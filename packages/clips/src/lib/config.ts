import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, ensureDir } from "@ltx/shared";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChannelConfig {
  channel: string;
  avatarRegion: Region;
  gameplayRegion: Region;
}

export function getConfigPath(): string {
  return join(DATA_DIR, "clips", "channel-config.json");
}

export function loadChannelConfig(): ChannelConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as ChannelConfig;
}

export function saveChannelConfig(config: ChannelConfig): void {
  const configPath = getConfigPath();
  ensureDir(join(DATA_DIR, "clips"));
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
