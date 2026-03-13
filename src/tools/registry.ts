/**
 * Tool Registry -- catalog of every tool available on media-server.
 *
 * This is the authoritative list of CLIs, MCP servers, and builtins that
 * agents can use. The ToolStore.seed() method inserts these into the DB
 * on first run (skipping any that already exist).
 *
 * Source of truth: ~/.claude/projects/-home-mwhit-clawd/memory/tools-inventory.md
 */

import type { CreateToolInput } from "./types.js";

export const TOOL_REGISTRY: CreateToolInput[] = [
  // ── Claude Code Builtins ────────────────────────────────────────────────
  { id: "Bash", name: "Bash", type: "builtin", description: "Execute shell commands" },
  { id: "Read", name: "Read", type: "builtin", description: "Read files from the filesystem" },
  { id: "Write", name: "Write", type: "builtin", description: "Write files to the filesystem" },
  { id: "Edit", name: "Edit", type: "builtin", description: "Edit files with precise string replacement" },
  { id: "Glob", name: "Glob", type: "builtin", description: "Find files matching a pattern" },
  { id: "Grep", name: "Grep", type: "builtin", description: "Search file contents with ripgrep" },
  { id: "WebFetch", name: "WebFetch", type: "builtin", description: "Fetch content from a URL" },
  { id: "WebSearch", name: "WebSearch", type: "builtin", description: "Search the web" },
  { id: "Agent", name: "Agent", type: "builtin", description: "Spawn a sub-agent for delegated tasks" },
  { id: "TodoWrite", name: "TodoWrite", type: "builtin", description: "Manage a to-do list for task tracking" },

  // ── CLI Tools (~/bin/ and system) ───────────────────────────────────────
  {
    id: "gog",
    name: "gog (Google CLI)",
    type: "cli",
    cli_command: "gog",
    binary_path: "~/bin/gog",
    description: "Google CLI: Gmail, Calendar, Drive, Sheets, Docs, Contacts, Tasks. Pre-authed for 4 accounts.",
    config: { env: "GOG_KEYRING_PASSWORD", accounts: ["matthewjwhitney@gmail.com", "matt@bedda.tech", "matt@krain.ai", "matt@metatech.dev"] },
  },
  {
    id: "gdocs-write",
    name: "gdocs-write",
    type: "cli",
    cli_command: "gdocs-write",
    binary_path: "~/bin/gdocs-write",
    description: "Write content to Google Docs (gog complement). Uses gog OAuth tokens.",
  },
  {
    id: "bird-matt",
    name: "bird-matt (Twitter @MattWhitney__)",
    type: "cli",
    cli_command: "bird-matt",
    binary_path: "~/bin/bird-matt",
    description: "Twitter/X CLI for @MattWhitney__. Auth cookies baked in.",
  },
  {
    id: "bird-bedda",
    name: "bird-bedda (Twitter @BeddaTech)",
    type: "cli",
    cli_command: "bird-bedda",
    binary_path: "~/bin/bird-bedda",
    description: "Twitter/X CLI for @BeddaTech. Auth cookies baked in.",
  },
  {
    id: "bird-krain",
    name: "bird-krain (Twitter @krain_ai)",
    type: "cli",
    cli_command: "bird-krain",
    binary_path: "~/bin/bird-krain",
    description: "Twitter/X CLI for @krain_ai. Auth cookies baked in.",
  },
  {
    id: "reddit",
    name: "reddit CLI",
    type: "cli",
    cli_command: "reddit",
    binary_path: "~/bin/reddit",
    description: "Reddit CLI (puppeteer-stealth, multi-account). BLOCKED: needs API credentials.",
    enabled: false,
  },
  {
    id: "stripe",
    name: "Stripe CLI",
    type: "cli",
    cli_command: "stripe",
    binary_path: "~/bin/stripe",
    description: "Stripe CLI. Pre-authed binary.",
  },
  {
    id: "claude",
    name: "Claude CLI",
    type: "cli",
    cli_command: "claude",
    binary_path: "~/.local/bin/claude",
    description: "Claude Code CLI (headless -p mode). Use for LLM calls in scripts: claude -p. OAuth auto-refreshed.",
    version: "2.1.72",
  },
  {
    id: "sqlite-utils",
    name: "sqlite-utils",
    type: "cli",
    cli_command: "sqlite-utils",
    binary_path: "~/.local/bin/sqlite-utils",
    description: "SQLite query/insert/update CLI. No auth needed.",
  },
  {
    id: "weasyprint",
    name: "weasyprint",
    type: "cli",
    cli_command: "weasyprint",
    binary_path: "~/.local/bin/weasyprint",
    description: "HTML-to-PDF converter. No auth needed.",
  },
  {
    id: "vercel",
    name: "Vercel CLI",
    type: "cli",
    cli_command: "vercel",
    description: "Vercel deployment CLI.",
    config: { tokenEnv: "VERCEL_TOKEN" },
  },
  {
    id: "gh",
    name: "GitHub CLI",
    type: "cli",
    cli_command: "gh",
    description: "GitHub CLI. Multi-account: matt-bedda, matt-krain, matthewjwhitney, MetaMatt1.",
  },
  {
    id: "pnpm",
    name: "pnpm",
    type: "cli",
    cli_command: "pnpm",
    description: "Fast package manager (npm alternative). No auth needed.",
  },
  {
    id: "supabase",
    name: "Supabase CLI",
    type: "cli",
    cli_command: "npx supabase",
    description: "Supabase CLI. Requires SUPABASE_ACCESS_TOKEN env var.",
    config: { tokenEnv: "SUPABASE_ACCESS_TOKEN" },
  },

  // ── MCP Servers ─────────────────────────────────────────────────────────
  {
    id: "mcp-github",
    name: "GitHub MCP",
    type: "mcp",
    description: "GitHub MCP server: issues, PRs, repos, commits, code search, branches, releases.",
    config: { transport: "http", auth: "bearer", tokenEnv: "GITHUB_TOKEN" },
  },
  {
    id: "mcp-neon",
    name: "Neon MCP",
    type: "mcp",
    description: "Neon database MCP: projects, branches, SQL execution, schema management, migrations.",
    config: { transport: "http", auth: "bearer", tokenEnv: "NEON_API_KEY" },
  },
  {
    id: "mcp-gmail",
    name: "Gmail MCP",
    type: "mcp",
    description: "Gmail MCP (Claude AI): search, read, draft, list labels/messages/threads.",
    config: { transport: "claude-ai", auth: "oauth" },
  },
  {
    id: "mcp-notion",
    name: "Notion MCP",
    type: "mcp",
    description: "Notion MCP (Claude AI): search, fetch, create/update pages, databases, comments.",
    config: { transport: "claude-ai", auth: "oauth" },
  },
  {
    id: "mcp-chrome",
    name: "Claude-in-Chrome MCP",
    type: "mcp",
    description: "Browser automation via Chrome extension: tabs, navigation, screenshots, JS execution.",
    config: { transport: "claude-ai", flag: "--chrome" },
  },
];
