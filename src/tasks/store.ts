/**
 * Task management store — unified task database for agent work assignment.
 *
 * Tasks can be assigned to specific cron agents. When an agent runs, it checks
 * for assigned tasks via the API. Tasks can be one-off or recurring.
 */

import type Database from "better-sqlite3";
import { getLogger } from "../util/logger.js";

const log = getLogger("task-store");

export interface Task {
  id: number;
  title: string;
  description: string | null;
  assigned_agent: string | null;
  status: string;
  priority: number;
  recurring: number;
  recurrence_schedule: string | null;
  last_completed_at: string | null;
  result: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assigned_agent?: string;
  priority?: number;
  recurring?: boolean;
  recurrence_schedule?: string;
  tags?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  assigned_agent?: string | null;
  status?: string;
  priority?: number;
  recurring?: boolean;
  recurrence_schedule?: string;
  tags?: string[];
}

export class TaskStore {
  constructor(private db: Database.Database) {}

  list(filters?: { status?: string; assigned_agent?: string; tag?: string }): Task[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.assigned_agent) {
      sql += " AND assigned_agent = ?";
      params.push(filters.assigned_agent);
    }
    if (filters?.tag) {
      sql += " AND tags LIKE ?";
      params.push(`%"${filters.tag}"%`);
    }

    sql += " ORDER BY priority ASC, created_at ASC";
    return this.db.prepare(sql).all(...params) as Task[];
  }

  get(id: number): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  }

  create(input: CreateTaskInput): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (title, description, assigned_agent, priority, recurring, recurrence_schedule, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.title,
      input.description ?? null,
      input.assigned_agent ?? null,
      input.priority ?? 5,
      input.recurring ? 1 : 0,
      input.recurrence_schedule ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
    );
    log.info({ id: result.lastInsertRowid, title: input.title }, "task created");
    return this.get(Number(result.lastInsertRowid))!;
  }

  update(id: number, input: UpdateTaskInput): Task | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.title !== undefined) {
      fields.push("title = ?");
      values.push(input.title);
    }
    if (input.description !== undefined) {
      fields.push("description = ?");
      values.push(input.description);
    }
    if (input.assigned_agent !== undefined) {
      fields.push("assigned_agent = ?");
      values.push(input.assigned_agent);
    }
    if (input.status !== undefined) {
      fields.push("status = ?");
      values.push(input.status);
    }
    if (input.priority !== undefined) {
      fields.push("priority = ?");
      values.push(input.priority);
    }
    if (input.recurring !== undefined) {
      fields.push("recurring = ?");
      values.push(input.recurring ? 1 : 0);
    }
    if (input.recurrence_schedule !== undefined) {
      fields.push("recurrence_schedule = ?");
      values.push(input.recurrence_schedule);
    }
    if (input.tags !== undefined) {
      fields.push("tags = ?");
      values.push(JSON.stringify(input.tags));
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info({ id }, "task updated");
    return this.get(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info({ id }, "task deleted");
      return true;
    }
    return false;
  }

  /** Agent claims the next available task assigned to it (or unassigned). */
  claim(agentId: string): Task | undefined {
    const task = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'ready'
           AND (assigned_agent = ? OR assigned_agent IS NULL)
         ORDER BY
           CASE WHEN assigned_agent = ? THEN 0 ELSE 1 END,
           priority ASC,
           created_at ASC
         LIMIT 1`,
      )
      .get(agentId, agentId) as Task | undefined;

    if (!task) return undefined;

    this.db
      .prepare(
        `UPDATE tasks SET status = 'in_progress', claimed_by = ?, claimed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(agentId, task.id);

    log.info({ taskId: task.id, agent: agentId }, "task claimed");
    return this.get(task.id);
  }

  /** Agent marks a task complete with a result. Recurring tasks reset to ready. */
  complete(id: number, result: string): Task | undefined {
    const task = this.get(id);
    if (!task) return undefined;

    if (task.recurring) {
      this.db
        .prepare(
          `UPDATE tasks SET status = 'ready', result = ?, last_completed_at = datetime('now'),
           claimed_by = NULL, claimed_at = NULL, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(result, id);
      log.info({ id }, "recurring task completed, reset to ready");
    } else {
      this.db
        .prepare(
          `UPDATE tasks SET status = 'completed', result = ?, last_completed_at = datetime('now'),
           updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(result, id);
      log.info({ id }, "task completed");
    }

    return this.get(id);
  }

  /** Get the next task for a specific agent without claiming it. */
  next(agentId: string): Task | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'ready'
           AND (assigned_agent = ? OR assigned_agent IS NULL)
         ORDER BY
           CASE WHEN assigned_agent = ? THEN 0 ELSE 1 END,
           priority ASC,
           created_at ASC
         LIMIT 1`,
      )
      .get(agentId, agentId) as Task | undefined;
  }
}
