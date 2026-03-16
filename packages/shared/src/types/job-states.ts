export const JOB_STATES = [
  "discovered",
  "ranked",
  "selected",
  "scripted",
  "visual_planned",
  "assets_captured",
  "voiced",
  "rendered",
  "uploaded_private",
  "scheduled",
  "published",
  "failed",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const STATE_TRANSITIONS: Record<JobState, JobState[]> = {
  discovered: ["ranked", "failed"],
  ranked: ["selected", "failed"],
  selected: ["scripted", "failed"],
  scripted: ["visual_planned", "failed"],
  visual_planned: ["assets_captured", "failed"],
  assets_captured: ["voiced", "failed"],
  voiced: ["rendered", "failed"],
  rendered: ["uploaded_private", "failed"],
  uploaded_private: ["scheduled", "failed"],
  scheduled: ["published", "failed"],
  published: [],
  failed: [
    "discovered",
    "ranked",
    "selected",
    "scripted",
    "visual_planned",
    "assets_captured",
    "voiced",
    "rendered",
    "uploaded_private",
    "scheduled",
  ],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export function advanceState(current: JobState, next: JobState): JobState {
  if (!canTransition(current, next)) {
    throw new Error(`Invalid state transition: ${current} -> ${next}`);
  }
  return next;
}
