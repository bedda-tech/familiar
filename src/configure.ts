import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getConfigDir, getConfigPath, configExists } from "./config.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") {
        resolve(defaultYes);
      } else {
        resolve(a === "y" || a === "yes");
      }
    });
  });
}

function print(msg: string): void {
  console.log(msg);
}

export async function runConfigure(): Promise<void> {
  print("");
  print("=== Familiar Configuration Wizard ===");
  print("");

  // Step 1: Check for existing config
  if (configExists()) {
    print(`Existing config found at ${getConfigPath()}`);
    const proceed = await askYesNo("Do you want to reconfigure?", false);
    if (!proceed) {
      print("Keeping existing configuration. Exiting.");
      rl.close();
      return;
    }
    print("");
  }

  // Step 2: Telegram bot token
  print("--- Telegram Bot Token ---");
  print("To create a Telegram bot:");
  print("  1. Open Telegram and search for @BotFather");
  print("  2. Send /newbot and follow the prompts");
  print("  3. Copy the bot token BotFather gives you");
  print("");
  let botToken = "";
  while (!botToken) {
    botToken = await ask("Telegram bot token (required)");
    if (!botToken) {
      print("  Bot token is required. Please enter a valid token.");
    }
  }
  print("");

  // Step 3: Telegram user ID
  print("--- Telegram User ID ---");
  print("To find your Telegram user ID:");
  print("  1. Open Telegram and search for @userinfobot");
  print("  2. Start a chat and it will reply with your user ID");
  print("  3. Enter the numeric ID below");
  print("");
  let userId = 0;
  while (!userId) {
    const raw = await ask("Telegram user ID (required)");
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
      print("  Please enter a valid numeric user ID.");
    } else {
      userId = parsed;
    }
  }
  print("");

  // Step 4: Claude model preference
  print("--- Claude Model ---");
  print("Available models:");
  print("  opus   — Most capable, highest quality");
  print("  sonnet — Balanced performance and speed (recommended)");
  print("  haiku  — Fastest, most affordable");
  print("");
  let model = "";
  while (!model) {
    const choice = await ask("Claude model", "sonnet");
    if (["opus", "sonnet", "haiku"].includes(choice)) {
      model = choice;
    } else {
      print("  Please choose one of: opus, sonnet, haiku");
    }
  }
  print("");

  // Step 5: Workspace directory
  print("--- Workspace Directory ---");
  print("This is where Familiar stores its working files (CLAUDE.md, memory, etc).");
  print("");
  const defaultWorkspace = join(homedir(), "familiar-workspace");
  const workspace = await ask("Workspace directory", defaultWorkspace);
  print("");

  // Step 6: OpenAI API key (optional, for voice transcription)
  print("--- Voice Transcription (Optional) ---");
  print("An OpenAI API key enables voice message transcription via Whisper.");
  print("You can skip this and add it later in config.json.");
  print("");
  const wantOpenAI = await askYesNo("Set up OpenAI API key for voice transcription?", false);
  let openaiKey = "";
  if (wantOpenAI) {
    openaiKey = await ask("OpenAI API key");
  }
  print("");

  // Step 7: Write config
  print("--- Writing Configuration ---");
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });

  const config: Record<string, unknown> = {
    telegram: {
      botToken,
      allowedUsers: [userId],
    },
    claude: {
      workingDirectory: workspace,
      model,
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

  if (openaiKey) {
    config.openai = {
      apiKey: openaiKey,
    };
  }

  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  print(`Config written to ${configPath}`);

  // Create workspace directory
  mkdirSync(workspace, { recursive: true });
  print(`Workspace directory ensured at ${workspace}`);
  print("");

  // Step 8: Next steps
  print("=== Setup Complete ===");
  print("");
  print("Next steps:");
  print("  1. Run 'familiar init' to populate workspace templates (CLAUDE.md, SOUL.md, etc.)");
  print("  2. Run 'familiar start' to start the bot");
  print("  3. Open Telegram and send a message to your bot!");
  print("");
  print("Optional:");
  print("  - Run 'familiar install-service' to set up systemd auto-start");
  print("  - Edit config.json to add cron jobs, webhooks, or other settings");
  print("");

  rl.close();
}
