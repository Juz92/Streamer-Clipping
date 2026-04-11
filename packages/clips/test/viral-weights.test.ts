import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_WEIGHTS,
  DURATION_SWEET_SPOT,
  DURATION_HARD_LIMITS,
  DURATION_BONUS,
  DURATION_PENALTY,
  STANDALONE_BONUS,
  LONG_SETUP_PENALTY,
  LONG_SETUP_THRESHOLD_SEC,
  CROSS_CATEGORY_BONUS,
} from "../src/lib/viral-weights.js";

test("category weights cover all 11 viral categories", () => {
  const expected = [
    "hot-take",
    "drama",
    "running-bit",
    "character-moment",
    "callback",
    "dry-joke",
    "absurdist",
    "emotional-peak",
    "reaction-gold",
    "one-liner",
    "story-of-stream",
  ];
  for (const cat of expected) {
    assert.ok(
      typeof CATEGORY_WEIGHTS[cat] === "number",
      `missing weight for ${cat}`,
    );
  }
  assert.equal(Object.keys(CATEGORY_WEIGHTS).length, expected.length);
});

test("hot-take has highest weight (drives comments)", () => {
  const sorted = Object.entries(CATEGORY_WEIGHTS).sort((a, b) => b[1] - a[1]);
  // story-of-stream is the single hero pick bonus, so it's allowed to be higher
  const topWithoutHero = sorted.filter(([k]) => k !== "story-of-stream")[0];
  assert.equal(topWithoutHero[0], "hot-take");
});

test("one-liner has lowest weight (feeds titles, not standalone)", () => {
  const sorted = Object.entries(CATEGORY_WEIGHTS).sort((a, b) => a[1] - b[1]);
  assert.equal(sorted[0][0], "one-liner");
});

test("duration limits are coherent", () => {
  assert.ok(DURATION_SWEET_SPOT.min < DURATION_SWEET_SPOT.max);
  assert.ok(DURATION_HARD_LIMITS.min <= DURATION_SWEET_SPOT.min);
  assert.ok(DURATION_HARD_LIMITS.max >= DURATION_SWEET_SPOT.max);
});

test("modifiers are numeric", () => {
  assert.equal(typeof DURATION_BONUS, "number");
  assert.equal(typeof DURATION_PENALTY, "number");
  assert.equal(typeof STANDALONE_BONUS, "number");
  assert.equal(typeof LONG_SETUP_PENALTY, "number");
  assert.equal(typeof LONG_SETUP_THRESHOLD_SEC, "number");
  assert.equal(typeof CROSS_CATEGORY_BONUS, "number");
});
