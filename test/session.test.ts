/**
 * Unit tests for SessionManager (session & pending-approval bookkeeping).
 */

import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/session/session.js';

describe('SessionManager', () => {
  it('newSession creates an isolated pending map per session', () => {
    const sm = new SessionManager();
    const a = sm.newSession();
    const b = sm.newSession();
    expect(a).not.toBe(b);
    expect(sm.getSession(a)?.size).toBe(0);
    expect(sm.getSession(b)?.size).toBe(0);
  });

  it('addPending registers an unresolved pending request; unknown session throws', () => {
    const sm = new SessionManager();
    const sid = sm.newSession();
    const pid = sm.addPending(sid);
    expect(pid).toBeTruthy();
    const pending = sm.getSession(sid);
    expect(pending?.get(pid)?.resolved).toBe(false);
    expect(() => sm.addPending('nope')).toThrow(/Unknown session/);
  });

  it('resolvePending marks the entry resolved; unknown ids are no-ops', () => {
    const sm = new SessionManager();
    const sid = sm.newSession();
    const pid = sm.addPending(sid);
    sm.resolvePending(sid, pid);
    expect(sm.getSession(sid)?.get(pid)?.resolved).toBe(true);
    // Unknown session / pending id: must not throw.
    expect(() => sm.resolvePending('nope', pid)).not.toThrow();
    expect(() => sm.resolvePending(sid, 'nope')).not.toThrow();
  });

  it('cleanupAbandoned removes only old unresolved requests and returns the count', () => {
    const sm = new SessionManager();
    const sid = sm.newSession();
    const old = sm.addPending(sid);
    // Backdate the first request so it is older than the TTL.
    const entry = sm.getSession(sid)?.get(old);
    if (entry) entry.createdAt = Date.now() - 10_000;
    const fresh = sm.addPending(sid);
    const resolvedOld = sm.addPending(sid);
    if (sm.getSession(sid)?.get(resolvedOld)) sm.resolvePending(sid, resolvedOld);

    const removed = sm.cleanupAbandoned(sid, 5_000);
    expect(removed).toBe(1);
    expect(sm.getSession(sid)?.has(old)).toBe(false);
    expect(sm.getSession(sid)?.has(fresh)).toBe(true);
    expect(sm.getSession(sid)?.has(resolvedOld)).toBe(true); // resolved ones stay
  });

  it('cleanupAbandoned on unknown session returns 0', () => {
    const sm = new SessionManager();
    expect(sm.cleanupAbandoned('nope', 1000)).toBe(0);
  });

  it('closeSession drops the session entirely', () => {
    const sm = new SessionManager();
    const sid = sm.newSession();
    sm.addPending(sid);
    sm.closeSession(sid);
    expect(sm.getSession(sid)).toBeUndefined();
  });
});
