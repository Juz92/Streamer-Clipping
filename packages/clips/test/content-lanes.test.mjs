import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoveryRankScore,
  passesAutomaticDiscoveryFloor,
} from "../dist/lib/content-lanes.js";
import { hasDiscoveryPayoffEvidence, chooseMomentSource } from "../dist/story-gate.js";
import { parseLLMResponse } from "../dist/lib/llm-humor-scorer.js";

test("lane floor recovers strong personality and gameplay without weakening LOL fallback", () => {
  assert.equal(passesAutomaticDiscoveryFloor({
    contentLane: "peanut-bits",
    laneScore: 0.72,
    laughOutLoudScore: 0.3,
  }), true);
  assert.equal(passesAutomaticDiscoveryFloor({
    contentLane: "peanut-plays",
    laneScore: 0.82,
    laughOutLoudScore: 0.2,
  }), true);
  assert.equal(passesAutomaticDiscoveryFloor({
    contentLane: "reject",
    laneScore: 0.99,
    laughOutLoudScore: 0.99,
  }), false);
  assert.equal(passesAutomaticDiscoveryFloor({ laughOutLoudScore: 0.64 }), false);
  assert.equal(passesAutomaticDiscoveryFloor({ laughOutLoudScore: 0.65 }), true);
});

test("lane floors stay stricter for commodity gameplay and context-heavy missions", () => {
  assert.equal(passesAutomaticDiscoveryFloor({ contentLane: "peanut-bits", laneScore: 0.69 }), false);
  assert.equal(passesAutomaticDiscoveryFloor({ contentLane: "squad-chaos", laneScore: 0.69 }), false);
  assert.equal(passesAutomaticDiscoveryFloor({ contentLane: "wtf-game-moments", laneScore: 0.74 }), false);
  assert.equal(passesAutomaticDiscoveryFloor({ contentLane: "peanut-plays", laneScore: 0.79 }), false);
  assert.equal(passesAutomaticDiscoveryFloor({ contentLane: "the-mission", laneScore: 0.79 }), false);
});

test("personality-first ranking breaks equal-score ties without burying exceptional play", () => {
  const bit = discoveryRankScore({
    contentLane: "peanut-bits",
    laneScore: 0.8,
    comedyScore: 0.75,
  });
  const play = discoveryRankScore({
    contentLane: "peanut-plays",
    laneScore: 0.8,
    comedyScore: 0.3,
  });
  const exceptionalPlay = discoveryRankScore({
    contentLane: "peanut-plays",
    laneScore: 0.92,
    comedyScore: 0.3,
  });

  assert.ok(bit > play);
  assert.ok(exceptionalPlay > bit);
  assert.equal(discoveryRankScore({ contentLane: "reject", laneScore: 1, comedyScore: 1 }), 0);
});

test("story gate accepts strong lane payoff without pretending it is comedy", () => {
  assert.equal(hasDiscoveryPayoffEvidence({
    contentLane: "peanut-plays",
    payoffType: "wow",
    laneScore: 0.82,
    laughOutLoudScore: 0.2,
  }), true);
  assert.equal(hasDiscoveryPayoffEvidence({
    contentLane: "the-mission",
    payoffType: "tension",
    laneScore: 0.79,
  }), false);
  assert.equal(hasDiscoveryPayoffEvidence({ laughOutLoudScore: 0.72 }), true);
});

test("LLM parser normalizes lane contract and rejects unknown labels", () => {
  const parsed = parseLLMResponse(JSON.stringify({ scenes: [{
    sceneId: "scene-001",
    humorScore: 0.4,
    laughOutLoudScore: 0.3,
    contentLane: "Peanut Bits",
    payoffType: "ROAST",
    laneScore: 0.83,
    whyWorthWatching: "Peanut turns a viewer insult into a character bit.",
    flashTimeSec: 10,
    endTimeSec: 20,
    confidence: 0.9,
    tags: ["chat-roast"],
  }, {
    sceneId: "scene-002",
    contentLane: "generic-gameplay",
    payoffType: "noise",
    laneScore: 0.95,
  }] }), ["scene-001", "scene-002"]);

  assert.equal(parsed.get("scene-001").contentLane, "peanut-bits");
  assert.equal(parsed.get("scene-001").payoffType, "roast");
  assert.equal(parsed.get("scene-001").laneScore, 0.83);
  assert.match(parsed.get("scene-001").whyWorthWatching, /viewer insult/);
  assert.equal(parsed.get("scene-002").contentLane, "reject");
  assert.equal(parsed.get("scene-002").payoffType, "none");
});

test("LLM parser converts null provider content into safe rejects", () => {
  const parsed = parseLLMResponse(null, ["scene-null"]);
  assert.equal(parsed.get("scene-null")?.contentLane, "reject");
  assert.equal(parsed.get("scene-null")?.laneScore, 0);
});

test("story gate prefers lane-aware scorer moments over stale legacy artifacts", () => {
  const notebook = [{ rank: 1, description: "legacy notebook" }];
  const unified = [{ rank: 2, description: "legacy unified" }];
  const laneAware = [{ rank: 3, contentLane: "peanut-plays", payoffType: "wow", laneScore: 0.85 }];

  assert.equal(chooseMomentSource(notebook, unified, laneAware), laneAware);
  assert.equal(chooseMomentSource(notebook, unified, [{ rank: 4 }]), notebook);
});
