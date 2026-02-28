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
import type { AgentCrudStore } from "../agents/agent-store.js";
import type { TaskStore } from "../tasks/store.js";
import type { ScheduleStore } from "../schedules/store.js";
import type { ProjectStore } from "../projects/store.js";
import type { ToolStore } from "../tools/store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("api-router");

export class ApiRouter {
  private cronScheduler: CronScheduler | null = null;
  private agentStore: AgentStore | null = null;
  private agentCrudStore: AgentCrudStore | null = null;
  private taskStore: TaskStore | null = null;
  private scheduleStore: ScheduleStore | null = null;
  private projectStore: ProjectStore | null = null;
  private toolStore: ToolStore | null = null;
  private configPath: string | null = null;
  private onConfigChange: (() => Promise<void>) | null = null;

  setCronScheduler(scheduler: CronScheduler): void {
    this.cronScheduler = scheduler;
  }

  setAgentStore(store: AgentStore): void {
    this.agentStore = store;
  }

  setAgentCrudStore(store: AgentCrudStore): void {
    this.agentCrudStore = store;
  }

  setConfigPath(path: string): void {
    this.configPath = path;
  }

  setTaskStore(store: TaskStore): void {
    this.taskStore = store;
  }

  setScheduleStore(store: ScheduleStore): void {
    this.scheduleStore = store;
  }

  setProjectStore(store: ProjectStore): void {
    this.projectStore = store;
  }

  setToolStore(store: ToolStore): void {
    this.toolStore = store;
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
      // ── Persistent Agents (CRUD) ──
      if (path === "/api/agents") {
        if (this.agentCrudStore) {
          sendJson(res, 200, { agents: this.agentCrudStore.list() });
        } else {
          this.handleListAgents(res);
        }
        return true;
      }
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch) {
        const id = decodeURIComponent(agentMatch[1]);
        if (this.agentCrudStore) {
          const agent = this.agentCrudStore.get(id);
          if (!agent) {
            sendJson(res, 404, { error: `Agent '${id}' not found` });
          } else {
            sendJson(res, 200, { agent });
          }
        } else {
          this.handleGetAgent(id, res);
        }
        return true;
      }

      // ── Schedules ──
      if (path === "/api/schedules") {
        if (!this.scheduleStore) {
          sendJson(res, 503, { error: "Schedule store not available" });
        } else {
          const params = new URLSearchParams(queryString ?? "");
          const agentId = params.get("agent_id") ?? undefined;
          sendJson(res, 200, { schedules: this.scheduleStore.list({ agent_id: agentId }) });
        }
        return true;
      }
      const scheduleMatch = path.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleMatch) {
        if (!this.scheduleStore) {
          sendJson(res, 503, { error: "Schedule store not available" });
        } else {
          const s = this.scheduleStore.get(decodeURIComponent(scheduleMatch[1]));
          if (!s) sendJson(res, 404, { error: "Schedule not found" });
          else sendJson(res, 200, { schedule: s });
        }
        return true;
      }

      // ── Projects ──
      if (path === "/api/projects") {
        if (!this.projectStore) {
          sendJson(res, 503, { error: "Project store not available" });
        } else {
          sendJson(res, 200, { projects: this.projectStore.list() });
        }
        return true;
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        if (!this.projectStore) {
          sendJson(res, 503, { error: "Project store not available" });
        } else {
          const p = this.projectStore.get(decodeURIComponent(projectMatch[1]));
          if (!p) sendJson(res, 404, { error: "Project not found" });
          else sendJson(res, 200, { project: p });
        }
        return true;
      }

      // ── Tools ──
      if (path === "/api/tools") {
        if (!this.toolStore) {
          sendJson(res, 503, { error: "Tool store not available" });
        } else {
          sendJson(res, 200, { tools: this.toolStore.list() });
        }
        return true;
      }
      const toolMatch = path.match(/^\/api\/tools\/([^/]+)$/);
      if (toolMatch) {
        if (!this.toolStore) {
          sendJson(res, 503, { error: "Tool store not available" });
        } else {
          const t = this.toolStore.get(decodeURIComponent(toolMatch[1]));
          if (!t) sendJson(res, 404, { error: "Tool not found" });
          else sendJson(res, 200, { tool: t });
        }
        return true;
      }

      // ── Sub-agents (read-only, legacy) ──
      if (path === "/api/subagents") {
        this.handleListAgents(res);
        return true;
      }

      // ── Cron (legacy compat) ──
      if (path === "/api/cron" || path === "/api/cron/jobs") {
        this.handleListCronJobs(res);
        return true;
      }
      const runsMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)\/runs$/);
      if (runsMatch) {
        const params = new URLSearchParams(queryString ?? "");
        const limit = parseInt(params.get("limit") ?? "20", 10);
        this.handleGetCronRuns(
          decodeURIComponent(runsMatch[1]),
          Math.min(Math.max(limit, 1), 100),
          res,
        );
        return true;
      }
      const singleJobMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)$/);
      if (singleJobMatch) {
        this.handleGetCronJob(decodeURIComponent(singleJobMatch[1]), res);
        return true;
      }

      // ── Config ──
      if (path === "/api/config") {
        this.handleGetConfig(res);
        return true;
      }

      // ── Tasks ──
      if (path === "/api/tasks") {
        const params = new URLSearchParams(queryString ?? "");
        this.handleListTasks(params, res);
        return true;
      }
      if (path === "/api/tasks/next") {
        const params = new URLSearchParams(queryString ?? "");
        this.handleNextTask(params.get("agent") ?? "", res);
        return true;
      }
      const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch) {
        this.handleGetTask(parseInt(taskMatch[1], 10), res);
        return true;
      }

      // ── Activity Log ──
      if (path === "/api/activity") {
        this.handleListActivity(queryString ?? "", res);
        return true;
      }
    }

    if (method === "POST") {
      // ── Agent CRUD ──
      if (path === "/api/agents" && body) {
        if (!this.agentCrudStore) {
          sendJson(res, 503, { error: "Agent store not available" });
        } else {
          const { id, name } = body as any;
          if (!id || !name) {
            sendJson(res, 400, { error: "Missing required fields: id, name" });
          } else {
            try {
              const agent = this.agentCrudStore.create(body as any);
              if (this.cronScheduler) await this.cronScheduler.reload();
              sendJson(res, 201, { agent });
            } catch (e: any) {
              sendJson(res, 409, { error: e.message ?? "Failed to create agent" });
            }
          }
        }
        return true;
      }

      // ── Schedule CRUD ──
      if (path === "/api/schedules" && body) {
        if (!this.scheduleStore) {
          sendJson(res, 503, { error: "Schedule store not available" });
        } else {
          const { id, agent_id, schedule, prompt } = body as any;
          if (!id || !agent_id || !schedule || !prompt) {
            sendJson(res, 400, { error: "Missing required fields: id, agent_id, schedule, prompt" });
          } else {
            try {
              const s = this.scheduleStore.create(body as any);
              if (this.cronScheduler) await this.cronScheduler.reload();
              sendJson(res, 201, { schedule: s });
            } catch (e: any) {
              sendJson(res, 409, { error: e.message ?? "Failed to create schedule" });
            }
          }
        }
        return true;
      }
      const scheduleRunMatch = path.match(/^\/api\/schedules\/([^/]+)\/run$/);
      if (scheduleRunMatch) {
        await this.handleTriggerCronJob(decodeURIComponent(scheduleRunMatch[1]), res);
        return true;
      }

      // ── Project CRUD ──
      if (path === "/api/projects" && body) {
        if (!this.projectStore) {
          sendJson(res, 503, { error: "Project store not available" });
        } else {
          const { id, name } = body as any;
          if (!id || !name) {
            sendJson(res, 400, { error: "Missing required fields: id, name" });
          } else {
            try {
              const p = this.projectStore.create(body as any);
              sendJson(res, 201, { project: p });
            } catch (e: any) {
              sendJson(res, 409, { error: e.message ?? "Failed to create project" });
            }
          }
        }
        return true;
      }

      // ── Tool CRUD ──
      if (path === "/api/tools" && body) {
        if (!this.toolStore) {
          sendJson(res, 503, { error: "Tool store not available" });
        } else {
          const { id, name, type } = body as any;
          if (!id || !name || !type) {
            sendJson(res, 400, { error: "Missing required fields: id, name, type" });
          } else {
            try {
              const t = this.toolStore.create(body as any);
              sendJson(res, 201, { tool: t });
            } catch (e: any) {
              sendJson(res, 409, { error: e.message ?? "Failed to create tool" });
            }
          }
        }
        return true;
      }

      // ── Tasks ──
      if (path === "/api/tasks" && body) {
        this.handleCreateTask(body, res);
        return true;
      }
      const claimMatch = path.match(/^\/api\/tasks\/(\d+)\/claim$/);
      if (claimMatch && body) {
        this.handleClaimTask(parseInt(claimMatch[1], 10), body, res);
        return true;
      }
      const completeMatch = path.match(/^\/api\/tasks\/(\d+)\/complete$/);
      if (completeMatch && body) {
        this.handleCompleteTask(parseInt(completeMatch[1], 10), body, res);
        return true;
      }

      // ── Cron (legacy compat) ──
      if ((path === "/api/cron/jobs" || path === "/api/cron") && body) {
        await this.handleCreateCronJob(body, res);
        return true;
      }
      const runMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)\/run$/);
      if (runMatch) {
        await this.handleTriggerCronJob(decodeURIComponent(runMatch[1]), res);
        return true;
      }
    }

    if (method === "PUT") {
      // ── Agent update ──
      const agentUpdateMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (agentUpdateMatch && body) {
        if (!this.agentCrudStore) {
          sendJson(res, 503, { error: "Agent store not available" });
        } else {
          const agent = this.agentCrudStore.update(decodeURIComponent(agentUpdateMatch[1]), body as any);
          if (!agent) sendJson(res, 404, { error: "Agent not found" });
          else {
            if (this.cronScheduler) await this.cronScheduler.reload();
            sendJson(res, 200, { agent });
          }
        }
        return true;
      }

      // ── Schedule update ──
      const scheduleUpdateMatch = path.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleUpdateMatch && body) {
        if (!this.scheduleStore) {
          sendJson(res, 503, { error: "Schedule store not available" });
        } else {
          const s = this.scheduleStore.update(decodeURIComponent(scheduleUpdateMatch[1]), body as any);
          if (!s) sendJson(res, 404, { error: "Schedule not found" });
          else {
            if (this.cronScheduler) await this.cronScheduler.reload();
            sendJson(res, 200, { schedule: s });
          }
        }
        return true;
      }

      // ── Project update ──
      const projectUpdateMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectUpdateMatch && body) {
        if (!this.projectStore) {
          sendJson(res, 503, { error: "Project store not available" });
        } else {
          const p = this.projectStore.update(decodeURIComponent(projectUpdateMatch[1]), body as any);
          if (!p) sendJson(res, 404, { error: "Project not found" });
          else sendJson(res, 200, { project: p });
        }
        return true;
      }

      // ── Tool update ──
      const toolUpdateMatch = path.match(/^\/api\/tools\/([^/]+)$/);
      if (toolUpdateMatch && body) {
        if (!this.toolStore) {
          sendJson(res, 503, { error: "Tool store not available" });
        } else {
          const t = this.toolStore.update(decodeURIComponent(toolUpdateMatch[1]), body as any);
          if (!t) sendJson(res, 404, { error: "Tool not found" });
          else sendJson(res, 200, { tool: t });
        }
        return true;
      }

      // ── Task update ──
      const taskUpdateMatch = path.match(/^\/api\/tasks\/(\d+)$/);
      if (taskUpdateMatch && body) {
        this.handleUpdateTask(parseInt(taskUpdateMatch[1], 10), body, res);
        return true;
      }

      // ── Cron update (legacy) ──
      const updateMatch = path.match(/^\/api\/cron(?:\/jobs)?\/([^/]+)$/);
      if (updateMatch && body) {
        await this.handleUpdateCronJob(decodeURIComponent(updateMatch[1]), body, res);
        return true;
      }
    }

    if (method === "DELETE") {
      // ── Agent delete ──
      const agentDeleteMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (agentDeleteMatch) {
        if (!this.agentCrudStore) {
          sendJson(res, 503, { error: "Agent store not available" });
        } else {
          // Delete associated schedules first
          if (this.scheduleStore) {
            const schedules = this.scheduleStore.listByAgent(decodeURIComponent(agentDeleteMatch[1]));
            for (const s of schedules) {
              this.scheduleStore.delete(s.id);
            }
          }
          if (!this.agentCrudStore.delete(decodeURIComponent(agentDeleteMatch[1]))) {
            sendJson(res, 404, { error: "Agent not found" });
          } else {
            if (this.cronScheduler) await this.cronScheduler.reload();
            sendJson(res, 200, { status: "deleted" });
          }
        }
        return true;
      }

      // ── Schedule delete ──
      const scheduleDeleteMatch = path.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleDeleteMatch) {
        if (!this.scheduleStore) {
          sendJson(res, 503, { error: "Schedule store not available" });
        } else {
          if (!this.scheduleStore.delete(decodeURIComponent(scheduleDeleteMatch[1]))) {
            sendJson(res, 404, { error: "Schedule not found" });
          } else {
            if (this.cronScheduler) await this.cronScheduler.reload();
            sendJson(res, 200, { status: "deleted" });
          }
        }
        return true;
      }

      // ── Project delete ──
      const projectDeleteMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectDeleteMatch) {
        if (!this.projectStore) {
          sendJson(res, 503, { error: "Project store not available" });
        } else {
          if (!this.projectStore.delete(decodeURIComponent(projectDeleteMatch[1]))) {
            sendJson(res, 404, { error: "Project not found" });
          } else {
            sendJson(res, 200, { status: "deleted" });
          }
        }
        return true;
      }

      // ── Tool delete ──
      const toolDeleteMatch = path.match(/^\/api\/tools\/([^/]+)$/);
      if (toolDeleteMatch) {
        if (!this.toolStore) {
          sendJson(res, 503, { error: "Tool store not available" });
        } else {
          if (!this.toolStore.delete(decodeURIComponent(toolDeleteMatch[1]))) {
            sendJson(res, 404, { error: "Tool not found" });
          } else {
            sendJson(res, 200, { status: "deleted" });
          }
        }
        return true;
      }

      // ── Task delete ──
      const taskDeleteMatch = path.match(/^\/api\/tasks\/(\d+)$/);
      if (taskDeleteMatch) {
        this.handleDeleteTask(parseInt(taskDeleteMatch[1], 10), res);
        return true;
      }

      // ── Cron delete (legacy) ──
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

  // ── Task Handlers ──────────────────────────────────────────────────

  private handleListTasks(params: URLSearchParams, res: ServerResponse): void {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    const tasks = this.taskStore.list({
      status: params.get("status") ?? undefined,
      assigned_agent: params.get("assigned_agent") ?? undefined,
      tag: params.get("tag") ?? undefined,
    });
    sendJson(res, 200, { tasks });
  }

  private handleGetTask(id: number, res: ServerResponse): void {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    const task = this.taskStore.get(id);
    if (!task) {
      sendJson(res, 404, { error: `Task ${id} not found` });
      return;
    }
    sendJson(res, 200, { task });
  }

  private handleCreateTask(body: Record<string, unknown>, res: ServerResponse): void {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    const { title } = body as any;
    if (!title) {
      sendJson(res, 400, { error: "Missing required field: title" });
      return;
    }
    const task = this.taskStore.create({
      title: title as string,
      description: body.description as string | undefined,
      assigned_agent: body.assigned_agent as string | undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      recurring: body.recurring as boolean | undefined,
      recurrence_schedule: body.recurrence_schedule as string | undefined,
      tags: body.tags as string[] | undefined,
    });
    sendJson(res, 201, { task });
  }

  private handleUpdateTask(id: number, body: Record<string, unknown>, res: ServerResponse): void {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    const task = this.taskStore.update(id, {
      title: body.title as string | undefined,
      description: body.description as string | undefined,
      assigned_agent: body.assigned_agent as string | null | undefined,
      status: body.status as string | undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      recurring: body.recurring as boolean | undefined,
      recurrence_schedule: body.recurrence_schedule as string | undefined,
      tags: body.tags as string[] | undefined,
    });
    if (!task) {
      sendJson(res, 404, { error: `Task ${id} not found` });
      return;
    }
    sendJson(res, 200, { task });
  }

  private handleDeleteTask(id: number, res: ServerResponse): void {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    if (!this.taskStore.delete(id)) {
      sendJson(res, 404, { error: `Task ${id} not found` });
      return;
    }
    sendJson(res, 200, { status: "deleted", id });
  }

  private handleNextTask(agentId: string, res: ServerResponse): void {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    if (!agentId) {
      sendJson(res, 400, { error: "Missing query parameter: agent" });
      return;
    }
    const task = this.taskStore.next(agentId);
    if (!task) {
      sendJson(res, 200, { task: null });
      return;
    }
    sendJson(res, 200, { task });
  }

  private handleClaimTask(id: number, body: Record<string, unknown>, res: ServerResponse): void {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    const agent = body.agent as string;
    if (!agent) {
      sendJson(res, 400, { error: "Missing required field: agent" });
      return;
    }
    // Claim by updating status directly
    const task = this.taskStore.get(id);
    if (!task) {
      sendJson(res, 404, { error: `Task ${id} not found` });
      return;
    }
    const updated = this.taskStore.update(id, { status: "in_progress" });
    sendJson(res, 200, { task: updated });
  }

  private handleCompleteTask(id: number, body: Record<string, unknown>, res: ServerResponse): void {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    const result = (body.result as string) ?? "";
    const task = this.taskStore.complete(id, result);
    if (!task) {
      sendJson(res, 404, { error: `Task ${id} not found` });
      return;
    }
    sendJson(res, 200, { task });
  }

  // ── Activity Handler ──────────────────────────────────────────────

  private handleListActivity(queryString: string, res: ServerResponse): void {
    // Activity log is optional -- uses the shared DB from cron scheduler
    sendJson(res, 200, { activity: [] });
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
