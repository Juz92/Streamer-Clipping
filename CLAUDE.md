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
`discover → analyze → transcript scan → score & rank → extract clips → whisper captions → render 9:16 → thumbnails → upload metadata → QA → upload`

The automated analysis catches REACTIONS but misses HUMOR. The manual transcript scan is the most important step.

## Architecture
- `packages/clips/` — separate package, file-based state (no DB), depends only on `@ltx/shared`
- `packages/remotion/src/compositions/GamingShort/` — dual-panel Remotion composition
- Working dir: `data/clips/job-NNN-YYYY-MM-DD/` (auto-incrementing job numbers, date = stream date)
- External tools: yt-dlp (`python -m yt_dlp`), ffmpeg, ffprobe

## Key Commands
```bash
# Full pipeline (single command)
npx tsx packages/clips/src/orchestrate.ts                          # Latest stream, full pipeline
npx tsx packages/clips/src/orchestrate.ts --url <url>              # Specific stream
npx tsx packages/clips/src/orchestrate.ts --stream <id> --from analyze  # Resume from step
npx tsx packages/clips/src/orchestrate.ts --top 5 --dry-run        # Preview plan

# Individual modules
npx tsx packages/clips/src/discover.ts                    # Download latest stream
npx tsx packages/clips/src/discover.ts --list             # List 10 recent streams
npx tsx packages/clips/src/discover.ts --url <url>        # Specific stream
npx tsx packages/clips/src/analyze.ts --stream <id>       # 3-signal analysis + rank
npx tsx packages/clips/src/scan.ts --stream <id>          # Chunked transcript scanning
npx tsx packages/clips/src/preview.ts --stream <id>       # Pre-render QA frames
npx tsx packages/clips/src/render-fast.ts --stream <id> --clips 1,2,3   # Fast ffmpeg render
npx tsx packages/clips/src/clip.ts --stream <id> --moments 1,2,5       # Remotion render
npx tsx packages/clips/src/upload.ts --stream <id>                     # Upload all shorts to YouTube
npx tsx packages/clips/src/upload.ts --stream <id> --clips 1,3         # Upload specific clips
npx tsx packages/clips/src/upload.ts --auth                            # OAuth setup (first time)
```

## Clip Pipeline Modules (packages/clips/src/)
- `orchestrate.ts` — Full pipeline orchestrator: discover → analyze → clip → render → upload (--url, --stream, --from, --top, --dry-run)
- `discover.ts` — Find latest livestream, download video + auto-subs + chat replay via yt-dlp
- `analyze.ts` — Run 3 signal analyses, cross-reference, rank moments (--stream, --top, --json)
- `scan.ts` — Chunked transcript scanning with signal annotations (--around, --before, --search, --timeline, --merge)
- `preview.ts` — Pre-render QA: frame extraction, layout detection, caption check (--captions --edit for SRT export)
- `render-fast.ts` — Fast ffmpeg rendering, 5-10x faster than Remotion (--clips, --srt, --layout, --no-captions)
- `clip.ts` — Remotion rendering for complex compositions (--stream, --moments, --preview, --setup)
- `upload.ts` — YouTube Shorts upload via OAuth2 (--stream, --clips, --dry-run, --auth). Uploads as private for QA review.
- `lib/signals.ts` — Transcript (5-tier keyword weights + caps + sentiment) + chat signal detection
- `lib/audio-analyzer.ts` — Per-frame RMS extraction, spike detection (+20dB threshold), silence-to-loud transitions
- `lib/chat-parser.ts` — JSONL chat replay parsing, 10s binning, message rate + emoji density
- `lib/whisper-captions.ts` — faster-whisper transcription for accurate clip-relative word timing
- `lib/subtitle-parser.ts` — VTT parsing, word-level timestamp extraction, time-range filtering, clean transcript export
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
- ASS subtitle format with `\kf` per-word timing
- **Timing source**: faster-whisper on each raw clip (accurate clip-relative timing). Falls back to VTT if whisper-captions/ directory doesn't exist.
- White text (unspoken) turns yellow (spoken) word-by-word
- Arial Bold size 36, thin black outline, NO background box
- Gameplay: at join line (Alignment=8, MarginV=752)
- Talking: bottom third (Alignment=2, MarginV=200)
- **Why not VTT for timing**: YouTube auto-generated VTT word timestamps have variable 0.3-1.0s drift — inconsistent and unusable for precise karaoke. Whisper gives accurate word alignment.

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
  whisper-captions/            # 01-description.json (word-level timing per clip)
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

**CTA rules (CRITICAL — spammy CTAs hurt trust score and can violate policy):**
- Channel links are fine. "Subscribe" overlays, mid-video subscribe prompts, and aggressive follow CTAs are not.
- Descriptions: channel links only. No "smash that subscribe button" language.

## YouTube Shorts Algorithm (verified via NotebookLM analysis of creator research)

### Metric priority order
1. **Retention** — the primary signal. YouTube measures the graph by three traits: **height** (how many watch at all), **flatness** (how few drop off mid-clip), and **initial dip size** (how many swipe in the first 1-3s). Perfect retention overrules bad engagement.
2. **Trust Score** — hidden metric. How much YouTube believes pushing your video will keep people on the platform and generate revenue. Low trust = view jail regardless of content quality.
3. **Audience conversion** — converting new viewers into returning ones. One of the biggest signals for deciding who to push future content to.
4. **AVD** (Average View Duration) — secondary to retention shape.
5. **Engagement** — likes/comments/shares can rescue a mediocre clip. Comments are the strongest signal.

### The 30K seed audience
Every Short gets pushed to ~30,000 people initially (not the 1K-10K commonly cited). If it flatlines in the low thousands, that's a content problem. If it flatlines at 10K-20K, that's a retention/hook problem. **If it plateaus at 30K — that's actually good**: it means the content is good enough to go viral and YouTube is just building audience profiles. The next clip that resonates will get pushed to a much wider pool.

### Broad appeal = fastest growth
Clips that are funny or compelling to someone with **zero gaming knowledge** go viral faster on a new channel because the algorithm doesn't need audience data to place them. Peanut's best broad-appeal clips: friend roasts, absurd one-liners, crash-outs ("if you're homeless, just buy a home") — anyone gets these. Rust-specific plays only resonate once the channel has built an audience.

**Posting order rule:** Always lead the batch with the broadest-appeal clips. Post gaming-context clips after the channel has an established audience.

### Trust Score and view jail
- New channels must have "third-level feature eligibility" enabled in YouTube Studio (channel settings) — this is the single make-or-break factor for avoiding zero-view jail.
- Trust score increases significantly when new viewers become returning viewers. Consistency matters more than individual viral hits.
- After a first viral clip, YouTube enters a "honeymoon phase" — push more aggressively in the weeks immediately after a breakout.
- **Post-success trap:** Dropping upload frequency or quality after going viral can permanently reduce reach and restrict pushes to subscribers only.

### Upload cadence
- **Post one clip per day** from each batch. Don't dump all clips at once — stagger them to maximise each clip's individual seed audience test and allow YouTube to build trust incrementally.
- Each clip tests against a fresh 30K seed audience. Posting 5 clips in one day splits your data; posting them across 5 days gives each clip a proper test.

### Retention rules for clip construction
- The flash segment (first 2s) must eliminate the initial dip — show the peak moment immediately, make non-swiping the obvious choice
- Every second of content must earn its place. Dead air in the middle of a clip = graph dip = algorithm stops pushing it
- 25-45s total is the sweet spot. The 77s clips from early production had 44% retention — dead air in the middle was the cause
- Natural endings: the graph must not drop sharply at the end. End on completed sentences, natural pauses, or peak laughter — never mid-word or mid-sentence

## Peanut-Specific Signals
Catchphrases added to tier-1 signal detection:
- **"lock in"** — says before/during highlights and clutch moments
- **"hooray"** — celebration after doing something cool

---

## Key Learnings (Production Rules)

### 15-Clip Production Cap (NOT A RECALL CAP)
- Recall must remain complete. `analyze.ts` writes every lane-clearing scene and legacy signal anchor to `signal-recall.json`; transcript reviewers write all semantic nominations to `recall-candidates.json`; `recall-union.json` merges both with route evidence and no score cap.
- `notebooklm-moments.json` remains the ranked `--top N` production derivative (default 15). Rendering/review volume is capped there, after recall is preserved.
- `scan.ts mergeSources()` is also uncapped and source-time ordered. It must never regenerate IDs from rank.
- Override production volume with `--top N` on the orchestrator. Never reduce `recall-union.json` to make review easier; downstream grounding/ranking owns that decision.

### Caption Timing (CRITICAL)
- **YouTube VTT word timestamps are unreliable** — they have variable 0.3-1.0s drift with no consistent offset. Cannot be fixed with a global shift.
- **Always use faster-whisper** on raw clips for caption timing. It gives clip-relative, audio-accurate word timestamps. Model: `base.en`, ~1-2s per clip.
- Whisper may misrecognize gaming slang/proper nouns ("Amish" → "Amis") — this is acceptable for karaoke captions since timing accuracy matters more than text accuracy.
- Caption source priority in render-fast.ts: Whisper JSON > VTT with manifest ranges > VTT with JSON ranges.

### Clip Extraction
- Raw clips have a 2-second flash segment pre-pended before content. Flash comes from INSIDE the content time range (a "flash forward" to the peak moment).
- Caption words in the 0-2s range should be filtered out — they're from the flash segment.
- End times should snap to natural speech boundaries (parse VTT for sentence-ending punctuation near clip end).

### Layout Detection
- Auto-detected layout is unreliable. Always set `layoutMode` in `unified-moments.json` per clip after QC.
- Layout priority: CLI override > unified-moments.json > auto-detect.

### Manifest & Phase Tracking
- Phase progression: `downloaded → analyzed → notebooklm-reviewed → clipped → rendered → uploaded`
- `precise-clips-manifest.json` tracks actual content ranges (contentStart, contentDur) separately from unified-moments.json (which tracks suggested ranges). The precise manifest is the source of truth for what's actually in each clip.

### Rendering
- 2-pass render: first pass does layout (gameplay/talking + hook overlay), second pass burns in ASS subtitles.
- `renderClipFfmpeg` handles both passes. The subtitle pass re-encodes video but copies audio.
- Non-monotonic DTS warnings from aac encoder are cosmetic and don't affect output.

### Avatar Position
- Avatar position varies per game and per stream. Always QC frame extraction before batch rendering.
- RUST: bottom-left corner (avatarRegion `{x:180, y:780, w:420, h:300}`).
- When in doubt, extract a frame at t=5s from the raw clip and check.
