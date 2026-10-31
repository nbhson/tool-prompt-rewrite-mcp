/**
 * Unit tests for PendingReviewStore (text-echo fallback state).
 *
 * The store keeps pending_user_selection state between the gate tool's
 * rewrite step and the agent's relay re-call, so the server can verify
 * that the approved text is EXACTLY what the user saw.
 */

import { describe, it, expect } from 'vitest';
import { PendingReviewStore, PENDING_REVIEW_TTL_MS } from '../src/session/session.js';
import type { PendingReview } from '../src/session/session.js';

function sampleReview(): Omit<PendingReview, 'id' | 'createdAt'> {
  return {
    originalPrompt: 'Fix the login bug',
    rewrittenPrompt: '**Mục tiêu**\nFix the login bug in module X.',
    changesSummary: 'Added goal heading and acceptance criteria.',
    level: 'balanced',
    language: 'vietnamese',
    context: 'Session about auth.',
    revisionCount: 0,
  };
}

describe('PendingReviewStore', () => {
  it('create returns a unique id and get returns the stored review', () => {
    const store = new PendingReviewStore();
    const id1 = store.create(sampleReview());
    const id2 = store.create(sampleReview());

    expect(id1).not.toBe(id2);
    const review = store.get(id1);
    expect(review?.originalPrompt).toBe('Fix the login bug');
    expect(review?.level).toBe('balanced');
    expect(review?.revisionCount).toBe(0);
    expect(typeof review?.createdAt).toBe('number');
  });

  it('get returns undefined for unknown ids', () => {
    const store = new PendingReviewStore();
    expect(store.get('nope')).toBeUndefined();
  });

  it('remove drops the entry; subsequent get returns undefined', () => {
    const store = new PendingReviewStore();
    const id = store.create(sampleReview());
    expect(store.size).toBe(1);
    store.remove(id);
    expect(store.get(id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('remove on unknown id is a no-op', () => {
    const store = new PendingReviewStore();
    expect(() => store.remove('nope')).not.toThrow();
  });

  it('expired entries are purged on access', () => {
    const store = new PendingReviewStore(10); // 10 ms TTL
    const id = store.create(sampleReview());
    vi_wait(15);
    expect(store.get(id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('non-expired entries survive purging', () => {
    const store = new PendingReviewStore(10_000);
    const id = store.create(sampleReview());
    vi_wait(15);
    expect(store.get(id)?.id).toBe(id);
  });

  it('default TTL is 30 minutes', () => {
    expect(PENDING_REVIEW_TTL_MS).toBe(30 * 60 * 1000);
  });
});

/** Tiny helper: busy-wait the given number of milliseconds (test only). */
function vi_wait(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // spin
  }
}
