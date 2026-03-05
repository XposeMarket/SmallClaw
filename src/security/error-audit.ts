// src/security/error-audit.ts
// GDPR-compliant audit logging for error response system

import fs from 'fs';
import path from 'path';

interface AuditEntry {
  timestamp: string;
  eventType: string;
  taskId?: string;
  category?: string;
  resolution?: string;
  userId?: string;
  details?: Record<string, any>;
}

class ErrorAudit {
  private logPath: string;
  private buffer: AuditEntry[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private bufferLimit = 100;

  constructor(logFilePath: string) {
    this.logPath = logFilePath;
    this.ensureLogDir();
    this.startFlushTimer();
  }

  private ensureLogDir(): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.warn('[ErrorAudit] Could not create log directory:', err);
    }
  }

  private startFlushTimer(): void {
    this.flushInterval = setInterval(() => this.flush(), 10000); // flush every 10s
  }

  log(eventType: string, details?: Partial<AuditEntry>): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      eventType,
      ...details,
    };
    this.buffer.push(entry);
    if (this.buffer.length >= this.bufferLimit) {
      this.flush();
    }
  }

  logErrorDetected(taskId: string, category: string, sanitizedMessage: string): void {
    this.log('error_detected', { taskId, category, details: { message: sanitizedMessage } });
  }

  logCredentialProvided(taskId: string, credType: string): void {
    // GDPR: never log actual credentials, only the fact they were provided
    this.log('credential_provided', { taskId, details: { credentialType: credType } });
  }

  logResolution(taskId: string, resolution: string, success: boolean): void {
    this.log('error_resolved', { taskId, resolution, details: { success } });
  }

  logRetryAttempt(taskId: string, attempt: number, delayMs: number): void {
    this.log('retry_attempt', { taskId, details: { attempt, delayMs } });
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const toWrite = this.buffer.splice(0);
    try {
      const lines = toWrite.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(this.logPath, lines, 'utf8');
    } catch (err) {
      // Non-fatal: audit logging failures should not crash the server
      console.warn('[ErrorAudit] Failed to write audit log:', err);
    }
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush(); // Final flush on shutdown
  }
}

let instance: ErrorAudit | null = null;

export function getErrorAudit(logFilePath: string): ErrorAudit {
  if (!instance) {
    instance = new ErrorAudit(logFilePath);
  }
  return instance;
}
