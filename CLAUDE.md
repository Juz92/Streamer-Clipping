# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Automated gaming clip extraction pipeline for The Burnt Peanut livestreams. Produces 9:16 Shorts for YouTube, TikTok, and Instagram Reels.

## Architecture

- npm workspaces monorepo with **3 packages**: `shared`, `clips`, `remotion`
- All TypeScript/Node.js, ESM modules (`"type": "module"`)
- Run TS files directly with `npx tsx packages/<pkg>/src/<module>.ts`
- Clips pipeline: file-based state (`manifest.json` per job, no DB)
- Video rendering: Remotion 4.x (React) OR direct ffmpeg (render-fast.ts)
- yt-dlp via `python -m yt_dlp` (not on PATH, installed as Python module)

## Key Commands
```bash
npm run build                    # TypeScript compilation
npx remotion studio              # Preview Remotion compositions (from packages/remotion)
npx tsx packages/clips/src/<module>.ts      # Run clips pipeline modules
```

---

# The Burnt Peanut — Streamer Clip Pipeline

**Source channel:** [The Burnt Peanut](https://www.youtube.com/@TheBurntPeanut) — gaming livestreams with peanut avatar.
**Clips channel:** [Daily Peanut Clips & Highlights](https://www.youtube.com/@DailyPeanutClipsHighlights) — curated Shorts from streams.

## Pipeline Flow
`discover → analyze → transcript scan → score & rank → extract clips → render 9:16 → thumbnails → upload metadata → QA → upload`

The automated analysis catches REACTIONS but misses HUMOR. The manual transcript scan is the most important step.

## Architecture
- `packages/clips/` — separate package, file-based state (no DB), depends only on `@ltx/shared`
- `packages/remotion/src/compositions/GamingShort/` — dual-panel Remotion composition
- Working dir: `data/clips/job-NNN-YYYY-MM-DD/` (auto-incrementing job numbers, date = stream date)
- External tools: yt-dlp (`python -m yt_dlp`), ffmpeg, ffprobe

## Key Commands
```bash
npx tsx packages/clips/src/discover.ts                    # Download latest stream
npx tsx packages/clips/src/discover.ts --list             # List 10 recent streams
npx tsx packages/clips/src/discover.ts --url <url>        # Specific stream
npx tsx packages/clips/src/analyze.ts --stream <id>       # 3-signal analysis + rank
npx tsx packages/clips/src/scan.ts --stream <id>          # Chunked transcript scanning
npx tsx packages/clips/src/preview.ts --stream <id>       # Pre-render QA frames
npx tsx packages/clips/src/render-fast.ts --stream <id> --clips 1,2,3   # Fast ffmpeg render
npx tsx packages/clips/src/clip.ts --stream <id> --moments 1,2,5       # Remotion render
```

## Clip Pipeline Modules (packages/clips/src/)
- `discover.ts` — Find latest livestream, download video + auto-subs + chat replay via yt-dlp
- `analyze.ts` — Run 3 signal analyses, cross-reference, rank moments (--stream, --top, --json)
- `scan.ts` — Chunked transcript scanning with signal annotations (--around, --before, --search, --timeline, --merge)
- `preview.ts` — Pre-render QA: frame extraction, layout detection, caption check (--captions --edit for SRT export)
- `render-fast.ts` — Fast ffmpeg rendering, 5-10x faster than Remotion (--clips, --srt, --layout, --no-captions)
- `clip.ts` — Remotion rendering for complex compositions (--stream, --moments, --preview, --setup)
- `lib/signals.ts` — Transcript (5-tier keyword weights + caps + sentiment) + chat signal detection
- `lib/audio-analyzer.ts` — Per-frame RMS extraction, spike detection (+20dB threshold), silence-to-loud transitions
- `lib/chat-parser.ts` — JSONL chat replay parsing, 10s binning, message rate + emoji density
- `lib/subtitle-parser.ts` — VTT parsing, word-level timestamp extraction
- `lib/scorer.ts` — Composite scoring: signal overlap 35%, chat 25%, audio 20%, virality 15%, duration 5%
- `lib/manifest.ts` — JSON state tracking, `getJobDir()` with `job-NNN-YYYY-MM-DD` naming
- `lib/layout.ts` — Gameplay vs talking mode auto-detection via frame motion analysis
- `lib/config.ts` — Channel config (avatar/gameplay region coordinates per streamer)

## Signal Analysis
- **Transcription**: 5-tier keyword weights (0.9 "no way"/"lock in"/"hooray" → 0.5 "so basically"), ALL CAPS clusters, sentiment. Requires 2+ distinct hits per window.
- **Chat replay**: Message frequency spikes >1.5 stddev above mean (10s bins), emoji density, keyword floods (3+ occurrences)
- **Audio**: Volume spikes +20dB above 30s running average, silence-to-loud transitions (<-40dB → >-20dB)
- **Hard filter**: Moments need 2+ signal types + audio >=22dB + transcript weight >=0.8 (comedy path), OR massive audio/chat spikes (highlight path)

## Layout Modes
- **Gameplay** (2-panel): Avatar top 40% (768px) + gameplay bottom 60% (1152px)
- **Talking** (single crop): 9:16 crop centered on avatar, scale to 1080x1920

**Avatar position varies per stream and game.** Always QC before rendering:
- Halo: bottom-left corner (x:80-420, y:580-1080)
- Apex lobby ("THE BUNGULATOR"): CENTERED on stage. Crop: `crop=607:1080:550:0`
- Apex in-game: bottom-left corner (x:~100, y:~850)
- CS2: varies — check each stream

## Approved Visual Style (DO NOT CHANGE without user approval)

**Hook overlay (first 2 seconds):**
- Full-width white banner bar (white@0.85, 140px for 2-line / 80px for 1-line)
- Yellow text with black outline + orange glow shadow ("Neon Glow" style)
- Line 1: Impact fontsize 54, borderw 5, shadowcolor=0xFF6600@0.7
- Line 2: Impact fontsize 70, borderw 6, shadowcolor=0xFF6600@0.8
- Uses ffmpeg `drawtext` with `enable='lt(t,2)'` — NOT ASS styling
- Banner MUST fully cover text top-to-bottom

**Karaoke captions (after 2 seconds):**
- ASS subtitle format with `\kf` per-word timing from VTT
- White text (unspoken) turns yellow (spoken) word-by-word
- Arial Bold size 36, thin black outline, NO background box
- Gameplay: at join line (Alignment=8, MarginV=752)
- Talking: bottom third (Alignment=2, MarginV=200)

## 3-Stage QA Process (MANDATORY — no exceptions)

**Stage 1: Pre-render** — Extract frame from EACH raw clip. Classify layout per-clip individually. Note avatar position.

**Stage 2: Test render** — Render ONE gameplay + ONE talking clip. QC frame at t=1s (hook) and t=10s (captions). Fix before batch.

**Stage 3: Post-render** — Extract + inspect frame from EVERY rendered short. Report failures before declaring done.

## Job Folder Structure
```
data/clips/job-NNN-YYYY-MM-DD/
  manifest.json                # Pipeline state + paths
  source/                      # stream.mp4, stream.en.vtt, transcript_clean.txt
  analysis/                    # audio_levels.txt, moments.json, clip-scores.xlsx
  raw-clips/                   # 01-description.mp4 (ranked by virality)
  shorts/                      # 01-description.mp4 (rendered 9:16)
    karaoke-NN.ass             # Per-clip ASS caption files
    thumbnails/                # yt-NN.jpg + tt-NN.jpg per clip
  upload-metadata.md           # Titles, descriptions, hashtags per platform
```

## Upload Metadata
Every job generates `upload-metadata.md` with per-clip:
- YouTube Shorts title (under 70 chars, hook-style)
- TikTok caption (with hashtags inline)
- Reels caption
- YouTube description (2-3 sentences + channel links + hashtags)

**Channel links (always include):**
- Streams: https://www.youtube.com/@TheBurntPeanut
- Clips: https://www.youtube.com/@DailyPeanutClipsHighlights

## Peanut-Specific Signals
Catchphrases added to tier-1 signal detection:
- **"lock in"** — says before/during highlights and clutch moments
- **"hooray"** — celebration after doing something cool
