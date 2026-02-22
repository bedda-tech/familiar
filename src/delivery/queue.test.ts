import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DeliveryQueue } from "./queue.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

describe("DeliveryQueue", () => {
  let db: Database.Database;
  let queue: DeliveryQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(":memory:");
    queue = new DeliveryQueue(db);
  });

  afterEach(() => {
    queue.stop();
    db.close();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------
  // Table creation
  // ---------------------------------------------------------------
  it("creates the delivery_queue table on construction", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_queue'")
      .all();
    expect(tables).toHaveLength(1);
  });

  // ---------------------------------------------------------------
  // deliver() — immediate success
  // ---------------------------------------------------------------
  it("deliver() calls sender directly and does not enqueue on success", async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    queue.onSend(sender);

    await queue.deliver("chat-1", "hello");

    expect(sender).toHaveBeenCalledWith("chat-1", "hello");
    expect(queue.pendingCount()).toBe(0);
  });

  // ---------------------------------------------------------------
  // deliver() — sender failure
  // ---------------------------------------------------------------
  it("deliver() enqueues the message when the sender throws", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("network error"));
    queue.onSend(sender);

    await queue.deliver("chat-2", "retry me");

    expect(sender).toHaveBeenCalledOnce();
    expect(queue.pendingCount()).toBe(1);
  });

  // ---------------------------------------------------------------
  // deliver() — no sender configured
  // ---------------------------------------------------------------
  it("deliver() silently drops the message when no sender is configured", async () => {
    // onSend never called — sender remains null
    await queue.deliver("chat-3", "dropped");

    expect(queue.pendingCount()).toBe(0);
  });

  // ---------------------------------------------------------------
  // pendingCount()
  // ---------------------------------------------------------------
  it("pendingCount() returns the correct number of queued items", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("fail"));
    queue.onSend(sender);

    expect(queue.pendingCount()).toBe(0);

    await queue.deliver("chat-a", "msg1");
    expect(queue.pendingCount()).toBe(1);

    await queue.deliver("chat-b", "msg2");
    expect(queue.pendingCount()).toBe(2);

    await queue.deliver("chat-c", "msg3");
    expect(queue.pendingCount()).toBe(3);
  });

  // ---------------------------------------------------------------
  // Backoff calculation
  // ---------------------------------------------------------------
  describe("getBackoff()", () => {
    it.each([
      [0, 10],
      [1, 30],
      [2, 90],
      [3, 270],
      [4, 810],
    ])("attempt %i returns %i seconds", (attempt, expected) => {
      const backoff = (queue as any).getBackoff(attempt);
      expect(backoff).toBe(expected);
    });

    it("caps at 900 seconds for very high attempt numbers", () => {
      const backoff = (queue as any).getBackoff(10);
      expect(backoff).toBe(900);
    });
  });

  // ---------------------------------------------------------------
  // processQueue — successful retry
  // ---------------------------------------------------------------
  it("processQueue retries a failed delivery and removes it from the queue on success", async () => {
    // First call fails (during deliver()), second call succeeds (during processQueue)
    const sender = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    queue.onSend(sender);

    await queue.deliver("chat-retry", "retry this");
    expect(queue.pendingCount()).toBe(1);

    // Make the queued item eligible for retry by setting next_attempt_at to the past
    db.prepare("UPDATE delivery_queue SET next_attempt_at = datetime('now', '-1 seconds')").run();

    // Trigger processQueue by calling it directly via start() + timer
    // start() calls processQueue immediately
    queue.start();

    // processQueue is async, give the microtask queue time to flush
    await vi.advanceTimersByTimeAsync(0);

    expect(sender).toHaveBeenCalledTimes(2);
    expect(queue.pendingCount()).toBe(0);
  });

  // ---------------------------------------------------------------
  // processQueue — max attempts exceeded
  // ---------------------------------------------------------------
  it("processQueue drops the message after maxAttempts is reached", async () => {
    const maxAttempts = 3;
    const queueWithLowMax = new DeliveryQueue(db, maxAttempts);

    const sender = vi.fn().mockRejectedValue(new Error("persistent failure"));
    queueWithLowMax.onSend(sender);

    await queueWithLowMax.deliver("chat-drop", "will be dropped");
    expect(queueWithLowMax.pendingCount()).toBe(1);

    // Simulate reaching maxAttempts by setting attempts to maxAttempts - 1
    // (the next failure will push it to maxAttempts and trigger the drop)
    db.prepare("UPDATE delivery_queue SET attempts = ?, next_attempt_at = datetime('now', '-1 seconds')").run(
      maxAttempts - 1,
    );

    // Trigger processQueue
    queueWithLowMax.start();
    await vi.advanceTimersByTimeAsync(0);

    // Message should be removed from the queue after exceeding maxAttempts
    expect(queueWithLowMax.pendingCount()).toBe(0);

    queueWithLowMax.stop();
  });

  // ---------------------------------------------------------------
  // stop() clears the interval
  // ---------------------------------------------------------------
  it("stop() clears the retry interval", () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    queue.onSend(vi.fn().mockResolvedValue(undefined));
    queue.start();
    queue.stop();

    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });

  it("stop() is safe to call when no timer is running", () => {
    // Should not throw
    expect(() => queue.stop()).not.toThrow();
  });

  // ---------------------------------------------------------------
  // Multiple pending deliveries processed in order
  // ---------------------------------------------------------------
  it("processes multiple pending deliveries in creation order", async () => {
    const deliveryOrder: string[] = [];
    let callCount = 0;

    const sender = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
      callCount++;
      // Fail on initial deliver() calls (calls 1-3), succeed on retries (calls 4-6)
      if (callCount <= 3) {
        throw new Error("initial failure");
      }
      deliveryOrder.push(text);
    });
    queue.onSend(sender);

    // All three will fail on first attempt and be enqueued
    await queue.deliver("chat-1", "first");
    await queue.deliver("chat-2", "second");
    await queue.deliver("chat-3", "third");

    expect(queue.pendingCount()).toBe(3);

    // Make all eligible for retry
    db.prepare("UPDATE delivery_queue SET next_attempt_at = datetime('now', '-1 seconds')").run();

    // processQueue should retry them in created_at ASC order
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.pendingCount()).toBe(0);
    expect(deliveryOrder).toEqual(["first", "second", "third"]);
  });

  // ---------------------------------------------------------------
  // start() immediately flushes pending deliveries
  // ---------------------------------------------------------------
  it("start() calls processQueue immediately to flush pending items", async () => {
    const sender = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(undefined);
    queue.onSend(sender);

    await queue.deliver("chat-flush", "flush me");
    expect(queue.pendingCount()).toBe(1);

    // Make eligible
    db.prepare("UPDATE delivery_queue SET next_attempt_at = datetime('now', '-1 seconds')").run();

    queue.start();
    // The immediate processQueue call is async, flush microtasks
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.pendingCount()).toBe(0);
  });

  // ---------------------------------------------------------------
  // Retry loop fires on the 10-second interval
  // ---------------------------------------------------------------
  it("retry loop fires every 10 seconds after start()", async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    queue.onSend(sender);

    queue.start();
    await vi.advanceTimersByTimeAsync(0); // flush the immediate processQueue

    // Manually insert a row that is already due
    db.prepare(`
      INSERT INTO delivery_queue (chat_id, text, attempts, max_attempts, next_attempt_at)
      VALUES ('chat-interval', 'interval test', 0, 5, datetime('now', '-1 seconds'))
    `).run();

    expect(queue.pendingCount()).toBe(1);

    // Advance by 10 seconds to trigger the interval
    await vi.advanceTimersByTimeAsync(10_000);

    expect(queue.pendingCount()).toBe(0);
    expect(sender).toHaveBeenCalledWith("chat-interval", "interval test");
  });

  // ---------------------------------------------------------------
  // Failed retry reschedules with increased attempt count
  // ---------------------------------------------------------------
  it("failed retry increments attempts and reschedules with backoff", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("still failing"));
    queue.onSend(sender);

    await queue.deliver("chat-backoff", "backoff test");
    expect(queue.pendingCount()).toBe(1);

    // The initial deliver() failure sets attempts=1. Make it eligible for retry.
    db.prepare("UPDATE delivery_queue SET next_attempt_at = datetime('now', '-1 seconds')").run();

    // Trigger processQueue
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    // Should still be in queue but with incremented attempts
    expect(queue.pendingCount()).toBe(1);

    const row = db.prepare("SELECT attempts, last_error FROM delivery_queue").get() as {
      attempts: number;
      last_error: string;
    };
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe("still failing");
  });

  // ---------------------------------------------------------------
  // Error message is stored correctly for non-Error throws
  // ---------------------------------------------------------------
  it("stores stringified error for non-Error throws", async () => {
    const sender = vi.fn().mockRejectedValue("string error");
    queue.onSend(sender);

    await queue.deliver("chat-str-err", "string error test");

    const row = db.prepare("SELECT last_error FROM delivery_queue").get() as { last_error: string };
    expect(row.last_error).toBe("string error");
  });

  // ---------------------------------------------------------------
  // processQueue skips items not yet due for retry
  // ---------------------------------------------------------------
  it("processQueue does not process items scheduled for the future", async () => {
    const sender = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(undefined);
    queue.onSend(sender);

    await queue.deliver("chat-future", "not yet");
    expect(queue.pendingCount()).toBe(1);

    // The item has next_attempt_at in the future (10s backoff from initial failure).
    // processQueue should skip it.
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    // Still pending — not yet due
    expect(queue.pendingCount()).toBe(1);
    // sender was called only once (the initial deliver() attempt)
    expect(sender).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------
  // Custom maxAttempts
  // ---------------------------------------------------------------
  it("respects custom maxAttempts passed to constructor", async () => {
    const customQueue = new DeliveryQueue(db, 2);
    const sender = vi.fn().mockRejectedValue(new Error("always fails"));
    customQueue.onSend(sender);

    await customQueue.deliver("chat-custom", "custom max");
    expect(customQueue.pendingCount()).toBe(1);

    // Row has attempts=1, maxAttempts=2. One more failure should drop it.
    db.prepare("UPDATE delivery_queue SET next_attempt_at = datetime('now', '-1 seconds')").run();

    customQueue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(customQueue.pendingCount()).toBe(0);

    customQueue.stop();
  });
});
