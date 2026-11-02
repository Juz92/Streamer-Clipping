# State of Play — 2026-11-02

Audit of the pipeline as it actually stands, ~4 months after
[the 2026-07-14 reassessment](stream-clipper-reassessment-2026-07-14.md).
Everything below is read off code and on-disk job state, not intentions.

## 1. Where the system actually stopped

| Fact | Value | Source |
|---|---|---|
| Jobs ever created | 6 | job numbering |
| Jobs surviving on disk | 4 — `job-002`, `job-004`, `job-005`, `job-006` | `data/clips/` |
| Jobs with a source video still present | 1 (`job-006`, 11.5 GB) | `source/stream.mp4` |
| Last run | 2026-07-16, Palworld w/ Gimmick x Cloakzy, 11.8h, 11.5 GB | `manifest.json` |
| Phase reached | `notebooklm-reviewed` | `manifest.json` |
| Rendered / uploaded | none | no `shorts/`, no `raw-clips/` |
| Last human verdict | all 10 shadow-ranked candidates rejected, "not really funny" | `manual-review-feedback.json` |
| Promotion gate | `WAITING_FOR_LABELS` — 10/12 labels, 2/3 streams | `shadow-scorecard.json` |

The pipeline did not fail noisily. It ran discovery, produced 181 candidates,
asked for a human verdict, got a blanket rejection, and has been parked since.

Funnel on that run: **181 recalled → 143 grounded → 38 blocked → 0 rendered.**

## 2. The five real gaps, ranked

### Gap 1 — Chat is dead, and it was the best humour signal

`manifest.json` has `"chatPath": null` and `"heatmapPath": null`.
`source/` contains `chat.live_chat.json.part` (35 MB) plus a stray
`...-Frag532.part`: the yt-dlp live-chat download **aborted and was never
retried**. `shadow-scorecard.json` confirms the consequence:

```json
"evidence": { "transcript": true, "chat": false, "audio": true, "heatmap": false }
```

Two of the five designed recall routes have never executed on a real stream.
The 2026-07-07 council audit called chat replay "a free *human-labeled humor
detector*" and the project's strongest moat. It is switched off by a download
bug, not by a decision.

**Fix is small:** resume/retry the chat fragment download, assert `chatPath`
non-null in preflight, and fail the job loudly instead of silently degrading.

**Amended 2026-11-02** — see
[research/03-crowd-route.md](../../.scratch/measurable-clip-finder/research/03-crowd-route.md).
Chat and heatmap are not the same kind of problem and should not have been
listed together. Chat is a recoverable download bug, as above. **The heatmap is
not a route at all**, for three independent reasons: YouTube does not serve a
heatmap for long `was_live` archives (0 for 5 VODs across four months, while
control videos return 100 points); if it did, it is always exactly 100 buckets,
which is ~320 s each on a 9-hour VOD — five to ten clips wide, useless as an
anchor; and `lib/heatmap-extractor.ts` returns `null` by construction anyway,
because it regexes the watch page for an SVG the player builds at runtime and
falls back to a key name that is yt-dlp's own output field rather than
anything YouTube emits.

So `manifest.heatmapPath: null` says nothing about YouTube. The module and its
consumers (`discover.ts:170-215`, `gemini-review.ts:291-303`, the 0–15
`scoreHeatmapBonus`) are dead weight. The genuine crowd signal on YouTube is
the `live_chat` track that ships with every VOD, which `chat-parser.ts` already
bins at 10 s — 32x finer than a heatmap bucket would be.

### Gap 2 — Recall is effectively single-route, so taste rejection teaches nothing

Route attribution for the 181 candidates:

| Route | Count |
|---|---:|
| `semantic:humor` | 133 |
| `semantic:emotional-peaks` | 25 |
| `audio-peak` | 19 |
| `scorer` | 19 |
| `transcript-signal` | 14 |
| `semantic:friend-roasts` | 8 |
| crowd / Twitch-clip route | 0 |
| chat-reaction route | 0 |

73% of candidates came from one prompt. When Justin rejects all 10 finalists,
the information content is "that prompt's taste is wrong" — it cannot
distinguish a bad ranker from a stream that genuinely had nothing. The
reassessment's multi-route union exists in `recall-union.ts` but is fed by
one live route.

**Amended 2026-11-02** — the crowd route's zero was **void evidence, not a
failure**. `RecallSource` at `recall-union.ts:11` declares `"twitch-clip"`, and
a repo-wide grep for it returns that one line and nothing else: no harvester,
no fetch, no writer. The route was never built, so it could not have run.

And it is far cheaper than the reassessment assumed. The Burnt Peanut
**simulcasts**: across seven matched stream pairs, Twitch VOD start versus
YouTube `release_timestamp` diverged by 0, 0, +1, −2, +3 and +9 seconds. One
encoder, two destinations. So the feared Twitch→YouTube alignment step is a
subtraction of two integers under ten seconds apart.

It also needs no Twitch token and no `vod_offset`: `yt-dlp`'s clips extractor
exposes a clip's `createdAt` as `timestamp`, so
`anchor = clip.timestamp − vod.release_timestamp`. That form does not expire
with the VOD, so it works retroactively across the whole clip archive — which
matters, because his Twitch archive measured exactly 60 days (52 broadcasts).
Verified live on one stream: 3 of 3 anchors landed in the right VOD and 2 of 3
on the moment, sitting a few tens of seconds *after* content start because
clippers press late.

Two traps recorded: titles differ between platforms, so match on timestamp and
never on title; and Twitch sometimes merges several YouTube broadcasts into one
14–18 hour VOD, so match by interval containment.

Separately useful: Twitch VODs carry **per-game chapters with real second
boundaries** while the YouTube sidecars record `chapters: null`. Those chapters
transfer onto the YouTube timeline by the same ≤9 s offset, which means
discovery *can* hand a per-segment game hint downstream — directly relevant to
the stale per-game layout constants in Gap 4.

### Gap 3 — 60s hard gate and duration-first trimming still delete the arc

- `quality-gates.ts:37` rejects any rendered short with `durationSec > 60`.
- `trim.ts:707` still assigns archetype duration targets (15–25s skill,
  22–32s roast, 25–35s story payoff, 18–30s general) and trims from the
  *setup* side to protect the punchline.

The project's own `hit-examples.json` — six clips, 5.0M–10.0M views — has
durations 24, 25, 26, 35, 42 and **69** seconds. One of six proven winners
would be rejected by the current gate. YouTube has classified qualifying
vertical uploads up to three minutes as Shorts since 2025, so 60s is a
self-imposed limit that contradicts the measured evidence.

### Gap 4 — Packaging copies the worst-performing competitor

Pulled 40 Shorts from each reference channel, 2026-11-02:

| Channel | Median views | Max | Title style |
|---|---:|---:|---|
| **@TheBurntPeanutShorts** | **244,000** | 1.7M | Title Case + trailing `...` cliffhanger (38/40) |
| @TheDailyBungulator | 48,000 | 2.3M | Sentence case, one SCREAMING word, hashtags inline |
| @BurntPeanut_Daily | 18,000 | 648K | ALL CAPS (38/40), no ellipsis |

The consistent winner by median is the **Title Case + unresolved-ellipsis
cliffhanger** form, at 13.5x the ALL-CAPS channel's median. Bungulator owns the
single biggest hit but is 5x less consistent.

Meanwhile this repo's CLAUDE.md "Approved Visual Style" specifies an ALL-CAPS
Impact yellow hook overlay, and `generate-metadata.ts` has no cliffhanger
title archetype. We are reproducing the aesthetic of the 18K-median channel.

Also stale: CLAUDE.md documents avatar crops for Halo, Apex, CS2 and Rust.
Current streams are Arc Raiders, Gears of War E-Day, Wardogs, CoD, AoE2,
Palworld and Tarkov. Every per-game layout constant is for a game he has
stopped playing.

### Gap 5 — Two model generations stale, plus ~1.3k LOC of dead code

Models referenced in `packages/clips/src`: `gemini-3.5-flash`, `gpt-5.5`,
`claude-haiku-4-5`, `claude-3-haiku-20240307`, `gpt-4o-mini`, `gpt-oss-120b`,
and Whisper `base.en` (the smallest English model).

Dead modules — zero importers: `lib/auto-trim.ts`, `lib/humor-patterns.ts`,
`lib/viral-weights.ts`. Reachable only from `analyze.ts`, whose top-20 scene
prefilter the reassessment identified as the recall killer:
`lib/scene-segmenter.ts`, `lib/scene-scorer.ts`, `lib/llm-humor-scorer.ts`,
`lib/enhanced-scorer.ts`.

There are 30 test files in `packages/clips/test/` and **no `test` script in any
package.json**. Nothing runs them.

## 3. What is genuinely good — do not rebuild

- **`training/official-shorts/source-vod-alignments.json`** now aligns 4
  official Shorts to source VODs with start/end seconds and coverage. The
  reassessment recorded 1. This is the seed of the supervised source-discovery
  dataset the project has always lacked, and it is the highest-value asset on
  disk.
- **The V2 spine landed**: `lib/candidate-contract.ts` (one `jobId:momentId`
  identity), `lib/recall-union.ts`, `lib/arc-grounding.ts`, `grounded-rank.ts`.
  The `moment-1` vs `nlm-001` split the reassessment called out is closed.
- **`shadow-scorecard.ts`** is an honest measured gate that refused to promote
  on insufficient labels. That is the system working correctly.
- **Rendering, captions, thumbnails, upload, review packaging** all work. The
  bottleneck is upstream of them.

## 4. What the newer models change

Three of the reassessment's constraints were model limitations that no longer
bind:

1. **The top-20 prefilter existed because long context was expensive.** A
   11.8h VOD's full word-level transcript is ~700 KB (`transcript_clean.txt`).
   That now fits in one context window per lane prompt, so recall no longer
   has to be throttled by a hand-written scene scorer before the good model
   sees anything.
2. ~~**"LLMs can't hear tone" is obsolete.** Native audio-input models hear
   laughter, timing and sarcasm directly from the clip audio. That removes the
   need for a separate YAMNet/laughter-detection pipeline *and* attacks the
   humour gap head-on, which is the one gap every prior audit named as fatal.~~

   **Corrected 2026-11-02, same day, by measurement** — see
   [research/02-audio-models.md](../../.scratch/measurable-clip-finder/research/02-audio-models.md).
   Half of this was wrong. Audio models *classify* laughter almost perfectly
   (Qwen2-Audio: 0.982 F1 on "is there laughter") and *localise* it terribly
   (the same model: **0.028** on "where"). Temporal audio grounding is now
   benchmarked across 21 systems: the best scores 31.2 mIoU, and Gemini-3.1-Pro
   drops to 7.2–12.9 mIoU on 17-minute audio. Our input is 11.8 hours.

   So the YAMNet-style local model the 2026-07-07 council recommended is now
   *better* evidenced, not obsolete: a trained temporal head over audio
   embeddings (AST+GRU) reaches 41.79 mAP on 2-hour sports video, beating
   vision-only and every prior audio-visual method. What survives of my claim
   is narrow and still useful: audio is the cheapest recall route available
   ($0.41 for one pass over this VOD), provided it nominates candidate
   *regions* and never boundaries.
3. **Structured outputs replace regex parsing.** `lib/notebooklm-parser.ts` is
   24 KB of free-text regex parsing. Schema-constrained output deletes most of it.

What has *not* changed: a better model does not supply labelled boundary data.
The gold corpus is still the gate, and it is still at 10 labels across 2 streams.

## 5. The honest summary

The engineering is further along than the strategy. The V2 data contract
landed, the measured gate works, the renderer works. The system is stalled on
three unglamorous things:

1. a **failed chat download** that silenced its best signal;
2. **one working recall route** instead of five, so human rejection is
   uninformative;
3. **10 labels** where the gate needs 12 across 3 streams.

None of those is a model problem. The model upgrade makes items 1 and 2 cheaper
to fix and finally gives a credible attack on humour detection, but the project
is two unblocked chores and one labelling session away from being measurable
again.
