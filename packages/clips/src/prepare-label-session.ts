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
import { CONTENT_LANES, GAMEPLAY_CONTENT_LANES } from "./lib/content-lanes.js";

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
  gates?: {
    arcComplete?: boolean | null;
    visualProof?: boolean | null;
    contextIndependent?: boolean | null;
  };
  evidence?: { visualProof?: unknown };
  categories?: string[];
}

/**
 * Everything the gate needs except the one judgement only Justin can make.
 *
 * Each value carries the evidence it came from, and the page emits both so the
 * corpus can record `labelSource: "manual-review+derived"` rather than claiming
 * a human classified it. Weight a derived field below a human one.
 */
interface Derived {
  values: Record<string, unknown>;
  basis: Record<string, string>;
}

function derive(row: GroundingRow | undefined, candidate: RankedCandidate): Derived {
  const gates = row?.gates ?? {};
  const evidence = row?.evidence ?? {};
  const categories = row?.categories ?? candidate.categories ?? [];
  const hasVisual = evidence.visualProof != null && evidence.visualProof !== false;
  const lane = categories.find((c) => (CONTENT_LANES as readonly string[]).includes(c)) ?? "peanut-bits";
  const isGameplay = (GAMEPLAY_CONTENT_LANES as readonly string[]).includes(lane);

  const values: Record<string, unknown> = {};
  const basis: Record<string, string> = {};
  const put = (key: string, value: unknown, why: string) => {
    values[key] = value;
    basis[key] = why;
  };

  put("lane", lane, `categories ${JSON.stringify(categories)} intersected with the content lanes`);

  if (gates.contextIndependent === true) {
    put("contextLevel", "self-contained", "arc-grounding gates.contextIndependent === true");
  } else {
    // light vs deep is a human distinction; light is the conservative choice and
    // the basis says so rather than implying the depth was measured.
    put("contextLevel", "light-context",
      "arc-grounding gates.contextIndependent is not true; depth not determinable from evidence, light assumed");
  }

  put("primaryEvidenceModality", hasVisual ? (isGameplay ? "visual" : "hybrid") : "dialogue",
    `arc-grounding evidence.visualProof ${hasVisual ? "present" : "absent"}; transcript present`);
  put("contextCarrier", hasVisual ? "visual" : "dialogue",
    `sole evidence modality is ${hasVisual ? "visual proof" : "transcript dialogue"}`);
  put("visualProofRequired", hasVisual || isGameplay,
    `lane ${lane} is ${isGameplay ? "" : "not "}a gameplay lane; visualProof evidence ${hasVisual ? "present" : "absent"}`);

  if (categories.includes("reaction-gold")) {
    put("repetitionClass", "distinctive",
      "categorisation independently tagged reaction-gold, a selective marker (17 of 181 in the comparable job)");
  } else {
    // Not derivable. Term recurrence measures how much a stream discusses a
    // topic, not whether a moment is a distinctive bit, so this stays unset and
    // the candidate stays ineligible rather than guessed.
    put("repetitionClass", null, "no independent basis; left for a human");
  }

  put("arcIntent", gates.arcComplete === true ? "single-arc" : "compilation",
    `arc-grounding gates.arcComplete === ${String(gates.arcComplete)}`);

  const beats = hasCompleteBeats(row?.beats) ? row?.beats : null;
  put("coldOpenAccepted", beats?.flashSec != null,
    beats?.flashSec != null
      ? "arc-grounding placed a flash inside the arc"
      : "arc-grounding placed no flash, so there is no cold open to accept");

  return { values, basis };
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
    // Named by candidate, never by slot. The pick is shuffled and cutting is
    // skipped when the file already exists, so a slot name silently remaps every
    // clip to a different candidate on a re-run, recording reactions against the
    // wrong clips. Caught exactly that way on 2026-11-02.
    const file = `${candidate.momentId}.mp4`;
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
      beats: (() => {
        const row = grounding.get(candidate.candidateId);
        return hasCompleteBeats(row?.beats) ? row?.beats : null;
      })(),
      derived: derive(grounding.get(candidate.candidateId), candidate),
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
