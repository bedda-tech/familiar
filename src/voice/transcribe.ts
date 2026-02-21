import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import type { OpenAIConfig } from "../config.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("voice");

/**
 * Transcribe an audio file using OpenAI Whisper API.
 * Converts .ogg to .mp3 via ffmpeg first (Whisper API doesn't accept .ogg).
 */
export async function transcribeAudio(
  filePath: string,
  config: OpenAIConfig,
): Promise<string> {
  const model = config.whisperModel ?? "whisper-1";

  // Convert to mp3 if needed (Telegram sends .ogg/opus)
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  let audioPath = filePath;

  if (ext === "ogg" || ext === "oga" || ext === "opus") {
    audioPath = await convertToMp3(filePath);
  }

  log.info({ audioPath, model }, "transcribing audio");

  // Call OpenAI Whisper API
  const formData = new FormData();
  const fileBlob = await fileToBlob(audioPath);
  formData.append("file", fileBlob, audioPath.split("/").pop() ?? "audio.mp3");
  formData.append("model", model);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    log.error({ status: response.status, body: errText }, "Whisper API error");
    throw new Error(`Whisper API error ${response.status}: ${errText}`);
  }

  const result = (await response.json()) as { text: string };
  log.info({ chars: result.text.length }, "transcription complete");
  return result.text;
}

/** Convert audio to mp3 using ffmpeg */
async function convertToMp3(inputPath: string): Promise<string> {
  const dir = join(tmpdir(), "familiar");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `voice_${Date.now()}.mp3`);

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-i", inputPath,
      "-y",        // overwrite
      "-vn",       // no video
      "-ar", "16000",
      "-ac", "1",
      "-b:a", "64k",
      outputPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg conversion failed (code ${code}): ${stderr.slice(-200)}`));
      }
    });
  });
}

/** Read a file into a Blob for FormData */
async function fileToBlob(filePath: string): Promise<Blob> {
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(filePath);
  return new Blob([buffer], { type: "audio/mpeg" });
}
