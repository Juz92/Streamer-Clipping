export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function msToFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

export function framesToMs(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1000);
}
