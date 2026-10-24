import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 本机代理按约定位置找到控制接口；与 ~/.graycode/skills 同属用户级目录。 */
export function controlDiscoveryDirectory(): string { return path.join(os.homedir(), '.graycode', 'control-api'); }

export interface ControlDiscovery {
  url: string;
  token: string;
  version: string;
  dataDirectory: string;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * 每个实例一个 <pid>.json，接口监听时写入地址与令牌，停止或退出时删除。令牌与加密凭据的
 * 读取权限相同：同一用户的进程本来就能解密凭据存储，文件只多了一个约定位置。
 */
export class ControlDiscoveryFile {
  private readonly file: string;
  private written = '';

  constructor(private readonly directory: string) {
    this.file = path.join(directory, `${process.pid}.json`);
  }

  async write(value: ControlDiscovery): Promise<void> {
    const content = JSON.stringify({ ...value, pid: process.pid, startedAt: Date.now(),
      help: `GET ${value.url}/v1 列出全部接口；请求头 Authorization: Bearer <token>。` }, null, 2);
    const identity = JSON.stringify(value);
    if (this.written === identity) return;
    await mkdir(this.directory, { recursive: true });
    await this.removeStale();
    await writeFile(this.file, content, { encoding: 'utf8', mode: 0o600 });
    this.written = identity;
  }

  async remove(): Promise<void> {
    if (!this.written) return;
    await rm(this.file, { force: true });
    this.written = '';
  }

  /** 进程异常退出时来不及删除，下次写入时清理已经不存在的进程留下的文件。 */
  private async removeStale(): Promise<void> {
    for (const name of await readdir(this.directory)) {
      const pid = Number(path.basename(name, '.json'));
      if (name.endsWith('.json') && Number.isInteger(pid) && pid !== process.pid && !alive(pid))
        await rm(path.join(this.directory, name), { force: true });
    }
  }
}
