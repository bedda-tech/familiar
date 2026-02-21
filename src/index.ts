#!/usr/bin/env node

import { mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  loadConfig,
  getConfigDir,
  getConfigPath,
  configExists,
} from "./config.js";
import { initLogger, getLogger } from "./util/logger.js";
import { SessionStore } from "./session/store.js";
import { ClaudeCLI } from "./claude/cli.js";
import { TelegramChannel } from "./channels/telegram.js";
import { Bridge } from "./bridge.js";
import { CronScheduler } from "./cron/scheduler.js";
import type { CronJobConfig, CronRunResult } from "./cron/types.js";
import { migrateFromOpenClaw } from "./migrate-openclaw.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function printUsage(): void {
  console.log(`
familiar — Your AI Familiar

Usage:
  familiar start                Start the bot
  familiar tui                  Open interactive TUI (resumes Telegram session)
  familiar cron list            List configured cron jobs and their state
  familiar cron run <id>        Manually trigger a cron job
  familiar init                 Initialize config and workspace
  familiar migrate-from-openclaw  Migrate an existing OpenClaw assistant
  familiar install-service      Install systemd user service
  familiar help                 Show this help

Options:
  --config <path>   Path to config file (default: ~/.familiar/config.json)
  --daemon          Run in background (TODO)
`);
}

async function cmdInit(): Promise<void> {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });

  // Create example config if none exists
  if (!configExists()) {
    const exampleConfig = {
      telegram: {
        botToken: "YOUR_BOT_TOKEN_HERE",
        allowedUsers: [0],
      },
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

    writeFileSync(getConfigPath(), JSON.stringify(exampleConfig, null, 2) + "\n");
    console.log(`Created config at ${getConfigPath()}`);
    console.log("Edit it with your Telegram bot token and user ID.");
  } else {
    console.log(`Config already exists at ${getConfigPath()}`);
  }

  // Create workspace with templates
  const config = configExists() ? (() => {
    try { return loadConfig(); } catch { return null; }
  })() : null;

  const workspaceDir = config?.claude?.workingDirectory ?? join(homedir(), "familiar-workspace");
  mkdirSync(workspaceDir, { recursive: true });

  // Copy templates
  const templatesDir = join(__dirname, "..", "templates");
  const templateFiles = [
    "CLAUDE.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "AGENTS.md",
    "TOOLS.md",
    "BOOTSTRAP.md",
    "TODO.md",
    "MEMORY.md",
  ];

  for (const file of templateFiles) {
    const dest = join(workspaceDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) {
      cpSync(src, dest);
      console.log(`Created ${dest}`);
    }
  }

  // Create memory directory
  const memDir = join(workspaceDir, "memory");
  mkdirSync(memDir, { recursive: true });

  console.log(`\nWorkspace initialized at ${workspaceDir}`);
  console.log("\nNext steps:");
  console.log(`1. Edit ${getConfigPath()} with your bot token and Telegram user ID`);
  console.log("2. Run 'familiar start' to start the bot");
}

function cmdInstallService(): void {
  // Build PATH from current process — ensures claude CLI and node are reachable
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  const serviceContent = `[Unit]
Description=Familiar — AI Assistant Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${__filename} start
Restart=always
RestartSec=10
Environment=HOME=${homedir()}
Environment=NODE_ENV=production
Environment=PATH=${path}

[Install]
WantedBy=default.target
`;

  const serviceDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(serviceDir, { recursive: true });

  const servicePath = join(serviceDir, "familiar.service");
  writeFileSync(servicePath, serviceContent);

  console.log(`Service file written to ${servicePath}`);
  console.log("\nTo enable and start:");
  console.log("  systemctl --user daemon-reload");
  console.log("  systemctl --user enable familiar");
  console.log("  systemctl --user start familiar");
  console.log("\nTo check status:");
  console.log("  systemctl --user status familiar");
  console.log("  journalctl --user -u familiar -f");
}

function cmdTui(): void {
  const config = loadConfig();
  const chatId = String(config.telegram.allowedUsers[0]);

  const sessions = new SessionStore(
    config.sessions.inactivityTimeout,
    config.sessions.rotateAfterMessages,
  );

  const sessionId = sessions.getSession(chatId);
  sessions.close();

  const args: string[] = [];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  if (config.claude.model) {
    args.push("--model", config.claude.model);
  }

  if (sessionId) {
    console.log(`Resuming session ${sessionId.slice(0, 8)}…`);
  } else {
    console.log("No active session found — starting fresh.");
  }

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const result = spawnSync("claude", args, {
    cwd: config.claude.workingDirectory,
    stdio: "inherit",
    env,
  });

  process.exit(result.status ?? 1);
}

async function cmdCron(subArgs: string[]): Promise<void> {
  const config = loadConfig();
  const subcommand = subArgs[0];
  const jobs = (config.cron?.jobs ?? []) as CronJobConfig[];

  if (!subcommand || subcommand === "list") {
    if (jobs.length === 0) {
      console.log("No cron jobs configured. Add jobs to the 'cron.jobs' array in config.json.");
      return;
    }

    const scheduler = new CronScheduler(jobs, config.claude);
    const list = scheduler.listJobs();
    scheduler.stop();

    console.log(`\n  Cron Jobs (${list.length})\n`);
    for (const job of list) {
      const enabled = job.enabled !== false ? "ON" : "OFF";
      const model = job.model ?? config.claude.model ?? "default";
      console.log(`  ${enabled === "OFF" ? "  " : "* "}${job.id}`);
      console.log(`    Label:    ${job.label ?? "-"}`);
      console.log(`    Schedule: ${job.schedule} (${job.timezone ?? "UTC"})`);
      console.log(`    Model:    ${model}`);
      console.log(`    Runs:     ${job.runCount}`);
      console.log(`    Last run: ${job.lastRun ?? "never"}`);
      console.log(`    Next run: ${job.nextRun ?? "N/A"}`);
      console.log(`    Enabled:  ${enabled}`);
      console.log();
    }
    return;
  }

  if (subcommand === "run") {
    const jobId = subArgs[1];
    if (!jobId) {
      console.error("Usage: familiar cron run <job-id>");
      process.exit(1);
    }

    const jobConfig = jobs.find((j) => j.id === jobId);
    if (!jobConfig) {
      console.error(`Job not found: ${jobId}`);
      console.error(`Available jobs: ${jobs.map((j) => j.id).join(", ")}`);
      process.exit(1);
    }

    initLogger(config.log.level);
    console.log(`Running job: ${jobId}...`);
    const { runCronJob } = await import("./cron/runner.js");
    const result = await runCronJob(jobConfig, config.claude);
    console.log(`\nResult (${result.isError ? "ERROR" : "OK"}):`);
    console.log(`Duration: ${result.durationMs}ms`);
    console.log(`Cost: $${result.costUsd.toFixed(4)}`);
    console.log(`Turns: ${result.numTurns}`);
    console.log(`\n${result.text}`);
    return;
  }

  console.error(`Unknown cron subcommand: ${subcommand}`);
  console.log("Usage: familiar cron [list|run <id>]");
  process.exit(1);
}

async function cmdStart(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  initLogger(config.log.level);
  const log = getLogger("main");

  log.info("starting familiar");

  // Ensure working directory exists
  mkdirSync(config.claude.workingDirectory, { recursive: true });

  // Initialize components
  const sessions = new SessionStore(
    config.sessions.inactivityTimeout,
    config.sessions.rotateAfterMessages,
  );

  const claude = new ClaudeCLI(config.claude);
  const telegram = new TelegramChannel(config.telegram);
  const bridge = new Bridge(telegram, claude, sessions);

  // Wire up and start
  bridge.start();
  await telegram.start();

  // Start cron scheduler if jobs are configured
  let cron: CronScheduler | null = null;
  if (config.cron?.jobs && config.cron.jobs.length > 0) {
    const defaultChatId = String(config.telegram.allowedUsers[0]);
    cron = new CronScheduler(config.cron.jobs as CronJobConfig[], config.claude);

    cron.onDelivery(async (_jobId: string, result: CronRunResult, jobConfig: CronJobConfig) => {
      const chatId = jobConfig.deliverTo ?? defaultChatId;
      const label = jobConfig.label ?? jobConfig.id;
      const prefix = result.isError ? `*Cron Error — ${label}*` : `*Cron — ${label}*`;
      const meta = `_${result.durationMs}ms | $${result.costUsd.toFixed(4)} | ${result.numTurns} turns_`;
      const text = `${prefix}\n${meta}\n\n${result.text}`;
      await telegram.sendDirectMessage(chatId, text);
    });

    cron.start();
    log.info({ jobs: config.cron.jobs.length }, "cron scheduler started");
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    if (cron) cron.stop();
    await telegram.stop();
    sessions.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("familiar is running");
}

// CLI entry point
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "start":
  case undefined: {
    const configIdx = args.indexOf("--config");
    const configPath = configIdx >= 0 ? args[configIdx + 1] : undefined;
    cmdStart(configPath).catch((e) => {
      console.error("Fatal:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  }

  case "init":
    cmdInit().catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "tui":
    cmdTui();
    break;

  case "install-service":
    cmdInstallService();
    break;

  case "migrate-from-openclaw":
    migrateFromOpenClaw().catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "cron":
    cmdCron(args.slice(1)).catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "help":
  case "--help":
  case "-h":
    printUsage();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
