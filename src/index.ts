// Main exports for SmallClaw

// Configuration
export { ConfigManager, getConfig, DEFAULT_CONFIG } from './config/config.js';

// Database
export { JobDatabase, getDatabase } from './db/database.js';

// Agents
export { OllamaClient, getOllamaClient } from './agents/ollama-client.js';

// Tools
export { getToolRegistry } from './tools/registry.js';
export { shellTool } from './tools/shell.js';
export { readTool, writeTool, editTool, listTool, deleteTool, renameTool, copyTool, mkdirTool, statTool, appendTool } from './tools/files.js';

// Types
export * from './types.js';
