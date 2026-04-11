import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPool,
  savePool,
  appendCandidates,
  removeByJobId,
} from "../src/lib/candidate-pool.js";
import type { CandidatePointer } from "../src/lib/candidate-pool.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "peanut-pool-"));
}

function mkCandidate(
  jobId: string,
  momentId: string,
  score = 80,
): CandidatePointer {
  return {
    jobId,
    momentId,
    streamId: `stream-${jobId}`,
    streamDate: "2026-04-10",
    categories: ["dry-joke"],
    viralScore: score,
    durationSec: 45,
    hook: `Test pick ${momentId}`,
    status: "pending",
    statusUpdatedAt: new Date().toISOString(),
  };
}

test("loadPool returns empty pool when file missing", () => {
  const tmp = makeTmp();
  const pool = loadPool(join(tmp, "pool.json"));
  assert.equal(pool.version, 1);
  assert.equal(pool.candidates.length, 0);
  rmSync(tmp, { recursive: true, force: true });
});

test("savePool + loadPool round-trip", () => {
  const tmp = makeTmp();
  const path = join(tmp, "pool.json");
  const pool = {
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    candidates: [mkCandidate("job-001", "nlm-1")],
  };
  savePool(path, pool);
  const loaded = loadPool(path);
  assert.equal(loaded.candidates.length, 1);
  assert.equal(loaded.candidates[0].jobId, "job-001");
  rmSync(tmp, { recursive: true, force: true });
});

test("appendCandidates adds new records with status=pending", () => {
  const tmp = makeTmp();
  const path = join(tmp, "pool.json");
  appendCandidates(path, [mkCandidate("job-001", "nlm-1"), mkCandidate("job-001", "nlm-2")]);
  const pool = loadPool(path);
  assert.equal(pool.candidates.length, 2);
  assert.ok(pool.candidates.every((c) => c.status === "pending"));
  rmSync(tmp, { recursive: true, force: true });
});

test("removeByJobId removes only pending records for the given job", () => {
  const tmp = makeTmp();
  const path = join(tmp, "pool.json");
  // Seed with mixed statuses
  const seed = {
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    candidates: [
      mkCandidate("job-001", "nlm-1"),
      { ...mkCandidate("job-001", "nlm-2"), status: "posted-daily" as const },
      mkCandidate("job-002", "nlm-3"),
    ],
  };
  savePool(path, seed);

  removeByJobId(path, "job-001");

  const pool = loadPool(path);
  assert.equal(pool.candidates.length, 2);
  // posted-daily is immutable
  assert.ok(pool.candidates.some((c) => c.momentId === "nlm-2"));
  // other job untouched
  assert.ok(pool.candidates.some((c) => c.jobId === "job-002"));
  // pending for job-001 is gone
  assert.ok(!pool.candidates.some((c) => c.momentId === "nlm-1"));
  rmSync(tmp, { recursive: true, force: true });
});

test("savePool uses atomic temp-file-rename pattern", () => {
  const tmp = makeTmp();
  const path = join(tmp, "pool.json");
  savePool(path, {
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    candidates: [mkCandidate("job-001", "nlm-1")],
  });
  // No temp file left behind
  assert.ok(!existsSync(`${path}.tmp`));
  assert.ok(existsSync(path));
  rmSync(tmp, { recursive: true, force: true });
});
