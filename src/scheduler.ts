import fs from 'fs';
import path from 'path';
import { Cron } from 'croner';
import { getAgents, ensureAgentWorkspace } from './config/config.js';
import { spawnAgent } from './agents/spawner.js';

const activeCronJobs: Map<string, Cron> = new Map();
const historyPath = path.join(process.cwd(), '.smallclaw', 'agents', 'run-history.json');
const MAX_HISTORY = 300;

export interface AgentRunHistoryEntry {
  id: string;
  agentId: string;
  agentName: string;
  trigger: 'cron' | 'manual';
  success: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  stepCount?: number;
  error?: string;
  resultPreview?: string;
}

let runHistoryCache: AgentRunHistoryEntry[] | null = null;

function loadRunHistory(): AgentRunHistoryEntry[] {
  if (runHistoryCache) return runHistoryCache;
  try {
    if (!fs.existsSync(historyPath)) {
      runHistoryCache = [];
      return runHistoryCache;
    }
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    runHistoryCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    runHistoryCache = [];
  }
  return runHistoryCache;
}

function saveRunHistory(entries: AgentRunHistoryEntry[]): void {
  runHistoryCache = entries.slice(-MAX_HISTORY);
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(runHistoryCache, null, 2), 'utf-8');
  } catch {}
}

export function recordAgentRun(entry: Omit<AgentRunHistoryEntry, 'id'>): AgentRunHistoryEntry {
  const saved: AgentRunHistoryEntry = {
    ...entry,
    id: `ar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  };
  const existing = loadRunHistory();
  existing.push(saved);
  saveRunHistory(existing);
  return saved;
}

export function getAgentRunHistory(agentId?: string, limit = 30): AgentRunHistoryEntry[] {
  const all = loadRunHistory();
  const filtered = agentId ? all.filter(r => r.agentId === agentId) : all;
  return filtered.slice(-Math.max(1, limit)).reverse();
}

export function getAgentLastRun(agentId: string): AgentRunHistoryEntry | null {
  const all = loadRunHistory();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].agentId === agentId) return all[i];
  }
  return null;
}

export function initializeAgentSchedules(): void {
  const agents = getAgents();

  for (const agent of agents) {
    if (!agent.cronSchedule) continue;
    const expr = String(agent.cronSchedule || '').trim();
    if (!expr) continue;

    try {
      // Validate by asking Croner for the next run.
      const probe = new Cron(expr, { paused: true, maxRuns: 1 });
      const next = probe.nextRun();
      probe.stop();
      if (!next) {
        console.warn(`[Scheduler] Invalid cron schedule for agent "${agent.id}": ${expr}`);
        continue;
      }
    } catch {
      console.warn(`[Scheduler] Invalid cron schedule for agent "${agent.id}": ${expr}`);
      continue;
    }

    // Stop existing job if config changed
    activeCronJobs.get(agent.id)?.stop();

    const job = new Cron(expr, async () => {
      const startedAt = Date.now();
      console.log(`[Scheduler] Waking agent "${agent.id}" (${agent.name})`);
      const ws = ensureAgentWorkspace(agent);

      // Read HEARTBEAT.md to get the agent's autonomous task
      const heartbeatPath = path.join(ws, 'HEARTBEAT.md');
      const heartbeatContent = fs.existsSync(heartbeatPath)
        ? fs.readFileSync(heartbeatPath, 'utf-8').trim()
        : 'Check for anything useful to do and write a journal entry.';

      const task = [
        'You have been woken by the scheduler. Read your HEARTBEAT.md and execute the tasks described.',
        '',
        'HEARTBEAT.md contents:',
        heartbeatContent,
      ].join('\n');

      const result = await spawnAgent({
        agentId: agent.id,
        task,
        timeoutMs: 300000, // 5 min timeout for scheduled runs
      });
      const finishedAt = Date.now();

      recordAgentRun({
        agentId: agent.id,
        agentName: agent.name,
        trigger: 'cron',
        success: result.success,
        startedAt,
        finishedAt,
        durationMs: result.durationMs,
        stepCount: result.stepCount,
        error: result.error,
        resultPreview: result.success ? String(result.result || '').slice(0, 400) : undefined,
      });

      if (result.success) {
        console.log(`[Scheduler] Agent "${agent.id}" completed. Steps: ${result.stepCount}. Duration: ${result.durationMs}ms`);
      } else {
        console.error(`[Scheduler] Agent "${agent.id}" failed: ${result.error}`);
      }
    });

    activeCronJobs.set(agent.id, job);
    console.log(`[Scheduler] Registered cron for agent "${agent.id}": ${expr}`);
  }
}

/** Reload schedules when config changes (e.g. after UI update). */
export function reloadAgentSchedules(): void {
  // Stop all existing jobs
  for (const [id, job] of activeCronJobs) {
    job.stop();
    activeCronJobs.delete(id);
  }
  initializeAgentSchedules();
}

/** Stop all active agent schedules. */
export function stopAgentSchedules(): void {
  for (const [id, job] of activeCronJobs) {
    job.stop();
    activeCronJobs.delete(id);
  }
}
