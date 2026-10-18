/**
 * LLM provider factory.
 */
import { OpenAICompatibleProvider } from './provider.js';
export function createProvider(cfg) {
    return new OpenAICompatibleProvider(cfg);
}
