import { Cron } from "croner";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { CronJobConfig, CronRunResult } from "./types.js";
import type { ClaudeConfig } from "../config.js";
import { runCronJob } from "./runner.js";
import { getConfigDir } from "../config.js";
import { AgentWorkspace } from "../agents/workspace.js";
import { getLogger } from "../util/logger.js";
import type { Agent } from "../agents/types.js";
import type { Schedule } from "../schedules/types.js";
import type { WsServer } from "../ws/server.js";
import type { WsEvent } from "../ws/types.js";
import type { TaskStore } from "../tasks/store.js";

const log = getLogger("cron-scheduler");

/** Agents that skip task-awareness injection (infrastructure agents). */
const SKIP_TASK_PREFIX_AGENTS = new Set(["heartbeat", "cron-doctor", "pipeline-monitor"]);

/** Parse a JSON string array column, returning undefined if null/invalid. */
function parseJsonArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface CronDeliveryHandler {
  (jobId: string, result: CronRunResult, config: CronJobConfig, runId?: number): Promise<void>;
}

export class CronScheduler {
  private jobs = new Map<string, Cron>();
  private configs = new Map<string, CronJobConfig>();
  private db: Database.Database;
  private running = new Map<string, boolean>();
  private deliveryHandler: CronDeliveryHandler | null = null;
  private claudeConfig: ClaudeConfig;
  private workspace: AgentWorkspace;
  private concurrentCount = 0;
  private maxConcurrent = 3;
  private waitQueue: Array<{ resolve: () => void }> = [];
  /** Shared DB handle for reading agents/schedules tables. */
  private sharedDb: Database.Database | null = null;
  /** Recurring task ticker -- resets completed recurring tasks on schedule. */
  private recurringTicker: Cron | null = null;
  /** Stale task ticker -- rescues abandoned in_progress tasks. */
  private staleTaskTicker: Cron | null = null;
  /** WebSocket server for broadcasting events. */
  private wsServer: WsServer | null = null;
  /** Task store for creating follow-up tasks on validation failure. */
  private taskStore: TaskStore | null = null;
  /**
   * Tracks when each scheduled job last finished.
   * Used to prevent chained fires: when croner's protect=true causes it to
   * fire immediately after a long run ends (because a "missed" trigger time
   * has already passed), we skip the fire and wait for the next legitimate
   * scheduled time.
   */
  private lastFinishedAt = new Map<string, number>();

  private webhookToken: string;
  private webhookPort: number;

  constructor(jobConfigs: CronJobConfig[], claudeConfig: ClaudeConfig, dbPath?: string, webhookToken?: string, webhookPort?: number) {
    this.claudeConfig = claudeConfig;
    this.webhookToken = webhookToken ?? "";
    this.webhookPort = webhookPort ?? 3002;
    this.workspace = new AgentWorkspace();

    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    const path = dbPath ?? join(dir, "familiar.db");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();

    for (const config of jobConfigs) {
      this.configs.set(config.id, config);
    }
  }

  /** Set the shared DB handle for reading agents/schedules tables. */
  setSharedDb(db: Database.Database): void {
    this.sharedDb = db;
  }

  /** Set the WebSocket server for broadcasting events. */
  setWsServer(ws: WsServer): void {
    this.wsServer = ws;
  }

  /** Set the task store for creating follow-up tasks on validation failure. */
  setTaskStore(store: TaskStore): void {
    this.taskStore = store;
  }

  /** Log an entry to the activity_log table (via sharedDb). */
  private logActivity(
    type: string,
    summary: string,
    opts?: { agentId?: string; scheduleId?: string; taskId?: number; details?: string },
  ): void {
    if (!this.sharedDb) return;
    try {
      this.sharedDb
        .prepare(
          `INSERT INTO activity_log (type, agent_id, schedule_id, task_id, summary, details)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          type,
          opts?.agentId ?? null,
          opts?.scheduleId ?? null,
          opts?.taskId ?? null,
          summary,
          opts?.details ?? null,
        );
    } catch (e) {
      log.warn({ err: e }, "failed to log activity");
    }
  }

  /**
   * Run post-validation after an agent completes a run.
   *
   * Flow:
   *   1. Look up agent's validation_command from DB (skip if none set)
   *   2. Detect new git commits since the run started
   *   3. If commits found, run the validation command in the agent's working dir
   *   4. On success: log activity
   *   5. On failure: create follow-up task, revert the commit, broadcast event
   */
  private runPostValidation(agentId: string, workDir: string | undefined, startedAt: Date): void {
    if (!this.sharedDb || !workDir) return;

    // Look up validation command for this agent
    const agentRow = this.sharedDb
      .prepare("SELECT validation_command FROM agents WHERE id = ?")
      .get(agentId) as { validation_command: string | null } | undefined;

    const validationCmd = agentRow?.validation_command;
    if (!validationCmd) return;

    // Detect new commits since this run started (ISO 8601 format git understands)
    const sinceArg = `--since=${startedAt.toISOString()}`;
    const gitCheck = spawnSync("git", ["log", sinceArg, "--oneline"], {
      cwd: workDir,
      encoding: "utf-8",
    });

    if (gitCheck.status !== 0 || !gitCheck.stdout.trim()) {
      log.debug({ agentId }, "no new commits since run start, skipping validation");
      return;
    }

    const commits = gitCheck.stdout.trim();
    const firstCommit = commits.split("\n")[0];
    log.info({ agentId, commits }, "new commits detected — running post-run validation");

    // Run the validation command (shell: true so && chains work)
    const validation = spawnSync(validationCmd, {
      shell: true,
      cwd: workDir,
      encoding: "utf-8",
      timeout: 5 * 60 * 1000, // 5 minute cap
    });

    if (validation.status === 0) {
      log.info({ agentId, commits }, "post-run validation passed");
      this.logActivity("validation_passed", `Validation passed for agent ${agentId}`, {
        agentId,
        details: JSON.stringify({ command: validationCmd, commits }),
      });
      return;
    }

    // Validation failed
    const errOutput = ((validation.stdout ?? "") + "\n" + (validation.stderr ?? ""))
      .trim()
      .slice(0, 2000);
    log.error(
      { agentId, exitCode: validation.status, commits, errOutput },
      "post-run validation FAILED — reverting commit",
    );

    this.logActivity(
      "validation_failed",
      `Validation FAILED for agent ${agentId} — commit reverted`,
      {
        agentId,
        details: JSON.stringify({ command: validationCmd, commits, error: errOutput }),
      },
    );

    // Create a follow-up fix task
    let followUpTaskId: number | undefined;
    if (this.taskStore) {
      try {
        const task = this.taskStore.create({
          title: `Fix build broken by ${agentId}: ${firstCommit.slice(0, 50)}`,
          description:
            `Post-run validation failed after ${agentId} committed changes.\n\n` +
            `**Commits:**\n\`\`\`\n${commits}\n\`\`\`\n\n` +
            `**Validation command:** \`${validationCmd}\`\n\n` +
            `**Output:**\n\`\`\`\n${errOutput}\n\`\`\`\n\n` +
            `The offending commit was automatically reverted. Fix the underlying issue and re-commit.`,
          assigned_agent: agentId,
          priority: 1,
          tags: ["build-broken", "validation-failed", "auto-created"],
        });
        followUpTaskId = task.id;
        log.info({ agentId, taskId: task.id }, "follow-up fix task created");
      } catch (e) {
        log.warn({ agentId, err: e }, "failed to create follow-up task");
      }
    }

    // Revert the bad commit
    const revert = spawnSync("git", ["revert", "HEAD", "--no-edit"], {
      cwd: workDir,
      encoding: "utf-8",
    });

    if (revert.status === 0) {
      log.info({ agentId }, "bad commit reverted successfully");
    } else {
      log.error(
        { agentId, stderr: revert.stderr?.slice(0, 500) },
        "failed to auto-revert bad commit — manual intervention required",
      );
    }

    // Broadcast failure event
    this.wsServer?.broadcast({
      type: "validation:failed",
      agentId,
      commits,
      validationCommand: validationCmd,
      taskId: followUpTaskId,
    });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_state (
        job_id TEXT PRIMARY KEY,
        last_run_at TEXT,
        next_run_at TEXT,
        run_count INTEGER DEFAULT 0,
        last_error TEXT,
        last_duration_ms INTEGER,
        last_cost_usd REAL
      );

      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER,
        cost_usd REAL DEFAULT 0,
        num_turns INTEGER DEFAULT 0,
        is_error INTEGER DEFAULT 0,
        result_text TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Additive migration: run_log column for full conversation logs
    try {
      this.db.exec("ALTER TABLE cron_runs ADD COLUMN run_log TEXT");
    } catch {
      // Column already exists
    }
  }

  /** Get the agent workspace instance (for external access to agent state/memory). */
  getWorkspace(): AgentWorkspace {
    return this.workspace;
  }

  /** Set the handler for delivering cron results to the user. */
  onDelivery(handler: CronDeliveryHandler): void {
    this.deliveryHandler = handler;
  }

  /** Start all enabled cron jobs -- reads from DB schedules if available, falls back to config. */
  start(): void {
    // DB-backed schedules take priority
    if (this.sharedDb) {
      this.startFromDb();
    }

    // Start recurring task ticker (every minute)
    this.startRecurringTicker();

    // Start stale task rescue ticker (every 5 minutes)
    this.startStaleTaskTicker();

    // Legacy config-based jobs (skip any already scheduled from DB)
    for (const [id, config] of this.configs) {
      if (config.enabled === false) {
        log.info({ jobId: id }, "skipping disabled job");
        continue;
      }
      // Skip if already scheduled from DB (schedule id = "{agentId}-default")
      if (this.jobs.has(id) || this.jobs.has(`${id}-default`)) {
        continue;
      }

      try {
        const cron = this.scheduleJob(config);
        this.jobs.set(id, cron);
        const next = cron.nextRun();
        const nextStr = next ? next.toISOString() : "unknown";
        this.updateNextRun(id, nextStr);
        log.info(
          { jobId: id, schedule: config.schedule, timezone: config.timezone, next: nextStr },
          "scheduled cron job (legacy)",
        );
      } catch (e) {
        log.error({ jobId: id, err: e }, "failed to schedule job");
      }
    }

    log.info({ jobCount: this.jobs.size }, "cron scheduler started");
  }

  /** Schedule jobs from DB agents + schedules tables. */
  private startFromDb(): void {
    if (!this.sharedDb) return;

    try {
      const rows = this.sharedDb
        .prepare(
          `SELECT s.id as schedule_id, s.agent_id, s.name as schedule_name,
                  s.schedule, s.timezone, s.prompt, s.enabled as schedule_enabled,
                  a.name as agent_name, a.model, a.system_prompt, a.max_turns,
                  a.working_directory, a.tools as agent_tools, a.announce,
                  a.suppress_pattern, a.deliver_to, a.mcp_config, a.enabled as agent_enabled,
                  a.chrome, a.max_run_budget_usd, a.worktree_isolation,
                  a.pre_hook, a.post_hook
           FROM schedules s
           JOIN agents a ON s.agent_id = a.id
           WHERE s.enabled = 1 AND a.enabled = 1`,
        )
        .all() as Array<Record<string, unknown>>;

      for (const row of rows) {
        const scheduleId = row.schedule_id as string;
        const agentId = row.agent_id as string;

        try {
          // Build a CronJobConfig from the joined row (runner still uses this format)
          const jobConfig: CronJobConfig = {
            id: agentId,
            label: (row.agent_name as string) || (row.schedule_name as string) || agentId,
            schedule: row.schedule as string,
            timezone: (row.timezone as string) ?? "UTC",
            prompt: row.prompt as string,
            model: (row.model as string) ?? undefined,
            maxTurns: (row.max_turns as number) ?? 25,
            workingDirectory: (row.working_directory as string) ?? undefined,
            announce: (row.announce as number) === 1,
            suppressPattern: (row.suppress_pattern as string) ?? undefined,
            deliverTo: (row.deliver_to as string) ?? undefined,
            enabled: true,
            systemPrompt: (row.system_prompt as string) ?? undefined,
            chrome: (row.chrome as number) !== 0,
            maxRunBudgetUsd: (row.max_run_budget_usd as number) ?? undefined,
            worktreeIsolation: (row.worktree_isolation as number) === 1,
            preHook: (row.pre_hook as string) ?? undefined,
            postHook: (row.post_hook as string) ?? undefined,
            allowedTools: parseJsonArray(row.agent_tools as string | null),
            mcpConfig: (row.mcp_config as string) ?? undefined,
          };

          const cron = new Cron(
            row.schedule as string,
            {
              timezone: ((row.timezone as string) ?? "UTC") as string,
              protect: true,
            },
            async () => {
              // Guard against chained fires: croner's protect=true fires immediately
              // after a long run ends (because the previous trigger time has passed).
              // If the current time is before the next legitimate scheduled time
              // (computed from when the last run finished), skip this fire.
              const lastFinished = this.lastFinishedAt.get(scheduleId);
              if (lastFinished !== undefined) {
                const cronJob = this.jobs.get(scheduleId);
                if (cronJob) {
                  const nextLegitimate = cronJob.nextRun(new Date(lastFinished));
                  if (nextLegitimate && Date.now() < nextLegitimate.getTime()) {
                    log.info(
                      { scheduleId, nextLegitimate: nextLegitimate.toISOString() },
                      "skipping chained fire — next scheduled time not yet reached",
                    );
                    return;
                  }
                }
              }
              await this.executeJobWithScheduleId(jobConfig, scheduleId);
            },
          );

          this.jobs.set(scheduleId, cron);

          const next = cron.nextRun();
          const nextStr = next ? next.toISOString() : "unknown";
          this.updateNextRun(scheduleId, nextStr);

          log.info(
            { scheduleId, agentId, schedule: row.schedule, next: nextStr },
            "scheduled DB job",
          );
        } catch (e) {
          log.error({ scheduleId, err: e }, "failed to schedule DB job");
        }
      }

      log.info({ count: rows.length }, "DB schedules loaded");
    } catch (e) {
      log.error({ err: e }, "failed to load DB schedules");
    }
  }

  /** Reload all schedules. Stops existing croner instances and re-schedules. */
  async reload(): Promise<void> {
    log.info("reloading schedules");
    for (const [, cron] of this.jobs) {
      cron.stop();
    }
    this.jobs.clear();
    this.start();
  }

  /** Stop all cron jobs. */
  stop(): void {
    if (this.recurringTicker) {
      this.recurringTicker.stop();
      this.recurringTicker = null;
    }
    if (this.staleTaskTicker) {
      this.staleTaskTicker.stop();
      this.staleTaskTicker = null;
    }
    for (const [id, cron] of this.jobs) {
      cron.stop();
      log.debug({ jobId: id }, "stopped job");
    }
    this.jobs.clear();
    this.db.close();
    log.info("cron scheduler stopped");
  }

  /** Manually trigger a job by ID (supports schedule IDs, agent IDs, and legacy job IDs). */
  async runNow(jobId: string): Promise<CronRunResult | null> {
    // Try DB: look up schedule by ID or by agent_id
    if (this.sharedDb) {
      const schedule =
        (this.sharedDb
          .prepare("SELECT * FROM schedules WHERE id = ?")
          .get(jobId) as Record<string, unknown> | undefined) ??
        (this.sharedDb
          .prepare("SELECT * FROM schedules WHERE agent_id = ? LIMIT 1")
          .get(jobId) as Record<string, unknown> | undefined);

      if (schedule) {
        const agent = this.sharedDb
          .prepare("SELECT * FROM agents WHERE id = ?")
          .get(schedule.agent_id as string) as Record<string, unknown> | undefined;

        if (agent) {
          const jobConfig: CronJobConfig = {
            id: agent.id as string,
            label: (agent.name as string) || (agent.id as string),
            schedule: schedule.schedule as string,
            timezone: (schedule.timezone as string) ?? "UTC",
            prompt: schedule.prompt as string,
            model: (agent.model as string) ?? undefined,
            maxTurns: (agent.max_turns as number) ?? 25,
            workingDirectory: (agent.working_directory as string) ?? undefined,
            announce: (agent.announce as number) === 1,
            suppressPattern: (agent.suppress_pattern as string) ?? undefined,
            deliverTo: (agent.deliver_to as string) ?? undefined,
            enabled: true,
            systemPrompt: (agent.system_prompt as string) ?? undefined,
            chrome: (agent.chrome as number) !== 0,
            maxRunBudgetUsd: (agent.max_run_budget_usd as number) ?? undefined,
            worktreeIsolation: (agent.worktree_isolation as number) === 1,
            preHook: (agent.pre_hook as string) ?? undefined,
            postHook: (agent.post_hook as string) ?? undefined,
          };
          return this.executeJobWithScheduleId(jobConfig, schedule.id as string);
        }
      }
    }

    // Fall back to legacy config
    const config = this.configs.get(jobId);
    if (!config) {
      log.warn({ jobId }, "job not found");
      return null;
    }
    return this.executeJob(config);
  }

  /** List all configured jobs with their state (DB + legacy merged). */
  listJobs(): Array<
    CronJobConfig & { nextRun: string | null; lastRun: string | null; runCount: number }
  > {
    const results: Array<
      CronJobConfig & { nextRun: string | null; lastRun: string | null; runCount: number }
    > = [];
    const coveredAgentIds = new Set<string>();

    // DB schedules
    if (this.sharedDb) {
      try {
        const rows = this.sharedDb
          .prepare(
            `SELECT s.id as schedule_id, s.agent_id, s.name as schedule_name,
                    s.schedule, s.timezone, s.prompt, s.enabled as schedule_enabled,
                    a.name as agent_name, a.model, a.system_prompt, a.max_turns,
                    a.working_directory, a.announce, a.suppress_pattern, a.deliver_to,
                    a.enabled as agent_enabled, a.chrome, a.max_run_budget_usd, a.worktree_isolation
             FROM schedules s
             JOIN agents a ON s.agent_id = a.id`,
          )
          .all() as Array<Record<string, unknown>>;

        for (const row of rows) {
          const scheduleId = row.schedule_id as string;
          const agentId = row.agent_id as string;
          coveredAgentIds.add(agentId);

          const state = this.getJobState(scheduleId);
          const liveCron = this.jobs.get(scheduleId);
          let next = liveCron?.nextRun();
          const isEnabled =
            (row.schedule_enabled as number) === 1 && (row.agent_enabled as number) === 1;

          if (!next && isEnabled) {
            try {
              const tmp = new Cron(row.schedule as string, {
                timezone: (row.timezone as string) ?? "UTC",
              });
              next = tmp.nextRun() ?? undefined;
              tmp.stop();
            } catch {}
          }

          results.push({
            id: agentId,
            label: (row.agent_name as string) || (row.schedule_name as string) || agentId,
            schedule: row.schedule as string,
            timezone: (row.timezone as string) ?? "UTC",
            prompt: row.prompt as string,
            model: (row.model as string) ?? undefined,
            maxTurns: (row.max_turns as number) ?? 25,
            workingDirectory: (row.working_directory as string) ?? undefined,
            announce: (row.announce as number) === 1,
            suppressPattern: (row.suppress_pattern as string) ?? undefined,
            deliverTo: (row.deliver_to as string) ?? undefined,
            enabled: isEnabled,
            systemPrompt: (row.system_prompt as string) ?? undefined,
            chrome: (row.chrome as number) !== 0,
            maxRunBudgetUsd: (row.max_run_budget_usd as number) ?? undefined,
            worktreeIsolation: (row.worktree_isolation as number) === 1,
            preHook: (row.pre_hook as string) ?? undefined,
            postHook: (row.post_hook as string) ?? undefined,
            nextRun: next?.toISOString() ?? state?.next_run_at ?? null,
            lastRun: state?.last_run_at ?? null,
            runCount: state?.run_count ?? 0,
          });
        }
      } catch (e) {
        log.error({ err: e }, "failed to list DB schedules");
      }
    }

    // Legacy config-based jobs (not covered by DB)
    for (const [id, config] of this.configs) {
      if (coveredAgentIds.has(id)) continue;

      const state = this.getJobState(id);
      const liveCron = this.jobs.get(id);
      let next = liveCron?.nextRun();
      if (!next && config.enabled !== false) {
        try {
          const tmp = new Cron(config.schedule, { timezone: config.timezone ?? "UTC" });
          next = tmp.nextRun() ?? undefined;
          tmp.stop();
        } catch {}
      }
      results.push({
        ...config,
        nextRun: next?.toISOString() ?? state?.next_run_at ?? null,
        lastRun: state?.last_run_at ?? null,
        runCount: state?.run_count ?? 0,
      });
    }

    return results;
  }

  /** Get recent run history for a job. */
  getRunHistory(
    jobId: string,
    limit: number = 10,
  ): Array<{
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    costUsd: number;
    isError: boolean;
    resultPreview: string;
  }> {
    // Try exact match first, then prefix match (agent-id -> agent-id-default)
    let rows = this.db
      .prepare(
        `SELECT started_at, finished_at, duration_ms, cost_usd, is_error, result_text
         FROM cron_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(jobId, limit) as Array<{
      started_at: string;
      finished_at: string;
      duration_ms: number;
      cost_usd: number;
      is_error: number;
      result_text: string;
    }>;

    if (rows.length === 0) {
      rows = this.db
        .prepare(
          `SELECT started_at, finished_at, duration_ms, cost_usd, is_error, result_text
           FROM cron_runs WHERE job_id LIKE ? || '%' ORDER BY id DESC LIMIT ?`,
        )
        .all(jobId, limit) as typeof rows;
    }

    return rows.map((r) => ({
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      costUsd: r.cost_usd,
      isError: r.is_error === 1,
      resultPreview: r.result_text?.slice(0, 200) ?? "",
    }));
  }

  /** Prune old cron_runs (older than 30 days) and stale ready tasks (older than 14 days). */
  private pruneOldData(): void {
    try {
      const runsDeleted = this.db
        .prepare(`DELETE FROM cron_runs WHERE started_at < datetime('now', '-30 days')`)
        .run().changes;
      if (runsDeleted > 0) {
        log.info({ runsDeleted }, "pruned old cron_runs");
      }
    } catch (e) {
      log.warn({ err: e }, "failed to prune cron_runs");
    }

    if (this.sharedDb) {
      try {
        const tasksDeleted = this.sharedDb
          .prepare(
            `DELETE FROM tasks
             WHERE status = 'ready'
               AND claimed_by IS NULL
               AND updated_at < datetime('now', '-14 days')`,
          )
          .run().changes;
        if (tasksDeleted > 0) {
          log.info({ tasksDeleted }, "pruned stale ready tasks");
        }
      } catch (e) {
        log.warn({ err: e }, "failed to prune stale tasks");
      }
    }
  }

  /** Start the recurring task ticker -- runs every minute to reset due recurring tasks. */
  private startRecurringTicker(): void {
    if (this.recurringTicker) {
      this.recurringTicker.stop();
    }

    // Run data pruning once at startup
    this.pruneOldData();

    this.recurringTicker = new Cron("* * * * *", { protect: true }, () => {
      this.tickRecurringTasks();
    });

    log.info("recurring task ticker started (every minute)");
  }

  /** Check completed/failed recurring tasks and reset those that are due. */
  private tickRecurringTasks(): void {
    if (!this.sharedDb) return;

    try {
      const tasks = this.sharedDb
        .prepare(
          `SELECT id, title, recurrence_schedule, last_completed_at, status, updated_at
           FROM tasks
           WHERE recurring = 1
             AND recurrence_schedule IS NOT NULL
             AND status IN ('completed', 'failed')`,
        )
        .all() as Array<{
        id: number;
        title: string;
        recurrence_schedule: string;
        last_completed_at: string | null;
        status: string;
        updated_at: string;
      }>;

      if (tasks.length === 0) return;

      const now = new Date();
      let resetCount = 0;

      for (const task of tasks) {
        try {
          // For completed tasks use last_completed_at; for failed tasks use updated_at
          // (the time they were moved to failed) as the reference for scheduling.
          const referenceTime = task.last_completed_at ?? task.updated_at;
          const lastRun = new Date(referenceTime);
          const cron = new Cron(task.recurrence_schedule);
          const nextDue = cron.nextRun(lastRun);
          cron.stop();

          if (nextDue && nextDue <= now) {
            // Task is due -- reset to ready. Also reset retry_count so each new
            // cycle starts fresh and doesn't inherit stale-rescue counts from
            // previous cycles (prevents premature permanent failure).
            this.sharedDb!
              .prepare(
                `UPDATE tasks SET status = 'ready', claimed_by = NULL, claimed_at = NULL,
                 result = NULL, retry_count = 0, updated_at = datetime('now')
                 WHERE id = ?`,
              )
              .run(task.id);
            resetCount++;
            log.info(
              { taskId: task.id, title: task.title, schedule: task.recurrence_schedule },
              "recurring task reset to ready",
            );
          }
        } catch (e) {
          log.warn(
            { taskId: task.id, schedule: task.recurrence_schedule, err: e },
            "failed to evaluate recurrence schedule",
          );
        }
      }

      if (resetCount > 0) {
        log.info({ resetCount, checked: tasks.length }, "recurring task tick complete");
      }
    } catch (e) {
      log.error({ err: e }, "recurring task ticker failed");
    }
  }

  /** Start the stale task rescue ticker -- runs every 5 minutes. */
  private startStaleTaskTicker(): void {
    if (this.staleTaskTicker) {
      this.staleTaskTicker.stop();
    }

    this.staleTaskTicker = new Cron("*/5 * * * *", { protect: true }, () => {
      this.tickStaleTasks();
    });

    log.info("stale task rescue ticker started (every 5 minutes)");
  }

  /** Rescue abandoned in_progress tasks: reset to ready or fail after max retries. */
  private tickStaleTasks(): void {
    if (!this.sharedDb) return;

    const defaultCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    try {
      // Fetch all in_progress tasks; filter per-task below based on stale_timeout_hours
      const staleTasks = (
        this.sharedDb
          .prepare(
            `SELECT id, title, COALESCE(retry_count, 0) as retry_count, assigned_agent, recurring,
                    stale_timeout_hours, claimed_at
             FROM tasks
             WHERE status = 'in_progress'
               AND (claimed_at IS NULL OR claimed_at < ?)`,
          )
          .all(defaultCutoff) as Array<{
          id: number;
          title: string;
          retry_count: number;
          assigned_agent: string | null;
          recurring: number;
          stale_timeout_hours: number | null;
          claimed_at: string | null;
        }>
      ).filter((task) => {
        // If the task has a custom timeout, check it independently
        if (task.stale_timeout_hours != null && task.claimed_at != null) {
          const customCutoff = new Date(
            Date.now() - task.stale_timeout_hours * 60 * 60 * 1000,
          ).toISOString();
          return task.claimed_at < customCutoff;
        }
        return true; // Already filtered by defaultCutoff above
      });

      if (staleTasks.length === 0) return;

      let rescuedCount = 0;
      let failedCount = 0;

      for (const task of staleTasks) {
        const newRetryCount = task.retry_count + 1;
        // Recurring tasks get more retries since their schedule will reset retry_count
        // after each cycle; non-recurring tasks have a tighter cap.
        const maxRetries = task.recurring ? 5 : 3;

        if (newRetryCount > maxRetries) {
          // Too many rescues -- move to failed
          this.sharedDb
            .prepare(
              `UPDATE tasks SET status = 'failed', retry_count = ?,
               claimed_by = NULL, claimed_at = NULL, updated_at = datetime('now')
               WHERE id = ?`,
            )
            .run(newRetryCount, task.id);

          failedCount++;
          log.warn(
            { taskId: task.id, title: task.title, retryCount: newRetryCount, maxRetries },
            "stale task moved to failed after max retries",
          );

          this.logActivity(
            "task_failed_stale",
            `Task "${task.title}" failed after ${maxRetries} rescue attempts`,
            {
              taskId: task.id,
              details: JSON.stringify({ retryCount: newRetryCount, maxRetries }),
            },
          );

          this.wsServer?.broadcast({
            type: "task:failed_stale",
            taskId: task.id,
            title: task.title,
            retryCount: newRetryCount,
          });
        } else {
          // Reset to ready for another attempt
          this.sharedDb
            .prepare(
              `UPDATE tasks SET status = 'ready', retry_count = ?,
               claimed_by = NULL, claimed_at = NULL, updated_at = datetime('now')
               WHERE id = ?`,
            )
            .run(newRetryCount, task.id);

          rescuedCount++;
          log.info(
            { taskId: task.id, title: task.title, retryCount: newRetryCount, maxRetries },
            "stale task rescued, reset to ready",
          );

          this.logActivity(
            "task_rescued",
            `Task "${task.title}" rescued (attempt ${newRetryCount}/${maxRetries})`,
            {
              taskId: task.id,
              details: JSON.stringify({ retryCount: newRetryCount }),
            },
          );

          this.wsServer?.broadcast({
            type: "task:rescued",
            taskId: task.id,
            title: task.title,
            retryCount: newRetryCount,
          });
        }
      }

      if (rescuedCount > 0 || failedCount > 0) {
        log.info(
          { rescuedCount, failedCount, checked: staleTasks.length },
          "stale task rescue tick complete",
        );
      }
    } catch (e) {
      log.error({ err: e }, "stale task rescue ticker failed");
    }
  }

  /** Build the task-awareness prefix that gets injected into agent prompts at runtime.
   *  This standardizes task claim/complete behavior across all non-infrastructure agents. */
  private buildTaskPrefix(agentId: string): string {
    const token = this.webhookToken;
    const base = `http://127.0.0.1:${this.webhookPort}`;
    return `## Task Queue Check (auto-injected)
Before starting your default work, check for assigned tasks:
curl -s -H 'x-familiar-token: ${token}' '${base}/api/tasks/next?agent=${agentId}'
If a task is returned (task is not null):
1. Claim IMMEDIATELY: curl -s -X POST -H 'x-familiar-token: ${token}' -H 'Content-Type: application/json' '${base}/api/tasks/TASK_ID/claim' -d '{"agent":"${agentId}"}'
2. Do the work described in the task
3. Complete as your LAST action: curl -s -X POST -H 'x-familiar-token: ${token}' -H 'Content-Type: application/json' '${base}/api/tasks/TASK_ID/complete' -d '{"result":"Summary of what you did"}'
IMPORTANT: If you are running low on turns and cannot finish, complete with: '{"result":"PARTIAL: <describe progress and what remains>"}'
If no task is assigned, proceed with your default work below.

`;
  }

  /** Inject task prefix into prompt if the agent is not infrastructure. */
  private injectTaskPrefix(config: CronJobConfig): CronJobConfig {
    if (SKIP_TASK_PREFIX_AGENTS.has(config.id)) return config;
    // Don't double-inject if prompt already has task queue check
    if (config.prompt.includes("Task Queue Check")) return config;
    return { ...config, prompt: this.buildTaskPrefix(config.id) + config.prompt };
  }

  private async acquireSlot(jobId: string): Promise<void> {
    if (this.concurrentCount < this.maxConcurrent) {
      this.concurrentCount++;
      return;
    }
    log.info(
      { jobId, queue: this.waitQueue.length, running: this.concurrentCount },
      "waiting for concurrency slot",
    );
    return new Promise<void>((resolve) => {
      this.waitQueue.push({ resolve });
    });
  }

  private releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next.resolve();
    } else {
      this.concurrentCount--;
    }
  }

  private scheduleJob(config: CronJobConfig): Cron {
    return new Cron(
      config.schedule,
      {
        timezone: config.timezone ?? "UTC",
        protect: true, // Don't overlap runs
      },
      async () => {
        await this.executeJob(config);
      },
    );
  }

  /** Execute a job and record with a specific schedule ID (for DB-backed jobs). */
  private async executeJobWithScheduleId(
    config: CronJobConfig,
    scheduleId: string,
  ): Promise<CronRunResult> {
    if (this.running.get(scheduleId)) {
      log.warn({ jobId: scheduleId }, "job already running, skipping");
      return {
        jobId: scheduleId,
        text: "Skipped: previous run still in progress",
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        isError: false,
        startedAt: new Date(),
        finishedAt: new Date(),
      };
    }

    // Budget check
    const budgetCheck = this.checkBudget(config.id);
    if (!budgetCheck.allowed) {
      const msg = `Budget exceeded: agent ${config.id} spent $${budgetCheck.dailyCostUsd.toFixed(4)} today (limit $${budgetCheck.budgetUsd.toFixed(4)})`;
      log.warn({ agentId: config.id, scheduleId, dailyCostUsd: budgetCheck.dailyCostUsd, budgetUsd: budgetCheck.budgetUsd }, msg);
      this.wsServer?.broadcast({
        type: "schedule:budget_exceeded",
        scheduleId,
        agentId: config.id,
        dailyCostUsd: budgetCheck.dailyCostUsd,
        budgetUsd: budgetCheck.budgetUsd,
      });
      this.logActivity("budget_exceeded", msg, { agentId: config.id, scheduleId });
      return {
        jobId: scheduleId,
        text: msg,
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        isError: false,
        startedAt: new Date(),
        finishedAt: new Date(),
      };
    }

    this.running.set(scheduleId, true);
    await this.acquireSlot(scheduleId);

    // Broadcast start event
    this.wsServer?.broadcast({ type: "schedule:started", scheduleId, agentId: config.id });
    this.logActivity("schedule_run", `Schedule ${scheduleId} started`, {
      agentId: config.id,
      scheduleId,
    });

    try {
      log.info({ scheduleId, agentId: config.id, concurrent: this.concurrentCount }, "executing DB job");
      const effectiveConfig = this.injectTaskPrefix(config);
      const result = await runCronJob(effectiveConfig, this.claudeConfig, { workspace: this.workspace });

      // Record with schedule ID
      const resultForRecording = { ...result, jobId: scheduleId };
      const runId = this.recordRun(resultForRecording);

      // Post-run validation (only if run succeeded or made commits despite errors)
      if (!result.isError) {
        this.runPostValidation(config.id, config.workingDirectory, result.startedAt);
      }

      // Update next run time
      const cron = this.jobs.get(scheduleId);
      if (cron) {
        const next = cron.nextRun();
        if (next) this.updateNextRun(scheduleId, next.toISOString());
      }

      // Broadcast completion event + log activity
      this.wsServer?.broadcast({
        type: "schedule:completed",
        scheduleId,
        agentId: config.id,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        isError: result.isError,
      });
      const summary = result.isError
        ? `Schedule ${scheduleId} failed (${result.durationMs}ms)`
        : `Schedule ${scheduleId} completed (${result.durationMs}ms, $${result.costUsd.toFixed(4)})`;
      this.logActivity("schedule_run", summary, {
        agentId: config.id,
        scheduleId,
        details: JSON.stringify({ durationMs: result.durationMs, costUsd: result.costUsd, isError: result.isError }),
      });

      // Deliver result
      if (config.announce !== false && this.deliveryHandler) {
        let suppressed = false;
        if (config.suppressPattern) {
          try {
            suppressed = new RegExp(config.suppressPattern).test(result.text);
          } catch {
            log.warn({ jobId: scheduleId, pattern: config.suppressPattern }, "invalid suppressPattern");
          }
        }

        if (suppressed) {
          log.info({ jobId: scheduleId }, "delivery suppressed by pattern match");
        } else {
          try {
            await this.deliveryHandler(config.id, result, config, runId);
          } catch (e) {
            log.error({ jobId: scheduleId, err: e }, "delivery failed");
          }
        }
      }

      return result;
    } finally {
      this.releaseSlot();
      this.running.set(scheduleId, false);
      // Record finish time so the chained-fire guard can detect immediate re-fires.
      this.lastFinishedAt.set(scheduleId, Date.now());
    }
  }

  private async executeJob(config: CronJobConfig): Promise<CronRunResult> {
    // Prevent overlapping runs of the same job
    if (this.running.get(config.id)) {
      log.warn({ jobId: config.id }, "job already running, skipping");
      return {
        jobId: config.id,
        text: "Skipped: previous run still in progress",
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        isError: false,
        startedAt: new Date(),
        finishedAt: new Date(),
      };
    }

    // Budget check
    const budgetCheck = this.checkBudget(config.id);
    if (!budgetCheck.allowed) {
      const msg = `Budget exceeded: agent ${config.id} spent $${budgetCheck.dailyCostUsd.toFixed(4)} today (limit $${budgetCheck.budgetUsd.toFixed(4)})`;
      log.warn({ agentId: config.id, dailyCostUsd: budgetCheck.dailyCostUsd, budgetUsd: budgetCheck.budgetUsd }, msg);
      this.wsServer?.broadcast({
        type: "schedule:budget_exceeded",
        scheduleId: config.id,
        agentId: config.id,
        dailyCostUsd: budgetCheck.dailyCostUsd,
        budgetUsd: budgetCheck.budgetUsd,
      });
      this.logActivity("budget_exceeded", msg, { agentId: config.id, scheduleId: config.id });
      return {
        jobId: config.id,
        text: msg,
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        isError: false,
        startedAt: new Date(),
        finishedAt: new Date(),
      };
    }

    this.running.set(config.id, true);
    await this.acquireSlot(config.id);

    // Broadcast start event
    this.wsServer?.broadcast({ type: "schedule:started", scheduleId: config.id, agentId: config.id });
    this.logActivity("schedule_run", `Job ${config.id} started`, { agentId: config.id, scheduleId: config.id });

    try {
      log.info({ jobId: config.id, concurrent: this.concurrentCount }, "executing job");
      const effectiveConfig = this.injectTaskPrefix(config);
      const result = await runCronJob(effectiveConfig, this.claudeConfig, { workspace: this.workspace });
      const runId = this.recordRun(result);

      // Post-run validation (only if run succeeded or made commits despite errors)
      if (!result.isError) {
        this.runPostValidation(config.id, config.workingDirectory, result.startedAt);
      }

      // Update next run time
      const cron = this.jobs.get(config.id);
      if (cron) {
        const next = cron.nextRun();
        if (next) this.updateNextRun(config.id, next.toISOString());
      }

      // Broadcast completion event + log activity
      this.wsServer?.broadcast({
        type: "schedule:completed",
        scheduleId: config.id,
        agentId: config.id,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        isError: result.isError,
      });
      const summary = result.isError
        ? `Job ${config.id} failed (${result.durationMs}ms)`
        : `Job ${config.id} completed (${result.durationMs}ms, $${result.costUsd.toFixed(4)})`;
      this.logActivity("schedule_run", summary, {
        agentId: config.id,
        scheduleId: config.id,
        details: JSON.stringify({ durationMs: result.durationMs, costUsd: result.costUsd, isError: result.isError }),
      });

      // Deliver result (unless suppressed by pattern match)
      if (config.announce !== false && this.deliveryHandler) {
        let suppressed = false;
        if (config.suppressPattern) {
          try {
            suppressed = new RegExp(config.suppressPattern).test(result.text);
          } catch {
            log.warn(
              { jobId: config.id, pattern: config.suppressPattern },
              "invalid suppressPattern",
            );
          }
        }

        if (suppressed) {
          log.info({ jobId: config.id }, "delivery suppressed by pattern match");
        } else {
          try {
            await this.deliveryHandler(config.id, result, config, runId);
          } catch (e) {
            log.error({ jobId: config.id, err: e }, "delivery failed");
          }
        }
      }

      return result;
    } finally {
      this.releaseSlot();
      this.running.set(config.id, false);
    }
  }

  private recordRun(result: CronRunResult): number {
    // Insert run record
    const info = this.db
      .prepare(
        `INSERT INTO cron_runs (job_id, started_at, finished_at, duration_ms, cost_usd, num_turns, is_error, result_text, run_log)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.jobId,
        result.startedAt.toISOString(),
        result.finishedAt.toISOString(),
        result.durationMs,
        result.costUsd,
        result.numTurns,
        result.isError ? 1 : 0,
        result.text,
        result.runLog ?? null,
      );

    // Update state
    this.db
      .prepare(
        `INSERT INTO cron_state (job_id, last_run_at, run_count, last_error, last_duration_ms, last_cost_usd)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           run_count = run_count + 1,
           last_error = excluded.last_error,
           last_duration_ms = excluded.last_duration_ms,
           last_cost_usd = excluded.last_cost_usd`,
      )
      .run(
        result.jobId,
        result.finishedAt.toISOString(),
        result.isError ? result.text.slice(0, 500) : null,
        result.durationMs,
        result.costUsd,
      );
    return info.lastInsertRowid as number;
  }

  private updateNextRun(jobId: string, nextRunAt: string): void {
    this.db
      .prepare(
        `INSERT INTO cron_state (job_id, next_run_at)
         VALUES (?, ?)
         ON CONFLICT(job_id) DO UPDATE SET next_run_at = excluded.next_run_at`,
      )
      .run(jobId, nextRunAt);
  }

  private getJobState(jobId: string):
    | {
        last_run_at: string | null;
        next_run_at: string | null;
        run_count: number;
      }
    | undefined {
    return this.db
      .prepare("SELECT last_run_at, next_run_at, run_count FROM cron_state WHERE job_id = ?")
      .get(jobId) as
      | { last_run_at: string | null; next_run_at: string | null; run_count: number }
      | undefined;
  }

  /** Sum cost_usd for a given agent across all job IDs in the last 24 hours.
   *  Costs are recorded under schedule_id (e.g. "heartbeat-default"), so we
   *  match both the exact agent_id and any schedule_id prefixed with it. */
  getDailyAgentCost(agentId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total
         FROM cron_runs
         WHERE (job_id = ? OR job_id LIKE ? || '-%')
           AND started_at >= datetime('now', '-1 day')`,
      )
      .get(agentId, agentId) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  /**
   * Check whether agentId is over its daily budget.
   * Returns { allowed: true } if under budget or no budget set,
   * or { allowed: false, dailyCostUsd, budgetUsd } if over budget.
   */
  private checkBudget(
    agentId: string,
  ): { allowed: true } | { allowed: false; dailyCostUsd: number; budgetUsd: number } {
    if (!this.sharedDb) return { allowed: true };

    const agent = this.sharedDb
      .prepare("SELECT daily_budget_usd FROM agents WHERE id = ?")
      .get(agentId) as { daily_budget_usd: number | null } | undefined;

    if (!agent || agent.daily_budget_usd === null) return { allowed: true };

    const dailyCostUsd = this.getDailyAgentCost(agentId);
    if (dailyCostUsd >= agent.daily_budget_usd) {
      return { allowed: false, dailyCostUsd, budgetUsd: agent.daily_budget_usd };
    }
    return { allowed: true };
  }
}
