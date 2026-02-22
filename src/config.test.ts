import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock/home"),
}));

import { readFileSync, existsSync } from "node:fs";
import { parseDuration, loadConfig, getConfigDir, configExists } from "./config.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

/** Minimal valid config that satisfies all required fields. */
function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    telegram: {
      botToken: "123:ABC",
      allowedUsers: [111],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------
describe("parseDuration", () => {
  it("parses milliseconds", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  it("parses seconds", () => {
    expect(parseDuration("1s")).toBe(1_000);
    expect(parseDuration("30s")).toBe(30_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1m")).toBe(60_000);
  });

  it("parses hours", () => {
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("parses days", () => {
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  it("handles zero values", () => {
    expect(parseDuration("0s")).toBe(0);
    expect(parseDuration("0h")).toBe(0);
    expect(parseDuration("0ms")).toBe(0);
  });

  it("handles large values", () => {
    expect(parseDuration("365d")).toBe(365 * 86_400_000);
    expect(parseDuration("9999ms")).toBe(9_999);
  });

  it("allows optional whitespace between number and unit", () => {
    expect(parseDuration("10 ms")).toBe(10);
    expect(parseDuration("5 h")).toBe(5 * 3_600_000);
  });

  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });

  it("throws on bare number without unit", () => {
    expect(() => parseDuration("100")).toThrow("Invalid duration");
  });

  it("throws on bare unit without number", () => {
    expect(() => parseDuration("ms")).toThrow("Invalid duration");
  });

  it("throws on unknown unit", () => {
    expect(() => parseDuration("10w")).toThrow("Invalid duration");
    expect(() => parseDuration("5y")).toThrow("Invalid duration");
  });

  it("throws on negative values", () => {
    expect(() => parseDuration("-5m")).toThrow("Invalid duration");
  });

  it("throws on decimal values", () => {
    expect(() => parseDuration("1.5h")).toThrow("Invalid duration");
  });

  it("throws on non-string-like garbage", () => {
    expect(() => parseDuration("foobar")).toThrow("Invalid duration");
  });

  it("includes the offending value in the error message", () => {
    expect(() => parseDuration("bad")).toThrow("bad");
  });
});

// ---------------------------------------------------------------------------
// getConfigDir
// ---------------------------------------------------------------------------
describe("getConfigDir", () => {
  it("returns ~/.familiar based on mocked homedir", () => {
    expect(getConfigDir()).toBe("/mock/home/.familiar");
  });
});

// ---------------------------------------------------------------------------
// configExists
// ---------------------------------------------------------------------------
describe("configExists", () => {
  it("returns true when config file exists", () => {
    mockedExistsSync.mockReturnValue(true);
    expect(configExists()).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith("/mock/home/.familiar/config.json");
  });

  it("returns false when config file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(configExists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------
describe("loadConfig", () => {
  describe("valid configs", () => {
    it("loads a minimal valid config and merges with defaults", () => {
      const cfg = validConfig();
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

      const result = loadConfig("/tmp/test-config.json");

      // User-specified values preserved
      expect(result.telegram.botToken).toBe("123:ABC");
      expect(result.telegram.allowedUsers).toEqual([111]);

      // Defaults filled in
      expect(result.claude.model).toBe("sonnet");
      expect(result.claude.maxTurns).toBe(25);
      expect(result.claude.workingDirectory).toBe("/mock/home/familiar-workspace");
      expect(result.claude.allowedTools).toEqual([
        "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
      ]);
      expect(result.sessions.inactivityTimeout).toBe("24h");
      expect(result.sessions.rotateAfterMessages).toBe(200);
      expect(result.log.level).toBe("info");
    });

    it("uses the default config path when none is provided", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(validConfig()));

      loadConfig();

      expect(mockedExistsSync).toHaveBeenCalledWith("/mock/home/.familiar/config.json");
      expect(mockedReadFileSync).toHaveBeenCalledWith("/mock/home/.familiar/config.json", "utf-8");
    });

    it("user-provided claude values override defaults (deep merge)", () => {
      const cfg = validConfig({
        claude: {
          workingDirectory: "/my/workspace",
          model: "opus",
        },
      });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

      const result = loadConfig("/tmp/test-config.json");

      // Overridden values
      expect(result.claude.workingDirectory).toBe("/my/workspace");
      expect(result.claude.model).toBe("opus");

      // Defaults still present for non-overridden nested fields
      expect(result.claude.maxTurns).toBe(25);
      expect(result.claude.systemPrompt).toContain("helpful personal assistant");
      expect(result.claude.allowedTools).toBeDefined();
    });

    it("user-provided session values override defaults", () => {
      const cfg = validConfig({
        sessions: {
          inactivityTimeout: "1h",
          rotateAfterMessages: 50,
        },
      });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

      const result = loadConfig("/tmp/test-config.json");

      expect(result.sessions.inactivityTimeout).toBe("1h");
      expect(result.sessions.rotateAfterMessages).toBe(50);
    });

    it("arrays from user config replace default arrays (not merge)", () => {
      const cfg = validConfig({
        claude: {
          workingDirectory: "/w",
          allowedTools: ["Bash"],
        },
      });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

      const result = loadConfig("/tmp/test-config.json");

      // Arrays should be replaced, not concatenated
      expect(result.claude.allowedTools).toEqual(["Bash"]);
    });

    it("preserves optional top-level sections like cron", () => {
      const cfg = validConfig({
        cron: {
          jobs: [{ id: "heartbeat", schedule: "*/5 * * * *", prompt: "ping" }],
        },
      });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

      const result = loadConfig("/tmp/test-config.json");

      expect(result.cron).toBeDefined();
      expect(result.cron!.jobs).toHaveLength(1);
      expect(result.cron!.jobs[0].id).toBe("heartbeat");
    });

    it("preserves optional openai section", () => {
      const cfg = validConfig({
        openai: { apiKey: "sk-test", whisperModel: "whisper-1" },
      });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

      const result = loadConfig("/tmp/test-config.json");

      expect(result.openai).toBeDefined();
      expect(result.openai!.apiKey).toBe("sk-test");
    });

    it("preserves optional webhooks section", () => {
      const cfg = validConfig({
        webhooks: { port: 9090, token: "secret" },
      });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

      const result = loadConfig("/tmp/test-config.json");

      expect(result.webhooks).toBeDefined();
      expect(result.webhooks!.port).toBe(9090);
      expect(result.webhooks!.token).toBe("secret");
    });

    it("handles multiple allowed users", () => {
      const cfg = validConfig();
      (cfg.telegram as Record<string, unknown>).allowedUsers = [111, 222, 333];
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

      const result = loadConfig("/tmp/test-config.json");

      expect(result.telegram.allowedUsers).toEqual([111, 222, 333]);
    });
  });

  describe("missing config file", () => {
    it("throws when config file does not exist", () => {
      mockedExistsSync.mockReturnValue(false);

      expect(() => loadConfig("/nonexistent/config.json")).toThrow(
        "Config file not found",
      );
    });

    it("includes the path in the error message", () => {
      mockedExistsSync.mockReturnValue(false);

      expect(() => loadConfig("/some/path.json")).toThrow("/some/path.json");
    });

    it("suggests running 'familiar init'", () => {
      mockedExistsSync.mockReturnValue(false);

      expect(() => loadConfig("/p.json")).toThrow("familiar init");
    });
  });

  describe("invalid JSON", () => {
    it("throws on malformed JSON", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("{not valid json");

      expect(() => loadConfig("/tmp/bad.json")).toThrow("Failed to parse config");
    });

    it("includes the path in the parse error", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("}}}{{{");

      expect(() => loadConfig("/tmp/bad.json")).toThrow("/tmp/bad.json");
    });
  });

  describe("validation errors", () => {
    it("throws when telegram section is missing entirely", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify({}));

      expect(() => loadConfig("/tmp/c.json")).toThrow("telegram");
    });

    it("throws when telegram is not an object", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify({ telegram: "bad" }));

      expect(() => loadConfig("/tmp/c.json")).toThrow("telegram");
    });

    it("throws when telegram is null", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify({ telegram: null }));

      expect(() => loadConfig("/tmp/c.json")).toThrow("telegram");
    });

    it("throws when botToken is missing", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ telegram: { allowedUsers: [1] } }),
      );

      expect(() => loadConfig("/tmp/c.json")).toThrow("botToken");
    });

    it("throws when botToken is empty string", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ telegram: { botToken: "", allowedUsers: [1] } }),
      );

      expect(() => loadConfig("/tmp/c.json")).toThrow("botToken");
    });

    it("throws when botToken is a number instead of string", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ telegram: { botToken: 12345, allowedUsers: [1] } }),
      );

      expect(() => loadConfig("/tmp/c.json")).toThrow("botToken");
    });

    it("throws when allowedUsers is missing", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ telegram: { botToken: "tok" } }),
      );

      expect(() => loadConfig("/tmp/c.json")).toThrow("allowedUsers");
    });

    it("throws when allowedUsers is an empty array", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ telegram: { botToken: "tok", allowedUsers: [] } }),
      );

      expect(() => loadConfig("/tmp/c.json")).toThrow("allowedUsers");
    });

    it("throws when allowedUsers is not an array", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ telegram: { botToken: "tok", allowedUsers: "bad" } }),
      );

      expect(() => loadConfig("/tmp/c.json")).toThrow("allowedUsers");
    });
  });
});
