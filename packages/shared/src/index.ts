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
