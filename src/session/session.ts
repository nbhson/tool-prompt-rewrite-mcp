/**
 * Session & pending-request management.
 *
 * Each MCP client connection (stdio process, or HTTP session) gets an
 * isolated session. Concurrent calls within one session must not
 * share approval decisions; abandoned pending requests must be cleaned up.
 */

import { randomUUID } from 'node:crypto';

export interface PendingApproval {
  id: string;
  createdAt: number;
  /** Set when the user interaction completes. */
  resolved: boolean;
}

export class SessionManager {
  /** Keyed by session identifier (per-connection). */
  private readonly sessions = new Map<string, { pending: Map<string, PendingApproval> }>();

  newSession(): string {
    const id = randomUUID();
    this.sessions.set(id, { pending: new Map() });
    return id;
  }

  getSession(id: string): Map<string, PendingApproval> | undefined {
    return this.sessions.get(id)?.pending;
  }

  addPending(sessionId: string): string {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    const id = randomUUID();
    s.pending.set(id, { id, createdAt: Date.now(), resolved: false });
    return id;
  }

  resolvePending(sessionId: string, pendingId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const p = s.pending.get(pendingId);
    if (p) p.resolved = true;
  }

  /** Remove abandoned pending requests older than ttlMs. */
  cleanupAbandoned(sessionId: string, ttlMs: number): number {
    const s = this.sessions.get(sessionId);
    if (!s) return 0;
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const [k, v] of s.pending) {
      if (!v.resolved && v.createdAt < cutoff) {
        s.pending.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /** Drop a session entirely (on client disconnect / transport close). */
  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
