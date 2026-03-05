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
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  getConfig,
  getAgents,
  getAgentById,
  ensureAgentWorkspace,
  resolveAgentWorkspace,
} from '../config/config';
import { getVault } from '../security/vault';
import { getOllamaClient } from '../agents/ollama-client';
import { spawnAgent } from '../agents/spawner';
import { getSession, addMessage, getHistory, getHistoryForApiCall, getWorkspace, setWorkspace, clearHistory, cleanupSessions } from './session';
import { hookBus } from './hooks';
import { loadWorkspaceHooks } from './hook-loader';
import { runBootMd } from './boot';
import { TaskRunner, runTask, TaskTool, TaskState } from './task-runner';
import { setupErrorResponseEndpoint } from './error-response-endpoint-integrated';
import { initCredentialHandler, getCredentialHandler } from '../security/credential-handler';
import { getVerificationFlowManager } from './verification-flow';
import { getErrorAnalyzer } from './error-analyzer';
import { getErrorHistory } from './error-history';
import { getRetryStrategy } from './retry-strategy';
import { getVisualErrorDetector } from './visual-error-detection';
import { getErrorAudit } from '../security/error-audit';
import { getContextInjectionManager } from './context-injection';
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
import {
  initializeAgentSchedules,
  reloadAgentSchedules,
  stopAgentSchedules,
  getAgentRunHistory,
  getAgentLastRun,
  recordAgentRun,
} from '../scheduler';
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
import { SubagentManager } from './subagent-manager';
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
import { internalAgentTaskRouter } from './internal-agent-task';
import {
  registerAgentBuilderTools,
  executeAgentBuilderTool,
  AGENT_BUILDER_TOOL_NAMES,
  getWorkflowContextBlock,
} from './agent-builder-integration';

// ─── Config ────────────────────────────────────────────────────────────────────

const config = getConfig().getConfig();
const CONFIG_DIR_PATH = getConfig().getConfigDir();
const PORT = config.gateway.port || (process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT, 10) : 18789);
const HOST = config.gateway.host || process.env.GATEWAY_HOST || (process.env.DOCKER_CONTAINER ? '0.0.0.0' : '127.0.0.1');
const MAX_TOOL_ROUNDS = 20;
type ExecutionMode = 'interactive' | 'background_task' | 'heartbeat' | 'cron';

function repairLegacyTaskChannelMetadata(): void {
  try {
    const tasks = listTasks();
    let repaired = 0;
    for (const task of tasks) {
      if (!String(task.sessionId || '').startsWith('telegram_')) continue;
      if (task.channel === 'telegram' && task.telegramChatId) continue;
      task.channel = 'telegram';
      if (!task.telegramChatId) {
        const parsed = Number(String(task.sessionId || '').replace(/^telegram_/, ''));
        if (Number.isFinite(parsed) && parsed > 0) task.telegramChatId = parsed;
      }
      saveTask(task);
      repaired++;
    }
    if (repaired > 0) {
      console.log(`[TaskStore] Repaired ${repaired} legacy task(s) with telegram metadata.`);
    }
  } catch (err: any) {
    console.warn('[TaskStore] Legacy task metadata repair skipped:', err?.message || err);
  }
}

{
  const cleaned = cleanupSessions();
  if (cleaned.deleted > 0) {
    console.log(`[session] Cleaned up ${cleaned.deleted} stale automated session file(s).`);
  }
  repairLegacyTaskChannelMetadata();
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

function hasUriScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value || '').trim());
}

const BLOCKED_PATTERNS = ['del ', 'rm ', 'format', 'shutdown', 'restart', 'rmdir', 'rd ', 'taskkill', 'reg '];

// ── Sub-Agent Tool Profiles ────────────────────────────────────────────────────────────
type SubagentProfile = 'file_editor' | 'researcher' | 'shell_runner' | 'reader_only';
const TOOL_PROFILES: Record<SubagentProfile, Set<string>> = {
  file_editor:  new Set(['read_file', 'create_file', 'replace_lines', 'insert_after', 'delete_lines', 'find_replace', 'list_files']),
  researcher:   new Set(['read_file', 'list_files', 'web_search', 'web_fetch']),
  shell_runner: new Set(['run_command', 'read_file', 'list_files']),
  reader_only:  new Set(['read_file', 'list_files']),
};

// Track last-used filename per session for when model forgets to pass it
const lastFilenameUsed: Map<string, string> = new Map();

// Skills system
const configuredSkillsDir = (config as any).skills?.directory || path.join(CONFIG_DIR_PATH, 'skills');
const fallbackSkillsDir = path.join(CONFIG_DIR_PATH, 'skills');

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

type TelegramChannelConfig = {
  enabled: boolean;
  botToken: string;
  allowedUserIds: number[];
  streamMode: 'full' | 'partial';
};

type DiscordChannelConfig = {
  enabled: boolean;
  botToken: string;
  applicationId: string;
  guildId: string;
  channelId: string;
  webhookUrl: string;
};

type WhatsAppChannelConfig = {
  enabled: boolean;
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  verifyToken: string;
  webhookSecret: string;
  testRecipient: string;
};

type ChannelsConfig = {
  telegram: TelegramChannelConfig;
  discord: DiscordChannelConfig;
  whatsapp: WhatsAppChannelConfig;
};

// HIGH-01 fix: resolve vault references when normalizing channel configs.
// Tokens stored as "vault:<key>" are decrypted here at point-of-use,
// so they never have to be plaintext in config.json.
function resolveToken(raw: string | undefined): string {
  if (!raw) return '';
  return getConfig().resolveSecret(raw) || '';
}

function normalizeTelegramConfig(raw: any): TelegramChannelConfig {
  return {
    enabled: raw?.enabled === true,
    botToken: resolveToken(raw?.botToken),
    allowedUserIds: Array.isArray(raw?.allowedUserIds) ? raw.allowedUserIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0) : [],
    streamMode: raw?.streamMode === 'partial' ? 'partial' : 'full',
  };
}

function normalizeDiscordConfig(raw: any): DiscordChannelConfig {
  return {
    enabled: raw?.enabled === true,
    botToken: resolveToken(raw?.botToken),
    applicationId: String(raw?.applicationId || ''),
    guildId: String(raw?.guildId || ''),
    channelId: String(raw?.channelId || ''),
    webhookUrl: resolveToken(raw?.webhookUrl) || String(raw?.webhookUrl || ''),
  };
}

function normalizeWhatsAppConfig(raw: any): WhatsAppChannelConfig {
  return {
    enabled: raw?.enabled === true,
    accessToken: resolveToken(raw?.accessToken),
    phoneNumberId: String(raw?.phoneNumberId || ''),
    businessAccountId: String(raw?.businessAccountId || ''),
    verifyToken: resolveToken(raw?.verifyToken) || String(raw?.verifyToken || ''),
    webhookSecret: resolveToken(raw?.webhookSecret) || String(raw?.webhookSecret || ''),
    testRecipient: String(raw?.testRecipient || ''),
  };
}

function resolveChannelsConfig(): ChannelsConfig {
  const cfg = getConfig().getConfig() as any;
  const channels = cfg.channels || {};
  const legacyTelegram = cfg.telegram || {};
  return {
    telegram: normalizeTelegramConfig({ ...(channels.telegram || {}), ...legacyTelegram }),
    discord: normalizeDiscordConfig(channels.discord || {}),
    whatsapp: normalizeWhatsAppConfig(channels.whatsapp || {}),
  };
}

// ─── CronScheduler Init ────────────────────────────────────────────────────────

const cronStorePath = path.join(CONFIG_DIR_PATH, 'cron', 'jobs.json');
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
  spawnBackgroundTask: async (job) => {
    try {
      // ── Step 1: ask the preflight advisor to generate a real task plan ──────
      // Awaited properly so the cron scheduler gets a real taskId back.
      let taskTitle = job.name;
      let plan: Array<{ index: number; description: string; status: 'pending' }> = [];

      try {
        const preflight = await callSecondaryPreflight({ userMessage: job.prompt });
        if (preflight?.task_plan && preflight.task_plan.length > 0) {
          taskTitle = preflight.task_title || job.name;
          plan = preflight.task_plan.map((desc: string, i: number) => ({
            index: i,
            description: desc,
            status: 'pending' as const,
          }));
          console.log(`[CronScheduler] Preflight generated ${plan.length} steps for "${job.name}"`);
        }
      } catch (preflightErr: any) {
        console.warn(`[CronScheduler] Preflight unavailable for "${job.name}", using default plan:`, preflightErr.message);
      }

      // ── Step 2: fall back to a smart default plan if preflight gave nothing ─
      if (plan.length === 0) {
        const prompt = job.prompt.toLowerCase();
        const isNews = /news|summar|stories|headlines|brief|report|digest/.test(prompt);
        const isResearch = /research|find|look up|search|gather|collect/.test(prompt);
        const isEmail = /email|inbox|gmail|message/.test(prompt);

        if (isNews) {
          plan = [
            { index: 0, description: 'Search for today\'s top news stories from multiple sources', status: 'pending' },
            { index: 1, description: 'Fetch and read full article content from results', status: 'pending' },
            { index: 2, description: 'Synthesize stories into a concise 3-5 bullet summary with sources', status: 'pending' },
            { index: 3, description: 'Deliver final summary to user', status: 'pending' },
          ];
        } else if (isResearch) {
          plan = [
            { index: 0, description: 'Search for relevant information on the topic', status: 'pending' },
            { index: 1, description: 'Read and extract key details from top results', status: 'pending' },
            { index: 2, description: 'Compile findings into a clear summary', status: 'pending' },
          ];
        } else if (isEmail) {
          plan = [
            { index: 0, description: 'Check inbox for new messages', status: 'pending' },
            { index: 1, description: 'Summarize important emails', status: 'pending' },
          ];
        } else {
          plan = [
            { index: 0, description: `Execute: ${job.prompt.slice(0, 120)}`, status: 'pending' },
            { index: 1, description: 'Review results and deliver output to user', status: 'pending' },
          ];
        }
      }

      // ── Step 3: create the task and launch the runner ────────────────────────
      const cronSessionId = `cron_${job.id}`;
      const task = createTask({
        title: taskTitle,
        prompt: job.prompt,
        sessionId: cronSessionId,
        channel: 'web',
        plan,
      });
      appendJournal(task.id, { type: 'status_push', content: `Scheduled job "${job.name}" launched as background task (${plan.length} steps)` });
      const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
      runner.start().catch((err: any) => console.error(`[CronScheduler] Task ${task.id} error:`, err.message));
      broadcastWS({ type: 'cron_task_spawned', jobId: job.id, jobName: job.name, taskId: task.id });
      return { taskId: task.id, sessionId: cronSessionId };
    } catch (err: any) {
      console.error('[CronScheduler] spawnBackgroundTask failed:', err.message);
      return null;
    }
  },
});

// ─── Telegram Channel Init ─────────────────────────────────────────────────────────

const telegramChannel = new TelegramChannel(
  resolveChannelsConfig().telegram,
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
  configPath: path.join(CONFIG_DIR_PATH, 'heartbeat', 'config.json'),
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
        lines.push(`- [${t.id}] [${t.status}] ${t.title} (step ${step}/${total})`);
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

  // Inject actual memory content so LLM doesn't need to read files during boot
  const memFileToRead = fs.existsSync(todayMem) ? todayMem : fs.existsSync(yesterdayMem) ? yesterdayMem : null;
  if (memFileToRead) {
    try {
      const memContent = fs.readFileSync(memFileToRead, 'utf-8').trim();
      const memFilename = path.basename(memFileToRead);
      lines.push(`memory_content (${memFilename} — last 3000 chars):`);
      lines.push(memContent.slice(-3000));
    } catch {
      lines.push('memory_content: unreadable');
    }
  } else {
    lines.push('memory_content: no memory file found for today or yesterday');
  }

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
      'CONTEXT: Internal startup BOOT.md turn. All data has been pre-fetched and is in the snapshot below.',
      'Do NOT call any tools. Read the snapshot and write a 2-3 sentence startup summary.',
      '[BOOT STARTUP SNAPSHOT - pre-fetched runtime data, no tools needed]',
      startupSnapshot,
      '[/BOOT STARTUP SNAPSHOT]',
    ].join('\n\n');
    const effectiveSessionId = sessionId || bootSessionId;
    setWorkspace(effectiveSessionId, workspacePath);
    const result = await handleChat(message, effectiveSessionId, sendSSE, undefined, undefined, bootContext);
    if (result?.text) {
      broadcastWS({ type: 'boot_greeting', text: result.text, sessionId: effectiveSessionId });
    }
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

// ─── Tiered Prompt System ─────────────────────────────────────────────────────

// Intent detection: returns matched tool categories for the message
function detectToolCategories(text: string): Set<string> {
  const lower = String(text || '').toLowerCase();
  const cats = new Set<string>();
  const WEB = ['search', 'find', 'look up', 'google', 'what is', 'who is', 'news', 'latest', 'research', 'look into', 'check online', 'summarize', 'article', 'read about'];
  const BROWSER = ['open', 'login', 'log in', 'website', 'click', 'fill', 'form', 'navigate', 'go to', 'browse', 'sign in', 'download'];
  const DESKTOP = ['desktop', 'screenshot', 'window', 'focus window', 'app', 'screen', 'type into', 'drag', 'clipboard'];
  const FILES = ['read file', 'write file', 'edit file', 'create file', 'modify', 'replace', 'open file', 'delete file', 'rename', 'copy file', 'make a file', 'update the file', 'change the file', 'save to'];
  const TASK = ['task', 'background', 'run this', 'start a', 'status', 'paused', 'resume', 'in progress', 'what tasks', 'running tasks'];
  const SCHEDULE = ['schedule', 'every day', 'every week', 'at ', 'recurring', 'cron', 'automate', 'remind me', 'daily', 'weekly'];
  const SHELL = ['run command', 'execute', 'terminal', 'powershell', 'script', 'command line', 'cmd', 'bash'];
  const MEMORY = ['remember', 'note that', 'save that', 'write that down', 'dont forget', "don't forget", 'keep in mind', 'update my', 'add to my', 'i prefer', 'i like', 'i hate', 'i use', 'my name', 'call me', 'i work', 'my project', 'my stack'];
  const DEBUG = ['why', 'error', 'failed', 'how does', 'architecture', 'debug', 'caused', 'broke', 'not working', 'explain how', 'whats wrong', "what's wrong"];
  if (WEB.some(k => lower.includes(k))) cats.add('web');
  if (BROWSER.some(k => lower.includes(k))) cats.add('browser');
  if (DESKTOP.some(k => lower.includes(k))) cats.add('desktop');
  if (FILES.some(k => lower.includes(k))) cats.add('files');
  if (TASK.some(k => lower.includes(k))) cats.add('task');
  if (SCHEDULE.some(k => lower.includes(k))) cats.add('schedule');
  if (SHELL.some(k => lower.includes(k))) cats.add('shell');
  if (MEMORY.some(k => lower.includes(k))) cats.add('memory');
  if (DEBUG.some(k => lower.includes(k))) cats.add('debug');
  return cats;
}

// Tool rule blocks — compact, injected only when relevant
const TOOL_BLOCKS: Record<string, string> = {
  web: `WEB TOOLS: web_search(query) → headlines+snippets. web_fetch(url) → full page text. Use web_search first to get URLs, then web_fetch to read. For Reddit: web_search with site:reddit.com "keyword", then web_fetch post URLs — never open browser for Reddit.`,

  browser: `BROWSER TOOLS: browser_open(url) → opens+returns snapshot. browser_snapshot() → refresh elements. browser_click(ref) → click by @ref. browser_fill(ref,text) → fill input. browser_press_key(key) → Enter/Tab/Escape. browser_wait(ms) → wait then snapshot. browser_close() → close tab. Chrome profile is persistent — already logged into sites. SNAPSHOT RULE: browser_open, browser_fill, browser_wait, and browser_click ALL return a fresh snapshot automatically — do NOT call browser_snapshot immediately after any of them. Only call browser_snapshot when you have NOT received a snapshot recently. Calling browser_snapshot twice in a row or after any tool that already returned one is a loop bug — act on the existing snapshot instead. SCROLL RULE: Do NOT scroll/PageDown on an interactive page before reading its snapshot — the compose area and action buttons are visible without scrolling. Read the snapshot refs and act. POST/TWEET RULE: After filling a tweet/post composer, the fill result will show "⚠️ COMPOSER SUBMIT BUTTON: @N" — you MUST click that exact @N ref immediately as your very next action. Do NOT click any other ref, do NOT snapshot, do NOT wait. If no COMPOSER SUBMIT BUTTON annotation appears, find the button named "Post" or "Tweet" that is visually inside the composer area and click it. Filling the textarea alone is NOT completion. After clicking Post, snapshot to verify it was published.`,

  desktop: `DESKTOP TOOLS: desktop_screenshot() → capture+OCR. desktop_find_window(name) → find window. desktop_focus_window(name) → bring to front (use SHORT process name: msedge, chrome, code). desktop_click(x,y) → click coords. desktop_type(text) → type. desktop_press_key(key) → key combo. desktop_drag(x1,y1,x2,y2) → drag. desktop_get_clipboard()/set_clipboard(text). Always screenshot first. Focus window before click/type. Fail twice on focus → stop and report.`,

  files: `FILE TOOLS: read_file(filename) → contents with line numbers. Always read before editing. replace_lines(filename,start,end,content) → surgical edit. insert_after(filename,line,content) → insert. delete_lines(filename,start,end) → delete. find_replace(filename,find,replace) → exact text swap. create_file(filename,content) → new only (fails if exists). delete_file(filename). RULES: read first, surgical edits only, never rewrite whole file for partial changes.`,

  task: `TASK TOOLS: task_control(action,...)  actions: list/get/resume/rerun/pause/delete. start_task(title,prompt) → launch new background task. Check for existing tasks first before creating — never duplicate. Do NOT use read_file to check task state.`,

  schedule: `SCHEDULE TOOL: schedule_job(action,...) actions: list/create/update/pause/resume/delete/run_now. Always confirm before create/update/delete. Keep schedule timing separate from instruction_prompt content.`,

  shell: `SHELL TOOL: run_command(command) → opens app for user to see (chrome, notepad, vscode). For web automation use browser_* not run_command. For desktop interaction use desktop_* not run_command.`,

  memory: `MEMORY TOOLS: memory_browse(file) → list categories in user.md or soul.md. memory_write(file,category,content) → add/update a fact (creates category if new). memory_read(file) → full file contents. File is "user" or "soul". Browse first to find the right category. Write immediately when you learn something — don't wait.`,

  debug: `DEBUG: If asked about errors or architecture, use read_source(file) to inspect SmallClaw source. SELF.md has architecture overview. Workspace files: IDENTITY.md, SOUL.md, USER.md, TOOLS.md, SELF.md. Read the relevant one before diagnosing.`,
};

// Read memory categories for a specific file (for category-aware injection)
function readMemoryCategories(workspacePath: string, file: 'user' | 'soul'): string[] {
  const filename = file === 'user' ? 'USER.md' : 'SOUL.md';
  const filePath = path.join(workspacePath, filename);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const matches = content.match(/^##\s+([^\n]+)/gm) || [];
  return matches.map(m => m.replace(/^##\s+/, '').trim());
}

// Read memory snippets matching detected categories (for category-aware injection)
function readMemorySnippets(workspacePath: string, categories: string[]): string {
  if (categories.length === 0) return '';
  const snippets: string[] = [];
  for (const file of ['USER.md', 'SOUL.md']) {
    const filePath = path.join(workspacePath, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let inSection = false;
    let currentSection = '';
    const sectionLines: string[] = [];
    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)/);
      if (headingMatch) {
        if (inSection && sectionLines.length > 0) {
          snippets.push(`[${file}:${currentSection}]\n${sectionLines.join('\n')}`);
        }
        currentSection = headingMatch[1].trim();
        inSection = categories.some(cat => currentSection.toLowerCase().includes(cat.toLowerCase()) || cat.toLowerCase().includes(currentSection.toLowerCase()));
        sectionLines.length = 0;
      } else if (inSection && line.trim()) {
        sectionLines.push(line);
      }
    }
    if (inSection && sectionLines.length > 0) {
      snippets.push(`[${file}:${currentSection}]\n${sectionLines.join('\n')}`);
    }
  }
  return snippets.slice(0, 6).join('\n\n');
}

// Map tool categories to memory category keywords
const TOOL_TO_MEMORY_CATS: Record<string, string[]> = {
  web: ['web', 'research', 'search'],
  browser: ['browser', 'web'],
  files: ['files', 'coding', 'editing', 'development'],
  task: ['tasks', 'workflow'],
  schedule: ['schedule', 'automation'],
  shell: ['shell', 'commands'],
  memory: ['preferences', 'communication'],
};

async function buildPersonalityContext(
  sessionId: string,
  workspacePath: string,
  messageText: string,
  executionMode: string,
  historyLength: number,
): Promise<string> {

  // ── Path B: autonomous execution — full prompt, no changes ─────────────────
  const isAutonomous = executionMode === 'background_task' || executionMode === 'cron' || executionMode === 'heartbeat';
  if (isAutonomous) {
    const identity = loadWorkspaceFile(workspacePath, 'IDENTITY.md', 400);
    const soul = loadWorkspaceFile(workspacePath, 'SOUL.md', 800);
    const user = loadWorkspaceFile(workspacePath, 'USER.md', 600);
    const today = new Date().toISOString().split('T')[0];
    const intradayPath = path.join(workspacePath, 'memory', `${today}-intraday-notes.md`);
    const intradayNotes = fs.existsSync(intradayPath) ? fs.readFileSync(intradayPath, 'utf-8').trim().slice(-600) : '';
    const parts = [
      identity ? `[IDENTITY]\n${identity}` : '',
      soul ? `[SOUL]\n${soul}` : '',
      user ? `[USER]\n${user}` : '',
      intradayNotes ? `[TODAY_NOTES]\n${intradayNotes}` : '',
    ].filter(Boolean);
    await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  // ── Path A: interactive chat — tiered ─────────────────────────────────────
  const identity = loadWorkspaceFile(workspacePath, 'IDENTITY.md', 400);
  const user = loadWorkspaceFile(workspacePath, 'USER.md', 500);
  const today = new Date().toISOString().split('T')[0];
  const intradayPath = path.join(workspacePath, 'memory', `${today}-intraday-notes.md`);
  const intradayNotes = fs.existsSync(intradayPath) ? fs.readFileSync(intradayPath, 'utf-8').trim().slice(-600) : '';

  // ── Tier 1: first message in session ──────────────────────────────────────
  if (historyLength === 0) {
    const parts = [
      identity ? `[IDENTITY]\n${identity}` : '',
      user ? `[USER]\n${user}` : '',
      intradayNotes ? `[TODAY_NOTES]\n${intradayNotes}` : '',
    ].filter(Boolean);
    await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  // ── Tier 2 / 3: subsequent messages — detect intent ───────────────────────
  const cats = detectToolCategories(messageText);
  const soul = loadWorkspaceFile(workspacePath, 'SOUL.md', 600);

  // Build tool blocks for detected categories
  const toolBlockParts: string[] = [];
  for (const cat of cats) {
    if (TOOL_BLOCKS[cat]) toolBlockParts.push(TOOL_BLOCKS[cat]);
  }

  // Build memory snippets for categories related to detected tool groups
  const memoryCategoryKeywords: string[] = [];
  for (const cat of cats) {
    const memCats = TOOL_TO_MEMORY_CATS[cat] || [];
    memoryCategoryKeywords.push(...memCats);
  }
  const memorySnippets = memoryCategoryKeywords.length > 0
    ? readMemorySnippets(workspacePath, memoryCategoryKeywords)
    : '';

  // Tier 3: complex/multi-domain — add tools.md hint
  const isComplex = cats.size >= 3 || /\b(how do i|help me|can you|i need to|i want to)\b/i.test(messageText);
  const toolsHint = isComplex ? `\nFor full tool reference: read_file TOOLS.md` : '';

  // Self.md for debug
  const self = cats.has('debug') ? loadWorkspaceFile(workspacePath, 'SELF.md', 600) : '';

  const parts = [
    identity ? `[IDENTITY]\n${identity}` : '',
    user ? `[USER]\n${user}` : '',
    soul ? `[SOUL]\n${soul}` : '',
    intradayNotes ? `[TODAY_NOTES]\n${intradayNotes}` : '',
    toolBlockParts.length > 0 ? `[TOOLS]\n${toolBlockParts.join('\n\n')}${toolsHint}` : (toolsHint ? `[TOOLS]${toolsHint}` : ''),
    memorySnippets ? `[RELEVANT_MEMORY]\n${memorySnippets}` : '',
    self ? `[SELF]\n${self}` : '',
  ].filter(Boolean);

  await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
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
  const toolDefs = [
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
        name: 'write_note',
        description: 'Write a temporary note to today\'s intraday memory file. Works in all sessions (task and chat). Notes persist across the day and are included in tomorrow\'s boot context. Auto-cleaned at end of day.',
        parameters: {
          type: 'object', required: ['content'],
          properties: {
            content: { type: 'string', description: 'Note content — what you found, decided, or want to remember' },
            tag: { type: 'string', description: 'Optional tag: task, debug, discovery, or general (default: general)' },
            task_id: { type: 'string', description: 'Optional task ID if this note is related to a specific task' },
            step: { type: 'string', description: 'Legacy: step label (still accepted, mapped to tag)' },
          },
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
        description: 'Open apps for the USER to see on their screen. NEVER use this to open Chrome or Edge for web automation — those windows have no debug port and are invisible to browser_open/snapshot/click. For any web browsing, always use browser_open instead. Use run_command only for: launching GUI apps like notepad or VS Code.',
        parameters: {
          type: 'object', required: ['command'],
          properties: {
            command: { type: 'string', description: 'Examples: "notepad", "code D:\\project". Do NOT use "chrome" or "msedge" here — use browser_open instead.' },
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
    {
      type: 'function',
      function: {
        name: 'task_control',
        description: 'Query and control background tasks. Use this instead of reading files to discover task status.',
        parameters: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', description: 'One of: list, latest, get, resume, rerun, pause, cancel, delete' },
            task_id: { type: 'string', description: 'Task ID (required for get/pause/cancel/delete; optional for resume/rerun)' },
            status: { type: 'string', description: 'Optional filter: queued|running|paused|stalled|needs_assistance|failed|complete|waiting_subagent' },
            include_all_sessions: { type: 'boolean', description: 'If true, list across all sessions/channels; default false (scoped)' },
            limit: { type: 'number', description: 'Max tasks to return (default 20, max 100)' },
            note: { type: 'string', description: 'Optional operator note to append when resuming/rerunning' },
            confirm: { type: 'boolean', description: 'Required true for destructive actions cancel/delete' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_job',
        description: 'Manage scheduled jobs (list/create/update/pause/resume/delete/run_now). Use for recurring or time-based automation.',
        parameters: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', description: 'One of: list, create, update, pause, resume, delete, run_now' },
            job_id: { type: 'string', description: 'Required for update/pause/resume/delete/run_now' },
            name: { type: 'string', description: 'Job name (create/update)' },
            instruction_prompt: { type: 'string', description: 'What the scheduled run should do (create/update)' },
            schedule: {
              type: 'object',
              properties: {
                kind: { type: 'string', description: 'recurring or one_shot' },
                cron: { type: 'string', description: 'Cron expression for recurring jobs' },
                run_at: { type: 'string', description: 'ISO timestamp for one-shot jobs' },
              },
            },
            timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York)' },
            delivery: {
              type: 'object',
              properties: {
                channel: { type: 'string', description: 'web, telegram, discord, whatsapp' },
                session_target: { type: 'string', description: 'main or isolated' },
              },
            },
            model_override: { type: 'string', description: 'Optional model override for this scheduled job' },
            confirm: { type: 'boolean', description: 'Must be true for create/update/delete actions' },
            limit: { type: 'number', description: 'Optional max jobs returned for list' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'parse_schedule_pattern',
        description: 'Parse natural language schedule patterns to cron expressions. Use before creating schedules to convert user language like "daily at 3:13pm" to proper cron syntax.',
        parameters: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'Natural language pattern, e.g. "daily at 3:13pm", "every weekday at 9am", "weekly on monday"' },
            timezone: { type: 'string', description: 'Optional IANA timezone (e.g. America/New_York). Defaults to UTC.' },
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
    // ── Sub-agent tools ── shown based on subagent_mode toggle ────────────────────────────────────
    ...(() => {
      const subagentMode = (getConfig().getConfig() as any).orchestration?.subagent_mode === true;
      if (subagentMode) {
        // Full Claude Cowork–style: free-form arbitrary spawn (multi-agent ON)
        return [{
          type: 'function' as const,
          function: {
            name: 'subagent_spawn',
            description:
              'Spawn a child agent in an isolated session to handle a parallel subtask. ' +
              'The current task pauses until ALL spawned children complete. ' +
              'Do NOT call this recursively from inside a child task.',
            parameters: {
              type: 'object',
              required: ['task_title', 'task_prompt'],
              properties: {
                task_title:      { type: 'string', description: 'Short title for the sub-agent task' },
                task_prompt:     { type: 'string', description: 'Full instruction for the sub-agent (be precise)' },
                context_snippet: { type: 'string', description: 'Relevant context pre-extracted for the sub-agent (file contents, URLs, etc.)' },
                expected_output: { type: 'string', description: 'What the sub-agent should return when done' },
                profile: {
                  type: 'string',
                  enum: ['file_editor', 'researcher', 'shell_runner', 'reader_only'],
                  description: 'Tool access profile: file_editor=read/write files, researcher=read+web, shell_runner=run_command, reader_only=read only',
                },
              },
            },
          },
        }];
      }
      // Conservative 4B-safe mode: fixed specialist templates (multi-agent OFF)
      return [{
        type: 'function' as const,
        function: {
          name: 'delegate_to_specialist',
          description:
            'Delegate a focused, self-contained subtask to a specialist sub-agent. ' +
            'Use for file edits, research lookups, or shell commands that are narrow and well-scoped. ' +
            'The current task pauses until the specialist completes.',
          parameters: {
            type: 'object',
            required: ['type', 'input'],
            properties: {
              type: {
                type: 'string',
                enum: ['file_editor', 'researcher', 'shell_runner', 'reader_only'],
                description: 'Specialist role',
              },
              input: { type: 'string', description: 'Precise instruction for the specialist' },
              context_snippet: { type: 'string', description: 'Relevant context the specialist needs (file content, URL, etc.)' },
              target_file: { type: 'string', description: 'File to operate on (for file_editor)' },
            },
          },
        },
      }];
    })(),
    // Modular subagent spawning — create custom specialists on the fly
    {
      type: 'function' as const,
      function: {
        name: 'spawn_subagent',
        description:
          'Create and spawn a specialized sub-agent for a specific task. Define the subagent\'s tools, constraints, and instructions dynamically. ' +
          'Perfect for delegating research, analysis, or data extraction to a constrained secondary agent. ' +
          'Subagent configs are persisted and reusable (you can call the same subagent_id again later).',
        parameters: {
          type: 'object',
          required: ['subagent_id', 'task_prompt'],
          properties: {
            subagent_id: {
              type: 'string',
              description: 'Unique identifier for this subagent (e.g., "news_researcher_v1", "article_analyzer"). Use persistent names so you can call it again.',
            },
            task_prompt: {
              type: 'string',
              description: 'The specific task for this subagent to complete (e.g., "Extract headline and key facts from these 3 Reuters article snapshots").',
            },
            context_data: {
              type: 'object',
              description: 'Optional context to pass to the subagent: snapshots, URLs, previously extracted text, etc.',
            },
            create_if_missing: {
              type: 'object',
              description: 'If subagent does not exist, create it with these specifications. Subagent config files are saved to .smallclaw/subagents/ and can be edited by users.',
              properties: {
                description: {
                  type: 'string',
                  description: 'What this subagent specializes in (e.g., "News article researcher that extracts facts from web pages")',
                },
                allowed_tools: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Tools this subagent can access. Examples: web_fetch, browser_open, browser_click, read_file, time_now. Use wildcard patterns like "browser_*".',
                },
                forbidden_tools: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Explicit tool blacklist to prevent (e.g., ["run_command", "create_file"])',
                },
                system_instructions: {
                  type: 'string',
                  description: 'Detailed instructions for how this subagent should think and behave (personality, priorities, special rules)',
                },
                constraints: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Hard rules the subagent MUST follow (e.g., "Extract ONLY facts, never hallucinate", "Return max 5 items", "Verify facts across 2+ sources")',
                },
                success_criteria: {
                  type: 'string',
                  description: 'Condition for when the subagent has completed successfully (e.g., "When you have extracted headlines and key facts from at least 3 news sources")',
                },
                max_steps: {
                  type: 'number',
                  description: 'Maximum tool calls before stopping (default 20)',
                },
                timeout_ms: {
                  type: 'number',
                  description: 'Maximum milliseconds to wait (default 300000 = 5 minutes)',
                },
                model: {
                  type: 'string',
                  description: 'Optional override of which model runs this subagent',
                },
              },
              required: ['description', 'allowed_tools', 'system_instructions', 'constraints', 'success_criteria'],
            },
          },
        },
      },
    },
    // ── Memory Tools ──────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'memory_browse',
        description: 'List the category sections currently in USER.md or SOUL.md. Call this before memory_write to find the right category or decide to create a new one.',
        parameters: {
          type: 'object',
          required: ['file'],
          properties: {
            file: { type: 'string', description: '"user" for USER.md or "soul" for SOUL.md' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_write',
        description: 'Write a fact or update to USER.md or SOUL.md under a specific category section. Creates the category if it does not exist. Use memory_browse first to pick the right category.',
        parameters: {
          type: 'object',
          required: ['file', 'category', 'content'],
          properties: {
            file: { type: 'string', description: '"user" for USER.md or "soul" for SOUL.md' },
            category: { type: 'string', description: 'Category section name (e.g. "coding", "communication_style", "projects"). Use existing categories when possible.' },
            content: { type: 'string', description: 'The fact or update to write. Be specific and concise. Example: "Prefers vanilla JS over frameworks"' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_read',
        description: 'Read the full contents of USER.md or SOUL.md. Use when you need complete context before making changes.',
        parameters: {
          type: 'object',
          required: ['file'],
          properties: {
            file: { type: 'string', description: '"user" for USER.md or "soul" for SOUL.md' },
          },
        },
      },
    },
    // ── Agent Builder Integration Tools ──────────────────────────────────────
  ] as any[];
  registerAgentBuilderTools(toolDefs);
  return toolDefs;
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

interface TaskControlResponse {
  success: boolean;
  action: string;
  code?: string;
  message?: string;
  scope?: string;
  task?: Record<string, any> | null;
  tasks?: Array<Record<string, any>>;
  candidates?: Array<Record<string, any>>;
}

type ScheduleJobAction =
  | 'list'
  | 'create'
  | 'update'
  | 'pause'
  | 'resume'
  | 'delete'
  | 'run_now';

function normalizeScheduleJobAction(raw: any): ScheduleJobAction | null {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'run-now') return 'run_now';
  if (['list', 'create', 'update', 'pause', 'resume', 'delete', 'run_now'].includes(v)) {
    return v as ScheduleJobAction;
  }
  return null;
}

function summarizeCronJob(job: any): Record<string, any> {
  return {
    id: String(job?.id || ''),
    name: String(job?.name || ''),
    type: String(job?.type || 'recurring'),
    status: String(job?.status || 'scheduled'),
    enabled: job?.enabled !== false,
    schedule: job?.schedule || null,
    runAt: job?.runAt || null,
    tz: job?.tz || null,
    nextRun: job?.nextRun || null,
    lastRun: job?.lastRun || null,
    lastResult: job?.lastResult || null,
    sessionTarget: job?.sessionTarget || 'isolated',
    model: job?.model || null,
  };
}

function normalizeDeliveryChannel(raw: any): 'web' | 'telegram' | 'discord' | 'whatsapp' {
  const v = String(raw || 'web').trim().toLowerCase();
  if (v === 'telegram' || v === 'discord' || v === 'whatsapp') return v;
  return 'web';
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
          // Add https:// only when no URI scheme is present.
          // This preserves file://, chrome://, about:, etc.
          if (url && !hasUriScheme(url)) url = 'https://' + url;
          execCmd = buildBrowserLaunchCommand(app, url);
        }
        // 3. URL/URI → open in default browser
        else if (/^(https?:\/\/|file:\/\/|chrome:\/\/|about:|www\.)/.test(cmd)) {
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

      case 'task_control': {
        const out = await handleTaskControlAction(sessionId, args);
        return {
          name,
          args,
          result: JSON.stringify(out, null, 2),
          error: out.success !== true,
        };
      }

      case 'schedule_job': {
        const action = normalizeScheduleJobAction(args.action);
        if (!action) {
          return {
            name,
            args,
            result: 'schedule_job requires a valid action: list, create, update, pause, resume, delete, run_now',
            error: true,
          };
        }

        const requiresConfirm = action === 'create' || action === 'update' || action === 'delete';
        if (requiresConfirm && args.confirm !== true) {
          return {
            name,
            args,
            result: JSON.stringify({
              success: false,
              needs_confirmation: true,
              action,
              message: `Action "${action}" requires explicit confirmation. Re-run with confirm=true after user says yes.`,
            }, null, 2),
            error: true,
          };
        }

        if (action === 'list') {
          const limitRaw = Number(args.limit);
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
          const jobs = cronScheduler.getJobs().map(summarizeCronJob).slice(0, limit);
          return {
            name,
            args,
            result: JSON.stringify({ success: true, count: jobs.length, jobs }, null, 2),
            error: false,
          };
        }

        const jobId = String(args.job_id || args.jobId || '').trim();

        if (action === 'create') {
          const instructionPrompt = String(args.instruction_prompt || args.prompt || '').trim();
          if (!instructionPrompt) {
            return { name, args, result: 'schedule_job(create) requires instruction_prompt', error: true };
          }

          const schedule = (args.schedule && typeof args.schedule === 'object') ? args.schedule : {};
          const rawKind = String(schedule.kind || args.kind || 'recurring').trim().toLowerCase();
          const kind: 'recurring' | 'one-shot' = (rawKind === 'one_shot' || rawKind === 'one-shot') ? 'one-shot' : 'recurring';
          const cron = String(schedule.cron || args.cron || '').trim();
          const runAtRaw = String(schedule.run_at || args.run_at || '').trim();
          const timezone = String(args.timezone || args.tz || '').trim() || undefined;
          const delivery = (args.delivery && typeof args.delivery === 'object') ? args.delivery : {};
          const channel = normalizeDeliveryChannel(delivery.channel || args.channel);
          const sessionTarget = String(delivery.session_target || args.session_target || 'isolated').toLowerCase() === 'main'
            ? 'main'
            : 'isolated';
          const modelOverride = String(args.model_override || args.model || '').trim() || undefined;
          const nameValue = String(args.name || '').trim() || `Scheduled task ${new Date().toLocaleString()}`;

          if (channel !== 'web') {
            return {
              name,
              args,
              result: `Delivery channel "${channel}" is not enabled for scheduler jobs yet. Use channel "web" for now.`,
              error: true,
            };
          }

          if (kind === 'one-shot') {
            if (!runAtRaw) return { name, args, result: 'schedule.kind=one_shot requires schedule.run_at (ISO datetime)', error: true };
            const parsed = new Date(runAtRaw);
            if (!Number.isFinite(parsed.getTime())) {
              return { name, args, result: `Invalid run_at value: "${runAtRaw}"`, error: true };
            }
          } else if (!cron) {
            return { name, args, result: 'schedule.kind=recurring requires schedule.cron', error: true };
          }

          const created = cronScheduler.createJob({
            name: nameValue,
            prompt: instructionPrompt,
            type: kind,
            schedule: kind === 'recurring' ? cron : undefined,
            runAt: kind === 'one-shot' ? new Date(runAtRaw).toISOString() : undefined,
            tz: timezone,
            sessionTarget,
            model: modelOverride,
          } as any);

          return {
            name,
            args,
            result: JSON.stringify({
              success: true,
              action: 'create',
              job: summarizeCronJob(created),
              message: `Scheduled job "${created.name}" created.`,
            }, null, 2),
            error: false,
          };
        }

        if (!jobId) {
          return { name, args, result: `schedule_job(${action}) requires job_id`, error: true };
        }

        if (action === 'pause') {
          const updated = cronScheduler.updateJob(jobId, { status: 'paused', enabled: false } as any);
          if (!updated) return { name, args, result: `Job not found: ${jobId}`, error: true };
          return { name, args, result: JSON.stringify({ success: true, action: 'pause', job: summarizeCronJob(updated) }, null, 2), error: false };
        }

        if (action === 'resume') {
          const updated = cronScheduler.updateJob(jobId, { status: 'scheduled', enabled: true } as any);
          if (!updated) return { name, args, result: `Job not found: ${jobId}`, error: true };
          return { name, args, result: JSON.stringify({ success: true, action: 'resume', job: summarizeCronJob(updated) }, null, 2), error: false };
        }

        if (action === 'run_now') {
          const exists = cronScheduler.getJobs().some(j => j.id === jobId);
          if (!exists) return { name, args, result: `Job not found: ${jobId}`, error: true };
          cronScheduler.runJobNow(jobId, { respectActiveHours: false }).catch(err =>
            console.error(`[schedule_job] run_now failed for ${jobId}:`, err?.message || err)
          );
          return {
            name,
            args,
            result: JSON.stringify({ success: true, action: 'run_now', job_id: jobId, message: 'Job queued for immediate run.' }, null, 2),
            error: false,
          };
        }

        if (action === 'delete') {
          const ok = cronScheduler.deleteJob(jobId);
          if (!ok) return { name, args, result: `Job not found: ${jobId}`, error: true };
          return {
            name,
            args,
            result: JSON.stringify({ success: true, action: 'delete', job_id: jobId, message: 'Job deleted.' }, null, 2),
            error: false,
          };
        }

        if (action === 'update') {
          const schedule = (args.schedule && typeof args.schedule === 'object') ? args.schedule : {};
          const patch: Record<string, any> = {};

          if (args.name !== undefined) patch.name = String(args.name || '').trim();
          if (args.instruction_prompt !== undefined || args.prompt !== undefined) {
            patch.prompt = String(args.instruction_prompt || args.prompt || '').trim();
          }
          if (args.timezone !== undefined || args.tz !== undefined) {
            patch.tz = String(args.timezone || args.tz || '').trim();
          }
          if (args.model_override !== undefined || args.model !== undefined) {
            const mv = String(args.model_override || args.model || '').trim();
            patch.model = mv || undefined;
          }
          if (args.delivery !== undefined || args.channel !== undefined) {
            const delivery = (args.delivery && typeof args.delivery === 'object') ? args.delivery : {};
            const channel = normalizeDeliveryChannel(delivery.channel || args.channel);
            if (channel !== 'web') {
              return {
                name,
                args,
                result: `Delivery channel "${channel}" is not enabled for scheduler jobs yet. Use channel "web" for now.`,
                error: true,
              };
            }
            const sessionTarget = String(delivery.session_target || args.session_target || '').toLowerCase();
            if (sessionTarget === 'main' || sessionTarget === 'isolated') patch.sessionTarget = sessionTarget;
          }

          const rawKind = String(schedule.kind || args.kind || '').trim().toLowerCase();
          if (rawKind === 'one_shot' || rawKind === 'one-shot') patch.type = 'one-shot';
          if (rawKind === 'recurring') patch.type = 'recurring';
          if (schedule.cron !== undefined || args.cron !== undefined) patch.schedule = String(schedule.cron || args.cron || '').trim();
          if (schedule.run_at !== undefined || args.run_at !== undefined) patch.runAt = String(schedule.run_at || args.run_at || '').trim();

          if (Object.keys(patch).length === 0) {
            return { name, args, result: 'No update fields provided for schedule_job(update).', error: true };
          }

          if (patch.type === 'one-shot' && !patch.runAt) {
            return { name, args, result: 'Updating to one_shot requires schedule.run_at', error: true };
          }
          if (patch.type === 'recurring' && patch.schedule === '') {
            return { name, args, result: 'Updating to recurring requires schedule.cron', error: true };
          }
          if (patch.runAt) {
            const parsed = new Date(String(patch.runAt));
            if (!Number.isFinite(parsed.getTime())) {
              return { name, args, result: `Invalid run_at value: "${patch.runAt}"`, error: true };
            }
            patch.runAt = parsed.toISOString();
          }

          const updated = cronScheduler.updateJob(jobId, patch as any);
          if (!updated) return { name, args, result: `Job not found: ${jobId}`, error: true };
          return {
            name,
            args,
            result: JSON.stringify({
              success: true,
              action: 'update',
              job: summarizeCronJob(updated),
              message: `Scheduled job "${updated.name}" updated.`,
            }, null, 2),
            error: false,
          };
        }

        return { name, args, result: `Unsupported schedule_job action: ${action}`, error: true };
      }

      case 'spawn_subagent': {
        // Spawn a specialized sub-agent with restricted tool set
        // This is used by primary agents to delegate work to secondary specialists
        try {
          const subagentId = String(args.subagent_id || '').trim();
          const taskPrompt = String(args.task_prompt || '').trim();
          const contextData = args.context_data && typeof args.context_data === 'object' ? args.context_data : undefined;
          const createIfMissing = args.create_if_missing && typeof args.create_if_missing === 'object' ? args.create_if_missing : undefined;

          if (!subagentId) {
            return { name, args, result: 'spawn_subagent requires subagent_id', error: true };
          }
          if (!taskPrompt) {
            return { name, args, result: 'spawn_subagent requires task_prompt', error: true };
          }

          // Get workspace path from config
          const workspacePath = getConfig().getConfig().workspace?.path || process.cwd();

          // Create SubagentManager with broadcast capability
          const subagentMgr = new SubagentManager(workspacePath, broadcastWS);

          // Call the subagent (creates if missing)
          const result = await subagentMgr.callSubagent(
            {
              subagent_id: subagentId,
              task_prompt: taskPrompt,
              context_data: contextData,
              create_if_missing: createIfMissing,
            },
            sessionId // parent task ID (session context)
          );

          return {
            name,
            args,
            result: JSON.stringify(result, null, 2),
            error: false,
          };
        } catch (err: any) {
          return { name, args, result: `spawn_subagent error: ${err.message}`, error: true };
        }
      }

      case 'parse_schedule_pattern': {
        const text = String(args.text || '').trim();
        if (!text) {
          return { name, args, result: 'parse_schedule_pattern requires text parameter', error: true };
        }
        
        try {
          let cron = '';
          let preview = '';
          const t = text.toLowerCase().trim();
          
          // Helper: extract time from text and handle AM/PM
          function extractTime(text: string): { hour: number; minute: number } | null {
            const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
            if (!timeMatch) return null;
            
            let hour = parseInt(timeMatch[1], 10);
            const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
            const period = timeMatch[3]?.toLowerCase();
            
            if (period === 'pm' && hour !== 12) {
              hour += 12;
            } else if (period === 'am' && hour === 12) {
              hour = 0;
            }
            
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
            
            return { hour, minute };
          }
          
          if (t.includes('daily') || t.includes('every day')) {
            const timeInfo = extractTime(t);
            if (timeInfo) {
              const hourStr = String(timeInfo.hour).padStart(2, '0');
              const minStr = String(timeInfo.minute).padStart(2, '0');
              cron = `${timeInfo.minute} ${timeInfo.hour} * * *`;
              preview = `Daily at ${hourStr}:${minStr}`;
            } else {
              cron = '0 9 * * *';
              preview = 'Daily at 09:00';
            }
          } else if (t.includes('weekly')) {
            const timeInfo = extractTime(t);
            if (timeInfo) {
              cron = `${timeInfo.minute} ${timeInfo.hour} * * 1`;
              preview = `Weekly on Monday at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
            } else {
              cron = '0 9 * * 1';
              preview = 'Weekly on Monday at 09:00';
            }
          } else if (t.includes('monday') || t.includes('tuesday') || t.includes('wednesday') || t.includes('thursday') || t.includes('friday')) {
            const timeInfo = extractTime(t);
            if (timeInfo) {
              cron = `${timeInfo.minute} ${timeInfo.hour} * * 1-5`;
              preview = `Weekdays at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
            } else {
              cron = '0 9 * * 1-5';
              preview = 'Weekdays at 09:00';
            }
          } else if (/^\d{1,2} \d{1,2} \d|\d \d \*/.test(t)) {
            cron = t;
            preview = 'Custom cron pattern';
          } else {
            return {
              name,
              args,
              result: JSON.stringify({
                success: false,
                error: 'Could not parse pattern. Try: "daily at 3:13pm", "daily at 15:13", "weekly", or cron like "0 9 * * *"',
              }, null, 2),
              error: true,
            };
          }
          
          return {
            name,
            args,
            result: JSON.stringify({
              success: true,
              cron,
              preview,
              timezone: args.timezone || 'UTC',
            }, null, 2),
            error: false,
          };
        } catch (err: any) {
          return { name, args, result: `parse_schedule_pattern error: ${err.message}`, error: true };
        }
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

      case 'memory_browse': {
        const mbFile = String(args.file || 'user').toLowerCase().trim();
        const mbFilename = mbFile === 'soul' ? 'SOUL.md' : 'USER.md';
        const mbPath = path.join(workspacePath, mbFilename);
        if (!fs.existsSync(mbPath)) {
          return { name, args, result: `${mbFilename} not found. Create it first.`, error: true };
        }
        const mbContent = fs.readFileSync(mbPath, 'utf-8');
        const mbMatches = mbContent.match(/^## (.+)/gm) || [];
        const mbCategories = mbMatches.map((m: string) => m.replace(/^## /, '').trim());
        if (mbCategories.length === 0) {
          return { name, args, result: `${mbFilename} has no categories yet. Use memory_write to create the first one.`, error: false };
        }
        return { name, args, result: `${mbFilename} categories:\n${mbCategories.map((c: string) => `- ${c}`).join('\n')}\n\nUse memory_write(file="${mbFile}", category="<name>", content="...") to add a fact.`, error: false };
      }

      case 'memory_write': {
        const mwFile = String(args.file || 'user').toLowerCase().trim();
        const mwCategory = String(args.category || '').trim().toLowerCase().replace(/\s+/g, '_');
        const mwContent = String(args.content || '').trim();
        if (!mwCategory) return { name, args, result: 'memory_write: category is required', error: true };
        if (!mwContent) return { name, args, result: 'memory_write: content is required', error: true };
        const mwFilename = mwFile === 'soul' ? 'SOUL.md' : 'USER.md';
        const mwPath = path.join(workspacePath, mwFilename);
        if (!fs.existsSync(mwPath)) return { name, args, result: `${mwFilename} not found`, error: true };
        let mwFileContent = fs.readFileSync(mwPath, 'utf-8');
        const mwDate = new Date().toISOString().split('T')[0];
        const mwEntry = `- ${mwContent} [${mwDate}]`;
        const mwSectionHeader = `## ${mwCategory}`;
        const mwSectionIdx = mwFileContent.indexOf(`\n${mwSectionHeader}`);
        if (mwSectionIdx !== -1) {
          // Section exists — find end of section, insert before next ## or EOF
          const afterHeader = mwSectionIdx + mwSectionHeader.length + 1;
          const nextSection = mwFileContent.indexOf('\n## ', afterHeader);
          const insertAt = nextSection !== -1 ? nextSection : mwFileContent.length;
          mwFileContent = mwFileContent.slice(0, insertAt) + '\n' + mwEntry + mwFileContent.slice(insertAt);
        } else {
          // New category — append before closing --- or at end
          const closingComment = mwFileContent.lastIndexOf('\n---');
          const insertAt = closingComment !== -1 ? closingComment : mwFileContent.length;
          mwFileContent = mwFileContent.slice(0, insertAt) + '\n\n' + mwSectionHeader + '\n' + mwEntry + mwFileContent.slice(insertAt);
        }
        fs.writeFileSync(mwPath, mwFileContent, 'utf-8');
        return { name, args, result: `Written to ${mwFilename} [${mwCategory}]: ${mwContent}`, error: false };
      }

      case 'memory_read': {
        const mrFile = String(args.file || 'user').toLowerCase().trim();
        const mrFilename = mrFile === 'soul' ? 'SOUL.md' : 'USER.md';
        const mrPath = path.join(workspacePath, mrFilename);
        if (!fs.existsSync(mrPath)) return { name, args, result: `${mrFilename} not found`, error: true };
        const mrContent = fs.readFileSync(mrPath, 'utf-8');
        return { name, args, result: mrContent, error: false };
      }

      case 'write_note': {
        const noteContent = String(args.content || '').trim();
        if (!noteContent) {
          return { name, args, result: 'write_note: empty content', error: true };
        }
        const noteTag = String(args.tag || args.step || 'general').trim();
        const noteTaskId = args.task_id ? String(args.task_id) : null;

        // Always write to intraday notes file (works in all sessions)
        try {
          const noteDate = new Date().toISOString().split('T')[0];
          const memDir = path.join(workspacePath, 'memory');
          if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
          const intradayFile = path.join(memDir, `${noteDate}-intraday-notes.md`);
          const timestamp = new Date().toISOString();
          let entry = `\n### [${noteTag.toUpperCase()}] ${timestamp}\n${noteContent}`;
          if (noteTaskId) entry += `\n_Related task: ${noteTaskId}_`;
          fs.appendFileSync(intradayFile, entry + '\n');
        } catch (err: any) {
          return { name, args, result: `write_note: failed to write intraday note: ${err.message}`, error: true };
        }

        // Also append to task journal if in a task session
        const isTaskSession = String(sessionId || '').startsWith('task_');
        if (isTaskSession) {
          try {
            const taskId = sessionId.replace(/^task_/, '');
            const { appendJournal } = require('./task-store');
            appendJournal(taskId, {
              type: 'write_note',
              content: `[${noteTag}] ${noteContent.slice(0, 300)}`,
              detail: noteContent.slice(0, 2000),
            });
          } catch {}
        }

        return { name, args, result: `Note saved [${noteTag}] (${noteContent.length} chars) → intraday-notes`, error: false };
      }

      // ── Agent Builder Integration ────────────────────────────────────────────
      case 'architect_workflow':
      case 'verify_workflow_credentials':
      case 'test_workflow':
      case 'deploy_workflow':
      case 'get_workflow_status':
      case 'search_workflow_templates':
      case 'execute_workflow_template':
      case 'create_node_subagent': {
        const result = await executeAgentBuilderTool(name, args);
        return { name, args, result, error: false };
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

function goalIsInteractiveAction(goal: string): boolean {
  // Returns true when the user's goal is to DO something on the page (post, click, fill, submit)
  // rather than READ or RESEARCH. Used to skip feed-collection mode on social feeds.
  return /\b(post|tweet|retweet|reply|send|publish|submit|compose|write.*tweet|make.*post|create.*post|type.*message|fill|click|navigate to|go to|open composer|draft)\b/i.test(String(goal || ''));
}

function isBrowserHeavyResearchPage(input: {
  url?: string;
  pageType?: string;
  snapshotElements?: number;
  feedCount?: number;
  goal?: string;
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
    /Snapshot diagnostics:\s*scanned=([0-9]*)\s+included=([0-9]*)\s+hidden=([0-9]*)\s+unlabeled_non_input=([0-9]*)\s+unnamed_input_included=([0-9]*)/i,
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
  // Scroll-before-act gate: tracks whether a fill/click has happened yet this turn.
  // Blocks PageDown/scroll calls on interactive pages until the model actually acts.
  let browserFillOrClickDoneThisTurn = false;
  let browserScrollBeforeActCount = 0;
  const SCROLL_BEFORE_ACT_MAX = 1; // allow at most 1 scroll before a fill/click
  let desktopContinuationPending = false;
  let desktopAdvisorRoute: 'answer_now' | 'continue_desktop' | 'handoff_primary' | null = null;
  let desktopAdvisorHintPreview = '';
  let desktopAdvisorCallsThisTurn = 0;
  let browserAdvisorLastHash = '';
  let browserAdvisorUrlKey = '';
  let consecutiveUnchangedSnapshots = 0;
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
  // User preference: no automatic browser retries/snapshots.
  // Let the model explicitly decide when to call browser_snapshot.
  const browserAutoSnapshotRetriesEnabled = false;
  const browserMaxForcedRetries = browserAutoSnapshotRetriesEnabled
    ? (orchRuntimeCfg?.browser?.max_forced_retries ?? 2)
    : 0;
  const browserMaxAdvisorCallsPerTurn = orchRuntimeCfg?.browser?.max_advisor_calls_per_turn ?? 5;
  const desktopMaxAdvisorCallsPerTurn = 4;
  const browserMaxCollectedItems = orchRuntimeCfg?.browser?.max_collected_items ?? 80;
  const browserMinFeedItemsBeforeAnswer = orchRuntimeCfg?.browser?.min_feed_items_before_answer ?? 12;
  const browserStabilizeMaxWaitRetries = browserAutoSnapshotRetriesEnabled ? 2 : 0;
  const browserStabilizeMaxTabProbes = browserAutoSnapshotRetriesEnabled ? 2 : 0;
  const browserPacketMaxItems = Math.max(12, Math.min(60, Math.min(browserMaxCollectedItems, 40)));
  const seenToolCalls = new Set<string>();
  const cachedReadOnlyToolResults = new Map<string, ToolResult>();
  const canReplayReadOnlyCall = (toolName: string): boolean =>
    toolName === 'list_files' || toolName === 'read_file';
  const loopDetectionEnabled = orchRuntimeCfg?.triggers?.loop_detection !== false;
  const loopWarningThreshold = 3;
  const loopCriticalThreshold = 5;
  const loopWarnNudged = new Set<string>();
  const loopBlockNudged = new Set<string>();
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
    if (!loopDetectionEnabled) return { state: 'ok', repeats: 1 };
    const argsHash = hashArgs(args);
    // Count includes this current attempt so thresholds are exact:
    // warning at 3rd identical call, block at 5th.
    const repeats = recentToolCalls.filter((t) => t.name === toolName && t.argsHash === argsHash).length + 1;
    recentToolCalls.push({ name: toolName, argsHash });
    if (recentToolCalls.length > 20) recentToolCalls.shift();
    if (repeats >= loopCriticalThreshold) return { state: 'block', repeats };
    if (repeats >= loopWarningThreshold) return { state: 'warn', repeats };
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

  const personalityCtx = await buildPersonalityContext(sessionId, workspacePath, message, executionMode || 'interactive', history.length);

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
      content: `${executionModeSystemBlock ? `${executionModeSystemBlock}\n\n` : ''}You are SmallClaw 🦞, a local AI assistant.\nCurrent date: ${dateStr}, ${timeStr}.\nNever search for or link SmallClaw repos unless the user is asking about SmallClaw itself.\nThis app runs on the user's own machine — browser/desktop automation requests are pre-authorized.\nKeep responses SHORT (1-2 sentences). Don't think out loud. Act and report. Greet naturally without tools.${callerContext ? '\n\n' + callerContext : ''}${browserStateCtx}${personalityCtx}${skillsManager.buildPromptContext(500)}\n\n${getWorkflowContextBlock()}`,
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
    const preflightBlockedTask = findBlockedTaskForSession(sessionId);
    const preflight = await callSecondaryPreflight({
      userMessage: message,
      recentHistory: history.slice(-4).map(h => ({ role: h.role, content: h.content })),
      blockedTask: preflightBlockedTask
        ? {
            id: preflightBlockedTask.id,
            title: preflightBlockedTask.title,
            status: preflightBlockedTask.status,
            currentStepIndex: preflightBlockedTask.currentStepIndex,
            planLength: Array.isArray(preflightBlockedTask.plan) ? preflightBlockedTask.plan.length : 0,
            pauseReason: preflightBlockedTask.pauseReason,
          }
        : undefined,
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
        const taskChannel = inferTaskChannelFromSession(sessionId);
        const parsedTelegramChatId = taskChannel === 'telegram'
          ? Number(String(sessionId || '').replace(/^telegram_/, ''))
          : NaN;
        const telegramChatId = Number.isFinite(parsedTelegramChatId) && parsedTelegramChatId > 0
          ? parsedTelegramChatId
          : undefined;
        const task = createTask({
          title: taskTitle,
          prompt: message,
          sessionId,
          channel: taskChannel,
          telegramChatId,
          plan: taskPlan.length > 0 ? taskPlan : [{ index: 0, description: 'Execute task', status: 'pending' }],
        });
        appendJournal(task.id, { type: 'status_push', content: `Task queued: ${taskTitle}` });
        // Fire background runner (detached — does not block HTTP response)
        const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
        runner.start().catch(err => console.error(`[BackgroundTaskRunner] Task ${task.id} error:`, err.message));
        const queuedMessage = preflight.friendly_queued_message
          || `On it! I've queued "${taskTitle}" as a background task. You can track progress in the Tasks panel.`;
        sendSSE('task_queued', { taskId: task.id, title: taskTitle });
        logToDaily(workspacePath, 'SmallClaw', queuedMessage);
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
        logToDaily(workspacePath, 'SmallClaw', text);
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
          const taskChannel = inferTaskChannelFromSession(sessionId);
          const parsedTelegramChatId = taskChannel === 'telegram'
            ? Number(String(sessionId || '').replace(/^telegram_/, ''))
            : NaN;
          const telegramChatId = Number.isFinite(parsedTelegramChatId) && parsedTelegramChatId > 0
            ? parsedTelegramChatId
            : undefined;
          const task = createTask({
            title: taskTitle,
            prompt: message,
            sessionId,
            channel: taskChannel,
            telegramChatId,
            plan: taskPlan.length > 0 ? taskPlan : [{ index: 0, description: 'Execute task', status: 'pending' }],
          });
          appendJournal(task.id, { type: 'status_push', content: `Task queued (upgraded from primary_with_plan): ${taskTitle}` });
          const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
          runner.start().catch((err: Error) => console.error(`[BackgroundTaskRunner] Task ${task.id} error:`, err.message));
          const queuedMessage = preflight.friendly_queued_message
            || `On it! I've queued "${taskTitle}" as a background task. You can track progress in the Tasks panel.`;
          sendSSE('task_queued', { taskId: task.id, title: taskTitle });
          logToDaily(workspacePath, 'SmallClaw', queuedMessage);
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
    consecutiveUnchangedSnapshots = 0;
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
    if (hashUnchanged && !browserContinuationPending) {
      // On non-feed interactive pages, a stuck snapshot hash means the model is looping.
      // After 2 consecutive identical snapshots, force the advisor to run so it generates
      // a concrete @ref-based action instead of silently returning and letting the model re-snapshot.
      consecutiveUnchangedSnapshots += 1;
      if (consecutiveUnchangedSnapshots >= 2) {
        // Force advisor call — override the early return so it runs with existing data.
        // Applies to ALL page types including feed pages: if the snapshot hasn't changed,
        // the model is looping and needs a concrete directive from the advisor.
        browserContinuationPending = true;
        browserAdvisorRoute = 'continue_browser';
        browserAdvisorHintPreview = 'Snapshot unchanged — forcing advisor to generate concrete action';
        sendSSE('info', { message: `Snapshot hash unchanged (${consecutiveUnchangedSnapshots}x) — forcing browser advisor to generate concrete action.` });
        // Don't return — fall through to advisor call below
      } else {
        return;
      }
    } else {
      consecutiveUnchangedSnapshots = 0;
    }
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
    if (browserAutoSnapshotRetriesEnabled && packet.page.pageType === 'chat_interface' && packet.isGenerating) {
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

    if (browserAutoSnapshotRetriesEnabled && (isCollectMoreScroll || isCollectMoreWait)) {
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
      logToDaily(workspacePath, 'SmallClaw', text);
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
      logToDaily(workspacePath, 'SmallClaw', finalText);
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
      // DISABLED: Force continuation was causing excessive unnecessary tool calls
      // Users should get immediate final response, not artificial padding
      const shouldContinueInsteadOfFinalizing = false;

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

      logToDaily(workspacePath, 'SmallClaw', finalText);
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

      // ── Scroll-before-act gate ────────────────────────────────────────────────
      // Block PageDown / browser_scroll on interactive pages when the model hasn't
      // filled or clicked anything yet. This is the #1 cause of the scroll loop bug
      // where the AI scrolls past the X.com composer instead of filling it.
      // Feed/search pages (x_feed, search_results) are exempt — they need scrolling.
      const isScrollAttempt =
        (toolName === 'browser_press_key' && String(toolArgs?.key || '').toLowerCase() === 'pagedown')
        || toolName === 'browser_scroll';
      if (isScrollAttempt && !browserFillOrClickDoneThisTurn) {
        const sessionInfo = getBrowserSessionInfo(sessionId);
        const currentPacket = sessionInfo.active
          ? await getBrowserAdvisorPacket(sessionId, { maxItems: 0, snapshotElements: 10 }).catch(() => null)
          : null;
        const pageType = currentPacket?.page?.pageType || 'generic';
        const isFeedPage = pageType === 'x_feed' || pageType === 'search_results';
        if (!isFeedPage) {
          browserScrollBeforeActCount++;
          if (browserScrollBeforeActCount > SCROLL_BEFORE_ACT_MAX) {
            const lastSnap = currentPacket?.snapshot || '';
            const blockMsg = [
              `SCROLL BLOCKED: You scrolled ${browserScrollBeforeActCount} time(s) without filling or clicking anything.`,
              `This is the scroll-before-act loop bug. The page already shows actionable elements — stop scrolling and act on them.`,
              lastSnap ? `\nCurrent page snapshot (act on these @ref elements NOW):\n${lastSnap.slice(0, 2000)}` : '',
              `\nRequired next action: find the input or button you need and call browser_fill(ref, text) or browser_click(ref) immediately.`,
              `Do NOT call browser_press_key(PageDown), browser_scroll, or browser_snapshot. Act on the snapshot above.`,
            ].filter(Boolean).join(' ');
            console.warn(`[v2] SCROLL-BEFORE-ACT BLOCKED (${browserScrollBeforeActCount}x): ${toolName} on ${pageType} page before any fill/click`);
            sendSSE('info', { message: `Scroll-before-act gate: blocked ${toolName} on non-feed page (${browserScrollBeforeActCount}/${SCROLL_BEFORE_ACT_MAX} allowed before act required).` });
            const blockedResult: ToolResult = { name: toolName, args: toolArgs, result: blockMsg, error: true };
            allToolResults.push(blockedResult);
            logToolCall(workspacePath, toolName, toolArgs, blockMsg, true);
            sendSSE('tool_call', { action: toolName, args: toolArgs, stepNum: allToolResults.length });
            sendSSE('tool_result', { action: toolName, result: blockMsg.slice(0, 300), error: true, stepNum: allToolResults.length });
            messages.push({ role: 'tool', tool_name: toolName, tool_call_id: toolCallId || undefined, content: blockMsg });
            messages.push({ role: 'user', content: `Scroll blocked. You must call browser_fill or browser_click on a @ref from the snapshot above before scrolling. Stop planning and act now.` });
            continue;
          }
        }
      }
      // Track fills and clicks so the gate knows when it's safe to scroll
      if (toolName === 'browser_fill' || toolName === 'browser_click') {
        browserFillOrClickDoneThisTurn = true;
        browserScrollBeforeActCount = 0;
      }
      // ── End scroll-before-act gate ────────────────────────────────────────────

      const loopSig = `${toolName}:${hashArgs(toolArgs)}`;
      const loopPivotNudge = 'Loop detector: you are looping on this tool, try a different approach or ask the user.';
      const loopCheck = checkLoopDetection(toolName, toolArgs);
      if (loopCheck.state === 'block') {
        const blockMsg = `${loopPivotNudge} Repeated call blocked: ${toolName} with identical arguments has run ${loopCheck.repeats} times (critical threshold ${loopCriticalThreshold}).`;
        console.warn(`[v2] LOOP BLOCK: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}) x${loopCheck.repeats}`);
        const blockedResult: ToolResult = {
          name: toolName,
          args: toolArgs,
          result: blockMsg,
          error: true,
        };
        allToolResults.push(blockedResult);
        logToolCall(workspacePath, toolName, toolArgs, blockMsg, true);
        sendSSE('info', { message: blockMsg });
        sendSSE('tool_result', {
          action: toolName,
          result: blockMsg,
          error: true,
          stepNum: allToolResults.length,
        });
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: blockMsg,
        });
        if (!loopBlockNudged.has(loopSig)) {
          loopBlockNudged.add(loopSig);
          messages.push({
            role: 'user',
            content: `${loopPivotNudge} Do not call ${toolName} with the same arguments again this turn.`,
          });
        }
        continue;
      }
      if (loopCheck.state === 'warn') {
        const warnMsg = `${loopPivotNudge} Warning: ${toolName} with identical arguments repeated ${loopCheck.repeats} times (warning threshold ${loopWarningThreshold}).`;
        console.warn(`[v2] LOOP WARN: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}) x${loopCheck.repeats}`);
        sendSSE('info', { message: warnMsg });
        if (!loopWarnNudged.has(loopSig)) {
          loopWarnNudged.add(loopSig);
          messages.push({
            role: 'user',
            content: warnMsg,
          });
        }
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
        const cachedResult = canReplayReadOnlyCall(toolName)
          ? cachedReadOnlyToolResults.get(callKey)
          : undefined;
        if (cachedResult) {
          const replayedResult: ToolResult = {
            ...cachedResult,
            args: toolArgs,
          };
          allToolResults.push(replayedResult);
          if (!replayedResult.error) roundHadProgress = true;
          logToolCall(workspacePath, toolName, toolArgs, replayedResult.result, replayedResult.error);
          console.log(`[v2] REPLAY: duplicate ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);
          sendSSE('tool_result', {
            action: toolName,
            result: replayedResult.result.slice(0, 500),
            error: replayedResult.error,
            stepNum: allToolResults.length,
          });
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: replayedResult.result,
          });
          continue;
        }
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

        const taskTools = tools.filter((t: any) => t.function.name !== 'start_task') as any[];

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

      // ── Sub-agent spawn / specialist delegate ──────────────────────────────────────────────
      if (toolName === 'delegate_to_specialist' || toolName === 'subagent_spawn') {
        const isTaskSession = sessionId.startsWith('task_');

        // Determine profile and build child prompt
        const profile = ((toolArgs.profile || toolArgs.type || 'reader_only') as SubagentProfile);
        const subTitle  = String(toolArgs.task_title || `${profile} specialist task`).slice(0, 120);
        const subPrompt = [
          toolArgs.context_snippet ? `[CONTEXT]\n${String(toolArgs.context_snippet).slice(0, 1200)}\n[/CONTEXT]\n\n` : '',
          String(toolArgs.input || toolArgs.task_prompt || '').trim(),
          toolArgs.target_file ? `\n\nTarget file: ${toolArgs.target_file}` : '',
        ].join('').trim();

        if (!subPrompt) {
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: 'Sub-agent spawn failed: no task_prompt or input provided.',
          });
          continue;
        }

        // Guard: do not allow sub-agents to spawn more sub-agents (prevent recursion)
        const parentTaskId = isTaskSession ? sessionId.replace(/^task_/, '') : undefined;
        if (parentTaskId) {
          const parentTask = loadTask(parentTaskId);
          if (parentTask?.parentTaskId) {
            messages.push({
              role: 'tool',
              tool_name: toolName,
              tool_call_id: toolCallId || undefined,
              content: 'Sub-agent recursion blocked: sub-agents cannot spawn further sub-agents.',
            });
            continue;
          }
        }

        const onResumeInstruction =
          `Sub-agent "${subTitle}" has completed. Review the [SUBAGENT RESULT] injected above and continue the parent task.`;
        const parentTask = parentTaskId ? loadTask(parentTaskId) : null;
        const childChannel = parentTask?.channel || inferTaskChannelFromSession(sessionId);

        // Create the child TaskRecord
        const childTask = createTask({
          title: subTitle,
          prompt: subPrompt,
          sessionId: `task_${crypto.randomUUID()}`,
          channel: childChannel,
          plan: [{ index: 0, description: subPrompt.slice(0, 120), status: 'pending' as const }],
          parentTaskId,
          subagentProfile: profile,
          onResumeInstruction,
        });

        // Register child in parent and flip parent to waiting_subagent
        if (parentTaskId) {
          if (parentTask) {
            parentTask.pendingSubagentIds = [...(parentTask.pendingSubagentIds || []), childTask.id];
            parentTask.status = 'waiting_subagent';
            saveTask(parentTask);
          }
        }

        // Spawn the child BackgroundTaskRunner
        const childRunner = new BackgroundTaskRunner(
          childTask.id,
          handleChat,
          makeBroadcastForTask(childTask.id),
          telegramChannel,
        );
        childRunner.start().catch((err: Error) =>
          console.error(`[SubagentSpawn] Child ${childTask.id} error:`, err.message)
        );

        const ackMsg = toolName === 'subagent_spawn'
          ? `Spawned sub-agent "${subTitle}" (ID: ${childTask.id}, profile: ${profile}). Parent task is paused pending completion.`
          : `Delegated to ${profile} specialist (ID: ${childTask.id}). Parent task is paused until specialist completes.`;

        console.log(`[SubagentSpawn] ${ackMsg}`);
        appendJournal(parentTaskId || childTask.id, { type: 'status_push', content: ackMsg });
        broadcastWS({ type: 'task_subagent_spawned', parentTaskId, childTaskId: childTask.id, subTitle, profile });

        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: ackMsg,
        });
        // Break out of the tool loop — parent task status is now waiting_subagent,
        // which the BackgroundTaskRunner will detect on its next iteration.
        break;
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
      if (canReplayReadOnlyCall(toolName)) cachedReadOnlyToolResults.set(callKey, toolResult);
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

const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  'queued',
  'running',
  'paused',
  'stalled',
  'needs_assistance',
  'failed',
  'waiting_subagent',
];

function inferTaskChannelFromSession(sessionId: string): 'web' | 'telegram' {
  return String(sessionId || '').startsWith('telegram_') ? 'telegram' : 'web';
}

function latestTaskForSession(sessionId: string, statuses: TaskStatus[]): TaskRecord | null {
  const tasks = listTasks({ status: statuses })
    .filter(t => t.sessionId === sessionId)
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  return tasks[0] || null;
}

function findBlockedTaskForSession(sessionId: string): TaskRecord | null {
  const blocked = listTasks({ status: ['needs_assistance', 'stalled', 'paused', 'failed'] })
    .filter(t => t.sessionId === sessionId)
    .filter(t =>
      t.status === 'needs_assistance'
      || t.status === 'stalled'
      || t.status === 'failed'
      || (t.status === 'paused' && t.pauseReason !== 'user_pause'),
    )
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  return blocked[0] || null;
}

function isResumeIntent(message: string): boolean {
  const text = message.trim();
  // Must explicitly reference resuming/continuing a task — not just a casual "go ahead"
  // which people often say when starting a NEW task ("go ahead and open chatgpt").
  // Require task context, or an explicit resume/rerun keyword standalone.
  if (/\b(resume|rerun|re-run|run again|retry|restart)\b/i.test(text)) return true;
  if (/\b(continue|proceed)\b.*\b(task|it|that|this)\b/i.test(text)) return true;
  if (/\b(go ahead|do it|apply)\b.*\b(task|resume|rerun)\b/i.test(text)) return true;
  return false;
}

function isRerunIntent(message: string): boolean {
  return /\b(rerun|re-run|run again|retry|restart|start again)\b/i.test(message);
}

function isCancelIntent(message: string): boolean {
  return /\b(cancel|abort|stop( task)?|do not continue|don't continue)\b/i.test(message);
}

function isStatusQuestion(message: string): boolean {
  return /\?|^\s*(what|why|how|status|did|where|when)\b/i.test(message)
    || /\b(what happened|why did|status|stuck|failed|error|progress|what went wrong)\b/i.test(message);
}

function isTaskListIntent(message: string): boolean {
  return /\b(what|which|show|list)\b.*\b(background\s+)?tasks?\b/i.test(message)
    || /\b(background\s+)?tasks?\b.*\b(do we have|running|active|current)\b/i.test(message);
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

function summarizeTaskRecord(task: TaskRecord): Record<string, any> {
  const total = Array.isArray(task.plan) ? task.plan.length : 0;
  const step = Math.min((task.currentStepIndex || 0) + 1, Math.max(1, total));
  const done = (task.plan || []).filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const latestPause = getLatestPauseContext(task);
  return {
    task_id: task.id,
    title: task.title,
    status: task.status,
    pause_reason: task.pauseReason || null,
    step,
    total_steps: Math.max(1, total),
    completed_steps: done,
    last_issue: latestPause.reason || null,
    last_issue_detail: latestPause.detail || null,
    channel: task.channel,
    session_id: task.sessionId,
    last_progress_at: task.lastProgressAt,
    last_progress_iso: new Date(task.lastProgressAt).toISOString(),
    started_at: task.startedAt,
    started_at_iso: new Date(task.startedAt).toISOString(),
    completed_at: task.completedAt || null,
    completed_at_iso: task.completedAt ? new Date(task.completedAt).toISOString() : null,
  };
}

function buildBlockedTaskStatusMessage(task: TaskRecord): string {
  const summary = summarizeTaskRecord(task);
  const lines = [
    `Task status: ${summary.title}`,
    `Status: ${summary.status}`,
    `Step: ${summary.step}/${summary.total_steps} (${summary.completed_steps} completed)`,
    summary.last_issue ? `Last issue: ${summary.last_issue}` : '',
    summary.last_issue_detail ? `Details: ${summary.last_issue_detail}` : '',
    `Task ID: ${summary.task_id}`,
    `You can say: "resume task ${summary.task_id}" or "rerun task ${summary.task_id}".`,
  ];
  return lines.filter(Boolean).join('\n');
}

function parseTaskStatusFilter(raw: any): TaskStatus[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const valid = new Set<TaskStatus>([
    'queued',
    'running',
    'paused',
    'stalled',
    'needs_assistance',
    'failed',
    'complete',
    'waiting_subagent',
  ]);
  const values = String(raw)
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean) as TaskStatus[];
  const filtered = values.filter(v => valid.has(v));
  return filtered.length > 0 ? filtered : undefined;
}

function getTaskScopeBuckets(sessionId: string, statuses?: TaskStatus[]) {
  const all = listTasks(statuses ? { status: statuses } : undefined).sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  const sessionTasks = all.filter(t => t.sessionId === sessionId);
  const channel = inferTaskChannelFromSession(sessionId);
  const channelTasks = all.filter(t => t.channel === channel && t.sessionId !== sessionId);
  return { all, sessionTasks, channelTasks, channel };
}

function parseTaskIdFromText(text: string): string | null {
  const m = String(text || '').match(/\b([a-f0-9]{8}-[a-f0-9-]{27,})\b/i);
  return m ? m[1] : null;
}

function launchBackgroundTaskRunner(taskId: string): void {
  const runner = new BackgroundTaskRunner(taskId, handleChat, makeBroadcastForTask(taskId), telegramChannel);
  runner.start().catch(err => console.error(`[BackgroundTaskRunner] task_control start ${taskId} error:`, err.message));
}

async function handleTaskControlAction(sessionId: string, args: any): Promise<TaskControlResponse> {
  const action = String(args?.action || '').trim().toLowerCase();
  const taskId = String(args?.task_id || args?.id || '').trim();
  const includeAllSessions = args?.include_all_sessions === true;
  const note = String(args?.note || '').trim();
  const limitRaw = Number(args?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 20;
  const statusFilter = parseTaskStatusFilter(args?.status);

  if (!action) {
    return { success: false, action: 'unknown', code: 'invalid_action', message: 'task_control requires action.' };
  }

  if (action === 'list' || action === 'latest') {
    const statuses = statusFilter || (action === 'list' ? ACTIVE_TASK_STATUSES : undefined);
    const scope = getTaskScopeBuckets(sessionId, statuses);
    const tasks = includeAllSessions
      ? scope.all
      : [...scope.sessionTasks, ...scope.channelTasks];
    if (action === 'latest') {
      const latest = tasks[0] || null;
      return {
        success: true,
        action,
        scope: includeAllSessions ? 'all_sessions' : `session+${scope.channel}`,
        task: latest ? summarizeTaskRecord(latest) : null,
        message: latest ? `Latest task is "${latest.title}" (${latest.status}).` : 'No tasks found.',
      };
    }
    const summarized = tasks.slice(0, limit).map(summarizeTaskRecord);
    return {
      success: true,
      action,
      scope: includeAllSessions ? 'all_sessions' : `session+${scope.channel}`,
      tasks: summarized,
      message: summarized.length > 0 ? `Found ${summarized.length} task(s).` : 'No tasks found.',
    };
  }

  if (action === 'get') {
    if (!taskId) return { success: false, action, code: 'missing_task_id', message: 'task_control(get) requires task_id.' };
    const task = loadTask(taskId);
    if (!task) return { success: false, action, code: 'not_found', message: `Task not found: ${taskId}` };
    return { success: true, action, task: summarizeTaskRecord(task), message: `Loaded task "${task.title}".` };
  }

  const resolveCandidateForAction = (candidateAction: 'resume' | 'rerun' | 'pause' | 'cancel' | 'delete') => {
    if (taskId) {
      const exact = loadTask(taskId);
      if (!exact) return { task: null as TaskRecord | null, err: `Task not found: ${taskId}` };
      return { task: exact, err: '' };
    }

    const preferredStatuses: TaskStatus[] =
      candidateAction === 'rerun'
        ? ['needs_assistance', 'stalled', 'paused', 'failed', 'complete']
        : candidateAction === 'delete'
          ? ['needs_assistance', 'stalled', 'paused', 'failed', 'queued', 'complete', 'waiting_subagent']
          // 'running' included so tasks stuck in running state (dead runner) can be resumed
          : ['needs_assistance', 'stalled', 'paused', 'failed', 'queued', 'running'];
    const scope = getTaskScopeBuckets(sessionId, preferredStatuses);
    let preferred = [...scope.sessionTasks, ...scope.channelTasks];
    if (preferred.length === 0) {
      preferred = scope.all;
    }
    if (preferred.length === 0) {
      return { task: null as TaskRecord | null, err: 'No matching task found in current scope.' };
    }
    if (preferred.length === 1) {
      return { task: preferred[0], err: '' };
    }
    return { task: null as TaskRecord | null, err: 'AMBIGUOUS', candidates: preferred.slice(0, 3) };
  };

  if (action === 'resume' || action === 'rerun') {
    const resolved = resolveCandidateForAction(action);
    if (!resolved.task) {
      if (resolved.err === 'AMBIGUOUS') {
        return {
          success: false,
          action,
          code: 'ambiguous',
          message: 'Multiple tasks match. Provide task_id.',
          candidates: (resolved.candidates || []).map(summarizeTaskRecord),
        };
      }
      return { success: false, action, code: 'no_candidate', message: resolved.err };
    }
    const task = loadTask(resolved.task.id);
    if (!task) return { success: false, action, code: 'not_found', message: `Task not found: ${resolved.task.id}` };
    if (BackgroundTaskRunner.isRunning(task.id)) {
      return {
        success: true,
        action,
        task: summarizeTaskRecord(task),
        message: `Task "${task.title}" is already actively running (runner is live).`,
      };
    }

    // Status is 'running' but no active runner found — runner died without cleanup.
    // Auto-correct the stale status so the resume proceeds normally.
    if (task.status === 'running') {
      appendJournal(task.id, { type: 'status_push', content: 'Stale running status detected (no active runner). Auto-correcting to paused for resume.' });
      BackgroundTaskRunner.forceRelease(task.id); // clear any ghost activeRunners entry
      updateTaskStatus(task.id, 'paused', { pauseReason: 'error' });
      task.status = 'paused'; // keep local ref in sync
    }

    if (action === 'resume') {
      if (task.status === 'complete') {
        return { success: false, action, code: 'already_complete', message: `Task "${task.title}" is complete. Use rerun to restart.` };
      }
      updateTaskStatus(task.id, 'queued');
      appendJournal(task.id, { type: 'resume', content: `task_control resume${note ? `: ${note.slice(0, 220)}` : ''}` });
      // Reset self-heal counter so the user's manual intervention gives a fresh start
      task.selfHealAttempts = 0;
      task.resynthAttempts = 0;
      saveTask(task);
      if (note) {
        const resumeMessages = Array.isArray(task.resumeContext?.messages) ? task.resumeContext.messages : [];
        updateResumeContext(task.id, {
          messages: [
            ...resumeMessages,
            { role: 'user', content: `[TASK USER FOLLOW-UP]\n${note}`, timestamp: Date.now() },
          ].slice(-80),
        });
      }
      launchBackgroundTaskRunner(task.id);
      const refreshed = loadTask(task.id) || task;
      return {
        success: true,
        action,
        task: summarizeTaskRecord(refreshed),
        message: `Resumed task "${refreshed.title}" at step ${refreshed.currentStepIndex + 1}/${Math.max(1, refreshed.plan.length)}.`,
      };
    }

    // rerun
    task.status = 'queued';
    task.pauseReason = undefined;
    task.currentStepIndex = 0;
    task.completedAt = undefined;
    task.finalSummary = undefined;
    task.lastToolCall = undefined;
    task.lastToolCallAt = undefined;
    task.lastProgressAt = Date.now();
    task.plan = (task.plan || []).map((step, idx) => ({
      ...step,
      index: idx,
      status: 'pending',
      completedAt: undefined,
      notes: undefined,
    }));
    task.resumeContext = {
      ...(task.resumeContext || {
        messages: [],
        browserSessionActive: false,
        round: 0,
        orchestrationLog: [],
      }),
      messages: [],
      browserSessionActive: false,
      browserUrl: undefined,
      round: 0,
      orchestrationLog: [],
      fileOpState: undefined,
    };
    saveTask(task);
    appendJournal(task.id, { type: 'status_push', content: `task_control rerun${note ? `: ${note.slice(0, 220)}` : ''}` });
    launchBackgroundTaskRunner(task.id);
    const refreshed = loadTask(task.id) || task;
    return {
      success: true,
      action,
      task: summarizeTaskRecord(refreshed),
      message: `Rerunning task "${refreshed.title}" from step 1/${Math.max(1, refreshed.plan.length)}.`,
    };
  }

  if (action === 'pause' || action === 'cancel') {
    const resolved = resolveCandidateForAction(action as any);
    if (!resolved.task) {
      if (resolved.err === 'AMBIGUOUS') {
        return {
          success: false,
          action,
          code: 'ambiguous',
          message: 'Multiple tasks match. Provide task_id.',
          candidates: (resolved.candidates || []).map(summarizeTaskRecord),
        };
      }
      return { success: false, action, code: 'no_candidate', message: resolved.err };
    }
    if (action === 'cancel' && args?.confirm !== true) {
      return { success: false, action, code: 'needs_confirmation', message: 'cancel requires confirm=true.' };
    }
    const task = loadTask(resolved.task.id);
    if (!task) return { success: false, action, code: 'not_found', message: `Task not found: ${resolved.task.id}` };
    if (BackgroundTaskRunner.isRunning(task.id)) {
      BackgroundTaskRunner.requestPause(task.id);
    }
    updateTaskStatus(task.id, 'paused', { pauseReason: 'user_pause' });
    appendJournal(task.id, { type: 'pause', content: `task_control ${action}${note ? `: ${note.slice(0, 220)}` : ''}` });
    const refreshed = loadTask(task.id) || task;
    return {
      success: true,
      action,
      task: summarizeTaskRecord(refreshed),
      message: `${action === 'cancel' ? 'Cancelled' : 'Paused'} task "${refreshed.title}".`,
    };
  }

  if (action === 'delete') {
    if (args?.confirm !== true) {
      return { success: false, action, code: 'needs_confirmation', message: 'delete requires confirm=true.' };
    }
    const resolved = resolveCandidateForAction('delete');
    if (!resolved.task) {
      if (resolved.err === 'AMBIGUOUS') {
        return {
          success: false,
          action,
          code: 'ambiguous',
          message: 'Multiple tasks match. Provide task_id.',
          candidates: (resolved.candidates || []).map(summarizeTaskRecord),
        };
      }
      return { success: false, action, code: 'no_candidate', message: resolved.err };
    }
    if (BackgroundTaskRunner.isRunning(resolved.task.id)) {
      return { success: false, action, code: 'running', message: `Task "${resolved.task.title}" is running. Pause it before delete.` };
    }
    const ok = deleteTask(resolved.task.id);
    if (!ok) return { success: false, action, code: 'not_found', message: `Task not found: ${resolved.task.id}` };
    return { success: true, action, message: `Deleted task "${resolved.task.title}" (${resolved.task.id}).` };
  }

  return { success: false, action, code: 'invalid_action', message: `Unsupported task_control action: ${action}` };
}

function renderTaskCandidatesForHuman(candidates: Array<Record<string, any>>): string {
  if (!Array.isArray(candidates) || candidates.length === 0) return 'No candidates found.';
  return candidates
    .slice(0, 3)
    .map((c, i) => `${i + 1}. ${c.title} [${c.status}] — Task ID: ${c.task_id}`)
    .join('\n');
}

async function tryHandleBlockedTaskFollowup(sessionId: string, rawMessage: string): Promise<string | null> {
  if (String(sessionId || '').startsWith('task_')) return null;
  const message = String(rawMessage || '').trim();
  if (!message) return null;

  // ── Path A: Explicit task UUID in the message (original behavior) ───────────
  const explicitTaskId = parseTaskIdFromText(message);
  if (explicitTaskId) {
    const rerunRequested = isRerunIntent(message);
    const resumeRequested = isResumeIntent(message);
    const cancelRequested = isCancelIntent(message);
    if (!rerunRequested && !resumeRequested && !cancelRequested) return null;
    const action = rerunRequested ? 'rerun' : cancelRequested ? 'pause' : 'resume';
    const ctl = await handleTaskControlAction(sessionId, { action, task_id: explicitTaskId, note: message });
    return ctl.success ? (ctl.message || null) : null;
  }

  // ── Path B: No UUID — look for a blocked/escalated task on this session ─────
  // Handles user messages like "proceed", "I logged in", "go ahead", "fixed it", etc.
  // where the task ID is implicit from context.
  const blockedTask = findBlockedTaskForSession(sessionId);
  if (!blockedTask) return null;

  const cancelRequested = isCancelIntent(message);
  const rerunRequested = isRerunIntent(message);

  // Broad resume detection: standard resume verbs OR short affirmations that only
  // make sense as "yes, continue" replies when a blocked task already exists.
  const resumeRequestedBroad =
    isResumeIntent(message) ||
    /^\s*(proceed|go ahead|ok|okay|continue|yes|yep|sure|do it|keep going|try again|move on|sounds good|ready|done|fixed|logged in|i logged in|it('s| is) fixed|all good)\.?\s*$/i.test(message) ||
    /\b(logged in|fixed it|done now|all set|ready now|proceed|go ahead)\.?$/i.test(message);

  if (!resumeRequestedBroad && !cancelRequested && !rerunRequested) return null;

  // Safety: if the message is long and contains strong new-task language, let it
  // fall through to the AI rather than hijacking it as a resume.
  const hasNewTaskLanguage =
    message.length > 80 &&
    /\b(open|go to|navigate|search for|create a|make a|write a|post a|send a|find me|check the)\b/i.test(message);
  if (hasNewTaskLanguage) return null;

  const action = rerunRequested ? 'rerun' : cancelRequested ? 'pause' : 'resume';
  const ctl = await handleTaskControlAction(sessionId, {
    action,
    task_id: blockedTask.id,
    note: message,
  });

  if (!ctl.success) return null;

  const verb = action === 'resume' ? 'Resuming' : action === 'rerun' ? 'Rerunning' : 'Cancelling';
  const taskLabel = `"${blockedTask.title}"`;
  return `${verb} task ${taskLabel}. ${ctl.message || ''}`.trim();
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
    subagent_mode: raw.subagent_mode === true,
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

  // Persist subagent_mode separately (not inside clampOrchestrationConfig)
  const finalMerged = {
    ...merged,
    subagent_mode: typeof incoming.subagent_mode === 'boolean'
      ? incoming.subagent_mode
      : (current as any).subagent_mode ?? false,
  };

  getConfig().updateConfig({ orchestration: finalMerged } as any);
  res.json({ success: true, config: finalMerged });
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
  const resumableStatuses: TaskStatus[] = ['paused', 'queued', 'stalled', 'needs_assistance', 'running', 'failed'];
  if (resumableStatuses.includes(task.status as TaskStatus)) {
    // If status is 'running' but no active runner exists, the runner died without cleanup.
    // Treat it as resumable — reset to queued and start a fresh runner.
    if (task.status === 'running' && BackgroundTaskRunner.isRunning(task.id)) {
      res.json({ success: false, error: 'Task is already actively running.' });
      return;
    }
    // Status is 'running' but runner is dead — clear any ghost activeRunners entry before relaunching
    if (task.status === 'running') {
      BackgroundTaskRunner.forceRelease(task.id);
    }
    updateTaskStatus(task.id, 'queued');
    const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
    runner.start().catch(err => console.error(`[BackgroundTaskRunner] Resume ${task.id} error:`, err.message));
    res.json({ success: true });
  } else {
    res.json({ success: false, error: `Task status is ${task.status}, cannot resume` });
  }
});

// ─── Error Response Endpoint ────────────────────────────────────────────────
// Receives structured user response to a task error, injects it as a resume
// instruction, and relaunches the task runner so the agent acts on it.
app.post('/api/bg-tasks/:id/error-response', async (req: any, res: any) => {
  const task = loadTask(req.params.id);
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }

  const { action, category, inputs } = req.body || {};
  if (!action) { res.status(400).json({ success: false, error: 'action is required' }); return; }

  // Build a clear natural-language injection the agent will see on its next round
  let instruction = '';

  if (action === 'cancel') {
    // User wants to stop — mark failed and return
    updateTaskStatus(task.id, 'failed', { pauseReason: undefined });
    appendJournal(task.id, { type: 'status_push', content: 'User cancelled task via error response.' });
    res.json({ success: true, resumed: false });
    return;
  }

  if (action === 'credentials' && inputs?.email) {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has provided login credentials to resolve the authentication error.`,
      `Email: ${inputs.email}`,
      `Password: [PROVIDED — use the credential ID to retrieve it]`,
      ``,
      `Your next steps:`,
      `1. Return to the login form on the page`,
      `2. Fill the email field with: ${inputs.email}`,
      `3. Fill the password field with the provided password`,
      `4. Click the login/submit button`,
      `5. If a 2FA/verification code is requested next, pause and ask the user`,
      `6. Do NOT retry with the same credentials if login fails — pause and ask user instead`,
    ].join('\n');

    // Store credentials securely if credential handler is available
    try {
      const credHandler = getCredentialHandler();
      const credId = credHandler.store(task.id, 'auth', { email: inputs.email, password: inputs.password || '' });
      instruction += `\nCredential ID (for secure retrieval): ${credId}`;
      getErrorAudit(path.join(CONFIG_DIR_PATH, 'logs', 'audit.log')).logCredentialProvided(task.id, 'auth');
    } catch {}

  } else if (action === 'verification_code' && inputs?.code) {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has provided the verification/2FA code: ${inputs.code}`,
      ``,
      `Your next steps:`,
      `1. Find the verification code input field on the page`,
      `2. Fill it with: ${inputs.code}`,
      `3. Submit/confirm the code`,
      `4. Continue the original task after successful verification`,
    ].join('\n');

  } else if (action === 'manual_complete') {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has manually completed the CAPTCHA or challenge.`,
      `The page should now be accessible. Continue from where you left off.`,
      `Take a fresh browser_snapshot() to see the current page state before proceeding.`,
    ].join('\n');

  } else if (action === 'retry_now' || action === 'retry_delay') {
    const delayMs = action === 'retry_delay' ? 30000 : 0;
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has requested a retry after the network/service error.`,
      `Retry the last failed operation. If it fails again, pause for assistance.`,
    ].join('\n');

  } else if (action === 'skip_content' || action === 'skip_step' || action === 'skip') {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has chosen to skip this step/content.`,
      `Do not attempt this step again. Move on to the next task step.`,
      `Mark this step as skipped and continue.`,
    ].join('\n');

  } else if (action === 'grant_permission') {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has granted permission or resolved the access issue.`,
      `Retry the operation that was blocked. If still denied, skip and continue.`,
    ].join('\n');

  } else if (action === 'google' || action === 'oauth') {
    const provider = inputs?.provider || 'Google';
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user wants to use ${provider} OAuth sign-in.`,
      `Find and click the "Sign in with ${provider}" button on the page.`,
      `The browser will handle the OAuth redirect. Wait for it to complete and return to the original page.`,
      `If a verification code or additional step is needed after OAuth, pause and ask the user.`,
    ].join('\n');

  } else {
    // Generic fallback — pass raw action as instruction
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `User action: ${action}`,
      inputs ? `Additional context: ${JSON.stringify(inputs)}` : '',
      `Proceed accordingly. If unsure, take a fresh browser_snapshot() and reassess.`,
    ].filter(Boolean).join('\n');
  }

  // Inject instruction into resume context so the runner sees it immediately
  updateResumeContext(task.id, { onResumeInstruction: instruction });
  appendJournal(task.id, {
    type: 'status_push',
    content: `Error response received: action=${action} category=${category || 'unknown'}. Resuming task.`,
  });

  // Requeue and relaunch
  updateTaskStatus(task.id, 'queued', { pauseReason: undefined });
  const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
  runner.start().catch((err: any) => console.error(`[ErrorResponse] Task ${task.id} resume error:`, err.message));

  res.json({ success: true, resumed: true, action });
});

// Inject a user message into the task's session — lets the web UI chat directly with the task agent.
// If the task is paused/needs_assistance, it also resumes it so the agent sees and responds to the message.
app.post('/api/bg-tasks/:id/message', async (req: any, res: any) => {
  const task = loadTask(req.params.id);
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  const userMessage = String(req.body?.message || '').trim();
  if (!userMessage) { res.status(400).json({ success: false, error: 'message is required' }); return; }

  // Inject the message into the task session so the agent sees it on the next round.
  const sessionId = `task_${task.id}`;
  addMessage(sessionId, { role: 'user', content: userMessage, timestamp: Date.now() });
  appendJournal(task.id, { type: 'status_push', content: `User replied via task panel: ${userMessage.slice(0, 200)}` });

  // If the task is waiting for guidance, resume it so it processes the message.
  const needsResume = task.status === 'needs_assistance' || task.status === 'paused' || task.status === 'stalled';
  if (needsResume) {
    updateTaskStatus(task.id, 'queued');
    const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
    runner.start().catch((err: any) => console.error(`[BackgroundTaskRunner] MessageResume ${task.id} error:`, err.message));
  }

  res.json({ success: true, resumed: needsResume });
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
const taskHeartbeatPath = path.join(CONFIG_DIR_PATH, 'task-heartbeat.json');

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

// ─── Channels API ──────────────────────────────────────────────────────────────

async function testTelegramConfig(token: string): Promise<{ success: boolean; bot?: any; error?: string }> {
  if (!token) return { success: false, error: 'No Telegram bot token provided' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, { method: 'POST' });
    const data: any = await resp.json();
    if (!data.ok) return { success: false, error: data.description || 'Invalid token' };
    return { success: true, bot: { username: data.result.username, firstName: data.result.first_name, id: data.result.id } };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

async function testDiscordConfig(dc: DiscordChannelConfig): Promise<{ success: boolean; bot?: any; error?: string }> {
  if (!dc.botToken) return { success: false, error: 'No Discord bot token provided' };
  try {
    const meResp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${dc.botToken}` },
    });
    const meData: any = await meResp.json();
    if (!meResp.ok) return { success: false, error: meData?.message || `Discord API ${meResp.status}` };

    return {
      success: true,
      bot: { username: meData.username, id: meData.id, discriminator: meData.discriminator },
    };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

async function testWhatsAppConfig(wa: WhatsAppChannelConfig): Promise<{ success: boolean; account?: any; error?: string }> {
  if (!wa.accessToken) return { success: false, error: 'No WhatsApp access token provided' };
  if (!wa.phoneNumberId) return { success: false, error: 'No WhatsApp phone number ID provided' };
  try {
    const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(wa.phoneNumberId)}?fields=id,display_phone_number,verified_name`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${wa.accessToken}` },
    });
    const data: any = await resp.json();
    if (!resp.ok) return { success: false, error: data?.error?.message || `WhatsApp API ${resp.status}` };
    return { success: true, account: data };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

app.get('/api/channels/status', (_req, res) => {
  const runtimeTelegram = telegramChannel.getStatus();
  const channels = resolveChannelsConfig();

  res.json({
    success: true,
    telegram: {
      ...runtimeTelegram,
      enabled: channels.telegram.enabled,
      hasToken: !!channels.telegram.botToken,
      allowedUserIds: channels.telegram.allowedUserIds,
    },
    discord: {
      enabled: channels.discord.enabled,
      hasToken: !!channels.discord.botToken,
      hasWebhook: !!channels.discord.webhookUrl,
      applicationId: channels.discord.applicationId,
      guildId: channels.discord.guildId,
      channelId: channels.discord.channelId,
    },
    whatsapp: {
      enabled: channels.whatsapp.enabled,
      hasAccessToken: !!channels.whatsapp.accessToken,
      phoneNumberId: channels.whatsapp.phoneNumberId,
      businessAccountId: channels.whatsapp.businessAccountId,
      verifyTokenSet: !!channels.whatsapp.verifyToken,
      webhookSecretSet: !!channels.whatsapp.webhookSecret,
      testRecipient: channels.whatsapp.testRecipient,
    },
  });
});

app.post('/api/channels/config', async (req, res) => {
  const incoming = req.body?.channels || {};
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const existing = resolveChannelsConfig();

  const mergedTelegram = normalizeTelegramConfig({ ...existing.telegram, ...(incoming.telegram || {}) });
  const mergedDiscord = normalizeDiscordConfig({ ...existing.discord, ...(incoming.discord || {}) });
  const mergedWhatsApp = normalizeWhatsAppConfig({ ...existing.whatsapp, ...(incoming.whatsapp || {}) });

  const channels = {
    ...(current.channels || {}),
    telegram: mergedTelegram,
    discord: mergedDiscord,
    whatsapp: mergedWhatsApp,
  };

  // Keep legacy top-level telegram key in sync for backward compatibility.
  cm.updateConfig({
    channels,
    telegram: mergedTelegram,
  } as any);

  telegramChannel.updateConfig(mergedTelegram);

  res.json({
    success: true,
    channels: {
      telegram: { enabled: mergedTelegram.enabled, hasToken: !!mergedTelegram.botToken, allowedUserIds: mergedTelegram.allowedUserIds },
      discord: { enabled: mergedDiscord.enabled, hasToken: !!mergedDiscord.botToken, hasWebhook: !!mergedDiscord.webhookUrl },
      whatsapp: { enabled: mergedWhatsApp.enabled, hasAccessToken: !!mergedWhatsApp.accessToken, phoneNumberId: mergedWhatsApp.phoneNumberId },
    },
  });
});

app.post('/api/channels/test/:channel', async (req, res) => {
  const channel = String(req.params.channel || '').toLowerCase();
  const channels = resolveChannelsConfig();

  if (channel === 'telegram') {
    const token = String(req.body?.botToken || channels.telegram.botToken || '');
    const result = await testTelegramConfig(token);
    res.json(result);
    return;
  }

  if (channel === 'discord') {
    const dc = normalizeDiscordConfig({ ...channels.discord, ...(req.body || {}) });
    const result = await testDiscordConfig(dc);
    res.json(result);
    return;
  }

  if (channel === 'whatsapp') {
    const wa = normalizeWhatsAppConfig({ ...channels.whatsapp, ...(req.body || {}) });
    const result = await testWhatsAppConfig(wa);
    res.json(result);
    return;
  }

  res.status(400).json({ success: false, error: `Unsupported channel: ${channel}` });
});

app.post('/api/channels/send-test/:channel', async (req, res) => {
  const channel = String(req.params.channel || '').toLowerCase();
  const channels = resolveChannelsConfig();

  if (channel === 'telegram') {
    try {
      await telegramChannel.sendToAllowed('🦞 SmallClaw test message - Telegram is connected!');
      res.json({ success: true });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  if (channel === 'discord') {
    const dc = normalizeDiscordConfig({ ...channels.discord, ...(req.body || {}) });
    const text = String(req.body?.text || '🦞 SmallClaw test message - Discord is connected!');
    if (dc.webhookUrl) {
      try {
        const resp = await fetch(dc.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          res.json({ success: false, error: body || `Discord webhook HTTP ${resp.status}` });
          return;
        }
        res.json({ success: true });
      } catch (err: any) {
        res.json({ success: false, error: String(err?.message || err) });
      }
      return;
    }
    if (!dc.botToken || !dc.channelId) {
      res.json({ success: false, error: 'Provide Discord webhook URL or bot token + channel ID' });
      return;
    }
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(dc.channelId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${dc.botToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: text }),
      });
      const data: any = await resp.json();
      if (!resp.ok) {
        res.json({ success: false, error: data?.message || `Discord API ${resp.status}` });
        return;
      }
      res.json({ success: true, messageId: data?.id });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  if (channel === 'whatsapp') {
    const wa = normalizeWhatsAppConfig({ ...channels.whatsapp, ...(req.body || {}) });
    const to = String(req.body?.to || wa.testRecipient || '').trim();
    const text = String(req.body?.text || 'SmallClaw test message - WhatsApp is connected!');
    if (!wa.accessToken || !wa.phoneNumberId || !to) {
      res.json({ success: false, error: 'Provide WhatsApp access token, phone number ID, and test recipient number' });
      return;
    }
    try {
      const resp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(wa.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${wa.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      });
      const data: any = await resp.json();
      if (!resp.ok) {
        res.json({ success: false, error: data?.error?.message || `WhatsApp API ${resp.status}` });
        return;
      }
      res.json({ success: true, messageId: data?.messages?.[0]?.id || null });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  res.status(400).json({ success: false, error: `Unsupported channel: ${channel}` });
});

// Legacy Telegram endpoints (compatibility wrappers)
app.get('/api/telegram/status', (_req, res) => {
  const runtimeTelegram = telegramChannel.getStatus();
  const channels = resolveChannelsConfig();
  res.json({
    success: true,
    ...runtimeTelegram,
    enabled: channels.telegram.enabled,
    hasToken: !!channels.telegram.botToken,
    allowedUserIds: channels.telegram.allowedUserIds,
  });
});

app.post('/api/telegram/config', async (req, res) => {
  const incoming = req.body || {};
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const existing = resolveChannelsConfig();
  const mergedTelegram = normalizeTelegramConfig({ ...existing.telegram, ...incoming });
  const channels = {
    ...(current.channels || {}),
    telegram: mergedTelegram,
    discord: existing.discord,
    whatsapp: existing.whatsapp,
  };
  cm.updateConfig({ channels, telegram: mergedTelegram } as any);
  telegramChannel.updateConfig(mergedTelegram);
  res.json({ success: true, config: { enabled: mergedTelegram.enabled, hasToken: !!mergedTelegram.botToken, allowedUserIds: mergedTelegram.allowedUserIds } });
});

app.post('/api/telegram/test', async (req, res) => {
  const channels = resolveChannelsConfig();
  const token = String(req.body?.botToken || channels.telegram.botToken || '');
  const result = await testTelegramConfig(token);
  res.json(result);
});

app.post('/api/telegram/send-test', async (req, res) => {
  try {
    await telegramChannel.sendToAllowed('🦞 SmallClaw test message - Telegram is connected!');
    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err) });
  }
});

type AgentToolProfile = 'minimal' | 'coding' | 'web' | 'full';

function sanitizeAgentId(value: any): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeAgentDefinition(raw: any, fallbackId?: string): any {
  const id = sanitizeAgentId(raw?.id || fallbackId || '');
  const profile = String(raw?.tools?.profile || '').trim();
  const normalized: any = {
    id,
    name: String(raw?.name || id || 'Agent').trim() || 'Agent',
  };
  if (raw?.description !== undefined) normalized.description = String(raw.description || '').trim();
  if (raw?.emoji !== undefined) normalized.emoji = String(raw.emoji || '').trim();
  if (raw?.workspace !== undefined) normalized.workspace = String(raw.workspace || '').trim();
  if (raw?.model !== undefined) normalized.model = String(raw.model || '').trim();
  if (typeof raw?.minimalPrompt === 'boolean') normalized.minimalPrompt = raw.minimalPrompt;
  if (typeof raw?.default === 'boolean') normalized.default = raw.default;
  if (typeof raw?.canSpawn === 'boolean') normalized.canSpawn = raw.canSpawn;
  if (raw?.cronSchedule !== undefined) normalized.cronSchedule = String(raw.cronSchedule || '').trim();
  if (raw?.maxSteps !== undefined) {
    const n = Number(raw.maxSteps);
    if (Number.isFinite(n) && n > 0) normalized.maxSteps = Math.floor(n);
  }
  if (Array.isArray(raw?.spawnAllowlist)) {
    normalized.spawnAllowlist = raw.spawnAllowlist
      .map((v: any) => sanitizeAgentId(v))
      .filter((v: string) => !!v);
  }
  if (raw?.tools && typeof raw.tools === 'object') {
    normalized.tools = {};
    if (Array.isArray(raw.tools.allow)) normalized.tools.allow = raw.tools.allow.map((s: any) => String(s || '').trim()).filter(Boolean);
    if (Array.isArray(raw.tools.deny)) normalized.tools.deny = raw.tools.deny.map((s: any) => String(s || '').trim()).filter(Boolean);
    if (['minimal', 'coding', 'web', 'full'].includes(profile)) normalized.tools.profile = profile as AgentToolProfile;
    if (!normalized.tools.allow && !normalized.tools.deny && !normalized.tools.profile) delete normalized.tools;
  }
  if (Array.isArray(raw?.bindings)) {
    normalized.bindings = raw.bindings
      .filter((b: any) => b && ['telegram', 'discord', 'whatsapp'].includes(String(b.channel || '')))
      .map((b: any) => ({
        channel: String(b.channel),
        ...(b.accountId ? { accountId: String(b.accountId) } : {}),
        ...(b.peerId ? { peerId: String(b.peerId) } : {}),
      }));
  }
  return normalized;
}

function normalizeAgentsForSave(incomingAgents: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const raw of incomingAgents || []) {
    const n = normalizeAgentDefinition(raw);
    if (!n.id || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  if (out.length > 0 && !out.some(a => a.default === true)) out[0].default = true;
  if (out.filter(a => a.default === true).length > 1) {
    let found = false;
    for (const a of out) {
      if (a.default === true && !found) { found = true; continue; }
      if (a.default === true) a.default = false;
    }
  }
  return out;
}

function findLastCronRunAt(agentId: string): number | null {
  const entries = getAgentRunHistory(agentId, 100);
  const hit = entries.find((e) => e.trigger === 'cron');
  return hit ? hit.finishedAt : null;
}

app.get('/api/agents', (_req, res) => {
  const cfg = getConfig().getConfig() as any;
  const explicitAgents = Array.isArray(cfg.agents) ? cfg.agents : [];
  const agents = getAgents().map((agent) => {
    const workspace = resolveAgentWorkspace(agent as any);
    const lastRun = getAgentLastRun(agent.id);
    return {
      ...agent,
      workspaceResolved: workspace,
      workspaceExists: fs.existsSync(workspace),
      isSynthetic: explicitAgents.length === 0 && agent.id === 'main',
      lastRun: lastRun || null,
      lastHeartbeatAt: findLastCronRunAt(agent.id),
    };
  });
  const defaultAgent = agents.find((a) => a.default) || agents[0] || null;
  res.json({ success: true, agents, defaultAgentId: defaultAgent?.id || null });
});

app.get('/api/agents/history', (req, res) => {
  const agentId = String(req.query.agentId || '').trim() || undefined;
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  res.json({ success: true, history: getAgentRunHistory(agentId, limit) });
});

app.post('/api/agents', (req, res) => {
  const incoming = req.body?.agent || req.body || {};
  const normalized = normalizeAgentDefinition(incoming);
  if (!normalized.id) {
    res.status(400).json({ success: false, error: 'agent.id is required' });
    return;
  }
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const explicitAgents = Array.isArray(current.agents) ? current.agents : [];
  const idx = explicitAgents.findIndex((a: any) => sanitizeAgentId(a.id) === normalized.id);
  const next = idx >= 0
    ? explicitAgents.map((a: any, i: number) => (i === idx ? { ...a, ...normalized } : a))
    : [...explicitAgents, normalized];
  const finalAgents = normalizeAgentsForSave(next);
  cm.updateConfig({ agents: finalAgents } as any);
  const saved = finalAgents.find(a => a.id === normalized.id);
  if (saved) ensureAgentWorkspace(saved as any);
  reloadAgentSchedules();
  res.json({ success: true, agent: saved || normalized, created: idx < 0 });
});

app.put('/api/agents/:id', (req, res) => {
  const targetId = sanitizeAgentId(req.params.id);
  if (!targetId) {
    res.status(400).json({ success: false, error: 'Invalid agent id' });
    return;
  }
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const explicitAgents = Array.isArray(current.agents) ? current.agents : [];
  const idx = explicitAgents.findIndex((a: any) => sanitizeAgentId(a.id) === targetId);
  if (idx < 0) {
    res.status(404).json({ success: false, error: `Agent "${targetId}" not found in config` });
    return;
  }
  const merged = normalizeAgentDefinition({ ...explicitAgents[idx], ...(req.body?.agent || req.body || {}), id: targetId }, targetId);
  const next = explicitAgents.map((a: any, i: number) => (i === idx ? merged : a));
  const finalAgents = normalizeAgentsForSave(next);
  cm.updateConfig({ agents: finalAgents } as any);
  ensureAgentWorkspace(merged as any);
  reloadAgentSchedules();
  res.json({ success: true, agent: merged });
});

app.delete('/api/agents/:id', (req, res) => {
  const targetId = sanitizeAgentId(req.params.id);
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const explicitAgents = Array.isArray(current.agents) ? current.agents : [];
  const next = explicitAgents.filter((a: any) => sanitizeAgentId(a.id) !== targetId);
  if (next.length === explicitAgents.length) {
    res.status(404).json({ success: false, error: `Agent "${targetId}" not found` });
    return;
  }
  const finalAgents = normalizeAgentsForSave(next);
  cm.updateConfig({ agents: finalAgents } as any);
  reloadAgentSchedules();
  res.json({ success: true });
});

app.get('/api/agents/:id/agents-md', (req, res) => {
  const agentId = sanitizeAgentId(req.params.id);
  const agent = getAgentById(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: `Agent "${agentId}" not found` });
    return;
  }
  const workspace = ensureAgentWorkspace(agent as any);
  const filePath = path.join(workspace, 'AGENTS.md');
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  res.json({ success: true, agentId, path: filePath, content });
});

app.put('/api/agents/:id/agents-md', (req, res) => {
  const agentId = sanitizeAgentId(req.params.id);
  const agent = getAgentById(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: `Agent "${agentId}" not found` });
    return;
  }
  const content = String(req.body?.content || '');
  const workspace = ensureAgentWorkspace(agent as any);
  const filePath = path.join(workspace, 'AGENTS.md');
  fs.writeFileSync(filePath, content, 'utf-8');
  res.json({ success: true, path: filePath });
});

app.post('/api/agents/:id/spawn', async (req, res) => {
  const agentId = sanitizeAgentId(req.params.id);
  const agent = getAgentById(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: `Agent "${agentId}" not found` });
    return;
  }
  const task = String(req.body?.task || '').trim();
  if (!task) {
    res.status(400).json({ success: false, error: 'task is required' });
    return;
  }
  const context = req.body?.context !== undefined ? String(req.body.context) : undefined;
  const maxStepsRaw = req.body?.maxSteps;
  const maxSteps = Number.isFinite(Number(maxStepsRaw)) && Number(maxStepsRaw) > 0
    ? Math.floor(Number(maxStepsRaw))
    : undefined;
  const timeoutRaw = req.body?.timeoutMs;
  const timeoutMs = Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) > 0
    ? Math.floor(Number(timeoutRaw))
    : 120000;

  const startedAt = Date.now();
  const result = await spawnAgent({
    agentId,
    task,
    context,
    maxSteps,
    timeoutMs,
  });
  const finishedAt = Date.now();
  const historyEntry = recordAgentRun({
    agentId: result.agentId,
    agentName: result.agentName,
    trigger: 'manual',
    success: result.success,
    startedAt,
    finishedAt,
    durationMs: result.durationMs,
    stepCount: result.stepCount,
    error: result.error,
    resultPreview: result.success ? String(result.result || '').slice(0, 400) : undefined,
  });
  res.json({ success: result.success, result, historyEntry });
});

// ─── Scheduler API ────────────────────────────────────────────────────────────────

app.get('/api/schedules', (_req, res) => {
  const jobs = cronScheduler.getJobs();
  res.json({
    success: true,
    schedules: jobs.map((job: any) => ({
      id: job.id,
      name: job.name,
      prompt: job.prompt,
      cron: job.cron,
      run_at: job.run_at,
      timezone: job.timezone,
      status: job.status || 'active',
      next_run: job.nextRun,
      last_run: job.lastRun,
      delivery_channel: job.deliveryChannel || 'web',
    })),
  });
});

app.post('/api/schedules', (req: any, res: any) => {
  const { name, pattern, prompt, timezone, delivery_channel, confirm } = req.body;
  
  // Require confirmation for create
  if (confirm !== true) {
    return res.json({
      success: false,
      needs_confirmation: true,
      error: 'This action requires explicit confirmation. Set confirm: true to proceed.',
    });
  }
  
  if (!name || !pattern || !prompt) {
    return res.json({ success: false, error: 'name, pattern, and prompt are required' });
  }
  
  try {
    const job = cronScheduler.createJob({
      name: String(name).slice(0, 100),
      prompt: String(prompt).slice(0, 2000),
      schedule: /^\d/.test(pattern) ? pattern : null,  // If starts with number, assume cron
      runAt: !/^\d/.test(pattern) ? pattern : null,  // NL pattern
      tz: timezone || 'UTC',
      delivery: 'web',  // Only web supported for now
    });
    
    res.json({
      success: true,
      job: {
        id: job.id,
        name: job.name,
        status: 'active',
        next_run: job.nextRun,
      },
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.put('/api/schedules/:id', (req: any, res: any) => {
  const { name, pattern, prompt, timezone, delivery_channel, confirm } = req.body;
  
  if (confirm !== true) {
    return res.json({
      success: false,
      needs_confirmation: true,
      error: 'This action requires explicit confirmation. Set confirm: true to proceed.',
    });
  }
  
  try {
    const job = cronScheduler.updateJob(req.params.id, {
      name: name ? String(name).slice(0, 100) : undefined,
      prompt: prompt ? String(prompt).slice(0, 2000) : undefined,
      schedule: pattern && /^\d/.test(pattern) ? pattern : undefined,
      runAt: pattern && !/^\d/.test(pattern) ? pattern : undefined,
      tz: timezone || undefined,
    });
    
    res.json({ success: true, job });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.delete('/api/schedules/:id', (req: any, res: any) => {
  const { confirm } = req.body;
  
  if (confirm !== true) {
    return res.json({
      success: false,
      needs_confirmation: true,
      error: 'This action requires explicit confirmation. Set confirm: true to proceed.',
    });
  }
  
  try {
    cronScheduler.deleteJob(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.patch('/api/schedules/:id', (req: any, res: any) => {
  const { status } = req.body;
  
  try {
    const job = cronScheduler.updateJob(req.params.id, { status });
    res.json({ success: true, job });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/schedules/:id/run', (req: any, res: any) => {
  try {
    cronScheduler.runJobNow(req.params.id);
    res.json({ success: true, message: 'Schedule triggered' });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/schedules/parse', (req: any, res: any) => {
  const { text, timezone } = req.body;
  
  if (!text) {
    return res.json({ success: false, error: 'text is required' });
  }
  
  try {
    let cron = '';
    let preview = '';
    const t = text.toLowerCase().trim();
    
    // Helper: extract time from text and handle AM/PM
    function extractTime(text: string): { hour: number; minute: number } | null {
      // Match: "3:13pm", "15:13", "3:13", "11am", etc.
      const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
      if (!timeMatch) return null;
      
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const period = timeMatch[3]?.toLowerCase();
      
      // Convert 12-hour to 24-hour format if AM/PM specified
      if (period === 'pm' && hour !== 12) {
        hour += 12;
      } else if (period === 'am' && hour === 12) {
        hour = 0;
      }
      
      // Validate ranges
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      
      return { hour, minute };
    }
    
    if (t.includes('daily') || t.includes('every day')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        const hourStr = String(timeInfo.hour).padStart(2, '0');
        const minStr = String(timeInfo.minute).padStart(2, '0');
        cron = `${timeInfo.minute} ${timeInfo.hour} * * *`;
        preview = `Daily at ${hourStr}:${minStr}`;
      } else {
        cron = '0 9 * * *';
        preview = 'Daily at 09:00';
      }
    } else if (t.includes('weekly')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        cron = `${timeInfo.minute} ${timeInfo.hour} * * 1`;
        preview = `Weekly on Monday at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
      } else {
        cron = '0 9 * * 1';
        preview = 'Weekly on Monday at 09:00';
      }
    } else if (t.includes('monday') || t.includes('tuesday') || t.includes('wednesday') || t.includes('thursday') || t.includes('friday')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        cron = `${timeInfo.minute} ${timeInfo.hour} * * 1-5`;
        preview = `Weekdays at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
      } else {
        cron = '0 9 * * 1-5';
        preview = 'Weekdays at 09:00';
      }
    } else if (/^\d{1,2} \d{1,2} \d|\d \d \*/.test(t)) {
      cron = t;
      preview = 'Custom cron pattern';
    } else {
      return res.json({
        success: false,
        error: 'Could not parse pattern. Try: "daily at 3:13pm", "daily at 15:13", "weekly", or cron like "0 9 * * *"',
        confidence: 0,
      });
    }
    
    res.json({
      success: true,
      kind: 'cron',
      cron,
      human_text: preview,
      preview,
      timezone: timezone || 'UTC',
      confidence: 0.8,
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Settings API ────────────────────────────────────────────────────────────────

app.get('/api/settings/search', (_req, res) => {
  const cm = getConfig();
  const cfg = (cm.getConfig() as any).search || {};
  // Resolve then mask — never send actual key values to the browser.
  // Returns '••••••••' if a key is present (vault or plaintext), '' if not set.
  const maskIfSet = (val: string | undefined): string => {
    if (!val) return '';
    const resolved = cm.resolveSecret(val);
    return resolved ? '••••••••' : '';
  };
  res.json({
    preferred_provider: cfg.preferred_provider || 'tavily',
    search_rigor: cfg.search_rigor || 'verified',
    tavily_api_key: maskIfSet(cfg.tavily_api_key),
    google_api_key: maskIfSet(cfg.google_api_key),
    google_cx: cfg.google_cx || '',   // CSE ID is not a secret
    brave_api_key: maskIfSet(cfg.brave_api_key),
  });
});

app.post('/api/settings/search', (req, res) => {
  const { preferred_provider, search_rigor, tavily_api_key, google_api_key, google_cx, brave_api_key } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  // Only write a key field if the user actually entered a new value.
  // '••••••••' means "leave existing vault entry alone".
  const isNew = (v: any) => v !== undefined && v !== '' && v !== '••••••••';
  const newSearch = {
    ...((current.search || {})),
    ...(preferred_provider !== undefined && { preferred_provider }),
    ...(search_rigor !== undefined && { search_rigor }),
    ...(isNew(tavily_api_key) && { tavily_api_key }),
    ...(isNew(google_api_key) && { google_api_key }),
    ...(google_cx !== undefined && { google_cx }),
    ...(isNew(brave_api_key) && { brave_api_key }),
  };
  cm.updateConfig({ search: newSearch } as any);
  // migrateSecretsToVault() runs inside updateConfig → saveConfig, so any
  // plaintext key just entered is automatically encrypted and replaced with
  // a "vault:<key>" reference before hitting disk.
  res.json({ success: true });
});

// GET /api/credentials/status — list which vault keys are currently stored (names only, no values)
app.get('/api/credentials/status', (_req, res) => {
  try {
    const vault = getVault();
    res.json({ success: true, keys: vault.keys() });
  } catch (err: any) {
    res.json({ success: false, keys: [], error: err.message });
  }
});

// GET /api/credentials/audit — return last N lines of vault-audit.log (scrubbed)
app.get('/api/credentials/audit', (_req, res) => {
  const fs = require('fs');
  const path = require('path');
  try {
    const auditPath = path.join(process.cwd(), '.smallclaw', 'vault', 'vault-audit.log');
    if (!fs.existsSync(auditPath)) { res.json({ success: true, lines: [] }); return; }
    const raw = fs.readFileSync(auditPath, 'utf-8');
    const lines = raw.split('\n').filter((l: string) => l.trim());
    res.json({ success: true, lines: lines.slice(-40) });
  } catch (err: any) {
    res.json({ success: false, lines: [], error: err.message });
  }
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

// ─── Approvals API ───────────────────────────────────────────────────────────
// SECURITY: All approval endpoints require gateway auth. Approvals are the
// confirmation gate before the agent executes irreversible actions — an
// unauthenticated bypass here is a critical vulnerability.

// ─── Gateway Auth Middleware ──────────────────────────────────────────────────
// CRIT-03 / CRIT-01 fix: protects approval, memory-confirm, and open-path
// endpoints from unauthenticated access.
//
// Auth strategy (in priority order):
//   1. Bearer token in Authorization header  →  Authorization: Bearer <token>
//   2. X-Gateway-Token header                →  X-Gateway-Token: <token>
//   3. Localhost bypass (127.0.0.1 / ::1)    →  always trusted when no token configured
//
// Token is read from config at request time so it takes effect immediately
// after a config save without requiring a gateway restart.

function requireGatewayAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const cfg = getConfig().getConfig() as any;
  const configuredToken = String(cfg?.gateway?.auth_token || '').trim();

  // If no token is configured, fall back to localhost-only access.
  if (!configuredToken) {
    const remoteIp = String(
      req.ip ||
      req.socket?.remoteAddress ||
      (req.connection as any)?.remoteAddress ||
      ''
    );
    const isLocalhost =
      remoteIp === '127.0.0.1' ||
      remoteIp === '::1' ||
      remoteIp === '::ffff:127.0.0.1';
    if (isLocalhost) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized: configure gateway.auth_token to enable remote access to this endpoint.' });
    return;
  }

  // Extract token from Authorization header or X-Gateway-Token header.
  const authHeader = String(req.headers['authorization'] || '');
  const xGatewayToken = String(req.headers['x-gateway-token'] || '');
  let providedToken = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    providedToken = authHeader.slice('bearer '.length).trim();
  } else if (xGatewayToken) {
    providedToken = xGatewayToken.trim();
  }

  if (!providedToken || providedToken !== configuredToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

const pendingApprovals: Map<string, { id: string; action: string; reason: string }> = new Map();

app.get('/api/approvals', requireGatewayAuth, (_req, res) => {
  res.json(Array.from(pendingApprovals.values()));
});

app.post('/api/approvals/:id', requireGatewayAuth, (req, res) => {
  const { decision } = req.body;
  const VALID_DECISIONS = ['approved', 'rejected'];
  if (!decision || !VALID_DECISIONS.includes(decision)) {
    res.status(400).json({ success: false, error: `decision must be one of: ${VALID_DECISIONS.join(', ')}` });
    return;
  }
  const approval = pendingApprovals.get(req.params.id);
  if (!approval) {
    res.status(404).json({ success: false, error: 'Approval not found' });
    return;
  }
  pendingApprovals.delete(req.params.id);
  // Security audit: log every approval action (action name only, no payload)
  import('../security/log-scrubber').then(({ log }) => {
    log.security('[approvals]', decision.toUpperCase(), 'approval-id:', req.params.id, 'action:', approval.action);
  }).catch(() => {});
  res.json({ success: true, decision });
});

// ─── Memory API (stub) ───────────────────────────────────────────────────────────

app.post('/api/memory/confirm', requireGatewayAuth, (req, res) => {
  // Memory persistence stub — can be wired to ChromaDB/vector store
  // SECURITY: req.body is user/agent-supplied content — never log it raw.
  // scrubSecrets runs inside sanitizeToolLog before any write.
  import('../security/log-scrubber').then(({ log, sanitizeToolLog }) => {
    log.info('[Memory]', sanitizeToolLog('confirm', req.body));
  }).catch(() => {});
  res.json({ ok: true });
});

// Open a file path in the OS file explorer
// SECURITY: This endpoint uses execFile() (not exec()) so the path is passed
// as an argument, not interpolated into a shell string. The path is also
// validated to be inside the workspace before execution.
app.post('/api/open-path', requireGatewayAuth, async (req, res) => {
  const fp = (req.body?.path || '') as string;
  if (!fp) { res.status(400).json({ ok: false, error: 'Path required' }); return; }

  // Resolve and validate — must be inside workspace or config dir
  const resolvedFp = path.resolve(fp);
  const workspacePath = getConfig().getWorkspacePath();
  const configDirPath = getConfig().getConfigDir();
  const isInWorkspace = resolvedFp.startsWith(path.resolve(workspacePath));
  const isInConfigDir = resolvedFp.startsWith(path.resolve(configDirPath));
  if (!isInWorkspace && !isInConfigDir) {
    res.status(403).json({ ok: false, error: 'Path is outside allowed directories' });
    return;
  }

  try {
    const { execFile } = await import('child_process');
    // execFile passes args as a list — no shell interpolation possible
    if (process.platform === 'win32') {
      execFile('explorer.exe', [resolvedFp]);
    } else if (process.platform === 'darwin') {
      execFile('open', [resolvedFp]);
    } else {
      execFile('xdg-open', [resolvedFp]);
    }
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Provider / Model Settings API ───────────────────────────────────────────
// Used by the Settings → Models tab to read/write provider config and
// trigger the OpenAI OAuth flow.

import { getProvider, resetProvider, buildProviderForLLM } from '../providers/factory';
import { buildWebhookRouter, resolveHookConfig } from './webhook-handler';
import { getMCPManager } from './mcp-manager';
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

// HIGH-02 fix: redact all api_key / token fields before sending to the UI.
// Vault references ("vault:...") and env references ("env:...") are also masked
// so neither the vault key name nor the env var name leaks to the browser.
const SENSITIVE_KEY_PATTERNS = /api[_-]?key|apikey|token|secret|password|passwd|credential/i;

function redactConfigForUI(obj: any, depth = 0): any {
  if (depth > 8 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => redactConfigForUI(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = '••••••••';
    } else {
      out[k] = redactConfigForUI(v, depth + 1);
    }
  }
  return out;
}

// GET /api/settings/provider  — return active provider config (keys redacted)
app.get('/api/settings/provider', (_req, res) => {
  const raw = getConfig().getConfig() as any;
  const llmRaw = raw.llm || {
    provider: 'ollama',
    providers: { ollama: { endpoint: raw.ollama?.endpoint || 'http://localhost:11434', model: raw.models?.primary || 'qwen3:4b' } },
  };
  const llm = redactConfigForUI(sanitizeLLMConfig(llmRaw));
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
  const configDir = CONFIG_DIR_PATH;
  const connected = isConnected(configDir);
  const tokens    = connected ? loadTokens(configDir) : null;
  res.json({ connected, account_id: tokens?.account_id || null, expires_at: tokens?.expires_at || null });
});

// POST /api/auth/openai/start  — kick off OAuth flow (opens browser)
app.post('/api/auth/openai/start', async (_req, res) => {
  const configDir = CONFIG_DIR_PATH;
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
  const configDir = CONFIG_DIR_PATH;
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
  const configDir = CONFIG_DIR_PATH;
  clearTokens(configDir);
  res.json({ success: true });
});

// ─── Webhook Settings API ────────────────────────────────────────────────────

app.get('/api/settings/hooks', (_req, res) => {
  const cfg = (getConfig().getConfig() as any).hooks || {};
  res.json({
    success: true,
    hooks: {
      enabled: cfg.enabled === true,
      token: cfg.token ? '••••••••' : '',           // never return the real token
      tokenSet: !!cfg.token,
      path: cfg.path || '/hooks',
    },
  });
});

app.post('/api/settings/hooks', (req, res) => {
  try {
    const { enabled, token, path: hookPath } = req.body || {};
    const current = (getConfig().getConfig() as any).hooks || {};
    const updated = {
      enabled: enabled === true,
      // If the user sent the masked placeholder, keep the existing token
      token: token && token !== '••••••••' ? String(token).trim() : (current.token || ''),
      path: hookPath ? String(hookPath).trim() : (current.path || '/hooks'),
    };
    getConfig().updateConfig({ hooks: updated } as any);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings/hooks/test', async (req, res) => {
  try {
    const cfg = (getConfig().getConfig() as any).hooks || {};
    if (!cfg.enabled) { res.json({ success: false, error: 'Webhooks are disabled' }); return; }
    if (!cfg.token)   { res.json({ success: false, error: 'No token configured' }); return; }
    res.json({ success: true, message: 'Webhook endpoint is active', path: cfg.path || '/hooks' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── MCP API ──────────────────────────────────────────────────────────────────

app.get('/api/mcp/servers', (_req, res) => {
  try {
    const mgr = getMCPManager();
    const configs = mgr.getConfigs();
    const status = mgr.getStatus();
    const merged = configs.map(cfg => {
      const s = status.find(x => x.id === cfg.id);
      return { ...cfg, status: s?.status || 'disconnected', toolCount: s?.tools || 0, toolNames: s?.toolNames || [], error: s?.error };
    });
    res.json({ success: true, servers: merged });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/servers', (req, res) => {
  try {
    const mgr = getMCPManager();
    const cfg = req.body;
    if (!cfg.id || !cfg.name) { res.status(400).json({ success: false, error: 'id and name are required' }); return; }
    if (!cfg.id.match(/^[a-z0-9_-]+$/i)) { res.status(400).json({ success: false, error: 'id must be alphanumeric/underscore/dash only' }); return; }
    mgr.upsertConfig(cfg);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/mcp/servers/:id', (req, res) => {
  try {
    const mgr = getMCPManager();
    const deleted = mgr.deleteConfig(req.params.id);
    res.json({ success: deleted, error: deleted ? undefined : 'Server not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/servers/:id/connect', async (req, res) => {
  try {
    const mgr = getMCPManager();
    const result = await mgr.connect(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/servers/:id/disconnect', async (req, res) => {
  try {
    const mgr = getMCPManager();
    await mgr.disconnect(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/mcp/tools', (_req, res) => {
  try {
    const mgr = getMCPManager();
    res.json({ success: true, tools: mgr.getAllTools() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Webhook Routes ──────────────────────────────────────────────────────────
// Mounted dynamically so the path is always read fresh from config.
// Must be registered BEFORE the SPA catch-all below.
(() => {
  const hookCfg = resolveHookConfig();
  if (!hookCfg.enabled) {
    console.log('[Webhooks] Disabled — set hooks.enabled=true in config to activate.');
    return;
  }
  if (!hookCfg.token) {
    console.warn('[Webhooks] hooks.enabled=true but no hooks.token set — webhooks will be disabled until a token is configured.');
    return;
  }
  const webhookRouter = buildWebhookRouter({
    handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode) =>
      handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode),
    addMessage,
    getIsModelBusy: () => isModelBusy,
    broadcast: broadcastWS,
    deliverTelegram: (text: string) => telegramChannel.sendToAllowed(text),
  });
  app.use(hookCfg.path, webhookRouter);
  console.log(`[Webhooks] Listening at ${hookCfg.path} (wake, agent, status)`);
})();

// ─── Internal Agent Task endpoint (called by Agent Builder for AI-authoring nodes)
// Localhost-only unless SMALLCLAW_INTERNAL_TOKEN is set.
app.use('/internal/agent-task', internalAgentTaskRouter);
console.log('[InternalAgentTask] Endpoint mounted at POST /internal/agent-task');

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

// Setup error response endpoint
setupErrorResponseEndpoint(app);

// ─── Initialize Advanced Error Response Systems ────────────────────────────────
const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const credentialHandler = initCredentialHandler(encryptionKey);
const verificationFlowManager = getVerificationFlowManager();
const errorAnalyzer = getErrorAnalyzer();
const errorHistory = getErrorHistory();
const retryStrategy = getRetryStrategy();
const visualErrorDetector = getVisualErrorDetector();
const errorAudit = getErrorAudit(process.env.ERROR_AUDIT_LOG_PATH || path.join(CONFIG_DIR_PATH, 'logs', 'audit.log'));
const contextInjectionManager = getContextInjectionManager();

console.log('[Server] ✅ Advanced error response systems initialized');
console.log(`[Server] - Credential Handler: ${encryptionKey.substring(0, 8)}...`);
console.log('[Server] - Verification Flow Manager: Ready');
console.log('[Server] - Error Analyzer: Ready');
console.log('[Server] - Error History: Ready');
console.log('[Server] - Retry Strategy: Ready');
console.log('[Server] - Visual Error Detector: Ready');
console.log('[Server] - Error Audit: Ready');
console.log('[Server] - Context Injection Manager: Ready');

server.listen(PORT, HOST, () => {
  // Detect GPU hardware once — logs a single clean line, caches result for
  // the lifetime of the process (used by /api/system-stats, no repeated probes).
  logGpuStatus();

  const liveConfig = getConfig().getConfig();
  const searchCfg = (liveConfig as any).search || {};
  // HIGH-03: resolve vault references before checking presence — never log the key value itself
  const cm = getConfig();
  const tavilyKey = cm.resolveSecret(searchCfg.tavily_api_key);
  const googleKey = cm.resolveSecret(searchCfg.google_api_key);
  const hasSearch = tavilyKey ? '✓ Tavily' : googleKey ? '✓ Google' : '✗ None (configure in Settings → Search)';
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║              SmallClaw v2 Gateway (Native Tools)              ║
╠════════════════════════════════════════════════════════════════╣
║  Tasks:   Cron scheduler active, jobs at .smallclaw/cron/     ║
║  Skills: ${String(skillsManager.getAll().length + ' loaded, ' + skillsManager.getEnabledSkills().length + ' enabled').padEnd(49)}║
║  Search:  ${hasSearch.padEnd(49)}║
║  Memory:  SOUL.md + IDENTITY.md + USER.md + MEMORY.md         ║
║                                                               ║
║  Web UI:    http://${HOST}:${PORT}                            ║
║  Model:     ${liveConfig.models.primary.padEnd(45)}║
║  Workspace: ${liveConfig.workspace.path.slice(0, 43).padEnd(45)}║
╚════════════════════════════════════════════════════════════════╝
`);
  // Auto-connect enabled MCP servers
  getMCPManager().startEnabledServers().catch(err => console.warn('[MCP] Startup error:', err?.message));

  cronScheduler.start();
  console.log('[CronScheduler] Tick loop started — heartbeat:', cronScheduler.getConfig().enabled ? 'ON' : 'OFF');
  initializeAgentSchedules();
  console.log('[Scheduler] Agent cron schedules initialized.');
  heartbeatRunner.start();
  console.log('[HeartbeatRunner] Started — interval:', heartbeatRunner.getConfig().intervalMinutes, 'min');
  telegramChannel.start().then(() => {
    // Check if we just restarted after a self-update
    const selfUpdateStatusFile = path.join(require('os').homedir(), '.smallclaw', 'last_self_update.txt');
    if (fs.existsSync(selfUpdateStatusFile)) {
      try {
        const statusContent = fs.readFileSync(selfUpdateStatusFile, 'utf-8').trim();
        fs.unlinkSync(selfUpdateStatusFile); // consume it — only notify once
        if (statusContent.startsWith('UPDATE_SUCCESS')) {
          const lines = statusContent.split('\n');
          const timestamp = lines[1] || '';
          const msg = `✅ SmallClaw self-update complete!\n\nI ran the update, rebuilt, and have restarted the gateway. I'm back online and up to date.\n\n🕐 Updated at: ${timestamp.trim()}`;
          setTimeout(() => telegramChannel.sendToAllowed(msg).catch(() => {}), 3000);
          console.log('[Gateway] Post-update Telegram notification queued.');
        } else if (statusContent.startsWith('UPDATE_FAILED')) {
          const lines = statusContent.split('\n');
          const timestamp = lines[1] || '';
          const msg = `❌ SmallClaw self-update failed.\n\nThe update process encountered an error. Gateway has restarted with the previous version. Check the terminal for details.\n\n🕐 Attempted at: ${timestamp.trim()}`;
          setTimeout(() => telegramChannel.sendToAllowed(msg).catch(() => {}), 3000);
          console.log('[Gateway] Post-update failure Telegram notification queued.');
        }
      } catch (e: any) {
        console.warn('[Gateway] Could not read self-update status file:', e.message);
      }
    }
  }).catch(err => console.error('[Telegram] Start failed:', err.message));
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
  console.log('[Gateway] Shutting down error response systems...');
  try { credentialHandler.stop(); console.log('[Gateway] ✅ Credential handler stopped'); } catch (e) { console.error('[Gateway] Error:', e); }
  try { verificationFlowManager.stop(); console.log('[Gateway] ✅ Verification flow stopped'); } catch (e) { console.error('[Gateway] Error:', e); }
  console.log(`[Gateway] Received ${signal}; shutting down...`);
  try { skillsManager.persistState(); } catch {}
  try { telegramChannel.stop(); } catch {}
  try { getMCPManager().disconnectAll(); } catch {}
  try { cronScheduler.stop(); } catch {}
  try { stopAgentSchedules(); } catch {}
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
