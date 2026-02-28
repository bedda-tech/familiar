/** Project entity -- a context container linking agents, tasks, and docs. */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  path: string | null; // filesystem path to project root
  context_file: string | null; // path to context .md file
  tags: string | null; // JSON array
  enabled: number; // 0 or 1
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  id: string;
  name: string;
  description?: string;
  path?: string;
  context_file?: string;
  tags?: string[];
  enabled?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  path?: string | null;
  context_file?: string | null;
  tags?: string[];
  enabled?: boolean;
}
