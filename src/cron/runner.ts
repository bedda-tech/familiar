import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { delimiter } from "node:path";
import { createInterface } from "node:readline";
import type { CronJobConfig, CronRunResult } from "./types.js";
import type { ClaudeConfig } from "../config.js";
import type { StreamEvent, BackendResult, ResultEvent } from "../claude/types.js";
import type { AgentWorkspace } from "../agents/workspace.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("cron-runner");

/**
 * Parsed frontmatter fields from an agent .md file.
 * Only fields relevant to the runner are extracted here.
 */
export interface AgentFrontmatter {
  /** Auto-submit this as the first user turn (Claude Code v2.1.83+). */
  initialPrompt?: string;
}

/** Parse YAML-like frontmatter from a --- block. Only supports simple key: value pairs. */
function parseFrontmatter(raw: string): AgentFrontmatter {
  const fm: AgentFrontmatter = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    const unquoted = val.replace(/^["']|["']$/g, "").trim();
    if (key === "initialPrompt") fm.initialPrompt = unquoted;
  }
  return fm;
}

/** Resolve a prompt string -- if it's a file path (.md), read the file. Otherwise return as-is.
 *
 * If the file has YAML frontmatter with `initialPrompt`, that value is used as the
 * effective prompt (Claude Code v2.1.83+ convention). Falls back to the body text.
 */
function resolvePrompt(prompt: string): string {
  if (!prompt) return prompt;
  const trimmed = prompt.trim();
  // Detect file paths: starts with / or ~ or ends with .md
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.endsWith(".md")) {
    const resolved = trimmed.startsWith("~") ? trimmed.replace("~", homedir()) : trimmed;
    if (existsSync(resolved)) {
      try {
        const content = readFileSync(resolved, "utf-8");
        // Parse YAML frontmatter if present
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (fmMatch) {
          const fm = parseFrontmatter(fmMatch[1]);
          // If initialPrompt is declared in frontmatter, use it as the active prompt.
          // This follows the Claude Code v2.1.83 convention where agent .md files can
          // embed their first-turn prompt directly without a wrapper script.
          if (fm.initialPrompt) return fm.initialPrompt;
          return fmMatch[2].trim();
        }
        return content.trim();
      } catch (e) {
        log.warn({ path: resolved }, "failed to read prompt file, using path as prompt");
      }
    }
  }
  return prompt;
}

export interface RunCronJobOptions {
  /** Optional agent workspace — when provided, the job gets a persistent workspace. */
  workspace?: AgentWorkspace;
  /**
   * Optional model hint — overrides the job's model when set.
   * Resolved via resolveModel() which applies complexity routing rules.
   * Values: "opus" | "sonnet" | "haiku" or full model IDs.
   */
  modelHint?: string;
}

/**
 * Resolve the effective model for a job run, applying complexity routing.
 *
 * Routing hierarchy (highest to lowest priority):
 *   1. Explicit modelHint (from task.model_hint)
 *   2. Job-level model override (job.model)
 *   3. Default config model
 *
 * Smart routing for tasks:
 *   - "opus"  → priority 1 tasks or tasks tagged "complex"
 *   - "haiku" → heartbeat/monitoring/extraction tasks (by tag or keyword)
 *   - "sonnet" → everything else (default)
 */
export function resolveModel(
  job: CronJobConfig,
  defaultConfig: ClaudeConfig,
  modelHint?: string,
): string | undefined {
  if (modelHint) return modelHint;
  return job.model ?? defaultConfig.model;
}

/**
 * Infer a model tier from task attributes (priority + tags).
 * Returns "opus", "haiku", or "sonnet" (default).
 *
 * Usage: pass the result as modelHint when calling runCronJob().
 */
export function inferModelFromTask(task: {
  priority?: number;
  tags?: string | null;
  title?: string;
  model_hint?: string | null;
}): string {
  // Explicit hint takes precedence
  if (task.model_hint) return task.model_hint;

  const priority = task.priority ?? 5;
  const tags = task.tags ? (JSON.parse(task.tags) as string[]) : [];
  const titleLower = (task.title ?? "").toLowerCase();

  // Priority 1 or "complex" tag → opus
  if (priority <= 1 || tags.includes("complex")) {
    return "opus";
  }

  // Heartbeat / monitoring / extraction keywords → haiku
  const haikuPatterns = ["heartbeat", "monitor", "extract", "ping", "health", "check", "poll"];
  if (
    tags.some((t) => haikuPatterns.some((p) => t.toLowerCase().includes(p))) ||
    haikuPatterns.some((p) => titleLower.includes(p))
  ) {
    return "haiku";
  }

  // Default: sonnet
  return "sonnet";
}

/** Detect OAuth token expiry errors from stderr or result text. */
function isAuthError(stderr: string, text: string): boolean {
  const combined = (stderr + " " + text).toLowerCase();
  return (
    combined.includes("oauth token has expired") ||
    combined.includes("401 unauthorized") ||
    (combined.includes("401") && combined.includes("authentication")) ||
    combined.includes("invalid api key") ||
    combined.includes("unauthenticated") ||
    combined.includes("does not have access to claude") ||
    combined.includes("please login again")
  );
}

/** Delay helper for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Create a git worktree for isolated agent execution. Returns null on failure. */
function createWorktree(workDir: string, jobId: string): WorktreeInfo | null {
  const timestamp = Date.now();
  const safeId = jobId.replace(/[^a-zA-Z0-9-]/g, "-");
  const branch = `agent/${safeId}/${timestamp}`;
  const worktreeDir = join(workDir, ".worktrees", `${safeId}-${timestamp}`);

  mkdirSync(join(workDir, ".worktrees"), { recursive: true });

  const result = spawnSync("git", ["worktree", "add", worktreeDir, "-b", branch], {
    cwd: workDir,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    log.warn({ jobId, stderr: result.stderr?.slice(0, 300) }, "failed to create git worktree");
    return null;
  }

  log.info({ jobId, worktreePath: worktreeDir, branch }, "created git worktree");
  return { path: worktreeDir, branch };
}

/** Merge and remove a worktree on success, or preserve it on failure. */
function cleanupWorktree(
  workDir: string,
  info: WorktreeInfo,
  success: boolean,
  jobId: string,
): void {
  if (!success) {
    log.info(
      { jobId, worktreePath: info.path, branch: info.branch },
      "preserving failed worktree for inspection",
    );
    return;
  }

  const merge = spawnSync(
    "git",
    ["merge", info.branch, "--no-ff", "-m", `Merge agent run: ${jobId}`],
    { cwd: workDir, encoding: "utf-8" },
  );

  if (merge.status !== 0) {
    log.error(
      { jobId, stderr: merge.stderr?.slice(0, 500), branch: info.branch },
      "failed to merge worktree branch — preserving for inspection",
    );
    return;
  }

  spawnSync("git", ["worktree", "remove", info.path, "--force"], { cwd: workDir });
  spawnSync("git", ["branch", "-d", info.branch], { cwd: workDir });
  log.info({ jobId, branch: info.branch }, "worktree merged and removed");
}

/**
 * Run a pre/post hook shell command in the given working directory.
 * Failures are logged as warnings and do not throw — hooks never block the main job.
 */
function runHook(cmd: string, workDir: string | undefined, jobId: string, phase: "pre" | "post"): void {
  log.info({ jobId, phase, cmd }, `running ${phase}_hook`);
  const result = spawnSync(cmd, {
    cwd: workDir,
    shell: true,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (result.status !== 0 || result.error) {
    log.warn(
      {
        jobId,
        phase,
        cmd,
        status: result.status,
        stderr: result.stderr?.slice(0, 300),
        error: result.error?.message,
      },
      `${phase}_hook failed — continuing`,
    );
  } else {
    log.debug({ jobId, phase, stdout: result.stdout?.slice(0, 200) }, `${phase}_hook succeeded`);
  }
}

/**
 * Resolve the absolute path to the claude CLI binary.
 *
 * When familiar runs as a system service (e.g. systemd), PATH is often minimal
 * and doesn't include ~/.local/bin where npm global installs live. We augment
 * PATH with common install locations and try to find the binary via `which`.
 *
 * Priority:
 *   1. Explicit claudeBin from config
 *   2. which claude (with augmented PATH)
 *   3. Fall back to "claude" and let the OS error naturally
 */
export function resolveClaudeBin(configured?: string): string {
  if (configured) return configured;

  // Build an augmented PATH with common install locations
  const home = homedir();
  const extraDirs = [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/usr/bin",
  ];

  // Also include any nvm-managed node bin dirs currently in PATH
  const currentPath = process.env.PATH ?? "";
  const nvmBinDirs = currentPath
    .split(delimiter)
    .filter((d) => d.includes(".nvm") || d.includes(".nodenv") || d.includes(".volta"));

  const augmentedPath = [...new Set([...extraDirs, ...nvmBinDirs, ...currentPath.split(delimiter)])]
    .filter(Boolean)
    .join(delimiter);

  const result = spawnSync("which", ["claude"], {
    env: { ...process.env, PATH: augmentedPath },
    encoding: "utf-8",
  });

  const resolved = result.stdout?.trim();
  if (resolved && existsSync(resolved)) {
    return resolved;
  }

  return "claude";
}

/** Force-remove a worktree without merging (e.g. auth errors with no useful content). */
function forceRemoveWorktree(workDir: string, info: WorktreeInfo, jobId: string): void {
  spawnSync("git", ["worktree", "remove", info.path, "--force"], { cwd: workDir });
  spawnSync("git", ["branch", "-D", info.branch], { cwd: workDir });
  log.debug({ jobId, branch: info.branch }, "force-removed empty worktree");
}

/** Run a cron job by spawning an isolated `claude -p` process. */
export async function runCronJob(
  job: CronJobConfig,
  defaultConfig: ClaudeConfig,
  options?: RunCronJobOptions,
  _isRetry = false,
): Promise<CronRunResult> {
  const startedAt = new Date();
  const model = resolveModel(job, defaultConfig, options?.modelHint);
  const workDir = job.workingDirectory ?? defaultConfig.workingDirectory;
  const maxTurns = job.maxTurns ?? defaultConfig.maxTurns ?? 25;

  // Validate workDir exists before attempting to spawn (non-existent cwd causes
  // Node.js to report ENOENT on the executable rather than the directory).
  if (workDir && (!existsSync(workDir) || !statSync(workDir).isDirectory())) {
    const errMsg = `working directory does not exist: ${workDir}`;
    log.error({ jobId: job.id, workDir }, errMsg);
    return {
      jobId: job.id,
      text: `Job failed: ${errMsg}`,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      isError: true,
      startedAt,
      finishedAt: new Date(),
    };
  }

  // Worktree isolation: create a fresh branch for this run
  let worktreeInfo: WorktreeInfo | null = null;
  let effectiveWorkDir = workDir;
  if (job.worktreeIsolation && workDir) {
    worktreeInfo = createWorktree(workDir, job.id);
    if (worktreeInfo) {
      effectiveWorkDir = worktreeInfo.path;
    }
  }

  // Execute pre_hook before anything else (runs in the original workDir, not the worktree)
  if (job.preHook) {
    runHook(job.preHook, workDir, job.id, "pre");
  }

  // Set up agent workspace if provided
  const workspace = options?.workspace;
  let workspacePrompt = "";
  if (workspace) {
    workspace.ensureWorkspace(job.id);
    workspace.recordRunStart(job.id);
    workspacePrompt = workspace.buildSystemPromptFragment(job.id);
  }

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose", // Required: stream-json with -p requires --verbose
    // Each cron run MUST be a fresh session. Without this flag, Claude resumes
    // a prior session and hallucinates "Already reported above" without doing
    // any work — this caused 12 wasted greenhouse-pipeline runs on 2026-02-22.
    "--no-session-persistence",
  ];

  if (model) {
    args.push("--model", model);
  }

  // Cron jobs are task-focused executors — do NOT inject the main session's
  // personality prompt. The main session persona causes cron agents to waste turns
  // reading governing docs (SOUL.md, IDENTITY.md, etc.) instead of executing
  // their actual task. Each cron job's prompt IS the system prompt.
  // Only pass the system prompt if the job explicitly opts in via systemPrompt field.
  //
  // When a workspace is available, we append the workspace prompt fragment so
  // the agent knows where its persistent state, memory, and output dirs live.
  {
    const parts: string[] = [];
    if (job.systemPrompt) parts.push(resolvePrompt(job.systemPrompt));
    if (workspacePrompt) parts.push(workspacePrompt);
    if (parts.length > 0) {
      args.push("--append-system-prompt", parts.join("\n\n"));
    }
  }

  // Per-agent tool override takes priority over default config.
  // Expand bare "Bash" to "Bash(*)" so all shell commands are pre-approved.
  // Without the wildcard, claude -p treats "Bash" as "tool available" but
  // still prompts for individual commands, which blocks headless agents.
  const effectiveTools = (job.allowedTools ?? defaultConfig.allowedTools)
    ?.map((t: string) => t === "Bash" ? "Bash(*)" : t);
  if (effectiveTools && effectiveTools.length > 0) {
    args.push("--allowedTools", effectiveTools.join(","));
  }

  args.push("--max-turns", String(maxTurns));

  // Per-agent MCP config override takes priority over default config
  const effectiveMcpConfig = job.mcpConfig ?? defaultConfig.mcpConfig;
  if (effectiveMcpConfig) {
    args.push("--mcp-config", effectiveMcpConfig);
  }

  // Only spawn with --chrome when the job needs browser access (default: true)
  if (job.chrome !== false) {
    args.push("--chrome");
  }

  // Per-run budget cap
  if (job.maxRunBudgetUsd) {
    args.push("--max-budget-usd", String(job.maxRunBudgetUsd));
  }

  log.info(
    { jobId: job.id, model, workDir: effectiveWorkDir, chrome: job.chrome !== false },
    "running cron job",
  );

  const claudeBin = resolveClaudeBin(defaultConfig.claudeBin);

  // Augment PATH so claude can find its own dependencies (node, etc.)
  const home = homedir();
  const extraDirs = [join(home, ".local", "bin"), "/usr/local/bin"];
  const currentPath = process.env.PATH ?? "";
  const augmentedPath = [...new Set([...extraDirs, ...currentPath.split(delimiter)])]
    .filter(Boolean)
    .join(delimiter);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath };
  delete env.CLAUDECODE;
  // Strip Anthropic and cloud provider credentials from all subprocess environments
  // (Bash tool, hooks, MCP stdio). Claude Code v2.1.83+ feature.
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  // Skip MCP connection wait in -p (print/headless) mode. Claude Code v2.1.89+.
  // --mcp-config server connections are still made but bounded at 5s.
  // Reduces startup latency for all cron agent invocations.
  env.MCP_CONNECTION_NONBLOCKING = "true";
  // Fail hung streams faster. Default is 90s; 30s is sufficient for cron agents
  // and keeps stuck jobs from blocking the queue. Claude Code v2.1.84+.
  env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = "30000";

  log.debug({ jobId: job.id, claudeBin }, "spawning claude");

  const proc = spawn(claudeBin, args, {
    cwd: effectiveWorkDir,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  // Capture spawn errors (e.g. ENOENT when claude binary is missing)
  // so they don't become uncaught exceptions.
  let spawnError: Error | null = null;
  proc.on("error", (err: Error) => {
    spawnError = err;
  });

  proc.stdin.write(resolvePrompt(job.prompt));
  proc.stdin.end();

  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const rl = createInterface({ input: proc.stdout });
  let result: BackendResult | null = null;
  let accumulatedText = "";
  // Track tool names used during the session for fallback summary
  const toolsUsed = new Set<string>();
  // Capture structured conversation log
  const logEntries: string[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }

    // Capture all events for the run log (skip raw deltas to keep size reasonable)
    if (event.type !== "content_block_delta") {
      logEntries.push(line);
    }

    switch (event.type) {
      case "content_block_start":
        if (event.content_block?.type === "tool_use" && event.content_block.name) {
          toolsUsed.add(event.content_block.name);
        }
        break;

      case "content_block_delta":
        if (event.delta?.type === "text_delta" && event.delta.text) {
          accumulatedText += event.delta.text;
        }
        break;

      case "assistant":
        // In stream-json piped mode, text comes via assistant message content
        // blocks (content_block_delta events are never emitted). Always extract.
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              accumulatedText += block.text;
            }
            if (block.type === "tool_use" && block.name) {
              toolsUsed.add(block.name);
            }
          }
        }
        break;

      case "result":
        result = parseResult(event as ResultEvent);
        break;
    }
  }

  const runLog = logEntries.join("\n");

  // If spawn failed (ENOENT etc.), short-circuit with an error result
  if (spawnError !== null) {
    const err = spawnError as Error;
    const finishedAt = new Date();
    log.error({ jobId: job.id, claudeBin, err }, "failed to spawn claude process");
    return {
      jobId: job.id,
      text: `Failed to spawn claude (${claudeBin}): ${err.message}`,
      costUsd: 0,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      numTurns: 0,
      isError: true,
      startedAt,
      finishedAt,
    };
  }

  const exitCode = await waitForExit(proc);
  const finishedAt = new Date();

  if (!result) {
    if (exitCode !== 0) {
      log.error({ jobId: job.id, exitCode, stderr: stderr.slice(0, 500) }, "cron job failed");
      result = {
        text: accumulatedText || `Cron job exited with code ${exitCode}: ${stderr.slice(0, 200)}`,
        sessionId: "",
        costUsd: 0,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        numTurns: 0,
        isError: true,
      };
    } else {
      result = {
        text: accumulatedText,
        sessionId: "",
        costUsd: 0,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        numTurns: 0,
        isError: false,
      };
    }
  }

  // Save run output to workspace
  if (workspace) {
    try {
      const outputDir = workspace.getOutputDir(job.id);
      const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
      const outputFile = join(outputDir, `run-${timestamp}.txt`);
      // Prefer accumulatedText (all turns) over result.text (final turn only)
      const outputText = accumulatedText || result.text;
      writeFileSync(outputFile, outputText, "utf-8");

      // Update state with latest run metadata
      workspace.setState(job.id, {
        data: {
          lastRunCost: result.costUsd,
          lastRunTurns: result.numTurns,
          lastRunError: result.isError ? result.text || "unknown error" : undefined,
        },
      });
    } catch (e) {
      log.warn({ jobId: job.id, err: e }, "failed to save workspace output");
    }
  }

  log.info(
    {
      jobId: job.id,
      cost: result.costUsd,
      duration: result.durationMs,
      turns: result.numTurns,
      isError: result.isError,
      responseLen: (accumulatedText || result.text).length,
    },
    "cron job complete",
  );

  // Execute post_hook after main job finishes (runs in the original workDir)
  if (job.postHook) {
    runHook(job.postHook, workDir, job.id, "post");
  }

  // Build final text. When both accumulatedText and result.text are empty
  // (common in tool-heavy sessions), generate a fallback summary so the
  // delivery message isn't blank.
  let finalText = accumulatedText || result.text;
  if (!finalText && (result.numTurns > 0 || toolsUsed.size > 0)) {
    const parts = [`Session completed (${result.numTurns} turns)`];
    if (toolsUsed.size > 0) {
      parts.push(`tools: ${[...toolsUsed].join(", ")}`);
    }
    finalText = parts.join(" -- ");
  }

  // Retry once on auth errors (OAuth token expired). The Claude CLI should auto-refresh,
  // but if the refresh was slow or the token just refreshed, a 30s delay + retry often works.
  if (result.isError && !_isRetry && isAuthError(stderr, finalText)) {
    log.warn({ jobId: job.id }, "auth error detected — waiting 30s then retrying once");
    // Auth error: agent did no real work, force-remove worktree before retry
    if (worktreeInfo && workDir) {
      forceRemoveWorktree(workDir, worktreeInfo, job.id);
    }
    await sleep(30_000);
    return runCronJob(job, defaultConfig, options, true);
  }

  // Merge or preserve worktree
  if (worktreeInfo && workDir) {
    cleanupWorktree(workDir, worktreeInfo, !result.isError, job.id);
  }

  return {
    jobId: job.id,
    // Prefer accumulatedText (captures all turns) over result.text (final turn only).
    // For multi-turn sessions, result.text from the result event only contains the
    // last assistant message. accumulatedText has text from every turn.
    text: finalText,
    costUsd: result.costUsd,
    // Use wall-clock time rather than Claude's internal timer. Claude's duration_ms
    // only covers API latency and excludes subprocess wait time (e.g. when an agent
    // runs `npm run agents:extract` and waits 20 min for the script to finish, Claude
    // reports ~5s while the actual job took 20 minutes).
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    numTurns: result.numTurns,
    isError: result.isError,
    startedAt,
    finishedAt,
    runLog,
  };
}

function parseResult(event: ResultEvent): BackendResult {
  return {
    text: event.result ?? "",
    sessionId: event.session_id ?? "",
    // Claude CLI emits total_cost_usd (not cost_usd) in stream-json output
    costUsd: event.total_cost_usd ?? event.cost_usd ?? 0,
    durationMs: event.duration_ms ?? 0,
    numTurns: event.num_turns ?? 0,
    isError: event.is_error ?? false,
  };
}

function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
      return;
    }
    proc.on("close", (code) => resolve(code ?? 1));
  });
}
