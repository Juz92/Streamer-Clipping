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
  youtubeUrl?: string;
  weeklyCompilationId?: string;
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
