# Key layout on the game segment

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Status: partially done — the game hint exists; the renderer still has to use it

## Progress, 2026-11-02

### Done: chapters become game segments on the YouTube timeline

Verified against the seven `data/clips/twitch-vod-*.json` dumps before building,
and the chapter titles really are game names with real boundaries:

```
twitch-vod-2814633597   0-18005  Chivalry 2
                    18005-27520  Holdfast: Nations At War
twitch-vod-2812381177   0-10957  MECCHA CHAMELEON   (a five-game party night)
```

**Nuance that qualifies ticket 11's rationale:** five of the seven VODs have a
single chapter spanning the whole broadcast. That is correct rather than a
shortcoming — a night spent on one game is one segment — but it means
per-segment granularity only appears when the game actually changes. The reason
to key on the game rather than the stream is unchanged, and it is the stronger
one: a game label generalises to future streams, where a streamId cannot.

Added to `lib/twitch-clips.ts`, next to the clip anchors as this ticket asked,
because it is the same simulcast-offset arithmetic:

- `toGameSegments(chapters, twitchRelease, youtubeRelease, youtubeDuration)` —
  shifts Twitch chapter boundaries onto the YouTube timeline and clamps them.
- `gameAtSec(segments, sec)` — the game covering a second, or **null**.

8 tests in `packages/clips/test/game-segments.test.ts`, using the real chapter
boundaries. One test exists purely to pin that `gameAtSec` returns null outside
every segment and that null is a real answer, not something to default away.

### Not done: the renderer still keys on streamId

`DAILY_PEANUT_STREAM_STYLE_OVERRIDES` in `render-fast.ts` is untouched, and so
is `lib/config.ts`. I stopped deliberately rather than guessing:

- the crops in there are hand-calibrated per stream *and per rank*, with exact
  pixel offsets chosen by looking at frames;
- there is no current-game stream on disk to calibrate a new entry against —
  `job-006` is Palworld from July, and the games now are Arc Raiders, Gears
  E-Day, Wardogs, CoD, AoE2 and Tarkov;
- a crop cannot be verified except by rendering and looking, so writing
  game-keyed crop values without a frame to check them against would be
  inventing numbers, which is the failure mode this ticket exists to stop.

What remains: move the crops into game-keyed config, block to manual QC on an
unknown game, demote `detectLayoutMode` to a QC proposal, and clean up
CLAUDE.md's unread per-game section. All of it wants one real current stream to
calibrate against, so it pairs naturally with the fresh-stream run.

Implements [11 — where does the per-game layout hint come from](11-per-game-layout-hint.md).

## Question

Nothing to decide. The decision is that layout config is keyed on the **game
segment**, derived from Twitch chapters, with per-stream overrides demoted to an
escape hatch and an unknown game blocking to manual QC rather than falling back
silently.

What must change:

- **Carry a game hint on the candidate.** Twitch VODs expose per-game `chapters`
  with real second boundaries; YouTube's are null. They transfer onto the
  YouTube timeline by the same simulcast offset `lib/twitch-clips.ts` already
  computes — `clipAnchorSec` is the same arithmetic, so the chapter harvest
  belongs next to it rather than in a new module.
- **Key the crops on that hint.** `lib/config.ts` currently holds one
  `avatarRegion` for the whole channel and `channel-config.json` does not exist.
  `DAILY_PEANUT_STREAM_STYLE_OVERRIDES` in `render-fast.ts` is the thing
  actually in use, keyed by streamId, with per-rank gameplay crops nested
  inside. The three entries there are all from July.
- **Block on an unknown game.** No silent fallback. A wrong avatar crop produces
  a short with Peanut half out of frame, which is worse than not rendering and
  looks identical to success in an automated run.
- **Demote `detectLayoutMode` to a proposal.** Keep it for display during QC, the
  way the labelling page shows pipeline proposals for confirmation, but it stops
  deciding anything. CLAUDE.md already records that it is unreliable.
- **Update CLAUDE.md.** Its per-game crops for Halo, Apex, CS2 and Rust are
  documentation nothing reads, for games he no longer plays. Either delete that
  section or point it at wherever the real config ends up.

Worth confirming while in here: whether a per-rank gameplay crop is still needed
once the key is the segment, or whether per-rank was only ever compensating for
the absence of a game key.

Done when a fresh stream renders with correct crops without anyone adding a
streamId entry by hand, and a stream in an unconfigured game stops with a clear
message instead of rendering something wrong.

## Comments
