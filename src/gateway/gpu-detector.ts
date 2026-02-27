/**
 * gpu-detector.ts
 *
 * Detects the available GPU/compute backend exactly ONCE at startup.
 * Results are cached in memory so subsequent calls are free.
 *
 * Why this exists:
 *   Ollama runs `nvidia-smi` (and AMD equivalents) every time it loads a
 *   model. When running on a system without an NVIDIA GPU, that produces
 *   a noisy "nvidia-smi is not recognised" error on every generation call.
 *
 *   This module:
 *     1. Probes for GPU hardware once at startup and logs a single clean line.
 *     2. Exposes `isNvidiaAvailable()` so the process manager can decide
 *        whether to filter Ollama's stderr instead of inheriting it raw.
 *     3. Exposes `filterOllamaStderr()` to suppress known-noisy lines while
 *        still surfacing real errors.
 */

import { execSync } from 'child_process';

// ── Types ─────────────────────────────────────────────────────────────────────

export type GpuBackend = 'nvidia' | 'amd' | 'apple-silicon' | 'cpu';

export interface GpuInfo {
  backend: GpuBackend;
  /** Human-readable name from the probe, or null if CPU/unknown */
  name: string | null;
  /** True only when nvidia-smi exited 0 */
  nvidiaAvailable: boolean;
  /** True only when rocminfo or /dev/kfd found (AMD ROCm) */
  amdAvailable: boolean;
  /** True when running on Apple Silicon (arm64 macOS) */
  appleSilicon: boolean;
}

// ── Internal state ────────────────────────────────────────────────────────────

let _cached: GpuInfo | null = null;

// ── Probe helpers ─────────────────────────────────────────────────────────────

function probeNvidia(): { available: boolean; name: string | null } {
  try {
    const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      stdio: ['ignore', 'pipe', 'pipe'],   // capture stderr — never inherit
      timeout: 4000,
      encoding: 'utf-8',
    });
    const name = String(out || '').split('\n').map(l => l.trim()).find(Boolean) || null;
    return { available: true, name };
  } catch {
    return { available: false, name: null };
  }
}

function probeAmd(): { available: boolean; name: string | null } {
  // ROCm: try rocminfo first, then fall back to /dev/kfd presence
  try {
    const out = execSync('rocminfo', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 4000,
      encoding: 'utf-8',
    });
    const match = String(out).match(/Marketing Name:\s+(.+)/);
    return { available: true, name: match ? match[1].trim() : 'AMD GPU (ROCm)' };
  } catch {
    // Linux ROCm fallback
    const fs = require('fs') as typeof import('fs');
    if (process.platform === 'linux' && fs.existsSync('/dev/kfd')) {
      return { available: true, name: 'AMD GPU (/dev/kfd)' };
    }
    return { available: false, name: null };
  }
}

function probeAppleSilicon(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detects GPU hardware. Runs synchronously once; result is cached for the
 * lifetime of the process. Safe to call from multiple places.
 */
export function detectGpu(): GpuInfo {
  if (_cached) return _cached;

  const nvidia = probeNvidia();
  const amd    = probeAmd();
  const apple  = probeAppleSilicon();

  let backend: GpuBackend = 'cpu';
  let name: string | null = null;

  if (nvidia.available) {
    backend = 'nvidia';
    name    = nvidia.name;
  } else if (amd.available) {
    backend = 'amd';
    name    = amd.name;
  } else if (apple) {
    backend = 'apple-silicon';
    name    = 'Apple Silicon (Metal)';
  }

  _cached = {
    backend,
    name,
    nvidiaAvailable: nvidia.available,
    amdAvailable:    amd.available,
    appleSilicon:    apple,
  };

  return _cached;
}

/** Returns true only if nvidia-smi confirmed an NVIDIA GPU is present. */
export function isNvidiaAvailable(): boolean {
  return detectGpu().nvidiaAvailable;
}

/**
 * Log a single clean GPU status line to the console.
 * Called once during gateway startup — never called again.
 */
export function logGpuStatus(): void {
  const info = detectGpu();
  switch (info.backend) {
    case 'nvidia':
      console.log(`[GPU] NVIDIA detected: ${info.name ?? 'unknown'} — CUDA acceleration enabled`);
      break;
    case 'amd':
      console.log(`[GPU] AMD detected: ${info.name ?? 'unknown'} — ROCm acceleration enabled`);
      break;
    case 'apple-silicon':
      console.log('[GPU] Apple Silicon detected — Metal acceleration enabled');
      break;
    default:
      console.log('[GPU] No discrete GPU detected — running on CPU (this is fine for small models)');
  }
}

// ── Stderr filter ─────────────────────────────────────────────────────────────

/**
 * Lines from Ollama's stderr that are expected noise on CPU/AMD systems.
 * Matched case-insensitively as substrings.
 */
const SUPPRESSED_PATTERNS: RegExp[] = [
  // "nvidia-smi" not found / not recognised (Windows EN + ES + other locales)
  /nvidia-smi.*not.*recogni[sz]/i,
  /nvidia-smi.*no se reconoce/i,
  /nvidia-smi.*introuvable/i,
  /nvidia-smi.*nicht erkannt/i,
  /nvidia-smi.*não.*reconhecido/i,
  /'nvidia-smi' is not recognized/i,
  /nvidia-smi.*command not found/i,
  // Generic "command not found" for nvidia-smi (Unix shells)
  /command not found.*nvidia/i,
  /nvidia.*command not found/i,
  // Ollama GPU init messages that are harmless on CPU
  /\[GIN\].*nvidia/i,
  /no nvidia gpu/i,
  /failed to init nvidia/i,
  /cuda.*not available/i,
  /no cuda/i,
  // ROCm noise on non-AMD
  /no amd gpu/i,
  /hip.*not available/i,
  // Ollama "looking for" noise lines
  /looking for compatible gpu/i,
  /no compatible gpus/i,
];

/**
 * Returns true if a stderr line from Ollama should be suppressed.
 * Only active on non-NVIDIA systems; on NVIDIA we pass everything through.
 */
export function shouldSuppressOllamaStderr(line: string): boolean {
  if (isNvidiaAvailable()) return false;  // NVIDIA present — show everything
  return SUPPRESSED_PATTERNS.some(re => re.test(line));
}

/**
 * Filter a raw stderr buffer from an Ollama child process:
 *   - Split on newlines
 *   - Drop suppressed patterns
 *   - Re-join and return; empty string means nothing to print
 */
export function filterOllamaStderr(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter(line => line.trim() && !shouldSuppressOllamaStderr(line))
    .join('\n');
}
