/**
 * Tests for TaskStore — task dependency support.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { TaskStore } from "./store.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { vi } from "vitest";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      assigned_agent TEXT,
      status TEXT DEFAULT 'ready',
      priority INTEGER DEFAULT 5,
      recurring INTEGER DEFAULT 0,
      recurrence_schedule TEXT,
      last_completed_at TEXT,
      result TEXT,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      claimed_by TEXT,
      claimed_at TEXT,
      model_hint TEXT,
      retry_count INTEGER DEFAULT 0,
      depends_on TEXT,
      stale_timeout_hours REAL DEFAULT NULL
    );
  `);
  return db;
}

function makeStore(db: Database.Database): TaskStore {
  return new TaskStore(db);
}

describe("TaskStore — create with depends_on", () => {
  let db: Database.Database;
  let store: TaskStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
  });

  it("creates a task with status 'ready' when no depends_on", () => {
    const task = store.create({ title: "Task A" });
    expect(task.status).toBe("ready");
    expect(task.depends_on).toBeNull();
  });

  it("creates a task with status 'blocked' when depends_on is provided", () => {
    const dep = store.create({ title: "Dep task" });
    const task = store.create({ title: "Dependent task", depends_on: [dep.id] });
    expect(task.status).toBe("blocked");
    expect(JSON.parse(task.depends_on!)).toEqual([dep.id]);
  });

  it("creates a task with status 'blocked' for multiple deps", () => {
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });
    const task = store.create({ title: "C", depends_on: [a.id, b.id] });
    expect(task.status).toBe("blocked");
    expect(JSON.parse(task.depends_on!)).toEqual([a.id, b.id]);
  });

  it("creates a task with status 'ready' when depends_on is empty array", () => {
    const task = store.create({ title: "Task", depends_on: [] });
    expect(task.status).toBe("ready");
    expect(task.depends_on).toBeNull();
  });
});

describe("TaskStore — unblockDependents", () => {
  let db: Database.Database;
  let store: TaskStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
  });

  it("unblocks a task when its single dep completes", () => {
    const dep = store.create({ title: "Dep" });
    const dependent = store.create({ title: "Dependent", depends_on: [dep.id] });
    expect(dependent.status).toBe("blocked");

    store.complete(dep.id, "done");

    const updated = store.get(dependent.id)!;
    expect(updated.status).toBe("ready");
  });

  it("does not unblock when only one of two deps completes", () => {
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });
    const c = store.create({ title: "C", depends_on: [a.id, b.id] });

    store.complete(a.id, "a done");

    const cUpdated = store.get(c.id)!;
    expect(cUpdated.status).toBe("blocked");
  });

  it("unblocks when all deps complete in sequence", () => {
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });
    const c = store.create({ title: "C", depends_on: [a.id, b.id] });

    store.complete(a.id, "a done");
    store.complete(b.id, "b done");

    const cUpdated = store.get(c.id)!;
    expect(cUpdated.status).toBe("ready");
  });

  it("unblockDependents returns the list of newly unblocked tasks", () => {
    const dep = store.create({ title: "Dep" });
    const dependent = store.create({ title: "Dependent", depends_on: [dep.id] });

    // Mark dep completed directly so we can call unblockDependents separately
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(dep.id);
    const unblocked = store.unblockDependents(dep.id);

    expect(unblocked).toHaveLength(1);
    expect(unblocked[0].id).toBe(dependent.id);
    expect(unblocked[0].status).toBe("ready");
  });

  it("does not affect tasks without depends_on", () => {
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" }); // no deps

    store.complete(a.id, "done");

    const bUpdated = store.get(b.id)!;
    expect(bUpdated.status).toBe("ready"); // unchanged
  });
});

describe("TaskStore — enrichWithDependencyStatus", () => {
  let db: Database.Database;
  let store: TaskStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
  });

  it("returns null dependency_status for tasks with no deps", () => {
    const a = store.create({ title: "A" });
    const [enriched] = store.enrichWithDependencyStatus([a]);
    expect(enriched.dependency_status).toBeNull();
  });

  it("returns correct counts for a blocked task with no completed deps", () => {
    const dep = store.create({ title: "Dep" });
    const task = store.create({ title: "Task", depends_on: [dep.id] });
    const [enriched] = store.enrichWithDependencyStatus([task]);
    expect(enriched.dependency_status).toEqual({ total: 1, completed: 0 });
  });

  it("returns correct counts when some deps are completed", () => {
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });
    const c = store.create({ title: "C", depends_on: [a.id, b.id] });

    store.complete(a.id, "done");

    const [enriched] = store.enrichWithDependencyStatus([store.get(c.id)!]);
    expect(enriched.dependency_status).toEqual({ total: 2, completed: 1 });
  });

  it("returns correct counts when all deps are completed", () => {
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });
    const c = store.create({ title: "C", depends_on: [a.id, b.id] });

    store.complete(a.id, "a done");
    store.complete(b.id, "b done");

    const [enriched] = store.enrichWithDependencyStatus([store.get(c.id)!]);
    expect(enriched.dependency_status).toEqual({ total: 2, completed: 2 });
  });

  it("handles mixed tasks — some with deps, some without", () => {
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B", depends_on: [a.id] });
    const c = store.create({ title: "C" }); // no deps

    store.complete(a.id, "done");

    const enriched = store.enrichWithDependencyStatus([store.get(a.id)!, store.get(b.id)!, c]);
    expect(enriched[0].dependency_status).toBeNull(); // a has no deps
    expect(enriched[1].dependency_status).toEqual({ total: 1, completed: 1 }); // b's dep (a) is completed
    expect(enriched[2].dependency_status).toBeNull(); // c has no deps
  });
});
