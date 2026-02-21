import { Bot, Context } from "grammy";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PQueue from "p-queue";
import type { TelegramConfig } from "../config.js";
import type { Channel, IncomingMessage, DraftHandle } from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("telegram");

export class TelegramChannel implements Channel {
  private bot: Bot;
  private allowedUsers: Set<number>;
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private commandHandlers = new Map<string, (msg: IncomingMessage) => Promise<void>>();
  private queues = new Map<string, PQueue>();

  constructor(private config: TelegramConfig) {
    this.bot = new Bot(config.botToken);
    this.allowedUsers = new Set(config.allowedUsers);
    this.setupHandlers();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCommand(command: string, handler: (msg: IncomingMessage) => Promise<void>): void {
    this.commandHandlers.set(command, handler);
  }

  async sendDraft(chatId: string, text: string, replyContext: unknown): Promise<DraftHandle> {
    const ctx = replyContext as Context;
    try {
      const msg = await ctx.reply(text, { parse_mode: "Markdown" });
      return { messageId: msg.message_id, chatId };
    } catch {
      // Retry without markdown if parse fails
      try {
        const msg = await ctx.reply(text);
        return { messageId: msg.message_id, chatId };
      } catch (e) {
        log.error({ err: e, chatId }, "failed to send draft");
        return { messageId: null, chatId };
      }
    }
  }

  async updateDraft(handle: DraftHandle, text: string): Promise<void> {
    if (!handle.messageId) return;
    try {
      await this.bot.api.editMessageText(handle.chatId, handle.messageId, text, {
        parse_mode: "Markdown",
      });
    } catch {
      // Retry without markdown
      try {
        await this.bot.api.editMessageText(handle.chatId, handle.messageId, text);
      } catch (e) {
        // Telegram returns error if text hasn't changed — ignore
        const msg = e instanceof Error ? e.message : "";
        if (!msg.includes("message is not modified")) {
          log.debug({ err: e }, "edit failed");
        }
      }
    }
  }

  async sendChunks(chatId: string, chunks: string[], replyContext: unknown): Promise<void> {
    const ctx = replyContext as Context;
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
      } catch {
        try {
          await ctx.reply(chunk);
        } catch (e) {
          log.error({ err: e }, "failed to send chunk");
        }
      }
    }
  }

  async sendText(chatId: string, text: string, replyContext: unknown): Promise<void> {
    const ctx = replyContext as Context;
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      try {
        await ctx.reply(text);
      } catch (e) {
        log.error({ err: e }, "failed to send text");
      }
    }
  }

  startTyping(chatId: string): () => void {
    let active = true;

    const sendAction = () => {
      if (!active) return;
      this.bot.api.sendChatAction(Number(chatId), "typing").catch(() => {});
    };

    // Send immediately, then repeat every 4s (Telegram typing expires after ~5s)
    sendAction();
    const interval = setInterval(sendAction, 4000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }

  async start(): Promise<void> {
    log.info("starting Telegram bot");
    this.bot.start({
      onStart: (info) => {
        log.info({ username: info.username }, "Telegram bot started");
      },
    });
  }

  async stop(): Promise<void> {
    log.info("stopping Telegram bot");
    this.bot.stop();
  }

  private getQueue(chatId: string): PQueue {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      this.queues.set(chatId, queue);
    }
    return queue;
  }

  private isAllowed(userId: number): boolean {
    return this.allowedUsers.has(userId);
  }

  private setupHandlers(): void {
    // Auth middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.isAllowed(userId)) {
        log.warn({ userId }, "unauthorized user");
        await ctx.reply("Unauthorized. Your user ID is not in the allowlist.");
        return;
      }
      await next();
    });

    // Commands
    this.bot.command("new", async (ctx) => {
      const handler = this.commandHandlers.get("new");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("status", async (ctx) => {
      const handler = this.commandHandlers.get("status");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("model", async (ctx) => {
      const handler = this.commandHandlers.get("model");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "Hello! I'm your AI familiar, powered by Claude Code.\n\n" +
        "Just send me a message and I'll respond.\n\n" +
        "Commands:\n" +
        "/new — Start a fresh conversation\n" +
        "/status — Session info\n" +
        "/model — Switch model",
      );
    });

    // Photos
    this.bot.on("message:photo", async (ctx) => {
      if (!this.messageHandler) return;
      const queue = this.getQueue(String(ctx.chat.id));
      await queue.add(async () => {
        const msg = await this.normalizePhotoMessage(ctx);
        await this.messageHandler!(msg);
      });
    });

    // Documents/files
    this.bot.on("message:document", async (ctx) => {
      if (!this.messageHandler) return;
      const queue = this.getQueue(String(ctx.chat.id));
      await queue.add(async () => {
        const msg = await this.normalizeDocumentMessage(ctx);
        await this.messageHandler!(msg);
      });
    });

    // Voice messages
    this.bot.on("message:voice", async (ctx) => {
      if (!this.messageHandler) return;
      const queue = this.getQueue(String(ctx.chat.id));
      await queue.add(async () => {
        const msg = await this.normalizeVoiceMessage(ctx);
        await this.messageHandler!(msg);
      });
    });

    // Text messages (catch-all for non-command text)
    this.bot.on("message:text", async (ctx) => {
      if (!this.messageHandler) return;
      const queue = this.getQueue(String(ctx.chat.id));
      await queue.add(async () => {
        const msg = this.normalizeMessage(ctx);
        await this.messageHandler!(msg);
      });
    });

    // Error handler
    this.bot.catch((err) => {
      log.error({ err: err.error }, "bot error");
    });
  }

  private normalizeMessage(ctx: Context): IncomingMessage {
    return {
      chatId: String(ctx.chat!.id),
      userId: String(ctx.from!.id),
      text: ctx.message?.text ?? ctx.message?.caption ?? "",
      replyContext: ctx,
    };
  }

  private async normalizePhotoMessage(ctx: Context): Promise<IncomingMessage> {
    const msg = this.normalizeMessage(ctx);
    const photos = ctx.message?.photo;
    if (photos && photos.length > 0) {
      // Get highest resolution photo
      const photo = photos[photos.length - 1];
      const filePath = await this.downloadFile(photo.file_id, `photo_${Date.now()}.jpg`);
      if (filePath) {
        msg.filePaths = [filePath];
        if (!msg.text) {
          msg.text = "I'm sending you a photo. Please look at it and describe what you see.";
        }
      }
    }
    return msg;
  }

  private async normalizeDocumentMessage(ctx: Context): Promise<IncomingMessage> {
    const msg = this.normalizeMessage(ctx);
    const doc = ctx.message?.document;
    if (doc) {
      const ext = doc.file_name?.split(".").pop() ?? "bin";
      const filePath = await this.downloadFile(doc.file_id, `doc_${Date.now()}.${ext}`);
      if (filePath) {
        msg.filePaths = [filePath];
        if (!msg.text) {
          msg.text = `I'm sending you a file: ${doc.file_name ?? "unknown"}. Please read and process it.`;
        }
      }
    }
    return msg;
  }

  private async normalizeVoiceMessage(ctx: Context): Promise<IncomingMessage> {
    const msg = this.normalizeMessage(ctx);
    const voice = ctx.message?.voice;
    if (voice) {
      const filePath = await this.downloadFile(voice.file_id, `voice_${Date.now()}.ogg`);
      if (filePath) {
        msg.filePaths = [filePath];
        if (!msg.text) {
          msg.text = "I'm sending you a voice message. Please transcribe and respond to it.";
        }
      }
    }
    return msg;
  }

  private async downloadFile(fileId: string, filename: string): Promise<string | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return null;

      const dir = join(tmpdir(), "familiar");
      mkdirSync(dir, { recursive: true });
      const localPath = join(dir, filename);

      const url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(localPath, buffer);

      log.debug({ fileId, localPath }, "downloaded file");
      return localPath;
    } catch (e) {
      log.error({ err: e, fileId }, "failed to download file");
      return null;
    }
  }
}
