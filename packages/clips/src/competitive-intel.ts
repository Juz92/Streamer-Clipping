/**
 * competitive-intel.ts — Monitor top gaming clip channels for trending patterns.
 *
 * Scrapes successful gaming Shorts channels to extract:
 *   - Title patterns that are working now
 *   - Archetype trends (what clip types are getting views)
 *   - Duration sweet spots from top performers
 *   - Hook formulas gaining traction
 *
 * Usage:
 *   npx tsx packages/clips/src/competitive-intel.ts
 *   npx tsx packages/clips/src/competitive-intel.ts --channels <id1,id2,id3>
 *   npx tsx packages/clips/src/competitive-intel.ts --output intel-report.md
 *
 * The output feeds into pipeline decision-making by updating archetype
 * priorities and title pattern suggestions.
 */

import { execSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger, DATA_DIR, ensureDir } from "@ltx/shared";

const log = createLogger("comp-intel");

// Default channels to monitor — streamer/gaming clip packaging competitors.
// 2026-05-06 scan focus: Shorts feeds that repackage livestream/streamer moments,
// not original gameplay-only creator uploads.
const DEFAULT_CHANNELS = [
  "@WClipMedia",          // multi-streamer/Kai ecosystem clips; strongest current velocity
  "@StreamEchos",         // multi-streamer Twitch/gaming moments; bold hook overlays
  "@QTCinderellaClips",   // creator clip page; social/reaction packaging benchmark
  "@clipsofdantes",       // streamer reaction clip page; split-screen reaction benchmark
  "@JynxziOnTwitchClip",  // gameplay + facecam meme-caption benchmark
];

// Channels observed in the 2026-05-06 scan. Keep role labels to separate
// strict competitors from adjacent creator-owned/fan clip pages.
const KNOWN_VIRAL_GAMING_CHANNELS = [
  { handle: "@WClipMedia", name: "WClipMedia", role: "multi-streamer/Kai ecosystem clip aggregator" },
  { handle: "@StreamEchos", name: "StreamEchos", role: "multi-streamer Twitch/gaming moments" },
  { handle: "@QTCinderellaClips", name: "QTCinderella Clips", role: "creator clip page; social reaction packaging" },
  { handle: "@clipsofdantes", name: "clipsofdantes", role: "single-streamer reaction clip page" },
  { handle: "@JynxziOnTwitchClip", name: "Jynxzi Clips", role: "single-streamer gameplay/meme clip page" },
  { handle: "@ChexxPlays_en", name: "CHEXXTRA PLAYS", role: "emerging multi-streamer gaming moment repost page" },
];

const COMPETITIVE_PATTERN_ARCHETYPES = [
  {
    key: "celebrity-collab-payoff",
    status: "proven pattern",
    evidence: "@WClipMedia: 'Kai Cenat & JABBAWOCKEEZ Got into a Dance Battle 😂' — 11,748,816 views, 44s, 2026-04-29; 'Kai Cenat Rating Fan-Made Popcorns 😂🍿' — 2,270,516 views, 34s, 2026-05-02.",
    titleFormula: "[Streamer] & [guest] got into [specific event] 😂 / [Guest] told [streamer] [awkward quote] 😂",
    openingStyle: "recognizable face/guest or physical action in frame 0; no explanatory intro",
    captionStyle: "often minimal captions; title, names, emojis, and body language carry the hook",
    pipelineUse: "Boost named-person/guest recognition, visible body-language payoff, and broad social context.",
  },
  {
    key: "no-mercy-suspense",
    status: "proven pattern",
    evidence: "@StreamEchos: 'He Showed NO Mercy 😳 | Summit1g' — 15,762,990 views, 23s, 2026-03-28; visible opening uses facecam+gameplay with 'HE DIDN’T HOLD BACK' all-caps overlay.",
    titleFormula: "He showed NO MERCY 😳 | [streamer] / [Streamer] calls it until [twist] 💀 | [game]",
    openingStyle: "facecam + gameplay stack with the decision/conflict already on screen",
    captionStyle: "large white all-caps setup phrase with black outline; editorial hook, not full transcript",
    pipelineUse: "Boost clips where the first 2s clearly promise a win/loss/reveal/payoff question.",
  },
  {
    key: "split-screen-reaction-object",
    status: "proven pattern",
    evidence: "@clipsofdantes: 'Dantes Was On The Edge Of His Seat 😯' — 2,001,281 views, 64s, 2026-05-02; 'That Was A CLOSE CALL 😯' — 793,024 views, 15s, 2026-05-03.",
    titleFormula: "[Streamer] was on the edge of his seat 😯 / That was a CLOSE CALL 😯",
    openingStyle: "reaction facecam on top, simple external clip/game/meme underneath; stakes legible without stream context",
    captionStyle: "single-word or short all-caps cue such as LAST/CLOSE CALL, white with black outline",
    pipelineUse: "Boost reaction-gold when paired with a simple visual object/meme that cold viewers understand instantly.",
  },
  {
    key: "inside-joke-meme-caption",
    status: "proven pattern",
    evidence: "@JynxziOnTwitchClip: 'I just skipped 10 seconds 😭' — 768,601 views, 22s, 2026-05-02; 'Jynxzi can’t escape the Darth Maul joke 😭' — 247,885 views, 14s, 2026-05-02.",
    titleFormula: "I just [absurd action] 😭 / [Streamer] can’t escape the [running joke] 😭",
    openingStyle: "gameplay crop with small facecam; meme caption explains the joke immediately",
    captionStyle: "large white outlined meme text across the top; hashtags carry fandom discovery",
    pipelineUse: "Boost callbacks/running-bit only when the first caption translates the joke for cold viewers.",
  },
  {
    key: "social-awkwardness-roast",
    status: "proven pattern",
    evidence: "@QTCinderellaClips: 'Ludwig just loves them' — 778,592 views, 40s, 2026-04-07; 'Ludwig's ex' — 682,797 views, 46s, 2026-04-06; 'OMG RAE!' — 490,444 views, 38s, 2026-04-17.",
    titleFormula: "[Name] just loves them / [Name]'s ex / \"OMG [NAME]!\"",
    openingStyle: "talking-head/podcast crop or split-screen social setup; tension comes from known relationships",
    captionStyle: "sparse captions or cropped subtitle fragments; title carries the curiosity gap",
    pipelineUse: "Boost friend-roast/social tension when the relationship is obvious and the first line lands fast.",
  },
  {
    key: "ai-repost-cluster",
    status: "negative source-readiness evidence",
    evidence: "TikTok search surfaced StreamerPlug (.streamerclipss) at 877.1k followers/5.2M likes and STREAMER.CLIPS at 143.2k followers/18.1M likes, but with heavy repost/watermark risk; YouTube broad search surfaced many low-view duplicate clip/fail channels.",
    titleFormula: "Generic #twitch #clips #fyp repost titles",
    openingStyle: "generic vertical repost with no added context or traceable original source",
    captionStyle: "template captions/hashtags; weak editorial signal",
    pipelineUse: "Use as demand validation only; penalize source-readiness until original stream source and rights path are traceable.",
  },
];

const SCORING_WEIGHT_RECOMMENDATIONS = {
  broadAppealNamedPerson: "+10% when a viewer can understand the relationship/conflict without game knowledge",
  firstTwoSecondPayoffPromise: "+15% when frame 0 clearly promises a win/loss/reveal/countdown",
  facecamEmotion: "+8% for visible shock/laughter/rage in first 2s",
  visualObjectPayoff: "+8% when the clip includes an instantly legible object/meme/game under the reaction facecam",
  coldViewerCaptionClarity: "+6% when the first caption/title explains an inside joke for non-fans",
  gameplayOnlyContextPenalty: "-10% when the hook requires game mechanics knowledge",
  repostClusterPenalty: "-20% source-readiness when TikTok/YouTube/Reddit show the same clip as reposted/credited-to-third-party",
};

interface VideoIntel {
  videoId: string;
  title: string;
  views: number;
  likeCount: number;
  duration: number;
  publishedAt: string;
  channel: string;
  url: string;
}

interface PatternReport {
  generatedAt: string;
  channelsScanned: string[];
  totalVideos: number;
  titlePatterns: { pattern: string; count: number; avgViews: number; examples: string[] }[];
  archetypeTrends: { archetype: string; mentions: number; avgViews: number }[];
  patternArchetypes: typeof COMPETITIVE_PATTERN_ARCHETYPES;
  durationTrends: { range: string; count: number; avgViews: number }[];
  topHooks: { hook: string; views: number; channel: string; duration: number; url: string }[];
  scoringWeightRecommendations: typeof SCORING_WEIGHT_RECOMMENDATIONS;
  recommendations: string[];
}

function parseArgs(): { channels: string[]; outputPath: string; topN: number; sinceDays: number } {
  const args = process.argv.slice(2);
  const channels: string[] = [];
  let outputPath = join(DATA_DIR, "clips", "competitive-intel-report.md");
  let topN = 20;
  let sinceDays = 14;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channels" && args[i + 1]) {
      channels.push(...args[++i].split(",").map((c) => c.trim()));
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (args[i] === "--top" && args[i + 1]) {
      topN = parseInt(args[++i], 10);
    } else if (args[i] === "--since" && args[i + 1]) {
      sinceDays = parseInt(args[++i], 10);
    }
  }

  return { channels: channels.length ? channels : DEFAULT_CHANNELS, outputPath, topN, sinceDays };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function channelShortsUrl(channel: string): string {
  if (channel.startsWith("http")) return channel;
  if (channel.startsWith("@")) return `https://www.youtube.com/${channel}/shorts`;
  if (channel.startsWith("UC")) return `https://www.youtube.com/channel/${channel}/shorts`;
  return `https://www.youtube.com/${channel}/shorts`;
}

function ytDlpCommand(): string {
  if (process.env.YT_DLP_BIN) return shellQuote(process.env.YT_DLP_BIN);

  // WSL/Hermes fallback used by scheduled scanner jobs when python -m yt_dlp is unavailable.
  const hermesStandalone = "/home/justi/.hermes/workspace/tmp/bin/yt-dlp";
  if (existsSync(hermesStandalone)) return shellQuote(hermesStandalone);

  return "python -m yt_dlp";
}

/** Fetch recent Shorts from a channel using yt-dlp. */
function fetchChannelShorts(channelHandle: string, sinceDays: number, maxResults: number = 20): VideoIntel[] {
  const cutoffDate = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const shortsUrl = channelShortsUrl(channelHandle);

  try {
    const cmd = `${ytDlpCommand()} --dump-json --playlist-end ${maxResults} --dateafter ${cutoffDate} --match-filter "duration <= 75" ${shellQuote(shortsUrl)}`;
    const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe", timeout: 120000, maxBuffer: 50 * 1024 * 1024 });

    const videos: VideoIntel[] = [];
    const lines = output.trim().split("\n").filter((l) => l.startsWith("{"));

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.duration && data.duration > 75) continue; // Skip non-Shorts/long compilations
        videos.push({
          videoId: data.id,
          title: data.title || "",
          views: parseInt(data.view_count || "0"),
          likeCount: parseInt(data.like_count || "0"),
          duration: parseInt(data.duration || "0"),
          publishedAt: data.upload_date || "",
          channel: data.channel || channelHandle,
          url: data.webpage_url || `https://www.youtube.com/watch?v=${data.id}`,
        });
      } catch {
        // skip malformed lines
      }
    }

    return videos;
  } catch (e) {
    log.warn(`Failed to fetch ${channelHandle}: ${(e as Error).message}`);
    return [];
  }
}

/** Extract title patterns using regex matching. */
function extractPatterns(titles: string[]): { pattern: string; count: number; examples: string[] }[] {
  const patterns: Map<string, { count: number; examples: string[] }> = new Map();

  const patternRules = [
    { name: "Celebrity/name-led hook", regex: /(kai|xqc|speed|jynxzi|caseoh|ninja|lebron|selena|kevin hart|snoop|fanum|ray|tota)/i },
    { name: "Outcome disbelief", regex: /(no way|bro |can't believe|lost that|saved|insane|amazing|clutch|best)/i },
    { name: "Ranked/list packaging", regex: /(top \d+|ranking|types of|best of|\d+[:.\s])/i },
    { name: "Conflict/drama/event", regex: /(gets|spat|punched|fight|drama|allegations|crashed out|breaks down|concerned)/i },
    { name: "Question hook", regex: /\?$/ },
    { name: "POV format", regex: /^POV[:\s]/i },
    { name: "When...", regex: /^when\s/i },
    { name: "Nobody expected / wait-for-it", regex: /(nobody|no one|everyone|wait|hold up|wait for it)/i },
    { name: "How/Why", regex: /^(how|why)\s/i },
    { name: "Source/hashtag stack", regex: /#(shorts|twitch|streamer|clips|gaming|fortnite|kaicenat|xqc)/i },
    { name: "Emoji hook", regex: /[🔥💀😂🤯⚠️😭😱👀]/ },
    { name: "ALL CAPS word", regex: /\b[A-Z]{3,}\b/ },
    { name: "Quotation marks", regex: /[""']/ },
    { name: "First person", regex: /^(i |my |me )/i },
    { name: "Second person", regex: /^(you |your )/i },
    { name: "Curiosity gap", regex: /(but|until|then|finally|realize)/i },
  ];

  for (const title of titles) {
    for (const rule of patternRules) {
      if (rule.regex.test(title)) {
        const existing = patterns.get(rule.name);
        if (existing) {
          existing.count++;
          if (existing.examples.length < 3) existing.examples.push(title);
        } else {
          patterns.set(rule.name, { count: 1, examples: [title] });
        }
      }
    }
  }

  return Array.from(patterns.entries())
    .map(([pattern, data]) => ({ pattern, count: data.count, examples: data.examples }))
    .sort((a, b) => b.count - a.count);
}

/** Infer archetype from title text. */
function inferArchetypeFromTitle(title: string): string {
  const lower = title.toLowerCase();
  if (/(jabbawockeez|ice spice|mr\.? beast|nle|kai|fanum|ray|speed|celebrity|guest|dance battle|popcorns)/.test(lower)) return "celebrity-collab-payoff";
  if (/(no mercy|didn't hold back|no way|lost that|can't believe|clutch|insane|amazing|close call|edge of his seat)/.test(lower)) return "no-mercy-suspense";
  if (/(top \d+|ranking|types of|best of)/.test(lower)) return "ranked-reaction-list";
  if (/(skipped|can't escape|darth maul|who is bro|valid question|running joke)/.test(lower)) return "inside-joke-meme-caption";
  if (/(ludwig|rae|ex|desperate|loves them|relationship|girlfriend|wife)/.test(lower)) return "social-awkwardness-roast";
  if (/(spat|punched|fight|drama|allegations|crashed out|breaks down|concerned)/.test(lower)) return "irl-streamer-conflict";
  if (/rage|tilt|mad|angry|scream|quit|mald|goblin/.test(lower)) return "crashout";
  if (/roast|dunk|burn|savage|destroyed|dumb/.test(lower)) return "social-awkwardness-roast";
  if (/skill|clutch|ace|clip|nasty|cracked/.test(lower)) return "skill";
  if (/wholesome|heart|wholesum|feel|wholesome/.test(lower)) return "wholesome";
  if (/funny|lmao|lol|joke|hilarious/.test(lower)) return "humor";
  if (/story|when|back|then|remember/.test(lower)) return "story-payoff";
  if (/reaction|reacts|response/.test(lower)) return "reaction";
  return "general";
}

/** Group videos by actual duration ranges from yt-dlp metadata. */
function durationBuckets(videos: VideoIntel[]): { range: string; count: number; avgViews: number }[] {
  const ranges = [
    { min: 0, max: 15, label: "0-15s" },
    { min: 15, max: 30, label: "15-30s" },
    { min: 30, max: 45, label: "30-45s" },
    { min: 45, max: 60, label: "45-60s" },
    { min: 60, max: 76, label: "60-75s" },
  ];

  return ranges.map((r) => {
    const bucketVideos = videos.filter((v) => v.duration >= r.min && v.duration < r.max);
    return {
      range: r.label,
      count: bucketVideos.length,
      avgViews: bucketVideos.length
        ? Math.round(bucketVideos.reduce((s, v) => s + v.views, 0) / bucketVideos.length)
        : 0,
    };
  });
}

function generateReport(videos: VideoIntel[], channels: string[]): PatternReport {
  const patterns = extractPatterns(videos.map((v) => v.title));

  // Calculate pattern view averages
  const patternsWithViews = patterns.map((p) => {
    const matchingVideos = videos.filter((v) =>
      p.examples.some((ex) => ex.toLowerCase() === v.title.toLowerCase()),
    );
    const avgViews = matchingVideos.length > 0
      ? Math.round(matchingVideos.reduce((s, v) => s + v.views, 0) / matchingVideos.length)
      : 0;
    return { ...p, avgViews };
  });

  // Archetype trends
  const archetypeMap: Map<string, { mentions: number; totalViews: number }> = new Map();
  for (const v of videos) {
    const archetype = inferArchetypeFromTitle(v.title);
    const existing = archetypeMap.get(archetype);
    if (existing) {
      existing.mentions++;
      existing.totalViews += v.views;
    } else {
      archetypeMap.set(archetype, { mentions: 1, totalViews: v.views });
    }
  }
  const archetypeTrends = Array.from(archetypeMap.entries())
    .map(([archetype, data]) => ({
      archetype,
      mentions: data.mentions,
      avgViews: Math.round(data.totalViews / data.mentions),
    }))
    .sort((a, b) => b.avgViews - a.avgViews);

  // Top hooks (highest view videos)
  const topHooks = videos
    .sort((a, b) => b.views - a.views)
    .slice(0, 10)
    .map((v) => ({ hook: v.title, views: v.views, channel: v.channel, duration: v.duration, url: v.url }));

  // Generate recommendations
  const recommendations: string[] = [];

  const topPattern = patternsWithViews[0];
  if (topPattern && topPattern.count >= 3) {
    recommendations.push(`Pattern "${topPattern.pattern}" appears ${topPattern.count} times — consider testing this hook style`);
  }

  const topArchetype = archetypeTrends[0];
  if (topArchetype && topArchetype.avgViews > 50000) {
    recommendations.push(`"${topArchetype.archetype}" clips averaging ${topArchetype.avgViews.toLocaleString()} views — boost weight in pipeline`);
  }

  if (topHooks.length > 0 && topHooks[0].views > 100000) {
    recommendations.push(`Top performer: "${topHooks[0].hook.slice(0, 50)}..." (${topHooks[0].views.toLocaleString()} views) — study this title formula`);
  }

  recommendations.push("Update title pattern library weekly to stay current with trending formats");

  return {
    generatedAt: new Date().toISOString(),
    channelsScanned: channels,
    totalVideos: videos.length,
    titlePatterns: patternsWithViews,
    archetypeTrends,
    patternArchetypes: COMPETITIVE_PATTERN_ARCHETYPES,
    durationTrends: durationBuckets(videos),
    topHooks,
    scoringWeightRecommendations: SCORING_WEIGHT_RECOMMENDATIONS,
    recommendations,
  };
}

function buildMarkdownReport(report: PatternReport): string {
  const lines: string[] = [];
  lines.push("# Competitive Intelligence Report");
  lines.push("");
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Channels:** ${report.channelsScanned.join(", ")}`);
  lines.push(`**Videos analyzed:** ${report.totalVideos}`);
  lines.push("");

  lines.push("## Title Patterns");
  lines.push("");
  lines.push("| Pattern | Count | Avg Views | Examples |");
  lines.push("|---------|-------|-----------|----------|");
  for (const p of report.titlePatterns.slice(0, 10)) {
    const examples = p.examples.slice(0, 2).join("; ").slice(0, 60);
    lines.push(`| ${p.pattern} | ${p.count} | ${p.avgViews.toLocaleString()} | ${examples} |`);
  }
  lines.push("");

  lines.push("## Archetype Trends");
  lines.push("");
  lines.push("| Archetype | Mentions | Avg Views |");
  lines.push("|-----------|----------|-----------|");
  for (const a of report.archetypeTrends) {
    lines.push(`| ${a.archetype} | ${a.mentions} | ${a.avgViews.toLocaleString()} |`);
  }
  lines.push("");

  lines.push("## Pattern Archetypes to Test");
  lines.push("");
  for (const a of report.patternArchetypes) {
    lines.push(`### ${a.key} — ${a.status}`);
    lines.push(`- Evidence: ${a.evidence}`);
    lines.push(`- Title formula: ${a.titleFormula}`);
    lines.push(`- Opening style: ${a.openingStyle}`);
    lines.push(`- Caption style: ${a.captionStyle}`);
    lines.push(`- Pipeline use: ${a.pipelineUse}`);
    lines.push("");
  }

  lines.push("## Duration Trends");
  lines.push("");
  lines.push("| Duration | Count | Avg Views |");
  lines.push("|----------|-------|-----------|");
  for (const d of report.durationTrends) {
    lines.push(`| ${d.range} | ${d.count} | ${d.avgViews.toLocaleString()} |`);
  }
  lines.push("");

  lines.push("## Scoring Weight Recommendations");
  lines.push("");
  for (const [key, value] of Object.entries(report.scoringWeightRecommendations)) {
    lines.push(`- **${key}:** ${value}`);
  }
  lines.push("");

  lines.push("## Top Performing Hooks");
  lines.push("");
  for (let i = 0; i < report.topHooks.length; i++) {
    const h = report.topHooks[i];
    lines.push(`${i + 1}. **${h.channel}** — ${h.hook} (${h.views.toLocaleString()} views, ${h.duration}s) — ${h.url}`);
  }
  lines.push("");

  lines.push("## Recommendations");
  lines.push("");
  for (const r of report.recommendations) {
    lines.push(`- ${r}`);
  }
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();

  log.info("Competitive intelligence scan starting");
  log.info(`Channels: ${args.channels.join(", ")}`);
  log.info(`Window: last ${args.sinceDays} days`);

  const allVideos: VideoIntel[] = [];

  for (const channel of args.channels) {
    log.info(`Scanning ${channel}...`);
    const videos = fetchChannelShorts(channel, args.sinceDays, args.topN);
    log.info(`  Found ${videos.length} Shorts`);
    allVideos.push(...videos);
  }

  if (allVideos.length === 0) {
    log.error("No videos found. Check channel handles and yt_dlp availability.");
    process.exit(1);
  }

  const report = generateReport(allVideos, args.channels);
  const md = buildMarkdownReport(report);

  ensureDir(join(args.outputPath, ".."));
  writeFileSync(args.outputPath, md, "utf-8");
  log.info(`Report written → ${args.outputPath}`);

  // Also write JSON for programmatic consumption
  const jsonPath = args.outputPath.replace(/\.md$/, ".json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  log.info(`JSON data → ${jsonPath}`);

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("COMPETITIVE INTELLIGENCE SUMMARY");
  console.log("=".repeat(60));
  console.log(`Videos analyzed: ${report.totalVideos}`);
  console.log(`Top pattern: ${report.titlePatterns[0]?.pattern ?? "none"} (${report.titlePatterns[0]?.count ?? 0} occurrences)`);
  console.log(`Hot archetype: ${report.archetypeTrends[0]?.archetype ?? "none"} (${report.archetypeTrends[0]?.avgViews ?? 0} avg views)`);
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  log.error(err.message ?? err);
  process.exit(1);
});
