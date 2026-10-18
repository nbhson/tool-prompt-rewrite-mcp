import { describe, it, expect } from 'vitest';
import { RewriteService } from '../src/rewrite/rewrite.js';
import { MockProvider } from './fixtures/llm-mocks.js';

describe('RewriteService', () => {
  it('returns a well-formed RewriteResult for a normal LLM response', async () => {
    const svc = new RewriteService(
      new MockProvider({ kind: 'ok', reply: 'Tóm tắt tin tức Việt Nam hôm nay.' })
    );
    const res = await svc.rewrite('thông tin việt nam', { level: 'balanced' });
    expect(res.originalPrompt).toBe('thông tin việt nam');
    expect(res.rewrittenPrompt).toBe('Tóm tắt tin tức Việt Nam hôm nay.');
    expect(res.changesSummary).toContain('balanced');
    expect(res.warnings).toBeUndefined();
  });

  it('passes language and context to the LLM', async () => {
    const provider = new MockProvider({ kind: 'ok', reply: 'Summary' });
    const svc = new RewriteService(provider);
    await svc.rewrite('vn', { language: 'english', context: 'news about VN', level: 'light' });
    expect(provider.calls).toHaveLength(1);
    const userMsg = provider.calls[0]?.messages[1]?.content ?? '';
    expect(userMsg).toContain('Preferred output language: english');
    expect(userMsg).toContain('Additional context from user:');
    expect(userMsg).toContain('news about VN');
  });

  it('propagates LLM timeout as a distinct error', async () => {
    const svc = new RewriteService(new MockProvider({ kind: 'timeout' }));
    await expect(svc.rewrite('x')).rejects.toThrow(/timed out/);
  });

  it('propagates LLM malformed output as an error', async () => {
    const svc = new RewriteService(
      new MockProvider({ kind: 'throw', error: 'LLM returned an empty completion.' })
    );
    await expect(svc.rewrite('x')).rejects.toThrow(/empty completion/);
  });

  it('adds a warning when the rewrite is much shorter than the original', async () => {
    const svc = new RewriteService(new MockProvider({ kind: 'ok', reply: 'short' }));
    const res = await svc.rewrite(
      'a very long original prompt that needs context and structure and criteria'
    );
    expect(res.warnings).toBeDefined();
    expect(res.warnings?.[0]).toMatch(/shorter/);
  });
});
