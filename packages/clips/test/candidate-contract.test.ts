import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeMoment,
  makeCandidateId,
  chooseCanonicalMomentSource,
  loadValidatedGroundedPromoted,
} from "../src/lib/candidate-contract.js";

test("candidateId is stable within a job and independent of mutable source boundaries", () => {
  const first = canonicalizeMoment("job-004-2026-07-08", {
    id: "nlm-001",
    startSec: 100,
    endSec: 140,
  });
  const grounded = canonicalizeMoment("job-004-2026-07-08", {
    id: "nlm-001",
    startSec: 92,
    endSec: 148,
  });

  assert.equal(first.candidateId, "job-004-2026-07-08:nlm-001");
  assert.equal(grounded.candidateId, first.candidateId);
  assert.equal(first.momentId, "nlm-001");
  assert.equal(makeCandidateId("job-004-2026-07-08", "nlm-001"), first.candidateId);
});

test("candidate identity fails closed on missing or conflicting IDs", () => {
  assert.throws(
    () => canonicalizeMoment("job-004-2026-07-08", { startSec: 100 }),
    /moment id/i,
  );
  assert.throws(
    () =>
      canonicalizeMoment("job-004-2026-07-08", {
        id: "nlm-001",
        candidateId: "job-004-2026-07-08:curated-v2-01",
      }),
    /does not match/i,
  );
});

test("Story Gate and Trim can share one canonical artifact selector", () => {
  const notebook = [{ id: "nlm-001" }];
  const unified = [{ id: "curated-v2-01" }];
  const laneAwareScorer = [{ id: "moment-1", contentLane: "comedy", laneScore: 81 }];
  const legacyScorer = [{ id: "moment-1", rank: 1 }];
  const groundedPromoted = [{ id: "recall-1", candidateId: "job:recall-1" }];

  assert.equal(
    chooseCanonicalMomentSource(notebook, unified, laneAwareScorer, groundedPromoted),
    groundedPromoted,
  );
  assert.equal(
    chooseCanonicalMomentSource(notebook, unified, laneAwareScorer),
    laneAwareScorer,
  );
  assert.equal(chooseCanonicalMomentSource(notebook, unified, legacyScorer), notebook);
  assert.equal(chooseCanonicalMomentSource([], unified, legacyScorer), unified);
  assert.equal(chooseCanonicalMomentSource([], [], legacyScorer), legacyScorer);
});

test("grounded promoted loader rejects stale derivatives", () => {
  const streamDir = mkdtempSync(join(tmpdir(), "grounded-artifact-"));
  try {
    const candidate = { candidateId: "job:a", momentId: "a" };
    const groundingPath = join(streamDir, "arc-grounding.json");
    writeFileSync(groundingPath, "{}", "utf-8");
    writeFileSync(join(streamDir, "recall-union.json"), "[]", "utf-8");
    writeFileSync(join(streamDir, "grounded-ranking.json"), JSON.stringify({
      gate: { status: "PASS" },
      promoted: [candidate],
    }), "utf-8");
    writeFileSync(join(streamDir, "grounded-ranked-moments.json"), JSON.stringify([candidate]), "utf-8");

    assert.deepEqual(loadValidatedGroundedPromoted(streamDir), [candidate]);
    const future = new Date(Date.now() + 5_000);
    utimesSync(groundingPath, future, future);
    assert.throws(() => loadValidatedGroundedPromoted(streamDir), /stale/);
  } finally {
    rmSync(streamDir, { recursive: true, force: true });
  }
});
