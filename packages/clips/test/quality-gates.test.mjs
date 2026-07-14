import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksMissingQaReview, blocksMissingTranscriptReview, chooseReviewPacketClips, evaluateRenderedShorts, hasFirstThreeSecondHook } from "../dist/quality-gates.js";

test("first-3s hook passes on explicit flash or early signal, fails on slow setup", () => {
  assert.equal(hasFirstThreeSecondHook({ startSec: 100, text: "", flashDuration: 2, events: [] }), true);
  assert.equal(hasFirstThreeSecondHook({ startSec: 100, text: "", events: [{ timestampSec: 101, strength: 0.8 }] }), true);
  assert.equal(hasFirstThreeSecondHook({ startSec: 100, text: "slow setup", events: [{ timestampSec: 110, strength: 1 }] }), false);
});

test("render QA blocks missing audio, wrong dimensions, and bad durations", () => {
  const result = evaluateRenderedShorts([
    { file: "01-good.mp4", width: 1080, height: 1920, durationSec: 35, hasAudio: true },
    { file: "02-wide.mp4", width: 1920, height: 1080, durationSec: 35, hasAudio: true },
    { file: "03-silent.mp4", width: 1080, height: 1920, durationSec: 35, hasAudio: false },
    { file: "04-long.mp4", width: 1080, height: 1920, durationSec: 75, hasAudio: true },
  ]);
  assert.equal(result.bad, 3);
  assert.match(result.message, /02-wide/);
  assert.match(result.message, /03-silent/);
  assert.match(result.message, /04-long/);
});

test("production gates block scorer-only and no-QA runs unless explicit bypass or dry run", () => {
  assert.equal(blocksMissingTranscriptReview({ reviewed: false }), true);
  assert.equal(blocksMissingTranscriptReview({ reviewed: false, allowScorerOnly: true }), false);
  assert.equal(blocksMissingTranscriptReview({ reviewed: false, dryRun: true }), false);
  assert.equal(blocksMissingTranscriptReview({ reviewed: true }), false);

  assert.equal(blocksMissingQaReview({ qaAvailable: false }), true);
  assert.equal(blocksMissingQaReview({ qaAvailable: false, allowNoQa: true }), false);
  assert.equal(blocksMissingQaReview({ qaAvailable: false, dryRun: true }), false);
  assert.equal(blocksMissingQaReview({ qaAvailable: true }), false);
});

test("review packet is suggested first then best candidates, capped at three", () => {
  const clips = [
    { rank: 1, file: "01.mp4", title: "one", quality: { rank: 1, status: "candidate", arcCompleteness: 0.9 } },
    { rank: 2, file: "02.mp4", title: "two", quality: { rank: 2, status: "suggested", arcCompleteness: 0.7 } },
    { rank: 3, file: "03.mp4", title: "three", quality: { rank: 3, status: "reserve", arcCompleteness: 1 } },
    { rank: 4, file: "04.mp4", title: "four", quality: { rank: 4, status: "candidate", arcCompleteness: 0.8 } },
  ];
  assert.deepEqual(chooseReviewPacketClips(clips, 2).map((c) => c.rank), [2, 1, 4]);
});
