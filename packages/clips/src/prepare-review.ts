/**
 * prepare-review.ts - Build the local private review folder.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { chooseReviewPacketClips } from "./quality-gates.js";
import { CONTENT_LANES } from "./lib/content-lanes.js";
export { chooseReviewPacketClips } from "./quality-gates.js";

interface CliArgs {
  streamId: string;
  force: boolean;
}

interface PickQuality {
  rank: number;
  status?: "suggested" | "candidate" | "reserve";
  arcCompleteness?: number;
  contextNeeded?: boolean;
  reasonSuggested?: string;
}

interface TrimEntry {
  rank: number;
  candidateId: string;
  momentId: string;
  clipFile: string;
  totalDuration?: number;
  notes?: string;
}

export interface ReviewClip {
  rank: number;
  candidateId: string;
  momentId: string;
  file: string;
  title: string;
  thumb: string | null;
  quality?: PickQuality;
  trim?: TrimEntry;
}

const log = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let streamId = "";
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) streamId = args[++i];
    else if (args[i] === "--force") force = true;
  }

  if (!streamId) {
    log.error("Usage: prepare-review.ts --stream <id> [--force]");
    process.exit(1);
  }

  return { streamId, force };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function parseMetadataTitles(markdown: string): Map<number, string> {
  const titles = new Map<number, string>();
  const sections = markdown.split(/^## (\d+) -- /m);

  for (let i = 1; i < sections.length; i += 2) {
    const rank = parseInt(sections[i], 10);
    const body = sections[i + 1] ?? "";
    const titleMatch = body.match(/\*\*YouTube Shorts Title:\*\*\s*(.+)/);
    const firstLine = body.split("\n")[0]?.replace(/\s+\(Score:.*$/, "").replace(/\s+-- POST FIRST$/, "").trim();
    titles.set(rank, titleMatch?.[1]?.trim() || firstLine || `Clip ${rank}`);
  }

  return titles;
}

function copyIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  return true;
}

function rankFromFile(file: string): number {
  return parseInt(file.slice(0, 2), 10);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDecisionTemplate(streamId: string, clips: ReviewClip[], suggestedRank: number | null): string {
  for (const clip of clips) {
    const separator = clip.candidateId.indexOf(":");
    if (separator <= 0 || clip.candidateId.slice(separator + 1) !== clip.momentId) {
      throw new Error(`Candidate id ${clip.candidateId} does not match momentId ${clip.momentId}`);
    }
  }
  return JSON.stringify(
    {
      streamId,
      reviewedAt: null,
      chosenRank: suggestedRank,
      acceptedSuggestedPick: null,
      notes: "",
      labelOptions: {
        status: ["keep", "reject", "reserve"],
        lane: CONTENT_LANES.filter((lane) => lane !== "reject"),
        reaction: ["lol", "smiled", "nothing", "context-missing"],
        rejectionReason: ["weak-premise", "no-payoff", "needs-context", "generic-gameplay", "bad-cut", "wrong-lane", "not-funny", "other"],
        arcIntent: ["single-arc", "compilation"],
      },
      decisions: clips.map((clip) => ({
        rank: clip.rank,
        candidateId: clip.candidateId,
        momentId: clip.momentId,
        file: clip.file,
        status: "reserve",
        lane: null,
        reaction: null,
        rejectionReason: null,
        coldOpenAccepted: null,
        correctedBeats: null,
        arcIntent: "single-arc",
        notes: "",
      })),
    },
    null,
    2,
  );
}

function buildReviewPacketMarkdown(streamTitle: string, clips: ReviewClip[], suggestedRank: number | null): string {
  const rows = chooseReviewPacketClips(clips, suggestedRank).map((clip, index) => {
    const quality = clip.quality;
    const why = quality?.reasonSuggested ?? clip.trim?.notes ?? "watch candidate";
    const arc = quality?.arcCompleteness != null ? `${Math.round(quality.arcCompleteness * 100)}%` : "unscored";
    const status = quality?.status ?? "candidate";
    return `${index + 1}. #${String(clip.rank).padStart(2, "0")} — ${clip.title}\n   - file: shorts/${clip.file}\n   - status: ${status}\n   - arc: ${arc}\n   - why: ${why}`;
  });

  return `# Private review packet — ${streamTitle}\n\nNo upload/public action taken. Watch these candidates first; no clip is approved until manual review.\n\n${rows.join("\n\n")}\n`;
}

function buildHermesTask(streamId: string, reviewDir: string, suggestedRank: number | null): string {
  return JSON.stringify(
    {
      streamId,
      status: "waiting_private_review",
      uploadAllowed: false,
      reviewHtml: join(reviewDir, "review.html"),
      decisionTemplate: join(reviewDir, "review-decision.template.json"),
      decisionPath: join(reviewDir, "review-decision.json"),
      suggestedRank,
      commands: {
        ingestDecision: `npx tsx packages/clips/src/ingest-review-decision.ts --stream ${streamId}`,
        resumeReviewPackage: `npx tsx packages/clips/src/orchestrate.ts --stream ${streamId} --from review-package`,
        prepareUploadPackageAfterApproval: `npx tsx packages/clips/src/orchestrate.ts --stream ${streamId} --from upload --prepare-upload-package`,
      },
    },
    null,
    2,
  );
}

function buildReviewHtml(streamTitle: string, clips: ReviewClip[], suggestedRank: number | null): string {
  const displayClips = chooseReviewPacketClips(clips, suggestedRank);
  const rows = displayClips.map((clip) => {
    const quality = clip.quality;
    const isSuggested = clip.rank === suggestedRank || quality?.status === "suggested";
    const badges = [
      isSuggested ? `<span class="badge suggested">Suggested</span>` : "",
      quality?.status === "reserve" ? `<span class="badge reserve">Reserve</span>` : "",
      quality?.contextNeeded ? `<span class="badge context">Needs context</span>` : "",
    ].join("");
    const thumb = clip.thumb ? `<img src="${escapeHtml(clip.thumb)}" alt="">` : "";
    const score = quality?.arcCompleteness != null ? `${Math.round(quality.arcCompleteness * 100)}% arc` : "unscored";
    const duration = clip.trim?.totalDuration != null ? `${clip.trim.totalDuration.toFixed(1)}s` : "";

    return `
      <article class="clip ${isSuggested ? "is-suggested" : ""}">
        <div class="meta">
          <div class="rank">#${String(clip.rank).padStart(2, "0")}</div>
          <h2>${escapeHtml(clip.title)}</h2>
          <div class="badges">${badges}</div>
          <p>${escapeHtml(score)} ${duration ? `• ${escapeHtml(duration)}` : ""}</p>
          <p>${escapeHtml(quality?.reasonSuggested ?? clip.trim?.notes ?? "")}</p>
        </div>
        ${thumb}
        <video controls preload="metadata" src="shorts/${escapeHtml(clip.file)}"></video>
      </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clip Review - ${escapeHtml(streamTitle)}</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #101214; color: #f4f4f4; }
    header { padding: 20px; border-bottom: 1px solid #333; position: sticky; top: 0; background: #101214; z-index: 1; }
    h1 { margin: 0; font-size: 22px; }
    main { display: grid; gap: 18px; padding: 18px; max-width: 1240px; margin: 0 auto; }
    .clip { display: grid; grid-template-columns: minmax(240px, 1fr) 180px 270px; gap: 16px; align-items: start; padding: 16px; border: 1px solid #30343a; background: #181b1f; border-radius: 8px; }
    .clip.is-suggested { border-color: #f6c343; }
    .rank { color: #f6c343; font-weight: 700; }
    h2 { margin: 4px 0 8px; font-size: 18px; }
    p { color: #b9c0ca; line-height: 1.4; margin: 8px 0 0; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge { font-size: 12px; padding: 3px 8px; border-radius: 999px; background: #30343a; }
    .suggested { background: #f6c343; color: #171717; }
    .reserve { background: #5a3440; color: #ffdce5; }
    .context { background: #38455c; color: #d7e5ff; }
    img, video { width: 100%; border-radius: 6px; background: #050607; }
    @media (max-width: 840px) { .clip { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(streamTitle)}</h1>
    <p>${clips.length} clips ready for private review. Suggested: ${suggestedRank ? `#${String(suggestedRank).padStart(2, "0")}` : "none"}</p>
  </header>
  <main>${rows}</main>
</body>
</html>
`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { findStreamDir, loadManifest } = await import("./lib/manifest.js");
  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) {
    log.error(`No stream dir found for ${args.streamId}`);
    process.exit(1);
  }

  const manifest = loadManifest(args.streamId);
  const shortsDir = join(streamDir, "shorts");
  const thumbsDir = join(shortsDir, "thumbnails");
  const reviewDir = join(streamDir, "review");
  const reviewShortsDir = join(reviewDir, "shorts");
  const reviewThumbsDir = join(reviewDir, "thumbnails");
  const warnings: string[] = [];

  if (!existsSync(shortsDir)) {
    throw new Error(`No shorts directory found at ${shortsDir}`);
  }

  ensureDir(reviewShortsDir);
  ensureDir(reviewThumbsDir);

  const qualityReport = readJson<{ suggestedRank?: number | null; picks?: PickQuality[] }>(join(streamDir, "pick-quality.json"), {});
  const qualityByRank = new Map((qualityReport.picks ?? []).map((pick) => [pick.rank, pick]));
  const trimResults = readJson<{ approved?: TrimEntry[] }>(join(streamDir, "trim-results.json"), {});
  const trimByRank = new Map((trimResults.approved ?? []).map((entry) => [entry.rank, entry]));

  const metadataPath = join(streamDir, "upload-metadata.md");
  const metadata = existsSync(metadataPath) ? readFileSync(metadataPath, "utf-8") : "";
  if (!metadata) warnings.push("upload-metadata.md missing");
  const titles = parseMetadataTitles(metadata);

  const shortFiles = readdirSync(shortsDir)
    .filter((file) => /^\d{2}-.+\.mp4$/i.test(file))
    .sort();
  if (shortFiles.length === 0) throw new Error(`No rendered shorts found in ${shortsDir}`);

  const clips: ReviewClip[] = [];
  for (const file of shortFiles) {
    const rank = rankFromFile(file);
    const trim = trimByRank.get(rank);
    if (!trim?.candidateId || !trim.momentId) {
      throw new Error(`Rendered clip ${rank} has no canonical candidate identity in trim-results.json`);
    }
    const padded = String(rank).padStart(2, "0");
    copyFileSync(join(shortsDir, file), join(reviewShortsDir, file));

    const ytThumb = `yt-${padded}.jpg`;
    const ttThumb = `tt-${padded}.jpg`;
    const copiedYt = copyIfExists(join(thumbsDir, ytThumb), join(reviewThumbsDir, ytThumb));
    copyIfExists(join(thumbsDir, ttThumb), join(reviewThumbsDir, ttThumb));
    if (!copiedYt) warnings.push(`thumbnail missing for clip ${padded}`);

    clips.push({
      rank,
      candidateId: trim.candidateId,
      momentId: trim.momentId,
      file,
      title: titles.get(rank) ?? file.replace(/^\d{2}-/, "").replace(/\.mp4$/i, ""),
      thumb: copiedYt ? `thumbnails/${ytThumb}` : null,
      quality: qualityByRank.get(rank),
      trim,
    });
  }

  copyIfExists(metadataPath, join(reviewDir, "upload-metadata.md"));
  copyIfExists(join(streamDir, "upload-metadata.json"), join(reviewDir, "upload-metadata.json"));
  copyIfExists(join(streamDir, "pick-quality.json"), join(reviewDir, "pick-quality.json"));
  copyIfExists(join(streamDir, "trim-results.json"), join(reviewDir, "trim-results.json"));

  const explicitSuggestedRank = qualityReport.suggestedRank ?? null;
  const suggestedFromIncludedClip =
    explicitSuggestedRank != null && clips.some((clip) => clip.rank === explicitSuggestedRank)
      ? explicitSuggestedRank
      : clips.find((clip) => clip.quality?.status === "suggested")?.rank ?? null;
  const suggestedRank = suggestedFromIncludedClip;
  writeFileSync(join(reviewDir, "review.html"), buildReviewHtml(manifest.title, clips, suggestedRank), "utf-8");
  writeFileSync(join(reviewDir, "REVIEW_PACKET.md"), buildReviewPacketMarkdown(manifest.title, clips, suggestedRank), "utf-8");
  writeFileSync(join(reviewDir, "review-decision.template.json"), buildDecisionTemplate(manifest.streamId, clips, suggestedRank), "utf-8");
  writeFileSync(join(reviewDir, "hermes-task.json"), buildHermesTask(manifest.streamId, reviewDir, suggestedRank), "utf-8");
  writeFileSync(
    join(reviewDir, "run-report.json"),
    JSON.stringify(
      {
        streamId: manifest.streamId,
        generatedAt: new Date().toISOString(),
        reviewDir,
        suggestedRank,
        clips: clips.length,
        shorts: shortFiles.length,
        warnings,
      },
      null,
      2,
    ),
    "utf-8",
  );

  log.info(`Review package ready: ${reviewDir}`);
  log.info(`Open: ${join(reviewDir, "review.html")}`);
  if (warnings.length > 0) log.warn(`Warnings: ${warnings.join("; ")}`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("prepare-review.ts") || process.argv[1]?.endsWith("prepare-review.js")) {
  main().catch((err) => {
    log.error(err.message ?? String(err));
    process.exit(1);
  });
}
