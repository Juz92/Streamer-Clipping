import { test } from "node:test";
import assert from "node:assert/strict";
import {
  snapEndBoundaryEnhanced,
  snapStartBoundaryEnhanced,
} from "../src/lib/enhanced-auto-trim.js";

test("start snapping preserves the grounded setup instead of skipping forward", () => {
  const words = [
    { word: "before", startMs: 7_000, endMs: 8_000 },
    { word: "setup", startMs: 9_000, endMs: 9_400 },
    { word: "later", startMs: 10_500, endMs: 11_000 },
  ];

  const snapped = snapStartBoundaryEnhanced(words, 10, 5, 600);

  assert.equal(snapped.sec, 9);
  assert.equal(snapped.source, "silence");
});

test("end snapping preserves the grounded reaction instead of cutting backward", () => {
  const words = [
    { word: "early.", startMs: 8_500, endMs: 9_200 },
    { word: "unfinished", startMs: 9_800, endMs: 10_500 },
    { word: "complete.", startMs: 10_600, endMs: 11_500 },
  ];

  const snapped = snapEndBoundaryEnhanced(words, 10, 5, 600);

  assert.equal(snapped.sec, 11.5);
  assert.equal(snapped.source, "punctuation");
});

test("end snapping keeps an authoritative end already after punctuation", () => {
  const words = [
    { word: "complete.", startMs: 9_000, endMs: 9_800 },
    { word: "next.", startMs: 10_300, endMs: 11_000 },
  ];

  const snapped = snapEndBoundaryEnhanced(words, 10, 5, 600);

  assert.equal(snapped.sec, 10);
  assert.equal(snapped.source, "punctuation");
});
