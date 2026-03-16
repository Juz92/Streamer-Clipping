import { getDb, closeDb, DATA_DIR, schema, createLogger, advanceState, toJobState, withPipelineRetry } from "@ltx/shared";
import { eq } from "drizzle-orm";
import { google } from "googleapis";
import { readFileSync, createReadStream, existsSync } from "fs";
import { resolve, join } from "path";

const log = createLogger("upload");

function loadAuth() {
  const oauthPath = join(DATA_DIR, "youtube-oauth.json");
  if (!existsSync(oauthPath)) {
    throw new Error(
      "YouTube OAuth not configured. Run: npx tsx scripts/setup-youtube-oauth.ts"
    );
  }

  const tokens = JSON.parse(readFileSync(oauthPath, "utf-8"));
  const oauth2Client = new google.auth.OAuth2(
    tokens.client_id,
    tokens.client_secret
  );
  oauth2Client.setCredentials({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    expiry_date: tokens.expiry_date,
  });
  return oauth2Client;
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--job")) {
    console.log("Usage: upload.ts --job <job-id> [--schedule <ISO-datetime>]");
    process.exit(1);
  }

  const jobId = parseInt(args[args.indexOf("--job") + 1], 10);
  if (isNaN(jobId)) {
    log.error("Invalid job ID");
    process.exit(1);
  }

  const scheduledAt = args.includes("--schedule")
    ? args[args.indexOf("--schedule") + 1]
    : undefined;

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

  const jobAssets = db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.jobId, jobId))
    .all();

  const videoAsset = jobAssets.find((a) => a.type === "rendered_video");
  if (!videoAsset) {
    log.error(`No rendered video found for job ${jobId}`);
    process.exit(1);
  }

  const thumbnailAsset = jobAssets.find((a) => a.type === "thumbnail");

  const auth = loadAuth();
  const youtube = google.youtube({ version: "v3", auth });

  log.info("Uploading video to YouTube...", { jobId });

  const tags = script.youtubeTags as string[];

  const response = await withPipelineRetry(
    async () => {
      return youtube.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title: script.youtubeTitle,
            description: script.youtubeDescription,
            tags,
            categoryId: "28", // Science & Technology
            defaultLanguage: "en",
          },
          status: {
            privacyStatus: "private",
            selfDeclaredMadeForKids: false,
            publishAt: scheduledAt,
          },
        },
        media: {
          body: createReadStream(videoAsset.filePath),
        },
      });
    },
    { maxRetries: 2, baseDelayMs: 5000, jobId }
  );

  const videoId = response.data.id;
  if (!videoId) {
    log.error("Upload returned no video ID", { jobId });
    process.exit(1);
  }

  log.info(`Video uploaded: ${videoId}`, { jobId });

  // Upload thumbnail
  if (thumbnailAsset && existsSync(thumbnailAsset.filePath)) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: {
          body: createReadStream(thumbnailAsset.filePath),
        },
      });
      log.info("Thumbnail uploaded", { jobId });
    } catch (e) {
      log.warn(
        `Thumbnail upload failed (may require verified account): ${e instanceof Error ? e.message : String(e)}`,
        { jobId }
      );
    }
  }

  // Record upload
  db.insert(schema.uploads)
    .values({
      jobId,
      youtubeVideoId: videoId,
      privacyStatus: "private",
      scheduledPublishAt: scheduledAt || null,
    })
    .run();

  const currentState = toJobState(job.state);
  if (currentState !== "uploaded_private") {
    const newState = advanceState(currentState, "uploaded_private");
    db.update(schema.jobs)
      .set({ state: newState, updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, jobId))
      .run();
  }

  log.info(`Upload complete. Video ID: ${videoId}`, { jobId });
  console.log(`\nYouTube Studio: https://studio.youtube.com/video/${videoId}/edit`);
}

process.on("exit", closeDb);

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
