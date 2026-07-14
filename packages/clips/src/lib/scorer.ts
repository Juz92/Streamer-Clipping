import type { TranscriptSignal, ChatSignal } from "./signals.js";
import type { AudioSignal } from "./audio-analyzer.js";

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
    /** Distinct transcript/chat/audio beats per minute, normalized 0-1. */
    eventDensity?: number;
    /** Setup → middle → payoff escalation, normalized 0-1. */
    narrativeMomentum?: number;
    /** Strongest second-half peak, normalized 0-1. */
    emotionalPeak?: number;
    /** Streamer laughter plus chat laughter, normalized 0-1. */
    laughDetection?: number;
    /** Scream/gasp/physical reaction plus chat shock, normalized 0-1. */
    shockReaction?: number;
    /** Chat eruption aligned with streamer within the same ~2s window. */
    chatSync?: number;
    /** Genuinely quotable/funny line signal, normalized 0-1. */
    funnyQuote?: number;
    /** Streamer reacts → chat reacts → streamer reacts again loop. */
    reactionChain?: number;
    /** Repeated absurd subject/threat/persona bit, e.g. wizard/demons/robots. */
    runningBit?: number;
    /** 1.0 normally; <1.0 means calm-conversation penalty applied. */
    calmPenalty?: number;
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
const CHAT_SYNC_WINDOW_SEC = 2;
const MAX_RESCUES_PER_STREAM = 3;
const MIN_RESCUE_NARRATIVE_MOMENTUM = 0.55;
const MIN_STANDARD_NARRATIVE_MOMENTUM = 0.35;
const MIN_EMOTIONAL_PEAK_SCORE = 0.5;
const MIN_EVENT_DENSITY_SCORE = 0.5;

// Humor-first weights: raw signal noise is no longer enough. The scorer now
// prioritizes laugh/shock evidence, tight chat sync, and reaction loops.
const WEIGHTS = {
  overlap: 0.10,
  chatIntensity: 0.07,
  audioMagnitude: 0.04,
  virality: 0.11,
  durationSuitability: 0.06,
  eventDensity: 0.05,
  narrativeMomentum: 0.08,
  emotionalPeak: 0.03,
  laughDetection: 0.17,
  shockReaction: 0.12,
  chatSync: 0.06,
  funnyQuote: 0.07,
  reactionChain: 0.04,
  runningBit: 0.06,
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
  // Treat the weighted signal center as the likely payoff, not the setup.
  // Give the selector more runway before the peak and less dead-air tail after it.
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

function distinctEventCount(events: UnifiedEvent[]): number {
  // Collapse synchronized detections across sources into one temporal beat.
  // A transcript hit plus chat spike at the same moment is one event, not an arc.
  return new Set(events.map((e) => String(Math.floor(e.timestampSec / 5)))).size;
}

function calculateEventDensity(events: UnifiedEvent[], durationSec: number): number {
  const perMinute = distinctEventCount(events) / Math.max(durationSec / 60, 0.25);
  // Four distinct beats per minute is the floor; six per minute is healthy.
  return clamp01((perMinute - 2) / 4);
}

function calculateNarrativeMomentum(
  events: UnifiedEvent[],
  startSec: number,
  endSec: number,
): { setupSignal: number; middleSignal: number; payoffSignal: number; score: number } {
  const duration = Math.max(endSec - startSec, 1);
  const firstBreak = startSec + duration / 3;
  const secondBreak = startSec + (duration * 2) / 3;
  let setupSignal = 0;
  let middleSignal = 0;
  let payoffSignal = 0;

  for (const event of events) {
    const strength = eventStrength(event);
    if (event.timestampSec < firstBreak) {
      setupSignal = Math.max(setupSignal, strength);
    } else if (event.timestampSec < secondBreak) {
      middleSignal = Math.max(middleSignal, strength);
    } else {
      payoffSignal = Math.max(payoffSignal, strength);
    }
  }

  if (payoffSignal <= setupSignal) {
    return { setupSignal, middleSignal, payoffSignal, score: 0 };
  }

  const growth = (payoffSignal - setupSignal) / Math.max(setupSignal, 0.25);
  const payoffHoldsPeak = payoffSignal >= middleSignal * 0.95 ? 0.35 : 0;
  const score = clamp01(0.25 + growth * 0.4 + payoffHoldsPeak);
  return { setupSignal, middleSignal, payoffSignal, score };
}

function calculateEmotionalPeak(events: UnifiedEvent[], startSec: number, endSec: number): number {
  const midpoint = startSec + (endSec - startSec) / 2;
  return events
    .filter((e) => e.timestampSec >= midpoint && e.timestampSec <= endSec)
    .reduce((max, e) => Math.max(max, eventStrength(e)), 0);
}

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

function hasSyncedChat(streamerTimes: number[], chatSignals: ChatSignal[], windowSec = CHAT_SYNC_WINDOW_SEC): boolean {
  return streamerTimes.some((t) => chatSignals.some((c) => Math.abs(c.timestampSec - t) <= windowSec));
}

function maxSyncedChatScore(streamerTimes: number[], chatSignals: ChatSignal[]): number {
  let score = 0;
  for (const t of streamerTimes) {
    for (const c of chatSignals) {
      const diff = Math.abs(c.timestampSec - t);
      // Justin's feedback was explicit: chat_sync means chat erupts WITH the
      // streamer, not a few seconds later. Keep the full bonus restricted to
      // the same ~2-second window so delayed chat laughter cannot carry a clip.
      if (diff <= CHAT_SYNC_WINDOW_SEC) score = Math.max(score, 1);
    }
  }
  return score;
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

function runningBitScore(transcriptSignals: TranscriptSignal[]): number {
  const terms = transcriptSignals.flatMap((s) =>
    s.phrases
      .filter((p) => p.startsWith("running-bit:"))
      .map((p) => p.slice("running-bit:".length)),
  );
  const cueScore = terms.length === 0 ? 0 : terms.length >= 2 || new Set(terms).size >= 2 ? 1 : 0.75;
  const text = transcriptSignals.map((s) => s.text ?? s.phrases.join(" ")).join(" ").toLowerCase();
  const referenceStyleLine = /(who are these|what did they do|look at him|new to what|going outside|big as a mountain|come get some|my boy|brand new friends|for all the|let him have it)/.test(text) ? 0.85 : 0;
  return clamp01(Math.max(cueScore, referenceStyleLine));
}

function scoreMoment(
  events: UnifiedEvent[],
  centerTimeSec: number,
  streamDurationSec: number,
): Moment["scores"] {
  const sourceTypes = new Set(events.map((e) => e.source));
  const overlapCount = sourceTypes.size;
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

  const eventDensity = calculateEventDensity(events, duration);
  const narrativeMomentum = calculateNarrativeMomentum(events, start, end).score;
  const emotionalPeak = calculateEmotionalPeak(events, start, end);

  const laughStreamerTimes = [
    ...transcriptSignals.filter(isLaughTranscript).map((sig) => sig.timestampSec),
    ...audioSignals.filter((sig) => sig.type === "laugh").map((sig) => sig.timestampSec),
  ];
  const shockStreamerTimes = [
    ...transcriptSignals.filter(isShockTranscript).map((sig) => sig.timestampSec),
    ...audioSignals.filter((sig) => sig.type === "shock" || sig.type === "silence_to_loud").map((sig) => sig.timestampSec),
  ];
  const funnyQuoteTimes = transcriptSignals.filter(isFunnyQuoteTranscript).map((sig) => sig.timestampSec);
  const reactionStreamerTimes = [
    ...laughStreamerTimes,
    ...shockStreamerTimes,
    ...funnyQuoteTimes,
  ];

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
  const runningBit = runningBitScore(transcriptSignals);

  const humorPeak = Math.max(laughDetection, shockReaction, funnyQuote, chatSync, emotionalPeak, runningBit);
  const isCalmConversation =
    humorPeak < 0.55 &&
    audioMagnitude < 0.5 &&
    chatIntensity < 0.45 &&
    transcriptSignals.length > 0;
  const calmPenalty = isCalmConversation ? 0.55 : 1.0;

  const rawComposite =
    WEIGHTS.overlap * overlapScore +
    WEIGHTS.chatIntensity * chatIntensity +
    WEIGHTS.audioMagnitude * audioMagnitude +
    WEIGHTS.virality * viralityScore +
    WEIGHTS.durationSuitability * durationSuitability +
    WEIGHTS.eventDensity * eventDensity +
    WEIGHTS.narrativeMomentum * narrativeMomentum +
    WEIGHTS.emotionalPeak * emotionalPeak +
    WEIGHTS.laughDetection * laughDetection +
    WEIGHTS.shockReaction * shockReaction +
    WEIGHTS.chatSync * chatSync +
    WEIGHTS.funnyQuote * funnyQuote +
    WEIGHTS.reactionChain * reactionChain +
    WEIGHTS.runningBit * runningBit;

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
    runningBit,
    calmPenalty,
    composite,
  };
}

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

      const sources = new Set<string>();
      if (keeper.transcriptSignals.length > 0) sources.add("transcript");
      if (keeper.chatSignals.length > 0) sources.add("chat");
      if (keeper.audioSignals.length > 0) sources.add("audio");
      keeper.signalOverlap = sources.size;

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
  if ((moment.scores.runningBit ?? 0) >= 0.65) humorParts.push(`running-bit=${(moment.scores.runningBit ?? 0).toFixed(2)}`);
  if ((moment.scores.funnyQuote ?? 0) > 0) humorParts.push("funny-quote");
  if ((moment.scores.calmPenalty ?? 1) < 1) humorParts.push("calm-penalized");
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
    const allKeywords = [...new Set(moment.chatSignals.flatMap((s) => s.keywordHits))];
    const laughHits = moment.chatSignals.reduce((sum, s) => sum + (s.laughHits ?? 0), 0);
    const shockHits = moment.chatSignals.reduce((sum, s) => sum + (s.shockHits ?? 0), 0);
    let chatPart = `Chat spike: ${maxRate.toFixed(1)}msg/s`;
    if (laughHits > 0 || shockHits > 0) chatPart += ` (${laughHits} laugh/${shockHits} shock hits)`;
    else if (allKeywords.length > 0) chatPart += ` (${allKeywords.slice(0, 3).join(", ")})`;
    parts.push(chatPart);
  }

  if (moment.audioSignals.length > 0) {
    const maxDelta = Math.max(...moment.audioSignals.map((s) => s.deltaFromAvg));
    const types = [...new Set(moment.audioSignals.map((s) => s.type))];
    parts.push(`Audio ${types.join("+")}: +${maxDelta.toFixed(1)}dB`);
  }

  parts.push(
    `Arc: ${((moment.scores.narrativeMomentum ?? 0) * 100).toFixed(0)}`,
    `Density: ${((moment.scores.eventDensity ?? 0) * 100).toFixed(0)}`,
    `Peak: ${((moment.scores.emotionalPeak ?? 0) * 100).toFixed(0)}`,
  );

  if (moment.rescueReason) parts.push(`RESCUE: ${moment.rescueReason}`);

  return parts.join(" | ") || "Signal cluster";
}

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
  ) || (m.scores.runningBit ?? 0) >= 0.65;

  if (m.signalOverlap < 2) return false;
  if ((m.scores.eventDensity ?? 0) < MIN_EVENT_DENSITY_SCORE) return false;
  if ((m.scores.emotionalPeak ?? 0) < MIN_EMOTIONAL_PEAK_SCORE) return false;
  if ((m.scores.narrativeMomentum ?? 0) < MIN_STANDARD_NARRATIVE_MOMENTUM && (m.scores.reactionChain ?? 0) < 1) return false;
  if ((m.scores.calmPenalty ?? 1) < 1) return false;

  // Prevent raw audio spikes + generic chat volume from beating moments whose
  // transcript has an obvious joke/payoff. If the words do not show a laugh,
  // shock, or funny quote, require a very strong audiovisual eruption.
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
  const runningBitPass =
    (m.scores.runningBit ?? 0) >= 0.65 &&
    maxTranscriptWeight >= 0.7 &&
    Math.max(m.scores.laughDetection ?? 0, m.scores.shockReaction ?? 0, m.scores.funnyQuote ?? 0, m.scores.reactionChain ?? 0) >= 0.55 &&
    (m.chatSignals.length > 0 || maxAudioDelta >= 16);

  return laughPass || shockPass || funnyQuotePass || reactionChainPass || runningBitPass;
}

export function scoreAndRankMoments(
  transcriptSignals: TranscriptSignal[],
  chatSignals: ChatSignal[],
  audioSignals: AudioSignal[],
  streamDurationSec: number,
): Moment[] {
  const events = collectEvents(transcriptSignals, chatSignals, audioSignals);
  if (events.length === 0) return [];

  const groups = groupIntoMoments(events);

  let moments: Moment[] = groups.map((group) => {
    const center = weightedCenter(group);
    const scores = scoreMoment(group, center, streamDurationSec);
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

    const sourceTypes = new Set(group.map((e) => e.source));

    return {
      id: "",
      centerTimeSec: center,
      signalOverlap: sourceTypes.size,
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

  // Hard filter: gaming streams are constantly loud + exclamatory.
  // Keep moments that pass EITHER:
  //   - The comedy path (transcript + audio)
  //   - The highlight path (audio + chat, or massive audio)
  //   - The RESCUE path (single-signal but exceptional AND with a late arc)
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

  // Cap at top 25 — if you have more than 25 "viral" moments, you're not being selective enough
  moments.sort((a, b) => b.scores.composite - a.scores.composite);
  moments = moments.slice(0, 25);

  moments.sort((a, b) => b.scores.composite - a.scores.composite);

  for (let i = 0; i < moments.length; i++) {
    moments[i].id = `moment-${String(i + 1).padStart(3, "0")}`;
    moments[i].description = generateDescription(moments[i]);
  }

  return moments;
}
