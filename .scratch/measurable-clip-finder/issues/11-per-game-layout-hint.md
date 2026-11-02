# Where does the per-game layout hint come from?

Label: `wayfinder:grilling`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

**Decided by me, on Justin's instruction, same caveat as
[04](04-duration-and-boundary-policy.md): his to overturn.**

### First, this ticket described the code wrongly

It said avatar crops are "hardcoded per game". They are not. There is no
per-game anything in the code:

- `lib/config.ts` holds a **single** `ChannelConfig` with one `avatarRegion` and
  one `gameplayRegion` for the entire channel — and `channel-config.json` does
  not exist on disk, so `loadChannelConfig()` returns null.
- The crops that actually apply are `DAILY_PEANUT_STREAM_STYLE_OVERRIDES` in
  `render-fast.ts`, keyed by **streamId**, with per-**rank** gameplay crops
  nested inside. Three streams have entries: `wKJwi-MMLJQ`, `H-_9Fgs5tIg` and
  `gp4sqhiaxNo`. All three are from July. A new stream matches nothing.
- CLAUDE.md's per-game crops for Halo, Apex, CS2 and Rust are documentation
  that no code reads.

So the question was never "refresh the per-game constants or build a detector".
It is **what the layout config should be keyed on**, and the answer is now
cheap because of ticket 03.

### The decision

**Key layout on the game segment, not the stream.**

1. All seven Twitch VODs carry per-game `chapters` with real second boundaries
   while YouTube's are null, and those transfer onto the YouTube timeline by the
   same sub-ten-second simulcast offset the crowd route already uses. So a
   candidate's game is knowable from its timestamp, free, before any frame is
   examined. The hint rides on the candidate record.
2. **Per-stream overrides stay, demoted to an escape hatch** for a stream where
   the overlay genuinely moved mid-broadcast. They stop being the primary key,
   because keying on the stream guarantees staleness: every entry expires the
   moment the stream does, which is exactly the state the three July entries are
   in now.
3. **An unknown game blocks to manual QC. It never falls back silently.** A
   wrong avatar crop yields a short with Peanut half out of frame — worse than
   not rendering, and indistinguishable from success in an automated run. This is
   the same silent-degrade class as tickets 01 and 12.
4. **`detectLayoutMode` is retired as a decision source.** CLAUDE.md already
   records that auto-detection is unreliable and must be overridden by hand per
   clip. Keep it only as a *proposal* displayed during QC, the way the labelling
   page shows pipeline proposals for confirmation.

Answering the ticket's own question 4: per-stream variation is real (Apex lobby
versus in-game need different crops within one game), which is why the key is
the **game segment** rather than the game — a chapter boundary is a segment, and
a stream that changes game mid-session gets a new segment and a new crop.

Not implemented. Tracked as
[15 — Key layout on the game segment](15-key-layout-on-game-segment.md).

Graduated from the map's fog on 2026-11-02, once
[03 — Is the Twitch crowd route available for current VODs?](03-twitch-crowd-route.md)
established that discovery *can* hand off a per-segment game hint. The question
was unphrasable before that.

## Question

The destination includes visually-driven match highlights across several games,
and layout is where that currently breaks.

`lib/config.ts` and CLAUDE.md hardcode avatar and gameplay crop regions per
game, for **Halo, Apex, CS2 and Rust**. The streams now are Arc Raiders, Gears
of War E-Day, Wardogs, CoD, AoE2, Palworld and Tarkov. Every constant describes
a game he has stopped playing. CLAUDE.md's own standing rule — "Avatar position
varies per stream and per game. Always QC before rendering" — is an admission
that the constants are not trusted, and the reassessment separately records
that auto-detected layout is unreliable and must be overridden by hand per clip.

What is newly available: all seven Twitch VODs on disk carry per-game
`chapters` with real second boundaries, while the YouTube sidecars record
`chapters: null`. Those chapters transfer onto the YouTube timeline by the same
sub-ten-second simulcast offset. So a candidate's game can be known from its
timestamp, for free, before anything looks at a frame.

Decide:

1. **Does a game hint reach rendering at all?** Knowing the game is only useful
   if the hint rides on the candidate record through grounding and trim into
   `render-fast.ts`. That is a contract change, so it belongs with the recall
   decisions in [07](07-which-routes-and-scorers-survive.md), not after them.
2. **Refreshed constants per game, or a detector?** A config refresh is cheap
   and exact but goes stale the next time he picks up a game — which, judging by
   the four-month gap between the constants and reality, is the normal case. A
   general avatar detector costs more and never goes stale. The existing
   `lib/layout.ts` motion-based auto-detection is the third option and is
   already known not to work.
3. **What happens for a game with no entry?** Today `render-fast.ts` has
   fallback regions. If the hint says "Wardogs" and nothing is configured, does
   the clip block, fall back, or go to manual QC?
4. **Is per-stream variation real, or per-game?** CLAUDE.md claims both ("varies
   per stream and per game") and gives Apex two different crops for lobby versus
   in-game. If it genuinely varies within a single game, a per-game constant
   cannot be the answer and the question collapses into (2)'s detector.

Do not resolve this by refreshing the four stale constants to seven current
ones. That reproduces the exact failure this ticket exists to stop.

## Comments
