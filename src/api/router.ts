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
 *   GET  /api/activity                  — list activity log entries
 *   POST /api/activity                  — insert an activity log entry
 *   GET  /api/runs                      — fleet-wide cron run history (agent_id, is_error, limit, offset)
 *   GET  /api/runs/:id                  — get full details for a single run (includes full result_text)
 *   GET  /api/cost/summary              — per-agent cost totals for period
 *   GET  /api/cost/daily                — day-by-day fleet cost for period
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { CronScheduler } from "../cron/scheduler.js";
import type { AgentStore } from "../agents/store.js";
import type { AgentCrudStore } from "../agents/agent-store.js";
import type { TaskStore } from "../tasks/store.js";
import type { ScheduleStore } from "../schedules/store.js";
import type { ProjectStore } from "../projects/store.js";
import type { RepoManager } from "../projects/repo-manager.js";
import type { ToolStore } from "../tools/store.js";
import type { ToolAccountStore } from "../tools/account-store.js";
import type { TemplateStore } from "../templates/store.js";
import { TOOL_PROFILES, getProfile } from "../tools/profiles.js";
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
  private toolAccountStore: ToolAccountStore | null = null;
  private templateStore: TemplateStore | null = null;
  private db: Database.Database | null = null;
  private configPath: string | null = null;
  private onConfigChange: (() => Promise<void>) | null = null;
  private memoryStore: import("../memory/store.js").MemoryStore | null = null;
  private repoManager: RepoManager | null = null;

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

  setRepoManager(manager: RepoManager): void {
    this.repoManager = manager;
  }

  setToolStore(store: ToolStore): void {
    this.toolStore = store;
  }

  setToolAccountStore(store: ToolAccountStore): void {
    this.toolAccountStore = store;
  }

  setTemplateStore(store: TemplateStore): void {
    this.templateStore = store;
  }

  setDb(db: Database.Database): void {
    this.db = db;
  }

  setMemoryStore(store: import("../memory/store.js").MemoryStore): void {
    this.memoryStore = store;
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
          const params = new URLSearchParams(queryString ?? "");
          const projectId = params.get("project_id") ?? undefined;
          sendJson(res, 200, { agents: this.agentCrudStore.list({ project_id: projectId }) });
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
          const projectId = params.get("project_id") ?? undefined;
          sendJson(res, 200, { schedules: this.scheduleStore.list({ agent_id: agentId, project_id: projectId }) });
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

      // ── Project Repos ──
      const repoListMatch = path.match(/^\/api\/projects\/([^/]+)\/repos$/);
      if (repoListMatch) {
        if (!this.repoManager) {
          sendJson(res, 503, { error: "Repo manager not available" });
        } else {
          const projectId = decodeURIComponent(repoListMatch[1]);
          const repos = this.repoManager.listRepos(projectId);
          sendJson(res, 200, { repos });
        }
        return true;
      }
      const repoStatusMatch = path.match(/^\/api\/projects\/([^/]+)\/repos\/([^/]+)\/status$/);
      if (repoStatusMatch) {
        if (!this.repoManager) {
          sendJson(res, 503, { error: "Repo manager not available" });
        } else {
          const projectId = decodeURIComponent(repoStatusMatch[1]);
          const repoName = decodeURIComponent(repoStatusMatch[2]);
          const status = this.repoManager.getRepoStatus(projectId, repoName);
          if (!status) sendJson(res, 404, { error: "Repo not found" });
          else sendJson(res, 200, { status });
        }
        return true;
      }

      // ── Tools ──
      if (path === "/api/tools") {
        if (!this.toolStore) {
          sendJson(res, 503, { error: "Tool store not available" });
        } else {
          const toolList = this.toolStore.list();
          const enriched = toolList.map((t) => ({
            ...t,
            account_count: this.toolAccountStore ? this.toolAccountStore.countByTool(t.id) : 0,
          }));
          sendJson(res, 200, { tools: enriched });
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

      // ── Tool Accounts ──
      const toolAccountsMatch = path.match(/^\/api\/tools\/([^/]+)\/accounts$/);
      if (toolAccountsMatch) {
        if (!this.toolAccountStore) {
          sendJson(res, 503, { error: "Tool account store not available" });
        } else {
          const toolId = decodeURIComponent(toolAccountsMatch[1]);
          const params = new URLSearchParams(queryString ?? "");
          const reveal = params.get("reveal") === "1";
          const accounts = reveal
            ? this.toolAccountStore.list(toolId)
            : this.toolAccountStore.listMasked(toolId);
          sendJson(res, 200, { accounts });
        }
        return true;
      }
      const singleAccountMatch = path.match(/^\/api\/tools\/([^/]+)\/accounts\/([^/]+)$/);
      if (singleAccountMatch) {
        if (!this.toolAccountStore) {
          sendJson(res, 503, { error: "Tool account store not available" });
        } else {
          const params = new URLSearchParams(queryString ?? "");
          const reveal = params.get("reveal") === "1";
          const accountId = decodeURIComponent(singleAccountMatch[2]);
          const a = reveal
            ? this.toolAccountStore.get(accountId)
            : this.toolAccountStore.getMasked(accountId);
          if (!a) sendJson(res, 404, { error: "Tool account not found" });
          else sendJson(res, 200, { account: a });
        }
        return true;
      }

      // ── Tool Profiles ──
      if (path === "/api/tools/profiles") {
        sendJson(res, 200, { profiles: TOOL_PROFILES });
        return true;
      }
      const profileMatch = path.match(/^\/api\/tools\/profiles\/([^/]+)$/);
      if (profileMatch) {
        const profile = getProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) sendJson(res, 404, { error: "Profile not found" });
        else sendJson(res, 200, { profile });
        return true;
      }

      // ── Templates ──
      if (path === "/api/templates") {
        if (!this.templateStore) {
          sendJson(res, 503, { error: "Template store not available" });
        } else {
          sendJson(res, 200, { templates: this.templateStore.list() });
        }
        return true;
      }
      const templateMatch = path.match(/^\/api\/templates\/(\d+)$/);
      if (templateMatch) {
        if (!this.templateStore) {
          sendJson(res, 503, { error: "Template store not available" });
        } else {
          const t = this.templateStore.get(parseInt(templateMatch[1], 10));
          if (!t) sendJson(res, 404, { error: "Template not found" });
          else sendJson(res, 200, { template: t });
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

      // ── Metrics ──
      if (path === "/api/metrics") {
        const params = new URLSearchParams(queryString ?? "");
        this.handleMetrics(params.get("period") ?? "7d", res);
        return true;
      }

      // ── Runs (fleet-wide cron_runs history) ──
      if (path === "/api/runs") {
        const params = new URLSearchParams(queryString ?? "");
        this.handleListRuns(params, res);
        return true;
      }

      // ── Single Run Details ──
      const runIdMatch = path.match(/^\/api\/runs\/(\d+)$/);
      if (runIdMatch) {
        this.handleGetRun(parseInt(runIdMatch[1], 10), res);
        return true;
      }

      // ── Cost Summary ──
      if (path === "/api/cost/summary") {
        const params = new URLSearchParams(queryString ?? "");
        this.handleCostSummary(params.get("period") ?? "7d", res);
        return true;
      }

      // ── Cost Daily (day-by-day spend for chart) ──
      if (path === "/api/cost/daily") {
        const params = new URLSearchParams(queryString ?? "");
        this.handleCostDaily(params.get("period") ?? "7d", res);
        return true;
      }

      const agentCostMatch = path.match(/^\/api\/agents\/([^/]+)\/cost$/);
      if (agentCostMatch) {
        const params = new URLSearchParams(queryString ?? "");
        const limit = parseInt(params.get("limit") ?? "30", 10);
        this.handleAgentCostHistory(decodeURIComponent(agentCostMatch[1]), Math.min(Math.max(limit, 1), 100), res);
        return true;
      }

      // ── Memory Search ──
      if (path === "/api/memory/search") {
        const params = new URLSearchParams(queryString ?? "");
        const query = params.get("q") ?? "";
        const limit = parseInt(params.get("limit") ?? "10", 10);
        if (!query) {
          sendJson(res, 400, { error: "Missing required 'q' query parameter" });
          return true;
        }
        if (!this.memoryStore) {
          sendJson(res, 503, { error: "Memory store not available (requires openai config)" });
          return true;
        }
        try {
          const results = await this.memoryStore.search(query, Math.min(Math.max(limit, 1), 50));
          sendJson(res, 200, { results, query, count: results.length });
        } catch (e) {
          log.error({ err: e }, "memory search failed");
          sendJson(res, 500, { error: "Memory search failed" });
        }
        return true;
      }
    }

    if (method === "POST") {
      // ── Activity Log ──
      if (path === "/api/activity" && body) {
        if (!this.db) {
          sendJson(res, 503, { error: "Database not available" });
        } else {
          const { type, agent_id, schedule_id, task_id, summary, details, project_id } = body as any;
          if (!type || !summary) {
            sendJson(res, 400, { error: "Missing required fields: type, summary" });
          } else {
            try {
              const result = this.db
                .prepare(
                  `INSERT INTO activity_log (type, agent_id, schedule_id, task_id, summary, details, project_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  type,
                  agent_id ?? null,
                  schedule_id ?? null,
                  task_id ?? null,
                  summary,
                  details ? (typeof details === "string" ? details : JSON.stringify(details)) : null,
                  project_id ?? null,
                );
              const entry = this.db
                .prepare("SELECT * FROM activity_log WHERE id = ?")
                .get(result.lastInsertRowid);
              sendJson(res, 201, { activity: entry });
            } catch (e: any) {
              sendJson(res, 500, { error: e.message ?? "Failed to insert activity" });
            }
          }
        }
        return true;
      }

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

      // ── Project Repo POST endpoints ──
      const repoCloneMatch = path.match(/^\/api\/projects\/([^/]+)\/repos$/);
      if (repoCloneMatch && body) {
        if (!this.repoManager) {
          sendJson(res, 503, { error: "Repo manager not available" });
        } else {
          const projectId = decodeURIComponent(repoCloneMatch[1]);
          const { url } = body as any;
          if (!url) {
            sendJson(res, 400, { error: "Missing required field: url" });
          } else {
            try {
              const result = await this.repoManager.cloneRepo(projectId, body as any);
              if (result.success) {
                sendJson(res, 201, { result });
              } else {
                sendJson(res, 500, { error: result.error, result });
              }
            } catch (e: any) {
              sendJson(res, 500, { error: e.message ?? "Clone failed" });
            }
          }
        }
        return true;
      }
      const repoPullMatch = path.match(/^\/api\/projects\/([^/]+)\/repos\/([^/]+)\/pull$/);
      if (repoPullMatch) {
        if (!this.repoManager) {
          sendJson(res, 503, { error: "Repo manager not available" });
        } else {
          const projectId = decodeURIComponent(repoPullMatch[1]);
          const repoName = decodeURIComponent(repoPullMatch[2]);
          const result = this.repoManager.pullRepo(projectId, repoName);
          sendJson(res, result.success ? 200 : 500, { result });
        }
        return true;
      }

      // ── Apply tool profile to an agent ──
      // POST /api/tools/profiles/:id/apply  body: { agentId: string }
      const profileApplyMatch = path.match(/^\/api\/tools\/profiles\/([^/]+)\/apply$/);
      if (profileApplyMatch && body) {
        const profile = getProfile(decodeURIComponent(profileApplyMatch[1]));
        if (!profile) {
          sendJson(res, 404, { error: "Profile not found" });
          return true;
        }
        if (!this.agentCrudStore) {
          sendJson(res, 503, { error: "Agent store not available" });
          return true;
        }
        const { agentId } = body as { agentId?: string };
        if (!agentId) {
          sendJson(res, 400, { error: "Missing required field: agentId" });
          return true;
        }
        const agent = this.agentCrudStore.get(agentId);
        if (!agent) {
          sendJson(res, 404, { error: `Agent '${agentId}' not found` });
          return true;
        }
        const updated = this.agentCrudStore.update(agentId, { tools: profile.allowedTools });
        log.info({ agentId, profileId: profile.id, tools: profile.allowedTools }, "profile applied to agent");
        sendJson(res, 200, { agent: updated, profile: profile.id, appliedTools: profile.allowedTools });
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

      // ── Tool Account create ──
      const toolAccountCreateMatch = path.match(/^\/api\/tools\/([^/]+)\/accounts$/);
      if (toolAccountCreateMatch && body) {
        if (!this.toolAccountStore) {
          sendJson(res, 503, { error: "Tool account store not available" });
        } else {
          const toolId = decodeURIComponent(toolAccountCreateMatch[1]);
          const { account_name, credentials } = body as any;
          if (!account_name || !credentials) {
            sendJson(res, 400, { error: "Missing required fields: account_name, credentials" });
          } else {
            try {
              const a = this.toolAccountStore.create({ ...body as any, tool_id: toolId });
              sendJson(res, 201, { account: { ...a, credentials: maskObj(a.credentials) } });
            } catch (e: any) {
              sendJson(res, 409, { error: e.message ?? "Failed to create tool account" });
            }
          }
        }
        return true;
      }

      // ── Template create ──
      if (path === "/api/templates" && body) {
        if (!this.templateStore) {
          sendJson(res, 503, { error: "Template store not available" });
        } else {
          const { name, category, content } = body as any;
          if (!name || !content) {
            sendJson(res, 400, { error: "Missing required fields: name, content" });
          } else {
            const t = this.templateStore.create(body as any);
            sendJson(res, 201, { template: t });
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
      const taskRunMatch = path.match(/^\/api\/tasks\/(\d+)\/run$/);
      if (taskRunMatch) {
        await this.handleRunTask(parseInt(taskRunMatch[1], 10), res);
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

      // ── Tool Account update ──
      const toolAccountUpdateMatch = path.match(/^\/api\/tools\/([^/]+)\/accounts\/([^/]+)$/);
      if (toolAccountUpdateMatch && body) {
        if (!this.toolAccountStore) {
          sendJson(res, 503, { error: "Tool account store not available" });
        } else {
          const accountId = decodeURIComponent(toolAccountUpdateMatch[2]);
          const a = this.toolAccountStore.update(accountId, body as any);
          if (!a) sendJson(res, 404, { error: "Tool account not found" });
          else sendJson(res, 200, { account: { ...a, credentials: maskObj(a.credentials) } });
        }
        return true;
      }

      // ── Template update ──
      const templateUpdateMatch = path.match(/^\/api\/templates\/(\d+)$/);
      if (templateUpdateMatch && body) {
        if (!this.templateStore) {
          sendJson(res, 503, { error: "Template store not available" });
        } else {
          const t = this.templateStore.update(parseInt(templateUpdateMatch[1], 10), body as any);
          if (!t) sendJson(res, 404, { error: "Template not found" });
          else sendJson(res, 200, { template: t });
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

      // ── Project repo delete ──
      const repoDeleteMatch = path.match(/^\/api\/projects\/([^/]+)\/repos\/([^/]+)$/);
      if (repoDeleteMatch) {
        if (!this.repoManager) {
          sendJson(res, 503, { error: "Repo manager not available" });
        } else {
          const projectId = decodeURIComponent(repoDeleteMatch[1]);
          const repoName = decodeURIComponent(repoDeleteMatch[2]);
          if (!this.repoManager.removeRepo(projectId, repoName)) {
            sendJson(res, 404, { error: "Repo not found" });
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

      // ── Tool Account delete ──
      const toolAccountDeleteMatch = path.match(/^\/api\/tools\/([^/]+)\/accounts\/([^/]+)$/);
      if (toolAccountDeleteMatch) {
        if (!this.toolAccountStore) {
          sendJson(res, 503, { error: "Tool account store not available" });
        } else {
          const accountId = decodeURIComponent(toolAccountDeleteMatch[2]);
          if (!this.toolAccountStore.delete(accountId)) {
            sendJson(res, 404, { error: "Tool account not found" });
          } else {
            sendJson(res, 200, { status: "deleted" });
          }
        }
        return true;
      }

      // ── Template delete ──
      const templateDeleteMatch = path.match(/^\/api\/templates\/(\d+)$/);
      if (templateDeleteMatch) {
        if (!this.templateStore) {
          sendJson(res, 503, { error: "Template store not available" });
        } else {
          if (!this.templateStore.delete(parseInt(templateDeleteMatch[1], 10))) {
            sendJson(res, 404, { error: "Template not found" });
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
      project_id: params.get("project_id") ?? undefined,
    });
    sendJson(res, 200, { tasks: this.taskStore.enrichWithDependencyStatus(tasks) });
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
    const [enriched] = this.taskStore.enrichWithDependencyStatus([task]);
    sendJson(res, 200, { task: enriched });
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
      model_hint: body.model_hint as string | undefined,
      project_id: body.project_id as string | undefined,
      depends_on: Array.isArray(body.depends_on) ? (body.depends_on as number[]) : undefined,
      stale_timeout_hours:
        typeof body.stale_timeout_hours === "number" ? body.stale_timeout_hours : undefined,
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
      model_hint: "model_hint" in body ? (body.model_hint as string | null) : undefined,
      project_id: "project_id" in body ? (body.project_id as string | null) : undefined,
      stale_timeout_hours:
        "stale_timeout_hours" in body
          ? typeof body.stale_timeout_hours === "number"
            ? body.stale_timeout_hours
            : null
          : undefined,
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
    // Claim task: set status to in_progress with claimed_by
    const task = this.taskStore.get(id);
    if (!task) {
      sendJson(res, 404, { error: `Task ${id} not found` });
      return;
    }
    // If already in_progress and claimed by this agent, just return it (continuity)
    if (task.status === "in_progress" && task.claimed_by === agent) {
      sendJson(res, 200, { task });
      return;
    }
    // Use direct SQL to set both status and claimed_by atomically
    this.taskStore["db"]
      .prepare(
        `UPDATE tasks SET status = 'in_progress', claimed_by = ?, claimed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(agent, id);
    const updated = this.taskStore.get(id);
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

  // ── Task Run Handler ─────────────────────────────────────────────

  private async handleRunTask(id: number, res: ServerResponse): Promise<void> {
    if (!this.taskStore) {
      sendJson(res, 503, { error: "Task store not available" });
      return;
    }
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }

    const task = this.taskStore.get(id);
    if (!task) {
      sendJson(res, 404, { error: `Task ${id} not found` });
      return;
    }

    const agentId = task.assigned_agent;
    if (!agentId) {
      sendJson(res, 400, { error: "Task has no assigned agent" });
      return;
    }

    // Look up the agent from DB
    const db = (this.cronScheduler as any).sharedDb as import("better-sqlite3").Database | undefined;
    if (!db) {
      sendJson(res, 503, { error: "Database not available" });
      return;
    }

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | undefined;
    if (!agent) {
      sendJson(res, 404, { error: `Agent '${agentId}' not found` });
      return;
    }

    // Mark the task as in_progress
    this.taskStore.update(id, { status: "in_progress" });
    // Set claimed_by directly since UpdateTaskInput doesn't include it
    db.prepare("UPDATE tasks SET claimed_by = ?, claimed_at = datetime('now') WHERE id = ?").run(agentId, id);

    // Build a task-specific prompt
    const taskPrompt = `You have been assigned task #${id}. Work on it and report your results.

## Task: ${task.title}

${task.description || "No additional description."}

When done, summarize what you did.`;

    // Build a job config for this agent + task prompt
    const jobConfig = {
      id: agentId,
      label: `${agent.name || agentId}: Task #${id}`,
      schedule: "manual",
      timezone: "UTC",
      prompt: taskPrompt,
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

    log.info({ taskId: id, agentId }, "spawning agent for task via API");

    // Run asynchronously -- respond immediately so the dashboard doesn't hang
    sendJson(res, 202, { status: "started", taskId: id, agentId, message: `Agent '${agentId}' spawned for task #${id}` });

    // Fire and forget -- spawn agent, record run, complete task
    const cronScheduler = this.cronScheduler;
    const taskStore = this.taskStore;
    const runDb = (cronScheduler as any).db as import("better-sqlite3").Database;
    (async () => {
      try {
        const { runCronJob } = await import("../cron/runner.js");
        const workspace = (cronScheduler as any).workspace as any;
        const claudeConfig = (cronScheduler as any).claudeConfig as any;
        const result = await runCronJob(jobConfig as any, claudeConfig, { workspace });

        // Record the run in cron_runs so it shows up in the Runs tab with full logs
        runDb.prepare(
          `INSERT INTO cron_runs (job_id, started_at, finished_at, duration_ms, cost_usd, num_turns, is_error, result_text, run_log)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `task-${id}-${agentId}`,
          result.startedAt.toISOString(),
          result.finishedAt.toISOString(),
          result.durationMs,
          result.costUsd,
          result.numTurns,
          result.isError ? 1 : 0,
          result.text,
          result.runLog ?? null,
        );

        // Complete the task with the result
        const resultText = result.isError
          ? `Agent failed: ${result.text.slice(0, 500)}`
          : result.text.slice(0, 2000);
        taskStore.complete(id, resultText);
        log.info({ taskId: id, agentId, isError: result.isError, durationMs: result.durationMs }, "task run completed");
      } catch (e: any) {
        log.error({ taskId: id, agentId, err: e }, "task run failed");
        taskStore.update(id, { status: "ready" });
        db.prepare("UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ?").run(id);
      }
    })();
  }

  // ── Activity Handler ──────────────────────────────────────────────

  private handleListActivity(queryString: string, res: ServerResponse): void {
    if (!this.db) {
      sendJson(res, 200, { activity: [] });
      return;
    }

    const params = new URLSearchParams(queryString);
    const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 200);
    const type = params.get("type") ?? undefined;
    const agentId = params.get("agent_id") ?? undefined;
    const projectId = params.get("project_id") ?? undefined;

    let sql = "SELECT * FROM activity_log WHERE 1=1";
    const sqlParams: unknown[] = [];

    if (type) {
      sql += " AND type = ?";
      sqlParams.push(type);
    }
    if (agentId) {
      sql += " AND agent_id = ?";
      sqlParams.push(agentId);
    }
    if (projectId) {
      sql += " AND project_id = ?";
      sqlParams.push(projectId);
    }

    sql += " ORDER BY id DESC LIMIT ?";
    sqlParams.push(limit);

    try {
      const activity = this.db.prepare(sql).all(...sqlParams);
      sendJson(res, 200, { activity });
    } catch {
      sendJson(res, 200, { activity: [] });
    }
  }

  // ── Runs Handler ────────────────────────────────────────────────────

  /**
   * GET /api/runs?agent_id=&is_error=&limit=50&offset=0
   * Returns paginated fleet-wide cron run history.
   */
  private handleListRuns(params: URLSearchParams, res: ServerResponse): void {
    const db = this.cronScheduler
      ? ((this.cronScheduler as any).db as import("better-sqlite3").Database | undefined)
      : this.db ?? undefined;
    if (!db) {
      sendJson(res, 200, { runs: [], total: 0 });
      return;
    }

    const agentId = params.get("agent_id") ?? undefined;
    const isErrorParam = params.get("is_error") ?? "";
    const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 200);
    const offset = Math.max(parseInt(params.get("offset") ?? "0", 10), 0);

    const conditions: string[] = [];
    const sqlParams: unknown[] = [];

    if (agentId) {
      conditions.push("job_id = ?");
      sqlParams.push(agentId);
    }
    if (isErrorParam === "0") {
      conditions.push("is_error = 0");
    } else if (isErrorParam === "1") {
      conditions.push("is_error = 1");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
      const total = (db.prepare(`SELECT COUNT(*) as n FROM cron_runs ${where}`).get(...sqlParams) as any).n as number;
      const rows = db
        .prepare(
          `SELECT id, job_id, started_at, finished_at, duration_ms, cost_usd, num_turns, is_error, result_text
           FROM cron_runs ${where}
           ORDER BY id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...sqlParams, limit, offset) as Array<{
        id: number;
        job_id: string;
        started_at: string;
        finished_at: string;
        duration_ms: number;
        cost_usd: number;
        num_turns: number;
        is_error: number;
        result_text: string | null;
      }>;

      const runs = rows.map((r) => ({
        id: r.id,
        jobId: r.job_id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        durationMs: r.duration_ms,
        costUsd: r.cost_usd,
        numTurns: r.num_turns,
        isError: r.is_error === 1,
        resultPreview: r.result_text?.slice(0, 300) ?? "",
      }));

      sendJson(res, 200, { runs, total });
    } catch (e: any) {
      log.error({ err: e }, "runs query failed");
      sendJson(res, 500, { error: "Query failed" });
    }
  }

  /**
   * GET /api/runs/:id
   * Returns full details for a single run, including complete result_text.
   */
  private handleGetRun(id: number, res: ServerResponse): void {
    const db = this.cronScheduler
      ? ((this.cronScheduler as any).db as import("better-sqlite3").Database | undefined)
      : this.db ?? undefined;
    if (!db) {
      sendJson(res, 503, { error: "Database not available" });
      return;
    }

    try {
      const row = db
        .prepare(
          `SELECT id, job_id, started_at, finished_at, duration_ms, cost_usd, num_turns, is_error, result_text, run_log
           FROM cron_runs WHERE id = ?`,
        )
        .get(id) as
        | {
            id: number;
            job_id: string;
            started_at: string;
            finished_at: string;
            duration_ms: number;
            cost_usd: number;
            num_turns: number;
            is_error: number;
            result_text: string | null;
            run_log: string | null;
          }
        | undefined;

      if (!row) {
        sendJson(res, 404, { error: "Run not found" });
        return;
      }

      sendJson(res, 200, {
        run: {
          id: row.id,
          jobId: row.job_id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          durationMs: row.duration_ms,
          costUsd: row.cost_usd,
          numTurns: row.num_turns,
          isError: row.is_error === 1,
          resultText: row.result_text ?? "",
          hasLog: !!row.run_log,
          runLog: row.run_log ?? null,
        },
      });
    } catch (e: any) {
      log.error({ err: e }, "run lookup failed");
      sendJson(res, 500, { error: "Query failed" });
    }
  }

  // ── Cost Handlers ────────────────────────────────────────────────────

  /**
   * GET /api/cost/summary?period=7d
   * Returns per-agent cost totals over the given period (1d, 7d, 30d).
   */
  private handleCostSummary(period: string, res: ServerResponse): void {
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }

    const days = period === "1d" ? 1 : period === "30d" ? 30 : 7;
    const db = (this.cronScheduler as any).db as import("better-sqlite3").Database | undefined;
    if (!db) {
      sendJson(res, 200, { period, agents: [] });
      return;
    }

    try {
      const rows = db
        .prepare(
          `SELECT job_id as agentId,
                  COALESCE(SUM(cost_usd), 0) as totalCostUsd,
                  COUNT(*) as runCount,
                  COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0) as errorCount,
                  MAX(started_at) as lastRunAt
           FROM cron_runs
           WHERE started_at >= datetime('now', ? || ' days')
           GROUP BY job_id
           ORDER BY totalCostUsd DESC`,
        )
        .all(`-${days}`) as Array<{
        agentId: string;
        totalCostUsd: number;
        runCount: number;
        errorCount: number;
        lastRunAt: string;
      }>;

      // Attach budget info from agents table if available
      const withBudget = rows.map((r) => {
        let budgetUsd: number | null = null;
        if (this.agentCrudStore) {
          const agent = this.agentCrudStore.get(r.agentId);
          budgetUsd = agent?.daily_budget_usd ?? null;
        }
        return { ...r, dailyBudgetUsd: budgetUsd };
      });

      sendJson(res, 200, { period, agents: withBudget });
    } catch (e: any) {
      log.error({ err: e }, "cost summary query failed");
      sendJson(res, 500, { error: "Query failed" });
    }
  }

  /**
   * GET /api/cost/daily?period=7d
   * Returns day-by-day fleet cost totals for sparkline charts.
   */
  private handleCostDaily(period: string, res: ServerResponse): void {
    const db = this.cronScheduler
      ? ((this.cronScheduler as any).db as import("better-sqlite3").Database | undefined)
      : this.db ?? undefined;
    if (!db) {
      sendJson(res, 200, { period, days: [] });
      return;
    }

    const days = period === "1d" ? 1 : period === "30d" ? 30 : 7;

    try {
      const rows = db
        .prepare(
          `SELECT date(started_at) as day,
                  COALESCE(SUM(cost_usd), 0) as totalCostUsd,
                  COUNT(*) as runCount,
                  SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errorCount
           FROM cron_runs
           WHERE started_at >= datetime('now', ? || ' days')
           GROUP BY date(started_at)
           ORDER BY day ASC`,
        )
        .all(`-${days}`) as Array<{ day: string; totalCostUsd: number; runCount: number; errorCount: number }>;

      const totalCostUsd = rows.reduce((s, r) => s + r.totalCostUsd, 0);
      sendJson(res, 200, { period, totalCostUsd: Math.round(totalCostUsd * 10000) / 10000, days: rows });
    } catch (e: any) {
      log.error({ err: e }, "cost daily query failed");
      sendJson(res, 500, { error: "Query failed" });
    }
  }

  /**
   * GET /api/agents/:id/cost?limit=30
   * Returns recent run cost history for a specific agent.
   */
  private handleAgentCostHistory(agentId: string, limit: number, res: ServerResponse): void {
    if (!this.cronScheduler) {
      sendJson(res, 503, { error: "Cron scheduler not available" });
      return;
    }

    const db = (this.cronScheduler as any).db as import("better-sqlite3").Database | undefined;
    if (!db) {
      sendJson(res, 200, { agentId, runs: [] });
      return;
    }

    try {
      const rows = db
        .prepare(
          `SELECT started_at as startedAt, cost_usd as costUsd, duration_ms as durationMs,
                  num_turns as numTurns, is_error as isError
           FROM cron_runs
           WHERE job_id = ?
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(agentId, limit) as Array<{
        startedAt: string;
        costUsd: number;
        durationMs: number;
        numTurns: number;
        isError: number;
      }>;

      const dailyCostUsd = this.cronScheduler.getDailyAgentCost(agentId);
      let dailyBudgetUsd: number | null = null;
      if (this.agentCrudStore) {
        dailyBudgetUsd = this.agentCrudStore.get(agentId)?.daily_budget_usd ?? null;
      }

      sendJson(res, 200, {
        agentId,
        dailyCostUsd,
        dailyBudgetUsd,
        runs: rows.map((r) => ({ ...r, isError: r.isError === 1 })),
      });
    } catch (e: any) {
      log.error({ err: e, agentId }, "agent cost history query failed");
      sendJson(res, 500, { error: "Query failed" });
    }
  }

  // ── Metrics Handler ─────────────────────────────────────────────────

  /**
   * GET /api/metrics?period=7d
   * Returns per-agent performance metrics aggregated from cron_runs + tasks.
   */
  private handleMetrics(period: string, res: ServerResponse): void {
    const days = period === "1d" ? 1 : period === "30d" ? 30 : 7;
    const db = this.cronScheduler
      ? ((this.cronScheduler as any).db as import("better-sqlite3").Database | undefined)
      : this.db ?? undefined;

    if (!db) {
      sendJson(res, 200, { period, agents: [], summary: { totalRuns: 0, successRate: 0, totalCostUsd: 0, activeAgents: 0 } });
      return;
    }

    try {
      // Per-agent run metrics from cron_runs
      const runRows = db
        .prepare(
          `SELECT job_id AS agent_id,
                  COUNT(*) AS total_runs,
                  SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) AS success_count,
                  SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS failure_count,
                  ROUND(CAST(SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 3) AS success_rate,
                  COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
                  COALESCE(AVG(cost_usd), 0) AS avg_cost_per_run,
                  COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
           FROM cron_runs
           WHERE started_at >= datetime('now', ? || ' days')
           GROUP BY job_id
           ORDER BY total_runs DESC`,
        )
        .all(`-${days}`) as Array<{
        agent_id: string;
        total_runs: number;
        success_count: number;
        failure_count: number;
        success_rate: number;
        total_cost_usd: number;
        avg_cost_per_run: number;
        avg_duration_ms: number;
      }>;

      // Per-agent completed tasks count
      const taskRows = db
        .prepare(
          `SELECT assigned_agent AS agent_id, COUNT(*) AS tasks_completed
           FROM tasks
           WHERE status = 'completed' AND last_completed_at >= datetime('now', ? || ' days')
             AND assigned_agent IS NOT NULL
           GROUP BY assigned_agent`,
        )
        .all(`-${days}`) as Array<{ agent_id: string; tasks_completed: number }>;

      const taskMap = new Map(taskRows.map((r) => [r.agent_id, r.tasks_completed]));

      const agents = runRows.map((r) => {
        const alerts: string[] = [];
        if (r.success_rate < 0.7) alerts.push("low_success_rate");
        if (r.avg_cost_per_run > 2.0) alerts.push("high_cost_per_run");
        return {
          agentId: r.agent_id,
          totalRuns: r.total_runs,
          successCount: r.success_count,
          failureCount: r.failure_count,
          successRate: r.success_rate,
          totalCostUsd: r.total_cost_usd,
          avgCostPerRun: r.avg_cost_per_run,
          avgDurationMs: Math.round(r.avg_duration_ms),
          tasksCompleted: taskMap.get(r.agent_id) ?? 0,
          alerts,
        };
      });

      // Fleet-level summary
      const totalRuns = agents.reduce((s, a) => s + a.totalRuns, 0);
      const totalSuccess = agents.reduce((s, a) => s + a.successCount, 0);
      const totalCostUsd = agents.reduce((s, a) => s + a.totalCostUsd, 0);
      const summary = {
        totalRuns,
        successRate: totalRuns > 0 ? Math.round((totalSuccess / totalRuns) * 1000) / 1000 : 0,
        totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
        activeAgents: agents.length,
      };

      sendJson(res, 200, { period, summary, agents });
    } catch (e: any) {
      log.error({ err: e }, "metrics query failed");
      sendJson(res, 500, { error: "Query failed" });
    }
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
/** Replace all values in a JSON credentials blob with "****". */
function maskObj(credentialsJson: string): string {
  try {
    const obj = JSON.parse(credentialsJson) as Record<string, unknown>;
    const masked: Record<string, string> = {};
    for (const key of Object.keys(obj)) {
      masked[key] = "****";
    }
    return JSON.stringify(masked);
  } catch {
    return "****";
  }
}

function maskToken(token: string): string {
  if (token.length <= 4) return "****";
  return "****" + token.slice(-4);
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
