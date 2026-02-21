/** Normalized incoming message from any channel */
export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  filePaths?: string[];
  /** True if the message is a voice/audio message */
  isVoice?: boolean;
  /** Channel-specific context for sending replies */
  replyContext: unknown;
}

/** Handle to a draft message being edited in place */
export interface DraftHandle {
  messageId: number | null;
  chatId: string;
}

/** Interface that all channel adapters must implement */
export interface Channel {
  /** Register a handler for incoming messages */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

  /** Register a handler for commands */
  onCommand(command: string, handler: (msg: IncomingMessage) => Promise<void>): void;

  /** Send a new message, returns a draft handle */
  sendDraft(chatId: string, text: string, replyContext: unknown): Promise<DraftHandle>;

  /** Update a draft message in place */
  updateDraft(handle: DraftHandle, text: string): Promise<void>;

  /** Finalize: send chunked messages */
  sendChunks(chatId: string, chunks: string[], replyContext: unknown): Promise<void>;

  /** Send a simple text reply */
  sendText(chatId: string, text: string, replyContext: unknown): Promise<void>;

  /** Send typing indicator, repeating every 4s. Returns a stop function. */
  startTyping(chatId: string): () => void;

  /** Send a message directly to a chat (no reply context needed). Used by cron, etc. */
  sendDirectMessage(chatId: string, text: string): Promise<void>;

  /** Send a file to a chat */
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;

  /** Start the channel */
  start(): Promise<void>;

  /** Stop the channel */
  stop(): Promise<void>;
}
