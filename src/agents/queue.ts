import { watch, readdirSync, readFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config.js";
import type { AgentManager } from "./manager.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("spawn-queue");

interface SpawnRequest {
  task: string;
  model?: string;
  label?: string;
}

/**
 * Watches ~/.familiar/spawn-queue/ for JSON files written by the Claude process.
 * When a file appears, it spawns a sub-agent and deletes the file.
 */
export class SpawnQueue {
  private dir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private processing = new Set<string>();

  constructor(
    private manager: AgentManager,
    private defaultChatId: string,
  ) {
    this.dir = join(getConfigDir(), "spawn-queue");
    mkdirSync(this.dir, { recursive: true });
  }

  /** Get the queue directory path (for system prompt injection) */
  getDir(): string {
    return this.dir;
  }

  /** Start watching for spawn requests */
  start(): void {
    // Process any files already in the queue
    this.processExisting();

    // Watch for new files
    this.watcher = watch(this.dir, (event, filename) => {
      if (event === "rename" && filename && filename.endsWith(".json")) {
        // Small delay to ensure write is complete
        setTimeout(() => this.processFile(filename), 100);
      }
    });

    log.info({ dir: this.dir }, "spawn queue watching");
  }

  /** Stop watching */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private processExisting(): void {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        this.processFile(file);
      }
    } catch (e) {
      log.error({ err: e }, "failed to scan existing queue files");
    }
  }

  private async processFile(filename: string): Promise<void> {
    if (this.processing.has(filename)) return;
    this.processing.add(filename);

    const filepath = join(this.dir, filename);
    try {
      if (!existsSync(filepath)) return;

      const raw = readFileSync(filepath, "utf-8");
      const req = JSON.parse(raw) as SpawnRequest;

      if (!req.task || typeof req.task !== "string") {
        log.warn({ filename }, "invalid spawn request — missing task");
        unlinkSync(filepath);
        return;
      }

      // Delete the file first to avoid re-processing
      unlinkSync(filepath);

      log.info({ filename, task: req.task.slice(0, 100), model: req.model, label: req.label }, "processing spawn request");

      const result = await this.manager.spawn({
        task: req.task,
        model: req.model,
        label: req.label,
        chatId: this.defaultChatId,
      });

      if ("error" in result) {
        log.error({ filename, error: result.error }, "spawn request failed");
      } else {
        log.info({ filename, id: result.id }, "spawn request fulfilled");
      }
    } catch (e) {
      log.error({ err: e, filename }, "failed to process spawn request");
      // Try to clean up the file
      try { unlinkSync(filepath); } catch { /* ignore */ }
    } finally {
      this.processing.delete(filename);
    }
  }
}
