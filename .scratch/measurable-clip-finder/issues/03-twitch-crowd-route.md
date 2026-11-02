# Is the Twitch crowd route available for current VODs?

Label: `wayfinder:research`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

Findings: [research/03-crowd-route.md](../research/03-crowd-route.md).

**The crowd route lives, is cheap, and was never built.**

The zero on job-006 was void evidence. `RecallSource` at `recall-union.ts:11`
declares `"twitch-clip"` and a repo-wide grep returns that one line and nothing
else — no harvester, no fetch, no writer. It could not have run.

**He simulcasts.** Across seven matched stream pairs, Twitch VOD start versus
YouTube `release_timestamp` diverged by 0, 0, +1, −2, +3 and +9 seconds;
durations within ~500 s from end-trimming. One encoder multistreaming, not a
re-upload. The alignment step this ticket feared is a subtraction of two
integers less than ten seconds apart.

**No Twitch token and no `vod_offset` required.** `yt-dlp`'s clips extractor
exposes `createdAt` as `timestamp` (it does *not* expose
`videoOffsetSeconds`), so `anchor = clip.timestamp − vod.release_timestamp`.
Unlike `vod_offset`, this form does not expire when the source VOD does — and
his Twitch archive measured exactly 60 days (52 broadcasts, matching Partner
retention), so retroactive reach over the whole clip archive matters.

Verified live on one stream: 3 of 3 anchors resolved to the right VOD, 2 of 3
landed on the moment, each sitting a few tens of seconds *after* content start
because clippers press late. Suggested window `[anchor − 90, anchor + 30]`,
then hand to the existing boundary machinery.

Two traps: **titles differ between platforms**, so match on timestamp and never
title; and Twitch sometimes merges several YouTube broadcasts into one 14–18 h
VOD, so match by interval containment.

**The existing `twitch-top-clips-7d-base.json` is not what it looks like.** It
is ten `schema.org/VideoObject` JSON-LD records scraped off the clips web page,
not API output — no `video_id`, no `vod_offset`, and all ten dated
2026-06-11 → 2026-07-05. None falls inside any of the seven Twitch VODs or five
known YouTube VODs on disk. It is an all-time top-10 leaderboard, not a
per-stream harvest. Do not build on it.

**The heatmap is dead, for three independent reasons**, and
`manifest.heatmapPath: null` says nothing about YouTube:

1. **Not served.** `heatmap: None` on 3/3 current VODs including one at 1.37M
   views, plus the two July `null`s — 0 for 5 across four months. Controls (a
   62 s Short, and a short music video) both return 100 points, so the code path
   is fine; YouTube withholds it for long `was_live` archives.
2. **Resolution, if it ever were served.** yt-dlp's `_extract_heatmap` reads
   `macroMarkersListEntity` / `MARKER_TYPE_HEATMAP` and every extractor test
   asserts exactly 100 buckets — **~320 s each on a 9 h VOD**, five to ten clips
   wide.
3. **`heatmap-extractor.ts` cannot work as written.** It regexes the watch page
   for `ytp-heat-map-path`, an SVG the player JS builds at runtime rather than
   anything in the served HTML, and falls back to a `"heatmap":"..."` key that
   is yt-dlp's *output* field name, not a YouTube key. It returns `null` by
   construction on every video.

Recommended deletion, per the map's prefer-deleting-a-scorer preference:
`lib/heatmap-extractor.ts` and its consumers at `discover.ts:170-215`,
`gemini-review.ts:291-303`, and the 0–15 `scoreHeatmapBonus`. The real crowd
signal on YouTube is the `live_chat` track present on every VOD, already
downloaded by `discover.ts` and already binned at 10 s by `chat-parser.ts` —
32x finer than a heatmap bucket.

**Side-benefit for its own ticket:** all seven Twitch VODs carry per-game
`chapters` with real second boundaries, while the YouTube sidecars record
`chapters: null`. Those transfer onto the YouTube timeline by the same ≤9 s
offset, so discovery can hand a per-segment game hint downstream. This bears
directly on the map's open "do per-game layout constants survive" fog.

**Known limits, flagged by the researching agent:** Helix was never called (no
client ID or secret in the project), so the `vod_offset` expiry behaviour comes
from docs plus the measured 60-day retention, not a live response — though the
recommended `createdAt` route needs no token and *was* verified live. Transcript
verification covered 3 anchors on 1 stream, so there is no median anchor error
yet; ~30 clips over 2–3 streams would give one. The ±90 s window and the
"clipper presses late" asymmetry rest on two confirmed hits and should be
validated on a wider sample before being sized in code.
`data/clips/twitch-clips-page.html` was permission-denied and may hold
`videoOffsetSeconds` in an embedded payload, but its ten clips overlap no
processed VOD.

## Question

The reassessment made the crowd route Stage 2's first recall route, on the
reasoning that Twitch clips are crowd-selected event anchors with weak
boundaries — exactly the shape this project needs, since we relabel boundaries
ourselves anyway. It produced **zero** candidates on job-006.

Find out whether that route is actually available:

1. **Does Twitch's Get Clips endpoint still return `video_id` and `vod_offset`**
   for BurntPeanut's clips, and under what conditions does `vod_offset` come
   back null? The reassessment says it is exposed "when the VOD is available" —
   pin down what that means in practice, because Twitch VOD retention is
   limited and the offset is the whole value of the route.
2. **Do the YouTube VODs this pipeline downloads correspond to Twitch VODs at
   all?** `discover.ts` pulls from `@TheBurntPeanut` on YouTube. If he streams
   to Twitch and uploads to YouTube, the two have different time origins and a
   `vod_offset` is useless without an alignment step. If he streams natively to
   YouTube, there may be no Twitch clips to harvest. Determine which it is —
   this single fact decides whether the crowd route is cheap, expensive, or
   impossible.
3. **What does the existing on-disk evidence show?** `data/clips/` already
   holds `twitch-top-clips-7d-base.json`, `twitch-archives-flat.json` and
   seven `twitch-vod-<id>.json` files from a July scan. Read them before
   fetching anything: they may already answer (1) and (2).
4. **Is YouTube's own "most replayed" heatmap a substitute?** `manifest.heatmapPath`
   is null and `lib/heatmap-extractor.ts` exists but has never produced data.
   A heatmap is also crowd selection, on the platform we actually download from.
   Establish whether it is retrievable for these VODs and at what resolution.

Write findings to `.scratch/measurable-clip-finder/research/03-crowd-route.md`.
State plainly if the conclusion is that the crowd route cannot work as designed
— that is a useful answer and it would send the recall-routes decision
somewhere different.

## Comments
