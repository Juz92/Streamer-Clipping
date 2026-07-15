import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autonomousProofIsReusable,
  buildAutonomousVisualProof,
  buildBoundaryReviewPrompt,
  buildPovAttributionPrompt,
  candidateNeedsPovKillAttribution,
  validatePovAttributionReview,
} from "../src/lib/autonomous-boundary-review.js";

const candidate = {
  candidateId: "job-004:gameplay-a",
  startSec: 100,
  endSec: 130,
  previewStartSec: 95,
  previewEndSec: 160,
};

const response = {
  candidateId: candidate.candidateId,
  objectiveEvent: true,
  attributionAccurate: true,
  subjectRole: "actor",
  attribution: "POV player visibly lands the kill",
  confidence: 0.92,
  beats: {
    setupStartSec: 5,
    premiseClearSec: 12,
    actionStartSec: 20,
    payoffStartSec: 30,
    payoffEndSec: 32,
  },
  endpointCandidates: [
    { type: "minimum", timeSec: 32.5, reason: "kill confirmed" },
    { type: "natural", timeSec: 36, reason: "direct reaction completes" },
    { type: "extended", timeSec: 45, reason: "last worthwhile squad response" },
  ],
  recommendedType: "natural",
  nextTopicStartSec: 50,
};

const words = [
  { word: "got", startMs: 130_500, endMs: 131_000 },
  { word: "him!", startMs: 131_100, endMs: 132_000 },
  { word: "next", startMs: 145_000, endMs: 146_000 },
];

test("boundary prompt and validator use the same attribution contract", () => {
  const prompt = buildBoundaryReviewPrompt({
    ...candidate,
    description: "POV player lands the kill",
    categories: ["peanut-plays", "skill"],
  }, 65);

  assert.match(prompt, /Candidate content starts: 5\.000s/);
  assert.match(prompt, /"attributionAccurate": true/);
  assert.match(prompt, /"subjectRole": "actor"/);
  assert.match(prompt, /mission.*correct minor wording/is);
  assert.match(prompt, /recommend minimum/is);
  assert.doesNotMatch(prompt, /povPlayerCausedResult/);
});

test("claim-blind POV attribution gate requires visible causal evidence", () => {
  const prompt = buildPovAttributionPrompt(candidate.candidateId);
  assert.match(prompt, /Ignore.*candidate claim/i);
  assert.doesNotMatch(prompt, /lands the kill/i);

  assert.equal(validatePovAttributionReview({
    verdict: "pov_kill_confirmed",
    povActionVisible: true,
    resultVisible: true,
    evidence: "POV shot produces an on-screen ENEMY KILLED confirmation",
    confidence: 1,
  }).verified, true);
  assert.equal(validatePovAttributionReview({
    verdict: "no_confirmed_pov_kill",
    povActionVisible: true,
    resultVisible: true,
    evidence: "POV fires but dies without an on-screen kill confirmation",
    confidence: 1,
  }).verified, false);
});

test("POV kill attribution runs for every positive kill claim", () => {
  assert.equal(candidateNeedsPovKillAttribution({
    description: "POV player lands the kill",
    categories: ["peanut-plays"],
  }), true);
  assert.equal(candidateNeedsPovKillAttribution({
    description: "A bizarre kill caps the moment",
    categories: ["wtf-game-moments"],
  }), true);
  assert.equal(candidateNeedsPovKillAttribution({
    description: "Shot doesn't kill, it's just a sick joke",
    categories: ["skill", "wtf-game-moments"],
  }), false);
  assert.equal(candidateNeedsPovKillAttribution({
    description: "The squad races to light the fuse",
    categories: ["the-mission"],
  }), false);
});

test("autonomous boundary review creates an absolute source-grounded proof", () => {
  const proof = buildAutonomousVisualProof({
    candidate,
    response,
    reviewDurationSec: 65,
    words,
    model: "google/gemini-3.5-flash",
  });

  assert.equal(proof.verified, true);
  assert.equal(proof.reviewedCandidateStartSec, 100);
  assert.equal(proof.reviewedCandidateEndSec, 130);
  assert.equal(proof.beats?.setupStartSec, 100);
  assert.equal(proof.beats?.payoffEndSec, 127);
  assert.equal(proof.beats?.reactionEndSec, 132);
  assert.equal(proof.timestampSec, 127);
  assert.equal(proof.review.selectedType, "natural");
  assert.match(proof.description, /POV player visibly lands the kill/);
});

test("transient model failures are not cached as current proofs", () => {
  const proof = buildAutonomousVisualProof({
    candidate,
    response,
    reviewDurationSec: 65,
    words,
    model: "google/gemini-3.5-flash",
  });
  assert.equal(autonomousProofIsReusable(proof, candidate, "google/gemini-3.5-flash"), true);
  assert.equal(autonomousProofIsReusable({
    ...proof,
    verified: false,
    review: { ...proof.review, rejectionReason: "Model review failed: timeout" },
  }, candidate, "google/gemini-3.5-flash"), false);
  assert.equal(autonomousProofIsReusable({
    ...proof,
    verified: false,
    review: { ...proof.review, rejectionReason: "Speech boundary review failed: timeout" },
  }, candidate, "google/gemini-3.5-flash"), false);
  assert.equal(autonomousProofIsReusable({
    ...proof,
    verified: false,
    review: {
      ...proof.review,
      attributionGate: { ...proof.review.attributionGate, evidence: "Attribution model failed: timeout" },
    },
  }, candidate, "google/gemini-3.5-flash"), false);
});

test("unsafe speech snap keeps the safe visual endpoint", () => {
  const proof = buildAutonomousVisualProof({
    candidate,
    response: { ...response, nextTopicStartSec: 40 },
    reviewDurationSec: 65,
    words: [{ word: "later!", startMs: 134_000, endMs: 136_000 }],
    model: "google/gemini-3.5-flash",
  });

  assert.equal(proof.verified, true);
  assert.equal(proof.beats?.reactionEndSec, 131);
});

test("autonomous boundary review fails closed on unsafe model decisions", () => {
  const cases: Array<[string, unknown]> = [
    ["malformed response", null],
    ["placeholder attribution", { ...response, attribution: "what visibly happened and the POV player's role" }],
    ["wrong player", { ...response, attributionAccurate: false }],
    ["pre-candidate payoff", {
      ...response,
      beats: {
        setupStartSec: 0,
        premiseClearSec: 1,
        actionStartSec: 2,
        payoffStartSec: 3,
        payoffEndSec: 4,
      },
      endpointCandidates: [
        { type: "minimum", timeSec: 4, reason: "result" },
        { type: "natural", timeSec: 5, reason: "reaction" },
        { type: "extended", timeSec: 6, reason: "tail" },
      ],
    }],
    ["low confidence", { ...response, confidence: 0.5 }],
    ["unordered beats", { ...response, beats: { ...response.beats, actionStartSec: 10 } }],
    ["next-topic bleed", { ...response, nextTopicStartSec: 35 }],
    ["review-edge endpoint", {
      ...response,
      recommendedType: "extended",
      endpointCandidates: response.endpointCandidates.map((item) =>
        item.type === "extended" ? { ...item, timeSec: 64.5 } : item,
      ),
    }],
    ["candidate mismatch", { ...response, candidateId: "job-004:other" }],
  ];

  for (const [label, unsafe] of cases) {
    const proof = buildAutonomousVisualProof({
      candidate,
      response: unsafe,
      reviewDurationSec: 65,
      words,
      model: "google/gemini-3.5-flash",
    });
    assert.equal(proof.verified, false, label);
    assert.equal(proof.beats, undefined, label);
    assert.ok(proof.review.rejectionReason, label);
  }
});
