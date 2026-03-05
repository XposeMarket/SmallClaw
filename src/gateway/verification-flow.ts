// src/gateway/verification-flow.ts
import crypto from 'crypto';

interface VerificationSession {
  id: string;
  taskId: string;
  currentStep: 'oauth_selection' | 'oauth_redirect' | 'email_verification' | 'completing';
  pendingAction: 'awaiting_user_input' | 'awaiting_browser_completion';
  completedSteps: string[];
  nextPrompt: string;
  createdAt: number;
  expiresAt: number;
}

class VerificationFlowManager {
  private sessions: Map<string, VerificationSession> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  private startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let expired = 0;
      for (const [id, session] of this.sessions) {
        if (session.expiresAt < now) {
          this.sessions.delete(id);
          expired++;
        }
      }
      if (expired > 0) {
        console.log(`[VerificationFlowManager] Cleaned up ${expired} expired session(s)`);
      }
    }, 60000);
  }

  createSession(taskId: string, initialStep: 'oauth_selection' | 'oauth_redirect' | 'email_verification' = 'oauth_selection'): VerificationSession {
    const session: VerificationSession = {
      id: crypto.randomUUID(),
      taskId,
      currentStep: initialStep,
      pendingAction: 'awaiting_user_input',
      completedSteps: [],
      nextPrompt: '',
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minute timeout
    };

    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): VerificationSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (session.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  updateSession(sessionId: string, updates: Partial<VerificationSession>): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    Object.assign(session, updates);
    return true;
  }

  completeStep(sessionId: string, stepName: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    if (!session.completedSteps.includes(stepName)) {
      session.completedSteps.push(stepName);
    }

    return true;
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  deleteByTask(taskId: string): number {
    let count = 0;
    for (const [id, session] of this.sessions) {
      if (session.taskId === taskId) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
  }
}

let instance: VerificationFlowManager | null = null;

export function getVerificationFlowManager(): VerificationFlowManager {
  if (!instance) {
    instance = new VerificationFlowManager();
  }
  return instance;
}
