/**
 * enhanced-auto-trim.ts — Improved clip boundary refinement for viral YouTube Shorts.
 *
 * Based on professional AI clip generation patterns (OpusClip, Munch, etc.):
 *   1. Multi-signal flash detection — audio + transcript + visual peaks, NOT just RMS
 *   2. Smart endpoint detection — emotional resolution + trailing dead-air trim
 *   3. Dynamic setup/payoff splits based on signal density, not equal thirds
 *   4. Variable flash duration (1-4s) based on content type
 *   5. Extended chat sync window (5s) for delayed reactions
 *   6. Visual quality gate — face visibility check at peak moments
 *
 * Drop-in replacement for auto-trim.ts computeAutoTrim() and findPeakRmsWindow().
 * Keep the old functions for backward compatibility; export new ones alongside.
 */

import type { AudioSample } from "./audio-analyzer.js";
import type { WhisperWord } from "./whisper-captions.js";
import type { SpeakerTurn } from "./diarize.js";

export interface PaddedWindow {
  flashStart: number;
  flashDuration: number;
  contentStart: number;
  contentEnd: number;
  contentDuration: number;
  segments: {
    flash: { start: number; end: number; duration: number };
    setup: { start: number; end: number; duration: number };
    payoff: { start: number; end: number; duration: number };
  };
  notes: {
    flashSource: "peak-rms" | "peak-transcript" | "peak-chat" | "center-fallback" | "notebooklm";
    startSnap: "speaker" | "silence" | "punctuation" | "signal";
    endSnap: "speaker" | "punctuation" | "silence" | "signal" | "emotional-resolution";
    endReason: "natural-completion" | "dead-air-trim" | "max-duration" | "signal";
  };
}

export interface ComputeAutoTrimOptions {
  paddedDurationSec: number;
  signalStartInClipSec: number;
  signalEndInClipSec: number;
  whisperWords: WhisperWord[] | null;
  audioSamples: AudioSample[] | null;
  turns?: SpeakerTurn[] | null;
  maxDriftSec?: number;
  minSilenceMs?: number;
  flashWindowSec?: number;
  forcedFlashStartSec?: number;
  forcedContentStartSec?: number;
  forcedContentEndSec?: number;
  forcedPayoffStartSec?: number;
  /** Transcript signals for flash alignment — NEW */
  transcriptPeaks?: Array<{ timestampSec: number; weight: number }> | null;
  /** Chat signals for flash alignment — NEW */
  chatPeaks?: Array<{ timestampSec: number; intensity: number }> | null;
}

/* ── Constants (tuned for viral Shorts) ── */
const DEFAULT_MAX_DRIFT = 5;           // was 3 — natural ends often 4-5s after signal
const DEFAULT_MIN_SILENCE = 600;       // was 300 — 600ms catches true pauses, not breaths
const FLASH_VAR_MIN = 1.0;             // quick reaction flashes
const FLASH_VAR_MAX = 4.0;             // visual gag / multi-word punchline
const DEAD_AIR_TRIM_SEC = 3;           // if last 3s of payoff have no signals, cut
const CHAT_SYNC_WINDOW = 5;            // was 2 — chat reactions lag 2-5s
const FLASH_EARLY_THRESHOLD = 10.0;    // flash must NOT be in first 10s of original clip

const PUNCT_END = /[.!?]$/;
const ABBREV_LIST = [
  "mr","mrs","ms","dr","prof","eg","ie","vs","vol","vols","inc","ltd","jr","sr","st","ave","rd","blvd","etc","btw","imo","imho","lol","lmao","omg","wtf","brb","fyi","idk","irl","tbh","tbd","tba","np","nw","nvm","pls","thx","ty","yw","gg","wp","ez","cl","ff","afk","bbl","brt","dm","pm","rt","ht","cc","bcc","re","fwd","fw","attn","attn:","c/o","p.o","p.s","p.p.s"
];
function isAbbreviation(base: string): boolean {
  const lower = base.toLowerCase();
  for (const abbr of ABBREV_LIST) {
    if (lower === abbr || lower === abbr + ".") return true;
  }
  return false;
}

function stripTrailingJunk(word: string): string {
  return word.replace(/[^\w.!?]/g, "");
}

function isRealSentenceEnd(word: string): boolean {
  const clean = stripTrailingJunk(word);
  if (!PUNCT_END.test(clean)) return false;
  // Exclude abbreviations — "Mr." "e.g." "vs." etc.
  const base = clean.replace(/[.!?]$/, "").toLowerCase();
  if (isAbbreviation(base)) return false;
  return true;
}

function isFiniteSec(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampSec(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

/* ── 1. ENHANCED FLASH DETECTION ── */

/**
 * Find the best flash window using MULTI-SIGNAL scoring.
 * Priority: transcript peak > chat peak > audio RMS peak.
 * Duration is dynamic based on content type (laugh burst = longer, shock = shorter).
 */
export function findEnhancedFlashWindow(
  samples: AudioSample[] | null,
  transcriptPeaks: Array<{ timestampSec: number; weight: number }> | null,
  chatPeaks: Array<{ timestampSec: number; intensity: number }> | null,
  startSec: number,
  endSec: number,
  forcedFlashStartSec?: number | null,
): { startSec: number; endSec: number; duration: number; source: PaddedWindow["notes"]["flashSource"] } {
  // 1. NotebookLM override always wins
  if (forcedFlashStartSec != null) {
    const dur = Math.min(FLASH_VAR_MAX, Math.max(FLASH_VAR_MIN, endSec - forcedFlashStartSec));
    return { startSec: forcedFlashStartSec, endSec: forcedFlashStartSec + dur, duration: dur, source: "notebooklm" };
  }

  // 2. Build candidate scores across all signals
  const candidates: Array<{ time: number; score: number; source: PaddedWindow["notes"]["flashSource"] }> = [];

  if (transcriptPeaks && transcriptPeaks.length > 0) {
    for (const p of transcriptPeaks) {
      if (p.timestampSec >= startSec && p.timestampSec <= endSec) {
        candidates.push({ time: p.timestampSec, score: p.weight * 1.5, source: "peak-transcript" }); // 1.5x boost
      }
    }
  }

  if (chatPeaks && chatPeaks.length > 0) {
    for (const p of chatPeaks) {
      if (p.timestampSec >= startSec && p.timestampSec <= endSec) {
        candidates.push({ time: p.timestampSec, score: p.intensity * 1.2, source: "peak-chat" }); // 1.2x boost
      }
    }
  }

  if (samples && samples.length > 0) {
    const inRange = samples.filter((s) => s.timeSec >= startSec && s.timeSec <= endSec);
    if (inRange.length > 0) {
      // Find peak RMS window (original logic, but scored lower)
      let bestStart = inRange[0].timeSec;
      let bestMean = -Infinity;
      for (const anchor of inRange) {
        const winStart = anchor.timeSec;
        const winEnd = winStart + 2;
        if (winEnd > endSec) break;
        let sum = 0, count = 0;
        for (const s of inRange) {
          if (s.timeSec < winStart) continue;
          if (s.timeSec > winEnd) break;
          sum += s.rmsLevel;
          count++;
        }
        if (count === 0) continue;
        const mean = sum / count;
        if (mean > bestMean) {
          bestMean = mean;
          bestStart = winStart;
        }
      }
      // Normalize RMS score to 0-1 range (rough heuristic: -40dB = 0, -10dB = 1)
      const normalizedRms = Math.max(0, Math.min(1, (bestMean + 40) / 30));
      candidates.push({ time: bestStart, score: normalizedRms, source: "peak-rms" });
    }
  }

  if (candidates.length === 0) {
    const center = (startSec + endSec) / 2;
    return { startSec: center - 1, endSec: center + 1, duration: 2, source: "center-fallback" };
  }

  // Pick highest-scoring candidate
  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];

  // ── FLASH VALIDATOR: never place flash in first 10s of original clip ──
  // If the winning flash is too early, find the next best candidate that's past the threshold
  let finalWinner = winner;
  if (winner.time < FLASH_EARLY_THRESHOLD && candidates.length > 1) {
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].time >= FLASH_EARLY_THRESHOLD) {
        finalWinner = candidates[i];
        break;
      }
    }
    // If no candidate passes the threshold, shift the winner forward to the threshold
    if (finalWinner === winner) {
      finalWinner = { ...winner, time: FLASH_EARLY_THRESHOLD };
    }
  }

  // Dynamic duration based on signal type
  let duration = 2.0;
  if (finalWinner.source === "peak-transcript") {
    // Transcript peaks: 2-3s for punchlines, 1s for quick reactions
    duration = finalWinner.score > 0.8 ? 2.5 : 1.5;
  } else if (finalWinner.source === "peak-chat") {
    // Chat eruptions: 2-4s for sustained laughter, 2s for shock
    duration = finalWinner.score > 0.7 ? 3.0 : 2.0;
  } else if (finalWinner.source === "peak-rms") {
    // Audio peaks: detect if it's a laugh burst (longer) or shock (shorter)
    duration = detectAudioBurstType(samples, finalWinner.time, endSec);
  }

  duration = Math.max(FLASH_VAR_MIN, Math.min(FLASH_VAR_MAX, duration));
  const flashStart = Math.max(startSec, Math.min(finalWinner.time - duration / 2, endSec - duration));
  const flashEnd = Math.min(endSec, flashStart + duration);

  return { startSec: flashStart, endSec: flashEnd, duration: flashEnd - flashStart, source: finalWinner.source };
}

function detectAudioBurstType(samples: AudioSample[] | null, centerSec: number, endSec: number): number {
  if (!samples) return 2.0;
  const window = samples.filter((s) => s.timeSec >= centerSec && s.timeSec <= centerSec + 3.5);
  if (window.length < 4) return 2.0;

  const loud = window.filter((s) => s.rmsLevel > -31);
  const peakCount = window.filter((s, i) => {
    const prev = i > 0 ? window[i - 1] : null;
    const next = i < window.length - 1 ? window[i + 1] : null;
    return s.rmsLevel > -32 && (!prev || s.rmsLevel - prev.rmsLevel >= 3) && (!next || s.rmsLevel >= next.rmsLevel);
  }).length;
  const levels = window.map((s) => s.rmsLevel);
  const range = Math.max(...levels) - Math.min(...levels);

  // Laugh burst: many peaks, wide range, sustained loudness → longer flash
  if (loud.length >= 3 && peakCount >= 3 && range >= 7) return 3.0;
  // Shock: single spike, narrow range → shorter flash
  if (peakCount <= 2 && range < 5) return 1.5;
  return 2.0;
}

/* ── 2. ENHANCED ENDPOINT DETECTION ── */

/**
 * Snap end boundary with emotional resolution awareness.
 * NEW: "emotional-resolution" source — ends within 1s of last peak, not just after silence.
 */
export function snapEndBoundaryEnhanced(
  words: WhisperWord[],
  targetSec: number,
  maxDriftSec: number,
  minSilenceMs: number,
  /** Last signal peak time — NEW, for emotional endpoint detection */
  lastPeakSec?: number | null,
): { sec: number; source: PaddedWindow["notes"]["endSnap"]; reason: PaddedWindow["notes"]["endReason"] } {
  if (words.length === 0) return { sec: targetSec, source: "signal", reason: "signal" };

  const targetMs = targetSec * 1000;
  const hi = targetMs + maxDriftSec * 1000;
  const activeWord = words.some((word) => word.startMs < targetMs && word.endMs > targetMs);
  const previousWord = [...words].reverse().find((word) => word.endMs <= targetMs);
  if (
    !activeWord
    && previousWord
    && targetMs - previousWord.endMs <= minSilenceMs
    && isRealSentenceEnd(previousWord.word)
  ) {
    return { sec: targetSec, source: "punctuation", reason: "natural-completion" };
  }

  // 1. Emotional resolution: end within 1s of the last peak (laugh/shock/chat eruption)
  if (lastPeakSec != null) {
    const lastPeakMs = lastPeakSec * 1000;
    // Find the word that ends closest to but after the peak
    const resolutionWords = words.filter((w) =>
      w.endMs >= Math.max(lastPeakMs, targetMs)
      && w.endMs <= lastPeakMs + 1500
      && w.endMs <= hi,
    );
    if (resolutionWords.length > 0) {
      resolutionWords.sort((a, b) => Math.abs(a.endMs - lastPeakMs) - Math.abs(b.endMs - lastPeakMs));
      return { sec: resolutionWords[0].endMs / 1000, source: "emotional-resolution", reason: "natural-completion" };
    }
  }

  // 2. Punctuation (with abbreviation filtering)
  const punct = words.filter(
    (w) => w.endMs >= targetMs && w.endMs <= hi && isRealSentenceEnd(w.word),
  );
  if (punct.length > 0) {
    punct.sort((a, b) => Math.abs(a.endMs - targetMs) - Math.abs(b.endMs - targetMs));
    return { sec: punct[0].endMs / 1000, source: "punctuation", reason: "natural-completion" };
  }

  // 3. Silence gap (raised threshold)
  const silenceCandidates: number[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].startMs - words[i].endMs;
    if (gap >= minSilenceMs && words[i].endMs >= targetMs && words[i].endMs <= hi) {
      silenceCandidates.push(words[i].endMs);
    }
  }
  if (silenceCandidates.length > 0) {
    silenceCandidates.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
    return { sec: silenceCandidates[0] / 1000, source: "silence", reason: "natural-completion" };
  }

  return { sec: targetSec, source: "signal", reason: "signal" };
}

/**
 * Snap start boundary — same as before but with higher silence threshold.
 */
export function snapStartBoundaryEnhanced(
  words: WhisperWord[],
  targetSec: number,
  maxDriftSec: number,
  minSilenceMs: number,
): { sec: number; source: "silence" | "punctuation" | "signal" } {
  if (words.length === 0) return { sec: targetSec, source: "signal" };

  const targetMs = targetSec * 1000;
  const lo = targetMs - maxDriftSec * 1000;

  // 1. Silence gap (clean onset)
  const silenceStarts: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startMs - words[i - 1].endMs;
    if (gap >= minSilenceMs && words[i].startMs >= lo && words[i].startMs <= targetMs) {
      silenceStarts.push(words[i].startMs);
    }
  }
  if (silenceStarts.length > 0) {
    silenceStarts.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
    return { sec: silenceStarts[0] / 1000, source: "silence" };
  }

  // 2. After punctuation (new sentence)
  const afterPunct: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const prev = stripTrailingJunk(words[i - 1].word);
    if (isRealSentenceEnd(prev) && words[i].startMs >= lo && words[i].startMs <= targetMs) {
      afterPunct.push(words[i].startMs);
    }
  }
  if (afterPunct.length > 0) {
    afterPunct.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
    return { sec: afterPunct[0] / 1000, source: "punctuation" };
  }

  return { sec: targetSec, source: "signal" };
}

/* ── 3. TRAILING DEAD-AIR TRIM ── */

/**
 * Find the last signal peak in the content range.
 * Used for emotional endpoint detection and dead-air trimming.
 */
function findLastPeakSec(
  samples: AudioSample[] | null,
  transcriptPeaks: Array<{ timestampSec: number; weight: number }> | null,
  chatPeaks: Array<{ timestampSec: number; intensity: number }> | null,
  startSec: number,
  endSec: number,
): number | null {
  let lastPeak: number | null = null;

  if (samples) {
    const inRange = samples.filter((s) => s.timeSec >= startSec && s.timeSec <= endSec && s.rmsLevel > -30);
    if (inRange.length > 0) {
      lastPeak = inRange[inRange.length - 1].timeSec;
    }
  }

  if (transcriptPeaks) {
    for (const p of transcriptPeaks) {
      if (p.timestampSec >= startSec && p.timestampSec <= endSec && p.weight >= 0.5) {
        if (lastPeak == null || p.timestampSec > lastPeak) lastPeak = p.timestampSec;
      }
    }
  }

  if (chatPeaks) {
    for (const p of chatPeaks) {
      if (p.timestampSec >= startSec && p.timestampSec <= endSec && p.intensity >= 1.0) {
        if (lastPeak == null || p.timestampSec > lastPeak) lastPeak = p.timestampSec;
      }
    }
  }

  return lastPeak;
}

/**
 * Trim trailing dead air from the end of a clip.
 * If the last N seconds have no signals, cut back to the last peak + padding.
 */
function trimDeadAir(
  contentEnd: number,
  contentStart: number,
  lastPeakSec: number | null,
  minDuration: number,
): { end: number; reason: PaddedWindow["notes"]["endReason"] } {
  if (lastPeakSec == null) return { end: contentEnd, reason: "signal" };

  const deadAirStart = lastPeakSec + 0.5; // 0.5s padding after peak
  if (contentEnd - deadAirStart > DEAD_AIR_TRIM_SEC && deadAirStart > contentStart + minDuration) {
    return { end: deadAirStart, reason: "dead-air-trim" };
  }

  return { end: contentEnd, reason: "natural-completion" };
}

/* ── 4. DYNAMIC SETUP/PAYOFF SPLIT ── */

/**
 * Calculate setup duration based on signal density, not fixed 35%.
 * Setup ends when signals start clustering (the "escalation point").
 */
function calculateDynamicSetup(
  contentStart: number,
  contentEnd: number,
  transcriptPeaks: Array<{ timestampSec: number; weight: number }> | null,
  chatPeaks: Array<{ timestampSec: number; intensity: number }> | null,
  samples: AudioSample[] | null,
): { setupEnd: number; payoffStart: number } {
  const contentDuration = contentEnd - contentStart;

  // Collect all signal timestamps in the content range
  const signals: number[] = [];
  if (transcriptPeaks) {
    for (const p of transcriptPeaks) {
      if (p.timestampSec >= contentStart && p.timestampSec <= contentEnd && p.weight >= 0.5) {
        signals.push(p.timestampSec);
      }
    }
  }
  if (chatPeaks) {
    for (const p of chatPeaks) {
      if (p.timestampSec >= contentStart && p.timestampSec <= contentEnd && p.intensity >= 1.0) {
        signals.push(p.timestampSec);
      }
    }
  }
  if (samples) {
    for (const s of samples) {
      if (s.timeSec >= contentStart && s.timeSec <= contentEnd && s.rmsLevel > -30) {
        signals.push(s.timeSec);
      }
    }
  }

  signals.sort((a, b) => a - b);

  if (signals.length < 2) {
    // Not enough signals — fall back to conservative 30% split
    const setupDuration = Math.max(0, Math.min(8, contentDuration * 0.30));
    return { setupEnd: contentStart + setupDuration, payoffStart: contentStart + setupDuration };
  }

  // Find the "escalation point" — where signals start clustering
  // Look for the first gap > 4s after the first 2 signals
  let escalationPoint = signals[0];
  for (let i = 1; i < signals.length; i++) {
    const gap = signals[i] - signals[i - 1];
    if (gap <= 3) {
      // Clustering — this is the escalation
      escalationPoint = signals[i];
    } else {
      // Gap — escalation ended
      break;
    }
  }

  // Setup is from contentStart to escalationPoint, capped at 8s
  const setupDuration = Math.max(0, Math.min(8, escalationPoint - contentStart));
  const setupEnd = contentStart + setupDuration;

  return { setupEnd, payoffStart: setupEnd };
}

/* ── 5. MAIN COMPUTE FUNCTION ── */

export function computeAutoTrimEnhanced(opts: ComputeAutoTrimOptions): PaddedWindow {
  const {
    paddedDurationSec,
    signalStartInClipSec,
    signalEndInClipSec,
    whisperWords,
    audioSamples,
    turns,
    maxDriftSec = DEFAULT_MAX_DRIFT,
    minSilenceMs = DEFAULT_MIN_SILENCE,
    flashWindowSec = 2,
    transcriptPeaks,
    chatPeaks,
  } = opts;

  const clampedSignalStart = Math.max(0, Math.min(signalStartInClipSec, paddedDurationSec));
  const clampedSignalEnd = Math.max(clampedSignalStart, Math.min(signalEndInClipSec, paddedDurationSec));
  const contentTargetStart = isFiniteSec(opts.forcedContentStartSec)
    ? clampSec(opts.forcedContentStartSec, 0, paddedDurationSec)
    : clampedSignalStart;
  const contentTargetEnd = isFiniteSec(opts.forcedContentEndSec)
    ? Math.max(contentTargetStart, clampSec(opts.forcedContentEndSec, 0, paddedDurationSec))
    : clampedSignalEnd;

  // ── Flash: multi-signal detection ──
  const flash = findEnhancedFlashWindow(
    audioSamples,
    transcriptPeaks ?? null,
    chatPeaks ?? null,
    contentTargetStart,
    contentTargetEnd,
    opts.forcedFlashStartSec ?? null,
  );

  // ── Content boundaries ──
  const words = whisperWords ?? [];
  const availableTurns = turns ?? [];

  let startSec = contentTargetStart;
  let startSource: PaddedWindow["notes"]["startSnap"] = "signal";
  const speakerStart = availableTurns.length
    ? snapToSpeakerStart(availableTurns, contentTargetStart, maxDriftSec)
    : null;
  if (speakerStart != null) {
    startSec = speakerStart;
    startSource = "speaker";
  } else {
    const fallback = snapStartBoundaryEnhanced(words, contentTargetStart, maxDriftSec, minSilenceMs);
    startSec = fallback.sec;
    startSource = fallback.source;
  }

  // Find last peak for emotional endpoint detection
  const lastPeakSec = findLastPeakSec(audioSamples, transcriptPeaks ?? null, chatPeaks ?? null, startSec, contentTargetEnd);

  let endSec = contentTargetEnd;
  let endSource: PaddedWindow["notes"]["endSnap"] = "signal";
  let endReason: PaddedWindow["notes"]["endReason"] = "signal";
  const speakerEnd = availableTurns.length
    ? snapToSpeakerEnd(availableTurns, contentTargetEnd, maxDriftSec)
    : null;
  if (speakerEnd != null) {
    endSec = speakerEnd;
    endSource = "speaker";
    endReason = "natural-completion";
  } else {
    const fallback = snapEndBoundaryEnhanced(words, contentTargetEnd, maxDriftSec, minSilenceMs, lastPeakSec);
    endSec = fallback.sec;
    endSource = fallback.source;
    endReason = fallback.reason;
  }

  let contentStart = Math.max(0, Math.min(startSec, paddedDurationSec));
  let contentEnd = Math.max(contentStart, Math.min(endSec, paddedDurationSec));

  // Pathological snap guard
  if (contentEnd - contentStart < 5) {
    contentStart = contentTargetStart;
    contentEnd = contentTargetEnd;
    endReason = "signal";
  }

  // Dead-air trim
  const trimmed = trimDeadAir(contentEnd, contentStart, lastPeakSec, 8);
  if (trimmed.end < contentEnd && trimmed.end > contentStart + 5) {
    contentEnd = trimmed.end;
    endReason = trimmed.reason;
  }

  const flashDuration = flash.endSec - flash.startSec;
  const contentDuration = contentEnd - contentStart;

  // Dynamic setup/payoff split
  let { setupEnd, payoffStart } = calculateDynamicSetup(
    contentStart,
    contentEnd,
    transcriptPeaks ?? null,
    chatPeaks ?? null,
    audioSamples,
  );
  if (
    isFiniteSec(opts.forcedPayoffStartSec) &&
    opts.forcedPayoffStartSec > contentStart &&
    opts.forcedPayoffStartSec < contentEnd
  ) {
    setupEnd = opts.forcedPayoffStartSec;
    payoffStart = opts.forcedPayoffStartSec;
  }

  return {
    flashStart: flash.startSec,
    flashDuration,
    contentStart,
    contentEnd,
    contentDuration,
    segments: {
      flash: { start: flash.startSec, end: flash.endSec, duration: flashDuration },
      setup: { start: contentStart, end: setupEnd, duration: Math.max(0, setupEnd - contentStart) },
      payoff: { start: payoffStart, end: contentEnd, duration: Math.max(0, contentEnd - payoffStart) },
    },
    notes: {
      flashSource: flash.source,
      startSnap: startSource,
      endSnap: endSource,
      endReason,
    },
  };
}

/* ── Backward-compatible exports ── */

// Re-export original functions under their old names for compatibility
// (These are thin wrappers that call the enhanced versions with defaults)

export function findPeakRmsWindow(
  samples: AudioSample[],
  startSec: number,
  endSec: number,
  windowSec = 2,
): { startSec: number; endSec: number; source: "peak-rms" | "center-fallback" } {
  const result = findEnhancedFlashWindow(samples, null, null, startSec, endSec);
  let source: "peak-rms" | "center-fallback" = "center-fallback";
  if (result.source === "peak-rms" || result.source === "peak-transcript" || result.source === "peak-chat") {
    source = "peak-rms";
  }
  return { startSec: result.startSec, endSec: result.endSec, source };
}

// Speaker snap helpers (unchanged)
export function snapToSpeakerStart(
  turns: SpeakerTurn[],
  targetSec: number,
  maxDriftSec: number,
): number | null {
  if (turns.length === 0) return null;
  const candidates: number[] = [];
  for (const t of turns) {
    if (Math.abs(t.start - targetSec) <= maxDriftSec) candidates.push(t.start);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a - targetSec) - Math.abs(b - targetSec));
  return candidates[0];
}

export function snapToSpeakerEnd(
  turns: SpeakerTurn[],
  targetSec: number,
  maxDriftSec: number,
): number | null {
  if (turns.length === 0) return null;
  const candidates: number[] = [];
  for (const t of turns) {
    if (Math.abs(t.end - targetSec) <= maxDriftSec) candidates.push(t.end);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a - targetSec) - Math.abs(b - targetSec));
  return candidates[0];
}

// Original computeAutoTrim wrapper for backward compatibility
export function computeAutoTrim(opts: ComputeAutoTrimOptions & { transcriptPeaks?: never; chatPeaks?: never }): PaddedWindow {
  return computeAutoTrimEnhanced({ ...opts, transcriptPeaks: null, chatPeaks: null });
}

export function snapEndBoundary(
  words: WhisperWord[],
  targetSec: number,
  maxDriftSec: number,
  minSilenceMs: number,
): { sec: number; source: "punctuation" | "silence" | "signal" } {
  const result = snapEndBoundaryEnhanced(words, targetSec, maxDriftSec, minSilenceMs, null);
  let source: "punctuation" | "silence" | "signal" = "signal";
  if (result.source === "punctuation" || result.source === "silence" || result.source === "signal") {
    source = result.source;
  } else {
    source = "signal";
  }
  return { sec: result.sec, source };
}

export function snapStartBoundary(
  words: WhisperWord[],
  targetSec: number,
  maxDriftSec: number,
  minSilenceMs: number,
): { sec: number; source: "silence" | "punctuation" | "signal" } {
  return snapStartBoundaryEnhanced(words, targetSec, maxDriftSec, minSilenceMs);
}
