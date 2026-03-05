/**
 * memory-read.ts — Read full persona file contents
 *
 * Exposes memory_read tool: reads USER.md, SOUL.md, or IDENTITY.md in full.
 * Complements memory_search (snippets) and persona_read (line-numbered).
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';

const FILE_MAP: Record<string, string> = {
  user: 'USER.md',
  soul: 'SOUL.md',
  identity: 'IDENTITY.md',
  memory: 'MEMORY.md',
};

export async function executeMemoryRead(args: { target: string }): Promise<ToolResult> {
  const target = String(args?.target || '').toLowerCase().trim();
  const filename = FILE_MAP[target];

  if (!filename) {
    return {
      success: false,
      error: `Invalid target "${target}". Valid options: ${Object.keys(FILE_MAP).join(', ')}`,
    };
  }

  try {
    const workspacePath = getConfig().getWorkspacePath();
    const filePath = path.join(workspacePath, filename);

    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        error: `File not found: ${filename}`,
      };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      success: true,
      stdout: content,
      data: {
        target,
        file: filename,
        line_count: content.split('\n').length,
        char_count: content.length,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to read ${FILE_MAP[target] || target}: ${err.message}`,
    };
  }
}

export const memoryReadTool = {
  name: 'memory_read',
  description: 'Read complete contents of a persona/memory file (user, soul, identity, or memory). Use when you need full context before making updates.',
  execute: executeMemoryRead,
  schema: {
    target: 'string (required) — which file to read: user, soul, identity, or memory',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['user', 'soul', 'identity', 'memory'],
        description: 'Which memory file to read in full',
      },
    },
    required: ['target'],
    additionalProperties: false,
  },
};
