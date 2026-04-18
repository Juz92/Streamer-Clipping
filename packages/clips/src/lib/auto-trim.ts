/**
 * auto-trim.ts — pure functions for automated clip boundary refinement.
 *
 * Three concerns:
 *   1. Peak-RMS flash anchor — find the 2s sub-window with loudest mean RMS
 *      inside the signal-estimated content range. That's the "flash".
 *   2. Sentence snap — pull content start/end onto a natural speech boundary
 *      (sentence-ending punctuation or a silence gap) within a drift window.
 *   3. Compose — combine into a single result the trim/render pipeline can
 *      consume without calling ffmpeg.
 *
 * All timestamps in this module are in seconds, relative to the PADDED clip
 * (the +padSec-each-side raw extraction). Callers are responsible for
 * stream↔clip-relative conversion.
 */

import type { AudioSample } from "./audio-analyzer.js";
import type { WhisperWord } from "./whisper-captions.js";
import type { SpeakerTurn } from "./diarize.js";

export interface PaddedWindow {
  /** Clip-relative start of the 2s flash window. */
  flashStart: number;
  /** Duration of the flash — typically 2.0. */
  flashDuration: number;
  /** Clip-relative start of the linear content segment. */
  contentStart: number;
  /** Clip-relative end of the linear content segment. */
  contentEnd: number;
  /** contentEnd - contentStart, kept for convenience. */
  contentDuration: number;
  /** Per-step notes so callers can surface "why this boundary" in logs. */
  notes: {
    flashSource: "peak-rms" | "center-fallback";
    startSnap: "speaker" | "silence" | "punctuation" | "signal";
    endSnap: "speaker" | "punctuation" | "silence" | "signal";
  };
}

export interface ComputeAutoTrimOptions {
  /** Duration of the padded source clip (seconds). Boundaries are clamped to this. */
  paddedDurationSec: number;
  /** Where padding begins in clip-relative seconds — typically padSec. */
  signalStartInClipSec: number;
  /** Where padding ends in clip-relative seconds — typically padSec + originalDur. */
  signalEndInClipSec: number;
  /** Whisper words for the padded clip, clip-relative ms. */
  whisperWords: WhisperWord[] | null;
  /** Audio samples converted to clip-relative seconds. */
  audioSamples: AudioSample[] | null;
  /** Speaker-turn segments, clip-relative seconds. Optional — boundaries
   *  snap onto speaker changes first when present. */
  turns?: SpeakerTurn[] | null;
  /** How far start/end can drift to hit a natural boundary. */
  maxDriftSec?: number;
  /** Minimum gap between words to count as silence. */
  minSilenceMs?: number;
  /** Flash duration — only change for A/B tests. */
  flashWindowSec?: number;
}

/**
 * Find the 2s window with highest mean RMS inside [startSec, endSec].
 * Walks each in-range sample as a window start candidate; O(n²) but n is
 * small (~25Hz × ~40s per clip).
 */
export function findPeakRmsWindow(
  samples: AudioSample[],
  startSec: number,
  endSec: number,
  windowSec = 2,
): { startSec: number; endSec: number; source: "peak-rms" | "center-fallback" } {
  const inRange = samples.filter((s) => s.timeSec >= startSec && s.timeSec <= endSec);
  if (inRange.length === 0 || endSec - startSec < windowSec) {
    const center = (startSec + endSec) / 2;
    const fallbackStart = Math.max(startSec, center - windowSec / 2);
    return {
      startSec: fallbackStart,
      endSec: Math.min(endSec, fallbackStart + windowSec),
      source: "center-fallback",
    };
  }

  let bestStart = inRange[0].timeSec;
  let bestMean = -Infinity;

  for (const anchor of inRange) {
    const winStart = anchor.timeSec;
    const winEnd = winStart + windowSec;
    if (winEnd > endSec) break;

    let sum = 0;
    let count = 0;
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

  return {
    startSec: bestStart,
    endSec: bestStart + windowSec,
    source: "peak-rms",
  };
}

const PUNCT_END = /[.!?]$/;

function stripTrailingJunk(word: string): string {
  return word.replace(/[^\w.!?]/g, "");
}

/**
 * Snap an end-boundary onto a natural exit point. Priority:
 *   1. A word whose clean tail is `.` / `!` / `?` inside the drift window
 *   2. A word followed by a silence gap ≥ minSilenceMs inside the drift window
 *   3. The original target (caller keeps signal time)
 */
export function snapEndBoundary(
  words: WhisperWord[],
  targetSec: number,
  maxDriftSec: number,
  minSilenceMs: number,
): { sec: number; source: "punctuation" | "silence" | "signal" } {
  if (words.length === 0) return { sec: targetSec, source: "signal" };

  const targetMs = targetSec * 1000;
  const lo = targetMs - maxDriftSec * 1000;
  const hi = targetMs + maxDriftSec * 1000;

  const punct = words.filter(
    (w) => w.endMs >= lo && w.endMs <= hi && PUNCT_END.test(stripTrailingJunk(w.word)),
  );
  if (punct.length > 0) {
    punct.sort((a, b) => Math.abs(a.endMs - targetMs) - Math.abs(b.endMs - targetMs));
    return { sec: punct[0].endMs / 1000, source: "punctuation" };
  }

  const silenceCandidates: number[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].startMs - words[i].endMs;
    if (gap >= minSilenceMs && words[i].endMs >= lo && words[i].endMs <= hi) {
      silenceCandidates.push(words[i].endMs);
    }
  }
  if (silenceCandidates.length > 0) {
    silenceCandidates.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
    return { sec: silenceCandidates[0] / 1000, source: "silence" };
  }

  return { sec: targetSec, source: "signal" };
}

/**
 * Snap a start-boundary onto a natural entry point. Priority:
 *   1. A word that starts after a silence gap ≥ minSilenceMs (clean onset)
 *   2. A word that starts after sentence-ending punctuation (new sentence)
 *   3. The original target
 */
export function snapStartBoundary(
  words: WhisperWord[],
  targetSec: number,
  maxDriftSec: number,
  minSilenceMs: number,
): { sec: number; source: "silence" | "punctuation" | "signal" } {
  if (words.length === 0) return { sec: targetSec, source: "signal" };

  const targetMs = targetSec * 1000;
  const lo = targetMs - maxDriftSec * 1000;
  const hi = targetMs + maxDriftSec * 1000;

  const silenceStarts: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startMs - words[i - 1].endMs;
    if (gap >= minSilenceMs && words[i].startMs >= lo && words[i].startMs <= hi) {
      silenceStarts.push(words[i].startMs);
    }
  }
  if (silenceStarts.length > 0) {
    silenceStarts.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
    return { sec: silenceStarts[0] / 1000, source: "silence" };
  }

  const afterPunct: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const prev = stripTrailingJunk(words[i - 1].word);
    if (PUNCT_END.test(prev) && words[i].startMs >= lo && words[i].startMs <= hi) {
      afterPunct.push(words[i].startMs);
    }
  }
  if (afterPunct.length > 0) {
    afterPunct.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
    return { sec: afterPunct[0] / 1000, source: "punctuation" };
  }

  return { sec: targetSec, source: "signal" };
}

/**
 * Snap onto the nearest speaker-turn START inside the drift window.
 * Returns null when no turn boundary is close enough.
 */
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

/** Snap onto the nearest speaker-turn END inside the drift window. */
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

/**
 * Produce flash + content boundaries for a single padded clip.
 *
 * Falls back gracefully when whisper or audio data is unavailable: you still
 * get a sane clip, it just isn't snapped.
 */
export function computeAutoTrim(opts: ComputeAutoTrimOptions): PaddedWindow {
  const {
    paddedDurationSec,
    signalStartInClipSec,
    signalEndInClipSec,
    whisperWords,
    audioSamples,
    turns,
    maxDriftSec = 3,
    minSilenceMs = 300,
    flashWindowSec = 2,
  } = opts;

  const clampedSignalStart = Math.max(0, Math.min(signalStartInClipSec, paddedDurationSec));
  const clampedSignalEnd = Math.max(clampedSignalStart, Math.min(signalEndInClipSec, paddedDurationSec));

  // Flash: 2s peak-RMS window inside the signal range.
  const flash = audioSamples
    ? findPeakRmsWindow(audioSamples, clampedSignalStart, clampedSignalEnd, flashWindowSec)
    : {
        startSec: Math.max(0, (clampedSignalStart + clampedSignalEnd) / 2 - flashWindowSec / 2),
        endSec: Math.min(paddedDurationSec, (clampedSignalStart + clampedSignalEnd) / 2 + flashWindowSec / 2),
        source: "center-fallback" as const,
      };

  // Content boundaries. Priority for each edge:
  //   1. Speaker-turn change (cleanest cut — lands between sentences across speakers)
  //   2. Whisper silence gap
  //   3. Sentence-ending punctuation
  //   4. Original signal timestamp (no snap)
  const words = whisperWords ?? [];
  const availableTurns = turns ?? [];

  let startSec = clampedSignalStart;
  let startSource: PaddedWindow["notes"]["startSnap"] = "signal";
  const speakerStart = availableTurns.length
    ? snapToSpeakerStart(availableTurns, clampedSignalStart, maxDriftSec)
    : null;
  if (speakerStart != null) {
    startSec = speakerStart;
    startSource = "speaker";
  } else {
    const fallback = snapStartBoundary(words, clampedSignalStart, maxDriftSec, minSilenceMs);
    startSec = fallback.sec;
    startSource = fallback.source;
  }

  let endSec = clampedSignalEnd;
  let endSource: PaddedWindow["notes"]["endSnap"] = "signal";
  const speakerEnd = availableTurns.length
    ? snapToSpeakerEnd(availableTurns, clampedSignalEnd, maxDriftSec)
    : null;
  if (speakerEnd != null) {
    endSec = speakerEnd;
    endSource = "speaker";
  } else {
    const fallback = snapEndBoundary(words, clampedSignalEnd, maxDriftSec, minSilenceMs);
    endSec = fallback.sec;
    endSource = fallback.source;
  }

  let contentStart = Math.max(0, Math.min(startSec, paddedDurationSec));
  let contentEnd = Math.max(contentStart, Math.min(endSec, paddedDurationSec));

  // A pathological snap that collapses the clip below 5s means we found the
  // wrong thing — keep the signal boundaries rather than ship a broken clip.
  if (contentEnd - contentStart < 5) {
    contentStart = clampedSignalStart;
    contentEnd = clampedSignalEnd;
  }

  return {
    flashStart: flash.startSec,
    flashDuration: flash.endSec - flash.startSec,
    contentStart,
    contentEnd,
    contentDuration: contentEnd - contentStart,
    notes: {
      flashSource: flash.source,
      startSnap: startSource,
      endSnap: endSource,
    },
  };
}
