/**
 * upload.ts — Prepare rendered shorts for distribution to YouTube, TikTok, and Instagram.
 *
 * Default mode generates manual upload packages with videos, captions, and instructions.
 * API uploads are available behind --api-upload flag for future automated workflows.
 *
 * Usage:
 *   npx tsx packages/clips/src/upload.ts --stream <id>                          # All platforms, manual packages
 *   npx tsx packages/clips/src/upload.ts --stream <id> --platform youtube       # YouTube only
 *   npx tsx packages/clips/src/upload.ts --stream <id> --platform tiktok        # TikTok only
 *   npx tsx packages/clips/src/upload.ts --stream <id> --clips 1,3              # Specific clips only
 *   npx tsx packages/clips/src/upload.ts --stream <id> --dry-run                # Preview without writing
 *   npx tsx packages/clips/src/upload.ts --stream <id> --api-upload             # Use API upload (when configured)
 *   npx tsx packages/clips/src/upload.ts --auth                                 # YouTube OAuth setup (for future API use)
 *
 * API upload requirements (only with --api-upload):
 *   - YouTube: data/client_secret.json (Google OAuth desktop credentials)
 *   - TikTok: TIKTOK_ACCESS_TOKEN env var (Content Posting API, requires app review)
 *   - Instagram: IG_ACCESS_TOKEN + IG_USER_ID env vars (Graph API, requires business account)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from "fs";
import { join, basename } from "path";
import { createInterface } from "readline";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { loadManifest, findStreamDir } from "./lib/manifest.js";
import { google, Auth } from "googleapis";

type Platform = "youtube" | "tiktok" | "instagram";
const ALL_PLATFORMS: Platform[] = ["youtube", "tiktok", "instagram"];

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
  apiUpload: boolean;
  platforms: Platform[];
}

function parseArgs(): UploadArgs {
  const args = process.argv.slice(2);
  const result: UploadArgs = { clips: [], all: true, dryRun: false, authOnly: false, apiUpload: false, platforms: [...ALL_PLATFORMS] };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) {
      result.streamId = args[++i];
    } else if (args[i] === "--clips" && args[i + 1]) {
      result.clips = args[++i].split(",").map(Number);
      result.all = false;
    } else if (args[i] === "--platform" && args[i + 1]) {
      const val = args[++i].toLowerCase();
      if (val === "all") {
        result.platforms = [...ALL_PLATFORMS];
      } else {
        result.platforms = val.split(",").map((p) => p.trim()) as Platform[];
      }
    } else if (args[i] === "--api-upload") {
      result.apiUpload = true;
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
function loadOAuth2Client(): InstanceType<typeof google.auth.OAuth2> {
  if (!existsSync(CLIENT_SECRET_PATH)) {
    throw new Error(`Missing ${CLIENT_SECRET_PATH}. Download OAuth desktop credentials from Google Cloud Console.`);
  }

  const raw = JSON.parse(readFileSync(CLIENT_SECRET_PATH, "utf-8"));
  const creds = raw.installed || raw.web;
  if (!creds) throw new Error("Invalid client_secret.json format");

  return new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris?.[0] || "http://localhost",
  );
}

/** Authenticate with YouTube API. Reuses saved token or initiates browser flow. */
async function authenticate(): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const oauth2 = loadOAuth2Client();

  // Try to reuse existing token
  if (existsSync(TOKEN_PATH)) {
    const token = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
    oauth2.setCredentials(token);

    // Refresh if expired
    if (token.expiry_date && Date.now() >= token.expiry_date - 60_000) {
      log.info("Token expired, refreshing...");
      const res = await oauth2.refreshAccessToken();
      oauth2.setCredentials(res.credentials);
      writeFileSync(TOKEN_PATH, JSON.stringify(res.credentials, null, 2), "utf-8");
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

// ─── TikTok Content Posting API ───────────────────────────────────────────────

/**
 * Upload a video to TikTok via Content Posting API.
 * Requires TIKTOK_ACCESS_TOKEN env var.
 * API docs: https://developers.tiktok.com/doc/content-posting-api-get-started
 *
 * Flow: init upload → upload video file → publish
 */
async function uploadToTikTok(
  videoPath: string,
  meta: ClipMeta,
): Promise<string> {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) throw new Error("TIKTOK_ACCESS_TOKEN not set");

  const fileSize = statSync(videoPath).size;
  log.info(`[TikTok] Uploading ${basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);

  // Step 1: Initialize upload
  const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        title: meta.tiktokCaption,
        privacy_level: "SELF_ONLY", // Start as private for QA
        disable_duet: false,
        disable_stitch: false,
        disable_comment: false,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: fileSize,
        chunk_size: fileSize, // Single chunk for shorts (< 60s)
        total_chunk_count: 1,
      },
    }),
  });

  if (!initRes.ok) {
    const errBody = await initRes.text();
    throw new Error(`TikTok init failed (${initRes.status}): ${errBody}`);
  }

  const initData = (await initRes.json()) as { data: { publish_id: string; upload_url: string } };
  const { publish_id, upload_url } = initData.data;

  // Step 2: Upload video binary
  const videoBuffer = readFileSync(videoPath);
  const uploadRes = await fetch(upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes 0-${fileSize - 1}/${fileSize}`,
    },
    body: videoBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`TikTok upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  }

  log.info(`  [TikTok] Uploaded: publish_id=${publish_id} (private/inbox)`);
  return publish_id;
}

// ─── Instagram Graph API (Reels) ─────────────────────────────────────────────

/**
 * Upload a video to Instagram as a Reel via Graph API.
 * Requires IG_ACCESS_TOKEN and IG_USER_ID env vars.
 * API docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
 *
 * Flow: create media container (with video URL) → poll until ready → publish
 * Note: Instagram requires a publicly accessible video URL, so for local files
 * we'd need a temporary hosting step. This implementation assumes the video
 * is accessible via a URL (e.g., uploaded to a CDN or temp host first).
 */
async function uploadToInstagram(
  videoPath: string,
  meta: ClipMeta,
): Promise<string> {
  const token = process.env.IG_ACCESS_TOKEN;
  const userId = process.env.IG_USER_ID;
  if (!token || !userId) throw new Error("IG_ACCESS_TOKEN and IG_USER_ID must be set");

  const fileSize = statSync(videoPath).size;
  log.info(`[Instagram] Uploading ${basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);

  // Instagram Graph API requires a publicly accessible video URL.
  // Check for a pre-uploaded URL in IG_VIDEO_HOST_URL, or fall back to manual package.
  const videoHostBase = process.env.IG_VIDEO_HOST_URL;
  if (!videoHostBase) {
    throw new Error(
      "IG_VIDEO_HOST_URL not set. Instagram requires a publicly accessible video URL. " +
      "Upload videos to a CDN first, or use the manual upload package."
    );
  }

  const videoUrl = `${videoHostBase}/${basename(videoPath)}`;

  // Step 1: Create media container
  const containerRes = await fetch(
    `https://graph.instagram.com/v21.0/${userId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "REELS",
        video_url: videoUrl,
        caption: meta.reelsCaption,
        share_to_feed: true,
        access_token: token,
      }),
    },
  );

  if (!containerRes.ok) {
    throw new Error(`Instagram container creation failed (${containerRes.status}): ${await containerRes.text()}`);
  }

  const containerData = (await containerRes.json()) as { id: string };
  const containerId = containerData.id;

  // Step 2: Poll for media container status (Instagram processes the video async)
  log.info(`  [Instagram] Media container created: ${containerId}. Waiting for processing...`);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 5000)); // 5s poll interval

    const statusRes = await fetch(
      `https://graph.instagram.com/v21.0/${containerId}?fields=status_code&access_token=${token}`,
    );
    const statusData = (await statusRes.json()) as { status_code: string };

    if (statusData.status_code === "FINISHED") {
      ready = true;
      break;
    }
    if (statusData.status_code === "ERROR") {
      throw new Error("Instagram media processing failed");
    }
  }

  if (!ready) throw new Error("Instagram media processing timed out after 150s");

  // Step 3: Publish
  const publishRes = await fetch(
    `https://graph.instagram.com/v21.0/${userId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: token,
      }),
    },
  );

  if (!publishRes.ok) {
    throw new Error(`Instagram publish failed (${publishRes.status}): ${await publishRes.text()}`);
  }

  const publishData = (await publishRes.json()) as { id: string };
  log.info(`  [Instagram] Published Reel: ${publishData.id}`);
  return publishData.id;
}

// ─── Manual Upload Package Generator ─────────────────────────────────────────

/**
 * Generate a ready-to-upload package for manual distribution.
 * Creates {jobDir}/distribute/{platform}/ with video copies and metadata files.
 */
function generateManualPackage(
  platform: Platform,
  jobDir: string,
  uploadPlan: Array<{ meta: ClipMeta; videoPath: string }>,
): void {
  const distDir = join(jobDir, "distribute", platform);
  mkdirSync(distDir, { recursive: true });

  const instructions: string[] = [];
  instructions.push(`# ${platform.charAt(0).toUpperCase() + platform.slice(1)} Upload Package`);
  instructions.push(`Generated: ${new Date().toISOString()}\n`);

  if (platform === "youtube") {
    instructions.push("## How to upload to YouTube Shorts");
    instructions.push("1. Go to https://studio.youtube.com/ → Create → Upload videos");
    instructions.push("2. Upload each .mp4 file (they are already 9:16 Shorts format)");
    instructions.push("3. For each video, copy the title and description from the matching .txt file");
    instructions.push("4. Set Category to Gaming");
    instructions.push("5. Add the tags listed in each clip's metadata file");
    instructions.push("6. Set visibility: upload as Unlisted or Private, then schedule or publish when ready");
    instructions.push("7. Tip: upload 1-3 clips per day for best algorithm engagement\n");
  } else if (platform === "tiktok") {
    instructions.push("## How to upload to TikTok");
    instructions.push("1. Open TikTok app or tiktok.com/upload");
    instructions.push("2. For each video below, upload the .mp4 file");
    instructions.push("3. Copy the caption from the corresponding .txt file");
    instructions.push("4. Set visibility to public when ready\n");
  } else if (platform === "instagram") {
    instructions.push("## How to upload to Instagram Reels");
    instructions.push("1. Open Instagram app → Create → Reel");
    instructions.push("2. For each video below, upload the .mp4 file");
    instructions.push("3. Copy the caption from the corresponding .txt file");
    instructions.push("4. Post as Reel\n");
  }

  instructions.push("## Clips\n");

  for (const { meta, videoPath } of uploadPlan) {
    const padded = String(meta.clipNum).padStart(2, "0");
    const vidName = `${padded}-${meta.slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}.mp4`;
    const metaName = `${padded}-metadata.txt`;

    // Copy video (symlink-safe: only copy if not already there)
    const destVideo = join(distDir, vidName);
    if (!existsSync(destVideo)) {
      copyFileSync(videoPath, destVideo);
    }

    // Write platform-specific metadata file
    let metaContent: string;
    if (platform === "youtube") {
      metaContent = [
        `TITLE: ${meta.ytTitle}`,
        "",
        "DESCRIPTION:",
        meta.ytDescription,
        "",
        `TAGS: ${meta.ytTags.join(", ")}`,
        "",
        "CATEGORY: Gaming",
        "VISIBILITY: Private (set to Public when ready)",
      ].join("\n");
    } else if (platform === "tiktok") {
      metaContent = `CAPTION:\n${meta.tiktokCaption}`;
    } else {
      metaContent = `CAPTION:\n${meta.reelsCaption}`;
    }

    writeFileSync(join(distDir, metaName), metaContent, "utf-8");

    instructions.push(`### Clip ${meta.clipNum}: ${meta.slug}`);
    instructions.push(`- Video: \`${vidName}\``);
    instructions.push(`- Metadata: \`${metaName}\``);
    if (platform === "youtube") {
      instructions.push(`- Title: ${meta.ytTitle}`);
    } else {
      const caption = platform === "tiktok" ? meta.tiktokCaption : meta.reelsCaption;
      instructions.push(`- Caption: ${caption}`);
    }
    instructions.push("");
  }

  writeFileSync(join(distDir, "README.md"), instructions.join("\n"), "utf-8");
  log.info(`  [${platform}] Manual upload package → ${distDir}`);
}

// ─── Platform Availability Checks ────────────────────────────────────────────

function hasTikTokCredentials(): boolean {
  return !!process.env.TIKTOK_ACCESS_TOKEN;
}

function hasInstagramCredentials(): boolean {
  return !!process.env.IG_ACCESS_TOKEN && !!process.env.IG_USER_ID;
}

function hasYouTubeCredentials(): boolean {
  return existsSync(CLIENT_SECRET_PATH);
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
    log.error("Usage: npx tsx packages/clips/src/upload.ts --stream <id> [--platform youtube|tiktok|instagram|all] [--clips 1,2] [--dry-run]");
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

  log.info(`\nUpload plan: ${uploadPlan.length} clips → [${args.platforms.join(", ")}]`);
  log.info(`  Job: ${basename(jobDir)}`);
  log.info(`  Stream: ${manifest.title}\n`);

  for (const { meta, videoPath } of uploadPlan) {
    const size = (statSync(videoPath).size / 1024 / 1024).toFixed(1);
    log.info(`  ${String(meta.clipNum).padStart(2, "0")}. "${meta.ytTitle}" (${size} MB)`);
  }

  log.info(`\nMode: ${args.apiUpload ? "API upload" : "manual upload packages"}`);
  log.info(`Platforms: [${args.platforms.join(", ")}]`);

  if (args.dryRun) {
    log.info("\n[DRY RUN] No packages generated.");
    for (const platform of args.platforms) {
      if (args.apiUpload) {
        const hasCredentials =
          (platform === "youtube" && hasYouTubeCredentials()) ||
          (platform === "tiktok" && hasTikTokCredentials()) ||
          (platform === "instagram" && hasInstagramCredentials());
        log.info(`[DRY RUN] ${platform}: ${hasCredentials ? "would upload via API" : "credentials missing → manual package"}`);
      } else {
        log.info(`[DRY RUN] ${platform}: would generate manual upload package`);
      }
    }
    return;
  }

  // Track all upload results across platforms
  const allResults: Array<{
    clipNum: number;
    platform: Platform;
    id: string;
    url: string;
    method: "api" | "manual_package";
    uploadedAt: string;
    privacyStatus: string;
  }> = [];

  for (const platform of args.platforms) {
    log.info(`\n${"─".repeat(40)}`);
    log.info(`  ${platform.toUpperCase()}`);
    log.info(`${"─".repeat(40)}`);

    // Use API upload only when --api-upload flag is set AND credentials exist
    const useApi = args.apiUpload && (
      (platform === "youtube" && hasYouTubeCredentials()) ||
      (platform === "tiktok" && hasTikTokCredentials()) ||
      (platform === "instagram" && hasInstagramCredentials())
    );

    if (useApi) {
      // ─── API Upload Path (opt-in via --api-upload) ─────────────────────
      if (platform === "youtube") {
        const oauth2 = await authenticate();
        const youtube = google.youtube({ version: "v3", auth: oauth2 });
        for (const { meta, videoPath } of uploadPlan) {
          try {
            const videoId = await uploadToYouTube(youtube, videoPath, meta);
            allResults.push({
              clipNum: meta.clipNum, platform: "youtube", id: videoId,
              url: `https://youtube.com/shorts/${videoId}`, method: "api",
              uploadedAt: new Date().toISOString(), privacyStatus: "private",
            });
          } catch (err: any) {
            log.error(`[YouTube] Failed clip ${meta.clipNum}: ${err.message}`);
          }
        }
      } else if (platform === "tiktok") {
        for (const { meta, videoPath } of uploadPlan) {
          try {
            const publishId = await uploadToTikTok(videoPath, meta);
            allResults.push({
              clipNum: meta.clipNum, platform: "tiktok", id: publishId,
              url: `https://tiktok.com/@daily.peanut.clip`, method: "api",
              uploadedAt: new Date().toISOString(), privacyStatus: "self_only",
            });
          } catch (err: any) {
            log.error(`[TikTok] Failed clip ${meta.clipNum}: ${err.message}`);
          }
        }
      } else if (platform === "instagram") {
        for (const { meta, videoPath } of uploadPlan) {
          try {
            const mediaId = await uploadToInstagram(videoPath, meta);
            allResults.push({
              clipNum: meta.clipNum, platform: "instagram", id: mediaId,
              url: `https://instagram.com/dailypeanutclipsandhighlights/`, method: "api",
              uploadedAt: new Date().toISOString(), privacyStatus: "published",
            });
          } catch (err: any) {
            log.error(`[Instagram] Failed clip ${meta.clipNum}: ${err.message}`);
          }
        }
      }
    } else {
      // ─── Manual Upload Package (default) ───────────────────────────────
      if (args.apiUpload) {
        log.info(`[${platform}] --api-upload requested but credentials missing. Falling back to manual package.`);
      }
      generateManualPackage(platform, jobDir, uploadPlan);
      for (const { meta } of uploadPlan) {
        allResults.push({
          clipNum: meta.clipNum, platform, id: "manual",
          url: join(jobDir, "distribute", platform), method: "manual_package",
          uploadedAt: new Date().toISOString(), privacyStatus: "pending_manual_upload",
        });
      }
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  log.info(`\n${"=".repeat(60)}`);
  log.info("  DISTRIBUTION COMPLETE");
  log.info(`${"=".repeat(60)}\n`);

  const apiUploads = allResults.filter((r) => r.method === "api");
  const manualPackages = allResults.filter((r) => r.method === "manual_package");

  if (apiUploads.length > 0) {
    log.info(`API uploads: ${apiUploads.length}`);
    for (const r of apiUploads) {
      log.info(`  [${r.platform}] Clip ${String(r.clipNum).padStart(2, "0")}: ${r.url}`);
    }
  }

  if (manualPackages.length > 0) {
    const platforms = [...new Set(manualPackages.map((r) => r.platform))];
    log.info(`\nManual upload packages generated for: ${platforms.join(", ")}`);
    for (const p of platforms) {
      log.info(`  ${join(jobDir, "distribute", p)}/`);
    }
    log.info("See README.md in each folder for upload instructions.");
  }

  const ytResults = apiUploads.filter((r) => r.platform === "youtube");
  if (ytResults.length > 0) {
    log.info("\nYouTube clips uploaded as PRIVATE. Review in YouTube Studio, then set to public.");
  }

  // Save upload results to job dir (merge with existing log if present)
  const uploadLogPath = join(jobDir, "upload-log.json");
  let existingLog: typeof allResults = [];
  if (existsSync(uploadLogPath)) {
    try {
      existingLog = JSON.parse(readFileSync(uploadLogPath, "utf-8"));
    } catch { /* start fresh */ }
  }

  // Merge: replace entries for same clip+platform, append new ones
  for (const result of allResults) {
    const idx = existingLog.findIndex(
      (e) => e.clipNum === result.clipNum && e.platform === result.platform,
    );
    if (idx >= 0) {
      existingLog[idx] = result;
    } else {
      existingLog.push(result);
    }
  }

  writeFileSync(uploadLogPath, JSON.stringify(existingLog, null, 2), "utf-8");
  log.info(`\nUpload log saved to ${uploadLogPath}`);
}

main().catch((err) => {
  log.error("Upload failed:", err.message ?? err);
  process.exit(1);
});
