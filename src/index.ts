#!/usr/bin/env node
/**
 * Universal Prompt Gate MCP Server — entry point.
 *
 * Default transport: stdio (for desktop coding agents such as Claude Code,
 * Cursor, Cline, Continue, OpenCode).
 *
 * This file is the public bin. It MUST NOT write to stdout anything other
 * than the MCP protocol — all diagnostics go to stderr / the safe logger.
 *
 * Configuration precedence (highest wins):
 *   1. Real environment variables (incl. those the MCP client passes via
 *      the `env` field of its server config).
 *   2. A `.env` file, searched in this order:
 *      - `PROMPT_GATE_ENV_FILE` (explicit path),
 *      - `.env` in the current working directory,
 *      - `.env` next to this script (works when the MCP client spawns us
 *        from an arbitrary CWD).
 *   3. Built-in defaults.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { createProvider } from './llm/index.js';
import { detectCapabilities, type ClientCapabilities } from './capability/capability.js';
import { registerAllTools } from './tools/index.js';
import { SessionManager } from './session/session.js';
import { loadEnvFile } from './env.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerHandle {
  server: McpServer;
  sessions: SessionManager;
  log: Logger;
}

/**
 * Find a `.env` file to load. Real env vars always win (loadEnvFile never
 * overrides existing keys), so this is safe to call unconditionally.
 */
function findEnvFile(cwd: string, scriptDir: string): string {
  const explicit = process.env.PROMPT_GATE_ENV_FILE?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const cwdFile = join(cwd, '.env');
  if (existsSync(cwdFile)) return cwdFile;
  const scriptFile = join(scriptDir, '..', '.env');
  if (existsSync(scriptFile)) return scriptFile;
  return join(scriptDir, '..', '.env'); // last resort; loadEnvFile no-ops if absent
}

/**
 * Build the MCP server with all tools registered. Exported so tests / the
 * HTTP transport can reuse the exact same composition without stdio.
 */
export async function buildServer(
  configOverride?: Parameters<typeof loadConfig>[0]
): Promise<ServerHandle> {
  const cfg = loadConfig(configOverride);
  const log = createLogger(cfg.logLevel);
  const llm = await createProvider(cfg.llm);
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

  registerAllTools({
    server,
    llm,
    log,
    detectCapabilities: detect,
    llmConfig: cfg.llm,
  });

  // When the client sends initialize, the SDK calls oninitialize; we can't
  // easily override it here, so instead we lazily refresh on first tool call
  // via the session. For now, the conservative default is safe: any
  // client that actually supports elicitation will surface it through the
  // MCP protocol negotiation; we report "false" until then.
  // (TODO: wire real clientCapabilities from the SDK's initialize result.)

  log.info('server: built', {
    transport: cfg.transport,
    model: cfg.llm.model,
    provider: cfg.llm.provider,
  });

  return { server, sessions, log };
}

async function main(): Promise<void> {
  // Auto-load .env BEFORE config is read. Real env (incl. the MCP client's
  // `env` field) always takes precedence.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const envFile = findEnvFile(process.cwd(), scriptDir);
  const result = loadEnvFile({ path: envFile });
  const log = createLogger('info');
  if (result.applied > 0) {
    log.info('env: loaded', { source: result.source, applied: result.applied });
  }

  const { server, log: serverLog } = await buildServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  serverLog.info('server: connected via stdio');
}

main().catch((err) => {
  // stdout is reserved for MCP protocol — all fatal errors go to stderr.
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
