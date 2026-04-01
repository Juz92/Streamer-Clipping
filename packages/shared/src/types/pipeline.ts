export interface WordTimestamp {
  word: string;
  startMs: number;
  endMs: number;
}

export interface CaptureResult {
  shotId: string;
  type: "still_image" | "map" | "timeline" | "badge" | "broll_video";
  filePath: string;
  durationMs?: number;
  attribution?: string;
}

export interface VoiceoverResult {
  audioPath: string;
  srtPath: string;
  durationMs: number;
  wordTimestamps: WordTimestamp[];
}

export interface RenderResult {
  videoPath: string;
  thumbnailPath: string;
  durationMs: number;
}

export interface UploadResult {
  youtubeVideoId: string;
  privacyStatus: "private" | "unlisted" | "public";
  scheduledPublishAt?: string;
}
