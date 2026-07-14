/**
 * trim.ts — Browser-based interactive clip trimmer for gaming Shorts.
 *
 * Supports TWO data sources:
 *   1. unified-moments.json + raw-clips/  (manual/scan picks)
 *   2. notebooklm-moments.json            (auto-extracts padded clips from stream)
 *
 * For source 2, extracts padded clips (+10s each side) from stream.mp4 using
 * ffmpeg stream copy, then loads them into the trimmer with NotebookLM's
 * enrichment data (coldOpen, naturalEnd, thumbnail, titleDrafts) as initial
 * trim boundaries.
 *
 * Usage:
 *   npx tsx packages/clips/src/trim.ts --stream <id> [--port 3847]
 *   npx tsx packages/clips/src/trim.ts --stream <id> --source notebooklm
 *   npx tsx packages/clips/src/trim.ts --stream <id> --source unified
 */

import { createServer } from "http";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { createLogger, ensureDir } from "@ltx/shared";
import { findStreamDir, loadManifest, saveManifest } from "./lib/manifest.js";
import { parseAudioLevels, type AudioSample } from "./lib/audio-analyzer.js";
import { transcribeClip, type WhisperWord } from "./lib/whisper-captions.js";
import { computeAutoTrim } from "./lib/enhanced-auto-trim.js";
import { finalizeClip, remapWhisperForFinalized } from "./lib/trim-finalize.js";
import { diarizeClip, isPyannoteAvailable, type SpeakerTurn } from "./lib/diarize.js";
import { loadFeedback, getDurationSweetSpot } from "./lib/feedback.js";
import {
  canonicalizeMoment,
  chooseCanonicalMomentSource,
} from "./lib/candidate-contract.js";

const log = createLogger("trim");

interface ClipMeta {
  rank: number;
  candidateId: string;
  momentId?: string;
  sourceStartSec?: number;
  sourceEndSec?: number;
  clipFile: string;
  description: string;
  hookText: string;
  viralityScore: number;
  layoutMode: string;
  source: string;
  targetMin: number;
  targetMax: number;
  archetype?: string;
  titleDrafts?: string[];
  initialFlashStart?: number;
  initialFlashEnd?: number;
  initialContentStart?: number;
  initialContentEnd?: number;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--stream")) {
    console.log("Usage: trim.ts --stream <id> [--port 3847] [--source notebooklm|unified|auto] [--auto]");
    console.log(
      "Opens a browser-based clip trimming tool for fine-tuning raw clip boundaries.",
    );
    console.log(
      "  --auto    Skip the browser and finalize every clip using whisper + audio peak data.",
    );
    process.exit(1);
  }

  const streamId = args[args.indexOf("--stream") + 1];
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 3900;
  const sourceIdx = args.indexOf("--source");
  const sourceFlag = sourceIdx >= 0 ? args[sourceIdx + 1] : "auto";
  const autoMode = args.includes("--auto");
  const forceAuto = args.includes("--force");

  const streamDir = findStreamDir(streamId);
  if (!streamDir) {
    log.error(`Stream directory not found for ${streamId}`);
    process.exit(1);
  }

  if (autoMode) {
    await runAutoTrim(streamId, streamDir, forceAuto);
    return;
  }

  const manifest = loadManifest(streamId);
  const jobId = basename(manifest.jobDir);
  const rawClipsDir = join(streamDir, "raw-clips");
  const unifiedPath = join(streamDir, "unified-moments.json");
  const nlmPath = join(streamDir, "notebooklm-moments.json");

  // Determine data source
  const hasRawClips = existsSync(rawClipsDir) && readdirSync(rawClipsDir).some(f => f.endsWith(".mp4"));
  const hasUnified = existsSync(unifiedPath);
  const hasNlm = existsSync(nlmPath);

  let useNlm = false;
  if (sourceFlag === "notebooklm") useNlm = true;
  else if (sourceFlag === "unified") useNlm = false;
  else {
    // auto: prefer raw-clips+unified if available, else notebooklm
    useNlm = !hasRawClips && hasNlm;
  }

  let clips: ClipMeta[] = [];
  let reserveClips: string[] = [];
  let serveDir = rawClipsDir; // directory where .mp4 files are served from

  if (useNlm) {
    // ── NotebookLM source ──
    if (!hasNlm) {
      log.error(`No notebooklm-moments.json found in ${streamDir}`);
      process.exit(1);
    }
    if (!manifest.videoPath || !existsSync(manifest.videoPath)) {
      log.error(`No stream.mp4 found for extracting clips`);
      process.exit(1);
    }

    const nlmMoments: Array<{
      id?: string;
      startSec: number;
      endSec: number;
      durationSec?: number;
      hook?: string;
      description?: string;
      viralScore?: number;
      categories?: string[];
      archetype?: string;
      titleDrafts?: string[];
      coldOpenSec?: number;
      naturalEndSec?: number;
      thumbnailSec?: number;
    }> = JSON.parse(readFileSync(nlmPath, "utf-8"));

    if (nlmMoments.length === 0) {
      log.error("notebooklm-moments.json is empty — no picks to trim");
      process.exit(1);
    }

    // Extract padded clips from stream (+10s each side)
    const paddedClipsDir = join(streamDir, "raw-clips");
    mkdirSync(paddedClipsDir, { recursive: true });
    serveDir = paddedClipsDir;

    const PAD_SEC = 10;
    const streamPath = manifest.videoPath.replace(/\\/g, "/");

    for (let i = 0; i < nlmMoments.length; i++) {
      const m = nlmMoments[i];
      const identity = canonicalizeMoment(jobId, m);
      const rank = i + 1;
      const slug = (m.hook || m.description || `clip-${rank}`)
        .replace(/[^a-zA-Z0-9 ]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 40)
        .toLowerCase();
      const fileName = `${String(rank).padStart(2, "0")}-${slug}.mp4`;
      const outPath = join(paddedClipsDir, fileName);

      if (!existsSync(outPath)) {
        const paddedStart = Math.max(0, m.startSec - PAD_SEC);
        const paddedDur = (m.endSec - m.startSec) + (PAD_SEC * 2);
        log.info(`Extracting padded clip ${rank}: ${paddedStart}s +${paddedDur}s → ${fileName}`);
        try {
          execSync(
            `ffmpeg -ss ${paddedStart} -i "${streamPath}" -t ${paddedDur} -c copy "${outPath.replace(/\\/g, "/")}" -y`,
            { stdio: "pipe" },
          );
        } catch (e) {
          log.error(`Failed to extract clip ${rank}: ${(e as Error).message}`);
          continue;
        }
      }

      // Compute initial trim values from enrichment data
      // coldOpen → flash start, naturalEnd → content end
      const contentStart = m.coldOpenSec ? Math.max(0, m.coldOpenSec - (m.startSec - PAD_SEC)) : PAD_SEC;
      const contentEnd = m.naturalEndSec ? m.naturalEndSec - (m.startSec - PAD_SEC) : m.endSec - m.startSec + PAD_SEC;
      // Flash: 2s window around the peak (startSec is the anchor)
      const flashAnchor = m.startSec - (m.startSec - PAD_SEC); // = PAD_SEC
      const flashStart = Math.max(0, flashAnchor - 1);
      const flashEnd = flashAnchor + 1;

      const archetype = m.archetype || inferArchetypeFromCategories(m.categories || []);
      const targets = getTrimTargets(archetype);

      clips.push({
        rank,
        candidateId: identity.candidateId,
        momentId: identity.momentId,
        sourceStartSec: m.startSec,
        sourceEndSec: m.endSec,
        clipFile: fileName,
        description: m.description || m.hook || `Clip ${rank}`,
        hookText: m.hook || "",
        viralityScore: m.viralScore || 0,
        layoutMode: "gameplay",
        source: "notebooklm",
        archetype,
        targetMin: targets.targetMin,
        targetMax: targets.targetMax,
        titleDrafts: m.titleDrafts,
        initialFlashStart: flashStart,
        initialFlashEnd: flashEnd,
        initialContentStart: contentStart,
        initialContentEnd: Math.min(contentEnd, (m.endSec - m.startSec) + PAD_SEC * 2),
      });
    }

    log.info(`Loaded ${clips.length} NotebookLM picks with padded extraction`);
  } else {
    // ── Unified moments source (original path) ──
    if (!hasRawClips) {
      log.error(`No raw-clips/ directory found in ${streamDir}`);
      process.exit(1);
    }

    let moments: Array<{
      id?: string;
      momentId?: string;
      candidateId?: string;
      description?: string;
      hookText?: string;
      viralityScore?: number;
      layoutMode?: string;
      startSec?: number;
      endSec?: number;
      durationSec?: number;
      source?: string;
    }> = [];
    if (hasUnified) {
      moments = JSON.parse(readFileSync(unifiedPath, "utf-8"));
    }

    const clipFiles = readdirSync(rawClipsDir)
      .filter((f) => f.endsWith(".mp4"))
      .sort();

    if (clipFiles.length === 0) {
      log.error("No .mp4 files found in raw-clips/");
      process.exit(1);
    }

    clips = clipFiles.map((file) => {
      const rankMatch = file.match(/^(\d+)-/);
      const rank = rankMatch ? parseInt(rankMatch[1], 10) : 0;
      const moment = rank > 0 && rank <= moments.length ? moments[rank - 1] : null;
      const identity = canonicalizeMoment(jobId, moment ?? {
        id: `manual-${file.replace(/\.mp4$/i, "")}`,
      });
      return {
        rank,
        candidateId: identity.candidateId,
        momentId: identity.momentId,
        clipFile: file,
        description: moment?.description || file.replace(/^\d+-/, "").replace(/\.mp4$/, "").replace(/-/g, " "),
        hookText: moment?.hookText || "",
        viralityScore: moment?.viralityScore || 0,
        layoutMode: moment?.layoutMode || "gameplay",
        source: moment?.source || "manual",
        archetype: "general",
        targetMin: 20,
        targetMax: 25,
      };
    });

    reserveClips = readdirSync(rawClipsDir)
      .filter((f) => f.endsWith(".mp4") && !f.match(/^\d+-/))
      .sort();
  }

  const streamTitle = manifest.title || streamId;

  // Load channel-config for default crop regions
  let channelConfig: Record<string, unknown> = {};
  const channelConfigPath = join(process.cwd(), "data", "clips", "channel-config.json");
  if (existsSync(channelConfigPath)) {
    try { channelConfig = JSON.parse(readFileSync(channelConfigPath, "utf-8")); } catch {}
  }

  const clipData = JSON.stringify({
    streamId,
    streamTitle,
    channelConfig,
    clips: clips.map((c) => ({
      rank: c.rank,
      candidateId: c.candidateId,
      momentId: c.momentId,
      sourceStartSec: c.sourceStartSec,
      sourceEndSec: c.sourceEndSec,
      clipFile: c.clipFile,
      description: c.description,
      hookText: c.hookText,
      viralityScore: c.viralityScore,
      layoutMode: c.layoutMode,
      source: c.source,
      targetMin: c.targetMin,
      targetMax: c.targetMax,
      titleDrafts: c.titleDrafts,
      initialFlashStart: c.initialFlashStart,
      initialFlashEnd: c.initialFlashEnd,
      initialContentStart: c.initialContentStart,
      initialContentEnd: c.initialContentEnd,
    })),
    reserveClips,
  });

  const html = buildHTML(clipData);

  let finalizing = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    if (url.pathname.startsWith("/clips/")) {
      const file = decodeURIComponent(url.pathname.replace("/clips/", ""));
      const filePath = join(serveDir, file);
      if (existsSync(filePath)) {
        const data = readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": data.length,
          "Accept-Ranges": "bytes",
        });
        res.end(data);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // Save trim state (no ffmpeg, just persist decisions to disk)
    if (url.pathname === "/save-state" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const state = JSON.parse(body);
          const statePath = join(streamDir, "trim-state.json");
          writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
          log.info(`Trim state saved to ${statePath}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    // Load saved trim state
    if (url.pathname === "/load-state" && req.method === "GET") {
      const statePath = join(streamDir, "trim-state.json");
      if (existsSync(statePath)) {
        const state = readFileSync(statePath, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(state);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(null));
      }
      return;
    }

    if (url.pathname === "/finalize" && req.method === "POST") {
      // Prevent double-finalization
      if (finalizing) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Finalization already in progress. Please wait." }));
        return;
      }
      finalizing = true;

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const trimData = JSON.parse(body) as Array<{
            rank: number;
            clipFile: string;
            flashStart: number;
            flashDuration: number;
            startTime: number;
            endTime: number;
            duration: number;
            status: "approved" | "rejected" | "replaced";
            replacedWith?: string;
            comment?: string;
          }>;

          const approved = trimData.filter(
            (t) => t.status === "approved" || t.status === "replaced",
          );
          const rejected = trimData.filter((t) => t.status === "rejected");

          // Save trim-results.json FIRST (before any ffmpeg work)
          const resultsPath = join(streamDir, "trim-results.json");
          writeFileSync(
            resultsPath,
            JSON.stringify(
              {
                streamId,
                timestamp: new Date().toISOString(),
                totalClips: trimData.length,
                approved: approved.map((t) => ({
                  rank: t.rank,
                  candidateId: clips.find((clip) => clip.rank === t.rank)?.candidateId,
                  momentId: clips.find((clip) => clip.rank === t.rank)?.momentId,
                  sourceStartSec: clips.find((clip) => clip.rank === t.rank)?.sourceStartSec,
                  sourceEndSec: clips.find((clip) => clip.rank === t.rank)?.sourceEndSec,
                  clipFile: t.clipFile,
                  flashStart: t.flashStart,
                  flashDuration: t.flashDuration,
                  contentStart: t.startTime,
                  contentEnd: t.endTime,
                  contentDuration: t.duration,
                  totalDuration: t.duration + t.flashDuration,
                  status: t.status,
                  replacedWith: t.replacedWith || null,
                  comment: t.comment || null,
                })),
                rejected: rejected.map((t) => ({
                  rank: t.rank,
                  candidateId: clips.find((clip) => clip.rank === t.rank)?.candidateId,
                  momentId: clips.find((clip) => clip.rank === t.rank)?.momentId,
                  clipFile: t.clipFile,
                  reason: "User rejected",
                  comment: t.comment || null,
                })),
              },
              null,
              2,
            ),
            "utf-8",
          );
          log.info(`Results written to ${resultsPath}`);
          log.info(`Approved: ${approved.length}, Rejected: ${rejected.length}`);

          // Respond immediately with results — ffmpeg runs async
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              trimmedCount: approved.length,
              rejectedCount: rejected.length,
              resultsFile: resultsPath,
              message: `Saved trim decisions. Now processing ${approved.length} clips with ffmpeg (check terminal for progress)...`,
            }),
          );

          // Backup originals before trimming (only first time)
          const backupDir = join(streamDir, "raw-clips-backup");
          if (!existsSync(backupDir)) {
            ensureDir(backupDir);
            for (const t of approved) {
              const src = join(serveDir, t.clipFile);
              const dst = join(backupDir, t.clipFile);
              if (existsSync(src) && !existsSync(dst)) {
                try {
                  execSync(`cp "${src.replace(/\\/g, "/")}" "${dst.replace(/\\/g, "/")}"`, { stdio: "pipe" });
                } catch {}
              }
            }
            log.info(`Backed up ${approved.length} original clips to raw-clips-backup/`);
          } else {
            log.info("raw-clips-backup/ already exists, skipping backup");
          }

          // Process clips asynchronously (non-blocking)
          const tempDir = join(streamDir, "temp");
          ensureDir(tempDir);

          let processed = 0;
          for (const t of approved) {
            try {
              const srcFile = t.replacedWith || t.clipFile;
              const srcPath = join(serveDir, srcFile).replace(/\\/g, "/");
              const flashPath = join(tempDir, `flash-${t.clipFile}`).replace(/\\/g, "/");
              const contentPath = join(tempDir, `content-${t.clipFile}`).replace(/\\/g, "/");
              const concatPath = join(tempDir, `concat-${t.clipFile}.txt`).replace(/\\/g, "/");
              const outPath = join(tempDir, `out-${t.clipFile}`).replace(/\\/g, "/");
              const destPath = join(serveDir, t.clipFile);

              // Extract flash
              execSync(
                `ffmpeg -ss ${t.flashStart} -i "${srcPath}" -t ${t.flashDuration} -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k "${flashPath}" -y`,
                { stdio: "pipe" },
              );

              // Extract content
              execSync(
                `ffmpeg -ss ${t.startTime} -i "${srcPath}" -t ${t.duration} -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k "${contentPath}" -y`,
                { stdio: "pipe" },
              );

              // Concat flash + content
              writeFileSync(concatPath, `file '${flashPath}'\nfile '${contentPath}'\n`);
              execSync(
                `ffmpeg -f concat -safe 0 -i "${concatPath}" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k "${outPath}" -y`,
                { stdio: "pipe" },
              );

              // Replace original
              if (existsSync(outPath)) {
                if (existsSync(destPath)) unlinkSync(destPath);
                renameSync(outPath, destPath);
              }

              // Clean temp files
              [flashPath, contentPath, concatPath].forEach(f => { try { unlinkSync(f); } catch {} });

              processed++;
              log.info(
                `[${processed}/${approved.length}] Trimmed ${t.clipFile}: flash ${t.flashStart.toFixed(1)}s-${(t.flashStart + t.flashDuration).toFixed(1)}s (${t.flashDuration.toFixed(1)}s) + content ${t.startTime.toFixed(1)}s-${(t.startTime + t.duration).toFixed(1)}s (${t.duration.toFixed(1)}s) = ${(t.duration + t.flashDuration).toFixed(1)}s total`,
              );
            } catch (clipErr) {
              log.error(`Failed to trim ${t.clipFile}: ${clipErr instanceof Error ? clipErr.message : String(clipErr)}`);
            }
          }

          log.info(`Trimming complete: ${processed}/${approved.length} clips processed`);

          // Auto-shutdown after processing
          setTimeout(() => {
            log.info("Shutting down server.");
            server.close();
            process.exit(0);
          }, 1500);
        } catch (e) {
          finalizing = false;
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`\n  Clip Trimmer — ${streamTitle}`);
    console.log(`  Stream: ${streamId} | Clips: ${clips.length}`);
    console.log(`  Open: http://localhost:${port}\n`);

    // Auto-open browser on Windows
    try {
      execSync(`start http://localhost:${port}`, { stdio: "ignore" });
    } catch {
      /* ignore if open fails */
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auto-trim path — no browser, uses whisper + audio peaks to finalize every clip
// ─────────────────────────────────────────────────────────────────────────────

interface AutoMomentInput {
  id?: string;
  momentId?: string;
  candidateId?: string;
  contentLane?: string;
  laneScore?: number;
  rank?: number;
  startSec?: number;
  endSec?: number;
  suggestedStartSec?: number;
  suggestedEndSec?: number;
  description?: string;
  hookText?: string;
  hook?: string;
  viralScore?: number;
  viralityScore?: number;
  signalOverlap?: number;
  scores?: { viralityScore?: number; composite?: number };
  archetype?: string;
  categories?: string[];
  flashSec?: number;
  coldOpenSec?: number;
  naturalEndSec?: number;
  visualType?: string;
}

interface AutoMoment {
  rank: number;
  candidateId: string;
  momentId: string;
  slug: string;
  paddedFile: string;
  streamStartSec: number;
  streamEndSec: number;
  hookText: string;
  description: string;
  viralityScore: number;
  archetype: string;
  targetMin: number;
  targetMax: number;
  flashSec?: number;
  setupStartSec?: number;
  payoffStartSec?: number;
  naturalEndSec?: number;
  contextNeeded?: boolean;
  arcCompleteness?: number;
  qualityStatus?: "suggested" | "candidate" | "reserve";
  reasonSuggested?: string;
  visualType?: string;
}

interface PickQualityEntry {
  rank: number;
  status?: "suggested" | "candidate" | "reserve";
  setupStartSec?: number;
  payoffStartSec?: number;
  flashSec?: number;
  naturalEndSec?: number;
  contextNeeded?: boolean;
  arcCompleteness?: number;
  reasonSuggested?: string;
}

const PAD_SEC = 10;

function inferArchetypeFromCategories(categories: string[]): string {
  if (categories.includes("friend-roast") || categories.includes("roast")) return "roast";
  if (categories.includes("crash-out") || categories.includes("meltdown")) return "crashout";
  if (categories.includes("skill") || categories.includes("clutch") || categories.includes("gameplay")) return "skill";
  if (categories.includes("one-liner") || categories.includes("quotable")) return "one-liner";
  if (categories.includes("story-of-stream") || categories.includes("callback") || categories.includes("running-bit")) return "story-payoff";
  return "general";
}

function getTrimTargets(archetype: string): { targetMin: number; targetMax: number } {
  const fb = loadFeedback();
  const sweetSpot = getDurationSweetSpot(fb);
  const base = (() => {
    switch (archetype) {
      case "skill":
        return { targetMin: 15, targetMax: 25 };
      case "roast":
        return { targetMin: 22, targetMax: 32 };
      case "crashout":
        return { targetMin: 20, targetMax: 30 };
      case "one-liner":
        return { targetMin: 15, targetMax: 24 };
      case "story-payoff":
        return { targetMin: 25, targetMax: 35 };
      default:
        return { targetMin: 18, targetMax: 30 };
    }
  })();

  // Tighten targets toward the feedback sweet spot when available.
  if (sweetSpot.min < base.targetMin && sweetSpot.max > base.targetMin) {
    base.targetMin = Math.max(sweetSpot.min, base.targetMin - 3);
  }
  if (sweetSpot.max > base.targetMax && sweetSpot.min < base.targetMax) {
    base.targetMax = Math.min(sweetSpot.max, base.targetMax + 3);
  }
  return base;
}

function slugifyForFile(s: string, maxLen = 40): string {
  return s
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, maxLen)
    .toLowerCase();
}

function probeDurationSec(path: string): number {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${path.replace(/\\/g, "/")}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return parseFloat(out.trim());
  } catch {
    return 0;
  }
}

function unlinkIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort cache cleanup. Extraction/transcription will fail loudly if
    // the stale file actually blocks the next stage.
  }
}

function durationsClose(a: number, b: number, toleranceSec = 1.5): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) <= toleranceSec;
}

function isFiniteSec(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function loadPickQuality(streamDir: string): Map<number, PickQualityEntry> {
  const qualityPath = join(streamDir, "pick-quality.json");
  const byRank = new Map<number, PickQualityEntry>();
  if (!existsSync(qualityPath)) return byRank;

  try {
    const report = JSON.parse(readFileSync(qualityPath, "utf-8")) as { picks?: PickQualityEntry[] };
    for (const pick of report.picks ?? []) {
      if (Number.isInteger(pick.rank)) byRank.set(pick.rank, pick);
    }
  } catch (e) {
    log.warn(`Could not read pick-quality.json: ${(e as Error).message}`);
  }

  return byRank;
}

function applyPickQuality(moment: AutoMoment, quality?: PickQualityEntry): AutoMoment {
  if (!quality) return moment;

  return {
    ...moment,
    streamStartSec: isFiniteSec(quality.setupStartSec) ? quality.setupStartSec : moment.streamStartSec,
    streamEndSec: isFiniteSec(quality.naturalEndSec) ? quality.naturalEndSec : moment.streamEndSec,
    flashSec: isFiniteSec(quality.flashSec) ? quality.flashSec : moment.flashSec,
    setupStartSec: quality.setupStartSec,
    payoffStartSec: quality.payoffStartSec,
    naturalEndSec: quality.naturalEndSec,
    contextNeeded: quality.contextNeeded,
    arcCompleteness: quality.arcCompleteness,
    qualityStatus: quality.status,
    reasonSuggested: quality.reasonSuggested,
  };
}

function loadAutoMoments(
  streamDir: string,
  manifest: { videoPath: string; jobDir: string },
): AutoMoment[] {
  const nlmPath = join(streamDir, "notebooklm-moments.json");
  const unifiedPath = join(streamDir, "unified-moments.json");
  const momentsPath = join(streamDir, "moments.json");
  const qualityByRank = loadPickQuality(streamDir);
  const notebookMoments = existsSync(nlmPath)
    ? JSON.parse(readFileSync(nlmPath, "utf-8")) as AutoMomentInput[]
    : [];
  const unifiedMoments = existsSync(unifiedPath)
    ? JSON.parse(readFileSync(unifiedPath, "utf-8")) as AutoMomentInput[]
    : [];
  const scorerMoments = existsSync(momentsPath)
    ? JSON.parse(readFileSync(momentsPath, "utf-8")) as AutoMomentInput[]
    : [];
  const selectedMoments = chooseCanonicalMomentSource(
    notebookMoments,
    unifiedMoments,
    scorerMoments,
  );
  const jobId = basename(manifest.jobDir);

  if (selectedMoments === notebookMoments) {
    const nlm = notebookMoments;
    if (nlm.length > 0) {
      return nlm.map((m, i) => {
        const identity = canonicalizeMoment(jobId, m);
        const rank = i + 1;
        const startSec = m.coldOpenSec ?? m.startSec;
        const endSec = m.naturalEndSec ?? m.endSec;
        if (!isFiniteSec(startSec) || !isFiniteSec(endSec) || endSec <= startSec) {
          throw new Error(`Candidate ${identity.candidateId} has no valid source window`);
        }
        const slug = slugifyForFile(m.hook || m.description || `clip-${rank}`);
        const archetype = m.archetype || inferArchetypeFromCategories(m.categories || []);
        const targets = getTrimTargets(archetype);
        return applyPickQuality({
          rank,
          candidateId: identity.candidateId,
          momentId: identity.momentId,
          slug,
          paddedFile: `${String(rank).padStart(2, "0")}-${slug}.mp4`,
          streamStartSec: startSec,
          streamEndSec: endSec,
          hookText: m.hook || "",
          description: m.description || m.hook || `Clip ${rank}`,
          viralityScore: m.viralScore ?? 0,
          archetype,
          targetMin: targets.targetMin,
          targetMax: targets.targetMax,
          flashSec: m.flashSec,
          setupStartSec: m.coldOpenSec,
          naturalEndSec: m.naturalEndSec,
          visualType: m.visualType,
        }, qualityByRank.get(rank));
      });
    }
  }

  if (selectedMoments === unifiedMoments) {
    const unified = unifiedMoments;
    if (unified.length > 0) {
      return unified.map((m, i) => {
        const identity = canonicalizeMoment(jobId, m);
        const rank = i + 1;
        const startSec = m.coldOpenSec ?? m.startSec;
        const endSec = m.naturalEndSec ?? m.endSec;
        if (!isFiniteSec(startSec) || !isFiniteSec(endSec) || endSec <= startSec) {
          throw new Error(`Candidate ${identity.candidateId} has no valid source window`);
        }
        const slug = slugifyForFile(m.hookText || m.description || `clip-${rank}`);
        const archetype = m.archetype || inferArchetypeFromCategories(m.categories || []);
        const targets = getTrimTargets(archetype);
        return applyPickQuality({
          rank,
          candidateId: identity.candidateId,
          momentId: identity.momentId,
          slug,
          paddedFile: `${String(rank).padStart(2, "0")}-${slug}.mp4`,
          streamStartSec: startSec,
          streamEndSec: endSec,
          hookText: m.hookText || "",
          description: m.description || `Clip ${rank}`,
          viralityScore: m.viralityScore ?? 0,
          archetype,
          targetMin: targets.targetMin,
          targetMax: targets.targetMax,
          flashSec: m.flashSec,
          setupStartSec: m.coldOpenSec,
          naturalEndSec: m.naturalEndSec,
        }, qualityByRank.get(rank));
      });
    }
  }

  if (selectedMoments === scorerMoments) {
    const scorer = scorerMoments;
    return scorer.map((m, i) => {
      const identity = canonicalizeMoment(jobId, m);
      const rank = i + 1;
      const startSec = m.coldOpenSec ?? m.startSec ?? m.suggestedStartSec ?? 0;
      const endSec = m.naturalEndSec ?? m.endSec ?? m.suggestedEndSec ?? startSec + 30;
      const hookText = m.hookText || m.hook || "";
      const slug = slugifyForFile(hookText || m.description || `clip-${rank}`);
      const archetype = m.archetype || inferArchetypeFromCategories(m.categories || []);
      const targets = getTrimTargets(archetype);
      return applyPickQuality({
        rank,
        candidateId: identity.candidateId,
        momentId: identity.momentId,
        slug,
        paddedFile: `${String(rank).padStart(2, "0")}-${slug}.mp4`,
        streamStartSec: startSec,
        streamEndSec: endSec,
        hookText,
        description: m.description || hookText || `Clip ${rank}`,
        viralityScore: m.scores?.viralityScore ?? m.scores?.composite ?? m.signalOverlap ?? 0,
        archetype,
        targetMin: targets.targetMin,
        targetMax: targets.targetMax,
        flashSec: m.flashSec,
        setupStartSec: m.coldOpenSec,
        naturalEndSec: m.naturalEndSec,
        visualType: m.visualType,
      }, qualityByRank.get(rank));
    });
  }

  throw new Error(
    `No notebooklm-moments.json, unified-moments.json, or moments.json in ${streamDir}`,
  );
}

async function runAutoTrim(streamId: string, streamDir: string, force: boolean): Promise<void> {
  const trimResultsPath = join(streamDir, "trim-results.json");
  if (existsSync(trimResultsPath) && !force) {
    log.info(`trim-results.json already exists — skipping auto-trim. Pass --force to regenerate.`);
    return;
  }

  const manifest = loadManifest(streamId);
  if (!manifest.videoPath || !existsSync(manifest.videoPath)) {
    log.error("Source stream.mp4 not found — cannot extract padded clips.");
    process.exit(1);
  }

  const moments = loadAutoMoments(streamDir, manifest);
  if (moments.length === 0) {
    log.warn("No moments to auto-trim.");
    return;
  }

  const rawClipsDir = join(streamDir, "raw-clips");
  const rawClipsBackupDir = join(streamDir, "raw-clips-backup");
  const whisperDir = join(streamDir, "whisper-captions");
  const paddedWhisperDir = join(streamDir, "temp", "padded-whisper");
  const diarizeDir = join(streamDir, "temp", "diarize");
  const tempDir = join(streamDir, "temp");
  ensureDir(rawClipsDir);
  ensureDir(rawClipsBackupDir);
  ensureDir(whisperDir);
  ensureDir(paddedWhisperDir);
  ensureDir(diarizeDir);
  ensureDir(tempDir);

  // One-shot check so we don't spam the log per clip.
  const useSpeakers = isPyannoteAvailable() && !!process.env.HF_TOKEN;
  if (useSpeakers) {
    log.info("Pyannote detected — speaker-change boundary snapping enabled");
  } else {
    log.info("Pyannote/HF_TOKEN unavailable — falling back to silence+punctuation snapping");
  }

  // Step 1: extract padded clips (+PAD_SEC each side). A forced auto-trim must
  // rebuild these from stream.mp4, because raw-clips/ may already contain
  // finalized flash+content assemblies from a previous run. Reusing those as
  // "padded" sources poisons trim boundaries and caption timing.
  const streamPath = manifest.videoPath.replace(/\\/g, "/");
  for (const m of moments) {
    const outPath = join(rawClipsDir, m.paddedFile);
    const paddedWhisperPath = join(paddedWhisperDir, m.paddedFile.replace(/\.mp4$/, ".json"));
    const finalWhisperPath = join(whisperDir, m.paddedFile.replace(/\.mp4$/, ".json"));
    const paddedStart = Math.max(0, m.streamStartSec - PAD_SEC);
    const paddedDur = m.streamEndSec - m.streamStartSec + PAD_SEC * 2;
    const existingDuration = existsSync(outPath) ? probeDurationSec(outPath) : 0;
    const needsExtract = force || !existsSync(outPath) || !durationsClose(existingDuration, paddedDur);

    if (!needsExtract) continue;

    if (existsSync(outPath) && !force) {
      log.warn(
        `[${m.rank}] Existing raw clip duration ${existingDuration.toFixed(1)}s does not match padded ` +
          `${paddedDur.toFixed(1)}s — re-extracting and clearing stale captions`,
      );
    } else if (force) {
      log.info(`[${m.rank}] Force rebuild: re-extracting padded source and clearing cached captions`);
    }

    unlinkIfExists(paddedWhisperPath);
    unlinkIfExists(finalWhisperPath);

    log.info(`[${m.rank}] Extracting padded clip ${paddedStart.toFixed(1)}s +${paddedDur.toFixed(1)}s`);
    try {
      execSync(
        `ffmpeg -ss ${paddedStart} -i "${streamPath}" -t ${paddedDur} -c copy "${outPath.replace(/\\/g, "/")}" -y`,
        { stdio: "pipe" },
      );
    } catch (e) {
      log.error(`[${m.rank}] Padded extraction failed: ${(e as Error).message}`);
    }
  }

  // Step 2: load stream-level audio samples once (absolute timebase).
  let audioSamples: AudioSample[] | null = null;
  if (manifest.audioLevelsPath && existsSync(manifest.audioLevelsPath)) {
    try {
      audioSamples = parseAudioLevels(manifest.audioLevelsPath);
      log.info(`Loaded ${audioSamples.length} audio samples for flash anchoring`);
    } catch (e) {
      log.warn(`audio_levels.txt parse failed: ${(e as Error).message}`);
    }
  } else {
    log.warn("No audio_levels.txt — flash anchor will fall back to signal center");
  }

  const approved: Array<{
    rank: number;
    candidateId: string;
    momentId: string;
    sourceStartSec: number;
    sourceEndSec: number;
    clipFile: string;
    flashStart: number;
    flashDuration: number;
    contentStart: number;
    contentEnd: number;
    contentDuration: number;
    totalDuration: number;
    status: "approved";
    notes: string;
    qualityStatus?: "suggested" | "candidate" | "reserve";
    arcCompleteness?: number;
    contextNeeded?: boolean;
    reasonSuggested?: string;
  }> = [];

  for (const m of moments) {
    const padded = join(rawClipsDir, m.paddedFile);
    if (!existsSync(padded)) {
      log.warn(`[${m.rank}] Padded clip missing — skipping`);
      continue;
    }

    const paddedDurationSec = probeDurationSec(padded);
    if (paddedDurationSec < 5) {
      log.warn(`[${m.rank}] Padded duration ${paddedDurationSec}s too short — skipping`);
      continue;
    }

    // Step 3: whisper the padded clip (cache under temp/padded-whisper/).
    const paddedWhisperPath = join(paddedWhisperDir, m.paddedFile.replace(/\.mp4$/, ".json"));
    let paddedWords: WhisperWord[] | null = null;
    try {
      if (!existsSync(paddedWhisperPath)) {
        log.info(`[${m.rank}] Whisper-transcribing padded clip...`);
        paddedWords = transcribeClip(padded, paddedWhisperPath);
      } else {
        paddedWords = JSON.parse(readFileSync(paddedWhisperPath, "utf-8")) as WhisperWord[];
      }
    } catch (e) {
      log.warn(`[${m.rank}] Whisper failed — boundaries will not snap: ${(e as Error).message}`);
    }

    // Step 3b: diarize the padded clip for speaker-change boundary snapping.
    let turns: SpeakerTurn[] | null = null;
    if (useSpeakers) {
      const diarizePath = join(diarizeDir, m.paddedFile.replace(/\.mp4$/, ".json"));
      try {
        turns = diarizeClip(padded, diarizePath);
        if (turns) log.info(`[${m.rank}] Diarization: ${turns.length} turns`);
      } catch (e) {
        log.warn(`[${m.rank}] Diarization failed: ${(e as Error).message}`);
      }
    }

    // Step 4: translate stream time → padded-clip time for the signal range.
    const paddedStartAbs = Math.max(0, m.streamStartSec - PAD_SEC);
    const signalStartInClip = m.streamStartSec - paddedStartAbs; // ≈ PAD_SEC
    const signalEndInClip = m.streamEndSec - paddedStartAbs;

    // Remap audio samples to clip-relative seconds so peak search matches the clip.
    const clipAudio = audioSamples
      ? audioSamples
          .filter((s) => s.timeSec >= paddedStartAbs && s.timeSec <= paddedStartAbs + paddedDurationSec)
          .map((s) => ({ timeSec: s.timeSec - paddedStartAbs, rmsLevel: s.rmsLevel }))
      : null;

    const result = computeAutoTrim({
      paddedDurationSec,
      signalStartInClipSec: signalStartInClip,
      signalEndInClipSec: signalEndInClip,
      whisperWords: paddedWords,
      audioSamples: clipAudio,
      turns,
      forcedFlashStartSec: m.flashSec != null ? m.flashSec - paddedStartAbs : undefined,
      forcedContentStartSec: m.setupStartSec != null ? m.setupStartSec - paddedStartAbs : undefined,
      forcedContentEndSec: m.naturalEndSec != null ? m.naturalEndSec - paddedStartAbs : undefined,
      forcedPayoffStartSec: m.payoffStartSec != null ? m.payoffStartSec - paddedStartAbs : undefined,
    });

    // Step 5: keep the result inside the configured target duration.
    // Preserve the natural end/payoff first; trim excess from setup when the
    // quality pass expanded the build-up too far for a Short.
    const totalTarget = m.targetMax + 3;
    if (result.contentDuration + result.flashDuration > totalTarget) {
      const maxContent = Math.max(m.targetMin - result.flashDuration, totalTarget - result.flashDuration);
      result.contentStart = Math.max(0, Math.min(result.contentEnd - 5, result.contentEnd - maxContent));
      result.contentDuration = result.contentEnd - result.contentStart;
      const requestedPayoffStart = m.payoffStartSec != null
        ? m.payoffStartSec - paddedStartAbs
        : result.segments.payoff.start;
      const setupEnd = Math.max(result.contentStart, Math.min(result.contentEnd, requestedPayoffStart));
      result.segments.setup = {
        start: result.contentStart,
        end: setupEnd,
        duration: Math.max(0, setupEnd - result.contentStart),
      };
      result.segments.payoff = {
        start: setupEnd,
        end: result.contentEnd,
        duration: Math.max(0, result.contentEnd - setupEnd),
      };
    }

    log.info(
      `[${m.rank}] flash ${result.flashStart.toFixed(2)}s +${result.flashDuration.toFixed(2)}s ` +
        `(${result.notes.flashSource}); content ${result.contentStart.toFixed(2)}-${result.contentEnd.toFixed(2)}s ` +
        `(start:${result.notes.startSnap}, end:${result.notes.endSnap})`,
    );

    // Step 6a: snapshot the padded clip into raw-clips-backup/ so the review
    // pass can re-finalize against untouched source when Gemini flags an
    // extend. Skip copy if a backup already exists — finalize is idempotent
    // on source, not destructive on backup.
    const backupPath = join(rawClipsBackupDir, m.paddedFile);
    const backupDuration = existsSync(backupPath) ? probeDurationSec(backupPath) : 0;
    if (force || !existsSync(backupPath) || !durationsClose(backupDuration, paddedDurationSec)) {
      try {
        execSync(
          `ffmpeg -i "${padded.replace(/\\/g, "/")}" -c copy "${backupPath.replace(/\\/g, "/")}" -y`,
          { stdio: "pipe" },
        );
      } catch (e) {
        log.warn(`[${m.rank}] Could not snapshot padded clip: ${(e as Error).message}`);
      }
    }

    // Step 6b: finalize — replace padded raw clip with flash+content assembly.
    try {
      finalizeClip({
        srcPath: padded,
        flashStart: result.flashStart,
        flashDuration: result.flashDuration,
        contentStart: result.contentStart,
        contentDuration: result.contentDuration,
        tempDir,
        outPath: padded,
      });
    } catch (e) {
      log.error(`[${m.rank}] finalize failed: ${(e as Error).message}`);
      continue;
    }

    // Step 7: rewrite whisper JSON for the finalized timeline.
    if (paddedWords) {
      const remapped = remapWhisperForFinalized(
        paddedWords,
        result.contentStart,
        result.contentEnd,
        result.flashDuration,
      );
      const finalWhisperPath = join(whisperDir, m.paddedFile.replace(/\.mp4$/, ".json"));
      writeFileSync(finalWhisperPath, JSON.stringify(remapped, null, 2), "utf-8");
    }

    approved.push({
      rank: m.rank,
      candidateId: m.candidateId,
      momentId: m.momentId,
      sourceStartSec: m.streamStartSec,
      sourceEndSec: m.streamEndSec,
      clipFile: m.paddedFile,
      flashStart: result.flashStart,
      flashDuration: result.flashDuration,
      contentStart: result.contentStart,
      contentEnd: result.contentEnd,
      contentDuration: result.contentDuration,
      totalDuration: result.flashDuration + result.contentDuration,
      status: "approved",
      notes: `archetype:${m.archetype};quality:${m.qualityStatus ?? "unscored"};arc:${m.arcCompleteness ?? "n/a"};context:${m.contextNeeded ?? false};flash:${result.notes.flashSource};start:${result.notes.startSnap};end:${result.notes.endSnap};setup:${result.segments.setup.duration.toFixed(1)};payoff:${result.segments.payoff.duration.toFixed(1)}`,
      qualityStatus: m.qualityStatus,
      arcCompleteness: m.arcCompleteness,
      contextNeeded: m.contextNeeded,
      reasonSuggested: m.reasonSuggested,
    });
  }

  // Step 8: persist trim-results.json and bump phase.
  writeFileSync(
    trimResultsPath,
    JSON.stringify(
      {
        streamId,
        timestamp: new Date().toISOString(),
        mode: "auto",
        totalClips: moments.length,
        approved,
        rejected: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
  log.info(`\nAuto-trim complete — ${approved.length}/${moments.length} clips finalized.`);
  log.info(`Results: ${trimResultsPath}`);

  try {
    manifest.phase = "clipped";
    saveManifest(manifest);
  } catch (e) {
    log.warn(`Could not update manifest phase: ${(e as Error).message}`);
  }
}

function buildHTML(clipDataJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Clip Trimmer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #f5f5f0; font-family: 'Inter', system-ui, sans-serif; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; font-weight: 700; color: #d4a017; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #a0a0b0; margin-bottom: 20px; }

  .player-area { position: relative; background: #141414; border-radius: 12px; overflow: hidden; margin-bottom: 16px; }
  video { width: 100%; display: block; background: #000; max-height: 620px; object-fit: contain; cursor: pointer; }
  .time-overlay { position: absolute; top: 12px; left: 12px; background: rgba(0,0,0,0.75); color: #d4a017; font-family: 'Courier New', monospace; font-size: 18px; font-weight: 700; padding: 4px 10px; border-radius: 6px; pointer-events: none; }
  .speed-badge { position: absolute; top: 12px; right: 120px; background: rgba(0,0,0,0.75); color: #f59e0b; font-family: 'Courier New', monospace; font-size: 14px; font-weight: 700; padding: 4px 10px; border-radius: 6px; pointer-events: none; }
  .target-badge { position: absolute; top: 12px; right: 12px; background: rgba(26,143,60,0.85); color: white; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 6px; pointer-events: none; }

  .seekbar-container { position: relative; width: 100%; height: 32px; background: #1a1a2a; cursor: pointer; }
  .seekbar-track { position: absolute; top: 12px; left: 0; right: 0; height: 8px; background: #2a2a3a; border-radius: 4px; }
  .seekbar-progress { position: absolute; top: 12px; left: 0; height: 8px; background: #d4a017; border-radius: 4px; pointer-events: none; }
  .seekbar-flash { position: absolute; top: 12px; height: 8px; background: rgba(245,158,11,0.4); border-radius: 4px; pointer-events: none; }
  .seekbar-content { position: absolute; top: 12px; height: 8px; background: rgba(34,197,94,0.3); border-radius: 4px; pointer-events: none; }
  .seekbar-handle { position: absolute; top: 8px; width: 16px; height: 16px; background: #d4a017; border-radius: 50%; transform: translateX(-8px); pointer-events: none; box-shadow: 0 0 4px rgba(0,0,0,0.5); }
  .seekbar-time { position: absolute; bottom: 2px; right: 8px; font-size: 11px; color: #a0a0b0; font-family: 'Courier New', monospace; pointer-events: none; }

  .controls { padding: 16px; }

  .playback-btns { display: flex; gap: 8px; justify-content: center; margin-bottom: 14px; }
  .step-btn { width: 38px; height: 38px; border-radius: 8px; border: 1px solid #2a2a3a; background: #141414; color: #f5f5f0; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .step-btn:hover { border-color: #d4a017; }
  .nudge-btn { width: 24px; height: 24px; border-radius: 4px; border: 1px solid #3a3a4a; background: #1a1a2a; color: #a0a0b0; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0; }
  .nudge-btn:hover { border-color: #d4a017; color: #d4a017; }
  .btn { padding: 10px 24px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .btn-play { background: #1a8f3c; color: white; min-width: 100px; }
  .btn-play:hover { background: #22a548; }
  .btn-secondary { background: #2a2a3a; color: #f5f5f0; }
  .btn-secondary:hover { background: #3a3a4a; }
  .btn-primary { background: #d4a017; color: #0a0a0a; }
  .btn-primary:hover { background: #e5b020; }
  .btn:disabled { opacity: 0.3; cursor: default; }

  .range-row { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; }
  .range-row label { font-size: 12px; color: #a0a0b0; min-width: 44px; text-transform: uppercase; letter-spacing: 1px; }
  .range-row input[type="range"] { flex: 1; accent-color: #d4a017; height: 6px; }
  .range-row .shift-range { accent-color: #1a8f3c; }
  .range-row .time { font-family: 'Courier New', monospace; font-size: 14px; min-width: 54px; text-align: right; color: #d4a017; }

  .info-bar { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; padding: 12px 16px; background: #1a1a2a; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
  .info-item { display: flex; gap: 4px; }
  .info-bar .label { color: #a0a0b0; }
  .info-bar .value { font-weight: 700; color: #f5f5f0; }
  .info-bar .accent { color: #d4a017; }
  .info-bar .good { color: #22c55e; }
  .over-budget { color: #ef4444 !important; }

  .clip-meta { background: #1a1a2a; padding: 14px 16px; border-radius: 8px; margin-bottom: 16px; border-left: 3px solid #d4a017; }
  .clip-meta .shot-label { font-size: 11px; color: #d4a017; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .clip-meta .text { font-size: 14px; line-height: 1.5; color: #e0e0e0; }
  .clip-meta .caption { font-size: 12px; color: #a0a0b0; margin-top: 6px; font-style: italic; }
  .virality-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; margin-left: 8px; }
  .v-high { background: #22c55e33; color: #22c55e; }
  .v-mid { background: #d4a01733; color: #d4a017; }
  .v-low { background: #ef444433; color: #ef4444; }

  .clip-nav { display: flex; gap: 8px; justify-content: center; margin-bottom: 16px; align-items: center; }
  .clip-dot { width: 10px; height: 10px; border-radius: 50%; background: #2a2a3a; cursor: pointer; transition: all 0.15s; }
  .clip-dot.active { background: #d4a017; transform: scale(1.4); }
  .clip-dot.done { background: #1a8f3c; }

  .nav { display: flex; gap: 12px; justify-content: center; margin-bottom: 16px; }

  .btn-finalize { background: #1a8f3c; color: white; width: 100%; padding: 14px; font-size: 16px; margin-top: 8px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; }
  .btn-finalize:hover { background: #22a548; }

  .summary { background: #141414; border-radius: 8px; padding: 16px; margin-top: 16px; display: none; }
  .summary h3 { color: #d4a017; font-size: 14px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .summary table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .summary th { text-align: left; color: #a0a0b0; padding: 6px 8px; border-bottom: 1px solid #2a2a3a; }
  .summary td { padding: 6px 8px; border-bottom: 1px solid #1a1a2a; }
  .summary .mono { font-family: 'Courier New', monospace; color: #d4a017; }

  /* Crop overlay */
  .crop-overlay { position: absolute; top: 0; left: 0; right: 0; pointer-events: none; z-index: 10; overflow: hidden; }
  .crop-box { position: absolute; cursor: move; pointer-events: auto; user-select: none; box-sizing: border-box; }
  .crop-box.talking  { border: 3px solid #22c55e; background: rgba(34,197,94,0.07); }
  .crop-box.avatar   { border: 3px solid #f59e0b; background: rgba(245,158,11,0.07); }
  .crop-box.gameplay { border: 3px solid #60a5fa; background: rgba(96,165,250,0.07); }
  .crop-label { position: absolute; top: 4px; left: 6px; font-size: 11px; font-weight: 800; color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,0.9); text-transform: uppercase; letter-spacing: 0.5px; pointer-events: none; }
  .crop-coords { position: absolute; bottom: 4px; left: 6px; font-size: 9px; color: rgba(255,255,255,0.65); font-family: 'Courier New', monospace; pointer-events: none; white-space: nowrap; }
  .resize-handle { position: absolute; bottom: 0; right: 0; width: 18px; height: 18px; cursor: se-resize; background: rgba(255,255,255,0.35); border-top-left-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: rgba(255,255,255,0.7); }
  .layout-btn.active { border-color: #d4a017 !important; background: #261f00 !important; color: #d4a017 !important; }
</style>
</head>
<body>
<div class="container">
  <h1 id="title">Clip Trimmer</h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="clip-nav" id="clipNav"></div>

  <div class="player-area">
    <video id="video" preload="auto" onclick="togglePause()"></video>
    <div id="cropOverlay" class="crop-overlay">
      <div id="talkingBox" class="crop-box talking" style="display:none;">
        <div class="crop-label">↔ Talking Crop</div>
        <div class="crop-coords" id="talkingCoords"></div>
      </div>
      <div id="avatarBox" class="crop-box avatar" style="display:none;">
        <div class="crop-label">Avatar</div>
        <div class="crop-coords" id="avatarCoords"></div>
        <div class="resize-handle" id="avatarResize">↘</div>
      </div>
      <div id="gameplayBox" class="crop-box gameplay" style="display:none;">
        <div class="crop-label">Gameplay</div>
        <div class="crop-coords" id="gameplayCoords"></div>
        <div class="resize-handle" id="gameplayResize">↘</div>
      </div>
    </div>
    <div class="time-overlay" id="timeOverlay">0.00s</div>
    <div class="speed-badge" id="speedBadge">1.0x</div>
    <div class="target-badge" id="targetBadge">Target: 25-60s</div>
    <div class="seekbar-container" id="seekbar">
      <div class="seekbar-track"></div>
      <div class="seekbar-flash" id="seekFlash"></div>
      <div class="seekbar-content" id="seekContent"></div>
      <div class="seekbar-progress" id="seekProgress"></div>
      <div class="seekbar-handle" id="seekHandle"></div>
      <div class="seekbar-time" id="seekTime">0:00 / 0:00</div>
    </div>
  </div>

  <div class="controls">
    <div class="playback-btns">
      <button class="step-btn" onclick="stepFrame(-10)" title="-10 frames">&laquo;</button>
      <button class="step-btn" onclick="stepFrame(-1)" title="-1 frame">&lsaquo;</button>
      <button class="btn btn-play" id="playBtn" onclick="togglePlay()">&#9654; Play</button>
      <button class="step-btn" onclick="stepFrame(1)" title="+1 frame">&rsaquo;</button>
      <button class="step-btn" onclick="stepFrame(10)" title="+10 frames">&raquo;</button>
    </div>
    <div class="playback-btns" style="margin-bottom:14px;">
      <button class="step-btn" onclick="setSpeed(0.25)" title="0.25x" style="font-size:11px;width:44px">.25x</button>
      <button class="step-btn" onclick="setSpeed(0.5)" title="0.5x" style="font-size:11px;width:44px">.5x</button>
      <button class="step-btn" onclick="setSpeed(1)" title="1x" style="font-size:12px;width:44px;border-color:#d4a017">1x</button>
      <button class="step-btn" onclick="setSpeed(1.5)" title="1.5x" style="font-size:11px;width:44px">1.5x</button>
      <button class="step-btn" onclick="setSpeed(2)" title="2x" style="font-size:12px;width:44px">2x</button>
      <button class="step-btn" onclick="setSpeed(3)" title="3x" style="font-size:12px;width:44px">3x</button>
    </div>

    <div style="font-size:11px;color:#f59e0b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Flash Segment (peak energy preview — plays under hook text)</div>
    <div class="range-row">
      <label style="color:#f59e0b">F.Start</label>
      <button class="nudge-btn" onclick="nudgeSlider('flashStart',-1)" title="-1 frame">&lsaquo;</button>
      <input type="range" id="flashStartSlider" min="0" max="1000" value="0" step="1" style="accent-color:#f59e0b">
      <button class="nudge-btn" onclick="nudgeSlider('flashStart',1)" title="+1 frame">&rsaquo;</button>
      <span class="time" id="flashStartTime" style="color:#f59e0b">0.00s</span>
    </div>
    <div class="range-row">
      <label style="color:#e27b00">F.End</label>
      <button class="nudge-btn" onclick="nudgeSlider('flashEnd',-1)" title="-1 frame">&lsaquo;</button>
      <input type="range" id="flashEndSlider" min="0" max="1000" value="200" step="1" style="accent-color:#e27b00">
      <button class="nudge-btn" onclick="nudgeSlider('flashEnd',1)" title="+1 frame">&rsaquo;</button>
      <span class="time" id="flashEndTime" style="color:#e27b00">2.00s</span>
    </div>
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:6px;">
      <button class="btn" onclick="setFlashStartHere()" title="Set flash start to current playhead" style="flex:1;background:#2b1f00;color:#f59e0b;border:2px solid #f59e0b;font-size:13px;font-weight:700;padding:10px 8px;">&#9654; Flash start</button>
      <button class="btn" onclick="setFlashEndHere()" title="Set flash end to current playhead" style="flex:1;background:#2b1a00;color:#e27b00;border:2px solid #e27b00;font-size:13px;font-weight:700;padding:10px 8px;">Flash end &#9654;</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:14px;">
      <button class="btn btn-secondary" onclick="previewFlash()" style="font-size:12px;padding:6px 16px;border:1px solid #f59e0b;color:#f59e0b;">Play Flash</button>
    </div>

    <div style="height:1px;background:#2a2a3a;margin:8px 0 12px;"></div>
    <div style="font-size:11px;color:#22c55e;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Content Segment (the actual clip viewers watch after flash)</div>
    <div class="range-row">
      <label style="color:#22c55e">Start</label>
      <button class="nudge-btn" onclick="nudgeSlider('start',-1)" title="-1 frame">&lsaquo;</button>
      <input type="range" id="startSlider" min="0" max="1000" value="0" step="1">
      <button class="nudge-btn" onclick="nudgeSlider('start',1)" title="+1 frame">&rsaquo;</button>
      <span class="time" id="startTime" style="color:#22c55e">0.00s</span>
    </div>
    <div class="range-row">
      <label style="color:#ef4444">End</label>
      <button class="nudge-btn" onclick="nudgeSlider('end',-1)" title="-1 frame">&lsaquo;</button>
      <input type="range" id="endSlider" min="0" max="1000" value="1000" step="1">
      <button class="nudge-btn" onclick="nudgeSlider('end',1)" title="+1 frame">&rsaquo;</button>
      <span class="time" id="endTime" style="color:#ef4444">0.00s</span>
    </div>
    <div class="range-row">
      <label style="color:#1a8f3c">Shift</label>
      <button class="nudge-btn" onclick="nudgeSlider('shift',-1)" title="-1 frame">&lsaquo;</button>
      <input type="range" id="shiftSlider" class="shift-range" min="0" max="1000" value="500" step="1">
      <button class="nudge-btn" onclick="nudgeSlider('shift',1)" title="+1 frame">&rsaquo;</button>
      <span class="time" id="shiftTime" style="color:#1a8f3c">0.00s</span>
    </div>

    <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;margin-bottom:6px;">
      <button class="btn" onclick="setStartHere()" title="Set content start to current playhead" style="flex:1;background:#0d2b12;color:#22c55e;border:2px solid #22c55e;font-size:13px;font-weight:700;padding:10px 8px;letter-spacing:0.5px;">&#9654; Start here</button>
      <button class="btn" onclick="setEndHere()" title="Set content end to current playhead" style="flex:1;background:#2b0d0d;color:#ef4444;border:2px solid #ef4444;font-size:13px;font-weight:700;padding:10px 8px;letter-spacing:0.5px;">End here &#9654;</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:center;margin-top:4px;">
      <button class="btn btn-secondary" onclick="previewContent()" style="font-size:12px;padding:6px 16px;border:1px solid #22c55e;color:#22c55e;">Play Content</button>
      <button class="btn btn-secondary" onclick="saveState()" style="font-size:12px;padding:6px 16px;">Save</button>
      <button class="btn btn-secondary" onclick="revertState()" style="font-size:12px;padding:6px 16px;" id="revertBtn" disabled>Revert</button>
    </div>

    <div style="height:1px;background:#2a2a3a;margin:14px 0 12px;"></div>
    <div style="font-size:11px;color:#a0a0b0;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Layout Template</div>
    <div style="display:flex;gap:8px;margin-bottom:6px;">
      <button id="btnGameplay" class="btn btn-secondary layout-btn" onclick="setLayout('gameplay')" style="flex:1;font-size:12px;padding:9px 8px;">⊞ Gameplay (2-panel)</button>
      <button id="btnTalking" class="btn btn-secondary layout-btn" onclick="setLayout('talking')" style="flex:1;font-size:12px;padding:9px 8px;">◉ Talking (full crop)</button>
    </div>
    <div style="font-size:11px;color:#6a6a7a;margin-bottom:4px;">Drag boxes on video to position · drag <b style="color:#a0a0b0">↘</b> corner to resize</div>
  </div>

  <div class="info-bar">
    <div class="info-item"><span class="label">Flash: </span><span class="value" id="flashDuration" style="color:#f59e0b">2.0s</span></div>
    <div class="info-item"><span class="label">Content: </span><span class="value" id="clipDuration">0.0s</span></div>
    <div class="info-item"><span class="label">Total output: </span><span class="value" id="totalOutput">0.0s</span></div>
    <div class="info-item"><span class="label">Target: </span><span class="value accent" id="targetRange">25-40s</span></div>
    <div class="info-item"><span class="label">Virality: </span><span class="value accent" id="viralityDisplay">0</span></div>
  </div>

  <div class="clip-meta" id="clipMeta">
    <div class="shot-label" id="shotLabel"></div>
    <div class="text" id="descriptionText"></div>
    <div class="caption" id="hookTextDisplay"></div>
    <div class="caption" id="titleDraftsDisplay" style="display:none;color:#8b8ba0;margin-top:4px;"></div>
  </div>

  <div style="margin-bottom:12px;">
    <textarea id="clipComment" rows="2" placeholder="Notes (e.g. 'ending cuts mid-sentence, trim 0.5s' or 'need different flash')"
      style="width:100%;padding:10px;border-radius:8px;background:#1a1a2a;color:#f5f5f0;border:1px solid #2a2a3a;font-size:13px;font-family:inherit;resize:vertical;"
      oninput="commentState[currentIndex]=this.value;scheduleAutoSave()"></textarea>
  </div>

  <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
    <button class="btn" style="background:#ef4444;color:white;flex:1" id="rejectBtn" onclick="toggleReject()">Reject Clip</button>
    <select id="reserveSelect" style="flex:1;padding:8px;border-radius:8px;background:#2a2a3a;color:#f5f5f0;border:1px solid #3a3a4a;display:none;font-size:13px">
      <option value="">Replace with reserve...</option>
    </select>
  </div>

  <div class="nav">
    <button class="btn btn-secondary" id="prevBtn" onclick="navigate(-1)">&larr; Prev</button>
    <button class="btn btn-primary" id="nextBtn" onclick="navigate(1)">Next &rarr;</button>
  </div>

  <button class="btn-finalize" onclick="showSummary()">Review Summary</button>

  <div class="summary" id="summary">
    <h3>Trim Summary</h3>
    <table>
      <thead><tr><th>#</th><th>Clip</th><th>V</th><th>Flash</th><th>Start</th><th>End</th><th>Total</th><th>Target</th></tr></thead>
      <tbody id="summaryBody"></tbody>
      <tfoot id="summaryFoot"></tfoot>
    </table>
    <button class="btn-finalize" style="margin-top:12px" onclick="finalize()">Finalize &amp; Trim All Clips</button>
  </div>
</div>

<script>
const DATA = ${clipDataJson};
const video = document.getElementById("video");
const startSlider = document.getElementById("startSlider");
const endSlider = document.getElementById("endSlider");
const shiftSlider = document.getElementById("shiftSlider");
const flashStartSlider = document.getElementById("flashStartSlider");
const flashEndSlider = document.getElementById("flashEndSlider");

let currentIndex = 0;
let trimState = {};
let flashState = {}; // {start, end} per clip
let videoDuration = 0;
let isPlaying = false;
let previewEndTime = null;

document.getElementById("title").textContent = "Clip Trimmer \\u2014 " + DATA.streamTitle.slice(0, 60);
document.getElementById("subtitle").textContent = DATA.clips.length + " clips | Stream: " + DATA.streamId;

// Build clip dots
const navEl = document.getElementById("clipNav");
DATA.clips.forEach((c, i) => {
  const dot = document.createElement("div");
  dot.className = "clip-dot" + (i === 0 ? " active" : "");
  dot.onclick = () => loadClip(i);
  dot.title = "#" + c.rank + " " + c.description.slice(0, 30) + " (v:" + c.viralityScore + ")";
  navEl.appendChild(dot);
});

// Pre-set trim state and flash state
DATA.clips.forEach((c, i) => {
  trimState[i] = {
    startTime: c.initialContentStart ?? 0,
    endTime: c.initialContentEnd ?? 9999,
    adjusted: false,
  };
  flashState[i] = {
    start: c.initialFlashStart ?? 0,
    end: c.initialFlashEnd ?? 2,
  };
});

// Time overlay update
video.addEventListener("timeupdate", () => {
  document.getElementById("timeOverlay").textContent = video.currentTime.toFixed(2) + "s";
  updateSeekbar();
  if (previewEndTime !== null && video.currentTime >= previewEndTime) {
    video.pause();
    previewEndTime = null;
    updatePlayBtn();
  }
});

function togglePause() {
  if (video.paused) { video.play(); } else { video.pause(); }
  updatePlayBtn();
}

function togglePlay() {
  if (video.paused) {
    // Play from wherever the cursor is
    video.play();
  } else {
    video.pause();
    previewEndTime = null;
  }
  updatePlayBtn();
}

function previewContent() {
  const s = trimState[currentIndex];
  video.currentTime = s.startTime;
  previewEndTime = s.endTime;
  video.play();
  updatePlayBtn();
}

function setStartHere() {
  const t = video.currentTime;
  trimState[currentIndex].startTime = t;
  trimState[currentIndex].adjusted = true;
  startSlider.value = Math.floor(t * 100);
  const mid = (t + trimState[currentIndex].endTime) / 2;
  shiftSlider.value = Math.floor(mid * 100);
  updateDisplay();
}

function setEndHere() {
  const t = video.currentTime;
  trimState[currentIndex].endTime = t;
  trimState[currentIndex].adjusted = true;
  endSlider.value = Math.floor(t * 100);
  const mid = (trimState[currentIndex].startTime + t) / 2;
  shiftSlider.value = Math.floor(mid * 100);
  updateDisplay();
}

function setFlashStartHere() {
  const t = video.currentTime;
  if (!flashState[currentIndex]) flashState[currentIndex] = {start: 0, end: 2};
  flashState[currentIndex].start = t;
  if (flashState[currentIndex].end <= t) flashState[currentIndex].end = t + 1;
  trimState[currentIndex].adjusted = true;
  flashStartSlider.value = Math.floor(t * 100);
  updateDisplay();
}

function setFlashEndHere() {
  const t = video.currentTime;
  if (!flashState[currentIndex]) flashState[currentIndex] = {start: 0, end: 2};
  flashState[currentIndex].end = t;
  if (flashState[currentIndex].start >= t) flashState[currentIndex].start = Math.max(0, t - 1);
  trimState[currentIndex].adjusted = true;
  flashEndSlider.value = Math.floor(t * 100);
  updateDisplay();
}

function updatePlayBtn() {
  const btn = document.getElementById("playBtn");
  isPlaying = !video.paused;
  btn.innerHTML = isPlaying ? "&#10074;&#10074; Pause" : "&#9654; Preview";
}

function loadClip(index) {
  currentIndex = index;
  const clip = DATA.clips[index];

  video.src = "/clips/" + encodeURIComponent(clip.clipFile);
  video.load();

  video.onloadedmetadata = () => {
    videoDuration = video.duration;
    // First load: set end to actual video duration
    if (trimState[index].endTime > videoDuration) {
      trimState[index].endTime = videoDuration;
    }
    if (trimState[index].startTime > videoDuration) {
      trimState[index].startTime = 0;
    }

    const res = 100;
    startSlider.max = Math.floor(videoDuration * res);
    endSlider.max = Math.floor(videoDuration * res);
    shiftSlider.max = Math.floor(videoDuration * res);
    flashStartSlider.max = Math.floor(videoDuration * res);
    flashEndSlider.max = Math.floor(videoDuration * res);

    syncSliders();
    updateDisplay();
    video.currentTime = trimState[index].startTime;
  };

  // Virality badge
  const vScore = clip.viralityScore;
  const vClass = vScore >= 8 ? "v-high" : vScore >= 6 ? "v-mid" : "v-low";

  document.getElementById("shotLabel").innerHTML =
    "#" + clip.rank + " \\u2014 " + clip.layoutMode.toUpperCase() +
    ' <span class="virality-badge ' + vClass + '">V:' + vScore + '/10</span>';
  document.getElementById("descriptionText").textContent = clip.description;
  document.getElementById("hookTextDisplay").textContent = clip.hookText ? "Hook: " + clip.hookText : "";
  const tdEl = document.getElementById("titleDraftsDisplay");
  if (clip.titleDrafts && clip.titleDrafts.length > 0) {
    tdEl.style.display = "block";
    tdEl.innerHTML = "Title drafts:<br>" + clip.titleDrafts.map((t, i) => "  " + (i+1) + ". " + t).join("<br>");
  } else {
    tdEl.style.display = "none";
  }
  document.getElementById("targetBadge").textContent = "Target: " + clip.targetMin + "-" + clip.targetMax + "s";
  document.getElementById("targetRange").textContent = clip.targetMin + "-" + clip.targetMax + "s";
  document.getElementById("viralityDisplay").textContent = vScore + "/10";
  // layoutDisplay removed from UI

  document.querySelectorAll(".clip-dot").forEach((dot, i) => {
    dot.className = "clip-dot" + (i === currentIndex ? " active" : "") + (trimState[i]?.adjusted ? " done" : "");
  });

  document.getElementById("prevBtn").disabled = index === 0;
  document.getElementById("nextBtn").textContent = index === DATA.clips.length - 1 ? "Review \\u2192" : "Next \\u2192";
  document.getElementById("revertBtn").disabled = !savedStates[index];
  document.getElementById("clipComment").value = commentState[index] || "";

  initLayoutState(index);
  updateLayoutButtons();
  renderOverlay();

  // Reset reject UI
  const rState = rejectState[index];
  const rBtn = document.getElementById("rejectBtn");
  const rSel = document.getElementById("reserveSelect");
  document.querySelector(".player-area").style.opacity = "1";
  if (rState?.rejected) {
    rBtn.textContent = "Undo Reject";
    rBtn.style.background = "#a0a0b0";
    rSel.style.display = "block";
    if (rState.replacedWith) { rSel.value = rState.replacedWith; }
  } else {
    rBtn.textContent = "Reject Clip";
    rBtn.style.background = "#ef4444";
    rSel.style.display = "none";
  }
}

function syncSliders() {
  const s = trimState[currentIndex];
  const res = 100;
  startSlider.value = Math.floor(s.startTime * res);
  endSlider.value = Math.floor(s.endTime * res);
  const mid = (s.startTime + s.endTime) / 2;
  shiftSlider.value = Math.floor(mid * res);
  const fs = flashState[currentIndex] || {start:0, end:2};
  flashStartSlider.value = Math.floor(fs.start * res);
  flashEndSlider.value = Math.floor(fs.end * res);
}

startSlider.oninput = () => {
  const t = parseInt(startSlider.value) / 100;
  trimState[currentIndex].startTime = t;
  trimState[currentIndex].adjusted = true;
  video.currentTime = t;
  const mid = (t + trimState[currentIndex].endTime) / 2;
  shiftSlider.value = Math.floor(mid * 100);
  updateDisplay();
};

endSlider.oninput = () => {
  const t = parseInt(endSlider.value) / 100;
  trimState[currentIndex].endTime = t;
  trimState[currentIndex].adjusted = true;
  video.currentTime = t;
  const mid = (trimState[currentIndex].startTime + t) / 2;
  shiftSlider.value = Math.floor(mid * 100);
  updateDisplay();
};

shiftSlider.oninput = () => {
  const s = trimState[currentIndex];
  const dur = s.endTime - s.startTime;
  const newMid = parseInt(shiftSlider.value) / 100;
  let newStart = newMid - dur / 2;
  let newEnd = newMid + dur / 2;
  if (newStart < 0) { newStart = 0; newEnd = dur; }
  if (newEnd > videoDuration) { newEnd = videoDuration; newStart = videoDuration - dur; }
  s.startTime = Math.max(0, newStart);
  s.endTime = Math.min(videoDuration, newEnd);
  s.adjusted = true;
  startSlider.value = Math.floor(s.startTime * 100);
  endSlider.value = Math.floor(s.endTime * 100);
  video.currentTime = s.startTime;
  updateDisplay();
};

flashStartSlider.oninput = () => {
  const t = parseInt(flashStartSlider.value) / 100;
  if (!flashState[currentIndex]) flashState[currentIndex] = {start:0, end:2};
  flashState[currentIndex].start = t;
  if (flashState[currentIndex].end <= t) flashState[currentIndex].end = t + 1;
  trimState[currentIndex].adjusted = true;
  video.currentTime = t;
  updateDisplay();
};

flashEndSlider.oninput = () => {
  const t = parseInt(flashEndSlider.value) / 100;
  if (!flashState[currentIndex]) flashState[currentIndex] = {start:0, end:2};
  flashState[currentIndex].end = t;
  if (flashState[currentIndex].start >= t) flashState[currentIndex].start = Math.max(0, t - 1);
  trimState[currentIndex].adjusted = true;
  video.currentTime = t;
  updateDisplay();
};

function previewFlash() {
  const fs = flashState[currentIndex] || {start:0, end:2};
  video.currentTime = fs.start;
  previewEndTime = fs.end;
  video.play();
  updatePlayBtn();
}

function updateDisplay() {
  const s = trimState[currentIndex];
  document.getElementById("startTime").textContent = s.startTime.toFixed(2) + "s";
  document.getElementById("endTime").textContent = s.endTime.toFixed(2) + "s";
  const fs = flashState[currentIndex] || {start:0, end:2};
  const flashDur = Math.max(0, fs.end - fs.start);
  document.getElementById("flashStartTime").textContent = fs.start.toFixed(2) + "s";
  document.getElementById("flashEndTime").textContent = fs.end.toFixed(2) + "s";
  document.getElementById("flashDuration").textContent = flashDur.toFixed(1) + "s";
  const clipDur = Math.max(0, s.endTime - s.startTime);
  const totalOut = clipDur + flashDur;
  document.getElementById("totalOutput").textContent = totalOut.toFixed(1) + "s";
  const clip = DATA.clips[currentIndex];
  const durEl = document.getElementById("clipDuration");
  durEl.textContent = clipDur.toFixed(1) + "s";
  // Color code: green if in target range, yellow if close, red if way off
  if (clipDur >= clip.targetMin && clipDur <= clip.targetMax) {
    durEl.className = "value good";
  } else if (clipDur >= clip.targetMin - 5 && clipDur <= clip.targetMax + 10) {
    durEl.className = "value accent";
  } else {
    durEl.className = "value over-budget";
  }
  document.getElementById("shiftTime").textContent = clipDur.toFixed(1) + "s";
  updateSeekbar();
  scheduleAutoSave();
}

function stepFrame(frames) {
  video.currentTime = Math.max(0, Math.min(videoDuration, video.currentTime + frames / 30));
  document.getElementById("timeOverlay").textContent = video.currentTime.toFixed(2) + "s";
}

// ── Speed control ──
let currentSpeed = 1;
function setSpeed(speed) {
  currentSpeed = speed;
  video.playbackRate = speed;
  document.getElementById("speedBadge").textContent = speed + "x";
}

// ── Seekbar ──
const seekbar = document.getElementById("seekbar");
const seekProgress = document.getElementById("seekProgress");
const seekHandle = document.getElementById("seekHandle");
const seekFlashEl = document.getElementById("seekFlash");
const seekContentEl = document.getElementById("seekContent");
const seekTimeEl = document.getElementById("seekTime");
let isSeeking = false;

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ":" + (sec < 10 ? "0" : "") + sec;
}

function updateSeekbar() {
  if (!videoDuration) return;
  const pct = (video.currentTime / videoDuration) * 100;
  seekProgress.style.width = pct + "%";
  seekHandle.style.left = pct + "%";
  seekTimeEl.textContent = fmtTime(video.currentTime) + " / " + fmtTime(videoDuration);

  // Show flash and content ranges on seekbar
  const fs = flashState[currentIndex] || {start:0, end:2};
  const s = trimState[currentIndex];
  seekFlashEl.style.left = (fs.start / videoDuration * 100) + "%";
  seekFlashEl.style.width = ((fs.end - fs.start) / videoDuration * 100) + "%";
  seekContentEl.style.left = (s.startTime / videoDuration * 100) + "%";
  seekContentEl.style.width = ((s.endTime - s.startTime) / videoDuration * 100) + "%";
}

seekbar.addEventListener("mousedown", (e) => {
  isSeeking = true;
  seekTo(e);
});
document.addEventListener("mousemove", (e) => {
  if (isSeeking) seekTo(e);
});
document.addEventListener("mouseup", () => { isSeeking = false; });

function seekTo(e) {
  const rect = seekbar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  video.currentTime = pct * videoDuration;
  updateSeekbar();
  document.getElementById("timeOverlay").textContent = video.currentTime.toFixed(2) + "s";
}

function navigate(dir) {
  const next = currentIndex + dir;
  if (next >= 0 && next < DATA.clips.length) {
    video.pause(); previewEndTime = null; updatePlayBtn();
    loadClip(next);
  } else if (next >= DATA.clips.length) {
    showSummary();
  }
}

function nudgeSlider(which, frames) {
  const step = frames / 30;
  const s = trimState[currentIndex];
  if (which === 'flashStart') {
    if (!flashState[currentIndex]) flashState[currentIndex] = {start:0, end:2};
    flashState[currentIndex].start = Math.max(0, Math.min(videoDuration, flashState[currentIndex].start + step));
    video.currentTime = flashState[currentIndex].start;
  } else if (which === 'flashEnd') {
    if (!flashState[currentIndex]) flashState[currentIndex] = {start:0, end:2};
    flashState[currentIndex].end = Math.max(0, Math.min(videoDuration, flashState[currentIndex].end + step));
    video.currentTime = flashState[currentIndex].end;
  } else if (which === 'start') {
    s.startTime = Math.max(0, Math.min(videoDuration, s.startTime + step));
    video.currentTime = s.startTime;
  } else if (which === 'end') {
    s.endTime = Math.max(0, Math.min(videoDuration, s.endTime + step));
    video.currentTime = s.endTime;
  } else if (which === 'shift') {
    const dur = s.endTime - s.startTime;
    let newStart = s.startTime + step;
    let newEnd = s.endTime + step;
    if (newStart < 0) { newStart = 0; newEnd = dur; }
    if (newEnd > videoDuration) { newEnd = videoDuration; newStart = videoDuration - dur; }
    s.startTime = newStart;
    s.endTime = newEnd;
    video.currentTime = s.startTime;
  }
  s.adjusted = true;
  syncSliders();
  updateDisplay();
}

let savedStates = {};
function saveState() {
  const s = trimState[currentIndex];
  savedStates[currentIndex] = { startTime: s.startTime, endTime: s.endTime };
  document.getElementById("revertBtn").disabled = false;
}
function revertState() {
  const saved = savedStates[currentIndex];
  if (!saved) return;
  trimState[currentIndex].startTime = saved.startTime;
  trimState[currentIndex].endTime = saved.endTime;
  video.currentTime = saved.startTime;
  syncSliders();
  updateDisplay();
}

let commentState = {};
let rejectState = {};

// Auto-save state to server periodically and on changes
let autoSaveTimer = null;
function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    fetch("/save-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trimState, flashState, rejectState, commentState, layoutState }),
    }).catch(() => {});
  }, 2000);
}

// Restore state from server on page load
fetch("/load-state").then(r => r.json()).then(state => {
  if (state && state.trimState) {
    // Merge saved state (only for clips that exist)
    Object.keys(state.trimState).forEach(k => {
      if (trimState[k]) Object.assign(trimState[k], state.trimState[k]);
    });
    if (state.flashState) {
      Object.keys(state.flashState).forEach(k => {
        if (flashState[k] !== undefined) flashState[k] = state.flashState[k];
      });
    }
    if (state.rejectState) rejectState = state.rejectState;
    if (state.commentState) commentState = state.commentState;
    if (state.layoutState) {
      Object.keys(state.layoutState).forEach(k => { layoutState[k] = state.layoutState[k]; });
    }
    console.log("Restored saved trim state");
    loadClip(0);
    updateDots();
  }
}).catch(() => {});

const reserveSelect = document.getElementById("reserveSelect");
(DATA.reserveClips || []).forEach(f => {
  const opt = document.createElement("option");
  opt.value = f; opt.textContent = f;
  reserveSelect.appendChild(opt);
});

reserveSelect.onchange = () => {
  const val = reserveSelect.value;
  if (val && rejectState[currentIndex]?.rejected) {
    rejectState[currentIndex].replacedWith = val;
    video.src = "/clips/" + encodeURIComponent(val);
    video.load();
    video.onloadedmetadata = () => {
      videoDuration = video.duration;
      trimState[currentIndex] = { startTime: 0, endTime: videoDuration, adjusted: true };
      syncSliders();
      updateDisplay();
    };
  }
};

function toggleReject() {
  if (!rejectState[currentIndex]) rejectState[currentIndex] = { rejected: false };
  rejectState[currentIndex].rejected = !rejectState[currentIndex].rejected;
  const btn = document.getElementById("rejectBtn");
  const sel = document.getElementById("reserveSelect");
  if (rejectState[currentIndex].rejected) {
    btn.textContent = "Undo Reject"; btn.style.background = "#a0a0b0"; sel.style.display = "block";
  } else {
    btn.textContent = "Reject Clip"; btn.style.background = "#ef4444"; sel.style.display = "none";
    document.querySelector(".player-area").style.opacity = "1";
    delete rejectState[currentIndex].replacedWith;
    loadClip(currentIndex);
  }
  updateDots();
  scheduleAutoSave();
}

function updateDots() {
  document.querySelectorAll(".clip-dot").forEach((dot, i) => {
    let cls = "clip-dot";
    if (i === currentIndex) cls += " active";
    else if (rejectState[i]?.rejected) { dot.style.background = "#ef4444"; return; }
    else if (trimState[i]?.adjusted) cls += " done";
    dot.className = cls;
    dot.style.background = "";
  });
}

function showSummary() {
  const tbody = document.getElementById("summaryBody");
  const tfoot = document.getElementById("summaryFoot");
  tbody.innerHTML = "";
  let approvedCount = 0;
  let rejectedCount = 0;

  DATA.clips.forEach((c, i) => {
    const s = trimState[i];
    const r = rejectState[i];
    const isRejected = r?.rejected;
    const dur = isRejected ? 0 : Math.max(0, s.endTime - s.startTime);
    if (isRejected) rejectedCount++; else approvedCount++;

    const fsi = flashState[i] || {start:0, end:2};
    const flashDur = Math.max(0, fsi.end - fsi.start);
    const totalDur = dur + flashDur;
    const inRange = totalDur >= c.targetMin && totalDur <= c.targetMax;
    const row = document.createElement("tr");
    row.style.opacity = isRejected ? "0.4" : "1";
    row.style.textDecoration = isRejected ? "line-through" : "none";
    row.innerHTML =
      '<td>' + c.rank + '</td>' +
      '<td>' + c.description.slice(0,30) + (isRejected ? ' <span style="color:#ef4444">[REJ]</span>' : '') + '</td>' +
      '<td>' + c.viralityScore + '</td>' +
      '<td class="mono" style="color:#f59e0b">' + fsi.start.toFixed(1) + '-' + fsi.end.toFixed(1) + 's (' + flashDur.toFixed(1) + 's)</td>' +
      '<td class="mono">' + s.startTime.toFixed(2) + 's</td>' +
      '<td class="mono">' + s.endTime.toFixed(2) + 's</td>' +
      '<td class="mono" style="color:' + (isRejected ? '#666' : inRange ? '#22c55e' : '#ef4444') + '">' + (isRejected ? '\\u2014' : totalDur.toFixed(1) + 's') + '</td>' +
      '<td class="mono">' + c.targetMin + '-' + c.targetMax + 's</td>';
    tbody.appendChild(row);
  });

  tfoot.innerHTML =
    '<tr style="border-top:2px solid #d4a017"><td colspan="7" style="text-align:right;color:#a0a0b0;padding-top:8px">' +
    '<span style="color:#22c55e">' + approvedCount + ' approved</span>' +
    (rejectedCount > 0 ? ' &middot; <span style="color:#ef4444">' + rejectedCount + ' rejected</span>' : '') +
    '</td></tr>';

  document.getElementById("summary").style.display = "block";
  document.getElementById("summary").scrollIntoView({ behavior: "smooth" });
}

let finalizeInProgress = false;
async function finalize() {
  if (finalizeInProgress) {
    alert("Finalization already in progress! Check terminal for progress.");
    return;
  }
  finalizeInProgress = true;

  // Disable button immediately
  const btns = document.querySelectorAll(".btn-finalize");
  btns.forEach(b => { b.disabled = true; b.textContent = "Processing..."; b.style.opacity = "0.5"; });

  const trimData = DATA.clips.map((c, i) => {
    const s = trimState[i];
    const r = rejectState[i];
    const ls = layoutState[i];
    return {
      rank: c.rank,
      clipFile: c.clipFile,
      flashStart: (flashState[i] || {start:0}).start,
      flashDuration: Math.max(0, ((flashState[i] || {end:2}).end) - ((flashState[i] || {start:0}).start)),
      startTime: s.startTime,
      endTime: s.endTime,
      duration: Math.max(0, s.endTime - s.startTime),
      status: r?.rejected ? (r.replacedWith ? "replaced" : "rejected") : "approved",
      replacedWith: r?.replacedWith || undefined,
      comment: commentState[i] || "",
      layoutMode: ls?.mode || c.layoutMode || "gameplay",
      avatarRegion: ls?.avatar || null,
      gameplayRegion: ls?.gameplay || null,
      cropX: ls?.cropX ?? null,
    };
  });

  try {
    const res = await fetch("/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trimData),
    });
    const result = await res.json();
    if (result.success) {
      let msg = "Done! Saved trim decisions for " + result.trimmedCount + " clips.";
      if (result.rejectedCount > 0) msg += "\\n" + result.rejectedCount + " clip(s) rejected.";
      msg += "\\n\\nOriginals backed up to raw-clips-backup/.";
      msg += "\\nffmpeg processing running in background — check terminal for progress.";
      msg += "\\nServer will shut down when complete.";
      document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;color:#22c55e;font-size:20px;font-family:system-ui;text-align:center;padding:40px">\\u2713 ' + msg.replace(/\\n/g, '<br>') + '</div>';
    } else {
      finalizeInProgress = false;
      btns.forEach(b => { b.disabled = false; b.textContent = "Finalize & Trim All Clips"; b.style.opacity = "1"; });
      alert("Error: " + result.error);
    }
  } catch (e) {
    finalizeInProgress = false;
    btns.forEach(b => { b.disabled = false; b.textContent = "Finalize & Trim All Clips"; b.style.opacity = "1"; });
    alert("Error: " + e.message);
  }
}

// ── Layout & Crop Overlay ──
const channelConfig = DATA.channelConfig || {};
const defaultAvatar   = channelConfig.avatarRegion   || {x:0, y:0, w:1620, h:1080};
const defaultGameplay = channelConfig.gameplayRegion || {x:408, y:0, w:1320, h:1080};

let layoutState = {}; // clipIndex → { mode, avatar:{x,y,w,h}, gameplay:{x,y,w,h}, cropX }

function initLayoutState(i) {
  if (layoutState[i]) return;
  const clip = DATA.clips[i];
  layoutState[i] = {
    mode: clip.layoutMode || "gameplay",
    avatar:   { ...defaultAvatar },
    gameplay: { ...defaultGameplay },
    cropX: defaultAvatar.x
  };
}

function setLayout(mode) {
  initLayoutState(currentIndex);
  layoutState[currentIndex].mode = mode;
  trimState[currentIndex].adjusted = true;
  updateLayoutButtons();
  renderOverlay();
  scheduleAutoSave();
}

function updateLayoutButtons() {
  const mode = layoutState[currentIndex]?.mode || "gameplay";
  document.getElementById("btnGameplay").classList.toggle("active", mode === "gameplay");
  document.getElementById("btnTalking").classList.toggle("active", mode === "talking");
}

// Returns the actual rendered video content area within the element (accounts for object-fit:contain)
function getVideoContentRect() {
  const elW = video.offsetWidth  || 1;
  const elH = video.offsetHeight || 1;
  const vW  = video.videoWidth   || 1920;
  const vH  = video.videoHeight  || 1080;
  const srcAspect = vW / vH;
  const elAspect  = elW / elH;
  let w, h, x, y;
  if (srcAspect > elAspect) { w = elW; h = elW / srcAspect; x = 0; y = (elH - h) / 2; }
  else                      { h = elH; w = elH * srcAspect;  y = 0; x = (elW - w) / 2; }
  return { x, y, w, h, srcW: vW, srcH: vH };
}

function srcToDisp(sx, sy, sw, sh, vr) {
  const scaleX = vr.w / vr.srcW, scaleY = vr.h / vr.srcH;
  return { x: vr.x + sx*scaleX, y: vr.y + sy*scaleY, w: sw*scaleX, h: sh*scaleY };
}

function dispToSrc(dx, dy, dw, dh, vr) {
  const scaleX = vr.srcW / vr.w, scaleY = vr.srcH / vr.h;
  return {
    x: Math.round((dx - vr.x) * scaleX),
    y: Math.round((dy - vr.y) * scaleY),
    w: Math.round(dw * scaleX),
    h: Math.round(dh * scaleY)
  };
}

function renderOverlay() {
  initLayoutState(currentIndex);
  const ls = layoutState[currentIndex];
  const overlay  = document.getElementById("cropOverlay");
  const tBox     = document.getElementById("talkingBox");
  const aBox     = document.getElementById("avatarBox");
  const gBox     = document.getElementById("gameplayBox");

  overlay.style.height = video.offsetHeight + "px";

  const vr = getVideoContentRect();

  if (ls.mode === "talking") {
    tBox.style.display = "block";
    aBox.style.display = "none";
    gBox.style.display = "none";
    // talking crop: width = ih*(9/16) ≈ 607px, height = full ih (1080px), x = cropX, y = 0
    const srcW = Math.round(1080 * 9 / 16);
    const d = srcToDisp(ls.cropX, 0, srcW, 1080, vr);
    tBox.style.left   = d.x + "px";
    tBox.style.top    = d.y + "px";
    tBox.style.width  = d.w + "px";
    tBox.style.height = d.h + "px";
    document.getElementById("talkingCoords").textContent = "cropX:" + ls.cropX;
  } else {
    tBox.style.display = "none";
    aBox.style.display = "block";
    gBox.style.display = "block";
    const ad = srcToDisp(ls.avatar.x, ls.avatar.y, ls.avatar.w, ls.avatar.h, vr);
    aBox.style.left   = ad.x + "px";  aBox.style.top    = ad.y + "px";
    aBox.style.width  = ad.w + "px";  aBox.style.height = ad.h + "px";
    document.getElementById("avatarCoords").textContent =
      ls.avatar.x + "," + ls.avatar.y + " " + ls.avatar.w + "×" + ls.avatar.h;
    const gd = srcToDisp(ls.gameplay.x, ls.gameplay.y, ls.gameplay.w, ls.gameplay.h, vr);
    gBox.style.left   = gd.x + "px";  gBox.style.top    = gd.y + "px";
    gBox.style.width  = gd.w + "px";  gBox.style.height = gd.h + "px";
    document.getElementById("gameplayCoords").textContent =
      ls.gameplay.x + "," + ls.gameplay.y + " " + ls.gameplay.w + "×" + ls.gameplay.h;
  }
}

function updateCropFromBoxes() {
  const ls = layoutState[currentIndex];
  if (!ls) return;
  const vr = getVideoContentRect();
  if (ls.mode === "talking") {
    const b = document.getElementById("talkingBox");
    const src = dispToSrc(b.offsetLeft, b.offsetTop, b.offsetWidth, b.offsetHeight, vr);
    const maxCropX = 1920 - Math.round(1080 * 9 / 16);
    ls.cropX = Math.max(0, Math.min(maxCropX, src.x));
    document.getElementById("talkingCoords").textContent = "cropX:" + ls.cropX;
  } else {
    const ab = document.getElementById("avatarBox");
    const gb = document.getElementById("gameplayBox");
    const a = dispToSrc(ab.offsetLeft, ab.offsetTop, ab.offsetWidth, ab.offsetHeight, vr);
    const g = dispToSrc(gb.offsetLeft, gb.offsetTop, gb.offsetWidth, gb.offsetHeight, vr);
    ls.avatar   = { x: Math.max(0, a.x), y: Math.max(0, a.y), w: Math.max(10, a.w), h: Math.max(10, a.h) };
    ls.gameplay = { x: Math.max(0, g.x), y: Math.max(0, g.y), w: Math.max(10, g.w), h: Math.max(10, g.h) };
    document.getElementById("avatarCoords").textContent =
      ls.avatar.x + "," + ls.avatar.y + " " + ls.avatar.w + "×" + ls.avatar.h;
    document.getElementById("gameplayCoords").textContent =
      ls.gameplay.x + "," + ls.gameplay.y + " " + ls.gameplay.w + "×" + ls.gameplay.h;
  }
  trimState[currentIndex].adjusted = true;
}

function makeDraggable(boxEl) {
  boxEl.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("resize-handle")) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const origL = boxEl.offsetLeft, origT = boxEl.offsetTop;
    const overlay = document.getElementById("cropOverlay");
    const onMove = (e) => {
      const maxL = overlay.offsetWidth  - boxEl.offsetWidth;
      const maxT = overlay.offsetHeight - boxEl.offsetHeight;
      boxEl.style.left = Math.max(0, Math.min(maxL, origL + e.clientX - startX)) + "px";
      boxEl.style.top  = Math.max(0, Math.min(maxT, origT + e.clientY - startY)) + "px";
      updateCropFromBoxes();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scheduleAutoSave();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function makeResizable(handleEl) {
  handleEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const boxEl = handleEl.parentElement;
    const startX = e.clientX, startY = e.clientY;
    const startW = boxEl.offsetWidth, startH = boxEl.offsetHeight;
    const onMove = (e) => {
      boxEl.style.width  = Math.max(30, startW + e.clientX - startX) + "px";
      boxEl.style.height = Math.max(20, startH + e.clientY - startY) + "px";
      updateCropFromBoxes();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scheduleAutoSave();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// For talking box: only allow horizontal drag (lock height to video)
document.getElementById("talkingBox").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const box = document.getElementById("talkingBox");
  const startX = e.clientX, origL = box.offsetLeft;
  const overlay = document.getElementById("cropOverlay");
  const onMove = (e) => {
    const maxL = overlay.offsetWidth - box.offsetWidth;
    box.style.left = Math.max(0, Math.min(maxL, origL + e.clientX - startX)) + "px";
    updateCropFromBoxes();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    scheduleAutoSave();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

makeDraggable(document.getElementById("avatarBox"));
makeDraggable(document.getElementById("gameplayBox"));
makeResizable(document.getElementById("avatarResize"));
makeResizable(document.getElementById("gameplayResize"));

video.addEventListener("loadedmetadata", () => {
  renderOverlay();
});
window.addEventListener("resize", () => { renderOverlay(); });

loadClip(0);
</script>
</body>
</html>`;
}

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
