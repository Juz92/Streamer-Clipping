import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFile } from "../src/preflight.js";

// Regression guard for 2026-11-02: preflight reported
//   [PASS] manifest.videoPath: ...\stream.mp4 (10977.7 MB)
// for a OneDrive cloud placeholder that failed every read with errno 22.
// existsSync and statSync are metadata calls and succeed on a placeholder, so
// only an actual read tells the two apart.

function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "preflight-readability-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a readable file with content passes", () => {
  withTempDir((dir) => {
    const path = join(dir, "stream.mp4");
    writeFileSync(path, "not really video, but readable");
    const result = checkFile("manifest.videoPath", path, true);
    assert.equal(result.severity, "PASS", result.message);
  });
});

test("a path that exists but cannot be read does not pass", () => {
  withTempDir((dir) => {
    // A directory stands in for the placeholder: it exists, so existsSync and
    // statSync both succeed, and opening it as a file fails. Whether it is
    // caught as empty or as unreadable depends on the platform's directory
    // size; what must never happen is PASS.
    const path = join(dir, "looks-like-a-file.mp4");
    mkdirSync(path);
    const result = checkFile("manifest.videoPath", path, true);
    assert.notEqual(
      result.severity,
      "PASS",
      "a path that cannot be read as a file must never be reported as present and fine",
    );
    assert.equal(result.severity, "BLOCK");
  });
});

test("an empty file does not pass", () => {
  withTempDir((dir) => {
    const path = join(dir, "stream.mp4");
    writeFileSync(path, "");
    const result = checkFile("manifest.videoPath", path, true);
    assert.equal(result.severity, "BLOCK");
    assert.match(result.message, /empty/);
  });
});

test("a missing required path blocks and a missing optional path only warns", () => {
  withTempDir((dir) => {
    const path = join(dir, "absent.json");
    assert.equal(checkFile("manifest.chatPath", path, true).severity, "BLOCK");
    assert.equal(checkFile("manifest.chatPath", path, false).severity, "WARN");
  });
});

test("an unreadable optional path warns rather than blocking", () => {
  withTempDir((dir) => {
    const path = join(dir, "optional.mp4");
    mkdirSync(path);
    assert.equal(checkFile("manifest.audioLevelsPath", path, false).severity, "WARN");
  });
});
