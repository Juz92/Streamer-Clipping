import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { loadManifest, saveManifest } from "./lib/manifest.js";
import { writeCleanTranscript } from "./lib/subtitle-parser.js";
import {
  parseRecallCandidates,
  parseEnrichmentQuery,
  dedupePicks,
  type NotebookLMPick,
} from "./lib/notebooklm-parser.js";
import { scorePick } from "./lib/notebooklm-scorer.js";
import { loadHeatmap, scoreHeatmapBonus, type HeatPoint } from "./lib/heatmap-extractor.js";
import { makeCandidateId } from "./lib/candidate-contract.js";
import { makeSemanticRecallMomentId, persistRecallUnion } from "./lib/recall-union.js";
import { QUERY_ENRICHMENT_TIMESTAMPS, QUERY_ENRICHMENT_RUBRIC } from "./lib/notebooklm-queries.js";
import { UNIFIED_SYSTEM_PROMPT, TRANSCRIPT_RECALL_ANALYSIS, windowTimestampedTranscript } from "./lib/gpt55-queries.js";

const log = createLogger("openrouter-review");
const POOL_PATH = join(DATA_DIR, "clips", "candidate-pool.json");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_MODEL = process.env.OPENROUTER_RECALL_MODEL ?? "openai/gpt-oss-120b:nitro";
const OPENROUTER_TIMEOUT_MS = Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS ?? "90000", 10);

interface CliArgs {
  streamId: string;
  force: boolean;
  top: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const streamIdx = args.indexOf("--stream");
  const topIdx = args.indexOf("--top");
  const streamId = streamIdx >= 0 ? args[streamIdx + 1] : "";
  return {
    streamId,
    force: args.includes("--force"),
    top: topIdx >= 0 ? parseInt(args[topIdx + 1], 10) : 15,
  };
}

async function callOpenRouter(systemPrompt: string, userContent: string): Promise<string> {
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === "sk-or-v1-...") {
    throw new Error("OPENROUTER_API_KEY not set in .env. Get one free at https://openrouter.ai/keys");
  }

  const url = "https://openrouter.ai/api/v1/chat/completions";

  const body = {
    model: OPENROUTER_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0,
    max_tokens: 8192,
    response_format: { type: "json_object" },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://clawzilla.local",
        "X-Title": "Clawzilla Stream Clipper",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("OpenRouter returned empty response");
    return text;
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`OpenRouter request timed out after ${OPENROUTER_TIMEOUT_MS}ms (${OPENROUTER_MODEL})`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
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

async function main() {
  const cli = parseArgs();
  if (!cli.streamId) {
    log.error("Usage: openrouter-review.ts --stream <id> [--force]");
    process.exit(1);
  }

  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === "sk-or-v1-...") {
    log.error("OPENROUTER_API_KEY not set. Get one free at https://openrouter.ai/keys");
    process.exit(1);
  }

  const manifest = loadManifest(cli.streamId);
  if (!manifest.subtitlePath || !existsSync(manifest.subtitlePath)) {
    log.error(`No subtitle file for ${cli.streamId}`);
    process.exit(1);
  }

  // Re-run guard
  if (manifest.phase === "notebooklm-reviewed" && !cli.force) {
    log.info("Already reviewed. Use --force to re-run.");
    process.exit(0);
  }

  // Step 1: Write clean transcript
  const sourceDir = join(manifest.jobDir, "source");
  mkdirSync(sourceDir, { recursive: true });
  const transcriptPath = join(sourceDir, "transcript_clean.txt");
  const lineCount = writeCleanTranscript(manifest.subtitlePath, transcriptPath);
  log.info(`Wrote clean transcript: ${lineCount} lines → ${transcriptPath}`);

  const transcript = readFileSync(transcriptPath, "utf-8");
  const transcriptSizeKb = Buffer.byteLength(transcript, "utf-8") / 1024;
  log.info(`Transcript size: ${transcriptSizeKb.toFixed(1)} KB`);

  // Step 2: Map each local transcript window independently, batched only for transport efficiency.
  const windows = windowTimestampedTranscript(transcript);
  const batchSize = 15;
  const batches = Array.from({ length: Math.ceil(windows.length / batchSize) }, (_, i) =>
    windows.slice(i * batchSize, (i + 1) * batchSize).join("\n\n"),
  );
  const allPicks: NotebookLMPick[] = [];

  const concurrency = 2;
  log.info(`Running local recall across ${windows.length} windows in ${batches.length} OpenRouter batches (${concurrency} concurrent)...`);
  for (let groupStart = 0; groupStart < batches.length; groupStart += concurrency) {
    const groupResults = await Promise.all(
      batches.slice(groupStart, groupStart + concurrency).map(async (batch, offset) => {
        const i = groupStart + offset;
        log.info(`  Batch ${i + 1}/${batches.length}`);
        try {
          let response = "";
          let picks: NotebookLMPick[] = [];
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              response = await callOpenRouter(UNIFIED_SYSTEM_PROMPT, TRANSCRIPT_RECALL_ANALYSIS(batch));
              picks = parseRecallCandidates({ value: { answer: response, conversation_id: `openrouter-recall-${i + 1}` } });
              if (picks.length === 0) throw new Error("OpenRouter returned zero recall candidates");
              break;
            } catch (error) {
              if (attempt === 1) throw error;
              log.warn(`  Batch ${i + 1} transient failure, retrying once: ${(error as Error).message}`);
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
          }
          writeFileSync(join(manifest.jobDir, `openrouter-recall-batch-${String(i + 1).padStart(2, "0")}.txt`), response, "utf-8");
          log.info(`  Batch ${i + 1}: ${picks.length} parsed candidates`);
          return picks;
        } catch (e) {
          log.warn(`  Batch ${i + 1} failed: ${(e as Error).message}`);
          return [];
        }
      }),
    );
    allPicks.push(...groupResults.flat());
    if (groupStart + concurrency < batches.length) await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Step 3: Deduplicate overlapping window boundaries.
  const deduped = dedupePicks(allPicks);
  log.info(`Total ${allPicks.length} picks → ${deduped.length} after dedup`);

  // Step 4: Enrichment — 2-pass (timestamps first, then rubric)
  const enrichedData = new Map<number, { coldOpenSec?: number; naturalEndSec?: number; thumbnailSec?: number; flashSec?: number; titleDrafts?: string[]; rubric?: any }>();

  if (process.env.RECALL_ENRICH === "1" && deduped.length > 0) {
    // Pass 1: Timestamps
    const candidatesForTimestamps = deduped.map((p, i) => ({
      id: i + 1,
      timestamp: formatTimestamp(p.startSec),
      hook: p.hook.slice(0, 80),
    }));
    const timestampPrompt = QUERY_ENRICHMENT_TIMESTAMPS(candidatesForTimestamps);
    log.info(`Running enrichment pass 1 (timestamps) for ${candidatesForTimestamps.length} candidates`);

    try {
      const tsResponse = await callOpenRouter(UNIFIED_SYSTEM_PROMPT, `${timestampPrompt}\n\n---\n\nSTREAM TRANSCRIPT:\n${transcript}`);
      const wrapped = { value: { answer: tsResponse, conversation_id: "openrouter" } };
      writeFileSync(join(manifest.jobDir, "enrichment-raw-pass1.txt"), tsResponse, "utf-8");
      const timestampRecords = parseEnrichmentQuery(wrapped);
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
      log.warn(`Timestamp enrichment failed: ${(e as Error).message}`);
    }

    // Pass 2: Rubric (only for matched candidates)
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
      log.info(`Running enrichment pass 2 (rubric) for ${enrichedCandidates.length} candidates`);
      try {
        const rubricResponse = await callOpenRouter(UNIFIED_SYSTEM_PROMPT, `${rubricPrompt}\n\n---\n\nSTREAM TRANSCRIPT:\n${transcript}`);
        const wrapped = { value: { answer: rubricResponse, conversation_id: "openrouter" } };
        const rubricRecords = parseEnrichmentQuery(wrapped);
        let withRubric = 0;
        for (const rec of rubricRecords) {
          const pick = deduped.find((p) => Math.abs(p.startSec - rec.anchorStartSec) <= 30);
          if (!pick) continue;
          const idx = deduped.indexOf(pick);
          const existing = enrichedData.get(idx) ?? {};
          enrichedData.set(idx, { ...existing, titleDrafts: rec.titleDrafts, rubric: rec.rubric });
          if (rec.rubric) withRubric++;
        }
        log.info(`Rubric enrichment: ${withRubric} scored`);
      } catch (e) {
        log.warn(`Rubric enrichment failed: ${(e as Error).message}`);
      }
    }

    // Back-fill enrichment onto deduped picks
    let enrichedCount = 0;
    for (const [idx, data] of enrichedData) {
      const pick = deduped[idx];
      if (!pick) continue;
      enrichedCount++;
      if (data.coldOpenSec) (pick as any).coldOpenSec = data.coldOpenSec;
      if (data.naturalEndSec) { (pick as any).naturalEndSec = data.naturalEndSec; pick.endSec = data.naturalEndSec; }
      if (data.thumbnailSec) (pick as any).thumbnailSec = data.thumbnailSec;
      if (data.flashSec) (pick as any).flashSec = data.flashSec;
      if (data.titleDrafts?.length) (pick as any).titleDrafts = data.titleDrafts;
      if (data.rubric) (pick as any).rubric = data.rubric;
    }
    log.info(`Total enriched: ${enrichedCount}/${deduped.length} picks`);
  }

  // Step 5: Score each pick
  let heatmap: HeatPoint[] | null = null;
  if (manifest.heatmapPath && existsSync(manifest.heatmapPath)) {
    const heatResult = loadHeatmap(manifest.streamId, join(manifest.jobDir, "source"));
    if (heatResult) heatmap = heatResult.points;
  }

  const scores = new Map<string, number>();
  for (let i = 0; i < deduped.length; i++) {
    const p = deduped[i];
    const durationSec = p.endSec - p.startSec;
    let heatmapBonus = 0;
    if (heatmap && manifest.durationSec > 0) {
      heatmapBonus = scoreHeatmapBonus(heatmap, p.startSec / manifest.durationSec, p.endSec / manifest.durationSec);
    }
    const result = scorePick({
      strength: p.strength, categories: p.categories, durationSec,
      setupNeeded: p.setupNeeded, setupOffsetSec: p.setupOffsetSec,
      categoryQueryHitCount: p.categoryQueryHitCount, quote: p.quote, hook: p.hook, heatmapBonus,
    });
    const rubric = (p as any).rubric as { hook: number; flow: number; engagement: number; trend: number; total: number } | undefined;
    const blended = rubric ? Math.round(0.5 * result.final + 0.5 * rubric.total) : result.final;
    scores.set(`${i}`, blended);
    (p as any).viralSubScores = { ...result.breakdown, rubric: rubric ?? null, blendedFinal: blended };
  }

  const jobId = manifest.jobDir.split(/[\\/]/).pop() ?? "unknown-job";

  // Step 6: Sort, cap, and write the production derivative.
  const sortedIndices = Array.from(scores.keys()).sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  const sortedPicks = sortedIndices.map((i) => deduped[parseInt(i, 10)]).slice(0, cli.top);
  log.info(`Capped to top ${cli.top} picks (${sortedIndices.length} total before cap)`);

  const nlmMoments = sortedPicks.map((p, i) => ({
    id: makeSemanticRecallMomentId(p),
    momentId: makeSemanticRecallMomentId(p),
    candidateId: makeCandidateId(jobId, makeSemanticRecallMomentId(p)),
    startSec: p.startSec, endSec: p.endSec, durationSec: p.endSec - p.startSec,
    description: p.hook, viralScore: scores.get(`${sortedIndices[i]}`) ?? 0,
    categories: p.categories, hook: p.hook, quote: p.quote,
    setupNeeded: p.setupNeeded, archetype: inferArchetype(p.categories),
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

  // Step 7: Persist the uncapped semantic + scorer/chat/audio recall union.
  const { union } = persistRecallUnion({
    jobDir: manifest.jobDir,
    jobId,
    streamId: manifest.streamId,
    streamDate: manifest.uploadDate,
    semanticCandidates: deduped,
    poolPath: POOL_PATH,
  });
  log.info(`Persisted ${union.length} uncapped recall-union candidates`);

  // Step 8: Write review markdown
  const analysisDir = join(manifest.jobDir, "analysis");
  mkdirSync(analysisDir, { recursive: true });
  const reviewMdPath = join(analysisDir, "notebooklm-review.md");
  const md = buildReviewMarkdown(manifest, nlmMoments);
  writeFileSync(reviewMdPath, md, "utf-8");
  log.info(`Wrote review markdown → ${reviewMdPath}`);

  // Step 9: Update manifest
  manifest.notebookLMReviewPath = nlmMomentsPath;
  manifest.notebookLMReviewedAt = new Date().toISOString();
  manifest.phase = "notebooklm-reviewed";
  saveManifest(manifest);

  log.info("✓ OpenRouter review complete");
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
    lines.push(`### ${i + 1}. [${formatTimestamp(m.startSec)}] ${m.hook} (score: ${m.viralScore})`);
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
