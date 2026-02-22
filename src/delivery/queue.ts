import Database from "better-sqlite3";
import { getLogger } from "../util/logger.js";

const log = getLogger("delivery-queue");

interface PendingDelivery {
  id: number;
  chatId: string;
  text: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  createdAt: string;
}

/**
 * SQLite-backed delivery queue with exponential backoff retry.
 * Persists failed message deliveries so they survive restarts.
 */
export class DeliveryQueue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sender: ((chatId: string, text: string) => Promise<void>) | null = null;

  constructor(
    private db: Database.Database,
    private maxAttempts = 5,
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 5,
        next_attempt_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        last_error TEXT
      );
    `);
  }

  /** Set the function that actually sends messages to Telegram */
  onSend(sender: (chatId: string, text: string) => Promise<void>): void {
    this.sender = sender;
  }

  /** Enqueue a message for delivery. Tries immediately, persists on failure. */
  async deliver(chatId: string, text: string): Promise<void> {
    if (!this.sender) {
      log.warn("no sender configured — dropping message");
      return;
    }

    try {
      await this.sender(chatId, text);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      // Check if it's a rate limit (429) — always retry
      // For other errors, still enqueue for retry
      log.warn({ chatId, error: errMsg }, "delivery failed — enqueueing for retry");

      const backoffSec = this.getBackoff(0);
      this.db.prepare(`
        INSERT INTO delivery_queue (chat_id, text, attempts, max_attempts, next_attempt_at, last_error)
        VALUES (?, ?, 1, ?, datetime('now', '+' || ? || ' seconds'), ?)
      `).run(chatId, text, this.maxAttempts, backoffSec, errMsg);
    }
  }

  /** Start the retry loop (checks every 10s) */
  start(): void {
    // Flush any pending deliveries from previous runs
    this.processQueue();

    this.timer = setInterval(() => this.processQueue(), 10_000);
    log.info("delivery queue started");
  }

  /** Stop the retry loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get count of pending deliveries */
  pendingCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM delivery_queue`
    ).get() as { count: number };
    return row.count;
  }

  private async processQueue(): Promise<void> {
    if (!this.sender) return;

    const rows = this.db.prepare(`
      SELECT * FROM delivery_queue
      WHERE next_attempt_at <= datetime('now')
      ORDER BY created_at ASC
      LIMIT 10
    `).all() as PendingDelivery[];

    for (const row of rows) {
      try {
        await this.sender(row.chatId, row.text);
        // Success — remove from queue
        this.db.prepare(`DELETE FROM delivery_queue WHERE id = ?`).run(row.id);
        log.info({ id: row.id, chatId: row.chatId, attempts: row.attempts + 1 }, "retry delivery succeeded");
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const nextAttempt = row.attempts + 1;

        if (nextAttempt >= row.maxAttempts) {
          // Max retries exhausted — drop it
          this.db.prepare(`DELETE FROM delivery_queue WHERE id = ?`).run(row.id);
          log.error({ id: row.id, chatId: row.chatId, attempts: nextAttempt, error: errMsg }, "delivery failed permanently — dropped");
        } else {
          // Schedule next retry with exponential backoff
          const backoffSec = this.getBackoff(nextAttempt);
          this.db.prepare(`
            UPDATE delivery_queue
            SET attempts = ?, next_attempt_at = datetime('now', '+' || ? || ' seconds'), last_error = ?
            WHERE id = ?
          `).run(nextAttempt, backoffSec, errMsg, row.id);
          log.warn({ id: row.id, attempts: nextAttempt, nextRetrySec: backoffSec, error: errMsg }, "retry failed — rescheduled");
        }
      }
    }
  }

  /** Exponential backoff: 10s, 30s, 90s, 270s, 810s */
  private getBackoff(attempt: number): number {
    return Math.min(10 * Math.pow(3, attempt), 900);
  }
}
