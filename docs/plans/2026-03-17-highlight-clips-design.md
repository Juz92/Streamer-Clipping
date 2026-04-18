# Highlight Clips Pipeline — Design

## Problem
Text card scenes show white text on black backgrounds for 3-5 seconds each. In a typical 50s Short, ~20s is static text — a retention killer on Shorts/TikTok/Reels.

## Solution
Use `yt-dlp` + `ffmpeg` to download and crop highlight clips from YouTube compilations, then play them as background video behind text overlays with a dark gradient for readability.

## Pipeline Module: `highlights.ts`

### Usage
```bash
# Auto-download and crop highlight clips for all text_card shots
npx tsx packages/pipeline/src/highlights.ts --job <id>

# Or with a specific YouTube source URL
npx tsx packages/pipeline/src/highlights.ts --job <id> --source "https://youtube.com/watch?v=..."
```

### How It Works

1. **Search**: Uses `yt-dlp --flat-playlist` to search YouTube for `"<player-name> best goals skills highlights"` and picks the best compilation (official channels preferred, 2-10 min duration)

2. **Download segments**: For each text_card shot, downloads a 10s segment at a different timestamp using `yt-dlp --download-sections "*<start>-<end>"`

3. **Crop to portrait**: Uses `ffmpeg -vf "scale=-1:1920,crop=1080:1920"` to convert 16:9 landscape to 9:16 portrait, centering on the player and naturally cropping out scoreboards at the edges

4. **Strip audio**: Uses `ffmpeg -an` since we have our own voiceover track

5. **Register**: Saves clips to `data/assets/job-{id}/highlights/` and updates the visual plan's `backgroundClip` field for each text_card shot

### Visual Plan Integration

The `backgroundClip` field on `ShotPlan`:
```typescript
interface ShotPlan {
  // ... existing fields
  backgroundClip?: string; // Relative path to portrait highlight clip
}
```

### Remotion Integration

Scene components check `shot.backgroundClip` and render `<OffthreadVideo>` behind the text overlay with a dark gradient:
```tsx
{shot.backgroundClip && (
  <OffthreadVideo src={staticFile(shot.backgroundClip)} style={{ objectFit: "cover" }} />
)}
<div style={{ background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 40%)" }} />
```

### Timestamp Strategy

For a 5-minute compilation, distribute clips evenly:
- Hook: 0:05-0:15
- Setup text cards: 0:30-0:40, 1:00-1:10
- Turn text cards: 1:40-1:50
- Payoff text cards: 2:20-2:30, 2:50-3:00
- Sting: 3:20-3:30

### Dependencies
- `yt-dlp` (pip install)
- `ffmpeg` (already installed)

### Result
- Before: 42% of video was static black screens
- After: 100% of frames have visual content — highlight footage plays behind every text overlay
- File size: 42MB (up from 24MB) — more visual data = more engaging
</content>
</invoke>