/**
 * Octypo Run State - Shared singleton for batch coordination
 * Allows background service and API to communicate about batch status
 */

interface FailedItem {
  id: number;
  title: string;
  failedAt: Date;
  retryCount: number;
  lastError: string;
}

class OctypoRunState {
  private running = false;
  private lastCompleted: Date | null = null;
  private lastActivity: Date | null = null;
  private completionCallbacks: Array<() => void> = [];
  // Persistent failed queue - these will be retried
  private readonly failedQueue: Map<number, FailedItem> = new Map();
  // Track success/failure rate for adaptive concurrency
  private recentSuccesses = 0;
  private recentFailures = 0;
  private currentConcurrency = 12;

  private static readonly STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly MAX_RETRIES = 5;

  isRunning(): boolean {
    return this.running;
  }

  setRunning(value: boolean): void {
    this.running = value;
    if (value) {
      this.lastActivity = new Date();
    } else {
      this.lastCompleted = new Date();
      // Notify all registered callbacks
      this.completionCallbacks.forEach(cb => {
        try {
          cb();
        } catch (e) {
          console.error("[OctypoRunState] Completion callback error:", e);
        }
      });
    }
  }

  getLastCompleted(): Date | null {
    return this.lastCompleted;
  }

  getLastActivity(): Date | null {
    return this.lastActivity;
  }

  updateActivity(): void {
    this.lastActivity = new Date();
  }

  checkAndResetStale(): boolean {
    if (!this.running) return false;

    const now = Date.now();
    const lastActivityTime = this.lastActivity?.getTime() || 0;

    if (now - lastActivityTime > OctypoRunState.STALE_TIMEOUT_MS) {
      this.setRunning(false);
      return true;
    }
    return false;
  }

  onComplete(callback: () => void): void {
    this.completionCallbacks.push(callback);
  }

  clearCallbacks(): void {
    this.completionCallbacks = [];
  }

  // Failed queue management
  addToFailedQueue(id: number, title: string, error: string): void {
    const existing = this.failedQueue.get(id);
    const retryCount = existing ? existing.retryCount + 1 : 1;

    if (retryCount <= OctypoRunState.MAX_RETRIES) {
      this.failedQueue.set(id, {
        id,
        title,
        failedAt: new Date(),
        retryCount,
        lastError: error.substring(0, 200),
      });
    } else {
      // empty
    }
    this.recentFailures++;
  }

  removeFromFailedQueue(id: number): void {
    this.failedQueue.delete(id);
  }

  getFailedQueue(): FailedItem[] {
    return Array.from(this.failedQueue.values());
  }

  getFailedIds(): number[] {
    return Array.from(this.failedQueue.keys());
  }

  getFailedCount(): number {
    return this.failedQueue.size;
  }

  // Adaptive concurrency management
  reportSuccess(): void {
    this.recentSuccesses++;
    this.recentFailures = Math.max(0, this.recentFailures - 1);
  }

  reportFailure(): void {
    this.recentFailures++;
  }

  getConcurrency(): number {
    return this.currentConcurrency;
  }

  adjustConcurrency(): number {
    const total = this.recentSuccesses + this.recentFailures;
    if (total < 10) return this.currentConcurrency;

    const successRate = this.recentSuccesses / total;

    if (successRate > 0.9 && this.currentConcurrency < 20) {
      this.currentConcurrency = Math.min(20, this.currentConcurrency + 2);
    } else if (successRate < 0.5 && this.currentConcurrency > 5) {
      this.currentConcurrency = Math.max(5, this.currentConcurrency - 3);
    }

    // Reset counters periodically
    if (total > 50) {
      this.recentSuccesses = Math.floor(this.recentSuccesses / 2);
      this.recentFailures = Math.floor(this.recentFailures / 2);
    }

    return this.currentConcurrency;
  }

  getStats(): { failedCount: number; successRate: number; concurrency: number } {
    const total = this.recentSuccesses + this.recentFailures;
    return {
      failedCount: this.failedQueue.size,
      successRate: total > 0 ? this.recentSuccesses / total : 1,
      concurrency: this.currentConcurrency,
    };
  }
}

// Singleton instance
export const octypoState = new OctypoRunState();
