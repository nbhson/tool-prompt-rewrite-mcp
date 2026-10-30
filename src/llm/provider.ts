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

/** Machine-readable classification of LLM failures (used for retry + error mapping). */
export type LLMErrorCode = 'timeout' | 'transient' | 'malformed' | 'fatal';

export class LLMError extends Error {
  /** Machine-readable classification. Always set by this provider. */
  readonly code: LLMErrorCode;
  readonly elapsedMs: number;
  constructor(message: string, cause: unknown, elapsedMs: number, code: LLMErrorCode) {
    super(message);
    this.elapsedMs = elapsedMs;
    this.name = 'LLMError';
    this.cause = cause;
    this.code = code;
  }
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
    const start = Date.now();

    try {
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages,
        temperature: options?.temperature ?? this.cfg.temperature,
        max_tokens: options?.maxTokens ?? this.cfg.maxTokens,
        stream: false,
      };
      // Thinking models spend the token budget on reasoning_content and
      // leave message.content empty — even when the provider claims
      // thinking is off. We do NOT use reasoning_content as the answer:
      // an empty content with a reasoning payload is surfaced as a typed
      // 'malformed' error (see below) so the misconfiguration is visible.
      if (this.cfg.extraBody?.thinking === false) {
        body.thinking_budget = 0;
      }
      // Merge passthrough fields (e.g. enable_thinking for qwen3/llama.cpp).
      if (this.cfg.extraBody) Object.assign(body, this.cfg.extraBody);

      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Server-side rate limits and outage codes are retry-worthy.
        const code: LLMErrorCode = res.status >= 500 || res.status === 429 ? 'transient' : 'fatal';
        throw new LLMError(`LLM HTTP ${res.status}: ${truncate(text, 200)}`, null, Date.now() - start, code);
      }

      const json = (await res.json()) as unknown;
      const out = extractCompletionText(json);
      const trimmed = out?.trim() ?? '';
      // Thinking models via llama.cpp may return empty `content` while
      // putting the answer in `reasoning_content`. Surface a diagnosable
      // typed error so the user knows to either:
      //   1. run a non-thinking model (e.g. qwen2.5-7b), or
      //   2. confirm their llama.cpp build actually honors thinking:false.
      if (trimmed.length === 0) {
        const reasoning = extractReasoningContent(json);
        if (out === null) {
          throw new LLMError('LLM returned malformed completion (no content[0].text).', null, Date.now() - start, 'malformed');
        }
        if (reasoning !== null && reasoning.trim().length > 0) {
          throw new LLMError(
            'LLM returned empty content but produced reasoning_content; ' +
            'your model is a thinking variant that is not respecting ' +
            'thinking:false. Use a non-thinking model (e.g. qwen2.5-7b) ' +
            'or a llama.cpp build that supports thinking:false.',
            null,
            Date.now() - start,
            'malformed'
          );
        }
        throw new LLMError('LLM returned an empty completion.', null, Date.now() - start, 'malformed');
      }
      return trimmed;
    } catch (err) {
      if (err instanceof LLMError) throw err;
      // Propagate aborts as typed timeouts so callers can retry only on timeout.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError('LLM request timed out', err, Date.now() - start, 'timeout');
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
  if (typeof content === 'string') return content;
  // content may also arrive as a parts array in multimodal responses
  if (Array.isArray(content)) {
    const text = content
      .filter((p): p is { text: string } => typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string')
      .map((p) => p.text)
      .join('');
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * Read `choices[0].message.reasoning_content` (Qwen thinking models via
 * llama.cpp). Returns null when absent or not a string.
 */
function extractReasoningContent(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return null;
  const rc = (message as Record<string, unknown>).reasoning_content;
  return typeof rc === 'string' ? rc : null;
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
      // Only retry on transient errors; give up on the rest. Typed LLMError
      // codes are authoritative; the message regex only covers plain Errors
      // (e.g. raw fetch failures) thrown by non-typed code paths.
      const isTransient =
        err instanceof LLMError
          ? err.code === 'timeout' || err.code === 'transient'
          : /timed out|network|fetch failed|ECONNRESET|ECONNREFUSED|socket|HTTP 5\d\d|HTTP 429/i.test(
              err instanceof Error ? err.message : String(err)
            );
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
