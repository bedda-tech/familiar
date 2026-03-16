/**
 * AgentTemplateStore -- built-in starter agent templates.
 *
 * Agent templates are full agent configurations (model, system_prompt, tools, schedule)
 * that new users can deploy with one click. They live in templates/agents/*.json and are
 * seeded into the agent_templates table on startup.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentCrudStore } from "../agents/agent-store.js";
import type { ScheduleStore } from "../schedules/store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-template-store");

export interface AgentTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string;
  model: string;
  max_turns: number;
  system_prompt: string;
  suggested_schedule: string | null;
  suggested_tools: string; // JSON array stored as string
  is_builtin: number; // 1 = shipped with familiar
  created_at: string;
}

export interface DeployResult {
  agent: Record<string, unknown>;
  schedule: Record<string, unknown>;
}

export class AgentTemplateStore {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL DEFAULT 'utility',
        model TEXT NOT NULL DEFAULT 'sonnet',
        max_turns INTEGER NOT NULL DEFAULT 30,
        system_prompt TEXT NOT NULL DEFAULT '',
        suggested_schedule TEXT,
        suggested_tools TEXT NOT NULL DEFAULT '[]',
        is_builtin INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * Seed built-in templates from JSON files in {templatesDir}/agents/.
   * Idempotent — skips templates that already exist in the DB.
   */
  seed(templatesDir: string): void {
    const agentsDir = join(templatesDir, "agents");
    if (!existsSync(agentsDir)) {
      log.warn({ agentsDir }, "agent templates directory not found, skipping seed");
      return;
    }

    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    let seeded = 0;

    for (const file of files) {
      try {
        const raw = readFileSync(join(agentsDir, file), "utf-8");
        const tmpl = JSON.parse(raw) as Partial<AgentTemplate> & { suggested_tools?: string[] };

        if (!tmpl.id) {
          log.warn({ file }, "agent template missing id, skipping");
          continue;
        }

        const existing = this.get(tmpl.id);
        if (!existing) {
          this.db
            .prepare(
              `INSERT INTO agent_templates
                (id, name, description, category, model, max_turns, system_prompt, suggested_schedule, suggested_tools, is_builtin)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            )
            .run(
              tmpl.id,
              tmpl.name ?? tmpl.id,
              tmpl.description ?? null,
              tmpl.category ?? "utility",
              tmpl.model ?? "sonnet",
              tmpl.max_turns ?? 30,
              tmpl.system_prompt ?? "",
              tmpl.suggested_schedule ?? null,
              JSON.stringify(Array.isArray(tmpl.suggested_tools) ? tmpl.suggested_tools : []),
            );
          seeded++;
        }
      } catch (e) {
        log.warn({ file, error: String(e) }, "failed to seed agent template");
      }
    }

    if (seeded > 0) {
      log.info({ seeded }, "seeded built-in agent templates");
    }
  }

  list(): AgentTemplate[] {
    return this.db
      .prepare("SELECT * FROM agent_templates ORDER BY category ASC, name ASC")
      .all() as AgentTemplate[];
  }

  get(id: string): AgentTemplate | undefined {
    return this.db
      .prepare("SELECT * FROM agent_templates WHERE id = ?")
      .get(id) as AgentTemplate | undefined;
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_templates")
      .get() as { count: number };
    return row.count;
  }

  /**
   * Deploy a template: create an agent + schedule in the DB.
   * Both are created with enabled=false so the user can review and enable them.
   * Throws if the template doesn't exist or if an agent with that id already exists.
   */
  deploy(
    id: string,
    agentStore: AgentCrudStore,
    scheduleStore: ScheduleStore,
  ): DeployResult {
    const tmpl = this.get(id);
    if (!tmpl) throw new Error(`Agent template '${id}' not found`);

    const tools = (() => {
      try {
        return JSON.parse(tmpl.suggested_tools) as string[];
      } catch {
        return [];
      }
    })();

    const agent = agentStore.create({
      id: tmpl.id,
      name: tmpl.name,
      description: tmpl.description ?? undefined,
      model: tmpl.model,
      max_turns: tmpl.max_turns,
      system_prompt: tmpl.system_prompt,
      tools,
      enabled: false,
    });

    const schedule = scheduleStore.create({
      id: `${tmpl.id}-default`,
      agent_id: tmpl.id,
      name: `${tmpl.name} (default)`,
      schedule: tmpl.suggested_schedule ?? "0 */6 * * *",
      timezone: "UTC",
      prompt: "Run your scheduled tasks as described in your system prompt.",
      enabled: false,
    });

    log.info({ id: tmpl.id }, "agent template deployed");
    return {
      agent: agent as unknown as Record<string, unknown>,
      schedule: schedule as unknown as Record<string, unknown>,
    };
  }
}
