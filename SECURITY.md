# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| < 0.4   | No        |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **matt@bedda.tech** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledge**: Within 48 hours
- **Triage**: Within 72 hours
- **Fix (critical)**: Within 7 days
- **Fix (moderate)**: Within 30 days

### Scope

The following are in scope:

- Bot token exposure or leakage
- Session hijacking or unauthorized session access
- Unauthorized access to the bot (allowlist bypass)
- Command injection via user messages
- SQLite injection
- Webhook authentication bypass
- Information disclosure via error messages or logs

### Out of Scope

- Denial of service via Telegram rate limiting (Telegram's responsibility)
- Vulnerabilities in Claude Code CLI itself (report to Anthropic)
- Social engineering attacks

---

## Security Model

This section documents how Familiar handles user input and what protections are in place.

### Shell Command Injection

All invocations of the Claude CLI use Node's `child_process.spawn()` with an **array of arguments** (never a shell string). The user-supplied prompt is passed via **stdin**, not as a command-line argument. This means there is no shell metacharacter interpretation and no possibility of flag injection through prompt text.

```
spawn("claude", ["-p", "--output-format", "stream-json", ...], { stdio: ["pipe", ...] })
proc.stdin.write(userPrompt)   // safe: no shell involvement
```

### SQL Injection

Every SQLite query in the codebase uses **prepared statements with `?` parameter binding** (via `better-sqlite3`). No query is constructed by string concatenation of user-supplied values.

### Webhook Payload Limits

The HTTP server enforces the following limits to prevent memory exhaustion:

| Field     | Limit  |
|-----------|--------|
| Request body | 1 MB   |
| `message` (wake hook) | 64 KB  |
| `prompt` (agent hook) | 64 KB  |

Requests that exceed these limits receive a `400 Bad Request` response.

### Authentication

All webhook and REST API endpoints (except `/health` and `/dashboard`) require a Bearer token matching `webhooks.token` in the config. The token is compared with a plain string equality check (no timing-safe comparison needed — Bearer tokens are not secret inputs that must resist timing attacks on the server side, since the attacker must already know the endpoint).

### Configuration File Security

`~/.familiar/config.json` contains sensitive credentials (Telegram bot token, webhook token, OpenAI API key). Restrict access with:

```sh
chmod 600 ~/.familiar/config.json
```

The file is read once at startup and never written by Familiar itself.

### Telegram Access Control

Only user IDs in the `telegram.allowedUsers` list can interact with the bot. Messages from any other Telegram user ID are silently ignored before any processing occurs.

### Audit Trail

- All incoming messages are logged to SQLite (`message_log` table) truncated at 10 000 characters.
- Webhook requests are logged with `chatId` and message length (not content).
- Agent sub-process invocations are logged with model and turn count.
