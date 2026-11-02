/**
 * twitch-clips.ts — Turn Twitch clips into source anchors on the YouTube timeline.
 *
 * The crowd route: viewers clip the moments they thought were worth keeping, and
 * each clip carries the wall-clock time it was taken. The Burnt Peanut
 * simulcasts, so a clip's time maps onto the YouTube VOD we actually download by
 * subtracting the broadcast start. Measured across seven matched stream pairs,
 * the two platforms' start times diverge by under ten seconds.
 *
 * Clips are anchors, not boundaries. A clipper presses the button after the
 * thing happens, so the anchor sits inside the moment rather than at its start,
 * and the real boundaries come from the existing grounding stage.
 */

/** One clip as yt-dlp's Twitch extractor reports it. */
export interface TwitchClip {
  id: string;
  title: string;
  /** Unix seconds when the clip was created. yt-dlp maps Twitch's createdAt here. */
  timestamp: number;
  durationSec: number;
  viewCount?: number;
  url?: string;
}

/** The YouTube VOD a clip might belong to. */
export interface VodWindow {
  streamId: string;
  /**
   * Unix seconds when the *broadcast* began — yt-dlp's `release_timestamp`.
   *
   * Not `timestamp`, which is when the VOD was published. On a measured stream
   * the two differ by about fifteen hours, so using `timestamp` would put every
   * anchor far outside the video.
   */
  releaseTimestamp: number;
  durationSec: number;
}

export interface CrowdAnchor {
  momentId: string;
  routes: string[];
  source: "twitch-clip";
  /** Start of the window to hand to grounding, clamped to the VOD. */
  startSec: number;
  endSec: number;
  description: string;
  score?: number;
  categories?: string[];
  /** Where the clip itself landed, before the window was padded around it. */
  anchorSec: number;
  clipId: string;
  clipUrl?: string;
}

export interface WindowOptions {
  /** Seconds of lead-in before the anchor. */
  leadSec?: number;
  /** Seconds of tail after the anchor. */
  trailSec?: number;
}

// ponytail: 90s lead / 30s trail is asymmetric because clippers press late, but
// the asymmetry rests on three confirmed anchors from one stream. Widen or
// narrow once ticket 10's labelling gives a median anchor error over ~30 clips.
const DEFAULT_LEAD_SEC = 90;
const DEFAULT_TRAIL_SEC = 30;

/** Where a clip falls on the VOD timeline. Negative means before the broadcast. */
export function clipAnchorSec(clip: TwitchClip, vod: VodWindow): number {
  return clip.timestamp - vod.releaseTimestamp;
}

/**
 * Whether a clip belongs to this VOD, by interval containment.
 *
 * Never match on title: the same moment is titled differently on each platform.
 * Containment also handles Twitch merging several YouTube broadcasts into one
 * long archive, where a single Twitch VOD spans more than one YouTube video.
 */
export function clipFallsInVod(clip: TwitchClip, vod: VodWindow): boolean {
  const anchor = clipAnchorSec(clip, vod);
  return anchor >= 0 && anchor <= vod.durationSec;
}

/** A stable id, so re-harvesting the same clip does not create a new candidate. */
export function crowdMomentId(clip: TwitchClip): string {
  return `twitch-${clip.id}`;
}

/**
 * Build anchors for every clip that falls inside the VOD.
 *
 * Clips outside it are dropped rather than clamped — a clip from a different
 * broadcast is not weak evidence about this one, it is evidence about another.
 */
export function toCrowdAnchors(
  clips: TwitchClip[],
  vod: VodWindow,
  options: WindowOptions = {},
): CrowdAnchor[] {
  const lead = options.leadSec ?? DEFAULT_LEAD_SEC;
  const trail = options.trailSec ?? DEFAULT_TRAIL_SEC;

  return clips
    .filter((clip) => clipFallsInVod(clip, vod))
    .map((clip) => {
      const anchorSec = clipAnchorSec(clip, vod);
      return {
        momentId: crowdMomentId(clip),
        routes: ["twitch-clip"],
        source: "twitch-clip" as const,
        startSec: Math.max(0, anchorSec - lead),
        // The clip's own duration is part of the moment, so clear it before the tail.
        endSec: Math.min(vod.durationSec, anchorSec + clip.durationSec + trail),
        description: clip.title,
        score: clip.viewCount,
        categories: [],
        anchorSec,
        clipId: clip.id,
        clipUrl: clip.url,
      };
    })
    .sort((a, b) => a.startSec - b.startSec);
}

/**
 * Parse yt-dlp's `--dump-json` lines into clips.
 *
 * Tolerant by design: yt-dlp currently exits non-zero on this machine *after*
 * emitting every record, because a stale user config points --cookies at a path
 * that no longer exists and the cookie writeback then fails. Exit codes are
 * therefore not evidence about the data; the parsed rows are.
 */
export function parseClipDumpJson(stdout: string): TwitchClip[] {
  const clips: TwitchClip[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof row.id === "string" ? row.id : null;
    const timestamp = typeof row.timestamp === "number" ? row.timestamp : null;
    if (!id || timestamp == null) continue;
    clips.push({
      id,
      title: typeof row.title === "string" ? row.title : "",
      timestamp,
      durationSec: typeof row.duration === "number" ? row.duration : 0,
      viewCount: typeof row.view_count === "number" ? row.view_count : undefined,
      url: typeof row.webpage_url === "string"
        ? row.webpage_url
        : typeof row.url === "string" ? row.url : undefined,
    });
  }
  return clips;
}
