/**
 * Tool registration — wires the three MCP tools to the underlying services.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LLMProvider } from '../llm/provider.js';
import { RewriteService } from '../rewrite/rewrite.js';
import type { ClientCapabilities } from '../capability/capability.js';
import type { Logger } from '../logger.js';
import { registerRewritePromptTool } from './rewritePrompt.js';
import { registerReviewAndSelectTool, type ReviewDeps } from './reviewAndSelect.js';
import { registerGetClientCapabilitiesTool } from './getClientCapabilities.js';

export interface ToolDeps {
  server: McpServer;
  llm: LLMProvider;
  log: Logger;
  /** Returns verified client capabilities for the current session. */
  detectCapabilities: () => ClientCapabilities;
  /** Optional injection point for tests to stub the elicitation step. */
  reviewDeps?: Partial<ReviewDeps>;
}

export function registerAllTools(deps: ToolDeps): void {
  const rewrite = new RewriteService(deps.llm);
  registerRewritePromptTool(deps.server, rewrite, deps.log);

  const reviewDeps: ReviewDeps = {
    server: deps.server,
    rewrite,
    log: deps.log,
    ...(deps.reviewDeps ?? {}),
  };
  registerReviewAndSelectTool(reviewDeps);

  registerGetClientCapabilitiesTool(deps.server, deps.detectCapabilities, deps.log);
}

export { registerRewritePromptTool, registerReviewAndSelectTool, registerGetClientCapabilitiesTool };
