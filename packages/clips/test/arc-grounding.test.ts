import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChatReactionEvidence,
  groundCandidateArc,
  localizeArcFromEvidence,
  passesArcGrounding,
  type ArcGroundingInput,
  type BeatMap,
} from "../src/lib/arc-grounding.js";

const candidate = {
  candidateId: "job-004:recall-a",
  jobId: "job-004",
  momentId: "recall-a",
  startSec: 100,
  endSec: 130,
  description: "The squad sets a trap, springs it, then loses it laughing",
  categories: ["conversational-humor"],
  recallRoutes: ["semantic:humor", "audio-peak"],
};

const transcript = [
  { startSec: 100, endSec: 104, text: "Wait here, I have a plan." },
  { startSec: 106, endSec: 110, text: "When he opens the door, we all shout." },
  { startSec: 112, endSec: 116, text: "He is coming. Get ready." },
  { startSec: 118, endSec: 120, text: "Now! Surprise!" },
  { startSec: 121, endSec: 126, text: "No way, we trapped ourselves. I am dead." },
];

const reactions = [
  { timestampSec: 119, source: "audio" as const, strength: 0.92, label: "shock" },
  { timestampSec: 122, source: "chat" as const, strength: 0.81, label: "unique-chatter spike" },
];

const beats: BeatMap = {
  setupStartSec: 100,
  premiseClearSec: 110,
  actionStartSec: 112,
  payoffStartSec: 118,
  payoffEndSec: 120,
  reactionEndSec: 126,
  flashSec: 119,
};

function input(overrides: Partial<ArcGroundingInput> = {}): ArcGroundingInput {
  return {
    candidate,
    transcript,
    reactions,
    proposedBeats: beats,
    localizer: "test-proposal",
    ...overrides,
  };
}

test("accepts an ordered beat map only when every beat aligns to source evidence", () => {
  const result = groundCandidateArc(input());

  assert.equal(result.candidateId, candidate.candidateId);
  assert.equal(result.momentId, candidate.momentId);
  assert.deepEqual(result.beats, beats);
  assert.equal(result.status, "GROUNDED");
  assert.equal(result.gates.arcComplete, true);
  assert.equal(result.gates.contextIndependent, true);
  assert.equal(result.gates.visualProof, null);
  assert.equal(result.missingEvidence.length, 0);
  assert.ok(result.evidence.transcript.length >= 5);
  assert.equal(result.evidence.reactions.length, 2);
});

test("fails closed when attractive beat timestamps are outside raw source evidence", () => {
  const ungrounded = groundCandidateArc(input({
    proposedBeats: {
      ...beats,
      payoffStartSec: 135,
      payoffEndSec: 138,
      reactionEndSec: 142,
    },
  }));

  assert.equal(ungrounded.status, "BLOCKED");
  assert.equal(ungrounded.gates.arcComplete, false);
  assert.ok(ungrounded.missingEvidence.some((reason) => reason.includes("payoffStartSec")));
  assert.ok(ungrounded.missingEvidence.some((reason) => reason.includes("reactionEndSec")));
});

test("all gameplay lanes require explicit visual proof", () => {
  for (const lane of ["wtf-game-moments", "peanut-plays", "the-mission"]) {
    const withoutProof = groundCandidateArc(input({
      candidate: { ...candidate, categories: [lane], recallRoutes: [`lane:${lane}`] },
    }));
    assert.equal(withoutProof.gates.visualProof, false);
    assert.equal(withoutProof.status, "BLOCKED");
  }
});

test("gameplay-only candidates cannot pass without explicit visual proof", () => {
  const gameplayCandidate = {
    ...candidate,
    categories: ["gameplay", "skill"],
    recallRoutes: ["scorer", "lane:visual-gameplay"],
  };

  const missing = groundCandidateArc(input({ candidate: gameplayCandidate }));
  assert.equal(missing.gates.visualProof, false);
  assert.equal(missing.status, "BLOCKED");
  assert.ok(missing.missingEvidence.includes("gameplay candidate requires verified visual proof"));

  const verified = groundCandidateArc(input({
    candidate: gameplayCandidate,
    visualProof: {
      verified: true,
      timestampSec: 119,
      source: "frame-review",
      description: "enemy is visibly trapped and the round result appears",
    },
  }));
  assert.equal(verified.gates.visualProof, true);
  assert.equal(verified.status, "GROUNDED");
});

test("source heuristic emits a complete ordered proposal from transcript plus reaction evidence", () => {
  const proposal = localizeArcFromEvidence({ candidate, transcript, reactions });
  const ordered = [
    proposal.setupStartSec,
    proposal.premiseClearSec,
    proposal.actionStartSec,
    proposal.payoffStartSec,
    proposal.payoffEndSec,
    proposal.reactionEndSec,
  ];

  assert.ok(ordered.every((value) => typeof value === "number"));
  for (let index = 1; index < ordered.length; index++) {
    assert.ok((ordered[index] as number) >= (ordered[index - 1] as number));
  }
  const result = groundCandidateArc(input({ proposedBeats: proposal, localizer: "source-heuristic-v1" }));
  assert.equal(result.status, "GROUNDED");
});

test("chat reactions require unique-chatter rate lift and reject duplicate spam", () => {
  const messages = [
    { timestampSec: 1, authorName: "a", text: "hello" },
    { timestampSec: 2, authorName: "b", text: "hey" },
    { timestampSec: 6, authorName: "a", text: "still here" },
    { timestampSec: 7, authorName: "c", text: "watching" },
    ...Array.from({ length: 8 }, (_, index) => ({
      timestampSec: 11 + index * 0.3,
      authorName: `reactor-${index}`,
      text: `reaction-${index}`,
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      timestampSec: 16 + index * 0.1,
      authorName: "spammer",
      text: "same emote",
    })),
  ];

  const events = buildChatReactionEvidence(messages);
  assert.equal(events.length, 1);
  assert.equal(events[0].timestampSec, 12.5);
  assert.match(events[0].label, /8 unique chatters/);
});

test("objective Arc Gate fails closed for missing or blocked grounding", () => {
  const grounded = groundCandidateArc(input());
  assert.equal(passesArcGrounding(undefined), false);
  assert.equal(passesArcGrounding({ ...grounded, status: "BLOCKED" }), false);
  assert.equal(passesArcGrounding(grounded), true);
});
