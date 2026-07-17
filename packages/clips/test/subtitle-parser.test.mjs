import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVtt, vttToWordTimestamps } from "../dist/lib/subtitle-parser.js";

test("YouTube VTT keeps speech after a blank spacer inside a cue", () => {
  const dir = mkdtempSync(join(tmpdir(), "vtt-spacer-"));
  const path = join(dir, "sample.vtt");
  writeFileSync(path, `WEBVTT\n\n00:00:01.000 --> 00:00:03.000 align:start\n \n>> But<00:00:01.200><c> I</c><00:00:01.400><c> would</c><00:00:01.600><c> like</c>\n\n`);
  try {
    assert.deepEqual(vttToWordTimestamps(parseVtt(path)).map((word) => word.word), ["But", "I", "would", "like"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("YouTube VTT keeps a repeated word that completes the next rolling cue", () => {
  const dir = mkdtempSync(join(tmpdir(), "vtt-repeat-"));
  const path = join(dir, "sample.vtt");
  writeFileSync(path, `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nApex<00:00:01.200><c> document.</c><00:00:01.400><c> They</c><00:00:01.600><c> got</c><00:00:01.800><c> an</c><00:00:01.900><c> Apex</c>\n\n00:00:02.000 --> 00:00:03.000\ndocument.\n\n`);
  try {
    assert.equal(vttToWordTimestamps(parseVtt(path)).at(-1)?.word, "document.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
