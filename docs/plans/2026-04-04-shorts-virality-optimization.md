# Shorts Virality Optimization — Flash-Setup-Payoff Structure

**Date:** 2026-04-04
**Context:** First uploaded Short (poo particle, job-001) got 1.3k views, 34s avg duration, 44% retention. Research analysis confirms clips are too long (~77s) and hooks are too slow.

## Problem

44% retention is below the 60% "decent" threshold. The algorithm tested the Short with a small audience and stopped expanding because retention was too low for further distribution. The research shows 70%+ retention is where Shorts get pushed to 2-3 additional audience waves.

## Root Causes

1. **Clips too long (~77s).** At 77s, even 34s avg view duration = only 44% retention. The same viewer behavior in a 35s clip = 97% retention.
2. **Slow build-ups.** Comedy clips start with context/setup, but 50-60% of viewers swipe in the first 3 seconds before reaching the punchline.

## Solution: Flash-Setup-Payoff Structure

Every clip becomes a 3-segment structure:

### Segment 1 — FLASH (1-2s)
The peak reaction moment. Plays UNDER the hook text overlay. This ensures the viewer's first frame is high-energy, not a calm conversation.

### Segment 2 — SETUP (3-8s)
Bare minimum context for the punchline to land. Hard cut from flash.

### Segment 3 — PAYOFF (15-25s)
Build through punchline + full group reaction. End EXACTLY when laughter peaks — not when it dies down. The abrupt cut creates loop potential.

### Duration Targets

| Type | Target | Max |
|------|--------|-----|
| Comedy (roasts, stories) | 30-35s | 40s |
| Highlights (skill plays) | 15-25s | 30s |
| Crash-outs (rage/tilt) | 25-35s | 40s |
| Timeline (callbacks) | 30-40s | 45s |

### Hook Text Formula
- Line 1 (small): Setup/context — "He really said" / "This went" / "Nobody expected"
- Line 2 (big, CAPS): The hook word — curiosity gap, incomplete sentence
- Max 6-8 words total. Force the viewer to watch for resolution.

### End-Point Rule: Cut on Peak
End on the peak reaction, NOT the comedown. Abrupt cut after peak laughter makes people replay. This creates loop behavior (>100% avg % viewed).

## Visual Style (UNCHANGED)
- 2-panel for gameplay (avatar top 40%, gameplay bottom 60%)
- Zoomed avatar crop for talking/lobby moments
- Neon glow on white banner hook overlay (first 2s)
- Karaoke word-tracking captions (after 2s)

## Implementation
Uses existing `segments` array in merge JSON — no pipeline code changes needed. Each clip pick includes:
- `segments[0]` = flash (1-2s from peak moment)
- `segments[1]` = setup (3-8s of context)
- `segments[2]` = payoff (through punchline + reaction peak)

## Algorithm Targets (from research)
- Retention: 70%+ (currently 44%)
- Viewed vs Swiped: >75% (first 3 seconds)
- Loop rate: maximize via abrupt peak endings
- 48-hour boost window: post into peak audience hours
