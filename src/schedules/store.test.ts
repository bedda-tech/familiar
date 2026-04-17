/**
 * Tests for ScheduleStore — CRUD for schedule entities.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import Database from "better-sqlite3";
import { ScheduleStore } from "./store.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  // schedules FK references agents(id) and projects(id)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  // Insert agent rows so FK constraints are satisfied in all tests
  const agentIds = ["agent-1", "agent-2", "a1", "a2", "a3", "agent-A", "agent-B"];
  for (const id of agentIds) {
    db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(id, id);
  }
  // Insert project rows for tests that reference project_id
  const projectIds = ["proj-1", "proj-X", "proj-Y", "proj-old", "proj-new"];
  for (const id of projectIds) {
    db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, id);
  }
  return db;
}

describe("ScheduleStore", () => {
  let db: Database.Database;
  let store: ScheduleStore;

  beforeEach(() => {
    db = makeDb();
    store = new ScheduleStore(db);
  });

  it("starts empty", () => {
    expect(store.list()).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it("creates a schedule and retrieves it by id", () => {
    const s = store.create({
      id: "sched-1",
      agent_id: "agent-1",
      schedule: "0 9 * * *",
      prompt: "Run morning briefing",
    });

    expect(s.id).toBe("sched-1");
    expect(s.agent_id).toBe("agent-1");
    expect(s.schedule).toBe("0 9 * * *");
    expect(s.prompt).toBe("Run morning briefing");
    expect(s.timezone).toBe("UTC");
    expect(s.enabled).toBe(1);
    expect(s.name).toBeNull();
    expect(s.project_id).toBeNull();
    expect(s.created_at).toBeDefined();
    expect(s.updated_at).toBeDefined();
  });

  it("stores optional name, timezone, and project_id", () => {
    const s = store.create({
      id: "sched-2",
      agent_id: "agent-2",
      name: "Daily digest",
      schedule: "every:1h",
      timezone: "America/Chicago",
      prompt: "Summarize activity",
      project_id: "proj-1",
    });

    expect(s.name).toBe("Daily digest");
    expect(s.timezone).toBe("America/Chicago");
    expect(s.project_id).toBe("proj-1");
  });

  it("creates disabled schedule when enabled=false", () => {
    const s = store.create({
      id: "sched-3",
      agent_id: "agent-1",
      schedule: "0 * * * *",
      prompt: "Hourly check",
      enabled: false,
    });

    expect(s.enabled).toBe(0);
  });

  it("returns undefined for missing id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists all schedules", () => {
    store.create({ id: "s1", agent_id: "a1", schedule: "0 9 * * *", prompt: "A", name: "Alpha" });
    store.create({ id: "s2", agent_id: "a2", schedule: "0 10 * * *", prompt: "B", name: "Beta" });

    const all = store.list();
    expect(all).toHaveLength(2);
  });

  it("lists schedules sorted by name ascending", () => {
    store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P", name: "Zebra" });
    store.create({ id: "s2", agent_id: "a2", schedule: "* * * * *", prompt: "P", name: "Alpha" });
    store.create({ id: "s3", agent_id: "a3", schedule: "* * * * *", prompt: "P", name: "Mango" });

    const all = store.list();
    expect(all.map((s) => s.name)).toEqual(["Alpha", "Mango", "Zebra"]);
  });

  it("filters by enabled=true", () => {
    store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P", enabled: true });
    store.create({ id: "s2", agent_id: "a2", schedule: "* * * * *", prompt: "P", enabled: false });

    const enabled = store.list({ enabled: true });
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe("s1");
  });

  it("filters by enabled=false", () => {
    store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P", enabled: true });
    store.create({ id: "s2", agent_id: "a2", schedule: "* * * * *", prompt: "P", enabled: false });

    const disabled = store.list({ enabled: false });
    expect(disabled).toHaveLength(1);
    expect(disabled[0].id).toBe("s2");
  });

  it("filters by agent_id", () => {
    store.create({ id: "s1", agent_id: "agent-A", schedule: "* * * * *", prompt: "P" });
    store.create({ id: "s2", agent_id: "agent-B", schedule: "* * * * *", prompt: "P" });
    store.create({ id: "s3", agent_id: "agent-A", schedule: "* * * * *", prompt: "Q" });

    const forA = store.list({ agent_id: "agent-A" });
    expect(forA).toHaveLength(2);
    expect(forA.every((s) => s.agent_id === "agent-A")).toBe(true);
  });

  it("filters by project_id", () => {
    store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P", project_id: "proj-X" });
    store.create({ id: "s2", agent_id: "a2", schedule: "* * * * *", prompt: "P", project_id: "proj-Y" });

    const forX = store.list({ project_id: "proj-X" });
    expect(forX).toHaveLength(1);
    expect(forX[0].id).toBe("s1");
  });

  it("listByAgent returns schedules for that agent", () => {
    store.create({ id: "s1", agent_id: "agent-1", schedule: "* * * * *", prompt: "P" });
    store.create({ id: "s2", agent_id: "agent-2", schedule: "* * * * *", prompt: "P" });
    store.create({ id: "s3", agent_id: "agent-1", schedule: "* * * * *", prompt: "Q" });

    const results = store.listByAgent("agent-1");
    expect(results).toHaveLength(2);
    expect(results.every((s) => s.agent_id === "agent-1")).toBe(true);
  });

  it("listEnabled returns only enabled schedules", () => {
    store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P", enabled: true });
    store.create({ id: "s2", agent_id: "a2", schedule: "* * * * *", prompt: "P", enabled: false });
    store.create({ id: "s3", agent_id: "a3", schedule: "* * * * *", prompt: "P", enabled: true });

    const enabled = store.listEnabled();
    expect(enabled).toHaveLength(2);
    expect(enabled.every((s) => s.enabled === 1)).toBe(true);
  });

  it("count reflects stored schedules", () => {
    expect(store.count()).toBe(0);
    store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P" });
    expect(store.count()).toBe(1);
    store.create({ id: "s2", agent_id: "a2", schedule: "* * * * *", prompt: "Q" });
    expect(store.count()).toBe(2);
  });

  describe("update", () => {
    it("updates schedule expression", () => {
      store.create({ id: "s1", agent_id: "a1", schedule: "0 9 * * *", prompt: "P" });
      const updated = store.update("s1", { schedule: "0 10 * * *" });
      expect(updated?.schedule).toBe("0 10 * * *");
    });

    it("updates prompt", () => {
      store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "Old prompt" });
      const updated = store.update("s1", { prompt: "New prompt" });
      expect(updated?.prompt).toBe("New prompt");
    });

    it("updates enabled flag", () => {
      store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P", enabled: true });
      const updated = store.update("s1", { enabled: false });
      expect(updated?.enabled).toBe(0);
    });

    it("updates timezone", () => {
      store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P" });
      const updated = store.update("s1", { timezone: "America/New_York" });
      expect(updated?.timezone).toBe("America/New_York");
    });

    it("updates name to null", () => {
      store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P", name: "Named" });
      const updated = store.update("s1", { name: null });
      expect(updated?.name).toBeNull();
    });

    it("updates project_id", () => {
      store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P" });
      const updated = store.update("s1", { project_id: "proj-new" });
      expect(updated?.project_id).toBe("proj-new");
    });

    it("clears project_id when set to null", () => {
      store.create({
        id: "s1",
        agent_id: "a1",
        schedule: "* * * * *",
        prompt: "P",
        project_id: "proj-old",
      });
      const updated = store.update("s1", { project_id: null });
      expect(updated?.project_id).toBeNull();
    });

    it("no-ops update with empty input", () => {
      store.create({ id: "s1", agent_id: "a1", schedule: "0 9 * * *", prompt: "Unchanged" });
      const updated = store.update("s1", {});
      expect(updated?.prompt).toBe("Unchanged");
      expect(updated?.schedule).toBe("0 9 * * *");
    });

    it("returns undefined when updating missing id", () => {
      expect(store.update("ghost", { prompt: "new" })).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("deletes an existing schedule and returns true", () => {
      store.create({ id: "s1", agent_id: "a1", schedule: "* * * * *", prompt: "P" });
      expect(store.delete("s1")).toBe(true);
      expect(store.get("s1")).toBeUndefined();
      expect(store.count()).toBe(0);
    });

    it("returns false when deleting missing id", () => {
      expect(store.delete("no-such-id")).toBe(false);
    });
  });
});
