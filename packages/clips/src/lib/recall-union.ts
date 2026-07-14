import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeMoment, type CandidateIdentity } from "./candidate-contract.js";
import {
  loadPool,
  savePool,
  type CandidatePointer,
} from "./candidate-pool.js";

export type RecallSource = "semantic" | "scorer" | "manual" | "twitch-clip";

export interface RecallAnchor {
  momentId: string;
  routes: string[];
  source: RecallSource;
  startSec: number;
  endSec: number;
  description: string;
  score?: number;
  categories?: string[];
}

export interface RecallRouteEvidence {
  momentId: string;
  source: RecallSource;
  routes: string[];
  startSec: number;
  endSec: number;
  score?: number;
}

export interface RecallUnionCandidate {
  candidateId: string;
  jobId: string;
  momentId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  description: string;
  recallScore?: number;
  categories: string[];
  recallRoutes: string[];
  routeEvidence: RecallRouteEvidence[];
}

export interface SemanticRecallCandidate {
  id?: string;
  momentId?: string;
  candidateId?: string;
  startSec: number;
  endSec: number;
  hook: string;
  quote?: string;
  categories: string[];
  sourceQuery: string;
  sourceQueries?: string[];
  viralSubScores?: Record<string, unknown>;
}

export interface ScorerRecallMoment {
  id: string;
  suggestedStartSec: number;
  suggestedEndSec: number;
  description: string;
  scores?: { composite?: number; chatIntensity?: number; audioMagnitude?: number };
  transcriptSignals?: unknown[];
  chatSignals?: unknown[];
  audioSignals?: unknown[];
  contentLane?: string;
  payoffType?: string;
  laneScore?: number;
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function makeSemanticRecallMomentId(candidate: SemanticRecallCandidate): string {
  if (candidate.momentId?.trim()) return candidate.momentId.trim();
  if (candidate.id?.trim()) return candidate.id.trim();
  const routes = [...new Set(candidate.sourceQueries?.length ? candidate.sourceQueries : [candidate.sourceQuery])].sort();
  const digest = createHash("sha256")
    .update(JSON.stringify({ hook: normalizedText(candidate.hook), quote: normalizedText(candidate.quote), routes }))
    .digest("hex")
    .slice(0, 12);
  return `recall-${digest}`;
}

export function identifySemanticRecallCandidates<T extends SemanticRecallCandidate>(
  jobId: string,
  candidates: T[],
): Array<T & CandidateIdentity & { recallRoutes: string[] }> {
  const identified = candidates.map((candidate) => {
    const recallRoutes = [...new Set(candidate.sourceQueries?.length ? candidate.sourceQueries : [candidate.sourceQuery])].sort();
    return {
      ...candidate,
      ...canonicalizeMoment(jobId, { momentId: makeSemanticRecallMomentId(candidate), candidateId: candidate.candidateId }),
      recallRoutes,
    };
  });
  const ids = new Set(identified.map((candidate) => candidate.candidateId));
  if (ids.size !== identified.length) {
    throw new Error("Semantic recall produced duplicate content identities");
  }
  return identified;
}

export function buildRecallUnion(
  jobId: string,
  semanticCandidates: SemanticRecallCandidate[],
  scorerMoments: ScorerRecallMoment[],
): RecallUnionCandidate[] {
  const semanticAnchors: RecallAnchor[] = semanticCandidates.map((candidate) => {
    const routes = [...new Set(candidate.sourceQueries?.length ? candidate.sourceQueries : [candidate.sourceQuery])]
      .map((route) => `semantic:${route}`)
      .sort();
    const blended = candidate.viralSubScores?.blendedFinal;
    return {
      momentId: makeSemanticRecallMomentId(candidate),
      routes,
      source: "semantic",
      startSec: candidate.startSec,
      endSec: candidate.endSec,
      description: candidate.hook,
      score: typeof blended === "number" ? blended : undefined,
      categories: candidate.categories,
    };
  });

  const scorerAnchors: RecallAnchor[] = scorerMoments.map((moment) => {
    const routes = ["scorer"];
    if ((moment.transcriptSignals?.length ?? 0) > 0) routes.push("transcript-signal");
    if ((moment.chatSignals?.length ?? 0) > 0 || (moment.scores?.chatIntensity ?? 0) > 0) routes.push("chat-eruption");
    if ((moment.audioSignals?.length ?? 0) > 0 || (moment.scores?.audioMagnitude ?? 0) > 0) routes.push("audio-peak");
    if (moment.contentLane) routes.push(`lane:${moment.contentLane}`);
    if (moment.payoffType) routes.push(`payoff:${moment.payoffType}`);
    return {
      momentId: moment.id,
      routes,
      source: "scorer",
      startSec: moment.suggestedStartSec,
      endSec: moment.suggestedEndSec,
      description: moment.description,
      score: typeof moment.laneScore === "number" ? moment.laneScore * 100 : (moment.scores?.composite ?? 0) * 10,
      categories: [moment.contentLane, moment.payoffType].filter((value): value is string => Boolean(value)),
    };
  });

  return mergeRecallAnchors(jobId, [...semanticAnchors, ...scorerAnchors]);
}

export function resolveRecallUnionCandidate(
  union: RecallUnionCandidate[],
  routeMomentId: string,
): RecallUnionCandidate {
  const matches = union.filter((candidate) =>
    candidate.momentId === routeMomentId
    || candidate.routeEvidence.some((evidence) => evidence.momentId === routeMomentId),
  );
  if (matches.length !== 1) {
    throw new Error(`Recall route ${routeMomentId} resolves to ${matches.length} union candidates`);
  }
  return matches[0];
}

export interface SyncRecallUnionPoolOptions {
  poolPath: string;
  jobId: string;
  streamId: string;
  streamDate: string;
  union: RecallUnionCandidate[];
}

export function syncRecallUnionToPool(options: SyncRecallUnionPoolOptions): void {
  const now = new Date().toISOString();
  const existingPool = loadPool(options.poolPath);
  const existingById = new Map(
    existingPool.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const pointers: CandidatePointer[] = options.union.map((candidate) => {
    const existing = existingById.get(candidate.candidateId);
    return {
      candidateId: candidate.candidateId,
      jobId: candidate.jobId,
      momentId: candidate.momentId,
      streamId: options.streamId,
      streamDate: options.streamDate,
      categories: candidate.categories,
      viralScore: candidate.recallScore ?? 0,
      startSec: candidate.startSec,
      endSec: candidate.endSec,
      durationSec: candidate.durationSec,
      hook: candidate.description,
      recallRoutes: candidate.recallRoutes,
      routeEvidence: candidate.routeEvidence,
      status: existing?.status ?? "pending",
      statusUpdatedAt: existing?.statusUpdatedAt ?? now,
      postedDate: existing?.postedDate,
      youtubeVideoId: existing?.youtubeVideoId,
      youtubeUrl: existing?.youtubeUrl,
      youtubePerformance: existing?.youtubePerformance,
      weeklyCompilationId: existing?.weeklyCompilationId,
    };
  });
  const immutableIds = new Set(
    existingPool.candidates
      .filter((candidate) =>
        candidate.jobId === options.jobId
        && ["posted-daily", "posted-weekly", "archived"].includes(candidate.status),
      )
      .map((candidate) => candidate.candidateId),
  );
  existingPool.candidates = existingPool.candidates.filter(
    (candidate) => candidate.jobId !== options.jobId || immutableIds.has(candidate.candidateId),
  );
  existingPool.candidates.push(
    ...pointers.filter((candidate) => !immutableIds.has(candidate.candidateId)),
  );
  savePool(options.poolPath, existingPool);
}

export interface PersistRecallUnionOptions<T extends SemanticRecallCandidate> {
  jobDir: string;
  jobId: string;
  streamId: string;
  streamDate: string;
  semanticCandidates: T[];
  poolPath: string;
}

export function persistRecallUnion<T extends SemanticRecallCandidate>(
  options: PersistRecallUnionOptions<T>,
): {
  semanticCandidates: Array<T & CandidateIdentity & { recallRoutes: string[] }>;
  union: RecallUnionCandidate[];
} {
  const identified = identifySemanticRecallCandidates(options.jobId, options.semanticCandidates);
  writeFileSync(join(options.jobDir, "recall-candidates.json"), JSON.stringify(identified, null, 2), "utf-8");

  const signalRecallPath = join(options.jobDir, "signal-recall.json");
  const scorerPath = existsSync(signalRecallPath) ? signalRecallPath : join(options.jobDir, "moments.json");
  const scorerMoments = existsSync(scorerPath)
    ? JSON.parse(readFileSync(scorerPath, "utf-8")) as ScorerRecallMoment[]
    : [];
  const union = buildRecallUnion(options.jobId, identified, scorerMoments);
  writeFileSync(join(options.jobDir, "recall-union.json"), JSON.stringify(union, null, 2), "utf-8");

  syncRecallUnionToPool({
    poolPath: options.poolPath,
    jobId: options.jobId,
    streamId: options.streamId,
    streamDate: options.streamDate,
    union,
  });

  return { semanticCandidates: identified, union };
}

function validAnchor(anchor: RecallAnchor): void {
  if (!anchor.momentId.trim()) throw new Error("Recall anchor requires a moment id");
  if (!Number.isFinite(anchor.startSec) || !Number.isFinite(anchor.endSec) || anchor.endSec <= anchor.startSec) {
    throw new Error(`Recall anchor ${anchor.momentId} has an invalid source window`);
  }
  if (anchor.routes.length === 0 || anchor.routes.some((route) => !route.trim())) {
    throw new Error(`Recall anchor ${anchor.momentId} requires route provenance`);
  }
}

function sameArc(candidate: RecallUnionCandidate, anchor: RecallAnchor): boolean {
  if (candidate.momentId === anchor.momentId) return true;
  const intersection = Math.max(0, Math.min(candidate.endSec, anchor.endSec) - Math.max(candidate.startSec, anchor.startSec));
  const shorterDuration = Math.min(candidate.durationSec, anchor.endSec - anchor.startSec);
  return intersection >= shorterDuration * 0.5 || Math.abs(candidate.startSec - anchor.startSec) <= 10;
}

function evidenceFor(anchor: RecallAnchor): RecallRouteEvidence {
  return {
    momentId: anchor.momentId,
    source: anchor.source,
    routes: [...new Set(anchor.routes)].sort(),
    startSec: anchor.startSec,
    endSec: anchor.endSec,
    score: anchor.score,
  };
}

function mergeInto(candidate: RecallUnionCandidate, anchor: RecallAnchor): void {
  candidate.startSec = Math.min(candidate.startSec, anchor.startSec);
  candidate.endSec = Math.max(candidate.endSec, anchor.endSec);
  candidate.durationSec = candidate.endSec - candidate.startSec;
  candidate.recallScore = Math.max(candidate.recallScore ?? Number.NEGATIVE_INFINITY, anchor.score ?? Number.NEGATIVE_INFINITY);
  if (candidate.recallScore === Number.NEGATIVE_INFINITY) delete candidate.recallScore;
  candidate.categories = [...new Set([...candidate.categories, ...(anchor.categories ?? [])])].sort();
  candidate.recallRoutes = [...new Set([...candidate.recallRoutes, ...anchor.routes])].sort();
  if (!candidate.routeEvidence.some((evidence) => evidence.momentId === anchor.momentId && evidence.source === anchor.source)) {
    candidate.routeEvidence.push(evidenceFor(anchor));
  }
}

/**
 * Build the high-recall candidate union. This stage deliberately does not rank
 * or cap output; later stages ground and rank the complete candidate set.
 */
export function mergeRecallAnchors(jobId: string, anchors: RecallAnchor[]): RecallUnionCandidate[] {
  const union: RecallUnionCandidate[] = [];

  for (const anchor of anchors) {
    validAnchor(anchor);
    const matches = union
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => sameArc(candidate, anchor));

    if (matches.length === 0) {
      const identity = canonicalizeMoment(jobId, { momentId: anchor.momentId });
      union.push({
        ...identity,
        startSec: anchor.startSec,
        endSec: anchor.endSec,
        durationSec: anchor.endSec - anchor.startSec,
        description: anchor.description,
        recallScore: anchor.score,
        categories: [...new Set(anchor.categories ?? [])].sort(),
        recallRoutes: [...new Set(anchor.routes)].sort(),
        routeEvidence: [evidenceFor(anchor)],
      });
      continue;
    }

    const primary = matches[0].candidate;
    mergeInto(primary, anchor);
    for (const { candidate } of matches.slice(1)) {
      for (const evidence of candidate.routeEvidence) {
        mergeInto(primary, {
          momentId: evidence.momentId,
          source: evidence.source,
          routes: evidence.routes,
          startSec: evidence.startSec,
          endSec: evidence.endSec,
          description: candidate.description,
          score: evidence.score,
          categories: candidate.categories,
        });
      }
    }
    for (const { index } of matches.slice(1).sort((a, b) => b.index - a.index)) union.splice(index, 1);
  }

  return union.sort((a, b) => a.startSec - b.startSec || a.candidateId.localeCompare(b.candidateId));
}
