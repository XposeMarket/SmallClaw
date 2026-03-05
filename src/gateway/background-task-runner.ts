/**
 * background-task-runner.ts
 *
 * Executes a TaskRecord autonomously in the background, detached from any HTTP request.
 * Re-enters handleChat() round-by-round using the task's stored context.
 * Writes progress to the task journal. Broadcasts status updates via WebSocket.
 */

import {
  loadTask,
  saveTask,
  updateTaskStatus,
  appendJournal,
  mutatePlan,
  updateResumeContext,
  resolveSubagentCompletion,
  type TaskRecord,
} from './task-store';
import { clearHistory, addMessage, getHistory, flushSession } from './session';
import { callSecondaryTaskStepAuditor } from '../orchestration/multi-agent';
import { errorCategorizer } from './error-categorizer';
import { getRetryStrategy } from './retry-strategy';
import { getErrorAnalyzer } from './error-analyzer';
import { getErrorHistory } from './error-history';
import {
  callErrorHealer,
  callCompletionVerifier,
  MAX_HEAL_ATTEMPTS,
} from './task-self-healer';

// Pause registry (global singleton map).
// Server-v2 calls BackgroundTaskRunner.requestPause(id) to signal a running
// task it should stop at the next round boundary.
const pauseRequests = new Set<string>();

// Active runners (prevents duplicate concurrent runners for same task).
const activeRunners = new Set<string>();
const MAX_RESUME_MESSAGES = 10;
const BACKGROUND_SESSION_MAX_MESSAGES = 40;
const DEFAULT_ROUND_TIMEOUT_MS = 120_000;
const MAX_STEP_VERIFICATION_RETRIES = 2;

function resolveRoundTimeoutMs(isResearchTask?: boolean): number {
  const candidates = [
    process.env.LOCALCLAW_BG_ROUND_TIMEOUT_MS,
    process.env.LOCALCLAW_TASK_ROUND_TIMEOUT_MS,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 10_000) return Math.floor(n);
  }
  // Research tasks (web search, browser automation, news aggregation) need longer timeout
  // to account for API calls, page loading, and content synthesis (5 min)
  if (isResearchTask) {
    return 300_000; // 5 minutes for research tasks
  }
  return DEFAULT_ROUND_TIMEOUT_MS; // 2 minutes for regular tasks
}

export class BackgroundTaskRunner {
  private taskId: string;
  private handleChat: (
    message: string,
    sessionId: string,
    sendSSE: (event: string, data: any) => void,
    pinnedMessages?: Array<{ role: string; content: string }>,
    abortSignal?: { aborted: boolean },
    callerContext?: string,
    modelOverride?: string,
    executionMode?: 'interactive' | 'background_task' | 'heartbeat' | 'cron',
  ) => Promise<{ type: string; text: string; thinking?: string }>;
  private broadcast: (data: object) => void;
  private telegramChannel: {
    sendToAllowed: (text: string) => Promise<void>;
    sendMessage?: (chatId: number, text: string) => Promise<void>;
  } | null;
  private openingAction: string | undefined;

  constructor(
    taskId: string,
    handleChat: BackgroundTaskRunner['handleChat'],
    broadcast: (data: object) => void,
    telegramChannel: {
      sendToAllowed: (text: string) => Promise<void>;
      sendMessage?: (chatId: number, text: string) => Promise<void>;
    } | null,
    openingAction?: string,
  ) {
    this.taskId = taskId;
    this.handleChat = handleChat;
    this.broadcast = broadcast;
    this.telegramChannel = telegramChannel;
    this.openingAction = openingAction;
  }

  static requestPause(taskId: string): void {
    pauseRequests.add(taskId);
  }

  static isRunning(taskId: string): boolean {
    return activeRunners.has(taskId);
  }

  /**
   * Force-release a task from activeRunners.
   * Only use when a runner is confirmed dead (e.g. stale 'running' status with no live runner).
   */
  static forceRelease(taskId: string): void {
    if (activeRunners.has(taskId)) {
      console.warn(`[BackgroundTaskRunner] Force-releasing stale activeRunners entry for task ${taskId}`);
      activeRunners.delete(taskId);
      pauseRequests.delete(taskId);
    }
  }

  /**
   * Get list of all currently running task IDs
   */
  static getRunningTasks(): string[] {
    return Array.from(activeRunners);
  }

  /**
   * Interrupt a task for schedule execution
   * Marks the task with schedule context so heartbeat can resume it later
   */
  static interruptTaskForSchedule(taskId: string, scheduleId: string): boolean {
    if (!activeRunners.has(taskId)) {
      return false; // Task not running
    }
    const task = loadTask(taskId);
    if (!task) return false;
    
    // Mark task with schedule interruption context
    updateTaskStatus(taskId, 'paused', {
      pauseReason: 'interrupted_by_schedule',
      pausedByScheduleId: scheduleId,
      pausedAt: Date.now(),
      pausedAtStepIndex: task.currentStepIndex,
      shouldResumeAfterSchedule: true,
    });
    
    // Request pause at next round boundary
    pauseRequests.add(taskId);
    
    console.log(`[BackgroundTaskRunner] Task ${taskId} interrupted by schedule ${scheduleId}`);
    return true;
  }

  /**
   * Resume a task that was paused by a schedule
   */
  static resumeTaskAfterSchedule(taskId: string, scheduleId: string): boolean {
    const task = loadTask(taskId);
    if (!task) return false;
    
    // Only resume if it was paused by this specific schedule
    if (task.pausedByScheduleId !== scheduleId) {
      console.warn(`[BackgroundTaskRunner] Task ${taskId} not paused by schedule ${scheduleId}`);
      return false;
    }
    
    // Clear pause context and mark for resumption
    updateTaskStatus(taskId, 'running', {
      pauseReason: undefined,
      pausedByScheduleId: undefined,
      pausedAt: undefined,
      pausedAtStepIndex: undefined,
      shouldResumeAfterSchedule: false,
    });
    
    // Start a new runner if not already active
    if (!activeRunners.has(taskId)) {
      console.log(`[BackgroundTaskRunner] Resuming task ${taskId} after schedule ${scheduleId} completed`);
      // Note: caller should invoke new BackgroundTaskRunner(taskId, ...).start()
    }
    
    return true;
  }

  async start(): Promise<void> {
    const { taskId } = this;

    if (activeRunners.has(taskId)) {
      console.log(`[BackgroundTaskRunner] Task ${taskId} already running - skipping duplicate start.`);
      return;
    }

    const task = loadTask(taskId);
    if (!task) {
      console.error(`[BackgroundTaskRunner] Task ${taskId} not found.`);
      return;
    }

    if (task.status === 'complete' || task.status === 'failed') {
      console.log(`[BackgroundTaskRunner] Task ${taskId} is already ${task.status} - nothing to do.`);
      return;
    }

    activeRunners.add(taskId);
    pauseRequests.delete(taskId);

    try {
      await this._run();
    } finally {
      activeRunners.delete(taskId);
      pauseRequests.delete(taskId);
    }
  }

  private _buildCallerContext(task: TaskRecord): string {
    const profileNote = task.subagentProfile
      ? `\nSub-agent role: ${task.subagentProfile}. Stay focused on your assigned task only. Do NOT call delegate_to_specialist or subagent_spawn.`
      : '';
    const resumeNote = task.resumeContext?.onResumeInstruction
      ? `\n${task.resumeContext.onResumeInstruction}`
      : '';
    
    // Add specific guidance for research/news tasks
    const isResearchTask = /\b(research|search|news|articles?|web.*search|browser|gather|collect|summari)\b/i.test(
      task.prompt + ' ' + task.title
    );
    // Detect X.com / Twitter tasks and inject login state guidance
    const isXTask = /\b(x\.com|twitter|tweet|retweet|post.*tweet|reply.*tweet)\b/i.test(
      task.prompt + ' ' + task.title
    );
    const xLoginGuidance = isXTask
      ? `\nX.COM LOGIN NOTE: If the browser page title shows "(N) Home / X", "Home / X", or any title ending in "/ X", ` +
        `the user IS already logged in to X — do NOT ask to confirm login or suggest they log in. ` +
        `Proceed directly with the task action (compose tweet, click reply, etc.).` +
        `\nX.COM POSTING FLOW: When posting a tweet, follow EXACTLY these steps and NO others:\n` +
        `  1. browser_open("https://x.com") — the snapshot shows the composer at the top.\n` +
        `  2. Find the textbox with name "Post text" or "What's happening" in the snapshot — browser_fill it.\n` +
        `  3. The fill result shows "⚠️ COMPOSER SUBMIT BUTTON: @N" — browser_click(@N) immediately.\n` +
        `  4. If browser_fill auto-posted (result says "Tweet has been posted successfully"), you are DONE. Stop immediately.\n` +
        `  5. Only call browser_snapshot ONCE to verify if auto-post did NOT happen. Then STOP.\n` +
        `Do NOT scroll, press PageDown, or take additional snapshots after confirming the tweet posted. ` +
        `Do NOT call browser_snapshot before filling. ` +
        `Do NOT call browser_snapshot after browser_open — it already returned a snapshot. ` +
        `After the tweet is confirmed posted, your ONLY valid next action is writing your FINAL: summary. ` +
        `There are ZERO valid reasons to scroll before filling the composer or after confirming the post.`
      : '';
    
    const researchGuidance = isResearchTask ? [
      ``,
      `[RESEARCH TASK GUIDANCE - SNAPSHOT → FETCH → SYNTHESIZE FLOW]`,
      `Your research follows a strict 3-phase flow. Execute each phase fully before moving to the next:`,
      ``,
      `PHASE 1: COLLECT SNAPSHOTS (identify article sources)`,
      `  • browser_open() to news sites (Reuters, AP, BBC, CNN, etc)`,
      `  • browser_snapshot() to see the page structure`,
      `  • Look at the snapshot Elements list - find links/headlines (elements with @##)`,
      `  • Do NOT stop at snapshot. Always proceed to Phase 2.`,
      ``,
      `PHASE 2: FETCH CONTENT (extract actual article text)`,
      `  • From snapshot elements, identify article URLs in the link references`,
      `  • Use web_fetch(url) on 4-6 different article URLs to get full text`,
      `  • Store key facts/headlines from each article as you fetch`,
      `  • After fetching articles, you have real data to work with`,
      ``,
      `PHASE 3: SYNTHESIZE (analyze and deliver final answer)`,
      `  • Review all fetched content together - identify 3-5 most significant events`,
      `  • Cross-reference facts (does story appear in multiple sources?)`,
      `  • Create concise bullets with facts + source attribution`,
      `  • Deliver final summary to user with citations`,
      ``,
      `CRITICAL: If you say "Snapshot complete. Awaiting next directive" — STOP and re-read this.`,
      `That phrase means you've stalled in Phase 1. CONTINUE to Phase 2: use web_fetch() on URLs.`,
      `Each phase builds on the previous. Do not pause between phases; execute the full flow.`,
      `[/RESEARCH TASK GUIDANCE]`,
    ].join('\n') : '';
    
    return [
      `[BACKGROUND TASK CONTEXT]`,
      `Task ID: ${task.id}`,
      `Task Title: ${task.title}`,
      `Original Request: ${task.prompt.slice(0, 400)}`,
      `Current Step: ${task.currentStepIndex + 1}/${task.plan.length}`,
      task.plan[task.currentStepIndex]
        ? `Step Description: ${task.plan[task.currentStepIndex].description}`
        : '',
      `You are running autonomously. Execute the task step by step.${profileNote}${resumeNote}${xLoginGuidance}${researchGuidance}`,
      `[/BACKGROUND TASK CONTEXT]`,
    ].filter(Boolean).join('\n');
  }

  private _restoreSessionForRetry(sessionId: string, resumeMessages: any[]): void {
    clearHistory(sessionId);
    for (const msg of resumeMessages) {
      if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
        addMessage(sessionId, {
          role: msg.role,
          content: String(msg.content || ''),
          timestamp: msg.timestamp || Date.now(),
        }, {
          disableMemoryFlushCheck: true,
          disableCompactionCheck: true,
          disableAutoSave: true,
          maxMessages: BACKGROUND_SESSION_MAX_MESSAGES,
        });
      }
    }
  }

  private _persistResumeContextSnapshot(taskId: string, sessionId: string): void {
    const task = loadTask(taskId);
    const existingRound = Number(task?.resumeContext?.round) || 0;
    const sessionHistory = getHistory(sessionId, 40);
    updateResumeContext(taskId, {
      messages: sessionHistory.slice(-MAX_RESUME_MESSAGES).map(h => ({
        role: h.role,
        content: h.content,
        timestamp: h.timestamp,
      })),
      round: existingRound,
    });
  }

  /**
   * Fast-path check: did the model's result already satisfy the top-level goal,
   * even though we're mid-plan?  Looks for explicit TASK_COMPLETE signals or
   * result text that clearly matches the original task prompt.
   *
   * Returns true only when there is strong evidence the user's goal is done.
   * Erring on the side of false keeps the normal verifier path as the default.
   */
  private _isGoalAchievedEarly(task: TaskRecord, resultText: string): boolean {
    const text = resultText.toLowerCase();

    // Explicit model signal
    if (/task[_\s-]?complete[:\s]/i.test(resultText)) return true;

    // The model quoted or summarised the original goal and said it's done
    const referenceWords = task.prompt.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 12);

    const hitCount = referenceWords.filter(w => text.includes(w)).length;
    const hitRatio = referenceWords.length > 0 ? hitCount / referenceWords.length : 0;

    const completionPhrases = [
      'successfully sent', 'has replied', 'chatgpt responded', 'chatgpt replied',
      'message sent', 'reply received', 'goal accomplished', 'already done',
      'already completed', 'already achieved', 'task is done', 'task already',
      'objective met', 'objective achieved',
    ];
    const hasCompletionPhrase = completionPhrases.some(p => text.includes(p));

    // Strong signal: result references the goal AND contains a completion phrase
    if (hitRatio >= 0.5 && hasCompletionPhrase) return true;

    // Very strong signal: step 1 already captured the full answer
    // (e.g. the browser opened, the message was sent, the reply was read)
    if (task.currentStepIndex === 0 && hasCompletionPhrase && hitRatio >= 0.3) return true;

    return false;
  }

  private async _withRoundTimeout<T>(
    op: Promise<T>,
    timeoutMs: number,
    abortSignal?: { aborted: boolean },
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        if (abortSignal) abortSignal.aborted = true;
        reject(new Error(`Round timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      if (timeoutId && typeof (timeoutId as any).unref === 'function') {
        (timeoutId as any).unref();
      }
    });

    try {
      return await Promise.race([op, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async _runRoundWithRetry(
    task: TaskRecord,
    prompt: string,
    sessionId: string,
    sendSSE: (event: string, data: any) => void,
    abortSignal: { aborted: boolean },
  ): Promise<
    | { ok: true; result: { type: string; text: string; thinking?: string } }
    | { ok: false; reason: string; detail: string }
  > {
    const MAX_TRANSPORT_RETRIES = 2;
    const RETRY_DELAY_MS = 4000;
    // Detect if this is a research task (needs longer timeout for web search + synthesis)
    const isResearchTask = /\b(research|search|news|articles?|web.*search|browser|scroll|page|google)\b/i.test(
      task.prompt + ' ' + task.title
    );
    const roundTimeoutMs = resolveRoundTimeoutMs(isResearchTask);
    const resumeMessages = Array.isArray(task.resumeContext?.messages)
      ? task.resumeContext.messages.slice(-MAX_RESUME_MESSAGES)
      : [];
    const callerContext = this._buildCallerContext(task);

    for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
      let attemptResult: { type: string; text: string; thinking?: string };
      const attemptAbortSignal = { aborted: abortSignal.aborted };

      try {
        attemptResult = await this._withRoundTimeout(
          this.handleChat(
            prompt,
            sessionId,
            sendSSE,
            undefined,
            attemptAbortSignal,
            callerContext,
            undefined,
            'background_task',
          ),
          roundTimeoutMs,
          attemptAbortSignal,
        );
      } catch (retryErr: any) {
        const errMsg = String(retryErr?.message || retryErr || 'unknown');
        appendJournal(task.id, {
          type: 'error',
          content: `Attempt ${attempt + 1} threw: ${errMsg.slice(0, 200)}`,
        });
        if (attempt < MAX_TRANSPORT_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          this._restoreSessionForRetry(sessionId, resumeMessages);
          continue;
        }
        return {
          ok: false,
          reason: `Task stopped after ${MAX_TRANSPORT_RETRIES + 1} failed attempts.`,
          detail: errMsg.slice(0, 600),
        };
      }

      const text = String(attemptResult.text || '');
      const isTransportError =
        text.startsWith('Error: Ollama')
        || text.startsWith('Error: fetch failed')
        || text.startsWith('Error: provider')
        || text.includes('fetch failed');

      if (isTransportError) {
        const errSnippet = text.slice(0, 200);

        // Use RetryStrategy for smarter backoff tracking
        const retryStrategy = getRetryStrategy();
        if (!retryStrategy.getState(task.id)) {
          retryStrategy.createRetryState(task.id, {
            maxAttempts: MAX_TRANSPORT_RETRIES + 1,
            baseDelayMs: RETRY_DELAY_MS,
            maxDelayMs: 30000,
            jitter: true,
          });
        }
        const retryResult = retryStrategy.recordAttempt(task.id);

        appendJournal(task.id, {
          type: 'error',
          content: `Transport error (attempt ${retryResult.attemptsUsed}/${MAX_TRANSPORT_RETRIES + 1}): ${errSnippet}`,
        });
        console.warn(`[BackgroundTaskRunner] Task ${task.id} transport error attempt ${retryResult.attemptsUsed}:`, errSnippet);

        if (retryResult.canRetry && attempt < MAX_TRANSPORT_RETRIES) {
          appendJournal(task.id, {
            type: 'status_push',
            content: `Retrying in ${retryResult.delayMs}ms (attempt ${retryResult.attemptsUsed}/${MAX_TRANSPORT_RETRIES + 1})`,
          });
          await new Promise(r => setTimeout(r, retryResult.delayMs || RETRY_DELAY_MS * (attempt + 1)));
          this._restoreSessionForRetry(sessionId, resumeMessages);
          continue;
        }

        // Retries exhausted — clear state and surface error
        retryStrategy.clearState(task.id);
        return {
          ok: false,
          reason: `Task paused after transport retries were exhausted at step ${task.currentStepIndex + 1}.`,
          detail: errSnippet,
        };
      }

      if (text.startsWith('Error:')) {
        appendJournal(task.id, {
          type: 'error',
          content: `Model returned error: ${text.slice(0, 200)}`,
        });
        return {
          ok: false,
          reason: `Task paused because the model returned an unrecoverable error at step ${task.currentStepIndex + 1}.`,
          detail: text.slice(0, 600),
        };
      }

      return { ok: true, result: attemptResult };
    }

    return {
      ok: false,
      reason: 'Task paused because no valid result was produced.',
      detail: 'No result after retry loop.',
    };
  }

  private async _run(): Promise<void> {
    const { taskId } = this;

    updateTaskStatus(taskId, 'running');
    appendJournal(taskId, { type: 'resume', content: 'Runner started.' });

    const initialTask = loadTask(taskId);
    if (!initialTask) return;

    this._broadcast('task_running', { taskId, title: initialTask.title });

    // Keep session ID deterministic per task so resume restores the same context key.
    // clearHistory() prevents stale cross-run contamination while preserving this mapping.
    const sessionId = `task_${taskId}`;
    clearHistory(sessionId);

    // Restore conversation context from prior runs.
    const initialMessages = Array.isArray(initialTask.resumeContext?.messages)
      ? initialTask.resumeContext.messages.slice(-MAX_RESUME_MESSAGES)
      : [];
    if (initialMessages.length > 0) {
      for (const msg of initialMessages) {
        if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
          addMessage(sessionId, {
            role: msg.role,
            content: String(msg.content || ''),
            timestamp: msg.timestamp || Date.now(),
          }, {
            disableMemoryFlushCheck: true,
            disableCompactionCheck: true,
            disableAutoSave: true,
            maxMessages: BACKGROUND_SESSION_MAX_MESSAGES,
          });
        }
      }
      appendJournal(taskId, {
        type: 'resume',
        content: `Restored ${initialMessages.length} message(s) from prior run context.`,
      });
    }

    // Fake SSE sender writing to task journal.
    const signatureRounds: string[][] = [];
    const toolSignatureCounts = new Map<string, number>();
    let currentRoundSignatures: string[] = [];
    let roundStallReason: string | null = null;
    // Full evidence log for the current round — used by the step auditor.
    let currentRoundToolLog: Array<{ tool: string; args: any; result: string; error: boolean }> = [];
    const finalizeRoundSignatures = (): void => {
      signatureRounds.push(currentRoundSignatures);
      while (signatureRounds.length > 6) {
        const dropped = signatureRounds.shift() || [];
        for (const sig of dropped) {
          const next = (toolSignatureCounts.get(sig) || 0) - 1;
          if (next <= 0) toolSignatureCounts.delete(sig);
          else toolSignatureCounts.set(sig, next);
        }
      }
    };

    const sendSSE = (event: string, data: any) => {
      if (event === 'tool_call') {
        // Refresh the open task panel on every tool call so steps update in real-time.
        // task_step_done only fires after verification, so without this the panel is
        // stale while the task is actively running between step completions.
        this._broadcast('task_panel_update', { taskId });
        const sig = `${String(data.action || 'unknown')}:${JSON.stringify(data.args || {})}`;
        currentRoundSignatures.push(sig);
        const next = (toolSignatureCounts.get(sig) || 0) + 1;
        toolSignatureCounts.set(sig, next);
        // Stall detection: browser research tools (scroll/wait/key) get a high threshold since
        // they naturally repeat while exploring pages. Snapshots get a tighter limit (5) because
        // repeated identical snapshots with no intervening action = the AI is stuck in a loop.
        // Nav tools (click/fill/open) also get a higher threshold for research flows.
        const isBrowserSnapshotTool = /^browser_snapshot$/i.test(String(data.action || ''));
        const isBrowserResearchTool = /^browser_(press_key|wait|scroll)$/i.test(String(data.action || ''));
        const isBrowserNavTool = /^browser_(click|fill|open)$/i.test(String(data.action || ''));
        const stallThreshold = isBrowserSnapshotTool ? 3   // snapshots: stall after 3 identical
          : isBrowserResearchTool ? 6                      // scroll/wait/key: 6 — looping without acting
          : isBrowserNavTool ? 20                          // click/fill/open: 20 for nav flows
          : 4;                                             // all other tools: 4
        if (next > stallThreshold && !roundStallReason) {
          roundStallReason = `Stall detected: ${String(data.action || 'unknown')} called ${next} times without progress (last 6 rounds).`;
        }
        // Also detect: all tools this round are scroll/wait/snapshot with zero clicks/fills/opens.
        // Only flag after 6+ such calls — short scroll sequences (e.g. post-tweet verification)
        // are normal and should not be treated as stalls.
        if (!roundStallReason && currentRoundSignatures.length >= 6) {
          const hasNavAction = currentRoundSignatures.some(s => /^browser_(click|fill|open):/.test(s));
          const allScroll = currentRoundSignatures.every(s => /^browser_(press_key|wait|scroll|snapshot):/.test(s));
          if (!hasNavAction && allScroll) {
            roundStallReason = `Stall detected: ${currentRoundSignatures.length} consecutive scroll/wait/snapshot calls with no click, fill, or navigation action. Agent is looping without interacting with the page.`;
          }
        }
        appendJournal(taskId, {
          type: 'tool_call',
          content: `${data.action || 'unknown'}(${JSON.stringify(data.args || {}).slice(0, 80)})`,
        });
        this._broadcast('task_tool_call', { taskId, tool: data.action, args: data.args });
        // Pre-populate an entry; result will be filled in by the tool_result handler.
        currentRoundToolLog.push({ tool: String(data.action || 'unknown'), args: data.args ?? {}, result: '', error: false });
      } else if (event === 'tool_result') {
        appendJournal(taskId, {
          type: 'tool_result',
          content: `${data.action || 'unknown'}: ${String(data.result || '').slice(0, 120)}${data.error ? ' [ERROR]' : ''}`,
          detail: data.error ? String(data.result || '') : undefined,
        });
        // Fill in result for the matching pending entry so the auditor has full evidence.
        for (let i = currentRoundToolLog.length - 1; i >= 0; i--) {
          if (currentRoundToolLog[i].tool === (data.action || 'unknown') && currentRoundToolLog[i].result === '') {
            currentRoundToolLog[i].result = String(data.result || '').slice(0, 1200);
            currentRoundToolLog[i].error = !!data.error;
            break;
          }
        }
      }
    };

    const abortSignal = { aborted: false };
    let firstRound = true;
    let lastResultSummary = '';
    const stepRetryHints = new Map<number, string>();
    const stepVerificationRetries = new Map<number, number>();

    while (true) {
      const task = loadTask(taskId);
      if (!task) return;
      if (task.status === 'complete' || task.status === 'failed') return;

      if (pauseRequests.has(taskId)) {
        const pauseReason = task.pauseReason || 'user_pause';
        const scheduleId = task.pausedByScheduleId;
        
        updateTaskStatus(taskId, 'paused', { pauseReason });
        
        let pauseMsg = 'Paused by user request.';
        if (pauseReason === 'interrupted_by_schedule' && scheduleId) {
          pauseMsg = `Paused by scheduled task (schedule: ${scheduleId}). Will resume after schedule completes.`;
        }
        
        appendJournal(taskId, { type: 'pause', content: pauseMsg });
        this._broadcast('task_paused', { taskId, reason: pauseReason, scheduleId });
        flushSession(sessionId);
        return;
      }

      // Parent is blocked waiting for child sub-agents to finish — exit loop.
      // scheduleTaskFollowup() will re-queue this task when all children complete.
      if (task.status === 'waiting_subagent') {
        activeRunners.delete(taskId);
        appendJournal(taskId, { type: 'pause', content: 'Waiting for sub-agents to complete.' });
        flushSession(sessionId);
        return;
      }

      if (task.currentStepIndex >= task.plan.length) {
        // All plan steps complete — now do a final synthesis round to format response for user
        if (!task.finalSummary) {
          // Check if any other tasks are paused by this task (were interrupted by schedules)
          const pausedTasksNote = task.pausedByScheduleId
            ? `\n\nNote: This task is paused by schedule ${task.pausedByScheduleId} and will resume later.`
            : '';
          
          const synthesisPrompt = [
            `Task "${task.title}" has completed all planned steps.`,
            `Here is what you found/accomplished:`,
            `${(lastResultSummary || 'Task execution complete').slice(0, 500)}`,
            ``,
            `Now format this as a concise, clear response directly to the user about their original request: "${task.prompt.slice(0, 200)}"`,
            `Do NOT say "Task complete" or mention this was a background task. Just give them the information they asked for.${pausedTasksNote}`,
          ].join('\n');
          
          updateTaskStatus(taskId, 'running');
          currentRoundToolLog = [];
          const synthesisOutcome = await this._runRoundWithRetry(task, synthesisPrompt, sessionId, sendSSE, abortSignal);
          
          if (synthesisOutcome.ok && synthesisOutcome.result?.text) {
            const synthesisText = String(synthesisOutcome.result.text || '').trim();

            // ── Completion verifier: ensure the final message is actually good ──
            const freshTaskForVerify = loadTask(taskId);
            const resynthAttempts = Number(freshTaskForVerify?.resynthAttempts) || 0;
            const verifyDecision = await callCompletionVerifier({
              task: freshTaskForVerify || task,
              finalMessage: synthesisText,
              resynthAttempt: resynthAttempts,
            });
            appendJournal(taskId, {
              type: 'status_push',
              content: `[Verifier] ${verifyDecision.action}: ${verifyDecision.reasoning}`,
            });

            if (verifyDecision.action === 'RESYNTH') {
              // One more synthesis round with the verifier's hint injected
              const freshTask2 = loadTask(taskId);
              if (freshTask2) {
                freshTask2.resynthAttempts = resynthAttempts + 1;
                saveTask(freshTask2);
              }
              const resynthPrompt = [
                `Task "${task.title}" needs an improved final response.`,
                `Verifier feedback: ${verifyDecision.hint}`,
                `Original request: "${task.prompt.slice(0, 200)}"`,
                `Previous attempt: ${synthesisText.slice(0, 400)}`,
                `Produce a complete, corrected response now.`,
              ].join('\n');
              const resynthOutcome = await this._runRoundWithRetry(task, resynthPrompt, sessionId, sendSSE, abortSignal);
              const finalMsg = resynthOutcome.ok
                ? String(resynthOutcome.result.text || synthesisText).trim()
                : synthesisText;
              updateTaskStatus(taskId, 'complete', { finalSummary: finalMsg });
              appendJournal(taskId, { type: 'status_push', content: 'Task complete. Re-synthesized and verified.' });
              this._broadcast('task_complete', { taskId, summary: finalMsg });
              await this._deliverToChannel(task, finalMsg);
              this._persistResumeContextSnapshot(taskId, sessionId);
              flushSession(sessionId);
              return;
            }

            // DELIVER or DELIVER_ANYWAY — use verifier's (possibly cleaned) message
            const deliverMsg = verifyDecision.message || synthesisText;
            updateTaskStatus(taskId, 'complete', { finalSummary: deliverMsg });
            appendJournal(taskId, { type: 'status_push', content: 'Task complete. Final synthesis verified.' });
            this._broadcast('task_complete', { taskId, summary: deliverMsg });
            await this._deliverToChannel(task, deliverMsg);
            this._persistResumeContextSnapshot(taskId, sessionId);
            flushSession(sessionId);
            return;
          } else {
            // Synthesis failed, use last known summary
            const fallbackSummary = lastResultSummary || 'Task completed all planned steps.';
            updateTaskStatus(taskId, 'complete', { finalSummary: fallbackSummary });
            appendJournal(taskId, { type: 'status_push', content: 'Task complete (synthesis round skipped).' });
            this._broadcast('task_complete', { taskId, summary: fallbackSummary });
            await this._deliverToChannel(task, fallbackSummary);
            this._persistResumeContextSnapshot(taskId, sessionId);
            flushSession(sessionId);
            return;
          }
        } else {
          // finalSummary already set, just mark complete and deliver
          updateTaskStatus(taskId, 'complete', { finalSummary: task.finalSummary });
          appendJournal(taskId, { type: 'status_push', content: 'Task complete: final summary already prepared.' });
          this._broadcast('task_complete', { taskId, summary: task.finalSummary });
          await this._deliverToChannel(task, task.finalSummary);
          this._persistResumeContextSnapshot(taskId, sessionId);
          flushSession(sessionId);
          return;
        }
      }

      updateTaskStatus(taskId, 'running');
      const currentStep = task.plan[task.currentStepIndex];
      const retryHint = stepRetryHints.get(task.currentStepIndex);
      const prompt = firstRound
        ? (
          this.openingAction
            ? `[Resuming task from heartbeat. Opening action: ${this.openingAction}]\n\n${task.prompt}`
            : task.prompt
        )
        : [
          `Continue task: ${task.title}`,
          ``,
          `CURRENT STEP: ${task.currentStepIndex + 1} of ${task.plan.length}`,
          `STEP GOAL: ${currentStep?.description || 'No step description provided.'}`,
          ``,
          `You MUST complete this step before moving on. When done, clearly state what you did to complete it so the verifier can confirm.`,
          retryHint ? `VERIFIER FEEDBACK (previous attempt failed): ${retryHint}` : '',
          `REMAINING STEPS:`,
          ...task.plan.slice(task.currentStepIndex + 1).map((s, i) =>
            `  Step ${task.currentStepIndex + 2 + i}: ${s.description}`
          ),
          ``,
          `Previous result: ${(lastResultSummary || 'No previous result.').slice(0, 300)}`,
        ].filter(Boolean).join('\n');
      firstRound = false;
      currentRoundSignatures = [];
      roundStallReason = null;
      currentRoundToolLog = [];

      const roundOutcome = await this._runRoundWithRetry(task, prompt, sessionId, sendSSE, abortSignal);
      finalizeRoundSignatures();
      if (roundStallReason) {
        // Deliver whatever the agent produced before pausing — the inline reasoning /
        // final message was already computed but never sent because the stall check
        // fires before _deliverToChannel. Flush it now so the user sees it in chat.
        const partialResult = roundOutcome.ok ? String(roundOutcome.result?.text || '').trim() : '';
        const isBrowserScrollLoop = /scroll|press_key|snapshot.*loop|looping without/i.test(roundStallReason);
        if (partialResult) {
          try {
            const freshTask = loadTask(taskId);
            if (freshTask) {
              await this._deliverToChannel(freshTask, partialResult);
            }
          } catch { /* best effort */ }
        }
        // If it's a scroll/snapshot loop stall AND the model already sent a message,
        // silently pause without the noisy error blast — user already got the model's reply.
        if (isBrowserScrollLoop && partialResult) {
          updateTaskStatus(task.id, 'needs_assistance', { pauseReason: 'error' });
          appendJournal(task.id, {
            type: 'pause',
            content: `Task paused (browser loop detected): ${String(roundStallReason).slice(0, 220)}`,
          });
          this._broadcast('task_paused', { taskId: task.id, reason: 'needs_assistance' });
          return;
        }
        await this._pauseForAssistance(task, roundStallReason);
        return;
      }
      if (!roundOutcome.ok) {
        await this._pauseForAssistance(task, roundOutcome.reason, roundOutcome.detail);
        return;
      }

      const result = roundOutcome.result;
      lastResultSummary = String(result.text || '').replace(/\s+/g, ' ').trim();
      const sessionHistory = getHistory(sessionId, 40);
      updateResumeContext(taskId, {
        messages: sessionHistory.slice(-MAX_RESUME_MESSAGES).map(h => ({
          role: h.role,
          content: h.content,
          timestamp: h.timestamp,
        })),
        round: (Number(task.resumeContext?.round) || 0) + 1,
      });
      flushSession(sessionId);

      if (pauseRequests.has(taskId)) {
        const task = loadTask(taskId);
        const pauseReason = task?.pauseReason || 'user_pause';
        const scheduleId = task?.pausedByScheduleId;
        
        updateTaskStatus(taskId, 'paused', { pauseReason });
        
        let pauseMsg = 'Paused by user request.';
        if (pauseReason === 'interrupted_by_schedule' && scheduleId) {
          pauseMsg = `Paused by scheduled task (schedule: ${scheduleId}). Will resume after schedule completes.`;
        }
        
        appendJournal(taskId, { type: 'pause', content: pauseMsg });
        this._broadcast('task_paused', { taskId, reason: pauseReason, scheduleId });
        flushSession(sessionId);
        return;
      }

      const freshTask = loadTask(taskId);
      if (!freshTask || !freshTask.plan[freshTask.currentStepIndex]) {
        updateTaskStatus(taskId, 'complete', { finalSummary: result.text });
        appendJournal(taskId, { type: 'status_push', content: `Task complete: ${result.text.slice(0, 200)}` });
        this._broadcast('task_complete', { taskId, summary: result.text });
        await this._deliverToChannel(task, `Task complete: ${task.title}\n\n${result.text}`, { forceTelegram: true });
        this._persistResumeContextSnapshot(taskId, sessionId);
        flushSession(sessionId);
        return;
      }

      // ── Early goal-completion fast-path ──────────────────────────────────
      // If the model's result already satisfies the original user goal
      // (e.g. it opened ChatGPT, sent the message, and got a reply in step 1),
      // mark the task complete immediately without running the remaining plan steps.
      {
        const freshForGoalCheck = loadTask(taskId);
        if (freshForGoalCheck && this._isGoalAchievedEarly(freshForGoalCheck, lastResultSummary)) {
          const summary = lastResultSummary.slice(0, 400);
          updateTaskStatus(taskId, 'complete', { finalSummary: summary });
          appendJournal(taskId, {
            type: 'status_push',
            content: `Goal achieved early at step ${freshForGoalCheck.currentStepIndex + 1} — skipping remaining ${freshForGoalCheck.plan.length - freshForGoalCheck.currentStepIndex - 1} step(s). ${summary}`,
          });
          this._broadcast('task_complete', { taskId, summary });
          await this._deliverToChannel(freshForGoalCheck, `Task complete: ${freshForGoalCheck.title}\n\n${summary}`, { forceTelegram: true });
          this._persistResumeContextSnapshot(taskId, sessionId);
          flushSession(sessionId);
          return;
        }
      }

      // If handleChat hit its internal tool-round cap, skip verification and
      // just continue to the next round — the step isn't done yet but the work
      // is still in progress. Treating this as a verification failure would
      // incorrectly burn retries and eventually kill the task.
      const hitMaxSteps = /^hit max steps/i.test(lastResultSummary);
      if (hitMaxSteps) {
        appendJournal(taskId, { type: 'status_push', content: 'Round hit max tool steps - continuing to next round.' });
        continue;
      }

      // Multi-step evidence audit:
      // Ask the secondary model to inspect this round's tool evidence and
      // mark every pending plan step that is provably complete.
      const pendingSteps = freshTask.plan
        .map((s, i) => ({ index: i, description: s.description, status: s.status }))
        .filter(s => s.status !== 'done' && s.status !== 'skipped');

      const auditResult = await callSecondaryTaskStepAuditor({
        pendingSteps: pendingSteps.map(s => ({ index: s.index, description: s.description })),
        toolCallLog: currentRoundToolLog,
        resultText: lastResultSummary,
      });

      if (!auditResult || auditResult.completed_steps.length === 0) {
        // Auditor found nothing done, treat as incomplete and retry.
        const stepIndex = freshTask.currentStepIndex;
        const retries = (stepVerificationRetries.get(stepIndex) || 0) + 1;
        stepVerificationRetries.set(stepIndex, retries);
        const reason = auditResult
          ? 'No plan steps were evidenced as complete by this round\'s tool calls.'
          : 'Step auditor unavailable; assuming incomplete.';
        stepRetryHints.set(stepIndex, reason);
        appendJournal(taskId, {
          type: 'status_push',
          content: `Auditor found no completed steps (${retries}/${MAX_STEP_VERIFICATION_RETRIES}): ${reason}`,
        });
        if (retries >= MAX_STEP_VERIFICATION_RETRIES) {
          const healed = await this._attemptSelfHeal(
            task,
            `Step ${stepIndex + 1} failed verification after ${retries} retries.`,
            reason,
            lastResultSummary,
            sessionId,
          );
          if (healed === 'continue') { stepVerificationRetries.delete(stepIndex); continue; }
          if (healed === 'complete') { flushSession(sessionId); return; }
          // healed === 'escalate' — fall through to _pauseForAssistance
          await this._pauseForAssistance(
            task,
            `Step ${stepIndex + 1} failed verification after ${retries} retries.`,
            reason,
          );
          flushSession(sessionId);
          return;
        }
        continue;
      }

      const completedIndices = Array.from(new Set(auditResult.completed_steps))
        .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < freshTask.plan.length)
        .sort((a, b) => a - b);

      if (completedIndices.length === 0) {
        const stepIndex = freshTask.currentStepIndex;
        const retries = (stepVerificationRetries.get(stepIndex) || 0) + 1;
        stepVerificationRetries.set(stepIndex, retries);
        const reason = 'Auditor returned only out-of-range step indices.';
        stepRetryHints.set(stepIndex, reason);
        appendJournal(taskId, {
          type: 'status_push',
          content: `Auditor result rejected (${retries}/${MAX_STEP_VERIFICATION_RETRIES}): ${reason}`,
        });
        if (retries >= MAX_STEP_VERIFICATION_RETRIES) {
          const healed = await this._attemptSelfHeal(
            task,
            `Step ${stepIndex + 1} failed verification after ${retries} retries.`,
            reason,
            lastResultSummary,
            sessionId,
          );
          if (healed === 'continue') { stepVerificationRetries.delete(stepIndex); continue; }
          if (healed === 'complete') { flushSession(sessionId); return; }
          await this._pauseForAssistance(
            task,
            `Step ${stepIndex + 1} failed verification after ${retries} retries.`,
            reason,
          );
          flushSession(sessionId);
          return;
        }
        continue;
      }

      const mutations = completedIndices.map((idx) => ({
        op: 'complete' as const,
        step_index: idx,
        notes: (auditResult.notes[idx] || lastResultSummary).slice(0, 200),
      }));

      // Apply any structural plan mutations the auditor recommended (add/skip/modify steps)
      // This is how the plan adapts mid-execution: skip redundant steps, add recovery steps,
      // correct step descriptions based on what was actually discovered.
      if (auditResult.plan_mutations && auditResult.plan_mutations.length > 0) {
        const adaptMutations: Parameters<typeof mutatePlan>[1] = [];
        for (const m of auditResult.plan_mutations) {
          if (m.op === 'add') {
            adaptMutations.push({ op: 'add', after_index: m.after_index, description: m.description });
          } else if (m.op === 'skip') {
            // 'skip' translates to completing the step with a skip note
            adaptMutations.push({ op: 'complete', step_index: m.step_index, notes: `[SKIPPED] ${m.reason}` });
          } else if (m.op === 'modify') {
            adaptMutations.push({ op: 'modify', step_index: m.step_index, description: m.description });
          }
        }
        if (adaptMutations.length > 0) {
          appendJournal(taskId, {
            type: 'status_push',
            content: `Auditor adapted plan: ${auditResult.plan_mutations.map(m => `${m.op}@${(m as any).step_index ?? (m as any).after_index}`).join(', ')}`,
          });
          mutatePlan(taskId, adaptMutations);
          this._broadcast('task_step_done', { taskId, planAdapted: true, mutations: auditResult.plan_mutations });
        }
      }

      appendJournal(taskId, {
        type: 'status_push',
        content: `Auditor confirmed step(s) ${completedIndices.map(i => i + 1).join(', ')} complete based on tool evidence.`,
      });
      mutatePlan(taskId, mutations);

      // Clear retry state for any step that just got confirmed.
      for (const idx of completedIndices) {
        stepRetryHints.delete(idx);
        stepVerificationRetries.delete(idx);
      }

      // Reload after mutations and advance currentStepIndex past all completed/skipped steps.
      const updated = loadTask(taskId);
      if (!updated) return;

      const previousStep = updated.currentStepIndex;
      let nextStep = previousStep;
      while (nextStep < updated.plan.length) {
        const status = updated.plan[nextStep]?.status;
        if (status !== 'done' && status !== 'skipped') break;
        nextStep++;
      }

      if (nextStep >= updated.plan.length) {
        updateTaskStatus(taskId, 'complete', { finalSummary: result.text });
        appendJournal(taskId, { type: 'status_push', content: `Task complete: ${result.text.slice(0, 200)}` });
        this._broadcast('task_complete', { taskId, summary: result.text });
        await this._deliverToChannel(task, `Task complete: ${task.title}\n\n${result.text}`, { forceTelegram: true });
        this._persistResumeContextSnapshot(taskId, sessionId);
        flushSession(sessionId);
        return;
      }

      if (nextStep !== previousStep) {
        updated.currentStepIndex = nextStep;
        saveTask(updated);
        appendJournal(taskId, {
          type: 'status_push',
          content: `Step pointer advanced from ${previousStep + 1} to ${nextStep + 1} after multi-step audit.`,
        });
        this._broadcast('task_step_done', {
          taskId,
          completedStep: previousStep,
          completedSteps: completedIndices,
          nextStep,
          autoContinued: true,
        });
      }
    }
  }
  /**
   * Intercepts a step-verification failure and attempts AI-powered self-healing
   * before bothering the user.
   *
   * Returns:
   *   'continue' — healer issued a retry hint; caller should continue the run loop
   *   'complete' — healer force-completed the task; caller should return
   *   'escalate' — healer gave up; caller should fall through to _pauseForAssistance
   */
  private async _attemptSelfHeal(
    task: TaskRecord,
    reason: string,
    detail: string,
    lastResultText: string,
    sessionId: string,
  ): Promise<'continue' | 'complete' | 'escalate'> {
    const freshTask = loadTask(task.id);
    if (!freshTask) return 'escalate';

    const healAttempt = Number(freshTask.selfHealAttempts) || 0;

    appendJournal(task.id, {
      type: 'status_push',
      content: `[SelfHealer] Intercepting failure (attempt ${healAttempt + 1}/${MAX_HEAL_ATTEMPTS}): ${reason.slice(0, 120)}`,
    });
    this._broadcast('task_self_healing', {
      taskId: task.id,
      attempt: healAttempt + 1,
      maxAttempts: MAX_HEAL_ATTEMPTS,
      reason: reason.slice(0, 200),
    });

    const decision = await callErrorHealer({
      task: freshTask,
      failureReason: reason,
      failureDetail: detail,
      lastResultText,
      healAttempt,
    });

    appendJournal(task.id, {
      type: 'status_push',
      content: `[SelfHealer] Decision: ${decision.action} — ${decision.reasoning}`,
    });
    console.log(`[SelfHealer] Task ${task.id} attempt ${healAttempt + 1}: ${decision.action} — ${decision.reasoning}`);

    // Increment counter regardless of outcome
    freshTask.selfHealAttempts = healAttempt + 1;
    saveTask(freshTask);

    if (decision.action === 'FORCE_COMPLETE') {
      // Mark all pending plan steps as done via the healer
      const planMutations = freshTask.plan
        .map((s, i) => ({ op: 'complete' as const, step_index: i, notes: '[SelfHealer] Force-completed by self-healer' }))
        .filter((_, i) => freshTask.plan[i].status !== 'done' && freshTask.plan[i].status !== 'skipped');
      if (planMutations.length > 0) {
        mutatePlan(task.id, planMutations);
      }
      updateTaskStatus(task.id, 'complete', { finalSummary: decision.message });
      appendJournal(task.id, {
        type: 'status_push',
        content: `[SelfHealer] Task force-completed. Delivering recovered message.`,
      });
      this._broadcast('task_complete', { taskId: task.id, summary: decision.message });
      await this._deliverToChannel(freshTask, decision.message);
      this._persistResumeContextSnapshot(task.id, sessionId);
      return 'complete';
    }

    if (decision.action === 'RESUME_WITH_HINT') {
      // If the healer corrected a step description, apply it
      if (decision.newStepDescription) {
        mutatePlan(task.id, [{
          op: 'modify',
          step_index: freshTask.currentStepIndex,
          description: decision.newStepDescription,
        }]);
      }
      // Inject the hint into the resume context so the next round sees it
      updateResumeContext(task.id, {
        onResumeInstruction: `[SelfHealer correction] ${decision.hint}`,
      });
      appendJournal(task.id, {
        type: 'status_push',
        content: `[SelfHealer] Resuming with hint: ${decision.hint.slice(0, 150)}`,
      });
      return 'continue';
    }

    // ESCALATE
    return 'escalate';
  }

  private async _pauseForAssistance(task: TaskRecord, reason: string, detail?: string): Promise<void> {
    updateTaskStatus(task.id, 'needs_assistance', { pauseReason: 'error' });
    appendJournal(task.id, {
      type: 'pause',
      content: `Task paused for assistance: ${reason.slice(0, 220)}`,
      detail: detail ? detail.slice(0, 1200) : undefined,
    });

    // ── Categorize error and broadcast error response UI ──
    const fullErrorMsg = detail ? `${reason}\n${detail}` : reason;
    const categorization = errorCategorizer.categorizeError(fullErrorMsg);

    // Record in error analyzer (pattern learning) and history
    try {
      const analyzer = getErrorAnalyzer();
      const history = getErrorHistory();
      if (categorization.category !== 'unknown') {
        analyzer.recordError(fullErrorMsg, categorization.category);
      }
      history.add({
        taskId: task.id,
        errorMessage: reason.substring(0, 200),
        category: categorization.category,
        resolved: false,
      });
    } catch {}

    // Only show error response panel if we detected a specific error type with high confidence
    if (categorization.confidence > 0.7 && categorization.template) {
      appendJournal(task.id, {
        type: 'status_push',
        content: `Error categorized as "${categorization.category}" (confidence: ${(categorization.confidence * 100).toFixed(0)}%): ${categorization.reasoning}`,
      });
      
      this._broadcast('task_error_requires_response', {
        taskId: task.id,
        errorCategory: categorization.category,
        errorMessage: reason,
        errorDetail: detail || '',
        template: categorization.template,
      });
    }

    this._broadcast('task_paused', { taskId: task.id, reason: 'needs_assistance' });
    this._broadcast('task_needs_assistance', {
      taskId: task.id,
      title: task.title,
      reason,
      detail: detail || '',
    });

    const message = [
      `Task paused and needs input: ${task.title}`,
      `Reason: ${reason}`,
      detail ? `Details: ${detail}` : '',
      `Reply in this chat with any adjustment or confirmation, and I will resume the task.`,
      `Task ID: ${task.id}`,
    ].filter(Boolean).join('\n');

    await this._deliverToChannel(task, message);

    // Always send escalation to Telegram when available, even for web-origin tasks.
    if (this.telegramChannel && task.channel !== 'telegram') {
      try { await this.telegramChannel.sendToAllowed(message); } catch {}
    }
  }

  private _broadcast(event: string, data: object): void {
    try {
      this.broadcast({ type: event, ...data });
    } catch {}
  }

  private async _deliverToChannel(
    task: TaskRecord,
    message: string,
    opts?: { forceTelegram?: boolean },
  ): Promise<void> {
    // ─ Sub-agent path: notify parent instead of delivering to user chat ─
    if (task.parentTaskId) {
      try {
        const { parentTask, allChildrenDone } = resolveSubagentCompletion(task.id, message);
        if (parentTask && allChildrenDone) {
          console.log(`[SubAgent] All children done for parent ${parentTask.id} — scheduling quick resume.`);
          // Signal the broadcast interceptor in server-v2 to scheduleTaskFollowup
          this._broadcast('task_step_followup_needed', {
            taskId: parentTask.id,
            delayMs: 2000,
          });
        } else if (parentTask) {
          console.log(`[SubAgent] Child ${task.id} done; parent ${parentTask.id} still waiting on more children.`);
        }
      } catch (e) {
        console.warn('[SubAgent] resolveSubagentCompletion error:', e);
      }
      // Sub-agents never deliver directly to user chat — return early.
      return;
    }

    try {
      addMessage(task.sessionId, {
        role: 'user',
        content: `[BACKGROUND_TASK_RESULT task_id=${task.id}]`,
        timestamp: Date.now() - 1,
      });
      addMessage(task.sessionId, { role: 'assistant', content: message, timestamp: Date.now() });
    } catch (e) {
      console.warn('[BTR] Delivery failed (addMessage):', e);
    }

    if ((opts?.forceTelegram || task.channel === 'telegram') && this.telegramChannel) {
      try {
        if (task.telegramChatId && typeof this.telegramChannel.sendMessage === 'function') {
          await this.telegramChannel.sendMessage(task.telegramChatId, message);
        } else {
          await this.telegramChannel.sendToAllowed(message);
        }
      } catch (e) {
        console.warn('[BTR] Delivery failed (telegram):', e);
      }
    }

    // For web channel, broadcast via WS so any open chat session sees it.
    this._broadcast('task_notification', {
      taskId: task.id,
      sessionId: task.sessionId,
      channel: task.channel,
      message,
    });
  }
}
