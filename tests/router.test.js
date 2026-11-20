import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRouteStore, normalizeRoutes, parseRouteCommand } from '../lib/router.js';

test('normalizeRoutes drops malformed entries', () => {
  const r = normalizeRoutes({ users: { good: { sessionId: 's1', title: 'T' }, bad: { sessionId: '' }, '': { sessionId: 's2' } } });
  assert.deepEqual(Object.keys(r.users), ['good']);
  assert.equal(r.users.good.sessionId, 's1');
});
test('route store persists and replaces a user session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-routes-'));
  const path = join(dir, 'nested', 'sessions.json');
  const store = await loadRouteStore(path, () => 123);
  await store.bind('s1', { title: 'A', cwd: 'D:/a', archived: false });
  await store.bind('s2', { title: 'B', archived: false });
  await store.set('user1', 's1', { title: 'A', cwd: 'D:/a' });
  await store.set('user1', 's2');
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.users.user1.sessionId, 's2');
  assert.equal(raw.users.user1.updatedAt, 123);
  const reloaded = await loadRouteStore(path);
  assert.equal(reloaded.get('user1').sessionId, 's2');
  assert.equal(await reloaded.clear('user1'), true);
});
test('v2 migration preserves explicit selections and broadcast-off but not discovery-only rows', () => {
  const r = normalizeRoutes({
    version: 2,
    users: { owner: { sessionId: 'manual', title: 'Selected' } },
    sessions: {
      manual: { title: 'Selected', broadcastEnabled: true },
      muted: { title: 'Muted', broadcastEnabled: false },
      discovered: { title: 'Discovery only', broadcastEnabled: true },
    },
  });
  assert.equal(r.version, 3);
  assert.equal(r.sessions.manual.bound, true);
  assert.equal(r.sessions.muted.bound, true);
  assert.equal(r.sessions.muted.broadcastEnabled, false);
  assert.equal(r.sessions.discovered.bound, false);
  assert.equal(normalizeRoutes(r).sessions.discovered.bound, false);
});
test('discovery never creates a binding; only bind() persists one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bind-'));
  const store = await loadRouteStore(join(dir, 'sessions.json'));
  await store.syncSessions([{ sessionId: 'old', title: 'Old unbroadcast' }], { authoritative: true });
  assert.deepEqual(store.listSessions(), []);
  assert.equal(store.getSession('old'), null);
  await assert.rejects(store.set('owner', 'old'));
  await assert.rejects(store.bind('old', { archived: true }));
  await store.bind('old', { title: 'Old unbroadcast', archived: false });
  assert.deepEqual(store.listSessions().map(s => s.sessionId), ['old']);
  await store.set('owner', 'old');
  await store.syncSessions([{ sessionId: 'old', title: 'New title', archived: false }]);
  assert.equal(store.getSession('old').title, 'New title');
  assert.equal(store.get('owner').sessionId, 'old');
});
test('parseRouteCommand covers session/list/clear', () => {
  assert.deepEqual(parseRouteCommand('/session s1'), { kind: 'session', sessionId: 's1' });
  assert.deepEqual(parseRouteCommand('/list'), { kind: 'list', page: 1 });
  assert.deepEqual(parseRouteCommand('/list -p 2'), { kind: 'list', page: 2 });
  assert.deepEqual(parseRouteCommand('/session'), { kind: 'session-list', page: 1 });
  assert.deepEqual(parseRouteCommand('/session -p 3'), { kind: 'session-list', page: 3 });
  assert.deepEqual(parseRouteCommand('/session add old-session'), { kind: 'session-add', sessionId: 'old-session' });
  assert.deepEqual(parseRouteCommand('/session add'), { kind: 'session-usage' });
  assert.deepEqual(parseRouteCommand('/list -p 0'), { kind: 'list-usage' });
  assert.deepEqual(parseRouteCommand('/session -p 0'), { kind: 'session-usage' });
  assert.equal(parseRouteCommand('/new').kind, 'clear');
  assert.equal(parseRouteCommand('hello'), null);
});
