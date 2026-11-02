import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMoment, hasDiscoveryPayoffEvidence } from "../src/story-gate.js";

const candidateId = "job-004:recall-a";
const moment = {
  id: "recall-a",
  momentId: "recall-a",
  candidateId,
  startSec: 100,
  endSec: 130,
  durationSec: 30,
  description: "No way, the flank argument ends in a hilarious roast payoff",
  hook: "The flank argument turns into a roast",
  quote: "No way, what an idiot",
  categories: ["humor", "friend-roast"],
  contentLane: "Comedy",
  payoffType: "punchline",
  laneScore: 0.9,
  laughOutLoudScore: 0.9,
  humorPotential: 0.9,
  funnyQuote: true,
  transcriptSignals: [
    { timestampSec: 101, weight: 0.8 },
    { timestampSec: 112, weight: 0.85 },
    { timestampSec: 124, weight: 1 },
  ],
};
const grounding = {
  candidateId,
  jobId: "job-004",
  momentId: "recall-a",
  status: "GROUNDED",
  localizer: "source-heuristic-v1",
  sourceWindow: { startSec: 10, endSec: 220 },
  beats: {
    setupStartSec: 100,
    premiseClearSec: 106,
    actionStartSec: 112,
    payoffStartSec: 120,
    payoffEndSec: 123,
    reactionEndSec: 128,
    flashSec: 121,
  },
  gates: { arcComplete: true, visualProof: null, contextIndependent: true },
  evidence: { transcript: [], reactions: [], visualProof: null },
  missingEvidence: [],
};

test("private A/B/C selection satisfies the discovery evidence floor", () => {
  assert.equal(hasDiscoveryPayoffEvidence({ privateSelection: "A" }), true);
});

test("Story Gate keeps taste and hook diagnostics separate from objective Arc Gate", () => {
  const weakTaste = {
    ...moment,
    hook: "",
    description: "",
    quote: "",
    durationSec: 90,
    contentLane: "reject",
    payoffType: "none",
    laneScore: 0,
    laughOutLoudScore: 0,
    humorPotential: 0,
    funnyQuote: false,
    viralScore: 1,
    transcriptSignals: [],
  };
  const result = scoreMoment(weakTaste, 1, undefined, weakTaste, grounding);
  assert.equal(result.status, "PASS");
  assert.equal(result.groundingStatus, "GROUNDED");
});

test("Story Gate blocks missing grounding before content score can promote it", () => {
  const blocked = scoreMoment(moment, 1, undefined, moment, undefined);
  assert.equal(blocked.status, "BLOCK");
  assert.equal(blocked.groundingStatus, "MISSING");

  const grounded = scoreMoment(moment, 1, undefined, moment, grounding);
  assert.notEqual(grounded.status, "BLOCK");
  assert.equal(grounded.groundingStatus, "GROUNDED");
  assert.deepEqual(grounded.beats, grounding.beats);
});
