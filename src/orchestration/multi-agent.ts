/**
 * multi-agent.ts
 *
 * Dual-model orchestration: advisor / executor split.
 *
 * PRIMARY model (active llm.provider) does all tool calls.
 * SECONDARY model is advisory only and returns structured guidance that is
 * injected as hidden runtime context into the primary's next step.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { getConfig } from '../config/config';
import type { LLMProvider } from '../providers/LLMProvider';
import { contentToString } from '../providers/content-utils';

export type PreflightMode = 'off' | 'complex_only' | 'always';

export interface SecondaryProfile {
  provider: string;
  model: string;
}

export interface OrchestrationConfig {
  enabled: boolean;
  secondary: SecondaryProfile;
  triggers: {
    consecutive_failures: number;
    stagnation_rounds: number;
    loop_detection: boolean;
    risky_files_threshold: number;
    risky_tool_ops_threshold: number;
    no_progress_seconds: number;
  };
  preflight: {
    mode: PreflightMode;
    allow_secondary_chat: boolean;
  };
  limits: {
    assist_cooldown_rounds: number;
    max_assists_per_turn: number;
    max_assists_per_session: number;
    telemetry_history_limit: number;
  };
  browser: {
    max_advisor_calls_per_turn: number;
    max_collected_items: number;
    max_forced_retries: number;
    min_feed_items_before_answer: number;
  };
  file_ops: {
    enabled: boolean;
    primary_create_max_lines: number;
    primary_create_max_chars: number;
    primary_edit_max_lines: number;
    primary_edit_max_chars: number;
    primary_edit_max_files: number;
    verify_create_always: boolean;
    verify_large_payload_lines: number;
    verify_large_payload_chars: number;
    watchdog_no_progress_cycles: number;
    checkpointing_enabled: boolean;
  };
}

const VALID_PREFLIGHT_MODES: Set<PreflightMode> = new Set(['off', 'complex_only', 'always']);

function normalizePreflightMode(value: any): PreflightMode {
  const mode = String(value || '').trim() as PreflightMode;
  return VALID_PREFLIGHT_MODES.has(mode) ? mode : 'complex_only';
}

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Authoritative clamp utility for orchestration config fields.
 * Single source of truth — imported by server-v2.ts so bounds can never silently diverge.
 */
export function clampOrchestrationConfig(raw: any): Omit<OrchestrationConfig, 'enabled' | 'secondary'> {
  const oc = raw || {};
  return {
    triggers: {
      consecutive_failures: clampInt(oc.triggers?.consecutive_failures, 1, 8, 2),
      stagnation_rounds: clampInt(oc.triggers?.stagnation_rounds, 1, 12, 3),
      loop_detection: oc.triggers?.loop_detection !== false,
      risky_files_threshold: clampInt(oc.triggers?.risky_files_threshold, 1, 30, 6),
      risky_tool_ops_threshold: clampInt(oc.triggers?.risky_tool_ops_threshold, 10, 2000, 220),
      no_progress_seconds: clampInt(oc.triggers?.no_progress_seconds, 15, 600, 90),
    },
    preflight: {
      mode: normalizePreflightMode(oc.preflight?.mode),
      allow_secondary_chat: oc.preflight?.allow_secondary_chat === true,
    },
    limits: {
      assist_cooldown_rounds: clampInt(oc.limits?.assist_cooldown_rounds, 1, 12, 3),
      max_assists_per_turn: clampInt(oc.limits?.max_assists_per_turn, 1, 12, 3),
      max_assists_per_session: clampInt(oc.limits?.max_assists_per_session, 1, 100, 18),
      telemetry_history_limit: clampInt(oc.limits?.telemetry_history_limit, 10, 500, 100),
    },
    browser: {
      max_advisor_calls_per_turn: clampInt(oc.browser?.max_advisor_calls_per_turn, 1, 12, 5),
      max_collected_items: clampInt(oc.browser?.max_collected_items, 12, 240, 80),
      max_forced_retries: clampInt(oc.browser?.max_forced_retries, 0, 6, 2),
      min_feed_items_before_answer: clampInt(oc.browser?.min_feed_items_before_answer, 1, 60, 12),
    },
    file_ops: {
      enabled: oc.file_ops?.enabled !== false,
      primary_create_max_lines: clampInt(oc.file_ops?.primary_create_max_lines, 20, 400, 80),
      primary_create_max_chars: clampInt(oc.file_ops?.primary_create_max_chars, 800, 40000, 3500),
      primary_edit_max_lines: clampInt(oc.file_ops?.primary_edit_max_lines, 1, 80, 12),
      primary_edit_max_chars: clampInt(oc.file_ops?.primary_edit_max_chars, 100, 8000, 800),
      primary_edit_max_files: clampInt(oc.file_ops?.primary_edit_max_files, 1, 8, 1),
      verify_create_always: oc.file_ops?.verify_create_always !== false,
      verify_large_payload_lines: clampInt(oc.file_ops?.verify_large_payload_lines, 5, 400, 25),
      verify_large_payload_chars: clampInt(oc.file_ops?.verify_large_payload_chars, 200, 50000, 1200),
      watchdog_no_progress_cycles: clampInt(oc.file_ops?.watchdog_no_progress_cycles, 2, 8, 3),
      checkpointing_enabled: oc.file_ops?.checkpointing_enabled !== false,
    },
  };
}

export function clampPreemptConfig(raw: any): {
  stall_threshold_seconds: number;
  max_preempts_per_turn: number;
  max_preempts_per_session: number;
  restart_mode: 'inherit_console' | 'detached_hidden';
  enabled: boolean;
} {
  const p = raw || {};
  const restartModeRaw = String(p.restart_mode || '').trim();
  const restartMode: 'inherit_console' | 'detached_hidden' =
    restartModeRaw === 'inherit_console' || restartModeRaw === 'detached_hidden'
      ? restartModeRaw
      : (typeof process !== 'undefined' && process.platform === 'win32' ? 'inherit_console' : 'detached_hidden');
  return {
    enabled: p.enabled === true,
    stall_threshold_seconds: clampInt(p.stall_threshold_seconds, 10, 300, 45),
    max_preempts_per_turn: clampInt(p.max_preempts_per_turn, 1, 3, 1),
    max_preempts_per_session: clampInt(p.max_preempts_per_session, 1, 10, 3),
    restart_mode: restartMode,
  };
}

export function getOrchestrationConfig(): OrchestrationConfig | null {
  const raw = getConfig().getConfig() as any;
  const oc = raw.orchestration;
  if (!oc?.secondary?.provider || !oc?.secondary?.model) return null;
  const clamped = clampOrchestrationConfig(oc);

  return {
    enabled: !!oc.enabled,
    secondary: {
      provider: String(oc.secondary.provider || '').trim(),
      model: String(oc.secondary.model || '').trim(),
    },
    ...clamped,
  };
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

function getConfigDir(): string {
  const project = path.join(process.cwd(), '.localclaw');
  const home = path.join(os.homedir(), '.localclaw');
  return fs.existsSync(project) ? project : home;
}

export async function checkOrchestrationEligibility(): Promise<EligibilityResult> {
  const raw = getConfig().getConfig() as any;
  const primaryProvider = raw.llm?.provider || 'ollama';
  if (!raw.llm?.providers?.[primaryProvider]) {
    return { eligible: false, reason: 'Primary provider not configured in Settings -> Models.' };
  }

  const secondary = raw.orchestration?.secondary;
  if (!secondary?.provider || !secondary?.model) {
    return { eligible: false, reason: 'Secondary model not configured in Settings -> Models -> Orchestration.' };
  }

  const primaryModel = raw.llm?.providers?.[primaryProvider]?.model;
  if (secondary.provider === primaryProvider && secondary.model === primaryModel) {
    return { eligible: false, reason: 'Secondary must be a different model than primary.' };
  }

  if (secondary.provider === 'openai_codex') {
    const tokenPath = path.join(getConfigDir(), 'credentials', 'oauth-openai.json');
    if (!fs.existsSync(tokenPath)) {
      return { eligible: false, reason: 'Secondary is ChatGPT but no OAuth token found - connect your account first.' };
    }
  }

  if (secondary.provider === 'openai') {
    if (!raw.llm?.providers?.openai?.api_key) {
      return { eligible: false, reason: 'Secondary is OpenAI but no API key configured.' };
    }
  }

  return { eligible: true };
}

function looksLikeSimpleBrowserAutomation(userMessage: string): boolean {
  const text = String(userMessage || '');
  const hasBrowserVerb = /\b(open|go to|navigate|visit|browse|click|type|fill|press|submit|use my computer)\b/i.test(text);
  const hasTarget = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/i.test(text)
    || /\b(chatgpt|google|reddit|x\.com|twitter|github|youtube)\b/i.test(text);
  return text.length <= 260 && hasBrowserVerb && hasTarget;
}

function looksGenericExecutorObjective(text: string): boolean {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (t.length < 40) return true;
  return /\b(requested message|requested text|requested action|as requested|the requested|user request|user asked)\b/i.test(t);
}

function buildFallbackExecutorObjective(userMessage: string, quickPlan: string[], toolHints: string[]): string {
  const literalRequest = String(userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
  const lines: string[] = [
    'Execute the user request exactly as written. Preserve literal text, URLs, names, and numbers.',
  ];
  if (literalRequest) lines.push(`Literal user request: ${literalRequest}`);
  if (quickPlan.length) lines.push(`Plan: ${quickPlan.slice(0, 3).join(' -> ')}`);
  if (toolHints.length) lines.push(`Preferred tools: ${toolHints.slice(0, 4).join(' | ')}`);
  return lines.join('\n');
}

export function shouldRunPreflight(userMessage: string, mode: PreflightMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // In complex_only mode, keep direct local browser automation requests fast and deterministic:
  // let the primary execute tools directly instead of routing through preflight.
  if (looksLikeSimpleBrowserAutomation(userMessage)) return false;

  // complex_only heuristic tuned for 4B assistance:
  // longer prompts, coding/edit/search terms, or multiline asks.
  const text = String(userMessage || '');
  const lower = text.toLowerCase();
  if (text.length >= 120) return true;
  if (text.includes('\n')) return true;

  return /\b(plan|spec|checklist|refactor|debug|fix|error|stack|search|web|browse|tool|edit|file|code|implement|oauth|api|endpoint|config|settings|migration)\b/i.test(lower);
}

export class OrchestrationTriggerState {
  consecutiveFailures = 0;
  stagnantRounds = 0;
  lastProgressRound = -1;
  lastProgressAtMs = Date.now();
  recentToolSignatures: string[] = [];
  lastAssistRound = -99;
  assistCountThisTurn = 0;
  riskyEditOps = 0;
  touchedFiles: Set<string> = new Set();

  recordToolResult(round: number, toolName: string, args: any, error: boolean) {
    if (error) {
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 0;
      this.lastProgressRound = round;
      this.lastProgressAtMs = Date.now();
      this.stagnantRounds = 0;
      this.trackEditRisk(toolName, args);
    }

    const sig = `${toolName}:${JSON.stringify(args).slice(0, 80)}`;
    this.recentToolSignatures.push(sig);
    if (this.recentToolSignatures.length > 8) this.recentToolSignatures.shift();
  }

  recordRoundNoProgress(round: number) {
    if (this.lastProgressRound < round) this.stagnantRounds++;
  }

  shouldTrigger(
    cfg: OrchestrationConfig,
    round: number,
    nowMs: number = Date.now(),
    sessionAssistCount: number = 0,
  ): { fire: boolean; reason: string } {
    if (this.assistCountThisTurn >= cfg.limits.max_assists_per_turn) {
      return { fire: false, reason: 'turn assist cap reached' };
    }
    if (sessionAssistCount >= cfg.limits.max_assists_per_session) {
      return { fire: false, reason: 'session assist cap reached' };
    }
    if (round - this.lastAssistRound < cfg.limits.assist_cooldown_rounds) {
      return { fire: false, reason: 'cooldown' };
    }
    if (this.consecutiveFailures >= cfg.triggers.consecutive_failures) {
      return { fire: true, reason: `${this.consecutiveFailures} consecutive tool failures` };
    }
    if (cfg.triggers.loop_detection && this.detectLoop()) {
      return { fire: true, reason: 'repeated tool-call loop detected' };
    }
    if (this.touchedFiles.size >= cfg.triggers.risky_files_threshold) {
      return { fire: true, reason: `risky edit scope: ${this.touchedFiles.size} files touched` };
    }
    if (this.riskyEditOps >= cfg.triggers.risky_tool_ops_threshold) {
      return { fire: true, reason: `risky edit volume: ~${this.riskyEditOps} line-ops` };
    }
    if (this.stagnantRounds >= cfg.triggers.stagnation_rounds) {
      return { fire: true, reason: `stalled for ${this.stagnantRounds} rounds with no progress` };
    }
    const noProgressForMs = nowMs - this.lastProgressAtMs;
    if (noProgressForMs >= cfg.triggers.no_progress_seconds * 1000) {
      return { fire: true, reason: `no progress for ${Math.floor(noProgressForMs / 1000)}s` };
    }
    return { fire: false, reason: '' };
  }

  markFired(round: number) {
    this.lastAssistRound = round;
    this.assistCountThisTurn++;
    this.consecutiveFailures = 0;
    this.stagnantRounds = 0;
  }

  private trackEditRisk(toolName: string, args: any): void {
    const filename = String(args?.filename || args?.name || '').trim();
    if (filename) this.touchedFiles.add(filename);

    switch (toolName) {
      case 'create_file':
      case 'delete_file':
      case 'find_replace':
        this.riskyEditOps += 1;
        break;
      case 'replace_lines':
      case 'delete_lines': {
        const start = Math.max(1, Math.floor(Number(args?.start_line) || 1));
        const end = Math.max(start, Math.floor(Number(args?.end_line) || start));
        this.riskyEditOps += Math.max(1, end - start + 1);
        break;
      }
      case 'insert_after': {
        const inserted = String(args?.content || '').split('\n').length;
        this.riskyEditOps += Math.max(1, inserted);
        break;
      }
      default:
        break;
    }
  }

  private detectLoop(): boolean {
    const sigs = this.recentToolSignatures;
    if (sigs.length < 4) return false;
    const last4 = sigs.slice(-4);
    return last4[0] === last4[2] && last4[1] === last4[3];
  }
}

export interface AdvisoryResult {
  mode: 'planner' | 'rescue';
  next_actions: string[];
  stop_doing: string[];
  hints: string[];
  risk_note: string;
  raw_response?: string;
  task_plan: string[];
  checkpoints: string[];
  exact_files: string[];
  success_criteria: string[];
  verification_checklist: string[];
  search_queries: string[];
  tool_sequence: string[];
}

export interface SecondaryAssistContext {
  availableTools?: string[];
  recentToolExecutions?: Array<{
    step?: number;
    name?: string;
    args?: any;
    result?: string;
    error?: boolean;
  }>;
  recentModelMessages?: Array<{
    role?: string;
    content?: string;
  }>;
  recentProcessNotes?: string[];
  latestBrowserSnapshot?: string;
  latestDesktopSnapshot?: string;
}

export interface SecondaryFileAnalysisResult {
  summary: string;
  diagnosis: string;
  exact_files: string[];
  edit_plan: string[];
}

export interface SecondaryFilePatchPlan {
  strategy: 'patch' | 'regenerate';
  tool_calls: Array<{ tool: string; args: Record<string, any> }>;
  estimated_lines_changed: number;
  estimated_chars: number;
  files_touched: number;
  rationale: string;
  raw_response?: string;
}

export interface SecondaryFileVerifierFinding {
  filename?: string;
  type?: string;
  location_hint?: {
    start_line?: number;
    end_line?: number;
  };
  expected?: string;
  observed?: string;
}

export interface SecondaryFileVerifierResult {
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
  findings: SecondaryFileVerifierFinding[];
  suggested_fix: {
    estimated_lines_changed: number;
    estimated_chars: number;
    files_touched: number;
  };
  raw_response?: string;
}

export interface SecondaryFileOpClassificationResult {
  operation: 'FILE_ANALYSIS' | 'FILE_CREATE' | 'FILE_EDIT' | 'BROWSER_OP' | 'DESKTOP_OP' | 'CHAT';
  reason: string;
  confidence: number;
  raw_response?: string;
}

const RESCUE_ADVISOR_SYSTEM = `You are a senior AI rescue advisor. Another AI (the executor) is stuck and needs recovery guidance.

Return ONLY a JSON object - no markdown, no explanation:
{
  "mode": "rescue",
  "next_actions": ["step 1", "step 2", "step 3"],
  "stop_doing": ["what to stop"],
  "hints": ["exact search query", "file path", "tool arg hint"],
  "risk_note": "warning or empty string",
  "task_plan": [],
  "checkpoints": [],
  "exact_files": [],
  "success_criteria": [],
  "verification_checklist": [],
  "search_queries": [],
  "tool_sequence": []
}

Rules:
- next_actions: max 5 items, each under 90 chars, ordered and specific
- stop_doing: max 3 items
- hints: concrete and actionable, max 6 items
- Return rescue-focused actions only
- Use ONLY tool names listed in AVAILABLE TOOLS from the user prompt.
- Never invent tools that are not listed (example of forbidden invention: browser_find).
- If RECENT TOOL EXECUTIONS includes a snapshot with [@ref] and [INPUT], prefer exact refs and concrete next tool args.
- Return JSON only`;

const PLANNER_ADVISOR_SYSTEM = `You are a senior AI planning advisor for a small 4B local executor model.

Return ONLY a JSON object - no markdown, no explanation:
{
  "mode": "planner",
  "task_plan": ["high-level step 1", "high-level step 2"],
  "checkpoints": ["checkpoint 1", "checkpoint 2"],
  "exact_files": ["path/file1.ts", "path/file2.md"],
  "success_criteria": ["what must be true at the end"],
  "verification_checklist": ["how to verify quickly"],
  "search_queries": ["query 1", "query 2"],
  "tool_sequence": ["read_file(file)", "replace_lines(file,...)"],
  "next_actions": ["immediate next action 1", "action 2"],
  "stop_doing": ["what to avoid"],
  "hints": ["small concrete tip"],
  "risk_note": "warning or empty string"
}

Rules:
- Keep it concise and executable for a small model
- task_plan max 6 items
- checkpoints max 6 items
- exact_files max 8 items
- success_criteria max 6 items
- verification_checklist max 6 items
- search_queries max 6 items
- tool_sequence max 8 items
- next_actions max 5 items
- Use precise file/tool hints over vague advice
- Return JSON only`;

const BROWSER_ADVISOR_SYSTEM = `You are a browser research advisor for a local executor AI.

You receive structured browser data extracted from the page. The PRIMARY executor model does NOT see the raw snapshot — only your guidance. You decide what it should do next.

Return ONLY JSON:
{
  "route": "answer_now" | "continue_browser" | "collect_more" | "handoff_primary",
  "reason": "short reason",
  "answer": "only when route=answer_now, else empty",
  "next_tool": {
    "tool": "browser_snapshot | browser_click | browser_fill | browser_press_key | browser_wait | web_fetch",
    "params": {}
  },
  "collect_policy": {
    "scroll_batches": 3,
    "target_count": 20
  },
  "primary_hint": "compact instruction for primary model",
  "evidence_focus": ["key evidence 1", "key evidence 2"]
}

COLLECTION MINIMUMS — enforce these strictly:
- x_feed pages: do NOT route answer_now until total_collected >= MIN_FEED_ITEMS
- search_results pages: do NOT route answer_now until total_collected >= MIN_FEED_ITEMS
- On batch 1 with total_collected < MIN_FEED_ITEMS: ALWAYS route collect_more
- Only route answer_now when total_collected >= MIN_FEED_ITEMS AND the evidence clearly answers the goal
- If unsure whether you have enough: default to collect_more, not answer_now

NON-FEED PAGES (critical):
- For page types other than x_feed/search_results, do NOT enforce MIN_FEED_ITEMS.
- On generic/app pages (example: chatgpt.com composer), NEVER route collect_more just to chase feed items.
- You will receive a PAGE SNAPSHOT section with all interactive elements listed as [@ref] role "name" [INPUT].
- Read the snapshot carefully. Identify the correct @ref number for the element to click or fill.
- Set next_tool.params to use the exact @ref number: {"ref": 4} for browser_click, or {"ref": 12, "text": ".."} for browser_fill.
- NEVER invent CSS selectors or href values. ONLY use @ref numbers from the snapshot.
- If the snapshot already shows actionable controls, route continue_browser with a concrete @ref-based next step.

SCROLL BEHAVIOR for collect_more:
- X/Twitter uses virtual DOM scrolling — old tweets are REMOVED from DOM as you scroll
- Each PageDown loads new tweets; you must extract BEFORE scrolling past them
- The accumulation buffer persists across scroll batches — keep scrolling to build it up
- Suggest browser_press_key with key=PageDown as next_tool when collecting more feed items
- After PageDown, follow with browser_wait(1500) then browser_snapshot to read new batch

ROUTING RULES:
- collect_more: ONLY for x_feed/search_results when feed collection is actually progressing
- continue_browser: need to interact further (click link, fill form, navigate)
- answer_now: total_collected >= minimum AND evidence directly answers the goal
- handoff_primary: page needs complex interaction the primary should decide

AFTER COLLECTION — web_fetch for deep reading:
- After collecting feed items with links, suggest web_fetch on a high-signal URL for full article text
- Use web_fetch when: goal needs article content, tweet links to external article, search result has real data
- Set next_tool.tool="web_fetch" and next_tool.params={"url": "<full url from extracted feed>"}

Rules:
- next_tool must be executable by the primary model; keep params concrete.
- primary_hint tells the primary exactly what to do next — be specific about tool and params.
- Keep answer <= 450 chars.
- primary_hint <= 600 chars.
- evidence_focus max 6 items.
- Return JSON only.`;

const DESKTOP_ADVISOR_SYSTEM = `You are a desktop automation advisor for a local executor AI.

You receive desktop context from a Windows machine (active window + open window titles + OCR text + screenshot metadata).
When the screenshot image is attached, use it directly — you can see UI elements, progress bars, status indicators,
and colour-coded states that OCR may miss. Prioritise what you see in the image over OCR text when they conflict.
The primary executor (a small 4B local model) controls tools directly and must follow your next step exactly.

Return ONLY JSON:
{
  "route": "answer_now" | "continue_desktop" | "handoff_primary",
  "reason": "short reason",
  "answer": "only when route=answer_now, else empty",
  "next_tool": {
    "tool": "desktop_screenshot | desktop_find_window | desktop_focus_window | desktop_click | desktop_drag | desktop_wait | desktop_type | desktop_press_key | desktop_get_clipboard | desktop_set_clipboard",
    "params": {}
  },
  "primary_hint": "compact instruction for primary model",
  "evidence_focus": ["key point 1", "key point 2"]
}

Routing rules:
- answer_now: only when evidence (screenshot image OR OCR OR window state) is sufficient to answer now.
- continue_desktop: when one concrete desktop tool action should run next.
- handoff_primary: when the primary should decide among multiple interaction paths.

Practical constraints:
- If a screenshot image is attached, read it carefully before routing. Look for: terminal output, progress bars,
  error dialogs, VS Code status bar, running/idle indicators, file save states.
- OCR_TEXT is the text extracted from the screenshot via OCR. Use it as a fallback when no image is attached.
- content_hash tells you if the screenshot changed since the last call. If the screen shows no progress and
  the task is not complete, do NOT route answer_now — route continue_desktop with desktop_screenshot to get fresh state.
- If evidence is insufficient to answer status questions (e.g., "is VS Code done?"), route continue_desktop
  with a concrete next step (focus VS Code, screenshot again, or inspect clipboard).
- Never invent tools beyond the allowed desktop tools.
- Keep answer <= 450 chars.
- Keep primary_hint <= 600 chars.
- evidence_focus max 6 items.
- Return JSON only.`;

const FILE_ANALYZER_SYSTEM = `You are a senior code/file analysis assistant.

Return ONLY JSON:
{
  "summary": "short summary",
  "diagnosis": "root issue / key behavior",
  "exact_files": ["path/file1", "path/file2"],
  "edit_plan": ["step 1", "step 2", "step 3"]
}

Rules:
- Focus on analysis only; do not fabricate file contents.
- exact_files max 10
- edit_plan max 8
- Keep summary + diagnosis concrete and short
- Return JSON only`;

const FILE_VERIFIER_SYSTEM = `You verify FILE_CREATE / FILE_EDIT outcomes.

Return ONLY JSON:
{
  "verdict": "PASS" | "FAIL",
  "reasons": ["max 3 short reasons"],
  "findings": [
    {
      "filename": "path/file",
      "type": "MISSING_SECTION|INCORRECT_CONTENT|BROKEN_STRUCTURE|OTHER",
      "location_hint": { "start_line": 1, "end_line": 10 },
      "expected": "what should exist",
      "observed": "what exists now"
    }
  ],
  "suggested_fix": {
    "estimated_lines_changed": 10,
    "estimated_chars": 650,
    "files_touched": 1
  }
}

Rules:
- FAIL only when there is a concrete mismatch with the request.
- findings max 8
- reasons max 3
- suggested_fix must be realistic and non-zero for FAIL.
- Return JSON only`;

const FILE_PATCH_PLANNER_SYSTEM = `You generate executable file patch plans.

Return ONLY JSON:
{
  "strategy": "patch" | "regenerate",
  "tool_calls": [
    { "tool": "create_file|replace_lines|insert_after|delete_lines|find_replace|delete_file|read_file|list_files", "args": {} }
  ],
  "estimated_lines_changed": 10,
  "estimated_chars": 650,
  "files_touched": 1,
  "rationale": "brief why this plan"
}

Arg keys for each tool (use EXACTLY these key names — never use "path" or "file"):
- create_file: { "filename": "name.ext", "content": "full file content" }
- replace_lines: { "filename": "name.ext", "start_line": N, "end_line": N, "new_content": "replacement" }
- insert_after: { "filename": "name.ext", "line": N, "content": "lines to insert" }
- delete_lines: { "filename": "name.ext", "start_line": N, "end_line": N }
- find_replace: { "filename": "name.ext", "find": "exact text", "replace": "new text" }
- delete_file: { "filename": "name.ext" }
- read_file: { "filename": "name.ext" }

Rules:
- Prefer minimal tool calls.
- Use only listed tool names.
- tool_calls max 8.
- Keep args concrete and executable. Never use "path" — always use "filename".
- If strategy is regenerate, include concrete create/replace tool calls.
- Return JSON only`;

const FILE_OP_CLASSIFIER_SYSTEM = `You are a strict runtime operation classifier for a local coding assistant.

Classify this user turn into exactly one operation:
- FILE_ANALYSIS
- FILE_CREATE
- FILE_EDIT
- BROWSER_OP
- DESKTOP_OP
- CHAT

Return ONLY JSON:
{
  "operation": "FILE_ANALYSIS|FILE_CREATE|FILE_EDIT|BROWSER_OP|DESKTOP_OP|CHAT",
  "reason": "short concrete reason",
  "confidence": 0.0
}

Rules:
- FILE_ANALYSIS: analyze/explain/review/debug code or files.
- FILE_CREATE: create/generate/build/make new file/page/template/config/layout/code artifact.
- FILE_EDIT: modify/fix/change existing file content.
- BROWSER_OP: browser automation (open/navigate/click/type/fill websites).
- DESKTOP_OP: desktop automation (screen/window/app focus/click/type/status checks like "is VS Code done?").
- CHAT: anything else.
- confidence must be in 0..1.
- Return JSON only.`;

export interface PreflightResult {
  route: 'primary_direct' | 'primary_with_plan' | 'secondary_chat' | 'background_task';
  reason: string;
  quick_plan: string[];
  search_queries: string[];
  likely_files: string[];
  tool_hints: string[];
  secondary_response: string;
  executor_objective: string;
  risk_note: string;
  // Background task fields (populated when route === 'background_task')
  task_title?: string;
  task_plan?: string[];
  friendly_queued_message?: string;
  raw_response?: string;
}

export interface BrowserAdvisorInput {
  goal: string;
  minFeedItemsBeforeAnswer?: number;
  page: {
    title: string;
    url: string;
    pageType: string;
    snapshotElements?: number;
  };
  extractedFeed?: Array<{
    id?: string;
    author?: string;
    handle?: string;
    time?: string;
    text?: string;
    link?: string;
    title?: string;
    snippet?: string;
    source?: string;
  }>;
  textBlocks?: string[];
  snapshot?: string;
  scrollState?: {
    batch?: number;
    total_collected?: number;
    dedupe_count?: number;
  };
  lastActions?: string[];
  recentFailures?: string[];
  pageText?: string;   // visible body text from page (chat responses, articles)
  isGenerating?: boolean; // true when a chat AI is still streaming
}

export type BrowserAdvisorRoute = 'answer_now' | 'continue_browser' | 'collect_more' | 'handoff_primary';

export interface BrowserAdvisorResult {
  route: BrowserAdvisorRoute;
  reason: string;
  answer: string;
  raw_response?: string;
  next_tool?: {
    tool: string;
    params: Record<string, any>;
  };
  collect_policy?: {
    scroll_batches: number;
    target_count: number;
  };
  primary_hint: string;
  evidence_focus: string[];
}

export interface DesktopAdvisorInput {
  goal: string;
  screenshot: {
    width: number;
    height: number;
    capturedAt: number;
    contentHash: string;
  };
  /**
   * Raw PNG as base64. Optional — only populated when the secondary model is
   * a vision-capable provider (openai, openai_codex). Never sent to Ollama or
   * llama.cpp since small 4B models cannot process images reliably.
   */
  screenshotBase64?: string;
  activeWindow?: {
    processName?: string;
    title?: string;
  };
  openWindows?: Array<{
    processName?: string;
    title?: string;
  }>;
  lastActions?: string[];
  recentFailures?: string[];
  clipboardPreview?: string;
  ocrText?: string;
  ocrConfidence?: number;
}

export type DesktopAdvisorRoute = 'answer_now' | 'continue_desktop' | 'handoff_primary';

export interface DesktopAdvisorResult {
  route: DesktopAdvisorRoute;
  reason: string;
  answer: string;
  raw_response?: string;
  next_tool?: {
    tool: string;
    params: Record<string, any>;
  };
  primary_hint: string;
  evidence_focus: string[];
}

function buildPreflightSystemPrompt(allowSecondaryChat: boolean): string {
  if (!allowSecondaryChat) {
    return `You are the secondary advisor for a small local coding assistant.

Decide routing for this turn and return JSON only:
{
  "route": "primary_direct" | "primary_with_plan" | "background_task",
  "reason": "short reason",
  "quick_plan": ["step 1", "step 2", "step 3"],
  "search_queries": ["query 1", "query 2"],
  "likely_files": ["path/one.ts", "path/two.ts"],
  "tool_hints": ["tool(arg: value)", "tool(arg: value)"],
  "secondary_response": "",
  "executor_objective": "Primary execution objective with exact user literals",
  "risk_note": "warning or empty string",
  "task_title": "Short kanban card title (only for background_task route)",
  "task_plan": ["step 1", "step 2", "step 3"],
  "friendly_queued_message": "Warm 1-2 sentence confirmation (only for background_task route)"
}

Authorization context:
- This app runs locally on the user's own machine.
- Requests to open websites, click, type, and submit in browser tools are user-authorized local automation.
- Do NOT classify normal local browser automation requests as disallowed remote control.

Routing policy — choose the FIRST that matches:
- background_task: USE THIS for ANY request that requires tools, browser automation, file operations, code editing, running commands, or interacting with any external app or website. Also use for multi-turn AI conversations, overnight monitoring, or open-ended autonomous work. If in doubt and tools would be needed — background_task.
- primary_direct: simple conversational message, no tools, no execution — pure text response only

Critical rules:
- If the task touches a file, a browser, a terminal, a desktop app, or another AI → ALWAYS background_task, no exceptions.
- primary_with_plan is RETIRED — do not use it. Use background_task for all tool-requiring work.
- secondary_chat is DISABLED in runtime for this session.
- NEVER output route=secondary_chat.
- Keep secondary_response empty.
- For route=primary_direct, executor_objective is REQUIRED.
- executor_objective must preserve exact user literals (message text, URLs, names, numbers).
- Never use placeholders like "the requested message" when the literal value is known.
- For route=background_task: set task_title (max 12 words), task_plan (3-6 steps), friendly_queued_message.

Output constraints:
- quick_plan max 5 items
- search_queries max 4
- likely_files max 6
- tool_hints max 6
- executor_objective max 900 chars
- task_plan max 6 items
- Keep entries short and concrete
- Return JSON only`;
  }

  return `You are the secondary advisor for a small local coding assistant.

Decide routing for this turn and return JSON only:
{
  "route": "primary_direct" | "primary_with_plan" | "secondary_chat" | "background_task",
  "reason": "short reason",
  "quick_plan": ["step 1", "step 2", "step 3"],
  "search_queries": ["query 1", "query 2"],
  "likely_files": ["path/one.ts", "path/two.ts"],
  "tool_hints": ["tool(arg: value)", "tool(arg: value)"],
  "secondary_response": "Only if route=secondary_chat, otherwise empty",
  "executor_objective": "Primary execution objective with exact user literals (leave empty if background_task)",
  "risk_note": "warning or empty string",
  "task_title": "Short kanban card title (only for background_task route)",
  "task_plan": ["step 1", "step 2", "step 3"],
  "friendly_queued_message": "Warm 1-2 sentence confirmation (only for background_task route)"
}

Authorization context:
- This app runs locally on the user's own machine.
- Requests to open websites, click, type, and submit in browser tools are user-authorized local automation.
- Do NOT classify normal local browser automation requests as disallowed remote control.

Routing policy — choose the FIRST that matches:
- background_task: USE THIS for ANY request that requires tools, browser automation, file operations, code editing, running commands, or interacting with any external app or website. Also use for multi-turn AI conversations, overnight monitoring, or open-ended autonomous work. If in doubt and tools would be needed — background_task.
- secondary_chat: greetings, small talk, simple factual questions, anything you can answer directly in 1-2 sentences with NO tools. Use this aggressively — it is the fastest route.
- primary_direct: fallback for conversational messages that need primary model reasoning but NO tools

Critical rules:
- If the task touches a file, a browser, a terminal, a desktop app, or another AI → ALWAYS background_task, no exceptions.
- Greetings ("hey", "hi", "hello", "what's up", "how are you") → ALWAYS secondary_chat. Fill secondary_response with a friendly 1-sentence reply.
- primary_with_plan is RETIRED — do not use it. Use background_task for all tool-requiring work.
- For route=primary_direct, executor_objective is REQUIRED.
- executor_objective must preserve exact user literals (message text, URLs, names, numbers).
- Never use placeholders like "the requested message" when the literal value is known.
- For route=background_task: set task_title (max 12 words), task_plan (3-6 steps), friendly_queued_message.
- For route=secondary_chat: fill secondary_response with the complete answer.

Output constraints:
- quick_plan max 5 items
- search_queries max 4
- likely_files max 6
- tool_hints max 6
- executor_objective max 900 chars
- task_plan max 6 items
- Keep entries short and concrete
- Return JSON only`;
}

function compactList(values: any, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    const s = String(v || '').trim();
    if (!s) continue;
    out.push(s.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

function compactToolCalls(values: any, maxItems: number = 8): Array<{ tool: string; args: Record<string, any> }> {
  if (!Array.isArray(values)) return [];
  const out: Array<{ tool: string; args: Record<string, any> }> = [];
  const allowed = new Set([
    'create_file',
    'replace_lines',
    'insert_after',
    'delete_lines',
    'find_replace',
    'delete_file',
    'read_file',
    'list_files',
  ]);
  for (const v of values) {
    if (!v || typeof v !== 'object') continue;
    const tool = String((v as any).tool || '').trim();
    if (!allowed.has(tool)) continue;
    const args = (v as any).args && typeof (v as any).args === 'object' ? (v as any).args : {};
    out.push({ tool, args });
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseJsonObject(raw: string): any | null {
  const clean = String(raw || '').replace(/```json|```/g, '').trim();
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function compactBrowserFeedLines(input: BrowserAdvisorInput): string[] {
  const feed = Array.isArray(input.extractedFeed) ? input.extractedFeed : [];
  const lines: string[] = [];
  for (const item of feed.slice(0, 80)) {
    const txt = String(item.text || item.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 320);
    const head = [
      item.author ? `author=${item.author}` : '',
      item.handle ? `handle=${item.handle}` : '',
      item.time ? `time=${item.time}` : '',
      item.title ? `title=${item.title}` : '',
      item.source ? `src=${item.source}` : '',
      item.link ? `link=${item.link}` : '',
    ].filter(Boolean).join(' | ');
    lines.push(`${head}${head && txt ? ' | ' : ''}${txt}`);
  }
  return lines.filter(Boolean);
}

async function summarizeBrowserChunks(
  provider: LLMProvider,
  model: string,
  lines: string[],
): Promise<string[]> {
  const chunkSize = 12;
  const summaries: string[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize);
    const prompt = `Summarize this browser evidence chunk for another AI.
Return JSON only:
{
  "facts": ["f1", "f2", "f3", "f4"],
  "entities": ["entity1", "entity2"],
  "links": ["url1", "url2"]
}

Chunk:
${chunk.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}`;
    try {
      const r = await provider.chat(
        [
          { role: 'system', content: 'You summarize evidence compactly. Return JSON only.' },
          { role: 'user', content: prompt },
        ],
        model,
        { max_tokens: 260 },
      );
      const parsed = parseJsonObject(contentToString(r.message.content));
      if (!parsed) continue;
      const facts = compactList(parsed.facts, 4, 160);
      const entities = compactList(parsed.entities, 3, 80);
      const links = compactList(parsed.links, 2, 180);
      const merged = [
        facts.length ? `facts: ${facts.join(' | ')}` : '',
        entities.length ? `entities: ${entities.join(', ')}` : '',
        links.length ? `links: ${links.join(', ')}` : '',
      ].filter(Boolean).join(' || ');
      if (merged) summaries.push(merged.slice(0, 460));
    } catch {
      // Ignore chunk failures and continue.
    }
    if (summaries.length >= 8) break;
  }
  return summaries;
}

async function buildSecondaryProvider(): Promise<{ provider: LLMProvider; config: OrchestrationConfig } | null> {
  const config = getOrchestrationConfig();
  if (!config) return null;

  let provider: LLMProvider;
  try {
    const { buildProviderById } = await import('../providers/factory');
    provider = buildProviderById(config.secondary.provider);
  } catch (err: any) {
    console.error('[Orchestrator] Failed to build secondary provider:', err.message);
    return null;
  }

  return { provider, config };
}

/**
 * Returns true when the secondary provider is a cloud/OpenAI-family model that
 * supports vision (image_url content parts in /v1/chat/completions).
 *
 * We deliberately exclude Ollama and llama.cpp here — even when those run a
 * vision model, the 4B context window and unreliable image tokenization make
 * screenshot analysis a liability rather than a gain for the desktop advisor.
 * Vision is only worth the token cost when the secondary is the powerful model
 * that can actually reason about the screenshot.
 */
function secondarySupportsVision(config: OrchestrationConfig): boolean {
  const p = config.secondary.provider;
  return p === 'openai' || p === 'openai_codex';
}

export async function callSecondaryPreflight(input: {
  userMessage: string;
  recentHistory?: Array<{ role: string; content: string }>;
}): Promise<PreflightResult | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;
  if (config.preflight.mode === 'off') return null;

  const historyText = (input.recentHistory || [])
    .slice(-4)
    .map((m, i) => `${i + 1}. ${m.role}: ${String(m.content || '').slice(0, 220)}`)
    .join('\n');

  const prompt = `USER MESSAGE:
${String(input.userMessage || '').slice(0, 1800)}

RECENT CONTEXT:
${historyText || '(none)'}

Return routing JSON now.`;

  try {
    const preflightSystem = buildPreflightSystemPrompt(config.preflight.allow_secondary_chat);
    const result = await provider.chat(
      [
        { role: 'system', content: preflightSystem },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 650 },
    );

    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) return null;

    const routeRaw = String(parsed.route || '').trim();
    let route: PreflightResult['route'] =
      routeRaw === 'secondary_chat' || routeRaw === 'primary_with_plan' || routeRaw === 'primary_direct' || routeRaw === 'background_task'
        ? routeRaw as PreflightResult['route']
        : 'primary_with_plan';
    let reason = String(parsed.reason || '').slice(0, 240);
    let quickPlan = compactList(parsed.quick_plan, 5, 120);
    const searchQueries = compactList(parsed.search_queries, 4, 140);
    const likelyFiles = compactList(parsed.likely_files, 6, 180);
    let toolHints = compactList(parsed.tool_hints, 6, 140);
    const secondaryResponse = String(parsed.secondary_response || '').slice(0, 1600);
    let executorObjective = String(parsed.executor_objective || '').slice(0, 2200).trim();
    const riskNote = String(parsed.risk_note || '').slice(0, 220);
    if (!config.preflight.allow_secondary_chat && route === 'secondary_chat') {
      route = 'primary_direct';
      reason = (reason ? `${reason} ` : '') + '(secondary_chat disabled by settings)';
    }

    // Safety-phrase normalization for local browser automation:
    // this runtime is explicitly user-authorized to automate the local browser.
    if (
      looksLikeSimpleBrowserAutomation(input.userMessage)
      && /\b(disallow|disallowed|cannot|can't|unable|not allowed|policy|control (?:their|the) computer)\b/i.test(reason)
    ) {
      route = 'primary_with_plan';
      reason = 'User explicitly authorized local browser automation in this chat.';
      if (!quickPlan.length) {
        quickPlan = [
          'Open the requested URL with browser_open.',
          'Use snapshot/fill/key tools to perform the requested action.',
        ];
      }
      if (!toolHints.length) {
        toolHints = [
          'browser_open(url: "...")',
          'browser_snapshot()',
          'browser_fill(ref: <input>, text: "...")',
          'browser_press_key(key: "Enter")',
        ];
      }
    }

    if (route === 'primary_direct' || route === 'primary_with_plan') {
      if (!executorObjective || looksGenericExecutorObjective(executorObjective)) {
        executorObjective = buildFallbackExecutorObjective(input.userMessage, quickPlan, toolHints);
      }
      const literalRequest = String(input.userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
      if (literalRequest && !executorObjective.includes(literalRequest)) {
        executorObjective = `${executorObjective}\nLiteral user request: ${literalRequest}`.slice(0, 2200);
      }
    }

    // Extract background task fields when route is background_task
    const taskTitle = route === 'background_task' ? String(parsed.task_title || '').slice(0, 120) : undefined;
    const taskPlan = route === 'background_task' ? compactList(parsed.task_plan, 6, 200) : undefined;
    const friendlyQueuedMessage = route === 'background_task' ? String(parsed.friendly_queued_message || '').slice(0, 600) : undefined;

    return {
      route,
      reason: reason.slice(0, 240),
      quick_plan: quickPlan,
      search_queries: searchQueries,
      likely_files: likelyFiles,
      tool_hints: toolHints,
      secondary_response: secondaryResponse,
      executor_objective: executorObjective,
      risk_note: riskNote,
      task_title: taskTitle,
      task_plan: taskPlan,
      friendly_queued_message: friendlyQueuedMessage,
      raw_response: rawResponse.slice(0, 6000),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Preflight call failed:', err.message);
    return null;
  }
}

export async function callSecondaryAdvisor(
  goal: string,
  recentActions: string[],
  triggerReason: string,
  mode: 'planner' | 'rescue',
  browserContext?: {
    active: boolean;
    title?: string;
    url?: string;
    totalCollected?: number;
  },
  assistContext?: SecondaryAssistContext,
): Promise<AdvisoryResult | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;

  const actionsText = recentActions.slice(-6).map((a, i) => `${i + 1}. ${a}`).join('\n');
  const availableToolsText = (assistContext?.availableTools || [])
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 64)
    .join(', ');

  const budgetedJoin = (chunks: string[], maxChars: number): string => {
    let out = '';
    for (const chunk of chunks) {
      const next = chunk.trim();
      if (!next) continue;
      const candidate = out ? `${out}\n\n${next}` : next;
      if (candidate.length > maxChars) break;
      out = candidate;
    }
    return out;
  };

  const recentToolExecutionsText = (() => {
    const rows = (assistContext?.recentToolExecutions || [])
      .slice(-24)
      .map((t, i) => {
        const stepNum = Number.isFinite(Number(t?.step)) ? Math.floor(Number(t?.step)) : (i + 1);
        const toolName = String(t?.name || 'unknown').slice(0, 80);
        let argsText = '';
        try {
          argsText = JSON.stringify(t?.args ?? {});
        } catch {
          argsText = '{}';
        }
        argsText = argsText.slice(0, 420);
        const resultText = String(t?.result || '').replace(/\r/g, '').trim().slice(0, 2200);
        const status = t?.error === true ? 'FAIL' : 'OK';
        return `Step ${stepNum} | ${status} | ${toolName}(${argsText})\nResult:\n${resultText || '(empty)'}`;
      });
    return budgetedJoin(rows, 12000);
  })();

  const recentModelMessagesText = (() => {
    const rows = (assistContext?.recentModelMessages || [])
      .slice(-24)
      .map((m, i) => {
        const role = String(m?.role || 'unknown').slice(0, 30);
        const content = String(m?.content || '').replace(/\r/g, '').trim().slice(0, 1400);
        return `${i + 1}. ${role}: ${content || '(empty)'}`;
      });
    return budgetedJoin(rows, 7000);
  })();

  const recentProcessNotesText = (() => {
    const rows = (assistContext?.recentProcessNotes || [])
      .slice(-24)
      .map((x, i) => `${i + 1}. ${String(x || '').slice(0, 300)}`);
    return budgetedJoin(rows, 2600);
  })();

  const latestBrowserSnapshot = String(assistContext?.latestBrowserSnapshot || '').trim().slice(0, 4500);
  const latestDesktopSnapshot = String(assistContext?.latestDesktopSnapshot || '').trim().slice(0, 4500);

  // Inject live browser state so rescue advisor doesn't suggest re-opening an open browser
  const browserCtxNote = browserContext?.active
    ? `\nACTIVE BROWSER SESSION:\n  URL: ${browserContext.url || 'unknown'}\n  Title: ${browserContext.title || 'unknown'}\n  Feed items collected: ${browserContext.totalCollected ?? 0}\nDo NOT suggest opening a new browser tab. Suggest: browser_snapshot -> continue collecting.\n`
    : '';

  const prompt = `GOAL: ${goal}

WHY I AM BEING CALLED: ${triggerReason}${browserCtxNote ? '\n' + browserCtxNote : ''}

WHAT THE EXECUTOR HAS DONE:
${actionsText || '(no actions yet - executor needs initial plan)'}

AVAILABLE TOOLS (STRICT):
${availableToolsText || '(not provided)'}

RECENT TOOL EXECUTIONS (MOST IMPORTANT):
${recentToolExecutionsText || '(none)'}

LATEST BROWSER SNAPSHOT:
${latestBrowserSnapshot || '(none)'}

LATEST DESKTOP SNAPSHOT:
${latestDesktopSnapshot || '(none)'}

RECENT MODEL / TOOL MESSAGES:
${recentModelMessagesText || '(none)'}

RECENT PROCESS NOTES:
${recentProcessNotesText || '(none)'}

Return guidance JSON now.`;

  try {
    const systemPrompt = mode === 'planner' ? PLANNER_ADVISOR_SYSTEM : RESCUE_ADVISOR_SYSTEM;
    const result = await provider.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: mode === 'planner' ? 950 : 600 },
    );

    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) {
      return {
        mode,
        next_actions: ['Continue carefully with the task.'],
        stop_doing: [],
        hints: rawResponse ? [rawResponse.slice(0, 200)] : [],
        risk_note: '',
        raw_response: rawResponse.slice(0, 6000),
        task_plan: [],
        checkpoints: [],
        exact_files: [],
        success_criteria: [],
        verification_checklist: [],
        search_queries: [],
        tool_sequence: [],
      };
    }

    return {
      mode: parsed.mode === 'planner' || parsed.mode === 'rescue' ? parsed.mode : mode,
      next_actions: compactList(parsed.next_actions, 5, 120),
      stop_doing: compactList(parsed.stop_doing, 3, 120),
      hints: compactList(parsed.hints, 6, 160),
      risk_note: String(parsed.risk_note || '').slice(0, 220),
      raw_response: rawResponse.slice(0, 6000),
      task_plan: compactList(parsed.task_plan, 6, 140),
      checkpoints: compactList(parsed.checkpoints, 6, 140),
      exact_files: compactList(parsed.exact_files, 8, 220),
      success_criteria: compactList(parsed.success_criteria, 6, 160),
      verification_checklist: compactList(parsed.verification_checklist, 6, 160),
      search_queries: compactList(parsed.search_queries, 6, 160),
      tool_sequence: compactList(parsed.tool_sequence, 8, 160),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Secondary call failed:', err.message);
    return null;
  }
}

export async function callSecondaryFileAnalyzer(input: {
  userMessage: string;
  recentHistory?: Array<{ role: string; content: string }>;
  candidateFiles?: string[];
}): Promise<SecondaryFileAnalysisResult | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;

  const historyText = (input.recentHistory || [])
    .slice(-8)
    .map((m, i) => `${i + 1}. ${String(m.role || '').slice(0, 20)}: ${String(m.content || '').slice(0, 260)}`)
    .join('\n');
  const filesText = compactList(input.candidateFiles || [], 16, 220).join('\n');

  const prompt = `USER REQUEST:
${String(input.userMessage || '').slice(0, 2200)}

RECENT HISTORY:
${historyText || '(none)'}

CANDIDATE FILES:
${filesText || '(none supplied)'}

Return analysis JSON now.`;

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: FILE_ANALYZER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 900 },
    );
    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) return null;
    return {
      summary: String(parsed.summary || '').slice(0, 1200),
      diagnosis: String(parsed.diagnosis || '').slice(0, 1800),
      exact_files: compactList(parsed.exact_files, 10, 220),
      edit_plan: compactList(parsed.edit_plan, 8, 220),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Secondary file analyzer failed:', err.message);
    return null;
  }
}

export async function callSecondaryFileOpClassifier(input: {
  userMessage: string;
  recentHistory?: Array<{ role: string; content: string }>;
}): Promise<SecondaryFileOpClassificationResult | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;

  const historyText = (input.recentHistory || [])
    .slice(-4)
    .map((m, i) => `${i + 1}. ${String(m.role || '').slice(0, 20)}: ${String(m.content || '').slice(0, 220)}`)
    .join('\n');

  const prompt = `USER MESSAGE:
${String(input.userMessage || '').slice(0, 1800)}

RECENT HISTORY:
${historyText || '(none)'}

Return classifier JSON now.`;

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: FILE_OP_CLASSIFIER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 260 },
    );

    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) return null;

    const opRaw = String(parsed.operation || '').trim().toUpperCase();
    const allowed = new Set(['FILE_ANALYSIS', 'FILE_CREATE', 'FILE_EDIT', 'BROWSER_OP', 'DESKTOP_OP', 'CHAT']);
    const operation = (allowed.has(opRaw) ? opRaw : 'CHAT') as SecondaryFileOpClassificationResult['operation'];
    const reason = String(parsed.reason || '').slice(0, 260);
    const c = Number(parsed.confidence);
    const confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;

    return {
      operation,
      reason,
      confidence,
      raw_response: rawResponse.slice(0, 4000),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Secondary file-op classifier failed:', err.message);
    return null;
  }
}

export async function callSecondaryFileVerifier(input: {
  userMessage: string;
  operationType: 'FILE_CREATE' | 'FILE_EDIT';
  fileSnapshots: Array<{
    filename: string;
    exists: boolean;
    content_preview: string;
    line_count: number;
    char_count: number;
  }>;
  recentToolExecutions?: Array<{
    tool: string;
    args: any;
    result: string;
    error: boolean;
  }>;
}): Promise<SecondaryFileVerifierResult | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;

  const fileBlock = (input.fileSnapshots || [])
    .slice(0, 8)
    .map((f, i) =>
      `${i + 1}. ${f.filename} | exists=${f.exists} | lines=${f.line_count} | chars=${f.char_count}\n${String(f.content_preview || '').slice(0, 2600)}`,
    )
    .join('\n\n');
  const toolBlock = (input.recentToolExecutions || [])
    .slice(-20)
    .map((t, i) => `${i + 1}. ${t.tool}(${JSON.stringify(t.args || {}).slice(0, 240)}) => ${String(t.result || '').slice(0, 260)}${t.error ? ' [ERROR]' : ''}`)
    .join('\n');

  const prompt = `OPERATION TYPE: ${input.operationType}
USER REQUEST:
${String(input.userMessage || '').slice(0, 2200)}

FILE SNAPSHOTS:
${fileBlock || '(none)'}

RECENT TOOL EXECUTIONS:
${toolBlock || '(none)'}

Return verifier JSON now.`;

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: FILE_VERIFIER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 1200 },
    );
    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) return null;

    const verdictRaw = String(parsed.verdict || '').trim().toUpperCase();
    const verdict: 'PASS' | 'FAIL' = verdictRaw === 'PASS' ? 'PASS' : 'FAIL';
    const reasons = compactList(parsed.reasons, 3, 220);
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings
          .slice(0, 8)
          .map((f: any) => ({
            filename: String(f?.filename || '').slice(0, 220),
            type: String(f?.type || '').slice(0, 80),
            location_hint: f?.location_hint && typeof f.location_hint === 'object'
              ? {
                  start_line: clampInt(f.location_hint.start_line, 1, 1000000, 1),
                  end_line: clampInt(f.location_hint.end_line, 1, 1000000, 1),
                }
              : undefined,
            expected: String(f?.expected || '').slice(0, 500),
            observed: String(f?.observed || '').slice(0, 500),
          }))
      : [];
    const fix = parsed.suggested_fix && typeof parsed.suggested_fix === 'object'
      ? {
          estimated_lines_changed: clampInt(parsed.suggested_fix.estimated_lines_changed, 0, 100000, 0),
          estimated_chars: clampInt(parsed.suggested_fix.estimated_chars, 0, 2000000, 0),
          files_touched: clampInt(parsed.suggested_fix.files_touched, 0, 100, 0),
        }
      : {
          estimated_lines_changed: 0,
          estimated_chars: 0,
          files_touched: 0,
        };

    return {
      verdict,
      reasons,
      findings,
      suggested_fix: fix,
      raw_response: rawResponse.slice(0, 6000),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Secondary file verifier failed:', err.message);
    return null;
  }
}

export async function callSecondaryFilePatchPlanner(input: {
  userMessage: string;
  operationType: 'FILE_CREATE' | 'FILE_EDIT';
  owner: 'primary' | 'secondary';
  reason: string;
  fileSnapshots?: Array<{
    filename: string;
    exists: boolean;
    content_preview: string;
    line_count: number;
    char_count: number;
  }>;
  verifier?: SecondaryFileVerifierResult | null;
  blockedPrimaryCall?: {
    tool: string;
    args: any;
    reason: string;
  };
  recentHistory?: Array<{ role: string; content: string }>;
  existingFiles?: string[];
}): Promise<SecondaryFilePatchPlan | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;

  const fileBlock = (input.fileSnapshots || [])
    .slice(0, 8)
    .map((f, i) =>
      `${i + 1}. ${f.filename} | exists=${f.exists} | lines=${f.line_count} | chars=${f.char_count}\n${String(f.content_preview || '').slice(0, 2400)}`,
    )
    .join('\n\n');
  const verifierBlock = input.verifier
    ? JSON.stringify({
        verdict: input.verifier.verdict,
        reasons: input.verifier.reasons,
        findings: input.verifier.findings,
        suggested_fix: input.verifier.suggested_fix,
      }).slice(0, 5000)
    : '(none)';
  const blockedCall = input.blockedPrimaryCall
    ? JSON.stringify(input.blockedPrimaryCall).slice(0, 1800)
    : '(none)';

  const historyText = (input.recentHistory || [])
    .slice(-6)
    .map(m => `${m.role}: ${String(m.content || '').slice(0, 300)}`)
    .join('\n');
  const existingFilesText = (input.existingFiles || []).slice(0, 40).join(', ') || '(none)';

  const prompt = `USER REQUEST:
${String(input.userMessage || '').slice(0, 2200)}

OPERATION TYPE: ${input.operationType}
CURRENT OWNER: ${input.owner}
TRIGGER REASON: ${String(input.reason || '').slice(0, 400)}

EXISTING FILES IN WORKSPACE:
${existingFilesText}

RECENT CONVERSATION:
${historyText || '(none)'}

BLOCKED PRIMARY CALL:
${blockedCall}

VERIFIER:
${verifierBlock}

FILE SNAPSHOTS:
${fileBlock || '(none)'}

Return patch plan JSON now.`;

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: FILE_PATCH_PLANNER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 1400 },
    );
    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) return null;
    const strategyRaw = String(parsed.strategy || '').trim().toLowerCase();
    const strategy: 'patch' | 'regenerate' = strategyRaw === 'regenerate' ? 'regenerate' : 'patch';
    return {
      strategy,
      tool_calls: compactToolCalls(parsed.tool_calls, 8),
      estimated_lines_changed: clampInt(parsed.estimated_lines_changed, 0, 100000, 0),
      estimated_chars: clampInt(parsed.estimated_chars, 0, 2000000, 0),
      files_touched: clampInt(parsed.files_touched, 0, 100, 0),
      rationale: String(parsed.rationale || '').slice(0, 1200),
      raw_response: rawResponse.slice(0, 6000),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Secondary file patch planner failed:', err.message);
    return null;
  }
}

export async function callSecondaryBrowserAdvisor(
  input: BrowserAdvisorInput,
): Promise<BrowserAdvisorResult | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;

  const feedLines = compactBrowserFeedLines(input);
  let evidenceBody = '';
  if (feedLines.length > 30) {
    const chunkSummaries = await summarizeBrowserChunks(provider, config.secondary.model, feedLines);
    evidenceBody = chunkSummaries.length
      ? chunkSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : feedLines.slice(0, 30).map((s, i) => `${i + 1}. ${s}`).join('\n');
  } else {
    evidenceBody = feedLines.slice(0, 30).map((s, i) => `${i + 1}. ${s}`).join('\n');
  }

  const blocks = (Array.isArray(input.textBlocks) ? input.textBlocks : [])
    .slice(0, 10)
    .map((t, i) => `${i + 1}. ${String(t || '').replace(/\s+/g, ' ').trim().slice(0, 420)}`)
    .join('\n');
  const actions = (Array.isArray(input.lastActions) ? input.lastActions : [])
    .slice(-6)
    .map((a, i) => `${i + 1}. ${String(a || '').slice(0, 220)}`)
    .join('\n');
  const failures = (Array.isArray(input.recentFailures) ? input.recentFailures : [])
    .slice(-4)
    .map((f, i) => `${i + 1}. ${String(f || '').slice(0, 220)}`)
    .join('\n');

  const pageTextSection = input.pageText && input.pageText.trim().length > 0
    ? `\nPAGE RESPONSE TEXT (last assistant message / article body):\n${input.pageText.trim().slice(0, 3000)}`
    : '';
  const generatingNote = input.isGenerating
    ? '\nGENERATION STATUS: The AI on this page is STILL GENERATING its response. Do NOT send a follow-up message yet. Route continue_browser with next_tool=browser_wait(3000) then browser_snapshot.'
    : '';

  const minItems = Number(input.minFeedItemsBeforeAnswer || 12);
  const pageType = String(input.page?.pageType || 'generic');
  const totalCollected = Number(input.scrollState?.total_collected || 0);
  const isFeedPage = pageType === 'x_feed' || pageType === 'search_results';
  const collectionStatus = isFeedPage
    ? totalCollected >= minItems
      ? `COLLECTION STATUS: ${totalCollected}/${minItems} items collected — minimum MET, answer_now is allowed if evidence answers goal.`
      : `COLLECTION STATUS: ${totalCollected}/${minItems} items collected — minimum NOT YET MET. You MUST route collect_more, not answer_now.`
    : `COLLECTION STATUS: non-feed page (${pageType}); MIN_FEED_ITEMS does NOT apply. Do NOT route collect_more just to chase feed items. Choose continue_browser or handoff_primary with a concrete interaction.`;

  // For non-feed pages (generic, article, app pages like chatgpt.com), the raw snapshot
  // is the ONLY useful data — extractedFeed and textBlocks will be empty.
  // Without the snapshot, the advisor is blind and hallucinates selectors.
  // For feed pages, the structured extractedFeed is sufficient; snapshot adds noise.
  const snapshotSection = !isFeedPage && input.snapshot && input.snapshot.trim().length > 0
    ? `\nPAGE SNAPSHOT (all interactive elements — use @ref numbers for browser_click/browser_fill):\n${input.snapshot.trim().slice(0, 6000)}`
    : '';

  const prompt = `GOAL:
${String(input.goal || '').slice(0, 900)}

PAGE:
title=${String(input.page?.title || '').slice(0, 220)}
url=${String(input.page?.url || '').slice(0, 350)}
type=${pageType}
snapshot_elements=${Number(input.page?.snapshotElements || 0)}

SCROLL STATE:
batch=${Number(input.scrollState?.batch || 1)}
total_collected=${totalCollected}
dedupe_count=${Number(input.scrollState?.dedupe_count || 0)}
MIN_FEED_ITEMS=${minItems}

${collectionStatus}${snapshotSection}

EXTRACTED FEED:
${evidenceBody || '(none)'}

ARTICLE BLOCKS:
${blocks || '(none)'}

RECENT ACTIONS:
${actions || '(none)'}

RECENT FAILURES:
${failures || '(none)'}${pageTextSection}${generatingNote}

Return route JSON now.`;

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: BROWSER_ADVISOR_SYSTEM },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 1024 },
    );
    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) return null;

    const routeRaw = String(parsed.route || '').trim();
    let route: BrowserAdvisorRoute =
      routeRaw === 'answer_now'
      || routeRaw === 'continue_browser'
      || routeRaw === 'collect_more'
      || routeRaw === 'handoff_primary'
        ? routeRaw
        : 'handoff_primary';
    if (!isFeedPage && route === 'collect_more') {
      route = 'continue_browser';
    }

    const nextToolName = String(parsed.next_tool?.tool || '').trim();
    const nextTool =
      nextToolName
        ? {
            tool: nextToolName,
            params: parsed.next_tool?.params && typeof parsed.next_tool.params === 'object'
              ? parsed.next_tool.params
              : {},
          }
        : undefined;

    const collectPolicy = parsed.collect_policy
      ? {
          scroll_batches: clampInt(parsed.collect_policy.scroll_batches, 1, 5, 2),
          target_count: clampInt(parsed.collect_policy.target_count, 8, 80, 24),
        }
      : undefined;

    return {
      route,
      reason: String(parsed.reason || '').slice(0, 260),
      answer: String(parsed.answer || '').slice(0, 1800),
      raw_response: rawResponse.slice(0, 6000),
      next_tool: nextTool,
      collect_policy: collectPolicy,
      primary_hint: String(parsed.primary_hint || '').slice(0, 650),
      evidence_focus: compactList(parsed.evidence_focus, 6, 160),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Browser advisor failed:', err.message);
    return null;
  }
}

export async function callSecondaryDesktopAdvisor(
  input: DesktopAdvisorInput,
): Promise<DesktopAdvisorResult | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;

  const actions = (Array.isArray(input.lastActions) ? input.lastActions : [])
    .slice(-8)
    .map((a, i) => `${i + 1}. ${String(a || '').slice(0, 240)}`)
    .join('\n');

  const failures = (Array.isArray(input.recentFailures) ? input.recentFailures : [])
    .slice(-5)
    .map((f, i) => `${i + 1}. ${String(f || '').slice(0, 240)}`)
    .join('\n');

  const windows = (Array.isArray(input.openWindows) ? input.openWindows : [])
    .slice(0, 40)
    .map((w, i) => {
      const proc = String(w?.processName || '').slice(0, 80);
      const title = String(w?.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      return `${i + 1}. [${proc || 'process'}] ${title || '(untitled)'}`;
    })
    .join('\n');

  const activeTitle = String(input.activeWindow?.title || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const activeProc = String(input.activeWindow?.processName || '').slice(0, 80);
  const clipboardPreview = String(input.clipboardPreview || '').slice(0, 1200);
  const ocrText = String(input.ocrText || '').slice(0, 6000);
  const ocrConfidence = Number(input.ocrConfidence || 0);

  const prompt = `GOAL:
${String(input.goal || '').slice(0, 900)}

SCREENSHOT META:
width=${Number(input.screenshot?.width || 0)}
height=${Number(input.screenshot?.height || 0)}
captured_at=${Number(input.screenshot?.capturedAt || 0)}
content_hash=${String(input.screenshot?.contentHash || '').slice(0, 64)}

ACTIVE WINDOW:
process=${activeProc || '(unknown)'}
title=${activeTitle || '(unknown)'}

OPEN WINDOWS:
${windows || '(none)'}

RECENT ACTIONS:
${actions || '(none)'}

RECENT FAILURES:
${failures || '(none)'}

CLIPBOARD PREVIEW:
${clipboardPreview || '(none)'}

OCR_TEXT:
confidence=${Math.round(ocrConfidence)}%
${ocrText || '(none)'}

Return desktop route JSON now.`;

  // Build the user message. When the secondary is a vision-capable provider AND
  // a screenshot was supplied, attach the image so the advisor can see UI elements
  // that OCR misses (buttons, icons, progress bars, colour-coded statuses).
  // For Ollama/llama.cpp we always send plain text — small models cannot use images.
  const useVision = secondarySupportsVision(config) && !!input.screenshotBase64;
  const userMessage = useVision
    ? {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: prompt },
          {
            type: 'image_url' as const,
            image_url: {
              url: `data:image/png;base64,${input.screenshotBase64}`,
              detail: 'low' as const,  // low = cheaper tokens, sufficient for UI status checks
            },
          },
        ],
      }
    : { role: 'user' as const, content: prompt };

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: DESKTOP_ADVISOR_SYSTEM },
        userMessage,
      ],
      config.secondary.model,
      { max_tokens: 1024 },  // increased from 900 — desktop tasks need room to reason
    );
    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) return null;

    const routeRaw = String(parsed.route || '').trim();
    const route: DesktopAdvisorRoute =
      routeRaw === 'answer_now'
      || routeRaw === 'continue_desktop'
      || routeRaw === 'handoff_primary'
        ? routeRaw
        : 'handoff_primary';

    const allowedTools = new Set([
      'desktop_screenshot',
      'desktop_find_window',
      'desktop_focus_window',
      'desktop_click',
      'desktop_drag',
      'desktop_wait',
      'desktop_type',
      'desktop_press_key',
      'desktop_get_clipboard',
      'desktop_set_clipboard',
    ]);
    const nextToolName = String(parsed.next_tool?.tool || '').trim();
    const nextTool =
      nextToolName && allowedTools.has(nextToolName)
        ? {
            tool: nextToolName,
            params: parsed.next_tool?.params && typeof parsed.next_tool.params === 'object'
              ? parsed.next_tool.params
              : {},
          }
        : undefined;

    return {
      route,
      reason: String(parsed.reason || '').slice(0, 280),
      answer: String(parsed.answer || '').slice(0, 1800),
      raw_response: rawResponse.slice(0, 6000),
      next_tool: nextTool,
      primary_hint: String(parsed.primary_hint || '').slice(0, 650),
      evidence_focus: compactList(parsed.evidence_focus, 6, 180),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Desktop advisor failed:', err.message);
    return null;
  }
}

export function formatPreflightExecutionObjective(preflight: PreflightResult): string {
  const lines: string[] = ['[ADVISOR EXECUTION OBJECTIVE - hidden guidance for this turn]'];
  if (preflight.reason) lines.push(`Reason: ${preflight.reason}`);
  if (preflight.executor_objective) {
    lines.push('Executor objective:');
    lines.push(preflight.executor_objective);
  }
  lines.push('Do not replace user literals with placeholders.');
  lines.push('[/ADVISOR EXECUTION OBJECTIVE]');
  return lines.join('\n');
}

export function formatPreflightHint(preflight: PreflightResult): string {
  const lines: string[] = ['[ADVISOR PREFLIGHT - hidden guidance for this turn]'];
  if (preflight.reason) lines.push(`Reason: ${preflight.reason}`);

  if (preflight.quick_plan.length) {
    lines.push('Quick plan:');
    preflight.quick_plan.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }

  if (preflight.search_queries.length) {
    lines.push('Suggested search queries:');
    preflight.search_queries.forEach((q) => lines.push(`  - ${q}`));
  }

  if (preflight.likely_files.length) {
    lines.push('Likely files:');
    preflight.likely_files.forEach((f) => lines.push(`  - ${f}`));
  }

  if (preflight.tool_hints.length) {
    lines.push('Tool hints:');
    preflight.tool_hints.forEach((t) => lines.push(`  - ${t}`));
  }

  if (preflight.risk_note) lines.push(`Risk: ${preflight.risk_note}`);
  lines.push('[/ADVISOR PREFLIGHT]');
  return lines.join('\n');
}

export function formatAdvisoryHint(advice: AdvisoryResult): string {
  const lines = ['[ADVISOR GUIDANCE - follow this for your next actions]'];
  if (advice.mode === 'planner' && advice.task_plan.length) {
    lines.push('Task plan:');
    advice.task_plan.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  }
  if (advice.mode === 'planner' && advice.checkpoints.length) {
    lines.push('Checkpoints:');
    advice.checkpoints.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }
  if (advice.mode === 'planner' && advice.exact_files.length) {
    lines.push('Exact files likely involved:');
    advice.exact_files.forEach((f) => lines.push(`  - ${f}`));
  }
  if (advice.mode === 'planner' && advice.success_criteria.length) {
    lines.push('Success criteria:');
    advice.success_criteria.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  if (advice.mode === 'planner' && advice.verification_checklist.length) {
    lines.push('Verification checklist:');
    advice.verification_checklist.forEach((v, i) => lines.push(`  ${i + 1}. ${v}`));
  }
  if (advice.mode === 'planner' && advice.search_queries.length) {
    lines.push('Suggested search queries:');
    advice.search_queries.forEach((q) => lines.push(`  - ${q}`));
  }
  if (advice.mode === 'planner' && advice.tool_sequence.length) {
    lines.push('Suggested tool sequence:');
    advice.tool_sequence.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
  }
  if (advice.next_actions.length) {
    lines.push('Next actions (do these in order):');
    advice.next_actions.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  }
  if (advice.stop_doing.length) {
    lines.push('Stop doing:');
    advice.stop_doing.forEach((s) => lines.push(`  - ${s}`));
  }
  if (advice.hints.length) {
    lines.push('Hints:');
    advice.hints.forEach((h) => lines.push(`  -> ${h}`));
  }
  if (advice.risk_note) lines.push(`Risk: ${advice.risk_note}`);
  lines.push('[/ADVISOR GUIDANCE]');
  return lines.join('\n');
}

// ─── Task Heartbeat Types ───────────────────────────────────────────────────

export interface TaskSnapshot {
  id: string;
  title: string;
  status: string;
  pauseReason?: string;
  currentStepIndex: number;
  totalSteps: number;
  currentStepDescription?: string;
  lastProgressAt: number;
  startedAt: number;
  lastJournalEntries: string[];
  channel: 'web' | 'telegram';
  sessionId: string;
}

export interface HeartbeatAdvisorResult {
  verdict: 'continue' | 'skip';
  resume_task_id?: string;
  resume_from_step?: number;
  opening_action?: string;
  rationale: string;
  plan_mutations?: Array<
    | { op: 'complete'; step_index: number; notes?: string }
    | { op: 'add'; after_index: number; description: string }
    | { op: 'modify'; step_index: number; description: string }
  >;
  raw_response?: string;
}

const HEARTBEAT_ADVISOR_SYSTEM = `You are the heartbeat advisor for an autonomous task management system.

You receive a snapshot of all paused/queued tasks. Decide which task to resume next and the first action to take.

Return ONLY JSON:
{
  "verdict": "continue" | "skip",
  "resume_task_id": "uuid of task to resume (only when verdict=continue)",
  "resume_from_step": 0,
  "opening_action": "browser_snapshot | desktop_screenshot | read_file | (empty if starting fresh)",
  "rationale": "short reason for the decision",
  "plan_mutations": [
    { "op": "complete", "step_index": 0, "notes": "what happened" },
    { "op": "add", "after_index": 1, "description": "new step to add" },
    { "op": "modify", "step_index": 2, "description": "updated description" }
  ]
}

Rules:
- verdict=skip: no tasks ready to resume, or all are blocked
- verdict=continue: pick the highest-priority paused/queued task
- Priority order: paused (preempted) > stalled > queued
- plan_mutations: apply only if context suggests steps should change; otherwise omit or leave empty
- opening_action: what the runner should do first when resuming (use empty string if just continue from where left off)
- Return JSON only`;

export async function callSecondaryHeartbeatAdvisor(input: {
  tasks: TaskSnapshot[];
  currentTimeMs: number;
}): Promise<HeartbeatAdvisorResult | null> {
  const built = await buildSecondaryProvider();
  if (!built) return null;
  const { provider, config } = built;

  const now = input.currentTimeMs || Date.now();

  const tasksText = (input.tasks || [])
    .slice(0, 10)
    .map((t, i) => {
      const ageMin = Math.floor((now - t.lastProgressAt) / 60000);
      const runMin = Math.floor((now - t.startedAt) / 60000);
      const stepInfo = `step ${t.currentStepIndex + 1}/${t.totalSteps}${t.currentStepDescription ? ': ' + t.currentStepDescription : ''}`;
      const journalSnippet = t.lastJournalEntries.slice(-3).join(' | ');
      return `${i + 1}. [${t.id.slice(0, 8)}] "${t.title}"
   status=${t.status}${t.pauseReason ? ' reason=' + t.pauseReason : ''}
   ${stepInfo}
   last_activity=${ageMin}min ago  running_for=${runMin}min
   channel=${t.channel}  session=${t.sessionId.slice(0, 8)}
   recent_journal: ${journalSnippet || '(none)'}`.trim();
    })
    .join('\n\n');

  const prompt = `CURRENT TIME: ${new Date(now).toISOString()}

PAUSED / QUEUED TASKS:
${tasksText || '(none)'}

Return heartbeat decision JSON now.`;

  try {
    const result = await provider.chat(
      [
        { role: 'system', content: HEARTBEAT_ADVISOR_SYSTEM },
        { role: 'user', content: prompt },
      ],
      config.secondary.model,
      { max_tokens: 600 },
    );
    const rawResponse = contentToString(result.message.content).trim();
    const parsed = parseJsonObject(rawResponse);
    if (!parsed) return null;

    const verdictRaw = String(parsed.verdict || '').trim();
    const verdict: 'continue' | 'skip' = verdictRaw === 'continue' ? 'continue' : 'skip';

    const mutations: HeartbeatAdvisorResult['plan_mutations'] = [];
    if (Array.isArray(parsed.plan_mutations)) {
      for (const m of parsed.plan_mutations.slice(0, 10)) {
        if (!m || typeof m !== 'object') continue;
        const op = String(m.op || '').trim();
        if (op === 'complete') {
          mutations.push({ op: 'complete', step_index: Number(m.step_index) || 0, notes: String(m.notes || '').slice(0, 300) });
        } else if (op === 'add') {
          mutations.push({ op: 'add', after_index: Number(m.after_index) || 0, description: String(m.description || '').slice(0, 200) });
        } else if (op === 'modify') {
          mutations.push({ op: 'modify', step_index: Number(m.step_index) || 0, description: String(m.description || '').slice(0, 200) });
        }
      }
    }

    return {
      verdict,
      resume_task_id: verdict === 'continue' ? String(parsed.resume_task_id || '').trim() : undefined,
      resume_from_step: verdict === 'continue' ? (Number(parsed.resume_from_step) || 0) : undefined,
      opening_action: verdict === 'continue' ? String(parsed.opening_action || '').trim() : undefined,
      rationale: String(parsed.rationale || '').slice(0, 400),
      plan_mutations: mutations.length ? mutations : undefined,
      raw_response: rawResponse.slice(0, 4000),
    };
  } catch (err: any) {
    console.error('[Orchestrator] Heartbeat advisor failed:', err.message);
    return null;
  }
}

export function formatBrowserAdvisorHint(advice: BrowserAdvisorResult): string {
  // For collect_more: single compact line — LLM just needs to know to wait for next directive.
  // Full structured hints are reserved for answer_now and continue_browser where
  // the LLM needs richer context to make a decision or construct a response.
  if (advice.route === 'collect_more') {
    const nextTool = advice.next_tool?.tool
      ? ` Next: ${advice.next_tool.tool}(${JSON.stringify(advice.next_tool.params || {}).replace(/"/g, '')})`
      : ' Next: scroll for more.';
    return `[BROWSER ADVISOR] collect_more — ${advice.reason || 'collecting feed items'}.${nextTool}`;
  }

  // Full hint for answer_now and continue_browser
  const lines = ['[BROWSER ADVISOR - hidden guidance]'];
  lines.push(`Route: ${advice.route}`);
  if (advice.reason) lines.push(`Reason: ${advice.reason}`);
  if (advice.evidence_focus.length) {
    lines.push('Evidence focus:');
    advice.evidence_focus.forEach((e) => lines.push(`  - ${e}`));
  }
  if (advice.next_tool?.tool) {
    lines.push(`Recommended next tool: ${advice.next_tool.tool}(${JSON.stringify(advice.next_tool.params || {})})`);
  }
  if (advice.collect_policy) {
    lines.push(`Collect policy: batches=${advice.collect_policy.scroll_batches}, target=${advice.collect_policy.target_count}`);
  }
  if (advice.primary_hint) {
    lines.push(`Primary hint: ${advice.primary_hint}`);
  }
  if (advice.route === 'answer_now' && advice.answer) {
    lines.push(`Candidate answer draft: ${advice.answer.slice(0, 600)}`);
  }
  lines.push('[/BROWSER ADVISOR]');
  return lines.join('\n');
}

export function formatDesktopAdvisorHint(advice: DesktopAdvisorResult): string {
  const lines = ['[DESKTOP ADVISOR - hidden guidance]'];
  lines.push(`Route: ${advice.route}`);
  if (advice.reason) lines.push(`Reason: ${advice.reason}`);
  if (advice.evidence_focus.length) {
    lines.push('Evidence focus:');
    advice.evidence_focus.forEach((e) => lines.push(`  - ${e}`));
  }
  if (advice.next_tool?.tool) {
    lines.push(`Recommended next tool: ${advice.next_tool.tool}(${JSON.stringify(advice.next_tool.params || {})})`);
  }
  if (advice.primary_hint) {
    lines.push(`Primary hint: ${advice.primary_hint}`);
  }
  if (advice.route === 'answer_now' && advice.answer) {
    lines.push(`Candidate answer draft: ${advice.answer.slice(0, 600)}`);
  }
  lines.push('[/DESKTOP ADVISOR]');
  return lines.join('\n');
}

