/**
 * Tests for ApiRouter — covers all /api/* endpoints.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { ApiRouter } from "./router.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// ── Mock node:fs ────────────────────────────────────────────────────────────

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

// ── Mock response builder ───────────────────────────────────────────────────

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeMockRes(): { res: ServerResponse; result: () => MockResponse } {
  let status = 0;
  let body: Record<string, unknown> = {};

  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(data: string) {
      try {
        body = JSON.parse(data) as Record<string, unknown>;
      } catch {
        body = {};
      }
    },
  } as unknown as ServerResponse;

  return { res, result: () => ({ status, body }) };
}

// ── Mock dependency factories ───────────────────────────────────────────────

function makeMockAgentStore(agents: Record<string, unknown>[] = []) {
  return {
    getState: () => ({ active: agents, recent: [], activeCount: agents.length }),
    getAgent: (id: string) => agents.find((a: any) => a.id === id) ?? null,
  };
}

function makeMockCronScheduler(
  jobs: Record<string, unknown>[] = [],
  runs: Record<string, unknown>[] = [],
) {
  return {
    listJobs: () => jobs,
    getRunHistory: (_id: string, _limit: number) => runs,
    runNow: async (jobId: string) => {
      const job = jobs.find((j: any) => j.id === jobId);
      if (!job) return null;
      return { jobId, isError: false, text: "ok", costUsd: 0.01, durationMs: 100, numTurns: 1 };
    },
  };
}

// ── Helper ──────────────────────────────────────────────────────────────────

function makeRouter() {
  return new ApiRouter();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ApiRouter — /api/agents", () => {
  let router: ApiRouter;

  beforeEach(() => {
    router = makeRouter();
    vi.clearAllMocks();
  });

  it("returns 503 when agent store is not set", async () => {
    const { res, result } = makeMockRes();
    const handled = await router.handle("GET", "/api/agents", res);
    expect(handled).toBe(true);
    expect(result().status).toBe(503);
  });

  it("returns agent list when store is set", async () => {
    const agent = { id: "abc123", status: "active" };
    router.setAgentStore(makeMockAgentStore([agent]) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/agents", res);
    expect(result().status).toBe(200);
    const body = result().body as { active: unknown[] };
    expect(body.active).toHaveLength(1);
  });

  it("GET /api/agents/:id returns 404 for unknown agent", async () => {
    router.setAgentStore(makeMockAgentStore([]) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/agents/no-such-id", res);
    expect(result().status).toBe(404);
  });

  it("GET /api/agents/:id returns agent when found", async () => {
    const agent = { id: "abc123", status: "done" };
    router.setAgentStore(makeMockAgentStore([agent]) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/agents/abc123", res);
    expect(result().status).toBe(200);
    expect((result().body as { agent: unknown }).agent).toBeTruthy();
  });

  it("GET /api/agents/:id returns 503 when store not set", async () => {
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/agents/abc123", res);
    expect(result().status).toBe(503);
  });
});

describe("ApiRouter — /api/cron", () => {
  let router: ApiRouter;

  beforeEach(() => {
    router = makeRouter();
    vi.clearAllMocks();
  });

  it("returns 503 when scheduler is not set", async () => {
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron", res);
    expect(result().status).toBe(503);
  });

  it("GET /api/cron lists jobs", async () => {
    const jobs = [{ id: "job1", schedule: "0 * * * *" }];
    router.setCronScheduler(makeMockCronScheduler(jobs) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron", res);
    expect(result().status).toBe(200);
    expect((result().body as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it("GET /api/cron/jobs also lists jobs (alias)", async () => {
    const jobs = [{ id: "job1" }];
    router.setCronScheduler(makeMockCronScheduler(jobs) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron/jobs", res);
    expect(result().status).toBe(200);
    expect((result().body as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it("GET /api/cron/jobs/:id returns single job", async () => {
    const jobs = [{ id: "job1", schedule: "0 * * * *" }];
    router.setCronScheduler(makeMockCronScheduler(jobs) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron/jobs/job1", res);
    expect(result().status).toBe(200);
    expect((result().body as { job: { id: string } }).job.id).toBe("job1");
  });

  it("GET /api/cron/jobs/:id returns 404 for missing job", async () => {
    router.setCronScheduler(makeMockCronScheduler([]) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron/jobs/no-such-job", res);
    expect(result().status).toBe(404);
  });

  it("GET /api/cron/jobs/:id/runs returns run history", async () => {
    const jobs = [{ id: "job1" }];
    const runs = [{ startedAt: "2026-01-01T00:00:00Z" }];
    router.setCronScheduler(makeMockCronScheduler(jobs, runs) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron/jobs/job1/runs", res);
    expect(result().status).toBe(200);
    expect((result().body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("GET /api/cron/:id/runs also works (alias)", async () => {
    const jobs = [{ id: "job1" }];
    const runs = [{ startedAt: "2026-01-01T00:00:00Z" }];
    router.setCronScheduler(makeMockCronScheduler(jobs, runs) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron/job1/runs", res);
    expect(result().status).toBe(200);
  });

  it("GET /api/cron/jobs/:id/runs respects ?limit query param", async () => {
    const jobs = [{ id: "job1" }];
    let capturedLimit = 0;
    const scheduler = {
      listJobs: () => jobs,
      getRunHistory: (_id: string, limit: number) => {
        capturedLimit = limit;
        return [];
      },
      runNow: async () => null,
    };
    router.setCronScheduler(scheduler as never);
    const { res } = makeMockRes();
    await router.handle("GET", "/api/cron/jobs/job1/runs?limit=50", res);
    expect(capturedLimit).toBe(50);
  });

  it("GET /api/cron/jobs/:id/runs clamps limit to max 100", async () => {
    const jobs = [{ id: "job1" }];
    let capturedLimit = 0;
    const scheduler = {
      listJobs: () => jobs,
      getRunHistory: (_id: string, limit: number) => {
        capturedLimit = limit;
        return [];
      },
      runNow: async () => null,
    };
    router.setCronScheduler(scheduler as never);
    const { res } = makeMockRes();
    await router.handle("GET", "/api/cron/jobs/job1/runs?limit=999", res);
    expect(capturedLimit).toBe(100);
  });

  it("POST /api/cron/jobs/:id/run triggers job", async () => {
    const jobs = [{ id: "job1" }];
    router.setCronScheduler(makeMockCronScheduler(jobs) as never);
    const { res, result } = makeMockRes();
    await router.handle("POST", "/api/cron/jobs/job1/run", res);
    expect(result().status).toBe(200);
    expect((result().body as { status: string }).status).toBe("ok");
  });

  it("POST /api/cron/jobs/:id/run returns 404 for unknown job", async () => {
    router.setCronScheduler(makeMockCronScheduler([]) as never);
    const { res, result } = makeMockRes();
    await router.handle("POST", "/api/cron/jobs/no-such-job/run", res);
    expect(result().status).toBe(404);
  });
});

describe("ApiRouter — cron CRUD", () => {
  let router: ApiRouter;

  const sampleConfig = {
    telegram: { botToken: "tok", allowedUsers: [] },
    cron: {
      jobs: [{ id: "job1", schedule: "0 * * * *", prompt: "do stuff", model: "sonnet" }],
    },
  };

  beforeEach(() => {
    router = makeRouter();
    vi.clearAllMocks();
    router.setConfigPath("/fake/config.json");
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleConfig));
    mockWriteFileSync.mockImplementation(() => {});
  });

  it("POST /api/cron/jobs creates a new job", async () => {
    const { res, result } = makeMockRes();
    await router.handle("POST", "/api/cron/jobs", res, {
      id: "new-job",
      schedule: "0 9 * * *",
      prompt: "run daily task",
    });
    expect(result().status).toBe(201);
    expect((result().body as { status: string }).status).toBe("created");
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });

  it("POST /api/cron/jobs returns 400 when required fields are missing", async () => {
    const { res, result } = makeMockRes();
    await router.handle("POST", "/api/cron/jobs", res, { id: "x" }); // missing schedule & prompt
    expect(result().status).toBe(400);
  });

  it("POST /api/cron/jobs returns 409 when job id already exists", async () => {
    const { res, result } = makeMockRes();
    await router.handle("POST", "/api/cron/jobs", res, {
      id: "job1",
      schedule: "0 * * * *",
      prompt: "duplicate",
    });
    expect(result().status).toBe(409);
  });

  it("POST /api/cron/jobs returns 503 when config path not set", async () => {
    const r = new ApiRouter();
    const { res, result } = makeMockRes();
    await r.handle("POST", "/api/cron/jobs", res, { id: "x", schedule: "* * * * *", prompt: "y" });
    expect(result().status).toBe(503);
  });

  it("PUT /api/cron/jobs/:id updates a job", async () => {
    const { res, result } = makeMockRes();
    await router.handle("PUT", "/api/cron/jobs/job1", res, { label: "Updated label" });
    expect(result().status).toBe(200);
    expect((result().body as { status: string }).status).toBe("updated");
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });

  it("PUT /api/cron/jobs/:id returns 404 for unknown job", async () => {
    const { res, result } = makeMockRes();
    await router.handle("PUT", "/api/cron/jobs/unknown", res, { label: "x" });
    expect(result().status).toBe(404);
  });

  it("DELETE /api/cron/jobs/:id deletes a job", async () => {
    const { res, result } = makeMockRes();
    await router.handle("DELETE", "/api/cron/jobs/job1", res);
    expect(result().status).toBe(200);
    expect((result().body as { status: string }).status).toBe("deleted");
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });

  it("DELETE /api/cron/jobs/:id returns 404 for unknown job", async () => {
    const { res, result } = makeMockRes();
    await router.handle("DELETE", "/api/cron/jobs/unknown", res);
    expect(result().status).toBe(404);
  });

  it("config change handler is called after create", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    router.setConfigChangeHandler(handler);
    const { res } = makeMockRes();
    await router.handle("POST", "/api/cron/jobs", res, {
      id: "new2",
      schedule: "0 * * * *",
      prompt: "hello",
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("config change handler is called after update", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    router.setConfigChangeHandler(handler);
    const { res } = makeMockRes();
    await router.handle("PUT", "/api/cron/jobs/job1", res, { label: "new" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("config change handler is called after delete", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    router.setConfigChangeHandler(handler);
    const { res } = makeMockRes();
    await router.handle("DELETE", "/api/cron/jobs/job1", res);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("ApiRouter — /api/config", () => {
  let router: ApiRouter;

  beforeEach(() => {
    router = makeRouter();
    vi.clearAllMocks();
  });

  it("returns 503 when config path is not set", async () => {
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/config", res);
    expect(result().status).toBe(503);
  });

  it("returns sanitized config", async () => {
    router.setConfigPath("/fake/config.json");
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        telegram: { botToken: "secret-bot-token" },
        webhooks: { token: "secret-webhook-token" },
        openai: { apiKey: "sk-openai-key" },
        claude: { apiKey: "sk-claude-key" },
        cron: { jobs: [] },
      }),
    );
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/config", res);
    expect(result().status).toBe(200);
    const config = (result().body as { config: Record<string, any> }).config;
    // Tokens should be masked
    expect(config.telegram.botToken).toMatch(/^\*{4}/);
    expect(config.webhooks.token).toMatch(/^\*{4}/);
    expect(config.openai.apiKey).toMatch(/^\*{4}/);
    expect(config.claude.apiKey).toMatch(/^\*{4}/);
    // Last 4 chars preserved
    expect(config.telegram.botToken).toMatch(/oken$/);
    expect(config.openai.apiKey).toMatch(/-key$/);
  });

  it("short tokens are fully masked", async () => {
    router.setConfigPath("/fake/config.json");
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ telegram: { botToken: "abc" } }),
    );
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/config", res);
    const config = (result().body as { config: Record<string, any> }).config;
    expect(config.telegram.botToken).toBe("****");
  });
});

describe("ApiRouter — route matching", () => {
  let router: ApiRouter;

  beforeEach(() => {
    router = makeRouter();
    vi.clearAllMocks();
  });

  it("returns false for unknown routes", async () => {
    const { res } = makeMockRes();
    const handled = await router.handle("GET", "/api/unknown-route", res);
    expect(handled).toBe(false);
  });

  it("returns false for non-API paths", async () => {
    const { res } = makeMockRes();
    const handled = await router.handle("GET", "/health", res);
    expect(handled).toBe(false);
  });

  it("ignores query string when matching routes", async () => {
    router.setCronScheduler(makeMockCronScheduler([{ id: "j1" }]) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron?foo=bar", res);
    expect(result().status).toBe(200);
  });

  it("decodes URL-encoded job ids", async () => {
    const jobs = [{ id: "my job" }];
    router.setCronScheduler(makeMockCronScheduler(jobs) as never);
    const { res, result } = makeMockRes();
    await router.handle("GET", "/api/cron/jobs/my%20job", res);
    expect(result().status).toBe(200);
    expect((result().body as { job: { id: string } }).job.id).toBe("my job");
  });
});
