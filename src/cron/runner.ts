import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { CronJobConfig, CronRunResult } from "./types.js";
import type { ClaudeConfig } from "../config.js";
import type { StreamEvent, BackendResult, ResultEvent } from "../claude/types.js";
import type { AgentWorkspace } from "../agents/workspace.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("cron-runner");

/** Resolve a prompt string -- if it's a file path (.md), read the file. Otherwise return as-is. */
function resolvePrompt(prompt: string): string {
  if (!prompt) return prompt;
  const trimmed = prompt.trim();
  // Detect file paths: starts with / or ~ or ends with .md
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.endsWith(".md")) {
    const resolved = trimmed.startsWith("~") ? trimmed.replace("~", homedir()) : trimmed;
    if (existsSync(resolved)) {
      try {
        const content = readFileSync(resolved, "utf-8");
        // Strip YAML frontmatter if present
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        return fmMatch ? fmMatch[2].trim() : content.trim();
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
}

/** Run a cron job by spawning an isolated `claude -p` process. */
export async function runCronJob(
  job: CronJobConfig,
  defaultConfig: ClaudeConfig,
  options?: RunCronJobOptions,
): Promise<CronRunResult> {
  const startedAt = new Date();
  const model = job.model ?? defaultConfig.model;
  const workDir = job.workingDirectory ?? defaultConfig.workingDirectory;
  const maxTurns = job.maxTurns ?? defaultConfig.maxTurns ?? 25;

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
    "--verbose",
    // Each cron run MUST be a fresh session. Without this flag, Claude resumes
    // a prior session and hallucinates "Already reported above" without doing
    // any work — this caused 12 wasted greenhouse-pipeline runs on 2026-02-22.
    "--no-session-persistence",
  ];

  if (model) {
    args.push("--model", model);
  }

  // Cron jobs are task-focused executors — do NOT inject the main session's
  // personality prompt. The Oliver persona causes cron agents to waste turns
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

  if (defaultConfig.allowedTools && defaultConfig.allowedTools.length > 0) {
    args.push("--allowedTools", defaultConfig.allowedTools.join(","));
  }

  args.push("--max-turns", String(maxTurns));

  if (defaultConfig.mcpConfig) {
    args.push("--mcp-config", defaultConfig.mcpConfig);
  }

  // Give cron agents access to Chrome for cookie extraction, web interaction, etc.
  args.push("--chrome");

  log.info({ jobId: job.id, model, workDir }, "running cron job");

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = spawn("claude", args, {
    cwd: workDir,
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
  // Track streaming text captured since the last assistant event. Used to
  // decide whether to fall back to the assistant message's text blocks when
  // no streaming deltas arrived for a given turn (e.g. piped/non-TTY mode).
  let deltasSinceLastAssistant = "";

  for await (const line of rl) {
    if (!line.trim()) continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case "content_block_delta":
        if (event.delta?.type === "text_delta" && event.delta.text) {
          accumulatedText += event.delta.text;
          deltasSinceLastAssistant += event.delta.text;
        }
        break;

      case "assistant":
        // If no streaming deltas arrived for this turn, extract text from the
        // full assistant message. This handles both non-streaming modes and
        // turns where Claude produced text that wasn't captured via deltas.
        if (!deltasSinceLastAssistant && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              accumulatedText += block.text;
            }
          }
        }
        // Reset per-turn tracker for the next turn.
        deltasSinceLastAssistant = "";
        break;

      case "result":
        result = parseResult(event as ResultEvent);
        break;
    }
  }

  // If spawn failed (ENOENT etc.), short-circuit with an error result
  if (spawnError !== null) {
    const err = spawnError as Error;
    const finishedAt = new Date();
    log.error({ jobId: job.id, err }, "failed to spawn claude process");
    return {
      jobId: job.id,
      text: `Failed to spawn claude: ${err.message}`,
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

  return {
    jobId: job.id,
    // Prefer accumulatedText (captures all turns) over result.text (final turn only).
    // For multi-turn sessions, result.text from the result event only contains the
    // last assistant message. accumulatedText has text from every turn.
    text: accumulatedText || result.text,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    isError: result.isError,
    startedAt,
    finishedAt,
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
