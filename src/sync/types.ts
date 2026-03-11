/**
 * Declarative YAML config types for the persona repo sync system.
 *
 * These types map to the YAML files in the persona repo directories
 * (agents/, schedules/, tools/, projects/, templates/).
 */

/** Agent YAML config -- one file per agent in agents/ */
export interface AgentYaml {
  id: string;
  name: string;
  description?: string;
  model?: string;
  system_prompt?: string;
  max_turns?: number;
  working_directory?: string;
  tools?: string[];
  announce?: boolean;
  suppress_pattern?: string;
  deliver_to?: string;
  mcp_config?: string;
  enabled?: boolean;
  daily_budget_usd?: number;
  validation_command?: string;
  worktree_isolation?: boolean;
  pre_hook?: string;
  post_hook?: string;
  project_id?: string;
}

/** Schedule YAML config -- can be inline in agent YAML or standalone */
export interface ScheduleYaml {
  id: string;
  agent_id: string;
  name?: string;
  schedule: string;
  timezone?: string;
  prompt: string;
  enabled?: boolean;
  project_id?: string;
}

/** Agent YAML with inline schedule (convenience format) */
export interface AgentWithScheduleYaml extends AgentYaml {
  schedule?: {
    cron: string;
    timezone?: string;
    prompt: string;
    name?: string;
    enabled?: boolean;
  };
  schedules?: Array<{
    id?: string;
    cron: string;
    timezone?: string;
    prompt: string;
    name?: string;
    enabled?: boolean;
  }>;
}

/** Tool YAML config */
export interface ToolYaml {
  id: string;
  name: string;
  type: string;
  description?: string;
  config?: Record<string, unknown>;
  cli_command?: string;
  binary_path?: string;
  version?: string;
  enabled?: boolean;
  accounts?: ToolAccountYaml[];
}

/** Tool account YAML config */
export interface ToolAccountYaml {
  id?: string;
  account_name: string;
  is_default?: boolean;
  project_id?: string;
  enabled?: boolean;
  // Note: credentials are NOT exported to YAML for security.
  // They must be provided during import or set via API.
}

/** Project YAML config */
export interface ProjectYaml {
  id: string;
  name: string;
  description?: string;
  path?: string;
  context_file?: string;
  tags?: string[];
  enabled?: boolean;
}

/** Template YAML config */
export interface TemplateYaml {
  id?: number;
  name: string;
  category: string;
  description?: string;
  content: string;
}

/** Summary of a sync operation */
export interface SyncResult {
  agents: { created: number; updated: number; total: number };
  schedules: { created: number; updated: number; total: number };
  tools: { created: number; updated: number; total: number };
  projects: { created: number; updated: number; total: number };
  templates: { created: number; updated: number; total: number };
}
