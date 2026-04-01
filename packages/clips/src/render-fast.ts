import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
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
 * Skip first 3 seconds (reserved for hook/thumbnail).
 */
function generateSrtChunks(
  words: ReturnType<typeof filterByTimeRange>,
): Array<{
  startMs: number;
  endMs: number;
  text: string;
}> {
  const skipMs = 3000;
  const filtered = words.filter((w) => w.startMs >= skipMs);

  if (filtered.length === 0) return [];

  const chunks: Array<{ startMs: number; endMs: number; text: string }> = [];
  let i = 0;

  while (i < filtered.length) {
    const chunkSize = 3 + Math.floor(Math.random() * 2); // 3-4 words
    const chunk = filtered.slice(i, i + chunkSize);

    chunks.push({
      startMs: chunk[0].startMs,
      endMs: chunk[chunk.length - 1].endMs,
      text: chunk.map((w) => w.word).join(" "),
    });

    i += chunkSize;
  }

  return chunks;
}

/**
 * Write SRT file from caption chunks.
 * SRT format:
 * 1
 * 00:00:03,000 --> 00:00:04,200
 * So basically we
 */
function writeSrtFile(
  chunks: Array<{
    startMs: number;
    endMs: number;
    text: string;
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
    lines.push(chunk.text);
    lines.push("");
  }

  writeFileSync(outputPath, lines.join("\n"), "utf-8");
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
 * Avatar top 40% (1080x768) + gameplay bottom 60% (1080x1152) with divider + captions.
 */
function buildGameplayFilterComplex(
  srtPath: string | null,
  avatarX: number,
  avatarY: number,
  avatarW: number,
  avatarH: number,
): string {
  const escapedSrtPath = srtPath ? escapePath(srtPath) : null;

  let filterChain =
    `[0:v]split[v1][v2];` +
    `[v1]crop=${avatarW}:${avatarH}:${avatarX}:${avatarY},scale=1080:768[avatar];` +
    `[v2]crop=1920:1080:0:0,scale=1080:1152[gameplay];` +
    `[avatar][gameplay]vstack[stacked];` +
    `[stacked]drawbox=y=766:w=1080:h=4:color=white@0.15:t=fill[divided]`;

  if (escapedSrtPath) {
    // For gameplay mode, position captions at y=700 from top in a 1920-tall frame
    // Use Alignment=6 (top-center) with MarginV=700
    filterChain +=
      `;[divided]subtitles=${escapedSrtPath}:force_style='FontSize=13,FontName=Arial,Bold=1,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=1,BorderStyle=1,Alignment=6,MarginV=700'[final]`;
  } else {
    filterChain += `;[divided]scale=1080:1920[final]`;
  }

  return filterChain;
}

/**
 * Build filter_complex for talking mode.
 * Full-frame avatar centered with blurred background + captions at bottom.
 */
function buildTalkingFilterComplex(srtPath: string | null): string {
  const escapedSrtPath = srtPath ? escapePath(srtPath) : null;

  let filterChain =
    `[0:v]split[bg][fg];` +
    `[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[blurred];` +
    `[fg]crop=607:1080:0:0,scale=810:1440[sharp];` +
    `[blurred][sharp]overlay=(W-w)/2:(H-h)/2[composed]`;

  if (escapedSrtPath) {
    // For talking mode, position captions at bottom third (MarginV=200 from bottom)
    // Use Alignment=2 (bottom-center)
    filterChain +=
      `;[composed]subtitles=${escapedSrtPath}:force_style='FontSize=13,FontName=Arial,Bold=1,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=1,BorderStyle=1,Alignment=2,MarginV=200'[final]`;
  } else {
    filterChain += `;[composed]scale=1080:1920[final]`;
  }

  return filterChain;
}

/**
 * Render a single clip via ffmpeg.
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
    srtPath: string | null;
    duration: number;
  },
): void {
  const startTime = Date.now();

  const filterComplex =
    layoutMode === "gameplay"
      ? buildGameplayFilterComplex(
          options.srtPath,
          options.avatarX,
          options.avatarY,
          options.avatarW,
          options.avatarH,
        )
      : buildTalkingFilterComplex(options.srtPath);

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

  const clipsDir = join(streamDir, "clips");
  const shortsDir = join(streamDir, "shorts");
  ensureDir(clipsDir);
  ensureDir(shortsDir);

  const tempDir = join(streamDir, "temp");
  ensureDir(tempDir);

  const summary: Array<{
    file: string;
    duration: number;
    layout: LayoutMode;
  }> = [];

  for (const idx of selectedIndices) {
    const moment = moments[idx];
    const rank = idx + 1;
    const padded = String(rank).padStart(3, "0");

    // Slugify description
    const slug = moment.description
      .split(/\s+/)
      .slice(0, 3)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");

    const clipFilename = `clip-${padded}-${slug}.mp4`;
    const clipPath = join(clipsDir, clipFilename);
    const sourcePath = manifest.videoPath;

    log.info(`\n--- Clip #${rank}: ${moment.description} ---`);
    log.info(
      `  Time: ${moment.suggestedStartSec.toFixed(1)}s - ${moment.suggestedEndSec.toFixed(1)}s (${moment.suggestedDurationSec.toFixed(1)}s)`,
    );

    // Verify clip exists
    if (!existsSync(clipPath)) {
      log.warn(`  Clip not found: ${clipPath}. Run clip.ts first.`);
      continue;
    }

    // Detect or override layout mode
    let layoutMode: LayoutMode;
    if (layoutOverride) {
      layoutMode = layoutOverride;
      log.info(`  Layout mode: ${layoutMode} (overridden)`);
    } else {
      layoutMode = detectLayoutMode(clipPath, gameplayRegion, tempDir);
      log.info(`  Layout mode: ${layoutMode}`);
    }

    // Prepare captions
    let srtFilePath: string | null = null;
    if (!noCaptions) {
      if (srtPath) {
        // Use provided SRT
        srtFilePath = srtPath;
        log.info(`  Captions: using provided SRT: ${srtPath}`);
      } else if (allWords) {
        // Check if this is a multi-segment (timeline) clip
        const segments = (moment as any).segments as Array<{ startSec: number; durationSec: number; label?: string }> | undefined;

        if (segments && segments.length > 1) {
          // N-segment timeline clip: extract captions per segment and remap timestamps
          // so they're sequential in the concatenated clip
          let allChunks: Array<{ startMs: number; endMs: number; text: string }> = [];
          let offsetMs = 0;

          for (const seg of segments) {
            const segWords = filterByTimeRange(allWords, seg.startSec, seg.startSec + seg.durationSec);
            if (segWords.length > 0) {
              // Remap word timestamps: subtract segment start, add accumulated offset
              const remapped = segWords.map((w) => ({
                ...w,
                startMs: (w.startMs - seg.startSec * 1000) + offsetMs,
                endMs: (w.endMs - seg.startSec * 1000) + offsetMs,
              }));
              const segChunks = generateSrtChunks(remapped);
              allChunks = allChunks.concat(segChunks);
            }
            offsetMs += seg.durationSec * 1000;
          }

          if (allChunks.length > 0) {
            srtFilePath = join(tempDir, `captions-${padded}.srt`);
            writeSrtFile(allChunks, srtFilePath);
            log.info(`  Captions: generated ${allChunks.length} chunks across ${segments.length} segments (timeline)`);
          }
        } else {
          // Single-segment: normal caption extraction
          const captionWords = filterByTimeRange(
            allWords,
            moment.suggestedStartSec,
            moment.suggestedEndSec,
          );
          if (captionWords.length > 0) {
            const chunks = generateSrtChunks(captionWords);
            srtFilePath = join(tempDir, `captions-${padded}.srt`);
            writeSrtFile(chunks, srtFilePath);
            log.info(
              `  Captions: generated ${chunks.length} chunks from ${captionWords.length} words`,
            );
          }
        }
      }
    }

    // Get clip duration for ffmpeg
    const clipDuration = getVideoDuration(clipPath);

    // Render via ffmpeg
    const shortFilename = `short-${padded}-${slug}.mp4`;
    const shortPath = join(shortsDir, shortFilename);

    log.info(`  Rendering: ${shortFilename}`);
    renderClipFfmpeg(clipPath, layoutMode, shortPath, {
      avatarX: avatarRegion.x,
      avatarY: avatarRegion.y,
      avatarW: avatarRegion.w,
      avatarH: avatarRegion.h,
      srtPath: srtFilePath,
      duration: clipDuration,
    });

    // Cleanup temp SRT if auto-generated
    if (srtFilePath && srtFilePath.startsWith(tempDir)) {
      try {
        unlinkSync(srtFilePath);
      } catch {
        // ignore
      }
    }

    summary.push({
      file: shortFilename,
      duration: moment.suggestedDurationSec,
      layout: layoutMode,
    });
    log.info(`  Done: shorts/${shortFilename}`);
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
