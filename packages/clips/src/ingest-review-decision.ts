/**
 * ingest-review-decision.ts - Store private review decisions for later tuning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

interface CliArgs {
  streamId: string;
  decisionPath?: string;
}

interface ReviewDecision {
  streamId?: string;
  reviewedAt?: string | null;
  chosenRank?: number | null;
  acceptedSuggestedPick?: boolean | null;
  notes?: string;
  decisions?: Array<{
    rank: number;
    candidateId: string;
    file?: string;
    status?: string;
    reaction?: "lol" | "smiled" | "nothing" | "context-missing" | null;
    rejectionReason?: "weak-premise" | "no-payoff" | "needs-context" | "generic-gameplay" | "bad-cut" | "wrong-lane" | "not-funny" | "other" | null;
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

export function normalizeReviewRecord(
  streamId: string,
  decision: ReviewDecision,
  quality: PickQuality,
  moments: DiscoveryMomentSummary[] = [],
): ManualReviewRecord {
  const suggestedRank = quality.suggestedRank ?? null;
  const chosenRank = decision.chosenRank ?? null;
  const momentByRank = new Map(moments.map((moment) => [moment.rank, moment]));
  const decisions: ReviewDecisionItem[] = (decision.decisions ?? []).map((item) => {
    const moment = momentByRank.get(item.rank);
    return {
      ...item,
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
  for (const item of decisions) {
    if (!Number.isInteger(item.rank)) throw new Error("Every decision item needs an integer rank");
    if (!item.candidateId) throw new Error("Every decision item needs candidateId");
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

function appendManualFeedback(record: ManualReviewRecord): void {
  const path = manualFeedbackPath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path)
    ? readJson<{ records?: ManualReviewRecord[] }>(path)
    : { records: [] };
  const records = (existing.records ?? []).filter((item) => item.streamId !== record.streamId);
  records.push(record);
  writeFileSync(path, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records }, null, 2), "utf-8");
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
  const moments = existsSync(join(streamDir, "moments.json"))
    ? readJson<{ moments?: DiscoveryMomentSummary[] }>(join(streamDir, "moments.json")).moments ?? []
    : [];
  const record = normalizeReviewRecord(args.streamId, decision, quality, moments);
  appendManualFeedback(record);

  const summaryPath = join(streamDir, "review", "review-decision.summary.json");
  writeFileSync(summaryPath, JSON.stringify(record, null, 2), "utf-8");
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
