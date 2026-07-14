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
): T[] {
  const scorerHasLaneMetadata = scorerMoments.some(
    (moment) => moment.contentLane != null || moment.laneScore != null,
  );
  if (scorerHasLaneMetadata) return scorerMoments;
  if (notebookMoments.length > 0) return notebookMoments;
  if (unifiedMoments.length > 0) return unifiedMoments;
  return scorerMoments;
}
