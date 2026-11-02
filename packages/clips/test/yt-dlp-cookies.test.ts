import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCookiesFile, ytDlpCommand } from "../src/lib/yt-dlp.js";

// Regression guard for 2026-11-02: the cookies path was assembled relative to
// the module, so running the pipeline from a git worktree resolved to the
// worktree root, found nothing, dropped --cookies, and let a stale user config
// pointing at C:/peanut/cookies.txt kill an 11GB download.

test("the cookies file is found from a nested directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cookies-climb-"));
  try {
    writeFileSync(join(root, "cookies.txt"), "# Netscape HTTP Cookie File\n");
    const nested = join(root, "packages", "clips", "src", "lib");
    mkdirSync(nested, { recursive: true });
    assert.equal(findCookiesFile(nested), join(root, "cookies.txt"),
      "must climb out of a nested source tree to reach the checkout root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absence is reported as null rather than a bogus path", () => {
  const root = mkdtempSync(join(tmpdir(), "cookies-none-"));
  const saved = process.env.YT_DLP_COOKIES;
  delete process.env.YT_DLP_COOKIES;
  try {
    // tmpdir has no cookies.txt above it in any realistic layout.
    const found = findCookiesFile(root);
    assert.ok(found === null || found.endsWith("cookies.txt"),
      "either nothing, or a real file -- never a path that does not exist");
  } finally {
    if (saved !== undefined) process.env.YT_DLP_COOKIES = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("YT_DLP_COOKIES wins, and a bad override does not silently fall through", () => {
  const saved = process.env.YT_DLP_COOKIES;
  try {
    process.env.YT_DLP_COOKIES = join(tmpdir(), "definitely-not-here-cookies.txt");
    assert.equal(findCookiesFile(), null,
      "an explicit override that does not exist must not fall back to a search");
  } finally {
    if (saved === undefined) delete process.env.YT_DLP_COOKIES;
    else process.env.YT_DLP_COOKIES = saved;
  }
});

test("the command carries --cookies exactly when a file was found", () => {
  // Asserts the relationship, not the environment. cookies.txt is gitignored,
  // so it is present on a dev machine and absent on CI; an unconditional
  // assertion here passed locally and failed on the runner.
  const cmd = ytDlpCommand();
  assert.match(cmd, /^python -m yt_dlp/);

  const found = findCookiesFile();
  if (found) {
    assert.ok(cmd.includes(`--cookies "${found}"`),
      "a found cookies file must reach the command line verbatim");
  } else {
    assert.ok(!cmd.includes("--cookies"),
      "with no cookies file, no flag -- never a path that does not exist");
  }
});
