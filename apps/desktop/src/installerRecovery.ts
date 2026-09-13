import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { DesktopRecovery } from './installer';

/** 修复入口保存在程序目录之外，安装中断后仍可使用旧包重新安装程序文件。 */
export async function writeProgramRecovery(recovery: DesktopRecovery, installDirectory: string, restartArgs: string[], template: string) {
  const directory = path.dirname(recovery.packagePath);
  await fs.copyFile(template, path.join(directory, 'restore-program.ps1'));
  await fs.writeFile(path.join(directory, 'recovery.json'), JSON.stringify({ format: 1, installDirectory,
    version: recovery.version, packageFile: path.basename(recovery.packagePath), packageSha256: recovery.packageSha256,
    backupFile: path.basename(recovery.backupPath), restartArgs }, null, 2), { mode: 0o600 });
  // cmd 入口只包含 ASCII，路径由批处理自身的位置确定，不插入用户配置。
  await fs.writeFile(path.join(directory, 'Restore-GrayCode.cmd'), '@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-program.ps1"\r\npause\r\n');
}
