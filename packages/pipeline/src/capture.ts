import { getDb, closeDb, DATA_DIR, schema, createLogger, advanceState, toJobState, ensureDir } from "@ltx/shared";
import type { ShotPlan } from "@ltx/shared";
import { eq } from "drizzle-orm";
import { chromium, type Page, type BrowserContext, type Browser } from "playwright";
import { resolve, join } from "path";

const log = createLogger("capture");

async function captureScreenshot(
  page: Page,
  shot: ShotPlan,
  outputDir: string
): Promise<string> {
  if (!shot.url) {
    throw new Error(`Shot ${shot.id} has no URL`);
  }
  await page.goto(shot.url, { waitUntil: "networkidle", timeout: 30000 });

  if (shot.scrollTo) {
    await page.evaluate((selector) => {
      document.querySelector(selector)?.scrollIntoView({ behavior: "instant" });
    }, shot.scrollTo);
    await page.waitForTimeout(500);
  }

  if (shot.clickSequence) {
    for (const selector of shot.clickSequence) {
      try {
        await page.click(selector, { timeout: 5000 });
        await page.waitForTimeout(300);
      } catch {
        log.warn(`Click failed for selector: ${selector}`, { shotId: shot.id });
      }
    }
  }

  const filePath = join(outputDir, `${shot.id}.png`);
  if (shot.selector) {
    const element = page.locator(shot.selector);
    await element.screenshot({ path: filePath });
  } else {
    await page.screenshot({ path: filePath, fullPage: false });
  }

  return filePath;
}

async function captureRecording(
  shot: ShotPlan,
  outputDir: string
): Promise<string> {
  if (!shot.url) {
    throw new Error(`Shot ${shot.id} has no URL`);
  }

  const filePath = join(outputDir, `${shot.id}.webm`);

  const browser = await chromium.launch({ headless: true });
  try {
    const recordingContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: { dir: outputDir, size: { width: 1920, height: 1080 } },
    });

    const page = await recordingContext.newPage();
    await page.goto(shot.url, { waitUntil: "networkidle", timeout: 30000 });

    if (shot.scrollTo) {
      await page.evaluate((selector) => {
        document.querySelector(selector)?.scrollIntoView({ behavior: "smooth" });
      }, shot.scrollTo);
    }

    if (shot.clickSequence) {
      for (const selector of shot.clickSequence) {
        try {
          await page.click(selector, { timeout: 5000 });
          await page.waitForTimeout(500);
        } catch {
          log.warn(`Click failed for selector: ${selector}`, { shotId: shot.id });
        }
      }
    }

    const recordDuration = Math.max(shot.durationMs, 2000);
    await page.waitForTimeout(recordDuration);

    const video = page.video();
    await page.close();

    if (!video) {
      throw new Error(`No video recorded for shot ${shot.id}`);
    }
    await video.saveAs(filePath);

    await recordingContext.close();
  } finally {
    await browser.close();
  }

  return filePath;
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--job")) {
    console.log("Usage: capture.ts --job <job-id>");
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

  const visualPlan = db
    .select()
    .from(schema.visualPlans)
    .where(eq(schema.visualPlans.jobId, jobId))
    .get();
  if (!visualPlan) {
    log.error(`No visual plan found for job ${jobId}`);
    process.exit(1);
  }

  const shots = visualPlan.shots as ShotPlan[];
  const screenshotDir = join(DATA_DIR, `assets/job-${jobId}/screenshots`);
  const recordingDir = join(DATA_DIR, `assets/job-${jobId}/recordings`);
  ensureDir(screenshotDir);
  ensureDir(recordingDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const capturableShots = shots.filter((s) => s.type !== "text_card");
  let captured = 0;
  let failed = 0;

  for (const shot of shots) {
    if (shot.type === "text_card") {
      log.info(`Skipping text_card shot ${shot.id} (rendered by Remotion)`, { jobId });
      continue;
    }

    try {
      let filePath: string;
      let assetType: "screenshot" | "recording";

      if (shot.type === "screenshot") {
        const page = await context.newPage();
        filePath = await captureScreenshot(page, shot, screenshotDir);
        await page.close();
        assetType = "screenshot";
      } else {
        filePath = await captureRecording(shot, recordingDir);
        assetType = "recording";
      }

      db.insert(schema.assets)
        .values({
          jobId,
          shotId: shot.id,
          type: assetType,
          filePath,
          durationMs: shot.durationMs,
        })
        .run();

      log.info(`Captured ${assetType}: ${shot.id}`, { jobId, filePath });
      captured++;
    } catch (e) {
      log.error(`Failed to capture shot ${shot.id}: ${e instanceof Error ? e.message : String(e)}`, {
        jobId,
      });
      failed++;
    }
  }

  await browser.close();

  // Only advance state if at least one shot was captured and not all failed
  if (capturableShots.length > 0 && failed === capturableShots.length) {
    db.update(schema.jobs)
      .set({
        state: "failed",
        retryFromState: job.state,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.jobs.id, jobId))
      .run();
    log.error(`All ${failed} captures failed — job marked as failed`, { jobId });
    process.exit(1);
  }

  const currentState = toJobState(job.state);
  if (currentState !== "assets_captured") {
    const newState = advanceState(currentState, "assets_captured");
    db.update(schema.jobs)
      .set({ state: newState, updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, jobId))
      .run();
  }

  log.info(`Capture complete: ${captured} captured, ${failed} failed`, { jobId });
}

process.on("exit", closeDb);

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
