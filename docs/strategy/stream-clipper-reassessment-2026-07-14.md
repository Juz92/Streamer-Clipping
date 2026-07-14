# Stream Clipper Reassessment — 2026-07-14

## Executive decision

The project has not failed because we have not found the right “virality model.” It has drifted because the system is trying to solve **recall, story understanding, personal taste, boundary selection, rendering, and outcome learning at the same time**, while those stages do not even operate on one canonical candidate set.

The best path is a **cascaded, evidence-first pipeline**:

1. generate a broad union of candidate anchors from independent recall routes;
2. expand each anchor into a local source window;
3. use transcript + chat + audio + sampled video to identify the complete story beats;
4. rank only candidates that contain a coherent setup → escalation/action → payoff → reaction tail;
5. keep private human approval and boundary correction until the measured gates pass;
6. automate rendering and posting only after discovery and trimming are proven.

Do **not** build another taste ranker yet. Do **not** fine-tune a general video model yet. Do **not** spend more time tuning the current hand-written virality weights.

There is also an upstream business blocker: a channel made from another creator’s minimally modified clips can receive views yet still fail YouTube Partner Program monetization under the reused-content policy. Rights and the transformative format must be decided before full automation.

**Wayfinder map:** https://github.com/Juz92/Streamer-Clipping/issues/11

---

## 1. Product destination

Build a BurntPeanut-first stream clipping system that:

- downloads or locates full streams;
- finds both conversational humour and visually driven gameplay moments;
- identifies the **complete source arc**, not merely the loudest point;
- chooses a cold-open strategy without deleting necessary context;
- ends after the payoff and useful reaction tail;
- produces a small, honest shortlist rather than filling a quota;
- learns from explicit private review and later owned-channel performance;
- renders and packages approved clips as Shorts;
- can later generalise to other creators and games without pretending one generic detector solves everything.

The immediate success condition is not “fully autonomous viral Shorts.” It is:

> On unseen VODs, the system reliably retrieves known good arcs and presents 3–5 correctly bounded candidates that Justin would seriously consider posting.

---

## 2. What the successful reference Shorts actually show

The local reference corpus contains **30 high-view videos from six adjacent channels**: five per channel, with 682,888 to 10,779,150 views. Twenty-one were marked as strict comedy positives.

### The unit-of-analysis problem

Five of those 21 positives are **Top-5 compilations** containing unrelated micro-clips. They are useful references for packaging, but they are not single source arcs and should not train a single-arc retriever.

That leaves **16 single-arc positives**:

| Measure | Result |
|---|---:|
| Minimum duration | 15s |
| Median duration | 30s |
| Mean duration | 43.9s |
| Maximum duration | 118s |
| Single arcs longer than 60s | 4/16 |

The current system usually trims clips to **15–35 seconds** and blocks rendered clips over 60 seconds. That makes it structurally impossible to reproduce four of the 16 successful single-arc examples without aggressively deleting story material. YouTube now classifies qualifying square/vertical uploads up to three minutes as Shorts, so 60 seconds is no longer a platform limit.

### Repeating editorial structures

The positives are not simply “funny dialogue” or “high action.” They repeatedly use one of these structures:

1. **Rule → repetition → violation → consequence**  
   Example: keep the laser on; the player turns it off; Peanut follows through.
2. **Claim or prophecy → suspense → visual proof → reaction**  
   Example: call for three tower shots; the shots arrive; the room erupts.
3. **Trap or plan → bait → execution → celebration/taunt**.
4. **Status or bravado → gameplay deflation → dismissive tag**.
5. **Callout → evidence ladder → confession or overreaction**.
6. **Ambiguous phrase → escalating misunderstanding → literal reveal**.
7. **Ordinary premise → increasingly absurd metaphor/riff → concise counter-roast**.
8. **Real gameplay stakes → simple social bit applied repeatedly → absurd conclusion**.

The action-positive examples also have a legible premise. A kill, a scream or chaotic movement is rarely enough on its own.

### Hooks are often editorial, not naturally present in the source

Many successful examples use an added title, a punchline-forward caption, a recognisable guest name, or a flash of the result. The raw source does not always begin with a strong first frame. Therefore discovery must find the complete arc; the editor can synthesize the hook later. Penalising a source window because its natural first three seconds are not already a finished hook confuses **source quality** with **edit quality**.

---

## 3. What the current evidence really proves

### Label volume is too small for personal-taste learning

The core taste benchmark has six `LOL` positives and ten `NOT_FUNNY` negatives. The private feedback file contains 20 decisions across three records: six `lol` and 14 `nothing`.

That is enough to expose bad approaches. It is not enough to learn a reliable personal humour boundary.

### Every attempted taste/ranking shortcut failed

| Method | Result | Interpretation |
|---|---:|---|
| Gemini text contrastive v1 | 62.5% accuracy; 100% positive recall; 40% negative specificity | Finds possibilities, over-approves weak clips |
| Gemini video-anchor | 60% on five cases | Too small and quota-limited |
| Qwen2.5-Omni-3B | 56.25%; 83.3% positive recall; 40% specificity | Same weak-negative problem |
| GPT-5.6 Luna | 75%; 33.3% positive recall; 100% specificity | Strong bouncer, misses most winners |
| Gemini video embeddings | best AUC 0.375 | Generic similarity does not encode humour quality |
| TF-IDF nearest public positive | AUC 0.450 | Transcript resemblance is not quality |
| TF-IDF logistic | AUC 0.233 | Worse than random ordering |
| Luna + reference examples | AUC 0.683; only 2/6 winners in top five | Better, still failed promotion gate |
| Public-outcome ranker | cross-val AUC 0.642; blind AUC 0.292 | Learned channel/performance artefacts, not Justin’s winners |

### The chat AUC result was overstated

`coreMessages` achieved AUC 1.0 on six positives versus four negatives, but **duration itself achieved AUC 0.917**. The known positive clips were generally longer. Once normalised, `coreMessagesPerSec` fell to AUC 0.625 and laugh-rate lift was 0.5.

Chat is still valuable as a recall anchor. The current evidence does not justify treating raw chat volume as a quality score.

### The reference bank lacks the labels the system needs

The 30 edited Shorts explain what successful outputs look like, but they generally do not contain:

- source VOD ID;
- source start and end;
- what happened before the editor’s cut;
- the true setup, payoff and reaction boundaries in the raw stream;
- nearby hard negatives from the same VOD;
- which raw signals were present at discovery time.

Only one of roughly 100 official Shorts was aligned to an available source VOD in the existing alignment output. The reference bank is therefore an **editorial pattern library**, not yet a supervised source-discovery dataset.

---

## 4. Current pipeline audit

### Keep: useful production foundations

- VOD discovery/download and manifest handling.
- Word-level transcription, chat parsing and audio extraction.
- Candidate-pool identity using `jobId + momentId`.
- Clip extraction/finalisation mechanics.
- Remotion rendering, captions, framing, thumbnails and stream QA.
- Private review packaging and explicit upload separation.
- YouTube upload/performance linking once owned data matures.

### Replace or reconnect: the discovery core

#### A. Discovery and trimming use different candidates

`analyze.ts` writes scorer candidates with IDs such as `moment-1`. Transcript recall writes `notebooklm-moments.json` with IDs such as `nlm-001`.

`story-gate.ts` prefers scorer moments when lane metadata exists. `trim.ts` prefers NotebookLM/retrieval moments. The existing jobs prove the mismatch:

- Job 002 story gate starts with `moment-1`; trim starts with `nlm-001`.
- Job 004 story gate starts with `curated-v2-01`; trim starts with `nlm-001`.

The system can therefore approve or block one candidate and render another. Preflight counts gate failures globally rather than proving that the rendered `momentId`s passed.

#### B. The main signal analyser prefilters before the better recall pass

`analyze.ts` computes scene arcs, but the LLM candidate pass receives only the top 20 individual scenes selected by the hand-written scene scorer. The computed arc scores are not used to create the LLM input set. This silently destroys recall before the multimodal/taste scorer runs.

The later windowed transcript recall is materially better for conversational candidates, but it is a separate path rather than the one canonical discovery stage.

#### C. Boundary selection is target-duration-first, not story-first

`trim.ts` assigns archetype targets such as:

- skill: 15–25s;
- roast: 22–32s;
- story payoff: 25–35s;
- general: 18–30s.

If the detected content is longer, the code trims from the setup side to keep the natural end. That preserves the punchline while often deleting the premise that makes it understandable.

Boundary logic should first locate the narrative beats, then decide whether the complete arc is suitable as one Short. Duration should be a soft editorial constraint, not the source of truth.

#### D. Feedback is not joined back reliably

`ingest-review-decision.ts` reads `moments.json` as though it were an object with a `moments` property, while current `moments.json` is an array. The content lane and scorer features are therefore omitted from feedback records. More importantly, no successful mainline model currently consumes enough of those labels to change retrieval.

#### E. Too many overlapping scorers hide the real decision

The project currently contains:

- scene scorer;
- enhanced scorer;
- LLM humour scorer;
- NotebookLM scorer;
- pick-quality heuristic;
- story gate;
- Gemini post-render review;
- contrastive taste gate;
- reference-bank rankers;
- autonomous outcome ranker;
- gameplay recall prototype.

Each is locally plausible. Together they create a system where it is hard to answer: **which candidate was found, why, which evidence changed its boundary, and which gate allowed it to render?**

### Archive as experiments, not production dependencies

Until the new evaluation corpus exists, keep these available for evidence but out of the production decision path:

- public-reference nearest-neighbour and logistic rankers;
- generic video-embedding taste ranker;
- autonomous outcome learner;
- Qwen/Luna/Gemini taste benchmarks;
- hand-written virality-weight tuning;
- the old full-transcript GPT-5.5 path;
- gameplay chat-keyword prototype as a final gate.

---

## 5. External evidence

### OpusClip

OpusClip’s official documentation says ClipAnything analyses visual, audio and sentiment cues, identifies scenes/actions/sounds/emotions/text, and supports natural-language prompts for specific moments. Its Virality Score evaluates **Hook, Flow, Value and Trend** and also prompt relevance.

That supports two conclusions:

1. multimodal evidence and task-specific prompting matter;
2. OpusClip is a useful benchmark, not proof that its proprietary score will match BurntPeanut humour or Justin’s taste.

We should run the same VOD and the same lane prompts through OpusClip before committing to months of custom model work.

### Twitch Clips

Twitch’s official API exposes clip view count, source `video_id` and `vod_offset` when the VOD is available. Public Twitch clip playlists are already accessible through `yt-dlp` without a custom scraper.

A quick local sample of the current top five BurntPeanut Twitch clips showed:

- a complete conversational food-confession arc;
- visually driven win/result clips;
- hybrid gameplay/social clips;
- some weak or late/early raw boundaries.

That is exactly what we need: **crowd-selected event anchors and weak positives**, followed by our own boundary relabelling. Twitch clips should become a recall/data route, not be treated as final edits.

### Research

- A 2018 game-stream highlight paper found that game footage alone is insufficient and combined visual gameplay with social signals such as speech and facial expression.
- A 2025 gameplay-highlight paper achieved reported >90% accuracy on unseen first-person-shooter footage by fine-tuning X-CLIP on an in-house, human-annotated gameplay-event dataset. It also explicitly notes the engineering cost of game-specific OCR and engine integration.
- TimeLens shows that modern multimodal models can improve temporal grounding, but its own project emphasises benchmark/data quality. It is a possible later localiser, not a substitute for a BurntPeanut-labelled corpus.

The consistent lesson is: **high-quality temporal labels precede a good model**.

---

## 6. Architecture options

| Option | Strength | Failure mode | Decision |
|---|---|---|---|
| Patch current prompts and weights | Fast and cheap | Preserves split candidate sets, wrong labels and duration-first cuts | Reject |
| End-to-end multimodal scan of 6–10h VODs | Conceptually similar to OpusClip | Expensive, opaque, weak timestamp precision, difficult to evaluate | Benchmark through Opus; do not build first |
| Supervised game-event model | Best eventual action recall within a genre | Needs substantial labelled video; does not solve humour or story boundaries | Later lane-specific investment |
| Multi-route recall → local multimodal arc grounding → private review | Measurable, debuggable, reuses existing system, lower compute | Requires a proper gold corpus and one canonical data contract | **Recommended** |

---

## 7. Recommended V2 architecture

### Stage 1 — Ingest once

Produce one stream evidence bundle:

- source video;
- word-level transcript;
- speaker turns when available;
- Twitch chat timeline;
- audio timeline and meaningful reaction events;
- coarse frame/shot index;
- game/title metadata;
- Twitch clip anchors where available.

Do not create final candidates in this stage.

### Stage 2 — Independent high-recall routes

Each route emits an anchor plus evidence, not a final score.

1. **Crowd route** — Twitch clips, repeated clip clusters and source offsets.
2. **Transcript route** — overlapping windows for stories, roasts, misunderstandings, confessions and social bits.
3. **Chat-reaction route** — robust rate/unique-chatter/duplicate-message changes; never raw volume alone.
4. **Audio-reaction route** — laughter, surprise, speech-energy change and group reaction; not RMS loudness alone.
5. **Gameplay route** — candidate nominations from chat/callouts first; later add game/genre-specific visual models or OCR where justified.

Union and deduplicate anchors with generous spacing. Recall should be allowed to return 30–80 nominations from a long VOD.

### Stage 3 — Candidate expansion and local grounding

For each anchor, inspect a bounded source window, for example ±60–90 seconds. Build a compact evidence packet containing:

- timestamped transcript;
- chat-rate and reaction histogram;
- audio/laughter markers;
- sampled frames or a low-resolution proxy;
- the route and anchor that nominated it.

A multimodal localiser then identifies:

- `setupStart`;
- `premiseClear`;
- `escalationStart` or `actionStart`;
- `payoffStart`;
- `payoffEnd`;
- `reactionEnd` / `naturalEnd`;
- optional `flashMoment`;
- lane and payoff type;
- missing-context and visual-proof requirements.

This is much easier and cheaper than asking one model to find exact highlights inside an entire VOD.

### Stage 4 — Arc gate before taste gate

A candidate cannot be taste-ranked until it passes objective editorial checks:

- premise understandable to a cold viewer;
- setup is present but not needlessly long;
- escalation/action changes something;
- payoff exists and is visible/audible;
- the cut does not end mid-sentence or before the result;
- the reaction tail adds value;
- no dead middle that makes the arc unusable;
- gameplay-only nominations have visual proof.

Then rank separately on:

1. **editorial strength** — completeness, clarity, distinctiveness, pacing;
2. **Justin taste** — `LOL=1`, `smiled=0.5`, other=0;
3. **market prior** — Twitch clips, reference patterns and later owned performance.

Never collapse all three into one undocumented “viral score.”

### Stage 5 — Human trim/label loop

Reuse the existing private review and trim UI, but capture:

- keep / reject / reserve;
- lane;
- reaction label;
- rejection reason;
- corrected setup, payoff and natural-end boundaries;
- whether the suggested cold open is acceptable;
- whether it is a single arc or compilation candidate.

Those corrected source timestamps are the most valuable training data in the project.

### Stage 6 — Render, QA and publish

The existing rendering and packaging work can remain. Render only accepted candidates. Automatic posting remains off until content, boundary, rights and quality gates all pass.

---

## 8. Canonical candidate contract

Every stage should read and write one stable record keyed by one immutable `candidateId`:

```json
{
  "candidateId": "streamId:startMs:endMs:version",
  "streamId": "...",
  "anchors": [{ "route": "twitch-clip", "timeSec": 1234, "strength": 0.8 }],
  "sourceWindow": { "startSec": 1144, "endSec": 1324 },
  "laneNominations": ["conversational-humor", "hybrid-gameplay"],
  "evidence": {
    "transcript": "...",
    "chatTimeline": "...",
    "audioTimeline": "...",
    "videoProxy": "..."
  },
  "beats": {
    "setupStartSec": null,
    "premiseClearSec": null,
    "actionStartSec": null,
    "payoffStartSec": null,
    "payoffEndSec": null,
    "reactionEndSec": null,
    "flashSec": null
  },
  "gates": {
    "arcComplete": null,
    "visualProof": null,
    "contextIndependent": null
  },
  "labels": {
    "reaction": null,
    "decision": null,
    "rejectionReason": null,
    "correctedBeats": null
  }
}
```

No rank-based joins. No separate `moment-1` and `nlm-001` identities for the same stage of the pipeline.

---

## 9. Evaluation corpus and promotion gates

### Gold corpus v1

Build from raw source windows, not edited Shorts alone:

- at least three unseen VODs to start, expanding to five before autonomous promotion;
- top Twitch clip anchors from those VODs;
- the six known `LOL` positives;
- nearby same-VOD negatives;
- conversational, hybrid and visual-gameplay positives;
- explicit beat boundaries;
- a separate compilation label;
- no forced positive quota per VOD.

Reference-channel Shorts remain pattern examples. Align them to source VODs where possible through VOD date resolution plus transcript/audio fingerprinting; otherwise do not use them as source-boundary truth.

### Gates

| Layer | Initial gate |
|---|---|
| Recall | Recall@50 ≥ 0.90 overall on unseen VODs; no major lane below 0.80 |
| Candidate quality | At least 50% of top 10 pass objective arc gate |
| Boundaries | Median start and end error ≤2s, or ≥70% accepted without manual boundary change |
| Payoff safety | ≥90% include payoff and useful reaction tail; zero mid-sentence hard cuts in promoted set |
| Taste | Mean Taste Score@5 ≥0.60 and beats the current baseline on at least 3/5 unseen VODs |
| Honesty | Allowed to return fewer than three candidates when a VOD lacks quality |
| Posting | Explicit private approval until all gates and rights decision pass |

Track recall, boundary quality and taste separately. A model can improve one while damaging another.

---

## 10. Execution sequence

### Frontier A — Decide the business model

Choose one:

- official/permissioned creator clipping partner;
- genuinely transformative editorial channel with original storyline/commentary;
- non-YPP distribution strategy with a different revenue model.

YouTube states that minimal changes to another creator’s clips can violate reused-content monetization rules **even with permission**. Permission still matters for copyright, but it does not solve YPP eligibility by itself.

### Frontier B — Establish the benchmark

Run the same source VOD through:

- the current system;
- OpusClip ClipAnything with separate humour and gameplay prompts;
- Twitch top clips from the same source period;
- the V2 recall union once available.

Blind-label the combined shortlist. This prevents building a worse version of something we could buy and gives us a real external baseline.

### Frontier C — Build gold data and one contract

1. correct the candidate identity/data-contract split;
2. make one artifact the source of truth;
3. label raw source beats for the first corpus;
4. make story gate, trim, render and feedback prove they use the same `candidateId`.

### Then

1. implement the multi-route recall union;
2. implement local multimodal arc grounding;
3. benchmark boundary accuracy;
4. add private feedback capture;
5. test taste ranking only after enough labels exist;
6. promote rendering/upload automation last.

---

## 11. Explicitly stop doing

- Stop adding taste models to six positives and ten negatives.
- Stop treating high-view edited Shorts as source-aligned training records.
- Stop using raw loudness or chat volume as quality.
- Stop forcing every candidate into 15–35 seconds.
- Stop story-gating one artifact and trimming another.
- Stop treating gameplay and conversational humour as one recall problem.
- Stop evaluating only top-five outputs without measuring missed known positives.
- Stop learning from public view counts without controlling for channel, packaging and source alignment.
- Stop auto-replacing weak clips until replacement candidates pass the same canonical gates.
- Stop assuming a clipping channel will be YPP-monetizable because similar channels receive views.

---

## 12. Sources

- OpusClip, “What is ClipAnything?” — https://help.opus.pro/docs/article/9947095-clip-anything.md
- OpusClip, “How to use ClipAnything?” — https://help.opus.pro/docs/article/how-to-use-clipanything.md
- OpusClip, “What is the Virality Score?” — https://help.opus.pro/docs/article/virality-score.md
- Twitch API, Get Clips — https://dev.twitch.tv/docs/api/reference/#get-clips
- YouTube Help, three-minute Shorts — https://support.google.com/youtube/answer/15424877
- YouTube channel monetization / reused content — https://support.google.com/youtube/answer/1311392
- “Deep Unsupervised Multi-View Detection of Video Game Stream Highlights” — https://arxiv.org/abs/1807.09715
- “Gameplay Highlights Generation” — https://arxiv.org/abs/2505.07721
- TimeLens — https://github.com/TencentARC/TimeLens
