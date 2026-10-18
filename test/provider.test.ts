import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from '../src/llm/provider.js';
import type { LLMConfig } from '../src/config.js';

function baseCfg(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://fake/v1',
    model: 'test',
    apiKey: 'k',
    timeoutMs: 1000,
    retryMax: 0,
    maxTokens: 100,
    temperature: 0.2,
    ...overrides,
  };
}

describe('OpenAICompatibleProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses config-driven maxTokens & temperature in the request body', async () => {
    const captured: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
      if (init) captured.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch);

    const p = new OpenAICompatibleProvider(
      baseCfg({ maxTokens: 4096, temperature: 0.1, extraBody: { thinking: false, enable_thinking: false } })
    );
    await p.chat([{ role: 'user', content: 'hi' }]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.max_tokens).toBe(4096);
    expect(captured[0]?.temperature).toBe(0.1);
    expect(captured[0]?.thinking).toBe(false);
    expect(captured[0]?.enable_thinking).toBe(false);
  });

  it('sets thinking_budget=0 when extraBody.thinking is false', async () => {
    const captured: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
      if (init) captured.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch);

    const p = new OpenAICompatibleProvider(baseCfg({ extraBody: { thinking: false } }));
    await p.chat([{ role: 'user', content: 'hi' }]);
    expect(captured[0]?.thinking_budget).toBe(0);
  });

  it('surfaces a diagnosable error when content is empty but reasoning_content is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '', reasoning_content: 'thinking…' },
              finish_reason: 'length',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as typeof fetch);

    const p = new OpenAICompatibleProvider(baseCfg());
    await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /thinking variant/i
    );
  });

  it('handles multimodal content array (string parts joined)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: 'hello ' },
                  { type: 'text', text: 'world' },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as typeof fetch);

    const p = new OpenAICompatibleProvider(baseCfg());
    const out = await p.chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('hello world');
  });
});
