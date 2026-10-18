/**
 * LLM provider factory.
 */

import type { LLMConfig } from '../config.js';
import { OpenAICompatibleProvider, type LLMProvider } from './provider.js';

export function createProvider(cfg: LLMConfig): LLMProvider {
  return new OpenAICompatibleProvider(cfg);
}

export type { LLMProvider } from './provider.js';
