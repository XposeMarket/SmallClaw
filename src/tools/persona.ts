/**
 * persona.ts — Personality Growth & Memory Flush Tools
 *
 * Three tools:
 *   - persona_update: surgically update SOUL.md, USER.md, IDENTITY.md in workspace
 *   - memory_flush:   write end-of-session memory before context compresses (called internally)
 *   - persona_read:   read a persona file so the AI can inspect before editing
 *
 * These tools let SmallClaw grow its personality, build knowledge of its user,
 * and preserve that knowledge across sessions and context resets.
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';

// ─── Allowed persona files ────────────────────────────────────────────────────

const ALLOWED_PERSONA_FILES = new Set([
  'SOUL.md',
  'USER.md',
  'IDENTITY.md',
  'MEMORY.md',
  'AGENTS.md',
  'TOOLS.md',
]);

function getWorkspacePath(): string {
  return getConfig().getWorkspacePath();
}

function resolvePersonaFile(filename: string): string | null {
  const clean = path.basename(filename.trim());
  if (!ALLOWED_PERSONA_FILES.has(clean)) return null;
  return path.join(getWorkspacePath(), clean);
}

// ─── persona_read ─────────────────────────────────────────────────────────────

export interface PersonaReadArgs {
  file: string; // one of SOUL.md, USER.md, IDENTITY.md, MEMORY.md, etc.
}

export async function executePersonaRead(args: PersonaReadArgs): Promise<ToolResult> {
  if (!args?.file?.trim()) {
    return { success: false, error: `file is required. Allowed: ${[...ALLOWED_PERSONA_FILES].join(', ')}` };
  }
  const absPath = resolvePersonaFile(args.file);
  if (!absPath) {
    return { success: false, error: `Not an editable persona file: "${args.file}". Allowed: ${[...ALLOWED_PERSONA_FILES].join(', ')}` };
  }
  if (!fs.existsSync(absPath)) {
    return { success: false, error: `File not found: ${args.file}` };
  }
  const content = fs.readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');
  const numbered = lines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join('\n');
  return {
    success: true,
    data: { file: args.file, lines: lines.length, size: content.length, content: numbered },
  };
}

export const personaReadTool = {
  name: 'persona_read',
  description:
    'Read a workspace persona file (SOUL.md, USER.md, IDENTITY.md, MEMORY.md, etc.) with line numbers. ' +
    'Always read before editing so you can make surgical changes.',
  execute: executePersonaRead,
  schema: {
    file: `string (required) — one of: ${[...ALLOWED_PERSONA_FILES].join(', ')}`,
  },
  jsonSchema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: { type: 'string', description: `Persona file to read: ${[...ALLOWED_PERSONA_FILES].join(', ')}` },
    },
    additionalProperties: false,
  },
};

// ─── persona_update ───────────────────────────────────────────────────────────

export type PersonaUpdateMode =
  | 'append_section'    // Add a new section at the end
  | 'upsert_line'       // Find a line by key and replace it, or append if not found
  | 'replace_section'   // Replace everything between two headings
  | 'full_rewrite';     // Replace the entire file (use sparingly)

export interface PersonaUpdateArgs {
  file: string;                   // SOUL.md, USER.md, etc.
  mode: PersonaUpdateMode;
  content: string;                // new content to insert/replace with
  section_heading?: string;       // for replace_section: heading to target (e.g. "## Notes")
  key?: string;                   // for upsert_line: substring to match existing line
  reason?: string;                // why this update (logged to daily memory)
}

export async function executePersonaUpdate(args: PersonaUpdateArgs): Promise<ToolResult> {
  if (!args?.file?.trim()) {
    return { success: false, error: 'file is required' };
  }
  if (!args?.mode?.trim()) {
    return { success: false, error: 'mode is required: append_section | upsert_line | replace_section | full_rewrite' };
  }
  if (!args?.content?.trim() && args.mode !== 'replace_section') {
    return { success: false, error: 'content is required' };
  }

  const absPath = resolvePersonaFile(args.file);
  if (!absPath) {
    return { success: false, error: `Not an editable persona file: "${args.file}". Allowed: ${[...ALLOWED_PERSONA_FILES].join(', ')}` };
  }

  let existing = '';
  if (fs.existsSync(absPath)) {
    existing = fs.readFileSync(absPath, 'utf-8');
  }

  let newContent: string;

  switch (args.mode) {
    case 'append_section': {
      // Append a new block at the end of the file
      const sep = existing.trimEnd() ? '\n\n' : '';
      newContent = existing.trimEnd() + sep + args.content.trim() + '\n';
      break;
    }

    case 'upsert_line': {
      // Find a line containing the key and replace it, or append
      if (!args.key?.trim()) {
        return { success: false, error: 'key is required for upsert_line mode' };
      }
      const lines = existing.split('\n');
      const keyLower = args.key.toLowerCase();
      const matchIdx = lines.findIndex(l => l.toLowerCase().includes(keyLower));
      if (matchIdx >= 0) {
        lines[matchIdx] = args.content.trim();
        newContent = lines.join('\n');
      } else {
        // Not found — append
        newContent = existing.trimEnd() + '\n' + args.content.trim() + '\n';
      }
      break;
    }

    case 'replace_section': {
      // Replace content between two headings
      if (!args.section_heading?.trim()) {
        return { success: false, error: 'section_heading is required for replace_section mode' };
      }
      const heading = args.section_heading.trim();
      const lines = existing.split('\n');
      const startIdx = lines.findIndex(l => l.trim() === heading || l.trim().startsWith(heading));
      if (startIdx < 0) {
        // Section not found — append it as a new section
        const sep = existing.trimEnd() ? '\n\n' : '';
        newContent = existing.trimEnd() + sep + heading + '\n\n' + (args.content?.trim() || '') + '\n';
      } else {
        // Find the next heading of same or higher level
        const headingLevel = (heading.match(/^#+/) || [''])[0].length;
        let endIdx = lines.length;
        for (let i = startIdx + 1; i < lines.length; i++) {
          const m = lines[i].match(/^(#+)\s/);
          if (m && m[1].length <= headingLevel) {
            endIdx = i;
            break;
          }
        }
        const before = lines.slice(0, startIdx + 1).join('\n');
        const after = lines.slice(endIdx).join('\n');
        const mid = '\n\n' + (args.content?.trim() || '') + '\n\n';
        newContent = before + mid + (after ? after : '');
      }
      break;
    }

    case 'full_rewrite': {
      newContent = args.content.trim() + '\n';
      break;
    }

    default:
      return { success: false, error: `Unknown mode: "${args.mode}". Use: append_section | upsert_line | replace_section | full_rewrite` };
  }

  // Write atomically
  const tmp = `${absPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, newContent, 'utf-8');
  fs.renameSync(tmp, absPath);

  // Log the update to today's daily memory
  try {
    const today = new Date().toISOString().slice(0, 10);
    const memDir = path.join(getWorkspacePath(), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const logPath = path.join(memDir, `${today}.md`);
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const reason = args.reason ? ` — ${args.reason}` : '';
    fs.appendFileSync(logPath, `[${ts}] **persona_update** ${args.file} (${args.mode})${reason}\n`);
  } catch {}

  return {
    success: true,
    stdout: `${args.file} updated (${args.mode}).${args.reason ? ' Reason: ' + args.reason : ''}`,
    data: { file: args.file, mode: args.mode, chars_written: newContent.length },
  };
}

export const personaUpdateTool = {
  name: 'persona_update',
  description:
    'Update a workspace personality file (SOUL.md, USER.md, IDENTITY.md, MEMORY.md). ' +
    'Use this to grow your personality, record user preferences, and keep your model of the user current. ' +
    'ALWAYS use persona_read first to see the current content. ' +
    'Prefer upsert_line for single facts, append_section for new topics, replace_section for updating existing sections.',
  execute: executePersonaUpdate,
  schema: {
    file: `string (required) — file to update: ${[...ALLOWED_PERSONA_FILES].join(', ')}`,
    mode: 'string (required) — append_section | upsert_line | replace_section | full_rewrite',
    content: 'string (required) — new content to insert or replace with',
    section_heading: 'string (for replace_section) — heading to target, e.g. "## Notes"',
    key: 'string (for upsert_line) — substring to find the target line',
    reason: 'string (optional) — brief note about why this update is being made',
  },
  jsonSchema: {
    type: 'object',
    required: ['file', 'mode', 'content'],
    properties: {
      file: { type: 'string' },
      mode: { type: 'string', enum: ['append_section', 'upsert_line', 'replace_section', 'full_rewrite'] },
      content: { type: 'string' },
      section_heading: { type: 'string' },
      key: { type: 'string' },
      reason: { type: 'string' },
    },
    additionalProperties: false,
  },
};

// ─── memory_flush (internal — called by server-v2 when context is getting long) ──

export interface MemoryFlushResult {
  triggered: boolean;
  reason: string;
  messageInjected?: string;
}

/**
 * Check if a memory flush should fire based on history length.
 * OpenClaw triggers this at ~70% context utilization.
 * For SmallClaw with 8K context, trigger at 25+ messages.
 */
export function shouldTriggerMemoryFlush(historyLength: number, maxMessages: number = 30): boolean {
  return historyLength >= Math.floor(maxMessages * 0.8);
}

/**
 * Build the silent memory flush system message.
 * This is injected into the next turn when context pressure is detected.
 * The model should write durable notes and reply with NO_REPLY if nothing meaningful to write.
 */
export function buildMemoryFlushPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    '[SYSTEM: Context window is getting long. Before this session compacts, do the following NOW:]',
    '1. Use memory_write to persist any new facts, preferences, or decisions learned this session',
    '2. Use persona_update to update USER.md with anything new you learned about your human',
    '3. Write a brief session note to memory/' + today + '.md using the write tool',
    '4. If you updated SOUL.md, note what changed',
    '',
    'After writing, reply with just: NO_REPLY',
    'Only send a real reply if there is something important the user needs to know.',
    '[/SYSTEM]',
  ].join('\n');
}
