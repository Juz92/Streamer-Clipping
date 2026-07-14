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

test("category weights retain every legacy viral category", () => {
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
});

test("broad-appeal arcs outrank the legacy hot-take category", () => {
  assert.ok(CATEGORY_WEIGHTS["story-of-stream"] > CATEGORY_WEIGHTS["hot-take"]);
  assert.ok(CATEGORY_WEIGHTS["broad-appeal"] > CATEGORY_WEIGHTS["hot-take"]);
  assert.ok(CATEGORY_WEIGHTS["friend-roast"] > CATEGORY_WEIGHTS["hot-take"]);
});

test("reaction-only clips stay below baseline while one-liners remain viable", () => {
  assert.ok(CATEGORY_WEIGHTS["reaction-gold"] < CATEGORY_WEIGHTS["dry-joke"]);
  assert.ok(CATEGORY_WEIGHTS["one-liner"] >= CATEGORY_WEIGHTS["dry-joke"]);
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
