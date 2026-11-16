import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config, name, inject, normalizeRules, unwrapVolatile, DEFAULT_RULES } from '../lib/index.js';

function ctxStub(overrides = {}) {
  const registered = [];
  const handlers = [];
  const services = {
    settings: { describe: () => [{ ns: name }], mutate: async () => ({}), configure: () => {} },
    webServer: { register: (route) => { registered.push(route); return () => {}; } },
    sessions: { list: () => [] },
    sessionController: { resume: async () => {}, prompt: async () => ({ accepted: true }) },
    credentials: { resolve: async () => ({ value: '' }) },
    ...(overrides.services ?? {}),
  };
  return { fiber: { entry: { options: { id: name } } }, get: (k) => services[k], on: (e, f) => { handlers.push({ event: e, fn: f }); return () => {}; }, effect() {}, inject() {}, logger: { warn() {}, info() {} }, registered, handlers, ...overrides };
}
test('plugin identity and schema', () => {
  assert.equal(name, 'dsh-wechat-allsessions');
  assert.ok(inject.includes('sessionController'));
  assert.ok(inject.includes('credentials'));
  assert.equal(typeof Config, 'function');
  assert.equal(Object.keys(Config.dict).length, Object.keys(DEFAULT_RULES).length);
});
test('volatile config unwraps to real values', () => {
  const resolved = Config({ enabled: true, broadcastAll: true, defaultUserId: 'wx-user' });
  const plain = unwrapVolatile(resolved);
  assert.equal(plain.enabled, true);
  assert.equal(normalizeRules(plain).defaultUserId, 'wx-user');
  assert.equal(normalizeRules({}).enabled, false);
});
test('apply registers global observer and four loopback routes', () => {
  const ctx = ctxStub();
  const handle = apply(ctx, { enabled: false });
  assert.equal(ctx.handlers.filter(h => h.event === 'session/event').length, 1);
  assert.equal(ctx.handlers.filter(h => h.event === 'settings/document-updated').length, 1);
  assert.equal(ctx.registered.length, 4);
  assert.equal(handle.started, false);
  assert.equal(handle.rules.enabled, false);
});
test('apply honors real Config-shaped values', () => {
  const ctx = ctxStub();
  const handle = apply(ctx, Config({ enabled: false, defaultUserId: 'u1', maxChunkBytes: 900 }));
  assert.equal(handle.rules.defaultUserId, 'u1');
  assert.equal(handle.rules.maxChunkBytes, 900);
});
test('login route serves a QR before the bridge is enabled', async () => {
  // Binding precedes enabling: a fresh install has no account, so gating the
  // scan behind 'enabled' would make the first bind impossible.
  const ctx = ctxStub();
  const handle = apply(ctx, { enabled: false });
  const route = ctx.registered.find(r => r.path.endsWith('/login'));
  const res = { setHeader() {}, end(p) { this.body = JSON.parse(p); }, statusCode: 0 };
  await route.handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {}, on(name, cb) { if (name === 'end') queueMicrotask(cb); return this; } }, res);
  assert.notEqual(res.statusCode, 403, 'a disabled bridge must still hand out a QR code');
  assert.equal(handle.rules.enabled, false, 'serving a QR must not flip enabled on its own');
});

test('a bodyless login POST is parsed as an empty object, not a JSON error', async () => {
  // Requesting a QR code sends no body; JSON.parse('') used to fail the route.
  const ctx = ctxStub();
  apply(ctx, { enabled: false });
  const route = ctx.registered.find(r => r.path.endsWith('/login'));
  const res = { setHeader() {}, end(p) { this.body = JSON.parse(p); }, statusCode: 0 };
  await route.handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {}, on(name, cb) { if (name === 'end') queueMicrotask(cb); return this; } }, res);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('Unexpected end of JSON input'), 'an empty body must not surface a JSON parse error');
});

test('config GET returns rules, POST applies known fields', async () => {
  const ctx = ctxStub();
  apply(ctx, {});
  const route = ctx.registered.find(r => r.path.endsWith('/config'));
  const response = () => ({ setHeader() {}, end(p) { this.body = JSON.parse(p); }, statusCode: 200 });
  const req = (method, body, remoteAddress = '127.0.0.1', headers = {}) => ({ method, socket: { remoteAddress }, headers, on(name, cb) { if (name === 'data' && body) cb(Buffer.from(JSON.stringify(body))); if (name === 'end') queueMicrotask(cb); return this; } });
  let res = response();
  await route.handler(req('GET'), res);
  assert.equal(res.body.ok, true);
  res = response();
  await route.handler(req('POST', { enabled: false, defaultUserId: 'u2' }), res);
  assert.equal(res.body.rules.defaultUserId, 'u2');
  res = response();
  await route.handler(req('GET', undefined, '10.0.0.1'), res);
  assert.equal(res.statusCode, 403);
  res = response();
  await route.handler(req('POST', { enabled: true }, '127.0.0.1', { origin: 'http://evil.example' }), res);
  assert.equal(res.statusCode, 403);
});
