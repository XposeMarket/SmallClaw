/**
 * memory-file-search.ts — Keyword search across persona files
 *
 * Exposes memory_file_search tool: searches USER.md + SOUL.md (+ optionally
 * IDENTITY.md and today's intraday notes) by keyword, returning only matching
 * snippets — not full file contents.
 *
 * Distinct from memory_search which searches the structured fact store.
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';

export async function executeMemoryFileSearch(args: {
  keywords: string | string[];
  scope?: string;
  context_lines?: number;
}): Promise<ToolResult> {
  // Parse keywords
  let keywords: string[] = [];
  if (Array.isArray(args?.keywords)) {
    keywords = args.keywords.map(k => String(k).toLowerCase().trim()).filter(Boolean);
  } else if (typeof args?.keywords === 'string') {
    keywords = args.keywords
      .split(/[\s,]+/)
      .map(k => k.toLowerCase().trim())
      .filter(k => k.length > 0);
  }

  if (keywords.length === 0) {
    return { success: false, error: 'No valid keywords provided' };
  }

  const scope = String(args?.scope || 'both').toLowerCase().trim();
  const contextLines = Math.max(0, Math.min(3, Number(args?.context_lines ?? 1)));

  const workspacePath = getConfig().getWorkspacePath();

  // Determine which files to search
  const filesToSearch: Array<{ label: string; path: string }> = [];

  if (scope === 'user' || scope === 'both') {
    filesToSearch.push({ label: 'user.md', path: path.join(workspacePath, 'USER.md') });
  }
  if (scope === 'soul' || scope === 'both') {
    filesToSearch.push({ label: 'soul.md', path: path.join(workspacePath, 'SOUL.md') });
  }
  if (scope === 'identity') {
    filesToSearch.push({ label: 'identity.md', path: path.join(workspacePath, 'IDENTITY.md') });
  }
  if (scope === 'intraday') {
    const today = new Date().toISOString().split('T')[0];
    filesToSearch.push({
      label: `intraday-notes (${today})`,
      path: path.join(workspacePath, 'memory', `${today}-intraday-notes.md`),
    });
  }

  const matches: Array<{
    file: string;
    line_number: number;
    matched_keywords: string[];
    snippet: string;
    relevance: number;
  }> = [];

  for (const fileInfo of filesToSearch) {
    if (!fs.existsSync(fileInfo.path)) continue;

    const content = fs.readFileSync(fileInfo.path, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const lowerLine = lines[i].toLowerCase();
      const matchedKeywords = keywords.filter(kw => lowerLine.includes(kw));
      if (matchedKeywords.length === 0) continue;

      const startLine = Math.max(0, i - contextLines);
      const endLine = Math.min(lines.length - 1, i + contextLines);
      const snippet = lines.slice(startLine, endLine + 1).join('\n');

      matches.push({
        file: fileInfo.label,
        line_number: i + 1,
        matched_keywords: matchedKeywords,
        snippet,
        relevance: matchedKeywords.length / keywords.length,
      });
    }
  }

  // Sort by relevance, limit to 15 matches
  matches.sort((a, b) => b.relevance - a.relevance || a.line_number - b.line_number);
  const limited = matches.slice(0, 15);

  const stdout = limited.length > 0
    ? limited.map(m =>
        `[${m.file}:${m.line_number}] (matched: ${m.matched_keywords.join(', ')})\n${m.snippet}`
      ).join('\n\n---\n\n')
    : 'No matches found.';

  return {
    success: true,
    stdout,
    data: {
      keywords,
      scope,
      total_matches: matches.length,
      shown: limited.length,
      matches: limited,
      note: 'Returns snippets only, not full files. Limited to top 15 matches.',
    },
  };
}

export const memoryFileSearchTool = {
  name: 'memory_file_search',
  description: 'Search persona files (USER.md, SOUL.md, IDENTITY.md, intraday notes) by keyword. Returns matching snippets only — not full file. Use when you want to quickly check if something was recorded without reading the whole file.',
  execute: executeMemoryFileSearch,
  schema: {
    keywords: 'string or array (required) — keywords to search for (space/comma separated)',
    scope: 'string (optional) — which files: user, soul, identity, intraday, or both (default: both = user+soul)',
    context_lines: 'number (optional, 0-3) — lines of context around each match (default: 1)',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      keywords: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'Keywords to search for',
      },
      scope: {
        type: 'string',
        enum: ['user', 'soul', 'identity', 'intraday', 'both'],
        description: 'Which files to search (default: both = user + soul)',
      },
      context_lines: {
        type: 'number',
        description: 'Lines of context around each match (0-3, default: 1)',
      },
    },
    required: ['keywords'],
    additionalProperties: false,
  },
};
