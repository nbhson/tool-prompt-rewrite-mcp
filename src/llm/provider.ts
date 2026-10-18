/**
 * LLM Provider abstraction.
 *
 * The server talks to one provider interface; the OpenAI-compatible
 * implementation works with local llama.cpp or any OpenAI-style endpoint.
 *
 * Design rules:
 * - Treat prompt as untrusted data (never execute anything from it).
 * - Validate and handle empty / malformed responses explicitly.
 * - Do NOT blindly retry non-idempotent user-interaction flows.
 *   Retries are only for network-level, idempotent LLM calls.
 */

import type { LLMConfig } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMProvider {
  /** One LLM completion. Throws on network/timeout/malformed — caller decides retry. */
  chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<string>;
  /** True when this provider is reachable/configured. */
  isConfigured(): boolean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly cfg: LLMConfig) {}

  isConfigured(): boolean {
    return this.cfg.baseUrl.length > 0;
  }

  async chat(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          temperature: options?.temperature ?? 0.2,
          max_tokens: options?.maxTokens ?? 1024,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${truncate(text, 200)}`);
      }

      const json = (await res.json()) as unknown;
      const out = extractCompletionText(json);
      if (out === null) {
        throw new Error('LLM returned malformed completion (no content[0].text).');
      }
      const trimmed = out.trim();
      if (trimmed.length === 0) {
        throw new Error('LLM returned an empty completion.');
      }
      return trimmed;
    } catch (err) {
      // Propagate AbortError distinctly so callers can retry only on timeout.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('LLM request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function extractCompletionText(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string') return null;
  return content;
}

/**
 * Retry an idempotent LLM call with exponential backoff.
 * ONLY for network-level failures. Never used for user-interaction flows.
 */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Only retry on transient network-ish errors; give up on the rest.
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        /timed out|network|fetch failed|ECONNRESET|ECONNREFUSED|socket|HTTP 5\d\d|HTTP 429/i.test(msg);
      if (!isTransient || attempt === maxRetries) break;
      const backoff = Math.min(8000, 500 * 2 ** attempt);
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
