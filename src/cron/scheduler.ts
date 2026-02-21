import { Cron } from "croner";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { CronJobConfig, CronRunResult } from "./types.js";
import type { ClaudeConfig } from "../config.js";
import { runCronJob } from "./runner.js";
import { getConfigDir } from "../config.js";
import { getLogger } from "../util/logger.js";

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

  constructor(
    jobConfigs: CronJobConfig[],
    claudeConfig: ClaudeConfig,
    dbPath?: string,
  ) {
    this.claudeConfig = claudeConfig;

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

  /** Set the handler for delivering cron results to the user. */
  onDelivery(handler: CronDeliveryHandler): void {
    this.deliveryHandler = handler;
  }

  /** Start all enabled cron jobs. */
  start(): void {
    for (const [id, config] of this.configs) {
      if (config.enabled === false) {
        log.info({ jobId: id }, "skipping disabled job");
        continue;
      }

      try {
        const cron = this.scheduleJob(config);
        this.jobs.set(id, cron);
        const next = cron.nextRun();
        const nextStr = next ? next.toISOString() : "unknown";
        this.updateNextRun(id, nextStr);
        log.info({ jobId: id, schedule: config.schedule, timezone: config.timezone, next: nextStr }, "scheduled cron job");
      } catch (e) {
        log.error({ jobId: id, err: e }, "failed to schedule job");
      }
    }

    log.info({ jobCount: this.jobs.size }, "cron scheduler started");
  }

  /** Stop all cron jobs. */
  stop(): void {
    for (const [id, cron] of this.jobs) {
      cron.stop();
      log.debug({ jobId: id }, "stopped job");
    }
    this.jobs.clear();
    this.db.close();
    log.info("cron scheduler stopped");
  }

  /** Manually trigger a job by ID. */
  async runNow(jobId: string): Promise<CronRunResult | null> {
    const config = this.configs.get(jobId);
    if (!config) {
      log.warn({ jobId }, "job not found");
      return null;
    }
    return this.executeJob(config);
  }

  /** List all configured jobs with their state. */
  listJobs(): Array<CronJobConfig & { nextRun: string | null; lastRun: string | null; runCount: number }> {
    return Array.from(this.configs.values()).map((config) => {
      const state = this.getJobState(config.id);
      // Use live scheduler if running, otherwise compute from expression
      const liveCron = this.jobs.get(config.id);
      let next = liveCron?.nextRun();
      if (!next && config.enabled !== false) {
        try {
          const tmp = new Cron(config.schedule, { timezone: config.timezone ?? "UTC" });
          next = tmp.nextRun() ?? undefined;
          tmp.stop();
        } catch {
          // Invalid schedule — leave null
        }
      }
      return {
        ...config,
        nextRun: next?.toISOString() ?? state?.next_run_at ?? null,
        lastRun: state?.last_run_at ?? null,
        runCount: state?.run_count ?? 0,
      };
    });
  }

  /** Get recent run history for a job. */
  getRunHistory(jobId: string, limit: number = 10): Array<{
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    costUsd: number;
    isError: boolean;
    resultPreview: string;
  }> {
    const rows = this.db
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

    return rows.map((r) => ({
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      costUsd: r.cost_usd,
      isError: r.is_error === 1,
      resultPreview: r.result_text?.slice(0, 200) ?? "",
    }));
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

    try {
      const result = await runCronJob(config, this.claudeConfig);
      this.recordRun(result);

      // Update next run time
      const cron = this.jobs.get(config.id);
      if (cron) {
        const next = cron.nextRun();
        if (next) this.updateNextRun(config.id, next.toISOString());
      }

      // Deliver result (unless suppressed by pattern match)
      if (config.announce !== false && this.deliveryHandler) {
        let suppressed = false;
        if (config.suppressPattern) {
          try {
            suppressed = new RegExp(config.suppressPattern).test(result.text);
          } catch {
            log.warn({ jobId: config.id, pattern: config.suppressPattern }, "invalid suppressPattern");
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

  private getJobState(jobId: string): {
    last_run_at: string | null;
    next_run_at: string | null;
    run_count: number;
  } | undefined {
    return this.db
      .prepare("SELECT last_run_at, next_run_at, run_count FROM cron_state WHERE job_id = ?")
      .get(jobId) as { last_run_at: string | null; next_run_at: string | null; run_count: number } | undefined;
  }
}
