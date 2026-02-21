import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClaudeConfig } from "../config.js";
import type {
  StreamEvent,
  StreamYield,
  BackendResult,
  ResultEvent,
} from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("claude-cli");

export interface ClaudeRequest {
  prompt: string;
  sessionId?: string;
  filePaths?: string[];
}

export class ClaudeCLI {
  constructor(private config: ClaudeConfig) {}

  /**
   * Send a message to Claude via `claude -p` and stream back results.
   * Yields TextDelta events as text arrives, and a final StreamDone with the result.
   */
  async *send(request: ClaudeRequest): AsyncGenerator<StreamYield> {
    const args = this.buildArgs(request);
    const prompt = this.buildPrompt(request);

    log.info({ sessionId: request.sessionId, prompt: prompt.slice(0, 100) }, "spawning claude");
    log.debug({ args }, "claude args");

    const proc = spawn("claude", args, {
      cwd: this.config.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnv(),
    });

    // Write prompt to stdin and close
    proc.stdin.write(prompt);
    proc.stdin.end();

    // Collect stderr for error reporting
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Parse NDJSON from stdout
    const rl = createInterface({ input: proc.stdout });

    let result: BackendResult | null = null;
    let accumulatedText = "";

    for await (const line of rl) {
      if (!line.trim()) continue;

      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        log.warn({ line: line.slice(0, 200) }, "failed to parse stream-json line");
        continue;
      }

      switch (event.type) {
        case "content_block_delta":
          if (event.delta?.type === "text_delta" && event.delta.text) {
            accumulatedText += event.delta.text;
            yield { type: "text_delta", text: event.delta.text };
          }
          break;

        case "content_block_start":
          if (event.content_block?.type === "tool_use" && event.content_block.name) {
            yield { type: "tool_use", name: event.content_block.name };
          }
          break;

        case "assistant":
          // Full assistant message — extract text and thinking from content blocks
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "thinking" && block.thinking) {
                yield { type: "thinking", text: block.thinking };
              } else if (block.type === "text" && block.text) {
                // Only yield if we haven't already streamed this text via deltas
                if (!accumulatedText.includes(block.text)) {
                  accumulatedText += block.text;
                  yield { type: "text_delta", text: block.text };
                }
              }
            }
          }
          break;

        case "result":
          result = this.parseResult(event);
          break;

        case "system":
          log.debug({ subtype: event.subtype, message: event.message }, "system event");
          break;
      }
    }

    // Wait for process to exit
    const exitCode = await waitForExit(proc);

    if (!result) {
      // If no result event, construct one from accumulated text
      if (exitCode !== 0) {
        log.error({ exitCode, stderr: stderr.slice(0, 500) }, "claude exited with error");
        result = {
          text: accumulatedText || `Claude exited with code ${exitCode}: ${stderr.slice(0, 200)}`,
          sessionId: "",
          costUsd: 0,
          durationMs: 0,
          numTurns: 0,
          isError: true,
        };
      } else {
        result = {
          text: accumulatedText,
          sessionId: "",
          costUsd: 0,
          durationMs: 0,
          numTurns: 0,
          isError: false,
        };
      }
    }

    // If we got no text from streaming, use the result text
    if (!accumulatedText && result.text) {
      yield { type: "text_delta", text: result.text };
    }

    yield { type: "done", result };
  }

  private buildArgs(request: ClaudeRequest): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    if (request.sessionId) {
      args.push("--resume", request.sessionId);
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    if (this.config.systemPrompt) {
      args.push("--append-system-prompt", this.config.systemPrompt);
    }

    if (this.config.allowedTools && this.config.allowedTools.length > 0) {
      args.push("--allowedTools", this.config.allowedTools.join(","));
    }

    if (this.config.maxTurns) {
      args.push("--max-turns", String(this.config.maxTurns));
    }

    return args;
  }

  private buildPrompt(request: ClaudeRequest): string {
    let prompt = request.prompt;

    if (request.filePaths && request.filePaths.length > 0) {
      const fileList = request.filePaths
        .map((p) => `- ${p}`)
        .join("\n");
      prompt += `\n\nThe user also sent these files. Read them if relevant:\n${fileList}`;
    }

    return prompt;
  }

  private parseResult(event: ResultEvent): BackendResult {
    return {
      text: event.result ?? "",
      sessionId: event.session_id ?? "",
      costUsd: event.cost_usd ?? 0,
      durationMs: event.duration_ms ?? 0,
      numTurns: event.num_turns ?? 0,
      isError: event.is_error ?? false,
    };
  }
}

/** Strip env vars that prevent claude from running inside another Claude Code session. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
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
