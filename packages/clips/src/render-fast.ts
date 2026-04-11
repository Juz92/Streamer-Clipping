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
import { detectLayoutMode } from "./lib/layout.js";
import { loadChannelConfig } from "./lib/config.js";
import type { Moment } from "./lib/scorer.js";
import type { LayoutMode } from "./lib/layout.js";

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
  words: ReturnType<typeof filterByTimeRange>,
): Array<{
  startMs: number;
  endMs: number;
  words: Array<{ word: string; startMs: number; endMs: number }>;
}> {
  const skipMs = 2000;
  const filtered = words.filter((w) => w.startMs >= skipMs);

  if (filtered.length === 0) return [];

  const chunks: Array<{
    startMs: number;
    endMs: number;
    words: Array<{ word: string; startMs: number; endMs: number }>;
  }> = [];
  let i = 0;

  while (i < filtered.length) {
    const chunkSize = 3 + Math.floor(Math.random() * 2); // 3-4 words
    const chunk = filtered.slice(i, i + chunkSize);

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
    `Style: Default,Arial,36,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,${alignment},20,20,${marginV},1`,
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
 * Matches files like "01-description.mp4", "02-slug.mp4".
 */
function findRawClip(rawClipsDir: string, rank: number): string | null {
  if (!existsSync(rawClipsDir)) return null;
  const prefix = String(rank).padStart(2, "0") + "-";
  const files = readdirSync(rawClipsDir);
  const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".mp4"));
  return match ? join(rawClipsDir, match) : null;
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
 * Build hook overlay drawtext filters for the first 2 seconds.
 * White banner + yellow neon glow text per CLAUDE.md approved style.
 */
function buildHookFilters(hookText: string, bannerY: number = 840): string {
  const [line1, line2] = splitHookText(hookText);

  const filters: string[] = [];

  if (line2) {
    const bannerH = 160;
    const line1Y = bannerY + 15;
    const line2Y = bannerY + 75;

    filters.push(
      `drawbox=y=${bannerY}:w=1080:h=${bannerH}:color=white@0.85:t=fill:enable='lt(t,2)'`,
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(line1)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=54:fontcolor=yellow:borderw=5:shadowcolor=0xFF6600@0.7:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${line1Y}:enable='lt(t,2)'`,
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(line2)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=70:fontcolor=yellow:borderw=6:shadowcolor=0xFF6600@0.8:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${line2Y}:enable='lt(t,2)'`,
    );
  } else {
    const bannerH = 100;
    const textY = bannerY + 15;

    filters.push(
      `drawbox=y=${bannerY}:w=1080:h=${bannerH}:color=white@0.85:t=fill:enable='lt(t,2)'`,
    );
    filters.push(
      `drawtext=text='${escapeDrawtext(line1)}':fontfile='C\\:/Windows/Fonts/impact.ttf':fontsize=70:fontcolor=yellow:borderw=6:shadowcolor=0xFF6600@0.8:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${textY}:enable='lt(t,2)'`,
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
): string {
  const gx = gameplayX ?? 320;
  const gy = gameplayY ?? 0;
  const gw = gameplayW ?? 1920;
  const gh = gameplayH ?? 1080;
  let filterChain =
    `[0:v]split[v1][v2];` +
    `[v1]crop=${avatarW}:${avatarH}:${avatarX}:${avatarY},scale=1080:768[avatar];` +
    `[v2]crop=${gw}:${gh}:${gx}:${gy},scale=1080:1152[gameplay];` +
    `[avatar][gameplay]vstack[stacked];` +
    `[stacked]drawbox=y=766:w=1080:h=4:color=white@0.15:t=fill`;

  if (hookText) {
    filterChain += `,${buildHookFilters(hookText)}[final]`;
  } else {
    filterChain += `[final]`;
  }

  return filterChain;
}

/**
 * Build filter_complex for talking mode.
 * Clean 9:16 crop centered on avatar, scaled to 1080x1920. No blur frame.
 */
function buildTalkingFilterComplex(hookText?: string, cropX?: number): string {
  // 9:16 crop from source: width = height * 9/16.  Full height (ih), width auto.
  const cx = cropX ?? 0;
  let filterChain =
    `[0:v]crop=ih*9/16:ih:${cx}:0,scale=1080:1920`;

  if (hookText) {
    filterChain += `,${buildHookFilters(hookText, 1700)}[final]`;
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
    assPath: string | null;
    duration: number;
    hookText?: string;
  },
): void {
  const startTime = Date.now();

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
        )
      : buildTalkingFilterComplex(options.hookText);

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
  const srtPath = args.srt as string | undefined;
  const layoutOverride = args.layout as LayoutMode | undefined;

  if (!streamId) {
    log.error("--stream <id> is required");
    process.exit(1);
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
    segments?: Array<{ startSec: number; durationSec: number; label?: string }>;
    // Legacy fields
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
    const clipPath = findRawClip(rawClipsDir, rank);
    if (!clipPath) {
      log.warn(`  Clip not found in raw-clips/ for rank ${rank}. Run clip extraction first.`);
      continue;
    }
    const clipBasename = clipPath.split(/[/\\]/).pop()!;

    // Detect or override layout mode
    let layoutMode: LayoutMode;
    if (layoutOverride) {
      layoutMode = layoutOverride;
      log.info(`  Layout mode: ${layoutMode} (overridden)`);
    } else {
      layoutMode = detectLayoutMode(clipPath, gameplayRegion, tempDir);
      log.info(`  Layout mode: ${layoutMode}`);
    }

    // Prepare ASS karaoke captions
    let assFilePath: string | null = null;
    if (!noCaptions) {
      if (srtPath) {
        // Use provided SRT (legacy support)
        assFilePath = srtPath;
        log.info(`  Captions: using provided file: ${srtPath}`);
      } else if (allWords) {
        // Check if this is a multi-segment (timeline) clip
        const segments = (moment as any).segments as Array<{ startSec: number; durationSec: number; label?: string }> | undefined;

        let captionChunks: ReturnType<typeof generateCaptionChunks> = [];

        if (segments && segments.length > 1) {
          let offsetMs = 0;
          for (const seg of segments) {
            const segWords = filterByTimeRange(allWords, seg.startSec, seg.startSec + seg.durationSec);
            if (segWords.length > 0) {
              // filterByTimeRange already remaps to segment-relative timestamps
              // Just add the clip-level offset for multi-segment positioning
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
          const captionWords = filterByTimeRange(
            allWords,
            moment.suggestedStartSec,
            moment.suggestedEndSec,
          );
          if (captionWords.length > 0) {
            captionChunks = generateCaptionChunks(captionWords);
          }
        }

        if (captionChunks.length > 0) {
          assFilePath = join(shortsDir, `karaoke-${padded}.ass`);
          writeKaraokeAss(captionChunks, layoutMode, assFilePath);
          log.info(`  Karaoke ASS: generated ${captionChunks.length} chunks`);
        } else {
          log.warn(`  No caption words found for segments: ${JSON.stringify(segments?.map(s => ({s: s.startSec, d: s.durationSec})))}`);
        }
      }
    }

    // Get clip duration for ffmpeg
    const clipDuration = getVideoDuration(clipPath);

    // Get hook text: CLI override > upload-metadata > none
    const hookText = (args["hook-text"] as string) || hookTexts.get(rank) || undefined;
    if (hookText) {
      log.info(`  Hook: "${hookText}"`);
    } else {
      log.warn(`  No hook text for clip #${rank}`);
    }

    // Render via ffmpeg — output uses same basename as raw clip
    const shortPath = join(shortsDir, clipBasename);

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
