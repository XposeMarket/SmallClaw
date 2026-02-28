/**
 * mcp-manager.ts — SmallClaw MCP Client
 *
 * Manages connections to external MCP (Model Context Protocol) servers.
 * Supports stdio child-process transport and HTTP/SSE transport.
 *
 * Config stored in ~/.smallclaw/mcp-servers.json
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { log } from '../security/log-scrubber';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MCPTransport = 'stdio' | 'sse';

export interface MCPServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: MCPTransport;
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse/http transport
  url?: string;
  headers?: Record<string, string>;
  // metadata
  description?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
  serverId: string;
  serverName: string;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

interface MCPSession {
  config: MCPServerConfig;
  process?: ChildProcess;
  tools: MCPTool[];
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  error?: string;
  requestId: number;
  pendingRequests: Map<number, PendingRequest>;
  buffer: string;
  initialized: boolean;
}

export interface MCPServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  tools: number;
  toolNames?: string[];
  error?: string;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class MCPManager {
  private configPath: string;
  private sessions = new Map<string, MCPSession>();
  private configs: MCPServerConfig[] = [];

  constructor(configDir: string) {
    this.configPath = path.join(configDir, 'mcp-servers.json');
    this.load();
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  load(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        this.configs = Array.isArray(raw) ? raw : [];
      }
    } catch (e: any) {
      console.warn('[MCP] Failed to load config:', e.message);
      this.configs = [];
    }
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.configs, null, 2), 'utf-8');
    } catch (e: any) {
      console.warn('[MCP] Failed to save config:', e.message);
    }
  }

  getConfigs(): MCPServerConfig[] { return this.configs; }

  // ── CRIT-02 fix: validate command before accepting MCP config ─────────────────
  // MCP stdio configs spawn real processes. Validate the command is in the
  // known-safe allowlist so a prompt-injected instruction cannot register
  // an arbitrary binary as an MCP server.
  static validateStdioCommand(command: string): { valid: boolean; reason?: string } {
    if (!command || typeof command !== 'string') {
      return { valid: false, reason: 'command must be a non-empty string' };
    }

    // Resolve just the base executable name (strip path prefix if present)
    const exe = path.basename(command).toLowerCase().replace(/\.exe$/i, '');

    const ALLOWED_EXECUTABLES = new Set([
      // Node / JS runtimes
      'node', 'nodejs', 'npx', 'tsx', 'ts-node',
      // Python runtimes
      'python', 'python3', 'python3.11', 'python3.12', 'uvx', 'uv',
      // Package runners
      'npx', 'pnpx', 'bunx', 'deno',
      // Common MCP server wrappers
      'mcp', 'mcp-server',
    ]);

    if (!ALLOWED_EXECUTABLES.has(exe)) {
      return {
        valid: false,
        reason: `Executable "${exe}" is not in the MCP allowed-command list. ` +
          `Allowed: ${[...ALLOWED_EXECUTABLES].join(', ')}`
      };
    }

    // Block shell metacharacters in command string itself
    if (/[;&|`$><]/.test(command)) {
      return { valid: false, reason: 'command contains shell metacharacters' };
    }

    return { valid: true };
  }

  // ── CRIT-02 / HIGH-04 fix: sanitize env vars ────────────────────────────
  // Prevent attackers from injecting PATH, NODE_OPTIONS, LD_PRELOAD, etc.
  static sanitizeEnv(env: Record<string, string>): Record<string, string> {
    // Explicitly blocked env vars that could hijack process execution
    const BLOCKED_ENV_KEYS = new Set([
      'PATH', 'NODE_OPTIONS', 'NODE_PATH',
      'LD_PRELOAD', 'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', // macOS
      'PYTHONPATH', 'PYTHONSTARTUP',
      'RUBYOPT', 'RUBYLIB',
      'PERL5OPT', 'PERL5LIB',
      'HOME', 'USERPROFILE',  // prevent redirecting home dir
      'TMPDIR', 'TEMP', 'TMP', // prevent temp dir hijacking
      'SHELL', 'COMSPEC',      // prevent shell override
    ]);

    const sanitized: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (BLOCKED_ENV_KEYS.has(k.toUpperCase()) || BLOCKED_ENV_KEYS.has(k)) {
        log.warn('[MCP] Blocked dangerous env var in server config:', k);
        continue;
      }
      sanitized[k] = String(v);
    }
    return sanitized;
  }

  upsertConfig(cfg: MCPServerConfig): void {
    // Validate stdio command before persisting
    if (cfg.transport === 'stdio' && cfg.command) {
      const validation = MCPManager.validateStdioCommand(cfg.command);
      if (!validation.valid) {
        throw new Error(`[MCP] Rejected config for "${cfg.id}": ${validation.reason}`);
      }
    }
    const idx = this.configs.findIndex(c => c.id === cfg.id);
    if (idx >= 0) this.configs[idx] = cfg;
    else this.configs.push(cfg);
    this.save();
    log.security('[MCP] Config saved for server:', cfg.id, 'transport:', cfg.transport);
  }

  deleteConfig(id: string): boolean {
    const idx = this.configs.findIndex(c => c.id === id);
    if (idx < 0) return false;
    this.configs.splice(idx, 1);
    this.save();
    this.disconnect(id);
    return true;
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  async connect(id: string): Promise<{ success: boolean; tools?: MCPTool[]; error?: string }> {
    const cfg = this.configs.find(c => c.id === id);
    if (!cfg) return { success: false, error: 'Server config not found' };
    if (!cfg.enabled) return { success: false, error: 'Server is disabled' };

    await this.disconnect(id);

    if (cfg.transport === 'stdio') return this.connectStdio(cfg);
    if (cfg.transport === 'sse') return this.connectSSE(cfg);
    return { success: false, error: `Unknown transport: ${cfg.transport}` };
  }

  private async connectStdio(cfg: MCPServerConfig): Promise<{ success: boolean; tools?: MCPTool[]; error?: string }> {
    if (!cfg.command) return { success: false, error: 'No command specified' };

    const session: MCPSession = {
      config: cfg,
      tools: [],
      status: 'connecting',
      requestId: 1,
      pendingRequests: new Map(),
      buffer: '',
      initialized: false,
    };
    this.sessions.set(cfg.id, session);

    return new Promise((resolve) => {
      try {
        // HIGH-04: sanitize env vars — block PATH, NODE_OPTIONS, LD_PRELOAD etc.
        const safeUserEnv = MCPManager.sanitizeEnv(cfg.env || {});
        const env = { ...process.env, ...safeUserEnv };

        // CRIT-02: shell: false always — args are passed as a list, not a shell string.
        // This prevents metacharacter injection via cfg.args on all platforms.
        const proc = spawn(cfg.command!, cfg.args || [], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,  // SECURITY: never true — prevents shell injection via args
        });

        session.process = proc;

        const timeout = setTimeout(() => {
          if (session.status === 'connecting') {
            session.status = 'error';
            session.error = 'Connection timeout (15s)';
            try { proc.kill(); } catch {}
            resolve({ success: false, error: session.error });
          }
        }, 15000);

        proc.stdout?.on('data', (chunk: Buffer) => {
          session.buffer += chunk.toString();
          this.processBuffer(session);
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
          const msg = chunk.toString().trim();
          if (msg) console.log(`[MCP:${cfg.id}] ${msg.slice(0, 200)}`);
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          session.status = 'error';
          session.error = err.message;
          console.error(`[MCP:${cfg.id}] Process error:`, err.message);
          resolve({ success: false, error: err.message });
        });

        proc.on('close', (code) => {
          console.log(`[MCP:${cfg.id}] Process closed (exit ${code})`);
          session.status = 'disconnected';
          for (const [, p] of session.pendingRequests) p.reject(new Error('MCP server disconnected'));
          session.pendingRequests.clear();
        });

        // Initialize handshake
        this.sendRequest(session, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: 'SmallClaw', version: '1.0.0' },
        }).then(async () => {
          clearTimeout(timeout);
          this.sendNotification(session, 'notifications/initialized', {});

          try {
            const toolsResult = await this.sendRequest(session, 'tools/list', {});
            const tools: MCPTool[] = (toolsResult?.tools || []).map((t: any) => ({
              name: t.name,
              description: t.description || '',
              inputSchema: t.inputSchema || { type: 'object', properties: {} },
              serverId: cfg.id,
              serverName: cfg.name,
            }));
            session.tools = tools;
            session.status = 'connected';
            session.initialized = true;
            console.log(`[MCP:${cfg.id}] Connected — ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
            resolve({ success: true, tools });
          } catch {
            session.status = 'connected';
            session.initialized = true;
            resolve({ success: true, tools: [] });
          }
        }).catch((e) => {
          clearTimeout(timeout);
          session.status = 'error';
          session.error = e.message;
          resolve({ success: false, error: e.message });
        });

      } catch (e: any) {
        session.status = 'error';
        session.error = e.message;
        resolve({ success: false, error: e.message });
      }
    });
  }

  private async connectSSE(cfg: MCPServerConfig): Promise<{ success: boolean; tools?: MCPTool[]; error?: string }> {
    if (!cfg.url) return { success: false, error: 'No URL specified for SSE transport' };

    const session: MCPSession = {
      config: cfg, tools: [], status: 'connecting',
      requestId: 1, pendingRequests: new Map(), buffer: '', initialized: false,
    };
    this.sessions.set(cfg.id, session);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(cfg.headers || {}),
      };
      const resp = await fetch(cfg.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        session.status = 'error';
        session.error = `HTTP ${resp.status} ${resp.statusText}`;
        return { success: false, error: session.error };
      }
      const data = await resp.json() as any;
      const tools: MCPTool[] = (data?.result?.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        serverId: cfg.id,
        serverName: cfg.name,
      }));
      session.tools = tools;
      session.status = 'connected';
      session.initialized = true;
      console.log(`[MCP:${cfg.id}] SSE connected — ${tools.length} tool(s)`);
      return { success: true, tools };
    } catch (e: any) {
      session.status = 'error';
      session.error = e.message;
      return { success: false, error: e.message };
    }
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = 'disconnected';
    if (session.process) { try { session.process.kill(); } catch {} }
    this.sessions.delete(id);
  }

  async disconnectAll(): Promise<void> {
    for (const id of this.sessions.keys()) await this.disconnect(id);
  }

  // ── Tool execution ─────────────────────────────────────────────────────────

  async callTool(serverId: string, toolName: string, args: Record<string, any>): Promise<MCPToolResult> {
    const session = this.sessions.get(serverId);
    if (!session) throw new Error(`MCP server "${serverId}" not connected`);
    if (session.status !== 'connected') throw new Error(`MCP server "${serverId}" is ${session.status}`);

    if (session.config.transport === 'sse') {
      const cfg = session.config;
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(cfg.headers || {}) };
      const resp = await fetch(cfg.url!, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: session.requestId++, method: 'tools/call', params: { name: toolName, arguments: args } }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await resp.json() as any;
      return {
        content: data?.result?.content || [{ type: 'text', text: JSON.stringify(data?.result) }],
        isError: data?.result?.isError === true,
      };
    }

    const result = await this.sendRequest(session, 'tools/call', { name: toolName, arguments: args });
    return {
      content: result?.content || [{ type: 'text', text: JSON.stringify(result) }],
      isError: result?.isError === true,
    };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): MCPServerStatus[] {
    return this.configs.map(cfg => {
      const session = this.sessions.get(cfg.id);
      return {
        id: cfg.id,
        name: cfg.name,
        enabled: cfg.enabled,
        status: session?.status || 'disconnected',
        tools: session?.tools.length || 0,
        toolNames: session?.tools.map(t => t.name) || [],
        error: session?.error,
      };
    });
  }

  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const session of this.sessions.values()) {
      if (session.status === 'connected') tools.push(...session.tools);
    }
    return tools;
  }

  async startEnabledServers(): Promise<void> {
    const enabled = this.configs.filter(c => c.enabled);
    if (enabled.length === 0) return;
    console.log(`[MCP] Auto-connecting ${enabled.length} enabled server(s)...`);
    await Promise.allSettled(enabled.map(c => this.connect(c.id)));
    const connected = this.getStatus().filter(s => s.status === 'connected');
    console.log(`[MCP] ${connected.length}/${enabled.length} server(s) connected`);
  }

  // ── JSON-RPC ───────────────────────────────────────────────────────────────

  private processBuffer(session: MCPSession): void {
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { this.handleMessage(session, JSON.parse(trimmed)); } catch {}
    }
  }

  private handleMessage(session: MCPSession, msg: any): void {
    if (msg.id !== undefined && session.pendingRequests.has(msg.id)) {
      const pending = session.pendingRequests.get(msg.id)!;
      session.pendingRequests.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    }
  }

  private sendRequest(session: MCPSession, method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = session.requestId++;
      const timeout = setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 15000);

      session.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      if (session.process?.stdin) {
        session.process.stdin.write(msg);
      } else {
        session.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(new Error('No stdin — process not running'));
      }
    });
  }

  private sendNotification(session: MCPSession, method: string, params: any): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    if (session.process?.stdin) session.process.stdin.write(msg);
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let _mcpManager: MCPManager | null = null;

export function getMCPManager(): MCPManager {
  if (!_mcpManager) {
    const { getConfig } = require('../config/config');
    const configDir = getConfig().getConfigDir();
    _mcpManager = new MCPManager(configDir);
  }
  return _mcpManager;
}
