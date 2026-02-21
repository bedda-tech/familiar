import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TelegramConfig {
  botToken: string;
  allowedUsers: number[];
}

export interface ClaudeConfig {
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
  /** Model failover chain — tries each in order on failure. Default: ["opus", "sonnet", "haiku"] */
  failoverChain?: string[];
}

export interface SessionConfig {
  inactivityTimeout: string;
  rotateAfterMessages?: number;
}

export interface LogConfig {
  level: string;
}

export interface CronJobEntry {
  id: string;
  label?: string;
  schedule: string;
  timezone?: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  workingDirectory?: string;
  deliverTo?: string;
  announce?: boolean;
  /** Regex pattern — if the result text matches, suppress delivery (useful for HEARTBEAT_OK) */
  suppressPattern?: string;
  enabled?: boolean;
}

export interface CronConfig {
  jobs: CronJobEntry[];
}

export interface OpenAIConfig {
  apiKey: string;
  whisperModel?: string; // default: "whisper-1"
}

export interface WebhookServerConfig {
  /** Port to listen on */
  port: number;
  /** Bind address (default: "127.0.0.1") */
  bind?: string;
  /** Bearer token for authentication */
  token: string;
}

export interface FamiliarConfig {
  telegram: TelegramConfig;
  claude: ClaudeConfig;
  sessions: SessionConfig;
  cron?: CronConfig;
  webhooks?: WebhookServerConfig;
  openai?: OpenAIConfig;
  log: LogConfig;
}

const CONFIG_DIR = join(homedir(), ".familiar");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULTS: Partial<FamiliarConfig> = {
  claude: {
    workingDirectory: join(homedir(), "familiar-workspace"),
    model: "sonnet",
    systemPrompt:
      "You are a helpful personal assistant communicating via Telegram. Keep responses concise and well-formatted for mobile reading.",
    allowedTools: [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
    ],
    maxTurns: 25,
  },
  sessions: {
    inactivityTimeout: "24h",
    rotateAfterMessages: 200,
  },
  log: {
    level: "info",
  },
};

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}

export function loadConfig(path?: string): FamiliarConfig {
  const configPath = path ?? CONFIG_PATH;

  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found at ${configPath}\nRun 'familiar init' to create one.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e) {
    throw new Error(
      `Failed to parse config at ${configPath}: ${e instanceof Error ? e.message : e}`,
    );
  }

  const config = raw as Record<string, unknown>;

  // Validate required fields
  if (!config.telegram || typeof config.telegram !== "object") {
    throw new Error("Config missing required 'telegram' section");
  }
  const tg = config.telegram as Record<string, unknown>;
  if (!tg.botToken || typeof tg.botToken !== "string") {
    throw new Error("Config missing required 'telegram.botToken'");
  }
  if (!Array.isArray(tg.allowedUsers) || tg.allowedUsers.length === 0) {
    throw new Error(
      "Config missing required 'telegram.allowedUsers' (array of Telegram user IDs)",
    );
  }

  // Merge with defaults
  const merged = deepMerge(DEFAULTS as Record<string, unknown>, config) as unknown as FamiliarConfig;

  return merged;
}

/** Parse duration string like "24h", "30m", "7d" to milliseconds */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `Invalid duration: ${duration}. Use format like "24h", "30m", "7d"`,
    );
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * multipliers[unit];
}
