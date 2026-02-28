/**
 * Webhook HTTP server for external triggering + REST API.
 *
 * Webhook Endpoints:
 *   POST /hooks/wake   — inject a message into a session (like a Telegram DM)
 *   POST /hooks/agent  — run an isolated agent turn and return the result
 *
 * REST API Endpoints:
 *   GET  /health                  — simple health check
 *   GET  /api/cron/jobs           — list all cron jobs with state
 *   GET  /api/cron/jobs/:id       — get single job config + state
 *   GET  /api/cron/jobs/:id/runs  — run history for a specific job
 *   POST /api/cron/jobs           — create a new cron job
 *   POST /api/cron/jobs/:id/run   — trigger a cron job manually
 *   PUT  /api/cron/jobs/:id       — update a cron job config
 *   DELETE /api/cron/jobs/:id     — delete a cron job
 *   GET  /api/agents              — list agents
 *   GET  /api/agents/:id          — get single agent details
 *   GET  /api/config              — get sanitized config
 *
 * Dashboard:
 *   GET  /                    — web dashboard (redirects to /dashboard)
 *   GET  /dashboard           — web dashboard UI
 *
 * Auth: Bearer token via Authorization header or x-familiar-token header.
 *       Dashboard HTML is served without auth (it prompts for token client-side).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeConfig } from "../config.js";
import { runCronJob } from "../cron/runner.js";
import type { CronJobConfig } from "../cron/types.js";
import type { CronScheduler } from "../cron/scheduler.js";
import { getLogger } from "../util/logger.js";
import { ApiRouter } from "../api/router.js";
import type { AgentStore } from "../agents/store.js";
import type { AgentCrudStore } from "../agents/agent-store.js";
import type { TaskStore } from "../tasks/store.js";
import type { ScheduleStore } from "../schedules/store.js";
import type { ProjectStore } from "../projects/store.js";
import type { ToolStore } from "../tools/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = getLogger("webhooks");

export interface WebhookConfig {
  port: number;
  bind?: string;
  token: string;
}

export type WakeHandler = (chatId: string, message: string) => Promise<void>;

export class WebhookServer {
  private server: Server | null = null;
  private wakeHandler: WakeHandler | null = null;
  private dashboardHtml: string | null = null;
  private apiRouter: ApiRouter = new ApiRouter();

  constructor(
    private config: WebhookConfig,
    private claudeConfig: ClaudeConfig,
  ) {
    this.loadDashboard();
  }

  /** Register handler for /hooks/wake — injects message into a chat session. */
  onWake(handler: WakeHandler): void {
    this.wakeHandler = handler;
  }

  /** Attach the cron scheduler for REST API access. */
  setCronScheduler(scheduler: CronScheduler): void {
    this.apiRouter.setCronScheduler(scheduler);
  }

  /** Attach the agent store for REST API access. */
  setAgentStore(store: AgentStore): void {
    this.apiRouter.setAgentStore(store);
  }

  /** Attach the task store for REST API access. */
  setTaskStore(store: TaskStore): void {
    this.apiRouter.setTaskStore(store);
  }

  /** Attach the persistent agent CRUD store. */
  setAgentCrudStore(store: AgentCrudStore): void {
    this.apiRouter.setAgentCrudStore(store);
  }

  /** Attach the schedule store. */
  setScheduleStore(store: ScheduleStore): void {
    this.apiRouter.setScheduleStore(store);
  }

  /** Attach the project store. */
  setProjectStore(store: ProjectStore): void {
    this.apiRouter.setProjectStore(store);
  }

  /** Attach the tool store. */
  setToolStore(store: ToolStore): void {
    this.apiRouter.setToolStore(store);
  }

  /** Set the config file path for CRUD operations on cron jobs. */
  setConfigPath(path: string): void {
    this.apiRouter.setConfigPath(path);
  }

  /** Set handler to call when config is changed via API (e.g. cron job CRUD). */
  setConfigChangeHandler(handler: () => Promise<void>): void {
    this.apiRouter.setConfigChangeHandler(handler);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      // CORS headers for web dashboard
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-familiar-token",
      );

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      this.handleRequest(req, res).catch((e) => {
        log.error({ err: e }, "unhandled webhook error");
        sendJson(res, 500, { error: "Internal server error" });
      });
    });

    const bind = this.config.bind ?? "127.0.0.1";
    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, bind, () => {
        log.info({ port: this.config.port, bind }, "webhook server listening");
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Health check — no auth required
    if (url === "/health" && method === "GET") {
      sendJson(res, 200, { status: "ok", uptime: process.uptime() });
      return;
    }

    // Dashboard — no auth required (the SPA handles auth client-side)
    if (method === "GET" && (url === "/" || url === "/dashboard")) {
      this.serveDashboard(res);
      return;
    }

    // Auth check for all other endpoints
    if (!this.authenticate(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // REST API routes — delegate to ApiRouter
    if (url.startsWith("/api/")) {
      if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      let body: Record<string, unknown> | undefined;
      if (method === "POST" || method === "PUT") {
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
      }
      const handled = await this.apiRouter.handle(method, url, res, body);
      if (!handled) {
        sendJson(res, 404, { error: "Not found" });
      }
      return;
    }

    if (method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // Parse body for webhook endpoints
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    switch (url) {
      case "/hooks/wake":
        await this.handleWake(body, res);
        break;

      case "/hooks/agent":
        await this.handleAgent(body, res);
        break;

      default:
        sendJson(res, 404, { error: "Not found" });
    }
  }

  // ── Webhook Handlers ───────────────────────────────────────────────

  /**
   * POST /hooks/wake — inject a message into a session.
   * Body: { chatId?: string, message: string }
   */
  private async handleWake(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const message = body.message as string | undefined;
    if (!message || typeof message !== "string") {
      sendJson(res, 400, { error: "Missing required 'message' field" });
      return;
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      sendJson(res, 400, {
        error: `'message' exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`,
      });
      return;
    }

    const chatId = (body.chatId as string | undefined) ?? undefined;

    if (!this.wakeHandler) {
      sendJson(res, 503, { error: "Wake handler not configured" });
      return;
    }

    log.info({ chatId, msgLen: message.length }, "webhook wake");

    try {
      await this.wakeHandler(chatId ?? "", message);
      sendJson(res, 200, { status: "delivered" });
    } catch (e) {
      log.error({ err: e }, "wake handler failed");
      sendJson(res, 500, { error: "Delivery failed" });
    }
  }

  /**
   * POST /hooks/agent — run an isolated agent turn and return the result.
   * Body: { prompt: string, model?: string, maxTurns?: number }
   */
  private async handleAgent(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const prompt = body.prompt as string | undefined;
    if (!prompt || typeof prompt !== "string") {
      sendJson(res, 400, { error: "Missing required 'prompt' field" });
      return;
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      sendJson(res, 400, {
        error: `'prompt' exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`,
      });
      return;
    }

    const model = (body.model as string | undefined) ?? undefined;
    const maxTurns = typeof body.maxTurns === "number" ? body.maxTurns : undefined;

    log.info({ model, maxTurns, promptLen: prompt.length }, "webhook agent turn");

    // Build a temporary job config for the runner
    const jobConfig: CronJobConfig = {
      id: `webhook-${Date.now()}`,
      schedule: "",
      prompt,
      ...(model && { model }),
      ...(maxTurns && { maxTurns }),
    };

    try {
      const result = await runCronJob(jobConfig, this.claudeConfig);

      sendJson(res, 200, {
        status: result.isError ? "error" : "ok",
        text: result.text,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
      });
    } catch (e) {
      log.error({ err: e }, "agent turn failed");
      sendJson(res, 500, { error: "Agent execution failed" });
    }
  }

  // ── Dashboard ────────────────────────────────────────────────────────

  /** Load the dashboard HTML at startup. Checks dist/ first, then src/ (dev). */
  private loadDashboard(): void {
    const candidates = [
      join(__dirname, "..", "dashboard", "index.html"), // dist/dashboard/index.html
      join(__dirname, "..", "..", "src", "dashboard", "index.html"), // src/dashboard/index.html (dev)
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try {
          this.dashboardHtml = readFileSync(candidate, "utf-8");
          log.info({ path: candidate }, "dashboard loaded");
          return;
        } catch (e) {
          log.warn({ path: candidate, err: e }, "failed to read dashboard file");
        }
      }
    }

    log.warn("dashboard HTML not found; dashboard will be unavailable");
  }

  /** Serve the dashboard HTML. */
  private serveDashboard(res: ServerResponse): void {
    if (!this.dashboardHtml) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Dashboard not available. Ensure src/dashboard/index.html exists.");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(this.dashboardHtml);
  }

  private authenticate(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    const tokenHeader = req.headers["x-familiar-token"] as string | undefined;

    if (authHeader) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match && match[1] === this.config.token) return true;
    }

    if (tokenHeader === this.config.token) return true;

    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Maximum allowed request body size (1 MB). Prevents memory exhaustion from oversized payloads. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Maximum length for user-supplied message text (64 KB). */
export const MAX_MESSAGE_LENGTH = 64 * 1024;

/** Maximum length for user-supplied prompt text (64 KB). */
export const MAX_PROMPT_LENGTH = 64 * 1024;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
