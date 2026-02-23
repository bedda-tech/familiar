/**
 * Watch config file for changes and reload on modification.
 *
 * Uses Node's fs.watch with debouncing to avoid rapid reloads
 * from editor save patterns (write → rename → write).
 */

import { watch, type FSWatcher } from "node:fs";
import { loadConfig, type FamiliarConfig } from "./config.js";
import { getLogger } from "./util/logger.js";

const log = getLogger("config-watcher");

export type ConfigChangeHandler = (newConfig: FamiliarConfig, oldConfig: FamiliarConfig) => void;

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private handler: ConfigChangeHandler | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentConfig: FamiliarConfig;

  constructor(
    private configPath: string,
    initialConfig: FamiliarConfig,
  ) {
    this.currentConfig = initialConfig;
  }

  /** Register handler called when config changes. */
  onChange(handler: ConfigChangeHandler): void {
    this.handler = handler;
  }

  /** Start watching the config file. */
  start(): void {
    if (this.watcher) return;

    try {
      this.watcher = watch(this.configPath, (_event) => {
        // Debounce — editors often trigger multiple events per save
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.reload(), 500);
      });

      this.watcher.on("error", (err) => {
        log.error({ err }, "config watcher error");
      });

      log.info({ path: this.configPath }, "watching config for changes");
    } catch (err) {
      log.error({ err }, "failed to start config watcher");
    }
  }

  /** Stop watching. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Get current config. */
  getConfig(): FamiliarConfig {
    return this.currentConfig;
  }

  private reload(): void {
    try {
      const newConfig = loadConfig(this.configPath);
      const oldConfig = this.currentConfig;
      this.currentConfig = newConfig;

      log.info("config reloaded");

      if (this.handler) {
        this.handler(newConfig, oldConfig);
      }
    } catch (err) {
      log.error({ err }, "failed to reload config — keeping current config");
    }
  }
}
