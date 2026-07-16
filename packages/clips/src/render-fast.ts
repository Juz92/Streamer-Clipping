import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { createLogger, ensureDir } from "@ltx/shared";
import { getStreamDir, loadManifest, saveManifest } from "./lib/manifest.js";
import {
  parseVtt,
  vttToWordTimestamps,
  filterByTimeRange,
} from "./lib/subtitle-parser.js";
import { loadWhisperCaptions, type WhisperWord } from "./lib/whisper-captions.js";
import { detectLayoutMode } from "./lib/layout.js";
import { loadChannelConfig, type Region } from "./lib/config.js";
import type { Moment } from "./lib/scorer.js";
import type { LayoutMode } from "./lib/layout.js";
import { planMotion, buildZoompanFilter, type MotionPlan } from "./lib/motion.js";
import { insertEmojis, CAPTION_EMOJI_FONT } from "./lib/caption-emoji.js";
import { loadValidatedGroundedPromoted } from "./lib/candidate-contract.js";
import { assertApprovedReviewWindows, assertFrame0Package, selectPromotedEntries } from "./quality-gates.js";

const log = createLogger("render-fast");

function markRendered(streamId: string): void {
  try {
    const manifest = loadManifest(streamId);
    manifest.phase = "rendered";
    saveManifest(manifest);
  } catch (e) {
    log.warn(`Could not update manifest phase: ${(e as Error).message}`);
  }
}

// Daily Peanut house style:
// - talking/setup clips should reframe tightly on the Peanut avatar panel;
// - gameplay clips should be a clean two-panel stack: avatar panel + reframed gameplay.
// Older jobs sometimes have zeroed avatar coords in channel-config.json, so keep
// sane source-space defaults here instead of silently falling back to full-frame crops.
// Final v8 Daily Peanut layout (2026-07 learnings): source is 1920x1080.
// Top panel uses a wide left/center source crop, then zooms another ~25% and
// bottom-aligns so the avatar sits on the join line. Bottom gameplay uses a
// right-biased 1320x1080 crop to avoid duplicating the Peanut/dog facecam.
const DAILY_PEANUT_AVATAR_REGION: Region = { x: 0, y: 0, w: 1620, h: 1080 };
const DAILY_PEANUT_GAMEPLAY_REGION: Region = { x: 408, y: 0, w: 1320, h: 1080 };
const DAILY_PEANUT_V8_GAMEPLAY_BY_RANK: Record<number, Region> = {
  1: { x: 276, y: 0, w: 1500, h: 1080 },
  2: { x: 408, y: 0, w: 1320, h: 1080 },
  3: { x: 408, y: 0, w: 1320, h: 1080 },
  4: { x: 252, y: 0, w: 1620, h: 1080 },
  5: { x: 960, y: 0, w: 960, h: 1080 },
  6: { x: 408, y: 0, w: 1320, h: 1080 },
};

interface StreamStyleOverride {
  avatar?: Region;
  frame0Avatar?: Region;
  gameplay?: Region;
  gameplayByRank?: Record<number, Region>;
}

// Stream-specific house-style overrides, authored in 1920x1080 source space.
// gp4sqhiaxNo is a 720p Holdfast stream where the Peanut/avatar sits much
// smaller and lower/right than job-002. Reusing the job-002 wide-left avatar
// crop makes it look like the old/generic layout, with Peanut tiny in the top
// panel. These values map to roughly x120 y300 w520 h370 on 1280x720 source.
const DAILY_PEANUT_STREAM_STYLE_OVERRIDES: Record<string, StreamStyleOverride> = {
  "wKJwi-MMLJQ": {
    avatar: DAILY_PEANUT_AVATAR_REGION,
    gameplayByRank: DAILY_PEANUT_V8_GAMEPLAY_BY_RANK,
  },
  "H-_9Fgs5tIg": {
    // Peanut is bottom-left in both games on this VOD. Match the approved v8
    // zoom/lift and start gameplay immediately after the avatar silhouette.
    avatar: { x: 97, y: 684, w: 556, h: 396 },
    frame0Avatar: { x: 235, y: 560, w: 300, h: 520 },
    gameplay: { x: 560, y: 0, w: 1012, h: 1080 },
  },
  gp4sqhiaxNo: {
    // 1280x720 equivalent: x195 y353 w371 h264. This matches the approved v8
    // zoom/lift while preserving the shared bottom-aligned top-panel crop.
    avatar: { x: 292, y: 530, w: 556, h: 396 },
    frame0Avatar: { x: 330, y: 381, w: 390, h: 693 },
    // ponytail: exact 675x720 effective crops; leftmost edge per clip that
    // excludes Peanut. Re-probe only when the stream overlay moves.
    gameplayByRank: {
      1: { x: 540, y: 0, w: 1012, h: 1080 },
      2: { x: 540, y: 0, w: 1012, h: 1080 },
      3: { x: 600, y: 0, w: 1012, h: 1080 },
      4: { x: 540, y: 0, w: 1012, h: 1080 },
      5: { x: 540, y: 0, w: 1012, h: 1080 },
      6: { x: 480, y: 0, w: 1012, h: 1080 },
      7: { x: 600, y: 0, w: 1012, h: 1080 },
      8: { x: 600, y: 0, w: 1012, h: 1080 },
      9: { x: 600, y: 0, w: 1012, h: 1080 },
      10: { x: 720, y: 0, w: 1012, h: 1080 },
    },
  },
};

function assertStreamStyleCalibrated(streamId: string): void {
  if (!DAILY_PEANUT_STREAM_STYLE_OVERRIDES[streamId]) {
    throw new Error(`No verified avatar/gameplay crop for ${streamId}; probe the stream before rendering`);
  }
}

const ENABLE_LEGACY_BODY_HOOK_BANNER = process.env.STREAMER_LEGACY_BODY_HOOK_BANNER === "1";

function isUsableRegion(region: Region | undefined | null): region is Region {
  return !!region && region.w > 0 && region.h > 0;
}

function normalizeAvatarRegion(region: Region | undefined | null): Region {
  return isUsableRegion(region) ? region : DAILY_PEANUT_AVATAR_REGION;
}

function normalizeGameplayRegion(region: Region | undefined | null): Region {
  return isUsableRegion(region) ? region : DAILY_PEANUT_GAMEPLAY_REGION;
}

function defaultAvatarRegion(streamId?: string): Region {
  return DAILY_PEANUT_STREAM_STYLE_OVERRIDES[streamId ?? ""]?.avatar ?? DAILY_PEANUT_AVATAR_REGION;
}

function defaultFrame0AvatarRegion(streamId: string | undefined, fallback: Region): Region {
  return DAILY_PEANUT_STREAM_STYLE_OVERRIDES[streamId ?? ""]?.frame0Avatar ?? fallback;
}

function defaultGameplayRegion(streamId: string | undefined, rank: number): Region {
  const override = DAILY_PEANUT_STREAM_STYLE_OVERRIDES[streamId ?? ""];
  return override?.gameplayByRank?.[rank]
    ?? override?.gameplay
    ?? DAILY_PEANUT_V8_GAMEPLAY_BY_RANK[rank]
    ?? DAILY_PEANUT_GAMEPLAY_REGION;
}

interface RenderFastOptions {
  streamId: string;
  clips: number[];
  all: boolean;
  noCaptions: boolean;
  srtPath?: string;
  layoutOverride?: LayoutMode;
}

/**
 * Escape paths for ffmpeg filter_complex.
 * Colons must be escaped as \: and backslashes as /
 */
function escapePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * Group caption words into deterministic max-3-word chunks.
 * Shorts readability beats density; v8 QA rejected 4-word caption groups.
 */
function generateCaptionChunks(
  words: Array<{ word: string; startMs: number; endMs: number }>,
): Array<{
  startMs: number;
  endMs: number;
  words: Array<{ word: string; startMs: number; endMs: number }>;
}> {
  if (words.length === 0) return [];

  const chunks: Array<{
    startMs: number;
    endMs: number;
    words: Array<{ word: string; startMs: number; endMs: number }>;
  }> = [];
  let i = 0;

  while (i < words.length) {
    const chunk = words.slice(i, i + 3);

    chunks.push({
      startMs: chunk[0].startMs,
      endMs: chunk[chunk.length - 1].endMs,
      words: chunk.map((w) => ({
        word: w.word.toUpperCase(),
        startMs: w.startMs,
        endMs: w.endMs,
      })),
    });

    i += chunk.length;
  }

  return chunks;
}

/**
 * Convert milliseconds to ASS timestamp format H:MM:SS.cc
 */
function msToAssTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Write ASS karaoke subtitle file with \kf per-word timing.
 * Words transition from white (unspoken) to yellow (spoken).
 */
function writeKaraokeAss(
  chunks: Array<{
    startMs: number;
    endMs: number;
    words: Array<{ word: string; startMs: number; endMs: number }>;
  }>,
  layoutMode: LayoutMode,
  outputPath: string,
  fontname = "Arial",
): void {
  const alignment = layoutMode === "gameplay" ? 8 : 2;
  const marginV = layoutMode === "gameplay" ? 752 : 200;

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontname},36,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,${alignment},20,20,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  for (const chunk of chunks) {
    const kfParts = chunk.words.map((w) => {
      const durCs = Math.max(10, Math.round((w.endMs - w.startMs) / 10));
      return `{\\kf${durCs}}${w.word}`;
    });

    const text = kfParts.join(" ");
    const startT = msToAssTime(chunk.startMs);
    const endT = msToAssTime(chunk.endMs);
    lines.push(`Dialogue: 0,${startT},${endT},Default,,0,0,0,,${text}`);
  }

  writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");
}

/**
 * Write SRT file from caption chunks (fallback when ASS is not needed).
 */
function writeSrtFile(
  chunks: Array<{
    startMs: number;
    endMs: number;
    words: Array<{ word: string; startMs: number; endMs: number }>;
  }>,
  outputPath: string,
): void {
  const msToSrtTime = (ms: number): string => {
    const totalSec = ms / 1000;
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = Math.floor(totalSec % 60);
    const milliseconds = Math.floor(ms % 1000);

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
  };

  const lines: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    lines.push(String(i + 1));
    lines.push(`${msToSrtTime(chunk.startMs)} --> ${msToSrtTime(chunk.endMs)}`);
    lines.push(chunk.words.map((w) => w.word).join(" "));
    lines.push("");
  }

  writeFileSync(outputPath, lines.join("\n"), "utf-8");
}

/**
 * Parse upload-metadata.md to extract YouTube Shorts titles per clip number.
 * Returns a Map<number, string> mapping clip rank (1-based) to hook text.
 */
function parseHookTexts(streamDir: string): Map<number, string> {
  const hooks = new Map<number, string>();
  const jsonPath = join(streamDir, "upload-metadata.json");

  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
        items?: Array<{ rank?: number; clipNum?: number; ytTitle?: string; title?: string }>;
      };
      for (const item of parsed.items ?? []) {
        const rank = item.rank ?? item.clipNum;
        const title = (item.ytTitle ?? item.title)?.trim();
        if (rank && title) hooks.set(rank, title.replace(/[^\x20-\x7E]/g, "").trim());
      }
    } catch {
      // Keep falling back to markdown hooks.
    }
  }

  const metaPath = join(streamDir, "upload-metadata.md");
  if (!existsSync(metaPath)) return hooks;

  const content = readFileSync(metaPath, "utf-8");
  // Match sections: ## NN -- Slug ...
  // Then find **YouTube Shorts Title:** line
  const sectionRegex = /^## (\d+)\s*--/gm;
  let match: RegExpExecArray | null;
  const sectionStarts: Array<{ rank: number; start: number }> = [];

  while ((match = sectionRegex.exec(content)) !== null) {
    sectionStarts.push({ rank: parseInt(match[1], 10), start: match.index });
  }

  for (let i = 0; i < sectionStarts.length; i++) {
    const start = sectionStarts[i].start;
    const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].start : content.length;
    const section = content.slice(start, end);

    const titleMatch = section.match(/\*\*YouTube Shorts Title:\*\*\s*(.+)/);
    if (titleMatch) {
      // Strip non-ASCII for ffmpeg drawtext compatibility (emojis render as □)
      const title = titleMatch[1].trim().replace(/[^\x20-\x7E]/g, "").trim();
      if (title) {
        hooks.set(sectionStarts[i].rank, title);
      }
    }
  }

  return hooks;
}

interface Frame0MetadataItem {
  rank?: number;
  clipNum?: number;
  frame0Hook?: string;
  frame0OffsetSec?: number;
}

function loadFrame0MetadataItems(streamDir: string): Frame0MetadataItem[] {
  const jsonPath = join(streamDir, "upload-metadata.json");
  if (!existsSync(jsonPath)) throw new Error("upload-metadata.json is required before rendering");
  const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as { items?: Frame0MetadataItem[] };
  return parsed.items ?? [];
}

function getFrame0Spec(items: Frame0MetadataItem[], rank: number, duration: number): { hookText: string; offsetSec: number } {
  assertFrame0Package(items, { [rank]: duration });
  const item = items.find((candidate) => (candidate.rank ?? candidate.clipNum) === rank)!;
  return { hookText: item.frame0Hook!.trim(), offsetSec: item.frame0OffsetSec! };
}

/**
 * Find raw clip file for a given rank in the raw-clips directory.
 * When multiple files match the rank prefix, prefer the one whose duration
 * is closest to expectedDurationSec (the flash-padded version).
 */
function findRawClip(
  rawClipsDir: string,
  rank: number,
  expectedDurationSec?: number,
): string | null {
  if (!existsSync(rawClipsDir)) return null;
  const prefix = String(rank).padStart(2, "0") + "-";
  const files = readdirSync(rawClipsDir).filter(
    (f) => f.startsWith(prefix) && f.endsWith(".mp4"),
  );
  if (files.length === 0) return null;
  if (files.length === 1) return join(rawClipsDir, files[0]);

  // Multiple matches — pick the one closest to expected duration
  if (expectedDurationSec != null) {
    let bestFile = files[0];
    let bestDelta = Infinity;
    for (const f of files) {
      try {
        const dur = parseFloat(
          execSync(
            `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${join(rawClipsDir, f)}"`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          ).trim(),
        );
        const delta = Math.abs(dur - expectedDurationSec);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestFile = f;
        }
      } catch {
        // skip unreadable files
      }
    }
    return join(rawClipsDir, bestFile);
  }

  return join(rawClipsDir, files[0]);
}

/**
 * Escape text for ffmpeg drawtext filter.
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%");
}

/**
 * Split hook text into 2 lines: setup + punchline.
 * ALL CAPS words at the end become Line 2 (bigger text).
 */
function splitHookText(hook: string): [string, string] {
  if (hook.includes("/")) {
    const parts = hook.split("/").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) return [parts[0], parts.slice(1).join(" ")];
  }

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
 * Build the legacy body hook banner.
 *
 * This is intentionally disabled by default because the approved v8 Shorts body
 * style is clean split-screen + captions; hook text belongs in frame0/thumbnail
 * only. Set STREAMER_LEGACY_BODY_HOOK_BANNER=1 for old review/debug renders.
 */
function buildHookFilters(hookText: string, bannerY: number = 840, flashDur: number = 2): string {
  const [line1, line2] = splitHookText(hookText);
  const show = `'lt(t,${flashDur})'`;

  const filters: string[] = [];

  if (line2) {
    const bannerH = 160;
    const line1Y = bannerY + 15;
    const line2Y = bannerY + 75;

    filters.push(
      `drawbox=y=${bannerY}:w=1080:h=${bannerH}:color=white@0.85:t=fill:enable=${show}`,
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(line1)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=54:fontcolor=yellow:borderw=5:shadowcolor=0xFF6600@0.7:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${line1Y}:enable=${show}`,
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(line2)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=70:fontcolor=yellow:borderw=6:shadowcolor=0xFF6600@0.8:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${line2Y}:enable=${show}`,
    );
  } else {
    const bannerH = 100;
    const textY = bannerY + 15;

    filters.push(
      `drawbox=y=${bannerY}:w=1080:h=${bannerH}:color=white@0.85:t=fill:enable=${show}`,
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(line1)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=70:fontcolor=yellow:borderw=6:shadowcolor=0xFF6600@0.8:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${textY}:enable=${show}`,
    );
  }

  return filters.join(",");
}

/**
 * Get video duration in seconds via ffprobe.
 */
function getVideoDuration(videoPath: string): number {
  const output = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
    { encoding: "utf-8" },
  );
  return parseFloat(output.trim());
}

function getVideoDimensions(videoPath: string): { width: number; height: number } {
  try {
    const output = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${videoPath}"`,
      { encoding: "utf-8" },
    );
    const parsed = JSON.parse(output) as { streams?: Array<{ width?: number; height?: number }> };
    const stream = parsed.streams?.[0];
    return {
      width: stream?.width ?? 1920,
      height: stream?.height ?? 1080,
    };
  } catch {
    return { width: 1920, height: 1080 };
  }
}

function scaleRegionForSource(region: Region, sourceW: number, sourceH: number): Region {
  // Region defaults are authored in 1920x1080 source space. When disk-pressure
  // downloads use 720p, scale before crop so ffmpeg never sees impossible
  // dimensions like 1620x1080 on a 1280x720 input.
  const sx = sourceW / 1920;
  const sy = sourceH / 1080;
  const x = Math.max(0, Math.min(sourceW - 10, Math.round(region.x * sx)));
  const y = Math.max(0, Math.min(sourceH - 10, Math.round(region.y * sy)));
  const w = Math.max(10, Math.min(sourceW - x, Math.round(region.w * sx)));
  const h = Math.max(10, Math.min(sourceH - y, Math.round(region.h * sy)));
  return { x, y, w, h };
}

function scaleCropXForSource(cropX: number, sourceW: number): number {
  const portraitW = Math.round(sourceW * 9 / 16);
  const maxCropX = Math.max(0, sourceW - portraitW);
  return Math.max(0, Math.min(maxCropX, Math.round(cropX * (sourceW / 1920))));
}

function buildFrame0HookFilters(hookText: string): string {
  const [line1, line2] = splitHookText(hookText.toUpperCase());
  const filters: string[] = [];
  const font = "C\\:/Windows/Fonts/impact.ttf";
  const bannerY = 1220;
  const bannerH = 340;

  // Keep the full hook inside the centered 4:5 crop YouTube may use for
  // vertical-video thumbnails (roughly y=285..1635 on a 1080x1920 frame).
  filters.push(`drawbox=y=${bannerY}:w=1080:h=${bannerH}:color=black@0.76:t=fill`);
  filters.push(`drawbox=y=${bannerY}:w=1080:h=6:color=yellow@0.95:t=fill`);
  if (line2) {
    filters.push(
      `drawtext=text='${escapeDrawtext(line1)}':fontfile='${font}':fontsize=80:fontcolor=white:borderw=7:bordercolor=black:x=(w-text_w)/2:y=1270`,
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(line2)}':fontfile='${font}':fontsize=100:fontcolor=yellow:borderw=8:bordercolor=black:x=(w-text_w)/2:y=1390`,
    );
  } else {
    filters.push(
      `drawtext=text='${escapeDrawtext(line1)}':fontfile='${font}':fontsize=96:fontcolor=yellow:borderw=8:bordercolor=black:x=(w-text_w)/2:y=1345`,
    );
  }

  return filters.join(",");
}

function buildFrame0AvatarFreeze(frame0HookText: string, avatarRegion?: Region): string {
  if (isUsableRegion(avatarRegion)) {
    const cropW = Math.max(2, Math.floor(avatarRegion.w / 2) * 2);
    const cropH = Math.max(2, Math.floor(avatarRegion.h / 2) * 2);
    return `crop=${cropW}:${cropH}:${avatarRegion.x}:${avatarRegion.y},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)/2:(ih-1920)/2,setsar=1,${buildFrame0HookFilters(frame0HookText)}`;
  }
  return `crop=trunc(ih*9/16/2)*2:ih:0:0,scale=1080:1920,setsar=1,${buildFrame0HookFilters(frame0HookText)}`;
}

/**
 * Build filter_complex for gameplay mode.
 * Avatar top 40% (1080x768) + gameplay bottom 60% (1080x1152) with divider + hook + captions.
 */
function buildGameplayFilterComplex(
  avatarX: number,
  avatarY: number,
  avatarW: number,
  avatarH: number,
  hookText?: string,
  gameplayX?: number,
  gameplayY?: number,
  gameplayW?: number,
  gameplayH?: number,
  flashDur?: number,
  motionFilter?: string | null,
  assPath?: string | null,
  frame0HookText?: string,
): string {
  const gx = gameplayX ?? 0;
  const gy = gameplayY ?? 0;
  const gw = gameplayW ?? 1920;
  const gh = gameplayH ?? 1080;

  const hasAvatar = avatarW > 0 && avatarH > 0;

  let filterChain: string;
  if (hasAvatar) {
    filterChain =
      `[0:v]split[v1][v2];` +
      `[v1]crop=${avatarW}:${avatarH}:${avatarX}:${avatarY},scale=1080:768:force_original_aspect_ratio=increase,crop=1080:768:(iw-1080)/2:ih-768[avatar];` +
      `[v2]crop=${gw}:${gh}:${gx}:${gy},scale=1080:1152:force_original_aspect_ratio=increase,crop=1080:1152:(iw-1080)/2:(ih-1152)/2[gameplay];` +
      `[avatar][gameplay]vstack[stacked];` +
      `[stacked]drawbox=y=766:w=1080:h=4:color=white@0.15:t=fill`;
  } else {
    filterChain =
      `[0:v]crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920`;
  }

  if (motionFilter) {
    filterChain += `[composite];[composite]${motionFilter}`;
  }

  if (hookText && ENABLE_LEGACY_BODY_HOOK_BANNER) {
    filterChain += `,${buildHookFilters(hookText, hasAvatar ? 840 : 1700, flashDur ?? 2)}`;
  }

  if (assPath) {
    const assEscaped = escapePath(assPath);
    filterChain += `,subtitles='${assEscaped}'`;
  }

  filterChain += `,setsar=1[final]`;
  return filterChain;
}

/**
 * Build filter_complex for talking mode.
 * Clean 9:16 crop centered on avatar region, scaled to 1080x1920.
 * Uses avatar center as crop anchor when avatarRegion is provided.
 */
function buildTalkingFilterComplex(
  hookText?: string,
  avatarX?: number,
  avatarY?: number,
  avatarW?: number,
  avatarH?: number,
  flashDur?: number,
  motionFilter?: string | null,
  assPath?: string | null,
  frame0HookText?: string,
): string {
  // Talking clips should feel like a single panel of Peanut's avatar, not a
  // generic center crop of the whole 16:9 stream. Use the avatar region as an
  // anchor and build a portrait crop around it.
  const avatar = normalizeAvatarRegion(
    avatarX != null && avatarY != null && avatarW != null && avatarH != null
      ? { x: avatarX, y: avatarY, w: avatarW, h: avatarH }
      : null,
  );
  // Clamp avatar crop to actual source dimensions (source is 1280x720 for Daily Peanut)
  const maxSourceW = 1280;
  const maxSourceH = 720;
  const cropH = Math.round(Math.max(320, Math.min(maxSourceH, avatar.h * 1.45)));
  const cropW = Math.round(cropH * 9 / 16);
  const cropX = Math.max(0, Math.min(maxSourceW - cropW, Math.round(avatar.x + avatar.w / 2 - cropW / 2)));
  const cropY = Math.max(0, Math.min(maxSourceH - cropH, Math.round(avatar.y + avatar.h / 2 - cropH / 2)));

  let filterChain =
    `[0:v]crop=${cropW}:${cropH}:${cropX}:${cropY},scale=1080:1920`;

  if (motionFilter) {
    filterChain += `[scaled];[scaled]${motionFilter}`;
  }

  if (hookText && ENABLE_LEGACY_BODY_HOOK_BANNER) {
    filterChain += `,${buildHookFilters(hookText, 1700, flashDur ?? 2)}`;
  }

  if (assPath) {
    const assEscaped = escapePath(assPath);
    filterChain += `,subtitles='${assEscaped}'`;
  }

  filterChain += `,setsar=1[final]`;
  return filterChain;
}

/**
 * Render a single clip via ffmpeg.
 * Pass 1: Layout + hook overlay.
 * Pass 2: Burn in ASS karaoke subtitles (avoids path escaping issues in filter_complex).
 */
function renderClipFfmpeg(
  clipPath: string,
  layoutMode: LayoutMode,
  outputPath: string,
  options: {
    avatarX: number;
    avatarY: number;
    avatarW: number;
    avatarH: number;
    gameplayX?: number;
    gameplayY?: number;
    gameplayW?: number;
    gameplayH?: number;
    cropX?: number;
    flashDuration?: number;
    assPath: string | null;
    duration: number;
    hookText?: string;
    frame0HookText?: string;
    frame0OffsetSec?: number;
    frame0SourcePath?: string;
    frame0SourceDuration?: number;
    frame0Avatar?: Region;
    motionPlan?: MotionPlan | null;
  },
): void {
  const startTime = Date.now();
  assertFrame0Package([
    { rank: 1, frame0Hook: options.frame0HookText, frame0OffsetSec: options.frame0OffsetSec },
  ], { 1: options.frame0SourceDuration ?? options.duration });
  const flashDur = options.flashDuration ?? 2;

  const motionFilter = options.motionPlan
    ? buildZoompanFilter(options.motionPlan, options.duration)
    : null;

  const filterComplex =
    layoutMode === "gameplay"
      ? buildGameplayFilterComplex(
          options.avatarX,
          options.avatarY,
          options.avatarW,
          options.avatarH,
          options.hookText,
          options.gameplayX,
          options.gameplayY,
          options.gameplayW,
          options.gameplayH,
          flashDur,
          motionFilter,
          options.assPath,
        )
      : buildTalkingFilterComplex(
          options.hookText,
          options.avatarX,
          options.avatarY,
          options.avatarW,
          options.avatarH,
          flashDur,
          motionFilter,
          options.assPath,
        );

  // Write filter_complex to temp file to avoid shell escaping issues on Windows.
  // If frame0HookText is present, render the normal body first, then replace
  // only frame 0 with the full-avatar hook frame. YouTube Shorts uses the first
  // frame as its default thumbnail, while viewers still get the split/talking
  // layout immediately after.
  const tmpFilterPath = outputPath + ".fc.txt";
  const bodyOutputPath = options.frame0HookText ? outputPath.replace(/\.mp4$/i, ".body-tmp.mp4") : outputPath;
  writeFileSync(tmpFilterPath, filterComplex, "utf-8");

  const cmd = [
    `ffmpeg`,
    `-i "${clipPath}"`,
    `-filter_complex_script "${tmpFilterPath}"`,
    `-map "[final]:v"`,
    `-map "0:a"`,
    `-af "loudnorm=I=-16:TP=-1.5:LRA=11"`,
    `-s 1080:1920`,
    `-c:v libx264 -preset fast -crf 18`,
    `-c:a aac -b:a 192k`,
    `-y "${bodyOutputPath}"`,
  ].join(" ");

  try {
    execSync(cmd, { stdio: "inherit", timeout: 300000 });
  } finally {
    try { unlinkSync(tmpFilterPath); } catch { /* ignore */ }
  }

  if (options.frame0HookText) {
    if (typeof options.frame0OffsetSec !== "number") {
      throw new Error("Validated frame0OffsetSec is required when rendering a frame-zero hook");
    }
    const frame0FilterPath = outputPath + ".frame0.fc.txt";
    const frame0Filter =
      `[1:v]select='eq(n,0)',${buildFrame0AvatarFreeze(options.frame0HookText, options.frame0Avatar)},trim=end_frame=1,setpts=PTS-STARTPTS[f0];` +
      `[0:v]trim=start_frame=1,setpts=PTS-STARTPTS[rest];` +
      `[f0][rest]concat=n=2:v=1:a=0[final]`;
    writeFileSync(frame0FilterPath, frame0Filter, "utf-8");
    const frame0Cmd = [
      `ffmpeg`,
      `-i "${bodyOutputPath}"`,
      `-ss ${options.frame0OffsetSec.toFixed(3)} -i "${options.frame0SourcePath ?? clipPath}"`,
      `-filter_complex_script "${frame0FilterPath}"`,
      `-map "[final]:v"`,
      `-map "0:a?"`,
      `-s 1080:1920`,
      `-c:v libx264 -preset fast -crf 18`,
      `-c:a copy`,
      `-shortest`,
      `-y "${outputPath}"`,
    ].join(" ");
    try {
      execSync(frame0Cmd, { stdio: "inherit", timeout: 300000 });
      log.info(`  Frame0 thumbnail hook: "${options.frame0HookText}"`);
    } finally {
      try { unlinkSync(frame0FilterPath); } catch { /* ignore */ }
      try { unlinkSync(bodyOutputPath); } catch { /* ignore */ }
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  log.info(
    `Rendered in ${elapsed.toFixed(1)}s (vs ~120s Remotion, ${(120 / elapsed).toFixed(1)}x faster)`,
  );
}

// ─── Trimmer-based render ────────────────────────────────────────────────────

interface TrimResultEntry {
  rank: number;
  candidateId?: string;
  momentId?: string;
  clipFile: string;
  sourceStartSec?: number;
  sourceEndSec?: number;
  flashStart: number;
  flashDuration: number;
  contentStart: number;
  contentEnd: number;
  contentDuration: number;
  status: string;
}

function promotedTrimEntries(streamDir: string, entries: TrimResultEntry[]): TrimResultEntry[] {
  const promoted = loadValidatedGroundedPromoted<{ candidateId?: string; momentId?: string }>(streamDir);
  return selectPromotedEntries(entries, promoted.map((candidate) => candidate.candidateId!));
}

function enforceApprovedReviewWindows(streamDir: string, entries: TrimResultEntry[], rawClipsDir?: string): void {
  const selectionPath = join(streamDir, "private-abc-selection.json");
  if (!existsSync(selectionPath)) return;
  const durations: Record<string, number> = {};
  if (rawClipsDir) {
    for (const entry of entries) {
      const path = join(rawClipsDir, entry.clipFile);
      if (existsSync(path)) durations[entry.clipFile] = getVideoDuration(path);
    }
  }
  assertApprovedReviewWindows(
    JSON.parse(readFileSync(selectionPath, "utf-8")),
    entries,
    durations,
  );
}

interface TrimLayoutState {
  mode: "gameplay" | "talking";
  avatar: { x: number; y: number; w: number; h: number };
  gameplay: { x: number; y: number; w: number; h: number };
  cropX: number;
}

/**
 * Render all approved clips from trim-results.json using per-clip layout from trim-state.json.
 * For each clip:
 *   1. Extract flash + content segments from the raw clip via stream copy
 *   2. Concat into a temp assembled file
 *   3. Adjust whisper caption timestamps to new timeline
 *   4. Render 9:16 short with per-clip crop regions
 */
async function renderFromTrimmer(
  streamDir: string,
  noCaptions: boolean,
  clipFilter?: number[] | null,
  noMotion: boolean = false,
  noEmojis: boolean = false,
): Promise<void> {
  const trimResultsPath = join(streamDir, "trim-results.json");
  const trimStatePath = join(streamDir, "trim-state.json");

  if (!existsSync(trimResultsPath)) {
    log.error("trim-results.json not found — run the clip trimmer first");
    process.exit(1);
  }

  const trimResults: { approved: TrimResultEntry[]; streamId: string } =
    JSON.parse(readFileSync(trimResultsPath, "utf-8"));
  const streamId = trimResults.streamId;
  const layoutState: Record<string, TrimLayoutState> = {};
  if (existsSync(trimStatePath)) {
    try {
      const trimStateRaw: { layoutState?: Record<string, TrimLayoutState> } =
        JSON.parse(readFileSync(trimStatePath, "utf-8"));
      Object.assign(layoutState, trimStateRaw.layoutState ?? {});
    } catch {
      log.warn("trim-state.json unreadable — using final v8 default layout");
    }
  } else {
    log.warn("trim-state.json missing — using final v8 default layout");
  }

  const rawClipsDir = join(streamDir, "raw-clips");
  enforceApprovedReviewWindows(streamDir, trimResults.approved);
  const whisperDir = join(streamDir, "whisper-captions");
  const shortsDir = join(streamDir, "shorts");
  const tempDir = join(streamDir, "temp");
  ensureDir(shortsDir);
  ensureDir(tempDir);

  // Filter to reviewed clips, optionally further filtered by rank
  const approvedClips = promotedTrimEntries(streamDir, trimResults.approved)
    .filter((c) => c.contentEnd < 9000)
    .filter((c) => !clipFilter || clipFilter.includes(c.rank));
  log.info(`Found ${approvedClips.length} reviewed+approved clips to render`);

  // Load hook texts
  const hookTexts = parseHookTexts(streamDir);
  const frame0Items = loadFrame0MetadataItems(streamDir);
  if (hookTexts.size > 0) {
    log.info(`Loaded ${hookTexts.size} hook texts from upload-metadata.md`);
  }
  log.info(`Loaded ${frame0Items.length} frame0 specs from upload metadata`);

  const summary: Array<{ file: string; duration: number; layout: string }> = [];

  for (const clip of approvedClips) {
    const rank = clip.rank;
    const padded = String(rank).padStart(2, "0");
    // layoutState uses 0-based index = rank - 1
    const layout: TrimLayoutState | undefined = layoutState[String(rank - 1)];

    log.info(`\n--- Clip #${rank}: ${clip.clipFile} ---`);

    const rawClipPath = join(rawClipsDir, clip.clipFile);
    if (!existsSync(rawClipPath)) {
      log.warn(`  Raw clip not found: ${rawClipPath} — skipping`);
      continue;
    }

    // Default layout if trimmer didn't set one
    const sourceDims = getVideoDimensions(rawClipPath);
    const mode: "gameplay" | "talking" = layout?.mode ?? "gameplay";
    const cropX = scaleCropXForSource(layout?.cropX ?? 0, sourceDims.width);
    const avatarDefault = layout?.avatar ?? defaultAvatarRegion(streamId);
    const avatar = scaleRegionForSource(avatarDefault, sourceDims.width, sourceDims.height);
    const gameplay = scaleRegionForSource(layout?.gameplay ?? defaultGameplayRegion(streamId, rank), sourceDims.width, sourceDims.height);
    const frame0Avatar = scaleRegionForSource(defaultFrame0AvatarRegion(streamId, avatarDefault), sourceDims.width, sourceDims.height);

    log.info(`  Layout: ${mode}, flashDur=${clip.flashDuration.toFixed(2)}s, content=${clip.contentStart.toFixed(2)}-${clip.contentEnd.toFixed(2)}s`);

    // Assemble flash + content using the concat filter (not concat demuxer).
    // The concat filter resets PTS to 0 so captions and hook overlay are in sync.
    // Stream-copy concat from different positions causes non-zero start PTS which
    // offsets the subtitle filter and hook enable times.
    const assembledPath = join(tempDir, `${padded}-assembled.mp4`);

    try {
      const assembleCmd = [
        `ffmpeg`,
        `-ss ${clip.flashStart} -t ${clip.flashDuration} -i "${rawClipPath}"`,
        `-ss ${clip.contentStart} -t ${clip.contentDuration} -i "${rawClipPath}"`,
        `-filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]"`,
        `-map "[v]" -map "[a]"`,
        `-c:v libx264 -preset fast -crf 18`,
        `-c:a aac -b:a 192k`,
        `-y "${assembledPath}"`,
      ].join(" ");
      execSync(assembleCmd, { stdio: "inherit" });
    } catch (err) {
      log.error(`  Failed to assemble clip #${rank}: ${(err as Error).message}`);
      continue;
    }

    // Step 3: Adjust whisper captions to new timeline
    let assFilePath: string | null = null;
    // Hoisted so the motion planner downstream can reuse it.
    let remappedWords: WhisperWord[] = [];
    {
      const whisperWords = loadWhisperCaptions(whisperDir, clip.clipFile);
      if (whisperWords && whisperWords.length > 0) {
        const contentStartMs = clip.contentStart * 1000;
        const contentEndMs = clip.contentEnd * 1000;
        const flashDurMs = clip.flashDuration * 1000;

        // Keep only words within the content range, remap to new timeline
        remappedWords = whisperWords
          .filter((w) => w.startMs >= contentStartMs && w.endMs <= contentEndMs + 500)
          .map((w) => ({
            word: w.word,
            startMs: flashDurMs + (w.startMs - contentStartMs),
            endMs: flashDurMs + (w.endMs - contentStartMs),
          }))
          // Don't show captions during flash overlay
          .filter((w) => w.startMs >= flashDurMs);

        if (!noCaptions) {
          if (remappedWords.length > 0) {
            let chunks = generateCaptionChunks(remappedWords);
            if (!noEmojis) chunks = insertEmojis(chunks);
            assFilePath = join(shortsDir, `karaoke-${padded}.ass`);
            writeKaraokeAss(chunks, mode, assFilePath, noEmojis ? "Arial" : CAPTION_EMOJI_FONT);
            log.info(`  Captions: ${remappedWords.length} words → ${chunks.length} chunks${noEmojis ? "" : " (emoji pass)"}`);
          } else {
            log.warn(`  No caption words in content range for clip #${rank}`);
          }
        }
      } else if (!noCaptions) {
        log.warn(`  No whisper captions found for ${clip.clipFile}`);
      }
    }

    // Step 4: Render 9:16 short
    const shortPath = join(shortsDir, clip.clipFile);
    const hookText = hookTexts.get(rank);
    if (hookText) {
      log.info(`  Hook: "${hookText}"`);
    }

    const assembledDuration = getVideoDuration(assembledPath);
    const frame0SourceDuration = getVideoDuration(rawClipPath);
    const frame0Spec = getFrame0Spec(frame0Items, rank, frame0SourceDuration);
    const frame0HookText = frame0Spec.hookText;
    log.info(`  Frame0 hook: "${frame0HookText}"`);
    log.info(`  Assembled clip duration: ${assembledDuration.toFixed(2)}s`);

    const motionPlan = noMotion
      ? null
      : planMotion(remappedWords ?? null, clip.flashDuration, assembledDuration, mode);
    if (motionPlan && (motionPlan.events.length > 0 || motionPlan.kenBurnsRange > 0)) {
      log.info(
        `  Motion: ${motionPlan.events.length} punch(es), kenBurns=${motionPlan.kenBurnsRange}`,
      );
    }

    renderClipFfmpeg(assembledPath, mode, shortPath, {
      avatarX: avatar.x,
      avatarY: avatar.y,
      avatarW: avatar.w,
      avatarH: avatar.h,
      gameplayX: gameplay.x,
      gameplayY: gameplay.y,
      gameplayW: gameplay.w,
      gameplayH: gameplay.h,
      cropX,
      flashDuration: clip.flashDuration,
      assPath: assFilePath,
      duration: assembledDuration,
      hookText,
      frame0HookText,
      frame0OffsetSec: frame0Spec.offsetSec,
      frame0SourcePath: rawClipPath,
      frame0SourceDuration,
      frame0Avatar,
      motionPlan,
    });

    // Cleanup assembled temp file
    try { if (existsSync(assembledPath)) unlinkSync(assembledPath); } catch { /* ignore */ }

    summary.push({ file: clip.clipFile, duration: assembledDuration, layout: mode });
    log.info(`  Done: shorts/${clip.clipFile}`);
  }

  log.info("\n=== Summary ===");
  for (const item of summary) {
    log.info(`${item.file} (${item.duration.toFixed(1)}s, ${item.layout})`);
  }
  log.info(`\nRendered ${summary.length} clips`);
}

// ─── Direct render (raw clips already assembled by trimmer finalize) ──────────

/**
 * Render raw clips directly as 9:16 shorts.
 * Raw clips are already assembled (flash+content) by the trimmer's finalize handler.
 * We stripped 2s off the front, so remaining flash = max(0, originalFlash - 2).
 * Captions from whisper are clip-relative (0 = start of current clip).
 * They are filtered to only show after remainingFlash seconds.
 */
async function renderDirect(
  streamDir: string,
  noCaptions: boolean,
  clipFilter?: number[] | null,
  noMotion: boolean = false,
  noEmojis: boolean = false,
): Promise<void> {
  const trimResultsPath = join(streamDir, "trim-results.json");
  if (!existsSync(trimResultsPath)) {
    log.error("trim-results.json not found — run the clip trimmer first");
    process.exit(1);
  }

  const trimResults: { approved: TrimResultEntry[]; streamId?: string } =
    JSON.parse(readFileSync(trimResultsPath, "utf-8"));
  const streamId = trimResults.streamId;

  // Load layout state if available (may be partial — defaults fill in gaps)
  const trimStatePath = join(streamDir, "trim-state.json");
  const layoutState: Record<string, TrimLayoutState> = {};
  if (existsSync(trimStatePath)) {
    try {
      const s = JSON.parse(readFileSync(trimStatePath, "utf-8"));
      Object.assign(layoutState, s.layoutState ?? {});
    } catch {}
  }

  const rawClipsDir = join(streamDir, "raw-clips");
  enforceApprovedReviewWindows(streamDir, trimResults.approved, rawClipsDir);
  const whisperDir = join(streamDir, "whisper-captions");
  const shortsDir = join(streamDir, "shorts");
  ensureDir(shortsDir);

  // Real clips only (contentEnd < 9000), rank <= 24, optionally filtered by rank
  const clipsToRender = promotedTrimEntries(streamDir, trimResults.approved)
    .filter((c) => c.contentEnd < 9000 && c.rank <= 24)
    .filter((c) => !clipFilter || clipFilter.includes(c.rank));

  log.info(`Rendering ${clipsToRender.length} clips directly from raw-clips/`);

  const hookTexts = parseHookTexts(streamDir);
  const frame0Items = loadFrame0MetadataItems(streamDir);
  log.info(`Loaded ${frame0Items.length} frame0 specs from upload metadata`);

  const summary: Array<{ file: string; duration: number; layout: string }> = [];

  for (const clip of clipsToRender) {
    const rank = clip.rank;
    const padded = String(rank).padStart(2, "0");
    log.info(`\n--- Clip #${rank}: ${clip.clipFile} ---`);

    const rawClipPath = join(rawClipsDir, clip.clipFile);
    if (!existsSync(rawClipPath)) {
      log.warn(`  Raw clip not found — skipping`);
      continue;
    }

    // The trimmer's finalize assembled [flashDuration + content] then we stripped 2s.
    // Remaining flash = how many seconds of the flash are still at the front of the clip.
    const STRIP_OFFSET = 2;
    const remainingFlash = Math.max(0, clip.flashDuration - STRIP_OFFSET);
    log.info(`  Original flash: ${clip.flashDuration.toFixed(2)}s → remaining after strip: ${remainingFlash.toFixed(2)}s`);

    // Layout: per-clip from trim-state, otherwise channel defaults.
    // Region defaults are authored for 1080p source frames; scale to actual
    // raw clip dimensions (720p downloads otherwise crash ffmpeg crop).
    const layout: TrimLayoutState | undefined = layoutState[String(rank - 1)];
    const sourceDims = getVideoDimensions(rawClipPath);
    const mode: "gameplay" | "talking" = layout?.mode ?? "gameplay";
    const cropX = scaleCropXForSource(layout?.cropX ?? 0, sourceDims.width);
    const avatarDefault = layout?.avatar ?? defaultAvatarRegion(streamId);
    const avatar = scaleRegionForSource(avatarDefault, sourceDims.width, sourceDims.height);
    const gameplay = scaleRegionForSource(layout?.gameplay ?? defaultGameplayRegion(streamId, rank), sourceDims.width, sourceDims.height);
    const frame0Avatar = scaleRegionForSource(defaultFrame0AvatarRegion(streamId, avatarDefault), sourceDims.width, sourceDims.height);
    log.info(`  Layout: ${mode} (${sourceDims.width}x${sourceDims.height} source)`);

    // Captions start after the frame0/hook beat. The legacy body hook banner is
    // disabled by default; don't re-enable it for v8 style renders.
    const HOOK_SECS = 2;

    let assFilePath: string | null = null;
    let contentWords: WhisperWord[] = [];
    {
      const whisperWords = loadWhisperCaptions(whisperDir, clip.clipFile);
      if (whisperWords && whisperWords.length > 0) {
        const flashMs = HOOK_SECS * 1000;
        contentWords = whisperWords.filter((w) => w.startMs >= flashMs);
        if (!noCaptions) {
          if (contentWords.length > 0) {
            let chunks = generateCaptionChunks(contentWords);
            if (!noEmojis) chunks = insertEmojis(chunks);
            assFilePath = join(shortsDir, `karaoke-${padded}.ass`);
            writeKaraokeAss(chunks, mode, assFilePath, noEmojis ? "Arial" : CAPTION_EMOJI_FONT);
            log.info(`  Captions: ${contentWords.length} words → ${chunks.length} chunks${noEmojis ? "" : " (emoji pass)"}`);
          } else {
            log.warn(`  No caption words after flash portion for clip #${rank}`);
          }
        }
      } else if (!noCaptions) {
        log.warn(`  No whisper captions for clip #${rank}`);
      }
    }

    // Render 9:16 short directly from the raw clip
    const clipDuration = getVideoDuration(rawClipPath);
    const shortPath = join(shortsDir, clip.clipFile);
    const hookText = hookTexts.get(rank);
    const frame0Spec = getFrame0Spec(frame0Items, rank, clipDuration);
    const frame0HookText = frame0Spec.hookText;
    if (hookText) log.info(`  Hook: "${hookText}"`);
    if (frame0HookText) log.info(`  Frame0 hook: "${frame0HookText}"`);

    const motionPlan = noMotion
      ? null
      : planMotion(contentWords, HOOK_SECS, clipDuration, mode);
    if (motionPlan && (motionPlan.events.length > 0 || motionPlan.kenBurnsRange > 0)) {
      log.info(
        `  Motion: ${motionPlan.events.length} punch(es), kenBurns=${motionPlan.kenBurnsRange}`,
      );
    }

    renderClipFfmpeg(rawClipPath, mode, shortPath, {
      avatarX: avatar.x,
      avatarY: avatar.y,
      avatarW: avatar.w,
      avatarH: avatar.h,
      gameplayX: gameplay.x,
      gameplayY: gameplay.y,
      gameplayW: gameplay.w,
      gameplayH: gameplay.h,
      cropX,
      flashDuration: HOOK_SECS,
      assPath: assFilePath,
      duration: clipDuration,
      hookText,
      frame0HookText,
      frame0OffsetSec: frame0Spec.offsetSec,
      frame0Avatar,
      motionPlan,
    });

    summary.push({ file: clip.clipFile, duration: clipDuration, layout: mode });
    log.info(`  Done: shorts/${clip.clipFile}`);
  }

  log.info("\n=== Summary ===");
  for (const item of summary) {
    log.info(`  ${item.file} (${item.duration.toFixed(1)}s, ${item.layout})`);
  }
  log.info(`\nRendered ${summary.length} clips to shorts/`);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse CLI arguments.
 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const streamId = args.stream as string | undefined;
  const clipsArg = args.clips as string | undefined;
  const all = !!args.all;
  const noCaptions = !!args["no-captions"];
  const noMotion = !!args["no-motion"];
  const noEmojis = !!args["no-emojis"];
  const srtPath = args.srt as string | undefined;
  const layoutOverride = args.layout as LayoutMode | undefined;
  if (layoutOverride && layoutOverride !== "gameplay" && layoutOverride !== "talking") {
    throw new Error(`Invalid --layout value: ${layoutOverride}. Use 'gameplay' or 'talking'.`);
  }
  const fromTrimmer = !!args["from-trimmer"];
  const direct = !!args["direct"];

  if (!streamId) {
    log.error("--stream <id> is required");
    process.exit(1);
  }
  assertStreamStyleCalibrated(streamId);

  // --direct: render raw clips as-is (already assembled by trimmer finalize)
  if (direct) {
    const streamDir = getStreamDir(streamId);
    const clipFilter = clipsArg
      ? (clipsArg as string).split(",").map((s) => parseInt(s.trim(), 10))
      : null;
    await renderDirect(streamDir, noCaptions, clipFilter, noMotion, noEmojis);
    markRendered(streamId);
    return;
  }

  // --from-trimmer: render all approved clips using trim-results.json + trim-state.json
  if (fromTrimmer) {
    const streamDir = getStreamDir(streamId);
    const clipFilter = clipsArg
      ? (clipsArg as string).split(",").map((s) => parseInt(s.trim(), 10))
      : null;
    await renderFromTrimmer(streamDir, noCaptions, clipFilter, noMotion, noEmojis);
    markRendered(streamId);
    return;
  }

  if (!clipsArg && !all) {
    log.error("Provide --clips 1,2,3 or --all");
    process.exit(1);
  }

  const manifest = loadManifest(streamId);
  const streamDir = getStreamDir(streamId);

  // Probe source video dimensions to clamp regions
  let sourceW = 1920;
  let sourceH = 1080;
  try {
    const probe = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${manifest.videoPath}"`,
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(probe);
    sourceW = parsed.streams?.[0]?.width ?? 1920;
    sourceH = parsed.streams?.[0]?.height ?? 1080;
  } catch {
    /* fallback to defaults */
  }

  // Load moments: prefer unified-moments.json, fall back to moments.json
  const unifiedPath = join(streamDir, "unified-moments.json");
  const momentsPath = join(streamDir, "moments.json");

  interface UnifiedEntry {
    startSec: number;
    endSec: number;
    durationSec: number;
    description: string;
    viralityScore: number;
    hookText?: string;
    layoutMode?: LayoutMode;
    segments?: Array<{ startSec: number; durationSec: number; label?: string }>;
    multiSegment?: boolean;
    buildUpStartSec?: number;
    buildUpDurationSec?: number;
    automatedSignals?: Record<string, unknown>;
  }

  let moments: Moment[];
  let unifiedEntries: UnifiedEntry[] | null = null;

  if (existsSync(unifiedPath)) {
    log.info("Loading unified-moments.json");
    unifiedEntries = JSON.parse(readFileSync(unifiedPath, "utf-8"));
    moments = unifiedEntries!.map((u, i) => {
      // Resolve segments
      let segments: Array<{ startSec: number; durationSec: number; label?: string }> | undefined;
      if (u.segments && u.segments.length > 0) {
        segments = u.segments;
      } else if (u.multiSegment && u.buildUpStartSec != null) {
        segments = [
          { startSec: u.buildUpStartSec, durationSec: u.buildUpDurationSec ?? 10, label: "build-up" },
          { startSec: u.startSec, durationSec: u.durationSec, label: "payoff" },
        ];
      }

      return {
        id: `unified-${String(i + 1).padStart(3, "0")}`,
        centerTimeSec: (u.startSec + u.endSec) / 2,
        signalOverlap: 0,
        transcriptSignals: [],
        chatSignals: [],
        audioSignals: [],
        scores: {
          overlapScore: 0,
          chatIntensity: u.automatedSignals?.chatIntensity as number ?? 0,
          audioMagnitude: u.automatedSignals?.audioMagnitude as number ?? 0,
          viralityScore: u.viralityScore / 10,
          durationSuitability: 1,
          composite: u.viralityScore / 10,
        },
        suggestedStartSec: u.startSec,
        suggestedEndSec: u.endSec,
        suggestedDurationSec: u.durationSec,
        description: u.description,
        ...(segments ? { segments } : {}),
      } as Moment;
    });
  } else if (existsSync(momentsPath)) {
    moments = JSON.parse(readFileSync(momentsPath, "utf-8"));
  } else {
    log.error(`No unified-moments.json or moments.json found`);
    process.exit(1);
  }

  let selectedIndices: number[];
  if (all) {
    selectedIndices = moments.map((_, i) => i);
  } else {
    selectedIndices = (clipsArg as string)
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < moments.length);
  }

  if (selectedIndices.length === 0) {
    log.error("No valid clips selected");
    process.exit(1);
  }

  // Load channel config (avatar/gameplay regions). Empty/missing config uses
  // the final v8 Daily Peanut defaults above.
  const config = loadChannelConfig();
  const avatarRegion = normalizeAvatarRegion(config?.avatarRegion);
  const rawGameplayRegion = normalizeGameplayRegion(config?.gameplayRegion);
  // Clamp gameplay region to actual source dimensions to prevent ffmpeg crop errors
  // when channel config has larger regions than the source resolution (e.g. 1520x1440 on 1280x720)
  const gameplayRegion = {
    x: Math.max(0, Math.min(rawGameplayRegion.x, sourceW - 10)),
    y: Math.max(0, Math.min(rawGameplayRegion.y, sourceH - 10)),
    w: Math.max(10, Math.min(rawGameplayRegion.w, sourceW - rawGameplayRegion.x)),
    h: Math.max(10, Math.min(rawGameplayRegion.h, sourceH - rawGameplayRegion.y)),
  };

  // Load subtitles if available
  let allWords: ReturnType<typeof vttToWordTimestamps> | null = null;
  if (!noCaptions && manifest.subtitlePath) {
    const subtitleFullPath = manifest.subtitlePath;
    if (existsSync(subtitleFullPath)) {
      const cues = parseVtt(subtitleFullPath);
      allWords = vttToWordTimestamps(cues);
      log.info(`Loaded ${allWords.length} caption words`);
    }
  }

  const rawClipsDir = join(streamDir, "raw-clips");
  const shortsDir = join(streamDir, "shorts");
  ensureDir(shortsDir);

  const tempDir = join(streamDir, "temp");
  ensureDir(tempDir);

  // Load precise-clips manifest for actual content start times
  const manifestPath = join(streamDir, "precise-clips-manifest.json");
  const clipManifest: Array<{ rank: number; contentStart: number; contentDur: number }> =
    existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];

  // Parse upload-metadata.md/json for hook texts
  const hookTexts = parseHookTexts(streamDir);
  const frame0Items = loadFrame0MetadataItems(streamDir);
  if (hookTexts.size > 0) {
    log.info(`Loaded ${hookTexts.size} hook texts from upload-metadata.md`);
  }
  log.info(`Loaded ${frame0Items.length} frame0 specs from upload metadata`);

  const summary: Array<{
    file: string;
    duration: number;
    layout: LayoutMode;
  }> = [];

  for (const idx of selectedIndices) {
    const moment = moments[idx];
    const rank = idx + 1;
    const padded = String(rank).padStart(2, "0");

    log.info(`\n--- Clip #${rank}: ${moment.description.slice(0, 60)} ---`);
    log.info(
      `  Time: ${moment.suggestedStartSec.toFixed(1)}s - ${moment.suggestedEndSec.toFixed(1)}s (${moment.suggestedDurationSec.toFixed(1)}s)`,
    );

    // Find raw clip file (NN-description.mp4 in raw-clips/)
    // Expected duration = content duration + 2s flash segment
    const expectedDur = moment.suggestedDurationSec + 2;
    const clipPath = findRawClip(rawClipsDir, rank, expectedDur);
    if (!clipPath) {
      log.warn(`  Clip not found in raw-clips/ for rank ${rank}. Run clip extraction first.`);
      continue;
    }
    const clipBasename = clipPath.split(/[/\\]/).pop()!;

    // Detect or override layout mode
    let layoutMode: LayoutMode;
    const jsonLayout = unifiedEntries?.[idx]?.layoutMode as LayoutMode | undefined;
    if (layoutOverride) {
      layoutMode = layoutOverride;
      log.info(`  Layout mode: ${layoutMode} (CLI overridden)`);
    } else if (jsonLayout) {
      layoutMode = jsonLayout;
      log.info(`  Layout mode: ${layoutMode} (from unified-moments.json)`);
    } else {
      layoutMode = detectLayoutMode(clipPath, gameplayRegion, tempDir, avatarRegion);
      log.info(`  Layout mode: ${layoutMode} (auto-detected)`);
    }

    // Prepare ASS karaoke captions. `whisperContentWords` is hoisted so the
    // motion planner downstream can reuse the finalized-timeline whisper words.
    let assFilePath: string | null = null;
    let whisperContentWords: WhisperWord[] = [];
    if (!noCaptions) {
      if (srtPath) {
        assFilePath = srtPath;
        log.info(`  Captions: using provided file: ${srtPath}`);
      } else {
        let captionChunks: ReturnType<typeof generateCaptionChunks> = [];

        // Priority 1: Whisper-based captions (accurate clip-relative timing)
        const whisperDir = join(streamDir, "whisper-captions");
        const whisperWords = loadWhisperCaptions(whisperDir, clipBasename);
        if (whisperWords) {
          // Whisper timestamps are clip-relative (0 = start of raw clip).
          // Skip words in the first 2 seconds (flash segment) — only caption the content.
          whisperContentWords = whisperWords.filter((w) => w.startMs >= 2000);
          if (whisperContentWords.length > 0) {
            captionChunks = generateCaptionChunks(whisperContentWords);
            log.info(`  Captions: Whisper (${whisperContentWords.length} words, skipping ${whisperWords.length - whisperContentWords.length} flash words)`);
          }
        } else if (allWords) {
          // Priority 2: VTT-based captions with stream-relative timestamps
          const segments = (moment as any).segments as Array<{ startSec: number; durationSec: number; label?: string }> | undefined;

          if (segments && segments.length > 1) {
            let offsetMs = 0;
            for (const seg of segments) {
              const segWords = filterByTimeRange(allWords, seg.startSec, seg.startSec + seg.durationSec);
              if (segWords.length > 0) {
                const remapped = segWords.map((w) => ({
                  ...w,
                  startMs: w.startMs + offsetMs,
                  endMs: w.endMs + offsetMs,
                }));
                captionChunks = captionChunks.concat(generateCaptionChunks(remapped));
              }
              offsetMs += seg.durationSec * 1000;
            }
          } else {
            const manifestEntry = clipManifest.find((e) => e.rank === rank);
            const captionStart = manifestEntry ? manifestEntry.contentStart : moment.suggestedStartSec;
            const captionEnd = manifestEntry
              ? manifestEntry.contentStart + manifestEntry.contentDur
              : moment.suggestedEndSec;
            const captionWords = filterByTimeRange(allWords, captionStart, captionEnd);
            const shifted = captionWords.map((w) => ({
              ...w,
              startMs: w.startMs + 2000,
              endMs: w.endMs + 2000,
            }));
            if (shifted.length > 0) {
              captionChunks = generateCaptionChunks(shifted);
            }
          }
          if (captionChunks.length > 0) {
            log.info(`  Captions: VTT fallback (${captionChunks.length} chunks)`);
          }
        }

        if (captionChunks.length > 0) {
          if (!noEmojis) captionChunks = insertEmojis(captionChunks);
          assFilePath = join(shortsDir, `karaoke-${padded}.ass`);
          writeKaraokeAss(captionChunks, layoutMode, assFilePath, noEmojis ? "Arial" : CAPTION_EMOJI_FONT);
          log.info(`  Karaoke ASS: generated ${captionChunks.length} chunks${noEmojis ? "" : " (emoji pass)"}`);
        } else {
          log.warn(`  No caption words found for clip #${rank}`);
        }
      }
    }

    // Get clip duration for ffmpeg
    const clipDuration = getVideoDuration(clipPath);

    // Get hook text: CLI override > upload-metadata > unified-moments.json > none
    const unifiedHook = unifiedEntries?.[idx]?.hookText;
    const hookText = (args["hook-text"] as string) || hookTexts.get(rank) || unifiedHook || undefined;
    const frame0Spec = getFrame0Spec(frame0Items, rank, clipDuration);
    const frame0HookText = frame0Spec.hookText;
    if (hookText) {
      log.info(`  Hook: "${hookText}"`);
    } else {
      log.warn(`  No hook text for clip #${rank}`);
    }
    if (frame0HookText) {
      log.info(`  Frame0 hook: "${frame0HookText}"`);
    }

    // Render via ffmpeg — output uses same basename as raw clip
    const shortPath = join(shortsDir, clipBasename);

    const motionPlan = noMotion
      ? null
      : planMotion(whisperContentWords, 2, clipDuration, layoutMode);
    if (motionPlan && (motionPlan.events.length > 0 || motionPlan.kenBurnsRange > 0)) {
      log.info(
        `  Motion: ${motionPlan.events.length} punch(es), kenBurns=${motionPlan.kenBurnsRange}`,
      );
    }

    log.info(`  Rendering: ${clipBasename}`);
    renderClipFfmpeg(clipPath, layoutMode, shortPath, {
      avatarX: avatarRegion.x,
      avatarY: avatarRegion.y,
      avatarW: avatarRegion.w,
      avatarH: avatarRegion.h,
      gameplayX: gameplayRegion.x,
      gameplayY: gameplayRegion.y,
      gameplayW: gameplayRegion.w,
      gameplayH: gameplayRegion.h,
      assPath: assFilePath,
      duration: clipDuration,
      hookText,
      frame0HookText,
      frame0OffsetSec: frame0Spec.offsetSec,
      motionPlan,
    });

    summary.push({
      file: clipBasename,
      duration: moment.suggestedDurationSec,
      layout: layoutMode,
    });
    log.info(`  Done: shorts/${clipBasename}`);
  }

  log.info("\n=== Summary ===");
  for (const item of summary) {
    log.info(
      `${item.file} (${item.duration.toFixed(1)}s, ${item.layout})`,
    );
  }
  markRendered(streamId);
}

main().catch((err) => {
  log.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
