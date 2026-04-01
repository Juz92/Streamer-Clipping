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
    composite: number;
  };
  suggestedStartSec: number;
  suggestedEndSec: number;
  suggestedDurationSec: number;
  description: string;
}

interface UnifiedEvent {
  timestampSec: number;
  source: "transcript" | "chat" | "audio";
  weight: number;
  signal: TranscriptSignal | ChatSignal | AudioSignal;
}

const ALIGNMENT_WINDOW = 15;

const WEIGHTS = {
  overlap: 0.35,
  chatIntensity: 0.25,
  audioMagnitude: 0.20,
  virality: 0.15,
  durationSuitability: 0.05,
} as const;

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

function scoreMoment(
  events: UnifiedEvent[],
  centerTimeSec: number,
  streamDurationSec: number,
): Moment["scores"] {
  const sourceTypes = new Set(events.map((e) => e.source));
  const overlapCount = sourceTypes.size;
  // Base overlap score, then bonus for having MANY events (not just one per type)
  const eventDensity = Math.min(events.length / 8, 1.0); // 8+ events in window = max
  const baseOverlap = overlapCount === 1 ? 0.2 : overlapCount === 2 ? 0.6 : 1.0;
  const overlapScore = baseOverlap * 0.7 + eventDensity * 0.3;

  const chatEvents = events.filter((e) => e.source === "chat");
  const maxSpike = chatEvents.reduce((max, e) => Math.max(max, (e.signal as ChatSignal).spikeIntensity), 0);
  const chatIntensity = Math.min(maxSpike / 5, 1.0);

  const audioEvents = events.filter((e) => e.source === "audio");
  const maxDelta = audioEvents.reduce((max, e) => Math.max(max, (e.signal as AudioSignal).deltaFromAvg), 0);
  const audioMagnitude = Math.min(maxDelta / 30, 1.0);

  const transcriptEvents = events.filter((e) => e.source === "transcript");
  const viralityScore = transcriptEvents.reduce((max, e) => Math.max(max, (e.signal as TranscriptSignal).weight), 0);

  const durationSuitability =
    centerTimeSec >= 5 && centerTimeSec <= streamDurationSec - 5 ? 1.0 : 0.5;

  const composite =
    WEIGHTS.overlap * overlapScore +
    WEIGHTS.chatIntensity * chatIntensity +
    WEIGHTS.audioMagnitude * audioMagnitude +
    WEIGHTS.virality * viralityScore +
    WEIGHTS.durationSuitability * durationSuitability;

  return { overlapScore, chatIntensity, audioMagnitude, viralityScore, durationSuitability, composite };
}

function clipBoundaries(
  centerTimeSec: number,
  streamDurationSec: number,
): { start: number; end: number; duration: number } {
  let start = Math.max(centerTimeSec - 20, 0);
  let end = Math.min(centerTimeSec + 25, streamDurationSec);
  let duration = end - start;

  if (duration < 15) {
    const deficit = 15 - duration;
    start = Math.max(start - deficit / 2, 0);
    end = Math.min(end + deficit / 2, streamDurationSec);
    duration = end - start;
  }

  if (duration > 60) {
    const excess = duration - 60;
    start += excess / 2;
    end -= excess / 2;
    duration = 60;
  }

  return { start, end, duration };
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

      merged[merged.length - 1] = keeper;
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

function generateDescription(moment: Moment): string {
  const parts: string[] = [];

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
    let chatPart = `Chat spike: ${maxRate.toFixed(1)}msg/s`;
    if (allKeywords.length > 0) {
      chatPart += ` (${allKeywords.slice(0, 3).join(", ")})`;
    }
    parts.push(chatPart);
  }

  if (moment.audioSignals.length > 0) {
    const maxDelta = Math.max(...moment.audioSignals.map((s) => s.deltaFromAvg));
    parts.push(`Audio spike: +${maxDelta.toFixed(1)}dB`);
  }

  return parts.join(" | ") || "Signal cluster";
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
  // Keep moments that pass EITHER the comedy path OR the highlight path.
  moments = moments.filter((m) => {
    // Must have 2+ signal types overlapping minimum
    if (m.signalOverlap < 2) return false;

    const maxAudioDelta = m.audioSignals.length > 0
      ? Math.max(...m.audioSignals.map((s) => s.deltaFromAvg))
      : 0;
    const maxTranscriptWeight = m.transcriptSignals.length > 0
      ? Math.max(...m.transcriptSignals.map((s) => s.weight))
      : 0;
    const maxChatSpike = m.chatSignals.length > 0
      ? Math.max(...m.chatSignals.map((s) => s.spikeIntensity))
      : 0;

    // Path A — Comedy/reaction (original filter): strong transcript + strong audio
    // Transcript must have high-tier keyword (0.8+) AND genuine audio spike (22dB+)
    const comedyPass =
      m.transcriptSignals.length > 0 &&
      m.audioSignals.length > 0 &&
      maxTranscriptWeight >= 0.8 &&
      maxAudioDelta >= 22;

    // Path B — Skill highlight: massive audio spike (someone screamed) even with
    // weaker transcript, OR huge chat explosion. Skill plays often produce a big
    // audio reaction with only mid-tier words ("insane", "let's go") or even silence
    // from the player while chat goes crazy.
    const highlightPass =
      (maxAudioDelta >= 28 && maxTranscriptWeight >= 0.4) ||   // Huge audio + any keyword
      (maxChatSpike >= 3.0 && maxAudioDelta >= 20) ||           // Chat explosion + decent audio
      (maxAudioDelta >= 25 && maxChatSpike >= 2.0);             // Strong audio + strong chat

    return comedyPass || highlightPass;
  });

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
