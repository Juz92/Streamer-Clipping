import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePick } from "../src/lib/notebooklm-scorer.js";
import type { ScoreInput } from "../src/lib/notebooklm-scorer.js";
import {
  CROSS_CATEGORY_BONUS,
  DURATION_BONUS,
  DURATION_HARD_LIMITS,
  DURATION_PENALTY,
  DURATION_SWEET_SPOT,
  LONG_SETUP_PENALTY,
  LONG_SETUP_THRESHOLD_SEC,
  SETUP_NEEDED_PENALTY,
  STANDALONE_BONUS,
  getCategoryWeight,
} from "../src/lib/viral-weights.js";

const sweetDuration = Math.round((DURATION_SWEET_SPOT.min + DURATION_SWEET_SPOT.max) / 2);

function base(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    strength: 4,
    categories: ["dry-joke"],
    durationSec: sweetDuration,
    setupNeeded: false,
    setupOffsetSec: 0,
    categoryQueryHitCount: 1,
    ...overrides,
  };
}

test("baseline pick uses live weights, sweet-spot bonus, and standalone bonus", () => {
  const result = scorePick(base());
  assert.equal(result.breakdown.nlmRaw, 80);
  assert.equal(result.breakdown.categoryWeight, getCategoryWeight("dry-joke"));
  assert.equal(result.breakdown.durationMod, DURATION_BONUS);
  assert.equal(result.breakdown.standaloneMod, STANDALONE_BONUS);
});

test("hot-take boost uses the live category weight", () => {
  const result = scorePick(base({ categories: ["hot-take"] }));
  assert.equal(result.breakdown.categoryWeight, getCategoryWeight("hot-take"));
});

test("multi-category picks use MAX weight", () => {
  const result = scorePick(base({ categories: ["dry-joke", "hot-take"] }));
  assert.equal(
    result.breakdown.categoryWeight,
    Math.max(getCategoryWeight("dry-joke"), getCategoryWeight("hot-take")),
  );
});

test("clip below the current hard minimum gets the duration penalty", () => {
  const result = scorePick(base({ durationSec: DURATION_HARD_LIMITS.min - 1 }));
  assert.equal(result.breakdown.durationMod, DURATION_PENALTY);
});

test("too-long clip (>90s): duration penalty", () => {
  const result = scorePick(base({ durationSec: 120 }));
  assert.equal(result.breakdown.durationMod, -15);
});

test("clip outside sweet spot but within hard limits: no duration mod", () => {
  const result = scorePick(base({ durationSec: DURATION_HARD_LIMITS.min }));
  assert.equal(result.breakdown.durationMod, 0);
});

test("setup-needed with long offset: long-setup penalty", () => {
  const result = scorePick(
    base({ setupNeeded: true, setupOffsetSec: LONG_SETUP_THRESHOLD_SEC + 1 }),
  );
  assert.equal(
    result.breakdown.setupMod,
    SETUP_NEEDED_PENALTY + LONG_SETUP_PENALTY,
  );
});

test("setup-needed with short offset: no long-setup penalty", () => {
  const result = scorePick(
    base({ setupNeeded: true, setupOffsetSec: 300 }),
  );
  assert.equal(result.breakdown.setupMod, SETUP_NEEDED_PENALTY);
});

test("cross-category bonus: pick in 3 queries", () => {
  const result = scorePick(base({ categoryQueryHitCount: 3 }));
  assert.equal(result.breakdown.crossCategoryBonus, CROSS_CATEGORY_BONUS);
});

test("missing strength defaults to 3 (60 raw)", () => {
  const result = scorePick(base({ strength: undefined }));
  assert.equal(result.breakdown.nlmRaw, 60);
});

test("score is clamped to [0, 100]", () => {
  // strength 5, hot-take, 45s, standalone, 3 categories
  // 100 * 1.15 + 10 + 5 + 3 = 133 → 100
  const r1 = scorePick(
    base({
      strength: 5,
      categories: ["hot-take"],
      categoryQueryHitCount: 3,
    }),
  );
  assert.equal(r1.final, 100);

  // strength 1, one-liner, too short, needs long setup
  // 20 * 0.9 - 15 + 0 - 5 = -2 → 0
  const r2 = scorePick(
    base({
      strength: 1,
      categories: ["one-liner"],
      durationSec: 5,
      setupNeeded: true,
      setupOffsetSec: 3600,
    }),
  );
  assert.equal(r2.final, 0);
});

test("story-of-stream uses its live category weight", () => {
  const result = scorePick(base({ categories: ["story-of-stream"] }));
  assert.equal(result.breakdown.categoryWeight, getCategoryWeight("story-of-stream"));
});

test("unknown category falls back to 1.0 weight", () => {
  const result = scorePick(base({ categories: ["bogus-category"] }));
  assert.equal(result.breakdown.categoryWeight, 1.0);
});
