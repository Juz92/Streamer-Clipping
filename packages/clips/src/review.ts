/**
 * review.ts — post-render Gemini QA + auto-fix.
 *
 * Usage:
 *   npx tsx packages/clips/src/review.ts --stream <id>
 *   npx tsx packages/clips/src/review.ts --stream <id> --clips 1,3
 *   npx tsx packages/clips/src/review.ts --stream <id> --no-fix        # review only
 *   npx tsx packages/clips/src/review.ts --stream <id> --fix-only       # assume reviews exist
 *
 * Pipeline:
 *   1. Run packages/clips/review/gemini-review.py against this job's shorts dir.
 *   2. Parse <job-dir>/gemini-reviews.json.
 *   3. For each NEEDS_TRIM with a non-zero trim_end_seconds:
 *        - If backup clip exists in raw-clips-backup/ and the target boundary
 *          is within that backup's duration, re-finalize with the adjusted
 *          contentEnd, remap whisper words, patch trim-results.json, then
 *          re-render via render-fast --direct for just that clip.
 *   4. Cap at 1 fix attempt per clip — don't loop forever on ambiguous
 *      Gemini verdicts. User can re-run for a second pass.
 *
 * Requires GEMINI_API_KEY in env.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger, ensureDir } from "@ltx/shared";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import { finalizeClip, remapWhisperForFinalized } from "./lib/trim-finalize.js";
import { transcribeClip, type WhisperWord } from "./lib/whisper-captions.js";

const log = createLogger("review");

interface TrimEntry {
  rank: number;
  clipFile: string;
  flashStart: number;
  flashDuration: number;
  contentStart: number;
  contentEnd: number;
  contentDuration: number;
  totalDuration: number;
  status: string;
  notes?: string;
}

interface TrimResults {
  streamId: string;
  timestamp: string;
  mode?: string;
  totalClips: number;
  approved: TrimEntry[];
  rejected: Array<Record<string, unknown>>;
}

interface GeminiReview {
  clip: string;
  num: string;
  audio_timing?: {
    starts_clean?: boolean;
    ends_clean?: boolean;
    mid_sentence_cut?: boolean;
    trim_start_seconds?: number;
    trim_end_seconds?: number;
    ending_description?: string;
  };
  overall_verdict?: "PASS" | "NEEDS_TRIM" | "NEEDS_RECUT" | "SKIP";
  action_items?: string[];
  error?: string;
}

function parseArgs(): {
  streamId?: string;
  clips?: number[];
  noFix: boolean;
  fixOnly: boolean;
} {
  const args = process.argv.slice(2);
  const out: {
    streamId?: string;
    clips?: number[];
    noFix: boolean;
    fixOnly: boolean;
  } = { noFix: false, fixOnly: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) out.streamId = args[++i];
    else if (args[i] === "--clips" && args[i + 1])
      out.clips = args[++i].split(",").map((s) => parseInt(s.trim(), 10));
    else if (args[i] === "--no-fix") out.noFix = true;
    else if (args[i] === "--fix-only") out.fixOnly = true;
  }
  return out;
}

function probeDurationSec(path: string): number {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${path.replace(/\\/g, "/")}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return parseFloat(out.trim());
  } catch {
    return 0;
  }
}

function runGeminiReview(jobDir: string, clips?: number[]): boolean {
  if (!process.env.GEMINI_API_KEY) {
    log.warn("GEMINI_API_KEY not set — skipping Gemini review");
    return false;
  }

  const scriptPath = join(
    process.cwd(),
    "packages",
    "clips",
    "review",
    "gemini-review.py",
  );
  if (!existsSync(scriptPath)) {
    log.error(`gemini-review.py not found at ${scriptPath}`);
    return false;
  }

  const args = [scriptPath, jobDir];
  if (clips && clips.length > 0) args.push(clips.join(","));
  else args.push("--all");

  log.info(`Running: python ${args.map((a) => `"${a}"`).join(" ")}`);
  const result = spawnSync("python", args, {
    stdio: "inherit",
    timeout: 3_600_000,
  });
  if (result.status !== 0) {
    log.error(`gemini-review.py exited with status ${result.status}`);
    return false;
  }
  return true;
}

/**
 * Apply a single Gemini fix. Returns true if a re-render is needed.
 *
 * trim_end_seconds convention (from the prompt):
 *   positive = trim from end    → contentEnd -= trimSec
 *   negative = extend end       → contentEnd += abs(trimSec)
 */
function applyFix(
  review: GeminiReview,
  entry: TrimEntry,
  jobDir: string,
  paddedWhisperDir: string,
  whisperDir: string,
  rawClipsDir: string,
  rawClipsBackupDir: string,
  tempDir: string,
): boolean {
  const trimSec = review.audio_timing?.trim_end_seconds ?? 0;
  if (trimSec === 0) return false;

  const backupPath = join(rawClipsBackupDir, entry.clipFile);
  if (!existsSync(backupPath)) {
    log.warn(`[${entry.rank}] No backup at ${entry.clipFile} — cannot auto-fix`);
    return false;
  }

  const backupDur = probeDurationSec(backupPath);
  const newContentEnd = entry.contentEnd - trimSec;

  if (newContentEnd <= entry.contentStart + 3) {
    log.warn(`[${entry.rank}] Fix would leave <3s of content — skipping`);
    return false;
  }
  if (newContentEnd > backupDur) {
    log.warn(
      `[${entry.rank}] Requested extension (${Math.abs(trimSec).toFixed(1)}s) exceeds backup padding — skipping`,
    );
    return false;
  }

  const newContentDuration = newContentEnd - entry.contentStart;
  log.info(
    `[${entry.rank}] Re-finalizing: contentEnd ${entry.contentEnd.toFixed(2)}s → ${newContentEnd.toFixed(2)}s ` +
      `(${trimSec > 0 ? "trim" : "extend"} ${Math.abs(trimSec).toFixed(1)}s)`,
  );

  const finalizedPath = join(rawClipsDir, entry.clipFile);
  try {
    finalizeClip({
      srcPath: backupPath,
      flashStart: entry.flashStart,
      flashDuration: entry.flashDuration,
      contentStart: entry.contentStart,
      contentDuration: newContentDuration,
      tempDir,
      outPath: finalizedPath,
    });
  } catch (e) {
    log.error(`[${entry.rank}] Re-finalize failed: ${(e as Error).message}`);
    return false;
  }

  // Remap whisper words to the new finalized timeline using the cached padded
  // whisper. If padded whisper is missing, fall back to re-transcribing the
  // finalized clip so captions stay in sync.
  const paddedWhisperPath = join(paddedWhisperDir, entry.clipFile.replace(/\.mp4$/, ".json"));
  const finalWhisperPath = join(whisperDir, entry.clipFile.replace(/\.mp4$/, ".json"));
  try {
    if (existsSync(paddedWhisperPath)) {
      const paddedWords = JSON.parse(readFileSync(paddedWhisperPath, "utf-8")) as WhisperWord[];
      const remapped = remapWhisperForFinalized(
        paddedWords,
        entry.contentStart,
        newContentEnd,
        entry.flashDuration,
      );
      writeFileSync(finalWhisperPath, JSON.stringify(remapped, null, 2), "utf-8");
    } else {
      log.info(`[${entry.rank}] Padded whisper missing, re-transcribing finalized clip`);
      transcribeClip(finalizedPath, finalWhisperPath);
    }
  } catch (e) {
    log.warn(`[${entry.rank}] Whisper remap failed: ${(e as Error).message}`);
  }

  // Patch trim-results entry in-place.
  entry.contentEnd = newContentEnd;
  entry.contentDuration = newContentDuration;
  entry.totalDuration = entry.flashDuration + newContentDuration;
  entry.notes = (entry.notes ? entry.notes + ";" : "") + `gemini-fix:${trimSec > 0 ? "trim" : "extend"}${Math.abs(trimSec).toFixed(1)}s`;
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.streamId) {
    console.log(
      "Usage: review.ts --stream <id> [--clips 1,2,3] [--no-fix|--fix-only]",
    );
    process.exit(1);
  }

  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) {
    log.error(`Stream dir not found for ${args.streamId}`);
    process.exit(1);
  }

  const manifest = loadManifest(args.streamId);
  void manifest;

  const rawClipsDir = join(streamDir, "raw-clips");
  const rawClipsBackupDir = join(streamDir, "raw-clips-backup");
  const whisperDir = join(streamDir, "whisper-captions");
  const paddedWhisperDir = join(streamDir, "temp", "padded-whisper");
  const tempDir = join(streamDir, "temp");
  ensureDir(tempDir);

  // Step 1: run Gemini review unless --fix-only.
  if (!args.fixOnly) {
    const ok = runGeminiReview(streamDir, args.clips);
    if (!ok) {
      log.warn("Gemini review step did not run — aborting fixes");
      process.exit(1);
    }
  }

  const reviewsPath = join(streamDir, "gemini-reviews.json");
  if (!existsSync(reviewsPath)) {
    log.error(`No gemini-reviews.json at ${reviewsPath}`);
    process.exit(1);
  }
  const reviews: GeminiReview[] = JSON.parse(readFileSync(reviewsPath, "utf-8"));
  log.info(`Loaded ${reviews.length} reviews`);

  if (args.noFix) {
    log.info("--no-fix set — stopping after review");
    return;
  }

  const trimResultsPath = join(streamDir, "trim-results.json");
  if (!existsSync(trimResultsPath)) {
    log.error(`trim-results.json missing — nothing to fix`);
    return;
  }
  const trimResults: TrimResults = JSON.parse(readFileSync(trimResultsPath, "utf-8"));

  const ranksToRerender: number[] = [];
  for (const review of reviews) {
    if (review.error) continue;
    if (review.overall_verdict !== "NEEDS_TRIM") continue;
    const rank = parseInt(review.num, 10);
    if (Number.isNaN(rank)) continue;
    if (args.clips && !args.clips.includes(rank)) continue;

    const entry = trimResults.approved.find((e) => e.rank === rank);
    if (!entry) {
      log.warn(`[${rank}] No trim-results entry — skipping`);
      continue;
    }

    const changed = applyFix(
      review,
      entry,
      streamDir,
      paddedWhisperDir,
      whisperDir,
      rawClipsDir,
      rawClipsBackupDir,
      tempDir,
    );
    if (changed) ranksToRerender.push(rank);
  }

  if (ranksToRerender.length === 0) {
    log.info("No fixes applied.");
    return;
  }

  writeFileSync(trimResultsPath, JSON.stringify(trimResults, null, 2), "utf-8");
  log.info(`Patched trim-results.json for ${ranksToRerender.length} clips`);

  // Step 3: re-render affected clips via render-fast --direct.
  const list = ranksToRerender.join(",");
  const cmd = `npx tsx packages/clips/src/render-fast.ts --stream ${args.streamId} --direct --clips ${list}`;
  log.info(`Re-rendering: ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", timeout: 1_800_000 });
  } catch (e) {
    log.error(`Re-render failed: ${(e as Error).message}`);
  }
}

main().catch((err) => {
  log.error("review failed:", err?.message ?? err);
  process.exit(1);
});
