/**
 * dsh-wechat-allsessions — standalone WeChat iLink bridge for all DSH sessions.
 * Requires no @xmanrui/dsh-im plugin. Uses DSH credentials + sessionController.
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

import { createWeixinTransport, extractWeixinText, accountFromConfirmed, QR_BASE_URL, DEFAULT_API_BASE_URL } from './transport.js';
import { provisionAccount, readAccountRoster, removeSavedAccount } from './account.js';
import { normalizeSessionInventory } from './inventory.js';
import { loadRouteStore, parseRouteCommand, normalizeRoutes, isArchivedSession, WECHAT_HELP } from './router.js';
import { buildBroadcastMessage, planDelivery } from './text.js';
import { createBroadcastEngine } from './events.js';import { createDesktopRestartDriver, restartTicketPath, readRestartTicket, writeRestartTicket, ticketActive, ticketReadyToNotify, RESTART_TTL_MS } from './restart.js';

let z;
try { z = (await import('@deepseek-ai/schemastery')).default; }
catch {
  const roots = [process.env.DSH_PROFILE_DIR, ...(process.env.USERPROFILE ? [join(process.env.USERPROFILE, '.dsh/profiles/desktop')] : []), join(homedir(), '.dsh/profiles/desktop')].filter(Boolean);
  let loaded = false;
  for (const root of roots) {
    const esm = join(root, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs');
    if (!existsSync(esm)) continue;
    try { z = (await import(pathToFileURL(esm).href)).default; loaded = true; break; } catch { /* next */ }
  }
  if (!loaded) throw new Error('dsh-wechat-allsessions: schemastery is not resolvable');
}

export const name = 'dsh-wechat-allsessions';
export const version = '0.4.6';
export const inject = ['settings', 'webServer', 'sessions', 'sessionController', 'credentials'];

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  broadcastAll: z.boolean().default(true).volatile(),
  defaultUserId: z.string().default('').volatile(),  activeBotId: z.string().default('').volatile(),
  maxChunkBytes: z.number().min(100).default(1500).volatile(),
  routeStorePath: z.string().default('').volatile(),
  accountConfigPath: z.string().default('').volatile(),
  statePath: z.string().default('').volatile(),
  includeSessionHint: z.boolean().default(true).volatile(),
  includeInternal: z.boolean().default(true).volatile(),
  includeSubagents: z.boolean().default(true).volatile(),
  format: z.union([z.const('plain'), z.const('markdown')]).default('plain').volatile(),
  sendLogLimit: z.number().min(1).default(20).volatile(),
});

export const DEFAULT_RULES = Object.freeze({
  enabled: true, broadcastAll: true, defaultUserId: '', activeBotId: '', maxChunkBytes: 1500,
  routeStorePath: '', accountConfigPath: '', statePath: '',
  includeSessionHint: true, includeInternal: true, includeSubagents: true,
  format: 'plain', sendLogLimit: 20,
});

export function unwrapVolatile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v]));
}

export function normalizeRules(input) {
  const raw = { ...DEFAULT_RULES, ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}) };
  const str = (v, max = 4096) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const int = (v, fallback, cap) => Number.isSafeInteger(v) && v >= 1 ? Math.min(v, cap) : fallback;
  return {
    enabled: raw.enabled === true,
    broadcastAll: raw.broadcastAll === true,
    defaultUserId: str(raw.defaultUserId, 256),    activeBotId: str(raw.activeBotId, 256),
    maxChunkBytes: int(raw.maxChunkBytes, 1500, 8000),
    routeStorePath: str(raw.routeStorePath),
    accountConfigPath: str(raw.accountConfigPath),
    statePath: str(raw.statePath),
    includeSessionHint: raw.includeSessionHint !== false,
    includeInternal: raw.includeInternal === true,
    includeSubagents: raw.includeSubagents === true,
    format: raw.format === 'markdown' ? 'markdown' : 'plain',
    sendLogLimit: int(raw.sendLogLimit, 20, 200),
  };
}

const json = (res, status, value) => {
  res.statusCode = status;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
};
function readBody(req, maxBytes = 1_048_576) {
  return new Promise((ok, bad) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { bad(new Error('request body too large')); req.destroy?.(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      // An empty body is legitimate here: requesting a QR code is a bodyless POST.
      if (text === '') { ok({}); return; }
      try { ok(JSON.parse(text)); } catch (e) { bad(e); }
    });
    req.on('error', bad);
  });
}
async function saveConfig(ctx, change) {
  const settings = ctx.get?.('settings');
  const rows = settings?.describe?.() ?? [];
  const row = rows.find(r => r.ns === name) ?? rows.find(r => String(r.ns).includes(name));
  if (!row) throw new Error('no configurable ' + name + ' entry');
  await settings.mutate(row.ns, Object.entries(change).map(([field, value]) => ({ op: 'set', path: [field], value })), undefined);
  return { ns: row.ns, fields: Object.keys(change) };
}

function homePaths(rules) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return {
    accounts: rules.accountConfigPath || join(home, 'integrations', 'dsh-weixin', 'config.json'),
    state: rules.statePath || join(home, 'integrations', 'dsh-weixin', 'accounts'),
    routes: rules.routeStorePath || join(home, 'integrations', 'dsh-wechat-allsessions', 'sessions.json'),
  };
}

async function loadAccount(credentials, configPath, selectedBotId = '') {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const all = Array.isArray(raw?.accounts) ? raw.accounts : [];
  const account = selectedBotId ? all.find(x => x?.botId === selectedBotId) : all[0];
  if (!account?.tokenRef || !account?.botId) {
    throw new Error(selectedBotId ? 'selected WeChat account is not in the saved account list' : 'no reusable WeChat account');
  }
  const resolved = await credentials.resolve(account.tokenRef);
  const token = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
  if (!token) throw new Error('WeChat token is empty for selected account');
  return {
    botId: account.botId,
    token,
    tokenRef: account.tokenRef,
    ownerUserId: typeof account.ownerUserId === 'string' ? account.ownerUserId.trim() : '',
    baseUrl: typeof account.baseUrl === 'string' ? account.baseUrl : DEFAULT_API_BASE_URL,
  };
}

async function readState(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return {
      getUpdatesBuf: typeof raw.getUpdatesBuf === 'string' ? raw.getUpdatesBuf : '',
      contextTokens: raw.contextTokens && typeof raw.contextTokens === 'object' ? raw.contextTokens : { users: {} },
      seenMessageIds: Array.isArray(raw.seenMessageIds) ? raw.seenMessageIds : [],
      lastContextToken: typeof raw.lastContextToken === 'string' ? raw.lastContextToken : '',
      users: raw.users && typeof raw.users === 'object' ? raw.users : {},
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { getUpdatesBuf: '', contextTokens: { users: {} }, seenMessageIds: [], lastContextToken: '', users: {} };
  }
}
async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

function describeSession(session) {
  const header = session?.header ?? {};
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events;
  let title = typeof session?.title === 'string' ? session.title
    : typeof header.title === 'string' ? header.title : '';
  if (Array.isArray(events)) for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'session/title' && typeof events[i].data?.title === 'string') { title = events[i].data.title; break; }
  }
  const archived = isArchivedSession(session) ? true
    : session?.archived === false || header.archived === false ? false : undefined;
  return { cwd: typeof header.cwd === 'string' ? header.cwd : '', title,
    isSubagent: header.origin === 'subagent' || Boolean(header.parentSession), archived };
}

function sessionRecord(session, event) {
  const sessionId = session?.id ?? session?.sessionId ?? session?.session_id;
  const meta = describeSession(session);
  if (event?.type === 'session/archive' || event?.type === 'session/archived') meta.archived = true;
  if (event?.type === 'session/unarchive' || event?.type === 'session/unarchived') meta.archived = false;
  if (event?.type === 'session/title' && typeof event.data?.title === 'string') meta.title = event.data.title;
  return { sessionId, ...meta };
}

function readPersistedConfig(ctx) {
  try {
    const rows = ctx.get?.('settings')?.describe?.();
    if (!Array.isArray(rows)) return {};
    const id = ctx.fiber?.entry?.options?.id;
    const row = rows.find(r => r.ns === id) ?? rows.find(r => String(r.ns).includes(name));
    return unwrapVolatile(row?.value);
  } catch { return {}; }
}

export function apply(ctx, config = {}, internals = {}) {
  const initialDirect = unwrapVolatile(ctx.fiber?.entry?.options?.config);
  let rules = normalizeRules({ ...unwrapVolatile(config), ...readPersistedConfig(ctx), ...initialDirect });
  let sendLog = [];
  let routes = null;
  let routeLoading = null;
  let account = null;
  let bridgeState = null;
  let legacyContextTokens = Object.create(null);
  let statePath = '';
  let polling = false;  let pollHealthy = false;
  let stopped = false;
  let abort = new AbortController();
  let pollTask = null;
  let inventoryTimer = null;  let inventoryStatus = { available: false, supported: false, complete: false, source: 'not-queried', rawCount: 0, reportedTotal: null };
  const desktopRestart = internals.desktopRestart ?? createDesktopRestartDriver();
  let restartMonitorTimer = null;
  let restartNotificationBusy = false;
  let restartQueued = false;

  const logger = internals.logger ?? ctx.logger;
  const log = (level, text) => { try { logger?.[level]?.(text); } catch { /* optional */ } };
  const transport = internals.transport ?? createWeixinTransport({ fetchImpl: internals.fetchImpl, baseUrl: internals.baseUrl ?? DEFAULT_API_BASE_URL });
  const controller = internals.sessionController ?? ctx.get?.('sessionController');
  const credentials = internals.credentials ?? ctx.get?.('credentials');

  async function ensureRoutes() {
    if (routes) return routes;
    if (!routeLoading) {
      routeLoading = loadRouteStore(homePaths(rules).routes).then(store => { routes = store; return store; })
        .catch(error => { routeLoading = null; throw error; });
    }
    return routeLoading;
  }

  async function syncSessionInventory() {
    const store = await ensureRoutes();
    const service = internals.sessions ?? ctx.get?.('sessions') ?? ctx.sessions;
    if (typeof service?.list !== 'function') {
      inventoryStatus = { available: false, supported: false, complete: false, source: 'unavailable', rawCount: 0, reportedTotal: null };
      return store.listSessions();
    }
    let result;
    try { result = await service.list(); }
    catch (error) {
      inventoryStatus = { ...inventoryStatus, available: true, complete: false, source: 'list-error' };
      throw error;
    }
    const normalized = normalizeSessionInventory(result);
    inventoryStatus = {
      available: true, supported: normalized.supported, complete: normalized.complete,
      source: normalized.source, rawCount: normalized.rawCount,
      reportedTotal: normalized.reportedTotal, matched: normalized.records.length,
    };
    if (!normalized.supported) {
      log('warn', 'wechat-assistant: unknown Host session inventory shape; keeping known conversations');
      return store.listSessions();
    }
    await store.syncSessions(normalized.records.map(session => sessionRecord(session)), { authoritative: normalized.complete });
    return store.listSessions();
  }

  function beginInventoryWatch() {
    if (inventoryTimer) return;
    // Reconcile idle/new conversations even if DSH does not emit a session/event.
    inventoryTimer = setInterval(() => {
      void syncSessionInventory().catch(error => log('warn', 'wechat-assistant: inventory sync failed: ' + (error?.message ?? error)));
    }, Math.max(25, internals.inventoryPollMs ?? 15_000));
    inventoryTimer.unref?.();
  }


  const currentRules = () => ({ ...rules, buildMessage: (context, text) => buildBroadcastMessage({
    title: context.title, cwd: context.cwd, sessionId: context.sessionId, text,
    maxChars: 4000, includeHint: rules.includeSessionHint,
  }) });

  const engine = createBroadcastEngine({
    rules: currentRules(),
    describeSession: async (session) => describeSession(session),
    isImOwned: internals.isImOwned ?? ((rpcId) => typeof rpcId === 'string' && rpcId.startsWith('wechat-allsessions-')),
    send: async (context, text) => {
      if (!account) return { sent: false, reason: 'no-account' };
      const userId = rules.defaultUserId || account.ownerUserId || context.userId || context.senderId;
      if (!userId) return { sent: false, reason: 'no-user-id' };
      const contextToken = contextTokenFor(userId);
      if (!contextToken) return { sent: false, reason: 'no-context-token: send /help to the bot once' };
      const plan = planDelivery(text, { maxBytes: rules.maxChunkBytes, maxChunks: 20 });      if (plan.items.length === 0) return { sent: false, reason: 'no-complete-sentence-within-limit' };
      for (const part of plan.items) {
        const result = await transport.sendText({
          token: account.token, baseUrl: account.baseUrl, toUserId: userId,
          text: part, contextToken, signal: abort.signal,
        });
        if (result?.sent === false) return result;
      }
      // Preserve an explicit /session selection. Only bootstrap a missing reply route.
      const store = await ensureRoutes();
      if (!store.get(userId)) await store.set(userId, context.sessionId, { title: context.title, cwd: context.cwd });
      return { sent: true, chunks: plan.items.length, truncated: plan.truncated };
    },
    onLog: (entry) => { try { sendLog = [...sendLog, entry].slice(-Math.max(1, rules.sendLogLimit)); } catch { /* best effort */ } },
    logger,
    shouldSkip: async (context) => {
      if (!rules.broadcastAll || context.archived) return true;
      const store = await ensureRoutes();
      await store.syncSessions([{ ...context, sessionId: context.sessionId }]);
      const entry = store.getSession(context.sessionId);
      if (!context.title && entry?.title) context.title = entry.title;
      return !entry || entry.archived || entry.broadcastEnabled === false;
    },
  });

  async function submitPrompt(sessionId, text, idempotencyKey) {
    if (!controller || typeof controller.prompt !== 'function') throw new Error('sessionController.prompt unavailable');
    const rpcId = 'wechat-allsessions-' + (idempotencyKey
      ? createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32) : randomUUID());
    const result = await controller.prompt({ requestId: rpcId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, abort.signal);
    if (result?.accepted === false || result?.ok === false) throw new Error('DSH session controller rejected the prompt');
    return result;
  }

  function contextTokenFor(userId) {
    const nested = bridgeState?.contextTokens?.users?.[userId]?.token;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
    const flat = bridgeState?.contextTokens?.[userId]?.token ?? bridgeState?.contextTokens?.[userId]?.contextToken;
    if (typeof flat === 'string' && flat.trim()) return flat.trim();
    return legacyContextTokens[userId];
  }

  async function loadLegacyContextTokens(paths) {
    legacyContextTokens = Object.create(null);
    // Read-only migration: never reset or alter the preexisting dsh-im state.
    try {
      const legacy = JSON.parse(await readFile(join(paths.state, account.botId, 'state.json'), 'utf8'));
      for (const userId of [account.ownerUserId, rules.defaultUserId].filter(Boolean)) {
        const token = legacy?.contextTokens?.users?.[userId]?.token
          ?? legacy?.contextTokens?.[userId]?.token
          ?? legacy?.contextTokens?.[userId]?.contextToken;
        if (typeof token === 'string' && token.trim()) legacyContextTokens[userId] = token.trim();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log('warn', 'wechat-assistant: could not reuse legacy context state');
    }
  }

  async function reply(userId, text) {
    const at = Date.now();
    try {
      if (!account) throw new Error('no-account');
      const plan = planDelivery(text, { maxBytes: rules.maxChunkBytes, maxChunks: 20 });
      for (const part of plan.items) {
        const result = await transport.sendText({
          token: account.token, baseUrl: account.baseUrl, toUserId: userId,
          text: part, contextToken: contextTokenFor(userId), signal: abort.signal,
        });
        if (result?.sent === false) throw new Error(result?.reason || 'send-refused');
      }
      sendLog = [...sendLog, { at, kind: 'wechat-command', ok: true, chunks: plan.items.length }].slice(-Math.max(1, rules.sendLogLimit));
    } catch (error) {
      // Never write WeChat IDs, tokens or command payloads to logs.
      const reason = error?.code ?? (error?.message === 'no-account' ? 'no-account' : 'reply-failed');
      sendLog = [...sendLog, { at, kind: 'wechat-command', ok: false, reason }].slice(-Math.max(1, rules.sendLogLimit));
      throw error;
    }
  }


  function clearRestartMonitor() {
    if (restartMonitorTimer) { clearInterval(restartMonitorTimer); restartMonitorTimer = null; }
  }

  async function attemptRestartNotification() {
    if (restartNotificationBusy || !account || stopped || !rules.enabled) return;
    restartNotificationBusy = true;
    try {
      const file = restartTicketPath(homePaths(rules).state, account.botId);
      let ticket = await readRestartTicket(file);
      if (!ticket || ['notified', 'cancelled', 'timed-out', 'failed-notified'].includes(ticket.phase)) {
        clearRestartMonitor();
        return;
      }
      if (ticket.botId !== account.botId || (ticket.userId !== account.ownerUserId
        && (!rules.defaultUserId || ticket.userId !== rules.defaultUserId))) {
        clearRestartMonitor();
        return;
      }
      if (ticket.phase === 'failed') {
        if (!contextTokenFor(ticket.userId)) return;
        await reply(ticket.userId, 'DSH Desktop 重启未成功。请检查应用运行状态，未发送“重启完成”的确认。');
        await writeRestartTicket(file, { ...ticket, phase: 'failed-notified', notifiedAt: Date.now() });
        clearRestartMonitor();
        return;
      }
      if (!ticketActive(ticket)) {
        if (Date.now() >= Number(ticket.expiresAt)) {
          await writeRestartTicket(file, { ...ticket, phase: 'timed-out' });
          clearRestartMonitor();
        }
        return;
      }
      if (['armed', 'executing'].includes(ticket.phase) && contextTokenFor(ticket.userId)) {
        if (internals.autoStart !== false && !pollHealthy) return;
        // The worker may exit after Desktop relaunched but before recording
        // success. Reconcile only if the OLD PID is gone and the NEW root
        // matches the same verified Desktop executable.
        const current = await desktopRestart.inspect();
        if (current.pid !== ticket.oldMainPid && current.exePath === ticket.exePath) {
          let oldExited = false;
          try { process.kill(ticket.oldMainPid, 0); }
          catch (error) { if (error?.code === 'ESRCH') oldExited = true; }
          if (oldExited) {
            const latest = await readRestartTicket(file);
            if (latest?.requestId === ticket.requestId && ['armed', 'executing'].includes(latest.phase)) {
              ticket = { ...latest, phase: 'restarted', newMainPid: current.pid, finishedAt: Date.now() };
              await writeRestartTicket(file, ticket);
            }
          }
        }
      }
      if (ticket.phase !== 'restarted' || !contextTokenFor(ticket.userId)) return;
      if (internals.autoStart !== false && !pollHealthy) return;
      // The Desktop main PID must have changed, and the current Host must
      // have fully initialized its WeChat account before acknowledging success.
      const currentMain = await desktopRestart.inspect();
      if (!ticketReadyToNotify(ticket, {
        botId: account.botId, userId: ticket.userId, mainPid: currentMain.pid,
      })) return;
      // Never claim completion while the one-shot scheduled task, its worker,
      // or any old Desktop executable instance is still present.
      if (typeof desktopRestart.verifyClean === 'function') {
        await desktopRestart.verifyClean(file);
      }
      await reply(ticket.userId, '✅ DSH Desktop 已完成重启，微信助手已恢复连接。');
      await writeRestartTicket(file, { ...ticket, phase: 'notified', notifiedAt: Date.now() });
      clearRestartMonitor();
    } catch {
      // Keep the ticket for a bounded retry; never expose its private user ID.
      log('warn', 'wechat-assistant: desktop restart confirmation pending retry');
    } finally {
      restartNotificationBusy = false;
    }
  }

  async function beginRestartMonitor() {
    if (restartMonitorTimer || !account || stopped) return;
    const ticket = await readRestartTicket(restartTicketPath(homePaths(rules).state, account.botId));
    if (!ticket || !['armed', 'executing', 'restarted', 'failed'].includes(ticket.phase)) return;
    restartMonitorTimer = setInterval(() => { void attemptRestartNotification(); },
      Math.max(200, internals.restartMonitorMs ?? 3_000));
    restartMonitorTimer.unref?.();
    void attemptRestartNotification();
  }

  async function armDesktopRestart(userId) {
    if (!account) throw new Error('no-bound-wechat-account');
    const file = restartTicketPath(homePaths(rules).state, account.botId);
    let prior;
    try { prior = await readRestartTicket(file); }
    catch { throw Object.assign(new Error('restart-state-read-failed'), { code: 'restart-state-read-failed' }); }
    if (ticketActive(prior)) {
      await reply(userId, 'DSH Desktop 已有重启请求正在执行，不会重复重启。完成后会通过微信通知。');
      return null;
    }
    const main = await desktopRestart.inspect();
    const requestedAt = Date.now();
    const ticket = {
      version: 1, requestId: randomUUID(), phase: 'armed',
      botId: account.botId, userId, requestedAt,
      expiresAt: requestedAt + RESTART_TTL_MS,
      oldMainPid: main.pid, newMainPid: null, exePath: main.exePath,
    };
    try { await writeRestartTicket(file, ticket); }
    catch { throw Object.assign(new Error('restart-state-write-failed'), { code: 'restart-state-write-failed' }); }
    try {
      await reply(userId, '已收到 /restart，正在启动一次性重启任务。确认启动后会重启 DSH Desktop（当前任务可能中断）；完成并恢复微信连接后自动通知。');
    } catch (error) {
      await writeRestartTicket(file, { ...ticket, phase: 'cancelled' }).catch(() => {});
      throw Object.assign(new Error('restart-ack-failed'), { code: 'restart-ack-failed' });
    }
    return { file, ticket };
  }

  async function handleInbound(message) {
    const userId = typeof message?.from_user_id === 'string' ? message.from_user_id.trim() : '';
    const text = extractWeixinText(message);
    if (!userId || !text || message?.message_type === 2 || !rules.enabled) return;
    // Local DSH sessions are private. A random WeChat sender cannot bind or
    // enumerate sessions just because they know the bot's contact address.
    const owner = Boolean(account?.ownerUserId) && userId === account.ownerUserId;
    const explicitlyTrusted = Boolean(rules.defaultUserId) && userId === rules.defaultUserId;
    if (!owner && !explicitlyTrusted) {
      log('warn', 'wechat-allsessions: rejected untrusted sender');
      return;
    }
    const messageId = typeof message.message_id === 'string' ? message.message_id : String(message.message_id ?? '');
    if (messageId && bridgeState.seenMessageIds.includes(messageId)) return;
    if (typeof message.context_token === 'string' && message.context_token.trim()) {
      const nested = bridgeState.contextTokens?.users && typeof bridgeState.contextTokens.users === 'object'
        ? bridgeState.contextTokens.users : {};
      bridgeState.contextTokens = {
        ...(bridgeState.contextTokens ?? {}),
        users: { ...nested, [userId]: { token: message.context_token.trim() } },
      };
      // This state may be saved independently; it does not acknowledge the message.
      await writeState(statePath, bridgeState);
    }
    const store = await ensureRoutes();
    const command = parseRouteCommand(text);
    if (command && command.kind !== 'restart') await syncSessionInventory();
    let restartAction = null;
    if (command?.kind === 'help') {
      await reply(userId, WECHAT_HELP);
    } else if (command?.kind === 'restart') {
      if (restartQueued) {
        await reply(userId, 'DSH Desktop 重启已经开始，请勿重复发送 /restart。');
      } else {
        restartQueued = true;
        try {
          restartAction = await armDesktopRestart(userId);
        } catch (error) {
          restartQueued = false;
          // Avoid masking storage/transport failures as a process-detection error.
          const code = typeof error?.code === 'string' ? error.code : '';
          const reason = code === 'desktop-not-running' ? 'DSH Desktop 当前未运行'
            : code === 'desktop-root-ambiguous' ? '存在多个无法区分的 Desktop 根进程'
              : code === 'desktop-bundle-missing' ? '主程序安装包校验不通过'
                : code === 'restart-state-read-failed' ? '重启状态文件读取失败'
                  : code === 'restart-state-write-failed' ? '重启状态文件写入失败'
                    : code === 'restart-ack-failed' ? '微信重启受理回执未发送成功'
                      : 'Desktop 主进程检查未通过';
          const safeCode = /^[a-z][a-z0-9-]{0,48}$/.test(code) ? code : 'unknown';
          log('warn', 'wechat-assistant: desktop restart rejected; code=' + safeCode);
          await reply(userId, 'DSH Desktop 未执行重启：' + reason + '（' + safeCode + '）。');
        }
      }
    } else if (command?.kind === 'list' || command?.kind === 'broadcast-list') {
      const entries = store.listSessions();
      const list = entries.map(r => (r.broadcastEnabled ? '🟢' : '🔕') + ' ' + r.sessionId + '  ' + (r.title || '未命名对话'));
      await reply(userId, list.length ? '已自动绑定的未归档对话：\n' + list.join('\n') : '暂无未归档对话');
    } else if (command?.kind === 'clear') {
      await store.clear(userId);
      await reply(userId, '已清除当前微信回复路由；其他会话自动广播不受影响');
    } else if (command?.kind === 'session') {
      const target = store.getSession(command.sessionId);
      if (!target || target.archived) {
        await reply(userId, '该会话不存在或已归档，发送 /list 查看可用会话');
      } else {
        await store.set(userId, command.sessionId, { title: target.title, cwd: target.cwd });
        await reply(userId, '已选择回复会话：' + target.title + '\n' + command.sessionId);
      }
    } else if (command?.kind === 'broadcast' || command?.kind === 'broadcast-status') {
      const sessionId = command.sessionId || store.get(userId)?.sessionId;
      const target = sessionId ? store.getSession(sessionId) : null;
      if (!target || target.archived) {
        await reply(userId, '会话不存在或尚未选择。发送 /list 和 /session <会话ID>');
      } else if (command.kind === 'broadcast-status') {
        await reply(userId, target.title + '\n' + sessionId + '\n自动广播：' + (target.broadcastEnabled ? '开启' : '关闭'));
      } else {
        const updated = await store.setBroadcast(sessionId, command.enabled);
        await reply(userId, updated.title + '\n' + sessionId + '\n自动广播已' + (updated.broadcastEnabled ? '开启' : '关闭'));
      }
    } else {
      const route = store.get(userId);
      if (!route) {
        await reply(userId, '全部未归档对话已自动绑定广播。请发送 /list，然后用 /session <会话ID> 选择微信消息的回复目标。');
      } else {
        const target = store.getSession(route.sessionId);
        if (target?.archived) await reply(userId, '当前回复会话已归档，请发送 /list 重新选择');
        else await submitPrompt(route.sessionId, text, messageId ? account.botId + ':' + userId + ':' + messageId : undefined);
      }
    }
    // Save the message dedupe marker before the isolated worker can stop
    // the old Desktop; otherwise getUpdates might replay /restart at boot.
    try {
      if (messageId) {
        bridgeState.seenMessageIds = [...bridgeState.seenMessageIds.slice(-999), messageId];
        await writeState(statePath, bridgeState);
      }
    } catch (error) {
      if (restartAction) await writeRestartTicket(restartAction.file, {
        ...restartAction.ticket, phase: 'cancelled',
      }).catch(() => {});
      restartQueued = false;
      throw error;
    }
    if (restartAction) {
      try {
        await desktopRestart.launch(restartAction.file);
        sendLog = [...sendLog, { at: Date.now(), kind: 'desktop-restart', ok: true, phase: 'worker-acknowledged' }]
          .slice(-Math.max(1, rules.sendLogLimit));
        void beginRestartMonitor();
      } catch {
        await writeRestartTicket(restartAction.file, {
          ...restartAction.ticket, phase: 'failed', failureCode: 'restart-launch-failed',
        }).catch(() => {});
        await reply(userId, '一次性重启任务未能确认启动，未执行重启。请查看微信助手重启记录。');
      } finally {
        restartQueued = false;
      }
    }

  }
  async function pollLoop() {
    if (polling || stopped) return;
    polling = true;
    try {
      while (!stopped && account) {        // A successful getUpdates response establishes that the new Host can
        // actually reach WeChat, not merely that Electron created a process.
        let updates;
        try {
          updates = await transport.getUpdates({ token: account.token, baseUrl: account.baseUrl, getUpdatesBuf: bridgeState.getUpdatesBuf, signal: abort.signal });
          pollHealthy = true;
        } catch (error) {
          if (stopped || abort.signal.aborted) break;          pollHealthy = false;
          log('warn', 'dsh-wechat-allsessions: getUpdates failed [' + (error?.code ?? 'unknown') + ']: ' + (error?.message ?? error));
          if (error?.code === 'stale-token') { await stop(); return; }
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        const messages = (Array.isArray(updates?.msgs) ? updates.msgs : []).slice().sort((a, b) => {
          const seq = (m) => Number(m?.seq ?? m?.message_id ?? 0);
          const time = (m) => Number(m?.create_time_ms ?? 0);
          return (Number.isFinite(seq(a)) && Number.isFinite(seq(b)) ? seq(a) - seq(b) : 0)
            || (Number.isFinite(time(a)) && Number.isFinite(time(b)) ? time(a) - time(b) : 0);
        });
        let batchFailed = false;
        for (const message of messages) {
          if (stopped || abort.signal.aborted) { batchFailed = true; break; }
          try { await handleInbound(message); }
          catch (error) {
            batchFailed = true;
            log('warn', 'dsh-wechat-allsessions: inbound failed; cursor retained: ' + (error?.message ?? error));
            break;
          }
        }
        if (batchFailed) {
          if (!stopped && !abort.signal.aborted) await new Promise(r => setTimeout(r, 500));
          continue;
        }
        // A batch is acknowledged only after every inbound event succeeds.
        const nextCursor = updates?.get_updates_buf;
        if (typeof nextCursor === 'string' && nextCursor !== bridgeState.getUpdatesBuf) {
          const previous = bridgeState.getUpdatesBuf;
          bridgeState.getUpdatesBuf = nextCursor;
          try { await writeState(statePath, bridgeState); }
          catch (error) {
            bridgeState.getUpdatesBuf = previous;
            log('warn', 'dsh-wechat-allsessions: cursor persist failed; preserving last known cursor');
            if (!stopped && !abort.signal.aborted) await new Promise(r => setTimeout(r, 500));
            continue;
          }
        }
        if (messages.length === 0 && !abort.signal.aborted) {
          await new Promise(r => setTimeout(r, internals.emptyPollDelayMs ?? 1000));
        }
      }
    } finally { polling = false; }
  }

  /**
   * Persist a confirmed scan and bring the bridge up on the new account.
   * This is what removes the dependency on an external plugin: the token from
   * the iLink confirmation is written to the Host credential store and the
   * account record to the configured config.json, then start() reads them back
   * through the same path a pre-existing account would use.
   */
  async function bindConfirmedAccount(status) {
    if (!credentials || typeof credentials.set !== 'function') throw new Error('credentials service unavailable');
    const paths = homePaths(rules);
    const { account: record, token } = accountFromConfirmed(status, account?.baseUrl ?? DEFAULT_API_BASE_URL);
    const provisioned = await provisionAccount({ credentials, configPath: paths.accounts, account: record, token });
    log('info', 'dsh-wechat-allsessions: bound WeChat account ' + record.botId);    // Never disrupt an explicitly selected account when another QR is scanned.
    if (rules.activeBotId && rules.activeBotId !== record.botId) {
      return { ...provisioned, connected: false, savedOnly: true };
    }

    // Rebind the running bridge to the freshly written account.
    try {
      if (account) { try { await stop(); } catch { /* best effort */ } }
      await start();
      return { ...provisioned, connected: rules.enabled && !stopped };
    } catch (error) {
      log('warn', 'dsh-wechat-allsessions: account saved but bridge start failed: ' + (error?.message ?? error));
      return { ...provisioned, connected: false, error: error?.message ?? String(error) };
    }
  }

  async function start() {
    if (!credentials || typeof credentials.resolve !== 'function') throw new Error('credentials service unavailable');
    if (pollTask && polling && !stopped && !abort.signal.aborted) return;
    if (pollTask) await pollTask;
    if (abort.signal.aborted) abort = new AbortController();
    stopped = false;
    const paths = homePaths(rules);    pollHealthy = false;
    account = await loadAccount(credentials, paths.accounts, rules.activeBotId);
    statePath = join(paths.state, account.botId, 'allsessions-state.json');
    bridgeState = await readState(statePath);
    await loadLegacyContextTokens(paths);
    await ensureRoutes();
    await syncSessionInventory();
    beginInventoryWatch();
    if (rules.enabled && typeof transport.notifyStart === 'function') {
      await transport.notifyStart({ token: account.token, baseUrl: account.baseUrl, signal: abort.signal });
    }
    if (rules.enabled && internals.autoStart !== false) {
      pollTask = pollLoop().catch(error => log('warn', 'dsh-wechat-allsessions: pollLoop failed: ' + (error?.message ?? error)));
    }
    if (rules.enabled) {
      // Restart recovery also runs when long polling is externally controlled.
      void beginRestartMonitor().catch(() => log('warn', 'wechat-assistant: restart monitor startup failed'));
    }
  }

  const disposers = [];
  const on = (event, fn, options) => { const r = ctx.on(event, fn, options); if (typeof r === 'function') disposers.push(r); };
  on('session/event', (session, event) => {
    const record = sessionRecord(session, event);
    if (record.sessionId) {
      void ensureRoutes().then(store => store.syncSessions([record]))
        .catch(error => log('warn', 'wechat-assistant: session auto-bind failed: ' + (error?.message ?? error)));
    }
    void engine.enqueue(session, event);
  }, { global: true });
  if (typeof ctx.on === 'function') {
    const disposeSettings = ctx.on('settings/document-updated', (ns) => {
      if (ns !== name && String(ns ?? '').includes(name) === false) return;
      const fresh = normalizeRules({ ...rules, ...unwrapVolatile(config), ...initialDirect, ...readPersistedConfig(ctx) });
      const changedEnabled = rules.enabled !== fresh.enabled;
      rules = fresh;
      engine.setRules(currentRules());
      if (changedEnabled) log('warn', 'dsh-wechat-allsessions: enabled changed in Host settings; restart Host to apply bridge lifecycle');
    }, { global: true });
    if (typeof disposeSettings === 'function') disposers.push(disposeSettings);
  }

  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['settings'], (sctx) => {
      ctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
      // Some Cordis loaders do not surface id-targeted config at apply-time.
      const persisted = readPersistedConfig(ctx);
      if (Object.keys(persisted).length) {
        const wasEnabled = rules.enabled;
        rules = normalizeRules({ ...rules, ...persisted });
        engine.setRules(currentRules());
        if (!wasEnabled && rules.enabled && internals.autoStart !== false && !account) {
          void start().catch(error => log('warn', 'dsh-wechat-allsessions: delayed startup failed: ' + (error?.message ?? error)));
        }
      }
    }); }
    catch (error) { log('warn', 'settings registration deferred: ' + (error?.message ?? error)); }
  }

  const webServer = internals.webServer ?? ctx.get?.('webServer');
  if (webServer?.register) {
    const register = (path, handler) => { const d = webServer.register({ kind: 'exact', path, handler }); if (typeof d === 'function') disposers.push(d); };
    const loopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');
    const base = '/plugins/' + name;
    register(base + '/config', async (req, res) => {
      if (!loopback(req)) return json(res, 403, { error: 'loopback only' });
      if (req.method === 'GET') return json(res, 200, { ok: true, rules, sendLog });
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const origin = req.headers?.origin;
      if (origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(origin)) return json(res, 403, { error: 'cross-origin POST refused' });
      try {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid body' });
        const change = Object.fromEntries(Object.keys(DEFAULT_RULES).filter(k => k in body).map(k => [k, body[k]]));
        if (!Object.keys(change).length) return json(res, 400, { error: 'no known fields' });
        const next = normalizeRules({ ...rules, ...change });
        const lifecycleChanged = rules.enabled !== next.enabled || rules.activeBotId !== next.activeBotId;
        // Persist before changing any live behavior; no false success on failure.
        const saved = await saveConfig(ctx, change);
        rules = next;
        engine.setRules(currentRules());
        return json(res, 200, { ok: true, rules, saved, restartRequired: lifecycleChanged,
          ...(lifecycleChanged ? { warning: 'enabled changed; restart Host to start or stop the WeChat bridge' } : {}) });
      } catch (error) { return json(res, 500, { error: error?.message ?? String(error) }); }
    });
    register(base + '/status', async (req, res) => {
      if (!loopback(req) || req.method !== 'GET') return json(res, 405, { error: 'loopback GET only' });
      const inventory = await syncSessionInventory().catch(() => routes?.listSessions?.() ?? []);
      const recipient = rules.defaultUserId || account?.ownerUserId;
      let accountRoster;
      try { accountRoster = await readAccountRoster(homePaths(rules).accounts, account?.botId ?? '', polling); }
      catch { accountRoster = { accounts: [], savedCount: 0, activeCount: 0, error: 'account-roster-unavailable' }; }
      return json(res, 200, { ok: true, version, enabled: rules.enabled, broadcastAll: rules.broadcastAll,
        connected: Boolean(account), botId: account?.botId ?? null, polling,
        accountRoster, inventoryStatus,
        routes: routes?.list?.() ?? [], sessions: inventory.length,
        broadcastReady: Boolean(recipient && contextTokenFor(recipient)),
        sendLog });
    });
    register(base + '/sessions', async (req, res) => {
      if (!loopback(req)) return json(res, 403, { error: 'loopback only' });
      if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const origin = req.headers?.origin;
      if (req.method === 'POST' && origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(origin)) {
        return json(res, 403, { error: 'cross-origin POST refused' });
      }
      try {
        await syncSessionInventory();
        const store = await ensureRoutes();
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (typeof body?.sessionId !== 'string' || typeof body?.broadcastEnabled !== 'boolean') {
            return json(res, 400, { error: 'sessionId and broadcastEnabled required' });
          }
          const entry = await store.setBroadcast(body.sessionId, body.broadcastEnabled);
          if (!entry) return json(res, 404, { error: 'session does not exist or is archived' });
        }
        return json(res, 200, { ok: true, sessions: store.listSessions(), inventoryStatus });
      } catch (error) { return json(res, 500, { error: error?.message ?? String(error) }); }
    });
    register(base + '/accounts/remove', async (req, res) => {
      if (!loopback(req)) return json(res, 403, { error: 'loopback only' });
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const origin = req.headers?.origin;
      if (origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(origin)) {
        return json(res, 403, { error: 'cross-origin POST refused' });
      }
      let selectionSaved = false;
      let originalSelection = rules.activeBotId;
      let wasLoaded = false;
      try {
        const body = await readBody(req, 16_384);
        const botId = typeof body?.botId === 'string' ? body.botId.trim() : '';
        if (!botId || botId.length > 256) return json(res, 400, { error: 'valid botId required' });
        wasLoaded = Boolean(account && account.botId === botId);
        const needsFallback = rules.activeBotId === botId || (wasLoaded && !rules.activeBotId);
        let selectedFallback = originalSelection;
        const result = await removeSavedAccount({
          configPath: homePaths(rules).accounts, botId,
          onBeforeWrite: async ({ fallbackBotId }) => {
            if (needsFallback) {
              // Persist the next boot choice before removing the old selection.
              await saveConfig(ctx, { activeBotId: fallbackBotId });
              selectionSaved = true;
              selectedFallback = fallbackBotId;
            }
            if (wasLoaded) {
              // A live bot must stop receiving before its binding disappears.
              await stop();
              if (pollTask) await pollTask;
            }
          },
        });
        if (!result.removed) return json(res, 404, { error: 'account not found' });
        if (selectionSaved) {
          rules = normalizeRules({ ...rules, activeBotId: selectedFallback });
          engine.setRules(currentRules());
        }
        if (wasLoaded) {
          account = null;
          bridgeState = null;
          statePath = '';
          legacyContextTokens = Object.create(null);
          if (abort.signal.aborted) abort = new AbortController();
        }
        const roster = await readAccountRoster(homePaths(rules).accounts, account?.botId ?? '', polling);
        return json(res, 200, {
          ok: true, removed: true, remainingCount: result.remainingCount,
          activeBotId: rules.activeBotId, restartRequired: wasLoaded || selectionSaved,
          accountRoster: roster, credentialsPreserved: true,
        });
      } catch (error) {
        if (selectionSaved) {
          try {
            await saveConfig(ctx, { activeBotId: originalSelection });
            rules = normalizeRules({ ...rules, activeBotId: originalSelection });
            engine.setRules(currentRules());
          } catch {
            log('warn', 'wechat-assistant: account removal settings rollback failed; restart required');
          }
        }
        log('warn', 'wechat-assistant: account removal failed (no credentials logged)');
        return json(res, 500, { error: 'account removal failed; binding retained or operation needs restart' });
      }
    });

    register(base + '/login', async (req, res) => {
      if (!loopback(req) || req.method !== 'POST') return json(res, 405, { error: 'loopback POST only' });
      const origin = req.headers?.origin;
      if (origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(origin)) return json(res, 403, { error: 'cross-origin POST refused' });
      // Binding is allowed before the bridge is enabled: a scan is how an account
      // comes to exist, so requiring 'enabled' first would deadlock a fresh install.
      try {
        const body = await readBody(req);
        if (body?.qrcode) {
          const status = await transport.pollLogin({ qrcode: body.qrcode, verifyCode: body.verifyCode, signal: abort.signal });
          if (status?.status === 'confirmed') {
            const provisioned = await bindConfirmedAccount(status);
            // Login status contains bot_token: never send that credential to the UI.
            return json(res, 200, { ok: true, status: { status: 'confirmed' },
              bound: { botId: provisioned.botId, connected: provisioned.connected, replaced: provisioned.replaced,
                savedOnly: provisioned.savedOnly === true } });
          }
          return json(res, 200, { ok: true, status });
        }
        const login = await transport.beginLogin({ signal: abort.signal });
        // The iLink API returns only a URL, so render the code locally as SVG.
        // The settings page can then show a scannable image instead of a link.
        let qrImage;
        try { qrImage = login.qrcodeUrl ? 'data:image/svg+xml;base64,' + Buffer.from(qrSvg(login.qrcodeUrl), 'utf8').toString('base64') : undefined; }
        catch (error) { log('warn', 'dsh-wechat-allsessions: local QR render failed: ' + (error?.message ?? error)); }
        return json(res, 200, { ok: true, ...login, ...(qrImage ? { qrImage } : {}), qrBaseUrl: QR_BASE_URL });
      } catch (error) { return json(res, 500, { error: error?.message ?? String(error) }); }
    });
  }

  async function stop() {
    stopped = true;    pollHealthy = false;
    clearRestartMonitor();
    if (inventoryTimer) { clearInterval(inventoryTimer); inventoryTimer = null; }
    // Stop the pending long-poll immediately, before notifyStop can take time.
    abort.abort(new Error('plugin stopped'));
    if (account && typeof transport.notifyStop === 'function') {
      try { await transport.notifyStop({ token: account.token, baseUrl: account.baseUrl, signal: AbortSignal.timeout(10_000) }); }
      catch (error) { log('warn', 'dsh-wechat-allsessions: notifyStop failed: ' + (error?.message ?? error)); }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      await stop();
      for (const dispose of disposers) { try { dispose(); } catch { /* best effort */ } }
    }, name + ' lifecycle');
  }

  const handle = {
    get rules() { return { ...rules }; },
    get sendLog() { return [...sendLog]; },
    get sessions() { return routes?.listSessions?.() ?? []; },
    refresh(next) { rules = normalizeRules({ ...rules, ...next }); engine.setRules(currentRules()); return rules; },
    get engine() { return engine; },
    get started() { return Boolean(account); },
    start, stop, submitPrompt, handleInbound, syncSessionInventory,
  };
  if (rules.enabled && internals.autoStart !== false) {
    // Discover sessions independently of the WeChat account connection.
    void syncSessionInventory().catch(error => log('warn', 'wechat-assistant: initial sync failed: ' + (error?.message ?? error)));
    beginInventoryWatch();
    void start().catch(error => log('warn', 'dsh-wechat-allsessions: startup failed: ' + (error?.message ?? error)));
  }
  return handle;
}

export default { name, inject, Config, apply };
