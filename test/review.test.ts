import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLogger } from '../src/logger.js';
import { handleReviewAndSelect, type ReviewDeps } from '../src/tools/reviewAndSelect.js';
import { RewriteService } from '../src/rewrite/rewrite.js';
import { MockProvider, type MockBehavior } from './fixtures/llm-mocks.js';
import { GateError } from '../src/types.js';

const quiet = createLogger('error');

function makeDeps(llmBehavior: MockBehavior, elicit?: ReviewDeps['elicit']): ReviewDeps {
  const server = new McpServer({ name: 'test', version: '0.0.1' }, { capabilities: { tools: {} } });
  const provider = new MockProvider(llmBehavior);
  const rewrite = new RewriteService(provider);
  return {
    server,
    rewrite,
    log: quiet,
    elicit,
  };
}

const choose = (value: string) => async () => ({ action: 'accept', chosen: value }) as const;
const cancel = () => async () => ({ action: 'cancel' }) as const;
const elicitationUnsupported = () => async () => {
  throw new GateError('elicitation_unsupported', 'client does not support elicitation');
};

describe('handleReviewAndSelect', () => {
  it('user selects ORIGINAL → returns original, not rewritten', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, choose('original'));
    const res = await handleReviewAndSelect(deps, { prompt: 'hello' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'original',
      selected_prompt: 'hello',
    });
  });

  it('user selects REWRITTEN → returns enriched, not original', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, choose('rewritten'));
    const res = await handleReviewAndSelect(deps, { prompt: 'hello' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'rewritten',
      selected_prompt: 'Enriched',
    });
  });

  it('user CANCELs → distinct cancelled outcome, selectedPrompt=null', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, cancel());
    const res = await handleReviewAndSelect(deps, { prompt: 'hello' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'cancelled',
      selected_option: 'cancel',
      selected_prompt: null,
    });
  });

  it('cancel via outcome.action="cancel" also maps to cancelled', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' });
    // Simulate the client aborting the elicitation itself.
    const cancelOutcome = async () => ({ action: 'cancel' }) as const;
    const deps2 = { ...deps, elicit: cancelOutcome };
    const res = await handleReviewAndSelect(deps2, { prompt: 'hello' });
    expect(res.structuredContent).toMatchObject({ status: 'cancelled', selected_prompt: null });
  });

  it('LLM failure → error outcome, NOT a silent fallback to original', async () => {
    const deps = makeDeps({ kind: 'timeout' });
    const res = await handleReviewAndSelect(deps, { prompt: 'hello' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'llm_timeout',
      selected_prompt: null,
    });
    // The text should make clear that no prompt was approved.
    expect(res.content[0].text).toMatch(/failed/i);
  });

  it('Elicitation unsupported → compatibility error, prompt NOT forwarded', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const res = await handleReviewAndSelect(deps, { prompt: 'hello' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'elicitation_unsupported',
      selected_prompt: null,
    });
    expect(res.content[0].text).toMatch(/does not support interactive elicitation/i);
  });

  it('Invalid selection (out-of-enum) → error outcome, no approval', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' });
    const invalid = async () => {
      throw new GateError('invalid_input', 'selected not in enum');
    };
    const res = await handleReviewAndSelect({ ...deps, elicit: invalid }, { prompt: 'hello' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'invalid_input',
      selected_prompt: null,
    });
  });

  it('empty prompt is rejected by Zod validation', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'x' });
    await expect(handleReviewAndSelect(deps, { prompt: '' })).rejects.toThrow();
  });
});
