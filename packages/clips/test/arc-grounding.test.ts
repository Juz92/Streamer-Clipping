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
import { buildArcGroundingReport } from "../src/ground-candidates.js";

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

test("unreviewed proof templates stay blocked and are not counted as visual proofs", () => {
  const gameplayCandidate = {
    ...candidate,
    categories: ["peanut-plays"],
    recallRoutes: ["lane:peanut-plays"],
  };
  const report = buildArcGroundingReport({
    streamId: "stream-1",
    jobId: candidate.jobId,
    candidates: [gameplayCandidate],
    transcript,
    reactions,
    visualProofs: new Map([[candidate.candidateId, {
      candidateId: candidate.candidateId,
      verified: false,
      timestampSec: 119,
      evidenceTimestampsSec: [112, 118, 121],
      source: "private-frame-timeline-v1",
      description: "UNREVIEWED",
    }]]),
  });

  assert.equal(report.summary.visualProofs, 0);
  assert.equal(report.results[0].status, "BLOCKED");
  assert.equal(report.results[0].gates.visualProof, false);
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

test("source heuristic anchors outer beats to the candidate semantic envelope", () => {
  const semanticCandidate = { ...candidate, startSec: 100, endSec: 126 };
  const semanticTranscript = [
    { startSec: 85, endSec: 90, text: "Unrelated earlier filler." },
    ...transcript,
    { startSec: 130, endSec: 134, text: "A new topic starts here." },
  ];

  const proposal = localizeArcFromEvidence({
    candidate: semanticCandidate,
    transcript: semanticTranscript,
    reactions,
  });

  assert.equal(proposal.setupStartSec, 100);
  assert.equal(proposal.reactionEndSec, 126);
});

test("source heuristic excludes next-topic evidence beyond the candidate envelope", () => {
  const boundedCandidate = { ...candidate, startSec: 100, endSec: 126 };
  const boundedTranscript = [
    { startSec: 100, endSec: 104, text: "The complete setup." },
    { startSec: 106, endSec: 110, text: "The premise is clear." },
    { startSec: 112, endSec: 116, text: "The action escalates." },
    { startSec: 118, endSec: 120, text: "The punchline lands." },
    { startSec: 121, endSec: 124, text: "The direct response." },
    { startSec: 126.1, endSec: 127, text: "A new topic." },
  ];
  const proposal = localizeArcFromEvidence({
    candidate: boundedCandidate,
    transcript: boundedTranscript,
    reactions: [{ timestampSec: 126.1, source: "audio", strength: 1, label: "next topic" }],
  });

  assert.equal(proposal.reactionEndSec, 124);
});

test("semantic-envelope setup remains before the computed premise", () => {
  const lateEnvelopeCandidate = { ...candidate, startSec: 115, endSec: 126 };
  const proposal = localizeArcFromEvidence({
    candidate: lateEnvelopeCandidate,
    transcript,
    reactions,
  });

  assert.ok((proposal.setupStartSec as number) <= (proposal.premiseClearSec as number));
  const result = groundCandidateArc(input({
    candidate: lateEnvelopeCandidate,
    proposedBeats: proposal,
    localizer: "source-envelope-v2",
  }));
  assert.equal(result.status, "GROUNDED");
});

test("reviewed corrected beats override automatic grounding by candidateId", () => {
  const corrected: BeatMap = {
    setupStartSec: 100,
    premiseClearSec: 110,
    actionStartSec: 112,
    payoffStartSec: 118,
    payoffEndSec: 120,
    reactionEndSec: 126,
    flashSec: 119,
  };
  const report = buildArcGroundingReport({
    streamId: "stream-1",
    jobId: candidate.jobId,
    candidates: [candidate],
    transcript,
    reactions,
    correctedBeats: new Map([[candidate.candidateId, corrected]]),
  });

  assert.deepEqual(report.results[0].beats, corrected);
  assert.equal(report.results[0].localizer, "review-correction-v1");
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
