export interface GroundedTrimMoment {
  candidateId: string;
  startSec: number;
  endSec: number;
  durationSec?: number;
  flashSec?: number;
}

export interface GroundedQuality {
  candidateId: string;
  status: "suggested" | "candidate" | "reserve";
  groundingStatus: "GROUNDED" | "BLOCKED" | "MISSING";
  setupStartSec: number;
  flashSec: number;
  reactionEndSec?: number;
  naturalEndSec: number;
  arcCompleteness: number;
}

export function applyGroundedQuality<T extends GroundedTrimMoment>(
  moment: T,
  quality: GroundedQuality,
): T & { qualityStatus: GroundedQuality["status"]; arcCompleteness: number } {
  if (moment.candidateId !== quality.candidateId) {
    throw new Error(`Candidate identity mismatch: ${moment.candidateId} != ${quality.candidateId}`);
  }
  if (quality.groundingStatus !== "GROUNDED" || quality.status === "reserve") {
    throw new Error(`${moment.candidateId} is not source-grounded for extraction`);
  }

  const endSec = quality.reactionEndSec ?? quality.naturalEndSec;
  if (endSec <= quality.setupStartSec) {
    throw new Error(`${moment.candidateId} has invalid grounded trim boundaries`);
  }

  return {
    ...moment,
    startSec: quality.setupStartSec,
    endSec,
    durationSec: endSec - quality.setupStartSec,
    flashSec: quality.flashSec,
    qualityStatus: quality.status,
    arcCompleteness: quality.arcCompleteness,
  };
}
