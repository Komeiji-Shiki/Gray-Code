/**
 * RemoteControlServer.ts
 *
 * 远程控制模块（Electron 主进程，随 BackendHost 懒加载包一起加载）。
 *
 * 功能：
 * - 在局域网内（0.0.0.0）监听用户自定义端口，提供移动端友好 UI 与 REST/SSE API；
 * - 通过 WebviewClientRegistry 以 'remote-control' 客户端身份接入现有 MessageRouter，
 *   移动端发起的 chatStream 与桌面端行为完全一致（流式 chunk 经 SSE 回传）；
 * - 桌面端自身会话的流式输出（main-chat 客户端消息）也会镜像转发给移动端，
 *   手机上可以实时看到电脑上正在生成的回复；
 * - 设置页 remoteControl.enabled=false 或端口变更时，由 BackendHost 调用
 *   syncFromSettings() 启停/重启服务器；关闭时服务器完全不存在（零资源占用）。
 *
 * 安全边界（与项目既有策略一致）：
 * - 默认关闭，必须用户在设置页显式开启（opt-in），仅限局域网使用；
 * - 请求体大小限制（MAX_BODY_BYTES），会话 ID 复用 assertSafeId 约定；
 * - 不提供任何文件系统/命令执行能力，仅透传聊天消息（与桌面端同一管道与校验）。
 */

import * as http from 'http';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { DEFAULT_REMOTE_CONTROL_PORT } from '../../../backend/modules/settings/generalTypes';
import { renderRemoteControlUiHtml } from './remoteControlUi';
import type { RemoteControlStatus } from '../../../webview/types';

/** 远程控制客户端的 WebviewClientId（响应/流块按此路由回移动端） */
export const REMOTE_CONTROL_CLIENT_ID = 'remote-control';

/** 请求体上限（256KB；聊天消息远小于此，防御恶意超大 POST） */
const MAX_BODY_BYTES = 256 * 1024;

/** 单次消息路由等待响应超时（chatStream 的 started 应答一般在毫秒级） */
const ROUTE_TIMEOUT_MS = 20_000;

/** SSE 心跳间隔（代理/移动网络保活） */
const SSE_HEARTBEAT_MS = 25_000;

/** SSE 并发连接上限（防御局域网内恶意客户端挂大量连接耗尽内存） */
const MAX_SSE_CLIENTS = 8;

/** SSE 空闲超时：超过该时间没有任何活动则销毁连接（防御半开连接滞留） */
const SSE_IDLE_TIMEOUT_MS = 90_000;

/** 单条消息长度上限（与前端输入框限制对齐） */
const MAX_MESSAGE_LENGTH = 20_000;

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isSafeConversationId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** 私有网段（IPv4）：10/8、172.16/12、192.168/16、169.254/16（链路本地） */
function isPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    return true;
  }
  return /^(10\.|192\.168\.|169\.254\.)/.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

/** 解析 Host 头中的主机名（兼容 host:port / [::1]:port） */
function hostHeaderHostname(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) {
    return host.slice(1, host.indexOf(']') > 0 ? host.indexOf(']') : undefined).toLowerCase();
  }
  return host.split(':')[0].toLowerCase();
}

interface ConversationMeta {
  title?: string;
  updatedAt?: number;
  messageCount?: number;
  preview?: string;
}

/** 远程控制服务器所需的宿主能力（由 BackendHost 注入，结构化类型避免循环依赖） */
export interface RemoteControlServerHost {
  /** 当前完整设置（含 remoteControl 段） */
  getSettings(): { remoteControl?: { enabled?: boolean; port?: number } | null; activeChannelId?: string | null };
  /** 移动端 UI 语言（桌面端 ui.language） */
  getUiLanguage(): string;
  getAppVersion(): string;
  /** 以指定 clientId 路由消息到 MessageRouter（响应经 clientRegistry 回调回传） */
  route(type: string, data: any, requestId: string, clientId: string): Promise<boolean>;
  conversationManager: {
    listConversations(): Promise<string[]>;
    getMetadata(conversationId: string): Promise<ConversationMeta | null | undefined>;
    getMessages(conversationId: string, workspaceUri?: string | null): Promise<any[]>;
  };
  configManager: {
    listConfigs(): Promise<Array<{ id: string; enabled?: boolean }>>;
  };
}

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 计算局域网访问地址（IPv4 非回环地址；无线/有线网卡都会列出）。
 * 仅用于展示给用户，不参与任何访问控制。
 */
function computeLanUrls(port: number): string[] {
  const urls: string[] = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const entry of interfaces[name] || []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          urls.push(`http://${entry.address}:${port}`);
        }
      }
    }
  } catch {
    // 网络接口枚举失败时返回空列表，设置页只显示端口
  }
  return urls;
}

/** 收集本机全部 IPv4 地址（Host/Origin 校验用：hostname 访问场景放行） */
function collectMachineIps(): Set<string> {
  const ips = new Set<string>();
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const entry of interfaces[name] || []) {
        if (entry.family === 'IPv4') {
          ips.add(entry.address);
        }
      }
    }
  } catch {
    // 枚举失败时空集合：校验退化为仅私有网段/回环放行
  }
  return ips;
}

export class RemoteControlServer {
  private server: http.Server | null = null;
  private listeningPort = 0;
  private settings = { enabled: false, port: DEFAULT_REMOTE_CONTROL_PORT };
  private running = false;
  private error: string | undefined;
  private urls: string[] = [];
  private sseClients = new Set<http.ServerResponse>();
  private sseHeartbeatTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, PendingRequest>();
  private restartPromise: Promise<void> | null = null;
  private activeConversationId: string | null = null;
  /** 启动代次：stop/禁用抢占正在 listen 的 start 时递增，使迟到回调失效 */
  private startGeneration = 0;
  /** 本机 IPv4 地址集合（Host/Origin 校验用；随 start 刷新） */
  private machineIps = new Set<string>();

  constructor(private host: RemoteControlServerHost) {}

  /** 是否正在监听 */
  isRunning(): boolean {
    return this.running;
  }

  /** 当前生效端口 */
  getPort(): number {
    return this.settings.port;
  }

  /** 前端上报桌面端激活会话（App.vue watcher，fire-and-forget） */
  setActiveConversation(conversationId: string | null): void {
    if (conversationId === null) return;
    if (isSafeConversationId(conversationId)) {
      this.activeConversationId = conversationId;
    }
  }

  /** 设置页「重试/重启」按钮 */
  apply(action: { type: 'restart' | 'stop' }): void {
    if (action?.type === 'stop') {
      // 仅停止服务器，不修改已持久化的配置（配置只由 syncFromSettings 跟随设置变化）
      this.rejectAllPending(new Error('Remote control server stopped'));
      void this.stop();
      return;
    }
    // restart：强制按当前配置重建服务器（端口占用被释放后重试等场景）
    void this.restart();
  }

  /** 查询状态（设置页 remoteControl.getStatus 消息） */
  getStatus(): RemoteControlStatus {
    return {
      available: true,
      enabled: this.settings.enabled,
      port: this.settings.port,
      running: this.running,
      error: this.error,
      urls: this.urls,
      activeConversationId: this.activeConversationId
    };
  }

  /**
   * 与设置同步：开启则启动/按端口重启，关闭则停止。
   * 由 BackendHost 在初始化后与每次设置变更（remoteControl/full）时调用。
   */
  syncFromSettings(): void {
    const rc = this.host.getSettings().remoteControl;
    const enabled = rc?.enabled === true;
    const port = isValidPort(rc?.port) ? (rc!.port as number) : DEFAULT_REMOTE_CONTROL_PORT;
    const changed = enabled !== this.settings.enabled || port !== this.settings.port;
    this.settings = { enabled, port };
    if (!enabled) {
      if (changed) this.stop();
      return;
    }
    if (!changed && this.running) return;
    void this.restart();
  }

  /** 客户端注册表回传（响应/错误/流块）；BackendHost 注册 'remote-control' 客户端时挂接 */
  onClientMessage(message: any): boolean {
    this.resolvePending(message);
    const type = message?.type;
    if (type === 'streamChunk' || type === 'streamChunkBatch') {
      this.broadcast('message', message);
    }
    return true;
  }

  /** 桌面端主聊天客户端的原始消息（镜像桌面端的流式输出到移动端） */
  onGlobalMessage(message: any): void {
    if (!this.running) return;
    const type = message?.type;
    if (type === 'streamChunk' || type === 'streamChunkBatch') {
      this.broadcast('global', message);
    }
  }

  /** 应用退出前清理 */
  async dispose(): Promise<void> {
    if (this.restartPromise) {
      try {
        await this.restartPromise;
      } catch {
        // ignore
      }
    }
    await this.stop();
    this.rejectAllPending(new Error('Remote control server disposed'));
  }

  // ==========================================================================
  // 服务器生命周期
  // ==========================================================================

  private async restart(): Promise<void> {
    // 是否需要按当前配置重建服务器：启用中且（未监听 或 监听端口 ≠ 当前配置端口）。
    // 链尾复查用 listeningPort 而非 !running：首轮 start 尚在 listen 阶段时端口又被
    // 修改（连续两次设置保存），首轮可能在旧端口成功，仅查 running 会跳过重建，
    // 导致服务器停在旧端口、设置页显示新端口的不一致。
    const needsRestart = (): boolean => {
      if (!this.settings.enabled) return false;
      return !this.running || this.listeningPort !== this.settings.port;
    };
    if (this.restartPromise) {
      // 串行化重启：并发 syncFromSettings 只执行最后一次配置
      return this.restartPromise.then(() => {
        if (needsRestart()) return this.doRestart();
        return undefined;
      });
    }
    this.restartPromise = this.doRestart().finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  private async doRestart(): Promise<void> {
    await this.stop();
    if (!this.settings.enabled) return;
    await this.start();
  }

  private start(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        resolve();
        return;
      }
      const generation = ++this.startGeneration;
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          const message = err?.message || 'Internal server error';
          const status = message === 'Unsupported content type'
            ? 415
            : message === 'Invalid JSON body'
              ? 400
              : message === 'Request body too large'
                ? 413
                : 500;
          this.sendJson(res, status, { ok: false, error: message });
        });
      });
      // 监听失败（端口占用等）不能弹崩溃窗，只记录状态供设置页展示；
      // 必须 resolve()，否则 restart 链 / dispose 会永久挂起（EADDRINUSE 后
      // 重试按钮、改端口、退出应用全部失效）。
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (generation !== this.startGeneration) {
          resolve();
          return;
        }
        this.error = err?.message || String(err);
        this.running = false;
        this.urls = [];
        if (this.server === server) {
          this.server = null;
        }
        // 清空 SSE 连接，避免残留客户端挂在死端口上
        this.closeSseClients();
        resolve();
      });
      server.listen(this.settings.port, '0.0.0.0', () => {
        // 竞态复查：listen 回调迟到时可能已被 stop/禁用抢占（generation 递增），
        // 此时必须立即关闭，否则「关闭开关后服务器仍在监听」。
        if (generation !== this.startGeneration || !this.settings.enabled) {
          try {
            server.close();
          } catch {
            // ignore
          }
          resolve();
          return;
        }
        this.server = server;
        this.running = true;
        this.error = undefined;
        this.listeningPort = this.settings.port;
        this.urls = computeLanUrls(this.settings.port);
        this.machineIps = collectMachineIps();
        this.startSseHeartbeat();
        resolve();
      });
    });
  }

  private stop(): Promise<void> {
    return new Promise((resolve) => {
      // 递增代次：使正在 listen 的 start 回调失效（关闭开关后不得复活）
      this.startGeneration++;
      this.closeSseClients();
      if (this.sseHeartbeatTimer) {
        clearInterval(this.sseHeartbeatTimer);
        this.sseHeartbeatTimer = null;
      }
      const server = this.server;
      this.server = null;
      this.running = false;
      this.urls = [];
      this.listeningPort = 0;
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      // 兜底：活动连接（SSE 客户端未断开等）可能阻止 close 回调
      setTimeout(() => resolve(), 2000).unref();
    });
  }

  private startSseHeartbeat(): void {
    this.stopSseHeartbeat();
    this.sseHeartbeatTimer = setInterval(() => {
      const payload = ': ping\n\n';
      for (const client of this.sseClients) {
        try {
          // 半开/已销毁连接清扫（写失败或 socket 已关闭的客户端逐出）
          if (client.destroyed || client.writableEnded) {
            this.sseClients.delete(client);
            continue;
          }
          client.write(payload);
        } catch {
          this.sseClients.delete(client);
        }
      }
    }, SSE_HEARTBEAT_MS);
    this.sseHeartbeatTimer.unref?.();
  }

  private stopSseHeartbeat(): void {
    if (this.sseHeartbeatTimer) {
      clearInterval(this.sseHeartbeatTimer);
      this.sseHeartbeatTimer = null;
    }
  }

  private closeSseClients(): void {
    const payload = sseEvent('bye', { reason: 'server-stopped' });
    for (const client of this.sseClients) {
      try {
        client.write(payload);
        client.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
  }

  // ==========================================================================
  // 消息路由（响应经 pending 表回传）
  // ==========================================================================

  private routeMessage(type: string, data: unknown): Promise<any> {
    const requestId = `remote_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request timed out: ${type}`));
      }, ROUTE_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.host.route(type, data, requestId, REMOTE_CONTROL_CLIENT_ID).catch((err) => {
        const entry = this.pending.get(requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(requestId);
        }
        reject(err);
      });
    });
  }

  private resolvePending(message: any): void {
    const requestId = message?.requestId;
    if (!requestId) return;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    if (message.type === 'response') {
      entry.resolve(message.data);
    } else {
      entry.reject(new Error(message?.error?.message || message?.error?.code || 'Remote request failed'));
    }
  }

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  // ==========================================================================
  // HTTP 请求处理
  // ==========================================================================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 反 DNS rebinding / 跨源滥用：
    // - Host 必须是回环、私有网段或本机网卡地址（攻击者域名解析到本机 IP 时 Host 为攻击者域名，被拒）；
    // - 带 Origin 的请求（跨源 fetch）Origin 主机必须与 Host 同源或为本机地址；
    // - 写操作必须携带 application/json（拦截 text/plain 简单请求绕 CORS 预检的 CSRF 式滥用）。
    if (!this.isAllowedHost(req)) {
      this.sendJson(res, 403, { ok: false, error: 'Forbidden host' });
      return;
    }
    if (!this.isAllowedOrigin(req)) {
      this.sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/') {
      this.sendHtml(res, renderRemoteControlUiHtml(this.host.getUiLanguage()));
      return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && pathname === '/api/stream') {
      this.handleSse(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      this.sendJson(res, 200, await this.buildStatusPayload());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/conversations') {
      await this.handleListConversations(res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/messages') {
      const conversationId = url.searchParams.get('conversationId') || '';
      if (!isSafeConversationId(conversationId)) {
        this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId' });
        return;
      }
      try {
        // 只允许读取已存在的会话：ConversationManager.getMessages 对未知名会
        // 自动创建会话落盘，HTTP 面放开会变成「穷举合法 ID → 无限建目录」的
        // 磁盘 DoS（局域网内无鉴权场景下）。
        const meta = await this.host.conversationManager.getMetadata(conversationId);
        if (!meta) {
          this.sendJson(res, 404, { ok: false, error: 'Conversation not found' });
          return;
        }
        const messages = await this.host.conversationManager.getMessages(conversationId, null);
        this.sendJson(res, 200, { ok: true, messages });
      } catch (err: any) {
        this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to load messages' });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/send') {
      await this.handleSend(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/cancel') {
      await this.handleCancel(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/rename') {
      await this.handleRename(res, await this.readBody(req));
      return;
    }

    this.sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  /** Host 头校验：回环 / 私有网段 / 本机网卡地址 */
  private isAllowedHost(req: http.IncomingMessage): boolean {
    const hostname = hostHeaderHostname(req.headers.host);
    if (!hostname) return false;
    return isPrivateHostname(hostname) || this.machineIps.has(hostname);
  }

  /** Origin 校验：无 Origin（导航/curl/SSE）放行；有 Origin 必须与 Host 同源或为本机地址 */
  private isAllowedOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      const hostname = parsed.hostname.toLowerCase();
      if (isPrivateHostname(hostname) || this.machineIps.has(hostname)) return true;
      // 同源：Origin 主机 == 请求 Host 主机
      const reqHost = hostHeaderHostname(req.headers.host);
      return !!reqHost && hostname === reqHost;
    } catch {
      return false;
    }
  }

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      // 写操作只接受 application/json：拦截 text/plain 等「简单请求」绕过 CORS
      // 预检的跨站写滥用（fetch 带 text/plain 仍会携带 body）。
      const contentType = req.headers['content-type'] || '';
      if (contentType && !contentType.toLowerCase().includes('application/json')) {
        // 不销毁连接：让 handler 正常回 4xx（销毁会导致客户端收到连接重置而非错误响应）
        reject(new Error('Unsupported content type'));
        return;
      }
      let size = 0;
      let overLimit = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        if (overLimit) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // 超限后丢弃后续数据（客户端通常已发完，无需主动断连）
          overLimit = true;
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (overLimit) return;
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  private async buildStatusPayload(): Promise<Record<string, unknown>> {
    let activeConversationTitle: string | null = null;
    if (this.activeConversationId) {
      try {
        const meta = await this.host.conversationManager.getMetadata(this.activeConversationId);
        activeConversationTitle = meta?.title || null;
      } catch {
        // 元数据读取失败不阻断状态返回
      }
    }
    return {
      ok: true,
      appVersion: this.host.getAppVersion(),
      lang: this.host.getUiLanguage(),
      enabled: this.settings.enabled,
      port: this.settings.port,
      running: this.running,
      error: this.error,
      urls: this.urls,
      activeConversationId: this.activeConversationId,
      activeConversationTitle
    };
  }

  private async handleListConversations(res: http.ServerResponse): Promise<void> {
    try {
      const ids = await this.host.conversationManager.listConversations();
      const metas = await Promise.all(
        ids.map((id) => this.host.conversationManager.getMetadata(id).catch(() => null))
      );
      const conversations = ids
        .map((id, i) => ({
          id,
          title: metas[i]?.title || '',
          updatedAt: metas[i]?.updatedAt || 0,
          messageCount: metas[i]?.messageCount || 0,
          preview: metas[i]?.preview || ''
        }))
        .filter((c) => c.messageCount > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      this.sendJson(res, 200, { ok: true, conversations });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to list conversations' });
    }
  }

  private async resolveConfigId(): Promise<string | undefined> {
    try {
      const settings = this.host.getSettings();
      if (settings.activeChannelId) return settings.activeChannelId;
      const configs = await this.host.configManager.listConfigs();
      const enabled = configs.filter((c) => c.enabled !== false);
      if (enabled.length === 0) return undefined;
      return enabled[0].id;
    } catch {
      return undefined;
    }
  }

  private async handleSend(res: http.ServerResponse, body: any): Promise<void> {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      this.sendJson(res, 400, { ok: false, error: 'Message text is required' });
      return;
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      this.sendJson(res, 400, { ok: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` });
      return;
    }
    const requestedId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    let targetId: string;
    if (requestedId) {
      if (!isSafeConversationId(requestedId)) {
        this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId' });
        return;
      }
      targetId = requestedId;
    } else {
      // 未指定会话：自动创建新会话（标题取首行前 30 字符，与桌面端一致）
      targetId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const title = text.split('\n')[0].slice(0, 30) || 'New Chat';
      try {
        await this.routeMessage('conversation.createConversation', {
          conversationId: targetId,
          title
        });
      } catch (err: any) {
        this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to create conversation' });
        return;
      }
    }

    const configId = await this.resolveConfigId();
    if (!configId) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'No channel enabled. Configure a channel with a valid API key in settings first.'
      });
      return;
    }

    this.activeConversationId = targetId;
    try {
      await this.routeMessage('chatStream', {
        conversationId: targetId,
        configId,
        message: text,
        messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        streamId: `remote_${randomUUID()}`
      });
      this.sendJson(res, 200, { ok: true, started: true, conversationId: targetId });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to start stream' });
    }
  }

  private async handleCancel(res: http.ServerResponse, body: any): Promise<void> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    if (!isSafeConversationId(conversationId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId' });
      return;
    }
    try {
      await this.routeMessage('cancelStream', { conversationId });
      this.sendJson(res, 200, { ok: true, cancelled: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to cancel stream' });
    }
  }

  private async handleRename(res: http.ServerResponse, body: any): Promise<void> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 100) : '';
    if (!isSafeConversationId(conversationId) || !title) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId or title' });
      return;
    }
    try {
      await this.routeMessage('conversation.setTitle', { conversationId, title });
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to rename conversation' });
    }
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      this.sendJson(res, 503, { ok: false, error: 'Too many stream connections' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    });
    res.write('retry: 2000\n\n');
    void this.buildStatusPayload().then((status) => {
      try {
        res.write(sseEvent('hello', status));
      } catch {
        // 客户端在 hello 前断开：连接已由 close 事件清理
      }
    });
    this.sseClients.add(res);
    // 空闲超时：半开连接（手机锁屏/网络切换未触发 close）滞留防护
    const socket = res.socket;
    if (socket) {
      socket.setTimeout(SSE_IDLE_TIMEOUT_MS, () => {
        this.sseClients.delete(res);
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
      socket.on('close', () => this.sseClients.delete(res));
    }
    req.on('close', () => {
      this.sseClients.delete(res);
    });
    req.on('error', () => {
      this.sseClients.delete(res);
    });
  }

  private broadcast(kind: 'message' | 'global', message: unknown): void {
    if (this.sseClients.size === 0) return;
    const payload = sseEvent(kind, message);
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(payload);
  }

  private sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
  }
}
