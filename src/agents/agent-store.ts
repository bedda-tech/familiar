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
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  list(filters?: { enabled?: boolean }): Agent[] {
    let sql = "SELECT * FROM agents WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.enabled !== undefined) {
      sql += " AND enabled = ?";
      params.push(filters.enabled ? 1 : 0);
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
        `INSERT INTO agents (id, name, description, model, system_prompt, max_turns, working_directory, tools, announce, suppress_pattern, deliver_to, mcp_config, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
