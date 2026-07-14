# Streamer-Clipping Transplant Roadmap

## Goal
Map the current Burnt Peanut pipeline, identify the technical/editorial gaps suppressing virality, and show exactly where proven ReRank and Terrace Talk logic should be transplanted first.

---

## 1) Current module responsibilities

### Pipeline control
- `packages/clips/src/orchestrate.ts`
  - Runs the full job flow: `discover -> analyze -> notebooklm-review -> trim -> whisper-captions -> render -> review -> thumbnails -> metadata -> upload`.
  - Uses manifest phase checks, but mostly treats each stage as a linear tool invocation, not as a scored gate.

### Discovery + signal mining
- `packages/clips/src/discover.ts`
  - Pulls the stream, subtitles, and chat replay.
- `packages/clips/src/analyze.ts`
  - Builds first-pass candidates from transcript, chat, and audio spikes.
  - Saves broad `moments.json` windows.
- `packages/clips/src/lib/signals.ts`
  - Keyword and chat heuristics for reaction/comedy detection.
- `packages/clips/src/lib/scorer.ts`
  - Scores windows by overlap/chat/audio/transcript and outputs 15-60s candidate spans.
- `packages/clips/src/notebooklm-review.ts`
  - Adds semantic enrichment, humor/running-bits picks, title drafts, cold-open/natural-end hints, then caps to top picks.
- `packages/clips/src/scan.ts`
  - Manual audit/merge utility for transcript scanning and unified picks.

### Clip shaping
- `packages/clips/src/trim.ts`
  - Browser trimmer or auto-trim finalizer.
  - Can start from `unified-moments.json` or NotebookLM picks.
  - Finalizes clips, whisper remaps, crop/layout state.
- `packages/clips/src/lib/auto-trim.ts`
  - Auto-trim logic driven by whisper/audio, but not by explicit virality constraints like punchline speed, self-contained setup, or loop role.
- `packages/clips/src/lib/trim-finalize.ts`
  - Produces flash + content finalized clip structure.

### Rendering
- `packages/clips/src/render-fast.ts`
  - Main production renderer.
  - Good strengths already present: hook overlay, karaoke ASS captions, layout detection, motion planning, ffmpeg-first rendering.
  - Still renders each clip independently with no clip-specific retention QA before render.
- `packages/remotion/src/compositions/GamingShort/index.tsx`
  - Simpler fallback composition. Useful structurally, but far less opinionated than the ffmpeg render path.

### Post-render QA
- `packages/clips/src/review.ts`
  - Gemini post-render review with one auto-fix path for end trims.
  - Helpful, but too late in the pipeline and too narrow. It only repairs some timing trims after render, not clip selection quality, ordering, opener strength, or loop behavior.

---

## 2) Gaps hurting virality

### A. Candidate scoring is still “signal-rich moment detection”, not “short-worthy self-contained story detection”
- `analyze.ts` + `lib/scorer.ts` are good at finding loud/reactive moments.
- They are weak at proving:
  - whether the clip makes sense to a cold viewer,
  - whether setup arrives fast enough,
  - whether the funniest beat lands soon enough,
  - whether the end resolves cleanly,
  - whether the first frame is scroll-stopping.
- This is the biggest gap versus ReRank.

### B. No dedicated pre-render clip gate
- ReRank has a strong `ranked-clip-review.ts` stage before render.
- Streamer-Clipping currently jumps from candidate generation into trim/render with only NotebookLM enrichment and optional browser review.
- That means weak, context-dependent, or slow-starting clips can survive too long.

### C. Auto-trim is not role-aware
- ReRank windowing explicitly protects setup, peak, reaction resolution, scene boundaries, silence tails, and rank-specific clip length behavior.
- Streamer-Clipping auto-trim does not appear to enforce opener-specific punchline speed, self-contained setup windows, clean boundary snapping, or natural loop-end behavior.

### D. Review happens too late and fixes too little
- `review.ts` only trims already rendered clips.
- It does not reject clips for “joined halfway”, “cute not funny”, weak frame 0, weak broad appeal, or filler.
- Terrace Talk and ReRank both push more judgment earlier in the pipeline.

### E. No batch-level retention model
- ReRank has `ranked-video-review.ts`, which predicts opener/retention/loop/ordering/diversity/broad appeal before upload.
- Streamer-Clipping has no equivalent final pack review for:
  - ordering the best clips first,
  - ensuring broad-appeal openers lead the batch,
  - checking clip-to-clip variety,
  - flagging weak loop endings or stale batches.

### F. Weak “broad appeal” bias in selection
- CLAUDE guidance clearly says Peanut’s best growth clips are non-gaming-native jokes, roasts, crash-outs, absurd lines.
- Current scoring still overweights generic stream signals, so gaming-context clips can outrank more universal clips.

### G. No clip verification against editorial intent
- Terrace Talk has `verify-clips.ts` and heavy review logic around whether visuals actually match the intended narration/beat.
- Streamer-Clipping has no equivalent validator for “does this clip actually deliver the hook/promise/description?”

### H. Final outputs are clip-by-clip, not portfolio-scored
- ReRank treats the final video as a single retention object.
- Streamer-Clipping mostly treats each short independently, with no cross-batch optimization layer.

---

## 3) Specific files/modules to change first

### Highest-priority insertion points
1. `packages/clips/src/notebooklm-review.ts`
   - Best place to import stronger editorial scoring fields.
   - Add explicit retention-oriented metadata: cold-viewer clarity, punchline speed, opener viability, broad-appeal rating, context dependency, clean-end confidence.

2. `packages/clips/src/trim.ts`
   - Best place to transplant ReRank-style window computation.
   - Should own smarter start/end selection, scene-boundary avoidance, punchline-preserving lead-in, and clean reaction tail handling.

3. `packages/clips/src/lib/auto-trim.ts`
   - Core place to encode deterministic clipping rules instead of loose whisper/audio trimming.
   - Should become the equivalent of a Peanut-specific `ranked-windowing.ts`.

4. `packages/clips/src/review.ts`
   - Should split into two review layers:
     - pre-render clip review,
     - post-render short review.
   - Current logic is too late and too narrow.

5. `packages/clips/src/orchestrate.ts`
   - Needs new mandatory gates between NotebookLM review, trim, render, and upload package generation.
   - Right now it is an orchestrator, not a true quality-enforcing pipeline.

### Secondary but important
6. `packages/clips/src/lib/scorer.ts`
   - Reweight for broad appeal and self-contained payoff, not just signal overlap.
7. `packages/clips/src/lib/signals.ts`
   - Expand streamer-specific phrase classes into editorial categories: roast, absurdity, crash-out, quoteable one-liner, broad-appeal reaction.
8. `packages/clips/src/generate-metadata.ts`
   - Wire metadata to the reviewed hook and opener classification, not just generic post hoc titling.
9. `packages/clips/src/render-fast.ts`
   - Consume richer precomputed review/window metadata instead of inferring so much at render time.
10. `packages/clips/src/upload.ts`
   - Batch/package outputs by posting order and broad-appeal priority, not just file completion.

---

## 4) 10 highest-impact upgrades, in priority order

### 1. Add a pre-render `clip-review` gate modeled on ReRank
**Transplant from:** `Shorts-creator/packages/pipeline/src/ranked-clip-review.ts`

Create a new module, likely `packages/clips/src/clip-review.ts`, that reviews each candidate clip before final render and writes structured fields such as:
- selfContained: yes/no
- punchlineSpeedMs
- firstFrameStrength
- broadAppeal
- contextDependency
- cleanBoundaryRisk
- pass/fail
- fix action

This is the single biggest improvement because it kills weak clips before they waste render/upload attention.

### 2. Replace loose auto-trim with deterministic windowing
**Transplant from:** `ranked-windowing.ts`

Port these ideas into Peanut trimming:
- preserve setup before peak,
- preserve reaction resolution after peak,
- snap away from scene boundaries,
- detect silence tails,
- enforce clip length floors/ceilings by clip role,
- favor early payoff.

This should live mainly in `lib/auto-trim.ts` and be consumed by `trim.ts`.

### 3. Introduce opener-role and broad-appeal scoring
**Transplant from:** ReRank clip gates + CLAUDE operational rules

Every candidate should get explicit fields like:
- openerViable
- broadAppealScore
- nonGamerClarity
- quoteStrength
- faceAtStart / brightnessAtStart if visually inferable from QA frames

Then enforce that daily posting order starts with the most broadly understandable clips.

### 4. Add a batch-level video/portfolio review layer
**Transplant from:** `ranked-video-review.ts`

Even if Peanut uploads shorts individually, the batch still needs review as a portfolio:
- best opener first,
- avoid five samey clips in a row,
- surface the 2-3 strongest uploads,
- warn on narrow-context overconcentration.

A lightweight `batch-review.ts` or `short-review.ts` would materially improve posting order and selection discipline.

### 5. Move review earlier, not only after render
**Transplant from:** ReRank’s staged gates, Terrace Talk’s verify-before-render mentality

Refactor `review.ts` into:
- `clip-review.ts` before render,
- `short-review.ts` after render.

Current late review catches trim issues, but not the more expensive mistake: rendering the wrong clip at all.

### 6. Add visual/editorial verification of selected clips against promise
**Transplant from:** Terrace Talk `verify-clips.ts`

Use AI review to verify that:
- the clip truly supports the hook text,
- the best beat is visible after crop,
- the clip is not generic filler,
- the action is complete,
- the moment is understandable without extra lore.

This is especially valuable for clips sourced from broad stream windows.

### 7. Reweight `lib/scorer.ts` toward retention factors, not raw event density
**Transplant from:** ReRank’s stronger pass/fail logic

Keep the signal pipeline, but reduce its authority. Signal overlap should nominate candidates, not decide winners.

Suggested additions to composite logic:
- penalty for likely context dependency,
- bonus for quoteability / one-liner structure,
- bonus for broad-appeal roast/crash-out/absurdity categories,
- bonus for early payoff,
- penalty for long setup or weak end resolution.

### 8. Turn NotebookLM enrichment into structured editorial features
**Transplant from:** ReRank structured JSON discipline + Terrace Talk’s agent outputs

`notebooklm-review.ts` already gets close. Push it harder by requiring fields like:
- why this works for cold viewers,
- what must be included before the peak,
- what exact line/beat is the payoff,
- whether clip is universal or gamer-only,
- whether it should lead the batch.

That makes downstream trim/review/render deterministic instead of interpretive.

### 9. Add final-output packaging and ranking discipline
**Transplant from:** ReRank operational lessons in self-improving memory

Make reviewed winners easy to find and publish in order, ideally in a final package folder with:
- posting order,
- broad-appeal rank,
- reviewed title/hook,
- QA verdict,
- why this clip should post first.

The current job-folder flow is technically sound but operationally weak.

### 10. Add stronger anti-filler rejection rules
**Transplant from:** ReRank hard gates + Terrace Talk quality floors

Codify rejection for clips that are:
- just loud, not funny,
- “cute” but not laugh-worthy,
- understandable only to regular stream viewers,
- late to payoff,
- ending mid-thought,
- visually muddy at frame 0.

This probably matters more than adding more candidate sources.

---

## 5) Fast wins vs larger refactors

### Fast wins, high ROI

#### Fast win 1. Add structured editorial fields to `notebooklm-review.ts`
Low code surface, high leverage.
Add fields like:
- `broadAppealScore`
- `contextDependency`
- `setupMustIncludeStartSec`
- `payoffMomentSec`
- `openerViable`
- `coldViewerClarity`

#### Fast win 2. Tighten `lib/scorer.ts` filters
Immediately downrank:
- clips with long windows and weak transcript specificity,
- clips with no clear quote/phrase payload,
- generic gameplay hype windows.

#### Fast win 3. Add a minimal pre-render `clip-review.ts`
Even a first version that only flags:
- slow start,
- weak first frame,
- missing setup,
- unresolved ending,
- narrow-context joke,
would improve hit rate fast.

#### Fast win 4. Add broad-appeal-first output ordering
Use metadata from review/enrichment to sort final upload suggestions so the strongest universal clip posts first.

#### Fast win 5. Expand streamer-specific signal taxonomy in `lib/signals.ts`
Separate:
- crash-out,
- roast,
- absurdity,
- quotable one-liner,
- hype highlight.
This will help scorer and NotebookLM weighting immediately.

### Larger refactors

#### Refactor 1. Build Peanut-specific deterministic window engine
A true replacement for current auto-trim heuristics, modeled on `ranked-windowing.ts`.
This is the most important heavier lift.

#### Refactor 2. Split review into candidate, clip, and post-render gates
Suggested flow:
- `analyze` nominates,
- `notebooklm-review` enriches,
- `clip-review` approves/rejects,
- `trim` finalizes windows,
- `render-fast` renders,
- `short-review` validates finished short,
- `batch-review` ranks posting order.

#### Refactor 3. Add a proper final-batch optimizer
A module that ranks the top shorts from a stream for posting order based on broad appeal, novelty, and predicted retention.

---

## Recommended implementation sequence

### Phase 1, stop the bleeding
1. Add `clip-review.ts` before render.
2. Add broad-appeal and cold-viewer clarity fields to `notebooklm-review.ts`.
3. Tighten `lib/scorer.ts` penalties for context-dependent or slow-payoff candidates.

### Phase 2, improve clip quality mechanically
4. Port deterministic windowing concepts from `ranked-windowing.ts` into `lib/auto-trim.ts` and `trim.ts`.
5. Add scene-boundary and clean-end handling.
6. Add opener-role handling and first-frame checks.

### Phase 3, improve batch outcomes
7. Add `short-review.ts` or `batch-review.ts` modeled on `ranked-video-review.ts`.
8. Sort upload/posting packages by broad appeal and predicted retention.
9. Improve metadata generation to inherit reviewed hooks.
10. Add final output foldering for easy manual publishing.

---

## Bottom line
Streamer-Clipping already has strong plumbing: discovery, transcript/chat/audio mining, NotebookLM enrichment, browser trimming, fast ffmpeg rendering, and post-render QA.

What it lacks is the same thing ReRank and Terrace Talk already learned the hard way: **strong editorial gates before render**.

The highest-value transplant is not a new renderer. It is a stricter decision layer:
- review candidates like ReRank,
- shape windows like ReRank,
- verify visual/editorial truth like Terrace Talk,
- treat posting order as a retention system, not a file list.

If only three changes happen first, they should be:
1. pre-render `clip-review.ts`,
2. deterministic windowing in `auto-trim.ts`,
3. broad-appeal-first scoring and output ordering.
