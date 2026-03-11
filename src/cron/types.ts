/** Configuration for a single cron job */
export interface CronJobConfig {
  /** Unique job identifier */
  id: string;
  /** Human-readable label */
  label?: string;
  /** Cron expression (5-field) or interval like "every:30m" */
  schedule: string;
  /** IANA timezone (e.g. "Europe/Rome", "UTC"). Defaults to UTC. */
  timezone?: string;
  /** Prompt to send to Claude */
  prompt: string;
  /** Model override (defaults to main config model) */
  model?: string;
  /** Max agentic turns for this job */
  maxTurns?: number;
  /** Working directory override */
  workingDirectory?: string;
  /** Telegram chat ID to deliver results to. Defaults to first allowedUser. */
  deliverTo?: string;
  /** Whether to deliver results to Telegram (default: true) */
  announce?: boolean;
  /** Regex pattern — if the result text matches, suppress delivery (useful for HEARTBEAT_OK) */
  suppressPattern?: string;
  /** Whether job is enabled (default: true) */
  enabled?: boolean;
  /** Optional system prompt for this job. Unlike the main session, cron jobs
   *  do NOT inherit the global systemPrompt by default — they are task-focused
   *  executors that don't need personality context. */
  systemPrompt?: string;
  /** Whether to spawn with --chrome. Defaults to true for backwards compat. */
  chrome?: boolean;
  /** Per-run budget cap passed as --max-budget-usd to the claude CLI. */
  maxRunBudgetUsd?: number;
  /** Whether to run this job in an isolated git worktree. */
  worktreeIsolation?: boolean;
  /** Shell command to run before spawning claude (e.g. "git pull", "npm install"). */
  preHook?: string | null;
  /** Shell command to run after completion (e.g. "git push", "npm run deploy"). */
  postHook?: string | null;
  /** Per-agent allowed tools override. When set, passed as --allowedTools instead of the default config. */
  allowedTools?: string[];
  /** Per-agent MCP config path override. When set, passed as --mcp-config instead of the default. */
  mcpConfig?: string;
}

/** Runtime state for a cron job, persisted in SQLite */
export interface CronJobState {
  jobId: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  lastError: string | null;
  lastDurationMs: number | null;
  lastCostUsd: number | null;
}

/** Result of a single cron job execution */
export interface CronRunResult {
  jobId: string;
  text: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
  startedAt: Date;
  finishedAt: Date;
  /** Full conversation log -- structured events from the claude -p stream */
  runLog?: string;
}
