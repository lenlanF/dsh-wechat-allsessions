import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windir = process.env.WINDIR || 'C:\\Windows';
const compilers = [
  join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const compiler = compilers.find(existsSync);
if (!compiler) throw new Error('Windows .NET Framework C# compiler (csc.exe) is required');
const source = join(root, 'scripts', 'windows', 'desktop-restart-native.cs');
const output = join(root, 'bin', 'win-x64', 'dsh-wechat-restart.exe');
mkdirSync(dirname(output), { recursive: true });
execFileSync(compiler, [
  '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
  '/reference:System.Management.dll',
  '/reference:System.Web.Extensions.dll',
  '/reference:Microsoft.CSharp.dll',
  '/out:' + output,
  source,
], { cwd: root, windowsHide: true, stdio: 'inherit' });

const bytes = readFileSync(output);
if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('restart helper is not a PE executable');
const peOffset = bytes.readUInt32LE(0x3c);
const subsystem = bytes.readUInt16LE(peOffset + 24 + 68);
if (subsystem !== 2) throw new Error('restart helper must use the Windows GUI subsystem (PE subsystem 2)');
process.stdout.write('Built invisible Windows GUI restart helper: ' + output + '\n');
