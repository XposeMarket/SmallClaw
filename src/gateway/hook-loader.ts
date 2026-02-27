import fs from 'fs';
import os from 'os';
import path from 'path';
import { hookBus, type HookEvent } from './hooks.js';

const ALLOWED_EVENTS: Set<HookEvent['type']> = new Set([
  'gateway:startup',
  'command:new',
  'command:reset',
  'command:stop',
  'agent:bootstrap',
]);

function parseHookEvents(hookMdPath: string): HookEvent['type'][] {
  if (!fs.existsSync(hookMdPath)) return ['command:new'];
  try {
    const raw = fs.readFileSync(hookMdPath, 'utf-8');
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match) return ['command:new'];
    const frontmatter = match[1];
    const eventLine = frontmatter
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^events?\s*:/i.test(line));
    if (!eventLine) return ['command:new'];
    const rhs = eventLine.split(':').slice(1).join(':').trim();
    const normalized = rhs
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const valid = normalized.filter((evt): evt is HookEvent['type'] => ALLOWED_EVENTS.has(evt as HookEvent['type']));
    return valid.length > 0 ? valid : ['command:new'];
  } catch {
    return ['command:new'];
  }
}

function registerHooksFromDir(rootHooksDir: string): void {
  if (!fs.existsSync(rootHooksDir)) return;
  const entries = fs.readdirSync(rootHooksDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hookDir = path.join(rootHooksDir, entry.name);
    const handlerPath = path.join(hookDir, 'handler.js');
    if (!fs.existsSync(handlerPath)) continue;

    try {
      const mod = require(handlerPath);
      const handler = mod?.default || mod;
      if (typeof handler !== 'function') {
        console.warn(`[hooks] Skipping ${entry.name}: handler.js must export a function`);
        continue;
      }
      const events = parseHookEvents(path.join(hookDir, 'HOOK.md'));
      for (const eventType of events) {
        hookBus.register(eventType as any, handler as any);
      }
      console.log(`[hooks] Loaded hook: ${entry.name} (${events.join(', ')})`);
    } catch (err: any) {
      console.warn(`[hooks] Failed to load ${entry.name}: ${String(err?.message || err)}`);
    }
  }
}

export function loadWorkspaceHooks(workspacePath: string): void {
  const workspaceHooks = path.join(workspacePath, 'hooks');
  registerHooksFromDir(workspaceHooks);
}

export function loadBuiltinHookDirectories(workspacePath: string): void {
  // Minimal discovery order: user home hooks first, then workspace hooks.
  const homeHooks = path.join(os.homedir(), '.localclaw', 'hooks');
  registerHooksFromDir(homeHooks);
  registerHooksFromDir(path.join(workspacePath, 'hooks'));
}
