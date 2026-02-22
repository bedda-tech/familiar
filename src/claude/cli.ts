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

/** Default failover chain: try opus, fall back to sonnet, then haiku */
const DEFAULT_FAILOVER = ["opus", "sonnet", "haiku"];

export class ClaudeCLI {
  private modelOverride: string | null = null;
  private failoverChain: string[] = DEFAULT_FAILOVER;

  constructor(private config: ClaudeConfig) {
    if (config.failoverChain?.length) {
      this.failoverChain = config.failoverChain;
    }
  }

  /** Override the model at runtime. Pass null to revert to config default. */
  setModel(model: string | null): void {
    this.modelOverride = model;
  }

  /** Get the currently active model (override or config default). */
  getModel(): string {
    return this.modelOverride ?? this.config.model ?? "sonnet";
  }

  /** Get failover models after the current model */
  private getFailoverModels(): string[] {
    const current = this.getModel();
    const idx = this.failoverChain.indexOf(current);
    if (idx < 0) return this.failoverChain.filter((m) => m !== current);
    return this.failoverChain.slice(idx + 1);
  }

  /**
   * Send with model failover — tries current model, falls back through chain on failure.
   * Only fails over if the model errors before producing any content.
   */
  async *send(request: ClaudeRequest): AsyncGenerator<StreamYield> {
    const models = [this.getModel(), ...this.getFailoverModels()];

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const isLast = i === models.length - 1;
      let hasContent = false;

      for await (const event of this.sendOnce(request, model)) {
        if (event.type === "text_delta" || event.type === "thinking") {
          hasContent = true;
        }

        // If error with no content and more models to try, failover
        if (event.type === "done" && event.result.isError && !hasContent && !isLast) {
          log.warn({ model, nextModel: models[i + 1] }, "model failed, trying failover");
          break; // Try next model
        }

        yield event;

        if (event.type === "done") return;
      }
    }
  }

  /** Send a message to a specific model. Core implementation. */
  private async *sendOnce(request: ClaudeRequest, model: string): AsyncGenerator<StreamYield> {
    const args = this.buildArgs(request, model);
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

    // Track thinking blocks being streamed via content_block_delta
    const thinkingBlocks = new Set<number>();
    let thinkingBuffer = "";
    const yieldedThinking = new Set<string>(); // Dedup against assistant event

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
          } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
            thinkingBuffer += event.delta.thinking;
          }
          break;

        case "content_block_start":
          if (event.content_block?.type === "tool_use" && event.content_block.name) {
            yield { type: "tool_use", name: event.content_block.name };
          } else if (event.content_block?.type === "thinking") {
            thinkingBlocks.add(event.index);
            thinkingBuffer = "";
          }
          break;

        case "content_block_stop":
          if (thinkingBlocks.has(event.index) && thinkingBuffer.length > 0) {
            yield { type: "thinking", text: thinkingBuffer };
            yieldedThinking.add(thinkingBuffer.slice(0, 100));
            thinkingBlocks.delete(event.index);
            thinkingBuffer = "";
          }
          break;

        case "assistant":
          // Full assistant message — extract text and thinking from content blocks
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "thinking" && block.thinking) {
                // Only yield if we didn't already stream this thinking block
                if (!yieldedThinking.has(block.thinking.slice(0, 100))) {
                  yield { type: "thinking", text: block.thinking };
                }
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
          yield { type: "system", subtype: event.subtype, message: event.message };
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

  private buildArgs(request: ClaudeRequest, model: string): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    if (request.sessionId) {
      args.push("--resume", request.sessionId);
    }

    args.push("--model", model);

    if (this.config.systemPrompt) {
      args.push("--append-system-prompt", this.config.systemPrompt);
    }

    if (this.config.allowedTools && this.config.allowedTools.length > 0) {
      args.push("--allowedTools", this.config.allowedTools.join(","));
    }

    if (this.config.maxTurns) {
      args.push("--max-turns", String(this.config.maxTurns));
    }

    if (this.config.mcpConfig) {
      args.push("--mcp-config", this.config.mcpConfig);
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
