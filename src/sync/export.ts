/**
 * Export -- dumps DB state to YAML files in the persona repo.
 *
 * Usage:
 *   familiar export --persona /path/to/persona
 *
 * Reads agents, schedules, tools, projects, templates from the DB
 * and writes them as YAML files into the persona repo directories.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type Database from "better-sqlite3";
import type { Agent } from "../agents/types.js";
import type { Schedule } from "../schedules/types.js";
import type { Tool, ToolAccount } from "../tools/types.js";
import type { Project } from "../projects/types.js";
import type { Template } from "../templates/types.js";
import type { AgentWithScheduleYaml, ToolYaml, ProjectYaml, TemplateYaml } from "./types.js";

export interface ExportOptions {
  personaPath: string;
  db: Database.Database;
}

export interface ExportResult {
  agents: number;
  schedules: number;
  tools: number;
  projects: number;
  templates: number;
}

/** Export all DB entities to YAML files in the persona repo. */
export function exportToPersona(opts: ExportOptions): ExportResult {
  const { personaPath, db } = opts;
  const result: ExportResult = { agents: 0, schedules: 0, tools: 0, projects: 0, templates: 0 };

  // Ensure directories exist
  for (const dir of ["agents", "tools", "schedules", "projects", "templates"]) {
    mkdirSync(join(personaPath, dir), { recursive: true });
  }

  // Export agents (with inline schedules)
  const agents = db.prepare("SELECT * FROM agents ORDER BY id").all() as Agent[];
  const allSchedules = db.prepare("SELECT * FROM schedules ORDER BY agent_id, id").all() as Schedule[];

  // Group schedules by agent_id
  const schedulesByAgent = new Map<string, Schedule[]>();
  for (const s of allSchedules) {
    const list = schedulesByAgent.get(s.agent_id) ?? [];
    list.push(s);
    schedulesByAgent.set(s.agent_id, list);
  }

  for (const agent of agents) {
    const agentSchedules = schedulesByAgent.get(agent.id) ?? [];
    const yaml = agentToYaml(agent, agentSchedules);
    const filename = `${agent.id}.yaml`;
    writeFileSync(join(personaPath, "agents", filename), stringify(yaml, { lineWidth: 120 }));
    result.agents++;
    result.schedules += agentSchedules.length;
  }

  // Export orphan schedules (schedules without matching agent) -- unlikely but handle it
  const agentIds = new Set(agents.map((a) => a.id));
  const orphanSchedules = allSchedules.filter((s) => !agentIds.has(s.agent_id));
  if (orphanSchedules.length > 0) {
    const orphanYaml = orphanSchedules.map(scheduleToYaml);
    writeFileSync(
      join(personaPath, "schedules", "_orphan-schedules.yaml"),
      stringify(orphanYaml, { lineWidth: 120 }),
    );
    result.schedules += orphanSchedules.length;
  }

  // Export tools
  const tools = db.prepare("SELECT * FROM tools ORDER BY id").all() as Tool[];
  let toolAccounts: ToolAccount[] = [];
  try {
    toolAccounts = db.prepare("SELECT * FROM tool_accounts ORDER BY tool_id, account_name").all() as ToolAccount[];
  } catch {
    // tool_accounts table may not exist yet
  }

  // Group by type for organized files
  const toolsByType = new Map<string, Tool[]>();
  for (const t of tools) {
    const list = toolsByType.get(t.type) ?? [];
    list.push(t);
    toolsByType.set(t.type, list);
  }

  const accountsByTool = new Map<string, ToolAccount[]>();
  for (const a of toolAccounts) {
    const list = accountsByTool.get(a.tool_id) ?? [];
    list.push(a);
    accountsByTool.set(a.tool_id, list);
  }

  for (const [type, typeTools] of toolsByType) {
    const yamls = typeTools.map((t) => toolToYaml(t, accountsByTool.get(t.id) ?? []));
    const filename = `${type}-tools.yaml`;
    writeFileSync(join(personaPath, "tools", filename), stringify(yamls, { lineWidth: 120 }));
    result.tools += typeTools.length;
  }

  // Export projects
  const projects = db.prepare("SELECT * FROM projects ORDER BY id").all() as Project[];
  if (projects.length > 0) {
    const yamls = projects.map(projectToYaml);
    writeFileSync(join(personaPath, "projects", "projects.yaml"), stringify(yamls, { lineWidth: 120 }));
    result.projects = projects.length;
  }

  // Export templates
  const templates = db.prepare("SELECT * FROM templates ORDER BY category, name").all() as Template[];
  if (templates.length > 0) {
    // Group by category
    const byCategory = new Map<string, Template[]>();
    for (const t of templates) {
      const list = byCategory.get(t.category) ?? [];
      list.push(t);
      byCategory.set(t.category, list);
    }

    for (const [category, catTemplates] of byCategory) {
      const yamls = catTemplates.map(templateToYaml);
      const filename = `${category}.yaml`;
      writeFileSync(join(personaPath, "templates", filename), stringify(yamls, { lineWidth: 120 }));
      result.templates += catTemplates.length;
    }
  }

  return result;
}

/** Convert an Agent + its Schedules to YAML format. */
function agentToYaml(agent: Agent, schedules: Schedule[]): AgentWithScheduleYaml {
  const yaml: AgentWithScheduleYaml = {
    id: agent.id,
    name: agent.name,
  };

  if (agent.description) yaml.description = agent.description;
  if (agent.model && agent.model !== "sonnet") yaml.model = agent.model;
  if (agent.system_prompt) yaml.system_prompt = agent.system_prompt;
  if (agent.max_turns !== 25) yaml.max_turns = agent.max_turns;
  if (agent.working_directory) yaml.working_directory = agent.working_directory;
  if (agent.tools) {
    try {
      yaml.tools = JSON.parse(agent.tools);
    } catch {
      // leave as undefined
    }
  }
  if (agent.announce === 0) yaml.announce = false;
  if (agent.suppress_pattern) yaml.suppress_pattern = agent.suppress_pattern;
  if (agent.deliver_to) yaml.deliver_to = agent.deliver_to;
  if (agent.mcp_config) yaml.mcp_config = agent.mcp_config;
  if (agent.enabled === 0) yaml.enabled = false;
  if (agent.daily_budget_usd != null) yaml.daily_budget_usd = agent.daily_budget_usd;
  if (agent.validation_command) yaml.validation_command = agent.validation_command;
  if (agent.worktree_isolation) yaml.worktree_isolation = true;
  if (agent.pre_hook) yaml.pre_hook = agent.pre_hook;
  if (agent.post_hook) yaml.post_hook = agent.post_hook;
  if (agent.project_id) yaml.project_id = agent.project_id;

  // Inline schedules
  if (schedules.length === 1) {
    const s = schedules[0];
    yaml.schedule = {
      cron: s.schedule,
      timezone: s.timezone !== "UTC" ? s.timezone : undefined,
      prompt: s.prompt,
      name: s.name ?? undefined,
      enabled: s.enabled === 0 ? false : undefined,
    };
    // Clean up undefined fields
    if (yaml.schedule.timezone === undefined) delete yaml.schedule.timezone;
    if (yaml.schedule.name === undefined) delete yaml.schedule.name;
    if (yaml.schedule.enabled === undefined) delete yaml.schedule.enabled;
  } else if (schedules.length > 1) {
    yaml.schedules = schedules.map((s) => ({
      id: s.id,
      cron: s.schedule,
      timezone: s.timezone !== "UTC" ? s.timezone : undefined,
      prompt: s.prompt,
      name: s.name ?? undefined,
      enabled: s.enabled === 0 ? false : undefined,
    }));
  }

  return yaml;
}

/** Convert a standalone Schedule to YAML. */
function scheduleToYaml(s: Schedule) {
  return {
    id: s.id,
    agent_id: s.agent_id,
    name: s.name,
    schedule: s.schedule,
    timezone: s.timezone,
    prompt: s.prompt,
    enabled: s.enabled === 1,
    project_id: s.project_id,
  };
}

/** Convert a Tool + accounts to YAML. */
function toolToYaml(tool: Tool, accounts: ToolAccount[]): ToolYaml {
  const yaml: ToolYaml = {
    id: tool.id,
    name: tool.name,
    type: tool.type,
  };

  if (tool.description) yaml.description = tool.description;
  if (tool.config) {
    try {
      yaml.config = JSON.parse(tool.config);
    } catch {
      // skip
    }
  }
  if (tool.cli_command) yaml.cli_command = tool.cli_command;
  if (tool.binary_path) yaml.binary_path = tool.binary_path;
  if (tool.version) yaml.version = tool.version;
  if (tool.enabled === 0) yaml.enabled = false;

  if (accounts.length > 0) {
    yaml.accounts = accounts.map((a) => ({
      id: a.id,
      account_name: a.account_name,
      is_default: a.is_default === 1 ? true : undefined,
      project_id: a.project_id ?? undefined,
      enabled: a.enabled === 0 ? false : undefined,
      // credentials deliberately omitted for security
    }));
  }

  return yaml;
}

/** Convert a Project to YAML. */
function projectToYaml(p: Project): ProjectYaml {
  const yaml: ProjectYaml = {
    id: p.id,
    name: p.name,
  };

  if (p.description) yaml.description = p.description;
  if (p.path) yaml.path = p.path;
  if (p.context_file) yaml.context_file = p.context_file;
  if (p.tags) {
    try {
      yaml.tags = JSON.parse(p.tags);
    } catch {
      // skip
    }
  }
  if (p.enabled === 0) yaml.enabled = false;

  return yaml;
}

/** Convert a Template to YAML. */
function templateToYaml(t: Template): TemplateYaml {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description ?? undefined,
    content: t.content,
  };
}
