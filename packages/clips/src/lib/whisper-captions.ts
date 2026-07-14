import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { createLogger } from "@ltx/shared";

const log = createLogger("whisper-captions");

export interface WhisperWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TranscribeOptions {
  model?: string;
  device?: string;
  computeType?: string;
  vadMinSilenceMs?: number;
}

const DEFAULT_OPTIONS: TranscribeOptions = {
  model: "base.en",
  device: "cpu",
  computeType: "int8",
  vadMinSilenceMs: 300,
};

function checkWhisperAvailable(): boolean {
  try {
    const result = execSync(
      'python -c "from faster_whisper import WhisperModel; print(\'ok\')"',
      { stdio: "pipe", timeout: 10_000 },
    );
    return result.toString().trim() === "ok";
  } catch {
    return false;
  }
}

export function transcribeClip(
  clipPath: string,
  outputPath: string,
  options: TranscribeOptions = {},
): WhisperWord[] {
  // Graceful fallback if faster-whisper is not installed
  if (!checkWhisperAvailable()) {
    log.warn("faster-whisper not available — skipping transcription. Install: pip install faster-whisper");
    return [];
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };

  const script = `
import json, sys
from faster_whisper import WhisperModel

model = WhisperModel("${opts.model}", device="${opts.device}", compute_type="${opts.computeType}")

segments, info = model.transcribe(
    sys.argv[1],
    language="en",
    word_timestamps=True,
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=${opts.vadMinSilenceMs}),
)

words = []
for seg in segments:
    for w in seg.words:
        words.append({
            "word": w.word.strip(),
            "startMs": round(w.start * 1000, 1),
            "endMs": round(w.end * 1000, 1),
        })

with open(sys.argv[2], "w") as f:
    json.dump(words, f, indent=2)
print(f"Transcribed {len(words)} words")
`.trim();

  const tmpScript = outputPath + ".transcribe.py";
  writeFileSync(tmpScript, script, "utf-8");

  try {
    execSync(`python "${tmpScript}" "${clipPath}" "${outputPath}"`, {
      stdio: "pipe",
      timeout: 120_000,
    });
  } finally {
    try {
      const { unlinkSync } = require("fs");
      if (existsSync(tmpScript)) require("fs").unlinkSync(tmpScript);
    } catch {}
  }

  if (!existsSync(outputPath)) return [];

  return JSON.parse(readFileSync(outputPath, "utf8")) as WhisperWord[];
}

export function transcribeAllClips(
  rawClipsDir: string,
  outputDir: string,
  options?: TranscribeOptions,
): { transcribed: number; skipped: number; failed: number } {
  if (!checkWhisperAvailable()) {
    log.error("faster-whisper not available. Install with: pip install faster-whisper");
    return { transcribed: 0, skipped: 0, failed: 0 };
  }

  mkdirSync(outputDir, { recursive: true });

  const clips = readdirSync(rawClipsDir)
    .filter((f) => f.endsWith(".mp4"))
    .sort();

  if (clips.length === 0) {
    log.warn(`No .mp4 files found in ${rawClipsDir}`);
    return { transcribed: 0, skipped: 0, failed: 0 };
  }

  log.info(`Transcribing ${clips.length} clips with faster-whisper...`);

  let transcribed = 0;
  let skipped = 0;
  let failed = 0;

  for (const clip of clips) {
    const name = clip.replace(/\.mp4$/, "");
    const outPath = join(outputDir, `${name}.json`);

    if (existsSync(outPath)) {
      skipped++;
      continue;
    }

    const clipPath = join(rawClipsDir, clip);
    log.info(`  Transcribing: ${clip}...`);

    try {
      const words = transcribeClip(clipPath, outPath, options);
      if (words.length > 0) {
        transcribed++;
        log.info(`    -> ${words.length} words`);
      } else {
        failed++;
        log.warn(`    -> No words transcribed`);
      }
    } catch (err: any) {
      failed++;
      log.error(`    -> Failed: ${err.message}`);
    }
  }

  log.info(
    `\nWhisper transcription complete: ${transcribed} transcribed, ${skipped} skipped (cached), ${failed} failed`,
  );

  return { transcribed, skipped, failed };
}

export function loadWhisperCaptions(
  whisperDir: string,
  clipBasename: string,
): WhisperWord[] | null {
  const jsonPath = join(whisperDir, `${clipBasename.replace(/\.mp4$/, "")}.json`);
  if (!existsSync(jsonPath)) return null;
  return JSON.parse(readFileSync(jsonPath, "utf8")) as WhisperWord[];
}
