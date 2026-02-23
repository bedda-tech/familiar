import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentWorkspace } from "./workspace.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// We also need to mock getConfigDir since AgentWorkspace defaults to it
vi.mock("../config.js", () => ({
  getConfigDir: () => "/tmp/familiar-test-config",
}));

describe("AgentWorkspace", () => {
  let tmpDir: string;
  let workspace: AgentWorkspace;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "familiar-ws-test-"));
    workspace = new AgentWorkspace(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. ensureWorkspace creates directory tree
  it("ensureWorkspace creates the workspace directory structure", () => {
    const root = workspace.ensureWorkspace("job-1");

    expect(root).toBe(join(tmpDir, "job-1"));

    expect(existsSync(join(root, "output"))).toBe(true);
    expect(existsSync(join(root, "workspace"))).toBe(true);
    expect(existsSync(join(root, "state.json"))).toBe(true);
    expect(existsSync(join(root, "memory.md"))).toBe(true);
  });

  // 2. ensureWorkspace initializes state.json with correct defaults
  it("ensureWorkspace initializes state.json with correct defaults", () => {
    workspace.ensureWorkspace("job-1");
    const state = workspace.getState("job-1");

    expect(state).not.toBeNull();
    expect(state!.agentId).toBe("job-1");
    expect(state!.runCount).toBe(0);
    expect(state!.createdAt).toBeDefined();
    expect(state!.data).toEqual({});
    expect(state!.lastRunAt).toBeUndefined();
  });

  // 3. ensureWorkspace is idempotent — calling twice does not reset state
  it("ensureWorkspace is idempotent — second call preserves existing state", () => {
    workspace.ensureWorkspace("job-1");
    workspace.setState("job-1", { runCount: 5 });

    // Call again
    workspace.ensureWorkspace("job-1");
    const state = workspace.getState("job-1");

    expect(state!.runCount).toBe(5);
  });

  // 4. getState returns null for non-existent agent
  it("getState returns null for unknown agent", () => {
    const state = workspace.getState("nonexistent");
    expect(state).toBeNull();
  });

  // 5. setState merges data correctly
  it("setState merges top-level fields and data map", () => {
    workspace.ensureWorkspace("job-1");
    workspace.setState("job-1", { runCount: 3, data: { key1: "value1" } });
    workspace.setState("job-1", { data: { key2: "value2" } });

    const state = workspace.getState("job-1");
    expect(state!.runCount).toBe(3);
    expect(state!.data["key1"]).toBe("value1");
    expect(state!.data["key2"]).toBe("value2");
  });

  // 6. setState preserves agentId even if caller provides different id
  it("setState preserves the original agentId", () => {
    workspace.ensureWorkspace("job-original");
    workspace.setState("job-original", { agentId: "different-id" } as never);

    const state = workspace.getState("job-original");
    expect(state!.agentId).toBe("job-original");
  });

  // 7. recordRunStart increments runCount and sets lastRunAt
  it("recordRunStart increments runCount and sets lastRunAt", () => {
    workspace.ensureWorkspace("job-1");

    workspace.recordRunStart("job-1");
    let state = workspace.getState("job-1");
    expect(state!.runCount).toBe(1);
    expect(state!.lastRunAt).toBeDefined();

    workspace.recordRunStart("job-1");
    state = workspace.getState("job-1");
    expect(state!.runCount).toBe(2);
  });

  // 8. recordRunStart works on a fresh agent (no prior ensureWorkspace)
  it("recordRunStart auto-creates workspace if needed", () => {
    workspace.recordRunStart("new-agent");
    const state = workspace.getState("new-agent");
    expect(state).not.toBeNull();
    expect(state!.runCount).toBe(1);
  });

  // 9. appendMemory writes to memory.md
  it("appendMemory appends a timestamped line to memory.md", () => {
    workspace.ensureWorkspace("job-1");
    workspace.appendMemory("job-1", "remembered something important");

    const content = readFileSync(join(tmpDir, "job-1", "memory.md"), "utf-8");
    expect(content).toContain("remembered something important");
    // Should have a timestamp-like prefix
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}/);
  });

  // 10. readMemory returns initial template when nothing appended
  it("readMemory returns initial template content", () => {
    workspace.ensureWorkspace("job-1");
    const content = workspace.readMemory("job-1");
    expect(content).toContain("# Agent Memory: job-1");
  });

  // 11. readMemory returns empty string for non-existent agent
  it("readMemory returns empty string for unknown agent", () => {
    const content = workspace.readMemory("nonexistent");
    expect(content).toBe("");
  });

  // 12. listOutputs returns empty array when no outputs
  it("listOutputs returns empty array when output dir is empty", () => {
    workspace.ensureWorkspace("job-1");
    const outputs = workspace.listOutputs("job-1");
    expect(outputs).toEqual([]);
  });

  // 13. listOutputs returns file names
  it("listOutputs returns names of files in output directory", () => {
    workspace.ensureWorkspace("job-1");
    const outputDir = workspace.getOutputDir("job-1");
    writeFileSync(join(outputDir, "run-001.txt"), "output content");
    writeFileSync(join(outputDir, "run-002.txt"), "more output");

    const outputs = workspace.listOutputs("job-1");
    expect(outputs).toHaveLength(2);
    expect(outputs).toContain("run-001.txt");
    expect(outputs).toContain("run-002.txt");
  });

  // 14. listOutputs returns empty for non-existent agent
  it("listOutputs returns empty array for unknown agent", () => {
    const outputs = workspace.listOutputs("nonexistent");
    expect(outputs).toEqual([]);
  });

  // 15. getOutputDir and getScratchDir return correct paths
  it("getOutputDir and getScratchDir return correct sub-paths", () => {
    const outputDir = workspace.getOutputDir("job-1");
    const scratchDir = workspace.getScratchDir("job-1");

    expect(outputDir).toBe(join(tmpDir, "job-1", "output"));
    expect(scratchDir).toBe(join(tmpDir, "job-1", "workspace"));
  });

  // 16. getWorkspacePath respects the baseDir
  it("getWorkspacePath returns path under the configured baseDir", () => {
    const path = workspace.getWorkspacePath("my-agent");
    expect(path).toBe(join(tmpDir, "my-agent"));
  });

  // 17. buildSystemPromptFragment mentions workspace path and state
  it("buildSystemPromptFragment includes workspace path and run count", () => {
    workspace.ensureWorkspace("job-1");
    workspace.recordRunStart("job-1");

    const fragment = workspace.buildSystemPromptFragment("job-1");

    expect(fragment).toContain("Agent Workspace");
    expect(fragment).toContain(join(tmpDir, "job-1"));
    expect(fragment).toContain("run #1");
    expect(fragment).toContain("state.json");
    expect(fragment).toContain("memory.md");
    expect(fragment).toContain("output/");
    expect(fragment).toContain("workspace/");
  });

  // 18. buildSystemPromptFragment mentions persisted data keys
  it("buildSystemPromptFragment lists persisted data keys", () => {
    workspace.ensureWorkspace("job-1");
    workspace.setState("job-1", { data: { foo: "bar", count: 42 } });

    const fragment = workspace.buildSystemPromptFragment("job-1");
    expect(fragment).toContain("foo");
    expect(fragment).toContain("count");
  });

  // 19. listAgents returns known agent IDs
  it("listAgents returns all workspace directory names", () => {
    workspace.ensureWorkspace("agent-a");
    workspace.ensureWorkspace("agent-b");
    workspace.ensureWorkspace("agent-c");

    const agents = workspace.listAgents();
    expect(agents).toHaveLength(3);
    expect(agents).toContain("agent-a");
    expect(agents).toContain("agent-b");
    expect(agents).toContain("agent-c");
  });

  // 20. listAgents returns empty array when no agents exist
  it("listAgents returns empty array when no workspaces exist", () => {
    // Fresh workspace with a new empty dir
    const emptyDir = mkdtempSync(join(tmpdir(), "familiar-ws-empty-"));
    try {
      const emptyWs = new AgentWorkspace(emptyDir);
      const agents = emptyWs.listAgents();
      expect(agents).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // 21. sanitizeId — special characters in agent ID are replaced
  it("sanitizeId replaces special characters in agent ID for directory naming", () => {
    // Forward slash would normally be invalid in a path component
    workspace.ensureWorkspace("cron/special:job");
    const path = workspace.getWorkspacePath("cron/special:job");
    // sanitizeId replaces / and : with _
    expect(path).toContain("cron_special_job");
  });

  // 22. Multiple setState calls accumulate data
  it("setState accumulates data across multiple calls", () => {
    workspace.ensureWorkspace("job-1");
    workspace.setState("job-1", { data: { a: 1 } });
    workspace.setState("job-1", { data: { b: 2 } });
    workspace.setState("job-1", { data: { c: 3 } });

    const state = workspace.getState("job-1");
    expect(state!.data).toEqual({ a: 1, b: 2, c: 3 });
  });
});
