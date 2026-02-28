import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentDefinition, SmallClawConfig } from '../types.js';
import { getVault, scrubSecrets } from '../security/vault.js';

function migrateLegacyDir(legacyDir: string, targetDir: string): void {
  try {
    if (!fs.existsSync(legacyDir)) return;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const marker = path.join(targetDir, '.migrated-from-localclaw');
    if (fs.existsSync(marker)) return;

    // One-time migration: preserve existing users by carrying over all legacy data,
    // including config, credentials, skills, logs, and state files.
    fs.cpSync(legacyDir, targetDir, { recursive: true, force: true });
    fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
    console.log(`[Config] Migrated legacy data: ${legacyDir} -> ${targetDir}`);
  } catch (err: any) {
    console.warn(`[Config] Legacy migration failed (${legacyDir} -> ${targetDir}): ${String(err?.message || err)}`);
  }
}

function migrateLegacyData(): void {
  const projectLegacy = path.join(__dirname, '..', '..', '.localclaw');
  const projectTarget = path.join(__dirname, '..', '..', '.smallclaw');
  const homeLegacy = path.join(os.homedir(), '.localclaw');
  const homeTarget = path.join(os.homedir(), '.smallclaw');

  if (process.env.SMALLCLAW_DATA_DIR) {
    const dataRoot = process.env.SMALLCLAW_DATA_DIR;
    migrateLegacyDir(path.join(dataRoot, '.localclaw'), path.join(dataRoot, '.smallclaw'));
    return;
  }

  // Prefer project-local migration when this repo has (or previously had)
  // project-scoped state; otherwise migrate home-scoped state.
  const hasProjectScopedState = fs.existsSync(projectLegacy) || fs.existsSync(projectTarget);
  if (hasProjectScopedState) {
    migrateLegacyDir(projectLegacy, projectTarget);
    return;
  }

  migrateLegacyDir(homeLegacy, homeTarget);
}

migrateLegacyData();

// ── Config & workspace directory resolution ──────────────────────────────────
// Priority:
//   1. SMALLCLAW_DATA_DIR env var   (set by Docker / CI)
//   2. .smallclaw/ next to the project root
//   3. ~/.smallclaw in the user's home directory
const PROJECT_CONFIG = path.join(__dirname, '..', '..', '.smallclaw');
const HOME_CONFIG    = path.join(os.homedir(), '.smallclaw');
const CONFIG_DIR =
  process.env.SMALLCLAW_DATA_DIR
    ? path.join(process.env.SMALLCLAW_DATA_DIR, '.smallclaw')
    : fs.existsSync(PROJECT_CONFIG)
      ? PROJECT_CONFIG
      : HOME_CONFIG;

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Workspace: env var → config-dir-relative default (cross-platform safe)
const WORKSPACE_DIR =
  process.env.SMALLCLAW_WORKSPACE_DIR ??
  path.join(CONFIG_DIR, '..', 'workspace');

export const DEFAULT_CONFIG: SmallClawConfig = {
  version: '1.0.1',
  gateway: {
    port: 18789,
    host: '127.0.0.1',
    auth: {
      enabled: true,
      token: undefined
    }
  },
  ollama: {
    endpoint: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    timeout: 120,
    concurrency: {
      llm_workers: 1,
      tool_workers: 3
    }
  },
  // ── Provider config – built from env vars so Docker works out of the box.
  // Any values in config.json will override these at load time.
  llm: {
    provider: (process.env.SMALLCLAW_PROVIDER as any) ?? 'ollama',
    providers: {
      ollama: {
        endpoint: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
        model:    'qwen3:4b',
      },
      lm_studio: {
        endpoint: process.env.LM_STUDIO_ENDPOINT ?? 'http://localhost:1234',
        model:    process.env.LM_STUDIO_MODEL    ?? '',
        api_key:  process.env.LM_STUDIO_API_KEY  ?? undefined,
      },
      llama_cpp: {
        endpoint: process.env.LLAMA_CPP_ENDPOINT ?? 'http://localhost:8080',
        model:    process.env.LLAMA_CPP_MODEL    ?? '',
      },
      openai: {
        // Supports inline value OR env: reference
        api_key: process.env.OPENAI_API_KEY ? `env:OPENAI_API_KEY` : '',
        model:   process.env.OPENAI_MODEL   ?? 'gpt-4o',
      },
      openai_codex: {
        model: process.env.CODEX_MODEL ?? 'gpt-5.3-codex',
      },
    },
  } as any,
  models: {
    primary: 'qwen3:4b',
    roles: {
      manager: 'qwen3:4b',
      executor: 'qwen3:4b',
      verifier: 'qwen3:4b'
    }
  },
  tools: {
    enabled: ['shell', 'read', 'write', 'edit', 'search'],
    permissions: {
      shell: {
        workspace_only: true,
        confirm_destructive: true,
        blocked_patterns: ['rm -rf /', 'del C:\\Windows', 'format']
      },
      files: {
        allowed_paths: [WORKSPACE_DIR],
        blocked_paths: ['/etc', '/System', 'C:\\Windows', '/usr', '/bin']
      },
      browser: {
        profile: 'automation',
        headless: false
      }
    }
  },
  skills: {
    directory: path.join(CONFIG_DIR, 'skills'),
    registries: ['https://clawhub.ai'],
    auto_update: false
  },
  memory: {
    provider: 'chromadb',
    path: path.join(CONFIG_DIR, 'memory'),
    embedding_model: 'nomic-embed-text'
  },
  memory_options: {
    auto_confirm: true,
    audit: true,
    truncate_length: 1000
  },
  heartbeat: {
    enabled: true,
    interval_minutes: 30,
    workspace_file: 'HEARTBEAT.md'
  },
  workspace: {
    path: WORKSPACE_DIR
  },
  agents: [] as AgentDefinition[],
  session: {
    maxMessages: 120,
    compactionThreshold: 0.7,
    memoryFlushThreshold: 0.75,
  },
  channels: {
    telegram: {
      enabled: false,
      botToken: '',
      allowedUserIds: [],
      streamMode: 'full',
    },
    discord: {
      enabled: false,
      botToken: '',
      applicationId: '',
      guildId: '',
      channelId: '',
      webhookUrl: '',
    },
    whatsapp: {
      enabled: false,
      accessToken: '',
      phoneNumberId: '',
      businessAccountId: '',
      verifyToken: '',
      webhookSecret: '',
      testRecipient: '',
    },
  },
  orchestration: {
    enabled: false,
    secondary: {
      provider: '',
      model: '',
    },
    triggers: {
      consecutive_failures: 2,
      stagnation_rounds: 3,
      loop_detection: true,
      risky_files_threshold: 6,
      risky_tool_ops_threshold: 220,
      no_progress_seconds: 90,
    },
    preflight: {
      mode: 'complex_only',
      allow_secondary_chat: false,
    },
    limits: {
      assist_cooldown_rounds: 3,
      max_assists_per_turn: 3,
      max_assists_per_session: 18,
      telemetry_history_limit: 100,
    },
    browser: {
      max_advisor_calls_per_turn: 5,
      max_collected_items: 80,
      max_forced_retries: 0,
      min_feed_items_before_answer: 12,
    },
    preempt: {
      enabled: false,
      stall_threshold_seconds: 45,
      max_preempts_per_turn: 1,
      max_preempts_per_session: 3,
      restart_mode: process.platform === 'win32' ? 'inherit_console' : 'detached_hidden',
    },
    file_ops: {
      enabled: true,
      primary_create_max_lines: 80,
      primary_create_max_chars: 3500,
      primary_edit_max_lines: 12,
      primary_edit_max_chars: 800,
      primary_edit_max_files: 1,
      verify_create_always: true,
      verify_large_payload_lines: 25,
      verify_large_payload_chars: 1200,
      watchdog_no_progress_cycles: 3,
      checkpointing_enabled: true,
    },
    // Sub-agent mode: false = conservative 4B specialist delegates (sequential)
    // true = full Claude Cowork-style free-form parallel spawn
    subagent_mode: false,
  },
  hooks: {
    enabled: false,
    token: '',
    path: '/hooks',
  },
};

function normalizeLegacyPathsInConfig(loaded: any): any {
  const out = { ...(loaded || {}) };

  const skillsDir = String(out?.skills?.directory || '');
  if (skillsDir && skillsDir.includes('.localclaw')) {
    out.skills = { ...(out.skills || {}), directory: path.join(CONFIG_DIR, 'skills') };
  }

  const memoryPath = String(out?.memory?.path || '');
  if (memoryPath && memoryPath.includes('.localclaw')) {
    out.memory = { ...(out.memory || {}), path: path.join(CONFIG_DIR, 'memory') };
  }

  return out;
}

// ─── Secret fields that must never live in config.json plaintext ─────────────
// Format: [ dotted.path.in.config, vault key name ]
// On saveConfig(), any of these found as plain strings are moved to the vault
// and replaced with a "vault:<key>" reference.
const SECRET_FIELD_MAP: Array<[string[], string]> = [
  [['gateway', 'auth', 'token'],                  'gateway.auth_token'],
  [['channels', 'telegram', 'botToken'],          'channels.telegram.botToken'],
  [['channels', 'discord', 'botToken'],           'channels.discord.botToken'],
  [['channels', 'whatsapp', 'accessToken'],       'channels.whatsapp.accessToken'],
  [['channels', 'whatsapp', 'webhookSecret'],     'channels.whatsapp.webhookSecret'],
  [['search', 'tavily_api_key'],                  'search.tavily_api_key'],
  [['search', 'google_api_key'],                  'search.google_api_key'],
  [['search', 'brave_api_key'],                   'search.brave_api_key'],
  [['llm', 'providers', 'openai', 'api_key'],     'llm.openai.api_key'],
  [['llm', 'providers', 'lm_studio', 'api_key'],  'llm.lm_studio.api_key'],
  [['hooks', 'token'],                             'hooks.token'],
];

function deepGet(obj: any, keys: string[]): string | undefined {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function deepSet(obj: any, keys: string[], value: string): void {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Scan the config object for plaintext secrets.
 * Any found are stored in the vault and replaced with a "vault:<key>" reference.
 * Returns a safe copy of the config suitable for writing to disk.
 */
function migrateSecretsToVault(config: any, configDir: string): any {
  const copy = JSON.parse(JSON.stringify(config)); // deep clone
  const vault = getVault(configDir);

  for (const [fieldPath, vaultKey] of SECRET_FIELD_MAP) {
    const value = deepGet(copy, fieldPath);
    if (!value) continue;
    // Skip if already a vault reference or env: reference
    if (value.startsWith('vault:') || value.startsWith('env:')) continue;
    // Skip masked placeholder from UI
    if (value === '••••••••') continue;
    // It's a real plaintext secret — move it to vault
    vault.set(vaultKey, value, 'config:migrate');
    deepSet(copy, fieldPath, `vault:${vaultKey}`);
  }

  return copy;
}

export class ConfigManager {
  private config: SmallClawConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): SmallClawConfig {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const loadedRaw = JSON.parse(data);
        const loaded = normalizeLegacyPathsInConfig(loadedRaw);

        // Deep-merge the llm.providers block so env-var defaults for
        // providers not present in config.json are preserved.
        const mergedLlm = loaded.llm
          ? {
              ...DEFAULT_CONFIG.llm,
              ...loaded.llm,
              providers: {
                ...(DEFAULT_CONFIG.llm as any)?.providers,
                ...loaded.llm.providers,
              },
            }
          : DEFAULT_CONFIG.llm;

        const mergedChannels = {
          ...(DEFAULT_CONFIG.channels || {}),
          ...(loaded.channels || {}),
          telegram: {
            ...((DEFAULT_CONFIG.channels as any)?.telegram || {}),
            ...((loaded.channels as any)?.telegram || {}),
            ...(loaded.telegram || {}),
          },
        };

        return {
          ...DEFAULT_CONFIG,
          ...loaded,
          llm: mergedLlm,
          channels: mergedChannels as any,
          telegram: (mergedChannels as any).telegram,
        };
      }
    } catch (error) {
      console.warn('Failed to load config, using defaults:', error);
    }
    return DEFAULT_CONFIG;
  }

  public getConfig(): SmallClawConfig {
    return this.config;
  }

  public updateConfig(updates: Partial<SmallClawConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  public saveConfig(): void {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      // Before writing, migrate any plaintext secrets to the vault
      // so they are never stored in config.json going forward.
      const sanitized = migrateSecretsToVault(this.config, CONFIG_DIR);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(sanitized, null, 2));
    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    }
  }

  /**
   * Resolve a config value that may be a vault reference.
   * Values stored as "vault:<key>" are decrypted on demand.
   * Plain strings are returned as-is.
   */
  public resolveSecret(value: string | undefined): string | undefined {
    if (!value) return value;
    if (value.startsWith('vault:')) {
      const vaultKey = value.slice(6);
      const secret = getVault(CONFIG_DIR).get(vaultKey, 'config:resolve');
      return secret ? secret.expose() : undefined;
    }
    return value;
  }

  public ensureDirectories(): void {
    const dirs = [
      CONFIG_DIR,
      this.config.workspace.path,
      this.config.skills.directory,
      this.config.memory.path,
      path.join(CONFIG_DIR, 'sessions'),
      path.join(CONFIG_DIR, 'logs')
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  public getConfigDir(): string {
    return CONFIG_DIR;
  }

  public getWorkspacePath(): string {
    return this.config.workspace.path;
  }

  public getDatabasePath(): string {
    return path.join(CONFIG_DIR, 'jobs.db');
  }
}

// Singleton instance
let configInstance: ConfigManager | null = null;

export function getConfig(): ConfigManager {
  if (!configInstance) {
    configInstance = new ConfigManager();
  }
  return configInstance;
}

/**
 * Returns the resolved workspace path for a given agent definition.
 * If the agent has an explicit workspace, use it.
 * Otherwise derive from configDir/agents/<id>/workspace.
 */
export function resolveAgentWorkspace(agent: AgentDefinition): string {
  if (agent.workspace) return agent.workspace;
  return path.join(CONFIG_DIR, 'agents', agent.id, 'workspace');
}

/**
 * Returns all configured agents. If none are defined, returns a synthetic
 * "main" agent using the global workspace path - backward-compatible.
 */
export function getAgents(): AgentDefinition[] {
  const cfg = getConfig().getConfig();
  const defined = Array.isArray(cfg.agents) ? cfg.agents : [];
  if (defined.length > 0) return defined;
  // Fallback: single main agent using legacy workspace
  return [{
    id: 'main',
    name: 'Main',
    description: 'Default assistant',
    default: true,
    workspace: cfg.workspace.path,
  }];
}

/**
 * Returns the default agent (the one that handles user chat).
 */
export function getDefaultAgent(): AgentDefinition {
  const agents = getAgents();
  return agents.find(a => a.default) ?? agents[0];
}

/**
 * Returns a specific agent by ID, or null if not found.
 */
export function getAgentById(id: string): AgentDefinition | null {
  return getAgents().find(a => a.id === id) ?? null;
}

/**
 * Ensures the workspace directory exists for an agent.
 * Also bootstraps missing AGENTS.md with a blank template if the
 * workspace is brand new.
 */
export function ensureAgentWorkspace(agent: AgentDefinition): string {
  const ws = resolveAgentWorkspace(agent);
  if (!fs.existsSync(ws)) {
    fs.mkdirSync(ws, { recursive: true });
    // Bootstrap blank AGENTS.md so the agent has instructions to follow
    const agentsMd = path.join(ws, 'AGENTS.md');
    if (!fs.existsSync(agentsMd)) {
      fs.writeFileSync(agentsMd, [
        `# AGENTS.md - ${agent.name}`,
        '',
        '## Role',
        agent.description ?? 'No description set. Update this file to define your role.',
        '',
        '## Instructions',
        '- Describe what this agent should do here.',
        '- Be specific about output format expected by the orchestrator.',
        '- List tools this agent is allowed to use.',
        '',
        '## Output Format',
        'Return a concise summary of what was accomplished.',
      ].join('\n'), 'utf-8');
    }

    const heartbeatMd = path.join(ws, 'HEARTBEAT.md');
    if (!fs.existsSync(heartbeatMd)) {
      fs.writeFileSync(heartbeatMd, [
        `# HEARTBEAT.md - ${agent.name}`,
        '',
        '## What to do when woken by the scheduler',
        '',
        'Edit this file to define autonomous tasks for this agent.',
        '',
        '## Example Tasks',
        '- Check for new trends in [topic] and write a brief to workspace/reports/',
        '- Post a draft to workspace/drafts/ for human review',
        '- Update MEMORY.md with anything new learned',
        '',
        '## Rules',
        '- Always write outputs to files, never just respond in chat',
        '- If nothing to do, write a short journal entry to memory/YYYY-MM-DD.md',
        '- Keep runs under 5 minutes',
      ].join('\n'), 'utf-8');
    }
  }
  return ws;
}
