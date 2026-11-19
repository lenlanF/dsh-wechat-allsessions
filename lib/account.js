// Self-contained WeChat account provisioning.
//
// This plugin previously reused the account file written by @xmanrui/dsh-im.
// Provisioning is now handled here so a scan alone is enough: the confirmed
// iLink response carries the bot token, which is the only credential the
// runtime needs.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deriveWeixinBotIdentity } from './transport.js';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, accounts: Object.freeze([]) });

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
  const payload = JSON.stringify({ version: 1, accounts: document.accounts }, null, 2);
  const tmp = path + '.tmp';
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, path);
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
  // Old profiles contain valid reusable entries that do not meet the current
  // strict normalization schema. Never discard them during a new QR binding.
  let existing;
  try { existing = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') existing = { version: 1, accounts: [] };
    else throw error; // Corrupt or unreadable files fail closed, not overwritten.
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)
    || !Array.isArray(existing.accounts)) {
    throw new Error('invalid saved WeChat account document; refusing to overwrite');
  }
  const oldAccounts = existing.accounts;
  const replaced = oldAccounts.some(item => item?.botId === account.botId);
  const accounts = [account, ...oldAccounts.filter(item => item?.botId !== account.botId)];
  // Persist credential first, then publish the account record atomically.
  await credentials.set(account.tokenRef, token);
  await writeAccountDocument(configPath, { version: 1, accounts });
  return { botId: account.botId, configPath, replaced };
}
