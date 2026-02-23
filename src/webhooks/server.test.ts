import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import http from "node:http";
import { WebhookServer, MAX_MESSAGE_LENGTH, MAX_PROMPT_LENGTH } from "./server.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

// Minimal ClaudeConfig for the server constructor
const claudeConfig = { workingDirectory: "/tmp" } as never;

function makeServer(token = "test-token") {
  return new WebhookServer({ port: 0, token }, claudeConfig);
}

/** Send an HTTP request and return { status, body }. */
function req(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
        ...headers,
      },
    };
    const r = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>,
          });
        } catch {
          reject(new Error("Failed to parse response"));
        }
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Get the port the server is listening on after start(). */
function getPort(server: WebhookServer): number {
  // Access the private `server` field via cast to retrieve the bound port
  const httpServer = (server as unknown as { server: http.Server }).server;
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  return addr.port;
}

describe("WebhookServer — input validation", () => {
  let srv: WebhookServer;
  let port: number;

  beforeEach(async () => {
    srv = makeServer();
    await srv.start();
    port = getPort(srv);
  });

  afterEach(() => {
    srv.stop();
  });

  // ── Auth ───────────────────────────────────────────────────────────

  it("rejects requests without a valid token", async () => {
    const { status } = await req(port, "POST", "/hooks/wake", { message: "hi" });
    expect(status).toBe(401);
  });

  it("accepts requests with a valid Bearer token", async () => {
    // No wakeHandler → 503, but we got past auth
    const { status } = await req(port, "POST", "/hooks/wake", { message: "hi" }, {
      Authorization: "Bearer test-token",
    });
    expect(status).not.toBe(401);
  });

  // ── /hooks/wake — message length ───────────────────────────────────

  it("rejects /hooks/wake with missing 'message'", async () => {
    const { status, body } = await req(port, "POST", "/hooks/wake", {}, {
      Authorization: "Bearer test-token",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/message/i);
  });

  it("rejects /hooks/wake when 'message' exceeds MAX_MESSAGE_LENGTH", async () => {
    const message = "x".repeat(MAX_MESSAGE_LENGTH + 1);
    const { status, body } = await req(port, "POST", "/hooks/wake", { message }, {
      Authorization: "Bearer test-token",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/exceeds maximum length/i);
  });

  it("accepts /hooks/wake when 'message' is exactly MAX_MESSAGE_LENGTH", async () => {
    const message = "x".repeat(MAX_MESSAGE_LENGTH);
    const { status } = await req(port, "POST", "/hooks/wake", { message }, {
      Authorization: "Bearer test-token",
    });
    // No wakeHandler configured → 503, but validation passed
    expect(status).not.toBe(400);
  });

  // ── /hooks/agent — prompt length ───────────────────────────────────

  it("rejects /hooks/agent with missing 'prompt'", async () => {
    const { status, body } = await req(port, "POST", "/hooks/agent", {}, {
      Authorization: "Bearer test-token",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/prompt/i);
  });

  it("rejects /hooks/agent when 'prompt' exceeds MAX_PROMPT_LENGTH", async () => {
    const prompt = "x".repeat(MAX_PROMPT_LENGTH + 1);
    const { status, body } = await req(port, "POST", "/hooks/agent", { prompt }, {
      Authorization: "Bearer test-token",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/exceeds maximum length/i);
  });

  it("accepts /hooks/agent when 'prompt' is exactly MAX_PROMPT_LENGTH", async () => {
    const prompt = "x".repeat(MAX_PROMPT_LENGTH);
    // This will try to actually run the cron job and fail, but it passes validation
    const { status } = await req(port, "POST", "/hooks/agent", { prompt }, {
      Authorization: "Bearer test-token",
    });
    // Should be 500 (execution failure) not 400 (validation failure)
    expect(status).not.toBe(400);
  });

  // ── Constants ──────────────────────────────────────────────────────

  it("MAX_MESSAGE_LENGTH is 64 KB", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(64 * 1024);
  });

  it("MAX_PROMPT_LENGTH is 64 KB", () => {
    expect(MAX_PROMPT_LENGTH).toBe(64 * 1024);
  });

  // ── Health ─────────────────────────────────────────────────────────

  it("GET /health returns 200 without auth", async () => {
    const { status, body } = await req(port, "GET", "/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });
});
