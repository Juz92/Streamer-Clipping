import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPickQualityReport } from "../dist/pick-quality.js";

test("suggests a complete setup-payoff arc over a context-missing payoff", () => {
  const report = buildPickQualityReport("stream-1", "notebooklm", [
    {
      startSec: 100,
      endSec: 128,
      coldOpenSec: 100,
      flashSec: 121,
      naturalEndSec: 128,
      viralScore: 8,
      setupNeeded: false,
      categories: ["roast"],
    },
    {
      startSec: 200,
      endSec: 214,
      flashSec: 211,
      naturalEndSec: 214,
      viralScore: 9,
      setupNeeded: true,
      setupRef: { startSec: 130, description: "callback from earlier" },
      categories: ["running-bit"],
    },
  ]);

  assert.equal(report.suggestedRank, 1);
  assert.equal(report.picks[0].status, "suggested");
  assert.equal(report.picks[1].status, "reserve");
  assert.equal(report.picks[1].contextNeeded, true);
  assert.ok(report.picks[0].arcCompleteness > report.picks[1].arcCompleteness);
  assert.equal(report.picks[0].naturalEndSec, 129.4);
  assert.equal(report.picks[1].naturalEndSec, 215.4);
});
