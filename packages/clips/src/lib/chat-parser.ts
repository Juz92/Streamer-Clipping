import { readFileSync } from "fs";

export interface ChatMessage {
  text: string;
  timestampSec: number;
  authorName: string;
}

interface ChatRenderer {
  message?: { runs?: { text?: string }[] };
  timestampUsec?: string;
  authorName?: { simpleText?: string };
}

function extractRenderer(line: unknown): ChatRenderer | null {
  const obj = line as Record<string, unknown>;
  const actions = (
    obj?.replayChatItemAction as Record<string, unknown> | undefined
  )?.actions as Array<Record<string, unknown>> | undefined;

  if (!actions?.length) return null;

  const addAction = actions[0]?.addChatItemAction as
    | Record<string, unknown>
    | undefined;
  const item = addAction?.item as Record<string, unknown> | undefined;
  if (!item) return null;

  return (
    (item.liveChatTextMessageRenderer as ChatRenderer | undefined) ??
    (item.liveChatPaidMessageRenderer as ChatRenderer | undefined) ??
    null
  );
}

export function parseChatReplay(filePath: string): ChatMessage[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  const messages: { text: string; authorName: string; usec: bigint }[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const renderer = extractRenderer(parsed);
    if (!renderer) continue;

    const runs = renderer.message?.runs;
    if (!runs?.length) continue;

    const text = runs.map((r) => r.text ?? "").join("");
    if (!text) continue;

    const usecStr = renderer.timestampUsec;
    if (!usecStr) continue;

    let usec: bigint;
    try {
      usec = BigInt(usecStr);
    } catch {
      continue;
    }

    const authorName = renderer.authorName?.simpleText ?? "Unknown";

    messages.push({ text, authorName, usec });
  }

  if (messages.length === 0) return [];

  // Sort by timestamp
  messages.sort((a, b) => (a.usec < b.usec ? -1 : a.usec > b.usec ? 1 : 0));

  const baseUsec = messages[0].usec;

  return messages.map((m) => ({
    text: m.text,
    timestampSec: Number(m.usec - baseUsec) / 1_000_000,
    authorName: m.authorName,
  }));
}
