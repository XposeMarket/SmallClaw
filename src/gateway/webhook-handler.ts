/**
 * webhook-handler.ts — SmallClaw Webhook Endpoint
 *
 * Exposes two core HTTP endpoints on the gateway:
 *
 *   POST /hooks/wake   — lightweight "nudge" that enqueues a system event
 *   POST /hooks/agent  — full agent run in an isolated session, optional reply delivery
 *
 * Auth: Bearer token or x-smallclaw-token header. Query-string tokens rejected (400).
 *
 * Config block in config.json:
 * {
 *   "hooks": {
 *     "enabled": true,
 *     "token": "your-secret-token",
 *     "path": "/hooks"
 *   }
 * }
 */

import express from 'express';
import { getConfig } from '../config/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HookConfig {
  enabled: boolean;
  token: string;
  path: string;
}

export interface WebhookDeps {
  handleChat: (
    message: string,
    sessionId: string,
    sendSSE: (event: string, data: any) => void,
    pinnedMessages?: Array<{ role: string; content: string }>,
    abortSignal?: { aborted: boolean },
    callerContext?: string,
    modelOverride?: string,
    executionMode?: 'interactive' | 'background_task' | 'heartbeat' | 'cron',
  ) => Promise<{ type: string; text: string; thinking?: string }>;
  addMessage: (id: string, msg: { role: 'user' | 'assistant'; content: string; timestamp: number }, options?: { disableMemoryFlushCheck?: boolean; disableCompactionCheck?: boolean }) => void;
  getIsModelBusy: () => boolean;
  broadcast: (data: object) => void;
  deliverTelegram: (text: string) => Promise<void>;
}

// Per-IP failed auth attempt tracking (brute-force rate limiting)
const authFailures = new Map<string, { count: number; lockedUntil: number }>();
const AUTH_RATE_LIMIT_MAX = 5;
const AUTH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const AUTH_RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000; // 15 minute lockout

// ─── Config helpers ────────────────────────────────────────────────────────────

export function resolveHookConfig(): HookConfig {
  const raw = (getConfig().getConfig() as any).hooks || {};
  // HIGH-01 fix: resolve vault reference before returning token
  const rawToken = String(raw.token || '').trim();
  const token = rawToken.startsWith('vault:')
    ? (getConfig().resolveSecret(rawToken) || '')
    : rawToken;
  return {
    enabled: raw.enabled === true,
    token,
    path: String(raw.path || '/hooks').replace(/\/+$/, '') || '/hooks',
  };
}

// ─── Auth middleware ───────────────────────────────────────────────────────────

function getClientIp(req: express.Request): string {
  return String(
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    'unknown'
  ).split(',')[0].trim();
}

function checkRateLimit(ip: string): { blocked: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry) return { blocked: false, retryAfterSeconds: 0 };
  if (entry.lockedUntil > now) {
    return { blocked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  // Lockout expired — clear it
  authFailures.delete(ip);
  return { blocked: false, retryAfterSeconds: 0 };
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= AUTH_RATE_LIMIT_MAX) {
    entry.lockedUntil = now + AUTH_RATE_LIMIT_LOCKOUT_MS;
    console.warn(`[Webhooks] IP ${ip} locked out after ${entry.count} failed auth attempts`);
  }
  authFailures.set(ip, entry);
}

function clearAuthFailures(ip: string): void {
  authFailures.delete(ip);
}

function createAuthMiddleware(getConfig: () => HookConfig) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const cfg = getConfig();
    const ip = getClientIp(req);

    // Check rate limit first
    const rateLimit = checkRateLimit(ip);
    if (rateLimit.blocked) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: 'Too many failed auth attempts. Try again later.',
        retryAfter: rateLimit.retryAfterSeconds,
      });
      return;
    }

    // Reject query-string token (security: tokens must not appear in URLs/logs)
    if (req.query.token) {
      res.status(400).json({ error: 'Query-string tokens are not accepted. Use Authorization header or x-smallclaw-token.' });
      return;
    }

    // Extract token from headers
    const authHeader = String(req.headers['authorization'] || '');
    const xToken = String(req.headers['x-smallclaw-token'] || '');
    let providedToken = '';

    if (authHeader.toLowerCase().startsWith('bearer ')) {
      providedToken = authHeader.slice('bearer '.length).trim();
    } else if (xToken) {
      providedToken = xToken.trim();
    }

    if (!providedToken || providedToken !== cfg.token) {
      recordAuthFailure(ip);
      console.warn(`[Webhooks] Auth failed from ${ip} (${req.method} ${req.path})`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    clearAuthFailures(ip);
    next();
  };
}

// ─── Router builder ────────────────────────────────────────────────────────────

export function buildWebhookRouter(deps: WebhookDeps): express.Router {
  const router = express.Router();
  const auth = createAuthMiddleware(resolveHookConfig);

  // ── POST /wake ──────────────────────────────────────────────────────────────
  // Lightweight nudge — injects a system event into the main session
  router.post('/wake', auth, (req: express.Request, res: express.Response): void => {
    const cfg = resolveHookConfig();
    if (!cfg.enabled) {
      res.status(503).json({ error: 'Webhook system is disabled' });
      return;
    }

    const { text, mode } = req.body || {};
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text (string) is required' });
      return;
    }

    const sessionId = 'webhook_wake';
    const wakeMode = mode === 'next-heartbeat' ? 'next-heartbeat' : 'now';

    console.log(`[Webhooks] /wake: "${text.slice(0, 80)}" mode=${wakeMode}`);

    // Inject as a system event into the main session
    deps.addMessage(sessionId, {
      role: 'assistant',
      content: `[System Event] ${text}`,
      timestamp: Date.now(),
    });

    deps.broadcast({
      type: 'webhook_wake',
      text: text.slice(0, 200),
      mode: wakeMode,
    });

    // If mode=now, trigger an immediate agent run in the background
    if (wakeMode === 'now') {
      const prompt = `[WEBHOOK SYSTEM EVENT]\n${text}\n\nRespond to this event if any action is needed.`;
      runAgentBackground({
        deps,
        sessionId,
        message: prompt,
        name: 'Wake',
        deliver: false,
        executionMode: 'heartbeat',
      });
    }

    res.status(200).json({ ok: true, mode: wakeMode });
  });

  // ── POST /agent ─────────────────────────────────────────────────────────────
  // Full agent run — processes a message and optionally delivers the response
  router.post('/agent', auth, async (req: express.Request, res: express.Response): Promise<void> => {
    const cfg = resolveHookConfig();
    if (!cfg.enabled) {
      res.status(503).json({ error: 'Webhook system is disabled' });
      return;
    }

    const {
      message,
      name,
      sessionKey,
      wakeMode,
      deliver = true,
      channel = 'last',
      model,
      timeoutSeconds,
    } = req.body || {};

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message (string) is required' });
      return;
    }

    const sourceName = String(name || 'Webhook').slice(0, 60);
    const sessionId = sessionKey ? String(sessionKey).slice(0, 120) : `webhook_agent_${Date.now()}`;
    const shouldDeliver = deliver !== false;
    const deliverChannel = String(channel || 'last').toLowerCase();
    const modelOverride = model ? String(model).trim() : undefined;
    const timeoutMs = timeoutSeconds ? Math.min(300_000, Math.max(5_000, Number(timeoutSeconds) * 1000)) : 120_000;

    console.log(`[Webhooks] /agent: source="${sourceName}" session="${sessionId}" deliver=${shouldDeliver} channel=${deliverChannel}`);

    // Respond immediately with 202 — agent runs async
    res.status(202).json({
      ok: true,
      sessionId,
      source: sourceName,
      queued: true,
    });

    // Run agent in background
    runAgentBackground({
      deps,
      sessionId,
      message,
      name: sourceName,
      deliver: shouldDeliver,
      channel: deliverChannel,
      modelOverride,
      timeoutMs,
      executionMode: 'background_task',
    });
  });

  // ── POST /status ────────────────────────────────────────────────────────────
  // Health check (authed)
  router.get('/status', auth, (_req: express.Request, res: express.Response): void => {
    const cfg = resolveHookConfig();
    res.json({
      ok: true,
      enabled: cfg.enabled,
      path: cfg.path,
      modelBusy: deps.getIsModelBusy(),
    });
  });

  return router;
}

// ─── Background agent runner ──────────────────────────────────────────────────

interface RunAgentOptions {
  deps: WebhookDeps;
  sessionId: string;
  message: string;
  name: string;
  deliver: boolean;
  channel?: string;
  modelOverride?: string;
  timeoutMs?: number;
  executionMode?: 'interactive' | 'background_task' | 'heartbeat' | 'cron';
}

async function runAgentBackground(opts: RunAgentOptions): Promise<void> {
  const {
    deps,
    sessionId,
    message,
    name,
    deliver,
    channel = 'last',
    modelOverride,
    timeoutMs = 120_000,
    executionMode = 'background_task',
  } = opts;

  const callerContext = [
    `CONTEXT: This is an automated webhook message from source "${name}".`,
    'You are running in background task mode. Execute the requested task autonomously.',
    'Do not ask clarifying questions. Complete the task and summarize the outcome.',
  ].join('\n');

  const events: Array<{ type: string; data: any }> = [];
  const sendSSE = (type: string, data: any) => events.push({ type, data });

  // Store incoming message
  deps.addMessage(sessionId, {
  role: 'user',
  content: message,
  timestamp: Date.now(),
  }, { disableMemoryFlushCheck: true, disableCompactionCheck: true });

  const timeoutSignal = { aborted: false };
  const timeoutTimer = setTimeout(() => {
    timeoutSignal.aborted = true;
    console.warn(`[Webhooks] Agent run for "${name}" timed out after ${timeoutMs}ms`);
  }, timeoutMs);

  try {
    console.log(`[Webhooks] Starting agent run: source="${name}" session="${sessionId}"`);

    const result = await deps.handleChat(
      message,
      sessionId,
      sendSSE,
      undefined,
      timeoutSignal,
      callerContext,
      modelOverride,
      executionMode,
    );

    clearTimeout(timeoutTimer);

    const responseText = result.text || 'No response generated.';
    console.log(`[Webhooks] Agent run complete: source="${name}" response="${responseText.slice(0, 80)}"`);

    // Store response
    deps.addMessage(sessionId, {
      role: 'assistant',
      content: responseText,
      timestamp: Date.now(),
    }, { disableMemoryFlushCheck: true, disableCompactionCheck: true });

    // Deliver response if requested
    if (deliver && responseText.trim()) {
      if (channel === 'telegram' || channel === 'last') {
        try {
          await deps.deliverTelegram(`[${name}]\n${responseText}`);
          console.log(`[Webhooks] Delivered response to Telegram for source="${name}"`);
        } catch (err: any) {
          console.warn(`[Webhooks] Telegram delivery failed: ${err.message}`);
        }
      }
    }

    // Broadcast to web UI
    deps.broadcast({
      type: 'webhook_agent_complete',
      source: name,
      sessionId,
      response: responseText.slice(0, 300),
    });

  } catch (err: any) {
    clearTimeout(timeoutTimer);
    console.error(`[Webhooks] Agent run error (source="${name}"):`, err.message);
    deps.broadcast({
      type: 'webhook_agent_error',
      source: name,
      sessionId,
      error: err.message,
    });
  }
}
