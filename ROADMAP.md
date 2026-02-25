# Roadmap

## Current State (v0.1.0)

Familiar bridges Telegram to Claude Code via `claude -p --resume`. Working today:

- Telegram bot with text, photo, document, and voice message support
- Session persistence (SQLite, auto-expire on inactivity or message count)
- Streaming responses with edit-in-place and smart chunking
- Shared sessions between Telegram and terminal (`familiar tui`)
- OpenClaw migration
- systemd service installer
- Workspace templates with first-run onboarding (BOOTSTRAP.md)

## Short Term

### Multi-channel support
The channel interface (`src/channels/types.ts`) is already abstracted. Two approaches to evaluate:

**Option A: Build adapters ourselves** (current plan)
- **WhatsApp** via WhatsApp Business API or Baileys
- **Discord** via discord.js
- **Signal** via signal-cli

**Option B: Adopt Vercel Chat SDK** (`npm i chat`, open-sourced Feb 2026)
- Unified TypeScript library for Slack, Discord, Teams, Google Chat, GitHub, Linear
- Adapter pattern similar to our channel abstraction
- Built-in AI streaming support (native Slack streaming + post+edit fallback)
- JSX cards/modals that render natively per platform
- Distributed state management with pluggable backends
- See `docs/research/vercel-chat-sdk-evaluation.md` for full analysis
- Catch: no Telegram adapter (we'd still need our own for that)

### Daemon mode
`--daemon` is in the help text but not implemented. Use `familiar start --daemon` to background the process without systemd.

### Runtime model switching
`/model opus` should hot-switch models without restarting. Currently blocked — config is loaded once at startup. Requires config reload or per-message model override.

### Voice transcription
Voice messages are downloaded but sent to Claude as file paths. Integrate Whisper or Claude's native audio to transcribe before sending.

### Config hot-reload
Watch `~/.familiar/config.json` for changes and reload without restart. Useful for model switching, tool changes, prompt tweaks.

## Medium Term

### Scheduled tasks / heartbeats
OpenClaw had cron-based heartbeats (e.g., morning briefing, periodic checks). Add a simple cron scheduler that sends prompts to Claude on a schedule.

### Message search and recall
`message_log` table exists but has no query interface. Add `/search <query>` to search past messages, or let Claude query its own history.

### Group chat support
Currently single-user per chat. Support Telegram group chats where the bot is @mentioned, with per-user session isolation.

### Per-user tool restrictions
`allowedTools` is global. Allow per-user or per-chat tool overrides in config for multi-user setups.

### Cost tracking dashboard
Message log already tracks `cost_usd`. Add `/cost` command showing daily/weekly/monthly spend, or a simple web dashboard.

## Long Term

### Sub-agents
Multiple Claude instances with different personas or specializations, routed by the bridge based on message content or explicit commands.

### MCP server integration
Expose Familiar's session store, message history, and config as an MCP server so Claude Code can introspect its own bridge state.

### Web UI
Lightweight web interface for config editing, session inspection, message history browsing, and cost monitoring.

### Multi-instance
Run multiple familiars (different bots, different workspaces) from a single config, with shared infrastructure.
