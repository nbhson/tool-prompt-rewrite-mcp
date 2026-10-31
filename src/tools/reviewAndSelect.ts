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
 * - The selection menu offers original / rewritten / UPDATE / cancel.
 *   "update" lets the user request changes (free-text feedback); the tool
 *   rewrites again and loops until the user picks one of the other three.
 * - Cancel NEVER produces an approved prompt.
 * - Errors NEVER silently fall back to the original.
 * - Timeout NEVER auto-selects an option.
 * - When the client does not support elicitation:
 *   - default (PROMPT_GATE_ECHO_FALLBACK=true): return
 *     "pending_level_selection" (level menu) and/or
 *     "pending_user_selection" (original/rewritten/update/cancel menu)
 *     results that render the choices in plain text; the agent asks the
 *     user and re-calls this tool with the user's choice. This is an
 *     EXPLICIT user choice relayed by the agent, not a silent fallback.
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
import {
  elicitChoice,
  type ElicitCall,
  type ElicitationOption,
  type ElicitationResult,
} from '../elicitation.js';
import { GateError, type ReviewResult, type PromptSelection, type RewriteLevel } from '../types.js';
import type { Logger } from '../logger.js';
import type { ClientCapabilities } from '../capability/capability.js';
import { PendingReviewStore, type PendingReview } from '../session/session.js';
import { normalizeGateError } from './gateErrors.js';

export const SELECTION_VALUES: readonly PromptSelection[] = ['original', 'rewritten', 'update', 'cancel'];
export const LEVEL_VALUES: readonly RewriteLevel[] = ['light', 'balanced', 'detailed'];

/** Response shape of the gate tool (loose: structuredContent varies by status). */
export type GateToolResponse = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

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
    .optional()
    .describe(
      '1-3 sentences summarizing the conversation/session so far (what the user has asked, ' +
        'what files/topics are in play, what was decided). STRONGLY RECOMMENDED: pass this ' +
        'on every call so the rewrite is grounded in prior context. Omit only for brand-new ' +
        'sessions with no history.'
    ),
  review_id: z
    .string()
    .min(8)
    .max(64)
    .optional()
    .describe(
      'REQUIRED on every re-call that passes `selection`: the review_id returned in ' +
        'structuredContent of the previous "pending_user_selection" result. The server ' +
        'verifies the re-call against the stored review, so the agent can only approve ' +
        'the exact text the user saw.'
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
    .enum(['original', 'rewritten', 'update', 'cancel'])
    .optional()
    .describe(
      "ONLY for a re-call after a pending_user_selection flow: the user's explicit " +
        'choice after the server could not show an interactive picker. On the first call ' +
        '(rewrite) this must be omitted. Values: "original", "rewritten", "cancel", or ' +
        '"update" (the user wants changes: pass their request in `feedback`; the tool ' +
        'rewrites again and returns a NEW "pending_user_selection"). Never auto-select; ' +
        'pass it only after the user has chosen.'
    ),
  feedback: z
    .string()
    .max(4_000)
    .optional()
    .describe(
      'ONLY with selection="update": the changes the user asked for, in their own ' +
        'words (e.g. "make it shorter", "add acceptance criteria for X", "keep the ' +
        'tone casual"). The tool applies them in the next rewrite. Required when ' +
        'selection="update". Never invent feedback for the user.'
    ),
  rewritten_prompt: z
    .string()
    .max(32_000)
    .optional()
    .describe(
      'The exact rewritten text the user saw. Pass it with `selection`="rewritten" ' +
        '(this is what gets approved — the user approves exactly what they read) and ' +
        'with `selection`="update" (the previous rewrite to revise). Omit on the first call.'
    ),
});

export type ReviewAndSelectInput = z.infer<typeof ReviewAndSelectInputSchema>;

const OPTION_ORIGINAL = 'original';
const OPTION_REWRITTEN = 'rewritten';
const OPTION_UPDATE = 'update';
const OPTION_CANCEL = 'cancel';

/** Defensive cap for revision rounds inside a single tool call. */
const MAX_REVISIONS = 25;

/** Free-text field offered together with the selection options. */
const FEEDBACK_FIELD = {
  title: 'Requested changes (only if you choose "update")',
  description:
    'Describe what should change in the rewritten prompt (e.g. "shorter", ' +
    '"add acceptance criteria for X"). Only used when "update" is selected.',
};

/**
 * The selection options: original / rewritten / UPDATE / cancel. "update"
 * keeps the loop going — the user writes feedback and the prompt is
 * rewritten again until they pick one of the other three.
 */
const SELECTION_OPTIONS: ElicitationOption[] = [
  {
    value: OPTION_ORIGINAL,
    title: 'Use original prompt',
    description: "Keep the user's exact text.",
  },
  {
    value: OPTION_REWRITTEN,
    title: 'Use rewritten prompt',
    description: 'Use the LLM-enriched version.',
  },
  {
    value: OPTION_UPDATE,
    title: 'Update — request changes',
    description:
      'Describe the changes in the text field; the prompt is rewritten again (loop) until you finalize.',
  },
  {
    value: OPTION_CANCEL,
    title: 'Cancel',
    description: 'Abort; do not use either prompt.',
  },
];

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
  /**
   * Server-side store for pending reviews (text-echo fallback). Injected so
   * tests can use an isolated store; defaults to a module-level store.
   */
  pendingReviews?: PendingReviewStore;
}

/** Default store when none is injected (one per server process). */
const defaultPendingReviews = new PendingReviewStore();

export function buildElicitDeps(deps: ReviewDeps) {
  const elicit = deps.elicit ?? ((call: ElicitCall) => elicitChoice(deps.server, call));
  return { ...deps, elicit };
}

/**
 * Core handler logic, separated from MCP tool registration so it can be
 * unit-tested without a live MCP server connection.
 */
export async function handleReviewAndSelect(deps: ReviewDeps, rawInput: unknown): Promise<GateToolResponse> {
  const { elicit } = buildElicitDeps(deps);
  const { log, rewrite } = deps;
  const echoFallback = deps.echoFallback ?? true;
  const detect = deps.detect;
  const pendingReviews = deps.pendingReviews ?? defaultPendingReviews;

  const parsed = ReviewAndSelectInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      content: [
        {
          type: 'text',
          text: `Invalid input for review_and_select_prompt (${issue?.path.join('.') || 'input'}): ${issue?.message ?? 'validation failed'}. Nothing was forwarded.`,
        },
      ],
      isError: true,
      structuredContent: {
        status: 'error',
        error_kind: 'invalid_input',
        message: issue?.message ?? 'validation failed',
        selected_prompt: null,
      },
    };
  }
  const input = parsed.data;
  const requestId = randomUUID().slice(0, 8);
  const start = Date.now();
  /** The verified pending review when the user relayed selection="update". */
  let updateReview: PendingReview | undefined;

  // ── Fast path: re-invocation after pending_user_selection ───────────
  // When the first call returned "pending_user_selection" (the client does
  // not support elicitation), the agent shows the choices to the user, the
  // user picks one, and the agent calls this tool again WITH the user's
  // `selection` and the `review_id` echoed from that pending response. The
  // server verifies the re-call against the STORED review, so the agent can
  // only approve the exact original/rewritten text the user saw — it cannot
  // substitute a different `rewritten_prompt`. For original/rewritten/cancel
  // this path does NOT call the LLM again.
  //
  // "update" is NOT a final choice: the user wants changes, so it must
  // rewrite again. It falls through to the revision flow below.
  if (input.selection) {
    const chosen = input.selection;

    // Integrity: a selection relay must reference a live pending review.
    const review = input.review_id ? pendingReviews.get(input.review_id) : undefined;
    if (!review) {
      log.warn('review_and_select_prompt: selection without a valid review_id', {
        requestId,
        chosen,
        hasReviewId: Boolean(input.review_id),
      });
      return {
        content: [
          {
            type: 'text',
            text:
              'selection requires a valid `review_id` from the previous "pending_user_selection" ' +
              'result (unknown, expired, or missing). The prompt was NOT forwarded. Re-run the ' +
              'gate from the first call, then relay the user\'s choice with the review_id the ' +
              'pending response returned.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'error',
          error_kind: 'invalid_input',
          message: 'selection requires a valid review_id from a pending_user_selection',
          selected_prompt: null,
        },
      };
    }
    // Integrity: the original prompt must be unchanged from the pending review.
    if (input.prompt !== review.originalPrompt) {
      pendingReviews.remove(review.id);
      return {
        content: [
          {
            type: 'text',
            text:
              'The `prompt` does not match the pending review. The prompt was NOT forwarded. ' +
              'Re-run the gate from the first call with the exact original prompt.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'error',
          error_kind: 'invalid_input',
          message: 'prompt does not match the pending review',
          selected_prompt: null,
        },
      };
    }

    log.info('review_and_select_prompt: selection received', {
      requestId,
      chosen,
      promptLen: input.prompt.length,
    });

    // Map the user's explicit choice to the outcome. The rewrite was
    // already produced on the first call; we reuse the STORED review state
    // (original/rewritten/level/context) so the response cannot drift from
    // what the user saw. We do NOT call the LLM again.
    if (chosen === 'cancel') {
      pendingReviews.remove(review.id);
      return {
        content: [
          {
            type: 'text',
            text: 'Prompt gate: user cancelled. No prompt was approved and none was forwarded.',
          },
        ],
        structuredContent: { status: 'cancelled', selected_option: 'cancel', selected_prompt: null },
      };
    }

    // Integrity: an explicitly relayed rewritten_prompt must match the
    // stored version the user saw — the agent cannot substitute its own.
    if (input.rewritten_prompt !== undefined && input.rewritten_prompt !== review.rewrittenPrompt) {
      pendingReviews.remove(review.id);
      return {
        content: [
          {
            type: 'text',
            text:
              'The `rewritten_prompt` does not match the version the user reviewed. ' +
              'The prompt was NOT forwarded. Relay the choice with the review_id and ' +
              'the exact rewritten text from the pending response.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'error',
          error_kind: 'invalid_input',
          message: 'rewritten_prompt does not match the pending review',
          selected_prompt: null,
        },
      };
    }

    if (chosen === 'update') {
      // Not final: the user wants changes. Validation of the reviewed text
      // happened above; the rewrite uses the stored level/language/context.
      updateReview = review;
    } else {
      // "original" / "rewritten" → approved; the loop ends here.
      const result: ReviewResult =
        chosen === 'rewritten'
          ? {
              status: 'approved',
              selectedOption: 'rewritten',
              selectedPrompt: review.rewrittenPrompt,
              originalPrompt: review.originalPrompt,
              rewrittenPrompt: review.rewrittenPrompt,
            }
          : {
              status: 'approved',
              selectedOption: 'original',
              selectedPrompt: review.originalPrompt,
              originalPrompt: review.originalPrompt,
              rewrittenPrompt: review.rewrittenPrompt,
            };
      pendingReviews.remove(review.id);

      const text = `Prompt gate: approved "${result.selectedOption}" prompt.\n\n${result.selectedPrompt}`;

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          status: 'approved',
          selected_option: result.selectedOption,
          selected_prompt: result.selectedPrompt,
          original_prompt: result.originalPrompt,
          rewritten_prompt: result.rewrittenPrompt,
        },
      };
    }
  }

  log.info('review_and_select_prompt: started', { requestId, promptLen: input.prompt.length });

  // ── Shared state: the current (re)write candidate ───────────────────
  // These always describe the LATEST round: the first rewrite, or the
  // revision produced after the user picked "update". The review loop
  // re-reads them on every round.
  let level: RewriteLevel;
  let original = input.prompt;
  let rewritten = input.prompt;
  let changesSummary = 'No rewrite was attempted.';
  let warnings: string[] | undefined;
  let revisionCount = 0;

  /**
   * Run one rewrite round. Returns an error response to early-return, or
   * null on success (state updated in place). When `feedback` is set this
   * is a revision round: the LLM revises `previousRewrite` (normally the
   * rewrite the user just reviewed) following the user's requested changes.
   */
  const doRewrite = async (feedback?: string, previousRewrite?: string): Promise<GateToolResponse | null> => {
    try {
      const r = await rewrite.rewrite(input.prompt, {
        level,
        language: input.language,
        context: input.context,
        feedback,
        previousRewrite,
      });
      original = r.originalPrompt;
      rewritten = r.rewrittenPrompt;
      changesSummary = r.changesSummary;
      warnings = r.warnings;
      return null;
    } catch (err) {
      const ge = normalizeGateError(err, requestId);
      log.error('review_and_select_prompt: rewrite failed', {
        requestId,
        kind: ge.kind,
        message: ge.message,
        revision: Boolean(feedback),
        elapsedMs: Date.now() - start,
      });
      return {
        content: [
          {
            type: 'text',
            text: feedback
              ? `Prompt gate failed while applying the requested changes: ${ge.message}`
              : `Prompt gate failed before user selection: ${ge.message}`,
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
  };

  /**
   * Step 3: user review loop. Shows the original + current rewrite with the
   * original / rewritten / update / cancel options.
   *
   * - "original" / "rewritten" → approved; the loop ends.
   * - "cancel" (or dialog abort) → cancelled; the loop ends.
   * - "update" → the user's free-text feedback triggers another rewrite
   *   round (same level) and the loop shows the new version again.
   *
   * When the client cannot show elicitation, the echo fallback returns
   * "pending_user_selection" and the agent relays the choice through
   * `selection` (+ `feedback` for update); each relayed update round
   * re-enters this same loop.
   */
  const selectionLoop = async (): Promise<GateToolResponse> => {
    let emptyFeedbackRounds = 0;
    let revisionNote: string | undefined;

    for (;;) {
      const message = [
        revisionCount > 0
          ? `Review the original prompt and the revised rewrite (revision ${revisionCount}), then choose one:`
          : 'Review the original prompt and the rewritten prompt, then choose one:',
        '',
        '--- ORIGINAL ---',
        original,
        '',
        '--- REWRITTEN ---',
        rewritten,
        '',
        `Changes: ${changesSummary}`,
        warnings?.length ? `Warnings: ${warnings.join('; ')}` : '',
        revisionNote ?? '',
        '',
        'To request changes instead, choose "update" and describe them in the text field.',
      ]
        .filter(Boolean)
        .join('\n');

      let outcome: ElicitationResult;
      try {
        outcome = await elicit({
          step: 'selection',
          message,
          options: SELECTION_OPTIONS,
          requestId,
          feedback: FEEDBACK_FIELD,
        });
      } catch (err) {
        const ge = err instanceof GateError ? err : new GateError('unknown', String(err), { requestId });
        log.warn('review_and_select_prompt: elicitation issue', { requestId, kind: ge.kind });

        // Elicitation unsupported (client did not declare the capability, or
        // the request was refused by the protocol). Two behaviors:
        //
        // 1. echoFallback=true (default): return a distinct
        //    "pending_user_selection" result that renders the numbered
        //    choices in plain text and instructs the agent to re-call this
        //    tool with the user's `selection`. This is an EXPLICIT user
        //    choice relayed by the agent — not a silent fallback, not an
        //    auto-select. "update" loops: selecting it with `feedback`
        //    rewrites again and returns a NEW pending_user_selection.
        //
        // 2. echoFallback=false (strict): hard compatibility error, as before.
        if (ge.kind === 'elicitation_unsupported' && echoFallback) {
          const supports = detect ? detect().elicitationSupported : false;
          // Store the pending review server-side: the re-call must carry its
          // review_id, and only the stored rewritten/original text can be
          // approved (the agent cannot substitute a different text).
          const reviewId = pendingReviews.create({
            originalPrompt: original,
            rewrittenPrompt: rewritten,
            changesSummary,
            warnings,
            level,
            language: input.language,
            context: input.context,
            revisionCount,
          });
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
            revisionCount > 0
              ? `(Revised ${revisionCount} time(s) following the user's requested changes.)`
              : '',
            '',
            `Changes: ${changesSummary}`,
            warnings?.length ? `Warnings: ${warnings.join('; ')}` : '',
            '',
            'REPLY TO THE USER: "Which should be used?", with these numbered options:',
            "[1] original — use the user's exact text",
            '[2] rewritten — use the LLM-enriched version',
            '[3] update — request changes: describe what to adjust, then the prompt is rewritten again',
            '[4] cancel — use neither; abort the prompt gate',
            '',
            'When the user answers, call review_and_select_prompt again with the ' +
              'SAME prompt/context/rewrite_level/language, `selection` set to:',
            '- "original" or "rewritten" — to finalize;',
            '- "cancel" — to abort;',
            '- "update" — PLUS `feedback` with the requested changes; the tool then ' +
              'rewrites again and returns a NEW pending_user_selection to review. ' +
              'Repeat until the user picks original, rewritten, or cancel.',
            'ALWAYS pass review_id="' +
              reviewId +
              '" (returned here in structuredContent) — re-calls with `selection` ' +
              'without it are rejected. Never pick for the user.',
          ]
            .filter(Boolean)
            .join('\n');
          return {
            content: [{ type: 'text', text: menu }],
            structuredContent: {
              status: 'pending_user_selection',
              review_id: reviewId,
              original_prompt: original,
              rewritten_prompt: rewritten,
              changes_summary: changesSummary,
              ...(warnings?.length ? { warnings } : {}),
              available_selections: ['original', 'rewritten', 'update', 'cancel'],
              revision_count: revisionCount,
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
          structuredContent: {
            status: 'error',
            error_kind: ge.kind,
            message: ge.message,
            selected_prompt: null,
          },
        };
      }

      log.info('review_and_select_prompt: user chose', {
        requestId,
        action: outcome.action,
        chosen: outcome.action === 'accept' ? outcome.chosen : 'n/a',
        elapsedMs: Date.now() - start,
      });

      // The user picked the explicit "cancel" option, or aborted the dialog.
      if (outcome.action === 'cancel' || outcome.chosen === OPTION_CANCEL) {
        return {
          content: [
            {
              type: 'text',
              text: 'Prompt gate: user cancelled. No prompt was approved and none was forwarded.',
            },
          ],
          structuredContent: { status: 'cancelled', selected_option: 'cancel', selected_prompt: null },
        };
      }

      // "update": the user wants changes. Apply the feedback and loop.
      if (outcome.chosen === OPTION_UPDATE) {
        const feedback = (outcome.feedback ?? '').trim();
        if (!feedback) {
          emptyFeedbackRounds += 1;
          if (emptyFeedbackRounds > 1) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'The user chose "update" but did not describe the changes. ' +
                    'Nothing was forwarded; ask the user for the changes and re-run the gate.',
                },
              ],
              isError: true,
              structuredContent: {
                status: 'error',
                error_kind: 'invalid_input',
                message: 'update selected without feedback',
                selected_prompt: null,
              },
            };
          }
          revisionNote =
            'You chose "update" but did not describe the changes yet — write them in ' +
            'the text field and choose "update" again.';
          continue;
        }

        if (revisionCount >= MAX_REVISIONS) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Reached the revision limit (${MAX_REVISIONS}) for a single gate call. ` +
                  'Ask the user to finalize: "original", "rewritten", or "cancel".',
              },
            ],
            isError: true,
            structuredContent: {
              status: 'error',
              error_kind: 'revision_limit',
              message: `revision limit (${MAX_REVISIONS}) reached`,
              selected_prompt: null,
            },
          };
        }

        emptyFeedbackRounds = 0;
        revisionNote = undefined;
        revisionCount += 1;
        log.info('review_and_select_prompt: revision requested', { requestId, revision: revisionCount });
        const failed = await doRewrite(feedback, rewritten);
        if (failed) return failed;
        continue;
      }

      // "original" / "rewritten" → approved; the loop ends here.
      const result: ReviewResult =
        outcome.chosen === OPTION_REWRITTEN
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

      const text = `Prompt gate: approved "${result.selectedOption}" prompt.\n\n${result.selectedPrompt}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          status: 'approved',
          selected_option: result.selectedOption,
          selected_prompt: result.selectedPrompt,
          original_prompt: result.originalPrompt,
          rewritten_prompt: result.rewrittenPrompt,
        },
      };
    }
  };

  // ── "update" relay (text fallback): the user asked for changes ──────
  // The previous call returned pending_user_selection, the user picked
  // "update", and the agent relays their feedback here. This is NOT a
  // final choice, so we rewrite again (revising the text the user saw)
  // and re-enter the review loop. The level/language/context come from
  // the STORED review (the user's own choices), never from agent input.
  if (input.selection === OPTION_UPDATE) {
    // Unreachable unless the fast path above verified the review — kept
    // as a defensive check so TS narrowing and runtime agree.
    if (!updateReview) {
      return {
        content: [
          {
            type: 'text',
            text:
              'selection="update" requires a valid `review_id` from a "pending_user_selection" ' +
              'result. Nothing was forwarded.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'error',
          error_kind: 'invalid_input',
          message: 'selection="update" requires a valid review_id',
          selected_prompt: null,
        },
      };
    }
    const feedback = input.feedback?.trim();
    if (!feedback) {
      return {
        content: [
          {
            type: 'text',
            text:
              'selection="update" requires `feedback` describing the changes the user ' +
              'asked for. Nothing was forwarded.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'error',
          error_kind: 'invalid_input',
          message: 'feedback is required when selection="update"',
          selected_prompt: null,
        },
      };
    }
    if (updateReview.revisionCount >= MAX_REVISIONS) {
      pendingReviews.remove(updateReview.id);
      return {
        content: [
          {
            type: 'text',
            text:
              `Reached the revision limit (${MAX_REVISIONS}) for this review. ` +
              'Ask the user to finalize: "original", "rewritten", or "cancel".',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'error',
          error_kind: 'revision_limit',
          message: `revision limit (${MAX_REVISIONS}) reached`,
          selected_prompt: null,
        },
      };
    }

    level = updateReview.level;
    log.info('review_and_select_prompt: revision requested (relay)', {
      requestId,
      level,
      revision: updateReview.revisionCount + 1,
      feedbackLen: feedback.length,
    });
    const failed = await doRewrite(feedback, updateReview.rewrittenPrompt);
    if (failed) return failed;
    pendingReviews.remove(updateReview.id); // replaced by a NEW entry in the pending response
    revisionCount = updateReview.revisionCount + 1;

    return await selectionLoop();
  }

  // ── Step 1: the USER chooses the rewrite level (mandatory) ──────────
  // The agent must never decide the level for the gate flow. When the
  // client supports elicitation we always show the picker (any
  // agent-provided `rewrite_level` is ignored). When it does not, the
  // text fallback returns "pending_level_selection"; the agent asks the
  // user and relays their choice back in `rewrite_level` on the next
  // call. `rewrite_level` is a RELAY channel for the user's choice, not
  // an agent-decided setting.

  const levelMessage =
    'Choose how much to enrich the prompt. The prompt will be rewritten at ' +
    'this level; you will then pick between the original and the rewritten ' +
    'version — or request changes to the rewrite.';

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
  // distinct error outcome (see doRewrite).
  const failed = await doRewrite();
  if (failed) return failed;

  return await selectionLoop();
}

export function registerReviewAndSelectTool(deps: ReviewDeps): void {
  const { server } = deps;
  server.registerTool(
    'review_and_select_prompt',
    {
      title: 'Prompt Gate (user-confirmed)',
      description:
        'Generates a rewritten version of the prompt, then asks the user to ' +
        'choose: use original, use rewritten, request changes (update), or ' +
        'cancel. Returns only the approved prompt. Cancellation is a distinct ' +
        'outcome and never exposes an approved prompt.\n' +
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
        'shows both versions in plain text with the numbered choices and asks ' +
        "the agent to re-call this tool with `selection` set to the user's " +
        'choice ("original" / "rewritten" / "update" / "cancel"). Choosing ' +
        '"update" is not final: pass the user\'s requested changes in ' +
        '`feedback`, the tool rewrites again and returns a NEW ' +
        '"pending_user_selection" to review. Repeat until the user picks ' +
        'original, rewritten, or cancel. Never auto-select.\n' +
        '\n' +
        'CALLING GUIDE (for the LLM):\n' +
        '- FIRST call: pass prompt (+ optional context and language); do NOT pass ' +
        '`rewrite_level` and do NOT pass `selection` — the user chooses ' +
        'the level. ALWAYS pass a short `context` (1-3 sentences) ' +
        'summarizing the conversation so far.\n' +
        '- If a call returns status "pending_level_selection": ask the user ' +
        'which level to use, then call again with the SAME inputs PLUS ' +
        '`rewrite_level` set to "light", "balanced", or "detailed" ' +
        'matching their choice.\n' +
        '- If a call returns status "pending_user_selection": show the two ' +
        'versions to the user, ask which to use, then call again with the ' +
        'SAME inputs PLUS `review_id` (echoed in structuredContent of the ' +
        'pending result — REQUIRED) and `selection` set to "original", ' +
        '"rewritten", or "cancel" matching the user\'s choice. If the user ' +
        'wants changes instead ("update"), call again with `review_id`, ' +
        '`selection: "update"` PLUS `feedback` containing their requested ' +
        'changes; the tool replies with a new "pending_user_selection". ' +
        'Loop until the user picks original, rewritten, or cancel — never ' +
        'decide for them.\n' +
        "- ALWAYS pass `language` set to the language of the user's original " +
        'prompt (e.g. "vietnamese"), so the rewrite stays in that language. If ' +
        'the user explicitly asks for a different output language, pass that ' +
        'language instead. Do NOT switch the language on your own judgment — ' +
        'that is a drift.',
      inputSchema: {
        prompt: ReviewAndSelectInputSchema.shape.prompt,
        language: ReviewAndSelectInputSchema.shape.language,
        context: ReviewAndSelectInputSchema.shape.context,
        review_id: ReviewAndSelectInputSchema.shape.review_id,
        rewrite_level: ReviewAndSelectInputSchema.shape.rewrite_level,
        selection: ReviewAndSelectInputSchema.shape.selection,
        rewritten_prompt: ReviewAndSelectInputSchema.shape.rewritten_prompt,
        feedback: ReviewAndSelectInputSchema.shape.feedback,
      },
    },
    async (rawInput) => handleReviewAndSelect(deps, rawInput)
  );
}

