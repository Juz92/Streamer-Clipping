# Where does the per-game layout hint come from?

Label: `wayfinder:grilling`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —

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
