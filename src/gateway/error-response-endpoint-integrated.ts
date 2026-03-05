// src/gateway/error-response-endpoint-integrated.ts
// Integrated error response endpoint — wires all error response subsystems together

import type { Express, Request, Response } from 'express';
import { errorCategorizer } from './error-categorizer';
import { getErrorTemplate } from './error-templates';
import { getVerificationFlowManager } from './verification-flow';
import { getCredentialHandler } from '../security/credential-handler';
import { getErrorAnalyzer } from './error-analyzer';
import { getErrorHistory } from './error-history';
import { getRetryStrategy } from './retry-strategy';
import { getVisualErrorDetector } from './visual-error-detection';
import { getErrorAudit } from '../security/error-audit';
import { getContextInjectionManager } from './context-injection';

// In-memory store for pending error responses awaiting user input
const pendingErrors: Map<string, {
  taskId: string;
  errorId: string;
  category: string;
  template: any;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutHandle: NodeJS.Timeout;
  createdAt: number;
}> = new Map();

export function setupErrorResponseEndpoint(app: Express): void {
  console.log('[ErrorResponse] Setting up integrated error response endpoints...');

  // ─── POST /api/error-response/detect ──────────────────────────────────────
  // Analyze an error and return categorization + template
  app.post('/api/error-response/detect', (req: Request, res: Response) => {
    const { errorMessage, taskId, pageText, pageTitle } = req.body || {};
    if (!errorMessage && !pageText) {
      return res.status(400).json({ error: 'errorMessage or pageText required' });
    }

    const analyzer = getErrorAnalyzer();
    const visualDetector = getVisualErrorDetector();
    const history = getErrorHistory();

    // Try learned patterns first
    let result = analyzer.analyze(errorMessage || '');

    // Try text categorizer
    const categorization = errorCategorizer.categorizeError(errorMessage || '', { taskId });

    // Try visual detection from page content
    let visualResult = null;
    if (pageText) {
      visualResult = visualDetector.analyzePageContent(pageText, pageTitle);
    }

    // Pick the best signal
    let finalCategory = categorization.category;
    let finalConfidence = categorization.confidence;

    if (result.suggestedCategory && result.confidence > finalConfidence) {
      finalCategory = result.suggestedCategory as typeof finalCategory;
      finalConfidence = result.confidence;
    }

    if (visualResult?.hasError && visualResult.topConfidence > finalConfidence) {
      finalCategory = (visualResult.topCategory || finalCategory) as typeof finalCategory;
      finalConfidence = visualResult.topConfidence;
    }

    // Record in history and analyzer
    if (finalCategory !== 'unknown') {
      analyzer.recordError(errorMessage || pageText || '', finalCategory);
      history.add({
        taskId,
        errorMessage: (errorMessage || '').substring(0, 200),
        category: finalCategory,
        resolved: false,
      });
    }

    // Try to get audit logger (may not be initialized yet)
    try {
      const audit = getErrorAudit('');
      audit.logErrorDetected(taskId || 'unknown', finalCategory, (errorMessage || '').substring(0, 100));
    } catch {}

    const template = categorization.template || (finalCategory !== 'unknown' ? getErrorTemplate(finalCategory + '_required') : null);

    return res.json({
      category: finalCategory,
      confidence: finalConfidence,
      template: template || null,
      hasTemplate: !!template,
      visualSignals: visualResult?.signals || [],
    });
  });

  // ─── POST /api/error-response/present ─────────────────────────────────────
  // Present an error to the user and wait for their response
  app.post('/api/error-response/present', (req: Request, res: Response) => {
    const { taskId, errorId, category, timeoutMs = 5 * 60 * 1000 } = req.body || {};
    if (!taskId || !errorId) {
      return res.status(400).json({ error: 'taskId and errorId required' });
    }

    const template = getErrorTemplate(errorId);
    if (!template) {
      return res.status(404).json({ error: `No template found for errorId: ${errorId}` });
    }

    const pendingId = `${taskId}_${Date.now()}`;
    const responsePromise = new Promise<any>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        pendingErrors.delete(pendingId);
        reject(new Error('User response timeout'));
      }, timeoutMs);

      pendingErrors.set(pendingId, {
        taskId,
        errorId,
        category,
        template,
        resolve,
        reject,
        timeoutHandle,
        createdAt: Date.now(),
      });
    });

    return res.json({
      pendingId,
      template,
      message: 'Error presented to user. Use pendingId to poll for response.',
    });
  });

  // ─── GET /api/error-response/pending ──────────────────────────────────────
  // Get all pending errors (for UI to display)
  app.get('/api/error-response/pending', (_req: Request, res: Response) => {
    const result = [];
    for (const [id, entry] of pendingErrors) {
      result.push({
        pendingId: id,
        taskId: entry.taskId,
        errorId: entry.errorId,
        category: entry.category,
        template: entry.template,
        waitingFor: Math.round((Date.now() - entry.createdAt) / 1000) + 's',
      });
    }
    return res.json({ pending: result, count: result.length });
  });

  // ─── POST /api/error-response/respond ─────────────────────────────────────
  // Submit user response to a pending error
  app.post('/api/error-response/respond', (req: Request, res: Response) => {
    const { pendingId, action, inputs, credentialData } = req.body || {};
    if (!pendingId || !action) {
      return res.status(400).json({ error: 'pendingId and action required' });
    }

    const entry = pendingErrors.get(pendingId);
    if (!entry) {
      return res.status(404).json({ error: 'Pending error not found or already resolved' });
    }

    clearTimeout(entry.timeoutHandle);
    pendingErrors.delete(pendingId);

    // Store credentials securely if provided
    let credentialId: string | null = null;
    if (credentialData && Object.keys(credentialData).length > 0) {
      try {
        const credHandler = getCredentialHandler();
        credentialId = credHandler.store(entry.taskId, entry.category as any, credentialData);
        try {
          const audit = getErrorAudit('');
          audit.logCredentialProvided(entry.taskId, entry.category);
        } catch {}
      } catch (err) {
        console.warn('[ErrorResponse] Could not store credentials (handler not initialized):', err);
      }
    }

    // Record resolution
    const history = getErrorHistory();
    const analyzer = getErrorAnalyzer();
    const isResolved = action !== 'cancel';

    history.resolve(pendingId, action);
    analyzer.recordResolution(entry.errorId, isResolved);

    try {
      const audit = getErrorAudit('');
      audit.logResolution(entry.taskId, action, isResolved);
    } catch {}

    // Resolve the promise
    entry.resolve({ action, inputs: inputs || {}, credentialId });

    return res.json({
      success: true,
      message: `Response recorded: ${action}`,
      credentialStored: !!credentialId,
      credentialId,
    });
  });

  // ─── POST /api/error-response/retry ───────────────────────────────────────
  // Calculate next retry delay for a task
  app.post('/api/error-response/retry', (req: Request, res: Response) => {
    const { taskId, maxAttempts, baseDelayMs, maxDelayMs } = req.body || {};
    if (!taskId) return res.status(400).json({ error: 'taskId required' });

    const retryStrategy = getRetryStrategy();

    let state = retryStrategy.getState(taskId);
    if (!state) {
      state = retryStrategy.createRetryState(taskId, { maxAttempts, baseDelayMs, maxDelayMs });
    }

    const result = retryStrategy.recordAttempt(taskId);
    if (result.canRetry) {
      try {
        const audit = getErrorAudit('');
        audit.logRetryAttempt(taskId, result.attemptsUsed, result.delayMs);
      } catch {}
    }

    return res.json(result);
  });

  // ─── POST /api/error-response/inject-context ──────────────────────────────
  // Inject error context into a prompt
  app.post('/api/error-response/inject-context', (req: Request, res: Response) => {
    const { prompt, errorContext } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const injectionManager = getContextInjectionManager();
    const result = injectionManager.inject(prompt, errorContext);
    return res.json(result);
  });

  // ─── GET /api/error-response/history ──────────────────────────────────────
  // Get recent error history
  app.get('/api/error-response/history', (req: Request, res: Response) => {
    const { taskId, limit = '50' } = req.query as Record<string, string>;
    const history = getErrorHistory();

    const records = taskId
      ? history.getByTask(taskId)
      : history.getRecent(parseInt(limit, 10));

    return res.json({ records, stats: history.getStats() });
  });

  // ─── GET /api/error-response/stats ────────────────────────────────────────
  // System-wide stats
  app.get('/api/error-response/stats', (_req: Request, res: Response) => {
    const analyzer = getErrorAnalyzer();
    const history = getErrorHistory();
    const verificationFlowManager = getVerificationFlowManager();

    return res.json({
      analyzer: analyzer.getStats(),
      history: history.getStats(),
      pendingErrors: pendingErrors.size,
    });
  });

  // ─── POST /api/error-response/verification-flow ───────────────────────────
  // Create an OAuth/2FA verification flow session
  app.post('/api/error-response/verification-flow', (req: Request, res: Response) => {
    const { taskId, initialStep } = req.body || {};
    if (!taskId) return res.status(400).json({ error: 'taskId required' });

    const manager = getVerificationFlowManager();
    const session = manager.createSession(taskId, initialStep);
    return res.json({ session });
  });

  // ─── GET /api/error-response/verification-flow/:sessionId ─────────────────
  app.get('/api/error-response/verification-flow/:sessionId', (req: Request, res: Response) => {
    const manager = getVerificationFlowManager();
    const session = manager.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });
    return res.json({ session });
  });

  console.log('[ErrorResponse] ✅ 10 integrated endpoints registered:');
  console.log('[ErrorResponse]   POST /api/error-response/detect');
  console.log('[ErrorResponse]   POST /api/error-response/present');
  console.log('[ErrorResponse]   GET  /api/error-response/pending');
  console.log('[ErrorResponse]   POST /api/error-response/respond');
  console.log('[ErrorResponse]   POST /api/error-response/retry');
  console.log('[ErrorResponse]   POST /api/error-response/inject-context');
  console.log('[ErrorResponse]   GET  /api/error-response/history');
  console.log('[ErrorResponse]   GET  /api/error-response/stats');
  console.log('[ErrorResponse]   POST /api/error-response/verification-flow');
  console.log('[ErrorResponse]   GET  /api/error-response/verification-flow/:id');
}
