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
import { createLogger } from "@ltx/shared";
import { findStreamDir, loadManifest } from "./lib/manifest.js";

const log = createLogger("orchestrate");

const STEPS = ["discover", "analyze", "render", "upload"] as const;
type Step = (typeof STEPS)[number];

interface OrchestrateArgs {
  url?: string;
  streamId?: string;
  from?: Step;
  top: number;
  dryRun: boolean;
}

function parseArgs(): OrchestrateArgs {
  const args = process.argv.slice(2);
  const result: OrchestrateArgs = { top: 10, dryRun: false };

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
          return "upload"; // Already done, but re-run is safe
        }
        if (manifest.phase === "analyzed" || manifest.phase === "clipped") {
          return "render";
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

  // We need a stream ID for remaining steps
  let streamId = args.streamId;
  if (!streamId && !args.dryRun) {
    // Try to find the most recently created manifest
    log.error("--stream <id> required for analyze/render steps when not starting from discover");
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

  // Step 3: Render (produce 9:16 shorts)
  if (startIdx <= 2 && streamId) {
    // First extract raw clips
    const clipRange = Array.from({ length: args.top }, (_, i) => i + 1).join(",");
    const clipCmd = `${tsx} ${base}/clip.ts --stream ${streamId} --moments ${clipRange}`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${clipCmd}`);
    } else {
      run(clipCmd, "Extract raw clips");
    }

    // Then render 9:16 shorts
    const renderCmd = `${tsx} ${base}/render-fast.ts --stream ${streamId} --all`;

    if (args.dryRun) {
      log.info(`[DRY RUN] Would run: ${renderCmd}`);
    } else {
      run(renderCmd, "Render 9:16 shorts");
    }
  }

  // Step 4: Generate manual upload packages for all platforms
  if (startIdx <= 3 && streamId) {
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
