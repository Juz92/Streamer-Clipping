import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewRecord } from "../dist/ingest-review-decision.js";

test("infers acceptedSuggestedPick and preserves discovery metadata for later calibration", () => {
  const record = normalizeReviewRecord(
    "stream-1",
    {
      chosenRank: 2,
      decisions: [{ rank: 2, status: "approved", reaction: "lol", rejectionReason: null }],
    },
    { suggestedRank: 2 },
    [{
      rank: 2,
      contentLane: "peanut-bits",
      payoffType: "roast",
      laneScore: 0.88,
      laughOutLoudScore: 0.72,
      humorPotential: 0.76,
    }],
  );

  assert.equal(record.acceptedSuggestedPick, true);
  assert.equal(record.chosenRank, 2);
  assert.equal(record.decisions[0].status, "approved");
  assert.equal(record.decisions[0].contentLane, "peanut-bits");
  assert.equal(record.decisions[0].payoffType, "roast");
  assert.equal(record.decisions[0].laneScore, 0.88);
  assert.equal(record.decisions[0].reaction, "lol");
  assert.equal(record.decisions[0].rejectionReason, null);
});
