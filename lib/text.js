// UTF-8-safe chunking: never split a Unicode code point.
// Adapted from sgaofen/cli-in-wechat src/ilink/text-chunk.ts (MIT).
export function chunkUtf8Text(text, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be positive');
  if (typeof text !== 'string' || text.length === 0) return [];
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (current && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    if (!current && size > maxBytes) {
      chunks.push(codePoint);
      continue;
    }
    current += codePoint;
    currentBytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function planDelivery(text, { maxBytes = 1500, maxChunks = 20, continuation = '（续）' } = {}) {
  const pieces = chunkUtf8Text(text, maxBytes);
  const items = pieces.slice(0, Math.max(0, maxChunks));
  const truncated = pieces.length > items.length;
  return {
    items,
    truncated,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    continuation,
  };
}

export function buildBroadcastMessage({ title, cwd, sessionId, text, maxChars = 4000, includeHint = true }) {
  const body = typeof text === 'string' ? text.trim() : '';
  const clipped = body.length > maxChars ? body.slice(0, maxChars) + '\n…（已截断）' : body;
  if (!includeHint) return clipped;
  const parts = [];
  if (title) parts.push('[' + title + ']');
  if (cwd) parts.push('工作区: ' + cwd);
  parts.push('Session: ' + sessionId);
  return parts.join('\n') + '\n\n' + clipped + '\n\n继续对话: /session ' + sessionId;
}
