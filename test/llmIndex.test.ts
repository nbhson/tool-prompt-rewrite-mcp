/**
 * Unit tests for the LLM provider factory (`createProvider`).
 */

import { describe, it, expect } from 'vitest';
import { createProvider } from '../src/llm/index.js';
import { OpenAICompatibleProvider } from '../src/llm/provider.js';
import type { LLMConfig } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const fixtureDir = fileURLToPath(new URL('./fixtures', import.meta.url));

function cfg(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'test',
    apiKey: 'k',
    timeoutMs: 1000,
    retryMax: 0,
    maxTokens: 100,
    temperature: 0.2,
    ...overrides,
  };
}

describe('createProvider', () => {
  it("provider 'openai-compatible' → OpenAICompatibleProvider", async () => {
    const p = await createProvider(cfg());
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.isConfigured()).toBe(true);
  });

  it("provider 'openai' requires a baseUrl", async () => {
    await expect(createProvider(cfg({ provider: 'openai', baseUrl: '  ' }))).rejects.toThrow(
      /requires a baseUrl/
    );
  });

  it("provider 'openai' with a baseUrl works like the compatible provider", async () => {
    const p = await createProvider(cfg({ provider: 'openai' }));
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("provider 'custom' requires PROMPT_GATE_CUSTOM_PROVIDER_MODULE", async () => {
    await expect(createProvider(cfg({ provider: 'custom' }))).rejects.toThrow(
      /requires PROMPT_GATE_CUSTOM_PROVIDER_MODULE/
    );
  });

  it("provider 'custom' rejects a module without createCustomLLMProvider", async () => {
    const badModule = join(fixtureDir, 'custom-provider-bad.mjs');
    await expect(createProvider(cfg({ provider: 'custom', customProviderModule: badModule }))).rejects.toThrow(
      /does not export/
    );
  });

  it("provider 'custom' loads a fixture module exporting createCustomLLMProvider", async () => {
    const goodModule = join(fixtureDir, 'custom-provider.mjs');
    const p = await createProvider(cfg({ provider: 'custom', customProviderModule: goodModule }));
    expect(p.isConfigured()).toBe(true);
    await expect(p.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('custom-fixture-reply');
  });
});
