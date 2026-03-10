/**
 * AgentCrudStore -- SQLite-backed CRUD for persistent agent entities.
 *
 * This is separate from the existing AgentStore/AgentManager which handles
 * ephemeral chat-spawned sub-agents. This store manages the persistent
 * agent identities used by the scheduler.
 */

import type Database from "better-sqlite3";
import type { Agent, CreateAgentInput, UpdateAgentInput } from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-crud-store");

export class AgentCrudStore {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        model TEXT DEFAULT 'sonnet',
        system_prompt TEXT,
        max_turns INTEGER DEFAULT 25,
        working_directory TEXT,
        tools TEXT,
        announce INTEGER DEFAULT 1,
        suppress_pattern TEXT,
        deliver_to TEXT,
        mcp_config TEXT,
        enabled INTEGER DEFAULT 1,
        daily_budget_usd REAL DEFAULT NULL,
        worktree_isolation INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Additive migrations: add columns if missing (existing DBs)
    const cols = (
      this.db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.includes("daily_budget_usd")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN daily_budget_usd REAL DEFAULT NULL");
    }
    if (!cols.includes("validation_command")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN validation_command TEXT DEFAULT NULL");
    }
    if (!cols.includes("worktree_isolation")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN worktree_isolation INTEGER DEFAULT 0");
    }
    if (!cols.includes("pre_hook")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN pre_hook TEXT DEFAULT NULL");
    }
    if (!cols.includes("post_hook")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN post_hook TEXT DEFAULT NULL");
    }
    if (!cols.includes("project_id")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN project_id TEXT REFERENCES projects(id)");
      // Backfill known agents with their project IDs
      this.db.exec(`
        UPDATE agents SET project_id = 'nozio'    WHERE project_id IS NULL AND id = 'nozio-engineering';
        UPDATE agents SET project_id = 'bedda-ai'  WHERE project_id IS NULL AND id = 'bedda-ai-engineering';
        UPDATE agents SET project_id = 'marketing' WHERE project_id IS NULL AND id = 'bedda-marketing-engineering';
        UPDATE agents SET project_id = 'omnivi'    WHERE project_id IS NULL AND id = 'omnivi-engineering';
        UPDATE agents SET project_id = 'axon'      WHERE project_id IS NULL AND id = 'axon-engineering';
        UPDATE agents SET project_id = 'familiar'  WHERE project_id IS NULL AND id IN ('familiar-engineering','heartbeat','infra-agent','cron-doctor');
        UPDATE agents SET project_id = 'crowdia'   WHERE project_id IS NULL AND id LIKE 'crowdia-%';
        UPDATE agents SET project_id = 'job-hunt'  WHERE project_id IS NULL AND id IN ('greenhouse','lever','ashby','linkedin');
        UPDATE agents SET project_id = 'job-hunt'  WHERE project_id IS NULL AND id LIKE 'job-%';
      `);
    }
  }

  list(filters?: { enabled?: boolean; project_id?: string }): Agent[] {
    let sql = "SELECT * FROM agents WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.enabled !== undefined) {
      sql += " AND enabled = ?";
      params.push(filters.enabled ? 1 : 0);
    }
    if (filters?.project_id) {
      sql += " AND project_id = ?";
      params.push(filters.project_id);
    }

    sql += " ORDER BY name ASC";
    return this.db.prepare(sql).all(...params) as Agent[];
  }

  get(id: string): Agent | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
  }

  create(input: CreateAgentInput): Agent {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, model, system_prompt, max_turns, working_directory, tools, announce, suppress_pattern, deliver_to, mcp_config, enabled, daily_budget_usd, validation_command, worktree_isolation, pre_hook, post_hook, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.description ?? null,
        input.model ?? "sonnet",
        input.system_prompt ?? null,
        input.max_turns ?? 25,
        input.working_directory ?? null,
        input.tools ? JSON.stringify(input.tools) : null,
        input.announce !== false ? 1 : 0,
        input.suppress_pattern ?? null,
        input.deliver_to ?? null,
        input.mcp_config ?? null,
        input.enabled !== false ? 1 : 0,
        input.daily_budget_usd ?? null,
        input.validation_command ?? null,
        input.worktree_isolation ? 1 : 0,
        input.pre_hook ?? null,
        input.post_hook ?? null,
        input.project_id ?? null,
      );
    log.info({ id: input.id, name: input.name }, "agent created");
    return this.get(input.id)!;
  }

  update(id: string, input: UpdateAgentInput): Agent | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.name !== undefined) {
      fields.push("name = ?");
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push("description = ?");
      values.push(input.description);
    }
    if (input.model !== undefined) {
      fields.push("model = ?");
      values.push(input.model);
    }
    if (input.system_prompt !== undefined) {
      fields.push("system_prompt = ?");
      values.push(input.system_prompt);
    }
    if (input.max_turns !== undefined) {
      fields.push("max_turns = ?");
      values.push(input.max_turns);
    }
    if (input.working_directory !== undefined) {
      fields.push("working_directory = ?");
      values.push(input.working_directory);
    }
    if (input.tools !== undefined) {
      fields.push("tools = ?");
      values.push(JSON.stringify(input.tools));
    }
    if (input.announce !== undefined) {
      fields.push("announce = ?");
      values.push(input.announce ? 1 : 0);
    }
    if (input.suppress_pattern !== undefined) {
      fields.push("suppress_pattern = ?");
      values.push(input.suppress_pattern);
    }
    if (input.deliver_to !== undefined) {
      fields.push("deliver_to = ?");
      values.push(input.deliver_to);
    }
    if (input.mcp_config !== undefined) {
      fields.push("mcp_config = ?");
      values.push(input.mcp_config);
    }
    if (input.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }
    if ("daily_budget_usd" in input) {
      fields.push("daily_budget_usd = ?");
      values.push(input.daily_budget_usd ?? null);
    }
    if ("validation_command" in input) {
      fields.push("validation_command = ?");
      values.push(input.validation_command ?? null);
    }
    if (input.worktree_isolation !== undefined) {
      fields.push("worktree_isolation = ?");
      values.push(input.worktree_isolation ? 1 : 0);
    }
    if ("pre_hook" in input) {
      fields.push("pre_hook = ?");
      values.push(input.pre_hook ?? null);
    }
    if ("post_hook" in input) {
      fields.push("post_hook = ?");
      values.push(input.post_hook ?? null);
    }
    if ("project_id" in input) {
      fields.push("project_id = ?");
      values.push(input.project_id ?? null);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info({ id }, "agent updated");
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info({ id }, "agent deleted");
      return true;
    }
    return false;
  }

  listEnabled(): Agent[] {
    return this.list({ enabled: true });
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM agents").get() as { count: number };
    return row.count;
  }
}
