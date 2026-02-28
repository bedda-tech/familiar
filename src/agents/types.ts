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
}
