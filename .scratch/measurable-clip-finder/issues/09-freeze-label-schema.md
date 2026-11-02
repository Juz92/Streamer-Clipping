# Freeze and enforce the label schema

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

**Most of this ticket was already done, and the part I described was wrong.**

The ticket claimed `ingest-review-decision.ts` "throws on four" of the seven
eligibility inputs. It throws on **all seven plus `coldOpenAccepted`** — and has
since before today. I wrote that line from a `head -30` truncated grep and never
checked the rest of the function. The existing ten labels predate that
validation; they were not written past it.

So a future labelling session could already not omit a classification field. Two
real gaps remained, and both are now closed.

### Gap 1 — the version was written and never read

`appendManualFeedback` stamped `version: 2` on every write and read the file back
as `{ records }`, ignoring the version entirely. A file written under any other
shape would have been merged in silently, which is exactly how two sessions
ended up with different schemas.

Now `FEEDBACK_SCHEMA_VERSION` is exported, written, and **checked on read**: an
existing file at a different version throws and tells you to migrate explicitly
rather than merging across versions.

### Gap 2 — a label could still be silently uncountable

`validateCorrectedBeats` returns early when beats are absent (`if (!beats)
return;`), which is correct — ticket 05 decided the pipeline proposes beats and
the human only confirms, so demanding six hand-typed timestamps per candidate
would defeat the protocol. But nothing checked that beats were *resolvable*. A
decision with no `correctedBeats`, on a candidate whose arc grounding has no
complete beat map either, passed validation and then failed
`hasCompleteBeatMap` inside the corpus — accepted at write time, uncounted at
read time, no complaint at either end.

`normalizeReviewRecord` now takes an optional set of candidates whose grounded
beats are complete, and refuses a decision that neither corrects the beats nor
can inherit them. `main()` builds that set from `arc-grounding.json`, which
ingest did not previously read. Callers that cannot see grounding omit the
argument and behave as before, so existing tests are unaffected.

### `coldOpenAccepted`: kept, and deliberately outside eligibility

It is required at write time but absent from the corpus eligibility check, which
the ticket flagged as the drift pattern. Keeping it, because it is a real
editorial judgement and it is the input
[04 — duration and boundary policy](04-duration-and-boundary-policy.md) needs
when it decides whether the 2-second flash stays. Wiring it into eligibility
would retroactively invalidate the five `gp4sqhiaxNo` labels that do carry it,
for no measurement benefit. Recorded here so the next reader knows it is a
policy input rather than a forgotten field.

### Tests

`packages/clips/test/label-schema-guard.test.ts` — 12 tests, all passing: one per
never-collected field, both beat-resolvability branches, out-of-order beats, and
both schema-version paths.

`npm test` now exists (that was listed as in-scope-if-needed) and the suite is
**167 tests, 165 passing**. The 2 failures are the worktree artifacts documented
in the comments above.

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

### 2026-11-02 (later) — both failures fixed, suite fully green at 191/191

The two failures above are gone. `visual-proof-review.test.ts` now asks node
where tsx is instead of assembling a path:

```ts
req.resolve("tsx/cli")   // -> .../node_modules/tsx/dist/cli.mjs
```

**Correcting the warning in the section above.** It said not to use
`createRequire(...).resolve(...)` for this. That was the wrong lesson from a
real failure. The approach is right; my *specifier* was wrong. tsx 4.21.0 has
an `exports` map in which:

- `tsx/cli` **is** declared and resolves straight to `dist/cli.mjs`;
- `tsx/dist/cli.mjs` is **not**, and throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.

Because I computed it at module scope, that throw took the whole file down and
silently dropped all 6 of its tests — the count went 150 to 145 while the
failure column *improved*, which is why it looked like progress. The danger was
never `createRequire`; it was a deep path into a package with an `exports` map,
evaluated where a throw is invisible.

A `tsx/package.json` fallback is kept behind the `tsx/cli` attempt, since
package.json is always exported and its `bin` field names the real entry point.
A comment on the function says not to collapse it back to a deep path.

Why node's resolution is the only thing that works: the worktree has **no
`node_modules` directory at all**, so every specifier climbs to the main
checkout's hoisted copy. A path built from the test file's own location cannot
do that; `req.resolve` does it for free, and the same code works unchanged in
either layout.

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
