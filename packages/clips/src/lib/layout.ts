import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { Region } from "./config.js";

export type LayoutMode = "gameplay" | "talking";

export function detectLayoutMode(
  clipPath: string,
  gameplayRegion: Region,
  tempDir: string,
): LayoutMode {
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  const duration = parseFloat(
    execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${clipPath}"`,
      { encoding: "utf-8" },
    ).trim(),
  );

  const fps = 30;
  const totalFrames = Math.floor(duration * fps);
  const interval = Math.max(1, Math.floor(totalFrames / 6));

  const { x, y, w, h } = gameplayRegion;

  try {
    execSync(
      `ffmpeg -i "${clipPath}" -vf "select=not(mod(n\\,${interval})),crop=${w}:${h}:${x}:${y},scale=320:180" -vsync vfn -frames:v 5 "${join(tempDir, "gp_%02d.jpg")}" -y`,
      { encoding: "utf-8", stdio: "pipe" },
    );
  } catch {
    return "talking";
  }

  const framePaths = Array.from({ length: 5 }, (_, i) =>
    join(tempDir, `gp_${String(i + 1).padStart(2, "0")}.jpg`),
  ).filter((p) => existsSync(p));

  if (framePaths.length < 2) {
    cleanup(framePaths);
    return "talking";
  }

  let staticPairs = 0;
  const totalPairs = framePaths.length - 1;

  for (let i = 0; i < totalPairs; i++) {
    const isStatic = areFramesStatic(framePaths[i], framePaths[i + 1]);
    if (isStatic) staticPairs++;
  }

  cleanup(framePaths);

  const threshold = Math.ceil(totalPairs * 0.75);
  return staticPairs >= threshold ? "talking" : "gameplay";
}

function areFramesStatic(frame1: string, frame2: string): boolean {
  try {
    const output = execSync(
      `ffmpeg -i "${frame1}" -i "${frame2}" -filter_complex "blend=all_mode=difference,blackframe=amount=95:threshold=32" -f null - 2>&1`,
      { encoding: "utf-8", stdio: "pipe" },
    );
    return /blackframe/.test(output);
  } catch (e: unknown) {
    const stderr =
      e instanceof Error && "stderr" in e ? String((e as any).stderr) : "";
    const stdout =
      e instanceof Error && "stdout" in e ? String((e as any).stdout) : "";
    if (/blackframe/.test(stderr + stdout)) return true;

    // Fallback: compare file sizes
    try {
      const size1 = readFileSync(frame1).length;
      const size2 = readFileSync(frame2).length;
      const ratio = Math.min(size1, size2) / Math.max(size1, size2);
      return ratio > 0.92;
    } catch {
      return false;
    }
  }
}

function cleanup(paths: string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

export function extractRegionFrame(
  videoPath: string,
  timeSec: number,
  region: Region,
  outputPath: string,
): void {
  const { x, y, w, h } = region;
  execSync(
    `ffmpeg -ss ${timeSec} -i "${videoPath}" -vf "crop=${w}:${h}:${x}:${y}" -vframes 1 -q:v 3 "${outputPath}" -y`,
    { stdio: "pipe" },
  );
}
