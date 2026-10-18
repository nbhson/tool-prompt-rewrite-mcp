import { loadConfig, type LogLevel } from './config.js';

/**
 * Safe logger.
 *
 * Design rules:
 * - NEVER log prompt contents.
 * - NEVER log API keys / secrets.
 * - Log only structured events: request ID, duration, error code.
 */

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export function createLogger(configLevel?: LogLevel): Logger {
  const level = LEVELS[configLevel ?? 'info'];

  const write = (lvl: LogLevel, msg: string, ctx?: Record<string, unknown>) => {
    if (LEVELS[lvl] < level) return;
    const ts = new Date().toISOString();
    const ctxStr = ctx && Object.keys(ctx).length > 0 ? ` ${JSON.stringify(sanitize(ctx))}` : '';
    const line = `[${ts}] [${lvl.toUpperCase()}] ${msg}${ctxStr}`;
    // ALL log output goes to stderr so stdout is reserved for the MCP
    // protocol (JSON-RPC frames). This is a hard requirement of any
    // stdio-based MCP server.
    console.error(line);
  };

  /**
   * Strip prompt / secret-shaped fields from a log context before writing.
   * This is the "redact secrets in logs" requirement — defensive measure
   * so we never leak prompt text or credentials.
   */
  function sanitize(ctx: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx)) {
      const lk = k.toLowerCase();
      if (
        lk === 'prompt' ||
        lk === 'original_prompt' ||
        lk === 'rewritten_prompt' ||
        lk === 'selected_prompt' ||
        lk === 'api_key' ||
        lk === 'apikey' ||
        lk === 'secret' ||
        lk === 'token'
      ) {
        out[k] = '<redacted>';
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  return {
    debug: (m, c) => write('debug', m, c),
    info: (m, c) => write('info', m, c),
    warn: (m, c) => write('warn', m, c),
    error: (m, c) => write('error', m, c),
  };
}

export function getLogger(): Logger {
  const cfg = loadConfig();
  return createLogger(cfg.logLevel);
}
