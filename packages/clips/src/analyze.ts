import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { getStreamDir, loadManifest, saveManifest } from "./lib/manifest.js";
import { parseVtt, vttToWordTimestamps } from "./lib/subtitle-parser.js";
import { parseChatReplay } from "./lib/chat-parser.js";
import { extractAudioLevels, parseAudioLevels, detectAudioSpikes } from "./lib/audio-analyzer.js";
import { detectTranscriptSignals, detectChatSignals } from "./lib/signals.js";
import { scoreAndRankMoments } from "./lib/scorer.js";
import type { Moment } from "./lib/scorer.js";
import type { TranscriptSignal, ChatSignal } from "./lib/signals.js";
import type { AudioSignal } from "./lib/audio-analyzer.js";

const log = createLogger("analyze");

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseArgs(): { streamId: string; top: number; json: boolean } {
  const args = process.argv.slice(2);
  let streamId = "";
  let top = 20;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) {
      streamId = args[++i];
    } else if (args[i] === "--top" && args[i + 1]) {
      top = parseInt(args[++i], 10);
    } else if (args[i] === "--json") {
      json = true;
    }
  }

  if (!streamId) {
    log.error("Missing --stream <stream-id>");
    process.exit(1);
  }

  return { streamId, top, json };
}

function displayMoments(moments: Moment[], title: string, streamDurationSec: number, top: number): void {
  const shown = moments.slice(0, top);
  const hours = (streamDurationSec / 3600).toFixed(1);

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  VIRAL MOMENTS — "${title}"`);
  console.log(`  Found ${moments.length} moments from ${hours} hours of stream`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");

  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    const rank = i + 1;
    const score = m.scores.composite.toFixed(2);
    const startTime = formatTime(m.suggestedStartSec);
    const endTime = formatTime(m.suggestedEndSec);
    const dur = Math.round(m.suggestedDurationSec);

    const signalNames: string[] = [];
    if (m.transcriptSignals.length > 0) signalNames.push("TRANSCRIPT");
    if (m.chatSignals.length > 0) signalNames.push("CHAT");
    if (m.audioSignals.length > 0) signalNames.push("AUDIO");

    console.log(`  #${rank}  [${score}]  ${startTime} → ${endTime}  (${dur}s)`);
    console.log(`      Signals: ${signalNames.join(" + ")}`);

    const statParts: string[] = [];
    if (m.chatSignals.length > 0) {
      const maxRate = Math.max(...m.chatSignals.map((s) => s.messageRate));
      const maxSpike = Math.max(...m.chatSignals.map((s) => s.spikeIntensity));
      statParts.push(`Chat: ${(maxRate * 10).toFixed(0)} msg/10s (${maxSpike.toFixed(1)}x avg)`);
    }
    if (m.audioSignals.length > 0) {
      const maxDelta = Math.max(...m.audioSignals.map((s) => s.deltaFromAvg));
      statParts.push(`Audio: +${maxDelta.toFixed(0)}dB`);
    }
    if (statParts.length > 0) {
      console.log(`      ${statParts.join(" | ")}`);
    }

    console.log(`      ${m.description}`);
    console.log("      ──────────────────────────────────────────────────────");
    console.log("");
  }
}

async function main(): Promise<void> {
  const { streamId, top, json } = parseArgs();

  const manifest = loadManifest(streamId);
  const validPhases = ["downloaded", "analyzed", "clipped"];
  if (!validPhases.includes(manifest.phase)) {
    log.error(`Stream "${streamId}" is in phase "${manifest.phase}", expected "downloaded" or later`);
    process.exit(1);
  }

  const streamDir = getStreamDir(streamId);
  let transcriptSignals: TranscriptSignal[] = [];
  let chatSignals: ChatSignal[] = [];
  let audioSignals: AudioSignal[] = [];

  // Signal A — Transcription
  if (manifest.subtitlePath && existsSync(manifest.subtitlePath)) {
    log.info("Parsing subtitles...");
    const cues = parseVtt(manifest.subtitlePath);
    const words = vttToWordTimestamps(cues);
    transcriptSignals = detectTranscriptSignals(words);
    log.info(`Found ${transcriptSignals.length} transcript signals`);
  } else {
    log.warn("No subtitles available, skipping transcript analysis");
  }

  // Signal B — Chat
  if (manifest.chatPath && existsSync(manifest.chatPath)) {
    log.info("Parsing chat replay...");
    const messages = parseChatReplay(manifest.chatPath);
    chatSignals = detectChatSignals(messages);
    log.info(`Found ${chatSignals.length} chat signals`);
  } else {
    log.warn("No chat replay available, skipping chat analysis");
  }

  // Signal C — Audio
  const audioLevelsFile = join(streamDir, "audio_levels.txt");
  if (!existsSync(audioLevelsFile)) {
    log.info("Extracting audio levels (this may take a while)...");
    extractAudioLevels(manifest.videoPath, audioLevelsFile);
  }
  log.info("Parsing audio levels...");
  const samples = parseAudioLevels(audioLevelsFile);
  audioSignals = detectAudioSpikes(samples);
  log.info(`Found ${audioSignals.length} audio signals`);
  manifest.audioLevelsPath = audioLevelsFile;

  // Cross-reference and rank
  log.info("Scoring and ranking moments...");
  const moments = scoreAndRankMoments(
    transcriptSignals,
    chatSignals,
    audioSignals,
    manifest.durationSec,
  );
  log.info(`Ranked ${moments.length} moments`);

  // Save moments
  const momentsPath = join(streamDir, "moments.json");
  writeFileSync(momentsPath, JSON.stringify(moments, null, 2), "utf-8");
  manifest.momentsPath = momentsPath;
  manifest.phase = "analyzed";
  saveManifest(manifest);
  log.info(`Saved ${moments.length} moments to ${momentsPath}`);

  // Display results
  if (json) {
    console.log(JSON.stringify(moments.slice(0, top), null, 2));
    return;
  }

  displayMoments(moments, manifest.title, manifest.durationSec, top);

  log.info(
    `Run \`npx tsx packages/clips/src/clip.ts --stream ${streamId} --moments 1,2,5\` to clip selected moments`,
  );
}

main().catch((err) => {
  log.error("Analysis failed:", err);
  process.exit(1);
});
