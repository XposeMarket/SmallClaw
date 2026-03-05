// src/gateway/context-injection.ts
// Smart context injection — enriches prompts with relevant error context

interface InjectionRule {
  id: string;
  trigger: string[];        // keywords that activate this rule
  contextSnippet: string;   // text injected into prompt
  priority: number;
}

interface InjectionResult {
  originalPrompt: string;
  enrichedPrompt: string;
  appliedRules: string[];
}

const DEFAULT_RULES: InjectionRule[] = [
  {
    id: 'auth_context',
    trigger: ['login', 'sign in', 'password', 'authentication'],
    contextSnippet: '[Context: Authentication required. If credentials are needed, request them from the user via the error response system rather than proceeding blindly.]',
    priority: 10,
  },
  {
    id: '2fa_context',
    trigger: ['verification code', '2fa', 'mfa', 'two factor', 'otp'],
    contextSnippet: '[Context: Two-factor authentication required. Pause and prompt the user for the verification code.]',
    priority: 10,
  },
  {
    id: 'captcha_context',
    trigger: ['captcha', 'recaptcha', 'human verification'],
    contextSnippet: '[Context: CAPTCHA detected. Cannot auto-solve. Request user to complete manually.]',
    priority: 9,
  },
  {
    id: 'paywall_context',
    trigger: ['paywall', 'subscription', 'upgrade', 'premium'],
    contextSnippet: '[Context: Paywall or subscription gate encountered. Present options to skip or cancel.]',
    priority: 8,
  },
  {
    id: 'retry_context',
    trigger: ['timeout', 'service unavailable', '503', '502', 'connection failed'],
    contextSnippet: '[Context: Transient network/server error. Retry with exponential backoff before escalating.]',
    priority: 7,
  },
];

class ContextInjectionManager {
  private rules: InjectionRule[] = [...DEFAULT_RULES];

  addRule(rule: InjectionRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  removeRule(id: string): boolean {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  inject(prompt: string, errorContext?: string): InjectionResult {
    const searchText = (prompt + ' ' + (errorContext || '')).toLowerCase();
    const appliedRules: string[] = [];
    const injections: string[] = [];

    for (const rule of this.rules) {
      const matches = rule.trigger.some(t => searchText.includes(t));
      if (matches) {
        injections.push(rule.contextSnippet);
        appliedRules.push(rule.id);
      }
    }

    const enrichedPrompt = injections.length > 0
      ? `${injections.join('\n')}\n\n${prompt}`
      : prompt;

    return { originalPrompt: prompt, enrichedPrompt, appliedRules };
  }

  listRules(): InjectionRule[] {
    return [...this.rules];
  }
}

let instance: ContextInjectionManager | null = null;

export function getContextInjectionManager(): ContextInjectionManager {
  if (!instance) instance = new ContextInjectionManager();
  return instance;
}
