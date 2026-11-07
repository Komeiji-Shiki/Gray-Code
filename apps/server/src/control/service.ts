import type { ControlApiSettings, ControlApiStatus, ControlMcpLaunch } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { ListenerLifecycle } from '../transport/listenerLifecycle';
import { lanAddresses } from '../transport/webOrigin';
import { startControlEndpoint, type ControlEndpoint, type ControlNetworkListener } from './server';
import { ControlDiscoveryFile } from './discovery';
import type { ControlApiHost } from './port';
import packageMetadata from '../../../../package.json';

export interface ControlApiServiceOptions {
  discoveryDirectory: string;
  /** MCP 控制桥脚本，写进发现文件与状态，供 MCP 客户端配置启动命令。 */
  mcpBridge: string;
}

/**
 * 外部应用控制接口与网页远程入口相互独立：令牌、端口和生命周期都不共用。本机管道随应用常开，
 * 网络端口跟随设置启停；只有网络端口会让关闭窗口后的应用留在后台。
 */
export class ControlApiService implements ControlApiHost {
  private closed = false;
  private readonly unsubscribe: () => void;
  private readonly discovery: ControlDiscoveryFile;
  private discoveryQueue: Promise<void> = Promise.resolve();
  private readonly mcp: ControlMcpLaunch;
  private endpoint?: ControlEndpoint;
  private local?: { pipe: string; close(): Promise<void> };
  private localError?: string;
  private readonly listener = new ListenerLifecycle<ControlNetworkListener>({
    plan: async () => {
      const config = this.configured();
      if (!config.enabled) return undefined;
      if (!this.endpoint) throw new Error(this.localError ?? '外部控制接口尚未初始化。');
      const token = await this.app.settings.credential(config.credentialRef!);
      if (!token) throw new Error('外部控制令牌不可用，请重新生成并保存。');
      const endpoint = this.endpoint;
      return {
        target: JSON.stringify([config.port, config.allowLan === true]),
        token,
        start: () => endpoint.network({ port: config.port, token, allowLan: config.allowLan === true }),
      };
    },
    changed: () => { this.emit(); this.syncDiscovery(); },
  });

  constructor(private readonly app: PlatformApplication, options: ControlApiServiceOptions) {
    this.discovery = new ControlDiscoveryFile(options.discoveryDirectory);
    this.mcp = { command: process.execPath, args: [options.mcpBridge], ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}) };
    this.unsubscribe = app.subscribe(event => {
      if (event.type === 'settings.changed') this.listener.reapply();
    });
  }

  get keepsAlive() { return this.listener.serving; }

  private configured(): ControlApiSettings {
    return this.app.settings.read('controlApi').controlApi ?? { enabled: false, port: 0 };
  }

  private emit() { if (!this.closed) this.app.publish({ type: 'control.changed' }); }

  /** 本机管道监听时保留发现文件；写入按状态变化顺序串行，失败不影响接口本身。 */
  private syncDiscovery() {
    const pipe = this.local?.pipe;
    const port = this.listener.state === 'listening' ? this.listener.server?.port : undefined;
    this.discoveryQueue = this.discoveryQueue.then(async () => {
      if (pipe === undefined) { await this.discovery.remove(); return; }
      await this.discovery.write({ pipe, mcp: this.mcp, ...(port !== undefined ? { http: { url: `http://127.0.0.1:${port}` } } : {}),
        version: packageMetadata.version, dataDirectory: this.app.storage.directory });
    }).catch(error => console.warn('[ControlApi] 发现文件更新失败：', error));
  }

  status(): ControlApiStatus {
    const config = this.configured();
    const port = this.listener.server?.port;
    const lan = config.allowLan && port !== undefined ? lanAddresses()[0] : undefined;
    return { state: this.listener.state, enabled: config.enabled, configuredPort: config.port,
      credentialRef: config.credentialRef, ...(port !== undefined ? { port,
        localAddress: `http://127.0.0.1:${port}`, ...(lan ? { lanAddress: `http://${lan}:${port}` } : {}) } : {}),
      error: this.listener.error,
      local: this.local ? { pipe: this.local.pipe, mcp: this.mcp } : { ...(this.localError ? { error: this.localError } : {}) } };
  }

  async accessToken(): Promise<string> {
    const reference = this.configured().credentialRef;
    return reference ? await this.app.settings.credential(reference) ?? '' : '';
  }

  /** 本机管道或网络端口启动失败只记录在状态里，不阻塞桌面启动。 */
  async initialize(): Promise<void> {
    try {
      this.endpoint = await startControlEndpoint(this.app);
      const pipe = await this.discovery.pipe();
      this.local = { pipe, ...await this.endpoint.local(pipe) };
      this.syncDiscovery();
    } catch (error) { this.localError = `本机控制通道启动失败：${(error as Error).message}`; }
    this.emit();
    try { await this.listener.initialize(); } catch { /* 状态页会显示启动错误。 */ }
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
    await this.endpoint?.close();
    this.local = undefined;
    this.syncDiscovery();
    await this.discoveryQueue;
  }
}
