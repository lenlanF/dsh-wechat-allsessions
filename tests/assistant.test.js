import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { loadRouteStore, parseRouteCommand, WECHAT_HELP } from '../lib/router.js';import { readRestartTicket, writeRestartTicket, restartTicketPath } from '../lib/restart.js';

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
    settings: { describe: () => [{ ns: 'dsh-wechat-allsessions' }], mutate: async () => { if (options.settingsFail) throw new Error('simulated settings failure'); }, configure: () => {} },
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
    async notifyStart() { if (options.notifyStartError) throw options.notifyStartError; }, async notifyStop() {},
    async pollLogin() { return options.scanConfirmation ?? { status: 'wait' }; },
    async getUpdates({ signal }) {
      options.pollStarted?.();
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    async sendText(params) { sends.push(params); return { sent: true }; },
  };
  const handle = apply(ctx, { enabled: true, broadcastAll: true, includeInternal: true,
    accountConfigPath, routeStorePath, statePath: stateDir }, { transport, autoStart: options.autoStart ?? false, inventoryPollMs: options.inventoryPollMs ?? 15_000,
    desktopRestart: options.desktopRestart, restartMonitorMs: options.restartMonitorMs ?? 30 });
  if (!options.autoStart) await handle.start();
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


test('temporary iLink notifyStart failure still starts exactly one WeChat polling loop', async t => {
  let polls = 0;
  const f = await fixture(t, {
    autoStart: true,
    notifyStartError: Object.assign(new Error('temporary external error'), { code: 'network-error' }),
    pollStarted() { polls += 1; },
  });
  const deadline = Date.now() + 2000;
  while (!polls && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(polls, 1, 'a failed start notification must not prevent getUpdates');
  const status = await f.request('status');
  assert.equal(status.body.connected, true);
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.polling, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(polls, 1, 'the recovery must not spawn duplicate polling loops');
});

test('/restart is handled by the plugin with a durable ticket and does not submit a DSH prompt', async t => {
  let pid = 151;
  const launched = [];
  const driver = {
    async inspect() { return { pid, exePath: 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe' }; },
    async launch(path) { launched.push(path); },
  };
  const f = await fixture(t, { desktopRestart: driver, restartMonitorMs: 30 });
  await f.handle.handleInbound(message('/restart', 'restart-id-1'));
  assert.equal(f.prompts.length, 0);
  assert.ok(f.sends.some(x => x.text.includes('正在启动一次性重启任务')));
  assert.ok(f.sends.every(x => !x.text.includes('已完成重启')));
  assert.equal(launched.length, 1);
  const file = restartTicketPath(f.stateDir, 'bot');
  assert.equal(launched[0], file);
  const ticket = await readRestartTicket(file);
  assert.equal(ticket.phase, 'armed');
  assert.equal(ticket.userId, 'owner');
  assert.equal(ticket.oldMainPid, pid);
  assert.ok(!JSON.stringify(ticket).includes('FAKE_ACCOUNT_TOKEN'));
  assert.ok(!JSON.stringify(ticket).includes('INBOUND_CTX'));

  await f.handle.handleInbound(message('/restart', 'restart-id-2'));
  assert.equal(launched.length, 1, 'duplicate /restart must not spawn a second watchdog');
  assert.ok(f.sends.some(x => x.text.includes('不会重复重启')));
  await writeRestartTicket(file, { ...ticket, phase: 'restarted', newMainPid: 152 });
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(f.sends.some(x => x.text.includes('已完成重启')), false,
    'an unchanged main PID cannot be reported as a completed restart');
  pid = 152;
  const deadline = Date.now() + 3_000;
  while (!f.sends.some(x => x.text.includes('已完成重启')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(f.sends.some(x => x.text.includes('已完成重启')));
  assert.equal((await readRestartTicket(file)).phase, 'notified');
});

test('/restart refuses untrusted senders and missing Desktop main process', async t => {
  const launched = [];
  const f = await fixture(t, { desktopRestart: {
    async inspect() { throw new Error('desktop-main-process-not-unique'); },
    async launch(path) { launched.push(path); },
  } });
  await f.handle.handleInbound(message('/restart', 'untrusted-id', 'stranger'));
  assert.equal(f.sends.length, 0);
  await f.handle.handleInbound(message('/restart', 'owner-id'));
  assert.equal(launched.length, 0);
  assert.ok(f.sends.some(x => x.text.includes('未执行重启') || x.text.includes('未执行 DSH Desktop 重启') || x.text.includes('未执行重启：')));
  assert.equal(f.prompts.length, 0);
});

test('/restart request is idempotent and the helper launch error never claims success', async t => {
  const f = await fixture(t, { desktopRestart: {
    async inspect() { return { pid: 101, exePath: 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe' }; },
    async launch() { throw new Error('simulated-launch-error'); },
  } });
  await f.handle.handleInbound(message('/restart', 'launch-fail-id'));
  assert.ok(f.sends.some(x => x.text.includes('未能确认启动')));
  assert.equal((await readRestartTicket(restartTicketPath(f.stateDir, 'bot'))).phase, 'failed');
  assert.equal(f.sends.some(x => x.text.includes('已完成重启')), false);
});

test('new Host reconciles an armed ticket after the old Desktop PID has exited', async t => {
  const now = Date.now();
  const executable = 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
  const f = await fixture(t, { desktopRestart: {
    async inspect() { return { pid: 456, exePath: executable }; },
    async launch() { throw new Error('should not launch'); },
  }, restartMonitorMs: 30 });
  const file = restartTicketPath(f.stateDir, 'bot');
  await writeRestartTicket(file, {
    version: 1, requestId: '00000000-0000-4000-8000-000000000001',
    botId: 'bot', userId: 'owner', phase: 'armed',
    requestedAt: now, expiresAt: now + 100_000,
    oldMainPid: 99999998, newMainPid: null, exePath: executable,
  });
  await f.handle.stop();
  await f.handle.start();
  const deadline = Date.now() + 3_000;
  while (!f.sends.some(s => s.text.includes('已完成重启')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(f.sends.filter(s => s.text.includes('已完成重启')).length, 1);
  assert.equal((await readRestartTicket(file)).phase, 'notified');
});

test('restart notification waits for one-shot task and old-process cleanup', async t => {
  const now = Date.now();
  const executable = 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
  let clean = false;
  let checks = 0;
  const f = await fixture(t, { desktopRestart: {
    async inspect() { return { pid: 333, exePath: executable }; },
    async launch() { throw new Error('should not start again'); },
    async verifyClean() { checks += 1; if (!clean) throw new Error('temporary task still active'); },
  }, restartMonitorMs: 30 });
  const file = restartTicketPath(f.stateDir, 'bot');
  await writeRestartTicket(file, {
    version: 1, requestId: '00000000-0000-4000-8000-000000000002',
    botId: 'bot', userId: 'owner', phase: 'restarted',
    requestedAt: now, expiresAt: now + 100_000,
    oldMainPid: 111, newMainPid: 333, exePath: executable,
  });
  await f.handle.stop();
  await f.handle.start();
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.ok(checks > 0);
  assert.equal(f.sends.some(s => s.text.includes('已完成重启')), false);
  assert.equal((await readRestartTicket(file)).phase, 'restarted');
  clean = true;
  const deadline = Date.now() + 3000;
  while (!f.sends.some(s => s.text.includes('已完成重启')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 45));
  }
  assert.equal(f.sends.filter(s => s.text.includes('已完成重启')).length, 1);
  assert.equal((await readRestartTicket(file)).phase, 'notified');
});

test('executing restart ticket remains active and blocks a duplicate /restart', async t => {
  const now = Date.now();
  const executable = 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
  const f = await fixture(t, { desktopRestart: {
    async inspect() { return { pid: 111, exePath: executable }; },
    async launch() { throw new Error('unexpected duplicate worker'); },
  } });
  const file = restartTicketPath(f.stateDir, 'bot');
  await writeRestartTicket(file, {
    version: 1, requestId: '00000000-0000-4000-8000-000000000003',
    botId: 'bot', userId: 'owner', phase: 'executing',
    requestedAt: now, expiresAt: now + 100_000,
    oldMainPid: 111, newMainPid: null, exePath: executable,
  });
  await f.handle.handleInbound(message('/restart', 'duplicate-executing'));
  assert.ok(f.sends.some(s => s.text.includes('不会重复重启')));
  assert.equal((await readRestartTicket(file)).phase, 'executing');
});

test('restart completion from a saved ticket goes only to its bound owner and sends once', async t => {
  const now = Date.now();
  const f = await fixture(t, { desktopRestart: {
    async inspect() { return { pid: 22, exePath: 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe' }; },
    async launch() { throw new Error('should-not-launch'); },
  } });
  const file = restartTicketPath(f.stateDir, 'bot');
  await writeRestartTicket(file, {
    version: 1, requestId: '00000000-0000-4000-8000-000000000000',
    botId: 'bot', userId: 'stranger', phase: 'restarted', requestedAt: now,
    expiresAt: now + 100_000, oldMainPid: 12, newMainPid: 22,
  });
  await f.handle.stop();
  await f.handle.start();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.sends.filter(x => x.text.includes('已完成重启')).length, 0);
});

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


const accountFor = id => ({ botId: id, ownerUserId: 'owner-' + id, tokenRef: 'FAKE_REF_' + id, metadata: { preserved: id } });

test('remove an inactive saved account; others and their private fields remain unchanged', async t => {
  const original = [accountFor('bot'), accountFor('botB'), accountFor('botC')];
  const f = await fixture(t, { accounts: original });
  const result = await f.request('accounts/remove', 'POST', { botId: 'botB' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.removed, true);
  assert.equal(result.body.restartRequired, false);
  assert.equal(result.body.remainingCount, 2);
  assert.equal(result.body.credentialsPreserved, true);
  assert.equal(result.body.accountRoster.savedCount, 2);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'accounts.json'), 'utf8')).accounts, [original[0], original[2]]);
  assert.equal((await f.request('status')).body.botId, 'bot');
  assert.doesNotMatch(JSON.stringify(result.body), /FAKE_REF_|owner-bot/);
});

test('remove the running selected account; stop it, select a saved fallback and allow restart', async t => {
  const f = await fixture(t, { accounts: [accountFor('bot'), accountFor('botB'), accountFor('botC')] });
  const result = await f.request('accounts/remove', 'POST', { botId: 'bot' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.restartRequired, true);
  assert.equal(result.body.activeBotId, 'botB');
  assert.equal(result.body.remainingCount, 2);
  const state = (await f.request('status')).body;
  assert.equal(state.connected, false, 'removed bot must never be reported connected');
  assert.equal(state.botId, null);
  assert.equal(state.accountRoster.savedCount, 2);
  assert.equal(state.accountRoster.activeCount, 0);
  await f.handle.start();
  assert.equal((await f.request('status')).body.botId, 'botB');
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'accounts.json'), 'utf8')).accounts.map(a => a.botId), ['botB', 'botC']);
});

test('deleting a live polling account aborts getUpdates and stops it before removing the record', async t => {
  let started;
  const polling = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { autoStart: true, pollStarted: started, accounts: [accountFor('bot'), accountFor('botB')] });
  await polling;
  assert.equal((await f.request('status')).body.polling, true);
  const result = await f.request('accounts/remove', 'POST', { botId: 'bot' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.restartRequired, true);
  const state = (await f.request('status')).body;
  assert.equal(state.polling, false);
  assert.equal(state.connected, false);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'accounts.json'), 'utf8')).accounts.map(a => a.botId), ['botB']);
});

test('remove a selected but not loaded account, and update the next boot selection only', async t => {
  const f = await fixture(t, { accounts: [accountFor('bot'), accountFor('botB'), accountFor('botC')] });
  f.handle.refresh({ activeBotId: 'botC' });
  const result = await f.request('accounts/remove', 'POST', { botId: 'botC' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.restartRequired, true);
  assert.equal(result.body.activeBotId, 'bot');
  assert.equal((await f.request('status')).body.botId, 'bot');
});

test('remove the last account: show empty roster, stop active bridge and preserve route storage', async t => {
  const f = await fixture(t, { accounts: [accountFor('bot')] });
  const result = await f.request('accounts/remove', 'POST', { botId: 'bot' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.remainingCount, 0);
  assert.equal(result.body.activeBotId, '');
  const state = (await f.request('status')).body;
  assert.equal(state.connected, false);
  assert.equal(state.accountRoster.savedCount, 0);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'accounts.json'), 'utf8')).accounts, []);
  assert.equal((await f.request('sessions')).body.sessions.length, 2);
});

test('account removal API validates identity, method, locality and request origin', async t => {
  const f = await fixture(t);
  const checks = [
    ['GET', { botId: 'bot' }, {}, 405],
    ['POST', { botId: 'bot' }, { remoteAddress: '192.0.2.10' }, 403],
    ['POST', { botId: 'bot' }, { origin: 'https://not-local.example' }, 403],
    ['POST', { botId: '../config.json' }, {}, 404],
    ['POST', { botId: ' ' }, {}, 400],
    ['POST', { botId: 'z'.repeat(300) }, {}, 400],
    ['POST', { botId: 'unknown' }, {}, 404],
  ];
  for (const [method, body, options, code] of checks) {
    assert.equal((await f.request('accounts/remove', method, body, options)).statusCode, code);
  }
  assert.equal((await f.request('status')).body.accountRoster.savedCount, 1);
});

test('a settings write failure does not remove the running account or mutate the account file', async t => {
  const f = await fixture(t, { settingsFail: true, accounts: [accountFor('bot'), accountFor('botB')] });
  const before = await readFile(join(f.dir, 'accounts.json'), 'utf8');
  const result = await f.request('accounts/remove', 'POST', { botId: 'bot' });
  assert.equal(result.statusCode, 500);
  assert.equal(await readFile(join(f.dir, 'accounts.json'), 'utf8'), before);
  assert.equal((await f.request('status')).body.botId, 'bot');
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
  assert.equal(response.version, '0.4.8');
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

test('real broadcast send path keeps entire continuation ID after long response segmentation', async t => {
  const f = await fixture(t);
  const response = Array.from({ length: 100 }, (_, i) => '这是第' + i + '句完整的微信播报内容。').join('');
  await answer(f.handle.engine, f.records[0], 107, response);
  assert.ok(f.sends.length >= 3);
  assert.ok(f.sends.every(s => Buffer.byteLength(s.text, 'utf8') <= 1500));
  const footer = f.sends.at(-1).text;
  assert.equal(footer, '继续对话：/session s1');
  assert.ok(f.sends.slice(0, -1).every(s => !s.text.includes('/session ')));
  assert.ok(f.sends.every(s => s.toUserId === 'owner'));
  assert.ok(f.sends[0].text.startsWith('对话ID：s1\n对话标题：正在写小说'));
});

test('multi-message WeChat /help keeps commands on intact lines under small byte limits', async t => {
  const f = await fixture(t);
  f.handle.refresh({ maxChunkBytes: 100 });
  await f.handle.handleInbound(message('/help', 'help-sentence-safe'));
  assert.ok(f.sends.length >= 3);
  assert.ok(f.sends.some(s => s.text.includes('/broadcast off <会话ID>')));
  assert.ok(f.sends.every(s => Buffer.byteLength(s.text, 'utf8') <= 100));
  assert.ok(f.sends.every(s => !s.text.endsWith('/broadcast')));
  assert.equal(f.prompts.length, 0);
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
