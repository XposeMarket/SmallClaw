/**
 * error-templates.ts — Error Response Template Definitions
 *
 * Defines all error types that the system can auto-detect and ask users about.
 * Each template specifies:
 * - How to display the error (title, description)
 * - What options the user can choose
 * - What input fields are needed (if any)
 * - How long to wait for user response
 *
 * The same template renders differently on Web (buttons+fields) vs Telegram (sequential messages)
 */

export interface InputField {
  id: string;                      // 'email', 'password', 'code'
  label: string;                   // Display label
  type: 'text' | 'password' | 'number' | 'textarea';
  placeholder?: string;
  validation?: 'email' | 'digits_only' | 'none';
  required?: boolean;
}

export interface ErrorOption {
  id: string;                      // 'credentials', 'google', 'cancel'
  label: string;                   // Display text
  icon?: string;                   // Emoji (📝, 🔵, etc.)
  triggerInputs?: string[];        // Which input fields to show (e.g., ['email', 'password'])
  description?: string;
  danger?: boolean;                // Red styling for destructive actions
}

export interface ErrorResponseTemplate {
  errorId: string;
  category: 'auth' | '2fa' | 'captcha' | 'paywall' | 'permission' | 'network' | 'unknown';
  title: string;
  description: string;
  options: ErrorOption[];
  requiredInputs?: InputField[];
  defaultAction?: string;
  timeout?: number;                // ms to wait for response
}

/**
 * AUTHENTICATION — Login pages, email/password forms
 */
export const AUTH_LOGIN_REQUIRED: ErrorResponseTemplate = {
  errorId: 'auth_login_required',
  category: 'auth',
  title: '🔐 LOGIN REQUIRED',
  description: 'The page requires authentication. I found a login form with email/password fields.',
  
  options: [
    {
      id: 'credentials',
      label: 'Provide Credentials',
      icon: '📝',
      triggerInputs: ['email', 'password'],
      description: 'Enter your email and password',
    },
    {
      id: 'google',
      label: 'Use Google Sign-In',
      icon: '🔵',
      description: 'I\'ll use Google authentication',
    },
    {
      id: 'facebook',
      label: 'Use Facebook',
      icon: '👍',
      description: 'I\'ll use Facebook authentication',
    },
    {
      id: 'cancel',
      label: 'Cancel Task',
      icon: '✕',
      danger: true,
      description: 'Stop this task',
    },
  ],
  
  requiredInputs: [
    {
      id: 'email',
      label: 'Email Address',
      type: 'text',
      placeholder: 'user@example.com',
      validation: 'email',
      required: true,
    },
    {
      id: 'password',
      label: 'Password',
      type: 'password',
      placeholder: '••••••••',
      required: true,
    },
  ],
  
  timeout: 5 * 60 * 1000, // 5 minutes
};

/**
 * TWO-FACTOR AUTHENTICATION — Verification codes from email/SMS/app
 */
export const AUTH_2FA_REQUIRED: ErrorResponseTemplate = {
  errorId: 'auth_2fa_required',
  category: '2fa',
  title: '🔐 VERIFICATION CODE NEEDED',
  description: 'Your account requires a verification code. Check your email or phone.',
  
  options: [
    {
      id: 'submit_code',
      label: 'I Have the Code',
      icon: '✓',
      triggerInputs: ['code'],
      description: 'Enter the code I received',
    },
    {
      id: 'resend',
      label: 'Resend Code',
      icon: '↻',
      description: 'Request another code',
    },
    {
      id: 'cancel',
      label: 'Cancel',
      icon: '✕',
      danger: true,
    },
  ],
  
  requiredInputs: [
    {
      id: 'code',
      label: 'Verification Code',
      type: 'text',
      placeholder: '000000',
      validation: 'digits_only',
      required: true,
    },
  ],
  
  timeout: 10 * 60 * 1000, // 10 minutes (codes expire)
};

/**
 * CAPTCHA — Bot detection challenges
 */
export const CAPTCHA_CHALLENGE: ErrorResponseTemplate = {
  errorId: 'captcha_challenge',
  category: 'captcha',
  title: '⚠️ CAPTCHA CHALLENGE',
  description: 'The page requires CAPTCHA verification. I can see the challenge but cannot solve it.',
  
  options: [
    {
      id: 'manual_complete',
      label: 'I\'ll Complete It Manually',
      icon: '👆',
      description: 'I\'ll pause for you to complete CAPTCHA',
    },
    {
      id: 'cancel',
      label: 'Cancel Task',
      icon: '✕',
      danger: true,
    },
  ],
  
  timeout: 10 * 60 * 1000, // 10 minutes
};

/**
 * PAYWALL — Subscription or payment required
 */
export const PAYWALL_REQUIRED: ErrorResponseTemplate = {
  errorId: 'paywall_required',
  category: 'paywall',
  title: '💳 SUBSCRIPTION REQUIRED',
  description: 'This content requires a paid subscription or account upgrade.',
  
  options: [
    {
      id: 'skip_content',
      label: 'Skip This Content',
      icon: '⊚',
      description: 'Continue with next item',
    },
    {
      id: 'cancel',
      label: 'Cancel Task',
      icon: '✕',
      danger: true,
    },
  ],
  
  timeout: 3 * 60 * 1000, // 3 minutes
};

/**
 * PERMISSION DENIED — Access control, 403 errors
 */
export const PERMISSION_DENIED: ErrorResponseTemplate = {
  errorId: 'permission_denied',
  category: 'permission',
  title: '🔒 PERMISSION DENIED',
  description: 'The system requires permission or access I don\'t have.',
  
  options: [
    {
      id: 'grant_permission',
      label: 'Grant Permission',
      icon: '✓',
      description: 'Allow access if possible',
    },
    {
      id: 'skip_step',
      label: 'Skip This Step',
      icon: '⊚',
      description: 'Continue without this',
    },
    {
      id: 'cancel',
      label: 'Cancel Task',
      icon: '✕',
      danger: true,
    },
  ],
  
  timeout: 3 * 60 * 1000, // 3 minutes
};

/**
 * NETWORK ERROR — Temporary server/connection issues
 */
export const NETWORK_ERROR: ErrorResponseTemplate = {
  errorId: 'network_error',
  category: 'network',
  title: '⚠️ TEMPORARY SERVICE ERROR',
  description: 'The service is experiencing issues. Should I retry?',
  
  options: [
    {
      id: 'retry_now',
      label: 'Retry Now',
      icon: '⟳',
      description: 'Try again immediately',
    },
    {
      id: 'retry_delay',
      label: 'Retry in 30 Seconds',
      icon: '⏱',
      description: 'Wait a moment then try again',
    },
    {
      id: 'skip',
      label: 'Skip This Step',
      icon: '⊚',
      description: 'Continue with next',
    },
    {
      id: 'cancel',
      label: 'Cancel Task',
      icon: '✕',
      danger: true,
    },
  ],
  
  timeout: 2 * 60 * 1000, // 2 minutes
};

/**
 * Template registry for easy lookup
 */
export const ERROR_TEMPLATES: Record<string, ErrorResponseTemplate> = {
  [AUTH_LOGIN_REQUIRED.errorId]: AUTH_LOGIN_REQUIRED,
  [AUTH_2FA_REQUIRED.errorId]: AUTH_2FA_REQUIRED,
  [CAPTCHA_CHALLENGE.errorId]: CAPTCHA_CHALLENGE,
  [PAYWALL_REQUIRED.errorId]: PAYWALL_REQUIRED,
  [PERMISSION_DENIED.errorId]: PERMISSION_DENIED,
  [NETWORK_ERROR.errorId]: NETWORK_ERROR,
};

/**
 * Get template by error ID
 */
export function getErrorTemplate(errorId: string): ErrorResponseTemplate | null {
  return ERROR_TEMPLATES[errorId] || null;
}

/**
 * Get templates by category
 */
export function getErrorTemplatesByCategory(
  category: 'auth' | '2fa' | 'captcha' | 'paywall' | 'permission' | 'network' | 'unknown'
): ErrorResponseTemplate[] {
  return Object.values(ERROR_TEMPLATES).filter(t => t.category === category);
}
