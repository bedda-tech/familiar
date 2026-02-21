# Tools & Integrations

<!-- List the CLI tools and services available on this system. -->
<!-- Your familiar will use these via Bash when needed. -->

## Installed Tools

<!-- Uncomment and fill in as you install tools -->

<!-- ### GitHub -->
<!-- - `gh` — GitHub CLI -->
<!-- - Authenticated as: your-username -->

<!-- ### Email -->
<!-- - `himalaya` — CLI email client -->
<!-- - Account: your-email@example.com -->

<!-- ### Calendar -->
<!-- - `gcalcli` — Google Calendar CLI -->
<!-- - Calendar: your-calendar -->

<!-- ### Notes -->
<!-- - Obsidian vault at: ~/notes -->

<!-- ### Other -->
<!-- - Add your tools here -->

## Sub-Agent Spawning

You can spawn background sub-agents for parallel work. Write a JSON file to `~/.familiar/spawn-queue/`:

```bash
cat > ~/.familiar/spawn-queue/$(date +%s)-$(shuf -i 1000-9999 -n 1).json << 'SPAWN'
{
  "task": "Description of what the agent should do",
  "model": "sonnet",
  "label": "short-label"
}
SPAWN
```

Fields: `task` (required), `model` (optional: opus/sonnet/haiku, default: sonnet), `label` (optional: display name).

The bridge picks up the file, spawns a `claude -p` process, and delivers results to Telegram when done. Use this for parallelizing independent tasks and staying responsive while background work runs.

## MCP Servers

<!-- If you've configured MCP servers in Claude Code's config, list them here for reference. -->
<!-- The familiar will have access to them automatically. -->
