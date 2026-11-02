# Map: A measurable clip-finder

Label: `wayfinder:map`
Created: 2026-11-02

## Destination

On an unseen BurntPeanut VOD, the system returns 3–5 correctly-bounded clips
Justin would seriously consider posting — and we can prove it did, on streams it
has never seen.

The map is done when nothing is left to decide before someone builds that.

## Notes

**Domain.** Automated gaming-clip extraction from 8–12h livestream VODs.
See [docs/agents/domain.md](../../docs/agents/domain.md).

**Required reading for every session on this map:**

- [docs/strategy/2026-11-02-state-of-play-audit.md](../../docs/strategy/2026-11-02-state-of-play-audit.md)
  — what the code and the one surviving job actually do today
- [docs/strategy/stream-clipper-reassessment-2026-07-14.md](../../docs/strategy/stream-clipper-reassessment-2026-07-14.md)
  — the V2 architecture this map continues; its Stage 1–6 cascade still holds

**Skills to consult:** `grilling` and `domain-modeling` on every grilling
ticket; `research` on every research ticket.

**Standing preferences.**

- Recall stays uncapped; production volume is capped downstream only
  (see CLAUDE.md, "15-Clip Production Cap (NOT A RECALL CAP)").
- Do not add a taste model to a handful of labels. Every prior attempt failed
  on 6 positives / 10 negatives; see the reassessment's table of nine dead ends.
- Prefer deleting a scorer to adding one. The project already carries ten
  overlapping rankers and ~1.3k LOC of unreachable modules.
- `shadow-scorecard.ts` keeps its veto. It is the only honest gate in the
  system and it is working as designed.
- Research findings land in `.scratch/measurable-clip-finder/research/`.
  Nothing on this map pushes a branch or opens a PR without Justin asking.

## Decisions so far

<!-- one line per closed ticket; the detail lives in the ticket -->

- [05 — What labelling protocol clears the gold-corpus gate?](issues/05-labelling-protocol.md):
  8 blind-mixed candidates per stream, human gives only reaction + context level
  while the pipeline proposes the other five eligibility fields; corpus reaches
  READY on the three streams already on disk, nothing held out yet. The gate was
  never short of labels — zero of the ten existing labels were ever eligible,
  because five required fields had never once been collected.
- [02 — What can current models actually do with long audio and timestamps?](issues/02-audio-native-humour-models.md):
  audio models classify laughter near-perfectly and localise it terribly
  (0.982 F1 vs 0.028 on the same model); temporal grounding is 7–13 mIoU at 17
  minutes against our 11.8 hours. Audio is a cheap recall route ($0.41/pass),
  never a boundary source. A small trained temporal head is now the
  better-evidenced path, and it needs the labels from ticket 05.
- [03 — Is the Twitch crowd route available for current VODs?](issues/03-twitch-crowd-route.md):
  the route lives and was never built — its zero was void evidence. He
  simulcasts, so Twitch and YouTube timelines diverge by under 10 s, and
  `clip.createdAt − vod.release_timestamp` gives an anchor with no Twitch token
  and no expiry. The heatmap is dead three ways over and its extractor returns
  null by construction; delete it. Twitch per-game chapters transfer onto the
  YouTube timeline for free.

## Not yet specified

- **How "correctly bounded" gets measured** once beats come from an
  audio-native model rather than VTT heuristics. The reassessment proposes
  median start/end error ≤2s, but that was written for text-derived beats and
  may be the wrong instrument. Revisit after the humour-architecture decision.
- **Whether `analyze.ts` is repaired or retired.** Its top-20 scene prefilter
  is the known recall killer, but it is also the only producer of the
  `scorer`-route candidates. Hangs on the recall-routes decision.

## Out of scope

Ruled beyond this destination when it was named on 2026-11-02. Returns only if
the destination is redrawn, as a fresh effort.

- **Monetization, rights and YPP eligibility.** Real and arguably blocking for
  the product, but not for a measurable clip-finder. See
  [docs/research/rights-and-ypp-monetization-2026-07-14.md](../../docs/research/rights-and-ypp-monetization-2026-07-14.md).
- **Upload cadence, scheduler and the publish queue.** No cron exists; that
  stays true.
- **Multi-streamer support.** Single-tenant throughout.
- **Packaging and title style.** Measured on 2026-11-02 and worth acting on
  one day: @TheBurntPeanutShorts runs a 244K median on Title Case +
  trailing-ellipsis cliffhangers, against @BurntPeanut_Daily's 18K median on
  ALL CAPS — a 13.5x gap, while this repo's approved hook overlay copies the
  ALL-CAPS form. Recorded in the state-of-play audit, §Gap 4. It is an
  output-packaging question, not a clip-finding one.
