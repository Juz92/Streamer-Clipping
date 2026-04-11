/**
 * trim.ts — Browser-based interactive clip trimmer for gaming Shorts.
 *
 * Adapted from the Football Shorts clip-trimmer. Reads unified-moments.json
 * + raw-clips/ directory instead of a database. Shows each clip in a video
 * player with frame-level trim controls, then trims in-place with ffmpeg.
 *
 * Usage:
 *   npx tsx packages/clips/src/trim.ts --stream <id> [--port 3847]
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
import { findStreamDir, loadManifest } from "./lib/manifest.js";

const log = createLogger("trim");

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--stream")) {
    console.log("Usage: trim.ts --stream <id> [--port 3847]");
    console.log(
      "Opens a browser-based clip trimming tool for fine-tuning raw clip boundaries.",
    );
    process.exit(1);
  }

  const streamId = args[args.indexOf("--stream") + 1];
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 3847;

  const streamDir = findStreamDir(streamId);
  if (!streamDir) {
    log.error(`Stream directory not found for ${streamId}`);
    process.exit(1);
  }

  const manifest = loadManifest(streamId);
  const rawClipsDir = join(streamDir, "raw-clips");
  if (!existsSync(rawClipsDir)) {
    log.error(`No raw-clips/ directory found in ${streamDir}`);
    process.exit(1);
  }

  // Load unified-moments.json for clip metadata
  const unifiedPath = join(streamDir, "unified-moments.json");
  let moments: Array<{
    description?: string;
    hookText?: string;
    viralityScore?: number;
    layoutMode?: string;
    startSec?: number;
    endSec?: number;
    durationSec?: number;
    source?: string;
  }> = [];
  if (existsSync(unifiedPath)) {
    moments = JSON.parse(readFileSync(unifiedPath, "utf-8"));
  }

  // Scan raw-clips/ and match to moments by NN prefix
  const clipFiles = readdirSync(rawClipsDir)
    .filter((f) => f.endsWith(".mp4"))
    .sort();

  if (clipFiles.length === 0) {
    log.error("No .mp4 files found in raw-clips/");
    process.exit(1);
  }

  const clips = clipFiles.map((file) => {
    const rankMatch = file.match(/^(\d+)-/);
    const rank = rankMatch ? parseInt(rankMatch[1], 10) : 0;
    const moment = rank > 0 && rank <= moments.length ? moments[rank - 1] : null;
    return {
      rank,
      clipFile: file,
      description: moment?.description || file.replace(/^\d+-/, "").replace(/\.mp4$/, "").replace(/-/g, " "),
      hookText: moment?.hookText || "",
      viralityScore: moment?.viralityScore || 0,
      layoutMode: moment?.layoutMode || "gameplay",
      source: moment?.source || "manual",
      targetMin: 20,
      targetMax: 25,
    };
  });

  // Find reserve clips (files in raw-clips not matching standard NN- pattern)
  const standardFiles = new Set(clipFiles);
  const reserveClips = readdirSync(rawClipsDir)
    .filter((f) => f.endsWith(".mp4") && !f.match(/^\d+-/))
    .sort();

  const streamTitle = manifest.title || streamId;

  const clipData = JSON.stringify({
    streamId,
    streamTitle,
    clips: clips.map((c) => ({
      rank: c.rank,
      clipFile: c.clipFile,
      description: c.description,
      hookText: c.hookText,
      viralityScore: c.viralityScore,
      layoutMode: c.layoutMode,
      source: c.source,
      targetMin: c.targetMin,
      targetMax: c.targetMax,
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
      const filePath = join(rawClipsDir, file);
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
              const src = join(rawClipsDir, t.clipFile);
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
              const srcPath = join(rawClipsDir, srcFile).replace(/\\/g, "/");
              const flashPath = join(tempDir, `flash-${t.clipFile}`).replace(/\\/g, "/");
              const contentPath = join(tempDir, `content-${t.clipFile}`).replace(/\\/g, "/");
              const concatPath = join(tempDir, `concat-${t.clipFile}.txt`).replace(/\\/g, "/");
              const outPath = join(tempDir, `out-${t.clipFile}`).replace(/\\/g, "/");
              const destPath = join(rawClipsDir, t.clipFile);

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
</style>
</head>
<body>
<div class="container">
  <h1 id="title">Clip Trimmer</h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="clip-nav" id="clipNav"></div>

  <div class="player-area">
    <video id="video" preload="auto" onclick="togglePause()"></video>
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

    <div style="display:flex;gap:8px;justify-content:center;margin-top:8px;">
      <button class="btn btn-secondary" onclick="previewContent()" style="font-size:12px;padding:6px 16px;border:1px solid #22c55e;color:#22c55e;">Play Content</button>
      <button class="btn btn-secondary" onclick="saveState()" style="font-size:12px;padding:6px 16px;">Save</button>
      <button class="btn btn-secondary" onclick="revertState()" style="font-size:12px;padding:6px 16px;" id="revertBtn" disabled>Revert</button>
    </div>
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
  trimState[i] = { startTime: 0, endTime: 9999, adjusted: false };
  flashState[i] = { start: 0, end: 2 }; // default 2s flash at start
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
      body: JSON.stringify({ trimState, flashState, rejectState, commentState }),
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

loadClip(0);
</script>
</body>
</html>`;
}

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
