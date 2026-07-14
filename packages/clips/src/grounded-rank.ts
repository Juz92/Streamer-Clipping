/** Grounded-only explainable ranking and promotion gate. */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "@ltx/shared";
import { loadArcGrounding } from "./lib/arc-grounding.js";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import { normalizeContentLane } from "./lib/content-lanes.js";

const log = createLogger("grounded-rank");
const HOLDOUT_K = 5;

export interface RankCandidate {
  candidateId: string;
  jobId: string;
  momentId: string;
  streamId: string;
  startSec: number;
  endSec: number;
  description?: string;
  categories?: string[];
  sourceScores?: Record<string, number>;
  recallScore?: number;
  laneScore?: number;
  viralScore?: number;
  routeEvidence?: Array<{ score?: number }>;
  marketPrior?: number | null;
}

export interface TasteLabel {
  streamId: string;
  candidateId: string;
  lane: string;
  status: "keep" | "reject" | "reserve";
  reaction: "lol" | "smiled" | "nothing" | "context-missing";
  editorialStrength?: number;
}

export interface RankedCandidate extends RankCandidate {
  editorialStrength: number;
  justinTaste: number | null;
  marketPrior: number | null;
}

export interface GroundedRankingReport {
  version: 1;
  generatedAt: string;
  gate: {
    status: "WAITING_FOR_LABELS" | "FAIL" | "PASS";
    labelSource: "private-review";
    labels: number;
    required: number;
    streams: number;
    meanTasteAt5: number | null;
    beatsEditorialOnStreams: number;
    requiredEditorialWins: number;
    holdouts: Array<{
      streamId: string;
      labels: number;
      tasteAt5: number;
      editorialAt5: number;
    }>;
  };
  ranked: RankedCandidate[];
  promoted: RankedCandidate[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function candidateLane(candidate: RankCandidate): string {
  for (const category of candidate.categories ?? []) {
    const lane = normalizeContentLane(category.replace(/^lane:/, ""));
    if (lane) return lane;
  }
  return "unclassified";
}

function editorialStrength(candidate: RankCandidate): number {
  const scores = [
    ...Object.values(candidate.sourceScores ?? {}),
    candidate.recallScore,
    candidate.laneScore,
    candidate.viralScore,
    ...(candidate.routeEvidence ?? []).map((evidence) => evidence.score),
  ].filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  if (scores.length === 0) return 0;
  return clamp01(Math.max(...scores.map((score) => score > 1 ? score / 100 : score)));
}

function tasteTarget(label: TasteLabel): number {
  return label.reaction === "lol" ? 1 : label.reaction === "smiled" ? 0.5 : 0;
}

function trainLaneMeans(labels: TasteLabel[]): { global: number; lanes: Map<string, number> } {
  const global = labels.length > 0
    ? labels.reduce((sum, label) => sum + tasteTarget(label), 0) / labels.length
    : 0.5;
  const groups = new Map<string, number[]>();
  for (const label of labels) {
    const values = groups.get(label.lane) ?? [];
    values.push(tasteTarget(label));
    groups.set(label.lane, values);
  }
  return {
    global,
    lanes: new Map([...groups].map(([lane, values]) => [
      lane,
      values.reduce((sum, value) => sum + value, 0) / values.length,
    ])),
  };
}

function predictTaste(model: ReturnType<typeof trainLaneMeans>, lane: string): number {
  return model.lanes.get(lane) ?? model.global;
}

function meanTarget(labels: TasteLabel[]): number {
  return labels.length > 0
    ? labels.reduce((sum, label) => sum + tasteTarget(label), 0) / labels.length
    : 0;
}

function evaluateHoldouts(labels: TasteLabel[]): GroundedRankingReport["gate"]["holdouts"] {
  const streamIds = [...new Set(labels.map((label) => label.streamId))].sort();
  return streamIds.flatMap((streamId) => {
    const train = labels.filter((label) => label.streamId !== streamId);
    const test = labels.filter((label) =>
      label.streamId === streamId && Number.isFinite(label.editorialStrength),
    );
    if (train.length === 0 || test.length < HOLDOUT_K + 1) return [];
    const model = trainLaneMeans(train);
    const k = Math.min(HOLDOUT_K, test.length);
    const tasteTop = [...test]
      .sort((a, b) => predictTaste(model, b.lane) - predictTaste(model, a.lane))
      .slice(0, k);
    const editorialTop = [...test]
      .sort((a, b) => (b.editorialStrength ?? 0) - (a.editorialStrength ?? 0))
      .slice(0, k);
    return [{
      streamId,
      labels: test.length,
      tasteAt5: meanTarget(tasteTop),
      editorialAt5: meanTarget(editorialTop),
    }];
  });
}

export function buildGroundedRanking(params: {
  candidates: RankCandidate[];
  grounding: Map<string, { status: string }>;
  labels: TasteLabel[];
  minimumLabels?: number;
}): GroundedRankingReport {
  const minimumLabels = params.minimumLabels ?? 10;
  const currentStreams = new Set(params.candidates.map((candidate) => candidate.streamId));
  const labels = params.labels.filter((label) => !currentStreams.has(label.streamId));
  const labelsByStream = new Map<string, number>();
  for (const label of labels) {
    labelsByStream.set(label.streamId, (labelsByStream.get(label.streamId) ?? 0) + 1);
  }
  const streamCount = labelsByStream.size;
  const minimumHoldoutLabels = HOLDOUT_K + 1; // One candidate must remain outside the measured top K.
  const holdoutsReady = streamCount >= 2
    && [...labelsByStream.values()].every((count) => count >= minimumHoldoutLabels);
  const requiredLabels = Math.max(minimumLabels, streamCount * minimumHoldoutLabels);
  const holdouts = labels.length >= requiredLabels && holdoutsReady
    ? evaluateHoldouts(labels)
    : [];
  const meanTasteAt5 = holdouts.length > 0
    ? holdouts.reduce((sum, row) => sum + row.tasteAt5, 0) / holdouts.length
    : null;
  const wins = holdouts.filter((row) => row.tasteAt5 > row.editorialAt5).length;
  const requiredWins = Math.ceil(holdouts.length * 2 / 3);
  const completeHoldouts = holdouts.length === streamCount;
  const gateStatus = labels.length < requiredLabels || !holdoutsReady
    ? "WAITING_FOR_LABELS" as const
    : !completeHoldouts
      ? "FAIL" as const
      : holdouts.length > 0 && (meanTasteAt5 ?? 0) >= 0.6 && wins >= requiredWins
        ? "PASS" as const
        : "FAIL" as const;
  const model = gateStatus === "PASS" ? trainLaneMeans(labels) : null;

  const ranked = params.candidates
    .filter((candidate) => params.grounding.get(candidate.candidateId)?.status === "GROUNDED")
    .map((candidate): RankedCandidate => ({
      ...candidate,
      editorialStrength: editorialStrength(candidate),
      justinTaste: model ? predictTaste(model, candidateLane(candidate)) : null,
      marketPrior: candidate.marketPrior == null ? null : clamp01(candidate.marketPrior),
    }))
    .sort((a, b) => model
      ? (b.justinTaste ?? 0) - (a.justinTaste ?? 0)
        || b.editorialStrength - a.editorialStrength
        || (b.marketPrior ?? -1) - (a.marketPrior ?? -1)
      : b.editorialStrength - a.editorialStrength
        || (b.marketPrior ?? -1) - (a.marketPrior ?? -1));

  const promoted = gateStatus === "PASS"
    ? ranked.filter((candidate) =>
        (candidate.justinTaste ?? 0) >= 0.6 && candidate.editorialStrength >= 0.6,
      ).slice(0, 3)
    : [];

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    gate: {
      status: gateStatus,
      labelSource: "private-review",
      labels: labels.length,
      required: requiredLabels,
      streams: streamCount,
      meanTasteAt5,
      beatsEditorialOnStreams: wins,
      requiredEditorialWins: requiredWins,
      holdouts,
    },
    ranked,
    promoted,
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function marketPrior(candidate: Record<string, unknown>): number | null {
  const performance = candidate.youtubePerformance as { mature72h?: boolean; averageViewPercentage?: number } | undefined;
  return performance?.mature72h && Number.isFinite(performance.averageViewPercentage)
    ? clamp01((performance.averageViewPercentage as number) / 100)
    : null;
}

function main(): void {
  const streamIndex = process.argv.indexOf("--stream");
  const streamId = streamIndex >= 0 ? process.argv[streamIndex + 1] : undefined;
  if (!streamId) throw new Error("Usage: grounded-rank.ts --stream <id>");
  const streamDir = findStreamDir(streamId);
  if (!streamDir) throw new Error(`No stream directory found for ${streamId}`);
  const manifest = loadManifest(streamId);
  const jobId = basename(manifest.jobDir);
  const union = readJson<RankCandidate[]>(join(streamDir, "recall-union.json"));
  const poolPath = join(process.cwd(), "data", "clips", "candidate-pool.json");
  const pool = existsSync(poolPath)
    ? readJson<{ candidates?: Array<Record<string, unknown> & { candidateId: string }> }>(poolPath).candidates ?? []
    : [];
  const poolByCandidate = new Map(pool.map((candidate) => [candidate.candidateId, candidate]));
  const candidates = union.map((candidate) => ({
    ...candidate,
    jobId,
    streamId,
    marketPrior: marketPrior(poolByCandidate.get(candidate.candidateId) ?? {}),
  }));
  const feedbackPath = join(process.cwd(), "data", "clips", "manual-review-feedback.json");
  const feedbackArtifact = existsSync(feedbackPath)
    ? readJson<{ version?: number; records?: Array<{ streamId: string; decisions?: TasteLabel[] }> }>(feedbackPath)
    : {};
  const feedback = feedbackArtifact.version === 2 ? feedbackArtifact.records ?? [] : [];
  const labels = feedback.flatMap((record) => (record.decisions ?? [])
    .filter((decision) =>
      normalizeContentLane(decision.lane) != null
      && ["keep", "reject", "reserve"].includes(decision.status)
      && ["lol", "smiled", "nothing", "context-missing"].includes(decision.reaction),
    )
    .map((decision) => {
      const baseline = poolByCandidate.get(decision.candidateId);
      return {
        ...decision,
        streamId: record.streamId,
        editorialStrength: baseline
          ? editorialStrength(baseline as unknown as RankCandidate)
          : undefined,
      };
    }));
  const report = buildGroundedRanking({
    candidates,
    grounding: loadArcGrounding(streamDir),
    labels,
    minimumLabels: Number(process.env.MIN_TASTE_LABELS ?? 10),
  });
  const reportPath = join(streamDir, "grounded-ranking.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  const derivativePath = join(streamDir, "grounded-ranked-moments.json");
  if (report.gate.status === "PASS") {
    writeFileSync(derivativePath, JSON.stringify(report.promoted, null, 2), "utf-8");
  } else if (existsSync(derivativePath)) {
    unlinkSync(derivativePath);
  }
  log.info(`Grounded ranking: ${report.gate.status}; eligible=${report.ranked.length}; promoted=${report.promoted.length}`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("grounded-rank.ts") || process.argv[1]?.endsWith("grounded-rank.js")) {
  try {
    main();
  } catch (error) {
    log.error((error as Error).message);
    process.exit(1);
  }
}
