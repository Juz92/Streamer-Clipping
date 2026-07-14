import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeMoment } from "./candidate-contract.js";
import { isGameplayContentLane } from "./content-lanes.js";

export interface GroundingCandidate {
  candidateId: string;
  jobId: string;
  momentId: string;
  startSec: number;
  endSec: number;
  description: string;
  categories: string[];
  recallRoutes: string[];
}

export interface TranscriptEvidenceCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ReactionEvidence {
  timestampSec: number;
  source: "chat" | "audio";
  strength: number;
  label: string;
}

export interface ChatTimelineMessage {
  timestampSec: number;
  authorName: string;
  text: string;
}

export interface VisualProof {
  verified: boolean;
  timestampSec: number;
  evidenceTimestampsSec?: number[];
  source: string;
  description: string;
}

export interface BeatMap {
  setupStartSec: number | null;
  premiseClearSec: number | null;
  actionStartSec: number | null;
  payoffStartSec: number | null;
  payoffEndSec: number | null;
  reactionEndSec: number | null;
  flashSec: number | null;
}

export interface ArcGroundingInput {
  candidate: GroundingCandidate;
  transcript: TranscriptEvidenceCue[];
  reactions: ReactionEvidence[];
  proposedBeats?: BeatMap;
  visualProof?: VisualProof;
  localizer?: string;
}

export interface ArcGroundingResult {
  candidateId: string;
  jobId: string;
  momentId: string;
  status: "GROUNDED" | "BLOCKED";
  localizer: string;
  sourceWindow: { startSec: number; endSec: number };
  beats: BeatMap;
  gates: {
    arcComplete: boolean;
    visualProof: boolean | null;
    contextIndependent: boolean;
  };
  evidence: {
    transcript: TranscriptEvidenceCue[];
    reactions: ReactionEvidence[];
    visualProof: VisualProof | null;
  };
  missingEvidence: string[];
}

export function passesArcGrounding(result: ArcGroundingResult | undefined): boolean {
  return result?.status === "GROUNDED"
    && result.gates.arcComplete
    && result.gates.contextIndependent
    && result.gates.visualProof !== false;
}

export function loadArcGrounding(streamDir: string): Map<string, ArcGroundingResult> {
  const path = join(streamDir, "arc-grounding.json");
  if (!existsSync(path)) throw new Error("arc-grounding.json missing; run ground-candidates first");
  const report = JSON.parse(readFileSync(path, "utf-8")) as { results?: ArcGroundingResult[] };
  const byCandidate = new Map<string, ArcGroundingResult>();
  for (const result of report.results ?? []) {
    if (byCandidate.has(result.candidateId)) throw new Error(`Duplicate arc grounding ${result.candidateId}`);
    byCandidate.set(result.candidateId, result);
  }
  return byCandidate;
}

const REQUIRED_BEATS: Array<keyof Omit<BeatMap, "flashSec">> = [
  "setupStartSec",
  "premiseClearSec",
  "actionStartSec",
  "payoffStartSec",
  "payoffEndSec",
  "reactionEndSec",
];

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function within(value: number, start: number, end: number, tolerance = 0): boolean {
  return value >= start - tolerance && value <= end + tolerance;
}

export function candidateNeedsVisualProof(
  candidate: Pick<GroundingCandidate, "categories" | "recallRoutes">,
): boolean {
  const values = [...candidate.categories, ...candidate.recallRoutes]
    .map((value) => value.toLowerCase());
  return values.some((value) => {
    const lane = value.replace(/^lane:/, "");
    return isGameplayContentLane(lane)
      || value === "gameplay"
      || value === "skill"
      || value.includes("visual-gameplay")
      || value.includes("gameplay-only");
  });
}

function beatHasSourceEvidence(
  second: number,
  transcript: TranscriptEvidenceCue[],
  reactions: ReactionEvidence[],
  visualProof?: VisualProof,
): boolean {
  return transcript.some((cue) => within(second, cue.startSec, cue.endSec, 1.5))
    || reactions.some((reaction) => Math.abs(reaction.timestampSec - second) <= 2.5)
    || (visualProof?.verified === true
      && (visualProof.evidenceTimestampsSec ?? [visualProof.timestampSec])
        .some((timestamp) => Math.abs(timestamp - second) <= 2.5));
}

function proposalIsOrdered(beats: BeatMap): boolean {
  const values = REQUIRED_BEATS.map((key) => beats[key]);
  if (values.some((value) => !finite(value))) return false;
  for (let index = 1; index < values.length; index++) {
    if ((values[index] as number) < (values[index - 1] as number)) return false;
  }
  return true;
}

function words(value: string): Set<string> {
  return new Set(
    cleanText(value)
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((token) => token.length >= 4),
  );
}

function textMatchScore(cue: TranscriptEvidenceCue, description: string): number {
  const expected = words(description);
  if (expected.size === 0) return 0;
  let matches = 0;
  for (const token of words(cue.text)) if (expected.has(token)) matches++;
  return matches / expected.size;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

/** Convert chat into robust reaction evidence; duplicate spam cannot win on volume. */
export function buildChatReactionEvidence(
  messages: ChatTimelineMessage[],
  bucketSec = 5,
): ReactionEvidence[] {
  if (messages.length === 0 || bucketSec <= 0) return [];
  const buckets = new Map<number, ChatTimelineMessage[]>();
  for (const message of messages) {
    if (!finite(message.timestampSec)) continue;
    const bucket = Math.floor(message.timestampSec / bucketSec);
    const rows = buckets.get(bucket) ?? [];
    rows.push(message);
    buckets.set(bucket, rows);
  }
  if (buckets.size === 0) return [];

  const indexes = [...buckets.keys()];
  const minBucket = Math.min(...indexes);
  const maxBucket = Math.max(...indexes);
  const counts: number[] = [];
  for (let index = minBucket; index <= maxBucket; index++) counts.push(buckets.get(index)?.length ?? 0);
  const baseline = Math.max(1, median(counts));
  const events: ReactionEvidence[] = [];

  for (const [bucket, rows] of buckets) {
    const uniqueAuthors = new Set(rows.map((row) => row.authorName.trim().toLowerCase())).size;
    const messageCounts = new Map<string, number>();
    for (const row of rows) {
      const key = cleanText(row.text).toLowerCase();
      messageCounts.set(key, (messageCounts.get(key) ?? 0) + 1);
    }
    const maxDuplicateCount = Math.max(...messageCounts.values(), 0);
    const duplicateRatio = maxDuplicateCount / rows.length;
    const rateLift = rows.length / baseline;
    const uniqueFactor = Math.min(1, uniqueAuthors / 4);
    const diversityFactor = 0.25 + (1 - duplicateRatio) * 0.75;
    const strength = Math.max(0, Math.min(1, (rateLift / 2) * uniqueFactor * diversityFactor));
    if (rows.length < 4 || uniqueAuthors < 3 || strength < 0.4) continue;
    events.push({
      timestampSec: bucket * bucketSec + bucketSec / 2,
      source: "chat",
      strength: Math.round(strength * 1000) / 1000,
      label: `${rows.length} messages, ${uniqueAuthors} unique chatters, ${(rateLift).toFixed(1)}x rate`,
    });
  }

  return events.sort((a, b) => a.timestampSec - b.timestampSec);
}

/**
 * Deterministic source-evidence baseline. It is deliberately conservative:
 * transcript establishes setup/action/payoff structure and reaction evidence
 * may locate the payoff, but missing modalities remain missing rather than being
 * invented from candidate metadata.
 */
export function localizeArcFromEvidence(
  input: Pick<ArcGroundingInput, "candidate" | "transcript" | "reactions">,
): BeatMap {
  const { candidate } = input;
  const transcript = input.transcript
    .filter((cue) => cue.endSec >= candidate.startSec - 15 && cue.startSec <= candidate.endSec + 20)
    .map((cue) => ({ ...cue, text: cleanText(cue.text) }))
    .filter((cue) => cue.text.length > 0)
    .sort((a, b) => a.startSec - b.startSec);
  const reactions = input.reactions
    .filter((event) => within(event.timestampSec, candidate.startSec - 5, candidate.endSec))
    .sort((a, b) => a.timestampSec - b.timestampSec);

  const strongestReaction = [...reactions].sort((a, b) => b.strength - a.strength)[0];
  let payoffCue = strongestReaction
    ? transcript.find((cue) =>
      cue.startSec <= candidate.endSec
      && within(strongestReaction.timestampSec, cue.startSec, cue.endSec, 1.5),
    )
    : undefined;

  if (!payoffCue && transcript.length > 0) {
    payoffCue = [...transcript]
      .filter((cue) => cue.startSec <= candidate.endSec)
      .sort((a, b) => {
        const scoreDiff = textMatchScore(b, candidate.description) - textMatchScore(a, candidate.description);
        if (scoreDiff !== 0) return scoreDiff;
        const target = candidate.startSec + (candidate.endSec - candidate.startSec) * 0.7;
        return Math.abs(a.startSec - target) - Math.abs(b.startSec - target);
      })[0];
  }

  if (!payoffCue) {
    return {
      setupStartSec: null,
      premiseClearSec: null,
      actionStartSec: null,
      payoffStartSec: strongestReaction?.timestampSec ?? null,
      payoffEndSec: strongestReaction ? strongestReaction.timestampSec + 2 : null,
      reactionEndSec: strongestReaction ? strongestReaction.timestampSec + 2 : null,
      flashSec: strongestReaction?.timestampSec ?? null,
    };
  }

  const beforePayoff = transcript.filter((cue) => cue.endSec <= payoffCue!.startSec + 0.5);
  const actionCue = beforePayoff[beforePayoff.length - 1];
  const premiseCue = beforePayoff.length >= 2
    ? beforePayoff[beforePayoff.length - 2]
    : beforePayoff[0];
  const setupCue = [...beforePayoff]
    .filter((cue) => !premiseCue || cue.startSec <= premiseCue.startSec)
    .sort((a, b) => Math.abs(a.startSec - candidate.startSec) - Math.abs(b.startSec - candidate.startSec))[0];
  const reactionCue = [...transcript]
    .filter((cue) =>
      cue.endSec >= payoffCue!.endSec
      && cue.startSec >= payoffCue!.startSec - 1.5
      && cue.startSec <= candidate.endSec,
    )
    .sort((a, b) => Math.abs(a.endSec - candidate.endSec) - Math.abs(b.endSec - candidate.endSec))[0];
  const reactionEvent = [...reactions]
    .filter((event) =>
      event.timestampSec >= payoffCue!.startSec
      && event.timestampSec <= candidate.endSec,
    )
    .sort((a, b) => Math.abs(a.timestampSec - candidate.endSec) - Math.abs(b.timestampSec - candidate.endSec))[0];
  const reactionEndSec = Math.min(candidate.endSec, Math.max(
    payoffCue.endSec,
    reactionCue?.endSec ?? payoffCue.endSec,
    reactionEvent ? reactionEvent.timestampSec + 2 : payoffCue.endSec,
  ));

  return {
    setupStartSec: setupCue?.startSec ?? null,
    premiseClearSec: premiseCue?.endSec ?? null,
    actionStartSec: actionCue?.startSec ?? null,
    payoffStartSec: payoffCue.startSec,
    payoffEndSec: payoffCue.endSec,
    reactionEndSec,
    flashSec: strongestReaction?.timestampSec ?? payoffCue.startSec,
  };
}

export function groundCandidateArc(input: ArcGroundingInput): ArcGroundingResult {
  const identity = canonicalizeMoment(input.candidate.jobId, input.candidate);
  const sourceWindow = {
    startSec: Math.max(0, input.candidate.startSec - 90),
    endSec: input.candidate.endSec + 90,
  };
  const transcript = input.transcript
    .filter((cue) => cue.endSec >= sourceWindow.startSec && cue.startSec <= sourceWindow.endSec)
    .map((cue) => ({ ...cue, text: cleanText(cue.text) }))
    .filter((cue) => cue.text.length > 0)
    .sort((a, b) => a.startSec - b.startSec);
  const reactions = input.reactions
    .filter((event) => within(event.timestampSec, sourceWindow.startSec, sourceWindow.endSec))
    .sort((a, b) => a.timestampSec - b.timestampSec);
  const beats = input.proposedBeats ?? localizeArcFromEvidence({
    candidate: input.candidate,
    transcript,
    reactions,
  });
  const missingEvidence: string[] = [];

  for (const key of REQUIRED_BEATS) {
    const second = beats[key];
    if (!finite(second)) {
      missingEvidence.push(`${key} is missing`);
    } else if (!beatHasSourceEvidence(second, transcript, reactions, input.visualProof)) {
      missingEvidence.push(`${key} is not aligned to transcript/chat/audio/visual evidence`);
    }
  }
  if (finite(beats.flashSec) && !beatHasSourceEvidence(beats.flashSec, transcript, reactions, input.visualProof)) {
    missingEvidence.push("flashSec is not aligned to transcript/chat/audio/visual evidence");
  }

  const ordered = proposalIsOrdered(beats);
  const insideArcEnvelope = finite(beats.setupStartSec)
    && finite(beats.reactionEndSec)
    && beats.setupStartSec >= input.candidate.startSec - 45
    && beats.reactionEndSec <= input.candidate.endSec + 30;
  if (!ordered || !insideArcEnvelope) {
    missingEvidence.push("ordered beat map must remain inside the candidate arc envelope");
  }

  const needsVisualProof = candidateNeedsVisualProof(input.candidate);
  const hasDialogueContext = finite(beats.setupStartSec)
    && finite(beats.premiseClearSec)
    && finite(beats.payoffStartSec)
    && beats.premiseClearSec <= beats.payoffStartSec
    && beats.payoffStartSec - beats.setupStartSec <= 45
    && transcript.some((cue) =>
      cue.startSec <= beats.premiseClearSec!
      && cue.endSec >= beats.setupStartSec!
      && cleanText(cue.text).split(/\s+/).length >= 3,
    );
  const hasVisualContext = needsVisualProof
    && input.visualProof?.verified === true
    && finite(beats.setupStartSec)
    && finite(beats.premiseClearSec)
    && [beats.setupStartSec, beats.premiseClearSec].every((second) =>
      beatHasSourceEvidence(second as number, [], [], input.visualProof),
    );
  const contextIndependent = hasDialogueContext || hasVisualContext;
  if (!contextIndependent) missingEvidence.push("premise is not independently understandable from source evidence");

  const visualProof = needsVisualProof ? input.visualProof?.verified === true : null;
  if (needsVisualProof && !visualProof) {
    missingEvidence.push("gameplay candidate requires verified visual proof");
  }

  const arcComplete = ordered
    && insideArcEnvelope
    && REQUIRED_BEATS.every((key) => finite(beats[key]))
    && REQUIRED_BEATS.every((key) => beatHasSourceEvidence(
      beats[key] as number,
      transcript,
      reactions,
      input.visualProof,
    ));
  const status = arcComplete && contextIndependent && visualProof !== false ? "GROUNDED" : "BLOCKED";

  return {
    ...identity,
    status,
    localizer: input.localizer ?? "source-envelope-v2",
    sourceWindow,
    beats,
    gates: { arcComplete, visualProof, contextIndependent },
    evidence: {
      transcript,
      reactions,
      visualProof: input.visualProof ?? null,
    },
    missingEvidence: [...new Set(missingEvidence)],
  };
}
