import type { ChildProcess } from "node:child_process";

/** An in-flight Claude CLI request being tracked */
export interface TrackedRequest {
  chatId: string;
  pid: number | undefined;
  startedAt: Date;
}

/**
 * Tracks active in-flight `claude` processes spawned for chat requests.
 * Allows the bridge to show active requests in /processes and cancel them
 * via /cancel or /new.
 */
export class ProcessTracker {
  private active = new Map<string, { proc: ChildProcess; startedAt: Date }>();

  /** Register a spawned process for a given chatId. */
  register(chatId: string, proc: ChildProcess): void {
    this.active.set(chatId, { proc, startedAt: new Date() });
  }

  /** Unregister a completed process for a given chatId. */
  unregister(chatId: string): void {
    this.active.delete(chatId);
  }

  /** Return all currently tracked requests. */
  list(): TrackedRequest[] {
    return Array.from(this.active.entries()).map(([chatId, { proc, startedAt }]) => ({
      chatId,
      pid: proc.pid,
      startedAt,
    }));
  }

  /** Returns true if there is an active request for the given chatId. */
  isActive(chatId: string): boolean {
    return this.active.has(chatId);
  }

  /**
   * Kill the active process for a chatId.
   * Returns true if a process was found and killed, false otherwise.
   */
  kill(chatId: string): boolean {
    const entry = this.active.get(chatId);
    if (!entry) return false;
    try {
      entry.proc.kill("SIGTERM");
    } catch {
      // Process may have already exited — ignore
    }
    this.active.delete(chatId);
    return true;
  }

  /** Kill all tracked processes. Returns the count killed. */
  killAll(): number {
    let count = 0;
    for (const [chatId] of this.active) {
      if (this.kill(chatId)) count++;
    }
    return count;
  }

  /** Number of currently active requests. */
  get size(): number {
    return this.active.size;
  }
}
