import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGroundedQuality } from "../dist/lib/grounded-trim.js";

const candidateId = "job-004:recall-a";
const moment = {
  id: "recall-a",
  momentId: "recall-a",
  candidateId,
  startSec: 100,
  endSec: 130,
  durationSec: 30,
  hookText: "A complete source arc",
  layoutMode: "gameplay",
};
const quality = {
  rank: 99,
  candidateId,
  status: "candidate",
  groundingStatus: "GROUNDED",
  setupStartSec: 98,
  payoffStartSec: 118,
  flashSec: 119,
  reactionEndSec: 127,
  naturalEndSec: 127,
  arcCompleteness: 1,
};

test("trim applies grounded boundaries by candidateId rather than rank", () => {
  const applied = applyGroundedQuality(moment, quality);
  assert.equal(applied.candidateId, candidateId);
  assert.equal(applied.startSec, 98);
  assert.equal(applied.endSec, 127);
  assert.equal(applied.flashSec, 119);
  assert.equal(applied.durationSec, 29);
});

test("trim rejects blocked grounding before extraction", () => {
  assert.throws(
    () => applyGroundedQuality(moment, { ...quality, status: "reserve", groundingStatus: "BLOCKED" }),
    /not source-grounded/,
  );
});
