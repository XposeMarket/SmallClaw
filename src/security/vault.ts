/**
 * vault.ts — SmallClaw Secret Vault
 *
 * Provides AES-256-GCM encrypted storage for all credentials.
 * Keys are derived from a machine-scoped master key (never stored alongside secrets).
 * Secrets are NEVER returned in logs, toString(), or JSON.stringify().
 *
 * Security model:
 *  - Encrypt on write, decrypt only on explicit .get() call
 *  - Vault key stored separately from vault data
 *  - All access logged with caller tag (no secret value in log)
 *  - UI/log layer should always call redact() before outputting any string
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALGO        = 'aes-256-gcm';
const KEY_BYTES   = 32;
const IV_BYTES    = 16;
const KEY_ITERS   = 200_000;
const KEY_DIGEST  = 'sha512';
const VAULT_FILE  = 'vault.enc';
const MASTER_FILE = 'vault.key';
const AUDIT_FILE  = 'vault-audit.log';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VaultEntry {
  /** Encrypted payload (hex) */
  enc: string;
  /** IV (hex) */
  iv: string;
  /** Auth tag (hex) */
  tag: string;
  /** When this entry was stored (Unix ms) */
  createdAt: number;
  /** When this entry expires (Unix ms), 0 = never */
  expiresAt: number;
}

export interface VaultMetadata {
  version: 1;
  entries: Record<string, VaultEntry>;
}

// ─── SecretValue ─────────────────────────────────────────────────────────────
/**
 * Wraps a plaintext secret so it CANNOT accidentally appear in logs,
 * JSON.stringify, or console output. Call .expose() only at the exact
 * point the raw value is needed (e.g. an HTTP Authorization header).
 */
export class SecretValue {
  readonly #value: string;

  constructor(raw: string) {
    this.#value = raw;
  }

  /** Only way to get the plaintext — call only at point-of-use */
  expose(): string {
    return this.#value;
  }

  toString(): string { return '[REDACTED]'; }
  toJSON(): string   { return '[REDACTED]'; }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'SecretValue([REDACTED])';
  }
}

// ─── Log scrubber ─────────────────────────────────────────────────────────────
/**
 * Call scrubSecrets() on ANY string before writing to logs, sending to UI,
 * or passing to an LLM (e.g. "summarise these logs").
 */

const SECRET_PATTERNS: RegExp[] = [
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // OpenAI-style keys
  /sk-[A-Za-z0-9]{20,}/g,
  // AWS access key IDs
  /AKIA[A-Z0-9]{16}/g,
  // JWTs
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g,
  // JSON key-value pairs containing sensitive field names
  /"(?:api_key|apikey|api_token|access_token|refresh_token|secret|password|passwd|credential|token)"\s*:\s*"[^"]{6,}"/gi,
  /'(?:api_key|apikey|api_token|access_token|refresh_token|secret|password|passwd|credential|token)'\s*:\s*'[^']{6,}'/gi,
  // Query-string style
  /(?:api_key|apikey|token|secret|password)=[^\s&"']{6,}/gi,
];

function looksHighEntropy(s: string): boolean {
  if (s.length < 32) return false;
  const unique = new Set(s.replace(/[^A-Za-z0-9+/=_\-]/g, '')).size;
  return unique >= 20;
}

export function scrubSecrets(input: string): string {
  let out = input;

  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      const eqIdx    = match.indexOf('=');
      const colonIdx = match.indexOf(':');
      if (eqIdx    > 0 && eqIdx    < 30) return match.slice(0, eqIdx + 1)    + '[REDACTED]';
      if (colonIdx > 0 && colonIdx < 30) return match.slice(0, colonIdx + 1) + ' "[REDACTED]"';
      return '[REDACTED]';
    });
  }

  // High-entropy word catch-all
  out = out.replace(/[A-Za-z0-9+/=_\-]{32,}/g, (word) =>
    looksHighEntropy(word) ? '[REDACTED-HE]' : word
  );

  return out;
}

// ─── SecretVault ──────────────────────────────────────────────────────────────

export class SecretVault {
  private readonly vaultPath: string;
  private readonly keyPath: string;
  private readonly auditPath: string;
  private masterKey: Buffer | null = null;
  private data: VaultMetadata = { version: 1, entries: {} };

  constructor(configDir: string) {
    const vaultDir = path.join(configDir, 'vault');
    if (!fs.existsSync(vaultDir)) fs.mkdirSync(vaultDir, { recursive: true });
    this.vaultPath = path.join(vaultDir, VAULT_FILE);
    this.keyPath   = path.join(vaultDir, MASTER_FILE);
    this.auditPath = path.join(vaultDir, AUDIT_FILE);
    this.loadOrInit();
  }

  // ── Key management ────────────────────────────────────────────────────────

  private loadOrInit(): void {
    this.masterKey = this.loadOrCreateMasterKey();
    if (fs.existsSync(this.vaultPath)) {
      try {
        const raw = fs.readFileSync(this.vaultPath, 'utf-8');
        this.data = JSON.parse(raw) as VaultMetadata;
      } catch {
        this.data = { version: 1, entries: {} };
      }
    }
  }

  private loadOrCreateMasterKey(): Buffer {
    if (fs.existsSync(this.keyPath)) {
      const hex = fs.readFileSync(this.keyPath, 'utf-8').trim();
      return Buffer.from(hex, 'hex');
    }
    const key = crypto.randomBytes(KEY_BYTES);
    // mode 0o600 = owner read/write only
    fs.writeFileSync(this.keyPath, key.toString('hex'), { mode: 0o600 });
    return key;
  }

  private deriveKey(salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(this.masterKey!, salt, KEY_ITERS, KEY_BYTES, KEY_DIGEST);
  }

  // ── Crypto ────────────────────────────────────────────────────────────────

  private encrypt(plaintext: string): Omit<VaultEntry, 'createdAt' | 'expiresAt'> {
    const iv     = crypto.randomBytes(IV_BYTES);
    const key    = this.deriveKey(iv);
    const cipher = crypto.createCipheriv(ALGO, key, iv) as crypto.CipherGCM;
    const enc    = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return { enc: enc.toString('hex'), iv: iv.toString('hex'), tag: tag.toString('hex') };
  }

  private decrypt(entry: VaultEntry): string {
    const iv      = Buffer.from(entry.iv,  'hex');
    const key     = this.deriveKey(iv);
    const decipher = crypto.createDecipheriv(ALGO, key, iv) as crypto.DecipherGCM;
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(entry.enc, 'hex')),
      decipher.final(),
    ]);
    return plain.toString('utf-8');
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private persist(): void {
    fs.writeFileSync(this.vaultPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  private audit(action: string, key: string, caller: string): void {
    const line = `${new Date().toISOString()} | ${action.padEnd(8)} | key=${key} | caller=${caller}\n`;
    try { fs.appendFileSync(this.auditPath, line); } catch { /* must not break call */ }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Store an encrypted secret.
   * @param key    Logical name (e.g. "openai.api_key")
   * @param value  Plaintext secret
   * @param caller Who is storing — recorded in audit log
   * @param ttlMs  Time-to-live ms; 0 = never expire
   */
  set(key: string, value: string, caller = 'unknown', ttlMs = 0): void {
    const { enc, iv, tag } = this.encrypt(value);
    this.data.entries[key] = {
      enc, iv, tag,
      createdAt: Date.now(),
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
    };
    this.persist();
    this.audit('SET', key, caller);
  }

  /**
   * Retrieve a secret wrapped in SecretValue (no plaintext in logs).
   * Returns null if missing or expired.
   */
  get(key: string, caller = 'unknown'): SecretValue | null {
    const entry = this.data.entries[key];
    if (!entry) return null;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.delete(key, 'vault:expiry');
      return null;
    }
    this.audit('GET', key, caller);
    try {
      return new SecretValue(this.decrypt(entry));
    } catch {
      this.audit('GET_FAIL', key, caller);
      return null;
    }
  }

  /** Check existence without decrypting or emitting a GET audit event */
  has(key: string): boolean {
    const entry = this.data.entries[key];
    if (!entry) return false;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.delete(key, 'vault:expiry');
      return false;
    }
    return true;
  }

  delete(key: string, caller = 'unknown'): void {
    if (this.data.entries[key]) {
      delete this.data.entries[key];
      this.persist();
      this.audit('DEL', key, caller);
    }
  }

  /** List all live key names — never values */
  keys(): string[] {
    return Object.keys(this.data.entries).filter((k) => {
      const e = this.data.entries[k];
      return !(e.expiresAt > 0 && Date.now() > e.expiresAt);
    });
  }

  /**
   * Rotate: re-encrypt with a fresh IV. Preserves original TTL.
   * Returns false if key doesn't exist.
   */
  rotate(key: string, newValue: string, caller = 'unknown'): boolean {
    const existing = this.data.entries[key];
    if (!existing) return false;
    const ttlMs = existing.expiresAt > 0
      ? existing.expiresAt - existing.createdAt
      : 0;
    this.set(key, newValue, caller, ttlMs);
    this.audit('ROTATE', key, caller);
    return true;
  }

  /** Factory-reset: wipe all entries */
  clear(caller = 'unknown'): void {
    this.data = { version: 1, entries: {} };
    this.persist();
    this.audit('CLEAR', '*', caller);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _vault: SecretVault | null = null;

export function getVault(configDir?: string): SecretVault {
  if (!_vault) {
    if (!configDir) throw new Error('[Vault] configDir required for first initialisation');
    _vault = new SecretVault(configDir);
  }
  return _vault;
}
