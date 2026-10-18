/**
 * `rewrite_prompt` tool.
 *
 * Generates a rewritten version of the user's prompt. This tool does NOT
 * claim the result is approved — approval is a separate step in
 * `review_and_select_prompt`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewriteService } from '../rewrite/rewrite.js';
import { LLMError } from '../rewrite/rewrite.js';
import { GateError, type RewriteLevel } from '../types.js';
import type { Logger } from '../logger.js';

export const RewritePromptInputSchema = z.object({
  prompt: z.string().min(1).max(32_000).describe('The original prompt to rewrite.'),
  language: z
    .string()
    .max(32)
    .optional()
    .describe('Preferred output language, e.g. "english" or "vietnamese".'),
  context: z
    .string()
    .max(8_000)
    .optional()
    .describe('Additional context from the user to inform the rewrite.'),
  rewrite_level: z
    .enum(['light', 'balanced', 'detailed'])
    .optional()
    .describe('How much enrichment to apply. Defaults to "balanced".'),
});

export type RewritePromptInput = z.infer<typeof RewritePromptInputSchema>;

export function registerRewritePromptTool(server: McpServer, rewrite: RewriteService, log: Logger): void {
  server.registerTool(
    'rewrite_prompt',
    {
      title: 'Prompt Rewrite (no approval)',
      description:
        'Re-emit the given prompt with richer context, structure, and quality ' +
        'criteria. This tool only produces a candidate rewrite; it does NOT ' +
        'approve the result. Use review_and_select_prompt for the gated, ' +
        'user-confirmed flow.',
      inputSchema: {
        prompt: RewritePromptInputSchema.shape.prompt,
        language: RewritePromptInputSchema.shape.language,
        context: RewritePromptInputSchema.shape.context,
        rewrite_level: RewritePromptInputSchema.shape.rewrite_level,
      },
    },
    async (rawInput) => {
      const input = RewritePromptInputSchema.parse(rawInput);
      const requestId = Math.random().toString(36).slice(2, 10);
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
  );
}

function normalizeGateError(err: unknown, requestId: string): GateError {
  if (err instanceof GateError) return err;
  if (err instanceof LLMError) {
    const msg = err.message.toLowerCase();
    const kind = msg.includes('timed out') ? 'llm_timeout' : 'llm_unavailable';
    return new GateError(kind, err.message, { requestId, elapsedMs: err.elapsedMs });
  }
  return new GateError('unknown', err instanceof Error ? err.message : String(err), { requestId });
}
