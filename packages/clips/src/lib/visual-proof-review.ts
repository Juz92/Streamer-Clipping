import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  candidateNeedsVisualProof,
  type GroundingCandidate,
  type VisualProof,
} from "./arc-grounding.js";

const FRAME_COUNT = 6;
const REVIEW_SOURCE = "private-frame-timeline-v1";

export type VisualProofReviewCandidate = GroundingCandidate;

export interface VisualProofReviewItem {
  candidateId: string;
  description: string;
  startSec: number;
  endSec: number;
  categories: string[];
  recallRoutes: string[];
  evidenceTimestampsSec: number[];
  framePaths: string[];
  contactSheetPath: string;
  previewVideoPath: string;
}

export interface VisualProofTemplateRecord extends VisualProof {
  candidateId: string;
}

export interface VisualProofReviewPlan {
  version: 1;
  frameCount: number;
  items: VisualProofReviewItem[];
  proofs: VisualProofTemplateRecord[];
}

function roundMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function timelineTimestamps(startSec: number, endSec: number): number[] {
  const durationSec = endSec - startSec;
  return Array.from({ length: FRAME_COUNT }, (_, index) =>
    roundMillis(startSec + durationSec * ((index + 0.5) / FRAME_COUNT)),
  );
}

export function buildVisualProofReviewPlan(
  candidates: VisualProofReviewCandidate[],
  outputDir: string,
): VisualProofReviewPlan {
  const items = candidates
    .filter(candidateNeedsVisualProof)
    .map((candidate): VisualProofReviewItem => {
      const encodedId = encodeURIComponent(candidate.candidateId);
      const evidenceTimestampsSec = timelineTimestamps(candidate.startSec, candidate.endSec);
      const frameDir = join(outputDir, "frames", encodedId);
      return {
        candidateId: candidate.candidateId,
        description: candidate.description,
        startSec: candidate.startSec,
        endSec: candidate.endSec,
        categories: candidate.categories,
        recallRoutes: candidate.recallRoutes,
        evidenceTimestampsSec,
        framePaths: evidenceTimestampsSec.map((timestamp, index) =>
          join(frameDir, `${String(index + 1).padStart(2, "0")}-${timestamp.toFixed(3)}.jpg`),
        ),
        contactSheetPath: join(outputDir, "contact-sheets", `${encodedId}.jpg`),
        previewVideoPath: join(outputDir, "videos", `${encodedId}.mp4`),
      };
    });

  return {
    version: 1,
    frameCount: FRAME_COUNT,
    items,
    proofs: items.map((item) => ({
      candidateId: item.candidateId,
      verified: false,
      timestampSec: item.evidenceTimestampsSec[Math.floor(FRAME_COUNT / 2)],
      evidenceTimestampsSec: item.evidenceTimestampsSec,
      source: REVIEW_SOURCE,
      description: "UNREVIEWED — verify the lane claim from the frame timeline before changing verified.",
    })),
  };
}

function runFfmpeg(args: string[], context: string): void {
  const result = spawnSync("ffmpeg", ["-nostdin", ...args], {
    stdio: "pipe",
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf-8") ?? "";
    throw new Error(`ffmpeg failed while ${context}: ${stderr.slice(-1000)}`);
  }
}

function renderVisualProofReviewPack(
  videoPath: string,
  plan: VisualProofReviewPlan,
): void {
  if (!existsSync(videoPath)) throw new Error(`Source video not found: ${videoPath}`);

  for (const item of plan.items) {
    item.framePaths.forEach((framePath, index) => {
      mkdirSync(dirname(framePath), { recursive: true });
      runFfmpeg([
        "-y",
        "-ss", item.evidenceTimestampsSec[index].toFixed(3),
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "2",
        framePath,
      ], `extracting ${item.candidateId} frame ${index + 1}`);
    });

    mkdirSync(dirname(item.contactSheetPath), { recursive: true });
    const scaleFilters = item.framePaths
      .map((_, index) => `[${index}:v]scale=480:-2[v${index}]`)
      .join(";");
    const scaledInputs = item.framePaths.map((_, index) => `[v${index}]`).join("");
    const layout = "0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0";
    runFfmpeg([
      "-y",
      ...item.framePaths.flatMap((framePath) => ["-i", framePath]),
      "-filter_complex",
      `${scaleFilters};${scaledInputs}xstack=inputs=6:layout=${layout}:fill=black[out]`,
      "-map", "[out]",
      "-frames:v", "1",
      "-q:v", "2",
      item.contactSheetPath,
    ], `building ${item.candidateId} contact sheet`);

    mkdirSync(dirname(item.previewVideoPath), { recursive: true });
    runFfmpeg([
      "-y",
      "-ss", item.startSec.toFixed(3),
      "-i", videoPath,
      "-t", (item.endSec - item.startSec).toFixed(3),
      "-vf", "scale=-2:720",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "25",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-movflags", "+faststart",
      item.previewVideoPath,
    ], `rendering ${item.candidateId} video preview`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildReviewHtml(plan: VisualProofReviewPlan): string {
  const cards = plan.items.map((item, index) => `
    <article>
      <h2>#${String(index + 1).padStart(2, "0")} — ${escapeHtml(item.description)}</h2>
      <p><b>${escapeHtml(item.candidateId)}</b><br>${(item.endSec - item.startSec).toFixed(1)}s · ${escapeHtml(item.categories.join(", "))}</p>
      <video controls preload="metadata" aria-label="Candidate ${index + 1}" src="videos/${encodeURI(basename(item.previewVideoPath))}"></video>
    </article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gameplay proof video review</title><style>body{font:16px Arial;background:#111;color:#eee;max-width:1100px;margin:auto;padding:20px}article{border:1px solid #444;border-radius:10px;padding:16px;margin:20px 0;background:#1b1b1b}h2{font-size:19px}p{color:#bbb;line-height:1.5}video{width:100%;max-height:70vh;background:#000}</style></head><body><h1>Gameplay proof video review</h1><p>Watch each complete window and record which numbers show setup → player action → visible result.</p>${cards}</body></html>`;
}

export interface PreparedVisualProofReviewPack {
  plan: VisualProofReviewPlan;
  planPath: string;
  templatePath: string;
  reviewHtmlPath: string;
}

export function prepareVisualProofReviewPack(params: {
  videoPath: string;
  candidates: VisualProofReviewCandidate[];
  outputDir: string;
  force?: boolean;
}): PreparedVisualProofReviewPack {
  const planPath = join(params.outputDir, "review-plan.json");
  const templatePath = join(params.outputDir, "visual-proofs.template.json");
  const reviewHtmlPath = join(params.outputDir, "review.html");
  if (existsSync(templatePath) && !params.force) {
    throw new Error(`Visual proof template already exists: ${templatePath}`);
  }

  const plan = buildVisualProofReviewPlan(params.candidates, params.outputDir);
  renderVisualProofReviewPack(params.videoPath, plan);
  mkdirSync(params.outputDir, { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
  writeVisualProofTemplate(templatePath, plan.proofs, params.force);
  writeFileSync(reviewHtmlPath, buildReviewHtml(plan), "utf-8");
  return { plan, planPath, templatePath, reviewHtmlPath };
}

export function writeVisualProofTemplate(
  path: string,
  proofs: VisualProofTemplateRecord[],
  force = false,
): void {
  if (existsSync(path) && !force) {
    throw new Error(`Visual proof template already exists: ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(proofs, null, 2), "utf-8");
}
