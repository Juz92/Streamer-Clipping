#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@ltx/shared";
import { findStreamDir } from "./lib/manifest.js";
import { transcribeClip, type WhisperWord } from "./lib/whisper-captions.js";
import {
  autonomousProofIsReusable,
  buildAutonomousVisualProof,
  buildBoundaryReviewPrompt,
  buildPovAttributionPrompt,
  candidateNeedsPovKillAttribution,
  validatePovAttributionReview,
  type AutonomousVisualProof,
  type BoundaryReviewCandidate,
  type PovAttributionReview,
} from "./lib/autonomous-boundary-review.js";

const log = createLogger("review-visual-boundaries");
const DEFAULT_MODEL = "google/gemini-3.5-flash";

function loadRootEnv(): void {
  const path = resolve(".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

loadRootEnv();

interface ReviewPlanItem extends BoundaryReviewCandidate {
  description: string;
  categories: string[];
  previewVideoPath: string;
}

interface ReviewPlan {
  items: ReviewPlanItem[];
}

function parseArgs(): { streamId: string; force: boolean } {
  const args = process.argv.slice(2);
  let streamId = "";
  let force = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--stream" && args[index + 1]) streamId = args[++index];
    else if (args[index] === "--force") force = true;
  }
  if (!streamId) throw new Error("Usage: review-visual-boundaries.ts --stream <id> [--force]");
  return { streamId, force };
}

function run(command: string, args: string[], context: string): void {
  const result = spawnSync(command, args, { stdio: "pipe", timeout: 180_000, windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${context}: ${result.stderr?.toString().trim() || `${command} exited ${result.status}`}`);
  }
}

function prepareModelInput(
  item: ReviewPlanItem,
  outputPath: string,
  force: boolean,
  durationSec?: number,
): void {
  if (
    existsSync(outputPath)
    && !force
    && statSync(outputPath).mtimeMs >= statSync(item.previewVideoPath).mtimeMs
  ) return;
  mkdirSync(dirname(outputPath), { recursive: true });
  run("ffmpeg", [
    "-nostdin", "-y", "-i", item.previewVideoPath,
    ...(durationSec ? ["-t", durationSec.toFixed(3)] : []),
    "-vf", "scale=-2:360", "-r", "15",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart",
    outputPath,
  ], `compressing ${item.candidateId}`);
}

function videoDuration(path: string): number {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path,
  ], { encoding: "utf-8", timeout: 30_000, windowsHide: true });
  const duration = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not probe review video ${path}`);
  }
  return duration;
}

function loadWords(videoPath: string, item: ReviewPlanItem, force: boolean): WhisperWord[] {
  const path = videoPath.replace(/\.mp4$/i, ".whisper.json");
  const relative = existsSync(path) && !force
    ? JSON.parse(readFileSync(path, "utf-8")) as WhisperWord[]
    : transcribeClip(videoPath, path);
  return relative.map((word) => ({
    ...word,
    startMs: word.startMs + item.previewStartSec * 1000,
    endMs: word.endMs + item.previewStartSec * 1000,
  }));
}

async function callOpenRouter(videoPath: string, prompt: string, model: string, maxTokens: number): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const video = readFileSync(videoPath).toString("base64");
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: ["Bear", "er ", apiKey].join(""),
          "HTTP-Referer": "https://github.com/justinhilliard/streamer-clipping",
          "X-Title": "Streamer Clip Boundary Review",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "video_url", video_url: { url: `data:video/mp4;base64,${video}` } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("OpenRouter returned no review content");
      const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenRouter returned non-object JSON");
      return parsed;
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error("OpenRouter review failed");
}

function existingProofsAreFresh(path: string, items: ReviewPlanItem[], model: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const proofs = JSON.parse(readFileSync(path, "utf-8")) as AutonomousVisualProof[];
    return proofs.length === items.length
      && proofs.every((proof, index) => autonomousProofIsReusable(proof, items[index], model));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) throw new Error(`No job directory found for stream ${args.streamId}`);
  const reviewDir = join(streamDir, "visual-proof-review");
  const planPath = join(reviewDir, "review-plan.json");
  if (!existsSync(planPath)) throw new Error(`Missing visual review plan: ${planPath}`);
  const plan = JSON.parse(readFileSync(planPath, "utf-8")) as ReviewPlan;
  const model = process.env.BOUNDARY_REVIEW_MODEL?.trim() || DEFAULT_MODEL;
  const outputPath = join(streamDir, "visual-proofs.json");
  if (!args.force && existingProofsAreFresh(outputPath, plan.items, model)) {
    log.info(`Autonomous visual proofs are current: ${outputPath}`);
    return;
  }

  const proofs: AutonomousVisualProof[] = [];
  for (const [index, item] of plan.items.entries()) {
    const inputPath = join(reviewDir, "model-inputs", basename(item.previewVideoPath));
    prepareModelInput(item, inputPath, args.force);
    const duration = videoDuration(inputPath);
    log.info(`[${index + 1}/${plan.items.length}] Reviewing ${item.candidateId} with ${model}`);
    const attributionRequired = candidateNeedsPovKillAttribution(item);
    let attributionGate: PovAttributionReview & { required: boolean } = {
      required: attributionRequired,
      verified: !attributionRequired,
      verdict: null,
      confidence: null,
      evidence: attributionRequired ? "POV attribution review failed" : "not required",
    };
    if (attributionRequired) {
      const attributionDuration = Math.min(duration, item.endSec - item.previewStartSec + 30);
      const attributionInputPath = join(
        reviewDir,
        "model-attribution-inputs",
        `${basename(item.previewVideoPath, ".mp4")}.${attributionDuration.toFixed(3)}s.mp4`,
      );
      prepareModelInput(item, attributionInputPath, args.force, attributionDuration);
      try {
        attributionGate = {
          required: true,
          ...validatePovAttributionReview(await callOpenRouter(
            attributionInputPath,
            buildPovAttributionPrompt(item.candidateId),
            model,
            512,
          )),
        };
      } catch (error) {
        attributionGate.evidence = `Attribution model failed: ${(error as Error).message.slice(0, 300)}`;
      }
    }

    let response: unknown;
    if (!attributionGate.verified) {
      response = {
        candidateId: item.candidateId,
        objectiveEvent: false,
        attributionAccurate: false,
        attribution: attributionGate.evidence,
      };
    } else {
      try {
        response = await callOpenRouter(
          inputPath,
          buildBoundaryReviewPrompt(item, duration),
          model,
          4096,
        );
      } catch (error) {
        response = {
          candidateId: item.candidateId,
          objectiveEvent: false,
          attributionAccurate: false,
          attribution: `Model review failed: ${(error as Error).message.slice(0, 300)}`,
        };
      }
    }
    let words: WhisperWord[] = [];
    if (attributionGate.verified) {
      try {
        words = loadWords(inputPath, item, args.force);
      } catch (error) {
        response = {
          candidateId: item.candidateId,
          objectiveEvent: false,
          attributionAccurate: false,
          attribution: `Speech boundary review failed: ${(error as Error).message.slice(0, 300)}`,
        };
      }
    }
    const proof = buildAutonomousVisualProof({
      candidate: item,
      response,
      reviewDurationSec: duration,
      words,
      model,
      attributionGate,
    });
    proofs.push(proof);
    log.info(`  ${proof.verified ? "VERIFIED" : "BLOCKED"}: ${proof.review.rejectionReason ?? proof.review.selectedEndSec}`);
  }

  const tempPath = `${outputPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(proofs, null, 2), "utf-8");
  renameSync(tempPath, outputPath);
  log.info(`Wrote ${outputPath}: ${proofs.filter((proof) => proof.verified).length}/${proofs.length} verified`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("review-visual-boundaries.ts") || process.argv[1]?.endsWith("review-visual-boundaries.js")) {
  main().catch((error) => {
    log.error((error as Error).message);
    process.exit(1);
  });
}
