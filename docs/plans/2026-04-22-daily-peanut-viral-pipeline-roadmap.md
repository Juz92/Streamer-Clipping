# Daily Peanut Viral Pipeline Roadmap

**Date:** 2026-04-22  
**Goal:** transplant the strongest proven viral mechanics from ReRank and Terrace Talk into Streamer-Clipping without rebuilding the whole factory.

## Executive take

Stream-Clipping already has the best automation base of the three projects.

What it lacks is ruthless editorial logic.

Right now the pipeline is good at finding moments, trimming them cleanly, rendering them fast, and packaging them decently. It is not yet opinionated enough about what *must* happen in the first 1-3 seconds, what counts as filler, when a clip should be rejected, or how to turn a good moment into a rewatchable short.

**Best path:** keep the current pipeline shape, but harden four layers:
1. candidate scoring
2. trim architecture
3. QA gates
4. packaging + feedback loop

---

## 1. Current module responsibilities

### Core pipeline
- `packages/clips/src/discover.ts`
  - downloads stream, captures base job data
- `packages/clips/src/analyze.ts`
  - builds initial moment candidates from transcript, chat, and audio
  - outputs `moments.json`
- `packages/clips/src/notebooklm-review.ts`
  - enriches candidates with humor/roast/crash-out/story queries
  - dedupes, scores, writes `notebooklm-moments.json`
- `packages/clips/src/trim.ts`
  - browser trimmer or auto-trim pass
  - already supports flash/content split and padded source extraction
- `packages/clips/src/render-fast.ts`
  - ffmpeg-based vertical render, layout handling, hook text, captions
- `packages/clips/src/review.ts`
  - Gemini review and limited auto-fix for trim-end issues
- `packages/clips/src/generate-thumbnails.ts`
  - frame extraction plus hook banner thumbnails
- `packages/clips/src/generate-metadata.ts`
  - AI metadata generation for shorts
- `packages/clips/src/upload.ts`
  - upload path
- `packages/clips/src/orchestrate.ts`
  - full end-to-end runner

### Key supporting logic
- `packages/clips/src/lib/signals.ts`
  - streamer-specific transcript/chat signal detection
- `packages/clips/src/lib/scorer.ts`
  - initial signal-cluster scoring from transcript/chat/audio overlap
- `packages/clips/src/lib/notebooklm-scorer.ts`
  - enriched pick scoring with category, duration, standalone, setup penalty
- `packages/clips/src/lib/auto-trim.ts`
  - peak-RMS flash window, speech boundary snapping
- `packages/clips/src/lib/layout.ts`
  - gameplay/talking layout choice
- `packages/clips/src/lib/motion.ts`
  - framing and movement planning

---

## 2. What is already strong

### Strongest existing advantages
- full factory already exists, from discovery to upload
- NotebookLM layer gives richer candidate understanding than raw signal-only pipelines
- auto-trim already has a useful flash/content concept
- render path already has house style, captions, and layout logic
- review path already exists instead of relying on blind renders
- metadata and thumbnail generation are operationally wired in

### Why this matters
This repo is not missing infrastructure. It is missing stricter creative judgment encoded into defaults.

---

## 3. Biggest gaps hurting virality

### Gap A. Candidate scoring still favors "signal-rich" over "scroll-stopping"
`analyze.ts` + `lib/scorer.ts` do a good job finding moments with overlap, but they do not strongly model:
- first-frame tension
- immediate legibility
- facial reaction visibility
- quotability
- payoff speed
- loop potential

**Effect:** good stream moments get surfaced, but not always the best *shorts* moments.

### Gap B. Auto-trim is clean, not ruthless
`lib/auto-trim.ts` focuses on natural boundaries and loud flash windows.
It does **not** yet strongly enforce:
- 1-2s punch flash
- minimum context before payoff
- cut on laughter/reaction peak
- clip-type-specific duration ceilings
- hard rejection of long build-up

**Effect:** clips can be coherent but still feel slow.

### Gap C. QA is mostly technical, not editorial enough
`review.ts` mainly handles trim cleanup and rerendering. It does not strongly grade:
- first 3 seconds stayed-to-view potential
- self-contained clarity
- filler/mildness
- middle drag
- abrupt but satisfying loop ending
- whether the hook actually resolves

**Effect:** technically valid clips can still be algorithmically dead.

### Gap D. Packaging is good but not variant-driven
`render-fast.ts`, `generate-thumbnails.ts`, and `generate-metadata.ts` package clips, but the logic is still fairly generic.

Missing:
- multiple hook variants for testing
- clip-type-specific hook formulas
- peak-frame-first packaging
- stronger integration between the chosen payoff and the thumbnail/title text

### Gap E. Analytics are not yet changing defaults aggressively enough
The repo has analytics plumbing, but there is not enough evidence of hard feedback into:
- duration defaults
- category weights
- hook patterns
- clip ordering
- rejection thresholds

**Effect:** learnings risk becoming reports instead of behavior changes.

---

## 4. What to transplant from ReRank

### ReRank mechanic to import
1. **Hard opener rule**
   - if the first 1-3s are weak, fail the clip
2. **Anti-filler gate**
   - "mild", "nothing happens", "needs context", "joined halfway" should fail
3. **Short runtime bias**
   - default to tighter clips, not generous windows
4. **Aggressive replacement culture**
   - rank 4/5 being merely decent is not acceptable, same for mid-tier Peanut clips
5. **Loop-aware endings**
   - end on reaction peak, not decompression
6. **Operator-facing outputs**
   - make final artifacts and review verdicts easy to inspect

### Target modules
- `packages/clips/src/lib/scorer.ts`
- `packages/clips/src/lib/notebooklm-scorer.ts`
- `packages/clips/src/trim.ts`
- `packages/clips/src/review.ts`
- `packages/clips/src/orchestrate.ts`

---

## 5. What to transplant from Terrace Talk

### Terrace mechanic to import
1. **Every second must earn its place**
2. **Visual QA is mandatory, not optional**
3. **Production polish matters to retention**
4. **No filler clips, even if relevant**
5. **Payoff clips need emotional conclusiveness**
6. **Better sound and impact timing**

### Target modules
- `packages/clips/src/review.ts`
- `packages/clips/src/render-fast.ts`
- `packages/clips/src/generate-thumbnails.ts`
- `packages/clips/src/lib/layout.ts`
- `packages/clips/src/lib/motion.ts`

---

## 6. Specific files/modules to change first

### Tier 1, immediate
1. `packages/clips/src/lib/notebooklm-scorer.ts`
2. `packages/clips/src/lib/scorer.ts`
3. `packages/clips/src/lib/auto-trim.ts`
4. `packages/clips/src/trim.ts`
5. `packages/clips/src/review.ts`

### Tier 2, after scoring/trim/QA
6. `packages/clips/src/render-fast.ts`
7. `packages/clips/src/generate-thumbnails.ts`
8. `packages/clips/src/generate-metadata.ts`
9. `packages/clips/src/orchestrate.ts`

### Tier 3, feedback loop
10. `packages/clips/src/analytics.ts`
11. `packages/clips/src/lib/viral-weights.ts`
12. `packages/clips/src/notebooklm-review.ts`

---

## 7. Top 10 highest-impact upgrades

## 1. Add a hard first-3-seconds viability score
**Impact:** very high  
**Effort:** medium

Create a new editorial score that heavily weights:
- visible reaction in first frame
- strong tension or absurdity instantly
- clarity without prior stream context
- payoff promised immediately

Use it in both initial scorer and NotebookLM scorer.

**Build:**
- add fields like `firstFrameClarity`, `payoffSpeed`, `reactionVisibility`, `loopPotential`
- penalize candidates with slow setup even if chat/audio spikes are strong

## 2. Upgrade trim logic from clean boundaries to Flash -> Setup -> Payoff enforcement
**Impact:** very high  
**Effort:** medium-high

The current trim system already has flash and content. Push it into full structure:
- `flash`: 1-2s highest energy moment
- `setup`: shortest context needed
- `payoff`: full reaction until the laughter/impact peak

**Build:**
- extend `auto-trim.ts` to output explicit segment types
- add clip-type duration caps
- make endings snap to reaction/laughter peak, not just punctuation/silence

## 3. Add anti-filler editorial QA gates
**Impact:** very high  
**Effort:** medium

`review.ts` should fail clips for:
- requires too much context
- payoff comes too late
- middle drag
- ending after the reaction already dies
- funny in transcript, weak on screen
- visually confusing start

This is the biggest ReRank transplant.

## 4. Introduce clip archetypes with different rules
**Impact:** high  
**Effort:** medium

Not all Peanut clips should be treated the same. Add explicit archetypes:
- roast
- crash-out
- skill/clutch
- absurd one-liner
- callback/story payoff

Each archetype gets different:
- duration target
- hook style
- trim strategy
- review gates

## 5. Make thumbnail generation peak-frame-led, not midpoint-led
**Impact:** high  
**Effort:** low-medium

Current thumbnail fallback often uses midpoint. That is too generic.

**Build:**
- prefer the flash frame or reaction peak frame
- if available, use enriched `thumbnailSec`, else derive from payoff peak
- reject thumbnails where face clarity is poor or text competes with clutter

## 6. Add hook text variants and tie them to archetype
**Impact:** high  
**Effort:** medium

Current hook logic is useful but too one-size-fits-all.

Create 2-3 formulas per archetype:
- roast: "HE REALLY SAID THIS"
- crash-out: "HE LOST IT OVER THIS"
- skill: "THIS WAS DISGUSTING"
- absurd story: "NOBODY SAW THIS COMING"

Store variants in metadata or review outputs so future A/B logic can use them.

## 7. Add stronger visual review, not just audio trim review
**Impact:** high  
**Effort:** medium-high

Add model review or deterministic checks for:
- face/subject readability in first frame
- caption overlap conflicts
- layout fit for gameplay vs talking mode
- whether hook banner blocks the actual moment

Terrace Talk’s QA discipline should live here.

## 8. Tighten default duration ceilings by archetype
**Impact:** high  
**Effort:** low

Move away from broad 20-35s defaults.

Suggested starting caps:
- skill/clutch: 15-25s
- roast: 22-32s
- crash-out: 20-30s
- callback/story payoff: 25-35s, only if payoff is strong

Apply this in scorer, trim, and review consistently.

## 9. Add replacement-first orchestration when clips are weak
**Impact:** medium-high  
**Effort:** medium

If review fails or scores weakly, the pipeline should not merely patch trims.
It should be able to:
- pull reserve candidates
- rerank alternates
- replace weak clips automatically

This is straight from ReRank’s better habits.

## 10. Feed performance learnings back into weights automatically
**Impact:** medium-high  
**Effort:** medium-high

Make analytics update:
- category weights
- duration bonuses
- setup penalties
- hook formulas
- thumbnail frame preferences

Without this, the system will keep producing polished guesses instead of improving.

---

## 8. Fast wins

### Fast win 1
Tighten `notebooklm-scorer.ts` penalties for setup-heavy clips and increase standalone bonuses.

### Fast win 2
Reduce duration targets in trim defaults by archetype.

### Fast win 3
Add review failures for slow first 3 seconds and context-heavy clips.

### Fast win 4
Change thumbnails to use flash frame or best reaction frame first.

### Fast win 5
Add a simple weak-clip verdict tier in review:
- pass
- pass but weak
- replace

---

## 9. Bigger refactors worth doing

### Refactor 1. Build an editorial scoring layer
Create a new module, likely `lib/editorial-score.ts`, that combines:
- first-frame clarity
- emotional spike quality
- self-contained story score
- quotability
- reaction visibility
- loop ending quality

This should sit above raw signal detection.

### Refactor 2. Segment-aware trimming
Formalize segment outputs:
- flash
- setup
- payoff
- optional tag/reaction tail

Then render and review can reason about segment intent instead of one generic clip.

### Refactor 3. Review architecture split
Split review into:
- `technical-review`
- `editorial-review`
- `visual-review`

Right now too much is bundled into one late-stage pass.

### Refactor 4. Replacement loop in orchestrator
Teach `orchestrate.ts` to automatically retry with alternates when a clip is weak, not just when a trim is off.

---

## 10. Recommended build order

### Sprint 1, highest leverage
1. tighten `notebooklm-scorer.ts`
2. tighten `lib/scorer.ts`
3. add archetype-aware duration ceilings
4. extend `review.ts` with anti-filler and first-3-seconds gates
5. switch thumbnails to flash/reaction frames

## Sprint 2 Status: COMPLETE ✅

### Completed
- [x] Upgrade `auto-trim.ts` to explicit Flash/Setup/Payoff outputs
- [x] Update `trim.ts` to surface/edit those segments + archetype targets
- [x] Add replacement logic in `orchestrate.ts`
- [x] Build full auto-replace module in `review.ts`

### Files changed
- `packages/clips/src/lib/auto-trim.ts`
- `packages/clips/src/trim.ts`
- `packages/clips/src/orchestrate.ts`
- `packages/clips/src/review.ts`

## Sprint 3 Status: COMPLETE ✅

### Completed
- [x] Build analytics-to-weights feedback loop
- [x] `packages/clips/src/lib/feedback.ts` — feedback state management
- [x] `analytics.ts --feedback` — correlates YouTube performance with clip metadata
- [x] `viral-weights.ts` — live feedback-adjusted category weights, duration sweet spot, setup penalty
- [x] `notebooklm-scorer.ts` — uses feedback-adjusted category weights
- [x] `trim.ts` — uses feedback-adjusted duration targets
- [x] `packages/clips/src/lib/hook-variants.ts` — archetype-aware title variant generator
- [x] `generate-metadata.ts` — outputs 2 title variants + hook pattern tracking
- [x] `packages/clips/src/lib/visual-qa.ts` — deterministic frame quality checks
- [x] `review.ts` — runs visual QA and flags failed clips for replacement

### How to use
```bash
# Fetch analytics and update pipeline weights
npx tsx packages/clips/src/analytics.ts --all --feedback

# Check current feedback state
cat data/clips/clip-feedback.json

# Review with visual QA
npx tsx packages/clips/src/review.ts --stream <id> --replace-weak
```

### What the feedback loop adjusts
- Archetype multipliers (range 0.85–1.15)
- Duration sweet spot (tightens toward winning bucket)
- Setup penalty (harsher when global retention is low)
- Hook pattern tracking (which title styles perform best)

### New capabilities
- **Hook variants**: Every clip now gets 2 title options (A = conversational, B = punchline-first)
- **Visual QA**: Automatic checks for dark frames, low contrast, clutter, face visibility
- **Auto-replace**: Visual QA failures automatically queue clips for replacement

---

## 11. Bottom line

Do **not** rebuild Streamer-Clipping from scratch.

The repo already has the factory.

What it needs now is to inherit:
- **ReRank’s ruthlessness** about hooks, filler, and loop value
- **Terrace Talk’s ruthlessness** about quality and editorial finish

If we encode those into defaults, Daily Peanut has a real shot at producing a repeatable viral system instead of just a productive clipping pipeline.
