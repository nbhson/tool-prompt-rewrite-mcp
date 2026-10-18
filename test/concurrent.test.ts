import { describe, it, expect } from 'vitest';
import { MockProvider } from './fixtures/llm-mocks.js';
import { RewriteService } from '../src/rewrite/rewrite.js';
import { handleReviewAndSelect, type ReviewDeps } from '../src/tools/reviewAndSelect.js';
import { createLogger } from '../src/logger.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const quiet = createLogger('error');

describe('Concurrent independent sessions', () => {
  it('two parallel gate calls in the SAME session do not share approvals', async () => {
    // Each session gets its own provider + service instance here.
    const p1 = new MockProvider({ kind: 'ok', reply: 'A' });
    const p2 = new MockProvider({ kind: 'ok', reply: 'B' });
    const r1 = new RewriteService(p1);
    const r2 = new RewriteService(p2);

    const s1 = new McpServer({ name: 's1', version: '0.0.1' }, { capabilities: { tools: {} } });
    const s2 = new McpServer({ name: 's2', version: '0.0.1' }, { capabilities: { tools: {} } });

    const d1: ReviewDeps = {
      server: s1,
      rewrite: r1,
      log: quiet,
      elicit: async () => ({ action: 'accept', chosen: 'rewritten' }),
    };
    const d2: ReviewDeps = {
      server: s2,
      rewrite: r2,
      log: quiet,
      elicit: async () => ({ action: 'accept', chosen: 'original' }),
    };

    const [resA, resB] = await Promise.all([
      handleReviewAndSelect(d1, { prompt: 'x', context: 'test' }),
      handleReviewAndSelect(d2, { prompt: 'y', context: 'test' }),
    ]);

    expect(resA.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'rewritten',
      selected_prompt: 'A',
    });
    expect(resB.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'original',
      selected_prompt: 'y',
    });
    // They are independent.
    expect(resA.structuredContent?.selected_prompt).not.toBe(resB.structuredContent?.selected_prompt);
  });

  it('client disconnect (elicit rejects) → error, not crash', async () => {
    const server = new McpServer({ name: 'd', version: '0.0.1' }, { capabilities: { tools: {} } });
    const provider = new MockProvider({ kind: 'ok', reply: 'X' });
    const deps: ReviewDeps = { server, rewrite: new RewriteService(provider), log: quiet };
    const disconnecting = async () => {
      throw new Error('client disconnected');
    };
    const res = await handleReviewAndSelect({ ...deps, elicit: disconnecting }, { prompt: 'p', context: 'test' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.selected_prompt).toBeNull();
  });
});
