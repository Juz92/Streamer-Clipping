# Make trim story-first instead of duration-first

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

**Already satisfied. The premise of this ticket was wrong, and almost nothing
needed to change.**

I wrote this ticket from the 2026-07-14 reassessment's §4C, which said trimming
is duration-first and cuts the setup to protect the punchline. Traced through the
code before editing, and that is no longer how it works:

- Every use of `targetMin`/`targetMax` in `trim.ts` either **writes them into an
  output record** (lines 242–258, 331, 366, 865–949) or **displays them in the
  generated review UI** (1675, 1803, 2040, 2052). **No line uses a target to
  compute a boundary.**
- Boundaries come from the grounded beats. `lib/grounded-trim.ts`
  `applyGroundedQuality` sets `startSec: quality.setupStartSec` and
  `endSec: quality.reactionEndSec ?? quality.naturalEndSec` — verbatim, with no
  duration budget anywhere near it.
- There is no non-grounded fallback to worry about. All three branches of
  `loadAutoMoments` feed `applyPickQuality`, which **throws** without a
  pick-quality entry, and `applyGroundedQuality` **throws** unless the candidate
  is `GROUNDED` and not `reserve`.
- `enhanced-auto-trim.ts`'s "target" is a *proposed boundary* to snap to speech,
  punctuation or silence — not a length budget. That is the "finish speech
  before cutting" behaviour, which is correct and stays.

So points 2 and 3 of [04](04-duration-and-boundary-policy.md) describe behaviour
the grounded trim path already has. The reassessment's criticism was fixed
between July and now, and the ticket inherited a stale claim.

### The one thing that did need fixing

The review UI was the single place targets were *not* advisory. It painted any
clip outside the archetype range red as `over-budget`, and the summary table
coloured it `#ef4444`. Under ADR 0003 that would flag the project's own 92s
short and the 107s labelling candidate as errors.

Changed so red means **invalid**, not merely long: outside 10–180s is red, inside
the archetype target is green, and valid-but-longer-than-typical is amber —
worth a look rather than a failure. The target stays visible as the guidance
ADR 0003 says it remains. Platform bounds are duplicated as literals there
because it is generated browser code and cannot import from the package; the
comment says so.

`getTrimTargets` and the `trim.ts:728` sweet-spot nudge were left exactly alone.
The nudge is inside a frame the evidence says is wrong, and ticket 04 was
explicit that adjusting it is the dead end — so it is neither adjusted nor
deleted, pending a reason to touch it.

No new test: the change is a colour expression in generated browser JS with no
reachable seam, and the behaviour it guards is visual.

Implements points 2–4 of [04 — duration and boundary policy](04-duration-and-boundary-policy.md),
recorded as [ADR 0003](../../../docs/adr/0003-duration-is-editorial-not-a-gate.md).

## Question

Nothing to decide — the policy is settled. This is the change in `trim.ts` that
the gate fix did not touch, kept separate because `trim.ts` is 99 KB and the
gate was one constant.

What must change:

- **`getTrimTargets` becomes advisory.** It currently returns hard
  `targetMin`/`targetMax` at line 707 that the cut is fitted to. The targets
  should be reported alongside the chosen boundaries, not drive them.
- **Stop trimming from the setup side.** When content runs longer than a target,
  the code currently preserves the natural end by cutting the premise. 19 of 21
  reference positives show their premise in the first 0–3 seconds, so the
  premise is load-bearing. If a complete arc does not fit, keep the arc.
- **Leave the sweet-spot nudge alone or delete it.** `trim.ts:728` adjusts
  targets by ±3s from competitive-intel data. Re-tuning it is explicitly the
  dead end ticket 04 warned against: it is tuning inside a frame the evidence
  says is wrong. Deleting it is fine; adjusting it is not.
- **Arc scoring must not penalise a weak natural opening.** The flash cold-open
  stays, and a source window should not lose points because its first three
  seconds are not already a finished hook. That confuses source quality with
  edit quality.

Done when a candidate whose complete arc runs 90 seconds is cut at 90 seconds
with its premise intact, the archetype target is recorded as a note rather than
a constraint, and a test covers the long-arc case.

Note the gate no longer blocks the result: `MAX_SHORT_DURATION_SEC` is 180.

## Comments
