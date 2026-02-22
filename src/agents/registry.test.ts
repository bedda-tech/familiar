import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { AgentRegistry, SubagentRecord } from "./registry.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

describe("AgentRegistry", () => {
  let db: Database.Database;
  let registry: AgentRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    registry = new AgentRegistry(db);
  });

  function makeRecord(overrides: Partial<Pick<SubagentRecord, "id" | "task" | "label" | "model" | "chatId">> = {}) {
    return {
      id: overrides.id ?? "agent-001",
      task: overrides.task ?? "do something",
      label: overrides.label,
      model: overrides.model ?? "claude-opus-4-6",
      chatId: overrides.chatId ?? "chat-abc",
    };
  }

  // 1. register creates a running agent
  it("register creates a running agent", () => {
    registry.register(makeRecord());

    const agent = registry.get("agent-001");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("agent-001");
    expect(agent!.task).toBe("do something");
    expect(agent!.model).toBe("claude-opus-4-6");
    expect(agent!.chatId).toBe("chat-abc");
    expect(agent!.status).toBe("running");
    expect(agent!.createdAt).toBeDefined();
  });

  // 2. complete marks agent as completed with result
  it("complete marks agent as completed with result", () => {
    registry.register(makeRecord());
    registry.complete("agent-001", "task finished successfully", 0.05, 1200);

    const agent = registry.get("agent-001");
    expect(agent).not.toBeNull();
    expect(agent!.status).toBe("completed");
    expect(agent!.resultText).toBe("task finished successfully");
    expect(agent!.costUsd).toBe(0.05);
    expect(agent!.durationMs).toBe(1200);
    expect(agent!.endedAt).toBeDefined();
  });

  // 3. fail marks agent as failed with error
  it("fail marks agent as failed with error", () => {
    registry.register(makeRecord());
    registry.fail("agent-001", "something went wrong");

    const agent = registry.get("agent-001");
    expect(agent).not.toBeNull();
    expect(agent!.status).toBe("failed");
    expect(agent!.resultText).toBe("something went wrong");
    expect(agent!.endedAt).toBeDefined();
  });

  // 4. kill marks agent as killed
  it("kill marks agent as killed", () => {
    registry.register(makeRecord());
    registry.kill("agent-001");

    const agent = registry.get("agent-001");
    expect(agent).not.toBeNull();
    expect(agent!.status).toBe("killed");
    expect(agent!.endedAt).toBeDefined();
  });

  // 5. listActive returns only running agents
  it("listActive returns only running agents", () => {
    registry.register(makeRecord({ id: "a1", chatId: "chat-1" }));
    registry.register(makeRecord({ id: "a2", chatId: "chat-1" }));
    registry.register(makeRecord({ id: "a3", chatId: "chat-1" }));
    registry.complete("a2", "done", 0.01, 500);
    registry.fail("a3", "oops");

    const active = registry.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("a1");
    expect(active[0].status).toBe("running");
  });

  // 6. listActive filters by chatId
  it("listActive filters by chatId", () => {
    registry.register(makeRecord({ id: "a1", chatId: "chat-1" }));
    registry.register(makeRecord({ id: "a2", chatId: "chat-2" }));
    registry.register(makeRecord({ id: "a3", chatId: "chat-1" }));

    const chat1Active = registry.listActive("chat-1");
    expect(chat1Active).toHaveLength(2);
    expect(chat1Active.every((a) => a.chatId === "chat-1")).toBe(true);

    const chat2Active = registry.listActive("chat-2");
    expect(chat2Active).toHaveLength(1);
    expect(chat2Active[0].id).toBe("a2");
  });

  // 7. listRecent returns agents in DESC order
  it("listRecent returns agents in DESC order by created_at", () => {
    // Insert with explicit created_at to guarantee ordering
    const insert = db.prepare(
      `INSERT INTO subagents (id, task, model, chat_id, status, created_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
    );
    insert.run("a1", "first", "model-a", "chat-1", "2026-01-01 00:00:00");
    insert.run("a2", "second", "model-a", "chat-1", "2026-01-02 00:00:00");
    insert.run("a3", "third", "model-a", "chat-1", "2026-01-03 00:00:00");

    const recent = registry.listRecent();
    expect(recent).toHaveLength(3);
    expect(recent[0].id).toBe("a3");
    expect(recent[1].id).toBe("a2");
    expect(recent[2].id).toBe("a1");
  });

  // 8. listRecent respects limit
  it("listRecent respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      registry.register(makeRecord({ id: `agent-${i}`, chatId: "chat-1" }));
    }

    const limited = registry.listRecent(undefined, 3);
    expect(limited).toHaveLength(3);
  });

  // 9. get finds by exact id
  it("get finds agent by exact id", () => {
    registry.register(makeRecord({ id: "agent-xyz-123" }));

    const agent = registry.get("agent-xyz-123");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("agent-xyz-123");
  });

  // 10. get finds by id prefix
  it("get finds agent by id prefix", () => {
    registry.register(makeRecord({ id: "agent-xyz-123" }));

    const agent = registry.get("agent-xyz");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("agent-xyz-123");
  });

  // 11. get returns null for unknown prefix
  it("get returns null for unknown prefix", () => {
    registry.register(makeRecord({ id: "agent-abc" }));

    const agent = registry.get("nonexistent");
    expect(agent).toBeNull();
  });

  // 12. activeCount returns correct count
  it("activeCount returns correct count", () => {
    expect(registry.activeCount()).toBe(0);

    registry.register(makeRecord({ id: "a1" }));
    registry.register(makeRecord({ id: "a2" }));
    registry.register(makeRecord({ id: "a3" }));
    expect(registry.activeCount()).toBe(3);

    registry.complete("a1", "done", 0, 0);
    expect(registry.activeCount()).toBe(2);

    registry.fail("a2", "error");
    expect(registry.activeCount()).toBe(1);

    registry.kill("a3");
    expect(registry.activeCount()).toBe(0);
  });

  // 13. resultText truncated at 50000 chars
  it("complete truncates resultText at 50000 characters", () => {
    registry.register(makeRecord());

    const longResult = "x".repeat(60000);
    registry.complete("agent-001", longResult, 0.1, 1000);

    const agent = registry.get("agent-001");
    expect(agent).not.toBeNull();
    expect(agent!.resultText).toHaveLength(50000);
  });

  // 14. error truncated at 10000 chars
  it("fail truncates error at 10000 characters", () => {
    registry.register(makeRecord());

    const longError = "e".repeat(15000);
    registry.fail("agent-001", longError);

    const agent = registry.get("agent-001");
    expect(agent).not.toBeNull();
    expect(agent!.resultText).toHaveLength(10000);
  });

  // 15. label is optional (null handling)
  it("label is optional and maps to undefined when null", () => {
    registry.register(makeRecord({ id: "no-label" }));

    const agent = registry.get("no-label");
    expect(agent).not.toBeNull();
    expect(agent!.label).toBeUndefined();

    registry.register(makeRecord({ id: "with-label", label: "my-label" }));

    const labeled = registry.get("with-label");
    expect(labeled).not.toBeNull();
    expect(labeled!.label).toBe("my-label");
  });

  // Additional: listRecent filters by chatId
  it("listRecent filters by chatId when provided", () => {
    registry.register(makeRecord({ id: "a1", chatId: "chat-1" }));
    registry.register(makeRecord({ id: "a2", chatId: "chat-2" }));
    registry.register(makeRecord({ id: "a3", chatId: "chat-1" }));

    const chat1Recent = registry.listRecent("chat-1");
    expect(chat1Recent).toHaveLength(2);
    expect(chat1Recent.every((a) => a.chatId === "chat-1")).toBe(true);
  });

  // Additional: listRecent uses default limit of 20
  it("listRecent defaults to limit of 20", () => {
    for (let i = 0; i < 25; i++) {
      registry.register(makeRecord({ id: `agent-${String(i).padStart(3, "0")}`, chatId: "chat-1" }));
    }

    const recent = registry.listRecent();
    expect(recent).toHaveLength(20);
  });
});
