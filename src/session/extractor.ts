import { spawnSync } from "node:child_process";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { MemoryStore } from "../memory/store.js";
import { MEMORY_CATEGORIES, type MemoryCategory } from "../memory/store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("session-extractor");

interface ExtractedMemory {
  category: MemoryCategory;
  filename: string;
  content: string;
}

/**
 * Extraction prompt — OpenViking session compression v5.2.0 pattern.
 *
 * Asks Haiku to extract structured memories in the 8 categories from a conversation.
 * Output is a JSON array only — no prose.
 */
const EXTRACTION_PROMPT = `You are a memory extraction agent. Extract structured memories from the conversation below.

Output a JSON array of memory objects. Each object:
  "category": one of: profile, preferences, entities, events, cases, patterns, tools, skills
  "filename": short snake_case filename without extension (e.g. "user_job_goal", "project_nozio_db_migration")
  "content": memory content as plain text — be specific, use exact terms verbatim

Category guide:
  profile:     who the user is — role, background, skills, goals, identity facts
  preferences: how the user wants things done — style, workflow, tooling preferences (be specific per facet)
  entities:    named things — people, projects, companies, products, servers the user works with
  events:      specific dated happenings — decisions, outcomes, status changes, releases
  cases:       problems and solutions — bugs fixed, errors diagnosed, workarounds discovered
  patterns:    reusable strategies — architectures, workflows, processes, recurring approaches
  tools:       tools, APIs, CLIs, scripts, integrations — how to invoke them, key flags, known quirks
  skills:      domain knowledge — research findings, techniques, analyses the user has demonstrated

Rules (strictly follow):
  - Only extract facts explicitly mentioned in the conversation
  - Use absolute dates (2026-03-28 not "yesterday" or "today")
  - Each distinct fact is a separate item — do not combine unrelated facts
  - Verbatim technical terms: exact variable names, commands, URLs, model IDs
  - Preferences: one facet per item (not "prefers X and Y and Z")
  - Skip greetings, filler, one-time ephemeral state, and general world knowledge
  - Return [] if nothing worth persisting across sessions

Output ONLY a valid JSON array — no markdown, no prose, no code fences.

Conversation:
`;

/** Resolve the claude binary, preferring ~/.local/bin like the cron runner does. */
function resolveClaudeBin(): string {
  const home = homedir();
  const extraDirs = [join(home, ".local", "bin"), join(home, ".npm-global", "bin"), "/usr/local/bin", "/usr/bin"];
  const currentPath = process.env.PATH ?? "";
  const nvmBinDirs = currentPath.split(delimiter).filter((d) => d.includes(".nvm") || d.includes(".volta"));
  const augmentedPath = [...new Set([...extraDirs, ...nvmBinDirs, ...currentPath.split(delimiter)])]
    .filter(Boolean)
    .join(delimiter);

  const result = spawnSync("which", ["claude"], { env: { ...process.env, PATH: augmentedPath }, encoding: "utf-8" });
  const resolved = result.stdout?.trim();
  if (resolved && existsSync(resolved)) return resolved;
  return "claude";
}

/**
 * Extract structured memories from a completed conversation and write them to the memory store.
 *
 * Flow:
 *  1. Build conversation text from messages
 *  2. Call `claude -p --model haiku` with extraction prompt → JSON array of candidates
 *  3. For each candidate, vector-search for near-duplicates
 *  4. Skip duplicates; write new memories to memory/<category>/<filename>.md
 *
 * Returns the number of memories written.
 */
export async function extractSessionMemories(
  messages: Array<{ role: string; content: string; created_at: string }>,
  workingDirectory: string,
  memoryStore: MemoryStore,
): Promise<number> {
  if (messages.length < 4) {
    log.debug({ count: messages.length }, "too few messages for extraction, skipping");
    return 0;
  }

  // Build conversation text (truncate each message to limit prompt size)
  const convText = messages
    .map((m) => {
      const speaker = m.role === "user" ? "User" : "Assistant";
      return `[${m.created_at}] ${speaker}: ${m.content.slice(0, 600)}`;
    })
    .join("\n\n");

  const fullPrompt = EXTRACTION_PROMPT + convText;

  const claudeBin = resolveClaudeBin();

  // Call haiku in --print mode (no session, single turn, text output)
  const result = spawnSync(claudeBin, ["-p", "--model", "haiku", "--output-format", "text", "--max-turns", "1"], {
    input: fullPrompt,
    encoding: "utf-8",
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
    cwd: workingDirectory,
  });

  if (result.error || result.status !== 0) {
    log.error(
      { err: result.error, status: result.status, stderr: result.stderr?.slice(0, 300) },
      "haiku extraction failed",
    );
    return 0;
  }

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return 0;

  // Parse the JSON array — find first [...] block in case of any surrounding text
  let candidates: ExtractedMemory[];
  try {
    const match = stdout.match(/\[[\s\S]*\]/);
    if (!match) {
      log.debug({ preview: stdout.slice(0, 100) }, "no JSON array in extraction output");
      return 0;
    }
    candidates = JSON.parse(match[0]) as ExtractedMemory[];
  } catch (e) {
    log.error({ err: e, preview: stdout.slice(0, 200) }, "failed to parse extraction JSON");
    return 0;
  }

  if (!Array.isArray(candidates) || candidates.length === 0) return 0;

  // Filter to valid, well-formed candidates
  const valid = candidates.filter(
    (c) =>
      c &&
      typeof c.category === "string" &&
      (MEMORY_CATEGORIES as readonly string[]).includes(c.category) &&
      typeof c.filename === "string" &&
      c.filename.length > 0 &&
      typeof c.content === "string" &&
      c.content.length > 10,
  );

  log.info({ total: candidates.length, valid: valid.length }, "extraction candidates");

  let written = 0;
  for (const candidate of valid) {
    try {
      // Vector-search for near-duplicates in the same category
      const searchQuery = `${candidate.filename.replace(/_/g, " ")} ${candidate.content.slice(0, 300)}`;
      const similar = await memoryStore.search(searchQuery, 3, candidate.category);

      // Reciprocal rank fusion scores >1.5 indicate a strong match — skip duplicates
      const isDuplicate = similar.some((r) => r.score > 1.5);
      if (isDuplicate) {
        log.debug({ filename: candidate.filename, topScore: similar[0]?.score }, "skipping near-duplicate memory");
        continue;
      }

      // Write to memory/<category>/<filename>.md
      const filename = candidate.filename.replace(/\.md$/, "") + ".md";
      await memoryStore.write(candidate.category as MemoryCategory, filename, candidate.content);
      written++;
      log.info({ category: candidate.category, filename }, "wrote extracted memory");
    } catch (e) {
      log.error({ err: e, filename: candidate.filename }, "failed to write extracted memory");
    }
  }

  log.info({ valid: valid.length, written }, "session memory extraction complete");
  return written;
}
