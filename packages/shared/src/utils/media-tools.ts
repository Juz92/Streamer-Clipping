import { existsSync } from "fs";
import { delimiter, join } from "path";

const WIN = process.platform === "win32";
const FFMPEG = WIN ? "ffmpeg.exe" : "ffmpeg";
const FFPROBE = WIN ? "ffprobe.exe" : "ffprobe";

/**
 * Directories that commonly hold ffmpeg, in priority order.
 *
 * FFMPEG_DIR is first so a machine with an unusual install can say so without
 * a code change. The rest are the default locations for the usual installers.
 */
function candidateDirs(): string[] {
  const dirs: string[] = [];
  const explicit = process.env.FFMPEG_DIR?.trim();
  if (explicit) dirs.push(explicit);

  if (WIN) {
    const localAppData = process.env.LOCALAPPDATA;
    // winget shims live here, and this is where this project's copy is.
    if (localAppData) dirs.push(join(localAppData, "Microsoft", "WinGet", "Links"));
    dirs.push("C:\\ffmpeg\\bin");
    for (const programFiles of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (programFiles) dirs.push(join(programFiles, "ffmpeg", "bin"));
    }
  } else {
    dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
  }
  return dirs;
}

/**
 * Add a fallback ffmpeg directory to PATH for this process and its children.
 *
 * Both binaries can be installed and still be uncallable: a PATH long enough to
 * hit Windows' limit silently drops entries, and the shells on this project's
 * machine resolve neither ffmpeg nor ffprobe even though winget installed both.
 * Everything here shells out by bare program name -- `execFileSync("ffprobe",
 * ...)` and friends, 93 call sites across 21 files -- so repairing PATH once
 * fixes all of them without touching any.
 *
 * The directory is **appended**, never prepended: if ffmpeg already resolves,
 * that copy keeps winning and this is a no-op. We only supply a last resort.
 *
 * Idempotent, and silent when nothing is found -- the caller's own ffmpeg error
 * is a better diagnostic than anything this could invent.
 *
 * @returns the directory added, or null if nothing was added.
 */
export function ensureMediaToolsOnPath(): string | null {
  const path = process.env.PATH ?? "";
  const entries = path.split(delimiter);

  for (const dir of candidateDirs()) {
    if (!existsSync(join(dir, FFMPEG)) || !existsSync(join(dir, FFPROBE))) continue;
    if (entries.includes(dir)) return null; // already reachable; nothing to do
    process.env.PATH = path ? `${path}${delimiter}${dir}` : dir;
    return dir;
  }
  return null;
}
