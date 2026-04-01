import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, ensureDir } from "@ltx/shared";

export interface StreamManifest {
  streamId: string;
  channelHandle: string;
  title: string;
  uploadDate: string;
  durationSec: number;
  videoPath: string;
  subtitlePath: string | null;
  chatPath: string | null;
  audioLevelsPath: string | null;
  momentsPath: string | null;
  phase: "downloaded" | "analyzed" | "clipped";
  createdAt: string;
  updatedAt: string;
}

export function getStreamDir(streamId: string): string {
  return join(DATA_DIR, "clips", streamId);
}

export function loadManifest(streamId: string): StreamManifest {
  const manifestPath = join(getStreamDir(streamId), "manifest.json");
  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as StreamManifest;
}

export function saveManifest(manifest: StreamManifest): void {
  const dir = getStreamDir(manifest.streamId);
  ensureDir(dir);
  manifest.updatedAt = new Date().toISOString();
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}
