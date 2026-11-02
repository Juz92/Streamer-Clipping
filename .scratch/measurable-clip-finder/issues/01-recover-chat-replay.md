# Recover the chat replay route

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

**Chat is recovered. `job-006` now has a complete chat timeline, and the cause
was a two-minute timeout.**

### The chat data

| Measure | Value |
|---|---|
| File | `job-006-2026-07-16/source/chat.live_chat.json`, 51.0 MB |
| Raw replay lines | 35,809, **0 unparseable** |
| Parsed by `chat-parser.ts` | 32,417 messages in 443 ms |
| Distinct chatters | **7,714** |
| Timeline coverage | 0 s → 42,460 s against a 42,458 s stream — **100%**, no gaps |
| Density | median 43 messages/minute; 708 of 707 minutes carry chat |

The 7,714 distinct chatters matter specifically: the reassessment's chat route
requires unique-chatter and duplicate-message change detection and forbids raw
volume as a quality score. That signal is now computable.

### Root cause

`discover.ts` gave the chat download `{ timeout: 120_000 }` while the video
download beside it used `{ timeout: 0 }`. A 12-hour stream's chat replay cannot
complete in two minutes, so `execSync` killed it mid-fragment every time. The
36 MB `chat.live_chat.json.part` ending at `Frag532` is exactly that kill. The
complete file is 51.0 MB, so the old partial held roughly 70% of the stream and
was silently treated as nothing.

This was never a network blip and never needed a resume. Fixed by removing the
cap, matching the video download.

### A second, worse blocker found on the way

`%APPDATA%\yt-dlp\config.txt` contains:

```
--cookies C:/peanut/cookies.txt
--js-runtimes node
```

`C:\peanut\` does not exist, and a missing cookies file aborts **every** yt-dlp
invocation on this machine with `FileNotFoundError`. So `discover.ts` could not
download anything at all — not video, not subtitles, not chat. A valid
`cookies.txt` (220 rows, Netscape format) sits unused at the project root.

Fixed in-pipeline rather than by editing the user's global config: the cookies
flag is folded into the `YT_DLP` constant in `discover.ts`, so all six
invocation sites inherit it and an explicit command-line flag beats the stale
config. Overridable with `YT_DLP_COOKIES`.

**Still outstanding for Justin:** that global config is broken for every other
yt-dlp caller in the project (`analytics.ts`, `competitive-intel.ts`) and for
manual use. Point it at a real file or remove the line.

### Is live chat replay retrievable at this VOD's age?

**Yes, at 3.5 months.** `yt-dlp --list-subs` offers `live_chat json` for
`DRR2zh3YscM` (streamed 2026-07-16, checked 2026-11-02) and the download
completed to 100% coverage. The two other labelled streams could not be probed
because the cookies abort hit before the subtitle listing; retest now that the
override is in place.

### Preflight no longer degrades silently

`preflight.ts` passed `required: false` for `manifest.chatPath`, so a missing
chat was a WARN forever. It is now required at the `analysis` stage — where the
chat recall route actually reads it — and a warning elsewhere. Verified on real
data:

```
--stage analysis    → [BLOCK] manifest.chatPath: missing path in manifest
                      Preflight failed: 1 blocker(s), 0 warning(s).
--stage pre-render  → [WARN]  manifest.chatPath: path not present
```

`discover.ts` also no longer swallows a chat failure. A thrown yt-dlp error now
exits non-zero, matching how the video download already behaved; yt-dlp
succeeding while writing no file is still a warning, because that is a VOD with
genuinely no replay rather than a broken run.

### Environmental finding that blocks other tickets

The project lives inside OneDrive, **`OneDrive.exe` is not running**, and every
media file in `data/clips/` is a cloud-only placeholder that fails to read with
`errno 22`. The split is exact:

- **cloud-only and unreadable:** every `.mp4` (including `job-006`'s 11.5 GB
  `stream.mp4`), every `.ass` in `shorts/`, and the old chat `.part` files —
  which is why the partial could not even be salvaged.
- **local and fine:** every `.vtt`, `.json`, `transcript_clean.txt` and
  `audio_levels.txt`.

Starting OneDrive is Justin's to do. Two consequences recorded elsewhere:

- [10 — Run the three labelling sessions](10-run-labelling-sessions.md) assumed
  `job-005`'s five rendered shorts and `job-006`'s source were reviewable. They
  are not, until OneDrive hydrates them. Only `job-004`'s desk exercise is
  unaffected, since eligibility does not require media.
- [12 — Preflight passes files that cannot be read](12-preflight-trusts-placeholders.md)
  was created because preflight reported `[PASS] manifest.videoPath ...
  (10977.7 MB)` for a file nothing can open.

### Left alone deliberately

The stale `chat.live_chat.json.part` and `...-Frag532.part` orphans are still in
`job-006/source/`. They are now superseded and safe to delete, but deleting
data is Justin's call, not a side effect of this ticket.

## Question

Nothing to decide here. This is the manual work that unblocks every chat
decision on the map: get a complete chat timeline on disk for at least one real
BurntPeanut VOD.

Today there is none. `job-006`'s manifest carries `"chatPath": null` and
`"heatmapPath": null`, and `source/` holds a 35 MB `chat.live_chat.json.part`
plus an orphaned `chat.live_chat.json.part-Frag532.part` — the yt-dlp live-chat
download aborted mid-fragment on 2026-07-17 and was never retried. The
consequence is recorded in `shadow-scorecard.json`:
`"evidence": { "chat": false, "heatmap": false }`.

So two of the five designed recall routes have never run on real data, and the
2026-07-07 council audit's claim that chat replay is "a free human-labeled
humor detector" has never been tested.

Done when:

- a complete chat timeline exists for `DRR2zh3YscM` (job-006) or, if that
  replay is no longer retrievable, for a current VOD of comparable length;
- `manifest.chatPath` is populated and `lib/chat-parser.ts` parses it end to end;
- `preflight.ts` fails the job loudly when chat is missing, rather than
  degrading silently to transcript-only — the silent degrade is what hid this
  for four months;
- the answer records: which VOD, how many messages, what the fix was, and
  whether YouTube live-chat replay is reliably retrievable for VODs of this age
  (that fact changes whether chat can be a route at all, or only a route for
  freshly-captured streams).

## Comments
