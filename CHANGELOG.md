# Changelog

All notable changes to Familiar are documented here.

## [0.2.0] — 2026-02-21

### Added
- **Cron scheduler** — Schedule recurring jobs with cron expressions and timezone support. Jobs run as isolated `claude -p` processes with configurable model, max turns, and working directory. Results delivered to Telegram. ([#14](https://github.com/bedda-tech/familiar/issues/14))
- **Typing indicators** — Bot shows "typing..." in Telegram while Claude is processing. Sends action immediately and repeats every 4 seconds until first text arrives. ([#20](https://github.com/bedda-tech/familiar/issues/20))
- **Thinking block streaming** — Extended thinking/reasoning from Claude is sent as italicized messages in Telegram before the final response. ([#38](https://github.com/bedda-tech/familiar/issues/38))
- **Webhook server** — HTTP endpoints for external triggering: `POST /hooks/wake` (inject message), `POST /hooks/agent` (isolated agent turn), `GET /health`. Bearer token auth via `Authorization` header or `x-familiar-token`. ([#15](https://github.com/bedda-tech/familiar/issues/15))
- **Runtime model switching** — `/model opus`, `/model sonnet`, `/model haiku` to switch models without restart. `/model reset` reverts to config default. ([#3](https://github.com/bedda-tech/familiar/issues/3))
- **Config hot-reload** — Watches `config.json` for changes with debouncing. Hot-reloads model and log level without restart. Warns about fields that require a restart. ([#5](https://github.com/bedda-tech/familiar/issues/5))
- **Heartbeat with conditional delivery** — `suppressPattern` config on cron jobs: if the output matches a regex (e.g. `HEARTBEAT_OK`), delivery is suppressed. ([#6](https://github.com/bedda-tech/familiar/issues/6))
- **OpenClaw migration** — `familiar migrate-from-openclaw` now migrates cron jobs (cron expressions, intervals), detects other channels, and provides clear next-steps guidance. ([#29](https://github.com/bedda-tech/familiar/issues/29))
- **Cron CLI** — `familiar cron list` shows job status and next run time. `familiar cron run <id>` manually triggers a job.

### Changed
- Architecture section in README updated to reflect new modules (cron, webhooks, config watcher).
- HEARTBEAT.md updated for Familiar context (removed OpenClaw-specific references).

### Dependencies
- Added `croner` for cron expression parsing with timezone support.

## [0.1.0] — 2026-02-21

### Added
- Initial release — Telegram to Claude Code bridge.
- grammY-based Telegram bot with message streaming (edit-in-place).
- Session management with SQLite (better-sqlite3): auto-rotation, inactivity timeout, message logging.
- `familiar start` — Start the bot.
- `familiar tui` — Open Claude Code TUI resuming the Telegram session.
- `familiar init` — Create config and workspace with template governing docs.
- `familiar migrate-from-openclaw` — Basic migration from OpenClaw config.
- `familiar install-service` — Install systemd user service.
- Workspace template system: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, BOOTSTRAP.md, TODO.md, MEMORY.md.
- First-run onboarding via BOOTSTRAP.md (self-deleting).
- Telegram commands: `/new` (fresh session), `/status` (session info), `/model` (show model).
- Response chunking for Telegram's 4096-char message limit.
- Structured logging with pino.
- Publishes as `@bedda/familiar` on npm.
