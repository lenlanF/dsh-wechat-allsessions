// Persistent user -> session routing, adapted from cli-in-wechat SessionManager (MIT).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_ROUTES = Object.freeze({ version: 1, users: {} });

function validUserId(value) {
  return typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : null;
}
function validSessionId(value) {
  return typeof value === 'string' && value.trim() && value.length <= 256 && !/\s/u.test(value) ? value.trim() : null;
}

export function normalizeRoutes(value) {
  const users = Object.create(null);
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value.users : null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, entry] of Object.entries(raw)) {
      const userId = validUserId(key);
      const sessionId = validSessionId(entry?.sessionId);
      if (!userId || !sessionId) continue;
      users[userId] = {
        sessionId,
        title: typeof entry.title === 'string' ? entry.title.slice(0, 200) : '',
        cwd: typeof entry.cwd === 'string' ? entry.cwd.slice(0, 4096) : '',
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
      };
    }
  }
  return { version: 1, users };
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
  return {
    get(userId) { return Object.hasOwn(data.users, userId) ? data.users[userId] : null; },
    list() { return Object.entries(data.users).map(([userId, entry]) => ({ userId, ...entry })); },
    async set(userId, sessionId, meta = {}) {
      const id = validUserId(userId);
      const sid = validSessionId(sessionId);
      if (!id || !sid) throw new TypeError('valid userId and sessionId are required');
      data = { version: 1, users: { ...data.users, [id]: {
        sessionId: sid,
        title: typeof meta.title === 'string' ? meta.title.slice(0, 200) : '',
        cwd: typeof meta.cwd === 'string' ? meta.cwd.slice(0, 4096) : '',
        updatedAt: now(),
      } } };
      await persist();
      return data.users[id];
    },
    async clear(userId) {
      const id = validUserId(userId);
      if (!id || !data.users[id]) return false;
      const users = { ...data.users };
      delete users[id];
      data = { version: 1, users };
      await persist();
      return true;
    },
    snapshot() { return structuredClone(data); },
  };
}

export function parseRouteCommand(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  const session = /^\/session\s+(\S+)$/iu.exec(value);
  if (session) return { kind: 'session', sessionId: session[1] };
  if (/^\/(?:list|sessions)$/iu.test(value)) return { kind: 'list' };
  if (/^\/(?:new|clear)$/iu.test(value)) return { kind: 'clear' };
  return null;
}
