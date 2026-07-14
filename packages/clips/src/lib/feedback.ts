/**
 * feedback.ts — analytics feedback loop for Daily Peanut.
 *
 * Reads performance data from posted clips and adjusts pipeline defaults
 * so future runs favor what actually worked.
 *
 * The feedback file lives at data/clips/clip-feedback.json and is
 * consumed by viral-weights.ts and trim.ts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export type TitleArchetype = "curiosity" | "quote" | "drama" | "other" | "unknown";
export type SignalTier = "rescue-tier" | "multi-signal" | "single-signal" | "unknown";

export interface ArchetypeStats {
  totalViews: number;
  totalRetention: number;
  count: number;
  totalCtr?: number;
  totalLikes?: number;
  totalComments?: number;
  totalAverageViewDuration?: number;
}

export interface DurationBucket {
  min: number;
  max: number;
  totalViews: number;
  totalRetention: number;
  count: number;
}

export interface WeightRecommendations {
  topTitleArchetype?: TitleArchetype;
  underperformingTitleArchetypes: TitleArchetype[];
  topSignalTier?: SignalTier;
  underperformingSignalTiers: SignalTier[];
  notes: string[];
}

export interface FeedbackState {
  version: number;
  updatedAt: string;
  archetypePerformance: Record<string, ArchetypeStats>;
  titleArchetypePerformance: Record<string, ArchetypeStats>;
  signalTierPerformance: Record<string, ArchetypeStats>;
  durationBuckets: DurationBucket[];
  hookPatterns: Record<string, { totalViews: number; count: number }>;
  adjusted: {
    archetypeMultipliers: Record<string, number>;
    titleArchetypeMultipliers: Record<string, number>;
    signalTierMultipliers: Record<string, number>;
    durationSweetSpot: { min: number; max: number };
    setupPenaltyDelta: number;
    recommendations: WeightRecommendations;
  };
}

export interface ClipPerformanceOptions {
  titleArchetype?: TitleArchetype | string;
  signalTier?: SignalTier | string;
  ctr?: number;
  likes?: number;
  comments?: number;
  averageViewDuration?: number;
}

const MIN_BUCKET_SAMPLE = 3;

function getFeedbackPath(): string {
  return join(process.cwd(), "data", "clips", "clip-feedback.json");
}

export function loadFeedback(): FeedbackState | null {
  const feedbackPath = getFeedbackPath();
  if (!existsSync(feedbackPath)) return null;
  try {
    const raw = readFileSync(feedbackPath, "utf-8");
    const parsed = JSON.parse(raw) as FeedbackState;
    if (parsed.version !== 1) {
      console.warn(`Unknown feedback version ${parsed.version}, ignoring`);
      return null;
    }
    return normalizeFeedback(parsed);
  } catch {
    return null;
  }
}

export function saveFeedback(state: FeedbackState): void {
  const feedbackPath = getFeedbackPath();
  mkdirSync(dirname(feedbackPath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(feedbackPath, JSON.stringify(normalizeFeedback(state), null, 2), "utf-8");
}

export function emptyFeedback(): FeedbackState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    archetypePerformance: {},
    titleArchetypePerformance: {},
    signalTierPerformance: {},
    durationBuckets: [
      { min: 8, max: 15, totalViews: 0, totalRetention: 0, count: 0 },
      { min: 15, max: 20, totalViews: 0, totalRetention: 0, count: 0 },
      { min: 20, max: 25, totalViews: 0, totalRetention: 0, count: 0 },
      { min: 25, max: 30, totalViews: 0, totalRetention: 0, count: 0 },
      { min: 30, max: 35, totalViews: 0, totalRetention: 0, count: 0 },
      { min: 35, max: 45, totalViews: 0, totalRetention: 0, count: 0 },
    ],
    hookPatterns: {},
    adjusted: {
      archetypeMultipliers: {},
      titleArchetypeMultipliers: {},
      signalTierMultipliers: {},
      durationSweetSpot: { min: 18, max: 30 },
      setupPenaltyDelta: 0,
      recommendations: {
        underperformingTitleArchetypes: [],
        underperformingSignalTiers: [],
        notes: [],
      },
    },
  };
}

function normalizeFeedback(state: FeedbackState): FeedbackState {
  const base = emptyFeedback();
  state.titleArchetypePerformance ??= {};
  state.signalTierPerformance ??= {};
  state.hookPatterns ??= {};
  state.durationBuckets ??= base.durationBuckets;
  state.adjusted ??= base.adjusted;
  state.adjusted.archetypeMultipliers ??= {};
  state.adjusted.titleArchetypeMultipliers ??= {};
  state.adjusted.signalTierMultipliers ??= {};
  state.adjusted.durationSweetSpot ??= base.adjusted.durationSweetSpot;
  state.adjusted.setupPenaltyDelta ??= 0;
  state.adjusted.recommendations ??= base.adjusted.recommendations;
  state.adjusted.recommendations.underperformingTitleArchetypes ??= [];
  state.adjusted.recommendations.underperformingSignalTiers ??= [];
  state.adjusted.recommendations.notes ??= [];
  return state;
}

/** Infer hook pattern from title text. */
export function detectHookPattern(title: string): string {
  const lower = title.toLowerCase();
  if (/\?/.test(title)) return "question";
  if (/^(he |she |they |this |when |how |what |why )/.test(lower)) return "statement-setup";
  if (/nobody|no one|everyone|all of|wait|hold up|no way/.test(lower)) return "curiosity-gap";
  if (/clip|moment|funny|best|worst|insane|disgusting/.test(lower)) return "descriptor";
  return "generic";
}

/** Record a single clip's performance. */
export function recordClipPerformance(
  state: FeedbackState,
  archetype: string,
  durationSec: number,
  title: string,
  views: number,
  avgViewPercentage: number,
  options: ClipPerformanceOptions = {},
): void {
  addStats(state.archetypePerformance, archetype || "general", views, avgViewPercentage, options);

  const titleArchetype = options.titleArchetype || "unknown";
  addStats(state.titleArchetypePerformance, titleArchetype, views, avgViewPercentage, options);

  const signalTier = options.signalTier || "unknown";
  addStats(state.signalTierPerformance, signalTier, views, avgViewPercentage, options);

  // Duration bucket
  const bucket = state.durationBuckets.find((b) => durationSec >= b.min && durationSec < b.max);
  if (bucket) {
    bucket.totalViews += views;
    bucket.totalRetention += avgViewPercentage;
    bucket.count += 1;
  }

  // Hook pattern
  const pattern = detectHookPattern(title);
  const h = state.hookPatterns[pattern] ?? { totalViews: 0, count: 0 };
  h.totalViews += views;
  h.count += 1;
  state.hookPatterns[pattern] = h;
}

function addStats(
  store: Record<string, ArchetypeStats>,
  key: string,
  views: number,
  avgViewPercentage: number,
  options: ClipPerformanceOptions,
): void {
  const stats = store[key] ?? {
    totalViews: 0,
    totalRetention: 0,
    count: 0,
    totalCtr: 0,
    totalLikes: 0,
    totalComments: 0,
    totalAverageViewDuration: 0,
  };
  stats.totalViews += views;
  stats.totalRetention += avgViewPercentage;
  stats.count += 1;
  stats.totalCtr = (stats.totalCtr ?? 0) + (options.ctr ?? 0);
  stats.totalLikes = (stats.totalLikes ?? 0) + (options.likes ?? 0);
  stats.totalComments = (stats.totalComments ?? 0) + (options.comments ?? 0);
  stats.totalAverageViewDuration =
    (stats.totalAverageViewDuration ?? 0) + (options.averageViewDuration ?? 0);
  store[key] = stats;
}

/** Recompute adjusted weights from accumulated stats. */
export function recomputeAdjustments(state: FeedbackState): void {
  normalizeFeedback(state);
  const archetypes = Object.entries(state.archetypePerformance);
  if (archetypes.length > 0) {
    state.adjusted.archetypeMultipliers = computeMultipliers(state.archetypePerformance, 0.85, 1.15);
  }

  state.adjusted.titleArchetypeMultipliers = computeMultipliers(
    state.titleArchetypePerformance,
    0.9,
    1.1,
    MIN_BUCKET_SAMPLE,
  );
  state.adjusted.signalTierMultipliers = computeMultipliers(
    state.signalTierPerformance,
    0.88,
    1.12,
    MIN_BUCKET_SAMPLE,
  );

  // Duration sweet spot: find the bucket with highest avg views, ignoring tiny samples
  // unless no bucket has enough data yet.
  const nonEmptyBuckets = state.durationBuckets.filter((b) => b.count > 0);
  const eligibleBuckets = nonEmptyBuckets.some((b) => b.count >= MIN_BUCKET_SAMPLE)
    ? nonEmptyBuckets.filter((b) => b.count >= MIN_BUCKET_SAMPLE)
    : nonEmptyBuckets;
  const bucketAvgs = eligibleBuckets
    .map((b) => ({
      min: b.min,
      max: b.max,
      avgViews: b.totalViews / b.count,
      avgRetention: b.totalRetention / b.count,
    }))
    .sort((a, b) => b.avgViews - a.avgViews);

  if (bucketAvgs.length > 0) {
    const bestBucket = bucketAvgs[0];
    // Tighten around the winning bucket, but keep reasonable bounds.
    state.adjusted.durationSweetSpot.min = Math.max(12, bestBucket.min - 2);
    state.adjusted.durationSweetSpot.max = Math.min(40, bestBucket.max + 2);
  }

  // Setup penalty: if retention is consistently low across all known clips,
  // increase the penalty for setup-heavy picks.
  const allRetention = archetypes.map(([, s]) =>
    s.count > 0 ? s.totalRetention / s.count : 0,
  );
  const globalRetention =
    allRetention.reduce((a, b) => a + b, 0) / (allRetention.length || 1);
  if (globalRetention > 0 && globalRetention < 55) {
    state.adjusted.setupPenaltyDelta = -4;
  } else if (globalRetention > 75) {
    state.adjusted.setupPenaltyDelta = 2;
  } else {
    state.adjusted.setupPenaltyDelta = 0;
  }

  state.adjusted.recommendations = buildRecommendations(state);
}

function computeMultipliers(
  store: Record<string, ArchetypeStats>,
  minMultiplier: number,
  maxMultiplier: number,
  minSample = 1,
): Record<string, number> {
  const entries = Object.entries(store).filter(([, stats]) => stats.count > 0);
  if (entries.length === 0) return {};

  const eligible = entries.filter(([, stats]) => stats.count >= minSample);
  const source = eligible.length >= 2 ? eligible : entries;
  const avgViews: Record<string, number> = {};
  for (const [key, stats] of source) {
    avgViews[key] = stats.totalViews / stats.count;
  }

  const sorted = Object.entries(avgViews).sort((a, b) => b[1] - a[1]);
  const bestAvg = sorted[0][1];
  const worstAvg = sorted[sorted.length - 1][1];
  const spread = bestAvg - worstAvg || 1;
  const range = maxMultiplier - minMultiplier;
  const out: Record<string, number> = {};

  for (const [key, avg] of sorted) {
    const normalized = (avg - worstAvg) / spread;
    const multiplier = minMultiplier + normalized * range;
    out[key] = Math.round(multiplier * 100) / 100;
  }

  // Keep tracked-but-tiny buckets neutral until sample size is less noisy.
  for (const [key, stats] of entries) {
    if (!(key in out)) out[key] = stats.count > 0 ? 1 : 1;
  }

  return out;
}

function buildRecommendations(state: FeedbackState): WeightRecommendations {
  const titleRanking = rankStats(state.titleArchetypePerformance);
  const signalRanking = rankStats(state.signalTierPerformance);
  const notes: string[] = [];

  if (titleRanking.length > 0) {
    const top = titleRanking[0];
    notes.push(
      `Title archetype leader: ${top.key} (${Math.round(top.avgViews)} avg views, n=${top.count}).`,
    );
  }
  if (signalRanking.length > 0) {
    const top = signalRanking[0];
    notes.push(
      `Signal-tier leader: ${top.key} (${Math.round(top.avgViews)} avg views, n=${top.count}).`,
    );
  }

  const tinyTitleBuckets = titleRanking.filter((r) => r.count < MIN_BUCKET_SAMPLE).map((r) => r.key);
  const tinySignalBuckets = signalRanking.filter((r) => r.count < MIN_BUCKET_SAMPLE).map((r) => r.key);
  if (tinyTitleBuckets.length > 0 || tinySignalBuckets.length > 0) {
    notes.push(
      `Treat buckets with n<${MIN_BUCKET_SAMPLE} as directional only; multipliers stay neutral unless at least two buckets clear the sample gate.`,
    );
  }

  return {
    topTitleArchetype: titleRanking[0]?.key as TitleArchetype | undefined,
    underperformingTitleArchetypes: titleRanking.slice(-2).map((r) => r.key as TitleArchetype),
    topSignalTier: signalRanking[0]?.key as SignalTier | undefined,
    underperformingSignalTiers: signalRanking.slice(-2).map((r) => r.key as SignalTier),
    notes,
  };
}

function rankStats(store: Record<string, ArchetypeStats>): Array<{
  key: string;
  avgViews: number;
  avgRetention: number;
  avgCtr: number;
  count: number;
}> {
  return Object.entries(store)
    .filter(([, stats]) => stats.count > 0)
    .map(([key, stats]) => ({
      key,
      count: stats.count,
      avgViews: stats.totalViews / stats.count,
      avgRetention: stats.totalRetention / stats.count,
      avgCtr: (stats.totalCtr ?? 0) / stats.count,
    }))
    .sort((a, b) => b.avgViews - a.avgViews);
}

/** Get effective archetype multiplier, falling back to 1.0. */
export function getArchetypeMultiplier(state: FeedbackState | null, archetype: string): number {
  if (!state) return 1.0;
  return state.adjusted.archetypeMultipliers[archetype] ?? 1.0;
}

/** Get effective title archetype multiplier, falling back to 1.0. */
export function getTitleArchetypeMultiplier(state: FeedbackState | null, archetype: string): number {
  if (!state) return 1.0;
  return state.adjusted.titleArchetypeMultipliers[archetype] ?? 1.0;
}

/** Get effective signal-tier multiplier, falling back to 1.0. */
export function getSignalTierMultiplier(state: FeedbackState | null, tier: string): number {
  if (!state) return 1.0;
  return state.adjusted.signalTierMultipliers[tier] ?? 1.0;
}

/** Get effective duration sweet spot. */
export function getDurationSweetSpot(state: FeedbackState | null): { min: number; max: number } {
  if (!state) return { min: 18, max: 30 };
  return state.adjusted.durationSweetSpot;
}

/** Get effective setup penalty delta. */
export function getSetupPenaltyDelta(state: FeedbackState | null): number {
  if (!state) return 0;
  return state.adjusted.setupPenaltyDelta;
}
