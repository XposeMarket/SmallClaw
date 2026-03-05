/**
 * WorkflowStore — Persistent SmallClaw-side workflow registry
 *
 * This is the SmallClaw brain for workflow memory. Every workflow
 * deployed through Agent Builder gets saved here permanently, keyed
 * by its workflow_id. On next request, SmallClaw checks this store
 * BEFORE calling architect_workflow(), preventing duplicates and
 * saving API calls / build time.
 *
 * Storage: .smallclaw/workflows.json (same pattern as CronScheduler jobs)
 * Format:  JSON file, human-readable, persists across restarts
 *
 * File location: src/gateway/workflow-store.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StoredWorkflow {
  /** Permanent ID from Agent Builder database — the canonical reference */
  workflow_id: string;

  /**
   * Registry template ID (reg_xxxxxx) from Agent Builder's WorkflowRegistry.
   * This is what registry/execute expects as template_id.
   * Populated after deploy_workflow() calls registry/register.
   */
  template_id?: string;

  /** Human-readable name, e.g. "X Daily Posts" */
  name: string;

  /** What this workflow does in plain English */
  description: string;

  /**
   * Type of workflow:
   * - "action"    → runs on-demand (post now, send email now)
   * - "scheduled" → runs on cron (daily posts, weekly digest)
   * - "background"→ runs continuously (monitor, listen for events)
   */
  type: 'action' | 'scheduled' | 'background';

  /** Primary verb: post, send, fetch, schedule, monitor, etc. */
  action: string;

  /**
   * Searchable tags. Used by SmallClaw to match user intent.
   * e.g. ["social", "x", "twitter", "post", "quick"]
   */
  tags: string[];

  /** Inputs the workflow REQUIRES to run */
  required_inputs: string[];

  /** Inputs the workflow ACCEPTS but doesn't require */
  optional_inputs: string[];

  /** Current state in Agent Builder */
  status: 'active' | 'inactive' | 'error';

  /** Cron expression if scheduled, e.g. "0 9 * * *" */
  cron_expression?: string;

  /** Number of times this workflow has been executed via SmallClaw */
  execution_count: number;

  /** ISO timestamp of last execution */
  last_executed?: string;

  /** ISO timestamp when this workflow was first deployed */
  deployed_at: string;

  /** ISO timestamp of last status check */
  last_verified?: string;

  /**
   * Credential providers this workflow needs, e.g. ["X API", "OpenAI"]
   * Populated from Agent Builder's credentials_needed response
   */
  credentials_required: string[];

  /** True once all credentials are confirmed present */
  credentials_verified: boolean;

  /**
   * Short phrases that should trigger this workflow.
   * SmallClaw learns these over time.
   * e.g. ["post to x", "tweet about", "x post"]
   */
  trigger_phrases: string[];
}

export interface WorkflowStoreData {
  /** Schema version for future migrations */
  version: number;

  /** ISO timestamp of last write */
  last_updated: string;

  /** Total workflows ever registered */
  total_registered: number;

  /** Total executions across all workflows */
  total_executions: number;

  /** The actual registry — keyed by workflow_id for O(1) lookup */
  workflows: Record<string, StoredWorkflow>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORE_VERSION = 1;

// Default store path — respects SMALLCLAW_DATA_DIR env var if set
function getStorePath(): string {
  const dataDir = process.env.SMALLCLAW_DATA_DIR
    || path.join(os.homedir(), '.smallclaw');

  return path.join(dataDir, 'workflows.json');
}

// ─── WorkflowStore Class ─────────────────────────────────────────────────────

export class WorkflowStore {
  private storePath: string;
  private data: WorkflowStoreData;
  private dirty: boolean = false;

  constructor(storePath?: string) {
    this.storePath = storePath || getStorePath();
    this.data = this.load();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private load(): WorkflowStoreData {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const parsed = JSON.parse(raw) as WorkflowStoreData;
        console.log(`[WorkflowStore] Loaded ${Object.keys(parsed.workflows).length} workflows from ${this.storePath}`);
        return parsed;
      }
    } catch (err) {
      console.error('[WorkflowStore] Failed to load store, starting fresh:', err);
    }

    return this.emptyStore();
  }

  private emptyStore(): WorkflowStoreData {
    return {
      version: STORE_VERSION,
      last_updated: new Date().toISOString(),
      total_registered: 0,
      total_executions: 0,
      workflows: {}
    };
  }

  /**
   * Write the store to disk. Called automatically after mutations.
   * Creates the directory if it doesn't exist.
   */
  save(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.data.last_updated = new Date().toISOString();
      fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.dirty = false;
      console.log(`[WorkflowStore] Saved ${Object.keys(this.data.workflows).length} workflows to disk`);
    } catch (err) {
      console.error('[WorkflowStore] Failed to save store:', err);
    }
  }

  // ── Write Operations ───────────────────────────────────────────────────────

  /**
   * Register a newly deployed workflow.
   * Called automatically by deploy_workflow() tool after successful deploy.
   *
   * @returns The stored workflow entry
   */
  register(workflow: Omit<StoredWorkflow, 'execution_count' | 'deployed_at' | 'credentials_verified' | 'trigger_phrases'> & Partial<Pick<StoredWorkflow, 'execution_count' | 'deployed_at' | 'credentials_verified' | 'trigger_phrases'>>): StoredWorkflow {
    const existing = this.data.workflows[workflow.workflow_id];

    const entry: StoredWorkflow = {
      ...workflow,
      execution_count: existing?.execution_count ?? 0,
      deployed_at: existing?.deployed_at ?? new Date().toISOString(),
      credentials_verified: workflow.credentials_verified ?? false,
      trigger_phrases: workflow.trigger_phrases ?? existing?.trigger_phrases ?? [],
    };

    this.data.workflows[workflow.workflow_id] = entry;

    if (!existing) {
      this.data.total_registered++;
    }

    this.save();
    console.log(`[WorkflowStore] Registered workflow: ${workflow.workflow_id} — "${workflow.name}"`);
    return entry;
  }

  /**
   * Mark a workflow as executed. Increments counters and updates last_executed.
   */
  recordExecution(workflowId: string): void {
    const wf = this.data.workflows[workflowId];
    if (!wf) {
      console.warn(`[WorkflowStore] recordExecution: unknown workflow ${workflowId}`);
      return;
    }

    wf.execution_count++;
    wf.last_executed = new Date().toISOString();
    this.data.total_executions++;
    this.save();
  }

  /**
   * Update a workflow's status (active/inactive/error).
   */
  updateStatus(workflowId: string, status: StoredWorkflow['status']): void {
    const wf = this.data.workflows[workflowId];
    if (!wf) return;
    wf.status = status;
    wf.last_verified = new Date().toISOString();
    this.save();
  }

  /**
   * Mark credentials as verified for a workflow.
   */
  markCredentialsVerified(workflowId: string): void {
    const wf = this.data.workflows[workflowId];
    if (!wf) return;
    wf.credentials_verified = true;
    wf.last_verified = new Date().toISOString();
    this.save();
  }

  /**
   * Add trigger phrases that the LLM learned map to this workflow.
   * Deduplicates automatically.
   */
  addTriggerPhrases(workflowId: string, phrases: string[]): void {
    const wf = this.data.workflows[workflowId];
    if (!wf) return;

    const existing = new Set(wf.trigger_phrases.map(p => p.toLowerCase()));
    const newPhrases = phrases
      .map(p => p.toLowerCase().trim())
      .filter(p => p.length > 0 && !existing.has(p));

    if (newPhrases.length > 0) {
      wf.trigger_phrases.push(...newPhrases);
      this.save();
    }
  }

  /**
   * Remove a workflow from the store (e.g. user deleted it from Agent Builder)
   */
  remove(workflowId: string): boolean {
    if (!this.data.workflows[workflowId]) return false;
    delete this.data.workflows[workflowId];
    this.save();
    console.log(`[WorkflowStore] Removed workflow: ${workflowId}`);
    return true;
  }

  // ── Read Operations ────────────────────────────────────────────────────────

  /**
   * Get a workflow by its Agent Builder ID.
   */
  get(workflowId: string): StoredWorkflow | null {
    return this.data.workflows[workflowId] ?? null;
  }

  /**
   * Get all stored workflows as an array.
   */
  getAll(): StoredWorkflow[] {
    return Object.values(this.data.workflows);
  }

  /**
   * Returns true if SmallClaw has a workflow registered for this ID.
   */
  has(workflowId: string): boolean {
    return workflowId in this.data.workflows;
  }

  /**
   * Get workflows filtered by type.
   */
  getByType(type: StoredWorkflow['type']): StoredWorkflow[] {
    return this.getAll().filter(wf => wf.type === type);
  }

  /**
   * Get all active workflows.
   */
  getActive(): StoredWorkflow[] {
    return this.getAll().filter(wf => wf.status === 'active');
  }

  /**
   * Full-text + tag search. Returns ranked results.
   *
   * Scoring (higher = better match):
   *  +3  exact tag match
   *  +2  name contains query word
   *  +2  trigger phrase match
   *  +1  description contains query word
   *  +1  action matches
   *
   * Filters:
   *  - type: restrict to action | scheduled | background
   *  - activeOnly: only return active workflows (default: true)
   */
  search(query: string, options: {
    type?: StoredWorkflow['type'];
    activeOnly?: boolean;
    limit?: number;
  } = {}): StoredWorkflow[] {
    const { type, activeOnly = true, limit = 10 } = options;

    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    let candidates = this.getAll();

    if (activeOnly) {
      candidates = candidates.filter(wf => wf.status === 'active');
    }

    if (type) {
      candidates = candidates.filter(wf => wf.type === type);
    }

    const scored = candidates.map(wf => {
      let score = 0;
      const name = wf.name.toLowerCase();
      const desc = wf.description.toLowerCase();
      const tagSet = new Set(wf.tags.map(t => t.toLowerCase()));

      for (const word of words) {
        if (tagSet.has(word)) score += 3;
        if (name.includes(word)) score += 2;
        if (wf.trigger_phrases.some(p => p.toLowerCase().includes(word))) score += 2;
        if (desc.includes(word)) score += 1;
        if (wf.action.toLowerCase() === word) score += 1;
      }

      // Boost by usage — popular workflows float up
      score += Math.min(wf.execution_count * 0.1, 2);

      return { wf, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.wf);
  }

  /**
   * Find a workflow by matching trigger phrases exactly.
   * This is the fastest path — O(n) scan but short-circuits on first hit.
   */
  findByTriggerPhrase(phrase: string): StoredWorkflow | null {
    const normalized = phrase.toLowerCase().trim();
    for (const wf of this.getAll()) {
      if (wf.status === 'active' && wf.trigger_phrases.some(p => p === normalized)) {
        return wf;
      }
    }
    return null;
  }

  /**
   * Returns store-level stats for debugging and display.
   */
  getStats(): {
    total_workflows: number;
    active_workflows: number;
    total_executions: number;
    most_used: StoredWorkflow | null;
    last_updated: string;
  } {
    const all = this.getAll();
    const mostUsed = all.length > 0
      ? all.reduce((a, b) => a.execution_count > b.execution_count ? a : b)
      : null;

    return {
      total_workflows: all.length,
      active_workflows: all.filter(wf => wf.status === 'active').length,
      total_executions: this.data.total_executions,
      most_used: mostUsed,
      last_updated: this.data.last_updated
    };
  }

  /**
   * Human-readable summary for LLM context injection.
   * SmallClaw can include this in its system prompt or tool descriptions.
   */
  toLLMSummary(): string {
    const all = this.getActive();
    if (all.length === 0) {
      return 'No workflows registered yet. Use architect_workflow() to create the first one.';
    }

    const lines = [
      `## Registered Workflows (${all.length} active)\n`,
      'These workflows are already built and deployed. Use execute_workflow_template() to run them.',
      ''
    ];

    for (const wf of all.sort((a, b) => b.execution_count - a.execution_count)) {
      lines.push(`### ${wf.name} [${wf.workflow_id}]`);
      lines.push(`- **Type:** ${wf.type} | **Action:** ${wf.action}`);
      lines.push(`- **Description:** ${wf.description}`);
      if (wf.required_inputs.length > 0) {
        lines.push(`- **Requires:** ${wf.required_inputs.join(', ')}`);
      }
      if (wf.optional_inputs.length > 0) {
        lines.push(`- **Optional:** ${wf.optional_inputs.join(', ')}`);
      }
      lines.push(`- **Tags:** ${wf.tags.join(', ')}`);
      lines.push(`- **Used:** ${wf.execution_count}x${wf.last_executed ? ` (last: ${new Date(wf.last_executed).toLocaleDateString()})` : ''}`);
      if (wf.trigger_phrases.length > 0) {
        lines.push(`- **Triggers:** "${wf.trigger_phrases.slice(0, 3).join('", "')}"`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/** Shared instance — import this everywhere instead of constructing new ones */
export const workflowStore = new WorkflowStore();
