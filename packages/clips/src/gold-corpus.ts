import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContentLane } from "./lib/content-lanes.js";

interface BeatMap {
  setupStartSec?: number;
  premiseClearSec?: number;
  actionStartSec?: number;
  payoffStartSec?: number;
  payoffEndSec?: number;
  reactionEndSec?: number;
  flashSec?: number;
}

interface CandidateEvidence {
  candidateId?: string;
  momentId?: string;
  startSec?: number;
  endSec?: number;
  categories?: string[];
  recallRoutes?: string[];
  beats?: BeatMap;
  status?: string;
}

export interface GoldCorpusRecord {
  candidateId: string;
  jobId: string;
  momentId: string;
  streamId: string;
  status: "keep" | "reject" | "reserve";
  reaction: string | null;
  labelStrength: "graded" | "ungraded";
  lane: string | null;
  rejectionReason: string | null;
  sourceWindow: { startSec: number; endSec: number };
  beatMap: BeatMap | null;
  recallRoutes: string[];
  labelSource: "manual-review" | "private-selection";
  sourceArtifact: string;
  reviewedAt: string | null;
  mediaPath: string | null;
  mediaAvailable: boolean;
}

export interface GoldCorpus {
  version: 1;
  records: GoldCorpusRecord[];
  excluded: Array<{
    candidateId: string;
    reason: "missing-recall-or-grounding" | "candidate-not-grounded";
    sourceArtifact: string;
  }>;
  summary: {
    records: number;
    gradedRecords: number;
    ungradedRecords: number;
    streams: number;
    gradedStreams: number;
    mediaAvailable: number;
    excludedRecords: number;
  };
  benchmark: {
    status: "READY" | "WAITING_FOR_LABELS";
    requiredGradedStreams: 3;
    gradedStreams: number;
  };
}

interface ManualFeedback {
  records?: Array<{
    streamId?: string;
    reviewedAt?: string;
    decisions?: Array<{
      candidateId?: string;
      momentId?: string;
      status?: "keep" | "reject" | "reserve";
      lane?: string | null;
      reaction?: string | null;
      rejectionReason?: string | null;
      correctedBeats?: BeatMap | null;
      file?: string;
    }>;
  }>;
}

interface PrivateSelection {
  streamId?: string;
  selectedAt?: string;
  decision?: string;
  candidates?: Array<{
    candidateId?: string;
    label?: string;
    startSec?: number;
    endSec?: number;
    beats?: BeatMap;
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function jobIdFromCandidate(candidateId: string): string {
  const separator = candidateId.indexOf(":");
  if (separator <= 0 || separator === candidateId.length - 1) {
    throw new Error(`Gold Corpus candidate id ${candidateId} is not canonical`);
  }
  return candidateId.slice(0, separator);
}

function loadEvidence(jobDir: string): {
  union: Map<string, CandidateEvidence>;
  grounding: Map<string, CandidateEvidence>;
} {
  const unionPath = join(jobDir, "recall-union.json");
  const groundingPath = join(jobDir, "arc-grounding.json");
  if (!existsSync(unionPath) || !existsSync(groundingPath)) {
    throw new Error(`Gold Corpus requires Recall Union and Arc Grounding for ${basename(jobDir)}`);
  }
  const unionRows = readJson<CandidateEvidence[]>(unionPath);
  const groundingArtifact = readJson<{ results?: CandidateEvidence[] }>(groundingPath);
  return {
    union: new Map(unionRows.map((row) => [row.candidateId ?? "", row])),
    grounding: new Map((groundingArtifact.results ?? []).map((row) => [row.candidateId ?? "", row])),
  };
}

function sourceWindow(
  candidateId: string,
  union: CandidateEvidence,
  grounding: CandidateEvidence,
  explicitWindow?: { startSec?: number; endSec?: number } | null,
  explicitBeats?: BeatMap | null,
): { startSec: number; endSec: number } {
  const beats = explicitBeats ?? grounding.beats;
  const startSec = explicitWindow?.startSec ?? beats?.setupStartSec ?? union.startSec;
  const endSec = explicitWindow?.endSec ?? beats?.reactionEndSec ?? union.endSec;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec! <= startSec!) {
    throw new Error(`Gold Corpus candidate ${candidateId} has an invalid source window`);
  }
  return { startSec: startSec!, endSec: endSec! };
}

function resolveLane(explicitLane: string | null | undefined, candidate: CandidateEvidence): string | null {
  const values = [explicitLane, ...(candidate.categories ?? []), ...(candidate.recallRoutes ?? [])];
  for (const value of values) {
    const lane = normalizeContentLane(value);
    if (lane) return lane;
  }
  return null;
}

function relativeMediaPath(clipsRoot: string, path: string | null): string | null {
  if (!path || !existsSync(path) || !statSync(path).isFile()) return null;
  return relative(clipsRoot, path).replaceAll("\\", "/");
}

function privateMediaPath(clipsRoot: string, jobDir: string, label: string | undefined): string | null {
  const index = label && /^[A-Z]$/.test(label) ? label.charCodeAt(0) - 64 : 0;
  if (index <= 0) return null;
  const prefix = `${String(index).padStart(2, "0")}-`;
  const rawDir = join(jobDir, "raw-clips");
  if (!existsSync(rawDir)) return null;
  const name = readdirSync(rawDir).sort().find((file) => file.startsWith(prefix) && file.endsWith(".mp4"));
  return name ? relativeMediaPath(clipsRoot, join(rawDir, name)) : null;
}

function addRecord(byCandidate: Map<string, GoldCorpusRecord>, record: GoldCorpusRecord): void {
  const previous = byCandidate.get(record.candidateId);
  if (!previous) {
    byCandidate.set(record.candidateId, record);
    return;
  }
  if (previous.sourceWindow.startSec !== record.sourceWindow.startSec
    || previous.sourceWindow.endSec !== record.sourceWindow.endSec) {
    throw new Error(`Gold Corpus candidate ${record.candidateId} has conflicting source windows`);
  }
  if (previous.labelStrength === "ungraded" && record.labelStrength === "graded") {
    byCandidate.set(record.candidateId, record);
  }
}

export function buildGoldCorpus(clipsRoot: string): GoldCorpus {
  const byCandidate = new Map<string, GoldCorpusRecord>();
  const excluded: GoldCorpus["excluded"] = [];
  const evidenceCache = new Map<string, ReturnType<typeof loadEvidence>>();
  const evidenceFor = (jobId: string) => {
    let evidence = evidenceCache.get(jobId);
    if (!evidence) {
      evidence = loadEvidence(join(clipsRoot, jobId));
      evidenceCache.set(jobId, evidence);
    }
    return evidence;
  };

  const manualPath = join(clipsRoot, "manual-review-feedback.json");
  if (existsSync(manualPath)) {
    const feedback = readJson<ManualFeedback>(manualPath);
    for (const review of feedback.records ?? []) {
      for (const decision of review.decisions ?? []) {
        const candidateId = decision.candidateId?.trim();
        if (!candidateId || !decision.status || !decision.reaction || !review.streamId) continue;
        const jobId = jobIdFromCandidate(candidateId);
        const jobDir = join(clipsRoot, jobId);
        if (!existsSync(join(jobDir, "recall-union.json")) || !existsSync(join(jobDir, "arc-grounding.json"))) {
          excluded.push({
            candidateId,
            reason: "missing-recall-or-grounding",
            sourceArtifact: "manual-review-feedback.json",
          });
          continue;
        }
        const evidence = evidenceFor(jobId);
        const union = evidence.union.get(candidateId);
        const grounding = evidence.grounding.get(candidateId);
        if (!union || grounding?.status !== "GROUNDED") {
          excluded.push({
            candidateId,
            reason: "candidate-not-grounded",
            sourceArtifact: "manual-review-feedback.json",
          });
          continue;
        }
        const beatMap = decision.correctedBeats ?? grounding.beats ?? null;
        const mediaCandidate = decision.file ? join(clipsRoot, jobId, decision.file) : null;
        const mediaPath = relativeMediaPath(clipsRoot, mediaCandidate);
        addRecord(byCandidate, {
          candidateId,
          jobId,
          momentId: decision.momentId ?? candidateId.slice(candidateId.indexOf(":") + 1),
          streamId: review.streamId,
          status: decision.status,
          reaction: decision.reaction,
          labelStrength: "graded",
          lane: resolveLane(decision.lane, union),
          rejectionReason: decision.rejectionReason ?? null,
          sourceWindow: sourceWindow(candidateId, union, grounding, null, beatMap),
          beatMap,
          recallRoutes: union.recallRoutes ?? [],
          labelSource: "manual-review",
          sourceArtifact: "manual-review-feedback.json",
          reviewedAt: review.reviewedAt ?? null,
          mediaPath,
          mediaAvailable: mediaPath != null,
        });
      }
    }
  }

  for (const entry of readdirSync(clipsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("job-")) continue;
    const jobDir = join(clipsRoot, entry.name);
    const selectionPath = join(jobDir, "private-abc-selection.json");
    if (!existsSync(selectionPath)) continue;
    const selection = readJson<PrivateSelection>(selectionPath);
    if (selection.decision !== "liked all" || !selection.streamId) continue;
    const evidence = evidenceFor(entry.name);
    for (const approved of selection.candidates ?? []) {
      const candidateId = approved.candidateId?.trim();
      if (!candidateId) continue;
      const union = evidence.union.get(candidateId);
      const grounding = evidence.grounding.get(candidateId);
      if (!union || grounding?.status !== "GROUNDED") {
        throw new Error(`Gold Corpus candidate ${candidateId} lacks grounded source evidence`);
      }
      const mediaPath = privateMediaPath(clipsRoot, jobDir, approved.label);
      addRecord(byCandidate, {
        candidateId,
        jobId: entry.name,
        momentId: union.momentId ?? candidateId.slice(candidateId.indexOf(":") + 1),
        streamId: selection.streamId,
        status: "keep",
        reaction: null,
        labelStrength: "ungraded",
        lane: resolveLane(null, union),
        rejectionReason: null,
        sourceWindow: sourceWindow(candidateId, union, grounding, approved, approved.beats),
        beatMap: approved.beats ?? grounding.beats ?? null,
        recallRoutes: union.recallRoutes ?? [],
        labelSource: "private-selection",
        sourceArtifact: `${entry.name}/private-abc-selection.json`,
        reviewedAt: selection.selectedAt ?? null,
        mediaPath,
        mediaAvailable: mediaPath != null,
      });
    }
  }

  const records = [...byCandidate.values()].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  excluded.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const graded = records.filter((record) => record.labelStrength === "graded");
  const gradedStreams = new Set(graded.map((record) => record.streamId)).size;
  return {
    version: 1,
    records,
    excluded,
    summary: {
      records: records.length,
      gradedRecords: graded.length,
      ungradedRecords: records.length - graded.length,
      streams: new Set(records.map((record) => record.streamId)).size,
      gradedStreams,
      mediaAvailable: records.filter((record) => record.mediaAvailable).length,
      excludedRecords: excluded.length,
    },
    benchmark: {
      status: gradedStreams >= 3 ? "READY" : "WAITING_FOR_LABELS",
      requiredGradedStreams: 3,
      gradedStreams,
    },
  };
}

function main(): void {
  const clipsRoot = join(process.cwd(), "data", "clips");
  const outputPath = join(clipsRoot, "gold-corpus-v1.json");
  const corpus = buildGoldCorpus(clipsRoot);
  writeFileSync(outputPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf-8");
  console.log(JSON.stringify({ outputPath, ...corpus.summary, benchmark: corpus.benchmark }, null, 2));
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && fileURLToPath(new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`)) === currentFile) {
  main();
}
