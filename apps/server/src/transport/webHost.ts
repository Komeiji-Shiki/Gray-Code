import path from 'node:path';
import os from 'node:os';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { PlatformApplication } from '../application';
import type { ApplicationRouter, ClientSession } from './router';

export function directoryBreadcrumbs(directory: string, paths = path) {
  const result: { name: string; path: string }[] = [];
  for (let current = directory; ; current = paths.dirname(current)) {
    result.unshift({ name: paths.basename(current) || current, path: current });
    if (paths.dirname(current) === current) return result;
  }
}

/** Web 端设备操作在部署电脑执行，任务和交互式终端使用同一核心。 */
export class WebHost {
  constructor(private readonly app: PlatformApplication, private readonly router: ApplicationRouter) {}
  async call(client: ClientSession, method: string, params: Record<string, any>): Promise<unknown> {
    if (method === 'host.directories') {
      this.app.requireOwner(client.actorId);
      const directory = await realpath(params.path ? String(params.path) : process.cwd());
      if (!(await stat(directory)).isDirectory()) throw new Error('请选择目录。');
      const entries = await readdir(directory, { withFileTypes: true });
      const directories = (await Promise.all(entries.map(async entry => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return { name: entry.name, path: target };
        if (entry.isSymbolicLink()) {
          try { if ((await stat(target)).isDirectory()) return { name: entry.name, path: target }; }
          catch { /* 无法访问的链接不作为可选目录，其他目录仍正常列出。 */ }
        }
        return null;
      }))).filter((entry): entry is { name: string; path: string } => entry !== null)
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
      const candidates = process.platform === 'win32'
        ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
        : ['/', os.homedir()];
      const roots = (await Promise.all(candidates.map(async root => {
        try { return (await stat(root)).isDirectory() ? { name: root, path: root } : null; }
        catch { return null; }
      }))).filter((root): root is { name: string; path: string } => root !== null);
      return { directory, name: path.basename(directory) || directory, parent: path.dirname(directory),
        breadcrumbs: directoryBreadcrumbs(directory),
        device: { id: 'local', name: os.hostname() }, roots,
        directories };
    }
    return this.router.call(client, method, params);
  }
}
