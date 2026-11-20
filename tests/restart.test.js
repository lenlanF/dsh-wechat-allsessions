import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RESTART_TTL_MS, restartTicketPath, readRestartTicket, writeRestartTicket,
  ticketActive, ticketReadyToNotify, createDesktopRestartDriver } from '../lib/restart.js';

const testRoot = process.env.DSH_PLUGIN_TEST_TMP || tmpdir();

test('restart ticket has no credentials, stores atomically and survives reopening', async t => {
  const dir = await mkdtemp(join(testRoot, 'wechat-restart-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = restartTicketPath(dir, 'wx_a1b2');
  const now = Date.now();
  const ticket = {
    version: 1, requestId: '00000000-0000-4000-8000-000000000000', phase: 'armed',
    botId: 'wx_a1b2', userId: 'owner', oldMainPid: 10, newMainPid: null,
    exePath: 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    requestedAt: now, expiresAt: now + RESTART_TTL_MS,
  };
  assert.equal(await readRestartTicket(path), null);
  await writeRestartTicket(path, ticket);
  assert.deepEqual(await readRestartTicket(path), ticket);
  assert.equal(ticketActive(ticket, now + 1), true);
  assert.equal(ticketActive(ticket, now + RESTART_TTL_MS + 1), false);
  await writeRestartTicket(path, { ...ticket, phase: 'restarted', newMainPid: 11 });
  const after = await readRestartTicket(path);
  assert.equal(ticketReadyToNotify(after, { botId: ticket.botId, userId: 'owner', mainPid: 11 }), true);
  assert.equal(ticketReadyToNotify(after, { botId: ticket.botId, userId: 'owner', mainPid: 10 }), false);
  assert.equal(ticketReadyToNotify(after, { botId: ticket.botId, userId: 'stranger', mainPid: 11 }), false);
  assert.equal(ticketReadyToNotify(after, { botId: 'wx_other', userId: 'owner', mainPid: 11 }), false);
  assert.equal(JSON.stringify(after).includes('FAKE_ACCOUNT_TOKEN'), false);
  const contents = await readFile(path, 'utf8');
  assert.equal(contents.includes('context_token'), false);
});

test('invalid persisted ticket and path traversal in bot ID fail closed', async t => {
  const dir = await mkdtemp(join(testRoot, 'wechat-restart-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => restartTicketPath(dir, '../outside'), /invalid bot identity/);
  assert.throws(() => restartTicketPath(dir, 'x/y'), /invalid bot identity/);
  assert.throws(() => restartTicketPath(dir, ''), /invalid bot identity/);
  const path = join(dir, 'broken.json');
  await writeFile(path, '{"ticket":', 'utf8');
  await assert.rejects(readRestartTicket(path), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), '{"ticket":');
});

test('restart driver refuses unsafe platforms or ambiguous executable paths', async () => {
  const other = createDesktopRestartDriver({ platform: 'linux' });
  await assert.rejects(other.inspect(), /requires-windows/);
  await assert.rejects(other.launch('relative-path'), /invalid-desktop-restart/);
  const malformed = createDesktopRestartDriver({
    platform: 'win32',
    execFile: async () => ({ stdout: JSON.stringify({ pid: 12, exePath: 'D:\\unexpected.exe' }) }),
    spawn() { throw new Error('should not launch'); },
  });
  await assert.rejects(malformed.inspect(), /invalid-dsh-desktop-main-process/);
});

test('the built-in Windows restart check launches only an argument-vector PowerShell command', async () => {
  let args;
  const valid = createDesktopRestartDriver({
    platform: 'win32',
    execFile: async (_exe, argv, opts) => {
      args = { argv, opts };
      return { stdout: JSON.stringify({
        pid: 321,
        exePath: 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
      }) };
    },
  });
  const item = await valid.inspect();
  assert.equal(item.pid, 321);
  assert.ok(args.argv.includes('-Mode') && args.argv.includes('Check'));
  assert.ok(args.argv.some(value => value.endsWith('restart-desktop.ps1')));
  assert.equal(args.argv[0], '-NoProfile');
  assert.equal(args.opts.windowsHide, true);
});
