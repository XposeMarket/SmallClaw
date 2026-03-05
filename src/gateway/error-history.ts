// src/gateway/error-history.ts
// Persistent in-memory error history for session tracking

interface ErrorRecord {
  id: string;
  taskId?: string;
  errorMessage: string;
  category: string;
  resolution?: string;
  resolved: boolean;
  timestamp: number;
}

class ErrorHistory {
  private records: ErrorRecord[] = [];
  private maxRecords = 500;

  add(entry: Omit<ErrorRecord, 'id' | 'timestamp'>): string {
    const id = Math.random().toString(36).substring(2, 10);
    const record: ErrorRecord = { ...entry, id, timestamp: Date.now() };
    this.records.unshift(record);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(0, this.maxRecords);
    }
    return id;
  }

  resolve(id: string, resolution: string): boolean {
    const record = this.records.find(r => r.id === id);
    if (!record) return false;
    record.resolved = true;
    record.resolution = resolution;
    return true;
  }

  getByTask(taskId: string): ErrorRecord[] {
    return this.records.filter(r => r.taskId === taskId);
  }

  getRecent(limit = 50): ErrorRecord[] {
    return this.records.slice(0, limit);
  }

  getStats(): { total: number; resolved: number; unresolved: number } {
    const resolved = this.records.filter(r => r.resolved).length;
    return { total: this.records.length, resolved, unresolved: this.records.length - resolved };
  }

  clear(): void {
    this.records = [];
  }
}

let instance: ErrorHistory | null = null;

export function getErrorHistory(): ErrorHistory {
  if (!instance) instance = new ErrorHistory();
  return instance;
}
