import { test } from "node:test";
import assert from "node:assert/strict";
import {
  migrateLegacyReviewFeedback,
  migrateTrimResults,
  resolveProvenLegacyRoute,
} from "../src/migrate-legacy-artifacts.js";

const union = [{
  candidateId: "job-002:nlm-001",
  jobId: "job-002",
  momentId: "nlm-001",
  startSec: 100,
  endSec: 145,
  durationSec: 45,
  description: "merged arc",
  categories: ["peanut-bits"],
  recallRoutes: ["semantic:legacy"],
  routeEvidence: [
    { momentId: "nlm-001", source: "semantic", routes: ["semantic:legacy"], startSec: 100, endSec: 125 },
    { momentId: "nlm-002", source: "semantic", routes: ["semantic:legacy"], startSec: 120, endSec: 145 },
  ],
}];

const job = {
  jobId: "job-002",
  streamId: "stream-2",
  union,
  sourceByMomentId: new Map([
    ["nlm-001", { momentId: "nlm-001", startSec: 100, endSec: 125, categories: ["peanut-bits"] }],
    ["nlm-002", { momentId: "nlm-002", startSec: 120, endSec: 145, categories: ["peanut-bits"] }],
  ]),
};

test("legacy route proof resolves merged routes to one canonical union identity", () => {
  assert.equal(resolveProvenLegacyRoute(union, "nlm-002", 120, 145)?.candidateId, "job-002:nlm-001");
  assert.equal(resolveProvenLegacyRoute(union, "nlm-001", 100, 145)?.candidateId, "job-002:nlm-001");
  assert.equal(resolveProvenLegacyRoute(union, "nlm-002", 121, 145), null);
});

test("trim migration canonicalizes exact route evidence and quarantines rank-only rows", () => {
  const result = migrateTrimResults(job, {
    streamId: "stream-2",
    totalClips: 2,
    approved: [
      { rank: 1, momentId: "nlm-002", sourceStartSec: 120, sourceEndSec: 145, clipFile: "01.mp4" },
      { rank: 2, clipFile: "02.mp4" },
    ],
  });

  assert.equal(result.artifact.approved.length, 1);
  assert.equal(result.artifact.approved[0].candidateId, "job-002:nlm-001");
  assert.equal(result.artifact.approved[0].momentId, "nlm-001");
  assert.equal(result.artifact.approved[0].legacyMomentId, "nlm-002");
  assert.equal(result.quarantined.length, 1);
});

test("review migration keeps exact labels and quarantines rank/file-only history", () => {
  const result = migrateLegacyReviewFeedback({
    version: 1,
    records: [{
      streamId: "stream-2",
      reviewedAt: "2026-07-11T00:00:00.000Z",
      decisions: [
        { rank: 1, momentId: "nlm-002", sourceStartSec: 120, sourceEndSec: 145, status: "DROP", reaction: "nothing", rejectionReason: "not-funny" },
        { rank: 2, file: "02-known-winner.mp4", status: "KEEP", reaction: "lol" },
      ],
    }],
  }, [job]);

  assert.equal(result.document.version, 2);
  assert.equal(result.document.records[0].decisions.length, 1);
  assert.equal(result.document.records[0].decisions[0].candidateId, "job-002:nlm-001");
  assert.equal(result.document.records[0].decisions[0].status, "reject");
  assert.equal(result.document.records[0].decisions[0].lane, "peanut-bits");
  assert.equal(result.quarantined.length, 1);
});
