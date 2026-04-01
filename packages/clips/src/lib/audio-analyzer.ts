import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { dirname, basename } from "path";

export interface AudioSample {
  timeSec: number;
  rmsLevel: number;
}

export interface AudioSignal {
  timestampSec: number;
  rmsLevel: number;
  deltaFromAvg: number;
  type: "spike" | "silence_to_loud";
}

export function extractAudioLevels(videoPath: string, outputPath: string): void {
  // Run ffmpeg from the output directory to avoid Windows path escaping issues
  const outDir = dirname(outputPath);
  const outFile = basename(outputPath);
  const result = spawnSync("ffmpeg", [
    "-i", videoPath,
    "-af", `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${outFile}`,
    "-vn", "-f", "null", "-",
  ], {
    cwd: outDir,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 600000,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (!existsSync(outputPath)) {
    const stderr = result.stderr?.toString("utf-8") ?? "";
    throw new Error(`ffmpeg audio extraction failed (status ${result.status}): ${stderr.slice(-500)}`);
  }
}

export function parseAudioLevels(filePath: string): AudioSample[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const samples: AudioSample[] = [];
  let currentTime: number | null = null;

  for (const line of lines) {
    const timeMatch = line.match(/pts_time:([\d.]+)/);
    if (timeMatch) {
      currentTime = parseFloat(timeMatch[1]);
      continue;
    }
    const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=([-\d.inf]+)/);
    if (rmsMatch && currentTime !== null) {
      const rmsRaw = rmsMatch[1];
      const rmsLevel = rmsRaw === "-inf" ? -100 : parseFloat(rmsRaw);
      samples.push({ timeSec: currentTime, rmsLevel });
      currentTime = null;
    }
  }

  samples.sort((a, b) => a.timeSec - b.timeSec);
  return samples;
}

export function detectAudioSpikes(
  samples: AudioSample[],
  windowSec = 30,
  thresholdDb = 20,
): AudioSignal[] {
  const raw: AudioSignal[] = [];
  const halfWindow = windowSec / 2;

  // Use two-pointer sliding window for O(n) instead of O(n^2)
  let wStart = 0;
  let wEnd = 0;
  let windowSum = 0;
  let windowCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    // Expand window end
    while (wEnd < samples.length && samples[wEnd].timeSec <= s.timeSec + halfWindow) {
      windowSum += samples[wEnd].rmsLevel;
      windowCount++;
      wEnd++;
    }
    // Shrink window start
    while (wStart < i && samples[wStart].timeSec < s.timeSec - halfWindow) {
      windowSum -= samples[wStart].rmsLevel;
      windowCount--;
      wStart++;
    }
    const avg = windowCount > 0 ? windowSum / windowCount : s.rmsLevel;
    const delta = s.rmsLevel - avg;

    if (delta >= thresholdDb) {
      raw.push({ timestampSec: s.timeSec, rmsLevel: s.rmsLevel, deltaFromAvg: delta, type: "spike" });
    }

    if (i > 0 && samples[i - 1].rmsLevel < -40 && s.rmsLevel > -20) {
      raw.push({ timestampSec: s.timeSec, rmsLevel: s.rmsLevel, deltaFromAvg: delta, type: "silence_to_loud" });
    }
  }

  const merged: AudioSignal[] = [];
  for (const sig of raw) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.type === "spike" &&
      sig.type === "spike" &&
      sig.timestampSec - last.timestampSec <= 3
    ) {
      if (sig.deltaFromAvg > last.deltaFromAvg) {
        merged[merged.length - 1] = sig;
      }
    } else {
      merged.push(sig);
    }
  }

  return merged;
}
