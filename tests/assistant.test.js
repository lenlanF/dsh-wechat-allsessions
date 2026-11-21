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
  // Existing regression fixtures start with an explicitly stored binding.
  // Discovery-only scenarios opt out with prebound:false.
  if (options.prebound !== false && !options.legacyRoutes) {
    const preset = options.records ?? [
      { id: 's1', header: { title: '正在写小说', cwd: 'E:/Temp' } },
      { id: 's2', header: { title: '选股分析', cwd: 'E:/Temp' } },
      { id: 's-old', archived: true, header: { title: '已归档' } },
    ];
    await writeFile(routeStorePath, JSON.stringify({ version: 3, users: {}, sessions: Object.fromEntries(
      preset.filter(r => !r.archived).map(r => [r.id ?? r.sessionId, {
        title: r.header?.title ?? r.title ?? '', cwd: r.header?.cwd ?? r.cwd ?? '',
        archived: false, bound: true, broadcastEnabled: true,
      }]),
    ) }));
  }
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
  const selections = [];
  const services = {
    settings: { describe: () => [{ ns: 'dsh-wechat-allsessions' }], mutate: async () => { if (options.settingsFail) throw new Error('simulated settings failure'); }, configure: () => {} },
    webServer: { register(route) { registered.push(route); return () => {}; } },
    sessions: { list: () => options.listResult ? options.listResult(records) : { sessions: records, complete: true } },
    workspaceRegistry: options.archiveRegistryUnavailable ? undefined : { get archivedSessionIds() {
      return options.archivedIds ?? records.filter(r => r.archived === true)
        .map(r => r.sessionId ?? r.id);
    } },
    sessionController: {
      async list() {
        if (options.directoryError) throw options.directoryError;
        if (options.controllerListResult) return options.controllerListResult(records);
        return { items: records.map(row => ({
          sessionId: row.sessionId ?? row.id ?? row.session_id,
          cwd: row.header?.cwd ?? row.cwd ?? '',
          origin: row.header?.origin ?? row.origin,
          parentSessionId: row.header?.parentSession ?? row.header?.parentSessionId ?? row.parentSessionId,
          blank: row.blank === true,
          projections: { values: { title: row.header?.title ?? row.title ?? '' } },
        })) };
      },
      async prompt(request) { prompts.push(request); return { accepted: true }; },
      async modelCatalog() { if (options.catalogError) throw options.catalogError;
        return options.modelCatalog ?? { groups: [], failures: [] }; },
      async selectModel(request) { selections.push(request);
        if (options.selectModelError) throw options.selectModelError;
        return options.selectModelResult ?? { selected: { provider: request.provider, model: request.model } }; },
    },
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
  return { dir, stateDir, routeStorePath, records, handlers, sends, prompts, selections, handle, request };
}


test('/models lists actual Host channels and model IDs without prompting the Agent', async t => {
  const catalog = { groups: [
    { id: 'native-router', name: '聚合路由', models: [
      { id: 'direct:workbuddy:hy4-flash', name: 'WorkBuddy · Hy4 flash · x0.00' },
    ] },
    { id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'v4', name: 'V4' }] },
  ], failures: [] };
  const f = await fixture(t, { modelCatalog: catalog });
  await f.handle.handleInbound(message('/models list -c', 'models-channels'));
  assert.ok(f.sends.at(-1).text.includes('native-router'));
  assert.ok(f.sends.at(-1).text.includes('deepseek-account'));
  await f.handle.handleInbound(message('/models list native-router', 'models-channel'));
  assert.ok(f.sends.at(-1).text.includes('direct:workbuddy:hy4-flash'));
  assert.ok(f.sends.at(-1).text.includes('x0.00'));
  assert.equal(f.sends.at(-1).text.includes('v4'), false);
  await f.handle.handleInbound(message('/models list', 'models-all'));
  assert.ok(f.sends.at(-1).text.includes('deepseek-account'));
  assert.equal(f.prompts.length, 0, '/models commands must never reach prompt');
  assert.equal(f.selections.length, 0, 'listing must not change Session selection');
});

test('/models sends a complete paged WeChat catalog without silent message truncation', async t => {
  const models = Array.from({ length: 52 }, (_, i) => ({
    id: 'model-' + String(i).padStart(2, '0'),
    name: 'Very long useful model name ' + i + ' compatible with DSH channel',
  }));
  const f = await fixture(t, { modelCatalog: {
    groups: [{ id: 'test-channel', name: '已注册渠道', models }], failures: [],
  } });
  await f.handle.handleInbound(message('/models list', 'many-models-1'));
  const first = f.sends.map(s => s.text).join('');
  assert.match(first, /model-00/u);
  assert.match(first, /model-24/u);
  assert.match(first, /下一页：\/models list -p 2/u);
  assert.doesNotMatch(first, /model-25/u);
  const offset = f.sends.length;
  await f.handle.handleInbound(message('/models list -p 2', 'many-models-2'));
  const second = f.sends.slice(offset).map(s => s.text).join('');
  assert.match(second, /model-25/u);
  assert.match(second, /model-49/u);
  assert.match(second, /下一页：\/models list -p 3/u);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.selections.length, 0);
});

test('/models keeps every copyable model command complete when WeChat splits long lists', async t => {
  const models = Array.from({ length: 25 }, (_, i) => ({
    id: 'model-' + String(i).padStart(2, '0'),
    name: '模型 ' + i + '（高精度文本推理）',
  }));
  const f = await fixture(t, { modelCatalog: { groups: [
    { id: 'loomy', name: 'Loomy', models },
  ], failures: [] } });
  f.handle.refresh({ maxChunkBytes: 180 });
  await f.handle.handleInbound(message('/models list loomy', 'models-multipart-commands'));
  assert.ok(f.sends.length > 3, 'model list should span multiple WeChat messages');
  assert.ok(f.sends.every(s => Buffer.byteLength(s.text, 'utf8') <= 180));
  const lines = f.sends.flatMap(s => s.text.split('\n'));
  for (const item of models) {
    const command = '/models loomy ' + item.id;
    assert.ok(lines.includes(command), 'full model selection line must be preserved: ' + command);
  }
  const all = f.sends.map(s => s.text).join('\n');
  assert.doesNotMatch(all, /已截断|单句超限/u);
  assert.equal(f.prompts.length, 0);
});
test('/models chooses a specific DSH Session and the host records exact selected provider/model', async t => {
  const catalog = { groups: [{ id: 'native-router', name: '聚合路由',
    models: [{ id: 'direct:workbuddy:hy4-flash', name: 'WorkBuddy · Hy4 flash · x0.00' }] }] };
  const f = await fixture(t, { modelCatalog: catalog });
  await f.handle.handleInbound(message('/session s1', 'choose-s1'));
  await f.handle.handleInbound(message('/models native-router direct:workbuddy:hy4-flash', 'select-model-s1'));
  assert.deepEqual(f.selections, [{ sessionId: 's1', provider: 'native-router', model: 'direct:workbuddy:hy4-flash' }]);
  assert.match(f.sends.at(-1).text, /已为当前 DSH 会话选择模型/u);
  await f.handle.handleInbound(message('/session s2', 'choose-s2'));
  await f.handle.handleInbound(message('/models native-router direct:workbuddy:hy4-flash', 'select-model-s2'));
  assert.equal(f.selections[1].sessionId, 's2');
  assert.equal(f.prompts.length, 0);
  await f.handle.handleInbound(message('继续分析', 'later-real-prompt'));
  assert.equal(f.prompts.at(-1).sessionId, 's2', 'follow-up goes to selected session');
});

test('/models keeps aggregate internal models separate from independently registered channels', async t => {
  const f = await fixture(t, { modelCatalog: { groups: [
    { id: 'native-router', name: '聚合路由', models: [
      { id: 'autofree', name: '聚合路由 · AutoFree · x?' },
      { id: 'chain:custom-route', name: '聚合路由 · 自建路由链 · x?' },
      { id: 'direct:workbuddy:hy4-flash', name: '聚合路由复用 · Hy4 flash · x0.00' },
    ] },
    { id: 'workbuddy', name: '独立 WorkBuddy Provider', models: [
      { id: 'hy4-flash', name: 'WorkBuddy · Hy4 flash' },
    ] },
  ], failures: [] } });
  await f.handle.handleInbound(message('/models list -c', 'independent-channels'));
  assert.match(f.sends.at(-1).text, /模型渠道（2 个/u);
  await f.handle.handleInbound(message('/models list native-router', 'aggregate-models'));
  assert.match(f.sends.at(-1).text, /autofree/u);
  assert.match(f.sends.at(-1).text, /chain:custom-route/u);
  assert.match(f.sends.at(-1).text, /direct:workbuddy:hy4-flash/u);
  await f.handle.handleInbound(message('/models list workbuddy', 'independent-models'));
  assert.match(f.sends.at(-1).text, /独立 WorkBuddy Provider/u);
  assert.doesNotMatch(f.sends.at(-1).text, /direct:workbuddy:hy4-flash/u);
  await f.handle.handleInbound(message('/session s1', 'separate-provider-session'));
  await f.handle.handleInbound(message('/models workbuddy direct:workbuddy:hy4-flash', 'separate-provider-invalid'));
  assert.match(f.sends.at(-1).text, /不在当前 DSH 可用目录/u);
  assert.equal(f.selections.length, 0, 'no source-ID fallback into native-router');
  await f.handle.handleInbound(message('/models native-router direct:workbuddy:hy4-flash', 'aggregate-provider-select'));
  await f.handle.handleInbound(message('/models workbuddy hy4-flash', 'independent-provider-select'));
  assert.deepEqual(f.selections, [
    { sessionId: 's1', provider: 'native-router', model: 'direct:workbuddy:hy4-flash' },
    { sessionId: 's1', provider: 'workbuddy', model: 'hy4-flash' },
  ]);
  assert.equal(f.prompts.length, 0);
});


test('/models refuses missing Session, unavailable model, and untrusted sender without mutation', async t => {
  const f = await fixture(t, { modelCatalog: { groups: [
    { id: 'native-router', name: '聚合路由', models: [{ id: 'valid', name: 'Valid' }] },
  ] } });
  await f.handle.handleInbound(message('/models native-router valid', 'without-session'));
  assert.match(f.sends.at(-1).text, /先使用 \/list 和 \/session/u);
  await f.handle.handleInbound(message('/session s1', 'models-select-session'));
  await f.handle.handleInbound(message('/models native-router absent', 'bad-model'));
  assert.match(f.sends.at(-1).text, /不在当前 DSH 可用目录/u);
  await f.handle.handleInbound(message('/models list', 'untrusted-model-query', 'other'));
  await f.handle.handleInbound(message('/models native-router valid', 'untrusted-model-mutation', 'other'));
  assert.equal(f.selections.length, 0);
  assert.equal(f.prompts.length, 0);
});

test('/models never confirms when DSH rejects or changes the selected model', async t => {
  const f = await fixture(t, { modelCatalog: { groups: [
    { id: 'native-router', name: '聚合路由', models: [{ id: 'valid', name: 'Valid' }] },
  ] }, selectModelResult: { selected: { provider: 'other', model: 'fallback' } } });
  await f.handle.handleInbound(message('/session s1', 'models-sel-failed-session'));
  await f.handle.handleInbound(message('/models native-router valid', 'models-sel-failed'));
  assert.equal(f.selections.length, 1);
  assert.match(f.sends.at(-1).text, /未确认本次模型切换/u);
});

test('/models gracefully rejects missing or broken Host model catalog', async t => {
  const f = await fixture(t, { catalogError: new Error('secret upstream URL and private token') });
  await f.handle.handleInbound(message('/models list', 'catalog-failed'));
  assert.match(f.sends.at(-1).text, /暂时不可用/u);
  assert.doesNotMatch(f.sends.at(-1).text, /secret|private token/u);
  assert.equal(f.selections.length, 0);
});
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

test('unavailable DSH persistent catalog cannot prevent WeChat startup or existing binding management', async t => {
  const f = await fixture(t, { prebound: true, directoryError: new Error('fake private credentials URL') });
  const status = (await f.request('status')).body;
  assert.equal(status.connected, true);
  assert.equal(status.inventoryStatus.available, false);
  await f.handle.handleInbound(message('/list', 'directory-offline-list'));
  assert.match(f.sends.at(-1).text, /无法确认 DSH 完整会话目录或归档状态/u);
  await f.handle.handleInbound(message('/session', 'directory-offline-bound'));
  assert.match(f.sends.at(-1).text, /已绑定会话/u);
  await f.handle.handleInbound(message('/session add missing', 'directory-offline-bind'));
  assert.match(f.sends.at(-1).text, /无法核实完整会话目录/u);
  assert.doesNotMatch(f.sends.map(s => s.text).join('\n'), /private credentials URL/u);
  assert.equal(f.prompts.length, 0);
});

test('malformed /list and /session commands are local usage errors, not AI prompts', async t => {
  const f = await fixture(t, { prebound: false });
  for (const [command, marker] of [
    ['/list -p 0', 'badlist0'],
    ['/list -p nope', 'badlistx'],
    ['/session add', 'badadd'],
    ['/session -p 0', 'badpage'],
  ]) {
    await f.handle.handleInbound(message(command, marker));
    assert.match(f.sends.at(-1).text, /全部会话：|已绑定列表：/u);
  }
  assert.equal(f.prompts.length, 0);
});
test('/list shows unarchived cold conversations but not archives; /session only explicit bindings', async t => {
  const records = [
    { id: 'cold-old', header: { title: '从未广播的历史会话' } },
    { id: 'running', header: { title: '当前会话' } },
    { id: 'archived-old', archived: true, header: { title: '归档的会话' } },
  ];
  const f = await fixture(t, { records, prebound: false });
  await f.handle.handleInbound(message('/list', 'all-sessions-1'));
  const list = f.sends.at(-1).text;
  assert.match(list, /未归档普通会话（2 个/u);
  assert.match(list, /从未广播的历史会话/u);
  assert.match(list, /cold-old/u);
  assert.match(list, /\/session add cold-old/u);
  assert.doesNotMatch(list, /archived-old|归档的会话|📦 已归档/u);
  await f.handle.handleInbound(message('/session', 'bound-none'));
  assert.match(f.sends.at(-1).text, /尚未绑定会话/u);
  await f.handle.handleInbound(message('/session cold-old', 'select-not-bound'));
  assert.match(f.sends.at(-1).text, /未绑定或已归档/u);
  assert.equal((await loadRouteStore(f.routeStorePath)).getSession('cold-old'), null);
  await f.handle.handleInbound(message('/session add cold-old', 'explicit-bind'));
  assert.match(f.sends.at(-1).text, /已手动绑定/u);
  const state = await loadRouteStore(f.routeStorePath);
  assert.equal(state.getSession('cold-old').bound, true);
  assert.equal(state.get('owner'), null, 'binding does not implicitly select a reply route');
  await f.handle.handleInbound(message('/session', 'bound-one'));
  assert.match(f.sends.at(-1).text, /已绑定会话（1 个/u);
  assert.match(f.sends.at(-1).text, /cold-old/u);
  assert.doesNotMatch(f.sends.at(-1).text, /running|archived-old/u);
  await f.handle.handleInbound(message('/session cold-old', 'select-explicit-bound'));
  assert.match(f.sends.at(-1).text, /已选择回复会话/u);
  await f.handle.handleInbound(message('继续历史讨论', 'prompt-cold-old'));
  assert.equal(f.prompts.at(-1)?.sessionId, 'cold-old');
  await f.handle.handleInbound(message('/session add cold-old', 'idempotent-add'));
  assert.match(f.sends.at(-1).text, /已经绑定/u);
  assert.deepEqual((await f.request('sessions')).body.sessions.map(s => s.sessionId), ['cold-old']);
});

test('archived, subagent, nonexistent, and unauthorized sessions cannot be manually bound', async t => {
  const f = await fixture(t, { prebound: false, records: [
    { id: 'archived', archived: true, header: { title: '归档' } },
    { id: 'child', header: { title: '子代理', origin: 'subagent', parentSessionId: 'root' } },
    { id: 'normal', header: { title: '正常' } },
  ] });
  await f.handle.handleInbound(message('/session add archived', 'archive-add'));
  assert.match(f.sends.at(-1).text, /不在未归档普通会话列表/u);
  await f.handle.handleInbound(message('/session add child', 'child-add'));
  assert.match(f.sends.at(-1).text, /不在未归档普通会话列表/u);
  await f.handle.handleInbound(message('/session add missing', 'missing-add'));
  assert.match(f.sends.at(-1).text, /不在未归档普通会话列表/u);
  const before = f.sends.length;
  await f.handle.handleInbound(message('/session add normal', 'intruder-add', 'stranger'));
  assert.equal(f.sends.length, before);
  await f.handle.handleInbound(message('/broadcast on normal', 'unbound-broadcast'));
  assert.match(f.sends.at(-1).text, /未绑定/u);
  const saved = await loadRouteStore(f.routeStorePath);
  assert.deepEqual(saved.listSessions(), []);
});

test('/list excludes archived, subagent and blank history without hiding legitimate forks or English titles', async t => {
  const rows = [
    { id: 'session-regular', header: { title: 'WPS灵犀代理模型接入方案', cwd: 'E:/Temp' } },
    { id: 'normal-english', header: { title: 'Complete Loomy Client Implementation', cwd: 'E:/Temp' } },
    { id: 'subagent-english', header: { title: 'Goal: transform the existing 826-line', origin: 'subagent', parentSession: 'session-regular' } },
    { id: 'subagent-chinese', header: { title: '内部执行任务', origin: 'subagent', parentSession: 'session-regular' } },
    { id: 'normal-fork', header: { title: '正常分支会话', parentSession: 'session-regular' } },
    { id: 'archived-session', header: { title: '以前归档的工作', cwd: 'E:/Temp' }, archived: true },
    { id: 'empty-session', header: { title: '', cwd: 'E:/Temp' }, blank: true },
  ];
  const f = await fixture(t, { records: rows, prebound: false });
  await f.handle.handleInbound(message('/list', 'filtered-1'));
  const output = f.sends.map(s => s.text).join('\n');
  assert.match(output, /未归档普通会话（3 个/u);
  assert.match(output, /session-regular/u);
  assert.match(output, /normal-english/u);
  assert.match(output, /normal-fork/u);
  assert.doesNotMatch(output, /subagent-english|subagent-chinese|archived-session|empty-session/u);
  assert.doesNotMatch(output, /以前归档的工作|Goal: transform|内部执行任务/u);
  assert.equal((await f.request('status')).body.inventoryStatus.visibleCount, 3);
  for (const id of ['subagent-english', 'subagent-chinese', 'archived-session', 'empty-session']) {
    const before = f.sends.length;
    await f.handle.handleInbound(message('/session add ' + id, 'reject-hidden-' + id));
    assert.match(f.sends.slice(before).map(s => s.text).join('\n'), /不在未归档普通会话列表/u);
  }
  await f.handle.handleInbound(message('/session add normal-fork', 'permit-fork'));
  assert.match(f.sends.at(-1).text, /已手动绑定/u);
  const bound = await loadRouteStore(f.routeStorePath);
  assert.deepEqual(bound.listSessions().map(s => s.sessionId), ['normal-fork']);
});

test('archive updates filter visible /list rows without deleting manual binding preferences', async t => {
  const rows = [{ id: 'ordinary', header: { title: '普通会话' } }, { id: 'arch', archived: false, header: { title: '随后归档' } }];
  const f = await fixture(t, { records: rows, prebound: false });
  await f.handle.handleInbound(message('/session add arch', 'bind-before-archive'));
  await f.handle.handleInbound(message('/broadcast off arch', 'mute-before-archive'));
  rows[1].archived = true;
  await f.handle.handleInbound(message('/list', 'list-after-archive'));
  assert.doesNotMatch(f.sends.at(-1).text, /arch|随后归档/u);
  const store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('arch').archived, true);
  assert.equal(store.getSession('arch').broadcastEnabled, false);
  rows[1].archived = false;
  await f.handle.handleInbound(message('/list', 'list-after-unarchive'));
  assert.match(f.sends.at(-1).text, /随后归档/u);
  const restored = await loadRouteStore(f.routeStorePath);
  assert.equal(restored.getSession('arch').broadcastEnabled, false);
});
test('/list pagination covers cold history without auto-binding, while /session paginates bound records', async t => {
  const records = Array.from({ length: 43 }, (_, index) => ({
    id: 'history-' + String(index).padStart(2, '0'),
    header: { title: '历史会话-' + index },
  }));
  const f = await fixture(t, { prebound: false, records });
  await f.handle.handleInbound(message('/list', 'page-1'));
  const firstPage = f.sends.map(s => s.text).join('\n');
  assert.match(firstPage, /第 1\/3 页/u);
  assert.match(firstPage, /\/list -p 2/u);
  assert.doesNotMatch(firstPage, /history-42/u);
  const page3Offset = f.sends.length;
  await f.handle.handleInbound(message('/list -p 3', 'page-3'));
  assert.match(f.sends.slice(page3Offset).map(s => s.text).join('\n'), /history-42/u);
  assert.equal((await f.request('sessions')).body.sessions.length, 0);
  for (const row of records) {
    await f.handle.handleInbound(message('/session add ' + row.id, 'manual-' + row.id));
  }
  const boundOffset = f.sends.length;
  await f.handle.handleInbound(message('/session', 'bound-page-1'));
  assert.match(f.sends.slice(boundOffset).map(s => s.text).join('\n'), /已绑定会话（43 个，第 1\/3 页）/u);
  await f.handle.handleInbound(message('/session -p 3', 'bound-page-3'));
  assert.match(f.sends.at(-1).text, /已绑定会话（43 个，第 3\/3 页）/u);
});

test('when archive registry is unavailable, /list does not claim non-archived and add is blocked', async t => {
  const f = await fixture(t, { prebound: false, records: [
    { id: 'unknown-archive', header: { title: '状态未知' } },
  ], archiveRegistryUnavailable: true });
  await f.handle.handleInbound(message('/list', 'unknown-archive-list'));
  assert.match(f.sends.at(-1).text, /无法确认 DSH 完整会话目录或归档状态/u);
  await f.handle.handleInbound(message('/session add unknown-archive', 'unknown-archive-add'));
  assert.match(f.sends.at(-1).text, /无法核实完整会话目录或归档状态/u);
  assert.deepEqual((await f.request('sessions')).body.sessions, []);
});
test('pre-existing explicit bindings remain bound; archived unknown sessions remain discovery-only', async t => {
  const f = await fixture(t);
  const sessions = await f.request('sessions');
  assert.equal(sessions.statusCode, 200);
  assert.deepEqual(sessions.body.sessions.map(s => s.sessionId).sort(), ['s1', 's2']);
  assert.ok(sessions.body.sessions.every(s => s.bound === true && s.broadcastEnabled));
  const store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('s-old'), null, 'an archived historical row must not be auto-bound');
  assert.equal(store.getSession('s1').title, '正在写小说');
  await f.handle.handleInbound(message('/list', 'list-archived-historical'));
  assert.ok(f.sends.some(s => s.text.includes('s1') && s.text.includes('s2')));
  assert.ok(f.sends.every(s => !s.text.includes('s-old')));
});

test('idle newly discovered sessions appear only in /list, never auto-bind or broadcast', async t => {
  const records = [{ id: 'existing', header: { title: '已有' } }];
  const f = await fixture(t, { records, prebound: false, inventoryPollMs: 30 });
  assert.equal((await f.request('sessions')).body.sessions.length, 0);
  records.push({ id: 'idle-new', header: { title: '暂未发言的新对话' } });
  let listed = false;
  for (let i = 0; i < 30; i++) {
    await f.handle.handleInbound(message('/list', 'idle-list-' + i));
    if (f.sends.at(-1)?.text.includes('idle-new')) { listed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(listed, true);
  const store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('idle-new'), null);
  await f.handle.handleInbound(message('/session', 'idle-bound-list'));
  assert.match(f.sends.at(-1).text, /尚未绑定会话/u);
  await answer(f.handle.engine, records[1], 22, '未绑定不能广播');
  assert.equal(f.sends.some(s => s.text.includes('未绑定不能广播')), false);
});

test('missing Session is not misclassified as archived; explicit archive and restore are authoritative', async t => {
  const records = [{ id: 'stays' }, { id: 'will-archive' }];
  const f = await fixture(t, { records });
  let store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('will-archive').archived, false);
  records.splice(1, 1);
  await f.handle.syncSessionInventory();
  store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('will-archive').archived, false,
    'missing a persisted list row is not proof of archive');
  records.push({ id: 'will-archive', archived: true });
  await f.handle.syncSessionInventory();
  store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('will-archive').archived, true);
  records[1].archived = false;
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

test('new Session events never auto-bind, and existing preferences are unchanged', async t => {
  const f = await fixture(t);
  const disabled = await f.request('sessions', 'POST', { sessionId: 's1', broadcastEnabled: false });
  assert.equal(disabled.body.sessions.find(x => x.sessionId === 's1').broadcastEnabled, false);
  const observer = f.handlers.find(h => h.eventName === 'session/event').fn;
  observer({ id: 'fresh', header: {} }, { type: 'session/title', data: { title: '刚创建的对话' } });
  await new Promise(resolve => setTimeout(resolve, 60));
  const store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.getSession('fresh'), null);
  assert.equal(store.getSession('s1').broadcastEnabled, false);
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

test('partial or unrecognized DSH directory cannot reclassify or auto-bind sessions', async t => {
  let mode = 'complete';
  const records = [{ id: 's1', header: { title: '第一条' } }, { id: 's2', header: { title: '第二条' } }];
  const f = await fixture(t, { records, controllerListResult: rows => mode === 'complete'
    ? { items: rows.map(row => ({ sessionId: row.id, projections: { values: { title: row.header.title } } })) }
    : mode === 'partial' ? { items: [{ sessionId: 's1' }], hasMore: true, total: 2 }
      : { unknown: 'shape' } });
  assert.equal((await f.request('status')).body.inventoryStatus.complete, true);
  mode = 'partial';
  const response = await f.request('sessions');
  assert.equal(response.body.sessions.length, 2);
  assert.equal(response.body.inventoryStatus.complete, false);
  let stored = await loadRouteStore(f.routeStorePath);
  assert.equal(stored.getSession('s2').archived, false);
  await f.handle.handleInbound(message('/list', 'partial-list-message'));
  assert.match(f.sends.at(-1).text, /无法确认 DSH 完整会话目录或归档状态/u);
  mode = 'unknown';
  const unknown = await f.request('status');
  assert.equal(unknown.body.inventoryStatus.supported, false);
  stored = await loadRouteStore(f.routeStorePath);
  assert.equal(stored.getSession('s2').archived, false);
});
test('DSH persistent list is authoritative; loaded-session Maps are not a complete catalog', async t => {
  const f = await fixture(t, { prebound: false, records: [
    { id: 'alpha', title: 'Host 历史会话' },
  ], listResult: () => ({ sessions: new Map([['mapped', { title: '仅内存可见' }]]), complete: true }) });
  assert.equal((await f.request('sessions')).body.sessions.length, 0);
  await f.handle.handleInbound(message('/list', 'persistent-list-primary'));
  assert.match(f.sends.at(-1).text, /alpha/u);
  assert.doesNotMatch(f.sends.at(-1).text, /mapped/u);
});
test('unknown persistent directory shape cannot wipe previous bindings', async t => {
  let bad = false;
  const f = await fixture(t, { controllerListResult: rows => bad
    ? { data: [{ session_id: 'unverified', title: '不受支持' }], complete: true }
    : { items: rows.map(row => ({ sessionId: row.id, projections: { values: { title: row.header?.title } } })) } });
  assert.equal((await f.request('status')).body.inventoryStatus.complete, true);
  bad = true;
  const response = await f.request('sessions');
  assert.equal(response.body.inventoryStatus.supported, false);
  assert.deepEqual(response.body.sessions.map(row => row.sessionId).sort(), ['s1', 's2']);
  await f.handle.handleInbound(message('/list', 'unknown-list-shape'));
  assert.match(f.sends.at(-1).text, /无法确认 DSH 完整会话目录或归档状态/u);
  assert.equal((await loadRouteStore(f.routeStorePath)).getSession('s1').bound, true);
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
  assert.equal(response.version, '0.4.16');
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

test('legacy v1 reply route stays bound but archived discovered history cannot be toggled', async t => {
  const f = await fixture(t, { legacyRoutes: { version: 1, users: {
    owner: { sessionId: 's2', title: '原路由', cwd: 'E:/Temp', updatedAt: 1 },
  } } });
  const store = await loadRouteStore(f.routeStorePath);
  assert.equal(store.get('owner').sessionId, 's2');
  assert.equal(store.getSession('s2').bound, true);
  assert.equal(store.getSession('s-old'), null);
  const response = await f.request('sessions', 'POST', { sessionId: 's-old', broadcastEnabled: false });
  assert.equal(response.statusCode, 404);
  await f.handle.handleInbound(message('/list', 'old-archive-from-v1'));
  assert.doesNotMatch(f.sends.at(-1).text, /s-old|已归档/u);
  await answer(f.handle.engine, f.records[2], 1, 'archived');
  assert.equal(f.sends.some(s => s.text.includes('archived')), false);
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
