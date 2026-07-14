/**
 * orchestrate.ts — Run the full clip pipeline end-to-end.
 *
 * Usage:
 *   npx tsx packages/clips/src/orchestrate.ts                    # Latest stream
 *   npx tsx packages/clips/src/orchestrate.ts --url <url>        # Specific stream
 *   npx tsx packages/clips/src/orchestrate.ts --stream <id>      # Resume from stream ID
 *   npx tsx packages/clips/src/orchestrate.ts --stream <id> --from analyze  # Resume from step
 *   npx tsx packages/clips/src/orchestrate.ts --top 5            # Render top N clips
 *   npx tsx packages/clips/src/orchestrate.ts --dry-run          # Show plan without executing
 */

import "dotenv/config";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger } from "@ltx/shared";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import { isNlmAvailable } from "./lib/notebooklm-client.js";
import { transcribeAllClips } from "./lib/whisper-captions.js";
import { blocksMissingQaReview, blocksMissingTranscriptReview } from "./quality-gates.js";
export { blocksMissingQaReview, blocksMissingTranscriptReview } from "./quality-gates.js";

const log = createLogger("orchestrate");

const STEPS = ["discover", "analyze", "notebooklm-review", "pick-quality", "trim", "story-gate", "whisper-captions", "render", "review", "thumbnails", "generate-metadata", "review-package", "upload"] as const;
type Step = (typeof STEPS)[number];

interface RunRecord {
  label: string;
  command: string;
  startedAt: string;
  endedAt?: string;
  attempts: number;
  status: "success" | "failed";
  error?: string;
}

interface OrchestrateArgs {
  url?: string;
  streamId?: string;
  from?: Step;
  top: number;
  dryRun: boolean;
  skipNotebookLM: boolean;
  useGpt55: boolean;
  interactiveTrim: boolean;
  skipReview: boolean;
  warnOnlyGates: boolean;
  prepareUploadPackage: boolean;
  allowScorerOnly: boolean;
  allowNoQa: boolean;
}

const runStartedAt = new Date().toISOString();
const runRecords: RunRecord[] = [];
const runWarnings: string[] = [];
let activeStreamId: string | undefined;

function warn(message: string): void {
  runWarnings.push(message);
  log.warn(message);
}

function parseArgs(): OrchestrateArgs {
  const args = process.argv.slice(2);
  const result: OrchestrateArgs = {
    top: 15,
    dryRun: false,
    skipNotebookLM: false,
    useGpt55: false,
    interactiveTrim: false,
    skipReview: false,
    warnOnlyGates: false,
    prepareUploadPackage: false,
    allowScorerOnly: false,
    allowNoQa: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      result.url = args[++i];
    } else if (args[i] === "--stream" && args[i + 1]) {
      result.streamId = args[++i];
    } else if (args[i] === "--from" && args[i + 1]) {
      result.from = args[++i] as Step;
    } else if (args[i] === "--top" && args[i + 1]) {
      result.top = parseInt(args[++i], 10);
    } else if (args[i] === "--dry-run") {
      result.dryRun = true;
    } else if (args[i] === "--skip-notebooklm") {
      result.skipNotebookLM = true;
    } else if (args[i] === "--use-gpt55") {
      result.useGpt55 = true;
    } else if (args[i] === "--interactive-trim") {
      result.interactiveTrim = true;
    } else if (args[i] === "--skip-review") {
      result.skipReview = true;
    } else if (args[i] === "--warn-only-gates") {
      result.warnOnlyGates = true;
    } else if (args[i] === "--prepare-upload-package") {
      result.prepareUploadPackage = true;
    } else if (args[i] === "--allow-scorer-only") {
      result.allowScorerOnly = true;
    } else if (args[i] === "--allow-no-qa") {
      result.allowNoQa = true;
    }
  }

  return result;
}

function run(cmd: string, label: string, retries = 2): void {
  const record: RunRecord = {
    label,
    command: cmd,
    startedAt: new Date().toISOString(),
    attempts: 0,
    status: "failed",
  };
  runRecords.push(record);

  const maxAttempts = retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    record.attempts = attempt;
    log.info(`\n${"=".repeat(60)}`);
    log.info(`  STEP: ${label}${maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : ""}`);
    log.info(`${"=".repeat(60)}\n`);
    log.info(`> ${cmd}\n`);

    try {
      execSync(cmd, {
        stdio: "inherit",
        timeout: 7_200_000, // 2 hour max per step
        cwd: process.cwd(),
      });
      record.status = "success";
      record.endedAt = new Date().toISOString();
      delete record.error;
      return;
    } catch (err: any) {
      record.error = err.message ?? String(err);
      record.endedAt = new Date().toISOString();
      if (attempt < maxAttempts) {
        warn(`Step "${label}" failed on attempt ${attempt}/${maxAttempts}; retrying.`);
      } else {
        log.error(`Step "${label}" failed: ${record.error}`);
        throw err;
      }
    }
  }
}

function writeRunReport(streamId: string | undefined, status: "complete" | "failed", error?: unknown): void {
  if (!streamId) return;
  const dir = findStreamDir(streamId);
  if (!dir) return;

  const reviewDir = join(dir, "review");
  const reviewReportPath = join(reviewDir, "run-report.json");
  let reviewPackage: unknown = undefined;
  if (existsSync(reviewReportPath)) {
    try {
      reviewPackage = JSON.parse(readFileSync(reviewReportPath, "utf-8"));
    } catch {
      reviewPackage = undefined;
    }
  }

  const payload = {
    streamId,
    status,
    startedAt: runStartedAt,
    endedAt: new Date().toISOString(),
    warnings: runWarnings,
    steps: runRecords,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
    reviewPackage,
  };

  writeFileSync(join(dir, "run-report.json"), JSON.stringify(payload, null, 2), "utf-8");
  if (existsSync(reviewDir)) {
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(reviewReportPath, JSON.stringify(payload, null, 2), "utf-8");
  }
}

function getStartStep(args: OrchestrateArgs): Step {
  if (args.from) return args.from;

  // If we have a stream ID, check its current phase
  if (args.streamId) {
    const dir = findStreamDir(args.streamId);
    if (dir) {
      try {
        const manifest = loadManifest(args.streamId);
        if (manifest.phase === "uploaded") {
          return "upload";
        }
        if (manifest.phase === "rendered") {
          return "review";
        }
        if (manifest.phase === "clipped") {
          return "story-gate";
        }
        if (manifest.phase === "notebooklm-reviewed") {
          return "pick-quality";
        }
        if (manifest.phase === "analyzed") {
          return "notebooklm-review";
        }
        if (manifest.phase === "downloaded") {
          return "analyze";
        }
      } catch {
        // manifest not loadable, start from discover
      }
    }
  }

  return "discover";
}

function shouldRun(startIdx: number, step: Step): boolean {
  return startIdx <= STEPS.indexOf(step);
}

function hasTranscriptReviewArtifact(streamId: string): boolean {
  const dir = findStreamDir(streamId);
  if (!dir) return false;
  for (const file of ["notebooklm-moments.json", "unified-moments.json"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (Array.isArray(parsed) && parsed.length > 0) return true;
    } catch {
      // Ignore malformed enrichment artifacts; downstream can fall back to scorer moments.
    }
  }
  return false;
}

function bypassReason(flag: string, dryRun: boolean): string {
  return dryRun ? "dry-run" : flag;
}

function extractVideoId(url: string): string | undefined {
  return url.match(/(?:[?&]v=|youtu\.be\/|youtube\.com\/live\/)([A-Za-z0-9_-]{11})/)?.[1];
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const startStep = getStartStep(args);
  const startIdx = STEPS.indexOf(startStep);

  log.info("Pipeline orchestrator starting");
  log.info(`  Stream: ${args.streamId || args.url || "latest"}`);
  log.info(`  Starting from: ${startStep}`);
  log.info(`  Top clips: ${args.top}`);
  log.info(`  Dry run: ${args.dryRun}`);
  if (args.useGpt55) log.info("  Using GPT-5.5 for transcript review");

  const tsx = "npx tsx";
  const base = "packages/clips/src";

  // Step 1: Discover (download stream)
  if (shouldRun(startIdx, "discover")) {
    const discoverArgs = args.url
      ? `--url ${shellArg(args.url)}`
      : args.streamId
        ? `--url https://youtube.com/watch?v=${args.streamId}`
        : "";

    const cmd = `${tsx} ${base}/discover.ts ${discoverArgs}`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${cmd}`);
    } else {
      run(cmd, "Download stream");
    }
  }

  // We need a stream ID for remaining steps. When launched with --url the
  // ID is right there in the query string; extract it so the rest of the
  // pipeline doesn't need an explicit --stream.
  let streamId = args.streamId;
  if (!streamId && args.url) {
    streamId = extractVideoId(args.url);
  }
  if (!streamId && !args.dryRun) {
    log.error("Could not resolve stream ID. Pass --stream <id> explicitly or use a YouTube watch/live/short URL.");
    process.exit(1);
  }
  activeStreamId = streamId;

  if (streamId && !args.dryRun && shouldRun(startIdx, "analyze")) {
    run(`${tsx} ${base}/preflight.ts --stream ${streamId} --stage analysis --warn-only`, "Preflight source assets");
  }

  // Step 2: Analyze (detect viral moments)
  if (shouldRun(startIdx, "analyze") && streamId) {
    const cmd = `${tsx} ${base}/analyze.ts --stream ${streamId} --top ${args.top}`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${cmd}`);
    } else {
      run(cmd, "Analyze & detect moments");
    }
  }

  // Step 3: Transcript review — GPT-5.5 (preferred) or NotebookLM (fallback)
  if (shouldRun(startIdx, "notebooklm-review") && streamId) {
    let reviewed = hasTranscriptReviewArtifact(streamId);

    if (args.skipNotebookLM) {
      if (reviewed) {
        log.info("Skipping transcript review (--skip-notebooklm); existing transcript review artifact found.");
      } else {
        const message = "Transcript review skipped (--skip-notebooklm), so picks would be scorer-only";
        if (blocksMissingTranscriptReview({ reviewed, dryRun: args.dryRun, allowScorerOnly: args.allowScorerOnly })) {
          throw new Error(`${message}. Pass --allow-scorer-only to bypass this production gate.`);
        }
        warn(`${message}; continuing because ${bypassReason("--allow-scorer-only", args.dryRun)} is active.`);
      }
    } else {
      if (process.env.OPENAI_API_KEY) {
        const gptCmd = `${tsx} ${base}/gpt55-review.ts --stream ${streamId} --top ${args.top}`;
        if (args.dryRun) {
          log.info(`[DRY RUN] Would run: ${gptCmd}`);
          reviewed = true;
        } else {
          try {
            run(gptCmd, "GPT-5.5 transcript review (humor, running bits, enrichment)");
            reviewed = hasTranscriptReviewArtifact(streamId);
          } catch (e) {
            warn(`GPT-5.5 review failed: ${(e as Error).message}. Falling back to NotebookLM/scorer picks.`);
          }
        }
      } else if (args.useGpt55) {
        warn("--use-gpt55 requested but OPENAI_API_KEY is not set for the repo client; falling back to NotebookLM/scorer picks.");
      }

      if (!reviewed && process.env.OPENROUTER_API_KEY) {
        const routerCmd = `${tsx} ${base}/gemini-review.ts --stream ${streamId} --top ${args.top}`;
        if (args.dryRun) {
          log.info(`[DRY RUN] Would run: ${routerCmd}`);
          reviewed = true;
        } else {
          try {
            run(routerCmd, "OpenRouter transcript review");
            reviewed = hasTranscriptReviewArtifact(streamId);
          } catch (e) {
            warn(`OpenRouter review failed: ${(e as Error).message}. Falling back to NotebookLM/scorer picks.`);
          }
        }
      }

      if (!reviewed && isNlmAvailable()) {
        const nlmCmd = `${tsx} ${base}/notebooklm-review.ts --stream ${streamId} --top ${args.top}`;
        if (args.dryRun) {
          log.info(`[DRY RUN] Would run: ${nlmCmd}`);
          reviewed = true;
        } else {
          try {
            run(nlmCmd, "NotebookLM review (humor, running bits, enrichment)");
            reviewed = hasTranscriptReviewArtifact(streamId);
          } catch (e) {
            warn(`NotebookLM review failed: ${(e as Error).message}. Continuing only if scorer-only bypass is active.`);
          }
        }
      }

      if (blocksMissingTranscriptReview({ reviewed, dryRun: args.dryRun, allowScorerOnly: args.allowScorerOnly })) {
        throw new Error("No transcript review available (set OPENAI_API_KEY for GPT-5.5 or install nlm CLI for NotebookLM). Pass --allow-scorer-only to bypass this production gate.");
      }
      if (!reviewed) {
        warn(`No transcript review available; continuing because ${bypassReason("--allow-scorer-only", args.dryRun)} is active.`);
      }
    }
  }

  // Shadow-run the autonomous ranker until its 2-VOD Precision@5 gate passes;
  // after that it promotes only the learned top three.
  if (shouldRun(startIdx, "notebooklm-review") && streamId) {
    const rankerCmd = "python scripts/autonomous-ranker.py run";
    if (args.dryRun) log.info(`[DRY RUN] Would run: ${rankerCmd}`);
    else {
      try {
        run(rankerCmd, "Autonomous signal enrichment and ranking");
      } catch (e) {
        warn(`Autonomous ranker stayed in shadow mode: ${(e as Error).message}`);
      }
    }
  }

  // Step 4: Pick-quality pass - normalize setup/payoff and mark suggested clip.
  if (shouldRun(startIdx, "pick-quality") && streamId) {
    const qualityCmd = `${tsx} ${base}/pick-quality.ts --stream ${streamId}`;
    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${qualityCmd}`);
    } else {
      run(qualityCmd, "Pick-quality pass (setup, payoff, suggested/reserve)");
    }
  }

  // Step 5: Clip trimming - default is automated; --interactive-trim opens the browser.
  if (shouldRun(startIdx, "trim") && streamId) {
    if (args.interactiveTrim) {
      const trimCmd = `${tsx} ${base}/trim.ts --stream ${streamId}`;
      if (args.dryRun) {
        log.info(`[DRY RUN] Would run: ${trimCmd}`);
        log.info(`[DRY RUN] Open http://localhost:3900 to trim clips`);
      } else {
        run(trimCmd, "Interactive clip trimming (opens browser)");
      }
    } else {
      const trimCmd = `${tsx} ${base}/trim.ts --stream ${streamId} --auto`;
      if (args.dryRun) {
        log.info(`[DRY RUN] Would run: ${trimCmd}`);
      } else {
        run(trimCmd, "Auto-trim clips (whisper + audio peaks, no browser)");
      }
    }
  }

  // Step 6: Story completeness gate - blocks risky clips before render.
  if (shouldRun(startIdx, "story-gate") && streamId) {
    const gateCmd = `${tsx} ${base}/story-gate.ts --stream ${streamId}${args.warnOnlyGates ? " --warn-only" : ""}`;
    const preflightCmd = `${tsx} ${base}/preflight.ts --stream ${streamId} --stage pre-render${args.warnOnlyGates ? " --warn-only" : ""}`;
    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${gateCmd}`);
      log.info(`[DRY RUN] Would run: ${preflightCmd}`);
    } else {
      run(gateCmd, "Story completeness gate");
      run(preflightCmd, "Pre-render preflight");
    }
  }

  // Step 7: Whisper caption generation (transcribe raw clips for accurate word timing)
  if (shouldRun(startIdx, "whisper-captions") && streamId) {
    if (args.dryRun) {
      log.info(`[DRY RUN] Would transcribe raw clips with faster-whisper`);
    } else {
      const { findStreamDir: findDir } = await import("./lib/manifest.js");
      const dir = findDir(streamId);
      if (dir) {
        const rawClipsDir = join(dir, "raw-clips");
        const whisperDir = join(dir, "whisper-captions");
        if (existsSync(rawClipsDir)) {
          log.info(`\n${"=".repeat(60)}`);
          log.info(`  STEP: Whisper caption generation`);
          log.info(`${"=".repeat(60)}\n`);
          transcribeAllClips(rawClipsDir, whisperDir);
        } else {
          warn("No raw-clips/ directory found — skipping Whisper transcription");
        }
      }
    }
  }

  // Step 8: Render (produce 9:16 shorts)
  if (shouldRun(startIdx, "render") && streamId) {
    const renderCmd = `${tsx} ${base}/render-fast.ts --stream ${streamId} --all`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${renderCmd}`);
    } else {
      run(renderCmd, "Render 9:16 shorts");
    }
  }

  // Step 9: Gemini QA review + auto-fix for NEEDS_TRIM clips.
  if (shouldRun(startIdx, "review") && streamId) {
    if (args.skipReview) {
      const message = "Gemini QA skipped (--skip-review), so rendered shorts are unreviewed";
      if (blocksMissingQaReview({ qaAvailable: false, dryRun: args.dryRun, allowNoQa: args.allowNoQa })) {
        throw new Error(`${message}. Pass --allow-no-qa to bypass this production gate.`);
      }
      warn(`${message}; continuing because ${bypassReason("--allow-no-qa", args.dryRun)} is active.`);
    } else if (!process.env.GEMINI_API_KEY) {
      const message = "GEMINI_API_KEY not set — Gemini QA unavailable";
      if (blocksMissingQaReview({ qaAvailable: false, dryRun: args.dryRun, allowNoQa: args.allowNoQa })) {
        throw new Error(`${message}. Pass --allow-no-qa to bypass this production gate.`);
      }
      warn(`${message}; continuing because ${bypassReason("--allow-no-qa", args.dryRun)} is active.`);
    } else {
      const reviewCmd = `${tsx} ${base}/review.ts --stream ${streamId}`;
      if (args.dryRun) {
        log.info(`[DRY RUN] Would run: ${reviewCmd}`);
      } else {
        try {
          run(reviewCmd, "Gemini QA review + auto-fix");

          const dir = findStreamDir(streamId);
          const reviewsPath = dir ? join(dir, "gemini-reviews.json") : "";
          const qaAvailable = !!dir && existsSync(reviewsPath);
          if (blocksMissingQaReview({ qaAvailable, dryRun: args.dryRun, allowNoQa: args.allowNoQa })) {
            throw new Error("Gemini review ran but gemini-reviews.json was not produced. Pass --allow-no-qa to bypass this production gate.");
          }
          if (qaAvailable) {
            const reviews = JSON.parse(readFileSync(reviewsPath, "utf-8")) as Array<{ overall_verdict?: string; clip?: string }>;
            const weak = reviews.filter((r) => r.overall_verdict === "SKIP" || r.overall_verdict === "NEEDS_RECUT");
            if (weak.length > 0) {
              warn(`Review flagged ${weak.length} weak clip(s) for replacement or manual re-pick: ${weak.map((r) => r.clip).join(", ")}`);
            }
          } else {
            warn(`Gemini review output missing; continuing because ${bypassReason("--allow-no-qa", args.dryRun)} is active.`);
          }
        } catch (e) {
          log.error(`Review step failed: ${(e as Error).message}. Blocking downstream steps.`);
          throw e;
        }
      }
    }
  }

  if (streamId && !args.dryRun && shouldRun(startIdx, "thumbnails")) {
    run(`${tsx} ${base}/preflight.ts --stream ${streamId} --stage pre-upload${args.warnOnlyGates ? " --warn-only" : ""}`, "Pre-upload QA gate");
  }

  // Step 10: Generate thumbnails (YT + TikTok variants per clip).
  if (shouldRun(startIdx, "thumbnails") && streamId) {
    const thumbsCmd = `${tsx} ${base}/generate-thumbnails.ts --stream ${streamId}`;
    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${thumbsCmd}`);
    } else {
      try {
        run(thumbsCmd, "Generate YT + TikTok thumbnails");
      } catch (e) {
        warn(`Thumbnail generation failed: ${(e as Error).message}. Continuing.`);
      }
    }
  }

  // Step 11: Generate AI upload metadata (titles, descriptions, tags, captions)
  if (shouldRun(startIdx, "generate-metadata") && streamId) {
    const metaCmd = `${tsx} ${base}/generate-metadata.ts --stream ${streamId}`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${metaCmd}`);
    } else {
      try {
        run(metaCmd, "Generate upload metadata (Claude AI)");
      } catch (e) {
        warn(
          `Metadata generation failed: ${(e as Error).message}. Upload.ts will error if upload-metadata.md is missing.`,
        );
      }
    }
  }

  // Step 12: Prepare local private review folder.
  if (shouldRun(startIdx, "review-package") && streamId) {
    const packageCmd = `${tsx} ${base}/prepare-review.ts --stream ${streamId}`;
    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${packageCmd}`);
    } else {
      run(packageCmd, "Prepare local review folder");
    }
  }

  // Step 13: Prepare manual upload packages only when explicitly requested.
  if (shouldRun(startIdx, "upload") && streamId) {
    const uploadCmd = `${tsx} ${base}/upload.ts --stream ${streamId}`;

    if (!args.prepareUploadPackage) {
      log.info("Skipping upload package generation by default. Pass --prepare-upload-package after Justin approves packaging.");
    } else if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${uploadCmd}`);
    } else {
      run(uploadCmd, "Generate manual upload packages for YouTube, TikTok, Instagram");
    }
  }

  // Step 14: Feedback loop - ingest YouTube Analytics and update weights
  if (streamId && !args.dryRun) {
    try {
      const feedbackCmd = `${tsx} ${base}/analytics.ts --feedback --since 14`;
      log.info(`\n${"=".repeat(60)}`);
      log.info("  STEP: Feedback loop (YouTube Analytics → weight updates)");
      log.info(`${"=".repeat(60)}\n`);
      execSync(feedbackCmd, { stdio: "inherit", timeout: 120000, cwd: process.cwd() });
    } catch (e) {
      warn(`Feedback step failed: ${(e as Error).message}. Weights not updated.`);
    }
  }

  log.info("\n" + "=".repeat(60));
  log.info("  PIPELINE COMPLETE");
  log.info("=".repeat(60));

  if (streamId && !args.dryRun) {
    try {
      const manifest = loadManifest(streamId);
      log.info(`  Job dir: ${manifest.jobDir}`);
      log.info(`  Phase: ${manifest.phase}`);
    } catch {
      // ignore
    }
  }

  if (streamId && !args.dryRun) {
    writeRunReport(streamId, "complete");
  }

  log.info("\nNext: review shorts in each platform, then set to public.");
}

if (process.argv[1]?.endsWith("orchestrate.ts") || process.argv[1]?.endsWith("orchestrate.js")) {
  main().catch((err) => {
    writeRunReport(activeStreamId, "failed", err);
    log.error("Pipeline failed:", err.message ?? err);
    process.exit(1);
  });
}
