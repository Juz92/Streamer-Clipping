import { parseVtt, vttToWordTimestamps, filterByTimeRange } from "./packages/clips/src/lib/subtitle-parser.js";

const cues = parseVtt("data/clips/job-005-2026-04-03/source/stream.en.vtt");
console.log("Cues:", cues.length);

const words = vttToWordTimestamps(cues);
console.log("Words:", words.length);

if (words.length > 0) {
  console.log("Word[0]:", JSON.stringify(words[0]));
  console.log("Word[1000]:", JSON.stringify(words[1000]));
  console.log("Word[50000]:", JSON.stringify(words[50000]));

  // Max timestamp
  const maxMs = Math.max(...words.map(w => w.startMs));
  console.log("Max startMs:", maxMs, "=", maxMs/1000, "seconds =", (maxMs/1000/3600).toFixed(2), "hours");
}

// Test clip 07 range: 27070-27100
const test = filterByTimeRange(words, 27070, 27100);
console.log("\nClip 07 (27070-27100s):", test.length, "words");

// Try a range we KNOW has words (early in stream)
const early = filterByTimeRange(words, 600, 630);
console.log("Early test (600-630s):", early.length, "words");
if (early.length > 0) console.log("  First:", JSON.stringify(early[0]));
