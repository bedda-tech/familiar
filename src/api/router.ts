/**
 * REST API Router for the Familiar dashboard.
 *
 * Handles all /api/* routes. Decoupled from the HTTP server so it can
 * be tested and extended independently.
 *
 * Endpoints:
 *   GET  /api/agents                     — list active + recent sub-agents
 *   GET  /api/cron                       — list all cron jobs with state
 *   GET  /api/cron/jobs                  — alias for /api/cron
 *   GET  /api/cron/jobs/:id/runs         — run history for a specific job
 *   POST /api/cron/:id/run               — manually trigger a cron job
 *   POST /api/cron/jobs/:id/run          — alias (matches dashboard)
 */

import type { ServerResponse } from "node:http";
import type { CronScheduler } from "../cron/scheduler.js";
import type { AgentStore } from "../agents/store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("api-router");

export class ApiRouter {
  private cronScheduler: CronScheduler | null = null;
  private agentStore: AgentStore | null = null;

  setCronScheduler(scheduler: CronScheduler): void {
    this.cronScheduler = scheduler;
  }

  setAgentStore(store: AgentStore): void {
    this.agentStore = store;
  }

  /**
   * Handle a request. Returns true if the route matched (response was sent),
   * false if no route matched (caller should send 404).
   */
  async handle(method: string, url: string, res: ServerResponse): Promise<boolean> {
    if (method === "GET") {
      if (url === "/api/agents") {
        this.handleListAgents(res);
        return true;
      }

      if (url === "/api/cron" || url === "/api/cron/jobs") {
        this.handleListCronJobs(res);
        return true;
      }

      // /api/cron/jobs/:id/runs  or  /api/cron/:id/runs
      const runsMatch = url.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)\/runs$/);
      if (runsMatch) {
        this.handleGetCronRuns(decodeURIComponent(runsMatch[1]), res);
        return true;
      }
    }

    if (method === "POST") {
      // /api/cron/jobs/:id/run  or  /api/cron/:id/run
      const runMatch = url.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)\/run$/);
      if (runMatch) {
        await this.handleTriggerCronJob(decodeURIComponent(runMatch[1]), res);
        return true;
      }
    }

    return false;
  }

  // ── Handlers ────────────────────────────────────────────────────────

  private handleListAgents(res: ServerResponse): void {
    if (!this.agentStore) {
      sendJson(res, 503, { error: "Agent manager not available" });
      return;
    }
    sendJson(res, 200, this.agentStore.getState() as unknown as Record<string, unknown>);
  }

  private handleListCronJobs(res: ServerResponse): void {
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }
    const jobs = this.cronScheduler.listJobs();
    sendJson(res, 200, { jobs });
  }

  private handleGetCronRuns(jobId: string, res: ServerResponse): void {
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }
    const runs = this.cronScheduler.getRunHistory(jobId, 20);
    sendJson(res, 200, { jobId, runs });
  }

  private async handleTriggerCronJob(jobId: string, res: ServerResponse): Promise<void> {
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }

    log.info({ jobId }, "manual cron trigger via API");
    const result = await this.cronScheduler.runNow(jobId);

    if (!result) {
      sendJson(res, 404, { error: `Job '${jobId}' not found` });
      return;
    }

    sendJson(res, 200, {
      status: result.isError ? "error" : "ok",
      jobId: result.jobId,
      text: result.text,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
    });
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
