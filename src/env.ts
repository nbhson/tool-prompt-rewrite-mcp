/**
 * Minimal, zero-dependency `.env` file loader.
 *
 * Design rules:
 * - NEVER overrides an existing `process.env` value. Real environment
 *   variables always win over the file (12-factor: the runtime is the
 *   source of truth).
 * - Parses KEY=VALUE lines, `#` comments, and `export KEY=VALUE`.
 * - Supports single/double-quoted values; trims surrounding whitespace.
 * - Inline `#` after a value is treated as a comment ONLY when the value
 *   is unquoted (matches dotenv's behavior).
 *
 * This is intentionally small — no `dotenv` dependency, so the package
 * stays lean and has no new runtime requirements.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LoadEnvOptions {
  /** Path to the .env file. Defaults to `.env` in the current working dir. */
  path?: string;
  /** Env map to merge into. Defaults to `process.env`. */
  target?: NodeJS.ProcessEnv;
  /** Throw if the file is missing. Defaults to false (silent no-op). */
  required?: boolean;
}

export interface LoadEnvResult {
  /** Number of keys actually set from the file (excludes ones already present). */
  applied: number;
  /** Absolute path of the file that was read, or null when skipped. */
  source: string | null;
}

function parseLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  let body = trimmed;
  if (body.startsWith('export ')) body = body.slice('export '.length);

  const eq = body.indexOf('=');
  if (eq === -1) return null;

  let key = body.slice(0, eq).trim();
  let value = body.slice(eq + 1).trim();

  if (key === '') return null;
  // Accept simple identifiers (allow common env char set).
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  // Strip matching quotes.
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  } else {
    // Unquoted: cut off an inline comment.
    const hash = value.indexOf('#');
    if (hash !== -1) value = value.slice(0, hash).trim();
  }

  return { key, value };
}

/**
 * Load a `.env` file into `target` (default `process.env`). Existing keys
 * are never overwritten.
 *
 * Returns what was actually applied so callers can log it.
 */
export function loadEnvFile(opts: LoadEnvOptions = {}): LoadEnvResult {
  const target = opts.target ?? process.env;
  const path = resolve(opts.path ?? '.env');

  if (!existsSync(path)) {
    if (opts.required) throw new Error(`.env file not found: ${path}`);
    return { applied: 0, source: null };
  }

  const text = readFileSync(path, 'utf8');
  let applied = 0;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (target[parsed.key] === undefined) {
      target[parsed.key] = parsed.value;
      applied++;
    }
  }
  return { applied, source: path };
}
