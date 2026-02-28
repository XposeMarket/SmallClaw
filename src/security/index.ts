/**
 * security/index.ts — SmallClaw Security Module
 *
 * Barrel export for all security primitives.
 * Import from here rather than individual files.
 *
 * Example:
 *   import { getVault, scrubSecrets, log } from '../security';
 */

export { SecretVault, SecretValue, scrubSecrets, getVault } from './vault';
export { log, initLogDir, sanitizeToolLog } from './log-scrubber';
