/**
 * Parse NotebookLM query JSON responses into structured NotebookLMPick
 * records. The responses are from the `nlm notebook query ... --json` CLI
 * output: { value: { answer: string, conversation_id, citations, references } }
 *
 * The `answer` is free-form markdown. Each parser uses regex to extract
 * structured fields matching the prompt output format specified in
 * notebooklm-queries.ts.
 */

export type SourceQuery =
  | "humor"
  | "running-bits"
  | "emotional-peaks"
  | "hot-takes"
  | "drama"
  | "one-liners"
  | "story-of-stream"
  | "enrichment";

export interface NotebookLMPick {
  /** Start time in seconds from stream beginning. */
  startSec: number;
  /** End time in seconds. Parsers estimate when absent. */
  endSec: number;
  /** Single-sentence hook description. */
  hook: string;
  /** Key quote(s) from the transcript. */
  quote?: string;
  /** Viral categories (may be multiple for enrichment merges). */
  categories: string[];
  /** Whether this pick depends on earlier context. */
  setupNeeded: boolean;
  /** How many seconds earlier the setup reference starts (0 if none). */
  setupOffsetSec: number;
  /** NotebookLM's 1-5 strength rating for this pick. */
  strength?: number;
  /** Which query this pick came from (provenance). */
  sourceQuery: SourceQuery;
  /** Additional timestamps for running bits / multi-appearance picks. */
  additionalTimestamps?: number[];
}

export interface RawQueryResponse {
  value: {
    answer: string;
    conversation_id: string;
    sources_used?: string[];
    citations?: Record<string, string>;
    references?: Array<{ cited_text: string }>;
  };
}

const TIMESTAMP_RE = /\[(\d{2}):(\d{2}):(\d{2})\]/;
const TIMESTAMP_GLOBAL_RE = /\[(\d{2}):(\d{2}):(\d{2})\]/g;

export function parseTimestampToSec(ts: string): number {
  const m = ts.match(TIMESTAMP_RE);
  if (!m) return -1;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

/**
 * Parse the query 1 (humor) response. Expects markdown with numbered picks:
 * `1. **Title** ... * **Timestamp:** [HH:MM:SS] ... * **Humor Type:** dry-joke`
 */
export function parseHumorQuery(raw: RawQueryResponse): NotebookLMPick[] {
  const answer = raw.value.answer;
  const picks: NotebookLMPick[] = [];

  // Split on numbered items: "1. **...**" or "### 1. ..." or "1."
  const items = answer.split(/\n(?=\d{1,2}\.\s+\*)/);

  for (const item of items) {
    const tsMatch = item.match(TIMESTAMP_RE);
    if (!tsMatch) continue;

    const startSec = parseTimestampToSec(tsMatch[0]);
    if (startSec < 0) continue;

    // Extract hook/title: either the **bold title** at the top or the
    // "Hook Description:" field
    const hookLineMatch = item.match(/\*\*Hook Description:?\*\*\s*([^\n]+)/i);
    const boldTitleMatch = item.match(/^\d+\.\s+\*\*([^*]+)\*\*/);
    const hook = (hookLineMatch?.[1] ?? boldTitleMatch?.[1] ?? "").trim();

    // Quote
    const quoteMatch = item.match(/\*\*Quote:?\*\*\s*["\u201C]([^"\u201D]+)["\u201D]/);
    const quote = quoteMatch?.[1].trim();

    // Humor type → category
    const humorMatch = item.match(/\*\*Humor Type:?\*\*\s*([a-z-]+)/i);
    const category = humorMatch?.[1].toLowerCase() ?? "dry-joke";

    // Setup needed
    const setupMatch = item.match(/\*\*Setup(?:\s+Needed)?:?\*\*\s*(Yes|No)/i);
    const setupNeeded = setupMatch ? setupMatch[1].toLowerCase() === "yes" : false;

    // Heuristic end time: add 45 seconds (middle of sweet spot)
    const endSec = startSec + 45;

    picks.push({
      startSec,
      endSec,
      hook,
      quote,
      categories: [category],
      setupNeeded,
      setupOffsetSec: 0, // query 1 doesn't give us an offset
      strength: undefined, // NotebookLM ranks 1-15 via list position, not explicit strength
      sourceQuery: "humor",
    });
  }

  // Derive strength from list position: pick #1 gets strength 5, #15 gets strength 3
  for (let i = 0; i < picks.length; i++) {
    picks[i].strength = Math.max(3, 5 - Math.floor(i / 5));
  }

  return picks;
}

/**
 * Parse the query 2 (running bits) response. Expects:
 * `### 1. The Bit Name * **Timestamps:** [HH:MM:SS], [HH:MM:SS], ... * **Best Single-Clip Candidate:** [HH:MM:SS] ...`
 */
export function parseRunningBitsQuery(
  raw: RawQueryResponse,
): NotebookLMPick[] {
  const answer = raw.value.answer;
  const picks: NotebookLMPick[] = [];

  // Split on "### N." headings
  const sections = answer.split(/\n(?=###\s+\d+\.)/);

  for (const section of sections) {
    const titleMatch = section.match(/###\s+\d+\.\s+(.+?)(?:\n|$)/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/["\u201C\u201D*]/g, "").trim();

    // All timestamps in the section
    const allTimestamps = [...section.matchAll(TIMESTAMP_GLOBAL_RE)].map(
      (m) => parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10),
    );
    if (allTimestamps.length === 0) continue;

    // "Best Single-Clip Candidate:" line — parse the timestamp right after it
    const bestMatch = section.match(
      /\*\*Best Single-Clip Candidate:?\*\*\s*\[(\d{2}):(\d{2}):(\d{2})\]/,
    );
    const startSec = bestMatch
      ? parseInt(bestMatch[1], 10) * 3600 +
        parseInt(bestMatch[2], 10) * 60 +
        parseInt(bestMatch[3], 10)
      : allTimestamps[0];

    // Description line
    const descMatch = section.match(
      /\*\*Description:?\*\*\s*([^\n]+)/,
    );
    const hook = `${title} \u2014 ${descMatch?.[1]?.trim() ?? ""}`.trim();

    picks.push({
      startSec,
      endSec: startSec + 50,
      hook,
      categories: ["running-bit"],
      setupNeeded: false, // best-clip candidate is designed to stand alone
      setupOffsetSec: 0,
      strength: 4, // Running bits are high-signal by definition
      sourceQuery: "running-bits",
      additionalTimestamps: allTimestamps.filter((t) => t !== startSec),
    });
  }

  return picks;
}

/**
 * Generic numbered-list parser for queries 3-6 (emotional-peaks, hot-takes,
 * drama, one-liners). They all share the same output format:
 *   N. **Title** * **Timestamp:** [HH:MM:SS] * **Hook:** ... * **Category:** ...
 */
function parseNumberedListQuery(
  raw: RawQueryResponse,
  sourceQuery: SourceQuery,
  defaultCategory: string,
): NotebookLMPick[] {
  const answer = raw.value.answer;
  const picks: NotebookLMPick[] = [];

  const items = answer.split(/\n(?=\d{1,2}\.\s+\*)/);

  for (const item of items) {
    const tsMatch = item.match(TIMESTAMP_RE);
    if (!tsMatch) continue;

    const startSec = parseTimestampToSec(tsMatch[0]);
    if (startSec < 0) continue;

    const hookMatch = item.match(/\*\*Hook:?\*\*\s*([^\n]+)/i);
    const titleMatch = item.match(/^\d+\.\s+\*\*([^*]+)\*\*/);
    const hook = (hookMatch?.[1] ?? titleMatch?.[1] ?? "").trim();

    const quoteMatch = item.match(/\*\*Quote:?\*\*\s*["\u201C]([^"\u201D]+)["\u201D]/);
    const quote = quoteMatch?.[1].trim();

    const setupMatch = item.match(/\*\*Setup(?:\s+Needed)?:?\*\*\s*(Yes|No)/i);
    const setupNeeded = setupMatch ? setupMatch[1].toLowerCase() === "yes" : false;

    picks.push({
      startSec,
      endSec: startSec + 45,
      hook,
      quote,
      categories: [defaultCategory],
      setupNeeded,
      setupOffsetSec: 0,
      strength: undefined,
      sourceQuery,
    });
  }

  // Position-based strength (top of list = strongest)
  for (let i = 0; i < picks.length; i++) {
    picks[i].strength = Math.max(3, 5 - Math.floor(i / 5));
  }

  return picks;
}

export function parseEmotionalPeaksQuery(
  raw: RawQueryResponse,
): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "emotional-peaks", "emotional-peak");
}

export function parseHotTakesQuery(raw: RawQueryResponse): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "hot-takes", "hot-take");
}

export function parseDramaQuery(raw: RawQueryResponse): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "drama", "drama");
}

export function parseOneLinersQuery(raw: RawQueryResponse): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "one-liners", "one-liner");
}

/**
 * Parse query 7: single hero pick (story-of-the-stream).
 */
export function parseStoryOfStreamQuery(
  raw: RawQueryResponse,
): NotebookLMPick[] {
  const answer = raw.value.answer;
  const tsMatch = answer.match(TIMESTAMP_RE);
  if (!tsMatch) return [];

  const startSec = parseTimestampToSec(tsMatch[0]);
  if (startSec < 0) return [];

  const hookMatch = answer.match(/\*\*Hook:?\*\*\s*([^\n]+)/i);
  const hook = hookMatch?.[1]?.trim() ?? "Story of the stream";

  return [
    {
      startSec,
      endSec: startSec + 60,
      hook,
      categories: ["story-of-stream"],
      setupNeeded: false,
      setupOffsetSec: 0,
      strength: 5, // Hero pick always gets max strength
      sourceQuery: "story-of-stream",
    },
  ];
}

/**
 * Parse query 8 (enrichment): returns enrichment records keyed by the anchor
 * timestamp of each candidate. Used to back-fill coldOpenSec/naturalEndSec/
 * thumbnailSec/titleDrafts on picks from queries 1-7.
 */
export interface EnrichmentRecord {
  anchorStartSec: number;
  coldOpenSec?: number;
  naturalEndSec?: number;
  thumbnailSec?: number;
  titleDrafts: string[];
}

export function parseEnrichmentQuery(
  raw: RawQueryResponse,
): EnrichmentRecord[] {
  const answer = raw.value.answer;
  const records: EnrichmentRecord[] = [];

  // Each candidate is a numbered block starting with **N. [HH:MM:SS]**
  const blocks = answer.split(/\n(?=\*\*\d+\.\s+\[\d{2}:\d{2}:\d{2}\])/);

  for (const block of blocks) {
    const anchorMatch = block.match(
      /\*\*\d+\.\s+\[(\d{2}):(\d{2}):(\d{2})\]/,
    );
    if (!anchorMatch) continue;
    const anchorStartSec =
      parseInt(anchorMatch[1], 10) * 3600 +
      parseInt(anchorMatch[2], 10) * 60 +
      parseInt(anchorMatch[3], 10);

    const extractTs = (label: string): number | undefined => {
      const re = new RegExp(`${label}:?\\s*\\[(\\d{2}):(\\d{2}):(\\d{2})\\]`, "i");
      const m = block.match(re);
      if (!m) return undefined;
      return (
        parseInt(m[1], 10) * 3600 +
        parseInt(m[2], 10) * 60 +
        parseInt(m[3], 10)
      );
    };

    const titleDrafts: string[] = [];
    // Look for "Title drafts:" or "Titles:" section followed by numbered list
    const titleSectionMatch = block.match(
      /Title (?:drafts|variants|options):?\s*\n((?:\s*\d+\.\s+[^\n]+\n?)+)/i,
    );
    if (titleSectionMatch) {
      const lines = titleSectionMatch[1].split("\n");
      for (const line of lines) {
        const titleMatch = line.match(/\d+\.\s+(.+)/);
        if (titleMatch) titleDrafts.push(titleMatch[1].trim());
      }
    }

    records.push({
      anchorStartSec,
      coldOpenSec: extractTs("Cold open"),
      naturalEndSec: extractTs("Natural end"),
      thumbnailSec: extractTs("Thumbnail"),
      titleDrafts: titleDrafts.slice(0, 3),
    });
  }

  return records;
}
