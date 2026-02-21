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
    `);
  }

  /** Get the session ID for a chat, or null if expired/nonexistent */
  getSession(chatId: string): string | null {
    const row = this.db
      .prepare("SELECT session_id, last_used_at, message_count FROM sessions WHERE chat_id = ?")
      .get(chatId) as { session_id: string; last_used_at: string; message_count: number } | undefined;

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

  /** Store or update session mapping */
  upsertSession(chatId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (chat_id, session_id, message_count)
         VALUES (?, ?, 1)
         ON CONFLICT(chat_id) DO UPDATE SET
           session_id = excluded.session_id,
           last_used_at = datetime('now'),
           message_count = message_count + 1`,
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

  /** Get session info for /status command */
  getSessionInfo(chatId: string): SessionInfo | null {
    const row = this.db
      .prepare("SELECT chat_id, session_id, created_at, last_used_at, message_count FROM sessions WHERE chat_id = ?")
      .get(chatId) as {
        chat_id: string;
        session_id: string;
        created_at: string;
        last_used_at: string;
        message_count: number;
      } | undefined;

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
  logMessage(chatId: string, role: "user" | "assistant", content: string, costUsd: number = 0): void {
    this.db
      .prepare("INSERT INTO message_log (chat_id, role, content, cost_usd) VALUES (?, ?, ?, ?)")
      .run(chatId, role, content.slice(0, 10000), costUsd);
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
