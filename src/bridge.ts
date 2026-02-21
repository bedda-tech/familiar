import type { Channel, IncomingMessage } from "./channels/types.js";
import type { ClaudeCLI, ClaudeRequest } from "./claude/cli.js";
import type { SessionStore } from "./session/store.js";
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
  constructor(
    private channel: Channel,
    private claude: ClaudeCLI,
    private sessions: SessionStore,
  ) {}

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

    // Handle /model — just inform, model is set in config
    this.channel.onCommand("model", async (msg) => {
      const text = msg.text.trim();
      if (text) {
        await this.channel.sendText(
          msg.chatId,
          `Model switching at runtime is not yet supported. Edit your config file to change the model.`,
          msg.replyContext,
        );
      } else {
        await this.channel.sendText(
          msg.chatId,
          `Model is configured in ~/.familiar/config.json`,
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
      { chatId: msg.chatId, textLen: msg.text.length, files: msg.filePaths?.length ?? 0 },
      "incoming message",
    );

    // Look up session
    const sessionId = this.sessions.getSession(msg.chatId);

    const request: ClaudeRequest = {
      prompt: msg.text,
      sessionId: sessionId ?? undefined,
      filePaths: msg.filePaths,
    };

    // Log the user message
    this.sessions.logMessage(msg.chatId, "user", msg.text);

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
    const stopTyping = this.channel.startTyping(msg.chatId);

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
            if (event.text.length > 0) {
              const preview = event.text.length > 3000
                ? event.text.slice(0, 3000) + "..."
                : event.text;
              await this.channel.sendDirectMessage(
                msg.chatId,
                `_${preview.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&")}_`,
              );
            }
            break;

          case "tool_use":
            toolsUsed.push(event.name);
            log.debug({ tool: event.name }, "tool use");
            break;

          case "done": {
            const { result } = event;

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
