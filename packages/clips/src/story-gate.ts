/**
 * story-gate.ts — hard editorial gate before render/upload.
 *
 * Scores each selected moment for self-contained short quality:
 * setup → escalation/payoff → clean exit. Writes story-gates.json and exits
 * non-zero when any selected clip is too risky unless --warn-only is passed.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "@ltx/shared";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import { hasFirstThreeSecondHook } from "./quality-gates.js";
import { passesAutomaticDiscoveryFloor } from "./lib/content-lanes.js";
export { hasFirstThreeSecondHook } from "./quality-gates.js";

const log = createLogger("story-gate");

type GateStatus = "PASS" | "RECUT" | "REPLACE" | "BLOCK";
type SignalSource = "transcript" | "chat" | "audio";

interface TranscriptSignalLike {
  timestampSec: number;
  weight: number;
}

interface ChatSignalLike {
  timestampSec: number;
  spikeIntensity: number;
}

interface AudioSignalLike {
  timestampSec: number;
  deltaFromAvg: number;
}

interface MomentLike {
  id?: string;
  rank?: number;
  startSec?: number;
  endSec?: number;
  durationSec?: number;
  suggestedStartSec?: number;
  suggestedEndSec?: number;
  suggestedDurationSec?: number;
  description?: string;
  hook?: string;
  hookText?: string;
  quote?: string;
  categories?: string[];
  setupNeeded?: boolean;
  archetype?: string;
  viralScore?: number;
  viralityScore?: number;
  rescueReason?: string;
  funnyQuote?: boolean;
  humorPotential?: number;
  laughOutLoudScore?: number;
  contentLane?: string;
  payoffType?: string;
  laneScore?: number;
  laughDetection?: number;
  shockReaction?: number;
  chatSync?: number;
  reactionChain?: number;
  rubric?: Record<string, unknown>;
  viralSubScores?: Record<string, unknown>;
  transcriptSignals?: TranscriptSignalLike[];
  chatSignals?: ChatSignalLike[];
  audioSignals?: AudioSignalLike[];
  scores?: {
    eventDensity?: number;
    narrativeMomentum?: number;
    emotionalPeak?: number;
    composite?: number;
  };
}

interface TrimEntry {
  rank: number;
  clipFile: string;
  flashDuration?: number;
  contentDuration?: number;
  totalDuration?: number;
  notes?: string;
}

interface SignalEvent {
  timestampSec: number;
  source: SignalSource;
  strength: number;
}

interface SignalMetrics {
  setupSignal: number;
  middleSignal: number;
  payoffSignal: number;
  narrativeMomentum: number;
  eventCount: number;
  eventDensityPerMinute: number;
  emotionalPeakSecondHalf: boolean;
}

interface GateResult {
  rank: number;
  momentId: string;
  status: GateStatus;
  score: number;
  reasons: string[];
  recommendedAction: string;
  signalMetrics?: SignalMetrics;
}

function parseArgs(): { streamId?: string; minScore: number; warnOnly: boolean; clips?: number[] } {
  const args = process.argv.slice(2);
  const out: { streamId?: string; minScore: number; warnOnly: boolean; clips?: number[] } = {
    minScore: 65,
    warnOnly: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) out.streamId = args[++i];
    else if (args[i] === "--min-score" && args[i + 1]) out.minScore = parseInt(args[++i], 10);
    else if (args[i] === "--warn-only") out.warnOnly = true;
    else if (args[i] === "--clips" && args[i + 1]) out.clips = args[++i].split(",").map((s) => parseInt(s.trim(), 10));
  }
  return out;
}

export function chooseMomentSource(
  notebookMoments: MomentLike[],
  unifiedMoments: MomentLike[],
  scorerMoments: MomentLike[],
): MomentLike[] {
  const hasLaneMetadata = scorerMoments.some((moment) =>
    typeof moment.contentLane === "string" && typeof moment.laneScore === "number"
  );
  if (hasLaneMetadata) return scorerMoments;
  if (notebookMoments.length > 0) return notebookMoments;
  if (unifiedMoments.length > 0) return unifiedMoments;
  return scorerMoments;
}

function loadMomentArray(path: string): MomentLike[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(parsed) ? parsed : [];
}

function loadMoments(streamDir: string): MomentLike[] {
  const notebookMoments = loadMomentArray(join(streamDir, "notebooklm-moments.json"));
  const unifiedMoments = loadMomentArray(join(streamDir, "unified-moments.json"));
  const scorerMoments = loadMomentArray(join(streamDir, "moments.json"));
  const selected = chooseMomentSource(notebookMoments, unifiedMoments, scorerMoments);
  if (selected.length > 0) return selected;
  throw new Error("No notebooklm-moments.json, unified-moments.json, or moments.json found");
}

function loadSignalMoments(streamDir: string): MomentLike[] {
  const path = join(streamDir, "moments.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadTrimEntries(streamDir: string): TrimEntry[] {
  const trimPath = join(streamDir, "trim-results.json");
  if (!existsSync(trimPath)) return [];
  const trim = JSON.parse(readFileSync(trimPath, "utf-8")) as { approved?: TrimEntry[] };
  return trim.approved ?? [];
}

function parseTimecodeSeconds(timecode: string): number | undefined {
  const parts = timecode.split(":").map((p) => Number(p));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseTrimNotes(notes: string | undefined): {
  setup?: number;
  payoff?: number;
  audioPeak?: number;
  sourceStart?: number;
  sourceEnd?: number;
} {
  const out: { setup?: number; payoff?: number; audioPeak?: number; sourceStart?: number; sourceEnd?: number } = {};
  if (!notes) return out;
  const setup = notes.match(/setup:([\d.]+)/);
  const payoff = notes.match(/payoff:([\d.]+)/);
  const audioPeak = notes.match(/audioPeak=([\d.]+)/);
  const source = notes.match(/source=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)-(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (setup) out.setup = parseFloat(setup[1]);
  if (payoff) out.payoff = parseFloat(payoff[1]);
  if (audioPeak) out.audioPeak = parseFloat(audioPeak[1]);
  if (source) {
    out.sourceStart = parseTimecodeSeconds(source[1]);
    out.sourceEnd = parseTimecodeSeconds(source[2]);
  }
  return out;
}

function hasAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

/** Story completeness is necessary, but it must not promote generic action. */
export function hasLaughOutLoudEvidence(moment: MomentLike): boolean {
  const comedyCategory = (moment.categories ?? []).some((category) => [
    "humor",
    "dry-joke",
    "absurdist",
    "reaction-gold",
    "friend-roast",
    "roast",
    "one-liner",
    "quotable",
    "running-bit",
    "callback",
  ].includes(category));

  return (
    (moment.laughOutLoudScore ?? 0) >= 0.65 ||
    (moment.funnyQuote === true && (moment.humorPotential ?? 0) >= 0.72) ||
    ((moment.laughDetection ?? 0) >= 0.75 && (moment.chatSync ?? 0) >= 0.65) ||
    (comedyCategory && ((moment.humorPotential ?? 0) >= 0.7 || (moment.reactionChain ?? 0) >= 0.65))
  );
}

/** Accept the strongest lane-specific payoff; unclassified legacy artifacts keep the LOL gate. */
export function hasDiscoveryPayoffEvidence(moment: MomentLike): boolean {
  if (moment.contentLane) {
    return passesAutomaticDiscoveryFloor({
      contentLane: moment.contentLane,
      payoffType: moment.payoffType,
      laneScore: moment.laneScore,
      laughOutLoudScore: moment.laughOutLoudScore,
    });
  }
  return hasLaughOutLoudEvidence(moment);
}

function hasStrongPayoffLanguage(text: string): boolean {
  return hasAny(text, [
    "absolute cinema",
    "it worked",
    "we won",
    "won.",
    "picasso",
    "peak content",
    "take a picture",
    "screenshot",
    "clutch",
    "caught",
    // Streamer-chaos payoffs: no-chat runs still need transcript shock/quote
    // language to count as an emotional peak when the VTT captures the actual
    // reaction. Without this, good combat panic clips get rejected unless chat
    // or a large audio spike happens in the second half.
    "no way",
    "what the",
    "oh my god",
    "holy",
    "i'm dead",
    "im dead",
    "get him",
    "beat his",
    "my ass",
    "panic",
    "chaos",
  ]);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function momentStart(moment: MomentLike): number | undefined {
  return moment.startSec ?? moment.suggestedStartSec;
}

function momentEnd(moment: MomentLike): number | undefined {
  return moment.endSec ?? moment.suggestedEndSec;
}

function overlapSec(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function findSignalMoment(moment: MomentLike, signalMoments: MomentLike[]): MomentLike | undefined {
  const start = momentStart(moment);
  const end = momentEnd(moment);
  if (start == null || end == null || signalMoments.length === 0) return undefined;

  let best: { moment: MomentLike; score: number } | undefined;
  for (const candidate of signalMoments) {
    const cStart = momentStart(candidate);
    const cEnd = momentEnd(candidate);
    if (cStart == null || cEnd == null) continue;
    const overlap = overlapSec(start, end, cStart, cEnd);
    const distance = Math.abs(cStart - start);
    const score = overlap * 10 - distance;
    if (!best || score > best.score) best = { moment: candidate, score };
  }

  return best && best.score > -45 ? best.moment : undefined;
}

function collectSignalEvents(
  signalMoment: MomentLike | undefined,
  trimNotes: ReturnType<typeof parseTrimNotes>,
  startSec: number,
  endSec: number,
): SignalEvent[] {
  const events: SignalEvent[] = [];
  const padStart = startSec - 2;
  const padEnd = endSec + 2;

  for (const sig of signalMoment?.transcriptSignals ?? []) {
    if (sig.timestampSec >= padStart && sig.timestampSec <= padEnd) {
      events.push({ timestampSec: sig.timestampSec, source: "transcript", strength: clamp01(sig.weight) });
    }
  }
  for (const sig of signalMoment?.chatSignals ?? []) {
    if (sig.timestampSec >= padStart && sig.timestampSec <= padEnd) {
      events.push({ timestampSec: sig.timestampSec, source: "chat", strength: clamp01(sig.spikeIntensity / 5) });
    }
  }
  for (const sig of signalMoment?.audioSignals ?? []) {
    if (sig.timestampSec >= padStart && sig.timestampSec <= padEnd) {
      events.push({ timestampSec: sig.timestampSec, source: "audio", strength: clamp01(sig.deltaFromAvg / 30) });
    }
  }

  if (trimNotes.audioPeak != null && trimNotes.audioPeak >= padStart && trimNotes.audioPeak <= padEnd) {
    events.push({ timestampSec: trimNotes.audioPeak, source: "audio", strength: 1 });
  }

  return events.sort((a, b) => a.timestampSec - b.timestampSec);
}

function distinctEventCount(events: SignalEvent[]): number {
  // Count temporal beats, not duplicate source detections in the same beat.
  return new Set(events.map((e) => String(Math.floor(e.timestampSec / 5)))).size;
}

function calculateSignalMetrics(
  events: SignalEvent[],
  startSec: number,
  endSec: number,
  text: string,
): SignalMetrics {
  const duration = Math.max(endSec - startSec, 1);
  const firstBreak = startSec + duration / 3;
  const secondBreak = startSec + (duration * 2) / 3;
  const midpoint = startSec + duration / 2;
  let setupSignal = 0;
  let middleSignal = 0;
  let payoffSignal = 0;

  for (const event of events) {
    if (event.timestampSec < firstBreak) {
      setupSignal = Math.max(setupSignal, event.strength);
    } else if (event.timestampSec < secondBreak) {
      middleSignal = Math.max(middleSignal, event.strength);
    } else {
      payoffSignal = Math.max(payoffSignal, event.strength);
    }
  }

  const payoffNearSetup = payoffSignal >= setupSignal * 0.85 && payoffSignal >= 0.5;
  const narrativeMomentum = payoffSignal > setupSignal
    ? clamp01(0.25 + ((payoffSignal - setupSignal) / Math.max(setupSignal, 0.25)) * 0.4 + (payoffSignal >= middleSignal * 0.95 ? 0.35 : 0))
    : payoffNearSetup && (middleSignal >= setupSignal * 0.7 || hasStrongPayoffLanguage(text))
      ? 0.45
      : 0;

  const eventCount = distinctEventCount(events);
  const eventDensityPerMinute = eventCount / Math.max(duration / 60, 0.25);
  const emotionalPeakSecondHalf =
    events.some((e) => e.timestampSec >= midpoint && e.strength >= 0.75) ||
    events.some((e) => e.timestampSec >= midpoint && e.source !== "transcript" && e.strength >= 0.5) ||
    hasStrongPayoffLanguage(text);

  return {
    setupSignal,
    middleSignal,
    payoffSignal,
    narrativeMomentum,
    eventCount,
    eventDensityPerMinute,
    emotionalPeakSecondHalf,
  };
}

function scoreMoment(
  moment: MomentLike,
  rank: number,
  trim?: TrimEntry,
  signalMoment?: MomentLike,
): GateResult {
  let score = 100;
  const reasons: string[] = [];
  let forceBlock = false;
  const notes = parseTrimNotes(trim?.notes);
  const startSec = notes.sourceStart ?? moment.startSec ?? moment.suggestedStartSec;
  const endSec = notes.sourceEnd ?? moment.endSec ?? moment.suggestedEndSec;
  const duration = trim?.totalDuration ?? trim?.contentDuration ?? moment.durationSec ?? (startSec != null && endSec != null ? endSec - startSec : undefined);
  const hook = moment.hook ?? moment.hookText ?? "";
  const desc = moment.description ?? "";
  const quote = moment.quote ?? "";
  const text = [hook, desc, quote, (moment.categories ?? []).join(" ")].join(" ");
  const categories = moment.categories ?? [];
  let signalMetrics: SignalMetrics | undefined;
  let events: SignalEvent[] = [];

  if (!Number.isFinite(duration) || duration == null || duration <= 0) {
    score -= 45;
    reasons.push("No valid duration available");
  } else {
    if (duration < 10) {
      score -= 25;
      reasons.push(`Too short to tell a mini-story (${duration.toFixed(1)}s)`);
    } else if (duration < 14) {
      score -= 10;
      reasons.push(`Very short; payoff must be instantly clear (${duration.toFixed(1)}s)`);
    }
    if (duration > 45) {
      score -= 20;
      reasons.push(`Too long for the current Daily Peanut target (${duration.toFixed(1)}s)`);
    }
  }

  if (startSec != null && endSec != null && endSec > startSec) {
    events = collectSignalEvents(signalMoment, notes, startSec, endSec);
    if (events.length > 0) {
      signalMetrics = calculateSignalMetrics(events, startSec, endSec, text);

      const payoffMateriallyLower = signalMetrics.payoffSignal + 0.05 < signalMetrics.setupSignal;
      if (payoffMateriallyLower && !hasStrongPayoffLanguage(text)) {
        score -= 45;
        forceBlock = true;
        reasons.push(
          `Payoff signal is materially weaker than setup signal (setup ${signalMetrics.setupSignal.toFixed(2)}, payoff ${signalMetrics.payoffSignal.toFixed(2)})`,
        );
      }
      if (signalMetrics.narrativeMomentum < 0.35) {
        score -= 16;
        reasons.push(`Weak narrative momentum (${signalMetrics.narrativeMomentum.toFixed(2)})`);
      }
      if (signalMetrics.eventCount < 2 || signalMetrics.eventDensityPerMinute < 4) {
        score -= 18;
        reasons.push(
          `Sparse event density (${signalMetrics.eventCount} distinct beats, ${signalMetrics.eventDensityPerMinute.toFixed(1)}/min)`,
        );
      }
      if (!signalMetrics.emotionalPeakSecondHalf) {
        score -= 15;
        reasons.push("No audio/chat eruption or strong payoff language in the second half");
      }
    }

    if (!hasFirstThreeSecondHook({ startSec, text: [hook, desc, quote].join(" "), flashDuration: trim?.flashDuration, events })) {
      score -= 22;
      reasons.push("Weak first 3 seconds — no flash, early signal, or strong hook text");
    }
  }

  if (hook.trim().length < 8 && desc.trim().length < 20) {
    score -= 18;
    reasons.push("Weak hook/description — unclear why this clip matters");
  }

  const hasEngagementSignal =
    moment.funnyQuote ||
    (moment.laneScore ?? 0) >= 0.7 ||
    (moment.payoffType != null && moment.payoffType !== "none") ||
    (moment.humorPotential ?? 0) >= 0.65 ||
    (moment.laughDetection ?? 0) >= 0.65 ||
    (moment.shockReaction ?? 0) >= 0.65 ||
    (moment.chatSync ?? 0) >= 0.65 ||
    (moment.reactionChain ?? 0) >= 0.65 ||
    hasAny(text, ["laugh", "lol", "lmao", "haha", "hilarious", "scream", "wtf", "what the", "roast", "meltdown", "rage", "insane", "caught", "payoff", "funny"]);

  if (!quote && !hasEngagementSignal) {
    score -= 28;
    reasons.push("Calm-conversation penalty — no obvious lane payoff, quote, reaction, or story signal");
  } else if (!hasEngagementSignal) {
    score -= 16;
    reasons.push("Quote exists but lane payoff/reaction signal is weak");
  } else if (moment.funnyQuote || (moment.laughDetection ?? 0) >= 0.8 || (moment.chatSync ?? 0) >= 0.8) {
    score += 6;
    reasons.push("Humor-first gate boost: funny quote/laugh/chat-sync signal present");
  }

  if (!hasDiscoveryPayoffEvidence(moment)) {
    score -= 35;
    forceBlock = true;
    reasons.push("Discovery floor failed — no strong lane-specific or LOL payoff evidence");
  }

  if (moment.setupNeeded && duration != null && duration < 22) {
    score -= 14;
    reasons.push("Marked setup-needed but duration is too short for context");
  }

  if (categories.some((c) => ["running-bit", "callback", "story-of-stream"].includes(c)) && !moment.setupNeeded && duration != null && duration < 18) {
    score -= 10;
    reasons.push("Callback/running-bit clip may lack context");
  }

  if (notes.setup != null && notes.setup < 2.5 && moment.setupNeeded) {
    score -= 16;
    reasons.push(`Setup segment too thin for setup-needed clip (${notes.setup.toFixed(1)}s)`);
  }
  if (notes.payoff != null && notes.payoff < 5) {
    score -= 18;
    reasons.push(`Payoff segment too short (${notes.payoff.toFixed(1)}s)`);
  }
  if (notes.setup != null && notes.payoff != null && notes.payoff <= notes.setup) {
    const severePayoffMissing = notes.payoff < 4 && !hasStrongPayoffLanguage(text);
    if (severePayoffMissing) {
      forceBlock = true;
      score -= 35;
      reasons.push(`Payoff segment is too thin and weaker than setup (${notes.payoff.toFixed(1)}s <= ${notes.setup.toFixed(1)}s)`);
    } else {
      score -= 10;
      reasons.push(`Setup is longer than payoff; keep an eye on pacing (${notes.payoff.toFixed(1)}s <= ${notes.setup.toFixed(1)}s)`);
    }
  }

  const viralScore = moment.viralScore ?? moment.viralityScore ?? 0;
  if (viralScore >= 80 && !forceBlock) score += 5;
  if (viralScore > 0 && viralScore < 45) {
    score -= 12;
    reasons.push(`Low virality score (${viralScore})`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let status: GateStatus = "PASS";
  let recommendedAction = "Proceed to render";
  if (forceBlock || score < 40) {
    status = "BLOCK";
    recommendedAction = "Do not render/upload; pick a different moment";
  } else if (score < 55) {
    status = "REPLACE";
    recommendedAction = "Prefer alternate candidate unless manually approved";
  } else if (score < 65) {
    status = "RECUT";
    recommendedAction = "Recut for clearer setup/payoff before render";
  }

  return {
    rank,
    momentId: moment.id ?? `moment-${rank}`,
    status,
    score,
    reasons,
    recommendedAction,
    signalMetrics,
  };
}

function main(): void {
  const args = parseArgs();
  if (!args.streamId) {
    log.error("Usage: story-gate.ts --stream <id> [--min-score 65] [--clips 1,2] [--warn-only]");
    process.exit(1);
  }

  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) {
    log.error(`No stream dir found for ${args.streamId}`);
    process.exit(1);
  }
  const manifest = loadManifest(args.streamId);
  const moments = loadMoments(streamDir);
  const signalMoments = loadSignalMoments(streamDir);
  const trims = loadTrimEntries(streamDir);

  const selected = moments
    .map((m, i) => ({ moment: m, rank: i + 1 }))
    .filter(({ rank }) => !args.clips || args.clips.includes(rank));

  if (selected.length === 0) {
    log.error("No selected moments to gate");
    process.exit(1);
  }

  const results = selected.map(({ moment, rank }) => scoreMoment(
    moment,
    rank,
    trims.find((t) => t.rank === rank),
    findSignalMoment(moment, signalMoments),
  ));

  // Upgrade threshold status when the CLI min score is higher than the built-in tiers.
  for (const r of results) {
    if (r.score < args.minScore && r.status === "PASS") {
      r.status = "RECUT";
      r.recommendedAction = `Recut or manually approve; below min score ${args.minScore}`;
      r.reasons.push(`Below configured min score ${args.minScore}`);
    }
  }

  const blocked = results.filter((r) => r.status === "BLOCK");
  const replace = results.filter((r) => r.status === "REPLACE");
  const recut = results.filter((r) => r.status === "RECUT");
  const pass = results.filter((r) => r.status === "PASS");

  for (const r of results) {
    const msg = `[${String(r.rank).padStart(2, "0")}] ${r.status} score=${r.score} — ${r.reasons.join("; ") || "story gate clear"}`;
    if (r.status === "PASS") log.info(msg);
    else if (r.status === "RECUT") log.warn(msg);
    else log.error(msg);
  }

  const outPath = join(streamDir, "story-gates.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        streamId: manifest.streamId,
        checkedAt: new Date().toISOString(),
        minScore: args.minScore,
        pass,
        recut,
        replace,
        blocked,
        results,
      },
      null,
      2,
    ),
    "utf-8",
  );
  log.info(`Wrote ${outPath}`);

  if ((blocked.length > 0 || replace.length > 0 || recut.length > 0) && !args.warnOnly) {
    log.error(`Story gate failed: ${blocked.length} block, ${replace.length} replace, ${recut.length} recut.`);
    process.exit(1);
  }
  log.info(`Story gate passed: ${pass.length}/${results.length} clip(s).`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("story-gate.ts") || process.argv[1]?.endsWith("story-gate.js")) {
  main();
}
