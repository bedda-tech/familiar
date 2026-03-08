/**
 * Tests for TemplateStore.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import Database from "better-sqlite3";
import { TemplateStore } from "./store.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

function makeStore(): TemplateStore {
  const db = new Database(":memory:");
  return new TemplateStore(db);
}

describe("TemplateStore", () => {
  let store: TemplateStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("starts empty", () => {
    expect(store.list()).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it("creates a template and retrieves it", () => {
    const t = store.create({ name: "My Template", category: "agent-prompt", content: "Hello {{agent}}" });
    expect(t.id).toBe(1);
    expect(t.name).toBe("My Template");
    expect(t.category).toBe("agent-prompt");
    expect(t.content).toBe("Hello {{agent}}");
    expect(t.description).toBeNull();

    const fetched = store.get(1);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("My Template");
  });

  it("returns undefined for missing id", () => {
    expect(store.get(999)).toBeUndefined();
  });

  it("lists templates sorted by category then name", () => {
    store.create({ name: "Z Template", category: "other", content: "z" });
    store.create({ name: "A Template", category: "agent-prompt", content: "a" });
    store.create({ name: "B Template", category: "agent-prompt", content: "b" });

    const list = store.list();
    expect(list[0].name).toBe("A Template");
    expect(list[1].name).toBe("B Template");
    expect(list[2].name).toBe("Z Template");
  });

  it("filters by category", () => {
    store.create({ name: "T1", category: "agent-prompt", content: "a" });
    store.create({ name: "T2", category: "system-prompt", content: "b" });

    const agentPrompts = store.list({ category: "agent-prompt" });
    expect(agentPrompts).toHaveLength(1);
    expect(agentPrompts[0].name).toBe("T1");
  });

  it("updates a template", () => {
    const t = store.create({ name: "Original", category: "other", content: "old" });
    const updated = store.update(t.id, { name: "Updated", content: "new content" });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Updated");
    expect(updated!.content).toBe("new content");
    expect(updated!.category).toBe("other"); // unchanged
  });

  it("returns undefined when updating missing id", () => {
    expect(store.update(999, { name: "X" })).toBeUndefined();
  });

  it("no-ops update with empty input", () => {
    const t = store.create({ name: "Stable", category: "other", content: "content" });
    const result = store.update(t.id, {});
    expect(result!.name).toBe("Stable");
  });

  it("deletes a template", () => {
    const t = store.create({ name: "Temporary", category: "other", content: "tmp" });
    expect(store.delete(t.id)).toBe(true);
    expect(store.get(t.id)).toBeUndefined();
    expect(store.count()).toBe(0);
  });

  it("returns false when deleting missing id", () => {
    expect(store.delete(999)).toBe(false);
  });

  it("stores description", () => {
    const t = store.create({ name: "With Desc", category: "other", content: "x", description: "My description" });
    expect(t.description).toBe("My description");
  });

  it("can set description to null on update", () => {
    const t = store.create({ name: "With Desc", category: "other", content: "x", description: "desc" });
    const updated = store.update(t.id, { description: null });
    expect(updated!.description).toBeNull();
  });

  it("count reflects stored templates", () => {
    store.create({ name: "T1", category: "other", content: "a" });
    store.create({ name: "T2", category: "other", content: "b" });
    expect(store.count()).toBe(2);
    store.delete(1);
    expect(store.count()).toBe(1);
  });
});
