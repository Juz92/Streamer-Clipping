/**
 * pick-quality.ts - Normalize reviewed moments into setup/payoff instructions.
 *
 * This pass does not cut video. It writes a small, stable artifact that tells
 * downstream automation which candidate is suggested and which candidates need
 * more context before they should be trusted as the top pick.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import { canonicalizeMoment, chooseCanonicalMomentSource, loadValidatedGroundedPromoted } from "./lib/candidate-contract.js";
import { loadArcGrounding, type ArcGroundingResult } from "./lib/arc-grounding.js";

const log = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};

const MIN_ARC_DURATION_SEC = 10;
const IDEAL_ARC_MAX_SEC = 42;
const MAX_SINGLE_SEGMENT_SETUP_LOOKBACK_SEC = 45;
const MAX_NATURAL_END_EXTENSION_SEC = 30;
const SPEECH_SAFE_TAIL_SEC = 1.4;

interface CliArgs {
  streamId: string;
}

interface SetupRef {
  startSec: number;
  description?: string;
}

export interface SourceMoment {
  id?: string;
  momentId?: string;
  candidateId?: string;
  startSec: number;
  endSec: number;
  durationSec?: number;
  hook?: string;
  hookText?: string;
  description?: string;
  viralScore?: number;
  viralityScore?: number;
  archetype?: string;
  categories?: string[];
  setupNeeded?: boolean;
  setupRef?: SetupRef;
  coldOpenSec?: number;
  flashSec?: number;
  naturalEndSec?: number;
}

export interface PickQuality {
  rank: number;
  id: string;
  candidateId: string;
  momentId: string;
  source: "notebooklm" | "unified" | "grounded";
  status: "suggested" | "candidate" | "reserve";
  setupStartSec: number;
  premiseClearSec: number;
  buildUpStartSec: number;
  actionStartSec: number;
  payoffStartSec: number;
  payoffEndSec: number;
  reactionEndSec: number;
  flashSec: number;
  naturalEndSec: number;
  arcCompleteness: number;
  contextNeeded: boolean;
  groundingStatus: "GROUNDED" | "BLOCKED" | "MISSING";
  reasonSuggested: string;
  reasons: string[];
}

export interface PickQualityReport {
  streamId: string;
  generatedAt: string;
  source: "notebooklm" | "unified" | "grounded";
  suggestedRank: number | null;
  reserveRanks: number[];
  picks: PickQuality[];
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let streamId = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) streamId = args[++i];
  }

  if (!streamId) {
    log.error("Usage: pick-quality.ts --stream <id>");
    process.exit(1);
  }

  return { streamId };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function roundSec(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function hasContextHeavyCategory(moment: SourceMoment): boolean {
  const categories = moment.categories ?? [];
  return (
    categories.includes("story-of-stream") ||
    categories.includes("running-bit") ||
    categories.includes("callback") ||
    moment.archetype === "story-payoff"
  );
}

function sourceScore(moment: SourceMoment): number {
  const score = moment.viralScore ?? moment.viralityScore ?? 0;
  return isFiniteNumber(score) ? score : 0;
}

function formatSec(sec: number): string {
  return `${roundSec(sec).toFixed(2)}s`;
}

function normalizeEnd(moment: SourceMoment, startSec: number): { endSec: number; usedNaturalEnd: boolean } {
  const fallbackEnd = isFiniteNumber(moment.endSec) && moment.endSec > startSec
    ? moment.endSec
    : startSec + Math.max(MIN_ARC_DURATION_SEC, moment.durationSec ?? 24);
  const speechSafeEnd = (endSec: number) => endSec + SPEECH_SAFE_TAIL_SEC;

  if (
    isFiniteNumber(moment.naturalEndSec) &&
    moment.naturalEndSec > startSec + 3 &&
    moment.naturalEndSec <= fallbackEnd + MAX_NATURAL_END_EXTENSION_SEC
  ) {
    // ponytail: fixed tail, replace with word-level VTT snapping if this still clips syllables.
    return { endSec: speechSafeEnd(moment.naturalEndSec), usedNaturalEnd: true };
  }

  return { endSec: speechSafeEnd(fallbackEnd), usedNaturalEnd: false };
}

function normalizeFlash(moment: SourceMoment, startSec: number, endSec: number): { flashSec: number; usedFlashHint: boolean } {
  if (
    isFiniteNumber(moment.flashSec) &&
    moment.flashSec >= startSec &&
    moment.flashSec <= endSec
  ) {
    return { flashSec: moment.flashSec, usedFlashHint: true };
  }

  const duration = Math.max(MIN_ARC_DURATION_SEC, endSec - startSec);
  return {
    flashSec: clamp(startSec + duration * 0.68, startSec + 1, endSec - 0.5),
    usedFlashHint: false,
  };
}

function chooseSetupStart(
  moment: SourceMoment,
  rawStartSec: number,
  payoffStartSec: number,
): { setupStartSec: number; setupRefTooFar: boolean; usedExplicitSetup: boolean } {
  const setupRefSec = moment.setupRef?.startSec;
  if (
    isFiniteNumber(setupRefSec) &&
    setupRefSec <= payoffStartSec &&
    payoffStartSec - setupRefSec <= MAX_SINGLE_SEGMENT_SETUP_LOOKBACK_SEC
  ) {
    return { setupStartSec: setupRefSec, setupRefTooFar: false, usedExplicitSetup: true };
  }

  const setupRefTooFar =
    isFiniteNumber(setupRefSec) &&
    setupRefSec < payoffStartSec &&
    payoffStartSec - setupRefSec > MAX_SINGLE_SEGMENT_SETUP_LOOKBACK_SEC;

  if (
    isFiniteNumber(moment.coldOpenSec) &&
    moment.coldOpenSec <= payoffStartSec &&
    payoffStartSec - moment.coldOpenSec <= MAX_SINGLE_SEGMENT_SETUP_LOOKBACK_SEC
  ) {
    return { setupStartSec: moment.coldOpenSec, setupRefTooFar, usedExplicitSetup: true };
  }

  return { setupStartSec: rawStartSec, setupRefTooFar, usedExplicitSetup: false };
}

function scoreArc(params: {
  durationSec: number;
  setupDurationSec: number;
  payoffDurationSec: number;
  usedFlashHint: boolean;
  usedNaturalEnd: boolean;
  contextNeeded: boolean;
  setupRefTooFar: boolean;
  setupNeeded: boolean;
}): number {
  let score = 0.35;

  if (params.durationSec >= MIN_ARC_DURATION_SEC) score += 0.12;
  if (params.durationSec <= IDEAL_ARC_MAX_SEC) score += 0.12;
  else if (params.durationSec <= IDEAL_ARC_MAX_SEC + 12) score += 0.06;

  if (params.usedFlashHint) score += 0.16;
  if (params.usedNaturalEnd) score += 0.14;

  if (params.setupDurationSec >= 3) score += 0.1;
  else if (!params.setupNeeded) score += 0.05;

  if (params.payoffDurationSec >= 5) score += 0.08;
  if (!params.contextNeeded) score += 0.12;

  if (params.setupRefTooFar) score -= 0.18;
  if (params.contextNeeded) score -= 0.16;
  if (params.durationSec < MIN_ARC_DURATION_SEC) score -= 0.18;
  if (params.durationSec > IDEAL_ARC_MAX_SEC + 12) score -= 0.12;

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

function buildGroundedPickQuality(
  moment: SourceMoment,
  rank: number,
  source: "notebooklm" | "unified" | "grounded",
  grounding: ArcGroundingResult,
): PickQuality {
  const beats = grounding.beats;
  const fallbackStart = moment.startSec;
  const fallbackEnd = moment.endSec;
  const setupStartSec = isFiniteNumber(beats.setupStartSec) ? beats.setupStartSec : fallbackStart;
  const premiseClearSec = isFiniteNumber(beats.premiseClearSec) ? beats.premiseClearSec : setupStartSec;
  const actionStartSec = isFiniteNumber(beats.actionStartSec) ? beats.actionStartSec : premiseClearSec;
  const payoffStartSec = isFiniteNumber(beats.payoffStartSec) ? beats.payoffStartSec : actionStartSec;
  const payoffEndSec = isFiniteNumber(beats.payoffEndSec) ? beats.payoffEndSec : payoffStartSec;
  const reactionEndSec = isFiniteNumber(beats.reactionEndSec) ? beats.reactionEndSec : fallbackEnd;
  const flashSec = isFiniteNumber(beats.flashSec) ? beats.flashSec : payoffStartSec;
  const grounded = grounding.status === "GROUNDED"
    && grounding.gates.arcComplete
    && grounding.gates.contextIndependent
    && grounding.gates.visualProof !== false;
  const reasons = grounded
    ? [`source-grounded by ${grounding.localizer}`]
    : grounding.missingEvidence.length > 0
      ? grounding.missingEvidence
      : ["source grounding blocked"];
  const status: PickQuality["status"] = grounded ? "candidate" : "reserve";

  return {
    rank,
    id: `clip-${String(rank).padStart(2, "0")}`,
    candidateId: grounding.candidateId,
    momentId: grounding.momentId,
    source,
    status,
    setupStartSec: roundSec(setupStartSec),
    premiseClearSec: roundSec(premiseClearSec),
    buildUpStartSec: roundSec(actionStartSec),
    actionStartSec: roundSec(actionStartSec),
    payoffStartSec: roundSec(payoffStartSec),
    payoffEndSec: roundSec(payoffEndSec),
    reactionEndSec: roundSec(reactionEndSec),
    flashSec: roundSec(flashSec),
    naturalEndSec: roundSec(reactionEndSec),
    arcCompleteness: grounded ? 1 : 0,
    contextNeeded: !grounding.gates.contextIndependent,
    groundingStatus: grounding.status,
    reasonSuggested: `${grounded ? "Candidate" : "Reserve"}: ${reasons.join("; ")}`,
    reasons,
  };
}

export function buildPickQuality(
  moment: SourceMoment,
  rank: number,
  source: "notebooklm" | "unified" | "grounded",
  grounding?: ArcGroundingResult,
): PickQuality {
  if (grounding) return buildGroundedPickQuality(moment, rank, source, grounding);
  const rawStartSec = isFiniteNumber(moment.startSec) ? moment.startSec : 0;
  const { endSec, usedNaturalEnd } = normalizeEnd(moment, rawStartSec);
  const { flashSec, usedFlashHint } = normalizeFlash(moment, rawStartSec, endSec);
  const payoffStartSec = clamp(flashSec - 2, rawStartSec, Math.max(rawStartSec, endSec - 1));
  const { setupStartSec, setupRefTooFar, usedExplicitSetup } = chooseSetupStart(moment, rawStartSec, payoffStartSec);
  const buildUpStartSec = Math.max(setupStartSec, payoffStartSec - 8);
  const durationSec = endSec - setupStartSec;
  const setupDurationSec = payoffStartSec - setupStartSec;
  const payoffDurationSec = endSec - payoffStartSec;
  const setupNeeded = moment.setupNeeded === true || hasContextHeavyCategory(moment);
  const contextHeavyTooShort = hasContextHeavyCategory(moment) && durationSec < 22;
  const setupMissing = setupNeeded && setupDurationSec < 3 && !usedExplicitSetup;
  const contextNeeded = setupRefTooFar || setupMissing || contextHeavyTooShort;

  const reasons: string[] = [];
  if (usedFlashHint) reasons.push(`flash hint at ${formatSec(flashSec)}`);
  else reasons.push("no flash hint; estimated payoff from range");
  if (usedNaturalEnd) reasons.push(`natural end at ${formatSec(endSec)}`);
  else reasons.push("no natural-end hint; using candidate end");
  if (usedExplicitSetup) reasons.push(`setup starts at ${formatSec(setupStartSec)}`);
  if (setupRefTooFar) reasons.push("setup reference is too far back for a single continuous Short");
  if (setupMissing) reasons.push("setup is marked needed but missing from the usable window");
  if (contextHeavyTooShort) reasons.push("context-heavy moment needs more build-up before payoff");

  const arcCompleteness = scoreArc({
    durationSec,
    setupDurationSec,
    payoffDurationSec,
    usedFlashHint,
    usedNaturalEnd,
    contextNeeded,
    setupRefTooFar,
    setupNeeded,
  });

  const status: PickQuality["status"] =
    contextNeeded || arcCompleteness < 0.65 ? "reserve" : "candidate";

  const momentId = moment.momentId ?? moment.id;
  const candidateId = moment.candidateId ?? momentId;
  if (!momentId || !candidateId) {
    throw new Error(`Pick-quality moment at rank ${rank} is missing canonical identity`);
  }

  return {
    rank,
    id: `clip-${String(rank).padStart(2, "0")}`,
    candidateId,
    momentId,
    source,
    status,
    setupStartSec: roundSec(setupStartSec),
    premiseClearSec: roundSec(setupStartSec),
    buildUpStartSec: roundSec(buildUpStartSec),
    actionStartSec: roundSec(buildUpStartSec),
    payoffStartSec: roundSec(payoffStartSec),
    payoffEndSec: roundSec(endSec),
    reactionEndSec: roundSec(endSec),
    flashSec: roundSec(flashSec),
    naturalEndSec: roundSec(endSec),
    arcCompleteness,
    contextNeeded,
    groundingStatus: "MISSING",
    reasonSuggested: status === "reserve"
      ? `Reserve: ${reasons.join("; ")}`
      : `Candidate: ${reasons.join("; ")}`,
    reasons,
  };
}

export function buildPickQualityReport(
  streamId: string,
  source: "notebooklm" | "unified" | "grounded",
  moments: SourceMoment[],
  groundingByCandidate?: Map<string, ArcGroundingResult>,
): PickQualityReport {
  const picks = moments.map((moment, index) => {
    const grounding = moment.candidateId ? groundingByCandidate?.get(moment.candidateId) : undefined;
    if (groundingByCandidate && !grounding) {
      throw new Error(`No arc grounding for ${moment.candidateId ?? moment.id ?? `rank ${index + 1}`}`);
    }
    return buildPickQuality(moment, index + 1, source, grounding);
  });
  const suggested = [...picks]
    .filter((pick) => pick.status !== "reserve")
    .sort((a, b) => {
      if (b.arcCompleteness !== a.arcCompleteness) return b.arcCompleteness - a.arcCompleteness;
      const scoreDiff = sourceScore(moments[b.rank - 1]) - sourceScore(moments[a.rank - 1]);
      if (scoreDiff !== 0) return scoreDiff;
      return a.rank - b.rank;
    })[0] ?? null;

  if (suggested) {
    suggested.status = "suggested";
    suggested.reasonSuggested = `Suggested: best complete setup-payoff arc (${Math.round(suggested.arcCompleteness * 100)}%). ${suggested.reasons.join("; ")}`;
  }

  return {
    streamId,
    generatedAt: new Date().toISOString(),
    source,
    suggestedRank: suggested?.rank ?? null,
    reserveRanks: picks.filter((pick) => pick.status === "reserve").map((pick) => pick.rank),
    picks,
  };
}

function readNonEmptyMoments(path: string): SourceMoment[] | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as SourceMoment[];
  return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
}

function loadSourceMoments(streamDir: string): { source: "notebooklm" | "unified" | "grounded"; moments: SourceMoment[] } {
  const notebookMoments = readNonEmptyMoments(join(streamDir, "notebooklm-moments.json")) ?? [];
  const unifiedMoments = readNonEmptyMoments(join(streamDir, "unified-moments.json")) ?? [];
  const groundedPromoted = loadValidatedGroundedPromoted<SourceMoment>(streamDir);
  const momentsPath = join(streamDir, "moments.json");
  const scorer = existsSync(momentsPath)
    ? JSON.parse(readFileSync(momentsPath, "utf-8")) as Array<SourceMoment & {
        suggestedStartSec?: number;
        suggestedEndSec?: number;
        suggestedDurationSec?: number;
        signalOverlap?: number;
        scores?: { viralityScore?: number; composite?: number };
      }>
    : [];
  const scorerMoments = scorer.map((moment) => {
    const startSec = isFiniteNumber(moment.startSec) ? moment.startSec : moment.suggestedStartSec;
    const endSec = isFiniteNumber(moment.endSec) ? moment.endSec : moment.suggestedEndSec;
    const durationSec = moment.durationSec ?? moment.suggestedDurationSec;
    return {
      ...moment,
      startSec: isFiniteNumber(startSec) ? startSec : 0,
      endSec: isFiniteNumber(endSec)
        ? endSec
        : isFiniteNumber(startSec) && isFiniteNumber(durationSec)
          ? startSec + durationSec
          : isFiniteNumber(startSec)
            ? startSec + MIN_ARC_DURATION_SEC
            : MIN_ARC_DURATION_SEC,
      durationSec,
      viralityScore: moment.viralityScore ?? moment.viralScore ?? moment.scores?.viralityScore ?? moment.scores?.composite ?? moment.signalOverlap,
    };
  });

  const selected = chooseCanonicalMomentSource(notebookMoments, unifiedMoments, scorerMoments, groundedPromoted);
  if (selected.length === 0) {
    throw new Error(`No grounded-ranked-moments.json or legacy source moments in ${streamDir}`);
  }
  return {
    source: selected === groundedPromoted ? "grounded" : selected === notebookMoments ? "notebooklm" : "unified",
    moments: selected,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { findStreamDir, loadManifest } = await import("./lib/manifest.js");
  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) {
    log.error(`No stream dir found for ${args.streamId}`);
    process.exit(1);
  }

  const manifest = loadManifest(args.streamId);
  const { source, moments } = loadSourceMoments(streamDir);
  const jobId = basename(streamDir);
  const canonicalMoments = moments.map((moment) => ({
    ...moment,
    ...canonicalizeMoment(jobId, moment),
  }));
  const report = buildPickQualityReport(
    manifest.streamId,
    source,
    canonicalMoments,
    loadArcGrounding(streamDir),
  );
  const outPath = join(streamDir, "pick-quality.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

  log.info(`Wrote ${outPath}`);
  if (report.suggestedRank != null) {
    log.info(`Suggested clip: #${report.suggestedRank}`);
  } else {
    log.warn("No non-reserve suggested clip; all candidates need manual context review.");
  }
  if (report.reserveRanks.length > 0) {
    log.warn(`Reserve clips: ${report.reserveRanks.map((rank) => `#${rank}`).join(", ")}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("pick-quality.ts") || process.argv[1]?.endsWith("pick-quality.js")) {
  main().catch((err) => {
    log.error(err.message ?? String(err));
    process.exit(1);
  });
}
