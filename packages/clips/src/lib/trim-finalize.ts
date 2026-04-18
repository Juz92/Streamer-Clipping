/**
 * trim-finalize.ts — shared flash+content assembly used by both the browser
 * trimmer and the --auto path.
 *
 * Given a padded raw clip and four numbers (flashStart, flashDuration,
 * contentStart, contentDuration — all clip-relative seconds), it re-encodes
 * the two segments with the project's h264/aac profile and concats them into
 * a single output file. Callers decide whether to overwrite the padded clip
 * or emit to a new path.
 *
 * Also exposes a helper that remaps clip-relative whisper words from the
 * padded timeline to the finalized timeline (flash at t=0, content at
 * t=flashDuration..), matching what render-fast.ts's default path expects.
 */

import { execSync } from "child_process";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join, basename } from "path";
import type { WhisperWord } from "./whisper-captions.js";

const ENCODE_OPTS = "-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k";

export interface FinalizeOptions {
  /** Padded raw clip that the boundaries are relative to. */
  srcPath: string;
  flashStart: number;
  flashDuration: number;
  contentStart: number;
  contentDuration: number;
  /** Scratch directory for intermediate files. */
  tempDir: string;
  /** Where the assembled clip should land. If it equals srcPath, the source is replaced. */
  outPath: string;
}

/**
 * Extract the flash, extract the content, concat demuxer. The two segments
 * are re-encoded independently so the audio joins cleanly; concat of two
 * stream-copied offsets would break timestamps at the seam.
 */
export function finalizeClip(opts: FinalizeOptions): void {
  const { srcPath, flashStart, flashDuration, contentStart, contentDuration, tempDir, outPath } = opts;

  const slug = basename(outPath).replace(/\.mp4$/i, "");
  const flashPath = join(tempDir, `flash-${slug}.mp4`).replace(/\\/g, "/");
  const contentPath = join(tempDir, `content-${slug}.mp4`).replace(/\\/g, "/");
  const concatPath = join(tempDir, `concat-${slug}.txt`).replace(/\\/g, "/");
  const assembledPath = join(tempDir, `out-${slug}.mp4`).replace(/\\/g, "/");
  const srcEsc = srcPath.replace(/\\/g, "/");

  execSync(
    `ffmpeg -ss ${flashStart} -i "${srcEsc}" -t ${flashDuration} ${ENCODE_OPTS} "${flashPath}" -y`,
    { stdio: "pipe" },
  );
  execSync(
    `ffmpeg -ss ${contentStart} -i "${srcEsc}" -t ${contentDuration} ${ENCODE_OPTS} "${contentPath}" -y`,
    { stdio: "pipe" },
  );

  writeFileSync(concatPath, `file '${flashPath}'\nfile '${contentPath}'\n`);
  execSync(
    `ffmpeg -f concat -safe 0 -i "${concatPath}" ${ENCODE_OPTS} "${assembledPath}" -y`,
    { stdio: "pipe" },
  );

  if (existsSync(outPath)) unlinkSync(outPath);
  renameSync(assembledPath, outPath);

  for (const f of [flashPath, contentPath, concatPath]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

/**
 * Remap padded-clip whisper words to the finalized timeline.
 *
 * The finalized clip has the flash at [0, flashDurationMs) followed by the
 * content at [flashDurationMs, flashDurationMs + contentDurationMs). We only
 * keep content words (the flash is an energy moment, not captioned) and
 * shift them so they line up with the rendered video.
 */
export function remapWhisperForFinalized(
  paddedWords: WhisperWord[],
  contentStartSec: number,
  contentEndSec: number,
  flashDurationSec: number,
): WhisperWord[] {
  const contentStartMs = contentStartSec * 1000;
  const contentEndMs = contentEndSec * 1000;
  const flashMs = flashDurationSec * 1000;

  return paddedWords
    .filter((w) => w.startMs >= contentStartMs && w.endMs <= contentEndMs + 500)
    .map((w) => ({
      word: w.word,
      startMs: flashMs + (w.startMs - contentStartMs),
      endMs: flashMs + (w.endMs - contentStartMs),
    }));
}
