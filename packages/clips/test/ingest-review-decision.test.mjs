import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendManualFeedback, mergeReviewRecords, normalizeReviewRecord } from "../dist/ingest-review-decision.js";

const requiredLabels = {
  lane: "peanut-bits",
  reaction: "nothing",
  coldOpenAccepted: false,
  arcIntent: "single-arc",
};

const beats = {
  setupStartSec: 100,
  premiseClearSec: 105,
  actionStartSec: 110,
  payoffStartSec: 118,
  payoffEndSec: 121,
  reactionEndSec: 126,
  flashSec: 119,
};

test("captures durable candidate-level taste, cold-open, arc, and boundary labels", () => {
  const record = normalizeReviewRecord(
    "stream-1",
    {
      chosenRank: 2,
      decisions: [{
        rank: 2,
        candidateId: "job-001:moment-2",
        momentId: "moment-2",
        status: "keep",
        lane: "peanut-bits",
        reaction: "lol",
        rejectionReason: null,
        coldOpenAccepted: true,
        correctedBeats: beats,
        arcIntent: "single-arc",
      }],
    },
    { suggestedRank: 2 },
    [{
      rank: 2,
      candidateId: "job-001:moment-2",
      momentId: "moment-2",
      contentLane: "peanut-bits",
      payoffType: "roast",
      laneScore: 0.88,
      laughOutLoudScore: 0.72,
      humorPotential: 0.76,
    }],
  );

  assert.equal(record.acceptedSuggestedPick, true);
  assert.equal(record.decisions[0].status, "keep");
  assert.equal(record.decisions[0].candidateId, "job-001:moment-2");
  assert.equal(record.decisions[0].momentId, "moment-2");
  assert.equal(record.decisions[0].lane, "peanut-bits");
  assert.equal(record.decisions[0].reaction, "lol");
  assert.equal(record.decisions[0].coldOpenAccepted, true);
  assert.equal(record.decisions[0].arcIntent, "single-arc");
  assert.deepEqual(record.decisions[0].correctedBeats, beats);
});

test("candidate-level reruns preserve prior labels and update only repeated identities", () => {
  const first = normalizeReviewRecord("stream-1", {
    decisions: [
      { ...requiredLabels, rank: 1, candidateId: "job-001:a", momentId: "a", status: "keep", reaction: "lol" },
      { ...requiredLabels, rank: 2, candidateId: "job-001:b", momentId: "b", status: "reserve", reaction: "smiled", correctedBeats: beats },
    ],
  }, {});
  const rerun = normalizeReviewRecord("stream-1", {
    decisions: [{ ...requiredLabels, rank: 2, candidateId: "job-001:b", momentId: "b", status: "reject", reaction: "nothing", rejectionReason: "no-payoff", correctedBeats: null }],
  }, {});

  const merged = mergeReviewRecords(first, rerun);
  assert.deepEqual(merged.decisions.map((item) => item.candidateId), ["job-001:a", "job-001:b"]);
  assert.equal(merged.decisions[0].status, "keep");
  assert.equal(merged.decisions[1].status, "reject");
  assert.equal(merged.decisions[1].rejectionReason, "no-payoff");
  assert.deepEqual(merged.decisions[1].correctedBeats, beats);
});

test("candidate label storage round-trips and preserves prior rerun decisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-labels-"));
  const path = join(dir, "manual-review-feedback.json");
  try {
    const first = normalizeReviewRecord("stream-1", {
      decisions: [{ ...requiredLabels, rank: 1, candidateId: "job-001:a", momentId: "a", status: "keep", reaction: "lol" }],
    }, {});
    const rerun = normalizeReviewRecord("stream-1", {
      decisions: [{ ...requiredLabels, rank: 2, candidateId: "job-001:b", momentId: "b", status: "reject", rejectionReason: "no-payoff" }],
    }, {});
    appendManualFeedback(first, path);
    appendManualFeedback(rerun, path);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.records[0].decisions.map((item) => item.candidateId), ["job-001:a", "job-001:b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects missing, conflicting, duplicate, and invalid corrected identities", () => {
  assert.throws(() => normalizeReviewRecord("stream-1", {
    decisions: [{ rank: 1, candidateId: "job-001:a", momentId: "a", status: "keep" }],
  }, {}), /lane/);
  assert.throws(() => normalizeReviewRecord("stream-1", {
    decisions: [{ rank: 1, candidateId: "", momentId: "a", status: "keep" }],
  }, {}), /candidateId/);
  assert.throws(() => normalizeReviewRecord("stream-1", {
    decisions: [{ ...requiredLabels, rank: 1, candidateId: "job-001:missing", momentId: "missing", status: "keep" }],
  }, {}, [{ rank: 1, candidateId: "job-001:a", momentId: "a" }]), /missing from/);
  assert.throws(() => normalizeReviewRecord("stream-1", {
    decisions: [{ ...requiredLabels, lane: "made-up", rank: 1, candidateId: "job-001:a", momentId: "a", status: "keep" }],
  }, {}), /valid lane/);
  assert.throws(() => normalizeReviewRecord("stream-1", {
    decisions: [{ ...requiredLabels, rank: 1, candidateId: "job-001:a:b", momentId: "b", status: "keep" }],
  }, {}), /does not match/);
  assert.throws(() => normalizeReviewRecord("stream-1", {
    decisions: [
      { ...requiredLabels, rank: 1, candidateId: "job-001:a", momentId: "a", status: "keep" },
      { ...requiredLabels, rank: 2, candidateId: "job-001:a", momentId: "a", status: "reserve" },
    ],
  }, {}), /Duplicate/);
  assert.throws(() => normalizeReviewRecord("stream-1", {
    decisions: [{
      ...requiredLabels,
      rank: 1,
      candidateId: "job-001:a",
      momentId: "a",
      status: "keep",
      correctedBeats: { ...beats, payoffStartSec: 90 },
    }],
  }, {}), /ordered/);
});
