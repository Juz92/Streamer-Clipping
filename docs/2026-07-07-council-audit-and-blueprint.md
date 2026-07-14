# Roast Council + Deep Audit + OpusClip Blueprint — 2026-07-07

Three skills run against the Streamer-Clipping project: **/roast** (5-persona council + Judge),
**/grill-me** (decision-tree interrogation, answered from the codebase where possible), and
**/figure-it-out** (aggressive research into how OpusClip/Eklipse actually do it), plus a
file-level deep audit of `packages/clips`.

---

## 1. THE VERDICT: RESHAPE

Confidence: **high**

**The call in one line:** Keep the pipeline, kill the business plan attached to it — repoint
monetization at the paid-clipping economy, invert the automation order (automate everything
*around* the final pick first), and get Peanut's written blessing this week.

**Why:** The council split cleanly: the engineering and the wedge are real (8-hour VODs +
chat-replay signal + retention feedback loop are things OpusClip doesn't have), but every
persona independently shredded the stated money route — gaming Shorts RPM is $10–70 *per
million* views behind a 10M-views-in-90-days gate, so the success case pays ~$100–700/quarter.
Meanwhile the paid-clipping economy (Whop campaigns $1–5/1K views, streamer retainers
$200–2K/mo) pays 20–300x for the identical output. And the automation is currently aimed at
the wrong step: the final pick is the highest-leverage judgment and the smallest time cost;
what's missing is everything around it (scheduler, resume, upload queue, closed feedback loop).

**Biggest risk:** The humor-detection gap stays unsolved while the factory gets more automated —
shipping worse clips faster into a channel whose ceiling is set by a small streamer's fame and
YouTube's inauthentic-content review. Secondary existential risk: no written permission from
The Burnt Peanut.

**Biggest upside:** A closed-loop clipper that learns from per-clip retention data is something
no commercial tool has (OpusClip is open-loop), it's half-built in this repo already
(`analytics.ts`, `feedback.ts`, `heatmap-extractor.ts`), and it compounds with every upload.

**Money read:** Own-channel RPM: years to first dollar, hobby money at best. Paid clipping:
first dollar in 30–60 days via a Whop campaign or one streamer rev-share deal ($0 upfront,
% of Shorts revenue — the Buyer persona said they'd "sign tomorrow" on that structure), *if*
the Peanut channel shows 30 days of daily uploads with a retention graph. Ship speed is not
the problem; evidence is.

**The cheapest 48-hour test:** Two things, zero build. (1) Take the two streams already on
disk, let the pipeline pick its top 15, independently hand-pick your own top 15, and measure
overlap — that number tells you exactly how far the picker is from automatable. (2) Message
The Burnt Peanut for written blessing (offer pre-upload veto + a rev-share conversation before
any money exists). If either fails, everything downstream changes.

**If RESHAPE:** The pivot: Peanut channel = live testbed + public portfolio, not the revenue
plan. Human keeps the final pick; automation owns detection→candidates→trim→render→QA→queue.
Log machine-pick vs your-pick agreement every stream; flip the pick to auto only when agreement
is proven on held-out streams. Sell *views* (campaigns/rev-share), not ads and not SaaS.

`Contrarian 2/10 · Expansionist 8/10 · Logician 5/10 · Researcher 4/10 · Buyer 4/10`

### The council in one line each
- **Contrarian (2/10):** Revenue math dead on arrival; YPP review rejects exactly this format at the moment of success; automation solves a volume problem a 1-clip/day strategy doesn't have; n=1 upload means nothing is validated.
- **Expansionist (8/10):** Chat-replay signal + closed retention loop are genuine moats; the money is in clipping economics (10–20x RPM); Peanut channel is the perfect zero-risk lab; the fleet is a config file away.
- **Logician (5/10):** Pipeline already over-provisioned (45 candidates/wk for 7 slots); chat replay is a free *human-labeled humor detector* — the "LLMs can't hear tone" problem is feature-plumbing, not physics; automate the pick last.
- **Researcher (4/10 → 7/10 if repointed):** RPM worse than assumed by 2–5x; OpusClip is a $215M-valuation knife fight and Powder (funded, gaming-specific) died in 2025; Whop/Vyro pay $1–5/1K for the same clip.
- **Buyer (4/10):** "You're automating the part that's already free (reaction detection) while the part every customer would pay for — humor — you still do by hand. Nobody buys the pipeline; they buy the taste."

---

## 2. GRILL-ME: the decision tree

Questions a relentless interviewer would ask, answered from the codebase where the code answers
them, with recommendations where only you can decide.

### Branch A — Purpose & economics
**Q1. What is this actually for — hobby, own-channel revenue, or service business?** `[YOUR CALL]`
Recommendation: testbed + paid-clipping service. The own-channel RPM route cannot be the goal
(see verdict). If it's a hobby/portfolio, own that and stop justifying sprints with future economics.

**Q2. Do you have The Burnt Peanut's written permission?** `[YOUR CALL — BLOCKING]`
Recommendation: ask this week. Buyer analysis says a small streamer's default is *endorse*
(free marketing) if you offer (a) pre-upload veto, (b) the revenue conversation before the first
payout, (c) proof of sub conversion ("clips sent you 40 subs this month").

**Q3. What's your API budget ceiling per stream?** `[YOUR CALL]`
Grounding: a full 10h low-res Gemini video pass ≈ **$1.40** (Flash), audio-only ≈ $1.20,
laughter detection locally ≈ $0. Budget is not the constraint you thought it was.

### Branch B — Automation scope
**Q4. What does "fully automated" mean — zero-touch to public, or zero-touch to a review queue?**
`[YOUR CALL]` Recommendation: zero-touch to a *private-upload review queue* (the pipeline already
uploads private-for-QA). Full auto-publish is a brand-safety risk with friend-group edgy banter —
one out-of-context clip burns the streamer relationship that the whole project depends on.

**Q5. What triggers a run today?** `[ANSWERED FROM CODE]` Nothing. No cron/polling exists;
orchestrate.ts must be manually invoked with `--url`/`--stream`. A `stream-detector` polling
loop (~6–8h work) is the single missing piece between "tool" and "system".

**Q6. What happens when the pipeline crashes 6 hours into an 8-hour run?** `[ANSWERED FROM CODE]`
Full restart. The manifest tracks coarse phases only (downloaded → analyzed → … → uploaded);
no per-step checkpoints, no partial-batch resume (3/15 failed renders = re-render all 15).

**Q7. How do the 3 LLM review paths interact?** `[ANSWERED FROM CODE]` GPT-5.5 if
`OPENAI_API_KEY` + `--use-gpt55`, else NotebookLM if available, else scorer-only. They produce
identical output types and can't be blended. `gemini-review.ts` is dead code — the real Gemini
review is post-render in `review.ts`. Regex parsing of free text, no structured output mode.

### Branch C — Clip finding quality
**Q8. Which scorer is actually live?** `[ANSWERED FROM CODE]` `enhanced-scorer.ts` (via
analyze.ts). `scorer.ts` is dead. So are `auto-trim.ts`, `humor-patterns.ts`, and the entire
scene trio (`scene-segmenter.ts`, `scene-scorer.ts`, `llm-humor-scorer.ts` — imported, never
called). ~1.3k LOC of confusion.

**Q9. What's the missing signal for humor?** `[ANSWERED BY RESEARCH]` Laughter. Friends
laughing IS the ground truth for "this was funny," and it's not words, so transcript keywords
structurally can't see it. Free local fix: jrgillick/laughter-detection or YAMNet. Second:
chat laugh-emote density (LMAO/💀/LUL) as a comedy-specific sub-signal distinct from raw rate —
research shows chat-rate models alone hit ~0.83 accuracy on highlight detection.

**Q10. How do you know a machine pick is good?** `[YOUR CALL + PROCESS]` Today: you don't —
zero real-stream validation since April (IMPLEMENTATION-TRACKER's "real stream end-to-end run"
is unchecked across two phases). Recommendation: agreement metric (machine top-15 vs your
top-15, every stream) + retention calibration. Treat all virality scores as ranking heuristics —
OpusClip's own users confirm theirs doesn't predict outcomes.

### Branch D — Content generation
**Q11. Are the A/B/C title variants actually tested?** `[ANSWERED FROM CODE]` No — generated,
uploaded, never tracked. Analytics can't attribute which variant won. Either track or stop
generating three.

**Q12. Are thumbnails reaction-aware?** `[ANSWERED FROM CODE]` Audio-peak frame with 0.3s
pre-bias only. No face/emotion check; can pick a dark or mid-blink frame. Cheap fix: score 5
candidate frames around the peak with the existing visual-qa pass and keep the best.

### Branch E — Distribution
**Q13. Can the pipeline hold the 1/day cadence automatically?** `[ANSWERED FROM CODE]` No
upload queue/scheduler exists. YouTube API quota supports max 6 uploads/day (1,600 units each
of a 10K/day default quota), so 15 private QA uploads costs 2+ days of quota — batch or request
an increase. TikTok/Reels are metadata-stubs only; both need app review/audit before public
API posting (TikTok unaudited = forced private; IG needs professional account + app review).

**Q14. Multi-streamer?** `[ANSWERED FROM CODE]` Not supported — single-tenant everywhere,
Peanut-specific keyword tiers and avatar crops hardcoded (with fallback regions in
render-fast.ts). Only worth building after Q1 resolves to "service."

---

## 3. DEEP AUDIT: what's actually there (and what isn't)

Full agent report highlights; file:line specifics preserved in the audit run.

### Dead / duplicated (delete list)
| File | Status |
|---|---|
| `lib/scorer.ts` | superseded by enhanced-scorer.ts — DELETE |
| `lib/auto-trim.ts` | superseded by enhanced-auto-trim.ts — DELETE |
| `lib/humor-patterns.ts` | orphaned, imported nowhere — DELETE |
| `src/gemini-review.ts` | fossil; real review is review.ts — DELETE |
| `lib/scene-segmenter.ts` + `lib/scene-scorer.ts` + `lib/llm-humor-scorer.ts` | imported by analyze.ts, never called — DELETE or actually wire |
| `run-gpt55-analysis.ts`, `check-models.js`, `test_zoom_expr.js` | diagnostics — DELETE |
| `tsconfig.tsbuildinfo` (both packages) | build cache in git — .gitignore |

### Structural oversights
1. **Feedback loop is write-only.** analytics.ts → clip-feedback.json → only
   notebooklm-scorer reads it. enhanced-scorer's 14 WEIGHTS and signals.ts keyword tiers never
   learn anything. The moat feature is half-wired.
2. **competitive-intel.ts output is consumed by nothing.**
3. **50+ tuning constants hardcoded across 8+ files** — no config file, no tuning without
   recompile, no per-channel override.
4. **Visual analysis is a post-render gate, not a pre-scoring signal.** Nothing looks at the
   video before render time except layout detection.
5. **Audio "laugh/shock" labels are heuristic guesses** (deltaFromAvg > 0.5), not detection.
6. **Zero tests** on scoring, trimming, rendering, orchestration, review gates (6 test files
   exist, all on parsers/pools).
7. **Everything since April is unvalidated** — build passes, dry-runs pass, no real stream
   has been through the current pipeline.

---

## 4. FIGURE-IT-OUT: the OpusClip blueprint, mapped to this repo

### How OpusClip actually works (reconstructed)
Whisper-class ASR → LLM-over-transcript segment detection (Classic) or video-LLM + audio-event
tagging over scene chunks (ClipAnything) → LLM rubric "virality score" (Hook/Flow/Value/Trend —
users report low predictive power; it's a ranking heuristic, not a predictor) → LLM hook/title
generation → face + active-speaker detection for 9:16 reframing → template captions → scheduler.
The marketing ("100M data points", "94% precision") is unverifiable; the techniques are
replicable. Crucially: **OpusClip's credit pricing (~1/min) makes a 10h VOD cost ~$150+/run —
it is economically hostile to exactly your use case.** Your pipeline's reason to exist is real.

### What Eklipse/Powder have that you don't (gaming-specific)
- **Game-event OCR**: kill-feed/objective detection over per-game templates, driving both
  moment detection and *dynamic clip boundaries* (6s simple play → 22s fight).
- **Emotion/laughter audio detection** (Powder marketed exactly this for "hilarious inside
  jokes and rage quits").

### The signal stack, ranked by impact for banter comedy + highlights
1. **★ Laughter/scream detection (local, free)** — jrgillick/laughter-detection or YAMNet
   (521 classes incl. laughter variants, screaming, cheering). New signal in `lib/signals.ts`.
2. **Few-shot LLM humor pass** — replace the zero-shot rubric with ~10 transcript exemplars of
   *proven Peanut winners* + inline audio/laughter/chat annotations in the prompt (research:
   FunnyNet-W, ACL 2025 multimodal-prompting — big uplift over zero-shot).
3. **Chat laugh-emote density** as its own sub-signal (already parse chat; new classifier line).
4. **Pitch/F0 arousal** — excited-voice-without-volume detection (librosa pyin, free); the
   sports-highlight literature says pitch rise + energy beats energy alone.
5. **YouTube Most-Replayed heatmap** — already extracted (`heatmap-extractor.ts`); yt-dlp ships
   it in info.json natively. Weight it heavily when present.
6. **Kill-feed OCR for Peanut's 2–3 games** — cropped region @ 1fps + PaddleOCR/Tesseract ≈ 80%
   of Eklipse's Layer 1 for a weekend of work. Unlocks the highlight (non-comedy) half.
7. **Gemini low-res full-VOD pass** — ~100–132 tok/s at low res → **~$0.14/hour on 2.5 Flash**
   (≈$1.40 per 10h VOD; batch API halves it). Chunk 30–45min, ask for MM:SS moment lists,
   re-verify top windows at default res. This is the ClipAnything equivalent, affordable.
8. Skip: trend-alignment scoring, B-roll (gameplay is the B-roll), active-speaker reframing
   (fixed avatar layout makes it moot).

### Upload/automation constraints (numbers that matter)
- YouTube Data API: 1,600 units/upload, 10K/day default → **6 uploads/day max**; unverified
  API projects force private (compatible with the QA flow); public flip needs verified project
  or manual Studio action.
- TikTok Content Posting API: unaudited = private-only, 5 users/day; audit required for public.
- IG Reels Graph API: professional account + app review; 100 posts/24h (non-issue).
- July 2025 "inauthentic content" policy: reused-content rules unchanged; per-clip hooks,
  captions, curation, 15-cap, 1/day cadence keep the channel on the safe side of it. The real
  YPP risk is at review time — human-touched variety in output is the defense.

---

## 5. PRIORITIZED ROADMAP

### Phase 0 — Evidence week (no new features)
1. Delete the dead-code list above (~1–2h). Add tsbuildinfo to .gitignore.
2. **Run one real stream end-to-end**, stop before upload, inspect all 15 outputs. Everything
   since April is theoretical until this happens.
3. **Pick-agreement test**: machine top-15 vs your independent top-15 on 2 streams on disk.
   This number decides how far full pick-automation actually is.
4. Message The Burnt Peanut for written blessing (veto + revenue conversation offer).

### Phase 1 — Make the picker see humor (the value layer)
5. Laughter/scream detector as a scored signal (local YAMNet/jrgillick, ~6–8h).
6. Chat laugh-emote density sub-signal (~2h).
7. Few-shot humor prompt: 10 proven-winner exemplars + inline signal annotations (~4h).
8. Close the feedback loop: clip-feedback.json → enhanced-scorer WEIGHTS + signals.ts tiers,
   not just notebooklm-scorer (~4–5h). Track title variants or stop making 3.
9. Externalize the 50+ constants to one config JSON with per-channel override shape (~4–6h).

### Phase 2 — Make it a system, not a tool
10. stream-detector.ts polling loop → auto-invoke orchestrator (~6–8h).
11. Per-step checkpoints + `--resume-from` + partial-batch re-render (~4–6h).
12. Upload queue with 1/day stagger inside YouTube's 6/day quota (~4h) + failure notifications
    (Discord webhook is fine).

### Phase 3 — Only after Q1/Q2 resolve
13. Multi-channel config + tenant isolation (service route only).
14. Kill-feed OCR for the highlight half.
15. Gemini low-res full-VOD pass as ClipAnything-equivalent (budget ≈$1.40/VOD).
16. TikTok/Reels API audits, or a $30–100/mo scheduler service instead.

---

## 6. Sources (key)
- OpusClip: opus.pro/clipanything, help.opus.pro virality-score docs, sacra.com/c/opusclip ($20M ARR, $215M valuation), eesel.ai teardown
- Eklipse gameplay-intelligence: blog.eklipse.gg/streaming-tips/how-gameplay-intelligence-works-2.html
- Laughter detection: github.com/jrgillick/laughter-detection; FunnyNet-W arXiv:2401.04210; ACL 2025 multimodal humor prompting
- Chat-based highlight detection ~0.83 acc: researchgate.net/publication/343522615
- Gemini video pricing/tokenization: ai.google.dev/gemini-api/docs/video-understanding, /pricing
- YouTube quota: developers.google.com/youtube/v3/determine_quota_cost; TikTok: developers.tiktok.com/doc/content-posting-api-get-started; IG: developers.facebook.com/docs/instagram-platform/content-publishing
- Clipping economy: Forbes "creator of clipping" (2026-04-26), clipaffiliates.com, digitalmusicnews.com contract-clippers
- Policy: socialmediatoday.com YouTube inauthentic-content clarification; support.google.com/youtube/answer/1311392
- Powder shutdown: powder.gg/pricing notice; xQc Clips economics: vidiq channel stats
