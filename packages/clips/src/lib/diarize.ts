/**
 * diarize.ts — thin wrapper around review/diarize.py.
 *
 * Pyannote is optional. All public functions degrade gracefully when it's
 * unavailable: `isPyannoteAvailable()` returns false and `diarizeClip()`
 * returns null. Callers decide whether to skip speaker-aware features.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createLogger } from "@ltx/shared";

const log = createLogger("diarize");

export interface SpeakerTurn {
  start: number;
  end: number;
  speaker: string;
}

let _available: boolean | null = null;

/** Cached per-process check that the pyannote.audio Python package loads. */
export function isPyannoteAvailable(): boolean {
  if (_available !== null) return _available;
  try {
    execSync('python -c "from pyannote.audio import Pipeline"', {
      stdio: "pipe",
      timeout: 30_000,
    });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * Run diarization on a clip. Returns turn segments or null if unavailable /
 * failed. Cached: if `outPath` already exists it is loaded without re-running.
 */
export function diarizeClip(
  audioPath: string,
  outPath: string,
  scriptPath?: string,
): SpeakerTurn[] | null {
  if (existsSync(outPath)) {
    try {
      return JSON.parse(readFileSync(outPath, "utf-8")) as SpeakerTurn[];
    } catch {
      // fall through and re-run
    }
  }

  if (!process.env.HF_TOKEN) {
    log.warn("HF_TOKEN not set — skipping diarization");
    return null;
  }
  if (!isPyannoteAvailable()) {
    log.warn("pyannote.audio not installed — skipping diarization");
    return null;
  }

  const script =
    scriptPath ??
    join(process.cwd(), "packages", "clips", "review", "diarize.py");
  if (!existsSync(script)) {
    log.warn(`diarize.py not found at ${script}`);
    return null;
  }

  const result = spawnSync("python", [script, audioPath, outPath], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 600_000,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf-8").slice(-300) ?? "";
    log.warn(`diarize.py failed (status ${result.status}): ${stderr}`);
    return null;
  }
  if (!existsSync(outPath)) return null;
  try {
    return JSON.parse(readFileSync(outPath, "utf-8")) as SpeakerTurn[];
  } catch (e) {
    log.warn(`diarize JSON parse failed: ${(e as Error).message}`);
    return null;
  }
}

export function loadTurns(path: string): SpeakerTurn[] | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SpeakerTurn[];
  } catch {
    return null;
  }
}
