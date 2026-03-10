/** Tool entity -- a capability available to agents. */
export interface Tool {
  id: string;
  name: string;
  type: string; // 'builtin' | 'cli' | 'mcp' | 'script'
  description: string | null;
  config: string | null; // JSON blob
  cli_command: string | null; // e.g. "vercel", "bird", "gh"
  binary_path: string | null;
  version: string | null;
  enabled: number; // 0 or 1
  created_at: string;
  updated_at: string;
}

export interface CreateToolInput {
  id: string;
  name: string;
  type: string;
  description?: string;
  config?: Record<string, unknown>;
  cli_command?: string;
  binary_path?: string;
  version?: string;
  enabled?: boolean;
}

export interface UpdateToolInput {
  name?: string;
  type?: string;
  description?: string | null;
  config?: Record<string, unknown> | null;
  cli_command?: string | null;
  binary_path?: string | null;
  version?: string | null;
  enabled?: boolean;
}

/** Tool account -- one set of credentials for a given tool. */
export interface ToolAccount {
  id: string;
  tool_id: string;
  account_name: string;
  credentials: string; // JSON blob (stored as-is; masked in API responses)
  is_default: number; // 0 or 1
  project_id: string | null;
  enabled: number; // 0 or 1
  created_at: string;
  updated_at: string;
}

export interface CreateToolAccountInput {
  id?: string;
  tool_id: string;
  account_name: string;
  credentials: Record<string, string>; // key->value env/secret pairs
  is_default?: boolean;
  project_id?: string;
  enabled?: boolean;
}

export interface UpdateToolAccountInput {
  account_name?: string;
  credentials?: Record<string, string>;
  is_default?: boolean;
  project_id?: string | null;
  enabled?: boolean;
}
