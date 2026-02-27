// Core type definitions for LocalClaw

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

// Config Types

export interface LocalClawConfig {
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
  };
  agent_policy?: {
    force_web_for_fresh?: boolean;
    memory_fallback_on_search_failure?: boolean;
    auto_store_web_facts?: boolean;
    natural_language_tool_router?: boolean;
    retrieval_mode?: string;
  };
}

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
