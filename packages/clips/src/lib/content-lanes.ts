export const CONTENT_LANES = [
  "peanut-bits",
  "squad-chaos",
  "wtf-game-moments",
  "peanut-plays",
  "the-mission",
  "reject",
] as const;

export type ContentLane = typeof CONTENT_LANES[number];

export const PAYOFF_TYPES = [
  "lol",
  "roast",
  "wow",
  "wtf",
  "tension",
  "satisfaction",
  "none",
] as const;

export type PayoffType = typeof PAYOFF_TYPES[number];

export interface DiscoveryAssessment {
  contentLane?: ContentLane | string;
  payoffType?: PayoffType | string;
  laneScore?: number;
  laughOutLoudScore?: number;
  comedyScore?: number;
}

const LANE_FLOORS: Record<Exclude<ContentLane, "reject">, number> = {
  "peanut-bits": 0.70,
  "squad-chaos": 0.70,
  "wtf-game-moments": 0.75,
  "peanut-plays": 0.80,
  "the-mission": 0.80,
};

const PERSONALITY_FIRST_BOOST: Record<Exclude<ContentLane, "reject">, number> = {
  "peanut-bits": 0.04,
  "squad-chaos": 0.02,
  "wtf-game-moments": 0.01,
  "peanut-plays": 0,
  "the-mission": 0,
};

function clamp01(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value as number));
}

export function normalizeContentLane(value: unknown): ContentLane | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  for (let i = 0; i < CONTENT_LANES.length; i++) {
    if (CONTENT_LANES[i] === normalized) return CONTENT_LANES[i];
  }
  return undefined;
}

export function normalizePayoffType(value: unknown): PayoffType {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    for (let i = 0; i < PAYOFF_TYPES.length; i++) {
      if (PAYOFF_TYPES[i] === normalized) return PAYOFF_TYPES[i];
    }
  }
  return "none";
}

/**
 * Hard automatic floor. Existing comedy-only artifacts remain backward compatible,
 * while classified lanes must clear their own stricter evidence threshold.
 */
export function passesAutomaticDiscoveryFloor(assessment: DiscoveryAssessment): boolean {
  const lane = normalizeContentLane(assessment.contentLane);
  if (!lane) return clamp01(assessment.laughOutLoudScore) >= 0.65;
  if (lane === "reject") return false;
  return clamp01(assessment.laneScore) >= LANE_FLOORS[lane];
}

/** Rank by the strongest proven payoff, with a small Peanut-personality preference. */
export function discoveryRankScore(assessment: DiscoveryAssessment): number {
  const lane = normalizeContentLane(assessment.contentLane);
  if (lane === "reject") return 0;

  const comedyScore = clamp01(assessment.comedyScore ?? assessment.laughOutLoudScore);
  if (!lane) return comedyScore;

  const laneScore = clamp01(assessment.laneScore);
  return clamp01(Math.max(comedyScore, laneScore + PERSONALITY_FIRST_BOOST[lane]));
}
