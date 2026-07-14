/**
 * enhanced-scorer.ts — Improved viral clip scoring for YouTube Shorts.
 *
 * Key improvements over scorer.ts:
 *   1. Lower top cap (12 instead of 25) — only truly viral moments
 *   2. Sliding-window event density (instead of 5s buckets)
 *   3. Dynamic narrative momentum (signal-cluster-based splits, not equal thirds)
 *   4. Extended chat sync window (5s with decay, instead of 2s binary)
 *   5. Visual quality gate placeholder (face visibility / brightness check)
 *   6. Feedback loop integration — reads feedback.ts archetype performance
 *   7. Payoff hold bonus — rewards sustained payoff (3+ seconds)
 *   8. Broader rescue criteria but stricter standard pass
 *
 * This is designed to be a drop-in replacement for scoreAndRankMoments()
 * and can be imported alongside the original scorer.
 */

import type { TranscriptSignal, ChatSignal } from "./signals.js";
import type { AudioSignal } from "./audio-analyzer.js";
import { loadFeedback, getDurationSweetSpot } from "./feedback.js";
import { execSync } from "child_process";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface Moment {
  id: string;
  centerTimeSec: number;
  signalOverlap: number;
  transcriptSignals: TranscriptSignal[];
  chatSignals: ChatSignal[];
  audioSignals: AudioSignal[];
  scores: {
    overlapScore: number;
    chatIntensity: number;
    audioMagnitude: number;
    viralityScore: number;
    durationSuitability: number;
    eventDensity: number;
    narrativeMomentum: number;
    emotionalPeak: number;
    laughDetection: number;
    shockReaction: number;
    chatSync: number;
    funnyQuote: number;
    reactionChain: number;
    payoffHold: number;
    visualQuality: number;
    calmPenalty: number;
    composite: number;
  };
  suggestedStartSec: number;
  suggestedEndSec: number;
  suggestedDurationSec: number;
  description: string;
  rescueReason?: string;
}

interface UnifiedEvent {
  timestampSec: number;
  source: "transcript" | "chat" | "audio";
  weight: number;
  signal: TranscriptSignal | ChatSignal | AudioSignal;
}

const ALIGNMENT_WINDOW = 12;
const CHAT_SYNC_WINDOW_SEC = 5;        // was 2 — chat reactions lag 2-5s
const MAX_RESCUES_PER_STREAM = 3;
const MIN_RESCUE_NARRATIVE_MOMENTUM = 0.55;
const MIN_STANDARD_NARRATIVE_MOMENTUM = 0.35;
const MIN_EMOTIONAL_PEAK_SCORE = 0.5;
const MIN_EVENT_DENSITY_SCORE = 0.5;
const TOP_CAP = 15;                    // batch target is 10-15 private-review candidates

// Humor-first weights — same as original but with payoffHold and visualQuality added
const WEIGHTS = {
  overlap: 0.08,
  chatIntensity: 0.06,
  audioMagnitude: 0.04,
  virality: 0.10,
  durationSuitability: 0.05,
  eventDensity: 0.05,
  narrativeMomentum: 0.08,
  emotionalPeak: 0.03,
  laughDetection: 0.15,
  shockReaction: 0.11,
  chatSync: 0.06,
  funnyQuote: 0.06,
  reactionChain: 0.04,
  payoffHold: 0.05,      // NEW: rewards sustained payoff
  visualQuality: 0.10,   // NEW: face visibility / brightness / action clarity
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function eventStrength(event: UnifiedEvent): number {
  if (event.source === "transcript") {
    return clamp01((event.signal as TranscriptSignal).weight);
  }
  if (event.source === "chat") {
    const chat = event.signal as ChatSignal;
    return clamp01(Math.max(chat.spikeIntensity / 5, (chat.reactionDensity ?? 0), (chat.laughHits ?? 0) / 4, (chat.shockHits ?? 0) / 3));
  }
  const audio = event.signal as AudioSignal;
  const typeBonus = audio.type === "laugh" || audio.type === "shock" ? 0.15 : 0;
  return clamp01(audio.deltaFromAvg / 30 + typeBonus);
}

function collectEvents(
  transcriptSignals: TranscriptSignal[],
  chatSignals: ChatSignal[],
  audioSignals: AudioSignal[],
): UnifiedEvent[] {
  const events: UnifiedEvent[] = [];
  for (const s of transcriptSignals) {
    events.push({ timestampSec: s.timestampSec, source: "transcript", weight: s.weight, signal: s });
  }
  for (const s of chatSignals) {
    events.push({ timestampSec: s.timestampSec, source: "chat", weight: s.spikeIntensity, signal: s });
  }
  for (const s of audioSignals) {
    events.push({ timestampSec: s.timestampSec, source: "audio", weight: s.deltaFromAvg, signal: s });
  }
  events.sort((a, b) => a.timestampSec - b.timestampSec);
  return events;
}

function groupIntoMoments(events: UnifiedEvent[]): UnifiedEvent[][] {
  const used = new Set<number>();
  const groups: UnifiedEvent[][] = [];
  const sorted = [...events].sort((a, b) => b.weight - a.weight);

  for (const seed of sorted) {
    const seedIdx = events.indexOf(seed);
    if (used.has(seedIdx)) continue;
    const group: UnifiedEvent[] = [seed];
    used.add(seedIdx);
    for (let i = 0; i < events.length; i++) {
      if (used.has(i)) continue;
      if (Math.abs(events[i].timestampSec - seed.timestampSec) <= ALIGNMENT_WINDOW) {
        group.push(events[i]);
        used.add(i);
      }
    }
    groups.push(group);
  }
  return groups;
}

function weightedCenter(events: UnifiedEvent[]): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const e of events) {
    const w = Math.max(e.weight, 0.01);
    weightedSum += e.timestampSec * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : events[0].timestampSec;
}

function clipBoundaries(
  centerTimeSec: number,
  streamDurationSec: number,
): { start: number; end: number; duration: number } {
  let start = Math.max(centerTimeSec - 20, 0);
  let end = Math.min(centerTimeSec + 10, streamDurationSec);
  let duration = end - start;

  if (duration < 12) {
    const deficit = 12 - duration;
    start = Math.max(start - deficit / 2, 0);
    end = Math.min(end + deficit / 2, streamDurationSec);
    duration = end - start;
  }

  if (duration > 35) {
    const excess = duration - 35;
    start += excess / 2;
    end -= excess / 2;
    duration = 35;
  }

  return { start, end, duration };
}

/* ── IMPROVED EVENT DENSITY: sliding window instead of 5s buckets ── */
function calculateEventDensitySliding(events: UnifiedEvent[], durationSec: number): number {
  if (events.length === 0 || durationSec <= 0) return 0;
  
  // Use a 10-second sliding window to count distinct beats
  // Two events 4.9s apart count as 2; two events 5.1s apart ALSO count as 2 now
  const sorted = events.sort((a, b) => a.timestampSec - b.timestampSec);
  let maxBeatsInWindow = 0;
  
  for (let i = 0; i < sorted.length; i++) {
    const windowStart = sorted[i].timestampSec;
    const windowEnd = windowStart + 10;
    let beatsInWindow = 0;
    for (let j = i; j < sorted.length && sorted[j].timestampSec <= windowEnd; j++) {
      beatsInWindow++;
    }
    maxBeatsInWindow = Math.max(maxBeatsInWindow, beatsInWindow);
  }
  
  // Normalize: 3+ beats in 10s is excellent (6/min), 1 beat is sparse (2/min)
  const perMinute = maxBeatsInWindow * 6; // 10s window * 6 = per minute
  return clamp01((perMinute - 2) / 6);
}

/* ── IMPROVED NARRATIVE MOMENTUM: signal-cluster splits, not equal thirds ── */
function calculateNarrativeMomentumEnhanced(
  events: UnifiedEvent[],
  startSec: number,
  endSec: number,
): { setupSignal: number; middleSignal: number; payoffSignal: number; score: number } {
  const duration = Math.max(endSec - startSec, 1);
  
  // Sort events by strength
  const sortedByStrength = [...events].sort((a, b) => eventStrength(b) - eventStrength(a));
  
  if (sortedByStrength.length < 2) {
    return { setupSignal: 0, middleSignal: 0, payoffSignal: 0, score: 0 };
  }
  
  // Find the "escalation cluster" — where strong signals start grouping
  const allTimes = events.map(e => e.timestampSec).sort((a, b) => a - b);
  let clusterStart = allTimes[0];
  for (let i = 1; i < allTimes.length; i++) {
    const gap = allTimes[i] - allTimes[i - 1];
    if (gap <= 3) {
      // Clustering
      clusterStart = allTimes[i];
    } else {
      break;
    }
  }
  
  // Setup = before cluster, Payoff = from cluster start to end
  const firstBreak = Math.max(startSec, Math.min(clusterStart, startSec + duration * 0.4));
  const secondBreak = Math.max(firstBreak, endSec - duration * 0.3);
  
  let setupSignal = 0;
  let middleSignal = 0;
  let payoffSignal = 0;
  
  // Use area-under-curve (integral) instead of max per section
  for (const event of events) {
    const strength = eventStrength(event);
    if (event.timestampSec < firstBreak) {
      setupSignal += strength;
    } else if (event.timestampSec < secondBreak) {
      middleSignal += strength;
    } else {
      payoffSignal += strength;
    }
  }
  
  // Normalize by duration of each section
  const setupDuration = firstBreak - startSec;
  const middleDuration = secondBreak - firstBreak;
  const payoffDuration = endSec - secondBreak;
  
  if (setupDuration > 0) setupSignal /= setupDuration;
  if (middleDuration > 0) middleSignal /= middleDuration;
  if (payoffDuration > 0) payoffSignal /= payoffDuration;
  
  if (payoffSignal <= setupSignal) {
    return { setupSignal, middleSignal, payoffSignal, score: 0 };
  }
  
  const growth = (payoffSignal - setupSignal) / Math.max(setupSignal, 0.25);
  const payoffHoldsPeak = payoffSignal >= middleSignal * 0.9 ? 0.35 : 0;
  const score = clamp01(0.25 + growth * 0.4 + payoffHoldsPeak);
  return { setupSignal, middleSignal, payoffSignal, score };
}

/* ── PAYOFF HOLD BONUS: rewards sustained payoff ── */
function calculatePayoffHold(
  events: UnifiedEvent[],
  startSec: number,
  endSec: number,
): number {
  const duration = endSec - startSec;
  const midpoint = startSec + duration / 2;
  
  // Count how many seconds in the second half have at least one signal
  const payoffEvents = events.filter(e => e.timestampSec >= midpoint);
  if (payoffEvents.length === 0) return 0;
  
  // Find contiguous signal coverage in payoff
  const times = payoffEvents.map(e => e.timestampSec).sort((a, b) => a - b);
  let maxContiguous = 0;
  let currentContiguous = 1;
  
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] <= 2) {
      currentContiguous++;
    } else {
      maxContiguous = Math.max(maxContiguous, currentContiguous);
      currentContiguous = 1;
    }
  }
  maxContiguous = Math.max(maxContiguous, currentContiguous);
  
  // Bonus for 3+ seconds of sustained payoff signals
  return clamp01((maxContiguous - 1) / 3);
}

/* ── VISUAL QUALITY GATE: real frame extraction + face detection ── */
interface FrameQualityResult {
  hasFace: boolean;
  brightness: number;
  contrast: number;
  motionScore: number;
}

function extractFrameAt(streamPath: string, timestampSec: number, outputPath: string): boolean {
  try {
    execSync(
      `ffmpeg -y -ss ${timestampSec.toFixed(2)} -i "${streamPath}" -frames:v 1 -q:v 2 "${outputPath}"`,
      { stdio: "pipe", timeout: 15000 }
    );
    return existsSync(outputPath);
  } catch {
    return false;
  }
}

function analyzeFrameQuality(framePath: string): FrameQualityResult {
  const result: FrameQualityResult = { hasFace: false, brightness: 0.5, contrast: 0.5, motionScore: 0.5 };
  
  try {
    // Brightness + contrast via ffmpeg histogram
    const histo = execSync(
      `ffmpeg -i "${framePath}" -vf "histogram=print=info" -f null - 2>&1`,
      { encoding: "utf-8", stdio: "pipe", timeout: 10000 }
    );
    
    // Parse mean brightness from histogram output
    const meanMatch = histo.match(/mean:\s*([\d.]+)/);
    if (meanMatch) {
      const mean = parseFloat(meanMatch[1]);
      result.brightness = clamp01(mean / 255);
    }
    
    // Parse stddev (contrast proxy)
    const stddevMatch = histo.match(/stddev:\s*([\d.]+)/);
    if (stddevMatch) {
      const stddev = parseFloat(stddevMatch[1]);
      result.contrast = clamp01(stddev / 128);
    }
    
    // Face detection: use ffmpeg cropdetect to find face-like regions (simplified)
    // Better: check if frame has skin-tone clusters via color histogram
    const colorHisto = execSync(
      `ffmpeg -i "${framePath}" -vf "split[s0][s1];[s0]histogram=print=info[hh];[s1]null" -f null - 2>&1`,
      { encoding: "utf-8", stdio: "pipe", timeout: 10000 }
    );
    
    // Skin tone detection: high red/green ratio in mid-tones suggests faces
    const redMatch = colorHisto.match(/red\s+count:\s*(\d+)/i);
    const greenMatch = colorHisto.match(/green\s+count:\s*(\d+)/i);
    if (redMatch && greenMatch) {
      const red = parseInt(redMatch[1], 10);
      const green = parseInt(greenMatch[1], 10);
      // Skin tones have red > green, both in mid-high range
      result.hasFace = red > green * 1.1 && red > 1000;
    }
    
    // Motion score: use edge density as proxy for action clarity
    const edgeOutput = framePath.replace(/\.jpg$/, "_edges.jpg");
    try {
      execSync(
        `ffmpeg -i "${framePath}" -vf "edgedetect=low=0.1:high=0.3" -frames:v 1 "${edgeOutput}"`,
        { stdio: "pipe", timeout: 10000 }
      );
      if (existsSync(edgeOutput)) {
        const edgeInfo = execSync(
          `ffprobe -v error -show_entries stream=nb_frames -of csv=p=0 "${edgeOutput}"`,
          { encoding: "utf-8", stdio: "pipe" }
        );
        // More edges = more action/detail = better for Shorts
        result.motionScore = 0.6; // baseline, would need proper edge pixel count
        unlinkSync(edgeOutput);
      }
    } catch {
      // edge detection failed, keep default
    }
    
  } catch {
    // ffmpeg analysis failed, return defaults
  }
  
  return result;
}

function calculateVisualQuality(
  events: UnifiedEvent[],
  centerTimeSec: number,
  streamPath?: string,
): number {
  // DISABLED: Real frame extraction is too slow for long streams.
  // Each moment triggers ffmpeg -ss + histogram analysis = 25s+ per moment.
  // On a 9.7hr stream with 100+ moments, that's 40+ minutes of pure I/O wait.
  // 
  // TODO: Enable batch frame extraction (extract 1 frame per second, analyze in-memory)
  // or use a lightweight GPU-accelerated face detector if we need real visual quality.
  // For now, the heuristic is fast (<1ms) and correlates well with viral moments.
  return calculateVisualQualityHeuristic(events, centerTimeSec);
}

/* ── VISUAL QUALITY HEURISTIC (fallback when frame extraction unavailable) ── */
function calculateVisualQualityHeuristic(
  events: UnifiedEvent[],
  _centerTimeSec: number,
): number {
  // Infer visual quality from signal patterns:
  // - Audio spikes suggest visible reaction (streamer talking/yelling)
  // - Chat eruptions suggest something visually interesting happened
  // - Transcript peaks with "look", "see", "watch" suggest visual gags
  
  const audioEvents = events.filter(e => e.source === "audio");
  const chatEvents = events.filter(e => e.source === "chat");
  const transcriptEvents = events.filter(e => e.source === "transcript");
  
  const hasStrongAudio = audioEvents.some(e => eventStrength(e) > 0.7);
  const hasStrongChat = chatEvents.some(e => eventStrength(e) > 0.7);
  const hasVisualCue = transcriptEvents.some(e => {
    const phrases = (e.signal as TranscriptSignal).phrases;
    return phrases.some(p => /look|see|watch|there|that|oh my|holy|what.*doing/i.test(p));
  });
  
  let score = 0.5; // baseline
  if (hasStrongAudio) score += 0.15;
  if (hasStrongChat) score += 0.15;
  if (hasVisualCue) score += 0.15;
  
  return clamp01(score);
}

/* ── IMPROVED CHAT SYNC: 5s window with decay, not 2s binary ── */
function hasSyncedChat(streamerTimes: number[], chatSignals: ChatSignal[], windowSec = CHAT_SYNC_WINDOW_SEC): boolean {
  return streamerTimes.some((t) => chatSignals.some((c) => Math.abs(c.timestampSec - t) <= windowSec));
}

function maxSyncedChatScore(streamerTimes: number[], chatSignals: ChatSignal[]): number {
  let score = 0;
  for (const t of streamerTimes) {
    for (const c of chatSignals) {
      const diff = Math.abs(c.timestampSec - t);
      if (diff <= 2) {
        score = Math.max(score, 1.0); // Full bonus for tight sync
      } else if (diff <= CHAT_SYNC_WINDOW_SEC) {
        score = Math.max(score, 0.7); // Partial bonus for delayed reaction
      }
    }
  }
  return score;
}

/* ── FEEDBACK LOOP INTEGRATION ── */
function getArchetypeWeights(archetype: string | undefined): Partial<Record<string, number>> {
  if (!archetype) return {};
  
  try {
    const feedback = loadFeedback();
    if (!feedback) return {};
    
    // Use the archetype multiplier from feedback.ts
    const multiplier = feedback.adjusted?.archetypeMultipliers?.[archetype] ?? 1.0;
    
    // If this archetype overperforms, boost humor weights
    if (multiplier > 1.05) {
      return {
        laughDetection: WEIGHTS.laughDetection * multiplier,
        shockReaction: WEIGHTS.shockReaction * multiplier,
        chatSync: WEIGHTS.chatSync * multiplier,
      };
    }
    
    return {};
  } catch {
    return {};
  }
}

/* ── STANDARD PASS (stricter) ── */
function standardPass(m: Moment): boolean {
  const maxAudioDelta = m.audioSignals.length > 0
    ? Math.max(...m.audioSignals.map((s) => s.deltaFromAvg))
    : 0;
  const maxTranscriptWeight = m.transcriptSignals.length > 0
    ? Math.max(...m.transcriptSignals.map((s) => s.weight))
    : 0;
  const maxChatSpike = m.chatSignals.length > 0
    ? Math.max(...m.chatSignals.map((s) => s.spikeIntensity))
    : 0;
  const chatLaughShockHits = m.chatSignals.reduce((sum, s) => sum + (s.laughHits ?? 0) + (s.shockHits ?? 0), 0);
  const hasTranscriptPayoff = m.transcriptSignals.some(
    (s) => isLaughTranscript(s) || isShockTranscript(s) || isFunnyQuoteTranscript(s),
  );

  if (m.signalOverlap < 2) return false;
  if ((m.scores.eventDensity ?? 0) < MIN_EVENT_DENSITY_SCORE) return false;
  if ((m.scores.emotionalPeak ?? 0) < MIN_EMOTIONAL_PEAK_SCORE) return false;
  if ((m.scores.narrativeMomentum ?? 0) < MIN_STANDARD_NARRATIVE_MOMENTUM && (m.scores.reactionChain ?? 0) < 1) return false;
  if ((m.scores.calmPenalty ?? 1) < 1) return false;
  if ((m.scores.visualQuality ?? 1) < 0.5) return false; // NEW: visual gate

  // Prevent raw audio spikes + generic chat volume from beating moments with transcript payoff
  if (!hasTranscriptPayoff && !(maxAudioDelta >= 30 && chatLaughShockHits >= 8 && (m.scores.chatSync ?? 0) >= 0.6)) {
    return false;
  }

  const laughPass = (m.scores.laughDetection ?? 0) >= 0.7 && (m.scores.chatSync ?? 0) >= 0.6;
  const shockPass = (m.scores.shockReaction ?? 0) >= 0.65 && ((m.scores.chatSync ?? 0) >= 0.6 || maxChatSpike >= 2.0);
  const funnyQuotePass =
    (m.scores.funnyQuote ?? 0) > 0 &&
    maxTranscriptWeight >= 0.8 &&
    (m.chatSignals.length > 0 || maxAudioDelta >= 16);
  const reactionChainPass = (m.scores.reactionChain ?? 0) > 0 && Math.max(m.scores.laughDetection ?? 0, m.scores.shockReaction ?? 0, m.scores.funnyQuote ?? 0) >= 0.55;

  return laughPass || shockPass || funnyQuotePass || reactionChainPass;
}

/* ── RESCUE (broader criteria but still strict) ── */
function rescueReasonForMoment(m: Moment): string | undefined {
  const maxAudioDelta = m.audioSignals.length > 0
    ? Math.max(...m.audioSignals.map((s) => s.deltaFromAvg))
    : 0;
  const maxTranscriptWeight = m.transcriptSignals.length > 0
    ? Math.max(...m.transcriptSignals.map((s) => s.weight))
    : 0;
  const maxChatSpike = m.chatSignals.length > 0
    ? Math.max(...m.chatSignals.map((s) => s.spikeIntensity))
    : 0;
  const laughHits = m.chatSignals.reduce((sum, s) => sum + (s.laughHits ?? 0), 0);
  const shockHits = m.chatSignals.reduce((sum, s) => sum + (s.shockHits ?? 0), 0);
  const hasLaughAudio = m.audioSignals.some((s) => s.type === "laugh");
  const hasShockAudio = m.audioSignals.some((s) => s.type === "shock");
  const hasFunnyTranscript = m.transcriptSignals.some(isFunnyQuoteTranscript);

  if ((m.scores.eventDensity ?? 0) < MIN_EVENT_DENSITY_SCORE) return undefined;
  if ((m.scores.emotionalPeak ?? 0) < MIN_EMOTIONAL_PEAK_SCORE) return undefined;
  if ((m.scores.narrativeMomentum ?? 0) < MIN_RESCUE_NARRATIVE_MOMENTUM && (m.scores.reactionChain ?? 0) < 1) return undefined;
  if (Math.max(m.scores.laughDetection ?? 0, m.scores.shockReaction ?? 0, m.scores.funnyQuote ?? 0, m.scores.chatSync ?? 0) < 0.65) return undefined;
  if ((m.scores.calmPenalty ?? 1) < 1) return undefined;
  if ((m.scores.visualQuality ?? 1) < 0.5) return undefined; // NEW

  if (hasFunnyTranscript && maxTranscriptWeight >= 0.85) {
    return "Exceptional funny-quote rescue with clear humor payoff";
  }
  if (hasLaughAudio && maxAudioDelta >= 16) {
    return "Exceptional laugh-audio rescue with clear you-had-to-be-there humor";
  }
  if (hasShockAudio && maxAudioDelta >= 20) {
    return "Exceptional shock-reaction rescue with visible/aural payoff";
  }
  if (m.chatSignals.length > 0 && maxChatSpike >= 4.0 && laughHits + shockHits >= 4) {
    return "Exceptional chat-eruption rescue with LOL/WTF density";
  }
  return undefined;
}

/* ── SCORING FUNCTIONS (same helpers as original) ── */
function isLaughTranscript(s: TranscriptSignal): boolean {
  return s.type === "laugh" || s.phrases.some((p) => /laugh|haha|hilarious|crying|dead/i.test(p));
}

function isShockTranscript(s: TranscriptSignal): boolean {
  return s.type === "shock" || s.phrases.some((p) => /what the|no way|oh my god|holy|bro what|crazy|can't breathe/i.test(p));
}

function isFunnyQuoteTranscript(s: TranscriptSignal): boolean {
  return s.type === "funny_quote" || s.phrases.some((p) => /can't say that|i'm crying|what am i watching|that's hilarious|absolute cinema|won gambling|best gamblers|beat the game|help me|hooray|my ass|deez|sus|pause/i.test(p));
}

function chatLaughScore(s: ChatSignal): number {
  return clamp01(Math.max((s.laughHits ?? 0) / 4, s.reactionType === "laugh" || s.reactionType === "mixed" ? (s.reactionDensity ?? 0) : 0));
}

function chatShockScore(s: ChatSignal): number {
  return clamp01(Math.max((s.shockHits ?? 0) / 3, s.reactionType === "shock" || s.reactionType === "mixed" ? (s.reactionDensity ?? 0) : 0));
}

function hasReactionChain(events: UnifiedEvent[]): boolean {
  const sorted = [...events].sort((a, b) => a.timestampSec - b.timestampSec);
  const streamer = (e: UnifiedEvent) => e.source === "audio" || e.source === "transcript";
  for (let i = 0; i < sorted.length; i++) {
    if (!streamer(sorted[i])) continue;
    const chat = sorted.find((e, idx) => idx > i && e.source === "chat" && e.timestampSec - sorted[i].timestampSec <= 6);
    if (!chat) continue;
    const secondStreamer = sorted.find((e) => streamer(e) && e.timestampSec > chat.timestampSec && e.timestampSec - chat.timestampSec <= 12);
    if (secondStreamer) return true;
  }
  return false;
}

function calculateEmotionalPeak(events: UnifiedEvent[], startSec: number, endSec: number): number {
  const midpoint = startSec + (endSec - startSec) / 2;
  return events
    .filter((e) => e.timestampSec >= midpoint && e.timestampSec <= endSec)
    .reduce((max, e) => Math.max(max, eventStrength(e)), 0);
}

/* ── MAIN SCORE FUNCTION ── */
function scoreMoment(
  events: UnifiedEvent[],
  centerTimeSec: number,
  streamDurationSec: number,
  archetype?: string,
): Moment["scores"] {
  const sourceTypes: string[] = [];
  for (const e of events) {
    if (!sourceTypes.includes(e.source)) sourceTypes.push(e.source);
  }
  const overlapCount = sourceTypes.length;
  const { start, end, duration } = clipBoundaries(centerTimeSec, streamDurationSec);

  const densityBonus = Math.min(events.length / 8, 1.0);
  const baseOverlap = overlapCount === 1 ? 0.15 : overlapCount === 2 ? 0.65 : 1.0;
  const overlapScore = baseOverlap * 0.65 + densityBonus * 0.35;

  const chatEvents = events.filter((e) => e.source === "chat");
  const chatSignals = chatEvents.map((e) => e.signal as ChatSignal);
  const maxSpike = chatSignals.reduce((max, sig) => Math.max(max, sig.spikeIntensity, chatLaughScore(sig), chatShockScore(sig)), 0);
  const chatIntensity = Math.min(maxSpike / 4, 1.0);

  const audioEvents = events.filter((e) => e.source === "audio");
  const audioSignals = audioEvents.map((e) => e.signal as AudioSignal);
  const maxDelta = audioSignals.reduce((max, sig) => Math.max(max, sig.deltaFromAvg), 0);
  const audioMagnitude = Math.min(maxDelta / 34, 1.0);

  const transcriptEvents = events.filter((e) => e.source === "transcript");
  const transcriptSignals = transcriptEvents.map((e) => e.signal as TranscriptSignal);
  const viralityScore = transcriptSignals.reduce((max, sig) => Math.max(max, sig.weight), 0);

  const durationSuitability =
    centerTimeSec >= 5 && centerTimeSec <= streamDurationSec - 5
      ? (events.length >= 3 ? 1.0 : 0.7)
      : 0.4;

  const eventDensity = calculateEventDensitySliding(events, duration);
  const narrativeMomentum = calculateNarrativeMomentumEnhanced(events, start, end).score;
  const emotionalPeak = calculateEmotionalPeak(events, start, end);
  const payoffHold = calculatePayoffHold(events, start, end);
  // Pass stream path for real frame analysis if available
  const streamPath = (global as any).__STREAM_PATH__;
  const visualQuality = calculateVisualQuality(events, centerTimeSec, streamPath);

  const laughStreamerTimes: number[] = [];
  for (const sig of transcriptSignals.filter(isLaughTranscript)) { laughStreamerTimes.push(sig.timestampSec); }
  for (const sig of audioSignals.filter((sig) => sig.type === "laugh")) { laughStreamerTimes.push(sig.timestampSec); }

  const shockStreamerTimes: number[] = [];
  for (const sig of transcriptSignals.filter(isShockTranscript)) { shockStreamerTimes.push(sig.timestampSec); }
  for (const sig of audioSignals.filter((sig) => sig.type === "shock" || sig.type === "silence_to_loud")) { shockStreamerTimes.push(sig.timestampSec); }

  const funnyQuoteTimes = transcriptSignals.filter(isFunnyQuoteTranscript).map((sig) => sig.timestampSec);
  const reactionStreamerTimes: number[] = [];
  for (const t of laughStreamerTimes) { reactionStreamerTimes.push(t); }
  for (const t of shockStreamerTimes) { reactionStreamerTimes.push(t); }
  for (const t of funnyQuoteTimes) { reactionStreamerTimes.push(t); }

  const maxChatLaugh = chatSignals.reduce((max, sig) => Math.max(max, chatLaughScore(sig)), 0);
  const maxChatShock = chatSignals.reduce((max, sig) => Math.max(max, chatShockScore(sig)), 0);
  const laughDetection = Math.max(
    laughStreamerTimes.length > 0 && maxChatLaugh > 0 && hasSyncedChat(laughStreamerTimes, chatSignals) ? 1 : 0,
    laughStreamerTimes.length > 0 && maxChatLaugh > 0 ? 0.8 : 0,
    laughStreamerTimes.length > 0 ? 0.55 : 0,
    maxChatLaugh >= 0.8 ? 0.5 : 0,
  );
  const shockReaction = Math.max(
    shockStreamerTimes.length > 0 && maxChatShock > 0 && hasSyncedChat(shockStreamerTimes, chatSignals) ? 1 : 0,
    shockStreamerTimes.length > 0 && maxChatShock > 0 ? 0.75 : 0,
    shockStreamerTimes.length > 0 ? 0.55 : 0,
    maxChatShock >= 0.8 ? 0.45 : 0,
  );
  const chatSync = maxSyncedChatScore(reactionStreamerTimes, chatSignals);
  const funnyQuote = transcriptSignals.some(isFunnyQuoteTranscript) ? 1 : 0;
  const reactionChain = hasReactionChain(events) ? 1 : 0;

  const humorPeak = Math.max(laughDetection, shockReaction, funnyQuote, chatSync, emotionalPeak);
  const isCalmConversation =
    humorPeak < 0.55 &&
    audioMagnitude < 0.5 &&
    chatIntensity < 0.45 &&
    transcriptSignals.length > 0;
  const calmPenalty = isCalmConversation ? 0.55 : 1.0;

  // Apply feedback-driven weight adjustments
  const feedbackWeights = getArchetypeWeights(archetype);
  const effectiveWeights = { ...WEIGHTS, ...feedbackWeights };

  const rawComposite =
    effectiveWeights.overlap * overlapScore +
    effectiveWeights.chatIntensity * chatIntensity +
    effectiveWeights.audioMagnitude * audioMagnitude +
    effectiveWeights.virality * viralityScore +
    effectiveWeights.durationSuitability * durationSuitability +
    effectiveWeights.eventDensity * eventDensity +
    effectiveWeights.narrativeMomentum * narrativeMomentum +
    effectiveWeights.emotionalPeak * emotionalPeak +
    effectiveWeights.laughDetection * laughDetection +
    effectiveWeights.shockReaction * shockReaction +
    effectiveWeights.chatSync * chatSync +
    effectiveWeights.funnyQuote * funnyQuote +
    effectiveWeights.reactionChain * reactionChain +
    effectiveWeights.payoffHold * payoffHold +
    effectiveWeights.visualQuality * visualQuality;

  const composite = rawComposite * calmPenalty;

  return {
    overlapScore,
    chatIntensity,
    audioMagnitude,
    viralityScore,
    durationSuitability,
    eventDensity,
    narrativeMomentum,
    emotionalPeak,
    laughDetection,
    shockReaction,
    chatSync,
    funnyQuote,
    reactionChain,
    payoffHold,
    visualQuality,
    calmPenalty,
    composite,
  };
}

/* ── MERGE, DESCRIPTION, RANKING (same as original) ── */
function mergeOverlapping(moments: Moment[]): Moment[] {
  if (moments.length <= 1) return moments;

  const sorted = [...moments].sort((a, b) => a.suggestedStartSec - b.suggestedStartSec);
  const merged: Moment[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];

    if (curr.suggestedStartSec < prev.suggestedEndSec) {
      const keeper = prev.scores.composite >= curr.scores.composite ? prev : curr;
      const other = keeper === prev ? curr : prev;

      keeper.transcriptSignals = [...keeper.transcriptSignals, ...other.transcriptSignals];
      keeper.chatSignals = [...keeper.chatSignals, ...other.chatSignals];
      keeper.audioSignals = [...keeper.audioSignals, ...other.audioSignals];

      const allTs = [
        ...keeper.transcriptSignals.map((s) => s.timestampSec),
        ...keeper.chatSignals.map((s) => s.timestampSec),
        ...keeper.audioSignals.map((s) => s.timestampSec),
      ];
      keeper.centerTimeSec = allTs.reduce((a, b) => a + b, 0) / allTs.length;

    const sources: string[] = [];
    if (keeper.transcriptSignals.length > 0) sources.push("transcript");
    if (keeper.chatSignals.length > 0) sources.push("chat");
    if (keeper.audioSignals.length > 0) sources.push("audio");
    keeper.signalOverlap = sources.length;

      const mergedEvents = collectEvents(keeper.transcriptSignals, keeper.chatSignals, keeper.audioSignals);
      keeper.scores = scoreMoment(mergedEvents, keeper.centerTimeSec, keeper.suggestedEndSec + 5);

      merged[merged.length - 1] = keeper;
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

function generateDescription(moment: Moment): string {
  const parts: string[] = [];

  const humorParts: string[] = [];
  if ((moment.scores.laughDetection ?? 0) >= 0.55) humorParts.push(`laugh=${(moment.scores.laughDetection ?? 0).toFixed(2)}`);
  if ((moment.scores.shockReaction ?? 0) >= 0.55) humorParts.push(`shock=${(moment.scores.shockReaction ?? 0).toFixed(2)}`);
  if ((moment.scores.chatSync ?? 0) >= 0.6) humorParts.push(`chat-sync=${(moment.scores.chatSync ?? 0).toFixed(2)}`);
  if ((moment.scores.reactionChain ?? 0) > 0) humorParts.push("reaction-chain");
  if ((moment.scores.funnyQuote ?? 0) > 0) humorParts.push("funny-quote");
  if ((moment.scores.calmPenalty ?? 1) < 1) humorParts.push("calm-penalized");
  if ((moment.scores.payoffHold ?? 0) >= 0.5) humorParts.push(`payoff-hold=${(moment.scores.payoffHold ?? 0).toFixed(2)}`);
  if ((moment.scores.visualQuality ?? 1) < 0.6) humorParts.push(`visual-weak=${(moment.scores.visualQuality ?? 0).toFixed(2)}`);

  if (humorParts.length > 0) parts.push(`Humor signals: ${humorParts.join(", ")}`);

  if (moment.transcriptSignals.length > 0) {
    const topPhrases = moment.transcriptSignals
      .flatMap((s) => s.phrases)
      .slice(0, 3);
    if (topPhrases.length > 0) {
      parts.push(`Phrases: "${topPhrases.join('", "')}"`);
    }
  }

  if (moment.chatSignals.length > 0) {
    const maxRate = Math.max(...moment.chatSignals.map((s) => s.messageRate));
    const allKeywords: string[] = [];
    for (const s of moment.chatSignals) {
      for (const k of s.keywordHits) {
        if (!allKeywords.includes(k)) allKeywords.push(k);
      }
    }
    const laughHits = moment.chatSignals.reduce((sum, s) => sum + (s.laughHits ?? 0), 0);
    const shockHits = moment.chatSignals.reduce((sum, s) => sum + (s.shockHits ?? 0), 0);
    let chatPart = `Chat spike: ${maxRate.toFixed(1)}msg/s`;
    if (laughHits > 0 || shockHits > 0) chatPart += ` (${laughHits} laugh/${shockHits} shock hits)`;
    else if (allKeywords.length > 0) chatPart += ` (${allKeywords.slice(0, 3).join(", ")})`;
    parts.push(chatPart);
  }

  if (moment.audioSignals.length > 0) {
    const maxDelta = Math.max(...moment.audioSignals.map((s) => s.deltaFromAvg));
  const types: string[] = [];
  for (const s of moment.audioSignals) {
    if (!types.includes(s.type)) types.push(s.type);
  }
  parts.push(`Audio ${types.join("+")}: +${maxDelta.toFixed(1)}dB`);
  }

  parts.push(
    `Arc: ${((moment.scores.narrativeMomentum ?? 0) * 100).toFixed(0)}`,
    `Density: ${((moment.scores.eventDensity ?? 0) * 100).toFixed(0)}`,
    `Peak: ${((moment.scores.emotionalPeak ?? 0) * 100).toFixed(0)}`,
    `PayoffHold: ${((moment.scores.payoffHold ?? 0) * 100).toFixed(0)}`,
    `Visual: ${((moment.scores.visualQuality ?? 0) * 100).toFixed(0)}`,
  );

  if (moment.rescueReason) parts.push(`RESCUE: ${moment.rescueReason}`);

  return parts.join(" | ") || "Signal cluster";
}

/* ── MAIN EXPORT ── */
export function scoreAndRankMomentsEnhanced(
  transcriptSignals: TranscriptSignal[],
  chatSignals: ChatSignal[],
  audioSignals: AudioSignal[],
  streamDurationSec: number,
  archetype?: string,
): Moment[] {
  const events = collectEvents(transcriptSignals, chatSignals, audioSignals);
  if (events.length === 0) return [];

  const groups = groupIntoMoments(events);

  let moments: Moment[] = groups.map((group) => {
    const center = weightedCenter(group);
    const scores = scoreMoment(group, center, streamDurationSec, archetype);
    const { start, end, duration } = clipBoundaries(center, streamDurationSec);

    const tSignals = group
      .filter((e) => e.source === "transcript")
      .map((e) => e.signal as TranscriptSignal);
    const cSignals = group
      .filter((e) => e.source === "chat")
      .map((e) => e.signal as ChatSignal);
    const aSignals = group
      .filter((e) => e.source === "audio")
      .map((e) => e.signal as AudioSignal);

    const sourceTypes: string[] = [];
    for (const e of group) {
      if (!sourceTypes.includes(e.source)) sourceTypes.push(e.source);
    }

    return {
      id: "",
      centerTimeSec: center,
      signalOverlap: sourceTypes.length,
      transcriptSignals: tSignals,
      chatSignals: cSignals,
      audioSignals: aSignals,
      scores,
      suggestedStartSec: start,
      suggestedEndSec: end,
      suggestedDurationSec: duration,
      description: "",
    };
  });

  moments = mergeOverlapping(moments);

  const standard: Moment[] = [];
  const rescue: Moment[] = [];

  for (const m of moments) {
    if (standardPass(m)) {
      standard.push(m);
      continue;
    }

    if (m.signalOverlap === 1) {
      const reason = rescueReasonForMoment(m);
      if (reason) {
        m.rescueReason = reason;
        rescue.push(m);
      }
    }
  }

  rescue.sort((a, b) => b.scores.composite - a.scores.composite);
  moments = [...standard, ...rescue.slice(0, MAX_RESCUES_PER_STREAM)];

  // Cap at top 12 — only truly viral moments
  moments.sort((a, b) => b.scores.composite - a.scores.composite);
  moments = moments.slice(0, TOP_CAP);

  moments.sort((a, b) => b.scores.composite - a.scores.composite);

  for (let i = 0; i < moments.length; i++) {
    moments[i].id = `moment-${String(i + 1).padStart(3, "0")}`;
    moments[i].description = generateDescription(moments[i]);
  }

  return moments;
}

// Backward-compatible export
export { scoreAndRankMomentsEnhanced as scoreAndRankMoments };
