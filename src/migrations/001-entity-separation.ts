/**
 * Migration 001: Entity Separation
 *
 * Creates agents, schedules, projects, and tools tables.
 * Migrates config.json cron jobs into agent + schedule DB rows.
 * Seeds projects from ~/.familiar/projects/*.md files.
 * Seeds builtin tools.
 *
 * Idempotent -- safe to run multiple times.
 * Can be run standalone: npx tsx src/migrations/001-entity-separation.ts
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "../util/logger.js";

const log = getLogger("migration-001");

export interface MigrationResult {
  agents: number;
  schedules: number;
  projects: number;
  tools: number;
  skipped: boolean;
}

export function runMigration(db: Database.Database, configPath?: string): MigrationResult {
  const result: MigrationResult = { agents: 0, schedules: 0, projects: 0, tools: 0, skipped: false };

  // Create tables (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      model TEXT DEFAULT 'sonnet',
      system_prompt TEXT,
      max_turns INTEGER DEFAULT 25,
      working_directory TEXT,
      tools TEXT,
      announce INTEGER DEFAULT 1,
      suppress_pattern TEXT,
      deliver_to TEXT,
      mcp_config TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

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

    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'builtin',
      description TEXT,
      config TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      agent_id TEXT,
      schedule_id TEXT,
      task_id INTEGER,
      summary TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add project_id to tasks if not exists
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT");
  } catch {
    // Column already exists
  }

  // Check if migration has already populated data
  const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as { c: number }).c;
  if (agentCount > 0) {
    log.info("agents table already populated, skipping config migration");
    result.skipped = true;
    // Still seed tools and projects if missing
    result.tools = seedBuiltinTools(db);
    result.projects = seedProjects(db);
    return result;
  }

  // Migrate cron jobs from config.json
  const cfgPath = configPath ?? join(homedir(), ".familiar", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const config = JSON.parse(readFileSync(cfgPath, "utf-8"));
      const jobs = config?.cron?.jobs ?? [];

      const insertAgent = db.prepare(
        `INSERT OR IGNORE INTO agents (id, name, description, model, system_prompt, max_turns, working_directory, tools, announce, suppress_pattern, deliver_to, mcp_config, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const insertSchedule = db.prepare(
        `INSERT OR IGNORE INTO schedules (id, agent_id, name, schedule, timezone, prompt, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const job of jobs) {
        // Extract agent identity
        const agentId = job.id;
        const agentName = job.label || job.id;

        insertAgent.run(
          agentId,
          agentName,
          null, // description
          job.model ?? "sonnet",
          job.systemPrompt ?? null,
          job.maxTurns ?? 25,
          job.workingDirectory ?? null,
          null, // tools -- inherit from defaults
          job.announce !== false ? 1 : 0,
          job.suppressPattern ?? null,
          job.deliverTo ?? null,
          null, // mcpConfig
          job.enabled !== false ? 1 : 0,
        );
        result.agents++;

        // Extract schedule
        const scheduleId = `${agentId}-default`;
        insertSchedule.run(
          scheduleId,
          agentId,
          `${agentName} schedule`,
          job.schedule,
          job.timezone ?? "UTC",
          job.prompt,
          job.enabled !== false ? 1 : 0,
        );
        result.schedules++;
      }

      log.info(
        { agents: result.agents, schedules: result.schedules },
        "migrated cron jobs to agents + schedules",
      );
    } catch (e) {
      log.error({ err: e, path: cfgPath }, "failed to read config for migration");
    }
  }

  // Seed tools and projects
  result.tools = seedBuiltinTools(db);
  result.projects = seedProjects(db);

  return result;
}

function seedBuiltinTools(db: Database.Database): number {
  const toolCount = (db.prepare("SELECT COUNT(*) as c FROM tools").get() as { c: number }).c;
  if (toolCount > 0) return 0;

  const builtins = [
    { id: "bash", name: "Bash", description: "Execute shell commands" },
    { id: "read", name: "Read", description: "Read file contents" },
    { id: "write", name: "Write", description: "Write file contents" },
    { id: "edit", name: "Edit", description: "Edit files with string replacement" },
    { id: "glob", name: "Glob", description: "Find files by pattern" },
    { id: "grep", name: "Grep", description: "Search file contents" },
    { id: "web-fetch", name: "WebFetch", description: "Fetch and analyze web content" },
    { id: "web-search", name: "WebSearch", description: "Search the web" },
  ];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO tools (id, name, type, description, enabled) VALUES (?, ?, 'builtin', ?, 1)`,
  );

  let count = 0;
  for (const tool of builtins) {
    const r = insert.run(tool.id, tool.name, tool.description);
    if (r.changes > 0) count++;
  }

  log.info({ count }, "seeded builtin tools");
  return count;
}

function seedProjects(db: Database.Database): number {
  const projectCount = (db.prepare("SELECT COUNT(*) as c FROM projects").get() as { c: number }).c;
  if (projectCount > 0) return 0;

  const projectsDir = join(homedir(), ".familiar", "projects");
  if (!existsSync(projectsDir)) return 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, description, context_file, enabled) VALUES (?, ?, ?, ?, 1)`,
  );

  let count = 0;
  try {
    const files = readdirSync(projectsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const id = basename(file, ".md");
      const filePath = join(projectsDir, file);
      const content = readFileSync(filePath, "utf-8");

      // Extract first heading or first line as description
      const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? id;
      const description = firstLine.replace(/^#+\s*/, "").trim();

      const r = insert.run(id, id, description, filePath);
      if (r.changes > 0) count++;
    }
  } catch (e) {
    log.warn({ err: e }, "failed to seed projects from files");
  }

  if (count > 0) log.info({ count }, "seeded projects from context files");
  return count;
}

// Standalone execution
if (process.argv[1]?.endsWith("001-entity-separation.ts") || process.argv[1]?.endsWith("001-entity-separation.js")) {
  const configDir = join(homedir(), ".familiar");
  const dbPath = join(configDir, "familiar.db");

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run 'familiar start' first.`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const result = runMigration(db);
  db.close();

  console.log("Migration complete:");
  console.log(`  Agents: ${result.agents}`);
  console.log(`  Schedules: ${result.schedules}`);
  console.log(`  Projects: ${result.projects}`);
  console.log(`  Tools: ${result.tools}`);
  if (result.skipped) {
    console.log("  (Config migration skipped -- agents table already populated)");
  }
}
