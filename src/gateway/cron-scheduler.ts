/**
 * cron-scheduler.ts — SmallClaw Tasks / Cron System
 *
 * Design constraints (4B model reality):
 *  - isModelBusy guard: if a user chat is in-flight, skip the tick entirely
 *  - One task at a time, no parallelism
 *  - Minimal cron parsing — handles the 90% patterns without external deps
 *  - HEARTBEAT_OK response is silently suppressed
 *  - Any real content → creates an automated chat session broadcast over WS
 *  - Telegram stub: deliverTelegram() is a no-op with a clear TODO marker
 */

import fs from 'fs';
import path from 'path';
import { Cron } from 'croner';
import { BackgroundTaskRunner } from './background-task-runner';
import { clearHistory } from './session';
import { getConfig } from '../config/config';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  type: 'one-shot' | 'recurring' | 'heartbeat';
  schedule: string | null;   // Cron expression (5 or 6 fields), e.g. "*/30 * * * *"
  tz?: string;               // Optional IANA timezone (e.g. "America/New_York")
  sessionTarget: 'main' | 'isolated';       // default: isolated
  payloadKind: 'agentTurn' | 'systemEvent'; // default: agentTurn
  systemEventText?: string;                  // used when payloadKind=systemEvent
  model?: string;                            // optional per-job model override
  runAt: string | null;      // ISO timestamp for one-shots
  enabled: boolean;
  priority: number;          // lower number = higher priority
  delivery: 'web';           // 'telegram' coming later — stub is ready
  lastRun: string | null;
  lastResult: string | null;
  lastDuration: number | null;
  consecutiveErrors?: number;
  deleteAfterRun?: boolean;
  nextRun: string | null;
  status: 'scheduled' | 'queued' | 'running' | 'completed' | 'paused';
  pausedReason?: 'manual' | 'interrupted_by_schedule';
  lastOutputSessionId: string | null;  // last auto-created session containing output
  createdAt: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  activeHoursStart: number; // 0–23
  activeHoursEnd: number;   // 0–23
}

export interface CronStore {
  heartbeat: HeartbeatConfig;
  jobs: CronJob[];
}

export interface AutomatedSession {
  id: string;
  title: string;
  jobName: string;
  jobId: string;
  history: Array<{ role: string; content: string }>;
  automated: true;
  createdAt: number;
}

export interface RunJobNowOptions {
  // Default false for direct user-triggered runs.
  // Automated recovery callers should pass true.
  respectActiveHours?: boolean;
}

type JobRunStatus = 'ok' | 'success' | 'error';

const TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function isTopOfHourExpr(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts[0] === '0' && parts[1].includes('*');
}

function computeStaggerMs(jobId: string, schedule: string | null): number {
  if (!schedule || !isTopOfHourExpr(schedule)) return 0;
  let hash = 0;
  for (let i = 0; i < jobId.length; i++) {
    hash = ((hash << 5) - hash) + jobId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % TOP_OF_HOUR_STAGGER_MS;
}

function applyDeterministicStagger(nextRunIso: string, jobId: string, schedule: string | null): string {
  const staggerMs = computeStaggerMs(jobId, schedule);
  if (staggerMs <= 0) return nextRunIso;
  const nextRunDate = new Date(nextRunIso);
  if (!Number.isFinite(nextRunDate.getTime())) return nextRunIso;
  return new Date(nextRunDate.getTime() + staggerMs).toISOString();
}

// ─── Minimal Cron Parser ───────────────────────────────────────────────────────
// Supports: * * * * * (min hour dom month dow)
// Patterns covered:
//   */N  * * * *   → every N minutes
//   0    H * * *   → daily at hour H
//   0    H * * D   → weekly on day D at H
//   0    H 1 * *   → monthly on 1st at H
//   *    * * * *   → every minute (should not be used but handled)

export function getNextRun(cronExpr: string | null, from: Date, tz?: string): Date {
  if (!cronExpr) {
    return new Date(from.getTime() + 30 * 60 * 1000);
  }

  try {
    const cron = new Cron(cronExpr.trim(), {
      timezone: tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
      catch: false,
    });
    const next = cron.nextRun(from);
    if (next && Number.isFinite(next.getTime()) && next.getTime() > from.getTime()) {
      return next;
    }
    // Guard: avoid same-second scheduling loops.
    const nextSecond = new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000);
    const retry = cron.nextRun(nextSecond);
    return retry && retry.getTime() > from.getTime()
      ? retry
      : new Date(from.getTime() + 30 * 60 * 1000);
  } catch {
    return new Date(from.getTime() + 30 * 60 * 1000);
  }
}

// ─── Telegram Stub ─────────────────────────────────────────────────────────────
// TODO: Replace this stub with actual telegram delivery when implementing Telegram channel.
// The interface is already defined — just fill in the body of deliverTelegram().

async function deliverTelegram(_jobName: string, _content: string): Promise<void> {
  // STUB — Telegram not yet configured.
  // When implementing:
  //   1. Read config.channels.telegram.botToken and allowedUserIds
  //   2. POST to https://api.telegram.org/bot{token}/sendMessage
  //   3. Split content if > 4096 chars
  console.log('[CronScheduler] Telegram delivery stub called — not yet implemented');
}

// ─── CronScheduler Class ───────────────────────────────────────────────────────

interface SchedulerDeps {
  storePath: string;         // path to jobs.json
  handleChat: (          // direct reference to the handleChat function
    message: string,
    sessionId: string,
    sendSSE: (event: string, data: any) => void,
    pinnedMessages?: Array<{ role: string; content: string }>,
    abortSignal?: { aborted: boolean },
    callerContext?: string,
    modelOverride?: string,
    executionMode?: 'interactive' | 'background_task' | 'heartbeat' | 'cron'
  ) => Promise<{ type: string; text: string; thinking?: string }>;
  broadcast: (data: object) => void; // WebSocket broadcast to all clients
  getIsModelBusy: () => boolean;     // check if a user chat is in-flight
  deliverTelegram?: (text: string) => Promise<void>; // optional telegram delivery
  getMainSessionId?: () => string;
  injectSystemEvent?: (sessionId: string, text: string, job: CronJob) => void;
  // NEW: spawn a proper BackgroundTask instead of raw handleChat
  // Returns a Promise so the caller can await the task creation (including preflight plan generation)
  spawnBackgroundTask?: (job: CronJob) => Promise<{ taskId: string; sessionId: string } | null>;
}

export class CronScheduler {
  private storePath: string;
  private store: CronStore;
  private deps: SchedulerDeps;
  private tickInterval: NodeJS.Timeout | null = null;
  private runningJobId: string | null = null;
  private interruptedTasksBySchedule: Map<string, string[]> = new Map(); // scheduleId -> [taskIds]

  private defaultStore(): CronStore {
    return {
      heartbeat: {
        enabled: false,
        intervalMinutes: 30,
        activeHoursStart: 8,
        activeHoursEnd: 22,
      },
      jobs: [],
    };
  }

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.storePath = deps.storePath;
    this.store = this.loadStore();
    console.log(`[CronScheduler] Loaded ${this.store.jobs.length} jobs from ${this.storePath}`);
  }

  // ─── Store I/O ───────────────────────────────────────────────────────────────

  private loadStore(): CronStore {
    try {
      if (!fs.existsSync(this.storePath)) return this.defaultStore();
      const raw = fs.readFileSync(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const jobs = Array.isArray(parsed.jobs)
        ? parsed.jobs.map((j: any) => ({
            ...j,
            sessionTarget: j?.sessionTarget === 'main' ? 'main' : 'isolated',
            payloadKind: j?.payloadKind === 'systemEvent' ? 'systemEvent' : 'agentTurn',
            lastOutputSessionId: j?.lastOutputSessionId ?? j?.sessionId ?? null,
          }))
        : [];
      return {
        heartbeat: { ...this.defaultStore().heartbeat, ...(parsed.heartbeat || {}) },
        jobs,
      };
    } catch {
      return this.defaultStore();
    }
  }

  private saveStore(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.storePath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf-8');
      fs.renameSync(tmp, this.storePath);
    } catch (err: any) {
      console.error('[CronScheduler] Failed to save store:', err.message);
    }
  }

  private appendRunHistory(jobId: string, entry: { t: string; status: JobRunStatus; duration: number; result_excerpt: string }): void {
    try {
      const baseDir = path.dirname(this.storePath);
      const runsDir = path.join(baseDir, 'runs');
      if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
      const safeId = String(jobId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(runsDir, `${safeId}.jsonl`);

      const lines = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean)
        : [];
      lines.push(JSON.stringify(entry));
      let maxRunHistory = 200;
      try {
        const raw = Number((getConfig().getConfig() as any)?.tasks?.maxRunHistory);
        if (Number.isFinite(raw) && raw >= 10) maxRunHistory = Math.floor(raw);
      } catch {
        // keep default
      }
      const trimmed = lines.slice(-maxRunHistory);
      fs.writeFileSync(filePath, trimmed.join('\n') + '\n', 'utf-8');
    } catch (err: any) {
      console.error(`[CronScheduler] Failed to append run history for ${jobId}:`, err?.message || err);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  getJobs(): CronJob[] {
    return this.store.jobs;
  }

  getConfig(): HeartbeatConfig {
    return this.store.heartbeat;
  }

  updateConfig(partial: Partial<HeartbeatConfig>): void {
    this.store.heartbeat = { ...this.store.heartbeat, ...partial };
    this.saveStore();
    // Restart tick loop with new interval
    this.stop();
    this.start();
    this.broadcastUpdate();
  }

  createJob(partial: Partial<CronJob> & { name: string; prompt: string }): CronJob {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date();
    const normalizedType: CronJob['type'] = partial.type === 'one-shot' ? 'one-shot' : 'recurring';

    const job: CronJob = {
      id,
      name: partial.name,
      prompt: partial.prompt,
      type: normalizedType,
      schedule: partial.schedule || '*/30 * * * *',
      tz: partial.tz,
      sessionTarget: partial.sessionTarget === 'main' ? 'main' : 'isolated',
      payloadKind: partial.payloadKind === 'systemEvent' ? 'systemEvent' : 'agentTurn',
      systemEventText: typeof partial.systemEventText === 'string' ? partial.systemEventText : undefined,
      model: typeof partial.model === 'string' ? partial.model : undefined,
      runAt: partial.runAt || null,
      enabled: partial.enabled !== false,
      priority: typeof partial.priority === 'number' ? partial.priority : this.store.jobs.length,
      delivery: 'web',
      lastRun: null,
      lastResult: null,
      lastDuration: null,
      consecutiveErrors: 0,
      deleteAfterRun: partial.deleteAfterRun === true,
      nextRun: normalizedType === 'one-shot' && partial.runAt
        ? partial.runAt
        : applyDeterministicStagger(
            getNextRun(partial.schedule || null, now, partial.tz).toISOString(),
            id,
            partial.schedule || null
          ),
      status: 'scheduled',
      lastOutputSessionId: null,
      createdAt: now.toISOString(),
    };

    this.store.jobs.push(job);
    this.saveStore();
    this.broadcastUpdate();
    console.log(`[CronScheduler] Created job "${job.name}" (${job.id})`);
    return job;
  }

  updateJob(id: string, partial: Partial<CronJob>): CronJob | null {
    const idx = this.store.jobs.findIndex(j => j.id === id);
    if (idx === -1) return null;
    const normalizedPartial: Partial<CronJob> = { ...partial };
    if (partial.type !== undefined) {
      normalizedPartial.type = partial.type === 'one-shot' ? 'one-shot' : 'recurring';
    }
    this.store.jobs[idx] = { ...this.store.jobs[idx], ...normalizedPartial };
    // Recalculate nextRun if schedule changed
    if (partial.schedule !== undefined || partial.runAt !== undefined || partial.tz !== undefined) {
      const job = this.store.jobs[idx];
      job.nextRun = job.type === 'one-shot' && job.runAt
        ? job.runAt
        : applyDeterministicStagger(
            getNextRun(job.schedule, new Date(), job.tz).toISOString(),
            job.id,
            job.schedule
          );
    }
    this.saveStore();
    this.broadcastUpdate();
    return this.store.jobs[idx];
  }

  deleteJob(id: string): boolean {
    const before = this.store.jobs.length;
    this.store.jobs = this.store.jobs.filter(j => j.id !== id);
    if (this.store.jobs.length === before) return false;
    this.saveStore();
    this.broadcastUpdate();
    return true;
  }

  reorderJobs(orderedIds: string[]): void {
    const byId = new Map(this.store.jobs.map(j => [j.id, j]));
    orderedIds.forEach((id, idx) => {
      const job = byId.get(id);
      if (job) job.priority = idx;
    });
    this.store.jobs.sort((a, b) => a.priority - b.priority);
    this.saveStore();
    this.broadcastUpdate();
  }

  async runJobNow(id: string, options: RunJobNowOptions = {}): Promise<void> {
    const job = this.store.jobs.find(j => j.id === id);
    if (!job) return;
    if (job.type === 'heartbeat') {
      console.log(`[CronScheduler] runJobNow ignored for legacy heartbeat job "${job.name}"`);
      return;
    }
    // Run outside the normal tick: ignore model-busy guard (user explicitly requested).
    if (options.respectActiveHours && !this.isWithinActiveHours()) {
      console.log(`[CronScheduler] runJobNow skipped for "${job.name}" - outside active hours`);
      return;
    }
    await this.executeJob(job);
  }

  // ─── Scheduler Loop ──────────────────────────────────────────────────────────

  start(): void {
    if (this.tickInterval) return;
    // Tick every 10 seconds for better cron accuracy
    // 60s intervals could miss a 1-minute cron window; 10s ensures we catch every due job
    this.tickInterval = setInterval(() => this.tick(), 10 * 1000);
    console.log('[CronScheduler] Started — ticking every 10s for accurate cron execution');
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private isWithinActiveHours(): boolean {
    const { activeHoursStart, activeHoursEnd } = this.store.heartbeat;
    const hour = new Date().getHours();
    if (activeHoursStart <= activeHoursEnd) {
      return hour >= activeHoursStart && hour < activeHoursEnd;
    }
    // Overnight range e.g. 22–6
    return hour >= activeHoursStart || hour < activeHoursEnd;
  }

  private tick(): void {
    // CRITICAL: Check if ANY cron jobs are enabled, not just heartbeat!
    // Heartbeat is a separate feature — regular cron jobs should execute independent of it.
    const hasEnabledJobs = this.store.jobs.some(j => j.enabled && j.type !== 'heartbeat');
    if (!hasEnabledJobs && !this.store.heartbeat.enabled) return;
    
    if (this.runningJobId) return; // one at a time
    if (this.deps.getIsModelBusy()) {
      console.log('[CronScheduler] Tick skipped — model is busy with user chat');
      return;
    }
    // Active hours only gates the heartbeat — NOT explicit cron jobs.
    // If a user scheduled "daily at 9:59 PM", that fires regardless of active hours.
    // We only apply the active hours check when the ONLY pending work is heartbeat.
    const hasOverdueExplicitJobs = this.store.jobs.some(j =>
      j.enabled &&
      j.type !== 'heartbeat' &&
      j.status !== 'running' &&
      j.status !== 'paused' &&
      j.status !== 'completed' &&
      j.nextRun !== null &&
      new Date(j.nextRun) <= new Date()
    );
    if (!hasOverdueExplicitJobs && !this.isWithinActiveHours()) {
      // Only skip if there are no explicit cron jobs due — heartbeat respects active hours
      return;
    }

    const now = new Date();
    const overdue = this.store.jobs
      .filter(j =>
        j.enabled &&
        j.type !== 'heartbeat' &&
        j.status !== 'running' &&
        j.status !== 'paused' &&
        j.status !== 'completed' &&
        j.nextRun !== null &&
        new Date(j.nextRun) <= now
      )
      .sort((a, b) => a.priority - b.priority);

    if (overdue.length === 0) return;

    const job = overdue[0];
    console.log(`[CronScheduler] Tick — running job "${job.name}"`);
    // Fire async but don't await — tick returns immediately
    this.executeJob(job).catch(err =>
      console.error(`[CronScheduler] Job "${job.name}" crashed:`, err.message)
    );
  }

  // ─── Job Execution ────────────────────────────────────────────────────────────

  private async executeJob(job: CronJob): Promise<void> {
    this.runningJobId = job.id;
    const start = Date.now();

    // Mark as running
    job.status = 'running';
    this.saveStore();
    this.deps.broadcast({ type: 'tasks_update', jobs: this.store.jobs, config: this.store.heartbeat });
    this.deps.broadcast({ type: 'task_running', jobId: job.id, jobName: job.name });

    // Check for running background tasks and interrupt them if this schedule requires it
    const interruptedTasks: string[] = [];
    const runningTasks = BackgroundTaskRunner.getRunningTasks();
    if (runningTasks.length > 0) {
      console.log(`[CronScheduler] Schedule "${job.name}" found ${runningTasks.length} running background task(s) - interrupting...`);
      for (const taskId of runningTasks) {
        const interrupted = BackgroundTaskRunner.interruptTaskForSchedule(taskId, job.id);
        if (interrupted) {
          interruptedTasks.push(taskId);
          console.log(`[CronScheduler] Interrupted background task ${taskId} for schedule ${job.id}`);
        }
      }
      // Store interrupted tasks by schedule ID for later resumption
      if (interruptedTasks.length > 0) {
        this.interruptedTasksBySchedule.set(job.id, interruptedTasks);
      }
      // Give tasks a moment to pause at round boundary
      if (interruptedTasks.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Fake sessionId for the cron call — isolated from user sessions
    const mainSessionId = this.deps.getMainSessionId?.() || 'default';
    const targetSessionId = job.sessionTarget === 'main'
      ? mainSessionId
      : `cron_${job.id}_${Date.now()}`;
    const isolatedRunSession = job.sessionTarget !== 'main';
    if (isolatedRunSession) {
      // Defensive clear to guarantee clean isolated context for this run.
      clearHistory(targetSessionId);
    }

    // Collect SSE events emitted during the run
    const events: Array<{ type: string; data: any }> = [];
    const sendSSE = (type: string, data: any) => {
      events.push({ type, data });
      // Forward tool_call/tool_result events to UI so NOW card shows live progress
      if (['tool_call', 'tool_result', 'thinking', 'info'].includes(type)) {
        this.deps.broadcast({ type: 'task_sse', jobId: job.id, event: type, data });
      }
    };

    let resultText = '';
    let duration = 0;
    let spawnedTaskId: string | null = null;

    try {
      if (job.payloadKind === 'systemEvent') {
        const text = String(job.systemEventText || job.prompt || '').trim();
        if (text) {
          this.deps.injectSystemEvent?.(targetSessionId, text, job);
          resultText = text;
        } else {
          resultText = 'SYSTEM_EVENT_EMPTY';
        }
      } else if (this.deps.spawnBackgroundTask) {
        // ── Preferred path: spawn a proper BackgroundTask with full task runner ──
        // This gives the job a plan, journal, kanban card, retry logic, and
        // correct tool access — instead of a raw single-shot handleChat call.
        const spawned = await this.deps.spawnBackgroundTask(job);
        if (spawned) {
          spawnedTaskId = spawned.taskId;
          console.log(`[CronScheduler] Job "${job.name}" spawned as background task ${spawned.taskId}`);
          // The task runs asynchronously — we mark the job complete now.
          // The BackgroundTaskRunner will broadcast task_complete when done.
          resultText = `__BACKGROUND_TASK_SPAWNED__:${spawned.taskId}`;
        } else {
          // Fallback to direct handleChat if spawn failed
          const modelOverride = String(job.model || '').trim() || undefined;
          const result = await this.deps.handleChat(
            job.prompt,
            targetSessionId,
            sendSSE,
            undefined,
            undefined,
            undefined,
            modelOverride,
            'cron'
          );
          resultText = result.text || '';
        }
      } else {
        const modelOverride = String(job.model || '').trim() || undefined;
        const result = await this.deps.handleChat(
          job.prompt,
          targetSessionId,
          sendSSE,
          undefined,
          undefined,
          undefined,
          modelOverride,
          'cron'
        );
        resultText = result.text || '';
      }
      duration = Date.now() - start;
    } catch (err: any) {
      resultText = `ERROR: ${err.message}`;
      duration = Date.now() - start;
      console.error(`[CronScheduler] Job "${job.name}" error:`, err.message);
    }

    // Determine if this is a silent OK or real output
    const isSpawnedTask = resultText.startsWith('__BACKGROUND_TASK_SPAWNED__:');
    const isOk = isSpawnedTask || /^\s*HEARTBEAT_OK\s*$/i.test(resultText);
    const runStatus: JobRunStatus = isOk
      ? 'ok'
      : (/^\s*ERROR:/i.test(resultText) ? 'error' : 'success');

    job.lastRun = new Date().toISOString();
    job.lastResult = resultText.slice(0, 500);
    job.lastDuration = duration;

    if (job.type === 'one-shot' || job.deleteAfterRun) {
      this.store.jobs = this.store.jobs.filter(j => j.id !== job.id);
    } else {
      job.status = 'scheduled';
      if (runStatus === 'error') {
        job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
        const backoffMs = Math.min(
          Math.pow(2, job.consecutiveErrors - 1) * 60_000,
          4 * 60 * 60_000
        );
        job.nextRun = new Date(Date.now() + backoffMs).toISOString();
      } else {
        job.consecutiveErrors = 0;
        job.nextRun = applyDeterministicStagger(
          getNextRun(job.schedule, new Date(), job.tz).toISOString(),
          job.id,
          job.schedule
        );
      }
    }

    let automatedSession: AutomatedSession | null = null;

    if (!isOk && resultText.trim() && job.payloadKind !== 'systemEvent') {
      // Create an automated chat session with the output
      const sessionId = `auto_${job.id}_${Date.now()}`;
      const title = `🕐 ${job.name} — ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;

      automatedSession = {
        id: sessionId,
        title,
        jobName: job.name,
        jobId: job.id,
        automated: true,
        createdAt: Date.now(),
        history: [
          { role: 'user', content: `[Automated Task: ${job.name}]\n\n${job.prompt}` },
          { role: 'ai', content: resultText },
        ],
      };

      job.lastOutputSessionId = sessionId;
      console.log(`[CronScheduler] Job "${job.name}" produced output → auto session ${sessionId}`);

      // Deliver to Telegram if available
      if (this.deps.deliverTelegram) {
        const tgMsg = `\ud83d\udd50 <b>${job.name}</b>\n\n${resultText}`;
        this.deps.deliverTelegram(tgMsg).catch(err =>
          console.error(`[CronScheduler] Telegram delivery failed:`, err.message)
        );
      }
    } else {
      console.log(`[CronScheduler] Job "${job.name}" → HEARTBEAT_OK (suppressed)`);
    }

    this.appendRunHistory(job.id, {
      t: job.lastRun || new Date().toISOString(),
      status: runStatus,
      duration,
      result_excerpt: resultText.slice(0, 500),
    });

    this.saveStore();
    if (isolatedRunSession) {
      // Isolated cron runs should not retain conversation context after completion.
      clearHistory(targetSessionId);
    }
    this.runningJobId = null;

    // After schedule completes, resume any tasks that were interrupted by this schedule
    const tasksToResume = this.interruptedTasksBySchedule.get(job.id);
    if (tasksToResume && tasksToResume.length > 0) {
      console.log(`[CronScheduler] Schedule "${job.name}" completed - scheduling resumption of ${tasksToResume.length} task(s)`);
      // Schedule resumption for next heartbeat cycle or shortly after
      setTimeout(() => {
        for (const taskId of tasksToResume) {
          if (BackgroundTaskRunner.resumeTaskAfterSchedule(taskId, job.id)) {
            console.log(`[CronScheduler] Resumed task ${taskId} after schedule ${job.id} completed`);
          }
        }
        this.interruptedTasksBySchedule.delete(job.id);
      }, 2000); // 2 second delay to ensure final state is persisted
    }

    // Broadcast final state to all WebSocket clients
    this.deps.broadcast({
      type: 'task_done',
      jobId: job.id,
      jobName: job.name,
      isOk,
      duration,
      automatedSession,
      jobs: this.store.jobs,
      config: this.store.heartbeat,
    });
  }

  // ─── Task Pause/Resume/Interrupt ─────────────────────────────────────────────

  /**
   * Pause a job (e.g., to resume/retry later)
   */
  pauseJob(id: string, reason: 'manual' | 'interrupted_by_schedule' = 'manual'): CronJob | null {
    const job = this.store.jobs.find(j => j.id === id);
    if (!job) return null;
    job.status = 'paused';
    job.pausedReason = reason;
    this.saveStore();
    this.broadcastUpdate();
    console.log(`[CronScheduler] Job "${job.name}" paused (reason: ${reason})`);
    return job;
  }

  /**
   * Resume a paused job
   */
  resumeJob(id: string): CronJob | null {
    const job = this.store.jobs.find(j => j.id === id);
    if (!job) return null;
    if (job.status !== 'paused') {
      console.warn(`[CronScheduler] Attempt to resume non-paused job "${job.name}"`);
      return job;
    }
    job.status = 'scheduled';
    job.pausedReason = undefined;
    // Recalculate nextRun
    const now = new Date();
    job.nextRun = job.type === 'one-shot' && job.runAt
      ? job.runAt
      : applyDeterministicStagger(
          getNextRun(job.schedule, now, job.tz).toISOString(),
          job.id,
          job.schedule
        );
    this.saveStore();
    this.broadcastUpdate();
    console.log(`[CronScheduler] Job "${job.name}" resumed`);
    return job;
  }

  /**
   * Get job status and pause info
   */
  getJobStatus(id: string): { job: CronJob | null; isPaused: boolean; pauseReason?: string } {
    const job = this.store.jobs.find(j => j.id === id);
    return {
      job: job || null,
      isPaused: job?.status === 'paused',
      pauseReason: job?.pausedReason,
    };
  }

  // ─── Broadcast Helper ─────────────────────────────────────────────────────────

  private broadcastUpdate(): void {
    this.deps.broadcast({ type: 'tasks_update', jobs: this.store.jobs, config: this.store.heartbeat });
  }
}

