/**
 * ScheduleStore -- SQLite-backed CRUD for schedule entities.
 *
 * Schedules define when an agent runs and with what prompt.
 * One agent can have multiple schedules.
 */

import type Database from "better-sqlite3";
import type { Schedule, CreateScheduleInput, UpdateScheduleInput } from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("schedule-store");

export class ScheduleStore {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT,
        schedule TEXT NOT NULL,
        timezone TEXT DEFAULT 'UTC',
        prompt TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      );
    `);
  }

  list(filters?: { enabled?: boolean; agent_id?: string }): Schedule[] {
    let sql = "SELECT * FROM schedules WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.enabled !== undefined) {
      sql += " AND enabled = ?";
      params.push(filters.enabled ? 1 : 0);
    }
    if (filters?.agent_id) {
      sql += " AND agent_id = ?";
      params.push(filters.agent_id);
    }

    sql += " ORDER BY name ASC";
    return this.db.prepare(sql).all(...params) as Schedule[];
  }

  get(id: string): Schedule | undefined {
    return this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Schedule | undefined;
  }

  create(input: CreateScheduleInput): Schedule {
    this.db
      .prepare(
        `INSERT INTO schedules (id, agent_id, name, schedule, timezone, prompt, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.agent_id,
        input.name ?? null,
        input.schedule,
        input.timezone ?? "UTC",
        input.prompt,
        input.enabled !== false ? 1 : 0,
      );
    log.info({ id: input.id, agent_id: input.agent_id }, "schedule created");
    return this.get(input.id)!;
  }

  update(id: string, input: UpdateScheduleInput): Schedule | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.agent_id !== undefined) {
      fields.push("agent_id = ?");
      values.push(input.agent_id);
    }
    if (input.name !== undefined) {
      fields.push("name = ?");
      values.push(input.name);
    }
    if (input.schedule !== undefined) {
      fields.push("schedule = ?");
      values.push(input.schedule);
    }
    if (input.timezone !== undefined) {
      fields.push("timezone = ?");
      values.push(input.timezone);
    }
    if (input.prompt !== undefined) {
      fields.push("prompt = ?");
      values.push(input.prompt);
    }
    if (input.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info({ id }, "schedule updated");
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info({ id }, "schedule deleted");
      return true;
    }
    return false;
  }

  listByAgent(agentId: string): Schedule[] {
    return this.list({ agent_id: agentId });
  }

  listEnabled(): Schedule[] {
    return this.list({ enabled: true });
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM schedules").get() as {
      count: number;
    };
    return row.count;
  }
}
