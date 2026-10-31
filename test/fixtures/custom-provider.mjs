/**
 * Test fixture: a valid custom LLM provider module.
 * Exports `createCustomLLMProvider(cfg)` as required by the 'custom' provider.
 */

export function createCustomLLMProvider() {
  return {
    isConfigured: () => true,
    chat: async () => 'custom-fixture-reply',
  };
}
