/**
 * gpt55-client.ts — Minimal OpenAI API client for GPT-5.5 transcript analysis.
 *
 * Uses fetch (no extra dependencies) with retry logic.
 * Requires OPENAI_API_KEY env var.
 */

const API_BASE = "https://api.openai.com/v1";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  timeoutMs?: number;
}

export interface ChatCompletionResult {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Check if API key is configured. */
export function isGpt55Available(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/** Call GPT-5.5 with retry logic. */
export async function chatCompletion(
  opts: ChatCompletionOptions,
  maxRetries = 3,
): Promise<ChatCompletionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const model = opts.model ?? "gpt-5.5";
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const body = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 16_384,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delayMs = Math.min(30000, 2000 * Math.pow(2, attempt));
        await sleep(delayMs);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API ${response.status}: ${errText.slice(0, 200)}`);
      }

      const json = await response.json();
      const content = json.choices?.[0]?.message?.content ?? "";
      const usage = json.usage;

      return { content, usage };
    } catch (e) {
      lastError = e as Error;
      const msg = lastError.message;
      if (msg.includes("429") || msg.includes("rate limit") || msg.includes("overloaded")) {
        continue; // retryable
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
