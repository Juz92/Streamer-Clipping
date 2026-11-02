/**
 * preflight.ts — deterministic pipeline readiness checks before expensive stages.
 *
 * Usage:
 *   npx tsx packages/clips/src/preflight.ts --stream <id> --stage analysis
 *   npx tsx packages/clips/src/preflight.ts --stream <id> --stage pre-render
 *   npx tsx packages/clips/src/preflight.ts --stream <id> --stage pre-upload
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, isAbsolute } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { createLogger } from "@ltx/shared";
import { findStreamDir, loadManifest } from "./lib/manifest.js";
import { evaluateRenderedShorts, type RenderedShortProbe } from "./quality-gates.js";
export { evaluateRenderedShorts, type RenderedShortProbe } from "./quality-gates.js";

const log = createLogger("preflight");

type Stage = "analysis" | "transcript-review" | "pre-render" | "pre-upload";
type Severity = "PASS" | "WARN" | "BLOCK";

interface CheckResult {
  name: string;
  severity: Severity;
  message: string;
}

function probeRenderedShort(path: string, file: string): RenderedShortProbe {
  const raw = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height:format=duration",
    "-of", "json",
    path,
  ], { encoding: "utf-8" });
  const parsed = JSON.parse(raw) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  return {
    file,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationSec: Number(parsed.format?.duration ?? 0),
    hasAudio: !!parsed.streams?.some((stream) => stream.codec_type === "audio"),
  };
}

function parseArgs(): { streamId?: string; stage: Stage; warnOnly: boolean } {
  const args = process.argv.slice(2);
  const out: { streamId?: string; stage: Stage; warnOnly: boolean } = {
    stage: "pre-render",
    warnOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) out.streamId = args[++i];
    else if (args[i] === "--stage" && args[i + 1]) out.stage = args[++i] as Stage;
    else if (args[i] === "--warn-only") out.warnOnly = true;
  }
  return out;
}

function checkFile(name: string, rawPath: string | null | undefined, required: boolean, baseDir?: string): CheckResult {
  let path = rawPath;
  if (path && baseDir && !isAbsolute(path)) {
    path = join(baseDir, path);
  }
  if (!path) {
    return {
      name,
      severity: required ? "BLOCK" : "WARN",
      message: required ? "missing path in manifest" : "path not present; fallback quality may be lower",
    };
  }
  if (!existsSync(path)) {
    return {
      name,
      severity: required ? "BLOCK" : "WARN",
      message: `${path} does not exist`,
    };
  }
  const size = statSync(path).size;
  if (size === 0) {
    return { name, severity: required ? "BLOCK" : "WARN", message: `${path} is empty` };
  }
  return { name, severity: "PASS", message: `${path} (${(size / 1024 / 1024).toFixed(1)} MB)` };
}

function fileCount(dir: string, predicate: (name: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(predicate).length;
}

function countCaptionChunkFailures(shortsDir: string): { files: number; failures: number } {
  if (!existsSync(shortsDir)) return { files: 0, failures: 0 };
  const assFiles = readdirSync(shortsDir).filter((f) => f.endsWith(".ass"));
  let failures = 0;
  for (const file of assFiles) {
    const content = readFileSync(join(shortsDir, file), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const text = line.split(",").slice(9).join(",");
      const visibleWords = text
        .replace(/\{[^}]*\}/g, " ")
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean);
      if (visibleWords.length > 3) failures++;
    }
  }
  return { files: assFiles.length, failures };
}

function checkUploadMetadata(streamDir: string): CheckResult[] {
  const mdPath = join(streamDir, "upload-metadata.md");
  const jsonPath = join(streamDir, "upload-metadata.json");
  const checks: CheckResult[] = [];

  checks.push({
    name: "upload-metadata.md",
    severity: existsSync(mdPath) ? "PASS" : "BLOCK",
    message: existsSync(mdPath) ? mdPath : "upload-metadata.md missing",
  });

  if (!existsSync(jsonPath)) {
    checks.push({ name: "upload-metadata.json", severity: "BLOCK", message: "upload-metadata.json missing" });
    return checks;
  }

  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as { items?: Array<{ frame0Hook?: string; ytTitle?: string; ytTags?: unknown[]; pinnedComment?: string }> };
    const items = parsed.items ?? [];
    const missingFrame0 = items.filter((item) => !item.frame0Hook?.trim()).length;
    const missingTitle = items.filter((item) => !item.ytTitle?.trim()).length;
    const missingTags = items.filter((item) => !Array.isArray(item.ytTags) || item.ytTags.length === 0).length;
    const missingPinned = items.filter((item) => !item.pinnedComment?.trim()).length;
    const bad = missingFrame0 + missingTitle + missingTags + missingPinned;
    checks.push({
      name: "upload-metadata.json",
      severity: items.length > 0 && bad === 0 ? "PASS" : "BLOCK",
      message: items.length > 0
        ? `${items.length} item(s); missing frame0/title/tags/pinned = ${missingFrame0}/${missingTitle}/${missingTags}/${missingPinned}`
        : "no items[] in upload-metadata.json",
    });
  } catch (err) {
    checks.push({ name: "upload-metadata.json", severity: "BLOCK", message: `invalid JSON: ${(err as Error).message}` });
  }

  return checks;
}

function main(): void {
  const args = parseArgs();
  if (!args.streamId) {
    log.error("Usage: preflight.ts --stream <id> [--stage analysis|transcript-review|pre-render|pre-upload] [--warn-only]");
    process.exit(1);
  }

  const streamDir = findStreamDir(args.streamId);
  if (!streamDir) {
    log.error(`No stream directory found for ${args.streamId}`);
    process.exit(1);
  }

  const manifest = loadManifest(args.streamId);
  const checks: CheckResult[] = [];

  checks.push(checkFile("manifest.videoPath", manifest.videoPath, true, streamDir));
  checks.push(checkFile("manifest.subtitlePath", manifest.subtitlePath, args.stage !== "analysis", streamDir));
  // Chat is required where it is actually read: the analysis stage runs the
  // chat-reaction recall route. Elsewhere its absence is only a warning.
  checks.push(checkFile("manifest.chatPath", manifest.chatPath, args.stage === "analysis", streamDir));
  checks.push(checkFile("manifest.audioLevelsPath", manifest.audioLevelsPath, false, streamDir));

  if (["transcript-review", "pre-render", "pre-upload"].includes(args.stage)) {
    const unified = join(streamDir, "unified-moments.json");
    const notebook = join(streamDir, "notebooklm-moments.json");
    const scorer = join(streamDir, "moments.json");
    checks.push({
      name: "moments",
      severity: existsSync(notebook) || existsSync(unified) || existsSync(scorer) ? "PASS" : "BLOCK",
      message: existsSync(notebook)
        ? notebook
        : existsSync(unified)
          ? unified
          : existsSync(scorer)
            ? `${scorer} (scorer-only)`
            : "no notebooklm-moments.json, unified-moments.json, or moments.json",
    });
  }

  if (["pre-render", "pre-upload"].includes(args.stage)) {
    const trimPath = join(streamDir, "trim-results.json");
    if (!existsSync(trimPath)) {
      checks.push({ name: "trim-results", severity: "BLOCK", message: "trim-results.json missing" });
    } else {
      const trim = JSON.parse(readFileSync(trimPath, "utf-8")) as { approved?: unknown[]; totalClips?: number };
      const approved = trim.approved?.length ?? 0;
      checks.push({
        name: "trim-results",
        severity: approved > 0 ? "PASS" : "BLOCK",
        message: `${approved}/${trim.totalClips ?? "?"} approved clips`,
      });
    }

    const rawCount = fileCount(join(streamDir, "raw-clips"), (f) => f.endsWith(".mp4"));
    checks.push({
      name: "raw-clips",
      severity: rawCount > 0 ? "PASS" : "BLOCK",
      message: `${rawCount} mp4 file(s)`,
    });
  }

  if (args.stage === "pre-upload") {
    const shortsDir = join(streamDir, "shorts");
    const shortFiles = existsSync(shortsDir) ? readdirSync(shortsDir).filter((f) => f.endsWith(".mp4")).sort() : [];
    const shortsCount = shortFiles.length;
    checks.push({
      name: "shorts",
      severity: shortsCount > 0 ? "PASS" : "BLOCK",
      message: `${shortsCount} rendered short(s)`,
    });

    if (shortFiles.length > 0) {
      try {
        const qa = evaluateRenderedShorts(shortFiles.map((file) => probeRenderedShort(join(shortsDir, file), file)));
        checks.push({ name: "rendered-short-qa", severity: qa.bad === 0 ? "PASS" : "BLOCK", message: qa.message });
      } catch (err) {
        checks.push({ name: "rendered-short-qa", severity: "BLOCK", message: `ffprobe failed: ${(err as Error).message}` });
      }
    }

    checks.push(...checkUploadMetadata(streamDir));

    const captionQa = countCaptionChunkFailures(shortsDir);
    checks.push({
      name: "caption-chunks",
      severity: captionQa.files === 0 ? "WARN" : captionQa.failures === 0 ? "PASS" : "BLOCK",
      message: captionQa.files === 0
        ? "no .ass caption files found"
        : `${captionQa.files} caption file(s); ${captionQa.failures} chunk(s) over 3 words`,
    });

    const storyGates = join(streamDir, "story-gates.json");
    if (existsSync(storyGates)) {
      const gates = JSON.parse(readFileSync(storyGates, "utf-8")) as { blocked?: unknown[]; recut?: unknown[] };
      const bad = (gates.blocked?.length ?? 0) + (gates.recut?.length ?? 0);
      checks.push({
        name: "story-gates",
        severity: bad === 0 ? "PASS" : "BLOCK",
        message: bad === 0 ? "all clips passed story gate" : `${bad} clip(s) require recut/block`,
      });
    } else {
      checks.push({ name: "story-gates", severity: "BLOCK", message: "story-gates.json missing" });
    }

    const reviews = join(streamDir, "gemini-reviews.json");
    if (existsSync(reviews)) {
      const parsed = JSON.parse(readFileSync(reviews, "utf-8")) as Array<{ overall_verdict?: string; error?: string }>;
      const bad = parsed.filter((r) => r.error || r.overall_verdict === "SKIP" || r.overall_verdict === "NEEDS_RECUT");
      checks.push({
        name: "gemini-review",
        severity: bad.length === 0 ? "PASS" : "BLOCK",
        message: bad.length === 0 ? `${parsed.length} reviewed clip(s) passed/trim-only` : `${bad.length} hard QA failure(s)`,
      });
    } else {
      checks.push({ name: "gemini-review", severity: "BLOCK", message: "gemini-reviews.json missing" });
    }
  }

  const blocked = checks.filter((c) => c.severity === "BLOCK");
  const warned = checks.filter((c) => c.severity === "WARN");

  for (const c of checks) {
    const line = `[${c.severity}] ${c.name}: ${c.message}`;
    if (c.severity === "BLOCK") log.error(line);
    else if (c.severity === "WARN") log.warn(line);
    else log.info(line);
  }

  const outPath = join(streamDir, `preflight-${args.stage}.json`);
  writeFileSync(outPath, JSON.stringify({ stage: args.stage, checkedAt: new Date().toISOString(), checks }, null, 2), "utf-8");
  log.info(`Wrote ${outPath}`);

  if (blocked.length > 0 && !args.warnOnly) {
    log.error(`Preflight failed: ${blocked.length} blocker(s), ${warned.length} warning(s).`);
    process.exit(1);
  }
  log.info(`Preflight passed with ${warned.length} warning(s).`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("preflight.ts") || process.argv[1]?.endsWith("preflight.js")) {
  main();
}
