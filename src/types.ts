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
 * Exactly one of `status: 'approved'` or `status: 'cancelled'`.
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
    };

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
