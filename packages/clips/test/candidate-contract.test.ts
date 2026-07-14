import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeMoment,
  makeCandidateId,
  chooseCanonicalMomentSource,
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

  assert.equal(
    chooseCanonicalMomentSource(notebook, unified, laneAwareScorer),
    laneAwareScorer,
  );
  assert.equal(chooseCanonicalMomentSource(notebook, unified, legacyScorer), notebook);
  assert.equal(chooseCanonicalMomentSource([], unified, legacyScorer), unified);
  assert.equal(chooseCanonicalMomentSource([], [], legacyScorer), legacyScorer);
});
