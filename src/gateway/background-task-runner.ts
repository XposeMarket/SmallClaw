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
  type TaskRecord,
} from './task-store';
import { clearHistory, addMessage, getHistory, flushSession } from './session';
import { callSecondaryAdvisor } from '../orchestration/multi-agent';

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

function resolveRoundTimeoutMs(): number {
  const candidates = [
    process.env.LOCALCLAW_BG_ROUND_TIMEOUT_MS,
    process.env.LOCALCLAW_TASK_ROUND_TIMEOUT_MS,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 10_000) return Math.floor(n);
  }
  return DEFAULT_ROUND_TIMEOUT_MS;
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
  private telegramChannel: { sendToAllowed: (text: string) => Promise<void> } | null;
  private openingAction: string | undefined;

  constructor(
    taskId: string,
    handleChat: BackgroundTaskRunner['handleChat'],
    broadcast: (data: object) => void,
    telegramChannel: { sendToAllowed: (text: string) => Promise<void> } | null,
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
    return [
      `[BACKGROUND TASK CONTEXT]`,
      `Task ID: ${task.id}`,
      `Task Title: ${task.title}`,
      `Original Request: ${task.prompt.slice(0, 400)}`,
      `Current Step: ${task.currentStepIndex + 1}/${task.plan.length}`,
      task.plan[task.currentStepIndex]
        ? `Step Description: ${task.plan[task.currentStepIndex].description}`
        : '',
      `You are running autonomously. Execute the task step by step.`,
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

  private async _verifyStepCompletion(stepDescription: string, stepResult: string): Promise<{ complete: boolean; reason: string }> {
    const step = String(stepDescription || '').trim() || 'No step description provided.';
    const result = String(stepResult || '').trim() || '(empty result)';
    const goal = [
      'Evaluate whether this task step is complete.',
      'Reply YES or NO with one sentence reason.',
      `STEP: ${step.slice(0, 500)}`,
      `RESULT: ${result.slice(0, 1200)}`,
    ].join('\n');
    const advice = await callSecondaryAdvisor(
      goal,
      [`Step: ${step.slice(0, 320)}`, `Result: ${result.slice(0, 500)}`],
      'Step completion verification (strict YES/NO)',
      'rescue',
    );

    if (!advice) {
      return { complete: true, reason: 'Verifier unavailable; proceeding without blocking.' };
    }

    const evidence = [
      String(advice.raw_response || ''),
      ...(advice.hints || []).map((h) => String(h || '')),
      ...(advice.next_actions || []).map((a) => String(a || '')),
    ]
      .filter(Boolean)
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();

    const verdictMatch = evidence.match(/\b(YES|NO)\b/i);
    if (verdictMatch) {
      const complete = verdictMatch[1].toUpperCase() === 'YES';
      const sentence = evidence.split(/[.!?]\s+/)[0] || evidence;
      return { complete, reason: sentence.slice(0, 280) };
    }

    const negativeCue = /\b(not complete|incomplete|missing|failed|did not|does not|cannot verify|needs retry|retry)\b/i.test(evidence);
    const complete = !negativeCue;
    return {
      complete,
      reason: (evidence.split(/[.!?]\s+/)[0] || (complete ? 'Step appears complete.' : 'Step appears incomplete.')).slice(0, 280),
    };
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
    const roundTimeoutMs = resolveRoundTimeoutMs();
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
        appendJournal(task.id, {
          type: 'error',
          content: `Transport error (attempt ${attempt + 1}/${MAX_TRANSPORT_RETRIES + 1}): ${errSnippet}`,
        });
        console.warn(`[BackgroundTaskRunner] Task ${task.id} transport error attempt ${attempt + 1}:`, errSnippet);
        if (attempt < MAX_TRANSPORT_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          this._restoreSessionForRetry(sessionId, resumeMessages);
          continue;
        }
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
        const sig = `${String(data.action || 'unknown')}:${JSON.stringify(data.args || {})}`;
        currentRoundSignatures.push(sig);
        const next = (toolSignatureCounts.get(sig) || 0) + 1;
        toolSignatureCounts.set(sig, next);
        if (next > 3 && !roundStallReason) {
          roundStallReason = `Stall detected: ${String(data.action || 'unknown')} called ${next} times without progress (last 6 rounds).`;
        }
        appendJournal(taskId, {
          type: 'tool_call',
          content: `${data.action || 'unknown'}(${JSON.stringify(data.args || {}).slice(0, 80)})`,
        });
        this._broadcast('task_tool_call', { taskId, tool: data.action, args: data.args });
      } else if (event === 'tool_result') {
        appendJournal(taskId, {
          type: 'tool_result',
          content: `${data.action || 'unknown'}: ${String(data.result || '').slice(0, 120)}${data.error ? ' [ERROR]' : ''}`,
          detail: data.error ? String(data.result || '') : undefined,
        });
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
        updateTaskStatus(taskId, 'paused', { pauseReason: 'user_pause' });
        appendJournal(taskId, { type: 'pause', content: 'Paused by user request.' });
        this._broadcast('task_paused', { taskId, reason: 'user_pause' });
        flushSession(sessionId);
        return;
      }

      if (task.currentStepIndex >= task.plan.length) {
        const finalSummary = task.finalSummary || 'Task completed all planned steps.';
        updateTaskStatus(taskId, 'complete', { finalSummary });
        appendJournal(taskId, { type: 'status_push', content: 'Task complete: all planned steps executed.' });
        this._broadcast('task_complete', { taskId, summary: finalSummary });
        await this._deliverToChannel(task, `Task complete: ${task.title}\n\n${finalSummary}`, { forceTelegram: true });
        this._persistResumeContextSnapshot(taskId, sessionId);
        flushSession(sessionId);
        return;
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
          `Current step (${task.currentStepIndex + 1}/${task.plan.length}): ${currentStep?.description || 'No step description provided.'}`,
          retryHint ? `Verifier feedback: ${retryHint}` : '',
          `Previous step result: ${(lastResultSummary || 'No previous step result available.').slice(0, 300)}`,
        ].join('\n');
      firstRound = false;
      currentRoundSignatures = [];
      roundStallReason = null;

      const roundOutcome = await this._runRoundWithRetry(task, prompt, sessionId, sendSSE, abortSignal);
      finalizeRoundSignatures();
      if (roundStallReason) {
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
        updateTaskStatus(taskId, 'paused', { pauseReason: 'user_pause' });
        appendJournal(taskId, { type: 'pause', content: 'Paused by user request.' });
        this._broadcast('task_paused', { taskId, reason: 'user_pause' });
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

      const verify = await this._verifyStepCompletion(
        currentStep?.description || 'No step description provided.',
        result.text || '',
      );
      if (!verify.complete) {
        const stepIndex = freshTask.currentStepIndex;
        const retries = (stepVerificationRetries.get(stepIndex) || 0) + 1;
        stepVerificationRetries.set(stepIndex, retries);
        stepRetryHints.set(stepIndex, verify.reason);
        appendJournal(taskId, {
          type: 'status_push',
          content: `Verifier says step ${stepIndex + 1} incomplete (${retries}/${MAX_STEP_VERIFICATION_RETRIES}): ${verify.reason}`,
        });
        if (retries >= MAX_STEP_VERIFICATION_RETRIES) {
          await this._pauseForAssistance(
            task,
            `Step ${stepIndex + 1} failed verification after ${retries} retries.`,
            verify.reason,
          );
          flushSession(sessionId);
          return;
        }
        continue;
      }
      stepRetryHints.delete(freshTask.currentStepIndex);
      stepVerificationRetries.delete(freshTask.currentStepIndex);

      const completedStep = freshTask.currentStepIndex;
      mutatePlan(taskId, [{
        op: 'complete',
        step_index: completedStep,
        notes: result.text.slice(0, 200),
      }]);

      const updated = loadTask(taskId);
      if (!updated) return;

      const nextStep = updated.currentStepIndex + 1;
      const allDone = nextStep >= updated.plan.length
        || updated.plan.slice(nextStep).every(s => s.status === 'done' || s.status === 'skipped');

      if (allDone) {
        updateTaskStatus(taskId, 'complete', { finalSummary: result.text });
        appendJournal(taskId, { type: 'status_push', content: `Task complete: ${result.text.slice(0, 200)}` });
        this._broadcast('task_complete', { taskId, summary: result.text });
        await this._deliverToChannel(task, `Task complete: ${task.title}\n\n${result.text}`, { forceTelegram: true });
        this._persistResumeContextSnapshot(taskId, sessionId);
        flushSession(sessionId);
        return;
      }

      updated.currentStepIndex = nextStep;
      saveTask(updated);
      appendJournal(taskId, {
        type: 'status_push',
        content: `Step ${completedStep + 1} done. Continuing automatically to step ${nextStep + 1}.`,
      });
      this._broadcast('task_step_done', {
        taskId,
        completedStep,
        nextStep,
        autoContinued: true,
      });
    }
  }

  private async _pauseForAssistance(task: TaskRecord, reason: string, detail?: string): Promise<void> {
    updateTaskStatus(task.id, 'needs_assistance', { pauseReason: 'error' });
    appendJournal(task.id, {
      type: 'pause',
      content: `Task paused for assistance: ${reason.slice(0, 220)}`,
      detail: detail ? detail.slice(0, 1200) : undefined,
    });

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
      try { await this.telegramChannel.sendToAllowed(message); } catch (e) {
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
