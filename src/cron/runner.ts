import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { CronJobConfig, CronRunResult } from "./types.js";
import type { ClaudeConfig } from "../config.js";
import type { StreamEvent, BackendResult, ResultEvent } from "../claude/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("cron-runner");

/** Run a cron job by spawning an isolated `claude -p` process. */
export async function runCronJob(
  job: CronJobConfig,
  defaultConfig: ClaudeConfig,
): Promise<CronRunResult> {
  const startedAt = new Date();
  const model = job.model ?? defaultConfig.model;
  const workDir = job.workingDirectory ?? defaultConfig.workingDirectory;
  const maxTurns = job.maxTurns ?? defaultConfig.maxTurns ?? 25;

  const args = ["-p", "--output-format", "stream-json", "--verbose"];

  if (model) {
    args.push("--model", model);
  }

  // Cron jobs are task-focused executors — do NOT inject the main session's
  // personality prompt. The Oliver persona causes cron agents to waste turns
  // reading governing docs (SOUL.md, IDENTITY.md, etc.) instead of executing
  // their actual task. Each cron job's prompt IS the system prompt.
  // Only pass the system prompt if the job explicitly opts in via systemPrompt field.
  if (job.systemPrompt) {
    args.push("--append-system-prompt", job.systemPrompt);
  }

  if (defaultConfig.allowedTools && defaultConfig.allowedTools.length > 0) {
    args.push("--allowedTools", defaultConfig.allowedTools.join(","));
  }

  args.push("--max-turns", String(maxTurns));

  if (defaultConfig.mcpConfig) {
    args.push("--mcp-config", defaultConfig.mcpConfig);
  }

  log.info({ jobId: job.id, model, workDir }, "running cron job");

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = spawn("claude", args, {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  proc.stdin.write(job.prompt);
  proc.stdin.end();

  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const rl = createInterface({ input: proc.stdout });
  let result: BackendResult | null = null;
  let accumulatedText = "";

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
        }
        break;

      case "assistant":
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              if (!accumulatedText.includes(block.text)) {
                accumulatedText += block.text;
              }
            }
          }
        }
        break;

      case "result":
        result = parseResult(event as ResultEvent);
        break;
    }
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

  log.info(
    {
      jobId: job.id,
      cost: result.costUsd,
      duration: result.durationMs,
      turns: result.numTurns,
      isError: result.isError,
      responseLen: (result.text || accumulatedText).length,
    },
    "cron job complete",
  );

  return {
    jobId: job.id,
    text: result.text || accumulatedText,
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
    costUsd: event.cost_usd ?? 0,
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
