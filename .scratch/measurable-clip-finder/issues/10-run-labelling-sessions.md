# Run the three labelling sessions

Label: `wayfinder:task`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: [08 — Prototype the labelling surface](08-labelling-surface-prototype.md), [09 — Freeze and enforce the label schema](09-freeze-label-schema.md)

## Question

Nothing to decide. This is the work that turns the corpus gate from
`WAITING_FOR_LABELS` to `READY`, and it is the only thing on the map that no
agent can do: the judgements are Justin's.

Protocol is fixed by [05](05-labelling-protocol.md). Per stream: 8 candidates,
blind-mixed 3 top / 3 mid / 2 known-good seeds, no keep quota. Per candidate
Justin gives a `reaction` and a `contextLevel`, then confirms or overrides five
pipeline-proposed fields. Six benchmark-eligible labels per stream is the floor.

Three sessions, in this order — cheapest and most informative first:

1. **`job-005` / `H-_9Fgs5tIg`** — 5 rendered shorts already on disk, zero
   labels, media present. Nothing to prepare but the candidate set. Do this one
   first: it is the only stream where Justin judges finished shorts rather than
   raw windows, so it also tests whether the renderer or the finder is at fault
   when a candidate disappoints.
2. **`job-006` / `DRR2zh3YscM`** — source video present (11.5 GB), 143 grounded
   candidates to draw from, and `calibration-pack.json` already holds 5 blind
   candidates with null label slots in the right shape. Extend to 8.
3. **`job-004` / `gp4sqhiaxNo`** — a desk exercise. Five graded labels exist
   with complete corrected beats; they need only the five never-collected
   classification fields. No media required, because `benchmarkEligible` does
   not depend on `mediaAvailable`. Extend to 6.

Done when `gold-corpus.ts` reports `benchmark.status: "READY"` with
`eligibleStreams: 3`, and the shadow scorecard's ranking gate stops blocking on
label count.

Record, in the answer: minutes per candidate, which field Justin hesitated on
most, and how many of the 2 known-good seeds per stream he kept. That last
number is the diagnostic — if he rejects the seeds too, the problem is how
candidates are cut, not how they are ranked.

**Do not** lower a threshold to reach READY. The gate refusing to promote is
the system working correctly; the whole point of this chain is to feed it, not
to argue with it.

## Comments
