<p align="center">
  <img src="banner.png" alt="Familiar" width="600">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bedda/familiar"><img src="https://img.shields.io/npm/v/@bedda/familiar" alt="npm"></a>
  <a href="https://github.com/bedda-tech/familiar/blob/main/LICENSE"><img src="https://img.shields.io/github/license/bedda-tech/familiar" alt="license"></a>
  <a href="https://github.com/orgs/bedda-tech/projects/3"><img src="https://img.shields.io/badge/project-roadmap-blue" alt="roadmap"></a>
</p>

A bridge between Telegram and Claude Code (`claude -p`). Gives you a persistent AI assistant on Telegram backed by Claude Code's full toolset — Bash, file ops, web search, MCP servers, session memory.

```
Telegram  ──>  Familiar (bridge)  ──>  claude -p --resume <session>
          <──                     <──  --output-format stream-json
```

## Features

- **Streaming responses** — Edit-in-place message streaming, just like ChatGPT
- **Session persistence** — SQLite-backed sessions survive restarts, auto-rotate on inactivity or message count
- **Thinking blocks** — Extended reasoning streamed as italicized messages before the response, toggleable via `/thinking`
- **Typing indicators** — Bot shows "typing..." while Claude is processing, including during tool execution
- **Tool visibility** — Tool calls shown in Telegram as inline code blocks so you can see what Claude is doing
- **Voice transcription** — Voice messages transcribed via OpenAI Whisper API before sending to Claude
- **Cost tracking** — `/cost` shows session, today, 24h, and all-time usage costs
- **Sub-agents** — `/spawn` background tasks on separate `claude -p` processes; `/agents` to list, kill, inspect. SQLite-tracked with concurrency limits. The familiar can also self-spawn agents via a file-based queue
- **Semantic memory** — Hybrid FTS5 + vector search (sqlite-vec, OpenAI embeddings). `familiar recall <query>` for semantic search, `familiar index-memory` to re-index
- **Delivery queue** — SQLite-backed retry with exponential backoff for all async Telegram deliveries (cron, sub-agents, webhooks). Survives restarts
- **Memory management** — PreCompact hook backs up transcripts, periodic checkpoints every 20 messages, urgent flush at 80% of session rotation limit
- **System diagnostics** — `familiar doctor` checks config, Claude CLI, DB integrity, workspace, systemd, disk space
- **Model failover** — Automatic failover chain (opus → sonnet → haiku) when a model errors before producing output
- **Cron scheduler** — Schedule recurring jobs with cron expressions, timezone support, and isolated execution
- **Webhooks** — HTTP endpoints for external triggering (`/hooks/wake`, `/hooks/agent`, `/health`)
- **Runtime model switching** — `/model opus`, `/model sonnet`, `/model haiku` — switch without restart
- **Config hot-reload** — Edit config.json and changes apply live (model, log level)
- **File responses** — Send photos and documents back to user from Claude via `sendFile`
- **TUI mode** — `familiar tui` opens the full Claude Code TUI, resuming the same Telegram session
- **OpenClaw migration** — `familiar migrate-from-openclaw` migrates config, cron jobs, OpenAI key, failover chain
- **Governing docs** — Personality system via SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md
- **First-run onboarding** — BOOTSTRAP.md walks new users through naming and configuring their familiar

## Setup

Two paths: **fresh install** or **migrate from OpenClaw**.

### Path A: Fresh Install

**Prerequisites**: Node.js >= 20, Claude Code CLI installed and authenticated (`claude --version` works).

```bash
# 1. Install globally from npm
npm install -g @bedda/familiar

# 2. Initialize config and workspace
familiar init
```

This creates:
- `~/.familiar/config.json` — edit this next
- `~/familiar-workspace/` — workspace with template governing docs

```bash
# 3. Edit the config — you MUST set botToken and allowedUsers
```

Open `~/.familiar/config.json` and set these two values:

| Field | How to get it |
|-------|---------------|
| `telegram.botToken` | Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the token |
| `telegram.allowedUsers[0]` | Message [@userinfobot](https://t.me/userinfobot) on Telegram → it replies with your numeric user ID |

The config after editing should look like:

```json
{
  "telegram": {
    "botToken": "7234567890:AAH...",
    "allowedUsers": [1632355333]
  },
  "claude": {
    "workingDirectory": "/home/you/familiar-workspace",
    "model": "sonnet",
    "systemPrompt": "You are a helpful personal assistant communicating via Telegram. Keep responses concise and well-formatted for mobile reading.",
    "allowedTools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
    "maxTurns": 25
  },
  "sessions": {
    "inactivityTimeout": "24h",
    "rotateAfterMessages": 200
  },
  "log": {
    "level": "info"
  }
}
```

```bash
# 4. Start
familiar start
```

### Path B: Migrate from OpenClaw

If `~/.openclaw/` exists with a previous OpenClaw/ClawdBot setup:

```bash
# 1. Install globally from npm
npm install -g @bedda/familiar

# 2. Run migration — reads OpenClaw config, cron jobs, creates Familiar config, adds CLAUDE.md
familiar migrate-from-openclaw
```

The migration reads from these OpenClaw paths:
- Config: `~/.openclaw/openclaw.json` or `~/.openclaw/clawdbot.json`
- Allowed users: `~/.openclaw/credentials/telegram-default-allowFrom.json`
- Cron jobs: `~/.openclaw/cron/jobs.json`

It creates:
- `~/.familiar/config.json` — with Telegram config, model, workspace, and migrated cron jobs
- `CLAUDE.md` in the workspace — Claude Code's auto-loaded root instruction file

All existing governing docs (SOUL.md, IDENTITY.md, USER.md, etc.) are left untouched.

**What's migrated:**
- Telegram bot token and user allowlist
- Model selection
- Cron jobs (cron expressions and interval schedules converted to Familiar format)
- System prompt derived from IDENTITY.md

**Not migrated:**
- Other channels (Discord, WhatsApp, Signal) — Familiar is Telegram-only for now
- Skills/plugins — use Claude Code MCP tools instead

```bash
# 3. Verify config looks right
cat ~/.familiar/config.json

# 4. Start
familiar start
```

## Verification

After starting, confirm it works:

1. `familiar start` should print log lines and not exit (ctrl+c to stop)
2. Message your bot on Telegram — it should respond
3. Run `familiar tui` in another terminal — should resume the same session
4. `/status` in Telegram — should show session info

If `familiar start` crashes:
- `"Config missing required 'telegram.botToken'"` → edit `~/.familiar/config.json`, set `botToken`
- `"Config missing required 'telegram.allowedUsers'"` → set `allowedUsers` to your Telegram user ID
- `ENOENT` on `claude` → Claude Code CLI not installed or not in PATH
- `"Claude Code cannot be launched inside another Claude Code session"` → familiar strips the `CLAUDECODE` env var automatically, but if you see this, make sure you're running `familiar start` from a normal terminal, not from inside `claude`

If `familiar install-service` creates a service that can't find `claude`:
- The service file captures your current `PATH` at install time. If you install `claude` or `node` to a new location later, re-run `familiar install-service` to regenerate the service file with the updated PATH.

## Config Reference

**File**: `~/.familiar/config.json`

### Core

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `telegram.botToken` | string | **required** | Telegram bot token from BotFather |
| `telegram.allowedUsers` | number[] | **required** | Telegram user IDs allowed to use the bot |
| `claude.workingDirectory` | string | `~/familiar-workspace` | Directory where Claude Code runs; governing docs live here |
| `claude.model` | string | `"sonnet"` | Model: `"sonnet"`, `"opus"`, or `"haiku"` |
| `claude.systemPrompt` | string | *(generic)* | System prompt prepended to every `claude -p` invocation |
| `claude.allowedTools` | string[] | *(see below)* | Claude Code tools to enable via `--allowedTools` |
| `claude.maxTurns` | number | `25` | Max agentic turns per message via `--max-turns` |
| `claude.failoverChain` | string[] | `["opus","sonnet","haiku"]` | Model failover order — tries next on error |
| `sessions.inactivityTimeout` | string | `"24h"` | Reset session after this much inactivity. Format: `"30m"`, `"24h"`, `"7d"` |
| `sessions.rotateAfterMessages` | number | `200` | Start fresh session after this many messages |
| `sessions.preCompactionFlush` | boolean | `true` | Inject memory-save prompt at 80% of rotation limit |
| `openai.apiKey` | string | — | OpenAI API key for Whisper voice transcription and memory embeddings |
| `openai.whisperModel` | string | `"whisper-1"` | Whisper model to use |
| `log.level` | string | `"info"` | Log level: `"debug"`, `"info"`, `"warn"`, `"error"` |

### Cron Jobs

```json
{
  "cron": {
    "jobs": [
      {
        "id": "heartbeat",
        "label": "Heartbeat",
        "schedule": "0 * * * *",
        "timezone": "Europe/Rome",
        "prompt": "Check system health. If nothing needs attention, reply HEARTBEAT_OK.",
        "model": "sonnet",
        "maxTurns": 10,
        "announce": true,
        "suppressPattern": "HEARTBEAT_OK"
      }
    ]
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | **required** | Unique job identifier |
| `label` | string | — | Human-readable name |
| `schedule` | string | **required** | Cron expression (5-field) |
| `timezone` | string | `"UTC"` | IANA timezone |
| `prompt` | string | **required** | Prompt sent to `claude -p` |
| `model` | string | config default | Model override for this job |
| `maxTurns` | number | config default | Max turns for this job |
| `workingDirectory` | string | config default | Working directory override |
| `deliverTo` | string | first allowed user | Telegram chat ID for delivery |
| `announce` | boolean | `true` | Whether to deliver results to Telegram |
| `suppressPattern` | string | — | Regex — if output matches, suppress delivery |
| `enabled` | boolean | `true` | Enable/disable without removing |

### Webhooks

```json
{
  "webhooks": {
    "port": 3100,
    "bind": "127.0.0.1",
    "token": "your-secret-token"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | **required** | Port to listen on |
| `bind` | string | `"127.0.0.1"` | Bind address |
| `token` | string | **required** | Bearer token for authentication |

**Endpoints:**
- `POST /hooks/wake` — Inject a message into a session. Body: `{ "message": "...", "chatId?": "..." }`
- `POST /hooks/agent` — Run an isolated agent turn, returns result. Body: `{ "prompt": "...", "model?": "...", "maxTurns?": 10 }`
- `GET /health` — Health check (no auth required). Returns: `{ "status": "ok", "uptime": 12345 }`

## CLI Commands

```
familiar start                  Start the Telegram bot (foreground)
familiar start --daemon         Start in background (writes PID to ~/.familiar/familiar.pid)
familiar stop                   Stop a daemon-mode process
familiar tui                    Open Claude Code TUI, resuming the active Telegram session
familiar cron list              List configured cron jobs and their state
familiar cron run <id>          Manually trigger a cron job
familiar recall <query>         Semantic memory search (hybrid FTS + vector)
familiar index-memory           Re-index all memory files for semantic search
familiar doctor                 Run system diagnostics
familiar init                   Create ~/.familiar/config.json and workspace with templates
familiar migrate-from-openclaw  Migrate from an existing OpenClaw setup
familiar install-service        Install systemd user service for background running
familiar help                   Show help
```

### `familiar tui`

Opens the full Claude Code interactive TUI, resuming the same session that Telegram uses. This lets you switch between phone and terminal mid-conversation.

- Reads the session ID from `~/.familiar/familiar.db` (same SQLite store Telegram uses)
- Launches `claude --resume <session_id>` with `stdio: inherit`
- When you exit the TUI, the next Telegram message picks up where you left off
- If no session exists yet, starts a fresh `claude` session

## Telegram Commands

- `/new` — Clear current session, start fresh
- `/status` — Show session info (session ID, message count, age)
- `/model` — Show current model
- `/model opus` / `/model sonnet` / `/model haiku` — Switch model at runtime
- `/model reset` — Revert to config default
- `/cost` — Show usage costs (session, today, 24h, all time)
- `/thinking on` / `/thinking off` — Toggle thinking block display
- `/spawn <task>` — Spawn a background sub-agent (optional `--model`, `--label`)
- `/agents` — List active/recent sub-agents
- `/agents kill <id|all>` — Kill running sub-agents
- `/agents info <id>` — Show sub-agent details and result
- Send a voice message — auto-transcribed via Whisper before processing

## Workspace & Governing Docs

The workspace directory (`claude.workingDirectory`) contains files that define your familiar's personality. `familiar init` creates these templates:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Root instruction file — loaded automatically by Claude Code on every invocation |
| `SOUL.md` | Core personality and philosophy |
| `IDENTITY.md` | Name, nature, emoji — filled in during first conversation via BOOTSTRAP.md |
| `USER.md` | Info about the human — filled in during first conversation |
| `AGENTS.md` | Behavioral rules |
| `TOOLS.md` | Available CLI tools and integrations |
| `BOOTSTRAP.md` | First-run onboarding script — self-deletes after setup |
| `TODO.md` | Persistent task board |
| `MEMORY.md` | Long-term curated memory |
| `memory/` | Daily notes directory (YYYY-MM-DD.md) |

On the first Telegram message, the familiar reads BOOTSTRAP.md and walks the user through choosing a name, emoji, and personality.

## Running as a systemd Service

```bash
# Install the service file to ~/.config/systemd/user/familiar.service
familiar install-service

# Enable and start
systemctl --user daemon-reload
systemctl --user enable familiar
systemctl --user start familiar

# Check status / logs
systemctl --user status familiar
journalctl --user -u familiar -f

# Stop
systemctl --user stop familiar
```

## Architecture

6 runtime dependencies (`grammy`, `better-sqlite3`, `pino`, `p-queue`, `croner`, `sqlite-vec`).

```
~/.familiar/
  config.json       # Config (hot-reloaded)
  familiar.db       # SQLite — sessions, message log, cron state, agents, delivery queue, memory vectors
  spawn-queue/      # File-based queue for self-spawning sub-agents

~/familiar/         # Source repo
  src/
    index.ts        # CLI entry point (start, tui, init, migrate, cron, doctor, recall, etc.)
    config.ts       # Config loader with defaults and validation
    config-watcher.ts # Hot-reload via fs.watch
    bridge.ts       # Message router: channel <-> Claude (with periodic memory checkpoints)
    doctor.ts       # System diagnostics (config, CLI, DB, workspace, systemd, disk)
    migrate-openclaw.ts # OpenClaw migration (config + cron jobs)
    claude/
      cli.ts        # Spawns `claude -p`, parses stream-json, model override
      types.ts      # Stream event types (text, thinking, tool_use, system, done)
    channels/
      telegram.ts   # grammY Telegram bot (typing, direct messages, chunking)
      types.ts      # Channel interface
    session/
      store.ts      # SQLite session store (better-sqlite3)
    streaming/
      chunker.ts    # Splits long responses into 4096-char Telegram messages
      draft.ts      # Edit-in-place streaming (updates message as response streams in)
    cron/
      scheduler.ts  # Cron scheduling with croner, SQLite state, suppress pattern
      runner.ts     # Isolated job execution (spawns claude -p per job)
      types.ts      # Cron job types
    agents/
      registry.ts   # SQLite sub-agent tracking (status, cost, results)
      manager.ts    # Sub-agent lifecycle (spawn, kill, delivery callbacks)
      queue.ts      # File-based spawn queue for self-spawning sub-agents
    delivery/
      queue.ts      # SQLite-backed retry with exponential backoff
    memory/
      store.ts      # Hybrid FTS5 + sqlite-vec semantic memory search
    webhooks/
      server.ts     # HTTP webhook server (wake, agent, health)
    voice/
      transcribe.ts # Whisper API transcription with ffmpeg conversion
    util/
      logger.ts     # pino logger
  templates/        # Workspace template files copied by `familiar init`
  dist/             # Compiled JS (after `npm run build`)
```

## Roadmap & Contributing

See the [project board](https://github.com/orgs/bedda-tech/projects/3) for tracked issues and priorities, and [CHANGELOG.md](CHANGELOG.md) for release history.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). AI-authored contributions are welcome as long as they are tagged with `Co-Authored-By`.

## License

MIT
