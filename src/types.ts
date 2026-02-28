// Core type definitions for SmallClaw

export type JobStatus = 'queued' | 'planning' | 'executing' | 'verifying' | 'completed' | 'failed' | 'needs_approval';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type AgentRole = 'manager' | 'executor' | 'verifier';
export type VerificationStatus = 'approved' | 'rejected' | 'needs_approval';

export interface Job {
  id: string;
  title: string;
  description?: string;
  status: JobStatus;
  priority: number;
  created_at: number;
  updated_at: number;
  completed_at?: number;
  metadata?: Record<string, any>;
}

export interface Task {
  id: string;
  job_id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assigned_to?: AgentRole;
  dependencies: string[]; // task IDs
  retry_count: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  acceptance_criteria: string[];
}

export interface Step {
  id: string;
  task_id: string;
  step_number: number;
  agent_role: AgentRole;
  tool_name?: string;
  tool_args?: Record<string, any>;
  result?: any;
  error?: string;
  created_at: number;
}

export interface Artifact {
  id: string;
  job_id: string;
  task_id?: string;
  type: 'file' | 'patch' | 'report' | 'code';
  path?: string;
  content: string;
  created_at: number;
}

export interface Approval {
  id: string;
  job_id: string;
  task_id: string;
  action: string;
  reason?: string;
  details?: Record<string, any>;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  resolved_at?: number;
}

export interface TaskState {
  job_id: string;
  mission: string;
  constraints: string[];
  plan: Task[];
  current_task: string | null;
  completed_tasks: string[];
  pending_tasks: string[];
  open_questions: string[];
  risks: string[];
  artifacts: Artifact[];
  steps: Array<{
    action: any;
    result: any;
  }>;
  feedback?: string[];
}

// Agent Output Types

export interface ManagerOutput {
  thought: string;
  plan: Array<{
    id: string;
    title: string;
    description: string;
    dependencies: string[];
    acceptance_criteria: string[];
    assigned_to: AgentRole;
  }>;
  risks: string[];
  requires_approval: boolean;
}

export interface ExecutorOutput {
  thought: string;
  tool?: string;
  args?: Record<string, any>;
  response?: string;
  artifacts?: string[];
}

export interface VerifierOutput {
  thought: string;
  status: VerificationStatus;
  issues?: string[];
  approval_reason?: string;
}

// Tool Types

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface ToolPermissions {
  shell: {
    workspace_only: boolean;
    confirm_destructive: boolean;
    blocked_patterns: string[];
  };
  files: {
    allowed_paths: string[];
    blocked_paths: string[];
  };
  browser: {
    profile: string;
    headless: boolean;
  };
}

export interface AgentToolPolicy {
  /** Tool names to explicitly allow (supports "group:fs" shorthands) */
  allow?: string[];
  /** Tool names to explicitly deny */
  deny?: string[];
  /** Profile shorthand: "minimal" | "coding" | "web" | "full" */
  profile?: 'minimal' | 'coding' | 'web' | 'full';
}

export interface AgentDefinition {
  /** Unique ID for this agent - used in bindings and spawn calls */
  id: string;

  /** Human-readable name shown in the UI */
  name: string;

  /** Short description - shown in UI, injected into orchestrator context */
  description?: string;

  /** Emoji shown in UI and in agent output prefix */
  emoji?: string;

  /**
   * Absolute path to this agent's workspace directory.
   * If omitted, defaults to: <configDir>/../agents/<id>/workspace
   * The directory will be created automatically if it doesn't exist.
   */
  workspace?: string;

  /**
   * Model override for this agent.
   * Format: "provider/model" e.g. "ollama/qwen3:4b" or "openai/gpt-4o"
   * If omitted, uses the global llm.provider + model.
   */
  model?: string;

  /** Tool policy for this agent - overrides global tool config */
  tools?: AgentToolPolicy;

  /**
   * Whether this agent uses minimal prompt mode.
   * Minimal = no SOUL.md, no USER.md, no memory, no heartbeat.
   * Ideal for sub-agents and background specialists.
   * Default: false for main, true for any agent spawned as a sub-agent.
   */
  minimalPrompt?: boolean;

  /**
   * If true, this agent is the default receiver for user chat sessions.
   * Only one agent should have default: true.
   * If none is set, the first agent in the list is used.
   */
  default?: boolean;

  /**
   * Channel bindings - which incoming messages route to this agent.
   * Simplified version of OpenClaw bindings.
   * Examples:
   *   { channel: "telegram", accountId: "default" }
   *   { channel: "telegram", peerId: "123456789" }
   */
  bindings?: Array<{
    channel: 'telegram' | 'discord' | 'whatsapp';
    accountId?: string;
    peerId?: string;
  }>;

  /**
   * Cron schedule for autonomous runs (POSIX cron syntax).
   * e.g. "0 8 * * *" = every day at 8am
   * Requires heartbeat.enabled = true in config.
   */
  cronSchedule?: string;

  /**
   * Maximum steps the reactor may take per run.
   * Defaults to global orchestration.maxSteps (8) or 8.
   */
  maxSteps?: number;

  /**
   * Whether this agent can spawn other sub-agents.
   * Default: false (only the orchestrator should spawn).
   */
  canSpawn?: boolean;

  /**
   * List of agent IDs this agent is allowed to spawn.
   * If omitted and canSpawn is true, can spawn any agent.
   */
  spawnAllowlist?: string[];
}

// Config Types

export interface SmallClawConfig {
  version: string;
  gateway: {
    port: number;
    host: string;
    auth: {
      enabled: boolean;
      token?: string;
    };
  };
  ollama: {
    endpoint: string;
    timeout: number;
    concurrency: {
      llm_workers: number;
      tool_workers: number;
    };
  };
  models: {
    primary: string;
    roles: {
      manager: string;
      executor: string;
      verifier: string;
    };
  };
  tools: {
    enabled: string[];
    permissions: ToolPermissions;
  };
  skills: {
    directory: string;
    registries: string[];
    auto_update: boolean;
  };
  memory: {
    provider: string;
    path: string;
    embedding_model: string;
  };
  memory_options?: {
    auto_confirm?: boolean;
    audit?: boolean;
    truncate_length?: number;
  };
  heartbeat: {
    enabled: boolean;
    interval_minutes: number;
    workspace_file: string;
  };
  workspace: {
    path: string;
  };
  /**
   * Named agent definitions. The first agent with default:true (or the first
   * entry if none is marked) handles all unrouted user chat messages.
   * Leave empty to use single-agent mode (original behavior).
   */
  agents?: AgentDefinition[];
  session?: {
    maxMessages?: number;
    compactionThreshold?: number;
    memoryFlushThreshold?: number;
  };
  telegram?: {
    enabled: boolean;
    botToken: string;
    allowedUserIds: number[];
    streamMode: 'full' | 'partial';
  };
  channels?: {
    telegram?: {
      enabled: boolean;
      botToken: string;
      allowedUserIds: number[];
      streamMode: 'full' | 'partial';
    };
    discord?: {
      enabled: boolean;
      botToken: string;
      applicationId?: string;
      guildId?: string;
      channelId?: string;
      webhookUrl?: string;
    };
    whatsapp?: {
      enabled: boolean;
      accessToken: string;
      phoneNumberId: string;
      businessAccountId?: string;
      verifyToken?: string;
      webhookSecret?: string;
      testRecipient?: string;
    };
  };
  search?: {
    preferred_provider?: string;
    tavily_api_key?: string;
    google_api_key?: string;
    google_cx?: string;
    brave_api_key?: string;
    search_rigor?: string;
  };
  llm?: LLMConfig;
  orchestration?: {
    enabled: boolean;
    secondary: {
      provider: ProviderID | '';
      model: string;
    };
    triggers: {
      consecutive_failures: number;
      stagnation_rounds: number;
      loop_detection: boolean;
      risky_files_threshold: number;
      risky_tool_ops_threshold: number;
      no_progress_seconds: number;
    };
    preflight: {
      mode: 'off' | 'complex_only' | 'always';
      allow_secondary_chat: boolean;
    };
    limits: {
      assist_cooldown_rounds: number;
      max_assists_per_turn: number;
      max_assists_per_session: number;
      telemetry_history_limit: number;
    };
    browser?: {
      max_advisor_calls_per_turn?: number;
      max_collected_items?: number;
      max_forced_retries?: number;
      min_feed_items_before_answer?: number;
    };
    preempt?: {
      enabled?: boolean;
      stall_threshold_seconds?: number;
      max_preempts_per_turn?: number;
      max_preempts_per_session?: number;
      restart_mode?: 'inherit_console' | 'detached_hidden';
    };
    file_ops?: {
      enabled?: boolean;
      primary_create_max_lines?: number;
      primary_create_max_chars?: number;
      primary_edit_max_lines?: number;
      primary_edit_max_chars?: number;
      primary_edit_max_files?: number;
      verify_create_always?: boolean;
      verify_large_payload_lines?: number;
      verify_large_payload_chars?: number;
      watchdog_no_progress_cycles?: number;
      checkpointing_enabled?: boolean;
    };
    // false = conservative 4B delegate_to_specialist (sequential)
    // true  = full multi-agent subagent_spawn (parallel, Claude Cowork-style)
    subagent_mode?: boolean;
  };
  hooks?: {
    enabled: boolean;
    token: string;
    path: string;
  };
  agent_policy?: {
    force_web_for_fresh?: boolean;
    memory_fallback_on_search_failure?: boolean;
    auto_store_web_facts?: boolean;
    natural_language_tool_router?: boolean;
    retrieval_mode?: string;
  };
}

// Backward-compatible alias while internals migrate.
export type LocalClawConfig = SmallClawConfig;

// ─── Multi-Provider LLM Config ──────────────────────────────────────────────

export type ProviderID = 'ollama' | 'llama_cpp' | 'lm_studio' | 'openai' | 'openai_codex';

export interface OllamaProviderConfig    { endpoint: string; model: string; }
export interface LlamaCppProviderConfig  { endpoint: string; model: string; api_key?: string; }
export interface LMStudioProviderConfig  { endpoint: string; model: string; api_key?: string; }
export interface OpenAIProviderConfig    { api_key: string;  model: string; }
export interface OpenAICodexProviderConfig { model: string; } // token managed by auth/openai-oauth.ts

export interface LLMConfig {
  provider: ProviderID;
  providers: {
    ollama?:       OllamaProviderConfig;
    llama_cpp?:    LlamaCppProviderConfig;
    lm_studio?:    LMStudioProviderConfig;
    openai?:       OpenAIProviderConfig;
    openai_codex?: OpenAICodexProviderConfig;
  };
}

export interface Skill {
  name: string;
  description: string;
  author?: string;
  version: string;
  tags: string[];
  permissions: {
    tools: string[];
    approval_required: boolean;
  };
  content: string;
}
