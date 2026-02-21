/**
 * Edit-in-place streaming for Telegram.
 *
 * Pattern:
 * 1. First text chunk: reply() to create message, capture message_id
 * 2. Subsequent chunks (throttled): editMessageText()
 * 3. On complete: final editMessageText with full response
 * 4. If response > 4000 chars: stop editing, send final as chunked messages
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("draft");

const DRAFT_MAX = 4000; // Max chars for edit-in-place before switching to chunks
const EDIT_THROTTLE_MS = 1500; // Min time between edits to avoid rate limits

export interface DraftContext {
  /** Send a new message, returns message ID */
  reply: (text: string) => Promise<number>;
  /** Edit an existing message */
  edit: (messageId: number, text: string) => Promise<void>;
  /** Send finalized chunked messages */
  sendChunks: (chunks: string[]) => Promise<void>;
}

export interface DraftState {
  messageId: number | null;
  text: string;
  lastEditAt: number;
  frozen: boolean; // true when we've exceeded DRAFT_MAX
  pendingEdit: ReturnType<typeof setTimeout> | null;
}

export function createDraft(): DraftState {
  return {
    messageId: null,
    text: "",
    lastEditAt: 0,
    frozen: false,
    pendingEdit: null,
  };
}

export async function appendToDraft(
  state: DraftState,
  ctx: DraftContext,
  delta: string,
): Promise<void> {
  state.text += delta;

  if (state.frozen) return;

  // If text exceeds draft max, freeze — we'll send chunks at finalize
  if (state.text.length > DRAFT_MAX) {
    state.frozen = true;
    if (state.pendingEdit) {
      clearTimeout(state.pendingEdit);
      state.pendingEdit = null;
    }
    // Update one last time with truncation notice
    if (state.messageId) {
      try {
        await ctx.edit(state.messageId, state.text.slice(0, DRAFT_MAX - 30) + "\n\n_typing..._");
      } catch (e) {
        log.debug({ err: e }, "edit failed during freeze");
      }
    }
    return;
  }

  if (!state.messageId) {
    // First chunk — create the message
    try {
      state.messageId = await ctx.reply(state.text || "...");
      state.lastEditAt = Date.now();
    } catch (e) {
      log.error({ err: e }, "failed to send initial draft message");
    }
    return;
  }

  // Throttle edits
  const now = Date.now();
  const elapsed = now - state.lastEditAt;

  if (elapsed >= EDIT_THROTTLE_MS) {
    await doEdit(state, ctx);
  } else if (!state.pendingEdit) {
    // Schedule an edit for later
    const delay = EDIT_THROTTLE_MS - elapsed;
    state.pendingEdit = setTimeout(async () => {
      state.pendingEdit = null;
      if (!state.frozen) {
        await doEdit(state, ctx);
      }
    }, delay);
  }
}

async function doEdit(state: DraftState, ctx: DraftContext): Promise<void> {
  if (!state.messageId || !state.text) return;
  try {
    await ctx.edit(state.messageId, state.text);
    state.lastEditAt = Date.now();
  } catch (e) {
    log.debug({ err: e }, "edit failed");
  }
}

export async function finalizeDraft(
  state: DraftState,
  ctx: DraftContext,
  chunks: string[],
): Promise<void> {
  if (state.pendingEdit) {
    clearTimeout(state.pendingEdit);
    state.pendingEdit = null;
  }

  if (chunks.length === 1 && state.messageId && !state.frozen) {
    // Single chunk — just do a final edit
    try {
      await ctx.edit(state.messageId, chunks[0]);
    } catch (e) {
      log.error({ err: e }, "final edit failed");
      // Fall back to sending as new message
      await ctx.sendChunks(chunks);
    }
  } else if (chunks.length > 0) {
    // Multiple chunks — delete draft and send all
    if (state.messageId) {
      try {
        await ctx.edit(state.messageId, chunks[0]);
        // Send remaining chunks as new messages
        if (chunks.length > 1) {
          await ctx.sendChunks(chunks.slice(1));
        }
      } catch (e) {
        log.error({ err: e }, "finalize edit failed, sending all as chunks");
        await ctx.sendChunks(chunks);
      }
    } else {
      await ctx.sendChunks(chunks);
    }
  }
}
