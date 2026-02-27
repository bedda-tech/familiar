/**
 * REST API Router for the Familiar dashboard.
 *
 * Handles all /api/* routes. Decoupled from the HTTP server so it can
 * be tested and extended independently.
 *
 * Endpoints:
 *   GET  /api/agents                     — list active + recent sub-agents
 *   GET  /api/agents/:id                 — get single agent details
 *   GET  /api/cron                       — list all cron jobs with state
 *   GET  /api/cron/jobs                  — alias for /api/cron
 *   GET  /api/cron/jobs/:id              — get single job config + state
 *   GET  /api/cron/jobs/:id/runs         — run history for a specific job
 *   POST /api/cron/jobs                  — create a new cron job
 *   POST /api/cron/:id/run              — manually trigger a cron job
 *   POST /api/cron/jobs/:id/run         — alias (matches dashboard)
 *   PUT  /api/cron/jobs/:id             — update a cron job config
 *   DELETE /api/cron/jobs/:id           — delete a cron job
 *   GET  /api/config                    — get sanitized config
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { CronScheduler } from "../cron/scheduler.js";
import type { AgentStore } from "../agents/store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("api-router");

export class ApiRouter {
  private cronScheduler: CronScheduler | null = null;
  private agentStore: AgentStore | null = null;
  private configPath: string | null = null;
  private onConfigChange: (() => Promise<void>) | null = null;

  setCronScheduler(scheduler: CronScheduler): void {
    this.cronScheduler = scheduler;
  }

  setAgentStore(store: AgentStore): void {
    this.agentStore = store;
  }

  setConfigPath(path: string): void {
    this.configPath = path;
  }

  setConfigChangeHandler(handler: () => Promise<void>): void {
    this.onConfigChange = handler;
  }

  /**
   * Handle a request. Returns true if the route matched (response was sent),
   * false if no route matched (caller should send 404).
   */
  async handle(
    method: string,
    url: string,
    res: ServerResponse,
    body?: Record<string, unknown>,
  ): Promise<boolean> {
    // Strip query string for route matching, but keep it for parameter extraction
    const [path, queryString] = url.split("?", 2);

    if (method === "GET") {
      // GET /api/agents
      if (path === "/api/agents") {
        this.handleListAgents(res);
        return true;
      }

      // GET /api/agents/:id
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch) {
        this.handleGetAgent(decodeURIComponent(agentMatch[1]), res);
        return true;
      }

      // GET /api/cron or /api/cron/jobs (list all)
      if (path === "/api/cron" || path === "/api/cron/jobs") {
        this.handleListCronJobs(res);
        return true;
      }

      // GET /api/cron/jobs/:id/runs or /api/cron/:id/runs
      const runsMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)\/runs$/);
      if (runsMatch) {
        const params = new URLSearchParams(queryString ?? "");
        const limit = parseInt(params.get("limit") ?? "20", 10);
        this.handleGetCronRuns(decodeURIComponent(runsMatch[1]), Math.min(Math.max(limit, 1), 100), res);
        return true;
      }

      // GET /api/cron/jobs/:id or /api/cron/:id (single job — AFTER /runs match)
      const singleJobMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)$/);
      if (singleJobMatch) {
        this.handleGetCronJob(decodeURIComponent(singleJobMatch[1]), res);
        return true;
      }

      // GET /api/config
      if (path === "/api/config") {
        this.handleGetConfig(res);
        return true;
      }
    }

    if (method === "POST") {
      // POST /api/cron/jobs or /api/cron (create new job) — must match BEFORE :id/run
      if ((path === "/api/cron/jobs" || path === "/api/cron") && body) {
        await this.handleCreateCronJob(body, res);
        return true;
      }

      // POST /api/cron/jobs/:id/run or /api/cron/:id/run
      const runMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)\/run$/);
      if (runMatch) {
        await this.handleTriggerCronJob(decodeURIComponent(runMatch[1]), res);
        return true;
      }
    }

    if (method === "PUT") {
      // PUT /api/cron/jobs/:id or /api/cron/:id
      const updateMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)$/);
      if (updateMatch && body) {
        await this.handleUpdateCronJob(decodeURIComponent(updateMatch[1]), body, res);
        return true;
      }
    }

    if (method === "DELETE") {
      // DELETE /api/cron/jobs/:id or /api/cron/:id
      const deleteMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)$/);
      if (deleteMatch) {
        await this.handleDeleteCronJob(decodeURIComponent(deleteMatch[1]), res);
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

  private handleGetAgent(agentId: string, res: ServerResponse): void {
    if (!this.agentStore) {
      sendJson(res, 503, { error: "Agent manager not available" });
      return;
    }
    const agent = this.agentStore.getAgent(agentId);
    if (!agent) {
      sendJson(res, 404, { error: `Agent '${agentId}' not found` });
      return;
    }
    sendJson(res, 200, { agent: agent as unknown as Record<string, unknown> });
  }

  private handleListCronJobs(res: ServerResponse): void {
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }
    const jobs = this.cronScheduler.listJobs();
    sendJson(res, 200, { jobs });
  }

  private handleGetCronJob(jobId: string, res: ServerResponse): void {
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }
    const jobs = this.cronScheduler.listJobs();
    const job = jobs.find((j: any) => j.id === jobId);
    if (!job) {
      sendJson(res, 404, { error: `Job '${jobId}' not found` });
      return;
    }
    sendJson(res, 200, { job });
  }

  private handleGetCronRuns(jobId: string, limit: number, res: ServerResponse): void {
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }
    const runs = this.cronScheduler.getRunHistory(jobId, limit);
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

  // ── Cron CRUD Handlers ──────────────────────────────────────────────

  private async handleCreateCronJob(
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.configPath) {
      sendJson(res, 503, { error: "Config not available" });
      return;
    }

    const { id, schedule, prompt } = body as any;
    if (!id || !schedule || !prompt) {
      sendJson(res, 400, { error: "Missing required fields: id, schedule, prompt" });
      return;
    }

    let config: any;
    try {
      config = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch (e) {
      log.error({ err: e }, "failed to read config for cron create");
      sendJson(res, 500, { error: "Failed to read config" });
      return;
    }

    if (!config.cron?.jobs) {
      config.cron = { ...(config.cron ?? {}), jobs: [] };
    }

    if (config.cron.jobs.find((j: any) => j.id === id)) {
      sendJson(res, 409, { error: `Job '${id}' already exists` });
      return;
    }

    const newJob: Record<string, unknown> = {
      id,
      label: body.label || id,
      schedule,
      timezone: body.timezone || "UTC",
      prompt,
      model: body.model || "sonnet",
      maxTurns: body.maxTurns || 10,
      workingDirectory: body.workingDirectory || process.env.HOME,
      announce: body.announce !== false,
      enabled: body.enabled !== false,
    };

    if (body.suppressPattern) {
      newJob.suppressPattern = body.suppressPattern;
    }
    if (body.deliverTo) {
      newJob.deliverTo = body.deliverTo;
    }

    config.cron.jobs.push(newJob);

    try {
      writeFileSync(this.configPath, JSON.stringify(config, null, 2) + "\n");
    } catch (e) {
      log.error({ err: e }, "failed to write config for cron create");
      sendJson(res, 500, { error: "Failed to write config" });
      return;
    }

    log.info({ jobId: id }, "cron job created via API");

    if (this.onConfigChange) {
      try {
        await this.onConfigChange();
      } catch (e) {
        log.warn({ err: e }, "config change handler failed after cron create");
      }
    }

    sendJson(res, 201, { status: "created", job: newJob });
  }

  private async handleUpdateCronJob(
    jobId: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.configPath) {
      sendJson(res, 503, { error: "Config not available" });
      return;
    }

    let config: any;
    try {
      config = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch (e) {
      log.error({ err: e }, "failed to read config for cron update");
      sendJson(res, 500, { error: "Failed to read config" });
      return;
    }

    if (!config.cron?.jobs) {
      sendJson(res, 404, { error: `Job '${jobId}' not found` });
      return;
    }

    const idx = config.cron.jobs.findIndex((j: any) => j.id === jobId);
    if (idx === -1) {
      sendJson(res, 404, { error: `Job '${jobId}' not found` });
      return;
    }

    // Merge fields (id cannot be changed)
    const existing = config.cron.jobs[idx];
    const updatable = [
      "label",
      "schedule",
      "timezone",
      "prompt",
      "model",
      "maxTurns",
      "workingDirectory",
      "announce",
      "suppressPattern",
      "enabled",
      "deliverTo",
    ];
    for (const key of updatable) {
      if (key in body) {
        existing[key] = body[key];
      }
    }

    config.cron.jobs[idx] = existing;

    try {
      writeFileSync(this.configPath, JSON.stringify(config, null, 2) + "\n");
    } catch (e) {
      log.error({ err: e }, "failed to write config for cron update");
      sendJson(res, 500, { error: "Failed to write config" });
      return;
    }

    log.info({ jobId }, "cron job updated via API");

    if (this.onConfigChange) {
      try {
        await this.onConfigChange();
      } catch (e) {
        log.warn({ err: e }, "config change handler failed after cron update");
      }
    }

    sendJson(res, 200, { status: "updated", job: existing });
  }

  private async handleDeleteCronJob(jobId: string, res: ServerResponse): Promise<void> {
    if (!this.configPath) {
      sendJson(res, 503, { error: "Config not available" });
      return;
    }

    let config: any;
    try {
      config = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch (e) {
      log.error({ err: e }, "failed to read config for cron delete");
      sendJson(res, 500, { error: "Failed to read config" });
      return;
    }

    if (!config.cron?.jobs) {
      sendJson(res, 404, { error: `Job '${jobId}' not found` });
      return;
    }

    const idx = config.cron.jobs.findIndex((j: any) => j.id === jobId);
    if (idx === -1) {
      sendJson(res, 404, { error: `Job '${jobId}' not found` });
      return;
    }

    const removed = config.cron.jobs.splice(idx, 1)[0];

    try {
      writeFileSync(this.configPath, JSON.stringify(config, null, 2) + "\n");
    } catch (e) {
      log.error({ err: e }, "failed to write config for cron delete");
      sendJson(res, 500, { error: "Failed to write config" });
      return;
    }

    log.info({ jobId }, "cron job deleted via API");

    if (this.onConfigChange) {
      try {
        await this.onConfigChange();
      } catch (e) {
        log.warn({ err: e }, "config change handler failed after cron delete");
      }
    }

    sendJson(res, 200, { status: "deleted", job: removed });
  }

  // ── Config Handler ──────────────────────────────────────────────────

  private handleGetConfig(res: ServerResponse): void {
    if (!this.configPath) {
      sendJson(res, 503, { error: "Config not available" });
      return;
    }

    let config: any;
    try {
      config = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch (e) {
      log.error({ err: e }, "failed to read config");
      sendJson(res, 500, { error: "Failed to read config" });
      return;
    }

    // Sanitize sensitive fields — mask tokens and keys
    const sanitized = JSON.parse(JSON.stringify(config));
    if (sanitized.telegram?.botToken) {
      sanitized.telegram.botToken = maskToken(sanitized.telegram.botToken);
    }
    if (sanitized.webhooks?.token) {
      sanitized.webhooks.token = maskToken(sanitized.webhooks.token);
    }
    if (sanitized.openai?.apiKey) {
      sanitized.openai.apiKey = maskToken(sanitized.openai.apiKey);
    }
    if (sanitized.claude?.apiKey) {
      sanitized.claude.apiKey = maskToken(sanitized.claude.apiKey);
    }

    sendJson(res, 200, { config: sanitized });
  }
}

/** Mask a token/key, showing only the last 4 characters. */
function maskToken(token: string): string {
  if (token.length <= 4) return "****";
  return "****" + token.slice(-4);
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
