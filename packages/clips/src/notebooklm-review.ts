import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { loadManifest, saveManifest } from "./lib/manifest.js";
import { writeCleanTranscript } from "./lib/subtitle-parser.js";
import {
  createNotebook,
  addSource,
  query,
  deleteNotebook,
  isNlmAvailable,
} from "./lib/notebooklm-client.js";
import { ALL_QUERIES, QUERY_ENRICHMENT_TEMPLATE } from "./lib/notebooklm-queries.js";
import {
  parseHumorQuery,
  parseRunningBitsQuery,
  parseEmotionalPeaksQuery,
  parseFriendRoastsQuery,
  parseCrashOutsQuery,
  parseOneLinersQuery,
  parseStoryOfStreamQuery,
  parseEnrichmentQuery,
  dedupePicks,
  type NotebookLMPick,
  type DedupedPick,
  type SourceQuery,
} from "./lib/notebooklm-parser.js";
import { scorePick } from "./lib/notebooklm-scorer.js";
import {
  appendCandidates,
  removeByJobId,
  type CandidatePointer,
} from "./lib/candidate-pool.js";

const log = createLogger("notebooklm-review");
const POOL_PATH = join(DATA_DIR, "clips", "candidate-pool.json");

interface CliArgs {
  streamId: string;
  force: boolean;
  enrichOnly: boolean;
  queries: number[] | null;
  notebookStrategy: "per-stream" | "shared";
  dryRun: boolean;
  top: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let streamId = "";
  let force = false;
  let enrichOnly = false;
  let queries: number[] | null = null;
  let notebookStrategy: "per-stream" | "shared" = "per-stream";
  let dryRun = false;
  let top = 15;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) streamId = args[++i];
    else if (args[i] === "--force") force = true;
    else if (args[i] === "--enrich-only") enrichOnly = true;
    else if (args[i] === "--top" && args[i + 1]) top = parseInt(args[++i], 10);
    else if (args[i] === "--queries" && args[i + 1]) {
      queries = args[++i].split(",").map((n) => parseInt(n, 10));
    } else if (args[i] === "--notebook-strategy" && args[i + 1]) {
      const v = args[++i];
      if (v !== "per-stream" && v !== "shared") {
        log.error(`Invalid --notebook-strategy: ${v}`);
        process.exit(1);
      }
      notebookStrategy = v;
    } else if (args[i] === "--dry-run") dryRun = true;
  }

  if (!streamId) {
    log.error("Missing --stream <stream-id>");
    process.exit(1);
  }

  return { streamId, force, enrichOnly, queries, notebookStrategy, dryRun, top };
}

async function main(): Promise<void> {
  const cli = parseArgs();

  // Precondition: nlm CLI must be available
  if (!isNlmAvailable()) {
    if (cli.dryRun) {
      log.warn("nlm CLI not available, but --dry-run set, continuing in validation mode");
    } else {
      log.error(
        "nlm CLI not found on PATH. Install with: uv tool install notebooklm-mcp-cli",
      );
      process.exit(1);
    }
  }

  if (cli.notebookStrategy === "shared") {
    log.error(
      "Shared notebook strategy is architected-for but not implemented in V1. Use --notebook-strategy per-stream.",
    );
    process.exit(1);
  }

  // Load manifest
  const manifest = loadManifest(cli.streamId);
  if (!manifest.subtitlePath || !existsSync(manifest.subtitlePath)) {
    log.error(
      `No subtitle file available for stream ${cli.streamId}. NotebookLM review requires transcript.`,
    );
    process.exit(1);
  }

  // Re-run guard
  if (manifest.phase === "notebooklm-reviewed" && !cli.force && !cli.enrichOnly) {
    log.info("Stream already reviewed. Use --force to re-run.");
    process.exit(0);
  }

  // Dry-run: show plan and exit
  if (cli.dryRun) {
    log.info("=== DRY RUN ===");
    log.info(`Stream: ${manifest.streamId} (${manifest.title})`);
    log.info(`Subtitle: ${manifest.subtitlePath}`);
    log.info(`Job dir: ${manifest.jobDir}`);
    log.info(`Queries to run: ${cli.queries?.join(",") ?? "1-8 (all)"}`);
    log.info(`Force: ${cli.force}`);
    log.info(`Strategy: ${cli.notebookStrategy}`);
    log.info("No API calls made.");
    process.exit(0);
  }

  // Step 1: Write clean transcript
  const sourceDir = join(manifest.jobDir, "source");
  mkdirSync(sourceDir, { recursive: true });
  const transcriptPath = join(sourceDir, "transcript_clean.txt");
  const lineCount = writeCleanTranscript(manifest.subtitlePath, transcriptPath);
  log.info(`Wrote clean transcript: ${lineCount} lines → ${transcriptPath}`);

  // Step 2: Force cleanup if requested
  if (cli.force && manifest.notebookId) {
    log.info(`--force: deleting old notebook ${manifest.notebookId}`);
    deleteNotebook(manifest.notebookId);
    removeByJobId(POOL_PATH, manifest.jobDir.split(/[\\/]/).pop() ?? "");
    manifest.notebookId = undefined;
    manifest.notebookSourceId = undefined;
  }

  // Step 3: Create notebook (or reuse if resuming)
  let notebookId = manifest.notebookId;
  let sourceId = manifest.notebookSourceId;

  if (!notebookId) {
    const asciiTitle = `Peanut - ${manifest.streamId} - ${manifest.uploadDate}`;
    log.info(`Creating notebook: ${asciiTitle}`);
    const result = createNotebook(asciiTitle);
    notebookId = result.notebookId;
    manifest.notebookId = notebookId;
    saveManifest(manifest);
  }

  if (!sourceId) {
    log.info(`Uploading transcript source (wait for ingestion)...`);
    const result = addSource(notebookId, transcriptPath, "Stream transcript");
    sourceId = result.sourceId;
    manifest.notebookSourceId = sourceId;
    saveManifest(manifest);
  }

  // Step 4: Run queries 1-7 (unless --enrich-only or --queries)
  const queriesToRun = cli.queries
    ? ALL_QUERIES.filter((_, i) => cli.queries!.includes(i + 1))
    : ALL_QUERIES;

  let conversationId: string | undefined;
  const picksBySource = new Map<SourceQuery, NotebookLMPick[]>();

  if (!cli.enrichOnly) {
    for (const q of queriesToRun) {
      log.info(`Running query: ${q.key}`);
      try {
        const response = query(notebookId, q.prompt, { conversationId });
        conversationId ??= response.value.conversation_id;

        // Route to parser based on query key
        let picks: NotebookLMPick[];
        switch (q.key) {
          case "humor":
            picks = parseHumorQuery(response);
            break;
          case "running-bits":
            picks = parseRunningBitsQuery(response);
            break;
          case "emotional-peaks":
            picks = parseEmotionalPeaksQuery(response);
            break;
          case "friend-roasts":
            picks = parseFriendRoastsQuery(response);
            break;
          case "crash-outs":
            picks = parseCrashOutsQuery(response);
            break;
          case "one-liners":
            picks = parseOneLinersQuery(response);
            break;
          case "story-of-stream":
            picks = parseStoryOfStreamQuery(response);
            break;
          default:
            continue;
        }

        log.info(`Query ${q.key}: ${picks.length} picks`);
        picksBySource.set(q.key, picks);
      } catch (e) {
        log.warn(`Query ${q.key} failed: ${(e as Error).message}. Continuing.`);
      }
    }
  }

  // Step 5: Flatten + dedup
  const allPicks: NotebookLMPick[] = [];
  for (const arr of picksBySource.values()) allPicks.push(...arr);
  const deduped = dedupePicks(allPicks);
  log.info(`Total ${allPicks.length} picks → ${deduped.length} after dedup`);

  // Step 6: Enrichment (query 8)
  if (deduped.length > 0 && (!cli.queries || cli.queries.includes(8))) {
    const candidates = deduped.map((p, i) => ({
      id: i + 1,
      timestamp: formatTimestamp(p.startSec),
      hook: p.hook.slice(0, 80),
    }));
    const enrichPrompt = QUERY_ENRICHMENT_TEMPLATE(candidates);
    log.info(`Running enrichment query for ${candidates.length} candidates`);
    try {
      const response = query(notebookId, enrichPrompt, { conversationId });
      const enrichments = parseEnrichmentQuery(response);

      // Back-fill enrichment onto deduped picks
      let matched = 0;
      let unmatched = 0;
      let withRubric = 0;
      for (const e of enrichments) {
        const pick = deduped.find(
          (p) => Math.abs(p.startSec - e.anchorStartSec) <= 30,
        );
        if (!pick) {
          unmatched++;
          continue;
        }
        matched++;
        if (e.coldOpenSec) (pick as any).coldOpenSec = e.coldOpenSec;
        if (e.naturalEndSec) {
          (pick as any).naturalEndSec = e.naturalEndSec;
          pick.endSec = e.naturalEndSec;
        }
        if (e.thumbnailSec) (pick as any).thumbnailSec = e.thumbnailSec;
        if (e.titleDrafts.length) (pick as any).titleDrafts = e.titleDrafts;
        if (e.rubric) {
          (pick as any).rubric = e.rubric;
          withRubric++;
        }
      }
      if (withRubric > 0) {
        log.info(`Rubric extracted for ${withRubric}/${matched} matched picks`);
      }
      log.info(`Enrichment: ${matched} matched, ${unmatched} unmatched`);
      if (unmatched > 0) {
        log.warn(
          `${unmatched} enrichment records could not be matched to picks (NotebookLM drifted > 30s from anchor). These picks will render with default coldOpen/naturalEnd/thumbnail.`,
        );
      }
    } catch (e) {
      log.warn(`Enrichment query failed: ${(e as Error).message}. Proceeding with picks as-is.`);
    }
  }

  // Step 7: Score each pick. When the 4-axis rubric is available from
  // enrichment, blend it 50/50 with the rule-based score so NotebookLM's
  // judgment on hook/flow/engagement/trend carries real weight.
  const scores = new Map<string, number>();
  for (let i = 0; i < deduped.length; i++) {
    const p = deduped[i];
    const result = scorePick({
      strength: p.strength,
      categories: p.categories,
      durationSec: p.endSec - p.startSec,
      setupNeeded: p.setupNeeded,
      setupOffsetSec: p.setupOffsetSec,
      categoryQueryHitCount: p.categoryQueryHitCount,
    });
    const rubric = (p as any).rubric as
      | { hook: number; flow: number; engagement: number; trend: number; total: number }
      | undefined;
    const blended = rubric
      ? Math.round(0.5 * result.final + 0.5 * rubric.total)
      : result.final;
    scores.set(`${i}`, blended);
    (p as any).viralSubScores = {
      ...result.breakdown,
      rubric: rubric ?? null,
      blendedFinal: blended,
    };
  }

  // Step 8: Sort by score descending, cap at --top (default 15)
  const sortedIndices = Array.from(scores.keys()).sort(
    (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0),
  );
  const sortedPicks = sortedIndices.map((i) => deduped[parseInt(i, 10)]).slice(0, cli.top);
  log.info(`Capped to top ${cli.top} picks (${sortedIndices.length} total before cap)`);

  // Step 9: Write notebooklm-moments.json
  const nlmMoments = sortedPicks.map((p, i) => ({
    id: `nlm-${String(i + 1).padStart(3, "0")}`,
    startSec: p.startSec,
    endSec: p.endSec,
    durationSec: p.endSec - p.startSec,
    description: p.hook,
    viralScore: scores.get(`${sortedIndices[i]}`) ?? 0,
    categories: p.categories,
    hook: p.hook,
    quote: p.quote,
    setupNeeded: p.setupNeeded,
    coldOpenSec: (p as any).coldOpenSec,
    naturalEndSec: (p as any).naturalEndSec,
    thumbnailSec: (p as any).thumbnailSec,
    titleDrafts: (p as any).titleDrafts,
    rubric: (p as any).rubric,
    viralSubScores: (p as any).viralSubScores,
  }));

  const nlmMomentsPath = join(manifest.jobDir, "notebooklm-moments.json");
  writeFileSync(nlmMomentsPath, JSON.stringify(nlmMoments, null, 2), "utf-8");
  log.info(`Wrote ${nlmMoments.length} picks → ${nlmMomentsPath}`);

  // Step 10: Append to candidate pool
  const jobId = manifest.jobDir.split(/[\\/]/).pop() ?? "unknown-job";
  const pointers: CandidatePointer[] = nlmMoments.map((m) => ({
    jobId,
    momentId: m.id,
    streamId: manifest.streamId,
    streamDate: manifest.uploadDate,
    categories: m.categories,
    viralScore: m.viralScore,
    durationSec: m.durationSec,
    hook: m.hook,
    status: "pending" as const,
    statusUpdatedAt: new Date().toISOString(),
  }));
  appendCandidates(POOL_PATH, pointers);
  log.info(`Appended ${pointers.length} candidates to ${POOL_PATH}`);

  // Step 11: Write human-readable review markdown
  const analysisDir = join(manifest.jobDir, "analysis");
  mkdirSync(analysisDir, { recursive: true });
  const reviewMdPath = join(analysisDir, "notebooklm-review.md");
  const md = buildReviewMarkdown(manifest, nlmMoments);
  writeFileSync(reviewMdPath, md, "utf-8");
  log.info(`Wrote review markdown → ${reviewMdPath}`);

  // Step 12: Update manifest
  manifest.notebookLMReviewPath = nlmMomentsPath;
  manifest.notebookLMReviewedAt = new Date().toISOString();
  manifest.phase = "notebooklm-reviewed";
  saveManifest(manifest);

  log.info("✓ NotebookLM review complete");
}

function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildReviewMarkdown(manifest: any, moments: any[]): string {
  const lines: string[] = [];
  lines.push(`# NotebookLM Review — ${manifest.streamId}`);
  lines.push("");
  lines.push(`**Stream:** ${manifest.title}`);
  lines.push(`**Date:** ${manifest.uploadDate}`);
  lines.push(`**Duration:** ${Math.round(manifest.durationSec / 60)} min`);
  lines.push(`**Picks:** ${moments.length}`);
  lines.push("");
  lines.push("## Ranked picks");
  lines.push("");
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    lines.push(
      `### ${i + 1}. [${formatTimestamp(m.startSec)}] ${m.hook} (score: ${m.viralScore})`,
    );
    lines.push(`- **Categories:** ${m.categories.join(", ")}`);
    lines.push(`- **Duration:** ${m.durationSec}s`);
    if (m.quote) lines.push(`- **Quote:** "${m.quote}"`);
    if (m.titleDrafts?.length) {
      lines.push(`- **Title drafts:**`);
      for (const t of m.titleDrafts) lines.push(`  - ${t}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((err) => {
  log.error(err.message ?? err);
  process.exit(1);
});
