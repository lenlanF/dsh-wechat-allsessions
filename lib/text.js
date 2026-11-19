// WeChat text formatting. Delivery boundaries must preserve entire sentences and
// /session commands; raw UTF-8 boundaries alone are not safe for readers.
const bytes = value => Buffer.byteLength(value, 'utf8');
const TRUNCATED_NOTE = '…（已截断，后续完整句子未发送）';

// Kept as a low-level UTF-8 helper for compatibility. Do not use it to send
// human-facing messages: it can split a sentence or /session command.
export function chunkUtf8Text(text, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be positive');
  if (typeof text !== 'string' || text.length === 0) return [];
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const codePoint of text) {
    const size = bytes(codePoint);
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

// A line lacking sentence-ending punctuation is one indivisible unit. This is
// intentional for URLs, identifiers, slash commands, code, and list entries.
// Newlines and Chinese/English sentence punctuation are safe boundaries.
export function sentenceUnits(text) {
  if (typeof text !== 'string' || !text) return [];
  const result = [];
  let begin = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') {
      result.push(text.slice(begin, i + 1));
      begin = i + 1;
      continue;
    }
    const sentenceEnd = /[。！？!?；;]/u.test(ch)
      || (ch === '.' && (i + 1 === text.length || /\s/u.test(text[i + 1])));
    if (!sentenceEnd) continue;
    // Include trailing closing quotes/brackets and adjacent punctuation.
    let next = i + 1;
    while (next < text.length && /[。！？!?；;”’"'）)\]}]/u.test(text[next])) next += 1;
    while (next < text.length && /[ \t]/u.test(text[next])) next += 1;
    result.push(text.slice(begin, next));
    begin = next;
    i = next - 1;
  }
  if (begin < text.length) result.push(text.slice(begin));
  return result.filter(Boolean);
}

export function clipCompleteSentences(text, maxChars) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new RangeError('maxChars must be a nonnegative integer');
  if (value.length <= maxChars) return { text: value, truncated: false };
  let kept = '';
  for (const unit of sentenceUnits(value)) {
    if (kept.length + unit.length > maxChars) break;
    kept += unit;
  }
  return { text: kept.trimEnd(), truncated: true };
}

// The continuation command is a logical atom. It is always the LAST complete
// message, even when the body is truncated by the maxChunks safety limit.
const sessionFooter = /(?:\r?\n){2}(继续对话：\/session[ \t]+\S+)$/u;

export function planDelivery(text, { maxBytes = 1500, maxChunks = 20, continuation = '（续）' } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be positive');
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 0) throw new RangeError('maxChunks must be a nonnegative integer');
  if (typeof text !== 'string' || !text.trim()) {
    return { items: [], truncated: false, totalBytes: 0, continuation };
  }

  const matched = text.match(sessionFooter);
  const footer = matched?.[1] ?? '';
  const body = matched ? text.slice(0, matched.index) : text;
  // Never send an incomplete /session command. If even the entire command is
  // larger than the configured limit, omit it and explain instead.
  const validFooter = footer && bytes(footer) <= maxBytes ? footer : '';
  const footerOmitted = Boolean(footer && !validFooter);
  const bodySlots = Math.max(0, maxChunks - (validFooter ? 1 : 0));
  const chunks = [];
  let current = '';
  let truncated = footerOmitted || maxChunks === 0;
  let finalFooter = validFooter;

  for (const unit of sentenceUnits(body)) {
    if (!unit.trim()) {
      if (current && bytes(current + unit) <= maxBytes) current += unit;
      continue;
    }
    if (bytes(unit.trim()) > maxBytes) {
      // A single over-limit sentence, command or unbroken line is omitted in
      // full: we must not fake an apparently complete partial sentence.
      truncated = true;
      break;
    }
    const candidate = current + unit;
    if (bytes(candidate.trim()) <= maxBytes) {
      current = candidate;
    } else {
      if (current.trim()) {
        if (chunks.length >= bodySlots) { truncated = true; break; }
        chunks.push(current.trim());
      }
      current = unit;
    }
  }
  if (current.trim()) {
    if (chunks.length < bodySlots) chunks.push(current.trim());
    else truncated = true;
  }
  // If a trailing sentence was omitted, avoid losing the explanation.
  if (truncated) {
    const marker = footerOmitted ? '…（续接命令超过单条限制，未发送）' : TRUNCATED_NOTE;
    const last = chunks.length - 1;
    if (last >= 0 && bytes(chunks[last] + '\n\n' + marker) <= maxBytes) {
      chunks[last] += '\n\n' + marker;
    } else if (chunks.length < bodySlots && bytes(marker) <= maxBytes) {
      chunks.push(marker);
    } else if (validFooter && bytes(marker + '\n\n' + validFooter) <= maxBytes) {
      // Use the reserved final message; never sacrifice complete body sentences.
      finalFooter = marker + '\n\n' + validFooter;
    } else if (chunks.length > 0 && bytes(marker) <= maxBytes) {
      // Without room elsewhere, replace the last chunk with an honest notice.
      chunks[chunks.length - 1] = marker;
    }
  }
  if (finalFooter && maxChunks > 0) {
    // The session ID can never become a separate orphaned fragment.
    chunks.push(finalFooter);
  }
  return {
    items: chunks.slice(0, maxChunks),
    truncated,
    totalBytes: bytes(text),
    continuation,
  };
}

export function buildBroadcastMessage({ title, sessionId, text, maxChars = 4000, includeHint = true }) {
  const clipped = clipCompleteSentences(text, maxChars);
  const body = clipped.text + (clipped.truncated ? (clipped.text ? '\n' : '') + '…（正文已截断，保留完整句子）' : '');
  // Always identify the DSH conversation, even when the reply hint is disabled.
  const header = '对话ID：' + sessionId + '\n对话标题：' + (title || '未命名对话');
  return header + '\n\n' + body + (includeHint ? '\n\n继续对话：/session ' + sessionId : '');
}
