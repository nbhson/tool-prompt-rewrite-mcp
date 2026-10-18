/**
 * Mock LLM provider for unit / integration tests.
 *
 * Lets tests exercise the rewrite service and tool handlers without a real
 * llama.cpp endpoint.
 */

import type { ChatMessage, LLMProvider } from '../../src/llm/provider.js';

export type MockBehavior =
  { kind: 'ok'; reply: string } | { kind: 'throw'; error: string; name?: string } | { kind: 'timeout' };

export class MockProvider implements LLMProvider {
  public calls: { messages: ChatMessage[]; timestamp: number }[] = [];

  constructor(
    private behavior: MockBehavior | ((msg: ChatMessage[]) => MockBehavior) = {
      kind: 'ok',
      reply: 'Rewritten',
    }
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    this.calls.push({ messages, timestamp: Date.now() });
    const b = typeof this.behavior === 'function' ? this.behavior(messages) : this.behavior;
    if (b.kind === 'ok') return b.reply;
    if (b.kind === 'timeout') {
      const e = new Error('LLM request timed out');
      e.name = 'AbortError';
      throw e;
    }
    const e = new Error(b.error);
    if (b.name) e.name = b.name;
    throw e;
  }
}
