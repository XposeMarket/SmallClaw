/**
 * task-store.ts — Persistent background task storage
 *
 * Tasks are stored as individual JSON files in .smallclaw/tasks/
 * plus an index file for fast listing.
 *
 * This is the data layer only — no execution logic.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfig } from '../config/config';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'stalled'
  | 'needs_assistance'
  | 'complete'
  | 'failed'
  | 'waiting_subagent';   // parent is blocked waiting for child sub-agents to finish

export type PauseReason =
  | 'preempted_by_chat'
  | 'heartbeat_cycle'
  | 'user_pause'
  | 'error'
  | 'max_steps';

export type JournalEntryType =
  | 'tool_call'
  | 'tool_result'
  | 'advisor_decision'
  | 'status_push'
  | 'pause'
  | 'resume'
  | 'error'
  | 'plan_mutation'
  | 'heartbeat';

export interface TaskPlanStep {
  index: number;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  completedAt?: number;
  notes?: string;
}

export interface TaskJournalEntry {
  t: number;
  type: JournalEntryType;
  content: string;      // compact one-liner
  detail?: string;      // full data if needed
}

export interface TaskResumeContext {
  messages: any[];                   // full messages[] array compressed
  browserSessionActive: boolean;
  browserUrl?: string;
  round: number;
  orchestrationLog: string[];
  fileOpState?: {
    type: string;
    owner: 'primary' | 'secondary';
    touchedFiles: string[];
  };
  onResumeInstruction?: string;      // injected into parent context when all children complete
}

export type SubagentProfile = 'file_editor' | 'researcher' | 'shell_runner' | 'reader_only';

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;                    // verbatim original user message
  sessionId: string;                 // originating chat session
  channel: 'web' | 'telegram';
  telegramChatId?: number;

  // ── Sub-agent fields ─────────────────────────────────────────────────────
  parentTaskId?: string;             // set if this task was spawned by a parent
  pendingSubagentIds?: string[];     // child task IDs the parent is waiting on
  subagentProfile?: SubagentProfile; // restricts tool access for this child task

  status: TaskStatus;
  pauseReason?: PauseReason;

  plan: TaskPlanStep[];
  currentStepIndex: number;
  maxPlanDepth: number;              // default 20

  journal: TaskJournalEntry[];
  lastToolCall?: string;
  lastToolCallAt?: number;
  lastProgressAt: number;

  startedAt: number;
  completedAt?: number;

  resumeContext: TaskResumeContext;
  finalSummary?: string;
}

// ─── Index ─────────────────────────────────────────────────────────────────────

interface TaskIndex {
  ids: string[];
  updatedAt: number;
}

// ─── Store ─────────────────────────────────────────────────────────────────────

const TASKS_DIR_NAME = 'tasks';

function getStateBaseDir(): string {
  try {
    return getConfig().getConfigDir();
  } catch {
    return path.join(process.cwd(), '.smallclaw');
  }
}

function getTasksDir(): string {
  const base = path.join(getStateBaseDir(), TASKS_DIR_NAME);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function taskFilePath(id: string): string {
  return path.join(getTasksDir(), `${id}.json`);
}

function indexFilePath(): string {
  return path.join(getTasksDir(), '_index.json');
}

function loadIndex(): TaskIndex {
  const p = indexFilePath();
  if (!fs.existsSync(p)) return { ids: [], updatedAt: Date.now() };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;

    // Backward compatibility: older builds persisted the index as string[].
    if (Array.isArray(parsed)) {
      const ids = parsed.filter((v): v is string => typeof v === 'string');
      return { ids: Array.from(new Set(ids)), updatedAt: Date.now() };
    }

    if (parsed && typeof parsed === 'object') {
      const record = parsed as { ids?: unknown; updatedAt?: unknown };
      const ids = Array.isArray(record.ids)
        ? record.ids.filter((v): v is string => typeof v === 'string')
        : [];
      const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : Date.now();
      return { ids: Array.from(new Set(ids)), updatedAt };
    }

    return { ids: [], updatedAt: Date.now() };
  } catch {
    return { ids: [], updatedAt: Date.now() };
  }
}

function saveIndex(index: TaskIndex): void {
  fs.writeFileSync(indexFilePath(), JSON.stringify(index, null, 2), 'utf-8');
}

function addToIndex(id: string): void {
  const idx = loadIndex();
  if (!idx.ids.includes(id)) {
    idx.ids.push(id);
    idx.updatedAt = Date.now();
    saveIndex(idx);
  }
}

function removeFromIndex(id: string): void {
  const idx = loadIndex();
  idx.ids = idx.ids.filter(i => i !== id);
  idx.updatedAt = Date.now();
  saveIndex(idx);
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

export function createTask(params: {
  title: string;
  prompt: string;
  sessionId: string;
  channel: 'web' | 'telegram';
  telegramChatId?: number;
  plan: TaskPlanStep[];
  // Sub-agent fields
  parentTaskId?: string;
  subagentProfile?: string;
  onResumeInstruction?: string;
}): TaskRecord {
  const id = crypto.randomUUID();
  const now = Date.now();

  const task: TaskRecord = {
    id,
    title: params.title,
    prompt: params.prompt,
    sessionId: params.sessionId,
    channel: params.channel,
    telegramChatId: params.telegramChatId,

    status: 'queued',

    // Sub-agent wiring
    parentTaskId: params.parentTaskId,
    pendingSubagentIds: [],
    subagentProfile: params.subagentProfile as SubagentProfile | undefined,

    plan: params.plan,
    currentStepIndex: 0,
    maxPlanDepth: 20,

    journal: [{
      t: now,
      type: 'status_push',
      content: `Task created: ${params.title}`,
    }],
    lastProgressAt: now,
    startedAt: now,

    resumeContext: {
      messages: [],
      browserSessionActive: false,
      round: 0,
      orchestrationLog: [],
      onResumeInstruction: params.onResumeInstruction,
    },
  };

  saveTask(task);
  addToIndex(id);
  return task;
}

export function loadTask(id: string): TaskRecord | null {
  const p = taskFilePath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as TaskRecord;
  } catch {
    return null;
  }
}

export function saveTask(task: TaskRecord): void {
  // Trim journal to last 500 entries to prevent unbounded growth
  if (task.journal.length > 500) {
    task.journal = task.journal.slice(-500);
  }
  fs.writeFileSync(taskFilePath(task.id), JSON.stringify(task, null, 2), 'utf-8');
}

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  opts?: { pauseReason?: PauseReason; finalSummary?: string },
): TaskRecord | null {
  const task = loadTask(id);
  if (!task) return null;
  task.status = status;
  if (opts?.pauseReason) task.pauseReason = opts.pauseReason;
  if (opts?.finalSummary) task.finalSummary = opts.finalSummary;
  if (status === 'complete' || status === 'failed') task.completedAt = Date.now();
  task.lastProgressAt = Date.now();
  saveTask(task);
  return task;
}

export function appendJournal(id: string, entry: Omit<TaskJournalEntry, 't'>): void {
  const task = loadTask(id);
  if (!task) return;
  task.journal.push({ t: Date.now(), ...entry });
  task.lastProgressAt = Date.now();
  if (entry.type === 'tool_call') {
    task.lastToolCall = entry.content;
    task.lastToolCallAt = Date.now();
  }
  saveTask(task);
}

export function updateResumeContext(id: string, ctx: Partial<TaskResumeContext>): void {
  const task = loadTask(id);
  if (!task) return;
  task.resumeContext = { ...task.resumeContext, ...ctx };
  saveTask(task);
}

export function mutatePlan(
  id: string,
  mutations: Array<
    | { op: 'complete'; step_index: number; notes?: string }
    | { op: 'add'; after_index: number; description: string }
    | { op: 'modify'; step_index: number; description: string }
  >,
): TaskRecord | null {
  const task = loadTask(id);
  if (!task) return null;

  for (const m of mutations) {
    if (m.op === 'complete') {
      const step = task.plan[m.step_index];
      if (step) {
        step.status = 'done';
        step.completedAt = Date.now();
        if (m.notes) step.notes = m.notes;
      }
    } else if (m.op === 'add') {
      // Guard max plan depth
      if (task.plan.length >= task.maxPlanDepth) continue;
      const insertAt = m.after_index + 1;
      const newStep: TaskPlanStep = {
        index: insertAt,
        description: m.description,
        status: 'pending',
      };
      task.plan.splice(insertAt, 0, newStep);
      // Re-index
      task.plan.forEach((s, i) => { s.index = i; });
    } else if (m.op === 'modify') {
      const step = task.plan[m.step_index];
      if (step && step.status === 'pending') {
        step.description = m.description;
      }
    }
  }

  task.journal.push({
    t: Date.now(),
    type: 'plan_mutation',
    content: `Plan mutated: ${mutations.map(m => m.op).join(', ')}`,
    detail: JSON.stringify(mutations),
  });

  saveTask(task);
  return task;
}

// ── Sub-Agent Completion ────────────────────────────────────────────────────────────

/**
 * Called when a child task completes. Removes it from the parent's pending
 * list and, if all children are done, re-queues the parent to resume.
 * Returns the parent task (if found) and whether all children finished.
 */
export function resolveSubagentCompletion(
  childTaskId: string,
  childSummary: string,
): { parentTask: TaskRecord | null; allChildrenDone: boolean } {
  const child = loadTask(childTaskId);
  if (!child?.parentTaskId) return { parentTask: null, allChildrenDone: false };

  const parent = loadTask(child.parentTaskId);
  if (!parent) return { parentTask: null, allChildrenDone: false };

  // Remove this child from pending list
  parent.pendingSubagentIds = (parent.pendingSubagentIds || [])
    .filter(id => id !== childTaskId);

  // Inject sub-agent result into parent's resume messages
  const resultMessage = {
    role: 'user',
    content: `[SUBAGENT RESULT: ${child.title}]\n${childSummary.slice(0, 800)}\n[/SUBAGENT RESULT]`,
    timestamp: Date.now(),
  };
  parent.resumeContext.messages = [
    ...(parent.resumeContext.messages || []),
    resultMessage,
  ].slice(-10); // respect MAX_RESUME_MESSAGES

  const allChildrenDone = (parent.pendingSubagentIds || []).length === 0;

  if (allChildrenDone) {
    parent.status = 'queued'; // ready to resume — runner will set to 'running'
    parent.lastProgressAt = Date.now();
    parent.journal.push({
      t: Date.now(),
      type: 'resume',
      content: `All sub-agents complete. Re-queuing parent task.`,
    });
  } else {
    parent.journal.push({
      t: Date.now(),
      type: 'status_push',
      content: `Sub-agent "${child.title}" finished. Still waiting on ${parent.pendingSubagentIds!.length} child(ren).`,
    });
  }

  saveTask(parent);
  return { parentTask: parent, allChildrenDone };
}

export function listTasks(filter?: { status?: TaskStatus[] }): TaskRecord[] {
  const idx = loadIndex();
  const tasks: TaskRecord[] = [];
  for (const id of idx.ids) {
    const task = loadTask(id);
    if (!task) continue;
    if (filter?.status && !filter.status.includes(task.status)) continue;
    tasks.push(task);
  }
  return tasks.sort((a, b) => b.startedAt - a.startedAt);
}

export function deleteTask(id: string): boolean {
  const p = taskFilePath(id);
  const idx = loadIndex();
  const inIndex = idx.ids.includes(id);
  let removedAny = false;

  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
      removedAny = true;
    } catch {
      // best effort; continue cleanup of related artifacts
    }
  }

  // Always remove from index to prevent stale list entries.
  if (inIndex) {
    removeFromIndex(id);
    removedAny = true;
  }

  // Remove related task artifacts created by background execution.
  const base = getStateBaseDir();
  const relatedFiles = [
    path.join(base, 'sessions', `task_${id}.json`),
    path.join(base, 'jobs', 'file-op-v2', `task_${id}.json`),
    // Backward-compat for older/alternate checkpoint naming.
    path.join(base, 'jobs', 'file-op-v2', `${id}.json`),
  ];
  for (const file of relatedFiles) {
    if (!fs.existsSync(file)) continue;
    try {
      fs.unlinkSync(file);
      removedAny = true;
    } catch {
      // best effort only
    }
  }

  return removedAny;
}

// ─── Snapshot for heartbeat advisor ────────────────────────────────────────────

export interface TaskSnapshot {
  id: string;
  title: string;
  status: TaskStatus;
  pauseReason?: PauseReason;
  currentStepIndex: number;
  totalSteps: number;
  lastProgressMinutesAgo: number;
  lastToolCall?: string;
  currentStep?: string;
  nextStep?: string;
  recentJournal: string[];
  channel: 'web' | 'telegram';
  sessionId: string;
}

export function buildTaskSnapshot(task: TaskRecord): TaskSnapshot {
  const now = Date.now();
  const current = task.plan[task.currentStepIndex];
  const next = task.plan[task.currentStepIndex + 1];
  const recentJournal = task.journal.slice(-8).map(j => `[${j.type}] ${j.content}`);

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    pauseReason: task.pauseReason,
    currentStepIndex: task.currentStepIndex,
    totalSteps: task.plan.length,
    lastProgressMinutesAgo: Math.round((now - task.lastProgressAt) / 60000),
    lastToolCall: task.lastToolCall,
    currentStep: current?.description,
    nextStep: next?.description,
    recentJournal,
    channel: task.channel,
    sessionId: task.sessionId,
  };
}
