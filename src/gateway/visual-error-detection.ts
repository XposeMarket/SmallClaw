// src/gateway/visual-error-detection.ts
// Visual analysis for detecting error states from browser screenshots

interface VisualErrorSignal {
  type: 'modal' | 'banner' | 'form_error' | 'captcha' | 'paywall' | 'blocked_page';
  confidence: number;
  description: string;
  suggestedCategory: string;
}

interface VisualAnalysisResult {
  hasError: boolean;
  signals: VisualErrorSignal[];
  topCategory: string | null;
  topConfidence: number;
}

class VisualErrorDetector {
  /**
   * Analyze page text content for visual error indicators.
   * In a full implementation this would process actual screenshots;
   * here we analyze extracted page text/DOM signals.
   */
  analyzePageContent(pageText: string, pageTitle?: string): VisualAnalysisResult {
    const signals: VisualErrorSignal[] = [];
    const lower = (pageText + ' ' + (pageTitle || '')).toLowerCase();

    // CAPTCHA detection
    if (/captcha|recaptcha|i'm not a robot|verify you are human/.test(lower)) {
      signals.push({
        type: 'captcha',
        confidence: 0.92,
        description: 'CAPTCHA challenge detected in page content',
        suggestedCategory: 'captcha',
      });
    }

    // Paywall / subscription wall
    if (/subscribe to (continue|read|access)|subscription required|premium (content|access)|upgrade (your|to) (plan|account)/.test(lower)) {
      signals.push({
        type: 'paywall',
        confidence: 0.88,
        description: 'Paywall or subscription gate detected',
        suggestedCategory: 'paywall',
      });
    }

    // Auth / login modal
    if (/(sign in|log in|login) to (continue|access|view)|please (sign in|log in|login)/.test(lower)) {
      signals.push({
        type: 'modal',
        confidence: 0.85,
        description: 'Login prompt or modal detected',
        suggestedCategory: 'auth',
      });
    }

    // 2FA / verification code
    if (/verification code|enter (the )?(code|otp)|check your (email|phone|sms)/.test(lower)) {
      signals.push({
        type: 'form_error',
        confidence: 0.88,
        description: 'Two-factor authentication code entry detected',
        suggestedCategory: '2fa',
      });
    }

    // Access denied / blocked
    if (/access denied|403 forbidden|you do not have permission|not authorized to/.test(lower)) {
      signals.push({
        type: 'blocked_page',
        confidence: 0.92,
        description: 'Access denied or forbidden page',
        suggestedCategory: 'permission',
      });
    }

    // Network error banners
    if (/service (temporarily )?unavailable|502 bad gateway|503 service|connection (timed out|failed|refused)/.test(lower)) {
      signals.push({
        type: 'banner',
        confidence: 0.87,
        description: 'Network or server error detected',
        suggestedCategory: 'network',
      });
    }

    if (signals.length === 0) {
      return { hasError: false, signals: [], topCategory: null, topConfidence: 0 };
    }

    // Sort by confidence
    signals.sort((a, b) => b.confidence - a.confidence);

    return {
      hasError: true,
      signals,
      topCategory: signals[0].suggestedCategory,
      topConfidence: signals[0].confidence,
    };
  }
}

let instance: VisualErrorDetector | null = null;

export function getVisualErrorDetector(): VisualErrorDetector {
  if (!instance) instance = new VisualErrorDetector();
  return instance;
}
