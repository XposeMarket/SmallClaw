#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { getConfig } from '../config/config';
import { getDatabase } from '../db/database';
import { getOllamaClient } from '../agents/ollama-client';
// AgentOrchestrator removed — legacy pipeline superseded by reactor + multi-agent orchestration

const program = new Command();

program
  .name('smallclaw')
  .description('Local AI agent powered by your choice of LLM provider')
  .version('1.0.1');

type InstallMode = 'git' | 'npm' | 'unknown';
type UpdateSource = 'git' | 'npm' | 'none';

interface UpdateContext {
  rootDir: string;
  packageName: string;
  currentVersion: string;
  mode: InstallMode;
}

interface UpdateCheckResult {
  mode: InstallMode;
  source: UpdateSource;
  available: boolean;
  message: string;
  currentVersion: string;
  latestVersion?: string;
  packageName?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
}

interface UpdateCacheState {
  checkedAt: number;
  mode: InstallMode;
  packageName: string;
  currentVersion: string;
  result: UpdateCheckResult;
}

const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function runCapture(command: string, cwd: string, timeoutMs: number = 10000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const out = execSync(command, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
    return { ok: true, stdout: String(out || ''), stderr: '' };
  } catch (err: any) {
    const stdout = err?.stdout ? String(err.stdout) : '';
    const stderr = err?.stderr ? String(err.stderr) : String(err?.message || '');
    return { ok: false, stdout, stderr };
  }
}

function runStep(label: string, command: string, cwd: string): boolean {
  console.log(`[update] ${label}`);
  try {
    execSync(command, { cwd, stdio: 'inherit' });
    return true;
  } catch (err: any) {
    console.error(`[update] Step failed: ${label}`);
    if (err?.message) console.error(`[update] ${err.message}`);
    return false;
  }
}

function resolveInstallRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

function readPackageMeta(rootDir: string): { name: string; version: string } {
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as any;
    return {
      name: String(pkg?.name || process.env.SMALLCLAW_NPM_PACKAGE || 'smallclaw'),
      version: String(pkg?.version || '0.0.0'),
    };
  } catch {
    return {
      name: String(process.env.SMALLCLAW_NPM_PACKAGE || 'smallclaw'),
      version: '0.0.0',
    };
  }
}

function detectInstallMode(rootDir: string): InstallMode {
  const gitPath = path.join(rootDir, '.git');
  if (fs.existsSync(gitPath)) return 'git';
  const gitProbe = runCapture('git rev-parse --is-inside-work-tree', rootDir, 4000);
  if (gitProbe.ok && gitProbe.stdout.trim() === 'true') return 'git';
  if (fs.existsSync(path.join(rootDir, 'package.json'))) return 'npm';
  return 'unknown';
}

function resolveUpdateContext(): UpdateContext {
  const rootDir = resolveInstallRoot();
  const pkg = readPackageMeta(rootDir);
  const mode = detectInstallMode(rootDir);
  return {
    rootDir,
    packageName: pkg.name,
    currentVersion: pkg.version,
    mode,
  };
}

function parseNpmVersion(raw: string): string | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
    if (Array.isArray(parsed) && parsed.length > 0) {
      const last = parsed[parsed.length - 1];
      if (typeof last === 'string' && last.trim()) return last.trim();
    }
  } catch {
    // ignore
  }
  const cleaned = text.replace(/^"|"$/g, '').trim();
  return cleaned || null;
}

function checkGitUpdate(ctx: UpdateContext, fetchRemote: boolean): UpdateCheckResult {
  const branchRes = runCapture('git rev-parse --abbrev-ref HEAD', ctx.rootDir, 4000);
  if (!branchRes.ok) {
    return {
      mode: 'git',
      source: 'git',
      available: false,
      message: 'Git repository detected, but current branch could not be resolved.',
      currentVersion: ctx.currentVersion,
    };
  }
  const branch = branchRes.stdout.trim() || 'HEAD';
  const upstreamRes = runCapture('git rev-parse --abbrev-ref --symbolic-full-name @{u}', ctx.rootDir, 4000);
  if (!upstreamRes.ok) {
    return {
      mode: 'git',
      source: 'git',
      available: false,
      message: `No upstream tracking branch configured for "${branch}".`,
      currentVersion: ctx.currentVersion,
      branch,
    };
  }

  if (fetchRemote) {
    runCapture('git fetch --quiet', ctx.rootDir, 12000);
  }

  const countsRes = runCapture('git rev-list --left-right --count HEAD...@{u}', ctx.rootDir, 4000);
  if (!countsRes.ok) {
    return {
      mode: 'git',
      source: 'git',
      available: false,
      message: `Unable to compare local branch "${branch}" with upstream.`,
      currentVersion: ctx.currentVersion,
      branch,
    };
  }

  const parts = countsRes.stdout.trim().split(/\s+/).filter(Boolean);
  const ahead = Number(parts[0] || 0);
  const behind = Number(parts[1] || 0);

  let message = `No updates available on branch "${branch}".`;
  if (behind > 0 && ahead > 0) {
    message = `Update available: "${branch}" is behind by ${behind} commit(s) and ahead by ${ahead}.`;
  } else if (behind > 0) {
    message = `Update available: "${branch}" is behind by ${behind} commit(s).`;
  } else if (ahead > 0) {
    message = `Local branch "${branch}" is ahead of upstream by ${ahead} commit(s).`;
  }

  const latestHash = runCapture('git rev-parse --short @{u}', ctx.rootDir, 3000);

  return {
    mode: 'git',
    source: 'git',
    available: behind > 0,
    message,
    currentVersion: ctx.currentVersion,
    latestVersion: latestHash.ok ? latestHash.stdout.trim() : undefined,
    branch,
    ahead,
    behind,
  };
}

function checkNpmUpdate(ctx: UpdateContext): UpdateCheckResult {
  const candidates = Array.from(
    new Set(
      [
        process.env.SMALLCLAW_NPM_PACKAGE,
        ctx.packageName,
        'smallclaw',
      ].filter(Boolean).map(v => String(v)),
    ),
  );

  for (const packageName of candidates) {
    const latestRes = runCapture(`npm view ${packageName} version --json`, ctx.rootDir, 12000);
    if (!latestRes.ok) continue;

    const latestVersion = parseNpmVersion(latestRes.stdout);
    if (!latestVersion) continue;

    const available = latestVersion !== ctx.currentVersion;
    return {
      mode: 'npm',
      source: 'npm',
      available,
      message: available
        ? `Update available: ${ctx.currentVersion} -> ${latestVersion} (${packageName}).`
        : `No npm updates available (${packageName}@${ctx.currentVersion}).`,
      currentVersion: ctx.currentVersion,
      latestVersion,
      packageName,
    };
  }

  return {
    mode: 'npm',
    source: 'npm',
    available: false,
    message: 'Could not resolve latest version from npm registry.',
    currentVersion: ctx.currentVersion,
  };
}

function checkForUpdates(ctx: UpdateContext, fetchRemote: boolean = true): UpdateCheckResult {
  if (ctx.mode === 'git') return checkGitUpdate(ctx, fetchRemote);
  if (ctx.mode === 'npm') return checkNpmUpdate(ctx);
  return {
    mode: 'unknown',
    source: 'none',
    available: false,
    message: 'Install type is unknown. Run manual update steps from your repository.',
    currentVersion: ctx.currentVersion,
  };
}

function getUpdateCachePath(): string {
  return path.join(getConfig().getConfigDir(), 'update_state.json');
}

function readUpdateCache(): UpdateCacheState | null {
  try {
    const cachePath = getUpdateCachePath();
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as UpdateCacheState;
    if (!parsed || typeof parsed.checkedAt !== 'number' || !parsed.result) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeUpdateCache(ctx: UpdateContext, result: UpdateCheckResult): void {
  try {
    const cachePath = getUpdateCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const payload: UpdateCacheState = {
      checkedAt: Date.now(),
      mode: ctx.mode,
      packageName: ctx.packageName,
      currentVersion: ctx.currentVersion,
      result,
    };
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // best effort only
  }
}

function printUpdateCheck(result: UpdateCheckResult): void {
  console.log(`[update] ${result.message}`);
  if (result.latestVersion) {
    console.log(`[update] Current: ${result.currentVersion} | Latest: ${result.latestVersion}`);
  } else {
    console.log(`[update] Current: ${result.currentVersion}`);
  }
}

async function confirmUpdate(assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('Proceed with update now? [y/N] ');
    return /^y(?:es)?$/i.test(String(answer || '').trim());
  } finally {
    rl.close();
  }
}

function hasDirtyGitChanges(rootDir: string): boolean {
  const status = runCapture('git status --porcelain', rootDir, 4000);
  if (!status.ok) return false;
  return status.stdout.trim().length > 0;
}

function applyGitUpdate(ctx: UpdateContext, force: boolean): boolean {
  if (!force && hasDirtyGitChanges(ctx.rootDir)) {
    console.error('[update] Local git changes detected. Commit/stash first or use --force.');
    return false;
  }

  const steps: Array<[string, string]> = [
    ['Pull latest changes', 'git pull --ff-only'],
    ['Install dependencies', 'npm install'],
    ['Build project', 'npm run build'],
    ['Refresh global link', 'npm link'],
  ];

  for (const [label, cmd] of steps) {
    if (!runStep(label, cmd, ctx.rootDir)) return false;
  }
  return true;
}

function applyNpmUpdate(ctx: UpdateContext, check: UpdateCheckResult): boolean {
  const packageName = check.packageName || ctx.packageName;
  return runStep(
    `Install latest npm package (${packageName}@latest)`,
    `npm install -g ${packageName}@latest`,
    ctx.rootDir,
  );
}

function maybeNotifyUpdate(): void {
  if (process.env.SMALLCLAW_DISABLE_UPDATE_CHECK === '1') return;
  const ctx = resolveUpdateContext();
  const cache = readUpdateCache();
  const isFresh = cache
    && (Date.now() - cache.checkedAt) < UPDATE_CACHE_TTL_MS
    && cache.mode === ctx.mode
    && cache.packageName === ctx.packageName
    && cache.currentVersion === ctx.currentVersion;

  const result = isFresh ? cache.result : checkForUpdates(ctx, true);
  if (!isFresh) {
    writeUpdateCache(ctx, result);
  }

  if (result.available) {
    console.log(`[Update] ${result.message}`);
    console.log('[Update] Run `smallclaw update` to install.');
  }
}

// ---- ONBOARD ----
program
  .command('onboard')
  .description('Setup SmallClaw for first-time use')
  .action(async () => {
    console.log('Welcome to SmallClaw!\n');
    const config = getConfig();
    config.ensureDirectories();
    config.saveConfig();
    console.log('Created configuration directories');
    console.log(`  Config:    ${config.getConfigDir()}`);
    console.log(`  Workspace: ${config.getWorkspacePath()}`);
    getDatabase();
    console.log('Initialized job database\n');
    console.log('SmallClaw is ready!');
    console.log('\nNext steps:');
    console.log('  1. Start the gateway:  smallclaw gateway start');
    console.log('  2. Open browser:       http://localhost:18789');
    console.log('  3. Go to Settings -> Models to configure your LLM provider');
  });

// ---- GATEWAY ----
const gateway = program.command('gateway').description('Control the gateway server');

gateway
  .command('start')
  .description('Start the gateway + web UI server')
  .action(async () => {
    console.log('SmallClaw Gateway starting...\n');
    maybeNotifyUpdate();
    try {
      const res = await fetch('http://127.0.0.1:18789/api/status', {
        signal: AbortSignal.timeout(1200),
      });
      if (res.ok) {
        const data = await res.json() as any;
        console.log('Gateway is already running at http://127.0.0.1:18789');
        if (data?.currentModel) {
          console.log(`Model: ${data.currentModel}`);
        }
        return;
      }
    } catch {}
    require('../gateway/server-v2');
  });

gateway
  .command('status')
  .description('Check gateway status')
  .action(async () => {
    try {
      const res = await fetch('http://localhost:18789/api/status');
      const data = await res.json() as any;
      console.log('Gateway: Online');
      console.log(`Model:   ${data.currentModel || 'unknown'}`);
    } catch {
      console.log('Gateway: Offline (run: smallclaw gateway start)');
    }
  });

// ---- AGENT ----
program
  .command('agent <mission>')
  .description('Run a mission via the gateway (starts gateway if needed)')
  .option('-p, --priority <number>', 'Job priority', '0')
  .action(async (mission: string) => {
    console.log('SmallClaw Agent');
    console.log(`Mission: ${mission}\n`);
    console.log('The CLI agent command now routes through the gateway.');
    console.log('Start the gateway and send your mission via the web UI or Telegram.');
    console.log('\n  smallclaw gateway start');
    console.log('  http://localhost:18789');
  });

// ---- JOBS ----
const jobs = program.command('jobs').description('Manage jobs');

jobs
  .command('list')
  .description('List all jobs')
  .action(() => {
    const db = getDatabase();
    const list = db.listJobs();
    if (list.length === 0) { console.log('No jobs found'); return; }
    list.forEach(j => {
      console.log(`[${j.status.padEnd(12)}] ${j.id.slice(0, 8)}  ${j.title}`);
    });
  });

jobs
  .command('show <id>')
  .description('Show job details')
  .action((id: string) => {
    const db = getDatabase();
    const job = db.getJob(id);
    if (!job) { console.log('Job not found'); return; }
    console.log(`ID:     ${job.id}`);
    console.log(`Title:  ${job.title}`);
    console.log(`Status: ${job.status}`);
    const tasks = db.listTasksForJob(id);
    console.log(`\nTasks (${tasks.length}):`);
    tasks.forEach((t: any) => console.log(`  [${t.status}] ${t.title}`));
  });

// ---- MODEL ----
const model = program.command('model').description('Manage models');

model.command('list').action(async () => {
  const models = await getOllamaClient().listModels();
  if (models.length === 0) {
    console.log('No models found (check your provider is running)');
    return;
  }
  console.log('Available models:');
  models.forEach(m => console.log(`  - ${m}`));
});

model.command('set <n>').action((name: string) => {
  const cfg = getConfig();
  const c = cfg.getConfig();
  cfg.updateConfig({ ...c, models: { ...c.models, primary: name, roles: { manager: name, executor: name, verifier: name } } });
  console.log(`Model set to: ${name}`);
});

// ---- DOCTOR ----
program.command('doctor').action(async () => {
  console.log('SmallClaw Health Check\n');
  const cfg = getConfig().getConfig() as any;
  const provider = cfg.llm?.provider || 'ollama';
  console.log(`Provider:  ${provider}`);
  const ollama = getOllamaClient();
  const connected = await ollama.testConnection();
  console.log(`Backend:   ${connected ? 'Online' : 'Offline'}`);
  if (connected) {
    const models = await ollama.listModels();
    console.log(`Models:    ${models.length} available`);
  }
  const db = getDatabase();
  const jobCount = db.listJobs().length;
  console.log(`Database:  ${jobCount} jobs stored`);
  console.log(`Workspace: ${getConfig().getWorkspacePath()}`);
  try {
    await fetch('http://localhost:18789/api/status');
    console.log(`Gateway:   Online -> http://localhost:18789`);
  } catch {
    console.log(`Gateway:   Offline (run: smallclaw gateway start)`);
  }
});

// ---- UPDATE ----
program
  .command('update [mode]')
  .description('Check for updates and install them (mode: check|apply)')
  .option('-y, --yes', 'Skip confirmation prompt when applying updates', false)
  .option('--force', 'Allow git update even with local changes', false)
  .action(async (mode: string | undefined, options: { yes?: boolean; force?: boolean }) => {
    const actionMode = String(mode || 'apply').toLowerCase();
    if (actionMode !== 'check' && actionMode !== 'apply') {
      console.error(`[update] Unknown mode "${actionMode}". Use "check" or "apply".`);
      process.exitCode = 1;
      return;
    }

    const ctx = resolveUpdateContext();
    const check = checkForUpdates(ctx, true);
    writeUpdateCache(ctx, check);
    printUpdateCheck(check);

    if (actionMode === 'check') {
      return;
    }

    if (!check.available) {
      console.log('[update] SmallClaw is already up to date.');
      return;
    }

    const confirmed = await confirmUpdate(Boolean(options.yes));
    if (!confirmed) {
      console.log('[update] Update canceled.');
      return;
    }

    let ok = false;
    if (ctx.mode === 'git') {
      ok = applyGitUpdate(ctx, Boolean(options.force));
    } else if (ctx.mode === 'npm') {
      ok = applyNpmUpdate(ctx, check);
    } else {
      console.error('[update] Unknown install mode. Run manual repo update commands.');
      process.exitCode = 1;
      return;
    }

    if (!ok) {
      process.exitCode = 1;
      return;
    }

    console.log('[update] Update complete.');
    console.log('[update] Restart any running SmallClaw gateway process.');
  });

program.parse();
