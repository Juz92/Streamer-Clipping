import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { buildRecallUnion, type RecallUnionCandidate, type SemanticRecallCandidate, type ScorerRecallMoment } from "./lib/recall-union.js";
import { normalizeContentLane, normalizeViewerReaction } from "./lib/content-lanes.js";

interface LegacySourceMoment {
  momentId: string;
  startSec: number;
  endSec: number;
  categories?: string[];
}

export interface LegacyJobIndex {
  jobId: string;
  streamId: string;
  union: RecallUnionCandidate[];
  sourceByMomentId: Map<string, LegacySourceMoment>;
}

interface LegacyRouteRef {
  momentId?: string;
  sourceStartSec?: number;
  sourceEndSec?: number;
}

export function resolveProvenLegacyRoute(
  union: RecallUnionCandidate[],
  momentId: string | undefined,
  startSec: number | undefined,
  endSec: number | undefined,
): RecallUnionCandidate | null {
  if (!momentId || !Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
  const matches = union.filter((candidate) =>
    (
      candidate.momentId === momentId
      && Math.abs(candidate.startSec - startSec!) < 0.01
      && Math.abs(candidate.endSec - endSec!) < 0.01
    )
    || candidate.routeEvidence.some((evidence) =>
      evidence.momentId === momentId
      && Math.abs(evidence.startSec - startSec!) < 0.01
      && Math.abs(evidence.endSec - endSec!) < 0.01,
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function migrateTrimResults<T extends { approved?: Array<LegacyRouteRef & Record<string, unknown>> }>(
  job: LegacyJobIndex,
  artifact: T,
): { artifact: T; quarantined: Array<Record<string, unknown>> } {
  const approved: Array<Record<string, unknown>> = [];
  const quarantined: Array<Record<string, unknown>> = [];
  for (const item of artifact.approved ?? []) {
    const candidate = resolveProvenLegacyRoute(job.union, item.momentId, item.sourceStartSec, item.sourceEndSec);
    if (!candidate) {
      quarantined.push({ ...item, quarantineReason: "identity-not-proven" });
      continue;
    }
    approved.push({
      ...item,
      legacyMomentId: item.momentId,
      candidateId: candidate.candidateId,
      momentId: candidate.momentId,
    });
  }
  return {
    artifact: { ...artifact, approved } as T,
    quarantined,
  };
}

function normalizedStatus(value: unknown): "keep" | "reject" | "reserve" | null {
  const status = String(value ?? "").toLowerCase();
  if (status === "keep") return "keep";
  if (status === "drop" || status === "reject") return "reject";
  if (status === "reserve") return "reserve";
  return null;
}

function laneFor(job: LegacyJobIndex, momentId: string): string | null {
  const source = job.sourceByMomentId.get(momentId);
  for (const category of source?.categories ?? []) {
    const lane = normalizeContentLane(category);
    if (lane && lane !== "reject") return lane;
  }
  return null;
}

export function migrateLegacyReviewFeedback(
  input: { version?: number; records?: Array<Record<string, unknown> & { streamId?: string; decisions?: Array<Record<string, unknown> & LegacyRouteRef> }> },
  jobs: LegacyJobIndex[],
): {
  document: { version: 2; updatedAt: string; records: Array<Record<string, unknown> & { streamId: string; decisions: Array<Record<string, unknown>> }> };
  quarantined: Array<Record<string, unknown>>;
} {
  const quarantined: Array<Record<string, unknown>> = [];
  const byStream = new Map<string, Record<string, unknown> & { streamId: string; decisions: Array<Record<string, unknown>> }>();

  for (const record of input.records ?? []) {
    const streamId = record.streamId;
    if (!streamId) {
      quarantined.push({ ...record, quarantineReason: "stream-missing" });
      continue;
    }
    const target = byStream.get(streamId) ?? {
      streamId,
      reviewedAt: record.reviewedAt ?? new Date(0).toISOString(),
      suggestedRank: record.suggestedRank ?? null,
      chosenRank: record.chosenRank ?? null,
      acceptedSuggestedPick: record.acceptedSuggestedPick ?? false,
      notes: record.notes ?? "",
      decisions: [],
    };
    const decisionByCandidate = new Map(target.decisions.map((decision) => [String(decision.candidateId), decision]));

    for (const decision of record.decisions ?? []) {
      const possible = jobs.filter((job) => job.streamId === streamId).map((job) => ({
        job,
        candidate: resolveProvenLegacyRoute(job.union, decision.momentId, decision.sourceStartSec, decision.sourceEndSec),
      })).filter((item) => item.candidate);
      const resolved = possible.length === 1 ? possible[0] : null;
      const status = normalizedStatus(decision.status);
      const lane = resolved && decision.momentId ? laneFor(resolved.job, decision.momentId) : null;
      const reaction = normalizeViewerReaction(decision.reaction) ?? null;
      if (!resolved?.candidate || !status || !lane || !reaction || (status === "reject" && !decision.rejectionReason)) {
        quarantined.push({ streamId, ...decision, quarantineReason: "identity-or-label-not-proven" });
        continue;
      }
      decisionByCandidate.set(resolved.candidate.candidateId, {
        ...decision,
        legacyMomentId: decision.momentId,
        candidateId: resolved.candidate.candidateId,
        momentId: resolved.candidate.momentId,
        status,
        lane,
        reaction,
        rightsStatus: "unresolved",
        publishApproved: false,
      });
    }
    target.decisions = [...decisionByCandidate.values()];
    const reviewedAt = String(record.reviewedAt ?? target.reviewedAt);
    if (reviewedAt >= String(target.reviewedAt)) {
      target.reviewedAt = reviewedAt;
      target.notes = record.notes ?? target.notes;
      target.acceptedSuggestedPick = record.acceptedSuggestedPick ?? target.acceptedSuggestedPick;
    }
    byStream.set(streamId, target);
  }

  return {
    document: { version: 2, updatedAt: new Date().toISOString(), records: [...byStream.values()] },
    quarantined,
  };
}

interface RuntimeJob extends LegacyJobIndex {
  jobDir: string;
  manifest: Record<string, unknown> & { streamId: string; uploadDate?: string; videoPath?: string; subtitlePath?: string };
  generatedUnion: boolean;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf-8");
  renameSync(temporary, path);
}

function sourceMoment(raw: Record<string, unknown>): LegacySourceMoment | null {
  const momentId = String(raw.momentId ?? raw.id ?? "").trim();
  const startSec = Number(raw.startSec ?? raw.suggestedStartSec);
  const endSec = Number(raw.endSec ?? raw.suggestedEndSec);
  if (!momentId || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
  return { momentId, startSec, endSec, categories: Array.isArray(raw.categories) ? raw.categories.map(String) : [] };
}

function loadRuntimeJob(jobDir: string): RuntimeJob | null {
  const manifestPath = join(jobDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = readJson<RuntimeJob["manifest"]>(manifestPath);
  if (!manifest.streamId) return null;
  const jobId = jobDir.replace(/.*[\\/]/, "");
  const notebookPath = join(jobDir, "notebooklm-moments.json");
  const scorerPath = join(jobDir, "moments.json");
  const notebookRaw = existsSync(notebookPath) ? readJson<Array<Record<string, unknown>>>(notebookPath) : [];
  const scorerRaw = existsSync(scorerPath) ? readJson<Array<Record<string, unknown>>>(scorerPath) : [];
  const sourceByMomentId = new Map<string, LegacySourceMoment>();
  for (const raw of [...notebookRaw, ...scorerRaw]) {
    const source = sourceMoment(raw);
    if (source) sourceByMomentId.set(source.momentId, source);
  }
  const unionPath = join(jobDir, "recall-union.json");
  const generatedUnion = !existsSync(unionPath);
  const semantic = notebookRaw.flatMap((raw): SemanticRecallCandidate[] => {
    const source = sourceMoment(raw);
    if (!source) return [];
    return [{
      id: source.momentId,
      momentId: source.momentId,
      startSec: source.startSec,
      endSec: source.endSec,
      hook: String(raw.hook ?? raw.description ?? source.momentId),
      quote: typeof raw.quote === "string" ? raw.quote : undefined,
      categories: source.categories ?? [],
      sourceQuery: "legacy-notebooklm-exact",
      viralSubScores: raw.viralSubScores as Record<string, unknown> | undefined,
    }];
  });
  const scorer = scorerRaw.filter((raw) => sourceMoment(raw)).map((raw) => raw as unknown as ScorerRecallMoment);
  const union = generatedUnion
    ? buildRecallUnion(jobId, semantic, scorer)
    : readJson<RecallUnionCandidate[]>(unionPath);
  if (union.length === 0) return null;
  return { jobId, jobDir, streamId: manifest.streamId, manifest, union, sourceByMomentId, generatedUnion };
}

function candidatePointer(job: RuntimeJob, candidate: RecallUnionCandidate, prior?: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    ...(prior ?? {}),
    candidateId: candidate.candidateId,
    jobId: candidate.jobId,
    momentId: candidate.momentId,
    streamId: job.streamId,
    streamDate: job.manifest.uploadDate ?? "",
    categories: candidate.categories,
    viralScore: candidate.recallScore ?? 0,
    startSec: candidate.startSec,
    endSec: candidate.endSec,
    durationSec: candidate.durationSec,
    hook: candidate.description,
    recallRoutes: candidate.recallRoutes,
    routeEvidence: candidate.routeEvidence,
    status: prior?.status ?? "pending",
    statusUpdatedAt: prior?.statusUpdatedAt ?? now,
  };
}

function artifactEntries(path: string): Array<Record<string, unknown>> {
  const value = readJson<unknown>(path);
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const keys = path.endsWith("story-gates.json") ? ["results", "pass", "recut", "replace", "blocked"] : ["picks", "approved"];
  return keys.flatMap((key) => Array.isArray(object[key]) ? object[key] as Array<Record<string, unknown>> : []);
}

function parseRootArg(): { root: string; apply: boolean } {
  const args = process.argv.slice(2);
  const index = args.indexOf("--root");
  return {
    root: index >= 0 && args[index + 1] ? args[index + 1] : join(process.cwd(), "data", "clips"),
    apply: args.includes("--apply"),
  };
}

function main(): void {
  const { root, apply } = parseRootArg();
  const jobs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("job-"))
    .map((entry) => loadRuntimeJob(join(root, entry.name)))
    .filter((job): job is RuntimeJob => job !== null);
  const jobById = new Map(jobs.map((job) => [job.jobId, job]));
  const validCandidateIds = new Set(jobs.flatMap((job) => job.union.map((candidate) => candidate.candidateId)));
  const quarantined: Array<Record<string, unknown>> = [];
  const migratedTrim = new Map<string, unknown>();
  const staleArtifacts: string[] = [];

  for (const job of jobs) {
    const trimPath = join(job.jobDir, "trim-results.json");
    if (existsSync(trimPath)) {
      const migrated = migrateTrimResults(job, readJson<{ approved?: Array<LegacyRouteRef & Record<string, unknown>> }>(trimPath));
      migratedTrim.set(trimPath, migrated.artifact);
      quarantined.push(...migrated.quarantined.map((item) => ({ jobId: job.jobId, artifact: "trim-results.json", ...item })));
    }
    for (const file of ["story-gates.json", "pick-quality.json", "upload-log.json", "publication-outcomes.json"]) {
      const path = join(job.jobDir, file);
      if (!existsSync(path)) continue;
      const entries = artifactEntries(path);
      if (entries.some((entry) => !entry.candidateId || !validCandidateIds.has(String(entry.candidateId)))) staleArtifacts.push(path);
    }
  }

  const poolPath = join(root, "candidate-pool.json");
  const legacyPool = existsSync(poolPath)
    ? readJson<{ version?: number; candidates?: Array<Record<string, unknown>> }>(poolPath)
    : { version: 1, candidates: [] };
  const priorByCandidate = new Map<string, Array<Record<string, unknown>>>();
  for (const prior of legacyPool.candidates ?? []) {
    const job = jobById.get(String(prior.jobId));
    const candidate = job ? resolveProvenLegacyRoute(job.union, String(prior.momentId ?? ""), Number(prior.startSec), Number(prior.endSec)) : null;
    if (!job || !candidate) {
      quarantined.push({ artifact: "candidate-pool.json", ...prior, quarantineReason: "identity-not-proven" });
      continue;
    }
    const list = priorByCandidate.get(candidate.candidateId) ?? [];
    list.push(prior);
    priorByCandidate.set(candidate.candidateId, list);
  }
  const immutable = new Set(["posted-daily", "posted-weekly", "archived"]);
  const migratedPoolCandidates = jobs.flatMap((job) => job.union.map((candidate) => {
    const priors = priorByCandidate.get(candidate.candidateId) ?? [];
    const immutablePriors = priors.filter((prior) => immutable.has(String(prior.status)));
    if (immutablePriors.length > 1) throw new Error(`Multiple immutable legacy records resolve to ${candidate.candidateId}`);
    return candidatePointer(job, candidate, immutablePriors[0] ?? priors[0]);
  }));
  const migratedPool = { version: 1, updatedAt: new Date().toISOString(), candidates: migratedPoolCandidates };

  const feedbackPath = join(root, "manual-review-feedback.json");
  const feedback = existsSync(feedbackPath)
    ? migrateLegacyReviewFeedback(readJson(feedbackPath), jobs)
    : { document: { version: 2 as const, updatedAt: new Date().toISOString(), records: [] }, quarantined: [] };
  quarantined.push(...feedback.quarantined.map((item) => ({ artifact: "manual-review-feedback.json", ...item })));

  const regenerationCommands = jobs.filter((job) =>
    job.manifest.videoPath && job.manifest.subtitlePath
    && existsSync(job.manifest.videoPath) && existsSync(job.manifest.subtitlePath),
  ).flatMap((job) => [
    `npx tsx packages/clips/src/ground-candidates.ts --stream ${job.streamId}`,
    `npx tsx packages/clips/src/grounded-rank.ts --stream ${job.streamId}`,
  ]);
  const report = {
    mode: apply ? "apply" : "dry-run",
    generatedAt: new Date().toISOString(),
    jobs: jobs.map((job) => ({ jobId: job.jobId, unionCandidates: job.union.length, generatedUnion: job.generatedUnion })),
    pool: { before: legacyPool.candidates?.length ?? 0, after: migratedPoolCandidates.length },
    trimArtifacts: migratedTrim.size,
    staleArtifacts: staleArtifacts.map((path) => relative(root, path)),
    quarantinedRecords: quarantined.length,
    quarantineByArtifact: Object.fromEntries([...new Set(quarantined.map((item) => String(item.artifact ?? "unknown")))].map((artifact) => [
      artifact,
      quarantined.filter((item) => String(item.artifact ?? "unknown") === artifact).length,
    ])),
    regenerationCommands,
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantineDir = join(root, "legacy-quarantine", stamp);
  const backup = (path: string): void => {
    if (!existsSync(path)) return;
    const destination = join(quarantineDir, "originals", relative(root, path));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
  };

  for (const job of jobs.filter((item) => item.generatedUnion)) {
    const path = join(job.jobDir, "recall-union.json");
    writeJsonAtomic(path, job.union);
  }
  for (const [path, artifact] of migratedTrim) {
    backup(path);
    writeJsonAtomic(path, artifact);
  }
  backup(poolPath);
  writeJsonAtomic(poolPath, migratedPool);
  if (existsSync(feedbackPath)) backup(feedbackPath);
  writeJsonAtomic(feedbackPath, feedback.document);
  for (const path of staleArtifacts) {
    backup(path);
    unlinkSync(path);
  }
  writeJsonAtomic(join(quarantineDir, "unresolved-records.json"), quarantined);
  writeJsonAtomic(join(root, "legacy-migration-report.json"), report);
  console.log(JSON.stringify(report, null, 2));
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("migrate-legacy-artifacts.ts") || process.argv[1]?.endsWith("migrate-legacy-artifacts.js")) {
  main();
}
