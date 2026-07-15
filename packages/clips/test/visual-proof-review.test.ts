import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildVisualProofReviewPlan,
  prepareVisualProofReviewPack,
  writeVisualProofTemplate,
} from "../src/lib/visual-proof-review.js";

const candidates = [
  {
    candidateId: "job-004:gameplay-a",
    jobId: "job-004",
    momentId: "gameplay-a",
    startSec: 100,
    endSec: 130,
    description: "A connected combat play",
    categories: ["peanut-plays", "wow"],
    recallRoutes: ["scorer", "lane:peanut-plays", "payoff:wow"],
  },
  {
    candidateId: "job-004:legacy-visual",
    jobId: "job-004",
    momentId: "legacy-visual",
    startSec: 200,
    endSec: 260,
    description: "Legacy visual gameplay nomination",
    categories: [],
    recallRoutes: ["lane:visual-gameplay"],
  },
  {
    candidateId: "job-004:comedy",
    jobId: "job-004",
    momentId: "comedy",
    startSec: 300,
    endSec: 330,
    description: "Conversation only",
    categories: ["peanut-bits"],
    recallRoutes: ["semantic:humor"],
  },
];

test("visual review plan selects gameplay candidates and creates safe timestamped proof templates", () => {
  const plan = buildVisualProofReviewPlan(candidates, join("review", "output"));

  assert.equal(plan.version, 1);
  assert.equal(plan.frameCount, 6);
  assert.deepEqual(plan.items.map((item) => item.candidateId), [
    "job-004:gameplay-a",
    "job-004:legacy-visual",
  ]);
  assert.deepEqual(plan.items[0].evidenceTimestampsSec, [102.5, 107.5, 112.5, 117.5, 122.5, 127.5]);
  assert.equal(basename(plan.items[0].contactSheetPath), "job-004%3Agameplay-a.jpg");
  assert.equal(basename(plan.items[0].previewVideoPath), "job-004%3Agameplay-a.mp4");
  assert.equal(plan.items[0].previewStartSec, 95);
  assert.equal(plan.items[0].previewEndSec, 145);
  assert.equal(plan.proofs[0].verified, false);
  assert.equal(plan.proofs[0].timestampSec, 117.5);
  assert.deepEqual(plan.proofs[0].evidenceTimestampsSec, plan.items[0].evidenceTimestampsSec);
  assert.match(plan.proofs[0].description, /UNREVIEWED/);
});

test("visual proof preparation renders evidence and writes safe auditable artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "visual-proof-render-"));
  const videoPath = join(root, "source.mp4");
  const outputDir = join(root, "review");
  try {
    const generated = spawnSync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=size=320x180:rate=2",
      "-t", "6",
      "-pix_fmt", "yuv420p",
      videoPath,
    ], { stdio: "pipe", windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr?.toString());

    const prepared = prepareVisualProofReviewPack({
      videoPath,
      candidates: [{ ...candidates[0], startSec: 0, endSec: 6 }],
      outputDir,
    });

    assert.ok(prepared.plan.items[0].framePaths.every((path) => existsSync(path) && statSync(path).size > 0));
    assert.ok(existsSync(prepared.plan.items[0].contactSheetPath));
    assert.ok(statSync(prepared.plan.items[0].contactSheetPath).size > 0);
    assert.ok(existsSync(prepared.plan.items[0].previewVideoPath));
    assert.ok(statSync(prepared.plan.items[0].previewVideoPath).size > 0);
    assert.ok(existsSync(prepared.reviewHtmlPath));
    assert.match(readFileSync(prepared.reviewHtmlPath, "utf-8"), /<video[^>]+controls/);
    assert.ok(existsSync(prepared.planPath));
    assert.ok(existsSync(prepared.templatePath));
    assert.equal(JSON.parse(readFileSync(prepared.templatePath, "utf-8"))[0].verified, false);
    assert.throws(
      () => prepareVisualProofReviewPack({
        videoPath,
        candidates: [{ ...candidates[0], startSec: 0, endSec: 6 }],
        outputDir,
      }),
      /already exists/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual proof template refuses to overwrite review state unless forced", () => {
  const root = mkdtempSync(join(tmpdir(), "visual-proof-template-"));
  const path = join(root, "visual-proofs.template.json");
  const plan = buildVisualProofReviewPlan(candidates, root);
  try {
    writeVisualProofTemplate(path, plan.proofs);
    assert.throws(
      () => writeVisualProofTemplate(path, [], false),
      /already exists/,
    );
    writeVisualProofTemplate(path, [], true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
