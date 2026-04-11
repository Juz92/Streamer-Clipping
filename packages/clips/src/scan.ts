import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { createLogger, DATA_DIR, readStdin } from "@ltx/shared";
import { getStreamDir, loadManifest } from "./lib/manifest.js";
import { parseVtt, vttToWordTimestamps, CaptionWord } from "./lib/subtitle-parser.js";
import type { Moment } from "./lib/scorer.js";

const log = createLogger("scan");

/** A single segment in a timeline clip — one continuous piece of video. */
interface ClipSegment {
  startSec: number;
  durationSec: number;
  label?: string;      // e.g. "first mention", "escalation", "callback"
}

interface UnifiedMoment {
  id: string;
  source: "manual" | "automated" | "notebooklm" | "both";
  startSec: number;
  endSec: number;
  durationSec: number;
  description: string;
  viralityScore: number;
  hookText?: string;
  layoutMode?: "gameplay" | "talking";
  /** For simple clips, segments is empty or has 1 entry. For timeline clips, 2+ entries. */
  segments: ClipSegment[];
  automatedSignals?: {
    transcriptPhrases: string[];
    chatIntensity: number;
    audioMagnitude: number;
    compositeScore: number;
  };
  // NEW: NotebookLM enrichment fields (all optional)
  categories?: string[];
  coldOpenSec?: number;
  naturalEndSec?: number;
  thumbnailSec?: number;
  titleDrafts?: string[];
  setupNeeded?: boolean;
  setupRef?: { startSec: number; description: string };
  viralSubScores?: Record<string, number>;
  notebooklmQuote?: string;
}

interface ManualPick {
  startSec: number;
  endSec: number;
  description: string;
  viralityScore: number;
  hookText?: string;
  layoutMode?: "gameplay" | "talking";
  /** Single-segment clip: omit or empty. Multi-segment: provide all segments. */
  segments?: ClipSegment[];
  // Legacy fields still accepted for simple 2-segment clips
  multiSegment?: boolean;
  buildUpStartSec?: number;
  buildUpDurationSec?: number;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseTimeString(timeStr: string): number {
  const parts = timeStr.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!parts) {
    log.error(`Invalid time format: ${timeStr}. Use HH:MM:SS`);
    process.exit(1);
  }
  const [, h, m, s] = parts;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function groupWordsByTime(
  words: CaptionWord[],
  windowSec: number = 30,
): { startSec: number; endSec: number; text: string }[] {
  if (words.length === 0) return [];

  const groups: { startSec: number; endSec: number; text: string }[] = [];
  let currentGroup: CaptionWord[] = [];
  let groupStartMs = words[0].startMs;

  for (const word of words) {
    const wordStartSec = word.startMs / 1000;
    const groupStartSec = groupStartMs / 1000;

    // If word is beyond window, flush current group and start new one
    if (wordStartSec - groupStartSec >= windowSec && currentGroup.length > 0) {
      const groupEndSec = currentGroup[currentGroup.length - 1].endMs / 1000;
      groups.push({
        startSec: groupStartSec,
        endSec: groupEndSec,
        text: currentGroup.map((w) => w.word).join(" "),
      });

      currentGroup = [word];
      groupStartMs = word.startMs;
    } else {
      currentGroup.push(word);
    }
  }

  // Flush final group
  if (currentGroup.length > 0) {
    const groupStartSec = groupStartMs / 1000;
    const groupEndSec = currentGroup[currentGroup.length - 1].endMs / 1000;
    groups.push({
      startSec: groupStartSec,
      endSec: groupEndSec,
      text: currentGroup.map((w) => w.word).join(" "),
    });
  }

  return groups;
}

function formatTranscriptLine(timestampSec: number, text: string): string {
  const time = formatTime(timestampSec);
  return `[${time}] ${text}`;
}

function displayChunkedScan(
  streamDir: string,
  words: CaptionWord[],
  moments: Moment[],
  chunkSizeSec: number,
  streamDurationSec: number,
): void {
  if (words.length === 0) {
    log.warn("No captions found. Cannot scan transcript.");
    return;
  }

  // Group words into ~30s blocks
  const blocks = groupWordsByTime(words, 30);

  // Calculate total chunks
  const totalChunks = Math.ceil(streamDurationSec / chunkSizeSec);

  let chunkNum = 0;

  // Iterate through time chunks
  for (let chunkStart = 0; chunkStart < streamDurationSec; chunkStart += chunkSizeSec) {
    chunkNum++;
    const chunkEnd = Math.min(chunkStart + chunkSizeSec, streamDurationSec);

    // Get blocks in this chunk
    const blocksInChunk = blocks.filter(
      (b) => b.startSec >= chunkStart && b.startSec < chunkEnd,
    );

    // Get moments in this chunk
    const momentsInChunk = moments.filter(
      (m) => m.suggestedStartSec >= chunkStart && m.suggestedStartSec < chunkEnd,
    );

    console.log("");
    console.log(
      "══════════════════════════════════════════════════════════════",
    );
    console.log(
      `  CHUNK ${chunkNum} of ${totalChunks} — ${formatTime(chunkStart)} → ${formatTime(chunkEnd)}`,
    );

    if (momentsInChunk.length > 0) {
      console.log(
        `  Automated signals in this window: ${momentsInChunk.length} moment(s)`,
      );
      for (const m of momentsInChunk) {
        console.log(
          `    - Score: ${m.scores.composite.toFixed(2)} (${formatTime(m.suggestedStartSec)})`,
        );
      }
    } else {
      console.log("  Automated signals in this window: none");
    }

    console.log(
      "══════════════════════════════════════════════════════════════",
    );
    console.log("");

    // Display transcript blocks
    for (const block of blocksInChunk) {
      console.log(formatTranscriptLine(block.startSec, block.text));
    }

    // Display moment annotations
    for (const moment of momentsInChunk) {
      console.log("");

      const phrases = moment.transcriptSignals
        .flatMap((s) => s.phrases)
        .slice(0, 3)
        .map((p) => `"${p}"`)
        .join(", ");

      const audioSpike =
        moment.audioSignals.length > 0
          ? `+${Math.max(...moment.audioSignals.map((s) => s.deltaFromAvg)).toFixed(1)}dB`
          : "none";

      const signalDesc = [
        phrases ? `Phrases: ${phrases}` : null,
        moment.audioSignals.length > 0 ? `Audio spike: ${audioSpike}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      console.log(
        `▸ AUTO SIGNAL at ${formatTime(moment.centerTimeSec)} (score ${moment.scores.composite.toFixed(2)}): ${signalDesc}`,
      );
    }

    console.log("");
  }

  console.log(
    "══════════════════════════════════════════════════════════════",
  );
}

/**
 * Display a time window of transcript with signal annotations.
 * Used by --around (asymmetric: more lookback) and --before (pure lookback).
 */
function displayTimeWindow(
  words: CaptionWord[],
  moments: Moment[],
  startSec: number,
  endSec: number,
  label: string,
  targetSec?: number,
): void {
  // Get blocks in window
  const blocks = groupWordsByTime(words, 30).filter(
    (b) => b.startSec >= startSec && b.startSec < endSec,
  );

  // Get moments in window
  const momentsInWindow = moments.filter(
    (m) =>
      m.suggestedStartSec >= startSec && m.suggestedStartSec < endSec,
  );

  console.log("");
  console.log(
    "══════════════════════════════════════════════════════════════",
  );
  console.log(`  ${label}`);
  console.log(`  ${formatTime(startSec)} → ${formatTime(endSec)}`);

  if (momentsInWindow.length > 0) {
    console.log(
      `  Automated signals in this window: ${momentsInWindow.length}`,
    );
    for (const m of momentsInWindow) {
      console.log(
        `    - Score: ${m.scores.composite.toFixed(2)} (${formatTime(m.suggestedStartSec)})`,
      );
    }
  } else {
    console.log("  Automated signals in this window: none");
  }

  console.log(
    "══════════════════════════════════════════════════════════════",
  );
  console.log("");

  // Display transcript, marking the target timestamp if provided
  for (const block of blocks) {
    const line = formatTranscriptLine(block.startSec, block.text);

    if (targetSec != null && block.startSec <= targetSec && block.endSec >= targetSec) {
      console.log(`${line}  ◄◄◄ PUNCHLINE HERE`);
    } else {
      console.log(line);
    }
  }

  // Display moment annotations
  for (const moment of momentsInWindow) {
    console.log("");
    const phrases = moment.transcriptSignals
      .flatMap((s) => s.phrases)
      .slice(0, 3)
      .map((p) => `"${p}"`)
      .join(", ");

    const audioSpike =
      moment.audioSignals.length > 0
        ? `+${Math.max(...moment.audioSignals.map((s) => s.deltaFromAvg)).toFixed(1)}dB`
        : "none";

    const signalDesc = [
      phrases ? `Phrases: ${phrases}` : null,
      moment.audioSignals.length > 0 ? `Audio spike: ${audioSpike}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    console.log(
      `▸ AUTO SIGNAL at ${formatTime(moment.centerTimeSec)} (score ${moment.scores.composite.toFixed(2)}): ${signalDesc}`,
    );
  }

  console.log("");
  console.log(
    "══════════════════════════════════════════════════════════════",
  );
}

/**
 * Search the transcript for a keyword or phrase. Returns all matches with
 * surrounding context and timestamps — used to trace back where a topic
 * (roast, story, running joke) first came up.
 */
function searchTranscript(
  words: CaptionWord[],
  moments: Moment[],
  query: string,
  contextSec: number = 30,
): void {
  const queryLower = query.toLowerCase();
  const blocks = groupWordsByTime(words, 15); // finer blocks for search

  const matches: { blockIdx: number; startSec: number; text: string }[] = [];

  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].text.toLowerCase().includes(queryLower)) {
      matches.push({ blockIdx: i, startSec: blocks[i].startSec, text: blocks[i].text });
    }
  }

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  SEARCH: "${query}" — ${matches.length} match(es) found`);
  console.log("══════════════════════════════════════════════════════════════");

  if (matches.length === 0) {
    console.log("");
    console.log("  No matches. Try a shorter keyword or different spelling.");
    console.log("  (Auto-subs often misspell words — try phonetic variants)");
    console.log("");
    return;
  }

  for (let mi = 0; mi < matches.length; mi++) {
    const match = matches[mi];
    console.log("");
    console.log(`  ── Match ${mi + 1} at ${formatTime(match.startSec)} ──`);
    console.log("");

    // Show context: blocks around the match
    const contextBlocks = Math.ceil(contextSec / 15);
    const startIdx = Math.max(0, match.blockIdx - contextBlocks);
    const endIdx = Math.min(blocks.length - 1, match.blockIdx + contextBlocks);

    for (let i = startIdx; i <= endIdx; i++) {
      const line = formatTranscriptLine(blocks[i].startSec, blocks[i].text);
      if (i === match.blockIdx) {
        // Highlight the matching block
        console.log(`  >>> ${line}`);
      } else {
        console.log(`      ${line}`);
      }
    }

    // Show any automated signals near this match
    const nearbyMoments = moments.filter(
      (m) => Math.abs(m.centerTimeSec - match.startSec) <= contextSec,
    );
    if (nearbyMoments.length > 0) {
      console.log("");
      for (const m of nearbyMoments) {
        console.log(
          `      ▸ AUTO SIGNAL at ${formatTime(m.centerTimeSec)} (score ${m.scores.composite.toFixed(2)})`,
        );
      }
    }
  }

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");

  // If multiple matches, show a timeline summary
  if (matches.length > 1) {
    console.log("");
    console.log("  Timeline:");
    const first = matches[0];
    const last = matches[matches.length - 1];
    console.log(`    First mention: ${formatTime(first.startSec)}`);
    console.log(`    Last mention:  ${formatTime(last.startSec)}`);
    const spanMin = ((last.startSec - first.startSec) / 60).toFixed(1);
    console.log(`    Span: ${spanMin} minutes across ${matches.length} occurrences`);
    console.log("");
    console.log("  Tip: The FIRST mention is likely where the setup/context begins.");
    console.log("  Use --before <last_timestamp> to see the full build-up to the punchline.");
    console.log("");
  }
}

/**
 * Trace a topic across the entire transcript and propose N-segment timeline clip
 * boundaries. Each mention becomes a candidate segment; nearby mentions are merged.
 * The output is a ready-to-paste ManualPick JSON with a segments array.
 */
function buildTimeline(
  words: CaptionWord[],
  moments: Moment[],
  query: string,
  contextSec: number,
  maxSegments: number,
): void {
  const queryLower = query.toLowerCase();
  const blocks = groupWordsByTime(words, 15);

  // Find all blocks that mention the keyword
  const rawMatches: { startSec: number; endSec: number; text: string }[] = [];
  for (const block of blocks) {
    if (block.text.toLowerCase().includes(queryLower)) {
      rawMatches.push(block);
    }
  }

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  TIMELINE: "${query}" — ${rawMatches.length} raw mention(s)`);
  console.log("══════════════════════════════════════════════════════════════");

  if (rawMatches.length === 0) {
    console.log("");
    console.log("  No mentions found. Try a shorter keyword or phonetic variant.");
    console.log("  (Auto-subs often misspell — try the closest phonetic match)");
    console.log("");
    return;
  }

  // ── Merge nearby mentions into segments ──
  // If two mentions are within 2x contextSec of each other, they're part of the
  // same conversational moment and should be a single segment.
  const mergeGapSec = contextSec * 2;
  const mergedSegments: { startSec: number; endSec: number; mentions: typeof rawMatches }[] = [];

  let currentSeg = {
    startSec: rawMatches[0].startSec,
    endSec: rawMatches[0].endSec,
    mentions: [rawMatches[0]],
  };

  for (let i = 1; i < rawMatches.length; i++) {
    const match = rawMatches[i];
    if (match.startSec - currentSeg.endSec <= mergeGapSec) {
      // Merge into current segment
      currentSeg.endSec = match.endSec;
      currentSeg.mentions.push(match);
    } else {
      // Gap too large — start a new segment
      mergedSegments.push(currentSeg);
      currentSeg = {
        startSec: match.startSec,
        endSec: match.endSec,
        mentions: [match],
      };
    }
  }
  mergedSegments.push(currentSeg);

  console.log(`  Merged into ${mergedSegments.length} distinct conversational moment(s)`);
  console.log("");

  // ── Show each merged segment with context ──
  for (let si = 0; si < mergedSegments.length; si++) {
    const seg = mergedSegments[si];
    const padStart = Math.max(0, seg.startSec - contextSec);
    const padEnd = seg.endSec + contextSec;

    console.log(`  ── Segment ${si + 1}: ${formatTime(padStart)} → ${formatTime(padEnd)} (${seg.mentions.length} mention(s)) ──`);
    console.log("");

    // Show transcript in this padded window
    const windowBlocks = blocks.filter(
      (b) => b.startSec >= padStart && b.startSec < padEnd,
    );
    for (const block of windowBlocks) {
      const isMatch = seg.mentions.some((m) => m.startSec === block.startSec);
      const prefix = isMatch ? "  >>> " : "      ";
      console.log(`${prefix}[${formatTime(block.startSec)}] ${block.text}`);
    }

    // Show any automated signals near this segment
    const nearbyMoments = moments.filter(
      (m) => m.centerTimeSec >= padStart && m.centerTimeSec <= padEnd,
    );
    if (nearbyMoments.length > 0) {
      console.log("");
      for (const m of nearbyMoments) {
        console.log(
          `      ▸ AUTO SIGNAL at ${formatTime(m.centerTimeSec)} (score ${m.scores.composite.toFixed(2)})`,
        );
      }
    }
    console.log("");
  }

  // ── Auto-label segments ──
  const labelPool = ["first mention", "escalation", "callback", "revival", "running gag"];

  // If more segments than maxSegments, keep the first, the last, and the most
  // interesting ones in between (by mention count or nearby auto signals).
  let selectedSegments = mergedSegments;
  if (mergedSegments.length > maxSegments) {
    console.log(`  More than ${maxSegments} segments — selecting the most interesting...`);

    // Always keep first and last
    const first = mergedSegments[0];
    const last = mergedSegments[mergedSegments.length - 1];
    const middle = mergedSegments.slice(1, -1);

    // Score middle segments: mention count + nearby auto signals
    const scored = middle.map((seg) => {
      const nearbyAuto = moments.filter(
        (m) => m.centerTimeSec >= seg.startSec - contextSec &&
               m.centerTimeSec <= seg.endSec + contextSec,
      ).length;
      return { seg, score: seg.mentions.length + nearbyAuto * 2 };
    });
    scored.sort((a, b) => b.score - a.score);

    const kept = scored.slice(0, maxSegments - 2).map((s) => s.seg);
    // Maintain chronological order
    kept.sort((a, b) => a.startSec - b.startSec);

    selectedSegments = [first, ...kept, last];
    console.log(`  Kept ${selectedSegments.length} segments (first + ${kept.length} best middle + last)`);
    console.log("");
  }

  // Build the proposed ClipSegments
  const proposedSegments: ClipSegment[] = selectedSegments.map((seg, i) => {
    const padStart = Math.max(0, seg.startSec - contextSec);
    const padEnd = seg.endSec + contextSec;
    const label = i < labelPool.length ? labelPool[i] : `moment-${i + 1}`;

    return {
      startSec: Math.round(padStart),
      durationSec: Math.round(padEnd - padStart),
      label,
    };
  });

  // Calculate total duration
  const totalDurationSec = proposedSegments.reduce((sum, s) => sum + s.durationSec, 0);
  const firstSeg = proposedSegments[0];
  const lastSeg = proposedSegments[proposedSegments.length - 1];

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  PROPOSED TIMELINE CLIP");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`  Total duration: ~${totalDurationSec}s across ${proposedSegments.length} segments`);
  if (totalDurationSec > 58) {
    console.log(`  ⚠️  Over 58s — consider trimming context or dropping a segment for Shorts`);
  }
  console.log("");

  for (let i = 0; i < proposedSegments.length; i++) {
    const seg = proposedSegments[i];
    console.log(`  ${i + 1}. [${seg.label}] ${formatTime(seg.startSec)} — ${seg.durationSec}s`);
  }

  // Output ready-to-paste ManualPick JSON
  const manualPick: ManualPick = {
    startSec: firstSeg.startSec,
    endSec: lastSeg.startSec + lastSeg.durationSec,
    description: `Timeline: "${query}" — ${proposedSegments.length} moments across the stream`,
    viralityScore: 8,
    hookText: `This joke kept coming back...`,
    segments: proposedSegments,
  };

  console.log("");
  console.log("  ── Copy-paste this into your manual picks JSON: ──");
  console.log("");
  console.log(JSON.stringify(manualPick, null, 2));
  console.log("");
  console.log("  Tips:");
  console.log("  - Adjust startSec/durationSec on each segment to tighten the cuts");
  console.log("  - Reorder labels to match the narrative arc you want");
  console.log("  - Use --around <timestamp> to inspect any segment's context more closely");
  console.log("  - Use --context <seconds> to widen/narrow the padding (default: 15s)");
  console.log("  - Use --max-segments <N> to cap how many moments to include (default: 5)");
  console.log("");
}

/**
 * Convert a ManualPick to the N-segment format.
 * Handles both new `segments` array and legacy `multiSegment`/`buildUpStartSec` fields.
 */
function resolveSegments(pick: ManualPick): ClipSegment[] {
  // New format: segments array provided directly
  if (pick.segments && pick.segments.length > 0) {
    return pick.segments;
  }

  // Legacy format: multiSegment + buildUpStartSec → convert to 2-segment array
  if (pick.multiSegment && pick.buildUpStartSec != null) {
    return [
      { startSec: pick.buildUpStartSec, durationSec: pick.buildUpDurationSec ?? 10, label: "build-up" },
      { startSec: pick.startSec, durationSec: pick.endSec - pick.startSec, label: "payoff" },
    ];
  }

  // Simple single-segment clip
  return [];
}

export interface NotebookLMPickForMerge {
  id: string;
  startSec: number;
  endSec: number;
  description: string;
  viralScore: number;
  categories: string[];
  hook: string;
  durationSec: number;
  setupNeeded: boolean;
  setupRef?: { startSec: number; description: string };
  coldOpenSec?: number;
  naturalEndSec?: number;
  thumbnailSec?: number;
  titleDrafts?: string[];
  quote?: string;
  viralSubScores?: Record<string, number>;
}

function mergeManualAndAutomated(
  manualPicks: ManualPick[],
  automatedMoments: Moment[],
): UnifiedMoment[] {
  const unified: UnifiedMoment[] = [];
  const usedAutoIds = new Set<string>();
  const OVERLAP_THRESHOLD_SEC = 30;

  // Process manual picks first
  for (let i = 0; i < manualPicks.length; i++) {
    const manual = manualPicks[i];
    const segments = resolveSegments(manual);

    // Find overlapping automated moments
    const overlappingAuto = automatedMoments.filter((auto) => {
      const distance = Math.abs(
        manual.startSec - auto.suggestedStartSec,
      );
      return distance <= OVERLAP_THRESHOLD_SEC;
    });

    if (overlappingAuto.length > 0) {
      // Manual pick overlaps with automated pick(s)
      const bestAuto = overlappingAuto[0];
      usedAutoIds.add(bestAuto.id);

      const unified_moment: UnifiedMoment = {
        id: `both-${String(unified.length + 1).padStart(3, "0")}`,
        source: "both",
        startSec: manual.startSec,
        endSec: manual.endSec,
        durationSec: manual.endSec - manual.startSec,
        description: manual.description,
        viralityScore: manual.viralityScore,
        hookText: manual.hookText,
        layoutMode: manual.layoutMode,
        segments,
        automatedSignals: {
          transcriptPhrases: bestAuto.transcriptSignals
            .flatMap((s) => s.phrases)
            .slice(0, 3),
          chatIntensity: Math.max(
            ...bestAuto.chatSignals.map((s) => s.spikeIntensity),
            0,
          ),
          audioMagnitude: Math.max(
            ...bestAuto.audioSignals.map((s) => s.deltaFromAvg),
            0,
          ),
          compositeScore: bestAuto.scores.composite,
        },
      };
      unified.push(unified_moment);
    } else {
      // Manual pick with no overlap
      const manual_moment: UnifiedMoment = {
        id: `manual-${String(unified.length + 1).padStart(3, "0")}`,
        source: "manual",
        startSec: manual.startSec,
        endSec: manual.endSec,
        durationSec: manual.endSec - manual.startSec,
        description: manual.description,
        viralityScore: manual.viralityScore,
        hookText: manual.hookText,
        layoutMode: manual.layoutMode,
        segments,
      };
      unified.push(manual_moment);
    }
  }

  // Add remaining automated moments
  for (const auto of automatedMoments) {
    if (!usedAutoIds.has(auto.id)) {
      const auto_moment: UnifiedMoment = {
        id: `auto-${String(unified.length + 1).padStart(3, "0")}`,
        source: "automated",
        startSec: auto.suggestedStartSec,
        endSec: auto.suggestedEndSec,
        durationSec: auto.suggestedDurationSec,
        description: auto.description,
        viralityScore: auto.scores.composite * 10,
        layoutMode: undefined,
        segments: [],
        automatedSignals: {
          transcriptPhrases: auto.transcriptSignals
            .flatMap((s) => s.phrases)
            .slice(0, 3),
          chatIntensity: Math.max(
            ...auto.chatSignals.map((s) => s.spikeIntensity),
            0,
          ),
          audioMagnitude: Math.max(
            ...auto.audioSignals.map((s) => s.deltaFromAvg),
            0,
          ),
          compositeScore: auto.scores.composite,
        },
      };
      unified.push(auto_moment);
    }
  }

  // Sort: manual picks (higher score) first, then automated
  unified.sort((a, b) => {
    if (a.source === "manual" && b.source !== "manual") return -1;
    if (b.source === "manual" && a.source !== "manual") return 1;
    return b.viralityScore - a.viralityScore;
  });

  // Re-ID after sort
  for (let i = 0; i < unified.length; i++) {
    const prefix = unified[i].source === "both" ? "both" :
                   unified[i].source === "manual" ? "manual" : "auto";
    unified[i].id = `${prefix}-${String(i + 1).padStart(3, "0")}`;
  }

  return unified;
}

/**
 * Three-way merge: manual picks + automated moments + NotebookLM picks.
 * Uses the existing manual+automated merger as pass 1, then folds NotebookLM
 * picks in as pass 2 with the same 30-second overlap threshold.
 *
 * Precedence for conflicting fields: manual > automated > notebooklm for
 * timing and description. NotebookLM wins for enrichment fields (categories,
 * coldOpenSec, titleDrafts, thumbnailSec, naturalEndSec) since it's the only
 * producer. Score reconciliation takes the MAX across all sources.
 */
export function mergeSources(
  manualPicks: ManualPick[],
  automatedMoments: Moment[],
  notebookLMPicks: NotebookLMPickForMerge[],
): UnifiedMoment[] {
  // Pass 1: existing manual + automated merge
  const pass1 = mergeManualAndAutomated(manualPicks, automatedMoments);

  // Pass 2: fold in NotebookLM picks
  const result: UnifiedMoment[] = [...pass1];

  for (const nlm of notebookLMPicks) {
    const overlap = result.find(
      (u) => Math.abs(u.startSec - nlm.startSec) <= 30,
    );

    if (overlap) {
      // Merge: upgrade source, take max score, fold enrichment
      overlap.source = "both";
      overlap.viralityScore = Math.max(overlap.viralityScore, nlm.viralScore);
      overlap.categories = nlm.categories;
      overlap.coldOpenSec = nlm.coldOpenSec;
      overlap.naturalEndSec = nlm.naturalEndSec;
      overlap.thumbnailSec = nlm.thumbnailSec;
      overlap.titleDrafts = nlm.titleDrafts;
      overlap.setupNeeded = nlm.setupNeeded;
      overlap.setupRef = nlm.setupRef;
      overlap.notebooklmQuote = nlm.quote;
      overlap.viralSubScores = nlm.viralSubScores;
    } else {
      // New standalone NotebookLM pick
      result.push({
        id: `nlm-${String(result.length + 1).padStart(3, "0")}`,
        source: "notebooklm",
        startSec: nlm.startSec,
        endSec: nlm.endSec,
        durationSec: nlm.durationSec,
        description: nlm.description || nlm.hook,
        viralityScore: nlm.viralScore,
        hookText: nlm.hook,
        segments: [],
        categories: nlm.categories,
        coldOpenSec: nlm.coldOpenSec,
        naturalEndSec: nlm.naturalEndSec,
        thumbnailSec: nlm.thumbnailSec,
        titleDrafts: nlm.titleDrafts,
        setupNeeded: nlm.setupNeeded,
        setupRef: nlm.setupRef,
        notebooklmQuote: nlm.quote,
        viralSubScores: nlm.viralSubScores,
      });
    }
  }

  return result;
}

function displayUnifiedMoments(
  moments: UnifiedMoment[],
): void {
  console.log("");
  console.log(
    "══════════════════════════════════════════════════════════════",
  );
  console.log(`  UNIFIED MOMENTS (${moments.length} total)`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");

  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const rank = i + 1;

    const sourceTag = m.source === "both" ? "MANUAL + AUTO" :
                      m.source === "manual" ? "MANUAL" : "AUTO";
    const score = m.viralityScore.toFixed(1);
    const startTime = formatTime(m.startSec);
    const endTime = formatTime(m.endSec);
    const dur = Math.round(m.durationSec);

    console.log(`  #${rank}  [${sourceTag}]  [${score}]  ${startTime} → ${endTime}  (${dur}s)`);
    console.log(`      ${m.description}`);

    if (m.hookText) {
      console.log(`      Hook: "${m.hookText}"`);
    }

    if (m.segments && m.segments.length > 1) {
      console.log(`      Timeline clip: ${m.segments.length} segments`);
      for (let si = 0; si < m.segments.length; si++) {
        const seg = m.segments[si];
        const segLabel = seg.label ? ` (${seg.label})` : "";
        console.log(`        ${si + 1}. ${formatTime(seg.startSec)} — ${Math.round(seg.durationSec)}s${segLabel}`);
      }
    }

    if (m.automatedSignals) {
      const { transcriptPhrases, chatIntensity, audioMagnitude, compositeScore } = m.automatedSignals;
      const signals: string[] = [];

      if (transcriptPhrases.length > 0) {
        signals.push(`Transcript: ${transcriptPhrases.map((p) => `"${p}"`).join(", ")}`);
      }
      if (chatIntensity > 0) {
        signals.push(`Chat: ${(chatIntensity * 10).toFixed(1)}`);
      }
      if (audioMagnitude > 0) {
        signals.push(`Audio: +${audioMagnitude.toFixed(1)}dB`);
      }

      if (signals.length > 0) {
        console.log(`      Signals: ${signals.join(" | ")}`);
      }
    }

    console.log("");
  }

  console.log(
    "══════════════════════════════════════════════════════════════",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let streamId = "";
  let chunkSizeSec = 10;
  let aroundTime = "";
  let beforeTime = "";
  let beforeMinutes = 3;
  let searchQuery = "";
  let mergeMode = false;
  let exportMode = false;
  let timelineQuery = "";
  let timelineContextSec = 15; // how many seconds of padding around each mention
  let timelineMaxSegments = 5; // cap segments to keep the Short watchable

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) {
      streamId = args[++i];
    } else if (args[i] === "--chunk" && args[i + 1]) {
      chunkSizeSec = parseInt(args[++i], 10);
    } else if (args[i] === "--around" && args[i + 1]) {
      aroundTime = args[++i];
    } else if (args[i] === "--before" && args[i + 1]) {
      beforeTime = args[++i];
    } else if (args[i] === "--minutes" && args[i + 1]) {
      beforeMinutes = parseInt(args[++i], 10);
    } else if (args[i] === "--search" && args[i + 1]) {
      searchQuery = args[++i];
    } else if (args[i] === "--timeline" && args[i + 1]) {
      timelineQuery = args[++i];
    } else if (args[i] === "--context" && args[i + 1]) {
      timelineContextSec = parseInt(args[++i], 10);
    } else if (args[i] === "--max-segments" && args[i + 1]) {
      timelineMaxSegments = parseInt(args[++i], 10);
    } else if (args[i] === "--merge") {
      mergeMode = true;
    } else if (args[i] === "--stdin") {
      // marker, used with --merge
    } else if (args[i] === "--export") {
      exportMode = true;
    }
  }

  if (!streamId) {
    log.error("--stream <id> is required");
    process.exit(1);
  }

  const streamDir = getStreamDir(streamId);
  const manifest = loadManifest(streamId);
  const streamDurationSec = manifest.durationSec;

  // Load moments (might not exist)
  let moments: Moment[] = [];
  const momentsPath = join(streamDir, "moments.json");
  if (existsSync(momentsPath)) {
    moments = JSON.parse(readFileSync(momentsPath, "utf-8"));
  }

  // Load captions for scan modes
  let allWords: CaptionWord[] = [];
  if (manifest.subtitlePath) {
    const subtitlePath = manifest.subtitlePath;
    if (existsSync(subtitlePath)) {
      const cues = parseVtt(subtitlePath);
      allWords = vttToWordTimestamps(cues);
      log.info(`Loaded ${allWords.length} caption words from subtitles`);
    }
  }

  if (mergeMode) {
    // Merge mode: read manual picks from stdin and merge with automated moments
    const stdinData = await readStdin();
    const manualPicks: ManualPick[] = JSON.parse(stdinData);

    const unified = mergeManualAndAutomated(manualPicks, moments);

    const unifiedPath = join(streamDir, "unified-moments.json");
    writeFileSync(unifiedPath, JSON.stringify(unified, null, 2), "utf-8");

    log.info(`Merged ${manualPicks.length} manual picks with ${moments.length} automated moments`);
    log.info(`Saved ${unified.length} unified moments to ${unifiedPath}`);

    displayUnifiedMoments(unified);
  } else if (exportMode) {
    // Export mode: read unified-moments.json or fall back to moments.json
    const unifiedPath = join(streamDir, "unified-moments.json");

    let toDisplay: UnifiedMoment[] = [];

    if (existsSync(unifiedPath)) {
      toDisplay = JSON.parse(readFileSync(unifiedPath, "utf-8"));
      log.info(`Loaded ${toDisplay.length} unified moments from ${unifiedPath}`);
    } else if (existsSync(momentsPath)) {
      // Convert automated moments to UnifiedMoment format
      toDisplay = moments.map((m, i) => ({
        id: `auto-${String(i + 1).padStart(3, "0")}`,
        source: "automated" as const,
        startSec: m.suggestedStartSec,
        endSec: m.suggestedEndSec,
        durationSec: m.suggestedDurationSec,
        description: m.description,
        viralityScore: m.scores.composite * 10,
        segments: [] as ClipSegment[],
        automatedSignals: {
          transcriptPhrases: m.transcriptSignals
            .flatMap((s) => s.phrases)
            .slice(0, 3),
          chatIntensity: Math.max(
            ...m.chatSignals.map((s) => s.spikeIntensity),
            0,
          ),
          audioMagnitude: Math.max(
            ...m.audioSignals.map((s) => s.deltaFromAvg),
            0,
          ),
          compositeScore: m.scores.composite,
        },
      }));
    } else {
      log.error("No unified-moments.json or moments.json found");
      process.exit(1);
    }

    displayUnifiedMoments(toDisplay);
  } else if (timelineQuery) {
    // Timeline mode: trace a topic across the stream and propose segment boundaries
    buildTimeline(allWords, moments, timelineQuery, timelineContextSec, timelineMaxSegments);
  } else if (searchQuery) {
    // Search mode: find keyword/phrase across the entire transcript
    searchTranscript(allWords, moments, searchQuery);
  } else if (beforeTime) {
    // Before mode: look BACKWARD from a punchline timestamp
    // Shows N minutes before the timestamp (default 3) + 30s after
    const targetSec = parseTimeString(beforeTime);
    const lookbackSec = beforeMinutes * 60;
    const startSec = Math.max(0, targetSec - lookbackSec);
    const endSec = Math.min(targetSec + 30, streamDurationSec);

    displayTimeWindow(
      allWords,
      moments,
      startSec,
      endSec,
      `LOOKBACK from ${formatTime(targetSec)} (${beforeMinutes} min before)`,
      targetSec,
    );
  } else if (aroundTime) {
    // Around mode: asymmetric window — 3 min before, 2 min after
    // Because setup comes BEFORE the peak, not after
    const centerSec = parseTimeString(aroundTime);
    const startSec = Math.max(0, centerSec - 180);
    const endSec = Math.min(centerSec + 120, streamDurationSec);

    displayTimeWindow(
      allWords,
      moments,
      startSec,
      endSec,
      `AROUND ${formatTime(centerSec)} (3 min before, 2 min after)`,
      centerSec,
    );
  } else {
    // Default: chunked scan mode
    displayChunkedScan(
      streamDir,
      allWords,
      moments,
      chunkSizeSec,
      streamDurationSec,
    );
  }
}

// Only run CLI when this file is executed directly (not imported by tests)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("scan.ts") || process.argv[1]?.endsWith("scan.js")) {
  main().catch((err) => {
    log.error(err.message);
    process.exit(1);
  });
}
