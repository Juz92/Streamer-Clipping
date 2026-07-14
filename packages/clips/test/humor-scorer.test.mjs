import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAndRankMoments } from "../dist/lib/scorer.js";
import { detectAudioSpikes } from "../dist/lib/audio-analyzer.js";
import { detectChatSignals, detectTranscriptSignals } from "../dist/lib/signals.js";
import { mergeScenesIntoArcs } from "../dist/lib/scene-segmenter.js";
import { blendComedyScore, passesAutomaticComedyFloor } from "../dist/lib/llm-humor-scorer.js";
import { hasLaughOutLoudEvidence } from "../dist/story-gate.js";

function transcript(timestampSec, type, phrases = [type], weight = 0.9) {
  return { timestampSec, type, phrases, weight };
}

function chat(timestampSec, reactionType, laughHits = 0, shockHits = 0, spikeIntensity = 3) {
  return {
    timestampSec,
    messageRate: 2,
    emojiDensity: 0,
    keywordHits: reactionType === "laugh" ? ["lmao"] : reactionType === "shock" ? ["wtf"] : [],
    spikeIntensity,
    laughHits,
    shockHits,
    reactionDensity: 1,
    reactionType,
  };
}

function words(text, startSec = 0) {
  return text.split(/\s+/).map((word, i) => ({
    word,
    startMs: startSec * 1000 + i * 250,
    endMs: startSec * 1000 + i * 250 + 200,
  }));
}

test("humor scorer rewards streamer laughter only when chat laughs in the same 2-second window", () => {
  const synced = scoreAndRankMoments(
    [
      transcript(100, "laugh", ["hahaha"], 0.85),
      transcript(111, "shock", ["oh no"], 0.9),
    ],
    [chat(101, "laugh", 4, 0)],
    [{ timestampSec: 100.5, rmsLevel: -20, deltaFromAvg: 18, type: "laugh" }],
    300,
  );

  assert.equal(synced.length, 1);
  assert.equal(synced[0].scores.laughDetection, 1);
  assert.equal(synced[0].scores.chatSync, 1);

  const lateChat = scoreAndRankMoments(
    [transcript(100, "laugh", ["hahaha"], 0.85)],
    [chat(104.1, "laugh", 4, 0)],
    [{ timestampSec: 100.5, rmsLevel: -20, deltaFromAvg: 18, type: "laugh" }],
    300,
  );

  assert.equal(lateChat.length, 0, "chat laughter outside the same 2-second window should not pass as a synced LOL clip");
});

test("calm conversation with generic signal overlap is rejected", () => {
  const moments = scoreAndRankMoments(
    [transcript(50, "story", ["so basically"], 0.5)],
    [chat(51, "generic", 0, 0, 3)],
    [{ timestampSec: 50.5, rmsLevel: -18, deltaFromAvg: 22, type: "spike" }],
    300,
  );

  assert.equal(moments.length, 0);
});

test("audio processor detects laugh bursts and shock attacks", () => {
  const samples = [
    { timeSec: 0, rmsLevel: -44 },
    { timeSec: 0.5, rmsLevel: -42 },
    { timeSec: 1.0, rmsLevel: -20 },
    { timeSec: 1.5, rmsLevel: -34 },
    { timeSec: 2.0, rmsLevel: -22 },
    { timeSec: 2.5, rmsLevel: -35 },
    { timeSec: 3.0, rmsLevel: -21 },
    { timeSec: 3.5, rmsLevel: -36 },
    { timeSec: 4.0, rmsLevel: -23 },
  ];

  const signals = detectAudioSpikes(samples, 6, 20);
  assert.ok(signals.some((s) => s.type === "shock"), "expected abrupt quiet-to-loud attack to be tagged shock");
  assert.ok(signals.some((s) => s.type === "laugh"), "expected repeated loud pulses to be tagged laugh");
});

test("chat detector emits laugh-density eruptions even without raw volume spike", () => {
  const messages = [
    { timestampSec: 10.1, author: "a", text: "lmao" },
    { timestampSec: 10.2, author: "b", text: "HAHA" },
    { timestampSec: 10.3, author: "c", text: "lol dead" },
  ];
  const signals = detectChatSignals(messages, 2);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].reactionType, "laugh");
  assert.ok((signals[0].laughHits ?? 0) >= 3);
});

test("running-bit subject arcs pass when streamer shock has chat/audio confirmation", () => {
  const transcriptSignals = detectTranscriptSignals([
    ...words("wizard wizard wizard look at him oh my god he runs", 18),
    ...words("wizard wizard wizard what did they do to my boy oh my god", 30),
  ]);

  assert.ok(transcriptSignals.some((s) => s.phrases.includes("running-bit:wizard")));

  const moments = scoreAndRankMoments(
    transcriptSignals,
    [chat(35.5, "shock", 0, 3)],
    [{ timestampSec: 35.5, rmsLevel: -18, deltaFromAvg: 18, type: "shock" }],
    60,
  );

  assert.equal(moments.length, 1);
  assert.ok((moments[0].scores.runningBit ?? 0) >= 0.65);
});

function arcScene(id, startSec, repeatedWord) {
  const words = Array.from({ length: 4 }, (_, i) => ({
    word: repeatedWord,
    startMs: (startSec + i) * 1000,
    endMs: (startSec + i + 0.2) * 1000,
  }));
  return {
    id,
    startSec,
    endSec: startSec + 20,
    durationSec: 20,
    startReason: "stream-start",
    endReason: "energy-valley",
    audio: { meanRms: -32, maxRms: -20, minRms: -50, rmsRange: 30, hasValleyToPeak: true },
    chat: { messageCount: 0, meanRate: 0, maxRate: 0, hasDeadToEruption: false, laughHits: 0, shockHits: 0 },
    transcript: { wordCount: words.length, speakerChanges: 0, topKeywords: [repeatedWord], hasQuestion: false, hasExclamation: false },
    words,
    messages: [],
    samples: [],
  };
}

test("common tactical repetition is not promoted as a comedy loop", () => {
  const common = mergeScenesIntoArcs([arcScene("a", 0, "go"), arcScene("b", 20, "go")]);
  const distinctive = mergeScenesIntoArcs([arcScene("a", 0, "laser"), arcScene("b", 20, "laser")]);

  assert.equal(common[0].arcType, "sustained-energy");
  assert.equal(distinctive[0].arcType, "repetition");
});

test("LOL floor caps generic excitement and rejects panic-only moments", () => {
  assert.ok(blendComedyScore(0.95, 0.3) <= 0.49);
  assert.ok(blendComedyScore(0.85, 0.82) >= 0.8);
  assert.equal(hasLaughOutLoudEvidence({ humorPotential: 0.68, shockReaction: 0.95 }), false);
  assert.equal(hasLaughOutLoudEvidence({ humorPotential: 0.8, funnyQuote: true }), true);
  assert.equal(hasLaughOutLoudEvidence({ laughOutLoudScore: 0.72 }), true);
});

test("automatic shortlist may return zero instead of legacy filler", () => {
  assert.equal(passesAutomaticComedyFloor(0.64), false);
  assert.equal(passesAutomaticComedyFloor(0.65), true);
});
