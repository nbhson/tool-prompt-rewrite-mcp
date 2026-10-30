import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLogger } from '../src/logger.js';
import { handleReviewAndSelect, type ReviewDeps } from '../src/tools/reviewAndSelect.js';
import { RewriteService, buildMetaPrompt } from '../src/rewrite/rewrite.js';
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
    expect(calls[1]?.options.map((o) => o.value)).toEqual(['original', 'rewritten', 'update', 'cancel']);
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
      available_selections: ['original', 'rewritten', 'update', 'cancel'],
    });
    const reviewId = (r2.structuredContent as Record<string, unknown>)['review_id'];
    expect(typeof reviewId).toBe('string');
    expect(textOf(r2)).toMatch(/\[1\] original/);
    expect(textOf(r2)).toMatch(/\[2\] rewritten/);
    expect(textOf(r2)).toMatch(/\[3\] update/);
    expect(textOf(r2)).toMatch(/\[4\] cancel/);
    expect(llmCalls).toBe(1);

    // Call 3 — the agent relays the user's prompt choice; no extra LLM call.
    const r3 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      rewrite_level: 'balanced',
      review_id: reviewId as string,
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

  /** Drive the gate to a pending_user_selection and return its review_id. */
  async function startPendingFlow(deps: ReviewDeps, prompt = 'hello'): Promise<string> {
    await handleReviewAndSelect(deps, { prompt, context: 'test session' }); // → pending_level_selection
    const r = await handleReviewAndSelect(deps, {
      prompt,
      context: 'test session',
      rewrite_level: 'balanced',
    }); // → pending_user_selection
    const reviewId = (r.structuredContent as Record<string, unknown>)['review_id'];
    if (typeof reviewId !== 'string') throw new Error('no review_id in pending response');
    return reviewId;
  }

  it('re-call with selection="rewritten" + review_id → approves the STORED rewritten prompt, no LLM re-call', async () => {
    let llmCalls = 0;
    const provider = {
      isConfigured: () => true,
      chat: async () => {
        llmCalls += 1;
        throw new Error('must not be called');
      },
    } as unknown as LLMProvider;
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const reviewId = await startPendingFlow(deps);
    // From here on, any LLM call is a bug: approval must reuse the stored text.
    deps.rewrite = new RewriteService(provider);
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      review_id: reviewId,
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

  it('re-call with selection="rewritten" but a TAMPERED rewritten_prompt → rejected, nothing approved', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const reviewId = await startPendingFlow(deps);
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      review_id: reviewId,
      selection: 'rewritten',
      rewritten_prompt: 'Malicious substitution',
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'invalid_input',
      selected_prompt: null,
    });
  });

  it('re-call with selection but WITHOUT review_id → rejected (integrity requirement)', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      selection: 'rewritten',
      rewritten_prompt: 'Enriched',
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'invalid_input',
      message: 'selection requires a valid review_id from a pending_user_selection',
      selected_prompt: null,
    });
  });

  it('re-call with an UNKNOWN review_id → rejected', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    await startPendingFlow(deps); // create a live review; we use a different id below
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      review_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      selection: 'original',
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'invalid_input',
      selected_prompt: null,
    });
  });

  it('re-call with selection="original" + review_id → approves the original prompt', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const reviewId = await startPendingFlow(deps);
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      review_id: reviewId,
      selection: 'original',
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'original',
      selected_prompt: 'hello',
    });
  });

  it('re-call with selection="cancel" + review_id → cancelled outcome, no approved prompt', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());
    const reviewId = await startPendingFlow(deps);
    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'test session',
      review_id: reviewId,
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

  it('empty prompt → invalid_input error response (no throw across the MCP boundary)', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'x' });
    const res = await handleReviewAndSelect(deps, { prompt: '' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'invalid_input',
      selected_prompt: null,
    });
  });

  it('selection picker offers UPDATE; update+feedback re-rewrites at the same level and loops until a final pick', async () => {
    const calls: ElicitCall[] = [];
    let selectionRounds = 0;
    const stub: ElicitFn = async (call) => {
      calls.push(call);
      if (call.step === 'level') return { action: 'accept', chosen: 'detailed' };
      selectionRounds += 1;
      if (selectionRounds === 1) {
        return { action: 'accept', chosen: 'update', feedback: 'Make it shorter' };
      }
      return { action: 'accept', chosen: 'rewritten' };
    };
    const provider = new MockProvider((messages) =>
      messages.some((m) => m.content.includes('Make it shorter'))
        ? { kind: 'ok', reply: 'Enriched v2' }
        : { kind: 'ok', reply: 'Enriched v1' }
    );
    const deps = makeDeps({ kind: 'ok', reply: 'unused' }, stub);
    deps.rewrite = new RewriteService(provider);

    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'ctx' });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'approved',
      selected_option: 'rewritten',
      selected_prompt: 'Enriched v2',
    });
    // Two selection rounds: update first, then the final pick.
    expect(calls.map((c) => c.step)).toEqual(['level', 'selection', 'selection']);
    expect(calls[1]?.options.map((o) => o.value)).toEqual(['original', 'rewritten', 'update', 'cancel']);
    // The selection form carries the optional feedback field.
    expect(calls[1]?.feedback).toBeDefined();
    // The revision round called the LLM with the user's feedback and the
    // previous rewrite, and the level was kept ("detailed").
    expect(provider.calls).toHaveLength(2);
    const revisionMessage = provider.calls[1]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(revisionMessage).toContain('Make it shorter');
    expect(revisionMessage).toContain('Enriched v1');
    // The revision keeps the user-chosen level ("detailed" meta-prompt).
    expect(provider.calls[1]?.messages[0]?.content).toBe(buildMetaPrompt('detailed'));
  });

  it('choosing UPDATE without feedback re-asks once; the next pick finalizes', async () => {
    const selectionMessages: string[] = [];
    let selectionRounds = 0;
    const stub: ElicitFn = async (call) => {
      if (call.step === 'level') return { action: 'accept', chosen: 'balanced' };
      selectionMessages.push(call.message);
      selectionRounds += 1;
      if (selectionRounds === 1) return { action: 'accept', chosen: 'update' };
      return { action: 'accept', chosen: 'original' };
    };
    let llmCalls = 0;
    const provider: LLMProvider = {
      isConfigured: () => true,
      chat: async () => {
        llmCalls += 1;
        return 'Enriched';
      },
    };
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, stub);
    deps.rewrite = new RewriteService(provider);

    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'ctx' });
    expect(res.structuredContent).toMatchObject({ status: 'approved', selected_option: 'original' });
    expect(selectionRounds).toBe(2);
    expect(selectionMessages[1]).toMatch(/did not describe the changes/);
    expect(llmCalls).toBe(1); // only the first rewrite; no revision was triggered
  });

  it('choosing UPDATE without feedback twice → invalid_input error (no infinite loop)', async () => {
    let selectionRounds = 0;
    const stub: ElicitFn = async (call) => {
      if (call.step === 'level') return { action: 'accept', chosen: 'balanced' };
      selectionRounds += 1;
      return { action: 'accept', chosen: 'update' };
    };
    let llmCalls = 0;
    const provider: LLMProvider = {
      isConfigured: () => true,
      chat: async () => {
        llmCalls += 1;
        return 'Enriched';
      },
    };
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, stub);
    deps.rewrite = new RewriteService(provider);

    const res = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'ctx' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'invalid_input',
      selected_prompt: null,
    });
    expect(selectionRounds).toBe(2);
    expect(llmCalls).toBe(1); // only the first rewrite
  });

  it('echo fallback: relayed selection="update" + feedback rewrites again and returns a NEW pending_user_selection (loop)', async () => {
    const provider = new MockProvider((messages) =>
      messages.some((m) => m.content.includes('Keep it short'))
        ? { kind: 'ok', reply: 'Short version' }
        : { kind: 'ok', reply: 'Enriched' }
    );
    const deps = makeDeps({ kind: 'ok', reply: 'unused' }, elicitationUnsupported());
    deps.rewrite = new RewriteService(provider);

    // Call 1: level menu (no LLM).
    const r1 = await handleReviewAndSelect(deps, { prompt: 'hello', context: 'ctx' });
    expect(r1.structuredContent).toMatchObject({ status: 'pending_level_selection' });

    // Call 2: relayed level → first rewrite + selection menu.
    const r2 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      rewrite_level: 'balanced',
    });
    expect(r2.structuredContent).toMatchObject({
      status: 'pending_user_selection',
      rewritten_prompt: 'Enriched',
      available_selections: ['original', 'rewritten', 'update', 'cancel'],
      revision_count: 0,
    });

    // Call 3: relayed update + feedback → revised rewrite + NEW menu.
    const r2ReviewId = (r2.structuredContent as Record<string, unknown>)['review_id'] as string;
    const r3 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      rewrite_level: 'balanced',
      review_id: r2ReviewId,
      selection: 'update',
      feedback: 'Keep it short',
      rewritten_prompt: 'Enriched',
    });
    expect(r3.isError).toBeFalsy();
    expect(r3.structuredContent).toMatchObject({
      status: 'pending_user_selection',
      rewritten_prompt: 'Short version',
      revision_count: 1,
      available_selections: ['original', 'rewritten', 'update', 'cancel'],
    });
    expect(textOf(r3)).toMatch(/Revised 1 time/);

    // Call 4: final pick → approved; no further LLM call.
    const r3ReviewId = (r3.structuredContent as Record<string, unknown>)['review_id'] as string;
    expect(r3ReviewId).not.toBe(r2ReviewId); // each pending round gets its own id
    const r4 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      rewrite_level: 'balanced',
      review_id: r3ReviewId,
      selection: 'rewritten',
      rewritten_prompt: 'Short version',
    });
    expect(r4.structuredContent).toMatchObject({ status: 'approved', selected_prompt: 'Short version' });
    expect(provider.calls).toHaveLength(2);
  });

  it('echo fallback: relayed selection="update" without feedback → invalid_input error, no LLM call', async () => {
    let llmCalls = 0;
    const provider: LLMProvider = {
      isConfigured: () => true,
      chat: async () => {
        llmCalls += 1;
        return 'x';
      },
    };
    const deps = makeDeps({ kind: 'ok', reply: 'x' }, elicitationUnsupported());
    deps.rewrite = new RewriteService(provider);

    await handleReviewAndSelect(deps, { prompt: 'hello', context: 'ctx' }); // → pending_level_selection
    const r2 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      rewrite_level: 'balanced',
    }); // → pending_user_selection
    const reviewId = (r2.structuredContent as Record<string, unknown>)['review_id'] as string;

    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      rewrite_level: 'balanced',
      review_id: reviewId,
      selection: 'update',
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'invalid_input',
      message: 'feedback is required when selection="update"',
      selected_prompt: null,
    });
    // llmCalls === 1: the FIRST rewrite (call 2 of the flow). The failed
    // update relay itself made no additional LLM call.
    expect(llmCalls).toBe(1);
  });

  it('echo fallback: update relay reuses the STORED review level (no silent "balanced" default)', async () => {
    const provider = new MockProvider((messages) =>
      messages.some((m) => m.content.includes('add criteria'))
        ? { kind: 'ok', reply: 'Revised' }
        : { kind: 'ok', reply: 'Enriched' }
    );
    const deps = makeDeps({ kind: 'ok', reply: 'unused' }, elicitationUnsupported());
    deps.rewrite = new RewriteService(provider);

    await handleReviewAndSelect(deps, { prompt: 'hello', context: 'ctx' }); // → pending_level_selection
    const r2 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      rewrite_level: 'detailed', // the USER chose "detailed"
    }); // → pending_user_selection
    const reviewId = (r2.structuredContent as Record<string, unknown>)['review_id'] as string;

    const res = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      review_id: reviewId,
      selection: 'update',
      feedback: 'add criteria',
      rewritten_prompt: 'Enriched',
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: 'pending_user_selection',
      rewritten_prompt: 'Revised',
    });
    // The revision runs at the level the user chose for this review.
    expect(provider.calls[1]?.messages[0]?.content).toBe(buildMetaPrompt('detailed'));
  });

  it('echo fallback: revision limit applies ACROSS relay calls (no unbounded update loop)', async () => {
    const deps = makeDeps({ kind: 'ok', reply: 'Enriched' }, elicitationUnsupported());

    await handleReviewAndSelect(deps, { prompt: 'hello', context: 'ctx' }); // → pending_level_selection
    const r2 = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      rewrite_level: 'balanced',
    }); // → pending_user_selection
    let reviewId = (r2.structuredContent as Record<string, unknown>)['review_id'] as string;

    // Relay "update" until the stored revision cap rejects the next round.
    let last = r2;
    for (let i = 0; i < 25; i++) {
      const r = await handleReviewAndSelect(deps, {
        prompt: 'hello',
        context: 'ctx',
        review_id: reviewId,
        selection: 'update',
        feedback: `change ${i}`,
      });
      expect(r.isError).toBeFalsy();
      last = r;
      reviewId = (r.structuredContent as Record<string, unknown>)['review_id'] as string;
    }
    expect((last.structuredContent as Record<string, unknown>)['revision_count']).toBe(25);

    // The 26th revision attempt exceeds MAX_REVISIONS (25).
    const over = await handleReviewAndSelect(deps, {
      prompt: 'hello',
      context: 'ctx',
      review_id: reviewId,
      selection: 'update',
      feedback: 'one too many',
    });
    expect(over.isError).toBe(true);
    expect(over.structuredContent).toMatchObject({
      status: 'error',
      error_kind: 'revision_limit',
      selected_prompt: null,
    });
  });
});
