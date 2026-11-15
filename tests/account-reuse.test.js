import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function ctxStub(services = {}) {
  const registered = [];
  const all = {
    settings: { describe: () => [{ ns: 'dsh-wechat-allsessions' }], mutate: async () => ({}), configure: () => {} },
    webServer: { register: (r) => { registered.push(r); return () => {}; } },
    sessions: { list: () => [] },
    sessionController: { resume: async () => {}, prompt: async () => ({ accepted: true }) },
    credentials: { resolve: async () => ({ value: 'token' }) },
    ...services,
  };
  return { fiber: { entry: { options: { id: 'dsh-wechat-allsessions' } } }, get: (k) => all[k], on: () => () => {}, effect() {}, inject() {}, logger: { warn() {}, info() {} }, registered };
}

test('standalone plugin reuses dsh-im account files without importing dsh-im', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-standalone-'));
  const accountPath = join(dir, 'config.json');
  await writeFile(accountPath, JSON.stringify({ version: 1, accounts: [{ botId: 'wx_test', accountId: 'acc', tokenRef: 'DSH_WEIXIN_BOT_TOKEN_TEST', baseUrl: 'https://ilinkai.weixin.qq.com/' }] }));
  const resolved = [];
  const transport = {
    getUpdates: async ({ getUpdatesBuf }) => ({ ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }),
    sendText: async () => ({ sent: true }),
    beginLogin: async () => ({ qrcode: 'q' }),
    pollLogin: async () => ({ status: 'wait' }),
  };
  const ctx = ctxStub({ credentials: { resolve: async (ref) => { resolved.push(ref); return { value: 'secret-token' }; } } });
  const handle = apply(ctx, {
    enabled: false, accountConfigPath: accountPath,
    statePath: join(dir, 'accounts'), routeStorePath: join(dir, 'sessions.json'),
  }, { transport, autoStart: false });
  await handle.start();
  assert.equal(handle.started, true);
  assert.deepEqual(resolved, ['DSH_WEIXIN_BOT_TOKEN_TEST']);
  handle.stop();
});

test('submitPrompt uses the real SessionController.prompt(request, signal) signature', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-prompt-'));
  const accountPath = join(dir, 'config.json');
  await writeFile(accountPath, JSON.stringify({ version: 1, accounts: [{ botId: 'wx_test', tokenRef: 'REF' }] }));
  const seen = [];
  const ctx = ctxStub({ credentials: { resolve: async () => ({ value: 'secret' }) }, sessionController: {
    prompt: async (request, signal) => {
      signal.throwIfAborted();
      seen.push(request);
      return { accepted: true };
    },
  } });
  const handle = apply(ctx, { enabled: false, accountConfigPath: accountPath, statePath: join(dir, 'accounts') }, {
    autoStart: false,
    transport: { notifyStart: async () => ({ ret: 0 }), notifyStop: async () => ({ ret: 0 }) },
  });
  await handle.start();
  await handle.submitPrompt('s1', 'hello');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 's1');
  assert.equal(seen[0].content[0].text, 'hello');
  assert.ok(seen[0].requestId.startsWith('wechat-allsessions-'));
  await handle.stop();
});

test('startup fails closed when the credential is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bad-'));
  const accountPath = join(dir, 'config.json');
  await writeFile(accountPath, JSON.stringify({ version: 1, accounts: [{ botId: 'wx_test', tokenRef: 'DSH_WEIXIN_BOT_TOKEN_TEST' }] }));
  const ctx = ctxStub({ credentials: { resolve: async () => ({ value: '' }) } });
  const handle = apply(ctx, { enabled: false, accountConfigPath: accountPath, statePath: join(dir, 'accounts') }, { autoStart: false });
  await assert.rejects(() => handle.start(), /token is empty|no reusable/);
  handle.stop();
});
