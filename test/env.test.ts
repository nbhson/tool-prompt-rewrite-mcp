import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../src/env.js';

describe('loadEnvFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'envtest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses KEY=VALUE and ignores comments & blank lines', () => {
    const target: Record<string, string> = {};
    writeFileSync(
      join(dir, '.env'),
      ['# comment', '', 'FOO=bar', ' export BAZ = qux ', 'NO_EQUALS'].join('\n')
    );
    const r = loadEnvFile({ path: join(dir, '.env'), target });
    expect(target.FOO).toBe('bar');
    expect(target.BAZ).toBe('qux');
    expect(r.applied).toBe(2);
  });

  it('supports single and double quoted values', () => {
    const target: Record<string, string> = {};
    writeFileSync(
      join(dir, '.env'),
      ["A='single value'", 'B="double value"', 'C=unquoted # inline comment'].join('\n')
    );
    loadEnvFile({ path: join(dir, '.env'), target });
    expect(target.A).toBe('single value');
    expect(target.B).toBe('double value');
    expect(target.C).toBe('unquoted');
  });

  it('NEVER overrides an existing value (real env wins)', () => {
    const target: Record<string, string> = { FOO: 'from-real-env' };
    writeFileSync(join(dir, '.env'), 'FOO=from-file\nNEW_KEY=new');
    const r = loadEnvFile({ path: join(dir, '.env'), target });
    expect(target.FOO).toBe('from-real-env');
    expect(target.NEW_KEY).toBe('new');
    expect(r.applied).toBe(1);
  });

  it('no-ops (returns applied:0, source:null) when file is absent', () => {
    const r = loadEnvFile({ path: join(dir, 'does-not-exist.env') });
    expect(r.applied).toBe(0);
    expect(r.source).toBeNull();
  });

  it('throws when required and file is absent', () => {
    expect(() => loadEnvFile({ path: join(dir, 'nope.env'), required: true })).toThrow(/not found/);
  });
});
