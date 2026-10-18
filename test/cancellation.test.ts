import { describe, it, expect } from 'vitest';
import { handleReviewAndSelect, type ReviewDeps } from '../src/tools/reviewAndSelect.js';
import { RewriteService } from '../src/rewrite/rewrite.js';
import { MockProvider } from './fixtures/llm-mocks.js';
import { createLogger } from '../src/logger.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const quiet = createLogger('error');

function depsWithReply(reply: string, elicit?: ReviewDeps['elicit']): ReviewDeps {
  const server = new McpServer({ name: 't', version: '0.0.1' }, { capabilities: { tools: {} } });
  return { server, rewrite: new RewriteService(new MockProvider({ kind: 'ok', reply })), log: quiet, elicit };
}

describe('Cancellation & fallback guarantees', () => {
  it('cancellation NEVER exposes selected_prompt (distinct outcome)', async () => {
    const deps = depsWithReply('Enriched', async () => ({ action: 'cancel' }));
    const res = await handleReviewAndSelect(deps, { prompt: 'hello' });
    expect(res.structuredContent?.status).toBe('cancelled');
    expect(res.structuredContent?.selected_prompt).toBeNull();
    // The text also makes it explicit.
    expect(res.content[0].text).toMatch(/cancelled/i);
  });

  it('LLM error NEVER silently falls back to original', async () => {
    // Simulate LLM failure (network error).
    const failing = new MockProvider({ kind: 'throw', error: 'ECONNREFUSED' });
    const server = new McpServer({ name: 't', version: '0.0.1' }, { capabilities: { tools: {} } });
    const deps: ReviewDeps = { server, rewrite: new RewriteService(failing), log: quiet };
    const res = await handleReviewAndSelect(deps, { prompt: 'original-prompt' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('error');
    expect(res.structuredContent?.selected_prompt).toBeNull();
    // The text should not claim the original was approved.
    expect(res.content[0].text).not.toMatch(/approved/i);
  });

  it('no auto-select after timeout — timeout is a hard error, not a default choice', async () => {
    const deps = depsWithReply('ok', async () => {
      // Simulate timeout / abort before user chose.
      throw new Error('aborted');
    });
    const res = await handleReviewAndSelect(deps, { prompt: 'p' });
    // Any failure in elicitation is a distinct error — never a silent
    // default to "original".
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.selected_prompt).toBeNull();
  });

  it('invalid input (prompt > 32000 chars) is rejected without calling the LLM', async () => {
    let llmCalled = false;
    const provider = new MockProvider({
      kind: 'ok',
      reply: 'x',
    });
    const server = new McpServer({ name: 't', version: '0.0.1' }, { capabilities: { tools: {} } });
    const svc = new RewriteService(provider);
    // Wrap rewrite so we can detect whether the LLM was hit.
    const orig = svc.rewrite.bind(svc);
    svc.rewrite = async (...args) => {
      llmCalled = true;
      return orig(...args);
    };
    const deps: ReviewDeps = { server, rewrite: svc, log: quiet };
    const tooLong = 'a'.repeat(32_001);
    await expect(handleReviewAndSelect(deps, { prompt: tooLong })).rejects.toThrow();
    expect(llmCalled).toBe(false);
  });
});
