/**
 * harvest-crowd-route.ts — Twitch clips as source anchors for one YouTube VOD.
 *
 * The crowd route has produced zero candidates since the pipeline was written,
 * not because it fails but because nobody built it: `RecallSource` declared
 * "twitch-clip" and nothing ever emitted one.
 *
 * Writes crowd-anchors.json into the job directory. Wiring those into
 * recall-union.json is deliberately left alone — which recall routes survive is
 * ticket 07's decision, and the anchors are already in RecallAnchor shape for
 * whenever that is made.
 *
 * Usage:
 *   npx tsx packages/clips/src/harvest-crowd-route.ts --stream <youtubeId>
 *   npx tsx packages/clips/src/harvest-crowd-route.ts --stream <id> --limit 200
 */

import { execSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger } from "@ltx/shared";
import { findStreamDir } from "./lib/manifest.js";
import { ytDlpCommand } from "./lib/yt-dlp.js";
import {
  parseClipDumpJson,
  toCrowdAnchors,
  type TwitchClip,
  type VodWindow,
} from "./lib/twitch-clips.js";

const log = createLogger("crowd-route");
const DEFAULT_TWITCH_CHANNEL = process.env.TWITCH_CHANNEL?.trim() || "theburntpeanut";

function parseArgs(): { streamId: string; channel: string; limit: number } {
  const args = process.argv.slice(2);
  let streamId = "";
  let channel = DEFAULT_TWITCH_CHANNEL;
  let limit = 100;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) streamId = args[++i];
    else if (args[i] === "--channel" && args[i + 1]) channel = args[++i];
    else if (args[i] === "--limit" && args[i + 1]) limit = Number(args[++i]);
  }
  if (!streamId) throw new Error("--stream <youtubeId> is required");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  return { streamId, channel, limit };
}

/**
 * Run yt-dlp and return stdout, ignoring a non-zero exit.
 *
 * yt-dlp can emit every record and *then* fail on cookie writeback, so the exit
 * code says nothing about whether the data arrived. Callers judge the content.
 */
function runTolerant(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const output = (err as { stdout?: string }).stdout;
    if (output) return output;
    throw err;
  }
}

/** Broadcast start and duration. Needs a per-video extraction: --flat-playlist leaves release_timestamp null. */
function fetchVodWindow(streamId: string): VodWindow {
  const out = runTolerant(
    `${ytDlpCommand()} --no-warnings --skip-download `
    + `--print "%(release_timestamp)s|%(duration)s" "https://youtube.com/watch?v=${streamId}"`,
  );
  const line = out.split("\n").map((l) => l.trim()).filter((l) => l.includes("|")).pop();
  if (!line) throw new Error(`yt-dlp returned no metadata for ${streamId}`);
  const [rawRelease, rawDuration] = line.split("|");
  const releaseTimestamp = Number(rawRelease);
  const durationSec = Number(rawDuration);
  if (!Number.isFinite(releaseTimestamp)) {
    throw new Error(
      `${streamId} has no release_timestamp, so clips cannot be placed on its timeline. `
      + "A VOD that was never a live broadcast has no crowd route.",
    );
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`${streamId} reported no usable duration`);
  }
  return { streamId, releaseTimestamp, durationSec };
}

function fetchClips(channel: string, limit: number): TwitchClip[] {
  const out = runTolerant(
    `${ytDlpCommand()} --no-warnings --flat-playlist --dump-json `
    + `--playlist-items 1-${limit} "https://www.twitch.tv/${channel}/clips"`,
  );
  return parseClipDumpJson(out);
}

function main(): void {
  const { streamId, channel, limit } = parseArgs();
  const streamDir = findStreamDir(streamId);
  if (!streamDir) throw new Error(`No job directory found for ${streamId}`);

  const vod = fetchVodWindow(streamId);
  log.info(`VOD ${streamId}: broadcast started ${new Date(vod.releaseTimestamp * 1000).toISOString()}, `
    + `${(vod.durationSec / 3600).toFixed(2)}h`);

  const clips = fetchClips(channel, limit);
  log.info(`Fetched ${clips.length} clips from twitch.tv/${channel}`);
  if (clips.length === 0) {
    throw new Error("No clips parsed. The channel may have none, or the clips page shape changed.");
  }

  const anchors = toCrowdAnchors(clips, vod);
  log.info(`${anchors.length} of ${clips.length} clips fall inside this VOD`);
  for (const anchor of anchors) {
    const at = new Date(anchor.anchorSec * 1000).toISOString().slice(11, 19);
    log.info(`  ${at}  ${anchor.description.slice(0, 48)}`);
  }

  if (anchors.length === 0) {
    log.warn("No clips overlap this VOD. Clips age out of Twitch's archive at 60 days, "
      + "and an older stream will have none left to match.");
  }

  const outPath = join(streamDir, "crowd-anchors.json");
  writeFileSync(outPath, JSON.stringify({
    version: 1,
    streamId,
    twitchChannel: channel,
    generatedAt: new Date().toISOString(),
    vod,
    clipsFetched: clips.length,
    anchors,
  }, null, 2), "utf-8");
  log.info(`Wrote ${outPath}`);
}

main();
