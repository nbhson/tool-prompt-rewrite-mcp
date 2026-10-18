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
export class OpenAICompatibleProvider {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    isConfigured() {
        return this.cfg.baseUrl.length > 0;
    }
    async chat(messages, options) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
        try {
            const body = {
                model: this.cfg.model,
                messages,
                temperature: options?.temperature ?? this.cfg.temperature,
                max_tokens: options?.maxTokens ?? this.cfg.maxTokens,
                stream: false,
            };
            // Thinking models spend the token budget on reasoning_content and
            // leave message.content empty — even when the provider claims
            // thinking is off. Treat reasoning_content as a fallback so the
            // pipeline still has text to work with.
            if (this.cfg.extraBody?.thinking === false) {
                body.thinking_budget = 0;
            }
            // Merge passthrough fields (e.g. enable_thinking for qwen3/llama.cpp).
            if (this.cfg.extraBody)
                Object.assign(body, this.cfg.extraBody);
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
                throw new Error(`LLM HTTP ${res.status}: ${truncate(text, 200)}`);
            }
            const json = (await res.json());
            const out = extractCompletionText(json);
            const trimmed = out?.trim() ?? '';
            // Thinking models via llama.cpp may return empty `content` while
            // putting the answer in `reasoning_content`. Surface a diagnosable
            // error so the user knows to either:
            //   1. run a non-thinking model (e.g. qwen2.5-7b), or
            //   2. confirm their llama.cpp build actually honors thinking:false.
            if (trimmed.length === 0) {
                const reasoning = extractReasoningContent(json);
                if (out === null) {
                    throw new Error('LLM returned malformed completion (no content[0].text).');
                }
                if (reasoning !== null && reasoning.trim().length > 0) {
                    throw new Error('LLM returned empty content but produced reasoning_content; ' +
                        'your model is a thinking variant that is not respecting ' +
                        'thinking:false. Use a non-thinking model (e.g. qwen2.5-7b) ' +
                        'or a llama.cpp build that supports thinking:false.');
                }
                throw new Error('LLM returned an empty completion.');
            }
            return trimmed;
        }
        catch (err) {
            // Propagate AbortError distinctly so callers can retry only on timeout.
            if (err instanceof Error && err.name === 'AbortError') {
                throw new Error('LLM request timed out');
            }
            throw err;
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
}
function extractCompletionText(json) {
    if (typeof json !== 'object' || json === null)
        return null;
    const obj = json;
    const choices = obj.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return null;
    const first = choices[0];
    if (typeof first !== 'object' || first === null)
        return null;
    const message = first.message;
    if (typeof message !== 'object' || message === null)
        return null;
    const content = message.content;
    if (typeof content === 'string')
        return content;
    // content may also arrive as a parts array in multimodal responses
    if (Array.isArray(content)) {
        const text = content
            .filter((p) => typeof p === 'object' && p !== null && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
        if (text.length > 0)
            return text;
    }
    return null;
}
/**
 * Read `choices[0].message.reasoning_content` (Qwen thinking models via
 * llama.cpp). Returns null when absent or not a string.
 */
function extractReasoningContent(json) {
    if (typeof json !== 'object' || json === null)
        return null;
    const obj = json;
    const choices = obj.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return null;
    const first = choices[0];
    if (typeof first !== 'object' || first === null)
        return null;
    const message = first.message;
    if (typeof message !== 'object' || message === null)
        return null;
    const rc = message.reasoning_content;
    return typeof rc === 'string' ? rc : null;
}
/**
 * Retry an idempotent LLM call with exponential backoff.
 * ONLY for network-level failures. Never used for user-interaction flows.
 */
export async function withRetry(fn, maxRetries) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            // Only retry on transient network-ish errors; give up on the rest.
            const msg = err instanceof Error ? err.message : String(err);
            const isTransient = /timed out|network|fetch failed|ECONNRESET|ECONNREFUSED|socket|HTTP 5\d\d|HTTP 429/i.test(msg);
            if (!isTransient || attempt === maxRetries)
                break;
            const backoff = Math.min(8000, 500 * 2 ** attempt);
            await sleep(backoff);
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
