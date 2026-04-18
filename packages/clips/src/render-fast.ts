import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync } from "fs";
import { join } from "path";
import { createLogger, ensureDir } from "@ltx/shared";
import { getStreamDir, loadManifest } from "./lib/manifest.js";
import {
  parseVtt,
  vttToWordTimestamps,
  filterByTimeRange,
} from "./lib/subtitle-parser.js";
import { loadWhisperCaptions, type WhisperWord } from "./lib/whisper-captions.js";
import { detectLayoutMode } from "./lib/layout.js";
import { loadChannelConfig } from "./lib/config.js";
import type { Moment } from "./lib/scorer.js";
import type { LayoutMode } from "./lib/layout.js";
import { planMotion, buildZoompanFilter, type MotionPlan } from "./lib/motion.js";
import { insertEmojis, CAPTION_EMOJI_FONT } from "./lib/caption-emoji.js";

const log = createLogger("render-fast");

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
 * Group caption words into 3-4 word chunks.
 * Skip first 2 seconds (reserved for hook overlay).
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
    const chunkSize = 3 + Math.floor(Math.random() * 2); // 3-4 words
    const chunk = words.slice(i, i + chunkSize);

    chunks.push({
      startMs: chunk[0].startMs,
      endMs: chunk[chunk.length - 1].endMs,
      words: chunk.map((w) => ({
        word: w.word.toUpperCase(),
        startMs: w.startMs,
        endMs: w.endMs,
      })),
    });

    i += chunkSize;
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
 * Build hook overlay drawtext filters for the flash duration.
 * White banner + yellow neon glow text per CLAUDE.md approved style.
 * flashDur: how long the hook overlay shows (seconds) — matches the flash segment length.
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
): string {
  const gx = gameplayX ?? 320;
  const gy = gameplayY ?? 0;
  const gw = gameplayW ?? 1920;
  const gh = gameplayH ?? 1080;
  let filterChain =
    `[0:v]split[v1][v2];` +
    `[v1]crop=${avatarW}:${avatarH}:${avatarX}:${avatarY},scale=-2:768,crop=1080:768[avatar];` +
    `[v2]crop=${gw}:${gh}:${gx}:${gy},scale=-2:1152,crop=1080:1152[gameplay];` +
    `[avatar][gameplay]vstack[stacked];` +
    `[stacked]drawbox=y=766:w=1080:h=4:color=white@0.15:t=fill`;

  if (motionFilter) {
    // Close the composite chain then run zoompan before the hook overlay so
    // the hook banner text stays pinned to absolute pixel coords.
    filterChain += `[composite];[composite]${motionFilter}`;
  }

  if (hookText) {
    filterChain += `,${buildHookFilters(hookText, 840, flashDur ?? 2)}[final]`;
  } else {
    filterChain += `[final]`;
  }

  return filterChain;
}

/**
 * Build filter_complex for talking mode.
 * Clean 9:16 crop centered on avatar, scaled to 1080x1920. No blur frame.
 */
function buildTalkingFilterComplex(
  hookText?: string,
  cropX?: number,
  flashDur?: number,
  motionFilter?: string | null,
): string {
  // 9:16 crop from source: width = height * 9/16.  Full height (ih), width auto.
  const cx = cropX ?? 0;
  let filterChain =
    `[0:v]crop=ih*9/16:ih:${cx}:0,scale=1080:1920`;

  if (motionFilter) {
    filterChain += `[scaled];[scaled]${motionFilter}`;
  }

  if (hookText) {
    filterChain += `,${buildHookFilters(hookText, 1700, flashDur ?? 2)}[final]`;
  } else {
    filterChain += `[final]`;
  }

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
    motionPlan?: MotionPlan | null;
  },
): void {
  const startTime = Date.now();
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
        )
      : buildTalkingFilterComplex(options.hookText, options.cropX, flashDur, motionFilter);

  const cmd = [
    `ffmpeg`,
    `-i "${clipPath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[final]:v"`,
    `-map "0:a"`,
    `-af "loudnorm=I=-16:TP=-1.5:LRA=11"`,
    `-s 1080:1920`,
    `-c:v libx264 -preset fast -crf 18`,
    `-c:a aac -b:a 192k`,
    `-y "${outputPath}"`,
  ].join(" ");

  execSync(cmd, { stdio: "inherit", timeout: 300000 });

  // Pass 2: Burn in ASS karaoke subtitles
  if (options.assPath && existsSync(options.assPath)) {
    const assEscaped = escapePath(options.assPath);
    const tmpPath = outputPath + ".tmp.mp4";
    try {
      // Rename to temp, then apply subtitles
      renameSync(outputPath, tmpPath);
      const subCmd = `ffmpeg -i "${tmpPath}" -vf "subtitles='${assEscaped}'" -c:a copy -c:v libx264 -preset fast -crf 18 -y "${outputPath}"`;
      execSync(subCmd, { stdio: "inherit", timeout: 300000 });
      unlinkSync(tmpPath);
    } catch (err) {
      log.warn("Subtitle pass failed, keeping version without captions");
      if (existsSync(tmpPath)) {
        try { unlinkSync(outputPath); } catch { /* ignore */ }
        renameSync(tmpPath, outputPath);
      }
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
  clipFile: string;
  flashStart: number;
  flashDuration: number;
  contentStart: number;
  contentEnd: number;
  contentDuration: number;
  status: string;
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
  if (!existsSync(trimStatePath)) {
    log.error("trim-state.json not found — run the clip trimmer first");
    process.exit(1);
  }

  const trimResults: { approved: TrimResultEntry[]; streamId: string } =
    JSON.parse(readFileSync(trimResultsPath, "utf-8"));
  const trimStateRaw: { layoutState: Record<string, TrimLayoutState> } =
    JSON.parse(readFileSync(trimStatePath, "utf-8"));

  const layoutState = trimStateRaw.layoutState;

  const rawClipsDir = join(streamDir, "raw-clips");
  const whisperDir = join(streamDir, "whisper-captions");
  const shortsDir = join(streamDir, "shorts");
  const tempDir = join(streamDir, "temp");
  ensureDir(shortsDir);
  ensureDir(tempDir);

  // Filter to reviewed clips, optionally further filtered by rank
  const approvedClips = trimResults.approved
    .filter((c) => c.contentEnd < 9000)
    .filter((c) => !clipFilter || clipFilter.includes(c.rank));
  log.info(`Found ${approvedClips.length} reviewed+approved clips to render`);

  // Load hook texts
  const hookTexts = parseHookTexts(streamDir);
  if (hookTexts.size > 0) {
    log.info(`Loaded ${hookTexts.size} hook texts from upload-metadata.md`);
  }

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
    const mode: "gameplay" | "talking" = layout?.mode ?? "gameplay";
    const cropX = layout?.cropX ?? 0;
    const avatar = layout?.avatar ?? { x: 100, y: 720, w: 560, h: 360 };
    const gameplay = layout?.gameplay ?? { x: 200, y: 0, w: 1520, h: 1080 };

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

  const trimResults: { approved: TrimResultEntry[] } =
    JSON.parse(readFileSync(trimResultsPath, "utf-8"));

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
  const whisperDir = join(streamDir, "whisper-captions");
  const shortsDir = join(streamDir, "shorts");
  ensureDir(shortsDir);

  // Real clips only (contentEnd < 9000), rank <= 24, optionally filtered by rank
  const clipsToRender = trimResults.approved
    .filter((c) => c.contentEnd < 9000 && c.rank <= 24)
    .filter((c) => !clipFilter || clipFilter.includes(c.rank));

  log.info(`Rendering ${clipsToRender.length} clips directly from raw-clips/`);

  const hookTexts = parseHookTexts(streamDir);

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

    // Layout: per-clip from trim-state, otherwise channel defaults
    const layout: TrimLayoutState | undefined = layoutState[String(rank - 1)];
    const mode: "gameplay" | "talking" = layout?.mode ?? "gameplay";
    const cropX = layout?.cropX ?? 0;
    const avatar = layout?.avatar ?? { x: 100, y: 720, w: 560, h: 360 };
    const gameplay = layout?.gameplay ?? { x: 200, y: 0, w: 1520, h: 1080 };
    log.info(`  Layout: ${mode}`);

    // Hook overlay always shows for exactly 2 seconds regardless of remaining flash.
    // Captions start at 2s so they don't overlap the hook banner.
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
    if (hookText) log.info(`  Hook: "${hookText}"`);

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
  const fromTrimmer = !!args["from-trimmer"];
  const direct = !!args["direct"];

  if (!streamId) {
    log.error("--stream <id> is required");
    process.exit(1);
  }

  // --direct: render raw clips as-is (already assembled by trimmer finalize)
  if (direct) {
    const streamDir = getStreamDir(streamId);
    const clipFilter = clipsArg
      ? (clipsArg as string).split(",").map((s) => parseInt(s.trim(), 10))
      : null;
    await renderDirect(streamDir, noCaptions, clipFilter, noMotion, noEmojis);
    return;
  }

  // --from-trimmer: render all approved clips using trim-results.json + trim-state.json
  if (fromTrimmer) {
    const streamDir = getStreamDir(streamId);
    const clipFilter = clipsArg
      ? (clipsArg as string).split(",").map((s) => parseInt(s.trim(), 10))
      : null;
    await renderFromTrimmer(streamDir, noCaptions, clipFilter, noMotion, noEmojis);
    return;
  }

  if (!clipsArg && !all) {
    log.error("Provide --clips 1,2,3 or --all");
    process.exit(1);
  }

  const manifest = loadManifest(streamId);
  const streamDir = getStreamDir(streamId);

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

  // Load channel config (avatar/gameplay regions)
  const config = loadChannelConfig();
  const avatarRegion = config?.avatarRegion || {
    x: 24,
    y: 24,
    w: 380,
    h: 380,
  };
  const gameplayRegion = config?.gameplayRegion || {
    x: 0,
    y: 0,
    w: 1920,
    h: 1080,
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

  // Parse upload-metadata.md for hook texts
  const hookTexts = parseHookTexts(streamDir);
  if (hookTexts.size > 0) {
    log.info(`Loaded ${hookTexts.size} hook texts from upload-metadata.md`);
  }

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
    if (hookText) {
      log.info(`  Hook: "${hookText}"`);
    } else {
      log.warn(`  No hook text for clip #${rank}`);
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
}

main().catch((err) => {
  log.error("Fatal error:", err);
  process.exit(1);
});
