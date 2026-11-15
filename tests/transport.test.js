import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeixinTransport, extractWeixinText, normalizeBaseUrl, QR_BASE_URL } from '../lib/transport.js';

test('base URL is restricted to WeChat HTTPS hosts', () => {
  assert.equal(normalizeBaseUrl(QR_BASE_URL), QR_BASE_URL);
  assert.throws(() => normalizeBaseUrl('http://evil.example'), /untrusted|invalid/);
});
test('extractWeixinText reads text and voice items', () => {
  assert.equal(extractWeixinText({ item_list: [{ type: 1, text_item: { text: ' hi ' } }] }), 'hi');
  assert.equal(extractWeixinText({ item_list: [{ type: 3, voice_item: { text: 'voice' } }] }), 'voice');
  assert.equal(extractWeixinText({ item_list: [] }), null);
});
test('sendText posts the iLink message shape', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ret: 0 }) };
  };
  const api = createWeixinTransport({ fetchImpl, baseUrl: QR_BASE_URL });
  const result = await api.sendText({ token: 'tk', toUserId: 'u1', text: 'hello', contextToken: 'ctx' });
  assert.equal(result.sent, true);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.msg.to_user_id, 'u1');
  assert.equal(body.msg.item_list[0].text_item.text, 'hello');
  assert.equal(body.msg.context_token, 'ctx');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tk');
});
test('getUpdates sends a cursor and login QR endpoint is unauthenticated', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: options.body });
    return { ok: true, json: async () => ({ qrcode: 'qr', qrcode_img_content: 'https://ilinkai.weixin.qq.com/q/1', ret: 0, msgs: [] }) };
  };
  const api = createWeixinTransport({ fetchImpl, baseUrl: QR_BASE_URL });
  await api.beginLogin();
  assert.equal(calls[0].headers.Authorization, undefined);
  await api.getUpdates({ token: 'tk', getUpdatesBuf: 'cursor' });
  assert.equal(JSON.parse(calls[1].body).get_updates_buf, 'cursor');
  const started = await api.notifyStart({ token: 'tk' });
  assert.ok(started);
  const staleNumeric = await createWeixinTransport({ fetchImpl: async () => ({ ok: true, json: async () => ({ ret: -14 }) }) }).getUpdates({ token: 'tk' }).catch(e => e);
  assert.equal(staleNumeric.code, 'stale-token');
  const staleErrcode = await createWeixinTransport({ fetchImpl: async () => ({ ok: true, json: async () => ({ ret: 0, errcode: -14 }) }) }).getUpdates({ token: 'tk' }).catch(e => e);
  assert.equal(staleErrcode.code, 'stale-token');
  const stringZero = await createWeixinTransport({ fetchImpl: async () => ({ ok: true, json: async () => ({ ret: '0', msgs: [] }) }) }).getUpdates({ token: 'tk' });
  assert.deepEqual(stringZero.msgs, []);
  const overrideCalls = [];
  const overrideApi = createWeixinTransport({ baseUrl: QR_BASE_URL, fetchImpl: async (url) => { overrideCalls.push(String(url)); return { ok: true, json: async () => ({ ret: 0 }) }; } });
  await overrideApi.sendText({ token: 'tk', toUserId: 'u', text: 'hi', baseUrl: 'https://foo.weixin.qq.com/' });
  assert.ok(overrideCalls[0].startsWith('https://foo.weixin.qq.com/'));
});
