import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPickQualityReport } from "../dist/pick-quality.js";

const candidateId = "job-004:recall-a";
const moment = {
  id: "recall-a",
  momentId: "recall-a",
  candidateId,
  startSec: 100,
  endSec: 130,
  coldOpenSec: 103,
  flashSec: 124,
  naturalEndSec: 128,
  viralScore: 8,
  setupNeeded: false,
  categories: ["roast"],
};

const grounding = {
  candidateId,
  jobId: "job-004",
  momentId: "recall-a",
  status: "GROUNDED",
  localizer: "source-heuristic-v1",
  sourceWindow: { startSec: 10, endSec: 220 },
  beats: {
    setupStartSec: 98,
    premiseClearSec: 104,
    actionStartSec: 110,
    payoffStartSec: 118,
    payoffEndSec: 121,
    reactionEndSec: 127,
    flashSec: 119,
  },
  gates: { arcComplete: true, visualProof: null, contextIndependent: true },
  evidence: { transcript: [], reactions: [], visualProof: null },
  missingEvidence: [],
};

test("grounded Beat Map overrides guessed quality boundaries by candidateId", () => {
  const report = buildPickQualityReport(
    "stream-1",
    "notebooklm",
    [moment],
    new Map([[candidateId, grounding]]),
  );

  assert.equal(report.suggestedRank, 1);
  assert.equal(report.picks[0].candidateId, candidateId);
  assert.equal(report.picks[0].setupStartSec, 98);
  assert.equal(report.picks[0].buildUpStartSec, 110);
  assert.equal(report.picks[0].payoffStartSec, 118);
  assert.equal(report.picks[0].payoffEndSec, 121);
  assert.equal(report.picks[0].naturalEndSec, 127);
  assert.equal(report.picks[0].arcCompleteness, 1);
});

test("blocked grounding stays reserve even when the proxy score is high", () => {
  const blocked = {
    ...grounding,
    status: "BLOCKED",
    gates: { arcComplete: false, visualProof: false, contextIndependent: false },
    missingEvidence: ["gameplay candidate requires verified visual proof"],
  };
  const report = buildPickQualityReport(
    "stream-1",
    "notebooklm",
    [{ ...moment, viralScore: 100 }],
    new Map([[candidateId, blocked]]),
  );

  assert.equal(report.suggestedRank, null);
  assert.equal(report.picks[0].status, "reserve");
  assert.equal(report.picks[0].contextNeeded, true);
});
