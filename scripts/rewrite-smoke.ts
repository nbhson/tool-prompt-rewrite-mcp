/**
 * E2E smoke test against a running llama.cpp server.
 * Usage:  node build/scripts/rewrite-smoke.mjs
 * Env:    PROMPT_GATE_LLM_ENABLE_THINKING, PROMPT_GATE_LLM_MAX_TOKENS, ...
 */
import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/llm/index.js';
import { RewriteService } from '../src/rewrite/rewrite.js';

const cfg = loadConfig();
console.error(`[config] baseUrl=${cfg.llm.baseUrl} model=${cfg.llm.model}`);
console.error(`[config] timeoutMs=${cfg.llm.timeoutMs} retryMax=${cfg.llm.retryMax} maxTokens=${cfg.llm.maxTokens}`);
console.error(`[config] extraBody=${JSON.stringify(cfg.llm.extraBody ?? {})}`);

const provider = createProvider(cfg.llm);
const svc = new RewriteService(provider, cfg.llm.retryMax);

const t0 = Date.now();
try {
  const r = await svc.rewrite('thông tin việt nam', { level: 'light' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== OK in ${secs}s ===`);
  console.log(`rewritten (${r.rewrittenPrompt.length} chars):`);
  console.log(r.rewrittenPrompt);
  if (r.warnings?.length) console.log(`warnings: ${r.warnings.join('; ')}`);
  process.exit(0);
} catch (err) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`\n=== FAILED after ${secs}s: ${err.message} ===`);
  if (err.cause) console.error(`cause: ${err.cause.message ?? err.cause}`);
  process.exit(1);
}
