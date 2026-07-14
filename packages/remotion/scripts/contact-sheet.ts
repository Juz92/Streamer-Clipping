import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { extname, join, relative } from "path";
import { fileURLToPath } from "url";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUT_DIR = join(ROOT, "packages", "remotion", ".tmp", "qa");
const FRAMES_DIR = join(OUT_DIR, "contact-frames");
const REPORT_PATH = join(OUT_DIR, "contact-sheet-report.json");
const SHEET_PATH = join(OUT_DIR, "contact-sheet.jpg");
const searchDirs = [join(ROOT, "outputs"), join(ROOT, "shorts"), join(ROOT, "data"), join(ROOT, "packages", "remotion", ".tmp")];
function walk(dir: string, out: string[] = []) { if (!existsSync(dir)) return out; for (const n of readdirSync(dir)) { const p=join(dir,n); const st=statSync(p); if (st.isDirectory()) walk(p,out); else if ([".mp4",".mov",".m4v",".webm"].includes(extname(p).toLowerCase())) out.push(p); } return out; }
function latestVideo() { const files=searchDirs.flatMap(d=>walk(d)).map(p=>({p,mtime:statSync(p).mtimeMs,size:statSync(p).size})).filter(x=>x.size>0).sort((a,b)=>b.mtime-a.mtime); return files[0]?.p; }
function duration(path: string) { try { return Number(execFileSync("ffprobe", ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",path], {encoding:"utf-8"}).trim()); } catch { return 0; } }
const input = process.argv[2] || latestVideo();
mkdirSync(FRAMES_DIR, { recursive: true });
const warnings: string[] = [];
if (!input || !existsSync(input)) { const report={ok:false,error:"No input video found. Pass a video path or render first.", searched:searchDirs}; writeFileSync(REPORT_PATH, JSON.stringify(report,null,2)); console.error(report.error); process.exit(1); }
const dur=duration(input);
const times = Array.from(new Set([0,0.5,1,3,Math.max(0,dur/2),Math.max(0,dur-1)].filter(t=>t<=Math.max(dur,0.1)).map(t=>Number(t.toFixed(2)))));
const frames: any[] = [];
for (let i=0;i<times.length;i++) { const out=join(FRAMES_DIR, `frame-${String(i).padStart(2,"0")}-${times[i]}s.jpg`); try { execFileSync("ffmpeg", ["-y","-ss",String(times[i]),"-i",input,"-frames:v","1","-q:v","2",out], {stdio:["ignore","ignore","ignore"]}); frames.push({time:times[i], path:out}); } catch { warnings.push(`failed extracting frame at ${times[i]}s`); } }
if (frames.length) { try { execFileSync("ffmpeg", ["-y", "-pattern_type", "glob", "-i", join(FRAMES_DIR, "*.jpg"), "-vf", "scale=360:-1,tile=3x2:padding=12:margin=12", SHEET_PATH], {stdio:["ignore","ignore","ignore"]}); } catch { warnings.push("failed creating tiled contact sheet"); } }
const report={ok:warnings.length===0,input,relativeInput:relative(ROOT,input),duration:dur,frames,contactSheet:SHEET_PATH,warnings,templateSignals:{compositionId:null,templateVariant:null,captionStyle:null,durationBucket: dur<45?"under_45s":dur<75?"45_75s":"over_75s"}};
writeFileSync(REPORT_PATH, JSON.stringify(report,null,2));
console.log(`Contact sheet report wrote ${REPORT_PATH}`);
if (warnings.length) process.exitCode=1;
