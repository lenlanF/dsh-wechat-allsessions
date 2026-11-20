// Persistent WeChat reply routes and independent per-session broadcast preferences.
// v3 keeps explicit bindings separate from the DSH persistent discovery catalog.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_ROUTES = Object.freeze({ version: 3, users: {}, sessions: {} });

function validUserId(value) {
  return typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : null;
}
function validSessionId(value) {
  return typeof value === 'string' && value.trim() && value.length <= 256 && !/\s/u.test(value) ? value.trim() : null;
}
function shortText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}
export function isArchivedSession(session) {
  const header = session?.header ?? {};
  const meta = session?.metadata ?? {};
  return session?.archived === true || session?.isArchived === true || header.archived === true
    || meta.archived === true || Boolean(session?.archivedAt || header.archivedAt || meta.archivedAt)
    || session?.status === 'archived' || session?.state === 'archived'
    || header.status === 'archived' || header.state === 'archived'
    || session?.status?.kind === 'archived';
}

export function normalizeRoutes(value) {
  const users = Object.create(null);
  const sessions = Object.create(null);
  const doc = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawUsers = doc.users;
  if (rawUsers && typeof rawUsers === 'object' && !Array.isArray(rawUsers)) {
    for (const [key, entry] of Object.entries(rawUsers)) {
      const userId = validUserId(key);
      const sessionId = validSessionId(entry?.sessionId);
      if (!userId || !sessionId) continue;
      users[userId] = {
        sessionId, title: shortText(entry.title, 200), cwd: shortText(entry.cwd, 4096),
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
      };
    }
  }
  const legacySelected = new Set(Object.values(users).map(entry => entry.sessionId));
  const legacy = doc.version !== 3;
  const rawSessions = doc.sessions;
  if (rawSessions && typeof rawSessions === 'object' && !Array.isArray(rawSessions)) {
    for (const [key, entry] of Object.entries(rawSessions)) {
      const sessionId = validSessionId(key);
      if (!sessionId || !entry || typeof entry !== 'object') continue;
      sessions[sessionId] = {
        sessionId, title: shortText(entry.title, 200), cwd: shortText(entry.cwd, 4096),
        archived: entry.archived === true, broadcastEnabled: entry.broadcastEnabled !== false,
        // v2 had no explicit binding: discovery silently persisted every session.
        // Keep prior manual selections/off toggles, never promote all discoveries.
        bound: entry.bound === true || (legacy && (legacySelected.has(sessionId) || entry.broadcastEnabled === false)),
        isSubagent: entry.isSubagent === true,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
      };
    }
  }
  // v1 stored selected reply targets without a Session roster.
  for (const entry of Object.values(users)) {
    const sid = entry.sessionId;
    if (!sessions[sid]) {
      sessions[sid] = {
        sessionId: sid, title: entry.title, cwd: entry.cwd,
        archived: false, broadcastEnabled: true, bound: true,
        isSubagent: false, updatedAt: entry.updatedAt,
      };
    }
  }
  return { version: 3, users, sessions };
}

export async function loadRouteStore(path, now = () => Date.now()) {
  let initial = DEFAULT_ROUTES;
  try { initial = normalizeRoutes(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let data = initial;
  let writes = Promise.resolve();
  const persist = () => {
    writes = writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = path + '.tmp';
      await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
      await rename(temp, path);
    });
    return writes;
  };
  const listSessions = (includeArchived = false) => Object.values(data.sessions)
    .filter(entry => entry.bound === true && (includeArchived || !entry.archived))
    .map(entry => ({ ...entry }))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh') || a.sessionId.localeCompare(b.sessionId));
  return {
    get(userId) { return Object.hasOwn(data.users, userId) ? { ...data.users[userId] } : null; },
    list() { return Object.entries(data.users).map(([userId, entry]) => ({ userId, ...entry })); },
    async set(userId, sessionId, meta = {}) {
      const id = validUserId(userId);
      const sid = validSessionId(sessionId);
      if (!id || !sid || data.sessions[sid]?.bound !== true || data.sessions[sid]?.archived)
        throw new TypeError('valid userId and a bound unarchived sessionId are required');
      data = { ...data, users: { ...data.users, [id]: {
        sessionId: sid, title: shortText(meta.title, 200), cwd: shortText(meta.cwd, 4096), updatedAt: now(),
      } } };
      await persist();
      return data.users[id];
    },
    async clear(userId) {
      const id = validUserId(userId);
      if (!id || !Object.hasOwn(data.users, id)) return false;
      const users = { ...data.users };
      delete users[id];
      data = { ...data, users };
      await persist();
      return true;
    },
    getSession(sessionId) {
      const id = validSessionId(sessionId);
      return id && data.sessions[id]?.bound === true ? { ...data.sessions[id] } : null;
    },
    listSessions,
    async bind(sessionId, meta = {}) {
      const id = validSessionId(sessionId);
      if (!id || meta.archived !== false || meta.isSubagent === true)
        throw new TypeError('binding requires a verified, unarchived ordinary DSH session');
      const previous = data.sessions[id];
      const entry = {
        sessionId: id,
        title: shortText(meta.title, 200) || previous?.title || '',
        cwd: shortText(meta.cwd, 4096) || previous?.cwd || '',
        archived: false,
        broadcastEnabled: previous?.broadcastEnabled !== false,
        bound: true,
        isSubagent: false,
        updatedAt: now(),
      };
      if (previous?.bound === true && ['title', 'cwd', 'archived'].every(k => previous[k] === entry[k]))
        return { ...previous };
      data = { ...data, sessions: { ...data.sessions, [id]: entry } };
      await persist();
      return { ...entry };
    },
    async syncSessions(items) {
      if (!Array.isArray(items)) throw new TypeError('session inventory must be an array');
      const next = { ...data.sessions };
      let changed = false;
      for (const item of items) {
        const id = validSessionId(item?.sessionId ?? item?.id);
        if (!id) continue;
        const existing = next[id];
        // Inventory updates ONLY existing explicit bindings; never creates one.
        if (!existing?.bound) continue;
        const incomingTitle = shortText(item.title, 200);
        const incomingCwd = shortText(item.cwd, 4096);
        const entry = {
          sessionId: id,
          title: incomingTitle || existing?.title || '',
          cwd: incomingCwd || existing?.cwd || '',
          archived: typeof item.archived === 'boolean' ? item.archived : existing.archived,
          broadcastEnabled: existing?.broadcastEnabled !== false,
          bound: true,
          isSubagent: item.isSubagent === true || (existing?.isSubagent === true && item.isSubagent === undefined),
          updatedAt: existing?.updatedAt ?? now(),
        };
        if (!existing || ['title', 'cwd', 'archived', 'isSubagent'].some(k => existing[k] !== entry[k])) {
          entry.updatedAt = now();
          next[id] = entry;
          changed = true;
        }
      }
      // DSH session/list includes archived entries. A missing row can be a
      // deleted/inaccessible session; absence alone is NOT an archive signal.
      // Unknown bindings retain their last state until a definitive Host fact.
      if (changed) {
        data = { ...data, sessions: next };
        await persist();
      }
      return listSessions();
    },
    async setBroadcast(sessionId, enabled) {
      const id = validSessionId(sessionId);
      if (!id || typeof enabled !== 'boolean') throw new TypeError('valid sessionId and boolean enabled are required');
      const existing = data.sessions[id];
      if (!existing?.bound || existing.archived) return null;
      if (existing.broadcastEnabled === enabled) return { ...existing };
      const entry = { ...existing, broadcastEnabled: enabled, updatedAt: now() };
      data = { ...data, sessions: { ...data.sessions, [id]: entry } };
      await persist();
      return { ...entry };
    },
    snapshot() { return structuredClone(data); },
  };
}

export function parseRouteCommand(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (/^\/help$/iu.test(value)) return { kind: 'help' };  if (/^\/restart$/iu.test(value)) return { kind: 'restart' };
  if (/^\/models(?:\s|$)/iu.test(value)) {
    const args = value.split(/\s+/u).slice(1);
    if (args[0]?.toLowerCase() === 'list') {
      const tokens = args.slice(1);
      let page = 1;
      if (tokens.includes('-p')) {
        const index = tokens.indexOf('-p');
        if (index !== tokens.length - 2 || !/^[1-9]\d{0,3}$/u.test(tokens[index + 1]))
          return { kind: 'models-usage' };
        page = Number(tokens[index + 1]);
        tokens.splice(index, 2);
      }
      if (tokens.length === 0) return { kind: 'models-list', page };
      if (tokens.length === 1 && tokens[0] === '-c') return { kind: 'models-list', channelsOnly: true, page };
      if (tokens.length === 1 && tokens[0].length <= 256 && !tokens[0].startsWith('-'))
        return { kind: 'models-list', channel: tokens[0], page };
      return { kind: 'models-usage' };
    }
    if (args.length >= 2 && args[0].length <= 256 && !args[0].startsWith('-')) {
      const model = args.slice(1).join(' ').trim();
      if (model && model.length <= 256)
        return { kind: 'models-select', channel: args[0], model };
    }
    return { kind: 'models-usage' };
  }
  if (/^\/session$/iu.test(value)) return { kind: 'session-list', page: 1 };
  const sessionPage = /^\/session\s+-p\s+([1-9]\d{0,3})$/iu.exec(value);
  if (sessionPage) return { kind: 'session-list', page: Number(sessionPage[1]) };
  const addSession = /^\/session\s+add\s+(\S+)$/iu.exec(value);
  if (addSession) return { kind: 'session-add', sessionId: addSession[1] };
  const session = /^\/session\s+(\S+)$/iu.exec(value);
  if (session && session[1].toLowerCase() !== 'add' && !session[1].startsWith('-'))
    return { kind: 'session', sessionId: session[1] };
  if (/^\/session(?:\s|$)/iu.test(value)) return { kind: 'session-usage' };
  if (/^\/(?:list|sessions)$/iu.test(value)) return { kind: 'list', page: 1 };
  const listPage = /^\/(?:list|sessions)\s+-p\s+([1-9]\d{0,3})$/iu.exec(value);
  if (listPage) return { kind: 'list', page: Number(listPage[1]) };
  if (/^\/(?:list|sessions)(?:\s|$)/iu.test(value)) return { kind: 'list-usage' };
  if (/^\/(?:new|clear)$/iu.test(value)) return { kind: 'clear' };
  const toggle = /^\/broadcast\s+(on|off)(?:\s+(\S+))?$/iu.exec(value);
  if (toggle) return { kind: 'broadcast', enabled: toggle[1].toLowerCase() === 'on', sessionId: toggle[2] || null };
  const status = /^\/broadcast\s+status(?:\s+(\S+))?$/iu.exec(value);
  if (status) return { kind: 'broadcast-status', sessionId: status[1] || null };
  if (/^\/broadcast(?:\s+list)?$/iu.test(value)) return { kind: 'broadcast-list' };
  return null;
}

export const WECHAT_HELP = [
  '微信助手｜命令帮助',
  '',
  '/help  查看帮助',  '',
  '/restart  重启 DSH Desktop，成功后微信通知',
  '',
  '/models list  按渠道列模型、倍率及完整复制命令',
  '',
  '/models list -c  列出渠道ID和查询命令',
  '',
  '/models list <渠道ID>  列出该渠道的模型',
  '',
  '/models <渠道ID> <模型ID>  切换当前 DSH 会话',
  '',
  '/models list -p 2  翻到下一页',
  '',
  '/list  列出全部 DSH 会话（支持 /list -p 2）',
  '',
  '/sessions  同 /list',
  '',
  '/session  列出已绑定会话（支持 /session -p 2）',
  '',
  '/session add <会话ID>  手动绑定未归档会话',
  '',
  '/session <会话ID>  选择已绑定会话作为回复目标',
  '',
  '/broadcast list  查看广播清单',
  '',
  '/broadcast on <会话ID>  开启广播',
  '',
  '/broadcast off <会话ID>  关闭广播',
  '',
  '/broadcast on  开启当前会话广播',
  '',
  '/broadcast off  关闭当前会话广播',
  '',
  '/broadcast status [会话ID]  查看广播状态',
  '',
  '/clear  清除回复会话选择',
  '',
  '/new  同 /clear',
  '',
  '普通文字  发送到已选 DSH 会话',
  '',
  '发现不等于绑定。只有手动绑定的未归档会话才能广播。',
].join('\n');
