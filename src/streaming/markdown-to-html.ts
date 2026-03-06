/**
 * Convert Markdown (as output by Claude) to Telegram-compatible HTML.
 *
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>
 * Everything else must be plain text with HTML entities escaped.
 *
 * Processing order:
 * 1. Extract code blocks, inline code, and tables into placeholders
 * 2. Escape HTML entities in remaining text
 * 3. Apply markdown formatting (headers, bold, italic, links, lists)
 * 4. Restore protected blocks
 */

export function markdownToTelegramHtml(md: string): string {
  if (!md) return md;

  const blocks: { placeholder: string; html: string }[] = [];
  let blockIdx = 0;

  const protect = (html: string): string => {
    const ph = `\x00B${blockIdx++}\x00`;
    blocks.push({ placeholder: ph, html });
    return ph;
  };

  let result = md;

  // 1a. Extract fenced code blocks: ```lang\ncode\n```
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return protect(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
  });

  // 1b. Extract inline code: `code`
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    return protect(`<code>${escapeHtml(code)}</code>`);
  });

  // 1c. Extract tables: 2+ consecutive lines that start and end with |
  result = result.replace(/(^|\n)((?:\|[^\n]+\|\s*\n){2,}\|[^\n]+\|)/gm, (_match, prefix, table) => {
    const lines = table.trim().split("\n");
    // Filter out separator rows like |---|---|
    const display = lines.filter((l: string) => !/^\|[\s\-:]+\|$/.test(l.trim()));
    return prefix + protect(`<pre>${escapeHtml(display.join("\n"))}</pre>`);
  });

  // 2. Escape HTML entities in remaining text
  result = escapeHtml(result);

  // 3. Apply markdown formatting

  // Headers: # text -> <b>text</b>
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold: **text** -> <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: _text_ -> <i>text</i> (word-boundary aware to avoid matching snake_case)
  result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "<i>$1</i>");

  // Links: [text](url) -> <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Unordered list markers at line start: - item or * item -> bullet
  result = result.replace(/^(\s*)[-*]\s+/gm, "$1\u2022 ");

  // 4. Restore protected blocks
  for (const block of blocks) {
    result = result.replace(block.placeholder, block.html);
  }

  return result;
}

/**
 * Escape characters that are special in HTML.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Strip all HTML tags for plain-text fallback.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}
