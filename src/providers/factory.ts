/**
 * factory.ts
 * Returns the active LLMProvider based on config.
 * All code that needs to talk to an LLM goes through here.
 *
 * Supported providers:
 *   ollama       - Ollama SDK (default, localhost:11434)
 *   llama_cpp    - llama-server OpenAI-compat (localhost:8080)
 *   lm_studio    - LM Studio OpenAI-compat (localhost:1234)
 *   openai       - OpenAI API key (api.openai.com)
 *   openai_codex - OpenAI OAuth / GPT Plus subscription
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { getConfig } from '../config/config';
import { log } from '../security/log-scrubber';
import type { LLMProvider, ProviderID } from './LLMProvider';
import { OllamaAdapter } from './ollama-adapter';
import { OpenAICompatAdapter } from './openai-compat-adapter';
import { OpenAICodexAdapter } from './openai-codex-adapter';

const LEGACY_BLOCKED_MODELS = new Set(['codex-davinci-002']);
const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const DEFAULT_OPENAI_CODEX_MODEL = 'gpt-5.3-codex';

// ─── Config Resolution ─────────────────────────────────────────────────────────

function getProviderConfig(): { active: ProviderID; providers: any } {
  const raw = getConfig().getConfig() as any;

  // New-style config
  if (raw.llm?.provider) {
    return { active: raw.llm.provider, providers: raw.llm.providers || {} };
  }

  // Legacy Ollama-only config — migrate transparently
  return {
    active: 'ollama',
    providers: {
      ollama: {
        endpoint: raw.ollama?.endpoint || 'http://localhost:11434',
        model: raw.models?.primary || 'qwen3:4b',
      },
    },
  };
}

function getConfigDir(): string {
  const PROJECT_CONFIG = path.join(process.cwd(), '.smallclaw');
  const HOME_CONFIG    = path.join(os.homedir(), '.smallclaw');
  return fs.existsSync(PROJECT_CONFIG) ? PROJECT_CONFIG : HOME_CONFIG;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

let cachedProvider: LLMProvider | null = null;
let cachedProviderId: ProviderID | null = null;

/**
 * Returns the active provider. Re-creates it if the config changed.
 */
export function getProvider(): LLMProvider {
  const { active, providers } = getProviderConfig();

  if (cachedProvider && cachedProviderId === active) {
    // For Ollama, update endpoint in case it changed in settings
    if (active === 'ollama' && cachedProvider instanceof OllamaAdapter) {
      cachedProvider.updateEndpoint(providers.ollama?.endpoint || 'http://localhost:11434');
    }
    return cachedProvider;
  }

  cachedProviderId = active;
  cachedProvider   = buildProvider(active, providers);
  return cachedProvider;
}

/** Force a fresh provider instance (call after settings change). */
export function resetProvider(): void {
  cachedProvider   = null;
  cachedProviderId = null;
}

/**
 * Build a provider instance for any provider ID without affecting the cached primary.
 * Used by the orchestration layer for the secondary model.
 */
export function buildProviderById(providerId: string): LLMProvider {
  const raw = getConfig().getConfig() as any;
  const providers = raw.llm?.providers || {};
  return buildProvider(providerId as ProviderID, providers);
}

/**
 * Build a provider instance from an arbitrary llm config payload
 * (e.g. unsaved Settings UI values) without mutating global config.
 */
export function buildProviderForLLM(llm: any): LLMProvider {
  const active = (llm?.provider || 'ollama') as ProviderID;
  const providers = llm?.providers || {};
  return buildProvider(active, providers);
}


function buildProvider(id: ProviderID, providers: any): LLMProvider {
  switch (id) {

    case 'ollama': {
      const cfg = providers.ollama || {};
      return new OllamaAdapter(cfg.endpoint || 'http://localhost:11434');
    }

    case 'llama_cpp': {
      const cfg = providers.llama_cpp || {};
      return new OpenAICompatAdapter({
        endpoint:   cfg.endpoint || 'http://localhost:8080',
        apiKey:     cfg.api_key,   // usually not needed for local
        providerId: 'llama_cpp',
      });
    }

    case 'lm_studio': {
      const cfg = providers.lm_studio || {};
      return new OpenAICompatAdapter({
        endpoint:   cfg.endpoint || 'http://localhost:1234',
        apiKey:     cfg.api_key,   // LM Studio has optional key support
        providerId: 'lm_studio',
      });
    }

    case 'openai': {
      const cfg = providers.openai || {};
      const apiKey = resolveEnvKey(cfg.api_key);
      if (!apiKey) throw new Error('OpenAI API key not configured. Add it in Settings -> Models.');
      return new OpenAICompatAdapter({
        endpoint:   'https://api.openai.com',
        apiKey,
        providerId: 'openai',
      });
    }

    case 'openai_codex': {
      const configDir = getConfigDir();
      return new OpenAICodexAdapter(configDir);
    }

    default:
      log.warn(`[Provider] Unknown provider "${id}", falling back to Ollama`);
      return new OllamaAdapter('http://localhost:11434');
  }
}

/**
 * Supports env-var references in config values.
 * e.g. api_key: "env:OPENAI_API_KEY" -> reads process.env.OPENAI_API_KEY
 */
function resolveEnvKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('env:')) {
    const envName = value.slice(4);
    return process.env[envName];
  }
  return value;
}

/** Convenience: get the active model name for a given role. */
export function getModelForRole(role: 'manager' | 'executor' | 'verifier'): string {
  const raw = getConfig().getConfig() as any;

  // New-style per-provider model
  const { active, providers } = getProviderConfig();
  const providerCfg = providers[active] || {};
  if (providerCfg.model) {
    const model = String(providerCfg.model).trim();
    if (active === 'openai_codex' && LEGACY_BLOCKED_MODELS.has(model)) return DEFAULT_OPENAI_CODEX_MODEL;
    return model;
  }

  if (active === 'openai_codex') return DEFAULT_OPENAI_CODEX_MODEL;
  if (active === 'openai') return DEFAULT_OPENAI_MODEL;

  // Legacy
  return raw.models?.roles?.[role] || raw.models?.primary || 'qwen3:4b';
}

export function getPrimaryModel(): string {
  return getModelForRole('executor');
}
