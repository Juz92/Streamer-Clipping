import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipAnchorSec,
  clipFallsInVod,
  crowdMomentId,
  parseClipDumpJson,
  toCrowdAnchors,
  type TwitchClip,
  type VodWindow,
} from "../src/lib/twitch-clips.js";

// Fixtures captured live on 2026-11-02 from twitch.tv/theburntpeanut/clips and
// the matching YouTube VOD, so these are real numbers rather than invented ones.
const VOD: VodWindow = {
  streamId: "VZkl3s33Ryw", // COD MW4 nuke challenge
  releaseTimestamp: 1793143296, // yt-dlp release_timestamp: broadcast start
  durationSec: 41945,
};

/** The VOD's `timestamp` field — when it was published, ~15h after it started. */
const VOD_PUBLISHED_TIMESTAMP = 1793197854;

const clip = (id: string, timestamp: number, durationSec = 23, title = "clip"): TwitchClip =>
  ({ id, title, timestamp, durationSec });

const INSIDE = [
  clip("4214606804", 1793146282, 23, "Spawns ruins peanuts nuke"),
  clip("208281447", 1793147137, 16, "peanut hip thrusts an Egirl"),
  clip("1577796157", 1793148735, 30, "get nuked"),
];
const OUTSIDE = [
  clip("2738154421", 1793219681, 60, "Kim Jong Poon"),   // a later broadcast
  clip("1456119400", 1793064023, 46, "D addict"),        // an earlier one
];

test("a clip's anchor is its creation time minus the broadcast start", () => {
  // Independently measured at 00:49:46 in the VOD while researching the route.
  assert.equal(clipAnchorSec(INSIDE[0], VOD), 2986);
  assert.equal(Math.floor(2986 / 60), 49);
  assert.equal(2986 % 60, 46);
});

test("using the VOD's published timestamp instead of its release time is wildly wrong", () => {
  // The guard that matters: these two fields differ by about fifteen hours, and
  // picking the wrong one puts every anchor outside the video with no error.
  const wrong = clipAnchorSec(INSIDE[0], { ...VOD, releaseTimestamp: VOD_PUBLISHED_TIMESTAMP });
  assert.ok(wrong < 0, "the published timestamp yields a negative anchor");
  assert.ok(Math.abs(wrong) > 50_000, `expected a gross error, got ${wrong}s`);
});

test("containment decides which VOD a clip belongs to", () => {
  for (const c of INSIDE) assert.ok(clipFallsInVod(c, VOD), `${c.title} should be inside`);
  for (const c of OUTSIDE) assert.ok(!clipFallsInVod(c, VOD), `${c.title} should be outside`);
});

test("clips from other broadcasts are dropped, not clamped", () => {
  const anchors = toCrowdAnchors([...INSIDE, ...OUTSIDE], VOD);
  assert.equal(anchors.length, 3);
  assert.deepEqual(
    anchors.map((a) => a.clipId).sort(),
    INSIDE.map((c) => c.id).sort(),
  );
});

test("the window leads the anchor and clears the clip's own duration", () => {
  const [anchor] = toCrowdAnchors([INSIDE[0]], VOD);
  assert.equal(anchor.anchorSec, 2986);
  assert.equal(anchor.startSec, 2986 - 90);
  assert.equal(anchor.endSec, 2986 + 23 + 30, "the clip's duration is part of the moment");
  assert.equal(anchor.source, "twitch-clip");
  assert.deepEqual(anchor.routes, ["twitch-clip"]);
});

test("the window is clamped to the VOD at both ends", () => {
  const atStart = toCrowdAnchors([clip("a", VOD.releaseTimestamp + 5)], VOD);
  assert.equal(atStart[0].startSec, 0, "cannot lead in before the broadcast began");

  const atEnd = toCrowdAnchors([clip("b", VOD.releaseTimestamp + VOD.durationSec - 1, 600)], VOD);
  assert.equal(atEnd[0].endSec, VOD.durationSec, "cannot run past the end of the VOD");
});

test("anchors come back in source order", () => {
  const anchors = toCrowdAnchors([INSIDE[2], INSIDE[0], INSIDE[1]], VOD);
  assert.deepEqual(anchors.map((a) => a.startSec), [...anchors].sort((x, y) => x - y).map((a) => a.startSec));
  assert.ok(anchors[0].startSec < anchors[2].startSec);
});

test("the moment id is stable across harvests", () => {
  assert.equal(crowdMomentId(INSIDE[0]), "twitch-4214606804");
  assert.equal(crowdMomentId({ ...INSIDE[0], title: "renamed" }), "twitch-4214606804");
});

test("dump-json parsing survives yt-dlp's warning preamble", () => {
  // yt-dlp prints version warnings and, on this machine, a cookie traceback
  // *after* emitting records. Neither is JSON and neither should cost us a clip.
  const stdout = [
    "WARNING: Your yt-dlp version (2026.03.17) is older than 90 days!",
    JSON.stringify({ id: "1", title: "a", timestamp: 1793146282, duration: 23, view_count: 9 }),
    "not json at all",
    "{ broken json",
    JSON.stringify({ id: "2", title: "b", timestamp: 1793146999, duration: 30 }),
    JSON.stringify({ id: "3", title: "no timestamp" }),
    "Traceback (most recent call last):",
  ].join("\n");

  const clips = parseClipDumpJson(stdout);
  assert.equal(clips.length, 2, "rows without a timestamp cannot be placed and are skipped");
  assert.deepEqual(clips.map((c) => c.id), ["1", "2"]);
  assert.equal(clips[0].viewCount, 9);
  assert.equal(clips[1].viewCount, undefined);
});
