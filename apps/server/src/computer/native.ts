import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ComputerError, type ComputerNativePort, type NativeComputerStatus } from './port';

interface Pending { resolve(value: any): void; reject(error: Error): void; cleanup(): void }

export class WindowsComputerNative implements ComputerNativePort {
  readonly available: boolean;
  identity?: { pid: number; executable: string; startedAt: number };
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private exiting?: Promise<void>;
  private closing = false;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(status: NativeComputerStatus) => void>();
  constructor(readonly executable = path.join(__dirname, 'computer-host', 'GrayCode.ComputerHost.exe')) {
    this.available = process.platform === 'win32' && fs.existsSync(executable);
  }
  subscribe(listener: (status: NativeComputerStatus) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(status: NativeComputerStatus) { for (const listener of this.listeners) listener(status); }
  private start() {
    if (this.closing) return Promise.reject(new ComputerError('HOST_CLOSED', '电脑操作宿主已经关闭。'));
    if (!this.available) return Promise.reject(new ComputerError('COMPUTER_UNAVAILABLE', '当前设备未提供 Windows 电脑操作宿主，请检查安装内容。'));
    return this.starting ??= new Promise<void>((resolve, reject) => {
      const child = this.child = spawn(this.executable, [], { windowsHide: true, stdio: 'pipe', shell: false });
      let ready = false, diagnostic = '';
      this.identity = child.pid ? { pid: child.pid, executable: this.executable, startedAt: Date.now() } : undefined;
      const timer = setTimeout(() => { reject(new ComputerError('HOST_TIMEOUT', '电脑操作宿主没有完成启动。')); void this.terminate(child, 'host_timeout'); }, 8000);
      child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-2000); });
      child.stdin.on('error', () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.ready && message.protocol === 1) { ready = true; clearTimeout(timer); resolve(); return; }
          if (message.fatal) { reject(new ComputerError(message.code, message.error)); void this.terminate(child, 'host_failed'); return; }
          if (message.eventType === 'control.changed') { this.changed(message.status); return; }
          const request = this.pending.get(message.id); if (!request) return;
          this.pending.delete(message.id); request.cleanup();
          if (message.error) request.reject(new ComputerError(message.error.code, message.error.message));
          else request.resolve(message.result);
        } catch { void this.terminate(child, 'protocol_error'); }
      });
      const fail = (error: Error) => {
        clearTimeout(timer); if (!ready) reject(error);
        for (const value of this.pending.values()) { value.cleanup(); value.reject(error); } this.pending.clear();
      };
      child.once('error', error => { fail(error); });
      this.exiting = new Promise<void>(done => child.once('close', (code, signal) => {
        fail(new ComputerError('HOST_DISCONNECTED', `电脑操作宿主已退出（${signal ?? code}）。${diagnostic}`));
        lines.close(); if (this.child === child) { this.child = undefined; this.identity = undefined; this.starting = undefined; }
        this.changed({ active: false, reason: 'host_disconnected', generation: 0 }); done();
      }));
    });
  }
  async request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); await this.start(); signal?.throwIfAborted();
    return this.send<T>(method, params, signal);
  }
  private send<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new ComputerError('HOST_DISCONNECTED', '电脑操作宿主不可用。'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const abort = () => { void this.stop('run_cancelled'); };
      const timer = setTimeout(() => { this.pending.delete(id); cleanup();
        reject(new ComputerError('OPERATION_UNKNOWN', '电脑操作未在期限内返回，已请求停止；请重新观察实际结果，不要重复发送同一次操作。'));
        void this.terminate(child, 'operation_timeout');
      }, ['stop', 'release', 'quit'].includes(method) ? 1500 : 20_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup }); signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error) return; this.pending.delete(id); cleanup(); reject(error);
      });
    });
  }
  async stop(reason: string) {
    if (!this.child) return;
    await this.send('stop', { reason }).catch(() => {});
  }
  private async terminate(child: ChildProcessWithoutNullStreams, reason: string) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // 先让宿主释放按住的键和鼠标；只终止当前实例实际创建的子进程。
    child.stdin.write(JSON.stringify({ method: 'stop', params: { reason } }) + '\n', () => {});
    const exited = this.exiting;
    const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 750);
    try { await exited; } finally { clearTimeout(timeout); }
  }
  async close() {
    this.closing = true;
    const child = this.child; if (!child) return;
    await this.stop('host_closed');
    await this.send('quit', {}).catch(() => {});
    await this.terminate(child, 'host_closed');
    this.listeners.clear();
  }
}
