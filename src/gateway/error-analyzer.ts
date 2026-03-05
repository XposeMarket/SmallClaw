// src/gateway/error-analyzer.ts
// Pattern learning for error analysis — tracks error frequency and outcomes

interface ErrorPattern {
  pattern: string;
  category: string;
  occurrences: number;
  successfulResolutions: number;
  lastSeen: number;
}

interface AnalysisResult {
  suggestedCategory: string | null;
  confidence: number;
  learnedPatterns: string[];
}

class ErrorAnalyzer {
  private patterns: Map<string, ErrorPattern> = new Map();

  recordError(errorMessage: string, category: string): void {
    const key = this.normalizeKey(errorMessage);
    const existing = this.patterns.get(key);
    if (existing) {
      existing.occurrences++;
      existing.lastSeen = Date.now();
    } else {
      this.patterns.set(key, {
        pattern: errorMessage.substring(0, 200),
        category,
        occurrences: 1,
        successfulResolutions: 0,
        lastSeen: Date.now(),
      });
    }
  }

  recordResolution(errorMessage: string, resolved: boolean): void {
    const key = this.normalizeKey(errorMessage);
    const existing = this.patterns.get(key);
    if (existing && resolved) {
      existing.successfulResolutions++;
    }
  }

  analyze(errorMessage: string): AnalysisResult {
    const key = this.normalizeKey(errorMessage);
    const match = this.patterns.get(key);
    if (match && match.occurrences >= 2) {
      const confidence = Math.min(0.9, 0.5 + match.occurrences * 0.1);
      return {
        suggestedCategory: match.category,
        confidence,
        learnedPatterns: [match.pattern],
      };
    }
    return { suggestedCategory: null, confidence: 0, learnedPatterns: [] };
  }

  getStats(): { totalPatterns: number; totalOccurrences: number } {
    let total = 0;
    for (const p of this.patterns.values()) total += p.occurrences;
    return { totalPatterns: this.patterns.size, totalOccurrences: total };
  }

  private normalizeKey(msg: string): string {
    return msg.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 64);
  }
}

let instance: ErrorAnalyzer | null = null;

export function getErrorAnalyzer(): ErrorAnalyzer {
  if (!instance) instance = new ErrorAnalyzer();
  return instance;
}
