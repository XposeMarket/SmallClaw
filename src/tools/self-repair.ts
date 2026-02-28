/**
 * self-repair.ts — SmallClaw Self-Repair Tool
 *
 * Flow:
 *   1. AI analyzes an error using read_source + list_source
 *   2. AI calls propose_repair() with error context + a unified diff patch
 *   3. The patch is stored in .smallclaw/pending-repairs/<id>.json
 *   4. A formatted proposal is returned (Telegram sends it to the user)
 *   5. User replies /approve <id> or /reject <id> in Telegram
 *   6. On approval: patch is applied to src/, npm run build runs, gateway restarts
 *   7. On rejection or build failure: patch is discarded/reverted
 *
 * The AI CANNOT self-apply patches. The approval gate is enforced here.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { ToolResult } from '../types.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

function getSmallClawRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

function getSmallClawDataDir(): string {
  const projectData = path.join(getSmallClawRoot(), '.smallclaw');
  const homeData = path.join(os.homedir(), '.smallclaw');
  return fs.existsSync(projectData) ? projectData : homeData;
}

function getPendingRepairsDir(): string {
  const dir = path.join(getSmallClawDataDir(), 'pending-repairs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRepairFilePath(id: string): string {
  return path.join(getPendingRepairsDir(), `${id}.json`);
}

// ─── Repair Record Type ───────────────────────────────────────────────────────

export interface PendingRepair {
  id: string;
  createdAt: number;
  errorSummary: string;
  rootCause: string;
  affectedFile: string;      // e.g. "src/gateway/telegram-channel.ts"
  affectedLines: string;     // e.g. "lines 45-52" (human-readable)
  fixDescription: string;    // plain English description of the fix
  patch: string;             // unified diff (git format)
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  taskId?: string;           // if triggered from a background task
  buildOutput?: string;      // populated after apply attempt
}

// ─── Storage Helpers ──────────────────────────────────────────────────────────

export function savePendingRepair(repair: PendingRepair): void {
  const filePath = getRepairFilePath(repair.id);
  fs.writeFileSync(filePath, JSON.stringify(repair, null, 2), 'utf-8');
}

export function loadPendingRepair(id: string): PendingRepair | null {
  const filePath = getRepairFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PendingRepair;
  } catch {
    return null;
  }
}

export function listPendingRepairs(): PendingRepair[] {
  const dir = getPendingRepairsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as PendingRepair; }
      catch { return null; }
    })
    .filter((r): r is PendingRepair => r !== null && r.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function deletePendingRepair(id: string): boolean {
  const filePath = getRepairFilePath(id);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ─── propose_repair tool ──────────────────────────────────────────────────────

export interface ProposeRepairArgs {
  error_summary: string;     // 1-2 sentence error description
  root_cause: string;        // What is the actual bug
  affected_file: string;     // e.g. "gateway/telegram-channel.ts" (relative to src/)
  affected_lines: string;    // e.g. "lines 45-52"
  fix_description: string;   // Plain English: what the fix does
  patch: string;             // Unified diff patch (git format, paths relative to project root)
  task_id?: string;          // Optional: ID of the background task that hit the error
}

export async function executeProposeRepair(args: ProposeRepairArgs): Promise<ToolResult> {
  // Validate required fields
  const required: (keyof ProposeRepairArgs)[] = [
    'error_summary', 'root_cause', 'affected_file', 'fix_description', 'patch',
  ];
  for (const field of required) {
    if (!args?.[field]?.toString().trim()) {
      return { success: false, error: `${field} is required` };
    }
  }

  // Validate the patch looks like a unified diff
  const patchText = String(args.patch || '').trim();
  if (!patchText.includes('---') || !patchText.includes('+++') || !patchText.includes('@@')) {
    return {
      success: false,
      error: 'patch must be a valid unified diff (must contain ---, +++, and @@ markers)',
    };
  }

  // Dry-run the patch to make sure it applies cleanly before storing
  const root = getSmallClawRoot();
  const tmpPatch = path.join(os.tmpdir(), `smallclaw-repair-check-${Date.now()}.patch`);
  try {
    fs.writeFileSync(tmpPatch, patchText, 'utf-8');
    execSync(`git apply --check --whitespace=nowarn "${tmpPatch}"`, {
      cwd: root,
      stdio: 'pipe',
    });
  } catch (checkErr: any) {
    const details = String(checkErr?.stderr || checkErr?.stdout || checkErr?.message || 'unknown').trim();
    return {
      success: false,
      error: `Patch dry-run failed — it does not apply cleanly to current source:\n${details}\n\nDouble-check the diff context lines match the actual file content.`,
    };
  } finally {
    try { fs.unlinkSync(tmpPatch); } catch {}
  }

  // Generate a short ID for the repair
  const id = randomUUID().slice(0, 8);

  const repair: PendingRepair = {
    id,
    createdAt: Date.now(),
    errorSummary: String(args.error_summary).trim(),
    rootCause: String(args.root_cause).trim(),
    affectedFile: `src/${String(args.affected_file).replace(/^src\//, '').trim()}`,
    affectedLines: String(args.affected_lines || 'unspecified').trim(),
    fixDescription: String(args.fix_description).trim(),
    patch: patchText,
    status: 'pending',
    taskId: args.task_id ? String(args.task_id).trim() : undefined,
  };

  savePendingRepair(repair);

  // Format the proposal message (this gets sent to Telegram)
  const proposal = formatRepairProposal(repair);

  return {
    success: true,
    data: { repair_id: id, repair },
    stdout: proposal,
  };
}

export function formatRepairProposal(repair: PendingRepair): string {
  const lines = [
    `🔧 <b>Self-Repair Proposal #${repair.id}</b>`,
    ``,
    `📍 <b>File:</b> <code>${repair.affectedFile}</code> (${repair.affectedLines})`,
    ``,
    `❌ <b>Error:</b>`,
    repair.errorSummary,
    ``,
    `🔍 <b>Root Cause:</b>`,
    repair.rootCause,
    ``,
    `🩹 <b>Proposed Fix:</b>`,
    repair.fixDescription,
    ``,
    `<pre>${repair.patch.slice(0, 1500)}${repair.patch.length > 1500 ? '\n...(truncated)' : ''}</pre>`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Reply <b>/approve ${repair.id}</b> to apply this fix, rebuild, and restart.`,
    `Reply <b>/reject ${repair.id}</b> to discard it.`,
  ];
  return lines.join('\n');
}

export const proposeRepairTool = {
  name: 'propose_repair',
  description:
    'Propose a source code repair after analyzing an error. The patch is stored as pending and ' +
    'sent to the user over Telegram for approval. The patch is NEVER applied automatically — ' +
    'the user must reply /approve <id> to trigger the apply + rebuild flow. ' +
    'IMPORTANT: Always use read_source and list_source FIRST to understand the bug before calling this.',
  execute: executeProposeRepair,
  schema: {
    error_summary: 'string (required) — 1-2 sentence description of the error',
    root_cause: 'string (required) — technical explanation of what caused the bug',
    affected_file: 'string (required) — file path relative to src/, e.g. "gateway/telegram-channel.ts"',
    affected_lines: 'string (required) — human-readable line range, e.g. "lines 45-52"',
    fix_description: 'string (required) — plain English description of what the fix does',
    patch: 'string (required) — unified diff patch in git format (paths relative to project root)',
    task_id: 'string (optional) — ID of the background task that encountered the error',
  },
  jsonSchema: {
    type: 'object',
    required: ['error_summary', 'root_cause', 'affected_file', 'affected_lines', 'fix_description', 'patch'],
    properties: {
      error_summary: { type: 'string' },
      root_cause: { type: 'string' },
      affected_file: { type: 'string' },
      affected_lines: { type: 'string' },
      fix_description: { type: 'string' },
      patch: { type: 'string' },
      task_id: { type: 'string' },
    },
    additionalProperties: false,
  },
};

// ─── Apply + Build (called by Telegram /approve handler) ─────────────────────

export interface ApplyRepairResult {
  success: boolean;
  repairId: string;
  message: string;
  buildOutput?: string;
}

export async function applyApprovedRepair(repairId: string): Promise<ApplyRepairResult> {
  const repair = loadPendingRepair(repairId);
  if (!repair) {
    return { success: false, repairId, message: `No pending repair found with ID: ${repairId}` };
  }
  if (repair.status !== 'pending') {
    return { success: false, repairId, message: `Repair #${repairId} is not pending (status: ${repair.status})` };
  }

  const root = getSmallClawRoot();
  const tmpPatch = path.join(os.tmpdir(), `smallclaw-repair-apply-${Date.now()}.patch`);

  try {
    fs.writeFileSync(tmpPatch, repair.patch, 'utf-8');

    // Step 1: Final check before apply
    try {
      execSync(`git apply --check --whitespace=nowarn "${tmpPatch}"`, { cwd: root, stdio: 'pipe' });
    } catch (checkErr: any) {
      const details = String(checkErr?.stderr || checkErr?.message || '').slice(0, 500);
      repair.status = 'failed';
      repair.buildOutput = `Patch no longer applies cleanly:\n${details}`;
      savePendingRepair(repair);
      return {
        success: false,
        repairId,
        message: `❌ Repair #${repairId} — patch no longer applies (source may have changed).\n\n${details}`,
      };
    }

    // Step 2: Apply the patch
    execSync(`git apply --whitespace=nowarn "${tmpPatch}"`, { cwd: root, stdio: 'pipe' });
    repair.status = 'approved';
    savePendingRepair(repair);

  } catch (applyErr: any) {
    const details = String(applyErr?.stderr || applyErr?.message || '').slice(0, 500);
    repair.status = 'failed';
    repair.buildOutput = `Patch apply failed:\n${details}`;
    savePendingRepair(repair);
    return { success: false, repairId, message: `❌ Failed to apply patch #${repairId}:\n\n${details}` };
  } finally {
    try { fs.unlinkSync(tmpPatch); } catch {}
  }

  // Step 3: Build
  let buildOutput = '';
  try {
    buildOutput = execSync('npm run build', {
      cwd: root,
      encoding: 'utf-8',
      timeout: 120_000, // 2 min build timeout
      stdio: 'pipe',
    });
    repair.status = 'applied';
    repair.buildOutput = buildOutput.slice(0, 1000);
    savePendingRepair(repair);
  } catch (buildErr: any) {
    buildOutput = String(buildErr?.stderr || buildErr?.stdout || buildErr?.message || '').slice(0, 800);
    repair.status = 'failed';
    repair.buildOutput = buildOutput;
    savePendingRepair(repair);

    // Revert the patch since build failed
    const revertPatch = path.join(os.tmpdir(), `smallclaw-repair-revert-${Date.now()}.patch`);
    try {
      fs.writeFileSync(revertPatch, repair.patch, 'utf-8');
      execSync(`git apply --reverse --whitespace=nowarn "${revertPatch}"`, { cwd: root, stdio: 'pipe' });
    } catch {
      // Revert also failed — leave a note
      repair.buildOutput += '\n\n⚠️ Auto-revert also failed. Source may be in a modified state.';
      savePendingRepair(repair);
    } finally {
      try { fs.unlinkSync(revertPatch); } catch {}
    }

    return {
      success: false,
      repairId,
      message: `❌ Patch applied but <b>build failed</b> — patch has been reverted.\n\n<pre>${buildOutput.slice(0, 600)}</pre>`,
      buildOutput,
    };
  }

  // Step 4: Restart gateway (same pattern as self-update.ts)
  triggerGatewayRestart(root, repairId);

  return {
    success: true,
    repairId,
    message: `✅ Repair #${repairId} applied and built successfully!\n\n📍 Fixed: <code>${repair.affectedFile}</code>\n\nGateway is restarting now — I'll be back in a moment.`,
    buildOutput,
  };
}

/** Spawns restart detached so the current process can exit cleanly */
function triggerGatewayRestart(root: string, repairId: string): void {
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      const batPath = path.join(root, 'start-smallclaw.bat');
      if (fs.existsSync(batPath)) {
        const child = spawn('cmd.exe', ['/c', batPath], {
          cwd: root, detached: true, stdio: 'ignore', windowsHide: false,
        });
        child.unref();
        return;
      }
    }
    // Cross-platform fallback
    const child = spawn('npm', ['start'], { cwd: root, detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err: any) {
    console.error(`[self-repair] Restart failed after applying repair #${repairId}:`, err.message);
  }
}
