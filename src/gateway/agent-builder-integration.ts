/**
 * agent-builder-integration.ts
 * SmallClaw ↔ Agent Builder bridge — with persistent workflow memory
 *
 * Tools exposed to the LLM:
 *   1. architect_workflow          — Design + create a new workflow
 *   2. verify_workflow_credentials — Check all creds are present
 *   3. test_workflow               — Run a dry-run test
 *   4. deploy_workflow             — Activate + SAVE to WorkflowStore
 *   5. get_workflow_status         — Check current status
 *   6. search_workflow_templates   — Search WorkflowStore (local-first, then Agent Builder)
 *   7. execute_workflow_template   — Execute a registered workflow
 *   8. create_node_subagent        — Create + attach a writing subagent for AI-authoring nodes
 *
 * File location: src/gateway/agent-builder-integration.ts
 */

import http from 'http';
import https from 'https';
import { workflowStore, StoredWorkflow } from './workflow-store';

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT_BUILDER_URL = process.env.AGENT_BUILDER_URL || 'http://localhost:3005';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function abCall(method: string, path: string, body?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, AGENT_BUILDER_URL);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SmallClaw-AgentBuilder/1.5',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      timeout: REQUEST_TIMEOUT_MS
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ ok: false, error: 'Non-JSON response from Agent Builder', raw: data });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Agent Builder request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(
        `Agent Builder unreachable at ${AGENT_BUILDER_URL}. Is it running? (${err.message})`
      ));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** abCall with automatic retry on transient errors */
async function abCallWithRetry(method: string, path: string, body?: object, retries = MAX_RETRIES): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await abCall(method, path, body);
    } catch (err: any) {
      if (attempt === retries) throw err;
      console.warn(`[AgentBuilder] Attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

/**
 * Tool 1: architect_workflow
 *
 * IMPORTANT: The LLM should ALWAYS call search_workflow_templates first.
 * Only call this if no suitable template exists.
 */
async function architect_workflow(args: {
  description: string;
  constraints?: Record<string, any>;
}): Promise<string> {
  console.log('[AgentBuilder] architect_workflow:', args.description);

  // Pre-flight: check local store first — LLM might have skipped search
  const localMatches = workflowStore.search(args.description, { limit: 3 });
  if (localMatches.length > 0) {
    const suggestions = localMatches.map(wf =>
      `- "${wf.name}" [${wf.workflow_id}] — ${wf.description}`
    ).join('\n');
    return JSON.stringify({
      success: false,
      hint: 'existing_workflows_found',
      message: 'Before creating a new workflow, consider these existing ones:',
      suggestions,
      action: 'Use execute_workflow_template() with one of these IDs, or call architect_workflow() again with force=true to override.'
    });
  }

  try {
    const result = await abCallWithRetry('POST', '/api/v1/ai/architect', {
      description: args.description,
      constraints: args.constraints || {}
    });

    if (result.workflow_id) {
      console.log(`[AgentBuilder] Workflow designed: ${result.workflow_id}`);
    }

    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

/**
 * Tool 2: verify_workflow_credentials
 */
async function verify_workflow_credentials(args: { workflow_id: string }): Promise<string> {
  console.log('[AgentBuilder] verify_credentials:', args.workflow_id);

  try {
    const result = await abCallWithRetry('GET', `/api/v1/workflows/${args.workflow_id}/verify-credentials`);

    if (result.all_credentials_present) {
      workflowStore.markCredentialsVerified(args.workflow_id);
      console.log(`[WorkflowStore] Credentials verified for ${args.workflow_id}`);
    }

    // Build a human-friendly message SmallClaw can relay directly to the user.
    // If credentials are missing, include the deep-link URLs so the user can
    // click straight into the right Agent Builder credential form.
    if (!result.all_credentials_present && result.credential_actions?.length) {
      const actions: Array<{ provider: string; label: string; add_credential_url: string }> = result.credential_actions;

      const linkLines = actions.map((a: any) =>
        `• **${a.provider}** (${a.label})\n  → [Add credentials here](${a.add_credential_url})`
      ).join('\n');

      result.user_message = [
        `To continue building this workflow I need ${actions.length === 1 ? 'a credential' : 'some credentials'} from you:\n`,
        linkLines,
        `\nEach link opens Agent Builder directly to the right setup form.`,
        `Once you\'ve added them, just say \'done\' and I\'ll verify and continue.`,
      ].join('\n');
    } else if (result.all_credentials_present) {
      result.user_message = `All credentials are configured — ready to test and deploy.`;
    }

    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

/**
 * Tool 3: test_workflow
 */
async function test_workflow(args: { workflow_id: string }): Promise<string> {
  console.log('[AgentBuilder] test_workflow:', args.workflow_id);

  try {
    const result = await abCallWithRetry('POST', `/api/v1/workflows/${args.workflow_id}/test`);
    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

/**
 * Tool 4: deploy_workflow
 *
 * This is the critical persistence point. After a successful deploy,
 * the workflow is saved to WorkflowStore so SmallClaw remembers it forever.
 */
async function deploy_workflow(args: {
  workflow_id: string;
  name: string;
  description: string;
  type: StoredWorkflow['type'];
  action: string;
  tags?: string[];
  required_inputs?: string[];
  optional_inputs?: string[];
  credentials_required?: string[];
  cron_expression?: string;
}): Promise<string> {
  console.log('[AgentBuilder] deploy_workflow:', args.workflow_id);

  try {
    // 1. Activate the workflow in Agent Builder's SQLite (sets status = 'active',
    //    also registers cron job if it has a cron_expression)
    await abCallWithRetry('POST', `/api/v1/workflows/${args.workflow_id}/activate`);
    console.log(`[AgentBuilder] Workflow ${args.workflow_id} activated`);

    // 2. Register as a reusable template — returns reg_xxxxxx template_id
    //    This is what registry/execute requires to dispatch the run
    const registryResult = await abCallWithRetry('POST', `/api/v1/workflows/registry/register`, {
      workflow_id: args.workflow_id,
      name: args.name,
      description: args.description,
      tags: args.tags || [],
      parameters: (args.required_inputs || []).map((name: string) => ({
        name,
        description: `Input: ${name}`,
        required: true,
      })).concat(
        (args.optional_inputs || []).map((name: string) => ({
          name,
          description: `Input: ${name}`,
          required: false,
        }))
      ),
    });

    // Extract the reg_xxxxxx template ID from the registry response
    const templateId: string | undefined =
      registryResult?.template?.id ||
      registryResult?.id ||
      undefined;

    if (!templateId) {
      console.warn(`[AgentBuilder] registry/register did not return a template id — execute will fall back to direct execution`);
    } else {
      console.log(`[AgentBuilder] Registry template ID: ${templateId}`);
    }

    // 3. Save to SmallClaw's persistent store — includes template_id for future execute calls
    const stored = workflowStore.register({
      workflow_id: args.workflow_id,
      template_id: templateId,
      name: args.name,
      description: args.description,
      type: args.type,
      action: args.action,
      tags: args.tags || [],
      required_inputs: args.required_inputs || [],
      optional_inputs: args.optional_inputs || [],
      status: 'active',
      cron_expression: args.cron_expression,
      credentials_required: args.credentials_required || [],
      credentials_verified: true,
    });

    console.log(`[WorkflowStore] ✅ Saved to persistent store: ${stored.workflow_id} (template: ${templateId ?? 'none'}) — "${stored.name}"`);

    return JSON.stringify({
      success: true,
      workflow_id: args.workflow_id,
      template_id: templateId,
      persisted_locally: true,
      message: `Workflow "${args.name}" activated and saved. Future requests will reuse this workflow — no rebuild needed.`,
      reuse_tip: `To execute this workflow again, call execute_workflow_template("${args.workflow_id}", { ...inputs })`
    });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

/**
 * Tool 5: get_workflow_status
 */
async function get_workflow_status(args: { workflow_id: string }): Promise<string> {
  console.log('[AgentBuilder] get_workflow_status:', args.workflow_id);

  // Check local store first for instant response
  const local = workflowStore.get(args.workflow_id);

  try {
    const result = await abCallWithRetry('GET', `/api/v1/workflows/${args.workflow_id}/details`);

    // Sync status back to local store if it changed
    if (result.status && local) {
      workflowStore.updateStatus(args.workflow_id, result.status);
    }

    return JSON.stringify({
      ...result,
      local_record: local ? {
        execution_count: local.execution_count,
        last_executed: local.last_executed,
        credentials_verified: local.credentials_verified
      } : null
    });
  } catch (err: any) {
    // Serve from local cache if Agent Builder is unreachable
    if (local) {
      console.warn('[AgentBuilder] Serving from local cache — Agent Builder unreachable');
      return JSON.stringify({
        success: true,
        source: 'local_cache',
        workflow_id: local.workflow_id,
        name: local.name,
        status: local.status,
        execution_count: local.execution_count,
        last_executed: local.last_executed,
        warning: 'Agent Builder unreachable — showing cached data'
      });
    }
    return JSON.stringify({ success: false, error: err.message });
  }
}

/**
 * Tool 6: search_workflow_templates
 *
 * LOCAL-FIRST: Searches SmallClaw's persistent store before hitting Agent Builder.
 * This is the primary way SmallClaw avoids creating duplicate workflows.
 *
 * LLM should ALWAYS call this before architect_workflow().
 */
async function search_workflow_templates(args: {
  query: string;
  type?: 'action' | 'scheduled' | 'background';
  limit?: number;
}): Promise<string> {
  console.log('[WorkflowStore] search_workflow_templates:', args.query);

  // 1. Search local persistent store first (instant, no network)
  const localResults = workflowStore.search(args.query, {
    type: args.type,
    limit: args.limit || 5
  });

  if (localResults.length > 0) {
    console.log(`[WorkflowStore] Found ${localResults.length} local matches for "${args.query}"`);
    return JSON.stringify({
      success: true,
      source: 'local_store',
      query: args.query,
      templates: localResults.map(wf => ({
        workflow_id: wf.workflow_id,
        name: wf.name,
        description: wf.description,
        type: wf.type,
        action: wf.action,
        tags: wf.tags,
        required_inputs: wf.required_inputs,
        optional_inputs: wf.optional_inputs,
        execution_count: wf.execution_count,
        last_executed: wf.last_executed,
        status: wf.status
      })),
      count: localResults.length,
      message: localResults.length === 1
        ? `Found an existing workflow that matches. Use execute_workflow_template("${localResults[0].workflow_id}", {...}) instead of creating a new one.`
        : `Found ${localResults.length} existing workflows. Choose one and use execute_workflow_template() to run it.`
    });
  }

  // 2. Fall back to Agent Builder registry (may have entries not in local store yet)
  console.log('[WorkflowStore] No local matches — checking Agent Builder registry');
  try {
    const params = new URLSearchParams({ search: args.query, limit: String(args.limit || 5) });
    if (args.type) params.set('type', args.type);

    const result = await abCallWithRetry('GET', `/api/v1/workflows/registry/list?${params}`);

    if (result.templates && result.templates.length > 0) {
      // Backfill any Agent Builder templates we don't have locally
      for (const tpl of result.templates) {
        if (tpl.workflow_id && !workflowStore.has(tpl.workflow_id)) {
          workflowStore.register({
            workflow_id: tpl.workflow_id,
            name: tpl.name,
            description: tpl.description || '',
            type: tpl.type || 'action',
            action: tpl.action || 'custom',
            tags: tpl.tags || [],
            required_inputs: tpl.required_inputs || [],
            optional_inputs: tpl.optional_inputs || [],
            status: 'active',
            credentials_required: [],
          });
          console.log(`[WorkflowStore] Backfilled workflow from Agent Builder: ${tpl.workflow_id}`);
        }
      }
    }

    return JSON.stringify({
      success: true,
      source: 'agent_builder_registry',
      ...result,
      templates: result.templates || [],
      count: result.templates?.length || 0
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      source: 'none',
      error: err.message,
      local_count: 0,
      message: 'No existing templates found. Use architect_workflow() to create a new one.'
    });
  }
}

/**
 * Tool 7: execute_workflow_template
 *
 * Execute a registered workflow with runtime parameters.
 * Records execution in WorkflowStore for usage tracking.
 */
async function execute_workflow_template(args: {
  workflow_id: string;
  inputs?: Record<string, any>;
  trigger_phrase?: string;
}): Promise<string> {
  console.log('[AgentBuilder] execute_workflow_template:', args.workflow_id);

  // Look up locally to validate before calling Agent Builder
  const local = workflowStore.get(args.workflow_id);
  if (local && local.status !== 'active') {
    return JSON.stringify({
      success: false,
      error: `Workflow "${local.name}" is not active (status: ${local.status}). Check Agent Builder dashboard.`
    });
  }

  try {
    let result: any;

    if (local?.template_id) {
      // Primary path: registry/execute requires template_id (reg_xxxxxx)
      // WorkflowRegistry is in Agent Builder RAM, so this works as long as
      // Agent Builder hasn't restarted since deploy. If it has, fall through.
      result = await abCallWithRetry('POST', `/api/v1/workflows/registry/execute`, {
        template_id: local.template_id,
        parameters: args.inputs || {},
      });

      // If Agent Builder restarted, WorkflowRegistry is empty — fall back to direct execute
      if (!result?.ok && (result?.error?.includes('Template not found') || result?.error?.includes('template_id'))) {
        console.warn(`[AgentBuilder] Template ${local.template_id} not found in registry (restart?) — falling back to direct execute`);
        result = await abCallWithRetry('POST', `/api/v1/workflows/${args.workflow_id}/execute?sync=true`, {
          triggerData: args.inputs || {},
        });
      }
    } else {
      // Fallback path: no template_id stored (deployed before this fix, or registry/register failed)
      // Hit the workflow's direct execute endpoint instead
      console.warn(`[AgentBuilder] No template_id for ${args.workflow_id} — using direct execute`);
      result = await abCallWithRetry('POST', `/api/v1/workflows/${args.workflow_id}/execute?sync=true`, {
        triggerData: args.inputs || {},
      });
    }

    // Record execution in local store
    workflowStore.recordExecution(args.workflow_id);

    // If the user used a phrase to trigger this, learn it
    if (args.trigger_phrase && local) {
      workflowStore.addTriggerPhrases(args.workflow_id, [args.trigger_phrase]);
    }

    const name = local?.name || args.workflow_id;
    const execCount = (local?.execution_count ?? 0) + 1;
    const wasSuccess = result?.ok === true || result?.success === true;
    const output = result?.result?.output || result?.output || null;
    const duration = result?.result?.duration || result?.duration || null;

    // Build a plain-English summary the LLM should relay to the user verbatim.
    // This is the notification bridge — Agent Builder ran something, SmallClaw tells you.
    let user_message: string;
    if (wasSuccess) {
      const parts = [`✅ **${name}** ran successfully.`];
      if (duration) parts.push(`Completed in ${duration < 1000 ? duration + 'ms' : (duration / 1000).toFixed(1) + 's'}.`);
      if (output && typeof output === 'object') {
        const outputStr = JSON.stringify(output, null, 2);
        if (outputStr.length < 400) parts.push(`\nOutput:\n\`\`\`\n${outputStr}\n\`\`\``);
      } else if (output && typeof output === 'string' && output.length < 400) {
        parts.push(`\nOutput: ${output}`);
      }
      parts.push(`\n_(Run #${execCount} for this workflow)_`);
      user_message = parts.join(' ');
    } else {
      const errorMsg = result?.result?.error || result?.error || 'unknown error';
      user_message = [
        `❌ **${name}** failed.`,
        `Error: ${errorMsg}`,
        `You can check the full execution log in Agent Builder under Executions.`,
      ].join('\n');
    }

    return JSON.stringify({
      ...result,
      workflow_name: name,
      execution_count: execCount,
      user_message,
    });
  } catch (err: any) {
    const name = local?.name || args.workflow_id;
    return JSON.stringify({
      success: false,
      error: err.message,
      user_message: `❌ **${name}** could not be executed. Agent Builder may be offline or the workflow may have an error. Details: ${err.message}`,
    });
  }
}

// ─── Tool Definitions (LLM schema) ────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────────
// Tool 8: create_node_subagent
// Called when architect detects an AI-authoring node (tweet, email, Slack, etc.)
// Runs an onboarding conversation, builds the subagent workspace + identity files,
// then returns the agentId to be stored in node.data.subagent_config.
// ───────────────────────────────────────────────────────────────────────────────

async function create_node_subagent(args: {
  node_type: string;
  node_action: string;
  workflow_id: string;
  workflow_name: string;
  onboarding_answers: {
    purpose: string;          // "What is this account/channel about?"
    tone: string;             // "What tone should content have?"
    hard_rules: string;       // "Any hard rules? Things to never say?"
    topics: string;           // "What topics should it cover?"
    post_frequency?: string;  // "How often will this run?"
    extra?: string;           // Any other instructions
  };
}): Promise<string> {
  const { node_type, node_action, workflow_id, workflow_name, onboarding_answers: answers } = args;

  // Generate a stable, human-readable agentId
  const slug = workflow_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30);
  const suffix = Math.random().toString(36).slice(2, 7);
  const agentId = `${slug}_${suffix}`;

  const nodeLabel = `${node_type} (${node_action})`;
  const outputField = OUTPUT_FIELD_FOR_NODE[node_type] || 'text';

  // Build SOUL.md — the agent's immutable identity and voice
  const soulMd = [
    `# ${workflow_name} — Writing Agent`,
    ``,
    `## Purpose`,
    answers.purpose,
    ``,
    `## Tone`,
    answers.tone,
    ``,
    `## Hard Rules (NEVER violate these)`,
    answers.hard_rules,
    ``,
    `## Post Frequency`,
    answers.post_frequency || 'Not specified',
    ``,
    `## Additional Instructions`,
    answers.extra || 'None',
    ``,
    `---`,
    `This file defines who you are. Read it before every task.`,
    `Do not deviate from these instructions.`,
  ].join('\n');

  // Build topics.md — the rotation list
  const topicsMd = [
    `# Topics Rotation`,
    ``,
    `Rotate through these topics. Track which you've covered in MEMORY.md.`,
    ``,
    answers.topics
      .split(/[,\n]+/)
      .map((t: string) => t.trim())
      .filter(Boolean)
      .map((t: string, i: number) => `${i + 1}. ${t}`)
      .join('\n'),
  ].join('\n');

  // Build MEMORY.md — seeded with initial context
  const memoryMd = [
    `# Memory`,
    ``,
    `## Last Topics Covered`,
    `(none yet — this is the first run)`,
    ``,
    `## Notes`,
    `Agent created for workflow: ${workflow_name} (${workflow_id})`,
    `Node: ${nodeLabel}`,
    `Created: ${new Date().toISOString()}`,
  ].join('\n');

  // Build system_instructions for the config
  const systemInstructions = [
    `You are a specialized writing agent for: ${answers.purpose}`,
    ``,
    `Your job is to generate ${nodeLabel} content that is:`,
    `- Tone: ${answers.tone}`,
    `- Relevant to the current topic rotation (see topics.md)`,
    `- Never repeating what you've already posted (see history.md)`,
    ``,
    `Before writing, ALWAYS:`,
    `1. Read SOUL.md for your voice and hard rules`,
    `2. Read topics.md for the current topic rotation`,
    `3. Read history.md to avoid repeating yourself`,
    `4. Read MEMORY.md for any running context`,
    ``,
    `After writing, update MEMORY.md with what topic you covered.`,
    `Return your output as JSON: { "${outputField}": "your content here" }`,
  ].join('\n');

  // Write all workspace files via Agent Builder's subagent registry endpoint
  // (Agent Builder stores them and SmallClaw reads them at runtime)
  const result = await abCallWithRetry('POST', '/api/v1/subagents/create', {
    agent_id: agentId,
    workflow_id,
    node_type,
    node_action,
    output_field: outputField,
    name: `${workflow_name} Writer`,
    description: answers.purpose,
    system_instructions: systemInstructions,
    constraints: [
      answers.hard_rules,
      'Return output as JSON with the correct output_field key',
      'Read memory files before every task',
      'Update MEMORY.md after every task',
      'Never repeat a topic covered in history.md',
    ].filter(Boolean),
    success_criteria: `A complete, ready-to-publish ${node_action} in the correct JSON format`,
    max_steps: 10,
    timeout_ms: 45_000,
    memory_files: {
      'SOUL.md': soulMd,
      'topics.md': topicsMd,
      'MEMORY.md': memoryMd,
    },
  });

  const taskTemplate = [
    `You are the ${workflow_name} writing agent.`,
    `Read your SOUL.md, topics.md, and history.md first.`,
    `Write one ${node_action} following your tone and topic rotation.`,
    `Return ONLY: { "${outputField}": "your content here" }`,
  ].join(' ');

  // Now patch the workflow node with the subagent_config
  await abCallWithRetry('POST', `/api/v1/workflows/${workflow_id}/patch-node-subagent`, {
    agent_id: agentId,
    node_type,
    node_action,
    task_template: taskTemplate,
    output_field: outputField,
  });

  const user_message = [
    `✅ Created **${workflow_name} Writer** agent (\`${agentId}\`).`,
    ``,
    `This agent will generate ${node_action} content each time the workflow runs.`,
    `It has its own memory, topic rotation, and voice defined by what you told me.`,
    ``,
    `**Identity:** ${answers.purpose}`,
    `**Tone:** ${answers.tone}`,
    `**Topics:** ${answers.topics.slice(0, 100)}${answers.topics.length > 100 ? '...' : ''}`,
    ``,
    `The workflow is ready to deploy. Want me to continue?`,
  ].join('\n');

  return JSON.stringify({
    success: true,
    agent_id: agentId,
    workflow_id,
    output_field: outputField,
    user_message,
    ...(result || {}),
  });
}

// Map node types to their output field name (mirrors agent-node-registry.js)
const OUTPUT_FIELD_FOR_NODE: Record<string, string> = {
  'social.twitter':    'text',
  'social.linkedin':   'text',
  'social.facebook':   'message',
  'google.gmail':      'body',
  'email.send':        'body',
  'notify.slack':      'text',
  'notify.discord':    'content',
  'google.docs':       'content',
  'microsoft.outlook': 'body',
  'microsoft.teams':   'message',
};

export const AGENT_BUILDER_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'architect_workflow',
      description: `Design and create a NEW workflow in Agent Builder. \nIMPORTANT: ALWAYS call search_workflow_templates first. Only call this if no suitable template exists — creating duplicates wastes time and API budget.\nIf search returns results, use execute_workflow_template() instead.`,
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Plain English description of what the workflow should do. Be specific: platform, trigger, action, frequency.'
          },
          constraints: {
            type: 'object',
            description: 'Optional constraints: { schedule: "9am daily", platforms: ["x"], tone: "professional" }'
          }
        },
        required: ['description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'verify_workflow_credentials',
      description: 'Check whether all required API credentials for a workflow are present in Agent Builder. Call this after architect_workflow() returns credentials_needed.',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'Workflow ID from architect_workflow response, e.g. wf_abc123' }
        },
        required: ['workflow_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'test_workflow',
      description: 'Run a dry-run test of a workflow to verify it works before deploying. Call after credentials are verified.',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'Workflow ID to test' }
        },
        required: ['workflow_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deploy_workflow',
      description: 'Activate a workflow and save it to SmallClaw\'s persistent registry. After this, the workflow is remembered forever and can be reused with execute_workflow_template(). Call only after test_workflow() passes.',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'Workflow ID to deploy' },
          name: { type: 'string', description: 'Short display name, e.g. "X Daily Posts"' },
          description: { type: 'string', description: 'What this workflow does' },
          type: {
            type: 'string',
            enum: ['action', 'scheduled', 'background'],
            description: 'action=runs on demand, scheduled=runs on cron, background=always running'
          },
          action: { type: 'string', description: 'Primary verb: post, send, fetch, monitor, etc.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Search tags: ["social", "x", "daily"]' },
          required_inputs: { type: 'array', items: { type: 'string' }, description: 'Params required to execute, e.g. ["text"]' },
          optional_inputs: { type: 'array', items: { type: 'string' }, description: 'Optional params, e.g. ["hashtags"]' },
          credentials_required: { type: 'array', items: { type: 'string' }, description: 'Credential providers needed, e.g. ["X API"]' },
          cron_expression: { type: 'string', description: 'Cron schedule if type=scheduled, e.g. "0 9 * * *"' }
        },
        required: ['workflow_id', 'name', 'description', 'type', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_workflow_status',
      description: 'Get the current status and execution history of a deployed workflow.',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'Workflow ID to check' }
        },
        required: ['workflow_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_workflow_templates',
      description: `Search for existing workflows before creating new ones. \nALWAYS call this FIRST when a user asks to automate something. \nSearches SmallClaw's local registry (instant) then Agent Builder.\nIf results found, use execute_workflow_template() — do NOT call architect_workflow().`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query, e.g. "post to x", "send email", "daily digest"' },
          type: {
            type: 'string',
            enum: ['action', 'scheduled', 'background'],
            description: 'Optional: filter by workflow type'
          },
          limit: { type: 'number', description: 'Max results to return (default: 5)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_workflow_template',
      description: 'Execute an existing workflow with runtime inputs. Use this to run any workflow that was previously deployed — no API calls to rebuild, instant execution.',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'Workflow ID from search_workflow_templates or deploy_workflow' },
          inputs: {
            type: 'object',
            description: 'Runtime inputs the workflow needs, e.g. { "text": "Hello world!", "topic": "AI" }'
          },
          trigger_phrase: {
            type: 'string',
            description: 'The phrase the user said that triggered this execution (helps SmallClaw learn patterns)'
          }
        },
        required: ['workflow_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_node_subagent',
      description: 'Create a persistent SmallClaw writing subagent for an AI-authoring workflow node (tweet/email/slack/etc), then attach it to the node via subagent_config.',
      parameters: {
        type: 'object',
        properties: {
          node_type: { type: 'string', description: 'Workflow node type, e.g. "social.twitter", "google.gmail", "notify.slack"' },
          node_action: { type: 'string', description: 'Node action/mode, e.g. "tweet", "send_email", "post_message"' },
          workflow_id: { type: 'string', description: 'Agent Builder workflow ID, e.g. wf_abc123' },
          workflow_name: { type: 'string', description: 'Human-readable workflow name used to derive subagent id/name' },
          onboarding_answers: {
            type: 'object',
            properties: {
              purpose: { type: 'string', description: 'What this account/channel is about' },
              tone: { type: 'string', description: 'Desired writing tone/personality' },
              hard_rules: { type: 'string', description: 'Hard rules and prohibitions' },
              topics: { type: 'string', description: 'Comma/newline-separated topic rotation list' },
              post_frequency: { type: 'string', description: 'How often the node runs/posts' },
              extra: { type: 'string', description: 'Any extra custom instructions' },
            },
            required: ['purpose', 'tone', 'hard_rules', 'topics'],
          },
        },
        required: ['node_type', 'node_action', 'workflow_id', 'workflow_name', 'onboarding_answers'],
      },
    },
  }
];

// ─── Tool Name Set ─────────────────────────────────────────────────────────────

export const AGENT_BUILDER_TOOL_NAMES = new Set(
  AGENT_BUILDER_TOOL_DEFINITIONS.map(t => t.function.name)
);

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function executeAgentBuilderTool(name: string, args: any): Promise<string> {
  switch (name) {
    case 'architect_workflow':           return architect_workflow(args);
    case 'verify_workflow_credentials':  return verify_workflow_credentials(args);
    case 'test_workflow':                return test_workflow(args);
    case 'deploy_workflow':              return deploy_workflow(args);
    case 'get_workflow_status':          return get_workflow_status(args);
    case 'search_workflow_templates':    return search_workflow_templates(args);
    case 'execute_workflow_template':    return execute_workflow_template(args);
    case 'create_node_subagent':         return create_node_subagent(args);
    default:
      return JSON.stringify({ success: false, error: `Unknown tool: ${name}` });
  }
}

// ─── Registration (fixed return type bug) ─────────────────────────────────────

/**
 * Register all Agent Builder tools into SmallClaw's tool array.
 *
 * FIX: Now returns the definitions array so callers can spread it:
 *   tools.push(...registerAgentBuilderTools(tools))  <- wrong pattern
 *   registerAgentBuilderTools(tools)                 <- correct (mutates + returns)
 *
 * In server-v2.ts buildTools(), use Option B (cleaner):
 *   registerAgentBuilderTools(tools);
 *   return tools;
 */
export function registerAgentBuilderTools(toolsArray: any[]): any[] {
  for (const tool of AGENT_BUILDER_TOOL_DEFINITIONS) {
    if (!toolsArray.find((t: any) => t?.function?.name === tool.function.name)) {
      toolsArray.push(tool);
    }
  }
  console.log(`[AgentBuilder] Registered ${AGENT_BUILDER_TOOL_DEFINITIONS.length} tools:`,
    AGENT_BUILDER_TOOL_DEFINITIONS.map(t => t.function.name));
  return AGENT_BUILDER_TOOL_DEFINITIONS;
}

// ─── Utility: inject workflow memory into system prompt ───────────────────────

/**
 * Returns a block to append to SmallClaw's system prompt.
 * Tells the LLM what workflows already exist so it doesn't try to recreate them.
 *
 * Usage in server-v2.ts:
 *   const systemPrompt = BASE_SYSTEM_PROMPT + '\n\n' + getWorkflowContextBlock();
 */
export function getWorkflowContextBlock(): string {
  const summary = workflowStore.toLLMSummary();
  const stats = workflowStore.getStats();

  return [
    '---',
    '## Your Workflow Memory',
    `You have ${stats.total_workflows} workflow(s) registered (${stats.active_workflows} active).`,
    'These are ALREADY BUILT AND DEPLOYED. Do not recreate them.',
    'ALWAYS call search_workflow_templates() before architect_workflow().',
    '',
    summary,
    '---'
  ].join('\n');
}
