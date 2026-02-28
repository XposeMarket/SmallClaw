import PTYManager from '../gateway/pty-manager';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { log } from '../security/log-scrubber.js';

export interface ShellToolArgs {
  command: string;
  cwd?: string;
}

// ── Path confinement helper ───────────────────────────────────────────────────
// Uses proper path.resolve + path.relative — immune to case, trailing-slash,
// and "../" traversal bypasses that defeat simple startsWith() checks.
function isPathInsideDir(base: string, target: string): boolean {
  const resolvedBase   = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (resolvedBase === resolvedTarget) return true;
  const rel = path.relative(resolvedBase, resolvedTarget);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ── Absolute-path detector ────────────────────────────────────────────────────
// Catches commands that contain absolute paths outside the workspace even when
// cwd is inside it — e.g. `type C:\Windows\System32\config\SAM`
function containsOutOfScopeAbsPath(command: string, workspacePath: string): boolean {
  // Match Windows and POSIX absolute paths embedded in command strings
  const absPathRe = process.platform === 'win32'
    ? /[A-Za-z]:[/\\][^\s"']+/g
    : /\/[^\s"']{3,}/g;

  const matches = command.match(absPathRe) || [];
  for (const match of matches) {
    try {
      if (!isPathInsideDir(workspacePath, match)) return true;
    } catch {
      // If we can't resolve it, treat as suspicious
      return true;
    }
  }
  return false;
}

export async function executeShell(args: ShellToolArgs): Promise<ToolResult> {
  const config = getConfig().getConfig();
  const permissions = config.tools.permissions.shell;
  const workspacePath = path.resolve(config.workspace.path);

  // Determine and resolve working directory
  const cwd = path.resolve(args.cwd ? args.cwd : workspacePath);

  // ── FIX HIGH-05: use proper path confinement (not startsWith) ──────────────
  if (permissions.workspace_only) {
    if (!isPathInsideDir(workspacePath, cwd)) {
      log.warn('[shell] Blocked: cwd outside workspace:', cwd);
      return {
        success: false,
        error: `Security: Command execution outside workspace is not allowed. Workspace: ${workspacePath}, Requested: ${cwd}`
      };
    }

    // Also block commands that reference absolute paths outside workspace
    if (containsOutOfScopeAbsPath(args.command, workspacePath)) {
      log.warn('[shell] Blocked: command references path outside workspace:', args.command.slice(0, 120));
      return {
        success: false,
        error: `Security: Command references a path outside the workspace directory.`
      };
    }
  }

  // Check config-defined blocked patterns
  for (const pattern of permissions.blocked_patterns) {
    if (args.command.includes(pattern)) {
      log.warn('[shell] Blocked pattern match:', pattern);
      return {
        success: false,
        error: `Security: Command blocked due to dangerous pattern: "${pattern}"`
      };
    }
  }

  // Hardcoded dangerous command patterns
  const dangerousCommands: Array<[RegExp, string]> = [
    [/rm\s+-rf\s+\//, 'rm -rf /'],
    [/mkfs/, 'filesystem format'],
    [/dd\s+if=/, 'disk write'],
    [/>\s*\/dev\//, 'device write'],
    [/\bsudo\b/, 'privilege escalation'],
    [/\bsu\s/, 'user switch'],
    [/chmod\s+777/, 'world-writable permission'],
    [/\bcurl\b.*\|.*\bbash\b/, 'curl-pipe-bash'],
    [/\bwget\b.*-O.*\s*-\s*\|/, 'wget-pipe'],
  ];

  for (const [pattern, label] of dangerousCommands) {
    if (pattern.test(args.command)) {
      log.warn('[shell] Blocked dangerous command:', label);
      return {
        success: false,
        error: `Security: Potentially destructive command detected (${label}): ${args.command.slice(0, 80)}`
      };
    }
  }

  try {
    const pty = PTYManager.getInstance();
    const output = await pty.runCommand(args.command);
    return {
      success: true,
      stdout: output.trim(),
      stderr: '',
      exitCode: 0
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      stdout: '',
      stderr: '',
      exitCode: 1
    };
  }
}

export const shellTool = {
  name: 'shell',
  description: 'Execute terminal commands in the workspace',
  execute: executeShell,
  schema: {
    command: 'string (required) - The command to execute',
    cwd: 'string (optional) - Working directory, defaults to workspace'
  }
};
