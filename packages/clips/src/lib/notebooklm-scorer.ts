import {
  getCategoryWeight,
  DURATION_SWEET_SPOT,
  DURATION_HARD_LIMITS,
  DURATION_BONUS,
  DURATION_PENALTY,
  STANDALONE_BONUS,
  LONG_SETUP_PENALTY,
  LONG_SETUP_THRESHOLD_SEC,
  CROSS_CATEGORY_BONUS,
  SETUP_NEEDED_PENALTY,
  FAST_PAYOFF_BONUS,
} from "./viral-weights.js";

export interface ScoreInput {
  /** NotebookLM's 1-5 strength rating for this pick. Undefined → default 3. */
  strength: number | undefined;
  /** Viral categories this pick belongs to (e.g., ["dry-joke", "hot-take"]). */
  categories: string[];
  /** Clip duration in seconds. */
  durationSec: number;
  /** Whether the pick requires earlier setup context. */
  setupNeeded: boolean;
  /** How many seconds earlier the setup reference is (0 if none). */
  setupOffsetSec: number;
  /** Optional heatmap intensity bonus for this moment (0-15). */
  heatmapBonus?: number;
  /** Number of distinct category queries this pick was surfaced in. */
  categoryQueryHitCount: number;
  /** Optional first-frame / editorial hints from enrichment. */
  quote?: string;
  hook?: string;
  /** GPT-5.5/editorial flag: line is genuinely funny, not just dialogue. */
  funnyQuote?: boolean;
  /** 0-1 estimate from GPT/editorial heuristics for actual LOL potential. */
  humorPotential?: number;
}

export interface ScoreBreakdown {
  nlmRaw: number;
  categoryWeight: number;
  durationMod: number;
  standaloneMod: number;
  setupMod: number;
  fastPayoffBonus: number;
  quoteBonus: number;
  funnyQuoteBonus: number;
  crossCategoryBonus: number;
  heatmapBonus: number;
  final: number;
}

export interface ScoreResult {
  final: number;
  breakdown: ScoreBreakdown;
}

/**
 * Score a NotebookLM pick for viral potential. Pure function.
 *
 * Formula: round(nlmRaw * categoryWeight + durationMod + standaloneMod +
 * setupMod + crossCategoryBonus), clamped to [0, 100].
 */
export function scorePick(input: ScoreInput): ScoreResult {
  // Raw score: strength 1-5 → 20-100, default 3 → 60
  const strength = input.strength ?? 3;
  const nlmRaw = strength * 20;

  // Category weight: use MAX weight across all categories for multi-cat picks
  const categoryWeight = Math.max(
    ...input.categories.map((c) => getCategoryWeight(c)),
    1.0, // floor at 1.0 in case categories is empty
  );

  // Duration modifier
  let durationMod = 0;
  if (
    input.durationSec < DURATION_HARD_LIMITS.min ||
    input.durationSec > DURATION_HARD_LIMITS.max
  ) {
    durationMod = DURATION_PENALTY;
  } else if (
    input.durationSec >= DURATION_SWEET_SPOT.min &&
    input.durationSec <= DURATION_SWEET_SPOT.max
  ) {
    durationMod = DURATION_BONUS;
  }

  // Standalone bonus
  const standaloneMod = !input.setupNeeded ? STANDALONE_BONUS : 0;

  // Setup penalties
  let setupMod = input.setupNeeded ? SETUP_NEEDED_PENALTY : 0;
  if (input.setupNeeded && input.setupOffsetSec > LONG_SETUP_THRESHOLD_SEC) {
    setupMod += LONG_SETUP_PENALTY;
  }

  // Fast payoff bonus for archetypes that usually work best as shorts
  const fastPayoffCategories = [
    "friend-roast",
    "roast",
    "crash-out",
    "meltdown",
    "one-liner",
    "quotable",
    "skill",
    "clutch",
    "broad-appeal",
  ];
  const fastPayoffBonus = input.categories.some((c) => fastPayoffCategories.includes(c))
    ? FAST_PAYOFF_BONUS
    : 0;

  // Quotable dialogue bonus, tends to correlate with comments/shares.
  // Funny-quote is deliberately separate: mundane dialogue should not ride the same boost.
  const quoteBonus = input.quote && input.quote.trim().length >= 12 ? 3 : 0;
  const funnyQuoteBonus = (input.funnyQuote ? 6 : 0) + Math.round((input.humorPotential ?? 0) * 4);

  // Cross-category bonus: picks in 2+ queries
  const crossCategoryBonus =
    input.categoryQueryHitCount >= 2 ? CROSS_CATEGORY_BONUS : 0;

  // Heatmap bonus: moments in high-replay regions get boosted
  const heatmapBonus = input.heatmapBonus ?? 0;

  // Final: round and clamp
  const raw =
    nlmRaw * categoryWeight +
    durationMod +
    standaloneMod +
    setupMod +
    fastPayoffBonus +
    quoteBonus +
    funnyQuoteBonus +
    crossCategoryBonus +
    heatmapBonus;
  const final = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    final,
    breakdown: {
      nlmRaw,
      categoryWeight,
      durationMod,
      standaloneMod,
      setupMod,
      fastPayoffBonus,
      quoteBonus,
      funnyQuoteBonus,
      crossCategoryBonus,
      heatmapBonus,
      final,
    },
  };
}
