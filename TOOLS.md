# Tool Assignment System

Familiar lets you assign specific tools to each cron agent so they get exactly what they need — nothing more.

## Overview

Every agent has a `tools` field (JSON array of Claude Code tool names). When the runner spawns `claude -p`, it passes `--allowedTools` to restrict what the agent can call.

Two layers of configuration:

1. **Tool Profiles** — predefined sets of tools grouped by agent category
2. **Tool Registry** — catalog of every available tool with metadata (stored in the `tools` DB table)

---

## Tool Profiles

Profiles are defined in `src/tools/profiles.ts` and exposed via the API.

| Profile | Tools | Typical Agents |
|---------|-------|----------------|
| `engineering` | Bash, Read, Write, Edit, Glob, Grep | familiar-engineering, nozio-engineering, axon-engineering, bedda-ai-engineering, crowdia-engineering |
| `job-hunt` | Bash, Read, Write, Glob, Grep, WebFetch, WebSearch | greenhouse-pipeline, lever-pipeline, ashby-pipeline, linkedin-pipeline, job-scanner, batch-tailor |
| `infra` | Bash, Read, Glob, Grep | infra-agent, cron-doctor, heartbeat |
| `content` | Bash, Read, Write, WebFetch, WebSearch | content, bedda-marketing-engineering, krain-marketing |
| `research` | Bash, Read, Write, WebFetch, WebSearch | research, triage |
| `crowdia` | Bash, Read, Write, Glob, Grep | crowdia-extraction, crowdia-discovery |
| `media` | Bash, Read, Write, Edit, Grep, Glob, Agent | media-monitor, media-server |
| `krain` | Bash, Read, Write, Edit, Glob, Grep, WebFetch | krain-discord-triage, krain-engineering, krain-app-review |

---

## API Endpoints

```
GET  /api/tools/profiles               List all profiles
GET  /api/tools/profiles/:id           Get a single profile
POST /api/tools/profiles/:id/apply     Apply profile to an agent
  body: { "agentId": "my-agent-id" }
```

### Apply a profile to an agent (curl)

```bash
curl -s -H "x-familiar-token: $TOKEN" \
  -X POST -H "Content-Type: application/json" \
  "http://localhost:3002/api/tools/profiles/engineering/apply" \
  -d '{"agentId": "my-new-agent"}'
```

---

## Dashboard UI

When creating or editing an agent in the dashboard:

1. Open the **Agents** tab and click **New Agent** (or edit an existing one)
2. Select a **Tool Profile** from the dropdown — this auto-fills the Tools field
3. The tools field remains editable if you need custom overrides
4. When editing, the dropdown auto-detects the current profile (if it matches exactly)

---

## Tool Registry

The registry (`src/tools/registry.ts`) catalogs every tool available on media-server. It's seeded into the `tools` SQLite table at startup via `ToolStore.seed()`.

### Tool Types

| Type | Description |
|------|-------------|
| `builtin` | Claude Code built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Agent) |
| `cli` | Command-line tools in `~/bin/` or system PATH |
| `mcp` | MCP servers (GitHub, Neon, Gmail, Notion, Chrome) |
| `script` | Custom scripts in project directories |

### Querying the Registry

```bash
# List all tools
curl -s -H "x-familiar-token: $TOKEN" "http://localhost:3002/api/tools"

# Filter by type
curl -s -H "x-familiar-token: $TOKEN" "http://localhost:3002/api/tools?type=cli"

# Single tool
curl -s -H "x-familiar-token: $TOKEN" "http://localhost:3002/api/tools/gog"
```

---

## Scope

- **Not in scope**: Restricting the main Oliver interactive session (it needs everything)
- **Not in scope**: Modifying Claude Code's upstream tool handling
- MCP servers are not currently passed per-agent (they're global to the session). The `mcpServers` field in profiles is reserved for future use.
