import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGoldCorpus } from "../src/gold-corpus.js";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf-8");
}

test("Gold Corpus preserves graded reviews and literal ungraded private approval", () => {
  const root = mkdtempSync(join(tmpdir(), "gold-corpus-"));
  try {
    const job4 = join(root, "job-004-2026-07-08");
    const job5 = join(root, "job-005-2026-07-14");
    mkdirSync(job4);
    mkdirSync(join(job5, "raw-clips"), { recursive: true });
    writeJson(join(root, "manual-review-feedback.json"), {
      version: 2,
      records: [{
        streamId: "stream-4",
        reviewedAt: "2026-07-14T00:00:00Z",
        decisions: [{
          candidateId: "job-004-2026-07-08:recall-a",
          momentId: "recall-a",
          status: "reject",
          lane: "peanut-bits",
          reaction: null,
          rejectionReason: "not-funny",
          correctedBeats: {
            setupStartSec: 12,
            premiseClearSec: 14,
            actionStartSec: 16,
            payoffStartSec: 18,
            payoffEndSec: 21,
            reactionEndSec: 24,
          },
          contextLevel: "self-contained",
          contextCarrier: "dialogue",
          visualProofRequired: false,
          primaryEvidenceModality: "dialogue",
          repetitionClass: "distinctive",
          arcIntent: "single-arc",
        }],
      }, {
        streamId: "legacy-stream",
        reviewedAt: "2026-07-03T00:00:00Z",
        decisions: [{
          candidateId: "job-002-2026-07-04:legacy-a",
          momentId: "legacy-a",
          status: "keep",
          lane: "peanut-bits",
          reaction: "lol",
        }],
      }],
    });
    writeJson(join(job4, "recall-union.json"), [{
      candidateId: "job-004-2026-07-08:recall-a",
      momentId: "recall-a",
      startSec: 10,
      endSec: 30,
      categories: ["peanut-bits"],
      recallRoutes: ["semantic:humor"],
    }]);
    writeJson(join(job4, "arc-grounding.json"), { results: [{
      candidateId: "job-004-2026-07-08:recall-a",
      status: "GROUNDED",
      beats: {
        setupStartSec: 11,
        premiseClearSec: 14,
        actionStartSec: 16,
        payoffStartSec: 18,
        payoffEndSec: 22,
        reactionEndSec: 25,
      },
    }] });

    writeJson(join(job5, "recall-union.json"), [{
      candidateId: "job-005-2026-07-14:recall-b",
      momentId: "recall-b",
      startSec: 40,
      endSec: 60,
      categories: ["peanut-bits"],
      recallRoutes: ["semantic:humor"],
    }]);
    writeJson(join(job5, "arc-grounding.json"), { results: [{
      candidateId: "job-005-2026-07-14:recall-b",
      status: "GROUNDED",
      beats: {
        setupStartSec: 39,
        premiseClearSec: 43,
        actionStartSec: 47,
        payoffStartSec: 51,
        payoffEndSec: 56,
        reactionEndSec: 61,
      },
    }] });
    writeJson(join(job5, "private-abc-selection.json"), {
      streamId: "stream-5",
      source: "Justin Telegram",
      selectedAt: "2026-07-17T00:00:00Z",
      decision: "liked all",
      publishApproved: false,
      rightsStatus: "unresolved",
      candidates: [{
        candidateId: "job-005-2026-07-14:recall-b",
        label: "A",
        startSec: 38,
        endSec: 62,
        beats: {
          setupStartSec: 39,
          premiseClearSec: 43,
          actionStartSec: 47,
          payoffStartSec: 51,
          payoffEndSec: 56,
          reactionEndSec: 61,
        },
      }],
    });
    writeFileSync(join(job5, "raw-clips", "01-reviewed.mp4"), "reviewed source window", "utf-8");

    const corpus = buildGoldCorpus(root);
    assert.deepEqual(corpus, buildGoldCorpus(root));
    assert.equal(corpus.summary.records, 2);
    assert.equal(corpus.summary.gradedRecords, 1);
    assert.equal(corpus.summary.ungradedRecords, 1);
    assert.equal(corpus.summary.gradedStreams, 1);
    assert.equal(corpus.summary.benchmarkEligibleRecords, 1);
    assert.equal(corpus.summary.benchmarkEligibleStreams, 1);
    assert.equal(corpus.summary.excludedRecords, 1);
    assert.deepEqual(corpus.excluded, [{
      candidateId: "job-002-2026-07-04:legacy-a",
      reason: "missing-recall-or-grounding",
      sourceArtifact: "manual-review-feedback.json",
    }]);
    assert.equal(corpus.benchmark.status, "WAITING_FOR_LABELS");
    assert.deepEqual(corpus.records.map((record) => ({
      candidateId: record.candidateId,
      status: record.status,
      reaction: record.reaction,
      labelStrength: record.labelStrength,
      benchmarkEligible: record.benchmarkEligible,
      contextLevel: record.contextLevel,
      contextCarrier: record.contextCarrier,
      visualProofRequired: record.visualProofRequired,
      primaryEvidenceModality: record.primaryEvidenceModality,
      repetitionClass: record.repetitionClass,
      arcIntent: record.arcIntent,
      sourceWindow: record.sourceWindow,
      mediaAvailable: record.mediaAvailable,
    })), [{
      candidateId: "job-004-2026-07-08:recall-a",
      status: "reject",
      reaction: null,
      labelStrength: "graded",
      benchmarkEligible: true,
      contextLevel: "self-contained",
      contextCarrier: "dialogue",
      visualProofRequired: false,
      primaryEvidenceModality: "dialogue",
      repetitionClass: "distinctive",
      arcIntent: "single-arc",
      sourceWindow: { startSec: 12, endSec: 24 },
      mediaAvailable: false,
    }, {
      candidateId: "job-005-2026-07-14:recall-b",
      status: "keep",
      reaction: null,
      labelStrength: "ungraded",
      benchmarkEligible: false,
      contextLevel: null,
      contextCarrier: null,
      visualProofRequired: null,
      primaryEvidenceModality: null,
      repetitionClass: null,
      arcIntent: null,
      sourceWindow: { startSec: 38, endSec: 62 },
      mediaAvailable: true,
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
