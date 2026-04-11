import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePick } from "../src/lib/notebooklm-scorer.js";
import type { ScoreInput } from "../src/lib/notebooklm-scorer.js";

function base(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    strength: 4,
    categories: ["dry-joke"],
    durationSec: 45,
    setupNeeded: false,
    setupOffsetSec: 0,
    categoryQueryHitCount: 1,
    ...overrides,
  };
}

test("baseline pick: strength 4, dry-joke, 45s, standalone", () => {
  // nlmRaw = 4*20 = 80
  // weight = 1.0 (dry-joke)
  // +10 duration bonus (20-70)
  // +5 standalone bonus
  // = 80 + 10 + 5 = 95
  const result = scorePick(base());
  assert.equal(result.final, 95);
  assert.equal(result.breakdown.nlmRaw, 80);
  assert.equal(result.breakdown.categoryWeight, 1.0);
  assert.equal(result.breakdown.durationMod, 10);
  assert.equal(result.breakdown.standaloneMod, 5);
});

test("hot-take boost: category weight 1.15 applied", () => {
  const result = scorePick(base({ categories: ["hot-take"] }));
  // nlmRaw(80) * 1.15 + 10 + 5 = 92 + 10 + 5 = 107 → clamped to 100
  assert.equal(result.final, 100);
});

test("multi-category picks use MAX weight", () => {
  const result = scorePick(base({ categories: ["dry-joke", "hot-take"] }));
  // uses 1.15 (max), not 1.0
  assert.equal(result.breakdown.categoryWeight, 1.15);
});

test("too-short clip (<10s): duration penalty", () => {
  const result = scorePick(base({ durationSec: 8 }));
  // 80 * 1.0 - 15 + 5 = 70
  assert.equal(result.final, 70);
});

test("too-long clip (>90s): duration penalty", () => {
  const result = scorePick(base({ durationSec: 120 }));
  assert.equal(result.breakdown.durationMod, -15);
});

test("clip outside sweet spot but within hard limits: no duration mod", () => {
  const result = scorePick(base({ durationSec: 15 }));
  assert.equal(result.breakdown.durationMod, 0);
});

test("setup-needed with long offset: long-setup penalty", () => {
  const result = scorePick(
    base({ setupNeeded: true, setupOffsetSec: 3600 }),
  );
  // 80 * 1.0 + 10 + 0 (no standalone bonus) - 5 (long setup) = 85
  assert.equal(result.final, 85);
});

test("setup-needed with short offset: no long-setup penalty", () => {
  const result = scorePick(
    base({ setupNeeded: true, setupOffsetSec: 300 }),
  );
  // 80 * 1.0 + 10 + 0 - 0 = 90
  assert.equal(result.final, 90);
});

test("cross-category bonus: pick in 3 queries", () => {
  const result = scorePick(base({ categoryQueryHitCount: 3 }));
  // 80 + 10 + 5 + 3 = 98
  assert.equal(result.final, 98);
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

test("story-of-stream gets highest category weight (1.20)", () => {
  const result = scorePick(base({ categories: ["story-of-stream"] }));
  assert.equal(result.breakdown.categoryWeight, 1.2);
});

test("unknown category falls back to 1.0 weight", () => {
  const result = scorePick(base({ categories: ["bogus-category"] }));
  assert.equal(result.breakdown.categoryWeight, 1.0);
});
