/**
 * ToolStore -- SQLite-backed CRUD for tool entities.
 *
 * Tools represent capabilities available to agents (builtin, CLI, MCP, script).
 */

import type Database from "better-sqlite3";
import type { Tool, CreateToolInput, UpdateToolInput } from "./types.js";
import { TOOL_REGISTRY } from "./registry.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("tool-store");

export class ToolStore {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'builtin',
        description TEXT,
        config TEXT,
        cli_command TEXT,
        binary_path TEXT,
        version TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Add new columns to existing tables (idempotent via try/catch)
    for (const col of [
      "ALTER TABLE tools ADD COLUMN cli_command TEXT",
      "ALTER TABLE tools ADD COLUMN binary_path TEXT",
      "ALTER TABLE tools ADD COLUMN version TEXT",
    ]) {
      try {
        this.db.exec(col);
      } catch {
        // column already exists
      }
    }
  }

  list(filters?: { enabled?: boolean; type?: string }): Tool[] {
    let sql = "SELECT * FROM tools WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.enabled !== undefined) {
      sql += " AND enabled = ?";
      params.push(filters.enabled ? 1 : 0);
    }
    if (filters?.type) {
      sql += " AND type = ?";
      params.push(filters.type);
    }

    sql += " ORDER BY name ASC";
    return this.db.prepare(sql).all(...params) as Tool[];
  }

  get(id: string): Tool | undefined {
    return this.db.prepare("SELECT * FROM tools WHERE id = ?").get(id) as Tool | undefined;
  }

  create(input: CreateToolInput): Tool {
    this.db
      .prepare(
        `INSERT INTO tools (id, name, type, description, config, cli_command, binary_path, version, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.type,
        input.description ?? null,
        input.config ? JSON.stringify(input.config) : null,
        input.cli_command ?? null,
        input.binary_path ?? null,
        input.version ?? null,
        input.enabled !== false ? 1 : 0,
      );
    log.info({ id: input.id, name: input.name }, "tool created");
    return this.get(input.id)!;
  }

  update(id: string, input: UpdateToolInput): Tool | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.name !== undefined) {
      fields.push("name = ?");
      values.push(input.name);
    }
    if (input.type !== undefined) {
      fields.push("type = ?");
      values.push(input.type);
    }
    if (input.description !== undefined) {
      fields.push("description = ?");
      values.push(input.description);
    }
    if (input.config !== undefined) {
      fields.push("config = ?");
      values.push(input.config ? JSON.stringify(input.config) : null);
    }
    if (input.cli_command !== undefined) {
      fields.push("cli_command = ?");
      values.push(input.cli_command);
    }
    if (input.binary_path !== undefined) {
      fields.push("binary_path = ?");
      values.push(input.binary_path);
    }
    if (input.version !== undefined) {
      fields.push("version = ?");
      values.push(input.version);
    }
    if (input.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE tools SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info({ id }, "tool updated");
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tools WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info({ id }, "tool deleted");
      return true;
    }
    return false;
  }

  listByType(type: string): Tool[] {
    return this.list({ type });
  }

  listEnabled(): Tool[] {
    return this.list({ enabled: true });
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM tools").get() as { count: number };
    return row.count;
  }

  /**
   * Seed the tools table from the built-in registry.
   * Skips entries that already exist (INSERT OR IGNORE).
   * Call once at startup to ensure the registry is populated.
   */
  seed(): number {
    let seeded = 0;
    for (const entry of TOOL_REGISTRY) {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO tools (id, name, type, description, config, cli_command, binary_path, version, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.name,
          entry.type,
          entry.description ?? null,
          entry.config ? JSON.stringify(entry.config) : null,
          entry.cli_command ?? null,
          entry.binary_path ?? null,
          entry.version ?? null,
          entry.enabled !== false ? 1 : 0,
        );
      if (result.changes > 0) seeded++;
    }
    if (seeded > 0) {
      log.info({ seeded }, "tool registry seeded");
    }
    return seeded;
  }
}
