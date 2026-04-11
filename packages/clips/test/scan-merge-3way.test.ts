import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSources } from "../src/scan.js";

// Minimal fixture types matching the function signature
const manualA = {
  startSec: 100,
  endSec: 145,
  description: "Manual pick A",
  viralityScore: 80,
};

const automatedA = {
  id: "auto-1",
  suggestedStartSec: 500,
  suggestedEndSec: 550,
  suggestedDurationSec: 50,
  description: "Automated pick A",
  scores: { composite: 7.5 },
  transcriptSignals: [],
  chatSignals: [],
  audioSignals: [],
};

const notebookLMA = {
  id: "nlm-1",
  startSec: 110, // overlaps with manualA
  endSec: 155,
  description: "NLM pick overlapping manual",
  viralScore: 85,
  categories: ["hot-take"],
  hook: "Hot take hook",
  durationSec: 45,
  setupNeeded: false,
  titleDrafts: ["Title 1", "Title 2", "Title 3"],
};

const notebookLMB = {
  id: "nlm-2",
  startSec: 900, // no overlap
  endSec: 950,
  description: "NLM solo pick",
  viralScore: 70,
  categories: ["dry-joke"],
  hook: "Dry joke hook",
  durationSec: 50,
  setupNeeded: false,
  titleDrafts: ["T1", "T2", "T3"],
};

test("mergeSources: NLM pick overlapping manual merges into source=both", () => {
  const unified = mergeSources([manualA as any], [], [notebookLMA as any]);
  const merged = unified.find(
    (u) => Math.abs(u.startSec - 100) <= 30 || Math.abs(u.startSec - 110) <= 30,
  );
  assert.ok(merged);
  assert.equal(merged!.source, "both");
  // Manual wins timing
  assert.equal(merged!.startSec, 100);
  // Score is max of manual + nlm
  assert.equal(merged!.viralityScore, 85);
  // NLM enrichment fields populated
  assert.deepEqual(merged!.titleDrafts, ["Title 1", "Title 2", "Title 3"]);
  assert.deepEqual(merged!.categories, ["hot-take"]);
});

test("mergeSources: non-overlapping NLM pick added as source=notebooklm", () => {
  const unified = mergeSources([], [], [notebookLMB as any]);
  assert.equal(unified.length, 1);
  assert.equal(unified[0].source, "notebooklm");
  assert.equal(unified[0].startSec, 900);
});

test("mergeSources: empty inputs return empty array", () => {
  const unified = mergeSources([], [], []);
  assert.deepEqual(unified, []);
});

test("mergeSources: all three sources combined preserves distinct picks", () => {
  const unified = mergeSources(
    [manualA as any],
    [automatedA as any],
    [notebookLMA as any, notebookLMB as any],
  );
  assert.equal(unified.length, 3); // manual+nlmA merged, automated alone, nlmB alone
  assert.ok(unified.some((u) => u.source === "both"));
  assert.ok(unified.some((u) => u.source === "automated"));
  assert.ok(unified.some((u) => u.source === "notebooklm"));
});
