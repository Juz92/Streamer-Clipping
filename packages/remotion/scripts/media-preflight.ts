import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { extname, join, relative } from "path";
import { fileURLToPath } from "url";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUT_DIR = join(ROOT, "packages", "remotion", ".tmp", "qa");
const REPORT_PATH = join(OUT_DIR, "media-preflight.json");
const PUBLIC_DIRS = [join(ROOT, "packages", "remotion", "public"), join(ROOT, "public"), join(ROOT, "data")];
const mediaExt = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".mp3", ".m4a", ".wav", ".aac"]);
function walk(dir: string, out: string[] = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else if (mediaExt.has(extname(p).toLowerCase())) out.push(p);
  }
  return out;
}
function probe(path: string) {
  try {
    const json = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,width,height,sample_rate,duration:format=duration,size", "-of", "json", path], { encoding: "utf-8" });
    return JSON.parse(json);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
mkdirSync(OUT_DIR, { recursive: true });
const files = PUBLIC_DIRS.flatMap((d) => walk(d));
const media = files.map((path) => {
  const p = probe(path);
  const video = p.streams?.find((s: any) => s.codec_type === "video");
  const audio = p.streams?.find((s: any) => s.codec_type === "audio");
  const warnings: string[] = [];
  if (p.error) warnings.push("ffprobe failed");
  if (!video && !audio) warnings.push("no video/audio stream detected");
  if (video && (!video.width || !video.height)) warnings.push("video dimensions missing");
  return { path, relativePath: relative(ROOT, path), duration: Number(p.format?.duration ?? video?.duration ?? audio?.duration ?? 0), size: Number(p.format?.size ?? 0), width: video?.width, height: video?.height, hasVideo: Boolean(video), hasAudio: Boolean(audio), warnings };
});
const warnings = media.flatMap((m) => m.warnings.map((w) => `${m.relativePath}: ${w}`));
const report = { ok: warnings.length === 0, root: ROOT, checkedAt: new Date().toISOString(), scannedDirs: PUBLIC_DIRS, count: media.length, media, warnings };
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`Media preflight wrote ${REPORT_PATH} (${media.length} file(s), ${warnings.length} warning(s))`);
if (warnings.length) process.exitCode = 1;
