import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FEEDBACK_SCHEMA_VERSION,
  appendManualFeedback,
  normalizeReviewRecord,
} from "../src/ingest-review-decision.js";

// Regression guard for the four-month stall found on 2026-11-02: the corpus gate
// held ten labels and counted zero as benchmark-eligible, because five required
// classification fields had never once been collected and nothing complained.

const BEATS = {
  setupStartSec: 10,
  premiseClearSec: 12,
  actionStartSec: 14,
  payoffStartSec: 18,
  payoffEndSec: 22,
  reactionEndSec: 25,
};

/** A decision item that satisfies every eligibility input. */
function completeItem(overrides: Record<string, unknown> = {}) {
  return {
    rank: 1,
    candidateId: "job-006-2026-07-16:recall-abc123",
    momentId: "recall-abc123",
    status: "keep",
    lane: "peanut-bits",
    reaction: "lol",
    coldOpenAccepted: true,
    arcIntent: "single-arc",
    contextLevel: "self-contained",
    contextCarrier: "dialogue",
    visualProofRequired: false,
    primaryEvidenceModality: "dialogue",
    repetitionClass: "distinctive",
    correctedBeats: BEATS,
    ...overrides,
  };
}

function normalize(item: Record<string, unknown>, grounded?: ReadonlySet<string>) {
  return normalizeReviewRecord(
    "DRR2zh3YscM",
    { decisions: [item] } as never,
    {} as never,
    [],
    grounded,
  );
}

test("a complete decision is accepted", () => {
  const record = normalize(completeItem());
  assert.equal(record.decisions.length, 1);
  assert.equal(record.decisions[0].contextLevel, "self-contained");
});

// One case per field that was never collected. Each of these produced a label
// that looked fine and was silently uncountable.
for (const field of [
  "contextLevel",
  "contextCarrier",
  "visualProofRequired",
  "primaryEvidenceModality",
  "repetitionClass",
  "arcIntent",
]) {
  test(`a decision missing ${field} is refused`, () => {
    assert.throws(
      () => normalize(completeItem({ [field]: undefined })),
      `omitting ${field} should throw rather than write an uncountable label`,
    );
  });
}

test("a decision with no beats at all is refused when grounding cannot supply them", () => {
  assert.throws(
    () => normalize(completeItem({ correctedBeats: null }), new Set<string>()),
    /no corrected Beat Map and no complete grounded one/,
  );
});

test("a decision with no beats is accepted when grounding supplies a complete set", () => {
  const record = normalize(
    completeItem({ correctedBeats: null }),
    new Set(["job-006-2026-07-16:recall-abc123"]),
  );
  assert.equal(record.decisions.length, 1);
});

test("beats that run out of order are refused", () => {
  assert.throws(
    () => normalize(completeItem({ correctedBeats: { ...BEATS, payoffEndSec: 1 } })),
    /ordered/,
  );
});

test("a feedback file from another schema version is not merged into", () => {
  const dir = mkdtempSync(join(tmpdir(), "label-schema-"));
  const path = join(dir, "manual-review-feedback.json");
  try {
    writeFileSync(path, JSON.stringify({ version: FEEDBACK_SCHEMA_VERSION + 1, records: [] }), "utf-8");
    assert.throws(
      () => appendManualFeedback(normalize(completeItem()), path),
      /Migrate it explicitly/,
      "merging across schema versions is how the two sessions diverged unnoticed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a feedback file at the current version is written back at that version", () => {
  const dir = mkdtempSync(join(tmpdir(), "label-schema-"));
  const path = join(dir, "manual-review-feedback.json");
  try {
    appendManualFeedback(normalize(completeItem()), path);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(written.version, FEEDBACK_SCHEMA_VERSION);
    assert.equal(written.records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
