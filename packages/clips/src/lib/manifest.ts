import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { DATA_DIR, ensureDir } from "@ltx/shared";

export interface StreamManifest {
  streamId: string;
  channelHandle: string;
  title: string;
  uploadDate: string;
  durationSec: number;
  jobDir: string;
  videoPath: string;
  subtitlePath: string | null;
  chatPath: string | null;
  audioLevelsPath: string | null;
  momentsPath: string | null;
  // NEW: NotebookLM review fields (all optional, backwards-compat)
  notebookId?: string;
  notebookSourceId?: string;
  notebookLMReviewPath?: string;
  notebookLMReviewedAt?: string;
  phase:
    | "downloaded"
    | "analyzed"
    | "notebooklm-reviewed"
    | "clipped"
    | "uploaded";
  createdAt: string;
  updatedAt: string;
}

const CLIPS_DIR = join(DATA_DIR, "clips");

/**
 * Find existing job directory for a stream by scanning manifests.
 */
export function findStreamDir(streamId: string): string | null {
  if (!existsSync(CLIPS_DIR)) return null;

  const dirs = readdirSync(CLIPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const dir of dirs) {
    const manifestPath = join(CLIPS_DIR, dir, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const raw = readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(raw);
        if (manifest.streamId === streamId) {
          return join(CLIPS_DIR, dir);
        }
      } catch {
        /* skip invalid manifests */
      }
    }
  }

  return null;
}

function getNextJobNumber(): number {
  if (!existsSync(CLIPS_DIR)) return 1;

  const dirs = readdirSync(CLIPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let maxNum = 0;
  for (const dir of dirs) {
    const match = dir.match(/^job-(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  return maxNum + 1;
}

/**
 * Get the directory for a stream.
 * Returns existing job dir if found, otherwise creates a new job-NNN-YYYY-MM-DD path.
 */
export function getStreamDir(streamId: string, uploadDate?: string): string {
  const existing = findStreamDir(streamId);
  if (existing) return existing;

  const num = getNextJobNumber();
  const date = uploadDate || new Date().toISOString().split("T")[0];
  const padded = String(num).padStart(3, "0");
  return join(CLIPS_DIR, `job-${padded}-${date}`);
}

export function loadManifest(streamId: string): StreamManifest {
  const dir = findStreamDir(streamId);
  if (!dir) {
    throw new Error(`No job directory found for stream ${streamId}`);
  }
  const manifestPath = join(dir, "manifest.json");
  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as StreamManifest;
}

export function saveManifest(manifest: StreamManifest): void {
  const dir = manifest.jobDir || getStreamDir(manifest.streamId);
  ensureDir(dir);
  manifest.jobDir = dir;
  manifest.updatedAt = new Date().toISOString();
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}
