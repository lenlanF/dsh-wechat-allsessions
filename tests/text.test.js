import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkUtf8Text, planDelivery, buildBroadcastMessage } from '../lib/text.js';

test('UTF-8 chunking never splits a code point', () => {
  const text = '你好😀abc';
  for (const chunk of chunkUtf8Text(text, 4)) assert.equal(Buffer.byteLength(chunk, 'utf8') <= 4 || chunk === '😀', true);
  assert.equal(chunkUtf8Text(text, 1000).join(''), text);
});
test('chunkUtf8Text rejects invalid limits', () => {
  assert.throws(() => chunkUtf8Text('x', 0), RangeError);
  assert.throws(() => chunkUtf8Text('x', 1.5), RangeError);
  assert.deepEqual(chunkUtf8Text('', 10), []);
});
test('planDelivery caps chunks and reports truncation', () => {
  const plan = planDelivery('a'.repeat(20), { maxBytes: 3, maxChunks: 2 });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.truncated, true);
});
test('broadcast message always begins with session ID and title; hint is optional', () => {
  const msg = buildBroadcastMessage({ title: 'T', sessionId: 's1', text: 'abcdef', maxChars: 3 });
  assert.ok(msg.startsWith('对话ID：s1\n对话标题：T\n\n'));
  assert.match(msg, /\/session s1/);
  assert.match(msg, /已截断/);
  assert.equal(buildBroadcastMessage({ sessionId: 's1', text: 'hi', includeHint: false }),
    '对话ID：s1\n对话标题：未命名对话\n\nhi');
});
