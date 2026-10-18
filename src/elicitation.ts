/**
 * Elicitation helper.
 *
 * Wraps `server.server.elicitInput` so that:
 * - Unsupported elicitation (client not declared the capability) returns
 *   a distinct GateError instead of throwing.
 * - Cancel/decline is mapped to the "cancelled" outcome.
 * - Server-side validation of the returned content is always performed.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GateError } from './types.js';

export interface ElicitationOption {
  value: string;
  title: string;
  description?: string;
}

export type ElicitationResult = { action: 'accept'; chosen: string } | { action: 'cancel' };

/** Which user decision an elicitation is asking for. */
export type ElicitStep = 'level' | 'selection';

/**
 * One elicitation call made by the gate tool. Passed to the (injectable)
 * elicit function so tests can stub the user's answer per step.
 */
export interface ElicitCall {
  step: ElicitStep;
  message: string;
  options: ElicitationOption[];
  requestId: string;
}

/**
 * Ask the user to choose among the given options (e.g. rewrite level, or
 * original / rewritten / cancel) using MCP form elicitation.
 *
 * The schema deliberately uses an `enum` so the client can render a
 * picker; the `selected` field is required so a blank selection is
 * impossible at the schema level.
 */
export async function elicitChoice(server: McpServer, call: ElicitCall): Promise<ElicitationResult> {
  const { message, options, requestId } = call;
  const enumValues = options.map((o) => o.value);

  let result;
  try {
    result = await server.server.elicitInput({
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          selected: {
            type: 'string',
            title: 'Selection',
            description: 'Which prompt to use',
            enum: enumValues,
            oneOf: options.map((o) => ({ const: o.value, title: o.title })),
          },
        },
        required: ['selected'],
      },
    });
  } catch (err) {
    // SDK throws when the client does not support elicitation, or the
    // protocol-level request fails. Both are "unsupported / failed" —
    // return a typed GateError, do not pretend it succeeded.
    const msg = err instanceof Error ? err.message : String(err);
    throw new GateError('elicitation_unsupported', `Elicitation failed: ${msg}`, { requestId });
  }

  if (result.action === 'decline') {
    return { action: 'cancel' };
  }
  if (result.action === 'accept' && result.content) {
    const selected = result.content['selected'];
    // Server-side validation: even though the schema should enforce this,
    // never trust the client blindly.
    if (typeof selected === 'string' && enumValues.includes(selected)) {
      return { action: 'accept', chosen: selected };
    }
    throw new GateError('invalid_input', 'Invalid elicitation response: missing or out-of-enum "selected".', {
      requestId,
    });
  }

  // 'cancelled' action (client aborted) — treat as user cancel, not error.
  return { action: 'cancel' };
}
