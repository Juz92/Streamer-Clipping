/**
 * ingest-review-decision.ts - Store private review decisions for later tuning.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  normalizeContentLane,
  normalizeViewerReaction,
  type ViewerReaction,
} from "./lib/content-lanes.js";

/**
 * Schema version of manual-review-feedback.json.
 *
 * The file has always carried a version and nothing ever read it, so a file
 * written under one shape could be merged into another silently. That is how
 * two labelling sessions ended up with different schemas -- one with no
 * correctedBeats or arcIntent at all -- and nobody noticed for four months.
 */
export const FEEDBACK_SCHEMA_VERSION = 2;

/** All six beats present and finite, matching the gold corpus's own test. */
function hasCompleteBeats(beats: CorrectedBeatMap | null | undefined): boolean {
  if (!beats) return false;
  return [
    beats.setupStartSec,
    beats.premiseClearSec,
    beats.actionStartSec,
    beats.payoffStartSec,
    beats.payoffEndSec,
    beats.reactionEndSec,
  ].every((value) => Number.isFinite(value));
}

interface CliArgs {
  streamId: string;
  decisionPath?: string;
}

interface CorrectedBeatMap {
  setupStartSec: number;
  premiseClearSec: number;
  actionStartSec: number;
  payoffStartSec: number;
  payoffEndSec: number;
  reactionEndSec: number;
  flashSec?: number;
}

type ReviewStatus = "keep" | "reject" | "reserve";
type ArcIntent = "single-arc" | "compilation";
type ContextLevel = "self-contained" | "light-context" | "deep-context";
type ContextCarrier = "dialogue" | "title" | "caption" | "visual";
type EvidenceModality = "dialogue" | "audio" | "visual" | "chat" | "hybrid";
type RepetitionClass = "distinctive" | "tactical-filler" | "not-applicable";

interface ReviewDecision {
  streamId?: string;
  reviewedAt?: string | null;
  chosenRank?: number | null;
  acceptedSuggestedPick?: boolean | null;
  notes?: string;
  decisions?: Array<{
    rank: number;
    candidateId: string;
    momentId?: string;
    file?: string;
    status?: ReviewStatus;
    lane?: string | null;
    reaction?: ViewerReaction | null;
    rejectionReason?: "weak-premise" | "no-payoff" | "needs-context" | "generic-gameplay" | "bad-cut" | "wrong-lane" | "not-funny" | "other" | null;
    coldOpenAccepted?: boolean | null;
    correctedBeats?: CorrectedBeatMap | null;
    arcIntent?: ArcIntent | null;
    contextLevel?: ContextLevel | null;
    contextCarrier?: ContextCarrier | null;
    visualProofRequired?: boolean | null;
    primaryEvidenceModality?: EvidenceModality | null;
    repetitionClass?: RepetitionClass | null;
    rightsStatus?: "cleared" | "unresolved" | "blocked" | null;
    publishApproved?: boolean | null;
    notes?: string;
  }>;
}

interface PickQuality {
  suggestedRank?: number | null;
  picks?: Array<{
    rank: number;
    status?: string;
    arcCompleteness?: number;
    contextNeeded?: boolean;
  }>;
}

interface DiscoveryMomentSummary {
  rank: number;
  candidateId?: string;
  momentId?: string;
  contentLane?: string;
  payoffType?: string;
  laneScore?: number;
  laughOutLoudScore?: number;
  humorPotential?: number;
}

type ReviewDecisionItem = NonNullable<ReviewDecision["decisions"]>[number] & Omit<DiscoveryMomentSummary, "rank">;

interface ManualReviewRecord {
  streamId: string;
  reviewedAt: string;
  suggestedRank: number | null;
  chosenRank: number | null;
  acceptedSuggestedPick: boolean;
  notes: string;
  decisions: ReviewDecisionItem[];
}

const log = {
  info: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let streamId = "";
  let decisionPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) streamId = args[++i];
    else if (args[i] === "--decision" && args[i + 1]) decisionPath = args[++i];
  }

  if (!streamId) {
    log.error("Usage: ingest-review-decision.ts --stream <id> [--decision path]");
    process.exit(1);
  }

  return { streamId, decisionPath };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function manualFeedbackPath(): string {
  return join(process.cwd(), "data", "clips", "manual-review-feedback.json");
}

function validateCorrectedBeats(beats: CorrectedBeatMap | null | undefined): void {
  if (!beats) return;
  const ordered = [
    beats.setupStartSec,
    beats.premiseClearSec,
    beats.actionStartSec,
    beats.payoffStartSec,
    beats.payoffEndSec,
    beats.reactionEndSec,
  ];
  if (ordered.some((value) => !Number.isFinite(value))) {
    throw new Error("Corrected Beat Map requires finite boundaries");
  }
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index] < ordered[index - 1]) throw new Error("Corrected Beat Map must remain ordered");
  }
  if (beats.flashSec != null && (
    !Number.isFinite(beats.flashSec)
    || beats.flashSec < beats.setupStartSec
    || beats.flashSec > beats.reactionEndSec
  )) {
    throw new Error("Corrected flashSec must remain inside the ordered Beat Map");
  }
}

export function normalizeReviewRecord(
  streamId: string,
  decision: ReviewDecision,
  quality: PickQuality,
  moments: DiscoveryMomentSummary[] = [],
  /**
   * Candidates whose arc grounding already carries a complete Beat Map. When
   * supplied, a decision that neither corrects the beats nor inherits a
   * complete set is rejected rather than written as a label the gold corpus
   * will silently refuse. Omitted by callers that cannot see grounding.
   */
  groundedBeatCandidates?: ReadonlySet<string>,
): ManualReviewRecord {
  const suggestedRank = quality.suggestedRank ?? null;
  const chosenRank = decision.chosenRank ?? null;
  const momentByCandidate = new Map(
    moments.filter((moment) => moment.candidateId).map((moment) => [moment.candidateId as string, moment]),
  );
  const seen = new Set<string>();
  const decisions: ReviewDecisionItem[] = (decision.decisions ?? []).map((item) => {
    if (!Number.isInteger(item.rank)) throw new Error("Every decision item needs an integer rank");
    const candidateId = item.candidateId?.trim();
    if (!candidateId) throw new Error("Every decision item needs candidateId");
    const separator = candidateId.indexOf(":");
    if (separator <= 0 || separator === candidateId.length - 1) {
      throw new Error(`Candidate id ${candidateId} is not canonical`);
    }
    const sourceMomentId = candidateId.slice(separator + 1);
    const momentId = item.momentId?.trim() || sourceMomentId;
    if (sourceMomentId !== momentId) {
      throw new Error(`Candidate id ${candidateId} does not match momentId ${momentId}`);
    }
    if (seen.has(candidateId)) throw new Error(`Duplicate review decision for ${candidateId}`);
    seen.add(candidateId);
    if (!item.status || !["keep", "reject", "reserve"].includes(item.status)) {
      throw new Error(`Review decision ${candidateId} needs keep, reject, or reserve status`);
    }
    validateCorrectedBeats(item.correctedBeats);
    if (
      groundedBeatCandidates
      && !hasCompleteBeats(item.correctedBeats)
      && !groundedBeatCandidates.has(candidateId)
    ) {
      throw new Error(
        `Review decision ${candidateId} has no corrected Beat Map and no complete grounded one, `
        + "so the gold corpus would accept the label and then never count it. "
        + "Supply correctedBeats, or re-run arc grounding for this candidate.",
      );
    }

    const moment = momentByCandidate.get(candidateId);
    if (momentByCandidate.size > 0 && !moment) {
      throw new Error(`Review candidate ${candidateId} is missing from the canonical source artifact`);
    }
    if (moment?.momentId && moment.momentId !== momentId) {
      throw new Error(`Candidate id ${candidateId} conflicts with source momentId ${moment.momentId}`);
    }
    const rawLane = item.lane ?? moment?.contentLane;
    const lane = normalizeContentLane(rawLane);
    if (!lane) throw new Error(`Review decision ${candidateId} needs a valid lane label`);
    const reaction = normalizeViewerReaction(item.reaction) ?? null;
    if (item.reaction != null && !reaction) {
      throw new Error(`Review decision ${candidateId} has an invalid reaction label`);
    }
    if (item.status === "keep" && !reaction) {
      throw new Error(`Kept candidate ${candidateId} needs a valid reaction label`);
    }
    if (typeof item.coldOpenAccepted !== "boolean") {
      throw new Error(`Review decision ${candidateId} needs a cold-open acceptance label`);
    }
    if (!item.arcIntent || !["single-arc", "compilation"].includes(item.arcIntent)) {
      throw new Error(`Review decision ${candidateId} needs single-arc or compilation intent`);
    }
    if (!item.contextLevel || !["self-contained", "light-context", "deep-context"].includes(item.contextLevel)) {
      throw new Error(`Review decision ${candidateId} needs a valid context level`);
    }
    if (!item.contextCarrier || !["dialogue", "title", "caption", "visual"].includes(item.contextCarrier)) {
      throw new Error(`Review decision ${candidateId} needs a valid context carrier`);
    }
    if (typeof item.visualProofRequired !== "boolean") {
      throw new Error(`Review decision ${candidateId} needs a visual-proof requirement label`);
    }
    if (!item.primaryEvidenceModality
      || !["dialogue", "audio", "visual", "chat", "hybrid"].includes(item.primaryEvidenceModality)) {
      throw new Error(`Review decision ${candidateId} needs a primary evidence modality`);
    }
    if (!item.repetitionClass
      || !["distinctive", "tactical-filler", "not-applicable"].includes(item.repetitionClass)) {
      throw new Error(`Review decision ${candidateId} needs a repetition classification`);
    }
    const rejectionReasons = ["weak-premise", "no-payoff", "needs-context", "generic-gameplay", "bad-cut", "wrong-lane", "not-funny", "other"];
    if (item.rejectionReason != null && !rejectionReasons.includes(item.rejectionReason)) {
      throw new Error(`Review decision ${candidateId} has an invalid rejection reason`);
    }
    if (item.status === "reject" && !item.rejectionReason) {
      throw new Error(`Rejected candidate ${candidateId} needs a rejection reason`);
    }
    const rightsStatus = item.rightsStatus ?? "unresolved";
    if (!["cleared", "unresolved", "blocked"].includes(rightsStatus)) {
      throw new Error(`Review decision ${candidateId} has an invalid rights status`);
    }
    const publishApproved = item.publishApproved ?? false;
    if (typeof publishApproved !== "boolean") {
      throw new Error(`Review decision ${candidateId} has an invalid publish approval`);
    }
    return {
      ...item,
      candidateId,
      momentId,
      lane,
      reaction,
      rightsStatus,
      publishApproved,
      contentLane: moment?.contentLane,
      payoffType: moment?.payoffType,
      laneScore: moment?.laneScore,
      laughOutLoudScore: moment?.laughOutLoudScore,
      humorPotential: moment?.humorPotential,
    };
  });
  const acceptedSuggestedPick = decision.acceptedSuggestedPick ?? (
    suggestedRank != null && chosenRank === suggestedRank
  );

  if (chosenRank != null && !Number.isInteger(chosenRank)) {
    throw new Error("chosenRank must be an integer or null");
  }

  return {
    streamId,
    reviewedAt: decision.reviewedAt || new Date().toISOString(),
    suggestedRank,
    chosenRank,
    acceptedSuggestedPick,
    notes: decision.notes ?? "",
    decisions,
  };
}

export function mergeReviewRecords(
  previous: ManualReviewRecord,
  next: ManualReviewRecord,
): ManualReviewRecord {
  if (previous.streamId !== next.streamId) throw new Error("Cannot merge review records from different streams");
  const byCandidate = new Map(previous.decisions.map((item) => [item.candidateId, item]));
  for (const item of next.decisions) {
    const prior = byCandidate.get(item.candidateId) ?? {};
    const defined = Object.fromEntries(
      Object.entries(item).filter(([key, value]) =>
        value !== undefined && !(key === "correctedBeats" && value === null),
      ),
    ) as ReviewDecisionItem;
    byCandidate.set(item.candidateId, { ...prior, ...defined });
  }
  return {
    ...previous,
    ...next,
    suggestedRank: next.suggestedRank ?? previous.suggestedRank,
    chosenRank: next.chosenRank ?? previous.chosenRank,
    acceptedSuggestedPick: next.chosenRank == null && next.suggestedRank == null
      ? previous.acceptedSuggestedPick
      : next.acceptedSuggestedPick,
    notes: next.notes || previous.notes,
    decisions: [...byCandidate.values()],
  };
}

export function appendManualFeedback(
  record: ManualReviewRecord,
  path = manualFeedbackPath(),
): ManualReviewRecord {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path)
    ? readJson<{ version?: number; records?: ManualReviewRecord[] }>(path)
    : { records: [] };
  if (existing.version != null && existing.version !== FEEDBACK_SCHEMA_VERSION) {
    throw new Error(
      `${path} is schema version ${existing.version}; this build writes `
      + `${FEEDBACK_SCHEMA_VERSION}. Migrate it explicitly rather than merging across versions.`,
    );
  }
  const previous = (existing.records ?? []).find((item) => item.streamId === record.streamId);
  const merged = previous ? mergeReviewRecords(previous, record) : record;
  const records = (existing.records ?? []).filter((item) => item.streamId !== record.streamId);
  records.push(merged);
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ version: FEEDBACK_SCHEMA_VERSION, updatedAt: new Date().toISOString(), records }, null, 2), "utf-8");
  renameSync(tempPath, path);
  return merged;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { findStreamDir } = await import("./lib/manifest.js");
  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) throw new Error(`No stream dir found for ${args.streamId}`);

  const decisionPath = args.decisionPath ?? join(streamDir, "review", "review-decision.json");
  if (!existsSync(decisionPath)) {
    throw new Error(`No review decision found at ${decisionPath}`);
  }

  const decision = readJson<ReviewDecision>(decisionPath);
  const quality = existsSync(join(streamDir, "pick-quality.json"))
    ? readJson<PickQuality>(join(streamDir, "pick-quality.json"))
    : {};
  const momentsPath = join(streamDir, "moments.json");
  const momentArtifact = existsSync(momentsPath)
    ? readJson<DiscoveryMomentSummary[] | { moments?: DiscoveryMomentSummary[] }>(momentsPath)
    : [];
  const moments = Array.isArray(momentArtifact) ? momentArtifact : momentArtifact.moments ?? [];
  const momentByCandidate = new Map(
    moments.filter((moment) => moment.candidateId).map((moment) => [moment.candidateId as string, moment]),
  );
  const trimPath = join(streamDir, "trim-results.json");
  const trimArtifact = existsSync(trimPath)
    ? readJson<{ approved?: Array<{ rank: number; candidateId: string; momentId: string }> }>(trimPath)
    : {};
  const canonicalCandidates = (trimArtifact.approved ?? []).map((item) => ({
    ...momentByCandidate.get(item.candidateId),
    ...item,
  }));
  // Arc grounding is where inherited beats come from, so read it here to reject
  // a decision that would land in the corpus as benchmark-ineligible.
  const groundingPath = join(streamDir, "arc-grounding.json");
  const groundedBeatCandidates = existsSync(groundingPath)
    ? new Set(
      (readJson<{ results?: Array<{ candidateId?: string; beats?: CorrectedBeatMap }> }>(groundingPath).results ?? [])
        .filter((row) => row.candidateId && hasCompleteBeats(row.beats))
        .map((row) => row.candidateId as string),
    )
    : undefined;

  const record = normalizeReviewRecord(
    args.streamId,
    decision,
    quality,
    canonicalCandidates.length > 0 ? canonicalCandidates : moments,
    groundedBeatCandidates,
  );
  const storedRecord = appendManualFeedback(record);

  const summaryPath = join(streamDir, "review", "review-decision.summary.json");
  writeFileSync(summaryPath, JSON.stringify(storedRecord, null, 2), "utf-8");
  log.info(`Ingested review decision: ${summaryPath}`);
  log.info(`Manual feedback: ${manualFeedbackPath()}`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("ingest-review-decision.ts") || process.argv[1]?.endsWith("ingest-review-decision.js")) {
  main().catch((err) => {
    log.error(err.message ?? String(err));
    process.exit(1);
  });
}
