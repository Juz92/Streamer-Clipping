import { createHash } from "crypto";

export function hashUrl(url: string): string {
  const normalized = url.trim().toLowerCase().replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex");
}
