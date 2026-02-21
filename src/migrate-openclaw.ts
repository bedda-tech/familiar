/**
 * Migrate an existing OpenClaw assistant to Familiar.
 *
 * What it does:
 * 1. Reads OpenClaw config to extract: bot token, workspace path, model, allowed users
 * 2. Reads OpenClaw cron jobs and converts them to Familiar format
 * 3. Creates ~/.familiar/config.json pointing at the existing workspace
 * 4. Adds a CLAUDE.md to the workspace (Claude Code's auto-loaded root instruction file)
 * 5. Leaves all existing governing docs (SOUL.md, IDENTITY.md, etc.) untouched
 *
 * What it does NOT do:
 * - Move or copy files — the workspace stays where it is
 * - Touch the OpenClaw SQLite memory DB — that's OpenClaw-specific
 * - Modify any existing governing docs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getConfigDir, getConfigPath, type CronJobEntry } from "./config.js";

// --- OpenClaw types ---

interface OpenClawConfig {
  channels?: {
    telegram?: {
      botToken?: string;
    };
    discord?: Record<string, unknown>;
    whatsapp?: Record<string, unknown>;
    signal?: Record<string, unknown>;
    slack?: Record<string, unknown>;
  };
  agents?: {
    defaults?: {
      workspace?: string;
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
      heartbeat?: {
        every?: string;
      };
      thinking?: string;
    };
    list?: Array<{
      id?: string;
      label?: string;
      workspace?: string;
      model?: { primary?: string };
    }>;
  };
}

interface OpenClawCronFile {
  version?: number;
  jobs?: OpenClawCronJob[];
}

interface OpenClawCronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  schedule: {
    kind: "at" | "every" | "cron";
    at?: string;
    everyMs?: number;
    expr?: string;
    tz?: string;
    staggerMs?: number;
  };
  sessionTarget?: "main" | "isolated";
  wakeMode?: "next-heartbeat" | "now";
  payload: {
    kind: "systemEvent" | "agentTurn";
    text?: string;
    message?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
  };
  delivery?: {
    mode?: "none" | "announce" | "webhook";
    channel?: string;
    to?: string;
    bestEffort?: boolean;
  };
  state?: {
    lastRunAtMs?: number;
    lastStatus?: string;
    consecutiveErrors?: number;
  };
}

interface TelegramAllowFrom {
  allowFrom?: string[];
}

// --- Constants ---

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const OPENCLAW_CONFIG_PATHS = [
  join(OPENCLAW_DIR, "openclaw.json"),
  join(OPENCLAW_DIR, "clawdbot.json"),
];
const OPENCLAW_CRON_PATH = join(OPENCLAW_DIR, "cron", "jobs.json");
const TELEGRAM_ALLOW_PATH = join(OPENCLAW_DIR, "credentials", "telegram-default-allowFrom.json");

// --- Helpers ---

function findOpenClawConfig(): { path: string; config: OpenClawConfig } | null {
  for (const p of OPENCLAW_CONFIG_PATHS) {
    if (existsSync(p)) {
      try {
        const config = JSON.parse(readFileSync(p, "utf-8")) as OpenClawConfig;
        return { path: p, config };
      } catch {
        continue;
      }
    }
  }
  return null;
}

function getAllowedTelegramUsers(): number[] {
  if (!existsSync(TELEGRAM_ALLOW_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(TELEGRAM_ALLOW_PATH, "utf-8")) as TelegramAllowFrom;
    return (data.allowFrom ?? []).map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

function mapModel(openclawModel?: string): string {
  if (!openclawModel) return "sonnet";
  const lower = openclawModel.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return "sonnet";
}

/** Convert OpenClaw interval in ms to a rough cron expression. */
function everyMsToCron(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `0 */${hours} * * *`;
  return `0 0 */${Math.round(hours / 24)} * *`;
}

/** Convert OpenClaw cron jobs to Familiar format. */
function migrateCronJobs(): { jobs: CronJobEntry[]; skipped: string[] } {
  if (!existsSync(OPENCLAW_CRON_PATH)) {
    return { jobs: [], skipped: [] };
  }

  let cronFile: OpenClawCronFile;
  try {
    cronFile = JSON.parse(readFileSync(OPENCLAW_CRON_PATH, "utf-8")) as OpenClawCronFile;
  } catch {
    return { jobs: [], skipped: ["Could not parse cron jobs file"] };
  }

  const jobs: CronJobEntry[] = [];
  const skipped: string[] = [];

  for (const job of cronFile.jobs ?? []) {
    // Skip one-shot jobs
    if (job.schedule.kind === "at") {
      skipped.push(`${job.name} (one-shot "at" job — not migrated)`);
      continue;
    }

    // Skip delete-after-run jobs
    if (job.deleteAfterRun) {
      skipped.push(`${job.name} (delete-after-run — not migrated)`);
      continue;
    }

    // Build schedule expression
    let schedule: string;
    let timezone: string | undefined;

    if (job.schedule.kind === "cron" && job.schedule.expr) {
      schedule = job.schedule.expr;
      timezone = job.schedule.tz;
    } else if (job.schedule.kind === "every" && job.schedule.everyMs) {
      schedule = everyMsToCron(job.schedule.everyMs);
    } else {
      skipped.push(`${job.name} (unsupported schedule kind: ${job.schedule.kind})`);
      continue;
    }

    // Build prompt from payload
    let prompt: string;
    if (job.payload.kind === "agentTurn" && job.payload.message) {
      prompt = job.payload.message;
    } else if (job.payload.kind === "systemEvent" && job.payload.text) {
      prompt = job.payload.text;
    } else {
      skipped.push(`${job.name} (no prompt/message in payload)`);
      continue;
    }

    // Map model
    const model = job.payload.model ? mapModel(job.payload.model) : undefined;

    // Map max turns from timeout (rough: ~2 min per turn)
    const maxTurns = job.payload.timeoutSeconds
      ? Math.min(50, Math.max(5, Math.ceil(job.payload.timeoutSeconds / 120)))
      : undefined;

    // Map delivery
    const announce = job.delivery?.mode !== "none";

    const entry: CronJobEntry = {
      id: job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: job.name,
      schedule,
      ...(timezone && { timezone }),
      prompt,
      ...(model && { model }),
      ...(maxTurns && { maxTurns }),
      announce,
      enabled: job.enabled,
    };

    jobs.push(entry);
  }

  return { jobs, skipped };
}

function buildClaudeMd(workspacePath: string): string {
  const possibleDocs = [
    { file: "SOUL.md", desc: "who you are" },
    { file: "IDENTITY.md", desc: "your name and nature" },
    { file: "USER.md", desc: "who you're helping" },
    { file: "AGENTS.md", desc: "your behavioral rules" },
    { file: "TOOLS.md", desc: "available tools and integrations" },
    { file: "HEARTBEAT.md", desc: "periodic monitoring checks" },
  ];

  const found = possibleDocs.filter((d) => existsSync(join(workspacePath, d.file)));

  const lines = [
    "# Familiar Workspace",
    "",
    "You are an AI familiar — a persistent personal assistant communicating through a messaging platform.",
    "",
    "Before doing anything else, read these files in order:",
  ];

  for (let i = 0; i < found.length; i++) {
    lines.push(`${i + 1}. ${found[i].file} — ${found[i].desc}`);
  }

  lines.push("");
  lines.push("Then check recent context:");
  lines.push("- `memory/` directory for today and yesterday's daily notes (YYYY-MM-DD.md)");

  if (existsSync(join(workspacePath, "MEMORY.md"))) {
    lines.push("- `MEMORY.md` — your long-term curated memory (only in private/direct chats)");
  }

  if (existsSync(join(workspacePath, "TODO.md"))) {
    lines.push("- `TODO.md` — current task board");
  }

  lines.push("");
  lines.push("If BOOTSTRAP.md exists, follow it — it's your first-run onboarding.");

  return lines.join("\n") + "\n";
}

function detectOtherChannels(config: OpenClawConfig): string[] {
  const channels: string[] = [];
  if (config.channels?.discord) channels.push("Discord");
  if (config.channels?.whatsapp) channels.push("WhatsApp");
  if (config.channels?.signal) channels.push("Signal");
  if (config.channels?.slack) channels.push("Slack");
  return channels;
}

// --- Main migration ---

export async function migrateFromOpenClaw(): Promise<void> {
  console.log("Migrating from OpenClaw to Familiar...\n");

  // 1. Find OpenClaw config
  const oc = findOpenClawConfig();
  if (!oc) {
    console.error("Could not find OpenClaw config at:");
    for (const p of OPENCLAW_CONFIG_PATHS) {
      console.error(`  ${p}`);
    }
    process.exit(1);
  }
  console.log(`Found OpenClaw config: ${oc.path}`);

  // 2. Extract core values
  const botToken = oc.config.channels?.telegram?.botToken;
  if (!botToken) {
    console.error("No Telegram bot token found in OpenClaw config.");
    console.error("Add your bot token to the Familiar config manually after migration.");
  }

  const workspace = oc.config.agents?.defaults?.workspace;
  if (!workspace) {
    console.error("No workspace path found in OpenClaw config.");
    process.exit(1);
  }
  console.log(`Workspace: ${workspace}`);

  if (!existsSync(workspace)) {
    console.error(`Workspace directory does not exist: ${workspace}`);
    process.exit(1);
  }

  const model = mapModel(oc.config.agents?.defaults?.model?.primary);
  console.log(`Model: ${model}`);

  const allowedUsers = getAllowedTelegramUsers();
  if (allowedUsers.length > 0) {
    console.log(`Allowed Telegram users: ${allowedUsers.join(", ")}`);
  } else {
    console.warn("No allowed Telegram users found — you'll need to add your user ID to the config.");
  }

  // Detect other channels for reporting
  const otherChannels = detectOtherChannels(oc.config);

  // 3. Migrate cron jobs
  console.log("\nMigrating cron jobs...");
  const { jobs: cronJobs, skipped: cronSkipped } = migrateCronJobs();
  if (cronJobs.length > 0) {
    console.log(`  Migrated ${cronJobs.length} cron job(s):`);
    for (const job of cronJobs) {
      console.log(`    - ${job.label ?? job.id} (${job.schedule})`);
    }
  } else {
    console.log("  No cron jobs to migrate.");
  }
  if (cronSkipped.length > 0) {
    console.log(`  Skipped ${cronSkipped.length}:`);
    for (const s of cronSkipped) {
      console.log(`    - ${s}`);
    }
  }

  // 4. Build system prompt from IDENTITY.md if available
  let systemPrompt =
    "You are a helpful personal assistant communicating via Telegram. Keep responses concise and well-formatted for mobile reading.";
  const identityPath = join(workspace, "IDENTITY.md");
  if (existsSync(identityPath)) {
    try {
      const identity = readFileSync(identityPath, "utf-8");
      const nameMatch = identity.match(/Name\b.*?:\s*(.+)/i);
      if (nameMatch) {
        const name = nameMatch[1].replace(/\*+/g, "").trim();
        systemPrompt = `You are ${name}, a personal AI familiar communicating via Telegram. Be yourself — read your governing docs (SOUL.md, IDENTITY.md, etc.) at session start. Keep responses concise for mobile reading.`;
        console.log(`\nIdentity: ${name}`);
      }
    } catch {
      /* ignore */
    }
  }

  // 5. Create Familiar config
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });

  const familiarConfig: Record<string, unknown> = {
    telegram: {
      botToken: botToken ?? "YOUR_BOT_TOKEN_HERE",
      allowedUsers: allowedUsers.length > 0 ? allowedUsers : [0],
    },
    claude: {
      workingDirectory: workspace,
      model,
      systemPrompt,
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
    ...(cronJobs.length > 0 && {
      cron: { jobs: cronJobs },
    }),
    log: {
      level: "info",
    },
  };

  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    const backupPath = configPath + ".bak";
    const existing = readFileSync(configPath, "utf-8");
    writeFileSync(backupPath, existing);
    console.log(`\nBacked up existing config to ${backupPath}`);
  }

  writeFileSync(configPath, JSON.stringify(familiarConfig, null, 2) + "\n");
  console.log(`Wrote config to ${configPath}`);

  // 6. Add CLAUDE.md to workspace
  const claudeMdPath = join(workspace, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const backupPath = claudeMdPath + ".bak";
    const existing = readFileSync(claudeMdPath, "utf-8");
    writeFileSync(backupPath, existing);
    console.log(`Backed up existing CLAUDE.md to ${backupPath}`);
  }

  const claudeMd = buildClaudeMd(workspace);
  writeFileSync(claudeMdPath, claudeMd);
  console.log(`Wrote ${claudeMdPath}`);

  // 7. Summary
  console.log("\n--- Migration complete ---\n");
  console.log("What was migrated:");
  console.log(`  + Familiar config at ${configPath}`);
  console.log(`  + CLAUDE.md at ${workspace}`);
  console.log(`  + Telegram bot token and user allowlist`);
  console.log(`  + Model selection (${model})`);
  if (cronJobs.length > 0) {
    console.log(`  + ${cronJobs.length} cron job(s)`);
  }
  console.log(`  + All existing governing docs left untouched`);

  console.log("\nWhat was NOT migrated (not yet supported):");
  if (otherChannels.length > 0) {
    console.log(`  - Other channels: ${otherChannels.join(", ")} — Familiar is Telegram-only for now`);
  }
  console.log("  - OpenClaw's vector memory DB — not used by Familiar");
  console.log("  - Skills / plugins — use Claude Code MCP tools instead");
  console.log("  - Webhook endpoints — planned feature");
  console.log("  - Sub-agent configs — planned feature");
  console.log("  - Browser profiles — planned feature");

  // Action items
  const actions: string[] = [];
  if (!botToken) {
    actions.push(`Add your Telegram bot token to ${configPath}`);
  }
  if (allowedUsers.length === 0) {
    actions.push(`Add your Telegram user ID to ${configPath}`);
  }

  if (actions.length > 0) {
    console.log("\nACTION REQUIRED:");
    for (const a of actions) {
      console.log(`  ${a}`);
    }
  }

  console.log("\nNext steps:");
  console.log("  1. Review the config: cat ~/.familiar/config.json");
  console.log("  2. Install systemd service: familiar install-service");
  console.log("  3. Start: familiar start");
  console.log("  4. (Optional) Enable service: systemctl --user enable --now familiar");
}
