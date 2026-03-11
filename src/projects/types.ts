/** Project entity -- a context container linking agents, tasks, and docs. */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  path: string | null; // filesystem path to project root
  context_file: string | null; // path to context .md file
  tags: string | null; // JSON array
  enabled: number; // 0 or 1
  status: string | null; // active, paused, archived
  priority: number | null;
  repos: string | null; // JSON array of RepoConfig
  issue_tracking: string | null; // JSON IssueTrackingConfig
  env_refs: string | null; // JSON Record<string, string>
  created_at: string;
  updated_at: string;
}

export interface RepoConfig {
  url: string; // git clone URL
  branch?: string; // default: main
  path?: string; // subdir name under repos/ (default: basename of url)
  auth?: string; // SSH key alias or auth hint
}

export interface IssueTrackingConfig {
  type: string; // "github", "familiar", "linear", "jira", "notion", etc.
  repo?: string; // for github: "bedda-tech/nozio"
  project_key?: string; // for linear/jira: "NOZ"
  url?: string; // direct URL to board/project
  db_id?: string; // for notion: database ID
}

export interface CreateProjectInput {
  id: string;
  name: string;
  description?: string;
  path?: string;
  context_file?: string;
  tags?: string[];
  enabled?: boolean;
  status?: string;
  priority?: number;
  repos?: RepoConfig[];
  issue_tracking?: IssueTrackingConfig;
  env_refs?: Record<string, string>;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  path?: string | null;
  context_file?: string | null;
  tags?: string[];
  enabled?: boolean;
  status?: string | null;
  priority?: number | null;
  repos?: RepoConfig[];
  issue_tracking?: IssueTrackingConfig | null;
  env_refs?: Record<string, string> | null;
}
