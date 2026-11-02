/**
 * prepare-label-session.ts — Build a blind labelling session for one stream.
 *
 * Picks a deliberately mixed candidate set, cuts a clip per candidate, and
 * writes everything the labelling page needs. The page is opened by hand from
 * the printed path; nothing here serves or uploads anything.
 *
 * The mix matters more than the ranking. A session that only shows the ranker's
 * own top picks cannot tell a broken ranker from a boring stream, which is
 * exactly what the 2026-07 session produced when all ten were rejected.
 *
 * Usage:
 *   npx tsx packages/clips/src/prepare-label-session.ts --stream <id>
 *   npx tsx packages/clips/src/prepare-label-session.ts --stream <id> --count 8
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { createLogger } from "@ltx/shared";
import { findStreamDir } from "./lib/manifest.js";
import { GAMEPLAY_CONTENT_LANES } from "./lib/content-lanes.js";

const log = createLogger("label-session");
const HERE = dirname(fileURLToPath(import.meta.url));

interface Beats {
  setupStartSec: number;
  premiseClearSec: number;
  actionStartSec: number;
  payoffStartSec: number;
  payoffEndSec: number;
  reactionEndSec: number;
  flashSec?: number;
}

interface RankedCandidate {
  candidateId: string;
  momentId: string;
  description?: string;
  startSec: number;
  endSec: number;
  durationSec?: number;
  editorialStrength?: number;
  categories?: string[];
  recallRoutes?: string[];
}

interface GroundingRow {
  candidateId?: string;
  beats?: Beats;
  gates?: { visualProof?: boolean | null };
  evidence?: { visualProof?: unknown };
  categories?: string[];
}

/** What the pipeline can honestly propose, and what it cannot. */
interface Proposals {
  beats: Beats | null;
  primaryEvidenceModality: "dialogue" | "visual" | "hybrid" | null;
  visualProofRequired: boolean | null;
  /**
   * Deliberately absent. Nothing in arc grounding speaks to which carrier
   * supplies the missing context, or whether a bit is distinctive versus
   * tactical filler, so proposing a value would be inventing one.
   */
  contextCarrier: null;
  repetitionClass: null;
}

function parseArgs(): { streamId: string; count: number } {
  const args = process.argv.slice(2);
  let streamId = "";
  let count = 8;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) streamId = args[++i];
    else if (args[i] === "--count" && args[i + 1]) count = Number(args[++i]);
  }
  if (!streamId) throw new Error("--stream <id> is required");
  if (!Number.isInteger(count) || count < 2) throw new Error("--count must be an integer of at least 2");
  return { streamId, count };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function hasCompleteBeats(beats: Beats | undefined | null): boolean {
  if (!beats) return false;
  return [
    beats.setupStartSec, beats.premiseClearSec, beats.actionStartSec,
    beats.payoffStartSec, beats.payoffEndSec, beats.reactionEndSec,
  ].every((value) => Number.isFinite(value));
}

function propose(row: GroundingRow | undefined, candidate: RankedCandidate): Proposals {
  const categories = row?.categories ?? candidate.categories ?? [];
  const isGameplay = categories.some((c) => (GAMEPLAY_CONTENT_LANES as readonly string[]).includes(c));
  const hasVisualEvidence = row?.evidence?.visualProof != null;

  return {
    beats: hasCompleteBeats(row?.beats) ? (row?.beats as Beats) : null,
    // Grounding records visual evidence for only a small minority of
    // candidates; everything else is carried by what was said.
    primaryEvidenceModality: hasVisualEvidence ? (isGameplay ? "visual" : "hybrid") : "dialogue",
    // gates.visualProof is null for most candidates, so fall back to the lane:
    // a gameplay moment needs to show the thing it claims happened.
    visualProofRequired: row?.gates?.visualProof ?? (isGameplay ? true : false),
    contextCarrier: null,
    repetitionClass: null,
  };
}

/**
 * Three from the top, three from the middle, the rest from the bottom.
 *
 * The bottom slots stand in for the known-good seeds the protocol asks for:
 * no same-stream seeds exist, since the aligned official Shorts come from other
 * VODs whose source video is gone. Keeping a bottom-ranked clip is still a
 * strong signal that the ranking, not the stream, is the problem.
 */
function pickMix(ranked: RankedCandidate[], count: number): Array<RankedCandidate & { band: string }> {
  const top = Math.min(3, ranked.length);
  const mid = Math.min(3, Math.max(0, ranked.length - top));
  const low = Math.max(0, count - top - mid);
  const midStart = Math.max(top, Math.floor(ranked.length / 2) - Math.floor(mid / 2));

  const picked: Array<RankedCandidate & { band: string }> = [
    ...ranked.slice(0, top).map((c) => ({ ...c, band: "top" })),
    ...ranked.slice(midStart, midStart + mid).map((c) => ({ ...c, band: "mid" })),
    ...ranked.slice(Math.max(0, ranked.length - low)).map((c) => ({ ...c, band: "low" })),
  ];

  // Shuffle so the page cannot leak the band through position. Seeded by index
  // only -- a fixed order would let a second session recognise the first.
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked;
}

function cutClip(videoPath: string, startSec: number, durationSec: number, outPath: string): void {
  // -ss before -i seeks by keyframe without decoding the whole file, which
  // matters when the source is 10.7 GB. Re-encoded small so eight clips stay
  // quick to produce and quick to scrub.
  execFileSync("ffmpeg", [
    "-nostdin", "-y",
    "-ss", startSec.toFixed(3),
    "-i", videoPath,
    "-t", durationSec.toFixed(3),
    "-vf", "scale=640:-2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
    "-c:a", "aac", "-b:a", "128k",
    outPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

function main(): void {
  const { streamId, count } = parseArgs();
  const streamDir = findStreamDir(streamId);
  if (!streamDir) throw new Error(`No job directory found for ${streamId}`);

  const rankingPath = join(streamDir, "grounded-ranking.json");
  const groundingPath = join(streamDir, "arc-grounding.json");
  const manifestPath = join(streamDir, "manifest.json");
  for (const [label, path] of [["grounded-ranking.json", rankingPath], ["manifest.json", manifestPath]]) {
    if (!existsSync(path)) throw new Error(`${label} is missing; run the pipeline through grounded-rank first`);
  }

  const ranked = readJson<{ ranked?: RankedCandidate[] }>(rankingPath).ranked ?? [];
  if (ranked.length === 0) throw new Error("grounded-ranking.json has no ranked candidates");

  const grounding = new Map(
    (existsSync(groundingPath)
      ? readJson<{ results?: GroundingRow[] }>(groundingPath).results ?? []
      : []
    ).filter((row) => row.candidateId).map((row) => [row.candidateId as string, row]),
  );

  const videoPath = readJson<{ videoPath?: string }>(manifestPath).videoPath;
  if (!videoPath || !existsSync(videoPath)) throw new Error("manifest.videoPath is missing or absent on disk");

  const sessionDir = join(streamDir, "label-session");
  const clipsDir = join(sessionDir, "clips");
  mkdirSync(clipsDir, { recursive: true });

  const picked = pickMix(ranked, count);
  log.info(`Cutting ${picked.length} clips from ${videoPath}`);

  const candidates = picked.map((candidate, index) => {
    const slot = String(index + 1).padStart(2, "0");
    const file = `${slot}.mp4`;
    const duration = Math.max(1, (candidate.endSec ?? 0) - (candidate.startSec ?? 0));
    const outPath = join(clipsDir, file);
    if (!existsSync(outPath)) {
      cutClip(videoPath, candidate.startSec, duration, outPath);
    }
    log.info(`  ${slot}  ${duration.toFixed(0)}s  ${candidate.candidateId}`);
    return {
      slot,
      candidateId: candidate.candidateId,
      momentId: candidate.momentId,
      clip: `clips/${file}`,
      startSec: candidate.startSec,
      endSec: candidate.endSec,
      durationSec: duration,
      description: candidate.description ?? "",
      recallRoutes: candidate.recallRoutes ?? [],
      categories: candidate.categories ?? [],
      // Held back from the page so the session stays blind; kept here so the
      // resolution can report which bands were kept.
      band: candidate.band,
      editorialStrength: candidate.editorialStrength ?? null,
      proposals: propose(grounding.get(candidate.candidateId), candidate),
    };
  });

  const session = { version: 1, streamId, generatedAt: new Date().toISOString(), candidates };
  writeFileSync(join(sessionDir, "candidates.json"), JSON.stringify(session, null, 2), "utf-8");

  // Inlined rather than fetched: browsers block fetch() of a sibling file over
  // file://, and this page has to open with a double click, not a dev server.
  const template = readFileSync(join(HERE, "label-session.html"), "utf-8");
  if (!template.includes("__SESSION_JSON__")) throw new Error("label-session.html lost its data placeholder");
  writeFileSync(
    join(sessionDir, "index.html"),
    template.replace("__SESSION_JSON__", JSON.stringify(session).replace(/</g, "\u003c")),
    "utf-8",
  );

  log.info("");
  log.info(`Session ready: ${join(sessionDir, "index.html")}`);
  log.info("Open that file in a browser. It saves review-decision.json next to it when you finish.");
}

main();
