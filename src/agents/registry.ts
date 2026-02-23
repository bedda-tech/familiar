import Database from "better-sqlite3";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-registry");

export interface SubagentRecord {
  id: string;
  task: string;
  label?: string;
  model: string;
  chatId: string;
  status: "running" | "completed" | "failed" | "killed";
  createdAt: string;
  endedAt?: string;
  resultText?: string;
  costUsd?: number;
  durationMs?: number;
}

export class AgentRegistry {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        label TEXT,
        model TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        created_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        result_text TEXT,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0
      );
    `);
  }

  /** Register a new sub-agent run */
  register(record: Pick<SubagentRecord, "id" | "task" | "label" | "model" | "chatId">): void {
    this.db
      .prepare(
        `INSERT INTO subagents (id, task, label, model, chat_id, status)
         VALUES (?, ?, ?, ?, ?, 'running')`,
      )
      .run(record.id, record.task, record.label ?? null, record.model, record.chatId);
    log.info({ id: record.id, model: record.model }, "sub-agent registered");
  }

  /** Mark a sub-agent as completed */
  complete(id: string, resultText: string, costUsd: number, durationMs: number): void {
    this.db
      .prepare(
        `UPDATE subagents SET status = 'completed', ended_at = datetime('now'),
         result_text = ?, cost_usd = ?, duration_ms = ?
         WHERE id = ?`,
      )
      .run(resultText.slice(0, 50000), costUsd, durationMs, id);
  }

  /** Mark a sub-agent as failed */
  fail(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE subagents SET status = 'failed', ended_at = datetime('now'),
         result_text = ? WHERE id = ?`,
      )
      .run(error.slice(0, 10000), id);
  }

  /** Mark a sub-agent as killed */
  kill(id: string): void {
    this.db
      .prepare(
        `UPDATE subagents SET status = 'killed', ended_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);
  }

  /** List active (running) sub-agents */
  listActive(chatId?: string): SubagentRecord[] {
    const query = chatId
      ? `SELECT * FROM subagents WHERE status = 'running' AND chat_id = ? ORDER BY created_at DESC`
      : `SELECT * FROM subagents WHERE status = 'running' ORDER BY created_at DESC`;
    const rows = chatId ? this.db.prepare(query).all(chatId) : this.db.prepare(query).all();
    return (rows as RawRow[]).map(mapRow);
  }

  /** List recent sub-agents (last 20) */
  listRecent(chatId?: string, limit = 20): SubagentRecord[] {
    const query = chatId
      ? `SELECT * FROM subagents WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM subagents ORDER BY created_at DESC LIMIT ?`;
    const rows = chatId
      ? this.db.prepare(query).all(chatId, limit)
      : this.db.prepare(query).all(limit);
    return (rows as RawRow[]).map(mapRow);
  }

  /** Get a specific sub-agent by ID (prefix match) */
  get(idPrefix: string): SubagentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM subagents WHERE id LIKE ? || '%' ORDER BY created_at DESC LIMIT 1`)
      .get(idPrefix) as RawRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Count currently running sub-agents */
  activeCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM subagents WHERE status = 'running'`)
      .get() as { count: number };
    return row.count;
  }
}

interface RawRow {
  id: string;
  task: string;
  label: string | null;
  model: string;
  chat_id: string;
  status: string;
  created_at: string;
  ended_at: string | null;
  result_text: string | null;
  cost_usd: number;
  duration_ms: number;
}

function mapRow(row: RawRow): SubagentRecord {
  return {
    id: row.id,
    task: row.task,
    label: row.label ?? undefined,
    model: row.model,
    chatId: row.chat_id,
    status: row.status as SubagentRecord["status"],
    createdAt: row.created_at,
    endedAt: row.ended_at ?? undefined,
    resultText: row.result_text ?? undefined,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
  };
}
