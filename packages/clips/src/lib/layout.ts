import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { Region } from "./config.js";

export type LayoutMode = "gameplay" | "talking";

export function detectLayoutMode(
  clipPath: string,
  gameplayRegion: Region,
  tempDir: string,
  avatarRegion?: Region,
): LayoutMode {
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  const duration = parseFloat(
    execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${clipPath}"`,
      { encoding: "utf-8" },
    ).trim(),
  );

  const skipSec = Math.min(2, Math.max(0, duration - 5));
  const effectiveDuration = duration - skipSec;
  if (effectiveDuration < 1) return "talking";

  const fps = 30;
  const totalFrames = Math.floor(effectiveDuration * fps);
  const interval = Math.max(1, Math.floor(totalFrames / 8));

  const primaryResult = sampleRegionMotion(
    clipPath,
    skipSec,
    interval,
    gameplayRegion,
    tempDir,
    "gp",
  );

  if (primaryResult === "error" || primaryResult === "too_few_frames") {
    return "talking";
  }

  if (primaryResult === "gameplay") {
    return "gameplay";
  }

  const secondaryRegion: Region = {
    x: Math.min(gameplayRegion.x + Math.floor(gameplayRegion.w * 0.4), 1920 - 400),
    y: Math.floor(gameplayRegion.h * 0.1),
    w: Math.min(500, 1920 - gameplayRegion.x - Math.floor(gameplayRegion.w * 0.4)),
    h: Math.min(400, gameplayRegion.h),
  };

  const secondaryResult = sampleRegionMotion(
    clipPath,
    skipSec,
    interval,
    secondaryRegion,
    tempDir,
    "sec",
  );

  if (secondaryResult === "gameplay") {
    return "gameplay";
  }

  if (avatarRegion) {
    const avatarResult = sampleRegionMotion(
      clipPath,
      skipSec,
      interval,
      avatarRegion,
      tempDir,
      "av",
    );

    if (avatarResult === "gameplay") {
      return "gameplay";
    }
  }

  return "talking";
}

function sampleRegionMotion(
  clipPath: string,
  skipSec: number,
  interval: number,
  region: Region,
  tempDir: string,
  prefix: string,
): "gameplay" | "talking" | "error" | "too_few_frames" {
  const { x, y, w, h } = region;

  try {
    execSync(
      `ffmpeg -ss ${skipSec} -i "${clipPath}" -vf "select=not(mod(n\\,${interval})),crop=${w}:${h}:${x}:${y},scale=320:180" -frames:v 6 "${join(tempDir, `${prefix}_%02d.jpg`)}" -y`,
      { encoding: "utf-8", stdio: "pipe" },
    );
  } catch {
    return "error";
  }

  const framePaths = Array.from({ length: 6 }, (_, i) =>
    join(tempDir, `${prefix}_${String(i + 1).padStart(2, "0")}.jpg`),
  ).filter((p) => existsSync(p));

  if (framePaths.length < 3) {
    cleanup(framePaths);
    return "too_few_frames";
  }

  let staticPairs = 0;
  let darkFrames = 0;
  const totalPairs = framePaths.length - 1;

  for (const fp of framePaths) {
    if (isDarkFrame(fp)) darkFrames++;
  }

  if (darkFrames >= Math.ceil(framePaths.length * 0.5)) {
    cleanup(framePaths);
    return "talking";
  }

  for (let i = 0; i < totalPairs; i++) {
    const isStatic = areFramesStatic(framePaths[i], framePaths[i + 1]);
    if (isStatic) staticPairs++;
  }

  cleanup(framePaths);

  const threshold = Math.ceil(totalPairs * 0.5);
  return staticPairs >= threshold ? "talking" : "gameplay";
}

function isDarkFrame(framePath: string): boolean {
  try {
    const output = execSync(
      `ffmpeg -i "${framePath}" -vf "blackframe=amount=90:threshold=30" -f null - 2>&1`,
      { encoding: "utf-8", stdio: "pipe" },
    );
    return /blackframe/.test(output);
  } catch (e: unknown) {
    const combined =
      (e instanceof Error && "stderr" in e ? String((e as any).stderr) : "") +
      (e instanceof Error && "stdout" in e ? String((e as any).stdout) : "");
    return /blackframe/.test(combined);
  }
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
