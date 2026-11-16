// Self-contained binding: a confirmed iLink scan must be enough to create the
// account, with no @xmanrui/dsh-im installation present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveWeixinBotIdentity, accountFromConfirmed } from '../lib/transport.js';
import { readAccountDocument, provisionAccount } from '../lib/account.js';

function memoryCredentials(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async set(ref, value) { store.set(ref, value); },
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref) } : {}; },
    async unset(ref) { store.delete(ref); },
  };
}

const CONFIRMED = Object.freeze({
  status: 'confirmed',
  bot_token: 'bot-token-abc',
  ilink_bot_id: 'ilink-bot-xyz',
  ilink_user_id: 'owner-user-1',
  baseurl: 'https://ilinkai.weixin.qq.com/',
});

test('identity is derived deterministically from the account id', () => {
  const first = deriveWeixinBotIdentity('ilink-bot-xyz');
  const second = deriveWeixinBotIdentity('ilink-bot-xyz');
  assert.deepEqual(first, second);
  assert.match(first.botId, /^wx_[a-f0-9]{24}$/);
  assert.match(first.tokenRef, /^DSH_WEIXIN_BOT_TOKEN_[A-F0-9]{24}$/);
  assert.notDeepEqual(deriveWeixinBotIdentity('other-bot'), first);
  assert.throws(() => deriveWeixinBotIdentity(''), TypeError);
});

test('a confirmed response yields a complete account record', () => {
  const { account, token } = accountFromConfirmed(CONFIRMED, 'https://ilinkai.weixin.qq.com/');
  assert.equal(token, 'bot-token-abc');
  assert.equal(account.accountId, 'ilink-bot-xyz');
  assert.equal(account.ownerUserId, 'owner-user-1');
  const identity = deriveWeixinBotIdentity('ilink-bot-xyz');
  assert.equal(account.botId, identity.botId);
  assert.equal(account.tokenRef, identity.tokenRef);
});

test('an incomplete confirmation is rejected rather than half-written', () => {
  for (const missing of ['bot_token', 'ilink_bot_id', 'ilink_user_id']) {
    const partial = { ...CONFIRMED };
    delete partial[missing];
    assert.throws(() => accountFromConfirmed(partial, 'https://ilinkai.weixin.qq.com/'),
      /incomplete account credentials/, missing + ' must be required');
  }
});

test('provisioning writes both the credential and the account document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'allsessions-bind-'));
  try {
    const configPath = join(dir, 'config.json');
    const credentials = memoryCredentials();
    const { account, token } = accountFromConfirmed(CONFIRMED, 'https://ilinkai.weixin.qq.com/');

    const result = await provisionAccount({ credentials, configPath, account, token });
    assert.equal(result.botId, account.botId);

    assert.equal(credentials.store.get(account.tokenRef), 'bot-token-abc');

    const document = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(document.version, 1);
    assert.equal(document.accounts.length, 1);
    assert.equal(document.accounts[0].botId, account.botId);
    assert.equal(document.accounts[0].accountId, 'ilink-bot-xyz');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('re-binding the same account replaces its entry instead of duplicating it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'allsessions-rebind-'));
  try {
    const configPath = join(dir, 'config.json');
    const credentials = memoryCredentials();
    const first = accountFromConfirmed(CONFIRMED, 'https://ilinkai.weixin.qq.com/');
    await provisionAccount({ credentials, configPath, account: first.account, token: first.token });

    const rescanned = accountFromConfirmed({ ...CONFIRMED, bot_token: 'rotated-token' }, 'https://ilinkai.weixin.qq.com/');
    await provisionAccount({ credentials, configPath, account: rescanned.account, token: rescanned.token });

    const document = await readAccountDocument(configPath);
    assert.equal(document.accounts.length, 1, 'a re-scan must not add a second account');
    assert.equal(credentials.store.get(rescanned.account.tokenRef), 'rotated-token', 'the token must be rotated');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a missing config file reads as an empty document', async () => {
  const document = await readAccountDocument(join(tmpdir(), 'allsessions-does-not-exist', 'config.json'));
  assert.deepEqual(document, { version: 1, accounts: [] });
});

test('provisioning refuses to run without a writable credential store', async () => {
  const { account, token } = accountFromConfirmed(CONFIRMED, 'https://ilinkai.weixin.qq.com/');
  await assert.rejects(() => provisionAccount({ credentials: {}, configPath: join(tmpdir(), 'x.json'), account, token }),
    /cannot store a WeChat bot token/);
});
