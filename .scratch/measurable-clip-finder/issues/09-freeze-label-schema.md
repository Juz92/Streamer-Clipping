# Freeze and enforce the label schema

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —

## Question

Nothing to decide on the protocol — ticket 05 settled that. This is the
hardening that stops the next labelling session wasting itself, and it must land
before [10 — Run the three labelling sessions](10-run-labelling-sessions.md).

The failure to prevent: the two existing labelling sessions used **different
schemas**. Stream `wKJwi-MMLJQ` collected no `correctedBeats` and no `arcIntent`;
stream `gp4sqhiaxNo` added both, plus a `coldOpenAccepted` field that the
eligibility check never reads. Nothing reconciled them, and the drift was
invisible — the gate simply reported `WAITING_FOR_LABELS` for four months while
holding ten labels, none eligible.

Done when:

- `ingest-review-decision.ts` rejects a decision missing **any** of the seven
  eligibility inputs, not just the four it currently throws on (it already
  validates `arcIntent`, `contextLevel`, `primaryEvidenceModality` and
  `repetitionClass` at lines 206–225; `contextCarrier`, `visualProofRequired`
  and a complete beat map need the same treatment). A session must not be able
  to produce an ineligible label silently.
- A **schema version** is stamped into the review pack and into
  `manual-review-feedback.json`, and a pack written against one version cannot
  be read as another without an explicit migration. `manual-review-feedback.json`
  already carries `"version": 2` — make it mean something.
- `coldOpenAccepted` is either wired into eligibility or dropped. Collecting a
  field nothing reads is how the drift started.
- A test covers the case that actually happened: a decision missing
  `contextLevel` must fail loudly, and a corpus built from such a record must
  not report it as eligible. `packages/clips/test/` already holds
  `gold-corpus.test.ts` and `ingest-review-decision.test.mjs` to extend.
- Note the live obstacle: there is **no `test` script in any package.json**, so
  nothing runs the 30 existing test files. Adding one is in scope here if that
  is what it takes to make this check real; the alternative is a test nobody
  executes, which is the same class of mistake as a field nobody reads.

The answer records what was enforced, the schema version, and whether the test
harness now runs.

## Comments

### 2026-11-02 — the test harness now runs, and the suite is mostly green

This ticket listed adding a `test` script as in-scope-if-needed. It was needed,
so it is done: `npm test` runs `tsx --test` over
`packages/clips/test/*.test.{ts,mjs}`.

Baseline on 2026-11-02: **150 tests, 148 pass, 2 fail.** The suite was in much
better shape than "nothing runs them" suggested — these were 30 files of
genuinely working tests that simply had no runner.

The 2 failures are **worktree artifacts, not defects**, and they will pass in
the main checkout:

- `visual-proof-review.test.ts` → "jobs with no visual candidates write an empty
  proof artifact without Gemini"
- `visual-proof-review.test.ts` → "orchestrator dry run orders prepare then
  review then Arc Gate"

Both spawn a subprocess using `const tsxCli = join(repoRoot, "node_modules",
"tsx", "dist", "cli.mjs")` at line 21, where `repoRoot` is derived from the test
file's own location. In a git worktree nested under `.claude/worktrees/`, that
path does not exist — the worktree has no `node_modules/tsx`, and node's own
resolution climbs to the main checkout's hoisted copy, which a hard-coded path
cannot do.

**Do not "fix" this with `createRequire(...).resolve("tsx/dist/cli.mjs")`.**
Tried on 2026-11-02 and it is worse: the deep subpath throws at module load
because of the package's `exports` map, which takes the whole file down and
silently drops all 6 of its tests from the run — the count goes 150 to 145 and
looks like an improvement in the failure column. If this is worth fixing, probe
several candidate locations and fall back, or pass the resolved path in from the
runner.

### 2026-11-02 — a worktree gotcha that will waste someone's afternoon

`node_modules/@ltx/` does not exist in the worktree. The symlinks live in the
main checkout and point at the **main checkout's** `packages/*`. So any import
of `@ltx/shared` from inside a worktree reads the main checkout's source, not
the working copy, and edits to a shared package appear to have no effect while
`tsc --build` happily typechecks them against the local source.

Tests must therefore import shared code by relative source path
(`../../shared/src/utils/...`) rather than by package specifier, which is what
every pre-existing test in this directory already does. Production code keeps
importing `@ltx/shared`; that is correct and resolves properly outside a
worktree.
