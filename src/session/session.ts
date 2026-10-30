/**
 * Pending-review state for the text-echo fallback of the gate tool.
 *
 * When the client does not support MCP elicitation, `review_and_select_prompt`
 * returns a "pending_user_selection" result and the agent relays the user's
 * choice on a re-call. To guarantee that the agent approves EXACTLY what the
 * user saw (and not a substituted text), the server stores the pending review
 * state here and requires the re-call to carry the matching `review_id`.
 *
 * Entries are short-lived (TTL) and removed once the review resolves.
 */

import { randomUUID } from 'node:crypto';
import type { RewriteLevel } from '../types.js';

/** State stored server-side between a pending_user_selection and its relay. */
export interface PendingReview {
  id: string;
  originalPrompt: string;
  rewrittenPrompt: string;
  changesSummary: string;
  warnings?: string[];
  /** The level the USER chose for this review (reused for revisions). */
  level: RewriteLevel;
  language?: string;
  context?: string;
  /** Revision rounds already applied in this review chain. */
  revisionCount: number;
  createdAt: number;
}

/** How long an unanswered pending review stays valid. */
export const PENDING_REVIEW_TTL_MS = 30 * 60 * 1000;

export class PendingReviewStore {
  private readonly entries = new Map<string, PendingReview>();

  constructor(private readonly ttlMs: number = PENDING_REVIEW_TTL_MS) {}

  /** Store a new pending review and return its id. */
  create(data: Omit<PendingReview, 'id' | 'createdAt'>): string {
    this.purgeExpired();
    const id = randomUUID();
    this.entries.set(id, { ...data, id, createdAt: Date.now() });
    return id;
  }

  /** Look up a pending review; expired or unknown ids return undefined. */
  get(id: string): PendingReview | undefined {
    this.purgeExpired();
    return this.entries.get(id);
  }

  /** Drop a pending review (after approval / cancellation / replacement). */
  remove(id: string): void {
    this.entries.delete(id);
  }

  /** Number of live entries (used by tests). */
  get size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  private purgeExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.entries) {
      if (v.createdAt < cutoff) this.entries.delete(k);
    }
  }
}
