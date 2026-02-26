# Vercel Chat SDK Evaluation for Familiar

> Date: 2026-02-25
> Status: Research
> SDK: https://github.com/vercel/chat (`npm i chat`)
> Announced: https://vercel.com/changelog/chat-sdk (Feb 24, 2026, public beta)

## What It Is

A unified TypeScript library for building chatbots that work across multiple messaging platforms with a single codebase. Write bot logic once, deploy to Slack, Discord, Teams, Google Chat, GitHub, Linear.

## Architecture

- **Adapter pattern**: common Chat API + platform-specific adapters
- **Event-driven**: type-safe handlers for mentions, messages, reactions, button clicks, slash commands, modals
- **JSX cards/modals**: render natively on each platform
- **AI streaming**: native Slack streaming + post+edit fallback on other platforms
- **Distributed state**: pluggable adapters (Redis, ioredis, in-memory)

## Platform Support Matrix

| Platform | Streaming | Reactions | Modals | Mentions | Status |
|----------|-----------|-----------|--------|----------|--------|
| Slack | Native | Full | Full | Full | Most complete |
| Teams | Post+edit | Read-only | ? | Full | Good |
| Google Chat | Post+edit | ? | ? | Full | Good |
| Discord | Post+edit | ? | ? | Full | Good |
| GitHub | No | Full | No | Full | Limited |
| Linear | No | Full | No | Full | Limited |
| **Telegram** | **N/A** | **N/A** | **N/A** | **N/A** | **Not supported** |

## Relevance to Familiar

### What We Have Today

Familiar already has a channel abstraction (`src/channels/types.ts`) that separates bot logic from platform specifics. Currently only Telegram is implemented. Our abstraction handles:
- Message sending/editing (streaming with edit-in-place)
- Photo/document/voice input
- Session persistence
- Cron-driven scheduled prompts

### What Chat SDK Offers Over Rolling Our Own

1. **6 platform adapters ready to use** instead of building each from scratch
2. **AI streaming already solved** per-platform (Slack's native streaming, post+edit fallback elsewhere)
3. **Interactive UI components** (JSX cards, buttons, modals) -- we don't have this
4. **Active maintenance by Vercel** -- platform API changes tracked upstream

### What We'd Lose / Trade-offs

1. **No Telegram support** -- our primary (and only current) channel. We'd need to keep our own Telegram adapter regardless.
2. **Different abstraction model** -- Chat SDK is event-driven (handlers for mentions, messages, reactions). Familiar is session-driven (persistent conversations with Claude). These are fundamentally different paradigms.
3. **Dependency on Vercel's beta** -- SDK is public beta, API may change
4. **State management mismatch** -- Chat SDK uses Redis/ioredis for state. Familiar uses SQLite for sessions and message history.
5. **Claude-specific features** -- our bridge does things Chat SDK doesn't: `claude -p --resume` session management, tool approval, context compaction, cost tracking

### Integration Approaches

**Approach 1: Use Chat SDK as a channel layer (recommended if we adopt)**

Keep Familiar's core (session management, Claude bridge, cron system) and use Chat SDK adapters as additional channel implementations alongside our Telegram channel:

```
Familiar Core (session store, Claude bridge, cron)
├── TelegramChannel (our own, stays as-is)
├── SlackChannel (wraps Chat SDK Slack adapter)
├── DiscordChannel (wraps Chat SDK Discord adapter)
└── TeamsChannel (wraps Chat SDK Teams adapter)
```

Each Chat SDK adapter would need a thin wrapper to:
- Map Chat SDK events -> Familiar's message handling
- Route responses back through Chat SDK's send/edit methods
- Handle session lifecycle (create/resume/rotate)

**Approach 2: Use Chat SDK standalone for non-Telegram platforms**

Run Chat SDK as a separate service that calls Familiar's webhook API (`/hooks/agent`) for AI processing. Simpler integration but duplicates some infrastructure.

**Approach 3: Don't adopt, build our own adapters**

Use discord.js, @slack/bolt, botbuilder (Teams) directly. More work upfront but full control, no beta dependency, no abstraction mismatch.

## Recommendation

**Wait and evaluate.** The Chat SDK is compelling but:

1. It's public beta -- let it stabilize
2. Telegram (our primary channel) isn't supported, so we can't replace our core
3. The session-driven vs. event-driven paradigm difference is non-trivial to bridge
4. We should focus on shipping Familiar's current roadmap before adding platform complexity

**When to revisit:**
- When Chat SDK reaches 1.0
- When a user requests Slack/Discord support
- When Familiar's core is stable enough to invest in multi-platform

**Quick win for now:** Open a GitHub issue tracking multi-platform support and reference this evaluation. If someone contributes a Slack adapter, they can choose to use Chat SDK or not.

## For bedda.ai

The Chat SDK is more immediately relevant to bedda.ai than to Familiar. bedda could use it to deploy multi-model AI access (Claude, GPT, Gemini) directly into team Slack/Discord/Teams workspaces as a "bedda for Teams" product. See `bedda-chat/docs/feature-ideas/CHAT_PLATFORM_EXPANSION.md` for that analysis.
