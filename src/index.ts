#!/usr/bin/env node

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { loadConfig, getConfigDir, getConfigPath, configExists } from "./config.js";
import { initLogger, getLogger } from "./util/logger.js";
import { SessionStore } from "./session/store.js";
import { ClaudeCLI } from "./claude/cli.js";
import { TelegramChannel } from "./channels/telegram.js";
import { Bridge } from "./bridge.js";
import { CronScheduler } from "./cron/scheduler.js";
import type { CronJobConfig, CronRunResult } from "./cron/types.js";
import { WebhookServer } from "./webhooks/server.js";
import { ConfigWatcher } from "./config-watcher.js";
import { DeliveryQueue } from "./delivery/queue.js";
import { AgentRegistry } from "./agents/registry.js";
import { AgentManager } from "./agents/manager.js";
import { AgentStore } from "./agents/store.js";
import { SpawnQueue } from "./agents/queue.js";
import { migrateFromOpenClaw } from "./migrate-openclaw.js";
import { runConfigure } from "./configure.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function printUsage(): void {
  console.log(`
familiar — Your AI Familiar

Usage:
  familiar start                Start the bot (foreground)
  familiar start --daemon       Start the bot in background (writes PID to ~/.familiar/familiar.pid)
  familiar stop                 Stop a daemonized instance (reads PID file, sends SIGTERM)
  familiar tui                  Open interactive TUI (resumes Telegram session)
  familiar cron list            List configured cron jobs and their state
  familiar cron run <id>        Manually trigger a cron job
  familiar recall <query>       Search memories semantically
  familiar index-memory         Re-index memory files for search
  familiar doctor               Run system diagnostics
  familiar configure             Interactive configuration wizard
  familiar init                 Initialize config and workspace
  familiar migrate-from-openclaw  Migrate an existing OpenClaw assistant
  familiar install-service      Install systemd user service
  familiar help                 Show this help

Options:
  --config <path>   Path to config file (default: ~/.familiar/config.json)
  --daemon          Run in background (fork and write PID file)
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
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
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
  const config = configExists()
    ? (() => {
        try {
          return loadConfig();
        } catch {
          return null;
        }
      })()
    : null;

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
  args.push("--dangerously-skip-permissions");
  args.push("--chrome");

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

  // Initialize delivery queue — wraps sendDirectMessage with retry + persistence
  const deliveryQueue = new DeliveryQueue(sessions.getDb());
  deliveryQueue.onSend((chatId, text) => telegram.sendDirectMessage(chatId, text));
  deliveryQueue.start();

  // Initialize sub-agent system
  const agentRegistry = new AgentRegistry(sessions.getDb());
  const agentManager = new AgentManager(agentRegistry, config.claude);

  // Deliver sub-agent results via the delivery queue (retry-safe)
  agentManager.onDelivery(async (agent, resultText, costUsd, durationMs) => {
    const label = agent.label ?? agent.id;
    const status = agent.status === "completed" ? "done" : agent.status;
    const meta = `_${(durationMs / 1000).toFixed(1)}s | $${costUsd.toFixed(4)}_`;
    const preview = resultText.length > 3000 ? resultText.slice(0, 3000) + "..." : resultText;
    const text = `*Sub-agent ${status} — ${label}*\n${meta}\n\n${preview}`;
    await deliveryQueue.deliver(agent.chatId, text);
  });

  // Start spawn queue — watches ~/.familiar/spawn-queue/ for agent requests from Claude
  const defaultChatId = String(config.telegram.allowedUsers[0]);
  const spawnQueue = new SpawnQueue(agentManager, defaultChatId);
  spawnQueue.start();

  // Initialize semantic memory store if OpenAI is configured
  let memoryStore: import("./memory/store.js").MemoryStore | undefined;
  if (config.openai) {
    try {
      const { MemoryStore } = await import("./memory/store.js");
      memoryStore = new MemoryStore(
        sessions.getDb(),
        config.openai,
        config.claude.workingDirectory,
      );
      log.info("memory store initialized for /search");
    } catch (e) {
      log.warn(
        { err: e },
        "failed to initialize memory store — /search will only search message history",
      );
    }
  }

  // Start cron scheduler if jobs are configured
  let cron: CronScheduler | null = null;
  if (config.cron?.jobs && config.cron.jobs.length > 0) {
    cron = new CronScheduler(config.cron.jobs as CronJobConfig[], config.claude);

    cron.onDelivery(async (_jobId: string, result: CronRunResult, jobConfig: CronJobConfig) => {
      const chatId = jobConfig.deliverTo ?? defaultChatId;
      const label = jobConfig.label ?? jobConfig.id;
      const prefix = result.isError ? `*Cron Error — ${label}*` : `*Cron — ${label}*`;
      const meta = `_${result.durationMs}ms | $${result.costUsd.toFixed(4)} | ${result.numTurns} turns_`;
      const text = `${prefix}\n${meta}\n\n${result.text}`;
      await deliveryQueue.deliver(chatId, text);
    });

    cron.start();
    log.info({ jobs: config.cron.jobs.length }, "cron scheduler started");
  }

  const bridge = new Bridge(
    telegram,
    claude,
    sessions,
    config.openai,
    agentManager,
    config.sessions,
    memoryStore,
    deliveryQueue,
    cron ?? undefined,
  );

  // Wire up and start
  bridge.start();
  await telegram.start();

  // Start webhook server if configured
  let webhooks: WebhookServer | null = null;
  if (config.webhooks?.token) {
    webhooks = new WebhookServer(config.webhooks, config.claude);

    // Wire up cron scheduler for REST API
    if (cron) {
      webhooks.setCronScheduler(cron);
    }

    // Wire up agent store for REST API
    webhooks.setAgentStore(new AgentStore(agentManager));

    // Wake handler — inject message into a chat (defaults to first allowed user)
    webhooks.onWake(async (chatId, message) => {
      const targetChat = chatId || String(config.telegram.allowedUsers[0]);
      await deliveryQueue.deliver(targetChat, message);
    });

    await webhooks.start();
    log.info({ port: config.webhooks.port }, "webhook server started");
  }

  // Watch config for hot-reload
  const resolvedConfigPath = configPath ?? getConfigPath();
  const configWatcher = new ConfigWatcher(resolvedConfigPath, config);
  configWatcher.onChange((newConfig, oldConfig) => {
    // Hot-reload model changes
    if (newConfig.claude.model !== oldConfig.claude.model) {
      claude.setModel(null); // Clear override, pick up new default
      log.info({ model: newConfig.claude.model }, "model updated from config");
    }

    // Hot-reload log level
    if (newConfig.log.level !== oldConfig.log.level) {
      initLogger(newConfig.log.level);
      log.info({ level: newConfig.log.level }, "log level updated from config");
    }

    // Notify about changes that require restart
    const needsRestart: string[] = [];
    if (newConfig.telegram.botToken !== oldConfig.telegram.botToken) {
      needsRestart.push("telegram.botToken");
    }
    if (JSON.stringify(newConfig.cron) !== JSON.stringify(oldConfig.cron)) {
      needsRestart.push("cron");
    }
    if (JSON.stringify(newConfig.webhooks) !== JSON.stringify(oldConfig.webhooks)) {
      needsRestart.push("webhooks");
    }
    if (needsRestart.length > 0) {
      log.warn({ fields: needsRestart }, "config changed — restart needed for these fields");
    }
  });
  configWatcher.start();

  // Graceful shutdown
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      log.warn({ signal }, "forced exit (second signal)");
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, "shutting down gracefully");

    // Force exit after 10 seconds
    const forceTimer = setTimeout(() => {
      log.error("shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000);
    forceTimer.unref(); // Don't keep process alive for the timer

    try {
      configWatcher.stop();
      deliveryQueue.stop();
      spawnQueue.stop();
      agentManager.killAll();
      if (webhooks) webhooks.stop();
      if (cron) cron.stop();
      await telegram.stop();
    } catch (e) {
      log.error({ err: e }, "error during shutdown");
    } finally {
      sessions.close();
      const pidFile = join(getConfigDir(), "familiar.pid");
      try {
        unlinkSync(pidFile);
      } catch {}
      process.exit(0);
    }
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

    if (args.includes("--daemon")) {
      const pidFile = join(getConfigDir(), "familiar.pid");

      // Check if already running
      if (existsSync(pidFile)) {
        const existingPid = parseInt(readFileSync(pidFile, "utf-8").trim());
        try {
          process.kill(existingPid, 0); // Check if process exists
          console.error(
            `Familiar is already running (PID ${existingPid}). Use 'familiar stop' first.`,
          );
          process.exit(1);
        } catch {
          // Process doesn't exist, stale PID file — continue
        }
      }

      const childArgs = [
        fileURLToPath(import.meta.url),
        "start",
        ...args.filter((a) => a !== "--daemon"),
      ];
      const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      writeFileSync(pidFile, String(child.pid));
      console.log(`Familiar started in background (PID ${child.pid})`);
      console.log(`Logs: journalctl --user -u familiar -f  OR  check ~/.familiar/`);
      console.log(`Stop: familiar stop`);
      process.exit(0);
    }

    cmdStart(configPath).catch((e) => {
      console.error("Fatal:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  }

  case "configure":
    runConfigure().catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

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

  case "stop": {
    const pidFile = join(getConfigDir(), "familiar.pid");
    if (!existsSync(pidFile)) {
      console.error("No PID file found — familiar may not be running as daemon.");
      console.error("If using systemd: systemctl --user stop familiar");
      process.exit(1);
    }
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
    try {
      process.kill(pid, "SIGTERM");
      unlinkSync(pidFile);
      console.log(`Sent SIGTERM to PID ${pid}`);
    } catch {
      unlinkSync(pidFile);
      console.log(`Process ${pid} not found (removed stale PID file)`);
    }
    break;
  }

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

  case "recall":
    (async () => {
      const query = args.slice(1).join(" ");
      if (!query) {
        console.error("Usage: familiar recall <query>");
        process.exit(1);
      }
      const config = loadConfig();
      if (!config.openai?.apiKey) {
        console.error("OpenAI API key required for memory search. Set openai.apiKey in config.");
        process.exit(1);
      }
      const { SessionStore } = await import("./session/store.js");
      const { MemoryStore } = await import("./memory/store.js");
      const sessions = new SessionStore(
        config.sessions.inactivityTimeout,
        config.sessions.rotateAfterMessages,
      );
      const memory = new MemoryStore(
        sessions.getDb(),
        config.openai,
        config.claude.workingDirectory,
      );
      const results = await memory.search(query);
      if (results.length === 0) {
        console.log("No results found.");
      } else {
        for (const r of results) {
          console.log(
            `\n--- ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)}) ---`,
          );
          console.log(r.text.slice(0, 500));
        }
      }
      sessions.close();
    })().catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "index-memory":
    (async () => {
      const config = loadConfig();
      if (!config.openai?.apiKey) {
        console.error("OpenAI API key required for memory indexing. Set openai.apiKey in config.");
        process.exit(1);
      }
      const { SessionStore } = await import("./session/store.js");
      const { MemoryStore } = await import("./memory/store.js");
      const sessions = new SessionStore(
        config.sessions.inactivityTimeout,
        config.sessions.rotateAfterMessages,
      );
      const memory = new MemoryStore(
        sessions.getDb(),
        config.openai,
        config.claude.workingDirectory,
      );
      console.log("Indexing memory files...");
      const result = await memory.indexAll();
      console.log(`Done: ${result.indexed} indexed, ${result.skipped} unchanged.`);
      const stats = memory.stats();
      console.log(`Total: ${stats.chunks} chunks across ${stats.files} files.`);
      sessions.close();
    })().catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "doctor":
    (async () => {
      const { runDoctor } = await import("./doctor.js");
      runDoctor();
    })().catch((e) => {
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
