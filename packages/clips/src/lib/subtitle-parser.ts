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

    const text = textLines.join(" ").trim();
    if (!text) continue;

    // Deduplication: skip if text is a substring of or identical to previous cue's text
    if (cues.length > 0) {
      const prevText = cues[cues.length - 1].text;
      // Strip inline timestamps for comparison
      const clean = (s: string) => s.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "").trim();
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

export function vttToWordTimestamps(cues: VttCue[]): CaptionWord[] {
  const words: CaptionWord[] = [];

  for (const cue of cues) {
    // Split text by inline timestamp tags to extract word+timestamp pairs
    // Format: "word1<HH:MM:SS.mmm> word2<HH:MM:SS.mmm> word3"
    // The first word uses cue.startMs, subsequent words use inline timestamps
    const tagRegex = /<(\d{2}:\d{2}:\d{2}\.\d{3})>/g;

    // Split by tags, keeping the tags as separators
    const parts = cue.text.split(tagRegex);
    // parts alternates: [text, timestamp, text, timestamp, text, ...]

    const wordEntries: { word: string; startMs: number }[] = [];

    // First part uses cue start
    const firstWords = parts[0].trim();
    if (firstWords) {
      for (const w of firstWords.split(/\s+/)) {
        if (w) wordEntries.push({ word: w, startMs: cue.startMs });
      }
    }

    // Remaining parts come in pairs: timestamp, text
    for (let j = 1; j < parts.length; j += 2) {
      const ts = parseTimestamp(parts[j]);
      const chunk = (parts[j + 1] || "").trim();
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
