import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";

export interface CandidatePointer {
  jobId: string;
  momentId: string;
  streamId: string;
  streamDate: string;
  categories: string[];
  viralScore: number;
  /** Absolute stream timestamp for the candidate. Needed for safe replacement extraction. */
  startSec?: number;
  /** Absolute stream end timestamp for the candidate. */
  endSec?: number;
  durationSec: number;
  hook: string;
  status:
    | "pending"
    | "posted-daily"
    | "posted-weekly"
    | "archived"
    | "rejected";
  statusUpdatedAt: string;
  postedDate?: string;
  youtubeVideoId?: string;
  youtubeUrl?: string;
  youtubePerformance?: YoutubePerformance;
  weeklyCompilationId?: string;
}

export interface YoutubePerformance {
  observedAt: string;
  ageHours: number;
  mature72h: boolean;
  views: number;
  averageViewPercentage: number;
  shares: number;
  likes?: number;
  comments?: number;
  averageViewDuration?: number;
  ctr?: number;
}

export interface CandidatePool {
  version: 1;
  updatedAt: string;
  candidates: CandidatePointer[];
}

/** Statuses that are treated as published state and never touched by --force. */
const IMMUTABLE_STATUSES = new Set<CandidatePointer["status"]>([
  "posted-daily",
  "posted-weekly",
  "archived",
]);

function emptyPool(): CandidatePool {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    candidates: [],
  };
}

/**
 * Load the pool from disk. Returns an empty pool if the file does not exist.
 * Throws if the file exists but is corrupted (data integrity > progress).
 */
export function loadPool(path: string): CandidatePool {
  if (!existsSync(path)) return emptyPool();
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as CandidatePool;
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported candidate pool version: ${parsed.version} (expected 1)`,
    );
  }
  return parsed;
}

/**
 * Save the pool atomically: write to a temp file, then rename.
 * Ensures readers never see a partially-written file.
 */
export function savePool(path: string, pool: CandidatePool): void {
  mkdirSync(dirname(path), { recursive: true });
  pool.updatedAt = new Date().toISOString();
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(pool, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

/**
 * Append new candidate pointers. Read → modify → write atomically.
 * Does not deduplicate — callers should use removeByJobId first if needed.
 */
export function appendCandidates(
  path: string,
  candidates: CandidatePointer[],
): void {
  const pool = loadPool(path);
  pool.candidates.push(...candidates);
  savePool(path, pool);
}

export interface YoutubeCandidateLink {
  jobId: string;
  momentId: string;
  videoId: string;
  linkedAt: string;
}

/**
 * Attach a YouTube video ID to one exact source candidate.
 * Moment IDs repeat between jobs, so matching by moment ID alone is unsafe.
 */
export function linkYoutubeUpload(
  path: string,
  link: YoutubeCandidateLink,
): CandidatePointer {
  if (!link.jobId || !link.momentId) {
    throw new Error("YouTube alignment requires both jobId and momentId");
  }
  if (!/^[A-Za-z0-9_-]{6,}$/.test(link.videoId)) {
    throw new Error(`Invalid YouTube video ID: ${link.videoId}`);
  }

  const pool = loadPool(path);
  const matches = pool.candidates.filter(
    (candidate) => candidate.jobId === link.jobId && candidate.momentId === link.momentId,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one candidate for ${link.jobId}:${link.momentId}; found ${matches.length}`,
    );
  }

  const candidate = matches[0];
  candidate.youtubeVideoId = link.videoId;
  candidate.youtubeUrl = `https://youtube.com/shorts/${link.videoId}`;
  candidate.statusUpdatedAt = link.linkedAt;
  savePool(path, pool);
  return candidate;
}

/** Mark an already-linked YouTube upload as a published daily clip. */
export function recordYoutubePublication(
  path: string,
  publication: Omit<YoutubeCandidateLink, "linkedAt"> & { postedAt: string },
): CandidatePointer {
  linkYoutubeUpload(path, {
    jobId: publication.jobId,
    momentId: publication.momentId,
    videoId: publication.videoId,
    linkedAt: publication.postedAt,
  });

  const pool = loadPool(path);
  const candidate = pool.candidates.find(
    (item) => item.jobId === publication.jobId && item.momentId === publication.momentId,
  )!;
  candidate.status = "posted-daily";
  candidate.postedDate = publication.postedAt.slice(0, 10);
  candidate.statusUpdatedAt = publication.postedAt;
  savePool(path, pool);
  return candidate;
}

/** Join an owned YouTube performance snapshot back to its exact source window. */
export function recordYoutubePerformance(
  path: string,
  snapshot: Omit<YoutubePerformance, "ageHours" | "mature72h"> & { videoId: string },
): CandidatePointer {
  const pool = loadPool(path);
  const matches = pool.candidates.filter((candidate) => candidate.youtubeVideoId === snapshot.videoId);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one candidate for YouTube ${snapshot.videoId}; found ${matches.length}`);
  }

  const candidate = matches[0];
  const ageHours = Math.max(
    0,
    (Date.parse(snapshot.observedAt) - Date.parse(candidate.statusUpdatedAt)) / 3_600_000,
  );
  candidate.youtubePerformance = {
    observedAt: snapshot.observedAt,
    ageHours,
    mature72h: ageHours >= 72,
    views: snapshot.views,
    averageViewPercentage: snapshot.averageViewPercentage,
    shares: snapshot.shares,
    likes: snapshot.likes,
    comments: snapshot.comments,
    averageViewDuration: snapshot.averageViewDuration,
    ctr: snapshot.ctr,
  };
  savePool(path, pool);
  return candidate;
}

/**
 * Remove all `pending` candidates for a given jobId. Immutable statuses
 * (posted-daily, posted-weekly, archived) are preserved unchanged.
 * Used when re-running a job with --force.
 */
export function removeByJobId(path: string, jobId: string): void {
  const pool = loadPool(path);
  pool.candidates = pool.candidates.filter(
    (c) => c.jobId !== jobId || IMMUTABLE_STATUSES.has(c.status),
  );
  savePool(path, pool);
}
