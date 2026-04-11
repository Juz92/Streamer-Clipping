import { readFileSync } from "fs";

export interface CaptionWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface VttCue {
  startMs: number;
  endMs: number;
  text: string;
}

function parseTimestamp(ts: string): number {
  const parts = ts.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!parts) return 0;
  const [, h, m, s, ms] = parts;
  return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(ms);
}

export function parseVtt(filePath: string): VttCue[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  const cues: VttCue[] = [];
  let i = 0;

  // Skip WEBVTT header and any lines until first blank line or timing line
  while (i < lines.length) {
    if (lines[i].includes("-->")) break;
    i++;
  }

  while (i < lines.length) {
    const line = lines[i];

    // Check for timing line
    const timingMatch = line.match(
      /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/
    );
    if (!timingMatch) {
      i++;
      continue;
    }

    const startMs = parseTimestamp(timingMatch[1]);
    const endMs = parseTimestamp(timingMatch[2]);
    i++;

    // Skip near-zero-duration cues (rolling display artifacts in YouTube VTT)
    if (endMs - startMs < 50) {
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].includes("-->")) i++;
      continue;
    }

    // Collect text lines until blank line or next timing line or NOTE block
    const textLines: string[] = [];
    while (i < lines.length) {
      const tl = lines[i];
      if (tl.trim() === "") break;
      if (tl.includes("-->")) break;
      if (tl.startsWith("NOTE")) break;
      textLines.push(tl);
      i++;
    }

    // For YouTube rolling VTT, multi-line cues have old text on first lines
    // and new text (with inline timestamps) on the last line. Use only the
    // line that contains inline timestamps, or the last line if none do.
    let text: string;
    const timestampedLines = textLines.filter((l) => /<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(l));
    if (timestampedLines.length > 0) {
      text = timestampedLines[timestampedLines.length - 1].trim();
    } else {
      text = textLines[textLines.length - 1]?.trim() || "";
    }

    if (!text) continue;

    // Deduplication: skip if cleaned text is a subset of previous cue
    if (cues.length > 0) {
      const prevText = cues[cues.length - 1].text;
      const clean = (s: string) =>
        s.replace(/<[^>]+>/g, "").replace(/&\w+;/g, " ").replace(/\s+/g, " ").trim();
      const cleanPrev = clean(prevText);
      const cleanCurr = clean(text);
      if (cleanCurr === cleanPrev || cleanPrev.includes(cleanCurr)) {
        continue;
      }
    }

    cues.push({ startMs, endMs, text });
  }

  return cues;
}

/**
 * Strip VTT formatting tags and HTML entities from text.
 */
function stripVttTags(text: string): string {
  return text
    .replace(/<\/?c(?:\.[^>]*)?>/g, "") // <c>, </c>, <c.colorE5E5E5>
    .replace(/&nbsp;/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/>>+/g, "")   // speaker change markers
    .replace(/\[\s*__\s*\]/g, "****") // censored words
    .trim();
}

export function vttToWordTimestamps(cues: VttCue[]): CaptionWord[] {
  const words: CaptionWord[] = [];

  for (const cue of cues) {
    // Split text by inline timestamp tags to extract word+timestamp pairs
    // Format: "word1<HH:MM:SS.mmm><c> word2</c><HH:MM:SS.mmm><c> word3</c>"
    // The first word uses cue.startMs, subsequent words use inline timestamps
    const tagRegex = /<(\d{2}:\d{2}:\d{2}\.\d{3})>/g;

    // Split by tags, keeping the tags as separators
    const parts = cue.text.split(tagRegex);
    // parts alternates: [text, timestamp, text, timestamp, text, ...]

    const wordEntries: { word: string; startMs: number }[] = [];

    // First part uses cue start
    const firstWords = stripVttTags(parts[0]);
    if (firstWords) {
      for (const w of firstWords.split(/\s+/)) {
        if (w) wordEntries.push({ word: w, startMs: cue.startMs });
      }
    }

    // Remaining parts come in pairs: timestamp, text
    for (let j = 1; j < parts.length; j += 2) {
      const ts = parseTimestamp(parts[j]);
      const chunk = stripVttTags(parts[j + 1] || "");
      if (chunk) {
        const chunkWords = chunk.split(/\s+/);
        for (const w of chunkWords) {
          if (w) wordEntries.push({ word: w, startMs: ts });
        }
      }
    }

    // Assign endMs: each word ends at the next word's start, last word ends at cue.endMs
    for (let k = 0; k < wordEntries.length; k++) {
      const endMs =
        k < wordEntries.length - 1 ? wordEntries[k + 1].startMs : cue.endMs;
      words.push({
        word: wordEntries[k].word,
        startMs: wordEntries[k].startMs,
        endMs,
      });
    }
  }

  return words;
}

export function filterByTimeRange(
  words: CaptionWord[],
  startSec: number,
  endSec: number
): CaptionWord[] {
  const startMs = startSec * 1000;
  const endMs = endSec * 1000;

  return words
    .filter((w) => w.startMs >= startMs && w.endMs <= endMs)
    .map((w) => ({
      word: w.word,
      startMs: w.startMs - startMs,
      endMs: w.endMs - startMs,
    }));
}
