import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { loadRouteStore, parseRouteCommand, WECHAT_HELP } from '../lib/router.js';

const tempRoot = process.env.DSH_PLUGIN_TEST_TMP || tmpdir();
const message = (text, id = 'msg-1', from = 'owner') => ({
  from_user_id: from, message_id: id, context_token: 'INBOUND_CTX',
  item_list: [{ type: 1, text_item: { text } }],
});
function event(type, turn, extra = {}) { return { type, data: { turn, ...extra }, surfaceOp: 'append' }; }
async function answer(engine, session, turn, text) {
  await engine.enqueue(session, event('turn/start', turn));
  await engine.enqueue(session, event('user/message', turn, { source: { kind: 'user' } }));
  await engine.enqueue(session, event('assistant/message', turn, { step: 0, message: { content: [{ type: 'text', text }] } }));
  await engine.enqueue(session, event('turn/end', turn, { reason: 'completed' }));
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tempRoot, 'wechat-assistant-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  await mkdir(join(stateDir, 'bot'), { recursive: true });
  const accountConfigPath = join(dir, 'accounts.json');
  const routeStorePath = join(dir, 'routes.json');
  await writeFile(accountConfigPath, JSON.stringify({ accounts: [
    { botId: 'bot', ownerUserId: 'owner', tokenRef: 'fake', baseUrl: 'https://ilinkai.weixin.qq.com/' },
  ] }));
  if (options.legacyRoutes) await writeFile(routeStorePath, JSON.stringify(options.legacyRoutes));
  if (options.contextToken !== false) await writeFile(join(stateDir, 'bot', 'allsessions-state.json'),
    JSON.stringify({ contextTokens: { users: { owner: { token: 'OWN_CTX' } } } }));
  if (options.legacyToken) await writeFile(join(stateDir, 'bot', 'state.json'),
    JSON.stringify({ contextTokens: { users: { owner: { token: 'LEGACY_CTX' }, other: { token: 'FOREIGN_CTX' } } } }));
  const records = options.records ?? [
    { id: 's1', header: { title: '正在写小说', cwd: 'E:/Temp' } },
    { id: 's2', header: { title: '选股分析', cwd: 'E:/Temp' } },
    { id: 's-old', archived: true, header: { title: '已归档' } },
  ];
  const handlers = [];
  const registered = [];
  const sends = [];
  const prompts = [];
  const services = {
    settings: { describe: () => [{ ns: 'dsh-wechat-allsessions' }], mutate: async () => {}, configure: () => {} },
    webServer: { register(route) { registered.push(route); return () => {}; } },
    sessions: { list: () => records },
    sessionController: { async prompt(request) { prompts.push(request); return { accepted: true }; } },
    credentials: { async resolve() { return { value: 'FAKE_ACCOUNT_TOKEN' }; } },
  };
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-wechat-allsessions' } } },
    get: name => services[name],
    on(eventName, fn) { handlers.push({ eventName, fn }); return () => {}; },
    effect() {}, inject() {}, logger: { info() {}, warn() {} },
  };
  const transport = {
    async notifyStart() {}, async notifyStop() {},
    async sendText(params) { sends.push(params); return { sent: true }; },
  };
  const handle = apply(ctx, { enabled: true, broadcastAll: true, includeInternal: true,
    accountConfigPath, routeStorePath, statePath: stateDir }, { transport, autoStart: false, inventoryPollMs: options.inventoryPollMs ?? 15_000 });
  await handle.start();
  t.after(() => handle.stop());
  const request = async (endpoint, method = 'GET', body, options = {}) => {
    const route = registered.find(entry => entry.path.endsWith('/' + endpoint));
    assert.ok(route, endpoint + ' endpoint registered');
    const req = { method, socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
      headers: { origin: options.origin ?? 'http://localhost:49685' },
      on(name, callback) {
        if (name === 'data' && body !== undefined) callback(Buffer.from(JSON.stringify(body)));
        if (name === 'end') queueMicrotask(callback);
        return this;
      },
    };
    const res = { statusCode: 200, setHeader() {}, end(payload) { this.body = JSON.parse(payload); } };
    await route.handler(req, res);
    return res;
  };
  return { dir, stateDir, routeStorePath, records, handlers, sends, prompts, handle, request };
}

test('all existing non-archived chats are registered automatically and start enabled', async t => {
  const f = await fixture(t);
  const sessions = await f.request('sessions');
  assert.equal(sessions.statusCode, 200);
  assert.deepEqual(sessions.body.sessions.map(s => s.sessionId).sort(), ['s1', 's2']);
  assert.ok(sessions.body.sessions.every(s => s.broadcastEnabled));
  const store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('s-old').archived, true);
  assert.equal(store.getSession('s1').title, '正在写小说');
  assert.equal(store.getSession('s2').title, '选股分析');
});

test('idle newly opened chat is registered by timer without requiring a session event', async t => {
  const records = [{ id: 'existing', header: { title: '已有' } }];
  const f = await fixture(t, { records, inventoryPollMs: 30 });
  const initial = await loadRouteStore(f.routeStorePath);
  assert.ok(initial.getSession('existing'));
  records.push({ id: 'idle-new', header: { title: '暂未发言的新对话' } });
  for (let i = 0; i < 25; i++) {
    const current = await loadRouteStore(f.routeStorePath);
    if (current.getSession('idle-new')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const registered = await loadRouteStore(f.routeStorePath);
  assert.equal(registered.getSession('idle-new')?.title, '暂未发言的新对话');
  assert.equal(registered.getSession('idle-new')?.broadcastEnabled, true);
});

test('removed/archived DSH session is excluded during inventory reconciliation and can return', async t => {
  const records = [{ id: 'stays' }, { id: 'will-archive' }];
  const f = await fixture(t, { records });
  let store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('will-archive').archived, false);
  records.splice(1, 1);
  await f.handle.syncSessionInventory();
  store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('will-archive').archived, true);
  assert.equal((await f.request('sessions')).body.sessions.length, 1);
  records.push({ id: 'will-archive' });
  await f.handle.syncSessionInventory();
  store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('will-archive').archived, false);
});

test('per-session configuration API refuses remote access and cross-site modifications', async t => {
  const f = await fixture(t);
  const payload = { sessionId: 's1', broadcastEnabled: false };
  assert.equal((await f.request('sessions', 'POST', payload, { origin: 'http://hostile.example' })).statusCode, 403);
  assert.equal((await f.request('sessions', 'POST', payload, { remoteAddress: '192.168.1.2' })).statusCode, 403);
  assert.equal((await loadRouteStore(f.routeStorePath)).getSession('s1').broadcastEnabled, true);
});

test('new event auto-registers its chat without changing existing preferences', async t => {
  const f = await fixture(t);
  const disabled = await f.request('sessions', 'POST', { sessionId: 's1', broadcastEnabled: false });
  assert.equal(disabled.body.sessions.find(x => x.sessionId === 's1').broadcastEnabled, false);
  const observer = f.handlers.find(h => h.eventName === 'session/event').fn;
  observer({ id: 'fresh', header: {} }, { type: 'session/title', data: { title: '刚创建的对话' } });
  for (let i = 0; i < 15; i++) {
    const store = await loadRouteStore(f.routeStorePath);
    if (store.getSession('fresh')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('fresh').title, '刚创建的对话');
  assert.equal(store.getSession('fresh').broadcastEnabled, true);
  assert.equal(store.getSession('s1').broadcastEnabled, false);
  await store.syncSessions([{ sessionId: 'fresh' }]);
  assert.equal(store.getSession('fresh').title, '刚创建的对话', 'missing titles must not erase a known title');
});

test('per-session UI toggle gates delivery and persists across reloads', async t => {
  const f = await fixture(t);
  let response = await f.request('sessions', 'POST', { sessionId: 's1', broadcastEnabled: false });
  assert.equal(response.body.ok, true);
  await answer(f.handle.engine, f.records[0], 1, '不该广播');
  assert.equal(f.sends.length, 0);
  await answer(f.handle.engine, f.records[1], 2, '允许广播');
  assert.ok(f.sends.some(send => send.text.includes('允许广播')));
  const first = f.sends[0].text;
  assert.ok(first.startsWith('对话ID：s2\n对话标题：选股分析'));
  response = await f.request('sessions', 'POST', { sessionId: 's1', broadcastEnabled: true });
  assert.equal(response.body.ok, true);
  await answer(f.handle.engine, f.records[0], 3, '重新开启');
  assert.ok(f.sends.some(send => send.text.includes('重新开启')));
  const reloaded = await loadRouteStore(f.routeStorePath);
  assert.equal(reloaded.getSession('s1').broadcastEnabled, true);
});

test('WeChat /broadcast changes are visible in the plugin UI, /help lists controls', async t => {
  const f = await fixture(t);
  await f.handle.handleInbound(message('/help', 'help-1'));
  assert.ok(f.sends.some(s => s.text.includes('/broadcast off <会话ID>')));
  assert.ok(f.sends.some(s => s.text.includes('/session <会话ID>')));
  await f.handle.handleInbound(message('/broadcast off s2', 'off-1'));
  assert.equal((await f.request('sessions')).body.sessions.find(s => s.sessionId === 's2').broadcastEnabled, false);
  await f.handle.handleInbound(message('/broadcast on s2', 'on-1'));
  assert.equal((await f.request('sessions')).body.sessions.find(s => s.sessionId === 's2').broadcastEnabled, true);
  await f.handle.handleInbound(message('/broadcast status s2', 'status-1'));
  assert.ok(f.sends.some(s => s.text.includes('自动广播：开启')));
  assert.equal(f.prompts.length, 0, 'commands never forward to DSH as text');
});

test('broadcast does not overwrite an explicitly selected reply route', async t => {
  const f = await fixture(t);
  await f.handle.handleInbound(message('/session s2', 'select-1'));
  await answer(f.handle.engine, f.records[0], 1, '来自其他对话');
  await f.handle.handleInbound(message('继续选股', 'prompt-2'));
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].sessionId, 's2');
  assert.equal((await loadRouteStore(f.routeStorePath)).get('owner').sessionId, 's2');
});

test('legacy v1 reply routes survive migration and archived chats cannot be toggled', async t => {
  const f = await fixture(t, { legacyRoutes: { version: 1, users: {
    owner: { sessionId: 's2', title: '原路由', cwd: 'E:/Temp', updatedAt: 1 },
  } } });
  const store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.get('owner').sessionId, 's2');
  assert.equal(store.getSession('s-old').archived, true);
  const response = await f.request('sessions', 'POST', { sessionId: 's-old', broadcastEnabled: false });
  assert.equal(response.statusCode, 404);
  assert.equal((await loadRouteStore(f.routeStorePath)).getSession('s-old').broadcastEnabled, true);
  await answer(f.handle.engine, f.records[2], 1, 'archived');
  assert.equal(f.sends.length, 0);
});

test('existing dsh-im per-user context token is read-only reused without leaking cross-user token', async t => {
  const f = await fixture(t, { contextToken: false, legacyToken: true });
  await answer(f.handle.engine, f.records[0], 1, 'reused');
  assert.equal(f.sends[0].contextToken, 'LEGACY_CTX');
  const original = JSON.parse(await readFile(join(f.stateDir, 'bot', 'state.json'), 'utf8'));
  assert.equal(original.contextTokens.users.other.token, 'FOREIGN_CTX');
  const status = (await f.request('status')).body;
  assert.equal(status.broadcastReady, true);
  assert.doesNotMatch(JSON.stringify(status), /LEGACY_CTX|FOREIGN_CTX/);
});

test('commands cannot be used by an unknown sender and malformed toggles are not actions', async t => {
  const f = await fixture(t);
  await f.handle.handleInbound(message('/broadcast off s1', 'intruder', 'stranger'));
  assert.equal((await loadRouteStore(f.routeStorePath)).getSession('s1').broadcastEnabled, true);
  assert.deepEqual(parseRouteCommand('/broadcast off s1'), { kind: 'broadcast', enabled: false, sessionId: 's1' });
  assert.equal(parseRouteCommand('/broadcast maybe s1'), null);
  assert.match(WECHAT_HELP, /\/help/);
  assert.match(WECHAT_HELP, /\/broadcast status/);
});
