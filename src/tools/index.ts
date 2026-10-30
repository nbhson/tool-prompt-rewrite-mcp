/**
 * Tool registration — wires the three MCP tools to the underlying services.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LLMProvider } from '../llm/provider.js';
import type { LLMConfig } from '../config.js';
import { RewriteService } from '../rewrite/rewrite.js';
import type { ClientCapabilities } from '../capability/capability.js';
import type { Logger } from '../logger.js';
import { registerRewritePromptTool } from './rewritePrompt.js';
import { registerReviewAndSelectTool, type ReviewDeps } from './reviewAndSelect.js';
import { registerGetClientCapabilitiesTool } from './getClientCapabilities.js';
import { PendingReviewStore } from '../session/session.js';

export interface ToolDeps {
  server: McpServer;
  llm: LLMProvider;
  log: Logger;
  /** Returns verified client capabilities for the current session. */
  detectCapabilities: () => ClientCapabilities;
  /** Optional injection point for tests to stub the elicitation step. */
  reviewDeps?: Partial<ReviewDeps>;
  /** LLM config, used to configure retry behavior for the rewrite service. */
  llmConfig?: LLMConfig;
  /** Global default policy file (from PROMPT_GATE_REWRITE_POLICY_FILE). */
  policyFile?: string;
  /**
   * Whether the text-echo fallback is enabled when the client does not
   * support elicitation (from PROMPT_GATE_ECHO_FALLBACK). Default true.
   */
  echoFallback?: boolean;
}

export function registerAllTools(deps: ToolDeps): void {
  const retryMax = deps.llmConfig?.retryMax ?? 3;
  const rewrite = new RewriteService(deps.llm, retryMax, deps.policyFile);
  registerRewritePromptTool(deps.server, rewrite, deps.log);

  const reviewDeps: ReviewDeps = {
    server: deps.server,
    rewrite,
    log: deps.log,
    detect: deps.detectCapabilities,
    echoFallback: deps.echoFallback ?? true,
    // One store per server process: pending reviews are verified on re-calls
    // so the agent can only approve the exact text the user saw.
    pendingReviews: new PendingReviewStore(),
    ...(deps.reviewDeps ?? {}),
  };
  registerReviewAndSelectTool(reviewDeps);

  registerGetClientCapabilitiesTool(deps.server, deps.detectCapabilities, deps.log);
}

export { registerRewritePromptTool, registerReviewAndSelectTool, registerGetClientCapabilitiesTool };
