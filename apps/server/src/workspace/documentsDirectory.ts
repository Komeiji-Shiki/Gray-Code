import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function documentsDirectory(supplied?: string): () => Promise<string> {
  let current: Promise<string> | undefined;
  return () => current ??= (async () => {
    if (supplied) return supplied;
    if (process.platform !== 'win32') return path.join(os.homedir(), 'Documents');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath("MyDocuments")'], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    const directory = stdout.trim();
    if (!path.isAbsolute(directory)) throw new Error('无法确定用户文档目录，请指定项目目录。');
    return directory;
  })();
}
