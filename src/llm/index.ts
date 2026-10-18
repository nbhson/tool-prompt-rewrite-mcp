/**
 * LLM provider factory.
 *
 * Built-in providers:
 * - `openai-compatible` (default) — works with local llama.cpp and any
 *   OpenAI-style endpoint (uses `cfg.baseUrl` / `model` / `apiKey`).
 * - `openai` — same HTTP shape, but the cloud default endpoint is used
 *   when `baseUrl` is left empty.
 *
 * Custom providers:
 * - `custom` — loads a module at `cfg.customProviderModule` that must
 *   export `createCustomLLMProvider(cfg): LLMProvider`. This lets users
 *   ship their own provider (e.g. a .env-driven local one) without
 *   editing this package.
 */

import type { LLMConfig } from '../config.js';
import { OpenAICompatibleProvider, type LLMProvider } from './provider.js';

export async function createProvider(cfg: LLMConfig): Promise<LLMProvider> {
  switch (cfg.provider) {
    case 'openai':
      // Same wire protocol; just make the baseUrl required explicit.
      if (!cfg.baseUrl || cfg.baseUrl.trim() === '') {
        throw new Error(
          'PROMPT_GATE_PROVIDER=openai requires a baseUrl. Set ' +
            'PROMPT_GATE_LLM_BASE_URL or PROMPT_GATE_EXTERNAL_LLM.'
        );
      }
      return new OpenAICompatibleProvider(cfg);

    case 'custom': {
      if (!cfg.customProviderModule) {
        throw new Error(
          'PROMPT_GATE_PROVIDER=custom requires PROMPT_GATE_CUSTOM_PROVIDER_MODULE ' +
            '(path to a module that exports createCustomLLMProvider).'
        );
      }
      const mod = (await import(cfg.customProviderModule)) as {
        createCustomLLMProvider?: (cfg: LLMConfig) => LLMProvider;
      };
      if (typeof mod.createCustomLLMProvider !== 'function') {
        throw new Error(
          `Custom provider module ${cfg.customProviderModule} does not export ` +
            '`createCustomLLMProvider(cfg: LLMConfig): LLMProvider`.'
        );
      }
      return mod.createCustomLLMProvider(cfg);
    }

    case 'openai-compatible':
    default:
      return new OpenAICompatibleProvider(cfg);
  }
}

export type { LLMProvider, OpenAICompatibleProvider } from './provider.js';
