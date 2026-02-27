/**
 * preempt-watchdog.ts
 *
 * Races a generation call against a stall timer.
 * When the timer wins, the generation result is discarded and the caller
 * receives a PreemptResult so it can kill Ollama and trigger rescue.
 *
 * Only active when multi-agent-orchestrator skill is enabled
 * and primary provider is ollama.
 */

export type WatchdogOutcome<T> =
  | { timedOut: false; result: T }
  | { timedOut: true; elapsedMs: number };

/**
 * Race a promise against a stall threshold.
 * If the promise resolves before the threshold, returns { timedOut: false, result }.
 * If the threshold fires first, returns { timedOut: true, elapsedMs }.
 * The underlying promise is NOT cancelled — Ollama will keep running internally.
 * The caller is responsible for killing the process.
 */
export async function raceWithWatchdog<T>(
  generationPromise: Promise<T>,
  stallThresholdMs: number,
  onStallWarning?: (elapsedMs: number) => void,
): Promise<WatchdogOutcome<T>> {
  const start = Date.now();

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<{ timedOut: true; elapsedMs: number }>(resolve => {
    timeoutId = setTimeout(() => {
      const elapsed = Date.now() - start;
      if (onStallWarning) onStallWarning(elapsed);
      resolve({ timedOut: true, elapsedMs: elapsed });
    }, stallThresholdMs);
  });

  const wrappedGeneration = generationPromise.then(
    (result): WatchdogOutcome<T> => ({ timedOut: false, result }),
  );

  const outcome = await Promise.race([wrappedGeneration, timeoutPromise]);

  if (timeoutId !== null) clearTimeout(timeoutId);

  return outcome;
}

/**
 * Preempt state tracker — enforces per-turn and per-session caps.
 */
export class PreemptState {
  preemptsThisTurn = 0;
  preemptsThisSession = 0;
  lastPreemptRound = -99;

  canPreempt(
    round: number,
    maxPerTurn: number,
    maxPerSession: number,
    cooldownRounds: number = 2,
  ): boolean {
    if (this.preemptsThisTurn >= maxPerTurn) return false;
    if (this.preemptsThisSession >= maxPerSession) return false;
    if (round - this.lastPreemptRound < cooldownRounds) return false;
    return true;
  }

  recordPreempt(round: number): void {
    this.preemptsThisTurn++;
    this.preemptsThisSession++;
    this.lastPreemptRound = round;
  }

  resetTurn(): void {
    this.preemptsThisTurn = 0;
  }
}
