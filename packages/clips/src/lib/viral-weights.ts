/**
 * Tunable weights for the NotebookLM review scoring formula.
 *
 * Edit this file and re-run notebooklm-review.ts to adjust how picks are
 * ranked. Weights are multiplied against NotebookLM's raw strength score
 * (0-100); modifiers are added to the final score.
 *
 * See docs/superpowers/specs/2026-04-11-notebooklm-review-module-design.md
 * for the full scoring formula.
 */

export const CATEGORY_WEIGHTS: Record<string, number> = {
  "hot-take": 1.15, // Drives comment engagement
  drama: 1.1, // Conflict = retention
  "running-bit": 1.05, // Rewards regulars, unique to NotebookLM
  "character-moment": 1.05,
  callback: 1.05,
  "dry-joke": 1.0, // Baseline
  absurdist: 1.0,
  "emotional-peak": 1.0,
  "reaction-gold": 0.95, // Scorer already covers via audio spike
  "one-liner": 0.9, // Feeds titles/thumbs, not standalone
  "story-of-stream": 1.2, // Single hero pick bonus
};

/** Shorts sweet spot: clips in this duration range get a score bonus. */
export const DURATION_SWEET_SPOT = { min: 20, max: 70 };

/** Hard limits: clips outside this range get a score penalty. */
export const DURATION_HARD_LIMITS = { min: 10, max: 90 };

/** Bonus for clips in the sweet spot. */
export const DURATION_BONUS = 10;

/** Penalty for clips outside hard limits. */
export const DURATION_PENALTY = -15;

/** Bonus for standalone clips (no setup needed). */
export const STANDALONE_BONUS = 5;

/** Penalty for clips whose setup reference is > 30 min earlier. */
export const LONG_SETUP_PENALTY = -5;

/** Bonus when a pick appears in 2+ different category queries. */
export const CROSS_CATEGORY_BONUS = 3;

/** Threshold for "long setup" in seconds (30 min). */
export const LONG_SETUP_THRESHOLD_SEC = 1800;
