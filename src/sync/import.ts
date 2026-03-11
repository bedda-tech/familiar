/**
 * Import -- reads YAML files from the persona repo and upserts into the DB.
 *
 * Usage:
 *   familiar sync --from /path/to/persona
 *   familiar init --persona /path/to/persona
 *
 * Handles: agents, schedules, tools, projects, templates.
 * Preserves runtime state (cron_runs, cron_state, activity_log are NOT touched).
 *
 * Projects can be in two formats:
 *   1. Per-project folders: projects/{id}/project.yaml (preferred)
 *   2. Flat file: projects/projects.yaml (legacy fallback)
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parse } from "yaml";
import type Database from "better-sqlite3";
import type { AgentCrudStore } from "../agents/agent-store.js";
import type { ScheduleStore } from "../schedules/store.js";
import type { ToolStore } from "../tools/store.js";
import type { ProjectStore } from "../projects/store.js";
import type { TemplateStore } from "../templates/store.js";
import type { RepoManager } from "../projects/repo-manager.js";
import type {
  AgentWithScheduleYaml,
  ScheduleYaml,
  ToolYaml,
  ProjectYaml,
  TemplateYaml,
  SyncResult,
} from "./types.js";

export interface ImportOptions {
  personaPath: string;
  db: Database.Database;
  agentStore: AgentCrudStore;
  scheduleStore: ScheduleStore;
  toolStore: ToolStore;
  projectStore: ProjectStore;
  templateStore: TemplateStore;
  repoManager?: RepoManager;
  cloneRepos?: boolean;
}

/** Read all YAML files from a directory (non-recursive). */
function readYamlDir<T>(dirPath: string): T[] {
  if (!existsSync(dirPath)) return [];

  const results: T[] = [];
  const files = readdirSync(dirPath).filter(
    (f) => extname(f) === ".yaml" || extname(f) === ".yml",
  );

  for (const file of files) {
    const content = readFileSync(join(dirPath, file), "utf-8");
    const parsed = parse(content);
    if (Array.isArray(parsed)) {
      results.push(...(parsed as T[]));
    } else if (parsed && typeof parsed === "object") {
      results.push(parsed as T);
    }
  }

  return results;
}

/** Scan projects/ for subdirectories containing project.yaml (per-project folder format). */
function readProjectFolders(projectsDir: string): ProjectYaml[] {
  if (!existsSync(projectsDir)) return [];

  const results: ProjectYaml[] = [];
  const entries = readdirSync(projectsDir);

  for (const entry of entries) {
    const entryPath = join(projectsDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    const projectYamlPath = join(entryPath, "project.yaml");
    if (!existsSync(projectYamlPath)) continue;

    const content = readFileSync(projectYamlPath, "utf-8");
    const parsed = parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      results.push(parsed as ProjectYaml);
    }
  }

  return results;
}

/** Import persona repo YAML files into the DB. */
export async function importFromPersona(opts: ImportOptions): Promise<SyncResult> {
  const { personaPath, agentStore, scheduleStore, toolStore, projectStore, templateStore } = opts;

  const result: SyncResult = {
    agents: { created: 0, updated: 0, total: 0 },
    schedules: { created: 0, updated: 0, total: 0 },
    tools: { created: 0, updated: 0, total: 0 },
    projects: { created: 0, updated: 0, total: 0 },
    templates: { created: 0, updated: 0, total: 0 },
  };

  // Import projects first (agents may reference them)
  // Try per-project folders first, fall back to flat file
  const projectsDir = join(personaPath, "projects");
  let projects = readProjectFolders(projectsDir);
  if (projects.length === 0) {
    // Fallback: read flat projects.yaml
    projects = readYamlDir<ProjectYaml>(projectsDir);
  }

  for (const p of projects) {
    const existing = projectStore.get(p.id);
    if (existing) {
      projectStore.update(p.id, {
        name: p.name,
        description: p.description,
        path: p.path,
        context_file: p.context_file,
        tags: p.tags,
        enabled: p.enabled,
        status: p.status,
        priority: p.priority,
        repos: p.repos,
        issue_tracking: p.issue_tracking,
        env_refs: p.env_refs,
      });
      result.projects.updated++;
    } else {
      projectStore.create({
        id: p.id,
        name: p.name,
        description: p.description,
        path: p.path,
        context_file: p.context_file,
        tags: p.tags,
        enabled: p.enabled,
        status: p.status,
        priority: p.priority,
        repos: p.repos,
        issue_tracking: p.issue_tracking,
        env_refs: p.env_refs,
      });
      result.projects.created++;
    }
    result.projects.total++;
  }

  // Clone repos if requested
  if (opts.cloneRepos && opts.repoManager) {
    for (const p of projects) {
      if (p.repos && p.repos.length > 0) {
        const cloneResults = await opts.repoManager.ensureRepos(p.id, p.repos);
        const succeeded = cloneResults.filter((r) => r.success).length;
        const failed = cloneResults.filter((r) => !r.success).length;
        if (failed > 0) {
          console.warn(`  Project ${p.id}: cloned ${succeeded}/${cloneResults.length} repos (${failed} failed)`);
        }
      }
    }
  }

  // Import agents (with inline schedules)
  const agentYamls = readYamlDir<AgentWithScheduleYaml>(join(personaPath, "agents"));
  for (const a of agentYamls) {
    const existing = agentStore.get(a.id);
    if (existing) {
      agentStore.update(a.id, {
        name: a.name,
        description: a.description,
        model: a.model,
        system_prompt: a.system_prompt,
        max_turns: a.max_turns,
        working_directory: a.working_directory,
        tools: a.tools,
        announce: a.announce,
        suppress_pattern: a.suppress_pattern,
        deliver_to: a.deliver_to,
        mcp_config: a.mcp_config,
        enabled: a.enabled,
        daily_budget_usd: a.daily_budget_usd ?? null,
        validation_command: a.validation_command ?? null,
        worktree_isolation: a.worktree_isolation,
        pre_hook: a.pre_hook ?? null,
        post_hook: a.post_hook ?? null,
        project_id: a.project_id ?? null,
      });
      result.agents.updated++;
    } else {
      agentStore.create({
        id: a.id,
        name: a.name,
        description: a.description,
        model: a.model,
        system_prompt: a.system_prompt,
        max_turns: a.max_turns,
        working_directory: a.working_directory,
        tools: a.tools,
        announce: a.announce,
        suppress_pattern: a.suppress_pattern,
        deliver_to: a.deliver_to,
        mcp_config: a.mcp_config,
        enabled: a.enabled,
        daily_budget_usd: a.daily_budget_usd,
        validation_command: a.validation_command,
        worktree_isolation: a.worktree_isolation,
        pre_hook: a.pre_hook,
        post_hook: a.post_hook,
        project_id: a.project_id,
      });
      result.agents.created++;
    }
    result.agents.total++;

    // Handle inline schedules
    if (a.schedule) {
      const scheduleId = `${a.id}-default`;
      importSchedule(scheduleStore, {
        id: scheduleId,
        agent_id: a.id,
        name: a.schedule.name,
        schedule: a.schedule.cron,
        timezone: a.schedule.timezone,
        prompt: a.schedule.prompt,
        enabled: a.schedule.enabled,
        project_id: a.project_id,
      }, result);
    }

    if (a.schedules) {
      for (let i = 0; i < a.schedules.length; i++) {
        const s = a.schedules[i];
        const scheduleId = s.id ?? `${a.id}-schedule-${i}`;
        importSchedule(scheduleStore, {
          id: scheduleId,
          agent_id: a.id,
          name: s.name,
          schedule: s.cron,
          timezone: s.timezone,
          prompt: s.prompt,
          enabled: s.enabled,
          project_id: a.project_id,
        }, result);
      }
    }
  }

  // Import standalone schedules
  const standaloneSchedules = readYamlDir<ScheduleYaml>(join(personaPath, "schedules"));
  for (const s of standaloneSchedules) {
    importSchedule(scheduleStore, s, result);
  }

  // Import tools
  const toolYamls = readYamlDir<ToolYaml>(join(personaPath, "tools"));
  for (const t of toolYamls) {
    const existing = toolStore.get(t.id);
    if (existing) {
      toolStore.update(t.id, {
        name: t.name,
        type: t.type,
        description: t.description,
        config: t.config,
        cli_command: t.cli_command,
        binary_path: t.binary_path,
        version: t.version,
        enabled: t.enabled,
      });
      result.tools.updated++;
    } else {
      toolStore.create({
        id: t.id,
        name: t.name,
        type: t.type,
        description: t.description,
        config: t.config,
        cli_command: t.cli_command,
        binary_path: t.binary_path,
        version: t.version,
        enabled: t.enabled,
      });
      result.tools.created++;
    }
    result.tools.total++;
  }

  // Import templates
  const templateYamls = readYamlDir<TemplateYaml>(join(personaPath, "templates"));
  for (const t of templateYamls) {
    // Templates use auto-increment IDs, so we match by name+category
    const existing = templateStore.list({ category: t.category })
      .find((e) => e.name === t.name);

    if (existing) {
      templateStore.update(existing.id, {
        name: t.name,
        category: t.category,
        description: t.description,
        content: t.content,
      });
      result.templates.updated++;
    } else {
      templateStore.create({
        name: t.name,
        category: t.category,
        description: t.description,
        content: t.content,
      });
      result.templates.created++;
    }
    result.templates.total++;
  }

  return result;
}

/** Helper to upsert a single schedule. */
function importSchedule(
  store: ScheduleStore,
  s: ScheduleYaml,
  result: SyncResult,
): void {
  const existing = store.get(s.id);
  if (existing) {
    store.update(s.id, {
      agent_id: s.agent_id,
      name: s.name,
      schedule: s.schedule,
      timezone: s.timezone,
      prompt: s.prompt,
      enabled: s.enabled,
      project_id: s.project_id,
    });
    result.schedules.updated++;
  } else {
    store.create({
      id: s.id,
      agent_id: s.agent_id,
      name: s.name,
      schedule: s.schedule,
      timezone: s.timezone,
      prompt: s.prompt,
      enabled: s.enabled,
      project_id: s.project_id,
    });
    result.schedules.created++;
  }
  result.schedules.total++;
}
