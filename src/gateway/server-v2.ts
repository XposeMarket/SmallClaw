/**
 * server-v2.ts - SmallClaw v2 Gateway
 * 
 * Architecture: Native Ollama Tool Calling
 * Memory: Reads SOUL.md, IDENTITY.md, USER.md, MEMORY.md from workspace
 * Search: Tavily / Google Custom Search API / Brave / DuckDuckGo
 * Logging: Daily session logs in memory/
 */

import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { getConfig } from '../config/config';
import { getOllamaClient } from '../agents/ollama-client';
import { getSession, addMessage, getHistory, getHistoryForApiCall, getWorkspace, setWorkspace, clearHistory, cleanupSessions } from './session';
import { hookBus } from './hooks';
import { loadWorkspaceHooks } from './hook-loader';
import { runBootMd } from './boot';
import { TaskRunner, runTask, TaskTool, TaskState } from './task-runner';
import { SkillsManager } from './skills-manager';
import {
  browserOpen,
  browserSnapshot,
  browserClick,
  browserFill,
  browserPressKey,
  browserWait,
  browserScroll,
  browserClose,
  getBrowserToolDefinitions,
  getBrowserSessionInfo,
  getBrowserAdvisorPacket,
} from './browser-tools';
import {
  desktopScreenshot,
  desktopFindWindow,
  desktopFocusWindow,
  desktopClick,
  desktopDrag,
  desktopWait,
  desktopType,
  desktopPressKey,
  desktopGetClipboard,
  desktopSetClipboard,
  getDesktopToolDefinitions,
  getDesktopAdvisorPacket,
} from './desktop-tools';
import { CronScheduler } from './cron-scheduler';
import { HeartbeatRunner } from './heartbeat-runner';
import { TelegramChannel } from './telegram-channel';
import {
  OrchestrationTriggerState,
  callSecondaryPreflight,
  callSecondaryAdvisor,
  callSecondaryFileOpClassifier,
  callSecondaryFileAnalyzer,
  callSecondaryFileVerifier,
  callSecondaryFilePatchPlanner,
  callSecondaryBrowserAdvisor,
  callSecondaryDesktopAdvisor,
  callSecondaryHeartbeatAdvisor,
  formatPreflightExecutionObjective,
  formatPreflightHint,
  formatAdvisoryHint,
  formatBrowserAdvisorHint,
  formatDesktopAdvisorHint,
  getOrchestrationConfig,
  clampOrchestrationConfig,
  clampPreemptConfig,
  checkOrchestrationEligibility,
  shouldRunPreflight,
  type TaskSnapshot as HeartbeatTaskSnapshot,
} from '../orchestration/multi-agent';
import {
  createTask,
  loadTask,
  saveTask,
  updateTaskStatus,
  appendJournal,
  updateResumeContext,
  listTasks,
  deleteTask,
  mutatePlan,
  buildTaskSnapshot,
  type TaskRecord,
  type TaskStatus,
} from './task-store';
import { BackgroundTaskRunner } from './background-task-runner';
import {
  FileOpProgressWatchdog,
  FileOpType,
  classifyFileOpType,
  resolveFileOpSettings,
  isFileMutationTool,
  isFileCreateTool,
  isFileEditTool,
  extractFileToolTarget,
  estimateFileToolChange,
  canPrimaryApplyFileTool,
  shouldVerifyFileTurn,
  isSmallSuggestedFix,
  buildFailureSignature,
  buildPatchSignature,
  loadFileOpCheckpoint,
  saveFileOpCheckpoint,
  clearFileOpCheckpoint,
} from '../orchestration/file-op-v2';
import { OllamaProcessManager } from './ollama-process-manager';
import { raceWithWatchdog, PreemptState } from './preempt-watchdog';
import { detectGpu, logGpuStatus } from './gpu-detector';

// ─── Config ────────────────────────────────────────────────────────────────────

const config = getConfig().getConfig();
const PORT = config.gateway.port || 18789;
const HOST = config.gateway.host || '127.0.0.1';
const MAX_TOOL_ROUNDS = 12;
type ExecutionMode = 'interactive' | 'background_task' | 'heartbeat' | 'cron';

{
  const cleaned = cleanupSessions();
  if (cleaned.deleted > 0) {
    console.log(`[session] Cleaned up ${cleaned.deleted} stale automated session file(s).`);
  }
}

// Search config is now read dynamically from config on each request
// so changing keys via settings takes effect immediately without restart

// Active tasks (keyed by session)
const activeTasks: Map<string, TaskState> = new Map();

type OrchestrationEvent = {
  ts: number;
  trigger: 'preflight' | 'explicit' | 'auto';
  mode: 'planner' | 'rescue';
  reason: string;
  route?: string;
};

type OrchestrationSessionStats = {
  assistCount: number;
  events: OrchestrationEvent[];
};

const orchestrationSessionStats: Map<string, OrchestrationSessionStats> = new Map();
const preemptSessionCounts: Map<string, number> = new Map();

function getOrchestrationSessionStats(sessionId: string): OrchestrationSessionStats {
  const id = String(sessionId || 'default');
  const existing = orchestrationSessionStats.get(id);
  if (existing) return existing;
  const created: OrchestrationSessionStats = { assistCount: 0, events: [] };
  orchestrationSessionStats.set(id, created);
  return created;
}

function recordOrchestrationEvent(
  sessionId: string,
  event: Omit<OrchestrationEvent, 'ts'>,
  cfg: ReturnType<typeof getOrchestrationConfig>,
): OrchestrationSessionStats {
  const stats = getOrchestrationSessionStats(sessionId);
  stats.assistCount += 1;
  stats.events.push({ ts: Date.now(), ...event });
  const limit = cfg?.limits?.telemetry_history_limit ?? 100;
  if (stats.events.length > limit) {
    stats.events = stats.events.slice(-limit);
  }
  return stats;
}

function getPreemptSessionCount(sessionId: string): number {
  return preemptSessionCounts.get(String(sessionId || 'default')) || 0;
}

function incrementPreemptSessionCount(sessionId: string): number {
  const id = String(sessionId || 'default');
  const next = getPreemptSessionCount(id) + 1;
  preemptSessionCounts.set(id, next);
  return next;
}

// Safe commands allowlist for run_command
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

const SAFE_COMMANDS: Record<string, string> = isWindows
  ? {
      'chrome': 'start chrome',
      'browser': 'start chrome',
      'firefox': 'start firefox',
      'edge': 'start msedge',
      'notepad': 'start notepad',
      'calc': 'start calc',
      'calculator': 'start calc',
      'explorer': 'start explorer',
      'terminal': 'start cmd',
      'cmd': 'start cmd',
      'powershell': 'start powershell',
    }
  : isMac
    ? {
        'chrome': 'open -a "Google Chrome"',
        'browser': 'open',
        'firefox': 'open -a "Firefox"',
        'edge': 'open -a "Microsoft Edge"',
        'notepad': 'open -a "TextEdit"',
        'calc': 'open -a "Calculator"',
        'calculator': 'open -a "Calculator"',
        'explorer': 'open .',
        'terminal': 'open -a "Terminal"',
        'cmd': 'open -a "Terminal"',
        'powershell': 'open -a "Terminal"',
      }
    : {
        'chrome': 'google-chrome',
        'browser': 'xdg-open',
        'firefox': 'firefox',
        'edge': 'microsoft-edge',
        'notepad': 'gedit',
        'calc': 'gnome-calculator',
        'calculator': 'gnome-calculator',
        'explorer': 'xdg-open .',
        'terminal': 'x-terminal-emulator',
        'cmd': 'x-terminal-emulator',
        'powershell': 'pwsh',
      };

function quoteShellArg(value: string): string {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function buildUrlOpenCommand(url: string): string {
  if (isWindows) return `start "" ${quoteShellArg(url)}`;
  if (isMac) return `open ${quoteShellArg(url)}`;
  return `xdg-open ${quoteShellArg(url)}`;
}

function buildBrowserLaunchCommand(app: string, url: string): string {
  const appCmd = SAFE_COMMANDS[app] || SAFE_COMMANDS.browser;
  if (isWindows) return `${appCmd} ${quoteShellArg(url)}`;
  if (app === 'browser') return buildUrlOpenCommand(url);
  return `${appCmd} ${quoteShellArg(url)}`;
}

const BLOCKED_PATTERNS = ['del ', 'rm ', 'format', 'shutdown', 'restart', 'rmdir', 'rd ', 'taskkill', 'reg '];

// Track last-used filename per session for when model forgets to pass it
const lastFilenameUsed: Map<string, string> = new Map();

// Skills system
const configuredSkillsDir = (config as any).skills?.directory || path.join(process.cwd(), '.localclaw', 'skills');
const fallbackSkillsDir = path.join(process.cwd(), '.localclaw', 'skills');

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function syncMissingSkills(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceSkillDir = path.join(sourceDir, entry.name);
    const sourceSkillMd = path.join(sourceSkillDir, 'SKILL.md');
    if (!fs.existsSync(sourceSkillMd)) continue;

    const targetSkillDir = path.join(targetDir, entry.name);
    if (fs.existsSync(path.join(targetSkillDir, 'SKILL.md'))) continue;
    fs.cpSync(sourceSkillDir, targetSkillDir, { recursive: true });
  }
}

function ensureMultiAgentSkill(targetDir: string): void {
  const targetSkillDir = path.join(targetDir, 'multi-agent-orchestrator');
  const targetSkillMd = path.join(targetSkillDir, 'SKILL.md');
  if (fs.existsSync(targetSkillMd)) return;

  const templateCandidates = [
    path.join(fallbackSkillsDir, 'multi-agent-orchestrator', 'SKILL.md'),
    path.join(process.cwd(), 'src', 'orchestration', 'SKILL.md'),
  ];

  const templatePath = templateCandidates.find(p => fs.existsSync(p));
  if (!templatePath) return;

  fs.mkdirSync(targetSkillDir, { recursive: true });
  fs.writeFileSync(targetSkillMd, fs.readFileSync(templatePath, 'utf-8'), 'utf-8');
}

function migrateSkillsStateIfMissing(targetDir: string): void {
  const targetStatePath = path.join(path.dirname(targetDir), 'skills_state.json');
  if (fs.existsSync(targetStatePath)) return;

  const sourceStatePath = path.join(path.dirname(fallbackSkillsDir), 'skills_state.json');
  if (!fs.existsSync(sourceStatePath)) return;

  fs.mkdirSync(path.dirname(targetStatePath), { recursive: true });
  fs.copyFileSync(sourceStatePath, targetStatePath);
}

function resolveSkillsDir(configuredDir: string): string {
  const fallbackDir = fallbackSkillsDir;
  const targetDir = configuredDir || fallbackDir;

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    if (!samePath(targetDir, fallbackDir)) {
      syncMissingSkills(fallbackDir, targetDir);
      migrateSkillsStateIfMissing(targetDir);
    }
    ensureMultiAgentSkill(targetDir);
    return targetDir;
  } catch (err: any) {
    console.warn(`[Skills] Failed to prepare configured skills directory "${targetDir}": ${err.message}`);
    fs.mkdirSync(fallbackDir, { recursive: true });
    ensureMultiAgentSkill(fallbackDir);
    return fallbackDir;
  }
}

const skillsDir = resolveSkillsDir(configuredSkillsDir);
const skillsManager = new SkillsManager(skillsDir, '');
console.log(`[Skills] Directory: ${skillsDir}`);

function isOrchestrationSkillEnabled(): boolean {
  return skillsManager.get('multi-agent-orchestrator')?.enabled === true;
}

function recoverSkillsIfEmpty(): void {
  // Refresh from disk first (handles files added while server is running).
  skillsManager.scanSkills();
  if (skillsManager.getAll().length > 0) return;
  if (samePath(skillsDir, fallbackSkillsDir)) return;

  try {
    syncMissingSkills(fallbackSkillsDir, skillsDir);
    migrateSkillsStateIfMissing(skillsDir);
    ensureMultiAgentSkill(skillsDir);
    skillsManager.scanSkills();
  } catch (err: any) {
    console.warn(`[Skills] Recovery failed: ${err.message}`);
  }
}

// Ensure skills are available for prompt injection from the first turn.
recoverSkillsIfEmpty();

function setOrchestrationEnabled(enabled: boolean): void {
  const raw = getConfig().getConfig() as any;
  const current = raw.orchestration || {};
  // Use the single-source-of-truth clamp utility from multi-agent.ts so bounds
  // can never silently diverge from getOrchestrationConfig() or getOrchestrationConfigForApi().
  const clamped = clampOrchestrationConfig(current);
  const preempt = clampPreemptConfig(current.preempt || {});
  const merged = {
    enabled,
    secondary: {
      provider: String(current.secondary?.provider || '').trim(),
      model: String(current.secondary?.model || '').trim(),
    },
    ...clamped,
    preempt,
  };
  getConfig().updateConfig({ orchestration: merged } as any);
}

// Keep config flag aligned with persisted skill state on startup.
(() => {
  const orchestratorSkill = skillsManager.get('multi-agent-orchestrator');
  if (!orchestratorSkill) return;
  const configEnabled = (getConfig().getConfig() as any).orchestration?.enabled === true;
  if (configEnabled !== orchestratorSkill.enabled) {
    setOrchestrationEnabled(orchestratorSkill.enabled);
  }
})();

// ─── Model-Busy Guard ──────────────────────────────────────────────────────────
// Prevents cron scheduler from firing while user chat is in-flight.
// Critical for 4B models — can't handle parallel inference.

let isModelBusy = false;
let lastMainSessionId = 'default';

// ─── WebSocket Broadcast ───────────────────────────────────────────────────────
// wss is assigned after server creation below; broadcastWS is only ever called
// after startup (by cron ticks), so the late assignment is safe.

let wss: WebSocketServer | undefined;

function broadcastWS(data: object): void {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) { // OPEN
      try { client.send(msg); } catch {}
    }
  });
}

// ─── CronScheduler Init ────────────────────────────────────────────────────────

const cronStorePath = path.join(process.cwd(), '.localclaw', 'cron', 'jobs.json');
const cronScheduler = new CronScheduler({
  storePath: cronStorePath,
  handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode) =>
    handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode),
  broadcast: broadcastWS,
  getIsModelBusy: () => isModelBusy,
  deliverTelegram: (text: string) => telegramChannel.sendToAllowed(text),
  getMainSessionId: () => lastMainSessionId || 'default',
  injectSystemEvent: (sessionId, text, job) => {
    addMessage(sessionId, {
      role: 'assistant',
      content: `[System Event: ${job.name}]\n${text}`,
      timestamp: Date.now(),
    });
    broadcastWS({
      type: 'system_event',
      sessionId,
      source: 'cron',
      jobId: job.id,
      jobName: job.name,
      text,
    });
  },
});

// ─── Telegram Channel Init ─────────────────────────────────────────────────────────

const telegramChannel = new TelegramChannel(
  {
    enabled: config.telegram?.enabled || false,
    botToken: config.telegram?.botToken || '',
    allowedUserIds: config.telegram?.allowedUserIds || [],
    streamMode: config.telegram?.streamMode || 'full',
  },
  {
    handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode) =>
      handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode),
    addMessage,
    getIsModelBusy: () => isModelBusy,
    broadcast: broadcastWS,
  }
);

const heartbeatRunner = new HeartbeatRunner({
  workspacePath: getConfig().getWorkspacePath(),
  configPath: path.join(process.cwd(), '.localclaw', 'heartbeat', 'config.json'),
  handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode) =>
    handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode),
  getMainSessionId: () => lastMainSessionId || 'default',
  getIsModelBusy: () => isModelBusy,
  broadcast: broadcastWS,
  deliverTelegram: (text: string) => telegramChannel.sendToAllowed(text),
});

// --- Hook: gateway:startup -> run BOOT.md ------------------------------------
function buildBootStartupSnapshot(workspacePath: string): string {
  const lines: string[] = [];
  lines.push(`workspace_path: ${workspacePath}`);

  try {
    const blocked = listTasks({ status: ['paused', 'stalled', 'needs_assistance'] }).slice(0, 12);
    if (blocked.length === 0) {
      lines.push('blocked_tasks: none');
    } else {
      lines.push('blocked_tasks:');
      for (const t of blocked) {
        const total = Math.max(1, Number(t.plan?.length || 0));
        const step = Math.min(total, Math.max(1, Number(t.currentStepIndex || 0) + 1));
        lines.push(`- [${t.status}] ${t.title} (step ${step}/${total})`);
      }
    }
  } catch (err: any) {
    lines.push(`blocked_tasks: unavailable (${String(err?.message || err || 'unknown')})`);
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterdayDate = new Date(now.getTime() - (24 * 60 * 60 * 1000));
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  const memDir = path.join(workspacePath, 'memory');
  const todayMem = path.join(memDir, `${today}.md`);
  const yesterdayMem = path.join(memDir, `${yesterday}.md`);
  lines.push(`today_memory_file: ${fs.existsSync(todayMem) ? `${today}.md` : 'missing'}`);
  lines.push(`yesterday_memory_file: ${fs.existsSync(yesterdayMem) ? `${yesterday}.md` : 'missing'}`);

  try {
    const dirents = fs.readdirSync(workspacePath, { withFileTypes: true });
    const topFiles = dirents.filter(d => d.isFile()).map(d => d.name);
    const tmpFiles = topFiles.filter((f) => /_tmp(\.|$)/i.test(f)).slice(0, 20);
    lines.push(`tmp_files: ${tmpFiles.length ? tmpFiles.join(', ') : 'none'}`);

    const todoHead: string[] = [];
    for (const file of topFiles.slice(0, 200)) {
      try {
        const head = fs.readFileSync(path.join(workspacePath, file), 'utf-8')
          .split('\n')
          .slice(0, 5)
          .join('\n');
        if (/\bTODO\b/i.test(head)) {
          todoHead.push(file);
          if (todoHead.length >= 20) break;
        }
      } catch {
        // skip unreadable files
      }
    }
    lines.push(`todo_in_first_5_lines: ${todoHead.length ? todoHead.join(', ') : 'none'}`);
  } catch (err: any) {
    lines.push(`workspace_scan: unavailable (${String(err?.message || err || 'unknown')})`);
  }

  return lines.join('\n');
}

hookBus.register('gateway:startup', async ({ workspacePath }) => {
  const bootSessionId = 'boot-startup';
  setWorkspace(bootSessionId, workspacePath);
  clearHistory(bootSessionId);
  const startupSnapshot = buildBootStartupSnapshot(workspacePath);
  await runBootMd(workspacePath, async (message, sessionId, sendSSE) => {
    const bootContext = [
      'CONTEXT: Internal startup BOOT.md turn. Execute tools to inspect workspace before summarizing.',
      'BOOT TOOL RESTRICTION: use only list_files and read_file. Do not use run_command/start_task/browser_*/desktop_*.',
      '[BOOT STARTUP SNAPSHOT - trusted runtime data]',
      startupSnapshot,
      'Use this snapshot as source of truth for task status. Use tools for file inspection.',
      '[/BOOT STARTUP SNAPSHOT]',
    ].join('\n\n');
    const effectiveSessionId = sessionId || bootSessionId;
    setWorkspace(effectiveSessionId, workspacePath);
    const result = await handleChat(message, effectiveSessionId, sendSSE, undefined, undefined, bootContext);
    return { text: result.text };
  });
});

// --- Hook: command:new -> snapshot session before reset -----------------------
hookBus.register('command:new', async ({ sessionId, workspacePath }) => {
  const history = getHistory(sessionId, 10);
  if (history.length === 0) return;

  const memDir = path.join(workspacePath, 'memory');
  fs.mkdirSync(memDir, { recursive: true });

  const stamp = new Date().toISOString().replace('T', '_').slice(0, 16).replace(':', '-');
  const slug = String(sessionId || '').slice(0, 8) || 'default';
  const outPath = path.join(memDir, `${stamp}-${slug}.md`);
  const lines = history.map((m) => `**${m.role}**: ${String(m.content || '').slice(0, 300)}`);
  fs.writeFileSync(outPath, `# Session snapshot - ${stamp}\n\n${lines.join('\n\n')}\n`, 'utf-8');
  console.log(`[hooks:command:new] Saved session snapshot -> ${path.basename(outPath)}`);
});

// ─── Workspace Memory Loader ───────────────────────────────────────────────────

function loadWorkspaceFile(workspacePath: string, filename: string, maxChars: number = 500): string {
  try {
    const filePath = path.join(workspacePath, filename);
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + '\n...(truncated)';
  } catch { return ''; }
}

function readDailyMemoryContext(workspacePath: string, maxTokens: number = 800): string {
  try {
    const memDir = path.join(workspacePath, 'memory');
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const sections: string[] = [];

    for (const day of [yesterday, today]) {
      const p = path.join(memDir, `${day}.md`);
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf-8').trim();
      if (!raw) continue;
      sections.push(`### Memory: ${day}\n${raw}`);
    }

    if (!sections.length) return '';

    let combined = sections.join('\n\n');
    const charLimit = Math.floor(maxTokens * 3.5);
    if (combined.length > charLimit) {
      combined = combined.slice(-charLimit);
    }
    return `\n\n## Recent Memory Notes\n${combined}`;
  } catch {
    return '';
  }
}

async function buildPersonalityContext(sessionId: string, workspacePath: string): Promise<string> {
  const identity = loadWorkspaceFile(workspacePath, 'IDENTITY.md', 200);
  const dailyMemory = readDailyMemoryContext(workspacePath, 800);
  const soul = loadWorkspaceFile(workspacePath, 'SOUL.md', 500);
  const user = loadWorkspaceFile(workspacePath, 'USER.md', 300);
  const memory = loadWorkspaceFile(workspacePath, 'MEMORY.md', 600);

  const bootstrapFiles = [
    { path: path.join(workspacePath, 'IDENTITY.md'), content: identity, label: 'IDENTITY' },
    { path: path.join(workspacePath, 'memory', '_recent.md'), content: dailyMemory.trim(), label: 'RECENT_MEMORY' },
    { path: path.join(workspacePath, 'SOUL.md'), content: soul, label: 'SOUL' },
    { path: path.join(workspacePath, 'USER.md'), content: user, label: 'USER' },
    { path: path.join(workspacePath, 'MEMORY.md'), content: memory, label: 'MEMORY' },
  ];

  await hookBus.fire({
    type: 'agent:bootstrap',
    sessionId,
    workspacePath,
    bootstrapFiles,
    timestamp: Date.now(),
  });

  const parts: string[] = [];
  for (const file of bootstrapFiles) {
    const content = String(file?.content || '').trim();
    if (!content) continue;
    const label = String(file?.label || '').trim().toUpperCase() || 'BOOTSTRAP';
    parts.push(`[${label}]\n${content}`);
  }

  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}

// ─── Session Logger ────────────────────────────────────────────────────────────

function logToDaily(workspacePath: string, role: string, content: string) {
  try {
    const memDir = path.join(workspacePath, 'memory');
    if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const logPath = path.join(memDir, `${today}.md`);
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = `[${timestamp}] **${role}**: ${content.slice(0, 300)}\n`;

    fs.appendFileSync(logPath, entry);
  } catch {}
}

// ─── Tool Definitions ──────────────────────────────────────────────────────────

function buildTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List all files in the workspace directory.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file and return its content WITH line numbers. Always use this before editing a file.',
        parameters: {
          type: 'object', required: ['filename'],
          properties: { filename: { type: 'string', description: 'Name of the file to read' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_file',
        description: 'Create a NEW file with content. Only use for files that do NOT exist yet.',
        parameters: {
          type: 'object', required: ['filename', 'content'],
          properties: {
            filename: { type: 'string', description: 'Name of the new file' },
            content: { type: 'string', description: 'Content for the new file' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_lines',
        description: 'Replace specific lines in an existing file. Use read_file first to see line numbers.',
        parameters: {
          type: 'object', required: ['filename', 'start_line', 'end_line', 'new_content'],
          properties: {
            filename: { type: 'string' },
            start_line: { type: 'number', description: 'First line to replace (1-based)' },
            end_line: { type: 'number', description: 'Last line to replace (1-based, inclusive)' },
            new_content: { type: 'string', description: 'New content to insert' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'insert_after',
        description: 'Insert new lines after a specific line number. Use 0 to insert at beginning.',
        parameters: {
          type: 'object', required: ['filename', 'after_line', 'content'],
          properties: {
            filename: { type: 'string' },
            after_line: { type: 'number', description: 'Line number to insert after (0 = beginning)' },
            content: { type: 'string', description: 'Content to insert' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_lines',
        description: 'Delete specific lines from a file.',
        parameters: {
          type: 'object', required: ['filename', 'start_line', 'end_line'],
          properties: {
            filename: { type: 'string' },
            start_line: { type: 'number', description: 'First line to delete (1-based)' },
            end_line: { type: 'number', description: 'Last line to delete (1-based, inclusive)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_replace',
        description: 'Find exact text in a file and replace it. Good for small text changes.',
        parameters: {
          type: 'object', required: ['filename', 'find', 'replace'],
          properties: {
            filename: { type: 'string' },
            find: { type: 'string', description: 'Exact text to find' },
            replace: { type: 'string', description: 'Text to replace with' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Delete a file from the workspace.',
        parameters: {
          type: 'object', required: ['filename'],
          properties: { filename: { type: 'string' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for current information. Use web_fetch on result URLs to read full page content.',
        parameters: {
          type: 'object', required: ['query'],
          properties: { query: { type: 'string', description: 'Search query' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch the full text content of a webpage URL. Use this AFTER web_search to read the actual page content instead of just snippets. Essential for getting real data, details, and context.',
        parameters: {
          type: 'object', required: ['url'],
          properties: { url: { type: 'string', description: 'Full URL to fetch (from web_search results or any URL)' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Open apps for the USER to see. Use browser_* tools for webpage interaction and desktop_* tools for desktop app interaction.',
        parameters: {
          type: 'object', required: ['command'],
          properties: {
            command: { type: 'string', description: 'Examples: "chrome", "chrome youtube.com", "youtube.com", "notepad", "code D:\\project"' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'start_task',
        description: 'Start a multi-step task that requires many actions (like browser automation, complex file operations). The task will run with a sliding context window so it can handle 20+ steps.',
        parameters: {
          type: 'object', required: ['goal'],
          properties: {
            goal: { type: 'string', description: 'What the task should accomplish (be specific)' },
            max_steps: { type: 'number', description: 'Maximum steps (default 25)' },
          },
        },
      },
    },
    // Browser automation tools
    ...getBrowserToolDefinitions(),
    ...getDesktopToolDefinitions(),
    // Orchestration tool — only exposed when orchestration is enabled
    ...(() => {
      const oc = getOrchestrationConfig();
      if (!oc?.enabled || !isOrchestrationSkillEnabled()) return [];
      return [{
        type: 'function' as const,
        function: {
          name: 'request_secondary_assist',
          description: 'Request guidance from the secondary AI advisor when you are stuck, need a plan, or have failed multiple times. The advisor returns a structured action plan. Use proactively for complex tasks.',
          parameters: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: { type: 'string', description: 'Why you need help: planning, stuck, repeated failures, risky edit, etc.' },
              mode:   { type: 'string', enum: ['planner', 'rescue'], description: 'planner = need upfront strategy; rescue = stuck or failing' },
            },
          },
        },
      }];
    })(),
  ];
}

// ─── Search Providers ─────────────────────────────────────────────────────────

async function tavilySearch(query: string, apiKey: string): Promise<string> {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: 5, search_depth: 'basic' }),
    });
    if (!response.ok) {
      const err = await response.text();
      return `Tavily search failed (${response.status}): ${err.slice(0, 200)}`;
    }
    const data = await response.json() as any;
    const results = (data.results || []).slice(0, 5).map((r: any, i: number) =>
      `[${i + 1}] ${r.title || 'No title'}\n${r.content?.slice(0, 200) || r.snippet || ''}\nURL: ${r.url || ''}`
    );
    if (!results.length) return `No results found for "${query}".`;
    let output = results.join('\n\n');
    const topUrl = (data.results || [])[0]?.url;
    if (topUrl) {
      console.log(`[v2] TAVILY AUTO-FETCH: ${topUrl.slice(0, 80)}`);
      const pageContent = await webFetch(topUrl);
      if (!pageContent.startsWith('Fetch failed') && !pageContent.startsWith('Fetch error') && !pageContent.startsWith('Fetch timed') && !pageContent.startsWith('Page fetched but very little')) {
        output += '\n\n─── TOP RESULT FULL CONTENT ───\n' + pageContent;
      }
    }
    output += '\n\nOther URLs above can be read with web_fetch if needed.';
    return output;
  } catch (err: any) {
    return `Tavily search error: ${err.message}`;
  }
}

async function googleSearch(query: string): Promise<string> {
  const searchCfg = (getConfig().getConfig() as any).search || {};
  const GOOGLE_API_KEY = (searchCfg.google_api_key || '').trim();
  const GOOGLE_CX = (searchCfg.google_cx || '').trim();
  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    return 'Google search not configured. Add google_api_key and google_cx in Settings → Search.';
  }

  try {
    const encoded = encodeURIComponent(query);
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encoded}&num=5`;
    const response = await fetch(url);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[v2] Google Search error: ${response.status} ${errText.slice(0, 200)}`);
      return `Search failed (${response.status}). Try again later.`;
    }

    const data = await response.json() as any;
    const items = data.items || [];

    if (items.length === 0) {
      return `No results found for "${query}".`;
    }

    const results = items.slice(0, 5).map((item: any, i: number) => {
      const title = item.title || 'No title';
      const snippet = item.snippet || 'No description';
      const link = item.link || '';
      return `[${i + 1}] ${title}\n${snippet}\nURL: ${link}`;
    });

    let output = results.join('\n\n');

    const topUrl = items[0]?.link;
    if (topUrl) {
      console.log(`[v2] AUTO-FETCH: Fetching top result: ${topUrl.slice(0, 80)}`);
      const pageContent = await webFetch(topUrl);
      if (!pageContent.startsWith('Fetch failed') && !pageContent.startsWith('Fetch error') && !pageContent.startsWith('Fetch timed') && !pageContent.startsWith('Page fetched but very little')) {
        output += '\n\n─── TOP RESULT FULL CONTENT ───\n' + pageContent;
      }
    }

    output += '\n\nOther URLs above can be read with web_fetch if needed.';
    return output;
  } catch (err: any) {
    console.error(`[v2] Google Search error:`, err.message);
    return `Search error: ${err.message}`;
  }
}

async function duckDuckGoSearch(query: string): Promise<string> {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
    const html = await webFetch(url);
    return html.startsWith('Content from') ? html : `No DDG results for "${query}".`;
  } catch (err: any) {
    return `DuckDuckGo search error: ${err.message}`;
  }
}

// Unified search router — picks provider based on config
async function webSearch(query: string): Promise<string> {
  const searchCfg = (getConfig().getConfig() as any).search || {};
  const provider = searchCfg.preferred_provider || 'google';
  const tavilyKey = searchCfg.tavily_api_key || '';
  console.log(`[v2] webSearch via ${provider}: ${query.slice(0, 80)}`);

  if (provider === 'tavily' && tavilyKey) {
    return tavilySearch(query, tavilyKey);
  }
  if (provider === 'google') {
    return googleSearch(query);
  }
  if (provider === 'ddg' || provider === 'duckduckgo') {
    return duckDuckGoSearch(query);
  }
  // Fallback: try tavily if key exists, then google, then ddg
  if (tavilyKey) return tavilySearch(query, tavilyKey);
  const googleResult = await googleSearch(query);
  if (!googleResult.includes('not configured')) return googleResult;
  return duckDuckGoSearch(query);
}

// ─── Web Fetch (full page content) ─────────────────────────────────────────────

async function webFetch(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return `Fetch failed (${response.status} ${response.statusText})`;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/json')) {
      return `Non-text content type: ${contentType}. Cannot extract text.`;
    }

    const html = await response.text();

    // Strip HTML to plain text — remove scripts, styles, tags, then clean whitespace
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    // Truncate to fit in context — ~3000 chars is plenty for a 4B model
    const maxChars = 3000;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n\n...(truncated — page had ' + text.length + ' chars total)';
    }

    if (text.length < 50) {
      return `Page fetched but very little text content extracted. The page may be JavaScript-heavy (SPA). Try using browser_open instead.`;
    }

    return `Content from ${url}:\n\n${text}`;
  } catch (err: any) {
    if (err.name === 'AbortError') return 'Fetch timed out after 15s.';
    return `Fetch error: ${err.message}`;
  }
}

// ─── Tool Execution ────────────────────────────────────────────────────────────

interface ToolResult {
  name: string;
  args: any;
  result: string;
  error: boolean;
}

function normalizeToolArgs(rawArgs: any): any {
  if (rawArgs == null) return {};
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof rawArgs === 'object') return rawArgs;
  return {};
}

async function executeTool(name: string, args: any, workspacePath: string, sessionId: string = 'default'): Promise<ToolResult> {
  // Filename inference: if the model forgot to pass filename, use the last one
  const needsFilename = ['read_file', 'create_file', 'replace_lines', 'insert_after', 'delete_lines', 'find_replace', 'delete_file'];
  if (needsFilename.includes(name)) {
    // Normalize: secondary AI sometimes returns "path" or "file" instead of "filename"
    if (!args.filename && !args.name) {
      if (args.path) { args.filename = args.path; }
      else if (args.file) { args.filename = args.file; }
    }
    const fn = args.filename || args.name;
    if (fn) {
      lastFilenameUsed.set(sessionId, fn);
    } else if (lastFilenameUsed.has(sessionId)) {
      args.filename = lastFilenameUsed.get(sessionId);
      console.log(`[v2] AUTO-FIX: Injected missing filename "${args.filename}" for ${name}`);
    }
  }

  try {
    switch (name) {
      case 'list_files': {
        const files = fs.readdirSync(workspacePath).filter(f => {
          try { return fs.statSync(path.join(workspacePath, f)).isFile(); } catch { return false; }
        });
        return { name, args, result: JSON.stringify(files), error: false };
      }

      case 'read_file': {
        const filename = args.filename || args.name;
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(filePath)) return { name, args, result: `File "${filename}" not found`, error: true };
        const content = fs.readFileSync(filePath, 'utf-8');
        const numbered = content.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
        return { name, args, result: `${filename} (${content.split('\n').length} lines):\n${numbered}`, error: false };
      }

      case 'create_file': {
        const filename = args.filename || args.name;
        const filePath = path.join(workspacePath, filename);
        if (fs.existsSync(filePath)) return { name, args, result: `"${filename}" already exists. Use replace_lines or insert_after to edit.`, error: true };
        fs.writeFileSync(filePath, args.content || '', 'utf-8');
        return { name, args, result: `${filename} created`, error: false };
      }

      case 'replace_lines': {
        const filename = args.filename || args.name;
        const startLine = Math.max(1, Math.floor(Number(args.start_line) || 1));
        const endLine = Math.max(startLine, Math.floor(Number(args.end_line) || startLine));
        const newContent = args.new_content || '';
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        if (startLine > lines.length) return { name, args, result: `Line ${startLine} past end (${lines.length} lines)`, error: true };
        const end = Math.min(endLine, lines.length);
        lines.splice(startLine - 1, end - startLine + 1, ...newContent.split('\n'));
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { name, args, result: `${filename}: replaced lines ${startLine}-${end} (now ${lines.length} lines)`, error: false };
      }

      case 'insert_after': {
        const filename = args.filename || args.name;
        const afterLine = Math.max(0, Math.floor(Number(args.after_line) || 0));
        const content = String(args.content || '').replace(/\\n/g, '\n');
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const insertAt = Math.min(afterLine, lines.length);
        lines.splice(insertAt, 0, ...content.split('\n'));
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { name, args, result: `${filename}: inserted after line ${afterLine} (now ${lines.length} lines)`, error: false };
      }

      case 'delete_lines': {
        const filename = args.filename || args.name;
        const startLine = Math.max(1, Math.floor(Number(args.start_line) || 1));
        const endLine = Math.max(startLine, Math.floor(Number(args.end_line) || startLine));
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const end = Math.min(endLine, lines.length);
        lines.splice(startLine - 1, end - startLine + 1);
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { name, args, result: `${filename}: deleted lines ${startLine}-${end} (now ${lines.length} lines)`, error: false };
      }

      case 'find_replace': {
        const filename = args.filename || args.name;
        const find = args.find || '';
        const replace = args.replace ?? '';
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.includes(find)) return { name, args, result: `Text not found. Use read_file to check exact content.`, error: true };
        fs.writeFileSync(filePath, content.replace(find, replace), 'utf-8');
        return { name, args, result: `${filename} updated`, error: false };
      }

      case 'delete_file': {
        const filename = args.filename || args.name;
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        fs.unlinkSync(filePath);
        return { name, args, result: `${filename} deleted`, error: false };
      }

      case 'web_search': {
        const result = await webSearch(args.query || '');
        return { name, args, result, error: false };
      }

      case 'web_fetch': {
        const result = await webFetch(args.url || '');
        return { name, args, result, error: result.startsWith('Fetch failed') || result.startsWith('Fetch error') || result.startsWith('Fetch timed') };
      }

      case 'run_command': {
        const rawCmd = (args.command || '').trim();
        const cmd = rawCmd.toLowerCase();
        // Check blocked patterns
        for (const blocked of BLOCKED_PATTERNS) {
          if (cmd.includes(blocked.toLowerCase())) {
            return { name, args, result: `Blocked: "${cmd}" contains unsafe pattern "${blocked}"`, error: true };
          }
        }

        let execCmd = '';

        // 1. Check allowlist (exact match)
        if (SAFE_COMMANDS[cmd]) {
          execCmd = SAFE_COMMANDS[cmd];
        }
        // 2. "chrome <url>" or "browser <url>" → open browser with URL
        else if (/^(chrome|browser|firefox|edge)\s+/.test(cmd)) {
          const parts = rawCmd.split(/\s+/);
          const app = parts[0].toLowerCase();
          let url = parts.slice(1).join(' ');
          // Add https:// if missing
          if (url && !url.startsWith('http')) url = 'https://' + url;
          execCmd = buildBrowserLaunchCommand(app, url);
        }
        // 3. Plain URL → open in default browser
        else if (/^(https?:\/\/|www\.)/.test(cmd)) {
          const url = cmd.startsWith('www.') ? 'https://' + rawCmd : rawCmd;
          execCmd = buildUrlOpenCommand(url);
        }
        // 4. Bare domain like "youtube.com" → open in browser
        else if (/^[a-z0-9-]+\.[a-z]{2,}/.test(cmd) && !cmd.includes(' ')) {
          execCmd = buildUrlOpenCommand(`https://${rawCmd}`);
        }
        // 5. "code <path>" → VS Code
        else if (cmd.startsWith('code ')) {
          execCmd = rawCmd;
        }
        // 6. Windows-only: "start <url>" → pass through
        else if (isWindows && (cmd.startsWith('start http') || cmd.startsWith('start https'))) {
          execCmd = rawCmd;
        }
        // 7. Windows-only: "explorer <path>"
        else if (isWindows && cmd.startsWith('explorer ')) {
          execCmd = rawCmd;
        }

        if (!execCmd) {
          return {
            name,
            args,
            result: `Command "${rawCmd}" not recognized. Try: chrome, chrome youtube.com, notepad, code <path>, or a URL`,
            error: true,
          };
        }
        try {
          const { exec } = await import('child_process');
          exec(execCmd);
          return { name, args, result: `Executed: ${execCmd}`, error: false };
        } catch (err: any) {
          return { name, args, result: `Failed: ${err.message}`, error: true };
        }
      }

      case 'start_task': {
        // This is handled specially in handleChat — shouldn't reach here
        return { name, args, result: 'Task system ready. Use the task endpoint.', error: false };
      }

      // Browser automation tools
      case 'browser_open': {
        const result = await browserOpen(sessionId, args.url || '');
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_snapshot': {
        const result = await browserSnapshot(sessionId);
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_click': {
        const result = await browserClick(sessionId, Number(args.ref || 0));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_fill': {
        const result = await browserFill(sessionId, Number(args.ref || 0), String(args.text || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_press_key': {
        const result = await browserPressKey(sessionId, String(args.key || 'Enter'));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_wait': {
        const result = await browserWait(sessionId, Number(args.ms || 2000));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_scroll': {
        const dir = String(args.direction || 'down').toLowerCase() === 'up' ? 'up' : 'down';
        const result = await browserScroll(sessionId, dir, Number(args.multiplier || 1));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_close': {
        const result = await browserClose(sessionId);
        return { name, args, result, error: false };
      }

      // Desktop automation tools
      case 'desktop_screenshot': {
        const result = await desktopScreenshot(sessionId);
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_find_window': {
        const result = await desktopFindWindow(String(args.name || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_focus_window': {
        const result = await desktopFocusWindow(String(args.name || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_click': {
        const result = await desktopClick(
          Number(args.x),
          Number(args.y),
          String(args.button || 'left').toLowerCase() === 'right' ? 'right' : 'left',
          args.double_click === true,
        );
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_drag': {
        const result = await desktopDrag(
          Number(args.from_x),
          Number(args.from_y),
          Number(args.to_x),
          Number(args.to_y),
          Number(args.steps || 20),
        );
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_wait': {
        const result = await desktopWait(Number(args.ms || 500));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_type': {
        const result = await desktopType(String(args.text || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_press_key': {
        const result = await desktopPressKey(String(args.key || 'Enter'));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_get_clipboard': {
        const result = await desktopGetClipboard();
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_set_clipboard': {
        const result = await desktopSetClipboard(String(args.text || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }

      default:
        return { name, args, result: `Unknown tool: ${name}`, error: true };
    }
  } catch (err: any) {
    return { name, args, result: `Error: ${err.message}`, error: true };
  }
}

// ─── Audit Logger ──────────────────────────────────────────────────────────────

function logToolCall(workspacePath: string, toolName: string, args: any, result: string, error: boolean) {
  try {
    const logPath = path.join(workspacePath, 'tool_audit.log');
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${error ? 'FAIL' : 'OK'} ${toolName}(${JSON.stringify(args).slice(0, 200)}) => ${result.slice(0, 200)}\n`);
  } catch {}
}

// ─── Thinking Stripper ─────────────────────────────────────────────────────────

function separateThinkingFromContent(text: string): { reply: string; thinking: string } {
  if (!text) return { reply: '', thinking: '' };

  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\/think>/gi, '')
    .trim();

  if (!cleaned) return { reply: '', thinking: text };

  // Fast-path: if the entire output looks like pure reasoning (starts with common
  // reasoning starters and is very long), treat the whole thing as thinking
  if (cleaned.length > 500 && /^(Okay|Ok,|Let me|First|Hmm|Wait|The user|I need|I should|So,)/i.test(cleaned)) {
    // Try to find the last sentence that looks like a real reply
    const sentences = cleaned.split(/(?<=[.!?])\s+/);
    let lastUseful: string | undefined;
    for (let i = sentences.length - 1; i >= 0; i--) {
      const s = sentences[i];
      if (s.length > 10 && s.length < 200 && !/\b(the user|I need to|I should|let me|wait,|hmm|the rules|the tools|the instructions)\b/i.test(s)) {
        lastUseful = s;
        break;
      }
    }
    if (lastUseful) {
      return { reply: lastUseful.trim(), thinking: cleaned };
    }
    return { reply: '', thinking: cleaned };
  }

  const paragraphs = cleaned.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const reasoningRE = /\b(the user|the tools|the instructions|I need to|I should|let me|the problem|the question|the answer|looking at|first,|second,|wait,|hmm|the response|the correct|the assistant|check the rules|according to|the file|the current|the plan)\b/i;
  const starterRE = /^(Okay|Ok|Alright|Let me|First|Hmm|So,? |Wait|The user|Looking|I need|I should|Now,? |Since|Given|Based on|Check)/i;

  let lastIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    if (reasoningRE.test(paragraphs[i]) || starterRE.test(paragraphs[i])) lastIdx = i;
  }

  if (lastIdx === -1) return { reply: cleaned, thinking: '' };
  if (lastIdx >= paragraphs.length - 1) {
    const last = paragraphs[paragraphs.length - 1];
    const sentences = last.split(/(?<=[.!?])\s+/);
    for (let i = sentences.length - 1; i >= 0; i--) {
      if (!reasoningRE.test(sentences[i]) && sentences[i].length < 200) {
        return {
          reply: sentences.slice(i).join(' ').trim(),
          thinking: [...paragraphs.slice(0, -1), sentences.slice(0, i).join(' ')].join('\n\n').trim(),
        };
      }
    }
    return { reply: cleaned, thinking: '' };
  }

  const reply = paragraphs.slice(lastIdx + 1).join('\n\n');
  const replyChars = reply.replace(/\s/g, '').length;
  if (replyChars < 10 && cleaned.length > reply.length) {
    return { reply: cleaned, thinking: '' };
  }

  return {
    thinking: paragraphs.slice(0, lastIdx + 1).join('\n\n'),
    reply,
  };
}

function normalizeForDedup(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function isGreetingLikeMessage(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 120) return false;
  if (/\b(search|open|read|write|file|code|task|build|fix|debug|run|install|http|www\.|\.com|please|could you|can you)\b/i.test(raw)) {
    return false;
  }
  return /^(hi|hello|hey|yo|sup|howdy|good (morning|afternoon|evening)|hey claw|hello claw|hi claw|hey smallclaw|hello smallclaw|hi smallclaw|how are you)[!.?\s]*$/i.test(raw);
}

function sanitizeFinalReply(
  text: string,
  opts: { preflightReason?: string } = {},
): string {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';

  const metaPatterns: RegExp[] = [
    /^\s*No tools (are|were) needed for (this|the) greeting\.?\s*$/i,
    /^\s*Greeting only,\s*no tools needed\.?\s*$/i,
    /^\s*Advisor route selected .*$/i,
    /^\s*\[ADVISOR[^\]]*\]\s*$/i,
    /^\s*\[\/ADVISOR[^\]]*\]\s*$/i,
    /^\s*Understood\.?\s*I will execute this objective.*$/i,
  ];

  const reasonNorm = normalizeForDedup(opts.preflightReason || '');
  const parts = raw
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .filter((p) => {
      if (metaPatterns.some(re => re.test(p))) return false;
      if (reasonNorm && normalizeForDedup(p) === reasonNorm) return false;
      return true;
    });

  const deduped: string[] = [];
  let prevNorm = '';
  for (const p of parts) {
    const norm = normalizeForDedup(p);
    if (!norm) continue;
    if (norm === prevNorm) continue;
    deduped.push(p);
    prevNorm = norm;
  }

  return deduped.join('\n\n').trim();
}

function stripExplicitThinkTags(text: string): { cleaned: string; thinking: string } {
  const raw = String(text || '');
  if (!raw) return { cleaned: '', thinking: '' };

  const blocks: string[] = [];
  let cleaned = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
    const t = String(inner || '').trim();
    if (t) blocks.push(t);
    return '';
  });

  // Handle dangling open <think> blocks from partial model outputs.
  const openIdx = cleaned.toLowerCase().lastIndexOf('<think>');
  if (openIdx !== -1) {
    const trailing = cleaned
      .slice(openIdx + '<think>'.length)
      .replace(/<\/think>/gi, '')
      .trim();
    if (trailing) blocks.push(trailing);
    cleaned = cleaned.slice(0, openIdx);
  }

  cleaned = cleaned.replace(/<\/think>/gi, '').trim();
  return { cleaned, thinking: blocks.join('\n\n').trim() };
}

// ─── Main Chat Handler ─────────────────────────────────────────────────────────

function isExecutionLikeRequest(message: string): boolean {
  const m = String(message || '');
  return /\b(create|build|implement|develop|scaffold|generate|fix|debug|edit|update|refactor|rewrite|patch|setup|configure|calendar|app|component|project|file|folder|directory|workspace|code|desktop|window|screen|mouse|keyboard|clipboard|vs code|vscode)\b/i.test(m);
}

function isBrowserAutomationRequest(message: string): boolean {
  const m = String(message || '');
  const hasBrowserVerb = /\b(open|go to|navigate|visit|browse|click|type|fill|press|submit|log ?in|login|use my computer)\b/i.test(m);
  const hasTarget = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/i.test(m)
    || /\b(chatgpt|google|reddit|x\.com|twitter|github|youtube)\b/i.test(m);
  return hasBrowserVerb && hasTarget;
}

function isDesktopAutomationRequest(message: string): boolean {
  const m = String(message || '');
  const hasDesktopVerb = /\b(check|look|see|open|focus|click|type|press|read|copy|paste|use my computer|screenshot)\b/i.test(m);
  const hasDesktopTarget = /\b(desktop|screen|window|app|application|vs code|vscode|terminal|notepad|clipboard|codex)\b/i.test(m);
  const statusAsk = /\b(is|did|has).*\b(done|finished|complete|completed)\b/i.test(m);
  return (hasDesktopVerb && hasDesktopTarget) || (statusAsk && /\b(vs code|vscode|codex)\b/i.test(m));
}

function extractLikelyUrl(message: string): string | null {
  const raw = String(message || '');
  const directUrlMatch = raw.match(/\bhttps?:\/\/[^\s)]+/i);
  const domainMatch = raw.match(/\b(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s)]*)?/i);
  const url = (directUrlMatch?.[0] || domainMatch?.[0] || '').trim();
  if (!url) return null;
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return normalized.replace(/["'<>]/g, '');
}

function looksLikeSafetyRefusal(text: string): boolean {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return false;
  return (
    /disallowed|can't (help|assist|do that|use your computer)|cannot (help|assist|do that|use your computer)|unable to (help|assist|do that)/i.test(s)
    || /i (can't|cannot) (control|operate|use) (your|the) computer/i.test(s)
    || /against (policy|safety)/i.test(s)
  );
}

function looksLikeIntentOnlyReply(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return true;

  const intentPattern = /\b(first[, ]|next[, ]|then[, ]|let me|i(?:'| a)?ll|i will|i'm going to|i can|i should|i need to|before i|to start|we should)\b/i;
  const completionPattern = /\b(done|completed|created|updated|fixed|implemented|finished|here(?:'s| is)|built|saved|wrote|ran|executed)\b/i;
  const questionPattern = /\?$/.test(s) || /\bshould i|want me to|do you want\b/i.test(s);

  if (completionPattern.test(s) || questionPattern) return false;
  return intentPattern.test(s);
}

function hasConcreteCompletion(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return false;
  return /\b(done|completed|created|updated|fixed|implemented|finished|saved|wrote|executed|here(?:'s| is) (?:the|your)|success(?:fully)?)\b/i.test(s);
}

function isBrowserToolName(name: string): boolean {
  return /^browser_(open|snapshot|click|fill|press_key|wait|scroll|close)$/i.test(String(name || ''));
}

function isDesktopToolName(name: string): boolean {
  return /^desktop_(screenshot|find_window|focus_window|click|drag|wait|type|press_key|get_clipboard|set_clipboard)$/i.test(String(name || ''));
}

function isHighStakesFile(filename: string): boolean {
  const f = String(filename || '').toLowerCase();
  return /(auth|billing|payment|security|secret|token|config|credential|oauth|permission|acl)/.test(f);
}

function requestedFullTemplate(message: string): boolean {
  return /\b(full page|full template|full config|full layout|complete page|entire file|whole file)\b/i
    .test(String(message || ''));
}

function resolveWorkspaceFilePath(workspacePath: string, filename: string): string {
  if (!filename) return '';
  if (path.isAbsolute(filename)) return filename;
  return path.join(workspacePath, filename);
}

function collectFileSnapshots(
  workspacePath: string,
  files: string[],
  maxCharsPerFile: number = 3600,
): Array<{
  filename: string;
  exists: boolean;
  content_preview: string;
  line_count: number;
  char_count: number;
}> {
  const out: Array<{
    filename: string;
    exists: boolean;
    content_preview: string;
    line_count: number;
    char_count: number;
  }> = [];
  const seen = new Set<string>();
  for (const raw of files || []) {
    const fn = String(raw || '').trim();
    if (!fn) continue;
    if (seen.has(fn.toLowerCase())) continue;
    seen.add(fn.toLowerCase());

    const fp = resolveWorkspaceFilePath(workspacePath, fn);
    if (!fp) continue;
    if (!fs.existsSync(fp)) {
      out.push({
        filename: fn,
        exists: false,
        content_preview: '',
        line_count: 0,
        char_count: 0,
      });
      continue;
    }
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      const lines = content.split('\n');
      const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
      out.push({
        filename: fn,
        exists: true,
        content_preview: numbered.slice(0, maxCharsPerFile),
        line_count: lines.length,
        char_count: content.length,
      });
    } catch {
      out.push({
        filename: fn,
        exists: true,
        content_preview: '',
        line_count: 0,
        char_count: 0,
      });
    }
    if (out.length >= 10) break;
  }
  return out;
}

// ─── Browser Tool Result Interceptor (Multi-Agent) ──────────────────────────
// When multi-agent orchestrator is active, the LLM should NEVER see raw browser
// snapshot data — only the secondary AI (via getBrowserAdvisorPacket) gets that.
// The LLM receives a short acknowledgment so it knows the tool ran, then waits
// for the advisor's directive telling it what to do next.
function buildBrowserAck(toolName: string, result: ToolResult): string {
  if (result.error) {
    // On error the LLM does need to know what failed so it can decide next step
    return `${toolName} failed: ${result.result.slice(0, 200)}`;
  }
  switch (toolName) {
    case 'browser_open':
      return 'Browser opened. Secondary AI is analyzing the page — wait for directive.';
    case 'browser_snapshot':
      return 'Snapshot captured. Secondary AI is analyzing — wait for directive.';
    case 'browser_press_key':
      return 'Key pressed. Page updating — secondary AI will instruct next step.';
    case 'browser_wait':
      return 'Wait complete.';
    case 'browser_click':
      return 'Clicked. Secondary AI is analyzing the result — wait for directive.';
    case 'browser_fill':
      return 'Input filled.';
    default:
      return `${toolName} complete.`;
  }
}

function buildDesktopAck(toolName: string, result: ToolResult): string {
  if (result.error) {
    return `${toolName} failed: ${result.result.slice(0, 200)}`;
  }
  switch (toolName) {
    case 'desktop_screenshot':
      return 'Desktop screenshot captured. Secondary AI is analyzing window context and will direct next step.';
    case 'desktop_find_window':
      return 'Window search complete.';
    case 'desktop_focus_window':
      return 'Window focused.';
    case 'desktop_click':
      return 'Desktop click executed.';
    case 'desktop_drag':
      return 'Desktop drag executed.';
    case 'desktop_wait':
      return 'Desktop wait complete.';
    case 'desktop_type':
      return 'Text input sent to focused window.';
    case 'desktop_press_key':
      return 'Key press sent.';
    case 'desktop_get_clipboard':
      return 'Clipboard read complete.';
    case 'desktop_set_clipboard':
      return 'Clipboard updated.';
    default:
      return `${toolName} complete.`;
  }
}

function isBrowserHeavyResearchPage(input: {
  url?: string;
  pageType?: string;
  snapshotElements?: number;
  feedCount?: number;
}): boolean {
  const url = String(input.url || '').toLowerCase();
  const pageType = String(input.pageType || '').toLowerCase();
  const elements = Number(input.snapshotElements || 0);
  const feedCount = Number(input.feedCount || 0);

  if (pageType === 'x_feed' || pageType === 'search_results' || pageType === 'article') return true;
  if (feedCount >= 6) return true;
  if (elements >= 10) return true;
  return /(x\.com|twitter\.com|reddit\.com|google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com|news|search\?q=)/.test(url);
}

type SnapshotDiagnostics = {
  scanned: number;
  included: number;
  hidden: number;
  unlabeledNonInput: number;
  unnamedInputIncluded: number;
};

type BrowserSnapshotQuality = {
  low: boolean;
  reasons: string[];
  elementCount: number;
  inputCandidates: number;
  dominantRoles: string[];
  diagnostics: SnapshotDiagnostics | null;
};

function goalLikelyNeedsTextInput(goal: string): boolean {
  const text = String(goal || '');
  return /\b(type|fill|enter|input|message|say|send|search|write|reply|post|submit|login|log ?in|chat|comment)\b/i.test(text);
}

function parseSnapshotDiagnostics(snapshot: string): SnapshotDiagnostics | null {
  const m = String(snapshot || '').match(
    /Snapshot diagnostics:\s*scanned=(\d+)\s+included=(\d+)\s+hidden=(\d+)\s+unlabeled_non_input=(\d+)\s+unnamed_input_included=(\d+)/i,
  );
  if (!m) return null;
  const toInt = (x: string) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  };
  return {
    scanned: toInt(m[1]),
    included: toInt(m[2]),
    hidden: toInt(m[3]),
    unlabeledNonInput: toInt(m[4]),
    unnamedInputIncluded: toInt(m[5]),
  };
}

function evaluateBrowserSnapshotQuality(snapshot: string, snapshotElements: number, goal: string): BrowserSnapshotQuality {
  const elementCount = Number.isFinite(Number(snapshotElements)) ? Math.max(0, Math.floor(Number(snapshotElements))) : 0;
  const roleCounts = new Map<string, number>();
  let inputCandidates = 0;

  for (const raw of String(snapshot || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[@\d+\]\s+([a-z0-9_-]+)/i);
    if (!m) continue;
    const role = String(m[1] || '').toLowerCase();
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    if (
      /\[INPUT\]/i.test(line)
      || role === 'textbox'
      || role === 'searchbox'
      || role === 'combobox'
      || role === 'textarea'
    ) {
      inputCandidates++;
    }
  }

  const dominantRoles = Array.from(roleCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([role, count]) => `${role}:${count}`);
  const diagnostics = parseSnapshotDiagnostics(snapshot);
  const reasons: string[] = [];
  const needsInput = goalLikelyNeedsTextInput(goal);
  if (elementCount < 10) reasons.push(`low_elements=${elementCount}`);
  if (needsInput && inputCandidates === 0) reasons.push('expected_input_but_none_detected');
  if (needsInput && inputCandidates === 0 && dominantRoles.length) {
    reasons.push(`top_roles=${dominantRoles.join(',')}`);
  }
  if (diagnostics && diagnostics.hidden > diagnostics.included) {
    reasons.push('many_hidden_candidates');
  }
  if (diagnostics && diagnostics.unlabeledNonInput > diagnostics.included) {
    reasons.push('many_unlabeled_non_input_candidates');
  }

  return {
    low: reasons.length > 0,
    reasons,
    elementCount,
    inputCandidates,
    dominantRoles,
    diagnostics,
  };
}

interface HandleChatResult {
  type: 'chat' | 'execute';
  text: string;
  thinking?: string;
  toolResults?: ToolResult[];
}

async function handleChat(
  message: string,
  sessionId: string,
  sendSSE: (event: string, data: any) => void,
  pinnedMessages?: Array<{ role: string; content: string }>,
  abortSignal?: { aborted: boolean },
  callerContext?: string,
  modelOverride?: string,
  executionMode: ExecutionMode = 'interactive'
): Promise<HandleChatResult> {
  const ollama = getOllamaClient();
  const isBootStartupTurn = /\bBOOT\.md\b/i.test(String(callerContext || ''));
  const bootAllowedTools = new Set(['list_files', 'read_file']);
  const configuredWorkspace = getConfig().getWorkspacePath();
  const sessionWorkspace = getWorkspace(sessionId);
  const workspacePath = configuredWorkspace || sessionWorkspace;
  if (workspacePath && sessionWorkspace !== workspacePath) {
    setWorkspace(sessionId, workspacePath);
  }
  console.log(`[v2] SESSION: ${sessionId} | Workspace: ${workspacePath}`);
  const history = getHistoryForApiCall(sessionId, 5);
  const tools = isBootStartupTurn
    ? buildTools().filter((t: any) => bootAllowedTools.has(String(t?.function?.name || '')))
    : buildTools();
  const allToolResults: ToolResult[] = [];
  let allThinking = '';
  let preflightRoute: 'primary_direct' | 'primary_with_plan' | 'secondary_chat' | 'background_task' | null = null;
  let preflightReasonForTurn = '';
  let continuationNudges = 0;
  const MAX_CONTINUATION_NUDGES = 2;
  const orchestrationSkillEnabled = isOrchestrationSkillEnabled();
  const greetingLikeTurn = isGreetingLikeMessage(message);

  // ── Preempt watchdog setup ─────────────────────────────────────────────────
  const rawCfgForPreempt = (getConfig().getConfig() as any);
  const primaryProvider = rawCfgForPreempt.llm?.provider || 'ollama';
  const preemptCfg: {
    enabled: boolean;
    stallThresholdMs: number;
    maxPerTurn: number;
    maxPerSession: number;
    restartMode: 'inherit_console' | 'detached_hidden';
  } = (() => {
    const oc = rawCfgForPreempt.orchestration;
    const preemptRaw = {
      ...(oc?.preempt || {}),
      restart_mode: oc?.preempt?.restart_mode
        || process.env.SMALLCLAW_OLLAMA_RESTART_MODE
        || (process.platform === 'win32' ? 'inherit_console' : 'detached_hidden'),
    };
    const normalizedPreempt = clampPreemptConfig(preemptRaw);
    return {
      enabled: orchestrationSkillEnabled
        && primaryProvider === 'ollama'
        && normalizedPreempt.enabled,
      stallThresholdMs: normalizedPreempt.stall_threshold_seconds * 1000,
      maxPerTurn: normalizedPreempt.max_preempts_per_turn,
      maxPerSession: normalizedPreempt.max_preempts_per_session,
      restartMode: normalizedPreempt.restart_mode === 'detached_hidden'
        ? 'detached_hidden'
        : 'inherit_console',
    };
  })();
  const preemptState = new PreemptState();
  preemptState.preemptsThisSession = getPreemptSessionCount(sessionId);
  const ollamaEndpoint = rawCfgForPreempt.llm?.providers?.ollama?.endpoint
    || rawCfgForPreempt.ollama?.endpoint
    || 'http://localhost:11434';
  const ollamaProcMgr = preemptCfg.enabled
    ? new OllamaProcessManager({ endpoint: ollamaEndpoint, restartMode: preemptCfg.restartMode })
    : null;
  let browserContinuationPending = false;
  let browserAdvisorRoute: 'answer_now' | 'continue_browser' | 'collect_more' | 'handoff_primary' | null = null;
  let browserAdvisorHintPreview = '';
  let browserForcedRetries = 0;
  let browserAdvisorCallsThisTurn = 0;
  let desktopContinuationPending = false;
  let desktopAdvisorRoute: 'answer_now' | 'continue_desktop' | 'handoff_primary' | null = null;
  let desktopAdvisorHintPreview = '';
  let desktopAdvisorCallsThisTurn = 0;
  let browserAdvisorLastHash = '';
  let browserAdvisorUrlKey = '';
  let browserAdvisorBatch = 0;
  let browserAdvisorDedupeCount = 0;
  let browserNoFeedProgressStreak = 0;
  let browserStabilizeUrlKey = '';
  let browserStabilizeWaitRetries = 0;
  let browserStabilizeTabProbes = 0;
  let browserStabilizeExhausted = false;
  const browserAdvisorCollectedFeed: Array<Record<string, any>> = [];
  const browserAdvisorSeenFeedKeys = new Set<string>();
  const orchRuntimeCfg = getOrchestrationConfig();
  const fileOpSettings = resolveFileOpSettings(orchRuntimeCfg as any);
  const fileOpRouterEnabled =
    orchestrationSkillEnabled
    && (orchRuntimeCfg?.enabled ?? false)
    && fileOpSettings.enabled
    && !isBootStartupTurn;
  const localFileOpClassification = fileOpRouterEnabled
    ? classifyFileOpType(message)
    : { type: 'CHAT' as FileOpType, reason: 'file-op v2 disabled' };
  let fileOpClassification = localFileOpClassification;
  if (fileOpRouterEnabled) {
    const secondaryClass = await callSecondaryFileOpClassifier({
      userMessage: message,
      recentHistory: history.slice(-4).map(h => ({ role: h.role, content: h.content })),
    });
    if (secondaryClass) {
      fileOpClassification = {
        type: secondaryClass.operation as FileOpType,
        reason: `secondary classifier: ${secondaryClass.reason || 'runtime classification'} (confidence ${secondaryClass.confidence.toFixed(2)})`,
      };
      sendSSE('orchestration', {
        trigger: 'file_op_classifier',
        mode: 'router',
        route: secondaryClass.operation === 'BROWSER_OP'
          ? 'browser_ops'
          : secondaryClass.operation === 'DESKTOP_OP'
            ? 'desktop_ops'
            : (secondaryClass.operation === 'CHAT' ? 'chat' : 'file_ops'),
        reason: secondaryClass.reason || 'secondary runtime classification',
        operation: secondaryClass.operation,
        confidence: secondaryClass.confidence,
      });
    } else {
      // Secondary classifier unavailable — degrade to local classifier rather than
      // collapsing to CHAT. Falling back to CHAT silently strips all file-op gating
      // and verification, letting unchecked primary writes bypass all thresholds.
      // Local classification is conservative (FILE_EDIT/FILE_CREATE) and safer.
      sendSSE('info', {
        message: `FILE_OP router: secondary classifier unavailable; degrading to local classification (${localFileOpClassification.type}).`,
      });
      fileOpClassification = {
        type: localFileOpClassification.type,
        reason: `secondary classifier unavailable — local fallback: ${localFileOpClassification.reason}`,
      };
    }
  }
  const browserMaxForcedRetries = orchRuntimeCfg?.browser?.max_forced_retries ?? 2;
  const browserMaxAdvisorCallsPerTurn = orchRuntimeCfg?.browser?.max_advisor_calls_per_turn ?? 5;
  const desktopMaxAdvisorCallsPerTurn = 4;
  const browserMaxCollectedItems = orchRuntimeCfg?.browser?.max_collected_items ?? 80;
  const browserMinFeedItemsBeforeAnswer = orchRuntimeCfg?.browser?.min_feed_items_before_answer ?? 12;
  const browserStabilizeMaxWaitRetries = 2;
  const browserStabilizeMaxTabProbes = 2;
  const browserPacketMaxItems = Math.max(12, Math.min(60, Math.min(browserMaxCollectedItems, 40)));
  const seenToolCalls = new Set<string>();
  const recentToolCalls: Array<{ name: string; argsHash: string }> = [];
  const hashArgs = (args: any): string => {
    try {
      const normalize = (v: any): any => {
        if (Array.isArray(v)) return v.map(normalize);
        if (v && typeof v === 'object') {
          const out: Record<string, any> = {};
          for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
          return out;
        }
        return v;
      };
      return JSON.stringify(normalize(args || {})).slice(0, 200);
    } catch {
      return String(args || '').slice(0, 200);
    }
  };
  const checkLoopDetection = (toolName: string, args: any): { state: 'ok' | 'warn' | 'block'; repeats: number } => {
    const argsHash = hashArgs(args);
    const repeats = recentToolCalls.filter((t) => t.name === toolName && t.argsHash === argsHash).length;
    recentToolCalls.push({ name: toolName, argsHash });
    if (recentToolCalls.length > 20) recentToolCalls.shift();
    if (repeats >= 5) return { state: 'block', repeats };
    if (repeats >= 3) return { state: 'warn', repeats };
    return { state: 'ok', repeats };
  };
  const orchestrationState = new OrchestrationTriggerState();
  const orchestrationLog: string[] = [];
  const orchestrationStats = getOrchestrationSessionStats(sessionId);
  // Cached once per turn — used by browser interception, preempt nudge, and advisor calls
  const multiAgentActive = orchestrationSkillEnabled && ((getOrchestrationConfig()?.enabled) ?? false);
  const fileOpV2Active = multiAgentActive
    && fileOpSettings.enabled
    && (fileOpClassification.type === 'FILE_ANALYSIS' || fileOpClassification.type === 'FILE_CREATE' || fileOpClassification.type === 'FILE_EDIT');
  const fileOpType = fileOpClassification.type;
  let fileOpOwner: 'primary' | 'secondary' = fileOpType === 'FILE_ANALYSIS' ? 'secondary' : 'primary';
  const fileOpTouchedFiles = new Set<string>();
  const fileOpToolHistory: Array<{
    tool: string;
    args: any;
    result: string;
    error: boolean;
    actor: 'primary' | 'secondary';
    estimate_lines: number;
    estimate_chars: number;
  }> = [];
  let fileOpPrimaryWriteLines = 0;
  let fileOpPrimaryWriteChars = 0;
  let fileOpHadCreate = false;
  let fileOpHadToolFailure = false;
  let fileOpPrimaryStallPromoted = false;
  let fileOpLastFailureSignature = '';
  const fileOpPatchSignatures: string[] = [];
  const fileOpWatchdog = new FileOpProgressWatchdog(fileOpSettings.watchdog_no_progress_cycles);
  const resumedFileOpCheckpoint = (fileOpV2Active && fileOpSettings.checkpointing_enabled)
    ? loadFileOpCheckpoint(sessionId)
    : null;
  if (
    resumedFileOpCheckpoint
    && resumedFileOpCheckpoint.goal === message
    && resumedFileOpCheckpoint.phase !== 'done'
  ) {
    fileOpOwner = resumedFileOpCheckpoint.owner || fileOpOwner;
    for (const f of resumedFileOpCheckpoint.files_changed || []) {
      if (f) fileOpTouchedFiles.add(String(f));
    }
    for (const sig of resumedFileOpCheckpoint.patch_history_signatures || []) {
      if (sig) fileOpPatchSignatures.push(String(sig));
    }
    if (fileOpPatchSignatures.length > 20) {
      fileOpPatchSignatures.splice(0, fileOpPatchSignatures.length - 20);
    }
  }
  // Synthetic tool calls queued by the browser advisor for deterministic next steps.
  // When set, the main loop skips LLM generation and executes these directly.
  let pendingSyntheticToolCalls: Array<{ function: { name: string; arguments: any } }> = [];

  const trackFileOpMutation = (toolName: string, toolArgs: any, toolResult: ToolResult, actor: 'primary' | 'secondary') => {
    if (!isFileMutationTool(toolName)) return;
    const estimate = estimateFileToolChange(toolName, toolArgs);
    const target = extractFileToolTarget(toolName, toolArgs);
    if (target) fileOpTouchedFiles.add(target);
    if (actor === 'primary') {
      fileOpPrimaryWriteLines += estimate.lines_changed;
      fileOpPrimaryWriteChars += estimate.chars_changed;
    }
    if (isFileCreateTool(toolName) && !toolResult.error) fileOpHadCreate = true;
    if (toolResult.error) fileOpHadToolFailure = true;
    fileOpToolHistory.push({
      tool: toolName,
      args: toolArgs,
      result: toolResult.result,
      error: toolResult.error,
      actor,
      estimate_lines: estimate.lines_changed,
      estimate_chars: estimate.chars_changed,
    });
    if (fileOpToolHistory.length > 64) fileOpToolHistory.shift();
    maybeSaveFileOpCheckpoint({
      phase: 'execute',
      next_action: `${actor} applied ${toolName}`,
    });
  };

  const maybeSaveFileOpCheckpoint = (patch: {
    phase: 'plan' | 'execute' | 'verify' | 'repair' | 'done';
    next_action: string;
    findings?: any[];
  }) => {
    if (!fileOpV2Active || !fileOpSettings.checkpointing_enabled) return;
    saveFileOpCheckpoint(sessionId, {
      goal: message,
      phase: patch.phase,
      owner: fileOpOwner,
      operation: fileOpType,
      files_changed: Array.from(fileOpTouchedFiles).slice(0, 24),
      last_verifier_findings: Array.isArray(patch.findings) ? patch.findings : [],
      patch_history_signatures: fileOpPatchSignatures.slice(-12),
      next_action: patch.next_action,
    });
  };

  const executeSecondaryPatchCalls = async (
    calls: Array<{ tool: string; args: any }>,
    reason: string,
  ): Promise<{ ran: number; patchSignature: string }> => {
    const planCalls = (calls || []).filter(c => c && c.tool && typeof c.args === 'object');
    if (!planCalls.length) return { ran: 0, patchSignature: '' };
    const patchSignature = buildPatchSignature(planCalls.map(c => ({ tool: c.tool, args: c.args })));
    fileOpPatchSignatures.push(patchSignature);
    if (fileOpPatchSignatures.length > 20) fileOpPatchSignatures.shift();
    sendSSE('info', { message: `FILE_OP v2: applying ${planCalls.length} secondary patch call(s) (${reason}).` });
    let ran = 0;
    for (const call of planCalls) {
      const toolName = String(call.tool || '').trim();
      const toolArgs = call.args || {};
      sendSSE('tool_call', { action: toolName, args: toolArgs, stepNum: allToolResults.length + 1, synthetic: true, actor: 'secondary' });
      const toolResult = await executeTool(toolName, toolArgs, workspacePath, sessionId);
      allToolResults.push(toolResult);
      logToolCall(workspacePath, toolName, toolArgs, toolResult.result, toolResult.error);
      trackFileOpMutation(toolName, toolArgs, toolResult, 'secondary');
      if (toolResult.error) fileOpHadToolFailure = true;
      sendSSE('tool_result', { action: toolName, result: toolResult.result.slice(0, 500), error: toolResult.error, stepNum: allToolResults.length, synthetic: true, actor: 'secondary' });
      const goalReminder = `\n\n[GOAL REMINDER: Your task is still: "${message.slice(0, 120)}". Stay focused on this goal only.]`;
      const isBrowserTool = isBrowserToolName(toolName);
      const isDesktopTool = isDesktopToolName(toolName);
      const toolMessageContent = (multiAgentActive && (isBrowserTool || isDesktopTool))
        ? (isBrowserTool ? buildBrowserAck(toolName, toolResult) : buildDesktopAck(toolName, toolResult))
        : toolResult.result;
      messages.push({ role: 'tool', tool_name: toolName, content: toolMessageContent + goalReminder });
      orchestrationLog.push(
        toolResult.error
          ? `✗ [secondary_patch] ${toolName}: ${toolResult.result.slice(0, 100)}`
          : `✓ [secondary_patch] ${toolName}: ${toolResult.result.slice(0, 80)}`,
      );
      ran++;
    }
    return { ran, patchSignature };
  };

  if (fileOpV2Active) {
    sendSSE('info', {
      message: `FILE_OP v2 active: ${fileOpType} (${fileOpClassification.reason}).`,
    });
    sendSSE('orchestration', {
      trigger: 'file_op_router',
      mode: 'router',
      route: 'file_ops',
      reason: `${fileOpType} (${fileOpClassification.reason})`,
      file_op_type: fileOpType,
      owner: fileOpOwner,
    });
    if (resumedFileOpCheckpoint && resumedFileOpCheckpoint.goal === message && resumedFileOpCheckpoint.phase !== 'done') {
      sendSSE('info', {
        message: `FILE_OP v2: resuming checkpoint at phase="${resumedFileOpCheckpoint.phase}" next="${resumedFileOpCheckpoint.next_action || 'n/a'}".`,
      });
    } else {
      maybeSaveFileOpCheckpoint({
        phase: 'plan',
        next_action: fileOpType === 'FILE_ANALYSIS' ? 'secondary analysis' : 'primary execution',
      });
    }
  }

  const personalityCtx = await buildPersonalityContext(sessionId, workspacePath);

  // Inject active browser session state so LLM knows to reuse it instead of re-opening
  const browserInfo = getBrowserSessionInfo(sessionId);
  const browserStateCtx = browserInfo.active
    ? `\n\n[BROWSER SESSION ACTIVE: A browser tab is already open.${
        browserInfo.title ? ` Current page: "${browserInfo.title}"` : ''
      }${
        browserInfo.url ? ` at ${browserInfo.url}` : ''
      }. Use browser_snapshot to see current elements, or browser_click to navigate. Do NOT call browser_open unless you need to go to a completely different site.]`
    : '';

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const executionModeSystemBlock = (() => {
    if (executionMode === 'background_task') {
      return [
        'EXECUTION MODE: Autonomous background task.',
        'You are running without user oversight. Do not ask clarifying questions.',
        'Make decisions based on available context. Use tools precisely.',
        'If truly blocked: return a concise blocked reason and the best next action.',
      ].join('\n');
    }
    if (executionMode === 'heartbeat') {
      return [
        'EXECUTION MODE: Heartbeat check.',
        'Run concise, decisive checks and report only actionable issues.',
      ].join('\n');
    }
    if (executionMode === 'cron') {
      return [
        'EXECUTION MODE: Scheduled cron task.',
        'Act autonomously and complete the prompt without asking follow-up questions.',
      ].join('\n');
    }
    return '';
  })();

  const messages: any[] = [
    {
      role: 'system',
      content: `${executionModeSystemBlock ? `${executionModeSystemBlock}\n\n` : ''}You are SmallClaw 🦞, a friendly AI assistant that runs locally.
Current date: ${dateStr}, ${timeStr}.

TOOLS:
- list_files: List workspace files
- read_file: Read file WITH line numbers (do this before editing)
- create_file: Create NEW file (fails if exists)
- replace_lines: Replace lines N-M with new content
- insert_after: Insert content after line N
- delete_lines: Delete lines N-M
- find_replace: Find exact text and replace
- delete_file: Delete a file
- web_search: Search the web. Returns headlines + short snippets.
- web_fetch: Fetch full text content from a URL. Use after web_search to read the actual page.
- run_command: Open apps for the USER to see (chrome, notepad, vscode). Use desktop_* tools to interact with desktop apps afterward.
- start_task: Launch a multi-step task (for complex operations needing many steps)
- browser_open: Navigate to a URL in a browser YOU control (can click, fill, snapshot after)
- browser_snapshot: Refresh visible elements. If element count looks low, call browser_wait first
- browser_click: Click by @ref. ALWAYS take browser_snapshot after to confirm the click worked
- browser_fill: Type into an [INPUT] element by @ref, then press Enter or click submit
- browser_press_key: Press Enter/Tab/Escape. Use Enter after filling a search box
- browser_wait: Wait N ms then snapshot — use when page has few elements or content is still loading
- browser_close: Close browser tab
- desktop_screenshot: Capture full desktop screenshot and window context (Windows)
- desktop_find_window: Find desktop windows by title/process
- desktop_focus_window: Bring a desktop window to foreground
- desktop_click: Click at screen coordinates
- desktop_drag: Drag mouse from one coordinate to another
- desktop_wait: Wait for UI to settle (ms)
- desktop_type: Type text into focused desktop window
- desktop_press_key: Press key/combo in focused desktop window
- desktop_get_clipboard: Read clipboard text
- desktop_set_clipboard: Set clipboard text

IDENTITY RULE:
Your name is SmallClaw. When a user asks you to search for, open, or find any external tool or project, look it up as requested. NEVER redirect to SmallClaw links or repos unless the user is specifically asking about SmallClaw itself. If a search fails, say so and ask for clarification.

TOOL ROUTING - web_fetch vs browser:
- Use browser_open + browser_snapshot for: social feeds (X/Twitter, Reddit), login-gated pages, JavaScript-heavy SPAs, anything that requires scrolling or clicking to reveal content.
- Use web_fetch for: static article URLs, documentation, blog posts, news pages — any URL where you already have the link and just need the text content. It is faster and cheaper than browser.
- Combined pattern: use browser to discover and collect links from a feed, then use web_fetch on specific linked URLs to read their full content.

BROWSER RULES:
1. run_command launches apps/windows. Use browser_* for web pages and desktop_* for native app/screen control.
2. If you already have a browser open, DO NOT call browser_open again. Use browser_snapshot to see the current page, then browser_click to navigate.
3. browser_open RETURNS a snapshot — read it immediately. Find the correct link by @ref, then call browser_click to follow it.
4. After EVERY click, read the snapshot returned in the tool result to confirm what changed.
5. Prefer direct search URLs over clicking search boxes.

DESKTOP RULES (Windows):
1. Use desktop_screenshot first to inspect active/open windows.
2. Use desktop_focus_window before desktop_click or desktop_type when the target app is not focused.
3. desktop_screenshot includes OCR preview text when available; use that evidence for status checks.
4. For status checks like "is VS Code done?", capture a fresh desktop_screenshot before answering.

AUTOMATION AUTHORIZATION:
- This app runs on the user's own machine; user requests here are explicit authorization for local browser and desktop automation.
- If the user asks to "use my computer" to open a site/click/type, execute with browser_* or desktop_* tools instead of refusing.
- Do not output policy refusal text for normal user-authorized local automation requests.

EDITING RULES:
1. ALWAYS read_file first to see line numbers.
2. Use replace_lines, insert_after, delete_lines for SURGICAL edits.
3. NEVER rewrite an entire file to change part of it.
4. KEEP all existing content the user didn't ask to change.
5. create_file is ONLY for new files.

RESPONSE RULES:
- Keep responses SHORT (1-2 sentences).
- Do NOT think out loud. Act and report.
- For greetings/questions, reply naturally without tools.${callerContext ? '\n\n' + callerContext : ''}${browserStateCtx}${personalityCtx}${skillsManager.buildPromptContext(500)}`,
    },
  ];

  if (pinnedMessages && pinnedMessages.length > 0) {
    messages.push({ role: 'user', content: '[PINNED CONTEXT - Important messages from earlier in our conversation:]' });
    for (const pin of pinnedMessages.slice(0, 3)) {
      messages.push({ role: pin.role === 'user' ? 'user' : 'assistant', content: pin.content });
    }
    messages.push({ role: 'assistant', content: 'I have the pinned context. Continuing...' });
  }

  for (const msg of history) {
    messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content });
  }
  messages.push({ role: 'user', content: message });

  const replaceCurrentUserPromptWithAdvisorObjective = (objective: string): boolean => {
    const objectiveText = String(objective || '').trim();
    if (!objectiveText) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== 'user') continue;
      if (String(msg?.content || '') !== message) continue;
      messages.splice(i, 1);
      break;
    }
    messages.push({ role: 'user', content: objectiveText });
    messages.push({
      role: 'assistant',
      content: 'Understood. I will execute this objective and preserve literal values from the request.',
    });
    return true;
  };

  const buildSecondaryAssistContext = () => {
    const availableTools = (tools || [])
      .map((t: any) => String(t?.function?.name || '').trim())
      .filter(Boolean);

    const recentToolExecutions = allToolResults.slice(-24).map((tr, idx, arr) => {
      const step = allToolResults.length - arr.length + idx + 1;
      return {
        step,
        name: String(tr.name || '').slice(0, 80),
        args: tr.args ?? {},
        result: String(tr.result || '').slice(0, 6000),
        error: tr.error === true,
      };
    });

    const recentModelMessages = (messages || [])
      .slice(-60)
      .map((m: any) => {
        const role = String(m?.role || '').trim();
        if (!role || !['user', 'assistant', 'tool'].includes(role)) return null;

        let content = String(m?.content || '');
        if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
          const toolCallSummary = m.tool_calls
            .slice(0, 10)
            .map((c: any) => {
              const n = String(c?.function?.name || 'unknown');
              let a = '{}';
              try { a = JSON.stringify(c?.function?.arguments || {}); } catch {}
              return `${n}(${a.slice(0, 240)})`;
            })
            .join(' | ');
          content = content
            ? `${content}\nTOOL_CALLS: ${toolCallSummary}`
            : `TOOL_CALLS: ${toolCallSummary}`;
        } else if (role === 'tool') {
          const toolName = String(m?.tool_name || 'tool');
          content = `${toolName}: ${content}`;
        }

        const trimmed = content.replace(/\r/g, '').trim();
        if (!trimmed) return null;
        return { role, content: trimmed.slice(0, 2200) };
      })
      .filter(Boolean)
      .slice(-28) as Array<{ role: string; content: string }>;

    let latestBrowserSnapshot = '';
    let latestDesktopSnapshot = '';
    for (let i = allToolResults.length - 1; i >= 0; i--) {
      const tr = allToolResults[i];
      if (!tr || typeof tr.name !== 'string') continue;
      const txt = String(tr.result || '').trim();
      if (!txt) continue;
      if (!latestBrowserSnapshot && tr.name.startsWith('browser_')) {
        latestBrowserSnapshot = txt.slice(0, 7000);
      }
      if (!latestDesktopSnapshot && tr.name.startsWith('desktop_')) {
        latestDesktopSnapshot = txt.slice(0, 7000);
      }
      if (latestBrowserSnapshot && latestDesktopSnapshot) break;
    }

    return {
      availableTools,
      recentToolExecutions,
      recentModelMessages,
      recentProcessNotes: orchestrationLog.slice(-28),
      latestBrowserSnapshot,
      latestDesktopSnapshot,
    };
  };

  const rawOrchCfg = ((getConfig().getConfig() as any).orchestration || {}) as any;

  // Optional preflight advisor pass: secondary model can route and provide
  // a compact execution plan before primary starts tool calling.
  const preflightCfg = orchestrationSkillEnabled ? getOrchestrationConfig() : null;
  if (!preflightCfg?.enabled && String(rawOrchCfg?.preflight?.mode || '') === 'always') {
    sendSSE('info', {
      message: 'Preflight advisor is set to Always, but Multi-Agent Orchestrator skill is disabled.',
    });
  }
  const skipGenericPreflightForFileOp = fileOpV2Active;
  if (skipGenericPreflightForFileOp) {
    sendSSE('info', {
      message: `FILE_OP v2 route selected (${fileOpType}); skipping generic advisor preflight.`,
    });
  }
  // Task runner sessions (sessionId starts with 'task_') are already inside a background task
  // execution — skip preflight entirely to prevent recursive task spawning loops.
  const isTaskRunnerSession = sessionId.startsWith('task_');

  if (
    preflightCfg?.enabled &&
    !isBootStartupTurn &&
    !skipGenericPreflightForFileOp &&
    !isTaskRunnerSession &&
    shouldRunPreflight(message, preflightCfg.preflight.mode) &&
    orchestrationStats.assistCount < preflightCfg.limits.max_assists_per_session
  ) {
    sendSSE('info', {
      message: `Running advisor preflight via ${preflightCfg.secondary.provider}:${preflightCfg.secondary.model}...`,
    });
    console.log(
      `[Orchestrator] Preflight start (${preflightCfg.secondary.provider}:${preflightCfg.secondary.model})`,
    );
    const preflight = await callSecondaryPreflight({
      userMessage: message,
      recentHistory: history.slice(-4).map(h => ({ role: h.role, content: h.content })),
    });

    if (preflight) {
      preflightRoute = preflight.route;
      preflightReasonForTurn = String(preflight.reason || '').trim();
      orchestrationLog.push(`[preflight:${preflight.route}] ${preflight.reason || 'no reason'}`);
      console.log(
        `[Orchestrator] Preflight route=${preflight.route} reason=${(preflight.reason || 'n/a').slice(0, 120)}`,
      );
      const stats = recordOrchestrationEvent(
        sessionId,
        {
          trigger: 'preflight',
          mode: 'planner',
          reason: preflight.reason || 'preflight routing',
          route: preflight.route,
        },
        preflightCfg,
      );
      sendSSE('orchestration', {
        trigger: 'preflight',
        mode: 'planner',
        route: preflight.route,
        reason: preflight.reason,
        preflight,
        assist_count: stats.assistCount,
        assist_cap: preflightCfg.limits.max_assists_per_session,
      });

      // ── Background task route ────────────────────────────────────────────
      if (preflight.route === 'background_task' && multiAgentActive) {
        const taskTitle = preflight.task_title || 'Background Task';
        const taskPlan = (preflight.task_plan || []).map((desc, i) => ({
          index: i,
          description: desc,
          status: 'pending' as const,
        }));
        const isTelegram = callerContext?.includes('[TELEGRAM]');
        const task = createTask({
          title: taskTitle,
          prompt: message,
          sessionId,
          channel: isTelegram ? 'telegram' : 'web',
          plan: taskPlan.length > 0 ? taskPlan : [{ index: 0, description: 'Execute task', status: 'pending' }],
        });
        appendJournal(task.id, { type: 'status_push', content: `Task queued: ${taskTitle}` });
        // Fire background runner (detached — does not block HTTP response)
        const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
        runner.start().catch(err => console.error(`[BackgroundTaskRunner] Task ${task.id} error:`, err.message));
        const queuedMessage = preflight.friendly_queued_message
          || `On it! I've queued "${taskTitle}" as a background task. You can track progress in the Tasks panel.`;
        sendSSE('task_queued', { taskId: task.id, title: taskTitle });
        logToDaily(workspacePath, 'LocalClaw', queuedMessage);
        addMessage(sessionId, { role: 'assistant', content: queuedMessage, timestamp: Date.now() });
        return { type: 'chat', text: queuedMessage };
      }

      if (
        preflight.route === 'secondary_chat' &&
        preflightCfg.preflight.allow_secondary_chat &&
        preflight.secondary_response?.trim()
      ) {
        sendSSE('info', {
          message: 'Advisor route selected secondary_chat. Returning secondary response directly.',
        });
        const text = preflight.secondary_response.trim();
        logToDaily(workspacePath, 'LocalClaw', text);
        return { type: 'chat', text };
      }

      if (preflight.route === 'secondary_chat' && !preflightCfg.preflight.allow_secondary_chat) {
        sendSSE('info', {
          message: 'Advisor suggested secondary_chat, but direct secondary chat is disabled. Continuing with primary.',
        });
      } else if (preflight.route === 'primary_direct') {
        sendSSE('info', { message: 'Advisor route selected primary_direct. Continuing with primary response.' });
      } else if (preflight.route === 'primary_with_plan') {
        // primary_with_plan is retired when multi-agent is active — upgrade to background_task
        if (multiAgentActive) {
          sendSSE('info', { message: 'Advisor returned primary_with_plan but multi-agent is active — upgrading to background_task.' });
          const taskTitle = preflight.task_title || (preflight.reason ? preflight.reason.slice(0, 60) : 'Background Task');
          const taskPlan = (preflight.task_plan || preflight.quick_plan || []).map((desc: string, i: number) => ({
            index: i, description: desc, status: 'pending' as const,
          }));
          const isTelegram = callerContext?.includes('[TELEGRAM]');
          const task = createTask({
            title: taskTitle,
            prompt: message,
            sessionId,
            channel: isTelegram ? 'telegram' : 'web',
            plan: taskPlan.length > 0 ? taskPlan : [{ index: 0, description: 'Execute task', status: 'pending' }],
          });
          appendJournal(task.id, { type: 'status_push', content: `Task queued (upgraded from primary_with_plan): ${taskTitle}` });
          const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
          runner.start().catch((err: Error) => console.error(`[BackgroundTaskRunner] Task ${task.id} error:`, err.message));
          const queuedMessage = preflight.friendly_queued_message
            || `On it! I've queued "${taskTitle}" as a background task. You can track progress in the Tasks panel.`;
          sendSSE('task_queued', { taskId: task.id, title: taskTitle });
          logToDaily(workspacePath, 'LocalClaw', queuedMessage);
          addMessage(sessionId, { role: 'assistant', content: queuedMessage, timestamp: Date.now() });
          return { type: 'chat', text: queuedMessage };
        }
        sendSSE('info', { message: 'Advisor route selected primary_with_plan. Injecting execution objective and plan guidance.' });
      }

      const shouldInjectObjective = preflight.route === 'primary_with_plan';
      if (shouldInjectObjective) {
        const objectiveHint = formatPreflightExecutionObjective(preflight);
        const injected = replaceCurrentUserPromptWithAdvisorObjective(objectiveHint);
        if (!injected) {
          sendSSE('warn', {
            message: 'Advisor objective injection failed; falling back to raw user prompt.',
          });
        }
      }

      if (preflight.route === 'primary_with_plan') {
        const hint = formatPreflightHint(preflight);
        messages.push({ role: 'user', content: hint });
        messages.push({ role: 'assistant', content: 'Understood. I will follow this preflight guidance.' });
      }
    }
  } else if (
    preflightCfg?.enabled &&
    !isBootStartupTurn &&
    !isTaskRunnerSession &&
    shouldRunPreflight(message, preflightCfg.preflight.mode) &&
    orchestrationStats.assistCount >= preflightCfg.limits.max_assists_per_session
  ) {
    sendSSE('info', { message: 'Advisor preflight skipped: session assist cap reached.' });
  }

  const resetBrowserAdvisorCollection = () => {
    browserAdvisorCollectedFeed.length = 0;
    browserAdvisorSeenFeedKeys.clear();
    browserAdvisorDedupeCount = 0;
    browserAdvisorBatch = 0;
    browserAdvisorLastHash = '';
    browserNoFeedProgressStreak = 0;
    browserStabilizeUrlKey = '';
    browserStabilizeWaitRetries = 0;
    browserStabilizeTabProbes = 0;
    browserStabilizeExhausted = false;
  };

  const toUrlKey = (rawUrl: string): string => {
    try {
      const u = new URL(String(rawUrl || ''));
      return `${u.hostname}${u.pathname}`.toLowerCase();
    } catch {
      return String(rawUrl || '').toLowerCase().split('?')[0];
    }
  };

  const feedItemKey = (item: Record<string, any>): string => {
    if (item?.id) return `id:${String(item.id)}`;
    if (item?.link) return `link:${String(item.link)}`;
    const text = String(item?.text || item?.snippet || item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const handle = String(item?.handle || item?.author || '').toLowerCase();
    const time = String(item?.time || '').slice(0, 40);
    return `hash:${handle}|${time}|${text}`;
  };

  const mergeBrowserFeedBatch = (batch: Array<Record<string, any>>): { added: number; deduped: number; total: number } => {
    let added = 0;
    let deduped = 0;
    for (const raw of batch || []) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const key = feedItemKey(item);
      if (!key || browserAdvisorSeenFeedKeys.has(key)) {
        deduped++;
        continue;
      }
      browserAdvisorSeenFeedKeys.add(key);
      browserAdvisorCollectedFeed.push(item);
      if (browserAdvisorCollectedFeed.length > browserMaxCollectedItems) {
        browserAdvisorCollectedFeed.shift();
      }
      added++;
    }
    browserAdvisorDedupeCount += deduped;
    return { added, deduped, total: browserAdvisorCollectedFeed.length };
  };

  const maybeRunBrowserAdvisorPass = async (triggerToolName: string, triggerResult: ToolResult): Promise<void> => {
    if (!isBrowserToolName(triggerToolName) || triggerResult.error) return;
    const orchCfg = getOrchestrationConfig();
    if (!orchestrationSkillEnabled || !orchCfg?.enabled) return;
    if (browserAdvisorCallsThisTurn >= browserMaxAdvisorCallsPerTurn) return;
    if (orchestrationStats.assistCount >= orchCfg.limits.max_assists_per_session) return;

    const packet = await getBrowserAdvisorPacket(sessionId, { maxItems: browserPacketMaxItems, snapshotElements: 180 });
    if (!packet) return;
    const packetUrlKey = toUrlKey(packet.page.url);
    if (
      triggerToolName === 'browser_open'
      || (browserAdvisorUrlKey && packetUrlKey && packetUrlKey !== browserAdvisorUrlKey && !browserContinuationPending)
    ) {
      resetBrowserAdvisorCollection();
    }
    browserAdvisorUrlKey = packetUrlKey || browserAdvisorUrlKey;
    if (!browserStabilizeUrlKey || (packetUrlKey && packetUrlKey !== browserStabilizeUrlKey)) {
      browserStabilizeUrlKey = packetUrlKey || browserStabilizeUrlKey;
      browserStabilizeWaitRetries = 0;
      browserStabilizeTabProbes = 0;
      browserStabilizeExhausted = false;
    }

    const isFeedOrSearchPage = packet.page.pageType === 'x_feed' || packet.page.pageType === 'search_results';
    const quality = evaluateBrowserSnapshotQuality(packet.snapshot, packet.snapshotElements, message);
    if (quality.low) {
      const diag = quality.diagnostics;
      const diagMsg = diag
        ? ` hidden=${diag.hidden}, unlabeled_non_input=${diag.unlabeledNonInput}, unnamed_input_included=${diag.unnamedInputIncluded}`
        : '';
      sendSSE('info', {
        message: `Snapshot quality low: elements=${quality.elementCount}, input_candidates=${quality.inputCandidates}, reasons=${quality.reasons.join(' | ')}.${diagMsg}`,
      });
      const logLine = `[snapshot_quality] low | elements=${quality.elementCount} | inputs=${quality.inputCandidates} | reasons=${quality.reasons.join('; ')}`;
      orchestrationLog.push(logLine.slice(0, 260));
    }

    const stabilizationEligibleTool = (
      triggerToolName === 'browser_open'
      || triggerToolName === 'browser_snapshot'
      || triggerToolName === 'browser_wait'
      || triggerToolName === 'browser_press_key'
    );
    const stabilizationEligiblePage = packet.page.pageType === 'generic' || packet.page.pageType === 'article';
    const shouldAutoStabilize =
      quality.elementCount < 10
      || (goalLikelyNeedsTextInput(message) && quality.inputCandidates === 0);
    if (
      stabilizationEligibleTool
      && stabilizationEligiblePage
      && quality.low
      && shouldAutoStabilize
      && !isFeedOrSearchPage
      && !browserStabilizeExhausted
    ) {
      if (browserStabilizeWaitRetries < browserStabilizeMaxWaitRetries) {
        browserStabilizeWaitRetries += 1;
        browserContinuationPending = true;
        browserAdvisorRoute = 'continue_browser';
        browserAdvisorHintPreview = 'Snapshot stabilization in progress';
        pendingSyntheticToolCalls = [
          { function: { name: 'browser_wait', arguments: { ms: 1500 } } },
          { function: { name: 'browser_snapshot', arguments: {} } },
        ];
        sendSSE('info', {
          message: `Snapshot stabilization: wait+snapshot (${browserStabilizeWaitRetries}/${browserStabilizeMaxWaitRetries}) before advisor routing.`,
        });
        return;
      }

      const shouldProbeFocus = goalLikelyNeedsTextInput(message) && quality.inputCandidates === 0;
      if (shouldProbeFocus && browserStabilizeTabProbes < browserStabilizeMaxTabProbes) {
        browserStabilizeTabProbes += 1;
        browserContinuationPending = true;
        browserAdvisorRoute = 'continue_browser';
        browserAdvisorHintPreview = 'Input focus probe in progress';
        pendingSyntheticToolCalls = [
          { function: { name: 'browser_press_key', arguments: { key: 'Tab' } } },
          { function: { name: 'browser_wait', arguments: { ms: 500 } } },
          { function: { name: 'browser_snapshot', arguments: {} } },
        ];
        sendSSE('info', {
          message: `Snapshot stabilization: Tab focus probe (${browserStabilizeTabProbes}/${browserStabilizeMaxTabProbes}) to surface input controls.`,
        });
        return;
      }

      browserStabilizeExhausted = true;
      sendSSE('info', {
        message: 'Snapshot stabilization exhausted for this page; proceeding with current snapshot evidence.',
      });
    } else if (
      !quality.low
      && (browserStabilizeWaitRetries > 0 || browserStabilizeTabProbes > 0)
    ) {
      sendSSE('info', {
        message: `Snapshot stabilization complete: elements=${quality.elementCount}, input_candidates=${quality.inputCandidates}.`,
      });
      browserStabilizeWaitRetries = 0;
      browserStabilizeTabProbes = 0;
      browserStabilizeExhausted = false;
    }

    if (
      !isBrowserHeavyResearchPage({
        url: packet.page.url,
        pageType: packet.page.pageType,
        snapshotElements: packet.snapshotElements,
        feedCount: packet.extractedFeed.length,
      })
    ) {
      return;
    }
    const hashUnchanged = packet.contentHash === browserAdvisorLastHash;
    if (hashUnchanged && !browserContinuationPending) return;
    browserAdvisorLastHash = packet.contentHash;
    browserAdvisorCallsThisTurn += 1;
    browserAdvisorBatch += 1;

    const merged = mergeBrowserFeedBatch(packet.extractedFeed as Array<Record<string, any>>);
    const isFeedCollectionPage = packet.page.pageType === 'x_feed' || packet.page.pageType === 'search_results';
    if (isFeedCollectionPage) {
      browserNoFeedProgressStreak = merged.added > 0 ? 0 : (browserNoFeedProgressStreak + 1);
    } else {
      browserNoFeedProgressStreak = 0;
    }

    sendSSE('browser_advisor_start', {
      trigger_tool: triggerToolName,
      page_type: packet.page.pageType,
      url: packet.page.url,
      snapshot_elements: packet.snapshotElements,
      extracted_count: packet.extractedFeed.length,
    });
    sendSSE('feed_collected', {
      batch: browserAdvisorBatch,
      added: merged.added,
      total: merged.total,
      deduped: merged.deduped,
      url: packet.page.url,
    });

    const recentFailures = allToolResults
      .filter((r) => r.error)
      .slice(-4)
      .map((r) => `${r.name}: ${String(r.result || '').slice(0, 180)}`);

    const advisorFeed = browserAdvisorCollectedFeed.length > 0
      ? browserAdvisorCollectedFeed.slice(-browserMaxCollectedItems)
      : (packet.extractedFeed as Array<Record<string, any>>);

    // ── Change 5: chat_interface generation-wait — skip advisor, inject synthetic wait ──
    if (packet.page.pageType === 'chat_interface' && packet.isGenerating) {
      sendSSE('info', { message: 'Browser: chat interface still generating — waiting for response before advising.' });
      pendingSyntheticToolCalls = [
        { function: { name: 'browser_wait', arguments: { ms: 3000 } } },
        { function: { name: 'browser_snapshot', arguments: {} } },
      ];
      return; // don't call advisor yet — next round will re-enter this function with fresh snapshot
    }

    let advisor = await callSecondaryBrowserAdvisor({
      goal: message,
      minFeedItemsBeforeAnswer: browserMinFeedItemsBeforeAnswer,
      page: {
        title: packet.page.title,
        url: packet.page.url,
        pageType: packet.page.pageType,
        snapshotElements: packet.snapshotElements,
      },
      extractedFeed: advisorFeed,
      textBlocks: packet.textBlocks,
      snapshot: packet.snapshot,
      scrollState: {
        batch: browserAdvisorBatch,
        total_collected: advisorFeed.length,
        dedupe_count: browserAdvisorDedupeCount,
      },
      lastActions: orchestrationLog.slice(-8),
      recentFailures,
      pageText: packet.pageText,
      isGenerating: packet.isGenerating,
    });
    if (!advisor) return;

    // Guardrail: collect_more should only run on feed/search collection pages.
    // For generic pages (e.g. chatgpt.com composer), force decisive routing.
    if (advisor.route === 'collect_more' && !isFeedCollectionPage) {
      sendSSE('info', {
        message: 'Browser advisor override: collect_more disabled on non-feed page; switching to direct interaction mode.',
      });
      advisor = {
        ...advisor,
        route: 'handoff_primary',
        reason: 'collect_more disabled for non-feed pages; choose a concrete interaction from current snapshot.',
        next_tool: { tool: 'browser_snapshot', params: {} },
        primary_hint: 'Do not scroll/PageDown here. Use the current snapshot refs to click/fill the correct control directly.',
      };
    }

    // Guardrail: if feed collection is making no progress, stop scroll loops.
    if (
      advisor.route === 'collect_more'
      && isFeedCollectionPage
      && browserNoFeedProgressStreak >= 2
      && advisorFeed.length === 0
    ) {
      sendSSE('info', {
        message: 'Browser advisor override: collection stalled with zero extracted items; stopping scroll loop.',
      });
      advisor = {
        ...advisor,
        route: 'continue_browser',
        reason: 'No feed items extracted after repeated collection attempts; stop scrolling and select a concrete next interaction.',
        next_tool: { tool: 'browser_snapshot', params: {} },
        primary_hint: 'Collection is stalled (0 extracted). Do not keep PageDown looping. Use snapshot evidence and pick a concrete click/fill step.',
      };
    }

    if (advisor.route === 'collect_more') {
      if (!advisor.next_tool?.tool) {
        advisor = {
          ...advisor,
          next_tool: { tool: 'browser_press_key', params: { key: 'PageDown' } },
        };
      } else if (
        advisor.next_tool.tool === 'browser_press_key'
        && (!advisor.next_tool.params || !advisor.next_tool.params.key)
      ) {
        advisor = {
          ...advisor,
          next_tool: { tool: 'browser_press_key', params: { ...(advisor.next_tool.params || {}), key: 'PageDown' } },
        };
      }
    }

    const hint = formatBrowserAdvisorHint(advisor);
    const stats = recordOrchestrationEvent(
      sessionId,
      {
        trigger: 'auto',
        mode: 'planner',
        reason: `browser_advisor:${advisor.route}${advisor.reason ? ` (${advisor.reason})` : ''}`,
        route: advisor.route,
      },
      orchCfg,
    );

    browserAdvisorRoute = advisor.route;
    browserAdvisorHintPreview = String(advisor.primary_hint || advisor.reason || advisor.answer || '').slice(0, 220);
    browserContinuationPending = advisor.route === 'continue_browser' || advisor.route === 'collect_more';
    if (!browserContinuationPending) {
      browserForcedRetries = 0;
    }

    sendSSE('browser_advisor_route', {
      route: advisor.route,
      reason: advisor.reason,
      answer: advisor.answer || '',
      primary_hint: advisor.primary_hint || '',
      next_tool: advisor.next_tool || null,
      collect_policy: advisor.collect_policy || null,
      raw_response: advisor.raw_response || '',
      assist_count: stats.assistCount,
      assist_cap: orchCfg.limits.max_assists_per_session,
    });
    sendSSE('browser_advisor_nudge', {
      route: advisor.route,
      preview: browserAdvisorHintPreview,
    });

    orchestrationLog.push(`[browser:${advisor.route}] ${String(advisor.reason || 'n/a').slice(0, 200)}`);

    // ── Synthetic tool call injection for deterministic collect_more scrolls ─────────
    // When the advisor says scroll (PageDown), skip LLM generation entirely.
    // Inject as a synthetic assistant message that the main loop executes directly.
    // This eliminates the 75s stall window between advisor directive and actual scroll.
    const isCollectMoreScroll = advisor.route === 'collect_more'
      && multiAgentActive
      && isFeedCollectionPage
      && advisor.next_tool?.tool === 'browser_press_key';
    const isCollectMoreWait = advisor.route === 'collect_more'
      && multiAgentActive
      && isFeedCollectionPage
      && advisor.next_tool?.tool === 'browser_wait';

    if (isCollectMoreScroll || isCollectMoreWait) {
      // Queue synthetic tool calls: scroll + wait + snapshot (all deterministic)
      const scrollParams = advisor.next_tool!.params || { key: 'PageDown' };
      pendingSyntheticToolCalls = [
        { function: { name: advisor.next_tool!.tool, arguments: scrollParams } },
        { function: { name: 'browser_wait', arguments: { ms: 1500 } } },
        { function: { name: 'browser_snapshot', arguments: {} } },
      ];
      sendSSE('info', { message: `Advisor: synthetic scroll queued (${advisor.route}) — skipping LLM generation.` });
      // Push a compact hint so the LLM knows what happened after the synthetic round
      messages.push({ role: 'user', content: hint });
      messages.push({ role: 'assistant', content: `[ADVISOR] ${advisorFeed.length}/${browserMinFeedItemsBeforeAnswer} items. Scrolling for more.` });
      return;
    }

    // For non-deterministic steps, use the normal message injection path
    // ── Changes 2 & 3: context wipe + stripped executor system for browser ops ──────────
    // Secondary holds full state via buildSecondaryAssistContext().
    // Primary only needs: minimal system + original goal + last 4 tool acks + this directive.
    // Wipe now, before pushing the hint pair, so the hint ends up at the bottom cleanly.
    if (multiAgentActive) {
      const systemMsg = messages[0]; // always keep system at [0]
      // Stripped executor system — no editing rules, no identity prose, just tool list + 3 rules
      const strippedSystem = {
        role: 'system',
        content: `You are SmallClaw. Execute browser tool calls exactly as instructed by the advisor directive below.

BROWSER TOOLS: browser_open, browser_snapshot, browser_click, browser_fill, browser_press_key, browser_wait, browser_scroll, browser_close, web_fetch

RULES:
1. Call exactly the tool and params the advisor specifies.
2. Do not think, plan, or explain. Just call the tool.
3. If the directive says answer_now, respond in 1-2 sentences using the provided draft.`,
      };
      // Keep last 4 tool-result messages so the LLM has minimal recent action context
      const recentToolMsgs = messages
        .filter((m: any) => m.role === 'tool')
        .slice(-4);
      // Rebuild messages: stripped system + goal + last 4 tool acks
      messages.length = 0;
      messages.push(strippedSystem);
      messages.push({ role: 'user', content: message });
      messages.push({ role: 'assistant', content: 'Understood. Executing browser task.' });
      for (const tm of recentToolMsgs) messages.push(tm);
    }

    messages.push({ role: 'user', content: hint });
    messages.push({ role: 'assistant', content: 'Understood. Continuing with browser advisor guidance.' });
    if (advisor.route === 'answer_now' && advisor.answer.trim()) {
      messages.push({
        role: 'user',
        content: `Use the browser evidence and answer now in 1-2 concise sentences. Draft answer: ${advisor.answer.slice(0, 700)}`,
      });
    } else if (advisor.next_tool?.tool) {
      const isWebFetchStep = advisor.next_tool.tool === 'web_fetch';
      const collectTail = advisor.route === 'collect_more' && !isWebFetchStep
        ? ' Then continue collection: if needed call browser_wait(1200) and browser_snapshot before deciding again.'
        : '';
      const webFetchNote = isWebFetchStep
        ? ' Use web_fetch (not browser_open) since you already have the URL and only need the text content.'
        : '';
      messages.push({
        role: 'user',
        content: `Immediate next step: call ${advisor.next_tool.tool} with params ${JSON.stringify(advisor.next_tool.params || {})}. Do not stop with intent text.${collectTail}${webFetchNote}`,
      });
    }
  };

  const maybeRunDesktopAdvisorPass = async (triggerToolName: string, triggerResult: ToolResult): Promise<void> => {
    if (!isDesktopToolName(triggerToolName) || triggerResult.error) return;
    if (triggerToolName !== 'desktop_screenshot') return;
    const orchCfg = getOrchestrationConfig();
    if (!orchestrationSkillEnabled || !orchCfg?.enabled) return;
    if (desktopAdvisorCallsThisTurn >= desktopMaxAdvisorCallsPerTurn) return;
    if (orchestrationStats.assistCount >= orchCfg.limits.max_assists_per_session) return;

    const packet = getDesktopAdvisorPacket(sessionId);
    if (!packet) return;

    desktopAdvisorCallsThisTurn += 1;
    sendSSE('desktop_advisor_start', {
      trigger_tool: triggerToolName,
      active_window: packet.activeWindow?.title || '',
      open_windows: packet.openWindows.length,
      width: packet.width,
      height: packet.height,
      ocr_confidence: Number(packet.ocrConfidence || 0),
      ocr_chars: String(packet.ocrText || '').length,
    });

    const recentFailures = allToolResults
      .filter((r) => r.error)
      .slice(-4)
      .map((r) => `${r.name}: ${String(r.result || '').slice(0, 180)}`);
    const clipboardPreview = (() => {
      for (let i = allToolResults.length - 1; i >= 0; i--) {
        const r = allToolResults[i];
        if (!r || r.error) continue;
        if (r.name !== 'desktop_get_clipboard') continue;
        return String(r.result || '').slice(0, 1200);
      }
      return '';
    })();

    const advisor = await callSecondaryDesktopAdvisor({
      goal: message,
      screenshot: {
        width: packet.width,
        height: packet.height,
        capturedAt: packet.capturedAt,
        contentHash: packet.contentHash,
      },
      // Pass the raw screenshot to the advisor when available. The advisor function
      // will only inject it as an image_url content part when the secondary provider
      // supports vision (openai / openai_codex). For Ollama/llama.cpp it is ignored.
      screenshotBase64: packet.screenshotBase64 || undefined,
      activeWindow: packet.activeWindow
        ? { processName: packet.activeWindow.processName, title: packet.activeWindow.title }
        : undefined,
      openWindows: packet.openWindows.slice(0, 40).map((w) => ({ processName: w.processName, title: w.title })),
      lastActions: orchestrationLog.slice(-8),
      recentFailures,
      clipboardPreview,
      ocrText: packet.ocrText || '',
      ocrConfidence: Number(packet.ocrConfidence || 0),
    });
    if (!advisor) return;

    const hint = formatDesktopAdvisorHint(advisor);
    const stats = recordOrchestrationEvent(
      sessionId,
      {
        trigger: 'auto',
        mode: 'planner',
        reason: `desktop_advisor:${advisor.route}${advisor.reason ? ` (${advisor.reason})` : ''}`,
        route: advisor.route,
      },
      orchCfg,
    );

    desktopAdvisorRoute = advisor.route;
    desktopAdvisorHintPreview = String(advisor.primary_hint || advisor.reason || advisor.answer || '').slice(0, 220);
    desktopContinuationPending = advisor.route === 'continue_desktop';

    sendSSE('desktop_advisor_route', {
      route: advisor.route,
      reason: advisor.reason,
      answer: advisor.answer || '',
      primary_hint: advisor.primary_hint || '',
      next_tool: advisor.next_tool || null,
      raw_response: advisor.raw_response || '',
      assist_count: stats.assistCount,
      assist_cap: orchCfg.limits.max_assists_per_session,
    });
    sendSSE('desktop_advisor_nudge', {
      route: advisor.route,
      preview: desktopAdvisorHintPreview,
    });

    orchestrationLog.push(`[desktop:${advisor.route}] ${String(advisor.reason || 'n/a').slice(0, 200)}`);

    if (multiAgentActive) {
      const strippedSystem = {
        role: 'system',
        content: `You are SmallClaw. Execute desktop tool calls exactly as instructed by the advisor directive below.

DESKTOP TOOLS: desktop_screenshot, desktop_find_window, desktop_focus_window, desktop_click, desktop_drag, desktop_wait, desktop_type, desktop_press_key, desktop_get_clipboard, desktop_set_clipboard

RULES:
1. Call exactly the tool and params the advisor specifies.
2. Do not think, plan, or explain. Just call the tool.
3. If the directive says answer_now, respond in 1-2 sentences using the provided draft.`,
      };
      const recentToolMsgs = messages
        .filter((m: any) => m.role === 'tool')
        .slice(-4);
      messages.length = 0;
      messages.push(strippedSystem);
      messages.push({ role: 'user', content: message });
      messages.push({ role: 'assistant', content: 'Understood. Executing desktop task.' });
      for (const tm of recentToolMsgs) messages.push(tm);
    }

    messages.push({ role: 'user', content: hint });
    messages.push({ role: 'assistant', content: 'Understood. Continuing with desktop advisor guidance.' });
    if (advisor.route === 'answer_now' && advisor.answer.trim()) {
      messages.push({
        role: 'user',
        content: `Use desktop evidence and answer now in 1-2 concise sentences. Draft answer: ${advisor.answer.slice(0, 700)}`,
      });
    } else if (advisor.next_tool?.tool) {
      messages.push({
        role: 'user',
        content: `Immediate next step: call ${advisor.next_tool.tool} with params ${JSON.stringify(advisor.next_tool.params || {})}. After acting, capture desktop_screenshot again if fresh state is needed.`,
      });
    }
  };

  if (fileOpV2Active && fileOpType === 'FILE_ANALYSIS') {
    sendSSE('info', { message: 'FILE_OP v2: delegating analysis to secondary model.' });
    const candidateFiles = (() => {
      try {
        return fs.readdirSync(workspacePath, { withFileTypes: true })
          .filter(e => e.isFile())
          .map(e => e.name)
          .slice(0, 80);
      } catch {
        return [] as string[];
      }
    })();
    const analysis = await callSecondaryFileAnalyzer({
      userMessage: message,
      recentHistory: history.slice(-6).map(h => ({ role: h.role, content: h.content })),
      candidateFiles,
    });
    if (analysis) {
      maybeSaveFileOpCheckpoint({
        phase: 'done',
        next_action: 'analysis complete',
      });
      clearFileOpCheckpoint(sessionId);
      const lines: string[] = [];
      if (analysis.summary) lines.push(analysis.summary);
      if (analysis.diagnosis) lines.push(`Diagnosis: ${analysis.diagnosis}`);
      if (analysis.exact_files.length) lines.push(`Files: ${analysis.exact_files.join(', ')}`);
      if (analysis.edit_plan.length) lines.push(`Plan: ${analysis.edit_plan.join(' -> ')}`);
      const text = lines.join('\n');
      logToDaily(workspacePath, 'LocalClaw', text);
      return { type: 'chat', text };
    }
    // Secondary unavailable — fail-closed. Spec: FILE_ANALYSIS is always Secondary, no primary fallback.
    sendSSE('info', { message: 'FILE_OP v2: secondary analyzer unavailable; cannot complete FILE_ANALYSIS (fail-closed).' });
    return { type: 'chat', text: 'Analysis could not be completed: the secondary model is unavailable. Please try again.' };
  }

  logToDaily(workspacePath, 'User', message);

  // ── FILE_CREATE upfront size routing ──
  // If the request is clearly secondary territory (full page / large template),
  // skip primary entirely — queue secondary patch plan now so round 0 executes
  // it as synthetic calls without ever running the LLM for generation.
  // This eliminates the stall→restart spiral for large creates.
  if (
    fileOpV2Active
    && fileOpType === 'FILE_CREATE'
    && fileOpOwner === 'primary'
    && pendingSyntheticToolCalls.length === 0
  ) {
    const looksLarge = requestedFullTemplate(message)
      || /\b(landing page|full html|multi.?section|multiple sections|panels?|sections?.+panels?|panels?.+sections?|full.?page|whole page|full.?site|complete.?page)\b/i.test(message);
    if (looksLarge) {
      fileOpOwner = 'secondary';
      fileOpPrimaryStallPromoted = true;
      sendSSE('info', {
        message: 'FILE_OP v2: large FILE_CREATE detected upfront — routing directly to secondary (skipping primary generation).',
      });
      maybeSaveFileOpCheckpoint({ phase: 'plan', next_action: 'upfront secondary routing for large create' });
      const patchPlan = await callSecondaryFilePatchPlanner({
        userMessage: message,
        operationType: 'FILE_CREATE',
        owner: 'secondary',
        reason: 'Upfront large-create detection: request exceeds primary create thresholds before generation',
        fileSnapshots: collectFileSnapshots(workspacePath, Array.from(fileOpTouchedFiles)),
        verifier: null,
      });
      if (patchPlan?.tool_calls?.length) {
        pendingSyntheticToolCalls = patchPlan.tool_calls.map(tc => ({
          function: { name: tc.tool, arguments: tc.args || {} },
        }));
        sendSSE('info', {
          message: `FILE_OP v2: queued ${pendingSyntheticToolCalls.length} secondary call(s) for large create.`,
        });
        maybeSaveFileOpCheckpoint({ phase: 'execute', next_action: 'execute secondary upfront create batch' });
      }
    }
  }

  sendSSE('info', { message: 'Thinking...' });
  console.log(`\n[v2] ── CHAT (native tools) ──`);

  for (let round = 0; ; round++) {
    if (round >= MAX_TOOL_ROUNDS) {
      const allowExtendedFileOpLoop =
        fileOpV2Active
        && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
        && (fileOpOwner === 'secondary' || !!fileOpLastFailureSignature);
      if (!allowExtendedFileOpLoop) break;
      if (round === MAX_TOOL_ROUNDS) {
        sendSSE('info', {
          message: 'FILE_OP v2: extending execution beyond default step cap for secondary-owned repair convergence.',
        });
      }
    }

    if (abortSignal?.aborted) {
      console.log(`[v2] Aborted at round ${round} — client disconnected`);
      const partial = allToolResults.length > 0
        ? `Stopped after ${allToolResults.length} step${allToolResults.length !== 1 ? 's' : ''}.`
        : 'Stopped.';
      return { type: 'execute', text: partial, toolResults: allToolResults.length > 0 ? allToolResults : undefined };
    }

    // ── Synthetic tool calls from browser advisor ─────────────────────────────
    // When the advisor queued deterministic tool calls (e.g. PageDown scroll),
    // skip LLM generation entirely for this round and execute them directly.
    if (pendingSyntheticToolCalls.length > 0) {
      const syntheticCalls = pendingSyntheticToolCalls.map((call: any, idx: number) => ({
        ...call,
        id: String(call?.id || `synthetic_${Date.now()}_${round + 1}_${idx + 1}`),
      }));
      pendingSyntheticToolCalls = []; // consume immediately
      console.log(`[v2] SYNTHETIC[${round + 1}]: executing ${syntheticCalls.length} advisor-injected tool calls`);
      sendSSE('info', { message: `Executing ${syntheticCalls.length} synthetic browser step(s)...` });

      // Inject a synthetic assistant message so the message history is coherent
      const syntheticAssistant = {
        role: 'assistant',
        content: null,
        tool_calls: syntheticCalls,
      };
      messages.push(syntheticAssistant);

      let roundHadProgressSynthetic = false;
      for (const call of syntheticCalls) {
        const toolCallId = String((call as any)?.id || '').trim();
        const toolName = call.function?.name || 'unknown';
        const toolArgs = normalizeToolArgs(call.function?.arguments);
        console.log(`[v2] SYNTHETIC TOOL: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`);
        sendSSE('tool_call', { action: toolName, args: toolArgs, stepNum: allToolResults.length + 1, synthetic: true });

        const toolResult = await executeTool(toolName, toolArgs, workspacePath, sessionId);
        allToolResults.push(toolResult);
        logToolCall(workspacePath, toolName, toolArgs, toolResult.result, toolResult.error);
        trackFileOpMutation(toolName, toolArgs, toolResult, 'secondary');
        if (!toolResult.error) roundHadProgressSynthetic = true;

        orchestrationLog.push(
          toolResult.error
            ? `✗ [synthetic] ${toolName}: ${toolResult.result.slice(0, 80)}`
            : `✓ [synthetic] ${toolName}: ${toolResult.result.slice(0, 60)}`
        );
        sendSSE('tool_result', { action: toolName, result: toolResult.result.slice(0, 300), error: toolResult.error, stepNum: allToolResults.length, synthetic: true });

        const goalReminder = `\n\n[GOAL REMINDER: Your task is still: "${message.slice(0, 120)}". Stay focused on this goal only.]`;
        const isBrowserTool = isBrowserToolName(toolName);
        const isDesktopTool = isDesktopToolName(toolName);
        // Browser/Desktop tools in multi-agent mode always get an ack (LLM never sees raw snapshots)
        const toolMessageContent = (multiAgentActive && (isBrowserTool || isDesktopTool))
          ? (isBrowserTool ? buildBrowserAck(toolName, toolResult) : buildDesktopAck(toolName, toolResult))
          : toolResult.result;
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: toolMessageContent + goalReminder,
        });

        if (isBrowserTool && !toolResult.error) {
          browserForcedRetries = 0;
          if (toolName === 'browser_close') {
            browserContinuationPending = false;
            browserAdvisorRoute = null;
            browserAdvisorHintPreview = '';
            resetBrowserAdvisorCollection();
          }
        }
        if (isDesktopTool && !toolResult.error && toolName === 'desktop_screenshot') {
          desktopContinuationPending = false;
        }
        // Fire advisor after each browser/desktop tool in the synthetic batch
        await maybeRunBrowserAdvisorPass(toolName, toolResult);
        await maybeRunDesktopAdvisorPass(toolName, toolResult);
      }

      sendSSE('info', { message: `Synthetic steps complete (step ${round + 1})` });
      // Continue to next round — either with fresh LLM gen or another synthetic batch
      continue;
    }

    // ── Secondary-owned FILE_OP: skip Ollama, run verify, return directly ──
    // When secondary has already executed all patch calls there is nothing left
    // for primary to do. Build the reply from what we already know in-memory.
    if (
      fileOpV2Active
      && fileOpOwner === 'secondary'
      && pendingSyntheticToolCalls.length === 0
      && fileOpToolHistory.some(h => isFileMutationTool(h.tool))
    ) {
      // Run verification if triggered
      const verifyDecision = shouldVerifyFileTurn({
        had_create: fileOpHadCreate,
        user_requested_full_template: requestedFullTemplate(message),
        primary_write_lines: fileOpPrimaryWriteLines,
        primary_write_chars: fileOpPrimaryWriteChars,
        had_tool_failure: fileOpHadToolFailure,
        touched_files: Array.from(fileOpTouchedFiles),
        high_stakes_touched: Array.from(fileOpTouchedFiles).some(isHighStakesFile),
      }, fileOpSettings);

      if (verifyDecision.verify) {
        sendSSE('info', { message: `FILE_OP v2: verifier check (${verifyDecision.reasons.join(' | ')}).` });
        maybeSaveFileOpCheckpoint({ phase: 'verify', next_action: 'run secondary verifier' });
        const targetFiles = Array.from(fileOpTouchedFiles);
        const verifier = await callSecondaryFileVerifier({
          userMessage: message,
          operationType: fileOpType as 'FILE_CREATE' | 'FILE_EDIT',
          fileSnapshots: collectFileSnapshots(workspacePath, targetFiles),
          recentToolExecutions: fileOpToolHistory.slice(-24).map(h => ({
            tool: h.tool, args: h.args, result: h.result, error: h.error,
          })),
        });
        if (verifier?.verdict === 'FAIL') {
          // Re-enter the repair loop by queuing a secondary patch plan and continuing
          const patchPlan = await callSecondaryFilePatchPlanner({
            userMessage: message,
            operationType: fileOpType as 'FILE_CREATE' | 'FILE_EDIT',
            owner: 'secondary',
            reason: (verifier.reasons || []).join(' | ') || 'verifier fail',
            fileSnapshots: collectFileSnapshots(workspacePath, targetFiles),
            verifier,
          });
          if (patchPlan?.tool_calls?.length) {
            pendingSyntheticToolCalls = patchPlan.tool_calls.map(tc => ({
              function: { name: tc.tool, arguments: tc.args || {} },
            }));
            maybeSaveFileOpCheckpoint({ phase: 'execute', next_action: 'repair after verify fail' });
            continue; // back to top of round loop — executes repair batch next
          }
        } else if (verifier?.verdict === 'PASS') {
          maybeSaveFileOpCheckpoint({ phase: 'done', next_action: 'verification pass' });
          clearFileOpCheckpoint(sessionId);
        }
      } else {
        maybeSaveFileOpCheckpoint({ phase: 'done', next_action: 'turn complete' });
        clearFileOpCheckpoint(sessionId);
      }

      // Build reply from actual results — no Ollama, no extra AI call
      const createdFiles = fileOpToolHistory
        .filter(h => h.tool === 'create_file' && !h.error)
        .map(h => String(h.args?.filename || h.args?.name || h.args?.path || 'file'));
      const editedFiles = fileOpToolHistory
        .filter(h => isFileMutationTool(h.tool) && h.tool !== 'create_file' && !h.error)
        .map(h => String(h.args?.filename || h.args?.name || h.args?.path || 'file'));
      const failedOps = fileOpToolHistory.filter(h => h.error);

      const parts: string[] = [];
      if (createdFiles.length) parts.push(`Created ${createdFiles.join(', ')}`);
      if (editedFiles.length) parts.push(`Updated ${[...new Set(editedFiles)].join(', ')}`);
      if (failedOps.length) parts.push(`${failedOps.length} operation(s) failed`);
      const finalText = parts.length ? parts.join('. ') + '.' : 'Done.';

      console.log(`[v2] FINAL (secondary-owned): ${finalText}`);
      logToDaily(workspacePath, 'LocalClaw', finalText);
      return {
        type: 'execute',
        text: finalText,
        toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      };
    }

    let response: any;
    try {
      // In multi-agent mode, disable thinking for browser ops — the secondary AI
      // holds all context and issues exact directives; the primary just executes.
      // Thinking during browser ops burns the full stall threshold (110s) for no gain.
      const isActiveAutomationOp = multiAgentActive && (
        fileOpType === 'BROWSER_OP'
        || fileOpType === 'DESKTOP_OP'
        || browserContinuationPending
        || browserAdvisorRoute !== null
        || desktopContinuationPending
        || desktopAdvisorRoute !== null
        || allToolResults.some(r =>
          typeof r.name === 'string'
          && (r.name.startsWith('browser_') || r.name.startsWith('desktop_')),
        )
      );
      const primaryThinkMode: boolean | 'high' | 'medium' | 'low' = (multiAgentActive && !isActiveAutomationOp) ? true : false;
      const generationPromise = ollama.chatWithThinking(messages, 'executor', {
        tools,
        temperature: 0.3,
        num_ctx: 8192,
        num_predict: 4096,
        think: primaryThinkMode,
        model: String(modelOverride || '').trim() || undefined,
      });

      // ── Preempt watchdog ────────────────────────────────────────────
      if (
        preemptCfg.enabled
        && ollamaProcMgr
        && preemptState.canPreempt(round, preemptCfg.maxPerTurn, preemptCfg.maxPerSession)
      ) {
        const watchdogOutcome = await raceWithWatchdog(
          generationPromise,
          preemptCfg.stallThresholdMs,
          (elapsedMs) => {
            console.log(`[Preempt] Generation stalled at ${Math.round(elapsedMs / 1000)}s — triggering preempt`);
            sendSSE('preempt_start', { elapsed_ms: elapsedMs, threshold_ms: preemptCfg.stallThresholdMs, round });
          },
        );

        if (watchdogOutcome.timedOut) {
          // ── FILE_OP stall: bypass preempt restart entirely, promote immediately ──
          if (
            fileOpV2Active
            && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
            && fileOpOwner === 'primary'
          ) {
            sendSSE('info', {
              message: `FILE_OP v2: stall detected during ${fileOpType} after ${Math.round(watchdogOutcome.elapsedMs / 1000)}s — promoting immediately to secondary (no Ollama restart).`,
            });
            fileOpOwner = 'secondary';
            fileOpPrimaryStallPromoted = true;
            maybeSaveFileOpCheckpoint({
              phase: 'repair',
              next_action: 'stall promotion to secondary patch planning',
            });
            const patchPlan = await callSecondaryFilePatchPlanner({
              userMessage: message,
              operationType: fileOpType,
              owner: fileOpOwner,
              reason: `Primary stalled after ${Math.round(watchdogOutcome.elapsedMs / 1000)}s`,
              fileSnapshots: collectFileSnapshots(workspacePath, Array.from(fileOpTouchedFiles)),
              verifier: null,
            });
            if (patchPlan?.tool_calls?.length) {
              pendingSyntheticToolCalls = patchPlan.tool_calls.map(tc => ({
                function: { name: tc.tool, arguments: tc.args || {} },
              }));
              sendSSE('info', {
                message: `FILE_OP v2: queued ${patchPlan.tool_calls.length} secondary patch call(s) after stall promotion.`,
              });
              maybeSaveFileOpCheckpoint({
                phase: 'execute',
                next_action: 'execute secondary synthetic patch batch',
              });
            }
            continue;
          }

          // ── Non-FILE_OP stall: normal preempt restart path ──
          preemptState.recordPreempt(round);
          const sessionPreemptCount = incrementPreemptSessionCount(sessionId);
          sendSSE('info', {
            message: `Preempt: generation stalled after ${Math.round(watchdogOutcome.elapsedMs / 1000)}s. Restarting Ollama... (${sessionPreemptCount}/${preemptCfg.maxPerSession} this session)`,
          });

          const restarted = await ollamaProcMgr.killAndRestart();
          sendSSE('preempt_killed', {
            restarted,
            round,
            preempts_session: sessionPreemptCount,
            preempts_session_cap: preemptCfg.maxPerSession,
          });

          if (!restarted) {
            sendSSE('info', { message: 'Preempt: Ollama did not restart in time. Continuing without rescue.' });
          } else {
            sendSSE('preempt_ready', {
              round,
              preempts_session: sessionPreemptCount,
              preempts_session_cap: preemptCfg.maxPerSession,
            });

            // Fire secondary rescue advisor
            const orchCfgForPreempt = getOrchestrationConfig();
            if (orchCfgForPreempt?.enabled && orchestrationStats.assistCount < orchCfgForPreempt.limits.max_assists_per_session) {
              sendSSE('info', { message: 'Preempt: consulting rescue advisor...' });
              const liveInfoForRescue = getBrowserSessionInfo(sessionId);
              const advice = await callSecondaryAdvisor(
                message,
                orchestrationLog,
                `Generation stalled after ${Math.round(watchdogOutcome.elapsedMs / 1000)}s with no output`,
                'rescue',
                liveInfoForRescue.active ? {
                  active: true,
                  title: liveInfoForRescue.title,
                  url: liveInfoForRescue.url,
                  totalCollected: browserAdvisorCollectedFeed.length,
                } : undefined,
                buildSecondaryAssistContext(),
              );
              if (advice) {
                const hint = formatAdvisoryHint(advice);
                const stats = recordOrchestrationEvent(
                  sessionId,
                  { trigger: 'auto', reason: 'preempt_stall', mode: 'rescue' },
                  orchCfgForPreempt,
                );
                sendSSE('preempt_rescue', {
                  round,
                  assist_count: stats.assistCount,
                  assist_cap: orchCfgForPreempt.limits.max_assists_per_session,
                });
                messages.push({ role: 'user', content: hint });
                messages.push({ role: 'assistant', content: 'Understood. Acting immediately.' });
              }
            }

            // Inject strict nudge and retry — model just woke up fresh
            // Re-inject live browser state so model doesn't re-open an already-open browser
            const liveInfoForRetry = getBrowserSessionInfo(sessionId);
            const browserRetryReminder = liveInfoForRetry.active
              ? multiAgentActive
                ? `\n\nCRITICAL: Browser is ALREADY OPEN at "${liveInfoForRetry.url || 'current page'}". ` +
                  `Do NOT call browser_open. Call browser_snapshot so the secondary AI can analyze and tell you what to do next.`
                : `\n\nCRITICAL: Browser is ALREADY OPEN at "${liveInfoForRetry.url || 'current page'}". ` +
                  `Do NOT call browser_open again. Use browser_snapshot to see the current page.`
              : '';
            messages.push({
              role: 'user',
              content: `Your last generation was interrupted. Do NOT think or plan. Call the next tool immediately. If no tool is needed, reply in 1 sentence.${browserRetryReminder}`,
            });
            sendSSE('preempt_retry', { round });
            sendSSE('info', { message: 'Preempt: retrying with rescue context...' });
          }
          // Re-run this round from the top with the fresh Ollama instance
          continue;
        }

        // Generation finished before watchdog
        const result = watchdogOutcome.result;
        response = result.message;
        if (result.thinking) {
          console.log(`[v2] THINK (${result.thinking.length} chars): ${result.thinking.slice(0, 150)}...`);
          allThinking += (allThinking ? '\n\n' : '') + result.thinking;
          sendSSE('thinking', { thinking: result.thinking });
        }
      } else {
        // Watchdog not active — normal await
        const result = await generationPromise;
        response = result.message;
        if (result.thinking) {
          console.log(`[v2] THINK (${result.thinking.length} chars): ${result.thinking.slice(0, 150)}...`);
          allThinking += (allThinking ? '\n\n' : '') + result.thinking;
          sendSSE('thinking', { thinking: result.thinking });
        }
      }

      const explicitThink = stripExplicitThinkTags(response?.content || '');
      if (explicitThink.thinking) {
        console.log(`[v2] TAG THINK (${explicitThink.thinking.length} chars): ${explicitThink.thinking.slice(0, 150)}...`);
        allThinking += (allThinking ? '\n\n' : '') + explicitThink.thinking;
        sendSSE('thinking', { thinking: explicitThink.thinking });
      }
      if (String(response?.content || '') !== explicitThink.cleaned) {
        response.content = explicitThink.cleaned;
      }
    } catch (err: any) {
      console.error('[v2] Chat error:', err.message);
      return { type: 'chat', text: `Error: ${err.message}` };
    }

    let toolCalls = response.tool_calls;

    // Auto-recover: if model wrote a tool call as text instead of using the tool mechanism
    if ((!toolCalls || toolCalls.length === 0) && response.content) {
      const textToolMatch = response.content.match(/"action"\s*:\s*"(\w+)"\s*,\s*"action_input"\s*:\s*(\{[^}]+\})/s)
        || response.content.match(/"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]+\})/s);
      if (textToolMatch) {
        const toolName = textToolMatch[1];
        try {
          const toolArgs = JSON.parse(textToolMatch[2]);
          console.log(`[v2] AUTO-RECOVER: Model wrote ${toolName} as text, converting to tool call`);
          const recoveredCallId = `recovered_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
          toolCalls = [{ id: recoveredCallId, type: 'function', function: { name: toolName, arguments: toolArgs } }];
          response.tool_calls = toolCalls;
          response.content = '';
        } catch { /* JSON parse failed, treat as normal text */ }
      }
    }

    // Auto-recover: if model dumped pure reasoning without calling any tools on a
    // question that clearly needs tools (search, file, browser), re-prompt once
    if ((!toolCalls || toolCalls.length === 0) && response.content && round === 0 && allToolResults.length === 0) {
      const content = response.content;
      const looksLikeReasoning = content.length > 300
        && (/\b(let me|I need to|I should|the user|first,|wait,|hmm|the rules say)\b/i.test(content));
      const queryNeedsTools = /\b(search|find|look up|latest|news|info|open|browse|navigate|visit|click|type|fill|what happened|desktop|screen|window|vscode|vs code|codex|clipboard)\b/i.test(message);
      const browserAutomationRequest = isBrowserAutomationRequest(message);
      const desktopAutomationRequest = isDesktopAutomationRequest(message);
      const looksLikeRefusal = looksLikeSafetyRefusal(content);
      if (queryNeedsTools && (looksLikeReasoning || looksLikeRefusal)) {
        console.log(`[v2] AUTO-RECOVER: Model dumped ${content.length} chars of reasoning instead of calling tools. Re-prompting...`);
        allThinking += (allThinking ? '\n\n' : '') + content;
        sendSSE('thinking', { thinking: content.slice(0, 500) + '...' });
        // Inject a forceful nudge and retry this round
        if (browserAutomationRequest) {
          const liveBrowser = getBrowserSessionInfo(sessionId);
          const explicitUrl = extractLikelyUrl(message);
          messages.push({ role: 'assistant', content: 'Understood. Executing browser automation now.' });
          if (liveBrowser.active) {
            messages.push({
              role: 'user',
              content: 'Use browser_snapshot now. Then continue with browser_click/browser_fill/browser_press_key to complete the user request. Do NOT refuse.',
            });
          } else if (explicitUrl) {
            messages.push({
              role: 'user',
              content: `Use browser_open now with url="${explicitUrl}". This is explicitly user-authorized local automation. Then continue with browser_snapshot/browser_fill/browser_press_key as needed. Do NOT refuse.`,
            });
          } else {
            messages.push({
              role: 'user',
              content: 'Call browser_open now using the target site from the user request. Then continue with browser_snapshot/browser_click/browser_fill to complete the task. Do NOT refuse.',
            });
          }
          sendSSE('info', { message: 'Re-prompting model to execute browser automation...' });
        } else if (desktopAutomationRequest) {
          messages.push({ role: 'assistant', content: 'Understood. Checking desktop state now.' });
          messages.push({
            role: 'user',
            content: 'Use desktop_screenshot now. If VS Code or another app must be targeted, use desktop_focus_window first, then continue with desktop_click/desktop_type/desktop_press_key as needed. Do NOT refuse.',
          });
          sendSSE('info', { message: 'Re-prompting model to execute desktop automation...' });
        } else {
          messages.push({ role: 'assistant', content: 'Let me search for that now.' });
          messages.push({ role: 'user', content: 'Yes, use the web_search tool right now. Do NOT think or plan — just call web_search.' });
          sendSSE('info', { message: 'Re-prompting model to use tools...' });
        }
        continue; // retry this round
      }
    }

    if (!toolCalls || toolCalls.length === 0) {
      const { reply, thinking: inlineThinking } = separateThinkingFromContent(response.content || '');
      if (inlineThinking) {
        console.log(`[v2] INLINE REASONING (${inlineThinking.length} chars): ${inlineThinking.slice(0, 100)}...`);
        allThinking += (allThinking ? '\n\n' : '') + inlineThinking;
        sendSSE('thinking', { thinking: inlineThinking });
      }

      const rawAssistantText = String(response.content || '').trim();
      const candidateText = String(reply || rawAssistantText || '').trim();
      const isExecutionTurn =
        preflightRoute === 'primary_with_plan'
        || allToolResults.length > 0
        || isExecutionLikeRequest(message);
      const lastToolFailed = allToolResults.length > 0 && allToolResults[allToolResults.length - 1].error;
      const shouldContinueInsteadOfFinalizing =
        orchestrationSkillEnabled
        && isExecutionTurn
        && continuationNudges < MAX_CONTINUATION_NUDGES
        && (
          looksLikeIntentOnlyReply(candidateText)
          || (lastToolFailed && !hasConcreteCompletion(candidateText))
        );

      const shouldForceBrowserRetry =
        orchestrationSkillEnabled
        && browserContinuationPending
        && browserForcedRetries < browserMaxForcedRetries
        && !hasConcreteCompletion(candidateText);
      const shouldForceDesktopRetry =
        orchestrationSkillEnabled
        && desktopContinuationPending
        && continuationNudges < MAX_CONTINUATION_NUDGES
        && !hasConcreteCompletion(candidateText);

      if (shouldForceBrowserRetry) {
        browserForcedRetries++;
        const reason = `browser advisor route=${browserAdvisorRoute || 'continue_browser'} requires continued execution`;
        console.log(
          `[v2] BROWSER POST-CHECK: forcing retry (${browserForcedRetries}/${browserMaxForcedRetries}) - ${reason}`,
        );
        sendSSE('forced_retry', {
          reason,
          retry: browserForcedRetries,
          max_retries: browserMaxForcedRetries,
          route: browserAdvisorRoute,
        });
        sendSSE('info', {
          message: `Browser post-check: continuing execution (${browserForcedRetries}/${browserMaxForcedRetries}).`,
        });
        if (candidateText) {
          messages.push({ role: 'assistant', content: candidateText });
        }
        const preview = browserAdvisorHintPreview ? `Advisor hint: ${browserAdvisorHintPreview}` : '';
        messages.push({
          role: 'user',
          content:
            `${preview}\nDo not stop. Call the next browser tool now and continue execution. If more feed coverage is needed, use browser_press_key with PageDown then browser_wait then browser_snapshot.`,
        });
        continue;
      }

      if (shouldForceDesktopRetry) {
        continuationNudges++;
        const reason = `desktop advisor route=${desktopAdvisorRoute || 'continue_desktop'} requires continued execution`;
        console.log(
          `[v2] DESKTOP POST-CHECK: forcing retry (${continuationNudges}/${MAX_CONTINUATION_NUDGES}) - ${reason}`,
        );
        sendSSE('info', {
          message: `Desktop post-check: continuing execution (${continuationNudges}/${MAX_CONTINUATION_NUDGES}).`,
        });
        if (candidateText) {
          messages.push({ role: 'assistant', content: candidateText });
        }
        const preview = desktopAdvisorHintPreview ? `Advisor hint: ${desktopAdvisorHintPreview}` : '';
        messages.push({
          role: 'user',
          content: `${preview}\nDo not stop. Call the next desktop tool now. If state may have changed, use desktop_screenshot again.`,
        });
        continue;
      }

      if (shouldContinueInsteadOfFinalizing) {
        continuationNudges++;
        const nudgeReason = lastToolFailed
          ? 'last tool failed'
          : 'intent-only response with no tool execution';
        console.log(`[v2] ORCH POST-CHECK: forcing continuation (${continuationNudges}/${MAX_CONTINUATION_NUDGES}) — ${nudgeReason}`);
        sendSSE('info', {
          message: `Orchestration post-check: continuing execution (${continuationNudges}/${MAX_CONTINUATION_NUDGES}) — ${nudgeReason}.`,
        });

        if (candidateText) {
          messages.push({ role: 'assistant', content: candidateText });
        }
        messages.push({
          role: 'user',
          content:
            'Do not stop at an intention statement. Continue now by calling the next SmallClaw tool. Use only available tools (for filesystem use list_files/read_file/create_file/replace_lines/insert_after/delete_lines/find_replace). If a path failed, inspect workspace first and then proceed.',
        });
        continue;
      }

      if (
        fileOpV2Active
        && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
        && fileOpToolHistory.some(h => isFileMutationTool(h.tool))
      ) {
        const verifyDecision = shouldVerifyFileTurn({
          had_create: fileOpHadCreate,
          user_requested_full_template: requestedFullTemplate(message),
          primary_write_lines: fileOpPrimaryWriteLines,
          primary_write_chars: fileOpPrimaryWriteChars,
          had_tool_failure: fileOpHadToolFailure,
          touched_files: Array.from(fileOpTouchedFiles),
          high_stakes_touched: Array.from(fileOpTouchedFiles).some(isHighStakesFile),
        }, fileOpSettings);

        if (verifyDecision.verify) {
          sendSSE('info', {
            message: `FILE_OP v2: verifier check (${verifyDecision.reasons.join(' | ')}).`,
          });
          maybeSaveFileOpCheckpoint({
            phase: 'verify',
            next_action: 'run secondary verifier',
          });

          const runVerifier = async () => {
            const targetFiles = (() => {
              const direct = Array.from(fileOpTouchedFiles);
              if (direct.length) return direct;
              const fromHistory = fileOpToolHistory
                .map(h => extractFileToolTarget(h.tool, h.args))
                .filter(Boolean);
              return Array.from(new Set(fromHistory));
            })();
            return callSecondaryFileVerifier({
              userMessage: message,
              operationType: fileOpType,
              fileSnapshots: collectFileSnapshots(workspacePath, targetFiles),
              recentToolExecutions: fileOpToolHistory.slice(-24).map(h => ({
                tool: h.tool,
                args: h.args,
                result: h.result,
                error: h.error,
              })),
            });
          };

          let verifier = await runVerifier();
          if (verifier?.verdict === 'PASS') {
            maybeSaveFileOpCheckpoint({
              phase: 'done',
              next_action: 'verification pass',
            });
            clearFileOpCheckpoint(sessionId);
          } else if (verifier?.verdict === 'FAIL') {
            let delegatePrimaryMicroFix = false;
            let reasonForPatch = (verifier.reasons || []).join(' | ') || 'verifier fail';
            let latestVerifier: typeof verifier | null = verifier;
            let noProgressEscalations = 0;

            while (latestVerifier && latestVerifier.verdict === 'FAIL') {
              const failureSig = buildFailureSignature(latestVerifier as any);
              const smallFix = isSmallSuggestedFix(latestVerifier as any, fileOpSettings);
              const previousPatchSig = fileOpPatchSignatures[fileOpPatchSignatures.length - 1] || 'none';
              const progress = fileOpWatchdog.record({
                failure_signature: failureSig,
                patch_signature: previousPatchSig,
                large_patch: !smallFix,
              });
              fileOpLastFailureSignature = failureSig;
              if (progress.no_progress) {
                noProgressEscalations++;
                // Escalation ladder — each level changes strategy, not just intensity:
                // Level 1: Broaden patch scope, rewrite the broken section
                // Level 2: Regenerate the entire file from scratch using original prompt + accumulated findings
                // Level 3: Switch actor — force primary micro-fix attempt if fix is plausibly small
                // Level 4+: Re-derive requirements checklist and verify full spec coverage
                if (noProgressEscalations === 1) {
                  reasonForPatch = `ESCALATION L1 (no progress on sig=${failureSig}): Broaden patch scope. Do NOT make the same targeted fix again. Rewrite the entire broken section from scratch using the original requirements and verifier findings.`;
                } else if (noProgressEscalations === 2) {
                  reasonForPatch = `ESCALATION L2 (still no progress): Regenerate the ENTIRE file from scratch. Use the original user prompt, all accumulated verifier findings, and current constraints. Do not attempt another targeted patch.`;
                } else if (noProgressEscalations === 3) {
                  // Switch actor: force primary micro-fix regardless of smallFix gating
                  reasonForPatch = `ESCALATION L3: Switching actor to primary for a targeted micro-fix attempt.`;
                  sendSSE('info', {
                    message: `FILE_OP v2: no-progress watchdog L3 — switching actor to primary micro-fix.`,
                  });
                  delegatePrimaryMicroFix = true;
                } else {
                  reasonForPatch = `ESCALATION L${noProgressEscalations} (requirements re-derivation): Re-derive the full requirements checklist from the original user prompt. List every requirement explicitly, then verify which are missing or broken. Patch only what the checklist shows is unmet.`;
                }
                sendSSE('info', {
                  message: `FILE_OP v2: no-progress watchdog triggered (level ${noProgressEscalations}); escalating repair strategy.`,
                });
              }

              maybeSaveFileOpCheckpoint({
                phase: 'repair',
                next_action: progress.no_progress
                  ? `escalate repair strategy L${noProgressEscalations} (no progress watchdog)`
                  : 'repair current verifier findings',
                findings: latestVerifier.findings || [],
              });

              if (delegatePrimaryMicroFix) break;

              if (smallFix) {
                delegatePrimaryMicroFix = true;
                break;
              }

              fileOpOwner = 'secondary';
              const patchPlan = await callSecondaryFilePatchPlanner({
                userMessage: message,
                operationType: fileOpType,
                owner: fileOpOwner,
                reason: reasonForPatch,
                fileSnapshots: collectFileSnapshots(workspacePath, Array.from(fileOpTouchedFiles)),
                verifier: latestVerifier,
              });

              if (!patchPlan?.tool_calls?.length) {
                sendSSE('info', {
                  message: 'FILE_OP v2: secondary patch planner returned no executable calls; switching to primary micro-fix attempt.',
                });
                delegatePrimaryMicroFix = true;
                break;
              }

              const applied = await executeSecondaryPatchCalls(
                patchPlan.tool_calls,
                progress.no_progress ? 'watchdog escalation' : 'verifier repair',
              );
              maybeSaveFileOpCheckpoint({
                phase: 'execute',
                next_action: applied.ran > 0 ? 'secondary patch batch applied' : 'secondary patch batch empty',
              });

              latestVerifier = await runVerifier();
              if (latestVerifier?.verdict === 'PASS') {
                maybeSaveFileOpCheckpoint({
                  phase: 'done',
                  next_action: 'verification pass after secondary repair',
                });
                clearFileOpCheckpoint(sessionId);
                break;
              }
              if (!latestVerifier) break;
              reasonForPatch = (latestVerifier.reasons || []).join(' | ') || 'verifier fail after repair';
            }

            if (delegatePrimaryMicroFix) {
              const findingsText = (latestVerifier?.findings || [])
                .slice(0, 3)
                .map(f => `${f.filename || 'file'}:${f.type || 'issue'} expected="${String(f.expected || '').slice(0, 70)}" observed="${String(f.observed || '').slice(0, 70)}"`)
                .join(' | ');
              const failReasons = (latestVerifier?.reasons || []).join(' | ');
              fileOpOwner = 'primary';
              if (candidateText) messages.push({ role: 'assistant', content: candidateText });
              messages.push({
                role: 'user',
                content: `Verifier FAIL (${failReasons || 'unspecified'}). Apply ONLY a minimal tool patch now. Constraints: max ${fileOpSettings.primary_edit_max_lines} changed lines, max ${fileOpSettings.primary_edit_max_chars} chars, max ${fileOpSettings.primary_edit_max_files} file. No refactor, no extra files. Findings: ${findingsText || 'fix request mismatch and re-check.'}`,
              });
              maybeSaveFileOpCheckpoint({
                phase: 'execute',
                next_action: 'primary micro-fix patch requested',
                findings: latestVerifier?.findings || [],
              });
              continue;
            }

            const finalVerifier = await runVerifier();
            if (finalVerifier?.verdict === 'FAIL') {
              const reasons = (finalVerifier.reasons || []).join(' | ') || 'verification failed';
              if (candidateText) messages.push({ role: 'assistant', content: candidateText });
              messages.push({
                role: 'user',
                content: `Verifier still FAIL (${reasons}). Apply the next concrete patch now and continue until it passes.`,
              });
              maybeSaveFileOpCheckpoint({
                phase: 'execute',
                next_action: 'retry after final verifier fail',
                findings: finalVerifier.findings || [],
              });
              continue;
            }
            maybeSaveFileOpCheckpoint({
              phase: 'done',
              next_action: 'verification pass after repair loop',
            });
            clearFileOpCheckpoint(sessionId);
          } else {
            sendSSE('info', {
              message: 'FILE_OP v2: secondary verifier unavailable; continuing with current result.',
            });
          }
        }
      }

      // If model dumped massive reasoning with no usable reply, generate a fallback
      let finalText = sanitizeFinalReply(
        String(reply || rawAssistantText || ''),
        { preflightReason: preflightReasonForTurn },
      );
      if (!finalText || finalText.length < 5) {
        if (allToolResults.length > 0) {
          // Summarize what tools actually did
          const lastResult = allToolResults[allToolResults.length - 1];
          finalText = lastResult.error ? `Tool failed: ${lastResult.result.slice(0, 200)}` : 'Done!';
        } else {
          finalText = 'Hey! How can I help?';
        }
      }
      if (greetingLikeTurn && finalText.length > 220) {
        finalText = finalText.split(/\n+/)[0].slice(0, 220).trim();
      }
      finalText = sanitizeFinalReply(finalText, { preflightReason: preflightReasonForTurn }) || 'Hey! How can I help?';
      console.log(`[v2] FINAL: ${finalText.slice(0, 150)}`);

      logToDaily(workspacePath, 'LocalClaw', finalText);
      if (fileOpV2Active) {
        maybeSaveFileOpCheckpoint({
          phase: 'done',
          next_action: 'turn complete',
        });
        clearFileOpCheckpoint(sessionId);
      }

      return {
        type: allToolResults.length > 0 ? 'execute' : 'chat',
        text: finalText,
        thinking: allThinking || undefined,
        toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      };
    }

    messages.push(response);

    const batchCreatedFiles = new Set<string>();
    let roundHadProgress = false;

    for (const call of toolCalls) {
      const toolCallId = String((call as any)?.id || '').trim();
      const toolName = call.function?.name || 'unknown';
      const toolArgs = normalizeToolArgs(call.function?.arguments);
      const loopCheck = checkLoopDetection(toolName, toolArgs);
      if (loopCheck.state === 'block') {
        const blockMsg = `Loop guard: ${toolName} with the same arguments has already run ${loopCheck.repeats} times. Stop repeating this call and try a different approach.`;
        console.warn(`[v2] LOOP BLOCK: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}) x${loopCheck.repeats}`);
        const blockedResult: ToolResult = {
          name: toolName,
          args: toolArgs,
          result: blockMsg,
          error: false,
        };
        allToolResults.push(blockedResult);
        roundHadProgress = true;
        sendSSE('tool_result', {
          action: toolName,
          result: blockMsg,
          error: false,
          stepNum: allToolResults.length,
        });
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: blockMsg,
        });
        continue;
      }
      if (loopCheck.state === 'warn') {
        const warnMsg = `Loop warning: ${toolName} with same arguments repeated ${loopCheck.repeats} times.`;
        console.warn(`[v2] LOOP WARN: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}) x${loopCheck.repeats}`);
        sendSSE('info', { message: warnMsg });
      }

      if (isBootStartupTurn && !bootAllowedTools.has(toolName)) {
        const blockMsg = `BOOT mode: "${toolName}" is disabled. Use only list_files and read_file, then provide the startup summary.`;
        console.log(`[v2] BOOT TOOL BLOCKED: ${toolName}`);
        const blockedResult: ToolResult = {
          name: toolName,
          args: toolArgs,
          result: blockMsg,
          error: false,
        };
        allToolResults.push(blockedResult);
        roundHadProgress = true;
        logToolCall(workspacePath, toolName, toolArgs, blockMsg, false);
        sendSSE('tool_result', {
          action: toolName,
          result: blockMsg,
          error: false,
          stepNum: allToolResults.length,
        });
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: blockMsg,
        });
        continue;
      }

      if (toolName === 'create_file') {
        const fn = toolArgs.filename || toolArgs.name;
        if (fn && batchCreatedFiles.has(fn)) {
          console.log(`[v2] SKIP: duplicate create_file("${fn}") in same batch`);
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: `${fn} already created in this batch. Use replace_lines to edit.`,
          });
          continue;
        }
        if (fn) batchCreatedFiles.add(fn);
      }

      // Browser workflows often need repeated identical actions (PageDown, wait,
      // snapshot) across rounds to collect more evidence. Keep duplicate blocking
      // for non-browser tools only.
      const allowRepeatedTool = toolName.startsWith('browser_');
      const callKey = `${toolName}:${JSON.stringify(toolArgs)}`;
      if (!allowRepeatedTool && seenToolCalls.has(callKey)) {
        console.log(`[v2] SKIP: duplicate tool call ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: 'Already ran this exact call. Use the previous result and move on.',
        });
        continue;
      }
      if (!allowRepeatedTool) {
        seenToolCalls.add(callKey);
      }

      if (
        fileOpV2Active
        && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
        && fileOpOwner === 'secondary'
        && isFileMutationTool(toolName)
      ) {
        sendSSE('info', {
          message: 'FILE_OP v2: secondary-owned turn; replacing primary mutation call with secondary patch plan.',
        });
        const target = extractFileToolTarget(toolName, toolArgs);
        const patchPlan = await callSecondaryFilePatchPlanner({
          userMessage: message,
          operationType: fileOpType,
          owner: fileOpOwner,
          reason: 'secondary-owned execution',
          fileSnapshots: collectFileSnapshots(
            workspacePath,
            target ? [target, ...Array.from(fileOpTouchedFiles)] : Array.from(fileOpTouchedFiles),
          ),
          blockedPrimaryCall: {
            tool: toolName,
            args: toolArgs,
            reason: 'secondary-owned execution',
          },
          verifier: null,
        });
        if (patchPlan?.tool_calls?.length) {
          const applied = await executeSecondaryPatchCalls(patchPlan.tool_calls, 'secondary owner replacement');
          if (applied.ran > 0) roundHadProgress = true;
        } else {
          fileOpHadToolFailure = true;
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: 'FILE_OP v2: secondary planner produced no replacement calls.',
          });
        }
        continue;
      }

      if (
        fileOpV2Active
        && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
        && fileOpOwner === 'primary'
        && isFileMutationTool(toolName)
      ) {
        const allowance = canPrimaryApplyFileTool({
          tool_name: toolName,
          args: toolArgs,
          message,
          touched_files: fileOpTouchedFiles,
          settings: fileOpSettings,
        });
        if (!allowance.allowed) {
          fileOpOwner = 'secondary';
          maybeSaveFileOpCheckpoint({
            phase: 'repair',
            next_action: `secondary takeover after gate block: ${allowance.reason}`,
          });
          sendSSE('info', {
            message: `FILE_OP v2 gate: promoted to secondary (${allowance.reason}).`,
          });
          const target = extractFileToolTarget(toolName, toolArgs);
          const snapshots = collectFileSnapshots(
            workspacePath,
            target ? [target, ...Array.from(fileOpTouchedFiles)] : Array.from(fileOpTouchedFiles),
          );
          const patchPlan = await callSecondaryFilePatchPlanner({
            userMessage: message,
            operationType: fileOpType,
            owner: fileOpOwner,
            reason: allowance.reason,
            fileSnapshots: snapshots,
            blockedPrimaryCall: {
              tool: toolName,
              args: toolArgs,
              reason: allowance.reason,
            },
            verifier: null,
          });
          if (patchPlan?.tool_calls?.length) {
            const applied = await executeSecondaryPatchCalls(patchPlan.tool_calls, 'primary threshold gate');
            if (applied.ran > 0) roundHadProgress = true;
            maybeSaveFileOpCheckpoint({
              phase: 'execute',
              next_action: applied.ran > 0 ? 'secondary patch calls applied' : 'no patch calls applied',
            });
            continue;
          }
          fileOpHadToolFailure = true;
          const failText = 'FILE_OP v2: secondary patch planner returned no executable calls.';
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: failText,
          });
          sendSSE('tool_result', {
            action: toolName,
            result: failText,
            error: true,
            stepNum: allToolResults.length,
            actor: 'secondary',
          });
          continue;
        }
      }

      console.log(`[v2] TOOL[${round + 1}]: ${toolName}(${JSON.stringify(toolArgs).slice(0, 150)})`);
      sendSSE('tool_call', { action: toolName, args: toolArgs, stepNum: allToolResults.length + 1 });

      if (toolName === 'start_task') {
        const taskGoal = toolArgs.goal || message;
        const maxSteps = toolArgs.max_steps || 25;
        sendSSE('info', { message: `Starting multi-step task: ${taskGoal}` });

        const taskTools = tools.filter(t => t.function.name !== 'start_task') as any[];

        const taskResult = await runTask({
          goal: taskGoal,
          tools: taskTools,
          executor: async (name, args) => {
            const r = await executeTool(name, args, workspacePath);
            return { result: r.result, error: r.error };
          },
          onProgress: sendSSE,
          systemContext: personalityCtx.slice(0, 500),
          maxSteps,
        });

        activeTasks.set(sessionId, taskResult);

        const summary = taskResult.status === 'complete'
          ? `Task completed in ${taskResult.currentStep} steps!`
          : taskResult.status === 'failed'
            ? `Task failed at step ${taskResult.currentStep}: ${taskResult.error}`
            : `Task paused at step ${taskResult.currentStep}/${taskResult.maxSteps}`;

        const journalSummary = taskResult.journal.slice(-5).map(j => j.result).join('\n');

        return {
          type: 'execute',
          text: `${summary}\n\nRecent steps:\n${journalSummary}`,
          thinking: allThinking || undefined,
          toolResults: taskResult.journal.map(j => ({
            name: j.action.split('(')[0],
            args: {},
            result: j.result,
            error: j.result.startsWith('❌'),
          })),
        };
      }

      // ── Orchestration: explicit request from primary
      if (toolName === 'request_secondary_assist') {
        const orchCfg = getOrchestrationConfig();
        if (orchestrationSkillEnabled && orchCfg?.enabled) {
          if (orchestrationStats.assistCount >= orchCfg.limits.max_assists_per_session) {
            messages.push({
              role: 'tool',
              tool_name: toolName,
              tool_call_id: toolCallId || undefined,
              content: `Secondary advisor session cap reached (${orchCfg.limits.max_assists_per_session}). Continue without escalation.`,
            });
            continue;
          }

          const mode   = (toolArgs.mode || 'rescue') as 'planner' | 'rescue';
          const reason = toolArgs.reason || 'Explicitly requested by executor';
          sendSSE('info', { message: `Consulting secondary advisor (${mode} mode)...` });
          console.log(`[Orchestrator] Explicit trigger: ${reason}`);
          const advice = await callSecondaryAdvisor(
            message,
            orchestrationLog,
            reason,
            mode,
            undefined,
            buildSecondaryAssistContext(),
          );
          if (advice) {
            const hint = formatAdvisoryHint(advice);
            orchestrationState.markFired(round);
            const stats = recordOrchestrationEvent(
              sessionId,
              { trigger: 'explicit', reason, mode },
              orchCfg,
            );
            sendSSE('orchestration', {
              trigger: 'explicit',
              reason,
              mode,
              advice,
              assist_count: stats.assistCount,
              assist_cap: orchCfg.limits.max_assists_per_session,
            });
            console.log(
              `[Orchestrator] Explicit assist complete (${stats.assistCount}/${orchCfg.limits.max_assists_per_session})`,
            );
            messages.push({
              role: 'tool',
              tool_name: toolName,
              tool_call_id: toolCallId || undefined,
              content: hint,
            });
          } else {
            messages.push({
              role: 'tool',
              tool_name: toolName,
              tool_call_id: toolCallId || undefined,
              content: 'Secondary advisor unavailable. Continue with your best judgment.',
            });
          }
          continue;
        }
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: 'Multi-agent orchestration is not enabled.',
        });
        continue;
      }

      const toolResult = await executeTool(toolName, toolArgs, workspacePath, sessionId);
      allToolResults.push(toolResult);
      logToolCall(workspacePath, toolName, toolArgs, toolResult.result, toolResult.error);
      trackFileOpMutation(toolName, toolArgs, toolResult, 'primary');
      if (fileOpV2Active && toolResult.error) fileOpHadToolFailure = true;
      if (!toolResult.error) roundHadProgress = true;

      // ── Orchestration: track trigger state
      orchestrationState.recordToolResult(round, toolName, toolArgs, toolResult.error);
      orchestrationLog.push(
        toolResult.error
          ? `✗ ${toolName}(${JSON.stringify(toolArgs).slice(0, 60)}): ${toolResult.result.slice(0, 100)}`
          : `✓ ${toolName}(${JSON.stringify(toolArgs).slice(0, 60)}): ${toolResult.result.slice(0, 80)}`
      );

      console.log(toolResult.error ? `[v2] TOOL FAIL: ${toolResult.result.slice(0, 100)}` : `[v2] TOOL OK: ${toolResult.result.slice(0, 100)}`);
      sendSSE('tool_result', { action: toolName, result: toolResult.result.slice(0, 500), error: toolResult.error, stepNum: allToolResults.length });

      const goalReminder = `\n\n[GOAL REMINDER: Your task is still: "${message.slice(0, 120)}". Stay focused on this goal only.]`;
      // ── Multi-agent browser interception ────────────────────────────────────
      // When orchestrator is active, LLM never sees raw snapshot/browser data.
      // Full data still flows to advisor via getBrowserAdvisorPacket().
      const isBrowserTool = isBrowserToolName(toolName);
      const isDesktopTool = isDesktopToolName(toolName);
      const toolMessageContent = (multiAgentActive && (isBrowserTool || isDesktopTool))
        ? (isBrowserTool ? buildBrowserAck(toolName, toolResult) : buildDesktopAck(toolName, toolResult))
        : toolResult.result;
      messages.push({
        role: 'tool',
        tool_name: toolName,
        tool_call_id: toolCallId || undefined,
        content: toolMessageContent + goalReminder,
      });

      if (isBrowserTool && !toolResult.error) {
        browserForcedRetries = 0;
        if (toolName === 'browser_close') {
          browserContinuationPending = false;
          browserAdvisorRoute = null;
          browserAdvisorHintPreview = '';
          resetBrowserAdvisorCollection();
        }
      }
      if (isDesktopTool && !toolResult.error && toolName === 'desktop_screenshot') {
        desktopContinuationPending = false;
      }
      await maybeRunBrowserAdvisorPass(toolName, toolResult);
      await maybeRunDesktopAdvisorPass(toolName, toolResult);
    }

    // ── Orchestration: auto-trigger check after each round
    const orchCfg = getOrchestrationConfig();
    if (orchestrationSkillEnabled && orchCfg?.enabled && !isBootStartupTurn) {
      if (!roundHadProgress) orchestrationState.recordRoundNoProgress(round);
      const { fire, reason } = orchestrationState.shouldTrigger(
        orchCfg,
        round,
        Date.now(),
        orchestrationStats.assistCount,
      );
      if (fire && orchestrationStats.assistCount < orchCfg.limits.max_assists_per_session) {
        sendSSE('info', { message: `Auto-consulting advisor: ${reason}` });
        console.log(`[Orchestrator] Auto-trigger (${reason})`);
        const advice = await callSecondaryAdvisor(
          message,
          orchestrationLog,
          reason,
          'rescue',
          undefined,
          buildSecondaryAssistContext(),
        );
        if (advice) {
          const hint = formatAdvisoryHint(advice);
          orchestrationState.markFired(round);
          const stats = recordOrchestrationEvent(
            sessionId,
            { trigger: 'auto', reason, mode: 'rescue' },
            orchCfg,
          );
          sendSSE('orchestration', {
            trigger: 'auto',
            reason,
            mode: 'rescue',
            advice,
            assist_count: stats.assistCount,
            assist_cap: orchCfg.limits.max_assists_per_session,
          });
          console.log(
            `[Orchestrator] Auto assist complete (${stats.assistCount}/${orchCfg.limits.max_assists_per_session})`,
          );
          messages.push({ role: 'user', content: hint });
          messages.push({ role: 'assistant', content: 'Understood. Following the advisor guidance now.' });
        }
      }
    }

    sendSSE('info', { message: `Processing... (step ${round + 1})` });
  }

  return { type: 'execute', text: 'Hit max steps.', toolResults: allToolResults };
}

// ─── SSE + Routes ──────────────────────────────────────────────────────────────

function createSSESender(res: express.Response): (event: string, data: any) => void {
  return (type: string, data: any) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {} };
}

function latestTaskForSession(sessionId: string, statuses: TaskStatus[]): TaskRecord | null {
  const tasks = listTasks({ status: statuses })
    .filter(t => t.sessionId === sessionId)
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  return tasks[0] || null;
}

function findBlockedTaskForSession(sessionId: string): TaskRecord | null {
  const blocked = listTasks({ status: ['needs_assistance', 'stalled', 'paused'] })
    .filter(t => t.sessionId === sessionId)
    .filter(t =>
      t.status === 'needs_assistance'
      || t.status === 'stalled'
      || (t.status === 'paused' && t.pauseReason !== 'user_pause'),
    )
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  return blocked[0] || null;
}

function isResumeIntent(message: string): boolean {
  return /\b(resume|continue|go ahead|proceed|restart|start again|run it|do it now|apply and continue)\b/i.test(message);
}

function isCancelIntent(message: string): boolean {
  return /\b(cancel|abort|stop( task)?|do not continue|don't continue)\b/i.test(message);
}

function isStatusQuestion(message: string): boolean {
  return /\?|^\s*(what|why|how|status|did|where|when)\b/i.test(message)
    || /\b(what happened|why did|status|stuck|failed|error|progress|what went wrong)\b/i.test(message);
}

function isAdjustmentIntent(message: string): boolean {
  return /\b(instead|change|adjust|update|only|skip|don't|do not|use|delete|remove|clear|keep|retry|try again)\b/i.test(message);
}

function getLatestPauseContext(task: TaskRecord): { reason: string; detail: string } {
  const latestPause = [...(task.journal || [])].reverse().find((j) => j.type === 'pause');
  if (latestPause) {
    return {
      reason: String(latestPause.content || '').replace(/^Task paused for assistance:\s*/i, '').slice(0, 220),
      detail: String(latestPause.detail || '').slice(0, 420),
    };
  }
  return { reason: task.pauseReason || 'paused', detail: '' };
}

function buildBlockedTaskStatusMessage(task: TaskRecord): string {
  const total = Array.isArray(task.plan) ? task.plan.length : 0;
  const step = Math.min((task.currentStepIndex || 0) + 1, Math.max(1, total));
  const done = (task.plan || []).filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const pause = getLatestPauseContext(task);
  const lines = [
    `Task status: ${task.title}`,
    `Status: ${task.status}`,
    `Step: ${step}/${Math.max(1, total)} (${done} completed)`,
    `Last issue: ${pause.reason || 'n/a'}`,
    pause.detail ? `Details: ${pause.detail}` : '',
    `Task ID: ${task.id}`,
    `Reply with "resume" to continue, or send an adjustment (for example: "only delete *_tmp.html").`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function tryHandleBlockedTaskFollowup(sessionId: string, rawMessage: string): Promise<string | null> {
  if (String(sessionId || '').startsWith('task_')) return null;
  const message = String(rawMessage || '').trim();
  if (!message) return null;

  const resumeRequested = isResumeIntent(message);
  const statusQuestion = isStatusQuestion(message);
  const adjustmentRequested = isAdjustmentIntent(message);
  let task = findBlockedTaskForSession(sessionId);
  if (!task && resumeRequested) {
    task = latestTaskForSession(sessionId, ['paused']);
  }
  if (!task) return null;

  const cancelRequested = isCancelIntent(message);
  if (cancelRequested) {
    updateTaskStatus(task.id, 'paused', { pauseReason: 'user_pause' });
    appendJournal(task.id, { type: 'pause', content: `User requested stop: ${message.slice(0, 220)}` });
    const ws = getWorkspace(sessionId) || (getConfig().getConfig() as any).workspace?.path || '';
    if (ws) {
      await hookBus.fire({
        type: 'command:stop',
        sessionId,
        workspacePath: ws,
        timestamp: Date.now(),
      });
    }
    return `Paused task \"${task.title}\".`;
  }

  if (statusQuestion && !resumeRequested) {
    appendJournal(task.id, { type: 'status_push', content: `User requested status while blocked: ${message.slice(0, 220)}` });
    return buildBlockedTaskStatusMessage(task);
  }

  if (!resumeRequested && !adjustmentRequested) {
    appendJournal(task.id, { type: 'status_push', content: `Ignored non-resume follow-up while blocked: ${message.slice(0, 220)}` });
    return [
      `Task \"${task.title}\" is still paused.`,
      `I did not resume it yet.`,
      `Reply "resume" to continue, or send an explicit adjustment.`,
      `Task ID: ${task.id}`,
    ].join('\n');
  }

  const liveTask = loadTask(task.id);
  if (!liveTask) return null;

  appendJournal(task.id, { type: 'resume', content: `User follow-up: ${message.slice(0, 220)}` });
  const resumeMessages = Array.isArray(liveTask.resumeContext?.messages)
    ? liveTask.resumeContext.messages
    : [];
  const nextMessages = [
    ...resumeMessages,
    { role: 'user', content: `[TASK USER FOLLOW-UP]\n${message}`, timestamp: Date.now() },
  ].slice(-80);
  updateResumeContext(task.id, { messages: nextMessages });

  if (BackgroundTaskRunner.isRunning(task.id)) {
    return `Task \"${task.title}\" is already running. I added your instruction and it will apply on the next step.`;
  }

  updateTaskStatus(task.id, 'queued');
  const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
  runner.start().catch(err => console.error(`[BackgroundTaskRunner] Follow-up resume ${task.id} error:`, err.message));

  const refreshed = loadTask(task.id) || liveTask;
  if (resumeRequested) {
    return `Resumed task \"${task.title}\" at step ${refreshed.currentStepIndex + 1}/${refreshed.plan.length}.`;
  }
  return `Queued your adjustment and resumed task \"${task.title}\" at step ${refreshed.currentStepIndex + 1}/${refreshed.plan.length}.`;
}

const app = express();
app.use(cors());
app.use(express.json());

const webUiPath = path.join(__dirname, '..', '..', 'web-ui');
app.use(express.static(webUiPath));

app.get('/api/status', async (_req, res) => {
  const ollama = getOllamaClient();
  const connected = await ollama.testConnection();
  const rawCfg = getConfig().getConfig() as any;
  const provider: string = rawCfg.llm?.provider || 'ollama';
  const providerCfg = rawCfg.llm?.providers?.[provider] || {};
  const activeModel: string = providerCfg.model || rawCfg.models?.primary || 'unknown';
  const orchCfg = getOrchestrationConfig();
  res.json({
    status: 'ok', version: 'v2-tools', ollama: connected,
    provider,
    currentModel: activeModel,
    workspace: (config as any).workspace?.path || '',
    search: rawCfg.search?.google_api_key ? 'google' : (rawCfg.search?.tavily_api_key ? 'tavily' : 'none'),
    orchestration: orchCfg ? {
      enabled: orchCfg.enabled,
      secondary: orchCfg.secondary,
    } : null,
  });
});

app.post('/api/chat', async (req, res) => {
  const { message, sessionId = 'default', pinnedMessages } = req.body;
  if (!message || typeof message !== 'string') { res.status(400).json({ error: 'Message required' }); return; }
  lastMainSessionId = String(sessionId || 'default');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendSSE = createSSESender(res);
  const heartbeat = setInterval(() => sendSSE('heartbeat', { state: 'processing' }), 5000);

  // ── Model busy guard — block cron scheduler while user chat is running ──
  isModelBusy = true;

  const abortSignal = { aborted: false };
  let requestCompleted = false;
  res.on('close', () => {
    if (!requestCompleted && !abortSignal.aborted) {
      abortSignal.aborted = true;
      console.log(`[v2] Client disconnected — aborting task for session ${sessionId}`);
    }
  });

  try {
    const userMsg = { role: 'user' as const, content: message, timestamp: Date.now() };
    const addResult = addMessage(sessionId, userMsg, { deferOnMemoryFlush: true, deferOnCompaction: true });
    if (addResult.deferredForCompaction && addResult.compactionPrompt) {
      console.log(`[v2] Context compaction triggered for session ${sessionId} (${addResult.estimatedTokens}/${addResult.contextLimitTokens} est. tokens)`);
      try {
        const internalCompactionContext = 'CONTEXT: Internal context compaction turn. Summarize prior conversation into compact retained context only.';
        const compactResult = await handleChat(
          addResult.compactionPrompt,
          sessionId,
          () => {},
          undefined,
          abortSignal,
          internalCompactionContext,
        );
        if (!abortSignal.aborted && compactResult?.text) {
          addMessage(
            sessionId,
            { role: 'assistant', content: compactResult.text, timestamp: Date.now() },
            { disableMemoryFlushCheck: true, disableCompactionCheck: true },
          );
        }
      } catch (compactErr: any) {
        console.warn('[v2] Context compaction turn failed:', compactErr?.message || compactErr);
      }
      if (abortSignal.aborted) return;
      addMessage(sessionId, userMsg, { disableMemoryFlushCheck: true, disableCompactionCheck: true });
    } else if (addResult.deferredForMemoryFlush && addResult.memoryFlushPrompt) {
      console.log(`[v2] Pre-compaction memory flush triggered for session ${sessionId} (${addResult.estimatedTokens}/${addResult.contextLimitTokens} est. tokens)`);
      try {
        const internalFlushContext = 'CONTEXT: Internal pre-compaction memory flush turn. Before continuing, save important durable user/task facts to memory now.';
        const flushResult = await handleChat(
          addResult.memoryFlushPrompt,
          sessionId,
          () => {},
          undefined,
          abortSignal,
          internalFlushContext,
        );
        if (!abortSignal.aborted && flushResult?.text) {
          addMessage(
            sessionId,
            { role: 'assistant', content: flushResult.text, timestamp: Date.now() },
            { disableMemoryFlushCheck: true, disableCompactionCheck: true },
          );
        }
      } catch (flushErr: any) {
        console.warn('[v2] Pre-compaction memory flush failed:', flushErr?.message || flushErr);
      }
      if (abortSignal.aborted) return;
      addMessage(sessionId, userMsg, { disableMemoryFlushCheck: true, disableCompactionCheck: true });
    }

    console.log(`\n[v2] USER: ${message.slice(0, 100)}`);
    const followupHandled = await tryHandleBlockedTaskFollowup(sessionId, message);
    if (followupHandled) {
      if (!abortSignal.aborted) {
        addMessage(sessionId, { role: 'assistant', content: followupHandled, timestamp: Date.now() });
        sendSSE('final', { text: followupHandled });
        sendSSE('done', {
          reply: followupHandled,
          mode: 'chat',
          sections: [{ type: 'text', content: followupHandled }],
        });
      }
      return;
    }
    const pins = Array.isArray(pinnedMessages) ? pinnedMessages.slice(0, 3) : [];
    const result = await handleChat(message, sessionId, sendSSE, pins.length > 0 ? pins : undefined, abortSignal);
    if (!abortSignal.aborted) {
      addMessage(sessionId, { role: 'assistant', content: result.text, timestamp: Date.now() });
      sendSSE('final', { text: result.text });
      sendSSE('done', {
        reply: result.text, mode: result.type,
        sections: [{ type: result.type === 'execute' ? 'tool_results' : 'text', content: result.text }],
        thinking: result.thinking, results: result.toolResults,
      });
    }
  } catch (err: any) {
    if (!abortSignal.aborted) {
      console.error('[v2] ERROR:', err);
      sendSSE('error', { message: err.message || 'Unknown error' });
    }
  } finally {
    requestCompleted = true;
    clearInterval(heartbeat);
    isModelBusy = false; // release busy guard — cron scheduler may now run
    res.end();
  }
});

app.get('/api/open-path', async (req, res) => {
  const fp = req.query.path as string;
  if (!fp) { res.status(400).json({ error: 'Path required' }); return; }
  try {
    const { exec } = await import('child_process');
    const cmd = process.platform === 'win32' ? `start "" "${fp}"` : process.platform === 'darwin' ? `open "${fp}"` : `xdg-open "${fp}"`;
    exec(cmd, (err) => { err ? res.status(500).json({ error: err.message }) : res.json({ success: true }); });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clear-history', async (req, res) => {
  const sid = req.body.sessionId || 'default';
  const ws = getWorkspace(sid) || (getConfig().getConfig() as any).workspace?.path || '';
  if (ws) {
    await hookBus.fire({
      type: 'command:reset',
      sessionId: sid,
      workspacePath: ws,
      timestamp: Date.now(),
    });
    await hookBus.fire({
      type: 'command:new',
      sessionId: sid,
      workspacePath: ws,
      timestamp: Date.now(),
    });
  }
  clearHistory(sid);
  res.json({ success: true });
});

// ─── Skills API ────────────────────────────────────────────────────────────────

app.get('/api/skills', async (_req, res) => {
  recoverSkillsIfEmpty();

  let orchestrationEligibility: { eligible: boolean; reason?: string } = { eligible: true };
  try {
    orchestrationEligibility = await checkOrchestrationEligibility();
  } catch {}

  const skills = skillsManager.getAll().map(s => {
    const isOrchestrator = s.id === 'multi-agent-orchestrator';
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      emoji: s.emoji,
      version: s.version,
      enabled: s.enabled,
      createdAt: s.createdAt,
      eligible: isOrchestrator ? orchestrationEligibility.eligible : true,
      eligibleReason: isOrchestrator
        ? (orchestrationEligibility.eligible ? undefined : orchestrationEligibility.reason)
        : undefined,
    };
  });
  res.json({ success: true, skills });
});

app.get('/api/skills/:id', (req, res) => {
  const skill = skillsManager.get(req.params.id);
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true, skill });
});

app.post('/api/skills/:id/toggle', async (req, res) => {
  const skillId = req.params.id;
  const current = skillsManager.get(skillId);
  if (!current) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }

  // Guard enabling orchestration skill until config is eligible.
  if (skillId === 'multi-agent-orchestrator' && !current.enabled) {
    const eligibility = await checkOrchestrationEligibility();
    if (!eligibility.eligible) {
      res.status(409).json({
        success: false,
        error: eligibility.reason || 'Configure a valid secondary model first.',
      });
      return;
    }
  }

  const skill = skillsManager.toggle(skillId);
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }

  if (skillId === 'multi-agent-orchestrator') {
    setOrchestrationEnabled(skill.enabled);
  }

  res.json({ success: true, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } });
});

app.post('/api/skills', (req, res) => {
  try {
    const { id, name, description, emoji, instructions } = req.body;
    if (!name || !instructions) { res.status(400).json({ success: false, error: 'Name and instructions required' }); return; }
    const skillId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const skill = skillsManager.create({ id: skillId, name, description: description || '', emoji: emoji || '🧩', instructions });
    res.json({ success: true, skill: { id: skill.id, name: skill.name, description: skill.description, emoji: skill.emoji, enabled: skill.enabled } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/skills/:id', (req, res) => {
  const { name, description, emoji, instructions } = req.body;
  const skill = skillsManager.update(req.params.id, { name, description, emoji, instructions });
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true, skill: { id: skill.id, name: skill.name, description: skill.description, emoji: skill.emoji, enabled: skill.enabled } });
});

app.delete('/api/skills/:id', (req, res) => {
  const ok = skillsManager.delete(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true });
});

// ——— Orchestration Settings API ————————————————————————————————

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function getOrchestrationConfigForApi() {
  const raw = (getConfig().getConfig() as any).orchestration || {};
  // Use the single-source-of-truth clamp utility — no inline duplication.
  const clamped = clampOrchestrationConfig(raw);
  const preempt = clampPreemptConfig(raw.preempt || {});
  return {
    enabled: raw.enabled === true,
    secondary: {
      provider: String(raw.secondary?.provider || '').trim(),
      model: String(raw.secondary?.model || '').trim(),
    },
    ...clamped,
    preempt,
  };
}

app.get('/api/orchestration/config', (_req, res) => {
  res.json(getOrchestrationConfigForApi());
});

app.post('/api/orchestration/config', (req, res) => {
  const current = getOrchestrationConfigForApi();
  const incoming = req.body || {};
  const incomingMode = String(incoming.preflight?.mode || '').trim();
  const incomingRestartMode = String(incoming.preempt?.restart_mode || '').trim();

  const mergedRaw = {
    enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : current.enabled,
    secondary: {
      provider: String(incoming.secondary?.provider ?? current.secondary.provider).trim(),
      model: String(incoming.secondary?.model ?? current.secondary.model).trim(),
    },
    triggers: {
      ...current.triggers,
      ...(incoming.triggers && typeof incoming.triggers === 'object' ? incoming.triggers : {}),
      loop_detection: typeof incoming.triggers?.loop_detection === 'boolean'
        ? incoming.triggers.loop_detection
        : current.triggers.loop_detection,
    },
    preflight: {
      ...current.preflight,
      ...(incoming.preflight && typeof incoming.preflight === 'object' ? incoming.preflight : {}),
      mode: ['off', 'complex_only', 'always'].includes(incomingMode)
        ? incomingMode
        : current.preflight.mode,
      allow_secondary_chat: typeof incoming.preflight?.allow_secondary_chat === 'boolean'
        ? incoming.preflight.allow_secondary_chat
        : current.preflight.allow_secondary_chat,
    },
    limits: {
      ...current.limits,
      ...(incoming.limits && typeof incoming.limits === 'object' ? incoming.limits : {}),
    },
    browser: {
      ...current.browser,
      ...(incoming.browser && typeof incoming.browser === 'object' ? incoming.browser : {}),
    },
    file_ops: {
      ...current.file_ops,
      ...(incoming.file_ops && typeof incoming.file_ops === 'object' ? incoming.file_ops : {}),
      enabled: typeof incoming.file_ops?.enabled === 'boolean'
        ? incoming.file_ops.enabled
        : current.file_ops.enabled,
      verify_create_always: typeof incoming.file_ops?.verify_create_always === 'boolean'
        ? incoming.file_ops.verify_create_always
        : current.file_ops.verify_create_always,
      checkpointing_enabled: typeof incoming.file_ops?.checkpointing_enabled === 'boolean'
        ? incoming.file_ops.checkpointing_enabled
        : current.file_ops.checkpointing_enabled,
    },
    preempt: {
      ...current.preempt,
      ...(incoming.preempt && typeof incoming.preempt === 'object' ? incoming.preempt : {}),
      enabled: typeof incoming.preempt?.enabled === 'boolean'
        ? incoming.preempt.enabled
        : current.preempt.enabled,
      restart_mode: ['inherit_console', 'detached_hidden'].includes(incomingRestartMode)
        ? incomingRestartMode
        : current.preempt.restart_mode,
    },
  };

  const clamped = clampOrchestrationConfig(mergedRaw);
  const preempt = clampPreemptConfig(mergedRaw.preempt || {});
  const merged = {
    enabled: mergedRaw.enabled,
    secondary: mergedRaw.secondary,
    ...clamped,
    preempt: {
      ...preempt,
      enabled: mergedRaw.preempt.enabled,
    },
  };

  getConfig().updateConfig({ orchestration: merged } as any);
  res.json({ success: true, config: merged });
});

app.get('/api/orchestration/eligible', async (_req, res) => {
  const eligibility = await checkOrchestrationEligibility();
  res.json(eligibility);
});

app.get('/api/orchestration/telemetry', (req, res) => {
  const sessionId = String(req.query.sessionId || 'default');
  const stats = getOrchestrationSessionStats(sessionId);
  const cfg = getOrchestrationConfig();
  const limit = cfg?.limits?.telemetry_history_limit || 100;
  res.json({
    sessionId,
    assistCount: stats.assistCount,
    assistCap: cfg?.limits?.max_assists_per_session || 0,
    events: stats.events.slice(-limit),
  });
});

app.get('/api/task-status', (req, res) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const task = activeTasks.get(sessionId);
  if (!task) { res.json({ active: false }); return; }
  res.json({ active: task.status === 'running', ...task, journal: task.journal.slice(-10) });
});

// ─── Tasks / Cron API ──────────────────────────────────────────────────────────

app.get('/api/tasks', (_req, res) => {
  res.json({ success: true, jobs: cronScheduler.getJobs(), config: cronScheduler.getConfig() });
});

app.post('/api/tasks', (req, res) => {
  const { name, prompt, type, schedule, tz, runAt, priority, sessionTarget, payloadKind, systemEventText, model } = req.body;
  if (!name || !prompt) { res.status(400).json({ success: false, error: 'name and prompt required' }); return; }
  if (type === 'heartbeat') {
    res.status(400).json({ success: false, error: 'Heartbeat is no longer a CronJob. Configure HEARTBEAT.md and /api/heartbeat/config instead.' });
    return;
  }
  const job = cronScheduler.createJob({
    name,
    prompt,
    type,
    schedule,
    tz,
    runAt,
    priority,
    sessionTarget,
    payloadKind,
    systemEventText,
    model,
  });
  res.json({ success: true, job });
});

app.put('/api/tasks/:id', (req, res) => {
  const job = cronScheduler.updateJob(req.params.id, req.body);
  if (!job) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true, job });
});

app.delete('/api/tasks/:id', (req, res) => {
  const ok = cronScheduler.deleteJob(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true });
});

app.post('/api/tasks/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) { res.status(400).json({ success: false, error: 'orderedIds array required' }); return; }
  cronScheduler.reorderJobs(orderedIds);
  res.json({ success: true });
});

app.post('/api/tasks/:id/run', async (req, res) => {
  const jobs = cronScheduler.getJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true, message: 'Job queued for immediate run' });
  cronScheduler.runJobNow(req.params.id, { respectActiveHours: false }).catch(console.error);
});

app.get('/api/tasks/config', (_req, res) => {
  res.json({ success: true, config: cronScheduler.getConfig() });
});

app.put('/api/tasks/config', (req, res) => {
  cronScheduler.updateConfig(req.body);
  res.json({ success: true, config: cronScheduler.getConfig() });
});

app.get('/api/heartbeat/config', (_req, res) => {
  res.json({ success: true, config: heartbeatRunner.getConfig() });
});

app.put('/api/heartbeat/config', (req, res) => {
  const cfg = heartbeatRunner.updateConfig(req.body || {});
  res.json({ success: true, config: cfg });
});

// ─── Background Task Kanban API ─────────────────────────────────────────────────

app.get('/api/bg-tasks', (_req, res) => {
  const tasks = listTasks();
  const heartbeatConfig = loadTaskHeartbeatConfig();
  res.json({ success: true, tasks, heartbeatConfig });
});

app.get('/api/bg-tasks/:id', (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  res.json({ success: true, task });
});

app.delete('/api/bg-tasks/:id', (req, res) => {
  const ok = deleteTask(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  res.json({ success: true });
});

app.post('/api/bg-tasks/:id/pause', (req, res) => {
  const task = updateTaskStatus(req.params.id, 'paused', { pauseReason: 'user_pause' });
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  BackgroundTaskRunner.requestPause(req.params.id);
  const sid = task.sessionId || 'default';
  const ws = getWorkspace(sid) || (getConfig().getConfig() as any).workspace?.path || '';
  if (ws) {
    hookBus.fire({
      type: 'command:stop',
      sessionId: sid,
      workspacePath: ws,
      timestamp: Date.now(),
    }).catch((err: any) => console.warn('[hooks] command:stop error:', err?.message || err));
  }
  res.json({ success: true });
});

app.post('/api/bg-tasks/:id/resume', (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  if (
    task.status === 'paused'
    || task.status === 'queued'
    || task.status === 'stalled'
    || task.status === 'needs_assistance'
  ) {
    updateTaskStatus(task.id, 'queued');
    const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
    runner.start().catch(err => console.error(`[BackgroundTaskRunner] Resume ${task.id} error:`, err.message));
    res.json({ success: true });
  } else {
    res.json({ success: false, error: `Task status is ${task.status}, cannot resume` });
  }
});

// SSE stream for live task updates
app.get('/api/bg-tasks/:id/stream', (req, res) => {
  const taskId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (data: any) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  // Send current state immediately
  const task = loadTask(taskId);
  if (task) send({ type: 'snapshot', task });

  // Poll task file every 2s for updates
  let lastJournalLen = task?.journal?.length || 0;
  const poll = setInterval(() => {
    const t = loadTask(taskId);
    if (!t) { clearInterval(poll); send({ type: 'error', message: 'Task not found' }); res.end(); return; }
    if (t.journal.length !== lastJournalLen) {
      lastJournalLen = t.journal.length;
      send({ type: 'update', task: t });
    }
    if (t.status === 'complete' || t.status === 'failed') {
      send({ type: 'final', task: t });
      clearInterval(poll);
      res.end();
    }
  }, 2000);

  req.on('close', () => clearInterval(poll));
});

// Task heartbeat config API
const taskHeartbeatPath = path.join(process.cwd(), '.localclaw', 'task-heartbeat.json');

function loadTaskHeartbeatConfig(): { enabled: boolean; interval_minutes: number } {
  try {
    if (fs.existsSync(taskHeartbeatPath)) return JSON.parse(fs.readFileSync(taskHeartbeatPath, 'utf-8'));
  } catch {}
  return { enabled: true, interval_minutes: 10 };
}

function saveTaskHeartbeatConfig(cfg: { enabled: boolean; interval_minutes: number }): void {
  try { fs.mkdirSync(path.dirname(taskHeartbeatPath), { recursive: true }); } catch {}
  fs.writeFileSync(taskHeartbeatPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

app.get('/api/bg-tasks/heartbeat/config', (_req, res) => {
  res.json({ success: true, config: loadTaskHeartbeatConfig() });
});

app.put('/api/bg-tasks/heartbeat/config', (req, res) => {
  const current = loadTaskHeartbeatConfig();
  const next = {
    enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : current.enabled,
    interval_minutes: Math.max(1, Math.min(1440, Number(req.body.interval_minutes) || current.interval_minutes)),
  };
  saveTaskHeartbeatConfig(next);
  scheduleTaskHeartbeat();
  res.json({ success: true, config: next });
});

// ─── Task Heartbeat Scheduler ───────────────────────────────────────────────

let taskHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

// Per-task followup timers — fired when a step completes to resume quickly
// instead of waiting the full heartbeat interval.
const taskFollowupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleTaskFollowup(taskId: string, delayMs: number): void {
  // Cancel any existing followup for this task
  const existing = taskFollowupTimers.get(taskId);
  if (existing) clearTimeout(existing);
  console.log(`[TaskFollowup] Scheduling quick resume for task ${taskId} in ${Math.round(delayMs / 1000)}s`);
  const t = setTimeout(async () => {
    taskFollowupTimers.delete(taskId);
    if (isModelBusy) {
      // Retry in 30s if model is busy
      scheduleTaskFollowup(taskId, 30_000);
      return;
    }
    const task = loadTask(taskId);
    if (!task || task.status === 'complete' || task.status === 'failed' || task.status === 'running') return;
    console.log(`[TaskFollowup] Quick-resuming task ${taskId}: ${task.title}`);
    updateTaskStatus(taskId, 'queued');
    appendJournal(taskId, { type: 'heartbeat', content: 'Quick follow-up resume triggered after step completion.' });
    const runner = new BackgroundTaskRunner(taskId, handleChat, makeBroadcastForTask(taskId), telegramChannel);
    runner.start().catch(err => console.error(`[TaskFollowup] Runner error:`, err.message));
    broadcastWS({ type: 'task_heartbeat_resumed', taskId, rationale: 'Quick step follow-up' });
  }, delayMs);
  if (t && typeof (t as any).unref === 'function') (t as any).unref();
  taskFollowupTimers.set(taskId, t);
}

// Broadcast interceptor for BackgroundTaskRunner — catches internal signals
// that need server-side action (like scheduling a quick step follow-up)
// while still forwarding all events to WS clients.
function makeBroadcastForTask(taskId: string): (data: object) => void {
  return (data: object) => {
    const d = data as any;
    if (d.type === 'task_step_followup_needed' && d.taskId === taskId) {
      scheduleTaskFollowup(taskId, d.delayMs || 120_000);
      // Don't forward this internal signal to UI clients
      return;
    }
    broadcastWS(data);
  };
}

function scheduleTaskHeartbeat(): void {
  if (taskHeartbeatTimer) clearTimeout(taskHeartbeatTimer);
  const cfg = loadTaskHeartbeatConfig();
  if (!cfg.enabled) return;
  const intervalMs = cfg.interval_minutes * 60 * 1000;
  taskHeartbeatTimer = setTimeout(runTaskHeartbeat, intervalMs);
  if (taskHeartbeatTimer && typeof (taskHeartbeatTimer as any).unref === 'function') {
    (taskHeartbeatTimer as any).unref();
  }
}

async function runTaskHeartbeat(): Promise<void> {
  if (isModelBusy) {
    scheduleTaskHeartbeat();
    return;
  }
  const orchCfg = getOrchestrationConfig();
  if (!orchCfg?.enabled) {
    scheduleTaskHeartbeat();
    return;
  }

  const pausedOrQueued = listTasks({ status: ['paused', 'queued', 'stalled'] });
  if (pausedOrQueued.length === 0) {
    scheduleTaskHeartbeat();
    return;
  }

  console.log(`[TaskHeartbeat] Firing advisor for ${pausedOrQueued.length} task(s)...`);
  broadcastWS({ type: 'task_heartbeat_tick', taskCount: pausedOrQueued.length });

  // Single-pass map: pull both buildTaskSnapshot fields and raw task timestamps together
  // so there is no implicit index coupling between chained map calls.
  const snapshots: HeartbeatTaskSnapshot[] = pausedOrQueued.map(t => {
    const s = buildTaskSnapshot(t);
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      pauseReason: s.pauseReason,
      currentStepIndex: s.currentStepIndex,
      totalSteps: s.totalSteps,
      currentStepDescription: s.currentStep,
      lastProgressAt: t.lastProgressAt,
      startedAt: t.startedAt,
      lastJournalEntries: s.recentJournal,
      channel: s.channel,
      sessionId: s.sessionId,
    };
  });

  try {
    const decision = await callSecondaryHeartbeatAdvisor({ tasks: snapshots, currentTimeMs: Date.now() });
    if (!decision || decision.verdict !== 'continue' || !decision.resume_task_id) {
      console.log(`[TaskHeartbeat] Advisor verdict: ${decision?.verdict || 'null'} — nothing to resume.`);
      scheduleTaskHeartbeat();
      return;
    }

    const taskToResume = loadTask(decision.resume_task_id);
    if (!taskToResume) {
      scheduleTaskHeartbeat();
      return;
    }

    // Apply any plan mutations the advisor suggested
    if (decision.plan_mutations?.length) {
      mutatePlan(decision.resume_task_id, decision.plan_mutations);
    }

    appendJournal(decision.resume_task_id, {
      type: 'heartbeat',
      content: `Heartbeat resume: ${decision.rationale.slice(0, 120)}`,
    });

    updateTaskStatus(decision.resume_task_id, 'queued');
    const runner = new BackgroundTaskRunner(
      decision.resume_task_id,
      handleChat,
      makeBroadcastForTask(decision.resume_task_id),
      telegramChannel,
      decision.opening_action,
    );
    runner.start().catch(err => console.error(`[TaskHeartbeat] Runner error:`, err.message));
    broadcastWS({ type: 'task_heartbeat_resumed', taskId: decision.resume_task_id, rationale: decision.rationale });
    console.log(`[TaskHeartbeat] Resuming task ${decision.resume_task_id}: ${taskToResume.title}`);
  } catch (err: any) {
    console.error('[TaskHeartbeat] Advisor error:', err.message);
  }

  scheduleTaskHeartbeat();
}

// ─── Telegram API ──────────────────────────────────────────────────────────────

app.get('/api/telegram/status', (_req, res) => {
  const status = telegramChannel.getStatus();
  const tgConfig = getConfig().getConfig().telegram;
  res.json({
    success: true,
    ...status,
    enabled: tgConfig?.enabled || false,
    hasToken: !!(tgConfig?.botToken),
    allowedUserIds: tgConfig?.allowedUserIds || [],
  });
});

app.post('/api/telegram/config', async (req, res) => {
  const { botToken, allowedUserIds, enabled } = req.body;
  const cm = getConfig();
  const current = cm.getConfig();
  const newTg = {
    enabled: typeof enabled === 'boolean' ? enabled : (current.telegram?.enabled || false),
    botToken: typeof botToken === 'string' ? botToken : (current.telegram?.botToken || ''),
    allowedUserIds: Array.isArray(allowedUserIds) ? allowedUserIds.map(Number).filter(n => !isNaN(n)) : (current.telegram?.allowedUserIds || []),
    streamMode: 'full' as const,
  };
  cm.updateConfig({ telegram: newTg });
  telegramChannel.updateConfig(newTg);
  res.json({ success: true, config: { enabled: newTg.enabled, hasToken: !!newTg.botToken, allowedUserIds: newTg.allowedUserIds } });
});

app.post('/api/telegram/test', async (req, res) => {
  const { botToken } = req.body;
  const token = botToken || getConfig().getConfig().telegram?.botToken;
  if (!token) { res.json({ success: false, error: 'No bot token provided' }); return; }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, { method: 'POST' });
    const data: any = await resp.json();
    if (!data.ok) { res.json({ success: false, error: data.description || 'Invalid token' }); return; }
    res.json({ success: true, bot: { username: data.result.username, firstName: data.result.first_name, id: data.result.id } });
  } catch (err: any) { res.json({ success: false, error: err.message }); }
});

app.post('/api/telegram/send-test', async (req, res) => {
  try {
    await telegramChannel.sendToAllowed('🦞 SmallClaw test message — Telegram is connected!');
    res.json({ success: true });
  } catch (err: any) { res.json({ success: false, error: err.message }); }
});

// ─── Settings API ────────────────────────────────────────────────────────────────

app.get('/api/settings/search', (_req, res) => {
  const cfg = (getConfig().getConfig() as any).search || {};
  res.json({
    preferred_provider: cfg.preferred_provider || 'tavily',
    search_rigor: cfg.search_rigor || 'verified',
    tavily_api_key: cfg.tavily_api_key || '',
    google_api_key: cfg.google_api_key || '',
    google_cx: cfg.google_cx || '',
    brave_api_key: cfg.brave_api_key || '',
  });
});

app.post('/api/settings/search', (req, res) => {
  const { preferred_provider, search_rigor, tavily_api_key, google_api_key, google_cx, brave_api_key } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const newSearch = {
    ...((current.search || {})),
    ...(preferred_provider !== undefined && { preferred_provider }),
    ...(search_rigor !== undefined && { search_rigor }),
    ...(tavily_api_key !== undefined && { tavily_api_key }),
    ...(google_api_key !== undefined && { google_api_key }),
    ...(google_cx !== undefined && { google_cx }),
    ...(brave_api_key !== undefined && { brave_api_key }),
  };
  cm.updateConfig({ search: newSearch } as any);
  res.json({ success: true });
});

app.get('/api/settings/paths', (_req, res) => {
  const cfg = getConfig().getConfig();
  res.json({
    workspace_path: (cfg as any).workspace?.path || '',
    allowed_paths: (cfg as any).tools?.permissions?.files?.allowed_paths || [],
    blocked_paths: (cfg as any).tools?.permissions?.files?.blocked_paths || [],
  });
});

app.post('/api/settings/paths', (req, res) => {
  const { workspace_path, allowed_paths, blocked_paths } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const tools = {
    ...current.tools,
    permissions: {
      ...current.tools?.permissions,
      files: {
        ...(current.tools?.permissions?.files || {}),
        ...(Array.isArray(allowed_paths) && { allowed_paths }),
        ...(Array.isArray(blocked_paths) && { blocked_paths }),
      },
    },
  };
  const workspacePath = typeof workspace_path === 'string' ? workspace_path.trim() : '';
  if (workspacePath) {
    try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}
  }
  cm.updateConfig({
    tools,
    ...(workspacePath ? { workspace: { ...(current.workspace || {}), path: workspacePath } } : {}),
  } as any);
  res.json({ success: true });
});

app.get('/api/settings/agent', (_req, res) => {
  const cfg = (getConfig().getConfig() as any).agent_policy || {};
  res.json({
    force_web_for_fresh: cfg.force_web_for_fresh !== false,
    memory_fallback_on_search_failure: cfg.memory_fallback_on_search_failure !== false,
    auto_store_web_facts: cfg.auto_store_web_facts !== false,
    natural_language_tool_router: cfg.natural_language_tool_router !== false,
    retrieval_mode: cfg.retrieval_mode || 'standard',
  });
});

app.post('/api/settings/agent', (req, res) => {
  const { force_web_for_fresh, memory_fallback_on_search_failure, auto_store_web_facts, natural_language_tool_router, retrieval_mode } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const newPolicy = {
    ...(current.agent_policy || {}),
    ...(force_web_for_fresh !== undefined && { force_web_for_fresh }),
    ...(memory_fallback_on_search_failure !== undefined && { memory_fallback_on_search_failure }),
    ...(auto_store_web_facts !== undefined && { auto_store_web_facts }),
    ...(natural_language_tool_router !== undefined && { natural_language_tool_router }),
    ...(retrieval_mode !== undefined && { retrieval_mode }),
  };
  cm.updateConfig({ agent_policy: newPolicy } as any);
  res.json({ success: true });
});

// ─── Model / Ollama Settings API ──────────────────────────────────────────────────

app.get('/api/settings/model', (_req, res) => {
  const cfg = getConfig().getConfig();
  res.json({
    primary: cfg.models.primary,
    roles: cfg.models.roles,
    ollama_endpoint: (cfg as any).ollama?.endpoint || 'http://localhost:11434',
  });
});

app.post('/api/settings/model', (req, res) => {
  const { primary, roles, ollama_endpoint } = req.body;
  const cm = getConfig();
  const current = cm.getConfig();
  if (primary || roles) {
    cm.updateConfig({
      models: {
        primary: primary || current.models.primary,
        roles: { ...current.models.roles, ...(roles || {}) },
      }
    });
  }
  if (ollama_endpoint) {
    cm.updateConfig({
      ollama: { ...(current as any).ollama, endpoint: ollama_endpoint }
    } as any);
  }
  res.json({ success: true, model: getConfig().getConfig().models.primary });
});

// Fetch available Ollama models (proxies Ollama /api/tags)
app.get('/api/ollama/models', async (_req, res) => {
  try {
    const ollamaEndpoint = (getConfig().getConfig() as any).ollama?.endpoint || 'http://localhost:11434';
    const response = await fetch(`${ollamaEndpoint}/api/tags`);
    if (!response.ok) { res.json({ success: false, models: [], error: `Ollama returned ${response.status}` }); return; }
    const data = await response.json() as any;
    const models = (data.models || []).map((m: any) => ({
      name: m.name,
      size: m.size,
      parameter_size: m.details?.parameter_size || '',
      family: m.details?.family || '',
      modified_at: m.modified_at,
    }));
    res.json({ success: true, models });
  } catch (err: any) {
    res.json({ success: false, models: [], error: err.message });
  }
});

// ─── System Stats API ───────────────────────────────────────────────────────────

import * as osModule from 'os';

// Track previous CPU times for accurate utilization
let prevCpuTimes: { idle: number; total: number } | null = null;

function getCpuPercent(): number {
  const cpus = osModule.cpus();
  let totalIdle = 0; let totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += (cpu.times as any)[type];
    totalIdle += cpu.times.idle;
  }
  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  if (!prevCpuTimes) { prevCpuTimes = { idle, total }; return 0; }
  const idleDiff = idle - prevCpuTimes.idle;
  const totalDiff = total - prevCpuTimes.total;
  prevCpuTimes = { idle, total };
  if (totalDiff === 0) return 0;
  return Math.round(100 * (1 - idleDiff / totalDiff));
}

app.get('/api/system-stats', async (_req, res) => {
  const totalMem = osModule.totalmem();
  const freeMem = osModule.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = (usedMem / totalMem) * 100;
  const cpuPercent = getCpuPercent();
  const rss = process.memoryUsage().rss;

  // Check if Ollama is reachable
  let ollamaRunning = false;
  let ollamaMemMb = 0;
  let ollamaCount = 0;
  try {
    const ollamaEndpoint = (getConfig().getConfig() as any).ollama?.endpoint || 'http://localhost:11434';
    const r = await fetch(`${ollamaEndpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      ollamaRunning = true;
      const data = await r.json() as any;
      ollamaCount = (data.models || []).length;
    }
  } catch {}

  // GPU stats — use the cached detector (probed once at startup, never calls
  // nvidia-smi again). On non-NVIDIA systems this is instant and silent.
  const gpuInfo = detectGpu();
  let gpuStats = { available: false, gpu_util_percent: 0, vram_used_percent: 0, vram_used_gb: 0, vram_total_gb: 0, name: '' };
  if (gpuInfo.nvidiaAvailable) {
    // Re-query utilization metrics only when NVIDIA is confirmed present.
    // This is the *only* place nvidia-smi runs at runtime; startup detection
    // already verified the GPU exists so this call is guaranteed to succeed.
    try {
      const { execSync } = await import('child_process');
      const smiOut = execSync(
        'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
        { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parts = smiOut.trim().split(',').map((s: string) => s.trim());
      if (parts.length >= 4) {
        const vramUsedMb = Number(parts[2]);
        const vramTotalMb = Number(parts[3]);
        gpuStats = {
          available: true,
          name: parts[0],
          gpu_util_percent: Number(parts[1]),
          vram_used_percent: vramTotalMb > 0 ? (vramUsedMb / vramTotalMb) * 100 : 0,
          vram_used_gb: vramUsedMb / 1024,
          vram_total_gb: vramTotalMb / 1024,
        };
      }
    } catch { /* nvidia-smi already confirmed working at startup; ignore transient errors */ }
  } else if (gpuInfo.amdAvailable) {
    gpuStats = { available: true, gpu_util_percent: 0, vram_used_percent: 0, vram_used_gb: 0, vram_total_gb: 0, name: gpuInfo.name ?? 'AMD GPU' };
  } else if (gpuInfo.appleSilicon) {
    gpuStats = { available: true, gpu_util_percent: 0, vram_used_percent: 0, vram_used_gb: 0, vram_total_gb: 0, name: gpuInfo.name ?? 'Apple Silicon' };
  }

  res.json({
    system: {
      cpu_percent: cpuPercent,
      memory_percent: memPercent,
      memory_used_gb: usedMem / (1024 ** 3),
      memory_total_gb: totalMem / (1024 ** 3),
    },
    gpu: gpuStats,
    ollama_process: { running: ollamaRunning, process_count: ollamaCount, total_memory_mb: ollamaMemMb },
    gateway_process: { rss_mb: rss / (1024 * 1024) },
    active_provider: (getConfig().getConfig() as any).llm?.provider || 'ollama',
    active_model: (() => { const c = getConfig().getConfig() as any; const p = c.llm?.provider || 'ollama'; return c.llm?.providers?.[p]?.model || c.models?.primary || 'unknown'; })(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Agent Session Context API ────────────────────────────────────────────────

app.get('/api/agent/session/:id', (req, res) => {
  const sessionId = req.params.id;
  const history = getHistory(sessionId, 50);
  const userMessages = history.filter(h => h.role === 'user');
  const aiMessages = history.filter(h => h.role === 'assistant');
  const recent = history.slice(-8).map(h => ({
    kind: h.role,
    status: 'completed',
    text: String(h.content || '').slice(0, 120),
  }));
  res.json({
    mode_lock: null,
    mode: useAgentMode ? 'agent' : 'chat',
    tasks: [],
    task_counts: { total: 0, done: 0 },
    turn_counts: { completed: history.length, open: 0 },
    execution_counts: { total: 0, done: 0, running: 0, failed: 0 },
    recent_turns: recent,
    recent_turn_executions: [],
    current_turn_execution: null,
    overview_objective: userMessages.length > 0 ? String(userMessages[0]?.content || '').slice(0, 80) : null,
    active_objective: userMessages.length > 0 ? String(userMessages[userMessages.length - 1]?.content || '').slice(0, 80) : null,
  });
});

// Track agent mode per-session (simplified)
let useAgentMode = false;

// ─── Approvals API (stub — full approval workflow in enterprise builds) ───

const pendingApprovals: Map<string, { id: string; action: string; reason: string }> = new Map();

app.get('/api/approvals', (_req, res) => {
  res.json(Array.from(pendingApprovals.values()));
});

app.post('/api/approvals/:id', (req, res) => {
  const { decision } = req.body;
  pendingApprovals.delete(req.params.id);
  res.json({ success: true, decision });
});

// ─── Memory API (stub) ───────────────────────────────────────────────────────────

app.post('/api/memory/confirm', (req, res) => {
  // Memory persistence stub — can be wired to ChromaDB/vector store
  console.log('[Memory] Confirmation request:', JSON.stringify(req.body).slice(0, 200));
  res.json({ ok: true });
});

// Open a file path in the OS file explorer
app.post('/api/open-path', async (req, res) => {
  const fp = (req.body?.path || '') as string;
  if (!fp) { res.status(400).json({ ok: false, error: 'Path required' }); return; }
  try {
    const { exec } = await import('child_process');
    const cmd = process.platform === 'win32' ? `explorer "${fp}"` : process.platform === 'darwin' ? `open "${fp}"` : `xdg-open "${fp}"`;
    exec(cmd);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Provider / Model Settings API ───────────────────────────────────────────
// Used by the Settings → Models tab to read/write provider config and
// trigger the OpenAI OAuth flow.

import { getProvider, resetProvider, buildProviderForLLM } from '../providers/factory';
import { startOAuthFlow, isConnected, clearTokens, loadTokens, exchangeManualCodeFromPending } from '../auth/openai-oauth';

function sanitizeLLMConfig(llm: any): any {
  if (!llm || typeof llm !== 'object') return llm;
  const copy = JSON.parse(JSON.stringify(llm));
  const codexModel = copy?.providers?.openai_codex?.model;
  if (typeof codexModel === 'string' && codexModel.trim() === 'codex-davinci-002') {
    copy.providers.openai_codex.model = 'gpt-4o';
  }
  return copy;
}

// GET /api/settings/provider  — return active provider config
app.get('/api/settings/provider', (_req, res) => {
  const raw = getConfig().getConfig() as any;
  const llmRaw = raw.llm || {
    provider: 'ollama',
    providers: { ollama: { endpoint: raw.ollama?.endpoint || 'http://localhost:11434', model: raw.models?.primary || 'qwen3:4b' } },
  };
  const llm = sanitizeLLMConfig(llmRaw);
  res.json({ success: true, llm });
});

// POST /api/settings/provider  — update provider config
app.post('/api/settings/provider', (req, res) => {
  try {
    const llm = sanitizeLLMConfig(req.body?.llm);
    if (!llm?.provider) { res.status(400).json({ success: false, error: 'Missing llm.provider' }); return; }
    const configManager = getConfig();
    configManager.updateConfig({ llm } as any);
    resetProvider();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/models/test  — test connectivity for the active (or a given) provider
app.post('/api/models/test', async (req, res) => {
  try {
    const llmOverride = req.body?.llm ? sanitizeLLMConfig(req.body.llm) : null;
    const provider = llmOverride ? buildProviderForLLM(llmOverride) : getProvider();
    const ok = await provider.testConnection();
    const models = ok ? await provider.listModels() : [];
    res.json({ success: ok, models, error: ok ? undefined : 'Could not connect' });
  } catch (err: any) {
    res.json({ success: false, models: [], error: err.message });
  }
});

// GET /api/auth/openai/status  — is the user connected via OAuth?
app.get('/api/auth/openai/status', (_req, res) => {
  const configDir = path.join(process.cwd(), '.localclaw');
  const connected = isConnected(configDir);
  const tokens    = connected ? loadTokens(configDir) : null;
  res.json({ connected, account_id: tokens?.account_id || null, expires_at: tokens?.expires_at || null });
});

// POST /api/auth/openai/start  — kick off OAuth flow (opens browser)
app.post('/api/auth/openai/start', async (_req, res) => {
  const configDir = path.join(process.cwd(), '.localclaw');
  try {
    const result = await startOAuthFlow(configDir);
    if (result.needsManualPaste) {
      res.json({ success: false, needsManualPaste: true, authUrl: result.authUrl });
    } else {
      res.json(result);
    }
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/auth/openai/manual  — manual paste fallback token exchange
app.post('/api/auth/openai/manual', async (req, res) => {
  const configDir = path.join(process.cwd(), '.localclaw');
  const redirectedUrl = String(req.body?.url || '').trim();
  if (!redirectedUrl) {
    res.status(400).json({ success: false, error: 'Missing redirect URL' });
    return;
  }
  try {
    const result = await exchangeManualCodeFromPending(configDir, redirectedUrl);
    res.json(result);
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/auth/openai/disconnect  — revoke stored tokens
app.post('/api/auth/openai/disconnect', (_req, res) => {
  const configDir = path.join(process.cwd(), '.localclaw');
  clearTokens(configDir);
  res.json({ success: true });
});

app.get('*', (_req, res) => { res.sendFile(path.join(webUiPath, 'index.html')); });

// ─── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[Gateway] Port ${HOST}:${PORT} is already in use.`);
    console.error('[Gateway] Another gateway instance is likely already running.');
    console.error('[Gateway] Use one instance only, then open http://127.0.0.1:18789');
    process.exit(1);
    return;
  }
  console.error('[Gateway] WebSocket error:', err?.message || err);
  process.exit(1);
});
wss.on('connection', (ws: WebSocket) => {
  console.log('[v2] WS connected');
  ws.on('message', (d) => { try { JSON.parse(d.toString()); } catch {} });
  ws.on('close', () => console.log('[v2] WS disconnected'));
});

server.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[Gateway] Port ${HOST}:${PORT} is already in use.`);
    console.error('[Gateway] Another gateway instance is likely already running.');
    console.error('[Gateway] Use one instance only, then open http://127.0.0.1:18789');
    process.exit(1);
    return;
  }
  console.error('[Gateway] HTTP server error:', err?.message || err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // Detect GPU hardware once — logs a single clean line, caches result for
  // the lifetime of the process (used by /api/system-stats, no repeated probes).
  logGpuStatus();

  const liveConfig = getConfig().getConfig();
  const searchCfg = (liveConfig as any).search || {};
  const searchProvider = searchCfg.preferred_provider || 'none';
  const hasSearch = searchCfg.tavily_api_key ? '✓ Tavily' : searchCfg.google_api_key ? '✓ Google' : '✗ None (configure in Settings → Search)';
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║              SmallClaw v2 Gateway (Native Tools)              ║
╠════════════════════════════════════════════════════════════════╣
║  Tasks:   Cron scheduler active, jobs at .localclaw/cron/     ║
║  Skills: ${String(skillsManager.getAll().length + ' loaded, ' + skillsManager.getEnabledSkills().length + ' enabled').padEnd(49)}║
║  Search:  ${hasSearch.padEnd(49)}║
║  Memory:  SOUL.md + IDENTITY.md + USER.md + MEMORY.md         ║
║                                                               ║
║  Web UI:    http://${HOST}:${PORT}                            ║
║  Model:     ${liveConfig.models.primary.padEnd(45)}║
║  Workspace: ${liveConfig.workspace.path.slice(0, 43).padEnd(45)}║
╚════════════════════════════════════════════════════════════════╝
`);
  cronScheduler.start();
  console.log('[CronScheduler] Tick loop started — heartbeat:', cronScheduler.getConfig().enabled ? 'ON' : 'OFF');
  heartbeatRunner.start();
  console.log('[HeartbeatRunner] Started — interval:', heartbeatRunner.getConfig().intervalMinutes, 'min');
  telegramChannel.start().catch(err => console.error('[Telegram] Start failed:', err.message));
  scheduleTaskHeartbeat();
  console.log('[TaskHeartbeat] Scheduled — interval:', loadTaskHeartbeatConfig().interval_minutes, 'min');

  const bootWorkspace = getConfig().getWorkspacePath() || (getConfig().getConfig() as any).workspace?.path || '';
  if (bootWorkspace) {
    loadWorkspaceHooks(bootWorkspace);
    hookBus
      .fire({ type: 'gateway:startup', workspacePath: bootWorkspace })
      .catch((err: any) => console.warn('[hooks] gateway:startup error:', err?.message || err));
  }
});

let shuttingDown = false;
function gracefulShutdown(signal: 'SIGINT' | 'SIGTERM'): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Gateway] Received ${signal}; shutting down...`);
  try { skillsManager.persistState(); } catch {}
  try { telegramChannel.stop(); } catch {}
  try { cronScheduler.stop(); } catch {}
  try { heartbeatRunner.stop(); } catch {}
  try { if (wss) wss.close(); } catch {}
  try {
    server.close(() => process.exit(0));
    const forceExitTimer = setTimeout(() => process.exit(0), 1200) as any;
    if (typeof forceExitTimer?.unref === 'function') forceExitTimer.unref();
  } catch {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

export { app, server };
