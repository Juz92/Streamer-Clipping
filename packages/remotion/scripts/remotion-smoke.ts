import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { ensureMediaToolsOnPath } from "@ltx/shared";

// ffmpeg may be installed but unreachable on PATH; add a fallback before probing.
ensureMediaToolsOnPath();

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REMOTION_ENTRY = join(ROOT, "packages", "remotion", "src", "index.ts");
const OUT_DIR = join(ROOT, "packages", "remotion", ".tmp", "workflow-smoke");
const PUBLIC_DIR = join(OUT_DIR, "public");
const REPORT_PATH = join(OUT_DIR, "smoke-report.json");
const PROPS_PATH = join(OUT_DIR, "props.json");
const STILL_PATH = join(OUT_DIR, "frame0.png");
const VIDEO_PATH = join(OUT_DIR, "workflow-smoke.mp4");
const SMOKE_VIDEO = join(PUBLIC_DIR, "smoke-video.mp4");
const SMOKE_AUDIO = join(PUBLIC_DIR, "smoke-audio.m4a");
const REMOTION_CLI = join(ROOT, "node_modules", "@remotion", "cli", "remotion-cli.js");
function run(command: string, args: string[]) { execFileSync(command, args, { cwd: ROOT, stdio: "inherit" }); }
function capture(command: string, args: string[]) { return execFileSync(command, args, { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
function ensureSmokeAssets() {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=1", "-f", "lavfi", "-i", "sine=frequency=660:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", SMOKE_VIDEO]);
  run("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", SMOKE_AUDIO]);
}
function probeRenderedVideo() { return JSON.parse(capture("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,width,height,sample_rate:format=duration,size", "-of", "json", VIDEO_PATH])); }
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
ensureSmokeAssets();
writeFileSync(PROPS_PATH, JSON.stringify({ videoSrc: "smoke-video.mp4", audioSrc: "smoke-audio.m4a", label: "Remotion workflow smoke" }, null, 2));
run(process.execPath, [REMOTION_CLI, "still", REMOTION_ENTRY, "WorkflowSmoke", STILL_PATH, "--props", PROPS_PATH, "--frame", "0", "--public-dir", PUBLIC_DIR]);
run(process.execPath, [REMOTION_CLI, "render", REMOTION_ENTRY, "WorkflowSmoke", VIDEO_PATH, "--props", PROPS_PATH, "--public-dir", PUBLIC_DIR, "--codec", "h264", "--sample-rate", "48000", "--audio-bitrate", "128k"]);
const probe = probeRenderedVideo();
const videoStream = probe.streams?.find((s: any) => s.codec_type === "video");
const audioStream = probe.streams?.find((s: any) => s.codec_type === "audio");
const duration = Number(probe.format?.duration ?? 0);
const size = Number(probe.format?.size ?? 0);
const checks = { stillExists: existsSync(STILL_PATH), videoExists: existsSync(VIDEO_PATH), width: videoStream?.width, height: videoStream?.height, hasAudio: Boolean(audioStream), audioSampleRate: audioStream?.sample_rate, duration, size };
const issues: string[] = [];
if (!checks.stillExists) issues.push("frame0 still was not created");
if (!checks.videoExists) issues.push("smoke render was not created");
if (checks.width !== 360 || checks.height !== 640) issues.push(`unexpected dimensions ${checks.width}x${checks.height}`);
if (!checks.hasAudio) issues.push("rendered smoke video has no audio stream");
if (duration < 0.85 || duration > 1.2) issues.push(`unexpected duration ${duration}`);
if (size <= 0) issues.push("rendered smoke video is empty");
const report = { ok: issues.length === 0, remotionEntry: REMOTION_ENTRY, publicDir: PUBLIC_DIR, frame0: STILL_PATH, render: VIDEO_PATH, checks, issues };
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
if (issues.length) { console.error(`Remotion smoke failed. Report: ${REPORT_PATH}`); for (const issue of issues) console.error(`- ${issue}`); process.exit(1); }
console.log(`Remotion smoke passed. Report: ${REPORT_PATH}`);
