# Recover the chat replay route

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —

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
