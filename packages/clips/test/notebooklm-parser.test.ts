import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHumorQuery,
  parseRunningBitsQuery,
  parseTimestampToSec,
} from "../src/lib/notebooklm-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures");

test("parseTimestampToSec handles [HH:MM:SS] format", () => {
  assert.equal(parseTimestampToSec("[00:00:00]"), 0);
  assert.equal(parseTimestampToSec("[00:01:30]"), 90);
  assert.equal(parseTimestampToSec("[01:12:47]"), 4367);
  assert.equal(parseTimestampToSec("[11:00:19]"), 39619);
});

test("parseTimestampToSec returns -1 for malformed input", () => {
  assert.equal(parseTimestampToSec("not a timestamp"), -1);
  assert.equal(parseTimestampToSec(""), -1);
});

test("parseHumorQuery extracts picks from query 1 fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "query1-humor.json"), "utf-8"),
  );
  const picks = parseHumorQuery(fixture);

  // Trial had 15 picks
  assert.ok(picks.length >= 10, `expected >= 10 picks, got ${picks.length}`);
  assert.ok(picks.length <= 20, `expected <= 20 picks, got ${picks.length}`);

  // Every pick has required fields
  for (const p of picks) {
    assert.ok(p.startSec >= 0);
    assert.ok(p.hook.length > 0);
    assert.ok(p.categories.length > 0);
    assert.ok(
      ["callback", "running-bit", "dry-joke", "absurdist", "reaction-gold", "character-moment"].includes(
        p.categories[0],
      ),
      `unexpected category: ${p.categories[0]}`,
    );
    assert.equal(typeof p.setupNeeded, "boolean");
    assert.equal(p.sourceQuery, "humor");
  }
});

test("parseHumorQuery finds the berry logic pick at 01:12:47", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "query1-humor.json"), "utf-8"),
  );
  const picks = parseHumorQuery(fixture);
  const berry = picks.find(
    (p) => Math.abs(p.startSec - 4367) <= 5,
  );
  assert.ok(berry, "expected to find berry logic pick near 01:12:47");
  assert.match(berry!.hook.toLowerCase(), /30,?000|berr/);
  assert.equal(berry!.categories[0], "dry-joke");
});

test("parseRunningBitsQuery extracts bits from query 2 fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "query2-runningbits.json"), "utf-8"),
  );
  const picks = parseRunningBitsQuery(fixture);

  // Trial had 10 running bits, each with best-clip timestamp
  assert.ok(picks.length >= 5, `expected >= 5 bits, got ${picks.length}`);

  for (const p of picks) {
    assert.ok(p.startSec >= 0);
    assert.equal(p.categories[0], "running-bit");
    assert.equal(p.sourceQuery, "running-bits");
    // Running bits are multi-timestamp by nature; should carry additional refs
    assert.ok(
      p.additionalTimestamps === undefined ||
        Array.isArray(p.additionalTimestamps),
    );
  }
});
