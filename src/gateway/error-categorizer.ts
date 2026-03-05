/**
 * error-categorizer.ts — Analyze errors and categorize them
 *
 * Uses pattern matching on error messages to determine:
 * - What type of error occurred
 * - How confident we are (0.0-1.0)
 * - Which template to show user
 */

import {
  ErrorResponseTemplate,
  AUTH_LOGIN_REQUIRED,
  AUTH_2FA_REQUIRED,
  PERMISSION_DENIED,
  NETWORK_ERROR,
  PAYWALL_REQUIRED,
  CAPTCHA_CHALLENGE,
} from './error-templates';

export interface ErrorCategorization {
  category: 'auth' | '2fa' | 'captcha' | 'paywall' | 'permission' | 'network' | 'unknown';
  confidence: number;           // 0.0-1.0
  template: ErrorResponseTemplate | null;
  reasoning: string;            // Why we think this is the category
}

export class ErrorCategorizer {
  /**
   * Categorize an error based on message + context
   */
  categorizeError(errorMessage: string, context?: any): ErrorCategorization {
    const normalized = String(errorMessage || '').toLowerCase();

    // Try each category in order of specificity
    const twoFAMatch = this.checkTwoFA(normalized);
    if (twoFAMatch.confidence > 0.7) return twoFAMatch;

    const authMatch = this.checkAuth(normalized);
    if (authMatch.confidence > 0.75) return authMatch;

    const captchaMatch = this.checkCaptcha(normalized);
    if (captchaMatch.confidence > 0.8) return captchaMatch;

    const paywallMatch = this.checkPaywall(normalized);
    if (paywallMatch.confidence > 0.7) return paywallMatch;

    const permissionMatch = this.checkPermission(normalized);
    if (permissionMatch.confidence > 0.8) return permissionMatch;

    const networkMatch = this.checkNetwork(normalized);
    if (networkMatch.confidence > 0.7) return networkMatch;

    // Unknown error
    return {
      category: 'unknown',
      confidence: 0,
      template: null,
      reasoning: 'Error pattern not recognized',
    };
  }

  /**
   * Check for authentication/login errors
   */
  private checkAuth(error: string): ErrorCategorization {
    const patterns = {
      high: [
        'email required',
        'password required',
        'login required',
        'sign in required',
        'please log in',
        'please sign in',
      ],
      medium: [
        'password',
        'login',
        'email',
        'sign in',
        'signin',
        'invalid email',
        'invalid password',
        'incorrect password',
        'unauthorized',
        'authentication failed',
        'invalid credentials',
        'access denied',
      ],
    };

    // Check high-confidence patterns first
    const highMatch = patterns.high.filter(p => error.includes(p)).length;
    if (highMatch > 0) {
      return {
        category: 'auth',
        confidence: 0.95,
        template: AUTH_LOGIN_REQUIRED,
        reasoning: `Found high-confidence auth pattern: "${patterns.high.find(p => error.includes(p))}"`,
      };
    }

    // Check medium-confidence patterns
    const mediumMatch = patterns.medium.filter(p => error.includes(p)).length;
    if (mediumMatch >= 2) {
      return {
        category: 'auth',
        confidence: 0.85,
        template: AUTH_LOGIN_REQUIRED,
        reasoning: `Found ${mediumMatch} auth-related keywords`,
      };
    }

    return { category: 'unknown', confidence: 0, template: null, reasoning: 'No auth patterns found' };
  }

  /**
   * Check for Two-Factor Authentication
   */
  private checkTwoFA(error: string): ErrorCategorization {
    const patterns = [
      'verification code',
      '6-digit code',
      'verification code required',
      'enter code',
      'code sent to',
      'check your email',
      'check your phone',
      'check your app',
      '2fa',
      'mfa',
      'two-factor',
      'two factor',
      'authenticator code',
      '6 digit',
    ];

    const matches = patterns.filter(p => error.includes(p)).length;
    if (matches >= 1) {
      return {
        category: '2fa',
        confidence: Math.min(0.95, 0.70 + matches * 0.10),
        template: AUTH_2FA_REQUIRED,
        reasoning: `Found ${matches} 2FA-related keyword(s)`,
      };
    }

    return { category: 'unknown', confidence: 0, template: null, reasoning: 'No 2FA patterns found' };
  }

  /**
   * Check for CAPTCHA challenges
   */
  private checkCaptcha(error: string): ErrorCategorization {
    const patterns = [
      'captcha',
      'recaptcha',
      'robot',
      'human verification',
      'please verify',
      'verify you',
      "you're not a robot",
      'challenge',
    ];

    const matches = patterns.filter(p => error.includes(p)).length;
    if (matches >= 1) {
      return {
        category: 'captcha',
        confidence: 0.90,
        template: CAPTCHA_CHALLENGE,
        reasoning: `Found CAPTCHA pattern: "${patterns.find(p => error.includes(p))}"`,
      };
    }

    return { category: 'unknown', confidence: 0, template: null, reasoning: 'No CAPTCHA patterns found' };
  }

  /**
   * Check for paywalls/subscriptions
   */
  private checkPaywall(error: string): ErrorCategorization {
    const patterns = [
      'upgrade',
      'subscription required',
      'upgrade required',
      'upgrade now',
      'subscribe',
      'paywall',
      'premium',
      'credit card',
      'payment required',
      'purchase required',
      'membership required',
    ];

    const matches = patterns.filter(p => error.includes(p)).length;
    if (matches >= 1) {
      return {
        category: 'paywall',
        confidence: 0.85,
        template: PAYWALL_REQUIRED,
        reasoning: `Found paywall pattern: "${patterns.find(p => error.includes(p))}"`,
      };
    }

    return { category: 'unknown', confidence: 0, template: null, reasoning: 'No paywall patterns found' };
  }

  /**
   * Check for permission/access errors
   */
  private checkPermission(error: string): ErrorCategorization {
    const patterns = {
      high: ['permission denied', 'access denied', 'forbidden', '403'],
      medium: ['not authorized', 'authorization required', 'permission required', 'access required'],
    };

    const highMatches = patterns.high.filter(p => error.includes(p)).length;
    if (highMatches > 0) {
      return {
        category: 'permission',
        confidence: 0.95,
        template: PERMISSION_DENIED,
        reasoning: `Found permission error pattern: "${patterns.high.find(p => error.includes(p))}"`,
      };
    }

    const mediumMatches = patterns.medium.filter(p => error.includes(p)).length;
    if (mediumMatches >= 1) {
      return {
        category: 'permission',
        confidence: 0.80,
        template: PERMISSION_DENIED,
        reasoning: `Found permission-related pattern: "${patterns.medium.find(p => error.includes(p))}"`,
      };
    }

    return { category: 'unknown', confidence: 0, template: null, reasoning: 'No permission patterns found' };
  }

  /**
   * Check for temporary network/server errors
   */
  private checkNetwork(error: string): ErrorCategorization {
    const patterns = [
      'timeout',
      'connection failed',
      'connection error',
      'server error',
      'service unavailable',
      '503',
      '502',
      '501',
      'temporarily unavailable',
      'try again later',
      'network error',
      'err_connection',
    ];

    const matches = patterns.filter(p => error.includes(p)).length;
    if (matches >= 1) {
      return {
        category: 'network',
        confidence: 0.90,
        template: NETWORK_ERROR,
        reasoning: `Found network error pattern: "${patterns.find(p => error.includes(p))}"`,
      };
    }

    return { category: 'unknown', confidence: 0, template: null, reasoning: 'No network error patterns found' };
  }
}

/**
 * Global singleton instance
 */
export const errorCategorizer = new ErrorCategorizer();
