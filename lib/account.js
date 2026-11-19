// Self-contained WeChat account provisioning.
//
// This plugin previously reused the account file written by @xmanrui/dsh-im.
// Provisioning is now handled here so a scan alone is enough: the confirmed
// iLink response carries the bot token, which is the only credential the
// runtime needs.
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { deriveWeixinBotIdentity } from './transport.js';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, accounts: Object.freeze([]) });

// Serialize QR registrations and account removals. They must never race to
// overwrite the same JSON account file with two different snapshots.
const accountMutations = new Map();
function withAccountLock(path, task) {
  const prior = accountMutations.get(path) ?? Promise.resolve();
  const pending = prior.catch(() => {}).then(task);
  const drained = pending.then(() => {}, () => {});
  accountMutations.set(path, drained);
  void drained.then(() => {
    if (accountMutations.get(path) === drained) accountMutations.delete(path);
  });
  return pending;
}

async function rawAccountDocument(path) {
  let doc;
  try { doc = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, accounts: [] };
    throw error; // Invalid or unreadable data must never be overwritten.
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.accounts)) {
    throw new Error('invalid saved WeChat account document; refusing to overwrite');
  }
  return doc;
}


function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Normalize one account record, dropping anything unusable. */
function normalizeAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const accountId = cleanString(value.accountId);
  const ownerUserId = cleanString(value.ownerUserId);
  const botId = cleanString(value.botId);
  const tokenRef = cleanString(value.tokenRef);
  if (!accountId || !ownerUserId || !botId || !tokenRef) return null;
  const derived = deriveWeixinBotIdentity(accountId);
  if (derived.botId !== botId || derived.tokenRef !== tokenRef) return null;
  return {
    botId,
    accountId,
    tokenRef,
    ownerUserId,
    ...(cleanString(value.baseUrl) ? { baseUrl: cleanString(value.baseUrl) } : {}),
    createdAt: cleanString(value.createdAt) ?? new Date().toISOString(),
    ...(cleanString(value.connectedAt) ? { connectedAt: cleanString(value.connectedAt) } : {}),
  };
}

/** Read the account document; a missing file is an empty document, not an error. */
export async function readAccountDocument(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const accounts = Array.isArray(raw?.accounts)
      ? raw.accounts.map(normalizeAccount).filter((account) => account !== null)
      : [];
    return { version: 1, accounts };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, accounts: [] };
    throw error;
  }
}

// Public settings roster: never expose token references, owner IDs or credential data.
export async function readAccountRoster(path, selectedBotId = '', isPolling = false) {
  let raw;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { accounts: [], savedCount: 0, activeCount: 0 };
    throw error;
  }
  const seen = new Set();
  const accounts = [];
  for (const entry of Array.isArray(raw?.accounts) ? raw.accounts : []) {
    const botId = cleanString(entry?.botId);
    const tokenRef = cleanString(entry?.tokenRef);
    if (!botId || !tokenRef || seen.has(botId)) continue;
    seen.add(botId);
    const name = [entry.displayName, entry.nickname, entry.name].find(v =>
      typeof v === 'string' && v.trim() && v.length <= 80)?.trim();
    const active = botId === selectedBotId;
    accounts.push({
      botId, label: name || '微信账号 ' + (accounts.length + 1),
      active, polling: active && isPolling, maskedId: '…' + botId.slice(-6),
    });
  }
  return { accounts, savedCount: accounts.length, activeCount: accounts.filter(x => x.polling).length };
}

/** Write the document atomically so a crash cannot truncate the account file. */
export async function writeAccountDocument(path, document) {
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify({ ...document, version: 1, accounts: document.accounts }, null, 2);
  // Unique sibling temporary file avoids collisions across concurrent writes.
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Persist one confirmed account and its token.
 * The credential is written before the account record so a reader never sees an
 * account whose token cannot be resolved. An existing entry with the same botId
 * is replaced in place, which keeps the account idempotent across re-scans.
 */
export async function provisionAccount({ credentials, configPath, account, token }) {
  if (!credentials || typeof credentials.set !== 'function') {
    throw new Error('credentials service cannot store a WeChat bot token');
  }
  return withAccountLock(configPath, async () => {
    const existing = await rawAccountDocument(configPath);
    const oldAccounts = existing.accounts;
    const replaced = oldAccounts.some(item => item?.botId === account.botId);
    const accounts = [account, ...oldAccounts.filter(item => item?.botId !== account.botId)];
    // Persist credential first, then publish the account record atomically.
    await credentials.set(account.tokenRef, token);
    await writeAccountDocument(configPath, { ...existing, accounts });
    return { botId: account.botId, configPath, replaced };
  });
}

/**
 * Unlink one account from this plugin, retaining credentials managed by the
 * Host. Other plugins may reuse the same token; revoking it here is unsafe.
 * onBeforeWrite lets the caller stop its active poller and persist any
 * selection fallback before the account record is removed.
 */
export async function removeSavedAccount({ configPath, botId, onBeforeWrite } = {}) {
  const normalizedId = cleanString(botId);
  if (!normalizedId || normalizedId.length > 256) throw new TypeError('valid botId required');
  return withAccountLock(configPath, async () => {
    const existing = await rawAccountDocument(configPath);
    const selected = existing.accounts.find(a => a?.botId === normalizedId);
    if (!selected) return { removed: false, remainingCount: existing.accounts.length };
    const accounts = existing.accounts.filter(a => a?.botId !== normalizedId);
    const fallbackBotId = accounts.find(a => cleanString(a?.botId))?.botId ?? '';
    if (onBeforeWrite) await onBeforeWrite({ fallbackBotId });
    await writeAccountDocument(configPath, { ...existing, accounts });
    return { removed: true, remainingCount: accounts.length, fallbackBotId };
  });
}
