# GPT-5.5 Deep Audit — Streamer-Clipping / Daily Peanut

Date: 2026-04-24  
Model/session: `openai-codex/gpt-5.5` via OpenClaw Codex OAuth  
Repo: `C:\Users\Justi\OneDrive\Documents\Projects\Streamer-Clipping`

## Executive verdict

The pipeline has the right architecture for a strong Daily Peanut clipping system: signal detection, LLM transcript review, human/auto trim flow, portrait render, QA, thumbnailing, metadata, upload, analytics feedback, and now competitive intelligence.

The earlier 7 improvement areas were directionally correct, but the dirty tree was not production-safe yet. The GPT-5.5 audit found multiple implementation blockers and fixed the obvious ones:

- TypeScript build was failing from the new GPT-5.5 review module.
- Motion punch-in expression still failed real ffmpeg parsing because it used `t` and `^` inside `zoompan`.
- Visual QA tried to extract frames into a directory that was never created.
- The feedback step had a hardcoded `cwd: "C:/peanut"`.
- The GPT/NotebookLM fallback logic could skip fallback or log misleading warnings.

After fixes, `npm run build` passes.

## Verification performed

- `npm run build` → **PASS**
- `git diff --check` → **PASS**
- ffmpeg zoompan parser smoke test using the generated expression pattern → **PASS**
- Orchestrator dry-run:
  - `npx tsx packages/clips/src/orchestrate.ts --stream teststream --dry-run --use-gpt55 --top 3` → **PASS**

No full real stream end-to-end run was performed in this pass because that would touch external downloads/API services and consume significant time/quota.

## Dirty tree status

The repo is still very dirty. Treat this branch as an experimental integration branch until a real stream run passes.

Notable untracked/new files include:

- `packages/clips/src/gpt55-review.ts`
- `packages/clips/src/lib/gpt55-client.ts`
- `packages/clips/src/lib/gpt55-queries.ts`
- `packages/clips/src/analytics.ts`
- `packages/clips/src/competitive-intel.ts`
- `packages/clips/src/lib/feedback.ts`
- `packages/clips/src/lib/visual-qa.ts`
- `packages/clips/src/lib/heatmap-extractor.ts`
- `packages/clips/src/run-gpt55-analysis.ts`
- `check-models.js`
- `test_zoom_expr.js`

Recommendation: keep production files, but delete/quarantine temporary diagnostics before commit:

- `check-models.js`
- `test_zoom_expr.js`
- probably `packages/clips/src/run-gpt55-analysis.ts` unless you want a permanent repo-analysis helper.

## Findings by pipeline stage

### 1. Discovery / source acquisition

Discovery is not the main bottleneck. The pipeline can resolve stream URLs and pass stream IDs through orchestration. The bigger risk is downstream quality, not finding the stream.

Opportunity:

- Add a stream manifest preflight command that verifies subtitles, chat, video file, audio levels, and candidate pool before expensive LLM/render steps.

### 2. Signal analysis / scoring

The original scorer was too strict because it required multi-signal overlap. That was good for precision but bad for streamer content, where viral moments are often one dominant signal:

- one insane line in transcript
- one huge audio spike/laugh/scream
- one chat eruption

The rescue tier is the right fix. It keeps the normal 2-signal overlap rule but allows exceptional single-signal moments through.

Risk:

- The rescue thresholds are hand-tuned. They need performance feedback from actual published clips.

Recommendation:

- Log every rescued clip with `rescueReason` and compare published retention against normal multi-signal clips.
- Add a cap like `maxRescuesPerStream` if rescue clips start flooding the queue.

### 3. GPT-5.5 / NotebookLM transcript review

Replacing NotebookLM as the default review brain is the highest-leverage improvement. NotebookLM is useful but brittle and slow. A GPT-style transcript reviewer is better for repeatable automation.

Important caveat:

- The repo-level `gpt55-client.ts` uses `OPENAI_API_KEY`, not OpenClaw's Codex OAuth session.
- The current chat/session has GPT-5.5 through OpenClaw, but the project script itself still needs a valid API key route to call GPT-5.5.

Fixed during audit:

- Fake parser response objects now include `conversation_id`, so TypeScript accepts reuse of NotebookLM parsers.
- Orchestrator fallback now does not blindly force GPT review when `--use-gpt55` is requested but the repo API key is unavailable.

Recommendation:

- Rename this layer from `gpt55-*` to `llm-review-*` eventually, with `OPENAI_MODEL` defaulting to GPT-5.5. Hardcoding model names makes it brittle.
- Add structured JSON output mode instead of relying on NotebookLM parser compatibility forever.

### 4. Trimming / story boundaries

The trim system is the heart of clip quality because Justin's key preference is no scene bleed and self-contained mini-stories.

Current direction is good:

- NotebookLM/GPT moments flow into candidate pool.
- Auto-trim and finalization exist.
- Review can trigger replacement/recut logic.

Remaining risk:

- The pipeline still needs a hard narrative gate before render: setup → escalation/payoff → clean exit.

Recommendation:

- Add an explicit `storyCompletenessScore` to every candidate before render.
- Block clips below threshold unless manually approved.

### 5. Rendering / motion / subtitles

Single-pass rendering is the right optimization. Burning ASS subtitles inside the main ffmpeg graph should reduce time and quality loss versus two full encodes.

Critical bug found and fixed:

- The re-enabled motion expression still failed ffmpeg parsing.
- `zoompan` did not accept the expression using `t` and `^`.
- The fixed expression now uses `on / 30`, escaped `between()` commas, and explicit cubic multiplication.

Verified:

- ffmpeg accepted the fixed zoompan expression in a smoke test.

Remaining risk:

- Need a real clip render with subtitles + motion + gameplay/talking layout to catch full filtergraph escaping issues.

### 6. Review / QA

The Gemini/visual QA direction is strong. The review stage is where bad clips should die before upload.

Bug found and fixed:

- `visual-qa.ts` extracted frames into `jobDir/frames` but did not create the directory.

Important principle:

- Failed review must block render/upload, not produce a partial warning.

Recommendation:

- Make QA output machine-enforced statuses: `PASS`, `RECUT`, `REPLACE`, `BLOCK`.
- Only `PASS` should continue to thumbnail/metadata/upload.

### 7. Thumbnails

Audio-peak thumbnail timing is a good first pass. It should improve reaction-face capture versus using midpoint frames.

Remaining opportunity:

- Audio peak is not always visual peak. A loud line can happen while the face is neutral.

Recommendation:

- Combine audio peak + face/emotion frame selection.
- Prefer frames with open mouth, widened eyes, face visible, and minimal motion blur.

### 8. Metadata

Metadata/title generation has been improved, but should be tied tighter to actual clip psychology.

Recommendation:

- Generate 3 title variants per clip:
  1. curiosity hook
  2. direct funny quote
  3. drama/escalation hook
- Track retention/clicks by title archetype.

### 9. Feedback loop

Feedback loop wiring is essential and now more realistic.

Bug found and fixed:

- Orchestrator feedback step used hardcoded `cwd: "C:/peanut"`; now uses `process.cwd()`.

Remaining risk:

- YouTube Analytics auth and actual metric availability still need a real run.

Recommendation:

- Run weekly weight updates, not only after upload, because early upload metrics may be too noisy.

### 10. Competitive intelligence

The new competitive intelligence module is promising, but it should not become vanity scraping.

Best use:

- Extract repeating hook/title formats.
- Compare clip lengths and opening patterns.
- Feed learnings into title generation and candidate scoring.

Risk:

- Copying competitors too literally will make the channel generic.

Recommendation:

- Convert competitor findings into reusable archetypes, not one-off imitation.

## Production readiness score

Current state after fixes: **6.5/10**

Why not higher:

- Build passes, but no full stream run has validated the entire dirty tree.
- GPT-5.5 review module depends on API-key access that may not match OpenClaw Codex OAuth access.
- Several new modules are promising but unproven on real stream data.
- QA gates need to be made hard-blocking.

Why it is promising:

- The core architecture is strong.
- The 7 improvement areas map to real bottlenecks.
- The fixes made during audit removed actual build/runtime blockers.
- The pipeline is moving toward a proper learning system rather than a one-off clip generator.

## Recommended next order of work

1. Run one real stream through the pipeline with `--dry-run` off, but stop before upload.
2. Inspect generated candidates manually for story completeness and scene bleed.
3. Render 3 clips only, not the whole batch.
4. Run Gemini/visual QA on those 3 clips.
5. Compare thumbnails against actual emotional peaks.
6. If clips pass, publish as a small controlled test.
7. After 24–72 hours, ingest analytics and adjust scoring weights.

## Files changed/fixed during GPT-5.5 audit

- `packages/clips/src/gpt55-review.ts`
  - Fixed fake NotebookLM-compatible parser responses by adding `conversation_id`.
- `packages/clips/src/run-gpt55-analysis.ts`
  - Fixed unknown catch error handling.
  - Restored model string to `gpt-5.5`.
- `packages/clips/src/lib/motion.ts`
  - Fixed ffmpeg zoompan expression to use `on/30`, escaped commas, and multiplication instead of `^`.
- `packages/clips/src/lib/visual-qa.ts`
  - Creates frame extraction directory before ffmpeg frame extraction.
- `packages/clips/src/orchestrate.ts`
  - Fixed GPT/NotebookLM fallback flow.
  - Removed hardcoded feedback cwd.

## Bottom line

The pipeline is worth continuing. The biggest wins are not more random features; they are reliability and learning loops:

- hard story/QA gates
- reliable LLM transcript analysis
- ffmpeg render stability
- analytics-driven scoring updates
- competitor pattern learning feeding titles/hooks

The repo is now build-clean, but I would not call it production-ready until one real stream completes through candidate generation, render, QA, thumbnail, metadata, and pre-upload review.
