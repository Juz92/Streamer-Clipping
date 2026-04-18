/**
 * Parse NotebookLM query JSON responses into structured NotebookLMPick
 * records. The responses are from the `nlm notebook query ... --json` CLI
 * output: { value: { answer: string, conversation_id, citations, references } }
 *
 * IMPORTANT: NotebookLM does NOT consistently follow the requested output
 * format. These parsers are deliberately loose — they extract timestamps and
 * metadata from wherever they appear in the response text, using multiple
 * fallback patterns. See test-nlm-dump.ts for examples of real responses.
 */

export type SourceQuery =
  | "humor"
  | "running-bits"
  | "emotional-peaks"
  | "friend-roasts"
  | "crash-outs"
  | "one-liners"
  | "story-of-stream"
  | "enrichment"
  // Legacy — kept for backwards compat with old manifests/pool
  | "hot-takes"
  | "drama";

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
    references?: Array<{ citation_number?: number; source_id?: string; cited_text: string }>;
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
 * Extract the FIRST timestamp from text, looking in these locations:
 * 1. `* **Timestamp:** [HH:MM:SS]` (requested format)
 * 2. `**Timestamp:** [HH:MM:SS]` (without bullet)
 * 3. `[HH:MM:SS]` anywhere in the text (fallback)
 */
function extractTimestamp(text: string): number {
  // Try structured formats first
  const structured = text.match(/\*\*\s*Timestamp:?\s*\*\*\s*\[(\d{2}):(\d{2}):(\d{2})\]/);
  if (structured) {
    return parseInt(structured[1], 10) * 3600 + parseInt(structured[2], 10) * 60 + parseInt(structured[3], 10);
  }
  // Fallback: first [HH:MM:SS] in the text
  const fallback = text.match(TIMESTAMP_RE);
  if (fallback) {
    return parseInt(fallback[1], 10) * 3600 + parseInt(fallback[2], 10) * 60 + parseInt(fallback[3], 10);
  }
  return -1;
}

/**
 * Extract timestamp from citation references when the answer text has no
 * inline timestamps. NotebookLM often puts `[N]` citation markers in the
 * answer and the actual timestamps are in `references[N].cited_text`.
 *
 * Returns the FIRST timestamp found in the cited text for the first
 * citation number referenced in `itemText`.
 */
function extractTimestampFromRefs(
  itemText: string,
  refs: Array<{ citation_number?: number; cited_text: string }> | undefined,
): number {
  if (!refs || refs.length === 0) return -1;

  // Find citation numbers in the item text: [1], [2, 3], [1-5]
  const citationNums: number[] = [];
  const singleRe = itemText.matchAll(/\[(\d+)\]/g);
  for (const m of singleRe) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n <= 50) citationNums.push(n); // skip if it looks like a timestamp HH:MM:SS
  }
  const rangeRe = itemText.matchAll(/\[(\d+)[,-](\d+)\]/g);
  for (const m of rangeRe) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    for (let i = start; i <= Math.min(end, 50); i++) citationNums.push(i);
  }

  if (citationNums.length === 0) return -1;

  // Look up the first cited text for the first citation number
  for (const num of citationNums) {
    const ref = refs.find((r) => r.citation_number === num);
    if (ref?.cited_text) {
      const ts = ref.cited_text.match(TIMESTAMP_RE);
      if (ts) {
        return parseInt(ts[1], 10) * 3600 + parseInt(ts[2], 10) * 60 + parseInt(ts[3], 10);
      }
    }
  }

  return -1;
}

/**
 * Extract ALL timestamps from a text block.
 */
function extractAllTimestamps(text: string): number[] {
  return [...text.matchAll(TIMESTAMP_GLOBAL_RE)].map(
    (m) => parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10),
  );
}

/**
 * Extract a hook/title from a text block. Tries multiple patterns:
 * 1. `* **Hook Description:** text` (requested)
 * 2. `* **Hook:** text`
 * 3. `### N. Title` (heading format)
 * 4. `N. **Title**` (bold numbered)
 * 5. First line of text (fallback)
 */
function extractHook(text: string): string {
  // Hook Description field
  const hookDesc = text.match(/\*\*\s*(?:Hook Description|Hook)\s*:?\s*\*\*\s*([^\n]+)/i);
  if (hookDesc) return hookDesc[1].replace(/\[\d+(?:[,-]\d+)*\]/g, "").trim();

  // ### heading
  const heading = text.match(/###\s+\d+\.\s+(.+?)(?:\n|$)/);
  if (heading) return heading[1].replace(/["\u201C\u201D*]/g, "").trim();

  // N. **Title**
  const boldTitle = text.match(/\d+\.\s+\*\*([^*]+)\*\*/);
  if (boldTitle) return boldTitle[1].trim();

  // First non-empty line (stripped of numbering)
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    return lines[0].replace(/^\d+\.\s*/, "").replace(/\*\*/g, "").trim().slice(0, 120);
  }
  return "";
}

/**
 * Split a response into individual item blocks. Handles multiple formats:
 * - `### N. Title` (NotebookLM's preferred heading format)
 * - `N. **Title**` (numbered bold)
 * - `N. Title` (plain numbered)
 */
function splitItems(answer: string): string[] {
  // Try ### N. headings first (most common with NotebookLM)
  const headingItems = answer.split(/\n(?=###\s+\d+\.)/);
  if (headingItems.length > 1) return headingItems;

  // Try N. ** bold numbered
  const boldItems = answer.split(/\n(?=\d{1,2}\.\s+\*\*)/);
  if (boldItems.length > 1) return boldItems;

  // Try plain N. numbered (with period + space)
  const plainItems = answer.split(/\n(?=\d{1,2}\.\s+\S)/);
  if (plainItems.length > 1) return plainItems;

  // Single item
  return [answer];
}

/**
 * Parse the query 1 (humor) response. NotebookLM often ignores the requested
 * format and uses its own heading style. We extract timestamps and hooks
 * from wherever they appear.
 */
export function parseHumorQuery(raw: RawQueryResponse): NotebookLMPick[] {
  const answer = raw.value.answer;
  const refs = raw.value.references;
  const picks: NotebookLMPick[] = [];
  const items = splitItems(answer);

  for (const item of items) {
    // Try inline timestamp first, then fall back to citation references
    let startSec = extractTimestamp(item);
    if (startSec < 0) {
      startSec = extractTimestampFromRefs(item, refs);
    }
    if (startSec < 0) continue;

    const hook = extractHook(item);

    // Quote: multiple patterns
    const quoteMatch =
      item.match(/\*\*\s*(?:Quote|Punchline)\s*:?\s*\*\*\s*["\u201C]([^"\u201D]+)["\u201D]/) ||
      item.match(/["\u201C]([^"\u201D]{10,})["\u201D]/);
    const quote = quoteMatch?.[1]?.trim();

    // Humor type / category
    const humorMatch = item.match(/\*\*\s*Humor Type\s*:?\s*\*\*\s*([a-z-]+)/i);
    const category = humorMatch?.[1]?.toLowerCase() ?? "humor";

    // Setup needed
    const setupMatch = item.match(/\*\*\s*Setup(?:\s+Needed)?\s*:?\s*\*\*\s*(Yes|No)/i);
    const setupNeeded = setupMatch ? /yes/i.test(setupMatch[1]) : false;

    // Broad Appeal flag
    const broadAppealMatch = item.match(/\*\*\s*Broad Appeal\s*:?\s*\*\*\s*(Yes|No)/i);
    const isBroadAppeal = broadAppealMatch ? /yes/i.test(broadAppealMatch[1]) : false;
    const categories = isBroadAppeal ? [category, "broad-appeal"] : [category];

    picks.push({
      startSec,
      endSec: startSec + 45,
      hook,
      quote,
      categories,
      setupNeeded,
      setupOffsetSec: 0,
      strength: undefined,
      sourceQuery: "humor",
    });
  }

  // Derive strength from list position
  for (let i = 0; i < picks.length; i++) {
    picks[i].strength = Math.max(3, 5 - Math.floor(i / 5));
  }

  return picks;
}

/**
 * Parse the query 2 (running bits) response. Handles both the requested
 * `### N. Name` format and other NotebookLM output styles.
 */
export function parseRunningBitsQuery(
  raw: RawQueryResponse,
): NotebookLMPick[] {
  const answer = raw.value.answer;
  const refs = raw.value.references;
  const picks: NotebookLMPick[] = [];

  const sections = answer.split(/\n(?=###\s+\d+\.)/);

  for (const section of sections) {
    const titleMatch = section.match(/###\s+\d+\.\s+(.+?)(?:\n|$)/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/["\u201C\u201D*]/g, "").trim();

    // Find all timestamps (inline first, then from refs)
    let allTimestamps = extractAllTimestamps(section);
    if (allTimestamps.length === 0 && refs) {
      // Try to extract from citation references
      const ts = extractTimestampFromRefs(section, refs);
      if (ts >= 0) allTimestamps = [ts];
    }
    if (allTimestamps.length === 0) continue;

    // "Best Single-Clip Candidate:" timestamp
    const bestMatch = section.match(
      /\*\*\s*Best Single-Clip Candidate\s*:?\s*\*\*\s*\[(\d{2}):(\d{2}):(\d{2})\]/,
    );
    const startSec = bestMatch
      ? parseInt(bestMatch[1], 10) * 3600 +
        parseInt(bestMatch[2], 10) * 60 +
        parseInt(bestMatch[3], 10)
      : allTimestamps[0];

    // Description
    const descMatch = section.match(/\*\*\s*Description\s*:?\s*\*\*\s*([^\n]+)/);
    const hook = `${title} — ${descMatch?.[1]?.trim() ?? ""}`.trim();

    picks.push({
      startSec,
      endSec: startSec + 50,
      hook,
      categories: ["running-bit"],
      setupNeeded: false,
      setupOffsetSec: 0,
      strength: 4,
      sourceQuery: "running-bits",
      additionalTimestamps: allTimestamps.filter((t) => t !== startSec),
    });
  }

  return picks;
}

/**
 * Generic numbered-list parser for queries 3-6 (emotional-peaks, hot-takes,
 * drama, one-liners). Handles all NotebookLM output format variations.
 */
function parseNumberedListQuery(
  raw: RawQueryResponse,
  sourceQuery: SourceQuery,
  defaultCategory: string,
): NotebookLMPick[] {
  const answer = raw.value.answer;
  const refs = raw.value.references;
  const picks: NotebookLMPick[] = [];
  const items = splitItems(answer);

  for (const item of items) {
    let startSec = extractTimestamp(item);
    if (startSec < 0) {
      startSec = extractTimestampFromRefs(item, refs);
    }
    if (startSec < 0) continue;

    const hook = extractHook(item);

    const quoteMatch =
      item.match(/\*\*\s*Quote\s*:?\s*\*\*\s*["\u201C]([^"\u201D]+)["\u201D]/) ||
      item.match(/["\u201C]([^"\u201D]{10,})["\u201D]/);
    const quote = quoteMatch?.[1]?.trim();

    const setupMatch = item.match(/\*\*\s*Setup(?:\s+Needed)?\s*:?\s*\*\*\s*(Yes|No)/i);
    const setupNeeded = setupMatch ? /yes/i.test(setupMatch[1]) : false;

    // Try to extract emotion/category-specific field
    const emotionMatch = item.match(/\*\*\s*Emotion\s*:?\s*\*\*\s*([^\n]+)/i);
    const category = emotionMatch?.[1]?.trim()?.toLowerCase() ?? defaultCategory;

    // Broad Appeal flag: if NLM says Yes, add "broad-appeal" category for scoring bonus
    const broadAppealMatch = item.match(/\*\*\s*Broad Appeal\s*:?\s*\*\*\s*(Yes|No)/i);
    const isBroadAppeal = broadAppealMatch ? /yes/i.test(broadAppealMatch[1]) : false;
    const categories = isBroadAppeal ? [category, "broad-appeal"] : [category];

    picks.push({
      startSec,
      endSec: startSec + 45,
      hook,
      quote,
      categories,
      setupNeeded,
      setupOffsetSec: 0,
      strength: undefined,
      sourceQuery,
    });
  }

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

export function parseFriendRoastsQuery(raw: RawQueryResponse): NotebookLMPick[] {
  return parseNumberedListQuery(raw, "friend-roasts", "friend-roast");
}

export function parseCrashOutsQuery(raw: RawQueryResponse): NotebookLMPick[] {
  // Crash-out type maps to the "Crash type" field in the prompt.
  // parseNumberedListQuery will pick up emotion-like fields via the
  // generic extractor; we default to "crash-out" if not found.
  const picks = parseNumberedListQuery(raw, "crash-outs", "crash-out");
  // Crash-out clips tend to need more context — extend default window.
  for (const p of picks) {
    if (p.endSec - p.startSec < 45) p.endSec = p.startSec + 60;
  }
  return picks;
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
  const refs = raw.value.references;
  let startSec = extractTimestamp(answer);
  if (startSec < 0) {
    startSec = extractTimestampFromRefs(answer, refs);
  }
  if (startSec < 0) return [];

  const hookMatch =
    answer.match(/\*\*\s*Hook\s*:?\s*\*\*\s*([^\n]+)/i) ||
    answer.match(/###\s+.*?\n(.+)/);
  const hook = hookMatch?.[1]?.trim() ?? "Story of the stream";

  return [
    {
      startSec,
      endSec: startSec + 60,
      hook,
      categories: ["story-of-stream"],
      setupNeeded: false,
      setupOffsetSec: 0,
      strength: 5,
      sourceQuery: "story-of-stream",
    },
  ];
}

/**
 * Parse query 8 (enrichment): returns enrichment records keyed by the anchor
 * timestamp of each candidate.
 */
export interface ViralRubric {
  hook: number;
  flow: number;
  engagement: number;
  trend: number;
  /** Sum of the four dimensions, 0-100. */
  total: number;
}

export interface EnrichmentRecord {
  anchorStartSec: number;
  coldOpenSec?: number;
  naturalEndSec?: number;
  thumbnailSec?: number;
  titleDrafts: string[];
  rubric?: ViralRubric;
}

export function parseEnrichmentQuery(
  raw: RawQueryResponse,
): EnrichmentRecord[] {
  const answer = raw.value.answer;
  const records: EnrichmentRecord[] = [];

  // Each candidate: **N. [HH:MM:SS]** or N. [HH:MM:SS]
  const blocks = answer.split(/\n(?=(?:\*\*)?\d+\.\s+\[\d{2}:\d{2}:\d{2}\])/);

  for (const block of blocks) {
    const anchorMatch = block.match(
      /(?:\*\*)?\d+\.\s+\[(\d{2}):(\d{2}):(\d{2})\]/,
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

    // Rubric — tolerate "Hook: 18/25" or "Hook: 18" or "- Hook: 18/25"
    const extractScore = (label: string): number | undefined => {
      const re = new RegExp(`${label}:\\s*(\\d+)(?:\\s*/\\s*25)?`, "i");
      const m = block.match(re);
      if (!m) return undefined;
      const n = parseInt(m[1], 10);
      if (Number.isNaN(n)) return undefined;
      return Math.max(0, Math.min(25, n));
    };

    const hook = extractScore("Hook");
    const flow = extractScore("Flow");
    const engagement = extractScore("Engagement");
    const trend = extractScore("Trend");

    let rubric: ViralRubric | undefined;
    if (hook != null && flow != null && engagement != null && trend != null) {
      rubric = {
        hook,
        flow,
        engagement,
        trend,
        total: hook + flow + engagement + trend,
      };
    }

    records.push({
      anchorStartSec,
      coldOpenSec: extractTs("Cold open"),
      naturalEndSec: extractTs("Natural end"),
      thumbnailSec: extractTs("Thumbnail"),
      titleDrafts: titleDrafts.slice(0, 3),
      rubric,
    });
  }

  return records;
}

/**
 * Extended pick with aggregated metadata populated during dedup.
 */
export interface DedupedPick extends NotebookLMPick {
  /** Number of distinct source queries this pick was surfaced in. */
  categoryQueryHitCount: number;
  /** All source queries that surfaced this pick (for provenance). */
  sourceQueries: SourceQuery[];
}

const OVERLAP_THRESHOLD_SEC = 30;

/**
 * Deduplicate picks across multiple query results. Two picks are considered
 * the same moment if their `startSec` values are within OVERLAP_THRESHOLD_SEC
 * of each other. Merged picks combine categories, tally source queries, and
 * keep the earliest start + highest strength + longest hook.
 */
export function dedupePicks(picks: NotebookLMPick[]): DedupedPick[] {
  const sorted = [...picks].sort((a, b) => a.startSec - b.startSec);
  const result: DedupedPick[] = [];

  for (const pick of sorted) {
    const existing = result.find(
      (r) => Math.abs(r.startSec - pick.startSec) <= OVERLAP_THRESHOLD_SEC,
    );

    if (!existing) {
      result.push({
        ...pick,
        categoryQueryHitCount: 1,
        sourceQueries: [pick.sourceQuery],
      });
      continue;
    }

    for (const cat of pick.categories) {
      if (!existing.categories.includes(cat)) existing.categories.push(cat);
    }
    if (!existing.sourceQueries.includes(pick.sourceQuery)) {
      existing.sourceQueries.push(pick.sourceQuery);
      existing.categoryQueryHitCount = existing.sourceQueries.length;
    }

    if (pick.startSec < existing.startSec) existing.startSec = pick.startSec;
    if (pick.endSec > existing.endSec) existing.endSec = pick.endSec;

    if ((pick.strength ?? 0) > (existing.strength ?? 0)) {
      existing.strength = pick.strength;
    }

    if (pick.hook.length > existing.hook.length) existing.hook = pick.hook;
    if (!existing.quote && pick.quote) existing.quote = pick.quote;
    if (pick.additionalTimestamps && !existing.additionalTimestamps) {
      existing.additionalTimestamps = pick.additionalTimestamps;
    }
    if (pick.setupNeeded && !existing.setupNeeded) {
      existing.setupNeeded = true;
      existing.setupOffsetSec = pick.setupOffsetSec;
    }
  }

  return result;
}
