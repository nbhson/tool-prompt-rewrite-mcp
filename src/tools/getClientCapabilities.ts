/**
 * `get_client_capabilities` tool.
 *
 * Reports which interaction features are available for the current client
 * or session. Based only on verified protocol negotiation and config.
 * Never infers from the agent's name.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClientCapabilities } from '../capability/capability.js';
import type { Logger } from '../logger.js';

/**
 * Core handler logic, separated from MCP tool registration so it can be
 * unit-tested without a live MCP server connection.
 */
export function handleGetClientCapabilities(
  detect: () => ClientCapabilities,
  log: Logger
): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const caps = detect();
  log.info('get_client_capabilities', {
    elicitation: caps.elicitationSupported,
    structured: caps.structuredElicitationSupported,
    transport: caps.transport,
    mode: caps.integrationMode,
    mandatory: caps.mandatoryGatingEnforceable,
  });
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(caps, null, 2),
      },
    ],
    structuredContent: {
      elicitation_supported: caps.elicitationSupported,
      structured_elicitation_supported: caps.structuredElicitationSupported,
      transport: caps.transport,
      integration_mode: caps.integrationMode,
      mandatory_gating_enforceable: caps.mandatoryGatingEnforceable,
    },
  };
}

/**
 * Build a factory for the capabilities tool. The `detect` function is
 * injected so tests can stub out the real protocol negotiation.
 */
export function registerGetClientCapabilitiesTool(
  server: McpServer,
  detect: () => ClientCapabilities,
  log: Logger
): void {
  server.registerTool(
    'get_client_capabilities',
    {
      title: 'Client Capabilities',
      description:
        'Reports which interaction features are available for the current MCP ' +
        'client/session: elicitation support, structured elicitation, transport, ' +
        'integration mode, and whether a mandatory prompt gate is enforceable. ' +
        'Capabilities are derived from verified protocol negotiation, not ' +
        'from the agent name.',
      inputSchema: {},
    },
    async () => handleGetClientCapabilities(detect, log)
  );
}
