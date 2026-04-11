import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCleanTranscript } from "../src/lib/subtitle-parser.js";

test("writeCleanTranscript produces timestamped lines from VTT", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "peanut-test-"));
  const vttPath = join(tmpDir, "test.vtt");
  const outPath = join(tmpDir, "clean.txt");

  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:01.500 --> 00:00:03.000
Hello world

00:00:05.000 --> 00:00:07.500
This is a test
`;
  writeFileSync(vttPath, vtt, "utf-8");

  const count = writeCleanTranscript(vttPath, outPath);

  assert.equal(count, 2);
  const content = readFileSync(outPath, "utf-8");
  assert.match(content, /^\[00:00:01\] Hello world$/m);
  assert.match(content, /^\[00:00:05\] This is a test$/m);

  rmSync(tmpDir, { recursive: true, force: true });
});
