#!/usr/bin/env node

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, cpSync, symlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
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
import { AgentCrudStore } from "./agents/agent-store.js";
import { SpawnQueue } from "./agents/queue.js";
import { ProcessTracker } from "./claude/process-tracker.js";
import { TaskStore } from "./tasks/store.js";
import { ScheduleStore } from "./schedules/store.js";
import { ProjectStore } from "./projects/store.js";
import { ToolStore } from "./tools/store.js";
import { ToolAccountStore } from "./tools/account-store.js";
import { TemplateStore } from "./templates/store.js";
import { AgentTemplateStore } from "./templates/agent-store.js";
import { runMigration } from "./migrations/001-entity-separation.js";
import { migrateFromOpenClaw } from "./migrate-openclaw.js";
import { runConfigure } from "./configure.js";
import { WsServer } from "./ws/server.js";
import { DashboardChannel } from "./channels/dashboard.js";
import { MessageBus } from "./bus.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Extract tool result snippets from a structured runLog to supplement thin assistant text */
function extractToolSnippets(runLog: string, maxLen = 1500): string {
  const snippets: string[] = [];
  let used = 0;
  for (const line of runLog.split("\n")) {
    try {
      const ev = JSON.parse(line);
      // Tool results come inside "user" events as content blocks with type "tool_result"
      if (ev.type === "user" && ev.message?.content) {
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        for (const block of blocks) {
          if (block.type === "tool_result" && block.content) {
            const text = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b: { text?: string }) => b.text ?? "").join("")
                : "";
            if (text.length > 10) {
              const snippet = text.slice(0, 300);
              if (used + snippet.length > maxLen) break;
              snippets.push(snippet);
              used += snippet.length;
            }
          }
        }
      }
    } catch { /* skip non-JSON lines */ }
  }
  return snippets.join("\n---\n");
}

/** Use haiku via claude -p to generate a one-line agent run summary */
async function summarizeAgentRun(agentLabel: string, resultText: string, runLog?: string): Promise<string> {
  // If assistant text is mostly filler ("Let me check...", "I'll run..."),
  // supplement with actual tool result snippets from the run log
  let content = resultText;
  const fillerPattern = /\b(Let me|I'll|Now let me|Looking at|Checking|Let me check|I need to|Now I|First,? let|Running|Searching|Querying|Examining|Analyzing|Investigating|Reading|Fetching|Scanning)[^.:!]*[.:!]/gi;
  const stripped = resultText.replace(fillerPattern, "").replace(/\s+/g, " ").trim();
  const fillerRatio = stripped.length / Math.max(resultText.length, 1);
  // If more than 60% of the text is filler, or stripped is short, pull from tool results
  if ((fillerRatio < 0.4 || stripped.length < 100) && runLog) {
    const snippets = extractToolSnippets(runLog);
    if (snippets) {
      content = `${resultText}\n\n[Tool outputs]\n${snippets}`;
    }
  }
  const truncated = content.length > 3000 ? content.slice(0, 3000) : content;
  const sysPrompt = "You summarize agent run outputs. Output ONLY a single sentence. NEVER ask for more information. NEVER say you don't see output. Work with whatever text is provided.";
  const prompt = `Summarize what the "${agentLabel}" agent did in ONE sentence (under 120 chars). If the text is sparse, infer from tool outputs and context. No quotes, no filler, no questions.\n\n${truncated}`;
  return new Promise<string>((resolve, reject) => {
    let resolved = false;
    const proc = spawn("claude", [
      "-p", "--model", "haiku", "--max-turns", "1",
      "--system-prompt", sysPrompt,
      "--setting-sources", "user",
      "--allowedTools", "",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/tmp",
    });
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on("error", (e) => { if (!resolved) { resolved = true; reject(e); } });
    proc.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      if (code !== 0) { reject(new Error(`claude exited ${code}`)); return; }
      const line = stdout.trim().split("\n")[0]?.trim() ?? "";
      resolve(line.length > 200 ? line.slice(0, 197) + "..." : line);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
    setTimeout(() => {
      if (!resolved) { resolved = true; try { proc.kill(); } catch {} reject(new Error("summary timeout")); }
    }, 30_000);
  });
}

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
  familiar restart              Restart the systemd user service
  familiar doctor               Run system diagnostics
  familiar configure             Interactive configuration wizard
  familiar init                 Initialize config and workspace
  familiar migrate-from-openclaw  Migrate an existing OpenClaw assistant
  familiar export [--persona <path>]  Export DB state to persona repo YAML files
  familiar sync [--from <path>]      Import persona repo YAML files into DB
  familiar manifest [--persona <path>]  Generate SYSTEM.md from DB state
  familiar backup [--output <dir>] [--jobs-db <path>]  Dump DB(s) to .sql files for git backup
  familiar restore [--from <dir>] [--jobs-db <path>] [--dry-run]  Restore DB(s) from .sql files
  familiar install-service      Install systemd user service
  familiar help                 Show this help

Options:
  --config <path>   Path to config file (default: ~/.familiar/config.json)
  --daemon          Run in background (fork and write PID file)
`);
}

async function cmdInit(): Promise<void> {
  const { createInterface } = await import("node:readline");
  const { randomBytes } = await import("node:crypto");

  console.log("\n╭──────────────────────────────────────────────╮");
  console.log("│   Welcome to Familiar — AI Agent Platform    │");
  console.log("╰──────────────────────────────────────────────╯\n");
  console.log("This wizard sets up your familiar workspace.\n");
  console.log("Press Enter to accept defaults shown in [brackets].\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string, defaultVal = ""): Promise<string> =>
    new Promise((resolve) => {
      const hint = defaultVal ? ` [${defaultVal}]` : "";
      rl.question(`${prompt}${hint}: `, (ans) => resolve(ans.trim() || defaultVal));
    });

  // ── Step 1: Workspace path ─────────────────────────────────
  const defaultWorkspace = join(homedir(), "familiar-workspace");
  const workspaceInput = await ask("Workspace directory", defaultWorkspace);
  const workspaceDir = workspaceInput.startsWith("~/")
    ? join(homedir(), workspaceInput.slice(2))
    : workspaceInput;

  // ── Step 2: Owner ──────────────────────────────────────────
  console.log("");
  const ownerName = await ask("Your username (for task assignment)", "owner");
  const displayName = await ask("Your display name (optional)", "");

  // ── Step 3: Familiar name ──────────────────────────────────
  console.log("");
  const familiarName = await ask("Name your familiar", "Familiar");

  // ── Step 4: Telegram ───────────────────────────────────────
  console.log("\n── Telegram ─────────────────────────────────────");
  console.log("  Create a bot at https://t.me/BotFather to get a token.");
  console.log("  Find your user ID at https://t.me/userinfobot\n");
  const botToken = await ask("Bot token", "YOUR_BOT_TOKEN_HERE");
  const userIdInput = await ask("Your Telegram user ID(s) (comma-separated)", "0");
  const allowedUsers = userIdInput
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));

  // ── Step 5: Dashboard ─────────────────────────────────────
  console.log("\n── Dashboard ────────────────────────────────────");
  const portInput = await ask("Dashboard port", "3002");
  const port = parseInt(portInput, 10) || 3002;
  const token = randomBytes(32).toString("hex");
  const publicUrl = await ask(
    "Public URL (e.g. https://myserver.com:3002, press Enter to skip)",
    "",
  );

  // ── Step 6: OpenAI (optional) ─────────────────────────────
  console.log("\n── OpenAI (optional, for voice + embeddings) ───");
  const openaiKey = await ask("OpenAI API key (press Enter to skip)", "");

  rl.close();

  // ── Create workspace structure ────────────────────────────
  console.log("\n── Creating workspace ───────────────────────────");

  const configDir = join(workspaceDir, ".familiar");
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(join(workspaceDir, "identity"), { recursive: true });
  mkdirSync(join(workspaceDir, "claude-memory"), { recursive: true });

  // ── Memory category subdirectories ───────────────────────
  const memoryCategories: Record<string, string> = {
    profile: "Agent's own identity, role, and self-description.",
    preferences: "User's stated preferences per facet: communication style, tool choices, formatting.",
    entities: "People, projects, and organizations. One file per entity with facts and status.",
    events: "Time-bound events: daily notes, incidents, meetings. Named YYYY-MM-DD[-topic].md.",
    cases: "Problem + solution pairs. Documents challenges encountered and how they were resolved.",
    patterns: "Reusable processes, runbooks, and strategies. Step-by-step workflows.",
    tools: "Tool usage documentation, CLIs, integrations, and stats. One file per tool.",
    skills: "Workflow optimization knowledge, research findings, and learned capabilities.",
  };
  for (const [cat, desc] of Object.entries(memoryCategories)) {
    const catDir = join(workspaceDir, "memory", cat);
    mkdirSync(catDir, { recursive: true });
    const readmePath = join(catDir, "README.md");
    if (!existsSync(readmePath)) {
      writeFileSync(readmePath, `# ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n${desc}\n`);
    }
  }
  console.log(`  Created ${workspaceDir}/`);

  // ── Symlink ~/.familiar -> workspace/.familiar ─────────────
  const symlinkTarget = join(homedir(), ".familiar");
  if (!existsSync(symlinkTarget)) {
    try {
      symlinkSync(configDir, symlinkTarget);
      console.log(`  Symlink: ~/.familiar -> ${configDir}`);
    } catch (e: any) {
      console.log(`  Warning: Could not create ~/.familiar symlink: ${e.message}`);
    }
  } else {
    let kind = "exists";
    try {
      kind = lstatSync(symlinkTarget).isSymbolicLink() ? "symlink" : "directory";
    } catch { /* ignore */ }
    console.log(`  ~/.familiar already exists (${kind}) — skipping symlink`);
  }

  // ── Write config.json ─────────────────────────────────────
  const configPath = join(configDir, "config.json");
  if (!existsSync(configPath)) {
    const cfg: Record<string, unknown> = {
      name: familiarName,
      owner: {
        name: ownerName,
        ...(displayName ? { displayName } : {}),
      },
      telegram: { botToken, allowedUsers },
      claude: {
        workingDirectory: workspaceDir,
        model: "sonnet",
        systemPrompt: `You are ${familiarName}, an AI familiar — a persistent personal assistant communicating through a messaging platform. Keep responses concise and well-formatted for mobile reading.`,
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
        maxTurns: 25,
      },
      sessions: { inactivityTimeout: "24h", rotateAfterMessages: 200 },
      webhooks: {
        port,
        token,
        ...(publicUrl ? { publicUrl } : {}),
      },
      ...(openaiKey ? { openai: { apiKey: openaiKey } } : {}),
      log: { level: "info" },
    };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`  Config: ${configPath}`);
  } else {
    console.log(`  Config already exists at ${configPath}`);
  }

  // ── Copy templates ────────────────────────────────────────
  const templatesDir = join(__dirname, "..", "templates");

  // Identity files go in identity/
  const identityFiles = ["SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md"];
  for (const file of identityFiles) {
    const dest = join(workspaceDir, "identity", file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) {
      cpSync(src, dest);
      console.log(`  Created identity/${file}`);
    }
  }

  // IDENTITY.md with name pre-filled
  const identityMdPath = join(workspaceDir, "identity", "IDENTITY.md");
  if (!existsSync(identityMdPath)) {
    writeFileSync(
      identityMdPath,
      `# Identity\n\n**Name**: ${familiarName}\n**Nature**: AI familiar — persistent personal assistant\n**Emoji**: ✨\n`,
    );
    console.log(`  Created identity/IDENTITY.md (name: ${familiarName})`);
  }

  // CLAUDE.md with identity/ paths
  const claudeMdPath = join(workspaceDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    writeFileSync(
      claudeMdPath,
      `# Familiar Workspace\n\nYou are ${familiarName} — an AI familiar and persistent personal assistant communicating through a messaging platform.\n\n## Session Startup\n\nRead these files in order:\n1. identity/SOUL.md — who you are\n2. identity/IDENTITY.md — your name and nature\n3. identity/USER.md — who you're helping\n4. identity/AGENTS.md — behavioral rules\n5. identity/TOOLS.md — available tools\n\nCheck \`memory/events/\` for recent daily notes (YYYY-MM-DD.md).\n\nIf BOOTSTRAP.md exists, follow it — it's your first-run onboarding.\n\n## Memory System\n\nOperational memory lives in \`memory/\` organized into 8 categories:\n\n| Category | Purpose |\n|----------|----------|\n| \`profile/\` | Agent identity, role, self-description |\n| \`preferences/\` | User preferences per facet |\n| \`entities/\` | People, projects, organizations |\n| \`events/\` | Daily notes, incidents (YYYY-MM-DD.md) |\n| \`cases/\` | Problem + solution pairs |\n| \`patterns/\` | Runbooks, processes, strategies |\n| \`tools/\` | Tool docs, CLI guides |\n| \`skills/\` | Research findings, workflow optimization |\n\nWrite new memory to the appropriate category subdir. Daily notes go in \`memory/events/YYYY-MM-DD.md\`.\nSearch memory: \`curl -s "http://localhost:3002/api/memory/search?q=<query>"\`\n`,
    );
    console.log(`  Created CLAUDE.md`);
  }

  // Other workspace-root files
  for (const file of ["MEMORY.md", "BOOTSTRAP.md"]) {
    const dest = join(workspaceDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) {
      cpSync(src, dest);
      console.log(`  Created ${file}`);
    }
  }

  // ── Deploy starter agents ─────────────────────────────────
  await deployStarterTemplates(configDir, createInterface);

  // ── Systemd service ───────────────────────────────────────
  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const ask2 = (prompt: string, defaultVal = ""): Promise<string> =>
    new Promise((resolve) => {
      const hint = defaultVal ? ` [${defaultVal}]` : "";
      rl2.question(`${prompt}${hint}: `, (ans) => resolve(ans.trim() || defaultVal));
    });

  console.log("\n── System service ───────────────────────────────");
  const doService = await ask2("Install systemd user service? (y/n)", "n");
  rl2.close();

  if (doService.toLowerCase().startsWith("y")) {
    cmdInstallService();
    console.log("\n  To enable and start:");
    console.log("    systemctl --user daemon-reload");
    console.log("    systemctl --user enable familiar");
    console.log("    systemctl --user start familiar");
  }

  // ── Summary ───────────────────────────────────────────────
  const dashUrl = publicUrl || `http://localhost:${port}`;
  console.log("\n╭──────────────────────────────────────────────╮");
  console.log("│   Setup complete!                            │");
  console.log("╰──────────────────────────────────────────────╯");
  console.log(`\n  Workspace:  ${workspaceDir}`);
  console.log(`  Config:     ${configPath}`);
  console.log(`  Dashboard:  ${dashUrl}`);
  if (botToken === "YOUR_BOT_TOKEN_HERE") {
    console.log("\n  Next: edit config.json with your real Telegram bot token and user ID.");
  }
  console.log("\n  1. Run 'familiar start' to start");
  console.log(`  2. Open the dashboard: ${dashUrl}`);
  console.log("  3. Enable your agents from the Agents tab");
  console.log("  4. Message your bot to begin your first conversation\n");
}

async function deployStarterTemplates(
  configDir: string,
  createInterface: typeof import("node:readline").createInterface,
): Promise<void> {
  // Open (or create) the DB so we can seed and deploy templates
  const dbPath = join(configDir, "familiar.db");
  const db = new Database(dbPath);

  const agentTemplateStore = new AgentTemplateStore(db);
  const agentStore = new AgentCrudStore(db);
  const scheduleStore = new ScheduleStore(db);

  // Seed built-in templates from JSON files
  agentTemplateStore.seed(join(__dirname, "..", "templates"));

  const templates = agentTemplateStore.list();
  if (templates.length === 0) {
    db.close();
    return;
  }

  console.log("\nStarter agent templates available:");
  templates.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.name} (${t.model}, ${t.suggested_schedule ?? "no schedule"}) — ${t.description ?? ""}`);
  });
  console.log("  0. Skip (deploy templates later from the dashboard)");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  const answer = await question("\nWhich templates to deploy? (e.g. 1,3 or 'all' or 0 to skip): ");
  rl.close();

  const input = answer.trim().toLowerCase();
  if (!input || input === "0" || input === "skip") {
    console.log("Skipped. Deploy templates anytime from the dashboard (Templates tab).");
    db.close();
    return;
  }

  let selected: typeof templates;
  if (input === "all") {
    selected = templates;
  } else {
    const indices = input
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10) - 1)
      .filter((i) => i >= 0 && i < templates.length);
    selected = indices.map((i) => templates[i]).filter(Boolean);
  }

  for (const t of selected) {
    try {
      agentTemplateStore.deploy(t.id, agentStore, scheduleStore);
      console.log(`  Deployed: ${t.name} (agent + schedule created, enabled=false)`);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE constraint")) {
        console.log(`  Skipped: ${t.name} (already exists)`);
      } else {
        console.log(`  Failed: ${t.name} — ${e.message}`);
      }
    }
  }

  if (selected.length > 0) {
    console.log("\nAgents created with enabled=false. Enable them from the dashboard when ready.");
  }

  db.close();
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

function cmdTui(subArgs: string[] = []): void {
  const config = loadConfig();
  const chatId = String(config.telegram.allowedUsers[0]);

  const sessions = new SessionStore(
    config.sessions.inactivityTimeout,
    config.sessions.rotateAfterMessages,
  );

  // Accept explicit session ID: familiar tui <sessionId>
  const explicitSessionId = subArgs[0] || null;
  const sessionId = explicitSessionId ?? sessions.getSession(chatId);

  // If explicit session ID provided, update the session store so Telegram follows along
  if (explicitSessionId) {
    sessions.upsertSession(chatId, explicitSessionId);
    console.log(`Switching to session ${explicitSessionId.slice(0, 8)}… (Telegram will follow)`);
  }

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

  if (sessionId && !explicitSessionId) {
    console.log(`Resuming session ${sessionId.slice(0, 8)}…`);
  } else if (!sessionId) {
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

  /** Open familiar.db read-only. Returns null if the DB doesn't exist. */
  function openDb(): Database.Database | null {
    const dbPath = join(getConfigDir(), "familiar.db");
    if (!existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    db.pragma("journal_mode = WAL");
    return db;
  }

  /** Build a CronJobConfig from a joined schedules+agents DB row. */
  function rowToJobConfig(row: Record<string, unknown>): CronJobConfig {
    let allowedTools: string[] | undefined;
    const toolsStr = row.agent_tools as string | null;
    if (toolsStr) {
      try { allowedTools = JSON.parse(toolsStr) as string[]; } catch { /* ignore */ }
    }
    return {
      id: row.agent_id as string,
      label: (row.agent_name as string) || (row.schedule_name as string) || (row.agent_id as string),
      schedule: row.schedule as string,
      timezone: (row.timezone as string) ?? "UTC",
      prompt: row.prompt as string,
      model: (row.model as string) ?? undefined,
      maxTurns: (row.max_turns as number) ?? 25,
      workingDirectory: (row.working_directory as string) ?? undefined,
      announce: (row.announce as number) === 1,
      suppressPattern: (row.suppress_pattern as string) ?? undefined,
      deliverTo: (row.deliver_to as string) ?? undefined,
      enabled: (row.agent_enabled as number) === 1 && (row.schedule_enabled as number) === 1,
      systemPrompt: (row.system_prompt as string) ?? undefined,
      worktreeIsolation: (row.worktree_isolation as number) === 1,
      preHook: (row.pre_hook as string) ?? undefined,
      postHook: (row.post_hook as string) ?? undefined,
      allowedTools,
      mcpConfig: (row.mcp_config as string) ?? undefined,
    };
  }

  if (!subcommand || subcommand === "list") {
    // Config-based jobs
    if (jobs.length > 0) {
      const scheduler = new CronScheduler(jobs, config.claude, undefined, config.webhooks?.token, config.webhooks?.port);
      const list = scheduler.listJobs();
      scheduler.stop();

      console.log(`\n  Config Cron Jobs (${list.length})\n`);
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
    }

    // DB-backed jobs
    const db = openDb();
    if (db) {
      try {
        const rows = db
          .prepare(
            `SELECT s.id as schedule_id, s.agent_id, s.name as schedule_name,
                    s.schedule, s.timezone, s.enabled as schedule_enabled,
                    a.name as agent_name, a.model, a.max_turns,
                    a.working_directory, a.enabled as agent_enabled
             FROM schedules s
             JOIN agents a ON s.agent_id = a.id
             ORDER BY a.name ASC`,
          )
          .all() as Array<Record<string, unknown>>;

        if (rows.length > 0) {
          console.log(`\n  DB Cron Jobs (${rows.length})\n`);
          for (const row of rows) {
            const enabled =
              (row.agent_enabled as number) === 1 && (row.schedule_enabled as number) === 1;
            const agentId = row.agent_id as string;
            const scheduleId = row.schedule_id as string;
            console.log(`  ${enabled ? "* " : "  "}${agentId}  (schedule: ${scheduleId})`);
            console.log(`    Label:    ${(row.agent_name as string) ?? "-"}`);
            console.log(`    Schedule: ${row.schedule} (${(row.timezone as string) ?? "UTC"})`);
            console.log(`    Model:    ${(row.model as string) ?? config.claude.model ?? "default"}`);
            console.log(`    MaxTurns: ${(row.max_turns as number) ?? 25}`);
            console.log(`    WorkDir:  ${(row.working_directory as string) ?? config.claude.workingDirectory}`);
            console.log(`    Enabled:  ${enabled ? "ON" : "OFF"}`);
            console.log();
          }
        }
      } finally {
        db.close();
      }
    }

    if (jobs.length === 0 && !openDb()) {
      console.log("No cron jobs configured.");
    }
    return;
  }

  if (subcommand === "run") {
    const jobId = subArgs[1];
    if (!jobId) {
      console.error("Usage: familiar cron run <job-id>");
      process.exit(1);
    }

    // Check config first (backward compat)
    let jobConfig: CronJobConfig | undefined = jobs.find((j) => j.id === jobId);

    // Fall back to DB: match by agent_id or schedule_id
    if (!jobConfig) {
      const db = openDb();
      if (db) {
        try {
          const row = db
            .prepare(
              `SELECT s.id as schedule_id, s.agent_id, s.name as schedule_name,
                      s.schedule, s.timezone, s.prompt, s.enabled as schedule_enabled,
                      a.name as agent_name, a.model, a.system_prompt, a.max_turns,
                      a.working_directory, a.tools as agent_tools, a.announce,
                      a.suppress_pattern, a.deliver_to, a.mcp_config, a.enabled as agent_enabled,
                      a.worktree_isolation, a.pre_hook, a.post_hook
               FROM schedules s
               JOIN agents a ON s.agent_id = a.id
               WHERE s.id = ? OR a.id = ?
               LIMIT 1`,
            )
            .get(jobId, jobId) as Record<string, unknown> | undefined;

          if (row) {
            jobConfig = rowToJobConfig(row);
          }
        } finally {
          db.close();
        }
      }
    }

    if (!jobConfig) {
      console.error(`Job not found: ${jobId}`);
      const configIds = jobs.map((j) => j.id);
      if (configIds.length > 0) {
        console.error(`Available config jobs: ${configIds.join(", ")}`);
      }
      console.error("Tip: use 'familiar cron list' to see all available jobs.");
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

  // Run entity separation migration (idempotent)
  const db = sessions.getDb();
  const configDir = getConfigDir();
  const migrationResult = runMigration(db, join(configDir, "config.json"));
  log.info(
    {
      agents: migrationResult.agents,
      schedules: migrationResult.schedules,
      projects: migrationResult.projects,
      tools: migrationResult.tools,
      skipped: migrationResult.skipped,
    },
    "migration 001 complete",
  );

  // Initialize entity stores (DB-backed)
  const agentCrudStore = new AgentCrudStore(db);
  const scheduleStore = new ScheduleStore(db);
  const projectStore = new ProjectStore(db);
  const toolStore = new ToolStore(db);
  toolStore.seed(); // populate registry on first run (INSERT OR IGNORE)
  const toolAccountStore = new ToolAccountStore(db);

  const claude = new ClaudeCLI(config.claude);
  const processTracker = new ProcessTracker();
  claude.setTracker(processTracker);
  const telegram = new TelegramChannel(config.telegram);

  // Initialize delivery queue — wraps sendDirectMessage with retry + persistence
  const deliveryQueue = new DeliveryQueue(db);
  deliveryQueue.onSend((chatId, text) => telegram.sendDirectMessage(chatId, text));
  deliveryQueue.start();

  // Initialize sub-agent system
  const agentRegistry = new AgentRegistry(db);
  const agentManager = new AgentManager(agentRegistry, config.claude);

  // Deliver sub-agent results via the delivery queue (retry-safe)
  agentManager.onDelivery(async (agent, resultText, costUsd, durationMs) => {
    const label = agent.label ?? agent.id;
    const status = agent.status === "completed" ? "done" : agent.status;
    const meta = `_${(durationMs / 1000).toFixed(1)}s | $${costUsd.toFixed(4)}_`;
    const preview = resultText.length > 3000 ? resultText.slice(0, 3000) + "..." : resultText;
    const text = `**Sub-agent ${status} -- ${label}**\n${meta}\n\n${preview}`;
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

  // Start cron scheduler -- reads from DB schedules + legacy config jobs
  let cron: CronScheduler | null = null;
  const configJobs = (config.cron?.jobs ?? []) as CronJobConfig[];
  // Always create scheduler if we have DB agents or config jobs
  const hasDbAgents = agentCrudStore.count() > 0;
  if (configJobs.length > 0 || hasDbAgents) {
    cron = new CronScheduler(configJobs, config.claude, undefined, config.webhooks?.token, config.webhooks?.port);
    cron.setSharedDb(db);

    cron.onDelivery(async (_jobId: string, result: CronRunResult, jobConfig: CronJobConfig, runId?: number) => {
      const chatId = jobConfig.deliverTo ?? defaultChatId;
      const label = jobConfig.label ?? jobConfig.id;
      const totalSec = result.durationMs / 1000;
      const durStr =
        totalSec >= 60
          ? `${Math.floor(totalSec / 60)}m${Math.round(totalSec % 60)}s`
          : `${totalSec.toFixed(1)}s`;
      const costStr = `$${result.costUsd.toFixed(2)}`;
      const baseUrl = config.webhooks?.publicUrl ?? "";
      const link = runId && baseUrl ? `\n${baseUrl}/#/runs/${runId}` : "";

      // Generate a one-line summary via haiku
      let summary = "";
      const hasText = result.text && result.text.trim().length > 0;
      const hasLog = result.runLog && result.runLog.trim().length > 0;
      if (hasText || hasLog) {
        try {
          const textForSummary = hasText ? result.text : `[Tool-only session for ${label}]`;
          summary = await summarizeAgentRun(label, textForSummary, result.runLog);
          if (summary) summary = `\n${summary}`;
        } catch (e) {
          log.warn({ err: e }, "failed to generate agent summary, using fallback");
          if (hasText) {
            const firstLine = result.text.split("\n").find((l: string) => l.trim().length > 10);
            if (firstLine) {
              summary = `\n${firstLine.trim().slice(0, 200)}`;
            }
          } else {
            summary = `\nCompleted ${result.numTurns} turns`;
          }
        }
      }

      const text = result.isError
        ? `${label} FAILED (${durStr})${summary}${link}`
        : `${label} (${durStr}, ${costStr})${summary}${link}`;
      await deliveryQueue.deliver(chatId, text);
    });

    cron.start();
    log.info({ configJobs: configJobs.length, dbAgents: agentCrudStore.count() }, "cron scheduler started");
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
    processTracker,
    config.claude.workingDirectory,
  );

  // Wire up and start
  bridge.start();
  // Detect sessions interrupted by a process restart (OOM kill, systemctl restart, etc.)
  // and prepare resume context for the next incoming message from each affected chatId.
  bridge.loadInterruptedSessions();
  await telegram.start();

  // Start webhook server if configured
  let webhooks: WebhookServer | null = null;
  if (config.webhooks?.token) {
    webhooks = new WebhookServer(config.webhooks, config.claude);

    // Wire up database for activity log and other db-dependent endpoints
    webhooks.setDb(db);

    // Wire up cron scheduler for REST API
    if (cron) {
      webhooks.setCronScheduler(cron);
    }

    // Wire up agent store for REST API (sub-agents)
    webhooks.setAgentStore(new AgentStore(agentManager));

    // Wire up persistent entity stores
    webhooks.setAgentCrudStore(agentCrudStore);
    webhooks.setScheduleStore(scheduleStore);
    webhooks.setProjectStore(projectStore);

    // Wire up repo manager for project repo operations
    const { RepoManager } = await import("./projects/repo-manager.js");
    const repoManager = new RepoManager(config.claude.workingDirectory);
    webhooks.setRepoManager(repoManager);
    webhooks.setToolStore(toolStore);
    webhooks.setToolAccountStore(toolAccountStore);
    webhooks.setTemplateStore(new TemplateStore(db));

    // Wire up agent template store (starter agent templates)
    const agentTemplateStore = new AgentTemplateStore(db);
    agentTemplateStore.seed(join(__dirname, "..", "templates"));
    webhooks.setAgentTemplateStore(agentTemplateStore);

    // Wire up memory store for /api/memory/search
    if (memoryStore) {
      webhooks.setMemoryStore(memoryStore);
    }

    // Wire up task store for REST API (named so we can add onUpdate callback)
    const taskStore = new TaskStore(db);
    webhooks.setTaskStore(taskStore);

    // Notify the owner via Telegram when a task is assigned to them
    const ownerName = config.owner?.name ?? "owner";
    webhooks.onTaskCreated((task: Record<string, unknown>) => {
      const agent = task.assigned_agent as string | undefined;
      if (agent === ownerName) {
        const title = task.title as string;
        const project = task.project_id as string | undefined;
        const priority = task.priority as number | undefined;
        const id = task.id as number;
        const desc = (task.description as string | undefined)?.slice(0, 200) ?? "";
        const msg = `New task for you: #${id}\n${title}${project ? ` [${project}]` : ""}${priority ? ` P${priority}` : ""}\n${desc}`;
        deliveryQueue.deliver(defaultChatId, msg).catch(() => {});
      }
    });

    // Allow /save skill to clear sessions via API
    webhooks.onSessionClear(() => {
      sessions.clearSession(String(defaultChatId));
      log.info("session cleared via /api/sessions/clear");
    });

    // Wire task store into scheduler so validation failures can create follow-up tasks
    if (cron) {
      cron.setTaskStore(taskStore);
    }

    // Set config path for legacy cron CRUD operations
    webhooks.setConfigPath(join(configDir, "config.json"));
    webhooks.setConfigChangeHandler(async () => {
      if (cron) await cron.reload();
      log.info("config changed via API -- scheduler reloaded");
    });

    // Wake handler — inject message into a chat (defaults to first allowed user)
    webhooks.onWake(async (chatId, message) => {
      const targetChat = chatId || String(config.telegram.allowedUsers[0]);
      await deliveryQueue.deliver(targetChat, message);
    });

    await webhooks.start();
    log.info({ port: config.webhooks.port }, "webhook server started");

    // Attach WebSocket server to the HTTP server
    const httpServer = webhooks.getHttpServer();
    if (httpServer) {
      const wsServer = new WsServer(httpServer, config.webhooks.token);
      log.info("ws server attached");

      // Wire scheduler to broadcast schedule events
      if (cron) {
        cron.setWsServer(wsServer);
      }

      // Wire task store to broadcast task change events
      taskStore.onUpdate((task) => {
        wsServer.broadcast({ type: "task:updated", task: task as unknown as Record<string, unknown> });
      });

      // Wire router to broadcast task:claimed events
      webhooks.setWsServer(wsServer);

      // Wire dashboard chat channel
      // primaryChatId unifies dashboard sessions with Telegram (shared Claude context)
      const primaryChatId = String(config.telegram.allowedUsers[0]);
      const dashboardChannel = new DashboardChannel(wsServer, primaryChatId);
      bridge.addChannel(dashboardChannel);
      await dashboardChannel.start();

      // Wire MessageBus for cross-channel sync (Telegram ↔ Dashboard)
      const bus = new MessageBus();
      bridge.setBus(bus);
      wsServer.setBus(bus);
      telegram.setBus(bus, primaryChatId);
      bridge.setMirrorChannel(telegram, primaryChatId);
      log.info("dashboard channel wired (cross-channel sync via MessageBus enabled)");
    }
  }

  // Generate SYSTEM.md manifest on startup
  try {
    const { generateManifest } = await import("./manifest.js");
    generateManifest({ personaPath: config.claude.workingDirectory, db, config });
    log.info("SYSTEM.md manifest generated");
  } catch (e) {
    log.warn({ err: e }, "failed to generate SYSTEM.md manifest");
  }

  // Send startup notification to Telegram
  const startupChatId = String(config.telegram.allowedUsers[0]);
  const agentCount = agentCrudStore?.count() ?? 0;
  const scheduleCount = cron ? cron.listJobs().length : 0;
  const publicUrl = config.webhooks?.publicUrl ?? "";
  const dashboardLink = publicUrl ? ` | ${publicUrl}` : "";
  await deliveryQueue.deliver(
    startupChatId,
    `${config.name ?? "Familiar"} online. ${agentCount} agents, ${scheduleCount} schedules.${dashboardLink}`,
  );

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

/** Dump a SQLite DB to a .sql file using the sqlite3 CLI. Returns true on success. */
function dumpSqlite(dbPath: string, outPath: string): boolean {
  const result = spawnSync("sqlite3", [dbPath, ".dump"], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const msg = result.error?.message ?? result.stderr ?? "unknown error";
    console.error(`  ✗ Failed to dump ${dbPath}: ${msg}`);
    return false;
  }
  writeFileSync(outPath, result.stdout, "utf-8");
  return true;
}

async function cmdBackup(subArgs: string[]): Promise<void> {
  const configDir = getConfigDir();
  const outDirIdx = subArgs.indexOf("--output");
  const outputDir = outDirIdx >= 0 ? subArgs[outDirIdx + 1] : configDir;
  const jobsDbIdx = subArgs.indexOf("--jobs-db");
  const jobsDbPath = jobsDbIdx >= 0 ? subArgs[jobsDbIdx + 1] : join(homedir(), "oliver", "projects", "job-hunt", "jobs.db");

  console.log("familiar backup\n");

  // Dump familiar.db
  const familiarDb = join(configDir, "familiar.db");
  const familiarSql = join(outputDir, "familiar.sql");
  if (!existsSync(familiarDb)) {
    console.error(`  ✗ familiar.db not found at ${familiarDb}`);
    process.exit(1);
  }
  process.stdout.write(`  Dumping familiar.db → ${familiarSql} ... `);
  if (dumpSqlite(familiarDb, familiarSql)) {
    const bytes = readFileSync(familiarSql).length;
    console.log(`ok (${Math.round(bytes / 1024)}KB)`);
  } else {
    process.exit(1);
  }

  // Dump jobs.db if present
  if (existsSync(jobsDbPath)) {
    const jobsSql = join(dirname(jobsDbPath), "jobs.sql");
    process.stdout.write(`  Dumping jobs.db → ${jobsSql} ... `);
    if (dumpSqlite(jobsDbPath, jobsSql)) {
      const bytes = readFileSync(jobsSql).length;
      console.log(`ok (${Math.round(bytes / 1024)}KB)`);
    }
  } else {
    console.log(`  (jobs.db not found at ${jobsDbPath} — skipping)`);
  }

  console.log("\nBackup complete. Commit the .sql files to your git repo to save them.");
}

async function cmdRestore(subArgs: string[]): Promise<void> {
  const configDir = getConfigDir();
  const fromIdx = subArgs.indexOf("--from");
  const sourceDir = fromIdx >= 0 ? subArgs[fromIdx + 1] : configDir;
  const jobsDbIdx = subArgs.indexOf("--jobs-db");
  const jobsDbPath = jobsDbIdx >= 0 ? subArgs[jobsDbIdx + 1] : join(homedir(), "oliver", "projects", "job-hunt", "jobs.db");
  const dryRun = subArgs.includes("--dry-run");

  console.log(`familiar restore${dryRun ? " (dry-run)" : ""}\n`);

  // Restore familiar.db from familiar.sql
  const familiarSql = join(sourceDir, "familiar.sql");
  const familiarDb = join(configDir, "familiar.db");
  if (!existsSync(familiarSql)) {
    console.error(`  ✗ familiar.sql not found at ${familiarSql}`);
    console.error(`  Run 'familiar backup' first, or pass --from <path> to the directory containing the .sql file.`);
    process.exit(1);
  }

  if (existsSync(familiarDb) && !dryRun) {
    const backupPath = familiarDb + ".bak";
    cpSync(familiarDb, backupPath);
    console.log(`  Backed up existing familiar.db → ${backupPath}`);
    unlinkSync(familiarDb);
  }

  if (!dryRun) {
    console.log(`  Restoring familiar.db from ${familiarSql} ...`);
    const result = spawnSync("sqlite3", [familiarDb], {
      input: readFileSync(familiarSql, "utf-8"),
      encoding: "utf-8",
    });
    if (result.error || result.status !== 0) {
      console.error(`  ✗ Failed: ${result.error?.message ?? result.stderr}`);
      process.exit(1);
    }
    console.log("  ✓ familiar.db restored");
  } else {
    console.log(`  [dry-run] Would restore familiar.db from ${familiarSql}`);
  }

  // Restore jobs.db if jobs.sql exists
  const jobsSqlPath = join(dirname(jobsDbPath), "jobs.sql");
  if (existsSync(jobsSqlPath)) {
    if (!dryRun) {
      if (existsSync(jobsDbPath)) {
        cpSync(jobsDbPath, jobsDbPath + ".bak");
        unlinkSync(jobsDbPath);
      }
      mkdirSync(dirname(jobsDbPath), { recursive: true });
      console.log(`  Restoring jobs.db from ${jobsSqlPath} ...`);
      const result = spawnSync("sqlite3", [jobsDbPath], {
        input: readFileSync(jobsSqlPath, "utf-8"),
        encoding: "utf-8",
      });
      if (result.error || result.status !== 0) {
        console.error(`  ✗ Failed: ${result.error?.message ?? result.stderr}`);
      } else {
        console.log("  ✓ jobs.db restored");
      }
    } else {
      console.log(`  [dry-run] Would restore jobs.db from ${jobsSqlPath}`);
    }
  } else {
    console.log(`  (jobs.sql not found — skipping jobs.db restore)`);
  }

  if (!dryRun) {
    console.log("\nRestore complete. Run 'familiar start' to launch.");
  }
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
    cmdTui(args.slice(1));
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

  case "export":
    (async () => {
      const config = loadConfig();
      const personaIdx = args.indexOf("--persona");
      const personaPath = personaIdx >= 0 ? args[personaIdx + 1] : config.claude.workingDirectory;
      if (!personaPath) {
        console.error("No persona path specified. Use --persona <path> or set claude.workingDirectory in config.");
        process.exit(1);
      }

      const { SessionStore } = await import("./session/store.js");
      const sessions = new SessionStore(config.sessions.inactivityTimeout, config.sessions.rotateAfterMessages);
      const db = sessions.getDb();

      // Ensure entity tables exist
      const { AgentCrudStore } = await import("./agents/agent-store.js");
      new AgentCrudStore(db);
      const { ScheduleStore } = await import("./schedules/store.js");
      new ScheduleStore(db);
      const { ToolStore } = await import("./tools/store.js");
      new ToolStore(db);
      const { ProjectStore } = await import("./projects/store.js");
      new ProjectStore(db);
      const { TemplateStore } = await import("./templates/store.js");
      new TemplateStore(db);

      const { exportToPersona } = await import("./sync/export.js");
      const result = exportToPersona({ personaPath, db });
      console.log(`Exported to ${personaPath}:`);
      console.log(`  Agents:    ${result.agents}`);
      console.log(`  Schedules: ${result.schedules}`);
      console.log(`  Tools:     ${result.tools}`);
      console.log(`  Projects:  ${result.projects}`);
      console.log(`  Templates: ${result.templates}`);
      sessions.close();
    })().catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "sync":
    (async () => {
      const config = loadConfig();
      const fromIdx = args.indexOf("--from");
      const personaPath = fromIdx >= 0 ? args[fromIdx + 1] : config.claude.workingDirectory;
      if (!personaPath) {
        console.error("No persona path specified. Use --from <path> or set claude.workingDirectory in config.");
        process.exit(1);
      }

      const { SessionStore } = await import("./session/store.js");
      const sessions = new SessionStore(config.sessions.inactivityTimeout, config.sessions.rotateAfterMessages);
      const db = sessions.getDb();

      const { AgentCrudStore } = await import("./agents/agent-store.js");
      const agentStore = new AgentCrudStore(db);
      const { ScheduleStore } = await import("./schedules/store.js");
      const scheduleStore = new ScheduleStore(db);
      const { ToolStore } = await import("./tools/store.js");
      const toolStore = new ToolStore(db);
      const { ProjectStore } = await import("./projects/store.js");
      const projectStore = new ProjectStore(db);
      const { TemplateStore } = await import("./templates/store.js");
      const templateStore = new TemplateStore(db);

      const cloneRepos = args.includes("--clone-repos");
      let repoManager: import("./projects/repo-manager.js").RepoManager | undefined;
      if (cloneRepos) {
        const { RepoManager } = await import("./projects/repo-manager.js");
        repoManager = new RepoManager(personaPath);
      }

      const { importFromPersona } = await import("./sync/import.js");
      const result = await importFromPersona({
        personaPath, db, agentStore, scheduleStore, toolStore, projectStore, templateStore,
        repoManager, cloneRepos,
      });
      console.log(`Synced from ${personaPath}:`);
      console.log(`  Agents:    ${result.agents.total} (${result.agents.created} new, ${result.agents.updated} updated)`);
      console.log(`  Schedules: ${result.schedules.total} (${result.schedules.created} new, ${result.schedules.updated} updated)`);
      console.log(`  Tools:     ${result.tools.total} (${result.tools.created} new, ${result.tools.updated} updated)`);
      console.log(`  Projects:  ${result.projects.total} (${result.projects.created} new, ${result.projects.updated} updated)`);
      console.log(`  Templates: ${result.templates.total} (${result.templates.created} new, ${result.templates.updated} updated)`);
      sessions.close();
    })().catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "manifest":
    (async () => {
      const config = loadConfig();
      const personaIdx = args.indexOf("--persona");
      const personaPath = personaIdx >= 0 ? args[personaIdx + 1] : config.claude.workingDirectory;
      if (!personaPath) {
        console.error("No persona path specified. Use --persona <path> or set claude.workingDirectory in config.");
        process.exit(1);
      }

      const { SessionStore } = await import("./session/store.js");
      const sessions = new SessionStore(config.sessions.inactivityTimeout, config.sessions.rotateAfterMessages);
      const db = sessions.getDb();

      // Ensure entity tables exist
      const { AgentCrudStore } = await import("./agents/agent-store.js");
      new AgentCrudStore(db);
      const { ScheduleStore } = await import("./schedules/store.js");
      new ScheduleStore(db);
      const { ToolStore } = await import("./tools/store.js");
      new ToolStore(db);
      const { ProjectStore } = await import("./projects/store.js");
      new ProjectStore(db);

      const { generateManifest } = await import("./manifest.js");
      generateManifest({ personaPath, db, config });
      console.log(`Generated SYSTEM.md at ${personaPath}/SYSTEM.md`);
      sessions.close();
    })().catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "backup":
    cmdBackup(args.slice(1)).catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "restore":
    cmdRestore(args.slice(1)).catch((e) => {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;

  case "restart": {
    const { execSync } = await import("node:child_process");
    try {
      execSync("systemctl --user restart familiar", { stdio: "inherit" });
      console.log("familiar restarted.");
      process.exit(0);
    } catch {
      console.error("Failed to restart. Is the systemd service installed? Run: familiar install-service");
      process.exit(1);
    }
  }

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
