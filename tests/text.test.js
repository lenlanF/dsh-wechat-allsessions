import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkUtf8Text, sentenceUnits, clipCompleteSentences, planDelivery, buildBroadcastMessage } from '../lib/text.js';

test('low-level UTF-8 chunking never splits a code point', () => {
  const text = '你好😀abc';
  for (const chunk of chunkUtf8Text(text, 4)) assert.equal(Buffer.byteLength(chunk, 'utf8') <= 4 || chunk === '😀', true);
  assert.equal(chunkUtf8Text(text, 1000).join(''), text);
});
test('chunkUtf8Text rejects invalid limits', () => {
  assert.throws(() => chunkUtf8Text('x', 0), RangeError);
  assert.throws(() => chunkUtf8Text('x', 1.5), RangeError);
  assert.deepEqual(chunkUtf8Text('', 10), []);
});

test('sentence unit boundaries preserve whole Chinese and English sentences, numbers and commands', () => {
  const input = '价格是 3.14 元。Hello world. 下一句！\n/session session-abcd-1234';
  const units = sentenceUnits(input);
  assert.deepEqual(units, [
    '价格是 3.14 元。',
    'Hello world. ',
    '下一句！',
    '\n',
    '/session session-abcd-1234',
  ]);
  assert.equal(units.join(''), input);
});

test('broadcast text limit drops incomplete trailing sentences, never emits fragments', () => {
  const body = '第一句已经结束。第二句话尚未完整结束？第三句。';
  const boundary = '第一句已经结束。第二句话尚未'.length;
  const clip = clipCompleteSentences(body, boundary);
  assert.equal(clip.text, '第一句已经结束。');
  assert.equal(clip.truncated, true);
  const result = buildBroadcastMessage({ title: 'T', sessionId: 'test-session', text: body, maxChars: boundary });
  assert.match(result, /第一句已经结束。\n…（正文已截断，保留完整句子）/u);
  assert.ok(!result.includes('第二句话尚未'));
  assert.match(result, /\/session test-session$/u);
});

test('broadcast message always begins with complete session ID and title; hint remains optional', () => {
  const msg = buildBroadcastMessage({ title: 'T', sessionId: 's1', text: 'abcdef', maxChars: 3 });
  assert.ok(msg.startsWith('对话ID：s1\n对话标题：T\n\n'));
  assert.match(msg, /\/session s1/);
  assert.match(msg, /已截断/);
  assert.ok(!msg.includes('abc'), 'an overlong unpunctuated sentence must be omitted');
  assert.equal(buildBroadcastMessage({ sessionId: 's1', text: 'hi', includeHint: false }),
    '对话ID：s1\n对话标题：未命名对话\n\nhi');
});

test('sentence-safe chunking never splits the /session command at the 1500-byte boundary', () => {
  const id = 'session-' + 'a'.repeat(50);
  const text = Array.from({ length: 75 }, (_, i) => '第' + i + '个完整的段落，应该正确保留整个句子。').join('');
  const source = buildBroadcastMessage({ title: '测试对话', sessionId: id, text, maxChars: 8000 });
  const plan = planDelivery(source, { maxBytes: 1500, maxChunks: 20 });
  assert.ok(plan.items.length >= 3);
  assert.equal(plan.truncated, false);
  assert.equal(plan.items.at(-1), '继续对话：/session ' + id);
  assert.equal(plan.items.filter(item => item.includes('/session ')).length, 1);
  assert.ok(plan.items.every(item => Buffer.byteLength(item, 'utf8') <= 1500));
  assert.ok(plan.items.slice(0, -1).every(item => !item.endsWith('第')));
});

test('maxChunks truncation reserves the entire final continuation command and adds a notice', () => {
  const id = 'session-' + 'a'.repeat(30);
  const source = buildBroadcastMessage({ title: '测试', sessionId: id, text: '这是一句完整内容。'.repeat(60), maxChars: 6000 });
  const plan = planDelivery(source, { maxBytes: 120, maxChunks: 2 });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.truncated, true);
  assert.ok(plan.items.at(-1).includes('/session ' + id));
  assert.ok(plan.items.some(item => item.includes('已截断')));
  assert.ok(plan.items.every(item => Buffer.byteLength(item, 'utf8') <= 120));
  assert.ok(plan.items.every(item => !item.endsWith('/session session-a')));
});

test('over-limit individual sentence is omitted instead of sending a fragment', () => {
  const body = '开始说明。\n' + '这是无法再被切割的一个长句'.repeat(30);
  const plan = planDelivery(body, { maxBytes: 110, maxChunks: 4 });
  assert.equal(plan.truncated, true);
  assert.ok(plan.items.join('').includes('开始说明。'));
  assert.ok(plan.items.join('').includes('已截断'));
  assert.ok(!plan.items.join('').includes('这是无法'));
  assert.ok(plan.items.every(item => Buffer.byteLength(item, 'utf8') <= 110));
});

test('an oversized session footer is omitted whole instead of leaking an unusable suffix', () => {
  const longId = 'session-' + 'z'.repeat(220);
  const plan = planDelivery('已处理完成。\n\n继续对话：/session ' + longId, { maxBytes: 100, maxChunks: 3 });
  assert.equal(plan.truncated, true);
  assert.ok(plan.items.join('').includes('继续命令') || plan.items.join('').includes('续接命令'));
  assert.ok(!plan.items.join('').includes(longId));
  assert.ok(!plan.items.join('').includes('/session '));
});

test('chunk ceiling preserves complete short sentences and accurately reports truncation', () => {
  const plan = planDelivery('One. Two. Three. Four.', { maxBytes: 9, maxChunks: 2 });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.items, ['One. Two.', 'Three.']);
});
