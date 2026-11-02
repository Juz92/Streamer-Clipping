import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Find the cookies file by searching upward, not by assembling a path.
 *
 * `cookies.txt` is gitignored, so it exists only in the main checkout. A path
 * built relative to this module resolves to the *worktree* root when the
 * pipeline runs from `.claude/worktrees/...`, finds nothing, and silently drops
 * the --cookies flag -- at which point the stale user config takes over and
 * every download dies. Climbing finds the real file from either layout, the way
 * node's own module resolution does.
 */
export function findCookiesFile(startDir: string = HERE): string | null {
  const explicit = process.env.YT_DLP_COOKIES?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  let dir = resolve(startDir);
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, "cookies.txt");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The yt-dlp invocation to shell out with, including a cookies override.
 *
 * yt-dlp reads a user-level config that may point --cookies at a path that no
 * longer exists. A missing cookies file aborts the run outright, and a cookies
 * path that cannot be written aborts it *after* every record has been emitted,
 * which makes the exit code useless as a signal about the data. An explicit
 * flag on the command line beats the config, so pass ours whenever we have one.
 *
 * Override the binary with YT_DLP_CMD and the cookies file with YT_DLP_COOKIES.
 */
export function ytDlpCommand(): string {
  const bin = process.env.YT_DLP_CMD?.trim() || "python -m yt_dlp";
  const cookies = findCookiesFile();
  return cookies ? `${bin} --cookies "${cookies}"` : bin;
}
