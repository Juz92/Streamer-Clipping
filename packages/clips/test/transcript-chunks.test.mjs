import test from "node:test";
import assert from "node:assert/strict";
import { windowTimestampedTranscript } from "../dist/lib/gpt55-queries.js";

test("builds overlapping time windows that fully contain a 96-second arc", () => {
  const lines = Array.from({ length: 31 }, (_, i) => {
    const sec = i * 10;
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    return `[00:${mm}:${ss}] line-${sec}`;
  });

  const windows = windowTimestampedTranscript(lines.join("\n"), 180, 60);

  assert.ok(windows.length > 1);
  for (const line of lines) assert.ok(windows.some((window) => window.includes(line)), line);
  assert.ok(
    windows.some((window) => window.includes("line-70") && window.includes("line-160")),
    "expected one window to contain the full 70s-166s gold-style arc",
  );
});
