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
  await store.set('user1', 's1', { title: 'A', cwd: 'D:/a' });
  await store.set('user1', 's2');
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.users.user1.sessionId, 's2');
  assert.equal(raw.users.user1.updatedAt, 123);
  const reloaded = await loadRouteStore(path);
  assert.equal(reloaded.get('user1').sessionId, 's2');
  assert.equal(await reloaded.clear('user1'), true);
});
test('parseRouteCommand covers session/list/clear', () => {
  assert.deepEqual(parseRouteCommand('/session s1'), { kind: 'session', sessionId: 's1' });
  assert.equal(parseRouteCommand('/list').kind, 'list');
  assert.equal(parseRouteCommand('/new').kind, 'clear');
  assert.equal(parseRouteCommand('hello'), null);
});
