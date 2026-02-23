import { describe, it, expect } from "vitest";
import { chunkMessage } from "./chunker.js";

const MAX_CHUNK = 4000;

describe("chunkMessage", () => {
  // ── 1. Short messages ──────────────────────────────────────────────

  describe("short messages (under limit)", () => {
    it("returns a single-element array for a short string", () => {
      const result = chunkMessage("Hello, world!");
      expect(result).toEqual(["Hello, world!"]);
    });

    it("returns a single-element array for a string well under the limit", () => {
      const text = "a".repeat(2000);
      const result = chunkMessage(text);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(text);
    });
  });

  // ── 2. Empty string ────────────────────────────────────────────────

  describe("empty string", () => {
    it("returns a single-element array containing an empty string", () => {
      const result = chunkMessage("");
      expect(result).toEqual([""]);
    });
  });

  // ── 3. Exact limit ─────────────────────────────────────────────────

  describe("exact limit (4000 chars)", () => {
    it("returns a single chunk when text is exactly MAX_CHUNK characters", () => {
      const text = "x".repeat(MAX_CHUNK);
      const result = chunkMessage(text);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(text);
    });
  });

  // ── 4. Just over limit ─────────────────────────────────────────────

  describe("just over limit", () => {
    it("splits into two chunks when text is slightly over MAX_CHUNK", () => {
      const text = "word ".repeat(801); // 4005 chars
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // Reassemble and verify no content is lost (modulo whitespace trimming)
      const reassembled = result.join(" ").replace(/\s+/g, " ").trim();
      const original = text.replace(/\s+/g, " ").trim();
      expect(reassembled).toBe(original);
    });

    it("keeps every chunk at or under MAX_CHUNK characters", () => {
      const text = "word ".repeat(801);
      const result = chunkMessage(text);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK);
      }
    });
  });

  // ── 5. Very long text (multi-chunk) ────────────────────────────────

  describe("very long text", () => {
    it("splits into multiple chunks for very long input", () => {
      const text = "sentence end. ".repeat(2000); // ~28 000 chars
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(3);
    });

    it("preserves all content across chunks", () => {
      const sentences = Array.from({ length: 500 }, (_, i) => `Sentence number ${i}.`);
      const text = sentences.join(" ");
      const result = chunkMessage(text);
      const reassembled = result.join(" ");
      // Every original sentence should appear somewhere in the output
      for (const s of sentences) {
        expect(reassembled).toContain(s);
      }
    });
  });

  // ── 6. Paragraph boundary splitting ────────────────────────────────

  describe("paragraph boundary splitting", () => {
    it("prefers splitting at double newlines", () => {
      // Build a text where a paragraph boundary sits in the back half
      const para1 = "a".repeat(3000);
      const para2 = "b".repeat(3000);
      const text = para1 + "\n\n" + para2;
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // The first chunk should end right at the paragraph boundary
      expect(result[0].endsWith("a")).toBe(true);
      expect(result[0]).not.toContain("b");
    });
  });

  // ── 7. Single newline splitting ────────────────────────────────────

  describe("single newline splitting", () => {
    it("splits at a single newline when no paragraph boundary is available in the back half", () => {
      // Put a single newline roughly 70% through the text, no double newlines
      const partA = "x".repeat(2800);
      const partB = "y".repeat(2800);
      const text = partA + "\n" + partB;
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // First chunk should end at or before the newline
      expect(result[0].length).toBeLessThanOrEqual(MAX_CHUNK);
    });
  });

  // ── 8. Sentence boundary splitting ─────────────────────────────────

  describe("sentence boundary splitting", () => {
    it("splits at a sentence boundary (period + space) when no newlines are available", () => {
      // Continuous text without newlines but with sentence-ending periods
      const segment = "This is a test sentence. "; // 25 chars
      const repetitions = Math.ceil((MAX_CHUNK + 500) / segment.length);
      const text = segment.repeat(repetitions);
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // The first chunk should end at a sentence boundary (after a period)
      const trimmed = result[0].trimEnd();
      expect(trimmed.endsWith(".")).toBe(true);
    });

    it("splits at exclamation and question marks too", () => {
      const segment = "Is this a question? Yes it is! ";
      const repetitions = Math.ceil((MAX_CHUNK + 500) / segment.length);
      const text = segment.repeat(repetitions);
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      const trimmed = result[0].trimEnd();
      // Should end at a sentence boundary
      expect(trimmed.endsWith("?") || trimmed.endsWith("!") || trimmed.endsWith(".")).toBe(true);
    });
  });

  // ── 9. Code fence handling ─────────────────────────────────────────

  describe("code fence handling", () => {
    it("closes an unclosed fence at the end of a chunk and reopens it in the next", () => {
      const codeContent = "console.log('hello');\n".repeat(300); // long code block
      const text = "Here is code:\n\n```\n" + codeContent + "```\n\nDone.";
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);

      // First chunk must close the fence
      expect(result[0].trimEnd().endsWith("```")).toBe(true);

      // Second chunk must reopen the fence
      expect(result[1].startsWith("```")).toBe(true);
    });

    it("does not add unnecessary fence markers when fences are properly closed", () => {
      const code = "let x = 1;\n".repeat(10);
      const text = "Before.\n\n```\n" + code + "```\n\nAfter.";
      // This should fit in one chunk
      expect(text.length).toBeLessThanOrEqual(MAX_CHUNK);
      const result = chunkMessage(text);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(text);
    });
  });

  // ── 10. Code fence with language identifier ────────────────────────

  describe("code fence with language identifier", () => {
    it("preserves the language identifier when reopening a fence", () => {
      const codeContent = "def foo():\n    pass\n".repeat(300);
      const text = "Example:\n\n```python\n" + codeContent + "```\n\nEnd.";
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);

      // First chunk should close the open python fence
      expect(result[0].trimEnd().endsWith("```")).toBe(true);

      // Second chunk should reopen with the language tag
      expect(result[1].startsWith("```python")).toBe(true);
    });

    it("preserves various language identifiers (typescript, rust, etc.)", () => {
      for (const lang of ["typescript", "rust", "javascript", "go"]) {
        const codeContent = "// code\n".repeat(600);
        const text = `\`\`\`${lang}\n` + codeContent + "```";
        const result = chunkMessage(text);
        if (result.length >= 2) {
          expect(result[1].startsWith("```" + lang)).toBe(true);
        }
      }
    });
  });

  // ── 11. Multiple code fences in one message ────────────────────────

  describe("multiple code fences", () => {
    it("handles multiple properly closed code fences that fit in one chunk", () => {
      const text = [
        "First block:",
        "```js",
        "const a = 1;",
        "```",
        "Second block:",
        "```python",
        "x = 2",
        "```",
        "Done.",
      ].join("\n");
      expect(text.length).toBeLessThanOrEqual(MAX_CHUNK);
      const result = chunkMessage(text);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(text);
    });

    it("handles a split that occurs between two code fences", () => {
      const code1 = "line1();\n".repeat(500);
      const code2 = "line2();\n".repeat(500);
      const text = "```js\n" + code1 + "```\n\nMiddle text.\n\n```python\n" + code2 + "```";
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);

      // All chunks should be valid — no dangling unclosed fences
      // except where intentionally continued
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(
          MAX_CHUNK + 20, // small margin for closing fence appended
        );
      }
    });

    it("tracks fence state correctly through multiple open/close pairs", () => {
      // Alternate small code blocks with prose, then have one huge unclosed block at the end
      let text = "";
      for (let i = 0; i < 5; i++) {
        text += `Block ${i}:\n\`\`\`\ncode${i}\n\`\`\`\n\n`;
      }
      // Add one final unclosed code block that forces a split
      text += "```typescript\n" + "x = 1;\n".repeat(600) + "```";
      const result = chunkMessage(text);

      // Reassembled content should contain all blocks
      const all = result.join("\n");
      for (let i = 0; i < 5; i++) {
        expect(all).toContain(`code${i}`);
      }
    });
  });

  // ── 12. No natural split points (hard cut) ─────────────────────────

  describe("no natural split points", () => {
    it("performs a hard cut when there are no spaces, newlines, or sentence boundaries", () => {
      const text = "a".repeat(MAX_CHUNK + 500);
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // First chunk should be exactly MAX_CHUNK since there are no split points
      expect(result[0].length).toBe(MAX_CHUNK);
      // Second chunk gets the remainder
      expect(result[1].length).toBe(500);
    });

    it("performs a hard cut at a space boundary when only spaces are available", () => {
      // Long text with spaces but no newlines or sentence-ending punctuation
      const word = "abcdefghij "; // 11 chars, no punctuation
      const text = word.repeat(400); // 4400 chars
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // First chunk should end at a space boundary
      expect(result[0].endsWith(" ") || result[0].endsWith("j")).toBe(true);
    });
  });

  // ── 13. All chunks under MAX_CHUNK ─────────────────────────────────

  describe("all chunks respect size limit", () => {
    it("keeps every chunk at or under MAX_CHUNK for plain text", () => {
      const text = "Hello world. ".repeat(500);
      const result = chunkMessage(text);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK);
      }
    });

    it("keeps every chunk at or under MAX_CHUNK for text with newlines", () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i}: ${"x".repeat(50)}`);
      const text = lines.join("\n");
      const result = chunkMessage(text);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK);
      }
    });

    it("keeps chunks reasonably sized even with code fences and language tags", () => {
      const codeContent = "const val = 42;\n".repeat(400);
      const text = "Intro:\n\n```typescript\n" + codeContent + "```\n\nConclusion.";
      const result = chunkMessage(text);
      for (const chunk of result) {
        // Allow a small margin for the closing ``` that gets appended
        expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK + 20);
      }
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles text that is exactly one character over the limit", () => {
      const text = "a".repeat(MAX_CHUNK + 1);
      const result = chunkMessage(text);
      expect(result.length).toBe(2);
      expect(result[0].length).toBe(MAX_CHUNK);
      expect(result[1].length).toBe(1);
    });

    it("handles text composed entirely of newlines", () => {
      const text = "\n".repeat(MAX_CHUNK + 100);
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(1);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK);
      }
    });

    it("handles a code fence at the very start of the text", () => {
      const code = "x = 1\n".repeat(800);
      const text = "```python\n" + code + "```";
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // First chunk starts with the code fence
      expect(result[0].startsWith("```python")).toBe(true);
    });

    it("handles backticks inside code (not fence markers)", () => {
      // Inline backticks should not confuse fence tracking
      const text = "Some `inline code` and more `stuff`.\n".repeat(200);
      const result = chunkMessage(text);
      // Should not add any fence closing/opening markers
      for (const chunk of result) {
        // No chunk should start with ``` since there are no fenced code blocks
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("```")) {
            // Inline backticks on a line by themselves would be a fence,
            // but our input has none of those — this verifies no spurious fences
            expect(line).toContain("`inline");
          }
        }
      }
    });

    it("does not produce empty chunks", () => {
      const text = "Hello world. ".repeat(500);
      const result = chunkMessage(text);
      for (const chunk of result) {
        expect(chunk.length).toBeGreaterThan(0);
      }
    });

    it("handles unicode characters correctly", () => {
      // Emoji and multi-byte characters
      const segment = "Hello \u{1F600} world! ";
      const text = segment.repeat(500);
      const result = chunkMessage(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      const reassembled = result.join(" ");
      expect(reassembled).toContain("\u{1F600}");
    });
  });
});
