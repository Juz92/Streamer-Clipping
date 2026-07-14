/**
 * generate-metadata.ts — AI-powered upload metadata generator.
 *
 * Reads clip data from notebooklm-moments.json (or unified-moments.json fallback)
 * and calls Claude API to generate platform-optimized titles, descriptions,
 * tags, and captions for each rendered Short — with YouTube Shorts algorithm
 * rules baked in (broad-appeal ordering, no CTA language, one-per-day cadence).
 *
 * Usage:
 *   npx tsx packages/clips/src/generate-metadata.ts --stream <id>
 *   npx tsx packages/clips/src/generate-metadata.ts --stream <id> --clips 1,3,5
 *   npx tsx packages/clips/src/generate-metadata.ts --stream <id> --dry-run
 *   npx tsx packages/clips/src/generate-metadata.ts --stream <id> --force   # overwrite existing
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { createLogger } from "@ltx/shared";
import { generateHookVariants, inferHookPattern } from "./lib/hook-variants.js";
import { loadManifest } from "./lib/manifest.js";

/** Load ANTHROPIC_API_KEY from .env file at project root if not already in env. */
function loadEnvKey(): void {
  if (process.env.ANTHROPIC_API_KEY) return;

  const candidates = [
    join(process.cwd(), ".env"),
    "C:/peanut/.env",
    join(process.env.HOME ?? "", ".env"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^ANTHROPIC_API_KEY\s*=\s*["']?(.+?)["']?\s*$/);
      if (m) {
        process.env.ANTHROPIC_API_KEY = m[1];
        return;
      }
    }
  }
}

const log = createLogger("generate-metadata");

const GLOBAL_YT_TAGS = [
  "The Burnt Peanut",
  "TheBurntPeanut",
  "Burnt Peanut",
  "DailyPeanutClipsHighlights",
  "gaming clips",
  "gaming moments",
  "gaming shorts",
  "funny gaming",
  "twitch clips",
  "youtube gaming",
  "streamer clips",
  "gaming highlights",
  "funny moments",
  "gaming funny moments",
  "shorts",
];

interface ClipSource {
  clipNum: number;
  slug: string;        // from filename
  description: string;
  categories: string[];
  hook: string;
  quote?: string;
  funnyQuote?: boolean;
  humorPotential?: number;
  setupNeeded: boolean;
  viralScore: number;
  durationSec: number;
}

interface GeneratedMeta {
  clipNum: number;
  slug: string;
  ytTitle: string;
  ytTitleVariantB?: string;
  ytTitleVariantC?: string;
  frame0Hook: string;
  ytDescription: string;
  ytTags: string[];
  tiktokCaption: string;
  reelsCaption: string;
  pinnedComment: string;
  postFirst: boolean;
  hookPattern: string;
}

interface ParsedMetadataResponse {
  postingOrder: number[];
  clips: Array<{
    clipNum: number;
    ytTitle: string;
    ytTitleVariantB?: string;
    ytTitleVariantC?: string;
    frame0Hook?: string;
    ytDescription: string;
    ytTags: string[];
    tiktokCaption: string;
    reelsCaption: string;
    pinnedComment?: string;
    postFirst: boolean;
  }>;
}

interface CliArgs {
  streamId: string;
  clips: number[];
  all: boolean;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    streamId: "",
    clips: [],
    all: true,
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) {
      result.streamId = args[++i];
    } else if (args[i] === "--clips" && args[i + 1]) {
      result.clips = args[++i].split(",").map(Number);
      result.all = false;
    } else if (args[i] === "--dry-run") {
      result.dryRun = true;
    } else if (args[i] === "--force") {
      result.force = true;
    }
  }

  return result;
}

/** Derive a URL-friendly slug from a short filename like "01-hutch-lose-some-weight.mp4" */
function slugFromFilename(filename: string): string {
  return basename(filename, ".mp4")
    .replace(/^\d+-/, "")   // strip leading NN-
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Infer game name from stream title */
function inferGame(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("rust")) return "Rust";
  if (lower.includes("halo")) return "Halo";
  if (lower.includes("apex")) return "Apex Legends";
  if (lower.includes("cs2") || lower.includes("counter-strike")) return "CS2";
  if (lower.includes("warzone")) return "Warzone";
  if (lower.includes("valorant")) return "Valorant";
  if (lower.includes("fortnite")) return "Fortnite";
  return "Gaming";
}

/** Load clips from notebooklm-moments.json or unified-moments.json */
function loadClipSources(jobDir: string, shortsDir: string, filter: number[]): ClipSource[] {
  // Find rendered shorts to determine clip numbers
  const shortFiles = readdirSync(shortsDir)
    .filter((f) => f.endsWith(".mp4") && /^\d+/.test(f))
    .sort();

  // Try notebooklm-moments.json first (matches rendered order)
  const nlmPath = join(jobDir, "notebooklm-moments.json");
  const unifiedPath = join(jobDir, "unified-moments.json");
  const momentsPath = join(jobDir, "moments.json");

  let moments: Array<{
    id?: string;
    rank?: number;
    description: string;
    categories: string[];
    hook?: string;
    quote?: string;
    hookText?: string;
    setupNeeded: boolean;
    viralScore?: number;
    viralityScore?: number;
    durationSec: number;
    funnyQuote?: boolean;
    humorPotential?: number;
  }> = [];

  if (existsSync(nlmPath)) {
    moments = JSON.parse(readFileSync(nlmPath, "utf-8"));
    if (moments.length > 0) log.info(`Loaded ${moments.length} picks from notebooklm-moments.json`);
  }
  if (moments.length === 0 && existsSync(unifiedPath)) {
    moments = JSON.parse(readFileSync(unifiedPath, "utf-8"));
    if (moments.length > 0) log.info(`Loaded ${moments.length} picks from unified-moments.json`);
  }
  if (moments.length === 0 && existsSync(momentsPath)) {
    moments = JSON.parse(readFileSync(momentsPath, "utf-8"));
    log.info(`Loaded ${moments.length} picks from moments.json (scorer-only)`);
  }
  if (moments.length === 0) {
    log.error("No moments file found (notebooklm-moments.json, unified-moments.json, or moments.json)");
    process.exit(1);
  }

  const sources: ClipSource[] = [];

  for (let i = 0; i < shortFiles.length; i++) {
    const filename = shortFiles[i];
    const clipNum = i + 1;

    if (filter.length > 0 && !filter.includes(clipNum)) continue;

    const moment = moments[i];
    if (!moment) {
      log.warn(`No moment data for clip ${clipNum} (${filename}) — skipping`);
      continue;
    }

    sources.push({
      clipNum,
      slug: slugFromFilename(filename),
      description: moment.description,
      categories: moment.categories ?? [],
      hook: moment.hook ?? moment.hookText ?? moment.description,
      quote: moment.quote,
      funnyQuote: moment.funnyQuote ?? false,
      humorPotential: moment.humorPotential ?? 0,
      setupNeeded: moment.setupNeeded ?? false,
      viralScore: moment.viralScore ?? moment.viralityScore ?? 50,
      durationSec: moment.durationSec,
    });
  }

  return sources;
}

function buildClaudePrompt(
  clips: ClipSource[],
  streamTitle: string,
  game: string,
  streamDate: string,
): string {
  const clipList = clips
    .map(
      (c) => `
CLIP ${c.clipNum} (${c.durationSec}s) — Viral Score: ${c.viralScore}
  Description: ${c.description}
  Hook line: ${c.hook}
  ${c.quote ? `Best quote: "${c.quote}"` : ""}
  Funny quote: ${c.funnyQuote ? "Yes — use direct quote title if possible" : "No/unknown"}
  Humor potential: ${Math.round((c.humorPotential ?? 0) * 100)}/100
  Categories: ${c.categories.join(", ")}
  Setup needed: ${c.setupNeeded ? "Yes" : "No (standalone)"}
  Broad appeal (non-gamer gets it): ${c.categories.includes("broad-appeal") || !["running-bit", "callback", "game-specific"].some((t) => c.categories.includes(t)) ? "Likely yes" : "Needs context"}`.trim(),
    )
    .join("\n\n");

  return `You are a YouTube Shorts metadata specialist for a gaming channel.

CHANNEL:
- Streamer: The Burnt Peanut (@TheBurntPeanut) — gaming creator with friend group (Hutch, Cloakzy, Nickmercs, Drac, Taxi, Moist, Summit1g)
- Clips channel: @DailyPeanutClipsHighlights
- Stream: "${streamTitle}"
- Game: ${game}
- Date: ${streamDate}
- Comedy style: friend-group roasts, absurd one-liners, crude humor, competitive meltdowns

YOUTUBE SHORTS ALGORITHM RULES (non-negotiable):
1. Titles: under 70 chars. Humor-first: prefer direct funny quotes, then "WTF just happened" shock hooks, then payoff-first titles. 1-2 words in CAPS max.
   - BAD: "Peanut plays Rust and gets mad"
   - BAD: "Odd conversation at the gambling table"
   - GOOD: "he blamed him for the plane not reaching ALTITUDE 💀"
   - GOOD: "WTF just happened to Peanut's voice?"
2. NO "subscribe", "like", "smash the bell" language anywhere. Trust Score killer.
3. Channel links in descriptions are fine and encouraged.
4. Broad-appeal clips: mark postFirst=true. Non-gamers understanding = viral faster on new channels.
5. One clip per day from each batch — do NOT say this in the content though.
6. Tags: 33-37 total. Global channel tags + game tags + clip-specific tags.

DESCRIPTION FORMAT (each clip, 2-4 lines total including links):
Line 1-2: 1-2 punchy sentences capturing the moment. Lead with the punchline energy.
Blank line
"Watch The Burnt Peanut live: https://www.youtube.com/@TheBurntPeanut"
"Clips: https://www.youtube.com/@DailyPeanutClipsHighlights"
Blank line
3-5 hashtags: always include #shorts #gaming #${game.toLowerCase().replace(/\s+/g, "")} + clip-specific

TIKTOK CAPTION: conversational, 1-2 sentences + 3-5 inline hashtags + 1-2 emoji. Under 150 chars.

REELS CAPTION: shortest and punchiest. 1 sentence + hashtags at end. Under 100 chars.

GAME-SPECIFIC TAGS to include (pick relevant ones):
${game === "Rust" ? "rust, rust gameplay, rust pvp, rust base building, rust funny moments, rust raid, rust 2024, rust server" : `${game.toLowerCase()}, ${game.toLowerCase()} gameplay, ${game.toLowerCase()} funny moments`}

CLIPS TO GENERATE METADATA FOR:
${clipList}

Return a JSON object with this exact structure:
{
  "postingOrder": [array of clipNums in recommended posting order — broad-appeal first, then crash-outs/friend-roasts, game-specific last],
  "clips": [
    {
      "clipNum": 1,
      "ytTitle": "curiosity hook title under 70 chars with CAPS emphasis",
      "ytTitleVariantB": "direct funny quote title under 70 chars, if genuinely funny",
      "ytTitleVariantC": "WTF/shock/payoff hook title under 70 chars",
      "frame0Hook": "2-6 word thumbnail hook for the first frame. Use slash to split lines, e.g. LOVE ISLAND / BUT NORMAL",
      "ytDescription": "full description with links and hashtags",
      "ytTags": ["tag1", "tag2", ...],
      "tiktokCaption": "caption with #hashtags and emoji",
      "reelsCaption": "punchy caption #hashtags",
      "pinnedComment": "short pinned comment that invites replies without saying like/subscribe",
      "postFirst": true or false
    }
  ]
}

IMPORTANT: Return ONLY valid JSON. No markdown fences. No extra text before or after.`;
}

function buildUploadMetadataMd(
  clips: GeneratedMeta[],
  postingOrder: number[],
  streamTitle: string,
  streamDate: string,
  game: string,
): string {
  const lines: string[] = [];

  lines.push(`# Upload Metadata — ${streamTitle}`);
  lines.push(`Generated: ${new Date().toISOString()} | Game: ${game}`);
  lines.push("");
  lines.push("## Posting Schedule");
  lines.push("");
  lines.push("One clip per day. Post in this order — broad-appeal clips first:");
  lines.push("");

  for (let i = 0; i < postingOrder.length; i++) {
    const num = postingOrder[i];
    const clip = clips.find((c) => c.clipNum === num);
    if (!clip) continue;
    const postFirstNote = clip.postFirst ? " *(broad appeal — post early)*" : "";
    lines.push(`${i + 1}. Clip ${String(num).padStart(2, "0")} — ${clip.ytTitle}${postFirstNote}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  // Clip sections (in postingOrder for easy sequential copy-paste)
  const orderedClips = postingOrder
    .map((n) => clips.find((c) => c.clipNum === n))
    .filter(Boolean) as GeneratedMeta[];

  // Also include any clips not in the posting order (fallback)
  const remainingClips = clips.filter((c) => !postingOrder.includes(c.clipNum));
  const allOrdered = [...orderedClips, ...remainingClips];

  for (const clip of allOrdered) {
    const numPadded = String(clip.clipNum).padStart(2, "0");
    const postNote = clip.postFirst ? " -- POST FIRST" : "";
    lines.push(`## ${numPadded} -- ${clip.ytTitle}${postNote} (Score: ${clip.clipNum})`);
    lines.push("");
    lines.push(`**YouTube Shorts Title:** ${clip.ytTitle}`);
    if (clip.ytTitleVariantB) {
      lines.push(`**Title Variant B:** ${clip.ytTitleVariantB}`);
    }
    if (clip.ytTitleVariantC) {
      lines.push(`**Title Variant C:** ${clip.ytTitleVariantC}`);
    }
    lines.push(`**Hook Pattern:** ${clip.hookPattern}`);
    lines.push(`**Frame0 Hook:** ${clip.frame0Hook}`);
    lines.push("");
    lines.push("**YouTube Description:**");
    lines.push(clip.ytDescription);
    lines.push("");
    lines.push(`**TikTok Caption:** ${clip.tiktokCaption}`);
    lines.push("");
    lines.push(`**Reels Caption:** ${clip.reelsCaption}`);
    lines.push("");
    lines.push(`**Pinned Comment:** ${clip.pinnedComment}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // YouTube Tags section
  lines.push("## YouTube Tags");
  lines.push("");

  for (const clip of allOrdered) {
    const numPadded = String(clip.clipNum).padStart(2, "0");
    lines.push(`### ${numPadded} -- ${clip.ytTitle}`);
    lines.push("```");
    lines.push(clip.ytTags.join(", "));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function inferArchetypeFromCategories(categories: string[]): string {
  if (categories.includes("friend-roast") || categories.includes("roast")) return "roast";
  if (categories.includes("crash-out") || categories.includes("meltdown")) return "crashout";
  if (categories.includes("skill") || categories.includes("clutch") || categories.includes("gameplay")) return "skill";
  if (categories.includes("one-liner") || categories.includes("quotable")) return "one-liner";
  if (categories.includes("story-of-stream") || categories.includes("callback") || categories.includes("running-bit")) return "story-payoff";
  return "general";
}

function cleanPublicText(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clipTitle(text: string, max = 68): string {
  const cleaned = cleanPublicText(text)
    .replace(/^(repetition loop|sustainedenergy arc)[:\s-]*/i, "")
    .replace(/\bsaid\s+(\d+)\s+times\b/i, "said $1 times")
    .replace(/\s+plus\s+.*$/i, "")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).replace(/\s+\S*$/, "").trim()}…`;
}

function frameHookFromTitle(title: string): string {
  const stop = new Set(["THE", "A", "AN", "AND", "OR", "TO", "FOR", "WITH", "THIS", "THAT", "HIS", "HER", "HIM"]);
  const words = cleanPublicText(title)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stop.has(w));
  const first = words.slice(0, 3).join(" ") || "PEANUT";
  const second = words.slice(3, 6).join(" ") || "CHAOS";
  return `${first} / ${second}`;
}

function buildFallbackMetadata(clips: ClipSource[], game: string): ParsedMetadataResponse {
  const fallbackTags = [
    "funny gaming clips",
    "streamer funny moments",
    "streamer rage",
    "gaming rage",
    "friend group gaming",
    "gaming banter",
    "gaming comedy",
    "live stream moments",
    "viral gaming shorts",
    "funny shorts",
    "gamer moments",
    "stream highlights",
    "daily gaming clips",
    "peanut clips",
    "burnt peanut clips",
    "multiplayer funny moments",
    "gaming fails",
    "gaming chaos",
    "holdfast funny moments",
    "random games funny moments",
    "australian gaming",
    "youtube shorts gaming",
  ];

  const ordered = [...clips].sort((a, b) => {
    const broadA = a.categories.includes("broad-appeal") ? 1 : 0;
    const broadB = b.categories.includes("broad-appeal") ? 1 : 0;
    if (broadA !== broadB) return broadB - broadA;
    return b.viralScore - a.viralScore;
  });

  return {
    postingOrder: ordered.map((c) => c.clipNum),
    clips: clips.map((c) => {
      const rawTitle = c.quote && c.quote.length <= 70 ? c.quote : c.hook || c.description;
      const title = clipTitle(rawTitle || c.slug.replace(/-/g, " "));
      const variantB = clipTitle(c.description || title);
      const variantC = clipTitle(`${title} got out of hand`);
      const frame0Hook = frameHookFromTitle(title);
      const hashtags = `#shorts #gaming #${game.toLowerCase().replace(/\s+/g, "")} #funnygaming`;
      const description = `${title}.\n\nWatch The Burnt Peanut live: https://www.youtube.com/@TheBurntPeanut\nClips: https://www.youtube.com/@DailyPeanutClipsHighlights\n\n${hashtags}`;
      return {
        clipNum: c.clipNum,
        ytTitle: title,
        ytTitleVariantB: variantB,
        ytTitleVariantC: variantC,
        frame0Hook,
        ytDescription: description,
        ytTags: [...fallbackTags, ...c.categories.slice(0, 8)],
        tiktokCaption: `${clipTitle(title, 95)} ${hashtags}`,
        reelsCaption: `${clipTitle(title, 70)} #shorts #gaming`,
        pinnedComment: "Which mate got cooked the worst here?",
        postFirst: c.categories.includes("broad-appeal") || c.viralScore >= 80,
      };
    }),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.streamId) {
    log.error(
      "Usage: npx tsx packages/clips/src/generate-metadata.ts --stream <id> [--clips 1,3] [--dry-run] [--force]",
    );
    process.exit(1);
  }

  const manifest = loadManifest(args.streamId);
  const jobDir = manifest.jobDir;
  const shortsDir = join(jobDir, "shorts");
  const outPath = join(jobDir, "upload-metadata.md");
  const outJsonPath = join(jobDir, "upload-metadata.json");

  if (!existsSync(shortsDir)) {
    log.error(`No shorts/ directory at ${shortsDir}. Run render-fast first.`);
    process.exit(1);
  }

  if (existsSync(outPath) && !args.force) {
    log.warn(
      `upload-metadata.md already exists at ${outPath}. Use --force to regenerate.`,
    );
    process.exit(0);
  }

  const game = inferGame(manifest.title);
  const streamDate = manifest.uploadDate ?? manifest.createdAt?.split("T")[0] ?? "unknown";

  log.info(`Stream: ${manifest.title}`);
  log.info(`Game: ${game} | Date: ${streamDate}`);

  const clips = loadClipSources(jobDir, shortsDir, args.all ? [] : args.clips);

  if (clips.length === 0) {
    log.error("No clips found to generate metadata for.");
    process.exit(1);
  }

  log.info(`Generating metadata for ${clips.length} clips via Claude API...`);

  if (args.dryRun) {
    log.info("[DRY RUN] Would call Claude API with the following clips:");
    for (const c of clips) {
      log.info(`  Clip ${c.clipNum}: ${c.description} [${c.categories.join(", ")}]`);
    }
    log.info(`[DRY RUN] Would write → ${outPath}`);
    log.info(`[DRY RUN] Would write → ${outJsonPath}`);
    return;
  }

  loadEnvKey();

  let parsed: ParsedMetadataResponse;

  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn("ANTHROPIC_API_KEY is not set — writing deterministic fallback metadata from scored moments.");
    parsed = buildFallbackMetadata(clips, game);
  } else {
    const client = new Anthropic();
    const prompt = buildClaudePrompt(clips, manifest.title, game, streamDate);

    log.info("Calling Claude API (claude-haiku-4-5)...");

    let rawResponse: string;
    try {
      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      rawResponse =
        message.content[0].type === "text" ? message.content[0].text : "";
    } catch (err: any) {
      log.warn(`Claude API call failed (${err.message}); writing deterministic fallback metadata.`);
      parsed = buildFallbackMetadata(clips, game);
      rawResponse = "";
    }

    if (!parsed!) {
      try {
        // Strip any accidental markdown fences
        const cleaned = rawResponse
          .replace(/^```(?:json)?\n?/m, "")
          .replace(/\n?```$/m, "")
          .trim();
        parsed = JSON.parse(cleaned);
      } catch (err: any) {
        log.warn(`Failed to parse Claude JSON response (${err.message}); writing deterministic fallback metadata.`);
        log.warn("Raw response preview:");
        log.warn(rawResponse.slice(0, 500));
        parsed = buildFallbackMetadata(clips, game);
      }
    }
  }

  // Merge generated data with source data
  const generatedClips: GeneratedMeta[] = parsed.clips.map((g) => {
    const source = clips.find((c) => c.clipNum === g.clipNum);
    const slug = source?.slug ?? `clip-${g.clipNum}`;

    // Merge global tags + game tags + generated tags, dedup
    const allTags = [
      ...GLOBAL_YT_TAGS,
      ...(game !== "Gaming"
        ? [
            game,
            game.toLowerCase(),
            `${game.toLowerCase()} funny moments`,
            `${game.toLowerCase()} gameplay`,
            `${game.toLowerCase()} highlights`,
          ]
        : []),
      ...g.ytTags,
    ];
    const deduped = Array.from(new Set(allTags.map((t) => t.trim()).filter(Boolean)));

    // Generate archetype-aware title variants as fallback/enrichment
    const archetype = inferArchetypeFromCategories(source?.categories ?? []);
    const variants = generateHookVariants(
      g.ytTitle,
      source?.quote,
      archetype,
    );

    const hookPattern = inferHookPattern(g.ytTitle);
    const frame0Hook = (g.frame0Hook || variants.titleC || variants.titleA || g.ytTitle)
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/#\w+/g, "")
      .replace(/\s+/g, " ")
      .trim();

    return {
      clipNum: g.clipNum,
      slug,
      ytTitle: g.ytTitle || variants.titleA,
      ytTitleVariantB: g.ytTitleVariantB || variants.titleB,
      ytTitleVariantC: g.ytTitleVariantC || variants.titleC,
      frame0Hook,
      ytDescription: g.ytDescription,
      ytTags: deduped,
      tiktokCaption: g.tiktokCaption,
      reelsCaption: g.reelsCaption,
      pinnedComment: g.pinnedComment || "Which mate is getting cooked next?",
      postFirst: g.postFirst ?? false,
      hookPattern,
    };
  });

  // Validate posting order — fill in any missing clip numbers
  const allNums = generatedClips.map((c) => c.clipNum);
  const postingOrder = [
    ...parsed.postingOrder.filter((n) => allNums.includes(n)),
    ...allNums.filter((n) => !parsed.postingOrder.includes(n)),
  ];

  const md = buildUploadMetadataMd(
    generatedClips,
    postingOrder,
    manifest.title,
    streamDate,
    game,
  );

  writeFileSync(outPath, md, "utf-8");
  writeFileSync(outJsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    streamId: args.streamId,
    streamTitle: manifest.title,
    game,
    streamDate,
    postingOrder,
    items: generatedClips.map((clip) => ({
      rank: clip.clipNum,
      clipNum: clip.clipNum,
      slug: clip.slug,
      ytTitle: clip.ytTitle,
      ytTitleVariantB: clip.ytTitleVariantB,
      ytTitleVariantC: clip.ytTitleVariantC,
      frame0Hook: clip.frame0Hook,
      ytDescription: clip.ytDescription,
      ytTags: clip.ytTags,
      tiktokCaption: clip.tiktokCaption,
      reelsCaption: clip.reelsCaption,
      pinnedComment: clip.pinnedComment,
      postFirst: clip.postFirst,
      hookPattern: clip.hookPattern,
    })),
  }, null, 2), "utf-8");
  log.info(`\nupload-metadata.md written to ${outPath}`);
  log.info(`upload-metadata.json written to ${outJsonPath}`);
  log.info(`  ${generatedClips.length} clips`);
  log.info(
    `  Posting order: ${postingOrder.map((n) => String(n).padStart(2, "0")).join(" → ")}`,
  );

  const postFirst = generatedClips.filter((c) => c.postFirst);
  if (postFirst.length > 0) {
    log.info(
      `  Broad-appeal clips (post first): ${postFirst.map((c) => String(c.clipNum).padStart(2, "0")).join(", ")}`,
    );
  }
}

main().catch((err) => {
  log.error("generate-metadata failed:", err.message ?? err);
  process.exit(1);
});
