/**
 * source-access.ts — Read-Only Access to SmallClaw Source Code
 *
 * Gives the AI the ability to read its own source files for error analysis
 * and self-repair planning. Deliberately READ-ONLY — no writes, no deletes.
 *
 * All paths are resolved relative to src/ and clamped there (no traversal).
 * These tools are registered in registry.ts alongside all other tools.
 */

import fs from 'fs';
import path from 'path';
import { ToolResult } from '../types.js';

// ─── Path Resolution ──────────────────────────────────────────────────────────

function resolveSourceRoot(): string {
  // Works from both src/ (dev) and dist/ (compiled) contexts
  return path.resolve(__dirname, '..', '..', 'src');
}

function resolveSourcePath(relPath: string): string | null {
  const srcRoot = resolveSourceRoot();
  const resolved = path.resolve(srcRoot, relPath);
  // Security: clamp strictly inside src/
  if (!resolved.startsWith(srcRoot + path.sep) && resolved !== srcRoot) return null;
  return resolved;
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ─── read_source ──────────────────────────────────────────────────────────────

export interface ReadSourceArgs {
  path: string;         // relative to src/ e.g. "gateway/telegram-channel.ts"
  start_line?: number;  // 1-based, default 1
  num_lines?: number;   // default 120, max 300
}

export async function executeReadSource(args: ReadSourceArgs): Promise<ToolResult> {
  if (!args?.path?.trim()) {
    return { success: false, error: 'path is required (relative to src/, e.g. "gateway/server-v2.ts")' };
  }

  const absPath = resolveSourcePath(args.path.trim());
  if (!absPath) {
    return { success: false, error: `Path escapes src/ directory: ${args.path}` };
  }

  if (!fs.existsSync(absPath)) {
    return { success: false, error: `Source file not found: src/${args.path}` };
  }

  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    return { success: false, error: `Not a file: src/${args.path} — use list_source to browse directories` };
  }

  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch (err: any) {
    return { success: false, error: `Failed to read file: ${err.message}` };
  }

  const allLines = content.split('\n');
  const totalLines = allLines.length;
  const MAX_LINES = 300;
  const DEFAULT_LINES = 120;

  const startLine = Math.max(1, Number(args.start_line || 1) || 1);
  const numLines = Math.min(MAX_LINES, Math.max(1, Number(args.num_lines || DEFAULT_LINES) || DEFAULT_LINES));
  const startIdx = startLine - 1;
  const slice = allLines.slice(startIdx, startIdx + numLines);

  // Format with line numbers (matches how read_file works in workspace)
  const numbered = slice.map((line, i) => `${String(startLine + i).padStart(4)} | ${line}`).join('\n');

  return {
    success: true,
    data: {
      path: `src/${args.path}`,
      abs_path: absPath,
      total_lines: totalLines,
      file_size: formatSize(stat.size),
      window: {
        start_line: startLine,
        end_line: startLine + slice.length - 1,
        returned_lines: slice.length,
        truncated: totalLines > (startLine - 1 + numLines),
      },
      content: numbered,
    },
  };
}

export const readSourceTool = {
  name: 'read_source',
  description:
    'Read a SmallClaw source file (read-only). Use this to analyze errors, understand how a module works, ' +
    'or prepare a repair proposal. Paths are relative to src/ e.g. "gateway/telegram-channel.ts". ' +
    'Returns numbered lines. Use start_line + num_lines to paginate large files.',
  execute: executeReadSource,
  schema: {
    path: 'string (required) — path relative to src/, e.g. "gateway/server-v2.ts" or "tools/files.ts"',
    start_line: 'number (optional) — 1-based start line, default 1',
    num_lines: 'number (optional) — lines to return, default 120, max 300',
  },
  jsonSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Path relative to src/, e.g. "gateway/server-v2.ts"' },
      start_line: { type: 'number', description: '1-based start line (default 1)' },
      num_lines: { type: 'number', description: 'Lines to return (default 120, max 300)' },
    },
    additionalProperties: false,
  },
};

// ─── list_source ──────────────────────────────────────────────────────────────

export interface ListSourceArgs {
  path?: string; // relative to src/, default "" = root of src/
}

export async function executeListSource(args: ListSourceArgs): Promise<ToolResult> {
  const relPath = (args?.path || '').trim();
  const absPath = relPath ? resolveSourcePath(relPath) : resolveSourceRoot();

  if (!absPath) {
    return { success: false, error: `Path escapes src/ directory: ${relPath}` };
  }

  if (!fs.existsSync(absPath)) {
    return { success: false, error: `Directory not found: src/${relPath || ''}` };
  }

  const stat = fs.statSync(absPath);
  if (!stat.isFile() && !stat.isDirectory()) {
    return { success: false, error: `Not a file or directory: src/${relPath}` };
  }

  // If it's actually a file, just describe it
  if (stat.isFile()) {
    return {
      success: true,
      data: {
        path: `src/${relPath}`,
        type: 'file',
        size: formatSize(stat.size),
        note: 'Use read_source to read this file',
      },
    };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch (err: any) {
    return { success: false, error: `Failed to list directory: ${err.message}` };
  }

  const dirs = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  const files = entries
    .filter(e => e.isFile())
    .map(e => {
      const size = formatSize(fs.statSync(path.join(absPath, e.name)).size);
      return { name: e.name, size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const srcRoot = resolveSourceRoot();
  const displayPath = `src/${path.relative(srcRoot, absPath).replace(/\\/g, '/') || ''}`.replace(/\/$/, '');

  return {
    success: true,
    data: {
      path: displayPath,
      directories: dirs,
      files: files.map(f => `${f.name} (${f.size})`),
      total_entries: entries.length,
    },
  };
}

export const listSourceTool = {
  name: 'list_source',
  description:
    'List files and directories inside the SmallClaw src/ folder. ' +
    'Use with no args to see the top-level structure. ' +
    'Pass a subdirectory like "gateway" or "tools" to drill in.',
  execute: executeListSource,
  schema: {
    path: 'string (optional) — subdirectory relative to src/, e.g. "gateway" or "tools". Omit for root.',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Subdirectory relative to src/ (omit for root listing)' },
    },
    additionalProperties: false,
  },
};
