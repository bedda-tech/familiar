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
  model_hint: string | null;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  retry_count: number;
  depends_on: string | null; // JSON array of task IDs this task depends on
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assigned_agent?: string;
  priority?: number;
  recurring?: boolean;
  recurrence_schedule?: string;
  tags?: string[];
  model_hint?: string;
  depends_on?: number[]; // task IDs that must complete before this task becomes ready
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
  model_hint?: string | null;
  retry_count?: number;
}

export class TaskStore {
  private updateHandler: ((task: Task) => void) | null = null;

  constructor(private db: Database.Database) {}

  /** Register a callback fired after any task mutation (create/update/claim/complete). */
  onUpdate(handler: (task: Task) => void): void {
    this.updateHandler = handler;
  }

  private notifyUpdate(task: Task): void {
    if (this.updateHandler) this.updateHandler(task);
  }

  list(filters?: { status?: string; assigned_agent?: string; tag?: string; project_id?: string }): Task[] {
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
    if (filters?.project_id) {
      sql += " AND project_id = ?";
      params.push(filters.project_id);
    }

    sql += " ORDER BY priority ASC, created_at ASC";
    return this.db.prepare(sql).all(...params) as Task[];
  }

  get(id: number): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  }

  create(input: CreateTaskInput): Task {
    const dependsOnJson =
      input.depends_on && input.depends_on.length > 0 ? JSON.stringify(input.depends_on) : null;
    const initialStatus = dependsOnJson ? "blocked" : "ready";

    const stmt = this.db.prepare(`
      INSERT INTO tasks (title, description, assigned_agent, status, priority, recurring, recurrence_schedule, tags, model_hint, depends_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.title,
      input.description ?? null,
      input.assigned_agent ?? null,
      initialStatus,
      input.priority ?? 5,
      input.recurring ? 1 : 0,
      input.recurrence_schedule ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.model_hint ?? null,
      dependsOnJson,
    );
    log.info({ id: result.lastInsertRowid, title: input.title, status: initialStatus }, "task created");
    const created = this.get(Number(result.lastInsertRowid))!;
    this.notifyUpdate(created);
    return created;
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
    if (input.model_hint !== undefined) {
      fields.push("model_hint = ?");
      values.push(input.model_hint ?? null);
    }
    if (input.retry_count !== undefined) {
      fields.push("retry_count = ?");
      values.push(input.retry_count);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info({ id }, "task updated");
    const updated = this.get(id);
    if (updated) this.notifyUpdate(updated);
    return updated;
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info({ id }, "task deleted");
      return true;
    }
    return false;
  }

  /** Agent claims the next available task assigned to it (or unassigned).
   *  Returns any in_progress task already claimed by this agent first (continuity). */
  claim(agentId: string): Task | undefined {
    // Continuity: if this agent already has an in_progress task, return it
    const existing = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'in_progress' AND claimed_by = ?
         ORDER BY priority ASC LIMIT 1`,
      )
      .get(agentId) as Task | undefined;
    if (existing) {
      log.info({ taskId: existing.id, agent: agentId }, "returning existing in_progress task");
      return existing;
    }

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
    const claimed = this.get(task.id);
    if (claimed) this.notifyUpdate(claimed);
    return claimed;
  }

  /** Agent marks a task complete with a result. Recurring tasks with a schedule stay completed until the ticker resets them. Recurring tasks without a schedule reset immediately. */
  complete(id: number, result: string): Task | undefined {
    const task = this.get(id);
    if (!task) return undefined;

    if (task.recurring && !task.recurrence_schedule) {
      // No schedule -- reset to ready immediately (legacy behavior)
      // Reset retry_count so each new cycle starts fresh.
      this.db
        .prepare(
          `UPDATE tasks SET status = 'ready', result = ?, last_completed_at = datetime('now'),
           claimed_by = NULL, claimed_at = NULL, retry_count = 0, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(result, id);
      log.info({ id }, "recurring task completed, reset to ready (no schedule)");
    } else {
      // Non-recurring or has recurrence_schedule -- mark completed
      // The recurring ticker will reset scheduled tasks when due.
      // Reset retry_count so the next cycle starts fresh.
      this.db
        .prepare(
          `UPDATE tasks SET status = 'completed', result = ?, last_completed_at = datetime('now'),
           claimed_by = NULL, claimed_at = NULL, retry_count = 0, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(result, id);
      log.info({ id, recurring: !!task.recurring }, "task completed");
    }

    const completed = this.get(id);
    if (completed) this.notifyUpdate(completed);
    // Unblock any tasks that were waiting on this one
    this.unblockDependents(id);
    return completed;
  }

  /** After a task completes, check if any blocked tasks now have all their deps satisfied.
   *  Returns the list of tasks that were unblocked. */
  unblockDependents(completedTaskId: number): Task[] {
    const blockedTasks = this.db
      .prepare(`SELECT * FROM tasks WHERE status = 'blocked' AND depends_on IS NOT NULL`)
      .all() as Task[];

    const unblocked: Task[] = [];
    for (const task of blockedTasks) {
      let deps: number[];
      try {
        deps = JSON.parse(task.depends_on!) as number[];
      } catch {
        continue;
      }
      if (deps.length === 0 || !deps.includes(completedTaskId)) continue;

      // Check if ALL deps are now completed
      const placeholders = deps.map(() => "?").join(", ");
      const completedCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status = 'completed'`,
          )
          .get(...deps) as { c: number }
      ).c;

      if (completedCount === deps.length) {
        this.db
          .prepare(`UPDATE tasks SET status = 'ready', updated_at = datetime('now') WHERE id = ?`)
          .run(task.id);
        log.info({ taskId: task.id, completedTaskId }, "task unblocked");
        const updated = this.get(task.id);
        if (updated) {
          unblocked.push(updated);
          this.notifyUpdate(updated);
        }
      }
    }
    return unblocked;
  }

  /** Enrich tasks with a computed dependency_status field showing how many deps are satisfied. */
  enrichWithDependencyStatus(
    tasks: Task[],
  ): Array<Task & { dependency_status: { total: number; completed: number } | null }> {
    // Collect all dep IDs across all tasks
    const allDepIds = new Set<number>();
    for (const task of tasks) {
      if (!task.depends_on) continue;
      try {
        const ids = JSON.parse(task.depends_on) as number[];
        for (const id of ids) allDepIds.add(id);
      } catch {
        // ignore malformed
      }
    }

    // Batch-fetch which dep IDs are completed
    const completedIds = new Set<number>();
    if (allDepIds.size > 0) {
      const depIdArr = Array.from(allDepIds);
      const placeholders = depIdArr.map(() => "?").join(", ");
      const completedTasks = this.db
        .prepare(
          `SELECT id FROM tasks WHERE id IN (${placeholders}) AND status = 'completed'`,
        )
        .all(...depIdArr) as { id: number }[];
      for (const t of completedTasks) completedIds.add(t.id);
    }

    return tasks.map((task) => {
      if (!task.depends_on) return { ...task, dependency_status: null };
      try {
        const ids = JSON.parse(task.depends_on) as number[];
        if (ids.length === 0) return { ...task, dependency_status: null };
        const completed = ids.filter((id) => completedIds.has(id)).length;
        return { ...task, dependency_status: { total: ids.length, completed } };
      } catch {
        return { ...task, dependency_status: null };
      }
    });
  }

  /** List recurring tasks that are completed and due for reset based on their recurrence_schedule. */
  listRecurringDue(): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE recurring = 1
           AND recurrence_schedule IS NOT NULL
           AND status = 'completed'
         ORDER BY last_completed_at ASC`,
      )
      .all() as Task[];
  }

  /** Get the next task for a specific agent without claiming it.
   *  Returns any in_progress task already claimed by this agent first (continuity),
   *  then falls back to the next ready task. */
  next(agentId: string): Task | undefined {
    // Continuity: if this agent already has an in_progress task, return it first
    const inProgress = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'in_progress' AND claimed_by = ?
         ORDER BY priority ASC LIMIT 1`,
      )
      .get(agentId) as Task | undefined;
    if (inProgress) return inProgress;

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
