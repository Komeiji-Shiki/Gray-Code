import { createHash } from 'node:crypto';
import type { ControlApiSettings, ControlApiStatus } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { lanAddresses } from '../transport/webOrigin';
import { startControlServer } from './server';
import type { ControlApiHost } from './port';

/** 外部应用控制接口与网页远程入口相互独立：令牌、端口和生命周期都不共用。 */
export class ControlApiService implements ControlApiHost {
  private server?: Awaited<ReturnType<typeof startControlServer>>;
  private initialized = false;
  private closed = false;
  private paused = false;
  private state: ControlApiStatus['state'] = 'disabled';
  private error?: string;
  private key = '';
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(private readonly app: PlatformApplication) {
    this.unsubscribe = app.subscribe(event => {
      if (event.type === 'settings.changed' && this.initialized && !this.closed)
        void this.enqueue(() => this.apply()).catch(() => {});
    });
  }

  get keepsAlive() { return this.initialized && !this.closed && !this.paused && this.configured().enabled; }

  private configured(): ControlApiSettings {
    return this.app.settings.read('controlApi').controlApi ?? { enabled: false, port: 0 };
  }

  status(): ControlApiStatus {
    const config = this.configured();
    const port = this.server?.port;
    const lan = config.allowLan && port !== undefined ? lanAddresses()[0] : undefined;
    return { available: true, state: this.state, enabled: config.enabled, configuredPort: config.port,
      credentialRef: config.credentialRef, ...(port !== undefined ? { port,
        localAddress: `http://127.0.0.1:${port}`, ...(lan ? { lanAddress: `http://${lan}:${port}` } : {}) } : {}),
      error: this.error };
  }

  async accessToken(): Promise<string> {
    const reference = this.configured().credentialRef;
    return reference ? await this.app.settings.credential(reference) ?? '' : '';
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.catch(() => {}).then(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return operation();
    });
    this.queue = current;
    return current;
  }

  private emit() { if (!this.closed) this.app.publish({ type: 'control.changed' }); }

  private async disconnect() {
    const server = this.server;
    if (!server) return;
    this.state = 'stopping'; this.emit();
    await server.close();
    this.server = undefined;
  }

  private async apply(): Promise<void> {
    if (this.closed || !this.initialized) return;
    let disconnected = false;
    try {
      const config = this.configured();
      if (!config.enabled) {
        disconnected = true; await this.disconnect();
        this.state = 'disabled'; this.error = undefined; this.paused = false; this.key = ''; this.emit(); return;
      }
      if (!config.credentialRef) throw new Error('请先生成外部控制接口的访问令牌。');
      const token = await this.app.settings.credential(config.credentialRef);
      if (!token || token.length < 32) throw new Error('外部控制令牌不可用，请生成至少 32 个字符的令牌。');
      const key = JSON.stringify([config.port, config.allowLan === true, createHash('sha256').update(token).digest('hex')]);
      if (this.key !== key) this.paused = false;
      this.key = key;
      if (this.paused) return;
      if (this.server && this.state === 'listening') { this.error = undefined; this.emit(); return; }
      disconnected = true; await this.disconnect();
      this.state = 'starting'; this.error = undefined; this.emit();
      const server = await startControlServer(this.app, { port: config.port, token, allowLan: config.allowLan === true });
      if (this.closed) { await server.close(); return; }
      this.server = server; this.state = 'listening'; this.key = key; this.emit();
    } catch (error) {
      try { if (!disconnected) await this.disconnect(); }
      finally {
        this.state = 'error'; this.error = error instanceof Error ? error.message : String(error); this.emit();
      }
      throw error;
    }
  }

  async initialize(): Promise<void> {
    this.initialized = true;
    try { await this.enqueue(() => this.apply()); } catch { /* 状态页会显示启动错误，不阻塞桌面启动。 */ }
  }

  async start(): Promise<ControlApiStatus> {
    if (!this.configured().enabled) throw new Error('请先启用外部控制接口并保存设置。');
    this.paused = false; await this.enqueue(() => this.apply()); return this.status();
  }

  stop(): void {
    this.paused = true; this.state = this.server ? 'stopping' : 'stopped'; this.emit();
    void this.enqueue(async () => { await this.disconnect(); this.state = 'stopped'; this.error = undefined; this.emit(); })
      .catch(error => { this.state = 'error'; this.error = (error as Error).message; this.emit(); });
  }

  async close(): Promise<void> {
    this.closed = true; this.unsubscribe();
    await this.queue.catch(() => {});
    await this.disconnect();
    this.state = 'stopped';
  }
}
