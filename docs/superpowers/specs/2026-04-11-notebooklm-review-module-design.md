# NotebookLM Review Module — V1 Design Spec

**Status:** Draft, awaiting user review
**Date:** 2026-04-11
**Scope:** Sub-project A of a 3-sub-project initiative (A: review module, B: daily picker, C: weekly compilation video). This spec covers A only. B and C get their own specs after V1 is in production.

## Goal

Add a new pipeline step that uses NotebookLM (via the `nlm` CLI) to extract, score, and enrich high-value clip candidates from a stream transcript. Output feeds directly into the existing render/upload pipeline via the `unified-moments.json` flow, and into a new cross-stream candidate pool that enables future daily-picker (V2) and weekly-compilation (V3) workflows.

## Non-goals

These are out of scope for V1 and will be addressed in follow-up specs:

- **Daily picker** (V2): Automatically selecting the top 1-2 picks per stream for a daily Shorts upload.
- **Weekly compilation video** (V3): Monday job that builds a top-10 countdown long-form video from the last 7 days of the candidate pool.
- **Historical performance learning**: Adjusting category weights based on past YouTube Analytics retention/view data. Weights are hand-tuned in V1.
- **Cross-stream queries**: Running NotebookLM queries that span multiple streams (e.g. "find callbacks to last week's stream"). Architected-for but disabled in V1.
- **Replacing the existing audio/chat/transcript scorer**: `analyze.ts` continues to run and produce its own picks. NotebookLM is a complementary third source.

## Trial validation

A trial run on stream `zja-l_9aQBs` (11-hour RUST stream, 2026-04-10) established that:

- NotebookLM can identify humor moments the existing scorer fundamentally misses (dry-jokes, callbacks, character moments, running bits spanning hours).
- CLI + source upload + 2 queries completed in ~3 minutes on a 0.69 MB transcript.
- Output is citation-grounded with specific timestamps.
- Full trial results are in `data/clips/job-010-2026-04-10/analysis/notebooklm-trial-review.md`.

## Architecture

### Pipeline position

```
discover → analyze → notebooklm-review (NEW) → scan --merge → render-fast → upload
```

The new step runs after `analyze.ts` (which produces `moments.json` from audio/chat/transcript signals) and before `scan.ts --merge` (which fuses sources into `unified-moments.json`).

### Module structure

```
packages/clips/src/
  notebooklm-review.ts              # CLI entry point + orchestration
  lib/
    notebooklm-client.ts            # Thin wrapper over `nlm` CLI subprocess calls
    notebooklm-queries.ts           # The 8 query prompts as typed constants
    notebooklm-scorer.ts            # Category weights + modifiers → viralScore
    notebooklm-parser.ts            # Parse JSON responses into structured picks
    viral-weights.ts                # Tunable category weights + score modifiers
    candidate-pool.ts               # Read/append/update the master pool JSON
```

Breaking into 6 small files (not one monolith) keeps each unit testable in isolation and matches how the rest of `packages/clips/src/lib/` is organized.

### Data flow

1. Module reads `manifest.json` → `subtitlePath` (VTT) and `jobDir`
2. Parses VTT into a clean timestamped transcript (reuses existing `lib/subtitle-parser.ts`)
3. Writes transcript to `{jobDir}/source/transcript_clean.txt`
4. Creates a NotebookLM notebook via `nlm notebook create`, uploads the transcript via `nlm source add --file --wait`
5. Runs 8 queries sequentially (conversation ID chained for cross-query context)
6. Parses each JSON response into structured picks
7. Applies the scoring formula to produce a `viralScore` per pick
8. Writes `{jobDir}/notebooklm-moments.json` in the new `NotebookLMMoment[]` format
9. Writes human-readable `{jobDir}/analysis/notebooklm-review.md` for manual inspection
10. Appends pointer records to `data/clips/candidate-pool.json`
11. Updates `manifest.json` with `notebookId`, `notebookSourceId`, `notebookLMReviewPath`, `phase: "notebooklm-reviewed"`

Downstream: `scan.ts --merge` is extended to accept a third source (NotebookLM) and fuses all three into the existing `unified-moments.json`.

## Query set (8 queries)

Each query runs with `--json --timeout 300`. Queries 2-8 chain via `--conversation-id` from query 1 so NotebookLM remembers earlier context.

| # | Query | Purpose | Expected output count |
|---|---|---|---|
| 1 | **Humor moments** | Top 15 individual comedy picks with humor-type classification | 15 |
| 2 | **Running bits** | Recurring themes spanning multiple timestamps across the stream | 8-12 |
| 3 | **Emotional peaks (non-comedy)** | Rage, wholesome, vulnerability, shock, triumph, cringe | 8-10 |
| 4 | **Hot takes & opinions** | Moments where Peanut drops controversial or strong opinions (drives comments) | 5-10 |
| 5 | **Drama & conflict** | Arguments, callouts, betrayals, trash-talk exchanges | 5-10 |
| 6 | **Quotable one-liners** | Standalone 5-15 word zingers for thumbnails/titles | 10-15 |
| 7 | **Story of the stream** | Single hero pick — THE moment of the stream | 1 |
| 8 | **Per-clip enrichment** | For every unique candidate from queries 1-7: cold-open timestamp, natural-end timestamp, 3 title drafts, thumbnail frame timestamp | ~40 enrichment records |

Each prompt is a typed constant in `notebooklm-queries.ts` with a standardized output-format instruction demanding JSON-parseable fields (timestamp, hook, quote, category, setup_needed, strength 1-5). Query 8's prompt lists the deduplicated candidates from queries 1-7 and asks for enrichment one at a time.

**Deduplication between queries:** Two picks from different queries are considered the same moment if their start timestamps are within 30 seconds (matching the existing merge threshold in `scan.ts`). Duplicates get merged with the higher strength score, and the category list is preserved as an array so a pick can be both `hot-take` and `drama`.

## Scoring formula

```
viralScore = round(nlmRawScore × categoryWeight + modifiers)
```

Where:

- **`nlmRawScore`** (0-100): NotebookLM's subjective strength rating, normalized from the per-query 1-5 strength field: `strength * 20`. If a pick comes back without a strength field (some queries may not always populate it), default to `strength = 3` (→ `nlmRawScore = 60`), which is "middle of the pack, include but don't prioritize."
- **`categoryWeight`**: From `viral-weights.ts` (see below). When a pick has multiple categories, use the MAX weight.
- **`modifiers`** (additive):
  - `+10` if `durationSec` is 20-70 (Shorts sweet spot)
  - `-15` if `durationSec < 10` or `durationSec > 90`
  - `+5` if `setupNeeded === false` (standalone-friendly)
  - `-5` if `setupNeeded === true` AND `setupRef` points to a moment > 30 minutes earlier (high cognitive load)
  - `+3` if pick appears in 2+ different category queries (broad appeal signal)

Final score is clamped to [0, 100].

### Default category weights (`lib/viral-weights.ts`)

```typescript
export const CATEGORY_WEIGHTS: Record<string, number> = {
  "hot-take": 1.15,          // Drives comment engagement
  "drama": 1.10,             // Conflict = retention
  "running-bit": 1.05,       // Rewards regulars, unique to NotebookLM
  "character-moment": 1.05,
  "callback": 1.05,
  "dry-joke": 1.00,          // Baseline
  "absurdist": 1.00,
  "emotional-peak": 1.00,
  "reaction-gold": 0.95,     // Scorer already covers via audio spike
  "one-liner": 0.90,         // Feeds titles/thumbs, not standalone
  "story-of-stream": 1.20,   // Hero pick bonus
};

export const DURATION_SWEET_SPOT = { min: 20, max: 70 };
export const DURATION_HARD_LIMITS = { min: 10, max: 90 };
```

Weights are hand-tuned to start. V3 / future work includes a feedback loop that adjusts these from YouTube Analytics data. For now, editing this file and re-running is the tuning loop.

## Schema changes

### Extended `UnifiedMoment` interface (in `scan.ts`)

Additive only. All new fields are optional so existing manual + automated picks continue to validate.

```typescript
interface UnifiedMoment {
  id: string;
  source: "manual" | "automated" | "notebooklm" | "both";  // +notebooklm
  startSec: number;
  endSec: number;
  durationSec: number;
  description: string;
  viralityScore: number;
  hookText?: string;
  layoutMode?: "gameplay" | "talking";
  segments: ClipSegment[];
  automatedSignals?: { ... };                  // existing

  // NEW optional fields (populated by notebooklm-review):
  categories?: string[];                        // e.g. ["hot-take", "drama"]
  coldOpenSec?: number;                          // enriched start for first-3s hook
  naturalEndSec?: number;                        // enriched end at natural audio exit
  thumbnailSec?: number;                         // single frame for thumbnail generation
  titleDrafts?: string[];                        // 3 title variants, ≤60 chars each
  setupNeeded?: boolean;
  setupRef?: { startSec: number; description: string };
  viralSubScores?: {
    nlmRaw: number;
    categoryWeight: number;
    durationMod: number;
    standaloneMod: number;
    crossCategoryBonus: number;
    final: number;
  };
  notebooklmQuote?: string;                      // cited transcript excerpt for provenance
}
```

### New `NotebookLMMoment` (internal to `notebooklm-review.ts`, pre-merge)

Before passing to `scan.ts --merge`, picks are written to `{jobDir}/notebooklm-moments.json` in an intermediate format. `scan.ts --merge` converts them into `UnifiedMoment` during the merge. This matches the existing pattern (ManualPick → UnifiedMoment).

### Extended `StreamManifest`

```typescript
interface StreamManifest {
  // ... existing fields
  notebookId?: string;                    // NotebookLM notebook UUID
  notebookSourceId?: string;              // Source UUID within the notebook
  notebookLMReviewPath?: string;          // Path to notebooklm-moments.json
  notebookLMReviewedAt?: string;          // ISO timestamp
  phase: "downloaded" | "analyzed" | "notebooklm-reviewed" | "scanned" | "rendered" | "uploaded";
}
```

### Candidate pool (`data/clips/candidate-pool.json`)

```typescript
interface CandidatePool {
  version: 1;
  updatedAt: string;
  candidates: CandidatePointer[];
}

interface CandidatePointer {
  jobId: string;                          // e.g. "job-010-2026-04-10"
  momentId: string;                       // e.g. "nlm-002"
  streamId: string;
  streamDate: string;                     // ISO date
  categories: string[];
  viralScore: number;
  durationSec: number;
  hook: string;                           // short hook for quick scanning
  status: "pending" | "posted-daily" | "posted-weekly" | "archived" | "rejected";
  statusUpdatedAt: string;
  postedDate?: string;                    // ISO date when uploaded
  youtubeUrl?: string;                    // populated by V2 after upload
  weeklyCompilationId?: string;           // populated by V3
}
```

V1 only appends new records with `status: "pending"`. V2/V3 mutate status. The pool is stored as JSON (not a DB) to match the rest of the pipeline's file-based-state philosophy.

**Conflict handling on re-runs:** If a job is re-reviewed, old pointers for that `jobId` are removed and replaced. Posted/archived entries are preserved unchanged (they represent published state).

## Integration with `scan.ts --merge`

The existing `mergeManualAndAutomated` function becomes `mergeSources`, accepting three arrays:

```typescript
function mergeSources(
  manualPicks: ManualPick[],
  automatedMoments: Moment[],
  notebookLMPicks: NotebookLMPick[],
): UnifiedMoment[]
```

Merge algorithm (two-pass):

1. **Pass 1**: Merge manual + automated (existing logic, unchanged).
2. **Pass 2**: For each NotebookLM pick, find overlaps with pass-1 output using the existing `OVERLAP_THRESHOLD_SEC = 30` rule. On overlap, preserve manual-dominant fields (timing, description) but merge NotebookLM enrichment fields (categories, coldOpenSec, titleDrafts, etc.) and upgrade `source` to `"both"`. Non-overlapping NotebookLM picks are added as `source: "notebooklm"` records.
3. **Precedence for conflicting fields**: manual > automated > notebooklm for description and timing. NotebookLM wins for enrichment fields (since it's the only producer).
4. **Score reconciliation**: All three sources produce a 0-100 `viralityScore` in their unified form (manual is already 0-100, automated is converted via `composite * 10`, notebooklm uses the formula below). Final `viralityScore` on the merged moment is `max(manualScore, automatedScore, nlmViralScore)` — whichever source rated it highest wins. This favors "at least one source loved this" over averaging, because missing signal in one source shouldn't drag down a confirmed hit.

`scan.ts --merge` CLI gains a new optional flag: `--notebooklm <path>` to point at the NotebookLM moments file. If omitted, merge auto-detects `{jobDir}/notebooklm-moments.json` and includes it when present. This keeps the existing 2-source merge workflow working unchanged when NotebookLM is absent or deliberately skipped.

## CLI interface

```bash
# Default: run full review on a stream
npx tsx packages/clips/src/notebooklm-review.ts --stream <streamId>

# Re-run (delete existing notebook + re-upload)
npx tsx packages/clips/src/notebooklm-review.ts --stream <streamId> --force

# Skip queries 1-7, only re-run query 8 (enrichment) on existing candidates
# Reads existing notebooklm-moments.json, re-queries enrichment for each pick,
# overwrites the enrichment fields in place. Preserves viralScore + categories.
npx tsx packages/clips/src/notebooklm-review.ts --stream <streamId> --enrich-only

# Limit to specific queries (for debugging)
npx tsx packages/clips/src/notebooklm-review.ts --stream <streamId> --queries 1,2,3

# Notebook lifecycle strategy (default: per-stream; shared mode is architected-for but not active in V1)
npx tsx packages/clips/src/notebooklm-review.ts --stream <streamId> --notebook-strategy per-stream

# Dry run — validate inputs, show plan, no API calls
npx tsx packages/clips/src/notebooklm-review.ts --stream <streamId> --dry-run
```

Flags are processed in `notebooklm-review.ts` entry point. The `--notebook-strategy` option defaults to `per-stream` and `shared` returns "not implemented in V1" — the flag exists now so the switch is a config change later, not an architecture rewrite.

## Orchestrator integration

Add NotebookLM review as a new phase in `orchestrate.ts`:

```typescript
const PHASES = ["discover", "analyze", "notebooklm-review", "scan", "render", "upload"] as const;
```

Default behavior: `orchestrate` runs through NotebookLM review automatically. If `nlm` CLI is not on PATH, the phase is skipped with a warning (graceful degradation). If NotebookLM review fails mid-run, the pipeline continues with just manual + automated picks (the module's failure does not break the downstream render).

New orchestrator flag: `--skip-notebooklm` for when you deliberately want to bypass NotebookLM (debugging, quota exhaustion, offline).

## Error handling

| Failure mode | Behavior |
|---|---|
| `nlm` CLI not installed | Log warning, skip step, continue pipeline |
| `nlm login` expired | Log error with remediation hint (`run nlm login`), exit cleanly |
| Notebook creation fails | Retry once, then skip step |
| Source upload fails | Retry once with exponential backoff, then skip step |
| Individual query fails | Log warning, skip that query, proceed with partial results |
| Query returns malformed JSON | Attempt lenient JSON repair (strip markdown fences, etc.), then skip |
| Transcript missing | Hard fail — NotebookLM review cannot run without VTT |
| `PYTHONIOENCODING` not set | Module sets it internally on every subprocess call (Windows cp1252 fix) |

All subprocess calls go through `notebooklm-client.ts` which centralizes env setup, retries, and structured error types.

## State & idempotency

**Re-run behavior:** Default is "skip if already reviewed" (checks `manifest.phase === "notebooklm-reviewed"`). `--force` deletes the existing notebook (best-effort), removes the pool's `pending` records for this jobId, and starts fresh. Pool records with `status` in {`posted-daily`, `posted-weekly`, `archived`} are never touched by `--force` — they represent published state and are immutable from V1's perspective.

**Notebook cleanup policy:** After a successful review, the NotebookLM notebook is kept (not auto-deleted) so the user can manually revisit it in the NotebookLM web UI for ad-hoc follow-up questions. Only `--force` deletes. A future `nlm-review --cleanup-old` command could purge notebooks older than N days, but that's out of scope for V1.

**Transcript file persistence:** `{jobDir}/source/transcript_clean.txt` is kept after upload (not deleted) for provenance and to enable `--enrich-only` re-runs without re-parsing VTT.

**Partial state recovery:** If the module crashes between "notebook created" and "queries complete", `manifest.notebookId` is already saved. On retry without `--force`, the module detects this, reuses the notebook, and resumes from the next unexecuted query.

**Pool consistency:** Pool writes use "read → modify → write" atomically with a temp file + rename. If the pool is corrupted, the module fails loudly and refuses to proceed — data integrity over progress.

## Configuration

No new config files. Knobs live in:

- `packages/clips/src/lib/viral-weights.ts` — category weights + modifiers (code, easy to tune)
- `packages/clips/src/lib/notebooklm-queries.ts` — query prompts (code, easy to version)
- Environment: `PYTHONIOENCODING=utf-8 PYTHONUTF8=1` is set by `notebooklm-client.ts` internally, always.

## Testing approach

No existing test harness in the clips package, so V1 introduces lightweight validation rather than a full test suite:

1. **Fixture-based validation:** Save the query responses from the trial run (`data/clips/job-010-2026-04-10/analysis/notebooklm-query*.json`) as fixtures. Unit-test the parser and scorer against them — no API calls.
2. **Dry-run mode** (`--dry-run`): Validates inputs, prints the execution plan, touches no files. Makes it safe to test on CI or in a stale environment.
3. **Smoke test script:** `scripts/smoke-notebooklm-review.sh` runs a minimal end-to-end against a known job folder and checks exit code + file existence. Run manually before commits to the module.

Full end-to-end validation = run on a real stream and visually inspect the output markdown. Automating this is out of scope for V1.

## Known limitations

1. **Community-built `nlm` CLI.** Jacob Ben-David's package (`notebooklm-mcp-cli`). If Google changes NotebookLM internals, the CLI breaks. Version is pinned in install docs; watch for reports.
2. **Windows Unicode crashes.** The CLI crashes printing `✓` on cp1252 consoles. Workaround baked into `notebooklm-client.ts` (sets `PYTHONIOENCODING=utf-8` for every subprocess). Report upstream.
3. **Rate limits unknown.** NotebookLM is free but has undocumented per-account limits. If we hit them, the module logs and fails gracefully. Worth monitoring for the first 10-20 runs.
4. **Subjective scoring.** NotebookLM's "strength 1-5" per pick is not deterministic — the same stream re-queried might return slightly different rankings. V1 accepts this variance; V3 / feedback-learning removes it.
5. **No cross-stream queries in V1.** Running bits and callbacks are detected within a single stream only. Shared-notebook mode (architecturally supported, behind the `--notebook-strategy shared` flag) unlocks this later.
6. **Full transcript upload is required.** `--youtube` direct-ingest path is not used in V1 (untested on 11-hour videos). Worth experimenting with in V1.5.

## Future work (out of scope)

- V2 daily picker
- V3 weekly compilation video
- Historical performance feedback loop → auto-tuning category weights
- Shared-notebook cross-stream queries
- `--youtube` direct-ingest experiment
- Per-clip thumbnail generation from the enriched `thumbnailSec` timestamps
- Title A/B testing framework using the `titleDrafts` array

---

**Reviewer checklist (for user review):**

- [ ] Scope feels right — 8 queries, not too few / too many?
- [ ] Category weights match your taste for what performs?
- [ ] Integration with `scan.ts --merge` doesn't conflict with how you currently use it?
- [ ] Candidate pool at `data/clips/candidate-pool.json` is the right location?
- [ ] Error handling matches your tolerance for pipeline breakage?
- [ ] Anything important missing?
