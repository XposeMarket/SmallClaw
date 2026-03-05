// src/gateway/retry-strategy.ts
// Exponential backoff retry strategy for transient errors

interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

interface RetryState {
  taskId: string;
  attempts: number;
  lastAttemptAt: number;
  nextRetryAt: number;
  config: RetryConfig;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
};

class RetryStrategy {
  private states: Map<string, RetryState> = new Map();

  createRetryState(taskId: string, config?: Partial<RetryConfig>): RetryState {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const state: RetryState = {
      taskId,
      attempts: 0,
      lastAttemptAt: 0,
      nextRetryAt: Date.now(),
      config: mergedConfig,
    };
    this.states.set(taskId, state);
    return state;
  }

  shouldRetry(taskId: string): boolean {
    const state = this.states.get(taskId);
    if (!state) return false;
    return state.attempts < state.config.maxAttempts && Date.now() >= state.nextRetryAt;
  }

  recordAttempt(taskId: string): { canRetry: boolean; delayMs: number; attemptsUsed: number } {
    const state = this.states.get(taskId);
    if (!state) {
      return { canRetry: false, delayMs: 0, attemptsUsed: 0 };
    }

    state.attempts++;
    state.lastAttemptAt = Date.now();

    if (state.attempts >= state.config.maxAttempts) {
      return { canRetry: false, delayMs: 0, attemptsUsed: state.attempts };
    }

    // Exponential backoff: baseDelay * 2^attempt
    let delay = state.config.baseDelayMs * Math.pow(2, state.attempts - 1);
    delay = Math.min(delay, state.config.maxDelayMs);

    if (state.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    state.nextRetryAt = Date.now() + delay;
    return { canRetry: true, delayMs: Math.round(delay), attemptsUsed: state.attempts };
  }

  getState(taskId: string): RetryState | null {
    return this.states.get(taskId) || null;
  }

  clearState(taskId: string): void {
    this.states.delete(taskId);
  }

  clearAll(): void {
    this.states.clear();
  }
}

let instance: RetryStrategy | null = null;

export function getRetryStrategy(): RetryStrategy {
  if (!instance) instance = new RetryStrategy();
  return instance;
}
