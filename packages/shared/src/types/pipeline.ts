export interface WordTimestamp {
  word: string;
  startMs: number;
  endMs: number;
}

export interface CaptureResult {
  shotId: string;
  type: "screenshot" | "recording";
  filePath: string;
  durationMs?: number;
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
