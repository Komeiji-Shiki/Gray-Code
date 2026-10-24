import os from 'node:os';
import type { RemoteAccessSettings, RemoteAccessStatus } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { RemoteAccessHost, RemoteStartupOptions } from './remotePort';
import { startHttpServer } from './http';
import { ListenerLifecycle } from './listenerLifecycle';
import { lanAddresses, normalizeWebOrigin, validateRemoteAccess } from './webOrigin';

/** 只管理已授权的 Web 入口；任务、终端和数据目录仍属于原核心实例。 */
export class RemoteAccessService implements RemoteAccessHost {
  private override?: RemoteStartupOptions;
  private readonly unsubscribe: () => void;
  private readonly listener = new ListenerLifecycle<Awaited<ReturnType<typeof startHttpServer>>>({
    plan: async () => {
      const config = this.configured();
      if (!this.override) validateRemoteAccess(config);
      if (!config.enabled) return undefined;
      const token = this.override?.token ?? await this.app.settings.credential(config.credentialRef!);
      if (!token || token.length < 32) throw new Error('远程访问令牌不可用，请在设置中生成或填写至少 32 个字符的令牌。');
      return {
        target: JSON.stringify([config.port, config.publicOrigin ?? '', config.allowLan === true]),
        token,
        start: () => startHttpServer(this.app, { port: config.port, token, publicOrigin: config.publicOrigin,
          allowLan: config.allowLan === true, clientDirectory: this.options.clientDirectory, onConnectionsChanged: () => this.emit() }),
      };
    },
    changed: () => this.emit(),
  });
  private closed = false;
  constructor(private readonly app: PlatformApplication, private readonly options: { clientDirectory?: string }) {
    this.unsubscribe = app.subscribe(event => {
      if (event.type === 'settings.changed' && !this.override) this.listener.reapply();
    });
  }
  get keepsAlive() { return this.listener.serving; }
  private configured(): RemoteAccessSettings {
    if (this.override) return { enabled: true, port: this.override.port ?? 0, publicOrigin: this.override.publicOrigin,
      allowLan: this.override.allowLan };
    return this.app.settings.read('remoteAccess').remoteAccess ?? { enabled: false, port: 0 };
  }
  status(): RemoteAccessStatus {
    const config = this.configured(); const server = this.listener.server; const port = server?.port;
    const lan = config.allowLan && port !== undefined ? lanAddresses()[0] : undefined;
    return { available: true, source: this.override ? 'command_line' : 'settings', state: this.listener.state, enabled: config.enabled,
      deviceName: os.hostname(), configuredPort: config.port, credentialRef: config.credentialRef, port, error: this.listener.error,
      ...(port !== undefined ? { localAddress: `http://127.0.0.1:${port}`, address: config.publicOrigin || `http://127.0.0.1:${port}`,
        ...(lan ? { lanAddress: `http://${lan}:${port}` } : {}) } : {}),
      connections: server?.connections() ?? [], eventStream: server?.diagnostics() };
  }
  async initialize(override?: RemoteStartupOptions): Promise<void> {
    this.override = override ? { ...override, publicOrigin: normalizeWebOrigin(override.publicOrigin) } : undefined;
    try { await this.listener.initialize(); } catch (error) { if (override) throw error; }
  }
  async accessToken(): Promise<string> {
    const reference = this.configured().credentialRef;
    return this.override?.token ?? (reference ? await this.app.settings.credential(reference) ?? '' : '');
  }
  private emit() { if (!this.closed) this.app.publish({ type: 'remote.changed' }); }
  async start(): Promise<RemoteAccessStatus> {
    if (!this.configured().enabled) throw new Error('请先启用远程入口并保存全部设置。');
    await this.listener.start(); return this.status();
  }
  stop(): void { this.listener.stop(); }
  async revoke(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('请选择要撤销的登录设备。');
    await this.listener.server?.revoke(id); this.emit();
  }
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe(); await this.listener.close();
  }
}
