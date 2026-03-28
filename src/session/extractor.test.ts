import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process spawnSync
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

// Mock node:fs existsSync
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock logger
vi.mock("../util/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { spawnSync } from "node:child_process";
import { extractSessionMemories } from "./extractor.js";

/** Minimal MemoryStore stub */
function makeMemoryStore(searchScore = 0.0) {
  return {
    search: vi.fn().mockResolvedValue(searchScore > 0 ? [{ score: searchScore }] : []),
    write: vi.fn().mockResolvedValue({ relPath: "memory/profile/test.md", category: "profile" }),
  } as unknown as import("../memory/store.js").MemoryStore;
}

const BASE_MESSAGES = Array.from({ length: 4 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `Message ${i + 1} content`,
  created_at: `2026-03-28T10:0${i}:00`,
}));

describe("extractSessionMemories", () => {
  const spawnSyncMock = vi.mocked(spawnSync);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 with fewer than 4 messages", async () => {
    const store = makeMemoryStore();
    const result = await extractSessionMemories(BASE_MESSAGES.slice(0, 3), "/workspace", store);
    expect(result).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns 0 when claude exits non-zero", async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "error", error: undefined } as ReturnType<typeof spawnSync>);
    const store = makeMemoryStore();
    const result = await extractSessionMemories(BASE_MESSAGES, "/workspace", store);
    expect(result).toBe(0);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("returns 0 when output has no JSON array", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "No memories to extract.", stderr: "", error: undefined } as ReturnType<typeof spawnSync>);
    const store = makeMemoryStore();
    const result = await extractSessionMemories(BASE_MESSAGES, "/workspace", store);
    expect(result).toBe(0);
  });

  it("writes memories when extraction returns valid candidates", async () => {
    const candidates = [
      { category: "profile", filename: "user_role", content: "Matt is a software engineer building AI products." },
      { category: "preferences", filename: "response_style", content: "Prefers concise responses under 3 sentences." },
    ];
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify(candidates),
      stderr: "",
      error: undefined,
    } as ReturnType<typeof spawnSync>);

    const store = makeMemoryStore(0.0); // no duplicates
    const result = await extractSessionMemories(BASE_MESSAGES, "/workspace", store);

    expect(result).toBe(2);
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(store.write).toHaveBeenCalledWith("profile", "user_role.md", candidates[0].content);
    expect(store.write).toHaveBeenCalledWith("preferences", "response_style.md", candidates[1].content);
  });

  it("skips near-duplicate memories (score > 1.5)", async () => {
    const candidates = [
      { category: "profile", filename: "user_role", content: "Matt is a software engineer." },
    ];
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify(candidates),
      stderr: "",
      error: undefined,
    } as ReturnType<typeof spawnSync>);

    const store = makeMemoryStore(1.8); // high similarity score — duplicate
    const result = await extractSessionMemories(BASE_MESSAGES, "/workspace", store);

    expect(result).toBe(0);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("filters out invalid candidates (bad category, empty content)", async () => {
    const candidates = [
      { category: "invalid_cat", filename: "foo", content: "Some content" },
      { category: "entities", filename: "", content: "Missing filename" },
      { category: "events", filename: "event_x", content: "ok" }, // content too short (<= 10)
      { category: "tools", filename: "gh_cli", content: "gh pr create creates a GitHub pull request" },
    ];
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify(candidates),
      stderr: "",
      error: undefined,
    } as ReturnType<typeof spawnSync>);

    const store = makeMemoryStore(0.0);
    const result = await extractSessionMemories(BASE_MESSAGES, "/workspace", store);

    // Only "tools" candidate passes validation
    expect(result).toBe(1);
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(store.write).toHaveBeenCalledWith("tools", "gh_cli.md", candidates[3].content);
  });

  it("finds JSON array embedded in surrounding text", async () => {
    const candidates = [{ category: "skills", filename: "typescript_expertise", content: "Proficient in TypeScript generics and type inference." }];
    const output = `Sure, here are the memories:\n${JSON.stringify(candidates)}\nDone.`;
    spawnSyncMock.mockReturnValue({ status: 0, stdout: output, stderr: "", error: undefined } as ReturnType<typeof spawnSync>);

    const store = makeMemoryStore(0.0);
    const result = await extractSessionMemories(BASE_MESSAGES, "/workspace", store);
    expect(result).toBe(1);
  });

  it("appends .md extension only once", async () => {
    const candidates = [{ category: "patterns", filename: "cron_rescue_loop.md", content: "Use stale_timeout_hours on long-running recurring tasks." }];
    spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify(candidates), stderr: "", error: undefined } as ReturnType<typeof spawnSync>);

    const store = makeMemoryStore(0.0);
    await extractSessionMemories(BASE_MESSAGES, "/workspace", store);
    // Should not double the .md
    expect(store.write).toHaveBeenCalledWith("patterns", "cron_rescue_loop.md", candidates[0].content);
  });
});
