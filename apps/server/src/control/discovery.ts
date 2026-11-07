import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ControlMcpLaunch } from '@graycode/contracts';

/** 本机代理按约定位置找到控制接口；与 ~/.graycode/skills 同属用户级目录。 */
export function controlDiscoveryDirectory(): string { return path.join(os.homedir(), '.graycode', 'control-api'); }

export interface ControlDiscovery {
  /** 本机管道：HTTP 请求直接发到这里，不需要令牌。 */
  pipe: string;
  mcp: ControlMcpLaunch;
  /** 网络端口正在监听时的地址；它需要的令牌不写进文件。 */
  http?: { url: string };
  version: string;
  dataDirectory: string;
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * 每个实例一个 <pid>.json，本机管道监听时写入，退出时删除。目录只有当前用户可读，管道地址带随机段：
 * 其他账号既读不到地址，也无法抢先占用同名管道冒充 GrayCode。
 */
export class ControlDiscoveryFile {
  private readonly file: string;
  private readonly startedAt = Date.now();
  private written = '';

  constructor(private readonly directory: string) {
    this.file = path.join(directory, `${process.pid}.json`);
  }

  /** 为本进程分配本机管道地址；Unix socket 放在发现目录里，监听前清掉同一进程号留下的旧文件。 */
  async pipe(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') return `\\\\.\\pipe\\graycode-control-${randomUUID()}`;
    const socket = path.join(this.directory, `${process.pid}.sock`);
    await rm(socket, { force: true });
    return socket;
  }

  async write(value: ControlDiscovery): Promise<void> {
    const content = JSON.stringify({ ...value, pid: process.pid, startedAt: this.startedAt,
      help: `把 HTTP 请求发到 pipe（GET /v1 列出全部接口），或让 MCP 客户端用 mcp 中的命令启动控制桥。` }, null, 2);
    const identity = JSON.stringify(value);
    if (this.written === identity) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.removeStale();
    await writeFile(this.file, content, { encoding: 'utf8', mode: 0o600 });
    this.written = identity;
  }

  async remove(): Promise<void> {
    if (!this.written) return;
    await rm(this.file, { force: true });
    this.written = '';
  }

  /** 进程异常退出时来不及删除，下次写入时清理已经不存在的进程留下的发现文件和 socket。 */
  private async removeStale(): Promise<void> {
    for (const name of await readdir(this.directory)) {
      const pid = Number(path.basename(name, path.extname(name)));
      if (/\.(json|sock)$/.test(name) && Number.isInteger(pid) && pid !== process.pid && !processAlive(pid))
        await rm(path.join(this.directory, name), { force: true });
    }
  }
}
