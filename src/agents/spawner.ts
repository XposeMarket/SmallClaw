import { getAgentById, ensureAgentWorkspace } from '../config/config.js';
import { getOllamaClient } from './ollama-client.js';
import { Reactor } from './reactor.js';

export interface SpawnOptions {
  /** ID of the agent to run */
  agentId: string;
  /** The task/mission to give the agent */
  task: string;
  /** Timeout in ms. Default: 120000 (2 min) */
  timeoutMs?: number;
  /** Max reactor steps. Overrides agent.maxSteps */
  maxSteps?: number;
  /** Extra context injected into the task prompt */
  context?: string;
  /** Called on each reactor step (for streaming to UI) */
  onStep?: (step: any) => void;
}

export interface SpawnResult {
  agentId: string;
  agentName: string;
  success: boolean;
  result: string;
  error?: string;
  durationMs: number;
  stepCount?: number;
}

/**
 * Spawns a sub-agent run in isolation.
 *
 * - Loads the agent definition from config
 * - Resolves + ensures the agent's workspace exists
 * - Builds a Reactor with the agent's workspace as context
 * - Runs the task with minimal prompt mode (unless agent.minimalPrompt=false)
 * - Returns the result
 *
 * The parent agent's session history is NOT shared with the sub-agent.
 * The sub-agent writes any outputs to its own workspace.
 */
export async function spawnAgent(options: SpawnOptions): Promise<SpawnResult> {
  const startMs = Date.now();
  const agent = getAgentById(options.agentId);

  if (!agent) {
    return {
      agentId: options.agentId,
      agentName: options.agentId,
      success: false,
      result: '',
      error: `Agent "${options.agentId}" not found in config. Check your agents array.`,
      durationMs: Date.now() - startMs,
    };
  }

  const workspacePath = ensureAgentWorkspace(agent);
  const maxSteps = options.maxSteps ?? agent.maxSteps ?? 8;
  const promptMode = agent.minimalPrompt === false ? 'full' : 'minimal';

  // Build the task message - include context if provided
  const taskMessage = options.context
    ? `${options.task}\n\n[Context from orchestrator]\n${options.context}`
    : options.task;

  // Build the reactor with the agent's model (if overridden)
  // For now we use the global ollama client - model override via env or
  // a future per-agent reactor config.
  const ollama = getOllamaClient();
  const reactor = new Reactor(ollama, maxSteps);

  let stepCount = 0;
  const timeoutMs = options.timeoutMs ?? 120000;

  try {
    const resultText = await Promise.race<string>([
      reactor.run(taskMessage, {
        role: 'executor',
        promptMode,
        workspacePath, // each agent gets its own workspace
        maxSteps,
        onStep: (step) => {
          stepCount++;
          options.onStep?.(step);
        },
      }),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`Sub-agent timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);

    return {
      agentId: agent.id,
      agentName: agent.name,
      success: true,
      result: resultText,
      durationMs: Date.now() - startMs,
      stepCount,
    };
  } catch (err: any) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      success: false,
      result: '',
      error: String(err?.message ?? err),
      durationMs: Date.now() - startMs,
      stepCount,
    };
  }
}

/**
 * Spawns multiple agents in parallel and waits for all results.
 * Use this when tasks are independent (research + write simultaneously).
 */
export async function spawnAgentsParallel(
  tasks: Array<Omit<SpawnOptions, 'onStep'>>,
  onResult?: (result: SpawnResult) => void,
): Promise<SpawnResult[]> {
  const results = await Promise.allSettled(
    tasks.map(t => spawnAgent(t).then((r) => { onResult?.(r); return r; })),
  );
  return results.map(r =>
    r.status === 'fulfilled' ? r.value : {
      agentId: 'unknown',
      agentName: 'unknown',
      success: false,
      result: '',
      error: String((r as any).reason?.message ?? r),
      durationMs: 0,
    });
}

/**
 * Spawns multiple agents sequentially, passing each result to the next.
 * Use this for pipeline workflows: research -> write -> review.
 */
export async function spawnAgentsPipeline(
  stages: Array<{
    agentId: string;
    taskBuilder: (previousResult: string) => string;
    maxSteps?: number;
  }>,
): Promise<SpawnResult[]> {
  const results: SpawnResult[] = [];
  let lastResult = '';

  for (const stage of stages) {
    const task = stage.taskBuilder(lastResult);
    const result = await spawnAgent({
      agentId: stage.agentId,
      task,
      maxSteps: stage.maxSteps,
      context: lastResult ? `Previous stage output:\n${lastResult}` : undefined,
    });
    results.push(result);
    lastResult = result.result;
    if (!result.success) break; // stop pipeline on failure
  }

  return results;
}
