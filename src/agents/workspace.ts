import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-workspace");

/** Persistent state for an agent workspace */
export interface AgentState {
  /** Agent / job ID */
  agentId: string;
  /** ISO timestamp of when the workspace was created */
  createdAt: string;
  /** ISO timestamp of the last run */
  lastRunAt?: string;
  /** Number of completed runs */
  runCount: number;
  /** Arbitrary key-value data the agent can persist across runs */
  data: Record<string, unknown>;
}

/**
 * Manages per-agent workspace directories under ~/.familiar/agents/{agent-id}/.
 *
 * Each workspace contains:
 *   state.json  — persistent state across runs
 *   output/     — output files from runs
 *   workspace/  — scratch space for the agent
 *   memory.md   — agent-specific memory file
 */
export class AgentWorkspace {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(getConfigDir(), "agents");
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** Get the root path for a specific agent workspace. */
  getWorkspacePath(agentId: string): string {
    return join(this.baseDir, sanitizeId(agentId));
  }

  /**
   * Ensure the workspace directory structure exists for an agent.
   * Creates the directory tree and initializes state.json if missing.
   * Returns the workspace root path.
   */
  ensureWorkspace(agentId: string): string {
    const root = this.getWorkspacePath(agentId);
    const outputDir = join(root, "output");
    const scratchDir = join(root, "workspace");

    mkdirSync(outputDir, { recursive: true });
    mkdirSync(scratchDir, { recursive: true });

    const statePath = join(root, "state.json");
    if (!existsSync(statePath)) {
      const initial: AgentState = {
        agentId,
        createdAt: new Date().toISOString(),
        runCount: 0,
        data: {},
      };
      writeFileSync(statePath, JSON.stringify(initial, null, 2), "utf-8");
      log.info({ agentId, root }, "initialized agent workspace");
    }

    const memoryPath = join(root, "memory.md");
    if (!existsSync(memoryPath)) {
      writeFileSync(memoryPath, `# Agent Memory: ${agentId}\n\n`, "utf-8");
    }

    return root;
  }

  /** Read the agent's persistent state. Returns null if workspace doesn't exist. */
  getState(agentId: string): AgentState | null {
    const statePath = join(this.getWorkspacePath(agentId), "state.json");
    if (!existsSync(statePath)) return null;

    try {
      const raw = readFileSync(statePath, "utf-8");
      return JSON.parse(raw) as AgentState;
    } catch (e) {
      log.error({ agentId, err: e }, "failed to read agent state");
      return null;
    }
  }

  /** Write or merge the agent's persistent state. */
  setState(agentId: string, state: Partial<AgentState>): void {
    const root = this.ensureWorkspace(agentId);
    const statePath = join(root, "state.json");

    let current: AgentState;
    try {
      const raw = readFileSync(statePath, "utf-8");
      current = JSON.parse(raw) as AgentState;
    } catch {
      current = {
        agentId,
        createdAt: new Date().toISOString(),
        runCount: 0,
        data: {},
      };
    }

    const merged: AgentState = {
      ...current,
      ...state,
      agentId, // always keep the original ID
      data: {
        ...current.data,
        ...(state.data ?? {}),
      },
    };

    writeFileSync(statePath, JSON.stringify(merged, null, 2), "utf-8");
  }

  /** Increment the run count and set lastRunAt. Call at the start of each run. */
  recordRunStart(agentId: string): void {
    const state = this.getState(agentId);
    if (!state) {
      this.ensureWorkspace(agentId);
    }
    const current = this.getState(agentId)!;
    this.setState(agentId, {
      lastRunAt: new Date().toISOString(),
      runCount: current.runCount + 1,
    });
  }

  /** Append a line to the agent's memory file. */
  appendMemory(agentId: string, line: string): void {
    const root = this.ensureWorkspace(agentId);
    const memoryPath = join(root, "memory.md");
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    appendFileSync(memoryPath, `- [${timestamp}] ${line}\n`, "utf-8");
  }

  /** Read the agent's memory file. Returns empty string if not found. */
  readMemory(agentId: string): string {
    const memoryPath = join(this.getWorkspacePath(agentId), "memory.md");
    if (!existsSync(memoryPath)) return "";
    try {
      return readFileSync(memoryPath, "utf-8");
    } catch {
      return "";
    }
  }

  /** List output files for an agent. */
  listOutputs(agentId: string): string[] {
    const outputDir = join(this.getWorkspacePath(agentId), "output");
    if (!existsSync(outputDir)) return [];
    try {
      return readdirSync(outputDir);
    } catch {
      return [];
    }
  }

  /** Get the path to the agent's output directory. */
  getOutputDir(agentId: string): string {
    return join(this.getWorkspacePath(agentId), "output");
  }

  /** Get the path to the agent's scratch workspace. */
  getScratchDir(agentId: string): string {
    return join(this.getWorkspacePath(agentId), "workspace");
  }

  /**
   * Build a system prompt fragment describing the agent's workspace.
   * This is injected into the agent's context so it knows where to find its files.
   */
  buildSystemPromptFragment(agentId: string): string {
    const root = this.getWorkspacePath(agentId);
    const state = this.getState(agentId);
    const outputs = this.listOutputs(agentId);

    const lines = [
      `## Agent Workspace`,
      `You have a persistent workspace at: ${root}`,
      ``,
      `Directory structure:`,
      `  ${root}/state.json   — your persistent state (read/write JSON)`,
      `  ${root}/memory.md    — your memory file (append notes here)`,
      `  ${root}/output/      — place output files here (${outputs.length} existing)`,
      `  ${root}/workspace/   — scratch space for intermediate work`,
    ];

    if (state) {
      lines.push(``);
      lines.push(`Current state: run #${state.runCount}, last run: ${state.lastRunAt ?? "never"}`);
      if (Object.keys(state.data).length > 0) {
        lines.push(`Persisted data keys: ${Object.keys(state.data).join(", ")}`);
      }
    }

    return lines.join("\n");
  }

  /** List all known agent workspaces. */
  listAgents(): string[] {
    if (!existsSync(this.baseDir)) return [];
    try {
      return readdirSync(this.baseDir);
    } catch {
      return [];
    }
  }
}

/** Sanitize an agent ID for use as a directory name. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
