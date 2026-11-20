// Durable DSH Desktop restart request. Never store WeChat/DSH credentials.
// After Desktop starts again, it reads this ticket and acknowledges only
// when a different Desktop main process was confirmed by the OS worker.
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RESTART_TTL_MS = 10 * 60 * 1000;
const scriptPath = fileURLToPath(new URL('../scripts/restart-desktop.ps1', import.meta.url));

export function createDesktopRestartDriver({ platform = process.platform,
  execFile = promisify(nodeExecFile), spawn = nodeSpawn } = {}) {
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
    async launch(ticketPath) {
      if (platform !== 'win32' || !isAbsolute(ticketPath)) throw new Error('invalid-desktop-restart-request');
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath, '-Mode', 'Execute', '-TicketPath', ticketPath],
          { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
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
    && ['armed', 'restarted'].includes(ticket.phase));
}

export function ticketReadyToNotify(ticket, { botId, userId, mainPid, now = Date.now() }) {
  return ticketActive(ticket, now) && ticket.phase === 'restarted'
    && ticket.botId === botId && ticket.userId === userId
    && Number.isSafeInteger(ticket.oldMainPid) && ticket.oldMainPid > 0
    && Number.isSafeInteger(ticket.newMainPid) && ticket.newMainPid > 0
    && ticket.newMainPid !== ticket.oldMainPid && mainPid === ticket.newMainPid;
}
