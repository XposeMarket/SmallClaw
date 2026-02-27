/**
 * ollama-client.ts
 *
 * COMPATIBILITY SHIM — all existing code (reactor.ts, manager.ts, etc.)
 * continues to import this file unchanged. Internally it now delegates
 * to whichever LLMProvider is active in the factory.
 *
 * To switch providers, change config.llm.provider and restart (or call
 * resetProvider() from the settings API). No other files need touching.
 */

import { getProvider, getModelForRole, getPrimaryModel, resetProvider } from '../providers/factory';
import type { LLMProvider } from '../providers/LLMProvider';
import { AgentRole } from '../types';

export interface GenerateOutput {
  response: string;
  thinking?: string;
}

export interface ChatOutput {
  message: any;
  thinking?: string;
}

export class OllamaClient {

  private get provider(): LLMProvider {
    return getProvider();
  }

  // ─── Chat ───────────────────────────────────────────────────────────────────

  async chatWithThinking(
    messages: Array<any>,
    role: AgentRole,
    options?: {
      temperature?: number;
      num_ctx?: number;
      num_predict?: number;
      think?: boolean | 'high' | 'medium' | 'low';
      tools?: any[];
      model?: string;
    }
  ): Promise<ChatOutput> {
    const model = String(options?.model || '').trim() || getModelForRole(role);
    const result = await this.provider.chat(messages, model, {
      temperature: options?.temperature,
      max_tokens:  options?.num_predict,
      num_ctx:     options?.num_ctx,
      tools:       options?.tools,
      think:       options?.think,
    });
    return { message: result.message, thinking: result.thinking };
  }

  // ─── Generate ───────────────────────────────────────────────────────────────

  async generateWithThinking(
    prompt: string,
    role: AgentRole,
    options?: {
      temperature?: number;
      format?: 'json';
      system?: string;
      num_ctx?: number;
      num_predict?: number;
      think?: boolean | 'high' | 'medium' | 'low';
    }
  ): Promise<GenerateOutput> {
    const model = getModelForRole(role);
    return this.provider.generate(prompt, model, {
      temperature: options?.temperature,
      format:      options?.format,
      system:      options?.system,
      num_ctx:     options?.num_ctx,
      max_tokens:  options?.num_predict,
      think:       options?.think,
    });
  }

  async generate(prompt: string, role: AgentRole, options?: Parameters<OllamaClient['generateWithThinking']>[2]): Promise<string> {
    const out = await this.generateWithThinking(prompt, role, options);
    return out.response;
  }

  async generateWithRetry(
    prompt: string,
    role: AgentRole,
    options?: Parameters<OllamaClient['generateWithThinking']>[2],
    maxRetries: number = 3
  ): Promise<string> {
    const out = await this.generateWithRetryThinking(prompt, role, options, maxRetries);
    return out.response;
  }

  async generateWithRetryThinking(
    prompt: string,
    role: AgentRole,
    options?: Parameters<OllamaClient['generateWithThinking']>[2],
    maxRetries: number = 3
  ): Promise<GenerateOutput> {
    let lastError: Error | null = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.generateWithThinking(prompt, role, options);
      } catch (error: any) {
        lastError = error;
        console.warn(`Attempt ${i + 1}/${maxRetries} failed:`, error.message);
        if (i < maxRetries - 1) {
          await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        }
      }
    }
    throw lastError || new Error('Generation failed after retries');
  }

  // ─── Synthesis ──────────────────────────────────────────────────────────────

  async synthesize(facts: string[], originalQuestion: string, systemPrompt: string): Promise<string> {
    const out = await this.synthesizeWithThinking(facts, originalQuestion, systemPrompt);
    return out.response;
  }

  async synthesizeWithThinking(
    facts: string[],
    originalQuestion: string,
    systemPrompt: string,
    think: boolean | 'high' | 'medium' | 'low' = 'high'
  ): Promise<GenerateOutput> {
    const factsText = facts.map((f, i) => `[${i + 1}] ${f}`).join('\n\n');
    const prompt =
      `You found the following information to answer the user's question.\n\n` +
      `User asked: ${originalQuestion}\n\n` +
      `Facts gathered:\n${factsText}\n\n` +
      `Write a clear, complete response using these facts. ` +
      `Be specific. Use 2-5 sentences per topic. ` +
      `Do not say "based on search results" — just answer directly.`;

    const raw = await this.generateWithRetryThinking(prompt, 'executor', {
      temperature: 0.4,
      system: systemPrompt,
      num_ctx: 3072,
      think,
    });

    return {
      response: raw.response
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*/gi, '')
        .trim(),
      thinking: raw.thinking,
    };
  }

  // ─── Model Management (Ollama-only, graceful no-op for others) ──────────────

  async listModels(): Promise<string[]> {
    try {
      const models = await this.provider.listModels();
      return models.map(m => m.name);
    } catch { return []; }
  }

  async checkModelExists(modelName: string): Promise<boolean> {
    const models = await this.listModels();
    return models.includes(modelName);
  }

  async pullModel(modelName: string): Promise<void> {
    const p = this.provider as any;
    if (typeof p.pullModel === 'function') {
      await p.pullModel(modelName);
    } else {
      throw new Error(`pullModel is not supported for provider "${this.provider.id}". Download models via your provider's own tool.`);
    }
  }

  async testConnection(): Promise<boolean> {
    return this.provider.testConnection();
  }

  // ─── JSON Parser (unchanged) ─────────────────────────────────────────────────

  parseJSON<T>(response: string): T {
    let cleaned = response.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/m, '').replace(/\n?```\s*$/m, '');
    }
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    cleaned = cleaned.replace(/<think>[\s\S]*/gi, '').trim();

    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');

    if (start === -1) {
      throw new Error(`Invalid JSON response from model: SyntaxError: Unexpected end of JSON input`);
    }

    if (end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    } else {
      cleaned = cleaned.slice(start);
      cleaned = cleaned.replace(/,\s*$/, '');
      let openBraces = 0, openBrackets = 0, inString = false, escaped = false;
      for (const ch of cleaned) {
        if (escaped)         { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"')      { inString = !inString; continue; }
        if (inString)        continue;
        if (ch === '{')       openBraces++;
        else if (ch === '}')  openBraces  = Math.max(0, openBraces - 1);
        else if (ch === '[')  openBrackets++;
        else if (ch === ']')  openBrackets = Math.max(0, openBrackets - 1);
      }
      if (inString) cleaned += '"';
      cleaned += ']'.repeat(Math.max(0, openBrackets));
      cleaned += '}'.repeat(Math.max(0, openBraces));
    }

    return JSON.parse(cleaned) as T;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let ollamaInstance: OllamaClient | null = null;

export function getOllamaClient(): OllamaClient {
  if (!ollamaInstance) ollamaInstance = new OllamaClient();
  return ollamaInstance;
}

export { resetProvider };
