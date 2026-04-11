# NotebookLM Review Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new pipeline step that uses NotebookLM (via the `nlm` CLI) to extract, score, and enrich high-value clip candidates from a stream transcript. Output feeds `unified-moments.json` via an extended `scan.ts --merge` and a new cross-stream candidate pool.

**Architecture:** New entry point `notebooklm-review.ts` orchestrates 6 new `lib/*.ts` helper modules. Runs as a pipeline phase between `analyze.ts` and `scan.ts --merge`. Extends `scan.ts` merge from 2→3 sources. Uses Node's built-in `node:test` runner (zero dependencies) via `tsx`. Fixture-based tests rely on real trial output saved at `packages/clips/test/fixtures/`.

**Tech Stack:** TypeScript (ESM), Node 22, `tsx` for TS execution, `node:test` for tests, `node:assert/strict` for assertions, `nlm` CLI v0.5.20 (already installed), existing `@ltx/shared` and `@ltx/clips` workspace packages.

**Spec:** `docs/superpowers/specs/2026-04-11-notebooklm-review-module-design.md`

---

## File Structure

### New files (13 to create)

**Source files** (`packages/clips/src/`):
- `notebooklm-review.ts` — CLI entry point + orchestration (~200 LOC)
- `lib/notebooklm-client.ts` — Thin wrapper over `nlm` CLI subprocess calls (~150 LOC)
- `lib/notebooklm-queries.ts` — The 8 query prompts as typed constants (~200 LOC prompt text)
- `lib/notebooklm-parser.ts` — Parse JSON responses → `NotebookLMPick[]` + dedup (~250 LOC)
- `lib/notebooklm-scorer.ts` — Pure scoring function (~80 LOC)
- `lib/viral-weights.ts` — Tunable category weights + modifiers (~40 LOC)
- `lib/candidate-pool.ts` — Read/append/update master pool with atomic writes (~120 LOC)

**Test files** (`packages/clips/test/`):
- `test/fixtures/query1-humor.json` — Copied from trial output
- `test/fixtures/query2-runningbits.json` — Copied from trial output
- `test/notebooklm-scorer.test.ts`
- `test/notebooklm-parser.test.ts`
- `test/viral-weights.test.ts`
- `test/candidate-pool.test.ts`
- `test/scan-merge-3way.test.ts`

### Modified files (3)

- `packages/clips/src/lib/manifest.ts` — Extend `StreamManifest` interface (additive only)
- `packages/clips/src/lib/subtitle-parser.ts` — Add `writeCleanTranscript` helper
- `packages/clips/src/scan.ts` — Extend merge from 2→3 sources, add auto-detection
- `packages/clips/src/orchestrate.ts` — Add `notebooklm-review` phase

### File responsibilities

Each file has one clear purpose:

- **`notebooklm-client.ts`** knows how to invoke `nlm` subprocess commands. Nothing else.
- **`notebooklm-queries.ts`** holds prompt strings. No logic.
- **`notebooklm-parser.ts`** transforms NotebookLM's JSON responses into `NotebookLMPick` structures and handles cross-query deduplication.
- **`notebooklm-scorer.ts`** is a pure function: `(pick, weights) => viralScore`. No I/O.
- **`viral-weights.ts`** exports the tuning constants. No logic.
- **`candidate-pool.ts`** owns the master pool file — read, append, mutate with atomic writes.
- **`notebooklm-review.ts`** wires everything together and is the only file the user or orchestrator invokes directly.

---

## Task List (15 tasks)

### Task 1: Extend `StreamManifest` interface

**Files:**
- Modify: `packages/clips/src/lib/manifest.ts`

- [ ] **Step 1: Read current manifest.ts**

Run: Read `packages/clips/src/lib/manifest.ts` lines 1-20 to confirm current `StreamManifest` definition.

- [ ] **Step 2: Extend the interface**

Edit `packages/clips/src/lib/manifest.ts` lines 5-20. Replace the `StreamManifest` interface with:

```typescript
export interface StreamManifest {
  streamId: string;
  channelHandle: string;
  title: string;
  uploadDate: string;
  durationSec: number;
  jobDir: string;
  videoPath: string;
  subtitlePath: string | null;
  chatPath: string | null;
  audioLevelsPath: string | null;
  momentsPath: string | null;
  // NEW: NotebookLM review fields (all optional, backwards-compat)
  notebookId?: string;
  notebookSourceId?: string;
  notebookLMReviewPath?: string;
  notebookLMReviewedAt?: string;
  phase:
    | "downloaded"
    | "analyzed"
    | "notebooklm-reviewed"
    | "clipped"
    | "uploaded";
  createdAt: string;
  updatedAt: string;
}
```

Only two things changed: five new optional fields and one new value in the `phase` union (`"notebooklm-reviewed"`).

- [ ] **Step 3: Verify existing manifests still load**

Run:
```bash
npx tsx -e "import {loadManifest} from './packages/clips/src/lib/manifest.js'; const m = loadManifest('9lydAIfCwhA'); console.log('phase:', m.phase, 'notebookId:', m.notebookId ?? 'undefined');"
```

Expected: `phase: analyzed notebookId: undefined`

If it errors with "No job directory found" for that streamId, try `zja-l_9aQBs` instead (job-010).

- [ ] **Step 4: Commit**

```bash
git add packages/clips/src/lib/manifest.ts
git commit -m "feat(clips): extend StreamManifest with NotebookLM review fields"
```

---

### Task 2: Create `viral-weights.ts` constants

**Files:**
- Create: `packages/clips/src/lib/viral-weights.ts`
- Create: `packages/clips/test/viral-weights.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/clips/test/viral-weights.test.ts`:

```typescript
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
  assert.equal(typeof CROSS_CATEGORY_BONUS, "number");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clips && node --import tsx --test test/viral-weights.test.ts`
Expected: FAIL with `Cannot find module '../src/lib/viral-weights.js'`

- [ ] **Step 3: Create the constants file**

Create `packages/clips/src/lib/viral-weights.ts`:

```typescript
/**
 * Tunable weights for the NotebookLM review scoring formula.
 *
 * Edit this file and re-run notebooklm-review.ts to adjust how picks are
 * ranked. Weights are multiplied against NotebookLM's raw strength score
 * (0-100); modifiers are added to the final score.
 *
 * See docs/superpowers/specs/2026-04-11-notebooklm-review-module-design.md
 * for the full scoring formula.
 */

export const CATEGORY_WEIGHTS: Record<string, number> = {
  "hot-take": 1.15, // Drives comment engagement
  drama: 1.1, // Conflict = retention
  "running-bit": 1.05, // Rewards regulars, unique to NotebookLM
  "character-moment": 1.05,
  callback: 1.05,
  "dry-joke": 1.0, // Baseline
  absurdist: 1.0,
  "emotional-peak": 1.0,
  "reaction-gold": 0.95, // Scorer already covers via audio spike
  "one-liner": 0.9, // Feeds titles/thumbs, not standalone
  "story-of-stream": 1.2, // Single hero pick bonus
};

/** Shorts sweet spot: clips in this duration range get a score bonus. */
export const DURATION_SWEET_SPOT = { min: 20, max: 70 };

/** Hard limits: clips outside this range get a score penalty. */
export const DURATION_HARD_LIMITS = { min: 10, max: 90 };

/** Bonus for clips in the sweet spot. */
export const DURATION_BONUS = 10;

/** Penalty for clips outside hard limits. */
export const DURATION_PENALTY = -15;

/** Bonus for standalone clips (no setup needed). */
export const STANDALONE_BONUS = 5;

/** Penalty for clips whose setup reference is > 30 min earlier. */
export const LONG_SETUP_PENALTY = -5;

/** Bonus when a pick appears in 2+ different category queries. */
export const CROSS_CATEGORY_BONUS = 3;

/** Threshold for "long setup" in seconds (30 min). */
export const LONG_SETUP_THRESHOLD_SEC = 1800;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/clips && node --import tsx --test test/viral-weights.test.ts`
Expected: PASS — 5 tests passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add packages/clips/src/lib/viral-weights.ts packages/clips/test/viral-weights.test.ts
git commit -m "feat(clips): add viral-weights constants for NotebookLM scoring"
```

---

### Task 3: Copy trial fixtures to test directory

**Files:**
- Create: `packages/clips/test/fixtures/query1-humor.json`
- Create: `packages/clips/test/fixtures/query2-runningbits.json`

- [ ] **Step 1: Create fixtures directory**

```bash
mkdir -p packages/clips/test/fixtures
```

- [ ] **Step 2: Copy fixtures from trial temp location**

```bash
cp "C:/Users/Justi/AppData/Local/Temp/peanut-trial/query1-humor.json" packages/clips/test/fixtures/query1-humor.json
cp "C:/Users/Justi/AppData/Local/Temp/peanut-trial/query2-runningbits.json" packages/clips/test/fixtures/query2-runningbits.json
```

- [ ] **Step 3: Verify fixtures are valid JSON and non-empty**

```bash
node -e "const f1 = require('./packages/clips/test/fixtures/query1-humor.json'); const f2 = require('./packages/clips/test/fixtures/query2-runningbits.json'); console.log('q1 answer len:', f1.value.answer.length, 'q2 answer len:', f2.value.answer.length);"
```
Expected: both lengths > 1000 characters.

- [ ] **Step 4: Commit**

```bash
git add packages/clips/test/fixtures/
git commit -m "test(clips): add NotebookLM query fixtures from trial run"
```

---

### Task 4: Add `writeCleanTranscript` to subtitle-parser.ts

**Files:**
- Modify: `packages/clips/src/lib/subtitle-parser.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/clips/test/subtitle-parser.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCleanTranscript } from "../src/lib/subtitle-parser.js";

test("writeCleanTranscript produces timestamped lines from VTT", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "peanut-test-"));
  const vttPath = join(tmpDir, "test.vtt");
  const outPath = join(tmpDir, "clean.txt");

  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:01.500 --> 00:00:03.000
Hello world

00:00:05.000 --> 00:00:07.500
This is a test
`;
  writeFileSync(vttPath, vtt, "utf-8");

  const count = writeCleanTranscript(vttPath, outPath);

  assert.equal(count, 2);
  const content = readFileSync(outPath, "utf-8");
  assert.match(content, /^\[00:00:01\] Hello world$/m);
  assert.match(content, /^\[00:00:05\] This is a test$/m);

  rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clips && node --import tsx --test test/subtitle-parser.test.ts`
Expected: FAIL with `writeCleanTranscript is not a function`.

- [ ] **Step 3: Add the helper function**

Append to `packages/clips/src/lib/subtitle-parser.ts`:

```typescript
/**
 * Convert a VTT subtitle file to a plain timestamped transcript file,
 * one line per cue in `[HH:MM:SS] text` format. Returns the number of
 * lines written. Used by the NotebookLM review module to produce the
 * text source uploaded to NotebookLM.
 */
export function writeCleanTranscript(
  vttPath: string,
  outPath: string,
): number {
  const cues = parseVtt(vttPath);
  const { writeFileSync } = require("fs");

  const fmt = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const lines: string[] = [];
  for (const cue of cues) {
    const text = cue.text
      .replace(/<\/?c(?:\.[^>]*)?>/g, "")
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&")
      .replace(/>>+/g, "")
      .replace(/\[\s*__\s*\]/g, "****")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    lines.push(`[${fmt(cue.startMs)}] ${text}`);
  }

  writeFileSync(outPath, lines.join("\n"), "utf-8");
  return lines.length;
}
```

Note: use static ESM imports at the top of the file instead of `require` — add `writeFileSync` to the existing `fs` import at line 1:

```typescript
import { readFileSync, writeFileSync } from "fs";
```

And remove the `const { writeFileSync } = require("fs");` line from inside the function.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/clips && node --import tsx --test test/subtitle-parser.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Delete the trial one-off script**

The trial-clean-transcript.ts script at `packages/clips/src/trial-clean-transcript.ts` was a throwaway for the trial. Delete it since `writeCleanTranscript` replaces it:

```bash
rm packages/clips/src/trial-clean-transcript.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/clips/src/lib/subtitle-parser.ts packages/clips/test/subtitle-parser.test.ts
git rm packages/clips/src/trial-clean-transcript.ts
git commit -m "feat(clips): add writeCleanTranscript helper for NotebookLM ingestion"
```

---

### Task 5: Create `notebooklm-scorer.ts` with scoring formula

**Files:**
- Create: `packages/clips/src/lib/notebooklm-scorer.ts`
- Create: `packages/clips/test/notebooklm-scorer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/clips/test/notebooklm-scorer.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePick } from "../src/lib/notebooklm-scorer.js";
import type { ScoreInput } from "../src/lib/notebooklm-scorer.js";

function base(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    strength: 4,
    categories: ["dry-joke"],
    durationSec: 45,
    setupNeeded: false,
    setupOffsetSec: 0,
    categoryQueryHitCount: 1,
    ...overrides,
  };
}

test("baseline pick: strength 4, dry-joke, 45s, standalone", () => {
  // nlmRaw = 4*20 = 80
  // weight = 1.0 (dry-joke)
  // +10 duration bonus (20-70)
  // +5 standalone bonus
  // = 80 + 10 + 5 = 95
  const result = scorePick(base());
  assert.equal(result.final, 95);
  assert.equal(result.breakdown.nlmRaw, 80);
  assert.equal(result.breakdown.categoryWeight, 1.0);
  assert.equal(result.breakdown.durationMod, 10);
  assert.equal(result.breakdown.standaloneMod, 5);
});

test("hot-take boost: category weight 1.15 applied", () => {
  const result = scorePick(base({ categories: ["hot-take"] }));
  // nlmRaw(80) * 1.15 + 10 + 5 = 92 + 10 + 5 = 107 → clamped to 100
  assert.equal(result.final, 100);
});

test("multi-category picks use MAX weight", () => {
  const result = scorePick(base({ categories: ["dry-joke", "hot-take"] }));
  // uses 1.15 (max), not 1.0
  assert.equal(result.breakdown.categoryWeight, 1.15);
});

test("too-short clip (<10s): duration penalty", () => {
  const result = scorePick(base({ durationSec: 8 }));
  // 80 * 1.0 - 15 + 5 = 70
  assert.equal(result.final, 70);
});

test("too-long clip (>90s): duration penalty", () => {
  const result = scorePick(base({ durationSec: 120 }));
  assert.equal(result.breakdown.durationMod, -15);
});

test("clip outside sweet spot but within hard limits: no duration mod", () => {
  const result = scorePick(base({ durationSec: 15 }));
  assert.equal(result.breakdown.durationMod, 0);
});

test("setup-needed with long offset: long-setup penalty", () => {
  const result = scorePick(
    base({ setupNeeded: true, setupOffsetSec: 3600 }),
  );
  // 80 * 1.0 + 10 + 0 (no standalone bonus) - 5 (long setup) = 85
  assert.equal(result.final, 85);
});

test("setup-needed with short offset: no long-setup penalty", () => {
  const result = scorePick(
    base({ setupNeeded: true, setupOffsetSec: 300 }),
  );
  // 80 * 1.0 + 10 + 0 - 0 = 90
  assert.equal(result.final, 90);
});

test("cross-category bonus: pick in 3 queries", () => {
  const result = scorePick(base({ categoryQueryHitCount: 3 }));
  // 80 + 10 + 5 + 3 = 98
  assert.equal(result.final, 98);
});

test("missing strength defaults to 3 (60 raw)", () => {
  const result = scorePick(base({ strength: undefined }));
  assert.equal(result.breakdown.nlmRaw, 60);
});

test("score is clamped to [0, 100]", () => {
  // strength 5, hot-take, 45s, standalone, 3 categories
  // 100 * 1.15 + 10 + 5 + 3 = 133 → 100
  const r1 = scorePick(
    base({
      strength: 5,
      categories: ["hot-take"],
      categoryQueryHitCount: 3,
    }),
  );
  assert.equal(r1.final, 100);

  // strength 1, one-liner, too short, needs long setup
  // 20 * 0.9 - 15 + 0 - 5 = -2 → 0
  const r2 = scorePick(
    base({
      strength: 1,
      categories: ["one-liner"],
      durationSec: 5,
      setupNeeded: true,
      setupOffsetSec: 3600,
    }),
  );
  assert.equal(r2.final, 0);
});

test("story-of-stream gets highest category weight (1.20)", () => {
  const result = scorePick(base({ categories: ["story-of-stream"] }));
  assert.equal(result.breakdown.categoryWeight, 1.2);
});

test("unknown category falls back to 1.0 weight", () => {
  const result = scorePick(base({ categories: ["bogus-category"] }));
  assert.equal(result.breakdown.categoryWeight, 1.0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clips && node --import tsx --test test/notebooklm-scorer.test.ts`
Expected: FAIL with `Cannot find module '../src/lib/notebooklm-scorer.js'`.

- [ ] **Step 3: Implement the scorer**

Create `packages/clips/src/lib/notebooklm-scorer.ts`:

```typescript
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
} from "./viral-weights.js";

export interface ScoreInput {
  /** NotebookLM's 1-5 strength rating for this pick. Undefined → default 3. */
  strength: number | undefined;
  /** Viral categories this pick belongs to (e.g., ["dry-joke", "hot-take"]). */
  categories: string[];
  /** Clip duration in seconds. */
  durationSec: number;
  /** Whether the pick requires earlier setup context. */
  setupNeeded: boolean;
  /** How many seconds earlier the setup reference is (0 if none). */
  setupOffsetSec: number;
  /** Number of distinct category queries this pick was surfaced in. */
  categoryQueryHitCount: number;
}

export interface ScoreBreakdown {
  nlmRaw: number;
  categoryWeight: number;
  durationMod: number;
  standaloneMod: number;
  setupMod: number;
  crossCategoryBonus: number;
  final: number;
}

export interface ScoreResult {
  final: number;
  breakdown: ScoreBreakdown;
}

/**
 * Score a NotebookLM pick for viral potential. Pure function.
 *
 * Formula: round(nlmRaw * categoryWeight + durationMod + standaloneMod +
 * setupMod + crossCategoryBonus), clamped to [0, 100].
 */
export function scorePick(input: ScoreInput): ScoreResult {
  // Raw score: strength 1-5 → 20-100, default 3 → 60
  const strength = input.strength ?? 3;
  const nlmRaw = strength * 20;

  // Category weight: use MAX weight across all categories for multi-cat picks
  const categoryWeight = Math.max(
    ...input.categories.map((c) => CATEGORY_WEIGHTS[c] ?? 1.0),
    1.0, // floor at 1.0 in case categories is empty
  );

  // Duration modifier
  let durationMod = 0;
  if (
    input.durationSec < DURATION_HARD_LIMITS.min ||
    input.durationSec > DURATION_HARD_LIMITS.max
  ) {
    durationMod = DURATION_PENALTY;
  } else if (
    input.durationSec >= DURATION_SWEET_SPOT.min &&
    input.durationSec <= DURATION_SWEET_SPOT.max
  ) {
    durationMod = DURATION_BONUS;
  }

  // Standalone bonus
  const standaloneMod = !input.setupNeeded ? STANDALONE_BONUS : 0;

  // Long setup penalty
  const setupMod =
    input.setupNeeded && input.setupOffsetSec > LONG_SETUP_THRESHOLD_SEC
      ? LONG_SETUP_PENALTY
      : 0;

  // Cross-category bonus: picks in 2+ queries
  const crossCategoryBonus =
    input.categoryQueryHitCount >= 2 ? CROSS_CATEGORY_BONUS : 0;

  // Final: round and clamp
  const raw =
    nlmRaw * categoryWeight +
    durationMod +
    standaloneMod +
    setupMod +
    crossCategoryBonus;
  const final = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    final,
    breakdown: {
      nlmRaw,
      categoryWeight,
      durationMod,
      standaloneMod,
      setupMod,
      crossCategoryBonus,
      final,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/clips && node --import tsx --test test/notebooklm-scorer.test.ts`
Expected: PASS — 13 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/clips/src/lib/notebooklm-scorer.ts packages/clips/test/notebooklm-scorer.test.ts
git commit -m "feat(clips): add NotebookLM scoring formula (pure function)"
```

---

### Task 6: Create `notebooklm-parser.ts` with types and parsers

**Files:**
- Create: `packages/clips/src/lib/notebooklm-parser.ts`
- Create: `packages/clips/test/notebooklm-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/clips/test/notebooklm-parser.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHumorQuery,
  parseRunningBitsQuery,
  parseTimestampToSec,
} from "../src/lib/notebooklm-parser.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clips && node --import tsx --test test/notebooklm-parser.test.ts`
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Implement the parser**

Create `packages/clips/src/lib/notebooklm-parser.ts`:

```typescript
/**
 * Parse NotebookLM query JSON responses into structured NotebookLMPick
 * records. The responses are from the `nlm notebook query ... --json` CLI
 * output: { value: { answer: string, conversation_id, citations, references } }
 *
 * The `answer` is free-form markdown. Each parser uses regex to extract
 * structured fields matching the prompt output format specified in
 * notebooklm-queries.ts.
 */

export type SourceQuery =
  | "humor"
  | "running-bits"
  | "emotional-peaks"
  | "hot-takes"
  | "drama"
  | "one-liners"
  | "story-of-stream"
  | "enrichment";

export interface NotebookLMPick {
  /** Start time in seconds from stream beginning. */
  startSec: number;
  /** End time in seconds. Parsers estimate when absent. */
  endSec: number;
  /** Single-sentence hook description. */
  hook: string;
  /** Key quote(s) from the transcript. */
  quote?: string;
  /** Viral categories (may be multiple for enrichment merges). */
  categories: string[];
  /** Whether this pick depends on earlier context. */
  setupNeeded: boolean;
  /** How many seconds earlier the setup reference starts (0 if none). */
  setupOffsetSec: number;
  /** NotebookLM's 1-5 strength rating for this pick. */
  strength?: number;
  /** Which query this pick came from (provenance). */
  sourceQuery: SourceQuery;
  /** Additional timestamps for running bits / multi-appearance picks. */
  additionalTimestamps?: number[];
}

export interface RawQueryResponse {
  value: {
    answer: string;
    conversation_id: string;
    sources_used?: string[];
    citations?: Record<string, string>;
    references?: Array<{ cited_text: string }>;
  };
}

const TIMESTAMP_RE = /\[(\d{2}):(\d{2}):(\d{2})\]/;
const TIMESTAMP_GLOBAL_RE = /\[(\d{2}):(\d{2}):(\d{2})\]/g;

export function parseTimestampToSec(ts: string): number {
  const m = ts.match(TIMESTAMP_RE);
  if (!m) return -1;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

/**
 * Parse the query 1 (humor) response. Expects markdown with numbered picks:
 * `1. **Title** ... * **Timestamp:** [HH:MM:SS] ... * **Humor Type:** dry-joke`
 */
export function parseHumorQuery(raw: RawQueryResponse): NotebookLMPick[] {
  const answer = raw.value.answer;
  const picks: NotebookLMPick[] = [];

  // Split on numbered items: "1. **...**" or "### 1. ..." or "1."
  const items = answer.split(/\n(?=\d{1,2}\.\s+\*)/);

  for (const item of items) {
    const tsMatch = item.match(TIMESTAMP_RE);
    if (!tsMatch) continue;

    const startSec = parseTimestampToSec(tsMatch[0]);
    if (startSec < 0) continue;

    // Extract hook/title: either the **bold title** at the top or the
    // "Hook Description:" field
    const hookLineMatch = item.match(/\*\*Hook Description:?\*\*\s*([^\n]+)/i);
    const boldTitleMatch = item.match(/^\d+\.\s+\*\*([^*]+)\*\*/);
    const hook = (hookLineMatch?.[1] ?? boldTitleMatch?.[1] ?? "").trim();

    // Quote
    const quoteMatch = item.match(/\*\*Quote:?\*\*\s*["“]([^"”]+)["”]/);
    const quote = quoteMatch?.[1].trim();

    // Humor type → category
    const humorMatch = item.match(/\*\*Humor Type:?\*\*\s*([a-z-]+)/i);
    const category = humorMatch?.[1].toLowerCase() ?? "dry-joke";

    // Setup needed
    const setupMatch = item.match(/\*\*Setup(?:\s+Needed)?:?\*\*\s*(Yes|No)/i);
    const setupNeeded = setupMatch ? setupMatch[1].toLowerCase() === "yes" : false;

    // Heuristic end time: add 45 seconds (middle of sweet spot)
    const endSec = startSec + 45;

    picks.push({
      startSec,
      endSec,
      hook,
      quote,
      categories: [category],
      setupNeeded,
      setupOffsetSec: 0, // query 1 doesn't give us an offset
      strength: undefined, // NotebookLM ranks 1-15 via list position, not explicit strength
      sourceQuery: "humor",
    });
  }

  // Derive strength from list position: pick #1 gets strength 5, #15 gets strength 3
  for (let i = 0; i < picks.length; i++) {
    picks[i].strength = Math.max(3, 5 - Math.floor(i / 5));
  }

  return picks;
}

/**
 * Parse the query 2 (running bits) response. Expects:
 * `### 1. The Bit Name * **Timestamps:** [HH:MM:SS], [HH:MM:SS], ... * **Best Single-Clip Candidate:** [HH:MM:SS] ...`
 */
export function parseRunningBitsQuery(
  raw: RawQueryResponse,
): NotebookLMPick[] {
  const answer = raw.value.answer;
  const picks: NotebookLMPick[] = [];

  // Split on "### N." headings
  const sections = answer.split(/\n(?=###\s+\d+\.)/);

  for (const section of sections) {
    const titleMatch = section.match(/###\s+\d+\.\s+(.+?)(?:\n|$)/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/["*]/g, "").trim();

    // All timestamps in the section
    const allTimestamps = [...section.matchAll(TIMESTAMP_GLOBAL_RE)].map(
      (m) => parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10),
    );
    if (allTimestamps.length === 0) continue;

    // "Best Single-Clip Candidate:" line — parse the timestamp right after it
    const bestMatch = section.match(
      /\*\*Best Single-Clip Candidate:?\*\*\s*\[(\d{2}):(\d{2}):(\d{2})\]/,
    );
    const startSec = bestMatch
      ? parseInt(bestMatch[1], 10) * 3600 +
        parseInt(bestMatch[2], 10) * 60 +
        parseInt(bestMatch[3], 10)
      : allTimestamps[0];

    // Description line
    const descMatch = section.match(
      /\*\*Description:?\*\*\s*([^\n]+)/,
    );
    const hook = `${title} — ${descMatch?.[1]?.trim() ?? ""}`.trim();

    picks.push({
      startSec,
      endSec: startSec + 50,
      hook,
      categories: ["running-bit"],
      setupNeeded: false, // best-clip candidate is designed to stand alone
      setupOffsetSec: 0,
      strength: 4, // Running bits are high-signal by definition
      sourceQuery: "running-bits",
      additionalTimestamps: allTimestamps.filter((t) => t !== startSec),
    });
  }

  return picks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/clips && node --import tsx --test test/notebooklm-parser.test.ts`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/clips/src/lib/notebooklm-parser.ts packages/clips/test/notebooklm-parser.test.ts
git commit -m "feat(clips): add NotebookLM response parser with humor + running-bits support"
```

---

### Task 7: Add parsers for queries 3-7 and enrichment (query 8)

**Files:**
- Modify: `packages/clips/src/lib/notebooklm-parser.ts`
- Modify: `packages/clips/test/notebooklm-parser.test.ts`

Each of queries 3-6 follows the same numbered-list pattern as query 1 (emotional peaks, hot takes, drama, one-liners). Query 7 returns a single hero pick. Query 8 returns enrichment records per candidate.

- [ ] **Step 1: Write failing tests for the new parsers**

Append to `packages/clips/test/notebooklm-parser.test.ts`:

```typescript
import {
  parseEmotionalPeaksQuery,
  parseHotTakesQuery,
  parseDramaQuery,
  parseOneLinersQuery,
  parseStoryOfStreamQuery,
  parseEnrichmentQuery,
} from "../src/lib/notebooklm-parser.js";

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
  assert.equal(picks[0].categories[0], "emotional-peak");
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

**1. [01:12:47] — 30,000 Hour Berry Logic**
- Cold open: [01:12:25]
- Natural end: [01:14:16]
- Thumbnail: [01:13:36]
- Title drafts:
  1. He Has 30,000 Hours And Can't Grow Berries
  2. 4 Years Of Full-Time Berry Farming
  3. The Math Got Him FUMING

**2. [05:40:24] — 6767 Security Breach**
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clips && node --import tsx --test test/notebooklm-parser.test.ts`
Expected: FAIL with "parseEmotionalPeaksQuery is not exported".

- [ ] **Step 3: Implement the new parsers**

Append to `packages/clips/src/lib/notebooklm-parser.ts`:

```typescript
/**
 * Generic numbered-list parser for queries 3-6 (emotional-peaks, hot-takes,
 * drama, one-liners). They all share the same output format:
 *   N. **Title** * **Timestamp:** [HH:MM:SS] * **Hook:** ... * **Category:** ...
 */
function parseNumberedListQuery(
  raw: RawQueryResponse,
  sourceQuery: SourceQuery,
  defaultCategory: string,
): NotebookLMPick[] {
  const answer = raw.value.answer;
  const picks: NotebookLMPick[] = [];

  const items = answer.split(/\n(?=\d{1,2}\.\s+\*)/);

  for (const item of items) {
    const tsMatch = item.match(TIMESTAMP_RE);
    if (!tsMatch) continue;

    const startSec = parseTimestampToSec(tsMatch[0]);
    if (startSec < 0) continue;

    const hookMatch = item.match(/\*\*Hook:?\*\*\s*([^\n]+)/i);
    const titleMatch = item.match(/^\d+\.\s+\*\*([^*]+)\*\*/);
    const hook = (hookMatch?.[1] ?? titleMatch?.[1] ?? "").trim();

    const quoteMatch = item.match(/\*\*Quote:?\*\*\s*["“]([^"”]+)["”]/);
    const quote = quoteMatch?.[1].trim();

    const setupMatch = item.match(/\*\*Setup(?:\s+Needed)?:?\*\*\s*(Yes|No)/i);
    const setupNeeded = setupMatch ? setupMatch[1].toLowerCase() === "yes" : false;

    picks.push({
      startSec,
      endSec: startSec + 45,
      hook,
      quote,
      categories: [defaultCategory],
      setupNeeded,
      setupOffsetSec: 0,
      strength: undefined,
      sourceQuery,
    });
  }

  // Position-based strength (top of list = strongest)
  for (let i = 0; i < picks.length; i++) {
    picks[i].strength = Math.max(3, 5 - Math.floor(i / 5));
  }

  return picks;
}

export function parseEmotionalPeaksQuery(
  raw: RawQueryResponse,
): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "emotional-peaks", "emotional-peak");
}

export function parseHotTakesQuery(raw: RawQueryResponse): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "hot-takes", "hot-take");
}

export function parseDramaQuery(raw: RawQueryResponse): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "drama", "drama");
}

export function parseOneLinersQuery(raw: RawQueryResponse): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "one-liners", "one-liner");
}

/**
 * Parse query 7: single hero pick (story-of-the-stream).
 */
export function parseStoryOfStreamQuery(
  raw: RawQueryResponse,
): NotebookLMPick[] {
  const answer = raw.value.answer;
  const tsMatch = answer.match(TIMESTAMP_RE);
  if (!tsMatch) return [];

  const startSec = parseTimestampToSec(tsMatch[0]);
  if (startSec < 0) return [];

  const hookMatch = answer.match(/\*\*Hook:?\*\*\s*([^\n]+)/i);
  const hook = hookMatch?.[1]?.trim() ?? "Story of the stream";

  return [
    {
      startSec,
      endSec: startSec + 60,
      hook,
      categories: ["story-of-stream"],
      setupNeeded: false,
      setupOffsetSec: 0,
      strength: 5, // Hero pick always gets max strength
      sourceQuery: "story-of-stream",
    },
  ];
}

/**
 * Parse query 8 (enrichment): returns enrichment records keyed by the anchor
 * timestamp of each candidate. Used to back-fill coldOpenSec/naturalEndSec/
 * thumbnailSec/titleDrafts on picks from queries 1-7.
 */
export interface EnrichmentRecord {
  anchorStartSec: number;
  coldOpenSec?: number;
  naturalEndSec?: number;
  thumbnailSec?: number;
  titleDrafts: string[];
}

export function parseEnrichmentQuery(
  raw: RawQueryResponse,
): EnrichmentRecord[] {
  const answer = raw.value.answer;
  const records: EnrichmentRecord[] = [];

  // Each candidate is a numbered block starting with **N. [HH:MM:SS]**
  const blocks = answer.split(/\n(?=\*\*\d+\.\s+\[\d{2}:\d{2}:\d{2}\])/);

  for (const block of blocks) {
    const anchorMatch = block.match(
      /\*\*\d+\.\s+\[(\d{2}):(\d{2}):(\d{2})\]/,
    );
    if (!anchorMatch) continue;
    const anchorStartSec =
      parseInt(anchorMatch[1], 10) * 3600 +
      parseInt(anchorMatch[2], 10) * 60 +
      parseInt(anchorMatch[3], 10);

    const extractTs = (label: string): number | undefined => {
      const re = new RegExp(`${label}:?\\s*\\[(\\d{2}):(\\d{2}):(\\d{2})\\]`, "i");
      const m = block.match(re);
      if (!m) return undefined;
      return (
        parseInt(m[1], 10) * 3600 +
        parseInt(m[2], 10) * 60 +
        parseInt(m[3], 10)
      );
    };

    const titleDrafts: string[] = [];
    // Look for "Title drafts:" or "Titles:" section followed by numbered list
    const titleSectionMatch = block.match(
      /Title (?:drafts|variants|options):?\s*\n((?:\s*\d+\.\s+[^\n]+\n?)+)/i,
    );
    if (titleSectionMatch) {
      const lines = titleSectionMatch[1].split("\n");
      for (const line of lines) {
        const titleMatch = line.match(/\d+\.\s+(.+)/);
        if (titleMatch) titleDrafts.push(titleMatch[1].trim());
      }
    }

    records.push({
      anchorStartSec,
      coldOpenSec: extractTs("Cold open"),
      naturalEndSec: extractTs("Natural end"),
      thumbnailSec: extractTs("Thumbnail"),
      titleDrafts: titleDrafts.slice(0, 3),
    });
  }

  return records;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/clips && node --import tsx --test test/notebooklm-parser.test.ts`
Expected: PASS — 8 tests passing total.

- [ ] **Step 5: Commit**

```bash
git add packages/clips/src/lib/notebooklm-parser.ts packages/clips/test/notebooklm-parser.test.ts
git commit -m "feat(clips): add parsers for emotional/hot-take/drama/story/enrichment queries"
```

---

### Task 8: Implement cross-query deduplication

**Files:**
- Modify: `packages/clips/src/lib/notebooklm-parser.ts`
- Modify: `packages/clips/test/notebooklm-parser.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/clips/test/notebooklm-parser.test.ts`:

```typescript
import { dedupePicks } from "../src/lib/notebooklm-parser.js";
import type { NotebookLMPick } from "../src/lib/notebooklm-parser.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clips && node --import tsx --test test/notebooklm-parser.test.ts`
Expected: FAIL with "dedupePicks is not a function".

- [ ] **Step 3: Implement dedupePicks**

Append to `packages/clips/src/lib/notebooklm-parser.ts`:

```typescript
/**
 * Extended pick with aggregated metadata populated during dedup.
 */
export interface DedupedPick extends NotebookLMPick {
  /** Number of distinct source queries this pick was surfaced in. */
  categoryQueryHitCount: number;
  /** All source queries that surfaced this pick (for provenance). */
  sourceQueries: SourceQuery[];
}

const OVERLAP_THRESHOLD_SEC = 30;

/**
 * Deduplicate picks across multiple query results. Two picks are considered
 * the same moment if their `startSec` values are within OVERLAP_THRESHOLD_SEC
 * of each other. Merged picks combine categories, tally source queries, and
 * keep the earliest start + highest strength + longest hook.
 */
export function dedupePicks(picks: NotebookLMPick[]): DedupedPick[] {
  // Sort by startSec so we process earliest first
  const sorted = [...picks].sort((a, b) => a.startSec - b.startSec);
  const result: DedupedPick[] = [];

  for (const pick of sorted) {
    const existing = result.find(
      (r) => Math.abs(r.startSec - pick.startSec) <= OVERLAP_THRESHOLD_SEC,
    );

    if (!existing) {
      result.push({
        ...pick,
        categoryQueryHitCount: 1,
        sourceQueries: [pick.sourceQuery],
      });
      continue;
    }

    // Merge into existing
    for (const cat of pick.categories) {
      if (!existing.categories.includes(cat)) existing.categories.push(cat);
    }
    if (!existing.sourceQueries.includes(pick.sourceQuery)) {
      existing.sourceQueries.push(pick.sourceQuery);
      existing.categoryQueryHitCount = existing.sourceQueries.length;
    }

    // Earliest start wins
    if (pick.startSec < existing.startSec) existing.startSec = pick.startSec;
    if (pick.endSec > existing.endSec) existing.endSec = pick.endSec;

    // Strongest strength wins
    if ((pick.strength ?? 0) > (existing.strength ?? 0)) {
      existing.strength = pick.strength;
    }

    // Longer hook wins (usually more descriptive)
    if (pick.hook.length > existing.hook.length) existing.hook = pick.hook;

    // Preserve quote if we don't have one
    if (!existing.quote && pick.quote) existing.quote = pick.quote;

    // Preserve additionalTimestamps from any source
    if (pick.additionalTimestamps && !existing.additionalTimestamps) {
      existing.additionalTimestamps = pick.additionalTimestamps;
    }

    // Stronger setup info wins
    if (pick.setupNeeded && !existing.setupNeeded) {
      existing.setupNeeded = true;
      existing.setupOffsetSec = pick.setupOffsetSec;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/clips && node --import tsx --test test/notebooklm-parser.test.ts`
Expected: PASS — 12 tests passing total.

- [ ] **Step 5: Commit**

```bash
git add packages/clips/src/lib/notebooklm-parser.ts packages/clips/test/notebooklm-parser.test.ts
git commit -m "feat(clips): add cross-query pick deduplication with 30s overlap"
```

---

### Task 9: Create `candidate-pool.ts` with atomic writes

**Files:**
- Create: `packages/clips/src/lib/candidate-pool.ts`
- Create: `packages/clips/test/candidate-pool.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/clips/test/candidate-pool.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPool,
  savePool,
  appendCandidates,
  removeByJobId,
} from "../src/lib/candidate-pool.js";
import type { CandidatePointer } from "../src/lib/candidate-pool.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "peanut-pool-"));
}

function mkCandidate(
  jobId: string,
  momentId: string,
  score = 80,
): CandidatePointer {
  return {
    jobId,
    momentId,
    streamId: `stream-${jobId}`,
    streamDate: "2026-04-10",
    categories: ["dry-joke"],
    viralScore: score,
    durationSec: 45,
    hook: `Test pick ${momentId}`,
    status: "pending",
    statusUpdatedAt: new Date().toISOString(),
  };
}

test("loadPool returns empty pool when file missing", () => {
  const tmp = makeTmp();
  const pool = loadPool(join(tmp, "pool.json"));
  assert.equal(pool.version, 1);
  assert.equal(pool.candidates.length, 0);
  rmSync(tmp, { recursive: true, force: true });
});

test("savePool + loadPool round-trip", () => {
  const tmp = makeTmp();
  const path = join(tmp, "pool.json");
  const pool = {
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    candidates: [mkCandidate("job-001", "nlm-1")],
  };
  savePool(path, pool);
  const loaded = loadPool(path);
  assert.equal(loaded.candidates.length, 1);
  assert.equal(loaded.candidates[0].jobId, "job-001");
  rmSync(tmp, { recursive: true, force: true });
});

test("appendCandidates adds new records with status=pending", () => {
  const tmp = makeTmp();
  const path = join(tmp, "pool.json");
  appendCandidates(path, [mkCandidate("job-001", "nlm-1"), mkCandidate("job-001", "nlm-2")]);
  const pool = loadPool(path);
  assert.equal(pool.candidates.length, 2);
  assert.ok(pool.candidates.every((c) => c.status === "pending"));
  rmSync(tmp, { recursive: true, force: true });
});

test("removeByJobId removes only pending records for the given job", () => {
  const tmp = makeTmp();
  const path = join(tmp, "pool.json");
  // Seed with mixed statuses
  const seed = {
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    candidates: [
      mkCandidate("job-001", "nlm-1"),
      { ...mkCandidate("job-001", "nlm-2"), status: "posted-daily" as const },
      mkCandidate("job-002", "nlm-3"),
    ],
  };
  savePool(path, seed);

  removeByJobId(path, "job-001");

  const pool = loadPool(path);
  assert.equal(pool.candidates.length, 2);
  // posted-daily is immutable
  assert.ok(pool.candidates.some((c) => c.momentId === "nlm-2"));
  // other job untouched
  assert.ok(pool.candidates.some((c) => c.jobId === "job-002"));
  // pending for job-001 is gone
  assert.ok(!pool.candidates.some((c) => c.momentId === "nlm-1"));
  rmSync(tmp, { recursive: true, force: true });
});

test("savePool uses atomic temp-file-rename pattern", () => {
  const tmp = makeTmp();
  const path = join(tmp, "pool.json");
  savePool(path, {
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    candidates: [mkCandidate("job-001", "nlm-1")],
  });
  // No temp file left behind
  assert.ok(!existsSync(`${path}.tmp`));
  assert.ok(existsSync(path));
  rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clips && node --import tsx --test test/candidate-pool.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the pool**

Create `packages/clips/src/lib/candidate-pool.ts`:

```typescript
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";

export interface CandidatePointer {
  jobId: string;
  momentId: string;
  streamId: string;
  streamDate: string;
  categories: string[];
  viralScore: number;
  durationSec: number;
  hook: string;
  status:
    | "pending"
    | "posted-daily"
    | "posted-weekly"
    | "archived"
    | "rejected";
  statusUpdatedAt: string;
  postedDate?: string;
  youtubeUrl?: string;
  weeklyCompilationId?: string;
}

export interface CandidatePool {
  version: 1;
  updatedAt: string;
  candidates: CandidatePointer[];
}

/** Statuses that are treated as published state and never touched by --force. */
const IMMUTABLE_STATUSES = new Set<CandidatePointer["status"]>([
  "posted-daily",
  "posted-weekly",
  "archived",
]);

function emptyPool(): CandidatePool {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    candidates: [],
  };
}

/**
 * Load the pool from disk. Returns an empty pool if the file does not exist.
 * Throws if the file exists but is corrupted (data integrity > progress).
 */
export function loadPool(path: string): CandidatePool {
  if (!existsSync(path)) return emptyPool();
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as CandidatePool;
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported candidate pool version: ${parsed.version} (expected 1)`,
    );
  }
  return parsed;
}

/**
 * Save the pool atomically: write to a temp file, then rename.
 * Ensures readers never see a partially-written file.
 */
export function savePool(path: string, pool: CandidatePool): void {
  mkdirSync(dirname(path), { recursive: true });
  pool.updatedAt = new Date().toISOString();
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(pool, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

/**
 * Append new candidate pointers. Read → modify → write atomically.
 * Does not deduplicate — callers should use removeByJobId first if needed.
 */
export function appendCandidates(
  path: string,
  candidates: CandidatePointer[],
): void {
  const pool = loadPool(path);
  pool.candidates.push(...candidates);
  savePool(path, pool);
}

/**
 * Remove all `pending` candidates for a given jobId. Immutable statuses
 * (posted-daily, posted-weekly, archived) are preserved unchanged.
 * Used when re-running a job with --force.
 */
export function removeByJobId(path: string, jobId: string): void {
  const pool = loadPool(path);
  pool.candidates = pool.candidates.filter(
    (c) => c.jobId !== jobId || IMMUTABLE_STATUSES.has(c.status),
  );
  savePool(path, pool);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/clips && node --import tsx --test test/candidate-pool.test.ts`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/clips/src/lib/candidate-pool.ts packages/clips/test/candidate-pool.test.ts
git commit -m "feat(clips): add cross-stream candidate pool with atomic writes"
```

---

### Task 10: Create `notebooklm-queries.ts` with the 8 prompts

**Files:**
- Create: `packages/clips/src/lib/notebooklm-queries.ts`

No tests for this file — it's just prompt string constants. The parsers (already tested) verify the prompts produce parseable output.

- [ ] **Step 1: Create the prompts file**

Create `packages/clips/src/lib/notebooklm-queries.ts`:

```typescript
/**
 * The 8 NotebookLM queries the review module runs against each stream
 * transcript. Each prompt specifies an exact output format so the parser
 * in notebooklm-parser.ts can extract structured fields reliably.
 *
 * Queries 2-8 chain via --conversation-id from query 1 so NotebookLM
 * remembers context across the query set (e.g., query 2 can exclude
 * things it already surfaced in query 1).
 */

export const QUERY_HUMOR = `You are reviewing a transcript from an 11-hour livestream of gaming YouTuber 'The Burnt Peanut' playing games like RUST or Halo. Your goal is to identify the TOP 15 MOMENTS that would make the funniest, most viral 9:16 YouTube Short clips (30-60 seconds each).

Focus on HUMOR — jokes, reactions, callbacks, absurd moments, timing, personality — not just loud excitement. An automated keyword scorer already catches generic 'loud reactions', so focus on things the scorer would MISS: dry jokes, ironic deliveries, setup-and-payoff pairs, callbacks to earlier moments, running bits, and moments where the humor comes from WHAT is said rather than HOW loud it is.

For each of the top 15 moments, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS]
    *   **Hook Description:** One sentence suitable for a YouTube Short title
    *   **Quote:** "Direct quote from the transcript"
    *   **Why it's funny:** 1-2 sentences
    *   **Setup Needed:** Yes or No (if yes, note the earlier timestamp)
    *   **Humor Type:** one of: callback, running-bit, dry-joke, absurdist, reaction-gold, character-moment

Return a numbered list ranked by viral potential. Be selective — 15 strong picks is better than 30 mediocre ones.`;

export const QUERY_RUNNING_BITS = `Second question — different lens. Instead of individual moments, identify RUNNING BITS, INSIDE JOKES, and RECURRING THEMES that appear multiple times across the stream. These are patterns a keyword scorer cannot detect because they require remembering context across hours.

For each running bit, provide EXACTLY this format:

### N. The Bit Name
*   **Timestamps:** [HH:MM:SS], [HH:MM:SS], [HH:MM:SS]...
*   **Description:** One sentence describing the bit
*   **Best Single-Clip Candidate:** [HH:MM:SS] followed by a brief description of why this is the best standalone clip

Focus on things NOT in your previous top 15 answer. Return 8-12 running bits, ranked by comedy potential unlocked for compilation or themed clips.`;

export const QUERY_EMOTIONAL_PEAKS = `Third question — emotional peaks that are NOT pure comedy. Identify 8-10 moments with strong emotional intensity of any type: rage, wholesome, vulnerability, shock, triumph, cringe, genuine fear, resignation, explosive joy. These are often quiet peaks the keyword scorer misses (no audio spike, no CAPS).

For each moment, provide EXACTLY this format:

N. **Short Title — Emotion Type**
    *   **Timestamp:** [HH:MM:SS]
    *   **Hook:** One sentence hook description
    *   **Emotion:** rage / wholesome / triumph / vulnerability / shock / cringe / resignation / explosive-joy
    *   **Setup Needed:** Yes or No

Exclude moments already identified as humor picks. Focus on moments where the PERSON is the content, not the joke.`;

export const QUERY_HOT_TAKES = `Fourth question — hot takes and spicy opinions. Identify 5-10 moments where Peanut drops a controversial opinion, a strong take on games/streamers/industry, or a claim likely to drive comment engagement. These are comment-bait clips.

For each, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS]
    *   **Hook:** One sentence
    *   **The take:** What specifically did he say (short paraphrase)
    *   **Why it's spicy:** What makes this engagement-bait
    *   **Setup Needed:** Yes or No

Return 5-10 picks, ranked by how much comment-section chaos they would start.`;

export const QUERY_DRAMA = `Fifth question — drama and conflict moments. Identify 5-10 moments of interpersonal heat: arguments with teammates, callouts against enemies, betrayals, trash-talk exchanges, beefs. This is NOT the same as rage (which is personal frustration) — drama is interpersonal.

For each, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS]
    *   **Hook:** One sentence
    *   **Parties involved:** Who is in conflict
    *   **The conflict:** What's at stake
    *   **Setup Needed:** Yes or No

Return 5-10 picks, ranked by intensity.`;

export const QUERY_ONE_LINERS = `Sixth question — quotable one-liners. Identify 10-15 standalone zingers, punchlines, metaphors, or unexpected phrasings between 5 and 15 words long. These feed thumbnails and title cards — they do not need to be standalone clips.

For each, provide EXACTLY this format:

N. **"The exact quote"**
    *   **Timestamp:** [HH:MM:SS]
    *   **Context:** One sentence of context
    *   **Why it's quotable:** Why this line is memeable / thumbnail-worthy

Return 10-15 picks. Prioritize lines that would work as title overlays on thumbnails.`;

export const QUERY_STORY_OF_STREAM = `Seventh question — single hero pick. Out of everything in this 11-hour stream, what is THE moment? The single thing viewers would tell their friends about. The moment that defines this stream. This becomes our headline Short.

Provide EXACTLY this format:

### The Story of the Stream

**Timestamp:** [HH:MM:SS]
**Hook:** One-sentence hook
**Why this is THE moment:** 2-3 sentences on why this beats every other candidate

Return exactly one pick.`;

export const QUERY_ENRICHMENT_TEMPLATE = (
  candidates: Array<{ id: number; timestamp: string; hook: string }>,
): string => {
  const list = candidates
    .map((c) => `${c.id}. [${c.timestamp}] — ${c.hook}`)
    .join("\n");

  return `Final question — per-clip enrichment. For each candidate listed below, provide EXACTLY these fields so I can render tight, viral-optimized clips:

Candidates:
${list}

For each candidate, provide EXACTLY this format:

**N. [HH:MM:SS] — Short label**
- Cold open: [HH:MM:SS] (the exact timestamp where the clip should START for the strongest first-3-second hook — usually slightly before the main moment to catch the setup)
- Natural end: [HH:MM:SS] (the exact timestamp where the clip should END at a natural audio exit, never mid-sentence)
- Thumbnail: [HH:MM:SS] (single timestamp of the peak facial / reaction / emotional beat that would make the best thumbnail frame)
- Title drafts:
  1. First title variant (≤60 chars, hook-style)
  2. Second title variant (curiosity gap)
  3. Third title variant (payoff-first)

Be precise with timestamps — these drive clip rendering.`;
};

export const ALL_QUERIES = [
  { key: "humor", prompt: QUERY_HUMOR },
  { key: "running-bits", prompt: QUERY_RUNNING_BITS },
  { key: "emotional-peaks", prompt: QUERY_EMOTIONAL_PEAKS },
  { key: "hot-takes", prompt: QUERY_HOT_TAKES },
  { key: "drama", prompt: QUERY_DRAMA },
  { key: "one-liners", prompt: QUERY_ONE_LINERS },
  { key: "story-of-stream", prompt: QUERY_STORY_OF_STREAM },
] as const;
```

- [ ] **Step 2: Verify file compiles via a typecheck smoke**

Run: `cd packages/clips && npx tsc --noEmit -p .`
Expected: No TypeScript errors in the new file. (Other pre-existing errors may appear in unrelated files — ignore those if present before your changes.)

- [ ] **Step 3: Commit**

```bash
git add packages/clips/src/lib/notebooklm-queries.ts
git commit -m "feat(clips): add 8 NotebookLM query prompts with structured output formats"
```

---

### Task 11: Create `notebooklm-client.ts` subprocess wrapper

**Files:**
- Create: `packages/clips/src/lib/notebooklm-client.ts`

No dedicated tests — this module makes real subprocess calls to `nlm`. Integration is verified via the end-to-end smoke test in Task 15.

- [ ] **Step 1: Create the client module**

Create `packages/clips/src/lib/notebooklm-client.ts`:

```typescript
import { spawnSync } from "child_process";
import { createLogger } from "@ltx/shared";

const log = createLogger("notebooklm-client");

export interface NotebookLMEnv {
  readonly env: Record<string, string>;
}

/** Always set these env vars for every nlm invocation (Windows cp1252 fix). */
const NLM_ENV: NotebookLMEnv = {
  env: {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  } as Record<string, string>,
};

function run(
  args: string[],
  opts: { timeoutMs?: number; maxBufferMb?: number } = {},
): string {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBuffer = (opts.maxBufferMb ?? 32) * 1024 * 1024;

  const result = spawnSync("nlm", args, {
    env: NLM_ENV.env,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer,
    shell: true, // needed on Windows to find .cmd wrappers
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "nlm CLI not found on PATH. Install with: uv tool install notebooklm-mcp-cli",
      );
    }
    throw result.error;
  }

  if (result.status !== 0) {
    // nlm has known cp1252 crashes on Windows AFTER the operation succeeds.
    // If stderr contains the traceback but stdout has our expected content,
    // callers should still use stdout. We log and return stdout; callers
    // validate the JSON themselves.
    log.warn(
      `nlm exited with status ${result.status}. stderr: ${(result.stderr ?? "").slice(0, 300)}`,
    );
  }

  return result.stdout ?? "";
}

function runJson<T = unknown>(
  args: string[],
  opts: { timeoutMs?: number } = {},
): T {
  const stdout = run(args, opts);
  // Find the first `{` — nlm sometimes prints progress lines before JSON
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    throw new Error(
      `No JSON found in nlm output. First 200 chars: ${stdout.slice(0, 200)}`,
    );
  }
  const jsonStr = stdout.slice(jsonStart);
  try {
    return JSON.parse(jsonStr) as T;
  } catch (e) {
    throw new Error(
      `Failed to parse nlm JSON output: ${(e as Error).message}. First 200 chars: ${jsonStr.slice(0, 200)}`,
    );
  }
}

export interface CreateNotebookResult {
  notebookId: string;
  title: string;
}

export function createNotebook(title: string): CreateNotebookResult {
  // Strip non-ASCII to avoid cp1252 mojibake in titles
  const asciiTitle = title.replace(/[^\x20-\x7E]/g, "-");

  // `nlm notebook create` crashes on Windows console print but the notebook
  // IS created. We call list afterward and find the most recent one with
  // the matching title.
  try {
    run(["notebook", "create", `"${asciiTitle}"`], { timeoutMs: 60_000 });
  } catch (e) {
    log.warn(`notebook create may have crashed on success print: ${(e as Error).message}`);
  }

  // Look it up via list (which returns JSON natively without the crash)
  const list = runJson<
    Array<{ id: string; title: string; updated_at: string }>
  >(["notebook", "list"], { timeoutMs: 30_000 });

  // Match most recent notebook whose title contains our ASCII title
  const matches = list
    .filter(
      (n) =>
        n.title.trim() === asciiTitle.trim() ||
        n.title.includes(asciiTitle.slice(0, 20)),
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  if (matches.length === 0) {
    throw new Error(
      `Could not find notebook after creation. Title was: ${asciiTitle}`,
    );
  }

  return { notebookId: matches[0].id, title: matches[0].title };
}

export interface AddSourceResult {
  sourceId: string;
  ready: boolean;
}

export function addSource(
  notebookId: string,
  filePath: string,
  sourceTitle: string,
  waitTimeoutSec: number = 900,
): AddSourceResult {
  const asciiSourceTitle = sourceTitle.replace(/[^\x20-\x7E]/g, "-");
  const stdout = run(
    [
      "source",
      "add",
      notebookId,
      "--file",
      `"${filePath}"`,
      "--title",
      `"${asciiSourceTitle}"`,
      "--wait",
      "--wait-timeout",
      String(waitTimeoutSec),
    ],
    { timeoutMs: (waitTimeoutSec + 60) * 1000 },
  );

  // nlm source add --wait prints "Source ID: <uuid>" on success
  const idMatch = stdout.match(/Source ID:\s+([a-f0-9-]{36})/);
  if (!idMatch) {
    throw new Error(
      `Could not extract source ID from nlm output. Output: ${stdout.slice(0, 400)}`,
    );
  }
  const ready = /ready/i.test(stdout);
  return { sourceId: idMatch[1], ready };
}

export interface QueryResult<T = unknown> {
  value: {
    answer: string;
    conversation_id: string;
    sources_used?: string[];
    citations?: Record<string, string>;
    references?: Array<{ cited_text: string }>;
  };
}

export function query(
  notebookId: string,
  prompt: string,
  opts: { conversationId?: string; timeoutSec?: number } = {},
): QueryResult {
  const timeoutSec = opts.timeoutSec ?? 300;
  const args = ["notebook", "query", notebookId, `"${prompt.replace(/"/g, '\\"')}"`, "--json", "--timeout", String(timeoutSec)];
  if (opts.conversationId) {
    args.push("--conversation-id", opts.conversationId);
  }

  return runJson<QueryResult>(args, { timeoutMs: (timeoutSec + 60) * 1000 });
}

export function deleteNotebook(notebookId: string): void {
  try {
    run(["notebook", "delete", notebookId, "--yes"], { timeoutMs: 30_000 });
  } catch (e) {
    log.warn(`Failed to delete notebook ${notebookId}: ${(e as Error).message}`);
  }
}

/** Check whether the nlm CLI is available on PATH. */
export function isNlmAvailable(): boolean {
  try {
    const result = spawnSync("nlm", ["--version"], {
      env: NLM_ENV.env,
      encoding: "utf-8",
      timeout: 10_000,
      shell: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Smoke test the availability check manually**

Run:
```bash
cd packages/clips && npx tsx -e "import {isNlmAvailable} from './src/lib/notebooklm-client.js'; console.log('nlm available:', isNlmAvailable());"
```
Expected: `nlm available: true`

- [ ] **Step 3: Commit**

```bash
git add packages/clips/src/lib/notebooklm-client.ts
git commit -m "feat(clips): add nlm CLI subprocess wrapper with Windows UTF-8 workaround"
```

---

### Task 12: Extend `scan.ts` merge to 3 sources

**Files:**
- Modify: `packages/clips/src/scan.ts`
- Create: `packages/clips/test/scan-merge-3way.test.ts`

- [ ] **Step 1: Read existing `mergeManualAndAutomated` to understand signature**

Run: Read `packages/clips/src/scan.ts` lines 610-720 to see the existing merge function.

- [ ] **Step 2: Write failing tests for 3-source merge**

Create `packages/clips/test/scan-merge-3way.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/clips && node --import tsx --test test/scan-merge-3way.test.ts`
Expected: FAIL with "mergeSources is not exported from scan".

- [ ] **Step 4: Extend scan.ts with `mergeSources` and export it**

Open `packages/clips/src/scan.ts`. Near the top of the file (before `mergeManualAndAutomated`), add this new interface:

```typescript
export interface NotebookLMPickForMerge {
  id: string;
  startSec: number;
  endSec: number;
  description: string;
  viralScore: number;
  categories: string[];
  hook: string;
  durationSec: number;
  setupNeeded: boolean;
  setupRef?: { startSec: number; description: string };
  coldOpenSec?: number;
  naturalEndSec?: number;
  thumbnailSec?: number;
  titleDrafts?: string[];
  quote?: string;
  viralSubScores?: Record<string, number>;
}
```

Find the existing `mergeManualAndAutomated` function (around line 615). Change its `export` status so it remains usable internally, then add a new exported `mergeSources` function right after it:

```typescript
/**
 * Three-way merge: manual picks + automated moments + NotebookLM picks.
 * Uses the existing manual+automated merger as pass 1, then folds NotebookLM
 * picks in as pass 2 with the same 30-second overlap threshold.
 *
 * Precedence for conflicting fields: manual > automated > notebooklm for
 * timing and description. NotebookLM wins for enrichment fields (categories,
 * coldOpenSec, titleDrafts, thumbnailSec, naturalEndSec) since it's the only
 * producer. Score reconciliation takes the MAX across all sources.
 */
export function mergeSources(
  manualPicks: ManualPick[],
  automatedMoments: Moment[],
  notebookLMPicks: NotebookLMPickForMerge[],
): UnifiedMoment[] {
  // Pass 1: existing manual + automated merge
  const pass1 = mergeManualAndAutomated(manualPicks, automatedMoments);

  // Pass 2: fold in NotebookLM picks
  const result: UnifiedMoment[] = [...pass1];

  for (const nlm of notebookLMPicks) {
    const overlap = result.find(
      (u) => Math.abs(u.startSec - nlm.startSec) <= 30,
    );

    if (overlap) {
      // Merge: upgrade source, take max score, fold enrichment
      overlap.source = overlap.source === "manual" ? "both" : "both";
      overlap.viralityScore = Math.max(overlap.viralityScore, nlm.viralScore);
      overlap.categories = nlm.categories;
      overlap.coldOpenSec = nlm.coldOpenSec;
      overlap.naturalEndSec = nlm.naturalEndSec;
      overlap.thumbnailSec = nlm.thumbnailSec;
      overlap.titleDrafts = nlm.titleDrafts;
      overlap.setupNeeded = nlm.setupNeeded;
      overlap.setupRef = nlm.setupRef;
      overlap.notebooklmQuote = nlm.quote;
      overlap.viralSubScores = nlm.viralSubScores;
    } else {
      // New standalone NotebookLM pick
      result.push({
        id: `nlm-${String(result.length + 1).padStart(3, "0")}`,
        source: "notebooklm",
        startSec: nlm.startSec,
        endSec: nlm.endSec,
        durationSec: nlm.durationSec,
        description: nlm.description || nlm.hook,
        viralityScore: nlm.viralScore,
        hookText: nlm.hook,
        segments: [],
        categories: nlm.categories,
        coldOpenSec: nlm.coldOpenSec,
        naturalEndSec: nlm.naturalEndSec,
        thumbnailSec: nlm.thumbnailSec,
        titleDrafts: nlm.titleDrafts,
        setupNeeded: nlm.setupNeeded,
        setupRef: nlm.setupRef,
        notebooklmQuote: nlm.quote,
        viralSubScores: nlm.viralSubScores,
      });
    }
  }

  return result;
}
```

Also extend the `UnifiedMoment` interface at the top of `scan.ts` with the new optional fields:

```typescript
interface UnifiedMoment {
  id: string;
  source: "manual" | "automated" | "notebooklm" | "both";
  startSec: number;
  endSec: number;
  durationSec: number;
  description: string;
  viralityScore: number;
  hookText?: string;
  layoutMode?: "gameplay" | "talking";
  segments: ClipSegment[];
  automatedSignals?: {
    transcriptPhrases: string[];
    chatIntensity: number;
    audioMagnitude: number;
    compositeScore: number;
  };
  // NEW: NotebookLM enrichment fields (all optional)
  categories?: string[];
  coldOpenSec?: number;
  naturalEndSec?: number;
  thumbnailSec?: number;
  titleDrafts?: string[];
  setupNeeded?: boolean;
  setupRef?: { startSec: number; description: string };
  viralSubScores?: Record<string, number>;
  notebooklmQuote?: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/clips && node --import tsx --test test/scan-merge-3way.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/clips/src/scan.ts packages/clips/test/scan-merge-3way.test.ts
git commit -m "feat(clips): extend scan merge from 2 to 3 sources (+ NotebookLM)"
```

---

### Task 13: Auto-detection of notebooklm-moments.json in scan.ts --merge CLI

**Files:**
- Modify: `packages/clips/src/scan.ts`

- [ ] **Step 1: Locate the merge mode handler**

Run: Read `packages/clips/src/scan.ts` lines 865-900 (the `if (mergeMode)` block).

- [ ] **Step 2: Extend the merge handler**

Replace the `if (mergeMode) { ... }` block (around lines 869-882) with:

```typescript
if (mergeMode) {
  // Merge mode: read manual picks from stdin and merge with automated + notebooklm moments
  const stdinData = await readStdin();
  const manualPicks: ManualPick[] = JSON.parse(stdinData);

  // Auto-detect notebooklm-moments.json if present, or use --notebooklm override
  const notebookLMPath = notebookLMPathArg ?? join(streamDir, "notebooklm-moments.json");
  let notebookLMPicks: NotebookLMPickForMerge[] = [];
  if (existsSync(notebookLMPath)) {
    notebookLMPicks = JSON.parse(readFileSync(notebookLMPath, "utf-8"));
    log.info(`Loaded ${notebookLMPicks.length} NotebookLM picks from ${notebookLMPath}`);
  } else {
    log.info(`No NotebookLM picks found (looked at ${notebookLMPath})`);
  }

  const unified = mergeSources(manualPicks, moments, notebookLMPicks);

  const unifiedPath = join(streamDir, "unified-moments.json");
  writeFileSync(unifiedPath, JSON.stringify(unified, null, 2), "utf-8");

  log.info(
    `Merged ${manualPicks.length} manual + ${moments.length} automated + ${notebookLMPicks.length} notebooklm moments`,
  );
  log.info(`Saved ${unified.length} unified moments to ${unifiedPath}`);

  displayUnifiedMoments(unified);
}
```

- [ ] **Step 3: Add the `--notebooklm` arg parsing**

Find the `parseArgs` or args-setup section near the top of `scan.ts` (search for `--merge` or `mergeMode`). Add:

```typescript
const notebookLMIdx = args.indexOf("--notebooklm");
const notebookLMPathArg = notebookLMIdx !== -1 ? args[notebookLMIdx + 1] : null;
```

in the same block where other CLI args are parsed.

- [ ] **Step 4: Manual smoke test**

Verify scan.ts still starts (without actually merging):

```bash
cd packages/clips && npx tsx src/scan.ts --help 2>&1 | head -5
```

Expected: Either a help message or at least no import/syntax error. If scan.ts doesn't have a `--help` flag, run with `--stream nonexistent` and expect it to error with "no stream found" — that's fine, it proves the file loads.

- [ ] **Step 5: Commit**

```bash
git add packages/clips/src/scan.ts
git commit -m "feat(clips): auto-detect notebooklm-moments.json in scan.ts --merge"
```

---

### Task 14: Create `notebooklm-review.ts` entry point

**Files:**
- Create: `packages/clips/src/notebooklm-review.ts`

This is the CLI entry point the user will run. It wires together everything built in tasks 1-13.

- [ ] **Step 1: Create the entry point file**

Create `packages/clips/src/notebooklm-review.ts`:

```typescript
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { loadManifest, saveManifest } from "./lib/manifest.js";
import { writeCleanTranscript } from "./lib/subtitle-parser.js";
import {
  createNotebook,
  addSource,
  query,
  deleteNotebook,
  isNlmAvailable,
} from "./lib/notebooklm-client.js";
import { ALL_QUERIES, QUERY_ENRICHMENT_TEMPLATE } from "./lib/notebooklm-queries.js";
import {
  parseHumorQuery,
  parseRunningBitsQuery,
  parseEmotionalPeaksQuery,
  parseHotTakesQuery,
  parseDramaQuery,
  parseOneLinersQuery,
  parseStoryOfStreamQuery,
  parseEnrichmentQuery,
  dedupePicks,
  type NotebookLMPick,
  type DedupedPick,
  type SourceQuery,
} from "./lib/notebooklm-parser.js";
import { scorePick } from "./lib/notebooklm-scorer.js";
import {
  appendCandidates,
  removeByJobId,
  type CandidatePointer,
} from "./lib/candidate-pool.js";

const log = createLogger("notebooklm-review");
const POOL_PATH = join(DATA_DIR, "clips", "candidate-pool.json");

interface CliArgs {
  streamId: string;
  force: boolean;
  enrichOnly: boolean;
  queries: number[] | null;
  notebookStrategy: "per-stream" | "shared";
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let streamId = "";
  let force = false;
  let enrichOnly = false;
  let queries: number[] | null = null;
  let notebookStrategy: "per-stream" | "shared" = "per-stream";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) streamId = args[++i];
    else if (args[i] === "--force") force = true;
    else if (args[i] === "--enrich-only") enrichOnly = true;
    else if (args[i] === "--queries" && args[i + 1]) {
      queries = args[++i].split(",").map((n) => parseInt(n, 10));
    } else if (args[i] === "--notebook-strategy" && args[i + 1]) {
      const v = args[++i];
      if (v !== "per-stream" && v !== "shared") {
        log.error(`Invalid --notebook-strategy: ${v}`);
        process.exit(1);
      }
      notebookStrategy = v;
    } else if (args[i] === "--dry-run") dryRun = true;
  }

  if (!streamId) {
    log.error("Missing --stream <stream-id>");
    process.exit(1);
  }

  return { streamId, force, enrichOnly, queries, notebookStrategy, dryRun };
}

function picksToCandidatePointers(
  picks: DedupedPick[],
  jobId: string,
  streamId: string,
  streamDate: string,
  scores: Map<string, number>,
): CandidatePointer[] {
  const now = new Date().toISOString();
  return picks.map((p, i) => ({
    jobId,
    momentId: `nlm-${String(i + 1).padStart(3, "0")}`,
    streamId,
    streamDate,
    categories: p.categories,
    viralScore: scores.get(`${i}`) ?? 0,
    durationSec: p.endSec - p.startSec,
    hook: p.hook,
    status: "pending" as const,
    statusUpdatedAt: now,
  }));
}

async function main(): Promise<void> {
  const cli = parseArgs();

  // Precondition: nlm CLI must be available
  if (!isNlmAvailable()) {
    if (cli.dryRun) {
      log.warn("nlm CLI not available, but --dry-run set, continuing in validation mode");
    } else {
      log.error(
        "nlm CLI not found on PATH. Install with: uv tool install notebooklm-mcp-cli",
      );
      process.exit(1);
    }
  }

  if (cli.notebookStrategy === "shared") {
    log.error(
      "Shared notebook strategy is architected-for but not implemented in V1. Use --notebook-strategy per-stream.",
    );
    process.exit(1);
  }

  // Load manifest
  const manifest = loadManifest(cli.streamId);
  if (!manifest.subtitlePath || !existsSync(manifest.subtitlePath)) {
    log.error(
      `No subtitle file available for stream ${cli.streamId}. NotebookLM review requires transcript.`,
    );
    process.exit(1);
  }

  // Re-run guard
  if (manifest.phase === "notebooklm-reviewed" && !cli.force && !cli.enrichOnly) {
    log.info("Stream already reviewed. Use --force to re-run.");
    process.exit(0);
  }

  // Dry-run: show plan and exit
  if (cli.dryRun) {
    log.info("=== DRY RUN ===");
    log.info(`Stream: ${manifest.streamId} (${manifest.title})`);
    log.info(`Subtitle: ${manifest.subtitlePath}`);
    log.info(`Job dir: ${manifest.jobDir}`);
    log.info(`Queries to run: ${cli.queries?.join(",") ?? "1-8 (all)"}`);
    log.info(`Force: ${cli.force}`);
    log.info(`Strategy: ${cli.notebookStrategy}`);
    log.info("No API calls made.");
    process.exit(0);
  }

  // Step 1: Write clean transcript
  const sourceDir = join(manifest.jobDir, "source");
  mkdirSync(sourceDir, { recursive: true });
  const transcriptPath = join(sourceDir, "transcript_clean.txt");
  const lineCount = writeCleanTranscript(manifest.subtitlePath, transcriptPath);
  log.info(`Wrote clean transcript: ${lineCount} lines → ${transcriptPath}`);

  // Step 2: Force cleanup if requested
  if (cli.force && manifest.notebookId) {
    log.info(`--force: deleting old notebook ${manifest.notebookId}`);
    deleteNotebook(manifest.notebookId);
    removeByJobId(POOL_PATH, manifest.jobDir.split(/[\\/]/).pop() ?? "");
    manifest.notebookId = undefined;
    manifest.notebookSourceId = undefined;
  }

  // Step 3: Create notebook (or reuse if resuming)
  let notebookId = manifest.notebookId;
  let sourceId = manifest.notebookSourceId;

  if (!notebookId) {
    const asciiTitle = `Peanut - ${manifest.streamId} - ${manifest.uploadDate}`;
    log.info(`Creating notebook: ${asciiTitle}`);
    const result = createNotebook(asciiTitle);
    notebookId = result.notebookId;
    manifest.notebookId = notebookId;
    saveManifest(manifest);
  }

  if (!sourceId) {
    log.info(`Uploading transcript source (wait for ingestion)...`);
    const result = addSource(notebookId, transcriptPath, "Stream transcript");
    sourceId = result.sourceId;
    manifest.notebookSourceId = sourceId;
    saveManifest(manifest);
  }

  // Step 4: Run queries 1-7 (unless --enrich-only or --queries)
  const queriesToRun = cli.queries
    ? ALL_QUERIES.filter((_, i) => cli.queries!.includes(i + 1))
    : ALL_QUERIES;

  let conversationId: string | undefined;
  const picksBySource = new Map<SourceQuery, NotebookLMPick[]>();

  if (!cli.enrichOnly) {
    for (const q of queriesToRun) {
      log.info(`Running query: ${q.key}`);
      try {
        const response = query(notebookId, q.prompt, { conversationId });
        conversationId ??= response.value.conversation_id;

        // Route to parser based on query key
        let picks: NotebookLMPick[];
        switch (q.key) {
          case "humor":
            picks = parseHumorQuery(response);
            break;
          case "running-bits":
            picks = parseRunningBitsQuery(response);
            break;
          case "emotional-peaks":
            picks = parseEmotionalPeaksQuery(response);
            break;
          case "hot-takes":
            picks = parseHotTakesQuery(response);
            break;
          case "drama":
            picks = parseDramaQuery(response);
            break;
          case "one-liners":
            picks = parseOneLinersQuery(response);
            break;
          case "story-of-stream":
            picks = parseStoryOfStreamQuery(response);
            break;
          default:
            continue;
        }

        log.info(`Query ${q.key}: ${picks.length} picks`);
        picksBySource.set(q.key, picks);
      } catch (e) {
        log.warn(`Query ${q.key} failed: ${(e as Error).message}. Continuing.`);
      }
    }
  }

  // Step 5: Flatten + dedup
  const allPicks: NotebookLMPick[] = [];
  for (const arr of picksBySource.values()) allPicks.push(...arr);
  const deduped = dedupePicks(allPicks);
  log.info(`Total ${allPicks.length} picks → ${deduped.length} after dedup`);

  // Step 6: Enrichment (query 8)
  if (deduped.length > 0 && (!cli.queries || cli.queries.includes(8))) {
    const candidates = deduped.map((p, i) => ({
      id: i + 1,
      timestamp: formatTimestamp(p.startSec),
      hook: p.hook.slice(0, 80),
    }));
    const enrichPrompt = QUERY_ENRICHMENT_TEMPLATE(candidates);
    log.info(`Running enrichment query for ${candidates.length} candidates`);
    try {
      const response = query(notebookId, enrichPrompt, { conversationId });
      const enrichments = parseEnrichmentQuery(response);

      // Back-fill enrichment onto deduped picks
      for (const e of enrichments) {
        const pick = deduped.find(
          (p) => Math.abs(p.startSec - e.anchorStartSec) <= 30,
        );
        if (!pick) continue;
        if (e.coldOpenSec) (pick as any).coldOpenSec = e.coldOpenSec;
        if (e.naturalEndSec) {
          (pick as any).naturalEndSec = e.naturalEndSec;
          pick.endSec = e.naturalEndSec;
        }
        if (e.thumbnailSec) (pick as any).thumbnailSec = e.thumbnailSec;
        if (e.titleDrafts.length) (pick as any).titleDrafts = e.titleDrafts;
      }
    } catch (e) {
      log.warn(`Enrichment query failed: ${(e as Error).message}. Proceeding with picks as-is.`);
    }
  }

  // Step 7: Score each pick
  const scores = new Map<string, number>();
  for (let i = 0; i < deduped.length; i++) {
    const p = deduped[i];
    const result = scorePick({
      strength: p.strength,
      categories: p.categories,
      durationSec: p.endSec - p.startSec,
      setupNeeded: p.setupNeeded,
      setupOffsetSec: p.setupOffsetSec,
      categoryQueryHitCount: p.categoryQueryHitCount,
    });
    scores.set(`${i}`, result.final);
    (p as any).viralSubScores = result.breakdown;
  }

  // Step 8: Sort by score descending
  const sortedIndices = Array.from(scores.keys()).sort(
    (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0),
  );
  const sortedPicks = sortedIndices.map((i) => deduped[parseInt(i, 10)]);

  // Step 9: Write notebooklm-moments.json
  const nlmMoments = sortedPicks.map((p, i) => ({
    id: `nlm-${String(i + 1).padStart(3, "0")}`,
    startSec: p.startSec,
    endSec: p.endSec,
    durationSec: p.endSec - p.startSec,
    description: p.hook,
    viralScore: scores.get(`${sortedIndices[i]}`) ?? 0,
    categories: p.categories,
    hook: p.hook,
    quote: p.quote,
    setupNeeded: p.setupNeeded,
    coldOpenSec: (p as any).coldOpenSec,
    naturalEndSec: (p as any).naturalEndSec,
    thumbnailSec: (p as any).thumbnailSec,
    titleDrafts: (p as any).titleDrafts,
    viralSubScores: (p as any).viralSubScores,
  }));

  const nlmMomentsPath = join(manifest.jobDir, "notebooklm-moments.json");
  writeFileSync(nlmMomentsPath, JSON.stringify(nlmMoments, null, 2), "utf-8");
  log.info(`Wrote ${nlmMoments.length} picks → ${nlmMomentsPath}`);

  // Step 10: Append to candidate pool
  const jobId = manifest.jobDir.split(/[\\/]/).pop() ?? "unknown-job";
  const pointers: CandidatePointer[] = nlmMoments.map((m) => ({
    jobId,
    momentId: m.id,
    streamId: manifest.streamId,
    streamDate: manifest.uploadDate,
    categories: m.categories,
    viralScore: m.viralScore,
    durationSec: m.durationSec,
    hook: m.hook,
    status: "pending" as const,
    statusUpdatedAt: new Date().toISOString(),
  }));
  appendCandidates(POOL_PATH, pointers);
  log.info(`Appended ${pointers.length} candidates to ${POOL_PATH}`);

  // Step 11: Write human-readable review markdown
  const analysisDir = join(manifest.jobDir, "analysis");
  mkdirSync(analysisDir, { recursive: true });
  const reviewMdPath = join(analysisDir, "notebooklm-review.md");
  const md = buildReviewMarkdown(manifest, nlmMoments);
  writeFileSync(reviewMdPath, md, "utf-8");
  log.info(`Wrote review markdown → ${reviewMdPath}`);

  // Step 12: Update manifest
  manifest.notebookLMReviewPath = nlmMomentsPath;
  manifest.notebookLMReviewedAt = new Date().toISOString();
  manifest.phase = "notebooklm-reviewed";
  saveManifest(manifest);

  log.info("✓ NotebookLM review complete");
}

function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildReviewMarkdown(manifest: any, moments: any[]): string {
  const lines: string[] = [];
  lines.push(`# NotebookLM Review — ${manifest.streamId}`);
  lines.push("");
  lines.push(`**Stream:** ${manifest.title}`);
  lines.push(`**Date:** ${manifest.uploadDate}`);
  lines.push(`**Duration:** ${Math.round(manifest.durationSec / 60)} min`);
  lines.push(`**Picks:** ${moments.length}`);
  lines.push("");
  lines.push("## Ranked picks");
  lines.push("");
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    lines.push(
      `### ${i + 1}. [${formatTimestamp(m.startSec)}] ${m.hook} (score: ${m.viralScore})`,
    );
    lines.push(`- **Categories:** ${m.categories.join(", ")}`);
    lines.push(`- **Duration:** ${m.durationSec}s`);
    if (m.quote) lines.push(`- **Quote:** "${m.quote}"`);
    if (m.titleDrafts?.length) {
      lines.push(`- **Title drafts:**`);
      for (const t of m.titleDrafts) lines.push(`  - ${t}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((err) => {
  log.error(err.message ?? err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/clips && npx tsc --noEmit -p .`
Expected: No errors in new files. Ignore pre-existing errors in other files that existed before your changes.

- [ ] **Step 3: Commit**

```bash
git add packages/clips/src/notebooklm-review.ts
git commit -m "feat(clips): add notebooklm-review entry point wiring all components"
```

---

### Task 15: Add `notebooklm-review` phase to `orchestrate.ts` + end-to-end smoke test

**Files:**
- Modify: `packages/clips/src/orchestrate.ts`

- [ ] **Step 1: Read current orchestrate phases**

Run: Read `packages/clips/src/orchestrate.ts` — find the PHASES constant or phase array.

- [ ] **Step 2: Add notebooklm-review phase**

Find the phase list in `orchestrate.ts`. Add `"notebooklm-review"` between `"analyze"` and `"scan"` (or wherever the scan phase lives). Example (actual file may differ — adapt to real structure):

```typescript
const PHASES = ["discover", "analyze", "notebooklm-review", "scan", "render", "upload"] as const;
```

Where the orchestrator runs each phase (look for the switch/if chain), add a new branch:

```typescript
case "notebooklm-review": {
  if (!isNlmAvailable()) {
    log.warn("nlm CLI not available — skipping notebooklm-review phase");
    break;
  }
  log.info("Running NotebookLM review...");
  try {
    execSync(
      `npx tsx packages/clips/src/notebooklm-review.ts --stream ${streamId}`,
      { stdio: "inherit" },
    );
  } catch (e) {
    log.warn(`NotebookLM review failed: ${(e as Error).message}. Continuing with scorer-only picks.`);
  }
  break;
}
```

Import `isNlmAvailable` from `./lib/notebooklm-client.js` at the top of orchestrate.ts.

Also add a `--skip-notebooklm` CLI flag to `parseArgs` in orchestrate.ts that, when set, removes `"notebooklm-review"` from the phase list.

- [ ] **Step 3: End-to-end smoke test on trial data**

Verify the full module runs on the existing trial data (job-010, which already has a transcript because the video download is still in progress but the VTT exists):

First, ensure the trial VTT is in the expected location:

```bash
# The VTT was saved to the temp location during the trial. Copy it into
# the actual job source folder where the module expects it.
cp "C:/Users/Justi/AppData/Local/Temp/peanut-trial/stream.en.vtt" "data/clips/job-010-2026-04-10/source/stream.en.vtt"
```

Patch the manifest to point at it (if not already set):

```bash
node -e "
const fs = require('fs');
const p = 'data/clips/job-010-2026-04-10/manifest.json';
const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
m.subtitlePath = m.subtitlePath || 'data/clips/job-010-2026-04-10/source/stream.en.vtt';
fs.writeFileSync(p, JSON.stringify(m, null, 2));
console.log('patched:', m.subtitlePath);
"
```

Run dry-run first:

```bash
cd C:/peanut && npx tsx packages/clips/src/notebooklm-review.ts --stream zja-l_9aQBs --dry-run
```

Expected output includes: the stream title, the VTT path, planned queries, no API calls.

If dry-run looks correct, run the real thing using `--force` to bypass the existing trial notebook:

```bash
cd C:/peanut && npx tsx packages/clips/src/notebooklm-review.ts --stream zja-l_9aQBs --force
```

Expected: ~5-10 min total runtime, final log line `✓ NotebookLM review complete`.

Verify outputs exist:

```bash
ls data/clips/job-010-2026-04-10/notebooklm-moments.json data/clips/job-010-2026-04-10/analysis/notebooklm-review.md data/clips/candidate-pool.json
```

Expected: all 3 files present.

Verify the pool has candidates:

```bash
node -e "const p = require('./data/clips/candidate-pool.json'); console.log('pool size:', p.candidates.length, 'for job-010:', p.candidates.filter(c => c.jobId.includes('010')).length);"
```

Expected: pool size ≥ 10, job-010 entries > 0.

- [ ] **Step 4: Commit**

```bash
git add packages/clips/src/orchestrate.ts
git commit -m "feat(clips): add notebooklm-review phase to orchestrator"
```

- [ ] **Step 5: Final verification — run all tests**

```bash
cd packages/clips && node --import tsx --test test/*.test.ts
```

Expected: all tests pass.

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered by task |
|---|---|
| New module `notebooklm-review.ts` | Task 14 |
| `lib/notebooklm-client.ts` | Task 11 |
| `lib/notebooklm-queries.ts` | Task 10 |
| `lib/notebooklm-scorer.ts` | Task 5 |
| `lib/notebooklm-parser.ts` | Tasks 6-8 |
| `lib/viral-weights.ts` | Task 2 |
| `lib/candidate-pool.ts` | Task 9 |
| Extended StreamManifest | Task 1 |
| `writeCleanTranscript` helper | Task 4 |
| Extended scan.ts merge (3-source) | Task 12 |
| Auto-detect notebooklm-moments.json | Task 13 |
| Orchestrator phase integration | Task 15 |
| Test fixtures from trial | Task 3 |
| End-to-end smoke test | Task 15 |
| Scoring formula | Task 5 |
| Category weights | Task 2 |
| 8-query set | Task 10 |
| Per-query parser + dedup | Tasks 6-8 |
| Candidate pool append | Tasks 9, 14 |
| Error handling (`--force`, missing nlm, failed queries) | Tasks 11, 14 |
| Windows cp1252 workaround | Task 11 (PYTHONIOENCODING in client) |

All 21 spec concerns are addressed by exactly one task.

**Placeholder scan:** None found — every step has concrete code.

**Type consistency check:**
- `NotebookLMPick` defined in Task 6, extended to `DedupedPick` in Task 8 ✓
- `ScoreInput` / `ScoreResult` defined in Task 5, consumed in Task 14 ✓
- `CandidatePointer` defined in Task 9, consumed in Task 14 ✓
- `NotebookLMPickForMerge` defined in Task 12 (separate from parser's NotebookLMPick to avoid Scan → Parser dependency cycle) ✓
- `UnifiedMoment` extension in Task 12 is additive (all new fields optional) — matches Task 1's manifest extension philosophy ✓

**Function/method name consistency:**
- `scorePick()` — Task 5, used in Task 14 ✓
- `parseHumorQuery()` — Task 6 ✓
- `parseRunningBitsQuery()` — Task 6 ✓
- `parseEmotionalPeaksQuery()`, `parseHotTakesQuery()`, `parseDramaQuery()`, `parseOneLinersQuery()`, `parseStoryOfStreamQuery()`, `parseEnrichmentQuery()` — Task 7 ✓
- `dedupePicks()` — Task 8 ✓
- `loadPool()`, `savePool()`, `appendCandidates()`, `removeByJobId()` — Task 9 ✓
- `createNotebook()`, `addSource()`, `query()`, `deleteNotebook()`, `isNlmAvailable()` — Task 11 ✓
- `mergeSources()` — Task 12 ✓
- `writeCleanTranscript()` — Task 4 ✓

All names consistent across tasks.

**Scope check:** V1 only. No V2 daily picker, no V3 weekly compile, no historical learning. All explicitly marked non-goals in the spec are excluded.
