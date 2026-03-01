import { Cron } from "croner";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
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

const log = getLogger("cron-scheduler");

export interface CronDeliveryHandler {
  (jobId: string, result: CronRunResult, config: CronJobConfig): Promise<void>;
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
  /** WebSocket server for broadcasting events. */
  private wsServer: WsServer | null = null;

  constructor(jobConfigs: CronJobConfig[], claudeConfig: ClaudeConfig, dbPath?: string) {
    this.claudeConfig = claudeConfig;
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
                  a.suppress_pattern, a.deliver_to, a.mcp_config, a.enabled as agent_enabled
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
          };

          const cron = new Cron(
            row.schedule as string,
            {
              timezone: ((row.timezone as string) ?? "UTC") as string,
              protect: true,
            },
            async () => {
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
                    a.enabled as agent_enabled
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

  /** Start the recurring task ticker -- runs every minute to reset due recurring tasks. */
  private startRecurringTicker(): void {
    if (this.recurringTicker) {
      this.recurringTicker.stop();
    }

    this.recurringTicker = new Cron("* * * * *", { protect: true }, () => {
      this.tickRecurringTasks();
    });

    log.info("recurring task ticker started (every minute)");
  }

  /** Check completed recurring tasks and reset those that are due. */
  private tickRecurringTasks(): void {
    if (!this.sharedDb) return;

    try {
      const tasks = this.sharedDb
        .prepare(
          `SELECT * FROM tasks
           WHERE recurring = 1
             AND recurrence_schedule IS NOT NULL
             AND status = 'completed'
             AND last_completed_at IS NOT NULL`,
        )
        .all() as Array<{
        id: number;
        title: string;
        recurrence_schedule: string;
        last_completed_at: string;
      }>;

      if (tasks.length === 0) return;

      const now = new Date();
      let resetCount = 0;

      for (const task of tasks) {
        try {
          // Use croner to find the next occurrence after the last completion
          const lastCompleted = new Date(task.last_completed_at);
          const cron = new Cron(task.recurrence_schedule);
          const nextDue = cron.nextRun(lastCompleted);
          cron.stop();

          if (nextDue && nextDue <= now) {
            // Task is due -- reset to ready
            this.sharedDb!
              .prepare(
                `UPDATE tasks SET status = 'ready', claimed_by = NULL, claimed_at = NULL,
                 result = NULL, updated_at = datetime('now')
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
      const result = await runCronJob(config, this.claudeConfig, { workspace: this.workspace });

      // Record with schedule ID
      const resultForRecording = { ...result, jobId: scheduleId };
      this.recordRun(resultForRecording);

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
            await this.deliveryHandler(config.id, result, config);
          } catch (e) {
            log.error({ jobId: scheduleId, err: e }, "delivery failed");
          }
        }
      }

      return result;
    } finally {
      this.releaseSlot();
      this.running.set(scheduleId, false);
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

    this.running.set(config.id, true);
    await this.acquireSlot(config.id);

    // Broadcast start event
    this.wsServer?.broadcast({ type: "schedule:started", scheduleId: config.id, agentId: config.id });
    this.logActivity("schedule_run", `Job ${config.id} started`, { agentId: config.id, scheduleId: config.id });

    try {
      log.info({ jobId: config.id, concurrent: this.concurrentCount }, "executing job");
      const result = await runCronJob(config, this.claudeConfig, { workspace: this.workspace });
      this.recordRun(result);

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
            await this.deliveryHandler(config.id, result, config);
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

  private recordRun(result: CronRunResult): void {
    // Insert run record
    this.db
      .prepare(
        `INSERT INTO cron_runs (job_id, started_at, finished_at, duration_ms, cost_usd, num_turns, is_error, result_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.jobId,
        result.startedAt.toISOString(),
        result.finishedAt.toISOString(),
        result.durationMs,
        result.costUsd,
        result.numTurns,
        result.isError ? 1 : 0,
        result.text.slice(0, 10000),
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
}
