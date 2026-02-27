/**
 * session.ts - Simple session state for LocalClaw v2
 * 
 * No plans. No verified facts. No workspace ledger. No self-learning.
 * Just conversation history.
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config';
import { appendDailyMemoryNote } from './memory-manager';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  id: string;
  history: ChatMessage[];
  workspace: string;
  createdAt: number;
  lastActiveAt: number;
  pendingMemoryFlush?: boolean;
  pendingCompaction?: boolean;
  contextTokenEstimate?: number;
}

const sessions = new Map<string, Session>();
export const PRE_COMPACTION_MEMORY_FLUSH_PROMPT = 'Before continuing: write any important facts from this conversation to memory now.';
export const PRE_COMPACTION_SUMMARY_PROMPT = 'Before continuing: summarize the conversation so far into a compact context note. Include goals, constraints, decisions, and open items in <= 180 words.';
const API_HISTORY_PRUNE_THRESHOLD_CHARS = 3000;
const API_HISTORY_PRUNE_KEEP_CHARS = 2500;
const SESSION_CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_SESSION_ID_RE = /^(task_|cron_)/i;
const SESSION_SAVE_DEBOUNCE_MS = 500;
const sessionSaveTimers = new Map<string, NodeJS.Timeout>();

const SESSION_DIR = (() => {
  try {
    return path.join(getConfig().getConfigDir(), 'sessions');
  } catch {
    return path.join(process.cwd(), '.localclaw', 'sessions');
  }
})();

function ensureSessionDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function getSessionPath(id: string): string {
  return path.join(SESSION_DIR, `${id}.json`);
}

function resolveNumCtx(): number {
  const envCandidates = [
    process.env.LOCALCLAW_SESSION_NUM_CTX,
    process.env.LOCALCLAW_CHAT_NUM_CTX,
  ];
  for (const raw of envCandidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 512) return Math.floor(n);
  }
  try {
    const cfg: any = getConfig().getConfig();
    const candidate = Number(cfg?.llm?.num_ctx);
    if (Number.isFinite(candidate) && candidate > 512) return Math.floor(candidate);
  } catch {
    // fall through
  }
  return 8192;
}

function estimateMessageTokens(msg: ChatMessage): number {
  const contentTokens = Math.max(1, Math.ceil(String(msg.content || '').length / 3.5));
  // Per-message framing overhead
  return contentTokens + 6;
}

function estimateHistoryTokens(history: ChatMessage[]): number {
  let total = 0;
  for (const msg of history) total += estimateMessageTokens(msg);
  return total;
}

function resolveSessionPolicy(): {
  maxMessages: number;
  compactionThreshold: number;
  memoryFlushThreshold: number;
} {
  const defaults = {
    maxMessages: 120,
    compactionThreshold: 0.7,
    memoryFlushThreshold: 0.75,
  };
  try {
    const cfg: any = getConfig().getConfig();
    const maxMessagesRaw = Number(cfg?.session?.maxMessages);
    const compactionThresholdRaw = Number(cfg?.session?.compactionThreshold);
    const memoryFlushThresholdRaw = Number(cfg?.session?.memoryFlushThreshold);
    const maxMessages = Number.isFinite(maxMessagesRaw) && maxMessagesRaw >= 20
      ? Math.floor(maxMessagesRaw)
      : defaults.maxMessages;
    const compactionThreshold = Number.isFinite(compactionThresholdRaw) && compactionThresholdRaw >= 0.4 && compactionThresholdRaw <= 0.95
      ? compactionThresholdRaw
      : defaults.compactionThreshold;
    const memoryFlushThreshold = Number.isFinite(memoryFlushThresholdRaw) && memoryFlushThresholdRaw >= 0.5 && memoryFlushThresholdRaw <= 0.98
      ? memoryFlushThresholdRaw
      : defaults.memoryFlushThreshold;
    return { maxMessages, compactionThreshold, memoryFlushThreshold };
  } catch {
    return defaults;
  }
}

function trimHistory(session: Session, maxMessages: number): void {
  if (session.history.length > maxMessages) {
    session.history = session.history.slice(-maxMessages);
  }
}

function compactHistoryWithSummary(session: Session, summaryText: string, maxMessages: number): boolean {
  const promptIndex = session.history
    .map((m, i) => ({ m, i }))
    .reverse()
    .find((x) => x.m.role === 'user' && x.m.content === PRE_COMPACTION_SUMMARY_PROMPT)?.i ?? -1;
  if (promptIndex <= 0) return false;

  const beforePrompt = session.history.slice(0, promptIndex);
  const tailAfterSummary = session.history.slice(promptIndex + 2);
  if (beforePrompt.length < 4) {
    session.history = [...beforePrompt, ...tailAfterSummary];
    trimHistory(session, maxMessages);
    return true;
  }

  const droppedHalfEnd = Math.max(1, Math.floor(beforePrompt.length / 2));
  const keptRecentHalf = beforePrompt.slice(droppedHalfEnd);
  const summaryMsg: ChatMessage = {
    role: 'assistant',
    content: `[Compacted context summary]\n${String(summaryText || '').trim() || '(No summary generated.)'}`,
    timestamp: Date.now(),
  };

  // Persist compaction summary so restart does not lose condensed context.
  try {
    appendDailyMemoryNote(`[compaction-summary] ${String(summaryText || '').slice(0, 600)}`);
  } catch {
    // Memory persistence must not break chat flow.
  }

  session.history = [summaryMsg, ...keptRecentHalf, ...tailAfterSummary];
  if (session.history.length > maxMessages) {
    session.history = [summaryMsg, ...session.history.slice(-(maxMessages - 1))];
  }
  return true;
}

export interface AddMessageOptions {
  deferOnMemoryFlush?: boolean;
  deferOnCompaction?: boolean;
  disableMemoryFlushCheck?: boolean;
  disableCompactionCheck?: boolean;
  disableAutoSave?: boolean;
  maxMessages?: number;
}

export interface AddMessageResult {
  added: boolean;
  compactionInjected: boolean;
  deferredForCompaction: boolean;
  compactionPrompt?: string;
  compactionApplied?: boolean;
  memoryFlushInjected: boolean;
  deferredForMemoryFlush: boolean;
  memoryFlushPrompt?: string;
  estimatedTokens: number;
  contextLimitTokens: number;
  thresholdTokens: number;
}

export function getSession(id: string): Session {
  if (sessions.has(id)) {
    return sessions.get(id)!;
  }

  ensureSessionDir();
  const filePath = getSessionPath(id);

  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const session: Session = {
        id: data.id || id,
        history: Array.isArray(data.history) ? data.history : [],
        workspace: data.workspace || getConfig().getWorkspacePath(),
        createdAt: data.createdAt || Date.now(),
        lastActiveAt: data.lastActiveAt || Date.now(),
        pendingMemoryFlush: data.pendingMemoryFlush === true,
        pendingCompaction: data.pendingCompaction === true,
        contextTokenEstimate: Number.isFinite(Number(data.contextTokenEstimate))
          ? Number(data.contextTokenEstimate)
          : undefined,
      };
      sessions.set(id, session);
      return session;
    } catch {
      // Corrupted file, create new session
    }
  }

  const session: Session = {
    id,
    history: [],
    workspace: getConfig().getWorkspacePath(),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pendingMemoryFlush: false,
    pendingCompaction: false,
    contextTokenEstimate: 0,
  };
  sessions.set(id, session);
  saveSession(id);
  return session;
}

export function addMessage(id: string, msg: ChatMessage, options: AddMessageOptions = {}): AddMessageResult {
  const session = getSession(id);
  const sessionPolicy = resolveSessionPolicy();
  const maxMessages = Number.isFinite(Number(options.maxMessages)) && Number(options.maxMessages) >= 10
    ? Math.floor(Number(options.maxMessages))
    : sessionPolicy.maxMessages;
  const contextLimitTokens = resolveNumCtx();
  const thresholdTokens = Math.floor(contextLimitTokens * sessionPolicy.memoryFlushThreshold);
  const compactionThresholdTokens = Math.floor(contextLimitTokens * sessionPolicy.compactionThreshold);
  const beforeTokens = estimateHistoryTokens(session.history);
  let compactionInjected = false;
  let deferredForCompaction = false;
  let compactionApplied = false;
  let memoryFlushInjected = false;
  let deferredForMemoryFlush = false;

  if (
    msg.role === 'user'
    && !options.disableCompactionCheck
    && !session.pendingCompaction
  ) {
    const projectedTokens = beforeTokens + estimateMessageTokens(msg);
    const recentlyCompacted = session.history
      .slice(-8)
      .some((h) => h.role === 'user' && h.content === PRE_COMPACTION_SUMMARY_PROMPT);
    const shouldCompact = projectedTokens >= compactionThresholdTokens && !recentlyCompacted;
    if (shouldCompact) {
      session.history.push({
        role: 'user',
        content: PRE_COMPACTION_SUMMARY_PROMPT,
        timestamp: Math.max(0, msg.timestamp - 1),
      });
      session.pendingCompaction = true;
      compactionInjected = true;
      deferredForCompaction = options.deferOnCompaction === true;
    }
  }

  if (
    !deferredForCompaction
    && msg.role === 'user'
    && !options.disableMemoryFlushCheck
    && !session.pendingMemoryFlush
  ) {
    const projectedTokens = beforeTokens + estimateMessageTokens(msg);
    const recentlyPrompted = session.history
      .slice(-6)
      .some((h) => h.role === 'user' && h.content === PRE_COMPACTION_MEMORY_FLUSH_PROMPT);
    const shouldInject = projectedTokens >= thresholdTokens && !recentlyPrompted;
    if (shouldInject) {
      session.history.push({
        role: 'user',
        content: PRE_COMPACTION_MEMORY_FLUSH_PROMPT,
        timestamp: Math.max(0, msg.timestamp - 1),
      });
      session.pendingMemoryFlush = true;
      memoryFlushInjected = true;
      deferredForMemoryFlush = options.deferOnMemoryFlush === true;
    }
  }

  const storedMsg: ChatMessage = { ...msg };

  if (!deferredForCompaction && !deferredForMemoryFlush) {
    session.history.push(storedMsg);
  }

  if (storedMsg.role === 'assistant' && session.pendingCompaction) {
    compactionApplied = compactHistoryWithSummary(session, storedMsg.content, maxMessages);
    session.pendingCompaction = false;
  }

  if (storedMsg.role === 'assistant' && session.pendingMemoryFlush) {
    session.pendingMemoryFlush = false;
  }

  trimHistory(session, maxMessages);
  session.contextTokenEstimate = estimateHistoryTokens(session.history);
  session.lastActiveAt = Date.now();
  if (!options.disableAutoSave) {
    saveSession(id);
  }

  return {
    added: !deferredForCompaction && !deferredForMemoryFlush,
    compactionInjected,
    deferredForCompaction,
    compactionPrompt: compactionInjected ? PRE_COMPACTION_SUMMARY_PROMPT : undefined,
    compactionApplied,
    memoryFlushInjected,
    deferredForMemoryFlush,
    memoryFlushPrompt: memoryFlushInjected ? PRE_COMPACTION_MEMORY_FLUSH_PROMPT : undefined,
    estimatedTokens: session.contextTokenEstimate,
    contextLimitTokens,
    thresholdTokens,
  };
}

export function getHistory(id: string, maxTurns: number = 10): ChatMessage[] {
  const session = getSession(id);
  // Return last N messages (2 messages per turn = user + assistant)
  const maxMessages = maxTurns * 2;
  return session.history.slice(-maxMessages);
}

export function getHistoryForApiCall(id: string, maxTurns: number = 60): ChatMessage[] {
  const messages = getHistory(id, maxTurns);
  return messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    const content = String(msg.content || '');
    if (content.length <= API_HISTORY_PRUNE_THRESHOLD_CHARS) return msg;
    const removed = content.length - API_HISTORY_PRUNE_KEEP_CHARS;
    return {
      ...msg,
      content: `${content.slice(0, API_HISTORY_PRUNE_KEEP_CHARS)}\n[pruned: ${removed} chars]`,
    };
  });
}

export function clearHistory(id: string): void {
  const session = getSession(id);
  session.history = [];
  session.pendingCompaction = false;
  session.pendingMemoryFlush = false;
  session.contextTokenEstimate = 0;
  session.lastActiveAt = Date.now();
  saveSession(id);
}

export function cleanupSessions(nowMs: number = Date.now()): { deleted: number; scanned: number } {
  ensureSessionDir();
  let deleted = 0;
  let scanned = 0;
  try {
    const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      scanned++;
      const id = file.replace(/\.json$/i, '');
      if (!AUTO_SESSION_ID_RE.test(id)) continue;
      const filePath = path.join(SESSION_DIR, file);
      let st: fs.Stats;
      try {
        st = fs.statSync(filePath);
      } catch {
        continue;
      }
      const ageMs = nowMs - Number(st.mtimeMs || 0);
      if (ageMs < SESSION_CLEANUP_MAX_AGE_MS) continue;
      try {
        fs.unlinkSync(filePath);
        sessions.delete(id);
        deleted++;
      } catch {
        // ignore unlink failures; next startup can retry
      }
    }
  } catch {
    return { deleted: 0, scanned: 0 };
  }
  return { deleted, scanned };
}

function saveSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;

  const existing = sessionSaveTimers.get(id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    sessionSaveTimers.delete(id);
    const latest = sessions.get(id);
    if (!latest) return;
    ensureSessionDir();
    try {
      fs.writeFileSync(getSessionPath(id), JSON.stringify(latest, null, 2));
    } catch (err) {
      console.warn(`[session] Failed to save session ${id}:`, err);
    }
  }, SESSION_SAVE_DEBOUNCE_MS);
  if (typeof (timer as any).unref === 'function') {
    (timer as any).unref();
  }
  sessionSaveTimers.set(id, timer);
}

export function flushSession(id: string): void {
  const existing = sessionSaveTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    sessionSaveTimers.delete(id);
  }
  const session = sessions.get(id);
  if (!session) return;
  ensureSessionDir();
  try {
    fs.writeFileSync(getSessionPath(id), JSON.stringify(session, null, 2));
  } catch (err) {
    console.warn(`[session] Failed to flush session ${id}:`, err);
  }
}

export function getWorkspace(id: string): string {
  return getSession(id).workspace;
}

export function setWorkspace(id: string, workspacePath: string): void {
  const session = getSession(id);
  session.workspace = workspacePath;
  session.lastActiveAt = Date.now();
  saveSession(id);
}
