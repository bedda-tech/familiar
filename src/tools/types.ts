/** Tool entity -- a capability available to agents. */
export interface Tool {
  id: string;
  name: string;
  type: string; // 'builtin' | 'cli' | 'mcp'
  description: string | null;
  config: string | null; // JSON blob
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
  enabled?: boolean;
}

export interface UpdateToolInput {
  name?: string;
  type?: string;
  description?: string | null;
  config?: Record<string, unknown> | null;
  enabled?: boolean;
}
