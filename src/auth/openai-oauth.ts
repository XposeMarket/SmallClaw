/**
 * openai-oauth.ts
 * Handles the full OpenAI Codex OAuth PKCE flow.
 *
 * Key insight from the actual Codex CLI (codex-rs/login/src/server.rs):
 *   - The OAuth access_token IS the bearer token for chatgpt.com/backend-api
 *   - JWT claims are nested under 'https://api.openai.com/auth' namespace
 *   - Token exchange for an API key is optional; CLI continues without it on failure
 *   - The refresh flow returns a new access_token + id_token
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';
import { getVault } from '../security/vault';
import { log } from '../security/log-scrubber';

// ─── Constants ──────────────────────────────────────────────────────────────────

const AUTH_URL      = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL     = 'https://auth.openai.com/oauth/token';
const CALLBACK_HOST = process.env.SMALLCLAW_OPENAI_OAUTH_HOST || 'localhost';
const CALLBACK_PORT = Number(process.env.SMALLCLAW_OPENAI_OAUTH_PORT || '1455');
const CALLBACK_PATH = '/auth/callback';
const CALLBACK_URL  = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Public OAuth client ID used by the official Codex CLI
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// ─── Token Storage ──────────────────────────────────────────────────────────────

export interface OAuthTokens {
  /** OAuth access_token — used as Bearer token for chatgpt.com/backend-api/codex */
  access_token: string;
  /** Optional API key from token exchange — for api.openai.com if needed */
  api_key?: string;
  refresh_token: string;
  expires_at: number; // Unix ms
  account_id?: string;
  id_token?: string;
}

// ─── JWT helpers ────────────────────────────────────────────────────────────────

/**
 * Decode claims from an OpenAI JWT.
 * OpenAI nests org/account claims under the 'https://api.openai.com/auth' key.
 */
function decodeJwtClaims(jwt: string): Record<string, any> {
  const parts = String(jwt).split('.');
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    const ns = payload['https://api.openai.com/auth'];
    return (ns && typeof ns === 'object') ? ns : payload;
  } catch {
    return {};
  }
}

// ─── Optional token exchange ────────────────────────────────────────────────────

async function tryExchangeForApiKey(idToken: string): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id:          CLIENT_ID,
      requested_token:    'openai-api-key',
      subject_token:      idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    });
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.access_token || null;
  } catch {
    return null;
  }
}

// ─── Pending / active flow state ────────────────────────────────────────────────

interface OAuthFlowState {
  verifier: string;
  state: string;
  authUrl: string;
  createdAt: number;
}

const FLOW_TTL_MS = 10 * 60 * 1000;
const activeFlows = new Map<string, OAuthFlowState>();

function setFlow(configDir: string, flow: OAuthFlowState) {
  activeFlows.set(path.resolve(configDir), flow);
}
function getFlow(configDir: string): OAuthFlowState | null {
  const f = activeFlows.get(path.resolve(configDir));
  if (!f) return null;
  if (Date.now() - f.createdAt > FLOW_TTL_MS) { activeFlows.delete(path.resolve(configDir)); return null; }
  return f;
}
function clearFlow(configDir: string) {
  activeFlows.delete(path.resolve(configDir));
}

// ─── Credential storage (vault-backed) ──────────────────────────────────────────
// Tokens are stored AES-256-GCM encrypted via SecretVault.
// The legacy plaintext oauth-openai.json is migrated on first load and removed.

const VAULT_KEY = 'openai.oauth_tokens';

/** Migrate legacy plaintext credentials file into vault, then delete it */
function migrateLegacyCredentials(configDir: string): void {
  const legacyPath = path.join(configDir, 'credentials', 'oauth-openai.json');
  if (!fs.existsSync(legacyPath)) return;
  try {
    const raw  = fs.readFileSync(legacyPath, 'utf-8');
    const data = JSON.parse(raw) as OAuthTokens;
    // Validate it looks like tokens before migrating
    if (!data.access_token || !data.refresh_token) return;
    getVault(configDir).set(VAULT_KEY, JSON.stringify(data), 'migration:oauth');
    fs.unlinkSync(legacyPath);
    log.security('[oauth] Migrated plaintext credentials to vault and removed legacy file');
  } catch (err) {
    log.warn('[oauth] Legacy credential migration failed:', String(err));
  }
}

export function loadTokens(configDir: string): OAuthTokens | null {
  migrateLegacyCredentials(configDir);
  const vault  = getVault(configDir);
  const secret = vault.get(VAULT_KEY, 'oauth:load');
  if (!secret) return null;
  try {
    return JSON.parse(secret.expose()) as OAuthTokens;
  } catch {
    return null;
  }
}

export function saveTokens(configDir: string, tokens: OAuthTokens): void {
  // access_token and refresh_token must NEVER appear in any log
  const vault = getVault(configDir);
  // 8-hour TTL on storage (tokens have their own expiry tracked inside)
  vault.set(VAULT_KEY, JSON.stringify(tokens), 'oauth:save', 8 * 60 * 60 * 1000);
  log.security('[oauth] Tokens saved to vault (account:', tokens.account_id ?? 'unknown', ')');
}

export function clearTokens(configDir: string): void {
  getVault(configDir).delete(VAULT_KEY, 'oauth:clear');
  log.security('[oauth] Tokens cleared from vault');
}

export function isConnected(configDir: string): boolean {
  return loadTokens(configDir) !== null;
}

// ─── PKCE ───────────────────────────────────────────────────────────────────────

function generateVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}
function generateChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── Token refresh ──────────────────────────────────────────────────────────────

export async function refreshTokens(configDir: string): Promise<OAuthTokens> {
  const existing = loadTokens(configDir);
  if (!existing?.refresh_token) throw new Error('No refresh token — please reconnect.');

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: existing.refresh_token,
      client_id:     CLIENT_ID,
    }).toString(),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Token refresh failed (${res.status}): ${txt.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const idToken = data.id_token || existing.id_token;
  const apiKey  = idToken ? await tryExchangeForApiKey(idToken) : existing.api_key;

  const claims = idToken ? decodeJwtClaims(idToken) : {};
  const accountId = claims.chatgpt_account_id || claims.sub || existing.account_id;

  const tokens: OAuthTokens = {
    access_token:  data.access_token || existing.access_token,
    api_key:       apiKey ?? existing.api_key,
    refresh_token: data.refresh_token || existing.refresh_token,
    expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
    account_id:    accountId,
    id_token:      idToken,
  };
  saveTokens(configDir, tokens);
  return tokens;
}

// ─── Get valid token (auto-refresh) ────────────────────────────────────────────

export async function getValidToken(configDir: string): Promise<string> {
  let tokens = loadTokens(configDir);
  if (!tokens) throw new Error('Not connected to OpenAI. Go to Settings → Models → OpenAI Codex and click Connect.');

  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    tokens = await refreshTokens(configDir);
  }
  return tokens.access_token;
}

// ─── OAuth flow ─────────────────────────────────────────────────────────────────

export interface OAuthFlowResult {
  success: boolean;
  account_id?: string;
  error?: string;
  needsManualPaste?: boolean;
  authUrl?: string;
}

export async function startOAuthFlow(configDir: string): Promise<OAuthFlowResult> {
  const existing = getFlow(configDir);
  if (existing) {
    return { success: false, needsManualPaste: true, authUrl: existing.authUrl,
      error: 'OAuth already in progress — finish the existing browser tab.' };
  }

  const verifier  = generateVerifier();
  const challenge = generateChallenge(verifier);
  const state     = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    response_type:              'code',
    client_id:                  CLIENT_ID,
    redirect_uri:               CALLBACK_URL,
    scope:                      'openid profile email offline_access',
    code_challenge:             challenge,
    code_challenge_method:      'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow:  'true',
    originator:                 'codex_cli_rs',
  });

  const authUrl = `${AUTH_URL}?${params.toString()}`;
  setFlow(configDir, { verifier, state, authUrl, createdAt: Date.now() });

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) { res.writeHead(404); res.end(); return; }

      const url           = new URL(req.url, `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
      const code          = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error         = url.searchParams.get('error');

      const fail = (msg: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>${msg}</h2><p>You can close this window.</p></body></html>`);
        server.close(); clearFlow(configDir);
        resolve({ success: false, error: msg });
      };

      if (error || !code) return fail(error || 'No code returned');
      if (returnedState !== state) return fail('State mismatch — possible CSRF');

      try {
        const tokenRes = await fetch(TOKEN_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({
            grant_type:    'authorization_code',
            code,
            redirect_uri:  CALLBACK_URL,
            client_id:     CLIENT_ID,
            code_verifier: verifier,
          }).toString(),
        });

        if (!tokenRes.ok) {
          const txt = await tokenRes.text().catch(() => '');
          throw new Error(`Token exchange failed (${tokenRes.status}): ${txt.slice(0, 200)}`);
        }

        const td      = await tokenRes.json() as any;
        const idToken = td.id_token as string | undefined;
        if (!idToken) throw new Error('OAuth response missing id_token');

        const apiKey    = await tryExchangeForApiKey(idToken);
        const claims    = decodeJwtClaims(idToken);
        const accountId = claims.chatgpt_account_id || claims.sub || undefined;

        const tokens: OAuthTokens = {
          access_token:  td.access_token,
          api_key:       apiKey ?? undefined,
          refresh_token: td.refresh_token,
          expires_at:    Date.now() + (td.expires_in || 3600) * 1000,
          account_id:    accountId,
          id_token:      idToken,
        };

        saveTokens(configDir, tokens);
        clearFlow(configDir);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ Connected to SmallClaw!</h2><p>You can close this window and return to the app.</p></body></html>');
        server.close();
        resolve({ success: true, account_id: accountId });
      } catch (err: any) {
        fail(err.message);
      }
    });

    server.on('error', () => {
      resolve({ success: false, needsManualPaste: true, authUrl });
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      openBrowser(authUrl);
      setTimeout(() => {
        server.close(); clearFlow(configDir);
        resolve({ success: false, error: 'Timed out waiting for OAuth callback (5 min).' });
      }, 5 * 60 * 1000);
    });
  });
}

// ─── Manual paste fallback ──────────────────────────────────────────────────────

export async function exchangeManualCodeFromPending(
  configDir: string,
  redirectedUrl: string,
): Promise<OAuthFlowResult> {
  const flow = getFlow(configDir);
  if (!flow) return { success: false, error: 'No active OAuth session — click Connect again.' };

  try {
    const url           = new URL(redirectedUrl);
    const code          = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');

    if (!code) return { success: false, error: 'No code in URL.' };
    if (returnedState !== flow.state) return { success: false, error: 'State mismatch.' };

    const tokenRes = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  CALLBACK_URL,
        client_id:     CLIENT_ID,
        code_verifier: flow.verifier,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text().catch(() => '');
      throw new Error(`Token exchange failed (${tokenRes.status}): ${txt.slice(0, 200)}`);
    }

    const td      = await tokenRes.json() as any;
    const idToken = td.id_token as string | undefined;
    if (!idToken) throw new Error('OAuth response missing id_token');

    const apiKey    = await tryExchangeForApiKey(idToken);
    const claims    = decodeJwtClaims(idToken);
    const accountId = claims.chatgpt_account_id || claims.sub || undefined;

    const tokens: OAuthTokens = {
      access_token:  td.access_token,
      api_key:       apiKey ?? undefined,
      refresh_token: td.refresh_token,
      expires_at:    Date.now() + (td.expires_in || 3600) * 1000,
      account_id:    accountId,
      id_token:      idToken,
    };

    saveTokens(configDir, tokens);
    clearFlow(configDir);
    return { success: true, account_id: accountId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
