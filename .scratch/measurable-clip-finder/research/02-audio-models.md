# Research: what current models can actually do with long audio and timestamps

Resolves: [issues/02-audio-native-humour-models.md](../issues/02-audio-native-humour-models.md)
Date: 2026-11-02
Method: primary sources only — vendor API docs, model cards, arXiv papers, CVPR
proceedings. No blog roundups. Every number below is attributed; every capability
that is claimed but not benchmarked is labelled **CLAIMED, UNBENCHMARKED**.

---

## Headline

Audio-native models are real, cheap and will happily ingest most of an 11.8-hour
VOD. **They cannot return usable timestamps.** The only published benchmark of
temporal audio grounding in audio LLMs puts the best of 21 systems at 31.2 mIoU,
and the best proprietary model (Gemini-3.1-Pro) at 26.4 mIoU — falling to
**12.9 and 7.2 mIoU on its two 17-minute subsets**. Audio input is 25x cheaper
than the project assumed; temporal precision is roughly 4x worse than the
≤2s boundary target implies. Cost was never the constraint and still isn't.
Localisation is.

---

## 1. Which generally-available models accept audio directly, and the real limits

### Google Gemini — the only vendor where long audio is practical

| Limit | Value | Source |
|---|---|---|
| Max audio per prompt | **9.5 hours** | [ai.google.dev audio guide](https://ai.google.dev/gemini-api/docs/audio) |
| Max audio per prompt (Vertex wording) | **~8.4 hours, or up to 1 million tokens** | [Vertex audio understanding](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/audio-understanding) |
| Audio token rate | **32 tokens per second** (1 min = 1,920 tokens) | ai.google.dev audio guide |
| Files per prompt | **one audio file per prompt** | Vertex audio understanding |
| Inline request cap | **20 MB total** including prompt and files; use Files API above that | ai.google.dev audio guide |
| Formats | 13 MIME types incl. wav, mp3, flac, m4a, opus, webm | ai.google.dev audio guide |

The two published maxima disagree (9.5 h vs ~8.4 h). The Vertex figure is the
one that reconciles with the token rate: 1,000,000 ÷ 32 = 31,250 s = **8.68 h**.
Treat 8.4 h as the real ceiling and 9.5 h as marketing rounding.

**Consequence for an 11.8 h VOD: it must be chunked, but only into 2 pieces.**
11.8 h × 3600 × 32 = **1,359,360 audio tokens**, against a 1M-token window.
This is the one genuinely new fact since July: a whole-stream audio pass is
within one order of magnitude of a single request. It was not before.

**Google's dedicated transcription model is far more restricted.**
[`gemini-3.5-transcribe`](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe):

- "Up to 1 hour per request (**up to 30 minutes when speaker diarization or
  word-level timestamps are enabled**)."
- Diarization up to 8 speakers; "attribution for 3+ speakers is experimental."
- Diarization and word-level timestamps are **mutually exclusive with custom
  vocabulary**.
- The doc states word-level timestamps "**Degrade transcription accuracy**."

So the word-timestamp path costs 24 requests per VOD and trades text accuracy
for timing — the inverse of the trade CLAUDE.md already settled on for captions
(whisper for timing, accept bad text). It is a caption tool, not a finder.

### OpenAI — ruled out by context, not by capability

[`gpt-audio-1.5`](https://developers.openai.com/api/docs/models/gpt-audio-1.5)
(listed as the default audio model) and
[`gpt-audio`](https://developers.openai.com/api/docs/models/gpt-audio):

- **128,000 token context window**, 16,384 max output tokens.
- Audio tokens: **$32.00 / 1M input, $64.00 / 1M output**.
- Knowledge cutoff Sep 30 2024. Listed supported features: streaming and
  function calling. **Structured outputs is not listed.**
- **No maximum audio duration is documented anywhere I could find.** The
  [audio guide](https://developers.openai.com/api/docs/guides/audio) and the
  [Chat Completions audio guide](https://developers.openai.com/api/docs/guides/audio-chat-completions)
  state neither a duration cap, nor a file-size cap, nor an audio tokenisation
  rate, nor timestamp support. **UNDOCUMENTED** — do not assume.

The 128k context is disqualifying regardless of the token rate. Even at an
optimistic 10 tokens/s it caps a request at ~3.5 h; at Gemini's 32 tokens/s it
caps at ~67 minutes. Combined with $32/1M audio input (**32–107x Gemini's audio
rate**), OpenAI is not a candidate for VOD-scale work.

### Anthropic Claude — no audio input at all

The [Files API](https://docs.claude.com/en/docs/build-with-claude/files)
file-type table lists PDF, plain text and images only. The
[OpenAI SDK compatibility page](https://docs.claude.com/en/api/openai-sdk)
states audio input is not supported and is **ignored and stripped** from input.
`claude-haiku-4-5` cannot hear anything. Any Claude role in this pipeline stays
text-only.

### Open / API-hosted omni models

- **Qwen3-Omni** ([tech report 2509.17765](https://arxiv.org/abs/2509.17765)):
  handles audio "up to 40 minutes per instance" for ASR and SLU.
- **Qwen3.5-Omni** ([tech report 2604.15804](https://arxiv.org/html/2604.15804v1)):
  claims "**over 10 hours of audio understanding**", 256k context, AuT encoder at
  a **6.25 Hz token rate** (~160 ms per frame — 5x coarser than Gemini's 32/s).
  It says it inserts "timestamps at random intervals" during training.
  **It reports no temporal grounding benchmark of any kind.** CLAIMED,
  UNBENCHMARKED. The report also says it "scales to hundreds of billions of
  parameters", names Plus and Flash variants, and states it is "publicly
  accessible via API" — it does **not** say weights are released. Treat it as a
  closed API, not a local model.

---

## 2. Can they return usable timestamps? — No. This is the decisive finding.

### TAG-Bench (the direct answer)

[**TAG-Bench: Benchmarking Temporal Audio Grounding in Large Audio Language
Models**, arXiv 2609.01542](https://arxiv.org/html/2609.01542v2) — 1,750
human-verified query/recording pairs, 149.5 hours, 21 systems, durations from
7 s to 20 min. This is exactly the question the ticket asks, measured.

Selected results (%, Table 2):

| Model | mIoU | R@0.3 | R@0.5 | R@0.7 |
|---|---:|---:|---:|---:|
| FireRedAudio (best overall) | **31.2** | 39.7 | 30.8 | **21.5** |
| MOSS-Audio-8B-Thinking | 29.6 | 38.6 | 25.5 | 18.2 |
| MOSS-Audio-4B-Thinking | 27.8 | 36.3 | 24.1 | 16.2 |
| **Gemini-3.1-Pro** | **26.4** | 35.6 | 24.0 | **13.7** |
| LAT-Audio (temporal expert) | 19.7 | 27.0 | 16.2 | 8.3 |
| TimeAudio (temporal expert) | 12.4 | 13.7 | 6.9 | 3.1 |
| Audio Flamingo 3 | 8.7 | 12.1 | 5.9 | 2.0 |
| Kimi-Audio-7B | 1.4 | 1.4 | 0.5 | 0.2 |

Read `R@0.7` as "the fraction of queries where the returned interval overlaps
the truth by 70% or more" — the loosest possible proxy for a cut you could
actually render. **Gemini-3.1-Pro: 13.7%.** Best system in the world: 21.5%.

Duration is the killer. On the benchmark's two long subsets (17.3 min and
17.5 min average):

- FireRedAudio: 20.6 and 21.7 mIoU
- **Gemini-3.1-Pro: 12.9 and 7.2 mIoU**
- MOSS-Audio-8B-Thinking, which reaches ~51.9 mIoU on short acoustic subsets,
  collapses to **4.8 and 4.1**

The paper's own section heading: "Temporal grounding remains far from solved."
And on finding *all* instances — the recall problem this project cares about
most — "No model exceeds **13.2%** one-to-many count accuracy." Every model
under-reports how many times an event occurred.

Caveat the authors themselves raise, and I'll repeat it: the long subsets differ
in source domain and query distribution, so duration alone is not *proven* to be
the cause of the collapse. But the direction is unambiguous and consistent
across the other papers below.

Note the benchmark's longest audio is **20 minutes**. Our VOD is **35x** that.
Nobody has measured what happens at 11.8 hours. The honest statement is: the
curve is falling steeply at 17 minutes and no one has published a data point
anywhere near our input length.

### Corroborating evidence on timestamp drift

- [**LAT-Bench / "Listening with Time"**, arXiv 2604.22245](https://arxiv.org/pdf/2604.22245)
  — described as the first human-verified benchmark supporting audio up to
  **30 minutes**, covering dense captioning, temporal grounding and temporal
  classification. It attributes failures to **temporal hallucination and
  timestamp drift, both of which worsen with audio duration**. (Read from the
  paper's abstract/intro, not the full tables.)
- [**MusTBench**, arXiv 2605.29300](https://arxiv.org/html/2605.29300v2) — music
  domain, but the shape is instructive: accuracy is best when the true timestamp
  falls around **10–30 seconds** into the file and decreases both earlier and
  later. Positional bias, not understanding.
- [**GigaChat Audio**, arXiv 2607.10387](https://arxiv.org/pdf/2607.10387) — a
  purpose-built time-aware model answering with explicit timestamps over up to
  120 minutes. Its own comparison table puts **Qwen3-Omni-30B at 27.3 mIoU** on
  temporal grounding, consistent with TAG-Bench.
- [**SpotSound**, arXiv 2604.13023](https://arxiv.org/html/2604.13023v1) and
  [**Tempo**, arXiv 2608.29999](https://arxiv.org/html/2608.29999) — further
  evidence that fine-grained temporal perception needs purpose-built training;
  Tempo reports baseline tempo accuracy of **18.0% for Audio Flamingo 3** and
  **40.3% for Qwen3-Omni**.

### What the vendor docs do and don't promise

Google's audio and video docs explain *how to ask* for `MM:SS` timestamps and
nothing more. The [audio guide](https://ai.google.dev/gemini-api/docs/audio)
shows a diarisation prompt requesting "accurate timestamps for each segment
(Format: MM:SS)" — that is a prompt instruction, **not a capability claim**.
Neither the audio guide nor the
[video guide](https://ai.google.dev/gemini-api/docs/video-understanding) makes
any statement about timestamp accuracy.

Two concrete API facts worth carrying forward:

- **`audioTimestamp` must be explicitly enabled for audio-only files.** Vertex:
  "To enable timestamp understanding for audio-only files, enable the
  `audioTimestamp` parameter in `GenerationConfig`", and in its Limitations:
  "To accurately generate timestamps for audio-only files, you must configure
  the `audio_timestamp` parameter." This is not mentioned on the ai.google.dev
  audio page at all. Any prior experiment that passed audio without it was
  measuring a misconfigured model.
- **Video gets per-second timestamps for free**; audio does not. Video guide:
  "Timestamps are added every second" in static mode.

### Is TimeLens or a successor a credible off-the-shelf localiser?

Partly — for **video with a text query**, not for audio and not for "find the
funny bits".

- [**TimeLens** (CVPR 2026)](https://openaccess.thecvf.com/content/CVPR2026/papers/Zhang_TimeLens_Rethinking_Video_Temporal_Grounding_with_Multimodal_LLMs_CVPR_2026_paper.pdf),
  [code](https://github.com/TencentARC/TimeLens) — its contribution is *data
  quality* (TimeLens-Bench re-annotation, TimeLens-100K training set). Reported
  8B scores: **55.2 mIoU on Charades-TimeLens, 65.5 on QVHighlights-TimeLens**,
  beating GPT-5 and Gemini-2.5-Flash.
- [**TimeLens2**, arXiv 2607.17423](https://arxiv.org/abs/2607.17423) (19 Jul
  2026) — generalist VTG at 2B/4B/8B, multi-span supervision over a 93K dataset,
  temporal Wasserstein + temporal IoU RL rewards. Reports **mIoU gains of 14.2 /
  13.0 / 18.1 points** over its Qwen3-VL backbones, SOTA on 7 benchmarks, and a
  qualitative 93.7-minute example retrieving an event near 4,750 s.

So: the successor exists, it is public, and it is the strongest published
temporal localiser. **But** Charades averages ~30 s and QVHighlights ~150 s per
video. 55–65 mIoU on 30-second clips is a different claim from anything useful
on a 42,480-second VOD, and the 93.7-minute result is one qualitative figure,
not a benchmark. The reassessment's judgement — "a possible later localiser,
not a substitute for a BurntPeanut-labelled corpus" — survives intact, and
TimeLens's own thesis (**the contribution was better annotations, not a better
model**) is the same lesson this project keeps relearning.

---

## 3. Can they distinguish laughter quality?

**Detection: yes. Localisation: barely. Genuine-vs-polite: nobody has measured
it, in any paper I could find.**

The only paper that benchmarks a frontier model on laughter *localisation* is
[**MTLLFM: Multimodal-Temporal Laughter Localization**, arXiv
2605.25409](https://arxiv.org/html/2605.25409). It introduces UR-FUNNY-Temporal
(10,166 videos / 72.9 h / 3,385 laughter events) and SMILE-Temporal
(887 videos / 5.9 h / 1,560 events), plus an unreleased broadcast set
("SportsPress", withheld for rights reasons).

Table 2 — classification F1 / Precision@IoU=0.5 / mean IoU:

| Method | SportsPress | UR-FUNNY | SMILE |
|---|---|---|---|
| Qwen2-Audio-7B (audio only) | 0.982 / **0.028** / 0.059 | 0.466 / 0.137 / 0.172 | 0.335 / 0.138 / 0.204 |
| Qwen2.5-Omni-7B (A+V) | 0.997 / 0.208 / 0.301 | 0.773 / 0.218 / 0.267 | 0.783 / 0.315 / 0.361 |
| **Gemini 3 Flash** | 0.885 / **0.542** / 0.546 | 0.775 / **0.393** / 0.405 | 0.724 / **0.579** / 0.540 |
| MTLLFM (purpose-built) | 0.990 / 0.681 / 0.580 | 0.849 / 0.497 / 0.466 | 0.803 / 0.567 / 0.511 |

Three things matter here.

1. **The classify/localise gap is enormous.** Qwen2-Audio scores 0.982 F1 on
   "is there laughter in this clip" and **0.028** on "where". A detector that
   knows laughter happened but not when is precisely the tool this pipeline
   cannot use.
2. **Gemini 3 Flash is genuinely competitive at laughter localisation** —
   0.542/0.393/0.579 P@IoU0.5, beating the purpose-built model on SMILE
   localisation (57.9% vs 56.7%), which the authors flag as "an interesting
   boundary case". This is the single most encouraging number in this document.
   But note the task: clip-level labels over **5-second segments**, with the
   model told to look for laughter. That is not "scan 11.8 h and tell me what's
   funny".
3. **Audio alone carries most of it.** MTLLFM ablation on SportsPress:
   audio-only F1 0.979 / P@0.5 0.604 / IoU 0.552; vision-only 0.675 / 0.257 /
   0.322; both 0.990 / 0.681 / 0.580. Vision adds ~8% relative on localisation.
   So the modality choice is defensible — audio is where the laugh lives.

**On laughter *quality*:** MTLLFM's annotations distinguish speaker vs audience
laughter and chuckle vs full laughter, and label modality dominance. They
explicitly **do not** distinguish genuine from polite. I found no benchmark
testing whether an audio LLM separates a genuine group laugh from a polite one
or from a scream of panic. [SMILE-Next, arXiv
2605.28084](https://arxiv.org/html/2605.28084v1) teaches LLMs to "detect,
classify and reason about" laughter and reports Qwen2.5-Omni-7B around 0.84 on
laughter detection with "much weaker results on the reasoning metrics" — which
is the closest thing to an answer and it is a negative one. **The ticket's
question 3 is UNANSWERED by the literature.** Given the 1–4 second reaction tail
the reference corpus analysis found, assuming this capability would be exactly
the kind of plausible inference that cost this project four months.

And the one vendor statement on the subject is a warning, not a promise. Vertex
Limitations: "**The models that support audio might make mistakes recognizing
sound that's not speech.**"

### What *does* work on long-form audio: a trained temporal model

Worth recording because it is the strongest positive result I found and it is
not an LLM. [**Audio for Sports Highlight Detection: A Comparative Empirical
Study**, arXiv 2609.17923](https://arxiv.org/html/2609.17923), on SV-Highlights
(320 videos, 8 sports, **~2 hours average each**):

| Model | Input | mAP | Hit@1 | IoU |
|---|---|---:|---:|---:|
| Audio (MLP, clip-independent) | A | 33.55 | 76.96 | 22.68 |
| **Audio (GRU, temporal)** | A | **41.79** | **86.90** | **27.49** |
| Vision (GRU) | V | 37.99 | 79.57 | 25.48 |
| Fusion (GRU) | V+A | **46.92** | 91.09 | **30.67** |
| TR-DETR (best prior audio-visual) | V+A | 37.77 | 74.36 | 25.63 |
| QD-DETR | V+A | 35.42 | 58.62 | 24.25 |

Features: frozen **Audio Spectrogram Transformer** over non-overlapping 2-second
clips; frozen CLIP for vision. Authors' conclusion: audio "should be treated as
a primary signal rather than merely an auxiliary cue."

Note what produced those numbers: *frame-level embeddings plus a small trained
temporal head, with labels*. Not a prompt. The audio-only GRU (41.79 mAP) beats
every prior audio-visual method, and beats the clip-independent MLP on the same
features by 8 points — **the temporal model, not the audio understanding, is
what earned the gain**. Also note the splits are self-constructed (the authors
say SV-Highlights has no official split), so the absolute numbers are soft.

---

## 4. Does structured output remove the parsing layer?

**Yes, and it is worth doing — but it buys syntax, not truth, and it does not
bear on the architecture decision.**

[Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output):

- Configured with `response_format` = `{type: "text", mime_type:
  "application/json", schema: ...}`; SDKs accept Pydantic and Zod directly.
- Supports `enum` on strings and integers, `minimum`/`maximum` on numbers,
  `required`, `prefixItems`, `minItems`/`maxItems`, `anyOf`, and recursive
  `$ref: "#"`. A `{startSec, endSec, confidence, laughterType}` contract maps
  cleanly.
- **Silently stripped and not enforced**: `minLength`, `maxLength`,
  `minProperties`, `maxProperties`, `uniqueItems`, `contains`, `minContains`,
  `maxContains`.
- The doc's own guidance: output is "syntactically correct JSON" but "always
  validate values in your application."
- Overly complex schemas fail with `400 INVALID_ARGUMENT`; named causes include
  large `maxItems` on nested arrays, enums with many values, long runs of
  optional properties, and `anyOf` with many alternatives. Keep the candidate
  schema flat.
- Structured output **combined with tools** is Gemini-3-series only and in
  preview. Not needed here.
- **The docs do not state whether structured output works with audio or video
  inputs.** It is not listed as incompatible either. UNVERIFIED — a 5-minute
  test settles it, and that test should happen before any build.
- For OpenAI's audio models, structured outputs is **not** in the listed feature
  set (streaming and function calling only).

So: `lib/notebooklm-parser.ts` (24 KB of regex) can be deleted on any path that
calls the Gemini API directly with a `response_format` schema, and that deletion
satisfies the map's "prefer deleting a scorer to adding one". **But it is a
separate, smaller win.** A schema guarantees `startSec` is a number; it says
nothing about whether that number is the right second, and §2 says it usually
isn't. Do not let "structured output removes the parsing layer" be read as
evidence for the audio-native path.

---

## 5. What does one audio pass over an 11.8 h VOD cost?

11.8 h = 42,480 s. At Gemini's documented 32 tokens/s: **1,359,360 audio input
tokens**. Prices from the [Gemini API pricing page](https://ai.google.dev/gemini-api/docs/pricing),
standard paid tier, read 2026-11-02. Input only; output for a candidate list is
a few thousand tokens and rounds to nothing.

| Model | Audio input rate | One 11.8 h pass | Notes |
|---|---|---:|---|
| Gemini 3.5 Flash-Lite | $0.30 / 1M (text/image/video/audio) | **$0.41** | cheapest viable |
| Gemini 3.8 Flash | $0.75 / 1M (no separate audio rate listed) | **$1.02** | $1.50/1M from 1 Jan 2027 → $2.04 |
| Gemini 3.1 Flash-Lite | $0.50 / 1M audio | $0.68 | |
| Gemini 3 Flash Preview | $1.00 / 1M audio | $1.36 | |
| Gemini 2.5 Flash | $1.00 / 1M audio | $1.36 | |
| Gemini 3.5 Transcribe | $0.003 / min audio | **$2.12** | but 30 min/request with word timestamps → 24 requests |
| OpenAI gpt-audio-1.5 | $32.00 / 1M audio | **not costable** | token rate undocumented; 128k context disqualifies anyway |

Chunking: **2 requests minimum** for the audio-only path (1.36M tokens against a
1M window). 24 requests if word-level timestamps are needed from
`gemini-3.5-transcribe`.

**Re-checking the council's ~$1.40 low-res video figure.** Video guide: ~100
tokens/s at low (default) media resolution, 3 h max per 1M-context model, audio
within video also 32 tokens/s. 42,480 s × 100 = **4,248,000 video tokens**,
needing **4 chunks** (3 h each).

- At Gemini 3.5 Flash-Lite ($0.30/1M): **$1.27**
- At Gemini 3.8 Flash ($0.75/1M): **$3.19**

So the council's $1.40 was right for the cheapest tier and remains right today.
And audio-only is **~3x cheaper again** ($0.41 vs $1.27) with **half the
chunks**. A custom `fps` (e.g. `fps: 0.5`) and `start_offset`/`end_offset`
clipping are both available in static mode and would cut the video figure
further.

**Conclusion on cost: emphatically not the constraint.** At $0.41 per VOD you
could run an audio pass over every stream the channel has ever produced for the
price of a coffee. Budget has never been the blocker and this re-check makes the
point harder than before. Nothing here should be read as endorsing the audio
pass — only as removing cost from the list of reasons against it.

---

## What this means for the architecture decision

**Audio-native models do not change the picture in the way the ticket hoped,
and they change it in a different way that matters.**

1. **They do not solve the pipeline's output.** The output is a cut. Gemini-3.1-
   Pro returns a defensible interval 13.7% of the time on 7s–20min audio and
   7.2–12.9 mIoU on 17-minute audio. There is no published measurement at
   11.8 hours and the trend line is pointing down. "Ask the model when it was
   funny over the whole VOD" is the end-to-end multimodal scan the reassessment
   already rejected for "weak timestamp precision", and the 2026 literature
   vindicates that rejection with numbers rather than intuition.

2. **They may well solve the pipeline's *input* — the recall route.** The
   genuinely new facts are: (a) a whole-stream audio pass costs $0.41 and 2
   requests; (b) Gemini 3 Flash localises laughter at 0.39–0.58 P@IoU0.5 when
   given short windows and told what to look for; (c) audio-only beats
   vision-only for highlight detection on 2-hour video, and the audio-only GRU
   beats every prior audio-visual method. That combination says: **audio belongs
   as a high-recall anchor generator feeding Stage 2, with boundaries decided
   elsewhere.** Which is where the V2 cascade already puts it.

3. **The local-laughter-model answer from the 2026-07-07 council audit is not
   obsolete — it is now the better-evidenced option.** The two strongest
   localisation results in this document (MTLLFM, and the AST+GRU sports study)
   both come from small trained temporal models over frozen frame-level audio
   embeddings. Neither is an LLM. Both beat every frontier model they compare
   against on the thing we need. jrgillick/YAMNet were the right shape of answer.

4. **But both of those need labels, and the map says we have 6 positives.** The
   standing preference "do not add a taste model to a handful of labels" applies
   with full force here, and the labels problem is not what this ticket set out
   to solve. TimeLens's own finding — that its contribution was the
   re-annotation, not the model — is the third independent source this quarter
   saying the same thing the reassessment said: **high-quality temporal labels
   precede a good model.** Nothing in the 2026 audio literature offers a way
   around that.

5. **What is cheap enough to be worth doing regardless.** A `$0.41`
   `audioTimestamp`-enabled pass that nominates *candidate regions* (not
   boundaries) with a `response_format` schema, scored by the existing
   `shadow-scorecard.ts` veto against the gold corpus. It is a recall route; it
   gets measured like one; it costs less than the electricity to render a clip.
   If it clears the shadow scorecard it earns its place. If it doesn't, we spent
   forty-one cents to find out — which is the cheapest negative result available
   to this project.

6. **Two things to verify before anyone builds.** (a) Whether `response_format`
   actually works alongside audio input — undocumented, 5 minutes to test.
   (b) Whether `audioTimestamp` was set in any prior Gemini audio experiment;
   if not, those results measured a misconfigured model and are void.

**Unknowns I could not close, stated plainly:**

- No published temporal-grounding measurement on audio longer than 30 minutes,
  anywhere. Our input is 23x that.
- No benchmark of genuine vs polite vs panic laughter discrimination, in any
  model, anywhere.
- OpenAI's audio duration limits, audio tokenisation rate, timestamp support and
  structured-output compatibility are all undocumented.
- Qwen3.5-Omni's ">10 hours of audio understanding" is unaccompanied by any
  temporal benchmark and its weight release is unstated.
- Whether `gemini-3.5-flash` / `gemini-3.8-flash` have a separate audio input
  price; the pricing page lists none, so I used the text rate, which may
  overstate or understate.

---

## Sources

Vendor primary documentation:

- Gemini audio understanding — https://ai.google.dev/gemini-api/docs/audio
- Gemini video understanding — https://ai.google.dev/gemini-api/docs/video-understanding
- Gemini structured output — https://ai.google.dev/gemini-api/docs/structured-output
- Gemini API pricing — https://ai.google.dev/gemini-api/docs/pricing
- `gemini-3.5-transcribe` model page — https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
- Gemini audio transcription guide — https://ai.google.dev/gemini-api/docs/transcribe
- Vertex / Gemini Enterprise audio understanding (`audioTimestamp`, limitations) — https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/audio-understanding
- OpenAI `gpt-audio-1.5` model page — https://developers.openai.com/api/docs/models/gpt-audio-1.5
- OpenAI `gpt-audio` model page — https://developers.openai.com/api/docs/models/gpt-audio
- OpenAI `gpt-4o-audio-preview` model page — https://developers.openai.com/api/docs/models/gpt-4o-audio-preview
- OpenAI audio guide — https://developers.openai.com/api/docs/guides/audio
- OpenAI audio in Chat Completions — https://developers.openai.com/api/docs/guides/audio-chat-completions
- Claude Files API (supported file types) — https://docs.claude.com/en/docs/build-with-claude/files
- Claude OpenAI SDK compatibility (audio stripped) — https://docs.claude.com/en/api/openai-sdk

Papers:

- TAG-Bench: Benchmarking Temporal Audio Grounding in LALMs, arXiv 2609.01542 — https://arxiv.org/html/2609.01542v2
- Listening with Time / LAT-Bench, arXiv 2604.22245 — https://arxiv.org/pdf/2604.22245
- MusTBench, arXiv 2605.29300 — https://arxiv.org/html/2605.29300v2
- GigaChat Audio: Time-aware LALM, arXiv 2607.10387 — https://arxiv.org/pdf/2607.10387
- SpotSound, arXiv 2604.13023 — https://arxiv.org/html/2604.13023v1
- Tempo: Temporally-grounded Multi-task Post-training for LALMs, arXiv 2608.29999 — https://arxiv.org/html/2608.29999
- TimeAudio, arXiv 2511.11039 — https://arxiv.org/html/2511.11039v1
- MTLLFM: Multimodal-Temporal Laughter Localization, arXiv 2605.25409 — https://arxiv.org/html/2605.25409
- SMILE-Next: Teaching LLMs to Detect, Classify and Reason about Laughter, arXiv 2605.28084 — https://arxiv.org/html/2605.28084v1
- Audio for Sports Highlight Detection: A Comparative Empirical Study, arXiv 2609.17923 — https://arxiv.org/html/2609.17923
- SVHighlights, arXiv 2606.06926 — https://arxiv.org/html/2606.06926
- TimeLens (CVPR 2026) — https://openaccess.thecvf.com/content/CVPR2026/papers/Zhang_TimeLens_Rethinking_Video_Temporal_Grounding_with_Multimodal_LLMs_CVPR_2026_paper.pdf
- TimeLens code — https://github.com/TencentARC/TimeLens
- TimeLens2: Generalist Video Temporal Grounding, arXiv 2607.17423 — https://arxiv.org/abs/2607.17423
- Qwen3-Omni Technical Report, arXiv 2509.17765 — https://arxiv.org/abs/2509.17765
- Qwen3.5-Omni Technical Report, arXiv 2604.15804 — https://arxiv.org/html/2604.15804v1
- Deep Unsupervised Multi-View Detection of Video Game Stream Highlights, arXiv 1807.09715 (the reassessment's 2018 paper; still the canonical multi-view stream result, no 2026 replacement found) — https://arxiv.org/pdf/1807.09715
- A Multimodal Transformer for Live Streaming Highlight Prediction, arXiv 2407.12002 — https://arxiv.org/abs/2407.12002
- 3M: Multi-modal Multi-task Multi-teacher Learning for Game Event Detection, arXiv 2406.09076 — https://arxiv.org/pdf/2406.09076
- A Survey on Video Temporal Grounding with Multimodal LLMs, arXiv 2508.10922 — https://arxiv.org/pdf/2508.10922

**On the two papers the reassessment leaned on:** arXiv 1807.09715 (multi-view
stream highlights, 2018) has no 2026 replacement I could find — the closest
successors are arXiv 2407.12002 (live streaming highlight prediction, with the
KLive dataset) and arXiv 2406.09076 (3M, which explicitly notes "there remains a
gap in the literature concerning the integration of livestream content and chat
platforms together"). I did not locate work displacing arXiv 2505.07721
(gameplay highlight generation via fine-tuned X-CLIP); the newest adjacent
benchmarks are sports, not gaming (SVHighlights, arXiv 2606.06926). **Both of
the reassessment's citations stand.**
