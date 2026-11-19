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
  await writeFile(accountConfigPath, JSON.stringify({ accounts: options.accounts ?? [
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
    sessions: { list: () => options.listResult ? options.listResult(records) : { sessions: records, complete: true } },
    sessionController: { async prompt(request) { prompts.push(request); return { accepted: true }; } },
    credentials: { async resolve() { return { value: 'FAKE_ACCOUNT_TOKEN' }; }, async set() {} },
  };
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-wechat-allsessions' } } },
    get: name => services[name],
    on(eventName, fn) { handlers.push({ eventName, fn }); return () => {}; },
    effect() {}, inject() {}, logger: { info() {}, warn() {} },
  };
  const transport = {
    async notifyStart() {}, async notifyStop() {},    async pollLogin() { return options.scanConfirmation ?? { status: 'wait' }; },
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

test('WeChat help uses a separate paragraph for every command without splitting messages', () => {
  const lines = WECHAT_HELP.split('\n\n');
  assert.equal(lines[0], '微信助手｜命令帮助');
  assert.ok(lines.some(line => line.startsWith('/session <会话ID>  ')));
  assert.ok(lines.some(line => line.startsWith('/broadcast off <会话ID>  ')));
  assert.ok(lines.some(line => line.startsWith('/broadcast status [会话ID]  ')));
  assert.ok(lines.every(line => !line.includes('\n')));
  assert.ok(Buffer.byteLength(WECHAT_HELP, 'utf8') <= 1500);
});

test('all saved WeChat accounts appear in the roster without exposing tokens or owner IDs', async t => {
  const f = await fixture(t, { accounts: [
    { botId: 'bot', ownerUserId: 'owner', tokenRef: 'secret-ref', name: '常用微信' },
    { botId: 'botB', ownerUserId: 'person-b', tokenRef: 'secret-ref-b', nickname: '工作微信' },
    { botId: 'botC', ownerUserId: 'person-c', tokenRef: 'secret-ref-c' },
  ] });
  const status = (await f.request('status')).body;
  assert.equal(status.accountRoster.savedCount, 3);
  assert.equal(status.accountRoster.accounts.length, 3);
  assert.equal(status.accountRoster.accounts.filter(x => x.active).length, 1);
  assert.equal(status.accountRoster.activeCount, 0, 'the test does not run a live poller');
  assert.equal(status.accountRoster.accounts[1].label, '工作微信');
  assert.doesNotMatch(JSON.stringify(status.accountRoster), /secret-ref|person-b|person-c/);
  await f.handle.stop();
  f.handle.refresh({ activeBotId: 'botB' });
  await f.handle.start();
  const switched = (await f.request('status')).body;
  assert.equal(switched.botId, 'botB');
  assert.ok(switched.accountRoster.accounts[1].active);
  assert.equal(switched.accountRoster.savedCount, 3);
});

test('partial/unknown DSH inventory never archives existing chats', async t => {
  let mode = 'complete';
  const records = [{ id: 's1', header: { title: '第一条' } }, { id: 's2', header: { title: '第二条' } }];
  const f = await fixture(t, { records, listResult: rows => mode === 'complete'
    ? { data: { items: rows, total: 2, complete: true } }
    : mode === 'partial' ? { items: rows.slice(0, 1), hasMore: true, total: 2 }
      : { unknown: 'shape' } });
  assert.equal((await f.request('status')).body.inventoryStatus.complete, true);
  mode = 'partial';
  const response = await f.request('sessions');
  assert.equal(response.body.sessions.length, 2);
  assert.equal(response.body.inventoryStatus.complete, false);
  let stored = await loadRouteStore(f.routeStorePath);
  assert.equal(stored.getSession('s2').archived, false);
  mode = 'unknown';
  const unknown = await f.request('status');
  assert.equal(unknown.body.inventoryStatus.supported, false);
  stored = await loadRouteStore(f.routeStorePath);
  assert.equal(stored.getSession('s2').archived, false);
});

test('Map inventories with IDs in keys discover all represented conversations', async t => {
  const f = await fixture(t, { records: [{ id: 'alpha', title: '原来' }], listResult: () =>
    ({ sessions: new Map([['mapped', { header: { title: '映射会话' } }], ['beta', { title: '普通会话' }]]), complete: true }) });
  const response = await f.request('sessions');
  assert.deepEqual(response.body.sessions.map(s => s.sessionId).sort(), ['beta', 'mapped']);
  assert.equal(response.body.inventoryStatus.complete, true);
});

test('session inventory accepts data arrays, dictionary maps and snake_case identifiers', async t => {
  let shape = 'data';
  const f = await fixture(t, { listResult: () => shape === 'data'
    ? { data: [{ session_id: 'snake-id', title: '蛇形 ID' }], complete: true }
    : { sessions: { 'keyed-id': { header: { title: '字典 ID' } } }, complete: false } });
  let status = await f.request('sessions');
  assert.deepEqual(status.body.sessions.map(x => x.sessionId), ['snake-id']);
  shape = 'dictionary';
  status = await f.request('sessions');
  assert.deepEqual(status.body.sessions.map(x => x.sessionId).sort(), ['keyed-id','snake-id']);
  assert.equal(status.body.inventoryStatus.complete, false);
});

test('scanning another account saves it but does not interrupt an explicitly selected account', async t => {
  const confirmed = {
    status: 'confirmed', bot_token: 'NEW_FAKE_TOKEN',
    ilink_bot_id: 'another-bot', ilink_user_id: 'other-owner',
    baseurl: 'https://ilinkai.weixin.qq.com/',
  };
  const f = await fixture(t, { scanConfirmation: confirmed });
  f.handle.refresh({ activeBotId: 'bot' });
  const response = await f.request('login', 'POST', { qrcode: 'test-scan' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.bound.connected, false);
  assert.equal(response.body.bound.savedOnly, true);
  assert.doesNotMatch(JSON.stringify(response.body), /NEW_FAKE_TOKEN|other-owner/);
  const status = (await f.request('status')).body;
  assert.equal(status.botId, 'bot');
  assert.equal(status.accountRoster.savedCount, 2);
  assert.ok(status.accountRoster.accounts.find(x => x.active && x.botId === 'bot'));
});

test('WeChat /help is handled inside bridge, never posted into the latest DSH conversation', async t => {
  const f = await fixture(t);
  const response = (await f.request('status')).body;
  assert.equal(response.version, '0.4.0');
  assert.equal(response.enabled, true);
  assert.equal(response.broadcastAll, true);
  await f.handle.handleInbound(message('/help', 'wx-help-direct'));
  assert.equal(f.prompts.length, 0, '/help must not reach SessionController');
  assert.ok(f.sends.some(x => x.text.includes('/broadcast off <会话ID>')));
  const status = (await f.request('status')).body;
  assert.equal(status.sendLog.at(-1).kind, 'wechat-command');
  assert.equal(status.sendLog.at(-1).ok, true);
});

test('WeChat-origin question emits a final answer to the same bound user', async t => {
  const f = await fixture(t);
  await f.handle.handleInbound(message('/session s1', 'select-wx'));
  f.sends.length = 0;
  await f.handle.handleInbound(message('检查工作进度', 'question-wx'));
  assert.equal(f.prompts.length, 1);
  const rpcId = f.prompts[0].requestId;
  assert.ok(rpcId.startsWith('wechat-allsessions-'));
  const session = f.records[0];
  await f.handle.engine.enqueue(session, event('turn/start', 6));
  await f.handle.engine.enqueue(session, event('user/message', 6, { source: { kind: 'user', rpcId } }));
  await f.handle.engine.enqueue(session, event('assistant/message', 6, {
    step: 1, message: { content: [{ type: 'text', text: '这是微信提问对应的回答' }] },
  }));
  await f.handle.engine.enqueue(session, event('turn/end', 6, { reason: 'completed' }));
  assert.ok(f.sends.some(x => x.toUserId === 'owner' && x.text.includes('这是微信提问对应的回答')));
  assert.ok(f.sends.some(x => x.text.startsWith('对话ID：s1\n对话标题：正在写小说')));
  assert.equal((await f.request('status')).body.sendLog.at(-1).ok, true);
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
