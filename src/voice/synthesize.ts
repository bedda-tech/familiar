import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpenAIConfig } from "../config.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("voice");

/** Maximum text length accepted by the OpenAI TTS API */
export const MAX_TTS_LENGTH = 4096;

/**
 * Synthesize text to speech using OpenAI TTS API.
 * Returns path to the generated audio file (ogg/opus).
 * The caller is responsible for deleting the file after use.
 */
export async function synthesizeSpeech(text: string, config: OpenAIConfig): Promise<string> {
  const model = config.ttsModel ?? "tts-1";
  const voice = config.ttsVoice ?? "alloy";

  // Truncate to API limit if needed
  const input = text.length > MAX_TTS_LENGTH ? text.slice(0, MAX_TTS_LENGTH) : text;

  log.info({ chars: input.length, model, voice }, "synthesizing speech");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      voice,
      response_format: "opus",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    log.error({ status: response.status, body: errText }, "TTS API error");
    throw new Error(`TTS API error ${response.status}: ${errText}`);
  }

  const dir = join(tmpdir(), "familiar");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `tts_${Date.now()}.ogg`);

  const buffer = await response.arrayBuffer();
  await writeFile(filePath, Buffer.from(buffer));

  log.info({ filePath, bytes: buffer.byteLength }, "speech synthesized");
  return filePath;
}

/**
 * Delete a temporary audio file.
 * Safe to call even if the file has already been removed.
 */
export async function cleanupAudioFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    log.debug({ filePath }, "deleted temp audio file");
  } catch {
    // Ignore — file may already be deleted or never created
  }
}

/**
 * Strip Telegram Markdown formatting from text for TTS synthesis.
 * Removes markdown syntax while preserving readable content.
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // Fenced code blocks — keep the code content, drop the fences
      .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, "$1")
      // Inline code
      .replace(/`([^`]+)`/g, "$1")
      // Bold (**text** or __text__)
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      // Italic (*text* or _text_)
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/_([^_\n]+)_/g, "$1")
      // Markdown links [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // ATX headings (# Heading)
      .replace(/^#{1,6}\s+/gm, "")
      // Unordered list markers
      .replace(/^[*\-+]\s+/gm, "")
      // Ordered list markers (1. 2.)
      .replace(/^\d+\.\s+/gm, "")
      // Horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, "")
      // Blockquote markers
      .replace(/^>\s*/gm, "")
      // Collapse 3+ consecutive newlines to two
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
