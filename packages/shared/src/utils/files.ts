import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve the asset directory for a job.
 * Handles both old format (job-5) and new format (job-5-modric).
 * For new jobs, call with a slug to create job-{id}-{slug}.
 */
export function jobAssetDir(dataDir: string, jobId: number, slug?: string): string {
  const assetsBase = join(dataDir, "assets");

  // Check for existing directory matching this job ID
  if (existsSync(assetsBase)) {
    try {
      const dirs = readdirSync(assetsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      // Look for job-{id}-* (new format) first
      const namedDir = dirs.find(d => d.match(new RegExp(`^job-${jobId}-`)));
      if (namedDir) return join(assetsBase, namedDir);

      // Fall back to job-{id} (old format)
      const plainDir = dirs.find(d => d === `job-${jobId}`);
      if (plainDir) return join(assetsBase, plainDir);
    } catch { /* directory listing failed, fall through */ }
  }

  // New directory — use slug if provided
  const dirName = slug ? `job-${jobId}-${slug}` : `job-${jobId}`;
  return join(assetsBase, dirName);
}
