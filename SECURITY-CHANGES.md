# SmallClaw Security Hardening — Change Log

> **Format:** Each entry records *what changed*, *where*, *why*, and *how to verify*.
> This file is the running reference for a security update post.
> Last updated: 2026-02-28

---

## Overview

SmallClaw is being hardened against the most common vulnerabilities reported in
open-source agent frameworks. Changes are grouped by threat area from the
SmallClaw Security Architecture document (v0.1).

Addressed so far:
- ✅ **Section 1.1** — Secret Vaulting (AES-256-GCM encrypted credential storage)
- ✅ **Section 1.3** — Log Hardening (scrubber pipeline, SecretValue wrapper, secure logger)
- ✅ **Credential migration** — Existing plaintext `oauth-openai.json` auto-migrates to vault on first run
- ✅ **CRIT-01** — `/api/open-path` command injection fixed (execFile + path validation + auth)
- ✅ **CRIT-02** — MCP stdio command allowlist + `shell:false` + env var sanitization
- ✅ **CRIT-03** — `/api/approvals` auth bypass fixed (gateway auth + decision validation + audit log)
- ✅ **HIGH-01** — All channel/search/hook tokens auto-migrate to vault on next config save
- ✅ **HIGH-02** — `redactConfigForUI()` masks all keys matching `api_key|token|secret|password` before sending to browser
- ✅ **HIGH-03** — Startup banner resolves vault references before presence check; key values never logged
- ✅ **HIGH-04** — MCP env block sanitized — blocks PATH, NODE_OPTIONS, LD_PRELOAD, SHELL, and 12 other dangerous vars
- ✅ **HIGH-05** — `shell.ts` workspace check replaced with proper `path.resolve + path.relative` confinement; absolute path scanner added
- ✅ **MED-01** — `/api/memory/confirm` raw body logging fixed (sanitizeToolLog + auth)
- ✅ **MED-02** — Session files scrubbed via `scrubSecrets()` before writing to disk

Pending (next iterations):
- 🔲 Section 1.2 — Scoped Token Lifecycle (TTL enforcement + rotation hooks)
- 🔲 Section 1.4 — Egress Controls (domain allowlist at network layer)
- 🔲 MED-03 — Zod schema validation on settings endpoints
- 🔲 MED-04 — Rate limiting on `/api/chat`
- 🔲 Section 2.x — Lethal Trifecta controls (data reach, input quarantine, outbound confirmation)

---

## Change 001 — Secret Vault (`src/security/vault.ts`)

**Date:** 2026-02-28
**Threat addressed:** Credential leakage — plaintext keys, tokens stored on disk

### What changed

New file: `src/security/vault.ts`

Implements `SecretVault` — an AES-256-GCM encrypted key-value store for all
credentials. Each entry is independently encrypted with a fresh IV (IV doubles
as the PBKDF2 salt, 200,000 iterations, SHA-512).

The vault master key lives at `.smallclaw/vault/vault.key` (chmod 600).
Encrypted entries live at `.smallclaw/vault/vault.enc`.
These two files are stored separately — compromising one does not yield the other.

Key features:
- `SecretValue` wrapper: plaintext is private (`#value`). `toString()`,
  `toJSON()`, and `util.inspect()` all return `"[REDACTED]"` — secrets cannot
  accidentally appear in logs or JSON serialisation.
- `.expose()` is the only way to get the raw string, making accidental logging
  obvious in code review.
- All vault reads/writes are appended to `.smallclaw/vault/vault-audit.log`
  with timestamp, action, key name, and caller tag. The secret value is never
  in the audit log.
- `.rotate()` re-encrypts with a fresh IV while preserving the original TTL.
- `.has()` checks existence without triggering a GET audit event.
- Expired entries are lazily pruned on first access.

### Files changed

| File | Change |
|------|--------|
| `src/security/vault.ts` | **New** — SecretVault, SecretValue, scrubSecrets() |
| `src/security/index.ts` | **New** — barrel export |

### How to verify

```ts
import { getVault, SecretValue } from './src/security/vault';

const vault = getVault('/path/to/.smallclaw');
vault.set('test.key', 'super-secret-value', 'test');

const s = vault.get('test.key', 'test');
console.log(s);             // SecretValue([REDACTED])
console.log(String(s));     // [REDACTED]
console.log(JSON.stringify({ secret: s })); // {"secret":"[REDACTED]"}
console.log(s!.expose());   // super-secret-value  ← only here

// Check vault.enc is not plaintext
// cat .smallclaw/vault/vault.enc  → JSON with hex enc/iv/tag fields, no readable strings
```

---

## Change 002 — Log Scrubber + Secure Logger (`src/security/log-scrubber.ts`)

**Date:** 2026-02-28
**Threat addressed:** Credential leakage via logs; logs as injection surface

### What changed

New file: `src/security/log-scrubber.ts`

Implements `scrubSecrets(input: string): string` — a pipeline function that
must be called on any string before it goes to a log sink or the UI.

Pattern registry covers:
- `Bearer <token>` (OAuth / API tokens)
- `sk-<...>` (OpenAI-style API keys)
- `AKIA<...>` (AWS access key IDs)
- JWT header.payload.signature blobs
- JSON/query-string fields named `api_key`, `token`, `password`, `secret`, `credential`, etc.
- High-entropy string detector: any base64/hex blob > 32 chars with >= 20 unique
  characters is flagged as `[REDACTED-HE]` as a catch-all.

Also implements `log` — a structured secure logger that:
- Scrubs every argument before writing to stdout/file
- Serialises objects via `JSON.stringify` before scrubbing (no raw object dumps)
- Separates security events (`log.security()`) to `security.log`, never mixed
  into `app.log`
- Supports `SMALLCLAW_LOG_LEVEL` env var (`debug`/`info`/`warn`/`error`)
- Supports `SMALLCLAW_LOG_DIR` env var for log file location

`sanitizeToolLog(toolName, data, maxChars)` utility for debug-logging tool
call inputs/outputs: truncates large payloads AND scrubs secrets.

### Files changed

| File | Change |
|------|--------|
| `src/security/log-scrubber.ts` | **New** — scrubSecrets, log, sanitizeToolLog |

### Why this matters

The most common accidental credential leak pattern in agent frameworks is not
`console.log(apiKey)` — it's `console.log('Tool result:', JSON.stringify(toolOutput))`
where `toolOutput` happens to contain an API response with a credential field.
The scrubber catches this even when the caller doesn't know the payload contains secrets.

### How to verify

```ts
import { scrubSecrets } from './src/security/vault';

scrubSecrets('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abc.def');
// → 'Authorization: [REDACTED]'

scrubSecrets('{"api_key": "sk-abc123456789012345678"}');
// → '{"api_key": "[REDACTED]"}'

scrubSecrets('normal log message with no secrets');
// → 'normal log message with no secrets'  (unchanged)
```

---

## Change 003 — OAuth Token Storage Hardened (`src/auth/openai-oauth.ts`)

**Date:** 2026-02-28
**Threat addressed:** Plaintext OAuth tokens in `credentials/oauth-openai.json`

### What changed

**Before:** `saveTokens()` wrote a raw JSON file to
`.smallclaw/credentials/oauth-openai.json` containing `access_token`,
`refresh_token`, `api_key`, and `id_token` in plaintext. Anyone with filesystem
access (another process, a compromised tool with read scope) could read all tokens.

**After:** `saveTokens()` stores the token bundle via `SecretVault` under the
key `openai.oauth_tokens`, AES-256-GCM encrypted at rest. The plaintext file
no longer exists after first run.

**Auto-migration:** `loadTokens()` now calls `migrateLegacyCredentials()` on
every load. If the old `oauth-openai.json` exists, it is automatically moved
into the vault and the plaintext file is deleted. Users do not need to
re-authenticate.

TTL: vault entry for OAuth tokens is set to 8 hours (tokens have their own
`expires_at` field internally; the vault TTL is an outer safety net).

Security events are emitted to `security.log` for migration, save, and clear operations.

### Files changed

| File | Change |
|------|--------|
| `src/auth/openai-oauth.ts` | **Modified** — vault-backed token storage, auto-migration, security logging |

### How to verify

1. Before updating: note that `.smallclaw/credentials/oauth-openai.json` exists and is readable.
2. After updating and restarting SmallClaw: the file should be gone.
3. `.smallclaw/vault/vault.enc` should contain a `openai.oauth_tokens` entry with no readable token strings.
4. `.smallclaw/vault/vault-audit.log` should show `migration:oauth` and `oauth:save` entries.

---

## Change 004 — Secure Logger wired into Provider Factory (`src/providers/factory.ts`)

**Date:** 2026-02-28
**Threat addressed:** Miscellaneous log hardening; consistent logging approach

### What changed

`console.warn()` in the provider factory fallback path replaced with `log.warn()`
from the secure logger. This ensures even the fallback path benefits from
secret scrubbing.

This is a small change but establishes the pattern: **all new code in SmallClaw
must use `log.*` from `src/security/log-scrubber.ts` rather than `console.*`.**
Existing `console.*` calls will be migrated progressively.

### Files changed

| File | Change |
|------|--------|
| `src/providers/factory.ts` | **Modified** — `console.warn` → `log.warn` |

---

## What's Next

The following are queued for the next session:

### Section 1.2 — Scoped Token Lifecycle
- Per-connector token storage with individual vault keys (`connector.<id>.token`)
- Rotation hook infrastructure (`vault.rotate()` is already implemented)
- Short TTL enforcement per token type (1h action, 8h read-only)
- Token revocation test harness

### Section 1.4 — Egress Controls
- Domain allowlist in config (`tools.permissions.network.allowed_domains`)
- Network-layer enforcement wrapper around `fetch` / outbound HTTP calls
- Block internal network ranges from agent-triggered requests (SSRF prevention)
- First-time domain alert to `security.log`

### Section 2.x — Lethal Trifecta
- Path allowlists on file connector (already partially in config, needs enforcement)
- Content quarantine / source tagging before LLM ingestion
- Outbound action confirmation gate for irreversible actions
- Session isolation (no cross-session persistent state by default)
- Memory write approval for externally-sourced content

---

*This log is maintained alongside the SmallClaw Security Architecture document (v0.1).*
*Each entry here corresponds to a control in that document.*
