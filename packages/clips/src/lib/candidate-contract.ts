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

export function loadValidatedGroundedPromoted<T extends CandidateMomentInput>(streamDir: string): T[] {
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
    gate?: { status?: string };
    promoted?: CandidateMomentInput[];
  };
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
