import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLogger } from '../src/logger.js';
import { handleReviewAndSelect, type ReviewDeps } from '../src/tools/reviewAndSelect.js';
import { RewriteService } from '../src/rewrite/rewrite.js';
import type { LLMProvider } from '../src/llm/provider.js';
import type { ElicitCall } from '../src/elicitation.js';
import { MockProvider, type MockBehavior } from './fixtures/llm-mocks.js';
import { GateError } from '../src/types.js';

const quiet = createLogger('error');

type GateResponse = Awaited<ReturnType<typeof handleReviewAndSelect>>;
/** First text block of a gate response (optional-safe for strict TS). */
const textOf = (res: GateResponse): string => res.content[0]?.text ?? '';

function makeDeps(llmBehavior: MockBehavior, elicit?: ReviewDeps['elicit']): ReviewDeps {
  const server = new McpServer({ name: 'test', version: '0.0.1' }, { capabilities: { tools: {} } });
  const provider = new MockProvider(llmBehavior);
  const rewrite = new RewriteService(provider);
  return {
    server,
    rewrite,
    log: quiet,
    // Default: the level picker accepts "balanced", the selection picker
    // accepts "rewritten". Individual tests override this.
    elicit: elicit ?? choose('rewritten'),
  };
}

type ElicitFn = NonNullable<ReviewDeps['elicit']>;

/**
 * Step-aware stub: the level picker returns `level` (default "balanced"),
 * the selection picker returns `value`.
 */
const choose =
  (value: string, level = 'balanced'): ElicitFn =>
  async (call: ElicitCall) =>
    call.step === 'level' ? { action: 'accept', chosen: level } : { action: 'accept', chosen: value };

/** The user picks the "cancel" option at the given step. */
const chooseCancel =
  (at: 'level' | 'selection' = 'selection'): ElicitFn =>
  async (call: ElicitCall) =>
    call.step === at
      ? { action: 'accept', chosen: 'cancel' }
      : { action: 'accept', chosen: call.step === 'level' ? 'balanced' : 'original' };

/** The client aborts the elicitation itself at the given step. */
const abort =
  (at: 'level' | 'selection' = 'selection'): ElicitFn =>
  async (call: ElicitCall) =>
    call.step === at
      ? { action: 'cancel' }
      : { action: 'accept', chosen: call.step === 'level' ? 'balanced' : 'original' };

const elicitationUnsupported = (): ElicitFn => async () => {
  throw new GateError('elicitation_unsupported', 'client does not support elicitation');
};

describe('handleReviewAndSelect', () => {
  it('user selects ORIGINAL → returns original, not rewritten', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, choose('original'));
    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'original',
      selected_prompt: 'hello',
    });
  });

  it('user selects REWRITTEN → returns enriched, not original', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, choose('rewritten'));
    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'rewritten',
      selected_prompt: 'Enriched',
    });
  });

  it('asks the USER for the rewrite level first (light/balanced/detailed), before the rewrite', async () => {
    const calls: ElicitCall[] = [];
    const stub: ElicitFn = async (call) => {
      calls.push(call);
      return call.step === 'level'
        ? { action: 'accept', chosen: 'detailed' }
        : { action: 'accept', chosen: 'original' };
    };
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, stub);
    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(res.structuredContent).toMatchObject({ status: 'approved', selected_option: 'original' });
    // The level picker comes FIRST, with exactly the three levels;
    // the selection picker comes after the rewrite.
    expect(calls.map((c) => c.step)).toEqual(['level', 'selection']);
    expect(calls[0]?.options.map((o) => o.value)).toEqual(['light', 'balanced', 'detailed']);
    expect(calls[1]?.options.map((o) => o.value)).toEqual(['original', 'rewritten', 'cancel']);
  });

  it('rewrites at the level the USER picked (agent-provided level is ignored when the picker works)', async () => {
    const usedLevels: string[] = [];
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, choose('rewritten', 'detailed'));
    const svc = new RewriteService(new MockProvider({ kind: 'ok', reply: 'Enriched' }));
    const orig = svc.rewrite.bind(svc);
    svc.rewrite = async (p, o) => {
      usedLevels.push(o?.level ?? 'undefined');
      return orig(p, o);
    };
    deps.rewrite = svc;
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      rewrite_level: 'light', // agent suggestion — must be ignored; the user picks "detailed"
    });
    expect(res.structuredContent).toMatchObject({ status: 'approved', selected_option: 'rewritten' });
    expect(usedLevels).toEqual(['detailed']);
  });

  it('user picks CANCEL at the selection step → distinct cancelled outcome, selectedPrompt=null', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, chooseCancel('selection'));
    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'cancelled',
      selected_option: 'cancel',
      selected_prompt: null,
    });
  });

  it('cancel via outcome.action="cancel" (client aborted the picker) also maps to cancelled', async () => {
    // Simulate the client aborting the selection elicitation itself.
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, abort('selection'));
    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(res.structuredContent).toMatchObject({ status: 'cancelled', selected_prompt: null });
  });

  it('user CANCELs at the level picker → cancelled before any rewrite (no LLM call)', async () => {
    let llmCalls = 0;
    const inner = new MockProvider({ kind: 'ok', reply: 'Enriched' });
    const counting: LLMProvider = {
      isConfigured: () => true,
      chat: async (messages) => {
        llmCalls += 1;
        return inner.chat(messages);
      },
    };
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, abort('level'));
    deps.rewrite = new RewriteService(counting);
    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'cancelled',
      selected_option: 'cancel',
      selected_prompt: null,
    });
    expect(textOf(res)).toMatch(/cancelled/i);
    expect(llmCalls).toBe(0);
  });

  it('LLM failure → error outcome, NOT a silent fallback to original', async () => {
    const deps = makeDeps({ kind: 'timeout' });
    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'llm_timeout',
      selected_prompt: null,
    });
    // The text should make clear that no prompt was approved.
    expect(textOf(res)).toMatch(/failed/i);
  });

  it('Elicitation unsupported + echoFallback=true (default) → level menu first (no LLM), then selection menu, then approval', async () => {
    let llmCalls = 0;
    const inner = new MockProvider({ kind: 'ok', reply: 'Enriched' });
    const counting: LLMProvider = {
      isConfigured: () => true,
      chat: async (messages) => {
        llmCalls += 1;
        return inner.chat(messages);
      },
    };
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    deps.rewrite = new RewriteService(counting);

    // Call 1 — no level relayed yet: ask the USER for the level; NO LLM call.
    const r1 = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'test session' });
    expect(r1.isError).toBeFalsy();
    expect(r1.structuredContent).toMatchObject({
      status: 'pending_level_selection',
      available_levels: ['light', 'balanced', 'detailed'],
    });
    expect(textOf(r1)).toMatch(/\[1\] light/);
    expect(textOf(r1)).toMatch(/\[2\] balanced/);
    expect(textOf(r1)).toMatch(/\[3\] detailed/);
    expect(llmCalls).toBe(0);

    // Call 2 — the agent relays the user's level choice: the rewrite runs,
    // then the selection menu is returned as pending_user_selection.
    const r2 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      rewrite_level: 'balanced',
    });
    expect(r2.isError).toBeFalsy();
    expect(r2.structuredContent).toMatchObject({
      status: 'pending_user_selection',
      original_prompt: 'hello',
      rewritten_prompt: 'Enriched',
      available_selections: ['original', 'rewritten', 'cancel'],
    });
    expect(textOf(r2)).toMatch(/\[1\] original/);
    expect(textOf(r2)).toMatch(/\[2\] rewritten/);
    expect(textOf(r2)).toMatch(/\[3\] cancel/);
    expect(llmCalls).toBe(1);

    // Call 3 — the agent relays the user's prompt choice; no extra LLM call.
    const r3 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      rewrite_level: 'balanced',
      selection: 'rewritten',
      rewritten_prompt: 'Enriched',
    });
    expect(r3.isError).toBeFalsy();
    expect(r3.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'rewritten',
      selected_prompt: 'Enriched',
    });
    expect(llmCalls).toBe(1);
  });

  it('Elicitation unsupported + echoFallback=false (strict) → compatibility error, prompt NOT forwarded', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const res = await handleReviewAndSelect(
      { ...deps, echoFallback: false },
      { prompt: 'hello', context: 'test session' }
    );
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'elicitation_unsupported',
      selected_prompt: null,
    });
    expect(textOf(res)).toMatch(/does not support interactive elicitation/i);
  });

  it('re-call with selection="rewritten" → approves the passed rewritten_prompt, no LLM re-call', async () => {
    let llmCalls = 0;
    const provider = {
      isConfigured: () => true,
      chat: async () => {
        llmCalls += 1;
        throw new Error('must not be called');
      },
    } as unknown as LLMProvider;
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' });
    deps.rewrite = new RewriteService(provider);
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      selection: 'rewritten',
      rewritten_prompt: 'Enriched',
    });
    expect(llmCalls).toBe(0);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'rewritten',
      selected_prompt: 'Enriched',
      original_prompt: 'hello',
      rewritten_prompt: 'Enriched',
    });
  });

  it('re-call with selection="original" → approves the original prompt', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      selection: 'original',
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'original',
      selected_prompt: 'hello',
    });
  });

  it('re-call with selection="cancel" → cancelled outcome, no approved prompt', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      selection: 'cancel',
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'cancelled',
      selected_option: 'cancel',
      selected_prompt: null,
    });
    expect(textOf(res)).toMatch(/cancelled/i);
  });

  it('Invalid selection (out-of-enum) → error outcome, no approval', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' });
    const invalid = async () => {
      throw new GateError('invalid_input', 'selected not in enum');
    };
    const res = await handleReviewAndSelect(
      { ...deps, elicit: invalid },
      { prompt: 'hello', context: 'test' }
    );
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
