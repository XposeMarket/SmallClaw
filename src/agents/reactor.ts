/**
 * reactor.ts - LocalClaw execute engine
 *
 * PRIMARY execute channel: node_call<...> pattern in model response text.
 *   The model writes: node_call<fs.readdirSync(WORKSPACE).filter(f => f.startsWith('golden'))>
 *   Backend detects via regex, sandboxes, runs, feeds result back.
 *
 * SECONDARY channel: Native Ollama function-call objects (model-emitted tool_calls[]).
 *   Used when the model happens to emit proper function-call JSON.
 *
 * REMOVED: THOUGHT/ACTION/PARAM text protocol, heuristic mappers, deterministic fallbacks.
 *
 * DISCUSS triggers (open_tool, open_web, open_confirm) are unchanged — those live in server.ts.
 */

import vm from 'vm';
import { OllamaClient } from './ollama-client.js';
import { getToolRegistry, ToolProfile } from '../tools/registry.js';
import { buildSystemPrompt, selectSkillSlugsForMessage } from '../config/soul-loader.js';
import { AgentRole } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReactStep {
  thought?: string;
  thinking?: string;
  action?: string;
  params?: any;
  toolResult?: string;
  toolData?: any;
  finalAnswer?: string;
  stepNum?: number;
  isFormatViolation?: boolean;
}

export interface ReactOptions {
  maxSteps?: number;
  role?: AgentRole;
  temperature?: number;
  onStep?: (step: ReactStep) => void;
  skillSlugs?: string[];
  extraInstructions?: string;
  label?: string;
  serverToolCall?: { tool: string; params: any; reason?: string } | null;
  allowHeuristicRouting?: boolean; // kept for API compat, ignored
  formatViolationFuse?: number;
  nativeOnly?: boolean; // kept for API compat, ignored — node_call is always primary now
  toolProfile?: ToolProfile;
}

// Detect FINAL: in model response
const FINAL_RE = /FINAL:\s*([\s\S]*?)(?:---END---|$)/i;

// Primary channel: detect node_call<...> anywhere in model response
// NOTE: we use a custom parser instead of a simple regex because the naive
// /node_call<([\s\S]+?)>/gi pattern terminates at the first '>' it finds,
// which breaks arrow functions (=>), comparisons (>=), and shift operators (>>).
export function extractNodeCallBlocks(text: string): string[] {
  const results: string[] = [];
  const marker = 'node_call<';
  let pos = 0;
  while (true) {
    const start = text.toLowerCase().indexOf(marker, pos);
    if (start === -1) break;
    const codeStart = start + marker.length;
    let i = codeStart;
    let found = false;
    while (i < text.length) {
      if (text[i] === '>') {
        const prev = i > 0 ? text[i - 1] : '';
        const next = i < text.length - 1 ? text[i + 1] : '';
        // Skip => (arrow function)
        if (prev === '=') { i++; continue; }
        // Skip >= (greater-than-or-equal)
        if (next === '=') { i += 2; continue; }
        // Skip >> and >>> (shift operators)
        if (next === '>') { i += 2; if (i < text.length && text[i] === '>') i++; continue; }
        // This > is the closing delimiter
        results.push(text.slice(codeStart, i));
        pos = i + 1;
        found = true;
        break;
      }
      i++;
    }
    if (!found) {
      // No closing > found — treat rest of text as code (model may have omitted closing >)
      results.push(text.slice(codeStart));
      break;
    }
  }
  return results;
}
// Keep regex for backward compat detection (e.g. checking if node_call exists in text)
const NODE_CALL_RE = /node_call</gi;
const URL_LIKE_RE = /\bhttps?:\/\/|www\./i;
const WEB_HINT_RE = /\b(url|link|website|web|internet|browse|scrape|crawl|fetch|search)\b/i;
const CODING_HINT_RE = /\b(code|script|file|folder|directory|path|repo|repository|build|compile|test|debug|patch|refactor|typescript|javascript|python|npm|node)\b/i;
const SKILL_HINT_RE = /\b(skill|clawhub)\b/i;
const GENERIC_REPEAT_WINDOW = 6;
const GENERIC_REPEAT_THRESHOLD = 3;

// ─── Constants ────────────────────────────────────────────────────────────────

// Destructive patterns — triggers open_confirm if no confirmation in session
const DESTRUCTIVE_NODE_RE = /(?:\/\/\s*DESTRUCTIVE|fs\.(unlinkSync|rmSync|rmdirSync|renameSync|truncateSync|writeFileSync|appendFileSync)|fs\.promises\.(unlink|rm|rmdir|rename|truncate|writeFile|appendFile)|\.rmdir\b|\.unlink\b|\.rename\b)/;

// Modules that must never be loaded inside sandbox
const BLOCKED_MODULES = new Set([
  'child_process', 'net', 'http', 'https', 'http2',
  'cluster', 'worker_threads', 'dgram', 'tls', 'dns',
  'vm', 'v8', 'inspector', 'repl', 'readline',
]);

// Format violation reprompt for node_call world
const NODE_CALL_REPROMPT =
  'INVALID OUTPUT. You must output either:\n' +
  '1) node_call<your Node.js code here> — to perform an action\n' +
  '2) FINAL: <answer> — if task is complete or you need to ask a question\n' +
  'Nothing else. No prose before or after.';

// Native tool-call path: disabled by default for small models (4b and under).
// The node_call<> text channel is far more reliable for Qwen3:4b.
// Set LOCALCLAW_NATIVE_TOOL_CALLS=1 to force-enable (useful for 32b+ models).
const NATIVE_TOOL_CALLS_ENABLED = (() => {
  const explicit = process.env.LOCALCLAW_NATIVE_TOOL_CALLS;
  if (explicit === '1' || explicit === 'true') return true;
  if (explicit === '0' || explicit === 'false') return false;
  // Auto-detect: disable for small models
  try {
    const { getConfig } = require('../config/config.js');
    const modelId = String(getConfig().getConfig()?.models?.primary || '').toLowerCase();
    // Models 7b and under: skip native tool calls (unreliable)
    if (/[:\-_](0\.5|1|1\.5|2|3|4|6|7)b/.test(modelId)) return false;
    // Larger models: enable native tool calls
    return true;
  } catch {
    return false; // safe default: use node_call channel
  }
})();
const EXECUTE_NUM_CTX = (() => {
  const n = Number(process.env.LOCALCLAW_EXECUTE_NUM_CTX || 4096);
  return Number.isFinite(n) && n >= 2048 ? Math.floor(n) : 4096;
})();
const EXECUTE_NUM_PREDICT = (() => {
  // With think=true, thinking tokens are separate — num_predict only covers code output.
  // 512 is plenty for multi-line code (delete loops, file ops, etc.).
  const n = Number(process.env.LOCALCLAW_EXECUTE_NUM_PREDICT || 512);
  return Number.isFinite(n) && n >= 256 ? Math.floor(n) : 512;
})();
const EXECUTE_THINK = (() => {
  // Default 'true' for execute mode. With think=true, Ollama returns thinking tokens
  // in a SEPARATE field (response.thinking) that does NOT count against num_predict.
  // This means the model can reason about what code to write (avoiding placeholder junk
  // and wrong operations) while num_predict goes entirely to the actual code output.
  // DO NOT use 'low' — it puts thinking inline in the response, eating the code budget.
  // DO NOT use 'false' — the model writes placeholder code or wrong operations.
  const raw = String(process.env.LOCALCLAW_EXECUTE_THINK || 'on').trim().toLowerCase();
  if (!raw || ['off', 'none', 'false', '0'].includes(raw)) return false;
  if (['low', 'medium', 'high'].includes(raw)) return raw as ('low' | 'medium' | 'high');
  if (['on', 'true', '1'].includes(raw)) return true;
  return false;
})();
const EXECUTE_MODEL_RETRIES = (() => {
  const n = Number(process.env.LOCALCLAW_EXECUTE_MODEL_RETRIES || 1);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, Math.floor(n)));
})();

console.log(`[reactor] Tuning: native_tools=${NATIVE_TOOL_CALLS_ENABLED} ctx=${EXECUTE_NUM_CTX} predict=${EXECUTE_NUM_PREDICT} think=${EXECUTE_THINK} retries=${EXECUTE_MODEL_RETRIES}`);

// ─── Sandbox executor ─────────────────────────────────────────────────────────

export interface SandboxResult {
  stdout: string;
  returnValue: any;
  error: string | null;
  isDestructive: boolean;
}

/**
 * Runs model-emitted Node.js code inside a vm sandbox.
 * - Injects WORKSPACE constant pointing to the real workspace path.
 * - Blocks dangerous modules (child_process, net, http, etc.).
 * - Captures console.log output and return value.
 * - Hard timeout: 5000ms.
 */
export async function runNodeCallSandbox(
  code: string,
  workspacePath: string,
  timeoutMs = 5000
): Promise<SandboxResult> {
  const isDestructive = DESTRUCTIVE_NODE_RE.test(code);
  const output: string[] = [];

  // Build a safe require that blocks dangerous modules
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const realRequire = require;
  const safeRequire = (mod: string): any => {
    if (BLOCKED_MODULES.has(mod)) {
      throw new Error(`Module '${mod}' is blocked in the LocalClaw sandbox.`);
    }
    return realRequire(mod);
  };

  const sandbox: Record<string, any> = {
    WORKSPACE: workspacePath,
    require: safeRequire,
    console: {
      log: (...args: any[]) => output.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
      error: (...args: any[]) => output.push('[err] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
      warn: (...args: any[]) => output.push('[warn] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
    },
    JSON,
    Math,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    Promise,
    setTimeout: undefined, // blocked
    setInterval: undefined, // blocked
    process: {
      env: { NODE_ENV: process.env.NODE_ENV || 'production' },
      platform: process.platform,
      cwd: () => workspacePath,
      kill: () => { throw new Error('process.kill is blocked in sandbox'); },
      exit: () => { throw new Error('process.exit is blocked in sandbox'); },
    },
  };

  
  // ── Injected helper functions for simpler model code ──
  // Instead of model writing 10 lines of fs/path code,
  // it can write: return readFile('index.html') or writeFile('index.html', newContent)
  sandbox.readFile = (name: string) => {
    const realFs = realRequire('fs');
    const realPath = realRequire('path');
    return realFs.readFileSync(realPath.join(workspacePath, name), 'utf-8');
  };
  sandbox.writeFile = (name: string, content: string) => {
    const realFs = realRequire('fs');
    const realPath = realRequire('path');
    realFs.writeFileSync(realPath.join(workspacePath, name), content, 'utf-8');
    return `${name} updated`;
  };
  sandbox.listFiles = () => {
    const realFs = realRequire('fs');
    return realFs.readdirSync(workspacePath);
  };
  sandbox.fileExists = (name: string) => {
    const realFs = realRequire('fs');
    const realPath = realRequire('path');
    return realFs.existsSync(realPath.join(workspacePath, name));
  };
  sandbox.deleteFile = (name: string) => {
    const realFs = realRequire('fs');
    const realPath = realRequire('path');
    realFs.unlinkSync(realPath.join(workspacePath, name));
    return `${name} deleted`;
  };
  sandbox.report = (msg: string) => {
    output.push(`[step] ${msg}`);
  };

  vm.createContext(sandbox);

  // Normalize code: strip a trailing bare `}` that the model sometimes emits
  // when it closes its own imagined function wrapper — it conflicts with our sandbox wrapper.
  let normalizedCode = code.trim();
  // If the last non-whitespace char is `}` and removing it produces balanced braces, strip it
  if (normalizedCode.endsWith('}')) {
    const withoutTrailing = normalizedCode.slice(0, -1).trimEnd();
    const openCount = (withoutTrailing.match(/\{/g) || []).length;
    const closeCount = (withoutTrailing.match(/\}/g) || []).length;
    if (openCount === closeCount) {
      normalizedCode = withoutTrailing;
    }
  }

  // Wrap code so bare `return X` works at top level
  const wrappedCode = `(function __sandboxMain__() { ${normalizedCode} })()`;
  let script: vm.Script;
  try {
    script = new vm.Script(wrappedCode, { filename: 'node_call' });
  } catch (parseErr: any) {
    // Syntax error in model-generated code — return as error so model can self-repair
    return {
      stdout: '',
      returnValue: null,
      error: `SyntaxError in node_call code: ${String(parseErr?.message || parseErr)}. Fix the syntax and try again.`,
      isDestructive,
    };
  }

  try {
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sandbox timeout (5000ms)')), timeoutMs);
      try {
        const ret = script.runInContext(sandbox, { timeout: timeoutMs });
        clearTimeout(timer);
        if (ret && typeof ret === 'object' && typeof ret.then === 'function') {
          ret.then(
            (v: any) => { clearTimeout(timer); resolve(v); },
            (e: any) => { clearTimeout(timer); reject(e); }
          );
        } else {
          resolve(ret);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });

    let returnValue = result;
    if (returnValue !== undefined && returnValue !== null && typeof returnValue === 'object') {
      try { returnValue = JSON.stringify(returnValue); } catch { returnValue = String(returnValue); }
    }

    return {
      stdout: output.join('\n'),
      returnValue: returnValue !== undefined ? returnValue : null,
      error: null,
      isDestructive,
    };
  } catch (err: any) {
    return {
      stdout: output.join('\n'),
      returnValue: null,
      error: String(err?.message || err || 'Unknown sandbox error'),
      isDestructive,
    };
  }
}

export function isDestructiveNodeCall(code: string): boolean {
  return DESTRUCTIVE_NODE_RE.test(code);
}

export function formatSandboxResult(result: SandboxResult): string {
  if (result.error) return `ERROR: ${result.error}`;
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.returnValue !== null && result.returnValue !== undefined) {
    const rv = String(result.returnValue);
    if (!result.stdout.includes(rv.slice(0, 40))) parts.push(rv);
  }
  return parts.join('\n').trim() || '(no output)';
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildNodeCallSystemPrompt(
  workspacePath: string,
  options: ReactOptions,
  userMessage: string,
  toolProfile: ToolProfile,
  toolSchemas: string
): string {
  const today = new Date().toISOString().slice(0, 10);
  const selectedSkillSlugs = Array.isArray(options.skillSlugs) && options.skillSlugs.length
    ? options.skillSlugs
    : selectSkillSlugsForMessage(userMessage, 2);
  const soul = buildSystemPrompt({
    includeSkillSlugs: selectedSkillSlugs,
    includeMemory: false,
    extraInstructions: options.extraInstructions,
  });
  const toolProfileBlock = toolSchemas.trim()
    ? `TOOL PROFILE: ${toolProfile}\nAVAILABLE TOOLS:\n${toolSchemas}\n`
    : '';

  const executeInstructions = `
You are in EXECUTE mode. Today is ${today}.
Workspace: ${workspacePath}
${toolProfileBlock}

━━━ HOW TO ACT ━━━

To perform ANY file or system operation, write a node_call block:

  node_call<...actual JavaScript code...>

The backend extracts the code, runs it in a sandboxed Node.js environment, and returns the result to you.
WRITE REAL CODE INSIDE node_call<>. Never write placeholder text like "YOUR CODE HERE".
You then write a FINAL: response summarizing what happened.

WORKSPACE constant is pre-injected — use it as the base path:
  node_call<const fs = require('fs'); return fs.readdirSync(WORKSPACE);>

For destructive operations (delete, overwrite, rename, move), add // DESTRUCTIVE to the code.
If the user already said to do it ("remove them", "go ahead", "delete it"), just execute.
Only include open_confirm in your FINAL if the user's intent is genuinely unclear.

━━━ FINISH ━━━

After all node_call blocks complete, always write:
  FINAL: <short plain-English summary of what was done>

If you need to ask the user a question instead of acting:
  FINAL: <your question here>
  open_confirm

━━━ REFERENCE PATTERNS ━━━

List all files in workspace:
  node_call<const fs = require('fs'); return fs.readdirSync(WORKSPACE);>

Read a file:
  node_call<const fs = require('fs'), path = require('path'); return fs.readFileSync(path.join(WORKSPACE, 'index.html'), 'utf8');>

Write/overwrite a file:
  node_call<const fs = require('fs'), path = require('path'); fs.writeFileSync(path.join(WORKSPACE, 'out.txt'), 'content here');>

Delete one file:
  node_call<const fs = require('fs'), path = require('path'); fs.unlinkSync(path.join(WORKSPACE, 'old.txt')); // DESTRUCTIVE>

Delete files matching a prefix:
  node_call<
  const fs = require('fs'), path = require('path');
  const matches = fs.readdirSync(WORKSPACE).filter(f => f.startsWith('golden'));
  matches.forEach(f => fs.unlinkSync(path.join(WORKSPACE, f)));
  // DESTRUCTIVE
  >

Edit text in a file (find + replace):
  node_call<
  const fs = require('fs'), path = require('path');
  const p = path.join(WORKSPACE, 'index.html');
  const updated = fs.readFileSync(p, 'utf8').replace('old text', 'new text');
  fs.writeFileSync(p, updated);
  >

Rename a file:
  node_call<const fs = require('fs'), path = require('path'); fs.renameSync(path.join(WORKSPACE, 'old.txt'), path.join(WORKSPACE, 'new.txt')); // DESTRUCTIVE>

List files matching a pattern:
  node_call<const fs = require('fs'); return fs.readdirSync(WORKSPACE).filter(f => f.startsWith('golden'));>

Web search (built-in):
  node_call<return web_search({query: 'your search here', max_results: 5});>

━━━ RULES ━━━
- Never assume filenames or paths. If unknown, list workspace first.
- Never claim task is done without a tool result confirming it.
- For destructive ops: if the user clearly said to do it ("remove them", "delete it", "go ahead"), just do it with // DESTRUCTIVE. Only use open_confirm if intent is ambiguous.
- Do not narrate or explain before node_call blocks. Act directly.
- Write node_call blocks IMMEDIATELY. Do not write prose, thinking, or explanation before or between them.
- You may use multiple node_call blocks in one response if needed.
- For multi-line code, write it all in one node_call block. Keep code compact (no extra variables).
`.trim();

  return [soul, executeInstructions].filter(Boolean).join('\n\n---\n\n');
}

function buildNativeToolSystemPrompt(
  toolSchemas: string,
  options: ReactOptions,
  userMessage: string
): string {
  const today = new Date().toISOString().slice(0, 10);
  const soul = buildSystemPrompt({
    includeSkillSlugs: Array.isArray(options.skillSlugs) ? options.skillSlugs : [],
    includeMemory: false,
    extraInstructions: String(options.extraInstructions || '').trim() || undefined,
  });
  const toolInstructions = `
You are in EXECUTE mode. Your job is to call tools and complete the user request.
Today is ${today}.
Call tools using native function calls. Do not describe what you're doing — just call the tool.
AVAILABLE TOOLS:\n${toolSchemas}
RULES:
1. Unknown target? Call list or stat first, then act.
2. Bulk/pattern ops: call list first, then act only on matched items.
3. Destructive ops without confirmed intent: include open_confirm in your response before mutating.
4. Never claim done without a successful tool result.
`.trim();
  return [soul, toolInstructions].filter(Boolean).join('\n\n---\n\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractThinking(raw: string): [string, string] {
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
  const thinking = thinkMatch ? thinkMatch[1].trim() : '';
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    // Also strip orphaned </think> (model writes closing tag without opening tag when think=false)
    .replace(/<\/think>/gi, '')
    .trim();
  return [thinking, cleaned];
}

function mergeThinking(nativeThinking: string, tagThinking: string): string {
  const a = (nativeThinking || '').trim();
  const b = (tagThinking || '').trim();
  if (a && b) {
    if (a === b) return a;
    if (a.includes(b)) return a;
    if (b.includes(a)) return b;
    return `${a}\n\n${b}`;
  }
  return a || b;
}

function extractPrimaryUserMessage(input: string): string {
  const raw = String(input || '').trim();
  const m = raw.match(/User request:\s*([^\n]+)/i);
  if (m?.[1]) return m[1].trim();
  return raw;
}

function inferToolProfile(userMessage: string, requestedProfile?: ToolProfile): ToolProfile {
  if (requestedProfile) return requestedProfile;
  const text = String(userMessage || '');
  if (SKILL_HINT_RE.test(text)) return 'full';
  if (URL_LIKE_RE.test(text) || WEB_HINT_RE.test(text)) return 'web';
  if (CODING_HINT_RE.test(text)) return 'coding';
  return 'minimal';
}

function parseNativeToolArgs(rawArgs: any): any {
  if (rawArgs == null) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  const text = String(rawArgs || '').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    try { return JSON.parse(text.replace(/'/g, '"').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')); } catch { return {}; }
  }
}

function mapToolAlias(actionName: string): string {
  const a = String(actionName || '').trim().toLowerCase();
  if (a === 'update_memory' || a === 'set_memory' || a === 'memory_update') return 'memory_write';
  return actionName;
}

function looksLikeInternalReasoning(text: string): boolean {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (/^(thought:|action:|param:|tool_hint:)/i.test(t)) return true;
  if (/^(okay|alright|hmm|wait)[,!\s]/.test(t)) return true;
  if (/\bthe user wants\b/.test(t)) return true;
  if (/\blet me (think|check|figure|tackle|analyze)\b/.test(t)) return true;
  if (/\btools provided\b/.test(t)) return true;
  return false;
}

function hashText(input: string): string {
  const text = String(input || '');
  let hash = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

// ─── Reactor class ────────────────────────────────────────────────────────────

export class Reactor {
  private ollama: OllamaClient;
  private registry = getToolRegistry();
  private maxSteps: number;

  constructor(ollama: OllamaClient, maxSteps = 8) {
    this.ollama = ollama;
    this.maxSteps = maxSteps;
  }

  async run(userMessage: string, options: ReactOptions = {}): Promise<string> {
    const maxSteps = options.maxSteps ?? this.maxSteps;
    const role: AgentRole = options.role ?? 'executor';
    const temperature = options.temperature ?? 0.25;
    const label = options.label ? `[${options.label}]` : '[reactor]';
    const formatViolationFuse = Math.max(1, Number(options.formatViolationFuse || 3));

    // Resolve workspace path — try config, fall back to cwd
    let workspacePath: string;
    try {
      // Dynamic import to avoid circular dep issues at module load time
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getConfig } = require('../config/config.js');
      workspacePath = String(getConfig().getConfig()?.workspace?.path || process.cwd());
    } catch {
      workspacePath = process.cwd();
    }

    const primaryUserMessage = extractPrimaryUserMessage(userMessage);
    const inferredToolProfile = inferToolProfile(primaryUserMessage, options.toolProfile);
    const toolProfile = this.registry.resolveToolProfile(inferredToolProfile);
    const toolSchemas = this.registry.getToolSchemas(toolProfile);
    const systemPrompt = buildNodeCallSystemPrompt(workspacePath, options, primaryUserMessage, toolProfile, toolSchemas);
    const nativeSystemPrompt = buildNativeToolSystemPrompt(toolSchemas, options, primaryUserMessage);

    console.log(`\n${label} USER   ${primaryUserMessage.slice(0, 120)}`);
    console.log(`${label} TOOLS  profile=${toolProfile}`);

    const startTime = Date.now();
    const historyLines: string[] = [];
    historyLines.push(`User: ${userMessage}`);

    // ── server-provided tool call (policy lock shortcut, unchanged) ──────────
    if (options.serverToolCall?.tool) {
      const mapped = mapToolAlias(options.serverToolCall.tool);
      if (this.registry.get(mapped)) {
        console.log(`${label} -> SERVER_TOOL  ${mapped}`);
        options.onStep?.({
          thought: options.serverToolCall.reason || 'Server-provided tool decision.',
          action: mapped,
          params: options.serverToolCall.params || {},
          stepNum: 1,
        });
        const toolResult = await this.registry.execute(mapped, options.serverToolCall.params || {});
        const resultText = toolResult.success
          ? (toolResult.stdout || JSON.stringify(toolResult.data || {}))
          : `ERROR: ${toolResult.error}`;
        options.onStep?.({
          thought: options.serverToolCall.reason || 'Server-provided tool decision.',
          action: mapped,
          params: options.serverToolCall.params || {},
          stepNum: 1,
          toolResult: resultText,
          toolData: toolResult.data,
        });
        return resultText;
      }
    }

    // ── Try native Ollama function-call path first (secondary channel) ───────
    // If the model emits proper tool_calls[] objects, great — use them.
    // If not, fall through to the node_call<> primary channel.
    if (NATIVE_TOOL_CALLS_ENABLED) {
      try {
        const allNativeTools = this.registry.getToolDefinitionsForChat(toolProfile);
        const nativeMessages: any[] = [
          { role: 'system', content: nativeSystemPrompt },
          { role: 'user', content: userMessage },
        ];

        let nativeSteps = 0;
        let nativeProducedToolCall = false;
        let nativeLastToolResult = '';
        let nativeToolExecutions = 0;
        let nativeRescueAttempted = false;

        while (nativeSteps < Math.min(maxSteps, 4)) {
          nativeSteps++;
          const chatOut = await this.ollama.chatWithThinking(nativeMessages, role, {
            temperature,
            num_ctx: EXECUTE_NUM_CTX,
            num_predict: EXECUTE_NUM_PREDICT,
            think: EXECUTE_THINK,
            tools: allNativeTools,
          });
          const msg: any = chatOut?.message || {};
          const thinking = String(chatOut?.thinking || '').trim();
          if (thinking) {
            const preview = thinking.replace(/\n+/g, ' ').slice(0, 200);
            console.log(`${label} THINK  ${preview}${thinking.length > 200 ? '...' : ''}`);
          }

          const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
          const assistantContent = String(msg?.content || '').trim();

          if (!toolCalls.length) {
            if (!nativeRescueAttempted) {
              nativeRescueAttempted = true;
              nativeMessages.push({
                role: 'user',
                content: 'Call a tool now using the tool definitions. Do not write prose. Make exactly one tool call, or respond FINAL: <answer> if no tool needed.',
              });
              continue;
            }
            // Second attempt also produced no tool call — fall through to node_call path
            console.log(`${label} INFO   Native path produced no tool_calls; switching to node_call channel.`);
            break;
          }

          nativeProducedToolCall = true;
          nativeMessages.push({ role: 'assistant', content: assistantContent || '', tool_calls: toolCalls });

          for (const tc of toolCalls) {
            const rawName = String(tc?.function?.name || tc?.name || '').trim();
            const mappedName = mapToolAlias(rawName);
            const callId = String(tc?.id || `${nativeSteps}_${mappedName}_${Date.now()}`);
            const params = parseNativeToolArgs(tc?.function?.arguments ?? tc?.arguments ?? {});

            options.onStep?.({
              thought: `Native tool-call: ${mappedName}`,
              thinking,
              action: mappedName,
              params,
              stepNum: nativeSteps,
            });

            if (!mappedName || !this.registry.get(mappedName)) {
              const errText = `ERROR: Tool not found: ${mappedName || rawName}`;
              nativeMessages.push({ role: 'tool', tool_call_id: callId, name: mappedName || rawName || 'unknown', content: errText });
              options.onStep?.({ thought: `Native tool-call: ${mappedName}`, action: mappedName || rawName || 'unknown', params, stepNum: nativeSteps, toolResult: errText, isFormatViolation: true });
              continue;
            }

            const toolResult = await this.registry.execute(mappedName, params);
            const fullResultText = toolResult.success
              ? (toolResult.stdout || JSON.stringify(toolResult.data || {}))
              : `ERROR: ${toolResult.error}`;
            nativeToolExecutions++;
            nativeLastToolResult = fullResultText;

            options.onStep?.({ thought: `Native tool-call: ${mappedName}`, action: mappedName, params, stepNum: nativeSteps, toolResult: fullResultText, toolData: toolResult.data });
            nativeMessages.push({ role: 'tool', tool_call_id: callId, name: mappedName, content: fullResultText });
          }
        }

        // If native path executed at least one tool successfully, return last result
        if (nativeProducedToolCall && nativeToolExecutions > 0 && nativeLastToolResult) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`${label} FINAL  [native] ${nativeLastToolResult.slice(0, 200)}`);
          console.log(`${label} Done in ${elapsed}s [native]\n`);
          options.onStep?.({ finalAnswer: nativeLastToolResult, stepNum: nativeSteps });
          return nativeLastToolResult;
        }
      } catch (err: any) {
        console.warn(`${label} WARN   Native tool-calling error; switching to node_call channel: ${String(err?.message || err)}`);
      }
    }

    // ── Primary channel: node_call<> loop ─────────────────────────────────────
    let stepCount = 0;
    let lastAnswer = '';
    let formatViolations = 0;
    let nextStepIsFinalOnly = false; // set after successful tool results — tighten budget
    let nextStepDisableThink = false; // set after format violation — stop model from debugging
    let lastSuccessfulResult = ''; // for repeat-result circuit breaker
    let lastCleanResult = ''; // clean tool output (no "node_call[N] result:" prefix) for FINAL fallback
    const genericRepeatWindow: Array<{ action: string; resultHash: string }> = [];
    const nodeCallHistory: string[] = [...historyLines];

    while (stepCount < maxSteps) {
      stepCount++;
      console.log(`${label} STEP ${stepCount} [node_call]`);

      // After successful tool results, the model only needs to write FINAL: <summary>.
      // Use a tight budget and a strong prefix to avoid re-running tools.
      const isFinalStep = nextStepIsFinalOnly;
      const disableThink = nextStepDisableThink;
      const stepPredict = isFinalStep ? Math.min(EXECUTE_NUM_PREDICT, 192) : EXECUTE_NUM_PREDICT;
      const stepThink = (isFinalStep || disableThink) ? false : EXECUTE_THINK;
      nextStepIsFinalOnly = false; // reset for this step
      nextStepDisableThink = false; // reset for this step

      const fullPrompt = isFinalStep
        ? nodeCallHistory.join('\n') + '\nAssistant: FINAL:'
        : nodeCallHistory.join('\n') + '\nAssistant:';

      let raw: string;
      let nativeThinking = '';
      try {
        const modelOut = await this.ollama.generateWithRetryThinking(fullPrompt, role, {
          temperature,
          system: systemPrompt,
          num_ctx: EXECUTE_NUM_CTX,
          num_predict: stepPredict,
          think: stepThink,
        }, EXECUTE_MODEL_RETRIES);
        raw = modelOut.response;
        nativeThinking = modelOut.thinking || '';
      } catch (err: any) {
        console.error(`${label} ERROR: ${err.message}`);
        lastAnswer = `Error communicating with model: ${err.message}`;
        break;
      }

      const [tagThinking, cleaned] = extractThinking(raw);
      const thinking = mergeThinking(nativeThinking, tagThinking);
      if (thinking) {
        const preview = thinking.replace(/\n+/g, ' ').slice(0, 200);
        console.log(`${label} THINK  ${preview}${thinking.length > 200 ? '...' : ''}`);
      }

      // ── Scan for node_call<> blocks ──────────────────────────────────────
      // Deduplicate: small models often emit the same node_call 2-3x with minor variations
      // (trailing semicolons, extra variables, whitespace). Normalize before comparing.
      const rawNodeCalls = extractNodeCallBlocks(cleaned).map(s => s.trim()).filter(Boolean);
      const normalizeForDedup = (code: string) => code.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
      const seen = new Set<string>();
      const nodeCallMatches = rawNodeCalls.filter(code => {
        const key = normalizeForDedup(code);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (nodeCallMatches.length > 0) {
        formatViolations = 0;
        const allResults: string[] = [];
        const cleanResults: string[] = []; // raw tool output without "node_call[N] result:" prefix
        const successfulPairsThisStep: Array<{ action: string; resultHash: string }> = [];

        for (let i = 0; i < nodeCallMatches.length; i++) {
          const code = nodeCallMatches[i];
          const isDestructive = isDestructiveNodeCall(code);

          console.log(`${label} NODE_CALL[${i + 1}/${nodeCallMatches.length}] destructive=${isDestructive} code=${code.replace(/\n/g, ' ').slice(0, 120)}`);

          // Emit step so UI shows it
          options.onStep?.({
            thought: `node_call block ${i + 1}`,
            thinking: i === 0 ? thinking : '',
            action: 'node_call',
            params: { code: code.slice(0, 300), isDestructive },
            stepNum: stepCount,
          });

          // Destructive: check for open_confirm signal in model output
          if (isDestructive) {
            const hasOpenConfirm = /\bopen[_\s-]?confirm\b/i.test(cleaned);
            if (hasOpenConfirm) {
              const finalMatch = FINAL_RE.exec(cleaned);
              const question = finalMatch
                ? finalMatch[1].replace(/\bopen[_\s-]?confirm\b/gi, '').trim()
                : 'This is a destructive operation. Do you want to continue?';
              const confirmReply = `${question}\nopen_confirm`;
              options.onStep?.({ finalAnswer: confirmReply, stepNum: stepCount });
              return confirmReply;
            }
          }

          // Run sandbox
          const sandboxResult = await runNodeCallSandbox(code, workspacePath);
          const resultText = formatSandboxResult(sandboxResult);

          console.log(sandboxResult.error
            ? `${label} FAIL   ${resultText.slice(0, 200)}`
            : `${label} OK     ${resultText.slice(0, 200)}`);

          options.onStep?.({
            thought: `node_call block ${i + 1}`,
            action: 'node_call',
            params: { code: code.slice(0, 300), isDestructive },
            stepNum: stepCount,
            toolResult: resultText,
            toolData: { sandboxResult },
          });

          // If sandbox had a syntax/runtime error, inject a targeted self-repair reprompt
          // so the model knows exactly what broke and can fix it on the next step.
          if (sandboxResult.error) {
            allResults.push(`node_call[${i + 1}] FAILED:\n${resultText}`);
          } else {
            allResults.push(`node_call[${i + 1}] result:\n${resultText}`);
            cleanResults.push(resultText);
            successfulPairsThisStep.push({
              action: `node_call:${hashText(normalizeForDedup(code))}`,
              resultHash: hashText(resultText),
            });
          }
        }

        // Feed all results back to model for FINAL summary (or self-repair if errors)
        const resultFeed = allResults.join('\n\n');
        const hasErrors = allResults.some(r => r.includes(' FAILED:'));
        nodeCallHistory.push(`Assistant:\n${cleaned}`);
        if (hasErrors) {
          nodeCallHistory.push(
            `Sandbox results:\n${resultFeed}\n\n` +
            `System: One or more node_call blocks failed. Fix the code and retry with a corrected node_call<> block, or write FINAL: if the task cannot be completed.`
          );
        } else {
          nodeCallHistory.push(`Sandbox results:\n${resultFeed}\n\nSystem: Write FINAL: <one-sentence summary of what was done or found> now.`);
        }
        if (nodeCallHistory.length > 20) nodeCallHistory.splice(1, nodeCallHistory.length - 20);
        lastAnswer = resultFeed;
        if (cleanResults.length > 0) lastCleanResult = cleanResults.join(', ');

        // Generic repeat detector for ping-pong/no-progress loops:
        // if the same (action, result_hash) pair appears >=3 times within the last 6,
        // stop early with a warning instead of burning all maxSteps.
        if (!hasErrors && successfulPairsThisStep.length > 0) {
          for (const pair of successfulPairsThisStep) {
            genericRepeatWindow.push(pair);
            if (genericRepeatWindow.length > GENERIC_REPEAT_WINDOW) genericRepeatWindow.shift();
          }
          const pairCounts = new Map<string, number>();
          let detectedRepeat = false;
          for (const pair of genericRepeatWindow) {
            const key = `${pair.action}|${pair.resultHash}`;
            const count = (pairCounts.get(key) || 0) + 1;
            pairCounts.set(key, count);
            if (count >= GENERIC_REPEAT_THRESHOLD) {
              detectedRepeat = true;
              break;
            }
          }
          if (detectedRepeat) {
            const warning = 'Warning: No-progress loop detected (repeated action/result pair). Stopping execution.';
            const finalText = `${warning}${lastCleanResult ? ` Last result: ${lastCleanResult.slice(0, 300)}` : ''}`;
            console.warn(`${label} WARN   Generic repeat detected (${GENERIC_REPEAT_THRESHOLD}+ in last ${GENERIC_REPEAT_WINDOW}); stopping.`);
            lastAnswer = finalText;
            options.onStep?.({ finalAnswer: finalText, stepNum: stepCount });
            break;
          }
        }

        // Repeat-result circuit breaker: if the model produced the same successful result
        // as the previous step, it's stuck in a loop. Force FINAL with the clean result.
        if (!hasErrors && resultFeed === lastSuccessfulResult) {
          console.log(`${label} INFO   Repeat-result detected — forcing FINAL with clean result.`);
          const finalText = lastCleanResult || lastAnswer;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`${label} FINAL  [auto] ${finalText.slice(0, 200)}`);
          console.log(`${label} Done in ${elapsed}s - ${stepCount} step(s)\n`);
          options.onStep?.({ finalAnswer: finalText, thinking: '', stepNum: stepCount });
          break;
        }
        if (!hasErrors) {
          lastSuccessfulResult = resultFeed;
          nextStepIsFinalOnly = true;
        }
        continue;
      }

      // ── Scan for FINAL: ──────────────────────────────────────────────────
      // When isFinalStep was true, the prompt was pre-filled with "FINAL:" so the
      // model's response IS the FINAL content (it won't repeat "FINAL:" itself).
      const finalMatch = FINAL_RE.exec(cleaned);
      let prefillFinalContent: string | null = null;
      if (isFinalStep && !finalMatch) {
        const candidate = cleaned.replace(/^\s*FINAL:\s*/i, '').trim();
        // Guard: if the model wrote deliberation, thinking, or raw feed text instead
        // of a clean answer, use the clean tool result as the FINAL answer.
        const looksLikeBadOutput = candidate.length > 200
          || /^(okay|let me|first|wait|hmm|I need to|the user|node_call\[)/i.test(candidate);
        const fallback = lastCleanResult || lastAnswer;
        prefillFinalContent = looksLikeBadOutput ? fallback : (candidate || fallback);
      }
      if (finalMatch || prefillFinalContent) {
        lastAnswer = (finalMatch ? finalMatch[1].trim() : prefillFinalContent) || lastAnswer;
        formatViolations = 0;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`${label} FINAL  ${lastAnswer.slice(0, 200)}${lastAnswer.length > 200 ? '...' : ''}`);
        console.log(`${label} Done in ${elapsed}s - ${stepCount} step(s)\n`);
        options.onStep?.({ finalAnswer: lastAnswer, thinking, stepNum: stepCount });
        break;
      }

      // ── Neither node_call nor FINAL detected: format violation ───────────
      formatViolations++;
      console.warn(`${label} WARN   Format violation #${formatViolations} - no node_call or FINAL found`);
      console.warn(`${label} RAW    ${cleaned.replace(/\s+/g, ' ').slice(0, 220)}`);
      options.onStep?.({ isFormatViolation: true, stepNum: stepCount, thinking });

      if (formatViolations >= formatViolationFuse) {
        const blocked = 'BLOCKED: No node_call or FINAL emitted after retries. The model did not produce a valid execute response.';
        console.warn(`${label} WARN   Format-violation fuse triggered (${formatViolations}/${formatViolationFuse}).`);
        options.onStep?.({ isFormatViolation: true, stepNum: stepCount, thought: 'Format-violation fuse triggered.', finalAnswer: blocked });
        return blocked;
      }

      // Reprompt and retry — disable thinking on retries to prevent the model from
      // burning the entire budget debugging the error instead of writing code.
      nodeCallHistory.push(`System: ${NODE_CALL_REPROMPT}`);
      nextStepIsFinalOnly = false; // not a FINAL step, but we'll override think below
      nextStepDisableThink = true; // force think=false on the retry
      stepCount--; // don't count the violation as a real step
    }

    if (stepCount >= maxSteps && !lastAnswer) {
      lastAnswer = 'Max steps reached without a final answer.';
      console.warn(`${label} WARN   Max steps (${maxSteps}) reached.`);
    }

    return lastAnswer;
  }
}

let reactorInstance: Reactor | null = null;

export function getReactor(ollama: OllamaClient): Reactor {
  if (!reactorInstance) {
    reactorInstance = new Reactor(ollama);
  }
  return reactorInstance;
}
