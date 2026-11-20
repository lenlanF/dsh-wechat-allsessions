import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RESTART_TTL_MS, restartTicketPath, readRestartTicket, writeRestartTicket,// Native driver errors are intentionally normalized before sending to WeChat.
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

test('launch waits for an independent one-time worker acknowledgement', async () => {
  const captured = [];
  const driver = createDesktopRestartDriver({
    platform: 'win32',
    execFile: async (executable, args, options) => {
      captured.push({ executable, args, options });
      return { stdout: '{"workerStarted":true}' };
    },
  });
  await driver.launch('D:\\Temp\\request.json');
  assert.equal(captured.length, 1);
  assert.ok(captured[0].args.some(arg => arg.endsWith('schedule-desktop-restart.ps1')));
  assert.ok(captured[0].args.includes('D:\\Temp\\request.json'));
  assert.equal(captured[0].options.windowsHide, true);
  assert.equal(captured[0].options.timeout, 22_000);
  const fail = createDesktopRestartDriver({
    platform: 'win32', execFile: async () => ({ stdout: '{"workerStarted":false}' }),
  });
  await assert.rejects(() => fail.launch('D:\\Temp\\request.json'), /restart-worker-not-started/);
});

test('cleanup verification rejects a leftover task or worker', async () => {
  const called = [];
  const driver = createDesktopRestartDriver({
    platform: 'win32',
    execFile: async (_program, argv) => {
      called.push(argv);
      return { stdout: '{"clean":true}' };
    },
  });
  assert.equal(await driver.verifyClean('D:\\Temp\\request.json'), true);
  assert.ok(called[0].includes('CheckClean'));
  const unclean = createDesktopRestartDriver({
    platform: 'win32', execFile: async () => ({ stdout: '{"clean":false}' }),
  });
  await assert.rejects(() => unclean.verifyClean('D:\\Temp\\request.json'), /cleanup-unverified/);
});

test('scheduled restart is on-demand with no triggers, repetition, escalation or permanent worker', async () => {
  const scheduler = await readFile(new URL('../scripts/schedule-desktop-restart.ps1', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../scripts/restart-desktop.ps1', import.meta.url), 'utf8');
  assert.ok(scheduler.includes('Schedule.Service'));
  assert.ok(scheduler.includes('AllowDemandStart'));
  assert.doesNotMatch(scheduler, /\.Triggers\.Create\(/);
  assert.ok(scheduler.includes('LogonType = 3'));
  assert.ok(scheduler.includes('RunLevel = 0'));
  assert.ok(worker.includes('Remove-ScheduledTask'));
  assert.ok(worker.indexOf('Remove-ScheduledTask\n  Write-Ticket $ticket')
    < worker.indexOf('Stop-Process -Id $entry.pid'));
  assert.ok(worker.includes('old-desktop-process-residue'));
  assert.ok(worker.includes("CheckClean"));
  assert.doesNotMatch(worker, /^\s*taskkill\b/m);
});

test('Windows Desktop root preflight exposes fixed error codes without private data', async () => {
  const causes = [
    [10, 'desktop-not-running'],
    [11, 'desktop-root-ambiguous'],
    [12, 'desktop-bundle-missing'],
    [13, 'desktop-check-failed'],
    ['ENOENT', 'desktop-check-failed'],
  ];
  for (const [exitCode, expected] of causes) {
    const driver = createDesktopRestartDriver({
      platform: 'win32',
      execFile: async () => {
        const err = new Error('redact-private-arguments-and-paths');
        err.code = exitCode;
        throw err;
      },
    });
    await assert.rejects(() => driver.inspect(), error => {
      assert.equal(error.code, expected);
      assert.equal(error.message, expected);
      assert.ok(!error.message.includes('redact-private'));
      return true;
    });
  }
});

test('Windows restart script writes tickets with nonempty atomic backup paths', async () => {
  const source = await readFile(new URL('../scripts/restart-desktop.ps1', import.meta.url), 'utf8');
  assert.match(source, /\[IO\.File\]::Replace\(\$tmp,\s*\$TicketPath,\s*\$backup\)/);
  assert.ok(source.includes("worker-"));
  assert.match(source, /if \(Test-Path -LiteralPath \$backup\)/);
  assert.doesNotMatch(source, /\[IO\.File\]::Replace\(\$tmp,\s*\$TicketPath,\s*\$null\)/);
});

test('shipped PowerShell driver selects root by parent PID and stops only verified executable subtree', async () => {
  const source = await readFile(new URL('../scripts/restart-desktop.ps1', import.meta.url), 'utf8');
  assert.match(source, /ParentProcessId/);
  assert.match(source, /Get-DesktopTree/);
  assert.match(source, /Sort-Object depth -Descending/);
  assert.match(source, /Stop-Process -Id \$entry\.pid -Force/);
  assert.doesNotMatch(source, /^\s*taskkill\b/m);
  assert.ok(source.includes('desktop-root-process-not-unique'));
});
