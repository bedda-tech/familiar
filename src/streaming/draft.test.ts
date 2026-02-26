import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createDraft, appendToDraft, finalizeDraft } from "./draft.js";
import type { DraftContext } from "./draft.js";

const DRAFT_MAX = 4000; // Must match the constant in draft.ts
const EDIT_THROTTLE_MS = 1500; // Must match the constant in draft.ts

/**
 * Build a mock DraftContext. Returns the ctx object and individual mocks
 * so tests can assert on call counts and arguments.
 */
function makeMockCtx(editImpl?: () => Promise<void>) {
  const reply = vi.fn().mockResolvedValue(42);
  const edit = editImpl
    ? vi.fn().mockImplementation(editImpl)
    : vi.fn().mockResolvedValue(undefined);
  const sendChunks = vi.fn().mockResolvedValue(undefined);

  const ctx: DraftContext = {
    reply: reply as DraftContext["reply"],
    edit: edit as DraftContext["edit"],
    sendChunks: sendChunks as DraftContext["sendChunks"],
  };

  return { ctx, reply, edit, sendChunks };
}

// ---------------------------------------------------------------------------
// createDraft
// ---------------------------------------------------------------------------

describe("createDraft", () => {
  it("returns the correct initial state", () => {
    const state = createDraft();

    expect(state.messageId).toBeNull();
    expect(state.text).toBe("");
    expect(state.lastEditAt).toBe(0);
    expect(state.frozen).toBe(false);
    expect(state.pendingEdit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// appendToDraft
// ---------------------------------------------------------------------------

describe("appendToDraft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── First chunk ────────────────────────────────────────────────────────────

  it("first chunk sends the initial message via reply()", async () => {
    const { ctx, reply } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello");

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("Hello");
    expect(state.messageId).toBe(42);
  });

  it("first chunk uses '...' as placeholder when delta is empty", async () => {
    const { ctx, reply } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "");

    expect(reply).toHaveBeenCalledWith("...");
  });

  it("first chunk does not call edit or sendChunks", async () => {
    const { ctx, edit, sendChunks } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello");

    expect(edit).not.toHaveBeenCalled();
    expect(sendChunks).not.toHaveBeenCalled();
  });

  it("accumulates text correctly across multiple calls", async () => {
    const { ctx } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello");
    // Advance time past throttle so next append triggers immediate edit
    vi.advanceTimersByTime(EDIT_THROTTLE_MS + 100);
    await appendToDraft(state, ctx, " world");

    expect(state.text).toBe("Hello world");
  });

  // ── Throttling ─────────────────────────────────────────────────────────────

  it("second chunk within throttle period schedules a deferred edit", async () => {
    const { ctx, edit } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello");
    // No time advances — still within throttle window
    await appendToDraft(state, ctx, " world");

    expect(edit).not.toHaveBeenCalled();
    expect(state.pendingEdit).not.toBeNull();
  });

  it("the deferred edit fires after the throttle period elapses", async () => {
    const { ctx, edit } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello");
    await appendToDraft(state, ctx, " world");

    // Advance timers to trigger the pending edit
    await vi.runAllTimersAsync();

    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(42, "Hello world");
  });

  it("second chunk after throttle period triggers an immediate edit", async () => {
    const { ctx, edit } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello");
    // Advance past the throttle window before the next append
    vi.advanceTimersByTime(EDIT_THROTTLE_MS + 100);
    await appendToDraft(state, ctx, " world");

    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(42, "Hello world");
    // No pending edit when immediate edit was done
    expect(state.pendingEdit).toBeNull();
  });

  it("does not schedule a second pending edit when one already exists", async () => {
    const { ctx } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello"); // creates message
    await appendToDraft(state, ctx, " one"); // schedules pendingEdit
    const firstHandle = state.pendingEdit;

    await appendToDraft(state, ctx, " two"); // should NOT schedule another

    expect(state.pendingEdit).toBe(firstHandle);
  });

  it("pending edit does not fire when state is frozen by the time timer triggers", async () => {
    const { ctx, edit } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello"); // creates message
    await appendToDraft(state, ctx, " more"); // schedules edit

    // Manually freeze state before timer fires
    state.frozen = true;
    await vi.runAllTimersAsync();

    expect(edit).not.toHaveBeenCalled();
  });

  // ── Freeze at DRAFT_MAX ────────────────────────────────────────────────────

  it(`freezes when accumulated text exceeds ${DRAFT_MAX} characters`, async () => {
    const { ctx } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "A"); // creates message
    await appendToDraft(state, ctx, "B".repeat(DRAFT_MAX));

    expect(state.frozen).toBe(true);
  });

  it("shows a truncation notice when freezing", async () => {
    const { ctx, edit } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "A");
    await appendToDraft(state, ctx, "B".repeat(DRAFT_MAX));

    expect(edit).toHaveBeenCalledOnce();
    const editedText = edit.mock.calls[0][1] as string;
    expect(editedText).toContain("_typing..._");
  });

  it("clears pendingEdit when freezing", async () => {
    const { ctx } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "Hello"); // creates message
    await appendToDraft(state, ctx, " more"); // schedules pendingEdit
    expect(state.pendingEdit).not.toBeNull();

    // Append enough text to trigger freeze
    await appendToDraft(state, ctx, "X".repeat(DRAFT_MAX));

    expect(state.frozen).toBe(true);
    expect(state.pendingEdit).toBeNull();
  });

  it("further appends are ignored when frozen (no additional edits)", async () => {
    const { ctx, edit } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "A");
    await appendToDraft(state, ctx, "B".repeat(DRAFT_MAX)); // freeze → 1 edit call
    const editCountAfterFreeze = edit.mock.calls.length;

    await appendToDraft(state, ctx, "more text after freeze");

    expect(edit).toHaveBeenCalledTimes(editCountAfterFreeze);
  });

  it("still accumulates text when frozen", async () => {
    const { ctx } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "A");
    await appendToDraft(state, ctx, "B".repeat(DRAFT_MAX));
    await appendToDraft(state, ctx, "extra");

    expect(state.text).toContain("extra");
  });

  it("freezes without creating a message if first delta is already over the limit", async () => {
    const { ctx, reply, edit } = makeMockCtx();
    const state = createDraft();

    await appendToDraft(state, ctx, "X".repeat(DRAFT_MAX + 1));

    expect(state.frozen).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// finalizeDraft
// ---------------------------------------------------------------------------

describe("finalizeDraft", () => {
  // ── Single chunk ───────────────────────────────────────────────────────────

  it("single chunk with messageId does a final edit", async () => {
    const { ctx, edit, sendChunks } = makeMockCtx();
    const state = createDraft();
    state.messageId = 42;

    await finalizeDraft(state, ctx, ["Final answer"]);

    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(42, "Final answer");
    expect(sendChunks).not.toHaveBeenCalled();
  });

  it("single chunk without messageId sends as chunks", async () => {
    const { ctx, edit, sendChunks } = makeMockCtx();
    const state = createDraft();
    // messageId is null

    await finalizeDraft(state, ctx, ["Only chunk"]);

    expect(sendChunks).toHaveBeenCalledWith(["Only chunk"]);
    expect(edit).not.toHaveBeenCalled();
  });

  it("single chunk with frozen state: edits existing message (multi-chunk path)", async () => {
    const { ctx, edit } = makeMockCtx();
    const state = createDraft();
    state.messageId = 42;
    state.frozen = true;

    await finalizeDraft(state, ctx, ["Frozen final"]);

    // frozen + single chunk → falls into `else if (chunks.length > 0)` with messageId
    expect(edit).toHaveBeenCalledWith(42, "Frozen final");
  });

  // ── Multiple chunks ────────────────────────────────────────────────────────

  it("multiple chunks with messageId: edits draft with first chunk, sends rest", async () => {
    const { ctx, edit, sendChunks } = makeMockCtx();
    const state = createDraft();
    state.messageId = 42;

    await finalizeDraft(state, ctx, ["chunk1", "chunk2", "chunk3"]);

    expect(edit).toHaveBeenCalledWith(42, "chunk1");
    expect(sendChunks).toHaveBeenCalledWith(["chunk2", "chunk3"]);
  });

  it("two chunks with messageId: edits first, sends second", async () => {
    const { ctx, edit, sendChunks } = makeMockCtx();
    const state = createDraft();
    state.messageId = 99;

    await finalizeDraft(state, ctx, ["part-a", "part-b"]);

    expect(edit).toHaveBeenCalledWith(99, "part-a");
    expect(sendChunks).toHaveBeenCalledWith(["part-b"]);
  });

  it("multiple chunks without messageId sends all as chunks", async () => {
    const { ctx, edit, sendChunks } = makeMockCtx();
    const state = createDraft();
    // messageId is null

    await finalizeDraft(state, ctx, ["chunk1", "chunk2"]);

    expect(sendChunks).toHaveBeenCalledWith(["chunk1", "chunk2"]);
    expect(edit).not.toHaveBeenCalled();
  });

  // ── Empty chunks ───────────────────────────────────────────────────────────

  it("empty chunks array does nothing", async () => {
    const { ctx, edit, sendChunks } = makeMockCtx();
    const state = createDraft();
    state.messageId = 42;

    await finalizeDraft(state, ctx, []);

    expect(edit).not.toHaveBeenCalled();
    expect(sendChunks).not.toHaveBeenCalled();
  });

  // ── Pending edit cleanup ───────────────────────────────────────────────────

  it("clears pendingEdit before acting", async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = makeMockCtx();
      const state = createDraft();
      state.messageId = 42;
      state.pendingEdit = setTimeout(() => {}, 5_000);

      await finalizeDraft(state, ctx, ["Final"]);

      expect(state.pendingEdit).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Error fallback ────────────────────────────────────────────────────────

  it("falls back to sendChunks when single-chunk final edit throws", async () => {
    const { ctx, sendChunks } = makeMockCtx(() => Promise.reject(new Error("API error")));
    const state = createDraft();
    state.messageId = 42;

    await finalizeDraft(state, ctx, ["Final answer"]);

    expect(sendChunks).toHaveBeenCalledWith(["Final answer"]);
  });

  it("sends all chunks when multi-chunk finalize edit throws", async () => {
    const { ctx, sendChunks } = makeMockCtx(() => Promise.reject(new Error("Network error")));
    const state = createDraft();
    state.messageId = 42;

    await finalizeDraft(state, ctx, ["chunk1", "chunk2"]);

    expect(sendChunks).toHaveBeenCalledWith(["chunk1", "chunk2"]);
  });
});
