/**
 * Shared domain types for the Universal Prompt Gate MCP Server.
 */

/** Per-call rewrite level. Independent of global policy file. */
export type RewriteLevel = 'light' | 'balanced' | 'detailed';

/**
 * Result of a rewrite operation.
 *
 * NOTE: This is NOT an approval. Approval only happens via
 * `review_and_select_prompt` (Option 2 in the user workflow).
 */
export interface RewriteResult {
  originalPrompt: string;
  rewrittenPrompt: string;
  /** Human-readable description of what the LLM changed. */
  changesSummary: string;
  /** Non-fatal observations (e.g. "prompt is short; no enrichment needed"). */
  warnings?: string[];
}

/**
 * Output of `review_and_select_prompt` after user interaction.
 *
 * Exactly one of `status: 'approved'`, `status: 'cancelled'`,
 * `status: 'pending_level_selection'`, or `status: 'pending_user_selection'`.
 * Cancellation MUST NOT expose `selectedPrompt`.
 */
export type ReviewResult =
  | {
      status: 'approved';
      selectedOption: 'original' | 'rewritten';
      selectedPrompt: string;
      originalPrompt: string;
      rewrittenPrompt: string;
    }
  | {
      status: 'cancelled';
      selectedOption: 'cancel';
      selectedPrompt: null;
    }
  | {
      /**
       * The USER must choose the rewrite level first. Returned only when the
       * client does not support MCP elicitation and the text fallback (echo
       * fallback) is enabled. The prompt has NOT been rewritten yet; the
       * agent must re-call the tool with `rewrite_level` after the user picks.
       * The agent must never choose the level for the user.
       */
      status: 'pending_level_selection';
      /** The three valid values the agent may pass on the next call. */
      availableLevels: RewriteLevel[];
    }
  | {
      /**
       * The rewrite is ready but the user has not chosen yet. Returned only
       * when the client does not support MCP elicitation and the text
       * fallback (echo fallback) is enabled. `originalPrompt` /
       * `rewrittenPrompt` are BOTH exposed so the user can compare; the
       * agent must re-call the tool with `selection` after the user picks.
       */
      status: 'pending_user_selection';
      originalPrompt: string;
      rewrittenPrompt: string;
      changesSummary: string;
      warnings?: string[];
      /** The three valid values the agent may pass on the next call. */
      availableSelections: ['original', 'rewritten', 'cancel'];
    };

/** The user's explicit choice, used on the re-invocation of the gate tool. */
export type PromptSelection = 'original' | 'rewritten' | 'cancel';

/** Errors that should be returned as data (not thrown across the MCP boundary). */
export type GateErrorKind =
  | 'invalid_input'
  | 'llm_unavailable'
  | 'llm_timeout'
  | 'llm_malformed_output'
  | 'elicitation_unsupported'
  | 'elicitation_declined'
  | 'cancelled'
  | 'unknown';

/** Distinct protocol-level errors the client must handle explicitly. */
export class GateError extends Error {
  constructor(
    public readonly kind: GateErrorKind,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GateError';
  }
}
