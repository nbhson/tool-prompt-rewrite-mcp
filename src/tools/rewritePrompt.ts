/**
 * `rewrite_prompt` tool.
 *
 * Generates a rewritten version of the user's prompt. This tool does NOT
 * claim the result is approved — approval is a separate step in
 * `review_and_select_prompt`.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewriteService } from '../rewrite/rewrite.js';
import type { RewriteLevel } from '../types.js';
import type { Logger } from '../logger.js';
import { normalizeGateError } from './gateErrors.js';

export const RewritePromptInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(32_000)
    .describe("The original prompt to rewrite. This is the user's latest message only."),
  language: z
    .string()
    .max(32)
    .optional()
    .describe(
      'Output language of the rewritten prompt, e.g. "vietnamese", "english", ' +
        '"japanese". ALWAYS pass the language the user wrote their prompt in, so ' +
        'the rewrite preserves it. If the user explicitly asks for a different ' +
        'output language (e.g. "answer in English"), pass THAT language instead. ' +
        'Never switch the language on your own judgment — passing "english" to ' +
        '"improve clarity" is a drift. Omit only when the language cannot be ' +
        'determined; the server then auto-detects it.'
    ),
  context: z
    .string()
    .max(8_000)
    .optional()
    .describe(
      '1-3 sentences summarizing the conversation/session so far (what the user has asked, ' +
        'what files/topics are in play, what was decided). STRONGLY RECOMMENDED: pass this ' +
        'on every call so the rewrite is grounded in prior context. Omit only for brand-new ' +
        'sessions with no history.'
    ),
  rewrite_level: z
    .enum(['light', 'balanced', 'detailed'])
    .optional()
    .describe(
      'How much enrichment to apply. "light" = minimal (keep close to original); ' +
        '"balanced" (default) = add missing structure/context/criteria; ' +
        '"detailed" = full spec with acceptance criteria. Pick based on task complexity.'
    ),
});

export type RewritePromptInput = z.infer<typeof RewritePromptInputSchema>;

/**
 * Core handler logic, separated from MCP tool registration so it can be
 * unit-tested without a live MCP server connection (same pattern as
 * `handleReviewAndSelect`).
 */
export async function handleRewritePrompt(
  rewrite: RewriteService,
  log: Logger,
  rawInput: unknown
): Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}> {
  const input = RewritePromptInputSchema.parse(rawInput);
  const requestId = randomUUID().slice(0, 8);
  const start = Date.now();

  try {
    log.info('rewrite_prompt: started', {
      requestId,
      level: input.rewrite_level ?? 'balanced',
      promptLen: input.prompt.length,
    });

    const result = await rewrite.rewrite(input.prompt, {
      level: (input.rewrite_level ?? 'balanced') as RewriteLevel,
      language: input.language,
      context: input.context,
    });

    log.info('rewrite_prompt: done', { requestId, elapsedMs: Date.now() - start });

    const text = [
      `Original:\n${result.originalPrompt}`,
      ``,
      `Rewritten:\n${result.rewrittenPrompt}`,
      ``,
      `Changes: ${result.changesSummary}`,
      result.warnings?.length ? `\nWarnings:\n- ${result.warnings.join('\n- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        original_prompt: result.originalPrompt,
        rewritten_prompt: result.rewrittenPrompt,
        changes_summary: result.changesSummary,
        ...(result.warnings ? { warnings: result.warnings } : {}),
      },
    };
  } catch (err) {
    const ge = normalizeGateError(err, requestId);
    log.error('rewrite_prompt: failed', {
      requestId,
      kind: ge.kind,
      message: ge.message,
      elapsedMs: Date.now() - start,
    });
    return {
      content: [{ type: 'text', text: `Error: ${ge.message}` }],
      isError: true,
      structuredContent: { error: ge.kind, message: ge.message },
    };
  }
}

export function registerRewritePromptTool(server: McpServer, rewrite: RewriteService, log: Logger): void {
  server.registerTool(
    'rewrite_prompt',
    {
      title: 'Prompt Rewrite (no approval)',
      description:
        'Re-emit the given prompt with richer context, structure, and quality ' +
        'criteria. This tool only produces a candidate rewrite; it does NOT ' +
        'approve the result. Use review_and_select_prompt for the gated, ' +
        'user-confirmed flow.\n' +
        '\n' +
        'CALLING GUIDE (for the LLM):\n' +
        '- Pass a short `context` (1-3 sentences) summarizing the ' +
        'conversation/session so far so the enrichment is grounded. Omit it ' +
        'only for brand-new sessions with no history.\n' +
        '- Choose `rewrite_level` to fit the task: `light` for quick one-shot ' +
        'answers, `balanced` (default) for most coding/research work, ' +
        '`detailed` when the user explicitly wants a fully-specified spec.\n' +
        "- ALWAYS pass `language` set to the language of the user's original " +
        'prompt (e.g. "vietnamese"), so the rewrite stays in that language. If ' +
        'the user explicitly asks for a different output language, pass that ' +
        'language instead. Do NOT switch the language on your own judgment — ' +
        'that is a drift.',
      inputSchema: {
        prompt: RewritePromptInputSchema.shape.prompt,
        language: RewritePromptInputSchema.shape.language,
        context: RewritePromptInputSchema.shape.context,
        rewrite_level: RewritePromptInputSchema.shape.rewrite_level,
      },
    },
    async (rawInput) => handleRewritePrompt(rewrite, log, rawInput)
  );
}

