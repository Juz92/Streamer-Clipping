import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRecallUnion,
  makeSemanticRecallMomentId,
  mergeRecallAnchors,
  persistRecallUnion,
  resolveRecallUnionCandidate,
  syncRecallUnionToPool,
} from "../src/lib/recall-union.js";
import { loadRecallCandidates } from "../src/ground-candidates.js";
import { loadPool, savePool } from "../src/lib/candidate-pool.js";

function semanticAnchor(index: number) {
  const startSec = index * 200;
  return {
    momentId: `semantic-${index}`,
    routes: ["semantic:humor"],
    source: "semantic" as const,
    startSec,
    endSec: startSec + 40,
    description: `Semantic nomination ${index}`,
    score: index,
    categories: ["peanut-bits"],
  };
}

test("recall union is uncapped and ordered by source time rather than proxy score", () => {
  const anchors = Array.from({ length: 20 }, (_, index) => semanticAnchor(index));
  anchors.push({
    ...semanticAnchor(25),
    momentId: "scorer-standalone",
    routes: ["audio-peak"],
    source: "scorer",
    score: 999,
  });

  const union = mergeRecallAnchors("job-123", anchors);

  assert.equal(union.length, 21);
  assert.equal(union[0].momentId, "semantic-0");
  assert.equal(union.at(-1)?.momentId, "scorer-standalone");
});

test("overlapping routes merge without losing provenance or primary identity", () => {
  const union = mergeRecallAnchors("job-123", [
    semanticAnchor(0),
    {
      momentId: "moment-audio-1",
      routes: ["audio-peak", "chat-eruption"],
      source: "scorer",
      startSec: 10,
      endSec: 50,
      description: "Same arc found from live signals",
      score: 91,
      categories: [],
    },
  ]);

  assert.equal(union.length, 1);
  assert.equal(union[0].candidateId, "job-123:semantic-0");
  assert.equal(union[0].momentId, "semantic-0");
  assert.deepEqual(union[0].recallRoutes, ["audio-peak", "chat-eruption", "semantic:humor"]);
  assert.deepEqual(
    union[0].routeEvidence.map((evidence) => evidence.momentId).sort(),
    ["moment-audio-1", "semantic-0"],
  );
  assert.equal(resolveRecallUnionCandidate(union, "moment-audio-1").candidateId, "job-123:semantic-0");
});

test("candidate identity survives boundary corrections", () => {
  const original = mergeRecallAnchors("job-123", [semanticAnchor(2)])[0];
  const corrected = mergeRecallAnchors("job-123", [
    { ...semanticAnchor(2), startSec: 385, endSec: 455 },
  ])[0];

  assert.equal(corrected.candidateId, original.candidateId);
  assert.equal(corrected.momentId, original.momentId);
  assert.notEqual(corrected.startSec, original.startSec);
});

test("semantic identity does not depend on mutable boundaries", () => {
  const candidate = {
    startSec: 100,
    endSec: 140,
    hook: "A complete joke",
    quote: "The payoff",
    categories: ["peanut-bits"],
    sourceQuery: "humor",
  };
  assert.equal(
    makeSemanticRecallMomentId(candidate),
    makeSemanticRecallMomentId({ ...candidate, startSec: 90, endSec: 155 }),
  );
});

test("persistence keeps the uncapped union in the artifact and candidate pool", () => {
  const root = mkdtempSync(join(tmpdir(), "recall-union-"));
  const poolPath = join(root, "candidate-pool.json");
  try {
    writeFileSync(join(root, "moments.json"), JSON.stringify([
      {
        id: "moment-overlap",
        suggestedStartSec: 10,
        suggestedEndSec: 50,
        description: "Overlapping signal anchor",
        scores: { composite: 8 },
        transcriptSignals: [{}],
        chatSignals: [{}],
        audioSignals: [{}],
      },
      {
        id: "moment-standalone",
        suggestedStartSec: 5000,
        suggestedEndSec: 5040,
        description: "Standalone signal anchor",
        scores: { composite: 9 },
        transcriptSignals: [],
        chatSignals: [{}],
        audioSignals: [],
      },
    ]));
    const semanticCandidates = Array.from({ length: 20 }, (_, index) => ({
      startSec: index * 200,
      endSec: index * 200 + 40,
      hook: `Semantic nomination ${index}`,
      quote: `Quote ${index}`,
      categories: ["peanut-bits"],
      sourceQuery: "humor",
      viralSubScores: { blendedFinal: index },
    }));

    const { union } = persistRecallUnion({
      jobDir: root,
      jobId: "job-123",
      streamId: "stream-123",
      streamDate: "2026-07-14",
      semanticCandidates,
      poolPath,
    });

    const artifact = JSON.parse(readFileSync(join(root, "recall-union.json"), "utf-8"));
    const pool = loadPool(poolPath);
    assert.equal(union.length, 21);
    assert.equal(artifact.length, 21);
    assert.equal(pool.candidates.length, 21);
    assert.ok(pool.candidates.every((candidate) => candidate.recallRoutes?.length));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorer payoff nomination survives in recall categories and route provenance", () => {
  const [candidate] = buildRecallUnion("job-wow", [], [{
    id: "moment-wow",
    suggestedStartSec: 100,
    suggestedEndSec: 140,
    description: "A visually impressive connected play",
    contentLane: "peanut-plays",
    payoffType: "wow",
    laneScore: 0.9,
  }]);

  assert.deepEqual(candidate.categories, ["peanut-plays", "wow"]);
  assert.ok(candidate.recallRoutes.includes("payoff:wow"));
  assert.ok(candidate.routeEvidence[0].routes.includes("payoff:wow"));
});

test("grounding refreshes a stale derived union from current recall sources", () => {
  const root = mkdtempSync(join(tmpdir(), "recall-ground-refresh-"));
  try {
    writeFileSync(join(root, "recall-candidates.json"), JSON.stringify([{
      momentId: "semantic-current",
      candidateId: "job-refresh:semantic-current",
      startSec: 100,
      endSec: 140,
      hook: "Current semantic candidate",
      categories: ["peanut-bits"],
      sourceQuery: "humor",
    }]));
    writeFileSync(join(root, "signal-recall.json"), JSON.stringify([{
      id: "scorer-current",
      suggestedStartSec: 500,
      suggestedEndSec: 540,
      description: "Current gameplay scorer candidate",
      contentLane: "peanut-plays",
      payoffType: "wow",
      laneScore: 0.9,
    }]));
    writeFileSync(join(root, "recall-union.json"), JSON.stringify([{
      ...mergeRecallAnchors("job-refresh", [semanticAnchor(0)])[0],
      description: "Stale derived candidate",
    }]));

    const refreshed = loadRecallCandidates(root, "job-refresh");
    const artifact = JSON.parse(readFileSync(join(root, "recall-union.json"), "utf-8"));

    assert.equal(refreshed.length, 2);
    assert.equal(artifact.length, 2);
    assert.ok(refreshed.some((candidate) => candidate.momentId === "scorer-current"));
    assert.ok(refreshed.some((candidate) => candidate.categories.includes("wow")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshed recall union synchronizes new scorer candidates into the canonical pool", () => {
  const root = mkdtempSync(join(tmpdir(), "recall-pool-sync-"));
  const poolPath = join(root, "candidate-pool.json");
  try {
    const union = buildRecallUnion("job-sync", [], [{
      id: "scorer-wow",
      suggestedStartSec: 100,
      suggestedEndSec: 140,
      description: "Current scorer candidate",
      contentLane: "peanut-plays",
      payoffType: "wow",
      laneScore: 0.9,
    }]);

    syncRecallUnionToPool({
      poolPath,
      jobId: "job-sync",
      streamId: "stream-sync",
      streamDate: "2026-07-15",
      union,
    });

    const pool = loadPool(poolPath);
    assert.equal(pool.candidates.length, 1);
    assert.equal(pool.candidates[0].candidateId, "job-sync:scorer-wow");
    assert.deepEqual(pool.candidates[0].categories, ["peanut-plays", "wow"]);
    assert.ok(pool.candidates[0].recallRoutes?.includes("payoff:wow"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recall refresh preserves immutable published candidates without duplicate IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "recall-rerun-"));
  const poolPath = join(root, "candidate-pool.json");
  const options = {
    jobDir: root,
    jobId: "job-published",
    streamId: "stream-published",
    streamDate: "2026-07-14",
    semanticCandidates: [{
      startSec: 100,
      endSec: 140,
      hook: "Published candidate",
      categories: ["peanut-bits"],
      sourceQuery: "humor",
    }],
    poolPath,
  };
  try {
    persistRecallUnion(options);
    const publishedPool = loadPool(poolPath);
    publishedPool.candidates[0].status = "posted-daily";
    savePool(poolPath, publishedPool);

    persistRecallUnion(options);
    const refreshed = loadPool(poolPath);
    assert.equal(refreshed.candidates.length, 1);
    assert.equal(refreshed.candidates[0].status, "posted-daily");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
