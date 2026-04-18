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
  // ── Tier 1: broadest appeal + highest retention arc ──────────────────────
  "story-of-stream": 1.25, // THE moment of the stream — hero pick
  "broad-appeal": 1.2,    // Non-gamers get it instantly; fastest path to viral
  "friend-roast": 1.2,    // Escalation arc = retention; universally funny
  // ── Tier 2: strong retention signal ──────────────────────────────────────
  "crash-out": 1.15,      // Escalation arc = retention; universally relatable
  "hot-take": 1.1,        // Comment-bait; legacy (query replaced but kept for old data)
  drama: 1.05,            // Legacy (query replaced by crash-out/friend-roast)
  "running-bit": 1.05,    // Rewards returning viewers; recall boosts trust score
  "character-moment": 1.05,
  callback: 1.05,
  // ── Tier 3: solid but context-dependent ───────────────────────────────────
  "one-liner": 1.05,      // Raised from 0.9 — standalone quotable = broad appeal
  "dry-joke": 1.0,        // Baseline
  absurdist: 1.0,
  "emotional-peak": 1.0,
  "reaction-gold": 0.95,  // Scorer already covers via audio spike
};

/**
 * Shorts sweet spot: clips in this range get a score bonus.
 * Upper limit dropped from 70→45s based on algorithm data: retention curves
 * show sharp drops after ~45s on content that isn't a continuous narrative.
 */
export const DURATION_SWEET_SPOT = { min: 20, max: 45 };

/** Hard limits: clips outside this range get a score penalty. */
export const DURATION_HARD_LIMITS = { min: 10, max: 75 };

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
