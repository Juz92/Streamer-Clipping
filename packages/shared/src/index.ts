// Database
export { getDb, getSqlite, closeDb, DATA_DIR, schema } from "./db/connection.js";

// Types
export type { JobState } from "./types/job-states.js";
export {
  JOB_STATES,
  STATE_TRANSITIONS,
  canTransition,
  advanceState,
  toJobState,
  isAtOrPast,
} from "./types/job-states.js";
export type { ScriptSection, ScriptPackage } from "./types/script.js";
export type { ShotPlan } from "./types/visual-plan.js";
export type {
  WordTimestamp,
  CaptureResult,
  VoiceoverResult,
  RenderResult,
  UploadResult,
} from "./types/pipeline.js";

// Utilities
export { createLogger } from "./utils/logger.js";
export { hashUrl } from "./utils/hash.js";
export { withPipelineRetry } from "./utils/retry.js";
export { readStdin } from "./utils/stdin.js";
export { ensureDir, jobAssetDir } from "./utils/files.js";
export { msToFrames, secondsToFrames, framesToMs } from "./utils/timing.js";
export { ensureMediaToolsOnPath } from "./utils/media-tools.js";

import { ensureMediaToolsOnPath as addMediaTools } from "./utils/media-tools.js";

// Run on import. Everything downstream shells out to ffmpeg/ffprobe by bare
// program name, so PATH has to be right before the first child process spawns
// and there is no single entry point to do it in. Appending only ever adds a
// fallback, so this cannot change behaviour where ffmpeg already resolves.
addMediaTools();
