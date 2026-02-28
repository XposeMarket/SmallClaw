import { ToolResult } from '../types.js';
import { shellTool } from './shell.js';
import { readTool, writeTool, editTool, listTool, deleteTool, renameTool, copyTool, mkdirTool, statTool, appendTool, applyPatchTool } from './files.js';
import { webSearchTool, webFetchTool } from './web.js';
import { memorySearchTool, memoryWriteTool } from './memory.js';
import { skillListTool, skillSearchTool, skillInstallTool, skillRemoveTool, skillExecTool } from './skills.js';
import { timeNowTool } from './time.js';
import { selfUpdateTool } from './self-update.js';
import { readSourceTool, listSourceTool } from './source-access.js';
import { proposeRepairTool } from './self-repair.js';
import { personaReadTool, personaUpdateTool } from './persona.js';

export interface Tool {
  name: string;
  description: string;
  execute: (args: any) => Promise<ToolResult>;
  schema: Record<string, string>;
  // Optional explicit OpenAPI-style JSON schema for native function-call parameters.
  // When provided, this is used instead of description-based type inference.
  jsonSchema?: Record<string, any>;
}

export type ToolProfile = 'minimal' | 'coding' | 'web' | 'full';

const TOOL_PROFILE_TOOL_NAMES: Record<Exclude<ToolProfile, 'full'>, ReadonlySet<string>> = {
  minimal: new Set([
    'memory_search',
    'memory_write',
    'time_now',
  ]),
  coding: new Set([
    'shell',
    'read',
    'write',
    'edit',
    'list',
    'delete',
    'rename',
    'copy',
    'mkdir',
    'stat',
    'append',
    'apply_patch',
    'memory_search',
    'memory_write',
  ]),
  web: new Set([
    'web_search',
    'web_fetch',
    'memory_search',
    'memory_write',
  ]),
};

function isToolProfile(value: string): value is ToolProfile {
  return value === 'minimal' || value === 'coding' || value === 'web' || value === 'full';
}

const spawnAgentTool: Tool = {
  name: 'spawn_agent',
  description: 'Spawn a sub-agent to handle a specific task. Returns the agent\'s result.',
  schema: {
    agentId: 'ID of the agent to spawn (from config)',
    task: 'Task description to give the agent',
    context: 'Optional extra context to inject',
    maxSteps: 'Max reactor steps (default 8)',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'ID of the agent to spawn (from config)' },
      task: { type: 'string', description: 'Task description to give the agent' },
      context: { type: 'string', description: 'Optional extra context to inject' },
      maxSteps: { type: 'number', description: 'Max reactor steps (default 8)' },
    },
    required: ['agentId', 'task'],
    additionalProperties: true,
  },
  execute: async (params: any): Promise<ToolResult> => {
    const { spawnAgent } = await import('../agents/spawner.js');
    const result = await spawnAgent({
      agentId: params?.agentId,
      task: params?.task,
      context: params?.context,
      maxSteps: params?.maxSteps,
    });
    return {
      success: result.success,
      stdout: result.success
        ? `[${result.agentName}] ${result.result}`
        : `[${result.agentName}] FAILED: ${result.error}`,
      data: result,
    };
  },
};

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  private registerSafe(tool: Tool): void {
    try {
      this.register(tool);
    } catch (err: any) {
      const label = tool?.name || 'unknown_tool';
      const message = String(err?.message || err || 'unknown error');
      console.warn(`[tools] Failed to register "${label}": ${message}`);
    }
  }

  constructor() {
    // Core filesystem + shell
    this.registerSafe(shellTool);
    this.registerSafe(readTool);
    this.registerSafe(writeTool);
    this.registerSafe(editTool);
    this.registerSafe(listTool);
    this.registerSafe(deleteTool);
    // Additional filesystem utilities
    this.registerSafe(renameTool);
    this.registerSafe(copyTool);
    this.registerSafe(mkdirTool);
    this.registerSafe(statTool);
    this.registerSafe(appendTool);
    this.registerSafe(applyPatchTool);
    // Web tools
    this.registerSafe(webSearchTool);
    this.registerSafe(webFetchTool);
    // Memory tools
    this.registerSafe(memoryWriteTool);
    this.registerSafe(memorySearchTool);
    // Time tool (system clock — no network)
    this.registerSafe(timeNowTool);
    // ClawHub skills tools
    this.registerSafe(skillListTool);
    this.registerSafe(skillSearchTool);
    this.registerSafe(skillInstallTool);
    this.registerSafe(skillRemoveTool);
    this.registerSafe(skillExecTool);
    // Self-update tool
    this.registerSafe(selfUpdateTool);
    // Self-repair tools (source read + repair proposal)
    this.registerSafe(readSourceTool);
    this.registerSafe(listSourceTool);
    this.registerSafe(proposeRepairTool);
    // Persona / memory growth tools
    this.registerSafe(personaReadTool);
    this.registerSafe(personaUpdateTool);
    // Multi-agent spawn tool
    this.registerSafe(spawnAgentTool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  private listByProfile(profile: ToolProfile = 'full'): Tool[] {
    if (profile === 'full') return this.list();
    const toolNames = TOOL_PROFILE_TOOL_NAMES[profile];
    return this.list().filter((tool) => toolNames.has(tool.name));
  }

  resolveToolProfile(profile?: string | null): ToolProfile {
    const normalized = String(profile || '').trim().toLowerCase();
    return isToolProfile(normalized) ? normalized : 'full';
  }

  async execute(toolName: string, args: any): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolName}. Available tools: ${Array.from(this.tools.keys()).join(', ')}`
      };
    }

    try {
      return await tool.execute(args);
    } catch (error: any) {
      return {
        success: false,
        error: `Tool execution failed: ${error.message}`
      };
    }
  }

  getToolSchemas(profile: ToolProfile = 'full'): string {
    const tools = this.listByProfile(profile);
    return tools.map(tool => {
      const schemaStr = Object.entries(tool.schema)
        .map(([key, desc]) => `  - ${key}: ${desc}`)
        .join('\n');
      
      return `${tool.name}: ${tool.description}\n${schemaStr}`;
    }).join('\n\n');
  }

  getToolDefinitionsForChat(profile: ToolProfile = 'full'): any[] {
    const tools = this.listByProfile(profile);
    const inferParamSchema = (key: string, desc: string): any => {
      const k = String(key || '').toLowerCase();
      const d = String(desc || '').toLowerCase();
      if (/\b(true|false|boolean)\b/.test(d) || /\b(force|strict|recursive|enabled|disabled|stream|dry_run|dry run)\b/.test(k)) {
        return { type: 'boolean', description: String(desc || '') };
      }
      if (
        /\b(integer|number|count|max|min|limit|timeout|ms|seconds?|minutes?|days?)\b/.test(d)
        || /(max|min|count|limit|timeout|num|days|hours|minutes|seconds|retries|offset|line|chars|size|port)$/.test(k)
      ) {
        return { type: 'number', description: String(desc || '') };
      }
      if (/\bjson\b/.test(d) || /(args|params|options|payload|values)_?json$/.test(k)) {
        return {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'string' },
          ],
          description: String(desc || ''),
        };
      }
      return { type: 'string', description: String(desc || '') };
    };
    const buildInferredParameters = (tool: Tool): Record<string, any> => {
      const properties: Record<string, any> = {};
      for (const [key, desc] of Object.entries(tool.schema || {})) {
        properties[key] = inferParamSchema(key, String(desc || ''));
      }
      return {
        type: 'object',
        properties,
        additionalProperties: true,
      };
    };
    const normalizeExplicitParameters = (tool: Tool): Record<string, any> | null => {
      const raw = tool.jsonSchema;
      if (!raw || typeof raw !== 'object') return null;
      const normalized: Record<string, any> = { ...raw };
      if (normalized.type == null) normalized.type = 'object';
      if (normalized.properties == null) normalized.properties = {};
      if (normalized.additionalProperties == null) normalized.additionalProperties = true;
      return normalized;
    };
    return tools.map((tool) => {
      const explicitParameters = normalizeExplicitParameters(tool);
      const inferredParameters = buildInferredParameters(tool);
      const parameters = explicitParameters || inferredParameters;
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters,
        },
      };
    });
  }

  isToolEnabled(toolName: string, enabledTools: string[]): boolean {
    return enabledTools.includes(toolName);
  }
}

// Singleton instance
let registryInstance: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!registryInstance) {
    registryInstance = new ToolRegistry();
  }
  return registryInstance;
}
