import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildVisualProofReviewPlan,
  prepareVisualProofReviewPack,
  visualProofReviewPlanMatches,
  writeVisualProofTemplate,
} from "../src/lib/visual-proof-review.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

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
  assert.equal(plan.items[0].previewEndSec, 190);
  assert.equal(plan.proofs[0].verified, false);
  assert.equal(plan.proofs[0].timestampSec, 117.5);
  assert.deepEqual(plan.proofs[0].evidenceTimestampsSec, plan.items[0].evidenceTimestampsSec);
  assert.match(plan.proofs[0].description, /UNREVIEWED/);
});

test("visual review plan freshness follows canonical candidate boundaries", () => {
  const outputDir = join("review", "output");
  const plan = buildVisualProofReviewPlan(candidates, outputDir);

  assert.equal(visualProofReviewPlanMatches(plan, candidates, outputDir), true);
  assert.equal(visualProofReviewPlanMatches(plan, [
    { ...candidates[0], endSec: candidates[0].endSec + 1 },
    ...candidates.slice(1),
  ], outputDir), false);
});

test("jobs with no visual candidates write an empty proof artifact without OpenRouter", () => {
  const streamId = `empty-review-${process.pid}-${Date.now()}`;
  const jobDir = join(repoRoot, "data", "clips", `job-test-${streamId}`);
  const reviewDir = join(jobDir, "visual-proof-review");
  try {
    const plan = buildVisualProofReviewPlan([candidates[2]], reviewDir);
    assert.deepEqual(plan.items, []);
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(jobDir, "manifest.json"), JSON.stringify({ streamId }), "utf-8");
    writeFileSync(join(reviewDir, "review-plan.json"), JSON.stringify(plan), "utf-8");

    const result = spawnSync(process.execPath, [
      tsxCli, "packages/clips/src/review-visual-boundaries.ts", "--stream", streamId,
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, OPENROUTER_API_KEY: "" },
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(jobDir, "visual-proofs.json"), "utf-8")), []);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("orchestrator dry run orders prepare then review then Arc Gate", () => {
  const result = spawnSync(process.execPath, [
    tsxCli, "packages/clips/src/orchestrate.ts",
    "--stream", "dry-run-boundary-order",
    "--from", "ground-candidates",
    "--dry-run",
    "--allow-scorer-only",
  ], { cwd: repoRoot, encoding: "utf-8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = `${result.stdout}\n${result.stderr}`;
  const prepare = output.indexOf("prepare-visual-proofs.ts");
  const review = output.indexOf("review-visual-boundaries.ts");
  const ground = output.indexOf("ground-candidates.ts");
  assert.ok(prepare >= 0 && prepare < review && review < ground, output);
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
