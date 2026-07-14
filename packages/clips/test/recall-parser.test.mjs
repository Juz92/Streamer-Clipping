import test from "node:test";
import assert from "node:assert/strict";
import { parseRecallCandidates } from "../dist/lib/notebooklm-parser.js";

const loveIsland = {
  startSec: 8834,
  endSec: 8913,
  hook: "Love Island normal guy: A complete character riff with a clean consultant payoff",
  quote: "Imagine one normal guy on Love Island",
  categories: ["peanut-bits", "character-moment"],
  setupNeeded: false,
  setupOffsetSec: 0,
  strength: 5,
  sourceQuery: "humor",
};

const hrAdvice = {
  startSec: 6336,
  endSec: 6473,
  hook: "Four tips to get out of HR: Long recall nomination to trim after visual review",
  quote: "There's demons down the road",
  categories: ["peanut-bits", "character-moment"],
  setupNeeded: false,
  setupOffsetSec: 0,
  strength: 5,
  sourceQuery: "humor",
};

test("parses JSON recall output, keeps pipe fallback, and enforces 20-140 second nominations", () => {
  const jsonResponse = {
    value: {
      conversation_id: "json",
      answer: JSON.stringify({
        windows: [
          {
            windowStart: "02:27:00",
            candidate: {
              start: "02:27:14",
              end: "02:28:33",
              lane: "Peanut Bits",
              strength: 5,
              title: "Love Island normal guy",
              reason: "A complete character riff with a clean consultant payoff",
              quote: "Imagine one normal guy on Love Island",
            },
          },
          {
            windowStart: "01:45:00",
            candidate: {
              start: "01:45:36",
              end: "01:47:53",
              lane: "Peanut Bits",
              strength: 5,
              title: "Four tips to get out of HR",
              reason: "Long recall nomination to trim after visual review",
              quote: "There's demons down the road",
            },
          },
          {
            windowStart: "02:50:00",
            candidate: {
              start: "02:50:00",
              end: "02:50:05",
              lane: "Peanut Bits",
              strength: 4,
              title: "Too short",
              reason: "Ignored",
              quote: "Ignored",
            },
          },
        ],
      }),
    },
  };
  assert.deepEqual(parseRecallCandidates(jsonResponse), [loveIsland, hrAdvice]);

  const pipeResponse = {
    value: {
      conversation_id: "pipe",
      answer: "1. window: CANDIDATE|02:27:14|02:28:33|Peanut Bits|5|Love Island normal guy|A complete character riff with a clean consultant payoff|Imagine one normal guy on Love Island",
    },
  };
  assert.deepEqual(parseRecallCandidates(pipeResponse), [loveIsland]);
});
