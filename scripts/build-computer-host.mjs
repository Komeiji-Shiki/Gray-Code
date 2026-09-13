import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 使用 Windows 随系统提供的 .NET Framework，桌面包不要求用户另装 SDK。
export function buildComputerHost(output = 'apps/server/dist/computer-host') {
  if (process.platform !== 'win32') return;
  const framework = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('构建 Windows 电脑操作宿主需要 .NET Framework 4。');
  const source = path.join(root, 'native/windows/ComputerHost');
  const destination = path.resolve(root, output);
  fs.mkdirSync(destination, { recursive: true });
  const references = ['System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Management.dll',
    'WPF/WindowsBase.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll'];
  const executable = path.join(destination, 'GrayCode.ComputerHost.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/utf8output', '/out:' + executable,
    '/win32manifest:' + path.join(source, 'app.manifest'),
    ...references.map(file => '/reference:' + path.join(framework, file)),
    ...fs.readdirSync(source).filter(file => file.endsWith('.cs')).sort().map(file => path.join(source, file))],
  { stdio: 'inherit', windowsHide: true });
  console.log('Windows computer host built:', path.relative(root, executable));
  return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildComputerHost(process.argv[2]);
