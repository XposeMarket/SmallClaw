/**
 * internal-agent-task.ts
 * SmallClaw headless agent runner — called by Agent Builder during workflow execution.
 *
 * Endpoint: POST /internal/agent-task
 *   Body: { agentId, task, context?, output_field?, timeoutMs? }
 *   Response: { success, agentId, result, output_field?, value, durationMs, error? }
 *
 * Endpoint: GET /internal/agent-task/agents
 *   Response: { success, agents: [{ id, name, description, output_field }] }
 *
 * Auth: localhost-only by default (same as requireGatewayAuth without a token configured).
 * Set SMALLCLAW_INTERNAL_TOKEN env var to require a bearer token from Agent Builder.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnAgent } from '../agents/spawner';
import { getAgentById, getConfig } from '../config/config';
import { getOllamaClient } from '../agents/ollama-client';
import { Reactor } from '../agents/reactor';

export const internalAgentTaskRouter = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

// Primary dynamic subagent location (matches SubagentManager):
// <workspace>/.smallclaw/subagents/<agentId>/
function getPrimarySubagentStoreDir(): string {
  try {
    const workspace = String(getConfig().getConfig()?.workspace?.path || process.cwd());
    return path.join(workspace, '.smallclaw', 'subagents');
  } catch {
    return path.join(process.cwd(), '.smallclaw', 'subagents');
  }
}

// Legacy location used by earlier builds of this endpoint:
// <SMALLCLAW_DATA_DIR>/subagents OR ~/.smallclaw/subagents
function getLegacySubagentStoreDir(): string {
  const dataDir = process.env.SMALLCLAW_DATA_DIR || path.join(os.homedir(), '.smallclaw');
  return path.join(dataDir, 'subagents');
}

function getSubagentDir(agentId: string): string {
  return path.join(getPrimarySubagentStoreDir(), agentId);
}

function resolveSubagentDir(agentId: string): string {
  const primary = getSubagentDir(agentId);
  const primaryConfig = path.join(primary, 'config.json');
  if (fs.existsSync(primaryConfig)) return primary;

  const legacy = path.join(getLegacySubagentStoreDir(), agentId);
  const legacyConfig = path.join(legacy, 'config.json');
  if (legacy !== primary && fs.existsSync(legacyConfig)) return legacy;

  // Default to primary path for new agents / write-back.
  return primary;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SubagentDef {
  id: string;
  name: string;
  description: string;
  system_instructions: string;
  constraints: string[];
  success_criteria: string;
  max_steps: number;
  timeout_ms: number;
  output_field?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadDef(agentId: string): SubagentDef | null {
  const p = path.join(resolveSubagentDir(agentId), 'config.json');
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return null; }
}

/** Read memory files from <agentDir>/memory/ and return them as a combined block. */
function readMemoryBlock(agentId: string): string {
  const memDir = path.join(resolveSubagentDir(agentId), 'memory');
  if (!fs.existsSync(memDir)) return '';
  const files = ['MEMORY.md', 'topics.md', 'history.md', 'SOUL.md'];
  const blocks: string[] = [];
  for (const fname of files) {
    const fp = path.join(memDir, fname);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf-8').trim();
      if (content) blocks.push(`### ${fname}\n${content}`);
    }
  }
  return blocks.length ? `\n\n--- Subagent Memory ---\n${blocks.join('\n\n')}\n--- End Memory ---` : '';
}

/**
 * After a successful run, append to history.md.
 * The agent is responsible for writing its own structured memory (MEMORY.md, topics.md),
 * but we always record the raw task+result here for audit purposes.
 */
function appendHistory(agentId: string, task: string, result: string): void {
  const memDir = path.join(resolveSubagentDir(agentId), 'memory');
  if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
  const entry = [
    `\n## ${new Date().toISOString()}`,
    `**Task:** ${task.slice(0, 200)}`,
    `**Result:** ${result.slice(0, 500)}`,
    '',
  ].join('\n');
  fs.appendFileSync(path.join(memDir, 'history.md'), entry, 'utf-8');
}

/**
 * Try to extract a specific field from the agent's result.
 * Result may be plain text or JSON. If JSON, pull output_field.
 * Falls back to full result text.
 */
function extractField(result: string, field?: string): string {
  if (!field) return result.trim();
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed[field] !== undefined) return String(parsed[field]);
    }
  } catch { /* not JSON */ }

  // Try "field: value" pattern on a line
  const lineMatch = result.match(new RegExp(`${field}[:\\s]+["']?([^"'\\n]{1,500})["']?`, 'i'));
  if (lineMatch) return lineMatch[1].trim();

  return result.trim();
}

async function runDynamicSubagent(
  agentId: string,
  def: SubagentDef,
  fullPrompt: string,
  timeoutMs: number,
): Promise<{ success: boolean; result: string; durationMs: number; error?: string }> {
  const startMs = Date.now();
  const workspacePath = resolveSubagentDir(agentId);
  const maxSteps = Number(def.max_steps) > 0 ? Number(def.max_steps) : 15;
  const ollama = getOllamaClient();
  const reactor = new Reactor(ollama, maxSteps);

  const runPromise = reactor.run(fullPrompt, {
    role: 'executor',
    workspacePath,
    promptMode: 'minimal',
    maxSteps,
    label: `subagent:${agentId}`,
  });

  const timeoutPromise = new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error(`Subagent timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const result = await Promise.race([runPromise, timeoutPromise]);
    return {
      success: true,
      result: String(result || ''),
      durationMs: Date.now() - startMs,
    };
  } catch (err: any) {
    return {
      success: false,
      result: '',
      durationMs: Date.now() - startMs,
      error: String(err?.message || err || 'Unknown subagent execution error'),
    };
  }
}

// ─── Core runner ──────────────────────────────────────────────────────────────

async function runAgent(
  agentId: string,
  task: string,
  context?: Record<string, any>,
  timeoutMs = 60_000,
): Promise<{ success: boolean; result: string; durationMs: number; error?: string }> {
  const startMs = Date.now();

  // Build context block
  const contextBlock = context && Object.keys(context).length
    ? `\n\nWorkflow context:\n${JSON.stringify(context, null, 2)}`
    : '';

  // Path A: Named agent from agents.json config
  const configAgent = getAgentById(agentId);
  if (configAgent) {
    const r = await spawnAgent({ agentId, task: `${task}${contextBlock}`, timeoutMs });
    return { success: r.success, result: r.result || r.error || '', durationMs: r.durationMs, error: r.error };
  }

  // Path B: Dynamic subagent stored in .smallclaw/subagents/
  const def = loadDef(agentId);
  if (!def) {
    return {
      success: false, result: '',
      durationMs: Date.now() - startMs,
      error: `Subagent "${agentId}" not found. Create it first using SmallClaw's create_node_subagent tool.`,
    };
  }

  const memory = readMemoryBlock(agentId);
  const systemPromptPath = path.join(resolveSubagentDir(agentId), 'system_prompt.md');
  const systemPrompt = fs.existsSync(systemPromptPath)
    ? fs.readFileSync(systemPromptPath, 'utf-8')
    : def.system_instructions;

  const outputField = def.output_field || 'result';

  const fullPrompt = [
    `[SUBAGENT: ${def.name}]`,
    '',
    systemPrompt,
    memory,
    '',
    '--- TASK ---',
    task,
    contextBlock,
    '',
    '--- CONSTRAINTS ---',
    def.constraints.map((c: string) => `• ${c}`).join('\n'),
    '',
    `SUCCESS CRITERIA: ${def.success_criteria}`,
    '',
    `IMPORTANT: Return your response as a JSON object with a "${outputField}" field containing the final content.`,
    `Example: { "${outputField}": "your generated content here" }`,
  ].join('\n');

  return runDynamicSubagent(agentId, def, fullPrompt, timeoutMs);
}

// ─── POST /internal/agent-task ────────────────────────────────────────────────

internalAgentTaskRouter.post('/', async (req: express.Request, res: express.Response) => {
  // Token check — if SMALLCLAW_INTERNAL_TOKEN is set, enforce it
  const requiredToken = process.env.SMALLCLAW_INTERNAL_TOKEN || '';
  if (requiredToken) {
    const provided = String(req.headers['authorization'] || '').replace(/^bearer /i, '').trim();
    if (provided !== requiredToken) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
  }

  const { agentId, task, context, output_field, timeoutMs } = req.body || {};

  if (!agentId || typeof agentId !== 'string' || !agentId.trim()) {
    res.status(400).json({ success: false, error: 'agentId is required' });
    return;
  }
  if (!task || typeof task !== 'string' || !task.trim()) {
    res.status(400).json({ success: false, error: 'task is required' });
    return;
  }

  const timeout = Math.min(Math.max(Number(timeoutMs) || 60_000, 5_000), 300_000);

  console.log(`[InternalAgentTask] Running "${agentId}" | task: ${String(task).slice(0, 100)}`);

  const runResult = await runAgent(agentId.trim(), task.trim(), context, timeout);

  // Determine output_field: explicit request > def default > 'result'
  const def = loadDef(agentId.trim());
  const resolvedField = output_field || def?.output_field || undefined;

  const value = extractField(runResult.result, resolvedField);

  if (runResult.success) {
    appendHistory(agentId.trim(), task.trim(), value);
  }

  console.log(`[InternalAgentTask] "${agentId}" → ${runResult.success ? 'OK' : 'FAIL'} (${runResult.durationMs}ms)`);

  res.json({
    success: runResult.success,
    agentId: agentId.trim(),
    result: runResult.result,
    output_field: resolvedField,
    value,
    durationMs: runResult.durationMs,
    ...(runResult.error ? { error: runResult.error } : {}),
  });
});

// ─── GET /internal/agent-task/agents ─────────────────────────────────────────

internalAgentTaskRouter.get('/agents', (_req: express.Request, res: express.Response) => {
  const storePaths = [getPrimarySubagentStoreDir(), getLegacySubagentStoreDir()]
    .filter((value, index, arr) => arr.indexOf(value) === index);
  const agents: Array<{ id: string; name: string; description: string; output_field?: string }> = [];
  const seenIds = new Set<string>();

  try {
    for (const storePath of storePaths) {
      if (!fs.existsSync(storePath)) continue;
      for (const dir of fs.readdirSync(storePath)) {
        const def = loadDef(dir);
        if (!def) continue;
        if (seenIds.has(def.id)) continue;
        agents.push({ id: def.id, name: def.name, description: def.description, output_field: def.output_field });
        seenIds.add(def.id);
      }
    }
  } catch (err: any) {
    console.warn('[InternalAgentTask] Error listing agents:', err.message);
  }

  res.json({ success: true, agents, count: agents.length });
});
