/**
 * ollama-process-manager.ts
 *
 * Handles hard kill + restart of the local Ollama process.
 * Only used by the preempt watchdog when a generation stalls.
 * Ollama-specific — not wired for LM Studio or llama.cpp.
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { filterOllamaStderr, isNvidiaAvailable } from './gpu-detector';

const execAsync = promisify(exec);

export type OllamaRestartMode = 'inherit_console' | 'detached_hidden';

export interface OllamaProcessManagerOptions {
  endpoint: string;        // e.g. "http://localhost:11434"
  readyTimeoutMs?: number; // how long to wait for Ollama to come back (default 15000)
  killTimeoutMs?: number;  // how long to wait for port to clear after kill (default 5000)
  restartMode?: OllamaRestartMode;
}

export class OllamaProcessManager {
  private endpoint: string;
  private readyTimeoutMs: number;
  private killTimeoutMs: number;
  private restartMode: OllamaRestartMode;
  private isWindows = process.platform === 'win32';

  constructor(opts: OllamaProcessManagerOptions) {
    const modeFromEnv = String(process.env.SMALLCLAW_OLLAMA_RESTART_MODE || '').trim().toLowerCase();
    const requestedMode = String(opts.restartMode || modeFromEnv || '').trim().toLowerCase();
    this.endpoint = String(opts.endpoint || 'http://localhost:11434').replace(/\/$/, '');
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15000;
    this.killTimeoutMs = opts.killTimeoutMs ?? 5000;
    this.restartMode = requestedMode === 'detached_hidden'
      ? 'detached_hidden'
      : 'inherit_console';
  }

  // ── Kill ────────────────────────────────────────────────────────────────────

  async kill(): Promise<void> {
    console.log('[OllamaProcessManager] Killing Ollama process...');
    try {
      if (this.isWindows) {
        await execAsync('taskkill /F /IM ollama.exe /T').catch(() => {});
        // Also kill runner processes (llama-server, ollama_llama_server)
        await execAsync('taskkill /F /IM llama-server.exe /T').catch(() => {});
        await execAsync('taskkill /F /IM ollama_llama_server.exe /T').catch(() => {});
      } else {
        await execAsync('pkill -9 -f "ollama serve"').catch(() => {});
        await execAsync('pkill -9 -f "ollama_llama_server"').catch(() => {});
        await execAsync('killall -9 ollama').catch(() => {});
      }
    } catch {
      // Ignore — process may already be dead
    }

    // Wait for port to go dark
    await this.waitForPortDark(this.killTimeoutMs);
    if (await this.isAlive()) {
      console.warn('[OllamaProcessManager] Ollama endpoint stayed alive after kill (likely auto-respawn by Ollama app).');
    }
    console.log('[OllamaProcessManager] Ollama process stopped.');
  }

  // ── Restart ──────────────────────────────────────────────────────────────────

  async restart(): Promise<void> {
    console.log('[OllamaProcessManager] Starting Ollama...');
    // Guard: on some systems the desktop app auto-respawns `ollama serve`
    // immediately after kill. In that case, skip explicit spawn to avoid
    // duplicate bind attempts on 127.0.0.1:11434.
    if (await this.isAlive()) {
      console.log('[OllamaProcessManager] Restart skipped: endpoint already alive.');
      return;
    }
    try {
      if (this.isWindows) {
        const resolved = await this.resolveWindowsOllamaCommand();
        if (this.restartMode === 'inherit_console') {
          // Launch in the same console as the gateway (no extra terminal window).
          if (resolved.shell) {
            const child = spawn(`${resolved.command} serve`, {
              detached: false,
              stdio: ['ignore', 'inherit', 'pipe'],  // pipe stderr so we can filter it
              shell: true,
              windowsHide: false,
            });
            this.attachStderrFilter(child);
          } else {
            const child = spawn(resolved.command, ['serve'], {
              detached: false,
              stdio: ['ignore', 'inherit', 'pipe'],
              shell: false,
              windowsHide: false,
            });
            this.attachStderrFilter(child);
          }
          return;
        }
        // Background restart with no visible window.
        if (resolved.shell) {
          const child = spawn(`${resolved.command} serve`, {
            detached: true,
            stdio: 'ignore',
            shell: true,
            windowsHide: true,
          });
          child.unref();
        } else {
          const child = spawn(resolved.command, ['serve'], {
            detached: true,
            stdio: 'ignore',
            shell: false,
            windowsHide: true,
          });
          child.unref();
        }
      } else {
        // On non-NVIDIA Linux, pipe stderr to suppress gpu-probe noise.
        // On NVIDIA, inherit to keep full output visible.
        const stderrMode = isNvidiaAvailable() ? 'ignore' : 'pipe';
        const child = spawn('ollama', ['serve'], {
          detached: true,
          stdio: ['ignore', 'ignore', stderrMode],
        });
        if (stderrMode === 'pipe') this.attachStderrFilter(child);
        child.unref();
      }
    } catch (err: any) {
      console.error('[OllamaProcessManager] Failed to spawn Ollama:', err.message);
      throw new Error(`Failed to restart Ollama: ${err.message}`);
    }
  }

  // ── Wait Ready ──────────────────────────────────────────────────────────────

  async waitReady(): Promise<boolean> {
    console.log('[OllamaProcessManager] Waiting for Ollama to be ready...');
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(600);
      if (await this.isAlive()) {
        console.log('[OllamaProcessManager] Ollama is ready.');
        return true;
      }
    }
    console.warn('[OllamaProcessManager] Ollama did not become ready in time.');
    return false;
  }

  // ── Full Cycle: kill → restart → waitReady ──────────────────────────────────

  async killAndRestart(): Promise<boolean> {
    await this.kill();
    if (await this.isAlive()) {
      console.log('[OllamaProcessManager] Endpoint recovered after kill; skipping explicit restart.');
      return true;
    }
    await this.restart();
    return this.waitReady();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Attach a stderr listener to an Ollama child process.
   * Lines that match known GPU-probe noise are silently dropped;
   * anything else is forwarded to process.stderr so real errors still surface.
   */
  private attachStderrFilter(child: ReturnType<typeof spawn>): void {
    if (!child.stderr) return;
    let buf = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      buf += chunk;
      // Flush complete lines
      const lines = buf.split(/\n/);
      buf = lines.pop() ?? '';  // keep the incomplete trailing fragment
      for (const line of lines) {
        const filtered = filterOllamaStderr(line + '\n');
        if (filtered) process.stderr.write(filtered);
      }
    });
    child.stderr.on('end', () => {
      if (buf.trim()) {
        const filtered = filterOllamaStderr(buf);
        if (filtered) process.stderr.write(filtered + '\n');
      }
      buf = '';
    });
  }

  private async resolveWindowsOllamaCommand(): Promise<{ command: string; shell: boolean }> {
    try {
      const out = await execAsync('where.exe ollama');
      const first = String(out.stdout || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .find(Boolean);
      if (first) {
        return { command: first, shell: false };
      }
    } catch {
      // fall through to shell-based resolution
    }
    return { command: 'ollama', shell: true };
  }

  private async isAlive(): Promise<boolean> {
    try {
      const url = `${this.endpoint}/api/tags`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async waitForPortDark(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(400);
      const alive = await this.isAlive();
      if (!alive) return;
    }
    // If it never went dark, continue anyway
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
