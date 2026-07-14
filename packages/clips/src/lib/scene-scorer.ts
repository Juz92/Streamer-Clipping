/**
 * scene-scorer.ts — Score scenes by humor potential using detected patterns.
 *
 * Replaces the old signal-peak scoring with scene-level humor analysis:
 *   1. Segment stream into scenes
 *   2. Detect humor patterns within each scene
 *   3. Score scenes by pattern confidence + chat reaction magnitude + audio arc quality
 *   4. Extract best 30s clip from top-scoring scenes
 */

import type { Scene } from "./scene-segmenter.js";
import type { HumorPattern } from "./humor-patterns.js";
import { detectHumorPatterns } from "./humor-patterns.js";

export interface SceneScore {
  sceneId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  humorScore: number; // 0-1, comedy composite
  laughOutLoudScore?: number; // 0-1, LLM-estimated audible-laugh likelihood
  contentLane?: string;
  payoffType?: string;
  laneScore?: number;
  discoveryScore?: number;
  llmTags?: string[];
  patterns: HumorPattern[];
  patternConfidence: number; // max pattern confidence
  chatReactionScore: number; // 0-1, based on laugh/shock hits + rate change
  audioArcScore: number; // 0-1, based on valley→peak quality
  transcriptQuality: number; // 0-1, based on keyword density + exclamation
  compositeRank: number;
  /** Best 30s window within this scene for clip extraction */
  bestClipWindow: { startSec: number; endSec: number; centerSec: number };
  description: string;
}

/* ── SCORING FUNCTIONS ── */

function scoreChatReaction(scene: Scene): number {
  const { chat } = scene;
  if (chat.messageCount === 0) return 0;

  // Base score from laugh + shock hits
  const reactionHits = chat.laughHits + chat.shockHits;
  const hitScore = Math.min(reactionHits / 8, 1.0); // 8+ hits = max

  // Bonus for dead→eruption arc (biggest indicator of viral moment)
  const arcBonus = chat.hasDeadToEruption ? 0.3 : 0;

  // Rate change score
  const rateChange = chat.maxRate - chat.meanRate;
  const rateScore = Math.min(rateChange / 5, 1.0) * 0.3;

  return Math.min(hitScore * 0.5 + arcBonus + rateScore, 1.0);
}

function scoreAudioArc(scene: Scene): number {
  const { audio } = scene;
  if (audio.rmsRange < 10) return 0.1; // flat audio = boring

  // Range score
  const rangeScore = Math.min(audio.rmsRange / 30, 1.0) * 0.4;

  // Valley→peak bonus
  const arcBonus = audio.hasValleyToPeak ? 0.4 : 0;

  // Max loudness score (must be loud enough to be engaging)
  const loudnessScore = audio.maxRms > -25 ? 0.2 : audio.maxRms > -35 ? 0.1 : 0;

  return Math.min(rangeScore + arcBonus + loudnessScore, 1.0);
}

/* ── SUSTAINED ENERGY SCORING ── */
// Viral clips are sustained arcs, not single peaks. 30s of medium excitement > 3s of screaming.
function scoreSustainedEnergy(scene: Scene): number {
  const { audio, chat } = scene;
  const duration = scene.durationSec;

  // Short scenes can't have sustained energy
  if (duration < 10) return 0;

  // Calculate "energy density" — how much of the scene is above baseline
  const samples = scene.samples;
  if (samples.length === 0) return 0;

  // Count samples above various thresholds
  let aboveNeg35 = 0;
  let aboveNeg30 = 0;
  let aboveNeg25 = 0;
  for (const s of samples) {
    if (s.rmsLevel > -35) aboveNeg35++;
    if (s.rmsLevel > -30) aboveNeg30++;
    if (s.rmsLevel > -25) aboveNeg25++;
  }

  const totalSamples = samples.length;
  const density35 = aboveNeg35 / totalSamples;
  const density30 = aboveNeg30 / totalSamples;
  const density25 = aboveNeg25 / totalSamples;

  // Sustained energy score: prefers 20-60s scenes with consistent medium-high energy
  // NOT 5s of peak energy — that's a single moment, not a sustained arc
  const durationBonus = duration >= 20 && duration <= 60 ? 0.15 : duration > 60 ? 0.05 : 0;

  // Energy density: 40%+ of scene above -35dB = sustained engagement
  const energyScore = density35 * 0.3 + density30 * 0.25 + density25 * 0.2;

  // Chat sustained engagement: messages spread across scene, not just one burst
  const chatSpread = chat.messageCount > 0 ? Math.min(chat.messageCount / (duration / 5), 1.0) * 0.2 : 0;

  // Penalty for "single spike" scenes — 90%+ of energy in <20% of duration
  const spikeRatio = density25 > 0 ? density25 / (density35 + 0.01) : 0;
  const singleSpikePenalty = spikeRatio > 0.8 ? -0.15 : 0;

  return Math.min(energyScore + durationBonus + chatSpread + singleSpikePenalty, 1.0);
}

function scoreTranscriptQuality(scene: Scene): number {
  const { transcript } = scene;
  if (transcript.wordCount === 0) return 0;

  // Keyword density (humor-specific words per minute)
  const keywordsPerMin = transcript.topKeywords.length / (transcript.wordCount / 120); // 120 wpm approx
  const keywordScore = Math.min(keywordsPerMin * 0.3, 0.4);

  // Exclamation/question marks = energy
  const punctuationScore = (transcript.hasExclamation ? 0.2 : 0) + (transcript.hasQuestion ? 0.1 : 0);

  // Speaker changes = dynamic conversation
  const speakerScore = Math.min(transcript.speakerChanges / 3, 0.3);

  return Math.min(keywordScore + punctuationScore + speakerScore, 1.0);
}

function findBestClipWindow(scene: Scene, patterns: HumorPattern[]): { startSec: number; endSec: number; centerSec: number } {
  // Default: center on highest-confidence pattern's payoff
  let centerSec = scene.startSec + scene.durationSec / 2;

  if (patterns.length > 0) {
    const bestPattern = patterns.reduce((a, b) => (a.confidence > b.confidence ? a : b));
    centerSec = bestPattern.payoffTimeSec;
  }

    // NEW: Tighter clip windows for viral Shorts
    // Default: 18-22s, not 30s. Viral clips are punchy.
    let startSec = Math.max(centerSec - 11, scene.startSec);
    let endSec = Math.min(centerSec + 11, scene.endSec);

    // If at edges, shift to fit
    if (endSec - startSec < 22) {
      if (startSec === scene.startSec) {
        endSec = Math.min(startSec + 22, scene.endSec);
      } else if (endSec === scene.endSec) {
        startSec = Math.max(endSec - 22, scene.startSec);
      }
    }

    // NEW: Flash must never be in first 8s of the clip (was 10s — tighter)
    const flashTime = patterns.length > 0
      ? patterns.reduce((a, b) => (a.confidence > b.confidence ? a : b)).payoffTimeSec
      : centerSec;

    if (flashTime < startSec + 8) {
      const shift = (startSec + 8) - flashTime;
      startSec += shift;
      endSec += shift;
      // Re-clamp to scene bounds after shift
      if (endSec > scene.endSec) {
        const overshoot = endSec - scene.endSec;
        startSec -= overshoot;
        endSec -= overshoot;
      }
      if (startSec < scene.startSec) {
        const undershoot = scene.startSec - startSec;
        startSec += undershoot;
        endSec += undershoot;
      }
      centerSec = (startSec + endSec) / 2;
    }

    // NEW: Natural endpoint — cut after laugh dies, not mid-sentence
    const reactionTailEnd = patterns.length > 0
      ? Math.max(...patterns.map(p => p.payoffTimeSec)) + 4
      : endSec;

    if (reactionTailEnd > endSec && reactionTailEnd <= scene.endSec) {
      endSec = reactionTailEnd;
      centerSec = (startSec + endSec) / 2;
    }

    // NEW: Cap clip duration at 28s max — viral Shorts are tight
    if (endSec - startSec > 28) {
      endSec = startSec + 28;
      centerSec = (startSec + endSec) / 2;
    }

    // NEW: Minimum clip duration 12s — shorter than that is usually a false positive
    if (endSec - startSec < 12) {
      endSec = Math.min(startSec + 12, scene.endSec);
      centerSec = (startSec + endSec) / 2;
    }

  centerSec = (startSec + endSec) / 2;

  return { startSec, endSec, centerSec };
}

/* ── MAIN EXPORT ── */
export function scoreScenes(scenes: Scene[]): SceneScore[] {
  const scores: SceneScore[] = [];

  for (const scene of scenes) {
    const patterns = detectHumorPatterns(scene);
    const patternConfidence = patterns.length > 0
      ? Math.max(...patterns.map(p => p.confidence))
      : 0;

    const chatReactionScore = scoreChatReaction(scene);
    const audioArcScore = scoreAudioArc(scene);
    const transcriptQualityScore = scoreTranscriptQuality(scene);

    // Composite: REPETITION and SOCIAL DYNAMICS are king for this channel
    // Viral formula from hit analysis: repetition loops + betrayal/panic + sustained chaos
    const hasRepetitionLoop = patterns.some(p => p.description.includes("Repetition loop") || p.description.includes("repetition"));
    const hasFriendlyBetrayal = patterns.some(p => p.type === "roast" || p.description.includes("betrayal") || p.description.includes("panic"));
    const hasChatRoast = patterns.some(p => p.type === "roast" && p.description.includes("Chat roast"));
    const hasSilenceExplosion = patterns.some(p => p.type === "setup-punchline" && p.description.includes("Silence→Explosion"));
    const hasCalmStorm = patterns.some(p => p.description.includes("Calm→Storm"));
    const sustainedEnergyScore = scoreSustainedEnergy(scene);

    // MASSIVE bonuses for proven viral patterns (from 6 hit analysis)
    const repetitionBonus = hasRepetitionLoop ? 0.20 : 0;      // Repetition = #1 signal
    const betrayalBonus = hasFriendlyBetrayal ? 0.15 : 0;      // Betrayal/panic = #2 signal
    const chatRoastBonus = hasChatRoast ? 0.10 : 0;            // Chat roast = strong
    const calmStormBonus = hasCalmStorm || hasSilenceExplosion ? 0.08 : 0;

    // Demote generic pattern confidence — hits aren't "structured jokes"
    // Promote chat reaction (social proof) and sustained energy (arc quality)
    const humorScore = Math.min(
      patternConfidence * 0.20 +        // Reduced from 0.35 — abstract patterns less important
      chatReactionScore * 0.30 +        // Increased — chat energy is social proof
      audioArcScore * 0.08 +            // Reduced — audio alone doesn't viral
      transcriptQualityScore * 0.05 +   // Reduced — keyword density irrelevant
      sustainedEnergyScore * 0.20 +     // Increased — sustained arcs are the format
      repetitionBonus +
      betrayalBonus +
      chatRoastBonus +
      calmStormBonus,
      1.0,
    );

    const bestClipWindow = findBestClipWindow(scene, patterns);

    // Generate description from top pattern
    const topPattern = patterns.length > 0
      ? patterns.reduce((a, b) => (a.confidence > b.confidence ? a : b))
      : null;

    const description = topPattern
      ? `${topPattern.type} (conf=${topPattern.confidence.toFixed(2)}): ${topPattern.description}`
      : `Scene: ${scene.transcript.wordCount} words, ${scene.chat.messageCount} chat msgs, RMS range ${scene.audio.rmsRange.toFixed(1)}dB`;

    scores.push({
      sceneId: scene.id,
      startSec: scene.startSec,
      endSec: scene.endSec,
      durationSec: scene.durationSec,
      humorScore,
      patterns,
      patternConfidence,
      chatReactionScore,
      audioArcScore,
      transcriptQuality: transcriptQualityScore,
      compositeRank: 0, // filled after sort
      bestClipWindow,
      description,
    });
  }

  // Sort by humor score descending
  scores.sort((a, b) => b.humorScore - a.humorScore);

  // Assign ranks
  for (let i = 0; i < scores.length; i++) {
    scores[i].compositeRank = i + 1;
  }

  return scores;
}

/** Get top N scenes for clip extraction */
export function getTopScenes(scores: SceneScore[], n = 12): SceneScore[] {
  return scores.slice(0, n);
}
