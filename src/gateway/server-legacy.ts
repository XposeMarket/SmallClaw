import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { AgentOrchestrator } from './orchestrator';
import { getConfig } from '../config/config';
import { getDatabase } from '../db/database';
import { createHash, randomUUID } from 'crypto';
import { getOllamaClient } from '../agents/ollama-client';
import { getReactor } from '../agents/reactor-legacy';
import { buildSystemPrompt, loadMemory, selectSkillSlugsForMessage } from '../config/soul-loader';
import { listSkillManifests, removeSkillPack, writeSkillPackFromContent } from '../skills/processor';
import {
  executeSkillExec,
  executeSkillInspect,
  executeSkillInstall,
  executeSkillList,
  executeSkillRemove,
  executeSkillRescan,
  executeSkillSearch,
  executeSkillSetEnabled,
  executeSkillUpload,
} from '../tools/skills';
import { getToolRegistry } from '../tools/registry';
import { queryFactRecords, pruneFactStore } from './fact-store';
import { addMemoryFact, appendDailyMemoryNote } from './memory-manager';

const config = getConfig().getConfig();
const TOOL_AUDIT_LOG = path.join(config.workspace.path, 'tool_audit.log');
const THINK_LEVEL = (process.env.LOCALCLAW_THINK_LEVEL as 'high' | 'medium' | 'low' | undefined) || 'low';

function envFlag(name: string, defaultValue = true): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function envInt(name: string, defaultValue: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return defaultValue;
  return Math.floor(raw);
}

function envThinkMode(name: string, defaultValue: 'off' | 'low' | 'medium' | 'high' = 'off'): 'low' | 'medium' | 'high' | undefined {
  const raw = String(process.env[name] ?? defaultValue).trim().toLowerCase();
  if (!raw || ['off', 'none', 'false', '0'].includes(raw)) return undefined;
  if (raw === 'on' || raw === 'true' || raw === '1') return 'low';
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return undefined;
}

const SMALL_MODEL_TUNING = {
  // discuss_think MUST be 'low' — the trigger system reads open_tool from <think> blocks.
  // With think='off', thinking is stripped before trigger scan and open_tool is never detected.
  // num_predict raised so Qwen3:4b can finish its thoughts without being cut off mid-sentence.
  discuss_num_ctx: envInt('LOCALCLAW_DISCUSS_NUM_CTX', 3072),
  discuss_num_predict: envInt('LOCALCLAW_DISCUSS_NUM_PREDICT', 512),
  chat_num_ctx: envInt('LOCALCLAW_CHAT_NUM_CTX', 2560),
  chat_num_predict: envInt('LOCALCLAW_CHAT_NUM_PREDICT', 384),
  discuss_think: envThinkMode('LOCALCLAW_DISCUSS_THINK', 'low'),
  chat_think: envThinkMode('LOCALCLAW_CHAT_THINK', 'low'),
};

const EXEC_LIMITS = {
  max_tools_per_cycle: Math.max(1, envInt('LOCALCLAW_MAX_TOOLS_PER_CYCLE', 3)),
  max_cycles_per_user_turn: Math.max(1, envInt('LOCALCLAW_MAX_CYCLES_PER_TURN', 6)),
  max_total_tools_per_turn: Math.max(1, envInt('LOCALCLAW_MAX_TOTAL_TOOLS_PER_TURN', 18)),
  max_continuation_depth: Math.max(1, envInt('LOCALCLAW_MAX_CONTINUATION_DEPTH', 6)),
};

const FEATURE_FLAGS = {
  deterministic_prefix_delete: envFlag('LOCALCLAW_FF_PREFIX_DELETE', true),
  deterministic_execute_fallback: envFlag('LOCALCLAW_FF_DETERMINISTIC_EXECUTE_FALLBACK', false),
  execute_native_only_strict: envFlag('LOCALCLAW_FF_EXECUTE_NATIVE_ONLY', false),
  node_call_execute: envFlag('LOCALCLAW_FF_NODE_CALL_EXECUTE', true),
  html_structural_mutation: envFlag('LOCALCLAW_FF_STRUCTURAL_HTML', true),
  attribution_fetch_gate: envFlag('LOCALCLAW_FF_ATTRIBUTION_FETCH', true),
  retry_failed_fileop_replay: envFlag('LOCALCLAW_FF_RETRY_REPLAY', true),
  self_heal_skill_autowrite: envFlag('LOCALCLAW_FF_SELF_HEAL_SKILL', true),
  ai_first_execute_mode: envFlag('LOCALCLAW_FF_AI_FIRST_EXECUTE', true),
  fast_execute_bypass: envFlag('LOCALCLAW_FF_FAST_EXECUTE_BYPASS', false),
  model_trigger_mode_switch: envFlag('LOCALCLAW_FF_MODEL_TRIGGER_SWITCH', true),
  model_trigger_include_thinking: envFlag('LOCALCLAW_FF_MODEL_TRIGGER_THINKING', true), // MUST be true — trigger system depends on scanning <think> output
  model_trigger_post_exec_chat_finalize: envFlag('LOCALCLAW_FF_MODEL_TRIGGER_POST_FINALIZE', true),
  continuation_loop: envFlag('LOCALCLAW_FF_CONTINUATION_LOOP', true),
};

type DecisionMetricKey =
  | 'discuss_when_should_execute'
  | 'unsupported_mutation'
  | 'format_loop'
  | 'ambiguous_target'
  | 'missing_required_input'
  | 'verify_failed'
  | 'wrong_target';

const decisionTelemetry: Record<DecisionMetricKey, number> = {
  discuss_when_should_execute: 0,
  unsupported_mutation: 0,
  format_loop: 0,
  ambiguous_target: 0,
  missing_required_input: 0,
  verify_failed: 0,
  wrong_target: 0,
};

function bumpDecisionMetric(key: DecisionMetricKey): void {
  decisionTelemetry[key] = Number(decisionTelemetry[key] || 0) + 1;
}

interface AgentPolicySettings {
  force_web_for_fresh: boolean;
  memory_fallback_on_search_failure: boolean;
  auto_store_web_facts: boolean;
  natural_language_tool_router: boolean;
  retrieval_mode: 'fast' | 'standard' | 'deep';
}

function getLocalConfigFilePath(): string {
  const projectCfg = path.join(process.cwd(), '.localclaw', 'config.json');
  return fs.existsSync(projectCfg) ? projectCfg : path.join(os.homedir(), '.localclaw', 'config.json');
}

function readRawLocalConfig(): any {
  const cfgPath = getLocalConfigFilePath();
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeRawLocalConfig(data: any): void {
  const cfgPath = getLocalConfigFilePath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2), 'utf-8');
}

function getAgentPolicy(): AgentPolicySettings {
  const raw = readRawLocalConfig();
  const p = raw.agent_policy || {};
  const retrievalMode = String(p.retrieval_mode || 'standard').toLowerCase();
  return {
    force_web_for_fresh: p.force_web_for_fresh !== false,
    memory_fallback_on_search_failure: p.memory_fallback_on_search_failure !== false,
    auto_store_web_facts: p.auto_store_web_facts !== false,
    natural_language_tool_router: p.natural_language_tool_router !== false,
    retrieval_mode: (retrievalMode === 'fast' || retrievalMode === 'deep' || retrievalMode === 'standard')
      ? retrievalMode as ('fast' | 'standard' | 'deep')
      : 'standard',
  };
}

type SearchRigor = 'fast' | 'verified' | 'strict';

function getSearchRigor(): SearchRigor {
  const raw = readRawLocalConfig();
  const v = String(raw?.search?.search_rigor || 'verified').toLowerCase();
  if (v === 'fast' || v === 'strict') return v;
  return 'verified';
}

function getSearchRigorConfig() {
  const rigor = getSearchRigor();
  return {
    rigor,
    maxSanityRetries: rigor === 'fast' ? 0 : 1,
    requireOfficialForOffice: rigor === 'strict',
  };
}
function logToolAudit(entry: object) {
  try {
    fs.appendFileSync(TOOL_AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn('Failed to write tool audit log:', e);
  }
}

function recordAgentFailure(sessionId: string | undefined, turnId: string | undefined, kind: string, details?: any): void {
  try {
    db.createAgentFailure({
      id: randomUUID(),
      session_id: sessionId,
      turn_id: turnId,
      kind,
      details,
    });
  } catch (err: any) {
    console.warn('[server] Failed to record agent failure:', err?.message || err);
  }
}
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });
const orchestrator = new AgentOrchestrator();
const db = getDatabase();

try {
  const pruned = pruneFactStore();
  console.log(`[memory] fact-store prune complete: total=${pruned.total} stale_removed=${pruned.stale} session_ttl_backfilled=${pruned.session_without_expiry}`);
} catch (err: any) {
  console.warn('[memory] fact-store prune failed:', err?.message || err);
}

type AgentMode = 'discuss' | 'plan' | 'execute';
type DiscussSubmode = 'chat' | 'coach';
type SessionMode = 'chat' | 'agent';
type TurnKind = 'discuss' | 'plan' | 'continue_plan' | 'new_objective' | 'side_question';
type TurnExecutionStatus = 'planned' | 'running' | 'verifying' | 'repaired' | 'done' | 'failed';
type TurnExecutionStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
type TurnExecutionStepType = 'analyze_intent' | 'select_targets' | 'execute_changes' | 'verify_outcome' | 'finalize_reply';
type DecisionTraceStage = 'routing' | 'clause_split' | 'deterministic_candidates' | 'selected_plan' | 'execution' | 'verification' | 'finalize' | 'fallback';
type FileOpBlockedReason =
  | 'AMBIGUOUS_TARGET'
  | 'UNSUPPORTED_MUTATION'
  | 'VERIFY_FAILED'
  | 'FORMAT_VIOLATION_LOOP'
  | 'MISSING_REQUIRED_INPUT';
interface PlanTask {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  tool?: string;
  acceptance?: string[];
  model_task_id?: string;
}
interface TurnObjective {
  id: string;
  text: string;
  kind: TurnKind;
  status: 'open' | 'completed' | 'blocked';
  createdAt: number;
}
interface TurnExecutionStep {
  step_id: string;
  type: TurnExecutionStepType;
  title: string;
  status: TurnExecutionStepStatus;
  inputs?: Record<string, any>;
  outputs?: Record<string, any>;
  started_at?: number;
  ended_at?: number;
}
interface TurnExecutionToolCallRecord {
  tool_call_id: string;
  step_id: string;
  step_type: TurnExecutionStepType;
  tool_name: string;
  args: any;
  result_summary?: string;
  status: 'running' | 'ok' | 'error';
  phase: 'call' | 'result';
  timestamp: number;
}
interface TurnExecutionVerification {
  expected: Record<string, any>;
  actual: Record<string, any>;
  status: 'pass' | 'fail';
  repairs_applied?: string[];
  errors?: string[];
  checked_at: number;
}
interface DecisionTraceEvent {
  ts: number;
  stage: DecisionTraceStage;
  message: string;
  data?: any;
}
interface DecisionTrace {
  raw_user_message: string;
  normalized_message?: string;
  events: DecisionTraceEvent[];
}
interface TurnExecution {
  turn_id: string;
  created_at: number;
  updated_at: number;
  objective_raw: string;
  objective_normalized?: string;
  mode: AgentMode | 'chat' | 'coach';
  turn_kind: TurnKind;
  status: TurnExecutionStatus;
  steps: TurnExecutionStep[];
  tool_calls: TurnExecutionToolCallRecord[];
  verification?: TurnExecutionVerification;
  decision_trace?: DecisionTrace;
  final_summary?: string;
}
interface PendingConfirmation {
  id: string;
  requested_at: number;
  source_turn_id: string;
  question: string;
  original_user_message: string;
  resume_message: string;
}
interface AgentSessionState {
  sessionId: string;
  mode: AgentMode;
  modeLock: SessionMode | null;
  objective: string;
  activeObjective: string;
  summary: string;
  tasks: PlanTask[];
  turns: TurnObjective[];
  notes: string[];
  decisions: string[];
  pendingQuestions: string[];
  lastEvidence?: {
    question: string;
    answer_summary?: string;
    tools: string[];
    topSources: string[];
    generatedAt: number;
  };
  verifiedFacts?: Array<{
    key: string;
    value: string;
    claim_text: string;
    sources: string[];
    verified_at: number;
    ttl_minutes: number;
    confidence: number;
    fact_type?: 'generic' | 'office_holder' | 'weather' | 'breaking_news' | 'market_price' | 'event_date_fact';
    requires_reverify_on_use?: boolean;
    question?: string;
  }>;
  lastStyleMutation?: LastStyleMutation;
  lastFilePath?: string;
  recentFilePaths?: string[];
  pendingConfirmation?: PendingConfirmation;
  currentTurnExecution?: TurnExecution;
  recentTurnExecutions?: TurnExecution[];
  continuationDepth: number;         // how many execute→discuss continuation cycles this turn
  continuationOriginMessage: string; // the original user message driving the current continuation loop
  continuationLastTaskSnapshot: string; // serialized task statuses from last cycle — stall detection
  updatedAt: number;
}

type DeterministicFileCall = { tool: 'rename' | 'write' | 'delete'; params: any; reason: string };
const agentSessions = new Map<string, AgentSessionState>();

function persistAgentSessionState(state: AgentSessionState): void {
  try {
    db.saveAgentSessionState(state.sessionId, state);
  } catch (err: any) {
    console.warn('[server] Failed to persist agent session state:', err?.message || err);
  }
}

function cloneTurnExecution(exe: TurnExecution): TurnExecution {
  return JSON.parse(JSON.stringify(exe || {}));
}

function toTurnExecutionStepStatus(raw: any): TurnExecutionStepStatus {
  const v = String(raw || '').toLowerCase();
  if (v === 'running') return 'running';
  if (v === 'done') return 'done';
  if (v === 'failed') return 'failed';
  if (v === 'skipped') return 'skipped';
  return 'pending';
}

function toTurnExecutionStatus(raw: any): TurnExecutionStatus {
  const v = String(raw || '').toLowerCase();
  if (v === 'running') return 'running';
  if (v === 'verifying') return 'verifying';
  if (v === 'repaired') return 'repaired';
  if (v === 'done') return 'done';
  if (v === 'failed') return 'failed';
  return 'planned';
}

function sanitizeTurnExecution(raw: any): TurnExecution | null {
  if (!raw || typeof raw !== 'object') return null;
  const now = Date.now();
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : [];
  const callsRaw = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  const steps: TurnExecutionStep[] = stepsRaw.map((s: any, idx: number) => ({
    step_id: String(s?.step_id || `step_${idx + 1}`),
    type: ((): TurnExecutionStepType => {
      const t = String(s?.type || '').toLowerCase();
      if (t === 'analyze_intent') return 'analyze_intent';
      if (t === 'select_targets') return 'select_targets';
      if (t === 'execute_changes') return 'execute_changes';
      if (t === 'verify_outcome') return 'verify_outcome';
      if (t === 'finalize_reply') return 'finalize_reply';
      return 'execute_changes';
    })(),
    title: String(s?.title || 'Step'),
    status: toTurnExecutionStepStatus(s?.status),
    inputs: (s?.inputs && typeof s.inputs === 'object') ? s.inputs : undefined,
    outputs: (s?.outputs && typeof s.outputs === 'object') ? s.outputs : undefined,
    started_at: Number(s?.started_at || 0) || undefined,
    ended_at: Number(s?.ended_at || 0) || undefined,
  }));
  const tool_calls: TurnExecutionToolCallRecord[] = callsRaw.map((c: any, idx: number) => ({
    tool_call_id: String(c?.tool_call_id || `tool_${idx + 1}`),
    step_id: String(c?.step_id || ''),
    step_type: ((): TurnExecutionStepType => {
      const t = String(c?.step_type || '').toLowerCase();
      if (t === 'analyze_intent') return 'analyze_intent';
      if (t === 'select_targets') return 'select_targets';
      if (t === 'execute_changes') return 'execute_changes';
      if (t === 'verify_outcome') return 'verify_outcome';
      if (t === 'finalize_reply') return 'finalize_reply';
      return 'execute_changes';
    })(),
    tool_name: String(c?.tool_name || 'tool'),
    args: c?.args ?? {},
    result_summary: c?.result_summary ? String(c.result_summary) : undefined,
    status: ((): 'running' | 'ok' | 'error' => {
      const s = String(c?.status || '').toLowerCase();
      if (s === 'running') return 'running';
      if (s === 'error') return 'error';
      return 'ok';
    })(),
    phase: String(c?.phase || '').toLowerCase() === 'result' ? 'result' : 'call',
    timestamp: Number(c?.timestamp || now) || now,
  }));
  const verification = raw.verification && typeof raw.verification === 'object'
    ? {
      expected: (raw.verification.expected && typeof raw.verification.expected === 'object') ? raw.verification.expected : {},
      actual: (raw.verification.actual && typeof raw.verification.actual === 'object') ? raw.verification.actual : {},
      status: String(raw.verification.status || '').toLowerCase() === 'fail' ? 'fail' : 'pass',
      repairs_applied: Array.isArray(raw.verification.repairs_applied) ? raw.verification.repairs_applied.map((x: any) => String(x || '')) : [],
      errors: Array.isArray(raw.verification.errors) ? raw.verification.errors.map((x: any) => String(x || '')) : [],
      checked_at: Number(raw.verification.checked_at || now) || now,
    } as TurnExecutionVerification
    : undefined;
  const decision_trace = raw.decision_trace && typeof raw.decision_trace === 'object'
    ? {
      raw_user_message: String(raw.decision_trace.raw_user_message || raw.objective_raw || ''),
      normalized_message: raw.decision_trace.normalized_message ? String(raw.decision_trace.normalized_message) : undefined,
      events: Array.isArray(raw.decision_trace.events)
        ? raw.decision_trace.events.map((e: any) => ({
          ts: Number(e?.ts || now) || now,
          stage: ((): DecisionTraceStage => {
            const s = String(e?.stage || '').toLowerCase();
            if (s === 'routing') return 'routing';
            if (s === 'clause_split') return 'clause_split';
            if (s === 'deterministic_candidates') return 'deterministic_candidates';
            if (s === 'selected_plan') return 'selected_plan';
            if (s === 'execution') return 'execution';
            if (s === 'verification') return 'verification';
            if (s === 'finalize') return 'finalize';
            return 'fallback';
          })(),
          message: String(e?.message || ''),
          data: e?.data,
        }))
        : [],
    } as DecisionTrace
    : undefined;
  return {
    turn_id: String(raw.turn_id || randomUUID()),
    created_at: Number(raw.created_at || now) || now,
    updated_at: Number(raw.updated_at || now) || now,
    objective_raw: String(raw.objective_raw || ''),
    objective_normalized: raw.objective_normalized ? String(raw.objective_normalized) : undefined,
    mode: ((): TurnExecution['mode'] => {
      const m = String(raw.mode || '').toLowerCase();
      if (m === 'execute') return 'execute';
      if (m === 'plan') return 'plan';
      if (m === 'chat') return 'chat';
      if (m === 'coach') return 'coach';
      return 'discuss';
    })(),
    turn_kind: ((): TurnKind => {
      const k = String(raw.turn_kind || '').toLowerCase();
      if (k === 'plan') return 'plan';
      if (k === 'continue_plan') return 'continue_plan';
      if (k === 'new_objective') return 'new_objective';
      if (k === 'side_question') return 'side_question';
      return 'discuss';
    })(),
    status: toTurnExecutionStatus(raw.status),
    steps,
    tool_calls,
    verification,
    decision_trace,
    final_summary: raw.final_summary ? String(raw.final_summary) : undefined,
  };
}

function getAgentSessionState(sessionId: string): AgentSessionState {
  const existing = agentSessions.get(sessionId);
  if (existing) return existing;
  try {
    const loaded = db.getAgentSessionState(sessionId);
    if (loaded && typeof loaded === 'object') {
      const restored: AgentSessionState = {
        sessionId,
        mode: (loaded.mode === 'plan' || loaded.mode === 'execute') ? loaded.mode : 'discuss',
        modeLock: (loaded.modeLock === 'chat' || loaded.modeLock === 'agent') ? loaded.modeLock : null,
        objective: String(loaded.objective || ''),
        activeObjective: String(loaded.activeObjective || ''),
        summary: String(loaded.summary || ''),
        tasks: Array.isArray(loaded.tasks) ? loaded.tasks : [],
        turns: Array.isArray(loaded.turns) ? loaded.turns : [],
        notes: Array.isArray(loaded.notes) ? loaded.notes : [],
        decisions: Array.isArray(loaded.decisions) ? loaded.decisions : [],
        pendingQuestions: Array.isArray(loaded.pendingQuestions) ? loaded.pendingQuestions : [],
        lastEvidence: loaded.lastEvidence && typeof loaded.lastEvidence === 'object' ? loaded.lastEvidence : undefined,
        verifiedFacts: Array.isArray((loaded as any).verifiedFacts) ? (loaded as any).verifiedFacts : [],
        lastStyleMutation: ((loaded as any).lastStyleMutation && typeof (loaded as any).lastStyleMutation === 'object')
          ? {
            color: String((loaded as any).lastStyleMutation.color || '').trim().toLowerCase(),
            property: (String((loaded as any).lastStyleMutation.property || '').toLowerCase() === 'text' ? 'text' : 'background'),
            target: (String((loaded as any).lastStyleMutation.target || '').toLowerCase() === 'panel' ? 'panel' : 'page'),
            target_path: String((loaded as any).lastStyleMutation.target_path || '').trim() || undefined,
            updated_at: Number((loaded as any).lastStyleMutation.updated_at || Date.now()),
          }
          : undefined,
        lastFilePath: String((loaded as any).lastFilePath || '').trim() || undefined,
        recentFilePaths: Array.isArray((loaded as any).recentFilePaths) ? (loaded as any).recentFilePaths.map((x: any) => String(x || '')).filter(Boolean) : [],
        pendingConfirmation: ((loaded as any).pendingConfirmation && typeof (loaded as any).pendingConfirmation === 'object')
          ? {
            id: String((loaded as any).pendingConfirmation.id || randomUUID().slice(0, 8)),
            requested_at: Number((loaded as any).pendingConfirmation.requested_at || Date.now()),
            source_turn_id: String((loaded as any).pendingConfirmation.source_turn_id || ''),
            question: String((loaded as any).pendingConfirmation.question || '').trim(),
            original_user_message: String((loaded as any).pendingConfirmation.original_user_message || '').trim(),
            resume_message: String((loaded as any).pendingConfirmation.resume_message || '').trim(),
          }
          : undefined,
        currentTurnExecution: sanitizeTurnExecution((loaded as any).currentTurnExecution) || undefined,
        recentTurnExecutions: Array.isArray((loaded as any).recentTurnExecutions)
          ? (loaded as any).recentTurnExecutions.map((x: any) => sanitizeTurnExecution(x)).filter(Boolean) as TurnExecution[]
          : [],
        continuationDepth: 0,
        continuationOriginMessage: '',
        continuationLastTaskSnapshot: '',
        updatedAt: Number(loaded.updatedAt || Date.now()),
      };
      if ((!restored.recentFilePaths || restored.recentFilePaths.length === 0) && restored.lastFilePath) {
        restored.recentFilePaths = [path.resolve(restored.lastFilePath)];
      }
      agentSessions.set(sessionId, restored);
      return restored;
    }
  } catch {
    // ignore and build new state
  }
  const created: AgentSessionState = {
    sessionId,
    mode: 'discuss',
    modeLock: null,
    objective: '',
    activeObjective: '',
    summary: '',
    tasks: [],
    turns: [],
    notes: [],
    decisions: [],
    pendingQuestions: [],
    lastEvidence: undefined,
    verifiedFacts: [],
    lastStyleMutation: undefined,
    lastFilePath: undefined,
    recentFilePaths: [],
    pendingConfirmation: undefined,
    currentTurnExecution: undefined,
    recentTurnExecutions: [],
    continuationDepth: 0,
    continuationOriginMessage: '',
    continuationLastTaskSnapshot: '',
    updatedAt: Date.now(),
  };
  agentSessions.set(sessionId, created);
  persistAgentSessionState(created);
  return created;
}

function compactLines(lines: string[], max = 10): string[] {
  const cleaned = lines.map(s => s.trim()).filter(Boolean);
  return cleaned.length > max ? cleaned.slice(cleaned.length - max) : cleaned;
}

function getExecutionStepTitles(
  mode: AgentMode | 'chat' | 'coach',
  turnKind?: TurnKind
): Record<TurnExecutionStepType, string> {
  if (mode === 'execute') {
    return {
      analyze_intent: 'Analyze intent',
      select_targets: 'Select strategy',
      execute_changes: 'Run tool cycle',
      verify_outcome: 'Verify outcome',
      finalize_reply: 'Finalize reply',
    };
  }
  if (mode === 'plan' || mode === 'coach' || turnKind === 'plan') {
    return {
      analyze_intent: 'Analyze intent',
      select_targets: 'Draft coach reply',
      execute_changes: 'Plan/task signals',
      verify_outcome: 'Mode switch check',
      finalize_reply: 'Finalize reply',
    };
  }
  return {
    analyze_intent: 'Analyze intent',
    select_targets: 'Draft discuss reply',
    execute_changes: 'Trigger evaluation',
    verify_outcome: 'Mode switch check',
    finalize_reply: 'Finalize reply',
  };
}

function applyExecutionStepProfile(
  execution: TurnExecution,
  mode: AgentMode | 'chat' | 'coach',
  turnKind?: TurnKind,
  opts?: { reactivateExecuteSteps?: boolean }
): void {
  const titles = getExecutionStepTitles(mode, turnKind);
  const now = Date.now();
  for (const step of execution.steps || []) {
    const title = titles[step.type as TurnExecutionStepType];
    if (title) step.title = title;
  }
  if (mode === 'execute' && opts?.reactivateExecuteSteps) {
    for (const stepType of ['select_targets', 'execute_changes', 'verify_outcome'] as TurnExecutionStepType[]) {
      const step = (execution.steps || []).find((s) => s.type === stepType);
      if (!step) continue;
      if (step.status === 'skipped' || step.status === 'done') {
        step.status = 'pending';
        step.ended_at = undefined;
      }
      if (!step.started_at) step.started_at = now;
    }
  }
  execution.updated_at = now;
}

function buildDefaultExecutionSteps(mode: AgentMode | 'chat' | 'coach', turnKind?: TurnKind): TurnExecutionStep[] {
  const titles = getExecutionStepTitles(mode, turnKind);
  const steps: Array<{ type: TurnExecutionStepType; title: string }> = [
    { type: 'analyze_intent', title: titles.analyze_intent },
    { type: 'select_targets', title: titles.select_targets },
    { type: 'execute_changes', title: titles.execute_changes },
    { type: 'verify_outcome', title: titles.verify_outcome },
    { type: 'finalize_reply', title: titles.finalize_reply },
  ];
  return steps.map((s, idx) => ({
    step_id: `step_${idx + 1}_${s.type}`,
    type: s.type,
    title: s.title,
    status: s.type === 'analyze_intent' ? 'running' : 'pending',
    inputs: {},
    outputs: {},
    started_at: s.type === 'analyze_intent' ? Date.now() : undefined,
    ended_at: undefined,
  }));
}

function upsertRecentTurnExecution(state: AgentSessionState, execution: TurnExecution): void {
  const copy = cloneTurnExecution(execution);
  const prev = Array.isArray(state.recentTurnExecutions) ? state.recentTurnExecutions : [];
  const filtered = prev.filter(x => String(x?.turn_id || '') !== String(copy.turn_id || ''));
  state.recentTurnExecutions = [copy, ...filtered].slice(0, 25);
}

function getTurnExecutionStep(state: AgentSessionState, stepType: TurnExecutionStepType): TurnExecutionStep | undefined {
  const steps = state.currentTurnExecution?.steps || [];
  return steps.find(s => s.type === stepType);
}

function updateTurnExecutionStep(
  state: AgentSessionState,
  stepType: TurnExecutionStepType,
  patch: Partial<TurnExecutionStep>,
  persist = true
): void {
  const execution = state.currentTurnExecution;
  if (!execution) return;
  const step = execution.steps.find(s => s.type === stepType);
  if (!step) return;
  Object.assign(step, patch || {});
  execution.updated_at = Date.now();
  state.updatedAt = execution.updated_at;
  if (persist) persistAgentSessionState(state);
}

function setTurnExecutionStepStatus(
  state: AgentSessionState,
  stepType: TurnExecutionStepType,
  status: TurnExecutionStepStatus,
  outputs?: Record<string, any>,
  persist = true
): void {
  const execution = state.currentTurnExecution;
  if (!execution) return;
  const step = execution.steps.find(s => s.type === stepType);
  if (!step) return;
  if (status === 'running' && !step.started_at) step.started_at = Date.now();
  if ((status === 'done' || status === 'failed' || status === 'skipped') && !step.ended_at) {
    step.ended_at = Date.now();
  }
  step.status = status;
  if (outputs && typeof outputs === 'object') {
    step.outputs = { ...(step.outputs || {}), ...outputs };
  }
  execution.updated_at = Date.now();
  state.updatedAt = execution.updated_at;
  if (persist) persistAgentSessionState(state);
}

function setTurnExecutionStatus(state: AgentSessionState, status: TurnExecutionStatus, persist = true): void {
  if (!state.currentTurnExecution) return;
  state.currentTurnExecution.status = status;
  state.currentTurnExecution.updated_at = Date.now();
  state.updatedAt = state.currentTurnExecution.updated_at;
  if (persist) persistAgentSessionState(state);
}

function appendTurnExecutionToolCall(
  state: AgentSessionState,
  opts: {
    stepType?: TurnExecutionStepType;
    toolName: string;
    args?: any;
    resultSummary?: string;
    status: 'running' | 'ok' | 'error';
    phase: 'call' | 'result';
  },
  persist = true
): void {
  const execution = state.currentTurnExecution;
  if (!execution) return;
  const stepType = opts.stepType || 'execute_changes';
  const step = execution.steps.find(s => s.type === stepType) || execution.steps.find(s => s.type === 'execute_changes');
  const stepId = String(step?.step_id || execution.steps[0]?.step_id || 'step_execute');
  const toolName = String(opts.toolName || 'tool');
  const toolLower = toolName.toLowerCase();
  const summaryMax = toolLower === 'list' ? 8000 : 1200;
  execution.tool_calls.push({
    tool_call_id: randomUUID(),
    step_id: stepId,
    step_type: stepType,
    tool_name: toolName,
    args: opts.args ?? {},
    result_summary: opts.resultSummary ? String(opts.resultSummary).slice(0, summaryMax) : undefined,
    status: opts.status,
    phase: opts.phase,
    timestamp: Date.now(),
  });
  if (execution.tool_calls.length > 120) {
    execution.tool_calls = execution.tool_calls.slice(execution.tool_calls.length - 120);
  }
  execution.updated_at = Date.now();
  state.updatedAt = execution.updated_at;
  if (persist) persistAgentSessionState(state);
}

function setTurnExecutionVerification(
  state: AgentSessionState,
  verification: TurnExecutionVerification,
  persist = true
): void {
  if (!state.currentTurnExecution) return;
  state.currentTurnExecution.verification = verification;
  setTurnExecutionStepStatus(state, 'verify_outcome', verification.status === 'pass' ? 'done' : 'failed', {
    status: verification.status,
    repairs: verification.repairs_applied || [],
    errors: verification.errors || [],
  }, false);
  if (verification.status === 'fail') {
    setTurnExecutionStatus(state, 'failed', false);
  }
  if (state.currentTurnExecution) {
    const trace = state.currentTurnExecution.decision_trace
      || {
        raw_user_message: String(state.currentTurnExecution.objective_raw || ''),
        normalized_message: state.currentTurnExecution.objective_normalized,
        events: [],
      };
    trace.events.push({
      ts: Date.now(),
      stage: 'verification',
      message: verification.status === 'pass' ? 'Verification passed.' : 'Verification failed.',
      data: {
        expected: verification.expected,
        actual: verification.actual,
        repairs_applied: verification.repairs_applied || [],
        errors: verification.errors || [],
      },
    });
    if (trace.events.length > 220) trace.events = trace.events.slice(trace.events.length - 220);
    state.currentTurnExecution.decision_trace = trace;
  }
  state.currentTurnExecution.updated_at = Date.now();
  state.updatedAt = state.currentTurnExecution.updated_at;
  if (persist) persistAgentSessionState(state);
}

function appendDecisionTraceEvent(
  state: AgentSessionState,
  stage: DecisionTraceStage,
  message: string,
  data?: any,
  persist = true
): void {
  const execution = state.currentTurnExecution;
  if (!execution) return;
  if (!execution.decision_trace) {
    execution.decision_trace = {
      raw_user_message: String(execution.objective_raw || ''),
      normalized_message: execution.objective_normalized,
      events: [],
    };
  }
  execution.decision_trace.events.push({
    ts: Date.now(),
    stage,
    message: String(message || '').slice(0, 260),
    data,
  });
  if (execution.decision_trace.events.length > 220) {
    execution.decision_trace.events = execution.decision_trace.events.slice(execution.decision_trace.events.length - 220);
  }
  execution.updated_at = Date.now();
  state.updatedAt = execution.updated_at;
  if (persist) persistAgentSessionState(state);
}

function beginTurnExecution(
  state: AgentSessionState,
  args: { objectiveRaw: string; objectiveNormalized?: string; mode: AgentMode | 'chat' | 'coach'; turnKind: TurnKind; }
): TurnExecution {
  const now = Date.now();
  const previous = state.currentTurnExecution;
  if (previous && !['done', 'failed', 'repaired'].includes(previous.status)) {
    previous.status = 'failed';
    previous.final_summary = previous.final_summary || 'Superseded by a newer turn before completion.';
    previous.updated_at = now;
    upsertRecentTurnExecution(state, previous);
  } else if (previous) {
    upsertRecentTurnExecution(state, previous);
  }

  const execution: TurnExecution = {
    turn_id: randomUUID(),
    created_at: now,
    updated_at: now,
    objective_raw: String(args.objectiveRaw || ''),
    objective_normalized: String(args.objectiveNormalized || '').trim() || undefined,
    mode: args.mode,
    turn_kind: args.turnKind,
    status: 'running',
    steps: buildDefaultExecutionSteps(args.mode, args.turnKind),
    tool_calls: [],
    decision_trace: {
      raw_user_message: String(args.objectiveRaw || ''),
      normalized_message: String(args.objectiveNormalized || '').trim() || undefined,
      events: [],
    },
  };
  state.currentTurnExecution = execution;
  setTurnExecutionStepStatus(state, 'analyze_intent', 'done', {
    mode: args.mode,
    turn_kind: args.turnKind,
  }, false);
  state.updatedAt = now;
  persistAgentSessionState(state);
  return execution;
}

function finalizeCurrentTurnExecution(
  state: AgentSessionState,
  finalStatus: TurnExecutionStatus,
  finalSummary: string
): void {
  const execution = state.currentTurnExecution;
  if (!execution) return;
  const now = Date.now();
  const hasTools = Array.isArray(execution.tool_calls) && execution.tool_calls.length > 0;
  for (const step of execution.steps) {
    if (step.type === 'finalize_reply') continue;
    if (step.status === 'pending') {
      if (step.type === 'analyze_intent') {
        step.status = 'done';
      } else if (step.type === 'select_targets') {
        step.status = hasTools ? 'done' : (finalStatus === 'failed' && execution.mode === 'execute' ? 'failed' : 'skipped');
      } else if (step.type === 'execute_changes') {
        step.status = hasTools ? 'done' : (finalStatus === 'failed' && execution.mode === 'execute' ? 'failed' : 'skipped');
      } else if (step.type === 'verify_outcome') {
        step.status = hasTools ? 'done' : (finalStatus === 'failed' && execution.mode === 'execute' ? 'failed' : 'skipped');
      }
      if (!step.ended_at) step.ended_at = now;
    } else if (step.status === 'running') {
      if (!hasTools && finalStatus === 'failed' && execution.mode === 'execute') {
        step.status = 'failed';
      } else {
        step.status = step.type === 'verify_outcome' && !hasTools ? 'skipped' : 'done';
      }
      if (!step.ended_at) step.ended_at = now;
    }
  }
  if (execution.status === 'failed' && finalStatus !== 'failed') {
    // Preserve an explicit failure status if it was already set.
  } else {
    execution.status = finalStatus;
  }
  appendDecisionTraceEvent(state, 'finalize', `Turn finalized as ${execution.status}.`, {
    status: execution.status,
    summary: String(finalSummary || '').slice(0, 240),
  }, false);
  setTurnExecutionStepStatus(state, 'finalize_reply', execution.status === 'failed' ? 'failed' : 'done', {
    summary: String(finalSummary || '').slice(0, 400),
  }, false);
  execution.final_summary = String(finalSummary || '').slice(0, 800);
  execution.updated_at = Date.now();
  state.updatedAt = execution.updated_at;
  upsertRecentTurnExecution(state, execution);
  persistAgentSessionState(state);
}

const SELF_HEAL_ELIGIBLE_TOOLS = new Set([
  'write',
  'edit',
  'append',
  'delete',
  'rename',
  'copy',
  'mkdir',
]);
const AUTO_REPAIR_SKILL_COOLDOWN_MS = 10 * 60_000;
const AUTO_REPAIR_MAX_SKILLS = 40;
const recentAutoRepairSkillWrites = new Map<string, number>();

function sanitizeAutoSkillText(input: string, maxLen = 180): string {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .trim()
    .slice(0, maxLen);
}

function buildAutoRepairSkillId(seed: string, toolName: string): string {
  const digest = createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 10);
  const safeTool = String(toolName || 'tool').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  return `auto_repair_${safeTool}_${digest}`;
}

function pruneAutoRepairSkills(maxKeep = AUTO_REPAIR_MAX_SKILLS): void {
  try {
    const manifests = listSkillManifests()
      .filter((m: any) => /^auto_repair_[a-z0-9_]+_[a-f0-9]{10}$/i.test(String(m?.id || '')))
      .sort((a: any, b: any) => Number(b?.generated_at || 0) - Number(a?.generated_at || 0));
    const overflow = manifests.slice(Math.max(0, maxKeep));
    for (const m of overflow) {
      removeSkillPack(String(m.id || ''));
    }
  } catch {
    // Ignore pruning errors to avoid impacting active turn completion.
  }
}

function extractAutoRepairSkillCandidate(
  execution: TurnExecution
): { toolName: string; args: any; objective: string; resultSummary: string } | null {
  const calls = Array.isArray(execution.tool_calls) ? execution.tool_calls : [];
  if (!calls.length) return null;
  const result = [...calls].reverse().find((c) => {
    const tool = String(c?.tool_name || '').toLowerCase();
    return c?.phase === 'result' && c?.status === 'ok' && SELF_HEAL_ELIGIBLE_TOOLS.has(tool);
  });
  if (!result) return null;
  const toolName = String(result.tool_name || '').trim();
  if (!toolName) return null;
  const argsRecord = [...calls].reverse().find((c) => {
    return c?.phase === 'call' && String(c?.tool_name || '').toLowerCase() === toolName.toLowerCase();
  });
  const objective = sanitizeAutoSkillText(String(execution.objective_normalized || execution.objective_raw || ''), 220);
  if (!objective) return null;
  return {
    toolName,
    args: (argsRecord && typeof argsRecord.args === 'object' && argsRecord.args) ? argsRecord.args : {},
    objective,
    resultSummary: sanitizeAutoSkillText(String(result.result_summary || ''), 220),
  };
}

function buildAutoRepairSkillMarkdown(input: {
  toolName: string;
  objective: string;
  pathHint: string;
  resultSummary: string;
}): string {
  const tool = sanitizeAutoSkillText(input.toolName, 40);
  const objective = sanitizeAutoSkillText(input.objective, 220);
  const pathHint = sanitizeAutoSkillText(input.pathHint, 120);
  const resultSummary = sanitizeAutoSkillText(input.resultSummary, 180);
  const lines: string[] = [];
  lines.push(`# Auto Repair Skill (${tool})`);
  lines.push('');
  lines.push('Use this tool-guidance skill when a similar request failed once and later succeeded.');
  lines.push('');
  lines.push(`Observed successful request: "${objective}".`);
  lines.push(`Primary tool used: ${tool}.`);
  if (pathHint) lines.push(`Target file hint: ${pathHint}.`);
  if (resultSummary) lines.push(`Last verified result summary: ${resultSummary}.`);
  lines.push('');
  lines.push('Rules:');
  lines.push('- Treat similar requests as execute/file-operation turns, not discuss chat.');
  lines.push('- Apply the smallest non-destructive change that satisfies the request.');
  lines.push('- Preserve existing content/structure unless the user explicitly asks to replace it.');
  lines.push('- Re-check the target after mutation and retry once if verification fails.');
  lines.push('- Use tool outputs as truth; do not invent completion.');
  return lines.join('\n').trim() + '\n';
}

function maybeWriteAutoRepairSkill(
  state: AgentSessionState,
  execution: TurnExecution,
  finalStatus: TurnExecutionStatus
): { written: boolean; skillId?: string; reason?: string } {
  if (!FEATURE_FLAGS.self_heal_skill_autowrite) return { written: false, reason: 'feature_disabled' };
  if (finalStatus !== 'repaired') return { written: false, reason: 'not_repaired' };
  if (execution.mode !== 'execute') return { written: false, reason: 'mode_not_execute' };
  const candidate = extractAutoRepairSkillCandidate(execution);
  if (!candidate) return { written: false, reason: 'no_candidate' };
  if (candidate.objective.length < 18) return { written: false, reason: 'objective_too_short' };
  const pathHint = sanitizeAutoSkillText(String(candidate.args?.path || candidate.args?.new_path || ''), 140);
  const seed = `${candidate.objective}|${candidate.toolName}|${pathHint}`;
  const skillId = buildAutoRepairSkillId(seed, candidate.toolName);
  const now = Date.now();
  const lastWrite = Number(recentAutoRepairSkillWrites.get(skillId) || 0);
  if (lastWrite && now - lastWrite < AUTO_REPAIR_SKILL_COOLDOWN_MS) {
    return { written: false, reason: 'cooldown_active', skillId };
  }

  try {
    const skillMdContent = buildAutoRepairSkillMarkdown({
      toolName: candidate.toolName,
      objective: candidate.objective,
      pathHint: pathHint ? path.basename(pathHint) : '',
      resultSummary: candidate.resultSummary,
    });
    const manifest = writeSkillPackFromContent({
      id: skillId,
      skillMdContent,
      sourceType: 'manual',
      sourceFilename: 'auto-repair',
    });
    pruneAutoRepairSkills(AUTO_REPAIR_MAX_SKILLS);
    recentAutoRepairSkillWrites.set(skillId, now);
    appendDailyMemoryNote(`[auto_skill][repaired] id=${manifest.id} tool=${candidate.toolName} objective="${candidate.objective}"`);
    appendDecisionTraceEvent(state, 'finalize', 'Auto-generated repair skill from repaired execute turn.', {
      skill_id: manifest.id,
      tool: candidate.toolName,
      objective: candidate.objective,
    }, false);
    return { written: true, skillId: manifest.id };
  } catch (err: any) {
    return { written: false, reason: `write_failed:${String(err?.message || err || 'unknown')}` };
  }
}

function isFailureLikeFinalReply(reply: string): boolean {
  const r = String(reply || '').toLowerCase();
  if (!r) return false;
  if (/^\s*blocked\b/.test(r)) return true;
  if (/\bi could not\b[\s\S]*\b(valid|format|reliable|synthes|extract|answer)\b/.test(r)) return true;
  if (/\bi couldn'?t\b[\s\S]*\b(valid|format|reliable|synthes|extract|answer)\b/.test(r)) return true;
  if (/\bfailed\b/.test(r) && /\b(step|tool|operation|request|format|synthesis)\b/.test(r)) return true;
  if (/\berror\b/.test(r) && /\b(tool|request|synthesis|execution)\b/.test(r)) return true;
  return false;
}

function normalizeTaskTitleForMatch(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, '\'')
    .trim();
}

function buildTurnTaskTitle(message: string): string {
  const trimmed = String(message || '').trim();
  if (!trimmed) return '';
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

function completeTaskForTurn(
  state: AgentSessionState,
  message: string,
  status: 'done' | 'failed'
): void {
  const title = buildTurnTaskTitle(message);
  const normalizedTitle = normalizeTaskTitleForMatch(title);
  let idx = -1;
  for (let i = state.tasks.length - 1; i >= 0; i--) {
    const t = state.tasks[i];
    if (t.status !== 'in_progress') continue;
    if (normalizeTaskTitleForMatch(String(t.title || '')) === normalizedTitle) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    for (let i = state.tasks.length - 1; i >= 0; i--) {
      if (state.tasks[i].status === 'in_progress') {
        idx = i;
        break;
      }
    }
  }
  if (idx >= 0) state.tasks[idx].status = status;
}

type ParsedPlanTask = {
  model_task_id: string;
  title: string;
};

type ParsedPlanSignals = {
  open_plan: boolean;
  open_tool: boolean;
  open_web: boolean;
  plan_done: boolean;
  task_done_ids: string[];
  task_continue_ids: string[];
  task_blocked_ids: string[];
  tasks: ParsedPlanTask[];
};

function normalizeModelTaskId(input: string): string {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!raw) return '';
  const m = raw.match(/T\d+/);
  if (m?.[0]) return m[0];
  return raw.slice(0, 12);
}

function parsePlanTasksFromText(input: string): ParsedPlanTask[] {
  const raw = String(input || '');
  if (!raw) return [];
  const out: ParsedPlanTask[] = [];
  const seen = new Set<string>();

  // Explicit task lines: "T1: do x" or "- T2 - do y"
  const explicit = Array.from(raw.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?(?:task\s*)?(T\d+)\s*[:\-]\s*(.+?)(?=\n|$)/ig));
  for (const m of explicit) {
    const id = normalizeModelTaskId(String(m[1] || ''));
    const title = String(m[2] || '').trim();
    if (!id || !title) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ model_task_id: id, title: title.slice(0, 180) });
  }

  // Generic checkbox/bullet tasks if explicit ids are missing.
  if (out.length === 0) {
    const bullets = Array.from(raw.matchAll(/(?:^|\n)\s*(?:[-*]|\d+\.)\s*(?:\[[ xX]\]\s*)?(.+?)(?=\n|$)/g))
      .map((m) => String(m[1] || '').trim())
      .filter(Boolean)
      .filter((line) => !/^(open_plan|open_tool|open_web|plan_done|task_done:|task_continue:|task_blocked:)/i.test(line))
      .slice(0, 8);
    for (let i = 0; i < bullets.length; i++) {
      const id = `T${i + 1}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ model_task_id: id, title: bullets[i].slice(0, 180) });
    }
  }

  return out.slice(0, 8);
}

function parsePlanSignals(replyText: string, thinkingText: string): ParsedPlanSignals {
  // Parse control tokens from assistant reply text only.
  // Thinking can echo prompt instructions and cause false trigger matches.
  const replyOnly = String(replyText || '');
  const normalized = normalizeTriggerScanText(replyOnly);
  const task_done_ids = Array.from(replyOnly.matchAll(/\btask_done\s*:\s*([A-Za-z0-9_-]+)/ig))
    .map((m) => normalizeModelTaskId(String(m[1] || '')))
    .filter(Boolean);
  const task_continue_ids = Array.from(replyOnly.matchAll(/\btask_continue\s*:\s*([A-Za-z0-9_-]+)/ig))
    .map((m) => normalizeModelTaskId(String(m[1] || '')))
    .filter(Boolean);
  const task_blocked_ids = Array.from(replyOnly.matchAll(/\btask_blocked\s*:\s*([A-Za-z0-9_-]+)/ig))
    .map((m) => normalizeModelTaskId(String(m[1] || '')))
    .filter(Boolean);
  return {
    open_plan: /\bopen[_\s-]?plan\b/.test(normalized),
    open_tool: /\bopen[_\s-]?tool\b/.test(normalized),
    open_web: /\bopen[_\s-]?web\b/.test(normalized),
    plan_done: /\bplan[_\s-]?done\b/.test(normalized),
    task_done_ids: Array.from(new Set(task_done_ids)),
    task_continue_ids: Array.from(new Set(task_continue_ids)),
    task_blocked_ids: Array.from(new Set(task_blocked_ids)),
    tasks: parsePlanTasksFromText(replyText),
  };
}

type ExecuteControlSignals = {
  open_confirm: boolean;
  confirm_question: string;
  cleaned_reply: string;
};

function parseExecuteControlSignals(replyText: string, thinkingText: string): ExecuteControlSignals {
  const reply = String(replyText || '').trim();
  const thinking = String(thinkingText || '').trim();
  const hasInReply = /\bopen[_\s-]?confirm\b/i.test(reply);
  const looksLikeConfirmQuestion = /\?/.test(reply) || /\b(continue|proceed|yes|no|confirm)\b/i.test(reply);
  const hasInThinking = /\bopen[_\s-]?confirm\b/i.test(thinking) && looksLikeConfirmQuestion;
  const hasOpenConfirm = hasInReply || hasInThinking;
  if (!hasOpenConfirm) {
    return {
      open_confirm: false,
      confirm_question: '',
      cleaned_reply: reply,
    };
  }
  const cleaned = reply
    .replace(/^\s*open[_\s-]?confirm(?:\s*:\s*.*)?$/gim, '')
    .replace(/\bopen[_\s-]?confirm\b/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const question = (cleaned || 'This action is destructive. Do you want me to continue? Reply yes or no.')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    open_confirm: true,
    confirm_question: question,
    cleaned_reply: question,
  };
}

function parseBinaryConfirmationDecision(message: string): 'approve' | 'reject' | null {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return null;
  if (/^(yes|y|yeah|yep|sure|ok|okay|do it|go ahead|proceed|continue|confirm|approved?)\b/.test(m)) return 'approve';
  if (/\b(yes|y|yeah|yep|sure|ok|okay|do it|go ahead|proceed|continue|confirm|approved?)\b/.test(m) && m.length <= 20) return 'approve';
  if (/^(no|n|nah|nope|stop|cancel|dont|don't|do not|reject|decline)\b/.test(m)) return 'reject';
  if (/\b(no|n|nah|nope|stop|cancel|dont|don't|do not|reject|decline)\b/.test(m) && m.length <= 28) return 'reject';
  return null;
}

function findTaskByModelId(state: AgentSessionState, modelTaskId: string): PlanTask | null {
  const id = normalizeModelTaskId(modelTaskId);
  if (!id) return null;
  const exact = state.tasks.find((t) => normalizeModelTaskId(String((t as any).model_task_id || '')) === id);
  if (exact) return exact;
  const titlePrefix = state.tasks.find((t) => new RegExp(`^\\s*${id}\\b`, 'i').test(String(t.title || '')));
  if (titlePrefix) return titlePrefix;
  return null;
}

function upsertModelPlanTasks(state: AgentSessionState, tasks: ParsedPlanTask[]): number {
  let added = 0;
  for (const task of tasks) {
    const id = normalizeModelTaskId(task.model_task_id);
    const title = String(task.title || '').trim();
    if (!id || !title) continue;
    const existing = findTaskByModelId(state, id);
    if (existing) {
      if (existing.status === 'done' || existing.status === 'failed') continue;
      existing.title = title;
      continue;
    }
    state.tasks.push({
      id: randomUUID().slice(0, 8),
      model_task_id: id,
      title: title,
      status: added === 0 ? 'in_progress' : 'pending',
      tool: suggestToolForTaskText(title),
    });
    added++;
  }
  if (state.tasks.length > 24) state.tasks = state.tasks.slice(state.tasks.length - 24);
  return added;
}

function applyPlanSignalsToSession(
  state: AgentSessionState,
  signals: ParsedPlanSignals,
  fallbackMessage: string
): { changed: boolean; summary: string[] } {
  let changed = false;
  const summary: string[] = [];

  if (signals.open_plan) {
    const tasks = signals.tasks.length
      ? signals.tasks
      : splitInstructionClauses(String(fallbackMessage || ''))
        .filter((c) => hasConcreteTaskVerb(c))
        .slice(0, 8)
        .map((title, idx) => ({ model_task_id: `T${idx + 1}`, title: String(title || '').trim() }));
    const added = upsertModelPlanTasks(state, tasks);
    if (added > 0) {
      changed = true;
      summary.push(`open_plan detected: added ${added} task(s).`);
    } else if (tasks.length > 0) {
      summary.push('open_plan detected: refreshed existing tasks.');
    }
  }

  for (const id of signals.task_done_ids) {
    const t = findTaskByModelId(state, id);
    if (!t) continue;
    t.status = 'done';
    changed = true;
    summary.push(`task_done:${id}`);
  }
  for (const id of signals.task_continue_ids) {
    const t = findTaskByModelId(state, id);
    if (!t) continue;
    t.status = 'in_progress';
    changed = true;
    summary.push(`task_continue:${id}`);
  }
  for (const id of signals.task_blocked_ids) {
    const t = findTaskByModelId(state, id);
    if (!t) continue;
    t.status = 'failed';
    changed = true;
    summary.push(`task_blocked:${id}`);
  }

  if (signals.plan_done) {
    let doneCount = 0;
    for (const t of state.tasks) {
      if (t.status === 'pending' || t.status === 'in_progress') {
        t.status = 'done';
        doneCount++;
      }
    }
    if (doneCount > 0) changed = true;
    summary.push(`plan_done${doneCount ? `: closed ${doneCount} task(s)` : ''}`);
  }

  if (changed) {
    state.updatedAt = Date.now();
    persistAgentSessionState(state);
  }
  return { changed, summary };
}

interface WorkspaceLedgerEntry {
  state: 'exists' | 'deleted';
  created_at?: string;
  updated_at: string;
  deleted_at?: string;
  summary?: string;
}

interface WorkspaceLedger {
  version: number;
  files: Record<string, WorkspaceLedgerEntry>;
}

interface SelfLearningRecord {
  id: string;
  ts: string;
  session_id: string;
  turn_id: string;
  objective: string;
  objective_key: string;
  mode: AgentMode | DiscussSubmode;
  final_status: TurnExecutionStatus;
  correction_cue: boolean;
  replay_cue: boolean;
  model_trigger: string;
  primary_tool: string;
}

interface SelfLearningPattern {
  key: string;
  objective_example: string;
  total: number;
  failures: number;
  successes: number;
  repaired_successes: number;
  correction_repairs: number;
  model_trigger_repairs: number;
  last_tool?: string;
  last_status?: TurnExecutionStatus;
  last_seen_at: string;
  promoted_skill_id?: string;
}

interface SelfLearningStore {
  version: number;
  records: SelfLearningRecord[];
  patterns: Record<string, SelfLearningPattern>;
}

const SELF_LEARNING_MAX_RECORDS = envInt('LOCALCLAW_SELF_LEARNING_MAX_RECORDS', 600);
const SELF_LEARNING_PROMOTE_REPAIRS = envInt('LOCALCLAW_SELF_LEARNING_PROMOTE_REPAIRS', 2);

function getWorkspaceLedgerPath(): string {
  const projectCfg = path.join(process.cwd(), '.localclaw');
  const cfgDir = fs.existsSync(projectCfg) ? projectCfg : path.join(os.homedir(), '.localclaw');
  return path.join(cfgDir, 'workspace_state.json');
}

function loadWorkspaceLedger(): WorkspaceLedger {
  const p = getWorkspaceLedgerPath();
  if (!fs.existsSync(p)) return { version: 1, files: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { version: 1, files: {} };
    const files = raw.files && typeof raw.files === 'object' ? raw.files : {};
    return { version: 1, files };
  } catch {
    return { version: 1, files: {} };
  }
}

function saveWorkspaceLedger(store: WorkspaceLedger): void {
  const p = getWorkspaceLedgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

function getSelfLearningPath(): string {
  const projectCfg = path.join(process.cwd(), '.localclaw');
  const cfgDir = fs.existsSync(projectCfg) ? projectCfg : path.join(os.homedir(), '.localclaw');
  return path.join(cfgDir, 'self_learning.json');
}

function loadSelfLearningStore(): SelfLearningStore {
  const p = getSelfLearningPath();
  if (!fs.existsSync(p)) return { version: 1, records: [], patterns: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { version: 1, records: [], patterns: {} };
    const records = Array.isArray(raw.records) ? raw.records : [];
    const patterns = raw.patterns && typeof raw.patterns === 'object' ? raw.patterns : {};
    return { version: 1, records, patterns };
  } catch {
    return { version: 1, records: [], patterns: {} };
  }
}

function saveSelfLearningStore(store: SelfLearningStore): void {
  const p = getSelfLearningPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

function hasCorrectionRetryCue(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  if (isRetryOnlyMessage(m) || isCorrectiveRetryCue(m)) return true;
  if (/\b(no|nah|not)\b[\s\S]{0,24}\b(work|working|updated|changed|fixed|done)\b/.test(m)) return true;
  if (/\b(didn'?t|did not|still)\b[\s\S]{0,24}\b(work|update|change|fix|do)\b/.test(m)) return true;
  if (/\byou (?:didn'?t|did not|still)\b/.test(m)) return true;
  return false;
}

function getExecutionPrimaryTool(execution: TurnExecution): string {
  const calls = Array.isArray(execution?.tool_calls) ? execution.tool_calls : [];
  const call = calls.find((c) => c?.phase === 'call' && String(c?.tool_name || '').trim());
  if (!call) return '';
  return String(call.tool_name || '').trim().toLowerCase();
}

function recordSelfLearningTurn(
  execution: TurnExecution,
  finalStatus: TurnExecutionStatus,
  opts: {
    sessionId: string;
    turnId: string;
    userMessage: string;
    triggerToken?: string;
  }
): { key: string; pattern: SelfLearningPattern; promoteReady: boolean; correctionRepair: boolean } {
  const objective = String(execution.objective_normalized || execution.objective_raw || '').trim();
  const key = normalizeFactKey(objective || opts.userMessage || 'turn');
  const nowIso = new Date().toISOString();
  const correctionCue = hasCorrectionRetryCue(opts.userMessage);
  const replayCue = isRetryOnlyMessage(opts.userMessage);
  const modelTrigger = String(opts.triggerToken || '').trim().toLowerCase();
  const primaryTool = getExecutionPrimaryTool(execution);

  const store = loadSelfLearningStore();
  const rec: SelfLearningRecord = {
    id: `sl_${randomUUID().slice(0, 12)}`,
    ts: nowIso,
    session_id: String(opts.sessionId || ''),
    turn_id: String(opts.turnId || ''),
    objective,
    objective_key: key,
    mode: execution.mode,
    final_status: finalStatus,
    correction_cue: correctionCue,
    replay_cue: replayCue,
    model_trigger: modelTrigger,
    primary_tool: primaryTool,
  };
  store.records.push(rec);
  if (store.records.length > SELF_LEARNING_MAX_RECORDS) {
    store.records = store.records.slice(store.records.length - SELF_LEARNING_MAX_RECORDS);
  }

  const prev = store.patterns[key] || {
    key,
    objective_example: objective || opts.userMessage.slice(0, 180),
    total: 0,
    failures: 0,
    successes: 0,
    repaired_successes: 0,
    correction_repairs: 0,
    model_trigger_repairs: 0,
    last_seen_at: nowIso,
  } as SelfLearningPattern;
  const next: SelfLearningPattern = {
    ...prev,
    objective_example: prev.objective_example || objective || opts.userMessage.slice(0, 180),
    total: Number(prev.total || 0) + 1,
    failures: Number(prev.failures || 0) + (finalStatus === 'failed' ? 1 : 0),
    successes: Number(prev.successes || 0) + (finalStatus === 'done' ? 1 : 0),
    repaired_successes: Number(prev.repaired_successes || 0) + (finalStatus === 'repaired' ? 1 : 0),
    correction_repairs: Number(prev.correction_repairs || 0) + ((finalStatus === 'repaired' && correctionCue) ? 1 : 0),
    model_trigger_repairs: Number(prev.model_trigger_repairs || 0) + ((finalStatus === 'repaired' && !!modelTrigger) ? 1 : 0),
    last_tool: primaryTool || prev.last_tool,
    last_status: finalStatus,
    last_seen_at: nowIso,
  };
  store.patterns[key] = next;
  saveSelfLearningStore(store);
  const promoteReady =
    !next.promoted_skill_id
    && next.repaired_successes >= SELF_LEARNING_PROMOTE_REPAIRS
    && (next.correction_repairs > 0 || next.model_trigger_repairs > 0);
  return {
    key,
    pattern: next,
    promoteReady,
    correctionRepair: finalStatus === 'repaired' && correctionCue,
  };
}

function markSelfLearningPromotion(patternKey: string, skillId: string): void {
  const key = String(patternKey || '').trim();
  const sid = String(skillId || '').trim();
  if (!key || !sid) return;
  try {
    const store = loadSelfLearningStore();
    const p = store.patterns[key];
    if (!p) return;
    p.promoted_skill_id = sid;
    p.last_seen_at = new Date().toISOString();
    store.patterns[key] = p;
    saveSelfLearningStore(store);
  } catch {
    // best-effort
  }
}

function updateWorkspaceLedgerFileState(
  action: 'exists' | 'deleted',
  filePath: string,
  summary?: string
): void {
  const p = String(filePath || '').trim();
  if (!p) return;
  try {
    const abs = path.resolve(path.isAbsolute(p) ? p : path.join(config.workspace.path, p));
    const rel = path.relative(config.workspace.path, abs) || path.basename(abs);
    const key = rel.replace(/\\/g, '/');
    const store = loadWorkspaceLedger();
    const nowIso = new Date().toISOString();
    const prev = store.files[key] || { state: 'exists', created_at: nowIso, updated_at: nowIso };
    const next: WorkspaceLedgerEntry = {
      ...prev,
      state: action,
      updated_at: nowIso,
    };
    if (action === 'exists' && !next.created_at) next.created_at = nowIso;
    if (action === 'deleted') next.deleted_at = nowIso;
    if (summary && summary.trim()) next.summary = summary.trim().slice(0, 180);
    store.files[key] = next;
    saveWorkspaceLedger(store);
  } catch {
    // non-fatal best-effort ledger update
  }
}

function buildWorkspaceLedgerSummary(max = 6): string[] {
  try {
    const store = loadWorkspaceLedger();
    const rows = Object.entries(store.files || {})
      .map(([file, data]) => ({ file, data: data || ({} as WorkspaceLedgerEntry) }))
      .sort((a, b) => String(b.data?.updated_at || '').localeCompare(String(a.data?.updated_at || '')));
    const exists = rows.filter(r => String(r.data?.state || '') === 'exists').slice(0, max);
    const deleted = rows.filter(r => String(r.data?.state || '') === 'deleted').slice(0, 2);
    return [
      ...exists.map(r => `- [exists] ${r.file}${r.data.summary ? ` (${r.data.summary})` : ''}`),
      ...deleted.map(r => `- [deleted] ${r.file}`),
    ];
  } catch {
    return [];
  }
}

function rememberRecentFilePath(state: AgentSessionState, candidatePath: string, summary?: string): void {
  const p = String(candidatePath || '').trim();
  if (!p) return;
  state.lastFilePath = p;
  const list = Array.isArray(state.recentFilePaths) ? state.recentFilePaths.slice() : [];
  const normalized = path.resolve(p);
  const next = [normalized, ...list.filter(x => {
    try { return path.resolve(String(x || '')) !== normalized; } catch { return String(x || '') !== normalized; }
  })].slice(0, 8);
  state.recentFilePaths = next;
  updateWorkspaceLedgerFileState('exists', p, summary);
}

function rememberLastStyleMutation(state: AgentSessionState, targetPath: string, intent: HtmlStyleMutationIntent): void {
  const p = String(targetPath || '').trim();
  const color = String(intent?.color || '').trim().toLowerCase();
  if (!p || !color) return;
  state.lastStyleMutation = {
    color,
    property: intent.property,
    target: intent.target,
    target_path: p,
    updated_at: Date.now(),
  };
}

function forgetRecentFilePath(state: AgentSessionState, candidatePath: string): void {
  const p = String(candidatePath || '').trim();
  if (!p) return;
  const normalized = path.resolve(p);
  const list = Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [];
  const next = list.filter(x => {
    try { return path.resolve(String(x || '')) !== normalized; } catch { return String(x || '') !== normalized; }
  });
  state.recentFilePaths = next;
  if (state.lastFilePath) {
    try {
      if (path.resolve(state.lastFilePath) === normalized) {
        state.lastFilePath = next.length ? String(next[0]) : undefined;
      }
    } catch {
      if (state.lastFilePath === normalized) state.lastFilePath = next.length ? String(next[0]) : undefined;
    }
  }
  if (state.lastStyleMutation?.target_path) {
    const lastStylePath = String(state.lastStyleMutation.target_path || '').trim();
    try {
      if (path.resolve(lastStylePath) === normalized) {
        state.lastStyleMutation = undefined;
      }
    } catch {
      if (lastStylePath === normalized) state.lastStyleMutation = undefined;
    }
  }
  updateWorkspaceLedgerFileState('deleted', normalized);
}

function appendFileLifecycleNote(action: 'deleted' | 'deleted_repair', filePath: string): void {
  const p = String(filePath || '').trim();
  if (!p) return;
  try {
    const name = path.basename(p);
    appendDailyMemoryNote(`[file_lifecycle] ${action}: ${name} (${new Date().toISOString()})`);
    updateWorkspaceLedgerFileState('deleted', p);
  } catch {
    // non-fatal
  }
}

function inferRequestedFileExtension(message: string): string {
  const m = normalizeCommonFileTypos(String(message || '').toLowerCase());
  if (/\bhtml?\b|\.html?\b/.test(m)) return '.html';
  if (/\bmarkdown\b|\.md\b/.test(m)) return '.md';
  if (/\bjson\b|\.json\b/.test(m)) return '.json';
  if (/\bcss\b|\.css\b/.test(m)) return '.css';
  if (/\bjavascript\b|\.js\b/.test(m)) return '.js';
  if (/\btypescript\b|\.ts\b/.test(m)) return '.ts';
  if (/\bpython\b|\.py\b/.test(m)) return '.py';
  return '.txt';
}

function buildDefaultFileName(ext: string, message: string): string {
  const m = String(message || '').toLowerCase();
  const wantsNew = /\b(brand new|whole new|new)\b/.test(m) || /\b(do not|don't|not)\s+modify\b/.test(m);
  let base = 'note';
  if (ext === '.html') base = 'index';
  if (ext === '.md') base = 'README';
  if (ext === '.json') base = 'data';
  let out = `${base}${ext}`;
  if (!wantsNew) return out;
  let n = 2;
  while (fs.existsSync(path.join(config.workspace.path, out)) && n <= 200) {
    out = `${base}_${n}${ext}`;
    n++;
  }
  return out;
}

function escapeHtmlText(v: string): string {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildBasicHtmlDocument(text: string, opts?: { blackBackground?: boolean; whiteText?: boolean; panel?: boolean }): string {
  const t = String(text || '').trim() || 'Hello world - i am localclaw';
  const blackBackground = !!opts?.blackBackground;
  const whiteText = !!opts?.whiteText;
  const panel = opts?.panel !== false;
  const bg = blackBackground ? '#000000' : '#111111';
  const fg = whiteText ? '#ffffff' : '#f5f5f5';
  const panelBg = blackBackground ? '#111111' : '#1b1b1b';
  const inner = panel
    ? `<main class="panel"><h1>${escapeHtmlText(t)}</h1></main>`
    : `<h1>${escapeHtmlText(t)}</h1>`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>LocalClaw</title>',
    '  <style>',
    '    :root {',
    `      --bg: ${bg};`,
    `      --fg: ${fg};`,
    `      --panel: ${panelBg};`,
    '    }',
    '    * { box-sizing: border-box; }',
    '    body {',
    '      margin: 0;',
    '      min-height: 100vh;',
    '      display: grid;',
    '      place-items: center;',
    '      background: var(--bg);',
    '      color: var(--fg);',
    '      font-family: "Segoe UI", Arial, sans-serif;',
    '    }',
    '    .panel {',
    '      padding: 24px 28px;',
    '      border: 1px solid rgba(255,255,255,0.16);',
    '      border-radius: 12px;',
    '      background: var(--panel);',
    '      box-shadow: 0 12px 30px rgba(0,0,0,0.35);',
    '    }',
    '    h1 {',
    '      margin: 0;',
    '      font-size: 28px;',
    '      font-weight: 700;',
    '      line-height: 1.2;',
    '    }',
    '  </style>',
    '</head>',
    '<body>',
    `  ${inner}`,
    '</body>',
    '</html>',
  ].join('\n');
}

function rewriteHtmlPrimaryText(existingHtml: string, text: string): string {
  const html = String(existingHtml || '');
  const safe = escapeHtmlText(text);
  if (!html) return buildBasicHtmlDocument(text, { blackBackground: true, whiteText: true, panel: true });
  if (/<h1\b[^>]*>[\s\S]*?<\/h1>/i.test(html)) {
    return html.replace(/<h1\b([^>]*)>[\s\S]*?<\/h1>/i, `<h1$1>${safe}</h1>`);
  }
  if (/<main\b[^>]*>[\s\S]*?<\/main>/i.test(html)) {
    return html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, `<main class="panel"><h1>${safe}</h1></main>`);
  }
  if (/<body\b[^>]*>[\s\S]*?<\/body>/i.test(html)) {
    return html.replace(/<body\b[^>]*>[\s\S]*?<\/body>/i, `<body>\n  <main class="panel"><h1>${safe}</h1></main>\n</body>`);
  }
  return buildBasicHtmlDocument(text, { blackBackground: true, whiteText: true, panel: true });
}

type HtmlStyleProperty = 'background' | 'text';
type HtmlStyleTarget = 'panel' | 'page';
type HtmlStyleMutationIntent = {
  color: string;
  target: HtmlStyleTarget;
  property: HtmlStyleProperty;
  source: 'explicit' | 'retry';
};

type HtmlStructuralMutationIntent = {
  layout: 'panel_wrap';
  center: boolean;
  source: 'explicit' | 'retry';
};

type LastStyleMutation = {
  color: string;
  property: HtmlStyleProperty;
  target: HtmlStyleTarget;
  target_path?: string;
  updated_at: number;
};

function extractVisibleTextFromHtml(input: string): string {
  return String(input || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSignificantVisibleTextLoss(before: string, after: string, maxLossRatio = 0.35): boolean {
  const b = extractVisibleTextFromHtml(before);
  const a = extractVisibleTextFromHtml(after);
  if (b.length < 20) return false;
  const ratio = 1 - (a.length / Math.max(1, b.length));
  return ratio > maxLossRatio;
}

function normalizeCommonFileTypos(text: string): string {
  let out = String(text || '');
  if (!out) return out;
  out = out
    .replace(/\.(htnml|hmtl)\b/ig, '.html')
    .replace(/\b(htnml|hmtl)\b/ig, 'html');
  return out;
}

function extractColorToken(text: string): string | null {
  const raw = String(text || '').toLowerCase();
  if (!raw) return null;
  const hex = raw.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i)?.[0];
  if (hex) return hex;
  const rgb = raw.match(/\brgba?\([^)]+\)/i)?.[0];
  if (rgb) return rgb;
  const named = raw.match(/\b(red|blue|green|black|white|orange|yellow|purple|pink|gray|grey|teal|cyan|magenta|maroon|navy|lime|olive|silver|gold|brown)\b/i)?.[1];
  if (named) return named.toLowerCase();
  return null;
}

function extractTargetColorToken(text: string): string | null {
  const raw = String(text || '');
  if (!raw) return null;
  const named = '(?:red|blue|green|black|white|orange|yellow|purple|pink|gray|grey|teal|cyan|magenta|maroon|navy|lime|olive|silver|gold|brown)';
  const colorToken = `(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b|rgba?\\([^)]+\\)|${named})`;
  const fromTo = raw.match(new RegExp(`\\bfrom\\s+(${colorToken})\\s+to\\s+(${colorToken})\\b`, 'i'));
  if (fromTo?.[2]) return String(fromTo[2]).toLowerCase();
  const toColor = raw.match(new RegExp(`\\bto\\s+(?:be\\s+)?(${colorToken})\\b`, 'i'));
  if (toColor?.[1]) return String(toColor[1]).toLowerCase();
  const asColor = raw.match(new RegExp(`\\bas\\s+(${colorToken})\\b`, 'i'));
  if (asColor?.[1]) return String(asColor[1]).toLowerCase();
  return extractColorToken(raw);
}

function rewriteHtmlPanelBackground(existingHtml: string, color: string): string {
  const html = String(existingHtml || '');
  const c = String(color || '').trim();
  if (!html || !c) return html;
  if (/--panel\s*:/i.test(html)) {
    return html.replace(/(--panel\s*:\s*)([^;]+)(;)/i, `$1${c}$3`);
  }
  if (/\b\.panel\b[\s\S]*?\{[\s\S]*?\}/i.test(html)) {
    return html.replace(/(\.panel\b[\s\S]*?\{[\s\S]*?background\s*:\s*)([^;]+)(;)/i, `$1${c}$3`);
  }
  return html;
}

function isExplicitCreateIntent(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  if (/\b(create|make|write)\b/.test(m) && /\b(new|file|html?|txt|md|json|css|js|ts|py)\b/.test(m)) return true;
  if (/\bbrand new\b/.test(m) && /\bfile\b/.test(m)) return true;
  return false;
}

function splitInstructionClauses(message: string): string[] {
  const raw = String(message || '').trim();
  if (!raw) return [];
  const out: string[] = [];
  let buf = '';
  let quote: '' | '"' | '\'' | '`' = '';
  let escaped = false;
  const connectors = ['after that', 'and then', 'then'];
  const startsWithVerb = (s: string): boolean =>
    /^(remove|delete|edit|update|change|modify|set|replace|create|make|write|rename|move)\b/i.test(String(s || '').trim());
  const isBoundary = (ch: string | undefined): boolean => !/[a-z0-9_]/i.test(String(ch || ''));
  const prevNonSpaceChar = (idx: number): string => {
    for (let j = idx - 1; j >= 0; j--) {
      const ch = raw[j];
      if (!/\s/.test(ch)) return ch;
    }
    return '';
  };

  const pushBuf = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      buf += ch;
      continue;
    }

    const tailLower = raw.slice(i).toLowerCase();

    // Split on ", and <verb> ..." without splitting natural prose.
    if (
      tailLower.startsWith('and ')
      && /[,;:]/.test(prevNonSpaceChar(i))
      && startsWithVerb(raw.slice(i + 4))
    ) {
      pushBuf();
      i += 3;
      continue;
    }

    let matchedConnector = '';
    for (const c of connectors) {
      if (!tailLower.startsWith(c)) continue;
      const before = i > 0 ? raw[i - 1] : ' ';
      const after = raw[i + c.length];
      if (isBoundary(before) && isBoundary(after)) {
        matchedConnector = c;
        break;
      }
    }
    // Only split on "also" when it clearly starts a new imperative step.
    if (!matchedConnector && tailLower.startsWith('also ') && startsWithVerb(raw.slice(i + 5))) {
      const before = i > 0 ? raw[i - 1] : ' ';
      if (isBoundary(before)) matchedConnector = 'also';
    }
    if (matchedConnector) {
      pushBuf();
      i += matchedConnector.length - 1;
      continue;
    }

    buf += ch;
    if ((ch === '.' || ch === '!' || ch === '?') && !quote) {
      const rest = raw.slice(i + 1);
      if (startsWithVerb(rest)) {
        pushBuf();
      }
    }
  }

  pushBuf();
  return out.length ? out : [raw];
}

function replaceCssVariable(html: string, variable: string, value: string): string {
  const re = new RegExp(`(--${variable}\\s*:\\s*)([^;]+)(;)`, 'i');
  if (!re.test(html)) return html;
  return html.replace(re, `$1${value}$3`);
}

function rewriteCssBackgroundInBlock(html: string, selector: 'panel' | 'body', color: string): string {
  const selectorRe = selector === 'panel' ? /\.panel\b[\s\S]*?\{[\s\S]*?\}/i : /\bbody\b[\s\S]*?\{[\s\S]*?\}/i;
  const match = html.match(selectorRe);
  if (!match?.[0]) return html;
  const block = match[0];
  let updated = block;
  if (/background-color\s*:/i.test(updated)) {
    updated = updated.replace(/background-color\s*:\s*[^;]+;/i, `background-color: ${color};`);
  } else if (/background\s*:/i.test(updated)) {
    updated = updated.replace(/background\s*:\s*[^;]+;/i, `background: ${color};`);
  } else {
    updated = updated.replace(/\{/, `{\n      background: ${color};`);
  }
  return html.replace(block, updated);
}

function rewriteCssColorInBlock(html: string, selector: 'panel' | 'body', color: string): string {
  const selectorRe = selector === 'panel' ? /\.panel\b[\s\S]*?\{[\s\S]*?\}/i : /\bbody\b[\s\S]*?\{[\s\S]*?\}/i;
  const match = html.match(selectorRe);
  if (!match?.[0]) return html;
  const block = match[0];
  let updated = block;
  if (/(^|[;{\s])color\s*:/i.test(updated)) {
    updated = updated.replace(/(^|[;{\s])color\s*:\s*[^;]+;/i, `$1color: ${color};`);
  } else {
    updated = updated.replace(/\{/, `{\n      color: ${color};`);
  }
  return html.replace(block, updated);
}

function injectStyleRule(html: string, rule: string): string {
  if (/<\/style>/i.test(html)) {
    return html.replace(/<\/style>/i, `\n    ${rule}\n  </style>`);
  }
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n  <style>\n    ${rule}\n  </style>`);
  }
  return html;
}

function applyInlineBodyBackground(html: string, color: string): string {
  if (!/<body\b/i.test(html)) return html;
  const bodyOpen = html.match(/<body\b([^>]*)>/i);
  if (!bodyOpen) return html;
  const full = bodyOpen[0];
  const attrs = String(bodyOpen[1] || '');
  if (/style\s*=\s*["'][^"']*["']/i.test(attrs)) {
    const replaced = full.replace(/style\s*=\s*["']([^"']*)["']/i, (_m, styleText) => {
      const safe = String(styleText || '').trim();
      const next = /background(?:-color)?\s*:/i.test(safe)
        ? safe.replace(/background(?:-color)?\s*:\s*[^;]+;?/i, `background-color: ${color};`)
        : `${safe}${safe.endsWith(';') || !safe ? '' : ';'} background-color: ${color};`;
      return `style="${next.trim()}"`;
    });
    return html.replace(full, replaced);
  }
  return html.replace(full, `<body${attrs} style="background-color: ${color};">`);
}

function applyInlineBodyColor(html: string, color: string): string {
  if (!/<body\b/i.test(html)) return html;
  const bodyOpen = html.match(/<body\b([^>]*)>/i);
  if (!bodyOpen) return html;
  const full = bodyOpen[0];
  const attrs = String(bodyOpen[1] || '');
  if (/style\s*=\s*["'][^"']*["']/i.test(attrs)) {
    const replaced = full.replace(/style\s*=\s*["']([^"']*)["']/i, (_m, styleText) => {
      const safe = String(styleText || '').trim();
      const next = /(^|[;\s])color\s*:/i.test(safe)
        ? safe.replace(/(^|[;\s])color\s*:\s*[^;]+;?/i, `$1color: ${color};`)
        : `${safe}${safe.endsWith(';') || !safe ? '' : ';'} color: ${color};`;
      return `style="${next.trim()}"`;
    });
    return html.replace(full, replaced);
  }
  return html.replace(full, `<body${attrs} style="color: ${color};">`);
}

function isCorrectiveRetryCue(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return /\b(try again|retry|didn'?t|did not|still|wrong|you changed|not updated|fix that|instead)\b/.test(m);
}

function detectHtmlStyleMutationIntent(message: string, state?: AgentSessionState): HtmlStyleMutationIntent | null {
  const raw = normalizeCommonFileTypos(String(message || ''));
  const m = raw.toLowerCase();
  const hasVerb = /\b(change|update|set|make|edit|modify|turn|switch|fix|correct)\b/.test(m);
  const styleCue = /\b(background|bg|color|theme|text|font|foreground|panel|inside|inner|container|card|box)\b/.test(m);
  const retryCue = isCorrectiveRetryCue(m);
  if (!hasVerb && !retryCue) return null;
  if (!styleCue && !retryCue) return null;

  const explicitText = /\b(text|font|foreground)\b/.test(m);
  const explicitBackground = /\b(background|bg|theme)\b/.test(m);
  const hasColorWord = /\bcolor\b/.test(m);
  let property: HtmlStyleProperty | null = null;
  if (explicitText) property = 'text';
  else if (explicitBackground) property = 'background';
  else if (hasColorWord) property = 'background';
  else if (/\b(panel|inside|inner|container|card|box)\b/.test(m)) property = 'background';

  const hasTargetCue = /\b(panel|inside|inner|container|card|box)\b/i.test(raw);
  let target: HtmlStyleTarget = hasTargetCue ? 'panel' : 'page';
  let color = extractTargetColorToken(raw);
  let source: 'explicit' | 'retry' = 'explicit';
  const last = (state as any)?.lastStyleMutation as LastStyleMutation | undefined;

  if (!color && retryCue && last?.color) {
    color = String(last.color || '').trim().toLowerCase();
    source = 'retry';
  }
  if (!property && retryCue && last?.property) {
    property = last.property;
  }
  if (!hasTargetCue && retryCue && last?.target) {
    target = last.target;
  }

  if (!property || !color) return null;
  return { color, target, property, source };
}

function detectHtmlStructuralMutationIntent(message: string, _state?: AgentSessionState): HtmlStructuralMutationIntent | null {
  if (!FEATURE_FLAGS.html_structural_mutation) return null;
  const raw = normalizeCommonFileTypos(String(message || ''));
  const m = raw.toLowerCase();
  if (!m) return null;
  const hasVerb = /\b(change|update|set|make|edit|modify|wrap|put|place|move|center|rebuild|layout)\b/.test(m);
  if (!hasVerb) return null;
  if (extractTargetColorToken(raw)) return null;
  if (/\b(background|bg|text color|font color|foreground|theme)\b/.test(m)) return null;
  const panelCue = /\b(panel|card|box|container|wrap|inside a panel|in a panel)\b/.test(m);
  if (!panelCue) return null;
  return {
    layout: 'panel_wrap',
    center: /\b(center|centered|middle|middle of (?:the )?page)\b/.test(m),
    source: 'explicit',
  };
}

function hasHtmlStyleTargetContext(state?: AgentSessionState): boolean {
  const last = String((state as any)?.lastFilePath || '').trim();
  if (last && /\.html?$/i.test(last)) return true;
  const recent = Array.isArray((state as any)?.recentFilePaths) ? (state as any).recentFilePaths : [];
  if (recent.some((p: any) => /\.html?$/i.test(String(p || '')))) return true;
  return getWorkspaceHtmlCandidates(1).length > 0;
}

function isStyleMutationTurn(message: string, state?: AgentSessionState): boolean {
  return !!detectHtmlStyleMutationIntent(message, state) && hasHtmlStyleTargetContext(state);
}

function isStructuralMutationTurn(message: string, state?: AgentSessionState): boolean {
  return !!detectHtmlStructuralMutationIntent(message, state) && hasHtmlStyleTargetContext(state);
}

function rewriteHtmlStyleByIntent(
  existingHtml: string,
  intent: HtmlStyleMutationIntent
): { content: string; operation_type: string; expected_after_hint: string } | null {
  const html = String(existingHtml || '');
  const color = String(intent.color || '').trim();
  if (!html || !color) return null;
  let mutated = html;
  let operationType = '';
  if (intent.property === 'text') {
    const byVar = replaceCssVariable(mutated, 'fg', color);
    if (byVar !== mutated) {
      mutated = byVar;
      operationType = 'css_set_text_var';
    } else if (intent.target === 'panel') {
      const byPanelBlock = rewriteCssColorInBlock(mutated, 'panel', color);
      if (byPanelBlock !== mutated) {
        mutated = byPanelBlock;
        operationType = 'css_set_panel_text_color';
      } else {
        const injected = injectStyleRule(mutated, `.panel { color: ${color}; }`);
        if (injected !== mutated) {
          mutated = injected;
          operationType = 'css_inject_panel_text_rule';
        }
      }
    } else {
      const byBodyBlock = rewriteCssColorInBlock(mutated, 'body', color);
      if (byBodyBlock !== mutated) {
        mutated = byBodyBlock;
        operationType = 'css_set_body_text_color';
      } else {
        const injected = injectStyleRule(mutated, `body { color: ${color}; }`);
        if (injected !== mutated) {
          mutated = injected;
          operationType = 'css_inject_body_text_rule';
        } else {
          const inline = applyInlineBodyColor(mutated, color);
          if (inline !== mutated) {
            mutated = inline;
            operationType = 'html_set_body_inline_text_color';
          }
        }
      }
    }
  } else if (intent.target === 'panel') {
    const byVar = replaceCssVariable(mutated, 'panel', color);
    if (byVar !== mutated) {
      mutated = byVar;
      operationType = 'css_set_panel_var';
    } else {
      const byBlock = rewriteCssBackgroundInBlock(mutated, 'panel', color);
      if (byBlock !== mutated) {
        mutated = byBlock;
        operationType = 'css_set_panel_background';
      } else {
        const injected = injectStyleRule(mutated, `.panel { background: ${color}; }`);
        if (injected !== mutated) {
          mutated = injected;
          operationType = 'css_inject_panel_rule';
        }
      }
    }
  } else {
    const byVar = replaceCssVariable(mutated, 'bg', color);
    if (byVar !== mutated) {
      mutated = byVar;
      operationType = 'css_set_page_var';
    } else {
      const byBodyBlock = rewriteCssBackgroundInBlock(mutated, 'body', color);
      if (byBodyBlock !== mutated) {
        mutated = byBodyBlock;
        operationType = 'css_set_body_background';
      } else {
        const injected = injectStyleRule(mutated, `body { background: ${color}; }`);
        if (injected !== mutated) {
          mutated = injected;
          operationType = 'css_inject_body_rule';
        } else {
          const inline = applyInlineBodyBackground(mutated, color);
          if (inline !== mutated) {
            mutated = inline;
            operationType = 'html_set_body_inline_background';
          }
        }
      }
    }
  }
  if (!operationType) return null;
  if (hasSignificantVisibleTextLoss(html, mutated, 0.15)) return null;
  const expectedAfter = intent.property === 'text'
    ? (intent.target === 'panel' ? `color: ${color};` : `--fg: ${color};`)
    : (intent.target === 'panel' ? `--panel: ${color};` : `--bg: ${color};`);
  return {
    content: mutated,
    operation_type: operationType,
    expected_after_hint: expectedAfter,
  };
}

function ensurePanelLayoutStyles(html: string, center = true): string {
  let out = String(html || '');
  if (!/\b\.panel\b[\s\S]*?\{[\s\S]*?\}/i.test(out)) {
    out = injectStyleRule(out, '.panel { padding: 24px 28px; border: 1px solid rgba(255,255,255,0.16); border-radius: 12px; background: var(--panel, #1b1b1b); box-shadow: 0 12px 30px rgba(0,0,0,0.35); }');
  }
  if (center) {
    const bodyHasCenter = /\bbody\b[\s\S]*?\{[\s\S]*?(?:place-items\s*:\s*center|justify-content\s*:\s*center)[\s\S]*?\}/i.test(out);
    if (!bodyHasCenter) {
      out = injectStyleRule(out, 'body { min-height: 100vh; display: grid; place-items: center; margin: 0; }');
    }
  }
  return out;
}

function rewriteHtmlStructuralByIntent(
  existingHtml: string,
  intent: HtmlStructuralMutationIntent
): { content: string; operation_type: string; expected_after_hint: string } | null {
  const html = String(existingHtml || '');
  if (!html) return null;
  if (intent.layout !== 'panel_wrap') return null;

  let mutated = html;
  let operationType = '';
  if (!/<main\b[^>]*class\s*=\s*["'][^"']*\bpanel\b/i.test(mutated)) {
    if (/<body\b[^>]*>[\s\S]*?<\/body>/i.test(mutated)) {
      mutated = mutated.replace(/<body\b([^>]*)>([\s\S]*?)<\/body>/i, (_m, attrs, inner) => {
        const safeInner = String(inner || '').trim() || '<h1>Hello world</h1>';
        return `<body${String(attrs || '')}>\n  <main class="panel">\n${safeInner}\n  </main>\n</body>`;
      });
      operationType = 'html_wrap_body_in_panel';
    } else if (/<html\b/i.test(mutated)) {
      mutated = mutated.replace(/<\/html>/i, '<body>\n  <main class="panel"><h1>Hello world</h1></main>\n</body>\n</html>');
      operationType = 'html_inject_panel_body';
    } else {
      const text = extractVisibleTextFromHtml(mutated) || 'Hello world';
      mutated = buildBasicHtmlDocument(text, { panel: true });
      operationType = 'html_rebuild_with_panel';
    }
  }

  const withStyles = ensurePanelLayoutStyles(mutated, intent.center);
  if (withStyles !== mutated && !operationType) operationType = 'html_panel_styles_added';
  mutated = withStyles;
  if (!operationType) return null;
  if (hasSignificantVisibleTextLoss(html, mutated, 0.25)) return null;
  return {
    content: mutated,
    operation_type: operationType,
    expected_after_hint: 'class="panel"',
  };
}

function resolveHtmlTargetForMutation(
  message: string,
  state: AgentSessionState
): { status: 'resolved'; targetPath: string; candidates: string[] } | { status: 'ambiguous' | 'missing'; candidates: string[] } {
  const raw = normalizeCommonFileTypos(String(message || ''));
  const m = raw.toLowerCase();
  const isDeleteScopedMatch = (idx: number): boolean => {
    if (!Number.isFinite(idx) || idx < 0) return false;
    const start = Math.max(0, idx - 90);
    const prefix = raw.slice(start, idx).toLowerCase();
    if (!/\b(remove|delete)\b/.test(prefix)) return false;
    // If the local context already switched back to edit/style intent, do not treat as delete-scoped.
    const localAfterDelete = prefix.slice(Math.max(prefix.lastIndexOf('remove'), prefix.lastIndexOf('delete')));
    return !/\b(change|set|update|edit|modify|style|background|panel)\b/.test(localAfterDelete);
  };
  const explicitHtmlMatches = Array.from(raw.matchAll(/\b([a-zA-Z0-9._\-]+\.html?)\b/ig))
    .filter((mm: any) => !isDeleteScopedMatch(Number(mm?.index ?? -1)))
    .map((mm: any) => String(mm?.[1] || '').trim());
  const explicitUnique = Array.from(new Set(explicitHtmlMatches.filter(Boolean)));
  if (explicitUnique.length === 1) {
    const p = explicitUnique[0];
    return {
      status: 'resolved',
      targetPath: path.isAbsolute(p) ? p : path.join(config.workspace.path, p),
      candidates: [p],
    };
  }
  if (explicitUnique.length > 1) {
    return { status: 'ambiguous', candidates: explicitUnique };
  }

  // Bare-name resolution for prompts like "change the index_2 file..."
  const bareBaseRaw =
    raw.match(/\b(?:change|set|update|edit|modify|make)\b[\s\S]{0,120}?\b([a-zA-Z0-9._\-]+)\s+(?:html?|web)\s+file\b/i)?.[1]
    || raw.match(/\b([a-zA-Z0-9._\-]+)\s+(?:html?|web)\s+file\b/i)?.[1]
    || '';
  const bareBase = String(bareBaseRaw || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.html?$/i, '')
    .toLowerCase();
  if (bareBase && !/^(the|a|an|my|new|old|current|existing|same|that|this|file|html|htm)$/i.test(bareBase)) {
    const recent = Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [];
    const pool = Array.from(new Set([
      ...recent.map((x: any) => String(x || '').trim()).filter((x: string) => /\.html?$/i.test(x)),
      ...(String(state.lastFilePath || '').trim() && /\.html?$/i.test(String(state.lastFilePath || '').trim())
        ? [String(state.lastFilePath || '').trim()]
        : []),
      ...getWorkspaceHtmlCandidates(24),
    ]));
    const matched = pool.filter((p: string) =>
      String(path.basename(p || '')).replace(/\.html?$/i, '').toLowerCase() === bareBase);
    if (matched.length === 1) {
      const abs = path.isAbsolute(matched[0]) ? matched[0] : path.join(config.workspace.path, matched[0]);
      return { status: 'resolved', targetPath: abs, candidates: [abs] };
    }
    if (matched.length > 1) {
      return { status: 'ambiguous', candidates: matched };
    }
  }

  const referentialCue = /\b(it|that file|same file|this file|the html file|html file)\b/i.test(raw);
  const last = String(state.lastFilePath || '').trim();
  if (referentialCue && last && /\.html?$/i.test(last)) {
    const abs = path.isAbsolute(last) ? last : path.join(config.workspace.path, last);
    return { status: 'resolved', targetPath: abs, candidates: [abs] };
  }
  const recent = Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [];
  const recentHtml = recent.map(x => String(x || '').trim()).filter(x => /\.html?$/i.test(x));
  if (recentHtml.length === 1) {
    const abs = path.isAbsolute(recentHtml[0]) ? recentHtml[0] : path.join(config.workspace.path, recentHtml[0]);
    return { status: 'resolved', targetPath: abs, candidates: [abs] };
  }
  if (referentialCue && recentHtml.length > 1) {
    const abs = path.isAbsolute(recentHtml[0]) ? recentHtml[0] : path.join(config.workspace.path, recentHtml[0]);
    return { status: 'resolved', targetPath: abs, candidates: recentHtml };
  }
  const workspaceHtml = getWorkspaceHtmlCandidates(12);
  if (workspaceHtml.length === 1) {
    return { status: 'resolved', targetPath: workspaceHtml[0], candidates: [workspaceHtml[0]] };
  }
  if (workspaceHtml.length > 1) {
    return { status: 'ambiguous', candidates: workspaceHtml };
  }
  return { status: 'missing', candidates: [] };
}

function buildBlockedFileOpReply(opts: {
  reason_code: FileOpBlockedReason;
  what_was_tried: string[];
  exact_input_needed: string;
  suggested_next_prompt?: string;
}): string {
  if (opts.reason_code === 'UNSUPPORTED_MUTATION') bumpDecisionMetric('unsupported_mutation');
  if (opts.reason_code === 'FORMAT_VIOLATION_LOOP') bumpDecisionMetric('format_loop');
  if (opts.reason_code === 'AMBIGUOUS_TARGET') bumpDecisionMetric('ambiguous_target');
  if (opts.reason_code === 'MISSING_REQUIRED_INPUT') bumpDecisionMetric('missing_required_input');
  if (opts.reason_code === 'VERIFY_FAILED') bumpDecisionMetric('verify_failed');
  const lines = [
    `BLOCKED (${opts.reason_code})`,
    `Tried: ${opts.what_was_tried.join(' | ') || 'no deterministic steps could run.'}`,
    `Needed: ${opts.exact_input_needed}`,
  ];
  if (opts.suggested_next_prompt) lines.push(`Try: ${opts.suggested_next_prompt}`);
  return lines.join('\n');
}

function extractHtmlDisplayText(message: string, fallback?: string): string {
  const raw = String(message || '');
  const direct =
    raw.match(/\b(?:say|display|show)\s+["'`]?(.+?)["'`]?(?=\s*(?:\.\s*|,\s*(?:make|with|but|and)\b|make\b|with\b|but\b|and\b|$))/i)?.[1]
    || '';
  let out = String(direct || fallback || '').trim();
  out = out
    .replace(/\s*,\s*(?:make|set|put)\b[\s\S]*$/i, '')
    .replace(/\s+\b(?:make|set|put)\b[\s\S]*$/i, '')
    .trim();
  return out || 'Hello world - i am localclaw';
}

function extractCreateRequestedContentValue(message: string, maxLen = 260): string {
  const raw = String(message || '').trim();
  if (!raw) return '';
  const cue = '(?:inside it should say|it should say|should say|that says?|that said|says?|said|saying|with content|containing|put)';
  const quoted =
    raw.match(new RegExp(`\\b${cue}\\b[\\s:,-]*["'\`]{1}([^"'\`]+?)["'\`]{1}`, 'i'))?.[1]
    || '';
  let content = String(quoted || '').trim();
  if (!content) {
    const unquoted =
      raw.match(new RegExp(`\\b${cue}\\b\\s+(.+?)(?=\\s*(?:[.?!]|,\\s*(?:and then|after that|also)\\b|\\band then\\b|\\bafter that\\b|\\balso\\b|$))`, 'i'))?.[1]
      || '';
    content = String(unquoted || '').trim();
  }
  if (!content) return '';
  content = content
    .replace(/[.,]?\s+and\s+name\s+it\s+["'`]?.*$/i, '')
    .replace(/[.,]?\s+(?:named|called)\s+["'`]?.*$/i, '')
    .replace(/[.,]?\s+\b(?:and|but)\b\s+(?:wrap|put|set|make|style)\b[\s\S]*$/i, '')
    .trim();
  if (content.length > maxLen) content = content.slice(0, maxLen).trim();
  return content;
}

function extractRequestedContentValue(message: string, maxLen = 200): string {
  const raw = String(message || '').trim();
  if (!raw) return '';
  const contentPatterns = [
    /\b(?:it|the\s+[a-zA-Z0-9._\-]+\s+file)?\s*(?:doesn'?t|does\s+not)\s+say\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:,\s*(?:it\s+)?only\s+says?\b|,\s*can\s+(?:we|you)\s+fix\b))/i,
    /\bit should only say\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bshould only say\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bit only says\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bonly says\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bonly say\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bit should just be\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bshould just be\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bit should be\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bmake\s+it\s+(?:just\s+)?say\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\b(?:to|t)\s+just\s+say\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\b(?:to|t)\s+say\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bsaying\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\b(?:to|t)\s+contain\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\bwith content\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\binside(?:\s+it)?\s+(?:should\s+)?(?:say|contain)\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
    /\b(?:to|should|make\s+it|it\s+should|want\s+it\s+to|please)\s+(?:just\s+)?say\b\s*[:,\-]?\s*["'`]?(.+?)["'`]?(?=\s*(?:$|,\s*and\b|\band then\b))/i,
  ];
  let content = '';
  for (const re of contentPatterns) {
    const mm = raw.match(re);
    if (mm?.[1]) {
      content = String(mm[1]).trim();
      if (content) break;
    }
  }
  if (!content) return '';
  content = content.replace(/^that\s+/i, '').trim();
  content = content
    .replace(/[.,]?\s+it\s+currently\s+says\b[\s\S]*$/i, '')
    .replace(/[.,]?\s+it\s+currently\s+is\b[\s\S]*$/i, '')
    .replace(/[.,]?\s+it\s+only\s+says?\b[\s\S]*$/i, '')
    .replace(/[.,]?\s+can\s+(?:we|you)\s+fix\b[\s\S]*$/i, '')
    .trim();
  if (content.length > maxLen) content = content.slice(0, maxLen).trim();
  return content;
}

function getWorkspaceTxtCandidates(limit = 6): string[] {
  try {
    const entries = fs.readdirSync(config.workspace.path, { withFileTypes: true });
    return entries
      .filter((e: any) => e && typeof e.isFile === 'function' && e.isFile() && /\.txt$/i.test(String(e.name || '')))
      .map((e: any) => {
        const p = path.join(config.workspace.path, String(e.name || ''));
        let mtime = 0;
        try { mtime = Number(fs.statSync(p).mtimeMs || 0); } catch { mtime = 0; }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(x => x.p)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function getWorkspaceHtmlCandidates(limit = 8): string[] {
  try {
    const entries = fs.readdirSync(config.workspace.path, { withFileTypes: true });
    return entries
      .filter((e: any) => e && typeof e.isFile === 'function' && e.isFile() && /\.html?$/i.test(String(e.name || '')))
      .map((e: any) => {
        const p = path.join(config.workspace.path, String(e.name || ''));
        let mtime = 0;
        try { mtime = Number(fs.statSync(p).mtimeMs || 0); } catch { mtime = 0; }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(x => x.p)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function getWorkspaceFileCandidatesByExt(extHint = '', limit = 12): string[] {
  try {
    const ext = String(extHint || '').trim().toLowerCase();
    const entries = fs.readdirSync(config.workspace.path, { withFileTypes: true });
    return entries
      .filter((e: any) => e && typeof e.isFile === 'function' && e.isFile())
      .map((e: any) => String(e.name || ''))
      .filter((name: string) => {
        if (!name) return false;
        if (!ext) return true;
        return String(path.extname(name) || '').toLowerCase() === ext;
      })
      .map((name: string) => {
        const p = path.join(config.workspace.path, name);
        let mtime = 0;
        try { mtime = Number(fs.statSync(p).mtimeMs || 0); } catch { mtime = 0; }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(x => x.p)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function getWorkspaceAllFileCandidates(limit = 64): string[] {
  try {
    const entries = fs.readdirSync(config.workspace.path, { withFileTypes: true });
    return entries
      .filter((e: any) => e && typeof e.isFile === 'function' && e.isFile())
      .map((e: any) => String(e.name || ''))
      .filter(Boolean)
      .map((name: string) => {
        const p = path.join(config.workspace.path, name);
        let mtime = 0;
        try { mtime = Number(fs.statSync(p).mtimeMs || 0); } catch { mtime = 0; }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(x => x.p)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function extractPrefixDeleteHint(clause: string): string {
  const raw = String(clause || '').trim();
  if (!raw) return '';
  const patterns: RegExp[] = [
    /\b(?:start(?:ing|s)?\s+with|begin(?:ning)?\s+with|prefixed?\s+with)\s+["'`]?([a-zA-Z0-9._\-]+)\*?["'`]?/i,
    /\ball\s+(?:the\s+)?files?\s+(?:that\s+)?(?:start(?:ing|s)?|begin(?:ning)?)\s+with\s+["'`]?([a-zA-Z0-9._\-]+)\*?["'`]?/i,
    /\bfiles?\s+named\s+["'`]?([a-zA-Z0-9._\-]+)\*["'`]?/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const p = String(m?.[1] || '').trim().replace(/[*]+$/g, '');
    if (p) return p.toLowerCase();
  }
  return '';
}

function resolveGenericTargetForMutation(
  message: string,
  state: AgentSessionState
): { status: 'resolved'; targetPath: string; candidates: string[] } | { status: 'ambiguous' | 'missing'; candidates: string[] } {
  const raw = normalizeCommonFileTypos(String(message || ''));
  const explicitMatches = Array.from(raw.matchAll(/\b([a-zA-Z0-9._\-]+\.(?:txt|md|json|ts|js|py|html?|css))\b/ig))
    .map(m => String(m[1] || '').trim())
    .filter(Boolean);
  const explicitUnique = Array.from(new Set(explicitMatches));
  if (explicitUnique.length === 1) {
    const p = explicitUnique[0];
    const abs = path.isAbsolute(p) ? p : path.join(config.workspace.path, p);
    return { status: 'resolved', targetPath: abs, candidates: [abs] };
  }
  if (explicitUnique.length > 1) {
    return { status: 'ambiguous', candidates: explicitUnique };
  }

  const hasExtCue = /\b(html?|txt|text file|md|markdown|json|css|js|javascript|ts|typescript|py|python)\b|(?:\.[a-z0-9]{1,6}\b)/i.test(raw);
  const extHint = hasExtCue ? inferRequestedFileExtension(raw) : '';
  const singularCue = /\b(it|that file|this file|the file|same file|that one|this one)\b/i.test(raw);
  const aliasRaw = raw.match(/\b(?:the|that|this|my|current|existing|original)?\s*([a-zA-Z0-9._\-]+)\s+file\b/i)?.[1] || '';
  const alias = (() => {
    const cand = String(aliasRaw || '').trim().toLowerCase();
    if (!cand) return '';
    if (/^(the|a|an|my|new|original|current|existing|same|that|this|file|html|htm|txt|md|json|css|js|ts|py)$/.test(cand)) return '';
    return cand;
  })();

  const last = String(state.lastFilePath || '').trim();
  const recent = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [])
    .map(x => String(x || '').trim())
    .filter(Boolean);
  const recentUnique = Array.from(new Set(recent));

  const extFilteredRecent = extHint
    ? recentUnique.filter(p => String(path.extname(p) || '').toLowerCase() === extHint)
    : recentUnique.slice();
  const workspaceCandidates = getWorkspaceFileCandidatesByExt(extHint, 16);
  const pool = Array.from(new Set([...extFilteredRecent, ...workspaceCandidates]));

  if (alias) {
    const aliasMatches = pool.filter(p => {
      const base = String(path.basename(p) || '').toLowerCase();
      const stem = base.replace(/\.[a-z0-9]{1,6}$/i, '');
      return stem === alias || base.includes(alias);
    });
    if (aliasMatches.length === 1) {
      return { status: 'resolved', targetPath: aliasMatches[0], candidates: aliasMatches };
    }
    if (aliasMatches.length > 1) {
      return { status: 'ambiguous', candidates: aliasMatches };
    }
  }

  if (singularCue && last) {
    const absLast = path.isAbsolute(last) ? last : path.join(config.workspace.path, last);
    if (!extHint || String(path.extname(absLast) || '').toLowerCase() === extHint) {
      return { status: 'resolved', targetPath: absLast, candidates: [absLast] };
    }
  }

  if (singularCue && pool.length === 1) {
    return { status: 'resolved', targetPath: pool[0], candidates: [pool[0]] };
  }
  if (singularCue && pool.length > 1) {
    return { status: 'ambiguous', candidates: pool };
  }

  return { status: 'missing', candidates: pool };
}

function getWorkspaceTxtByContent(regex: RegExp, limit = 6): string[] {
  const out: string[] = [];
  const txt = getWorkspaceTxtCandidates(20);
  for (const p of txt) {
    if (out.length >= limit) break;
    try {
      const body = fs.readFileSync(p, 'utf-8');
      if (regex.test(String(body || ''))) out.push(p);
    } catch {
      // ignore unreadable file
    }
  }
  return out;
}

function normalizeFactKey(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '-')
    .slice(0, 80) || 'query';
}

function computeWorkspaceId(): string {
  const wp = String(config.workspace.path || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < wp.length; i++) h = ((h << 5) - h) + wp.charCodeAt(i);
  return `ws_${Math.abs(h >>> 0).toString(16)}`;
}

function loadDailyMemorySnippets(query: string, max = 4, maxTotalChars = 220, maxLineChars = 120): string[] {
  try {
    const dir = path.join(config.workspace.path, 'memory');
    if (!fs.existsSync(dir)) return [];
    const q = String(query || '').toLowerCase();
    const toks = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 4);
    if (!toks.length) return [];
    const files = fs.readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .slice(-3);
    const lines: Array<{ text: string; score: number; day: string }> = [];
    for (const f of files) {
      const day = f.replace(/\.md$/, '');
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      for (const ln of content.split(/\r?\n/)) {
        const t = ln.trim();
        if (!t.startsWith('- ')) continue;
        const low = t.toLowerCase();
        let score = 0;
        for (const tok of toks) if (low.includes(tok)) score++;
        if (score > 0) lines.push({ text: t.replace(/^-+\s*/, ''), score, day });
      }
    }
    const ranked = lines
      .sort((a, b) => b.score - a.score || b.day.localeCompare(a.day))
      .slice(0, max)
      .map(x => x.text)
      .filter(Boolean);
    const out: string[] = [];
    let used = 0;
    for (const row of ranked) {
      const clipped = String(row || '').slice(0, maxLineChars).trim();
      if (!clipped) continue;
      if (used + clipped.length > maxTotalChars) break;
      out.push(clipped);
      used += clipped.length;
    }
    return out;
  } catch {
    return [];
  }
}

function isQuestionLike(message: string): boolean {
  const m = message.toLowerCase().trim();
  if (!m) return false;
  if (m.endsWith('?')) return true;
  if (/^(who|what|when|where|why|how|is|are|do|does|did|can|could|should|would)\b/.test(m)) return true;
  if (/^(who'?s|whos|what'?s|whats|where'?s|wheres|when'?s|whens|why'?s|whys|how'?s|hows)\b/.test(m)) return true;
  if (/\b(can|could|would|will)\s+you\b/.test(m)) return true;
  if (/\b(tell me|let me know|find out|look up|check|search for|verify)\b/.test(m)) return true;
  if (/\bhow many\b/.test(m)) return true;
  return false;
}

interface NormalizedRequest {
  raw_text: string;
  chat_text: string;
  search_text: string;
}

interface SearchScope {
  country?: string;
  state?: string;
  city?: string;
  domain?: string;
  time_window?: string;
}

type DomainType = 'generic' | 'office_holder' | 'weather' | 'breaking_news' | 'market_price' | 'event_date_fact';

interface DomainPolicy {
  domain: DomainType;
  must_verify: boolean;
  default_scope?: { country?: string };
  expected_entity_class?: string;
  expected_keywords?: string[];
  buildTemplate: (normalized: NormalizedRequest, scope: SearchScope) => string;
}

interface QueryBuildInput {
  normalized: NormalizedRequest;
  domain?: string;
  scope?: SearchScope;
  templates?: { default?: string };
  expected_keywords?: string[];
}

interface RouteDecision {
  tool: 'web_search' | 'time_now' | null;
  params: any;
  locked_by_policy: boolean;
  lock_reason: string;
  requires_verification: boolean;
  domain: DomainType;
  provenance: 'policy_template' | 'referent_rewrite' | 'user_direct' | 'fallback_repair';
  expected_country?: string;
  expected_entity_class?: string;
  expected_keywords: string[];
}

function normalizeUserRequest(message: string): NormalizedRequest {
  const raw = String(message || '').trim();
  if (!raw) return { raw_text: '', chat_text: '', search_text: '' };
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text
    .replace(/^(lol|lmao|bro|hey|yo|okay|ok|cool|nice|sorry)[,!\s-]+/i, '')
    .replace(/^(openclaw|localclaw|claw)[,!\s-]+/i, '')
    .replace(/\b(can you|could you|would you|please)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const searchText = text
    .replace(/\b(i just wanted to see if you were working properly|just testing|for me|real quick)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    raw_text: raw,
    chat_text: text || raw,
    search_text: searchText || text || raw,
  };
}

function isOfficeHolderQuery(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return isQuestionLike(m) && /\b(president|vice president|prime minister|governor|mayor|ceo|attorney general|secretary of state|speaker)\b/.test(m);
}

function isWeatherQuery(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return /\b(weather|forecast|temperature|rain|snow|humidity|wind)\b/.test(m);
}

function isBreakingNewsQuery(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  if (/\b(file|workspace|folder|directory|rename|delete|remove|create|edit|update|write)\b/.test(m)) return false;
  if (/\b[a-z0-9._-]+\.(?:html?|txt|md|json|css|js|ts|py)\b/.test(m)) return false;
  return isQuestionLike(m) && /\b(breaking|latest|today|headline|news|what happened|update|recap|summary|outcome)\b/.test(m);
}

function isMarketQuery(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  if (/\b(file|workspace|folder|directory|rename|delete|remove|create|edit|update|write)\b/.test(m)) return false;
  if (/\b[a-z0-9._-]+\.(?:html?|txt|md|json|css|js|ts|py)\b/.test(m)) return false;
  return isQuestionLike(m) && /\b(price|quote|stock|crypto|bitcoin|btc|ethereum|eth|exchange rate|market cap|s&p|nasdaq|dow|dxy)\b/.test(m);
}

function isEventDateQuery(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return /\b(when did|on what date|what date did|date of)\b/.test(m);
}

function hasCountryDisambiguation(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return /\b(united states|u\.s\.|us\b|philippines|canada|uk|united kingdom|australia|india|france|germany|mexico)\b/.test(m);
}

function extractOfficeRole(message: string): string {
  const m = String(message || '').toLowerCase();
  const roles = [
    'vice president',
    'president',
    'prime minister',
    'governor',
    'mayor',
    'attorney general',
    'secretary of state',
    'speaker',
    'ceo',
  ];
  const found = roles.find(r => m.includes(r));
  return found || 'office holder';
}

const DOMAIN_POLICIES: Record<Exclude<DomainType, 'generic'>, DomainPolicy> = {
  office_holder: {
    domain: 'office_holder',
    must_verify: true,
    default_scope: { country: 'United States' },
    expected_entity_class: 'office_holder',
    expected_keywords: ['United States', 'White House'],
    buildTemplate: (normalized, scope) => {
      const role = extractOfficeRole(normalized.search_text || normalized.chat_text || normalized.raw_text);
      const country = scope.country || 'United States';
      return `${role} of ${country}`;
    },
  },
  weather: {
    domain: 'weather',
    must_verify: true,
    expected_entity_class: 'weather',
    expected_keywords: [],
    buildTemplate: (normalized, scope) => {
      const base = normalized.search_text || normalized.chat_text || normalized.raw_text;
      return `${base}${scope.time_window ? ` ${scope.time_window}` : ''} weather forecast`;
    },
  },
  breaking_news: {
    domain: 'breaking_news',
    must_verify: true,
    expected_entity_class: 'breaking_news',
    expected_keywords: [],
    buildTemplate: (normalized) => `${normalized.search_text || normalized.chat_text || normalized.raw_text} latest update`,
  },
  market_price: {
    domain: 'market_price',
    must_verify: true,
    expected_entity_class: 'market_price',
    expected_keywords: [],
    buildTemplate: (normalized) => `${normalized.search_text || normalized.chat_text || normalized.raw_text} current price`,
  },
  event_date_fact: {
    domain: 'event_date_fact',
    must_verify: true,
    expected_entity_class: 'event_date_fact',
    expected_keywords: [],
    buildTemplate: (normalized) => `${normalized.search_text || normalized.chat_text || normalized.raw_text} exact date`,
  },
};

function buildSearchQuery(input: QueryBuildInput): string {
  const normalized = input.normalized;
  const domain = String(input.domain || '').toLowerCase();
  const scope = input.scope || {};
  const expected = Array.isArray(input.expected_keywords) ? input.expected_keywords.filter(Boolean) : [];
  let q = String(input.templates?.default || normalized.search_text || normalized.chat_text || normalized.raw_text || '').trim();

  if (domain && domain !== 'generic' && DOMAIN_POLICIES[domain as Exclude<DomainType, 'generic'>]) {
    const policy = DOMAIN_POLICIES[domain as Exclude<DomainType, 'generic'>];
    q = String(input.templates?.default || policy.buildTemplate(normalized, scope)).trim();
  } else if (domain === 'office_holder') {
    const role = extractOfficeRole(q);
    const country = scope.country || 'United States';
    q = `${role} of ${country}`.trim();
  } else if (domain === 'weather') {
    if (!/\b(weather|forecast)\b/i.test(q)) q = `${q} weather forecast`;
    if (scope.time_window && !q.toLowerCase().includes(scope.time_window.toLowerCase())) q = `${q} ${scope.time_window}`;
  } else if (domain === 'breaking_news') {
    if (!/\b(latest|today|breaking|update)\b/i.test(q)) q = `${q} latest update`;
  } else if (domain === 'market_price') {
    if (!/\b(current|latest|today|price|quote)\b/i.test(q)) q = `${q} current price`;
  } else if (domain === 'event_date_fact') {
    if (!/\b(date|when did|exact date)\b/i.test(q)) q = `${q} exact date`;
  }

  if (expected.length) {
    const lower = q.toLowerCase();
    for (const k of expected) {
      if (!lower.includes(String(k).toLowerCase())) q = `${q} ${k}`;
    }
  }
  return q.replace(/\s+/g, ' ').trim();
}

function decideRoute(normalized: NormalizedRequest): RouteDecision {
  const message = normalized.chat_text || normalized.raw_text;
  if (isOfficeHolderQuery(message)) {
    const policy = DOMAIN_POLICIES.office_holder;
    const expectedCountry = hasCountryDisambiguation(message) ? undefined : policy.default_scope?.country;
    const expectedKeywords = expectedCountry ? (policy.expected_keywords || []) : [];
    const query = buildSearchQuery({
      normalized,
      domain: policy.domain,
      scope: { country: expectedCountry || undefined, domain: 'office_holder' },
      expected_keywords: expectedKeywords,
    });
    return {
      tool: 'web_search',
      params: { query, max_results: 5 },
      locked_by_policy: true,
      lock_reason: 'must-verify office holder',
      requires_verification: policy.must_verify,
      domain: policy.domain,
      provenance: 'policy_template',
      expected_country: expectedCountry || undefined,
      expected_entity_class: policy.expected_entity_class,
      expected_keywords: expectedKeywords,
    };
  }
  if (isWeatherQuery(message)) {
    const policy = DOMAIN_POLICIES.weather;
    const query = buildSearchQuery({
      normalized,
      domain: policy.domain,
      scope: { domain: 'weather', time_window: /\b(tonight|today|tomorrow)\b/i.test(message) ? (message.match(/\b(tonight|today|tomorrow)\b/i)?.[1] || '') : '' },
    });
    return {
      tool: 'web_search',
      params: { query, max_results: 5 },
      locked_by_policy: true,
      lock_reason: 'must-verify weather',
      requires_verification: policy.must_verify,
      domain: policy.domain,
      provenance: 'policy_template',
      expected_entity_class: policy.expected_entity_class,
      expected_keywords: policy.expected_keywords || [],
    };
  }
  if (isMarketQuery(message)) {
    const policy = DOMAIN_POLICIES.market_price;
    const query = buildSearchQuery({
      normalized,
      domain: policy.domain,
      scope: { domain: 'market_price' },
    });
    return {
      tool: 'web_search',
      params: { query, max_results: 5 },
      locked_by_policy: true,
      lock_reason: 'must-verify market price',
      requires_verification: policy.must_verify,
      domain: policy.domain,
      provenance: 'policy_template',
      expected_entity_class: policy.expected_entity_class,
      expected_keywords: policy.expected_keywords || [],
    };
  }
  if (isBreakingNewsQuery(message)) {
    const policy = DOMAIN_POLICIES.breaking_news;
    const query = buildSearchQuery({
      normalized,
      domain: policy.domain,
      scope: { domain: 'breaking_news' },
    });
    return {
      tool: 'web_search',
      params: { query, max_results: 5 },
      locked_by_policy: true,
      lock_reason: 'must-verify breaking news',
      requires_verification: policy.must_verify,
      domain: policy.domain,
      provenance: 'policy_template',
      expected_entity_class: policy.expected_entity_class,
      expected_keywords: policy.expected_keywords || [],
    };
  }
  if (isEventDateQuery(message)) {
    const policy = DOMAIN_POLICIES.event_date_fact;
    const query = buildSearchQuery({
      normalized,
      domain: policy.domain,
      scope: { domain: 'event_date_fact' },
    });
    return {
      tool: 'web_search',
      params: { query, max_results: 5 },
      locked_by_policy: true,
      lock_reason: 'must-verify event date',
      requires_verification: policy.must_verify,
      domain: policy.domain,
      provenance: 'policy_template',
      expected_entity_class: policy.expected_entity_class,
      expected_keywords: policy.expected_keywords || [],
    };
  }
  return {
    tool: null,
    params: {},
    locked_by_policy: false,
    lock_reason: '',
    requires_verification: false,
    domain: 'generic',
    provenance: 'user_direct',
    expected_keywords: [],
  };
}

function isMustVerifyDomain(domain?: string): boolean {
  const d = String(domain || '').toLowerCase();
  return ['office_holder', 'weather', 'breaking_news', 'market_price', 'event_date_fact'].includes(d);
}

function shouldRetryEntitySanity(args: {
  toolData?: any;
  expectedCountry?: string;
  expectedKeywords?: string[];
  expectedEntityClass?: string;
}): boolean {
  const expectedCountry = String(args.expectedCountry || '').toLowerCase();
  const expectedKeywords = Array.isArray(args.expectedKeywords) ? args.expectedKeywords.map(k => String(k).toLowerCase()) : [];
  const rows = Array.isArray(args.toolData?.results) ? args.toolData.results.slice(0, 5) : [];
  if (!rows.length) return false;
  const corpus = rows
    .map((r: any) => `${String(r?.title || '')} ${String(r?.snippet || '')}`.toLowerCase())
    .join(' ');
  if (!corpus) return false;
  if (expectedKeywords.length && expectedKeywords.some(k => corpus.includes(k))) return false;
  if (expectedCountry === 'united states') {
    const nonUsSignals = /\b(philippines|manila|duterte|marcos|ukraine|moscow|beijing|canada|australia)\b/.test(corpus);
    const usSignals = /\b(united states|u\.s\.|white house|washington|usa\.gov|congress\.gov)\b/.test(corpus);
    if (nonUsSignals && !usSignals) return true;
  }
  return false;
}

function refineQueryForExpectedScope(query: string, expectedCountry?: string, expectedKeywords?: string[]): string {
  let q = String(query || '').trim();
  const kws = Array.isArray(expectedKeywords) ? expectedKeywords.filter(Boolean) : [];
  if (expectedCountry && !new RegExp(`\\b${expectedCountry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(q)) {
    q = `${q} ${expectedCountry}`;
  }
  for (const kw of kws) {
    if (!new RegExp(`\\b${String(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(q)) q = `${q} ${kw}`;
  }
  return q.replace(/\s+/g, ' ').trim();
}

function hasConcreteTaskVerb(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return /\b(create|edit|read|search|summarize|run|write|build|fix|implement|find|check|verify|look up|analyze|change|modify|set|overwrite|replace|update|remove|delete|rename|move)\b/.test(m);
}

function isConversationIntent(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (/\b(i wanna just talk|i want to just talk|just talk|let'?s just talk|just chat|let'?s chat|chat with me)\b/.test(m)) return true;
  if (/\b(what model are you|who are you|introduce yourself)\b/.test(m)) return true;
  return false;
}

function isReactionLikeMessage(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  const short = m.length <= 80;
  const phatic = /\b(crazy|isn'?t it|right\??|lol|lmao|wtf|wow|no way|thats crazy|that's crazy|damn)\b/.test(m);
  return short && phatic && !hasConcreteTaskVerb(m);
}

function isGreetingOnlyMessage(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (hasConcreteTaskVerb(m)) return false;
  if (isLikelyToolDirective(m)) return false;
  if (isFileOperationRequest(m)) return false;
  if (needsFreshLookup(m)) return false;
  const words = m.split(/\s+/).filter(Boolean);
  if (words.length > 14) return false;
  const greetingCue = /\b(hey|hi|hello|yo|howdy|good morning|good afternoon|good evening|what'?s up|whats up|hows it going|how'?s it going|how are you)\b/;
  if (greetingCue.test(m) && /\b(still\s+)?just\s+testing\b/.test(m)) return true;
  return greetingCue.test(m);
}

function isRetryOnlyMessage(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (hasConcreteTaskVerb(m)) return false;
  return /\b(try again|retry|do it again|again please|it didn'?t update|it did not update|didn'?t work|did not work|failed)\b/.test(m);
}

function getLatestFailedExecuteObjective(state: AgentSessionState): string {
  const current = state.currentTurnExecution;
  if (current && current.mode === 'execute' && current.status === 'failed') {
    return String(current.objective_normalized || current.objective_raw || '').trim();
  }
  const recent = Array.isArray(state.recentTurnExecutions) ? state.recentTurnExecutions : [];
  for (const turn of recent) {
    if (turn && turn.mode === 'execute' && turn.status === 'failed') {
      const text = String(turn.objective_normalized || turn.objective_raw || '').trim();
      if (text) return text;
    }
  }
  return '';
}

function getLatestExecuteObjectiveByTool(
  state: AgentSessionState,
  toolName: string,
  statuses: TurnExecutionStatus[] = ['done', 'repaired', 'failed']
): string {
  const wanted = String(toolName || '').trim().toLowerCase();
  if (!wanted) return '';
  const turns: TurnExecution[] = [];
  if (state.currentTurnExecution) turns.push(state.currentTurnExecution);
  const recent = Array.isArray(state.recentTurnExecutions) ? state.recentTurnExecutions : [];
  turns.push(...recent);
  for (const turn of turns) {
    if (!turn || turn.mode !== 'execute') continue;
    if (Array.isArray(statuses) && statuses.length > 0 && !statuses.includes(turn.status)) continue;
    const calls = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
    const hasTool = calls.some((c) =>
      String(c?.tool_name || '').trim().toLowerCase() === wanted
      && String(c?.phase || '').toLowerCase() === 'call');
    if (!hasTool) continue;
    const objective = String(turn.objective_normalized || turn.objective_raw || '').trim();
    if (objective) return objective;
  }
  return '';
}

function resolveRetryReplayMessage(message: string, state: AgentSessionState): string {
  if (!FEATURE_FLAGS.retry_failed_fileop_replay) return '';
  if (!isRetryOnlyMessage(message)) return '';
  const replay = getLatestFailedExecuteObjective(state);
  if (!replay) return '';
  if (normalizeTaskTitleForMatch(replay) === normalizeTaskTitleForMatch(message)) return '';
  return replay;
}

function resolveCorrectiveReplayMessage(message: string, state: AgentSessionState): string {
  if (!FEATURE_FLAGS.retry_failed_fileop_replay) return '';
  const raw = normalizeCommonFileTypos(String(message || '').trim());
  const m = raw.toLowerCase();
  if (!m) return '';
  if (isFileOperationRequest(raw) || isWorkspaceListingRequest(raw) || isLikelyToolDirective(raw) || needsFreshLookup(raw)) return '';
  if (!(isCorrectiveRetryCue(m) || isRetryOnlyMessage(m))) return '';

  const failedReplay = resolveRetryReplayMessage(raw, state);
  if (failedReplay) return failedReplay;

  const listComplaint =
    /\b(list|listed|listing|files?|folders?|directories?|items?|workspace)\b/.test(m)
    && /\b(incorrect|correctly|right|properly|wrong|miss(?:ed|ing)?|left\s*out|forgot|didn'?t|did not|not)\b/.test(m);
  if (!listComplaint) return '';

  const listReplay = getLatestExecuteObjectiveByTool(state, 'list', ['done', 'repaired', 'failed']);
  if (listReplay && normalizeTaskTitleForMatch(listReplay) !== normalizeTaskTitleForMatch(raw)) return listReplay;
  return 'List the current files in the workspace.';
}

function asksForSources(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  return /\b(with sources|cite|citations?|source(s)?|proof|evidence|verify|verified)\b/.test(m);
}

function inferDiscussSubmode(message: string, history: any[]): DiscussSubmode {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return 'chat';

  if (isReactionLikeMessage(m)) return 'chat';

  const wordCount = m.split(/\s+/).filter(Boolean).length;
  if (wordCount < 12 && !hasConcreteTaskVerb(m)) return 'chat';

  if (/\b(that'?s wild|thats wild|no way|damn|bro|lol|lmao|wtf|wow|crazy|isn'?t it|right\??)\b/.test(m)) {
    return 'chat';
  }

  if (/\b(what should i do|what next|how do i|help me|walk me through|can you explain)\b/.test(m)) {
    return 'coach';
  }
  if (/\b(plan|steps|strategy|roadmap|approach)\b/.test(m)) return 'coach';
  if (/\bif it was real|hypothetical|hypothetically|in that case|what would you do\b/.test(m)) return 'coach';

  const recentAssistant = (history || [])
    .slice()
    .reverse()
    .find((h: any) => h?.role === 'assistant');
  if (recentAssistant && /\?$/.test(String(recentAssistant.content || '').trim()) && /\b(yes|yeah|ok|okay|sure)\b/.test(m)) {
    return 'coach';
  }
  return 'chat';
}

function isLikelyToolDirective(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (/\b(use|try|run|call)\s+(the\s+)?(web|search|tool|tools)\b/.test(m)) return true;
  if (/\bsearch\s+(the\s+)?web\b/.test(m) || /\bweb\s+search\b/.test(m)) return true;
  if (/\b(look\s*(it|that|this)?\s*up|check\s*(it|that|this)?\s*(online|on the web)?|verify\s*(it|that|this)?|find\s+sources|search\s+for)\b/.test(m)) return true;
  if (/\b(figure it out|go check|check online|check the web)\b/.test(m)) return true;
  if (/\bwhat\s+does\s+the\s+web\s+say\b/.test(m)) return true;
  return false;
}

function extractExplicitSearchTarget(message: string): string | null {
  const m = String(message || '').trim();
  const patterns = [
    /\b(?:search|look up|find|check|verify)\s+(?:for\s+)?["']?(.+?)["']?$/i,
    /\bwhat does the web say about\s+["']?(.+?)["']?\??$/i,
    /\buse (?:the )?web(?: to)?\s+(?:search|find|check)\s+(?:for\s+)?["']?(.+?)["']?$/i,
  ];
  for (const p of patterns) {
    const hit = m.match(p);
    if (hit?.[1]) {
      const t = hit[1].trim();
      if (t && !/^(it|that|this|the same|previous one|previous question)$/i.test(t)) return t;
    }
  }
  return null;
}

function hasNamedEntityLikeToken(message: string): boolean {
  const raw = String(message || '').trim();
  if (!raw) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  // crude heuristic: any non-first token capitalized likely refers to an entity
  return tokens.slice(1).some(t => /^[A-Z][a-z]/.test(t));
}

function isAmbiguousReferentialQuestion(message: string): boolean {
  const raw = String(message || '').trim();
  const m = raw.toLowerCase();
  if (!m) return false;
  const hasPronoun = /\b(that|this|it|they|he|she|those|these)\b/.test(m);
  const hasQIntent = /\b(why|how|what|when|where|who)\b/.test(m) || isQuestionLike(m);
  return hasPronoun && hasQIntent && !hasNamedEntityLikeToken(raw);
}

function resolveReferencedSearchTarget(message: string, state: AgentSessionState, history: any[]): string | null {
  const explicit = extractExplicitSearchTarget(message);
  if (explicit) return explicit;

  const m = String(message || '').toLowerCase();
  const likelyRef = /\b(it|that|this|same|previous|last)\b/.test(m) || isLikelyToolDirective(m);
  if (!likelyRef) return null;

  const recentUsers = (history || [])
    .slice()
    .reverse()
    .filter((h: any) => h?.role === 'user')
    .map((h: any) => String(h?.content || '').trim())
    .filter(Boolean);

  for (const u of recentUsers) {
    if (u.toLowerCase() === m) continue;
    if (isQuestionLike(u)) return u;
  }

  const recentTurns = (state.turns || []).slice().reverse();
  for (const t of recentTurns) {
    if (!t?.text) continue;
    if (isQuestionLike(t.text) || t.kind === 'side_question') return t.text;
  }

  if (state.lastEvidence?.question) {
    const q = String(state.lastEvidence.question || '').trim();
    const a = String(state.lastEvidence.answer_summary || '').trim();
    if (q && a) return `${q} context: ${a}`;
    if (q) return q;
  }

  if (state.activeObjective) return state.activeObjective;
  if (state.objective) return state.objective;
  return null;
}

async function inferNaturalToolIntent(
  ollama: any,
  message: string,
  state: AgentSessionState,
  history: any[],
  policyDecision?: RouteDecision
): Promise<{ tool: 'web_search' | 'time_now'; params: any; reason: string; confidence: number } | null> {
  if (policyDecision?.locked_by_policy && policyDecision.tool) {
    return {
      tool: policyDecision.tool,
      params: policyDecision.params,
      reason: `policy-lock: ${policyDecision.lock_reason}`,
      confidence: 1,
    };
  }
  const historyText = summarizeHistoryForPrompt(history || [], 6);
  const prompt = [
    `Decide if the user message requires a tool call.`,
    `Return ONLY JSON with keys: use_tool (boolean), tool ("web_search"|"time_now"|"none"), query (string), confidence (0..1), reason (string).`,
    `Use "web_search" for requests to look up/verify/check online, current/fresh facts, or when user asks what the web says.`,
    `Use "time_now" only for current time/date/day questions.`,
    `If no tool needed, set tool to "none".`,
    `Recent context:\n${historyText || '(none)'}`,
    `Plan context:\n${buildPlanContext(state)}`,
    `User message:\n${message}`,
  ].join('\n\n');

  try {
    const out = await ollama.generateWithRetryThinking(prompt, 'executor', {
      temperature: 0,
      num_ctx: 1536,
      think: 'low',
      system: 'You are a strict JSON classifier. Output JSON only.',
    });
    const raw = String(out.response || '').trim();
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    const useTool = !!parsed.use_tool;
    const tool = String(parsed.tool || 'none').toLowerCase();
    const confidence = Number(parsed.confidence ?? 0);
    const reason = String(parsed.reason || 'router decision');
    const query = String(parsed.query || '').trim();

    if (!useTool || tool === 'none') return null;
    if (tool === 'time_now') {
      return { tool: 'time_now', params: {}, reason, confidence: isFinite(confidence) ? confidence : 0.5 };
    }
    if (tool === 'web_search') {
      const normalized = normalizeUserRequest(message);
      let resolvedQuery = query || resolveReferencedSearchTarget(message, state, history) || normalized.search_text || normalized.chat_text;
      if (isAmbiguousReferentialQuestion(message) && state.lastEvidence?.question) {
        const baseQ = String(state.lastEvidence.question || '').trim();
        const baseA = String(state.lastEvidence.answer_summary || '').trim();
        resolvedQuery = `${baseQ}${baseA ? ` (${baseA})` : ''} ${message}`.trim();
      }
      const policy = decideRoute(normalized);
      const finalQuery = buildSearchQuery({
        normalized,
        domain: policy.expected_entity_class || undefined,
        scope: { country: policy.expected_country, domain: policy.expected_entity_class || undefined },
        templates: { default: resolvedQuery },
        expected_keywords: policy.expected_keywords,
      });
      return { tool: 'web_search', params: { query: finalQuery, max_results: 5 }, reason, confidence: isFinite(confidence) ? confidence : 0.5 };
    }
    return null;
  } catch {
    return null;
  }
}

function needsFreshLookup(message: string): boolean {
  const m = message.toLowerCase().trim();
  if (isConversationIntent(m) || isReactionLikeMessage(m)) return false;
  const freshnessCue = /\b(current|latest|today|now|right now|as of|recent)\b/.test(m);
  const dynamicTopic = /\b(price|quote|stock|crypto|bitcoin|btc|ethereum|eth|weather|forecast|news|headline|score|results|exchange rate|interest rate|market cap|version|release|released|announcement|announced|launch|launched|roadmap|changelog|outcome|hearing|trial|case|investigation|lawsuit|court|testimony|update|status)\b/.test(m);
  const modelReleaseTopic = /\b(model)\b/.test(m) && /\b(version|release|released|announcement|launch|changelog|latest|current)\b/.test(m);
  const publicOffice = /\b(attorney general|ag\b|president|vice president|secretary of state|speaker|senate majority leader|chief justice|governor|mayor|ceo|prime minister|chancellor|minister|director)\b/.test(m);
  const explicitWhoOffice = /^(who'?s|whos|who is)\b/.test(m) && publicOffice;
  const tenureQuery = /\bhow many days\b/.test(m) && /\b(in office|since)\b/.test(m);
  return explicitWhoOffice || tenureQuery || (freshnessCue && (dynamicTopic || modelReleaseTopic || publicOffice)) || (isQuestionLike(m) && (dynamicTopic || modelReleaseTopic));
}

function isMemorySafeFact(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length < 8) return false;
  if (/^error|^max steps/i.test(t)) return false;
  if (/\bcould not produce\b|\bformat violation\b|\bunsupported_mutation\b|\bmissing_required_input\b/i.test(t)) return false;
  if (/^blocked\b/i.test(t)) return false;
  if (/https?:\/\//i.test(t)) return false;
  if (/^\[\d+\]/.test(t)) return false;
  if (/^THOUGHT:/i.test(t)) return false;
  if (/\b(ACTION|PARAM|FINAL):/i.test(t)) return false;
  return true;
}

function isLowQualityFinalReply(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^Q\d+:\s*$/im.test(t)) return true;
  if (/Q:\s*.+\nA:\s*$/im.test(t)) return true;
  if (/^Q\d+:\s*\nQ:\s*.+\nA:\s*$/im.test(t)) return true;
  return false;
}

function hasDateLikePhrase(text: string): boolean {
  const t = String(text || '');
  if (!t) return false;
  if (/\b(20\d{2}-\d{2}-\d{2})\b/.test(t)) return true;
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*20\d{2})?/i.test(t)) return true;
  return false;
}

function hasCausalLanguage(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return /\b(because|due to|citing|stated|reason|rationale|in order to|aimed to)\b/.test(t);
}

function failsAnswerForm(question: string, reply: string): boolean {
  const q = String(question || '').toLowerCase().trim();
  const r = String(reply || '').trim();
  if (!r) return true;
  const urlCount = (r.match(/https?:\/\//g) || []).length;
  const lineCount = r.split(/\n+/).filter(Boolean).length;
  if (urlCount >= 2 && lineCount <= 4 && r.length < 320) return true;
  if (/^\s*(sources?:|1\.\s+https?:\/\/)/im.test(r) && !/[a-z]/i.test(r.replace(/https?:\/\/\S+/g, ''))) return true;
  if (/^\s*when\b/.test(q) && !hasDateLikePhrase(r)) return true;
  if (/^\s*why\b/.test(q) && !hasCausalLanguage(r)) return true;
  return false;
}

async function repairAnswerForm(
  ollama: any,
  systemPrompt: string,
  question: string,
  draftReply: string
): Promise<string> {
  if (!failsAnswerForm(question, draftReply)) return draftReply;
  const prompt = [
    `Rewrite the answer so it directly answers the user's question first.`,
    `Output format: 1-3 sentences answer first, then optional "Sources:" with 2-3 links if present.`,
    `Do not output only titles or only URLs.`,
    `Question: ${question}`,
    `Draft answer: ${draftReply}`,
    `Rewritten answer:`,
  ].join('\n\n');
  try {
    const out = await ollama.generateWithRetryThinking(prompt, 'executor', {
      temperature: 0.1,
      system: `${systemPrompt}\n\nBe direct and concrete.`,
      num_ctx: 1536,
      think: 'low',
    });
    const { cleaned } = stripThinkTags(out.response || '');
    const repaired = stripProtocolArtifacts(cleaned || '').trim();
    return repaired || draftReply;
  } catch {
    return draftReply;
  }
}

function isTenureDaysQuery(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return /\bhow many days\b/.test(m) && /\b(in office|since|been in office)\b/.test(m);
}

function extractDateCandidate(text: string): Date | null {
  const s = String(text || '');
  // ISO date
  const iso = s.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso?.[1]) {
    const d = new Date(`${iso[1]}T00:00:00Z`);
    if (!isNaN(d.getTime())) return d;
  }
  // Month name date, year
  const mdy = s.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-3]?\d)(?:st|nd|rd|th)?(?:,)?\s+(20\d{2})\b/i);
  if (mdy) {
    const d = new Date(`${mdy[1]} ${mdy[2]}, ${mdy[3]} 00:00:00 UTC`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

async function answerTenureDaysQuery(message: string): Promise<{ ok: boolean; reply?: string; toolText?: string }> {
  const registry = getToolRegistry();
  const m = String(message || '').toLowerCase();
  const subj = m.match(/\b(has|have)\s+(.+?)\s+(currently\s+)?been in office\b/i)?.[2]?.trim()
    || m.match(/\bhow many days has\s+(.+?)\s+been in office\b/i)?.[1]?.trim()
    || m.match(/\bhow many days since\s+(.+?)\s+took office\b/i)?.[1]?.trim()
    || 'the person';

  const normalized = normalizeUserRequest(`${subj} inauguration date`);
  const query = buildSearchQuery({
    normalized,
    domain: 'event_date_fact',
    scope: { domain: 'event_date_fact' },
  });
  const webExec = await executeWebSearchWithSanity(
    { query, max_results: 5 },
    { expectedEntityClass: 'event_date_fact' }
  );
  const web = webExec.toolRes;
  if (!web.success) return { ok: false };
  const toolText = String(web.stdout || '');
  const start = extractDateCandidate(toolText);
  if (!start) return { ok: false, toolText };

  const nowTool = await registry.execute('time_now', {});
  let now = new Date();
  const nowIso = String(nowTool.data?.iso || '');
  if (nowIso) {
    const d = new Date(nowIso);
    if (!isNaN(d.getTime())) now = d;
  }
  const diffDays = Math.floor((now.getTime() - start.getTime()) / 86400000);
  if (!isFinite(diffDays) || diffDays < 0) return { ok: false, toolText };

  const startYmd = start.toISOString().slice(0, 10);
  const nowYmd = now.toISOString().slice(0, 10);
  const reply = `${subj} has been in office for ${diffDays} days (from ${startYmd} to ${nowYmd}).`;
  return { ok: true, reply, toolText };
}

function parseMemoryInstruction(message: string): { fact: string; key?: string; action: 'append' | 'upsert' } | null {
  const m = String(message || '').trim();
  if (!m) return null;

  const direct = m.match(/^(remember|save|note|store|for future reference|update memory|mark this down)\s*[:,-]?\s+(.+)$/i);
  if (direct && direct[2]) {
    const fact = direct[2].trim();
    if (fact.length >= 3) {
      return { fact, action: 'append' };
    }
  }

  const natural = m.match(/^(?:can you|please|could you)?\s*(?:also\s*)?(?:update|remember|store|save)\s*(?:in\s*)?(?:your\s*)?memory\s*(?:that)?\s*[:,-]?\s+(.+)$/i);
  if (natural && natural[1]) {
    const fact = natural[1].trim();
    const lhs = fact.match(/^(.+?)\s+(is|are|was|were)\s+/i)?.[1]?.trim();
    const key = lhs ? `fact:${normalizeFactKey(lhs)}` : `fact:${normalizeFactKey(fact)}`;
    if (fact.length >= 3) {
      return { fact, key, action: 'upsert' };
    }
  }

  const correction = m.match(/^(you('| a)?re wrong|that's wrong|that is wrong|incorrect|correction)\s*[:,-]?\s+(.+)$/i);
  if (correction && correction[3]) {
    const fact = correction[3].trim();
    const lhs = fact.match(/^(.+?)\s+(is|are|was|were)\s+/i)?.[1]?.trim();
    const key = lhs ? `fact:${normalizeFactKey(lhs)}` : `fact:${normalizeFactKey(fact)}`;
    if (fact.length >= 3) {
      return { fact, key, action: 'upsert' };
    }
  }

  const simpleCorrection = m.match(/^actually[,:\s]+(.+)$/i);
  if (simpleCorrection && simpleCorrection[1]) {
    const fact = simpleCorrection[1].trim();
    const lhs = fact.match(/^(.+?)\s+(is|are|was|were)\s+/i)?.[1]?.trim();
    const key = lhs ? `fact:${normalizeFactKey(lhs)}` : `fact:${normalizeFactKey(fact)}`;
    if (fact.length >= 3) {
      return { fact, key, action: 'upsert' };
    }
  }

  return null;
}

function extractTaskCandidates(message: string): string[] {
  const text = message.replace(/\s+/g, ' ').trim();
  const parts = text.split(/[.\n;]+/).map(p => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length < 8) continue;
    if (/\b(build|create|implement|fix|refactor|write|test|deploy|add|remove|update|ship)\b/i.test(part)) {
      out.push(part);
    }
    if (/^-\s+/.test(part) || /^\d+\)/.test(part)) {
      out.push(part.replace(/^-\s+/, '').replace(/^\d+\)\s*/, ''));
    }
  }
  return out.slice(0, 6);
}

function classifyTurnKind(message: string, state: AgentSessionState): TurnKind {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return 'discuss';
  if (m.startsWith('/chat ')) return 'discuss';
  if (m.startsWith('/exec ')) return 'side_question';
  if (isStyleMutationTurn(message, state) || isStructuralMutationTurn(message, state) || isFileOperationRequest(m) || isFileFollowupOperationRequest(m, state) || isShellOperationRequest(m)) return 'side_question';
  if (isConversationIntent(m)) return 'discuss';
  if (isReactionLikeMessage(m)) return 'discuss';

  if (/\b(plan|roadmap|strategy|approach|brainstorm|requirements|scope)\b/.test(m)) return 'plan';
  if (isLikelyToolDirective(m)) return 'side_question';
  if (isQuestionLike(m) && isMarketFollowUpMessage(m) && (
    hasRecentVerifiedFactType(state, 'market_price', 240)
    || state.turns.slice(-4).some(t => /\b(price|quote|market|futures?|comex|cme|bitcoin|btc|gold|silver|oil)\b/i.test(String(t?.text || '')))
  )) return 'side_question';
  // For small models, freshness lookups should not depend on strict question punctuation/shape.
  if (needsFreshLookup(m)) return 'side_question';
  if (isQuestionLike(m) && asksForSources(m)) return 'side_question';
  if (/\bif it was real|hypothetical|hypothetically\b/.test(m) && !asksForSources(m)) return 'discuss';
  if (isQuestionLike(m)) return 'discuss';

  if (/\b(continue|next|keep going|go ahead|proceed|resume|do it|execute)\b/.test(m)) return 'continue_plan';

  // Deictic references usually refer to the current active objective.
  if (/\b(this|that|it|same task|same objective)\b/.test(m) && state.activeObjective) return 'continue_plan';

  if (/\b(create|build|implement|fix|refactor|write|test|deploy|add|remove|update|ship)\b/.test(m)) {
    return state.activeObjective ? 'continue_plan' : 'new_objective';
  }

  return 'discuss';
}

function isReferentialFollowUp(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  const directReference =
    /\b(that|it|this|them|those|same|inside|content|contents|that info|that answer|your answer|the last one|previous answer|source|sources|evidence|proof)\b/.test(m);
  if (directReference) return true;
  const correctiveCue =
    /\b(again|retry|try again|didn'?t|did not|not all|missing|you missed|you never|still|wrong|failed|didn'?t work|did not work|not updated|never sent)\b/.test(m);
  const actionContext =
    /\b(remove|delete|list|show|read|write|edit|update|rename|copy|move|create|open|changed|fixed|sent|worked)\b/.test(m);
  if (correctiveCue && (actionContext || /\b(it|them|those|all)\b/.test(m))) return true;
  return false;
}

function isSourceFollowUp(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (/\b(where (did|do) you get (that|this|it|the info|the information) from)\b/.test(m)) return true;
  if (/\b(what('?s| is) your source|sources\??|cite (it|that|this|sources)|how do you know)\b/.test(m)) return true;
  if (/\bsource\??$/.test(m)) return true;
  return false;
}

function isFreshnessOrProvenanceQuery(message: string): boolean {
  return needsFreshLookup(message) || isSourceFollowUp(message);
}

function isMarketFollowUpMessage(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  return /\b(futures?|comex|cme|contract|front month|expiry|basis|contango|backwardation|gc|si|cl|hg|es|nq|ym|zb|zn|6e|dxy)\b/.test(m)
    || /^(what about|how about|and what about|and)\b/.test(m);
}

function hasRecentVerifiedFactType(state: AgentSessionState, factType: string, maxAgeMinutes = 180): boolean {
  const facts = Array.isArray(state?.verifiedFacts) ? state.verifiedFacts : [];
  const now = Date.now();
  const maxAgeMs = Math.max(1, Number(maxAgeMinutes || 180)) * 60_000;
  return facts.some((f: any) => String(f?.fact_type || '').toLowerCase() === String(factType || '').toLowerCase()
    && Number.isFinite(f?.verified_at)
    && (now - Number(f.verified_at)) <= maxAgeMs);
}

function needsDeterministicExecute(message: string, state?: AgentSessionState): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  if (isWorkspaceListingFollowupRequest(m, state)) return true;
  if (isStyleMutationTurn(message, state) || isStructuralMutationTurn(message, state)) return true;
  if (isFileOperationRequest(m) || isFileFollowupOperationRequest(m, state) || isShellOperationRequest(m)) return true;
  if (isQuestionLike(m) && isMarketFollowUpMessage(m) && (
    hasRecentVerifiedFactType(state as any, 'market_price', 240)
    || ((state as any)?.turns || []).slice(-4).some((t: any) => /\b(price|quote|market|futures?|comex|cme|bitcoin|btc|gold|silver|oil)\b/i.test(String(t?.text || '')))
  )) return true;
  if (isFreshnessOrProvenanceQuery(m) && isQuestionLike(m)) return true;
  if (isQuestionLike(m) && /\b(futures?|comex|cme|contract|front month|expiry|basis|contango|backwardation)\b/.test(m)) return true;
  if (/\b(can|could|would|will)\s+you\b/.test(m) && /\b(check|verify|look up|search|find out|tell me)\b/.test(m)) return true;
  if (/\bhow many days\b/.test(m) && /\b(in office|since|been in office)\b/.test(m)) return true;
  return false;
}

function isFileOperationRequest(message: string): boolean {
  const normalized = normalizeCommonFileTypos(String(message || ''));
  const m = normalized.toLowerCase().trim();
  if (!m) return false;
  if (isStyleMutationTurn(normalized) || isStructuralMutationTurn(normalized)) return true;
  if (isWorkspaceListingRequest(m)) return true;
  if (/\b(create|make|write|edit|update|append|delete|remove|rename|move|copy|read|open|list|change|modify|set|overwrite|replace|change the name|change name)\b/.test(m)
    && /\b(files?|folders?|directories?|workspace|repo|repository|path|txt|md|json|ts|js|py|html|css)\b/.test(m)) {
    return true;
  }
  if (/\bchange\b/.test(m) && /\bname\b/.test(m) && /\b(files?|txt|md|json|ts|js|py|html|css)\b/.test(m)) return true;
  if (/\b(create|make)\b/.test(m) && /\bnew\b/.test(m) && /\b\.([a-z0-9]{1,6})\b/.test(m)) return true;
  return false;
}

function isWorkspaceListingRequest(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (hasConcreteTaskVerb(m) && !/\b(list|show|display|read|open)\b/.test(m)) return false;
  const queryCue = /\b(list|show|display|what|which|tell me|how many|count)\b/.test(m);
  const objectCue = /\b(files?|folders?|directories?|items?)\b/.test(m);
  const locationCue = /\b(workspace|folder|directory|repo|repository|here|current)\b/.test(m);
  return queryCue && objectCue && locationCue;
}

function hasRecentWorkspaceListContext(state?: AgentSessionState): boolean {
  const s = state as any;
  if (!s) return false;
  const candidates: any[] = [];
  if (s.currentTurnExecution) candidates.push(s.currentTurnExecution);
  if (Array.isArray(s.recentTurnExecutions)) candidates.push(...s.recentTurnExecutions.slice(0, 6));
  for (const exec of candidates) {
    const calls = Array.isArray(exec?.tool_calls) ? exec.tool_calls : [];
    for (const c of calls) {
      const name = String(c?.tool_name || '').toLowerCase();
      if (name !== 'list') continue;
      const status = String(c?.status || '').toLowerCase();
      const result = String(c?.result_summary || '').toLowerCase();
      if (status === 'error' || /^error:/.test(result)) continue;
      return true;
    }
  }
  return false;
}

function isWorkspaceListingFollowupRequest(message: string, state?: AgentSessionState): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (isWorkspaceListingRequest(m)) return true;
  const retryLike = /\b(again|retry|recheck|double[-\s]?check|try again)\b/.test(m);
  const incorrectList =
    /\b(didn'?t|did not|wrong|incorrect|not right|not correct)\b[\s\S]{0,30}\blist(ed)?\b/.test(m)
    || /\blist(ed)?\b[\s\S]{0,30}\b(wrong|incorrect|not right|not correct)\b/.test(m);
  const listAgain = /\b(list|show|check|verify|count)\b/.test(m) && /\b(files?|folders?|directories?|items?|them)\b/.test(m);
  const countFollowup = /\bhow many\b/.test(m) && /\b(files?|folders?|directories?|items?)\b/.test(m);
  if (!(retryLike || incorrectList || listAgain || countFollowup)) return false;
  return hasRecentWorkspaceListContext(state);
}

function isFileFollowupOperationRequest(message: string, state?: AgentSessionState): boolean {
  const m = normalizeCommonFileTypos(String(message || '').toLowerCase().trim());
  if (!m) return false;
  const hasRecentFiles = !!String((state as any)?.lastFilePath || '').trim()
    || (Array.isArray((state as any)?.recentFilePaths) && (state as any).recentFilePaths.length > 0);
  if (!hasRecentFiles) return false;
  const followupPronoun = /\b(it|them|both|botb|both of them|same file|that file|those files|that|this|inside|content|contents)\b/.test(m);
  const txtFilesRef = /\btxt\s+files?\b/.test(m);
  const fileVerb = /\b(rename|move|edit|update|change|write|set|replace|append|fix|correct|remove|delete)\b/.test(m);
  const deleteVerb = /\b(remove|delete)\b/.test(m);
  const makeContentFollowup = /\bmake\b/.test(m) && /\b(to say|say|contain|with content|inside|contents?)\b/.test(m);
  const contentCue = /\b(to say|say|contain|with content|inside|contents?)\b/.test(m);
  const correctiveStyleCue = isCorrectiveRetryCue(m) && /\b(text|font|foreground|background|bg|color|theme|panel)\b/.test(m);
  const retryActionCue = /\b(try again|retry|again)\b/.test(m) && /\b(change|set|edit|update|modify|fix|correct)\b/.test(m);
  const retryOnlyCue = isRetryOnlyMessage(m);
  if (followupPronoun && (fileVerb || makeContentFollowup)) return true;
  if (followupPronoun && deleteVerb) return true;
  if (txtFilesRef && deleteVerb) return true;
  if (/\bhtml?\s+files?\b/.test(m) && deleteVerb) return true;
  if (txtFilesRef && fileVerb && contentCue) return true;
  if (/\b(edit|update|change)\b/.test(m) && /\b(both|them)\b/.test(m) && contentCue) return true;
  if (/\b(fix|correct)\b/.test(m) && /\b(that|it|inside|content|contents)\b/.test(m)) return true;
  if (retryOnlyCue) return true;
  if (correctiveStyleCue || retryActionCue) return true;
  return false;
}

function isShellOperationRequest(message: string): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  return /\b(run|execute)\b/.test(m) && /\b(command|terminal|shell|powershell|bash|cmd)\b/.test(m);
}

function requiresToolExecutionForTurn(message: string, state?: AgentSessionState): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (isLikelyToolDirective(m)) return true;
  if (isWorkspaceListingFollowupRequest(m, state)) return true;
  if (needsDeterministicExecute(m, state)) return true;
  if (isFileOperationRequest(m) || isFileFollowupOperationRequest(m, state) || isShellOperationRequest(m)) return true;
  if (/\b(can|could|would|will)\s+you\b/.test(m)
    && hasConcreteTaskVerb(m)
    && /\b(file|workspace|folder|directory|terminal|shell|command)\b/.test(m)) {
    return true;
  }
  return false;
}

function inferDeterministicFileWriteCall(message: string): { tool: 'write'; params: { path: string; content: string }; reason: string } | null {
  const raw = normalizeCommonFileTypos(String(message || '').trim());
  const m = raw.toLowerCase();
  if (!isFileOperationRequest(m)) return null;
  const hasCreateVerb = /\b(create|write)\b/.test(m);
  const hasMakeCreatePhrase = /\bmake\s+(?:a|an|another|new|brand new|whole new)\b/.test(m);
  if (!(hasCreateVerb || hasMakeCreatePhrase) || !/\b(file|txt|text file|html|md|json|css|js|ts|py)\b/.test(m)) return null;
  const inferredExt = inferRequestedFileExtension(raw);
  const filenameMatch =
    raw.match(/\b(?:name\s+it|name(?:\s+is)?|called|filename(?:\s+is)?|named)\s+["'`]?([a-zA-Z0-9._\-]+(?:\.[a-zA-Z0-9]{1,6})?)["'`]?/i)
    || raw.match(/\b(?:create|write|make)\b[\s\S]{0,120}?\b([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})\b/i);
  let fileName = String(filenameMatch?.[1] || '').trim().replace(/\s+/g, '_');
  if (!fileName) fileName = buildDefaultFileName(inferredExt, raw);
  if (!/\.[a-z0-9]{1,6}$/i.test(fileName)) fileName = `${fileName}${inferredExt}`;
  let content = extractCreateRequestedContentValue(raw, 260) || 'hello world';
  if (/\.html?$/i.test(fileName) || inferredExt === '.html') {
    const black = /\bbackground\b[\s\S]*\bblack\b|\bblack\b[\s\S]*\bbackground\b/i.test(raw);
    const white = /\btext\b[\s\S]*\bwhite\b|\bwhite\b[\s\S]*\btext\b/i.test(raw);
    const panel = /\b(panel|card|box)\b/i.test(raw);
    const displayText = extractHtmlDisplayText(raw, content || 'Hello world - i am localclaw');
    content = buildBasicHtmlDocument(displayText, {
      blackBackground: black,
      whiteText: white,
      panel: panel || true,
    });
  }
  if (!content) content = 'hello world';
  return {
    tool: 'write',
    params: { path: fileName, content },
    reason: 'Deterministic file-create route',
  };
}

function inferDeterministicSingleFileOverwriteCall(
  message: string,
  state: AgentSessionState
): { tool: 'write'; params: { path: string; content: string }; reason: string } | null {
  const raw = normalizeCommonFileTypos(String(message || '').trim());
  const m = raw.toLowerCase();
  if (!m) return null;
  const styleIntent = detectHtmlStyleMutationIntent(raw, state);
  const structuralIntent = detectHtmlStructuralMutationIntent(raw, state);
  const hasContentRewriteCue = /\bonly\s+(?:say|says)\b|\bit\s+should\s+only\s+say\b|\bit\s+should(?:\s+just)?\s+be\b|\b(?:to|t)\s+(?:just\s+)?say\b|\bremove\b[\s\S]*\b(?:extra|additional|old)\s+(?:text|words?)\b/i.test(raw);
  const hasEditVerb = /\b(edit|update|overwrite|set|replace|change|modify|write|fix|correct|make)\b/.test(m)
    || (/\bremove\b/.test(m) && hasContentRewriteCue)
    || !!structuralIntent;
  if (!hasEditVerb) return null;
  if (/\b(?:both|botb|both of them|them|those files|all(?:\s+txt\s+files?)?)\b/.test(m)) return null;
  if (/\b(remove|delete)\b/.test(m) && /\b(and|then|,)\b/.test(m)) return null;
  const explicitTxtMentions = raw.match(/\b[a-zA-Z0-9._\-]+\.txt\b/ig) || [];
  if (explicitTxtMentions.length > 1) return null;
  const hasExplicitFileCue = /\b(file|txt|text file|workspace|html?|css|js|ts|json|md|py)\b/.test(m);
  const hasReferentialCue = /\b(that|this|it|inside|content|contents|same)\b/.test(m);
  if (!hasExplicitFileCue && !hasReferentialCue && !styleIntent && !structuralIntent) return null;

  const explicitAny = raw.match(/\b([a-zA-Z0-9._\-]+\.(?:txt|md|json|ts|js|py|html|css))\b/i)?.[1];
  const txtFilePhrase = raw.match(/\b(?:the\s+)?([a-zA-Z0-9._\-]+)\s+txt\s+file\b/i)?.[1];
  const genericFilePhraseRaw = raw.match(/\b(?:the\s+)?([a-zA-Z0-9._\-]+)\s+(?:html?|md|json|css|js|ts|py)\s+file\b/i)?.[1];
  const bareFilePhraseRaw = raw.match(/\b(?:the\s+)?([a-zA-Z0-9._\-]+)\s+file\b/i)?.[1];
  const genericFilePhrase = (() => {
    const cand = String(genericFilePhraseRaw || '').trim();
    if (!cand) return '';
    if (/^(the|a|an|my|new|original|current|existing|html|htm|txt|text|file|workspace|directory|folder)$/i.test(cand)) return '';
    return cand;
  })();
  const bareFilePhrase = (() => {
    const cand = String(bareFilePhraseRaw || '').trim();
    if (!cand) return '';
    if (/^(the|a|an|my|new|original|current|existing|html|htm|txt|text|file|workspace|directory|folder)$/i.test(cand)) return '';
    return cand;
  })();
  const quotedName =
    raw.match(/\b(?:named|called|filename(?:\s+is)?|file\s+named|file\s+called)\s+["'`]?([a-zA-Z0-9._\-]+)["'`]?/i)?.[1]
    || raw.match(/\bfile\s+["'`]([a-zA-Z0-9._\-]+)["'`]/i)?.[1];
  let fileName = String(explicitAny || txtFilePhrase || genericFilePhrase || bareFilePhrase || quotedName || '').trim();
  const extHint = (styleIntent || structuralIntent) ? '.html' : inferRequestedFileExtension(raw);
  if (/^(to|the|a|an|my|new|original|current|existing|only)$/i.test(fileName)) {
    fileName = '';
  }
  if (fileName && !/\.[a-z0-9]{1,6}$/i.test(fileName)) {
    fileName = `${fileName}${extHint}`;
  }
  if (!fileName) {
    const last = String(state.lastFilePath || '').trim();
    const recentList = Array.isArray(state.recentFilePaths)
      ? state.recentFilePaths.map(p => String(p || '').trim()).filter(Boolean)
      : [];
    const recent = recentList.length ? recentList[0] : '';
    const extHintLower = String(extHint || '').toLowerCase();
    const recentByExt = extHintLower
      ? recentList.find(p => String(path.extname(p) || '').toLowerCase() === extHintLower)
      : '';
    const recentHtml = /html|panel|background|inside|text|font|foreground|color/i.test(raw)
      ? recentList.find(p => /\.html?$/i.test(String(p)))
      : '';
    if (recentByExt) {
      fileName = recentByExt;
    } else if (recentHtml) {
      fileName = String(recentHtml);
    } else if (last) {
      fileName = last;
    } else if (recent) {
      fileName = recent;
    } else if ((/html|panel|background|inside|text|font|foreground|color/i.test(raw) || extHint === '.html')
      && fs.existsSync(path.join(config.workspace.path, 'index.html'))) {
      fileName = path.join(config.workspace.path, 'index.html');
    } else {
      return null;
    }
  }
  if (!path.extname(fileName)) fileName = `${fileName}${extHint || '.txt'}`;
  const targetPath = path.isAbsolute(fileName) ? fileName : path.join(config.workspace.path, fileName);

  let content = extractRequestedContentValue(raw, 200);
  if (content) {
    if (/\.html?$/i.test(targetPath)) {
      let existing = '';
      try { existing = fs.readFileSync(targetPath, 'utf-8'); } catch {}
      content = rewriteHtmlPrimaryText(existing, content);
    }
    return {
      tool: 'write',
      params: { path: targetPath, content },
      reason: 'Deterministic file single-edit overwrite route',
    };
  }

  if (/\.html?$/i.test(targetPath)) {
    if (!styleIntent && !structuralIntent) return null;
    let existing = '';
    try { existing = fs.readFileSync(targetPath, 'utf-8'); } catch { existing = ''; }
    if (!existing) return null;
    const rewritten = styleIntent
      ? rewriteHtmlStyleByIntent(existing, styleIntent)
      : rewriteHtmlStructuralByIntent(existing, structuralIntent as HtmlStructuralMutationIntent);
    if (!rewritten) return null;
    if (hasSignificantVisibleTextLoss(existing, rewritten.content, 0.25)) return null;
    if (normalizeContentForVerify(rewritten.content) === normalizeContentForVerify(existing)) {
      return {
        tool: 'write',
        params: { path: targetPath, content: existing },
        reason: `Deterministic file single-edit no-op route (${rewritten.operation_type})`,
      };
    }
    return {
      tool: 'write',
      params: { path: targetPath, content: rewritten.content },
      reason: `Deterministic file single-edit style route (${rewritten.operation_type})`,
    };
  }

  return null;
}

function isLikelySingleNamedCreate(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!/\b(create|make|write)\b/.test(m) || !/\b(file|txt|text file)\b/.test(m)) return false;
  if (!/\b(name\s+it|name\s+is|named|called|filename(?:\s+is)?)\b/.test(m)) return false;
  if (/\b(after that|and then|another|second|both|two|2|all\s+txt\s+files?)\b/.test(m)) return false;
  return true;
}

function extractNamedTargetFromMessage(message: string): string | null {
  const raw = String(message || '').trim();
  const named =
    raw.match(/\b(?:name\s+it|name\s+is|named|called|filename(?:\s+is)?)\s+["'`]?([a-zA-Z0-9._\-]+(?:\.[a-zA-Z0-9]{1,6})?)["'`]?/i)?.[1]
    || '';
  let out = String(named || '').trim();
  if (!out) return null;
  if (!/\.[a-z0-9]{1,6}$/i.test(out)) out = `${out}.txt`;
  return out;
}

function enforceSingleNamedCreateConstraint(
  calls: DeterministicFileCall[],
  message: string
): DeterministicFileCall[] {
  if (!isLikelySingleNamedCreate(message)) return calls;
  const writes = calls.filter(c => c.tool === 'write');
  if (writes.length <= 1) return calls;
  const target = String(extractNamedTargetFromMessage(message) || '').toLowerCase();
  if (!target) return [writes[0]];
  const preferred = writes.find(w => {
    const p = String(w.params?.path || '');
    return path.basename(p).toLowerCase() === path.basename(target).toLowerCase();
  }) || writes[0];
  return [preferred];
}

function normalizeContentForVerify(v: string): string {
  return String(v || '').replace(/\r\n/g, '\n').trim();
}

function isWriteNoOpCall(call: DeterministicFileCall): boolean {
  if (call.tool !== 'write') return false;
  const pRaw = String(call.params?.path || '').trim();
  if (!pRaw) return false;
  const abs = path.isAbsolute(pRaw) ? pRaw : path.join(config.workspace.path, pRaw);
  if (!fs.existsSync(abs)) return false;
  let existing = '';
  try {
    existing = fs.readFileSync(abs, 'utf-8');
  } catch {
    return false;
  }
  const expected = String(call.params?.content ?? '');
  return normalizeContentForVerify(existing) === normalizeContentForVerify(expected);
}

function shouldBlockImplicitWrite(call: DeterministicFileCall, requestMessage: string): boolean {
  if (call.tool !== 'write') return false;
  if (isExplicitCreateIntent(requestMessage)) return false;
  const pRaw = String(call.params?.path || '').trim();
  if (!pRaw) return true;
  const abs = path.isAbsolute(pRaw) ? pRaw : path.join(config.workspace.path, pRaw);
  return !fs.existsSync(abs);
}

async function verifyAndRepairDeterministicFileOps(
  registry: ReturnType<typeof getToolRegistry>,
  calls: DeterministicFileCall[]
): Promise<{ repairs: string[]; errors: string[] }> {
  const repairs: string[] = [];
  const errors: string[] = [];
  const writeTargets = new Set<string>(
    calls
      .filter((c: DeterministicFileCall) => c.tool === 'write')
      .map((c: DeterministicFileCall) => String(c.params?.path || '').trim())
      .filter(Boolean)
      .map((pRaw: string) => {
        const abs = path.isAbsolute(pRaw) ? pRaw : path.join(config.workspace.path, pRaw);
        return path.resolve(abs);
      })
  );
  for (const c of calls) {
    if (c.tool === 'write') {
      const pRaw = String(c.params?.path || '').trim();
      if (!pRaw) {
        errors.push('Write verification skipped: missing path.');
        continue;
      }
      const abs = path.isAbsolute(pRaw) ? pRaw : path.join(config.workspace.path, pRaw);
      const expected = String(c.params?.content ?? '');
      let actual = '';
      try {
        actual = fs.readFileSync(abs, 'utf-8');
      } catch {
        actual = '';
      }
      if (normalizeContentForVerify(actual) !== normalizeContentForVerify(expected)) {
        const fix = await registry.execute('write', { path: abs, content: expected });
        if (!fix.success) {
          errors.push(`Write verify/repair failed for ${path.basename(abs)}: ${String(fix.error || 'unknown error')}`);
          continue;
        }
        repairs.push(`Repaired content in \`${path.basename(abs)}\`.`);
        let after = '';
        try {
          after = fs.readFileSync(abs, 'utf-8');
        } catch {
          after = '';
        }
        if (normalizeContentForVerify(after) !== normalizeContentForVerify(expected)) {
          errors.push(`Write verification failed after repair for ${path.basename(abs)}.`);
        } else {
          continue;
        }
      }
      continue;
    }
    if (c.tool === 'rename') {
      const srcRaw = String(c.params?.path || '').trim();
      const dstRaw = String(c.params?.new_path || '').trim();
      if (!srcRaw || !dstRaw) {
        errors.push('Rename verification skipped: missing path/new_path.');
        continue;
      }
      const src = path.isAbsolute(srcRaw) ? srcRaw : path.join(config.workspace.path, srcRaw);
      const dst = path.isAbsolute(dstRaw) ? dstRaw : path.join(config.workspace.path, dstRaw);
      const dstExists = fs.existsSync(dst);
      if (!dstExists && fs.existsSync(src)) {
        const fix = await registry.execute('rename', { path: src, new_path: dst });
        if (!fix.success) {
          errors.push(`Rename verify/repair failed for ${path.basename(src)} -> ${path.basename(dst)}: ${String(fix.error || 'unknown error')}`);
          continue;
        }
        repairs.push(`Retried rename \`${path.basename(src)}\` -> \`${path.basename(dst)}\`.`);
        if (!fs.existsSync(dst) || fs.existsSync(src)) {
          errors.push(`Rename verification failed after repair: expected destination present and source absent (\`${path.basename(src)}\` -> \`${path.basename(dst)}\`).`);
        } else {
          continue;
        }
      } else if (!dstExists) {
        errors.push(`Rename verification failed: destination missing \`${path.basename(dst)}\`.`);
      }
    }
    if (c.tool === 'delete') {
      const pRaw = String(c.params?.path || '').trim();
      if (!pRaw) {
        errors.push('Delete verification skipped: missing path.');
        continue;
      }
      const abs = path.isAbsolute(pRaw) ? pRaw : path.join(config.workspace.path, pRaw);
      // In mixed batches (delete old + recreate same path), net expected outcome is controlled by write.
      if (writeTargets.has(path.resolve(abs))) {
        continue;
      }
      if (fs.existsSync(abs)) {
        const fix = await registry.execute('delete', { path: abs });
        if (!fix.success) {
          errors.push(`Delete verify/repair failed for ${path.basename(abs)}: ${String(fix.error || 'unknown error')}`);
          continue;
        }
        repairs.push(`Retried delete for \`${path.basename(abs)}\`.`);
        if (fs.existsSync(abs)) {
          errors.push(`Delete verification failed after repair for \`${path.basename(abs)}\`.`);
        } else {
          appendFileLifecycleNote('deleted_repair', abs);
          continue;
        }
      }
      continue;
    }
  }
  return { repairs, errors };
}

function inferDeterministicFileBatchCalls(
  message: string,
  state: AgentSessionState
): DeterministicFileCall[] {
  const raw = normalizeCommonFileTypos(String(message || '').trim());
  const m = raw.toLowerCase();
  const calls: DeterministicFileCall[] = [];
  let matchedMultiEditFollowup = false;
  let matchedCreateClause = false;
  if (!isFileOperationRequest(m) && !isFileFollowupOperationRequest(m, state)) return calls;

  // Pattern 1: parse create clauses independently (handles multiple create actions)
  {
    const clauses = splitInstructionClauses(raw);
    for (const clause of clauses) {
      const lc = clause.toLowerCase();
      const hasCreateVerb = /\b(create|write)\b/.test(lc);
      const hasMakeCreatePhrase = /\bmake\s+(?:a|an|another|new|brand new|whole new)\b/.test(lc);
      const hasCreateCue = /\b(new|brand new|another|second|name it|named|called|filename|name is)\b/.test(lc);
      const hasEditVerb = /\b(edit|update|change|modify|set|replace|overwrite|fix|correct)\b/.test(lc);
      if (!(hasCreateVerb || hasMakeCreatePhrase)) continue;
      if (!/\b(file|txt|text file|html|md|json|css|js|ts|py)\b/.test(lc)) continue;
      if (hasEditVerb && !hasCreateCue && !hasCreateVerb && !hasMakeCreatePhrase) continue;

      const inferredExt = inferRequestedFileExtension(clause);
      const namedMatch = clause.match(/\b(?:named|called|name\s+it|name\s+is|filename(?:\s+is)?)\s+["'`]?([a-zA-Z0-9._\-]+(?:\.[a-zA-Z0-9]{1,6})?)["'`]?(?=[\s,.;!?]|$)/i);
      // Avoid picking filenames from earlier delete segments in mixed clauses.
      const explicitNearCreate = clause.match(/\b(?:create|write|make)\b[\s\S]{0,140}?\b([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})\b/i);
      let fileName = String(namedMatch?.[1] || explicitNearCreate?.[1] || '').trim();
      if (!fileName) fileName = buildDefaultFileName(inferredExt, clause);
      if (!fileName) continue;
      if (!/\.[a-z0-9]{1,6}$/i.test(fileName)) fileName = `${fileName}${inferredExt}`;

      let content = extractCreateRequestedContentValue(clause, 260) || 'hello world';
      if (/\s+in\s+the\s+.+file$/i.test(content)) content = content.replace(/\s+in\s+the\s+.+file$/i, '').trim();
      content = content
        .replace(/[.,]?\s+and\s+name\s+it\s+["'`]?.*$/i, '')
        .replace(/[.,]?\s+(?:named|called)\s+["'`]?.*$/i, '')
        .trim();
      if (/\.html?$/i.test(fileName) || inferredExt === '.html') {
        const black = /\bbackground\b[\s\S]*\bblack\b|\bblack\b[\s\S]*\bbackground\b/i.test(clause);
        const white = /\btext\b[\s\S]*\bwhite\b|\bwhite\b[\s\S]*\btext\b/i.test(clause);
        const panel = /\b(panel|card|box)\b/i.test(clause);
        const displayText = extractHtmlDisplayText(clause, content || 'Hello world - i am localclaw');
        content = buildBasicHtmlDocument(displayText, {
          blackBackground: black,
          whiteText: white,
          panel: panel || true,
        });
      }
      if (!/\.html?$/i.test(fileName) && content.length > 140) content = content.slice(0, 140).trim();
      matchedCreateClause = true;

      calls.push({
        tool: 'write',
        params: { path: fileName, content },
        reason: 'Deterministic file-batch create route',
      });
    }
  }

  // Pattern 1b: follow-up edit for multiple recent files ("edit both of them to say ...")
  {
    const editBoth = raw.match(/\b(?:edit|update|change)\b[\s\S]*?\b(?:both|botb|both of them|them|those files|all(?:\s+txt\s+files?)?|two|2)\b[\s\S]*?\b(?:to say|say|to contain|contain)\s+["'`]?(.+?)["'`]?(?=\s*(?:\band then\b|,\s*and\b|,\s*also\b|$))/i);
    if (editBoth?.[1]) {
      matchedMultiEditFollowup = true;
      const content = String(editBoth[1] || '').trim() || 'hello world';
      const recent = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : []).filter(Boolean);
      const useTxtGroup = /\btxt\s+files?\b/i.test(raw);
      const workspaceTxt = getWorkspaceTxtCandidates(6);
      const last = String(state.lastFilePath || '').trim();
      const txtTargets = [
        ...recent.filter((p: string) => /\.txt$/i.test(String(p))),
        ...workspaceTxt,
        ...(last && /\.txt$/i.test(last) ? [last] : []),
      ].filter(Boolean).map((p: string) => path.resolve(String(p)));
      const uniqueTxtTargets = Array.from(new Set(txtTargets));
      const wantsAllTxt = /\ball\s+txt\s+files?\b/i.test(raw);
      const targets = useTxtGroup
        ? uniqueTxtTargets.slice(0, wantsAllTxt ? 6 : 2)
        : (recent.length >= 2 ? recent.slice(0, 2) : (state.lastFilePath ? [state.lastFilePath] : []));
      for (const targetPath of targets) {
        calls.push({
          tool: 'write',
          params: { path: String(targetPath), content },
          reason: 'Deterministic file-batch multi-edit route',
        });
      }
    }
  }

  // Pattern 1c: html panel/background style update on recent html target.
  {
    const clauses = splitInstructionClauses(raw);
    for (const clause of clauses) {
      const lc = clause.toLowerCase();
      const styleIntent = detectHtmlStyleMutationIntent(clause, state);
      if (!styleIntent) continue;
      const resolved = resolveHtmlTargetForMutation(clause, state);
      if (resolved.status !== 'resolved') continue;
      const targetPath = resolved.targetPath;
      let existing = '';
      try { existing = fs.readFileSync(targetPath, 'utf-8'); } catch { existing = ''; }
      if (!existing) continue;
      const rewritten = rewriteHtmlStyleByIntent(existing, styleIntent);
      if (!rewritten) continue;
      if (normalizeContentForVerify(rewritten.content) === normalizeContentForVerify(existing)) continue;
      calls.push({
        tool: 'write',
        params: { path: targetPath, content: rewritten.content },
        reason: `Deterministic file-batch html-style-update route (${rewritten.operation_type})`,
      });
    }
  }

  // Pattern 2: explicit "change <file> to say <content>" clause (overwrite file content)
  {
    const changeSay = raw.match(/\bchange\s+(?:the\s+)?([a-zA-Z0-9._\-]+(?:\.[a-zA-Z0-9]{1,6})?)\s+to\s+say\s+["'`]?(.+?)["'`]?(?=\s*(?:,\s*also\b|\band then\b|$))/i);
    if (changeSay?.[1]) {
      let p = String(changeSay[1]).trim();
      if (!/\.[a-z0-9]{1,6}$/i.test(p)) p = `${p}.txt`;
      const c = String(changeSay[2] || '').trim() || 'hello world';
      calls.push({
        tool: 'write',
        params: { path: p, content: c },
        reason: 'Deterministic file-batch content-update route',
      });
    }
  }

  // Pattern 2b: "change the contents of the <file> file to say <content>"
  {
    const changeContents = raw.match(/\bchange\s+(?:the\s+)?(?:contents?|content)\s+of\s+(?:the\s+)?([a-zA-Z0-9._\-]+(?:\.[a-zA-Z0-9]{1,6})?)\s*(?:txt\s+file|file)?\s+to\s+say\s+["'`]?(.+?)["'`]?(?=\s*(?:,\s*also\b|,\s*and\b|\band then\b|$))/i);
    if (changeContents?.[1]) {
      let p = String(changeContents[1]).trim();
      if (!/\.[a-z0-9]{1,6}$/i.test(p)) p = `${p}.txt`;
      const c = String(changeContents[2] || '').trim() || 'hello world';
      calls.push({
        tool: 'write',
        params: { path: p, content: c },
        reason: 'Deterministic file-batch content-update route',
      });
    }
  }

  // Pattern 2bb: explicit edit/update of a specific file to new content.
  {
    const clauses = splitInstructionClauses(raw);
    for (const clause of clauses) {
      const lc = clause.toLowerCase();
      const hasContentRewriteCue = /\b(?:to|t)\s+say\b|\bonly\s+(?:say|says)\b|\bshould(?:\s+just)?\s+be\b|\bit\s+should(?:\s+just)?\s+be\b/.test(lc);
      const hasEditVerb = /\b(edit|update|change|modify|set|overwrite|replace)\b/.test(lc)
        || (/\bremove\b/.test(lc) && hasContentRewriteCue);
      if (!hasEditVerb) continue;
      const hasFileCue = /\b(file|txt|text file|html?|md|json|css|js|ts|py)\b/.test(lc);
      const hasRefCue = /\b(it|that file|this file|same file|the html file|the txt file|inside)\b/.test(lc);
      if (!hasFileCue && !hasRefCue) continue;
      if (/\b(?:both|botb|both of them|them|those files|all\s+txt\s+files?)\b/.test(lc)) continue;

      const explicitAny = clause.match(/\b([a-zA-Z0-9._\-]+\.(?:txt|md|json|ts|js|py|html|css))\b/i)?.[1];
      const phraseMatch = clause.match(/\b(?:the\s+)?([a-zA-Z0-9._\-]+)\s+(txt|html?|md|json|css|js|ts|py)\s+file\b/i);
      let fileName = String(explicitAny || '').trim();
      if (!fileName && phraseMatch?.[1] && phraseMatch?.[2]) {
        const baseRaw = String(phraseMatch[1] || '').trim();
        if (!/^(the|a|an|my|new|original|current|existing|only|old|html|htm|txt|text|file)$/i.test(baseRaw)) {
          const extRaw = String(phraseMatch[2] || '').toLowerCase();
          const ext = (extRaw === 'htm' || extRaw === 'html') ? 'html' : extRaw;
          fileName = `${baseRaw}.${ext}`;
        }
      }
      if (!fileName) {
        const recentList = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [])
          .map((p: any) => String(p || '').trim())
          .filter(Boolean);
        const last = String(state.lastFilePath || '').trim();
        const recentHtml = recentList.find((p: string) => /\.html?$/i.test(String(p || '')));
        if (/html|panel|background|inside|text/i.test(lc) && recentHtml) {
          fileName = recentHtml;
        } else if (/html|panel|background|inside|text/i.test(lc) && last && /\.html?$/i.test(last)) {
          fileName = last;
        } else if (hasRefCue && last) {
          fileName = last;
        } else if (hasRefCue && recentList.length === 1) {
          fileName = recentList[0];
        }
      }
      if (!fileName) continue;
      const targetPath = path.isAbsolute(fileName) ? fileName : path.join(config.workspace.path, fileName);

      let content = extractRequestedContentValue(clause, 220);
      if (!content) continue;
      content = content.replace(/^that\s+/i, '').trim();
      if (!content) continue;

      if (/\.html?$/i.test(targetPath)) {
        let existing = '';
        try { existing = fs.readFileSync(targetPath, 'utf-8'); } catch { existing = ''; }
        content = existing ? rewriteHtmlPrimaryText(existing, content) : content;
      }

      calls.push({
        tool: 'write',
        params: { path: targetPath, content },
        reason: 'Deterministic file-batch single-edit route',
      });
    }
  }

  // Pattern 2c: explicit delete/remove path(s)
  {
    const deleteClauses = splitInstructionClauses(raw);
    for (const clause of deleteClauses) {
      const lc = clause.toLowerCase();
      if (!/\b(?:remove|delete)(?:\/delete)?\b/.test(lc)) continue;
      const explicitMatches = Array.from(
        clause.matchAll(/\b([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})\b/ig)
      )
        .map((mm: any) => String(mm?.[1] || '').trim())
        .filter(Boolean);
      const explicitUnique = Array.from(new Set(explicitMatches));
      const hasExplicitNamedTxt = explicitUnique.some((p: string) => /\.txt$/i.test(p));
      const hasExplicitNamedHtml = explicitUnique.some((p: string) => /\.html?$/i.test(p));
      const asksPluralDelete = /\b(all|both|files|them|those)\b/i.test(clause);
      const deleteIdx = (() => {
        const mm = /\b(?:remove|delete)(?:\/delete)?\b/i.exec(clause);
        return mm && Number.isFinite((mm as any).index) ? Number((mm as any).index) : -1;
      })();
      const htmlIdx = (() => {
        const mm = /\b(?:html|\.html?)\b/i.exec(clause);
        return mm && Number.isFinite((mm as any).index) ? Number((mm as any).index) : -1;
      })();
      const txtIdx = (() => {
        const mm = /\b(?:txt|text)\b/i.exec(clause);
        return mm && Number.isFinite((mm as any).index) ? Number((mm as any).index) : -1;
      })();
      const hasCreateBetween = (from: number, to: number): boolean => {
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) return false;
        return /\b(create|make|write)\b/i.test(clause.slice(from, to));
      };
      const htmlFileCue = htmlIdx >= 0 && /\bfiles?\b/i.test(clause.slice(htmlIdx, htmlIdx + 32));
      const txtFileCue = txtIdx >= 0 && /\bfiles?\b/i.test(clause.slice(txtIdx, txtIdx + 32));
      const wantsHtmlGroupDelete =
        !hasExplicitNamedHtml
        && asksPluralDelete
        && deleteIdx >= 0
        && htmlIdx > deleteIdx
        && htmlFileCue
        && !hasCreateBetween(deleteIdx, htmlIdx);
      const wantsHelloWorldTxtDelete = /\b(?:remove|delete)(?:\/delete)?\b[\s\S]{0,140}\bhello[\s_\-]*world\b[\s\S]{0,60}\btxt\b/i.test(clause);
      const wantsTxtGroupDelete =
        asksPluralDelete
        && !hasExplicitNamedTxt
        && deleteIdx >= 0
        && txtIdx > deleteIdx
        && txtFileCue
        && !hasCreateBetween(deleteIdx, txtIdx)
        && !wantsHelloWorldTxtDelete;
      const prefixDeleteHint = FEATURE_FLAGS.deterministic_prefix_delete && !explicitUnique.length
        ? extractPrefixDeleteHint(clause)
        : '';
      const wantsPrefixGroupDelete = !!prefixDeleteHint && /\b(remove|delete)\b/i.test(clause);

      if (wantsHtmlGroupDelete) {
        const recentHtmlSet = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [])
          .map((pp: any) => String(pp || '').trim())
          .filter((pp: string) => /\.html?$/i.test(pp));
        const workspaceHtml = getWorkspaceHtmlCandidates(20);
        const merged = Array.from(new Set([
          ...recentHtmlSet.map((pp: string) => path.resolve(pp)),
          ...workspaceHtml.map((pp: string) => path.resolve(pp)),
        ]));
        const targets = asksPluralDelete ? merged.slice(0, 12) : merged.slice(0, 1);
        for (const target of targets) {
          calls.push({
            tool: 'delete',
            params: { path: target },
            reason: 'Deterministic file-batch delete route (html group)',
          });
        }
      }

      if (wantsTxtGroupDelete) {
        const recentTxtSet = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [])
          .map((pp: any) => String(pp || '').trim())
          .filter((pp: string) => /\.txt$/i.test(pp));
        const workspaceTxt = getWorkspaceTxtCandidates(20);
        const merged = Array.from(new Set([
          ...recentTxtSet.map((pp: string) => path.resolve(pp)),
          ...workspaceTxt.map((pp: string) => path.resolve(pp)),
        ]));
        const targets = asksPluralDelete ? merged.slice(0, 12) : merged.slice(0, 1);
        for (const target of targets) {
          calls.push({
            tool: 'delete',
            params: { path: target },
            reason: 'Deterministic file-batch delete route (txt group)',
          });
        }
      }

      if (wantsPrefixGroupDelete) {
        let matches = getWorkspaceAllFileCandidates(200)
          .filter((pp: string) => String(path.basename(pp) || '').toLowerCase().startsWith(prefixDeleteHint));
        if (/\bhtml?\b/.test(lc)) {
          matches = matches.filter((pp: string) => /\.html?$/i.test(pp));
        }
        if (/\b(txt|text)\b/.test(lc)) {
          matches = matches.filter((pp: string) => /\.txt$/i.test(pp));
        }
        const limit = asksPluralDelete ? 24 : 1;
        for (const target of matches.slice(0, limit)) {
          calls.push({
            tool: 'delete',
            params: { path: target },
            reason: `Deterministic file-batch delete route (prefix-group: ${prefixDeleteHint}*)`,
          });
        }
      }

      if (wantsHelloWorldTxtDelete) {
        const recentTxtSet = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [])
          .map((pp: any) => String(pp || '').trim())
          .filter((pp: string) => /\.txt$/i.test(pp));
        const txtByName = getWorkspaceTxtCandidates(20).filter((pp: string) => /hello[\s_\-]*world|helloworld/i.test(path.basename(pp)));
        const txtByContent = getWorkspaceTxtByContent(/\bhello[\s_\-]*world\b/i, 10);
        const merged = Array.from(new Set([
          ...txtByName,
          ...txtByContent,
          ...recentTxtSet.filter((pp: string) => /hello[\s_\-]*world|helloworld/i.test(path.basename(pp))),
        ])).slice(0, 6);
        for (const target of merged) {
          calls.push({
            tool: 'delete',
            params: { path: target },
            reason: 'Deterministic file-batch delete route (hello-world txt)',
          });
        }
      }

      const looksLikeContentCleanup = /\bremove\b[\s\S]*\b(?:extra|additional|old)\s+text\b/i.test(clause)
        || /\bonly\s+(?:say|says)\b/i.test(clause)
        || /\bit\s+should(?:\s+just)?\s+be\b/i.test(clause)
        || /\b(?:to|t)\s+say\b/i.test(clause);
      if (!explicitUnique.length && looksLikeContentCleanup) continue;
      if (explicitUnique.length > 0) {
        for (const p0 of explicitUnique) {
          const p = String(p0 || '').trim();
          if (!p) continue;
          calls.push({
            tool: 'delete',
            params: { path: p },
            reason: 'Deterministic file-batch delete route (explicit)',
          });
        }
        continue;
      }

      const fallback = clause.match(/\b(?:remove|delete)(?:\/delete)?\b\s+(?:the\s+)?(?:original\s+|new\s+|current\s+|existing\s+)?(?:file\s+)?["'`]?([a-zA-Z0-9._\-]+)["'`]?(?:\s+file)?/i)?.[1];
      let p = String(fallback || '').trim();
      if (p) {
        const token = p.toLowerCase();
        if (['both', 'all', 'html', 'htm', 'txt', 'file', 'files', 'it', 'that', 'this', 'one', 'same'].includes(token)) p = '';
      }
      if (!p) {
        const recent = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [])
          .map((x: any) => String(x || '').trim())
          .filter(Boolean);
        const recentTxt = recent.find((x: string) => /\.txt$/i.test(x));
        const recentHtml = recent.find((x: string) => /\.html?$/i.test(x));
        if (/\b(txt|text)\s+file\b/.test(lc) && recentTxt) {
          p = recentTxt;
        } else if (/\bhtml?\s+file\b/.test(lc) && recentHtml) {
          p = recentHtml;
        } else if (/\b(txt|text)\s+file\b/.test(lc)) {
          const workspaceTxt = getWorkspaceTxtCandidates(2);
          if (workspaceTxt.length === 1) p = workspaceTxt[0];
        } else if (/\bhtml?\s+file\b/.test(lc)) {
          const workspaceHtml = getWorkspaceHtmlCandidates(2);
          if (workspaceHtml.length === 1) p = workspaceHtml[0];
        } else if (/\b(same file|that file|it)\b/.test(lc) && state.lastFilePath) {
          p = String(state.lastFilePath);
        }
      }
      if (!p) continue;
      if (!/\.[a-z0-9]{1,6}$/i.test(p)) p = `${p}.txt`;
      calls.push({
        tool: 'delete',
        params: { path: p },
        reason: 'Deterministic file-batch delete route',
      });
    }
  }

  // Pattern 2d: rename via "to be named ..." phrasing.
  {
    const clauses = splitInstructionClauses(raw);
    for (const clause of clauses) {
      const lc = clause.toLowerCase();
      const renameVerb = /\b(?:rename|move|change\s+the\s+name|change\s+name|update)\b/;
      if (!renameVerb.test(lc)) continue;
      if (/\b(create|write)\b/.test(lc)) continue;
      const startIdx = lc.search(renameVerb);
      const renameSegment = startIdx >= 0 ? clause.slice(startIdx) : clause;
      const renameNamed = renameSegment.match(/\b(?:to be named|named|as|to)\s+["'`]?([a-zA-Z0-9._\-]+(?:\.[a-zA-Z0-9]{1,6})?)["'`]?/i);
      if (!renameNamed?.[1]) continue;
      let target = String(renameNamed[1] || '').trim();
      if (!/\.[a-z0-9]{1,6}$/i.test(target)) target = `${target}.txt`;
      const targetLower = path.basename(target).toLowerCase();

      const explicitFrom =
        renameSegment.match(/\bfrom\s+["'`]?([a-zA-Z0-9._\-]+(?:\.[a-zA-Z0-9]{1,6})?)["'`]?/i)?.[1]
        || renameSegment.match(/\b(?:the\s+)?([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})\s+file\b[\s\S]*?\b(?:to be named|named|as)\b/i)?.[1]
        || '';

      const mentionsHtml = /\bhtml?\b/i.test(renameSegment) || /\.html?\b/i.test(target);
      const ext = path.extname(target).toLowerCase();
      const recent = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [])
        .map((p: any) => String(p || '').trim())
        .filter(Boolean);
      const recentByExt = recent.filter((p: string) => {
        if (ext) return path.extname(p).toLowerCase() === ext;
        if (mentionsHtml) return /\.html?$/i.test(p);
        return true;
      });
      let source = String(explicitFrom || '').trim();
      if (!source) {
        source = recentByExt.find((p: string) => path.basename(p).toLowerCase() !== targetLower)
          || String(state.lastFilePath || '')
          || '';
      }
      if (!source) continue;
      if (!path.isAbsolute(source)) source = path.join(config.workspace.path, source);
      const newPath = path.isAbsolute(target) ? target : path.join(path.dirname(source), target);
      if (path.resolve(source) !== path.resolve(newPath)) {
        calls.push({
          tool: 'rename',
          params: { path: source, new_path: newPath },
          reason: 'Deterministic file-batch rename route',
        });
      }
    }
  }

  // Pattern 3: cleanup rename phrase: "clean the name to say testing instead of testng"
  {
    const cleanRename = raw.match(/\bclean\s+the\s+name\b[\s\S]*?\bsay\s+([a-zA-Z0-9._\-]+)\s+instead\s+of\s+([a-zA-Z0-9._\-]+)/i);
    if (cleanRename?.[1] && cleanRename?.[2]) {
      const newer = String(cleanRename[1]).trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const older = String(cleanRename[2]).trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const existingWrite = calls.find(c => c.tool === 'write' && /testng/i.test(String(c.params?.path || '')));
      const srcBase = existingWrite
        ? String(existingWrite.params.path)
        : (String(state.lastFilePath || '') || `${older}_file.txt`);
      const src = /\.[a-z0-9]{1,6}$/i.test(srcBase) ? srcBase : `${srcBase}.txt`;
      const dst = src.replace(new RegExp(older, 'ig'), newer);
      if (src !== dst) {
        calls.push({
          tool: 'rename',
          params: {
            path: path.isAbsolute(src) ? src : path.join(config.workspace.path, src),
            new_path: path.isAbsolute(dst) ? dst : path.join(config.workspace.path, dst),
          },
          reason: 'Deterministic file-batch rename-cleanup route',
        });
      }
    }
  }

  if (calls.length > 1) {
    const deduped: DeterministicFileCall[] = [];
    const seenIndex = new Map<string, number>();
    for (const c of calls) {
      const p = String(c.params?.path || '').trim();
      const np = String(c.params?.new_path || '').trim();
      const key = c.tool === 'rename'
        ? `rename:${path.resolve(p || '_')}=>${path.resolve(np || '_')}`
        : `${c.tool}:${path.resolve(p || '_')}`;
      const existingIdx = seenIndex.get(key);
      if (typeof existingIdx === 'number') {
        deduped[existingIdx] = c;
      } else {
        seenIndex.set(key, deduped.length);
        deduped.push(c);
      }
    }
    return deduped;
  }

  const wantsRename = /\b(rename|change\s+the\s+name|change\s+name|move)\b/.test(m);
  const wantsCreate = (/\b(create|write)\b/.test(m) || /\bmake\s+(?:a|an|another|new|brand new|whole new)\b/.test(m))
    && /\b(file|txt|text file|html|md|json|css|js|ts|py)\b/.test(m);

  if (wantsRename) {
    const fromMatch = raw.match(/\bfrom\s+["'`]?([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})["'`]?/i);
    const toMatches = Array.from(raw.matchAll(/\bto\s+["'`]?([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})["'`]?/ig));
    const toMatch = toMatches.length ? toMatches[toMatches.length - 1] : raw.match(/\bto\s+["'`]?([a-zA-Z0-9._\-]+)["'`]?/i);
    let source = String(fromMatch?.[1] || state.lastFilePath || '').trim();
    let target = String(toMatch?.[1] || '').trim();
    if (source && target) {
      if (!/\.[a-z0-9]{1,6}$/i.test(target)) {
        const ext = path.extname(source) || '.txt';
        target = `${target}${ext}`;
      }
      const sourcePath = path.isAbsolute(source) ? source : path.join(config.workspace.path, source);
      const targetPath = path.isAbsolute(target) ? target : path.join(path.dirname(sourcePath), target);
      if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
        calls.push({
          tool: 'rename',
          params: { path: sourcePath, new_path: targetPath },
          reason: 'Deterministic file-batch rename route',
        });
      }
    }
  }

  if (wantsCreate && !matchedCreateClause) {
    const inferredExt = inferRequestedFileExtension(raw);
    const named = raw.match(/\b(?:named|called|name\s+it|name\s+is|filename(?:\s+is)?)\s+["'`]?([a-zA-Z0-9._\-]+(?:\.[a-zA-Z0-9]{1,6})?)["'`]?/i)?.[1];
    const explicitNearCreate =
      raw.match(/\b(?:create|write|make)\b[\s\S]{0,160}?\b([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})\b/i)?.[1]
      || '';
    let fileName = String(named || explicitNearCreate || buildDefaultFileName(inferredExt, raw)).trim().replace(/\s+/g, '_');
    if (!/\.[a-z0-9]{1,6}$/i.test(fileName)) fileName = `${fileName}${inferredExt}`;

    let content = extractCreateRequestedContentValue(raw, 260);
    if (!content) content = 'hello world';
    if (/\s+in\s+the\s+.+file$/i.test(content)) content = content.replace(/\s+in\s+the\s+.+file$/i, '').trim();
    content = content
      .replace(/[.,]?\s+and\s+name\s+it\s+["'`]?.*$/i, '')
      .replace(/[.,]?\s+(?:named|called)\s+["'`]?.*$/i, '')
      .trim();
    if (/\.html?$/i.test(fileName) || inferredExt === '.html') {
      const black = /\bbackground\b[\s\S]*\bblack\b|\bblack\b[\s\S]*\bbackground\b/i.test(raw);
      const white = /\btext\b[\s\S]*\bwhite\b|\bwhite\b[\s\S]*\btext\b/i.test(raw);
      const panel = /\b(panel|card|box)\b/i.test(raw);
      const displayText = extractHtmlDisplayText(raw, content || 'Hello world - i am localclaw');
      content = buildBasicHtmlDocument(displayText, {
        blackBackground: black,
        whiteText: white,
        panel: panel || true,
      });
    }
    if (content.length > 120) content = content.slice(0, 120).trim();

    calls.push({
      tool: 'write',
      params: { path: fileName, content },
      reason: 'Deterministic file-batch create route',
    });
  }

  if (calls.length > 1) {
    const deduped: DeterministicFileCall[] = [];
    const seenIndex = new Map<string, number>();
    for (const c of calls) {
      const p = String(c.params?.path || '').trim();
      const np = String(c.params?.new_path || '').trim();
      const key = c.tool === 'rename'
        ? `rename:${path.resolve(p || '_')}=>${path.resolve(np || '_')}`
        : `${c.tool}:${path.resolve(p || '_')}`;
      const existingIdx = seenIndex.get(key);
      if (typeof existingIdx === 'number') {
        deduped[existingIdx] = c;
      } else {
        seenIndex.set(key, deduped.length);
        deduped.push(c);
      }
    }
    calls.splice(0, calls.length, ...deduped);
  }

  // Allow one-call passthrough for explicit multi-edit followups in stale sessions.
  if (matchedMultiEditFollowup && calls.length >= 1) return calls;
  if (calls.length === 1) {
    // Single delete has no specialized deterministic handler; keep it here.
    if (calls[0].tool === 'delete') return calls;
    // Otherwise, let specialized single-call handlers process it.
    return [];
  }
  if (calls.length <= 0) return [];
  return calls;
}

function inferDeterministicFileFollowupCall(
  message: string,
  state: AgentSessionState
): { tool: 'rename'; params: { path: string; new_path: string }; reason: string } | null {
  const raw = String(message || '').trim();
  const m = raw.toLowerCase();
  if (!m) return null;
  const refersSame = /\b(same file|that file|that same file|same one|it)\b/.test(m);
  const wantsRename = /\b(rename|move|change\s+the\s+name|change\s+name)\b/.test(m);
  if (!wantsRename) return null;
  const fromMatch =
    raw.match(/\bfrom\s+["'`]?([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})["'`]?/i)
    || raw.match(/\brename\s+["'`]?([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6})["'`]?\s+to\b/i);
  const toMatch =
    raw.match(/\bto\s+["'`]?([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6}|[a-zA-Z0-9._\-]+)["'`]?/i)
    || raw.match(/\bas\s+["'`]?([a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6}|[a-zA-Z0-9._\-]+)["'`]?/i);
  let source = String(fromMatch?.[1] || state.lastFilePath || '').trim();
  if (!source) return null;
  if (!refersSame && !fromMatch?.[1] && !/\bfile\b/.test(m)) return null;

  let target = String(toMatch?.[1] || '').trim().replace(/\s+/g, '_');
  if (!target) return null;
  if (!/\.[a-z0-9]{1,6}$/i.test(target)) {
    const ext = path.extname(source) || '.txt';
    target = `${target}${ext}`;
  }
  const sourcePath = path.isAbsolute(source) ? source : path.join(config.workspace.path, source);
  const newPath = path.join(path.dirname(sourcePath), target);
  if (path.resolve(newPath) === path.resolve(sourcePath)) return null;
  return {
    tool: 'rename',
    params: { path: sourcePath, new_path: newPath },
    reason: 'Deterministic file-followup rename route',
  };
}

function inferDeterministicDeleteFollowupCalls(
  message: string,
  state: AgentSessionState
): DeterministicFileCall[] {
  const raw = String(message || '').trim();
  const m = raw.toLowerCase();
  if (!m || !/\b(remove|delete)\b/.test(m)) return [];

  const out: DeterministicFileCall[] = [];
  const recent = (Array.isArray(state.recentFilePaths) ? state.recentFilePaths : [])
    .map((p: any) => String(p || '').trim())
    .filter(Boolean);
  const recentTxt = recent.filter((p: string) => /\.txt$/i.test(p));
  const recentHtml = recent.filter((p: string) => /\.html?$/i.test(p));
  const explicitNames = (raw.match(/\b[a-zA-Z0-9._\-]+\.[a-zA-Z0-9]{1,6}\b/ig) || [])
    .map((p: string) => String(p || '').trim())
    .filter(Boolean);
  const addDelete = (p: string, reason: string) => {
    out.push({
      tool: 'delete',
      params: { path: p },
      reason,
    });
  };

  if (explicitNames.length) {
    for (const p of explicitNames) {
      addDelete(p, 'Deterministic file-followup delete route (explicit)');
    }
  }

  const wantsTxt = /\b(txt|text)\b/.test(m);
  const wantsHtml = /\bhtml?\b/.test(m);
  const asksPlural = /\b(all|both|files|them|those)\b/.test(m);

  if (wantsTxt) {
    const workspaceTxt = getWorkspaceTxtCandidates(20);
    const txtTargets = Array.from(new Set([
      ...recentTxt.map((p: string) => path.resolve(p)),
      ...workspaceTxt.map((p: string) => path.resolve(p)),
    ]));
    const take = asksPlural ? txtTargets.slice(0, 12) : txtTargets.slice(0, 1);
    for (const p of take) addDelete(p, asksPlural
      ? 'Deterministic file-followup delete route (txt group)'
      : 'Deterministic file-followup delete route (txt recent)');
  }

  if (wantsHtml) {
    const workspaceHtml = getWorkspaceHtmlCandidates(20);
    const htmlTargets = Array.from(new Set([
      ...recentHtml.map((p: string) => path.resolve(p)),
      ...workspaceHtml.map((p: string) => path.resolve(p)),
    ]));
    const take = asksPlural ? htmlTargets.slice(0, 12) : htmlTargets.slice(0, 1);
    for (const p of take) addDelete(p, asksPlural
      ? 'Deterministic file-followup delete route (html group)'
      : 'Deterministic file-followup delete route (html recent)');
  }

  if (!explicitNames.length && !wantsTxt && !wantsHtml && /\b(it|that file|same file)\b/.test(m) && state.lastFilePath) {
    addDelete(String(state.lastFilePath), 'Deterministic file-followup delete route (pronoun)');
  }

  const deduped: DeterministicFileCall[] = [];
  const seen = new Set<string>();
  for (const c of out) {
    const p = String(c.params?.path || '').trim();
    if (!p) continue;
    const k = `delete:${path.resolve(p)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(c);
  }
  return deduped;
}

function suggestToolForTaskText(text: string): string {
  const t = String(text || '').toLowerCase();
  if (/\b(rename|move|change the name|change name)\b/.test(t)) return 'rename';
  if (/\b(create|make|write)\b/.test(t) && /\b(file|txt|md|json|ts|js|py|html|css)\b/.test(t)) return 'write';
  if (/\b(edit|replace|modify|update)\b/.test(t) && /\b(file|txt|md|json|ts|js|py|html|css)\b/.test(t)) return 'edit';
  if (/\b(read|open|show|view)\b/.test(t) && /\b(file|txt|md|json|ts|js|py|html|css)\b/.test(t)) return 'read';
  if (/\b(list|ls|show files)\b/.test(t)) return 'list';
  if (/\b(delete|remove)\b/.test(t)) return 'delete';
  if (/\b(copy|duplicate)\b/.test(t)) return 'copy';
  if (/\bsearch|web|look up|verify\b/.test(t)) return 'web_search';
  if (/\btime|date|day\b/.test(t)) return 'time_now';
  return 'tool';
}

function classifyRouterClass(message: string): 'freshness' | 'provenance' | 'general' {
  if (isSourceFollowUp(message)) return 'provenance';
  if (needsFreshLookup(message)) return 'freshness';
  return 'general';
}

function routerConfidenceThreshold(message: string): number {
  const cls = classifyRouterClass(message);
  if (cls === 'provenance') return 0.35;
  if (cls === 'freshness') return 0.4;
  return 0.55;
}

type ModelTriggerMode = 'execute' | 'web';
type ModelTriggerMatch = {
  mode: ModelTriggerMode;
  token: string;
  source: 'response' | 'thinking';
};

function normalizeTriggerScanText(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[`"'.,!?;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectModelModeTriggerFromText(input: string): { mode: ModelTriggerMode; token: string; index: number } | null {
  const t = normalizeTriggerScanText(input);
  if (!t) return null;
  // Ignore prompt-echo instruction text; only actual trigger intent should match.
  if (/\bif backend execution is needed\b/.test(t)) return null;
  if (/\binclude token\s+open[_\s-]?tool\b/.test(t)) return null;
  if (/\binclude token\s+open[_\s-]?web\b/.test(t)) return null;

  const checks: Array<{ mode: ModelTriggerMode; token: string; re: RegExp }> = [
    { mode: 'web', token: 'open_web', re: /\b(open[_\s-]?web|use[_\s-]?web(search)?|switch[_\s-]?web|open<web>)\b/ },
    { mode: 'execute', token: 'open_tool', re: /\b(open[_\s-]?tool|use[_\s-]?tool|run[_\s-]?tool|switch[_\s-]?execute|open<tool>)\b/ },
  ];
  let best: { mode: ModelTriggerMode; token: string; index: number } | null = null;
  for (const c of checks) {
    const m = t.match(c.re);
    if (!m || m.index === undefined) continue;
    if (!best || m.index < best.index) {
      best = { mode: c.mode, token: c.token, index: m.index };
    }
  }
  return best;
}

function detectModelModeTrigger(replyText: string, thinkingText: string): ModelTriggerMatch | null {
  if (!FEATURE_FLAGS.model_trigger_mode_switch) return null;
  const fromReply = detectModelModeTriggerFromText(replyText);
  const fromThinking = FEATURE_FLAGS.model_trigger_include_thinking
    ? detectModelModeTriggerFromText(thinkingText)
    : null;
  if (!fromReply && !fromThinking) return null;
  if (fromReply && !fromThinking) return { mode: fromReply.mode, token: fromReply.token, source: 'response' };
  if (!fromReply && fromThinking) return { mode: fromThinking.mode, token: fromThinking.token, source: 'thinking' };
  const replyHit = fromReply as { mode: ModelTriggerMode; token: string; index: number };
  const thinkingHit = fromThinking as { mode: ModelTriggerMode; token: string; index: number };
  if (replyHit.index <= thinkingHit.index) {
    return { mode: replyHit.mode, token: replyHit.token, source: 'response' };
  }
  return { mode: thinkingHit.mode, token: thinkingHit.token, source: 'thinking' };
}

function shouldPromoteDraftToExecute(message: string, draft: string): boolean {
  const d = String(draft || '').toLowerCase();
  if (!d) return false;
  if (!isQuestionLike(message) && !isLikelyToolDirective(message)) return false;
  if (isFreshnessOrProvenanceQuery(message)) return true;
  if (/\b(can'?t run (live )?web search|cannot run (live )?web search|can'?t use tools|cannot use tools|per rules\b.*can'?t)\b/.test(d)) {
    return true;
  }
  if (/\b(i think|not sure|might be|possibly|probably|can'?t verify|cannot verify|training data|knowledge cutoff|based on my knowledge)\b/.test(d)) {
    return true;
  }
  if (/^thought:|^action:|^param:/im.test(d)) return true;
  return false;
}

function buildLastTurnContextHeader(history: any[], currentMessage: string): string {
  const h = Array.isArray(history) ? history : [];
  const lastUser = [...h].reverse().find((m: any) => m?.role === 'user')?.content || '';
  const lastAssistant = [...h].reverse().find((m: any) => m?.role === 'assistant')?.content || '';
  const summarize = (x: any) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return [
    `Last user question: ${summarize(lastUser) || '(none)'}`,
    `Your last answer (1 line): ${summarize(lastAssistant) || '(none)'}`,
    `User's current message: ${summarize(currentMessage)}`,
  ].join('\n');
}

function clipPromptText(input: string, max = 120): string {
  return String(input || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function summarizeRecentToolResultForContext(toolName: string, resultSummary: string): string {
  const tool = String(toolName || '').trim().toLowerCase();
  const raw = String(resultSummary || '').trim();
  if (!raw) return '(no result text)';

  if (tool === 'list') {
    try {
      const parsed = JSON.parse(raw);
      const listedPath = String(parsed?.path || '').trim();
      const files = Array.isArray(parsed?.files)
        ? parsed.files.map((x: any) => String(x || '').trim()).filter(Boolean)
        : [];
      const dirs = Array.isArray(parsed?.directories)
        ? parsed.directories.map((x: any) => String(x || '').trim()).filter(Boolean)
        : [];
      const filePart = files.length ? `Files (${files.length}): ${files.join(', ')}` : 'Files: none';
      const dirPart = dirs.length ? `Directories (${dirs.length}): ${dirs.join(', ')}` : 'Directories: none';
      const prefix = listedPath ? `Path: ${listedPath} | ` : '';
      return clipPromptText(`${prefix}${filePart} | ${dirPart}`, 2000);
    } catch {
      // fall through to generic clip
    }
    return clipPromptText(raw, 2000);
  }

  return clipPromptText(raw, 220);
}

function shouldInjectRecentToolContext(message: string, state?: AgentSessionState): boolean {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return false;
  if (isGreetingOnlyMessage(m) || isReactionLikeMessage(m)) return false;
  if (isRetryOnlyMessage(m) || isCorrectiveRetryCue(m) || isReferentialFollowUp(m)) return true;
  if (isWorkspaceListingRequest(m)) return true;
  if (isFileOperationRequest(m) || isFileFollowupOperationRequest(m, state) || isLikelyToolDirective(m)) return true;
  if (/\b(you|it|that|them)\b/.test(m) && /\b(did|changed|updated|listed|removed|deleted|created|renamed|worked|work)\b/.test(m)) return true;
  return false;
}

function buildRecentToolActionsContext(
  state: AgentSessionState,
  maxExecutions = 2,
  maxCallsPerExecution = 3
): string {
  const candidates: TurnExecution[] = [];
  if (state.currentTurnExecution) candidates.push(state.currentTurnExecution);
  const recent = Array.isArray(state.recentTurnExecutions) ? state.recentTurnExecutions : [];
  candidates.push(...recent);
  const out: string[] = [];
  const seenTurn = new Set<string>();
  let used = 0;
  for (const turn of candidates) {
    if (!turn || turn.mode !== 'execute') continue;
    const turnId = String(turn.turn_id || '').trim() || `turn_${used + 1}`;
    if (seenTurn.has(turnId)) continue;
    seenTurn.add(turnId);
    const calls = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
    const resultCalls = calls.filter((c) => String(c?.phase || '').toLowerCase() === 'result');
    const callList = resultCalls.length ? resultCalls : calls;
    if (!callList.length) continue;
    const objective = clipPromptText(String(turn.objective_normalized || turn.objective_raw || ''), 90) || '(objective unavailable)';
    out.push(`- [${turn.status}] ${objective}`);
    for (const c of callList.slice(0, maxCallsPerExecution)) {
      const tool = clipPromptText(String(c?.tool_name || 'tool'), 40) || 'tool';
      const result = summarizeRecentToolResultForContext(tool, String(c?.result_summary || ''));
      out.push(`  - ${tool}: ${result || '(no result text)'}`);
    }
    used++;
    if (used >= maxExecutions) break;
  }
  return out.join('\n').trim();
}

function buildChatReplyPrompt(message: string, state: AgentSessionState, history: any[]): string {
  const historyText = summarizeHistoryForPrompt(history || [], 6);
  const verified = buildVerifiedFactsHeader(state);
  const recentToolContext = shouldInjectRecentToolContext(message, state)
    ? buildRecentToolActionsContext(state, 2, 3)
    : '';
  // Detect multi-step request to inject task annotation instructions
  const clauses = splitInstructionClauses(message).filter(c => hasConcreteTaskVerb(c));
  const isMultiStep = clauses.length >= 2;
  const taskAnnotationInstructions = isMultiStep
    ? `MULTI-STEP TASK INSTRUCTIONS:\n` +
      `This request has multiple tasks. Before emitting open_tool, list them as:\n` +
      `T1: <first task>\nT2: <second task>\n(etc.)\n` +
      `Then emit open_plan to register the list, then open_tool to start executing.\n` +
      `After each execution cycle you will be asked to update task statuses using:\n` +
      `  task_done:T1  (task completed)\n` +
      `  task_continue:T2  (move to next task)\n` +
      `  task_blocked:T3  (task cannot proceed)\n` +
      `When ALL tasks are done, emit plan_done instead of open_tool.`
    : '';
  return [
    `You are LocalClaw in DISCUSS mode. Respond conversationally.`,
    `RULES:`,
    `1. Never run tools yourself in this mode.`,
    `2. If the user needs workspace/file work (create, read, delete, rename, move, list, count, etc.): ALWAYS write open_tool in your reply. This includes destructive operations like removing files — the execute mode handles confirmation, not you.`,
    `3. If the user needs a web search: write open_web somewhere in your reply.`,
    `4. open_tool and open_web are just words — writing them does NOT execute anything. The backend reads them and switches mode. You are simply signaling intent.`,
    `5. For greetings or pure conversation: respond normally, do not write open_tool.`,
    `6. NEVER try to handle file operations or confirmations yourself in discuss mode. ALWAYS hand off to execute mode via open_tool.`,
    taskAnnotationInstructions,
    `Respond like a normal conversational assistant.`,
    `Reference prior context when relevant.`,
    `For greetings/check-ins, do not inject unrelated facts unless the user asks.`,
    `Never claim or imply you performed a specific prior action unless that action is explicitly confirmed in recent conversation or verified tool steps.`,
    `If uncertain about prior actions, keep the reply generic and ask a brief follow-up instead of guessing.`,
    `Default to 1-3 sentences unless the user explicitly asks for depth.`,
    `Do NOT use planning/kickoff framing unless asked.`,
    `BANNED openers in CHAT: "What should we tackle first", "Here's the plan", "Next steps", "Step 1", "Let's break this down".`,
    verified,
    `Current plan state (reference only):\n${buildPlanContext(state)}`,
    recentToolContext ? `Recent verified tool actions:\n${recentToolContext}` : '',
    historyText ? `Recent conversation summary:\n${historyText}` : '',
    `Tiny context header:\n${buildLastTurnContextHeader(history || [], message)}`,
    `Assistant:`,
  ].filter(Boolean).join('\n\n');
}

function buildCoachReplyPrompt(message: string, state: AgentSessionState, history: any[]): string {
  const historyText = summarizeHistoryForPrompt(history || [], 8);
  const verified = buildVerifiedFactsHeader(state);
  const recentToolContext = shouldInjectRecentToolContext(message, state)
    ? buildRecentToolActionsContext(state, 2, 3)
    : '';
  return [
    `You are LocalClaw in DISCUSS mode. Respond with guidance.`,
    `RULES:`,
    `1. Never run tools yourself in this mode.`,
    `2. If the user needs workspace/file work (create, read, delete, rename, move, list, count, etc.): ALWAYS write open_tool in your reply. This includes destructive operations — execute mode handles confirmation.`,
    `3. If the user needs a web search: write open_web somewhere in your reply.`,
    `4. open_tool and open_web are just words — writing them does NOT execute anything. The backend reads them and switches mode. You are simply signaling intent.`,
    `5. For greetings or pure conversation: respond normally, do not write open_tool.`,
    `6. NEVER handle file operations or confirmations yourself. ALWAYS hand off via open_tool.`,
    `Provide practical guidance, options, or steps.`,
    `You may ask at most one clarifying question if needed.`,
    `Keep it concise and concrete.`,
    verified,
    `Current plan state:\n${buildPlanContext(state)}`,
    recentToolContext ? `Recent verified tool actions:\n${recentToolContext}` : '',
    historyText ? `Recent conversation summary:\n${historyText}` : '',
    `User: ${message}`,
    `Assistant:`,
  ].filter(Boolean).join('\n\n');
}

const CHAT_BANNED_OPENERS = [
  /^what should we tackle first/i,
  /^here('?| i)s the plan/i,
  /^next steps/i,
  /^step 1[:.\s]/i,
  /^let'?s break this down/i,
];

function enforceChatStyle(reply: string): string {
  const r = String(reply || '').trim();
  if (!r) return '';
  if (CHAT_BANNED_OPENERS.some(re => re.test(r))) {
    return 'I can help with that. Tell me what you want to do next.';
  }
  return r;
}

function sanitizeDiscussReplyForNoToolClaims(reply: string): string {
  const r = String(reply || '').trim();
  if (!r) return r;
  const actionClaim = /\b(i\s*(?:have|'ve)\s*(?:updated|changed|created|deleted|renamed|set|fixed|corrected|listed)|updated\s+`[^`]+`|(?:text|background)\s+color\s+updated|changed the (?:background|text)|i(?:'| a)m\s+changed)\b/i.test(r);
  const noAccessClaim = /\b(i\s*(?:don'?t|do not)\s+have\s+access|i\s*(?:can'?t|cannot)\s+(?:access|check|list|read|view)|no access)\b/i.test(r);
  const noPhysicalClaim = /\b(no physical location|this is text|text[-\s]?only|text[-\s]?based|virtual workspace|simulated workspace)\b/i.test(r);
  const fileScope = /\b(file|files|workspace|folder|directory|repo|html|txt|background|panel|text color|css|index\.html|list)\b/i.test(r);
  if ((noAccessClaim || noPhysicalClaim) && fileScope) {
    return 'I can run tools here and check that now.';
  }
  if (actionClaim && fileScope) {
    return 'I have not applied that change yet. Tell me exactly what to edit and I will run it now.';
  }
  return r;
}

function sanitizeStagedDiscussDraftReply(reply: string): string {
  const base = sanitizeDiscussReplyForNoToolClaims(reply);
  const r = String(base || '').trim();
  if (!r) return '';
  const stripped = r
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter((line) => line && !/^(open_plan|open_tool|open_web|plan_done|task_done:|task_continue:|task_blocked:)/i.test(line))
    .join(' ')
    .trim();
  if (!stripped && detectModelModeTriggerFromText(r)) return 'Got it - running that now.';
  const noAccessFileClaim = /\b(i\s*(?:don'?t|do not)\s+have\s+access|i\s*(?:can'?t|cannot)\s+(?:access|check|list|read|view))\b/i.test(stripped)
    && /\b(file|files|workspace|folder|directory|repo)\b/i.test(stripped);
  if (noAccessFileClaim) return 'Got it - running that now.';
  if (/^i\s*(?:have|'ve)\s*(?:fixed|corrected|updated|changed|listed)\b/i.test(stripped)) return 'Got it - running that now.';
  return stripped;
}

function hasTemporalContradictionClaim(text: string): boolean {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return /\b(hasn'?t happened yet|has not happened yet|as of my training|my knowledge cutoff|i don'?t have access to the current date|can'?t know today'?s date)\b/.test(t);
}

async function repairTemporalContradiction(
  ollama: any,
  systemPrompt: string,
  userMessage: string,
  draft: string
): Promise<string> {
  if (!hasTemporalContradictionClaim(draft)) return draft;
  const repairPrompt = [
    `Rewrite the assistant draft so it is consistent with runtime date/time and current turn context.`,
    `Do not mention training cutoff or claim the date/year has not happened.`,
    `Keep the same intent and answer naturally.`,
    `User: ${userMessage}`,
    `Draft: ${draft}`,
    `Rewritten answer:`,
  ].join('\n\n');
  try {
    const out = await ollama.generateWithRetryThinking(repairPrompt, 'executor', {
      temperature: 0.1,
      system: `${systemPrompt}\n\nUse runtime header as authoritative.`,
      num_ctx: 1536,
      think: 'low',
    });
    const { cleaned } = stripThinkTags(out.response || '');
    const repaired = stripProtocolArtifacts(cleaned || '').trim();
    return repaired || draft;
  } catch {
    return draft;
  }
}

function modeFromTurnKind(kind: TurnKind): AgentMode {
  if (kind === 'plan') return 'plan';
  if (kind === 'discuss') return 'discuss';
  return 'execute';
}

function inferAgentIntent(message: string, state: AgentSessionState): AgentMode {
  const m = message.toLowerCase().trim();
  if (m.startsWith('/chat ')) return 'discuss';
  if (m.startsWith('/exec ')) return 'execute';
  if (isFileOperationRequest(m) || isFileFollowupOperationRequest(m, state) || isShellOperationRequest(m)) return 'execute';
  if (isConversationIntent(m)) return 'discuss';
  if (isReactionLikeMessage(m)) return 'discuss';
  if (isQuestionLike(m) && /\b(futures?|comex|cme|contract|front month|expiry|basis|contango|backwardation)\b/.test(m)) return 'execute';
  if (isQuestionLike(m) && isMarketFollowUpMessage(m) && hasRecentVerifiedFactType(state, 'market_price', 240)) return 'execute';
  if (isQuestionLike(m) && (isOfficeHolderQuery(m) || isWeatherQuery(m))) return 'execute';
  // Fresh/current factual lookups should always route to execute (tool-capable path),
  // even while agent mode is in discuss state.
  if (/\bif it was real|hypothetical|hypothetically\b/.test(m) && !asksForSources(m)) {
    return 'discuss';
  }
  if (isQuestionLike(m) && needsFreshLookup(m)) {
    return 'execute';
  }
  // Non-fresh questions stay conversational unless user asks for verification/citations.
  if (isQuestionLike(m) && asksForSources(m)) {
    return 'execute';
  }
  if (isLikelyToolDirective(m)) {
    return 'execute';
  }

  const executeSignals = [
    /\bok(ay)?\s+go\s+ahead\b/,
    /\bgo\s+ahead\b/,
    /\bdo\s+it\b/,
    /\blet'?s\s+do\s+it\b/,
    /\bexecute\b/,
    /\brun\s+(it|this|the plan)\b/,
    /\bstart\b/,
    /\bbegin\b/,
    /\bproceed\b/,
    /\bcontinue\b/,
    /\bship\s+it\b/,
  ];
  if (executeSignals.some(r => r.test(m))) return 'execute';
  if (/\b(plan|roadmap|strategy|approach|brainstorm|requirements|scope)\b/.test(m)) return 'plan';
  if (state.mode === 'plan' && /\b(add|change|update|also|and|need|must|should)\b/.test(m)) return 'plan';
  if (state.mode === 'execute' && /\bcontinue|next|keep\s+going\b/.test(m)) return 'execute';
  return 'discuss';
}

function updateSessionPlanFromUser(state: AgentSessionState, message: string, intent: AgentMode, turnKind: TurnKind): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  state.mode = intent;
  const turn: TurnObjective = {
    id: randomUUID().slice(0, 8),
    text: trimmed,
    kind: turnKind,
    status: 'open',
    createdAt: Date.now(),
  };
  state.turns.push(turn);
  if (state.turns.length > 60) state.turns = state.turns.slice(state.turns.length - 60);

  if (turnKind === 'new_objective') {
    state.activeObjective = trimmed;
    if (!state.objective) state.objective = trimmed;
  } else if (turnKind === 'continue_plan' && !state.activeObjective) {
    state.activeObjective = trimmed;
    if (!state.objective) state.objective = trimmed;
  } else if (!state.objective && intent !== 'discuss') {
    state.objective = trimmed;
  }

  state.notes = compactLines([...state.notes, trimmed], 12);
  if (intent === 'plan' || turnKind === 'new_objective') {
    const taskCandidates = extractTaskCandidates(trimmed);
    for (const title of taskCandidates) {
      if (!state.tasks.some(t => t.title.toLowerCase() === title.toLowerCase())) {
        state.tasks.push({ id: randomUUID().slice(0, 8), title, status: 'pending', tool: suggestToolForTaskText(title) });
      }
    }
    state.tasks = state.tasks.slice(0, 20);
  }
  if (turnKind === 'side_question' && hasConcreteTaskVerb(trimmed)) {
    const title = trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
    if (!state.tasks.some(t => t.title.toLowerCase() === title.toLowerCase() && (t.status === 'pending' || t.status === 'in_progress'))) {
      state.tasks.push({ id: randomUUID().slice(0, 8), title, status: 'in_progress', tool: suggestToolForTaskText(title) });
      state.tasks = state.tasks.slice(0, 20);
    } else {
      const openTask = state.tasks.find(t => t.title.toLowerCase() === title.toLowerCase() && (t.status === 'pending' || t.status === 'in_progress' || t.status === 'failed'));
      if (openTask) openTask.status = 'in_progress';
    }
  }
  const pendingQs = trimmed.match(/[^.!?]*\?/g)?.map(s => s.trim()).filter(Boolean) || [];
  if (pendingQs.length > 0) {
    state.pendingQuestions = compactLines([...state.pendingQuestions, ...pendingQs], 8);
  }
  state.summary = compactLines([...state.notes], 6).join(' | ');
  state.updatedAt = Date.now();
  persistAgentSessionState(state);
}

function buildPlanContext(state: AgentSessionState): string {
  const taskLines = state.tasks.length
    ? state.tasks.map(t => `- [${t.status}] ${t.title}`).join('\n')
    : '- (no tasks yet)';
  const notes = state.notes.length ? state.notes.slice(-6).join('\n- ') : '';
  const pending = state.pendingQuestions.length ? state.pendingQuestions.slice(-4).join('\n- ') : '';
  const active = state.activeObjective || '(none)';
  const recentTurns = state.turns.slice(-6).map(t => `- [${t.kind}] ${t.text}`).join('\n');
  return [
    `Overview Objective: ${state.objective || '(not set)'}`,
    `Active Objective: ${active}`,
    `Summary: ${state.summary || '(none)'}`,
    `Tasks:\n${taskLines}`,
    recentTurns ? `Recent Turns:\n${recentTurns}` : '',
    notes ? `Recent Notes:\n- ${notes}` : '',
    pending ? `Open Questions:\n- ${pending}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Compact task ledger for continuation loop re-entry prompts.
 * Shows [ ] / [x] / [!] checkboxes — small model friendly.
 */
function buildContinuationLedger(state: AgentSessionState): string {
  if (!state.tasks.length) return '(no tasks)';
  return state.tasks.map(t => {
    const icon = t.status === 'done' ? '[x]' : t.status === 'failed' ? '[!]' : '[ ]';
    return `${icon} ${t.model_task_id || ''}: ${t.title}`.trim();
  }).join('\n');
}

/**
 * Runs a fast, compact discuss pass for continuation loop re-entry.
 * The model sees: original request + current ledger + last execution result.
 * It must either emit open_tool (more tasks) or write a final completion summary.
 */
async function runContinuationDiscussPass(
  ollama: ReturnType<typeof getOllamaClient>,
  state: AgentSessionState,
  lastExecutionResult: string,
  systemPrompt: string,
): Promise<{ reply: string; thinking: string }> {
  const ledger = buildContinuationLedger(state);
  const pendingCount = state.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length;
  const doneCount = state.tasks.filter(t => t.status === 'done').length;
  const prompt = [
    `Original request: ${state.continuationOriginMessage || state.activeObjective || state.objective}`,
    `Task ledger (${doneCount}/${state.tasks.length} done):\n${ledger}`,
    `Last execution result:\n${String(lastExecutionResult || '').slice(0, 600)}`,
    pendingCount > 0
      ? `Instructions: ${pendingCount} task(s) remain. Update any task statuses you know changed (task_done:T1, task_continue:T2). Write the next task to run and emit open_tool to continue. Keep it to 2-3 sentences.`
      : `Instructions: All tasks appear complete. Write a short plain-English completion summary for the user. Do NOT emit open_tool.`,
    `Assistant:`,
  ].join('\n\n');
  const out = await ollama.generateWithRetryThinking(prompt, 'executor', {
    temperature: 0.15,
    system: `${systemPrompt}\n\nYou are in continuation mode. Update task statuses and either emit open_tool to continue or write a final summary. Be concise.`,
    num_ctx: 2048,
    num_predict: 256,
    think: 'low',
  }, 1);
  const { cleaned, inlineThinking } = stripThinkTags(out.response || '');
  const thinking = mergeThinking(out.thinking || '', inlineThinking);
  const reply = stripProtocolArtifacts(String(cleaned || '')).trim();
  return { reply, thinking };
}

function summarizeHistoryForPrompt(history: any[], maxTurns = 6): string {
  const recent = (history || []).slice(-maxTurns);
  if (!recent.length) return '';
  const lines = recent.map((m: any) => {
    const role = m.role === 'user' ? 'U' : 'A';
    const txt = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return `${role}: ${txt}`;
  });
  return lines.join('\n');
}

function buildPlanReplyPrompt(message: string, state: AgentSessionState, history: any[]): string {
  const historyText = summarizeHistoryForPrompt(history || [], 8);
  return [
    `You are in planning/discussion mode. Do NOT call tools.`,
    `Keep replies concise, practical, and grounded in the session plan.`,
    `When helpful, ask one clarifying question.`,
    `Current plan state:\n${buildPlanContext(state)}`,
    historyText ? `Recent conversation summary:\n${historyText}` : '',
    `User: ${message}`,
    `Assistant:`,
  ].filter(Boolean).join('\n\n');
}

function buildExecutionInput(
  message: string,
  state: AgentSessionState,
  turnKind: TurnKind,
  triggerThinking = '',
  confirmationApproved = false
): string {
  const referential = isReferentialFollowUp(message) || isRetryOnlyMessage(message) || isCorrectiveRetryCue(message);
  const standalone = (turnKind === 'new_objective' && !referential) || (turnKind === 'side_question' && !referential);
  const recentToolContext = buildRecentToolActionsContext(state, 2, 4);
  const confirmationContext = confirmationApproved
    ? 'Confirmation status: APPROVED (user explicitly confirmed yes for this destructive action).'
    : '';
  // Execute brief: include the model's own prior reasoning so it knows exactly why it switched modes
  const nodeCallNote = `\n\nTo act, write: node_call<your Node.js code here>\nUse WORKSPACE constant as base path. Examples:\n  node_call<const fs=require('fs'); return fs.readdirSync(WORKSPACE);>\n  node_call<const fs=require('fs'),path=require('path'); fs.unlinkSync(path.join(WORKSPACE,'file.txt')); // DESTRUCTIVE>\nWrite FINAL: <summary> when done. If user clearly asked for the action, just do it.`;
  const brief = triggerThinking
    ? `You are now in EXECUTE mode.\nYou switched here because you determined tools were needed.\nYour reasoning that triggered this switch:\n${triggerThinking.slice(0, 800)}${nodeCallNote}`
    : `You are now in EXECUTE mode. Complete the user request using node_call blocks.${nodeCallNote}`;
  if (standalone) {
    return [
      brief,
      `User request: ${message}`,
      `Use tools to complete this. Do not explain or narrate — act and report the result.`,
      `Guardrails: never assume file structure, filenames, paths, or code layout. Inspect first (list/read/stat) before any mutation.`,
      `DESTRUCTIVE OPS RULE: If the user's message clearly says to do the action (e.g. "remove them", "delete it", "go ahead", "yes do it"), that IS confirmation — proceed and write the node_call with // DESTRUCTIVE. Only use open_confirm if the user's intent is genuinely ambiguous (e.g. "what about those files?" or "handle the golden files").`,
      confirmationContext ? confirmationContext : `The user said: "${message.slice(0, 100)}" — decide if this is clear intent or ambiguous.`,
      recentToolContext ? `Recent tool actions:\n${recentToolContext}` : '',
      state.activeObjective ? `Active objective (reference): ${state.activeObjective}` : '',
    ].filter(Boolean).join('\n\n');
  }
  return [
    brief,
    `User request: ${message}`,
    buildPlanContext(state),
    `Execute using tools. Complete pending tasks and report concrete outcomes.`,
    `Guardrails: never assume file structure, filenames, paths, or code layout. Inspect first (list/read/stat) before mutating anything.`,
    `DESTRUCTIVE OPS RULE: If the user's message clearly says to do the action (e.g. "remove them", "delete it", "go ahead", "yes do it"), that IS confirmation — proceed and write the node_call with // DESTRUCTIVE. Only use open_confirm if the user's intent is genuinely ambiguous.`,
    confirmationContext ? confirmationContext : `The user said: "${message.slice(0, 100)}" — decide if this is clear intent or ambiguous.`,
    recentToolContext ? `Recent tool actions:\n${recentToolContext}` : '',
  ].join('\n\n');
}

function stripThinkTags(text: string): { cleaned: string; inlineThinking: string } {
  const raw = String(text || '');
  const chunks: string[] = [];
  let cleaned = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
    const t = String(inner || '').trim();
    if (t) chunks.push(t);
    return '';
  });

  const openIdx = cleaned.toLowerCase().lastIndexOf('<think>');
  if (openIdx >= 0) {
    const trailing = cleaned.slice(openIdx + '<think>'.length).trim();
    if (trailing) chunks.push(trailing);
    cleaned = cleaned.slice(0, openIdx);
  }

  cleaned = cleaned.replace(/<\/think>/gi, '').trim();
  const inlineThinking = chunks.join('\n\n').trim();
  return { cleaned, inlineThinking };
}

function stripProtocolArtifacts(text: string): string {
  let s = String(text || '').trim();
  if (!s) return s;
  const final = s.match(/FINAL:\s*([\s\S]*?)(?:---END---|$)/i);
  if (final?.[1]) return final[1].trim();
  if (/^THOUGHT:\s*/i.test(s)) {
    s = s
      .replace(/^THOUGHT:\s*[\s\S]*?(?=\n(?:ACTION|PARAM|FINAL):|$)/i, '')
      .replace(/\n?ACTION:\s*[\s\S]*?(?=\nPARAM:|$)/i, '')
      .replace(/\n?PARAM:\s*[\s\S]*$/i, '')
      .replace(/---END---/g, '')
      .trim();
  }
  return s;
}

function mergeThinking(nativeThinking: string, inlineThinking: string): string {
  const a = (nativeThinking || '').trim();
  const b = (inlineThinking || '').trim();
  if (a && b) {
    if (a === b) return a;
    if (a.includes(b)) return a;
    if (b.includes(a)) return b;
    return `${a}\n\n${b}`;
  }
  return a || b;
}

function extractCurrentSentence(question: string, text: string): string | null {
  const q = String(question || '').toLowerCase();
  const t = String(text || '');
  if (!q || !t) return null;

  const sentences = t
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);

  const roleHintMatch = q.match(/current\s+(.+?)(?:\?|$)/i);
  const roleHint = roleHintMatch?.[1]?.toLowerCase().replace(/\b(the|of|us|u\.s\.)\b/g, ' ').replace(/\s+/g, ' ').trim() || '';

  for (const s of sentences) {
    const low = s.toLowerCase();
    if (!low.includes('current') || !low.includes(' is ')) continue;
    if (roleHint && !low.includes(roleHint)) continue;
    const clean = s.replace(/\s+/g, ' ').trim();
    if (clean.length >= 12 && clean.length <= 220) return clean;
  }

  // Fallback for patterns like: "Pam Bondi was sworn in as the 87th Attorney General..."
  for (const s of sentences) {
    const low = s.toLowerCase();
    if (!/\bwas\s+(sworn in|appointed|confirmed)\b/.test(low)) continue;
    if (roleHint && !low.includes(roleHint)) continue;
    const clean = s.replace(/\s+/g, ' ').trim();
    if (clean.length >= 12 && clean.length <= 220) return clean;
  }

  return null;
}

function isEventSummaryQuery(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return /\b(what happened|outcome|key takeaways|takeaways|latest update|what went down|summary|recap)\b/.test(m)
    || (/\b(hearing|trial|case|investigation|lawsuit|court|testimony)\b/.test(m) && /\b(what|how|why|when)\b/.test(m));
}

function parseTopSearchResults(text: string, max = 5): Array<{ title: string; url: string; snippet: string }> {
  const s = String(text || '');
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const re = /(?:^|\n)\[(\d+)\]\s+([^\n]+)\n\s+(https?:\/\/[^\s]+)\n\s+([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({
      title: String(m[2] || '').trim(),
      url: String(m[3] || '').trim(),
      snippet: String(m[4] || '').trim(),
    });
    if (out.length >= max) break;
  }
  return out;
}

function isAttributionSensitiveQuery(message: string): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return /\b(what did|did .+ say|did .+ state|quote|exact words|statement|testimony|what was said|said anything)\b/.test(m);
}

function snippetsContainDirectAttribution(results: Array<{ title: string; url: string; snippet: string }>, message: string): boolean {
  const qTokens = String(message || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4)
    .slice(0, 6);
  for (const r of results || []) {
    const combined = `${String(r.title || '')} ${String(r.snippet || '')}`.toLowerCase();
    const hasAttributionCue = /"[^"]{8,}"|\'[^\']{8,}\'|\b(said|stated|told|according to|testified|announced|wrote|posted|tweeted)\b/.test(combined);
    if (!hasAttributionCue) continue;
    if (!qTokens.length) return true;
    if (qTokens.some((t) => combined.includes(t))) return true;
  }
  return false;
}

function pickTopSearchUrl(toolData: any, fallbackText: string): string {
  const urlFromResults = Array.isArray(toolData?.results)
    ? String(toolData.results.find((r: any) => /^https?:\/\//i.test(String(r?.url || '')))?.url || '').trim()
    : '';
  if (urlFromResults) return urlFromResults;
  const parsed = parseTopSearchResults(fallbackText, 1);
  return String(parsed?.[0]?.url || '').trim();
}

function buildEventOutcomeSummary(message: string, text: string): string | null {
  if (!isEventSummaryQuery(message)) return null;
  const results = parseTopSearchResults(text, 6);
  if (!results.length) return null;

  const nonOpinion = results.filter(r => !/\b(opinion|editorial|letters)\b/i.test(r.title));
  const picked = (nonOpinion.length ? nonOpinion : results).slice(0, 3);
  if (!picked.length) return null;

  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const r of picked) {
    const line = r.snippet.replace(/\s+/g, ' ').trim();
    if (!line || line.length < 24) continue;
    const key = line.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(`- ${line}`);
    if (bullets.length >= 3) break;
  }
  if (!bullets.length) return null;

  const links = picked.map((r, i) => `${i + 1}. ${r.url}`);
  return `Here are the key reported takeaways:\n${bullets.join('\n')}\n\nSources:\n${links.join('\n')}`;
}

function isOfficeHolderTrustedUrl(url: string): number {
  const u = String(url || '').toLowerCase();
  if (!u) return 0;
  if (/https?:\/\/(www\.)?whitehouse\.gov\/administration\//.test(u)) return 100;
  if (/https?:\/\/(www\.)?whitehouse\.gov/.test(u)) return 90;
  if (/https?:\/\/(www\.)?[a-z0-9.-]+\.gov\//.test(u)) return 70;
  if (/obamawhitehouse\.archives\.gov/.test(u)) return 25;
  return 10;
}

type OfficeRole = 'president' | 'vice_president';

function inferOfficeRoleFromQuery(toolData: any): OfficeRole | null {
  const q = String(toolData?.query || '').toLowerCase();
  if (!q) return null;
  if (/\bvice president\b/.test(q)) return 'vice_president';
  if (/\bpresident\b/.test(q)) return 'president';
  return null;
}

function normalizeExtractedName(name: string): string {
  const raw = String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/[,\-:;]+$/g, '')
    .trim();
  if (!raw) return '';
  const tokens = raw.split(' ').filter(Boolean).slice(0, 4);
  const normalized = tokens.map((t) => {
    const clean = t.replace(/\.+$/g, '');
    if (!clean) return '';
    if (/^[A-Z]{1,3}$/.test(clean)) return clean;
    if (/^[A-Z]\.$/.test(t)) return t.toUpperCase();
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }).filter(Boolean);
  return normalized.join(' ').trim();
}

function extractHumanName(text: string): string | null {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const NAME_TOKEN = `(?:[A-Z][A-Za-z.'-]*|[A-Z]{2,}|[A-Z]\\.)`;
  const p1 = s.match(new RegExp(`\\bVice President(?: of the United States)?\\s*[-:–—]?\\s*(${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,3})\\b`));
  if (p1?.[1]) return normalizeExtractedName(p1[1]);
  const p2 = s.match(new RegExp(`\\b(${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,3})\\s*[-:–—]\\s*Vice President\\b`));
  if (p2?.[1]) return normalizeExtractedName(p2[1]);
  return null;
}

function slugToName(slug: string): string {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => {
      if (/^[a-z]{1,3}$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ')
    .trim();
}

function extractOfficeHolderAnswerFromResults(toolData: any): { answer: string; sources: string[]; confidence: number } | null {
  const rigorCfg = getSearchRigorConfig();
  const results = Array.isArray(toolData?.results) ? toolData.results : [];
  if (!results.length) return null;
  const askedRole = inferOfficeRoleFromQuery(toolData);
  const answerPrefix = askedRole === 'president'
    ? 'The President of the United States is'
    : 'The Vice President of the United States is';
  const ranked: Array<{ url: string; title: string; snippet: string; score: number }> = results.map((r: any) => {
    const url = String(r?.url || '').trim();
    const title = String(r?.title || '');
    const snippet = String(r?.snippet || '');
    let score = isOfficeHolderTrustedUrl(url);
    const combined = `${title} ${snippet}`;
    if (/\bvice president\b/i.test(combined)) score += askedRole === 'vice_president' ? 28 : -18;
    if (/\bpresident\b/i.test(combined)) score += askedRole === 'president' ? 18 : 6;
    if (/\bunited states\b/i.test(combined)) score += 10;
    return { url, title, snippet, score };
  }).sort((a: { score: number }, b: { score: number }) => b.score - a.score);

  for (const r of ranked) {
    if (r.score < 35) continue;
    if (rigorCfg.requireOfficialForOffice && !/whitehouse\.gov\/administration\//i.test(r.url)) continue;
    const fromText = extractHumanName(`${r.title} ${r.snippet}`);
    if (fromText) {
      return {
        answer: `${answerPrefix} ${fromText}.`,
        sources: [r.url].filter(Boolean),
        confidence: Math.min(0.98, r.score / 120),
      };
    }
    const slug = r.url.match(/\/administration\/([^\/?#]+)/i)?.[1];
    if (slug && slug.toLowerCase() !== 'administration') {
      const nm = slugToName(slug);
      if (nm && !/\b(administration|white house)\b/i.test(nm)) {
        const combined = `${r.title} ${r.snippet}`.toLowerCase();
        if (askedRole === 'president' && /\bvice president\b/.test(combined)) continue;
        if (askedRole === 'vice_president' && /\bvice president\b/.test(combined) === false && /\bpresident\b/.test(combined)) continue;
        return {
          answer: `${answerPrefix} ${nm}.`,
          sources: [r.url].filter(Boolean),
          confidence: Math.min(0.95, r.score / 120),
        };
      }
    }
  }
  return null;
}

function extractToolAnswerBundle(text: string): { answerLine: string; bullets: string[]; sources: string[] } | null {
  const s = String(text || '');
  if (!/Answer:\s*/i.test(s)) return null;
  const answerLine = s.match(/Answer:\s*([^\n]+)/i)?.[1]?.trim() || '';
  if (!answerLine) return null;
  const bulletMatches = Array.from(s.matchAll(/^\s*-\s+(.+)$/gim)).map(m => String(m[1] || '').trim()).slice(0, 4);
  const sourceMatches = Array.from(s.matchAll(/https?:\/\/[^\s)]+/g)).map(m => m[0]).slice(0, 5);
  return { answerLine, bullets: bulletMatches, sources: sourceMatches };
}

function buildEvidenceGatedReply(bundle: { answerLine: string; bullets: string[]; sources: string[] }): string {
  const lines: string[] = [];
  // Keep only concise lines; avoid gigantic pasted fragments.
  const clean = (x: string) => x.replace(/\[[0-9]+\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  lines.push(clean(bundle.answerLine));
  for (const b of bundle.bullets) {
    const c = clean(b);
    if (c.length >= 20) lines.push(`- ${c}`);
    if (lines.length >= 4) break;
  }
  const uniqueSources = Array.from(new Set(bundle.sources)).slice(0, 3);
  if (uniqueSources.length) {
    lines.push('Sources:');
    for (let i = 0; i < uniqueSources.length; i++) lines.push(`${i + 1}. ${uniqueSources[i]}`);
  }
  return lines.join('\n');
}

function buildEvidenceReplyFromToolData(toolData: any): string | null {
  if (!toolData || typeof toolData !== 'object') return null;
  const facts = Array.isArray(toolData.facts) ? toolData.facts : [];
  const sources = Array.isArray(toolData.sources) ? toolData.sources : [];
  if (!facts.length || !sources.length) return null;
  const clean = (x: string) => String(x || '').replace(/\[[0-9]+\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const out: string[] = [];
  out.push(clean(facts[0]?.claim || ''));
  for (const f of facts.slice(1, 4)) {
    const c = clean(f?.claim || '');
    if (c.length >= 20) out.push(`- ${c}`);
  }
  const links = sources
    .slice(0, 3)
    .map((s: any, i: number) => `${i + 1}. ${s?.url || ''}`.trim())
    .filter((x: string) => /\d+\.\s+https?:\/\//.test(x));
  if (links.length) {
    out.push('Sources:');
    out.push(...links);
  }
  const text = out.filter(Boolean).join('\n').trim();
  return text.length >= 24 ? text : null;
}

function getRuntimeFreshnessInstruction(): string {
  const now = new Date();
  const utcIso = now.toISOString();
  const local = now.toLocaleString();
  const modelId = config.models?.primary || 'unknown';
  return [
    `You are LocalClaw running locally on the user's machine.`,
    `Current agent model: ${modelId}.`,
    `Local time: ${local}.`,
    `UTC time: ${utcIso}.`,
    `This runtime header is authoritative. If anything conflicts, follow this header.`,
    `Never claim a date/year hasn't happened if runtime date shows it has.`,
    `Treat model priors as potentially stale; for factual/current queries use tools first and only fall back to memory if tools fail.`,
  ].join('\n');
}

function pruneVerifiedFacts(state: AgentSessionState): void {
  const now = Date.now();
  const facts = Array.isArray(state.verifiedFacts) ? state.verifiedFacts : [];
  state.verifiedFacts = facts
    .filter(f => !!f && (f.verified_at + (Math.max(1, Number(f.ttl_minutes || 0)) * 60_000)) > now)
    .slice(-10);
}

function rememberVerifiedFact(state: AgentSessionState, fact: {
  key: string;
  value: string;
  claim_text: string;
  sources?: string[];
  ttl_minutes?: number;
  confidence?: number;
  fact_type?: 'generic' | 'office_holder' | 'weather' | 'breaking_news' | 'market_price' | 'event_date_fact';
  requires_reverify_on_use?: boolean;
  question?: string;
}): void {
  const key = String(fact.key || '').trim();
  const value = String(fact.value || '').trim();
  const claimText = String(fact.claim_text || '').trim();
  if (!key || !claimText) return;
  if (!Array.isArray(state.verifiedFacts)) state.verifiedFacts = [];
  pruneVerifiedFacts(state);
  const rec = {
    key,
    value: value || claimText.slice(0, 120),
    claim_text: claimText.slice(0, 260),
    sources: Array.isArray(fact.sources) ? fact.sources.slice(0, 3) : [],
    verified_at: Date.now(),
    ttl_minutes: Math.max(30, Math.min(1440, Number(fact.ttl_minutes || 240))),
    confidence: Math.max(0.5, Math.min(0.99, Number(fact.confidence || 0.8))),
    fact_type: fact.fact_type || 'generic',
    requires_reverify_on_use: !!fact.requires_reverify_on_use,
    question: String(fact.question || '').trim() || undefined,
  };
  const idx = state.verifiedFacts.findIndex(f => f.key === rec.key);
  if (idx >= 0) state.verifiedFacts[idx] = rec;
  else state.verifiedFacts.push(rec);
  state.verifiedFacts = state.verifiedFacts.slice(-10);
}

function buildVerifiedFactsHeader(state: AgentSessionState): string {
  pruneVerifiedFacts(state);
  const facts = Array.isArray(state.verifiedFacts) ? state.verifiedFacts : [];
  if (!facts.length) return '';
  const lines = facts.slice(-5).map(f => {
    const when = new Date(f.verified_at).toISOString().slice(0, 16).replace('T', ' ');
    return `- ${f.key}: ${f.claim_text} (verified ${when} UTC${f.sources?.length ? `; sources: ${f.sources.slice(0, 2).join(', ')}` : ''})`;
  });
  return [
    'Verified in this thread (authoritative; do not contradict unless you re-check with tools):',
    ...lines,
  ].join('\n');
}

function extractPrimaryDateToken(text: string): string {
  const s = String(text || '');
  const iso = s.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (iso) return iso;
  const mdy = s.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-3]?\d)(?:st|nd|rd|th)?(?:,)?\s+(20\d{2})\b/i);
  if (mdy) return `${mdy[1]} ${mdy[2]}, ${mdy[3]}`;
  return '';
}

function inferFactTypeFromQuestion(question: string): 'generic' | 'office_holder' | 'weather' | 'breaking_news' | 'market_price' | 'event_date_fact' {
  const n = normalizeUserRequest(question || '');
  return decideRoute(n).domain;
}

function contradictionTierForFact(fact: any): 1 | 2 {
  const ft = String(fact?.fact_type || '').toLowerCase();
  if (isMustVerifyDomain(ft) || fact?.requires_reverify_on_use) return 2;
  return 1;
}

function contradictsVerifiedFacts(draft: string, state: AgentSessionState): { hit: boolean; reason?: string; fact?: any } {
  const d = String(draft || '').trim();
  if (!d) return { hit: false };
  pruneVerifiedFacts(state);
  const facts = Array.isArray(state.verifiedFacts) ? state.verifiedFacts : [];
  if (!facts.length) return { hit: false };

  const low = d.toLowerCase();
  const invalidating = /\b(fictional|hypothetical scenario|didn'?t happen|hasn'?t happened|has not happened|not real|as of my training|knowledge cutoff)\b/.test(low);
  for (const f of facts) {
    const factDate = extractPrimaryDateToken(`${f.value} ${f.claim_text}`);
    if (invalidating && factDate) {
      const parsed = new Date(factDate);
      if (!isNaN(parsed.getTime()) && parsed.getTime() <= Date.now()) {
        return { hit: true, reason: 'draft invalidates a verified factual claim', fact: f };
      }
    }
    if (factDate) {
      const draftDate = extractPrimaryDateToken(d);
      if (draftDate && draftDate !== factDate && /\b(when|date|happened|occurred|took place)\b/i.test(low)) {
        return { hit: true, reason: `draft date "${draftDate}" conflicts with verified "${factDate}"`, fact: f };
      }
    }
  }
  return { hit: false };
}

function buildConsistencyLockedReply(state: AgentSessionState): string {
  pruneVerifiedFacts(state);
  const f = (state.verifiedFacts || []).slice(-1)[0];
  if (!f) return 'I may be mixing context. If you want, I can quickly re-check with sources.';
  const sourceHint = (f.sources || []).slice(0, 2);
  return `Yeah, it is wild. Earlier in this thread I verified: ${f.claim_text}.${sourceHint.length ? ` Sources: ${sourceHint.join(', ')}` : ''} If you want, I can re-check right now.`;
}

interface TurnPlan {
  turn_plan_version: number;
  user_intent: 'chat' | 'coach' | 'plan' | 'search_web' | 'file_edit' | 'code' | 'execute';
  requires_tools: boolean;
  tool_candidates: string[];
  standalone_request: string;
  domain: 'generic' | 'office_holder' | 'weather' | 'breaking_news' | 'market_price' | 'event_date_fact';
  search_text: string;
  expected_country: string;
  expected_entity_class: string;
  expected_keywords: string[];
  requires_verification: boolean;
  missing_info: string;
  confidence: number;
}

async function inferTurnPlan(
  ollama: any,
  message: string,
  state: AgentSessionState,
  history: any[]
): Promise<TurnPlan | null> {
  const historyText = summarizeHistoryForPrompt(history || [], 6);
  const prompt = [
    'Create a strict JSON turn plan for the next assistant turn.',
    'Return ONLY JSON with keys: turn_plan_version, user_intent, requires_tools, tool_candidates, standalone_request, domain, search_text, expected_country, expected_entity_class, expected_keywords, requires_verification, missing_info, confidence.',
    'user_intent must be one of: chat, coach, plan, search_web, file_edit, code, execute.',
    'domain must be one of: generic, office_holder, weather, breaking_news, market_price, event_date_fact.',
    'requires_tools is true only when external tools are needed now.',
    'standalone_request must rewrite the user request with context if needed.',
    'search_text must be a cleaned query-friendly version of user request.',
    'confidence is 0..1.',
    `Recent conversation:\n${historyText || '(none)'}`,
    `Plan context:\n${buildPlanContext(state)}`,
    `User message:\n${message}`,
  ].join('\n\n');
  try {
    const out = await ollama.generateWithRetryThinking(prompt, 'executor', {
      temperature: 0,
      num_ctx: 1536,
      think: 'low',
      system: 'You are a strict JSON planner. Output JSON only.',
    });
    const raw = String(out.response || '').trim();
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) return null;
    const parsed: any = JSON.parse(jsonText);
    const intent = String(parsed.user_intent || '').toLowerCase();
    const allowed = new Set(['chat', 'coach', 'plan', 'search_web', 'file_edit', 'code', 'execute']);
    if (!allowed.has(intent)) return null;
    const confidence = Number(parsed.confidence ?? 0);
    const standalone = String(parsed.standalone_request || message).trim() || message;
    const tools = Array.isArray(parsed.tool_candidates) ? parsed.tool_candidates.map((x: any) => String(x)).filter(Boolean).slice(0, 4) : [];
    const domainRaw = String(parsed.domain || 'generic').toLowerCase();
    const allowedDomain = new Set(['generic', 'office_holder', 'weather', 'breaking_news', 'market_price', 'event_date_fact']);
    const domain = allowedDomain.has(domainRaw) ? domainRaw as TurnPlan['domain'] : 'generic';
    const expectedKeywords = Array.isArray(parsed.expected_keywords)
      ? parsed.expected_keywords.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 5)
      : [];
    const normalized = normalizeUserRequest(message);
    return {
      turn_plan_version: Number.isFinite(Number(parsed.turn_plan_version)) ? Number(parsed.turn_plan_version) : 1,
      user_intent: intent as TurnPlan['user_intent'],
      requires_tools: !!parsed.requires_tools,
      tool_candidates: tools,
      standalone_request: standalone,
      domain,
      search_text: String(parsed.search_text || normalized.search_text || normalized.chat_text || message).trim(),
      expected_country: String(parsed.expected_country || '').trim(),
      expected_entity_class: String(parsed.expected_entity_class || '').trim(),
      expected_keywords: expectedKeywords,
      requires_verification: !!parsed.requires_verification,
      missing_info: String(parsed.missing_info || '').trim(),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    };
  } catch {
    return null;
  }
}

interface TurnPipelineResult {
  routingMessage: string;
  turnPlan: TurnPlan | null;
  policyDecision: RouteDecision;
  freshnessQuery: boolean;
  freshnessMustUseWeb: boolean;
  turnKind: TurnKind;
  agentIntent: AgentMode;
}

async function runTurnPipeline(args: {
  ollama: any;
  normalizedMessage: string;
  forcedMode: AgentMode | null;
  sessionState: AgentSessionState;
  history: any[];
  agentPolicy: AgentPolicySettings;
  wantsSSE?: boolean;
  sseEvent?: (type: string, data: object) => void;
}): Promise<TurnPipelineResult> {
  const { ollama, normalizedMessage, forcedMode, sessionState, history, agentPolicy, wantsSSE, sseEvent } = args;
  let routingMessage = normalizedMessage;
  const replay = resolveRetryReplayMessage(normalizedMessage, sessionState);
  const correctiveReplay = replay ? '' : resolveCorrectiveReplayMessage(normalizedMessage, sessionState);
  const replayMessage = replay || correctiveReplay;
  if (replayMessage) {
    routingMessage = replayMessage;
    if (wantsSSE && sseEvent) {
      if (replay) {
        sseEvent('info', { message: `Retry replay detected. Re-running last failed execute objective: "${replayMessage.slice(0, 140)}"` });
      } else {
        sseEvent('info', { message: `Corrective replay detected. Re-running prior tool objective: "${replayMessage.slice(0, 140)}"` });
      }
    }
  }
  if (/\byou changed\b[\s\S]*\bbackground\b[\s\S]*\bwant\b[\s\S]*\btext\b/i.test(String(normalizedMessage || ''))) {
    bumpDecisionMetric('wrong_target');
  }
  const normalizedInitial = normalizeUserRequest(routingMessage);
  let policyDecision = decideRoute(normalizedInitial);
  let turnPlan: TurnPlan | null = null;

  if (!policyDecision.locked_by_policy && !FEATURE_FLAGS.model_trigger_mode_switch) {
    turnPlan = await inferTurnPlan(ollama, routingMessage, sessionState, history || []);
    if (turnPlan && turnPlan.confidence >= 0.58) {
      routingMessage = turnPlan.standalone_request || turnPlan.search_text || normalizedMessage;
      if (wantsSSE && sseEvent) {
        sseEvent('info', {
          message: `Turn plan: intent=${turnPlan.user_intent}, tools=${turnPlan.requires_tools}, conf=${turnPlan.confidence.toFixed(2)}`,
        });
      }
    }
    const normalizedRouting = normalizeUserRequest(routingMessage);
    policyDecision = decideRoute(normalizedRouting);
  } else if (!policyDecision.locked_by_policy && FEATURE_FLAGS.model_trigger_mode_switch) {
    if (wantsSSE && sseEvent) {
      sseEvent('info', {
        message: 'Turn planner skipped (model-trigger mode) to reduce routing latency.',
      });
    }
  }

  if (wantsSSE && sseEvent) {
    sseEvent('info', {
      message: `Routing decision: lock=${policyDecision.locked_by_policy} reason=${policyDecision.lock_reason || 'none'}`,
      final_query: policyDecision.params?.query || '',
      domain: policyDecision.domain,
      expected_country: policyDecision.expected_country || '',
      provenance: policyDecision.provenance,
      requires_verification: policyDecision.requires_verification,
      locked_by_policy: policyDecision.locked_by_policy,
    });
  }
  logToolAudit({
    type: 'routing_decision',
    message: normalizedMessage,
    final_query: policyDecision.params?.query || '',
    domain: policyDecision.domain,
    expected_country: policyDecision.expected_country || '',
    expected_entity_class: policyDecision.expected_entity_class || '',
    provenance: policyDecision.provenance,
    requires_verification: policyDecision.requires_verification,
    locked_by_policy: policyDecision.locked_by_policy,
    lock_reason: policyDecision.lock_reason || '',
  });

  const freshnessQuery = (isQuestionLike(routingMessage) && needsFreshLookup(routingMessage))
    || policyDecision.requires_verification
    || !!(turnPlan && turnPlan.confidence >= 0.58 && turnPlan.requires_verification);
  const freshnessMustUseWeb = freshnessQuery && agentPolicy.force_web_for_fresh;

  let turnKind = classifyTurnKind(routingMessage, sessionState);
  let agentIntent = modeFromTurnKind(turnKind);
  if (forcedMode) {
    agentIntent = forcedMode;
    turnKind = forcedMode === 'execute' ? 'side_question' : 'discuss';
  } else if (FEATURE_FLAGS.model_trigger_mode_switch) {
    // Model-led switching mode: always start in discuss/chat, then let model output
    // trigger words to escalate to execute/web within the same turn.
    const obviousExecute = FEATURE_FLAGS.fast_execute_bypass && requiresToolExecutionForTurn(routingMessage, sessionState);
    if (obviousExecute) {
      agentIntent = 'execute';
      turnKind = 'side_question';
      if (wantsSSE && sseEvent) {
        sseEvent('info', { message: 'Fast execute bypass: skipping discuss for obvious tool-required request.' });
      }
    } else {
      agentIntent = 'discuss';
      turnKind = 'discuss';
    }
  } else {
    if (policyDecision.locked_by_policy) {
      agentIntent = 'execute';
      turnKind = 'side_question';
    }
    if (agentIntent === 'discuss' && needsDeterministicExecute(routingMessage, sessionState)) {
      agentIntent = 'execute';
      turnKind = 'side_question';
      if (wantsSSE && sseEvent) sseEvent('info', { message: 'Auto-promoted to execute via deterministic rule.' });
    }
  }

  return {
    routingMessage,
    turnPlan,
    policyDecision,
    freshnessQuery,
    freshnessMustUseWeb,
    turnKind,
    agentIntent,
  };
}

function buildScopedMemoryInstruction(query: string, sessionId: string, freshnessQuery: boolean): string {
  if (isGreetingOnlyMessage(query) || isReactionLikeMessage(query)) return '';
  const workspaceQuery = isWorkspaceListingRequest(query);
  const fileOpLike = isFileOperationRequest(query);
  const factsMax = workspaceQuery ? 3 : (fileOpLike ? 4 : 8);
  const dailyMax = workspaceQuery ? 0 : (fileOpLike ? 1 : 3);
  const includeDaily = dailyMax > 0;
  const workspaceId = computeWorkspaceId();
  const agentId = 'main';
  const facts = queryFactRecords({
    query,
    session_id: sessionId,
    workspace_id: workspaceId,
    agent_id: agentId,
    includeGlobal: true,
    includeStale: !freshnessQuery,
    max: factsMax,
  });
  const daily = includeDaily ? loadDailyMemorySnippets(query, dailyMax, fileOpLike ? 120 : 220, 100) : [];
  const workspaceLedger = fileOpLike ? buildWorkspaceLedgerSummary(6) : [];
  if (!facts.length && !daily.length && !workspaceLedger.length) return '';
  const now = Date.now();
  const lines = facts.slice(0, factsMax).map(f => {
    let freshness = 'fresh';
    if (f.expires_at) {
      const exp = new Date(f.expires_at).getTime();
      if (!isNaN(exp) && exp < now) freshness = 'stale';
    }
    const src = f.source_url || f.source_tool || 'memory';
    return `- [${f.scope}/${freshness}] key=${f.key} value=${f.value} (verified=${(f.verified_at || '').slice(0,10)} source=${src})`;
  });
  const dailyLines = daily.slice(0, dailyMax).map(x => `- ${x}`);
  const workspaceLines = workspaceLedger.map(x => `${x}`);
  return [
    lines.length ? `Relevant typed facts (top-k):\n${lines.join('\n')}` : '',
    workspaceLines.length ? `Workspace state ledger (authoritative recent file states):\n${workspaceLines.join('\n')}` : '',
    dailyLines.length ? `Recent daily memory snippets:\n${dailyLines.join('\n')}` : '',
    'Use stale entries only as fallback if tools fail.',
  ].filter(Boolean).join('\n\n');
}

function getMemoryFallbackForQuery(query: string): string | null {
  const workspaceId = computeWorkspaceId();
  const agentId = 'main';
  const typed = queryFactRecords({
    query,
    workspace_id: workspaceId,
    agent_id: agentId,
    includeGlobal: true,
    includeStale: true,
    max: 1,
  });
  if (typed.length > 0) {
    const t = typed[0];
    return `${t.value} (last verified ${String(t.verified_at || '').slice(0, 10)})`;
  }
  const raw = loadMemory();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('- '));
  if (!lines.length) return null;
  const tokens = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4);
  if (!tokens.length) return null;

  let bestLine = '';
  let bestScore = 0;
  for (const line of lines) {
    const low = line.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (low.includes(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
    }
  }
  if (!bestLine || bestScore < 2) return null;
  // Strip metadata prefix like "- [agent][key=...] "
  const cleaned = bestLine
    .replace(/^-+\s*/, '')
    .replace(/(\[[^\]]+\])+/g, '')
    .trim();
  return cleaned || null;
}

async function executeWebSearchWithSanity(
  params: { query: string; max_results?: number },
  opts: {
    expectedCountry?: string;
    expectedKeywords?: string[];
    expectedEntityClass?: string;
    domain?: string;
    onInfo?: (msg: string, meta?: any) => void;
  } = {}
): Promise<{ toolRes: any; finalParams: { query: string; max_results: number }; retried: boolean }> {
  const registry = getToolRegistry();
  const rigorCfg = getSearchRigorConfig();
  const baseParams = { query: String(params.query || '').trim(), max_results: Number(params.max_results || 5) || 5 };
  const first = await registry.execute('web_search', baseParams);
  const domain = String(opts.domain || '').toLowerCase();
  const looksLikeBroadLatestNews = /\b(latest|news|update|today|current|what.?s new)\b/i.test(baseParams.query);
  if (domain === 'breaking_news' && looksLikeBroadLatestNews) {
    // Broad news searches are often heterogeneous by design; skip sanity retry
    // to avoid duplicate web calls with little gain.
    return { toolRes: first, finalParams: baseParams, retried: false };
  }
  const retryNeeded = first.success && shouldRetryEntitySanity({
    toolData: first.data,
    expectedCountry: opts.expectedCountry,
    expectedKeywords: opts.expectedKeywords,
    expectedEntityClass: opts.expectedEntityClass,
  });
  if (!retryNeeded || rigorCfg.maxSanityRetries <= 0) return { toolRes: first, finalParams: baseParams, retried: false };

  const refinedQuery = refineQueryForExpectedScope(baseParams.query, opts.expectedCountry, opts.expectedKeywords);
  const refinedParams = { query: refinedQuery, max_results: baseParams.max_results };
  opts.onInfo?.('Entity sanity retry triggered; refining query.', { from: baseParams.query, to: refinedQuery });
  const second = await registry.execute('web_search', refinedParams);
  return { toolRes: second, finalParams: refinedParams, retried: true };
}

function buildPreflightStatusMessage(action: string, domain?: string): string {
  const a = String(action || '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  if (a === 'web_search') {
    if (d === 'market_price') return 'Searching the web for the latest market data...';
    if (d === 'office_holder') return 'Checking official sources for the current office holder...';
    if (d === 'weather') return 'Checking the latest forecast...';
    if (d === 'breaking_news' || d === 'event_date_fact') return 'Verifying with reliable sources...';
    return 'Searching the web for up-to-date information...';
  }
  if (a === 'time_now') return 'Checking current date and time...';
  if (a === 'node_call') return 'Running Node.js operation...';
  return 'Running tools to verify the answer...';
}

interface UiTurnArtifact {
  id: string;
  type: 'file_created' | 'file_updated' | 'file_deleted' | 'file_renamed' | 'file_read' | 'workspace_list';
  title: string;
  path?: string;
  from_path?: string;
  to_path?: string;
  status: 'ok' | 'error' | 'skipped';
  summary?: string;
  preview?: string;
  files?: string[];
  directories?: string[];
}

function resolveArtifactPathFromStep(step: any): string {
  const dataPath = String(step?.toolData?.path || '').trim();
  const paramPath = String(step?.params?.path || '').trim();
  const pathGuess = dataPath || paramPath;
  if (!pathGuess) return '';
  const abs = path.isAbsolute(pathGuess) ? pathGuess : path.join(config.workspace.path, pathGuess);
  return path.resolve(abs);
}

function buildTurnArtifactsFromSteps(steps: any[]): UiTurnArtifact[] {
  const out: UiTurnArtifact[] = [];
  const seen = new Set<string>();
  const stepList = Array.isArray(steps) ? steps : [];

  for (let i = 0; i < stepList.length; i++) {
    const step = stepList[i] || {};
    const action = String(step?.action || '').trim().toLowerCase();
    if (!action) continue;
    const hasResult = step?.toolResult !== undefined || step?.toolData !== undefined;
    if (!hasResult) continue;
    const resultText = String(step?.toolResult || '').trim();
    const isErr = /^error:/i.test(resultText);
    const isSkipped = /already absent|no-op|skipped/i.test(resultText);
    const status: UiTurnArtifact['status'] = isErr ? 'error' : (isSkipped ? 'skipped' : 'ok');

    if (action === 'list') {
      const files = Array.isArray(step?.toolData?.files) ? step.toolData.files.map((x: any) => String(x || '')).filter(Boolean) : [];
      const dirs = Array.isArray(step?.toolData?.directories) ? step.toolData.directories.map((x: any) => String(x || '')).filter(Boolean) : [];
      const key = `workspace_list:${files.join('|')}::${dirs.join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `artifact_${out.length + 1}`,
        type: 'workspace_list',
        title: 'Workspace listing',
        status,
        summary: `Files: ${files.length}, Directories: ${dirs.length}`,
        files: files.slice(0, 80),
        directories: dirs.slice(0, 40),
      });
      continue;
    }

    if (action === 'rename') {
      const fromPath = String(step?.toolData?.from || step?.params?.path || '').trim();
      const toPath = String(step?.toolData?.to || step?.params?.new_path || '').trim();
      const fromAbs = fromPath ? path.resolve(path.isAbsolute(fromPath) ? fromPath : path.join(config.workspace.path, fromPath)) : '';
      const toAbs = toPath ? path.resolve(path.isAbsolute(toPath) ? toPath : path.join(config.workspace.path, toPath)) : '';
      const key = `rename:${fromAbs}=>${toAbs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `artifact_${out.length + 1}`,
        type: 'file_renamed',
        title: 'File renamed',
        from_path: fromAbs || undefined,
        to_path: toAbs || undefined,
        status,
        summary: fromAbs && toAbs ? `${path.basename(fromAbs)} -> ${path.basename(toAbs)}` : undefined,
      });
      continue;
    }

    if (action === 'delete') {
      const p = resolveArtifactPathFromStep(step);
      if (!p) continue;
      const key = `delete:${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `artifact_${out.length + 1}`,
        type: 'file_deleted',
        title: 'File deleted',
        path: p,
        status,
        summary: path.basename(p),
      });
      continue;
    }

    if (action === 'read') {
      const p = resolveArtifactPathFromStep(step);
      if (!p) continue;
      const key = `read:${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const preview = String(step?.toolData?.content || '').slice(0, 500);
      out.push({
        id: `artifact_${out.length + 1}`,
        type: 'file_read',
        title: 'File read',
        path: p,
        status,
        summary: path.basename(p),
        preview: preview || undefined,
      });
      continue;
    }

    if (action === 'write' || action === 'edit' || action === 'append' || action === 'copy') {
      const p = resolveArtifactPathFromStep(step);
      if (!p) continue;
      const createHint = /\b(create|new file|file-create|deterministic create)\b/i.test(String(step?.thought || ''));
      const type: UiTurnArtifact['type'] = (action === 'write' && createHint) ? 'file_created' : 'file_updated';
      const key = `${type}:${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const size = Number(step?.toolData?.size || 0);
      const lines = Number(step?.toolData?.lines || 0);
      const summary = Number.isFinite(size) && size > 0
        ? `${path.basename(p)} (${size} bytes${Number.isFinite(lines) && lines > 0 ? `, ${lines} lines` : ''})`
        : path.basename(p);
      out.push({
        id: `artifact_${out.length + 1}`,
        type,
        title: type === 'file_created' ? 'File created' : 'File updated',
        path: p,
        status,
        summary,
      });
      continue;
    }
  }
  return out.slice(0, 24);
}

function countExecutedToolCalls(steps: any[]): number {
  const seen = new Set<string>();
  const stepList = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < stepList.length; i++) {
    const s = stepList[i] || {};
    const action = String(s?.action || '').trim();
    if (!action) continue;
    const stepNum = Number(s?.stepNum || i + 1) || (i + 1);
    const key = `${stepNum}:${action.toLowerCase()}`;
    seen.add(key);
  }
  return seen.size;
}

// Track connected clients for broadcasting
const clients = new Set<WebSocket>();

type CpuSnapshot = { idle: number; total: number; at: number };
type GpuStats = {
  available: boolean;
  gpu_count: number;
  gpu_util_percent: number | null;
  memory_util_percent: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  vram_used_percent: number | null;
  temperature_c: number | null;
  name: string;
  note?: string;
};
type OllamaProcStats = {
  running: boolean;
  process_count: number;
  total_memory_mb: number;
  pids: number[];
  note?: string;
};

let cpuSnapshotPrev: CpuSnapshot | null = null;
let gpuStatsCache: GpuStats = {
  available: false,
  gpu_count: 0,
  gpu_util_percent: null,
  memory_util_percent: null,
  memory_used_mb: null,
  memory_total_mb: null,
  vram_used_percent: null,
  temperature_c: null,
  name: '',
  note: 'Not sampled yet',
};
let gpuStatsCacheAt = 0;
let ollamaProcCache: OllamaProcStats = {
  running: false,
  process_count: 0,
  total_memory_mb: 0,
  pids: [],
  note: 'Not sampled yet',
};
let ollamaProcCacheAt = 0;

function readCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const times = c.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total, at: Date.now() };
}

function readCpuUsagePercent(): number | null {
  const now = readCpuSnapshot();
  if (!cpuSnapshotPrev) {
    cpuSnapshotPrev = now;
    return null;
  }
  const totalDelta = now.total - cpuSnapshotPrev.total;
  const idleDelta = now.idle - cpuSnapshotPrev.idle;
  cpuSnapshotPrev = now;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
  const used = 100 * (1 - (idleDelta / totalDelta));
  if (!Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Number(used.toFixed(1))));
}

function parseNumberLoose(input: string): number | null {
  const n = Number(String(input || '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseTasklistCsvLine(line: string): string[] {
  const out: string[] = [];
  const src = String(line || '').trim();
  if (!src) return out;
  const re = /"([^"]*)"(?:,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(String(m[1] || ''));
  return out;
}

function runCommandCapture(command: string, args: string[], timeoutMs = 900): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; error?: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      let finished = false;
      const done = (result: { ok: boolean; stdout: string; stderr: string; code: number | null; error?: string }) => {
        if (finished) return;
        finished = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        done({ ok: false, stdout, stderr, code: null, error: 'timeout' });
      }, Math.max(150, timeoutMs));
      child.stdout?.on('data', (d) => { stdout += String(d || ''); });
      child.stderr?.on('data', (d) => { stderr += String(d || ''); });
      child.on('error', (err: any) => {
        clearTimeout(timer);
        done({
          ok: false,
          stdout,
          stderr,
          code: null,
          error: String(err?.message || err || 'command_error'),
        });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        done({
          ok: code === 0,
          stdout,
          stderr,
          code,
          error: code === 0 ? undefined : `exit_${String(code)}`,
        });
      });
    } catch (err: any) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        code: null,
        error: String(err?.message || err || 'spawn_failed'),
      });
    }
  });
}

async function readOllamaProcessStatsFresh(): Promise<OllamaProcStats> {
  if (process.platform === 'win32') {
    const result = await runCommandCapture('tasklist', ['/FI', 'IMAGENAME eq ollama.exe', '/FO', 'CSV', '/NH'], 800);
    if (!result.ok && !result.stdout) {
      return { running: false, process_count: 0, total_memory_mb: 0, pids: [], note: result.error || 'tasklist_failed' };
    }
    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/^INFO:/i.test(l));
    if (!lines.length) return { running: false, process_count: 0, total_memory_mb: 0, pids: [] };
    const pids: number[] = [];
    let totalMemMb = 0;
    for (const line of lines) {
      const cols = parseTasklistCsvLine(line);
      if (cols.length < 5) continue;
      const pid = Number(cols[1]);
      const memKb = parseNumberLoose(cols[4]);
      if (Number.isFinite(pid)) pids.push(pid);
      if (memKb != null) totalMemMb += (memKb / 1024);
    }
    return {
      running: pids.length > 0,
      process_count: pids.length,
      total_memory_mb: Number(totalMemMb.toFixed(1)),
      pids,
    };
  }

  const result = await runCommandCapture('ps', ['-eo', 'pid,comm,rss'], 900);
  if (!result.ok && !result.stdout) {
    return { running: false, process_count: 0, total_memory_mb: 0, pids: [], note: result.error || 'ps_failed' };
  }
  const lines = String(result.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(1);
  const hits = lines.filter((l) => /\bollama\b/i.test(l));
  if (!hits.length) return { running: false, process_count: 0, total_memory_mb: 0, pids: [] };
  let totalMb = 0;
  const pids: number[] = [];
  for (const line of hits) {
    const parts = line.split(/\s+/);
    const pid = Number(parts[0]);
    const rssKb = Number(parts[parts.length - 1]);
    if (Number.isFinite(pid)) pids.push(pid);
    if (Number.isFinite(rssKb)) totalMb += (rssKb / 1024);
  }
  return {
    running: pids.length > 0,
    process_count: pids.length,
    total_memory_mb: Number(totalMb.toFixed(1)),
    pids,
  };
}

async function readGpuStatsFresh(): Promise<GpuStats> {
  const args = [
    '--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits',
  ];
  const result = await runCommandCapture('nvidia-smi', args, 900);
  if (!result.ok || !String(result.stdout || '').trim()) {
    return {
      available: false,
      gpu_count: 0,
      gpu_util_percent: null,
      memory_util_percent: null,
      memory_used_mb: null,
      memory_total_mb: null,
      vram_used_percent: null,
      temperature_c: null,
      name: '',
      note: result.error || 'nvidia_smi_unavailable',
    };
  }
  const rows = String(result.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((x) => x.trim()));
  if (!rows.length) {
    return {
      available: false,
      gpu_count: 0,
      gpu_util_percent: null,
      memory_util_percent: null,
      memory_used_mb: null,
      memory_total_mb: null,
      vram_used_percent: null,
      temperature_c: null,
      name: '',
      note: 'no_gpu_rows',
    };
  }
  let utilSum = 0;
  let memUtilSum = 0;
  let usedSum = 0;
  let totalSum = 0;
  let tempSum = 0;
  let utilCount = 0;
  let memUtilCount = 0;
  let tempCount = 0;
  const names: string[] = [];
  for (const cols of rows) {
    const name = String(cols[0] || '');
    const util = parseNumberLoose(cols[1] || '');
    const memUtil = parseNumberLoose(cols[2] || '');
    const usedMb = parseNumberLoose(cols[3] || '');
    const totalMb = parseNumberLoose(cols[4] || '');
    const tempC = parseNumberLoose(cols[5] || '');
    if (name) names.push(name);
    if (util != null) { utilSum += util; utilCount += 1; }
    if (memUtil != null) { memUtilSum += memUtil; memUtilCount += 1; }
    if (usedMb != null) usedSum += usedMb;
    if (totalMb != null) totalSum += totalMb;
    if (tempC != null) { tempSum += tempC; tempCount += 1; }
  }
  const gpuUtil = utilCount > 0 ? Number((utilSum / utilCount).toFixed(1)) : null;
  const memUtil = memUtilCount > 0 ? Number((memUtilSum / memUtilCount).toFixed(1)) : null;
  const vramPct = totalSum > 0 ? Number(((usedSum / totalSum) * 100).toFixed(1)) : null;
  const tempAvg = tempCount > 0 ? Number((tempSum / tempCount).toFixed(1)) : null;
  return {
    available: true,
    gpu_count: rows.length,
    gpu_util_percent: gpuUtil,
    memory_util_percent: memUtil,
    memory_used_mb: Number(usedSum.toFixed(1)),
    memory_total_mb: Number(totalSum.toFixed(1)),
    vram_used_percent: vramPct,
    temperature_c: tempAvg,
    name: names[0] || '',
  };
}

async function getOllamaProcessStatsCached(): Promise<OllamaProcStats> {
  const now = Date.now();
  if (now - ollamaProcCacheAt < 3500) return ollamaProcCache;
  const fresh = await readOllamaProcessStatsFresh();
  ollamaProcCache = fresh;
  ollamaProcCacheAt = now;
  return fresh;
}

async function getGpuStatsCached(): Promise<GpuStats> {
  const now = Date.now();
  if (now - gpuStatsCacheAt < 6000) return gpuStatsCache;
  const fresh = await readGpuStatsFresh();
  gpuStatsCache = fresh;
  gpuStatsCacheAt = now;
  return fresh;
}

function broadcast(data: object) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// Serve the web UI (single HTML file)
const UI_PATH = path.join(__dirname, '..', '..', 'web-ui', 'index.html');
app.use(express.json());

app.get('/', (req, res) => {
  if (fs.existsSync(UI_PATH)) {
    res.sendFile(UI_PATH);
  } else {
    res.send('<h1>LocalClaw Gateway</h1><p>UI not found. Place index.html in web-ui/</p>');
  }
});

// REST API
app.get('/api/status', async (req, res) => {
  const ollama = getOllamaClient();
  const ollamaOnline = await ollama.testConnection();
  const models = ollamaOnline ? await ollama.listModels() : [];
  res.json({
    status: 'online',
    ollama: ollamaOnline,
    models,
    currentModel: config.models.primary,
    gateway: `${config.gateway.host}:${config.gateway.port}`
  });
});

app.get('/api/system-stats', async (_req, res) => {
  try {
    const cpuPercent = readCpuUsagePercent();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(0, totalMem - freeMem);
    const memoryPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
    const mem = process.memoryUsage();
    const [ollamaProc, gpu] = await Promise.all([
      getOllamaProcessStatsCached(),
      getGpuStatsCached(),
    ]);

    res.json({
      timestamp: Date.now(),
      system: {
        cpu_percent: cpuPercent,
        memory_percent: Number(memoryPercent.toFixed(1)),
        memory_used_gb: Number((usedMem / (1024 ** 3)).toFixed(2)),
        memory_total_gb: Number((totalMem / (1024 ** 3)).toFixed(2)),
        uptime_sec: Math.floor(os.uptime()),
      },
      gateway_process: {
        pid: process.pid,
        uptime_sec: Math.floor(process.uptime()),
        rss_mb: Number((mem.rss / (1024 ** 2)).toFixed(1)),
        heap_used_mb: Number((mem.heapUsed / (1024 ** 2)).toFixed(1)),
        heap_total_mb: Number((mem.heapTotal / (1024 ** 2)).toFixed(1)),
      },
      ollama_process: ollamaProc,
      gpu,
      model: {
        current: config.models.primary,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err || 'system_stats_failed') });
  }
});

app.get('/api/jobs', (req, res) => {
  const jobs = db.listJobs();
  res.json(jobs);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const tasks = db.listTasksForJob(req.params.id);
  const artifacts = db.listArtifactsForJob(req.params.id);
  const state = db.getTaskState(req.params.id);
  res.json({ job, tasks, artifacts, state });
});

app.post('/api/jobs', async (req, res) => {
  const { mission, priority } = req.body;
  if (!mission) return res.status(400).json({ error: 'mission required' });
  try {
    const jobId = await orchestrator.executeJob(mission, { priority: priority || 0 });
    broadcast({ type: 'job_created', jobId, mission });
    res.json({ jobId, status: 'started' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/approvals', (req, res) => {
  res.json(db.listPendingApprovals());
});

app.post('/api/approvals/:id', (req, res) => {
  const { decision } = req.body; // 'approved' or 'rejected'
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or rejected' });
  }
  db.resolveApproval(req.params.id, decision as 'approved' | 'rejected');
  broadcast({ type: 'approval_resolved', id: req.params.id, decision });
  res.json({ ok: true });
});

app.get('/api/models', async (req, res) => {
  try {
    const ollama = getOllamaClient();
    const models = await ollama.listModels();
    res.json({ models, current: config.models.primary });
  } catch {
    res.json({ models: [], current: config.models.primary });
  }
});

app.post('/api/open-path', (req, res) => {
  try {
    const raw = String(req.body?.path || '').trim();
    if (!raw) return res.status(400).json({ error: 'path required' });
    const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(config.workspace.path, raw));
    const workspaceRoot = path.resolve(config.workspace.path);
    const rel = path.relative(workspaceRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(403).json({ error: 'Path outside workspace is not allowed.' });
    }
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: `Path does not exist: ${abs}` });
    }
    const st = fs.statSync(abs);
    if (process.platform === 'win32') {
      if (st.isDirectory()) {
        const proc = spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' });
        proc.unref();
      } else {
        const proc = spawn('explorer.exe', [`/select,${abs}`], { detached: true, stdio: 'ignore' });
        proc.unref();
      }
    } else if (process.platform === 'darwin') {
      const proc = spawn('open', ['-R', abs], { detached: true, stdio: 'ignore' });
      proc.unref();
    } else {
      const target = st.isDirectory() ? abs : path.dirname(abs);
      const proc = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
      proc.unref();
    }
    return res.json({ ok: true, path: abs });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message || err || 'open_path_failed') });
  }
});

// ── Question decomposition ────────────────────────────────────────────────────
// Splits "who is president AND what is the weather" into two sub-questions.
// Done in TypeScript — never ask the small model to coordinate multiple tasks.
function decomposeQuestion(message: string): string[] {
  const raw = String(message || '').trim();
  if (!raw) return [];
  if (isFileOperationRequest(raw) || isFileFollowupOperationRequest(raw)) {
    const clauses = splitInstructionClauses(raw);
    return clauses.length ? clauses : [raw];
  }
  return [raw];
}

// ── /api/chat — SSE streaming endpoint ──────────────────────────────────────
// Uses Server-Sent Events so the UI sees each step live as it happens.
// Falls back to plain JSON if the client doesn't set Accept: text/event-stream.
app.post('/api/chat', async (req, res) => {
  const { message, history, useTools, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const rawMessage = String(message || '');
  const normalizedMessage = rawMessage.replace(/^\/(chat|exec)\s+/i, '').trim() || rawMessage;
  let executionObjectiveForTurn = normalizedMessage;
  let forcedMode: AgentMode | null = /^\/chat\b/i.test(rawMessage) ? 'discuss' : (/^\/exec\b/i.test(rawMessage) ? 'execute' : null);
  let confirmationApprovedForTurn = false;
  let effectiveUseTools = !!useTools;
  const turnId = randomUUID();
  let executionSessionState: AgentSessionState | null = null;
  let hasFinalizedTurnExecution = false;
  let stagedDiscussDraftReply = '';
  let stagedTriggerSwitch: ModelTriggerMatch | null = null;
  let stagedTriggerThinking = ''; // the thinking block that caused the mode switch — passed to execute brief
  let postExecChatFinalizeFn: ((executionReply: string, steps: any[]) => Promise<string>) | null = null;
  // Continuation loop state — reset each new user turn, incremented inside sseDone
  let continuationSystemPrompt = '';
  let isContinuationReentry = false;
  let continuationPending = false; // set by sseDone to signal another execute cycle needed

  const wantsSSE = req.headers.accept?.includes('text/event-stream');
  const heartbeatState = {
    last_progress_event_at: Date.now(),
    last_tool_call_at: 0,
    current_step: 'init',
    retry_count: 0,
    format_violation_count: 0,
    last_stall_level: '' as '' | 'soft' | 'hard',
  };
  let heartbeatTimer: NodeJS.Timeout | null = null;

  // SSE helpers
  function sseSetup() {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const stallMs = now - heartbeatState.last_progress_event_at;
      if (stallMs >= 45000 && heartbeatState.last_stall_level !== 'hard') {
        heartbeatState.last_stall_level = 'hard';
        sseEvent('heartbeat', {
          state: 'stalled',
          level: 'hard',
          message: 'No progress event for 45s. Route may be stuck.',
          ...heartbeatState,
        });
      } else if (stallMs >= 20000 && heartbeatState.last_stall_level === '') {
        heartbeatState.last_stall_level = 'soft';
        sseEvent('heartbeat', {
          state: 'stalled',
          level: 'soft',
          message: 'Still working... retrying/continuing.',
          ...heartbeatState,
        });
      }
    }, 5000);
  }

  function sseEvent(type: string, data: object) {
    if (type !== 'heartbeat') {
      const now = Date.now();
      if (type === 'tool_call') {
        heartbeatState.last_tool_call_at = now;
        heartbeatState.current_step = 'tool_call';
      } else if (type === 'tool_result') {
        heartbeatState.current_step = 'tool_result';
      } else if (type === 'synthesizing') {
        heartbeatState.current_step = 'synthesizing';
      } else if (type === 'step') {
        heartbeatState.current_step = 'step';
      } else if (type === 'info') {
        heartbeatState.current_step = 'info';
      }
      heartbeatState.last_progress_event_at = now;
      heartbeatState.last_stall_level = '';
    }
    if (executionSessionState?.currentTurnExecution) {
      const payload = data as any;
      if (type === 'tool_call') {
        setTurnExecutionStepStatus(executionSessionState, 'select_targets', 'done', {
          selected_by: 'deterministic_or_router',
        }, false);
        setTurnExecutionStepStatus(executionSessionState, 'execute_changes', 'running', {}, false);
        appendTurnExecutionToolCall(executionSessionState, {
          stepType: 'execute_changes',
          toolName: String(payload?.action || 'tool'),
          args: payload?.params || {},
          status: 'running',
          phase: 'call',
        }, false);
        executionSessionState.updatedAt = Date.now();
        persistAgentSessionState(executionSessionState);
        appendDecisionTraceEvent(executionSessionState, 'execution', 'Tool call started.', {
          action: String(payload?.action || 'tool'),
          params: payload?.params || {},
          stepNum: Number(payload?.stepNum || 0) || undefined,
        }, false);
      } else if (type === 'tool_result') {
        const text = String(payload?.result || '');
        const isErr = /^ERROR:/i.test(text);
        appendTurnExecutionToolCall(executionSessionState, {
          stepType: 'execute_changes',
          toolName: String(payload?.action || 'tool'),
          args: {},
          resultSummary: text,
          status: isErr ? 'error' : 'ok',
          phase: 'result',
        }, false);
        if (isErr) {
          setTurnExecutionStepStatus(executionSessionState, 'execute_changes', 'failed', {
            last_error: text.slice(0, 220),
          }, false);
          setTurnExecutionStatus(executionSessionState, 'failed', false);
        }
        appendDecisionTraceEvent(executionSessionState, 'execution', isErr ? 'Tool call failed.' : 'Tool call succeeded.', {
          action: String(payload?.action || 'tool'),
          result: text.slice(0, 240),
          stepNum: Number(payload?.stepNum || 0) || undefined,
        }, false);
        executionSessionState.updatedAt = Date.now();
        persistAgentSessionState(executionSessionState);
      } else if (type === 'info') {
        const msg = String(payload?.message || '');
        if (/verify|verification|checking/i.test(msg)) {
          setTurnExecutionStatus(executionSessionState, 'verifying', false);
          setTurnExecutionStepStatus(executionSessionState, 'verify_outcome', 'running', {
            hint: msg.slice(0, 180),
          }, false);
          persistAgentSessionState(executionSessionState);
        }
      }
    }
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  let lastThinkingFingerprint = '';
  function emitThinking(thinking: string, phase?: string, stepNum?: number) {
    if (!wantsSSE) return;
    const text = String(thinking || '').trim();
    if (!text) return;
    const fingerprint = `${String(phase || 'general')}|${Number(stepNum || 0)}|${text}`;
    if (fingerprint === lastThinkingFingerprint) return;
    lastThinkingFingerprint = fingerprint;
    const payload: any = { thinking: text };
    if (phase) payload.phase = phase;
    if (Number.isFinite(stepNum as number) && Number(stepNum) > 0) payload.stepNum = Number(stepNum);
    sseEvent('thinking', payload);
  }

  function emitDecisionThinkingFromStep(step: any, phase = 'execute_decision') {
    const stepThinking = String(step?.thinking || '').trim();
    if (stepThinking) return;
    const thought = String(step?.thought || '').trim();
    const action = String(step?.action || '').trim();
    if (!thought || !action) return;
    const stepNum = Number(step?.stepNum || 0);
    emitThinking(thought, phase, Number.isFinite(stepNum) && stepNum > 0 ? stepNum : undefined);
  }

  function buildFallbackPostExecuteChat(executionReply: string, steps: any[]): string {
    const cleanReply = String(executionReply || '').trim();
    const oneLineReply = cleanReply.replace(/\s+/g, ' ').trim();
    const looksLikeRawJson = /^[\[{].*[\]}]$/s.test(oneLineReply);
    if (oneLineReply && !looksLikeRawJson) {
      const clipped = oneLineReply.slice(0, 180);
      return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
    }
    const actions = Array.from(new Set((Array.isArray(steps) ? steps : [])
      .map((s: any) => String(s?.action || '').trim())
      .filter(Boolean))).slice(0, 3);
    if (actions.length === 1) {
      return `Done. I ran ${actions[0]} and included the result above.`;
    }
    if (actions.length > 1) {
      return `Done. I ran ${actions.join(', ')} and included the result above.`;
    }
    return 'Done. I completed the request and included the result above.';
  }

  async function sseDone(reply: string, steps: any[]) {
    let finalReply = String(reply || '').trim();
    const stepThinking = (Array.isArray(steps) ? steps : [])
      .map((s: any) => String(s?.thinking || '').trim())
      .filter(Boolean)
      .join('\n');
    const executeSignals = parseExecuteControlSignals(finalReply, stepThinking);
    const openConfirmRequested = executeSignals.open_confirm;
    if (openConfirmRequested) {
      finalReply = executeSignals.cleaned_reply;
    }
    const artifacts = buildTurnArtifactsFromSteps(steps);
    if (stagedTriggerSwitch && stagedDiscussDraftReply) {
      const sections: string[] = [];
      sections.push(`Initial chat:\n${stagedDiscussDraftReply.trim()}`);
      if (finalReply) sections.push(`Execution result:\n${finalReply}`);
      const stepList = Array.isArray(steps) ? steps : [];
      if (!openConfirmRequested) {
        let post = '';
        if (FEATURE_FLAGS.model_trigger_post_exec_chat_finalize && postExecChatFinalizeFn) {
          try {
            post = String(await postExecChatFinalizeFn(finalReply, stepList) || '').trim();
          } catch {
            // non-fatal; fall through to deterministic fallback final chat
          }
        }
        if (!post) {
          post = buildFallbackPostExecuteChat(finalReply, stepList);
          if (wantsSSE) {
            sseEvent('info', { message: 'Post-execute finalize returned empty; using fallback final chat summary.' });
          }
        }
        if (post) {
          // Check if the finalize response contains open_tool — model wants to
          // self-correct or continue. Trigger the same re-entry path as discuss.
          const postSignals = parsePlanSignals(post, '');
          if (postSignals.open_tool) {
            if (wantsSSE) sseEvent('info', { message: 'Post-exec finalize emitted open_tool — re-entering execute for self-correction.' });
            // Strip open_tool from the display text
            const cleanedPost = post.replace(/\bopen[_\s-]?tool\b/gi, '').trim();
            if (cleanedPost) sections.push(`Final chat:\n${cleanedPost}`);
            // Re-stage trigger to loop back into execute
            stagedDiscussDraftReply = cleanedPost || stagedDiscussDraftReply;
            stagedTriggerSwitch = { mode: 'execute', token: 'open_tool', source: 'response' };
            isContinuationReentry = true;
            continuationPending = true;
          } else {
            sections.push(`Final chat:\n${post}`);
          }
        }
      }
      finalReply = sections.filter(Boolean).join('\n\n---\n\n');
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (!hasFinalizedTurnExecution && executionSessionState?.currentTurnExecution) {
      const cur = executionSessionState.currentTurnExecution;
      const failedByReply = isFailureLikeFinalReply(finalReply);
      const failedByNoToolExecute = !openConfirmRequested
        && cur.mode === 'execute'
        && (!Array.isArray(cur.tool_calls) || cur.tool_calls.length === 0)
        && !cur.verification;
      const keep: TurnExecutionStatus =
        cur.status === 'failed'
          ? 'failed'
          : (failedByReply || failedByNoToolExecute)
            ? 'failed'
            : (cur.status === 'repaired' ? 'repaired' : 'done');
      finalizeCurrentTurnExecution(executionSessionState, keep, finalReply || '');
      const learningSessionId = String(executionSessionState.sessionId || '').trim()
        || String(sessionId || '').trim()
        || `sess_${turnId.slice(0, 8)}`;
      const learning = recordSelfLearningTurn(cur, keep, {
        sessionId: learningSessionId,
        turnId,
        userMessage: executionObjectiveForTurn,
        triggerToken: stagedTriggerSwitch?.token || '',
      });
      if (wantsSSE) {
        sseEvent('info', {
          message: `Self-learning: status=${keep}, repairs=${learning.pattern.repaired_successes}, failures=${learning.pattern.failures}${learning.promoteReady ? ' (promotion ready)' : ''}`,
        });
      }
      const shouldAutoPromoteSkill = keep === 'repaired' && (learning.promoteReady || learning.correctionRepair);
      if (shouldAutoPromoteSkill) {
        const autoSkill = maybeWriteAutoRepairSkill(executionSessionState, cur, keep);
        if (autoSkill.written) {
          markSelfLearningPromotion(learning.key, String(autoSkill.skillId || ''));
          executionSessionState.updatedAt = Date.now();
          persistAgentSessionState(executionSessionState);
          if (wantsSSE) {
            sseEvent('info', {
              message: `Self-heal learned a new skill from this repaired turn: ${autoSkill.skillId}`,
            });
          }
        }
      }
      const hasMatchingInProgressTask = Array.isArray(executionSessionState.tasks)
        && executionSessionState.tasks.some((t) =>
          t.status === 'in_progress'
          && normalizeTaskTitleForMatch(String(t.title || '')) === normalizeTaskTitleForMatch(buildTurnTaskTitle(executionObjectiveForTurn)));
      if (!openConfirmRequested && (cur.mode === 'execute' || hasMatchingInProgressTask)) {
        completeTaskForTurn(executionSessionState, executionObjectiveForTurn, keep === 'failed' ? 'failed' : 'done');
        executionSessionState.updatedAt = Date.now();
        persistAgentSessionState(executionSessionState);
      }
      if (openConfirmRequested) {
        const question = executeSignals.confirm_question || 'This action is destructive. Do you want me to continue? Reply yes or no.';
        executionSessionState.pendingConfirmation = {
          id: randomUUID().slice(0, 8),
          requested_at: Date.now(),
          source_turn_id: turnId,
          question,
          original_user_message: normalizedMessage,
          resume_message: executionObjectiveForTurn,
        };
        executionSessionState.mode = 'discuss';
        executionSessionState.updatedAt = Date.now();
        persistAgentSessionState(executionSessionState);
        if (wantsSSE) {
          sseEvent('info', { message: 'Confirmation required before destructive action. Switched execute -> discuss.' });
          sseEvent('agent_mode', {
            mode: 'discuss',
            route_target: 'discuss',
            switched_from: 'execute',
            switched_by: 'model_trigger',
            trigger: 'open_confirm',
            turnKind: 'discuss',
          });
        }
      }
      if (FEATURE_FLAGS.model_trigger_mode_switch) {
        const previousMode = executionSessionState.mode;
        executionSessionState.mode = 'discuss';
        executionSessionState.updatedAt = Date.now();
        persistAgentSessionState(executionSessionState);
        if (wantsSSE && !openConfirmRequested && previousMode !== 'discuss') {
          sseEvent('agent_mode', {
            mode: 'discuss',
            route_target: 'discuss',
            switched_from: 'execute',
            switched_by: 'execute_complete',
            trigger: 'auto_finalize',
            turnKind: 'discuss',
          });
        }
      }
      hasFinalizedTurnExecution = true;
      if (wantsSSE) sseEvent('turn_execution_updated', { execution: executionSessionState.currentTurnExecution });
    }
    // ── Continuation loop check ──────────────────────────────────────────────
    // If there are pending tasks, we haven't hit max depth, the last execute
    // produced results (not blocked/failed), and confirmation isn't pending —
    // re-enter a compact discuss pass instead of sending the reply to the user.
    const canContinue = (
      FEATURE_FLAGS.continuation_loop
      && !openConfirmRequested
      && executionSessionState !== null
      && executionSessionState.tasks.length > 0
      && executionSessionState.tasks.some(t => t.status === 'pending' || t.status === 'in_progress')
      && executionSessionState.continuationDepth < EXEC_LIMITS.max_continuation_depth
      && !isFailureLikeFinalReply(finalReply)
      && !/^\s*BLOCKED\b/i.test(finalReply)
    );

    if (canContinue && executionSessionState) {
      const state = executionSessionState;

      // Stall detection: if task snapshot hasn't changed since last cycle, abort loop
      const currentSnapshot = state.tasks.map(t => `${t.model_task_id}:${t.status}`).join(',');
      if (currentSnapshot === state.continuationLastTaskSnapshot) {
        if (wantsSSE) sseEvent('info', { message: 'Continuation loop: stall detected (no task progress). Exiting loop.' });
      } else {
        // Set origin message on first continuation
        if (!state.continuationOriginMessage) {
          state.continuationOriginMessage = executionObjectiveForTurn;
        }
        state.continuationLastTaskSnapshot = currentSnapshot;
        state.continuationDepth += 1;
        state.updatedAt = Date.now();
        persistAgentSessionState(state);

        const pendingTasks = state.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
        if (wantsSSE) {
          sseEvent('info', {
            message: `Continuation loop: depth ${state.continuationDepth}/${EXEC_LIMITS.max_continuation_depth} — ${pendingTasks.length} task(s) remaining.`,
          });
        }

        try {
          const contSystemPrompt = continuationSystemPrompt || 'You are LocalClaw. Be concise.';
          const { reply: contReply, thinking: contThinking } = await runContinuationDiscussPass(
            getOllamaClient(),
            state,
            finalReply,
            contSystemPrompt,
          );

          if (contThinking) emitThinking(contThinking, 'continuation_discuss');
          if (wantsSSE) sseEvent('info', { message: `Continuation discuss reply: ${contReply.slice(0, 120)}` });

          // Parse plan signals from the continuation reply to update task statuses
          const contSignals = parsePlanSignals(contReply, contThinking);
          applyPlanSignalsToSession(state, contSignals, '');

          // Check if model wants to continue (open_tool present) or is done (plan_done / no open_tool)
          const wantsContinue = contSignals.open_tool || contSignals.task_continue_ids.length > 0;
          const isDone = contSignals.plan_done
            || !state.tasks.some(t => t.status === 'pending' || t.status === 'in_progress');

          if (wantsContinue && !isDone) {
            // Model says continue — re-stage a trigger switch back into execute
            stagedDiscussDraftReply = '';
            stagedTriggerSwitch = { mode: 'execute', token: 'open_tool', source: 'response' };
            stagedTriggerThinking = contThinking;
            isContinuationReentry = true;
            hasFinalizedTurnExecution = false;
            // The next task description becomes the new execution objective
            const nextTask = state.tasks.find(t => t.status === 'pending' || t.status === 'in_progress');
            if (nextTask) {
              executionObjectiveForTurn = `${state.continuationOriginMessage} — continue with: ${nextTask.title}`;
            }
            // agentIntent/turnKind are set by the pipeline at next do-loop iteration via isContinuationReentry
            confirmationApprovedForTurn = false;
            if (wantsSSE) {
              sseEvent('agent_mode', {
                mode: 'execute',
                route_target: 'execute',
                switched_from: 'discuss',
                switched_by: 'continuation_loop',
                trigger: 'open_tool',
                depth: state.continuationDepth,
              });
            }
            // Signal that sseDone should re-enter the execute path next cycle.
            // The outer request handler loop will pick this up.
            continuationPending = true;
            return; // exit sseDone without sending to client — outer loop continues
          } else {
            // Model says done — use its completion summary as final reply
            const cleanedContReply = contReply
              .replace(/\bopen_tool\b/gi, '')
              .replace(/\bplan_done\b/gi, '')
              .replace(/\btask_done:[A-Z0-9_-]+\b/gi, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            state.continuationDepth = 0;
            state.continuationOriginMessage = '';
            state.continuationLastTaskSnapshot = '';
            state.updatedAt = Date.now();
            persistAgentSessionState(state);
            finalReply = cleanedContReply || finalReply;
            if (wantsSSE) sseEvent('info', { message: `Continuation loop complete. All tasks done.` });
          }
        } catch (contErr: any) {
          // Non-fatal: if continuation pass errors, just send what we have
          console.warn('[continuation] Error in continuation discuss pass:', String(contErr?.message || contErr));
          if (wantsSSE) sseEvent('info', { message: 'Continuation loop error; returning current result.' });
        }
      }
    } else if (executionSessionState && executionSessionState.continuationDepth > 0) {
      // Loop just finished naturally — reset depth
      executionSessionState.continuationDepth = 0;
      executionSessionState.continuationOriginMessage = '';
      executionSessionState.continuationLastTaskSnapshot = '';
      executionSessionState.updatedAt = Date.now();
      persistAgentSessionState(executionSessionState);
    }
    // ────────────────────────────────────────────────────────────────────────

    if (wantsSSE) {
      sseEvent('done', { reply: finalReply, steps, artifacts, mode: effectiveUseTools ? 'agentic' : 'chat' });
      res.end();
    } else {
      res.json({ reply: finalReply, steps, artifacts, mode: effectiveUseTools ? 'agentic' : 'chat' });
    }
  }

  if (wantsSSE) sseSetup();

  try {
    const ollama = getOllamaClient();
    const incomingSid = typeof sessionId === 'string' ? sessionId.trim() : '';
    const sid = incomingSid || `sess_${randomUUID()}`;
    if (!incomingSid && wantsSSE) {
      sseEvent('info', { message: `No session id provided. Using isolated session ${sid.slice(0, 12)}...` });
    }
    const agentPolicy = getAgentPolicy();
    const sessionState = getAgentSessionState(sid);
    executionSessionState = sessionState;
    const failureCounts: Record<string, number> = {};
    const recordTurnFailure = (kind: string, details?: any) => {
      failureCounts[kind] = (failureCounts[kind] || 0) + 1;
      recordAgentFailure(sid, turnId, kind, { ...(details || {}), count: failureCounts[kind] });
      if (wantsSSE) sseEvent('failure', { kind, details: details || {}, count: failureCounts[kind], turnId });
    };
    postExecChatFinalizeFn = async (executionReply: string, steps: any[]): Promise<string> => {
      const conciseStepSummary = (Array.isArray(steps) ? steps : [])
        .slice(0, 5)
        .map((s: any) => {
          const action = String(s?.action || '').trim();
          const result = String(s?.toolResult || '').replace(/\s+/g, ' ').trim().slice(0, 140);
          return action ? `${action}: ${result}` : '';
        })
        .filter(Boolean)
        .join('\n');

      // Use the same soul/personality + context as the discuss/chat pass so the
      // finalize response matches the tone, style, and awareness of the initial chat.
      // This also allows the model to emit open_tool for continuation if the task
      // failed or is incomplete — the trigger system detects it just like in discuss.
      const soulPrompt = continuationSystemPrompt || 'You are LocalClaw, a helpful local AI assistant. Be direct and conversational.';
      const verified = buildVerifiedFactsHeader(sessionState);
      const planContext = buildPlanContext(sessionState);
      const historyText = summarizeHistoryForPrompt(history || [], 4);
      const recentToolContext = buildRecentToolActionsContext(sessionState, 2, 3);

      const prompt = [
        `You are LocalClaw. You just executed tools for the user's request. Now respond.`,
        `RULES:`,
        `1. If the task completed successfully: respond with the result conversationally.`,
        `2. If the task failed or is incomplete: write open_tool somewhere in your reply to go back and fix/continue.`,
        `3. open_tool is just a word — writing it does NOT execute anything. The backend reads it and switches mode.`,
        `4. Do not claim actions you did not perform.`,
        `5. Default to 1-3 sentences unless the user asked for depth.`,
        verified,
        planContext ? `Current plan state:\n${planContext}` : '',
        recentToolContext ? `Recent tool actions:\n${recentToolContext}` : '',
        historyText ? `Recent conversation:\n${historyText}` : '',
        `User request: ${executionObjectiveForTurn}`,
        `Execution result: ${String(executionReply || '').trim()}`,
        conciseStepSummary ? `Tool steps:\n${conciseStepSummary}` : '',
        `Assistant:`,
      ].filter(Boolean).join('\n\n');

      try {
        const out = await ollama.generateWithRetryThinking(prompt, 'executor', {
          temperature: 0.25,
          system: soulPrompt,
          num_ctx: SMALL_MODEL_TUNING.chat_num_ctx,
          num_predict: SMALL_MODEL_TUNING.chat_num_predict,
          think: SMALL_MODEL_TUNING.chat_think,
        });
        const { cleaned, inlineThinking } = stripThinkTags(out.response || '');
        const finalizeThinking = mergeThinking(out.thinking || '', inlineThinking);
        if (finalizeThinking) emitThinking(finalizeThinking, 'post_execute_finalize');
        const result = stripProtocolArtifacts(String(cleaned || '')).trim();

        // If the model produced something usable, return it.
        // Otherwise fall back to a deterministic summary.
        if (result && !/^\s*BLOCKED\b/i.test(result)) return result;
      } catch (err: any) {
        console.warn(`[post-exec-finalize] LLM call failed: ${err?.message || err}`);
      }

      // Deterministic fallback if the LLM call failed or produced nothing
      return buildFallbackPostExecuteChat(executionReply, steps);
    };
    const resolveContradictionTiered = async (draft: string, userMessageForQuery: string): Promise<string> => {
      const contradiction = contradictsVerifiedFacts(draft, sessionState);
      if (!contradiction.hit) return draft;
      const fact = contradiction.fact || {};
      const tier = contradictionTierForFact(fact);
      if (wantsSSE) sseEvent('info', { message: `Consistency lock: ${contradiction.reason || 'reply contradicted verified fact'} (tier ${tier})` });
      if (tier === 1) return buildConsistencyLockedReply(sessionState);

      const baseQ = String(fact.question || sessionState.lastEvidence?.question || userMessageForQuery || fact.claim_text || '').trim();
      if (!baseQ) return buildConsistencyLockedReply(sessionState);
      const normalized = normalizeUserRequest(baseQ);
      const policy = decideRoute(normalized);
      const expectedCountry = policy.expected_country || (String(fact.fact_type || '').toLowerCase() === 'office_holder' ? 'United States' : undefined);
      const expectedKeywords = policy.expected_keywords?.length ? policy.expected_keywords : (expectedCountry ? ['United States', 'White House'] : []);
      const query = buildSearchQuery({
        normalized,
        domain: (policy.domain !== 'generic' ? policy.domain : String(fact.fact_type || 'generic') as DomainType),
        scope: { country: expectedCountry, domain: (policy.domain !== 'generic' ? policy.domain : undefined) },
        expected_keywords: expectedKeywords,
      });
      const params = { query, max_results: 5 };
      const stepNum = 1;
      if (wantsSSE) {
        sseEvent('ui_preflight', { message: buildPreflightStatusMessage('web_search', String(policy.domain || '')) });
        sseEvent('tool_call', { action: 'web_search', params, stepNum, thought: 'Consistency tier-2 auto re-verify.' });
      }
      logToolAudit({ type: 'tool_call', action: 'web_search', params, thought: 'Consistency tier-2 auto re-verify.', stepNum });
      const exec = await executeWebSearchWithSanity(params, {
        expectedCountry,
        expectedKeywords,
        expectedEntityClass: policy.expected_entity_class || String(fact.fact_type || ''),
        onInfo: (msg, meta) => {
          if (wantsSSE) sseEvent('info', { message: msg, ...meta });
        },
      });
      const toolRes = exec.toolRes;
      const text = toolRes.success ? (toolRes.stdout || JSON.stringify(toolRes.data || {})) : `ERROR: ${toolRes.error}`;
      if (wantsSSE) sseEvent('tool_result', { action: 'web_search', result: text, stepNum, diagnostics: (toolRes.data as any)?.search_diagnostics });
      logToolAudit({ type: 'tool_result', action: 'web_search', result: text, stepNum });
      if (!toolRes.success) return buildConsistencyLockedReply(sessionState);

      const extracted = buildEvidenceReplyFromToolData(toolRes.data)
        || extractCurrentSentence(baseQ, text)
        || extractCurrentSentence(userMessageForQuery, text)
        || (String(text).match(/^Answer:\s*(.+)$/im)?.[1]?.trim() || '');
      if (!extracted) return buildConsistencyLockedReply(sessionState);

      rememberVerifiedFact(sessionState, {
        key: String(fact.key || `vf:${normalizeFactKey(baseQ)}`),
        value: extractPrimaryDateToken(extracted) || extracted.slice(0, 120),
        claim_text: extracted,
        sources: Array.from(String(text).matchAll(/https?:\/\/[^\s)]+/g)).map(m => m[0]).slice(0, 3),
        ttl_minutes: isMustVerifyDomain(String(fact.fact_type || policy.domain)) ? 240 : 720,
        confidence: 0.85,
        fact_type: (isMustVerifyDomain(String(fact.fact_type || policy.domain)) ? String(fact.fact_type || policy.domain) : 'generic') as any,
        requires_reverify_on_use: isMustVerifyDomain(String(fact.fact_type || policy.domain)),
        question: baseQ,
      });
      sessionState.updatedAt = Date.now();
      persistAgentSessionState(sessionState);
      return extracted;
    };
    if (!sessionState.modeLock) {
      sessionState.modeLock = useTools ? 'agent' : 'chat';
      sessionState.updatedAt = Date.now();
      persistAgentSessionState(sessionState);
    }
    effectiveUseTools = sessionState.modeLock === 'agent';
    if (wantsSSE) sseEvent('session_mode_locked', { sessionId: sid, mode: sessionState.modeLock });
    let turnInputMessage = normalizedMessage;
    const pendingConfirmation = sessionState.pendingConfirmation;
    if (pendingConfirmation) {
      const decision = parseBinaryConfirmationDecision(normalizedMessage);
      if (decision === 'approve') {
        turnInputMessage = pendingConfirmation.resume_message || pendingConfirmation.original_user_message || normalizedMessage;
        // Hard-lock this turn to execute so confirmation resumes mutation flow
        // instead of being reclassified back to discuss.
        confirmationApprovedForTurn = true;
        forcedMode = 'execute';
        sessionState.mode = 'execute';
        sessionState.pendingConfirmation = undefined;
        sessionState.updatedAt = Date.now();
        persistAgentSessionState(sessionState);
        if (wantsSSE) {
          sseEvent('info', { message: 'Confirmation received. Resuming execute flow.' });
        }
      } else if (decision === 'reject') {
        sessionState.pendingConfirmation = undefined;
        sessionState.updatedAt = Date.now();
        persistAgentSessionState(sessionState);
        return sseDone('Understood. I will not run that destructive action.', []);
      } else {
        const looksLikeNewTask = hasConcreteTaskVerb(normalizedMessage) || isLikelyToolDirective(normalizedMessage) || isQuestionLike(normalizedMessage);
        if (!looksLikeNewTask) {
          const q = pendingConfirmation.question || 'This action is destructive. Do you want me to continue?';
          return sseDone(`${q} Reply yes or no.`, []);
        }
        sessionState.pendingConfirmation = undefined;
        sessionState.updatedAt = Date.now();
        persistAgentSessionState(sessionState);
        if (wantsSSE) sseEvent('info', { message: 'Pending confirmation cleared due to new request.' });
      }
    }
    executionObjectiveForTurn = turnInputMessage;
    const mustUseToolsThisTurn =
      forcedMode === 'execute'
      || (forcedMode !== 'discuss' && requiresToolExecutionForTurn(turnInputMessage, sessionState));
    if (!effectiveUseTools && mustUseToolsThisTurn) {
      effectiveUseTools = true;
      if (wantsSSE) sseEvent('info', { message: 'Tool-required request detected; executing with tools for this turn.' });
    }
    const memoryInstruction = parseMemoryInstruction(turnInputMessage);
    if (memoryInstruction) {
      try {
        const result = await addMemoryFact({
          fact: memoryInstruction.fact,
          key: memoryInstruction.key,
          action: memoryInstruction.action,
          scope: 'session',
          session_id: sid,
          workspace_id: computeWorkspaceId(),
          agent_id: 'main',
          confidence: 1,
          actor: 'user',
          source_kind: 'user',
          source_ref: `user:${turnId}`,
          source_tool: 'user_message',
          source_output: turnInputMessage,
          type: 'fact',
        });
        const reply = result.success
          ? `Got it. I updated memory${memoryInstruction.key ? ` (${memoryInstruction.key})` : ''}.`
          : `I tried to update memory but failed: ${result.message || 'unknown error'}`;
        if (wantsSSE) sseEvent('memory_saved', { ok: result.success, key: memoryInstruction.key, fact: memoryInstruction.fact });
        return sseDone(reply, []);
      } catch (err: any) {
        const em = err?.message || String(err);
        if (wantsSSE) sseEvent('error', { message: `Memory update failed: ${em}` });
        return sseDone(`I couldn't update memory: ${em}`, []);
      }
    }

    if (effectiveUseTools) {
      // Continuation loop: wraps the pipeline + routing so that after sseDone
      // sets continuationPending=true, we re-enter directly into execute mode
      // without going back to the client.
      continuationLoop: do {
        continuationPending = false; // reset at top of each iteration

      const pipeline = isContinuationReentry
        // On continuation re-entry: synthesize a minimal pipeline result pointing to execute
        ? {
            routingMessage: executionObjectiveForTurn,
            turnPlan: null,
            policyDecision: { locked_by_policy: false, tool: null, params: {}, domain: 'generic' as DomainType, lock_reason: '', requires_verification: false, provenance: 'fallback_repair' as const, expected_keywords: [] },
            freshnessQuery: false,
            freshnessMustUseWeb: false,
            turnKind: 'side_question' as const,
            agentIntent: 'execute' as const,
          }
        : await runTurnPipeline({
            ollama,
            normalizedMessage: turnInputMessage,
            forcedMode,
            sessionState,
            history: history || [],
            agentPolicy,
            wantsSSE,
            sseEvent,
          });
      let routingMessage = pipeline.routingMessage;
      const turnPlan = pipeline.turnPlan;
      let policyDecision = pipeline.policyDecision;
      const freshnessQuery = pipeline.freshnessQuery;
      const freshnessMustUseWeb = pipeline.freshnessMustUseWeb;
      let turnKind = pipeline.turnKind;
      let agentIntent = pipeline.agentIntent;

      // Promotion gate: even if classified as discuss, allow immediate escalation
      // to execute when natural-language routing indicates tool need.
      if (!FEATURE_FLAGS.model_trigger_mode_switch && agentIntent === 'discuss' && agentPolicy.natural_language_tool_router) {
        const discussSubmodePre = inferDiscussSubmode(executionObjectiveForTurn, history || []);
        const lockDiscussChatPre = discussSubmodePre === 'chat' || isConversationIntent(executionObjectiveForTurn) || isReactionLikeMessage(executionObjectiveForTurn);
        if (!lockDiscussChatPre) {
          const routed = await inferNaturalToolIntent(ollama, routingMessage, sessionState, history || [], policyDecision);
          if (routed && (routed.confidence >= routerConfidenceThreshold(routingMessage) || isLikelyToolDirective(routingMessage) || freshnessQuery)) {
            agentIntent = 'execute';
            turnKind = 'side_question';
            if (wantsSSE) sseEvent('info', { message: `Auto-promoted to execute via NL router (${routed.reason}).` });
          }
        }
      }

      updateSessionPlanFromUser(sessionState, executionObjectiveForTurn, agentIntent, turnKind);
      const selectedSkillSlugs = selectSkillSlugsForMessage(routingMessage, 2);
      const turnExecution = beginTurnExecution(sessionState, {
        objectiveRaw: executionObjectiveForTurn,
        objectiveNormalized: routingMessage,
        mode: agentIntent,
        turnKind,
      });
      appendDecisionTraceEvent(sessionState, 'routing', 'Turn routed.', {
        mode_lock: sessionState.modeLock || 'unlocked',
        forced_mode: forcedMode || null,
        agent_intent: agentIntent,
        turn_kind: turnKind,
        policy_locked: !!policyDecision.locked_by_policy,
      }, false);
      const clauseSplit = splitInstructionClauses(String(routingMessage || ''));
      appendDecisionTraceEvent(sessionState, 'clause_split', `Detected ${clauseSplit.length} clause(s).`, {
        clauses: clauseSplit.slice(0, 12),
      }, false);
      if (selectedSkillSlugs.length > 0) {
        appendDecisionTraceEvent(sessionState, 'routing', `Selected ${selectedSkillSlugs.length} skill(s) for this turn.`, {
          skills: selectedSkillSlugs,
        }, false);
      }
      persistAgentSessionState(sessionState);
      if (wantsSSE) sseEvent('agent_mode', { mode: agentIntent, sessionId: sid, turnKind });
      if (wantsSSE) sseEvent('turn_execution_created', { execution: turnExecution });

      // Provenance follow-up: answer from last tool-backed evidence directly.
      if (isSourceFollowUp(executionObjectiveForTurn) && sessionState.lastEvidence) {
        const ev = sessionState.lastEvidence;
        const sources = ev.topSources.slice(0, 3);
        const tools = ev.tools.length ? ev.tools.join(', ') : 'none';
        const summary = ev.answer_summary ? `Summary: ${ev.answer_summary}\n` : '';
        const reply = sources.length
          ? `${summary}I got that from tool output (${tools}) for: "${ev.question}". Top sources:\n${sources.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
          : `${summary}I got that from tool output (${tools}) for: "${ev.question}".`;
        return sseDone(reply, []);
      }

      // Discuss / Plan mode in agent toggle: no tool calls, keep conversation natural
      if (agentIntent !== 'execute') {
        const scopedMem = buildScopedMemoryInstruction(executionObjectiveForTurn, sid, freshnessQuery);
        const systemPrompt = buildSystemPrompt({
          includeSkillSlugs: selectedSkillSlugs,
          includeMemory: !freshnessQuery,
          extraInstructions: [getRuntimeFreshnessInstruction(), scopedMem].filter(Boolean).join('\n\n'),
        });
        // Stash system prompt so continuation passes can reuse it without rebuilding
        if (!continuationSystemPrompt) continuationSystemPrompt = systemPrompt;
        const discussSubmode: DiscussSubmode = agentIntent === 'plan'
          ? 'coach'
          : inferDiscussSubmode(executionObjectiveForTurn, history || []);
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'running', {
          phase: 'discuss',
          submode: discussSubmode,
        }, false);
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'pending', {}, false);
        setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'pending', {}, false);
        persistAgentSessionState(sessionState);
        if (wantsSSE) sseEvent('info', { message: `Discuss submode: ${discussSubmode.toUpperCase()}` });
        const discussPrompt = discussSubmode === 'chat'
          ? buildChatReplyPrompt(executionObjectiveForTurn, sessionState, history || [])
          : buildCoachReplyPrompt(executionObjectiveForTurn, sessionState, history || []);
        const discussNumCtx = discussSubmode === 'chat'
          ? SMALL_MODEL_TUNING.chat_num_ctx
          : SMALL_MODEL_TUNING.discuss_num_ctx;
        const discussNumPredict = discussSubmode === 'chat'
          ? SMALL_MODEL_TUNING.chat_num_predict
          : SMALL_MODEL_TUNING.discuss_num_predict;
        const discussThink = discussSubmode === 'chat'
          ? SMALL_MODEL_TUNING.chat_think
          : SMALL_MODEL_TUNING.discuss_think;
        const discussPredictBudget = discussThink ? Math.max(discussNumPredict, 256) : discussNumPredict;
        const out = await ollama.generateWithRetryThinking(discussPrompt, 'executor', {
          temperature: 0.25,
          system: `${systemPrompt}\n\nYou are in discussion mode. Do not emit tool calls.`,
          num_ctx: discussNumCtx,
          num_predict: discussPredictBudget,
          think: discussThink,
        }, 1);
        const { cleaned, inlineThinking } = stripThinkTags(out.response);
        const thinking = mergeThinking(out.thinking || '', inlineThinking);
        const preStrip = String(cleaned || '').trim();
        let reply = stripProtocolArtifacts(preStrip).trim();
        if (!reply) {
          recordTurnFailure('empty_discuss_reply_after_strip', {
            pre_strip_len: preStrip.length,
            pre_strip_head: preStrip.slice(0, 180),
          });
          if (wantsSSE) sseEvent('info', { message: 'Discuss reply body was empty after cleanup; regenerating concise final reply.' });
          const retryOut = await ollama.generateWithRetryThinking(`User: ${executionObjectiveForTurn}\nAssistant:`, 'executor', {
            temperature: 0.2,
            system: 'Return one short, user-facing reply only. No reasoning. No tool calls. No protocol tags.',
            num_ctx: 1024,
            num_predict: 96,
            think: undefined,
          }, 1);
          const retryCleaned = stripThinkTags(retryOut.response).cleaned;
          reply = stripProtocolArtifacts(String(retryCleaned || '')).trim();
        }
        if (!reply) {
          reply = isGreetingOnlyMessage(executionObjectiveForTurn) || isReactionLikeMessage(executionObjectiveForTurn)
            ? 'Hey! I am here.'
            : 'I can help with that.';
        }
        reply = await repairTemporalContradiction(ollama, systemPrompt, executionObjectiveForTurn, reply);
        if (discussSubmode === 'chat') reply = enforceChatStyle(reply);
        if (discussSubmode === 'chat') reply = sanitizeDiscussReplyForNoToolClaims(reply);
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
          phase: 'discuss',
          submode: discussSubmode,
          reply_len: String(reply || '').length,
        }, false);
        const planSignals = parsePlanSignals(preStrip, thinking || '');
        const appliedPlan = applyPlanSignalsToSession(sessionState, planSignals, executionObjectiveForTurn);
        if (appliedPlan.summary.length && wantsSSE) {
          sseEvent('info', { message: `Plan signals: ${appliedPlan.summary.join(' | ')}` });
        }
        let modelTrigger = detectModelModeTrigger(preStrip, thinking || '');
        if (modelTrigger?.source === 'thinking') {
          // AI-first: if the model said open_tool in thinking, trust it — don't second-guess with
          // deterministic checks. Only suppress on clear greetings/reactions where no work is needed.
          const casual = isGreetingOnlyMessage(routingMessage) || isConversationIntent(routingMessage) || isReactionLikeMessage(routingMessage);
          if (casual) {
            modelTrigger = null;
          }
        }
        if (!modelTrigger && planSignals.open_web) {
          modelTrigger = { mode: 'web', token: 'open_web', source: 'response' };
        } else if (!modelTrigger && (planSignals.open_tool || planSignals.task_continue_ids.length > 0)) {
          modelTrigger = { mode: 'execute', token: 'open_tool', source: 'response' };
        }
        if (FEATURE_FLAGS.model_trigger_mode_switch && modelTrigger) {
          emitThinking(thinking, 'discuss_pre_switch');
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', {
            trigger: modelTrigger.token,
            source: modelTrigger.source,
            routed_to: modelTrigger.mode,
          }, false);
          setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'done', {
            mode_switch: `discuss->${modelTrigger.mode}`,
          }, false);
          stagedDiscussDraftReply = sanitizeStagedDiscussDraftReply(reply) || 'Got it - running that now.';
          stagedTriggerSwitch = modelTrigger;
          // Capture the thinking that triggered the switch so execute mode gets full context
          stagedTriggerThinking = String(thinking || '').slice(-1200).trim();
          agentIntent = 'execute';
          turnKind = 'side_question';
          if (sessionState.currentTurnExecution) {
            applyExecutionStepProfile(sessionState.currentTurnExecution, 'execute', 'side_question', { reactivateExecuteSteps: true });
            sessionState.currentTurnExecution.mode = 'execute';
            sessionState.currentTurnExecution.turn_kind = 'side_question';
            sessionState.currentTurnExecution.objective_normalized = routingMessage;
            sessionState.currentTurnExecution.updated_at = Date.now();
            sessionState.updatedAt = Date.now();
            persistAgentSessionState(sessionState);
            if (wantsSSE) sseEvent('turn_execution_updated', { execution: sessionState.currentTurnExecution });
          }
          if (wantsSSE) {
            sseEvent('info', {
              message: `Model trigger detected (${modelTrigger.token} from ${modelTrigger.source}). Switching discuss -> ${modelTrigger.mode}.`,
            });
            sseEvent('agent_mode', {
              mode: 'execute',
              route_target: modelTrigger.mode,
              switched_from: 'discuss',
              switched_by: 'model_trigger',
              trigger: modelTrigger.token,
              turnKind: 'side_question',
            });
          }
          appendDecisionTraceEvent(sessionState, 'routing', 'Model trigger forced mode switch from discuss.', {
            token: modelTrigger.token,
            source: modelTrigger.source,
            switched_to: modelTrigger.mode,
          }, false);
          if (modelTrigger.mode === 'web') {
            const forcedDomain: DomainType = policyDecision.domain === 'generic' ? 'breaking_news' : policyDecision.domain;
            const normalizedForced = normalizeUserRequest(routingMessage);
            const forcedQuery = buildSearchQuery({
              normalized: normalizedForced,
              domain: forcedDomain,
              scope: {
                country: policyDecision.expected_country,
                domain: forcedDomain,
              },
              expected_keywords: Array.isArray(policyDecision.expected_keywords) ? policyDecision.expected_keywords : [],
            });
            policyDecision = {
              ...policyDecision,
              tool: 'web_search',
              params: { query: forcedQuery || normalizedForced.search_text || routingMessage, max_results: 5 },
              locked_by_policy: true,
              lock_reason: `model_trigger:${modelTrigger.token}`,
              requires_verification: true,
              domain: forcedDomain,
              provenance: 'fallback_repair',
            };
          } else {
            policyDecision = {
              ...policyDecision,
              tool: null,
              locked_by_policy: false,
              lock_reason: '',
            };
          }
        } else {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', {
            trigger: 'none',
            source: 'none',
            routed_to: 'discuss',
          }, false);
          setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'skipped', {
            mode_switch: 'none',
          }, false);
          persistAgentSessionState(sessionState);
          emitThinking(thinking, 'discuss');
          const lockDiscussChat = discussSubmode === 'chat' || isConversationIntent(executionObjectiveForTurn) || isReactionLikeMessage(executionObjectiveForTurn);

          if (!FEATURE_FLAGS.model_trigger_mode_switch && !lockDiscussChat && agentPolicy.natural_language_tool_router && shouldPromoteDraftToExecute(routingMessage, reply)) {
            const routed = await inferNaturalToolIntent(ollama, routingMessage, sessionState, history || [], policyDecision);
            if (routed && (routed.confidence >= routerConfidenceThreshold(routingMessage) || isLikelyToolDirective(routingMessage) || needsDeterministicExecute(routingMessage, sessionState))) {
              const registry = getToolRegistry();
              const stepNum = 1;
              if (wantsSSE) sseEvent('info', { message: `Discuss draft promoted to execute (${routed.reason}).` });
              if (wantsSSE) {
                sseEvent('ui_preflight', { message: buildPreflightStatusMessage(routed.tool, String(policyDecision.domain || '')) });
                sseEvent('tool_call', { action: routed.tool, params: routed.params, stepNum, thought: `Promotion: ${routed.reason}` });
              }
              logToolAudit({ type: 'tool_call', action: routed.tool, params: routed.params, thought: `Promotion: ${routed.reason}`, stepNum });
              const webExec = routed.tool === 'web_search'
                ? await executeWebSearchWithSanity(routed.params, {
                  expectedCountry: policyDecision.expected_country,
                  expectedKeywords: policyDecision.expected_keywords,
                  expectedEntityClass: policyDecision.expected_entity_class,
                  onInfo: (msg, meta) => {
                    if (wantsSSE) sseEvent('info', { message: msg, ...meta });
                  },
                })
                : null;
              const toolRes = webExec ? webExec.toolRes : await registry.execute(routed.tool, routed.params);
              const text = toolRes.success
                ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
                : `ERROR: ${toolRes.error}`;
              if (wantsSSE) sseEvent('tool_result', {
                action: routed.tool,
                result: text,
                stepNum,
                diagnostics: (toolRes.data as any)?.search_diagnostics,
              });

              if (toolRes.success) {
                if (routed.tool === 'time_now') {
                  return sseDone(String(toolRes.stdout || '').trim() || String(toolRes.data?.iso || 'Current time retrieved.'), []);
                }
                const direct = String(text).match(/^Answer:\s*(.+)$/im)?.[1]?.trim();
                if (direct) return sseDone(direct, []);
                const extracted = extractCurrentSentence(executionObjectiveForTurn, text);
                if (extracted) return sseDone(extracted, []);
                const links = Array.from(String(text).matchAll(/https?:\/\/[^\s)]+/g)).slice(0, 3).map(m => m[0]);
                if (links.length) {
                  return sseDone(`I checked the web. Top sources:\n${links.map((u, i) => `${i + 1}. ${u}`).join('\n')}`, []);
                }
              }
            }
          }

          reply = await resolveContradictionTiered(reply, executionObjectiveForTurn);

          return sseDone(reply || 'I can help with that.', []);
        }
      }

      const reactor = getReactor(ollama);
      const allSteps: any[] = [];
      const maxToolsPerCycle = Math.max(1, Math.floor(Number(EXEC_LIMITS.max_tools_per_cycle || 3)));
      const maxCyclesPerTurn = Math.max(1, Math.floor(Number(EXEC_LIMITS.max_cycles_per_user_turn || 6)));
      const maxTotalToolsPerTurn = Math.max(maxToolsPerCycle, Math.floor(Number(EXEC_LIMITS.max_total_tools_per_turn || 18)));
      // Build execute brief: if this run was triggered from discuss mode, give the model
      // its own reasoning context so it knows exactly why it switched and what to do.
      const executeThinkingContext = stagedTriggerThinking
        ? `\n\nYour reasoning that triggered this mode switch:\n${stagedTriggerThinking}`
        : '';
      const executionInput = buildExecutionInput(
        routingMessage,
        sessionState,
        turnKind,
        executeThinkingContext,
        confirmationApprovedForTurn
      );
      const subQuestions = decomposeQuestion(routingMessage);
      const collectedFacts: string[] = [];
      let skipReactorLoop = false;
      setTurnExecutionStepStatus(sessionState, 'select_targets', 'running', {
        request: routingMessage.slice(0, 220),
      }, false);
      persistAgentSessionState(sessionState);

      // Natural-language tool router for small models:
      // decode messages like "use web", "look it up", "verify that" with context carryover.
      let preRoutedExecuted = false;
      let allowDeterministicFallback = FEATURE_FLAGS.deterministic_execute_fallback;
      // node_call execute: node_call<> is the primary channel; native-only strictly disabled deterministic fallbacks.
      const strictAINativeExecute = FEATURE_FLAGS.node_call_execute || FEATURE_FLAGS.execute_native_only_strict;
      if (strictAINativeExecute) {
        allowDeterministicFallback = false;
        if (wantsSSE) {
          sseEvent('info', { message: 'Execute mode: node_call<> channel active — AI writes Node.js directly, deterministic routes disabled.' });
        }
      }
      const workspaceListIntent = isWorkspaceListingRequest(routingMessage);
      const workspaceListFollowupIntent = isWorkspaceListingFollowupRequest(routingMessage, sessionState);
      const localExecuteRequest = (
        workspaceListIntent
        || workspaceListFollowupIntent
        || isFileOperationRequest(routingMessage)
        || isFileFollowupOperationRequest(routingMessage, sessionState)
        || isShellOperationRequest(routingMessage)
        || needsDeterministicExecute(routingMessage, sessionState)
      );
      const localExecuteActions = new Set([
        'list', 'read', 'write', 'edit', 'append', 'delete', 'rename', 'copy', 'mkdir', 'stat', 'shell',
      ]);
      const mutativeExecuteRequest = /\b(create|make|write|edit|update|append|delete|remove|rename|move|copy|set|change|modify|overwrite|replace)\b/i.test(routingMessage);
      const mutativeExecuteActions = new Set([
        'write', 'edit', 'append', 'delete', 'rename', 'copy', 'mkdir', 'shell',
      ]);
      const isFileOpTurnForSubsteps =
        isFileOperationRequest(routingMessage) || isFileFollowupOperationRequest(routingMessage, sessionState);

      // AI-first execute: run one reactor cycle before deterministic ladders.
      if (FEATURE_FLAGS.ai_first_execute_mode) {
        const usedBefore = countExecutedToolCalls(allSteps);
        const remainingTurnToolBudget = Math.max(0, maxTotalToolsPerTurn - usedBefore);
        const aiFirstBudget = Math.min(maxToolsPerCycle, remainingTurnToolBudget);
        let aiFirstSuccessfulToolResults = 0;
        let aiFirstRelevantSuccessfulToolResults = 0;
        if (aiFirstBudget > 0) {
          const aiFirstStepStartIndex = allSteps.length;
          appendDecisionTraceEvent(sessionState, 'selected_plan', 'AI-first execute cycle started before deterministic fallbacks.', {
            max_steps: aiFirstBudget,
            policy_locked: !!policyDecision.locked_by_policy,
            policy_tool: policyDecision.tool || null,
          }, false);
          persistAgentSessionState(sessionState);

          const onAiFirstStep = (step: any) => {
            allSteps.push(step);
            if (step?.thinking) {
              emitThinking(String(step.thinking), 'execute', Number(step.stepNum || 0) || undefined);
            }
            emitDecisionThinkingFromStep(step, 'execute_decision');
            if (step.isFormatViolation) {
              heartbeatState.format_violation_count += 1;
              heartbeatState.retry_count += 1;
              heartbeatState.last_progress_event_at = Date.now();
              if (wantsSSE) {
                sseEvent('heartbeat', {
                  state: 'retrying',
                  level: 'format_violation',
                  message: 'Format violation detected, retrying.',
                  ...heartbeatState,
                });
              }
              recordTurnFailure('format_violation', {
                stepNum: step.stepNum,
                thought: step.thought || '',
                action: step.action || '',
              });
            }
            if (step.action) {
              logToolAudit({ type: 'tool_call', action: step.action, params: step.params, thought: step.thought, stepNum: step.stepNum });
              if (wantsSSE) {
                sseEvent('ui_preflight', { message: buildPreflightStatusMessage(step.action === 'node_call' ? 'node_call' : step.action, '') });
                sseEvent('tool_call', { action: step.action, params: step.params, thought: step.thought, stepNum: step.stepNum });
              }
            }
            if (step.toolResult !== undefined) {
              const toolText = String(step.toolResult || '');
              if (toolText && !/^ERROR:/i.test(toolText)) {
                aiFirstSuccessfulToolResults += 1;
                const actionName = String(step.action || '').toLowerCase().trim();
                // node_call counts as relevant for both local and general tasks
                const actionRelevant = actionName === 'node_call'
                  ? true
                  : (localExecuteRequest
                    ? localExecuteActions.has(actionName)
                    : true);
                const countsAsRelevant = actionName === 'node_call'
                  ? true
                  : (mutativeExecuteRequest
                    ? mutativeExecuteActions.has(actionName)
                    : actionRelevant);
                if (countsAsRelevant) aiFirstRelevantSuccessfulToolResults += 1;
                collectedFacts.push(`Q: ${routingMessage}\nA: ${toolText}`);
              }
              logToolAudit({ type: 'tool_result', action: step.action, result: step.toolResult, stepNum: step.stepNum });
              try {
                // For node_call steps, parse sandbox result to update workspace state
                if (step.action === 'node_call') {
                  const toolResult = step.toolResult || '';
                  try {
                    const parsed = JSON.parse(toolResult);
                    if (Array.isArray(parsed)) {
                      for (const f of parsed) {
                        const fname = String(f || '').trim();
                        if (fname) rememberRecentFilePath(sessionState, path.join(config.workspace.path, fname));
                      }
                      sessionState.updatedAt = Date.now();
                      persistAgentSessionState(sessionState);
                    }
                  } catch { /* not JSON — that's fine */ }
                } else if (step.action === 'list') {
                  const toolData = (step as any)?.toolData || {};
                  const listedPathRaw = String(toolData.path || step.params?.path || '.').trim() || '.';
                  const listedBase = path.isAbsolute(listedPathRaw)
                    ? listedPathRaw
                    : path.resolve(config.workspace.path, listedPathRaw);
                  const listedFiles = Array.isArray(toolData.files)
                    ? toolData.files.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 80)
                    : [];
                  if (listedFiles.length) {
                    for (const fileName of listedFiles) {
                      const candidate = path.isAbsolute(fileName)
                        ? fileName
                        : path.join(listedBase, fileName);
                      rememberRecentFilePath(sessionState, candidate);
                    }
                    sessionState.updatedAt = Date.now();
                    persistAgentSessionState(sessionState);
                  }
                } else if (step.action === 'write') {
                  const p = String((step as any)?.toolData?.path || step.params?.path || '').trim();
                  if (p) {
                    rememberRecentFilePath(sessionState, p);
                    sessionState.updatedAt = Date.now();
                    persistAgentSessionState(sessionState);
                  }
                } else if (step.action === 'rename') {
                  const from = String(step.params?.path || '').trim();
                  const to = String((step as any)?.toolData?.to || step.params?.new_path || '').trim();
                  if (from) forgetRecentFilePath(sessionState, from);
                  if (to) {
                    rememberRecentFilePath(sessionState, to);
                    sessionState.updatedAt = Date.now();
                    persistAgentSessionState(sessionState);
                  }
                } else if (step.action === 'delete') {
                  const deleted = String((step as any)?.toolData?.path || step.params?.path || '').trim();
                  if (deleted) {
                    forgetRecentFilePath(sessionState, deleted);
                    sessionState.updatedAt = Date.now();
                    persistAgentSessionState(sessionState);
                  }
                }
              } catch {
                // best-effort recent file tracking
              }
              if (wantsSSE) {
                sseEvent('tool_result', {
                  action: step.action,
                  result: step.toolResult,
                  stepNum: step.stepNum,
                  diagnostics: (step as any)?.toolData?.search_diagnostics,
                });
              }
            }
            if (wantsSSE) sseEvent('step', step);
          };

          const aiFirstAnswer = await reactor.run(executionInput, {
            maxSteps: aiFirstBudget,
            temperature: 0.1,
            label: 'ai-first',
            skillSlugs: selectedSkillSlugs,
            nativeOnly: false, // node_call<> is primary channel; native function-calls are secondary
            allowHeuristicRouting: false,
            formatViolationFuse: 2,
            serverToolCall: (!preRoutedExecuted && policyDecision.locked_by_policy && policyDecision.tool)
              ? { tool: policyDecision.tool, params: policyDecision.params, reason: `Policy lock: ${policyDecision.lock_reason}` }
              : null,
            onStep: onAiFirstStep,
          });

          const usedAfter = countExecutedToolCalls(allSteps);
          const aiUsedTools = usedAfter > usedBefore;
          const aiReply = String(aiFirstAnswer || '').trim();
          const aiBlocked = /^\s*BLOCKED\b/i.test(aiReply);
          const aiFailed = isFailureLikeFinalReply(aiReply) || /^max steps/i.test(aiReply);
          const aiActionable = aiFirstRelevantSuccessfulToolResults > 0;
          const aiFirstThinking = allSteps
            .slice(aiFirstStepStartIndex)
            .map((s: any) => String(s?.thinking || '').trim())
            .filter(Boolean)
            .join('\n');
          const aiFirstSignals = parseExecuteControlSignals(aiReply, aiFirstThinking);

          if (aiFirstSignals.open_confirm) {
            appendDecisionTraceEvent(sessionState, 'execution', 'AI-first execute requested destructive confirmation handoff.', {
              source: 'ai_first',
            }, false);
            persistAgentSessionState(sessionState);
            return sseDone(aiReply, allSteps);
          }

          if (aiUsedTools && !aiBlocked && !aiFailed && aiReply && aiActionable) {
            appendDecisionTraceEvent(sessionState, 'execution', 'AI-first execute cycle succeeded; returning without deterministic fallback.', {
              tool_calls: usedAfter - usedBefore,
            }, false);
            persistAgentSessionState(sessionState);
            return sseDone(aiReply, allSteps);
          }

          if (aiActionable) {
            allowDeterministicFallback = false;
            preRoutedExecuted = true;
            skipReactorLoop = subQuestions.length === 1;
            appendDecisionTraceEvent(sessionState, 'fallback', 'AI-first execute produced actionable tool results without a clean final; skipping deterministic fallback and synthesizing.', {
              blocked: aiBlocked,
              failed: aiFailed,
              reply_preview: aiReply.slice(0, 180),
            }, false);
            if (wantsSSE) {
              sseEvent('info', {
                message: 'AI-first execute produced actionable tool results but no clean final. Skipping deterministic fallback and synthesizing from tool output.',
              });
            }
            if (aiReply && !aiBlocked) {
              collectedFacts.push(`Q: ${routingMessage}\nA: ${aiReply}`);
            }
          } else {
            const probeOnlyMutationMiss = mutativeExecuteRequest
              && aiFirstSuccessfulToolResults > 0
              && aiFirstRelevantSuccessfulToolResults === 0;
            allowDeterministicFallback = FEATURE_FLAGS.deterministic_execute_fallback || probeOnlyMutationMiss;
            preRoutedExecuted = false;
            appendDecisionTraceEvent(sessionState, 'fallback', 'AI-first execute produced no relevant tool activity.', {
              reply_preview: aiReply.slice(0, 180),
              local_execute_request: localExecuteRequest,
              mutative_execute_request: mutativeExecuteRequest,
              successful_tool_results: aiFirstSuccessfulToolResults,
              relevant_successful_tool_results: aiFirstRelevantSuccessfulToolResults,
              probe_only_mutation_miss: probeOnlyMutationMiss,
              deterministic_fallback_enabled: allowDeterministicFallback,
            }, false);
            if (wantsSSE) {
              sseEvent('info', {
                message: allowDeterministicFallback
                  ? 'AI-first execute did not produce relevant actionable tool results. Falling back to deterministic handlers.'
                  : 'AI-first execute did not produce relevant actionable tool results. Continuing with AI execute loop.',
              });
            }
          }
          persistAgentSessionState(sessionState);
        }
      }

      // Deterministic fallback block: skip entirely when node_call execute is active
      if (!strictAINativeExecute && !FEATURE_FLAGS.node_call_execute) {
        let deterministicBatchCalls: DeterministicFileCall[] = [];
        if (!preRoutedExecuted && allowDeterministicFallback) {
          deterministicBatchCalls = inferDeterministicFileBatchCalls(routingMessage, sessionState);
          deterministicBatchCalls = enforceSingleNamedCreateConstraint(deterministicBatchCalls, routingMessage);
        }
        const toolOrder: Record<string, number> = { delete: 0, rename: 1, write: 2 };
        deterministicBatchCalls = deterministicBatchCalls.slice().sort((a, b) =>
          (toolOrder[String((a as any)?.tool || '')] ?? 10) - (toolOrder[String((b as any)?.tool || '')] ?? 10)
        );
        const cycleBudgetForBatch = Math.min(maxToolsPerCycle, Math.max(0, maxTotalToolsPerTurn - countExecutedToolCalls(allSteps)));
        if (!preRoutedExecuted && deterministicBatchCalls.length > cycleBudgetForBatch) {
          const skipped = deterministicBatchCalls.length - cycleBudgetForBatch;
          deterministicBatchCalls = deterministicBatchCalls.slice(0, cycleBudgetForBatch);
          if (wantsSSE) sseEvent('info', { message: `Cycle tool cap applied: running first ${cycleBudgetForBatch} call(s), deferring ${skipped}.` });
          appendDecisionTraceEvent(sessionState, 'selected_plan', 'Cycle tool cap truncated deterministic batch.', {
            max_tools_per_cycle: cycleBudgetForBatch,
            skipped_calls: skipped,
          }, false);
        }
        if (!preRoutedExecuted) {
          appendDecisionTraceEvent(sessionState, 'deterministic_candidates', 'Deterministic batch candidates evaluated.', {
            count: deterministicBatchCalls.length,
            calls: deterministicBatchCalls.map(c => ({
              tool: c.tool,
              reason: c.reason,
              path: String(c.params?.path || ''),
              new_path: String(c.params?.new_path || ''),
            })),
          }, false);
          persistAgentSessionState(sessionState);
        }
        if (allowDeterministicFallback && !preRoutedExecuted && (workspaceListIntent || workspaceListFollowupIntent)) {
        const registry = getToolRegistry();
        appendDecisionTraceEvent(sessionState, 'selected_plan', workspaceListFollowupIntent
          ? 'Deterministic workspace-list follow-up plan selected.'
          : 'Deterministic workspace-list plan selected.', {
          tool: 'list',
          path: config.workspace.path,
        }, false);
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
          deterministic_calls: ['list:workspace'],
          selected_by: workspaceListFollowupIntent ? 'workspace_followup_resolver' : 'workspace_query_resolver',
        }, false);
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'running', { call_count: 1 }, false);
        persistAgentSessionState(sessionState);
        const stepNum = allSteps.length + 1;
        if (wantsSSE) {
          sseEvent('ui_preflight', { message: 'Listing workspace files...' });
          sseEvent('tool_call', { action: 'list', params: { path: config.workspace.path }, stepNum, thought: 'Deterministic workspace listing route.' });
        }
        logToolAudit({ type: 'tool_call', action: 'list', params: { path: config.workspace.path }, thought: 'Deterministic workspace listing route.', stepNum });
        const toolRes = await registry.execute('list', { path: config.workspace.path });
        const text = toolRes.success
          ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
          : `ERROR: ${toolRes.error}`;
        const step = {
          action: 'list',
          params: { path: config.workspace.path },
          toolResult: text,
          toolData: toolRes.data,
          stepNum,
          thought: 'Deterministic workspace listing route.',
        };
        allSteps.push(step);
        logToolAudit({ type: 'tool_result', action: 'list', result: text, stepNum });
        if (wantsSSE) {
          sseEvent('tool_result', { action: 'list', result: text, stepNum });
          sseEvent('step', step);
        }
        collectedFacts.push(`Q: ${routingMessage}\nA: ${text}`);
        if (!toolRes.success) {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            failed_step: stepNum,
            error: String(toolRes.error || 'tool_failed').slice(0, 220),
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          return sseDone(`I couldn't list the workspace files: ${toolRes.error || 'unknown error'}`, allSteps);
        }
        const files = Array.isArray((toolRes.data as any)?.files)
          ? (toolRes.data as any).files.map((x: any) => String(x || '')).filter(Boolean)
          : [];
        const dirs = Array.isArray((toolRes.data as any)?.directories)
          ? (toolRes.data as any).directories.map((x: any) => String(x || '')).filter(Boolean)
          : [];
        const lines: string[] = [];
        lines.push(`Workspace contents (\`${config.workspace.path}\`):`);
        lines.push(files.length ? `Files (${files.length}): ${files.slice(0, 24).join(', ')}` : 'Files: none');
        lines.push(dirs.length ? `Directories (${dirs.length}): ${dirs.slice(0, 24).join(', ')}` : 'Directories: none');
        if (files.length > 24 || dirs.length > 24) lines.push('Showing first 24 entries per group.');
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', { completed_calls: 1 }, false);
        setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'skipped', { operation: 'workspace_list' }, false);
        setTurnExecutionStatus(sessionState, 'done', false);
        persistAgentSessionState(sessionState);
        preRoutedExecuted = true;
        return sseDone(lines.join('\n'), allSteps);
      }
      const groupedDeleteIntent = /\b(remove|delete)\b/i.test(routingMessage)
        && /\bhtml?\b/i.test(routingMessage)
        && /\btxt\b/i.test(routingMessage);
      if (allowDeterministicFallback && !preRoutedExecuted && groupedDeleteIntent && deterministicBatchCalls.length === 0) {
        appendDecisionTraceEvent(sessionState, 'selected_plan', 'Grouped delete intent had no matches.', {
          request: routingMessage,
        }, false);
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
          deterministic_calls: [],
          note: 'No matching delete targets found.',
        }, false);
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'skipped', {
          operation: 'delete_group',
          deleted_count: 0,
        }, false);
        setTurnExecutionStatus(sessionState, 'verifying', false);
        setTurnExecutionVerification(sessionState, {
          expected: { intent: 'group_delete_html_and_txt', target_count: 0 },
          actual: { deleted: [] },
          status: 'pass',
          repairs_applied: [],
          errors: [],
          checked_at: Date.now(),
        }, false);
        persistAgentSessionState(sessionState);
        preRoutedExecuted = true;
        return sseDone('I checked the workspace and found no matching HTML or TXT files to delete.', allSteps);
      }
      if (allowDeterministicFallback && !preRoutedExecuted && deterministicBatchCalls.length > 0) {
        const registry = getToolRegistry();
        const summaries: string[] = [];
        appendDecisionTraceEvent(sessionState, 'selected_plan', 'Deterministic batch plan selected.', {
          call_count: deterministicBatchCalls.length,
          calls: deterministicBatchCalls.map(c => ({
            tool: c.tool,
            reason: c.reason,
            path: String(c.params?.path || ''),
            new_path: String(c.params?.new_path || ''),
          })),
        }, false);
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
          deterministic_calls: deterministicBatchCalls.map(c => `${c.tool}:${path.basename(String(c.params?.path || c.params?.new_path || ''))}`),
        }, false);
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'running', { call_count: deterministicBatchCalls.length }, false);
        persistAgentSessionState(sessionState);
        for (let i = 0; i < deterministicBatchCalls.length; i++) {
          const c = deterministicBatchCalls[i];
          const stepNum = i + 1;
          if (shouldBlockImplicitWrite(c, routingMessage)) {
            setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
              failed_step: stepNum,
              reason: 'MISSING_REQUIRED_INPUT',
              error: `Refusing implicit file creation for edit/delete intent: ${String(c.params?.path || '')}`.slice(0, 220),
            }, false);
            setTurnExecutionStatus(sessionState, 'failed', false);
            persistAgentSessionState(sessionState);
            const blocked = buildBlockedFileOpReply({
              reason_code: 'MISSING_REQUIRED_INPUT',
              what_was_tried: ['deterministic batch parse'],
              exact_input_needed: `File not found for edit/delete intent: ${String(c.params?.path || '')}.`,
              suggested_next_prompt: `Create ${String(c.params?.path || 'the file')} first, or provide an existing target.`,
            });
            return sseDone(blocked, allSteps);
          }
          if (c.tool === 'write' && isWriteNoOpCall(c)) {
            const p = String(c.params?.path || '');
            const noOpText = `Already set: ${p}`;
            const noOpStep = {
              action: c.tool,
              params: c.params,
              toolResult: noOpText,
              toolData: { path: p, skipped: true, no_op: true },
              stepNum,
              thought: `${c.reason} (no-op)`,
            };
            allSteps.push(noOpStep);
            if (wantsSSE) {
              sseEvent('tool_result', { action: c.tool, result: noOpText, stepNum });
              sseEvent('step', noOpStep);
            }
            summaries.push(`Already set \`${path.basename(p || 'file')}\`.`);
            continue;
          }
          if (c.tool === 'delete') {
            const pRaw = String(c.params?.path || '').trim();
            if (pRaw) {
              const abs = path.isAbsolute(pRaw) ? pRaw : path.join(config.workspace.path, pRaw);
              if (!fs.existsSync(abs)) {
                const noOpText = `Already absent: ${pRaw}`;
                const noOpStep = {
                  action: c.tool,
                  params: c.params,
                  toolResult: noOpText,
                  toolData: { path: pRaw, skipped: true },
                  stepNum,
                  thought: `${c.reason} (no-op)`,
                };
                allSteps.push(noOpStep);
                if (wantsSSE) {
                  sseEvent('tool_result', { action: c.tool, result: noOpText, stepNum });
                  sseEvent('step', noOpStep);
                }
                summaries.push(`Skipped delete (already absent) \`${path.basename(pRaw || 'file')}\`.`);
                continue;
              }
            }
          }
          if (wantsSSE) {
            const preflightMsg =
              c.tool === 'rename'
                ? 'Renaming requested file...'
                : (c.tool === 'delete' ? 'Deleting requested file...' : 'Creating requested file...');
            sseEvent('ui_preflight', { message: preflightMsg });
            sseEvent('tool_call', { action: c.tool, params: c.params, stepNum, thought: c.reason });
          }
          logToolAudit({ type: 'tool_call', action: c.tool, params: c.params, thought: c.reason, stepNum });
          const toolRes = await registry.execute(c.tool, c.params);
          let normalizedRes = toolRes;
          let text = toolRes.success
            ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
            : `ERROR: ${toolRes.error}`;
          if (!toolRes.success && c.tool === 'delete' && /does not exist/i.test(String(toolRes.error || ''))) {
            normalizedRes = {
              success: true,
              stdout: `Already absent: ${String(c.params?.path || '')}`,
              data: { path: String(c.params?.path || ''), skipped: true },
            } as any;
            text = String((normalizedRes as any).stdout || '');
          }
          const step = {
            action: c.tool,
            params: c.params,
            toolResult: text,
            toolData: (normalizedRes as any).data,
            stepNum,
            thought: c.reason,
          };
          allSteps.push(step);
          logToolAudit({ type: 'tool_result', action: c.tool, result: text, stepNum });
          if (wantsSSE) {
            sseEvent('tool_result', { action: c.tool, result: text, stepNum });
            sseEvent('step', step);
          }
          collectedFacts.push(`Q: ${routingMessage}\nA: ${text}`);
          if (!normalizedRes.success) {
            setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
              failed_step: stepNum,
              error: String((normalizedRes as any).error || toolRes.error || 'tool_failed').slice(0, 220),
            }, false);
            setTurnExecutionStatus(sessionState, 'failed', false);
            persistAgentSessionState(sessionState);
            return sseDone(`I started the file operations but failed on step ${stepNum}: ${(normalizedRes as any).error || toolRes.error}`, allSteps);
          }
          if (c.tool === 'rename') {
            const from = String(((normalizedRes as any).data as any)?.from || c.params.path || '');
            const to = String(((normalizedRes as any).data as any)?.to || c.params.new_path || '');
            summaries.push(`Renamed \`${path.basename(from || String(c.params.path || 'file'))}\` to \`${path.basename(to || String(c.params.new_path || 'file'))}\`.`);
          }
          if (c.tool === 'write') {
            const p = String((((normalizedRes as any).data as any)?.path) || c.params.path || '');
            const writeVerb = /content-update|multi-edit|single-edit|overwrite|update/i.test(String(c.reason || '')) ? 'Updated' : 'Created';
            summaries.push(`${writeVerb} \`${path.basename(p || String(c.params.path || 'file'))}\` with content "${String(c.params.content || '').slice(0, 120)}".`);
          }
          if (c.tool === 'delete') {
            const p = String((((normalizedRes as any).data as any)?.path) || c.params.path || '');
            const skipped = !!(((normalizedRes as any).data as any)?.skipped);
            if (!skipped && p) appendFileLifecycleNote('deleted', p);
            summaries.push(`${skipped ? 'Skipped delete (already absent)' : 'Deleted'} \`${path.basename(p || String(c.params.path || 'file'))}\`.`);
          }
        }
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', {
          completed_calls: deterministicBatchCalls.length,
        }, false);
        setTurnExecutionStatus(sessionState, 'verifying', false);
        setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'running', {
          operation: 'deterministic_batch',
        }, false);
        persistAgentSessionState(sessionState);
        const verify = await verifyAndRepairDeterministicFileOps(registry, deterministicBatchCalls);
        setTurnExecutionVerification(sessionState, {
          expected: {
            call_count: deterministicBatchCalls.length,
            calls: deterministicBatchCalls.map(c => ({ tool: c.tool, params: c.params })),
          },
          actual: {
            repairs: verify.repairs,
            errors: verify.errors,
          },
          status: verify.errors.length ? 'fail' : 'pass',
          repairs_applied: verify.repairs,
          errors: verify.errors,
          checked_at: Date.now(),
        }, false);
        if (verify.repairs.length && !verify.errors.length) {
          setTurnExecutionStatus(sessionState, 'repaired', false);
        }
        persistAgentSessionState(sessionState);
        if (verify.errors.length) {
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          const blocked = buildBlockedFileOpReply({
            reason_code: 'VERIFY_FAILED',
            what_was_tried: ['deterministic batch execute', 'verify+repair'],
            exact_input_needed: `Verification failed after one repair retry: ${verify.errors.join(' | ')}`,
          });
          return sseDone(blocked, allSteps);
        }
        for (const c of deterministicBatchCalls) {
          if (c.tool === 'rename') {
            const from = String(c.params?.path || '').trim();
            const to = String(c.params?.new_path || '').trim();
            if (from) forgetRecentFilePath(sessionState, from);
            if (to) rememberRecentFilePath(sessionState, to);
          } else if (c.tool === 'write') {
            const p = String(c.params?.path || '').trim();
            if (p) {
              rememberRecentFilePath(sessionState, p);
              if (/\.html?$/i.test(p) && /\b(style|background|text|color|css_)\b/i.test(String(c.reason || ''))) {
                const batchStyleIntent = detectHtmlStyleMutationIntent(routingMessage, sessionState);
                if (batchStyleIntent) rememberLastStyleMutation(sessionState, p, batchStyleIntent);
              }
            }
          } else if (c.tool === 'delete') {
            const p = String(c.params?.path || '').trim();
            if (p) forgetRecentFilePath(sessionState, p);
          }
        }
        if (verify.repairs.length) summaries.push(...verify.repairs);
        sessionState.updatedAt = Date.now();
        persistAgentSessionState(sessionState);
        preRoutedExecuted = true;
        return sseDone(summaries.join('\n'), allSteps);
      }
      const deterministicFileCall = inferDeterministicFileWriteCall(routingMessage);
      const deterministicSingleEditCall = inferDeterministicSingleFileOverwriteCall(routingMessage, sessionState);
      const deterministicFollowupCall = inferDeterministicFileFollowupCall(routingMessage, sessionState);
      if (allowDeterministicFallback && !preRoutedExecuted && deterministicFileCall) {
        const registry = getToolRegistry();
        const stepNum = 1;
        appendDecisionTraceEvent(sessionState, 'selected_plan', 'Deterministic single create selected.', {
          tool: deterministicFileCall.tool,
          reason: deterministicFileCall.reason,
          params: deterministicFileCall.params,
        }, false);
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
          deterministic_call: `${deterministicFileCall.tool}:${path.basename(String(deterministicFileCall.params?.path || ''))}`,
        }, false);
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'running', { call_count: 1 }, false);
        persistAgentSessionState(sessionState);
        if (shouldBlockImplicitWrite(deterministicFileCall, routingMessage)) {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            reason: 'MISSING_REQUIRED_INPUT',
            error: `Refusing implicit file creation: ${String(deterministicFileCall.params?.path || '')}`.slice(0, 220),
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          const blocked = buildBlockedFileOpReply({
            reason_code: 'MISSING_REQUIRED_INPUT',
            what_was_tried: ['deterministic create route'],
            exact_input_needed: `File target is missing and request does not explicitly permit creation: ${String(deterministicFileCall.params?.path || '')}.`,
          });
          return sseDone(blocked, allSteps);
        }
        if (isWriteNoOpCall(deterministicFileCall)) {
          const p = String(deterministicFileCall.params?.path || '');
          if (p) rememberRecentFilePath(sessionState, p);
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', { completed_calls: 0, no_op: true }, false);
          setTurnExecutionStatus(sessionState, 'verifying', false);
          setTurnExecutionVerification(sessionState, {
            expected: { calls: [{ tool: deterministicFileCall.tool, params: deterministicFileCall.params }] },
            actual: { no_op: true, repairs: [], errors: [] },
            status: 'pass',
            repairs_applied: [],
            errors: [],
            checked_at: Date.now(),
          }, false);
          persistAgentSessionState(sessionState);
          preRoutedExecuted = true;
          return sseDone(`Already set: \`${path.basename(p || 'file')}\` already matches requested content.`, allSteps);
        }
        if (wantsSSE) {
          sseEvent('ui_preflight', { message: 'Creating the requested file in workspace...' });
          sseEvent('tool_call', { action: deterministicFileCall.tool, params: deterministicFileCall.params, stepNum, thought: deterministicFileCall.reason });
        }
        logToolAudit({
          type: 'tool_call',
          action: deterministicFileCall.tool,
          params: deterministicFileCall.params,
          thought: deterministicFileCall.reason,
          stepNum,
        });
        const toolRes = await registry.execute(deterministicFileCall.tool, deterministicFileCall.params);
        const text = toolRes.success
          ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
          : `ERROR: ${toolRes.error}`;
        const step = {
          action: deterministicFileCall.tool,
          params: deterministicFileCall.params,
          toolResult: text,
          toolData: toolRes.data,
          stepNum,
          thought: deterministicFileCall.reason,
        };
        allSteps.push(step);
        logToolAudit({ type: 'tool_result', action: deterministicFileCall.tool, result: text, stepNum });
        if (wantsSSE) {
          sseEvent('tool_result', { action: deterministicFileCall.tool, result: text, stepNum });
          sseEvent('step', step);
        }
        collectedFacts.push(`Q: ${routingMessage}\nA: ${text}`);
        preRoutedExecuted = true;
        if (toolRes.success) {
          const p = deterministicFileCall.params.path;
          const c = deterministicFileCall.params.content;
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', { completed_calls: 1 }, false);
          setTurnExecutionStatus(sessionState, 'verifying', false);
          setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'running', { operation: 'deterministic_create' }, false);
          persistAgentSessionState(sessionState);
          const verify = await verifyAndRepairDeterministicFileOps(registry, [deterministicFileCall]);
          setTurnExecutionVerification(sessionState, {
            expected: { calls: [{ tool: deterministicFileCall.tool, params: deterministicFileCall.params }] },
            actual: { repairs: verify.repairs, errors: verify.errors },
            status: verify.errors.length ? 'fail' : 'pass',
            repairs_applied: verify.repairs,
            errors: verify.errors,
            checked_at: Date.now(),
          }, false);
          if (verify.repairs.length && !verify.errors.length) {
            setTurnExecutionStatus(sessionState, 'repaired', false);
          }
          persistAgentSessionState(sessionState);
          sessionState.updatedAt = Date.now();
          persistAgentSessionState(sessionState);
          if (verify.errors.length) {
            setTurnExecutionStatus(sessionState, 'failed', false);
            persistAgentSessionState(sessionState);
            const blocked = buildBlockedFileOpReply({
              reason_code: 'VERIFY_FAILED',
              what_was_tried: ['deterministic create write', 'verify+repair'],
              exact_input_needed: `Verification failed after one repair retry: ${verify.errors.join(' | ')}`,
            });
            return sseDone(blocked, allSteps);
          }
          rememberRecentFilePath(sessionState, String((toolRes.data as any)?.path || p));
          const extras = [...verify.repairs];
          return sseDone(`Created \`${p}\` with content:\n"${c}"${extras.length ? `\n${extras.join('\n')}` : ''}`, allSteps);
        } else {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            error: String(toolRes.error || 'tool_failed').slice(0, 220),
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
        }
      }
      if (allowDeterministicFallback && !preRoutedExecuted && deterministicSingleEditCall) {
        const registry = getToolRegistry();
        const stepNum = 1;
        const preSingleStyleIntent = detectHtmlStyleMutationIntent(routingMessage, sessionState);
        appendDecisionTraceEvent(sessionState, 'selected_plan', 'Deterministic single edit selected.', {
          tool: deterministicSingleEditCall.tool,
          reason: deterministicSingleEditCall.reason,
          params: deterministicSingleEditCall.params,
        }, false);
        if (preSingleStyleIntent && /\.html?$/i.test(String(deterministicSingleEditCall.params?.path || ''))) {
          rememberLastStyleMutation(sessionState, String(deterministicSingleEditCall.params?.path || ''), preSingleStyleIntent);
        }
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
          deterministic_call: `${deterministicSingleEditCall.tool}:${path.basename(String(deterministicSingleEditCall.params?.path || ''))}`,
        }, false);
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'running', { call_count: 1 }, false);
        persistAgentSessionState(sessionState);
        if (shouldBlockImplicitWrite(deterministicSingleEditCall, routingMessage)) {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            reason: 'MISSING_REQUIRED_INPUT',
            error: `Refusing implicit file creation for edit intent: ${String(deterministicSingleEditCall.params?.path || '')}`.slice(0, 220),
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          const blocked = buildBlockedFileOpReply({
            reason_code: 'MISSING_REQUIRED_INPUT',
            what_was_tried: ['deterministic single edit route'],
            exact_input_needed: `Target file does not exist: ${String(deterministicSingleEditCall.params?.path || '')}.`,
            suggested_next_prompt: `Create ${String(deterministicSingleEditCall.params?.path || 'the file')} first, then apply the edit.`,
          });
          return sseDone(blocked, allSteps);
        }
        if (isWriteNoOpCall(deterministicSingleEditCall)) {
          const p = String(deterministicSingleEditCall.params?.path || '');
          if (p) rememberRecentFilePath(sessionState, p);
          const noOpStyleIntent = detectHtmlStyleMutationIntent(routingMessage, sessionState);
          if (p && noOpStyleIntent && /\.html?$/i.test(p)) rememberLastStyleMutation(sessionState, p, noOpStyleIntent);
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', { completed_calls: 0, no_op: true }, false);
          setTurnExecutionStatus(sessionState, 'verifying', false);
          setTurnExecutionVerification(sessionState, {
            expected: { calls: [{ tool: deterministicSingleEditCall.tool, params: deterministicSingleEditCall.params }] },
            actual: { no_op: true, repairs: [], errors: [] },
            status: 'pass',
            repairs_applied: [],
            errors: [],
            checked_at: Date.now(),
          }, false);
          persistAgentSessionState(sessionState);
          preRoutedExecuted = true;
          return sseDone(`Already set: \`${path.basename(p || 'file')}\` already matches requested content/style.`, allSteps);
        }
        if (wantsSSE) {
          sseEvent('ui_preflight', { message: 'Updating the requested file in workspace...' });
          sseEvent('tool_call', { action: deterministicSingleEditCall.tool, params: deterministicSingleEditCall.params, stepNum, thought: deterministicSingleEditCall.reason });
        }
        logToolAudit({
          type: 'tool_call',
          action: deterministicSingleEditCall.tool,
          params: deterministicSingleEditCall.params,
          thought: deterministicSingleEditCall.reason,
          stepNum,
        });
        const toolRes = await registry.execute(deterministicSingleEditCall.tool, deterministicSingleEditCall.params);
        const text = toolRes.success
          ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
          : `ERROR: ${toolRes.error}`;
        const step = {
          action: deterministicSingleEditCall.tool,
          params: deterministicSingleEditCall.params,
          toolResult: text,
          toolData: toolRes.data,
          stepNum,
          thought: deterministicSingleEditCall.reason,
        };
        allSteps.push(step);
        logToolAudit({ type: 'tool_result', action: deterministicSingleEditCall.tool, result: text, stepNum });
        if (wantsSSE) {
          sseEvent('tool_result', { action: deterministicSingleEditCall.tool, result: text, stepNum });
          sseEvent('step', step);
        }
        collectedFacts.push(`Q: ${routingMessage}\nA: ${text}`);
        preRoutedExecuted = true;
        if (toolRes.success) {
          const p = String((toolRes.data as any)?.path || deterministicSingleEditCall.params.path || '');
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', { completed_calls: 1 }, false);
          setTurnExecutionStatus(sessionState, 'verifying', false);
          setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'running', { operation: 'deterministic_single_edit' }, false);
          persistAgentSessionState(sessionState);
          const verify = await verifyAndRepairDeterministicFileOps(registry, [deterministicSingleEditCall]);
          setTurnExecutionVerification(sessionState, {
            expected: { calls: [{ tool: deterministicSingleEditCall.tool, params: deterministicSingleEditCall.params }] },
            actual: { repairs: verify.repairs, errors: verify.errors },
            status: verify.errors.length ? 'fail' : 'pass',
            repairs_applied: verify.repairs,
            errors: verify.errors,
            checked_at: Date.now(),
          }, false);
          if (verify.repairs.length && !verify.errors.length) {
            setTurnExecutionStatus(sessionState, 'repaired', false);
          }
          persistAgentSessionState(sessionState);
          sessionState.updatedAt = Date.now();
          persistAgentSessionState(sessionState);
          if (verify.errors.length) {
            setTurnExecutionStatus(sessionState, 'failed', false);
            persistAgentSessionState(sessionState);
            const blocked = buildBlockedFileOpReply({
              reason_code: 'VERIFY_FAILED',
              what_was_tried: ['deterministic single edit write', 'verify+repair'],
              exact_input_needed: `Verification failed after one repair retry: ${verify.errors.join(' | ')}`,
            });
            return sseDone(blocked, allSteps);
          }
          if (p) rememberRecentFilePath(sessionState, p);
          const singleStyleIntent = detectHtmlStyleMutationIntent(routingMessage, sessionState);
          if (p && singleStyleIntent && /\.html?$/i.test(p)) rememberLastStyleMutation(sessionState, p, singleStyleIntent);
          const extras = [...verify.repairs];
          return sseDone(`Updated \`${path.basename(p || String(deterministicSingleEditCall.params.path || 'file'))}\` with requested content.${extras.length ? `\n${extras.join('\n')}` : ''}`, allSteps);
        } else {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            error: String(toolRes.error || 'tool_failed').slice(0, 220),
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
        }
      }
      if (allowDeterministicFallback && !preRoutedExecuted && deterministicFollowupCall) {
        const registry = getToolRegistry();
        const stepNum = 1;
        appendDecisionTraceEvent(sessionState, 'selected_plan', 'Deterministic follow-up rename selected.', {
          tool: deterministicFollowupCall.tool,
          reason: deterministicFollowupCall.reason,
          params: deterministicFollowupCall.params,
        }, false);
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
          deterministic_call: `${deterministicFollowupCall.tool}:${path.basename(String(deterministicFollowupCall.params?.path || ''))}`,
        }, false);
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'running', { call_count: 1 }, false);
        persistAgentSessionState(sessionState);
        if (wantsSSE) {
          sseEvent('ui_preflight', { message: 'Renaming the requested file in workspace...' });
          sseEvent('tool_call', { action: deterministicFollowupCall.tool, params: deterministicFollowupCall.params, stepNum, thought: deterministicFollowupCall.reason });
        }
        logToolAudit({
          type: 'tool_call',
          action: deterministicFollowupCall.tool,
          params: deterministicFollowupCall.params,
          thought: deterministicFollowupCall.reason,
          stepNum,
        });
        const toolRes = await registry.execute(deterministicFollowupCall.tool, deterministicFollowupCall.params);
        const text = toolRes.success
          ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
          : `ERROR: ${toolRes.error}`;
        const step = {
          action: deterministicFollowupCall.tool,
          params: deterministicFollowupCall.params,
          toolResult: text,
          toolData: toolRes.data,
          stepNum,
          thought: deterministicFollowupCall.reason,
        };
        allSteps.push(step);
        logToolAudit({ type: 'tool_result', action: deterministicFollowupCall.tool, result: text, stepNum });
        if (wantsSSE) {
          sseEvent('tool_result', { action: deterministicFollowupCall.tool, result: text, stepNum });
          sseEvent('step', step);
        }
        collectedFacts.push(`Q: ${routingMessage}\nA: ${text}`);
        preRoutedExecuted = true;
        if (toolRes.success) {
          const to = String((toolRes.data as any)?.to || deterministicFollowupCall.params.new_path);
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', { completed_calls: 1 }, false);
          setTurnExecutionStatus(sessionState, 'verifying', false);
          setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'running', { operation: 'deterministic_rename' }, false);
          persistAgentSessionState(sessionState);
          const verify = await verifyAndRepairDeterministicFileOps(registry, [deterministicFollowupCall]);
          setTurnExecutionVerification(sessionState, {
            expected: { calls: [{ tool: deterministicFollowupCall.tool, params: deterministicFollowupCall.params }] },
            actual: { repairs: verify.repairs, errors: verify.errors },
            status: verify.errors.length ? 'fail' : 'pass',
            repairs_applied: verify.repairs,
            errors: verify.errors,
            checked_at: Date.now(),
          }, false);
          if (verify.repairs.length && !verify.errors.length) {
            setTurnExecutionStatus(sessionState, 'repaired', false);
          }
          persistAgentSessionState(sessionState);
          sessionState.updatedAt = Date.now();
          persistAgentSessionState(sessionState);
          if (verify.errors.length) {
            setTurnExecutionStatus(sessionState, 'failed', false);
            persistAgentSessionState(sessionState);
            const blocked = buildBlockedFileOpReply({
              reason_code: 'VERIFY_FAILED',
              what_was_tried: ['deterministic rename', 'verify+repair'],
              exact_input_needed: `Verification failed after one repair retry: ${verify.errors.join(' | ')}`,
            });
            return sseDone(blocked, allSteps);
          }
          const from = String(deterministicFollowupCall.params?.path || '').trim();
          if (from) forgetRecentFilePath(sessionState, from);
          if (to) rememberRecentFilePath(sessionState, to);
          const extras = [...verify.repairs];
          return sseDone(`Renamed file to \`${path.basename(to)}\`.${extras.length ? `\n${extras.join('\n')}` : ''}`, allSteps);
        } else {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            error: String(toolRes.error || 'tool_failed').slice(0, 220),
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
        }
      }
      const isStyleOpTurn = !!detectHtmlStyleMutationIntent(routingMessage, sessionState) && hasHtmlStyleTargetContext(sessionState);
      const isStructuralOpTurn = !!detectHtmlStructuralMutationIntent(routingMessage, sessionState) && hasHtmlStyleTargetContext(sessionState);
      const isFileOpTurn = isFileOperationRequest(routingMessage) || isFileFollowupOperationRequest(routingMessage, sessionState) || isStyleOpTurn || isStructuralOpTurn;
      if (allowDeterministicFallback && !preRoutedExecuted && isFileOpTurn) {
        const registry = getToolRegistry();
        const styleIntent = detectHtmlStyleMutationIntent(routingMessage, sessionState);
        const structuralIntent = detectHtmlStructuralMutationIntent(routingMessage, sessionState);
        const requestedContent = extractRequestedContentValue(routingMessage, 400);
        const contentIntent = !!requestedContent && /\b(edit|update|overwrite|set|replace|change|modify|fix|correct|write|make)\b/i.test(routingMessage);
        const mutationMode: 'style' | 'structural' | 'content' | '' = styleIntent ? 'style' : (structuralIntent ? 'structural' : (contentIntent ? 'content' : ''));
        let deleteFollowupCalls = !mutationMode
          ? inferDeterministicDeleteFollowupCalls(routingMessage, sessionState)
          : [];
        const cycleBudgetForDeleteFollowup = Math.min(maxToolsPerCycle, Math.max(0, maxTotalToolsPerTurn - countExecutedToolCalls(allSteps)));
        if (deleteFollowupCalls.length > cycleBudgetForDeleteFollowup) {
          const skipped = deleteFollowupCalls.length - cycleBudgetForDeleteFollowup;
          deleteFollowupCalls = deleteFollowupCalls.slice(0, cycleBudgetForDeleteFollowup);
          if (wantsSSE) sseEvent('info', { message: `Cycle tool cap applied: running first ${cycleBudgetForDeleteFollowup} delete call(s), deferring ${skipped}.` });
        }
        appendDecisionTraceEvent(sessionState, 'fallback', 'File-op ladder entered deterministic scout/mutate fallback.', {
          style_intent: styleIntent || null,
          structural_intent: structuralIntent || null,
          content_intent: contentIntent,
          mutation_mode: mutationMode || null,
          delete_followup_calls: deleteFollowupCalls.length,
        }, false);
        persistAgentSessionState(sessionState);

        if (!mutationMode && deleteFollowupCalls.length > 0) {
          const summaries: string[] = [];
          setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
            deterministic_calls: deleteFollowupCalls.map(c => `${c.tool}:${path.basename(String(c.params?.path || ''))}`),
            selected_by: 'deterministic_delete_followup',
          }, false);
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'running', {
            call_count: deleteFollowupCalls.length,
          }, false);
          persistAgentSessionState(sessionState);
          for (let i = 0; i < deleteFollowupCalls.length; i++) {
            const c = deleteFollowupCalls[i];
            const stepNum = allSteps.length + 1;
            const pRaw = String(c.params?.path || '').trim();
            const abs = pRaw ? (path.isAbsolute(pRaw) ? pRaw : path.join(config.workspace.path, pRaw)) : '';
            if (abs && !fs.existsSync(abs)) {
              const noOpText = `Already absent: ${pRaw}`;
              const noOpStep = {
                action: 'delete',
                params: c.params,
                toolResult: noOpText,
                toolData: { path: pRaw, skipped: true },
                stepNum,
                thought: `${c.reason} (no-op)`,
              };
              allSteps.push(noOpStep);
              if (wantsSSE) {
                sseEvent('tool_result', { action: 'delete', result: noOpText, stepNum });
                sseEvent('step', noOpStep);
              }
              summaries.push(`Skipped delete (already absent) \`${path.basename(pRaw || 'file')}\`.`);
              continue;
            }
            if (wantsSSE) {
              sseEvent('ui_preflight', { message: 'Deleting requested file...' });
              sseEvent('tool_call', { action: 'delete', params: c.params, stepNum, thought: c.reason });
            }
            logToolAudit({ type: 'tool_call', action: 'delete', params: c.params, thought: c.reason, stepNum });
            const toolRes = await registry.execute('delete', c.params);
            let normalizedRes = toolRes;
            let text = toolRes.success
              ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
              : `ERROR: ${toolRes.error}`;
            if (!toolRes.success && /does not exist/i.test(String(toolRes.error || ''))) {
              normalizedRes = {
                success: true,
                stdout: `Already absent: ${String(c.params?.path || '')}`,
                data: { path: String(c.params?.path || ''), skipped: true },
              } as any;
              text = String((normalizedRes as any).stdout || '');
            }
            const step = {
              action: 'delete',
              params: c.params,
              toolResult: text,
              toolData: (normalizedRes as any).data,
              stepNum,
              thought: c.reason,
            };
            allSteps.push(step);
            logToolAudit({ type: 'tool_result', action: 'delete', result: text, stepNum });
            if (wantsSSE) {
              sseEvent('tool_result', { action: 'delete', result: text, stepNum });
              sseEvent('step', step);
            }
            if (!(normalizedRes as any).success) {
              setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
                failed_step: stepNum,
                error: String((normalizedRes as any).error || toolRes.error || 'tool_failed').slice(0, 220),
              }, false);
              setTurnExecutionStatus(sessionState, 'failed', false);
              persistAgentSessionState(sessionState);
              return sseDone(`I started deletion but failed on step ${stepNum}: ${(normalizedRes as any).error || toolRes.error}`, allSteps);
            }
            const deletedPath = String((((normalizedRes as any).data as any)?.path) || c.params.path || '');
            forgetRecentFilePath(sessionState, deletedPath);
            const skipped = !!(((normalizedRes as any).data as any)?.skipped);
            if (!skipped && deletedPath) appendFileLifecycleNote('deleted', deletedPath);
            summaries.push(`${skipped ? 'Skipped delete (already absent)' : 'Deleted'} \`${path.basename(deletedPath || String(c.params.path || 'file'))}\`.`);
          }
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', {
            completed_calls: deleteFollowupCalls.length,
          }, false);
          setTurnExecutionStatus(sessionState, 'verifying', false);
          setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'running', {
            operation: 'deterministic_delete_followup',
          }, false);
          persistAgentSessionState(sessionState);
          const verify = await verifyAndRepairDeterministicFileOps(registry, deleteFollowupCalls);
          setTurnExecutionVerification(sessionState, {
            expected: { call_count: deleteFollowupCalls.length, operation: 'delete_followup' },
            actual: { repairs: verify.repairs, errors: verify.errors },
            status: verify.errors.length ? 'fail' : 'pass',
            repairs_applied: verify.repairs,
            errors: verify.errors,
            checked_at: Date.now(),
          }, false);
          if (verify.errors.length) {
            setTurnExecutionStatus(sessionState, 'failed', false);
            persistAgentSessionState(sessionState);
            const blocked = buildBlockedFileOpReply({
              reason_code: 'VERIFY_FAILED',
              what_was_tried: ['deterministic delete follow-up', 'verify+repair'],
              exact_input_needed: `Verification failed after one repair retry: ${verify.errors.join(' | ')}`,
            });
            return sseDone(blocked, allSteps);
          }
          if (verify.repairs.length) setTurnExecutionStatus(sessionState, 'repaired', false);
          sessionState.updatedAt = Date.now();
          persistAgentSessionState(sessionState);
          return sseDone([...summaries, ...verify.repairs].filter(Boolean).join('\n'), allSteps);
        }

        if (!mutationMode) {
          const genericProbe = resolveGenericTargetForMutation(routingMessage, sessionState);
          const styleLikeCue = /\b(text|font|foreground|background|bg|color|theme|panel|html|card|box|wrap|center)\b/i.test(routingMessage);
          if (genericProbe.status === 'ambiguous') {
            const names = genericProbe.candidates.map(p => path.basename(String(p || ''))).slice(0, 6);
            const question = `Which file should I edit: ${names.join(' or ')}?`;
            setTurnExecutionStepStatus(sessionState, 'select_targets', 'failed', {
              reason: 'AMBIGUOUS_TARGET',
              candidates: names,
            }, false);
            setTurnExecutionStepStatus(sessionState, 'execute_changes', 'skipped', {}, false);
            setTurnExecutionStatus(sessionState, 'failed', false);
            persistAgentSessionState(sessionState);
            return sseDone(question, allSteps);
          }
          const blocked = buildBlockedFileOpReply({
            reason_code: 'UNSUPPORTED_MUTATION',
            what_was_tried: ['deterministic direct rewrite', 'deterministic batch parsing', 'deterministic follow-up parsing'],
            exact_input_needed: 'Please specify a target file and mutation (for example: "set index.html text color to red", "set index.html panel background to red", "wrap index.html text in a panel", or "edit note.txt to say hello world").',
            suggested_next_prompt: styleLikeCue ? 'Wrap index.html text in a centered panel.' : 'Edit note.txt to say "hello world".',
          });
          setTurnExecutionStepStatus(sessionState, 'select_targets', 'failed', {
            reason: 'UNSUPPORTED_MUTATION',
          }, false);
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'skipped', {}, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          return sseDone(blocked, allSteps);
        }

        setTurnExecutionStepStatus(sessionState, 'select_targets', 'running', {
          selected_by: 'deterministic_scout',
          operation: mutationMode === 'style' ? 'style_mutation' : (mutationMode === 'structural' ? 'structural_mutation' : 'content_mutation'),
        }, false);
        persistAgentSessionState(sessionState);

        const scoutListStepNum = allSteps.length + 1;
        if (wantsSSE) {
          const modeLabel = mutationMode === 'style'
            ? 'style mutation'
            : (mutationMode === 'structural' ? 'structural mutation' : 'content mutation');
          sseEvent('ui_preflight', { message: `Scanning workspace for target file (${modeLabel})...` });
          sseEvent('tool_call', { action: 'list', params: { path: config.workspace.path }, stepNum: scoutListStepNum, thought: 'Deterministic scout: enumerate workspace files.' });
        }
        logToolAudit({ type: 'tool_call', action: 'list', params: { path: config.workspace.path }, thought: 'Deterministic scout: enumerate workspace files.', stepNum: scoutListStepNum });
        const scoutListRes = await registry.execute('list', { path: config.workspace.path });
        const scoutListText = scoutListRes.success
          ? (scoutListRes.stdout || JSON.stringify(scoutListRes.data || {}))
          : `ERROR: ${scoutListRes.error}`;
        const scoutListStep = {
          action: 'list',
          params: { path: config.workspace.path },
          toolResult: scoutListText,
          toolData: scoutListRes.data,
          stepNum: scoutListStepNum,
          thought: 'Deterministic scout: enumerate workspace files.',
        };
        allSteps.push(scoutListStep);
        if (wantsSSE) {
          sseEvent('tool_result', { action: 'list', result: scoutListText, stepNum: scoutListStepNum });
          sseEvent('step', scoutListStep);
        }
        logToolAudit({ type: 'tool_result', action: 'list', result: scoutListText, stepNum: scoutListStepNum });

        const resolved = (mutationMode === 'style' || mutationMode === 'structural')
          ? resolveHtmlTargetForMutation(routingMessage, sessionState)
          : resolveGenericTargetForMutation(routingMessage, sessionState);
        if (resolved.status === 'ambiguous') {
          const names = resolved.candidates.map(p => path.basename(String(p || ''))).slice(0, 6);
          const question = `Which file should I edit: ${names.join(' or ')}?`;
          setTurnExecutionStepStatus(sessionState, 'select_targets', 'failed', {
            reason: 'AMBIGUOUS_TARGET',
            candidates: names,
          }, false);
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'skipped', {}, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          return sseDone(question, allSteps);
        }
        if (resolved.status !== 'resolved') {
          const samplePrompt = mutationMode === 'style'
            ? ((styleIntent as any)?.property === 'text'
              ? 'Edit index.html and set the text color to red.'
              : 'Edit index.html and set the background to red.')
            : (mutationMode === 'structural'
              ? 'Edit index.html and wrap existing text in a centered panel.'
              : 'Edit note.txt and set it to "hello world".');
          const blocked = buildBlockedFileOpReply({
            reason_code: 'MISSING_REQUIRED_INPUT',
            what_was_tried: ['workspace scout', 'recent file history lookup'],
            exact_input_needed: 'I could not find a single target file. Provide the exact filename (for example: index.html or note.txt).',
            suggested_next_prompt: samplePrompt,
          });
          setTurnExecutionStepStatus(sessionState, 'select_targets', 'failed', {
            reason: 'MISSING_REQUIRED_INPUT',
          }, false);
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'skipped', {}, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          return sseDone(blocked, allSteps);
        }

        const targetPath = resolved.targetPath;
        if (mutationMode === 'style' && styleIntent) rememberLastStyleMutation(sessionState, targetPath, styleIntent);
        setTurnExecutionStepStatus(sessionState, 'select_targets', 'done', {
          deterministic_call: `write:${path.basename(targetPath)}`,
          selected_by: 'deterministic_scout',
        }, false);
        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'running', { call_count: 1 }, false);
        persistAgentSessionState(sessionState);

        const scoutReadStepNum = allSteps.length + 1;
        if (wantsSSE) {
          sseEvent('ui_preflight', { message: `Inspecting ${path.basename(targetPath)} before applying ${mutationMode} mutation...` });
          sseEvent('tool_call', { action: 'read', params: { path: targetPath, start_line: 1, num_lines: 260 }, stepNum: scoutReadStepNum, thought: 'Deterministic scout: bounded read before mutate.' });
        }
        logToolAudit({ type: 'tool_call', action: 'read', params: { path: targetPath, start_line: 1, num_lines: 260 }, thought: 'Deterministic scout: bounded read before mutate.', stepNum: scoutReadStepNum });
        const scoutReadRes = await registry.execute('read', { path: targetPath, start_line: 1, num_lines: 260 });
        const scoutReadText = scoutReadRes.success
          ? (scoutReadRes.stdout || JSON.stringify(scoutReadRes.data || {}))
          : `ERROR: ${scoutReadRes.error}`;
        const scoutReadStep = {
          action: 'read',
          params: { path: targetPath, start_line: 1, num_lines: 260 },
          toolResult: scoutReadText,
          toolData: scoutReadRes.data,
          stepNum: scoutReadStepNum,
          thought: 'Deterministic scout: bounded read before mutate.',
        };
        allSteps.push(scoutReadStep);
        if (wantsSSE) {
          sseEvent('tool_result', { action: 'read', result: scoutReadText, stepNum: scoutReadStepNum });
          sseEvent('step', scoutReadStep);
        }
        logToolAudit({ type: 'tool_result', action: 'read', result: scoutReadText, stepNum: scoutReadStepNum });

        if (!scoutReadRes.success) {
          const blocked = buildBlockedFileOpReply({
            reason_code: 'MISSING_REQUIRED_INPUT',
            what_was_tried: ['workspace scout', `read:${path.basename(targetPath)}`],
            exact_input_needed: `I couldn't read ${path.basename(targetPath)}. Confirm the file exists and is readable.`,
          });
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            error: String(scoutReadRes.error || 'read_failed').slice(0, 220),
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          return sseDone(blocked, allSteps);
        }

        const existingBody = String((scoutReadRes.data as any)?.content || '');
        let rewritten: { content: string; operation_type: string; expected_after_hint: string } | null = null;
        if (mutationMode === 'style') {
          rewritten = rewriteHtmlStyleByIntent(existingBody, styleIntent as HtmlStyleMutationIntent);
        } else if (mutationMode === 'structural') {
          rewritten = rewriteHtmlStructuralByIntent(existingBody, structuralIntent as HtmlStructuralMutationIntent);
        } else {
          const nextContent = /\.html?$/i.test(targetPath)
            ? rewriteHtmlPrimaryText(existingBody, requestedContent)
            : requestedContent;
          rewritten = nextContent
            ? {
              content: nextContent,
              operation_type: /\.html?$/i.test(targetPath) ? 'html_set_primary_text' : 'file_overwrite_content',
              expected_after_hint: requestedContent,
            }
            : null;
        }
        if (!rewritten) {
          const suggested = mutationMode === 'style'
            ? (((styleIntent as any)?.property === 'text')
              ? `Set ${path.basename(targetPath)} text color to red.`
              : `Set ${path.basename(targetPath)} panel background to red.`)
            : (mutationMode === 'structural'
              ? `Wrap ${path.basename(targetPath)} content in a centered panel.`
              : `Set ${path.basename(targetPath)} to say "hello world".`);
          const blocked = buildBlockedFileOpReply({
            reason_code: 'UNSUPPORTED_MUTATION',
            what_was_tried: [`deterministic ${mutationMode} mutation resolver`],
            exact_input_needed: mutationMode === 'style'
              ? 'I need a supported style mutation like page/panel background color or text color with a target color.'
              : (mutationMode === 'structural'
                ? 'I need a supported structural mutation like wrapping existing content in a panel.'
                : 'I need explicit target content (for example: "to say hello world").'),
            suggested_next_prompt: suggested,
          });
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            reason: 'UNSUPPORTED_MUTATION',
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          return sseDone(blocked, allSteps);
        }

        if (normalizeContentForVerify(existingBody) === normalizeContentForVerify(rewritten.content)) {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', { completed_calls: 0, no_op: true }, false);
          setTurnExecutionStatus(sessionState, 'verifying', false);
          setTurnExecutionVerification(sessionState, {
            expected: { path: targetPath, mutation: rewritten.operation_type },
            actual: { no_op: true },
            status: 'pass',
            repairs_applied: [],
            errors: [],
            checked_at: Date.now(),
          }, false);
          rememberRecentFilePath(sessionState, targetPath);
          if (mutationMode === 'style' && styleIntent) {
            rememberLastStyleMutation(sessionState, targetPath, styleIntent);
          }
          persistAgentSessionState(sessionState);
          preRoutedExecuted = true;
          return sseDone(`Already set: \`${path.basename(targetPath)}\` already matches the requested ${mutationMode}.`, allSteps);
        }

        const deterministicMutateCall: DeterministicFileCall = {
          tool: 'write',
          params: { path: targetPath, content: rewritten.content },
          reason: `Deterministic scout-mutate ${mutationMode} route (${rewritten.operation_type})`,
        };
        const mutateStepNum = allSteps.length + 1;
        if (wantsSSE) {
          sseEvent('ui_preflight', { message: `Applying ${mutationMode} mutation to ${path.basename(targetPath)}...` });
          sseEvent('tool_call', { action: 'write', params: deterministicMutateCall.params, stepNum: mutateStepNum, thought: deterministicMutateCall.reason });
        }
        logToolAudit({ type: 'tool_call', action: 'write', params: deterministicMutateCall.params, thought: deterministicMutateCall.reason, stepNum: mutateStepNum });
        const mutateRes = await registry.execute('write', deterministicMutateCall.params);
        const mutateText = mutateRes.success
          ? (mutateRes.stdout || JSON.stringify(mutateRes.data || {}))
          : `ERROR: ${mutateRes.error}`;
        const mutateStep = {
          action: 'write',
          params: deterministicMutateCall.params,
          toolResult: mutateText,
          toolData: mutateRes.data,
          stepNum: mutateStepNum,
          thought: deterministicMutateCall.reason,
        };
        allSteps.push(mutateStep);
        if (wantsSSE) {
          sseEvent('tool_result', { action: 'write', result: mutateText, stepNum: mutateStepNum });
          sseEvent('step', mutateStep);
        }
        logToolAudit({ type: 'tool_result', action: 'write', result: mutateText, stepNum: mutateStepNum });

        if (!mutateRes.success) {
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            error: String(mutateRes.error || 'write_failed').slice(0, 220),
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          const blocked = buildBlockedFileOpReply({
            reason_code: 'VERIFY_FAILED',
            what_was_tried: ['scout:list/read', `mutate:${mutationMode}:write`],
            exact_input_needed: `Write failed for ${path.basename(targetPath)}. Please retry or provide a different target file.`,
          });
          return sseDone(blocked, allSteps);
        }

        setTurnExecutionStepStatus(sessionState, 'execute_changes', 'done', { completed_calls: 1 }, false);
        setTurnExecutionStatus(sessionState, 'verifying', false);
        setTurnExecutionStepStatus(sessionState, 'verify_outcome', 'running', { operation: 'deterministic_scout_mutate' }, false);
        const verify = await verifyAndRepairDeterministicFileOps(registry, [deterministicMutateCall]);
        setTurnExecutionVerification(sessionState, {
          expected: { calls: [{ tool: deterministicMutateCall.tool, params: deterministicMutateCall.params }] },
          actual: { repairs: verify.repairs, errors: verify.errors },
          status: verify.errors.length ? 'fail' : 'pass',
          repairs_applied: verify.repairs,
          errors: verify.errors,
          checked_at: Date.now(),
        }, false);
        if (verify.errors.length) {
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          const blocked = buildBlockedFileOpReply({
            reason_code: 'VERIFY_FAILED',
            what_was_tried: ['scout:list/read', `mutate:${mutationMode}:write`, 'verify+repair'],
            exact_input_needed: `Verification failed for ${path.basename(targetPath)} after one repair retry.`,
            suggested_next_prompt: `Read ${path.basename(targetPath)} and inspect the latest file contents manually.`,
          });
          return sseDone(blocked, allSteps);
        }
        rememberRecentFilePath(sessionState, String((mutateRes.data as any)?.path || targetPath));
        if (mutationMode === 'style' && styleIntent) {
          rememberLastStyleMutation(sessionState, targetPath, styleIntent);
        }
        if (verify.repairs.length) setTurnExecutionStatus(sessionState, 'repaired', false);
        persistAgentSessionState(sessionState);
        preRoutedExecuted = true;
        const extras = verify.repairs.length ? `\n${verify.repairs.join('\n')}` : '';
        return sseDone(`Updated \`${path.basename(targetPath)}\` (${rewritten.operation_type}).${extras}`, allSteps);
      }
      if (policyDecision.locked_by_policy && policyDecision.tool) {
        const registry = getToolRegistry();
        const routed = { tool: policyDecision.tool, params: policyDecision.params, reason: `Policy lock: ${policyDecision.lock_reason}`, confidence: 1 };
        appendDecisionTraceEvent(sessionState, 'selected_plan', 'Policy-locked tool execution selected.', {
          tool: routed.tool,
          params: routed.params,
          reason: policyDecision.lock_reason,
        }, false);
        const stepNum = 1;
        if (wantsSSE) {
          sseEvent('ui_preflight', { message: buildPreflightStatusMessage(routed.tool, String(policyDecision.domain || '')) });
          sseEvent('tool_call', { action: routed.tool, params: routed.params, stepNum, thought: `Policy: ${policyDecision.lock_reason}` });
        }
        logToolAudit({ type: 'tool_call', action: routed.tool, params: routed.params, thought: `Policy: ${policyDecision.lock_reason}`, stepNum, locked_by_policy: true });
        const webExec = routed.tool === 'web_search'
          ? await executeWebSearchWithSanity(routed.params, {
            expectedCountry: policyDecision.expected_country,
            expectedKeywords: policyDecision.expected_keywords,
            expectedEntityClass: policyDecision.expected_entity_class,
            domain: policyDecision.domain,
            onInfo: (msg, meta) => {
              if (wantsSSE) sseEvent('info', { message: msg, ...meta });
            },
          })
          : null;
        const toolRes = webExec ? webExec.toolRes : await registry.execute(routed.tool, routed.params);
        const effectiveParams = webExec ? webExec.finalParams : routed.params;
        const text = toolRes.success
          ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
          : `ERROR: ${toolRes.error}`;
        const step = {
          action: routed.tool,
          params: effectiveParams,
          toolResult: text,
          toolData: toolRes.data,
          stepNum,
          thought: `Policy: ${policyDecision.lock_reason}`,
          decision: { locked_by_policy: true, lock_reason: policyDecision.lock_reason },
        };
        allSteps.push(step);
        if (wantsSSE) {
          sseEvent('tool_result', {
            action: routed.tool,
            result: text,
            stepNum,
            diagnostics: (toolRes.data as any)?.search_diagnostics,
          });
          sseEvent('step', step);
        }
        collectedFacts.push(`Q: ${routingMessage}\nA: ${text}`);
        preRoutedExecuted = true;
        if (toolRes.success && routed.tool === 'time_now') {
          return sseDone(String(toolRes.stdout || '').trim() || String(toolRes.data?.iso || 'Current time retrieved.'), allSteps);
        }
      }

      if (!preRoutedExecuted && agentPolicy.natural_language_tool_router) {
        const routed = await inferNaturalToolIntent(ollama, routingMessage, sessionState, history || [], policyDecision);
        if (routed && (routed.confidence >= 0.55 || isLikelyToolDirective(routingMessage))) {
          appendDecisionTraceEvent(sessionState, 'selected_plan', 'Natural-language router selected tool execution.', {
            tool: routed.tool,
            confidence: routed.confidence,
            reason: routed.reason,
            params: routed.params,
          }, false);
          const registry = getToolRegistry();
          const stepNum = 1;
          if (wantsSSE) {
            sseEvent('ui_preflight', { message: buildPreflightStatusMessage(routed.tool, String(policyDecision.domain || '')) });
            sseEvent('tool_call', { action: routed.tool, params: routed.params, stepNum, thought: `NL router: ${routed.reason}` });
          }
          logToolAudit({ type: 'tool_call', action: routed.tool, params: routed.params, thought: `NL router: ${routed.reason}`, stepNum });
          const webExec = routed.tool === 'web_search'
            ? await executeWebSearchWithSanity(routed.params, {
              expectedCountry: policyDecision.expected_country,
              expectedKeywords: policyDecision.expected_keywords,
              expectedEntityClass: policyDecision.expected_entity_class,
              domain: policyDecision.domain,
              onInfo: (msg, meta) => {
                if (wantsSSE) sseEvent('info', { message: msg, ...meta });
              },
            })
            : null;
          const toolRes = webExec ? webExec.toolRes : await registry.execute(routed.tool, routed.params);
          const effectiveParams = webExec ? webExec.finalParams : routed.params;
          const text = toolRes.success
            ? (toolRes.stdout || JSON.stringify(toolRes.data || {}))
            : `ERROR: ${toolRes.error}`;
          const step = {
            action: routed.tool,
            params: effectiveParams,
            toolResult: text,
            toolData: toolRes.data,
            stepNum,
            thought: `NL router: ${routed.reason}`,
          };
          allSteps.push(step);
          if (wantsSSE) {
            sseEvent('tool_result', {
              action: routed.tool,
              result: text,
              stepNum,
              diagnostics: (toolRes.data as any)?.search_diagnostics,
            });
            sseEvent('step', step);
          }
          collectedFacts.push(`Q: ${routingMessage}\nA: ${text}`);

          if (toolRes.success && routed.tool === 'time_now') {
            return sseDone(String(toolRes.stdout || '').trim() || String(toolRes.data?.iso || 'Current time retrieved.'), allSteps);
          }
          if (toolRes.success && routed.tool === 'web_search' && /^Answer:\s*/im.test(text)) {
            const direct = text.match(/^Answer:\s*(.+)$/im)?.[1]?.trim();
            if (direct) return sseDone(direct, allSteps);
          }
          // Fall through to synthesis with collectedFacts so response is natural.
        }
      }
      if (preRoutedExecuted && subQuestions.length === 1) {
        skipReactorLoop = true;
      }

      if (isTenureDaysQuery(routingMessage)) {
        const tenure = await answerTenureDaysQuery(routingMessage);
        if (tenure.ok && tenure.reply) {
          const tenureNorm = normalizeUserRequest(`${routingMessage} inauguration date`);
          const tenureQuery = buildSearchQuery({
            normalized: tenureNorm,
            domain: 'event_date_fact',
            scope: { domain: 'event_date_fact' },
          });
          allSteps.push({
            action: 'web_search',
            params: { query: tenureQuery, max_results: 5 },
            toolResult: tenure.toolText || '',
            stepNum: 1,
          });
          allSteps.push({
            action: 'time_now',
            params: {},
            toolResult: 'Used current system date/time.',
            stepNum: 2,
            finalAnswer: tenure.reply,
          });
          if (wantsSSE) {
            sseEvent('ui_preflight', { message: buildPreflightStatusMessage('web_search', 'event_date_fact') });
            sseEvent('tool_call', { action: 'web_search', params: { query: tenureQuery, max_results: 5 }, stepNum: 1 });
            sseEvent('tool_result', { action: 'web_search', result: tenure.toolText || '', stepNum: 1 });
            sseEvent('ui_preflight', { message: buildPreflightStatusMessage('time_now', 'event_date_fact') });
            sseEvent('tool_call', { action: 'time_now', params: {}, stepNum: 2 });
            sseEvent('tool_result', { action: 'time_now', result: 'Used current system date/time.', stepNum: 2 });
            sseEvent('step', { finalAnswer: tenure.reply, stepNum: 2 });
          }
          return sseDone(tenure.reply, allSteps);
        }
      }

      }
      if (wantsSSE && subQuestions.length > 1) {
        sseEvent('decomposed', { questions: subQuestions });
      }

      let cyclesUsed = 0;
      for (let qi = 0; qi < subQuestions.length && !skipReactorLoop; qi++) {
        if (cyclesUsed >= maxCyclesPerTurn) {
          if (wantsSSE) sseEvent('info', { message: `Cycle cap reached (${maxCyclesPerTurn}). Stopping further sub-questions this turn.` });
          break;
        }
        const usedTools = countExecutedToolCalls(allSteps);
        const remainingTurnToolBudget = Math.max(0, maxTotalToolsPerTurn - usedTools);
        const remainingToolBudget = Math.min(maxToolsPerCycle, remainingTurnToolBudget);
        if (remainingToolBudget <= 0) {
          if (wantsSSE) sseEvent('info', { message: `Total tool cap reached (${maxTotalToolsPerTurn}). Stopping further tool steps this turn.` });
          break;
        }
        cyclesUsed += 1;
        const subQ = subQuestions[qi];
        const label = subQuestions.length > 1 ? `Q${qi + 1}` : 'agent';

        // Record where this sub-question's steps will start so we can extract tool results later
        const stepStartIndex = allSteps.length;

        const reactorInput = subQuestions.length > 1
          ? `${subQ}\n\n${buildPlanContext(sessionState)}`
          : executionInput;

        const subAnswer = await reactor.run(reactorInput, {
          maxSteps: remainingToolBudget,
          temperature: 0.1,
          label,
          skillSlugs: selectedSkillSlugs,
          nativeOnly: false, // node_call<> is primary channel
          allowHeuristicRouting: false,
          formatViolationFuse: 2,
          serverToolCall: (!preRoutedExecuted && policyDecision.locked_by_policy && policyDecision.tool)
            ? { tool: policyDecision.tool, params: policyDecision.params, reason: `Policy lock: ${policyDecision.lock_reason}` }
            : null,
          onStep: (step) => {
            allSteps.push(step);
            if (step?.thinking) {
              emitThinking(String(step.thinking), 'execute', Number(step.stepNum || 0) || undefined);
            }
            emitDecisionThinkingFromStep(step, 'execute_decision');
            if (step.isFormatViolation) {
              heartbeatState.format_violation_count += 1;
              heartbeatState.retry_count += 1;
              heartbeatState.last_progress_event_at = Date.now();
              if (wantsSSE) {
                sseEvent('heartbeat', {
                  state: 'retrying',
                  level: 'format_violation',
                  message: 'Format violation detected, retrying.',
                  ...heartbeatState,
                });
              }
              const reason = String(step.thought || '').toLowerCase();
              if (reason.includes('fallback') || reason.includes('mapped')) {
                recordTurnFailure('fallback_tool_mapping', {
                  stepNum: step.stepNum,
                  thought: step.thought || '',
                  action: step.action || '',
                });
              } else {
                recordTurnFailure('format_violation', {
                  stepNum: step.stepNum,
                  thought: step.thought || '',
                  action: step.action || '',
                });
              }
            }
            // Log every tool call/result to audit file and UI
            if (step.action) {
              logToolAudit({ type: 'tool_call', action: step.action, params: step.params, thought: step.thought, stepNum: step.stepNum });
              if (wantsSSE) {
                sseEvent('ui_preflight', { message: buildPreflightStatusMessage(step.action, '') });
                sseEvent('tool_call', { action: step.action, params: step.params, thought: step.thought, stepNum: step.stepNum });
              }
            }
            if (step.toolResult !== undefined) {
              logToolAudit({ type: 'tool_result', action: step.action, result: step.toolResult, stepNum: step.stepNum });
              try {
                if (step.action === 'list') {
                  const toolData = (step as any)?.toolData || {};
                  const listedPathRaw = String(toolData.path || step.params?.path || '.').trim() || '.';
                  const listedBase = path.isAbsolute(listedPathRaw)
                    ? listedPathRaw
                    : path.resolve(config.workspace.path, listedPathRaw);
                  const listedFiles = Array.isArray(toolData.files)
                    ? toolData.files.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 80)
                    : [];
                  if (listedFiles.length) {
                    for (const fileName of listedFiles) {
                      const candidate = path.isAbsolute(fileName)
                        ? fileName
                        : path.join(listedBase, fileName);
                      rememberRecentFilePath(sessionState, candidate);
                    }
                    sessionState.updatedAt = Date.now();
                    persistAgentSessionState(sessionState);
                  }
                } else if (!isFileOpTurnForSubsteps && step.action === 'write') {
                  const p = String((step as any)?.toolData?.path || step.params?.path || '').trim();
                  if (p) {
                    rememberRecentFilePath(sessionState, p);
                    sessionState.updatedAt = Date.now();
                    persistAgentSessionState(sessionState);
                  }
                } else if (!isFileOpTurnForSubsteps && step.action === 'rename') {
                  const from = String(step.params?.path || '').trim();
                  const to = String((step as any)?.toolData?.to || step.params?.new_path || '').trim();
                  if (from) forgetRecentFilePath(sessionState, from);
                  if (to) {
                    rememberRecentFilePath(sessionState, to);
                    sessionState.updatedAt = Date.now();
                    persistAgentSessionState(sessionState);
                  }
                }
              } catch {
                // best-effort session file tracking
              }
              if (wantsSSE) {
                sseEvent('tool_result', {
                  action: step.action,
                  result: step.toolResult,
                  stepNum: step.stepNum,
                  diagnostics: (step as any)?.toolData?.search_diagnostics,
                });
              }
              // If this was a web search, emit snippets for richer UI and auditing
              try {
                if (step.action === 'web_search' && (step as any)?.toolData?.results) {
                  const tr = (step as any).toolData;
                  const query = step.params?.query || tr.query || '';
                  const snippets = (tr.results || []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.snippet }));
                  const diagnostics = tr.search_diagnostics || null;
                  logToolAudit({ type: 'web_search_results', query, snippets, diagnostics, stepNum: step.stepNum });
                  if (wantsSSE) sseEvent('web_search_snippets', { query, snippets, diagnostics, stepNum: step.stepNum });
                }
              } catch (err) {
                // best-effort; don't crash the stream
                const msg = (err as any)?.message || String(err);
                console.warn('[server] Failed to process web_search snippets for logging:', msg);
              }
            }
            // Stream each step to the UI live as before
            if (wantsSSE) sseEvent('step', step);
          },
        });
        if (/^\s*BLOCKED\b/i.test(String(subAnswer || ''))) {
          recordTurnFailure('reactor_blocked', { question: subQ, answer: String(subAnswer || '').slice(0, 220) });
          setTurnExecutionStepStatus(sessionState, 'execute_changes', 'failed', {
            reason: 'FORMAT_VIOLATION_LOOP',
          }, false);
          setTurnExecutionStatus(sessionState, 'failed', false);
          persistAgentSessionState(sessionState);
          return sseDone(String(subAnswer || 'BLOCKED: Unable to continue.'), allSteps);
        }

        // Fast confirmation handoff: do not wait for synthesis if execute already
        // asked for destructive confirmation with open_confirm.
        {
          const subStepThinking = allSteps
            .slice(stepStartIndex)
            .map((s: any) => String(s?.thinking || '').trim())
            .filter(Boolean)
            .join('\n');
          const executeSignals = parseExecuteControlSignals(String(subAnswer || ''), subStepThinking);
          if (executeSignals.open_confirm) {
            return sseDone(String(subAnswer || ''), allSteps);
          }
        }

        // Extract steps for this sub-question and find the last tool result (if any)
        let subSteps = allSteps.slice(stepStartIndex);
        let hasWebEvidence = subSteps.some(s => s.action === 'web_search' && s.toolResult);

        // Hard freshness gate: if this is a current/factual query, do not trust model-only output.
        // Force at least one web_search tool execution before synthesis.
        if (freshnessMustUseWeb && !hasWebEvidence) {
          recordTurnFailure('forced_web_freshness', { question: subQ });
          const registry = getToolRegistry();
          const normalizedSubQ = normalizeUserRequest(subQ);
          const subPolicy = decideRoute(normalizedSubQ);
          const forcedQuery = buildSearchQuery({
            normalized: normalizedSubQ,
            domain: subPolicy.expected_entity_class || undefined,
            scope: { country: subPolicy.expected_country, domain: subPolicy.expected_entity_class || undefined },
            templates: { default: normalizedSubQ.search_text || subQ },
            expected_keywords: subPolicy.expected_keywords,
          });
          const forcedParams = { query: forcedQuery, max_results: 5 };
          const forcedStepNum = allSteps.length + 1;
          if (wantsSSE) {
            sseEvent('ui_preflight', { message: buildPreflightStatusMessage('web_search', String(subPolicy.domain || '')) });
            sseEvent('tool_call', { action: 'web_search', params: forcedParams, stepNum: forcedStepNum });
          }
          logToolAudit({ type: 'tool_call', action: 'web_search', params: forcedParams, thought: 'Server freshness policy forced web verification.', stepNum: forcedStepNum });
          const forcedExec = await executeWebSearchWithSanity(forcedParams, {
            expectedCountry: subPolicy.expected_country,
            expectedKeywords: subPolicy.expected_keywords,
            expectedEntityClass: subPolicy.expected_entity_class,
            domain: subPolicy.domain,
            onInfo: (msg, meta) => {
              if (wantsSSE) sseEvent('info', { message: msg, ...meta });
            },
          });
          const forcedResult = forcedExec.toolRes;
          const effectiveForcedParams = forcedExec.finalParams;
          const forcedText = forcedResult.success
            ? (forcedResult.stdout || JSON.stringify(forcedResult.data || {}))
            : `ERROR: ${forcedResult.error}`;
          const forcedStep = {
            thought: 'Server freshness policy forced web verification.',
            action: 'web_search',
            params: effectiveForcedParams,
            stepNum: forcedStepNum,
            toolResult: forcedText,
            toolData: forcedResult.data,
          };
          allSteps.push(forcedStep);
          subSteps = allSteps.slice(stepStartIndex);
          hasWebEvidence = subSteps.some(s => s.action === 'web_search' && s.toolResult);
          logToolAudit({ type: 'tool_result', action: 'web_search', result: forcedText, stepNum: forcedStepNum });
          if (wantsSSE) {
            sseEvent('tool_result', {
              action: 'web_search',
              result: forcedText,
              stepNum: forcedStepNum,
              diagnostics: (forcedResult.data as any)?.search_diagnostics,
            });
            sseEvent('step', forcedStep);
          }
        }

        const lastToolStep = [...subSteps].reverse().find(s => s.toolResult || s.finalAnswer);
        const lastToolText = lastToolStep ? (lastToolStep.finalAnswer || lastToolStep.toolResult || '') : '';
        const toolNames = Array.from(new Set(subSteps.map(s => String(s.action || '').trim()).filter(Boolean)));
        const sourceLinks = Array.from(String(lastToolText || '').matchAll(/https?:\/\/[^\s)]+/g)).map(m => m[0]).slice(0, 5);

        // Store a compact fact including the tool result to ensure fallback always has useful data
        const factEntry = `Q: ${subQ}\nA: ${subAnswer || ''}${lastToolText ? '\nTOOL: ' + lastToolText : ''}`;
        collectedFacts.push(factEntry);

        // crude execution progress tracking for compact plan memory
        if (subAnswer && !subAnswer.startsWith('Error') && sessionState.tasks.length > 0) {
          sessionState.summary = compactLines([...sessionState.notes, `Executed: ${subQ}`, `Result: ${subAnswer.slice(0, 140)}`], 8).join(' | ');
          sessionState.updatedAt = Date.now();
          persistAgentSessionState(sessionState);
        }
        const lastTurn = sessionState.turns[sessionState.turns.length - 1];
        if (lastTurn && (lastTurn.kind === 'continue_plan' || lastTurn.kind === 'new_objective' || lastTurn.kind === 'side_question')) {
          if (subAnswer && !subAnswer.startsWith('Error') && !subAnswer.startsWith('Max steps')) {
            lastTurn.status = 'completed';
            appendDailyMemoryNote(`[objective_completed] session=${sid} objective="${subQ}"`);
          } else {
            lastTurn.status = 'blocked';
          }
        }

        // Persist evidence metadata for natural follow-up questions like
        // "where did you get that info from?"
        if (subAnswer && !subAnswer.startsWith('Error') && !subAnswer.startsWith('Max steps')) {
          const answerSummary = (
            extractCurrentSentence(subQ, String(lastToolText || '')) ||
            String(subAnswer || '').replace(/\s+/g, ' ').trim()
          ).slice(0, 220);
          sessionState.lastEvidence = {
            question: subQ,
            answer_summary: answerSummary,
            tools: toolNames,
            topSources: sourceLinks,
            generatedAt: Date.now(),
          };
          sessionState.updatedAt = Date.now();
          persistAgentSessionState(sessionState);
        }

        // Cross-mode consistency lock: store last verified fact claims from tool-backed evidence.
        if (hasWebEvidence) {
          const webFacts = (lastToolStep as any)?.toolData?.facts;
          const webSources = Array.isArray((lastToolStep as any)?.toolData?.sources)
            ? (lastToolStep as any).toolData.sources.map((s: any) => String(s?.url || '').trim()).filter((u: string) => /^https?:\/\//.test(u))
            : sourceLinks;
          const firstClaim = Array.isArray(webFacts) && webFacts[0]?.claim ? String(webFacts[0].claim).trim() : '';
          const extracted = extractCurrentSentence(subQ, String(lastToolText || '')) || '';
          const claimText = (firstClaim || extracted || '').trim();
          if (claimText && isMemorySafeFact(claimText)) {
            rememberVerifiedFact(sessionState, {
              key: `vf:${normalizeFactKey(subQ)}`,
              value: extractPrimaryDateToken(claimText) || claimText.slice(0, 120),
              claim_text: claimText,
              sources: webSources,
              ttl_minutes: needsFreshLookup(subQ) ? 240 : 720,
              confidence: Array.isArray(webFacts) && typeof webFacts[0]?.confidence === 'number' ? Number(webFacts[0].confidence) : 0.85,
              fact_type: inferFactTypeFromQuestion(subQ),
              requires_reverify_on_use: isMustVerifyDomain(inferFactTypeFromQuestion(subQ)),
              question: subQ,
            });
            sessionState.updatedAt = Date.now();
            persistAgentSessionState(sessionState);
          }
        }

        // Unified memory write policy: write from grounded claim only (not raw subAnswer dumps).
        if (subAnswer && !subAnswer.startsWith('Error') && !subAnswer.startsWith('Max steps')) {
          try {
            const workspaceId = computeWorkspaceId();
            const sourceUrl = Array.from(String(lastToolText || '').matchAll(/https?:\/\/[^\s)]+/g)).map(m => m[0])[0];
            const webFacts = (lastToolStep as any)?.toolData?.facts;
            const fromToolFacts = Array.isArray(webFacts) && webFacts[0]?.claim ? String(webFacts[0].claim).trim() : '';
            const extracted = extractCurrentSentence(subQ, String(lastToolText || '')) || '';
            const grounded = (fromToolFacts || extracted || subAnswer || '').replace(/\s+/g, ' ').trim().slice(0, 420);
            const canStore = isMemorySafeFact(grounded) && (!freshnessQuery || (hasWebEvidence && agentPolicy.auto_store_web_facts));
            if (canStore) {
              const memRes = await addMemoryFact({
                fact: grounded,
                type: freshnessQuery ? 'fact' : 'decision',
                scope: freshnessQuery ? 'global' : 'session',
                workspace_id: workspaceId,
                agent_id: 'main',
                session_id: sid,
                source_kind: hasWebEvidence ? 'web' : 'tool',
                source_ref: sourceUrl || `toolrun:${turnId}:${qi + 1}`,
                confidence: freshnessQuery ? (hasWebEvidence ? 0.9 : 0.6) : 0.7,
                routing: 'policy',
              });
              if (!memRes.success) console.warn('[server] addMemoryFact(policy) failed:', memRes.message);
            }
          } catch (err: any) {
            console.error('[server] Failed unified memory persist:', err?.message || err);
          }
        }

        sessionState.updatedAt = Date.now();
        persistAgentSessionState(sessionState);
      }

      // Synthesize gathered answers (also for single-question flows to avoid
      // returning raw tool payloads directly).
      console.log('[server] Synthesizing', subQuestions.length, 'answers...');
      if (wantsSSE) sseEvent('synthesizing', { count: subQuestions.length });
      const systemPrompt = buildSystemPrompt({
        includeSkillSlugs: selectedSkillSlugs,
        includeMemory: !freshnessQuery,
        extraInstructions: [getRuntimeFreshnessInstruction(), buildScopedMemoryInstruction(routingMessage, sid, freshnessQuery), buildVerifiedFactsHeader(sessionState)].filter(Boolean).join('\n\n'),
      });
      // Filter out empty or errored facts before synthesis
      const filteredFacts = collectedFacts.filter((f: string) => {
        if (!f || !f.toString().trim()) return false;
        const s = f.toString().trim();
        if (/^(Error|ERROR|Max steps|ERROR:)/i.test(s)) return false;
        if (s.replace(/\s+/g, '').length < 10) return false;
        return true;
      });

      const factsToSynthesize = filteredFacts.length ? filteredFacts : collectedFacts;
      if (!filteredFacts.length && freshnessQuery) {
        if (agentPolicy.memory_fallback_on_search_failure) {
          const memFallback = getMemoryFallbackForQuery(routingMessage);
          if (memFallback) {
            recordTurnFailure('memory_fallback', { query: executionObjectiveForTurn });
            const reply = `I could not verify live sources right now. Last stored memory says: ${memFallback}\n\nThis may be outdated; retry when search is available.`;
            return sseDone(reply, allSteps);
          }
        }
      }

      const isFreshFactualQuery = isQuestionLike(executionObjectiveForTurn) && needsFreshLookup(executionObjectiveForTurn);
      const webStepWithData = [...allSteps].reverse().find((s: any) =>
        s?.action === 'web_search'
        && s?.toolData
        && (Array.isArray(s.toolData?.results) || Array.isArray(s.toolData?.facts))
      );

      if (FEATURE_FLAGS.attribution_fetch_gate && isAttributionSensitiveQuery(executionObjectiveForTurn) && webStepWithData?.toolData) {
        try {
          const toolData = webStepWithData.toolData || {};
          const searchResults = Array.isArray(toolData?.results)
            ? toolData.results.map((r: any) => ({
              title: String(r?.title || ''),
              url: String(r?.url || ''),
              snippet: String(r?.snippet || ''),
            }))
            : parseTopSearchResults(String(webStepWithData?.toolResult || ''), 5);
          const hasDirectAttribution = snippetsContainDirectAttribution(searchResults, executionObjectiveForTurn);
          const topUrl = pickTopSearchUrl(toolData, String(webStepWithData?.toolResult || ''));
          if (!hasDirectAttribution && /^https?:\/\//i.test(topUrl)) {
            const stepNum = allSteps.length + 1;
            if (wantsSSE) {
              sseEvent('ui_preflight', { message: 'Fetching full source text for direct-attribution verification...' });
              sseEvent('tool_call', { action: 'web_fetch', params: { url: topUrl, max_chars: 12000 }, stepNum, thought: 'Attribution gate: snippets lacked direct quote/attribution evidence.' });
            }
            logToolAudit({ type: 'tool_call', action: 'web_fetch', params: { url: topUrl, max_chars: 12000 }, thought: 'Attribution gate: snippets lacked direct quote/attribution evidence.', stepNum });
            const fetchRes = await getToolRegistry().execute('web_fetch', { url: topUrl, max_chars: 12000 });
            const fetchText = fetchRes.success
              ? String(fetchRes.stdout || JSON.stringify(fetchRes.data || {}))
              : `ERROR: ${String(fetchRes.error || 'web_fetch_failed')}`;
            const fetchStep = {
              action: 'web_fetch',
              params: { url: topUrl, max_chars: 12000 },
              toolResult: fetchText,
              toolData: fetchRes.data,
              stepNum,
              thought: 'Attribution gate: full-page fetch for evidence.',
            };
            allSteps.push(fetchStep);
            logToolAudit({ type: 'tool_result', action: 'web_fetch', result: fetchText, stepNum });
            if (wantsSSE) {
              sseEvent('tool_result', { action: 'web_fetch', result: fetchText, stepNum });
              sseEvent('step', fetchStep);
            }
            if (fetchRes.success && fetchText.trim()) {
              collectedFacts.push(`Q: ${executionObjectiveForTurn}\nA: ${fetchText}\nSOURCE: ${topUrl}`);
              appendDecisionTraceEvent(sessionState, 'execution', 'Attribution gate fetched full source text before synthesis.', {
                url: topUrl,
                chars: fetchText.length,
              }, false);
            } else {
              appendDecisionTraceEvent(sessionState, 'execution', 'Attribution gate fetch failed; proceeding with snippet evidence only.', {
                url: topUrl,
                error: String(fetchRes.error || 'unknown error'),
              }, false);
            }
          }
        } catch (err: any) {
          appendDecisionTraceEvent(sessionState, 'execution', 'Attribution gate encountered an error; proceeding with available evidence.', {
            error: String(err?.message || err || 'unknown'),
          }, false);
        }
      }

      // Fast-path prefilter: only short-circuit when an explicit complete answer
      // is already present in tool output. Otherwise, prefer LLM synthesis first.
      if (subQuestions.length === 1 && factsToSynthesize.length > 0) {
        const first = factsToSynthesize[0];
        const cleanA = first.match(/\nA:\s*([^\n]+)\n?/i)?.[1]?.trim();
        const direct = first.match(/\nTOOL:\s*Answer:\s*([^\n]+)/i)?.[1]?.trim()
          || first.match(/\nA:\s*Answer:\s*([^\n]+)/i)?.[1]?.trim();
        if (direct && !isLowQualityFinalReply(direct)) {
          return sseDone(direct, allSteps);
        }
        if (
          cleanA &&
          cleanA.length > 0 &&
          !/^error|^max steps/i.test(cleanA) &&
          !/https?:\/\//i.test(cleanA) &&
          !/^\[\d+\]/.test(cleanA) &&
          cleanA.length < 280
        ) {
          if (!isLowQualityFinalReply(cleanA)) return sseDone(cleanA, allSteps);
        }
      }

      // Log synthesis inputs for debugging
      console.log('[server] Synthesis inputs (filtered):', factsToSynthesize);
      if (wantsSSE) sseEvent('synth_inputs', { facts: factsToSynthesize });

      let reply: string | null = null;
      try {
        if (!filteredFacts.length) {
          console.warn('[server] No valid facts after filtering; proceeding with unfiltered facts to preserve information.');
        }
        const synthOut = await ollama.synthesizeWithThinking(factsToSynthesize, executionObjectiveForTurn, systemPrompt, THINK_LEVEL);
        reply = synthOut.response;
        if (synthOut.thinking && synthOut.thinking.trim()) {
          emitThinking(synthOut.thinking.trim(), 'synthesis');
        }
        if (!reply || !reply.trim()) {
          throw new Error('Synthesis returned empty response.');
        }
        reply = await repairTemporalContradiction(ollama, systemPrompt, executionObjectiveForTurn, reply);
        reply = await repairAnswerForm(ollama, systemPrompt, executionObjectiveForTurn, reply);
        reply = await resolveContradictionTiered(reply, executionObjectiveForTurn);
        console.log('[server] Synthesis complete. Reply length:', reply.length);
        if (wantsSSE) sseEvent('synth_success', { reply: reply.slice(0, 200) });

        // Persist synthesis log
        try {
          db.createSynthesisLog({ id: randomUUID(), reference: undefined, facts: factsToSynthesize, reply: reply ?? undefined });
        } catch (dbErr: any) {
          console.error('[server] Failed to persist synthesis log:', dbErr?.message || dbErr);
        }

        sseDone(reply, allSteps);
      } catch (synthErr: any) {
        const errorMsg = `[SYNTHESIS ERROR] ${synthErr?.message || synthErr}`;
        console.error(errorMsg);
        recordTurnFailure('synthesis_failure', { error: synthErr?.message || String(synthErr) });
        if (wantsSSE) sseEvent('synth_failure', { error: errorMsg });

        // Persist synthesis failure
        try {
          db.createSynthesisLog({ id: randomUUID(), reference: undefined, facts: factsToSynthesize, reply: undefined, error: errorMsg });
        } catch (dbErr: any) {
          console.error('[server] Failed to persist synthesis log (failure):', dbErr?.message || dbErr);
        }

        // AI-first rescue for web runs: when synthesis fails, try one direct
        // LLM summary pass grounded in web tool evidence before deterministic fallback.
        try {
          const toolData: any = webStepWithData?.toolData || null;
          const resultRows = Array.isArray(toolData?.results) ? toolData.results.slice(0, 6) : [];
          const factRows = Array.isArray(toolData?.facts) ? toolData.facts.slice(0, 6) : [];
          const resultsBlock = resultRows
            .map((r: any, i: number) => {
              const title = String(r?.title || '').trim();
              const url = String(r?.url || '').trim();
              const snippet = String(r?.snippet || '').replace(/\s+/g, ' ').trim();
              return `[${i + 1}] ${title}\nURL: ${url}\nSnippet: ${snippet}`;
            })
            .filter(Boolean)
            .join('\n\n');
          const factsBlock = factRows
            .map((f: any, i: number) => {
              const text = String(f?.text || f?.fact || f?.summary || '').replace(/\s+/g, ' ').trim();
              const source = String(f?.source || f?.url || '').trim();
              return `[F${i + 1}] ${text}${source ? ` (source: ${source})` : ''}`;
            })
            .filter(Boolean)
            .join('\n');
          const rawTool = String(webStepWithData?.toolResult || '').trim().slice(0, 5000);
          const rawFactsFallback = String((factsToSynthesize || []).join('\n\n') || (collectedFacts || []).join('\n\n'))
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 5000);
          const evidenceBlock = [
            resultsBlock ? `Top results:\n${resultsBlock}` : '',
            factsBlock ? `Extracted facts:\n${factsBlock}` : '',
            (!resultsBlock && !factsBlock && rawTool) ? `Raw tool output:\n${rawTool}` : '',
            (!resultsBlock && !factsBlock && !rawTool && rawFactsFallback) ? `Captured facts:\n${rawFactsFallback}` : '',
          ].filter(Boolean).join('\n\n');

          if (evidenceBlock) {
            if (wantsSSE) {
              sseEvent('info', { message: 'Synthesis failed; attempting AI web-summary rescue from tool evidence.' });
            }
            const rescuePrompt = [
              `User request: ${executionObjectiveForTurn}`,
              `Use ONLY the web evidence below to answer.`,
              evidenceBlock,
              `Write a concise answer (3-6 sentences) with concrete details from evidence.`,
              `If evidence conflicts, state that briefly.`,
              `Add a "Sources:" list with up to 3 URLs from the evidence.`,
              `Do not say you could not extract an answer unless evidence is truly insufficient.`,
              `Answer:`,
            ].join('\n\n');
            const rescueOut = await ollama.generateWithRetryThinking(rescuePrompt, 'executor', {
              temperature: 0.15,
              system: 'You summarize web search evidence for the user. No tool calls. No JSON.',
              num_ctx: 3072,
              num_predict: 260,
              think: 'low',
            });
            const { cleaned: rescueCleaned, inlineThinking: rescueInlineThinking } = stripThinkTags(rescueOut.response || '');
            const rescueThinking = mergeThinking(rescueOut.thinking || '', rescueInlineThinking);
            if (rescueThinking) emitThinking(rescueThinking, 'synthesis_rescue');
            let rescueReply = stripProtocolArtifacts(String(rescueCleaned || '')).trim();
            if (rescueReply) {
              rescueReply = await repairTemporalContradiction(ollama, systemPrompt, executionObjectiveForTurn, rescueReply);
              rescueReply = await repairAnswerForm(ollama, systemPrompt, executionObjectiveForTurn, rescueReply);
              rescueReply = await resolveContradictionTiered(rescueReply, executionObjectiveForTurn);
            }
            if (rescueReply && !isLowQualityFinalReply(rescueReply)) {
              if (wantsSSE) sseEvent('synth_success', { reply: rescueReply.slice(0, 200), rescue: true });
              return sseDone(rescueReply, allSteps);
            }
          }
        } catch (rescueErr: any) {
          if (wantsSSE) sseEvent('info', { message: `AI web-summary rescue failed: ${String(rescueErr?.message || rescueErr || 'unknown')}` });
        }

        const firstFact = String(factsToSynthesize[0] || collectedFacts[0] || '');
        const deterministicFallback = (() => {
          if (!firstFact && !webStepWithData?.toolData) return '';
          if (policyDecision.domain === 'office_holder' && webStepWithData?.toolData) {
            const office = extractOfficeHolderAnswerFromResults(webStepWithData.toolData);
            if (office?.answer) {
              const src = office.sources.slice(0, 2);
              return src.length
                ? `${office.answer}\n\nSources:\n${src.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
                : office.answer;
            }
          }
          if (webStepWithData?.toolData) {
            const evReply = buildEvidenceReplyFromToolData(webStepWithData.toolData);
            if (evReply && !isLowQualityFinalReply(evReply)) return evReply;
          }
          const eventSummary = buildEventOutcomeSummary(executionObjectiveForTurn, firstFact);
          if (eventSummary) return eventSummary;
          const extracted = extractCurrentSentence(executionObjectiveForTurn, firstFact);
          if (extracted) return extracted;
          if (isFreshFactualQuery) {
            const topLinks = Array.from(firstFact.matchAll(/https?:\/\/[^\s)]+/g)).slice(0, 3).map(m => m[0]);
            if (topLinks.length > 0) {
              return `I couldn't extract a reliable answer from the snippets alone. Here are the top sources I checked:\n${topLinks.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;
            }
          }
          return '';
        })();
        if (deterministicFallback) return sseDone(deterministicFallback, allSteps);
        if (wantsSSE) {
          sseEvent('error', { message: errorMsg });
          const topLinks = Array.from(collectedFacts.join('\n').matchAll(/https?:\/\/[^\s)]+/g)).slice(0, 3).map(m => m[0]);
          const fallbackReply = topLinks.length
            ? `I could not synthesize a reliable final answer. Please check these sources:\n${topLinks.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
            : 'I could not synthesize a reliable final answer from available tool output.';
          return sseDone(fallbackReply, allSteps);
        }
        const topLinks = Array.from(collectedFacts.join('\n').matchAll(/https?:\/\/[^\s)]+/g)).slice(0, 3).map(m => m[0]);
        const fallbackReply = topLinks.length
          ? `I could not synthesize a reliable final answer. Please check these sources:\n${topLinks.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
          : 'I could not synthesize a reliable final answer from available tool output.';
        return sseDone(fallbackReply, allSteps);
      }

      } while (continuationPending); // continuationLoop

    } else {
      // Plain chat — no tools
      if (requiresToolExecutionForTurn(normalizedMessage, sessionState)) {
        bumpDecisionMetric('discuss_when_should_execute');
        const blockedReply = 'That request needs tool execution. Switch to Agent mode or send with /exec and I will run it for real.';
        return sseDone(blockedReply, []);
      }
      const selectedSkillSlugs = selectSkillSlugsForMessage(normalizedMessage, 2);
      const systemPrompt = buildSystemPrompt({
        includeSkillSlugs: selectedSkillSlugs,
        includeMemory: !needsFreshLookup(normalizedMessage),
        extraInstructions: [
          getRuntimeFreshnessInstruction(),
          buildScopedMemoryInstruction(normalizedMessage, sid, needsFreshLookup(normalizedMessage)),
          buildVerifiedFactsHeader(sessionState),
          'CHAT-ONLY MODE: Do not claim any tool execution. Do not claim files were created/edited/deleted or commands were run.',
          'If a request needs tools, clearly say the user should switch to Agent mode or use /exec.',
        ].filter(Boolean).join('\n\n'),
      });
      const historyText = summarizeHistoryForPrompt(history || [], 8);
      const prompt = historyText ? `${historyText}\nUser: ${normalizedMessage}\nAssistant:` : normalizedMessage;

      console.log(`[chat] ▶ USER   ${normalizedMessage.slice(0, 120)}`);
      const out = await ollama.generateWithRetryThinking(prompt, 'executor', {
        temperature: 0.7,
        system: systemPrompt || 'You are a helpful assistant. Be direct and concise.',
        num_ctx: SMALL_MODEL_TUNING.chat_num_ctx,
        num_predict: SMALL_MODEL_TUNING.chat_num_predict,
        think: SMALL_MODEL_TUNING.chat_think,
      });
      const { cleaned, inlineThinking } = stripThinkTags(out.response);
      const thinking = mergeThinking(out.thinking || '', inlineThinking);
      emitThinking(thinking, 'chat');
      let safeReply = stripProtocolArtifacts(cleaned || out.response.trim());
      safeReply = await repairTemporalContradiction(ollama, systemPrompt, normalizedMessage, safeReply);
      safeReply = await resolveContradictionTiered(safeReply, normalizedMessage);
      safeReply = sanitizeDiscussReplyForNoToolClaims(safeReply);
      if (isConversationIntent(normalizedMessage) || isReactionLikeMessage(normalizedMessage)) {
        safeReply = enforceChatStyle(safeReply);
      }
      console.log(`[chat] ★ REPLY  ${safeReply.slice(0, 120)}`);
      sseDone(safeReply || 'I can help with that. Could you rephrase it in one sentence?', []);
    }
  } catch (err: any) {
    console.error('[chat] ERROR:', err.message);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (!hasFinalizedTurnExecution && executionSessionState?.currentTurnExecution) {
      setTurnExecutionStatus(executionSessionState, 'failed', false);
      setTurnExecutionStepStatus(executionSessionState, 'execute_changes', 'failed', {
        error: String(err?.message || 'unknown error').slice(0, 220),
      }, false);
      finalizeCurrentTurnExecution(executionSessionState, 'failed', `Execution failed: ${String(err?.message || 'unknown error')}`);
      hasFinalizedTurnExecution = true;
      if (wantsSSE) sseEvent('turn_execution_updated', { execution: executionSessionState.currentTurnExecution });
    }
    if (wantsSSE) {
      sseEvent('error', { message: err.message });
      res.end();
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── ClawHub Skills API ──────────────────────────────────────────────────────
app.get('/api/skills', async (_req, res) => {
  const result = await executeSkillList({});
  if (!result.success) return res.status(500).json(result);
  res.json({ skills: (result.data as any)?.skills || [], message: result.stdout });
});

app.get('/api/skills/search', async (req, res) => {
  const q = req.query.q as string;
  if (!q) return res.status(400).json({ error: 'q query param required' });
  const result = await executeSkillSearch({ query: q });
  res.json(result);
});

app.post('/api/skills/install', async (req, res) => {
  const { slug, confirmed } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const result = await executeSkillInstall({ slug, confirmed });
  res.json(result);
});

app.post('/api/skills/upload', async (req, res) => {
  const skillMd = String(req.body?.skill_md || '').trim();
  const skillId = String(req.body?.skill_id || '').trim();
  const filename = String(req.body?.filename || '').trim();
  if (!skillMd) return res.status(400).json({ error: 'skill_md required' });
  const result = await executeSkillUpload({ skill_md: skillMd, skill_id: skillId || undefined, filename: filename || undefined });
  res.json(result);
});

app.get('/api/skills/:slug', async (req, res) => {
  const result = await executeSkillInspect({ slug: req.params.slug });
  if (!result.success) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/skills/:slug/enable', async (req, res) => {
  const enabled = !!req.body?.enabled;
  const result = await executeSkillSetEnabled({ slug: req.params.slug, enabled });
  if (!result.success) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/skills/:slug/rescan', async (req, res) => {
  const result = await executeSkillRescan({ slug: req.params.slug });
  if (!result.success) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/skills/:slug/exec', async (req, res) => {
  const result = await executeSkillExec({
    slug: req.params.slug,
    action: req.body?.action,
    command: req.body?.command,
    params: req.body?.params,
    confirmed: !!req.body?.confirmed,
    dry_run: !!req.body?.dry_run,
    cwd: req.body?.cwd,
  });
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

app.delete('/api/skills/:slug', async (req, res) => {
  const result = await executeSkillRemove({ slug: req.params.slug });
  res.json(result);
});

// Memory confirmation endpoint (UI calls this to accept a suggested memory fact)
app.post('/api/memory/confirm', async (req, res) => {
  const { fact, key, action, scope, session_id, confidence, source_url, reference, source_tool, source_output, actor } = req.body;
  if (!fact) return res.status(400).json({ error: 'fact required' });
  try {
    const result = await addMemoryFact({ fact, key, action, scope, session_id, confidence, source_url, reference, source_tool, source_output, actor });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/facts', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const session_id = String(req.query.session_id || '').trim() || undefined;
    const maxRaw = Number(req.query.max || 50);
    const max = Number.isFinite(maxRaw) ? Math.min(Math.max(maxRaw, 1), 500) : 50;
    const includeStale = String(req.query.include_stale || 'true').toLowerCase() !== 'false';
    const facts = queryFactRecords({
      query: q || '',
      session_id,
      includeGlobal: true,
      includeStale,
      max,
    });
    res.json({ ok: true, count: facts.length, facts });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/agent/session/:id', async (req, res) => {
  const sid = String(req.params.id || 'default').trim() || 'default';
  const s = getAgentSessionState(sid);
  const tasks = s.tasks || [];
  const turns = s.turns || [];
  const currentExecution = s.currentTurnExecution ? cloneTurnExecution(s.currentTurnExecution) : null;
  const recentExecutions = Array.isArray(s.recentTurnExecutions) ? s.recentTurnExecutions.map(cloneTurnExecution) : [];
  const taskCounts = {
    total: tasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    done: tasks.filter(t => t.status === 'done').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  };
  const turnCounts = {
    total: turns.length,
    open: turns.filter(t => t.status === 'open').length,
    completed: turns.filter(t => t.status === 'completed').length,
    blocked: turns.filter(t => t.status === 'blocked').length,
  };
  const allExecutions = [currentExecution, ...recentExecutions].filter(Boolean) as TurnExecution[];
  const executionCounts = {
    total: allExecutions.length,
    planned: allExecutions.filter(x => x.status === 'planned').length,
    running: allExecutions.filter(x => x.status === 'running').length,
    verifying: allExecutions.filter(x => x.status === 'verifying').length,
    repaired: allExecutions.filter(x => x.status === 'repaired').length,
    done: allExecutions.filter(x => x.status === 'done').length,
    failed: allExecutions.filter(x => x.status === 'failed').length,
  };
  res.json({
    session_schema_version: 2,
    sessionId: sid,
    mode_lock: s.modeLock || 'unlocked',
    mode: s.mode,
    overview_objective: s.objective || '',
    active_objective: s.activeObjective || '',
    summary: s.summary || '',
    task_counts: taskCounts,
    turn_counts: turnCounts,
    tasks: tasks.slice(0, 20),
    recent_turns: turns.slice(-8).reverse(),
    execution_counts: executionCounts,
    current_turn_execution: currentExecution,
    recent_turn_executions: recentExecutions.slice(0, 12),
    pending_confirmation: s.pendingConfirmation || null,
    decision_telemetry: decisionTelemetry,
    feature_flags: FEATURE_FLAGS,
    updated_at: s.updatedAt,
  });
});

app.get('/api/agent/failures', async (req, res) => {
  try {
    const sessionIdRaw = String(req.query.session_id || '').trim();
    const sessionId = sessionIdRaw || undefined;
    const limitRaw = Number(req.query.limit || 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 100;
    const rows = db.listAgentFailures(sessionId, limit);
    res.json({ ok: true, count: rows.length, failures: rows });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Settings API: get/update allowed paths for file tools
app.get('/api/settings/paths', async (_req, res) => {
  const cfgm = getConfig();
  const cfg = cfgm.getConfig();
  res.json({ allowed_paths: cfg.tools.permissions.files.allowed_paths, blocked_paths: cfg.tools.permissions.files.blocked_paths });
});

app.post('/api/settings/paths', async (req, res) => {
  const { allowed_paths, blocked_paths } = req.body;
  if (!Array.isArray(allowed_paths) && !Array.isArray(blocked_paths)) return res.status(400).json({ error: 'allowed_paths or blocked_paths required' });
  try {
    const cfgm = getConfig();
    const cfg = cfgm.getConfig();
    if (Array.isArray(allowed_paths)) {
      const resolved = allowed_paths.map((p: string) => path.resolve(p));
      cfg.tools.permissions.files.allowed_paths = resolved;
    }
    if (Array.isArray(blocked_paths)) {
      const resolvedB = blocked_paths.map((p: string) => path.resolve(p));
      cfg.tools.permissions.files.blocked_paths = resolvedB;
    }
    cfgm.updateConfig({ tools: cfg.tools });
    cfgm.ensureDirectories();
    res.json({ ok: true, files: cfg.tools.permissions.files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/search', async (_req, res) => {
  try {
    const raw = readRawLocalConfig();
    const search = raw.search || {};
    res.json({
      preferred_provider: search.preferred_provider || 'tavily',
      search_rigor: search.search_rigor || 'verified',
      tavily_api_key: search.tavily_api_key || '',
      google_api_key: search.google_api_key || '',
      google_cx: search.google_cx || '',
      brave_api_key: search.brave_api_key || '',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/search', async (req, res) => {
  try {
    const {
      preferred_provider,
      search_rigor,
      tavily_api_key,
      google_api_key,
      google_cx,
      brave_api_key,
    } = req.body || {};

    const raw = readRawLocalConfig();
    raw.search = {
      ...(raw.search || {}),
      preferred_provider: preferred_provider || raw.search?.preferred_provider || 'tavily',
      search_rigor: (search_rigor === 'fast' || search_rigor === 'strict' || search_rigor === 'verified')
        ? search_rigor
        : (raw.search?.search_rigor || 'verified'),
      tavily_api_key: tavily_api_key ?? raw.search?.tavily_api_key ?? '',
      google_api_key: google_api_key ?? raw.search?.google_api_key ?? '',
      google_cx: google_cx ?? raw.search?.google_cx ?? '',
      brave_api_key: brave_api_key ?? raw.search?.brave_api_key ?? '',
    };
    writeRawLocalConfig(raw);
    res.json({ ok: true, search: raw.search });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/agent', async (_req, res) => {
  try {
    res.json(getAgentPolicy());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/agent', async (req, res) => {
  try {
    const raw = readRawLocalConfig();
    const prev = raw.agent_policy || {};
    raw.agent_policy = {
      ...prev,
      force_web_for_fresh: req.body?.force_web_for_fresh !== false,
      memory_fallback_on_search_failure: req.body?.memory_fallback_on_search_failure !== false,
      auto_store_web_facts: req.body?.auto_store_web_facts !== false,
      natural_language_tool_router: req.body?.natural_language_tool_router !== false,
      retrieval_mode: (req.body?.retrieval_mode === 'fast' || req.body?.retrieval_mode === 'deep' || req.body?.retrieval_mode === 'standard')
        ? req.body.retrieval_mode
        : (prev.retrieval_mode || 'standard'),
    };
    writeRawLocalConfig(raw);
    res.json({ ok: true, agent_policy: raw.agent_policy });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket - real-time updates
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[Gateway] Client connected (${clients.size} total)`);

  // Send current state on connect
  ws.send(JSON.stringify({ type: 'connected', message: 'LocalClaw Gateway ready' }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'run_mission') {
        const jobId = await orchestrator.executeJob(msg.mission);
        ws.send(JSON.stringify({ type: 'job_created', jobId }));
      }

      if (msg.type === 'get_jobs') {
        const jobs = db.listJobs();
        ws.send(JSON.stringify({ type: 'jobs', jobs }));
      }

    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[Gateway] Client disconnected (${clients.size} total)`);
  });
});

// Poll job changes and broadcast to UI
if (process.env.LOCALCLAW_DISABLE_SERVER !== '1') {
  let lastJobSnapshot = '';
  const poll = setInterval(() => {
    try {
      const jobs = db.listJobs();
      const snapshot = JSON.stringify(jobs.map(j => ({ id: j.id, status: j.status })));
      if (snapshot !== lastJobSnapshot) {
        lastJobSnapshot = snapshot;
        broadcast({ type: 'jobs_update', jobs });
      }
    } catch {}
  }, 1500);
  // Avoid keeping process alive on shutdown races.
  (poll as any).unref?.();
}

function flushAgentSessionsToDailyMemory(reason: string): void {
  try {
    const now = new Date().toISOString();
    for (const s of agentSessions.values()) {
      if (!s.sessionId) continue;
      const summary = String(s.summary || '').trim();
      const active = String(s.activeObjective || s.objective || '').trim();
      if (!summary && !active) continue;
      appendDailyMemoryNote(`[flush:${reason}] session=${s.sessionId} time=${now} objective="${active}" summary="${summary}"`);
    }
  } catch (err: any) {
    console.warn('[server] Failed to flush agent sessions to daily memory:', err?.message || err);
  }
}

if (process.env.LOCALCLAW_DISABLE_SERVER !== '1') {
  process.on('SIGINT', () => {
    flushAgentSessionsToDailyMemory('sigint');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    flushAgentSessionsToDailyMemory('sigterm');
    process.exit(0);
  });
}

// Start server
const PORT = config.gateway.port;
const HOST = config.gateway.host;

if (process.env.LOCALCLAW_DISABLE_SERVER !== '1') {
  httpServer.listen(PORT, HOST, () => {
    console.log('');
    console.log('ðŸ¦ž LocalClaw Gateway running!');
    console.log(`   Open in browser: http://${HOST}:${PORT}`);
    console.log(`   WebSocket: ws://${HOST}:${PORT}`);
    console.log('');
    console.log('   Press Ctrl+C to stop');
    console.log('');
  });
}

export { broadcast };
export {
  normalizeUserRequest,
  buildSearchQuery,
  decideRoute,
  isQuestionLike,
  isFileOperationRequest,
  inferDeterministicFileWriteCall,
  inferDeterministicFileBatchCalls,
  inferDeterministicSingleFileOverwriteCall,
  inferDeterministicFileFollowupCall,
  requiresToolExecutionForTurn,
  shouldRetryEntitySanity,
  refineQueryForExpectedScope,
  contradictionTierForFact,
  runTurnPipeline,
  extractOfficeHolderAnswerFromResults,
};
