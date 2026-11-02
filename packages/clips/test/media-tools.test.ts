import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// Imported by source path, not as "@ltx/shared": in a git worktree nested
// inside the repo, node resolves that specifier to the MAIN checkout's
// packages/shared symlink, so the package import would test the wrong file.
import { ensureMediaToolsOnPath } from "../../shared/src/utils/media-tools.js";

// Regression guard for 2026-11-02: ffmpeg and ffprobe were installed under
// %LOCALAPPDATA%\Microsoft\WinGet\Links and resolved from neither Git Bash nor
// PowerShell, so every module that shells out by bare program name was broken
// while the binaries sat on disk working fine.

test("ffprobe is callable by bare program name", () => {
  ensureMediaToolsOnPath();
  const result = spawnSync("ffprobe", ["-version"], { encoding: "utf-8" });
  assert.equal(
    result.error,
    undefined,
    "ffprobe did not resolve on PATH. ffmpeg and ffprobe are required external " +
      "tools; install them or set FFMPEG_DIR to the directory holding both.",
  );
  assert.match(result.stdout, /ffprobe version/);
});

test("the fallback directory is appended, so an existing ffmpeg keeps winning", () => {
  const before = process.env.PATH ?? "";
  try {
    ensureMediaToolsOnPath();
    const after = process.env.PATH ?? "";
    assert.ok(
      after.startsWith(before),
      "PATH was modified ahead of its existing entries; the fallback must only " +
        "ever be appended so a working ffmpeg is never shadowed",
    );
  } finally {
    process.env.PATH = before;
  }
});

test("adding the fallback twice is a no-op", () => {
  const before = process.env.PATH ?? "";
  try {
    ensureMediaToolsOnPath();
    const afterFirst = process.env.PATH ?? "";
    assert.equal(ensureMediaToolsOnPath(), null, "second call should report nothing added");
    assert.equal(process.env.PATH, afterFirst, "second call should not touch PATH");
  } finally {
    process.env.PATH = before;
  }
});
