# Build the crowd-route harvester

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Closed: 2026-11-02 — see [Resolution](#resolution)

## Question

Nothing to decide. [03](03-twitch-crowd-route.md) established that the crowd
route works, is cheap, and had never been built: `RecallSource` at
`recall-union.ts:11` declared `"twitch-clip"` and a repo-wide grep returned that
one line and nothing else. This is the implementation.

Ticketed after the fact, on the user's instruction to build it while away.

## Resolution

**Built and verified end to end. 16 crowd anchors on a stream that previously
produced zero.**

### Files

- `lib/twitch-clips.ts` — the anchor maths, pure and tested: containment,
  anchor arithmetic, window padding, stable ids, and a tolerant parser for
  yt-dlp's `--dump-json`.
- `harvest-crowd-route.ts` — the CLI. `--stream <youtubeId>`, optional
  `--channel` and `--limit`. Writes `crowd-anchors.json` to the job directory.
- `lib/yt-dlp.ts` — cookie resolution extracted so `discover.ts` and the
  harvester share one definition instead of duplicating it.

### Verified on real data

Ran against the COD MW4 nuke-challenge VOD (`VZkl3s33Ryw`, 11.6 h) through an
isolated `LTX_DATA_DIR`, so no real job directory was touched:

```
VOD VZkl3s33Ryw: broadcast started 2026-10-27T..., 11.65h
Fetched 60 clips from twitch.tv/theburntpeanut
16 of 60 clips fall inside this VOD
  00:07:32  nobody remembers
  00:49:46  Spawns ruins peanuts nuke
  01:30:39  get nuked
  ...
  09:35:43  A cloakzy moment
```

Anchors span the full broadcast rather than clustering, windows run 125–180 s,
every window falls inside the VOD, and Twitch view counts (87 → 2,494) ride
along as `score`. The 00:49:46 figure matches ticket 03's independent
measurement of the same clip exactly.

### Two traps found and encoded

**Use `release_timestamp`, never `timestamp`.** On this VOD they are
`1793143296` and `1793197854` — about fifteen hours apart, because one is the
broadcast start and the other the publish time. Picking the wrong one puts every
anchor outside the video and raises no error. There is a test whose only job is
to fail if that is ever swapped.

**`--flat-playlist` leaves `release_timestamp` null**, so the VOD window needs a
per-video extraction. A channel listing cannot supply it, which is why the first
attempt at this measured nothing.

### yt-dlp's exit code is not evidence

It emits every record and *then* dies, because the stale user config points
`--cookies` at `C:/peanut/cookies.txt` and the cookie writeback fails. Observed
again during the verification run: the traceback printed mid-run and the
harvester completed correctly. `runTolerant()` keeps stdout from a non-zero exit
and the parser skips non-JSON, so warnings and tracebacks cost nothing. Fixing
that global config is still [01](01-recover-chat-replay.md)'s outstanding item
for Justin.

### Deliberately not done

**The anchors are not wired into `recall-union.json`.** Which recall routes
survive is [07](07-which-routes-and-scorers-survive.md)'s decision, and wiring
them now would pre-empt it. They are already in `RecallAnchor` shape, and
`mergeRecallAnchors(jobId, anchors)` is the single entry point, so that stays a
one-line change.

**The ±90 s window rests on thin evidence.** Three confirmed anchors from one
stream suggested clippers press late, so the window leads by 90 s and trails by
30 s plus the clip's own duration. Carries a `ponytail:` comment naming the
ceiling; revisit once [10](10-run-labelling-sessions.md) yields a median anchor
error over roughly 30 clips.

**Clips age out at 60 days.** Twitch's archive measured exactly 60 days, so this
route returns nothing for `job-006` (July). It works from the next stream
onward, and retroactively over whatever is still in the archive.

### Tests

`packages/clips/test/twitch-clips.test.ts` — 9 tests from fixtures captured live
today. Suite now 176 tests, 174 passing; the 2 failures remain the worktree
artifacts recorded in [09](09-freeze-label-schema.md).

## Comments
