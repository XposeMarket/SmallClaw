/**
 * LLMProvider.ts
 * Provider-agnostic interface that every backend adapter must implement.
 * ollama-client.ts delegates to whichever provider is active at runtime.
 */

/**
 * A single part inside a multimodal content array.
 * Used only when sending image data to capable secondary models (OpenAI, Codex).
 * Small primary models (Ollama 4B) always receive plain string content.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * Plain string for all primary (small) model calls.
   * ContentPart[] only for multimodal secondary advisor calls where the
   * provider is 'openai' or 'openai_codex' and the model supports vision.
   */
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  num_ctx?: number;
  tools?: any[];
  think?: boolean | 'high' | 'medium' | 'low';
}

export interface GenerateOptions {
  temperature?: number;
  max_tokens?: number;
  num_ctx?: number;
  format?: 'json';
  system?: string;
  think?: boolean | 'high' | 'medium' | 'low';
}

export interface ChatResult {
  message: ChatMessage;
  thinking?: string;
}

export interface GenerateResult {
  response: string;
  thinking?: string;
}

export interface ModelInfo {
  name: string;
  size?: number;
  parameter_size?: string;
  family?: string;
  modified_at?: string;
}

export interface LLMProvider {
  /** Send a multi-turn chat request. */
  chat(messages: ChatMessage[], model: string, options?: ChatOptions): Promise<ChatResult>;

  /** Single-prompt generation (used by reactor/agents). */
  generate(prompt: string, model: string, options?: GenerateOptions): Promise<GenerateResult>;

  /** List available models. Returns [] if provider doesn't support listing. */
  listModels(): Promise<ModelInfo[]>;

  /** Quick connectivity check. Returns true if reachable. */
  testConnection(): Promise<boolean>;

  /** Provider identifier. */
  readonly id: ProviderID;
}

export type ProviderID = 'ollama' | 'llama_cpp' | 'lm_studio' | 'openai' | 'openai_codex';
