import { getConfig } from '../config/config.js';

export function getMemoryTruncateLength(): number {
  try {
    const cfg = getConfig().getConfig();
    const raw = Number(cfg.memory_options?.truncate_length ?? 1000);
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  } catch {
    // fall through
  }
  return 1000;
}

export function sanitizeMemoryText(
  input: any,
  options?: { trim?: boolean; truncateLength?: number }
): string {
  if (input == null) return '';
  let text = '';
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }

  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  const truncateLen = Number.isFinite(Number(options?.truncateLength))
    ? Math.max(32, Math.floor(Number(options?.truncateLength)))
    : getMemoryTruncateLength();
  if (text.length > truncateLen) text = text.slice(0, truncateLen) + '\n...[truncated]';

  return options?.trim === false ? text : text.trim();
}

