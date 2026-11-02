import type { Region } from "./config.js";

// Older jobs sometimes have zeroed avatar coords in channel-config.json, so keep
// sane source-space defaults here instead of silently falling back to full-frame crops.
// Final v8 Daily Peanut layout (2026-07 learnings): source is 1920x1080.
// Top panel uses a wide left/center source crop, then zooms another ~25% and
// bottom-aligns so the avatar sits on the join line. Bottom gameplay uses a
// right-biased 1320x1080 crop to avoid duplicating the Peanut/dog facecam.
export const DAILY_PEANUT_AVATAR_REGION: Region = { x: 0, y: 0, w: 1620, h: 1080 };
export const DAILY_PEANUT_GAMEPLAY_REGION: Region = { x: 408, y: 0, w: 1320, h: 1080 };
export const DAILY_PEANUT_V8_GAMEPLAY_BY_RANK: Record<number, Region> = {
  1: { x: 276, y: 0, w: 1500, h: 1080 },
  2: { x: 408, y: 0, w: 1320, h: 1080 },
  3: { x: 408, y: 0, w: 1320, h: 1080 },
  4: { x: 252, y: 0, w: 1620, h: 1080 },
  5: { x: 960, y: 0, w: 960, h: 1080 },
  6: { x: 408, y: 0, w: 1320, h: 1080 },
};

export interface StreamStyleOverride {
  avatar?: Region;
  frame0Avatar?: Region;
  gameplay?: Region;
  gameplayByRank?: Record<number, Region>;
}

// Stream-specific house-style overrides, authored in 1920x1080 source space.
// gp4sqhiaxNo is a 720p Holdfast stream where the Peanut/avatar sits much
// smaller and lower/right than job-002. Reusing the job-002 wide-left avatar
// crop makes it look like the old/generic layout, with Peanut tiny in the top
// panel. These values map to roughly x120 y300 w520 h370 on 1280x720 source.
const DAILY_PEANUT_STREAM_STYLE_OVERRIDES: Record<string, StreamStyleOverride> = {
  "wKJwi-MMLJQ": {
    avatar: DAILY_PEANUT_AVATAR_REGION,
    gameplayByRank: DAILY_PEANUT_V8_GAMEPLAY_BY_RANK,
  },
  "H-_9Fgs5tIg": {
    // Peanut is bottom-left in both games on this VOD. Match the approved v8
    // zoom/lift and start gameplay immediately after the avatar silhouette.
    avatar: { x: 97, y: 684, w: 556, h: 396 },
    frame0Avatar: { x: 235, y: 560, w: 300, h: 520 },
    gameplay: { x: 560, y: 0, w: 1012, h: 1080 },
  },
  gp4sqhiaxNo: {
    // 1280x720 equivalent: x195 y353 w371 h264. This matches the approved v8
    // zoom/lift while preserving the shared bottom-aligned top-panel crop.
    avatar: { x: 292, y: 530, w: 556, h: 396 },
    frame0Avatar: { x: 330, y: 381, w: 390, h: 693 },
    // ponytail: exact 675x720 effective crops; leftmost edge per clip that
    // excludes Peanut. Re-probe only when the stream overlay moves.
    gameplayByRank: {
      1: { x: 540, y: 0, w: 1012, h: 1080 },
      2: { x: 540, y: 0, w: 1012, h: 1080 },
      3: { x: 600, y: 0, w: 1012, h: 1080 },
      4: { x: 540, y: 0, w: 1012, h: 1080 },
      5: { x: 540, y: 0, w: 1012, h: 1080 },
      6: { x: 480, y: 0, w: 1012, h: 1080 },
      7: { x: 600, y: 0, w: 1012, h: 1080 },
      8: { x: 600, y: 0, w: 1012, h: 1080 },
      9: { x: 600, y: 0, w: 1012, h: 1080 },
      10: { x: 720, y: 0, w: 1012, h: 1080 },
    },
  },
};

/**
 * Crops keyed by game, which is the unit that actually generalises.
 *
 * Keying on streamId guarantees staleness: an entry expires with the stream, so
 * every new broadcast needs fresh calibration even when it is the same game
 * with the same overlay. The three stream entries above are all from July 2026
 * and match nothing current.
 *
 * Intentionally empty. A crop cannot be verified except by rendering and
 * looking at the frame, so entries are added when someone calibrates against a
 * real frame of that game -- never guessed from another stream's numbers. Game
 * names come from Twitch chapters and must match them exactly, e.g.
 * "Chivalry 2", "Holdfast: Nations At War".
 */
const DAILY_PEANUT_GAME_STYLE_PROFILES: Record<string, StreamStyleOverride> = {};

/**
 * The style for a clip, most specific key first.
 *
 * A stream override beats a game profile because it exists precisely to handle
 * a broadcast where the overlay moved and the game's usual crop is wrong.
 */
export function resolveStyleFor(
  streamId: string | undefined,
  game?: string | null,
): StreamStyleOverride | undefined {
  return DAILY_PEANUT_STREAM_STYLE_OVERRIDES[streamId ?? ""]
    ?? (game ? DAILY_PEANUT_GAME_STYLE_PROFILES[game] : undefined);
}

/** Whether any game has a calibrated profile at all. */
export function hasGameStyleProfiles(): boolean {
  return Object.keys(DAILY_PEANUT_GAME_STYLE_PROFILES).length > 0;
}

export function assertStreamStyleCalibrated(streamId: string): void {
  // Passes if the stream itself is calibrated, or if the game path is viable at
  // all -- in which case per-clip resolution enforces it once the game is known.
  if (!DAILY_PEANUT_STREAM_STYLE_OVERRIDES[streamId] && !hasGameStyleProfiles()) {
    throw new Error(
      `No verified avatar/gameplay crop for ${streamId}, and no game profiles are `
      + "calibrated. Probe the stream and add a game entry to "
      + "DAILY_PEANUT_GAME_STYLE_PROFILES before rendering.",
    );
  }
}

/** Fails a clip whose game has no calibrated crop, rather than cropping it wrongly. */
export function assertClipStyleCalibrated(
  streamId: string | undefined,
  game: string | null | undefined,
  rank: number,
): void {
  if (resolveStyleFor(streamId, game)) return;
  throw new Error(
    `Clip #${rank} has no calibrated crop: stream ${streamId ?? "unknown"} has no override `
    + `and game ${game ? `"${game}"` : "could not be determined"} has no profile. `
    + "Rendering it would place the avatar by guesswork.",
  );
}


export function isUsableRegion(region: Region | undefined | null): region is Region {
  return !!region && region.w > 0 && region.h > 0;
}

export function normalizeAvatarRegion(region: Region | undefined | null): Region {
  return isUsableRegion(region) ? region : DAILY_PEANUT_AVATAR_REGION;
}

export function normalizeGameplayRegion(region: Region | undefined | null): Region {
  return isUsableRegion(region) ? region : DAILY_PEANUT_GAMEPLAY_REGION;
}

export function defaultAvatarRegion(streamId?: string, game?: string | null): Region {
  return resolveStyleFor(streamId, game)?.avatar ?? DAILY_PEANUT_AVATAR_REGION;
}

export function defaultFrame0AvatarRegion(
  streamId: string | undefined,
  fallback: Region,
  game?: string | null,
): Region {
  return resolveStyleFor(streamId, game)?.frame0Avatar ?? fallback;
}

export function defaultGameplayRegion(streamId: string | undefined, rank: number, game?: string | null): Region {
  const override = resolveStyleFor(streamId, game);
  return override?.gameplayByRank?.[rank]
    ?? override?.gameplay
    ?? DAILY_PEANUT_V8_GAMEPLAY_BY_RANK[rank]
    ?? DAILY_PEANUT_GAMEPLAY_REGION;
}
