#!/usr/bin/env node
/**
 * Universal Prompt Gate MCP Server — entry point.
 *
 * Default transport: stdio (for desktop coding agents such as Claude Code,
 * Cursor, Cline, Continue, OpenCode).
 *
 * This file is the public bin. It MUST NOT write to stdout anything other
 * than the MCP protocol — all diagnostics go to stderr / the safe logger.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { createProvider } from './llm/index.js';
import { detectCapabilities, type ClientCapabilities } from './capability/capability.js';
import { registerAllTools } from './tools/index.js';
import { SessionManager } from './session/session.js';

export interface ServerHandle {
  server: McpServer;
  sessions: SessionManager;
  log: Logger;
}

/**
 * Build the MCP server with all tools registered. Exported so tests / the
 * HTTP transport can reuse the exact same composition without stdio.
 */
export function buildServer(configOverride?: Parameters<typeof loadConfig>[0]): ServerHandle {
  const cfg = loadConfig(configOverride);
  const log = createLogger(cfg.logLevel);
  const llm = createProvider(cfg.llm);
  const sessions = new SessionManager();
  const sessionId = sessions.newSession();

  const server = new McpServer(
    { name: 'universal-prompt-gate-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // Capability detection uses the client's declared capabilities once the
  // protocol is initialized. Until then we report the conservative default
  // (no elicitation, no mandatory gating). This is the "no unverified
  // claims" principle.
  const caps = {
    current: detectCapabilities({}),
    sessionId,
  };

  const detect = (): ClientCapabilities => caps.current;

  registerAllTools({ server, llm, log, detectCapabilities: detect });

  // When the client sends initialize, the SDK calls oninitialize; we can't
  // easily override it here, so instead we lazily refresh on first tool call
  // via the session. For now, the conservative default is safe: any
  // client that actually supports elicitation will surface it through the
  // MCP protocol negotiation; we report "false" until then.
  // (TODO: wire real clientCapabilities from the SDK's initialize result.)

  log.info('server: built', { transport: cfg.transport, model: cfg.llm.model });

  return { server, sessions, log };
}

async function main(): Promise<void> {
  const { server, log } = buildServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('server: connected via stdio');
}

main().catch((err) => {
  // stdout is reserved for MCP protocol — all fatal errors go to stderr.
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
