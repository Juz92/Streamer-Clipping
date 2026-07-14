import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGroundedRanking } from "../src/grounded-rank.js";

const candidates = [
  {
    candidateId: "job-current:peanut",
    jobId: "job-current",
    momentId: "peanut",
    streamId: "current",
    startSec: 10,
    endSec: 40,
    description: "Peanut roast",
    categories: ["peanut-bits"],
    recallScore: 82,
    marketPrior: 0.4,
  },
  {
    candidateId: "job-current:gameplay",
    jobId: "job-current",
    momentId: "gameplay",
    streamId: "current",
    startSec: 50,
    endSec: 80,
    description: "Generic game clip",
    categories: ["peanut-plays"],
    sourceScores: { scorer: 95 },
    marketPrior: 0.9,
  },
  {
    candidateId: "job-current:blocked",
    jobId: "job-current",
    momentId: "blocked",
    streamId: "current",
    startSec: 90,
    endSec: 120,
    description: "Ungrounded bait",
    categories: ["peanut-bits"],
    sourceScores: { semantic: 100 },
    marketPrior: 1,
  },
];
const grounding = new Map([
  ["job-current:peanut", { status: "GROUNDED" }],
  ["job-current:gameplay", { status: "GROUNDED" }],
  ["job-current:blocked", { status: "BLOCKED" }],
]);

function label(streamId, suffix, lane, status, reaction) {
  return {
    streamId,
    candidateId: `${streamId}:${suffix}`,
    lane,
    status,
    reaction,
    editorialStrength: lane === "peanut-plays" ? 0.9 : 0.7,
  };
}

test("ranking excludes ungrounded candidates and keeps score families separate in shadow mode", () => {
  const report = buildGroundedRanking({ candidates, grounding, labels: [], minimumLabels: 10 });
  assert.equal(report.gate.status, "WAITING_FOR_LABELS");
  assert.deepEqual(report.ranked.map((item) => item.candidateId).sort(), ["job-current:gameplay", "job-current:peanut"]);
  assert.equal(report.promoted.length, 0);
  assert.equal(report.ranked[0].justinTaste, null);
  assert.equal(typeof report.ranked[0].editorialStrength, "number");
  assert.equal(typeof report.ranked[0].marketPrior, "number");
  assert.equal("viralScore" in report.ranked[0], false);
});

test("unseen gameplay lanes stay review-only after the global taste gate passes", () => {
  const labels = [];
  for (const streamId of ["job-a", "job-b"]) {
    for (let index = 0; index < 4; index++) {
      labels.push({
        ...label(streamId, `peanut-${index}`, "peanut-bits", "keep", "wow"),
        editorialStrength: 0.5,
      });
    }
    for (let index = 0; index < 2; index++) {
      labels.push({
        ...label(streamId, `squad-${index}`, "squad-chaos", "reject", "nothing"),
        editorialStrength: 0.95,
      });
    }
  }

  const report = buildGroundedRanking({ candidates, grounding, labels, minimumLabels: 10 });
  const gameplay = report.ranked.find((candidate) => candidate.candidateId === "job-current:gameplay");

  assert.equal(report.gate.status, "PASS");
  assert.equal(gameplay?.justinTaste, null);
  assert.deepEqual(report.promoted.map((candidate) => candidate.candidateId), ["job-current:peanut"]);
});

test("held-out private lol/wow labels gate taste promotion and allow fewer than three", () => {
  const labels = [];
  for (const streamId of ["job-a", "job-b", "job-c"]) {
    labels.push(label(streamId, "peanut-1", "peanut-bits", "keep", "wow"));
    labels.push(label(streamId, "peanut-2", "peanut-bits", "keep", "wow"));
    labels.push(label(streamId, "peanut-3", "peanut-bits", "reject", "wow"));
    labels.push(label(streamId, "game-1", "peanut-plays", "reject", "nothing"));
    labels.push(label(streamId, "game-2", "peanut-plays", "reject", "nothing"));
    labels.push(label(streamId, "game-3", "peanut-plays", "reject", "nothing"));
  }
  for (let index = 0; index < 12; index++) {
    labels.push(label("current", `leak-${index}`, "peanut-plays", "keep", "lol"));
  }

  const report = buildGroundedRanking({ candidates, grounding, labels, minimumLabels: 10 });
  assert.equal(report.gate.status, "PASS");
  assert.equal(report.gate.labels, 18);
  assert.equal(report.gate.labelSource, "private-review");
  assert.ok(report.gate.meanTasteAt5 >= 0.6);
  assert.ok(report.gate.beatsEditorialOnStreams >= 2);
  assert.deepEqual(report.promoted.map((item) => item.candidateId), ["job-current:peanut"]);
  assert.ok((report.promoted[0].justinTaste ?? 0) >= 0.6);
  assert.equal(report.promoted[0].editorialStrength, 0.82);
  assert.equal(report.promoted[0].marketPrior, 0.4);
});

test("held-out gate fails when any stream has only five editorially comparable labels", () => {
  const labels = [];
  for (const streamId of ["job-a", "job-b", "job-c"]) {
    labels.push(label(streamId, "peanut-1", "peanut-bits", "keep", "lol"));
    labels.push(label(streamId, "peanut-2", "peanut-bits", "keep", "lol"));
    labels.push(label(streamId, "peanut-3", "peanut-bits", "reject", "lol"));
    labels.push(label(streamId, "game-1", "peanut-plays", "reject", "nothing"));
    labels.push(label(streamId, "game-2", "peanut-plays", "reject", "nothing"));
    labels.push(label(streamId, "game-3", "peanut-plays", "reject", "nothing"));
  }
  delete labels.find((item) => item.streamId === "job-a" && item.candidateId.endsWith("game-3")).editorialStrength;

  const report = buildGroundedRanking({ candidates, grounding, labels, minimumLabels: 10 });
  assert.equal(report.gate.status, "FAIL");
  assert.equal(report.gate.holdouts.length, 2);
});

test("held-out gate waits until Precision@5 can distinguish rankings", () => {
  const labels = [];
  for (const streamId of ["job-a", "job-b"]) {
    for (let index = 0; index < 5; index++) {
      labels.push(label(streamId, `peanut-${index}`, "peanut-bits", "keep", "lol"));
    }
  }

  const report = buildGroundedRanking({ candidates, grounding, labels, minimumLabels: 10 });
  assert.equal(report.gate.status, "WAITING_FOR_LABELS");
  assert.equal(report.gate.required, 12);
  assert.deepEqual(report.gate.holdouts, []);
});

test("held-out gate fails when editorial baselines are missing", () => {
  const labels = [];
  for (const streamId of ["job-a", "job-b", "job-c"]) {
    for (let index = 0; index < 6; index++) {
      const { editorialStrength: _ignored, ...item } = label(streamId, `peanut-${index}`, "peanut-bits", "keep", "lol");
      labels.push(item);
    }
  }
  const report = buildGroundedRanking({ candidates, grounding, labels, minimumLabels: 10 });
  assert.equal(report.gate.status, "FAIL");
  assert.deepEqual(report.gate.holdouts, []);
});
