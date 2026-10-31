/**
 * Unit tests for the two non-gate tool handlers:
 * - handleRewritePrompt (`rewrite_prompt`)
 * - handleGetClientCapabilities (`get_client_capabilities`)
 *
 * The gate tool (`review_and_select_prompt`) has its own suite in
 * review.test.ts / cancellation.test.ts / concurrent.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleRewritePrompt } from '../src/tools/rewritePrompt.js';
import { handleGetClientCapabilities } from '../src/tools/getClientCapabilities.js';
import { RewriteService } from '../src/rewrite/rewrite.js';
import { LLMError } from '../src/llm/provider.js';
import { MockProvider, type MockBehavior } from './fixtures/llm-mocks.js';
import { createLogger } from '../src/logger.js';
import { detectCapabilities } from '../src/capability/capability.js';

const quiet = createLogger('error');

type ToolResponse = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
const textOf = (res: ToolResponse): string => res.content[0]?.text ?? '';

const validInput = { prompt: 'Fix the login bug', context: 'Session about auth.' };

function makeRewrite(behavior: MockBehavior): RewriteService {
  return new RewriteService(new MockProvider(behavior));
}

describe('handleRewritePrompt', () => {
  it('returns original + rewritten + changes summary on success', async () => {
    const res = await handleRewritePrompt(
      makeRewrite({ kind: 'ok', reply: 'Fix the login bug in module X.' }),
      quiet,
      { ...validInput, rewrite_level: 'light' }
    );
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.original_prompt).toBe('Fix the login bug');
    expect(res.structuredContent?.rewritten_prompt).toBe('Fix the login bug in module X.');
    expect(textOf(res)).toContain('Original:');
    expect(textOf(res)).toContain('Rewritten:');
  });

  it('defaults to the "balanced" level when rewrite_level is omitted', async () => {
    const res = await handleRewritePrompt(
      makeRewrite({ kind: 'ok', reply: 'ok' }),
      quiet,
      validInput
    );
    expect(res.structuredContent?.changes_summary).toContain('"balanced"');
  });

  it('LLM failure → isError outcome with a typed error kind (no silent fallback)', async () => {
    const res = await handleRewritePrompt(
      makeRewrite({ kind: 'throw', error: 'LLM HTTP 500: oops' }),
      quiet,
      validInput
    );
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toBe('llm_unavailable');
  });

  it('LLM timeout maps to llm_timeout', async () => {
    const res = await handleRewritePrompt(makeRewrite({ kind: 'timeout' }), quiet, validInput);
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toBe('llm_timeout');
  });

  it('plain LLM failure (wrapped as fatal code) maps to llm_unavailable', async () => {
    const res = await handleRewritePrompt(
      makeRewrite({ kind: 'throw', error: 'LLM returned an empty completion.' }),
      quiet,
      validInput
    );
    // A plain Error thrown by the provider is wrapped by RewriteService as a
    // 'fatal' LLMError → llm_unavailable. True malformed detection requires a
    // typed LLMError (code: 'malformed') — covered by the next test.
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toBe('llm_unavailable');
  });

  it('LLMError with code malformed maps to llm_malformed_output', async () => {
    const bad = new RewriteService({
      isConfigured: () => true,
      chat: async () => {
        throw new LLMError('LLM returned an empty completion.', new Error('empty'), 1, 'malformed');
      },
    });
    const res = await handleRewritePrompt(bad, quiet, validInput);
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toBe('llm_malformed_output');
  });

  it('invalid input (empty prompt) is rejected by Zod validation', async () => {
    await expect(handleRewritePrompt(makeRewrite({ kind: 'ok', reply: 'x' }), quiet, { prompt: '' })).rejects.toThrow();
    await expect(
      handleRewritePrompt(makeRewrite({ kind: 'ok', reply: 'x' }), quiet, {})
    ).rejects.toThrow();
  });

  it('renders warnings as a list when the rewrite is much shorter than the original', async () => {
    const long = 'This is a long prompt. '.repeat(20);
    const res = await handleRewritePrompt(
      makeRewrite({ kind: 'ok', reply: 'short' }),
      quiet,
      { prompt: long, context: 'c' }
    );
    expect(textOf(res)).toContain('Warnings:');
    expect((res.structuredContent?.warnings as string[]).length).toBeGreaterThan(0);
  });
});

describe('handleGetClientCapabilities', () => {
  it('reports the detected capabilities in text and structured form', () => {
    const detect = vi.fn(() =>
      detectCapabilities({ elicitation: { form: {} } })
    );
    const res = handleGetClientCapabilities(detect, quiet);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(res.structuredContent).toEqual({
      elicitation_supported: true,
      structured_elicitation_supported: true,
      transport: 'stdio',
      integration_mode: 'standard',
      mandatory_gating_enforceable: false,
    });
    expect(textOf(res)).toContain('elicitationSupported');
  });

  it('conservative defaults when the client declared nothing', () => {
    const res = handleGetClientCapabilities(() => detectCapabilities({}), quiet);
    expect(res.structuredContent?.elicitation_supported).toBe(false);
    expect(res.structuredContent?.mandatory_gating_enforceable).toBe(false);
  });
});
