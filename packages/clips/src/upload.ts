/**
 * upload.ts — Upload rendered shorts to YouTube.
 *
 * Usage:
 *   npx tsx packages/clips/src/upload.ts --stream <id>                # Upload all shorts
 *   npx tsx packages/clips/src/upload.ts --stream <id> --clips 1,3    # Upload specific clips
 *   npx tsx packages/clips/src/upload.ts --stream <id> --dry-run      # Show what would upload
 *   npx tsx packages/clips/src/upload.ts --auth                       # Just authenticate (setup)
 *
 * Requires:
 *   - data/client_secret.json (Google OAuth desktop credentials)
 *   - First run opens browser for OAuth consent, saves token to data/youtube_token.json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { createInterface } from "readline";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { loadManifest, findStreamDir } from "./lib/manifest.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

const log = createLogger("upload");

const CLIENT_SECRET_PATH = join(DATA_DIR, "client_secret.json");
const TOKEN_PATH = join(DATA_DIR, "youtube_token.json");

// YouTube Shorts category: "Gaming" = 20
const GAMING_CATEGORY_ID = "20";

interface ClipMeta {
  clipNum: number;
  slug: string;
  ytTitle: string;
  ytDescription: string;
  ytTags: string[];
  tiktokCaption: string;
  reelsCaption: string;
}

interface UploadArgs {
  streamId?: string;
  clips: number[];
  all: boolean;
  dryRun: boolean;
  authOnly: boolean;
}

function parseArgs(): UploadArgs {
  const args = process.argv.slice(2);
  const result: UploadArgs = { clips: [], all: true, dryRun: false, authOnly: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) {
      result.streamId = args[++i];
    } else if (args[i] === "--clips" && args[i + 1]) {
      result.clips = args[++i].split(",").map(Number);
      result.all = false;
    } else if (args[i] === "--dry-run") {
      result.dryRun = true;
    } else if (args[i] === "--auth") {
      result.authOnly = true;
    }
  }

  return result;
}

/** Prompt user for input in terminal */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Load OAuth2 client from client_secret.json */
function loadOAuth2Client(): OAuth2Client {
  if (!existsSync(CLIENT_SECRET_PATH)) {
    throw new Error(`Missing ${CLIENT_SECRET_PATH}. Download OAuth desktop credentials from Google Cloud Console.`);
  }

  const raw = JSON.parse(readFileSync(CLIENT_SECRET_PATH, "utf-8"));
  const creds = raw.installed || raw.web;
  if (!creds) throw new Error("Invalid client_secret.json format");

  return new OAuth2Client(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris?.[0] || "http://localhost",
  );
}

/** Authenticate with YouTube API. Reuses saved token or initiates browser flow. */
async function authenticate(): Promise<OAuth2Client> {
  const oauth2 = loadOAuth2Client();

  // Try to reuse existing token
  if (existsSync(TOKEN_PATH)) {
    const token = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
    oauth2.setCredentials(token);

    // Refresh if expired
    if (token.expiry_date && Date.now() >= token.expiry_date - 60_000) {
      log.info("Token expired, refreshing...");
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2), "utf-8");
      log.info("Token refreshed and saved.");
    }

    return oauth2;
  }

  // First-time auth: generate URL, user visits in browser, pastes code
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  log.info("\n=== YouTube OAuth Setup ===");
  log.info("Open this URL in your browser:\n");
  log.info(authUrl);
  log.info("");

  const code = await prompt("Paste the authorization code here: ");
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
  log.info(`Token saved to ${TOKEN_PATH}`);

  return oauth2;
}

/**
 * Parse upload-metadata.md into structured clip metadata.
 * Handles the markdown format used by the pipeline.
 */
function parseUploadMetadata(mdPath: string): ClipMeta[] {
  const content = readFileSync(mdPath, "utf-8");
  const clips: ClipMeta[] = [];

  // Split on clip headers: ## NN -- Slug (Score: N)
  const clipSections = content.split(/^## (\d+) -- /m);

  // clipSections[0] is the preamble, then pairs of [number, content]
  for (let i = 1; i < clipSections.length; i += 2) {
    const clipNum = parseInt(clipSections[i], 10);
    const body = clipSections[i + 1] || "";

    // Extract slug from first line
    const firstLine = body.split("\n")[0];
    const slugMatch = firstLine.match(/^([^(]+)/);
    const slug = slugMatch
      ? slugMatch[1].replace(/--\s*POST FIRST/i, "").trim()
      : `clip-${clipNum}`;

    // Extract YouTube title
    const titleMatch = body.match(/\*\*YouTube Shorts Title:\*\*\s*(.+)/);
    const ytTitle = titleMatch ? titleMatch[1].trim() : slug;

    // Extract YouTube description (everything between **YouTube Description:** and the next **)
    const descMatch = body.match(
      /\*\*YouTube Description:\*\*\n([\s\S]*?)(?=\n\*\*TikTok Caption:|$)/,
    );
    const ytDescription = descMatch ? descMatch[1].trim() : "";

    // Extract TikTok caption
    const tiktokMatch = body.match(/\*\*TikTok Caption:\*\*\s*(.+)/);
    const tiktokCaption = tiktokMatch ? tiktokMatch[1].trim() : "";

    // Extract Reels caption
    const reelsMatch = body.match(/\*\*Reels Caption:\*\*\s*(.+)/);
    const reelsCaption = reelsMatch ? reelsMatch[1].trim() : "";

    clips.push({
      clipNum,
      slug,
      ytTitle,
      ytDescription,
      ytTags: [], // Will be filled from tags section
      tiktokCaption,
      reelsCaption,
    });
  }

  // Parse YouTube Tags section
  const tagsSection = content.match(/## YouTube Tags[\s\S]*$/);
  if (tagsSection) {
    const tagBlocks = tagsSection[0].matchAll(
      /### (\d+) -- .+?\n```\n([\s\S]*?)```/g,
    );
    for (const match of tagBlocks) {
      const num = parseInt(match[1], 10);
      const tags = match[2]
        .trim()
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const clip = clips.find((c) => c.clipNum === num);
      if (clip) clip.ytTags = tags;
    }
  }

  return clips;
}

/** Find rendered short file for a clip number in the shorts directory. */
function findShortFile(shortsDir: string, clipNum: number): string | null {
  const padded = String(clipNum).padStart(2, "0");
  const files = readdirSync(shortsDir).filter(
    (f) => f.startsWith(`${padded}-`) && f.endsWith(".mp4"),
  );
  return files.length > 0 ? join(shortsDir, files[0]) : null;
}

/** Upload a single video to YouTube as a Short. */
async function uploadToYouTube(
  youtube: ReturnType<typeof google.youtube>,
  videoPath: string,
  meta: ClipMeta,
): Promise<string> {
  const fileSize = statSync(videoPath).size;
  log.info(`Uploading ${basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: meta.ytTitle,
        description: meta.ytDescription,
        tags: meta.ytTags,
        categoryId: GAMING_CATEGORY_ID,
      },
      status: {
        privacyStatus: "private", // Upload as private first for QA review
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: (await import("fs")).createReadStream(videoPath),
    },
  });

  const videoId = res.data.id!;
  log.info(`  Uploaded: https://youtube.com/shorts/${videoId} (private)`);
  return videoId;
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Auth-only mode for initial setup
  if (args.authOnly) {
    await authenticate();
    log.info("Authentication successful. Ready to upload.");
    return;
  }

  if (!args.streamId) {
    log.error("Usage: npx tsx packages/clips/src/upload.ts --stream <id> [--clips 1,2] [--dry-run]");
    process.exit(1);
  }

  const manifest = loadManifest(args.streamId);
  const jobDir = manifest.jobDir;
  const shortsDir = join(jobDir, "shorts");
  const metadataPath = join(jobDir, "upload-metadata.md");

  if (!existsSync(shortsDir)) {
    log.error(`No shorts directory found at ${shortsDir}. Run render-fast first.`);
    process.exit(1);
  }

  if (!existsSync(metadataPath)) {
    log.error(`No upload-metadata.md found at ${metadataPath}. Generate metadata first.`);
    process.exit(1);
  }

  // Parse metadata
  const allClips = parseUploadMetadata(metadataPath);
  const clipsToUpload = args.all
    ? allClips
    : allClips.filter((c) => args.clips.includes(c.clipNum));

  if (clipsToUpload.length === 0) {
    log.error("No clips match the specified filter.");
    process.exit(1);
  }

  // Verify all video files exist before starting uploads
  const uploadPlan: Array<{ meta: ClipMeta; videoPath: string }> = [];
  for (const clip of clipsToUpload) {
    const videoPath = findShortFile(shortsDir, clip.clipNum);
    if (!videoPath) {
      log.warn(`Skipping clip ${clip.clipNum} — no rendered file found in ${shortsDir}`);
      continue;
    }
    uploadPlan.push({ meta: clip, videoPath });
  }

  log.info(`\nUpload plan: ${uploadPlan.length} clips to YouTube`);
  log.info(`  Job: ${basename(jobDir)}`);
  log.info(`  Stream: ${manifest.title}\n`);

  for (const { meta, videoPath } of uploadPlan) {
    const size = (statSync(videoPath).size / 1024 / 1024).toFixed(1);
    log.info(`  ${String(meta.clipNum).padStart(2, "0")}. "${meta.ytTitle}" (${size} MB)`);
  }

  if (args.dryRun) {
    log.info("\n[DRY RUN] No uploads performed.");
    return;
  }

  // Authenticate and create YouTube client
  const oauth2 = await authenticate();
  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  // Upload each clip
  const results: Array<{ clipNum: number; videoId: string; title: string }> = [];

  for (const { meta, videoPath } of uploadPlan) {
    try {
      const videoId = await uploadToYouTube(youtube, videoPath, meta);
      results.push({ clipNum: meta.clipNum, videoId, title: meta.ytTitle });
    } catch (err: any) {
      log.error(`Failed to upload clip ${meta.clipNum}: ${err.message}`);
      // Continue with remaining uploads
    }
  }

  // Summary
  log.info(`\n${"=".repeat(60)}`);
  log.info("  UPLOAD COMPLETE");
  log.info(`${"=".repeat(60)}\n`);

  log.info(`Uploaded: ${results.length}/${uploadPlan.length} clips\n`);

  for (const r of results) {
    log.info(`  ${String(r.clipNum).padStart(2, "0")}. ${r.title}`);
    log.info(`      https://youtube.com/shorts/${r.videoId}`);
  }

  if (results.length > 0) {
    log.info("\nAll clips uploaded as PRIVATE. Review in YouTube Studio, then set to public.");
    log.info("YouTube Studio: https://studio.youtube.com/");
  }

  // Save upload results to job dir
  const uploadLog = results.map((r) => ({
    clipNum: r.clipNum,
    platform: "youtube",
    videoId: r.videoId,
    url: `https://youtube.com/shorts/${r.videoId}`,
    uploadedAt: new Date().toISOString(),
    privacyStatus: "private",
  }));

  const uploadLogPath = join(jobDir, "upload-log.json");
  writeFileSync(uploadLogPath, JSON.stringify(uploadLog, null, 2), "utf-8");
  log.info(`\nUpload log saved to ${uploadLogPath}`);
}

main().catch((err) => {
  log.error("Upload failed:", err.message ?? err);
  process.exit(1);
});
