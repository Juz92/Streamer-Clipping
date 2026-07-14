import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const QA_DIR = join(ROOT, "packages", "remotion", ".tmp", "qa");
const manifestPath = join(QA_DIR, "render-manifest.json");
function read(path: string) { try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; } }
mkdirSync(QA_DIR, { recursive: true });
const preflight = read(join(QA_DIR, "media-preflight.json"));
const contact = read(join(QA_DIR, "contact-sheet-report.json"));
const warnings = [...(preflight?.warnings ?? []).map((w: string)=>`preflight: ${w}`), ...(contact?.warnings ?? []).map((w: string)=>`contact: ${w}`)];
const manifest = { ok: warnings.length === 0 && (preflight?.ok ?? true) && (contact?.ok ?? true), createdAt: new Date().toISOString(), pipeline: ROOT.split(/[\/]/).pop(), compositionId: contact?.templateSignals?.compositionId ?? null, templateVariant: contact?.templateSignals?.templateVariant ?? null, captionStyle: contact?.templateSignals?.captionStyle ?? null, durationBucket: contact?.templateSignals?.durationBucket ?? null, outputPath: contact?.input ?? null, contactSheetPath: contact?.contactSheet ?? null, mediaChecked: preflight?.count ?? 0, warnings };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Render QA manifest wrote ${manifestPath}`);
if (!manifest.ok) process.exitCode = 1;
