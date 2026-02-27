import { ToolResult } from '../types.js';
import { loadMemory, updateMemory } from '../config/soul-loader.js';
import { queryFactRecords } from '../gateway/fact-store.js';
import { sanitizeMemoryText } from './memory-utils.js';

// MEMORY_WRITE: model appends or replaces a bullet in memory.md
export async function executeMemoryWrite(args: { fact: string; action?: 'append' | 'replace_all' | 'upsert'; key?: string; reference?: string; source_tool?: string; source_output?: string; actor?: 'agent' | 'user' | 'system' }): Promise<ToolResult> {
  if (!args.fact?.trim()) return { success: false, error: 'fact is required' };
  const action = args.action ?? 'append';

  try {
    const fact = sanitizeMemoryText(args.fact.trim());
    const actor = args.actor || 'agent';
    const reference = args.reference ? sanitizeMemoryText(args.reference) : undefined;
    const source_tool = args.source_tool ? sanitizeMemoryText(args.source_tool) : undefined;
    const source_output = args.source_output ? sanitizeMemoryText(args.source_output) : undefined;
    const key = args.key ? sanitizeMemoryText(args.key) : undefined;

    // Build bullet with metadata
    const metaParts: string[] = [];
    metaParts.push(`[${actor}]`);
    if (key) metaParts.push(`[key=${key}]`);
    if (reference) metaParts.push(`[ref=${reference}]`);
    if (source_tool) metaParts.push(`[src=${source_tool}]`);
    const meta = metaParts.join('');
    const bullet = `- ${meta} ${fact}`;

    if (action === 'replace_all') {
      updateMemory(`# Memory\n\n${bullet}\n`);
    } else if (action === 'upsert') {
      const current = loadMemory();
      const lines = current ? current.split(/\r?\n/) : [];
      const hasHeader = lines.some(l => /^#\s*memory\b/i.test(l.trim()));
      const keyPattern = key ? new RegExp(`\\[key=${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`) : null;
      const filtered = lines.filter(line => {
        const t = line.trim();
        if (!t) return true;
        if (/^#\s*memory\b/i.test(t)) return true;
        if (!t.startsWith('-')) return true;
        if (keyPattern && keyPattern.test(t)) return false;
        return true;
      });
      const out = [];
      if (hasHeader) out.push(...filtered);
      else out.push('# Memory', '', ...filtered.filter(l => l.trim() !== '# Memory'));
      if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
      out.push(bullet);
      out.push('');
      updateMemory(out.join('\n'));
    } else {
      const current = loadMemory();
      // Remove placeholder line if present
      const cleaned = current.replace(/- First run: no facts stored yet\.|\n?/, '').trim();
      const bullets = cleaned ? `${cleaned}\n${bullet}\n` : `# Memory\n\n${bullet}\n`;
      updateMemory(bullets);
    }

    return { success: true, stdout: `Memory updated: ${fact}` };
  } catch (err: any) {
    return { success: false, error: `Memory write failed: ${err.message}` };
  }
}

export const memoryWriteTool = {
  name: 'memory_write',
  description: 'Persist a fact to long-term memory (survives restarts)',
  execute: executeMemoryWrite,
  schema: {
    fact: 'string (required) - The fact to remember (e.g. "User prefers Python 3.12")',
    action: 'string (optional) - "append" (default) adds a new bullet, "upsert" replaces bullet with same key, "replace_all" clears and rewrites',
    key: 'string (optional) - unique key for upsert (e.g., "fact:us-attorney-general")',
    reference: 'string (optional) - job id or session reference to associate with this fact',
    source_tool: 'string (optional) - tool that produced this fact (e.g., web_search)',
    source_output: 'string (optional) - raw tool output or snippet',
    actor: 'string (optional) - who added the fact: agent|user|system'
  },
};

// MEMORY_SEARCH: semantic lookup over typed memory facts
export async function executeMemorySearch(args: { query: string; session_id?: string; max?: number }): Promise<ToolResult> {
  const query = String(args?.query || '').trim();
  if (!query) return { success: false, error: 'query is required' };

  try {
    const sessionId = String(args?.session_id || '').trim() || undefined;
    const maxRaw = Number(args?.max ?? 5);
    const max = Number.isFinite(maxRaw) ? Math.min(Math.max(Math.floor(maxRaw), 1), 25) : 5;

    const matches = queryFactRecords({
      query,
      session_id: sessionId,
      includeGlobal: true,
      max,
      includeStale: false,
    });

    const results = matches.map((m) => ({
      key: m.key,
      value: m.value,
      scope: m.scope,
      session_id: m.session_id,
      type: m.type,
      confidence: m.confidence,
      source_tool: m.source_tool,
      source_url: m.source_url,
      updated_at: m.updated_at,
      verified_at: m.verified_at,
      expires_at: m.expires_at,
      actor: m.actor,
    }));

    const stdout = results.length
      ? results.map((r, i) => `${i + 1}. [${r.key}] ${r.value}`).join('\n')
      : 'No memory matches found.';

    return {
      success: true,
      stdout,
      data: {
        query,
        session_id: sessionId,
        count: results.length,
        results,
      },
    };
  } catch (err: any) {
    return { success: false, error: `Memory search failed: ${err.message}` };
  }
}

export const memorySearchTool = {
  name: 'memory_search',
  description: 'Search long-term memory for relevant facts',
  execute: executeMemorySearch,
  schema: {
    query: 'string (required) - what to look for',
    session_id: 'string (optional) - narrow to session scope',
    max: 'number (optional, default 5) - max results',
  },
};
