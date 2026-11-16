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
  await credentials.set(account.tokenRef, token);
  const document = await readAccountDocument(configPath);
  const accounts = document.accounts.filter((existing) => existing.botId !== account.botId);
  accounts.unshift(account);
  await writeAccountDocument(configPath, { version: 1, accounts });
  return { botId: account.botId, configPath, replaced: accounts.length === document.accounts.length };
}
