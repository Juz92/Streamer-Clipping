/**
 * heatmap-extractor.ts — Extract YouTube "most replayed" heatmap data.
 *
 * YouTube embeds an SVG heatmap on every video watch page:
 *   <svg class="ytp-heat-map-svg" viewBox="0 0 1000 100">
 *     <path class="ytp-heat-map-path" d="M 0,100 C 1,80 2,5.6 5,0 ...">
 *   </svg>
 *
 * The path uses cubic Bézier curves ("C" commands). Every third x,y pair
 * after a "C" — where x ends with 5.0 — is a usable data point:
 *   • x = timestamp %  →  normalize as (x - 5) / 1000
 *   • y = heat value   →  normalize as (100 - y) / 100
 *
 * Returns normalized (time, intensity) pairs from 0→1.
 *
 * Usage:
 *   const heat = await extractHeatmap("https://youtube.com/watch?v=VIDEO_ID");
 *   const peaks = findPeaks(heat, 3); // top 3 hottest moments
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export interface HeatPoint {
  /** 0.0 → 1.0 (start → end of video) */
  timePct: number;
  /** 0.0 → 1.0 (low → high replay intensity) */
  intensity: number;
}

interface HeatmapResult {
  videoId: string;
  extractedAt: string;
  points: HeatPoint[];
  durationSec?: number;
}

/** Parse a single cubic-bezier "C" block: "C x1,y1 x2,y2 x3,y3" */
function parseCubicBezierBlock(block: string): HeatPoint | null {
  // Extract all numbers from the block
  const nums = block.match(/-?\d+\.?\d*/g);
  if (!nums || nums.length < 6) return null;

  // The 6 numbers are: x1 y1 x2 y2 x3 y3
  // The usable data point is the 3rd pair (x3, y3)
  const x3 = parseFloat(nums[4]);
  const y3 = parseFloat(nums[5]);

  // Filter: x must end with 5.0 (per youtube-heatmap docs)
  if (Math.abs(x3 % 10 - 5) > 0.1 && Math.abs(x3 % 10) > 0.1) {
    // Some implementations accept any .0 or .5
    if (Math.abs(x3 % 5) > 0.1) return null;
  }

  // Normalize
  const timePct = Math.max(0, Math.min(1, (x3 - 5) / 1000));
  const intensity = Math.max(0, Math.min(1, (100 - y3) / 100));

  return { timePct, intensity };
}

/** Parse the full SVG path `d` attribute into heat points. */
export function parseHeatmapPath(d: string): HeatPoint[] {
  const points: HeatPoint[] = [];

  // Split by "C" commands — each C block is a cubic bezier curve
  const blocks = d.split(/C\s+/).slice(1); // skip initial "M" block

  for (const block of blocks) {
    const pt = parseCubicBezierBlock(block);
    if (pt) points.push(pt);
  }

  // Sort by time
  points.sort((a, b) => a.timePct - b.timePct);

  return points;
}

/** Extract heatmap from YouTube watch page HTML. */
export async function extractHeatmap(
  videoIdOrUrl: string,
): Promise<HeatmapResult | null> {
  const videoId = videoIdOrUrl.includes("v=")
    ? new URL(videoIdOrUrl).searchParams.get("v")!
    : videoIdOrUrl.replace(/[^a-zA-Z0-9_-]/g, "");

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      console.warn(`Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Find the SVG path — look for ytp-heat-map-path class
    const pathMatch = html.match(
      /<path[^>]*class="[^"]*ytp-heat-map-path[^"]*"[^>]*d="([^"]*)"/,
    );

    if (!pathMatch) {
      // Try alternate: the heatmap might be in a script/json block
      const scriptMatch = html.match(
        /"heatmap":"([^"]+)"/,
      );
      if (scriptMatch) {
        const d = scriptMatch[1].replace(/\\/g, "");
        const points = parseHeatmapPath(d);
        return { videoId, extractedAt: new Date().toISOString(), points };
      }

      console.warn(`No heatmap found for ${videoId} — may not be available yet`);
      return null;
    }

    const d = pathMatch[1];
    const points = parseHeatmapPath(d);

    return {
      videoId,
      extractedAt: new Date().toISOString(),
      points,
    };
  } catch (err) {
    console.warn(`Heatmap extraction failed: ${(err as Error).message}`);
    return null;
  }
}

/** Find the top N peak moments from heat points. */
export function findPeaks(
  points: HeatPoint[],
  count: number,
  minGapPct: number = 0.05,
): Array<{ timePct: number; intensity: number; rank: number }> {
  // Sort by intensity descending
  const sorted = [...points].sort((a, b) => b.intensity - a.intensity);

  const peaks: Array<{ timePct: number; intensity: number; rank: number }> = [];

  for (const pt of sorted) {
    // Skip if too close to an already-selected peak
    const tooClose = peaks.some(
      (p) => Math.abs(p.timePct - pt.timePct) < minGapPct,
    );
    if (tooClose) continue;

    peaks.push({
      timePct: pt.timePct,
      intensity: pt.intensity,
      rank: peaks.length + 1,
    });

    if (peaks.length >= count) break;
  }

  // Sort by time for chronological order
  peaks.sort((a, b) => a.timePct - b.timePct);

  return peaks;
}

/** Get heatmap intensity at a specific timestamp. */
export function getIntensityAt(
  points: HeatPoint[],
  timePct: number,
): number {
  // Find closest point
  let closest = points[0];
  let minDist = Infinity;

  for (const pt of points) {
    const dist = Math.abs(pt.timePct - timePct);
    if (dist < minDist) {
      minDist = dist;
      closest = pt;
    }
  }

  return closest.intensity;
}

/** Convert heat points to absolute timestamps. */
export function toAbsoluteTimes(
  points: HeatPoint[],
  durationSec: number,
): Array<{ timeSec: number; intensity: number }> {
  return points.map((p) => ({
    timeSec: Math.round(p.timePct * durationSec * 10) / 10,
    intensity: p.intensity,
  }));
}

/** Save heatmap result to disk. */
export function saveHeatmap(
  result: HeatmapResult,
  outDir: string,
): string {
  const path = join(outDir, `heatmap-${result.videoId}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2), "utf-8");
  return path;
}

/** Load cached heatmap from disk. */
export function loadHeatmap(
  videoId: string,
  outDir: string,
): HeatmapResult | null {
  const path = join(outDir, `heatmap-${videoId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as HeatmapResult;
  } catch {
    return null;
  }
}

/** Get average heatmap intensity in a time range (as percentage 0-1). */
export function getAverageIntensity(
  points: HeatPoint[],
  startPct: number,
  endPct: number,
): number {
  const inRange = points.filter((p) => p.timePct >= startPct && p.timePct <= endPct);
  if (inRange.length === 0) return 0;
  const sum = inRange.reduce((acc, p) => acc + p.intensity, 0);
  return sum / inRange.length;
}

/** Score a clip moment using heatmap data. Returns 0-15 bonus. */
export function scoreHeatmapBonus(
  points: HeatPoint[],
  momentStartPct: number,
  momentEndPct: number,
): number {
  const avgIntensity = getAverageIntensity(points, momentStartPct, momentEndPct);
  // Scale: 0.0 intensity = 0 bonus, 1.0 intensity = 15 bonus
  return Math.round(avgIntensity * 15);
}
/** CLI entry point for testing. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const videoId = args[0];

  if (!videoId) {
    console.log("Usage: npx tsx heatmap-extractor.ts <video-id-or-url>");
    console.log("Example: npx tsx heatmap-extractor.ts dQw4w9WgXcQ");
    process.exit(1);
  }

  console.log(`Extracting heatmap for ${videoId}...`);
  const result = await extractHeatmap(videoId);

  if (!result) {
    console.log("No heatmap available for this video.");
    console.log("Reasons:");
    console.log("  • Video is too new (< few hours old)");
    console.log("  • Video has insufficient views for heatmap generation");
    console.log("  • YouTube hasn't generated heatmap data yet");
    process.exit(0);
  }

  console.log(`\nFound ${result.points.length} data points`);
  console.log(`Extracted at: ${result.extractedAt}\n`);

  const peaks = findPeaks(result.points, 5);
  console.log("Top 5 peak moments (by replay intensity):");
  for (const p of peaks) {
    const pct = Math.round(p.timePct * 100);
    const intensity = Math.round(p.intensity * 100);
    console.log(
      `  ${pct}% into video — intensity: ${intensity}% (rank #${p.rank})`,
    );
  }

  // Show intensity distribution
  const buckets = [0, 0, 0, 0, 0]; // 0-20%, 20-40%, ..., 80-100%
  for (const pt of result.points) {
    const idx = Math.min(4, Math.floor(pt.intensity * 5));
    buckets[idx]++;
  }

  console.log("\nIntensity distribution:");
  const labels = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"];
  for (let i = 0; i < 5; i++) {
    const bar = "█".repeat(Math.round(buckets[i] / 2));
    console.log(`  ${labels[i]}: ${bar} (${buckets[i]} points)`);
  }
}

/** Check if this module is being run directly (ESM-compatible). */
const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
