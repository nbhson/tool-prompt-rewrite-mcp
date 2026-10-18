/**
 * `review_and_select_prompt` — the gate tool.
 *
 * Generates a rewrite, shows both versions to the user via MCP elicitation,
 * and returns ONLY the approved prompt (or a distinct "cancelled" outcome).
 *
 * Hard rules (from spec):
 * - Cancel NEVER produces an approved prompt.
 * - Errors NEVER silently fall back to the original.
 * - Timeout NEVER auto-selects an option.
 * - When the client does not support elicitation:
 *   - default (PROMPT_GATE_ECHO_FALLBACK=true): return a
 *     "pending_user_selection" result that renders the three numbered
 *     choices in plain text; the agent asks the user and re-calls this
 *     tool with the `selection` input. This is an EXPLICIT user choice
 *     relayed by the agent, not a silent fallback.
 *   - strict (PROMPT_GATE_ECHO_FALLBACK=false): return a clear
 *     compatibility error — do not pretend a normal tool response is an
 *     interactive confirmation.
 *
 * For testability, the elicitation function and LLM provider are
 * injected rather than reached through the live MCP server.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewriteService } from '../rewrite/rewrite.js';
import { LLMError } from '../rewrite/rewrite.js';
import { elicitPromptChoice, type ElicitationOption, type ElicitationResult } from '../elicitation.js';
import { GateError, type ReviewResult, type PromptSelection } from '../types.js';
import type { Logger } from '../logger.js';
import type { ClientCapabilities } from '../capability/capability.js';

export const SELECTION_VALUES: readonly PromptSelection[] = ['original', 'rewritten', 'cancel'];

export const ReviewAndSelectInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(32_000)
    .describe("The original prompt to review. This is the user's latest message only."),
  language: z
    .string()
    .max(32)
    .optional()
    .describe(
      'Output language, e.g. "english" or "vietnamese". ONLY pass this when the ' +
        'user explicitly asks for a different output language. If the user has not ' +
        "asked, omit it — the server auto-detects the prompt's language and " +
        'preserves it. Do NOT pass "english" just to "improve clarity"; that ' +
        'switches the output language and is a drift.'
    ),
  context: z
    .string()
    .max(8_000)
    .describe(
      '1-3 sentences summarizing the conversation/session so far (what the user has asked, ' +
        'what files/topics are in play, what was decided). STRONGLY RECOMMENDED: pass this ' +
        'on every call so the rewrite is grounded in prior context. Omit only for brand-new ' +
        'sessions with no history.'
    ),
  rewrite_level: z
    .enum(['light', 'balanced', 'detailed'])
    .optional()
    .describe(
      'How much enrichment to apply. "light" = minimal; "balanced" (default) = add missing ' +
        'structure/context/criteria; "detailed" = full spec with acceptance criteria.'
    ),
  selection: z
    .enum(['original', 'rewritten', 'cancel'])
    .optional()
    .describe(
      "ONLY for the SECOND call of a pending_user_selection flow: the user's explicit " +
        'choice after the server could not show an interactive picker. On the first call ' +
        '(rewrite) this must be omitted. Values: "original", "rewritten", "cancel". ' +
        'Never auto-select; pass it only after the user has chosen.'
    ),
  rewritten_prompt: z
    .string()
    .max(32_000)
    .optional()
    .describe(
      'ONLY for the SECOND call of a pending_user_selection flow: the exact rewritten ' +
        'text the user saw in the first call\'s "pending_user_selection" result. ' +
        'Omit on the first call. When present with selection="rewritten", this is what ' +
        'gets approved — so the user approves exactly what they read, not a re-rewrite.'
    ),
});

export type ReviewAndSelectInput = z.infer<typeof ReviewAndSelectInputSchema>;

const OPTION_ORIGINAL = 'original';
const OPTION_REWRITTEN = 'rewritten';
const OPTION_CANCEL = 'cancel';

export interface ReviewDeps {
  server: McpServer;
  rewrite: RewriteService;
  log: Logger;
  /** Injectable so tests can stub user choice without a real client. */
  elicit?: (message: string, options: ElicitationOption[], requestId: string) => Promise<ElicitationResult>;
  /** Read the current client's verified capabilities (used to decide elicitation vs fallback). */
  detect?: () => ClientCapabilities;
  /**
   * Whether the text-echo fallback is enabled when the client does not
   * support elicitation. Default true. When false, the call returns a
   * hard compatibility error instead (strictest mode).
   */
  echoFallback?: boolean;
}

export function buildElicitDeps(deps: ReviewDeps) {
  const elicit =
    deps.elicit ??
    ((message: string, options: ElicitationOption[], requestId: string) =>
      elicitPromptChoice(deps.server, message, options, requestId));
  return { ...deps, elicit };
}

/**
 * Core handler logic, separated from MCP tool registration so it can be
 * unit-tested without a live MCP server connection.
 */
export async function handleReviewAndSelect(
  deps: ReviewDeps,
  rawInput: unknown
): Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}> {
  const { elicit } = buildElicitDeps(deps);
  const { log, rewrite } = deps;
  const echoFallback = deps.echoFallback ?? true;
  const detect = deps.detect;

  const input = ReviewAndSelectInputSchema.parse(rawInput);
  const requestId = randomUUID().slice(0, 8);
  const start = Date.now();

  // ── Fast path: re-invocation after pending_user_selection ───────────
  // When the first call returned "pending_user_selection" (the client does
  // not support elicitation), the agent shows the three choices to the user,
  // the user picks one, and the agent calls this tool again WITH the
  // user's `selection`. This path does NOT call the LLM again — it simply
  // maps the explicit choice to the approved/cancelled outcome.
  if (input.selection) {
    const chosen = input.selection;
    log.info('review_and_select_prompt: selection received', {
      requestId,
      chosen,
      promptLen: input.prompt.length,
    });

    // Map the user's explicit choice to the outcome. The rewrite was
    // already produced on the first call; we reuse the caller's
    // `prompt`/`rewrite_level`/`language`/`context` so the response is
    // self-consistent. We do NOT call the LLM again.
    const original = input.prompt;
    const result: ReviewResult =
      chosen === 'cancel'
        ? { status: 'cancelled', selectedOption: 'cancel', selectedPrompt: null }
        : chosen === 'rewritten'
          ? {
              status: 'approved',
              selectedOption: 'rewritten',
              selectedPrompt: input.rewritten_prompt ?? original,
              originalPrompt: original,
              rewrittenPrompt: input.rewritten_prompt ?? original,
            }
          : {
              status: 'approved',
              selectedOption: 'original',
              selectedPrompt: original,
              originalPrompt: original,
              rewrittenPrompt: input.rewritten_prompt ?? original,
            };

    const text =
      result.status === 'cancelled'
        ? 'Prompt gate: user cancelled. No prompt was approved and none was forwarded.'
        : `Prompt gate: approved "${result.selectedOption}" prompt.\n\n${result.selectedPrompt}`;

    return {
      content: [{ type: 'text', text }],
      structuredContent:
        result.status === 'cancelled'
          ? { status: 'cancelled', selected_option: 'cancel', selected_prompt: null }
          : {
              status: 'approved',
              selected_option: result.selectedOption,
              selected_prompt: result.selectedPrompt,
              original_prompt: result.originalPrompt,
              rewritten_prompt: result.rewrittenPrompt,
            },
    };
  }

  log.info('review_and_select_prompt: started', { requestId, promptLen: input.prompt.length });

  // 1. Generate the rewrite. On LLM failure we do NOT fall back to
  //    original — we surface a distinct error outcome.
  let original = input.prompt;
  let rewritten = input.prompt;
  let changesSummary = 'No rewrite was attempted.';
  let warnings: string[] | undefined;

  try {
    const r = await rewrite.rewrite(input.prompt, {
      level: input.rewrite_level,
      language: input.language,
      context: input.context,
    });
    original = r.originalPrompt;
    rewritten = r.rewrittenPrompt;
    changesSummary = r.changesSummary;
    warnings = r.warnings;
  } catch (err) {
    const ge = normalizeGateError(err, requestId);
    log.error('review_and_select_prompt: rewrite failed', {
      requestId,
      kind: ge.kind,
      message: ge.message,
      elapsedMs: Date.now() - start,
    });
    return {
      content: [{ type: 'text', text: `Prompt gate failed before user selection: ${ge.message}` }],
      isError: true,
      structuredContent: {
        status: 'error',
        error_kind: ge.kind,
        message: ge.message,
        selected_prompt: null,
      },
    };
  }

  // 2. Show both versions and ask the user to choose.
  const message = [
    'Review the original prompt and the rewritten prompt, then choose one:',
    '',
    '--- ORIGINAL ---',
    original,
    '',
    '--- REWRITTEN ---',
    rewritten,
    '',
    `Changes: ${changesSummary}`,
    warnings?.length ? `Warnings: ${warnings.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const options: ElicitationOption[] = [
    { value: OPTION_ORIGINAL, title: 'Use original prompt', description: "Keep the user's exact text." },
    { value: OPTION_REWRITTEN, title: 'Use rewritten prompt', description: 'Use the LLM-enriched version.' },
    { value: OPTION_CANCEL, title: 'Cancel', description: 'Abort; do not use either prompt.' },
  ];

  let outcome: ElicitationResult;
  try {
    outcome = await elicit(message, options, requestId);
  } catch (err) {
    const ge = err instanceof GateError ? err : new GateError('unknown', String(err), { requestId });
    log.warn('review_and_select_prompt: elicitation issue', { requestId, kind: ge.kind });

    // Elicitation unsupported (client did not declare the capability, or the
    // request was refused by the protocol). Two behaviors:
    //
    // 1. echoFallback=true (default): return a distinct
    //    "pending_user_selection" result that renders the three numbered
    //    choices in plain text and instructs the agent to re-call this tool
    //    with the user's `selection`. This is an EXPLICIT user choice
    //    relayed by the agent — not a silent fallback, not an auto-select.
    //
    // 2. echoFallback=false (strict): hard compatibility error, as before.
    if (ge.kind === 'elicitation_unsupported' && echoFallback) {
      const supports = detect ? detect().elicitationSupported : false;
      const menu = [
        'The client does not support MCP elicitation, so an interactive picker ' +
          'cannot be shown. Below are the two versions; ask the user to choose, ' +
          "then re-call this tool with the user's choice in `selection`.",
        '',
        '--- ORIGINAL ---',
        original,
        '',
        '--- REWRITTEN ---',
        rewritten,
        '',
        `Changes: ${changesSummary}`,
        warnings?.length ? `Warnings: ${warnings.join('; ')}` : '',
        '',
        'REPLY TO THE USER: "Which should be used?", with these numbered options:',
        "[1] original — use the user's exact text",
        '[2] rewritten — use the LLM-enriched version',
        '[3] cancel — use neither; abort the prompt gate',
        '',
        'When the user answers, call review_and_select_prompt again with the ' +
          'SAME prompt/context/rewrite_level/language and `selection` set to ' +
          '"original", "rewritten", or "cancel" depending on their choice. ' +
          'Never pick for the user.',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: [{ type: 'text', text: menu }],
        structuredContent: {
          status: 'pending_user_selection',
          original_prompt: original,
          rewritten_prompt: rewritten,
          changes_summary: changesSummary,
          ...(warnings?.length ? { warnings } : {}),
          available_selections: ['original', 'rewritten', 'cancel'],
          client_elicitation_supported: supports,
          request_id: requestId,
        },
      };
    }

    if (ge.kind === 'elicitation_unsupported' || ge.kind === 'invalid_input') {
      return {
        content: [
          {
            type: 'text',
            text:
              'This client does not support interactive elicitation, or the selection was invalid. ' +
              'The prompt was NOT forwarded. Set PROMPT_GATE_ECHO_FALLBACK=true to enable the ' +
              'text fallback (default), or configure a client that supports MCP elicitation.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'error',
          error_kind: ge.kind,
          message: ge.message,
          selected_prompt: null,
        },
      };
    }
    return {
      content: [{ type: 'text', text: `Elicitation error: ${ge.message}` }],
      isError: true,
      structuredContent: { status: 'error', error_kind: ge.kind, message: ge.message, selected_prompt: null },
    };
  }

  log.info('review_and_select_prompt: user chose', {
    requestId,
    action: outcome.action,
    chosen: outcome.action === 'accept' ? outcome.chosen : 'n/a',
    elapsedMs: Date.now() - start,
  });

  // 3. Map to ReviewResult.
  const result: ReviewResult =
    outcome.action === 'cancel' || outcome.chosen === OPTION_CANCEL
      ? { status: 'cancelled', selectedOption: 'cancel', selectedPrompt: null }
      : outcome.chosen === OPTION_REWRITTEN
        ? {
            status: 'approved',
            selectedOption: 'rewritten',
            selectedPrompt: rewritten,
            originalPrompt: original,
            rewrittenPrompt: rewritten,
          }
        : {
            status: 'approved',
            selectedOption: 'original',
            selectedPrompt: original,
            originalPrompt: original,
            rewrittenPrompt: rewritten,
          };

  const text =
    result.status === 'cancelled'
      ? 'Prompt gate: user cancelled. No prompt was approved and none was forwarded.'
      : `Prompt gate: approved "${result.selectedOption}" prompt.\n\n${result.selectedPrompt}`;

  return {
    content: [{ type: 'text', text }],
    structuredContent:
      result.status === 'cancelled'
        ? { status: 'cancelled', selected_option: 'cancel', selected_prompt: null }
        : {
            status: 'approved',
            selected_option: result.selectedOption,
            selected_prompt: result.selectedPrompt,
            original_prompt: result.originalPrompt,
            rewritten_prompt: result.rewrittenPrompt,
          },
  };
}

export function registerReviewAndSelectTool(deps: ReviewDeps): void {
  const { server } = deps;
  server.registerTool(
    'review_and_select_prompt',
    {
      title: 'Prompt Gate (user-confirmed)',
      description:
        'Generates a rewritten version of the prompt, then asks the user to ' +
        'choose: use original, use rewritten, or cancel. Returns only the ' +
        'approved prompt. Cancellation is a distinct outcome and never ' +
        'exposes an approved prompt.\n' +
        '\n' +
        'If the client does not support MCP elicitation, the tool returns a ' +
        'distinct "pending_user_selection" result: it shows both versions in ' +
        'plain text with the three numbered choices and asks the agent to ' +
        "re-call this tool with `selection` set to the user's choice " +
        '("original" / "rewritten" / "cancel"). Never auto-select.\n' +
        '\n' +
        'CALLING GUIDE (for the LLM):\n' +
        '- FIRST call (rewrite): pass prompt + context; do NOT pass ' +
        '`selection`. ALWAYS pass a short `context` (1-3 sentences) ' +
        'summarizing the conversation so far.\n' +
        '- If the first call returns status "pending_user_selection": show ' +
        'the two versions to the user, ask which to use, then call again ' +
        'with the SAME inputs PLUS `selection` set to "original", ' +
        '"rewritten", or "cancel" matching the user\'s choice.\n' +
        '- Choose `rewrite_level` to fit the task: `light` for quick ' +
        'one-shot answers, `balanced` (default) for most coding/research ' +
        'work, `detailed` when the user explicitly wants a fully-specified ' +
        'spec.\n' +
        '- Pass `language` only when the user wants the rewritten prompt in ' +
        'a language different from the original. Do NOT switch the language ' +
        'on your own judgment — the server auto-detects the prompt language ' +
        'and preserves it by default.',
      inputSchema: {
        prompt: ReviewAndSelectInputSchema.shape.prompt,
        language: ReviewAndSelectInputSchema.shape.language,
        context: ReviewAndSelectInputSchema.shape.context,
        rewrite_level: ReviewAndSelectInputSchema.shape.rewrite_level,
        selection: ReviewAndSelectInputSchema.shape.selection,
        rewritten_prompt: ReviewAndSelectInputSchema.shape.rewritten_prompt,
      },
    },
    async (rawInput) => handleReviewAndSelect(deps, rawInput)
  );
}

function normalizeGateError(err: unknown, requestId: string): GateError {
  if (err instanceof GateError) return err;
  if (err instanceof LLMError) {
    const msg = err.message.toLowerCase();
    const kind = msg.includes('timed out') ? 'llm_timeout' : 'llm_unavailable';
    return new GateError(kind, err.message, { requestId, elapsedMs: err.elapsedMs });
  }
  return new GateError('unknown', err instanceof Error ? err.message : String(err), { requestId });
}
