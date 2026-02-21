/**
 * Migrate an existing OpenClaw assistant to Familiar.
 *
 * What it does:
 * 1. Reads OpenClaw config to extract: bot token, workspace path, model, allowed users
 * 2. Creates ~/.familiar/config.json pointing at the existing workspace
 * 3. Adds a CLAUDE.md to the workspace (Claude Code's auto-loaded root instruction file)
 * 4. Leaves all existing governing docs (SOUL.md, IDENTITY.md, etc.) untouched
 *
 * What it does NOT do:
 * - Move or copy files — the workspace stays where it is
 * - Touch the OpenClaw SQLite memory DB — that's OpenClaw-specific
 * - Modify any existing governing docs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getConfigDir, getConfigPath } from "./config.js";

interface OpenClawConfig {
  channels?: {
    telegram?: {
      botToken?: string;
    };
  };
  agents?: {
    defaults?: {
      workspace?: string;
      model?: {
        primary?: string;
      };
      heartbeat?: {
        every?: string;
      };
    };
  };
}

interface TelegramAllowFrom {
  allowFrom?: string[];
}

const OPENCLAW_CONFIG_PATHS = [
  join(homedir(), ".openclaw", "openclaw.json"),
  join(homedir(), ".openclaw", "clawdbot.json"),
];

const TELEGRAM_ALLOW_PATH = join(
  homedir(),
  ".openclaw",
  "credentials",
  "telegram-default-allowFrom.json",
);

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

function buildClaudeMd(workspacePath: string): string {
  // Scan what governing docs actually exist in the workspace
  const possibleDocs = [
    { file: "SOUL.md", desc: "who you are" },
    { file: "IDENTITY.md", desc: "your name and nature" },
    { file: "USER.md", desc: "who you're helping" },
    { file: "AGENTS.md", desc: "your behavioral rules" },
    { file: "TOOLS.md", desc: "available tools and integrations" },
    { file: "HEARTBEAT.md", desc: "periodic monitoring checks" },
    { file: "OMNIVI.md", desc: "Omnivi project context" },
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

  // Always include memory instructions
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

  // 2. Extract values
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

  // 3. Build system prompt from SOUL.md + IDENTITY.md if available
  let systemPrompt = "You are a helpful personal assistant communicating via Telegram. Keep responses concise and well-formatted for mobile reading.";
  const identityPath = join(workspace, "IDENTITY.md");
  if (existsSync(identityPath)) {
    try {
      const identity = readFileSync(identityPath, "utf-8");
      // Extract name from IDENTITY.md
      const nameMatch = identity.match(/Name\b.*?:\s*(.+)/i);
      if (nameMatch) {
        const name = nameMatch[1].replace(/\*+/g, "").trim();
        systemPrompt = `You are ${name}, a personal AI familiar communicating via Telegram. Be yourself — read your governing docs (SOUL.md, IDENTITY.md, etc.) at session start. Keep responses concise for mobile reading.`;
        console.log(`Identity: ${name}`);
      }
    } catch { /* ignore */ }
  }

  // 4. Create Familiar config
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });

  const familiarConfig = {
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

  // 5. Add CLAUDE.md to workspace (Claude Code's root instruction file)
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

  // 6. Summary
  console.log("\n--- Migration complete ---\n");
  console.log("What happened:");
  console.log(`  - Created Familiar config at ${configPath}`);
  console.log(`  - Added CLAUDE.md to ${workspace}`);
  console.log(`  - All existing governing docs left untouched`);
  console.log("");
  console.log("What was NOT migrated:");
  console.log("  - OpenClaw's vector memory DB (261MB SQLite) — not used by Familiar");
  console.log("  - WhatsApp channel config — Familiar is Telegram-only for now");
  console.log("  - Cron jobs / heartbeats — not yet supported in Familiar");
  console.log("  - Sub-agent configs — not yet supported in Familiar");
  console.log("");

  if (!botToken) {
    console.log("ACTION REQUIRED:");
    console.log(`  Add your Telegram bot token to ${configPath}`);
    console.log("");
  }
  if (allowedUsers.length === 0) {
    console.log("ACTION REQUIRED:");
    console.log(`  Add your Telegram user ID to ${configPath}`);
    console.log("");
  }

  console.log("To start: familiar start");
}
