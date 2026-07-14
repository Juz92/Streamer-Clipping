export interface SignalEventLike {
  timestampSec: number;
  strength: number;
}

export function hasFirstThreeSecondHook(params: {
  startSec: number;
  text: string;
  flashDuration?: number;
  events: SignalEventLike[];
}): boolean {
  const strongText = /[?!]|\b(no way|what the|oh my|holy|clip that|shroud|bedtime|race|rage|roast|caught|wtf)\b/i.test(params.text);
  const earlySignal = params.events.some((event) =>
    event.timestampSec >= params.startSec &&
    event.timestampSec <= params.startSec + 3 &&
    event.strength >= 0.55,
  );
  return (params.flashDuration ?? 0) >= 1 || earlySignal || strongText;
}

export interface RenderedShortProbe {
  file: string;
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
}

export function evaluateRenderedShorts(probes: RenderedShortProbe[]): { bad: number; message: string } {
  const bad = probes.filter((probe) =>
    probe.width !== 1080 ||
    probe.height !== 1920 ||
    probe.durationSec < 10 ||
    probe.durationSec > 60 ||
    !probe.hasAudio,
  );
  return {
    bad: bad.length,
    message: bad.length === 0
      ? `${probes.length} rendered short(s) passed stream QA`
      : bad.map((probe) => `${probe.file}: ${probe.width}x${probe.height}, ${probe.durationSec.toFixed(1)}s, audio=${probe.hasAudio}`).join("; "),
  };
}

export interface ReviewPacketClip {
  rank: number;
  quality?: {
    status?: "suggested" | "candidate" | "reserve" | string;
    arcCompleteness?: number;
  };
}

export function chooseReviewPacketClips<T extends ReviewPacketClip>(clips: T[], suggestedRank: number | null): T[] {
  return [...clips].sort((a, b) => {
    const aSuggested = a.rank === suggestedRank || a.quality?.status === "suggested";
    const bSuggested = b.rank === suggestedRank || b.quality?.status === "suggested";
    if (aSuggested !== bSuggested) return aSuggested ? -1 : 1;
    const aReserve = a.quality?.status === "reserve";
    const bReserve = b.quality?.status === "reserve";
    if (aReserve !== bReserve) return aReserve ? 1 : -1;
    return (b.quality?.arcCompleteness ?? 0) - (a.quality?.arcCompleteness ?? 0) || a.rank - b.rank;
  }).slice(0, 3);
}

export function blocksMissingTranscriptReview(state: { reviewed: boolean; dryRun?: boolean; allowScorerOnly?: boolean }): boolean {
  return !state.reviewed && !state.dryRun && !state.allowScorerOnly;
}

export function blocksMissingQaReview(state: { qaAvailable: boolean; dryRun?: boolean; allowNoQa?: boolean }): boolean {
  return !state.qaAvailable && !state.dryRun && !state.allowNoQa;
}
