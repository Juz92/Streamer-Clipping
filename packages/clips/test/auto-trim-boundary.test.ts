import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAutoTrimEnhanced,
  snapEndBoundaryEnhanced,
  snapStartBoundaryEnhanced,
  snapToSpeakerEnd,
  snapToSpeakerStart,
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

test("speaker snapping cannot cross authoritative grounded boundaries", () => {
  assert.equal(snapToSpeakerStart([{ speaker: "a", start: 12, end: 20 }], 10, 5), null);
  assert.equal(snapToSpeakerEnd([{ speaker: "a", start: 0, end: 8 }], 10, 5), null);
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

test("auto trim follows active speech to a natural stop instead of cutting at the loud peak", () => {
  const words = [
    { word: "we", startMs: 9_800, endMs: 10_400 },
    { word: "are", startMs: 10_500, endMs: 11_200 },
    { word: "still", startMs: 11_300, endMs: 12_100 },
    { word: "finishing", startMs: 12_200, endMs: 13_300 },
    { word: "the", startMs: 13_400, endMs: 14_000 },
    { word: "whole", startMs: 14_100, endMs: 15_100 },
    { word: "sentence", startMs: 15_200, endMs: 16_400 },
    { word: "properly.", startMs: 16_500, endMs: 18_000 },
  ];

  const result = computeAutoTrimEnhanced({
    paddedDurationSec: 30,
    signalStartInClipSec: 0,
    signalEndInClipSec: 10,
    whisperWords: words,
    audioSamples: [{ timeSec: 10, rmsLevel: -10 }],
  });

  assert.equal(result.contentEnd, 18);
  assert.equal(result.notes.endSnap, "punctuation");
});
