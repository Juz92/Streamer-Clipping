import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

export interface SignalEventLike {
  timestampSec: number;
  strength: number;
}

export function hasFirstThreeSecondHook(params: {
  startSec: number;
  text: string;
  flashDuration?: number;
  events: SignalEventLike[];
}): boolean {
  const strongText = /[?!]|\b(no way|what the|oh my|holy|clip that|shroud|bedtime|race|rage|roast|caught|wtf)\b/i.test(params.text);
  const earlySignal = params.events.some((event) =>
    event.timestampSec >= params.startSec &&
    event.timestampSec <= params.startSec + 3 &&
    event.strength >= 0.55,
  );
  return (params.flashDuration ?? 0) >= 1 || earlySignal || strongText;
}

export interface RenderedShortProbe {
  file: string;
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
}

export function evaluateRenderedShorts(probes: RenderedShortProbe[]): { bad: number; message: string } {
  const bad = probes.filter((probe) =>
    probe.width !== 1080 ||
    probe.height !== 1920 ||
    probe.durationSec < 10 ||
    probe.durationSec > 60 ||
    !probe.hasAudio,
  );
  return {
    bad: bad.length,
    message: bad.length === 0
      ? `${probes.length} rendered short(s) passed stream QA`
      : bad.map((probe) => `${probe.file}: ${probe.width}x${probe.height}, ${probe.durationSec.toFixed(1)}s, audio=${probe.hasAudio}`).join("; "),
  };
}

export interface ReviewPacketClip {
  rank: number;
  quality?: {
    status?: "suggested" | "candidate" | "reserve" | string;
    arcCompleteness?: number;
  };
}

export function chooseReviewPacketClips<T extends ReviewPacketClip>(clips: T[], suggestedRank: number | null): T[] {
  return [...clips].sort((a, b) => {
    const aSuggested = a.rank === suggestedRank || a.quality?.status === "suggested";
    const bSuggested = b.rank === suggestedRank || b.quality?.status === "suggested";
    if (aSuggested !== bSuggested) return aSuggested ? -1 : 1;
    const aReserve = a.quality?.status === "reserve";
    const bReserve = b.quality?.status === "reserve";
    if (aReserve !== bReserve) return aReserve ? 1 : -1;
    return (b.quality?.arcCompleteness ?? 0) - (a.quality?.arcCompleteness ?? 0) || a.rank - b.rank;
  }).slice(0, 3);
}

export function blocksMissingTranscriptReview(state: { reviewed: boolean; dryRun?: boolean; allowScorerOnly?: boolean }): boolean {
  return !state.reviewed && !state.dryRun && !state.allowScorerOnly;
}

export function blocksMissingQaReview(state: { qaAvailable: boolean; dryRun?: boolean; allowNoQa?: boolean }): boolean {
  return !state.qaAvailable && !state.dryRun && !state.allowNoQa;
}

export function selectPromotedEntries<T extends { candidateId?: string }>(entries: T[], promotedCandidateIds: string[]): T[] {
  const missing = entries.filter((entry) => !entry.candidateId);
  if (missing.length > 0) throw new Error(`${missing.length} render entry/entries have no candidateId`);
  const promoted = new Set(promotedCandidateIds);
  const selected = entries.filter((entry) => promoted.has(entry.candidateId!));
  if (selected.length === 0) throw new Error("No promoted candidates are available to render");
  return selected;
}

export function assertApprovedReviewWindows(
  selection: { decision?: string; candidates?: Array<{ candidateId?: string; startSec?: number; endSec?: number }> } | null,
  entries: Array<{ candidateId?: string; sourceStartSec?: number; sourceEndSec?: number; clipFile?: string }>,
  actualDurations: Record<string, number> = {},
): void {
  if (selection?.decision !== "liked all") return;
  const entriesById = new Map(entries.map((entry) => [entry.candidateId, entry]));
  for (const approved of selection.candidates ?? []) {
    const entry = entriesById.get(approved.candidateId);
    const approvedStart = approved.startSec;
    const approvedEnd = approved.endSec;
    const renderStart = entry?.sourceStartSec;
    const renderEnd = entry?.sourceEndSec;
    if (!entry || typeof approvedStart !== "number" || typeof approvedEnd !== "number"
      || typeof renderStart !== "number" || typeof renderEnd !== "number"
      || Math.abs(renderStart - approvedStart) > 0.05
      || Math.abs(renderEnd - approvedEnd) > 0.05) {
      throw new Error(`Approved review window changed for ${approved.candidateId ?? "unknown candidate"}`);
    }
    const actualDuration = entry.clipFile ? actualDurations[entry.clipFile] : undefined;
    if (actualDuration != null && Math.abs(actualDuration - (approvedEnd - approvedStart)) > 0.15) {
      throw new Error(`Approved review media duration changed for ${approved.candidateId}`);
    }
  }
}

export function publicationBlockers(state: {
  promoted: boolean;
  privateStatus?: string;
  rightsStatus?: string;
  qualityPassed: boolean;
  publishApproved: boolean;
}): string[] {
  const blockers: string[] = [];
  if (!state.promoted) blockers.push("not-promoted");
  if (state.privateStatus !== "keep") blockers.push("private-keep-missing");
  if (state.rightsStatus !== "cleared") blockers.push("rights-unresolved");
  if (!state.qualityPassed) blockers.push("quality-unresolved");
  if (!state.publishApproved) blockers.push("private-publish-approval-missing");
  return blockers;
}

export function hasFreshPreUploadPass(jobDir: string): boolean {
  const reportPath = join(jobDir, "preflight-pre-upload.json");
  const shortsDir = join(jobDir, "shorts");
  if (!existsSync(reportPath) || !existsSync(shortsDir)) return false;
  const report = JSON.parse(readFileSync(reportPath, "utf-8")) as {
    stage?: string;
    checks?: Array<{ name?: string; severity?: string }>;
  };
  const required = [
    "manifest.videoPath",
    "manifest.subtitlePath",
    "moments",
    "trim-results",
    "raw-clips",
    "shorts",
    "rendered-short-qa",
    "upload-metadata.md",
    "upload-metadata.json",
    "story-gates",
    "gemini-review",
  ];
  const byName = new Map((report.checks ?? []).map((check) => [check.name, check.severity]));
  if (report.stage !== "pre-upload" || required.some((name) => byName.get(name) !== "PASS")) return false;
  const reportTime = statSync(reportPath).mtimeMs;
  const inputs = [
    join(jobDir, "trim-results.json"),
    join(jobDir, "upload-metadata.json"),
    join(jobDir, "upload-metadata.md"),
    join(jobDir, "story-gates.json"),
    join(jobDir, "gemini-reviews.json"),
    ...readdirSync(shortsDir).filter((file) => file.endsWith(".mp4")).map((file) => join(shortsDir, file)),
  ];
  return inputs.every((input) => existsSync(input) && statSync(input).mtimeMs <= reportTime);
}
