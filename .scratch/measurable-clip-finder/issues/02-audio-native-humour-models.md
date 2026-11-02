# What can current models actually do with long audio and timestamps?

Label: `wayfinder:research`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

Findings: [research/02-audio-models.md](../research/02-audio-models.md).

**Audio-native models cannot produce the cut. They can afford to propose where
to look.**

The decisive question was whether these models return usable timestamps. They
do not, and this is now measured rather than assumed. TAG-Bench
(arXiv 2609.01542) benchmarks temporal audio grounding over 21 systems, 1,750
human-verified pairs, 149.5 h: best system 31.2 mIoU / 21.5% R@IoU0.7; best
proprietary (Gemini-3.1-Pro) 26.4 mIoU / 13.7%. On its two long subsets
(~17 min average) Gemini-3.1-Pro falls to **12.9 and 7.2 mIoU**. No model
exceeds 13.2% accuracy at counting how many times an event occurred — every one
under-reports, which directly threatens the uncapped-recall preference.

The classify/localise split is the finding to carry forward. Qwen2-Audio scores
**0.982 F1** on "is there laughter" and **0.028** on "where is it". Gemini 3
Flash does markedly better at laughter localisation (0.542 / 0.393 / 0.579
P@IoU0.5, MTLLFM arXiv 2605.25409) but only on 5-second windows with the model
told what to look for — not a 12-hour search.

Consequences:

- **"Ask an audio model when it was funny" is the end-to-end multimodal VOD
  scan the 2026-07-14 reassessment already rejected** for weak timestamp
  precision. The 2026 literature vindicates that rejection with numbers. Do not
  reopen it.
- **The 2026-07-07 council's local-model answer is now the better-evidenced
  option.** A trained temporal head over audio embeddings (AST+GRU) reaches
  41.79 mAP on 2-hour sports video, beating vision-only (37.99) and every prior
  audio-visual method (37.77). The gain came from the temporal head, not from
  audio understanding. It needs labels, which is why
  [10 — Run the three labelling sessions](10-run-labelling-sessions.md) gates it.
- **Cost is not a constraint, and never was.** One audio pass over 11.8 h:
  **$0.41** (Gemini 3.5 Flash-Lite), 2 requests. The council's ~$1.40 low-res
  video estimate re-checks correct at $1.27. Forty-one cents buys a measured
  answer.
- **Claude is out** — it accepts no audio at all. OpenAI `gpt-audio-1.5` is out
  on a 128k context. Gemini is the only practical long-audio vendor: 9.5 h per
  prompt, though `gemini-3.5-transcribe` collapses to 30 min when word
  timestamps are enabled, and its own docs warn word timestamps "degrade
  transcription accuracy".
- **Structured output is confirmed** and would let `lib/notebooklm-parser.ts`
  (24 KB of regex) be deleted — but Gemini's docs promise only syntactically
  valid JSON and tell you to validate values. Syntax, not truth.
- **Both of the reassessment's cited papers stand.** TimeLens has a successor
  (TimeLens2, arXiv 2607.17423, SOTA on 7 benchmarks) but its benchmarks average
  30–150 s per video, so the reassessment's judgement — "a possible later
  localiser" — is unchanged.

**One gotcha that voids prior work.** Vertex requires an `audioTimestamp` flag
in `GenerationConfig` to enable timestamp understanding for audio-only files,
and this is **not documented on ai.google.dev's audio page at all**. Any earlier
Gemini audio experiment in this repo that omitted it was measuring a
misconfigured model; treat those results as void.

**Known limits of this answer, flagged by the researching agent:** there is *no
published temporal-grounding measurement on audio longer than 30 minutes
anywhere*, and our input is 23x that. The curve is falling steeply at 17
minutes, so "it will not work at VOD scale" is a strong inference from a trend,
not a measurement. Separately, *no model has been benchmarked on genuine versus
polite versus panic laughter* — question 3's fine-grained half is simply
unanswered by the literature, and the reference analysis says the useful
reaction tail is only 1–4 seconds, so that distinction matters. Several
secondary figures in the findings file come from abstracts rather than full
PDFs and are labelled as such.

## Question

Every prior audit named the same fatal gap: the system reads words, so it
cannot hear that something was funny. The 2026-07-07 council audit's answer was
a local laughter-detection model (jrgillick, YAMNet) plus chat emote density.
That answer predates models that take audio natively.

Establish, from primary sources, what is true now:

1. **Which generally-available models accept audio directly**, and what are
   the real limits — maximum audio duration per request, whether a 10–12 hour
   VOD must be chunked, and cost per hour of audio.
2. **Can they return usable timestamps?** This is the decisive question. A
   model that says "this was funny" without a defensible start/end is useless
   to a pipeline whose output is a cut. Find what temporal precision is
   actually documented or benchmarked, not claimed.
3. **Can they distinguish laughter quality** — a genuine group laugh versus a
   polite one versus a scream of panic? The reference corpus analysis found the
   useful reaction tail is only 1–4 seconds after the payoff, so this is a
   fine-grained judgement.
4. **Does structured output remove the parsing layer?** `lib/notebooklm-parser.ts`
   is 24 KB of regex over free text. Confirm whether schema-constrained output
   is available on the candidate models and would replace it.
5. **What does an audio pass over one 11.8h VOD cost**, end to end, at current
   prices? The council audit grounded a full low-res video pass at roughly
   $1.40 and concluded budget was not the constraint. Re-check that.

Also check whether anything has displaced the two papers the reassessment
leaned on (arXiv 1807.09715 on multi-view stream highlights, arXiv 2505.07721
on gameplay highlight generation) and whether TimeLens or a successor is now a
credible off-the-shelf temporal localiser.

Write findings to `.scratch/measurable-clip-finder/research/02-audio-models.md`.
Cite primary sources — vendor docs and papers, not blog summaries. Where a
capability is claimed but unbenchmarked, say so; this ticket exists because the
last four months of this project were spent on plausible-sounding rankers that
measured worse than random.

## Comments
