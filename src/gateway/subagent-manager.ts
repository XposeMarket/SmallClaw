/**
 * subagent-manager.ts — Modular Dynamic Subagent System
 *
 * Allows primary agents to spawn/manage specialized subagents with:
 * - Dynamic tool sets
 * - Custom constraints and instructions
 * - Persistent config files user can edit
 * - Call-time or create-time parameters
 */

import fs from 'fs';
import path from 'path';
import { TaskRecord, createTask } from './task-store';
import { BackgroundTaskRunner } from './background-task-runner';

export interface SubagentDefinition {
  id: string;
  name: string;
  description: string;
  
  // Execution constraints
  max_steps: number;
  timeout_ms: number;
  model?: string;  // Override from main config
  
  // Capabilities
  allowed_tools: string[];  // e.g., ["web_fetch", "browser_*", "read_file"]
  forbidden_tools: string[];  // Explicit blacklist
  
  // Behavior
  system_instructions: string;    // Detailed personality/rules
  constraints: string[];          // "Do not hallucinate", "Return ONLY facts", etc.
  success_criteria: string;       // "When to stop and return results"
  
  // Metadata
  created_at: number;
  modified_at: number;
  created_by: 'user' | 'ai';
  version: string;
}

export interface SubagentCallRequest {
  // Identify or create subagent
  subagent_id: string;            // e.g., "news_researcher_v1"
  subagent_name?: string;         // If different from ID
  
  // Task for this subagent
  task_prompt: string;            // "Extract headlines from these 3 Reuters pages"
  context_data?: Record<string, any>;  // Snapshots, URLs, etc.
  
  // Create new subagent if doesn't exist
  create_if_missing?: {
    description: string;
    allowed_tools: string[];
    forbidden_tools?: string[];
    system_instructions: string;
    constraints: string[];
    success_criteria: string;
    max_steps?: number;
    timeout_ms?: number;
    model?: string;
  };
}

export interface SubagentResult {
  subagent_id: string;
  task_id: string;
  status: 'running' | 'complete' | 'failed' | 'paused' | 'spawned';
  result_text: string;
  extracted_data?: Record<string, any>;
  error?: string;
}

const SUBAGENT_STORE_DIR = '.smallclaw/subagents';

export class SubagentManager {
  private storePath: string;
  private broadcastFn?: (data: any) => void;

  constructor(workspacePath: string, broadcastFn?: (data: any) => void) {
    this.storePath = path.join(workspacePath, SUBAGENT_STORE_DIR);
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true });
    }
  }

  /**
   * Get or create a subagent and spawn it with a task
   */
  async callSubagent(
    request: SubagentCallRequest,
    parentTaskId: string,
  ): Promise<SubagentResult> {
    const subagentId = request.subagent_id;
    
    // Load existing or create new
    let definition = this.loadSubagent(subagentId);
    if (!definition && request.create_if_missing) {
      definition = this.createSubagent(subagentId, request.create_if_missing);
    }
    
    if (!definition) {
      throw new Error(`Subagent "${subagentId}" not found and no create_if_missing provided`);
    }

    // Build task for this subagent
    const subagentPrompt = this.buildSubagentPrompt(definition, request.task_prompt, request.context_data);
    
    const subagentTask = createTask({
      title: `[Subagent] ${definition.name}`,
      prompt: subagentPrompt,
      sessionId: `subagent_${subagentId}_${Date.now()}`,
      channel: 'web',
      subagentProfile: definition.id,  // Mark as subagent with restrictions
      parentTaskId,  // Link to parent
      plan: this.buildDefaultPlan(definition),
    });

    // Broadcast agent_spawned event to UI
    if (this.broadcastFn) {
      this.broadcastFn({
        type: 'agent_spawned',
        serverAgentId: subagentTask.id,  // Server-side agent identifier
        name: definition.name,
        task: request.task_prompt,
        isSubagent: true,
      });
    }

    // Queue the subagent task for execution (will be picked up by heartbeat)
    // For now, just return the task ID; full integration with BackgroundTaskRunner
    // will happen in next phase

    return {
      subagent_id: subagentId,
      task_id: subagentTask.id,
      status: 'spawned',
      result_text: 'Subagent queued for execution',
      extracted_data: undefined,
    };
  }

  /**
   * Load subagent definition from disk
   */
  private loadSubagent(id: string): SubagentDefinition | null {
    const configPath = path.join(this.storePath, id, 'config.json');
    try {
      if (!fs.existsSync(configPath)) return null;
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      console.error(`[SubagentManager] Failed to load ${id}:`, err);
      return null;
    }
  }

  /**
   * Create and persist a new subagent definition
   */
  private createSubagent(id: string, params: SubagentCallRequest['create_if_missing']): SubagentDefinition {
    if (!params) throw new Error('create_if_missing required');

    const definition: SubagentDefinition = {
      id,
      name: params.description.split('\n')[0].slice(0, 40),
      description: params.description,
      max_steps: params.max_steps ?? 20,
      timeout_ms: params.timeout_ms ?? 300_000,
      model: params.model,
      allowed_tools: params.allowed_tools,
      forbidden_tools: params.forbidden_tools ?? [],
      system_instructions: params.system_instructions,
      constraints: params.constraints,
      success_criteria: params.success_criteria,
      created_at: Date.now(),
      modified_at: Date.now(),
      created_by: 'ai',
      version: '1.0',
    };

    // Persist
    const agentDir = path.join(this.storePath, id);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'config.json'),
      JSON.stringify(definition, null, 2),
    );

    // Also write editable system prompt file
    fs.writeFileSync(
      path.join(agentDir, 'system_prompt.md'),
      this.buildSystemPromptFile(definition),
    );

    console.log(`[SubagentManager] Created new subagent: ${id}`);
    return definition;
  }

  /**
   * Build system prompt file that user can edit
   */
  private buildSystemPromptFile(def: SubagentDefinition): string {
    return [
      `# ${def.name}`,
      ``,
      def.description,
      ``,
      `## Instructions`,
      def.system_instructions,
      ``,
      `## Constraints (DO NOT VIOLATE)`,
      def.constraints.map(c => `- ${c}`).join('\n'),
      ``,
      `## Success Criteria`,
      def.success_criteria,
      ``,
      `## Allowed Tools`,
      def.allowed_tools.map(t => `- ${t}`).join('\n'),
      ``,
      `## Forbidden Tools`,
      def.forbidden_tools.map(t => `- ${t}`).join('\n'),
      ``,
      `## Configuration`,
      `- Max steps: ${def.max_steps}`,
      `- Timeout: ${def.timeout_ms}ms`,
      `- Model override: ${def.model || '(use default)'}`,
      ``,
      `---`,
      `**Note:** Edit this file to modify the subagent. Changes take effect on next call.`,
    ].join('\n');
  }

  /**
   * Build the task prompt that includes context data
   */
  private buildSubagentPrompt(
    def: SubagentDefinition,
    taskPrompt: string,
    contextData?: Record<string, any>,
  ): string {
    const contextSection = contextData
      ? `\n\nCONTEXT DATA:\n${JSON.stringify(contextData, null, 2)}`
      : '';

    return [
      `[SUBAGENT: ${def.name}]`,
      ``,
      `TASK: ${taskPrompt}`,
      contextSection,
      ``,
      `CONSTRAINTS:`,
      def.constraints.map(c => `• ${c}`).join('\n'),
      ``,
      `SUCCESS CRITERIA: ${def.success_criteria}`,
    ].join('\n');
  }

  /**
   * Build a default plan for subagent execution
   */
  private buildDefaultPlan(def: SubagentDefinition): any[] {
    return [
      {
        index: 0,
        description: `Execute ${def.name} with allowed tools: ${def.allowed_tools.join(', ')}`,
        status: 'pending',
      },
      {
        index: 1,
        description: `Validate results against success criteria`,
        status: 'pending',
      },
      {
        index: 2,
        description: `Return extracted data to parent task`,
        status: 'pending',
      },
    ];
  }

  /**
   * List all available subagents
   */
  listSubagents(): Array<{ id: string; name: string; description: string }> {
    try {
      if (!fs.existsSync(this.storePath)) return [];
      const dirs = fs.readdirSync(this.storePath);
      return dirs
        .map(dir => {
          const config = this.loadSubagent(dir);
          return config
            ? { id: config.id, name: config.name, description: config.description }
            : null;
        })
        .filter(Boolean) as any;
    } catch {
      return [];
    }
  }

  /**
   * Delete a subagent
   */
  deleteSubagent(id: string): boolean {
    try {
      const agentDir = path.join(this.storePath, id);
      if (fs.existsSync(agentDir)) {
        fs.rmSync(agentDir, { recursive: true });
        console.log(`[SubagentManager] Deleted subagent: ${id}`);
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[SubagentManager] Failed to delete ${id}:`, err);
      return false;
    }
  }

  /**
   * Reload a subagent config from disk (for user edits)
   */
  reloadSubagent(id: string): SubagentDefinition | null {
    return this.loadSubagent(id);
  }

  /**
   * Emit a log event from a subagent to the UI
   * Called by background task runner or subagent itself
   */
  emitAgentLog(serverAgentId: string, logType: string, content: string): void {
    if (this.broadcastFn) {
      this.broadcastFn({
        type: 'agent_log',
        serverAgentId,
        logType,
        content,
      });
    }
  }

  /**
   * Emit a completion event for a subagent
   */
  emitAgentCompleted(serverAgentId: string): void {
    if (this.broadcastFn) {
      this.broadcastFn({
        type: 'agent_completed',
        serverAgentId,
      });
    }
  }

  /**
   * Emit a pause/error event for a subagent
   */
  emitAgentPaused(serverAgentId: string, reason: string): void {
    if (this.broadcastFn) {
      this.broadcastFn({
        type: 'agent_paused',
        serverAgentId,
        reason,
      });
    }
  }
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const subagentSpawnTool = {
  name: 'spawn_subagent',
  description:
    'Create a specialized sub-agent for a specific task (research, analysis, etc). The subagent gets a restricted tool set and explicit constraints. Perfect for delegating work while maintaining quality control.',
  schema: {
    type: 'object',
    required: ['subagent_id', 'task_prompt'],
    properties: {
      subagent_id: {
        type: 'string',
        description: 'Identifier for this subagent. Use persistent names like "news_researcher_v1" so you can call it again later.',
      },
      task_prompt: {
        type: 'string',
        description: 'The task for this subagent to complete. Be specific and include any context.',
      },
      context_data: {
        type: 'object',
        description: 'Optional data to pass: snapshots, URLs, extracted text, etc.',
      },
      create_if_missing: {
        type: 'object',
        description: 'If subagent does not exist, create it with these parameters.',
        properties: {
          description: {
            type: 'string',
            description: 'What this subagent does',
          },
          allowed_tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tools this subagent can use: web_fetch, browser_*, read_file, etc.',
          },
          system_instructions: {
            type: 'string',
            description: 'Detailed instructions for how to behave and think',
          },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Hard rules: "extract ONLY facts", "no hallucination", "return max 5 items"',
          },
          success_criteria: {
            type: 'string',
            description: 'When to stop and return results',
          },
          max_steps: {
            type: 'number',
            description: 'Maximum tool calls before stopping (default 20)',
          },
        },
        required: ['description', 'allowed_tools', 'system_instructions', 'constraints', 'success_criteria'],
      },
    },
  },
};
