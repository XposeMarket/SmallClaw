/**
 * openai-codex-adapter.ts
 *
 * Dedicated adapter for OpenAI Codex via ChatGPT Plus/Pro OAuth.
 * Uses https://chatgpt.com/backend-api/codex/responses — NOT /v1/chat/completions.
 *
 * Required headers:
 *   Authorization: Bearer <api_token>        (from OAuth token exchange)
 *   ChatGPT-Account-Id: <account_id>         (from JWT claims)
 *   OpenAI-Beta: responses=experimental
 *
 * Response format: SSE stream, we read response.completed for the final output.
 * Tool calls come back as response.output items with type "function_call".
 */

import type { LLMProvider, ChatMessage, ContentPart, ChatOptions, ChatResult, GenerateOptions, GenerateResult, ModelInfo } from './LLMProvider';
import { loadTokens, getValidToken } from '../auth/openai-oauth';
import { contentToString } from './content-utils';

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

// Models available via Codex OAuth
export const CODEX_MODELS = [
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.1',
  'gpt-5.2',
];

export class OpenAICodexAdapter implements LLMProvider {
  readonly id = 'openai_codex' as const;
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await getValidToken(this.configDir);
    const tokens = loadTokens(this.configDir);
    const accountId = tokens?.account_id || '';

    const headers: Record<string, string> = {
      'Content-Type':      'application/json',
      'Authorization':     `Bearer ${token}`,
      'OpenAI-Beta':       'responses=experimental',
      'Accept':            'text/event-stream',
    };
    if (accountId) {
      headers['chatgpt-account-id'] = accountId;
    }
    return headers;
  }

  // Convert SmallClaw ChatMessage[] -> Codex input[] format.
  // Handles both plain string content and ContentPart[] (multimodal vision calls).
  // Guarantees non-empty function call IDs for both function_call and function_call_output.
  private buildInput(messages: ChatMessage[]): any[] {
    const input: any[] = [];
    const pendingCallIds: string[] = [];
    const knownCallIds = new Set<string>();
    const consumedCallIds = new Set<string>();
    let fallbackSeq = 0;
    const nextFallbackCallId = () => `autocall_${Date.now()}_${++fallbackSeq}`;
    const asJsonArgumentString = (value: any): string => {
      if (typeof value === 'string') return value.trim() || '{}';
      if (value == null) return '{}';
      try {
        return JSON.stringify(value);
      } catch {
        return '{}';
      }
    };

    for (const m of messages) {
      if (m.role === 'system') continue; // system handled separately as instructions

      if (m.role === 'assistant' && m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const callId = String(tc?.id || (tc as any)?.call_id || '').trim() || nextFallbackCallId();
          pendingCallIds.push(callId);
          knownCallIds.add(callId);
          input.push({
            type: 'function_call',
            call_id: callId,
            name: String(tc?.function?.name || ''),
            arguments: asJsonArgumentString(tc?.function?.arguments),
          });
        }
        continue;
      }

      if (m.role === 'tool') {
        let callId = String(m.tool_call_id || '').trim();
        if (!callId && pendingCallIds.length > 0) {
          callId = pendingCallIds.shift()!;
        }
        if (callId) {
          // Keep the pending queue in sync even when tool_call_id is explicitly provided.
          const idx = pendingCallIds.indexOf(callId);
          if (idx !== -1) pendingCallIds.splice(idx, 1);
        }
        if (!callId) {
          // Some internal orchestration paths emit informational "tool" messages
          // that are not outputs for a real function_call. Codex rejects those as
          // function_call_output without a matching call_id, so preserve them as
          // plain assistant text context instead.
          const toolName = String((m as any).tool_name || m.name || 'tool').slice(0, 80);
          const content = typeof m.content === 'string' ? m.content : '';
          input.push({
            role: 'assistant',
            content: `[tool-note:${toolName}] ${content}`.slice(0, 12000),
          });
          continue;
        }
        if (!knownCallIds.has(callId) || consumedCallIds.has(callId)) {
          // Guard against desync: never send function_call_output for unknown/duplicate IDs.
          // Preserve context as assistant text instead of hard-failing the whole request.
          const toolName = String((m as any).tool_name || m.name || 'tool').slice(0, 80);
          const content = typeof m.content === 'string' ? m.content : '';
          input.push({
            role: 'assistant',
            content: `[tool-note:${toolName}] ${content}`.slice(0, 12000),
          });
          continue;
        }
        consumedCallIds.add(callId);
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: typeof m.content === 'string' ? m.content : '',
        });
        continue;
      }

      // Multimodal content: convert ContentPart[] to Codex content array format
      if (Array.isArray(m.content)) {
        const parts: any[] = m.content.map((part: ContentPart) => {
          if (part.type === 'text') return { type: 'input_text', text: part.text };
          if (part.type === 'image_url') {
            return {
              type: 'input_image',
              image_url: part.image_url.url,
              detail: part.image_url.detail ?? 'low',
            };
          }
          return { type: 'input_text', text: '' };
        });
        input.push({ role: m.role, content: parts });
        continue;
      }

      input.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
      });
    }

    return input;
  }

  async chat(messages: ChatMessage[], model: string, options?: ChatOptions): Promise<ChatResult> {
    const headers = await this.getHeaders();

    // Extract system message as instructions
    const systemMsg = messages.find(m => m.role === 'system');
    const instructions = systemMsg ? contentToString(systemMsg.content) : '';

    const body: any = {
      model,
      store: false,
      input: this.buildInput(messages),
      stream: true,
      tool_choice: 'auto',
      parallel_tool_calls: true,
    };
    if (instructions) body.instructions = instructions;
    if (Array.isArray(options?.tools) && options!.tools!.length) {
      body.tools = options!.tools.map((t: any) => ({
        type: 'function',
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        parameters: t.function?.parameters || t.parameters || {},
      }));
    }

    const response = await fetch(CODEX_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`openai_codex API error ${response.status}: ${text.slice(0, 400)}`);
    }

    // Parse SSE stream to extract the completed response
    const result = await this.parseSSEStream(response);
    return result;
  }

  private async parseSSEStream(response: Response): Promise<ChatResult> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from Codex endpoint');

    const decoder = new TextDecoder();
    let buffer = '';
    let finalContent = '';
    let toolCalls: any[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            const type = event.type as string;

            // Accumulate text deltas
            if (type === 'response.output_text.delta') {
              finalContent += event.delta || '';
            }

            // Tool/function call detected
            if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
              toolCalls.push({
                id:       event.item.call_id || `call_${Date.now()}`,
                type:     'function',
                function: {
                  name:      event.item.name || '',
                  arguments: '',
                },
                _idx: toolCalls.length,
              });
            }

            // Accumulate function call argument deltas
            if (type === 'response.function_call_arguments.delta') {
              const idx = event.output_index ?? (toolCalls.length - 1);
              if (toolCalls[idx]) {
                toolCalls[idx].function.arguments += event.delta || '';
              }
            }

            // response.completed contains the full final snapshot
            if (type === 'response.completed') {
              const outputs = event.response?.output || [];
              for (const item of outputs) {
                if (item.type === 'message') {
                  finalContent = (item.content || [])
                    .filter((c: any) => c.type === 'output_text')
                    .map((c: any) => c.text || '')
                    .join('');
                }
                if (item.type === 'function_call') {
                  // Prefer the complete snapshot over accumulated deltas
                  const existing = toolCalls.find(tc => tc.id === item.call_id);
                  if (existing) {
                    existing.function.name      = item.name || existing.function.name;
                    existing.function.arguments = item.arguments || existing.function.arguments;
                  } else {
                    toolCalls.push({
                      id:       item.call_id || `call_${Date.now()}`,
                      type:     'function',
                      function: { name: item.name || '', arguments: item.arguments || '' },
                    });
                  }
                }
              }
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Clean up internal tracking index
    toolCalls = toolCalls.map(({ _idx, ...tc }) => tc);

    const message: ChatMessage = {
      role: 'assistant',
      content: finalContent || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    return { message };
  }

  async generate(prompt: string, model: string, options?: GenerateOptions): Promise<GenerateResult> {
    const messages: ChatMessage[] = [];
    if (options?.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });
    const result = await this.chat(messages, model, {
      max_tokens:  options?.max_tokens,
    });
    return { response: contentToString(result.message.content) };
  }

  async listModels(): Promise<ModelInfo[]> {
    return CODEX_MODELS.map(name => ({ name }));
  }

  async testConnection(): Promise<boolean> {
    try {
      await getValidToken(this.configDir);
      return true;
    } catch {
      return false;
    }
  }
}
