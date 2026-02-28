/**
 * ProjectStore -- SQLite-backed CRUD for project entities.
 *
 * Projects are context containers that link agents, tasks, and documentation.
 */

import type Database from "better-sqlite3";
import type { Project, CreateProjectInput, UpdateProjectInput } from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("project-store");

export class ProjectStore {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        path TEXT,
        context_file TEXT,
        tags TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  list(filters?: { enabled?: boolean }): Project[] {
    let sql = "SELECT * FROM projects WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.enabled !== undefined) {
      sql += " AND enabled = ?";
      params.push(filters.enabled ? 1 : 0);
    }

    sql += " ORDER BY name ASC";
    return this.db.prepare(sql).all(...params) as Project[];
  }

  get(id: string): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
  }

  create(input: CreateProjectInput): Project {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, path, context_file, tags, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.description ?? null,
        input.path ?? null,
        input.context_file ?? null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.enabled !== false ? 1 : 0,
      );
    log.info({ id: input.id, name: input.name }, "project created");
    return this.get(input.id)!;
  }

  update(id: string, input: UpdateProjectInput): Project | undefined {
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
    if (input.path !== undefined) {
      fields.push("path = ?");
      values.push(input.path);
    }
    if (input.context_file !== undefined) {
      fields.push("context_file = ?");
      values.push(input.context_file);
    }
    if (input.tags !== undefined) {
      fields.push("tags = ?");
      values.push(JSON.stringify(input.tags));
    }
    if (input.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info({ id }, "project updated");
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info({ id }, "project deleted");
      return true;
    }
    return false;
  }

  listEnabled(): Project[] {
    return this.list({ enabled: true });
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM projects").get() as {
      count: number;
    };
    return row.count;
  }
}
