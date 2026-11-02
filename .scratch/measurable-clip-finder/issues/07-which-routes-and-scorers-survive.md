# Which recall routes and which scorers survive?

Label: `wayfinder:grilling`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: [03 — Is the Twitch crowd route available for current VODs?](03-twitch-crowd-route.md), [06 — What is the humour scoring architecture?](06-humour-scoring-architecture.md)

## Question

The pipeline runs 15 orchestrated steps and carries ten overlapping rankers.
On its last real run, 73% of candidates came from a single prompt:

| Route | job-006 candidates |
|---|---:|
| `semantic:humor` | 133 |
| `semantic:emotional-peaks` | 25 |
| `audio-peak` | 19 |
| `scorer` | 19 |
| `transcript-signal` | 14 |
| `semantic:friend-roasts` | 8 |
| `semantic:story-of-stream` | 5 |
| crowd / Twitch | 0 |
| chat-reaction | 0 |

Once chat exists and the humour architecture is decided, settle the shape of
discovery:

1. **Which of the five designed routes are real?** Transcript and audio run.
   Chat depends on ticket 01. Crowd depends on ticket 03. The gameplay route
   currently nominates from chat and callouts, so it has never run either —
   which means visually-driven match highlights across games are effectively
   undetected today, and the destination explicitly includes them.
2. **What dies?** Candidates for deletion, with evidence:
   - zero importers: `lib/auto-trim.ts`, `lib/humor-patterns.ts`, `lib/viral-weights.ts`
   - reachable only from the prefilter that ticket 06 may retire:
     `lib/scene-segmenter.ts`, `lib/scene-scorer.ts`, `lib/llm-humor-scorer.ts`,
     `lib/enhanced-scorer.ts`
   - the reassessment's archive list: public-reference nearest-neighbour and
     logistic rankers, the video-embedding taste ranker, the autonomous outcome
     learner, the old full-transcript GPT-5.5 path, and the gameplay
     chat-keyword prototype as a final gate.

   Deleting these is the single largest simplification available. The risk is
   deleting the only producer of a route we decide to keep, so this ticket
   resolves after 06, not before.
3. **Does `analyze.ts` get repaired or retired?** It owns the broken prefilter
   *and* is the only producer of `scorer`-route candidates. It cannot be both.
4. **How do routes combine?** `lib/recall-union.ts` exists and is uncapped by
   design. Confirm it stays the single union point, that no route can cap
   recall, and that route provenance survives into the candidate record — route
   attribution is the only thing that made this table possible.
5. **What is the recall target?** The reassessment proposes Recall@50 ≥ 0.90
   overall with no lane below 0.80. On what corpus is that measured, given
   ticket 05's answer about held-out streams?

## Comments
