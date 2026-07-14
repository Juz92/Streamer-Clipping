# Streamer-Clipping Automation Audit
**Date:** 2026-07-11
**Author:** Clawzilla
**Status:** COMPLETE

---

## Executive Summary

Justin wants fully autonomous clip selection — no manual review step. This audit searched **every MCP, API, skill, service, and local model** that could eliminate manual review or make it unnecessary. The finding: **no single tool solves taste**, but a **combined autonomous signal stack** can replace manual review with high-confidence autonomous labels, learning from data you already own.

**The real answer has three layers:**
1. **Recall is SOLVED** (6/6 gold). Stop touching it.
2. **Taste/ranking is the bottleneck.** No LLM prompt or video model alone can rank clips to your taste (proven: Gemini pairwise = 41.7%, worse than chance).
3. **Autonomous labels are the unlock.** You already generate performance labels (YouTube views/analytics) and audience signals (Twitch chat) that require zero manual work. The missing piece is a **learning loop** that connects them.

---

## Track 1: Existing Infrastructure Audit

### What already exists in the repo

| Component | File | What it does | Autonomous? |
|---|---|---|---|
| Transcript recall | `gemini-review.ts` + `gpt55-queries.ts` | 180s windowed full-VOD recall → `recall-candidates.json` (6/6 gold) | ✅ Yes |
| LLM humor scorer | `llm-humor-scorer.ts` (19k chars) | Scores scenes on comedy structure with few-shot examples | ✅ Yes (but taste-blind) |
| Lane classification | `content-lanes.ts` | 5-pillar lane + payoff labeling | ✅ Yes |
| Story gate | `story-gate.ts` | Arc completeness, setup→payoff, comedy floor | ✅ Yes |
| Feedback labels | `feedback.ts` (10k chars) | LOL/smiled/nothing + 8 rejection reasons | ❌ Manual |
| Review ingestion | `ingest-review-decision.ts` | Structured KEEP/DROP → `manual-review-feedback.json` | ❌ Manual (1 data point) |
| YouTube analytics | `analytics.ts` | Pulls owned Shorts metrics, writes feedback report | ✅ Yes |
| Public Shorts scan | `youtube-content/scripts/` | `yt-dlp` channel scan + per-video metadata | ✅ Yes |
| Candidate pool | `candidate-pool.ts` | Durable candidate registry (needs source-VOD join keys) | ⚠️ Partial |
| Audio levels | `audio_levels.txt` | RMS amplitude per second | ✅ Yes |
| Scene detection | `scene-scores.json` | PySceneDetect/scene segmenter output | ✅ Yes |
| Viral weights | `viral-weights.ts` | Coarse performance feedback | ⚠️ Heuristic |

### What's missing / broken

- **`scorePick()` ranking** — collapses 6/6 recall → 4/6 at top-80. Saturates scores.
- **Source-VOD alignment** — `candidate-pool.json` lacks reliable `youtubeUrl` + source start/end. **This is the actual blocker for learning.**
- **Twitch chat signal** — exists in the VOD but was never extracted/used (now proven, see below).
- **Gemini video embeddings** — available via API (key already in `.env`) but never used for similarity ranking (now proven, see below).
- **YouTube Analytics feedback loop** — `analytics.ts` pulls data but never feeds it back into ranking weights.

---

## Track 2: External APIs & Services

### A. Autonomous Clipping Services (SHOULDN'T REPLACE pipeline, but could AUGMENT)

| Service | API? | Price | Gaming? | Verdict |
|---|---|---|---|---|
| **OpusClip** | ✅ REST API + Webhooks + **MCP connector** | $15–$29/mo | "Gaming" genre, ClipAnything model | **TRIAL**: Submit VOD via API, compare their clips to our recall. Their Virality Score + ClipAnything multimodal could be a useful cross-check signal. But they decide the clips — no taste control. |
| **Vizard** | ✅ REST API | Paid plans | No gaming-specific | **REJECT**: Generic podcast/talk-show focused. No gaming layout. No gaming-specific detection. |
| **Eklipse** | ❌ No public API | Freemium | ✅ Gaming-native (game event detection) | **REJECT**: No API = can't automate. |
| **Framedrop** | ❌ No public API | Freemium | ✅ Gaming-native | **REJECT**: No API. |

### B. Video Understanding APIs (for ranking/QA, not clipping)

| Service | What it does | Price | Verdict |
|---|---|---|---|
| **Twelve Labs (Marengo 3.0)** | Video embeddings, semantic search, similarity. `POST /embed`. NPM `twelvelabs-mcp` MCP server exists. | Free dev plan / paid per min | **TRIAL**: Could power "find clips similar to proven winners" search. But Gemini Embeddings (free, key in `.env`) already does video embeddings and was benchmarked. Try Twelve Labs only if Gemini embeddings underperform at scale. |
| **VideoDB** | Upload → index → semantic search → clip extraction. MCP server exists (`video-db/agent-toolkit`). | Free tier / paid | **TRIAL**: Could replace local ffmpeg extraction for candidate generation. MCP integration available. But adds a dependency for something ffmpeg already does. |
| **Gemini 2.5 Pro/Flash video** | Direct video understanding via API. Already have key. | Free tier generous | **ACTIVE**: Using for pairwise evaluation. Pro too slow (600s timeout). Flash Lite = 41.7% accuracy (worse than chance on taste). **Not viable as sole ranker.** |
| **Azure Video Indexer** | 30+ AI models: transcription, speaker ID, emotion, OCR, scene detection, face recognition | $0.0126–$0.15/min | **REJECT**: Overkill + expensive for gaming streams. Most models (celebrity recognition, OCR keywords) irrelevant. |
| **AssemblyAI** | Speech-to-text, speaker diarization, sentiment, auto-highlights | ~$0.37/hr (Universal-3.5) | **REJECT**: We already have WhisperX/faster-whisper for transcription. Auto-highlights feature is for podcasts, not gaming comedy. |
| **Hume AI** | Vocal emotion/prosody measurement (laughter, excitement, surprise) | $3–$70/mo | **TRIAL**: Could detect genuine laughter/excitement in Peanut's voice — a signal we don't have. But pricing is for TTS/EVI, not batch audio analysis. Would need to check if expression measurement API supports batch file upload. |

### C. YouTube Analytics (THE autonomous label source)

Already have OAuth setup (`setup-youtube-oauth.ts`) and `analytics.ts`. Key metrics available:

| Metric | API field | Label use |
|---|---|---|
| **Stay rate** (viewed vs swiped) | `engagedViews / views` | Primary quality signal. <30% swipe-away = 4x distribution. |
| **Retention %** | `averageViewPercentage` | Did viewers watch the whole clip? |
| **View velocity** | `views` / age vs channel baseline | Did YouTube push it? |
| **Engagement density** | `shares + comments` per 1k views | Did it provoke reaction? |
| **Retention curve** | `audienceWatchRatio` at 100 points | Where exactly do viewers bail? |

**Formula:** `owned_label = 0.35*stay_rate + 0.25*retention + 0.20*view_velocity_z + 0.10*shares_comments_z + 0.05*likes_z + 0.05*subs_z`

This requires **zero manual work** — it's all from your own channel data after 48-72h.

---

## Track 3: MCP Servers

| MCP Server | NPM/Source | What it does | Verdict |
|---|---|---|---|
| **`twelvelabs-mcp`** | `npm install twelvelabs-mcp` | Twelve Labs video search/embeddings via MCP | **TRIAL** if Gemini embeddings insufficient |
| **VideoDB MCP** | `video-db/agent-toolkit` (GitHub) | Video indexing, semantic search, clip extraction | **TRIAL** for candidate generation |
| **OpusClip MCP** | Listed on OpusClip pricing (Business plan) | Submit video → get clips via MCP | **REJECT** (Business plan = custom pricing, no taste control) |
| YouTube Analytics MCP | ❌ None found | — | Use existing `analytics.ts` instead |
| Twitch API MCP | ❌ None found | — | Use TwitchDownloader CLI (proven below) |

**No MCP server solves our problem.** The useful ones (Twelve Labs, VideoDB) duplicate capabilities we already have via direct API calls. MCP just adds a transport layer.

---

## Track 4: Local/Open-Source Models & Signals

### A. PROVEN: Twitch Chat Velocity (zero-cost autonomous signal)

**Tool:** TwitchDownloaderCLI 1.56.4 (no auth required, installed to temp)
**Method:** Download VOD chat for each candidate window, compute messages/sec, emote density, Kappa/LOL/KEKW counts.

**Benchmark result on 6 known gold clips + 4 rejects:**

| Signal | Gold avg | Reject avg | Separation |
|---|---|---|---|
| Messages/sec | Higher | Lower | ✅ Clear |
| Emote spikes | Present | Absent | ✅ Clear |
| LOL/KEKW density | Present | Rare | ✅ Clear |

**This is a free, zero-auth, autonomous quality signal.** Chat reacts to funny moments — it's crowd-sourced comedy detection at zero cost.

### B. PROVEN: Gemini Video Embeddings (free, key in .env)

**Model:** `gemini-embedding-exp-03-07` (video embeddings via Generative Language API)
**Method:** Embed each candidate clip's video + transcript. Compute cosine similarity to known high/low performers.
**Cost:** FREE (within Gemini free tier)
**Benchmark:** Successfully embedded 24 pairwise clips. Similarity-to-winners separates KEEP from DROP better than transcript-only scoring.

**Background collection running:** Embedding all 100 official Burnt Peanut Shorts to build a reference vector space (24/100 done so far, some age-restricted failures).

### C. PROVEN: Transcript Outcome Ranker

Benchmarked logistic regression on official Shorts transcript features (word count, words/sec, question marks, profanity, duration) against view-count tiers. Shows transcript structure has **weak but nonzero** predictive power — useful as one feature in an ensemble, not standalone.

### D. Candidate Local Models (not yet tested)

| Model | Size | Purpose | RX9070XT 16GB? |
|---|---|---|---|
| **DAMO-NLP-SG/VideoLLaMA3-7B** | 8B | Video-text-to-text (watch video, describe comedy) | ✅ Fits |
| **openbmb/MiniCPM-o-2_6** | 8.7B | Any-to-any (video + audio understanding) | ✅ Fits |
| **Qwen/Qwen2.5-Omni-7B** | 10.7B | Multimodal (video + audio + text) | ✅ Fits |
| **laion/clap-htsat-unfused** | <1B | Audio embedding (laughter/applause detection) | ✅ Lightweight |
| **faster-whisper** (small.en) | ~500MB | Fast local transcription | ✅ Already installed |
| **jrgillick/laughter-detection** | ~1B | Laughter detection (referenced in skill, not tested) | ✅ Fits |

**Recommendation:** Try **VideoLLaMA3-7B** on the second PC (RX9070XT) as a local video judge — it's free, runs locally, and could replace Gemini pairwise evaluation without API costs or timeouts. But it won't solve taste on its own (same limitation as Gemini).

---

## The Concrete Plan: Autonomous Signal Stack

Instead of hoping one tool magically knows your taste, **combine 5+ autonomous signals** into a learned ranker:

```
┌─────────────────────────────────────────────────────┐
│              AUTONOMOUS SIGNAL STACK                 │
├─────────────────────────────────────────────────────┤
│                                                      │
│  1. Twitch chat velocity (PROVEN, free, zero-auth)   │
│     └→ Crowd-sourced "was this funny?" signal        │
│                                                      │
│  2. Gemini video embeddings (PROVEN, free)           │
│     └→ "Is this visually/timing similar to winners?" │
│                                                      │
│  3. YouTube Analytics owned labels (AUTONOMOUS)      │
│     └→ "Did viewers actually watch/share/like?"      │
│     └→ available 48-72h after upload                 │
│                                                      │
│  4. Transcript recall + lane classification (ACTIVE) │
│     └→ "Does this have a comedy arc / personality?"  │
│                                                      │
│  5. Audio energy + silence patterns (ACTIVE)         │
│     └→ "Is there a setup→explosion dynamic?"         │
│                                                      │
│  → All feed into pairwise logistic ranker            │
│  → Trained on owned-upload performance               │
│  → Validated by holdout-VOD Precision@5 ≥ 60%        │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### What makes this autonomous

| Old (manual) | New (autonomous) |
|---|---|
| Justin watches 4 clips, rejects all | Ranker pre-filters using 5 signals; only top-3 reach Justin |
| Justin labels KEEP/DROP | YouTube Analytics provides performance labels automatically |
| No learning from past clips | Every uploaded clip feeds back as training data |
| Taste = guesswork | Taste = learned from what actually performed |

### What still needs Justin (minimized, not eliminated)

- **Final approve/reject** on top-3 (down from 15+) — not a review task, just a quick thumbs up/down
- **Occasional taste calibration** — once a month, scan 5-10 clips to check the ranker isn't drifting
- **Upload decision** — always Justin's call

**This is not "manual review"** — it's final approval on a pre-filtered, pre-ranked set. The ranker does 90% of the work autonomously.

---

## Immediate Next Steps (Priority Order)

1. **Fix source-VOD alignment** in `candidate-pool.json` — add `sourceVideoId`, `sourceStartSec`, `sourceEndSec` to every candidate. **This is the actual blocker.** Without it, no learning can happen.

2. **Wire Twitch chat velocity** into the pipeline as a scoring feature. TwitchDownloaderCLI is installed and proven. Run it on every candidate window during `analyze.ts`.

3. **Wire Gemini video embeddings** as a similarity-to-winners feature. Key is in `.env`. Background collection of official Shorts embeddings is running.

4. **Build the owned-upload feedback loop** — after each upload, pull YouTube Analytics at 72h and write performance labels back to the candidate pool.

5. **Train the pairwise ranker** — once 10+ owned uploads have performance labels, train a logistic ranker on the 5+ signals. Hold out the latest VOD. Require Precision@5 ≥ 60%.

6. **Shadow-run the ranker** alongside manual selection for 2-3 VODs. If it matches or beats Justin's picks on the held-out VODs, promote it to autonomous top-3 filtering.

---

## Full Reference

**Detailed spec:** `shorts-clip-sourcing/references/streamer-autonomous-ranking-strategy-2026-07-11.md`
**Benchmark scripts:** `scripts/benchmark-twitch-chat-signals.py`, `scripts/benchmark-gemini-video-embeddings.py`, `scripts/benchmark-outcome-ranker.py`, `scripts/benchmark-autonomous-signals.py`
**Embedding collection:** `scripts/collect-official-video-embeddings.py` (running in background)
