import type { WhisperWord } from "./whisper-captions.js";
import { snapEndBoundaryEnhanced } from "./enhanced-auto-trim.js";
import type { BeatMap, VisualProof } from "./arc-grounding.js";

export const BOUNDARY_REVIEW_PROMPT_VERSION = "autonomous-boundary-v6";
const SUBJECT_ROLES = ["actor", "recipient", "observer"] as const;
type SubjectRole = (typeof SUBJECT_ROLES)[number];
const MIN_CONFIDENCE = 0.75;
const EDGE_GUARD_SEC = 1;
const MAX_END_EXTENSION_SEC = 30;
const ENDPOINT_TYPES = ["minimum", "natural", "extended"] as const;
type EndpointType = (typeof ENDPOINT_TYPES)[number];

export interface BoundaryReviewCandidate {
  candidateId: string;
  startSec: number;
  endSec: number;
  previewStartSec: number;
  previewEndSec: number;
}

export function buildBoundaryReviewPrompt(
  item: BoundaryReviewCandidate & { description: string; categories: string[] },
  reviewDurationSec: number,
): string {
  const oldCutSec = item.endSec - item.previewStartSec;
  const candidateStartSec = item.startSec - item.previewStartSec;
  return `You are the autonomous gameplay boundary reviewer for a short-form clip pipeline. Watch the complete video with audio.

Candidate: ${item.candidateId}
Claim: ${item.description}
Categories: ${item.categories.join(", ")}
Candidate content starts: ${candidateStartSec.toFixed(3)}s
Old candidate cut: ${oldCutSec.toFixed(3)}s
Review duration: ${reviewDurationSec.toFixed(3)}s

Return JSON only:
{
  "candidateId": "${item.candidateId}",
  "objectiveEvent": true,
  "attributionAccurate": true,
  "subjectRole": "actor",
  "attribution": "what visibly happened and the POV player's role",
  "confidence": 0.90,
  "beats": {
    "setupStartSec": 0.0,
    "premiseClearSec": 0.0,
    "actionStartSec": 0.0,
    "payoffStartSec": 0.0,
    "payoffEndSec": 0.0
  },
  "endpointCandidates": [
    { "type": "minimum", "timeSec": 0.0, "reason": "visible result complete" },
    { "type": "natural", "timeSec": 0.0, "reason": "result plus direct reaction" },
    { "type": "extended", "timeSec": 0.0, "reason": "last worthwhile beat before new action" }
  ],
  "recommendedType": "natural",
  "nextTopicStartSec": null
}

Use subjectRole actor, recipient, or observer. For mission or WTF lanes, correct minor wording in the claim and accept a genuine setup-to-result arc; reject only when the core event is absent. For skill or kill claims, attribution is strict: never credit a kill, win, or skill result to the POV player unless the video visibly proves they caused it. attributionAccurate may be true for a genuine POV reaction or mission even when the POV player is not the actor. If the core claim is false or unsupported, set objectiveEvent=false and attributionAccurate=false. Every payoff and endpoint must be at or after Candidate content starts. Every endpoint must precede nextTopicStartSec; recommend minimum when natural or extended would cross it. All timestamps are seconds from this video's start, ordered, and within the video. Confidence is 0.00-1.00. Keep every reason under 20 words. Never select the final frame merely because the video stops.`;
}

export function buildPovAttributionPrompt(candidateId: string): string {
  return `You are an adversarial first-person gameplay attribution checker, not a highlight finder.
Candidate: ${candidateId}
Ignore audio statements, subtitles, cheers, filenames, and any candidate claim. Watch the full video through deaths, camera switches, and aftermath. Decide only whether the POV player personally causes a visually confirmed kill. Firing at someone, a target falling off-screen, or hearing \"got him\" is not confirmation. A teammate kill or POV death is not a POV kill. When attribution is ambiguous, verdict must be unclear.
Return JSON only: {"verdict":"pov_kill_confirmed|other_player_kill|no_confirmed_pov_kill|unclear","povActionVisible":true,"resultVisible":true,"evidence":"specific on-screen causal evidence, not dialogue","confidence":0.0}.`;
}

export function candidateNeedsPovKillAttribution(
  candidate: { description: string; categories: string[] },
): boolean {
  const claim = candidate.description.toLowerCase();
  if (/(?:doesn't|does not|didn't|did not|no)\s+(?:actually\s+)?(?:get\s+(?:the\s+)?)?kill/.test(claim)) return false;
  return /\b(?:kill|killed|collateral)\b|head off/.test(claim);
}

export interface PovAttributionReview {
  verified: boolean;
  verdict: string | null;
  confidence: number | null;
  evidence: string;
}

interface EndpointCandidate {
  type: EndpointType;
  timeSec: number;
  reason: string;
}

export interface AutonomousVisualProof extends VisualProof {
  candidateId: string;
  beats?: BeatMap;
  reviewedCandidateStartSec: number;
  reviewedCandidateEndSec: number;
  review: {
    model: string;
    promptVersion: string;
    confidence: number | null;
    subjectRole: SubjectRole | null;
    attributionGate: PovAttributionReview & { required: boolean };
    selectedType: EndpointType | null;
    selectedEndSec: number | null;
    endpointCandidates: EndpointCandidate[];
    rejectionReason: string | null;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validatePovAttributionReview(value: unknown): PovAttributionReview {
  const raw = record(value);
  const verdict = raw && typeof raw.verdict === "string" ? raw.verdict : null;
  const confidence = raw && finite(raw.confidence) ? raw.confidence : null;
  const evidence = raw && typeof raw.evidence === "string" ? raw.evidence.trim() : "";
  return {
    verified: verdict === "pov_kill_confirmed"
      && raw?.povActionVisible === true
      && raw.resultVisible === true
      && evidence.length >= 12
      && confidence !== null
      && confidence >= 0.9
      && confidence <= 1,
    verdict,
    confidence,
    evidence,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildAutonomousVisualProof(params: {
  candidate: BoundaryReviewCandidate;
  response: unknown;
  reviewDurationSec: number;
  words: WhisperWord[];
  model: string;
  attributionGate?: PovAttributionReview & { required: boolean };
}): AutonomousVisualProof {
  const { candidate } = params;
  const attributionGate = params.attributionGate ?? {
    required: false,
    verified: true,
    verdict: null,
    confidence: null,
    evidence: "not required",
  };
  const raw = record(params.response);
  const confidence = raw && finite(raw.confidence) ? raw.confidence : null;
  const attribution = raw && typeof raw.attribution === "string" ? raw.attribution.trim() : "";
  const subjectRole = raw && typeof raw.subjectRole === "string" && SUBJECT_ROLES.includes(raw.subjectRole as SubjectRole)
    ? raw.subjectRole as SubjectRole
    : null;
  const endpointCandidates: EndpointCandidate[] = [];
  const base = (rejectionReason: string | null): AutonomousVisualProof => ({
    candidateId: candidate.candidateId,
    verified: false,
    timestampSec: candidate.endSec,
    evidenceTimestampsSec: [],
    source: BOUNDARY_REVIEW_PROMPT_VERSION,
    description: attribution || rejectionReason || "Autonomous video review",
    reviewedCandidateStartSec: candidate.startSec,
    reviewedCandidateEndSec: candidate.endSec,
    review: {
      model: params.model,
      promptVersion: BOUNDARY_REVIEW_PROMPT_VERSION,
      confidence,
      subjectRole,
      attributionGate,
      selectedType: null,
      selectedEndSec: null,
      endpointCandidates,
      rejectionReason,
    },
  });

  if (!raw) return base("model response is not an object");
  if (raw.candidateId !== candidate.candidateId) return base("candidate identity mismatch");
  if (attributionGate.required && !attributionGate.verified) {
    return base(attributionGate.evidence || "POV result attribution is not verified");
  }
  if (raw.objectiveEvent !== true || raw.attributionAccurate !== true) {
    return base(attribution || "The claimed event or player attribution is not visually accurate");
  }
  if (!subjectRole) return base("subject role is invalid");
  if (attribution.length < 12 || attribution === "what visibly happened and the POV player's role") {
    return base("attribution evidence is missing");
  }
  if (confidence === null || confidence < MIN_CONFIDENCE || confidence > 1) {
    return base("confidence is outside the accepted range");
  }

  const rawBeats = record(raw.beats);
  if (!rawBeats) return base("beat map is missing");
  const beatKeys = ["setupStartSec", "premiseClearSec", "actionStartSec", "payoffStartSec", "payoffEndSec"] as const;
  if (beatKeys.some((key) => !finite(rawBeats[key]))) return base("beat map contains a non-finite timestamp");

  if (!Array.isArray(raw.endpointCandidates)) return base("endpoint candidates are missing");
  for (const type of ENDPOINT_TYPES) {
    const item = raw.endpointCandidates.find((value) => record(value)?.type === type);
    const value = record(item);
    if (!value || !finite(value.timeSec) || typeof value.reason !== "string") {
      return base(`endpoint ${type} is invalid`);
    }
    endpointCandidates.push({ type, timeSec: value.timeSec, reason: value.reason });
  }

  const recommendedType = typeof raw.recommendedType === "string" && ENDPOINT_TYPES.includes(raw.recommendedType as EndpointType)
    ? raw.recommendedType as EndpointType
    : null;
  if (!recommendedType) return base("recommended endpoint type is invalid");
  const selected = endpointCandidates.find((item) => item.type === recommendedType)!;
  const candidateStartRelative = candidate.startSec - candidate.previewStartSec;
  if ((rawBeats.payoffEndSec as number) < candidateStartRelative || selected.timeSec < candidateStartRelative) {
    return base("payoff or endpoint falls before the candidate starts");
  }
  const relative = [
    rawBeats.setupStartSec as number,
    rawBeats.premiseClearSec as number,
    rawBeats.actionStartSec as number,
    rawBeats.payoffStartSec as number,
    rawBeats.payoffEndSec as number,
    selected.timeSec,
  ];
  if (relative.some((value) => value < 0 || value > params.reviewDurationSec)) {
    return base("beat or endpoint falls outside the review video");
  }
  if (relative.some((value, index) => index > 0 && value < relative[index - 1])) {
    return base("beat map is not ordered");
  }
  if (selected.timeSec >= params.reviewDurationSec - EDGE_GUARD_SEC) {
    return base("recommended endpoint reaches the review edge");
  }
  const nextTopicStartSec = raw.nextTopicStartSec;
  if (nextTopicStartSec != null && (!finite(nextTopicStartSec) || selected.timeSec >= nextTopicStartSec)) {
    return base("recommended endpoint crosses the next topic");
  }

  const absolute = relative.slice(0, 5).map((value) => round(candidate.previewStartSec + value));
  const selectedAbsolute = round(candidate.previewStartSec + selected.timeSec);
  const nextTopicAbsolute = finite(nextTopicStartSec)
    ? candidate.previewStartSec + nextTopicStartSec
    : Number.POSITIVE_INFINITY;
  const snapped = snapEndBoundaryEnhanced(
    params.words,
    selectedAbsolute,
    3,
    600,
    absolute[4],
  ).sec;
  const reactionEndSec = round(Math.max(selectedAbsolute, snapped));
  const reviewEndSec = candidate.previewStartSec + params.reviewDurationSec;
  if (
    reactionEndSec >= reviewEndSec - EDGE_GUARD_SEC
    || reactionEndSec >= nextTopicAbsolute
    || reactionEndSec > candidate.endSec + MAX_END_EXTENSION_SEC
  ) {
    return base("speech-snapped endpoint violates the review envelope");
  }

  const beats: BeatMap = {
    setupStartSec: absolute[0],
    premiseClearSec: absolute[1],
    actionStartSec: absolute[2],
    payoffStartSec: absolute[3],
    payoffEndSec: absolute[4],
    reactionEndSec,
    flashSec: absolute[3],
  };
  const absoluteEndpoints = endpointCandidates.map((item) => ({
    ...item,
    timeSec: round(candidate.previewStartSec + item.timeSec),
  }));

  return {
    ...base(null),
    verified: true,
    timestampSec: beats.payoffEndSec as number,
    evidenceTimestampsSec: [
      beats.setupStartSec,
      beats.premiseClearSec,
      beats.actionStartSec,
      beats.payoffStartSec,
      beats.payoffEndSec,
      beats.reactionEndSec,
    ] as number[],
    description: attribution,
    beats,
    review: {
      model: params.model,
      promptVersion: BOUNDARY_REVIEW_PROMPT_VERSION,
      confidence,
      subjectRole,
      attributionGate,
      selectedType: recommendedType,
      selectedEndSec: reactionEndSec,
      endpointCandidates: absoluteEndpoints,
      rejectionReason: null,
    },
  };
}

export function autonomousProofMatchesCandidate(
  proof: Pick<AutonomousVisualProof, "reviewedCandidateStartSec" | "reviewedCandidateEndSec">,
  candidate: Pick<BoundaryReviewCandidate, "startSec" | "endSec">,
): boolean {
  return proof.reviewedCandidateStartSec === candidate.startSec
    && proof.reviewedCandidateEndSec === candidate.endSec;
}

export function isFatalBoundaryReviewError(error: unknown): boolean {
  return error instanceof Error && /^OpenRouter \d{3}:/.test(error.message);
}

export function autonomousProofIsReusable(
  proof: AutonomousVisualProof,
  candidate: BoundaryReviewCandidate,
  model: string,
): boolean {
  return proof.source === BOUNDARY_REVIEW_PROMPT_VERSION
    && proof.review?.model === model
    && proof.review?.promptVersion === BOUNDARY_REVIEW_PROMPT_VERSION
    && proof.candidateId === candidate.candidateId
    && autonomousProofMatchesCandidate(proof, candidate)
    && !["Model review failed:", "Speech boundary review failed:"].some((prefix) =>
      proof.review.rejectionReason?.startsWith(prefix),
    )
    && !proof.review.attributionGate?.evidence.startsWith("Attribution model failed:");
}
