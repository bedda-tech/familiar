/**
 * Split long messages for Telegram's 4096-char limit.
 * Preserves code fences across splits.
 */

const MAX_CHUNK = 4000; // Leave margin below 4096

export function chunkMessage(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFence: string | null = null; // Track if we're inside a code fence

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK) {
      chunks.push(openFence ? openFence + "\n" + remaining : remaining);
      break;
    }

    let splitAt = findSplitPoint(remaining, MAX_CHUNK);
    let chunk = remaining.slice(0, splitAt);

    // Handle code fence continuity
    const fenceState = trackCodeFences(chunk, openFence);

    if (fenceState.needsClosing) {
      chunk += "\n```";
    }

    if (openFence) {
      chunk = openFence + "\n" + chunk;
      // Re-check length after prepending fence
      if (chunk.length > MAX_CHUNK) {
        // Re-split with smaller target
        splitAt = findSplitPoint(remaining, MAX_CHUNK - openFence.length - 10);
        chunk = openFence + "\n" + remaining.slice(0, splitAt);
        if (fenceState.needsClosing) chunk += "\n```";
      }
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
    openFence = fenceState.nextOpenFence;
  }

  return chunks;
}

function findSplitPoint(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;

  // Try to split at paragraph boundary (double newline)
  const paraIdx = text.lastIndexOf("\n\n", maxLen);
  if (paraIdx > maxLen * 0.5) return paraIdx;

  // Try single newline
  const nlIdx = text.lastIndexOf("\n", maxLen);
  if (nlIdx > maxLen * 0.3) return nlIdx;

  // Try sentence boundary
  const sentenceEnd = findLastSentenceEnd(text, maxLen);
  if (sentenceEnd > maxLen * 0.3) return sentenceEnd;

  // Hard cut at space
  const spaceIdx = text.lastIndexOf(" ", maxLen);
  if (spaceIdx > maxLen * 0.3) return spaceIdx;

  // Last resort: hard cut
  return maxLen;
}

function findLastSentenceEnd(text: string, maxLen: number): number {
  let best = -1;
  const region = text.slice(0, maxLen);
  for (let i = region.length - 1; i >= 0; i--) {
    if (region[i] === "." || region[i] === "!" || region[i] === "?") {
      // Make sure it's followed by whitespace or end
      if (i + 1 >= region.length || /\s/.test(region[i + 1])) {
        best = i + 1;
        break;
      }
    }
  }
  return best;
}

interface FenceState {
  needsClosing: boolean;
  nextOpenFence: string | null;
}

function trackCodeFences(chunk: string, currentFence: string | null): FenceState {
  const fenceRegex = /^(`{3,})\s*(\w*)/gm;
  let isOpen = currentFence !== null;
  let lastFenceOpen: string | null = currentFence;

  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(chunk)) !== null) {
    if (isOpen) {
      isOpen = false;
      lastFenceOpen = null;
    } else {
      isOpen = true;
      const lang = match[2] ? match[2] : "";
      lastFenceOpen = "```" + lang;
    }
  }

  return {
    needsClosing: isOpen,
    nextOpenFence: isOpen ? lastFenceOpen : null,
  };
}
