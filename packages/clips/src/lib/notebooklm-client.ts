import { spawnSync } from "child_process";
import { createLogger } from "@ltx/shared";

const log = createLogger("notebooklm-client");

export interface NotebookLMEnv {
  readonly env: Record<string, string>;
}

/** Always set these env vars for every nlm invocation (Windows cp1252 fix). */
const NLM_ENV: NotebookLMEnv = {
  env: {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  } as Record<string, string>,
};

function run(
  args: string[],
  opts: { timeoutMs?: number; maxBufferMb?: number } = {},
): string {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBuffer = (opts.maxBufferMb ?? 32) * 1024 * 1024;

  const result = spawnSync("nlm", args, {
    env: NLM_ENV.env,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer,
    shell: true, // needed on Windows to find .cmd wrappers
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "nlm CLI not found on PATH. Install with: uv tool install notebooklm-mcp-cli",
      );
    }
    throw result.error;
  }

  if (result.status !== 0) {
    // nlm has known cp1252 crashes on Windows AFTER the operation succeeds.
    // If stderr contains the traceback but stdout has our expected content,
    // callers should still use stdout. We log and return stdout; callers
    // validate the JSON themselves.
    log.warn(
      `nlm exited with status ${result.status}. stderr: ${(result.stderr ?? "").slice(0, 300)}`,
    );
  }

  return result.stdout ?? "";
}

function runJson<T = unknown>(
  args: string[],
  opts: { timeoutMs?: number } = {},
): T {
  const stdout = run(args, opts);
  // Find the first JSON structural char ({ for object or [ for array) —
  // nlm sometimes prints progress lines before JSON, and `notebook list`
  // returns an array while `notebook query --json` returns an object.
  const braceIdx = stdout.indexOf("{");
  const bracketIdx = stdout.indexOf("[");
  const candidates = [braceIdx, bracketIdx].filter((i) => i >= 0);
  if (candidates.length === 0) {
    throw new Error(
      `No JSON found in nlm output. First 200 chars: ${stdout.slice(0, 200)}`,
    );
  }
  const jsonStart = Math.min(...candidates);
  const jsonStr = stdout.slice(jsonStart);
  try {
    return JSON.parse(jsonStr) as T;
  } catch (e) {
    throw new Error(
      `Failed to parse nlm JSON output: ${(e as Error).message}. First 200 chars: ${jsonStr.slice(0, 200)}`,
    );
  }
}

export interface CreateNotebookResult {
  notebookId: string;
  title: string;
}

export function createNotebook(title: string): CreateNotebookResult {
  // Strip non-ASCII to avoid cp1252 mojibake in titles
  const asciiTitle = title.replace(/[^\x20-\x7E]/g, "-");

  // `nlm notebook create` crashes on Windows console print but the notebook
  // IS created. We call list afterward and find the most recent one with
  // the matching title.
  try {
    run(["notebook", "create", `"${asciiTitle}"`], { timeoutMs: 60_000 });
  } catch (e) {
    log.warn(`notebook create may have crashed on success print: ${(e as Error).message}`);
  }

  // Look it up via list (which returns JSON natively without the crash)
  const list = runJson<
    Array<{ id: string; title: string; updated_at: string }>
  >(["notebook", "list"], { timeoutMs: 30_000 });

  // Match most recent notebook whose title contains our ASCII title
  const matches = list
    .filter(
      (n) =>
        n.title.trim() === asciiTitle.trim() ||
        n.title.includes(asciiTitle.slice(0, 20)),
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  if (matches.length === 0) {
    throw new Error(
      `Could not find notebook after creation. Title was: ${asciiTitle}`,
    );
  }

  return { notebookId: matches[0].id, title: matches[0].title };
}

export interface AddSourceResult {
  sourceId: string;
  ready: boolean;
}

export function addSource(
  notebookId: string,
  filePath: string,
  sourceTitle: string,
  waitTimeoutSec: number = 900,
): AddSourceResult {
  const asciiSourceTitle = sourceTitle.replace(/[^\x20-\x7E]/g, "-");
  const stdout = run(
    [
      "source",
      "add",
      notebookId,
      "--file",
      `"${filePath}"`,
      "--title",
      `"${asciiSourceTitle}"`,
      "--wait",
      "--wait-timeout",
      String(waitTimeoutSec),
    ],
    { timeoutMs: (waitTimeoutSec + 60) * 1000 },
  );

  // nlm source add --wait prints "Source ID: <uuid>" on success
  const idMatch = stdout.match(/Source ID:\s+([a-f0-9-]{36})/);
  if (!idMatch) {
    throw new Error(
      `Could not extract source ID from nlm output. Output: ${stdout.slice(0, 400)}`,
    );
  }
  const ready = /ready/i.test(stdout);
  return { sourceId: idMatch[1], ready };
}

export interface QueryResult<T = unknown> {
  value: {
    answer: string;
    conversation_id: string;
    sources_used?: string[];
    citations?: Record<string, string>;
    references?: Array<{ cited_text: string }>;
  };
}

export function query(
  notebookId: string,
  prompt: string,
  opts: { conversationId?: string; timeoutSec?: number } = {},
): QueryResult {
  const timeoutSec = opts.timeoutSec ?? 300;
  const args = ["notebook", "query", notebookId, `"${prompt.replace(/"/g, '\\"')}"`, "--json", "--timeout", String(timeoutSec)];
  if (opts.conversationId) {
    args.push("--conversation-id", opts.conversationId);
  }

  return runJson<QueryResult>(args, { timeoutMs: (timeoutSec + 60) * 1000 });
}

export function deleteNotebook(notebookId: string): void {
  try {
    run(["notebook", "delete", notebookId, "-y"], { timeoutMs: 30_000 });
  } catch (e) {
    log.warn(`Failed to delete notebook ${notebookId}: ${(e as Error).message}`);
  }
}

/** Check whether the nlm CLI is available on PATH. */
export function isNlmAvailable(): boolean {
  try {
    const result = spawnSync("nlm", ["--version"], {
      env: NLM_ENV.env,
      encoding: "utf-8",
      timeout: 10_000,
      shell: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
