/**
 * DashboardChannel -- bridges the web dashboard chat UI to the Bridge/Claude backend.
 *
 * Incoming: WebSocket messages `{ type: "chat:send", text: string }` from dashboard clients.
 * Outgoing: WebSocket events `chat:draft` (streaming) and `chat:message` (final).
 *
 * chatId format: "dash:<clientId>" — keeps dashboard sessions isolated from Telegram sessions.
 */

import { randomUUID } from "node:crypto";
import type { Channel, IncomingMessage, DraftHandle } from "./types.js";
import type { WsServer } from "../ws/server.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("dashboard-channel");

export class DashboardChannel implements Channel {
  private messageHandlers: Array<(msg: IncomingMessage) => Promise<void>> = [];
  private commandHandlers = new Map<string, (msg: IncomingMessage) => Promise<void>>();

  // Timer to auto-finalize single-chunk responses (finalizeDraft calls updateDraft, not sendChunks)
  private doneTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private wsServer: WsServer) {
    // Wire incoming WebSocket messages from dashboard clients
    wsServer.onMessage((clientId, raw) => {
      if (raw.type !== "chat:send" || typeof raw.text !== "string" || !raw.text.trim()) return;

      const text = raw.text.trim();
      const chatId = `dash:${clientId}`;

      // Echo user message to all dashboard clients so multiple tabs stay in sync
      wsServer.broadcast({ type: "chat:message", role: "user", text });

      // Dispatch command or message
      if (text.startsWith("/")) {
        const spaceIdx = text.indexOf(" ");
        const command = (spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1)).toLowerCase();
        const rest = spaceIdx > 0 ? text.slice(spaceIdx + 1) : "";
        const handler = this.commandHandlers.get(command);
        if (handler) {
          const msg: IncomingMessage = { chatId, userId: clientId, text: rest, replyContext: clientId };
          void handler(msg);
          return;
        }
      }

      const msg: IncomingMessage = { chatId, userId: clientId, text, replyContext: clientId };
      for (const handler of this.messageHandlers) {
        void handler(msg);
      }
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onCommand(command: string, handler: (msg: IncomingMessage) => Promise<void>): void {
    this.commandHandlers.set(command, handler);
  }

  async sendDraft(chatId: string, text: string, _replyContext: unknown): Promise<DraftHandle> {
    this.wsServer.broadcast({ type: "chat:draft", text, done: false });
    this.scheduleAutoDone(chatId, text);
    return { messageId: 1, chatId };
  }

  async updateDraft(handle: DraftHandle, text: string): Promise<void> {
    this.wsServer.broadcast({ type: "chat:draft", text, done: false });
    this.scheduleAutoDone(handle.chatId, text);
  }

  async sendChunks(chatId: string, chunks: string[], _replyContext: unknown): Promise<void> {
    this.clearAutoDone(chatId);
    for (const chunk of chunks) {
      this.wsServer.broadcast({ type: "chat:message", role: "assistant", text: chunk });
    }
    this.wsServer.broadcast({ type: "chat:draft", text: "", done: true });
  }

  async sendText(chatId: string, text: string, _replyContext: unknown): Promise<void> {
    this.clearAutoDone(chatId);
    this.wsServer.broadcast({ type: "chat:message", role: "assistant", text });
    this.wsServer.broadcast({ type: "chat:draft", text: "", done: true });
  }

  startTyping(_chatId: string): () => void {
    // Draft streaming shows progress; typing indicator is a no-op for dashboard
    return () => {};
  }

  async sendDirectMessage(_chatId: string, text: string): Promise<void> {
    this.wsServer.broadcast({ type: "chat:message", role: "assistant", text });
  }

  async sendFile(_chatId: string, filePath: string, caption?: string): Promise<void> {
    const text = caption ? `${caption}\n[File: ${filePath}]` : `[File: ${filePath}]`;
    this.wsServer.broadcast({ type: "chat:message", role: "assistant", text });
  }

  async start(): Promise<void> {
    log.info("dashboard channel started");
  }

  async stop(): Promise<void> {
    for (const timer of this.doneTimers.values()) {
      clearTimeout(timer);
    }
    this.doneTimers.clear();
    log.info("dashboard channel stopped");
  }

  /**
   * When finalizeDraft uses the edit path (single chunk, < 4000 chars), it calls updateDraft
   * with the final text but never calls sendChunks. Schedule a done signal after a short
   * idle window so the UI can lock the streaming bubble into a final message.
   */
  private scheduleAutoDone(chatId: string, finalText: string): void {
    this.clearAutoDone(chatId);
    this.doneTimers.set(
      chatId,
      setTimeout(() => {
        this.doneTimers.delete(chatId);
        // Send the final text as a permanent message, then clear the draft
        this.wsServer.broadcast({ type: "chat:message", role: "assistant", text: finalText });
        this.wsServer.broadcast({ type: "chat:draft", text: "", done: true });
        log.debug({ chatId }, "auto-finalized dashboard draft");
      }, 2000),
    );
  }

  private clearAutoDone(chatId: string): void {
    const t = this.doneTimers.get(chatId);
    if (t) {
      clearTimeout(t);
      this.doneTimers.delete(chatId);
    }
  }

  /** Generate a fresh session-scoped chatId for a new dashboard conversation */
  static newChatId(): string {
    return `dash:${randomUUID().slice(0, 8)}`;
  }
}
