/**
 * dsh-wechat-allsessions — standalone WeChat iLink bridge for all DSH sessions.
 * Requires no @xmanrui/dsh-im plugin. Uses DSH credentials + sessionController.
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createWeixinTransport, extractWeixinText, accountFromConfirmed, QR_BASE_URL, DEFAULT_API_BASE_URL } from './transport.js';
import { provisionAccount } from './account.js';
import { qrSvg } from './qr.js';
import { loadRouteStore, parseRouteCommand, normalizeRoutes } from './router.js';
import { buildBroadcastMessage, planDelivery } from './text.js';
import { createBroadcastEngine } from './events.js';

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
export const inject = ['settings', 'webServer', 'sessions', 'sessionController', 'credentials'];

export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  broadcastAll: z.boolean().default(false).volatile(),
  defaultUserId: z.string().default('').volatile(),
  maxChunkBytes: z.number().min(100).default(1500).volatile(),
  routeStorePath: z.string().default('').volatile(),
  accountConfigPath: z.string().default('').volatile(),
  statePath: z.string().default('').volatile(),
  includeSessionHint: z.boolean().default(true).volatile(),
  includeInternal: z.boolean().default(false).volatile(),
  includeSubagents: z.boolean().default(false).volatile(),
  format: z.union([z.const('plain'), z.const('markdown')]).default('plain').volatile(),
  sendLogLimit: z.number().min(1).default(20).volatile(),
});

export const DEFAULT_RULES = Object.freeze({
  enabled: false, broadcastAll: false, defaultUserId: '', maxChunkBytes: 1500,
  routeStorePath: '', accountConfigPath: '', statePath: '',
  includeSessionHint: true, includeInternal: false, includeSubagents: false,
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
    defaultUserId: str(raw.defaultUserId, 256),
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

async function loadAccount(credentials, configPath) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const account = Array.isArray(raw?.accounts) ? raw.accounts[0] : null;
  if (!account?.tokenRef || !account?.botId) throw new Error('no reusable WeChat account in ' + configPath);
  const resolved = await credentials.resolve(account.tokenRef);
  const token = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
  if (!token) throw new Error('WeChat token is empty for ' + account.botId);
  return {
    botId: account.botId,
    token,
    tokenRef: account.tokenRef,
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
  } catch { return { getUpdatesBuf: '', contextTokens: { users: {} }, seenMessageIds: [], lastContextToken: '', users: {} }; }
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
  let title = '';
  if (Array.isArray(events)) for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'session/title' && typeof events[i].data?.title === 'string') { title = events[i].data.title; break; }
  }
  return { cwd: typeof header.cwd === 'string' ? header.cwd : '', title, isSubagent: header.origin === 'subagent' || Boolean(header.parentSession) };
}

export function apply(ctx, config = {}, internals = {}) {
  let rules = normalizeRules(unwrapVolatile(config));
  let sendLog = [];
  let routes = null;
  let account = null;
  let bridgeState = null;
  let statePath = '';
  let polling = false;
  let stopped = false;
  const abort = new AbortController();
  const logger = internals.logger ?? ctx.logger;
  const log = (level, text) => { try { logger?.[level]?.(text); } catch { /* optional */ } };
  const transport = internals.transport ?? createWeixinTransport({ fetchImpl: internals.fetchImpl, baseUrl: internals.baseUrl ?? DEFAULT_API_BASE_URL });
  const controller = internals.sessionController ?? ctx.get?.('sessionController');
  const credentials = internals.credentials ?? ctx.get?.('credentials');

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
      const userId = rules.defaultUserId || context.userId || context.senderId;
      if (!userId) return { sent: false, reason: 'no-user-id' };
      if (routes) await routes.set(userId, context.sessionId, { title: context.title, cwd: context.cwd });
      if (!contextTokenFor(userId)) return { sent: false, reason: 'no-context-token' };
      const plan = planDelivery(text, { maxBytes: rules.maxChunkBytes, maxChunks: 20 });
      for (const part of plan.items) {
        const result = await transport.sendText({
          token: account.token, baseUrl: account.baseUrl, toUserId: userId,
          text: part, contextToken: contextTokenFor(userId),
          signal: abort.signal,
        });
        if (result?.sent === false) return result;
      }
      return { sent: true, chunks: plan.items.length, truncated: plan.truncated };
    },
    onLog: (entry) => { try { sendLog = [...sendLog, entry].slice(-Math.max(1, rules.sendLogLimit)); } catch { /* best effort */ } },
    logger,
    shouldSkip: async (context) => !rules.broadcastAll && !rules.defaultUserId,
  });

  async function submitPrompt(sessionId, text) {
    if (!controller || typeof controller.prompt !== 'function') throw new Error('sessionController.prompt unavailable');
    const rpcId = 'wechat-allsessions-' + randomUUID();
    await controller.prompt({ requestId: rpcId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, abort.signal);
  }

  function contextTokenFor(userId) {
    const nested = bridgeState?.contextTokens?.users?.[userId]?.token;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
    const legacy = bridgeState?.contextTokens?.[userId]?.token ?? bridgeState?.contextTokens?.[userId]?.contextToken;
    return typeof legacy === 'string' && legacy.trim() ? legacy.trim() : undefined;
  }

  async function reply(userId, text) {
    if (!account) return;
    const plan = planDelivery(text, { maxBytes: rules.maxChunkBytes, maxChunks: 20 });
    for (const part of plan.items) {
      await transport.sendText({ token: account.token, baseUrl: account.baseUrl, toUserId: userId, text: part, contextToken: contextTokenFor(userId), signal: abort.signal });
    }
  }

  async function handleInbound(message) {
    const userId = typeof message?.from_user_id === 'string' ? message.from_user_id.trim() : '';
    const text = extractWeixinText(message);
    if (!userId || !text || message?.message_type === 2) return;
    if (message?.message_id && bridgeState.seenMessageIds.includes(message.message_id)) return;
    if (message?.message_id) {
      bridgeState.seenMessageIds = [...bridgeState.seenMessageIds.slice(-999), message.message_id];
      await writeState(statePath, bridgeState);
    }
    if (typeof message.context_token === 'string' && message.context_token.trim()) {
      const nested = bridgeState.contextTokens?.users && typeof bridgeState.contextTokens.users === 'object'
        ? bridgeState.contextTokens.users : {};
      bridgeState.contextTokens = {
        ...(bridgeState.contextTokens ?? {}),
        users: { ...nested, [userId]: { token: message.context_token.trim() } },
      };
      await writeState(statePath, bridgeState);
    }
    const command = parseRouteCommand(text);
    if (command?.kind === 'list') {
      const list = routes.list();
      await reply(userId, list.length ? list.map(r => r.sessionId + '  ' + (r.title || r.cwd)).join('\n') : '暂无会话路由');
      return;
    }
    if (command?.kind === 'clear') {
      await routes.clear(userId);
      await reply(userId, '已清除当前会话路由');
      return;
    }
    if (command?.kind === 'session') {
      await routes.set(userId, command.sessionId, { title: '手动绑定' });
      await reply(userId, '已绑定会话 ' + command.sessionId);
      return;
    }
    const route = routes.get(userId);
    if (!route) {
      await reply(userId, '还没有绑定会话。先在网页端完成一次对话，或发送 /session <Session ID>');
      return;
    }
    await submitPrompt(route.sessionId, text);
  }

  async function pollLoop() {
    if (polling || stopped) return;
    polling = true;
    try {
      while (!stopped && account) {
        let updates;
        try {
          updates = await transport.getUpdates({ token: account.token, baseUrl: account.baseUrl, getUpdatesBuf: bridgeState.getUpdatesBuf, signal: abort.signal });
        } catch (error) {
          log('warn', 'dsh-wechat-allsessions: getUpdates failed [' + (error?.code ?? 'unknown') + ']: ' + (error?.message ?? error));
          if (error?.code === 'stale-token') { await stop(); return; }
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        if (typeof updates?.get_updates_buf === 'string' && updates.get_updates_buf !== bridgeState.getUpdatesBuf) {
          bridgeState.getUpdatesBuf = updates.get_updates_buf;
          await writeState(statePath, bridgeState);
        }
        const messages = (Array.isArray(updates?.msgs) ? updates.msgs : []).slice().sort((a, b) => {
          const seq = (m) => Number(m?.seq ?? m?.message_id ?? 0);
          const time = (m) => Number(m?.create_time_ms ?? 0);
          return (Number.isFinite(seq(a)) && Number.isFinite(seq(b)) ? seq(a) - seq(b) : 0)
            || (Number.isFinite(time(a)) && Number.isFinite(time(b)) ? time(a) - time(b) : 0);
        });
        for (const message of messages) {
          try { await handleInbound(message); }
          catch (error) { log('warn', 'dsh-wechat-allsessions: inbound failed: ' + (error?.message ?? error)); }
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
    log('info', 'dsh-wechat-allsessions: bound WeChat account ' + record.botId);
    // Rebind the running bridge to the freshly written account.
    try {
      if (account) { try { await stop(); } catch { /* best effort */ } }
      stopped = false;
      await start();
      return { ...provisioned, connected: true };
    } catch (error) {
      log('warn', 'dsh-wechat-allsessions: account saved but bridge start failed: ' + (error?.message ?? error));
      return { ...provisioned, connected: false, error: error?.message ?? String(error) };
    }
  }

  async function start() {
    if (!credentials || typeof credentials.resolve !== 'function') throw new Error('credentials service unavailable');
    const paths = homePaths(rules);
    account = await loadAccount(credentials, paths.accounts);
    statePath = join(paths.state, account.botId, 'allsessions-state.json');
    bridgeState = await readState(statePath);
    routes = await loadRouteStore(paths.routes);
    if (typeof transport.notifyStart === 'function') {
      await transport.notifyStart({ token: account.token, baseUrl: account.baseUrl, signal: abort.signal });
    }
    if (internals.autoStart !== false) void pollLoop().catch((error) => log('warn', 'dsh-wechat-allsessions: pollLoop failed: ' + (error?.message ?? error)));
  }

  const disposers = [];
  const on = (event, fn, options) => { const r = ctx.on(event, fn, options); if (typeof r === 'function') disposers.push(r); };
  on('session/event', (session, event) => { void engine.enqueue(session, event); }, { global: true });
  if (typeof ctx.on === 'function') {
    const disposeSettings = ctx.on('settings/document-updated', (ns) => {
      if (ns !== name && String(ns ?? '').includes(name) === false) return;
      const fresh = normalizeRules(unwrapVolatile(config));
      const changedEnabled = rules.enabled !== fresh.enabled;
      rules = fresh;
      engine.setRules(currentRules());
      if (changedEnabled) log('warn', 'dsh-wechat-allsessions: enabled changed in Host settings; restart Host to apply bridge lifecycle');
    }, { global: true });
    if (typeof disposeSettings === 'function') disposers.push(disposeSettings);
  }

  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['settings'], (sctx) => { ctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber)); }); }
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
        const wasEnabled = rules.enabled;
        rules = normalizeRules({ ...rules, ...change });
        engine.setRules(currentRules());
        const lifecycleChanged = wasEnabled !== rules.enabled;
        if (lifecycleChanged) return json(res, 200, { ok: true, rules, restartRequired: true, warning: 'enabled changed; restart Host to start or stop the WeChat bridge' });
        let saved = null;
        try { saved = await saveConfig(ctx, change); } catch (error) { return json(res, 200, { ok: true, rules, warning: error?.message ?? String(error) }); }
        return json(res, 200, { ok: true, rules, saved });
      } catch (error) { return json(res, 500, { error: error?.message ?? String(error) }); }
    });
    register(base + '/status', async (req, res) => {
      if (!loopback(req) || req.method !== 'GET') return json(res, 405, { error: 'loopback GET only' });
      return json(res, 200, { ok: true, connected: Boolean(account), botId: account?.botId ?? null, polling, routes: routes?.list?.() ?? [], sendLog });
    });
    register(base + '/sessions', async (req, res) => {
      if (!loopback(req) || req.method !== 'GET') return json(res, 405, { error: 'loopback GET only' });
      const service = ctx.get?.('sessions') ?? ctx.sessions;
      const list = (service?.list?.() ?? []).map(s => ({ sessionId: s?.id ?? s?.sessionId, ...describeSession(s) }));
      return json(res, 200, { ok: true, sessions: list.filter(s => s.sessionId) });
    });
    register(base + '/login', async (req, res) => {
      if (!loopback(req) || req.method !== 'POST') return json(res, 405, { error: 'loopback POST only' });
      // Binding is allowed before the bridge is enabled: a scan is how an account
      // comes to exist, so requiring 'enabled' first would deadlock a fresh install.
      try {
        const body = await readBody(req);
        if (body?.qrcode) {
          const status = await transport.pollLogin({ qrcode: body.qrcode, verifyCode: body.verifyCode, signal: abort.signal });
          if (status?.status === 'confirmed') {
            const provisioned = await bindConfirmedAccount(status);
            return json(res, 200, { ok: true, status, bound: provisioned });
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
    stopped = true;
    if (account && typeof transport.notifyStop === 'function') {
      try { await transport.notifyStop({ token: account.token, baseUrl: account.baseUrl, signal: AbortSignal.timeout(10_000) }); }
      catch (error) { log('warn', 'dsh-wechat-allsessions: notifyStop failed: ' + (error?.message ?? error)); }
    }
    abort.abort(new Error('plugin stopped'));
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
    refresh(next) { rules = normalizeRules(next); engine.setRules(currentRules()); return rules; },
    get engine() { return engine; },
    get started() { return Boolean(account); },
    start,
    stop,
    submitPrompt,
    handleInbound,
  };
  if (rules.enabled && internals.autoStart !== false) void start().catch(error => log('warn', 'dsh-wechat-allsessions: startup failed: ' + (error?.message ?? error)));
  return handle;
}

export default { name, inject, Config, apply };
