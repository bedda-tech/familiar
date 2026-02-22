import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  getConfigDir: () => "/tmp/familiar-test",
  parseDuration: (d: string) => {
    const match = d.match(/^(\d+)(ms|s|m|h|d)$/);
    if (!match) throw new Error("Invalid duration: " + d);
    const v = parseInt(match[1]);
    const m: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60000,
      h: 3600000,
      d: 86400000,
    };
    return v * m[match[2]];
  },
}));

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { SessionStore } from "./store.js";
import type { SessionInfo, CostSummary } from "./store.js";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore("24h", 200, ":memory:");
  });

  afterEach(() => {
    store.close();
  });

  // ---------- 1. Unknown chat returns null ----------
  it("getSession returns null for unknown chatId", () => {
    expect(store.getSession("unknown-chat")).toBeNull();
  });

  // ---------- 2. upsertSession creates, getSession retrieves ----------
  it("upsertSession creates a new session and getSession returns the session id", () => {
    store.upsertSession("chat-1", "sess-abc");
    const result = store.getSession("chat-1");
    expect(result).toBe("sess-abc");
  });

  // ---------- 3. upsertSession updates existing session ----------
  it("upsertSession on existing chat updates session id and increments message count", () => {
    store.upsertSession("chat-1", "sess-old");
    store.upsertSession("chat-1", "sess-new");

    const result = store.getSession("chat-1");
    expect(result).toBe("sess-new");

    const info = store.getSessionInfo("chat-1");
    expect(info).not.toBeNull();
    // First upsert sets count=1, second upsert increments to 2
    expect(info!.messageCount).toBe(2);
  });

  // ---------- 4. touchSession increments count ----------
  it("touchSession increments message count without changing session id", () => {
    store.upsertSession("chat-1", "sess-abc");
    store.touchSession("chat-1");
    store.touchSession("chat-1");

    const info = store.getSessionInfo("chat-1");
    expect(info).not.toBeNull();
    // upsert sets count=1, two touches add 2 more => 3
    expect(info!.messageCount).toBe(3);
    expect(info!.sessionId).toBe("sess-abc");
  });

  // ---------- 5. Session expires after inactivity ----------
  it("session expires after inactivity timeout", () => {
    // Use a very short inactivity timeout (1 second)
    const shortStore = new SessionStore("1s", 200, ":memory:");
    try {
      shortStore.upsertSession("chat-1", "sess-abc");

      // Session should be valid immediately
      expect(shortStore.getSession("chat-1")).toBe("sess-abc");

      // Manually backdate last_used_at by 2 seconds to simulate inactivity
      const db = shortStore.getDb();
      db.prepare(
        "UPDATE sessions SET last_used_at = datetime('now', '-2 seconds') WHERE chat_id = ?",
      ).run("chat-1");

      // Now the session should be expired
      expect(shortStore.getSession("chat-1")).toBeNull();
    } finally {
      shortStore.close();
    }
  });

  // ---------- 6. Session rotates after message count limit ----------
  it("session rotates after reaching the message count limit", () => {
    const limitedStore = new SessionStore("24h", 3, ":memory:");
    try {
      limitedStore.upsertSession("chat-1", "sess-abc"); // count = 1
      expect(limitedStore.getSession("chat-1")).toBe("sess-abc");

      limitedStore.touchSession("chat-1"); // count = 2
      expect(limitedStore.getSession("chat-1")).toBe("sess-abc");

      limitedStore.touchSession("chat-1"); // count = 3 — hits limit
      expect(limitedStore.getSession("chat-1")).toBeNull();
    } finally {
      limitedStore.close();
    }
  });

  // ---------- 7. clearSession removes session ----------
  it("clearSession removes the session for a chat", () => {
    store.upsertSession("chat-1", "sess-abc");
    expect(store.getSession("chat-1")).toBe("sess-abc");

    store.clearSession("chat-1");
    expect(store.getSession("chat-1")).toBeNull();
    expect(store.getSessionInfo("chat-1")).toBeNull();
  });

  // ---------- 8. getSessionInfo returns full info ----------
  it("getSessionInfo returns full SessionInfo object", () => {
    store.upsertSession("chat-1", "sess-abc");
    store.touchSession("chat-1");

    const info = store.getSessionInfo("chat-1");
    expect(info).not.toBeNull();
    expect(info!.chatId).toBe("chat-1");
    expect(info!.sessionId).toBe("sess-abc");
    expect(info!.messageCount).toBe(2);
    expect(info!.createdAt).toBeDefined();
    expect(info!.lastUsedAt).toBeDefined();
    // Timestamps should be plausible ISO-ish strings from SQLite datetime()
    expect(typeof info!.createdAt).toBe("string");
    expect(typeof info!.lastUsedAt).toBe("string");
  });

  it("getSessionInfo returns null for unknown chatId", () => {
    expect(store.getSessionInfo("unknown")).toBeNull();
  });

  // ---------- 9. logMessage stores and truncates long content ----------
  it("logMessage stores a message in the log", () => {
    store.upsertSession("chat-1", "sess-abc");
    store.logMessage("chat-1", "user", "Hello world", 0);
    store.logMessage("chat-1", "assistant", "Hi there!", 0.003);

    const db = store.getDb();
    const rows = db
      .prepare("SELECT role, content, cost_usd FROM message_log WHERE chat_id = ? ORDER BY id")
      .all("chat-1") as Array<{ role: string; content: string; cost_usd: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toBe("Hello world");
    expect(rows[0].cost_usd).toBe(0);
    expect(rows[1].role).toBe("assistant");
    expect(rows[1].content).toBe("Hi there!");
    expect(rows[1].cost_usd).toBe(0.003);
  });

  it("logMessage truncates content longer than 10000 characters", () => {
    const longContent = "A".repeat(15000);
    store.upsertSession("chat-1", "sess-abc");
    store.logMessage("chat-1", "assistant", longContent, 0.01);

    const db = store.getDb();
    const row = db
      .prepare("SELECT content FROM message_log WHERE chat_id = ?")
      .get("chat-1") as { content: string };

    expect(row.content).toHaveLength(10000);
    expect(row.content).toBe("A".repeat(10000));
  });

  // ---------- 10. getCostSummary returns correct totals ----------
  it("getCostSummary returns correct cost totals", () => {
    store.upsertSession("chat-1", "sess-abc");

    // Log some messages with costs (only assistant messages counted by getCostSummary)
    store.logMessage("chat-1", "user", "question 1", 0);
    store.logMessage("chat-1", "assistant", "answer 1", 0.005);
    store.logMessage("chat-1", "user", "question 2", 0);
    store.logMessage("chat-1", "assistant", "answer 2", 0.010);

    const summary: CostSummary = store.getCostSummary("chat-1");

    // session cost should include both assistant messages
    expect(summary.session.cost).toBeCloseTo(0.015, 5);
    expect(summary.session.messages).toBe(2);

    // today cost should be the same (all messages logged "today")
    expect(summary.today.cost).toBeCloseTo(0.015, 5);
    expect(summary.today.messages).toBe(2);

    // last24h should be the same
    expect(summary.last24h).toBeCloseTo(0.015, 5);

    // allTime should be the same
    expect(summary.allTime.cost).toBeCloseTo(0.015, 5);
    expect(summary.allTime.messages).toBe(2);
  });

  it("getCostSummary returns zeros for chat with no messages", () => {
    const summary = store.getCostSummary("nonexistent-chat");
    expect(summary.session.cost).toBe(0);
    expect(summary.session.messages).toBe(0);
    expect(summary.today.cost).toBe(0);
    expect(summary.today.messages).toBe(0);
    expect(summary.last24h).toBe(0);
    expect(summary.allTime.cost).toBe(0);
    expect(summary.allTime.messages).toBe(0);
  });

  // ---------- 11. Multiple chats are independent ----------
  it("multiple chats maintain independent sessions", () => {
    store.upsertSession("chat-A", "sess-A1");
    store.upsertSession("chat-B", "sess-B1");

    expect(store.getSession("chat-A")).toBe("sess-A1");
    expect(store.getSession("chat-B")).toBe("sess-B1");

    // Touch one, not the other
    store.touchSession("chat-A");

    const infoA = store.getSessionInfo("chat-A");
    const infoB = store.getSessionInfo("chat-B");
    expect(infoA!.messageCount).toBe(2); // upsert(1) + touch(1)
    expect(infoB!.messageCount).toBe(1); // upsert(1) only

    // Clear one, the other remains
    store.clearSession("chat-A");
    expect(store.getSession("chat-A")).toBeNull();
    expect(store.getSession("chat-B")).toBe("sess-B1");
  });

  it("logMessage and getCostSummary are independent per chat", () => {
    store.upsertSession("chat-A", "sess-A1");
    store.upsertSession("chat-B", "sess-B1");

    store.logMessage("chat-A", "assistant", "response A", 0.01);
    store.logMessage("chat-B", "assistant", "response B", 0.02);

    const summaryA = store.getCostSummary("chat-A");
    const summaryB = store.getCostSummary("chat-B");

    expect(summaryA.allTime.cost).toBeCloseTo(0.01, 5);
    expect(summaryA.allTime.messages).toBe(1);
    expect(summaryB.allTime.cost).toBeCloseTo(0.02, 5);
    expect(summaryB.allTime.messages).toBe(1);
  });

  // ---------- Additional edge cases ----------

  it("getDb exposes the underlying database instance", () => {
    const db = store.getDb();
    expect(db).toBeDefined();
    // Verify we can query with it
    const result = db.prepare("SELECT 1 as val").get() as { val: number };
    expect(result.val).toBe(1);
  });

  it("upsertSession replaces session id on conflict while preserving created_at", () => {
    store.upsertSession("chat-1", "sess-first");
    const infoFirst = store.getSessionInfo("chat-1");

    store.upsertSession("chat-1", "sess-second");
    const infoSecond = store.getSessionInfo("chat-1");

    expect(infoSecond!.sessionId).toBe("sess-second");
    // created_at should remain unchanged since the ON CONFLICT UPDATE
    // does not modify created_at
    expect(infoSecond!.createdAt).toBe(infoFirst!.createdAt);
  });

  it("session rotation boundary: count just below limit is still valid", () => {
    const limitedStore = new SessionStore("24h", 3, ":memory:");
    try {
      limitedStore.upsertSession("chat-1", "sess-abc"); // count = 1
      limitedStore.touchSession("chat-1"); // count = 2

      // At count=2 with limit=3, session should still be valid
      expect(limitedStore.getSession("chat-1")).toBe("sess-abc");
    } finally {
      limitedStore.close();
    }
  });

  it("touchSession on nonexistent chat is a no-op", () => {
    // Should not throw
    store.touchSession("nonexistent");

    // Nothing should be created
    expect(store.getSessionInfo("nonexistent")).toBeNull();
  });

  it("clearSession on nonexistent chat is a no-op", () => {
    // Should not throw
    store.clearSession("nonexistent");
  });
});
