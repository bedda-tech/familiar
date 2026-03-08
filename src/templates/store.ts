/**
 * TemplateStore -- SQLite-backed CRUD for prompt templates.
 *
 * Templates are reusable text blocks that can be used as starting points
 * for agent prompts, task descriptions, system prompts, etc.
 */

import type Database from "better-sqlite3";
import type { Template, CreateTemplateInput, UpdateTemplateInput } from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("template-store");

export class TemplateStore {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        description TEXT,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  list(filters?: { category?: string }): Template[] {
    let sql = "SELECT * FROM templates WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.category) {
      sql += " AND category = ?";
      params.push(filters.category);
    }

    sql += " ORDER BY category ASC, name ASC";
    return this.db.prepare(sql).all(...params) as Template[];
  }

  get(id: number): Template | undefined {
    return this.db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Template | undefined;
  }

  create(input: CreateTemplateInput): Template {
    const result = this.db
      .prepare(
        `INSERT INTO templates (name, category, description, content)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.category,
        input.description ?? null,
        input.content,
      );
    log.info({ id: result.lastInsertRowid, name: input.name }, "template created");
    return this.get(Number(result.lastInsertRowid))!;
  }

  update(id: number, input: UpdateTemplateInput): Template | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.name !== undefined) {
      fields.push("name = ?");
      values.push(input.name);
    }
    if (input.category !== undefined) {
      fields.push("category = ?");
      values.push(input.category);
    }
    if (input.description !== undefined) {
      fields.push("description = ?");
      values.push(input.description ?? null);
    }
    if (input.content !== undefined) {
      fields.push("content = ?");
      values.push(input.content);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE templates SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info({ id }, "template updated");
    return this.get(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM templates WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info({ id }, "template deleted");
      return true;
    }
    return false;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM templates").get() as { count: number };
    return row.count;
  }
}
