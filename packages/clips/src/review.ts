/**
 * review.ts — post-render Gemini QA + auto-fix + auto-replace for weak clips.
 *
 * Usage:
 *   npx tsx packages/clips/src/review.ts --stream <id>
 *   npx tsx packages/clips/src/review.ts --stream <id> --clips 1,3
 *   npx tsx packages/clips/src/review.ts --stream <id> --no-fix        # review only
 *   npx tsx packages/clips/src/review.ts --stream <id> --fix-only       # assume reviews exist
 *   npx tsx packages/clips/src/review.ts --stream <id> --replace-weak   # replace SKIP/NEEDS_RECUT with alternates
 *
 * Pipeline:
 *   1. Run packages/clips/review/gemini-review.py against this job's shorts dir.
 *   2. Parse <job-dir>/gemini-reviews.json.
 *   3. For each NEEDS_TRIM with a non-zero trim_end_seconds:
 *        - If backup clip exists in raw-clips-backup/ and the target boundary
 *          is within that backup's duration, re-finalize with the adjusted
 *          contentEnd, remap whisper words, patch trim-results.json, then
 *          re-render via render-fast --direct for just that clip.
 *   4. For each SKIP / NEEDS_RECUT (when --replace-weak is passed):
 *        - Pull the next best alternate from the candidate pool for this stream.
 *        - Extract the alternate, trim it, render it, and swap it in.
 *   5. Cap at 1 fix attempt per clip — don't loop forever on ambiguous
 *      Gemini verdicts. User can re-run for a second pass.
 *
 * Requires GEMINI_API_KEY in env.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join, dirname, basename as pathBasename } from "path";
import { createLogger, ensureDir } from "@ltx/shared";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import { finalizeClip, remapWhisperForFinalized } from "./lib/trim-finalize.js";
import { transcribeClip, type WhisperWord } from "./lib/whisper-captions.js";
import { loadPool, type CandidatePointer } from "./lib/candidate-pool.js";
import { computeAutoTrim } from "./lib/enhanced-auto-trim.js";
import { runBatchVisualQA, type VisualQAResult } from "./lib/visual-qa.js";
import { parseAudioLevels } from "./lib/audio-analyzer.js";

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
  editorial_gates?: {
    first_three_seconds_strong?: boolean;
    self_contained?: boolean;
    payoff_arrives_fast?: boolean;
    has_filler_or_dead_middle?: boolean;
    ending_loops_cleanly?: boolean;
  };
  content_quality?: {
    score?: number;
    pacing?: string;
    best_moment_timestamp?: string;
    weakest_section?: string;
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
  replaceWeak: boolean;
} {
  const args = process.argv.slice(2);
  const out: {
    streamId?: string;
    clips?: number[];
    noFix: boolean;
    fixOnly: boolean;
    replaceWeak: boolean;
  } = { noFix: false, fixOnly: false, replaceWeak: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) out.streamId = args[++i];
    else if (args[i] === "--clips" && args[i + 1])
      out.clips = args[++i].split(",").map((s) => parseInt(s.trim(), 10));
    else if (args[i] === "--no-fix") out.noFix = true;
    else if (args[i] === "--fix-only") out.fixOnly = true;
    else if (args[i] === "--replace-weak") out.replaceWeak = true;
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
      "Usage: review.ts --stream <id> [--clips 1,2,3] [--no-fix|--fix-only] [--replace-weak]",
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

  for (const review of reviews) {
    if (review.error) continue;

    const gates = review.editorial_gates;
    const score = review.content_quality?.score ?? 0;
    const weakFirst3 = gates?.first_three_seconds_strong === false;
    const weakContext = gates?.self_contained === false;
    const slowPayoff = gates?.payoff_arrives_fast === false;
    const filler = gates?.has_filler_or_dead_middle === true;
    const badLoop = gates?.ending_loops_cleanly === false;

    if (weakFirst3 || weakContext || slowPayoff || filler || badLoop || score < 6) {
      review.overall_verdict = score < 5 || weakContext || filler ? "SKIP" : "NEEDS_RECUT";
      review.action_items = review.action_items ?? [];
      if (weakFirst3) review.action_items.push("Strengthen first 3 seconds or replace clip");
      if (weakContext) review.action_items.push("Clip needs too much outside context");
      if (slowPayoff) review.action_items.push("Shorten setup so payoff lands faster");
      if (filler) review.action_items.push("Remove dead middle or replace clip");
      if (badLoop) review.action_items.push("End closer to reaction peak for loop value");
      if (score < 6) review.action_items.push("Overall content score too weak for Shorts push");
    }
  }

  // Step 2.5: Run visual QA on rendered shorts
  const shortsDir = join(streamDir, "shorts");
  let visualQA: VisualQAResult[] = [];
  if (existsSync(shortsDir)) {
    log.info("Running visual QA on rendered clips...");
    try {
      visualQA = runBatchVisualQA(streamDir, shortsDir);
      const failedQA = visualQA.filter((q) => !q.passed);
      if (failedQA.length > 0) {
        log.warn(`${failedQA.length} clip(s) failed visual QA:`);
        for (const q of failedQA) {
          log.warn(`  [${q.clipNum}] ${q.issues.join("; ")}`);
        }
      } else {
        log.info("All clips passed visual QA");
      }
    } catch (e) {
      log.warn(`Visual QA failed: ${(e as Error).message}`);
    }
  }

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
  const ranksToReplace: number[] = [];

  for (const review of reviews) {
    if (review.error) continue;
    const rank = parseInt(review.num, 10);
    if (Number.isNaN(rank)) continue;
    if (args.clips && !args.clips.includes(rank)) continue;

    if (review.overall_verdict === "NEEDS_TRIM") {
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
    } else if (review.overall_verdict === "SKIP" || review.overall_verdict === "NEEDS_RECUT") {
      ranksToReplace.push(rank);
    }
  }

  // Add visual QA failures to replacement list
  const qaFailedRanks = visualQA
    .filter((q) => !q.passed)
    .map((q) => q.clipNum);
  for (const rank of qaFailedRanks) {
    if (!ranksToReplace.includes(rank)) {
      ranksToReplace.push(rank);
      log.warn(`[${rank}] Added to replacement queue — visual QA failed`);
    }
  }

  // Step 3: auto-replace weak clips with alternates if --replace-weak.
  let replacedRanks: number[] = [];
  if (args.replaceWeak && ranksToReplace.length > 0) {
    log.info(`\n${"=".repeat(60)}`);
    log.info(`  REPLACING ${ranksToReplace.length} WEAK CLIP(S)`);
    log.info(`${"=".repeat(60)}`);
    replacedRanks = await replaceWeakClips(
      ranksToReplace,
      streamDir,
      rawClipsDir,
      rawClipsBackupDir,
      whisperDir,
      paddedWhisperDir,
      tempDir,
      trimResults,
    );
    ranksToRerender.push(...replacedRanks);
  } else if (ranksToReplace.length > 0) {
    log.warn(`Weak clips flagged but --replace-weak not set: ${ranksToReplace.join(", ")}`);
    log.warn("Pass --replace-weak to auto-swap them with alternates.");
  }

  const unresolvedWeak = ranksToReplace.filter((rank) => !replacedRanks.includes(rank));
  if (unresolvedWeak.length > 0) {
    log.error(`Hard QA gate failed: unresolved weak/visual-failed clip(s): ${unresolvedWeak.join(", ")}`);
    log.error("Blocking downstream thumbnail/metadata/upload work until these are recut, replaced, or manually approved.");
    process.exit(1);
  }

  // Persist any trim fixes.
  if (ranksToRerender.length > 0) {
    writeFileSync(trimResultsPath, JSON.stringify(trimResults, null, 2), "utf-8");
    log.info(`Patched trim-results.json for ${ranksToRerender.length} clips`);
  }

  // Step 4: re-render affected clips via render-fast --direct.
  if (ranksToRerender.length > 0) {
    const uniqueRanks: number[] = [];
    for (const r of ranksToRerender) {
      if (!uniqueRanks.includes(r)) uniqueRanks.push(r);
    }
    const list = uniqueRanks.join(",");
    const cmd = `npx tsx packages/clips/src/render-fast.ts --stream ${args.streamId} --direct --clips ${list}`;
    log.info(`Re-rendering: ${cmd}`);
    try {
      execSync(cmd, { stdio: "inherit", timeout: 1_800_000 });
    } catch (e) {
      log.error(`Re-render failed: ${(e as Error).message}`);
    }
  } else {
    log.info("No clips to re-render.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auto-replace logic — pull alternates from candidate pool or reserve clips
// ─────────────────────────────────────────────────────────────────────────────

async function replaceWeakClips(
  ranks: number[],
  streamDir: string,
  rawClipsDir: string,
  rawClipsBackupDir: string,
  whisperDir: string,
  paddedWhisperDir: string,
  tempDir: string,
  trimResults: TrimResults,
): Promise<number[]> {
  const replaced: number[] = [];
  const manifest = loadManifest(trimResults.streamId);
  const streamPath = manifest.videoPath;

  // Try candidate pool first.
  const poolPath = join(process.cwd(), "data", "clips", "candidate-pool.json");
  let alternates: CandidatePointer[] = [];
  try {
    const pool = loadPool(poolPath);
    alternates = pool.candidates
      .filter(
        (c) =>
          c.streamId === trimResults.streamId &&
          c.status === "pending" &&
          !trimResults.approved.some((a) => a.clipFile.includes(c.momentId)),
      )
      .sort((a, b) => b.viralScore - a.viralScore);
  } catch {
    log.warn("Could not load candidate pool for replacement");
  }

  // Fall back to reserve clips in raw-clips/.
  const reserveFiles = readdirSync(rawClipsDir)
    .filter((f) => f.endsWith(".mp4") && !f.match(/^\d+-/))
    .sort();

  for (const rank of ranks) {
    const entry = trimResults.approved.find((e) => e.rank === rank);
    if (!entry) continue;

    log.info(`[${rank}] Attempting replacement for weak clip ${entry.clipFile}`);

    // Pick best alternate.
    let alt: { srcPath: string; isPool: boolean; candidate?: CandidatePointer } | null = null;

    if (alternates.length > 0) {
      const candidate = alternates.shift()!;
      alt = { srcPath: "", isPool: true, candidate };
    } else if (reserveFiles.length > 0) {
      const reserve = reserveFiles.shift()!;
      alt = { srcPath: join(rawClipsDir, reserve), isPool: false };
    }

    if (!alt) {
      log.warn(`[${rank}] No alternates available — skipping replacement`);
      continue;
    }

    // For pool candidates, extract from the full stream.
    let srcPath = alt.srcPath;
    if (alt.isPool && alt.candidate) {
      const c = alt.candidate;
      const altFile = `${String(rank).padStart(2, "0")}-alt-${slugify(c.hook || c.momentId)}.mp4`;
      srcPath = join(rawClipsDir, altFile);
      if (!existsSync(srcPath) && streamPath && existsSync(streamPath)) {
        const pad = 12;
        if (c.startSec == null || c.endSec == null) {
          log.warn(`[${rank}] Candidate ${c.momentId} has no stream timestamps — cannot safely extract alternate`);
          continue;
        }
        const start = Math.max(0, c.startSec - pad);
        const dur = Math.min(Math.max(c.endSec - c.startSec + pad * 2, 8), 60);
        try {
          execSync(
            `ffmpeg -ss ${start.toFixed(1)} -i "${streamPath.replace(/\\/g, "/")}" -t ${dur.toFixed(1)} -c copy "${srcPath.replace(/\\/g, "/")}" -y`,
            { stdio: "pipe" },
          );
          log.info(`[${rank}] Extracted alternate from stream: ${altFile}`);
        } catch (e) {
          log.error(`[${rank}] Alternate extraction failed: ${(e as Error).message}`);
          continue;
        }
      }
    }

    if (!existsSync(srcPath)) {
      log.warn(`[${rank}] Alternate source missing — skipping`);
      continue;
    }

    // Auto-trim the alternate.
    const paddedDur = probeDurationSec(srcPath);
    if (paddedDur < 5) {
      log.warn(`[${rank}] Alternate too short (${paddedDur}s) — skipping`);
      continue;
    }

    const paddedWhisperPath = join(paddedWhisperDir, pathBasename(srcPath).replace(/\.mp4$/, ".json"));
    let paddedWords: WhisperWord[] | null = null;
    try {
      if (!existsSync(paddedWhisperPath)) {
        paddedWords = transcribeClip(srcPath, paddedWhisperPath);
      } else {
        paddedWords = JSON.parse(readFileSync(paddedWhisperPath, "utf-8")) as WhisperWord[];
      }
    } catch (e) {
      log.warn(`[${rank}] Whisper failed on alternate: ${(e as Error).message}`);
    }

    let audioSamples = null;
    const audioLevelsFile = join(streamDir, "audio_levels.txt");
    if (existsSync(audioLevelsFile)) {
      try {
        const allSamples = parseAudioLevels(audioLevelsFile);
        const paddedStartAbs = 0; // alternate is already extracted
        audioSamples = allSamples
          .filter((s) => s.timeSec >= paddedStartAbs && s.timeSec <= paddedStartAbs + paddedDur)
          .map((s) => ({ timeSec: s.timeSec - paddedStartAbs, rmsLevel: s.rmsLevel }));
      } catch {}
    }

    const trimResult = computeAutoTrim({
      paddedDurationSec: paddedDur,
      signalStartInClipSec: 2,
      signalEndInClipSec: paddedDur - 2,
      whisperWords: paddedWords,
      audioSamples,
    });

    // Finalize alternate into the original clip slot.
    const outPath = join(rawClipsDir, entry.clipFile);
    try {
      finalizeClip({
        srcPath,
        flashStart: trimResult.flashStart,
        flashDuration: trimResult.flashDuration,
        contentStart: trimResult.contentStart,
        contentDuration: trimResult.contentDuration,
        tempDir,
        outPath,
      });
    } catch (e) {
      log.error(`[${rank}] Finalize of alternate failed: ${(e as Error).message}`);
      continue;
    }

    // Remap whisper for render.
    if (paddedWords) {
      const remapped = remapWhisperForFinalized(
        paddedWords,
        trimResult.contentStart,
        trimResult.contentEnd,
        trimResult.flashDuration,
      );
      const finalWhisperPath = join(whisperDir, entry.clipFile.replace(/\.mp4$/, ".json"));
      writeFileSync(finalWhisperPath, JSON.stringify(remapped, null, 2), "utf-8");
    }

    // Update trim-results entry.
    entry.flashStart = trimResult.flashStart;
    entry.flashDuration = trimResult.flashDuration;
    entry.contentStart = trimResult.contentStart;
    entry.contentEnd = trimResult.contentEnd;
    entry.contentDuration = trimResult.contentDuration;
    entry.totalDuration = trimResult.flashDuration + trimResult.contentDuration;
    entry.notes = (entry.notes ? entry.notes + ";" : "") + `replaced:${alt.isPool ? "pool" : "reserve"}`;

    replaced.push(rank);
    log.info(`[${rank}] Replaced with alternate (${alt.isPool ? "pool" : "reserve"}) → ${entry.clipFile}`);
  }

  return replaced;
}

function slugify(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 30)
    .toLowerCase();
}

main().catch((err) => {
  log.error("review failed:", err?.message ?? err);
  process.exit(1);
});
