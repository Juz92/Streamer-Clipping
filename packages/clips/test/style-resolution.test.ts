import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertClipStyleCalibrated,
  hasGameStyleProfiles,
  resolveStyleFor,
} from "../src/lib/layout-style.js";

// Guards the crop key order. Keying crops on streamId guarantees staleness —
// an entry expires with the stream — so the generalising key is the game, with
// the stream override kept for a broadcast where the overlay moved.

test("a calibrated stream resolves a style", () => {
  const style = resolveStyleFor("gp4sqhiaxNo");
  assert.ok(style, "gp4sqhiaxNo is one of the calibrated July streams");
  assert.ok(style.avatar, "it carries an avatar region");
});

test("an uncalibrated stream with no game resolves nothing", () => {
  assert.equal(resolveStyleFor("some-new-stream"), undefined);
  assert.equal(resolveStyleFor(undefined), undefined);
  assert.equal(resolveStyleFor("some-new-stream", "Arc Raiders"), undefined,
    "no game profile is calibrated yet, so a game name alone resolves nothing");
});

test("a stream override beats the game, because it exists to override the game", () => {
  // Same stream, with and without a game hint: the stream entry must win, so a
  // broadcast whose overlay moved is not dragged back to the game's usual crop.
  const withGame = resolveStyleFor("gp4sqhiaxNo", "Holdfast: Nations At War");
  const withoutGame = resolveStyleFor("gp4sqhiaxNo");
  assert.deepEqual(withGame, withoutGame);
});

test("no game profiles are calibrated yet, and that is deliberate", () => {
  // A crop cannot be verified except by rendering and looking at the frame.
  // If this starts failing, someone has added a profile — check they
  // calibrated it against a real frame rather than copying another stream's.
  assert.equal(hasGameStyleProfiles(), false);
});

test("a clip whose game has no profile fails loudly, naming both keys", () => {
  assert.throws(
    () => assertClipStyleCalibrated("some-new-stream", "Arc Raiders", 3),
    (err: Error) => {
      assert.match(err.message, /Clip #3/);
      assert.match(err.message, /some-new-stream/);
      assert.match(err.message, /Arc Raiders/);
      assert.match(err.message, /guesswork/);
      return true;
    },
  );
});

test("a clip with an undetermined game says so rather than blaming the game", () => {
  assert.throws(
    () => assertClipStyleCalibrated("some-new-stream", null, 1),
    /could not be determined/,
  );
});

test("a clip on a calibrated stream passes regardless of game", () => {
  assert.doesNotThrow(() => assertClipStyleCalibrated("gp4sqhiaxNo", null, 1));
  assert.doesNotThrow(() => assertClipStyleCalibrated("gp4sqhiaxNo", "Anything", 1));
});
