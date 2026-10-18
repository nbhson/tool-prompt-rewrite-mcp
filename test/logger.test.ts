import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger secret redaction', () => {
  it('redacts prompt-shaped fields', () => {
    const log = createLogger('debug');
    const written: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      written.push(args.join(' '));
    };
    try {
      log.debug('event-test', {
        prompt: 'secret prompt text',
        original_prompt: 'another secret',
        rewritten_prompt: 'also secret',
        selected_prompt: 'secret too',
        requestId: 'abc123',
      });
    } finally {
      console.error = origErr;
    }
    const line = written.find((l) => l.includes('event-test')) ?? '';
    expect(line).toContain('<redacted>');
    expect(line).not.toContain('secret prompt text');
    expect(line).not.toContain('another secret');
    expect(line).not.toContain('also secret');
    expect(line).not.toContain('secret too');
    expect(line).toContain('abc123');
  });

  it('redacts api_key / token / secret fields', () => {
    const log = createLogger('debug');
    const written: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      written.push(args.join(' '));
    };
    try {
      log.debug('event-secrets', { apiKey: 'sk-real-key-XYZ', token: 'tok-secret-XYZ', normal: 'visible' });
    } finally {
      console.error = origErr;
    }
    const line = written.find((l) => l.includes('event-secrets')) ?? '';
    expect(line).toContain('<redacted>');
    expect(line).not.toContain('sk-real-key-XYZ');
    expect(line).not.toContain('tok-secret-XYZ');
    expect(line).toContain('visible');
  });

  it('writes ALL log output to stderr (never stdout)', () => {
    const log = createLogger('debug');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      stdout.push(args.join(' '));
    };
    console.error = (...args: unknown[]) => {
      stderr.push(args.join(' '));
    };
    try {
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(4);
  });

  it('honors the log level (error-level logger suppresses info/warn/debug)', () => {
    const log = createLogger('error');
    const written: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      written.push(args.join(' '));
    };
    try {
      log.debug('only-debug');
      log.info('only-info');
      log.warn('only-warn');
      log.error('only-error');
    } finally {
      console.error = origErr;
    }
    expect(written.some((l) => l.includes('only-debug'))).toBe(false);
    expect(written.some((l) => l.includes('only-info'))).toBe(false);
    expect(written.some((l) => l.includes('only-warn'))).toBe(false);
    expect(written.some((l) => l.includes('only-error'))).toBe(true);
  });
});
