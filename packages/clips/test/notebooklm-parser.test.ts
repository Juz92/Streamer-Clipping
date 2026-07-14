import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHumorQuery,
  parseRunningBitsQuery,
  parseTimestampToSec,
  parseEmotionalPeaksQuery,
  parseHotTakesQuery,
  parseDramaQuery,
  parseOneLinersQuery,
  parseStoryOfStreamQuery,
  parseEnrichmentQuery,
  dedupePicks,
} from "../src/lib/notebooklm-parser.js";
import type { NotebookLMPick } from "../src/lib/notebooklm-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures");

test("parseTimestampToSec handles [HH:MM:SS] format", () => {
  assert.equal(parseTimestampToSec("[00:00:00]"), 0);
  assert.equal(parseTimestampToSec("[00:01:30]"), 90);
  assert.equal(parseTimestampToSec("[01:12:47]"), 4367);
  assert.equal(parseTimestampToSec("[11:00:19]"), 39619);
});

test("parseTimestampToSec returns -1 for malformed input", () => {
  assert.equal(parseTimestampToSec("not a timestamp"), -1);
  assert.equal(parseTimestampToSec(""), -1);
});

test("parseHumorQuery extracts picks from query 1 fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "query1-humor.json"), "utf-8"),
  );
  const picks = parseHumorQuery(fixture);

  // Trial had 15 picks
  assert.ok(picks.length >= 10, `expected >= 10 picks, got ${picks.length}`);
  assert.ok(picks.length <= 20, `expected <= 20 picks, got ${picks.length}`);

  // Every pick has required fields
  for (const p of picks) {
    assert.ok(p.startSec >= 0);
    assert.ok(p.hook.length > 0);
    assert.ok(p.categories.length > 0);
    assert.ok(
      ["callback", "running-bit", "dry-joke", "absurdist", "reaction-gold", "character-moment"].includes(
        p.categories[0],
      ),
      `unexpected category: ${p.categories[0]}`,
    );
    assert.equal(typeof p.setupNeeded, "boolean");
    assert.equal(p.sourceQuery, "humor");
  }
});

test("parseHumorQuery finds the berry logic pick at 01:12:47", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "query1-humor.json"), "utf-8"),
  );
  const picks = parseHumorQuery(fixture);
  const berry = picks.find(
    (p) => Math.abs(p.startSec - 4367) <= 5,
  );
  assert.ok(berry, "expected to find berry logic pick near 01:12:47");
  assert.match(berry!.hook.toLowerCase(), /30,?000|berr/);
  assert.equal(berry!.categories[0], "dry-joke");
});

test("parseRunningBitsQuery extracts bits from query 2 fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "query2-runningbits.json"), "utf-8"),
  );
  const picks = parseRunningBitsQuery(fixture);

  // Trial had 10 running bits, each with best-clip timestamp
  assert.ok(picks.length >= 5, `expected >= 5 bits, got ${picks.length}`);

  for (const p of picks) {
    assert.ok(p.startSec >= 0);
    assert.equal(p.categories[0], "running-bit");
    assert.equal(p.sourceQuery, "running-bits");
    // Running bits are multi-timestamp by nature; should carry additional refs
    assert.ok(
      p.additionalTimestamps === undefined ||
        Array.isArray(p.additionalTimestamps),
    );
  }
});

// Synthetic fixture matching the prompt's expected output format
const SYNTHETIC_EMOTIONAL = {
  value: {
    answer: `Here are 5 emotional peak moments:

1. **Rage: The 6767 Discovery**
    *   **Timestamp:** [05:40:24]
    *   **Hook:** When you realize everyone has your base code
    *   **Emotion:** rage
    *   **Setup Needed:** No

2. **Triumph: Sniper Clutch**
    *   **Timestamp:** [02:49:00]
    *   **Hook:** One-shot across the map
    *   **Emotion:** triumph
    *   **Setup Needed:** No
`,
    conversation_id: "test",
  },
};

test("parseEmotionalPeaksQuery extracts emotional moments", () => {
  const picks = parseEmotionalPeaksQuery(SYNTHETIC_EMOTIONAL as any);
  assert.equal(picks.length, 2);
  assert.equal(picks[0].startSec, 5 * 3600 + 40 * 60 + 24);
  assert.equal(picks[0].categories[0], "rage");
  assert.equal(picks[0].sourceQuery, "emotional-peaks");
});

const SYNTHETIC_STORY = {
  value: {
    answer: `### The Story of the Stream

**Timestamp:** [05:40:24]
**Hook:** The slow-motion horror of Peanut realizing everyone knows his base code
**Why this is THE moment:** This is the single biggest comedy beat of the stream.
`,
    conversation_id: "test",
  },
};

test("parseStoryOfStreamQuery extracts single hero pick", () => {
  const picks = parseStoryOfStreamQuery(SYNTHETIC_STORY as any);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].startSec, 5 * 3600 + 40 * 60 + 24);
  assert.equal(picks[0].categories[0], "story-of-stream");
  assert.equal(picks[0].strength, 5); // Hero pick always max
});

const SYNTHETIC_ENRICHMENT = {
  value: {
    answer: `### Enrichment for candidates

**1. [01:12:47] \u2014 30,000 Hour Berry Logic**
- Cold open: [01:12:25]
- Natural end: [01:14:16]
- Thumbnail: [01:13:36]
- Title drafts:
  1. He Has 30,000 Hours And Can't Grow Berries
  2. 4 Years Of Full-Time Berry Farming
  3. The Math Got Him FUMING

**2. [05:40:24] \u2014 6767 Security Breach**
- Cold open: [05:40:18]
- Natural end: [05:41:15]
- Thumbnail: [05:40:40]
- Title drafts:
  1. Everyone Knew His Base Code
  2. His "Secure" Base Was Using 6767
  3. 5 Hours Later He Figured It Out
`,
    conversation_id: "test",
  },
};

test("parseEnrichmentQuery extracts enrichment records", () => {
  const records = parseEnrichmentQuery(SYNTHETIC_ENRICHMENT as any);
  assert.equal(records.length, 2);

  const first = records[0];
  assert.equal(first.anchorStartSec, 4367); // 01:12:47
  assert.equal(first.coldOpenSec, 4345); // 01:12:25
  assert.equal(first.naturalEndSec, 4456); // 01:14:16
  assert.equal(first.thumbnailSec, 4416); // 01:13:36
  assert.equal(first.titleDrafts.length, 3);
  assert.match(first.titleDrafts[0], /30,?000|Berr/);
});

function mkPick(overrides: Partial<NotebookLMPick>): NotebookLMPick {
  return {
    startSec: 100,
    endSec: 145,
    hook: "Test hook",
    categories: ["dry-joke"],
    setupNeeded: false,
    setupOffsetSec: 0,
    strength: 4,
    sourceQuery: "humor",
    ...overrides,
  };
}

test("dedupePicks: picks within 30s overlap are merged", () => {
  const picks = [
    mkPick({ startSec: 100, categories: ["dry-joke"], sourceQuery: "humor" }),
    mkPick({ startSec: 115, categories: ["hot-take"], sourceQuery: "hot-takes" }),
  ];
  const merged = dedupePicks(picks);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].categories.sort(), ["dry-joke", "hot-take"]);
  assert.equal(merged[0].categoryQueryHitCount, 2);
});

test("dedupePicks: picks > 30s apart stay separate", () => {
  const picks = [
    mkPick({ startSec: 100 }),
    mkPick({ startSec: 131 }),
  ];
  const merged = dedupePicks(picks);
  assert.equal(merged.length, 2);
});

test("dedupePicks: merged pick keeps earliest start and highest strength", () => {
  const picks = [
    mkPick({ startSec: 110, strength: 3, hook: "later weaker" }),
    mkPick({ startSec: 100, strength: 5, hook: "earlier stronger" }),
  ];
  const merged = dedupePicks(picks);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].startSec, 100);
  assert.equal(merged[0].strength, 5);
  assert.equal(merged[0].hook, "earlier stronger");
});

test("dedupePicks: preserves additionalTimestamps from running bits", () => {
  const picks = [
    mkPick({
      startSec: 100,
      categories: ["running-bit"],
      sourceQuery: "running-bits",
      additionalTimestamps: [50, 200, 300],
    }),
    mkPick({ startSec: 105, categories: ["dry-joke"], sourceQuery: "humor" }),
  ];
  const merged = dedupePicks(picks);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].additionalTimestamps, [50, 200, 300]);
});
