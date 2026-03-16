import { getDb, schema, createLogger, advanceState, toJobState } from "@ltx/shared";
import type { WordTimestamp } from "@ltx/shared";
import { eq } from "drizzle-orm";
import { EdgeTTS } from "node-edge-tts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const log = createLogger("voiceover");

const TTS_VOICE = process.env.TTS_VOICE || "en-US-AndrewNeural";

interface SubtitleEntry {
  part: string;
  start: number;
  end: number;
}

function subtitlesToWordTimestamps(entries: SubtitleEntry[]): WordTimestamp[] {
  return entries.map((e) => ({
    word: e.part.trim(),
    startMs: e.start,
    endMs: e.end,
  }));
}

function formatSrtTime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function generateSrt(entries: SubtitleEntry[], wordsPerGroup: number = 6): string {
  const lines: string[] = [];
  let index = 1;

  for (let i = 0; i < entries.length; i += wordsPerGroup) {
    const group = entries.slice(i, i + wordsPerGroup);
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const text = group.map((e) => e.part.trim()).join(" ");

    lines.push(String(index));
    lines.push(`${formatSrtTime(start)} --> ${formatSrtTime(end)}`);
    lines.push(text);
    lines.push("");
    index++;
  }

  return lines.join("\n");
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--job")) {
    console.log("Usage: voiceover.ts --job <job-id>");
    process.exit(1);
  }

  const jobId = parseInt(args[args.indexOf("--job") + 1], 10);
  if (isNaN(jobId)) {
    log.error("Invalid job ID");
    process.exit(1);
  }

  const db = getDb();
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (!job) {
    log.error(`Job ${jobId} not found`);
    process.exit(1);
  }

  const script = db
    .select()
    .from(schema.scripts)
    .where(eq(schema.scripts.jobId, jobId))
    .get();
  if (!script) {
    log.error(`No script found for job ${jobId}`);
    process.exit(1);
  }

  const audioDir = resolve(`data/assets/job-${jobId}/audio`);
  const srtDir = resolve(`data/assets/job-${jobId}/srt`);
  ensureDir(audioDir);
  ensureDir(srtDir);

  const audioPath = resolve(audioDir, "narration.mp3");
  const srtPath = resolve(srtDir, "captions.srt");

  log.info(`Generating voiceover with voice ${TTS_VOICE}`, { jobId });

  const tts = new EdgeTTS({
    voice: TTS_VOICE,
    lang: "en-US",
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
    saveSubtitles: true,
    timeout: 60000,
  });

  await tts.ttsPromise(script.fullNarration, audioPath);

  const subtitlePath = `${audioPath}.json`;
  if (!existsSync(subtitlePath)) {
    log.error("Subtitle JSON file was not generated");
    process.exit(1);
  }

  const subtitleEntries: SubtitleEntry[] = JSON.parse(
    readFileSync(subtitlePath, "utf-8")
  );

  const wordTimestamps = subtitlesToWordTimestamps(subtitleEntries);
  const srtContent = generateSrt(subtitleEntries);
  writeFileSync(srtPath, srtContent, "utf-8");

  const lastEntry = subtitleEntries[subtitleEntries.length - 1];
  const durationMs = lastEntry ? lastEntry.end : 0;

  db.insert(schema.assets)
    .values({
      jobId,
      type: "audio",
      filePath: audioPath,
      durationMs,
    })
    .run();

  db.insert(schema.assets)
    .values({
      jobId,
      type: "srt",
      filePath: srtPath,
    })
    .run();

  const currentState = toJobState(job.state);
  if (currentState !== "voiced") {
    const newState = advanceState(currentState, "voiced");
    db.update(schema.jobs)
      .set({ state: newState, updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, jobId))
      .run();
  }

  log.info(
    `Voiceover complete: ${durationMs}ms, ${wordTimestamps.length} words, SRT generated`,
    { jobId }
  );
}

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
