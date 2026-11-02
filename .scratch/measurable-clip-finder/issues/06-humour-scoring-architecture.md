# What is the humour scoring architecture?

Label: `wayfinder:grilling`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: [01 — Recover the chat replay route](01-recover-chat-replay.md)
Was also blocked by: [02](02-audio-native-humour-models.md) — closed 2026-11-02

## Amendment, 2026-11-02 — ticket 02's answer settles question 1

Question 1 below asks whether audio becomes the primary humour evidence or a
second opinion, and warns against the heuristic `detectLaughBurst` being
"strictly dominated" by an audio model. **That framing is now wrong and should
not be re-litigated.**

Measured: audio models classify laughter at 0.982 F1 and localise it at 0.028
(same model). Temporal audio grounding falls to 7.2–12.9 mIoU on 17-minute
audio; our input is 11.8 hours. So an audio model cannot produce a boundary, and
cannot be the thing that *finds* the arc.

What this ticket still has to decide, with that constraint fixed:

- audio nominates candidate **regions** as one recall route among several, at
  $0.41 per VOD pass — settled, cheap, do it;
- whether the humour *score* comes from a small trained temporal head over
  audio embeddings (AST+GRU reached 41.79 mAP on 2-hour sports video, beating
  vision-only and all prior audio-visual methods) — this is the live question,
  and it is gated on labels from
  [10 — Run the three labelling sessions](10-run-labelling-sessions.md);
- how that interacts with chat reaction once ticket 01 lands.

Question 2 (arc gate before taste gate) is **unaffected and still open**: the
measurement makes it more important, not less, since nothing in the audio path
can be trusted to bound a clip.

Also carried forward: any prior Gemini audio experiment in this repo that did
not set Vertex's `audioTimestamp` flag was measuring a misconfigured model.
Treat those results as void rather than as evidence against audio.

## Question

This is the centre of the map. Everything else is instrumentation around it.

The project has never had a working humour detector. Nine approaches were
measured and tabulated in the reassessment; the best of them reached AUC 0.683
and put 2 of 6 known winners in its top five, and two scored *worse than
random* (TF-IDF logistic at AUC 0.233, video embeddings at 0.375). The stated
reason is structural: humour lives in tone, timing and the group's reaction,
and a transcript contains none of those.

Two things have changed since that table was written. Chat data will exist
(ticket 01). Models now take audio natively (ticket 02). Decide what to build
on that:

1. **Does audio become the primary humour evidence, or a second opinion?**
   If an audio-native model hears the laugh, chat-emote density and the audio
   spike detector in `lib/audio-analyzer.ts` may both become redundant — it
   already has a heuristic `detectLaughBurst` at line 163 that an audio model
   would strictly dominate. Or audio ranks and chat confirms. Pick one shape;
   do not run three and blend them, which is how the project arrived at ten
   overlapping scorers.
2. **Where in the cascade does humour scoring sit?** The reassessment is firm
   that the arc gate comes *before* the taste gate: a candidate must have a
   complete, legible setup → escalation → payoff → reaction before anyone asks
   whether it is funny. Does audio-native scoring respect that ordering, or
   does hearing the laugh become the thing that *finds* the arc? These give
   very different pipelines.
3. **Are the three ranking axes still separate?** The reassessment forbids
   collapsing editorial strength, Justin's taste, and market prior into one
   undocumented viral score. Audio evidence makes editorial strength much
   cheaper to measure. Confirm the three stay separate and say which one audio
   feeds.
4. **What replaces the prefilter?** `analyze.ts` hands the LLM pass only the
   top 20 scenes from a hand-written scene scorer — the known recall killer. If
   long context now takes the full transcript, and audio can be processed in
   bounded windows, the prefilter has no reason to exist. What does the
   discovery stage look like without it?
5. **What is the kill criterion?** Every previous humour attempt was kept alive
   past the point of usefulness. Name, before building, the measurement that
   retires this approach — and the baseline it has to beat, which is the
   existing editorial ranker on held-out streams.

Dead ends not to re-walk, all documented in the reassessment §3: fine-tuning a
general video model; raw chat volume as a quality score (duration alone scored
AUC 0.917 on the same set, so the chat result was duration in disguise);
learning from public view counts without controlling for channel and packaging;
and any taste model trained on the current label count.

## Comments
