/**
 * Tests for ToolStore and ToolAccountStore.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ToolStore } from "./store.js";
import { ToolAccountStore } from "./account-store.js";
import { TOOL_PROFILES, getProfile, profileForAgent } from "./profiles.js";
import { TOOL_REGISTRY } from "./registry.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  // tool_accounts references projects(id); create a stub table so the FK constraint parses
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  return db;
}

describe("ToolStore", () => {
  let db: Database.Database;
  let store: ToolStore;

  beforeEach(() => {
    db = makeDb();
    store = new ToolStore(db);
  });

  it("starts empty", () => {
    expect(store.list()).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it("creates and retrieves a tool", () => {
    const tool = store.create({
      id: "gh",
      name: "GitHub CLI",
      type: "cli",
      cli_command: "gh",
      description: "GitHub command-line tool",
    });

    expect(tool.id).toBe("gh");
    expect(tool.name).toBe("GitHub CLI");
    expect(tool.type).toBe("cli");
    expect(tool.cli_command).toBe("gh");
    expect(tool.enabled).toBe(1);
  });

  it("lists tools with optional type filter", () => {
    store.create({ id: "gh", name: "GitHub CLI", type: "cli" });
    store.create({ id: "bash", name: "Bash", type: "builtin" });
    store.create({ id: "github-mcp", name: "GitHub MCP", type: "mcp" });

    expect(store.list()).toHaveLength(3);
    expect(store.list({ type: "cli" })).toHaveLength(1);
    expect(store.list({ type: "mcp" })).toHaveLength(1);
    expect(store.listByType("builtin")).toHaveLength(1);
  });

  it("filters by enabled status", () => {
    store.create({ id: "gh", name: "GitHub CLI", type: "cli", enabled: true });
    store.create({ id: "bird", name: "Bird CLI", type: "cli", enabled: false });

    expect(store.listEnabled()).toHaveLength(1);
    expect(store.listEnabled()[0].id).toBe("gh");
  });

  it("updates a tool", () => {
    store.create({ id: "gh", name: "GitHub CLI", type: "cli" });
    const updated = store.update("gh", { description: "Updated desc", version: "2.0.0" });

    expect(updated?.description).toBe("Updated desc");
    expect(updated?.version).toBe("2.0.0");
  });

  it("returns undefined when updating non-existent tool", () => {
    expect(store.update("no-such", { version: "1.0" })).toBeUndefined();
  });

  it("stores and retrieves config JSON", () => {
    store.create({
      id: "github-mcp",
      name: "GitHub MCP",
      type: "mcp",
      config: { transport: "stdio", command: "npx mcp-github" },
    });

    const t = store.get("github-mcp");
    expect(t).toBeDefined();
    // config stored as JSON string
    const cfg = JSON.parse(t!.config!);
    expect(cfg.transport).toBe("stdio");
  });

  it("deletes a tool", () => {
    store.create({ id: "gh", name: "GitHub CLI", type: "cli" });
    expect(store.delete("gh")).toBe(true);
    expect(store.get("gh")).toBeUndefined();
    expect(store.count()).toBe(0);
  });

  it("delete returns false for non-existent tool", () => {
    expect(store.delete("no-such")).toBe(false);
  });

  it("counts tools", () => {
    expect(store.count()).toBe(0);
    store.create({ id: "a", name: "A", type: "cli" });
    store.create({ id: "b", name: "B", type: "mcp" });
    expect(store.count()).toBe(2);
  });
});

describe("ToolAccountStore", () => {
  let db: Database.Database;
  let toolStore: ToolStore;
  let accountStore: ToolAccountStore;

  beforeEach(() => {
    db = makeDb();
    toolStore = new ToolStore(db);
    accountStore = new ToolAccountStore(db);

    // Create a tool to attach accounts to
    toolStore.create({ id: "bird", name: "Bird CLI", type: "cli", cli_command: "bird" });
  });

  it("starts with no accounts", () => {
    expect(accountStore.list()).toEqual([]);
    expect(accountStore.list("bird")).toEqual([]);
    expect(accountStore.countByTool("bird")).toBe(0);
  });

  it("creates an account", () => {
    const acc = accountStore.create({
      tool_id: "bird",
      account_name: "beddaai",
      credentials: { AUTH_TOKEN: "tok123", CT0: "ct0abc" },
    });

    expect(acc.tool_id).toBe("bird");
    expect(acc.account_name).toBe("beddaai");
    expect(acc.is_default).toBe(0);
    expect(acc.enabled).toBe(1);

    // Credentials stored as JSON
    const creds = JSON.parse(acc.credentials);
    expect(creds.AUTH_TOKEN).toBe("tok123");
  });

  it("lists accounts for a specific tool", () => {
    toolStore.create({ id: "gh", name: "GitHub CLI", type: "cli" });
    accountStore.create({ tool_id: "bird", account_name: "beddaai", credentials: { tok: "a" } });
    accountStore.create({ tool_id: "gh", account_name: "personal", credentials: { GH_TOKEN: "x" } });

    expect(accountStore.list("bird")).toHaveLength(1);
    expect(accountStore.list("gh")).toHaveLength(1);
    expect(accountStore.list()).toHaveLength(2);
  });

  it("sets is_default and clears previous default", () => {
    accountStore.create({ tool_id: "bird", account_name: "beddaai", credentials: { tok: "a" }, is_default: true });
    accountStore.create({ tool_id: "bird", account_name: "personal", credentials: { tok: "b" }, is_default: true });

    const accounts = accountStore.list("bird");
    const defaults = accounts.filter((a) => a.is_default === 1);
    // Only one should be default
    expect(defaults).toHaveLength(1);
    expect(defaults[0].account_name).toBe("personal");
  });

  it("masks credentials in listMasked", () => {
    accountStore.create({ tool_id: "bird", account_name: "beddaai", credentials: { AUTH_TOKEN: "tok123", CT0: "ct0abc" } });
    const masked = accountStore.listMasked("bird");
    expect(masked).toHaveLength(1);
    const creds = JSON.parse(masked[0].credentials);
    expect(creds.AUTH_TOKEN).toBe("****");
    expect(creds.CT0).toBe("****");
  });

  it("getMasked returns masked credentials", () => {
    const acc = accountStore.create({ tool_id: "bird", account_name: "beddaai", credentials: { AUTH_TOKEN: "secret" } });
    const masked = accountStore.getMasked(acc.id);
    expect(masked).toBeDefined();
    const creds = JSON.parse(masked!.credentials);
    expect(creds.AUTH_TOKEN).toBe("****");
  });

  it("updates an account", () => {
    const acc = accountStore.create({ tool_id: "bird", account_name: "beddaai", credentials: { tok: "old" } });
    const updated = accountStore.update(acc.id, { account_name: "beddaai-updated", credentials: { tok: "new" } });

    expect(updated?.account_name).toBe("beddaai-updated");
    const creds = JSON.parse(updated!.credentials);
    expect(creds.tok).toBe("new");
  });

  it("update returns undefined for non-existent account", () => {
    expect(accountStore.update("no-such", { account_name: "x" })).toBeUndefined();
  });

  it("deletes an account", () => {
    const acc = accountStore.create({ tool_id: "bird", account_name: "beddaai", credentials: { tok: "a" } });
    expect(accountStore.delete(acc.id)).toBe(true);
    expect(accountStore.get(acc.id)).toBeUndefined();
  });

  it("deleteByTool removes all accounts for a tool", () => {
    accountStore.create({ tool_id: "bird", account_name: "a1", credentials: { tok: "a" } });
    accountStore.create({ tool_id: "bird", account_name: "a2", credentials: { tok: "b" } });
    const deleted = accountStore.deleteByTool("bird");
    expect(deleted).toBe(2);
    expect(accountStore.list("bird")).toHaveLength(0);
  });

  it("countByTool returns correct count", () => {
    expect(accountStore.countByTool("bird")).toBe(0);
    accountStore.create({ tool_id: "bird", account_name: "a1", credentials: { tok: "a" } });
    accountStore.create({ tool_id: "bird", account_name: "a2", credentials: { tok: "b" } });
    expect(accountStore.countByTool("bird")).toBe(2);
  });

  it("default ordering: default account first, then alpha", () => {
    accountStore.create({ tool_id: "bird", account_name: "zzz", credentials: { tok: "z" } });
    accountStore.create({ tool_id: "bird", account_name: "aaa", credentials: { tok: "a" }, is_default: true });

    const accounts = accountStore.list("bird");
    expect(accounts[0].account_name).toBe("aaa"); // default comes first
    expect(accounts[1].account_name).toBe("zzz");
  });
});

describe("ToolStore.seed()", () => {
  it("seeds all registry tools on first call", () => {
    const db = makeDb();
    const store = new ToolStore(db);
    const seeded = store.seed();
    expect(seeded).toBe(TOOL_REGISTRY.length);
    expect(store.count()).toBe(TOOL_REGISTRY.length);
  });

  it("seed is idempotent — second call adds nothing", () => {
    const db = makeDb();
    const store = new ToolStore(db);
    store.seed();
    const seededAgain = store.seed();
    expect(seededAgain).toBe(0);
    expect(store.count()).toBe(TOOL_REGISTRY.length);
  });

  it("seed does not overwrite manually updated tools", () => {
    const db = makeDb();
    const store = new ToolStore(db);
    store.seed();
    store.update("gh", { description: "Custom description" });
    store.seed(); // second seed should not reset the description
    expect(store.get("gh")?.description).toBe("Custom description");
  });
});

describe("Tool Profiles", () => {
  it("all profiles have required fields", () => {
    for (const p of TOOL_PROFILES) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.allowedTools.length).toBeGreaterThan(0);
    }
  });

  it("getProfile returns profile by ID", () => {
    const p = getProfile("engineering");
    expect(p).toBeDefined();
    expect(p!.allowedTools).toContain("Bash");
    expect(p!.allowedTools).toContain("Edit");
  });

  it("getProfile returns undefined for unknown ID", () => {
    expect(getProfile("no-such-profile")).toBeUndefined();
  });

  it("infra profile has no Write or Edit (read-only)", () => {
    const p = getProfile("infra");
    expect(p).toBeDefined();
    expect(p!.allowedTools).not.toContain("Write");
    expect(p!.allowedTools).not.toContain("Edit");
  });

  it("profileForAgent returns correct profile for known agent", () => {
    expect(profileForAgent("familiar-engineering")).toBe("engineering");
    expect(profileForAgent("infra-agent")).toBe("infra");
    expect(profileForAgent("greenhouse-pipeline")).toBe("job-hunt");
    expect(profileForAgent("content")).toBe("content");
  });

  it("profileForAgent returns undefined for unknown agent", () => {
    expect(profileForAgent("unknown-agent-xyz")).toBeUndefined();
  });

  it("each agent appears in at most one profile", () => {
    const seen = new Map<string, string>();
    for (const profile of TOOL_PROFILES) {
      for (const agentId of profile.defaultAgents ?? []) {
        if (seen.has(agentId)) {
          throw new Error(`Agent '${agentId}' appears in profiles '${seen.get(agentId)}' and '${profile.id}'`);
        }
        seen.set(agentId, profile.id);
      }
    }
  });
});
