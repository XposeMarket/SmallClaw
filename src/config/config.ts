import fs from 'fs';
import path from 'path';
import os from 'os';
import { LocalClawConfig } from '../types.js';

// ── Config & workspace directory resolution ──────────────────────────────────
// Priority:
//   1. SMALLCLAW_DATA_DIR env var   (set by Docker / CI)
//   2. .localclaw/ next to the project root
//   3. ~/.localclaw in the user's home directory
const PROJECT_CONFIG = path.join(__dirname, '..', '..', '.localclaw');
const HOME_CONFIG    = path.join(os.homedir(), '.localclaw');
const CONFIG_DIR =
  process.env.SMALLCLAW_DATA_DIR
    ? path.join(process.env.SMALLCLAW_DATA_DIR, '.localclaw')
    : fs.existsSync(PROJECT_CONFIG)
      ? PROJECT_CONFIG
      : HOME_CONFIG;

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Workspace: env var → config-dir-relative default (cross-platform safe)
const WORKSPACE_DIR =
  process.env.SMALLCLAW_WORKSPACE_DIR ??
  path.join(CONFIG_DIR, '..', 'workspace');

export const DEFAULT_CONFIG: LocalClawConfig = {
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
  session: {
    maxMessages: 120,
    compactionThreshold: 0.7,
    memoryFlushThreshold: 0.75,
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
      max_forced_retries: 2,
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
  }
};

export class ConfigManager {
  private config: LocalClawConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): LocalClawConfig {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const loaded = JSON.parse(data);

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

        return { ...DEFAULT_CONFIG, ...loaded, llm: mergedLlm };
      }
    } catch (error) {
      console.warn('Failed to load config, using defaults:', error);
    }
    return DEFAULT_CONFIG;
  }

  public getConfig(): LocalClawConfig {
    return this.config;
  }

  public updateConfig(updates: Partial<LocalClawConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  public saveConfig(): void {
    try {
      // Ensure config directory exists
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    }
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
