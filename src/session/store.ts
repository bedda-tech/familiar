import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { parseDuration, getConfigDir } from "../config.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("session-store");

export interface SessionInfo {
  chatId: string;
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
}

export class SessionStore {
  private db: Database.Database;
  private inactivityMs: number;
  private rotateAfterMessages: number;

  constructor(
    inactivityTimeout: string = "24h",
    rotateAfterMessages: number = 200,
    dbPath?: string,
  ) {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });

    const path = dbPath ?? join(dir, "familiar.db");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.inactivityMs = parseDuration(inactivityTimeout);
    this.rotateAfterMessages = rotateAfterMessages;

    this.migrate();
    log.info({ path, inactivityTimeout, rotateAfterMessages }, "session store initialized");
  }

  /** Expose the underlying database for shared use (e.g. sub-agent registry) */
  getDb(): Database.Database {
    return this.db;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        chat_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT DEFAULT (datetime('now')),
        message_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS message_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        cost_usd REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        assigned_agent TEXT,
        status TEXT DEFAULT 'ready',
        priority INTEGER DEFAULT 5,
        recurring INTEGER DEFAULT 0,
        recurrence_schedule TEXT,
        last_completed_at TEXT,
        result TEXT,
        tags TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        claimed_by TEXT,
        claimed_at TEXT
      );
    `);

    // Additive migrations (idempotent)
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN model_hint TEXT");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN depends_on TEXT");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN stale_timeout_hours REAL DEFAULT NULL");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE message_log ADD COLUMN source TEXT");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN in_flight INTEGER DEFAULT 0");
    } catch {
      // Column already exists
    }

    // Content marketing queue
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL DEFAULT 'krain',
        platform TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'post',
        pillar TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        scheduled_for TEXT,
        posted_at TEXT,
        post_url TEXT,
        drafted_by TEXT,
        reviewed_by TEXT,
        review_note TEXT,
        narrative_context TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  /** Get the session ID for a chat, or null if expired/nonexistent */
  getSession(chatId: string): string | null {
    const row = this.db
      .prepare("SELECT session_id, last_used_at, message_count FROM sessions WHERE chat_id = ?")
      .get(chatId) as
      | { session_id: string; last_used_at: string; message_count: number }
      | undefined;

    if (!row) return null;

    // Check inactivity timeout
    const lastUsed = new Date(row.last_used_at + "Z").getTime();
    const now = Date.now();
    if (now - lastUsed > this.inactivityMs) {
      log.info({ chatId, lastUsed: row.last_used_at }, "session expired due to inactivity");
      return null;
    }

    // Check message count rotation
    if (this.rotateAfterMessages > 0 && row.message_count >= this.rotateAfterMessages) {
      log.info({ chatId, messageCount: row.message_count }, "session rotated due to message count");
      return null;
    }

    return row.session_id;
  }

  /** Store or update session mapping. Resets message_count on a new session_id
   *  so rotation-by-count actually rotates instead of being stuck above the threshold. */
  upsertSession(chatId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (chat_id, session_id, message_count, created_at, last_used_at)
         VALUES (?, ?, 1, datetime('now'), datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET
           session_id = excluded.session_id,
           created_at = CASE WHEN sessions.session_id = excluded.session_id THEN sessions.created_at ELSE datetime('now') END,
           last_used_at = datetime('now'),
           message_count = CASE WHEN sessions.session_id = excluded.session_id THEN sessions.message_count + 1 ELSE 1 END`,
      )
      .run(chatId, sessionId);
  }

  /** Touch session (update last_used_at and increment count) without changing session_id */
  touchSession(chatId: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET last_used_at = datetime('now'), message_count = message_count + 1
         WHERE chat_id = ?`,
      )
      .run(chatId);
  }

  /** Clear session for a chat (used by /new command) */
  clearSession(chatId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
    log.info({ chatId }, "session cleared");
  }

  /** Mark a session as actively processing a message (in_flight=1) or done (in_flight=0). */
  setInFlight(chatId: string, active: boolean): void {
    this.db
      .prepare("UPDATE sessions SET in_flight = ? WHERE chat_id = ?")
      .run(active ? 1 : 0, chatId);
  }

  /** Return sessions that were mid-flight when the process last exited (restart detection). */
  getInterruptedSessions(): Array<{ chatId: string; sessionId: string }> {
    const rows = this.db
      .prepare("SELECT chat_id, session_id FROM sessions WHERE in_flight = 1")
      .all() as Array<{ chat_id: string; session_id: string }>;
    return rows.map((r) => ({ chatId: r.chat_id, sessionId: r.session_id }));
  }

  /** List all sessions ordered by most-recently-used */
  listSessions(): SessionInfo[] {
    const rows = this.db
      .prepare(
        "SELECT chat_id, session_id, created_at, last_used_at, message_count FROM sessions ORDER BY last_used_at DESC",
      )
      .all() as Array<{
      chat_id: string;
      session_id: string;
      created_at: string;
      last_used_at: string;
      message_count: number;
    }>;

    return rows.map((r) => ({
      chatId: r.chat_id,
      sessionId: r.session_id,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      messageCount: r.message_count,
    }));
  }

  /** Get session info for /status command */
  getSessionInfo(chatId: string): SessionInfo | null {
    const row = this.db
      .prepare(
        "SELECT chat_id, session_id, created_at, last_used_at, message_count FROM sessions WHERE chat_id = ?",
      )
      .get(chatId) as
      | {
          chat_id: string;
          session_id: string;
          created_at: string;
          last_used_at: string;
          message_count: number;
        }
      | undefined;

    if (!row) return null;
    return {
      chatId: row.chat_id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      messageCount: row.message_count,
    };
  }

  /** Log a message for usage tracking */
  logMessage(
    chatId: string,
    role: "user" | "assistant",
    content: string,
    costUsd: number = 0,
    source?: string,
  ): void {
    this.db
      .prepare("INSERT INTO message_log (chat_id, role, content, cost_usd, source) VALUES (?, ?, ?, ?, ?)")
      .run(chatId, role, content.slice(0, 10000), costUsd, source ?? null);
  }

  /** Get messages for a chat, ordered newest-first, with optional cursor-based pagination */
  getMessages(chatId: string, limit: number, before?: string): MessageRecord[] {
    if (before) {
      return this.db
        .prepare(
          `SELECT id, chat_id, role, content, cost_usd, created_at
           FROM message_log
           WHERE chat_id = ? AND created_at < ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(chatId, before, limit) as MessageRecord[];
    }
    return this.db
      .prepare(
        `SELECT id, chat_id, role, content, cost_usd, created_at
         FROM message_log
         WHERE chat_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(chatId, limit) as MessageRecord[];
  }

  /** Get total message count for a chat */
  getMessageCount(chatId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM message_log WHERE chat_id = ?")
      .get(chatId) as { count: number };
    return row.count;
  }

  /** Get cost summary for a chat */
  getCostSummary(chatId: string): CostSummary {
    const sessionCost = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as count
         FROM message_log WHERE chat_id = ? AND role = 'assistant'
         AND created_at >= (SELECT COALESCE(created_at, '1970-01-01') FROM sessions WHERE chat_id = ?)`,
      )
      .get(chatId, chatId) as { total: number; count: number };

    const todayCost = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as count
         FROM message_log WHERE chat_id = ? AND role = 'assistant'
         AND created_at >= date('now')`,
      )
      .get(chatId) as { total: number; count: number };

    const allTimeCost = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as count
         FROM message_log WHERE chat_id = ? AND role = 'assistant'`,
      )
      .get(chatId) as { total: number; count: number };

    const last24h = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total
         FROM message_log WHERE chat_id = ? AND role = 'assistant'
         AND created_at >= datetime('now', '-1 day')`,
      )
      .get(chatId) as { total: number };

    return {
      session: { cost: sessionCost.total, messages: sessionCost.count },
      today: { cost: todayCost.total, messages: todayCost.count },
      last24h: last24h.total,
      allTime: { cost: allTimeCost.total, messages: allTimeCost.count },
    };
  }

  close(): void {
    this.db.close();
  }
}

export interface CostSummary {
  session: { cost: number; messages: number };
  today: { cost: number; messages: number };
  last24h: number;
  allTime: { cost: number; messages: number };
}

export interface MessageRecord {
  id: number;
  chat_id: string;
  role: string;
  content: string;
  cost_usd: number;
  created_at: string;
}
