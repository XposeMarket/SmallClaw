import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { executeMemoryWrite } from '../tools/memory';
import { sanitizeMemoryText } from '../tools/memory-utils';
import { getDatabase } from '../db/database';
import { getConfig } from '../config/config';
import {
  defaultExpiryHoursForKey,
  upsertFactRecord,
  FactScope,
  FactType,
  FactSourceKind,
} from './fact-store';

const db = getDatabase();
const cfg = getConfig().getConfig();

export interface MemoryClaim {
  claim: string;
  type: FactType;
  scope: FactScope;
  workspace_id: string;
  agent_id: string;
  session_id?: string;
  source_kind: FactSourceKind;
  source_ref: string;
  confidence: number;
  ttl_hours?: number;
}

export interface AddMemoryFactArgs {
  fact: string;
  key?: string;
  action?: 'append' | 'upsert' | 'replace_all';
  scope?: FactScope;
  session_id?: string;
  confidence?: number;
  source_url?: string;
  reference?: string;
  source_kind?: FactSourceKind;
  source_ref?: string;
  source_tool?: string;
  source_output?: any;
  actor?: 'agent' | 'user' | 'system';
  type?: FactType;
  workspace_id?: string;
  agent_id?: string;
  ttl_hours?: number;
  routing?: 'direct' | 'policy';
}

type MemoryDecision = 'DISCARD' | 'DAILY_NOTE' | 'TYPED_FACT' | 'CURATED_PROFILE';

function shouldDiscardClaim(claim: MemoryClaim): boolean {
  const text = sanitizeMemoryText(claim.claim);
  if (!text || text.length < 10) return true;
  if (/^error|^max steps|^thought:/i.test(text)) return true;
  if (/\bcould not produce\b|\bformat violation\b|\bunsupported_mutation\b|\bmissing_required_input\b/i.test(text)) return true;
  if (/^\s*blocked\b/i.test(text)) return true;
  return false;
}

export function decideMemoryWrite(claim: MemoryClaim): MemoryDecision {
  if (shouldDiscardClaim(claim)) return 'DISCARD';
  if (!claim.source_kind || !claim.source_ref) return 'DAILY_NOTE';
  if ((claim.type === 'preference' || claim.type === 'rule') && claim.scope === 'global' && claim.confidence >= 0.9) {
    return 'CURATED_PROFILE';
  }
  if (claim.confidence >= 0.55) return 'TYPED_FACT';
  return 'DAILY_NOTE';
}

function getDailyMemoryPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(cfg.workspace.path, 'memory', `${day}.md`);
}

export function appendDailyMemoryNote(line: string): void {
  const p = getDailyMemoryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ts = new Date().toISOString();
  fs.appendFileSync(p, `- [${ts}] ${sanitizeMemoryText(line)}\n`, 'utf-8');
}

function normalizeFactKeyFromClaim(claim: MemoryClaim): string {
  const lhs = sanitizeMemoryText(claim.claim).match(/^(.+?)\s+(is|are|was|were)\s+/i)?.[1]?.trim();
  const base = lhs || sanitizeMemoryText(claim.claim);
  const slug = base.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80) || 'item';
  return `fact:${slug}`;
}

function shouldForceSessionScopeForTemporalClaim(text: string): boolean {
  return /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text)
    || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(text)
    || /\b\d{1,2}:\d{2}\b/.test(text)
    || /\blocal time\b/i.test(text)
    || /\bcurrent time\b/i.test(text);
}

function auditMemoryWrite(args: {
  reference?: string;
  fact: string;
  source_tool?: string;
  source_output?: string;
  actor?: 'agent' | 'user' | 'system';
  success: boolean;
  error?: string;
}): void {
  try {
    if (!(cfg.memory_options?.audit ?? true)) return;
    db.createMemoryLog({
      id: randomUUID(),
      reference: args.reference,
      fact: args.fact,
      source_tool: args.source_tool,
      source_output: args.source_output,
      actor: args.actor || 'agent',
      success: args.success ? 1 : 0,
      error: args.success ? undefined : (args.error || 'unknown'),
    });
  } catch (dbErr: any) {
    console.error('[memory-manager] Failed to persist memory log:', dbErr?.message || dbErr);
  }
}

function upsertTypedMemoryFact(input: {
  key: string;
  value: string;
  type?: FactType;
  scope: FactScope;
  workspace_id?: string;
  agent_id?: string;
  session_id?: string;
  source_kind?: FactSourceKind;
  source_ref?: string;
  source_tool?: string;
  source_url?: string;
  confidence?: number;
  actor?: 'agent' | 'user' | 'system';
  ttl_hours?: number;
}): void {
  const nowIso = new Date().toISOString();
  const ttlHours = typeof input.ttl_hours === 'number'
    ? input.ttl_hours
    : defaultExpiryHoursForKey(input.key);
  const expires_at = ttlHours
    ? new Date(Date.now() + ttlHours * 3600_000).toISOString()
    : undefined;

  upsertFactRecord({
    key: input.key,
    value: input.value,
    type: input.type,
    scope: input.scope,
    workspace_id: input.workspace_id,
    agent_id: input.agent_id,
    session_id: input.session_id,
    source_kind: input.source_kind,
    source_ref: input.source_ref,
    source_tool: input.source_tool,
    source_url: input.source_url,
    verified_at: nowIso,
    expires_at,
    confidence: input.confidence,
    actor: input.actor || 'agent',
  });
}

export async function addMemoryFact(args: AddMemoryFactArgs): Promise<{ success: boolean; destination: MemoryDecision; message?: string }> {
  const safeFact = sanitizeMemoryText(args.fact);
  if (!safeFact) {
    return { success: false, destination: 'DISCARD', message: 'fact required' };
  }
  const safeSourceOutput = args.source_output ? sanitizeMemoryText(args.source_output) : undefined;
  const normalizedScope: FactScope = shouldForceSessionScopeForTemporalClaim(safeFact) ? 'session' : (args.scope || 'global');
  const claim: MemoryClaim = {
    claim: safeFact,
    type: args.type || 'generic_fact',
    scope: normalizedScope,
    workspace_id: args.workspace_id || '',
    agent_id: args.agent_id || '',
    session_id: args.session_id,
    source_kind: args.source_kind || 'system',
    source_ref: args.source_ref || 'addMemoryFact',
    confidence: typeof args.confidence === 'number' ? args.confidence : 0.5,
    ttl_hours: args.ttl_hours,
  };

  const routing = args.routing || 'direct';

  const finish = (success: boolean, message: string, destination: MemoryDecision, error?: string) => {
    auditMemoryWrite({
      reference: args.reference,
      fact: safeFact,
      source_tool: args.source_tool,
      source_output: safeSourceOutput,
      actor: args.actor || 'agent',
      success,
      error,
    });
    return { success, destination, message };
  };

  if (shouldDiscardClaim(claim)) {
    return finish(true, 'discarded', 'DISCARD');
  }

  const decision: MemoryDecision = routing === 'policy' ? decideMemoryWrite(claim) : 'TYPED_FACT';

  try {
    if (decision === 'DISCARD') {
      return finish(true, 'discarded', decision);
    }

    if (decision === 'DAILY_NOTE') {
      appendDailyMemoryNote(safeFact);
      return finish(true, 'daily note appended', decision);
    }

    if (decision === 'CURATED_PROFILE') {
      const profileKey = args.key || `profile:${normalizeFactKeyFromClaim(claim).replace(/^fact:/, '')}`;
      const writeResult = await executeMemoryWrite({
        fact: safeFact,
        key: profileKey,
        action: 'upsert',
        reference: args.reference,
        source_tool: args.source_tool,
        source_output: safeSourceOutput,
        actor: args.actor || 'agent',
      });
      if (!writeResult.success) {
        const msg = writeResult.error || 'memory_write failed';
        return finish(false, msg, decision, msg);
      }
      upsertTypedMemoryFact({
        key: profileKey,
        value: safeFact,
        type: claim.type,
        scope: 'global',
        workspace_id: args.workspace_id,
        agent_id: args.agent_id,
        session_id: args.session_id,
        source_kind: claim.source_kind,
        source_ref: claim.source_ref,
        source_tool: args.source_tool,
        source_url: args.source_url,
        confidence: claim.confidence,
        actor: args.actor || 'agent',
        ttl_hours: claim.ttl_hours,
      });
      return finish(true, writeResult.stdout || 'memory profile upserted', decision);
    }

    if (routing === 'direct') {
      const writeResult = await executeMemoryWrite({
        fact: safeFact,
        key: args.key,
        action: args.action || 'append',
        reference: args.reference,
        source_tool: args.source_tool,
        source_output: safeSourceOutput,
        actor: args.actor || 'agent',
      });
      if (!writeResult.success) {
        const msg = writeResult.error || 'memory_write failed';
        return finish(false, msg, decision, msg);
      }
      const directKey = args.key || `fact:${safeFact.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80) || 'item'}`;
      upsertTypedMemoryFact({
        key: directKey,
        value: safeFact,
        type: args.type,
        scope: normalizedScope,
        workspace_id: args.workspace_id,
        agent_id: args.agent_id,
        session_id: args.session_id,
        source_kind: args.source_kind,
        source_ref: args.source_ref,
        source_tool: args.source_tool,
        source_url: args.source_url,
        confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
        actor: args.actor || 'agent',
        ttl_hours: args.ttl_hours,
      });
      return finish(true, writeResult.stdout || 'Memory updated', decision);
    }

    const typedKey = args.key || normalizeFactKeyFromClaim(claim);
    upsertTypedMemoryFact({
      key: typedKey,
      value: safeFact,
      type: claim.type,
      scope: claim.scope,
      workspace_id: args.workspace_id,
      agent_id: args.agent_id,
      session_id: args.session_id,
      source_kind: claim.source_kind,
      source_ref: claim.source_ref,
      source_tool: args.source_tool,
      source_url: args.source_url,
      confidence: claim.confidence,
      actor: args.actor || 'agent',
      ttl_hours: claim.ttl_hours,
    });
    appendDailyMemoryNote(safeFact);
    return finish(true, 'typed fact upserted', decision);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[memory-manager] Error adding memory fact:', msg);
    return finish(false, msg, decision, msg);
  }
}
