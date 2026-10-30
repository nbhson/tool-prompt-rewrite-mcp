import { describe, it, expect } from 'vitest';
import { handleReviewAndSelect, type ReviewDeps } from '../src/tools/reviewAndSelect.js';
import { RewriteService } from '../src/rewrite/rewrite.js';
import { MockProvider } from './fixtures/llm-mocks.js';
import { createLogger } from '../src/logger.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const quiet = createLogger('error');

type GateResponse = Awaited<ReturnType<typeof handleReviewAndSelect>>;
/** First text block of a gate response (optional-safe for strict TS). */
const textOf = (res: GateResponse): string => res.content[0]?.text ?? '';

/** Step-aware stub: level picker accepts "balanced"; selection returns `selection`. */
const levelThen =
  (selection: 'original' | 'rewritten' | 'cancel'): NonNullable<ReviewDeps['elicit']> =>
  async (call) =>
    call.step === 'level'
      ? { action: 'accept', chosen: 'balanced' }
      : { action: 'accept', chosen: selection };

function depsWithReply(reply: string, elicit?: ReviewDeps['elicit']): ReviewDeps {
  const server = new McpServer({ name: 't', version: '0.0.1' }, { capabilities: { tools: {} } });
  return {
    server,
    rewrite: new RewriteService(new MockProvider({ kind: 'ok', reply })),
    log: quiet,
    elicit: elicit ?? levelThen('rewritten'),
  };
}

describe('Cancellation & fallback guarantees', () => {
  it('cancellation NEVER exposes selected_prompt (distinct outcome)', async () => {
    const deps = depsWithReply('Enriched', async (call) =>
      call.step === 'level' ? { action: 'accept', chosen: 'balanced' } : { action: 'cancel' }
    );
    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(res.structuredContent?.status).toBe('cancelled');
    expect(res.structuredContent?.selected_prompt).toBeNull();
    // The text also makes it explicit.
    expect(textOf(res)).toMatch(/cancelled/i);
  });

  it('LLM error NEVER silently falls back to original', async () => {
    // Simulate LLM failure (network error).
    const failing = new MockProvider({ kind: 'throw', error: 'ECONNREFUSED' });
    const server = new McpServer({ name: 't', version: '0.0.1' }, { capabilities: { tools: {} } });
    const deps: ReviewDeps = {
      server,
      rewrite: new RewriteService(failing),
      log: quiet,
      elicit: levelThen('rewritten'),
    };
    const res = await handleReviewAndSelect(deps, { prompt: 'original-prompt', context: 'test session' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.status).toBe('error');
    expect(res.structuredContent?.selected_prompt).toBeNull();
    // The text should not claim the original was approved.
    expect(textOf(res)).not.toMatch(/approved/i);
  });

  it('no auto-select after timeout — timeout is a hard error, not a default choice', async () => {
    const deps = depsWithReply('ok', async () => {
      // Simulate timeout / abort while the user was choosing.
      throw new Error('aborted');
    });
    const res = await handleReviewAndSelect(deps, { prompt: 'p', context: 'test session' });
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
    // Validation errors return a structured invalid_input response (they
    // must not throw across the MCP boundary) and never reach the LLM.
    const res = await handleReviewAndSelect(deps, { prompt: tooLong });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'invalid_input',
      selected_prompt: null,
    });
    expect(llmCalled).toBe(false);
  });
});
