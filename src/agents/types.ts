/** Persistent agent entity -- represents a configured agent identity. */
export interface Agent {
  id: string;
  name: string;
  description: string | null;
  model: string;
  system_prompt: string | null;
  max_turns: number;
  working_directory: string | null;
  tools: string | null; // JSON array of tool names
  announce: number; // 0 or 1
  suppress_pattern: string | null;
  deliver_to: string | null;
  mcp_config: string | null; // JSON or file path
  enabled: number; // 0 or 1
  daily_budget_usd: number | null; // null = unlimited
  /** Shell command to run after the agent makes git commits. e.g. "npm run build && npm test" */
  validation_command: string | null;
  /** Whether to run each job in an isolated git worktree (0 or 1). */
  worktree_isolation: number;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentInput {
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
  daily_budget_usd?: number | null;
  validation_command?: string | null;
  worktree_isolation?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  model?: string;
  system_prompt?: string | null;
  max_turns?: number;
  working_directory?: string | null;
  tools?: string[];
  announce?: boolean;
  suppress_pattern?: string | null;
  deliver_to?: string | null;
  mcp_config?: string | null;
  enabled?: boolean;
  daily_budget_usd?: number | null;
  validation_command?: string | null;
  worktree_isolation?: boolean;
}
