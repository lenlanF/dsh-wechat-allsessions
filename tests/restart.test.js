import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('the built-in Windows process check uses the packaged GUI helper', async () => {
  let captured;
  const valid = createDesktopRestartDriver({
    platform: 'win32',
    execFile: async (executable, argv, options) => {
      captured = { executable, argv, options };
      return { stdout: JSON.stringify({
        pid: 321,
        exePath: 'D:\\Program\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
        treeCount: 4,
      }) };
    },
  });
  const item = await valid.inspect();
  assert.equal(item.pid, 321);
  assert.ok(captured.executable.endsWith('dsh-wechat-restart.exe'));
  assert.deepEqual(captured.argv, ['--check']);
  assert.equal(captured.options.windowsHide, true);
});

test('restart launches an independent one-shot task through the native GUI helper', async () => {
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
  assert.ok(captured[0].executable.endsWith('dsh-wechat-restart.exe'));
  assert.deepEqual(captured[0].args, ['--schedule', 'D:\\Temp\\request.json']);
  assert.equal(captured[0].options.windowsHide, true);
  assert.equal(captured[0].options.timeout, 35_000);
  const fail = createDesktopRestartDriver({
    platform: 'win32', execFile: async () => ({ stdout: '{"workerStarted":false}' }),
  });
  await assert.rejects(() => fail.launch('D:\\Temp\\request.json'), /restart-worker-not-started/);
});

test('completion is withheld until the native helper verifies process and task cleanup', async () => {
  const captured = [];
  const driver = createDesktopRestartDriver({
    platform: 'win32',
    execFile: async (executable, argv, options) => {
      captured.push({ executable, argv, options });
      return { stdout: '{"clean":true}' };
    },
  });
  assert.equal(await driver.verifyClean('D:\\Temp\\request.json'), true);
  assert.ok(captured[0].executable.endsWith('dsh-wechat-restart.exe'));
  assert.deepEqual(captured[0].argv, ['--check-clean', 'D:\\Temp\\request.json']);
  assert.equal(captured[0].options.windowsHide, true);
  const unclean = createDesktopRestartDriver({
    platform: 'win32', execFile: async () => ({ stdout: '{"clean":false}' }),
  });
  await assert.rejects(() => unclean.verifyClean('D:\\Temp\\request.json'), /cleanup-unverified/);
});

test('restart runtime has no console interpreter and ships a Windows GUI-subsystem helper', async () => {
  const source = await readFile(new URL('../scripts/windows/desktop-restart-native.cs', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../lib/restart.js', import.meta.url), 'utf8');
  const binary = await readFile(new URL('../bin/win-x64/dsh-wechat-restart.exe', import.meta.url));
  const peOffset = binary.readUInt32LE(0x3c);
  const subsystem = binary.readUInt16LE(peOffset + 24 + 68);
  assert.equal(subsystem, 2, 'helper must be PE GUI subsystem, not console subsystem');
  assert.equal(runtime.toLowerCase().includes('powershell.exe'), false);
  assert.equal(runtime.toLowerCase().includes('cmd.exe'), false);
  assert.equal(source.toLowerCase().includes('powershell.exe'), false);
  assert.equal(source.toLowerCase().includes('cmd.exe'), false);
  assert.ok(source.includes('definition.Principal.LogonType = 3'));
  assert.ok(source.includes('definition.Principal.RunLevel = runLevel'));
  assert.ok(source.includes('definition.Settings.MultipleInstances = 2'));
  assert.ok(source.includes('RegisterTask(desktopName, exePath, "", null, "PT0S", true,'));
  assert.ok(source.includes('DateTime.Now.AddMinutes(3)'));
  assert.ok(source.includes('CleanupTasks(requestId)'));
  assert.equal(source.split('Triggers.Create(').length - 1, 1,
    'only the bounded fallback cleanup task may have a one-time trigger');
  assert.equal(source.includes('Repetition.Interval'), false);
});


test('restart worker task matches the existing Desktop elevation without UAC or a console', async () => {
  const source = await readFile(new URL('../scripts/windows/desktop-restart-native.cs', import.meta.url), 'utf8');
  assert.ok(source.includes('TokenElevationClass = 20'));
  assert.ok(source.includes('IsProcessElevated(target.Pid) ? 1 : 0'));
  assert.ok(source.includes('Put(ticket, "oldMainElevated", runLevel)'));
  assert.ok(source.includes('"PT5M", true, runLevel'));
  assert.ok(source.includes('desktop-worker-elevation-mismatch'));
  assert.ok(source.includes('(int)Number(ticket, "oldMainElevated")'));
  assert.ok(source.includes('--probe-task-high'));
  assert.ok(source.includes('desktop-process-stop-denied'));
  assert.ok(source.includes('desktop-process-stop-race'));
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

test('native helper distinguishes PID reuse and parent changes by process creation time', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only native process identity test');
    return;
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exe = new URL('../bin/win-x64/dsh-wechat-restart.exe', import.meta.url);
  const { stdout } = await promisify(execFile)(
    fileURLToPath(exe), ['--probe-identity', String(process.pid)],
    { windowsHide: true, timeout: 15000, maxBuffer: 4096 });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, {
    safeIdentity: true,
    parentChangeHarmless: true,
    pidReuseRejected: true,
    pathMismatchRejected: true,
  });
});

test('snapshot cleanup checks creation time, current process handle and late child residue', async () => {
  const source = await readFile(new URL('../scripts/windows/desktop-restart-native.cs', import.meta.url), 'utf8');
  assert.ok(source.includes('CreatedAtDmtf'));
  assert.ok(source.includes('ManagementDateTimeConverter.ToDateTime'));
  assert.ok(source.includes('ProcessHandleMatches(entry, process)'));
  assert.ok(source.includes('IsOriginalInstanceAlive(entry)'));
  assert.ok(source.includes('GetDesktopProcesses(exePath).Count > 0'));
  assert.ok(source.includes('oldTreeInstances'));
  assert.ok(source.includes('oldMainCreatedAt'));
  assert.ok(source.includes('desktop-main-identity-changed'));
  assert.ok(source.includes('old-desktop-process-residue'));
  assert.equal(source.includes('current.ParentPid != entry.ParentPid'), false);
});

test('native helper atomically persists restart tickets and verifies a single executable process tree', async () => {
  const source = await readFile(new URL('../scripts/windows/desktop-restart-native.cs', import.meta.url), 'utf8');
  assert.ok(source.includes('File.Replace(temp, path, backup)'));
  assert.ok(source.includes('GetDesktopTree'));
  assert.ok(source.includes('StopDesktopTree'));
  assert.ok(source.includes('oldTreePids'));
  assert.ok(source.includes('old-desktop-process-residue'));
  assert.ok(source.includes('desktop-new-main-not-stable'));
  assert.ok(source.includes('desktop-stopped-during-task-cleanup'));
  assert.ok(source.includes('workerPid'));
  assert.ok(source.includes('PT0S'));
});
