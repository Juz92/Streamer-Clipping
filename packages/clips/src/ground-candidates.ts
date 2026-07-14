/**
 * ground-candidates.ts — expand recall anchors into source-aligned Beat Maps.
 *
 * This stage never taste-ranks. It grounds every recall candidate against raw
 * transcript/chat/audio evidence and optional reviewed frame evidence, then
 * writes arc-grounding.json for objective downstream gates.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "@ltx/shared";
import { parseVtt } from "./lib/subtitle-parser.js";
import { parseChatReplay } from "./lib/chat-parser.js";
import { detectAudioSpikes, parseAudioLevels } from "./lib/audio-analyzer.js";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import {
  buildRecallUnion,
  syncRecallUnionToPool,
  type RecallUnionCandidate,
  type ScorerRecallMoment,
} from "./lib/recall-union.js";
import {
  buildChatReactionEvidence,
  groundCandidateArc,
  type ArcGroundingResult,
  type BeatMap,
  type GroundingCandidate,
  type ReactionEvidence,
  type VisualProof,
} from "./lib/arc-grounding.js";

const log = createLogger("ground-candidates");

interface CliArgs {
  streamId: string;
  visualProofsPath?: string;
}

interface RecallUnionInput {
  candidateId: string;
  jobId: string;
  momentId: string;
  startSec: number;
  endSec: number;
  description?: string;
  categories?: string[];
  recallRoutes?: string[];
}

interface VisualProofRecord extends VisualProof {
  candidateId: string;
  beats?: BeatMap;
}

export interface ArcGroundingReport {
  streamId: string;
  jobId: string;
  generatedAt: string;
  summary: {
    candidates: number;
    grounded: number;
    blocked: number;
    transcriptCues: number;
    chatReactions: number;
    audioReactions: number;
    visualProofs: number;
  };
  results: ArcGroundingResult[];
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let streamId = "";
  let visualProofsPath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--stream" && args[index + 1]) streamId = args[++index];
    else if (args[index] === "--visual-proofs" && args[index + 1]) visualProofsPath = args[++index];
  }
  if (!streamId) throw new Error("Usage: ground-candidates.ts --stream <id> [--visual-proofs <path>]");
  return { streamId, visualProofsPath };
}

function loadVisualProofs(path: string | undefined): Map<string, VisualProofRecord> {
  const byCandidate = new Map<string, VisualProofRecord>();
  if (!path || !existsSync(path)) return byCandidate;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as VisualProofRecord[] | { results?: VisualProofRecord[] };
  const rows = Array.isArray(parsed) ? parsed : parsed.results ?? [];
  for (const row of rows) {
    if (!row.candidateId) throw new Error(`Visual proof in ${path} is missing candidateId`);
    if (byCandidate.has(row.candidateId)) throw new Error(`Duplicate visual proof for ${row.candidateId}`);
    byCandidate.set(row.candidateId, row);
  }
  return byCandidate;
}

function audioReactionEvidence(path: string | null): ReactionEvidence[] {
  if (!path || !existsSync(path)) return [];
  return detectAudioSpikes(parseAudioLevels(path)).map((signal) => ({
    timestampSec: signal.timestampSec,
    source: "audio" as const,
    strength: Math.max(0, Math.min(1, signal.deltaFromAvg / 30)),
    label: `${signal.type} (${signal.deltaFromAvg.toFixed(1)}dB over local average)`,
  }));
}

function loadCorrectedBeats(streamId: string): Map<string, BeatMap> {
  const path = join(process.cwd(), "data", "clips", "manual-review-feedback.json");
  if (!existsSync(path)) return new Map<string, BeatMap>();
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
    version?: number;
    records?: Array<{
      streamId?: string;
      decisions?: Array<{ candidateId?: string; correctedBeats?: BeatMap | null }>;
    }>;
  };
  if (parsed.version !== 2) return new Map<string, BeatMap>();
  const corrected = new Map<string, BeatMap>();
  for (const record of parsed.records ?? []) {
    if (record.streamId !== streamId) continue;
    for (const decision of record.decisions ?? []) {
      if (decision.candidateId && decision.correctedBeats) {
        corrected.set(decision.candidateId, decision.correctedBeats);
      }
    }
  }
  return corrected;
}

export function buildArcGroundingReport(params: {
  streamId: string;
  jobId: string;
  candidates: RecallUnionInput[];
  transcript: Array<{ startSec: number; endSec: number; text: string }>;
  reactions: ReactionEvidence[];
  visualProofs?: Map<string, VisualProofRecord>;
  correctedBeats?: Map<string, BeatMap>;
}): ArcGroundingReport {
  const visualProofs = params.visualProofs ?? new Map<string, VisualProofRecord>();
  const seen = new Set<string>();
  const results = params.candidates.map((row): ArcGroundingResult => {
    if (seen.has(row.candidateId)) throw new Error(`Duplicate recall-union candidateId ${row.candidateId}`);
    seen.add(row.candidateId);
    const candidate: GroundingCandidate = {
      candidateId: row.candidateId,
      jobId: row.jobId,
      momentId: row.momentId,
      startSec: row.startSec,
      endSec: row.endSec,
      description: row.description ?? "",
      categories: row.categories ?? [],
      recallRoutes: row.recallRoutes ?? [],
    };
    const proof = visualProofs.get(candidate.candidateId);
    const corrected = params.correctedBeats?.get(candidate.candidateId);
    const windowStart = Math.max(0, candidate.startSec - 90);
    const windowEnd = candidate.endSec + 90;
    return groundCandidateArc({
      candidate,
      transcript: params.transcript.filter((cue) => cue.endSec >= windowStart && cue.startSec <= windowEnd),
      reactions: params.reactions.filter((event) => event.timestampSec >= windowStart && event.timestampSec <= windowEnd),
      proposedBeats: corrected ?? proof?.beats,
      visualProof: proof,
      localizer: corrected
        ? "review-correction-v1"
        : proof?.beats
          ? "visual-proof-v1"
          : "source-envelope-v2",
    });
  });

  const grounded = results.filter((result) => result.status === "GROUNDED").length;
  return {
    streamId: params.streamId,
    jobId: params.jobId,
    generatedAt: new Date().toISOString(),
    summary: {
      candidates: results.length,
      grounded,
      blocked: results.length - grounded,
      transcriptCues: params.transcript.length,
      chatReactions: params.reactions.filter((event) => event.source === "chat").length,
      audioReactions: params.reactions.filter((event) => event.source === "audio").length,
      visualProofs: [...visualProofs.values()].filter((proof) => proof.verified).length,
    },
    results,
  };
}

export function loadRecallCandidates(streamDir: string, jobId: string): RecallUnionCandidate[] {
  const unionPath = join(streamDir, "recall-union.json");
  const semanticPath = join(streamDir, "recall-candidates.json");
  const signalPath = join(streamDir, "signal-recall.json");
  const momentsPath = join(streamDir, "moments.json");
  const hasUnion = existsSync(unionPath);
  const hasSignal = existsSync(signalPath);
  if (hasUnion && !hasSignal) {
    return JSON.parse(readFileSync(unionPath, "utf-8")) as RecallUnionCandidate[];
  }
  const scorerPath = hasSignal ? signalPath : momentsPath;
  const hasSemantic = existsSync(semanticPath);
  const hasScorer = existsSync(scorerPath);

  if (!hasSemantic && !hasScorer) {
    throw new Error("Recall artifacts missing; run transcript review or signal recall first");
  }

  const semanticCandidates = hasSemantic
    ? JSON.parse(readFileSync(semanticPath, "utf-8"))
    : [];
  const scorerMoments = hasScorer
    ? JSON.parse(readFileSync(scorerPath, "utf-8")) as ScorerRecallMoment[]
    : [];
  const union = buildRecallUnion(jobId, semanticCandidates, scorerMoments);
  writeFileSync(unionPath, JSON.stringify(union, null, 2), "utf-8");
  log.info(`Refreshed recall union with ${union.length} candidates`);
  return union;
}

function main(): void {
  const args = parseArgs();
  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) throw new Error(`No stream directory found for ${args.streamId}`);
  const manifest = loadManifest(args.streamId);
  const jobId = basename(manifest.jobDir);
  const candidates = loadRecallCandidates(streamDir, jobId);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("recall-union.json contains no candidates to ground");
  }
  syncRecallUnionToPool({
    poolPath: join(process.cwd(), "data", "clips", "candidate-pool.json"),
    jobId,
    streamId: manifest.streamId,
    streamDate: manifest.uploadDate,
    union: candidates,
  });

  const transcript = manifest.subtitlePath && existsSync(manifest.subtitlePath)
    ? parseVtt(manifest.subtitlePath).map((cue) => ({
      startSec: cue.startMs / 1000,
      endSec: cue.endMs / 1000,
      text: cue.text,
    }))
    : [];
  const chatMessages = manifest.chatPath && existsSync(manifest.chatPath)
    ? parseChatReplay(manifest.chatPath)
    : [];
  const chatReactions = buildChatReactionEvidence(chatMessages);
  const audioReactions = audioReactionEvidence(manifest.audioLevelsPath);
  const defaultVisualProofsPath = join(streamDir, "visual-proofs.json");
  const visualProofs = loadVisualProofs(
    args.visualProofsPath ?? (existsSync(defaultVisualProofsPath) ? defaultVisualProofsPath : undefined),
  );

  const correctedBeats = loadCorrectedBeats(manifest.streamId);
  const report = buildArcGroundingReport({
    streamId: manifest.streamId,
    jobId,
    candidates,
    transcript,
    reactions: [...chatReactions, ...audioReactions].sort((a, b) => a.timestampSec - b.timestampSec),
    visualProofs,
    correctedBeats,
  });
  const outPath = join(streamDir, "arc-grounding.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
  log.info(`Wrote ${outPath}`);
  log.info(`Grounded ${report.summary.grounded}/${report.summary.candidates}; blocked ${report.summary.blocked}`);
  if (report.summary.visualProofs === 0) {
    log.warn("No reviewed visual proofs found; gameplay-only candidates remain blocked by design");
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("ground-candidates.ts") || process.argv[1]?.endsWith("ground-candidates.js")) {
  try {
    main();
  } catch (error) {
    log.error((error as Error).message);
    process.exit(1);
  }
}
