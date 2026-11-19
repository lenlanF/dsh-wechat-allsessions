// Self-contained binding: a confirmed iLink scan must be enough to create the
// account, with no @xmanrui/dsh-im installation present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveWeixinBotIdentity, accountFromConfirmed } from '../lib/transport.js';
import { readAccountDocument, provisionAccount, removeSavedAccount } from '../lib/account.js';

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

test('new QR binding preserves legacy and unrelated account records exactly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'allsessions-preserve-'));
  try {
    const configPath = join(dir, 'config.json');
    const old = { botId: 'old-profile-account', ownerUserId: 'old-owner',
      tokenRef: 'LEGACY_CREDENTIAL', createdAt: '2026-01-01' };
    const extra = { botId: 'other-profile-account', ownerUserId: 'other-owner',
      tokenRef: 'OTHER_CREDENTIAL', metadata: { source: 'legacy' } };
    await writeFile(configPath, JSON.stringify({ version: 1, accounts: [old, extra] }), 'utf8');
    const credentials = memoryCredentials();
    const next = accountFromConfirmed(CONFIRMED, 'https://ilinkai.weixin.qq.com/');
    await provisionAccount({ credentials, configPath, account: next.account, token: next.token });
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.accounts.length, 3);
    assert.deepEqual(saved.accounts[1], old);
    assert.deepEqual(saved.accounts[2], extra);
    assert.equal(credentials.store.get(next.account.tokenRef), next.token);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt account documents are never erased by a new QR bind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'allsessions-corrupt-account-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, '{"accounts":');
    const credentials = memoryCredentials();
    const next = accountFromConfirmed(CONFIRMED, 'https://ilinkai.weixin.qq.com/');
    await assert.rejects(() => provisionAccount({ credentials, configPath, account: next.account, token: next.token }), SyntaxError);
    assert.equal(await readFile(configPath, 'utf8'), '{"accounts":');
    assert.equal(credentials.store.size, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent QR additions and removal serialize without losing unrelated accounts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'allsessions-concurrent-'));
  try {
    const configPath = join(dir, 'config.json');
    const original = [
      { botId: 'legacy-one', tokenRef: 'shared-old-token', ownerUserId: 'a' },
      { botId: 'legacy-two', tokenRef: 'shared-second-token', ownerUserId: 'b' },
    ];
    await writeFile(configPath, JSON.stringify({ version: 1, accounts: original, metadata: 'preserve-me' }));
    const credentials = memoryCredentials({ 'shared-old-token': 'DO_NOT_ERASE' });
    const a = accountFromConfirmed(CONFIRMED, 'https://ilinkai.weixin.qq.com/');
    const b = accountFromConfirmed({ ...CONFIRMED,
      ilink_bot_id: 'second-new-account', ilink_user_id: 'another-owner', bot_token: 'another-token',
    }, 'https://ilinkai.weixin.qq.com/');
    const [boundA, removed, boundB] = await Promise.all([
      provisionAccount({ credentials, configPath, account: a.account, token: a.token }),
      removeSavedAccount({ configPath, botId: 'legacy-one' }),
      provisionAccount({ credentials, configPath, account: b.account, token: b.token }),
    ]);
    assert.equal(boundA.botId, a.account.botId);
    assert.equal(removed.removed, true);
    assert.equal(boundB.botId, b.account.botId);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.metadata, 'preserve-me');
    assert.deepEqual(new Set(saved.accounts.map(x => x.botId)),
      new Set(['legacy-two', a.account.botId, b.account.botId]));
    assert.deepEqual(saved.accounts.find(x => x.botId === 'legacy-two'), original[1]);
    assert.equal(credentials.store.get('shared-old-token'), 'DO_NOT_ERASE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('removal refuses to overwrite a corrupted account document or an unknown account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'allsessions-remove-corrupt-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, '{"accounts":', 'utf8');
    await assert.rejects(() => removeSavedAccount({ configPath, botId: 'any' }), SyntaxError);
    assert.equal(await readFile(configPath, 'utf8'), '{"accounts":');
    await writeFile(configPath, JSON.stringify({ accounts: [{ botId: 'one', tokenRef: 'shared' }] }));
    assert.deepEqual(await removeSavedAccount({ configPath, botId: 'not-present' }),
      { removed: false, remainingCount: 1 });
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).accounts.length, 1);
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
