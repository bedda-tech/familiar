/**
 * Tool Profiles -- predefined sets of allowed tools for each agent category.
 *
 * Each profile specifies:
 *   - allowedTools: Claude Code builtins passed as --allowedTools
 *   - description: human-readable summary
 *
 * When applying a profile, the agent's `tools` column is set to `allowedTools`.
 * MCP servers are controlled separately via the agent's `mcp_config` column.
 *
 * Usage via API:
 *   GET  /api/tools/profiles            -- list all profiles
 *   POST /api/tools/profiles/:id/apply  -- apply profile to an agent
 *     body: { "agentId": "some-agent-id" }
 */

export interface ToolProfile {
  id: string;
  name: string;
  description: string;
  /** Claude Code tool names passed as --allowedTools to the claude CLI. */
  allowedTools: string[];
  /** Agent IDs that belong to this profile (used for bulk-apply migrations). */
  defaultAgents?: string[];
}

/** All available tool profiles. */
export const TOOL_PROFILES: ToolProfile[] = [
  {
    id: "engineering",
    name: "Engineering",
    description:
      "Software development agents: read/write code, run builds, use git and GitHub. " +
      "No web browsing or external APIs beyond code tools.",
    allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    defaultAgents: [
      "familiar-engineering",
      "nozio-engineering",
      "axon-engineering",
      "bedda-ai-engineering",
      "omnivi-engineering",
      "engineering",
      "crowdia-engineering",
    ],
  },
  {
    id: "job-hunt",
    name: "Job Hunt",
    description:
      "Job application pipeline agents: run pipeline scripts, fetch job listings, " +
      "write application data. Includes web access for job board scraping.",
    allowedTools: ["Bash", "Read", "Write", "Glob", "Grep", "WebFetch", "WebSearch"],
    defaultAgents: [
      "greenhouse-pipeline",
      "ashby-pipeline",
      "ashby-discover",
      "lever-pipeline",
      "linkedin-pipeline",
      "linkedin-to-greenhouse",
      "job-scanner",
      "job-inbox-monitor",
      "job-rescue-agent",
      "batch-tailor",
      "workday-submit",
      "pipeline-monitor",
    ],
  },
  {
    id: "infra",
    name: "Infrastructure",
    description:
      "Read-only infrastructure monitoring: check system health, disk, memory, processes. " +
      "No write access to prevent accidental system changes.",
    allowedTools: ["Bash", "Read", "Glob", "Grep"],
    defaultAgents: ["infra-agent", "cron-doctor", "heartbeat"],
  },
  {
    id: "content",
    name: "Content / Marketing",
    description:
      "Content creation and social media agents: write blog posts, social content, " +
      "fetch web sources. Includes bird CLI access for Twitter/X.",
    allowedTools: ["Bash", "Read", "Write", "WebFetch", "WebSearch"],
    defaultAgents: ["content", "bedda-marketing-engineering"],
  },
  {
    id: "research",
    name: "Research",
    description:
      "Web research and analysis agents: fetch URLs, search the web, summarize findings. " +
      "Can write output files but doesn't need code editing tools.",
    allowedTools: ["Bash", "Read", "Write", "WebFetch", "WebSearch"],
    defaultAgents: ["research", "triage"],
  },
  {
    id: "crowdia",
    name: "Crowdia Extraction",
    description:
      "Crowdia data agents: run extraction/discovery scripts, interact with Supabase. " +
      "No web search needed — scraping is done via the agents/index.ts scripts.",
    allowedTools: ["Bash", "Read", "Write", "Glob", "Grep"],
    defaultAgents: ["crowdia-extraction", "crowdia-discovery"],
  },
  {
    id: "media",
    name: "Media Server",
    description:
      "Media server management: check and fix Sonarr/Radarr/qBit/Plex, restart services, " +
      "clean download queues. Full read/write/edit for remediation work.",
    allowedTools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "Agent"],
    defaultAgents: ["media-monitor", "media-server"],
  },
];

/** Look up a profile by ID. Returns undefined if not found. */
export function getProfile(id: string): ToolProfile | undefined {
  return TOOL_PROFILES.find((p) => p.id === id);
}

/** Return the profile ID for a given agent, or undefined if none matches. */
export function profileForAgent(agentId: string): string | undefined {
  for (const profile of TOOL_PROFILES) {
    if (profile.defaultAgents?.includes(agentId)) {
      return profile.id;
    }
  }
  return undefined;
}
