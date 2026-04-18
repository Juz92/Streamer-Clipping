# AGENTS.md

## Project: The Burnt Peanut — Streamer Clip Pipeline

Automated gaming clip extraction from livestreams → 9:16 YouTube Shorts.

### Pipeline Steps (in order)
1. `discover.ts` — Download stream + VTT + chat
2. `analyze.ts` — 3-signal analysis (transcript + chat + audio)
3. `notebooklm-review.ts` — AI humor/moment review
4. `trim.ts` — Interactive clip trimming (browser)
5. `whisper-captions` — Transcribe raw clips for accurate word timing
6. `render-fast.ts` — 9:16 render with captions
7. `upload.ts` — YouTube upload

### Key Production Rules

- **Caption timing**: Use `faster-whisper` (base.en) on raw clips. YouTube VTT timestamps have 0.3-1.0s variable drift.
- **Flash segment**: Raw clips have 2s flash pre-pended. Filter caption words < 2s.
- **Layout mode**: Set per-clip in `unified-moments.json`. Don't trust auto-detect.
- **Clip end times**: Snap to speech boundaries (sentence-ending punctuation).
- **Avatar position**: Varies per game/stream. Always QC frames before batch render.

### Commands
```bash
npx tsx packages/clips/src/orchestrate.ts --stream <id>          # Full pipeline
npx tsx packages/clips/src/render-fast.ts --stream <id> --all    # Render all
npx tsx packages/clips/src/render-fast.ts --stream <id> --clips 1,3  # Specific clips
npx tsx packages/clips/src/upload.ts --stream <id>               # Upload
```

### External Dependencies
- `python -m yt_dlp` (not on PATH)
- `ffmpeg` / `ffprobe`
- `faster-whisper` Python package (`pip install faster-whisper`)
- `torch` (required by faster-whisper)
