import path from 'node:path';
import os from 'node:os';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { PlatformApplication } from '../application';
import type { ApplicationRouter, ClientSession } from './router';

/** Web 端设备操作在部署电脑执行，任务和交互式终端使用同一核心。 */
export class WebHost {
  constructor(private readonly app: PlatformApplication, private readonly router: ApplicationRouter) {}
  async call(client: ClientSession, method: string, params: Record<string, any>): Promise<unknown> {
    if (method === 'host.directories') {
      this.app.requireOwner(client.actorId);
      const directory = await realpath(params.path ? String(params.path) : process.cwd());
      if (!(await stat(directory)).isDirectory()) throw new Error('请选择目录。');
      const entries = await readdir(directory, { withFileTypes: true });
      const candidates = process.platform === 'win32'
        ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
        : ['/', os.homedir()];
      const roots = (await Promise.all(candidates.map(async root => {
        try { return (await stat(root)).isDirectory() ? { name: root, path: root } : null; }
        catch { return null; }
      }))).filter((root): root is { name: string; path: string } => root !== null);
      return { directory, name: path.basename(directory) || directory, parent: path.dirname(directory),
        device: { id: 'local', name: os.hostname() }, roots,
        directories: entries.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, path: path.join(directory, entry.name) })) };
    }
    return this.router.call(client, method, params);
  }
}
