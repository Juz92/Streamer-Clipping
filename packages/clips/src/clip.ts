import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { createLogger, ensureDir, DATA_DIR } from "@ltx/shared";
import { getStreamDir, loadManifest, saveManifest } from "./lib/manifest.js";
import { parseVtt, vttToWordTimestamps, filterByTimeRange } from "./lib/subtitle-parser.js";
import { detectLayoutMode } from "./lib/layout.js";
import { loadChannelConfig, saveChannelConfig } from "./lib/config.js";
import type { Moment } from "./lib/scorer.js";
import type { ChannelConfig, Region } from "./lib/config.js";

const log = createLogger("clip");
const ENCODE_OPTS = "-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k";

function slugify(description: string): string {
  return description
    .split(/\s+/)
    .slice(0, 3)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

interface Segment { startSec: number; durationSec: number; }

function extractMultiSegmentClip(
  sourcePath: string,
  segments: Segment[],
  outputPath: string,
  tempDir: string,
): void {
  if (segments.length === 1) {
    // Single segment — re-encode and explicitly map audio so extracted clips are never silent.
    execSync(
      `ffmpeg -ss ${segments[0].startSec} -i "${sourcePath}" -t ${segments[0].durationSec} -map 0:v:0 -map 0:a? ${ENCODE_OPTS} -movflags +faststart "${outputPath}" -y`,
      { stdio: "pipe", timeout: 120000 },
    );
    return;
  }

  // Multi-segment: re-encode each part then concat for clean audio
  const partFiles: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const partPath = join(tempDir, `part-${i}.mp4`);
    partFiles.push(partPath);
    execSync(
      `ffmpeg -ss ${seg.startSec} -i "${sourcePath}" -t ${seg.durationSec} ${ENCODE_OPTS} "${partPath}" -y`,
      { stdio: "pipe", timeout: 120000 },
    );
  }

  const concatFile = join(tempDir, "concat.txt");
  writeFileSync(concatFile, partFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"), "utf-8");

  execSync(
    `ffmpeg -f concat -safe 0 -i "${concatFile}" ${ENCODE_OPTS} "${outputPath}" -y`,
    { stdio: "pipe", timeout: 120000 },
  );

  // Cleanup temp files
  for (const f of partFiles) { try { unlinkSync(f); } catch {} }
  try { unlinkSync(concatFile); } catch {}
}

function parseArgs(argv: string[]) {
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

const args = parseArgs(process.argv);
const streamId = args.stream as string | undefined;
const momentsArg = args.moments as string | undefined;
const all = !!args.all;
const preview = !!args.preview;
const setup = !!args.setup;

if (setup) {
  const existing = loadChannelConfig();
  if (existing) {
    log.info("Channel config already exists:");
    log.info(JSON.stringify(existing, null, 2));
    process.exit(0);
  }

  log.info(`Channel config not found. Create ${join(DATA_DIR, "clips", "channel-config.json")} with:`);
  log.info(JSON.stringify({
    channel: "@TheBurntPeanut",
    avatarRegion: { x: 50, y: 50, w: 350, h: 350 },
    gameplayRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  }, null, 2));
  log.info("");
  log.info("To find avatar coordinates:");
  log.info("1. Open a stream frame: ffmpeg -ss 60 -i stream.mp4 -vframes 1 frame.jpg");
  log.info("2. Open frame.jpg and note the avatar overlay position (x, y, width, height)");
  process.exit(0);
}

if (!streamId) {
  log.error("--stream <id> is required");
  process.exit(1);
}

if (!momentsArg && !all) {
  log.error("Provide --moments 1,2,5 or --all");
  process.exit(1);
}

const manifest = loadManifest(streamId);
const streamDir = getStreamDir(streamId);

// Prefer unified-moments.json (merged manual + automated picks from scan.ts)
// Fall back to moments.json (automated only from analyze.ts)
const unifiedPath = join(streamDir, "unified-moments.json");
const momentsPath = join(streamDir, "moments.json");

let moments: Moment[];

if (existsSync(unifiedPath)) {
  log.info("Loading unified-moments.json (merged manual + automated picks)");
  const unified = JSON.parse(readFileSync(unifiedPath, "utf-8")) as Array<{
    startSec: number;
    endSec: number;
    durationSec: number;
    description: string;
    viralityScore: number;
    segments?: Array<{ startSec: number; durationSec: number; label?: string }>;
    // Legacy fields — converted to segments if present
    multiSegment?: boolean;
    buildUpStartSec?: number;
    buildUpDurationSec?: number;
    automatedSignals?: Record<string, unknown>;
  }>;
  // Adapt unified moments to the Moment interface clip.ts expects
  moments = unified.map((u, i) => {
    // Resolve segments: prefer new N-segment array, fall back to legacy 2-segment fields
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
      // Pass through segments for multi-segment extraction
      ...(segments ? { segments } : {}),
    };
  }) as Moment[];
} else if (existsSync(momentsPath)) {
  moments = JSON.parse(readFileSync(momentsPath, "utf-8"));
} else {
  log.error(`No moments found. Run 'analyze.ts' or 'scan.ts --merge' first.`);
  log.error(`Looked for: ${unifiedPath}`);
  log.error(`        and: ${momentsPath}`);
  process.exit(1);
}

let selectedIndices: number[];
if (all) {
  selectedIndices = moments.map((_, i) => i);
} else {
  selectedIndices = (momentsArg as string)
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < moments.length);
}

if (selectedIndices.length === 0) {
  log.error("No valid moments selected");
  process.exit(1);
}

let config = loadChannelConfig();
if (!config) {
  config = {
    channel: "@TheBurntPeanut",
    avatarRegion: { x: 24, y: 24, w: 380, h: 380 },
    gameplayRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  };
  saveChannelConfig(config);
  log.info("No channel config found. Saved defaults (top-left avatar, full-frame gameplay).");
}

let allWords: ReturnType<typeof vttToWordTimestamps> | null = null;
if (manifest.subtitlePath) {
  const subtitleFullPath = manifest.subtitlePath;
  if (existsSync(subtitleFullPath)) {
    const cues = parseVtt(subtitleFullPath);
    allWords = vttToWordTimestamps(cues);
    log.info(`Loaded ${allWords.length} caption words from subtitles`);
  }
}

const clipsDir = join(streamDir, "clips");
const shortsDir = join(streamDir, "shorts");
ensureDir(clipsDir);
ensureDir(shortsDir);

const tempDir = join(streamDir, "temp");
ensureDir(tempDir);

const summary: { file: string; duration: number; layout: string }[] = [];

for (const idx of selectedIndices) {
  const moment = moments[idx];
  const rank = idx + 1;
  const padded = String(rank).padStart(3, "0");
  const slug = slugify(moment.description);

  log.info(`\n--- Moment #${rank}: ${moment.description} ---`);
  log.info(`  Time: ${moment.suggestedStartSec.toFixed(1)}s - ${moment.suggestedEndSec.toFixed(1)}s (${moment.suggestedDurationSec.toFixed(1)}s)`);

  const clipFilename = `clip-${padded}-${slug}.mp4`;
  const clipPath = join(clipsDir, clipFilename);
  const sourcePath = manifest.videoPath;

  // Use single segment by default; multi-segment clips can be created
  // by setting moment.segments (build-up + payoff with cut)
  const segments: Segment[] = (moment as any).segments ?? [
    { startSec: moment.suggestedStartSec, durationSec: moment.suggestedDurationSec },
  ];

  extractMultiSegmentClip(sourcePath, segments, clipPath, tempDir);
  log.info(`  Extracted clip: ${clipFilename} (${segments.length} segment${segments.length > 1 ? "s, re-encoded" : ""})`);

  const layoutMode = detectLayoutMode(clipPath, config.gameplayRegion, tempDir, config.avatarRegion);
  log.info(`  Layout mode: ${layoutMode}`);

  let captionWords: ReturnType<typeof filterByTimeRange> | undefined;
  if (allWords) {
    captionWords = filterByTimeRange(allWords, moment.suggestedStartSec, moment.suggestedEndSec);
    log.info(`  Captions: ${captionWords.length} words`);
  }

  if (preview) {
    log.info(`  [preview] Skipping render`);
    summary.push({ file: clipFilename, duration: moment.suggestedDurationSec, layout: layoutMode });
    continue;
  }

  const inputProps = {
    clipSrc: `clips/${clipFilename}`,
    layoutMode,
    avatarRegion: config.avatarRegion,
    gameplayRegion: config.gameplayRegion,
    captionWords: captionWords ?? undefined,
    durationFrames: Math.round(moment.suggestedDurationSec * 30),
    title: slug,
  };

  const propsFilename = `input-props-${padded}.json`;
  const propsPath = join(shortsDir, propsFilename);
  writeFileSync(propsPath, JSON.stringify(inputProps, null, 2), "utf-8");
  log.info(`  Props: shorts/${propsFilename}`);

  const shortFilename = `short-${padded}-${slug}.mp4`;
  const shortPath = join(shortsDir, shortFilename);

  const renderCmd = [
    `npx remotion render`,
    `"packages/remotion/src/index.ts"`,
    `GamingShort`,
    `"${shortPath}"`,
    `--props "${propsPath}"`,
    `--codec h264`,
    `--public-dir "${streamDir}"`,
  ].join(" ");

  log.info(`  Rendering: ${shortFilename}`);
  execSync(renderCmd, { cwd: process.cwd(), stdio: "inherit", timeout: 600000 });

  summary.push({ file: shortFilename, duration: moment.suggestedDurationSec, layout: layoutMode });
  log.info(`  Done: ${shortFilename}`);
}

manifest.phase = "clipped";
saveManifest(manifest);

log.info("\n=== Clip Summary ===");
for (const s of summary) {
  log.info(`  ${s.file}  (${s.duration.toFixed(1)}s, ${s.layout})`);
}
log.info(`Total: ${summary.length} clip(s) processed`);
