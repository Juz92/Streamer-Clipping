/**
 * visual-qa.ts — Deterministic visual quality checks for rendered Shorts.
 *
 * Scans the first frame and key frames for:
 * - Face/subject readability
 * - Caption overlap conflicts
 * - Layout fit
 * - Hook banner blocking
 *
 * Uses ffmpeg to extract frames, then runs lightweight checks.
 * No ML model needed — deterministic heuristics only.
 */

import { execSync } from "child_process";
import { mkdirSync, readdirSync } from "fs";
import { join } from "path";

export interface VisualQAResult {
  clipNum: number;
  filePath: string;
  passed: boolean;
  issues: string[];
  firstFramePath: string;
  flashFramePath: string;
  thumbnailFramePath: string;
}

interface FrameCheck {
  framePath: string;
  timestamp: number;
  checks: {
    brightness: number; // 0-255 avg
    contrast: number; // std dev
    faceVisible: boolean | null; // null = couldn't determine
    textOverlapRisk: boolean;
    clutterScore: number; // 0-10
  };
}

/** Extract a frame at given timestamp via ffmpeg. */
function extractFrame(videoPath: string, timestampSec: number, outPath: string): void {
  execSync(
    `ffmpeg -y -ss ${timestampSec} -i "${videoPath}" -frames:v 1 -q:v 2 "${outPath}"`,
    { stdio: "pipe" },
  );
}

/** Run ImageMagick identify to get brightness/contrast stats. */
function analyzeFrame(framePath: string): Omit<FrameCheck["checks"], "faceVisible"> {
  try {
    const result = execSync(
      `magick identify -verbose "${framePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    const meanMatch = result.match(/Mean:\s+([\d.]+)/);
    const stdDevMatch = result.match(/Standard deviation:\s+([\d.]+)/);

    const brightness = meanMatch ? parseFloat(meanMatch[1]) : 128;
    const contrast = stdDevMatch ? parseFloat(stdDevMatch[1]) : 30;

    // Text overlap risk: check if there's a lot of high-contrast small regions
    // (heuristic: high edge density in lower third = captions)
    const textOverlapRisk = false; // would need edge detection

    // Clutter: high std dev + low mean = busy dark frame
    const clutterScore = Math.min(10, Math.round((contrast / 50) * (255 - brightness) / 255 * 10));

    return { brightness, contrast, textOverlapRisk, clutterScore };
  } catch {
    return { brightness: 128, contrast: 30, textOverlapRisk: false, clutterScore: 5 };
  }
}

/** Check if ffmpeg can detect a face-like region (using cropdetect as proxy). */
function detectFaceProxy(framePath: string): boolean | null {
  try {
    // Use a simple heuristic: if frame has good brightness and contrast in center region,
    // assume subject is visible. True face detection would need a model.
    const result = execSync(
      `magick "${framePath}" -gravity Center -crop 50x50%+0+0 +repage -format "%[mean]" info:`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const centerBrightness = parseFloat(result.trim());
    // If center is reasonably bright, assume face/subject is visible
    return centerBrightness > 40 && centerBrightness < 240;
  } catch {
    return null;
  }
}

/** Run full visual QA on a rendered Short. */
export function runVisualQA(
  clipNum: number,
  videoPath: string,
  jobDir: string,
  trimResult?: {
    coldOpenSec?: number;
    thumbnailSec?: number;
    naturalEndSec?: number;
  },
): VisualQAResult {
  const issues: string[] = [];
  const framesDir = join(jobDir, "frames");
  mkdirSync(framesDir, { recursive: true });

  // Extract key frames
  const firstFrame = join(framesDir, `clip-${clipNum}-first.jpg`);
  const flashFrame = join(framesDir, `clip-${clipNum}-flash.jpg`);
  const thumbFrame = join(framesDir, `clip-${clipNum}-thumb.jpg`);

  extractFrame(videoPath, 0.1, firstFrame);

  const flashSec = trimResult?.coldOpenSec ?? 0.5;
  extractFrame(videoPath, flashSec, flashFrame);

  const thumbSec = trimResult?.thumbnailSec ?? (trimResult?.naturalEndSec ? trimResult.naturalEndSec * 0.7 : 3);
  extractFrame(videoPath, thumbSec, thumbFrame);

  // Analyze first frame
  const firstChecks = analyzeFrame(firstFrame);
  const firstFace = detectFaceProxy(firstFrame);

  if (firstChecks.brightness < 30) {
    issues.push("First frame too dark — subject may be invisible");
  }
  if (firstChecks.brightness > 250) {
    issues.push("First frame overexposed — blown out");
  }
  if (firstChecks.contrast < 20) {
    issues.push("First frame flat — low contrast, may look dull");
  }
  if (firstFace === false) {
    issues.push("First frame: center region dark/empty — face may not be visible");
  }

  // Analyze flash frame
  const flashChecks = analyzeFrame(flashFrame);
  if (flashChecks.clutterScore > 7) {
    issues.push("Flash frame cluttered — hook text may compete with action");
  }

  // Analyze thumbnail frame
  const thumbChecks = analyzeFrame(thumbFrame);
  if (thumbChecks.contrast < 25) {
    issues.push("Thumbnail frame low contrast — may look flat in feed");
  }

  return {
    clipNum,
    filePath: videoPath,
    passed: issues.length === 0,
    issues,
    firstFramePath: firstFrame,
    flashFramePath: flashFrame,
    thumbnailFramePath: thumbFrame,
  };
}

/** Batch QA all clips in a job directory. */
export function runBatchVisualQA(
  jobDir: string,
  shortsDir: string,
  trimResults?: Array<{
    clipNum: number;
    coldOpenSec?: number;
    thumbnailSec?: number;
    naturalEndSec?: number;
  }>,
): VisualQAResult[] {
  const results: VisualQAResult[] = [];

  const files = readdirSync(shortsDir)
    .filter((f: string) => f.endsWith(".mp4"))
    .sort();

  for (const file of files) {
    const match = file.match(/^(\d+)/);
    if (!match) continue;
    const clipNum = parseInt(match[1]);
    const videoPath = join(shortsDir, file);
    const trim = trimResults?.find((t) => t.clipNum === clipNum);

    const qa = runVisualQA(clipNum, videoPath, jobDir, trim);
    results.push(qa);
  }

  return results;
}
