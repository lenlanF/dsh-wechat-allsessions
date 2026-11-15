// Global session/event observer: final answer extraction and origin classification.
// Mirrors @xmanrui/dsh-im session-sync-coordinator.mjs (MIT).
export function isCompletedTurn(event) {
  const reason = event?.data?.reason;
  return (typeof reason === 'string' ? reason : reason?.kind) === 'completed';
}

export function classifyUserMessage(event, { isImOwned = false } = {}) {
  const source = event?.data?.source;
  if (source?.form === 'notice' || source?.kind === 'schedule' || source?.kind === 'user-question-reply') return 'internal';
  if (source?.kind !== 'user') return 'internal';
  return isImOwned ? 'im' : 'web';
}

export function textFromContent(content) {
  return (Array.isArray(content) ? content : [])
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n').trim();
}

export class FinalTextAccumulator {
  constructor() { this.steps = new Map(); this.legacy = ''; }
  clear() { this.steps.clear(); this.legacy = ''; }
  appendDelta(step, index, text) {
    if (!text) return;
    const s = Number.isSafeInteger(step) ? step : 0;
    const i = Number.isSafeInteger(index) ? index : 0;
    this.legacy = '';
    const parts = this.steps.get(s) ?? new Map();
    parts.set(i, (parts.get(i) ?? '') + text);
    this.steps.set(s, parts);
  }
  setCanonical(step, text) {
    if (!text || !text.trim()) return;
    if (!Number.isSafeInteger(step)) { this.steps.clear(); this.legacy = text.trim(); return; }
    this.legacy = '';
    this.steps.set(step, new Map([[0, text.trim()]]));
  }
  get text() {
    if (this.steps.size === 0) return this.legacy;
    return [...this.steps.entries()].sort(([a], [b]) => a - b)
      .map(([, parts]) => [...parts.entries()].sort(([a], [b]) => a - b).map(([, t]) => t).join('\n').trim())
      .filter(Boolean).join('\n\n');
  }
}

export function accumulateFinalText(acc, event) {
  if (event.type === 'tool/call') acc.clear();
  else if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
    acc.appendDelta(event.data.step, event.data.chunk.index, event.data.chunk.text);
  } else if (event.type === 'assistant/message') {
    const content = event.data?.message?.content;
    const text = textFromContent(content);
    if (!text || (Array.isArray(content) && content.some(p => p?.type === 'tool-call'))) acc.clear();
    else acc.setCanonical(event.data.step, text);
  }
}

export function createTurnTracker({ isImOwned = () => false } = {}) {
  const turns = new Map();
  return Object.freeze({
    start(sessionId, event) {
      const turn = event?.data?.turn;
      if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(turn)) return null;
      const state = { turn, origin: null, sawInternal: false, accumulator: new FinalTextAccumulator() };
      turns.set(sessionId, state);
      return state;
    },
    userMessage(sessionId, event) {
      const state = turns.get(sessionId);
      if (!state || event?.surfaceOp !== 'append') return;
      const origin = classifyUserMessage(event, { isImOwned: isImOwned(event?.data?.source?.rpcId) });
      if (origin === 'internal') state.sawInternal = true;
      else if (origin === 'im' || state.origin === null) state.origin = origin;
    },
    content(sessionId, event) {
      const state = turns.get(sessionId);
      if (!state || state.origin === 'im') return;
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
      if (event.data?.interrupted === true) return;
      if (event.data?.turn !== undefined && event.data.turn !== state.turn) return;
      if (['assistant/message', 'assistant/chunk', 'tool/call'].includes(event.type)) accumulateFinalText(state.accumulator, event);
    },
    end(sessionId, event) {
      const state = turns.get(sessionId);
      if (!state || event?.data?.turn !== state.turn) return null;
      turns.delete(sessionId);
      return {
        sessionId, turn: state.turn,
        origin: state.origin ?? (state.sawInternal ? 'internal' : null),
        text: state.accumulator.text,
        completed: isCompletedTurn(event),
      };
    },
    get size() { return turns.size; },
  });
}

export function createBroadcastEngine({ rules, describeSession, isImOwned = () => false, send, onLog = () => {}, logger, shouldSkip = async () => false } = {}) {
  const tracker = createTurnTracker({ isImOwned });
  let current = rules;
  const tails = new Map();
  const log = (level, text) => { try { logger?.[level]?.(text); } catch { /* optional */ } };
  const setRules = (next) => { current = next; };

  async function deliverTurn(session, turn, event) {
    if (!current.enabled || !turn.completed || !turn.text) return;
    if (turn.origin === 'im' && !current.includeInternal) return;
    if (turn.origin === 'internal' && !current.includeInternal) return;
    const sessionId = session?.id ?? session?.sessionId;
    const context = { sessionId, ...(await describeSession(session, turn)) };
    if (context.isSubagent && !current.includeSubagents) return;
    if (await shouldSkip(context, turn)) return;
    const text = current.buildMessage(context, turn.text);
    try {
      const result = await send(context, text);
      onLog({ at: Date.now(), sessionId, turn: turn.turn, ok: result?.sent !== false, reason: result?.reason ?? null });
      if (result?.sent === false) log('warn', 'wechat-allsessions: send refused: ' + (result.reason ?? 'unknown'));
    } catch (error) {
      onLog({ at: Date.now(), sessionId, turn: turn.turn, ok: false, reason: error?.message ?? 'send-failed' });
      log('warn', 'wechat-allsessions: send failed: ' + (error?.message ?? error));
    }
  }

  function enqueue(session, event) {
    const key = session?.id ?? session?.sessionId ?? session;
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (!current.enabled || !event || typeof event !== 'object') return;
      const sessionId = session?.id ?? session?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) return;
      if (event.type === 'turn/start') return void tracker.start(sessionId, event);
      if (event.type === 'user/message') return void tracker.userMessage(sessionId, event);
      if (['assistant/message', 'assistant/chunk', 'tool/call'].includes(event.type)) return void tracker.content(sessionId, event);
      if (event.type !== 'turn/end') return;
      const turn = tracker.end(sessionId, event);
      if (!turn) return;
      await deliverTurn(session, turn, event);
    }).catch((error) => log('warn', 'wechat-allsessions: event handling failed: ' + (error?.message ?? error)))
      .finally(() => { if (tails.get(key) === next) tails.delete(key); });
    tails.set(key, next);
    return next;
  }
  return Object.freeze({ enqueue, setRules, deliverTurn, get pending() { return tails.size; } });
}
