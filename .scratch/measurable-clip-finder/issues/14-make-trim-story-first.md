# Make trim story-first instead of duration-first

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —

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
