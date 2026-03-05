/**
 * task-self-healer.ts
 *
 * Self-healing layer for background task execution.
 *
 * Sits between "something went wrong / task finished" and "bother the user".
 * Makes one AI call to inspect what actually happened, then returns a
 * structured decision so the runner can act autonomously instead of
 * immediately surfacing an error.
 *
 * TWO call sites in background-task-runner.ts:
 *
 *   1. ERROR PATH — called instead of _pauseForAssistance() on first failure.
 *      The healer decides:
 *        • FORCE_COMPLETE  – AI produced a real answer, just mark done & deliver it
 *        • RESUME_WITH_HINT – mismatched plan steps, retry with corrected prompt
 *        • ESCALATE        – true error, needs user (only after MAX_HEAL_ATTEMPTS)
 *
 *   2. COMPLETION PATH — called after the synthesis round, before _deliverToChannel().
 *      The healer verifies:
 *        • DELIVER  – message is good, send it
 *        • RESYNTH  – message is incomplete/wrong, ask for one more synthesis round
 *        • DELIVER_ANYWAY – resynth failed or we're past patience, send what we have
 */

import { getOrchestrationConfig } from '../orchestration/multi-agent';
import { contentToString } from '../providers/content-utils';
import type { TaskRecord, TaskJournalEntry } from './task-store';

// ─── Public constants ──────────────────────────────────────────────────────────

/** How many self-heal attempts before we give up and alert the user. */
export const MAX_HEAL_ATTEMPTS = 2;

// ─── Decision types ────────────────────────────────────────────────────────────

export type ErrorHealDecision =
  | { action: 'FORCE_COMPLETE'; message: string; reasoning: string }
  | { action: 'RESUME_WITH_HINT'; hint: string; newStepDescription?: string; reasoning: string }
  | { action: 'ESCALATE'; reasoning: string };

export type CompletionVerifyDecision =
  | { action: 'DELIVER'; message: string; reasoning: string }
  | { action: 'RESYNTH'; hint: string; reasoning: string }
  | { action: 'DELIVER_ANYWAY'; message: string; reasoning: string };

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseJsonObject(raw: string): any | null {
  const clean = String(raw || '').replace(/```json|```/g, '').trim();
  if (!clean) return null;
  try { return JSON.parse(clean); } catch { return null; }
}

async function buildSecondaryProvider(): Promise<{ provider: any; config: any } | null> {
  const config = getOrchestrationConfig();
  if (!config) return null;
  try {
    const { buildProviderById } = await import('../providers/factory');
    const provider = buildProviderById(config.secondary.provider);
    return { provider, config };
  } catch (err: any) {
    console.error('[SelfHealer] Failed to build secondary provider:', err.message);
    return null;
  }
}

function buildJournalSummary(journal: TaskJournalEntry[], maxEntries = 15): string {
  return journal
    .slice(-maxEntries)
    .map(e => `[${e.type}] ${e.content}${e.detail ? ` | ${e.detail.slice(0, 120)}` : ''}`)
    .join('\n');
}

function buildPlanSummary(task: TaskRecord): string {
  return task.plan
    .map((s, i) => `  Step ${i} [${s.status}]: ${s.description}`)
    .join('\n');
}

// ─── ERROR HEALER ──────────────────────────────────────────────────────────────

const ERROR_HEALER_SYSTEM = `You are a background task self-healing agent.

A background task has failed its step verification. Your job is to decide what ACTUALLY happened
and choose the best recovery path — WITHOUT involving the user unless absolutely necessary.

You will receive:
- The original task prompt (what the user asked for)
- The execution plan (the steps the task was supposed to follow)
- The recent process journal (what the AI actually did — tool calls, results, notes)
- The AI's last produced text (the answer it generated before failing)
- The failure reason (why the auditor rejected the step)

YOUR DECISION — choose exactly one:

1. FORCE_COMPLETE — Use this when the AI clearly produced a correct, complete answer that satisfies
   the user's original request, but the step verifier rejected it because the plan steps were 
   mismatched or irrelevant (e.g. steps said "check inbox" but task was actually "send reminder").
   In this case: extract or rewrite the best final message from the AI's output and deliver it.
   The task should be marked complete.

2. RESUME_WITH_HINT — Use this when the work is genuinely incomplete but the AI was headed in
   the right direction. Provide a corrected hint/instruction and optionally a corrected step
   description so the next round can succeed. The task will continue.

3. ESCALATE — Use this ONLY when there is a genuine blocker the AI cannot resolve:
   missing credentials, a real API error, a tool that is fundamentally broken,
   or the task has already tried to self-heal multiple times.
   Do NOT use ESCALATE just because a plan step description was wrong.

Return ONLY valid JSON:
{
  "action": "FORCE_COMPLETE" | "RESUME_WITH_HINT" | "ESCALATE",
  "reasoning": "one concise sentence explaining your decision",
  // for FORCE_COMPLETE:
  "message": "the complete, polished final response to deliver to the user",
  // for RESUME_WITH_HINT:
  "hint": "specific corrected instruction for the next round",
  "newStepDescription": "optional — rewritten step description that better matches what the AI is actually doing",
  // for ESCALATE: no extra fields needed
}

Rules:
- Prefer FORCE_COMPLETE when the AI's output text is already a good final answer
- Prefer RESUME_WITH_HINT when the task has real work left to do  
- ESCALATE is the last resort — only after genuine failures or repeated heal attempts
- Return JSON only — no prose, no markdown code fences`;

/**
 * Called on the error path instead of immediately pausing for user assistance.
 * Returns a structured decision the runner can act on.
 */
export async function callErrorHealer(input: {
  task: TaskRecord;
  failureReason: string;
  failureDetail: string;
  lastResultText: string;
  healAttempt: number;
}): Promise<ErrorHealDecision> {
  // Hard limit: if we've already tried healing MAX times, escalate unconditionally
  if (input.healAttempt >= MAX_HEAL_ATTEMPTS) {
    return {
      action: 'ESCALATE',
      reasoning: `Self-heal limit reached (${input.healAttempt}/${MAX_HEAL_ATTEMPTS}). Escalating to user.`,
    };
  }

  const built = await buildSecondaryProvider();
  if (!built) {
    // No secondary model available — fall back to single resume attempt
    console.warn('[SelfHealer] No secondary provider available, using fallback decision');
    return {
      action: 'RESUME_WITH_HINT',
      hint: 'The step verification failed. Focus on completing the original user request directly and write_note your findings.',
      reasoning: 'Secondary provider unavailable — issuing generic retry hint.',
    };
  }

  const { provider, config } = built;

  const prompt = `ORIGINAL TASK PROMPT:
"${input.task.prompt.slice(0, 400)}"

EXECUTION PLAN:
${buildPlanSummary(input.task)}
Current step index: ${input.task.currentStepIndex}

RECENT PROCESS JOURNAL (latest first):
${buildJournalSummary(input.task.journal, 20)}

AI'S LAST PRODUCED TEXT:
${input.lastResultText.slice(0, 1200) || '(none — AI produced no output)'}

FAILURE REASON:
${input.failureReason}
${input.failureDetail ? `FAILURE DETAIL:\n${input.failureDetail.slice(0, 400)}` : ''}

SELF-HEAL ATTEMPT: ${input.healAttempt + 1} of ${MAX_HEAL_ATTEMPTS}

Decide the recovery action. Return JSON only.`;

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: ERROR_HEALER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 600 },
    );

    const raw = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(raw);
    if (!parsed || !parsed.action) {
      console.warn('[SelfHealer] Error healer returned unparseable JSON:', raw.slice(0, 200));
      return {
        action: 'RESUME_WITH_HINT',
        hint: 'Complete the task directly based on the original request.',
        reasoning: 'Healer response was unparseable — issuing generic retry hint.',
      };
    }

    const action = String(parsed.action || '').toUpperCase();
    const reasoning = String(parsed.reasoning || '').slice(0, 300);

    if (action === 'FORCE_COMPLETE') {
      const message = String(parsed.message || input.lastResultText || '').trim();
      if (!message) {
        // Can't force complete with no message — resume instead
        return {
          action: 'RESUME_WITH_HINT',
          hint: 'Produce a complete final response to the user\'s request and write_note your findings.',
          reasoning: 'FORCE_COMPLETE requested but no message was available — retrying.',
        };
      }
      return { action: 'FORCE_COMPLETE', message, reasoning };
    }

    if (action === 'RESUME_WITH_HINT') {
      return {
        action: 'RESUME_WITH_HINT',
        hint: String(parsed.hint || 'Complete the task step and write_note findings.').slice(0, 500),
        newStepDescription: parsed.newStepDescription
          ? String(parsed.newStepDescription).slice(0, 200)
          : undefined,
        reasoning,
      };
    }

    // Default: ESCALATE
    return { action: 'ESCALATE', reasoning };

  } catch (err: any) {
    console.error('[SelfHealer] Error healer call failed:', err.message);
    return {
      action: 'RESUME_WITH_HINT',
      hint: 'Complete the task directly.',
      reasoning: `Healer call threw: ${err.message.slice(0, 100)}`,
    };
  }
}

// ─── COMPLETION VERIFIER ───────────────────────────────────────────────────────

const COMPLETION_VERIFIER_SYSTEM = `You are a background task completion verifier.

A background task has finished all its planned steps and produced a final response.
Your job is to verify that the response is actually complete and correct before it is
delivered to the user.

You will receive:
- The original task prompt (what the user asked for)  
- The final response the AI produced
- A summary of what steps were taken

YOUR DECISION — choose exactly one:

1. DELIVER — The response correctly and completely answers the user's original request.
   Use this whenever the response is genuinely useful, even if it could be marginally improved.
   
2. RESYNTH — The response is clearly incomplete, cut off, or misses the point of the request.
   Only use this when there is a meaningful gap. Provide a specific hint for re-synthesis.
   
3. DELIVER_ANYWAY — The response is imperfect but good enough, and we should not waste
   another round on it. Use this if RESYNTH was already attempted or the response has real content.

Return ONLY valid JSON:
{
  "action": "DELIVER" | "RESYNTH" | "DELIVER_ANYWAY",
  "reasoning": "one concise sentence",
  // for DELIVER and DELIVER_ANYWAY:
  "message": "the final message to deliver — can be the original or a lightly cleaned version",
  // for RESYNTH:
  "hint": "specific instruction to improve the synthesis"
}

Rules:
- If the response has actual content that addresses the request, prefer DELIVER
- Do NOT nitpick style or length — only fail responses that are genuinely broken/empty
- Return JSON only`;

/**
 * Called after the synthesis round completes, before delivering to the user.
 * Verifies the final output is actually good before it goes to chat/Telegram.
 */
export async function callCompletionVerifier(input: {
  task: TaskRecord;
  finalMessage: string;
  resynthAttempt: number;
}): Promise<CompletionVerifyDecision> {
  // After one resynth attempt, just deliver whatever we have
  if (input.resynthAttempt >= 1) {
    return {
      action: 'DELIVER_ANYWAY',
      message: input.finalMessage,
      reasoning: 'Already attempted re-synthesis — delivering existing output.',
    };
  }

  // If the message is clearly empty/broken, ask for a resynth immediately
  if (!input.finalMessage || input.finalMessage.trim().length < 20) {
    return {
      action: 'RESYNTH',
      hint: 'The response was empty or too short. Produce a complete answer to the original request.',
      reasoning: 'Final message was empty or too short to deliver.',
    };
  }

  const built = await buildSecondaryProvider();
  if (!built) {
    // No secondary available — just deliver
    return {
      action: 'DELIVER',
      message: input.finalMessage,
      reasoning: 'No secondary provider — delivering without verification.',
    };
  }

  const { provider, config } = built;

  const completedSteps = input.task.plan
    .filter(s => s.status === 'done' || s.status === 'skipped')
    .map(s => `  ✓ ${s.description}${s.notes ? `: ${s.notes.slice(0, 100)}` : ''}`)
    .join('\n');

  const prompt = `ORIGINAL TASK PROMPT:
"${input.task.prompt.slice(0, 400)}"

COMPLETED STEPS:
${completedSteps || '(no steps recorded)'}

FINAL RESPONSE TO VERIFY:
${input.finalMessage.slice(0, 1500)}

Does this response correctly and completely address the original task prompt?
Return JSON only.`;

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: COMPLETION_VERIFIER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 400 },
    );

    const raw = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(raw);
    if (!parsed || !parsed.action) {
      return {
        action: 'DELIVER',
        message: input.finalMessage,
        reasoning: 'Verifier response was unparseable — delivering as-is.',
      };
    }

    const action = String(parsed.action || '').toUpperCase();
    const reasoning = String(parsed.reasoning || '').slice(0, 300);

    if (action === 'RESYNTH') {
      return {
        action: 'RESYNTH',
        hint: String(parsed.hint || 'Improve the final response to better address the original request.').slice(0, 500),
        reasoning,
      };
    }

    // DELIVER or DELIVER_ANYWAY — use healer's message if it cleaned it up, else original
    const message = (parsed.message && String(parsed.message).trim().length > 20)
      ? String(parsed.message).slice(0, 4000)
      : input.finalMessage;

    return {
      action: action === 'DELIVER_ANYWAY' ? 'DELIVER_ANYWAY' : 'DELIVER',
      message,
      reasoning,
    };

  } catch (err: any) {
    console.error('[SelfHealer] Completion verifier call failed:', err.message);
    return {
      action: 'DELIVER',
      message: input.finalMessage,
      reasoning: `Verifier threw: ${err.message.slice(0, 100)} — delivering as-is.`,
    };
  }
}
