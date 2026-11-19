import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroadcastEngine, createTurnTracker, accumulateFinalText, FinalTextAccumulator } from '../lib/events.js';

const session = { id: 's1', header: { cwd: 'D:/x' } };
const ev = (type, data = {}, surfaceOp) => ({ type, data, ...(surfaceOp ? { surfaceOp } : {}) });
test('final text keeps only the answer after the last tool call', () => {
  const a = new FinalTextAccumulator();
  accumulateFinalText(a, ev('assistant/message', { step: 1, message: { content: [{ type: 'text', text: 'before' }] } }));
  accumulateFinalText(a, ev('tool/call', { step: 2 }));
  accumulateFinalText(a, ev('assistant/message', { step: 3, message: { content: [{ type: 'text', text: 'final' }] } }));
  assert.equal(a.text, 'final');
});
test('engine broadcasts a completed web turn and rejects IM turns', async () => {
  const sent = [];
  const logs = [];
  const engine = createBroadcastEngine({ rules: { enabled: true, includeInternal: false, includeSubagents: false, buildMessage: (c, t) => t }, describeSession: async () => ({ cwd: 'D:/x', title: 'T' }), isImOwned: (rpcId) => typeof rpcId === 'string' && rpcId.startsWith('wechat-allsessions-'), send: async (c, t) => { sent.push(t); return { sent: true }; }, onLog: (e) => logs.push(e) });
  await engine.enqueue(session, ev('turn/start', { turn: 1 }));
  await engine.enqueue(session, ev('user/message', { source: { kind: 'user', rpcId: 'web-1' } }, 'append'));
  await engine.enqueue(session, ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } }, 'append'));
  await engine.enqueue(session, ev('turn/end', { turn: 1, reason: 'completed' }));
  assert.deepEqual(sent, ['answer']);
  sent.length = 0;
  await engine.enqueue(session, ev('turn/start', { turn: 2 }));
  await engine.enqueue(session, ev('user/message', { source: { kind: 'user', rpcId: 'wechat-allsessions-x' } }, 'append'));
  await engine.enqueue(session, ev('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'im' }] } }, 'append'));
  await engine.enqueue(session, ev('turn/end', { turn: 2, reason: 'completed' }));
  assert.equal(sent.length, 0);
  assert.equal(logs.length, 1);
});
test('WeChat-origin completed replies broadcast when includeInternal is enabled', async () => {
  const sent = [];
  const engine = createBroadcastEngine({
    rules: { enabled: true, includeInternal: true, includeSubagents: true, buildMessage: (c, t) => t },
    describeSession: async () => ({ title: '微信助手回复' }),
    isImOwned: rpcId => rpcId?.startsWith('wechat-allsessions-'),
    send: async (_context, value) => { sent.push(value); return { sent: true }; },
  });
  await engine.enqueue(session, ev('turn/start', { turn: 3 }));
  await engine.enqueue(session, ev('user/message', { source: { kind: 'user', rpcId: 'wechat-allsessions-example' } }, 'append'));
  await engine.enqueue(session, ev('assistant/message', { turn: 3, step: 1, message: { content: [{ type: 'text', text: '微信里的回答' }] } }, 'append'));
  await engine.enqueue(session, ev('turn/end', { turn: 3, reason: 'completed' }));
  assert.deepEqual(sent, ['微信里的回答']);
});

test('engine absorbs describeSession failures', async () => {
  const warnings = [];
  const engine = createBroadcastEngine({ rules: { enabled: true, buildMessage: (c, t) => t }, describeSession: async () => { throw new Error('boom'); }, send: async () => ({ sent: true }), logger: { warn: (t) => warnings.push(t) } });
  const unhandled = [];
  const handler = (r) => unhandled.push(r);
  process.on('unhandledRejection', handler);
  await engine.enqueue(session, ev('turn/start', { turn: 1 }));
  await engine.enqueue(session, ev('user/message', { source: { kind: 'user' } }, 'append'));
  await engine.enqueue(session, ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] } }, 'append'));
  await engine.enqueue(session, ev('turn/end', { turn: 1, reason: 'completed' }));
  await new Promise(setImmediate);
  process.off('unhandledRejection', handler);
  assert.equal(unhandled.length, 0);
  assert.ok(warnings.some(w => w.includes('boom')));
});
