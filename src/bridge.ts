import type { Channel, IncomingMessage } from "./channels/types.js";
import type { ClaudeCLI, ClaudeRequest } from "./claude/cli.js";
import type { SessionStore } from "./session/store.js";
import type { OpenAIConfig } from "./config.js";
import { transcribeAudio } from "./voice/transcribe.js";
import { chunkMessage } from "./streaming/chunker.js";
import {
  createDraft,
  appendToDraft,
  finalizeDraft,
  type DraftContext,
} from "./streaming/draft.js";
import { getLogger } from "./util/logger.js";

const log = getLogger("bridge");

export class Bridge {
  private showThinking = true;
  private openai: OpenAIConfig | undefined;

  constructor(
    private channel: Channel,
    private claude: ClaudeCLI,
    private sessions: SessionStore,
    openai?: OpenAIConfig,
  ) {
    this.openai = openai;
  }

  /** Wire up the channel to the Claude backend */
  start(): void {
    // Handle regular messages
    this.channel.onMessage(async (msg) => {
      await this.handleMessage(msg);
    });

    // Handle /new — fresh session
    this.channel.onCommand("new", async (msg) => {
      this.sessions.clearSession(msg.chatId);
      await this.channel.sendText(msg.chatId, "Session cleared. Next message starts a fresh conversation.", msg.replyContext);
    });

    // Handle /status — session info
    this.channel.onCommand("status", async (msg) => {
      const info = this.sessions.getSessionInfo(msg.chatId);
      if (!info) {
        await this.channel.sendText(msg.chatId, "No active session.", msg.replyContext);
        return;
      }
      const status = [
        `*Session Info*`,
        `ID: \`${info.sessionId.slice(0, 8)}...\``,
        `Messages: ${info.messageCount}`,
        `Started: ${info.createdAt}`,
        `Last used: ${info.lastUsedAt}`,
      ].join("\n");
      await this.channel.sendText(msg.chatId, status, msg.replyContext);
    });

    // Handle /model — switch model at runtime or show current
    this.channel.onCommand("model", async (msg) => {
      const requested = msg.text.trim().toLowerCase();
      if (requested) {
        const valid = ["opus", "sonnet", "haiku"];
        if (valid.includes(requested)) {
          this.claude.setModel(requested);
          await this.channel.sendText(
            msg.chatId,
            `Model switched to *${requested}*. Use \`/model\` to check, or \`/model reset\` to revert to config default.`,
            msg.replyContext,
          );
        } else if (requested === "reset") {
          this.claude.setModel(null);
          await this.channel.sendText(
            msg.chatId,
            `Model reverted to config default: *${this.claude.getModel()}*`,
            msg.replyContext,
          );
        } else {
          await this.channel.sendText(
            msg.chatId,
            `Unknown model: ${requested}\nAvailable: opus, sonnet, haiku\nUse \`/model reset\` to revert to config default.`,
            msg.replyContext,
          );
        }
      } else {
        await this.channel.sendText(
          msg.chatId,
          `Current model: *${this.claude.getModel()}*\nUsage: \`/model opus\`, \`/model sonnet\`, \`/model haiku\`, \`/model reset\``,
          msg.replyContext,
        );
      }
    });

    // Handle /cost — show usage costs
    this.channel.onCommand("cost", async (msg) => {
      const summary = this.sessions.getCostSummary(msg.chatId);
      const fmt = (n: number) => `$${n.toFixed(4)}`;
      const text = [
        `*Usage Costs*`,
        ``,
        `Session: ${fmt(summary.session.cost)} (${summary.session.messages} msgs)`,
        `Today: ${fmt(summary.today.cost)} (${summary.today.messages} msgs)`,
        `Last 24h: ${fmt(summary.last24h)}`,
        `All time: ${fmt(summary.allTime.cost)} (${summary.allTime.messages} msgs)`,
      ].join("\n");
      await this.channel.sendText(msg.chatId, text, msg.replyContext);
    });

    // Handle /thinking — toggle thinking block display
    this.channel.onCommand("thinking", async (msg) => {
      const arg = msg.text.trim().toLowerCase();
      if (arg === "on") {
        this.showThinking = true;
        await this.channel.sendText(msg.chatId, "Thinking blocks *enabled*. You'll see reasoning before responses.", msg.replyContext);
      } else if (arg === "off") {
        this.showThinking = false;
        await this.channel.sendText(msg.chatId, "Thinking blocks *disabled*.", msg.replyContext);
      } else {
        const state = this.showThinking ? "ON" : "OFF";
        await this.channel.sendText(
          msg.chatId,
          `Thinking display: *${state}*\nUsage: \`/thinking on\`, \`/thinking off\``,
          msg.replyContext,
        );
      }
    });

    log.info("bridge wired up");
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    if (!msg.text && (!msg.filePaths || msg.filePaths.length === 0)) {
      return;
    }

    log.info(
      { chatId: msg.chatId, textLen: msg.text.length, files: msg.filePaths?.length ?? 0, isVoice: msg.isVoice },
      "incoming message",
    );

    // Transcribe voice messages if OpenAI is configured
    let prompt = msg.text;
    if (msg.isVoice && msg.filePaths?.length && this.openai) {
      try {
        const transcription = await transcribeAudio(msg.filePaths[0], this.openai);
        prompt = transcription;
        // Show transcription to user
        await this.channel.sendDirectMessage(msg.chatId, `_Voice: ${transcription}_`);
        // Don't pass audio file to Claude — the transcription is the prompt
        msg.filePaths = undefined;
      } catch (e) {
        log.error({ err: e }, "voice transcription failed");
        await this.channel.sendDirectMessage(
          msg.chatId,
          "Voice transcription failed. Sending audio file to Claude directly.",
        );
      }
    }

    // Look up session
    const sessionId = this.sessions.getSession(msg.chatId);

    const request: ClaudeRequest = {
      prompt,
      sessionId: sessionId ?? undefined,
      filePaths: msg.filePaths,
    };

    // Log the user message
    this.sessions.logMessage(msg.chatId, "user", prompt);

    // Set up draft streaming
    const draft = createDraft();
    const draftCtx: DraftContext = {
      reply: async (text) => {
        const handle = await this.channel.sendDraft(msg.chatId, text, msg.replyContext);
        return handle.messageId ?? 0;
      },
      edit: async (messageId, text) => {
        await this.channel.updateDraft({ messageId, chatId: msg.chatId }, text);
      },
      sendChunks: async (chunks) => {
        await this.channel.sendChunks(msg.chatId, chunks, msg.replyContext);
      },
    };

    // Show typing indicator while Claude is processing
    let stopTyping = this.channel.startTyping(msg.chatId);

    // Stream response from Claude
    let fullText = "";
    let toolsUsed: string[] = [];
    let typingStopped = false;

    try {
      for await (const event of this.claude.send(request)) {
        switch (event.type) {
          case "text_delta":
            if (!typingStopped) {
              stopTyping();
              typingStopped = true;
            }
            fullText += event.text;
            await appendToDraft(draft, draftCtx, event.text);
            break;

          case "thinking":
            // Send thinking as a separate message in italics
            if (this.showThinking && event.text.length > 0) {
              const preview = event.text.length > 3000
                ? event.text.slice(0, 3000) + "..."
                : event.text;
              // Escape for Telegram Markdown v1: only _ * ` [ need escaping
              const escaped = preview.replace(/[_*`\[]/g, "\\$&");
              await this.channel.sendDirectMessage(
                msg.chatId,
                `_${escaped}_`,
              );
            }
            break;

          case "tool_use":
            toolsUsed.push(event.name);
            log.debug({ tool: event.name }, "tool use");
            // Show tool usage to the user
            await this.channel.sendDirectMessage(
              msg.chatId,
              `\`${event.name}\``,
            );
            // Restart typing during tool execution
            if (typingStopped) {
              stopTyping = this.channel.startTyping(msg.chatId);
              typingStopped = false;
            }
            break;

          case "done": {
            const { result } = event;
            // Stop typing if still active
            if (!typingStopped) {
              stopTyping();
              typingStopped = true;
            }

            // Store/update session
            if (result.sessionId) {
              if (sessionId && sessionId === result.sessionId) {
                this.sessions.touchSession(msg.chatId);
              } else {
                this.sessions.upsertSession(msg.chatId, result.sessionId);
              }
            }

            // Use the final text from result if we got nothing from streaming
            const responseText = fullText || result.text;

            // Log assistant response
            this.sessions.logMessage(msg.chatId, "assistant", responseText, result.costUsd);

            // Finalize the draft
            const chunks = chunkMessage(responseText);
            await finalizeDraft(draft, draftCtx, chunks);

            if (result.isError) {
              log.warn({ chatId: msg.chatId, error: result.text.slice(0, 200) }, "claude returned error");
            } else {
              log.info(
                {
                  chatId: msg.chatId,
                  cost: result.costUsd,
                  duration: result.durationMs,
                  turns: result.numTurns,
                  tools: toolsUsed,
                  responseLen: responseText.length,
                },
                "response complete",
              );
            }
            break;
          }
        }
      }
    } catch (e) {
      stopTyping();
      log.error({ err: e, chatId: msg.chatId }, "error processing message");
      const errorText = `Error: ${e instanceof Error ? e.message : "Unknown error"}\n\nTry /new to start a fresh session.`;
      const chunks = chunkMessage(errorText);
      await finalizeDraft(draft, draftCtx, chunks);
    }
  }
}
