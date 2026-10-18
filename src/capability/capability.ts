/**
 * Client capability detection.
 *
 * Principle: never infer capabilities from the agent's name.
 * Report only what was actually negotiated via the MCP protocol
 * (initialization result) and what this server's configuration allows.
 */

export interface ClientCapabilities {
  /** Elicitation capability declared by the client. */
  elicitationSupported: boolean;
  /** Whether the client declares structured elicitation support. */
  structuredElicitationSupported: boolean;
  /** Transport in use. */
  transport: 'stdio' | 'http';
  /** Integration mode: "standard" (explicit tool call), "hook", or "none". */
  integrationMode: 'standard' | 'hook' | 'none';
  /**
   * Whether a mandatory prompt gate (interception of every prompt) can
   * actually be enforced against THIS client.
   *
   * This is true only when:
   * - the client supports elicitation, AND
   * - the client is wired through a hook / integration that routes every
   *   prompt through this server (agent-specific, not universal).
   *
   * Default: false unless the agent explicitly declares a hook integration.
   */
  mandatoryGatingEnforceable: boolean;
}

/**
 * Build capability report from the MCP `initialize` result.
 *
 * The client capabilities object in the MCP protocol declares what the
 * client supports. We only use verified fields.
 */
export function detectCapabilities(clientCaps: unknown): ClientCapabilities {
  const base: ClientCapabilities = {
    elicitationSupported: false,
    structuredElicitationSupported: false,
    transport: 'stdio',
    integrationMode: 'standard',
    mandatoryGatingEnforceable: false,
  };

  if (typeof clientCaps === 'object' && clientCaps !== null) {
    const obj = clientCaps as Record<string, unknown>;

    const el = obj.elicitation;
    if (typeof el === 'object' && el !== null) {
      base.elicitationSupported = true;
      const form = (el as Record<string, unknown>).form;
      if (typeof form === 'object' && form !== null) {
        base.structuredElicitationSupported = true;
      }
    }
  }

  return base;
}
