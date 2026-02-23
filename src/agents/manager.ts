import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClaudeConfig } from "../config.js";
import type { ResultEvent, StreamEvent } from "../claude/types.js";
import { AgentRegistry, type SubagentRecord } from "./registry.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-manager");

export interface SpawnOptions {
  task: string;
  label?: string;
  model?: string;
  maxTurns?: number;
  workingDirectory?: string;
  chatId: string;
}

export type DeliveryHandler = (
  agent: SubagentRecord,
  resultText: string,
  costUsd: number,
  durationMs: number,
) => Promise<void>;

export class AgentManager {
  private processes = new Map<string, ChildProcess>();
  private maxConcurrent: number;
  private deliveryHandler: DeliveryHandler | null = null;

  constructor(
    private registry: AgentRegistry,
    private claudeConfig: ClaudeConfig,
    maxConcurrent = 8,
  ) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Set the handler for delivering sub-agent results */
  onDelivery(handler: DeliveryHandler): void {
    this.deliveryHandler = handler;
  }

  /** Spawn a new sub-agent */
  async spawn(options: SpawnOptions): Promise<{ id: string } | { error: string }> {
    const active = this.registry.activeCount();
    if (active >= this.maxConcurrent) {
      return {
        error: `Max concurrent sub-agents reached (${this.maxConcurrent}). Kill one first.`,
      };
    }

    const id = randomUUID().slice(0, 8);
    const model = options.model ?? "sonnet";

    this.registry.register({
      id,
      task: options.task,
      label: options.label,
      model,
      chatId: options.chatId,
    });

    // Spawn in background
    this.runAgent(id, options, model).catch((e) => {
      log.error({ id, err: e }, "sub-agent crashed");
      this.registry.fail(id, e instanceof Error ? e.message : String(e));
    });

    return { id };
  }

  /** Kill a running sub-agent */
  kill(idPrefix: string): boolean {
    // Find by prefix
    for (const [id, proc] of this.processes) {
      if (id.startsWith(idPrefix)) {
        proc.kill("SIGTERM");
        this.processes.delete(id);
        this.registry.kill(id);
        log.info({ id }, "sub-agent killed");
        return true;
      }
    }
    return false;
  }

  /** Kill all running sub-agents */
  killAll(): number {
    let killed = 0;
    for (const [id, proc] of this.processes) {
      proc.kill("SIGTERM");
      this.registry.kill(id);
      killed++;
    }
    this.processes.clear();
    return killed;
  }

  /** List active sub-agents */
  listActive(chatId?: string): SubagentRecord[] {
    return this.registry.listActive(chatId);
  }

  /** List recent sub-agents */
  listRecent(chatId?: string, limit = 10): SubagentRecord[] {
    return this.registry.listRecent(chatId, limit);
  }

  /** Get info about a specific sub-agent */
  getInfo(idPrefix: string): SubagentRecord | null {
    return this.registry.get(idPrefix);
  }

  private async runAgent(id: string, options: SpawnOptions, model: string): Promise<void> {
    const cwd = options.workingDirectory ?? this.claudeConfig.workingDirectory;
    const maxTurns = options.maxTurns ?? this.claudeConfig.maxTurns ?? 25;

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      "--max-turns",
      String(maxTurns),
    ];

    if (this.claudeConfig.allowedTools?.length) {
      args.push("--allowedTools", this.claudeConfig.allowedTools.join(","));
    }

    if (this.claudeConfig.systemPrompt) {
      args.push("--append-system-prompt", this.claudeConfig.systemPrompt);
    }

    if (this.claudeConfig.mcpConfig) {
      args.push("--mcp-config", this.claudeConfig.mcpConfig);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;

    log.info({ id, model, cwd, task: options.task.slice(0, 100) }, "spawning sub-agent");

    const proc = spawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.processes.set(id, proc);

    // Write task prompt to stdin
    proc.stdin.write(options.task);
    proc.stdin.end();

    // Collect stderr
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Parse NDJSON output
    const rl = createInterface({ input: proc.stdout });
    let resultText = "";
    let costUsd = 0;
    let durationMs = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as StreamEvent;
        switch (event.type) {
          case "content_block_delta":
            if (event.delta?.type === "text_delta" && event.delta.text) {
              resultText += event.delta.text;
            }
            break;
          case "result": {
            const r = event as ResultEvent;
            costUsd = r.cost_usd ?? 0;
            durationMs = r.duration_ms ?? 0;
            if (r.result && !resultText) {
              resultText = r.result;
            }
            break;
          }
        }
      } catch {
        // skip unparseable lines
      }
    }

    // Wait for process exit
    const exitCode = await new Promise<number>((resolve) => {
      if (proc.exitCode !== null) return resolve(proc.exitCode);
      proc.on("close", (code) => resolve(code ?? 1));
    });

    this.processes.delete(id);

    if (exitCode !== 0 && !resultText) {
      resultText = `Sub-agent exited with code ${exitCode}: ${stderr.slice(0, 500)}`;
      this.registry.fail(id, resultText);
    } else {
      this.registry.complete(id, resultText, costUsd, durationMs);
    }

    // Deliver results
    const record = this.registry.get(id);
    if (record && this.deliveryHandler) {
      try {
        await this.deliveryHandler(record, resultText, costUsd, durationMs);
      } catch (e) {
        log.error({ id, err: e }, "failed to deliver sub-agent result");
      }
    }

    log.info({ id, status: record?.status, costUsd, durationMs }, "sub-agent finished");
  }
}
