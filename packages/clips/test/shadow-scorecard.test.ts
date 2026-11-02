import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShadowScorecard } from "../src/shadow-scorecard.js";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf-8");
}

test("shadow scorecard exposes funnel, route gaps, selected ranks and honest benchmark blocker", () => {
  const clipsRoot = mkdtempSync(join(tmpdir(), "shadow-scorecard-"));
  const jobDir = join(clipsRoot, "job-006-2026-07-17");
  mkdirSync(jobDir);
  try {
    writeJson(join(jobDir, "manifest.json"), {
      streamId: "unseen-stream",
      chatPath: null,
      heatmapPath: null,
      audioLevelsPath: join(jobDir, "audio_levels.txt"),
      subtitlePath: join(jobDir, "source.en.vtt"),
    });
    writeFileSync(join(jobDir, "audio_levels.txt"), "0 0.5", "utf-8");
    writeFileSync(join(jobDir, "source.en.vtt"), "WEBVTT", "utf-8");
    writeJson(join(jobDir, "recall-union.json"), [{
      candidateId: "job-006-2026-07-17:a",
      recallRoutes: ["semantic:humor"],
      categories: ["peanut-bits"],
    }, {
      candidateId: "job-006-2026-07-17:b",
      recallRoutes: ["lane:visual-gameplay"],
      categories: ["peanut-plays"],
    }, {
      candidateId: "job-006-2026-07-17:c",
      recallRoutes: ["semantic:humor"],
      categories: ["peanut-bits"],
    }]);
    writeJson(join(jobDir, "arc-grounding.json"), { results: [{
      candidateId: "job-006-2026-07-17:a",
      status: "GROUNDED",
      beats: {
        setupStartSec: 9,
        premiseClearSec: 12,
        actionStartSec: 16,
        payoffStartSec: 22,
        payoffEndSec: 27,
        reactionEndSec: 31,
      },
    }, {
      candidateId: "job-006-2026-07-17:b",
      status: "BLOCKED",
    }, {
      candidateId: "job-006-2026-07-17:c",
      status: "GROUNDED",
      beats: {
        setupStartSec: 50,
        premiseClearSec: 52,
        actionStartSec: 54,
        payoffStartSec: 56,
        payoffEndSec: 58,
        reactionEndSec: 60,
      },
    }] });
    writeJson(join(jobDir, "grounded-ranking.json"), {
      gate: { status: "WAITING_FOR_LABELS", labelSource: "private-review" },
      ranked: [{ candidateId: "job-006-2026-07-17:c", editorialStrength: 1 },
        { candidateId: "job-006-2026-07-17:a", editorialStrength: 1 }],
      promoted: [],
    });
    writeJson(join(jobDir, "private-abc-selection.json"), {
      source: "Justin Telegram",
      selectedAt: "2026-07-17T00:00:00Z",
      decision: "liked all",
      publishApproved: false,
      rightsStatus: "unresolved",
      candidates: [{
        candidateId: "job-006-2026-07-17:a",
        startSec: 10,
        endSec: 30,
        beats: {
          setupStartSec: 10,
          premiseClearSec: 12,
          actionStartSec: 16,
          payoffStartSec: 22,
          payoffEndSec: 27,
          reactionEndSec: 30,
        },
      }],
    });

    const scorecard = buildShadowScorecard(jobDir, {
      version: 1,
      records: [],
      excluded: [],
      summary: {
        records: 0,
        gradedRecords: 0,
        ungradedRecords: 0,
        streams: 0,
        gradedStreams: 1,
        benchmarkEligibleRecords: 0,
        benchmarkEligibleStreams: 1,
        mediaAvailable: 0,
        excludedRecords: 0,
      },
      benchmark: { status: "WAITING_FOR_LABELS", requiredEligibleStreams: 3, eligibleStreams: 1 },
    });

    assert.deepEqual(scorecard.funnel, { recalled: 3, grounded: 2, blocked: 1, ranked: 2 });
    assert.deepEqual(scorecard.routes, {
      "lane:visual-gameplay": 1,
      "semantic:humor": 2,
    });
    assert.deepEqual(scorecard.evidence, {
      transcript: true,
      chat: false,
      audio: true,
      heatmap: false,
    });
    assert.deepEqual(scorecard.ranking.selectedRanks, [{
      candidateId: "job-006-2026-07-17:a",
      rank: 2,
    }]);
    assert.deepEqual(scorecard.ranking.saturation, { maxEditorialStrength: 1, candidatesAtMax: 2 });
    assert.deepEqual(scorecard.boundaryQuality, {
      status: "MEASURED",
      reviewedCandidates: 1,
      acceptedWithinTwoSeconds: 1,
      acceptanceRate: 1,
      medianStartErrorSec: 1,
      medianEndErrorSec: 1,
      gatePassed: true,
    });
    assert.equal(scorecard.mode, "SHADOW_ONLY");
    assert.equal(scorecard.uploadBlocked, true);
    assert.equal(scorecard.review.maximumProductionCandidates, 5);
    assert.equal(scorecard.baseline.status, "WAITING_FOR_LABELS");
    assert.deepEqual(scorecard.baseline.blockers, [
      "Need 2 more benchmark-eligible streams",
      "Need at least 6 benchmark-eligible candidates per held-out stream",
    ]);
  } finally {
    rmSync(clipsRoot, { recursive: true, force: true });
  }
});
