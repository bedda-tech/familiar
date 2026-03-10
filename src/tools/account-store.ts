/**
 * ToolAccountStore -- SQLite-backed CRUD for tool account credentials.
 *
 * Each tool can have multiple accounts (e.g. "bird" tool with beddaai/beddatech/personal accounts).
 * Credentials are stored as JSON. They are never logged.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ToolAccount, CreateToolAccountInput, UpdateToolAccountInput } from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("tool-account-store");

export class ToolAccountStore {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_accounts (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL REFERENCES tools(id),
        account_name TEXT NOT NULL,
        credentials TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        project_id TEXT REFERENCES projects(id),
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  list(toolId?: string): ToolAccount[] {
    if (toolId) {
      return this.db
        .prepare("SELECT * FROM tool_accounts WHERE tool_id = ? ORDER BY is_default DESC, account_name ASC")
        .all(toolId) as ToolAccount[];
    }
    return this.db
      .prepare("SELECT * FROM tool_accounts ORDER BY tool_id ASC, is_default DESC, account_name ASC")
      .all() as ToolAccount[];
  }

  get(id: string): ToolAccount | undefined {
    return this.db.prepare("SELECT * FROM tool_accounts WHERE id = ?").get(id) as ToolAccount | undefined;
  }

  create(input: CreateToolAccountInput): ToolAccount {
    const id = input.id ?? randomUUID();

    // If this account is being set as default, clear existing default for this tool
    if (input.is_default) {
      this.db
        .prepare("UPDATE tool_accounts SET is_default = 0 WHERE tool_id = ?")
        .run(input.tool_id);
    }

    this.db
      .prepare(
        `INSERT INTO tool_accounts (id, tool_id, account_name, credentials, is_default, project_id, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tool_id,
        input.account_name,
        JSON.stringify(input.credentials),
        input.is_default ? 1 : 0,
        input.project_id ?? null,
        input.enabled !== false ? 1 : 0,
      );

    log.info({ id, tool_id: input.tool_id, account_name: input.account_name }, "tool account created");
    return this.get(id)!;
  }

  update(id: string, input: UpdateToolAccountInput): ToolAccount | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    // If setting as default, clear others for same tool
    if (input.is_default) {
      this.db
        .prepare("UPDATE tool_accounts SET is_default = 0 WHERE tool_id = ?")
        .run(existing.tool_id);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.account_name !== undefined) {
      fields.push("account_name = ?");
      values.push(input.account_name);
    }
    if (input.credentials !== undefined) {
      fields.push("credentials = ?");
      values.push(JSON.stringify(input.credentials));
    }
    if (input.is_default !== undefined) {
      fields.push("is_default = ?");
      values.push(input.is_default ? 1 : 0);
    }
    if (input.project_id !== undefined) {
      fields.push("project_id = ?");
      values.push(input.project_id);
    }
    if (input.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE tool_accounts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info({ id }, "tool account updated");
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tool_accounts WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info({ id }, "tool account deleted");
      return true;
    }
    return false;
  }

  deleteByTool(toolId: string): number {
    const result = this.db.prepare("DELETE FROM tool_accounts WHERE tool_id = ?").run(toolId);
    return result.changes;
  }

  /** Return accounts with credentials masked (value replaced with "****"). */
  listMasked(toolId?: string): (Omit<ToolAccount, "credentials"> & { credentials: string })[] {
    const accounts = this.list(toolId);
    return accounts.map((a) => ({
      ...a,
      credentials: maskCredentials(a.credentials),
    }));
  }

  getMasked(id: string): (Omit<ToolAccount, "credentials"> & { credentials: string }) | undefined {
    const a = this.get(id);
    if (!a) return undefined;
    return { ...a, credentials: maskCredentials(a.credentials) };
  }

  countByTool(toolId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM tool_accounts WHERE tool_id = ?")
      .get(toolId) as { count: number };
    return row.count;
  }
}

function maskCredentials(credentialsJson: string): string {
  try {
    const obj = JSON.parse(credentialsJson) as Record<string, unknown>;
    const masked: Record<string, string> = {};
    for (const key of Object.keys(obj)) {
      masked[key] = "****";
    }
    return JSON.stringify(masked);
  } catch {
    return "****";
  }
}
