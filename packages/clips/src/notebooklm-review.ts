import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { loadManifest, saveManifest } from "./lib/manifest.js";
import { writeCleanTranscript } from "./lib/subtitle-parser.js";
import {
  createNotebook,
  addSource,
  query,
  deleteNotebook,
  isNlmAvailable,
  reauth,
} from "./lib/notebooklm-client.js";
import { ALL_QUERIES, QUERY_ENRICHMENT_TIMESTAMPS, QUERY_ENRICHMENT_RUBRIC } from "./lib/notebooklm-queries.js";
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
import { loadHeatmap, scoreHeatmapBonus, type HeatPoint } from "./lib/heatmap-extractor.js";
import { makeCandidateId } from "./lib/candidate-contract.js";
import { makeSemanticRecallMomentId, persistRecallUnion } from "./lib/recall-union.js";

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

  // Re-auth before queries — cookies may expire during long upload wait
  reauth();

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
        const response = await queryWithRetry(notebookId, q.prompt, { conversationId });
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
        await sleep(8000); // 8s between queries to avoid Google rate limits
        picksBySource.set(q.key, picks);
      } catch (e) {
        log.warn(`Query ${q.key} failed: ${(e as Error).message}. Continuing.`);
      }
    }
  }

  // Step 5: Flatten + dedup. Enrichment-only runs must start from the
  // existing full recall artifact; an empty query set must never clear the pool.
  const allPicks: NotebookLMPick[] = [];
  if (cli.enrichOnly) {
    const recallPath = join(manifest.jobDir, "recall-candidates.json");
    if (!existsSync(recallPath)) {
      throw new Error("--enrich-only requires an existing recall-candidates.json artifact");
    }
    allPicks.push(...JSON.parse(readFileSync(recallPath, "utf-8")) as NotebookLMPick[]);
  } else {
    for (const arr of picksBySource.values()) allPicks.push(...arr);
  }
  const deduped = dedupePicks(allPicks);
  log.info(`Total ${allPicks.length} picks → ${deduped.length} after dedup`);

  // Step 6: Enrichment — 2-pass approach (timestamps first, then rubric)
  const enrichedData = new Map<number, { coldOpenSec?: number; naturalEndSec?: number; thumbnailSec?: number; flashSec?: number; titleDrafts?: string[]; rubric?: any }>();

  if (deduped.length > 0 && (!cli.queries || cli.queries.includes(8))) {
    // Pass 1: Get timestamps (coldOpen, flash, naturalEnd, thumbnail)
    const candidatesForTimestamps = deduped.map((p, i) => ({
      id: i + 1,
      timestamp: formatTimestamp(p.startSec),
      hook: p.hook.slice(0, 80),
    }));
    const timestampPrompt = QUERY_ENRICHMENT_TIMESTAMPS(candidatesForTimestamps);
    await sleep(15000); // 15s before enrichment to avoid rate limits
    log.info(`Running enrichment pass 1 (timestamps) for ${candidatesForTimestamps.length} candidates`);
    try {
      const tsResponse = await queryWithRetry(notebookId, timestampPrompt, { conversationId });
      // DEBUG: log raw enrichment response
      writeFileSync(
        join(manifest.jobDir, "enrichment-raw-response.json"),
        JSON.stringify(tsResponse, null, 2),
      );
      const timestampRecords = parseEnrichmentQuery(tsResponse);
      let matched = 0;
      for (const rec of timestampRecords) {
        const pick = deduped.find((p) => Math.abs(p.startSec - rec.anchorStartSec) <= 30);
        if (!pick) continue;
        matched++;
        const idx = deduped.indexOf(pick);
        enrichedData.set(idx, {
          coldOpenSec: rec.coldOpenSec,
          naturalEndSec: rec.naturalEndSec,
          thumbnailSec: rec.thumbnailSec,
          flashSec: rec.flashSec,
        });
        if (rec.naturalEndSec) pick.endSec = rec.naturalEndSec;
      }
      log.info(`Timestamp enrichment: ${matched} matched`);
    } catch (e) {
      log.warn(`Timestamp enrichment failed: ${(e as Error).message}. Proceeding without timestamps.`);
    }

    // Pass 2: Get rubric scores + title drafts (only for matched candidates)
    const enrichedCandidates = deduped
      .map((p, i) => {
        const data = enrichedData.get(i);
        if (!data) return null;
        return {
          id: i + 1,
          timestamp: formatTimestamp(p.startSec),
          hook: p.hook.slice(0, 80),
          coldOpen: data.coldOpenSec ? formatTimestamp(data.coldOpenSec) : formatTimestamp(p.startSec),
          flash: data.flashSec ? formatTimestamp(data.flashSec) : "none",
          naturalEnd: data.naturalEndSec ? formatTimestamp(data.naturalEndSec) : formatTimestamp(p.endSec),
          thumbnail: data.thumbnailSec ? formatTimestamp(data.thumbnailSec) : formatTimestamp(p.startSec + (p.endSec - p.startSec) / 2),
        };
      })
      .filter(Boolean) as Array<{ id: number; timestamp: string; hook: string; coldOpen: string; flash: string; naturalEnd: string; thumbnail: string }>;

    if (enrichedCandidates.length > 0) {
      const rubricPrompt = QUERY_ENRICHMENT_RUBRIC(enrichedCandidates);
      await sleep(15000); // 15s before enrichment to avoid rate limits
    log.info(`Running enrichment pass 2 (rubric) for ${enrichedCandidates.length} candidates`);
      try {
        const rubricResponse = await queryWithRetry(notebookId, rubricPrompt, { conversationId });
        const rubricRecords = parseEnrichmentQuery(rubricResponse);
        let withRubric = 0;
        for (const rec of rubricRecords) {
          const pick = deduped.find((p) => Math.abs(p.startSec - rec.anchorStartSec) <= 30);
          if (!pick) continue;
          const idx = deduped.indexOf(pick);
          const existing = enrichedData.get(idx) ?? {};
          enrichedData.set(idx, {
            ...existing,
            titleDrafts: rec.titleDrafts,
            rubric: rec.rubric,
          });
          if (rec.rubric) withRubric++;
        }
        log.info(`Rubric enrichment: ${withRubric} scored`);
      } catch (e) {
        log.warn(`Rubric enrichment failed: ${(e as Error).message}. Proceeding without rubric.`);
      }
    }

    // Back-fill enrichment onto deduped picks
    let enrichedCount = 0;
    for (const [idx, data] of enrichedData) {
      const pick = deduped[idx];
      if (!pick) continue;
      enrichedCount++;
      if (data.coldOpenSec) (pick as any).coldOpenSec = data.coldOpenSec;
      if (data.naturalEndSec) {
        (pick as any).naturalEndSec = data.naturalEndSec;
        pick.endSec = data.naturalEndSec;
      }
      if (data.thumbnailSec) (pick as any).thumbnailSec = data.thumbnailSec;
      if (data.flashSec) (pick as any).flashSec = data.flashSec;
      if (data.titleDrafts?.length) (pick as any).titleDrafts = data.titleDrafts;
      if (data.rubric) (pick as any).rubric = data.rubric;
    }
    log.info(`Total enriched: ${enrichedCount}/${deduped.length} picks`);
  }

  // Load heatmap if available for crowd-sourced scoring boost
  let heatmap: HeatPoint[] | null = null;
  if (manifest.heatmapPath && existsSync(manifest.heatmapPath)) {
    const heatResult = loadHeatmap(manifest.streamId, join(manifest.jobDir, "source"));
    if (heatResult) {
      heatmap = heatResult.points;
      log.info(`Loaded heatmap: ${heatmap.length} points`);
    }
  }

  // Step 7: Score each pick. When the 4-axis rubric is available from
  // enrichment, blend it 50/50 with the rule-based score so NotebookLM's
  // judgment on hook/flow/engagement/trend carries real weight.
  const scores = new Map<string, number>();
  for (let i = 0; i < deduped.length; i++) {
    const p = deduped[i];
    const durationSec = p.endSec - p.startSec;

    // Compute heatmap bonus based on moment's position in stream
    let heatmapBonus = 0;
    if (heatmap && manifest.durationSec > 0) {
      const startPct = p.startSec / manifest.durationSec;
      const endPct = p.endSec / manifest.durationSec;
      heatmapBonus = scoreHeatmapBonus(heatmap, startPct, endPct);
      if (heatmapBonus > 0) {
        log.debug(`Pick ${i}: heatmap bonus +${heatmapBonus} (${startPct.toFixed(2)}-${endPct.toFixed(2)})`);
      }
    }

    const result = scorePick({
      strength: p.strength,
      categories: p.categories,
      durationSec,
      setupNeeded: p.setupNeeded,
      setupOffsetSec: p.setupOffsetSec,
      categoryQueryHitCount: p.categoryQueryHitCount,
      quote: p.quote,
      hook: p.hook,
      heatmapBonus,
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

  const jobId = manifest.jobDir.split(/[\\/]/).pop() ?? "unknown-job";

  // Step 8: Sort by score and cap only the production derivative.
  const sortedIndices = Array.from(scores.keys()).sort(
    (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0),
  );
  const sortedPicks = sortedIndices.map((i) => deduped[parseInt(i, 10)]).slice(0, cli.top);
  log.info(`Capped to top ${cli.top} picks (${sortedIndices.length} total before cap)`);

  // Step 9: Write notebooklm-moments.json
  const nlmMoments = sortedPicks.map((p, i) => ({
    id: makeSemanticRecallMomentId(p),
    momentId: makeSemanticRecallMomentId(p),
    candidateId: makeCandidateId(jobId, makeSemanticRecallMomentId(p)),
    startSec: p.startSec,
    endSec: p.endSec,
    durationSec: p.endSec - p.startSec,
    description: p.hook,
    viralScore: scores.get(`${sortedIndices[i]}`) ?? 0,
    categories: p.categories,
    hook: p.hook,
    quote: p.quote,
    setupNeeded: p.setupNeeded,
    archetype: inferArchetype(p.categories),
    visualType: p.visualType,
    coldOpenSec: (p as any).coldOpenSec,
    naturalEndSec: (p as any).naturalEndSec,
    thumbnailSec: (p as any).thumbnailSec,
    flashSec: (p as any).flashSec ?? p.flashSec,
    titleDrafts: (p as any).titleDrafts,
    rubric: (p as any).rubric,
    viralSubScores: (p as any).viralSubScores,
  }));

  const nlmMomentsPath = join(manifest.jobDir, "notebooklm-moments.json");
  writeFileSync(nlmMomentsPath, JSON.stringify(nlmMoments, null, 2), "utf-8");
  log.info(`Wrote ${nlmMoments.length} picks → ${nlmMomentsPath}`);

  // Step 10: Persist the uncapped semantic + scorer/chat/audio recall union.
  const { union } = persistRecallUnion({
    jobDir: manifest.jobDir,
    jobId,
    streamId: manifest.streamId,
    streamDate: manifest.uploadDate,
    semanticCandidates: deduped,
    poolPath: POOL_PATH,
  });
  log.info(`Persisted ${union.length} uncapped recall-union candidates`);

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

// Retry wrapper for NotebookLM queries with exponential backoff
async function queryWithRetry(
  notebookId: string,
  prompt: string,
  opts: { conversationId?: string },
  maxRetries = 3,
): Promise<any> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delayMs = Math.min(30000, 5000 * Math.pow(2, attempt)); // 10s, 20s, 30s
        log.info(`  Retry ${attempt}/${maxRetries} after ${delayMs}ms...`);
        await sleep(delayMs);
      }
      return query(notebookId, prompt, opts);
    } catch (e) {
      const msg = (e as Error).message;
      lastError = e as Error;
      if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("rate limit") || msg.includes("8:")) {
        log.warn(`  Rate limited (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.slice(0, 100)}`);
        continue;
      }
      // Non-retryable error — throw immediately
      throw e;
    }
  }
  throw lastError ?? new Error("Max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function inferArchetype(categories: string[]): string {
  if (categories.includes("friend-roast") || categories.includes("roast")) return "roast";
  if (categories.includes("crash-out") || categories.includes("meltdown")) return "crashout";
  if (categories.includes("skill") || categories.includes("clutch") || categories.includes("gameplay")) return "skill";
  if (categories.includes("one-liner") || categories.includes("quotable")) return "one-liner";
  if (categories.includes("story-of-stream") || categories.includes("callback") || categories.includes("running-bit")) return "story-payoff";
  return "general";
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
    lines.push(`- **Archetype:** ${m.archetype}`);
    if (m.visualType) lines.push(`- **Visual Type:** ${m.visualType}`);
    lines.push(`- **Duration:** ${m.durationSec}s`);
    if (m.flashSec) lines.push(`- **Flash:** ${formatTimestamp(m.flashSec)}`);
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
