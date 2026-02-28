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
    return [
      `[BACKGROUND TASK CONTEXT]`,
      `Task ID: ${task.id}`,
      `Task Title: ${task.title}`,
      `Original Request: ${task.prompt.slice(0, 400)}`,
      `Current Step: ${task.currentStepIndex + 1}/${task.plan.length}`,
      task.plan[task.currentStepIndex]
        ? `Step Description: ${task.plan[task.currentStepIndex].description}`
        : '',
      `You are running autonomously. Execute the task step by step.${profileNote}${resumeNote}`,
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
        if (next > 3 && !roundStallReason) {
          roundStallReason = `Stall detected: ${String(data.action || 'unknown')} called ${next} times without progress (last 6 rounds).`;
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
        updateTaskStatus(taskId, 'paused', { pauseReason: 'user_pause' });
        appendJournal(taskId, { type: 'pause', content: 'Paused by user request.' });
        this._broadcast('task_paused', { taskId, reason: 'user_pause' });
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
      currentRoundToolLog = [];

      const roundOutcome = await this._runRoundWithRetry(task, prompt, sessionId, sendSSE, abortSignal);
      finalizeRoundSignatures();
      if (roundStallReason) {
        // Deliver whatever the agent produced before pausing — the inline reasoning /
        // final message was already computed but never sent because the stall check
        // fires before _deliverToChannel. Flush it now so the user sees it in chat.
        const partialResult = roundOutcome.ok ? String(roundOutcome.result?.text || '').trim() : '';
        if (partialResult) {
          try {
            const freshTask = loadTask(taskId);
            if (freshTask) {
              await this._deliverToChannel(freshTask, partialResult);
            }
          } catch { /* best effort */ }
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

