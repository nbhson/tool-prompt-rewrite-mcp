import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses default values when no env is set', () => {
    const cfg = loadConfig({});
    expect(cfg.llm.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(cfg.llm.model).toBe('qwen3.5-9b');
    expect(cfg.transport).toBe('stdio');
    expect(cfg.logLevel).toBe('info');
  });

  it('reads PROMPT_GATE_* env vars', () => {
    const cfg = loadConfig({
      PROMPT_GATE_LLM_BASE_URL: 'http://10.0.0.1:9999/v1',
      PROMPT_GATE_LLM_MODEL: 'other-model',
      PROMPT_GATE_TIMEOUT_MS: '15000',
      PROMPT_GATE_TRANSPORT: 'http',
      PROMPT_GATE_HTTP_PORT: '4000',
      PROMPT_GATE_LOG_LEVEL: 'debug',
    });
    expect(cfg.llm.baseUrl).toBe('http://10.0.0.1:9999/v1');
    expect(cfg.llm.model).toBe('other-model');
    expect(cfg.llm.timeoutMs).toBe(15000);
    expect(cfg.transport).toBe('http');
    expect(cfg.httpPort).toBe(4000);
    expect(cfg.logLevel).toBe('debug');
  });

  it('prefers PROMPT_GATE_EXTERNAL_LLM over local base URL', () => {
    const cfg = loadConfig({
      PROMPT_GATE_LLM_BASE_URL: 'http://local/v1',
      PROMPT_GATE_EXTERNAL_LLM: 'https://remote/v1',
    });
    expect(cfg.llm.baseUrl).toBe('https://remote/v1');
    expect(cfg.externalLlm).toBe('https://remote/v1');
  });

  it('clamps invalid timeout values to fallback', () => {
    const cfg = loadConfig({ PROMPT_GATE_TIMEOUT_MS: 'not-a-number' });
    expect(cfg.llm.timeoutMs).toBe(180_000);
  });

  it('reads maxTokens and retryMax env vars', () => {
    const cfg = loadConfig({
      PROMPT_GATE_LLM_MAX_TOKENS: '4096',
      PROMPT_GATE_LLM_RETRY_MAX: '5',
    });
    expect(cfg.llm.maxTokens).toBe(4096);
    expect(cfg.llm.retryMax).toBe(5);
  });

  it('passes enable_thinking=false through to extraBody (sends both llama.cpp & OpenAI keys)', () => {
    const cfg = loadConfig({ PROMPT_GATE_LLM_ENABLE_THINKING: 'false' });
    expect(cfg.llm.extraBody?.thinking).toBe(false);
    expect(cfg.llm.extraBody?.enable_thinking).toBe(false);
  });

  it('merges PROMPT_GATE_LLM_EXTRA_JSON into extraBody', () => {
    const cfg = loadConfig({
      PROMPT_GATE_LLM_ENABLE_THINKING: 'false',
      PROMPT_GATE_LLM_EXTRA_JSON: '{"reasoning_effort":"low"}',
    });
    expect(cfg.llm.extraBody?.enable_thinking).toBe(false);
    expect(cfg.llm.extraBody?.reasoning_effort).toBe('low');
  });

  it('rejects invalid log level gracefully', () => {
    const cfg = loadConfig({ PROMPT_GATE_LOG_LEVEL: 'verbose' as unknown as string });
    expect(cfg.logLevel).toBe('info');
  });
});
