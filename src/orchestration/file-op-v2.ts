import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { getConfig } from '../config/config';

export type FileOpType = 'FILE_ANALYSIS' | 'FILE_CREATE' | 'FILE_EDIT' | 'BROWSER_OP' | 'DESKTOP_OP' | 'CHAT';
export type FileOpOwner = 'primary' | 'secondary';

export interface FileOpSettings {
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
}

export interface FileOpClassifierResult {
  type: FileOpType;
  reason: string;
}

export interface FileToolEstimate {
  lines_changed: number;
  chars_changed: number;
  files_touched: number;
  file?: string;
}

export interface PrimaryToolAllowance {
  allowed: boolean;
  reason: string;
  estimate: FileToolEstimate;
}

export interface FileOpVerificationInput {
  had_create: boolean;
  user_requested_full_template: boolean;
  primary_write_lines: number;
  primary_write_chars: number;
  had_tool_failure: boolean;
  touched_files: string[];
  high_stakes_touched: boolean;
}

export interface FileOpVerifierFinding {
  filename?: string;
  type?: string;
  location_hint?: {
    start_line?: number;
    end_line?: number;
  };
  expected?: string;
  observed?: string;
}

export interface FileOpVerifierResult {
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
  findings: FileOpVerifierFinding[];
  suggested_fix: {
    estimated_lines_changed: number;
    estimated_chars: number;
    files_touched: number;
  };
}

export interface FileOpWatchdogRecord {
  failure_signature: string;
  patch_signature: string;
  large_patch: boolean;
  ts: number;
}

export class FileOpProgressWatchdog {
  private readonly windowSize: number;
  private readonly history: FileOpWatchdogRecord[] = [];

  constructor(windowSize: number) {
    this.windowSize = Math.max(2, Math.min(8, Math.floor(Number(windowSize) || 3)));
  }

  record(input: {
    failure_signature: string;
    patch_signature: string;
    large_patch: boolean;
  }): { no_progress: boolean; window: FileOpWatchdogRecord[] } {
    const next: FileOpWatchdogRecord = {
      failure_signature: String(input.failure_signature || ''),
      patch_signature: String(input.patch_signature || ''),
      large_patch: input.large_patch === true,
      ts: Date.now(),
    };
    this.history.push(next);
    if (this.history.length > 24) this.history.shift();

    const window = this.history.slice(-this.windowSize);
    if (window.length < this.windowSize) return { no_progress: false, window };

    const sameFailure = window.every(w => w.failure_signature === window[0].failure_signature);
    if (!sameFailure) return { no_progress: false, window };

    const patchSigs = window.map(w => w.patch_signature);
    const repeatedPatch = new Set(patchSigs).size <= 1;
    const oscillatingPatch =
      patchSigs.length >= 3
      && patchSigs[0] === patchSigs[2]
      && patchSigs[0] !== patchSigs[1];
    const unchangedAfterLargePatches = window.every(w => w.large_patch);

    return {
      no_progress: repeatedPatch || oscillatingPatch || unchangedAfterLargePatches,
      window,
    };
  }
}

export type FileOpPhase = 'plan' | 'execute' | 'verify' | 'repair' | 'done';

export interface FileOpJobState {
  session_id: string;
  goal: string;
  phase: FileOpPhase;
  tasks: string[];
  files_changed: string[];
  last_verifier_findings: FileOpVerifierFinding[];
  patch_history_signatures: string[];
  next_action: string;
  owner: FileOpOwner;
  operation: FileOpType;
  updated_at: number;
}

export interface OrchestrationLikeConfig {
  file_ops?: Partial<FileOpSettings>;
}

const CREATE_TOOLS = new Set(['create_file']);
const EDIT_TOOLS = new Set(['replace_lines', 'insert_after', 'delete_lines', 'find_replace', 'delete_file']);
const MUTATION_TOOLS = new Set([...Array.from(CREATE_TOOLS), ...Array.from(EDIT_TOOLS)]);

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function countLines(text: string): number {
  const raw = String(text || '');
  if (!raw) return 0;
  return raw.split('\n').length;
}

function normalizeText(value: string): string {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isBrowserOperationRequest(message: string): boolean {
  const m = normalizeText(message);
  const hasBrowserVerb = /\b(open|go to|navigate|visit|browse|click|type|fill|press|submit|use my computer)\b/.test(m);
  const hasTarget = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/.test(m)
    || /\b(chatgpt|google|reddit|x\.com|twitter|github|youtube)\b/.test(m);
  return hasBrowserVerb && hasTarget;
}

function isDesktopOperationRequest(message: string): boolean {
  const m = normalizeText(message);
  const hasDesktopVerb = /\b(check|look|see|open|focus|click|type|press|read|copy|paste|screenshot|status|monitor|watch)\b/.test(m);
  const hasDesktopTarget = /\b(desktop|screen|window|application|app|vs code|vscode|visual studio code|terminal|notepad|clipboard|codex)\b/.test(m);
  const vscodeDoneAsk =
    /\b(is|has|did|check|verify)\b.{0,40}\b(vs code|vscode|codex)\b.{0,40}\b(done|finished|complete|completed|responded)\b/.test(m)
    || /\b(vs code|vscode|codex)\b.{0,40}\b(done|finished|complete|completed|responded)\b/.test(m);
  return (hasDesktopVerb && hasDesktopTarget) || vscodeDoneAsk;
}

export function looksRefactorishIntent(message: string): boolean {
  return /\b(refactor|restructure|rewrite|modularize|multi-step system change|architect|redesign|overhaul)\b/i
    .test(String(message || ''));
}

export function classifyFileOpType(message: string): FileOpClassifierResult {
  const m = normalizeText(message);
  if (!m) return { type: 'CHAT', reason: 'empty message' };

  if (isDesktopOperationRequest(m)) {
    return { type: 'DESKTOP_OP', reason: 'desktop automation phrasing' };
  }

  if (isBrowserOperationRequest(m)) {
    return { type: 'BROWSER_OP', reason: 'browser automation phrasing' };
  }

  const hasFileContext = /\b(file|files|code|repo|repository|workspace|module|class|function|component|config|template|layout|page|website|html|css|js|ts|json|markdown|md)\b/.test(m);
  const hasExplicitFileName = /\b[a-z0-9._-]+\.(html?|css|js|ts|json|md|txt|py)\b/.test(m);
  const analysisIntent = /\b(analyze|analysis|explain|diagnose|root cause|why|review|understand|inspect|walk me through|trace)\b/.test(m);
  const createIntent = /\b(create|generate|scaffold|new file|add file|build(?:\s+page|\s+template)?|make|craft|design|compose|draft)\b/.test(m);
  const pageCreateCue = /\b(landing page|web page|full landing page|single html file|one html file|full page|full template|full layout|full config)\b/.test(m);
  const editIntent = /\b(edit|update|modify|change|fix|patch|replace|insert|delete|remove|rename|rewrite)\b/.test(m);

  if (analysisIntent && hasFileContext && !createIntent && !editIntent) {
    return { type: 'FILE_ANALYSIS', reason: 'analysis intent with file/code context' };
  }
  if (
    (createIntent && (hasFileContext || hasExplicitFileName))
    || (pageCreateCue && /\b(make|build|create|generate|design|craft)\b/.test(m))
  ) {
    return { type: 'FILE_CREATE', reason: 'create intent with file/code context' };
  }
  if (editIntent && hasFileContext) {
    return { type: 'FILE_EDIT', reason: 'edit intent with file/code context' };
  }
  return { type: 'CHAT', reason: 'non-file request' };
}

export function resolveFileOpSettings(orchestration?: OrchestrationLikeConfig | null): FileOpSettings {
  const f = orchestration?.file_ops || {};
  return {
    enabled: f.enabled !== false,
    primary_create_max_lines: clampInt(f.primary_create_max_lines, 20, 400, 80),
    primary_create_max_chars: clampInt(f.primary_create_max_chars, 800, 40000, 3500),
    primary_edit_max_lines: clampInt(f.primary_edit_max_lines, 1, 80, 12),
    primary_edit_max_chars: clampInt(f.primary_edit_max_chars, 100, 8000, 800),
    primary_edit_max_files: clampInt(f.primary_edit_max_files, 1, 8, 1),
    verify_create_always: f.verify_create_always !== false,
    verify_large_payload_lines: clampInt(f.verify_large_payload_lines, 5, 400, 25),
    verify_large_payload_chars: clampInt(f.verify_large_payload_chars, 200, 50000, 1200),
    watchdog_no_progress_cycles: clampInt(f.watchdog_no_progress_cycles, 2, 8, 3),
    checkpointing_enabled: f.checkpointing_enabled !== false,
  };
}

export function isFileCreateTool(toolName: string): boolean {
  return CREATE_TOOLS.has(String(toolName || '').trim());
}

export function isFileEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(String(toolName || '').trim());
}

export function isFileMutationTool(toolName: string): boolean {
  return MUTATION_TOOLS.has(String(toolName || '').trim());
}

export function extractFileToolTarget(toolName: string, args: any): string {
  const name = String(toolName || '').trim();
  if (!isFileMutationTool(name)) return '';
  return String(args?.filename || args?.name || '').trim();
}

export function estimateFileToolChange(toolName: string, args: any): FileToolEstimate {
  const name = String(toolName || '').trim();
  const filename = extractFileToolTarget(name, args);
  if (!isFileMutationTool(name)) {
    return { lines_changed: 0, chars_changed: 0, files_touched: 0 };
  }

  if (name === 'create_file') {
    const content = String(args?.content || '');
    return {
      lines_changed: countLines(content),
      chars_changed: content.length,
      files_touched: filename ? 1 : 0,
      file: filename || undefined,
    };
  }

  if (name === 'replace_lines') {
    const newContent = String(args?.new_content || '');
    return {
      lines_changed: Math.max(1, countLines(newContent)),
      chars_changed: newContent.length,
      files_touched: filename ? 1 : 0,
      file: filename || undefined,
    };
  }

  if (name === 'insert_after') {
    const content = String(args?.content || '');
    return {
      lines_changed: Math.max(1, countLines(content)),
      chars_changed: content.length,
      files_touched: filename ? 1 : 0,
      file: filename || undefined,
    };
  }

  if (name === 'delete_lines') {
    const start = Math.max(1, Math.floor(Number(args?.start_line) || 1));
    const end = Math.max(start, Math.floor(Number(args?.end_line) || start));
    return {
      lines_changed: Math.max(1, end - start + 1),
      chars_changed: 0,
      files_touched: filename ? 1 : 0,
      file: filename || undefined,
    };
  }

  if (name === 'find_replace') {
    const find = String(args?.find || '');
    const replace = String(args?.replace ?? '');
    return {
      lines_changed: Math.max(1, countLines(find), countLines(replace)),
      chars_changed: find.length + replace.length,
      files_touched: filename ? 1 : 0,
      file: filename || undefined,
    };
  }

  return {
    lines_changed: 1,
    chars_changed: 0,
    files_touched: filename ? 1 : 0,
    file: filename || undefined,
  };
}

export function canPrimaryApplyFileTool(input: {
  tool_name: string;
  args: any;
  message: string;
  touched_files: Set<string>;
  settings: FileOpSettings;
}): PrimaryToolAllowance {
  const toolName = String(input.tool_name || '').trim();
  const estimate = estimateFileToolChange(toolName, input.args);
  const target = estimate.file || '';
  const nextTouched = new Set<string>(input.touched_files);
  if (target) nextTouched.add(target);

  if (toolName === 'create_file') {
    const smallByLines = estimate.lines_changed <= input.settings.primary_create_max_lines;
    const smallByChars = estimate.chars_changed <= input.settings.primary_create_max_chars;
    return {
      allowed: smallByLines || smallByChars,
      reason: smallByLines || smallByChars
        ? 'create payload within primary create threshold'
        : `create payload exceeds threshold (${estimate.lines_changed} lines, ${estimate.chars_changed} chars)`,
      estimate,
    };
  }

  if (isFileEditTool(toolName)) {
    if (looksRefactorishIntent(input.message)) {
      return { allowed: false, reason: 'refactor-ish request requires secondary', estimate };
    }
    const withinLines = estimate.lines_changed <= input.settings.primary_edit_max_lines;
    const withinChars = estimate.chars_changed <= input.settings.primary_edit_max_chars;
    const withinFiles = nextTouched.size <= input.settings.primary_edit_max_files;
    return {
      allowed: withinLines && withinChars && withinFiles,
      reason: (withinLines && withinChars && withinFiles)
        ? 'edit payload within primary edit thresholds'
        : `edit payload exceeds threshold (lines=${estimate.lines_changed}, chars=${estimate.chars_changed}, files=${nextTouched.size})`,
      estimate,
    };
  }

  return { allowed: true, reason: 'non file-mutation tool', estimate };
}

export function shouldVerifyFileTurn(input: FileOpVerificationInput, settings: FileOpSettings): {
  verify: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (input.had_create && settings.verify_create_always) reasons.push('create_file occurred');
  if (input.user_requested_full_template) reasons.push('user requested full page/template/config/layout');
  if (input.primary_write_lines > settings.verify_large_payload_lines) reasons.push('primary wrote large line payload');
  if (input.primary_write_chars > settings.verify_large_payload_chars) reasons.push('primary wrote large char payload');
  if (input.had_tool_failure) reasons.push('tool failure occurred');
  if (input.high_stakes_touched) reasons.push('high-stakes files touched');
  return { verify: reasons.length > 0, reasons };
}

export function isSmallSuggestedFix(
  verifier: FileOpVerifierResult,
  settings: FileOpSettings,
): boolean {
  const s = verifier.suggested_fix || {
    estimated_lines_changed: Number.MAX_SAFE_INTEGER,
    estimated_chars: Number.MAX_SAFE_INTEGER,
    files_touched: Number.MAX_SAFE_INTEGER,
  };
  return s.estimated_lines_changed <= settings.primary_edit_max_lines
    && s.estimated_chars <= settings.primary_edit_max_chars
    && s.files_touched <= settings.primary_edit_max_files;
}

export function buildFailureSignature(verifier: FileOpVerifierResult): string {
  const reasons = (verifier.reasons || []).slice(0, 3).map(normalizeText).join('|');
  const findings = (verifier.findings || [])
    .slice(0, 6)
    .map(f => {
      const filename = normalizeText(String(f.filename || ''));
      const type = normalizeText(String(f.type || ''));
      const expected = normalizeText(String(f.expected || '')).slice(0, 80);
      const observed = normalizeText(String(f.observed || '')).slice(0, 80);
      return `${filename}:${type}:${expected}:${observed}`;
    })
    .join('|');
  return createHash('sha1').update(`${reasons}||${findings}`).digest('hex');
}

export function buildPatchSignature(toolCalls: Array<{ tool: string; args: any }>): string {
  const compact = (toolCalls || [])
    .map(t => `${String(t.tool || '').trim()}:${stableStringify(t.args || {})}`)
    .join('||');
  return createHash('sha1').update(compact).digest('hex');
}

function checkpointDir(): string {
  const cfgDir = getConfig().getConfigDir();
  return path.join(cfgDir, 'jobs', 'file-op-v2');
}

function checkpointPath(sessionId: string): string {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(checkpointDir(), `${safe}.json`);
}

export function loadFileOpCheckpoint(sessionId: string): FileOpJobState | null {
  try {
    const fp = checkpointPath(sessionId);
    if (!fs.existsSync(fp)) return null;
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw as FileOpJobState;
  } catch {
    return null;
  }
}

export function saveFileOpCheckpoint(
  sessionId: string,
  patch: Partial<FileOpJobState> & Pick<FileOpJobState, 'goal' | 'phase' | 'owner' | 'operation'>,
): FileOpJobState | null {
  try {
    fs.mkdirSync(checkpointDir(), { recursive: true });
    const current = loadFileOpCheckpoint(sessionId);
    const next: FileOpJobState = {
      session_id: sessionId,
      goal: patch.goal,
      phase: patch.phase,
      tasks: patch.tasks || current?.tasks || [],
      files_changed: patch.files_changed || current?.files_changed || [],
      last_verifier_findings: patch.last_verifier_findings || current?.last_verifier_findings || [],
      patch_history_signatures: patch.patch_history_signatures || current?.patch_history_signatures || [],
      next_action: patch.next_action || current?.next_action || '',
      owner: patch.owner,
      operation: patch.operation,
      updated_at: Date.now(),
    };
    fs.writeFileSync(checkpointPath(sessionId), JSON.stringify(next, null, 2), 'utf-8');
    return next;
  } catch {
    return null;
  }
}

export function clearFileOpCheckpoint(sessionId: string): void {
  try {
    const fp = checkpointPath(sessionId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    // best effort only
  }
}
