import fs from 'fs';
import path from 'path';
import os from 'os';
import { mmrRerank } from '../tools/memory-mmr.js';

export type FactScope = 'session' | 'global';
export type FactType =
  | 'preference'
  | 'rule'
  | 'fact'
  | 'decision'
  | 'office_holder'
  | 'weather'
  | 'breaking_news'
  | 'market_price'
  | 'event_date_fact'
  | 'generic_fact';
export type FactSourceKind = 'user' | 'tool' | 'file_ref' | 'web' | 'system';

export interface FactRecord {
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
  verified_at: string; // ISO
  expires_at?: string; // ISO
  confidence?: number; // 0..1
  actor?: 'agent' | 'user' | 'system';
  updated_at: string; // ISO
}

type FactStore = {
  version: number;
  records: FactRecord[];
};

const SESSION_FACT_DEFAULT_TTL_HOURS = 6;
const FACT_TEMPORAL_HALF_LIFE_DAYS = 30;
const FACT_TEMPORAL_LAMBDA = Math.LN2 / FACT_TEMPORAL_HALF_LIFE_DAYS;
let _storeCache: FactStore | null = null;
let _storeMtime = 0;

function getStorePath(): string {
  const projectCfg = path.join(process.cwd(), '.localclaw');
  const cfgDir = fs.existsSync(projectCfg) ? projectCfg : path.join(os.homedir(), '.localclaw');
  return path.join(cfgDir, 'facts.json');
}

function loadStore(): FactStore {
  const p = getStorePath();
  try {
    const stat = fs.statSync(p);
    if (_storeCache && stat.mtimeMs === _storeMtime) return _storeCache;
    _storeMtime = stat.mtimeMs;
  } catch {
    return _storeCache || { version: 1, records: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || !Array.isArray(raw.records)) return { version: 1, records: [] };
    const allowedTypes = new Set<FactType>([
      'preference',
      'rule',
      'fact',
      'decision',
      'office_holder',
      'weather',
      'breaking_news',
      'market_price',
      'event_date_fact',
      'generic_fact',
    ]);
    let changed = false;
    const nowMs = Date.now();
    const normalized = (raw.records as FactRecord[]).map((r) => {
      const type = r?.type && allowedTypes.has(r.type) ? r.type : 'generic_fact';
      const rec: FactRecord = { ...r, type };
      if (rec.scope === 'session' && !rec.expires_at) {
        const baseTs = new Date(rec.updated_at || rec.verified_at || new Date().toISOString()).getTime();
        const base = Number.isFinite(baseTs) ? baseTs : nowMs;
        rec.expires_at = new Date(base + SESSION_FACT_DEFAULT_TTL_HOURS * 3600_000).toISOString();
        changed = true;
      }
      return rec;
    });
    const freshOnly = normalized.filter((r) => {
      if (!r.expires_at) return true;
      const exp = new Date(r.expires_at).getTime();
      if (!Number.isFinite(exp)) return true;
      if (exp <= nowMs) {
        changed = true;
        return false;
      }
      return true;
    });

    // Keep the latest entry for each logical identity.
    const dedup = new Map<string, FactRecord>();
    for (const rec of freshOnly) {
      const key = [
        rec.key,
        rec.scope,
        rec.workspace_id || '',
        rec.agent_id || '',
        rec.session_id || '',
      ].join('|');
      const existing = dedup.get(key);
      if (!existing) {
        dedup.set(key, rec);
        continue;
      }
      const a = new Date(existing.updated_at || existing.verified_at || 0).getTime();
      const b = new Date(rec.updated_at || rec.verified_at || 0).getTime();
      if (!Number.isFinite(a) || b >= a) dedup.set(key, rec);
    }
    const records = Array.from(dedup.values());
    if (records.length !== freshOnly.length) changed = true;
    const out = { version: 1, records };
    if (changed) saveStore(out);
    _storeCache = out;
    return out;
  } catch {
    return { version: 1, records: [] };
  }
}

function saveStore(store: FactStore): void {
  const p = getStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
  _storeCache = store;
  try {
    _storeMtime = fs.statSync(p).mtimeMs;
  } catch {
    // leave cache mtime unchanged if stat fails transiently
  }
}

export function defaultExpiryHoursForKey(key: string): number | undefined {
  const k = key.toLowerCase();
  if (/\b(price|quote|stock|crypto|rate|weather|forecast|score|news|headline)\b/.test(k)) return 6;
  if (/\b(current|latest|today|now|office|president|attorney-general|minister|ceo|director)\b/.test(k)) return 48;
  return undefined;
}

export function upsertFactRecord(input: Omit<FactRecord, 'updated_at' | 'verified_at'> & { verified_at?: string }): FactRecord {
  const store = loadStore();
  const now = new Date().toISOString();
  const verified = input.verified_at || now;
  const computedExpiresAt = (() => {
    if (input.expires_at) return input.expires_at;
    if (input.scope === 'session') {
      return new Date(Date.now() + SESSION_FACT_DEFAULT_TTL_HOURS * 3600_000).toISOString();
    }
    return undefined;
  })();
  const idx = store.records.findIndex(r =>
    r.key === input.key &&
    r.scope === input.scope &&
    (r.workspace_id || '') === (input.workspace_id || '') &&
    (r.agent_id || '') === (input.agent_id || '') &&
    (r.scope === 'global' || r.session_id === input.session_id)
  );
  const rec: FactRecord = {
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
    verified_at: verified,
    expires_at: computedExpiresAt,
    confidence: input.confidence,
    actor: input.actor,
    updated_at: now,
  };
  if (idx >= 0) store.records[idx] = rec;
  else store.records.push(rec);
  saveStore(store);
  return rec;
}

export function pruneFactStore(): { total: number; stale: number; session_without_expiry: number } {
  const p = getStorePath();
  if (!fs.existsSync(p)) return { total: 0, stale: 0, session_without_expiry: 0 };
  let before: FactStore = { version: 1, records: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (raw && Array.isArray(raw.records)) {
      before = { version: 1, records: raw.records as FactRecord[] };
    }
  } catch {
    return { total: 0, stale: 0, session_without_expiry: 0 };
  }
  const now = Date.now();
  const stale = before.records.filter((r) => {
    if (!r.expires_at) return false;
    const exp = new Date(r.expires_at).getTime();
    return Number.isFinite(exp) && exp <= now;
  }).length;
  const sessionWithoutExpiry = before.records.filter((r) => r.scope === 'session' && !r.expires_at).length;
  // loadStore applies normalization + TTL backfill + stale prune + dedupe and persists when changed.
  const after = loadStore();
  return {
    total: after.records.length,
    stale,
    session_without_expiry: sessionWithoutExpiry,
  };
}

export function queryFactRecords(opts: {
  query: string;
  session_id?: string;
  workspace_id?: string;
  agent_id?: string;
  includeGlobal?: boolean;
  max?: number;
  includeStale?: boolean;
  useMmr?: boolean;
}): FactRecord[] {
  function temporalDecayMultiplier(updatedAt: string, sourceRef?: string): number {
    // Evergreen note-paths (no YYYY-MM-DD segment) are not time-decayed.
    const hasPathLikeRef = typeof sourceRef === 'string' && /[\\/]/.test(sourceRef);
    if (hasPathLikeRef && !/\b\d{4}-\d{2}-\d{2}\b/.test(String(sourceRef))) {
      return 1;
    }
    const ts = new Date(updatedAt).getTime();
    if (!Number.isFinite(ts)) return 1;
    const ageDays = (Date.now() - ts) / (24 * 3600 * 1000);
    return Math.exp(-FACT_TEMPORAL_LAMBDA * Math.max(0, ageDays));
  }

  const query = String(opts.query || '').toLowerCase();
  const toks = query.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 4);
  const now = Date.now();
  const includeGlobal = opts.includeGlobal ?? true;
  const max = opts.max ?? 6;
  const includeStale = opts.includeStale ?? false;
  const useMmr = opts.useMmr ?? true;
  const store = loadStore();

  const candidates = store.records.filter(r => {
    if (opts.workspace_id && (r.workspace_id || '') !== opts.workspace_id) return false;
    if (opts.agent_id && (r.agent_id || '') !== opts.agent_id) return false;
    if (r.scope === 'session' && opts.session_id && r.session_id !== opts.session_id) return false;
    if (r.scope === 'session' && !opts.session_id) return false;
    if (r.scope === 'global' && !includeGlobal) return false;
    if (!includeStale && r.expires_at) {
      const exp = new Date(r.expires_at).getTime();
      if (!isNaN(exp) && exp < now) return false;
    }
    return true;
  });

  const scored = candidates.map(r => {
    const hay = `${r.key} ${r.value}`.toLowerCase();
    let score = 0;
    for (const t of toks) {
      if (hay.includes(t)) score += 1;
    }
    if (r.scope === 'session') score += 0.5;
    if (r.actor === 'user' || r.source_kind === 'user') score += 1.2;
    if (typeof r.confidence === 'number') score += Math.max(0, Math.min(1, r.confidence));
    score *= temporalDecayMultiplier(r.updated_at, r.source_ref);
    return { r, score };
  }).filter(x => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aUser = (a.r.actor === 'user' || a.r.source_kind === 'user') ? 1 : 0;
      const bUser = (b.r.actor === 'user' || b.r.source_kind === 'user') ? 1 : 0;
      if (bUser !== aUser) return bUser - aUser;
      const aConf = typeof a.r.confidence === 'number' ? a.r.confidence : 0;
      const bConf = typeof b.r.confidence === 'number' ? b.r.confidence : 0;
      if (bConf !== aConf) return bConf - aConf;
      const aTime = new Date(a.r.updated_at).getTime();
      const bTime = new Date(b.r.updated_at).getTime();
      if (bTime !== aTime) return bTime - aTime;
      return 0;
    });

  // Conflict resolver: one best record per key.
  const byKey = new Map<string, { record: FactRecord; score: number }>();
  for (const row of scored) {
    if (!byKey.has(row.r.key)) byKey.set(row.r.key, { record: row.r, score: row.score });
  }

  const unique = Array.from(byKey.entries()).map(([id, v]) => ({
    id,
    score: v.score,
    content: `${v.record.key} ${v.record.value}`,
  }));
  const reranked = mmrRerank(unique, { enabled: useMmr, lambda: 0.7, max });
  return reranked
    .map((item) => byKey.get(item.id)?.record)
    .filter((r): r is FactRecord => Boolean(r))
    .slice(0, max);
}
