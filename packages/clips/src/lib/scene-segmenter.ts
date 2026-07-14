/**
 * scene-segmenter.ts — Break a long stream into distinct "bits" / scenes.
 *
 * Uses multi-modal scene boundary detection:
 *   1. Silence gaps (> 1.5s) — natural pauses between bits
 *   2. Speaker turns — new speaker = new scene
 *   3. Energy valleys → peaks — setup/payoff arcs
 *   4. Chat dead zones → eruptions — audience reaction arcs
 *   5. Topic shifts — keyword dissimilarity between adjacent windows
 *
 * Each scene is a candidate container for humor-pattern detection.
 */

import type { AudioSample } from "./audio-analyzer.js";
import type { WhisperWord } from "./whisper-captions.js";
import type { ChatMessage } from "./chat-parser.js";
import type { SpeakerTurn } from "./diarize.js";

export interface Scene {
  id: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** Why this boundary was created */
  startReason: "silence" | "speaker-change" | "energy-valley" | "chat-eruption" | "topic-shift" | "stream-start";
  endReason: "silence" | "speaker-change" | "energy-valley" | "chat-eruption" | "topic-shift" | "stream-end";
  /** Audio characteristics */
  audio: {
    meanRms: number;
    maxRms: number;
    minRms: number;
    rmsRange: number;
    hasValleyToPeak: boolean; // setup→payoff arc
    valleyTimeSec?: number;
    peakTimeSec?: number;
  };
  /** Chat characteristics */
  chat: {
    messageCount: number;
    meanRate: number;
    maxRate: number;
    hasDeadToEruption: boolean; // quiet→explosion arc
    deadTimeSec?: number;
    eruptionTimeSec?: number;
    laughHits: number;
    shockHits: number;
  };
  /** Transcript characteristics */
  transcript: {
    wordCount: number;
    speakerChanges: number;
    topKeywords: string[];
    hasQuestion: boolean;
    hasExclamation: boolean;
  };
  /** Pre-computed for humor pattern detection */
  words: WhisperWord[];
  messages: ChatMessage[];
  samples: AudioSample[];
}

/* ── Constants ── */
const MIN_SCENE_DURATION = 12;     // scenes shorter than 12s can't contain a sustained viral arc
const MAX_SCENE_DURATION = 120;    // scenes longer than 2min are probably multiple bits
const SILENCE_GAP_MS = 1500;       // 1.5s silence = strong scene boundary
const ENERGY_VALLEY_THRESHOLD = -45; // dB — quiet enough to be a setup
const ENERGY_PEAK_THRESHOLD = -25;   // dB — loud enough to be a payoff
const CHAT_DEAD_THRESHOLD = 0.3;   // msg/s — quiet chat
const CHAT_ERUPTION_THRESHOLD = 3.0; // msg/s — chat explosion
const TOPIC_SHIFT_WINDOW_SEC = 15;  // compare keyword overlap across 15s windows
const TOPIC_SHIFT_THRESHOLD = 0.3;  // Jaccard similarity below this = topic shift

/* ── 1. SILENCE GAP DETECTION ── */
function findSilenceBoundaries(samples: AudioSample[]): number[] {
  const boundaries: number[] = [];
  let silenceStart: number | null = null;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.rmsLevel < -50) {
      if (silenceStart === null) silenceStart = s.timeSec;
    } else {
      if (silenceStart !== null) {
        const gapMs = (s.timeSec - silenceStart) * 1000;
        if (gapMs >= SILENCE_GAP_MS) {
          boundaries.push(silenceStart + (s.timeSec - silenceStart) / 2);
        }
        silenceStart = null;
      }
    }
  }

  return boundaries;
}

/* ── 2. SPEAKER TURN BOUNDARIES ── */
function findSpeakerBoundaries(turns: SpeakerTurn[] | null): number[] {
  if (!turns || turns.length === 0) return [];
  const boundaries: number[] = [];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].speaker !== turns[i - 1].speaker) {
      boundaries.push(turns[i].start);
    }
  }
  return boundaries;
}

/* ── 3. ENERGY VALLEY → PEAK ARCS ── */
function findEnergyBoundaries(samples: AudioSample[]): number[] {
  const boundaries: number[] = [];
  let inValley = false;
  let valleyStart = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!inValley && s.rmsLevel < ENERGY_VALLEY_THRESHOLD) {
      inValley = true;
      valleyStart = s.timeSec;
    }
    if (inValley && s.rmsLevel > ENERGY_PEAK_THRESHOLD) {
      // Valley→peak arc detected. Boundary at valley start.
      boundaries.push(valleyStart);
      inValley = false;
    }
    if (inValley && s.rmsLevel > ENERGY_VALLEY_THRESHOLD + 10) {
      // Exited valley without peak — reset
      inValley = false;
    }
  }

  return boundaries;
}

/* ── 4. CHAT DEAD → ERUPTION ARCS ── */
function findChatBoundaries(messages: ChatMessage[]): number[] {
  if (messages.length === 0) return [];
  const boundaries: number[] = [];

  // 5-second sliding window rates
  const windowSize = 5;
  const maxSec = messages[messages.length - 1].timestampSec;
  const rates: { startSec: number; rate: number }[] = [];

  for (let start = 0; start <= maxSec; start += windowSize) {
    const count = messages.filter(m => m.timestampSec >= start && m.timestampSec < start + windowSize).length;
    rates.push({ startSec: start, rate: count / windowSize });
  }

  let inDead = false;
  let deadStart = 0;

  for (let i = 0; i < rates.length; i++) {
    const r = rates[i];
    if (!inDead && r.rate < CHAT_DEAD_THRESHOLD) {
      inDead = true;
      deadStart = r.startSec;
    }
    if (inDead && r.rate > CHAT_ERUPTION_THRESHOLD) {
      boundaries.push(deadStart);
      inDead = false;
    }
    if (inDead && r.rate > CHAT_DEAD_THRESHOLD && r.rate < CHAT_ERUPTION_THRESHOLD) {
      // Exited dead zone without eruption — reset after 10s
      if (r.startSec - deadStart > 10) inDead = false;
    }
  }

  return boundaries;
}

/* ── 5. TOPIC SHIFT DETECTION ── */
function findTopicBoundaries(words: WhisperWord[]): number[] {
  if (words.length < 20) return [];
  const boundaries: number[] = [];

  // Build keyword sets per window
  const windows: { startSec: number; keywords: Set<string> }[] = [];

  const minSec = words[0].startMs / 1000;
  const maxSec = words[words.length - 1].startMs / 1000;

  for (let start = minSec; start <= maxSec; start += TOPIC_SHIFT_WINDOW_SEC) {
    const windowWords = words.filter(w => w.startMs / 1000 >= start && w.startMs / 1000 < start + TOPIC_SHIFT_WINDOW_SEC);
    const contentWords = windowWords
      .map(w => w.word.toLowerCase().replace(/[^a-z]/g, ""))
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));
    windows.push({ startSec: start, keywords: new Set(contentWords) });
  }

  for (let i = 1; i < windows.length; i++) {
    const prev = windows[i - 1];
    const curr = windows[i];
    const intersectionArr: string[] = [];
    const prevKeywordsArr: string[] = [];
    prev.keywords.forEach(function(k: string) { prevKeywordsArr.push(k); });
    prevKeywordsArr.forEach(function(k: string) {
      if (curr.keywords.has(k)) intersectionArr.push(k);
    });
    const unionArr: string[] = [];
    prevKeywordsArr.forEach(function(k: string) { unionArr.push(k); });
    const currKeywordsArr: string[] = [];
    curr.keywords.forEach(function(k: string) { currKeywordsArr.push(k); });
    currKeywordsArr.forEach(function(k: string) {
      if (unionArr.indexOf(k) === -1) unionArr.push(k);
    });
    const jaccard = unionArr.length > 0 ? intersectionArr.length / unionArr.length : 0;

    if (jaccard < TOPIC_SHIFT_THRESHOLD && prev.keywords.size > 5 && curr.keywords.size > 5) {
      boundaries.push(curr.startSec);
    }
  }

  return boundaries;
}

const STOP_WORDS = new Set([
  "this", "that", "with", "from", "they", "have", "will", "been", "were", "said", "each",
  "which", "their", "what", "about", "could", "would", "should", "there", "when",
  "where", "while", "because", "before", "after", "above", "below", "between",
  "through", "during", "before", "after", "above", "below", "into", "onto", "upon",
  "just", "like", "know", "think", "want", "need", "come", "time", "really", "actually",
  "something", "someone", "somebody", "somewhere", "thing", "things", "people", "person",
  "yeah", "okay", "right", "well", "look", "listen", "mean", "guess", "sure", "maybe",
  "probably", "definitely", "absolutely", "literally", "basically", "honestly",
]);

/* ── MERGE ALL BOUNDARIES INTO SCENES ── */
function mergeBoundaries(
  allBoundaries: Array<{ time: number; source: Scene["startReason"] }>,
  streamDurationSec: number,
): number[] {
  // Sort and deduplicate boundaries within 3s of each other
  allBoundaries.sort((a, b) => a.time - b.time);
  const merged: number[] = [];
  const mergedSources: Scene["startReason"][] = [];

  for (const b of allBoundaries) {
    if (b.time < 0 || b.time > streamDurationSec) continue;
    if (merged.length === 0 || b.time - merged[merged.length - 1] > 3) {
      merged.push(b.time);
      mergedSources.push(b.source);
    }
  }

  // Always include stream start and end
  if (merged.length === 0 || merged[0] > 1) {
    merged.unshift(0);
  }
  if (merged[merged.length - 1] < streamDurationSec - 1) {
    merged.push(streamDurationSec);
  }

  return merged;
}

/* ── ARC MERGING: Merge adjacent high-energy scenes into sustained arcs ── */
export interface SceneArc {
  id: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  scenes: Scene[]; // constituent scenes
  arcType: "panic-loop" | "escalation" | "repetition" | "multi-roast" | "sustained-energy";
  /** Arc-level scores (higher than individual scenes) */
  arcScore: number;
}

const ARC_MERGE_WINDOW_SEC = 15; // merge scenes within 15s if both high-energy
const ARC_MAX_DURATION = 90; // cap arcs at 90s — longer than that is multiple bits

function shouldMergeScenes(a: Scene, b: Scene): boolean {
  // Merge if gap is small and both scenes have strong signals
  const gap = b.startSec - a.endSec;
  if (gap > ARC_MERGE_WINDOW_SEC) return false;
  if (gap < -5) return false; // overlapping, skip

  // Both need some energy signal — stricter thresholds
  const aHasEnergy = a.audio.maxRms > -28 || a.chat.maxRate > 3 || a.chat.laughHits + a.chat.shockHits > 5;
  const bHasEnergy = b.audio.maxRms > -28 || b.chat.maxRate > 3 || b.chat.laughHits + b.chat.shockHits > 5;

  return aHasEnergy && bHasEnergy;
}

function findDistinctiveRepeatedPhrase(merged: Scene[]): string | null {
  const words = merged
    .flatMap((scene) => scene.words)
    .map((word) => ({
      token: word.word.toLowerCase().replace(/[^a-z0-9']/g, ""),
      timeSec: word.startMs / 1000,
    }))
    .filter((word) => word.token)
    .sort((a, b) => a.timeSec - b.timeSec);
  const genericCommand = /^(all right|come on|get him|go go|hold the gate|i'?m dead|let'?s go|oh my god|no way|we'?re holding)$/;

  for (let size = 5; size >= 2; size--) {
    const counts = new Map<string, number>();
    for (let i = 0; i <= words.length - size; i++) {
      const slice = words.slice(i, i + size);
      if (slice.some((word, index) => index > 0 && word.timeSec - slice[index - 1].timeSec > 1.5)) continue;
      const phrase = slice.map((word) => word.token).join(" ");
      if (genericCommand.test(phrase)) continue;
      const hasDistinctiveWord = slice.some((word) => word.token.length >= 4 && !STOP_WORDS.has(word.token));
      if (!hasDistinctiveWord) continue;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
    const repeated = Array.from(counts.entries()).find(([, count]) => count >= 3)?.[0];
    if (repeated) return repeated;
  }

  return null;
}

function detectArcType(merged: Scene[]): SceneArc["arcType"] {
  // Repetition must be a recurring phrase, not a common word that naturally
  // appears several times inside a 90-second conversation.
  if (findDistinctiveRepeatedPhrase(merged)) return "repetition";

  // Check for panic loop: escalating audio + chat shock words
  const hasEscalation = merged.some((s, i) => i > 0 && s.audio.maxRms > merged[i - 1].audio.maxRms + 5);
  const hasShockWords = merged.some(s => s.messages.some(m => /\b(omg|wtf|no way|holy|gasp|nah|crazy|insane)\b/i.test(m.text)));
  if (hasEscalation && hasShockWords) return "panic-loop";

  // Check for multi-roast: multiple roast patterns
  const roastCount = merged.filter(s => s.messages.some(m => /\b(you're|you are|your|trash|garbage|dog|sus|cringe|weird|ugly|bald|short|fat|old|stupid|dumb|idiot|loser)\b/i.test(m.text))).length;
  if (roastCount >= 2) return "multi-roast";

  // Default: sustained energy
  return "sustained-energy";
}

export function mergeScenesIntoArcs(scenes: Scene[]): SceneArc[] {
  if (scenes.length === 0) return [];

  // Sort by start time
  const sorted = [...scenes].sort((a, b) => a.startSec - b.startSec);
  const arcs: SceneArc[] = [];
  let currentArc: Scene[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentArc[currentArc.length - 1];
    const curr = sorted[i];
    const projectedDuration = curr.endSec - currentArc[0].startSec;

    if (projectedDuration <= ARC_MAX_DURATION && shouldMergeScenes(prev, curr)) {
      currentArc.push(curr);
    } else {
      // Finalize current arc
      if (currentArc.length >= 2) {
        const startSec = currentArc[0].startSec;
        const endSec = currentArc[currentArc.length - 1].endSec;
        const arcType = detectArcType(currentArc);
        // Arc score: higher than individual scenes because sustained arcs are viral gold
        // BUT: cap at 0.85 so truly exceptional individual scenes can still win
        const baseScores = currentArc.map(s => {
          const chatScore = Math.min((s.chat.laughHits + s.chat.shockHits) / 10, 1) * 0.35;
          const audioScore = Math.min(s.audio.rmsRange / 35, 1) * 0.25;
          const energyScore = s.audio.maxRms > -25 ? 0.25 : s.audio.maxRms > -35 ? 0.12 : 0;
          return chatScore + audioScore + energyScore;
        });
        const avgScore = baseScores.reduce((a, b) => a + b, 0) / baseScores.length;
        // Bonus for arc length: 20-45s arcs are ideal for Shorts
        const durationBonus = Math.min((endSec - startSec) / 45, 1) * 0.10;
        // Bonus for multi-scene: more scenes = more sustained = more viral
        const multiSceneBonus = Math.min((currentArc.length - 1) * 0.03, 0.09);
        const arcScore = Math.min(avgScore + durationBonus + multiSceneBonus, 0.85);

        arcs.push({
          id: `arc-${String(arcs.length + 1).padStart(3, "0")}`,
          startSec,
          endSec,
          durationSec: endSec - startSec,
          scenes: [...currentArc],
          arcType,
          arcScore,
        });
      }
      currentArc = [curr];
    }
  }

  // Finalize last arc
  if (currentArc.length >= 2) {
    const startSec = currentArc[0].startSec;
    const endSec = currentArc[currentArc.length - 1].endSec;
    const arcType = detectArcType(currentArc);
    const baseScores = currentArc.map(s => {
      const chatScore = Math.min((s.chat.laughHits + s.chat.shockHits) / 10, 1) * 0.35;
      const audioScore = Math.min(s.audio.rmsRange / 35, 1) * 0.25;
      const energyScore = s.audio.maxRms > -25 ? 0.25 : s.audio.maxRms > -35 ? 0.12 : 0;
      return chatScore + audioScore + energyScore;
    });
    const avgScore = baseScores.reduce((a, b) => a + b, 0) / baseScores.length;
    const durationBonus = Math.min((endSec - startSec) / 45, 1) * 0.10;
    const multiSceneBonus = Math.min((currentArc.length - 1) * 0.03, 0.09);
    const arcScore = Math.min(avgScore + durationBonus + multiSceneBonus, 0.85);

    arcs.push({
      id: `arc-${String(arcs.length + 1).padStart(3, "0")}`,
      startSec,
      endSec,
      durationSec: endSec - startSec,
      scenes: [...currentArc],
      arcType,
      arcScore,
    });
  }

  return arcs;
}

/* ── BUILD SCENE OBJECTS ── */
function buildScenes(
  boundaries: number[],
  samples: AudioSample[],
  words: WhisperWord[],
  messages: ChatMessage[],
  turns: SpeakerTurn[] | null,
): Scene[] {
  const scenes: Scene[] = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSec = boundaries[i];
    const endSec = boundaries[i + 1];
    const durationSec = endSec - startSec;

    if (durationSec < MIN_SCENE_DURATION) continue;

    // Slice data for this scene
    const sceneSamples = samples.filter(s => s.timeSec >= startSec && s.timeSec < endSec);
    const sceneWords = words.filter(w => w.startMs / 1000 >= startSec && w.startMs / 1000 < endSec);
    const sceneMessages = messages.filter(m => m.timestampSec >= startSec && m.timestampSec < endSec);
    const sceneTurns = turns?.filter(t => t.start >= startSec && t.end < endSec) ?? [];

    // Audio stats
    const rmsValues = sceneSamples.map(s => s.rmsLevel);
    const meanRms = rmsValues.length > 0 ? rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length : -100;
    const maxRms = rmsValues.length > 0 ? Math.max(...rmsValues) : -100;
    const minRms = rmsValues.length > 0 ? Math.min(...rmsValues) : -100;
    const rmsRange = maxRms - minRms;

    // Find valley→peak arc
    let hasValleyToPeak = false;
    let valleyTime: number | undefined;
    let peakTime: number | undefined;
    for (let j = 0; j < sceneSamples.length; j++) {
      if (sceneSamples[j].rmsLevel < ENERGY_VALLEY_THRESHOLD) {
        for (let k = j + 1; k < sceneSamples.length; k++) {
          if (sceneSamples[k].rmsLevel > ENERGY_PEAK_THRESHOLD) {
            hasValleyToPeak = true;
            valleyTime = sceneSamples[j].timeSec;
            peakTime = sceneSamples[k].timeSec;
            break;
          }
          if (sceneSamples[k].rmsLevel > ENERGY_VALLEY_THRESHOLD + 15) break;
        }
      }
      if (hasValleyToPeak) break;
    }

    // Chat stats
    const chatWindowSize = 5;
    let maxRate = 0;
    let meanRate = 0;
    let laughHits = 0;
    let shockHits = 0;
    if (sceneMessages.length > 0) {
      const rates: number[] = [];
      for (let t = startSec; t < endSec; t += chatWindowSize) {
        const count = sceneMessages.filter(m => m.timestampSec >= t && m.timestampSec < t + chatWindowSize).length;
        rates.push(count / chatWindowSize);
      }
      maxRate = rates.length > 0 ? Math.max(...rates) : 0;
      meanRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

      const CHAT_LAUGH_RE = /\b(?:l+o+l+|lmao+|lmfao+|rofl|haha+|hehe+|omegalul|kekw|dead|dying|crying)\b/gi;
      const CHAT_SHOCK_RE = /\b(?:wtf|omg|no way|bro what|what the|holy|gasp|nah|crazy|insane)\b/gi;
      for (const m of sceneMessages) {
        laughHits += m.text.match(CHAT_LAUGH_RE)?.length ?? 0;
        shockHits += m.text.match(CHAT_SHOCK_RE)?.length ?? 0;
      }
    }

    // Find dead→eruption arc
    let hasDeadToEruption = false;
    let deadTime: number | undefined;
    let eruptionTime: number | undefined;
    if (sceneMessages.length > 0) {
      for (let t = startSec; t < endSec - 10; t += 2) {
        const earlyRate = sceneMessages.filter(m => m.timestampSec >= t && m.timestampSec < t + 5).length / 5;
        const lateRate = sceneMessages.filter(m => m.timestampSec >= t + 5 && m.timestampSec < t + 10).length / 5;
        if (earlyRate < CHAT_DEAD_THRESHOLD && lateRate > CHAT_ERUPTION_THRESHOLD) {
          hasDeadToEruption = true;
          deadTime = t;
          eruptionTime = t + 5;
          break;
        }
      }
    }

    // Transcript stats
    const contentWords = sceneWords
      .map(w => w.word.toLowerCase().replace(/[^a-z]/g, ""))
      .filter(w => w.length > 2);
    const wordFreq = new Map<string, number>();
    for (const w of contentWords) {
      wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
    }
    const topKeywords = Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);

    const hasQuestion = sceneWords.some(w => w.word.includes("?"));
    const hasExclamation = sceneWords.some(w => /[!?]{2,}/.test(w.word) || (w.word === w.word.toUpperCase() && w.word.length > 2));

    scenes.push({
      id: `scene-${String(i + 1).padStart(3, "0")}`,
      startSec,
      endSec,
      durationSec,
      startReason: i === 0 ? "stream-start" : "silence", // simplified — could track actual source
      endReason: i === boundaries.length - 2 ? "stream-end" : "silence",
      audio: {
        meanRms,
        maxRms,
        minRms,
        rmsRange,
        hasValleyToPeak,
        valleyTimeSec: valleyTime,
        peakTimeSec: peakTime,
      },
      chat: {
        messageCount: sceneMessages.length,
        meanRate,
        maxRate,
        hasDeadToEruption,
        deadTimeSec: deadTime,
        eruptionTimeSec: eruptionTime,
        laughHits,
        shockHits,
      },
      transcript: {
        wordCount: sceneWords.length,
        speakerChanges: sceneTurns.length,
        topKeywords,
        hasQuestion,
        hasExclamation,
      },
      words: sceneWords,
      messages: sceneMessages,
      samples: sceneSamples,
    });
  }

  return scenes;
}

/* ── MAIN EXPORT ── */
export function segmentStreamIntoScenes(
  samples: AudioSample[],
  words: WhisperWord[],
  messages: ChatMessage[],
  turns: SpeakerTurn[] | null,
  streamDurationSec: number,
): Scene[] {
  const allBoundaries: Array<{ time: number; source: Scene["startReason"] }> = [];

  // Collect boundaries from all sources
  for (const t of findSilenceBoundaries(samples)) {
    allBoundaries.push({ time: t, source: "silence" });
  }
  for (const t of findSpeakerBoundaries(turns)) {
    allBoundaries.push({ time: t, source: "speaker-change" });
  }
  for (const t of findEnergyBoundaries(samples)) {
    allBoundaries.push({ time: t, source: "energy-valley" });
  }
  for (const t of findChatBoundaries(messages)) {
    allBoundaries.push({ time: t, source: "chat-eruption" });
  }
  for (const t of findTopicBoundaries(words)) {
    allBoundaries.push({ time: t, source: "topic-shift" });
  }

  const boundaries = mergeBoundaries(allBoundaries, streamDurationSec);
  return buildScenes(boundaries, samples, words, messages, turns);
}
