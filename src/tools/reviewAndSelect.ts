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
 * - If the client does not support elicitation, return a clear
 *   compatibility error — do not pretend a normal tool response is an
 *   interactive confirmation.
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
import { GateError, type ReviewResult } from '../types.js';
import type { Logger } from '../logger.js';

export const ReviewAndSelectInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(32_000)
    .describe('The original prompt to review. This is the user\'s latest message only.'),
  language: z
    .string()
    .max(32)
    .optional()
    .describe('Preferred output language. Omit to keep the original language.'),
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

  const input = ReviewAndSelectInputSchema.parse(rawInput);
  const requestId = randomUUID().slice(0, 8);
  const start = Date.now();

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

    if (ge.kind === 'elicitation_unsupported' || ge.kind === 'invalid_input') {
      return {
        content: [
          {
            type: 'text',
            text:
              'This client does not support interactive elicitation, or the selection was invalid. ' +
              'The prompt was NOT forwarded. Configure a client that supports MCP elicitation, ' +
              'or provide a separately-configured fallback UI, to use this gate tool.',
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
        'exposes an approved prompt. If the client does not support MCP ' +
        'elicitation, the call returns a clear compatibility error.\n' +
        '\n' +
        'CALLING GUIDE (for the LLM):\n' +
        '- ALWAYS pass a short `context` (1-3 sentences) summarizing the ' +
        'conversation/session so far, so the rewrite is grounded in what ' +
        'the user has already said or done. Do not omit it.\n' +
        '- Choose `rewrite_level` to fit the task: `light` for quick one-shot ' +
        'answers, `balanced` (default) for most coding/research work, ' +
        '`detailed` when the user explicitly wants a fully-specified spec.\n' +
        '- Pass `language` only when the user wants the rewritten prompt in ' +
        'a language different from the original.',
      inputSchema: {
        prompt: ReviewAndSelectInputSchema.shape.prompt,
        language: ReviewAndSelectInputSchema.shape.language,
        context: ReviewAndSelectInputSchema.shape.context,
        rewrite_level: ReviewAndSelectInputSchema.shape.rewrite_level,
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
