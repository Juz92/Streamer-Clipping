/**
 * generate-thumbnails.ts — export exact frame-zero JPGs from final Shorts.
 *
 * Usage:
 *   npx tsx packages/clips/src/generate-thumbnails.ts --stream <id>
 *   npx tsx packages/clips/src/generate-thumbnails.ts --stream <id> --clips 1,3
 *   npx tsx packages/clips/src/generate-thumbnails.ts --stream <id> --force
 */

import { execFileSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { createLogger, ensureDir } from "@ltx/shared";
import { findStreamDir } from "./lib/manifest.js";

const log = createLogger("thumbs");

function parseArgs(): { streamId?: string; clips?: number[]; force: boolean } {
  const args = process.argv.slice(2);
  const out: { streamId?: string; clips?: number[]; force: boolean } = { force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) out.streamId = args[++i];
    else if (args[i] === "--clips" && args[i + 1])
      out.clips = args[++i].split(",").map((value) => Number(value.trim()));
    else if (args[i] === "--force") out.force = true;
  }
  return out;
}

function extractRenderedFrame0(shortPath: string, outPath: string): void {
  execFileSync("ffmpeg", [
    "-nostdin", "-v", "error", "-i", shortPath, "-frames:v", "1", "-q:v", "2", "-y", outPath,
  ]);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.streamId) {
    throw new Error("Usage: generate-thumbnails.ts --stream <id> [--clips 1,2,3] [--force]");
  }

  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) throw new Error(`Stream dir not found for ${args.streamId}`);

  const shortsDir = join(streamDir, "shorts");
  const rendered = new Map<number, string>();
  if (existsSync(shortsDir)) {
    for (const file of readdirSync(shortsDir).sort()) {
      const match = file.match(/^(\d+)-.*\.mp4$/);
      if (match && !file.includes(".body-tmp.")) rendered.set(Number(match[1]), join(shortsDir, file));
    }
  }
  if (rendered.size === 0) {
    throw new Error("No rendered Shorts are available; thumbnails must be decoded from final MP4 frame zero");
  }

  const thumbsDir = join(shortsDir, "thumbnails");
  ensureDir(thumbsDir);
  let generated = 0;
  let skipped = 0;

  for (const [rank, shortPath] of rendered) {
    if (args.clips && !args.clips.includes(rank)) continue;
    const padded = String(rank).padStart(2, "0");
    const ytPath = join(thumbsDir, `yt-${padded}.jpg`);
    const ttPath = join(thumbsDir, `tt-${padded}.jpg`);
    if (!args.force && existsSync(ytPath) && existsSync(ttPath)) {
      skipped++;
      continue;
    }
    extractRenderedFrame0(shortPath, ytPath);
    extractRenderedFrame0(shortPath, ttPath);
    generated++;
    log.info(`[${rank}] exact rendered frame 0 → yt-${padded}.jpg + tt-${padded}.jpg`);
  }

  log.info(`\nThumbnails: ${generated} generated, ${skipped} skipped`);
  log.info(`Output: ${thumbsDir}`);
}

main().catch((err) => {
  log.error("thumbnail generation failed:", err?.message ?? err);
  process.exit(1);
});
