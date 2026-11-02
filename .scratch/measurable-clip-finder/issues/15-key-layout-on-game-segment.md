# Key layout on the game segment

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —

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
