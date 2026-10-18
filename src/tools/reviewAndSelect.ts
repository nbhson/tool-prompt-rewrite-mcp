/**
 * `review_and_select_prompt` — the gate tool.
 *
 * Generates a rewrite, shows both versions to the user via MCP elicitation,
 * and returns ONLY the approved prompt (or a distinct "cancelled" outcome).
 *
 * Hard rules (from spec):
 * - The USER chooses the rewrite level (light/balanced/detailed) — the
 *   agent must not decide it. With elicitation, an interactive picker is
 *   shown before the rewrite; without it, the text fallback returns
 *   "pending_level_selection" and the agent relays the user's choice in
 *   `rewrite_level`.
 * - Cancel NEVER produces an approved prompt.
 * - Errors NEVER silently fall back to the original.
 * - Timeout NEVER auto-selects an option.
 * - When the client does not support elicitation:
 *   - default (PROMPT_GATE_ECHO_FALLBACK=true): return
 *     "pending_level_selection" (level menu) and/or
 *     "pending_user_selection" (original/rewritten/cancel menu) results
 *     that render the choices in plain text; the agent asks the user and
 *     re-calls this tool with the user's choice. This is an EXPLICIT user
 *     choice relayed by the agent, not a silent fallback.
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
import {
  elicitChoice,
  type ElicitCall,
  type ElicitationOption,
  type ElicitationResult,
} from '../elicitation.js';
import { GateError, type ReviewResult, type PromptSelection, type RewriteLevel } from '../types.js';
import type { Logger } from '../logger.js';
import type { ClientCapabilities } from '../capability/capability.js';

export const SELECTION_VALUES: readonly PromptSelection[] = ['original', 'rewritten', 'cancel'];
export const LEVEL_VALUES: readonly RewriteLevel[] = ['light', 'balanced', 'detailed'];

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
      'Output language of the rewritten prompt, e.g. "vietnamese", "english", ' +
        '"japanese". ALWAYS pass the language the user wrote their prompt in, so ' +
        'the rewrite preserves it. If the user explicitly asks for a different ' +
        'output language (e.g. "answer in English"), pass THAT language instead. ' +
        'Never switch the language on your own judgment — passing "english" to ' +
        '"improve clarity" is a drift. Omit only when the language cannot be ' +
        'determined; the server then auto-detects it.'
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
      'The enrichment level used for the rewrite. The USER chooses it via an ' +
        'interactive picker (or via the "pending_level_selection" text menu when ' +
        'the client has no elicitation), so do NOT pass it on the first call. ' +
        "Only pass it to relay the user's explicit choice on the call AFTER a " +
        '"pending_level_selection" result: "light" (minimal), "balanced" (adds ' +
        'structure/context/criteria), or "detailed" (full spec with acceptance ' +
        'criteria).'
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

/**
 * The level picker options. The user MUST pick one of these before the
 * rewrite happens — the agent never decides the level in the gate flow.
 */
const LEVEL_OPTIONS: ElicitationOption[] = [
  {
    value: 'light',
    title: 'Light',
    description: 'Minimal changes; keep the rewrite close to the original.',
  },
  {
    value: 'balanced',
    title: 'Balanced (default)',
    description: 'Add missing structure, context, and quality criteria.',
  },
  {
    value: 'detailed',
    title: 'Detailed',
    description: 'Full spec with acceptance criteria and edge cases.',
  },
];

export interface ReviewDeps {
  server: McpServer;
  rewrite: RewriteService;
  log: Logger;
  /** Injectable so tests can stub user choices without a real client. */
  elicit?: (call: ElicitCall) => Promise<ElicitationResult>;
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
  const elicit = deps.elicit ?? ((call: ElicitCall) => elicitChoice(deps.server, call));
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

  // ── Step 1: the USER chooses the rewrite level (mandatory) ──────────
  // The agent must never decide the level for the gate flow. When the
  // client supports elicitation we always show the picker (any
  // agent-provided `rewrite_level` is ignored). When it does not, the
  // text fallback returns "pending_level_selection"; the agent asks the
  // user and relays their choice back in `rewrite_level` on the next
  // call. `rewrite_level` is a RELAY channel for the user's choice, not
  // an agent-decided setting.
  let level: RewriteLevel;

  const levelMessage =
    'Choose how much to enrich the prompt. The prompt will be rewritten at ' +
    'this level; you will then pick between the original and the rewritten ' +
    'version.';

  try {
    const levelOutcome = await elicit({
      step: 'level',
      message: levelMessage,
      options: LEVEL_OPTIONS,
      requestId,
    });
    if (levelOutcome.action === 'cancel') {
      log.info('review_and_select_prompt: cancelled at level picker', { requestId });
      return {
        content: [
          {
            type: 'text',
            text:
              'Prompt gate: user cancelled at the rewrite-level step. ' +
              'No prompt was approved and none was forwarded.',
          },
        ],
        structuredContent: { status: 'cancelled', selected_option: 'cancel', selected_prompt: null },
      };
    }
    level = levelOutcome.chosen as RewriteLevel;
    log.info('review_and_select_prompt: level chosen', { requestId, level, source: 'picker' });
  } catch (err) {
    const ge = err instanceof GateError ? err : new GateError('unknown', String(err), { requestId });
    log.warn('review_and_select_prompt: level elicitation issue', { requestId, kind: ge.kind });

    if (ge.kind === 'elicitation_unsupported' && echoFallback && input.rewrite_level) {
      // Text fallback: the agent is relaying the user's explicit choice
      // from a previous `pending_level_selection` result. Proceed to the
      // rewrite; the selection step below uses the same text fallback.
      level = input.rewrite_level;
      log.info('review_and_select_prompt: level chosen', { requestId, level, source: 'relay' });
    } else if (ge.kind === 'elicitation_unsupported' && echoFallback) {
      // Text fallback, first step: the user must still choose the level.
      const supports = detect ? detect().elicitationSupported : false;
      const menu = [
        'The client does not support MCP elicitation, so an interactive picker ' +
          'cannot be shown. Ask the user which rewrite level to use. The prompt ' +
          'has NOT been rewritten yet.',
        '',
        'REPLY TO THE USER: "Which rewrite level should be used?", with these numbered options:',
        '[1] light — minimal changes; keep close to the original',
        '[2] balanced — add missing structure, context, and quality criteria',
        '[3] detailed — full spec with acceptance criteria',
        '',
        'When the user answers, call review_and_select_prompt again with the ' +
          "SAME prompt/context/language plus `rewrite_level` set to the user's " +
          'choice ("light" / "balanced" / "detailed"). Never pick for the user.',
      ].join('\n');
      return {
        content: [{ type: 'text', text: menu }],
        structuredContent: {
          status: 'pending_level_selection',
          available_levels: ['light', 'balanced', 'detailed'],
          client_elicitation_supported: supports,
          request_id: requestId,
        },
      };
    } else if (ge.kind === 'elicitation_unsupported' || ge.kind === 'invalid_input') {
      return {
        content: [
          {
            type: 'text',
            text:
              'This client does not support interactive elicitation, or the ' +
              'choice was invalid. The prompt was NOT forwarded. Set ' +
              'PROMPT_GATE_ECHO_FALLBACK=true to enable the text fallback ' +
              '(default), or configure a client that supports MCP elicitation.',
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
    } else {
      return {
        content: [{ type: 'text', text: `Elicitation error: ${ge.message}` }],
        isError: true,
        structuredContent: {
          status: 'error',
          error_kind: ge.kind,
          message: ge.message,
          selected_prompt: null,
        },
      };
    }
  }

  // ── Step 2: generate the rewrite AT THE LEVEL THE USER CHOSE ────────
  // On LLM failure we do NOT fall back to original — we surface a
  // distinct error outcome.
  let original = input.prompt;
  let rewritten = input.prompt;
  let changesSummary = 'No rewrite was attempted.';
  let warnings: string[] | undefined;

  try {
    const r = await rewrite.rewrite(input.prompt, {
      level,
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

  // 3. Show both versions and ask the user to choose.
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
    outcome = await elicit({ step: 'selection', message, options, requestId });
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

  // 4. Map to ReviewResult.
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
        'Before the rewrite, the USER chooses the enrichment level ' +
        '(`rewrite_level`: light / balanced / detailed) via an interactive ' +
        'picker — the agent must not choose it. If the client does not ' +
        'support MCP elicitation, the tool returns a distinct ' +
        '"pending_level_selection" result with the level menu in plain text; ' +
        'ask the user, then re-call with the SAME inputs PLUS ' +
        '`rewrite_level` set to their choice. Never pick for the user.\n' +
        '\n' +
        'After the rewrite, if the client does not support MCP elicitation, ' +
        'the tool returns a distinct "pending_user_selection" result: it ' +
        'shows both versions in plain text with the three numbered choices ' +
        'and asks the agent to re-call this tool with `selection` set to ' +
        'the user\'s choice ("original" / "rewritten" / "cancel"). Never ' +
        'auto-select.\n' +
        '\n' +
        'CALLING GUIDE (for the LLM):\n' +
        '- FIRST call: pass prompt + context (+ language); do NOT pass ' +
        '`rewrite_level` and do NOT pass `selection` — the user chooses ' +
        'the level. ALWAYS pass a short `context` (1-3 sentences) ' +
        'summarizing the conversation so far.\n' +
        '- If a call returns status "pending_level_selection": ask the user ' +
        'which level to use, then call again with the SAME inputs PLUS ' +
        '`rewrite_level` set to "light", "balanced", or "detailed" ' +
        'matching their choice.\n' +
        '- If a call returns status "pending_user_selection": show the two ' +
        'versions to the user, ask which to use, then call again with the ' +
        'SAME inputs PLUS `selection` set to "original", "rewritten", or ' +
        '"cancel" matching the user\'s choice.\n' +
        "- ALWAYS pass `language` set to the language of the user's original " +
        'prompt (e.g. "vietnamese"), so the rewrite stays in that language. If ' +
        'the user explicitly asks for a different output language, pass that ' +
        'language instead. Do NOT switch the language on your own judgment — ' +
        'that is a drift.',
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
