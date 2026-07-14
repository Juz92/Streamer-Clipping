/**
 * gpt55-review.ts — GPT-5.5 transcript analysis replacing NotebookLM.
 *
 * Advantages over NotebookLM:
 *   - No upload/download overhead (transcript sent directly in prompt)
 *   - Single API call for all 7 query categories (vs 7 sequential NotebookLM queries)
 *   - No auth expiration, Windows cp1252 issues, or rate-limit waits
 *   - Faster: ~30-60s total vs 10-15min
 *   - Same output format → fully compatible with existing pipeline
 *
 * Usage:
 *   npx tsx packages/clips/src/gpt55-review.ts --stream <id> [--top 15] [--force]
 *
 * Env: OPENAI_API_KEY must be set.
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { createLogger, DATA_DIR } from "@ltx/shared";
import { loadManifest, saveManifest } from "./lib/manifest.js";
import { writeCleanTranscript } from "./lib/subtitle-parser.js";
import { chatCompletion, isGpt55Available } from "./lib/gpt55-client.js";
import { UNIFIED_SYSTEM_PROMPT, UNIFIED_ANALYSIS, UNIFIED_ENRICHMENT_TIMESTAMPS, UNIFIED_ENRICHMENT_RUBRIC } from "./lib/gpt55-queries.js";
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

const log = createLogger("gpt55-review");
const POOL_PATH = join(DATA_DIR, "clips", "candidate-pool.json");

interface CliArgs {
  streamId: string;
  force: boolean;
  dryRun: boolean;
  top: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let streamId = "";
  let force = false;
  let dryRun = false;
  let top = 15;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) streamId = args[++i];
    else if (args[i] === "--force") force = true;
    else if (args[i] === "--top" && args[i + 1]) top = parseInt(args[++i], 10);
    else if (args[i] === "--dry-run") dryRun = true;
  }

  if (!streamId) {
    log.error("Usage: gpt55-review.ts --stream <id> [--top 15] [--force] [--dry-run]");
    process.exit(1);
  }

  return { streamId, force, dryRun, top };
}

async function main(): Promise<void> {
  const cli = parseArgs();

  if (!isGpt55Available()) {
    log.error("OPENAI_API_KEY not set. GPT-5.5 review unavailable.");
    process.exit(1);
  }

  const manifest = loadManifest(cli.streamId);
  if (!manifest.subtitlePath || !existsSync(manifest.subtitlePath)) {
    log.error(`No subtitle file for stream ${cli.streamId}`);
    process.exit(1);
  }

  if (manifest.phase === "notebooklm-reviewed" && !cli.force) {
    log.info("Stream already reviewed. Use --force to re-run.");
    process.exit(0);
  }

  if (cli.dryRun) {
    log.info("=== DRY RUN ===");
    log.info(`Stream: ${manifest.streamId} (${manifest.title})`);
    log.info(`Would send transcript to GPT-5.5 for unified analysis`);
    log.info(`Top picks: ${cli.top}`);
    process.exit(0);
  }

  // Step 1: Write clean transcript
  const sourceDir = join(manifest.jobDir, "source");
  mkdirSync(sourceDir, { recursive: true });
  const transcriptPath = join(sourceDir, "transcript_clean.txt");
  const lineCount = writeCleanTranscript(manifest.subtitlePath, transcriptPath);
  log.info(`Clean transcript: ${lineCount} lines → ${transcriptPath}`);

  // Step 2: Load transcript content
  const transcript = readFileSync(transcriptPath, "utf-8");
  log.info(`Transcript size: ${transcript.length} chars (~${Math.round(transcript.length / 4)} tokens estimated)`);

  // Step 3: Run unified analysis (single API call for all 7 categories)
  log.info("Sending unified analysis request to GPT-5.5...");
  const analysisStart = Date.now();

  const analysisResponse = await chatCompletion({
    messages: [
      { role: "system", content: UNIFIED_SYSTEM_PROMPT },
      { role: "user", content: UNIFIED_ANALYSIS(transcript) },
    ],
    temperature: 0.3,
    max_tokens: 16_384,
    timeoutMs: 180_000,
  });

  const analysisElapsed = (Date.now() - analysisStart) / 1000;
  log.info(`Analysis complete in ${analysisElapsed.toFixed(1)}s`);
  if (analysisResponse.usage) {
    log.info(`Tokens: ${analysisResponse.usage.prompt_tokens} prompt + ${analysisResponse.usage.completion_tokens} completion`);
  }

  // Save raw response for debugging
  const rawResponsePath = join(manifest.jobDir, "gpt55-raw-response.txt");
  writeFileSync(rawResponsePath, analysisResponse.content, "utf-8");

  // Step 4: Parse all categories from single response
  const picksBySource = new Map<SourceQuery, NotebookLMPick[]>();

  // Parse by routing through each category's parser
  // We wrap the full response in a fake API structure so existing parsers work
  const fakeResponse = { value: { answer: analysisResponse.content, conversation_id: "gpt55-unified-analysis" } };

  // Each parser looks for its section headers, so they can all run on the same text
  picksBySource.set("humor", parseHumorQuery(fakeResponse));
  picksBySource.set("running-bits", parseRunningBitsQuery(fakeResponse));
  picksBySource.set("emotional-peaks", parseEmotionalPeaksQuery(fakeResponse));
  picksBySource.set("friend-roasts", parseFriendRoastsQuery(fakeResponse));
  picksBySource.set("crash-outs", parseCrashOutsQuery(fakeResponse));
  picksBySource.set("one-liners", parseOneLinersQuery(fakeResponse));
  picksBySource.set("story-of-stream", parseStoryOfStreamQuery(fakeResponse));

  const totalPicks = Array.from(picksBySource.values()).reduce((sum, arr) => sum + arr.length, 0);
  log.info(`Parsed ${totalPicks} total picks across ${picksBySource.size} categories`);

  // Step 5: Flatten + dedup
  const allPicks: NotebookLMPick[] = [];
  for (const arr of picksBySource.values()) allPicks.push(...arr);
  const deduped = dedupePicks(allPicks);
  log.info(`Deduped: ${allPicks.length} → ${deduped.length} unique picks`);

  // Step 6: Enrichment — timestamps (pass 1)
  const enrichedData = new Map<number, { coldOpenSec?: number; naturalEndSec?: number; thumbnailSec?: number; flashSec?: number; titleDrafts?: string[]; rubric?: any }>();

  if (deduped.length > 0) {
    const candidatesForTimestamps = deduped.slice(0, 20).map((p, i) => ({
      id: i + 1,
      timestamp: formatTimestamp(p.startSec),
      hook: p.hook.slice(0, 80),
    }));

    const timestampPrompt = UNIFIED_ENRICHMENT_TIMESTAMPS(candidatesForTimestamps);
    log.info(`Running enrichment pass 1 (timestamps) for ${candidatesForTimestamps.length} candidates`);

    try {
      const tsResponse = await chatCompletion({
        messages: [
          { role: "system", content: UNIFIED_SYSTEM_PROMPT },
          { role: "user", content: timestampPrompt },
        ],
        temperature: 0.2,
        max_tokens: 8_192,
        timeoutMs: 120_000,
      });

      const tsFakeResponse = { value: { answer: tsResponse.content, conversation_id: "gpt55-timestamp-enrichment" } };
      const timestampRecords = parseEnrichmentQuery(tsFakeResponse);

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
      log.info(`Timestamp enrichment: ${matched}/${candidatesForTimestamps.length} matched`);
    } catch (e) {
      log.warn(`Timestamp enrichment failed: ${(e as Error).message}. Proceeding without.`);
    }

    // Step 7: Enrichment — rubric + title drafts (pass 2)
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
      const rubricPrompt = UNIFIED_ENRICHMENT_RUBRIC(enrichedCandidates);
      log.info(`Running enrichment pass 2 (rubric) for ${enrichedCandidates.length} candidates`);

      try {
        const rubricResponse = await chatCompletion({
          messages: [
            { role: "system", content: UNIFIED_SYSTEM_PROMPT },
            { role: "user", content: rubricPrompt },
          ],
          temperature: 0.2,
          max_tokens: 8_192,
          timeoutMs: 120_000,
        });

        const rubricFakeResponse = { value: { answer: rubricResponse.content, conversation_id: "gpt55-rubric-enrichment" } };
        const rubricRecords = parseEnrichmentQuery(rubricFakeResponse);

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
        log.warn(`Rubric enrichment failed: ${(e as Error).message}. Proceeding without.`);
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

  // Step 8: Score each pick
  let heatmap: HeatPoint[] | null = null;
  if (manifest.heatmapPath && existsSync(manifest.heatmapPath)) {
    const heatResult = loadHeatmap(manifest.streamId, join(manifest.jobDir, "source"));
    if (heatResult) {
      heatmap = heatResult.points;
      log.info(`Loaded heatmap: ${heatmap.length} points`);
    }
  }

  const scores = new Map<string, number>();
  for (let i = 0; i < deduped.length; i++) {
    const p = deduped[i];
    const durationSec = p.endSec - p.startSec;

    let heatmapBonus = 0;
    if (heatmap && manifest.durationSec > 0) {
      const startPct = p.startSec / manifest.durationSec;
      const endPct = p.endSec / manifest.durationSec;
      heatmapBonus = scoreHeatmapBonus(heatmap, startPct, endPct);
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
      ...estimateFunnyQuote(p, (p as any).rubric),
    });

    const rubric = (p as any).rubric as { hook: number; flow: number; engagement: number; humor?: number; trend: number; total: number } | undefined;
    const funny = estimateFunnyQuote(p, rubric);
    const blended = rubric ? Math.round(0.5 * result.final + 0.5 * rubric.total) : result.final;
    scores.set(`${i}`, blended);
    (p as any).funnyQuote = funny.funnyQuote;
    (p as any).humorPotential = funny.humorPotential;
    (p as any).viralSubScores = { ...result.breakdown, rubric: rubric ?? null, funnyQuote: funny.funnyQuote, humorPotential: funny.humorPotential, blendedFinal: blended };
  }

  const jobId = manifest.jobDir.split(/[\\/]/).pop() ?? "unknown-job";

  // Step 9: Sort, cap, and write the production derivative.
  const sortedIndices = Array.from(scores.keys()).sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  const sortedPicks = sortedIndices.map((i) => deduped[parseInt(i, 10)]).slice(0, cli.top);
  log.info(`Capped to top ${cli.top} picks (${sortedIndices.length} total)`);

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
    funnyQuote: (p as any).funnyQuote ?? false,
    humorPotential: (p as any).humorPotential ?? 0,
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

  // Step 11: Write review markdown
  const analysisDir = join(manifest.jobDir, "analysis");
  mkdirSync(analysisDir, { recursive: true });
  const reviewMdPath = join(analysisDir, "gpt55-review.md");
  const md = buildReviewMarkdown(manifest, nlmMoments);
  writeFileSync(reviewMdPath, md, "utf-8");
  log.info(`Wrote review markdown → ${reviewMdPath}`);

  // Step 12: Update manifest
  manifest.notebookLMReviewPath = nlmMomentsPath;
  manifest.notebookLMReviewedAt = new Date().toISOString();
  manifest.phase = "notebooklm-reviewed";
  saveManifest(manifest);

  log.info("✓ GPT-5.5 review complete");
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

function estimateFunnyQuote(p: DedupedPick, rubric?: any): { funnyQuote: boolean; humorPotential: number } {
  const text = [p.quote, p.hook, p.categories.join(" ")].filter(Boolean).join(" ").toLowerCase();
  const explicitFunny = /(lol|lmao|haha|funny|hilarious|crying|dead|roast|one-liner|quotable|wtf|what the|can't say that|sus|pause)/.test(text);
  const mundane = /(explain|talks about|discusses|strategy|where to go|inventory|craft|building|driving)/.test(text);
  const categoryFunny = p.categories.some((c) => ["humor", "dry-joke", "absurdist", "reaction-gold", "friend-roast", "roast", "one-liner", "quotable"].includes(c));
  const rubricHumor = Number(rubric?.humor ?? rubric?.engagement ?? 0);
  const quoteShortEnough = (p.quote?.trim().split(/\s+/).length ?? 99) <= 18;
  const funnyQuote = Boolean(p.quote && quoteShortEnough && !mundane && (explicitFunny || categoryFunny || rubricHumor >= 18));
  const humorPotential = Math.max(
    funnyQuote ? 0.85 : 0,
    categoryFunny ? 0.7 : 0,
    explicitFunny ? 0.65 : 0,
    Math.min(rubricHumor / 25, 1),
  );
  return { funnyQuote, humorPotential };
}

function buildReviewMarkdown(manifest: any, moments: any[]): string {
  const lines: string[] = [];
  lines.push(`# GPT-5.5 Review — ${manifest.streamId}`);
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
    lines.push(`- **Funny Quote:** ${m.funnyQuote ? "yes" : "no"}`);
    lines.push(`- **Humor Potential:** ${Math.round((m.humorPotential ?? 0) * 100)}/100`);
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
