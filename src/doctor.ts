import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, getConfigPath, getConfigDir, configExists } from "./config.js";

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function icon(status: CheckResult["status"]): string {
  switch (status) {
    case "pass":
      return `${GREEN}✓${RESET}`;
    case "warn":
      return `${YELLOW}⚠${RESET}`;
    case "fail":
      return `${RED}✗${RESET}`;
  }
}

function checkConfig(): CheckResult {
  if (!configExists()) {
    return {
      name: "Config file",
      status: "fail",
      message: `Not found at ${getConfigPath()}. Run 'familiar init'.`,
    };
  }
  try {
    loadConfig();
    return { name: "Config file", status: "pass", message: getConfigPath() };
  } catch (e) {
    return {
      name: "Config file",
      status: "fail",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

function checkClaudeCLI(): CheckResult {
  const result = spawnSync("claude", ["--version"], { timeout: 10_000 });
  if (result.error) {
    return {
      name: "Claude CLI",
      status: "fail",
      message: "Not found in PATH. Install Claude Code: https://claude.ai/cli",
    };
  }
  const version = result.stdout?.toString().trim() ?? "unknown";
  if (result.status !== 0) {
    return {
      name: "Claude CLI",
      status: "fail",
      message: `Exited with code ${result.status}: ${result.stderr?.toString().slice(0, 200)}`,
    };
  }
  return { name: "Claude CLI", status: "pass", message: version };
}

function checkTelegramToken(): CheckResult {
  if (!configExists()) {
    return { name: "Telegram bot", status: "fail", message: "No config file" };
  }
  try {
    const config = loadConfig();
    if (!config.telegram.botToken || config.telegram.botToken === "YOUR_BOT_TOKEN_HERE") {
      return {
        name: "Telegram bot",
        status: "fail",
        message: "Bot token not set. Get one from @BotFather.",
      };
    }
    // Quick validation — Telegram bot tokens are always in format NUMBER:ALPHANUMERIC
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.telegram.botToken)) {
      return { name: "Telegram bot", status: "warn", message: "Token format looks unusual" };
    }
    return {
      name: "Telegram bot",
      status: "pass",
      message: `Token set (${config.telegram.botToken.slice(0, 8)}...)`,
    };
  } catch {
    return { name: "Telegram bot", status: "fail", message: "Could not read config" };
  }
}

function checkDatabase(): CheckResult {
  const dbPath = join(getConfigDir(), "familiar.db");
  if (!existsSync(dbPath)) {
    return {
      name: "Database",
      status: "warn",
      message: "Not created yet (created on first start)",
    };
  }
  const stat = statSync(dbPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  // Quick integrity check
  const result = spawnSync("sqlite3", [dbPath, "PRAGMA integrity_check;"], { timeout: 10_000 });
  if (result.error) {
    return {
      name: "Database",
      status: "warn",
      message: `${sizeMB} MB (sqlite3 not in PATH — can't verify integrity)`,
    };
  }
  const output = result.stdout?.toString().trim();
  if (output === "ok") {
    return { name: "Database", status: "pass", message: `${sizeMB} MB, integrity OK` };
  }
  return {
    name: "Database",
    status: "fail",
    message: `Integrity check failed: ${output?.slice(0, 200)}`,
  };
}

function checkWorkspace(): CheckResult {
  if (!configExists()) {
    return { name: "Workspace", status: "fail", message: "No config file" };
  }
  try {
    const config = loadConfig();
    const dir = config.claude.workingDirectory;
    if (!existsSync(dir)) {
      return { name: "Workspace", status: "fail", message: `Directory not found: ${dir}` };
    }
    const claudeMd = join(dir, "CLAUDE.md");
    if (!existsSync(claudeMd)) {
      return { name: "Workspace", status: "warn", message: `${dir} exists but missing CLAUDE.md` };
    }
    return { name: "Workspace", status: "pass", message: dir };
  } catch {
    return { name: "Workspace", status: "fail", message: "Could not read config" };
  }
}

function checkSystemd(): CheckResult {
  const result = spawnSync("systemctl", ["--user", "is-active", "familiar"], { timeout: 5_000 });
  if (result.error) {
    return { name: "systemd service", status: "warn", message: "systemctl not available" };
  }
  const status = result.stdout?.toString().trim();
  if (status === "active") {
    return { name: "systemd service", status: "pass", message: "Running" };
  }
  if (status === "inactive") {
    return { name: "systemd service", status: "warn", message: "Installed but not running" };
  }
  // Service not installed
  const serviceFile = join(homedir(), ".config", "systemd", "user", "familiar.service");
  if (!existsSync(serviceFile)) {
    return {
      name: "systemd service",
      status: "warn",
      message: "Not installed. Run 'familiar install-service'.",
    };
  }
  return { name: "systemd service", status: "warn", message: `Status: ${status}` };
}

function checkDiskSpace(): CheckResult {
  const result = spawnSync("df", ["-h", getConfigDir()], { timeout: 5_000 });
  if (result.error) {
    return { name: "Disk space", status: "warn", message: "Could not check" };
  }
  const lines = result.stdout?.toString().trim().split("\n") ?? [];
  if (lines.length < 2) {
    return { name: "Disk space", status: "warn", message: "Could not parse df output" };
  }
  const parts = lines[1].split(/\s+/);
  const available = parts[3] ?? "?";
  const usePercent = parseInt(parts[4] ?? "0");
  if (usePercent > 95) {
    return {
      name: "Disk space",
      status: "fail",
      message: `${available} free (${usePercent}% used) — critically low!`,
    };
  }
  if (usePercent > 85) {
    return {
      name: "Disk space",
      status: "warn",
      message: `${available} free (${usePercent}% used)`,
    };
  }
  return { name: "Disk space", status: "pass", message: `${available} free (${usePercent}% used)` };
}

function checkSpawnQueue(): CheckResult {
  const dir = join(getConfigDir(), "spawn-queue");
  if (!existsSync(dir)) {
    return { name: "Spawn queue", status: "pass", message: "Directory created on start" };
  }
  return { name: "Spawn queue", status: "pass", message: dir };
}

export function runDoctor(): void {
  console.log(`\n${BOLD}familiar doctor${RESET}\n`);

  const checks = [
    checkConfig(),
    checkClaudeCLI(),
    checkTelegramToken(),
    checkDatabase(),
    checkWorkspace(),
    checkSystemd(),
    checkDiskSpace(),
    checkSpawnQueue(),
  ];

  const maxNameLen = Math.max(...checks.map((c) => c.name.length));

  for (const check of checks) {
    const pad = " ".repeat(maxNameLen - check.name.length);
    console.log(`  ${icon(check.status)} ${check.name}${pad}  ${check.message}`);
  }

  const pass = checks.filter((c) => c.status === "pass").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const fail = checks.filter((c) => c.status === "fail").length;

  console.log(`\n  ${pass} passed, ${warn} warnings, ${fail} failures\n`);

  if (fail > 0) {
    process.exit(1);
  }
}
