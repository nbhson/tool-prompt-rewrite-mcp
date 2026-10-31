/**
 * Shared error normalization for tool handlers.
 *
 * Maps low-level errors (LLM failures, unknown throws) onto the typed
 * `GateError` taxonomy so every tool returns consistent `error_kind`
 * values in its structured output.
 */

import { LLMError } from '../llm/provider.js';
import { GateError } from '../types.js';

export function normalizeGateError(err: unknown, requestId: string): GateError {
  if (err instanceof GateError) return err;
  if (err instanceof LLMError) {
    // Typed code first (robust); keep a message fallback for LLMErrors
    // constructed without a code (e.g. policy-file errors).
    const kind =
      err.code === 'timeout'
        ? 'llm_timeout'
        : err.code === 'malformed'
          ? 'llm_malformed_output'
          : err.code === 'transient' || err.code === 'fatal'
            ? 'llm_unavailable'
            : err.message.toLowerCase().includes('timed out')
              ? 'llm_timeout'
              : 'llm_unavailable';
    return new GateError(kind, err.message, { requestId, elapsedMs: err.elapsedMs });
  }
  return new GateError('unknown', err instanceof Error ? err.message : String(err), { requestId });
}
