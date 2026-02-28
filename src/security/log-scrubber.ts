/**
 * log-scrubber.ts — SmallClaw Secure Logger
 *
 * Drop-in replacement for console.log / console.warn / console.error.
 * Every message is scrubbed for secrets before being written to disk or stdout.
 *
 * Usage:
 *   import { log } from '../security/log-scrubber';
 *   log.info('[gateway]', 'Server started on port', port);
 *   log.warn('[vault]', 'Rotation due for key:', keyName);
 *   log.error('[auth]', 'Token exchange failed:', err.message);
 *
 * Rules enforced:
 *  1. scrubSecrets() runs on EVERY argument before output
 *  2. Object arguments are JSON-stringified then scrubbed (never raw)
 *  3. No raw tool-call inputs/outputs — callers must pass summaries
 *  4. Separate security-event sink (log.security()) goes to security.log only
 *  5. No plaintext secret values may appear in any log line
 */

import fs from 'fs';
import path from 'path';
import { scrubSecrets } from './vault';

// ─── Config ───────────────────────────────────────────────────────────────────

const LOG_DIR_ENV   = process.env.SMALLCLAW_LOG_DIR;
const LOG_LEVEL_ENV = (process.env.SMALLCLAW_LOG_LEVEL ?? 'info').toLowerCase();

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, security: 4 } as const;
type LogLevel = keyof typeof LEVELS;

const activeLevel: number = LEVELS[LOG_LEVEL_ENV as LogLevel] ?? LEVELS.info;

// ─── Formatting ───────────────────────────────────────────────────────────────

function serialize(arg: unknown): string {
  if (arg === null)      return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg, null, 0);
  } catch {
    return String(arg);
  }
}

function formatLine(level: string, parts: unknown[]): string {
  const ts  = new Date().toISOString();
  const msg = parts.map(serialize).join(' ');
  const clean = scrubSecrets(msg);
  return `[${ts}] [${level.toUpperCase().padEnd(8)}] ${clean}`;
}

// ─── Sinks ────────────────────────────────────────────────────────────────────

let _logDir: string | null = LOG_DIR_ENV ?? null;

function ensureLogDir(): string | null {
  if (_logDir) {
    try {
      if (!fs.existsSync(_logDir)) fs.mkdirSync(_logDir, { recursive: true });
      return _logDir;
    } catch {
      return null;
    }
  }
  return null;
}

function writeToFile(filename: string, line: string): void {
  const dir = ensureLogDir();
  if (!dir) return;
  try {
    fs.appendFileSync(path.join(dir, filename), line + '\n');
  } catch { /* disk errors must not crash the app */ }
}

export function initLogDir(dir: string): void {
  _logDir = dir;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVELS[level] < activeLevel) return;
  const line = formatLine(level, args);

  // Always write to stdout/stderr (scrubbed)
  if (level === 'error' || level === 'security') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }

  // Write to app log file
  if (level !== 'security') {
    writeToFile('app.log', line);
  }

  // Security events go to their own sink — never mixed with app logs
  if (level === 'security') {
    writeToFile('security.log', line);
  }
}

export const log = {
  debug(...args: unknown[]):    void { emit('debug',    args); },
  info(...args: unknown[]):     void { emit('info',     args); },
  warn(...args: unknown[]):     void { emit('warn',     args); },
  error(...args: unknown[]):    void { emit('error',    args); },
  /** Security events: always written to security.log, never to app.log */
  security(...args: unknown[]): void { emit('security', args); },
};

// ─── Tool call sanitiser ──────────────────────────────────────────────────────
/**
 * When you need to log a tool call for debugging, pass input/output through
 * this first. It truncates large payloads AND scrubs secrets.
 *
 * NEVER log raw tool inputs/outputs — they may contain credentials from
 * API responses or file reads.
 */
export function sanitizeToolLog(toolName: string, data: unknown, maxChars = 400): string {
  const raw = typeof data === 'string' ? data : JSON.stringify(data, null, 0);
  const truncated = raw.length > maxChars
    ? raw.slice(0, maxChars) + `…[${raw.length - maxChars} chars truncated]`
    : raw;
  return scrubSecrets(`tool:${toolName} ${truncated}`);
}
