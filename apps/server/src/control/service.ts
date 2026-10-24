import type { ControlApiSettings, ControlApiStatus } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { ListenerLifecycle } from '../transport/listenerLifecycle';
import { lanAddresses } from '../transport/webOrigin';
import { startControlServer } from './server';
import type { ControlApiHost } from './port';

/** 外部应用控制接口与网页远程入口相互独立：令牌、端口和生命周期都不共用。 */
export class ControlApiService implements ControlApiHost {
  private closed = false;
  private readonly unsubscribe: () => void;
  private readonly listener = new ListenerLifecycle<Awaited<ReturnType<typeof startControlServer>>>({
    plan: async () => {
      const config = this.configured();
      if (!config.enabled) return undefined;
      const token = await this.app.settings.credential(config.credentialRef!);
      if (!token) throw new Error('外部控制令牌不可用，请重新生成并保存。');
      return {
        target: JSON.stringify([config.port, config.allowLan === true]),
        token,
        start: () => startControlServer(this.app, { port: config.port, token, allowLan: config.allowLan === true }),
      };
    },
    changed: () => this.emit(),
  });

  constructor(private readonly app: PlatformApplication) {
    this.unsubscribe = app.subscribe(event => {
      if (event.type === 'settings.changed') this.listener.reapply();
    });
  }

  get keepsAlive() { return this.listener.serving; }

  private configured(): ControlApiSettings {
    return this.app.settings.read('controlApi').controlApi ?? { enabled: false, port: 0 };
  }

  private emit() { if (!this.closed) this.app.publish({ type: 'control.changed' }); }

  status(): ControlApiStatus {
    const config = this.configured();
    const port = this.listener.server?.port;
    const lan = config.allowLan && port !== undefined ? lanAddresses()[0] : undefined;
    return { available: true, state: this.listener.state, enabled: config.enabled, configuredPort: config.port,
      credentialRef: config.credentialRef, ...(port !== undefined ? { port,
        localAddress: `http://127.0.0.1:${port}`, ...(lan ? { lanAddress: `http://${lan}:${port}` } : {}) } : {}),
      error: this.listener.error };
  }

  async accessToken(): Promise<string> {
    const reference = this.configured().credentialRef;
    return reference ? await this.app.settings.credential(reference) ?? '' : '';
  }

  async initialize(): Promise<void> {
    try { await this.listener.initialize(); } catch { /* 状态页会显示启动错误，不阻塞桌面启动。 */ }
  }

  async start(): Promise<ControlApiStatus> {
    if (!this.configured().enabled) throw new Error('请先启用外部控制接口并保存设置。');
    await this.listener.start();
    return this.status();
  }

  stop(): void { this.listener.stop(); }

  async close(): Promise<void> {
    this.closed = true; this.unsubscribe();
    await this.listener.close();
  }
}
