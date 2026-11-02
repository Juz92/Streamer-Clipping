# Research: is the Twitch crowd route available for current VODs?

Ticket: [03-twitch-crowd-route.md](../issues/03-twitch-crowd-route.md)
Map: [A measurable clip-finder](../MAP.md)
Date: 2026-11-02
Method: local on-disk evidence first, then live `yt-dlp` probes against both
platforms, then primary API/source docs. Every number below was either read off
a file in `data/clips/` or produced by a command run today.

**Headline: the crowd route lives, and it is cheaper than the ticket assumed.**
He simulcasts. The Twitch and YouTube timelines of the same stream start within
**0–9 seconds of each other**, measured on 7 matched pairs. The route does not
need a Twitch API key and does not even need `vod_offset` — a clip's
`createdAt`, which `yt-dlp` already exposes, minus the YouTube VOD's
`release_timestamp` lands the anchor directly in the file `discover.ts`
downloads. Verified against transcript on live data.

The zero on job-006 was **not** an API failure. No code to produce the route has
ever existed.

---

## 1. Does Get Clips still return `video_id` and `vod_offset`, and when is the offset null?

**Yes, both fields are still documented and current.** From the Twitch API
reference, Get Clips response ([dev.twitch.tv/docs/api/reference#get-clips]):

- `video_id` — "An ID that identifies the video that the clip came from." The
  field is **an empty string if the video is not available**.
- `vod_offset` — "The zero-based offset, in seconds, to where the clip starts in
  the video (VOD)." It is **null** when the video is not available or has not
  yet been created from the live stream, and there is a **propagation delay of
  minutes** after a clip is made during a live broadcast before the offset is
  populated.

So `vod_offset` is null in three distinct situations, and they have very
different operational weight:

| Cause | Window | Matters here? |
|---|---|---|
| Clip just made, offset not yet propagated | minutes | No — we process after the stream ends |
| Broadcaster had "Store past broadcasts" off | permanent | No — his VODs demonstrably exist |
| **Source VOD has expired** | **after 60 days** | **Yes — this is the real limit** |

The 60 days is the binding constraint and it is not a guess. Twitch's
on-demand-content help article sets retention at **60 days for Partners, Prime
and Turbo, 14 days for Affiliates, 7 days for everyone else**
([help.twitch.tv/s/article/video-on-demand]). Measured today, his Twitch
archive listing holds exactly **52 past broadcasts**, oldest `v2863657602` at
`timestamp 1788387473` (2026-09-02), newest `v2916201526` at `1793487697`
(2026-10-31) — a **60-day window**, confirming Partner retention empirically.

Consequence worth stating plainly: **clips outlive their VODs, offsets do not.**
For any stream older than 60 days — including job-006's (2026-07-16) — the clips
still exist and still carry view counts, but `vod_offset` is gone forever. A
crowd route built on `vod_offset` can only be run on fresh streams, and can
never be run retroactively over the archive. See §2 for why that does not
actually matter.

Request parameters relevant to harvesting, same source: `broadcaster_id`;
`first` (min 1, **max 100**, default 20); `started_at` / `ended_at` in RFC3339,
and "If not specified, the time window is the start date plus one week". So a
clean per-stream harvest is `started_at = stream start`, `ended_at = stream
end`, paginated at 100.

Cost: Get Clips needs an app access token — a `client_credentials` POST to
`https://id.twitch.tv/oauth2/token` with a registered app's client ID and
secret ([dev.twitch.tv/docs/api/guide]). Free, but it is a new credential the
project does not currently hold (no Twitch client ID or secret is referenced
anywhere in `packages/`). Default request cost is 1 point; the guide shows
`Ratelimit-Limit: 800` as an example header rather than a stated default, so
treat 800/min as indicative, not contractual. Either way, a few hundred clips
per stream is nothing.

---

## 2. Twitch or YouTube? — the pivotal fact

**He simulcasts the same live stream to both platforms, and the two timelines
start within seconds of each other.** This is the single most important finding
in this document and it is measured, not inferred.

The method: Twitch's VOD `timestamp` (stream start) against the YouTube VOD's
`release_timestamp` (the moment the live stream went live, distinct from
`timestamp`, which is the publish time of the archive). Matched by title theme
and duration.

### Pairs already on disk from the July scan

| Stream | Twitch VOD | Twitch start | YouTube VOD | YT `release_timestamp` | **Δ start** | Twitch dur | YT dur |
|---|---|---|---|---|---|---|---|
| Quest for the Black Key | `v2811618871` | 1783124288 | `wKJwi-MMLJQ` | 1783124297 | **+9 s** | 27230 | 26734 |
| America's Birthday party games | `v2812381177` | 1783210211 | `xQvGWXh58MQ` | 1783210211 | **0 s** | 27640 | 27646 |
| Chivalry 2 / Holdfast | `v2814633597` | 1783469391 | `gp4sqhiaxNo` | 1783469394 | **+3 s** | 27520 | 27198 |
| Slur Saturday party games | `v2817856735` | 1783815442 | `9WJKzVbhFBM` | 1783815440 | **−2 s** | 26000 | 25638 |

Sources: `data/clips/twitch-vod-*.json` (yt-dlp `-J` dumps, `timestamp` /
`duration`) and `data/clips/<id>-youtube-metadata.json` (`release_timestamp` /
`duration`).

### Pairs measured live today, on current streams

| Stream | Twitch VOD | Twitch start | YouTube VOD | YT `release_timestamp` | **Δ start** | Twitch dur | YT dur |
|---|---|---|---|---|---|---|---|
| 2026-10-31 | `v2916201526` | 1793487697 | `H_7jfyXeQ-I` | 1793487697 | **0 s** | 32250 | 32256 |
| 2026-10-29 | `v2914367867` | 1793315902 | `khtCd6MCUkI` | 1793315903 | **+1 s** | 26120 | 26127 |
| 2026-10-27 (nuke challenge) | `v2912599749` | — | `VZkl3s33Ryw` | 1793143296 | — | 41940 | 41945 |

Seven pairs, maximum start divergence 9 seconds, maximum duration divergence
~500 s (and that is end-trimming, not drift). This is OBS multi-streaming to
both platforms from one encoder, not a re-upload.

**So: the Twitch `vod_offset` → YouTube offset mapping is a per-stream additive
constant of under ten seconds, computable exactly from two metadata fields the
pipeline can already fetch.** The ticket's worst case — "different time origins,
useless without an alignment step" — does not apply. The alignment step is one
subtraction.

Two traps, both real and both cheap to handle:

1. **Titles differ between platforms.** `H_7jfyXeQ-I` is "AGE OF EMPIRES 4 | ME
   + THE #1 PLAYER..." while the same-second Twitch VOD `v2916201526` is "THE
   PEANUT GAMES | STREAMER MINECRAFT EVENT". Twitch VOD titles capture the final
   live title; YouTube keeps the one set at go-live. **Match on timestamp and
   duration, never on title.**
2. **VOD boundaries are not always 1:1.** Two July Twitch VODs ran 14 h 45 m
   (`v2815416917`) and 18 h 21 m (`v2816216400`), spanning more than one YouTube
   broadcast — e.g. YouTube `5CFiXyXf1ho` (`release_timestamp 1783599858`,
   2.5 h) starts inside `v2815416917`'s span. Match by interval containment
   (`ytStart ≤ t ≤ ytStart + ytDuration`), not by index or by position in a
   sorted list.

### The better route: skip `vod_offset` entirely

Because the timelines coincide, the anchor can be derived from a field that is
**permanent and needs no API key**:

```
youtubeOffsetSec = clip.createdAt − youtubeVod.release_timestamp
```

`yt-dlp`'s `TwitchClipsIE` exposes `createdAt` as `timestamp`
(`yt_dlp/extractor/twitch.py:1288` region: `'timestamp': ('createdAt',
{parse_iso8601})`). It does **not** expose `videoOffsetSeconds` — that is the
one thing only Helix (or raw GQL) gives you. But `createdAt` never expires with
the VOD, so this form of the route **works retroactively over the whole clip
archive**, which the `vod_offset` form cannot.

**Verified live.** Top clips from the 2026-10-27 nuke-challenge stream, anchored
by the formula against YouTube `VZkl3s33Ryw` (`release_timestamp 1793143296`),
then checked against that VOD's auto-captions:

| Clip | `createdAt` | Derived YT offset | Transcript at that offset |
|---|---|---|---|
| "Spawns ruins peanuts nuke" (2396 views) | 1793146282 | **00:49:46** | 00:49:15 "that guy spawned in the box that I was camping in"; 00:49:28 "I'm sitting at a tasty zero right now, but it's about to change to a one" — **dead on the moment** |
| "peanut hip thrusts an Egirl" (1634 views) | 1793147137 | **01:04:01** | 01:03:16 "In the game, of course. In Call of Duty"; 01:03:34 "Oh, they are edging" — **the right bit** |
| "get nuked" (1249 views) | 1793148735 | **01:30:39** | gameplay chatter, no obvious nuke — **miss or loose clip title** |

Two of three land inside the moment; all three land inside the correct VOD. In
both hits the anchor sits a few tens of seconds **after** the content starts,
which is exactly what you would expect — the clipper presses the button once the
funny thing has happened, and Twitch's default clip captures the preceding ~30 s
of a ~90 s buffer. **Search window `[anchor − 90 s, anchor + 30 s]`**, then hand
the window to the project's existing boundary machinery. That is precisely the
"crowd-selected event anchor with weak boundaries" the reassessment described,
and this project relabels boundaries anyway.

Volume: the clips tab paginated to **789 entries** today (with some duplicates,
ranked by views; the `range=7d` URL filter did not visibly constrain the
listing). Helix `started_at`/`ended_at` is the clean way to get a per-stream
window. Recall supply is not the problem.

---

## 3. What the on-disk July evidence actually shows

Read in full. It answers more than expected, including the real cause of the
zero.

**`twitch-archives-flat.json`** — a `yt-dlp --flat-playlist` dump of
"theburntpeanut - Past Broadcasts sorted by Date". **Proof he streams to
Twitch**, not a re-uploader. Note the `view_count` and `duration` values in this
flat dump are unreliable (e.g. 66050 s / 1.46 M views); the per-VOD `-J` dumps
are the trustworthy source.

**`twitch-vod-<id>.json`** (7 files) — full `yt-dlp -J` dumps. All seven:
`was_live: true`, `uploader: TheBurntPeanut`, **1920x1080 @ 60 fps**, durations
7 h 13 m to 18 h 21 m. All seven carry **`chapters`** — Twitch's game-category
segments with real second boundaries, e.g. `v2812381177`: MECCHA CHAMELEON
0–10957, Gamble With Your Friends 10957–15151, Super Battle Golf 15151–17263,
RV There Yet? 17263–23008, Liar's Bar 23008–27640. **None has subtitles** —
`requested_subtitles` empty, no `subtitles` key. So Twitch supplies structure
but no text; YouTube supplies the text. An unanticipated bonus: those chapters
transfer onto the YouTube timeline by the same ≤9 s offset, and the YouTube
sidecars record `"chapters": null`. **Twitch is the only source of per-game
segmentation for these streams.**

**`twitch-top-clips-7d-base.json`** — **this file is the reason the route
produced zero.** It is not API output. It is ten `schema.org/VideoObject`
JSON-LD records scraped out of the Twitch clips web page: `name`, `url`,
`uploadDate`, `duration` (ISO 8601, `PT41S`), a view count under
`interactionStatistic`, and an `embedUrl` pointing at the clip's own video
asset. There is **no `video_id` and no `vod_offset`** — JSON-LD never carried
them. Worse, all ten clips are dated **2026-06-11 to 2026-07-05**, and I checked
every one against the interval of all seven scanned Twitch VODs and all five
known YouTube VODs: **zero fall inside any of them.** The file is a top-10
all-time-ish leaderboard, not a per-stream harvest. Any route built on it would
return nothing no matter how good the alignment maths was. (One near-miss:
"Chef Nut" at 2026-07-05T07:56:39Z sits ~6 minutes past the end of
`v2812381177` — a reminder to allow tolerance at VOD boundaries.)

**`<id>-youtube-metadata.json`** (5 files) — the other half of the alignment
proof: `release_timestamp`, `duration`, `view_count`. Two of them (`gp4sqhiaxNo`,
`wKJwi-MMLJQ`) explicitly record **`"heatmap": null`** and `"chapters": null`.
That is a July data point for question 4, written down and then never acted on.

**`training/official-shorts/source-vod-alignments.json`** — the most useful file
on disk, and nothing in the ticket predicted it. A **working 5-gram transcript
alignment** that located 4 of 5 published Shorts inside their 7–12 h source
YouTube VODs, to sub-second precision: e.g. `uKPFN2lnbIY` → `ZHqpgNsR-OA`
576.56–643.839 s, coverage 0.61, 19 matching n-grams; `FssjkOnc7BE` →
`VVbP9gDZD80` 19788.878–19910.32 s. One unmatched (`3mCjc8hao6c`), zero
ambiguous. This proves the project **already owns a VOD-timeline locator that
works at ±1 s against an 11-hour haystack.** It is the natural refinement stage
behind a ±90 s crowd anchor, and it is already written.

**`job-006-2026-07-16/recall-union.json`** — 181 candidates. Route tally:
`semantic:humor` 133, `semantic:emotional-peaks` 25, `audio-peak` 19, `scorer`
19, `transcript-signal` 14, `semantic:friend-roasts` 8,
`semantic:story-of-stream` 5, `lane:peanut-bits` 4, `payoff:lol` 3,
`payoff:roast` 2, `lane:wtf-game-moments` 1. Evidence sources: `semantic` 171,
`scorer` 19. **No Twitch or crowd route entry of any kind.**

And the decisive code fact: `RecallSource` in
`packages/clips/src/lib/recall-union.ts:11` declares
`"semantic" | "scorer" | "manual" | "twitch-clip"` — and a repo-wide grep for
`twitch-clip` across `packages/` returns **that one line and nothing else.**
There is no harvester, no fetch, no writer. **The crowd route scored zero
because it was never built, not because Twitch refused it.** Any post-mortem
that treats the zero as evidence against the route's feasibility is reasoning
from an experiment that was never run.

---

## 4. Is YouTube's "most replayed" heatmap a substitute?

**No. It fails twice over — it is not served for these VODs, and even where it
is served its resolution is off by two orders of magnitude.**

### It is not served for these VODs

Measured today with `yt-dlp -J`:

| Video | Duration | Views | `was_live` | `heatmap` |
|---|---|---|---|---|
| `H_7jfyXeQ-I` | 32256 s | 1,370,376 | true | **None** |
| `AvlQIurK_Hs` | 27466 s | 1,281,971 | true | **None** |
| `khtCd6MCUkI` | 26127 s | 1,219,355 | true | **None** |
| `uKPFN2lnbIY` (control: a 62 s Short) | 62 s | 664,211 | false | **100 points** |
| `dQw4w9WgXcQ` (control) | 213 s | 1.83 B | false | **100 points** |

The controls rule out a broken code path or a client-selection problem: the
extractor works, it returns data on ordinary uploads, and it returns nothing on
these VODs. 1.37 M views is not an insufficient-views problem either. Add the
two July sidecars that already recorded `"heatmap": null` and that is **5 of 5
BurntPeanut VODs with no heatmap, across four months.** The common factor is
`was_live: true` — YouTube does not appear to generate most-replayed data for
long live-stream archives.

### Even if it were served, the resolution is unusable

`yt-dlp`'s YouTube extractor reads the heatmap from
`frameworkUpdates.entityBatchUpdate.mutations[].payload.macroMarkersListEntity.markersList`
filtered to `markerType == 'MARKER_TYPE_HEATMAP'`, mapping `startMillis`,
`durationMillis` and `intensityScoreNormalized`
(`yt_dlp/extractor/youtube/_video.py:2373`, `_extract_heatmap`). Every test case
in that extractor asserts `'heatmap': 'count:100'`, and both controls returned
exactly 100 points. The field contract is documented in
`yt_dlp/extractor/common.py:405`: `start_time`, `end_time`, `value` (0–1).

**The heatmap is always exactly 100 buckets spanning the whole video.** For a
9-hour VOD that is **~320 seconds per bucket**. We are hunting 30–60 s clips. A
single bucket is five to ten clips wide. Even a perfect heatmap on an 8 h stream
would tell you which five-minute block to look in, which is not an anchor — the
existing audio and transcript signals already localise better than that.

### `heatmap-extractor.ts` cannot work as written

`packages/clips/src/lib/heatmap-extractor.ts` does a bare `fetch` of the watch
page and regexes for `class="ytp-heat-map-path" ... d="..."`, falling back to
`"heatmap":"..."`. Neither target exists in the served HTML. `ytp-heat-map-path`
is an SVG element the **player JavaScript constructs at runtime** from
`ytInitialData`; it is not in the initial document. And `"heatmap"` is
`yt-dlp`'s *output* field name, not a key in YouTube's response — the real path
is `macroMarkersListEntity`, above. So `extractHeatmap()` returns `null` by
construction, on every video, for reasons unrelated to whether a heatmap exists.
`manifest.heatmapPath` being null in job-006 says nothing about YouTube; it says
the parser never had a chance. The whole module and its consumers
(`discover.ts:170-215`, `gemini-review.ts:291-303`,
`scoreHeatmapBonus`'s 0–15 point bonus) are dead weight — and per the map's
standing preference to prefer deleting a scorer to adding one, **the honest move
is to delete it**, not to repair it against a signal that would be too coarse
even if it worked.

### The real crowd signal on YouTube is chat, and it is already wired

Every one of these VODs carries a `live_chat` subtitle track (confirmed on all
three fetched today). The pipeline already downloads chat replay in
`discover.ts` and already parses it in `lib/chat-parser.ts` with 10 s binning.
That is crowd selection at 10-second resolution on the platform we download
from — 32× finer than a heatmap bucket, and it needs nothing new.

---

## What this means for the recall-routes decision

**The crowd route lives. Recommend keeping it, and building the cheap form.**

1. **Treat the job-006 zero as void evidence.** `twitch-clip` is a type literal
   with no producer. The route has never run. Nothing was learned about it in
   July except that a 10-item JSON-LD scrape is not a harvest.

2. **The route is cheap, not expensive.** The feared alignment problem is a
   subtraction of two integers that differ by under ten seconds. The minimum
   viable implementation needs **no Twitch credential at all**:
   - `yt-dlp --flat-playlist` the clips tab → clip IDs, titles, view counts
   - `yt-dlp` each clip → `timestamp` (= `createdAt`)
   - `yt-dlp -J` the YouTube VOD → `release_timestamp`, `duration`
   - anchor = `clip.timestamp − vod.release_timestamp`; emit window
     `[anchor − 90, anchor + 30]` with the clip's view count as crowd weight
   This fits the existing `RecallSource` slot and writes into `recall-union.json`
   like any other route. No scorer added; it is a recall producer.

3. **Add Helix only to buy precision.** An app access token (free, client
   credentials) upgrades the ±90 s `createdAt` anchor to an exact `vod_offset`,
   and `started_at`/`ended_at` give a clean per-stream clip window instead of
   paginating a view-ranked tab. Worth doing, but it is an optimisation, not a
   prerequisite — and it is the only part of the route with a 60-day expiry.

4. **Match streams by timestamp containment, never by title or index.** Titles
   diverge between platforms; Twitch sometimes merges several YouTube broadcasts
   into one long VOD. Allow a few minutes' tolerance at VOD boundaries.

5. **The ±90 s anchor is a feature, not a defect** — and the refinement already
   exists. `source-vod-alignments.json` proves the project's 5-gram transcript
   locator pins a known passage inside an 11 h VOD to sub-second precision. A
   crowd anchor narrows the haystack from 8 hours to 2 minutes; the existing
   boundary machinery takes it from there. This is exactly the division of
   labour the reassessment wanted from a recall route.

6. **Kill the heatmap route and `heatmap-extractor.ts`.** Not served for these
   VODs (0 for 5 across four months), 100-bucket resolution if it ever were,
   and a parser that targets markup YouTube does not emit. Three independent
   reasons; none is fixable by effort.

7. **Free side-benefit, worth a ticket of its own.** The Twitch VODs carry
   per-game `chapters` with real second boundaries, and the YouTube VODs carry
   `chapters: null`. Those boundaries transfer onto the YouTube timeline by the
   same ≤9 s offset. That is a game/segment label for every second of every
   stream, for free — which bears directly on the map's open "whether per-game
   layout constants survive" question, since it means discovery *can* hand off
   a per-segment game hint.

---

## Sources

Primary, API and source code:

- Twitch API Reference, Get Clips — `video_id`, `vod_offset`, `first`,
  `started_at`, `ended_at`: https://dev.twitch.tv/docs/api/reference/#get-clips
- Twitch API guide, app access tokens via `client_credentials` and rate-limit
  points: https://dev.twitch.tv/docs/api/guide/
- Twitch help, On-Demand Content — 60 / 14 / 7-day VOD retention by account
  type, "Store past broadcasts" toggle:
  https://help.twitch.tv/s/article/video-on-demand
- `yt-dlp` 2026.03.17 source, `YoutubeIE._extract_heatmap` —
  `macroMarkersListEntity` / `MARKER_TYPE_HEATMAP` path:
  `yt_dlp/extractor/youtube/_video.py:2373`
- `yt-dlp` source, heatmap field contract (`start_time`, `end_time`, `value`):
  `yt_dlp/extractor/common.py:405`; `'heatmap': 'count:100'` asserted in every
  YouTube extractor test case in `_video.py`
- `yt-dlp` source, `TwitchClipsIE` returned fields — exposes
  `timestamp` ← `createdAt`, does **not** expose `videoOffsetSeconds`:
  `yt_dlp/extractor/twitch.py:1140-1300`

Local evidence (main checkout, read-only):

- `data/clips/twitch-archives-flat.json`
- `data/clips/twitch-vod-{2811618871,2812381177,2814633597,2815416917,2816216400,2817043153,2817856735}.json`
- `data/clips/twitch-top-clips-7d-base.json`
- `data/clips/{wKJwi-MMLJQ,xQvGWXh58MQ,gp4sqhiaxNo,9WJKzVbhFBM,5CFiXyXf1ho}-youtube-metadata.json`
- `data/clips/training/official-shorts/source-vod-alignments.json`
- `data/clips/job-006-2026-07-16/{manifest.json,recall-union.json}`

Repo code:

- `packages/clips/src/lib/recall-union.ts:11` — `RecallSource` includes
  `"twitch-clip"`; no producer anywhere in `packages/`
- `packages/clips/src/lib/heatmap-extractor.ts` — targets `ytp-heat-map-path`
  and a `"heatmap"` JSON key, neither present in served HTML
- `packages/clips/src/discover.ts:170-215`, `gemini-review.ts:291-303` —
  heatmap consumers
- `packages/clips/src/lib/chat-parser.ts` — existing 10 s-bin chat crowd signal

Live probes run 2026-11-02 (all via `python -m yt_dlp`; `--ignore-config` needed
for Twitch because a config file points at a nonexistent
`C:/peanut/cookies.txt`):

- `https://www.youtube.com/@TheBurntPeanut/streams` — flat playlist
- `https://www.twitch.tv/theburntpeanut/videos?filter=archives&sort=time` —
  52 entries, 60-day span
- `https://www.twitch.tv/theburntpeanut/clips?filter=clips&range=7d` —
  789 paginated entries
- `-J` on YouTube `H_7jfyXeQ-I`, `AvlQIurK_Hs`, `khtCd6MCUkI`, `VZkl3s33Ryw`,
  `a3VGm40UOrY`, `uKPFN2lnbIY`, `dQw4w9WgXcQ`
- `--print` on Twitch `v2916201526`, `v2914367867`, `v2863657602` and five
  current clip slugs
- auto-caption VTT for `VZkl3s33Ryw` (5.7 MB), read at the three derived anchors

## Gaps and caveats

- **`vod_offset` was not observed directly.** No Twitch client ID or secret
  exists in this project, so Get Clips was never called; question 1 is answered
  from the documentation plus the retention measurement, not from a live
  response. The `createdAt` route in §2 was verified live and needs no token,
  which is why the recommendation leads with it.
- **Transcript verification was 3 anchors on 1 stream**, 2 clear hits and 1
  miss. Enough to show the arithmetic lands in the right place; not enough to
  quote a median anchor error. If that number is wanted, run the same check
  over ~30 clips from 2–3 streams.
- **`data/clips/twitch-clips-page.html` and `twitch-clips30d-page.html` could
  not be read** (permission denied on this machine). They are the raw pages the
  JSON-LD was scraped from and might contain `videoOffsetSeconds` in an embedded
  GQL payload; if they do, the offsets for those 10 June/July clips are
  recoverable without Helix. Not pursued — those clips do not overlap any
  processed VOD anyway.
- **Why YouTube withholds heatmaps on live archives is inferred**, from 5 of 5
  BurntPeanut VODs (all `was_live: true`) returning none while two ordinary
  uploads returned 100 points. I found no YouTube statement of the rule. The
  resolution argument (100 buckets) stands independently and is documented.
