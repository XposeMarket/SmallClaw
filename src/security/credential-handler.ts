// src/security/credential-handler.ts
import crypto from 'crypto';

interface StoredCredential {
  id: string;
  taskId: string;
  type: 'auth' | '2fa' | 'oauth';
  encryptedData: string;
  iv: string;
  createdAt: number;
  expiresAt: number;
}

class CredentialHandler {
  private encryptionKey: Buffer;
  private credentials: Map<string, StoredCredential> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(keyHex: string) {
    this.encryptionKey = Buffer.from(keyHex, 'hex');
    this.startCleanupTimer();
  }

  private startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let expired = 0;
      for (const [id, cred] of this.credentials) {
        if (cred.expiresAt < now) {
          this.credentials.delete(id);
          expired++;
        }
      }
      if (expired > 0) {
        console.log(`[CredentialHandler] Cleaned up ${expired} expired credential(s)`);
      }
    }, 60000); // Check every minute
  }

  store(taskId: string, type: 'auth' | '2fa' | 'oauth', data: Record<string, any>, ttlMs: number = 15 * 60 * 1000): string {
    const id = crypto.randomUUID();
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const jsonData = JSON.stringify(data);
    let encrypted = cipher.update(jsonData, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    const cred: StoredCredential = {
      id,
      taskId,
      type,
      encryptedData: encrypted + ':' + authTag.toString('hex'),
      iv: iv.toString('hex'),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };

    this.credentials.set(id, cred);
    return id;
  }

  retrieve(credentialId: string): Record<string, any> | null {
    const cred = this.credentials.get(credentialId);
    if (!cred) return null;

    if (cred.expiresAt < Date.now()) {
      this.credentials.delete(credentialId);
      return null;
    }

    try {
      const [encrypted, authTag] = cred.encryptedData.split(':');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(cred.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return JSON.parse(decrypted);
    } catch (err) {
      console.error('[CredentialHandler] Decryption failed:', err);
      this.credentials.delete(credentialId);
      return null;
    }
  }

  delete(credentialId: string): boolean {
    return this.credentials.delete(credentialId);
  }

  deleteByTask(taskId: string): number {
    let count = 0;
    for (const [id, cred] of this.credentials) {
      if (cred.taskId === taskId) {
        this.credentials.delete(id);
        count++;
      }
    }
    return count;
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.credentials.clear();
  }
}

let instance: CredentialHandler | null = null;

export function initCredentialHandler(keyHex: string): CredentialHandler {
  if (instance) return instance;
  instance = new CredentialHandler(keyHex);
  return instance;
}

export function getCredentialHandler(): CredentialHandler {
  if (!instance) {
    throw new Error('CredentialHandler not initialized');
  }
  return instance;
}
