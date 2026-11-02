import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

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
  const cookies = process.env.YT_DLP_COOKIES?.trim() || join(PROJECT_ROOT, "cookies.txt");
  return existsSync(cookies) ? `${bin} --cookies "${cookies}"` : bin;
}
