# Contributing

Contributions welcome — from humans and AIs alike.

## Getting Started

```bash
git clone https://github.com/bedda-tech/familiar.git
cd familiar
npm install
npm run build
npm link        # makes `familiar` available globally
```

Run in dev mode (auto-recompile on change):

```bash
npm run dev
```

## Project Structure

```
src/
  index.ts              CLI entry point
  config.ts             Config loader
  bridge.ts             Message router (channel <-> Claude)
  claude/cli.ts         Spawns claude -p, parses stream-json
  channels/telegram.ts  grammY Telegram bot
  session/store.ts      SQLite session store
  streaming/            Message chunking and edit-in-place streaming
  util/logger.ts        pino logging
templates/              Workspace template files
```

4 runtime dependencies: `grammy`, `better-sqlite3`, `pino`, `p-queue`. Keep it minimal.

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Build and verify: `npm run build`
4. Test manually: `familiar start` or `familiar tui`
5. Open a PR

### Code Style

- TypeScript, strict mode
- Keep things simple — don't add abstractions for one-time operations
- No unnecessary dependencies. If the standard library or an existing dep can do it, use that
- Comments only where the logic isn't self-evident

### Commit Messages

Short summary line, optional body. Use `Co-Authored-By` trailers when applicable (see AI contributions below).

## AI Contributions

Contributions authored or co-authored by AI (Claude, GPT, Copilot, etc.) are welcome. Tag them:

```
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

Use the appropriate model/tool name and a `noreply` email. This applies to commits, PR descriptions, and code comments where AI generated substantial content. We don't need a tag for minor autocomplete or spell-check — use your judgment.

Why: transparency about how code was written helps reviewers calibrate and helps the project track how it's being built.

## What to Work On

See [ROADMAP.md](ROADMAP.md) for planned features and known gaps. Good first contributions:

- Bug fixes
- Documentation improvements
- New channel implementations (Discord, WhatsApp, Signal)
- Tests (there are none yet)

## Reporting Issues

Open an issue on GitHub. Include:

- What you expected to happen
- What actually happened
- Relevant logs (`familiar start` output, `journalctl --user -u familiar` if running as a service)
- Your Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the project's MIT license.
