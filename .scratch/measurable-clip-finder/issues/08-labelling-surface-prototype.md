# Prototype the labelling surface

Label: `wayfinder:prototype`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: [05 — What labelling protocol clears the gold-corpus gate?](05-labelling-protocol.md)

## Question

Labelling has stalled for four months. If ticket 05 concludes the protocol is
sound but the friction is in *doing* it, the fastest way to find out what is
actually tolerable is to build something cheap and rough and have Justin label
five candidates in it.

Make the smallest artifact that answers: how long does one candidate take, and
which of the required judgements are the ones that make him stop?

Material that already exists and should be reused rather than rebuilt:

- `data/clips/job-006-2026-07-16/calibration-pack.json` — five candidates with
  descriptions, start/end, recall routes, and null label slots already shaped
  for exactly this (`reaction`, `decision`, `correctedStartSec`,
  `correctedEndSec`). Verdicts were deliberately withheld for blind review.
- `private-review/pack-v1/` and `pack-v2/` — two generations of review packaging
  that already shipped.
- `prepare-review.ts` and `ingest-review-decision.ts` — the existing
  write-back path.

The useful output of this ticket is not the prototype. It is the answer to
"what does the protocol have to be for this to happen weekly instead of never",
plus a measured seconds-per-candidate figure. Link the prototype from this
ticket; it is a throwaway.

Note the known defect to avoid inheriting: the reassessment found
`ingest-review-decision.ts` reads `moments.json` as an object with a `moments`
property while the file is an array, so lane and scorer features are silently
dropped from feedback records. Verify whether that is still true before
building on that path.

## Comments
