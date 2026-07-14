import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { getStreamDir, loadManifest, saveManifest } from "./lib/manifest.js";
import { parseVtt, vttToWordTimestamps } from "./lib/subtitle-parser.js";
import { parseChatReplay } from "./lib/chat-parser.js";
import { extractAudioLevels, parseAudioLevels, detectAudioSpikes } from "./lib/audio-analyzer.js";
import { detectTranscriptSignals, detectChatSignals } from "./lib/signals.js";
import { scoreAndRankMoments } from "./lib/enhanced-scorer.js";
import type { Moment } from "./lib/enhanced-scorer.js";
import type { TranscriptSignal, ChatSignal } from "./lib/signals.js";
import type { AudioSignal } from "./lib/audio-analyzer.js";

// NEW: Scene-based humor detection
import { segmentStreamIntoScenes, mergeScenesIntoArcs, type SceneArc } from "./lib/scene-segmenter.js";
import { scoreScenes, getTopScenes } from "./lib/scene-scorer.js";
import type { SceneScore } from "./lib/scene-scorer.js";
import type { WhisperWord } from "./lib/whisper-captions.js";
import type { ChatMessage } from "./lib/chat-parser.js";
import type { AudioSample } from "./lib/audio-analyzer.js";
import type { SpeakerTurn } from "./lib/diarize.js";
import { loadTurns } from "./lib/diarize.js";

// NEW: LLM-based humor scoring
import { scoreScenesWithLLM, buildLLMRequestFromScene, blendComedyScore } from "./lib/llm-humor-scorer.js";
import type { LLMHumorResult } from "./lib/llm-humor-scorer.js";
import { discoveryRankScore, passesAutomaticDiscoveryFloor } from "./lib/content-lanes.js";

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
  let top = 15;
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
      const audioTypes: string[] = [];
      for (const s of m.audioSignals) {
        if (!audioTypes.includes(s.type)) audioTypes.push(s.type);
      }
      statParts.push(`Audio: +${maxDelta.toFixed(0)}dB (${audioTypes.join("+")})`);
    }
    statParts.push(
      `Laugh: ${((m.scores.laughDetection ?? 0) * 100).toFixed(0)}`,
      `Shock: ${((m.scores.shockReaction ?? 0) * 100).toFixed(0)}`,
      `ChatSync: ${((m.scores.chatSync ?? 0) * 100).toFixed(0)}`,
    );
    if (m.rescueReason) statParts.push(`Rescue: ${m.rescueReason}`);
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
  const validPhases = ["downloaded", "analyzed", "clipped", "rendered", "review-ready", "notebooklm-reviewed"];
  if (!validPhases.includes(manifest.phase)) {
    log.error(`Stream "${streamId}" is in phase "${manifest.phase}", expected "downloaded" or later`);
    process.exit(1);
  }

  const streamDir = manifest.jobDir || getStreamDir(streamId);
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

  // NEW: Scene-based humor detection pipeline
  log.info("Building scene-based humor pipeline...");
  let words: WhisperWord[] = [];
  let messages: ChatMessage[] = [];
  let speakerTurns: SpeakerTurn[] = [];

  if (manifest.subtitlePath && existsSync(manifest.subtitlePath)) {
    const cues = parseVtt(manifest.subtitlePath);
    words = vttToWordTimestamps(cues);
  }
  if (manifest.chatPath && existsSync(manifest.chatPath)) {
    messages = parseChatReplay(manifest.chatPath);
  }
  const diarizationPath = join(streamDir, "diarization.json");
  if (existsSync(diarizationPath)) {
    speakerTurns = loadTurns(diarizationPath) ?? [];
    log.info(`Loaded ${speakerTurns.length} speaker turns`);
  }

  // Segment stream into scenes
  log.info("Segmenting stream into scenes...");
  const scenes = segmentStreamIntoScenes(
    samples,
    words,
    messages,
    speakerTurns,
    manifest.durationSec,
  );
  log.info(`Found ${scenes.length} scenes`);

  // Score scenes by humor potential (regex-based patterns)
  log.info("Scoring scenes by humor patterns...");
  const sceneScores = scoreScenes(scenes);

  // NEW: Merge adjacent high-energy scenes into sustained arcs
  log.info("Merging adjacent scenes into arcs...");
  const arcs = mergeScenesIntoArcs(scenes);
  log.info(`Found ${arcs.length} sustained arcs (${arcs.map(a => a.arcType).join(", ") || "none"})`);

  // Convert arcs to SceneScore format so they compete with individual scenes
  const arcScores: SceneScore[] = arcs.map(arc => ({
    sceneId: arc.id,
    startSec: arc.startSec,
    endSec: arc.endSec,
    durationSec: arc.durationSec,
    humorScore: arc.arcScore,
    patterns: [{
      type: "setup-punchline" as const,
      confidence: arc.arcScore,
      triggerTimeSec: arc.startSec,
      payoffTimeSec: arc.startSec + arc.durationSec * 0.6,
      description: `${arc.arcType} arc: ${arc.scenes.length} scenes merged, ${arc.durationSec.toFixed(1)}s sustained energy`,
      supportingEvidence: arc.scenes.map(s => s.transcript.topKeywords.slice(0, 3).join(" ")),
    }],
    patternConfidence: arc.arcScore,
    chatReactionScore: Math.min(arc.scenes.reduce((sum, s) => sum + s.chat.laughHits + s.chat.shockHits, 0) / 8, 1),
    audioArcScore: Math.min(arc.scenes.reduce((sum, s) => sum + s.audio.rmsRange, 0) / arc.scenes.length / 30, 1),
    transcriptQuality: 0.5,
    compositeRank: 0,
    bestClipWindow: {
      startSec: arc.startSec,
      endSec: Math.min(arc.endSec, arc.startSec + 35),
      centerSec: arc.startSec + Math.min(arc.durationSec, 35) / 2,
    },
    description: `${arc.arcType} arc: ${arc.scenes.length} scenes, ${arc.durationSec.toFixed(1)}s`,
  }));

  // NEW: LLM-based humor scoring for top candidate scenes
  let llmResults: Map<string, LLMHumorResult> = new Map();
  const topCandidateScenes = getTopScenes(sceneScores, Math.max(20, top)); // keep extra candidates for LLM review

  // Build LLM requests for top candidates
  const llmRequests = topCandidateScenes.map(s => buildLLMRequestFromScene(
    scenes.find(sc => sc.id === s.sceneId)!,
    s.sceneId,
  ));

  // Call LLM if API key is available
  if (process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    log.info("Running LLM humor analysis on top " + llmRequests.length + " scenes...");
    llmResults = await scoreScenesWithLLM(llmRequests, 5);
    log.info("LLM analysis complete");
  } else {
    log.warn("No LLM API key found (ANTHROPIC_API_KEY or OPENAI_API_KEY). Using regex-only scoring.");
  }

  // Re-rank scenes using LLM scores when available
  const scoredScenes = sceneScores.map(s => {
    const llmResult = llmResults.get(s.sceneId);
    if (llmResult && llmResult.confidence > 0.3) {
      // Energy can look viral without being funny. Let the explicit cold-viewer
      // LOL score dominate and cap scenes the model says are merely exciting.
      const llmComedy = blendComedyScore(llmResult.humorScore, llmResult.laughOutLoudScore);
      let blendedHumor = llmComedy * 0.75 + s.humorScore * 0.25;
      if (llmResult.laughOutLoudScore < 0.55) blendedHumor = Math.min(blendedHumor, 0.55);
      const discoveryScore = discoveryRankScore({
        contentLane: llmResult.contentLane,
        payoffType: llmResult.payoffType,
        laneScore: llmResult.laneScore,
        laughOutLoudScore: llmResult.laughOutLoudScore,
        comedyScore: blendedHumor,
      });
      // Clamp LLM flash/end times to scene bounds, but keep enough runway for sustained loops.
      const sceneStart = s.startSec;
      const sceneEnd = s.endSec;
      const sceneDuration = Math.max(0, sceneEnd - sceneStart);
      const llmFlash = Math.max(sceneStart, Math.min(sceneEnd, llmResult.flashTimeSec));
      const llmEndRaw = Math.max(sceneStart, Math.min(sceneEnd, llmResult.endTimeSec));
      const targetDuration = Math.min(28, Math.max(16, Math.min(sceneDuration, 22)));
      let windowStart = Math.max(sceneStart, llmFlash - 8);
      let windowEnd = Math.min(sceneEnd, Math.max(llmEndRaw + 4, windowStart + targetDuration));
      if (windowEnd - windowStart < Math.min(12, sceneDuration)) {
        windowStart = Math.max(sceneStart, Math.min(llmFlash - 8, sceneEnd - Math.min(16, sceneDuration)));
        windowEnd = Math.min(sceneEnd, windowStart + Math.min(22, sceneDuration));
      }
      return {
        ...s,
        humorScore: blendedHumor,
        laughOutLoudScore: llmResult.laughOutLoudScore,
        contentLane: llmResult.contentLane,
        payoffType: llmResult.payoffType,
        laneScore: llmResult.laneScore,
        discoveryScore,
        // Override flash/end times with LLM suggestions when confident, while avoiding useless 3-6s micro-clips.
        bestClipWindow: llmResult.confidence > 0.6
          ? {
              startSec: windowStart,
              endSec: windowEnd,
              centerSec: llmFlash,
            }
          : s.bestClipWindow,
        description: llmResult.whyWorthWatching || llmResult.whyFunny || s.description,
        llmTags: llmResult.tags,
      };
    }
    return s;
  });

  // Sort by strongest lane-specific payoff, not comedy alone.
  scoredScenes.sort((a, b) => (b.discoveryScore ?? b.humorScore) - (a.discoveryScore ?? a.humorScore));

  // Reviewed candidates must clear their selected lane's evidence floor. Energy-only
  // arcs remain discovery context until they receive the same LLM lane assessment.
  const reviewedScenes = llmResults.size > 0
    ? scoredScenes.filter((scene) => passesAutomaticDiscoveryFloor({
        contentLane: scene.contentLane,
        payoffType: scene.payoffType,
        laneScore: scene.laneScore,
        laughOutLoudScore: scene.laughOutLoudScore,
      }))
    : scoredScenes;
  const topScenes = reviewedScenes.slice(0, top);

  log.info("Top discovery scores: " + topScenes.slice(0, 5).map(s => (s.discoveryScore ?? s.humorScore).toFixed(2)).join(", "));
  if (arcs.length > 0) {
    log.info(`Arcs in top 5: ${topScenes.slice(0, 5).filter(s => s.sceneId.startsWith("arc-")).length}`);
  }

  // Convert every lane-clearing scene for recall. The production shortlist is
  // sliced later, after the uncapped signal artifact has been preserved.
  const sceneMoments: Moment[] = reviewedScenes.map((sceneScore, idx) => {
    const w = sceneScore.bestClipWindow;
    return {
      id: "scene-" + sceneScore.sceneId,
      rank: idx + 1,
      centerTimeSec: w.centerSec,
      signalOverlap: sceneScore.discoveryScore ?? sceneScore.humorScore,
      suggestedStartSec: w.startSec,
      suggestedEndSec: w.endSec,
      suggestedDurationSec: w.endSec - w.startSec,
      signals: [],
      transcriptSignals: [],
      chatSignals: [],
      audioSignals: [],
      scores: {
        overlapScore: sceneScore.discoveryScore ?? sceneScore.humorScore,
        chatIntensity: sceneScore.chatReactionScore,
        audioMagnitude: sceneScore.audioArcScore,
        viralityScore: sceneScore.discoveryScore ?? sceneScore.humorScore,
        durationSuitability: 0.8,
        eventDensity: sceneScore.chatReactionScore * 0.6 + sceneScore.audioArcScore * 0.4,
        narrativeMomentum: sceneScore.discoveryScore ?? sceneScore.humorScore,
        emotionalPeak: sceneScore.patternConfidence,
        laughDetection: sceneScore.chatReactionScore * 0.7,
        shockReaction: sceneScore.chatReactionScore * 0.3,
        chatSync: sceneScore.chatReactionScore,
        funnyQuote: sceneScore.transcriptQuality,
        reactionChain: 0,
        payoffHold: 0,
        visualQuality: 0,
        calmPenalty: 0,
        composite: sceneScore.discoveryScore ?? sceneScore.humorScore,
      },
      description: sceneScore.description,
      categories: [sceneScore.contentLane, sceneScore.payoffType].concat(sceneScore.llmTags ?? []).filter(Boolean),
      humorPotential: sceneScore.humorScore,
      laughOutLoudScore: sceneScore.laughOutLoudScore ?? 0,
      contentLane: sceneScore.contentLane,
      payoffType: sceneScore.payoffType,
      laneScore: sceneScore.laneScore ?? 0,
      rescueReason: sceneScore.patterns.length > 0
        ? "Patterns: " + sceneScore.patterns.map(p => p.type).join(", ")
        : undefined,
    } as unknown as Moment;
  });

  // ALSO run legacy signal-peak scoring for comparison / fallback
  log.info("Also running legacy signal-peak scoring...");
  (global as any).__STREAM_PATH__ = manifest.videoPath;
  const legacyMoments = scoreAndRankMoments(
    transcriptSignals,
    chatSignals,
    audioSignals,
    manifest.durationSec,
  );
  delete (global as any).__STREAM_PATH__;

  // Merge: prefer scene-based moments, fill gaps with legacy
  const usedWindows = new Set<string>();
  const finalMoments: Moment[] = [];

  for (const m of sceneMoments.slice(0, top)) {
    const key = `${Math.floor(m.suggestedStartSec / 5)}-${Math.floor(m.suggestedEndSec / 5)}`;
    if (!usedWindows.has(key)) {
      usedWindows.add(key);
      finalMoments.push(m);
    }
  }

  // If LLM review ran, zero picks is valid. Do not refill a weak shortlist
  // with legacy activity spikes that never cleared the comedy floor.
  if (llmResults.size === 0) {
    for (const m of legacyMoments) {
      const key = `${Math.floor(m.suggestedStartSec / 5)}-${Math.floor(m.suggestedEndSec / 5)}`;
      if (!usedWindows.has(key) && finalMoments.length < top) {
        usedWindows.add(key);
        finalMoments.push(m);
      }
    }
  }

  const selectedSceneCount = finalMoments.filter((moment) => moment.id.startsWith("scene-")).length;
  log.info(`Final: ${finalMoments.length} moments (${selectedSceneCount} scene-based + ${finalMoments.length - selectedSceneCount} legacy fallback)`);

  const signalRecall: Moment[] = [];
  const recallWindows = new Set<string>();
  for (const moment of [...sceneMoments, ...legacyMoments]) {
    const key = `${Math.floor(moment.suggestedStartSec / 5)}-${Math.floor(moment.suggestedEndSec / 5)}`;
    if (recallWindows.has(key)) continue;
    recallWindows.add(key);
    signalRecall.push(moment);
  }
  const signalRecallPath = join(streamDir, "signal-recall.json");
  writeFileSync(signalRecallPath, JSON.stringify(signalRecall, null, 2), "utf-8");
  log.info(`Saved ${signalRecall.length} uncapped signal anchors to ${signalRecallPath}`);

  // Save moments
  const momentsPath = join(streamDir, "moments.json");
  writeFileSync(momentsPath, JSON.stringify(finalMoments, null, 2), "utf-8");
  manifest.momentsPath = momentsPath;
  if (manifest.phase === "downloaded") manifest.phase = "analyzed";
  saveManifest(manifest);
  log.info(`Saved ${finalMoments.length} moments to ${momentsPath}`);

  // Save scene scores for debugging
  const scenesPath = join(streamDir, "scene-scores.json");
  writeFileSync(scenesPath, JSON.stringify(sceneScores.slice(0, 20), null, 2), "utf-8");
  log.info(`Saved top 20 scene scores to ${scenesPath}`);

  // Display results
  if (json) {
    console.log(JSON.stringify(finalMoments.slice(0, top), null, 2));
    return;
  }

  displayMoments(finalMoments, manifest.title, manifest.durationSec, top);

  log.info(
    `Run \`npx tsx packages/clips/src/clip.ts --stream ${streamId} --moments 1,2,5\` to clip selected moments`,
  );
}

main().catch((err) => {
  log.error("Analysis failed:", err);
  process.exit(1);
});
