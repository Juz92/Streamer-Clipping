/**
 * generate-thumbnails.ts — YT + TikTok thumbnails per clip.
 *
 * Usage:
 *   npx tsx packages/clips/src/generate-thumbnails.ts --stream <id>
 *   npx tsx packages/clips/src/generate-thumbnails.ts --stream <id> --clips 1,3
 *   npx tsx packages/clips/src/generate-thumbnails.ts --stream <id> --force
 *
 * For each clip in notebooklm-moments.json (or unified-moments.json), extracts
 * a single frame at `thumbnailSec` from the source stream, applies a 9:16
 * center crop, and overlays the neon-glow banner + hook text in two variants:
 *
 *   shorts/thumbnails/yt-NN.jpg  — banner vertically centered (YouTube)
 *   shorts/thumbnails/tt-NN.jpg  — banner in the top third    (TikTok, Reels)
 *
 * The crop is intentionally simple (center 9:16 on the source frame) rather
 * than replicating the per-clip 2-panel / talking layout used at render time.
 * Thumbnails are seen at tiny size — visual readability wins over layout parity.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createLogger, ensureDir } from "@ltx/shared";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import { parseAudioLevels } from "./lib/audio-analyzer.js";

const log = createLogger("thumbs");

interface MomentLike {
  startSec?: number;
  endSec?: number;
  suggestedStartSec?: number;
  suggestedEndSec?: number;
  suggestedDurationSec?: number;
  hook?: string;
  hookText?: string;
  description?: string;
  thumbnailSec?: number;
  coldOpenSec?: number;
  naturalEndSec?: number;
}

function parseArgs(): { streamId?: string; clips?: number[]; force: boolean } {
  const args = process.argv.slice(2);
  const out: { streamId?: string; clips?: number[]; force: boolean } = { force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) out.streamId = args[++i];
    else if (args[i] === "--clips" && args[i + 1])
      out.clips = args[++i].split(",").map((s) => parseInt(s.trim(), 10));
    else if (args[i] === "--force") out.force = true;
  }
  return out;
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%");
}

function splitHookText(hook: string): [string, string] {
  const words = hook.split(/\s+/);
  if (words.length <= 2) return [hook, ""];

  let capsStart = words.length;
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i] === words[i].toUpperCase() && words[i].length > 1) {
      capsStart = i;
    } else {
      break;
    }
  }
  if (capsStart < words.length && capsStart > 0) {
    return [words.slice(0, capsStart).join(" "), words.slice(capsStart).join(" ")];
  }
  const mid = Math.floor(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

/**
 * Build a drawbox+drawtext filter chain that renders the hook banner at a
 * given vertical anchor. Matches the in-video hook style (yellow Impact,
 * orange shadow, white semi-transparent banner).
 */
function buildBannerFilters(hookText: string, bannerY: number): string[] {
  const [line1, line2] = splitHookText(hookText);
  const filters: string[] = [];

  if (line2) {
    const bannerH = 160;
    const line1Y = bannerY + 15;
    const line2Y = bannerY + 75;
    filters.push(`drawbox=y=${bannerY}:w=1080:h=${bannerH}:color=white@0.85:t=fill`);
    filters.push(
      `drawtext=text='${escapeDrawtext(line1)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=54:fontcolor=yellow:borderw=5:shadowcolor=0xFF6600@0.7:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${line1Y}`,
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(line2)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=70:fontcolor=yellow:borderw=6:shadowcolor=0xFF6600@0.8:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${line2Y}`,
    );
  } else {
    const bannerH = 100;
    const textY = bannerY + 15;
    filters.push(`drawbox=y=${bannerY}:w=1080:h=${bannerH}:color=white@0.85:t=fill`);
    filters.push(
      `drawtext=text='${escapeDrawtext(line1)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=70:fontcolor=yellow:borderw=6:shadowcolor=0xFF6600@0.8:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${textY}`,
    );
  }
  return filters;
}

function extractThumb(
  sourcePath: string,
  atSec: number,
  hookText: string,
  bannerY: number,
  outPath: string,
): void {
  const base = `crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920`;
  const banner = hookText ? buildBannerFilters(hookText, bannerY).join(",") : "";
  const vf = banner ? `${base},${banner}` : base;

  const cmd = [
    `ffmpeg`,
    `-ss ${atSec.toFixed(3)}`,
    `-i "${sourcePath.replace(/\\/g, "/")}"`,
    `-frames:v 1`,
    `-vf "${vf}"`,
    `-q:v 2`,
    `-y "${outPath.replace(/\\/g, "/")}"`,
  ].join(" ");
  execSync(cmd, { stdio: "pipe" });
}

function loadMoments(streamDir: string): MomentLike[] {
  const nlmPath = join(streamDir, "notebooklm-moments.json");
  const unifiedPath = join(streamDir, "unified-moments.json");
  const momentsPath = join(streamDir, "moments.json");
  if (existsSync(nlmPath)) {
    const parsed = JSON.parse(readFileSync(nlmPath, "utf-8")) as MomentLike[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  }
  if (existsSync(unifiedPath)) {
    const parsed = JSON.parse(readFileSync(unifiedPath, "utf-8")) as MomentLike[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  }
  if (existsSync(momentsPath)) {
    return JSON.parse(readFileSync(momentsPath, "utf-8")) as MomentLike[];
  }
  throw new Error("No notebooklm-moments.json, unified-moments.json, or moments.json found");
}

/**
 * Find the timestamp with peak audio energy within a clip's range.
 * Uses RMS audio data when available; falls back to midpoint.
 * Biases slightly before the peak (0.3s) to catch the reaction face
 * rather than the post-peak calm.
 */
function findPeakThumbTime(
  startSec: number,
  endSec: number,
  audioSamples: { timeSec: number; rmsLevel: number }[] | null,
): number {
  if (!audioSamples || audioSamples.length === 0) {
    return (startSec + endSec) / 2;
  }

  const inRange = audioSamples.filter((s) => s.timeSec >= startSec && s.timeSec <= endSec);
  if (inRange.length === 0) return (startSec + endSec) / 2;

  let peakSample = inRange[0];
  for (const s of inRange) {
    if (s.rmsLevel > peakSample.rmsLevel) {
      peakSample = s;
    }
  }

  const biasedPeak = Math.max(startSec, peakSample.timeSec - 0.3);
  return Math.min(biasedPeak, endSec);
}

function findRenderedShort(shortsDir: string, rank: number): string | null {
  if (!existsSync(shortsDir)) return null;
  const prefix = String(rank).padStart(2, "0") + "-";
  const match = readdirSync(shortsDir).find((f) => f.startsWith(prefix) && f.endsWith(".mp4"));
  return match ? join(shortsDir, match) : null;
}

function extractRenderedFrame0(shortPath: string, outPath: string): void {
  execSync(
    `ffmpeg -nostdin -i "${shortPath.replace(/\\/g, "/")}" -frames:v 1 -q:v 2 -y "${outPath.replace(/\\/g, "/")}"`,
    { stdio: "pipe" },
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.streamId) {
    console.log("Usage: generate-thumbnails.ts --stream <id> [--clips 1,2,3] [--force]");
    process.exit(1);
  }

  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) {
    log.error(`Stream dir not found for ${args.streamId}`);
    process.exit(1);
  }

  const manifest = loadManifest(args.streamId);

  // Load audio levels for peak-frame detection
  const audioLevelsPath = join(streamDir, "audio_levels.txt");
  const audioSamples = existsSync(audioLevelsPath) ? parseAudioLevels(audioLevelsPath) : null;
  if (audioSamples) {
    log.info(`Loaded audio levels: ${audioSamples.length} samples`);
  }

  const shortsDir = join(streamDir, "shorts");
  const renderedRanks = existsSync(shortsDir)
    ? readdirSync(shortsDir)
        .map((file) => Number(file.match(/^(\d+)-.*\.mp4$/)?.[1]))
        .filter((rank) => Number.isFinite(rank))
        .sort((a, b) => a - b)
    : [];
  const moments = renderedRanks.length > 0 ? [] : loadMoments(streamDir);
  if (renderedRanks.length === 0 && (!manifest.videoPath || !existsSync(manifest.videoPath))) {
    log.error("No rendered Shorts or source stream are available for thumbnails");
    process.exit(1);
  }
  const ranks = renderedRanks.length > 0 ? renderedRanks : moments.map((_, index) => index + 1);
  const thumbsDir = join(shortsDir, "thumbnails");
  ensureDir(thumbsDir);

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const rank of ranks) {
    if (args.clips && !args.clips.includes(rank)) continue;

    const m = moments[rank - 1] ?? {};
    const padded = String(rank).padStart(2, "0");
    const ytPath = join(thumbsDir, `yt-${padded}.jpg`);
    const ttPath = join(thumbsDir, `tt-${padded}.jpg`);

    if (!args.force && existsSync(ytPath) && existsSync(ttPath)) {
      skipped++;
      continue;
    }

    const renderedShort = findRenderedShort(shortsDir, rank);
    if (renderedShort) {
      try {
        extractRenderedFrame0(renderedShort, ytPath);
        extractRenderedFrame0(renderedShort, ttPath);
        generated++;
        log.info(`[${rank}] exact rendered frame 0 → yt-${padded}.jpg + tt-${padded}.jpg`);
      } catch (e) {
        failed++;
        log.error(`[${rank}] Frame-zero export failed: ${(e as Error).message}`);
      }
      continue;
    }

    const startSec = typeof m.startSec === "number" ? m.startSec : m.suggestedStartSec;
    const endSec = typeof m.endSec === "number"
      ? m.endSec
      : typeof m.suggestedEndSec === "number"
        ? m.suggestedEndSec
        : typeof startSec === "number" && typeof m.suggestedDurationSec === "number"
          ? startSec + m.suggestedDurationSec
          : undefined;

    if (typeof startSec !== "number" || typeof endSec !== "number" || endSec <= startSec) {
      failed++;
      log.error(`[${rank}] Missing usable start/end seconds — skipping thumbnail`);
      continue;
    }

    // Pick the frame time with a stronger viral bias.
    // Priority:
    // 1. explicit thumbnailSec from enrichment
    // 2. audio-peak frame within the clip (catches reaction face at max energy)
    // 3. cold-open / flash anchor
    // 4. late-payoff frame near natural end
    // 5. midpoint fallback
    const midpoint = (startSec + endSec) / 2;
    const audioPeak = findPeakThumbTime(startSec, endSec, audioSamples);
    const flashFrame = typeof m.coldOpenSec === "number" && m.coldOpenSec > 0
      ? m.coldOpenSec
      : undefined;
    const payoffFrame = typeof m.naturalEndSec === "number" && m.naturalEndSec > 1.5
      ? Math.max(startSec + 1, m.naturalEndSec - 1.2)
      : undefined;

    let atSec: number;
    if (typeof m.thumbnailSec === "number" && m.thumbnailSec > 0) {
      atSec = m.thumbnailSec;
      log.info(`[${rank}] Using enriched thumbnailSec=${atSec.toFixed(1)}s`);
    } else {
      // Use audio peak unless it's very close to an enriched boundary
      atSec = audioPeak;
      log.info(`[${rank}] Using audio-peak frame t=${atSec.toFixed(1)}s (RMS peak in [${startSec.toFixed(1)}-${endSec.toFixed(1)}])`);
    }
    // Override with flash/payoff only if no explicit thumbnailSec AND audio peak is weak (near midpoint)
    if (typeof m.thumbnailSec !== "number" && Math.abs(audioPeak - midpoint) < 1.0) {
      atSec = flashFrame ?? payoffFrame ?? audioPeak;
      if (atSec !== audioPeak) {
        log.info(`[${rank}] Audio peak was near midpoint, switching to ${flashFrame ? 'flash' : 'payoff'} frame t=${atSec.toFixed(1)}s`);
      }
    }

    const hookText = "";

    try {
      // YouTube: banner at vertical centre (y=1050 puts it just above mid-frame)
      extractThumb(manifest.videoPath, atSec, hookText, 1050, ytPath);
      // TikTok: banner in the top third, above platform UI overlays
      extractThumb(manifest.videoPath, atSec, hookText, 380, ttPath);
      generated++;
      log.info(`[${rank}] t=${atSec.toFixed(1)}s → yt-${padded}.jpg + tt-${padded}.jpg`);
    } catch (e) {
      failed++;
      log.error(`[${rank}] Thumb generation failed: ${(e as Error).message}`);
    }

  }

  log.info(`\nThumbnails: ${generated} generated, ${skipped} skipped, ${failed} failed`);
  log.info(`Output: ${thumbsDir}`);
}

main().catch((err) => {
  log.error("thumbnail generation failed:", err?.message ?? err);
  process.exit(1);
});
