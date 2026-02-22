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
