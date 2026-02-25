import { Bot, Context, GrammyError } from "grammy";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PQueue from "p-queue";
import { getConfigPath, type TelegramConfig } from "../config.js";
import type { Channel, IncomingMessage, DraftHandle } from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("telegram");

// Outgoing rate limit: 1 message per 1.1 seconds per chat (conservative; Telegram
// allows ~30/sec globally and 20/min per group, but 1/1.1s is safe for any chat type).
const SEND_INTERVAL_MS = 1100;

export class TelegramChannel implements Channel {
  private bot: Bot;
  private allowedUsers: Set<number>;
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private commandHandlers = new Map<string, (msg: IncomingMessage) => Promise<void>>();
  private queues = new Map<string, PQueue>();
  private sendQueues = new Map<string, PQueue>();

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
    return this.rateLimitedSend(chatId, async () => {
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
    });
  }

  async updateDraft(handle: DraftHandle, text: string): Promise<void> {
    if (!handle.messageId) return;
    await this.rateLimitedSend(handle.chatId, async () => {
      try {
        await this.bot.api.editMessageText(handle.chatId, handle.messageId!, text, {
          parse_mode: "Markdown",
        });
      } catch {
        // Retry without markdown
        try {
          await this.bot.api.editMessageText(handle.chatId, handle.messageId!, text);
        } catch (e) {
          // Telegram returns error if text hasn't changed — ignore
          const msg = e instanceof Error ? e.message : "";
          if (!msg.includes("message is not modified")) {
            log.debug({ err: e }, "edit failed");
          }
        }
      }
    });
  }

  async sendChunks(chatId: string, chunks: string[], replyContext: unknown): Promise<void> {
    const ctx = replyContext as Context;
    for (const chunk of chunks) {
      await this.rateLimitedSend(chatId, async () => {
        try {
          await ctx.reply(chunk, { parse_mode: "Markdown" });
        } catch {
          try {
            await ctx.reply(chunk);
          } catch (e) {
            log.error({ err: e }, "failed to send chunk");
          }
        }
      });
    }
  }

  async sendText(chatId: string, text: string, replyContext: unknown): Promise<void> {
    const ctx = replyContext as Context;
    await this.rateLimitedSend(chatId, async () => {
      try {
        await ctx.reply(text, { parse_mode: "Markdown" });
      } catch {
        try {
          await ctx.reply(text);
        } catch (e) {
          log.error({ err: e }, "failed to send text");
        }
      }
    });
  }

  async sendVoice(chatId: string, filePath: string): Promise<void> {
    try {
      const { createReadStream } = await import("node:fs");
      const { InputFile } = await import("grammy");
      const stream = createReadStream(filePath);
      const inputFile = new InputFile(stream, filePath.split("/").pop());
      await this.bot.api.sendVoice(Number(chatId), inputFile);
    } catch (e) {
      log.error({ err: e, chatId, filePath }, "failed to send voice message");
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    try {
      const { createReadStream } = await import("node:fs");
      const { InputFile } = await import("grammy");
      const stream = createReadStream(filePath);
      const inputFile = new InputFile(stream, filePath.split("/").pop());

      // Detect if image by extension
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];

      if (imageExts.includes(ext)) {
        await this.bot.api.sendPhoto(Number(chatId), inputFile, {
          caption: caption ?? undefined,
        });
      } else {
        await this.bot.api.sendDocument(Number(chatId), inputFile, {
          caption: caption ?? undefined,
        });
      }
    } catch (e) {
      log.error({ err: e, chatId, filePath }, "failed to send file");
    }
  }

  async sendDirectMessage(chatId: string, text: string): Promise<void> {
    const chunks = this.splitForTelegram(text);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(Number(chatId), chunk, { parse_mode: "Markdown" });
      } catch {
        try {
          await this.bot.api.sendMessage(Number(chatId), chunk);
        } catch (e) {
          log.error({ err: e, chatId }, "failed to send direct message");
        }
      }
    }
  }

  private splitForTelegram(text: string): string[] {
    const MAX = 4000;
    if (text.length <= MAX) return [text];
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX) {
        parts.push(remaining);
        break;
      }
      const idx = remaining.lastIndexOf("\n", MAX);
      const splitAt = idx > MAX * 0.3 ? idx : MAX;
      parts.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return parts;
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

  /**
   * Get (or create) the outgoing rate-limit queue for a chat.
   * One message per SEND_INTERVAL_MS to stay well under Telegram's limits.
   */
  private getSendQueue(chatId: string): PQueue {
    let queue = this.sendQueues.get(chatId);
    if (!queue) {
      queue = new PQueue({ concurrency: 1, intervalCap: 1, interval: SEND_INTERVAL_MS });
      this.sendQueues.set(chatId, queue);
    }
    return queue;
  }

  /**
   * Execute an outgoing Telegram API call through the per-chat send queue.
   * Automatically retries once on 429 (Too Many Requests) with the server's
   * Retry-After delay.
   */
  private async rateLimitedSend<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const queue = this.getSendQueue(chatId);
    const pending = queue.size;
    if (pending > 2) {
      log.debug({ chatId, pending }, "outgoing messages queued behind rate limit");
    }
    return queue.add(async () => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 429) {
          const retryAfter = e.parameters?.retry_after ?? 1;
          log.warn({ chatId, retryAfter }, "rate limited by Telegram — backing off");
          await new Promise<void>((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
          return await fn();
        }
        throw e;
      }
    }) as Promise<T>;
  }

  private isAllowed(userId: number): boolean {
    return this.allowedUsers.has(userId);
  }

  private get accessMode(): "allowlist" | "pairing" {
    return this.config.accessMode ?? "allowlist";
  }

  /**
   * Persist a newly-paired user ID to config.json so it survives restarts.
   */
  private persistAllowedUser(userId: number): void {
    try {
      const configPath = getConfigPath();
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const users: number[] = raw.telegram?.allowedUsers ?? [];
      if (!users.includes(userId)) {
        users.push(userId);
        raw.telegram.allowedUsers = users;
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
        log.info({ userId, configPath }, "persisted new paired user to config");
      }
    } catch (e) {
      log.error({ err: e, userId }, "failed to persist paired user to config");
    }
  }

  private setupHandlers(): void {
    // /pair command — runs BEFORE auth middleware so unpaired users can reach it
    this.bot.command("pair", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      // Already allowed — no need to pair
      if (this.isAllowed(userId)) {
        await ctx.reply("You are already connected.");
        return;
      }

      if (this.accessMode !== "pairing") {
        // In allowlist mode, silently ignore unknown users
        return;
      }

      const text = ctx.message?.text ?? "";
      const code = text.replace(/^\/pair\s*/, "").trim();

      if (!code) {
        await ctx.reply("Usage: /pair <code>");
        return;
      }

      if (code === this.config.pairingCode) {
        this.allowedUsers.add(userId);
        this.persistAllowedUser(userId);
        log.info({ userId }, "user paired successfully");
        await ctx.reply("Paired successfully! You can now send messages.");
      } else {
        log.warn({ userId }, "invalid pairing code attempt");
        await ctx.reply("Invalid pairing code.");
      }
    });

    // Auth middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.isAllowed(userId)) {
        if (this.accessMode === "pairing") {
          log.debug({ userId }, "unpaired user in pairing mode");
          await ctx.reply("Send /pair <code> to connect.");
        } else {
          log.warn({ userId }, "unauthorized user");
        }
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

    this.bot.command("cost", async (ctx) => {
      const handler = this.commandHandlers.get("cost");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("thinking", async (ctx) => {
      const handler = this.commandHandlers.get("thinking");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("spawn", async (ctx) => {
      const handler = this.commandHandlers.get("spawn");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("agents", async (ctx) => {
      const handler = this.commandHandlers.get("agents");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("search", async (ctx) => {
      const handler = this.commandHandlers.get("search");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("processes", async (ctx) => {
      const handler = this.commandHandlers.get("processes");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("ps", async (ctx) => {
      const handler = this.commandHandlers.get("ps");
      if (handler) {
        const msg = this.normalizeMessage(ctx);
        await handler(msg);
      }
    });

    this.bot.command("voice", async (ctx) => {
      const handler = this.commandHandlers.get("voice");
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
          "/model — Switch model\n" +
          "/cost — Usage costs\n" +
          "/thinking — Toggle thinking display\n" +
          "/voice — Toggle voice replies (TTS)\n" +
          "/spawn — Spawn a sub-agent for a task\n" +
          "/agents — List/kill/info sub-agents\n" +
          "/search — Search message history and memory\n" +
          "/processes — System status (alias: /ps)",
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
      const rawExt = doc.file_name?.split(".").pop() ?? "";
      const ext = /^[a-zA-Z0-9]{1,10}$/.test(rawExt) ? rawExt : "bin";
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
    msg.isVoice = true;
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
