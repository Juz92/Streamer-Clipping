import { getDb, schema, createLogger, advanceState, toJobState } from "@ltx/shared";
import type { ShotPlan } from "@ltx/shared";
import { eq } from "drizzle-orm";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve, join } from "path";

const log = createLogger("render");

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function msToFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--job")) {
    console.log("Usage: render.ts --job <job-id>");
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

  const visualPlan = db
    .select()
    .from(schema.visualPlans)
    .where(eq(schema.visualPlans.jobId, jobId))
    .get();
  if (!visualPlan) {
    log.error(`No visual plan found for job ${jobId}`);
    process.exit(1);
  }

  const jobAssets = db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.jobId, jobId))
    .all();

  const shots = visualPlan.shots as ShotPlan[];
  const fps = 30;

  const audioAsset = jobAssets.find((a) => a.type === "audio");
  const srtAsset = jobAssets.find((a) => a.type === "srt");

  // Build caption words from SRT subtitle JSON if available
  let captionWords: { word: string; startMs: number; endMs: number }[] = [];
  if (audioAsset) {
    const subtitleJsonPath = `${audioAsset.filePath}.json`;
    if (existsSync(subtitleJsonPath)) {
      const entries = JSON.parse(readFileSync(subtitleJsonPath, "utf-8"));
      captionWords = entries.map((e: { part: string; start: number; end: number }) => ({
        word: e.part.trim(),
        startMs: e.start,
        endMs: e.end,
      }));
    }
  }

  // Map shots to Remotion input format
  const remotionShots = shots.map((shot) => {
    const asset = jobAssets.find((a) => a.shotId === shot.id);
    let src: string | undefined;
    if (asset) {
      src = resolve(asset.filePath);
    }

    return {
      id: shot.id,
      type: shot.type,
      src,
      caption: shot.caption,
      heading: shot.type === "text_card" ? shot.textContent || shot.caption : undefined,
      body: undefined as string | undefined,
      durationFrames: msToFrames(shot.durationMs, fps),
      kenBurns: shot.kenBurns,
    };
  });

  const titleDurationFrames = 5 * fps; // 5 seconds
  const ctaDurationFrames = 5 * fps;   // 5 seconds

  const inputProps = {
    title: script.youtubeTitle,
    subtitle: script.hookText,
    shots: remotionShots,
    audioSrc: audioAsset ? resolve(audioAsset.filePath) : undefined,
    captionWords: captionWords.length > 0 ? captionWords : undefined,
    titleDurationFrames,
    ctaDurationFrames,
  };

  const outputDir = resolve(`data/assets/job-${jobId}/output`);
  ensureDir(outputDir);

  const propsPath = resolve(outputDir, "input-props.json");
  writeFileSync(propsPath, JSON.stringify(inputProps, null, 2), "utf-8");

  const videoPath = join(outputDir, "video.mp4");
  const thumbPath = join(outputDir, "thumbnail.png");
  const remotionRoot = resolve("packages/remotion/src/index.ts");

  // Render video
  log.info("Rendering video...", { jobId });
  try {
    execSync(
      `npx remotion render "${remotionRoot}" LongFormNews "${videoPath}" --props "${propsPath}" --codec h264` ,
      {
        cwd: resolve("."),
        stdio: "inherit",
        timeout: 600000, // 10 min
        env: { ...process.env, PATH: process.env.PATH + ":/c/Users/Justi/AppData/Local/Microsoft/WinGet/Links" },
      }
    );
  } catch (e) {
    log.error(`Video render failed: ${e instanceof Error ? e.message : String(e)}`, { jobId });
    process.exit(1);
  }

  // Render thumbnail
  log.info("Rendering thumbnail...", { jobId });
  const thumbProps = {
    title: script.youtubeTitle,
    accentColor: "#6366f1",
  };
  const thumbPropsPath = resolve(outputDir, "thumb-props.json");
  writeFileSync(thumbPropsPath, JSON.stringify(thumbProps, null, 2), "utf-8");

  try {
    execSync(
      `npx remotion still "${remotionRoot}" Thumbnail "${thumbPath}" --props "${thumbPropsPath}"`,
      {
        cwd: resolve("."),
        stdio: "inherit",
        timeout: 120000,
        env: { ...process.env, PATH: process.env.PATH + ":/c/Users/Justi/AppData/Local/Microsoft/WinGet/Links" },
      }
    );
  } catch (e) {
    log.error(`Thumbnail render failed: ${e instanceof Error ? e.message : String(e)}`, { jobId });
    process.exit(1);
  }

  // Record assets
  db.insert(schema.assets)
    .values({
      jobId,
      type: "rendered_video",
      filePath: videoPath,
    })
    .run();

  db.insert(schema.assets)
    .values({
      jobId,
      type: "thumbnail",
      filePath: thumbPath,
    })
    .run();

  const currentState = toJobState(job.state);
  if (currentState !== "rendered") {
    const newState = advanceState(currentState, "rendered");
    db.update(schema.jobs)
      .set({ state: newState, updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, jobId))
      .run();
  }

  log.info(`Render complete: ${videoPath}`, { jobId });
}

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
