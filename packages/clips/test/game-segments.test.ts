import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gameAtSec,
  toGameSegments,
  type TwitchChapter,
} from "../src/lib/twitch-clips.js";

// Chapter boundaries below are the real ones from data/clips/twitch-vod-*.json.
// The simulcast offset is a parameter, so it is synthetic here; measured offsets
// across seven matched stream pairs were 0, 0, +1, -2, +3 and +9 seconds.

/** twitch-vod-2814633597: a stream that switched game once. */
const TWO_GAME: TwitchChapter[] = [
  { title: "Chivalry 2", start_time: 0, end_time: 18005 },
  { title: "Holdfast: Nations At War", start_time: 18005, end_time: 27520 },
];

/** twitch-vod-2812381177: a party-game night, five games. */
const PARTY_NIGHT: TwitchChapter[] = [
  { title: "MECCHA CHAMELEON", start_time: 0, end_time: 10957 },
  { title: "Gamble With Your Friends", start_time: 10957, end_time: 15151 },
  { title: "Super Battle Golf", start_time: 15151, end_time: 17263 },
  { title: "RV There Yet?", start_time: 17263, end_time: 23008 },
  { title: "Liar's Bar", start_time: 23008, end_time: 27640 },
];

test("a stream that switched game once yields two segments", () => {
  const segments = toGameSegments(TWO_GAME, 1000, 1000, 27520);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { game: "Chivalry 2", startSec: 0, endSec: 18005 });
  assert.equal(segments[1].game, "Holdfast: Nations At War");
});

test("the simulcast offset shifts every boundary", () => {
  // Twitch started 3s after YouTube, so chapter times sit 3s later on the
  // YouTube timeline.
  const segments = toGameSegments(TWO_GAME, 1003, 1000, 27520);
  assert.equal(segments[0].startSec, 3);
  assert.equal(segments[0].endSec, 18008);
  assert.equal(segments[1].startSec, 18008);
});

test("a party-game night segments into every game", () => {
  const segments = toGameSegments(PARTY_NIGHT, 1000, 1000, 27640);
  assert.equal(segments.length, 5);
  assert.deepEqual(segments.map((s) => s.game), [
    "MECCHA CHAMELEON",
    "Gamble With Your Friends",
    "Super Battle Golf",
    "RV There Yet?",
    "Liar's Bar",
  ]);
});

test("a single-game stream yields one segment, which is correct and not a failure", () => {
  // Five of the seven VODs on disk look like this: one game all night.
  const segments = toGameSegments(
    [{ title: "Sand: Raiders Of Sophie", start_time: 0, end_time: 27230 }],
    1000, 1000, 27230,
  );
  assert.equal(segments.length, 1);
  assert.equal(segments[0].game, "Sand: Raiders Of Sophie");
  assert.equal(segments[0].endSec, 27230);
});

test("segments are clamped to the YouTube timeline at both ends", () => {
  // Twitch started 60s earlier, so the first chapter would begin before the
  // YouTube broadcast; and Twitch ran longer than YouTube kept.
  const segments = toGameSegments(TWO_GAME, 940, 1000, 20000);
  assert.equal(segments[0].startSec, 0, "cannot begin before the YouTube broadcast");
  assert.ok(segments.every((s) => s.endSec <= 20000), "cannot run past the YouTube duration");
});

test("unusable chapters are dropped rather than guessed at", () => {
  const segments = toGameSegments([
    { title: "", start_time: 0, end_time: 100 },
    { title: "   ", start_time: 100, end_time: 200 },
    { title: "Zero length", start_time: 300, end_time: 300 },
    { title: "Inverted", start_time: 500, end_time: 400 },
    { title: "Real Game", start_time: 600, end_time: 900 },
  ], 1000, 1000, 1000);
  assert.deepEqual(segments.map((s) => s.game), ["Real Game"]);
});

test("gameAtSec finds the game covering a candidate", () => {
  const segments = toGameSegments(TWO_GAME, 1000, 1000, 27520);
  assert.equal(gameAtSec(segments, 0), "Chivalry 2");
  assert.equal(gameAtSec(segments, 18004), "Chivalry 2");
  assert.equal(gameAtSec(segments, 18005), "Holdfast: Nations At War", "boundary belongs to the later game");
  assert.equal(gameAtSec(segments, 27519), "Holdfast: Nations At War");
});

test("gameAtSec returns null outside every segment, and null must not be defaulted away", () => {
  const segments = toGameSegments(TWO_GAME, 1000, 1000, 27520);
  assert.equal(gameAtSec(segments, 27520), null, "the end boundary is exclusive");
  assert.equal(gameAtSec(segments, 99999), null);
  assert.equal(gameAtSec([], 10), null, "no chapters means no game, not a guess");
});
