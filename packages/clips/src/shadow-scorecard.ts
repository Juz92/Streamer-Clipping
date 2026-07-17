import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoldCorpus, type GoldCorpus, type GoldCorpusRecord } from "./gold-corpus.js";
import { findStreamDir } from "./lib/manifest.js";

interface RecallCandidate {
  candidateId?: string;
  recallRoutes?: string[];
  categories?: string[];
}

interface GroundingResult {
  candidateId?: string;
  status?: string;
}

interface RankedCandidate {
  candidateId?: string;
  rank?: number;
  editorialStrength?: number;
}

interface RankingReport {
  gate?: { status?: string; labelSource?: string };
  ranked?: RankedCandidate[];
}

interface PrivateSelection {
  candidates?: Array<{ candidateId?: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function countValues(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function tasteScore(record: GoldCorpusRecord): number {
  if (record.status === "reject" || record.reaction == null) return 0;
  if (record.reaction === "lol" || record.reaction === "wow") return 1;
  return record.reaction === "smiled" ? 0.5 : 0;
}

function baselineBenchmark(clipsRoot: string, corpus: GoldCorpus): {
  status: "WAITING_FOR_LABELS" | "MEASURED";
  blockers: string[];
  streams?: Array<{ streamId: string; labels: number; tasteAt5: number }>;
  meanTasteAt5?: number;
} {
  const graded = corpus.records.filter((record) => record.labelStrength === "graded");
  const byStream = new Map<string, GoldCorpusRecord[]>();
  for (const record of graded) {
    const rows = byStream.get(record.streamId) ?? [];
    rows.push(record);
    byStream.set(record.streamId, rows);
  }
  const blockers: string[] = [];
  if (corpus.summary.gradedStreams < 3) {
    blockers.push(`Need ${3 - corpus.summary.gradedStreams} more graded streams`);
  }
  if (byStream.size === 0 || [...byStream.values()].some((records) => records.length < 6)) {
    blockers.push("Need at least 6 graded candidates per held-out stream");
  }
  if (blockers.length > 0) return { status: "WAITING_FOR_LABELS", blockers };

  const streams = [...byStream.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([streamId, records]) => {
    const jobIds = new Set(records.map((record) => record.jobId));
    if (jobIds.size !== 1) throw new Error(`Baseline stream ${streamId} spans multiple jobs`);
    const reportPath = join(clipsRoot, [...jobIds][0], "grounded-ranking.json");
    if (!existsSync(reportPath)) throw new Error(`Baseline stream ${streamId} has no grounded ranking report`);
    const report = readJson<RankingReport>(reportPath);
    const scoreByCandidate = new Map((report.ranked ?? []).map((candidate) => [
      candidate.candidateId,
      candidate.editorialStrength,
    ]));
    const comparable = records.filter((record) => Number.isFinite(scoreByCandidate.get(record.candidateId)));
    if (comparable.length < 6) {
      throw new Error(`Baseline stream ${streamId} has fewer than six score-aligned labels`);
    }
    comparable.sort((a, b) =>
      (scoreByCandidate.get(b.candidateId)! - scoreByCandidate.get(a.candidateId)!)
      || a.candidateId.localeCompare(b.candidateId),
    );
    const topFive = comparable.slice(0, 5);
    return {
      streamId,
      labels: comparable.length,
      tasteAt5: topFive.reduce((sum, record) => sum + tasteScore(record), 0) / topFive.length,
    };
  });
  return {
    status: "MEASURED",
    blockers: [],
    streams,
    meanTasteAt5: streams.reduce((sum, stream) => sum + stream.tasteAt5, 0) / streams.length,
  };
}

export function buildShadowScorecard(jobDir: string, corpus: GoldCorpus) {
  const manifest = readJson<{
    streamId?: string;
    subtitlePath?: string | null;
    chatPath?: string | null;
    audioLevelsPath?: string | null;
    heatmapPath?: string | null;
  }>(join(jobDir, "manifest.json"));
  const union = readJson<RecallCandidate[]>(join(jobDir, "recall-union.json"));
  const grounding = readJson<{ results?: GroundingResult[] }>(join(jobDir, "arc-grounding.json")).results ?? [];
  const ranking = readJson<RankingReport>(join(jobDir, "grounded-ranking.json"));
  const selectionPath = join(jobDir, "private-abc-selection.json");
  const selection = existsSync(selectionPath) ? readJson<PrivateSelection>(selectionPath) : {};
  const selectedIds = (selection.candidates ?? []).map((candidate) => candidate.candidateId).filter(Boolean) as string[];
  const rankByCandidate = new Map((ranking.ranked ?? []).map((candidate, index) => [
    candidate.candidateId,
    candidate.rank ?? index + 1,
  ]));
  const strengths = (ranking.ranked ?? [])
    .map((candidate) => candidate.editorialStrength)
    .filter((score): score is number => Number.isFinite(score));
  const maxStrength = strengths.length > 0 ? Math.max(...strengths) : null;
  const selectedRanks = selectedIds.map((candidateId) => ({
    candidateId,
    rank: rankByCandidate.get(candidateId) ?? null,
  }));
  const jobId = basename(jobDir);
  const labels = corpus.records.filter((record) => record.jobId === jobId);

  return {
    version: 1,
    mode: "SHADOW_ONLY" as const,
    uploadBlocked: true,
    jobId,
    streamId: manifest.streamId ?? null,
    funnel: {
      recalled: union.length,
      grounded: grounding.filter((result) => result.status === "GROUNDED").length,
      blocked: grounding.filter((result) => result.status === "BLOCKED").length,
      ranked: ranking.ranked?.length ?? 0,
    },
    routes: countValues(union.flatMap((candidate) => candidate.recallRoutes ?? [])),
    categories: countValues(union.flatMap((candidate) => candidate.categories ?? [])),
    evidence: {
      transcript: Boolean(manifest.subtitlePath && existsSync(manifest.subtitlePath)),
      chat: Boolean(manifest.chatPath && existsSync(manifest.chatPath)),
      audio: Boolean(manifest.audioLevelsPath && existsSync(manifest.audioLevelsPath)),
      heatmap: Boolean(manifest.heatmapPath && existsSync(manifest.heatmapPath)),
    },
    ranking: {
      gate: ranking.gate ?? null,
      topFive: (ranking.ranked ?? []).slice(0, 5).map((candidate) => candidate.candidateId),
      selectedRanks,
      saturation: {
        maxEditorialStrength: maxStrength,
        candidatesAtMax: maxStrength == null ? 0 : strengths.filter((score) => score === maxStrength).length,
      },
    },
    review: {
      status: selectedIds.length > 0 ? "PRIVATE_SELECTION_CAPTURED" : "WAITING_FOR_PRIVATE_REVIEW",
      maximumProductionCandidates: 5,
      selectedCandidateIds: selectedIds,
      withinProductionLimit: selectedIds.length <= 5,
    },
    labels: {
      graded: labels.filter((record) => record.labelStrength === "graded").length,
      ungraded: labels.filter((record) => record.labelStrength === "ungraded").length,
    },
    baseline: baselineBenchmark(dirname(jobDir), corpus),
  };
}

function main(): void {
  const streamIndex = process.argv.indexOf("--stream");
  const streamId = streamIndex >= 0 ? process.argv[streamIndex + 1] : undefined;
  if (!streamId) throw new Error("Usage: shadow-scorecard.ts --stream <id>");
  const jobDir = findStreamDir(streamId);
  if (!jobDir) throw new Error(`No stream directory found for ${streamId}`);
  const clipsRoot = dirname(jobDir);
  const corpus = buildGoldCorpus(clipsRoot);
  const corpusPath = join(clipsRoot, "gold-corpus-v1.json");
  writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf-8");
  const scorecard = buildShadowScorecard(jobDir, corpus);
  const scorecardPath = join(jobDir, "shadow-scorecard.json");
  writeFileSync(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf-8");
  console.log(JSON.stringify({ scorecardPath, ...scorecard }, null, 2));
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile || process.argv[1]?.endsWith("shadow-scorecard.ts") || process.argv[1]?.endsWith("shadow-scorecard.js")) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
