# Prototype the labelling surface

Label: `wayfinder:prototype`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: [05 — What labelling protocol clears the gold-corpus gate?](05-labelling-protocol.md)
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

Built, and a session for `job-006` is ready to label:

```
data/clips/job-006-2026-07-16/label-session/index.html
```

Open it in a browser. It saves `review-decision.json` next to itself.

Two files, both in `packages/clips/src/`:

- `prepare-label-session.ts` — picks the blind mix, cuts a clip per candidate
  with ffmpeg, computes what the pipeline can propose, and writes a
  self-contained page. `--stream <id>`, optional `--count`.
- `label-session.html` — the page template. Its data is **inlined** at prep
  time, not fetched: browsers block `fetch()` of a sibling file over `file://`,
  and this has to open with a double click rather than needing a dev server.
  `<video src>` works from `file://` either way.

### What the session looks like

8 candidates from the 143 ranked, mixed **3 top / 3 mid / 2 bottom** and then
shuffled so position cannot leak the band. The bottom two stand in for the
known-good seeds the protocol wants: no same-stream seeds exist, because the
aligned official Shorts come from other VODs whose source video is gone.
Keeping a bottom-ranked clip is still a strong signal that the ranking rather
than the stream is the problem. The band is held out of the page and kept in
`candidates.json` so the outcome can be read per band afterwards.

Clips cut in **24 seconds total** for 8, from the 10.7 GB source: fast seek
(`-ss` before `-i`), scaled to 640px, 0.9–16.6 MB each.

### Measurement, which is the actual point of this ticket

The page records, per candidate, total seconds spent and **time-to-first-touch
of every field**, then reports seconds-per-candidate and which question most
often took longest. That answers the ticket's question — which judgement makes
Justin stop — objectively rather than by asking him to remember.

### Verified

- Session data injects correctly: 8 candidates, no placeholder left, all 8 with
  complete beats, bands `mid top mid top top mid low low`.
- Round-tripped a simulated completed session through the real ingest path:
  `normalizeReviewRecord` accepted all 8, and **8 of 8 came out
  benchmark-eligible**. A finished session produces a fully countable stream,
  which is the thing that has never once happened in this project.

### Not verified

**The interactive flow has not been run.** The page opens as a static snapshot
in this environment, so its JavaScript never executed — the data injection and
the output shape were checked by inspection and simulation, not by clicking
through. Justin will be the first to execute it, and a first run that hits a
runtime error is entirely possible.

### Two findings for other tickets

- **Three of the eight clips are 107 s, 82 s and 77 s.** `quality-gates.ts:37`
  rejects anything over 60, so nearly half this blind set is unrenderable under
  the current gate. More evidence for
  [04](04-duration-and-boundary-policy.md).
- **The pipeline can only honestly propose three of the five fields**
  [05](05-labelling-protocol.md) assumed, so a session asks six human
  judgements rather than two. Recorded in 05's resolution. Whether six is
  tolerable is what [10](10-run-labelling-sessions.md) will measure — and it is
  now the only ticket between the map and a READY corpus.

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
