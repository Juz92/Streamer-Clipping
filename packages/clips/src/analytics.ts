import { google } from "googleapis";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "fs";
import { execFileSync } from "child_process";
import { resolve, join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "@ltx/shared";
import {
  loadFeedback,
  emptyFeedback,
  recordClipPerformance,
  recomputeAdjustments,
  saveFeedback,
  type FeedbackState,
  type TitleArchetype,
  type SignalTier,
} from "./lib/feedback.js";
import { loadPool, recordYoutubePerformance } from "./lib/candidate-pool.js";

const log = createLogger("analytics");
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PUBLIC_CHANNEL_SHORTS_URL = process.env.DAILY_PEANUT_CHANNEL_URL || "https://www.youtube.com/@DailyPeanutClipsHighlights/shorts";

interface VideoAnalytics {
  dataSource: "youtube-analytics-api" | "public-yt-dlp-fallback";
  videoId: string;
  title: string;
  publishedAt: string;
  duration: string;
  durationSec: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  subscribersGained: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number;
  impressions: number;
  ctr: number;
  titleArchetype: TitleArchetype;
  signalTier: SignalTier;
  contentArchetype: string;
  candidateId?: string;
  sourceVodId?: string;
  sourceStartSec?: number;
  sourceEndSec?: number;
  contextMatch?: string;
}

interface CandidateContext {
  candidateId?: string;
  contentArchetype: string;
  titleArchetype: TitleArchetype;
  signalTier: SignalTier;
  categories: string[];
  sourceVodId?: string;
  sourceStartSec?: number;
  sourceEndSec?: number;
  matchedBy?: string;
}

interface ContextIndex {
  byVideoId: Map<string, CandidateContext>;
  byTitle: Map<string, CandidateContext>;
  byCandidateId: Map<string, CandidateContext>;
}

interface AnalyticsRollup {
  key: string;
  count: number;
  totalViews: number;
  avgViews: number;
  avgRetention: number;
  avgCtr: number;
  avgLikes: number;
  avgComments: number;
}

interface FeedbackReport {
  generatedAt: string;
  dataSource: "youtube-analytics-api" | "public-yt-dlp-fallback";
  weightUpdateApplied: boolean;
  privateMetricsMissing?: string[];
  window: { startDate: string; endDate: string; sinceDays: number };
  videosAnalyzed: number;
  totals: { views: number; likes: number; comments: number };
  titleArchetypes: AnalyticsRollup[];
  signalTiers: AnalyticsRollup[];
  contentArchetypes: AnalyticsRollup[];
  topPerformingArchetype?: string;
  underperformingPatterns: string[];
  recommendedWeightAdjustments: string[];
  caveats: string[];
}

const FULL_ANALYTICS_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "likes",
  "comments",
  "shares",
  "impressions",
  "impressionClickThroughRate",
];

const BASE_ANALYTICS_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "likes",
  "comments",
  "shares",
];

function getAuth() {
  const oauthPath = resolve("data/youtube-oauth.json");
  if (!existsSync(oauthPath)) {
    log.error("No OAuth tokens found. Run: npx tsx scripts/setup-youtube-oauth.ts");
    process.exit(1);
  }

  const creds = JSON.parse(readFileSync(oauthPath, "utf-8"));
  const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  auth.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token,
    token_type: creds.token_type,
    expiry_date: creds.expiry_date,
  });

  auth.on("tokens", (tokens) => {
    const updated = { ...creds, ...tokens };
    writeFileSync(oauthPath, JSON.stringify(updated, null, 2), "utf-8");
    log.info("OAuth tokens refreshed and saved");
  });

  return auth;
}

async function getVideoDetails(auth: any, videoIds: string[]): Promise<Map<string, any>> {
  const youtube = google.youtube({ version: "v3", auth });
  const map = new Map();

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const res = await youtube.videos.list({
      part: ["snippet", "statistics", "contentDetails"],
      id: batch,
    });

    for (const item of res.data.items || []) {
      map.set(item.id, {
        title: item.snippet?.title || "",
        publishedAt: item.snippet?.publishedAt || "",
        duration: item.contentDetails?.duration || "",
        views: parseInt(item.statistics?.viewCount || "0", 10),
        likes: parseInt(item.statistics?.likeCount || "0", 10),
        comments: parseInt(item.statistics?.commentCount || "0", 10),
      });
    }
  }

  return map;
}

async function getAnalyticsData(
  auth: any,
  videoIds: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, any>> {
  try {
    return await queryAnalyticsMetrics(auth, videoIds, startDate, endDate, FULL_ANALYTICS_METRICS);
  } catch (e: any) {
    log.warn(
      `Analytics API CTR/impressions query failed (${e.message || "unknown error"}); retrying without CTR. ` +
        "Existing OAuth may need yt-analytics.readonly scope for full ingestion.",
    );
  }

  try {
    return await queryAnalyticsMetrics(auth, videoIds, startDate, endDate, BASE_ANALYTICS_METRICS);
  } catch (e: any) {
    log.warn(`Analytics API: ${e.message || "no data yet (24-48hr delay)"}`);
    return new Map();
  }
}

async function queryAnalyticsMetrics(
  auth: any,
  videoIds: string[],
  startDate: string,
  endDate: string,
  metrics: string[],
): Promise<Map<string, any>> {
  const analytics = google.youtubeAnalytics({ version: "v2", auth });
  const map = new Map<string, any>();

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const res = await analytics.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: metrics.join(","),
      dimensions: "video",
      filters: `video==${batch.join(",")}`,
      sort: "-views",
      maxResults: 50,
    });

    for (const row of res.data.rows || []) {
      const videoId = row[0] as string;
      const current = map.get(videoId) ?? {};
      metrics.forEach((metric, idx) => {
        current[metric] = Number(row[idx + 1] ?? 0);
      });
      map.set(videoId, current);
    }
  }

  return map;
}

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

function parseLimit(args: string[]): number | null {
  if (!args.includes("--limit")) return null;
  const raw = args[args.indexOf("--limit") + 1];
  const n = parseInt(raw || "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getUploadVideoIds(auth: any, limit: number | null): Promise<string[]> {
  const youtube = google.youtube({ version: "v3", auth });
  const channelRes = await youtube.channels.list({
    part: ["contentDetails"],
    mine: true,
  });

  const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    log.error("Could not find uploads playlist");
    process.exit(1);
  }

  const videoIds: string[] = [];
  let nextPageToken: string | undefined;
  do {
    const playlistRes = await youtube.playlistItems.list({
      part: ["contentDetails"],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken: nextPageToken,
    });

    for (const item of playlistRes.data.items || []) {
      if (item.contentDetails?.videoId) {
        videoIds.push(item.contentDetails.videoId);
        if (limit && videoIds.length >= limit) return videoIds;
      }
    }
    nextPageToken = playlistRes.data.nextPageToken || undefined;
  } while (nextPageToken);

  return videoIds;
}

function isRecoverableAnalyticsBlocker(e: any): boolean {
  const msg = String(e?.message || e?.response?.data?.error || e || "").toLowerCase();
  return msg.includes("invalid_grant") || msg.includes("no oauth tokens") || msg.includes("youtube analytics") || msg.includes("insufficient") || msg.includes("permission");
}

function ytDlpInvocation(): { cmd: string; argsPrefix: string[] } {
  const candidates = [
    process.env.YT_DLP_PATH,
    "/home/justi/.hermes/workspace/tmp/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { cmd: candidate, argsPrefix: [] };
  }

  return { cmd: "python", argsPrefix: ["-m", "yt_dlp"] };
}

function fetchPublicFallbackResults(limit: number | null, contextIndex: ContextIndex): VideoAnalytics[] {
  const { cmd, argsPrefix } = ytDlpInvocation();
  const max = limit ?? 40;
  const raw = execFileSync(
    cmd,
    [
      ...argsPrefix,
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-end",
      String(max),
      PUBLIC_CHANNEL_SHORTS_URL,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed.entries) ? parsed.entries.slice(0, max) : [];
  const results: VideoAnalytics[] = [];

  for (const entry of entries) {
    const videoId = entry.id || extractVideoId(entry.url || entry.webpage_url || "");
    if (!videoId) continue;

    let detail: any = entry;
    try {
      const detailRaw = execFileSync(
        cmd,
        [...argsPrefix, "--dump-single-json", "--skip-download", "--no-warnings", `https://www.youtube.com/shorts/${videoId}`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 },
      );
      detail = JSON.parse(detailRaw);
    } catch (e: any) {
      log.warn(`Public fallback detail probe failed for ${videoId}: ${e.message || String(e)}`);
    }

    const title = detail.title || entry.title || "";
    const durationSec = Number(detail.duration ?? entry.duration ?? 0);
    const publishedAt = uploadDateToIso(detail.upload_date || entry.upload_date);
    const context = resolveContext(contextIndex, videoId, title);

    results.push({
      dataSource: "public-yt-dlp-fallback",
      videoId,
      title,
      publishedAt,
      duration: `${durationSec}s`,
      durationSec,
      views: Number(detail.view_count ?? entry.view_count ?? 0),
      likes: Number(detail.like_count ?? entry.like_count ?? 0),
      comments: Number(detail.comment_count ?? entry.comment_count ?? 0),
      shares: 0,
      subscribersGained: 0,
      estimatedMinutesWatched: 0,
      averageViewDuration: 0,
      averageViewPercentage: 0,
      impressions: 0,
      ctr: 0,
      titleArchetype: context.titleArchetype,
      signalTier: context.signalTier,
      contentArchetype: context.contentArchetype,
      candidateId: context.candidateId,
      sourceVodId: context.sourceVodId,
      sourceStartSec: context.sourceStartSec,
      sourceEndSec: context.sourceEndSec,
      contextMatch: context.matchedBy || "public-fallback",
    });
  }

  log.info(`Public fallback found ${results.length} video(s) from ${PUBLIC_CHANNEL_SHORTS_URL}`);
  return results;
}

function uploadDateToIso(uploadDate?: string): string {
  if (!uploadDate || !/^\d{8}$/.test(uploadDate)) return new Date().toISOString();
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00Z`;
}

async function main() {
  process.chdir(PROJECT_ROOT);
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log("Usage:");
    console.log("  analytics.ts --all                    Fetch analytics for all Daily Peanut videos");
    console.log("  analytics.ts --video <id>             Fetch analytics for a specific video");
    console.log("  analytics.ts --since <days>           How many days back to query (default: 28; weekly job uses 7)");
    console.log("  analytics.ts --limit <n>              Limit newest uploads inspected");
    console.log("  analytics.ts --json                   Output as JSON");
    console.log("  analytics.ts --feedback               Update pipeline weights from performance data");
    console.log("\nMetrics pulled: views, AVD, average view %, impressions, CTR, likes, comments, shares.");
    console.log("Feedback compares title archetypes (curiosity/quote/drama) and signal tiers (rescue/multi-signal/single-signal).");
    process.exit(0);
  }

  const sinceDays = args.includes("--since") ? parseInt(args[args.indexOf("--since") + 1], 10) : 28;
  const outputJson = args.includes("--json");
  const feedbackMode = args.includes("--feedback");
  const limit = parseLimit(args);
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - sinceDays * 86400000).toISOString().split("T")[0];
  const contextIndex = buildCandidateContextIndex();

  let results: VideoAnalytics[] = [];
  let usedPublicFallback = false;

  try {
    const auth = getAuth();
    let videoIds: string[] = [];

    if (args.includes("--video")) {
      videoIds = [args[args.indexOf("--video") + 1]];
    } else {
      videoIds = await getUploadVideoIds(auth, limit);
    }

    if (videoIds.length === 0) {
      console.log("No videos found on channel.");
      process.exit(0);
    }

    log.info(`Found ${videoIds.length} video(s)`);

    const details = await getVideoDetails(auth, videoIds);
    const analyticsData = await getAnalyticsData(auth, videoIds, startDate, endDate);

    for (const videoId of videoIds) {
      const detail = details.get(videoId);
      const analytics = analyticsData.get(videoId);

      if (!detail) continue;

      const durationSeconds = parseDuration(detail.duration);
      const context = resolveContext(contextIndex, videoId, detail.title);

      results.push({
        dataSource: "youtube-analytics-api",
        videoId,
        title: detail.title,
        publishedAt: detail.publishedAt,
        duration: `${durationSeconds}s`,
        durationSec: durationSeconds,
        views: analytics?.views ?? detail.views,
        likes: analytics?.likes ?? detail.likes,
        comments: analytics?.comments ?? detail.comments,
        shares: analytics?.shares ?? 0,
        subscribersGained: analytics?.subscribersGained ?? 0,
        estimatedMinutesWatched: analytics?.estimatedMinutesWatched ?? 0,
        averageViewDuration: analytics?.averageViewDuration ?? 0,
        averageViewPercentage: analytics?.averageViewPercentage ?? 0,
        impressions: analytics?.impressions ?? 0,
        ctr: analytics?.impressionClickThroughRate ?? 0,
        titleArchetype: context.titleArchetype,
        signalTier: context.signalTier,
        contentArchetype: context.contentArchetype,
        candidateId: context.candidateId,
        sourceVodId: context.sourceVodId,
        sourceStartSec: context.sourceStartSec,
        sourceEndSec: context.sourceEndSec,
        contextMatch: context.matchedBy,
      });
    }
  } catch (e: any) {
    if (!isRecoverableAnalyticsBlocker(e)) throw e;
    usedPublicFallback = true;
    log.warn(
      `Private YouTube Analytics blocked (${e.message || String(e)}); ` +
        "using public yt-dlp fallback. AVD, retention, impressions and CTR will be unavailable.",
    );
    results = fetchPublicFallbackResults(limit, contextIndex);
  }

  if (outputJson && !feedbackMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printVideoReport(results);
  }

  // Store snapshots immediately; the candidate marks them trainable at 72h.
  const poolPath = join(process.cwd(), "data", "clips", "candidate-pool.json");
  for (const result of results) {
    if (!result.candidateId || result.contextMatch === "heuristic") continue;
    try {
      recordYoutubePerformance(poolPath, {
        videoId: result.videoId,
        observedAt: new Date().toISOString(),
        views: result.views,
        averageViewPercentage: result.averageViewPercentage,
        shares: result.shares,
        likes: result.likes,
        comments: result.comments,
        averageViewDuration: result.averageViewDuration,
        ctr: result.ctr,
      });
    } catch (error: any) {
      log.warn(`Could not persist performance for ${result.videoId}: ${error.message}`);
    }
  }

  // ── Feedback mode: correlate with candidate context and update weights ──
  if (feedbackMode) {
    let feedback = loadFeedback() ?? emptyFeedback();
    let correlated = 0;
    const canApplyWeights = !usedPublicFallback;

    if (canApplyWeights) {
      for (const r of results) {
        recordClipPerformance(
          feedback,
          r.contentArchetype,
          r.durationSec,
          r.title,
          r.views,
          r.averageViewPercentage,
          {
            titleArchetype: r.titleArchetype,
            signalTier: r.signalTier,
            ctr: r.ctr,
            likes: r.likes,
            comments: r.comments,
            averageViewDuration: r.averageViewDuration,
          },
        );
        if (r.contextMatch && r.contextMatch !== "heuristic") correlated++;
      }

      recomputeAdjustments(feedback);
      saveFeedback(feedback);
    } else {
      correlated = results.filter((r) => r.contextMatch && r.contextMatch !== "heuristic" && r.contextMatch !== "public-fallback").length;
      recomputeAdjustments(feedback);
    }

    const report = buildFeedbackReport(results, feedback, startDate, endDate, sinceDays, canApplyWeights);
    const reportPath = join(process.cwd(), "data", "clips", "analytics-feedback-report.json");
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

    if (outputJson) {
      console.log(JSON.stringify({ results, feedback, report }, null, 2));
    } else {
      printFeedbackReport(feedback, report, correlated, reportPath);
    }
  }
}

function printVideoReport(results: VideoAnalytics[]): void {
  console.log("\n" + "=".repeat(70));
  console.log("DAILY PEANUT CLIPS — Video Analytics");
  console.log("=".repeat(70));

  for (const r of results) {
    console.log(`\n  ${r.title}`);
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  Video ID:        ${r.videoId}`);
    console.log(`  Published:       ${r.publishedAt.split("T")[0]}`);
    console.log(`  Duration:        ${r.duration}`);
    console.log(`  Views:           ${r.views.toLocaleString()}`);
    console.log(`  AVD:             ${formatSeconds(r.averageViewDuration)}`);
    console.log(`  Avg Viewed:      ${r.averageViewPercentage ? `${r.averageViewPercentage.toFixed(1)}%` : "processing/unavailable"}`);
    console.log(`  Impressions:     ${r.impressions ? r.impressions.toLocaleString() : "unavailable"}`);
    console.log(`  CTR:             ${r.ctr ? `${r.ctr.toFixed(2)}%` : "unavailable"}`);
    console.log(`  Likes:           ${r.likes.toLocaleString()}`);
    console.log(`  Comments:        ${r.comments}`);
    console.log(`  Shares:          ${r.shares}`);
    console.log(`  Title archetype: ${r.titleArchetype}`);
    console.log(`  Signal tier:     ${r.signalTier}`);
    console.log(`  Candidate:       ${r.candidateId ?? "unmatched"}`);
    console.log(`  URL:             https://youtube.com/shorts/${r.videoId}`);
    console.log(`  Analytics:       https://studio.youtube.com/video/${r.videoId}/analytics/tab-overview/period-default`);
  }

  console.log("\n" + "=".repeat(70));
  console.log(`Total: ${results.length} video(s), ${results.reduce((s, r) => s + r.views, 0).toLocaleString()} views`);
  console.log("=".repeat(70) + "\n");
}

function formatSeconds(seconds: number): string {
  return seconds > 0 ? `${seconds.toFixed(1)}s` : "processing/unavailable";
}

function buildCandidateContextIndex(): ContextIndex {
  const index: ContextIndex = {
    byVideoId: new Map(),
    byTitle: new Map(),
    byCandidateId: new Map(),
  };

  const poolPath = join(process.cwd(), "data", "clips", "candidate-pool.json");
  if (existsSync(poolPath)) {
    try {
      const pool = loadPool(poolPath);
      for (const candidate of pool.candidates) {
        const context = contextFromCandidate(candidate, "candidate-pool");
        addContext(index, context);
        const videoId = extractVideoId(candidate.youtubeUrl || "");
        if (videoId) index.byVideoId.set(videoId, context);
        if (candidate.hook) index.byTitle.set(normalizeTitle(candidate.hook), context);
      }
    } catch (e: any) {
      log.warn(`Could not read candidate pool: ${e.message || String(e)}`);
    }
  }

  const clipsDir = join(process.cwd(), "data", "clips");
  for (const file of collectJsonFiles(clipsDir, 5)) {
    ingestContextJson(index, file);
  }

  return index;
}

function collectJsonFiles(dir: string, maxDepth: number): string[] {
  if (!existsSync(dir) || maxDepth < 0) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (["source", "frames", "shorts", "visualqa-review"].includes(entry)) continue;
      out.push(...collectJsonFiles(path, maxDepth - 1));
    } else if (entry.endsWith(".json")) {
      out.push(path);
    }
  }
  return out;
}

function ingestContextJson(index: ContextIndex, path: string): void {
  const name = basename(path);
  const interesting =
    name.includes("candidate-pool") ||
    name.includes("story-gate-approved") ||
    name === "metadata.json" ||
    name === "package-manifest.json";
  if (!interesting) return;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(parsed.candidates)) {
      for (const candidate of parsed.candidates) addContext(index, contextFromCandidate(candidate, path));
    }
    if (Array.isArray(parsed.packages)) {
      for (const pkg of parsed.packages) addPackageContext(index, pkg, path);
    }
    if (parsed.candidateId && (parsed.recommendedTitle || parsed.titleVariants)) {
      addPackageContext(index, parsed, path);
    }
  } catch (e: any) {
    log.warn(`Could not parse context JSON ${path}: ${e.message || String(e)}`);
  }
}

function addPackageContext(index: ContextIndex, pkg: any, source: string): void {
  const base = mergeContexts(index.byCandidateId.get(pkg.candidateId), {
    candidateId: pkg.candidateId,
    contentArchetype: "general",
    titleArchetype: "unknown",
    signalTier: "unknown",
    categories: [],
    matchedBy: source,
  });
  addContext(index, base);

  if (pkg.recommendedTitle) {
    const titleArchetype = inferTitleArchetypeFromVariants(pkg.recommendedTitle, pkg.titleVariants);
    index.byTitle.set(
      normalizeTitle(pkg.recommendedTitle),
      mergeContexts(base, { ...base, titleArchetype, matchedBy: `${source}:recommendedTitle` }),
    );
  }

  if (Array.isArray(pkg.titleVariants)) {
    for (const variant of pkg.titleVariants) {
      if (!variant?.title) continue;
      index.byTitle.set(
        normalizeTitle(variant.title),
        mergeContexts(base, {
          ...base,
          titleArchetype: normalizeTitleArchetype(variant.archetype),
          matchedBy: `${source}:titleVariant`,
        }),
      );
    }
  }
}

function addContext(index: ContextIndex, context: CandidateContext): void {
  if (context.candidateId) {
    const merged = mergeContexts(index.byCandidateId.get(context.candidateId), context);
    index.byCandidateId.set(context.candidateId, merged);
  }
}

function resolveContext(index: ContextIndex, videoId: string, title: string): CandidateContext {
  const byVideo = index.byVideoId.get(videoId);
  const byTitle = index.byTitle.get(normalizeTitle(title));
  const base = byVideo || byTitle;
  const byCandidate = base?.candidateId ? index.byCandidateId.get(base.candidateId) : undefined;
  if (base || byCandidate) return mergeContexts(byCandidate, base);

  return {
    contentArchetype: inferContentArchetypeFromTitle(title),
    titleArchetype: inferTitleArchetype(title),
    signalTier: "unknown",
    categories: [],
    matchedBy: "heuristic",
  };
}

function mergeContexts(a?: CandidateContext, b?: CandidateContext): CandidateContext {
  if (!a && !b) {
    return {
      contentArchetype: "general",
      titleArchetype: "unknown",
      signalTier: "unknown",
      categories: [],
    };
  }
  if (!a) return b!;
  if (!b) return a;

  return {
    candidateId: b.candidateId || a.candidateId,
    sourceVodId: b.sourceVodId || a.sourceVodId,
    sourceStartSec: b.sourceStartSec ?? a.sourceStartSec,
    sourceEndSec: b.sourceEndSec ?? a.sourceEndSec,
    contentArchetype: pickMeaningful(b.contentArchetype, a.contentArchetype, "general"),
    titleArchetype: pickMeaningful(b.titleArchetype, a.titleArchetype, "unknown") as TitleArchetype,
    signalTier: pickMeaningful(b.signalTier, a.signalTier, "unknown") as SignalTier,
    categories: Array.from(new Set([...(a.categories || []), ...(b.categories || [])])),
    matchedBy: b.matchedBy || a.matchedBy,
  };
}

function pickMeaningful(primary: string | undefined, fallback: string | undefined, neutral: string): string {
  if (primary && primary !== neutral) return primary;
  if (fallback) return fallback;
  return neutral;
}

function contextFromCandidate(candidate: any, source: string): CandidateContext {
  const categories = Array.isArray(candidate.categories) ? candidate.categories : [];
  return {
    candidateId: candidate.candidateId,
    sourceVodId: candidate.streamId,
    sourceStartSec: candidate.startSec,
    sourceEndSec: candidate.endSec,
    contentArchetype: inferArchetypeFromCategories(categories, candidate.title || candidate.hook || ""),
    titleArchetype: candidate.title ? inferTitleArchetype(candidate.title) : "unknown",
    signalTier: inferSignalTier(candidate),
    categories,
    matchedBy: source,
  };
}

function inferArchetypeFromCategories(categories: string[], fallbackTitle = ""): string {
  if (categories.includes("friend-roast") || categories.includes("roast")) return "roast";
  if (categories.includes("crash-out") || categories.includes("meltdown")) return "crashout";
  if (categories.includes("skill") || categories.includes("clutch") || categories.includes("gameplay")) return "skill";
  if (categories.includes("one-liner") || categories.includes("quotable")) return "one-liner";
  if (categories.includes("story-of-stream") || categories.includes("callback") || categories.includes("running-bit")) return "story-payoff";
  return inferContentArchetypeFromTitle(fallbackTitle);
}

function inferContentArchetypeFromTitle(title: string): string {
  const lower = title.toLowerCase();
  if (/roast|cooked|violated|flamed/.test(lower)) return "roast";
  if (/panic|meltdown|erupts|crash|chaos|disaster/.test(lower)) return "crashout";
  if (/clutch|winch|rescue|survive|survives|win|works/.test(lower)) return "skill";
  if (/[“”"]/.test(title) || /quote|said|says/.test(lower)) return "one-liner";
  return "general";
}

function inferSignalTier(candidate: any): SignalTier {
  const status = String(candidate.status || "").toLowerCase();
  if (status.includes("rescue") || candidate.rescueReason) return "rescue-tier";

  const counts = candidate.signalCounts || {};
  const scores = candidate.signalScores || {};
  const sources = ["transcript", "chat", "audio"].filter((key) => {
    const count = Number(counts[key] ?? 0);
    const score = Number(scores[key] ?? 0);
    return count > 0 || score > 0.05;
  });

  if (sources.length >= 2) return "multi-signal";
  if (sources.length === 1) return "single-signal";
  return "unknown";
}

function inferTitleArchetypeFromVariants(title: string, variants: any[]): TitleArchetype {
  if (Array.isArray(variants)) {
    const normalized = normalizeTitle(title);
    const match = variants.find((v) => normalizeTitle(v?.title || "") === normalized);
    if (match?.archetype) return normalizeTitleArchetype(match.archetype);
  }
  return inferTitleArchetype(title);
}

function inferTitleArchetype(title: string): TitleArchetype {
  const lower = title.toLowerCase();
  if (/^(no way|wait|hold up|how|what|why|when|this|they|he|she)\b/.test(lower) || /\?/.test(title)) {
    return "curiosity";
  }
  if (/[“”\"]/.test(title) || /peanut'?s .* (said|turned|called)|picasso|quote/.test(lower)) {
    return "quote";
  }
  if (/cooked|panic|erupts|meltdown|chaos|disaster|survives|survival|thought|then it worked/.test(lower)) {
    return "drama";
  }
  return "other";
}

function normalizeTitleArchetype(value: string): TitleArchetype {
  const v = String(value || "").toLowerCase();
  if (["curiosity", "quote", "drama"].includes(v)) return v as TitleArchetype;
  if (v === "other") return "other";
  return "unknown";
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractVideoId(url: string): string | null {
  if (!url) return null;
  const match = url.match(/(?:shorts\/|watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/) || url.match(/^([A-Za-z0-9_-]{6,})$/);
  return match?.[1] || null;
}

function buildFeedbackReport(
  results: VideoAnalytics[],
  feedback: FeedbackState,
  startDate: string,
  endDate: string,
  sinceDays: number,
  weightUpdateApplied: boolean,
): FeedbackReport {
  const dataSource = results.some((r) => r.dataSource === "public-yt-dlp-fallback")
    ? "public-yt-dlp-fallback"
    : "youtube-analytics-api";
  const titleArchetypes = rollup(results, (r) => r.titleArchetype);
  const signalTiers = rollup(results, (r) => r.signalTier);
  const contentArchetypes = rollup(results, (r) => r.contentArchetype);
  const underperformingPatterns: string[] = [];
  const recommendedWeightAdjustments: string[] = [];
  const caveats: string[] = [];

  const topTitle = titleArchetypes[0];
  const weakestTitle = titleArchetypes[titleArchetypes.length - 1];
  const topSignal = signalTiers[0];
  const weakestSignal = signalTiers[signalTiers.length - 1];

  if (dataSource === "public-yt-dlp-fallback") {
    const topVideos = [...results].sort((a, b) => b.views - a.views).slice(0, 4);
    recommendedWeightAdjustments.push(
      `Directional title lesson from public views: keep concrete curiosity hooks that name the person/action/outcome (${topVideos.map((v) => `"${v.title}"`).join("; ")}).`,
    );
    recommendedWeightAdjustments.push(
      "Do not boost quote/drama/rescue/multi-signal weights from this fallback run; those need private retention/CTR plus candidate metadata.",
    );
    if (results.some((r) => /\bthis\b|got caught/i.test(r.title) && r.views < 100)) {
      underperformingPatterns.push(
        "Vague curiosity phrasing using THIS/got caught appears in the lowest public-view outliers; only use it when the thumbnail/first frame makes the payoff instantly obvious.",
      );
    }
  } else {
    if (topTitle) {
      recommendedWeightAdjustments.push(
        `Favor ${topTitle.key} title packaging next scan (${Math.round(topTitle.avgViews)} avg views, ${topTitle.avgCtr.toFixed(2)}% CTR, n=${topTitle.count}).`,
      );
    }
    if (weakestTitle && topTitle && weakestTitle.key !== topTitle.key) {
      underperformingPatterns.push(
        `${weakestTitle.key} titles lagged (${Math.round(weakestTitle.avgViews)} avg views vs ${Math.round(topTitle.avgViews)} for ${topTitle.key}).`,
      );
    }
    if (topSignal) {
      recommendedWeightAdjustments.push(
        `Favor ${topSignal.key} sourcing when available (${Math.round(topSignal.avgViews)} avg views, n=${topSignal.count}).`,
      );
    }
    if (weakestSignal && topSignal && weakestSignal.key !== topSignal.key) {
      underperformingPatterns.push(
        `${weakestSignal.key} clips trailed ${topSignal.key}; keep rescue picks capped unless retention/CTR proves otherwise.`,
      );
    }
  }

  const titleMultipliers = Object.entries(feedback.adjusted.titleArchetypeMultipliers);
  if (titleMultipliers.length > 0) {
    recommendedWeightAdjustments.push(
      `Title multipliers now: ${titleMultipliers.map(([k, v]) => `${k}=${v}`).join(", ")}.`,
    );
  }
  const signalMultipliers = Object.entries(feedback.adjusted.signalTierMultipliers);
  if (signalMultipliers.length > 0) {
    recommendedWeightAdjustments.push(
      `Signal-tier multipliers now: ${signalMultipliers.map(([k, v]) => `${k}=${v}`).join(", ")}.`,
    );
  }

  const unmatched = results.filter((r) => r.signalTier === "unknown" || r.contextMatch === "heuristic").length;
  if (unmatched > 0) {
    caveats.push(`${unmatched}/${results.length} video(s) lacked candidate metadata; title archetype was inferred from the public title and signal tier may be unknown.`);
  }
  if (dataSource === "public-yt-dlp-fallback") {
    caveats.push("Private YouTube Analytics was unavailable; this report uses public yt-dlp stats only.");
    caveats.push("Public fallback cannot measure AVD, average view percentage, impressions, CTR, shares, subscribers gained, or true in-window performance.");
    caveats.push("Durable scoring weights were not updated from public fallback data to avoid poisoning retention/CTR and signal-tier buckets with zeros/unknowns.");
  } else if (results.some((r) => r.ctr === 0 || r.averageViewDuration === 0)) {
    caveats.push("Some private analytics metrics were unavailable/processing; YouTube Analytics can lag 24-48 hours and OAuth needs yt-analytics.readonly for CTR/AVD.");
  }
  if (results.length < 10) {
    caveats.push("Small sample: treat weight changes as directional until at least 10 posted Shorts have full analytics.");
  }

  if (dataSource === "public-yt-dlp-fallback") {
    recommendedWeightAdjustments.push(
      "Re-run after YouTube OAuth re-auth before changing rescue-tier vs multi-signal multipliers; public data cannot identify signal tier or retention.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    dataSource,
    weightUpdateApplied,
    privateMetricsMissing: dataSource === "public-yt-dlp-fallback"
      ? ["averageViewDuration", "averageViewPercentage", "impressions", "CTR", "shares", "subscribersGained"]
      : undefined,
    window: { startDate, endDate, sinceDays },
    videosAnalyzed: results.length,
    totals: {
      views: results.reduce((sum, r) => sum + r.views, 0),
      likes: results.reduce((sum, r) => sum + r.likes, 0),
      comments: results.reduce((sum, r) => sum + r.comments, 0),
    },
    titleArchetypes,
    signalTiers,
    contentArchetypes,
    topPerformingArchetype: dataSource === "public-yt-dlp-fallback" ? "concrete-curiosity-directional" : topTitle?.key,
    underperformingPatterns,
    recommendedWeightAdjustments,
    caveats,
  };
}

function rollup(results: VideoAnalytics[], keyFn: (r: VideoAnalytics) => string): AnalyticsRollup[] {
  const map = new Map<string, VideoAnalytics[]>();
  for (const r of results) {
    const key = keyFn(r) || "unknown";
    map.set(key, [...(map.get(key) || []), r]);
  }

  return Array.from(map.entries())
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      totalViews: rows.reduce((sum, r) => sum + r.views, 0),
      avgViews: rows.reduce((sum, r) => sum + r.views, 0) / rows.length,
      avgRetention: rows.reduce((sum, r) => sum + r.averageViewPercentage, 0) / rows.length,
      avgCtr: rows.reduce((sum, r) => sum + r.ctr, 0) / rows.length,
      avgLikes: rows.reduce((sum, r) => sum + r.likes, 0) / rows.length,
      avgComments: rows.reduce((sum, r) => sum + r.comments, 0) / rows.length,
    }))
    .sort((a, b) => b.avgViews - a.avgViews);
}

function printFeedbackReport(
  feedback: FeedbackState,
  report: FeedbackReport,
  correlated: number,
  reportPath: string,
): void {
  console.log("\n" + "=".repeat(70));
  console.log(report.weightUpdateApplied ? "FEEDBACK LOOP UPDATED" : "FEEDBACK LOOP REPORT (NO WEIGHT UPDATE)");
  console.log("=".repeat(70));
  console.log(`  Data source: ${report.dataSource}`);
  console.log(`  Correlated with candidate context: ${correlated}/${report.videosAnalyzed} video(s)`);
  console.log("\n  Title archetype performance:");
  printRollup(report.titleArchetypes);
  console.log("\n  Signal-tier performance:");
  printRollup(report.signalTiers);
  console.log("\n  Content archetype multipliers:");
  for (const [k, v] of Object.entries(feedback.adjusted.archetypeMultipliers)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log("  Title multipliers:");
  for (const [k, v] of Object.entries(feedback.adjusted.titleArchetypeMultipliers)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log("  Signal-tier multipliers:");
  for (const [k, v] of Object.entries(feedback.adjusted.signalTierMultipliers)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log(`  Duration sweet spot: ${feedback.adjusted.durationSweetSpot.min}s-${feedback.adjusted.durationSweetSpot.max}s`);
  console.log(`  Setup penalty delta: ${feedback.adjusted.setupPenaltyDelta}`);
  console.log("\n  Recommended next scan adjustments:");
  for (const rec of report.recommendedWeightAdjustments) console.log(`    - ${rec}`);
  console.log("\n  Underperforming patterns:");
  for (const pattern of report.underperformingPatterns) console.log(`    - ${pattern}`);
  console.log("\n  Caveats:");
  for (const caveat of report.caveats) console.log(`    - ${caveat}`);
  console.log(`\n  Report: ${reportPath}`);
  console.log("=".repeat(70) + "\n");
}

function printRollup(rows: AnalyticsRollup[]): void {
  if (rows.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const row of rows) {
    console.log(
      `    ${row.key}: n=${row.count}, avg views=${Math.round(row.avgViews)}, ` +
        `avg viewed=${row.avgRetention.toFixed(1)}%, CTR=${row.avgCtr.toFixed(2)}%, ` +
        `avg likes=${row.avgLikes.toFixed(1)}, avg comments=${row.avgComments.toFixed(1)}`,
    );
  }
}

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
