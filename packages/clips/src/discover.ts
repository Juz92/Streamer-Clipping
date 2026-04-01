import { execSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger, ensureDir, DATA_DIR } from "@ltx/shared";
import { getStreamDir, saveManifest } from "./lib/manifest.js";
import type { StreamManifest } from "./lib/manifest.js";

const log = createLogger("discover");

const DEFAULT_CHANNEL = "https://www.youtube.com/@TheBurntPeanut";
const YT_DLP = process.env.YT_DLP_CMD ?? "python -m yt_dlp";

const args = process.argv.slice(2);
const listMode = args.indexOf("--list") !== -1;
const urlIdx = args.indexOf("--url");
const urlArg = urlIdx !== -1 ? args[urlIdx + 1] : null;

function extractVideoId(url: string): string | null {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function run(cmd: string, opts?: { timeout?: number; stdio?: "inherit" | "pipe" }): string {
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: opts?.timeout ?? 120_000,
      stdio: opts?.stdio === "inherit" ? "inherit" : "pipe",
    });
    return (result ?? "").trim();
  } catch (err) {
    throw err;
  }
}

async function listStreams(): Promise<void> {
  log.info("Fetching recent streams...");
  const cmd = `${YT_DLP} --flat-playlist --print "%(id)s | %(title)s | %(upload_date>%Y-%m-%d)s | %(duration_string)s" "${DEFAULT_CHANNEL}/streams" --playlist-items 1:10`;
  try {
    const output = run(cmd, { timeout: 30_000 });
    console.log("\nRecent streams:\n");
    const lines = output.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      console.log(`  ${i + 1}. ${lines[i]}`);
    }
    console.log();
  } catch (err: any) {
    log.error(`Failed to list streams: ${err.message}`);
    process.exit(1);
  }
}

async function download(): Promise<void> {
  let streamId: string;

  if (urlArg) {
    const extracted = extractVideoId(urlArg);
    if (!extracted) {
      log.error(`Could not extract video ID from URL: ${urlArg}`);
      process.exit(1);
    }
    streamId = extracted;
    log.info(`Using provided URL, stream ID: ${streamId}`);
  } else {
    log.info("Finding latest stream...");
    try {
      streamId = run(
        `${YT_DLP} --flat-playlist --print "%(id)s" "${DEFAULT_CHANNEL}/streams" --playlist-items 1:1`,
        { timeout: 30_000 },
      );
      if (!streamId) {
        log.error("No streams found on channel");
        process.exit(1);
      }
      log.info(`Latest stream ID: ${streamId}`);
    } catch (err: any) {
      log.error(`Failed to find latest stream: ${err.message}`);
      process.exit(1);
    }
  }

  // Get metadata
  let title = "Unknown";
  let uploadDate = "unknown";
  let durationSec = 0;

  try {
    const meta = run(
      `${YT_DLP} --print "%(title)s" --print "%(upload_date>%Y-%m-%d)s" --print "%(duration)s" --skip-download "https://youtube.com/watch?v=${streamId}"`,
      { timeout: 30_000 },
    );
    const lines = meta.split("\n");
    if (lines.length >= 3) {
      title = lines[0].trim();
      uploadDate = lines[1].trim();
      durationSec = parseInt(lines[2].trim(), 10) || 0;
    }
    log.info(`Stream: "${title}" (${uploadDate}, ${Math.round(durationSec / 60)}min)`);
  } catch (err: any) {
    log.warn(`Could not fetch metadata: ${err.message}`);
  }

  // Create working directory (job-NNN-YYYY-MM-DD format)
  const dir = getStreamDir(streamId, uploadDate !== "unknown" ? uploadDate : undefined);
  const sourceDir = join(dir, "source");
  ensureDir(sourceDir);

  const videoPath = join(sourceDir, "stream.mp4");

  // Check if already downloaded
  if (existsSync(videoPath)) {
    log.info("Video already downloaded, skipping download");
  } else {
    log.info("Downloading video (this may take a while)...");
    try {
      run(
        `${YT_DLP} -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${videoPath}" "https://youtube.com/watch?v=${streamId}"`,
        { timeout: 3_600_000, stdio: "inherit" },
      );
      log.info("Video download complete");
    } catch (err: any) {
      log.error(`Video download failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Download auto-subs
  let subtitlePath: string | null = null;
  const subsOutput = join(sourceDir, "stream");
  const expectedSubPath = join(sourceDir, "stream.en.vtt");

  try {
    run(
      `${YT_DLP} --write-auto-sub --sub-lang en --sub-format vtt --skip-download -o "${subsOutput}" "https://youtube.com/watch?v=${streamId}"`,
      { timeout: 60_000 },
    );
    if (existsSync(expectedSubPath)) {
      subtitlePath = expectedSubPath;
      log.info("Auto-subs downloaded");
    } else {
      log.warn("Auto-subs file not found after download");
    }
  } catch (err: any) {
    log.warn(`Auto-subs download failed: ${err.message}`);
  }

  // Download live chat
  let chatPath: string | null = null;
  const chatOutput = join(sourceDir, "chat");
  const expectedChatPath = join(sourceDir, "chat.live_chat.json");

  try {
    run(
      `${YT_DLP} --write-sub --sub-lang live_chat --skip-download -o "${chatOutput}" "https://youtube.com/watch?v=${streamId}"`,
      { timeout: 120_000 },
    );
    if (existsSync(expectedChatPath)) {
      chatPath = expectedChatPath;
      log.info("Live chat downloaded");
    } else {
      log.warn("Live chat file not found after download");
    }
  } catch (err: any) {
    log.warn(`Live chat download failed: ${err.message}`);
  }

  // Write manifest
  const manifest: StreamManifest = {
    streamId,
    channelHandle: "@TheBurntPeanut",
    title,
    uploadDate,
    durationSec,
    jobDir: dir,
    videoPath,
    subtitlePath,
    chatPath,
    audioLevelsPath: null,
    momentsPath: null,
    phase: "downloaded",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveManifest(manifest);
  log.info("Manifest saved");

  // Summary
  console.log("\n--- Download Summary ---");
  console.log(`  Stream:    ${title}`);
  console.log(`  Date:      ${uploadDate}`);
  console.log(`  Duration:  ${Math.round(durationSec / 60)} min`);
  console.log(`  Video:     ${existsSync(videoPath) ? "OK" : "MISSING"}`);
  console.log(`  Subtitles: ${subtitlePath ? "OK" : "not available"}`);
  console.log(`  Chat:      ${chatPath ? "OK" : "not available"}`);
  console.log(`  Directory: ${dir}`);
  console.log();
}

async function main(): Promise<void> {
  if (listMode) {
    await listStreams();
  } else {
    await download();
  }
}

main().catch((err) => {
  log.error(err.message ?? err);
  process.exit(1);
});

process.on("exit", () => {});
