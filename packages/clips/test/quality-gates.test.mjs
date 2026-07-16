import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertApprovedReviewWindows, assertFrame0Package, blocksMissingQaReview, blocksMissingTranscriptReview, chooseReviewPacketClips, evaluateRenderedShorts, hasFirstThreeSecondHook, hasFreshPreUploadPass, publicationBlockers, selectPromotedEntries } from "../dist/quality-gates.js";

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

test("render selection keeps only canonical promoted candidates and may return fewer than three", () => {
  const entries = [
    { candidateId: "job:a", rank: 1 },
    { candidateId: "job:b", rank: 2 },
    { candidateId: "job:c", rank: 3 },
  ];
  assert.deepEqual(selectPromotedEntries(entries, ["job:b"]), [entries[1]]);
  assert.throws(() => selectPromotedEntries([{ rank: 1 }], ["job:a"]), /candidateId/);
  assert.throws(() => selectPromotedEntries(entries, ["job:missing"]), /No promoted/);
});

test("rendering cannot change an approved A/B/C review window or its media duration", () => {
  const selection = { decision: "liked all", candidates: [{ candidateId: "job:a", startSec: 10, endSec: 30 }] };
  const approved = [{ candidateId: "job:a", sourceStartSec: 10, sourceEndSec: 30, clipFile: "a.mp4" }];
  assert.doesNotThrow(() => assertApprovedReviewWindows(selection, approved, { "a.mp4": 20.05 }));
  assert.throws(() => assertApprovedReviewWindows(selection, [{ ...approved[0], sourceStartSec: 12 }]), /window changed/);
  assert.throws(() => assertApprovedReviewWindows(selection, approved, { "a.mp4": 17 }), /media duration changed/);
});

test("frame-zero package requires an explicit in-range expression and deliberate short lines", () => {
  const clips = { 1: 92.16, 2: 42.08 };
  const valid = [
    { rank: 1, frame0Hook: "FLUNG TO / THE MOON", frame0OffsetSec: 84 },
    { rank: 2, frame0Hook: "A SEX / WHEEL?", frame0OffsetSec: 29.5 },
  ];
  assert.doesNotThrow(() => assertFrame0Package(valid, clips));
  assert.throws(() => assertFrame0Package(valid.slice(0, 1), clips), /missing metadata for rank 2/);
  assert.throws(() => assertFrame0Package([{ ...valid[0], frame0Hook: "TOO MANY WORDS ON THIS LINE / PAYOFF" }, valid[1]], clips), /three words per line/);
  assert.throws(() => assertFrame0Package([{ ...valid[0], frame0Hook: "NO DELIBERATE BREAK" }, valid[1]], clips), /explicit.*\//);
  assert.throws(() => assertFrame0Package([{ ...valid[0], frame0OffsetSec: 92.16 }, valid[1]], clips), /outside clip duration/);
});

test("API publication blocks until every promotion gate passes", () => {
  const ready = {
    promoted: true,
    privateStatus: "keep",
    rightsStatus: "cleared",
    qualityPassed: true,
    publishApproved: true,
  };
  assert.deepEqual(publicationBlockers(ready), []);
  assert.deepEqual(publicationBlockers({
    ...ready,
    promoted: false,
    rightsStatus: "unresolved",
    qualityPassed: false,
    publishApproved: false,
  }), ["not-promoted", "rights-unresolved", "quality-unresolved", "private-publish-approval-missing"]);
});

test("distribution requires a complete fresh pre-upload report", () => {
  const jobDir = mkdtempSync(join(tmpdir(), "distribution-gates-"));
  try {
    const shortsDir = join(jobDir, "shorts");
    mkdirSync(shortsDir);
    const inputs = [
      "trim-results.json",
      "upload-metadata.json",
      "upload-metadata.md",
      "story-gates.json",
      "gemini-reviews.json",
    ].map((file) => join(jobDir, file));
    inputs.push(join(shortsDir, "01-test.mp4"));
    for (const path of inputs) writeFileSync(path, "fixture", "utf-8");

    const reportPath = join(jobDir, "preflight-pre-upload.json");
    writeFileSync(reportPath, JSON.stringify({ stage: "pre-upload", checks: [{ name: "shorts", severity: "PASS" }] }), "utf-8");
    assert.equal(hasFreshPreUploadPass(jobDir), false);

    const required = [
      "manifest.videoPath", "manifest.subtitlePath", "moments", "trim-results", "raw-clips",
      "shorts", "rendered-short-qa", "upload-metadata.md", "upload-metadata.json", "story-gates", "gemini-review",
    ];
    writeFileSync(reportPath, JSON.stringify({
      stage: "pre-upload",
      checks: required.map((name) => ({ name, severity: "PASS" })),
    }), "utf-8");
    assert.equal(hasFreshPreUploadPass(jobDir), true);

    const future = new Date(Date.now() + 5_000);
    utimesSync(join(jobDir, "trim-results.json"), future, future);
    assert.equal(hasFreshPreUploadPass(jobDir), false);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});
