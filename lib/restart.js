// Durable DSH Desktop restart request. Never store WeChat/DSH credentials.
// After Desktop starts again, it reads this ticket and acknowledges only
// when a different Desktop main process was confirmed by the OS worker.
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RESTART_TTL_MS = 10 * 60 * 1000;
const scriptPath = fileURLToPath(new URL('../scripts/restart-desktop.ps1', import.meta.url));const schedulerPath = fileURLToPath(new URL('../scripts/schedule-desktop-restart.ps1', import.meta.url));

export function createDesktopRestartDriver({ platform = process.platform,
  execFile = promisify(nodeExecFile) } = {}) {
  return {
    async inspect() {
      if (platform !== 'win32') throw new Error('desktop-restart-requires-windows');
      let stdout;
      try {
        ({ stdout } = await execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath, '-Mode', 'Check'],
          { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 }));
      } catch (error) {
        const codes = { 10: 'desktop-not-running', 11: 'desktop-root-ambiguous', 12: 'desktop-bundle-missing' };
        const code = codes[Number(error?.code)] ?? 'desktop-check-failed';
        const wrapped = new Error(code);
        wrapped.code = code;
        throw wrapped;
      }
      const details = JSON.parse(String(stdout).trim());
      if (!Number.isSafeInteger(details?.pid) || details.pid <= 0
          || typeof details.exePath !== 'string'
          || !isAbsolute(details.exePath)
          || basename(details.exePath).toLowerCase() !== 'deepseek harness.exe') {
        throw new Error('invalid-dsh-desktop-main-process');
      }
      return { pid: details.pid, exePath: details.exePath };
    },
    async verifyClean(ticketPath) {
      if (platform !== 'win32' || !isAbsolute(ticketPath)) {
        throw new Error('invalid-desktop-restart-cleanup-check');
      }
      const { stdout } = await execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath, '-Mode', 'CheckClean', '-TicketPath', ticketPath],
        { windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
      if (JSON.parse(String(stdout).trim())?.clean !== true) {
        throw new Error('desktop-restart-cleanup-unverified');
      }
      return true;
    },
    async launch(ticketPath) {
      if (platform !== 'win32' || !isAbsolute(ticketPath)) {
        throw new Error('invalid-desktop-restart-request');
      }
      // Do not start a descendant of the Electron Host: Windows can kill its
      // entire Job Object on exit. Task Scheduler launches one independent
      // short-lived worker with no trigger or recurrence. We wait until the
      // worker has actually claimed the request, not merely until spawn().
      try {
        const { stdout } = await execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', schedulerPath, '-TicketPath', ticketPath],
          { windowsHide: true, timeout: 22_000, maxBuffer: 4096 });
        const acknowledgement = JSON.parse(String(stdout).trim());
        if (acknowledgement?.workerStarted !== true) {
          throw new Error('restart-worker-not-acknowledged');
        }
      } catch {
        const error = new Error('restart-worker-not-started');
        error.code = 'restart-worker-not-started';
        throw error;
      }
    },
  };
}

export function restartTicketPath(stateRoot, botId) {
  if (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(botId)) {
    throw new Error('invalid bot identity for restart ticket');
  }
  return join(stateRoot, botId, 'desktop-restart.json');
}

export async function readRestartTicket(path) {
  try {
    const ticket = JSON.parse(await readFile(path, 'utf8'));
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)
      || ticket.version !== 1 || typeof ticket.requestId !== 'string') {
      throw new Error('invalid-restart-ticket');
    }
    return ticket;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeRestartTicket(path, ticket) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, JSON.stringify(ticket, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export function ticketActive(ticket, now = Date.now()) {
  return Boolean(ticket && ticket.version === 1
    && Number.isSafeInteger(ticket.requestedAt) && Number.isSafeInteger(ticket.expiresAt)
    && ticket.requestedAt <= now && now < ticket.expiresAt
    && ['armed', 'executing', 'restarted'].includes(ticket.phase));
}

export function ticketReadyToNotify(ticket, { botId, userId, mainPid, now = Date.now() }) {
  return ticketActive(ticket, now) && ticket.phase === 'restarted'
    && ticket.botId === botId && ticket.userId === userId
    && Number.isSafeInteger(ticket.oldMainPid) && ticket.oldMainPid > 0
    && Number.isSafeInteger(ticket.newMainPid) && ticket.newMainPid > 0
    && ticket.newMainPid !== ticket.oldMainPid && mainPid === ticket.newMainPid;
}
