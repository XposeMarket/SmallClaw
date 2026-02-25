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
import { getSession, addMessage, getHistory, getWorkspace, clearHistory } from './session';
import { TaskRunner, runTask, TaskTool, TaskState } from './task-runner';
import { SkillsManager } from './skills-manager';
import { browserOpen, browserSnapshot, browserClick, browserFill, browserPressKey, browserWait, browserClose, getBrowserToolDefinitions, getBrowserSessionInfo } from './browser-tools';
import { CronScheduler } from './cron-scheduler';
import { TelegramChannel } from './telegram-channel';

// ─── Config ────────────────────────────────────────────────────────────────────

const config = getConfig().getConfig();
const PORT = config.gateway.port || 18789;
const HOST = config.gateway.host || '127.0.0.1';
const MAX_TOOL_ROUNDS = 12;

// Search config is now read dynamically from config on each request
// so changing keys via settings takes effect immediately without restart

// Active tasks (keyed by session)
const activeTasks: Map<string, TaskState> = new Map();

// Safe commands allowlist for run_command — platform-aware
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const SAFE_COMMANDS: Record<string, string> = isMac ? {
  'chrome': 'open -a "Google Chrome"',
  'browser': 'open -a "Google Chrome"',
  'firefox': 'open -a Firefox',
  'edge': 'open -a "Microsoft Edge"',
  'notepad': 'open -a TextEdit',
  'calc': 'open -a Calculator',
  'calculator': 'open -a Calculator',
  'explorer': 'open .',
  'finder': 'open .',
  'terminal': 'open -a Terminal',
  'cmd': 'open -a Terminal',
} : isLinux ? {
  'chrome': 'google-chrome',
  'browser': 'xdg-open https://google.com',
  'firefox': 'firefox',
  'notepad': 'gedit',
  'calc': 'gnome-calculator',
  'calculator': 'gnome-calculator',
  'explorer': 'xdg-open .',
  'terminal': 'x-terminal-emulator',
  'cmd': 'x-terminal-emulator',
} : {
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
};

const BLOCKED_PATTERNS = ['del ', 'rm ', 'format', 'shutdown', 'restart', 'rmdir', 'rd ', 'taskkill', 'reg '];

// Track last-used filename per session for when model forgets to pass it
const lastFilenameUsed: Map<string, string> = new Map();

// Skills system
const skillsDir = (config as any).skills?.directory || path.join(process.cwd(), '.localclaw', 'skills');
const skillsManager = new SkillsManager(skillsDir, '');
console.log(`[Skills] Directory: ${skillsDir}`);

// ─── Model-Busy Guard ──────────────────────────────────────────────────────────
// Prevents cron scheduler from firing while user chat is in-flight.
// Critical for 4B models — can't handle parallel inference.

let isModelBusy = false;

// ─── WebSocket Broadcast ───────────────────────────────────────────────────────
// wss is assigned after server creation below; broadcastWS is only ever called
// after startup (by cron ticks), so the late assignment is safe.

let wss: WebSocketServer;

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
  handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal) =>
    handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal),
  broadcast: broadcastWS,
  getIsModelBusy: () => isModelBusy,
  deliverTelegram: (text: string) => telegramChannel.sendToAllowed(text),
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
    handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext) =>
      handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext),
    addMessage,
    getIsModelBusy: () => isModelBusy,
    broadcast: broadcastWS,
  }
);

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

function buildPersonalityContext(workspacePath: string): string {
  const identity = loadWorkspaceFile(workspacePath, 'IDENTITY.md', 200);
  const soul = loadWorkspaceFile(workspacePath, 'SOUL.md', 500);
  const user = loadWorkspaceFile(workspacePath, 'USER.md', 300);
  const memory = loadWorkspaceFile(workspacePath, 'MEMORY.md', 600);

  // NOTE: Daily log (memory/YYYY-MM-DD.md) is intentionally NOT injected here.
  // It is written by logToDaily() and will be consumed by the heartbeat/cron system.
  // Injecting it live causes stale/cleared conversations to bleed into new chats.

  const parts: string[] = [];
  if (identity) parts.push(`[IDENTITY]\n${identity}`);
  if (soul) parts.push(`[SOUL]\n${soul}`);
  if (user) parts.push(`[USER]\n${user}`);
  if (memory) parts.push(`[MEMORY]\n${memory}`);

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
        description: 'Open apps for the USER to see — you CANNOT interact with what it opens. Use "chrome" to open browser, "chrome youtube.com" to open a URL, "notepad" for notepad, "code D:\\path" for VS Code. If you need to interact with a webpage (click, read, fill forms), use browser_open instead.',
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
  console.log(`[v2] Google key: ...${GOOGLE_API_KEY.slice(-6)} | CX: ${GOOGLE_CX.slice(0,8)}... | lengths: key=${GOOGLE_API_KEY.length} cx=${GOOGLE_CX.length}`);
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

async function executeTool(name: string, args: any, workspacePath: string, sessionId: string = 'default'): Promise<ToolResult> {
  // Filename inference: if the model forgot to pass filename, use the last one
  const needsFilename = ['read_file', 'create_file', 'replace_lines', 'insert_after', 'delete_lines', 'find_replace', 'delete_file'];
  if (needsFilename.includes(name)) {
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
        const content = args.content || '';
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
          const appCmd = SAFE_COMMANDS[app] || (isMac ? 'open' : 'start chrome');
          execCmd = isMac ? `open "${url}"` : `${appCmd} ${url}`;
        }
        // 3. Plain URL → open in default browser
        else if (/^(https?:\/\/|www\.)/.test(cmd)) {
          const url = cmd.startsWith('www.') ? 'https://' + rawCmd : rawCmd;
          execCmd = isMac ? `open "${url}"` : isLinux ? `xdg-open "${url}"` : `start "" "${url}"`;
        }
        // 4. Bare domain like "youtube.com" → open in browser
        else if (/^[a-z0-9-]+\.[a-z]{2,}/.test(cmd) && !cmd.includes(' ')) {
          execCmd = isMac ? `open "https://${rawCmd}"` : isLinux ? `xdg-open "https://${rawCmd}"` : `start "" "https://${rawCmd}"`;
        }
        // 5. "code <path>" → VS Code
        else if (cmd.startsWith('code ')) {
          execCmd = rawCmd;
        }
        // 6. "start <url>" → pass through
        else if (cmd.startsWith('start http') || cmd.startsWith('start https')) {
          execCmd = rawCmd;
        }
        // 7. "explorer <path>"
        else if (cmd.startsWith('explorer ')) {
          execCmd = rawCmd;
        }

        if (!execCmd) {
          return { name, args, result: `Command "${rawCmd}" not recognized. Try: chrome, chrome youtube.com, notepad, code <path>, or a URL`, error: true };
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
      case 'browser_close': {
        const result = await browserClose(sessionId);
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

// ─── Main Chat Handler ─────────────────────────────────────────────────────────

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
  callerContext?: string
): Promise<HandleChatResult> {
  const ollama = getOllamaClient();
  const workspacePath = getWorkspace(sessionId);
  const history = getHistory(sessionId, 5);
  const tools = buildTools();
  const allToolResults: ToolResult[] = [];
  let allThinking = '';
  const seenToolCalls = new Set<string>();

  const personalityCtx = buildPersonalityContext(workspacePath);

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

  const messages: any[] = [
    {
      role: 'system',
      content: `You are SmallClaw 🦞, a friendly AI assistant that runs locally.
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
- run_command: Open apps for the USER to see (chrome, notepad, vscode). You CANNOT interact with what it opens.
- start_task: Launch a multi-step task (for complex operations needing many steps)
- browser_open: Navigate to a URL in a browser YOU control (can click, fill, snapshot after)
- browser_snapshot: Refresh visible elements. If element count looks low, call browser_wait first
- browser_click: Click by @ref. ALWAYS take browser_snapshot after to confirm the click worked
- browser_fill: Type into an [INPUT] element by @ref, then press Enter or click submit
- browser_press_key: Press Enter/Tab/Escape. Use Enter after filling a search box
- browser_wait: Wait N ms then snapshot — use when page has few elements or content is still loading
- browser_close: Close browser tab

IDENTITY RULE:
Your name is SmallClaw. When a user asks you to search for, open, or find any external tool or project, look it up as requested. NEVER redirect to SmallClaw links or repos unless the user is specifically asking about SmallClaw itself. If a search fails, say so and ask for clarification.

BROWSER RULES:
1. run_command = opens window for user, you can't control it. browser_open = opens page you CAN control.
2. If you already have a browser open, DO NOT call browser_open again. Use browser_snapshot to see the current page, then browser_click to navigate.
3. browser_open RETURNS a snapshot — read it immediately. Find the correct link by @ref, then call browser_click to follow it.
4. After EVERY click, read the snapshot returned in the tool result to confirm what changed.
5. Prefer direct search URLs over clicking search boxes.

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

  logToDaily(workspacePath, 'User', message);

  sendSSE('info', { message: 'Thinking...' });
  console.log(`\n[v2] ── CHAT (native tools) ──`);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (abortSignal?.aborted) {
      console.log(`[v2] Aborted at round ${round} — client disconnected`);
      const partial = allToolResults.length > 0
        ? `Stopped after ${allToolResults.length} step${allToolResults.length !== 1 ? 's' : ''}.`
        : 'Stopped.';
      return { type: 'execute', text: partial, toolResults: allToolResults.length > 0 ? allToolResults : undefined };
    }

    let response: any;
    try {
      const result = await ollama.chatWithThinking(messages, 'executor', {
        tools, temperature: 0.3, num_ctx: 8192, num_predict: 4096, think: false,
      });
      response = result.message;
      if (result.thinking) {
        console.log(`[v2] THINK (${result.thinking.length} chars): ${result.thinking.slice(0, 150)}...`);
        allThinking += (allThinking ? '\n\n' : '') + result.thinking;
        sendSSE('thinking', { thinking: result.thinking });
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
          toolCalls = [{ function: { name: toolName, arguments: toolArgs } }];
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
      const queryNeedsTools = /\b(search|find|look up|latest|news|info|open|browse|what happened)\b/i.test(message);
      if (looksLikeReasoning && queryNeedsTools) {
        console.log(`[v2] AUTO-RECOVER: Model dumped ${content.length} chars of reasoning instead of calling tools. Re-prompting...`);
        allThinking += (allThinking ? '\n\n' : '') + content;
        sendSSE('thinking', { thinking: content.slice(0, 500) + '...' });
        // Inject a forceful nudge and retry this round
        messages.push({ role: 'assistant', content: 'Let me search for that now.' });
        messages.push({ role: 'user', content: 'Yes, use the web_search tool right now. Do NOT think or plan — just call web_search.' });
        sendSSE('info', { message: 'Re-prompting model to use tools...' });
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
      // If model dumped massive reasoning with no usable reply, generate a fallback
      let finalText = reply;
      if (!finalText || finalText.length < 5) {
        if (allToolResults.length > 0) {
          // Summarize what tools actually did
          const lastResult = allToolResults[allToolResults.length - 1];
          finalText = lastResult.error ? `Tool failed: ${lastResult.result.slice(0, 200)}` : 'Done!';
        } else {
          finalText = 'Hey! How can I help?';
        }
      }
      console.log(`[v2] FINAL: ${finalText.slice(0, 150)}`);

      logToDaily(workspacePath, 'LocalClaw', finalText);

      return {
        type: allToolResults.length > 0 ? 'execute' : 'chat',
        text: finalText,
        thinking: allThinking || undefined,
        toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      };
    }

    messages.push(response);

    const batchCreatedFiles = new Set<string>();

    for (const call of toolCalls) {
      const toolName = call.function?.name || 'unknown';
      const toolArgs = call.function?.arguments || {};

      if (toolName === 'create_file') {
        const fn = toolArgs.filename || toolArgs.name;
        if (fn && batchCreatedFiles.has(fn)) {
          console.log(`[v2] SKIP: duplicate create_file("${fn}") in same batch`);
          messages.push({ role: 'tool', tool_name: toolName, content: `${fn} already created in this batch. Use replace_lines to edit.` });
          continue;
        }
        if (fn) batchCreatedFiles.add(fn);
      }

      const callKey = `${toolName}:${JSON.stringify(toolArgs)}`;
      if (seenToolCalls.has(callKey)) {
        console.log(`[v2] SKIP: duplicate tool call ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);
        messages.push({ role: 'tool', tool_name: toolName, content: `Already ran this exact call. Use the previous result and move on.` });
        continue;
      }
      seenToolCalls.add(callKey);

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

      const toolResult = await executeTool(toolName, toolArgs, workspacePath, sessionId);
      allToolResults.push(toolResult);
      logToolCall(workspacePath, toolName, toolArgs, toolResult.result, toolResult.error);

      console.log(toolResult.error ? `[v2] TOOL FAIL: ${toolResult.result.slice(0, 100)}` : `[v2] TOOL OK: ${toolResult.result.slice(0, 100)}`);
      sendSSE('tool_result', { action: toolName, result: toolResult.result.slice(0, 500), error: toolResult.error, stepNum: allToolResults.length });

      const goalReminder = `\n\n[GOAL REMINDER: Your task is still: "${message.slice(0, 120)}". Stay focused on this goal only.]`;
      messages.push({ role: 'tool', tool_name: toolName, content: toolResult.result + goalReminder });
    }

    sendSSE('info', { message: `Processing... (step ${round + 1})` });
  }

  return { type: 'execute', text: 'Hit max steps.', toolResults: allToolResults };
}

// ─── SSE + Routes ──────────────────────────────────────────────────────────────

function createSSESender(res: express.Response): (event: string, data: any) => void {
  return (type: string, data: any) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {} };
}

const app = express();
app.use(cors());
app.use(express.json());

const webUiPath = path.join(__dirname, '..', '..', 'web-ui');
app.use(express.static(webUiPath));

app.get('/api/status', async (_req, res) => {
  const ollama = getOllamaClient();
  const connected = await ollama.testConnection();
  res.json({
    status: 'ok', version: 'v2-tools', ollama: connected,
    currentModel: config.models.primary, workspace: config.workspace.path,
    search: getConfig().getConfig().search?.google_api_key ? 'google' : (getConfig().getConfig().search?.tavily_api_key ? 'tavily' : 'none'),
  });
});

app.post('/api/chat', async (req, res) => {
  const { message, sessionId = 'default', pinnedMessages } = req.body;
  if (!message || typeof message !== 'string') { res.status(400).json({ error: 'Message required' }); return; }

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
    addMessage(sessionId, { role: 'user', content: message, timestamp: Date.now() });
    console.log(`\n[v2] USER: ${message.slice(0, 100)}`);
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

app.post('/api/clear-history', (req, res) => { clearHistory(req.body.sessionId || 'default'); res.json({ success: true }); });

// ─── Skills API ────────────────────────────────────────────────────────────────

app.get('/api/skills', (_req, res) => {
  const skills = skillsManager.getAll().map(s => ({
    id: s.id, name: s.name, description: s.description, emoji: s.emoji,
    version: s.version, enabled: s.enabled, createdAt: s.createdAt,
  }));
  res.json({ success: true, skills });
});

app.get('/api/skills/:id', (req, res) => {
  const skill = skillsManager.get(req.params.id);
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true, skill });
});

app.post('/api/skills/:id/toggle', (req, res) => {
  const skill = skillsManager.toggle(req.params.id);
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
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
  const { name, prompt, type, schedule, runAt, priority } = req.body;
  if (!name || !prompt) { res.status(400).json({ success: false, error: 'name and prompt required' }); return; }
  const job = cronScheduler.createJob({ name, prompt, type, schedule, runAt, priority });
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
  cronScheduler.runJobNow(req.params.id).catch(console.error);
});

app.get('/api/tasks/config', (_req, res) => {
  res.json({ success: true, config: cronScheduler.getConfig() });
});

app.put('/api/tasks/config', (req, res) => {
  cronScheduler.updateConfig(req.body);
  res.json({ success: true, config: cronScheduler.getConfig() });
});

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
    allowed_paths: (cfg as any).tools?.permissions?.files?.allowed_paths || [],
    blocked_paths: (cfg as any).tools?.permissions?.files?.blocked_paths || [],
  });
});

app.post('/api/settings/paths', (req, res) => {
  const { allowed_paths, blocked_paths } = req.body;
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
  cm.updateConfig({ tools } as any);
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

  // Try nvidia-smi for GPU stats (Windows/Linux)
  let gpuStats = { available: false, gpu_util_percent: 0, vram_used_percent: 0, vram_used_gb: 0, vram_total_gb: 0, name: '' };
  try {
    const { execSync } = await import('child_process');
    const smiOut = execSync('nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits', { timeout: 3000, encoding: 'utf8' });
    const parts = smiOut.trim().split(',').map(s => s.trim());
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
  } catch {}

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

app.get('*', (_req, res) => { res.sendFile(path.join(webUiPath, 'index.html')); });

// ─── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws: WebSocket) => {
  console.log('[v2] WS connected');
  ws.on('message', (d) => { try { JSON.parse(d.toString()); } catch {} });
  ws.on('close', () => console.log('[v2] WS disconnected'));
});

server.listen(PORT, HOST, () => {
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
  telegramChannel.start().catch(err => console.error('[Telegram] Start failed:', err.message));
});

process.on('SIGINT', () => { telegramChannel.stop(); cronScheduler.stop(); wss.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { telegramChannel.stop(); cronScheduler.stop(); wss.close(); server.close(); process.exit(0); });

export { app, server };
