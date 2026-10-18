/**
 * Configuration loading for the Universal Prompt Gate MCP Server.
 *
 * Reads PROMPT_GATE_* env vars, validates them, and exposes typed config.
 * No secret values are ever logged.
 */

export type TransportKind = 'stdio' | 'http';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LLMConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  retryMax: number;
}

export interface PromptGateConfig {
  llm: LLMConfig;
  /** Optional remote OpenAI-compatible endpoint. When set, used in place of local LLM. */
  externalLlm?: string;
  transport: TransportKind;
  httpPort: number;
  /** Optional path to a custom meta-prompt policy file. */
  policyFile?: string;
  logLevel: LogLevel;
}

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'qwen3.5-9b',
  apiKey: 'local-dev-key',
  timeoutMs: 60_000,
  retryMax: 3,
  httpPort: 3000,
  logLevel: 'info' as const,
};

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  if (max !== undefined && n > max) return max;
  return n;
}

function parseLevel(raw: string | undefined): LogLevel {
  const r = raw?.toLowerCase();
  if (r === 'debug' || r === 'info' || r === 'warn' || r === 'error') return r;
  return DEFAULTS.logLevel;
}

function pickLlmUrl(env: NodeJS.ProcessEnv): string {
  // External LLM overrides local when set.
  if (env.PROMPT_GATE_EXTERNAL_LLM && env.PROMPT_GATE_EXTERNAL_LLM.trim() !== '') {
    return env.PROMPT_GATE_EXTERNAL_LLM.trim();
  }
  return env.PROMPT_GATE_LLM_BASE_URL?.trim() || DEFAULTS.baseUrl;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PromptGateConfig {
  const logLevel = parseLevel(env.PROMPT_GATE_LOG_LEVEL);

  const baseUrl = pickLlmUrl(env);
  const model = env.PROMPT_GATE_LLM_MODEL?.trim() || DEFAULTS.model;
  const apiKey = env.PROMPT_GATE_LLM_API_KEY?.trim() || DEFAULTS.apiKey;

  const timeoutMs = parsePositiveInt(env.PROMPT_GATE_TIMEOUT_MS, DEFAULTS.timeoutMs, 10 * 60_000);
  const retryMax = parsePositiveInt(env.PROMPT_GATE_LLM_RETRY_MAX, DEFAULTS.retryMax, 10);

  const transportRaw = env.PROMPT_GATE_TRANSPORT?.toLowerCase();
  const transport: TransportKind = transportRaw === 'http' ? 'http' : 'stdio';
  const httpPort = parsePositiveInt(env.PROMPT_GATE_HTTP_PORT, DEFAULTS.httpPort, 65535);

  const policyFile = env.PROMPT_GATE_REWRITE_POLICY_FILE?.trim() || undefined;

  return {
    llm: { baseUrl, model, apiKey, timeoutMs, retryMax },
    externalLlm: env.PROMPT_GATE_EXTERNAL_LLM?.trim() || undefined,
    transport,
    httpPort,
    policyFile,
    logLevel,
  };
}
