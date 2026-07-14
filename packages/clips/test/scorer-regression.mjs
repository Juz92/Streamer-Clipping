import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAndRankMoments } from "../dist/lib/scorer.js";

function transcript(timestampSec, weight = 1, phrases = ["oh my god", "exclamations"], type = "shock") {
  return { timestampSec, weight, phrases, type };
}

function chat(timestampSec, spikeIntensity = 4, shockHits = 3) {
  return {
    timestampSec,
    messageRate: 4,
    emojiDensity: 0,
    keywordHits: ["omg"],
    spikeIntensity,
    shockHits,
    laughHits: 0,
    reactionDensity: 1,
    reactionType: "shock",
  };
}

function audio(timestampSec, deltaFromAvg = 24, type = "shock") {
  return { timestampSec, rmsLevel: -18, deltaFromAvg, type };
}

test("filters multi-signal clips that spike in setup but have no second-half payoff", () => {
  const moments = scoreAndRankMoments(
    [transcript(100)],
    [chat(101)],
    [],
    1000,
  );

  assert.equal(moments.length, 0);
});

test("keeps a multi-signal clip when the payoff beats setup and peaks in the second half", () => {
  const moments = scoreAndRankMoments(
    [transcript(100, 0.3, ["hold on", "setup"], "story"), transcript(112, 1, ["oh my god", "it worked"], "shock")],
    [chat(112)],
    [audio(112)],
    1000,
  );

  assert.equal(moments.length, 1);
  assert.ok((moments[0].scores.narrativeMomentum ?? 0) >= 0.55);
  assert.ok((moments[0].scores.emotionalPeak ?? 0) >= 0.5);
});
