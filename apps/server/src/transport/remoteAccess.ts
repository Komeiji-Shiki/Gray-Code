import { createHash } from 'node:crypto';
import os from 'node:os';
import type { RemoteAccessSettings, RemoteAccessStatus } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { RemoteAccessHost, RemoteStartupOptions } from './remotePort';
import { startHttpServer } from './http';
import { normalizeWebOrigin, validateRemoteAccess } from './webOrigin';

/** 只管理已授权的 Web 入口；任务、终端和数据目录仍属于原核心实例。 */
export class RemoteAccessService implements RemoteAccessHost {
  private server?: Awaited<ReturnType<typeof startHttpServer>>;
  private override?: RemoteStartupOptions;
  private initialized = false;
  private closed = false;
  private paused = false;
  private state: RemoteAccessStatus['state'] = 'disabled';
  private error?: string;
  private target = '';
  private tokenHash = '';
  private desiredKey = '';
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;
  constructor(private readonly app: PlatformApplication, private readonly options: { clientDirectory?: string }) {
    this.unsubscribe = app.subscribe(event => {
      if (event.type === 'settings.changed' && this.initialized && !this.override && !this.closed)
        void this.enqueue(() => this.apply()).catch(() => {});
    });
  }
  get keepsAlive() { return this.initialized && !this.closed && !this.paused && this.configured().enabled; }
  private configured(): RemoteAccessSettings {
    if (this.override) return { enabled: true, port: this.override.port ?? 0, publicOrigin: this.override.publicOrigin };
    return this.app.settings.snapshot().settings.remoteAccess ?? { enabled: false, port: 0 };
  }
  status(): RemoteAccessStatus {
    const config = this.configured(); const port = this.server?.port;
    return { available: true, source: this.override ? 'command_line' : 'settings', state: this.state, enabled: config.enabled,
      deviceName: os.hostname(), configuredPort: config.port, credentialRef: config.credentialRef, port, error: this.error,
      ...(port !== undefined ? { localAddress: `http://127.0.0.1:${port}`, address: config.publicOrigin || `http://127.0.0.1:${port}` } : {}),
      connections: this.server?.connections() ?? [] };
  }
  async initialize(override?: RemoteStartupOptions): Promise<void> {
    this.override = override ? { ...override, publicOrigin: normalizeWebOrigin(override.publicOrigin) } : undefined;
    this.initialized = true;
    try { await this.enqueue(() => this.apply()); } catch (error) { if (override) throw error; }
  }
  async accessToken(): Promise<string> {
    const reference = this.configured().credentialRef;
    return this.override?.token ?? (reference ? await this.app.settings.credential(reference) ?? '' : '');
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.catch(() => {}).then(async () => {
      // 设置保存先完成当前请求的处理，再开始变更监听状态。
      await new Promise<void>(resolve => setImmediate(resolve)); return operation();
    });
    this.queue = current; return current;
  }
  private emit() { if (!this.closed) this.app.publish({ type: 'remote.changed' }); }
  private async disconnect() {
    const server = this.server; this.server = undefined;
    if (server) { this.state = 'stopping'; this.emit(); await server.close(); }
  }
  private async apply(): Promise<void> {
    if (this.closed || !this.initialized) return;
    try {
      const config = this.configured();
      if (!this.override) validateRemoteAccess(config);
      if (!config.enabled) { await this.disconnect(); this.state = 'disabled'; this.error = undefined; this.paused = false; this.desiredKey = ''; this.emit(); return; }
      const token = this.override?.token ?? await this.app.settings.credential(config.credentialRef!);
      if (!token || token.length < 32) throw new Error('远程访问令牌不可用，请在设置中生成或填写至少 32 个字符的令牌。');
      const target = JSON.stringify([config.port, config.publicOrigin ?? '']);
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const key = target + tokenHash;
      if (this.desiredKey !== key) this.paused = false;
      this.desiredKey = key;
      if (this.paused) return;
      if (this.server && target === this.target) {
        if (tokenHash !== this.tokenHash) await this.server.rotateToken(token);
        this.tokenHash = tokenHash; this.error = undefined; this.state = 'listening'; this.emit(); return;
      }
      await this.disconnect(); this.state = 'starting'; this.error = undefined; this.emit();
      const server = await startHttpServer(this.app, { port: config.port, token, publicOrigin: config.publicOrigin,
        clientDirectory: this.options.clientDirectory, onConnectionsChanged: () => this.emit() });
      if (this.closed) { await server.close(); return; }
      this.server = server; this.target = target; this.tokenHash = tokenHash; this.state = 'listening'; this.emit();
    } catch (error) {
      await this.disconnect(); this.state = 'error'; this.error = error instanceof Error ? error.message : String(error); this.emit(); throw error;
    }
  }
  async start(): Promise<RemoteAccessStatus> {
    if (!this.configured().enabled) throw new Error('请先启用远程入口并保存全部设置。');
    this.paused = false; await this.enqueue(() => this.apply()); return this.status();
  }
  stop(): void {
    this.paused = true; this.state = this.server ? 'stopping' : 'stopped'; this.emit();
    void this.enqueue(async () => { await this.disconnect(); this.state = 'stopped'; this.error = undefined; this.emit(); }).catch(error => {
      this.state = 'error'; this.error = (error as Error).message; this.emit();
    });
  }
  async revoke(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('请选择要撤销的登录设备。');
    await this.server?.revoke(id); this.emit();
  }
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe(); await this.queue.catch(() => {}); await this.disconnect(); this.state = 'stopped';
  }
}
