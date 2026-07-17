import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

export interface CandidateIdentity {
  candidateId: string;
  jobId: string;
  momentId: string;
}

export interface CandidateMomentInput {
  id?: string;
  momentId?: string;
  candidateId?: string;
  contentLane?: unknown;
  laneScore?: unknown;
}

export function makeCandidateId(jobId: string, momentId: string): string {
  const normalizedJobId = jobId.trim();
  const normalizedMomentId = momentId.trim();
  if (!normalizedJobId) throw new Error("Candidate identity requires a job id");
  if (!normalizedMomentId) throw new Error("Candidate identity requires a moment id");
  return `${normalizedJobId}:${normalizedMomentId}`;
}

export function canonicalizeMoment<T extends CandidateMomentInput>(
  jobId: string,
  moment: T,
): T & CandidateIdentity {
  const momentId = moment.momentId?.trim() || moment.id?.trim();
  if (!momentId) throw new Error("Candidate identity requires a moment id");
  if (moment.id && moment.momentId && moment.id !== moment.momentId) {
    throw new Error(`Moment id ${moment.momentId} does not match source id ${moment.id}`);
  }

  const candidateId = makeCandidateId(jobId, momentId);
  if (moment.candidateId && moment.candidateId !== candidateId) {
    throw new Error(`Candidate id ${moment.candidateId} does not match ${candidateId}`);
  }

  return { ...moment, candidateId, jobId: jobId.trim(), momentId };
}

export function chooseCanonicalMomentSource<T extends CandidateMomentInput>(
  notebookMoments: T[],
  unifiedMoments: T[],
  scorerMoments: T[],
  groundedPromoted: T[] = [],
): T[] {
  if (groundedPromoted.length > 0) return groundedPromoted;
  const scorerHasLaneMetadata = scorerMoments.some(
    (moment) => moment.contentLane != null || moment.laneScore != null,
  );
  if (scorerHasLaneMetadata) return scorerMoments;
  if (notebookMoments.length > 0) return notebookMoments;
  if (unifiedMoments.length > 0) return unifiedMoments;
  return scorerMoments;
}

export interface CandidateBeatMap {
  setupStartSec: number;
  premiseClearSec: number;
  actionStartSec: number;
  payoffStartSec: number;
  payoffEndSec: number;
  reactionEndSec: number;
  flashSec?: number;
}

export interface ValidatedPrivateSelectionCandidate<T extends CandidateMomentInput> {
  candidateId: string;
  label?: string;
  startSec: number;
  endSec: number;
  beats: CandidateBeatMap;
  groundingBeats: CandidateBeatMap | null;
  candidate: T;
}

export interface ValidatedPrivateSelection<T extends CandidateMomentInput> {
  streamId: string | null;
  source: string;
  selectedAt: string | null;
  publishApproved: boolean;
  rightsStatus: "cleared" | "unresolved" | "blocked";
  candidates: Array<ValidatedPrivateSelectionCandidate<T>>;
}

function validateBeatMap(candidateId: string, beats: CandidateBeatMap | undefined): CandidateBeatMap {
  if (!beats) throw new Error(`Private selection candidate ${candidateId} requires an explicit Beat Map`);
  const ordered = [
    beats.setupStartSec,
    beats.premiseClearSec,
    beats.actionStartSec,
    beats.payoffStartSec,
    beats.payoffEndSec,
    beats.reactionEndSec,
  ];
  if (ordered.some((value) => !Number.isFinite(value))
    || ordered.some((value, index) => index > 0 && value < ordered[index - 1])) {
    throw new Error(`Private selection candidate ${candidateId} has an invalid Beat Map`);
  }
  return beats;
}

export function loadValidatedPrivateSelection<T extends CandidateMomentInput>(
  streamDir: string,
): ValidatedPrivateSelection<T> | null {
  const selectionPath = join(streamDir, "private-abc-selection.json");
  if (!existsSync(selectionPath)) return null;
  const selection = JSON.parse(readFileSync(selectionPath, "utf-8")) as {
    streamId?: string;
    source?: string;
    selectedAt?: string;
    decision?: string;
    publishApproved?: boolean;
    rightsStatus?: string;
    candidates?: Array<{
      candidateId?: string;
      label?: string;
      startSec?: number;
      endSec?: number;
      beats?: CandidateBeatMap;
    }>;
  };
  if (selection.decision !== "liked all" || (selection.candidates?.length ?? 0) === 0) {
    throw new Error("Private selection is incomplete; expected an explicit non-empty liked-all decision");
  }
  if (!selection.source?.trim()) throw new Error("Private selection requires a decision source");
  if (typeof selection.publishApproved !== "boolean") throw new Error("Private selection requires an explicit publish status");
  if (!selection.rightsStatus || !["cleared", "unresolved", "blocked"].includes(selection.rightsStatus)) {
    throw new Error("Private selection requires an explicit rights status");
  }
  if (selection.candidates!.length > 5) throw new Error("Private selection may contain at most five candidates");

  const unionPath = join(streamDir, "recall-union.json");
  const groundingPath = join(streamDir, "arc-grounding.json");
  if (!existsSync(unionPath) || !existsSync(groundingPath)) {
    throw new Error("Private selection requires Recall Union and Arc Grounding evidence");
  }
  const union = JSON.parse(readFileSync(unionPath, "utf-8")) as Array<T & {
    candidateId?: string;
    startSec?: number;
    endSec?: number;
  }>;
  const grounding = JSON.parse(readFileSync(groundingPath, "utf-8")) as {
    results?: Array<{ candidateId?: string; status?: string; beats?: CandidateBeatMap }>;
  };
  const byCandidate = new Map(union.map((candidate) => [candidate.candidateId, candidate]));
  const groundingByCandidate = new Map((grounding.results ?? []).map((result) => [result.candidateId, result]));
  const seen = new Set<string>();

  const candidates = selection.candidates!.map((approved) => {
    const candidateId = approved.candidateId?.trim();
    if (!candidateId || seen.has(candidateId)) {
      throw new Error(`Private selection has a missing or duplicate candidateId: ${candidateId ?? "missing"}`);
    }
    seen.add(candidateId);
    const candidate = byCandidate.get(candidateId);
    if (!candidate) throw new Error(`Private selection candidate ${candidateId} is missing from Recall Union`);
    const grounded = groundingByCandidate.get(candidateId);
    if (grounded?.status !== "GROUNDED") {
      throw new Error(`Private selection candidate ${candidateId} did not pass Arc Gate`);
    }
    if (!Number.isFinite(approved.startSec) || !Number.isFinite(approved.endSec)
      || approved.endSec! <= approved.startSec!) {
      throw new Error(`Private selection candidate ${candidateId} has an invalid source window`);
    }
    const beats = validateBeatMap(candidateId, approved.beats);
    return {
      candidateId,
      label: approved.label,
      startSec: approved.startSec!,
      endSec: approved.endSec!,
      beats,
      groundingBeats: grounded.beats ?? null,
      candidate: {
        ...candidate,
        startSec: approved.startSec,
        endSec: approved.endSec,
        beats,
      } as T,
    };
  });

  return {
    streamId: selection.streamId?.trim() || null,
    source: selection.source.trim(),
    selectedAt: selection.selectedAt ?? null,
    publishApproved: selection.publishApproved,
    rightsStatus: selection.rightsStatus as ValidatedPrivateSelection<T>["rightsStatus"],
    candidates,
  };
}

export function loadValidatedGroundedPromoted<T extends CandidateMomentInput>(streamDir: string): T[] {
  const privateSelection = loadValidatedPrivateSelection<T>(streamDir);
  if (privateSelection) return privateSelection.candidates.map((approved) => approved.candidate);

  const reportPath = join(streamDir, "grounded-ranking.json");
  const derivativePath = join(streamDir, "grounded-ranked-moments.json");
  const hasReport = existsSync(reportPath);
  const hasDerivative = existsSync(derivativePath);
  if (!hasReport && !hasDerivative) {
    if (existsSync(join(streamDir, "arc-grounding.json"))) {
      throw new Error("Grounded ranking has not promoted any candidates; run grounded-rank first");
    }
    return [];
  }
  if (!hasReport) {
    throw new Error("Grounded ranking artifacts are incomplete; rerun grounded-rank");
  }

  const reportTime = statSync(reportPath).mtimeMs;
  for (const input of [
    join(streamDir, "arc-grounding.json"),
    join(streamDir, "recall-union.json"),
  ]) {
    if (existsSync(input) && statSync(input).mtimeMs > reportTime) {
      throw new Error(`Grounded ranking is stale relative to ${input}; rerun grounded-rank`);
    }
  }

  const report = JSON.parse(readFileSync(reportPath, "utf-8")) as {
    gate?: { status?: string; labelSource?: string };
    promoted?: CandidateMomentInput[];
  };
  if (report.gate?.status === "PASS" && report.gate.labelSource !== "private-review") {
    throw new Error(`Grounded ranking PASS has invalid label source ${report.gate.labelSource ?? "MISSING"}`);
  }
  if (report.gate?.status !== "PASS") {
    throw new Error(`Grounded ranking gate is ${report.gate?.status ?? "MISSING"}; no candidates may proceed`);
  }
  if (!hasDerivative) {
    throw new Error("Grounded ranking PASS derivative is missing; rerun grounded-rank");
  }
  const promoted = JSON.parse(readFileSync(derivativePath, "utf-8")) as T[];
  const expected = (report.promoted ?? []).map((item) => item.candidateId).sort();
  const actual = promoted.map((item) => item.candidateId).sort();
  if (expected.length === 0 || expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error("Grounded promoted derivative does not match grounded-ranking.json");
  }
  return promoted;
}
