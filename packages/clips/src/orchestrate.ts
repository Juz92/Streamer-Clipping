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

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { createLogger } from "@ltx/shared";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import { isNlmAvailable } from "./lib/notebooklm-client.js";
import { transcribeAllClips } from "./lib/whisper-captions.js";

const log = createLogger("orchestrate");

const STEPS = ["discover", "analyze", "notebooklm-review", "trim", "whisper-captions", "render", "review", "thumbnails", "generate-metadata", "upload"] as const;
type Step = (typeof STEPS)[number];

interface OrchestrateArgs {
  url?: string;
  streamId?: string;
  from?: Step;
  top: number;
  dryRun: boolean;
  skipNotebookLM: boolean;
  interactiveTrim: boolean;
  skipReview: boolean;
}

function parseArgs(): OrchestrateArgs {
  const args = process.argv.slice(2);
  const result: OrchestrateArgs = {
    top: 15,
    dryRun: false,
    skipNotebookLM: false,
    interactiveTrim: false,
    skipReview: false,
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
    } else if (args[i] === "--interactive-trim") {
      result.interactiveTrim = true;
    } else if (args[i] === "--skip-review") {
      result.skipReview = true;
    }
  }

  return result;
}

function run(cmd: string, label: string): void {
  log.info(`\n${"=".repeat(60)}`);
  log.info(`  STEP: ${label}`);
  log.info(`${"=".repeat(60)}\n`);
  log.info(`> ${cmd}\n`);

  try {
    execSync(cmd, {
      stdio: "inherit",
      timeout: 7_200_000, // 2 hour max per step
      cwd: "C:/peanut",
    });
  } catch (err: any) {
    log.error(`Step "${label}" failed: ${err.message}`);
    throw err;
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
          return "whisper-captions";
        }
        if (manifest.phase === "notebooklm-reviewed") {
          return "trim";
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

async function main(): Promise<void> {
  const args = parseArgs();
  const startStep = getStartStep(args);
  const startIdx = STEPS.indexOf(startStep);

  log.info("Pipeline orchestrator starting");
  log.info(`  Stream: ${args.streamId || args.url || "latest"}`);
  log.info(`  Starting from: ${startStep}`);
  log.info(`  Top clips: ${args.top}`);
  log.info(`  Dry run: ${args.dryRun}`);

  const tsx = "npx tsx";
  const base = "packages/clips/src";

  // Step 1: Discover (download stream)
  if (startIdx <= 0) {
    const discoverArgs = args.url
      ? `--url ${args.url}`
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
    const m = args.url.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (m) streamId = m[1];
  }
  if (!streamId && !args.dryRun) {
    log.error("Could not resolve stream ID. Pass --stream <id> explicitly or use a --url that contains ?v=<id>");
    process.exit(1);
  }

  // Step 2: Analyze (detect viral moments)
  if (startIdx <= 1 && streamId) {
    const cmd = `${tsx} ${base}/analyze.ts --stream ${streamId} --top ${args.top}`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${cmd}`);
    } else {
      run(cmd, "Analyze & detect moments");
    }
  }

  // Step 3: NotebookLM review (extract, score, enrich picks from transcript)
  if (startIdx <= 2 && streamId) {
    if (args.skipNotebookLM) {
      log.info("Skipping NotebookLM review (--skip-notebooklm)");
    } else if (!isNlmAvailable()) {
      log.warn("nlm CLI not available on PATH — skipping NotebookLM review");
    } else {
      const nlmCmd = `${tsx} ${base}/notebooklm-review.ts --stream ${streamId} --top ${args.top}`;

      if (args.dryRun) {
        log.info(`[DRY RUN] Would run: ${nlmCmd}`);
      } else {
        try {
          run(nlmCmd, "NotebookLM review (humor, running bits, enrichment)");
        } catch (e) {
          log.warn(
            `NotebookLM review failed: ${(e as Error).message}. Continuing with scorer-only picks.`,
          );
        }
      }
    }
  }

  // Step 4: Clip trimming — default is automated; --interactive-trim opens the browser.
  if (startIdx <= 3 && streamId) {
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

  // Step 5: Whisper caption generation (transcribe raw clips for accurate word timing)
  if (startIdx <= 4 && streamId) {
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
          log.warn("No raw-clips/ directory found — skipping Whisper transcription");
        }
      }
    }
  }

  // Step 6: Render (produce 9:16 shorts)
  if (startIdx <= 5 && streamId) {
    const renderCmd = `${tsx} ${base}/render-fast.ts --stream ${streamId} --all`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${renderCmd}`);
    } else {
      run(renderCmd, "Render 9:16 shorts");
    }
  }

  // Step 7: Gemini QA review + auto-fix for NEEDS_TRIM clips.
  if (startIdx <= 6 && streamId) {
    if (args.skipReview) {
      log.info("Skipping Gemini review (--skip-review)");
    } else if (!process.env.GEMINI_API_KEY) {
      log.warn("GEMINI_API_KEY not set — skipping Gemini review step");
    } else {
      const reviewCmd = `${tsx} ${base}/review.ts --stream ${streamId}`;
      if (args.dryRun) {
        log.info(`[DRY RUN] Would run: ${reviewCmd}`);
      } else {
        try {
          run(reviewCmd, "Gemini QA review + auto-fix");
        } catch (e) {
          log.warn(`Review step failed: ${(e as Error).message}. Continuing.`);
        }
      }
    }
  }

  // Step 8: Generate thumbnails (YT + TikTok variants per clip).
  if (startIdx <= 7 && streamId) {
    const thumbsCmd = `${tsx} ${base}/generate-thumbnails.ts --stream ${streamId}`;
    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${thumbsCmd}`);
    } else {
      try {
        run(thumbsCmd, "Generate YT + TikTok thumbnails");
      } catch (e) {
        log.warn(`Thumbnail generation failed: ${(e as Error).message}. Continuing.`);
      }
    }
  }

  // Step 9: Generate AI upload metadata (titles, descriptions, tags, captions)
  if (startIdx <= 8 && streamId) {
    const metaCmd = `${tsx} ${base}/generate-metadata.ts --stream ${streamId}`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${metaCmd}`);
    } else {
      try {
        run(metaCmd, "Generate upload metadata (Claude AI)");
      } catch (e) {
        log.warn(
          `Metadata generation failed: ${(e as Error).message}. Upload.ts will error if upload-metadata.md is missing.`,
        );
      }
    }
  }

  // Step 10: Generate manual upload packages for all platforms
  if (startIdx <= 9 && streamId) {
    const uploadCmd = `${tsx} ${base}/upload.ts --stream ${streamId}`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${uploadCmd}`);
    } else {
      run(uploadCmd, "Generate upload packages for YouTube, TikTok, Instagram");
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

  log.info("\nNext: review shorts in each platform, then set to public.");
}

main().catch((err) => {
  log.error("Pipeline failed:", err.message ?? err);
  process.exit(1);
});
