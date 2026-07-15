/** Prepare gameplay review videos and unverified visual-proof templates. */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@ltx/shared";
import { loadRecallCandidates } from "./ground-candidates.js";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import {
  prepareVisualProofReviewPack,
  visualProofReviewPlanMatches,
  type VisualProofReviewPlan,
} from "./lib/visual-proof-review.js";

const log = createLogger("prepare-visual-proofs");

interface CliArgs {
  streamId: string;
  outputDir?: string;
  force: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let streamId = "";
  let outputDir: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--stream" && args[index + 1]) streamId = args[++index];
    else if (args[index] === "--output" && args[index + 1]) outputDir = resolve(args[++index]);
    else if (args[index] === "--force") force = true;
  }
  if (!streamId) {
    throw new Error("Usage: prepare-visual-proofs.ts --stream <id> [--output <dir>] [--force]");
  }
  return { streamId, outputDir, force };
}

function main(): void {
  const args = parseArgs();
  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) throw new Error(`No job directory found for stream ${args.streamId}`);
  const manifest = loadManifest(args.streamId);
  const jobId = basename(manifest.jobDir);
  const recall = loadRecallCandidates(streamDir, jobId);
  const candidates = recall.map((candidate) => ({
    candidateId: candidate.candidateId,
    jobId: candidate.jobId,
    momentId: candidate.momentId,
    startSec: candidate.startSec,
    endSec: candidate.endSec,
    description: candidate.description ?? "",
    categories: candidate.categories ?? [],
    recallRoutes: candidate.recallRoutes ?? [],
  }));
  const outputDir = args.outputDir ?? join(streamDir, "visual-proof-review");
  const planPath = join(outputDir, "review-plan.json");
  let force = args.force;
  if (!force && existsSync(planPath)) {
    const existing = JSON.parse(readFileSync(planPath, "utf-8")) as VisualProofReviewPlan;
    if (
      visualProofReviewPlanMatches(existing, candidates, outputDir)
      && existing.items.every((item) => existsSync(item.previewVideoPath))
    ) {
      log.info(`Visual review pack is current: ${planPath}`);
      return;
    }
    force = true;
  }
  const prepared = prepareVisualProofReviewPack({
    videoPath: manifest.videoPath,
    candidates,
    outputDir,
    force,
  });

  log.info(`Prepared ${prepared.plan.items.length} gameplay review candidates`);
  log.info(`Review page: ${prepared.reviewHtmlPath}`);
  log.info(`Review plan: ${prepared.planPath}`);
  log.info(`Unverified template: ${prepared.templatePath}`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("prepare-visual-proofs.ts") || process.argv[1]?.endsWith("prepare-visual-proofs.js")) {
  try {
    main();
  } catch (error) {
    log.error((error as Error).message);
    process.exit(1);
  }
}
