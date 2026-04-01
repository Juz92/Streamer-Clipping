import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger, ensureDir, DATA_DIR } from "@ltx/shared";
import { getStreamDir, loadManifest } from "./lib/manifest.js";
import { parseVtt, vttToWordTimestamps, filterByTimeRange } from "./lib/subtitle-parser.js";
import { detectLayoutMode, extractRegionFrame } from "./lib/layout.js";
import { loadChannelConfig } from "./lib/config.js";
import type { CaptionWord } from "./lib/subtitle-parser.js";

const log = createLogger("preview");

interface ClipFile {
  name: string;
  path: string;
  rank: number;
}

interface PreviewArgs {
  streamId: string;
  mode: "clips" | "timestamp" | "captions";
  clipRanks: number[] | null;
  timestamp: string | null;
  duration: number | null;
  editCaptions: boolean;
}

function parseArgs(): PreviewArgs {
  const args = process.argv.slice(2);
  let streamId = "";
  let mode: "clips" | "timestamp" | "captions" = "clips";
  let clipRanks: number[] | null = null;
  let timestamp: string | null = null;
  let duration: number | null = null;
  let editCaptions = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) {
      streamId = args[++i];
    } else if (args[i] === "--clips" && args[i + 1]) {
      const clips = args[++i];
      clipRanks = clips.split(",").map((s) => parseInt(s.trim(), 10));
      mode = "clips";
    } else if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = args[++i];
      mode = "timestamp";
    } else if (args[i] === "--duration" && args[i + 1]) {
      duration = parseInt(args[++i], 10);
    } else if (args[i] === "--captions") {
      mode = "captions";
    } else if (args[i] === "--edit") {
      editCaptions = true;
    }
  }

  if (!streamId) {
    log.error("Missing required --stream <stream-id>");
    process.exit(1);
  }

  if (mode === "timestamp" && !timestamp) {
    log.error("--timestamp mode requires --timestamp HH:MM:SS");
    process.exit(1);
  }

  return { streamId, mode, clipRanks, timestamp, duration, editCaptions };
}

function getClipFiles(streamDir: string): ClipFile[] {
  const clipsDir = join(streamDir, "clips");
  if (!existsSync(clipsDir)) {
    return [];
  }

  const files = readdirSync(clipsDir).filter((f) => f.endsWith(".mp4"));
  return files
    .map((name) => {
      const match = name.match(/^clip-(\d+)/);
      const rank = match ? parseInt(match[1], 10) : 0;
      return {
        name,
        path: join(clipsDir, name),
        rank,
      };
    })
    .sort((a, b) => a.rank - b.rank);
}

function getClipDuration(clipPath: string): number {
  try {
    const output = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${clipPath}"`,
      { encoding: "utf-8" }
    ).trim();
    return parseFloat(output);
  } catch {
    return 0;
  }
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function parseTimestring(ts: string): number {
  const parts = ts.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!parts) return 0;
  const [, h, m, s] = parts;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function extractFrame(
  videoPath: string,
  timeSec: number,
  outputPath: string
): boolean {
  try {
    execSync(
      `ffmpeg -ss ${timeSec} -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}" -y`,
      { stdio: "pipe" }
    );
    return true;
  } catch {
    return false;
  }
}

function isBlackFrame(imagePath: string): boolean {
  try {
    const output = execSync(
      `ffmpeg -i "${imagePath}" -vf "blackframe=amount=90:threshold=32" -f null - 2>&1`,
      { encoding: "utf-8", stdio: "pipe" }
    );
    return /blackframe/.test(output);
  } catch (err: unknown) {
    const stderr = err instanceof Error && "stderr" in err ? String((err as any).stderr) : "";
    const stdout = err instanceof Error && "stdout" in err ? String((err as any).stdout) : "";
    return /blackframe/.test(stderr + stdout);
  }
}

async function previewClips(
  streamId: string,
  previewDir: string,
  clipRanks: number[] | null
): Promise<void> {
  const streamDir = getStreamDir(streamId);

  try {
    loadManifest(streamId);
  } catch {
    log.error(`Stream not found: ${streamId}`);
    process.exit(1);
  }

  const clips = getClipFiles(streamDir);
  if (clips.length === 0) {
    log.warn(`No clips found in ${join(streamDir, "clips")}`);
    return;
  }

  const toPreview = clipRanks ? clips.filter((c) => clipRanks.includes(c.rank)) : clips;

  if (toPreview.length === 0) {
    log.warn("No matching clips found for specified ranks");
    return;
  }

  ensureDir(previewDir);

  const config = loadChannelConfig();
  if (!config) {
    log.warn("No channel config found — layout detection may fail. Run setup first.");
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  CLIP PREVIEW — ${streamId}`);
  console.log(`  Extracting frames for ${toPreview.length} clip(s)`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  for (const clip of toPreview) {
    const duration = getClipDuration(clip.path);
    const midSec = duration / 2;
    const endSec = Math.max(0, duration - 1);

    const hookFrame = join(previewDir, `clip-${String(clip.rank).padStart(2, "0")}-hook.jpg`);
    const midFrame = join(previewDir, `clip-${String(clip.rank).padStart(2, "0")}-mid.jpg`);
    const endFrame = join(previewDir, `clip-${String(clip.rank).padStart(2, "0")}-end.jpg`);

    let hookSuccess = false;
    let layoutMode: string = "unknown";

    if (extractFrame(clip.path, 0, hookFrame)) {
      hookSuccess = true;
    } else {
      log.warn(`Could not extract hook frame for ${clip.name}`);
    }

    extractFrame(clip.path, midSec, midFrame);
    extractFrame(clip.path, endSec, endFrame);

    if (config) {
      try {
        layoutMode = detectLayoutMode(clip.path, config.gameplayRegion, previewDir);
      } catch {
        layoutMode = "unknown";
      }
    }

    const hookWarning = hookSuccess && isBlackFrame(hookFrame) ? " ⚠ Black hook frame — may need review" : "";

    console.log(`  Clip ${String(clip.rank).padStart(2, "0")}: ${clip.name}`);
    console.log(`    Duration: ${duration.toFixed(1)}s | Layout: ${layoutMode} | Frames: preview/clip-${String(clip.rank).padStart(2, "0")}-{hook,mid,end}.jpg${hookWarning}`);
    console.log("");
  }

  log.info(`Frame extraction complete. Saved to ${previewDir}`);
}

async function previewTimestamp(
  streamId: string,
  timestamp: string,
  duration: number | null,
  previewDir: string
): Promise<void> {
  const streamDir = getStreamDir(streamId);
  const manifest = loadManifest(streamId);

  const videoPath = manifest.videoPath;
  if (!existsSync(videoPath)) {
    log.error(`Stream video not found: ${videoPath}`);
    process.exit(1);
  }

  const startSec = parseTimestring(timestamp);
  const clipDuration = duration ?? 30;

  ensureDir(previewDir);

  log.info(`Extracting preview from ${timestamp} (${clipDuration}s)...`);

  const quickClip = join(previewDir, "quick-preview.mp4");
  try {
    execSync(
      `ffmpeg -ss ${startSec} -i "${videoPath}" -t ${clipDuration} -c:v libx264 -preset fast -crf 23 -c:a aac "${quickClip}" -y`,
      { stdio: "pipe" }
    );
  } catch {
    log.error("Failed to extract quick preview clip");
    process.exit(1);
  }

  const hookFrame = join(previewDir, "quick-preview-hook.jpg");
  const midFrame = join(previewDir, "quick-preview-mid.jpg");
  const endFrame = join(previewDir, "quick-preview-end.jpg");

  extractFrame(quickClip, 0, hookFrame);
  extractFrame(quickClip, clipDuration / 2, midFrame);
  extractFrame(quickClip, Math.max(0, clipDuration - 1), endFrame);

  const config = loadChannelConfig();
  let layoutMode = "unknown";
  if (config) {
    try {
      layoutMode = detectLayoutMode(quickClip, config.gameplayRegion, previewDir);
    } catch {
      // ignore
    }
  }

  const hookIsBlack = isBlackFrame(hookFrame);
  const hookWarning = hookIsBlack ? " ⚠ Hook is mostly black — check frame" : "";

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  TIMESTAMP PREVIEW — ${streamId}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`  Timestamp: ${timestamp}`);
  console.log(`  Duration: ${clipDuration}s`);
  console.log(`  Layout: ${layoutMode}`);
  console.log(`  Frames: preview/quick-preview-{hook,mid,end}.jpg${hookWarning}`);
  console.log(`  Clip: preview/quick-preview.mp4`);
  console.log("");

  if (manifest.subtitlePath && existsSync(manifest.subtitlePath)) {
    try {
      const cues = parseVtt(manifest.subtitlePath);
      const words = vttToWordTimestamps(cues);
      const filtered = filterByTimeRange(words, startSec, startSec + clipDuration);

      if (filtered.length > 0) {
        console.log(`  Captions for this timestamp:`);
        console.log("");
        const grouped = groupWordsIntoCues(filtered, 3, 4);
        for (const cue of grouped) {
          const start = formatTime(cue.startMs / 1000);
          const end = formatTime(cue.endMs / 1000);
          console.log(`    [${start} → ${end}] ${cue.text}`);
        }
        console.log("");
      }
    } catch (err: unknown) {
      log.warn("Could not parse subtitles for preview");
    }
  }

  log.info("Timestamp preview ready");
}

interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

function groupWordsIntoCues(
  words: CaptionWord[],
  minWords: number,
  maxWords: number
): SrtCue[] {
  const cues: SrtCue[] = [];
  let currentGroup: CaptionWord[] = [];

  for (const word of words) {
    currentGroup.push(word);

    if (currentGroup.length >= maxWords) {
      const cue = {
        index: cues.length + 1,
        startMs: currentGroup[0].startMs,
        endMs: currentGroup[currentGroup.length - 1].endMs,
        text: currentGroup.map((w) => w.word).join(" "),
      };
      cues.push(cue);
      currentGroup = [];
    }
  }

  if (currentGroup.length >= minWords) {
    const cue = {
      index: cues.length + 1,
      startMs: currentGroup[0].startMs,
      endMs: currentGroup[currentGroup.length - 1].endMs,
      text: currentGroup.map((w) => w.word).join(" "),
    };
    cues.push(cue);
  }

  return cues;
}

function msToSrtTime(ms: number): string {
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.floor(ms % 1000);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

async function previewCaptions(
  streamId: string,
  previewDir: string,
  editMode: boolean,
  clipRanks: number[] | null
): Promise<void> {
  const streamDir = getStreamDir(streamId);
  const manifest = loadManifest(streamId);

  if (!manifest.subtitlePath || !existsSync(manifest.subtitlePath)) {
    log.error("No subtitles found for this stream");
    process.exit(1);
  }

  const clips = getClipFiles(streamDir);
  if (clips.length === 0) {
    log.error("No clips found");
    process.exit(1);
  }

  const toPreview = clipRanks ? clips.filter((c) => clipRanks.includes(c.rank)) : clips;
  if (toPreview.length === 0) {
    log.warn("No matching clips found");
    return;
  }

  let allCues;
  try {
    const vttCues = parseVtt(manifest.subtitlePath);
    const words = vttToWordTimestamps(vttCues);
    allCues = words;
  } catch (err: unknown) {
    log.error(`Failed to parse subtitles: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  ensureDir(previewDir);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  CAPTION PREVIEW — ${streamId}`);
  console.log(`  Mode: ${editMode ? "EDIT (writing SRT files)" : "DISPLAY"}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  for (const clip of toPreview) {
    const duration = getClipDuration(clip.path);

    // Parse clip filename to get start timestamp (if available in metadata)
    // For now, we'll estimate based on clip number — in practice, clips/ should have timing info
    // This is a simplification; real implementation would load clip metadata
    const clipIndex = clip.rank - 1;

    const filtered = filterByTimeRange(allCues, 0, duration);
    const cues = groupWordsIntoCues(filtered, 3, 4);

    if (cues.length === 0) {
      console.log(`  Clip ${String(clip.rank).padStart(2, "0")}: ${clip.name}`);
      console.log(`    No captions available`);
      console.log("");
      continue;
    }

    // Check for issues
    const issues: string[] = [];
    for (let i = 0; i < cues.length - 1; i++) {
      const gap = cues[i + 1].startMs - cues[i].endMs;
      if (gap > 1000) {
        issues.push(`Gap >1s at cue ${cues[i].index}`);
      }
    }
    for (const cue of cues) {
      const wordCount = cue.text.split(/\s+/).length;
      if (wordCount > 6) {
        issues.push(`Long cue at ${cue.index} (${wordCount} words)`);
      }
    }

    const issueStr = issues.length > 0 ? ` ⚠ ${issues.join(", ")}` : "";

    console.log(`  Clip ${String(clip.rank).padStart(2, "0")}: ${clip.name}${issueStr}`);

    if (!editMode) {
      for (const cue of cues) {
        const start = formatTime(cue.startMs / 1000);
        const end = formatTime(cue.endMs / 1000);
        console.log(`    [${start} → ${end}] ${cue.text}`);
      }
    } else {
      // Write SRT file
      const srtPath = join(previewDir, `captions-${String(clip.rank).padStart(2, "0")}.srt`);
      let srtContent = "";
      for (const cue of cues) {
        srtContent += `${cue.index}\n`;
        srtContent += `${msToSrtTime(cue.startMs)} --> ${msToSrtTime(cue.endMs)}\n`;
        srtContent += `${cue.text}\n\n`;
      }
      writeFileSync(srtPath, srtContent, "utf-8");
      console.log(`    → Wrote ${cues.length} cues to ${srtPath}`);
    }
    console.log("");
  }

  if (editMode) {
    log.info("SRT files written to preview directory. Edit them and re-render clips with the corrected captions.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const streamDir = getStreamDir(args.streamId);
  const previewDir = join(streamDir, "preview");

  try {
    if (args.mode === "clips") {
      await previewClips(args.streamId, previewDir, args.clipRanks);
    } else if (args.mode === "timestamp") {
      const dur = args.duration ?? 30;
      await previewTimestamp(args.streamId, args.timestamp!, dur, previewDir);
    } else if (args.mode === "captions") {
      await previewCaptions(args.streamId, previewDir, args.editCaptions, args.clipRanks);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Preview failed: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  log.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
