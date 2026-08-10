/**
 * RemoteControlServer.ts
 *
 * 远程控制模块（Electron 主进程，随 BackendHost 懒加载包一起加载）。
 *
 * 架构（V2 去虚拟化直连）：
 * - 在局域网内（0.0.0.0）监听用户自定义端口，提供移动端友好 UI 与 REST/SSE API；
 * - 不再把远控端注册为 WebviewClientRegistry 的虚拟 webview 客户端、也不经
 *   MessageRouter 路由（此前所有操作都要「HTTP → routeMessage → MessageRouter →
 *   handler → clientRegistry 回传 → pending 表」绕一整圈，落盘与响应都多一层
 *   序列化往返，延迟更高、链路更难维护）；
 * - 现在所有操作由 BackendHost 提供的 `invoke()` 进程内直连：直接调用 webview
 *   handler 函数本身（sendResponse/sendError 直接 resolve/reject Promise），
 *   校验与业务逻辑与桌面端完全一致，但零虚拟客户端开销；
 * - 流式任务（chatStream/retryStream/toolConfirmation/cancelStream）由 BackendHost
 *   为远控端单独装配的 StreamRequestHandler 直连执行（共享全局 StreamAbortManager，
 *   移动端停止按钮与桌面端取消共用同一取消控制器），chunk 经 getClientView
 *   直投 SSE，同样不经过 MessageRouter；
 * - 桌面端自身会话的流式输出（main-chat 客户端消息）仍镜像转发给移动端，
 *   手机上可以实时看到电脑上正在生成的回复；
 * - 会话变更（创建/改名/删除/摘要更新）后调用 host.notifyConversationsChanged()
 *   推送桌面端与移动端实时刷新会话列表（不再需要重启才能看到新对话）；
 * - 移动端可操作真实工作区：浏览目录、读写文本文件、在桌面端打开文件（带行号）、
 *   切换工作区（文件操作全部经 webview FileHandlers 的既有工作区包含校验）；
 * - 移动端可参与工具审批流（toolConfirmation）、重试（retryStream）、删除消息、
 *   切换渠道模型（models.setActiveModel）、编辑用户消息重新生成（editBranchStream）、
 *   重新生成助手消息（rerollStream）、删除会话（conversation.deleteConversation）、
 *   新增/移除工作区（workspace.openFolder / workspace.removeSaved）；
 * - 渠道全量管理：新增（config.createConfig）/ 编辑（config.updateConfig）/
 *   删除（config.deleteConfig）/ 模型获取与增删（models.getModels/addModels/
 *   removeModel），设置页渠道管理与桌面端一致；
 * - 工作区新增支持移动端自选目录：GET /api/fs 浏览服务端任意目录（仅目录项，
 *   不读文件内容），POST /api/workspace-add 携带 fsPath 直接打开（不再依赖
 *   桌面端弹窗）；切换工作区对「已打开」走 workspace.setActive 固定、
 *   对「仅收藏」走 workspace.openFolder 由宿主打开，两种场景均可生效；
 * - 设置页全量补齐：GET/POST /api/settings 直连桌面端 settingsHandler
 *   （深合并语义与桌面端一致），密钥字段（apiKey / base64 音频资产 /
 *   代理 URL 内嵌凭据）在响应侧脱敏，移动端可读写桌面端全部设置项；
 * - 桌面端活动编辑器/工作区变化经 SSE workspace 事件实时镜像到手机；
 * - 设置页 remoteControl.enabled=false 或端口变更时，由 BackendHost 调用
 *   syncFromSettings() 启停/重启服务器；关闭时服务器完全不存在（零资源占用）。
 *
 * 安全边界（与项目既有策略一致）：
 * - 默认关闭，必须用户在设置页显式开启（opt-in），仅限局域网使用；
 * - 请求体大小限制（MAX_BODY_BYTES），会话 ID 复用 assertSafeId 约定；
 * - 文件/路径操作只透传 webview FileHandlers 既有校验（工作区包含、大小上限、
 *   文本嗅探），服务器侧再叠加长度/形状白名单，不做任何绕过；
 * - 无鉴权：仅靠 Host/Origin 校验 + JSON-only 写操作约束（详见 handleRequest）。
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { DEFAULT_REMOTE_CONTROL_PORT } from '../settings/generalTypes';
import { renderRemoteControlUiHtml } from './remoteControlUi';
import type { RemoteControlStatus } from '../../../webview/types';

/** 远程控制客户端的 WebviewClientId（BackendHost 装配远程流时使用；V2 不再注册虚拟客户端） */
export const REMOTE_CONTROL_CLIENT_ID = 'remote-control';

/** 请求体上限（256KB；聊天消息远小于此，防御恶意超大 POST） */
const MAX_BODY_BYTES = 256 * 1024;

/** SSE 心跳间隔（代理/移动网络保活） */
const SSE_HEARTBEAT_MS = 25_000;

/** SSE 并发连接上限（防御局域网内恶意客户端挂大量连接耗尽内存） */
const MAX_SSE_CLIENTS = 8;

/** SSE 空闲超时：超过该时间没有任何活动则销毁连接（防御半开连接滞留） */
const SSE_IDLE_TIMEOUT_MS = 90_000;

/** 单条消息长度上限（与前端输入框限制对齐） */
const MAX_MESSAGE_LENGTH = 20_000;

/** 工作区相对路径长度上限（配合 FileHandlers 工作区包含校验的前置白名单） */
const MAX_PATH_LENGTH = 1024;

/** 手机端写入文本文件的内容大小上限（1MB；桌面端 10MB 读取上限对手机编辑过重） */
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;

/** 单次工具确认最多携带的工具响应数（防御异常批量确认） */
const MAX_TOOL_RESPONSES = 20;

/** 目录浏览单次返回条目上限（防御巨型目录拖垮移动端渲染） */
const MAX_FS_LISTING_ENTRIES = 500;

/** 目录浏览路径长度上限（配合绝对路径白名单的前置拦截） */
const MAX_FS_PATH_LENGTH = 2048;

/** 会话列表分页（移动端抽屉惰性加载，对齐桌面端 CONVERSATIONS_PAGE_SIZE=30） */
const CONVERSATIONS_PAGE_SIZE = 30;

/** 会话列表分页上限（防御一次请求拉取过多 meta 拖垮消息队列） */
const CONVERSATIONS_PAGE_MAX = 100;

/** 消息历史分页（移动端滚动向上回溯加载，对齐桌面端 MESSAGES_PAGE_SIZE=120） */
const MESSAGES_PAGE_SIZE = 120;

/** 消息历史分页上限（单次窗口上限，防止超大窗口经局域网全量下发） */
const MESSAGES_PAGE_MAX = 500;

/** 会话摘要预览长度（与桌面端 updateConversationAfterMessage 的 slice(0,50) 一致） */
const SUMMARY_PREVIEW_LENGTH = 50;

/** 移动端设置补丁体大小上限（64KB；全量设置中仅密钥字段被脱敏后可达数十 KB） */
const MAX_SETTINGS_PATCH_BYTES = 64 * 1024;

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** 解析并钳制整数查询参数：非法/缺失/小于 min 回退默认值，超上限收敛到 max */
function clampInt(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || !isFinite(n)) return fallback;
  if (n < min) return fallback;
  return Math.min(max, n);
}

function isSafeConversationId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** 渠道 ID 白名单（configId 可含点，如 gemini-pro） */
function isSafeConfigId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id);
}

/** 模型 ID 形状白名单：ModelInfo.id 为自由字符串（可含 / @ 等），仅限长度与控制字符 */
function isSafeModelId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id);
}

/** 消息/分支节点 ID 白名单（editBranchStream 的 userNodeId/messageId、rerollStream 的 assistantNodeId） */
function isSafeNodeId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id);
}

/** 收藏工作区 fsPath 形状白名单（workspace.removeSaved 用）：本地绝对路径文本，禁控制字符 */
function isSafeFsPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > 4096) return false;
  return !/[\u0000-\u001f\u007f]/.test(path);
}

/**
 * 绝对本地路径白名单（GET /api/fs 目录浏览、POST /api/workspace-add 的 fsPath 用）：
 * 必须为绝对路径（Windows 盘符或 POSIX / 根），长度受限、禁控制字符、禁 `..` 段。
 * 目录浏览只下发目录项元数据（名称/路径），不读取任何文件内容。
 */
function isSafeAbsolutePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > MAX_FS_PATH_LENGTH) return false;
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(p);
  if (!isWinAbs && !p.startsWith('/')) return false;
  for (const seg of p.split(/[\\/]/)) {
    if (seg === '..' || /^\.+$/.test(seg)) return false;
  }
  return true;
}

/** 移动端设置响应脱敏：深拷贝后抹除密钥字段，仅影响下行数据，不回写桌面端 */
function sanitizeSettingsForRemote(settings: unknown): unknown {
  try {
    const s: any = JSON.parse(JSON.stringify(settings));
    // 图像生成 / Token 计数渠道的 apiKey：抹为占位串（UI 以此识别「已设置，留空保持不变」）
    const maskKey = (obj: any): void => {
      if (obj && typeof obj === 'object' && typeof obj.apiKey === 'string') {
        obj.apiKey = obj.apiKey ? '********' : '';
      }
    };
    maskKey(s?.toolsConfig?.generate_image);
    const tokenCount = s?.toolsConfig?.token_count;
    if (tokenCount && typeof tokenCount === 'object') {
      for (const key of Object.keys(tokenCount)) maskKey(tokenCount[key]);
    }
    // 界面音效资产（base64，可达数百 KB）：移动端不需要原始载荷，直接删除
    const assets = s?.ui?.sound?.assets;
    if (assets && typeof assets === 'object') {
      for (const key of Object.keys(assets)) {
        if (assets[key] && typeof assets[key] === 'object') delete assets[key].dataBase64;
      }
    }
    // 代理 URL 内嵌凭据（http://user:pass@host）：抹掉 userinfo，仅保留协议与主机
    if (typeof s?.proxy?.url === 'string') {
      s.proxy.url = s.proxy.url.replace(/^(\w+:\/\/)[^@/]+@/, '$1***@');
    }
    return s;
  } catch {
    return settings;
  }
}

/** 工作区相对路径：非空字符串、长度受限、不含控制字符、不以绝对路径开头、无 `..` / 尾点段 */
function isSafeWorkspacePath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return false;
  for (const seg of path.split(/[\\/]/)) {
    // 路径穿越前置拦截：`..` 段（含 `....` 等变体）与 Windows 尾点/尾空格
    // 规范化陷阱（`..` 段 / 尾点段在 Win32 上可解析为父目录）一律拒绝，
    // 与 FileHandlers 的 isUriInsideWorkspace 形成双重护栏
    if (seg === '..' || /^\.+$/.test(seg) || /[. ]$/.test(seg)) return false;
  }
  return true;
}

/** 目录列举路径：与 isSafeWorkspacePath 相同，但允许空字符串（空 = 工作区根目录，
 * 与 webview FileHandlers.listWorkspaceDirectory 的根目录语义一致） */
function isSafeWorkspaceDirPath(path: unknown): path is string {
  if (path === '') return true;
  return isSafeWorkspacePath(path);
}

/** 工具确认响应白名单：{id, name, confirmed} 各字段形状受限 */
function isSafeToolResponse(value: unknown): value is { id: string; name: string; confirmed: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 128
    && typeof v.name === 'string' && v.name.length <= 128
    && typeof v.confirmed === 'boolean';
}

/**
 * 剥离消息中的附件二进制载荷（inlineData/fileData base64），保留其余全部字段。
 * 移动端历史加载只关心文本/思考/工具调用，数十 MB 级 base64 不应经局域网下发；
 * 深拷贝仅发生在含附件字段的消息上（普通消息浅引用原数组，零额外开销）。
 */
function stripMessagePayloads(messages: any[]): any[] {
  const hasBlob = (parts: any[] | undefined): boolean =>
    !!parts && parts.some((p) => !!p?.inlineData || !!p?.fileData);
  return messages.map((m) => {
    if (!Array.isArray(m?.parts) || !hasBlob(m.parts)) return m;
    return {
      ...m,
      parts: m.parts.map((p: any) => {
        if (!p || (!p.inlineData && !p.fileData)) return p;
        const copy = { ...p };
        delete copy.inlineData;
        delete copy.fileData;
        return copy;
      })
    };
  });
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

/** 会话列表直读元数据（移动端列表/分页/状态/摘要同步用） */
export interface ConversationMeta {
  title?: string;
  updatedAt?: number;
  messageCount?: number;
  preview?: string;
  custom?: Record<string, unknown>;
}

/** 远程控制服务器所需的宿主能力（由 BackendHost 注入，结构化类型避免循环依赖） */
export interface RemoteControlServerHost {
  /** 当前完整设置（含 remoteControl 段） */
  getSettings(): { remoteControl?: { enabled?: boolean; port?: number } | null; activeChannelId?: string | null };
  /** 移动端 UI 语言（桌面端 ui.language） */
  getUiLanguage(): string;
  getAppVersion(): string;
  /** 当前激活工作区与活动编辑器（桌面端实时快照，SSE workspace 事件与 hello 用） */
  getWorkspaceSnapshot(): { workspaceUri: string | null; activeFilePath: string | null };
  /** 直连调用后端处理器（进程内直接执行 webview handler，无 MessageRouter/虚拟客户端往返） */
  invokeHandler(type: string, data: unknown): Promise<any>;
  /** 直连启动流式任务（chatStream/retryStream/toolConfirmation/cancelStream），
   *  返回 started 应答；chunk 经 streamSink 回调实时回传 */
  runStream(type: string, data: unknown): Promise<{ started?: boolean; cancelled?: boolean }>;
  /** 会话列表/元数据直读（列表/分页/状态/摘要同步用） */
  conversationManager: {
    listConversations(): Promise<string[]>;
    getMetadata(conversationId: string): Promise<ConversationMeta | null | undefined>;
    getMessages(conversationId: string, workspaceUri?: string | null): Promise<any[]>;
  };
  configManager: {
    listConfigs(): Promise<Array<{ id: string; enabled?: boolean }>>;
  };
  /** 会话变更（创建/改名/删除/摘要更新）通知：桌面端与移动端会话列表实时刷新 */
  notifyConversationsChanged(): void;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 虚拟网卡名模式：Hyper-V/WSL/Docker/VMware/VirtualBox 等内部 bridge 的地址
 *  局域网内不可达（如 vEthernet 的 172.x），不应作为访问地址展示给用户 */
const VIRTUAL_ADAPTER_RE = /vEthernet|docker|wsl|hyper|vmnet|vmware|vbox|virtual/i;

/**
 * 计算局域网访问地址（IPv4 非回环地址；无线/有线网卡都会列出）。
 * 过滤虚拟网卡（Hyper-V 默认交换机、WSL、Docker 等内部 bridge）：这些地址
 * 只对本机虚拟网络生效，手机等局域网设备无法访问，展示出来没有意义。
 * 仅用于展示给用户，不参与任何访问控制。
 */
function computeLanUrls(port: number): string[] {
  const urls: string[] = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      if (VIRTUAL_ADAPTER_RE.test(name)) continue;
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

  /** 前端上报桌面端激活会话（App.vue watcher，fire-and-forget）；null 清空跟踪 */
  setActiveConversation(conversationId: string | null): void {
    if (conversationId === null) {
      this.activeConversationId = null;
      return;
    }
    if (isSafeConversationId(conversationId)) {
      this.activeConversationId = conversationId;
    }
  }

  /** 桌面端活动编辑器/工作区变化（BackendHost 的 vscode 监听器调用）→ SSE workspace 事件 */
  notifyWorkspaceChange(): void {
    if (!this.running) return;
    try {
      this.broadcast('workspace', this.buildWorkspacePayload());
    } catch {
      // 快照构建失败静默：下次变化再推
    }
  }

  private buildWorkspacePayload(): Record<string, unknown> {
    const snap = this.host.getWorkspaceSnapshot?.() || { workspaceUri: null, activeFilePath: null };
    const workspaceUri = snap.workspaceUri || null;
    let workspaceName: string | null = null;
    if (workspaceUri) {
      try {
        workspaceName = decodeURIComponent(workspaceUri.split('?')[0].split('/').filter(Boolean).pop() || '') || null;
      } catch {
        workspaceName = null;
      }
    }
    return {
      workspaceUri,
      workspaceName,
      activeFilePath: snap.activeFilePath || null
    };
  }

  /** 设置页「重试/重启」按钮 */
  apply(action: { type: 'restart' | 'stop' }): void {
    if (action?.type === 'stop') {
      // 仅停止服务器，不修改已持久化的配置（配置只由 syncFromSettings 跟随设置变化）
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

  /** 流式任务 sink：BackendHost 装配的远程流（chatStream 等）的 chunk 经此回调回传。
   *  （桌面端 StreamChunkProcessor 投递 shape：streamChunk 单元素 / streamChunkBatch 数组，
   *   conversationId/streamId 位于每个 chunk 元素上。） */
  onClientMessage(message: any): boolean {
    const type = message?.type;
    if (type === 'streamChunk' || type === 'streamChunkBatch') {
      this.broadcast('message', message);
      // 流终结（complete/cancelled/error）后同步会话摘要元数据（messageCount/preview）：
      // 桌面端由前端在流式完成后调用 conversation.updateSummary，移动端没有该前端逻辑，
      // 若不补写，远端创建的会话在列表里 messageCount 恒为 0 / 预览为空（meta.custom 缺字段）。
      const conversationId = this.extractStreamConversationId(message);
      if (conversationId && isSafeConversationId(conversationId) && this.hasTerminalChunk(message)) {
        this.syncConversationSummary(conversationId);
      }
    }
    return true;
  }

  /**
   * 会话变更通知：推送给移动端 SSE（conversations 事件，移动端列表实时刷新），
   * 并告知 BackendHost 让桌面端最近对话列表实时刷新（不再需要重启才能看到新对话）。
   */
  notifyConversationsChanged(): void {
    if (!this.running) return;
    try {
      this.broadcast('conversations', { changed: true });
      this.host.notifyConversationsChanged();
    } catch {
      // 通知失败静默：仅影响列表实时性，不阻断会话操作
    }
  }

  /**
   * 从流式消息中提取会话 ID。桌面端 StreamChunkProcessor 的装配形状：
   * - streamChunk       → data 为单个 chunk，conversationId 在 data.conversationId；
   * - streamChunkBatch  → data 为 chunk 数组，conversationId 在【每个元素】上（包装层没有）。
   * 兼容处理三种位置，避免真实批量流（50ms 节流合并）被整体当作无主消息丢弃。
   */
  private extractStreamConversationId(message: any): string {
    if (typeof message?.conversationId === 'string' && message.conversationId) return message.conversationId;
    const data = message?.data;
    if (Array.isArray(data)) {
      const first = data[0];
      if (first && typeof first.conversationId === 'string' && first.conversationId) return first.conversationId;
      return '';
    }
    if (data && typeof data === 'object') {
      return typeof data.conversationId === 'string' ? data.conversationId : '';
    }
    return '';
  }

  /** streamChunk / streamChunkBatch 是否携带终结类事件（complete/cancelled/error） */
  private hasTerminalChunk(message: any): boolean {
    const data = message?.data;
    const chunks = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
    return chunks.some((c: any) => {
      const t = c?.type;
      return t === 'complete' || t === 'cancelled' || t === 'error';
    });
  }

  /**
   * 流结束后补齐会话摘要元数据（fire-and-forget）：
   * messageCount 取实际历史消息数（后端 updateSummary 会钳制到真实历史提交数），
   * preview 取最后一条非工具响应的用户消息文本前 50 字符（与桌面端口径一致）。
   * 纯展示性数据，失败静默不影响会话本身。
   */
  private syncConversationSummary(conversationId: string): void {
    void (async () => {
      try {
        const messages = await this.host.conversationManager.getMessages(conversationId, null);
        let preview: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (!m || m.role !== 'user' || m.isFunctionResponse) continue;
          // 与桌面端 partsToText 口径一致：只取非思考文本段，思考/工具段不计入预览
          const text = Array.isArray(m.parts)
            ? m.parts
                .filter((p: any) => typeof p?.text === 'string' && p.text && !p.thought)
                .map((p: any) => p.text)
                .join('')
                .trim()
            : '';
          if (text) {
            preview = text.slice(0, SUMMARY_PREVIEW_LENGTH);
            break;
          }
        }
        await this.invokeHandler('conversation.updateSummary', {
          conversationId,
          messageCount: messages.length,
          preview: preview ?? undefined
        });
        // 摘要已更新（计数/预览）：桌面端最近对话列表实时刷新
        this.notifyConversationsChanged();
      } catch {
        // 摘要同步失败静默：仅影响对话列表的计数/预览展示，不阻断会话操作
      }
    })();
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
  // 直连后端（V2 去虚拟化）：进程内直接执行 webview handler，无 MessageRouter/
  // 虚拟客户端/序列化往返；校验与业务逻辑与桌面端完全一致（handler 函数复用）。
  // ==========================================================================

  /** 非流式操作：直连调用后端 handler，返回 handler sendResponse 的数据 */
  private invokeHandler(type: string, data: unknown): Promise<any> {
    return Promise.resolve(this.host.invokeHandler(type, data));
  }

  /** 流式操作：直连启动（chatStream/retryStream/toolConfirmation/cancelStream），
   *  返回 started 应答；chunk 经 host 装配的 streamSink 回传（onClientMessage） */
  private runStream(type: string, data: unknown): Promise<{ started?: boolean; cancelled?: boolean }> {
    return Promise.resolve(this.host.runStream(type, data));
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
      await this.handleListConversations(res, url.searchParams.get('limit'), url.searchParams.get('offset'));
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
        const all = await this.host.conversationManager.getMessages(conversationId, null);
        // 移动端带宽优化：剥离附件二进制（inlineData/fileData base64，可达数十 MB），
        // 移动端 UI 只渲染文本/思考/工具调用，附件载荷不应经局域网全量下发
        const messages = stripMessagePayloads(all);
        // 历史分页（自尾端向前）：offset=0 返回最后 limit 条；滚动向上回溯加载更早消息。
        // 移动端避免整段历史（数百条）一次性渲染/下发，与桌面端 MESSAGES_PAGE_SIZE 语义一致
        const limit = clampInt(url.searchParams.get('limit'), MESSAGES_PAGE_SIZE, 1, MESSAGES_PAGE_MAX);
        const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
        const from = Math.max(0, messages.length - offset - limit);
        const to = messages.length - offset;
        this.sendJson(res, 200, {
          ok: true,
          messages: to > from ? messages.slice(from, to) : [],
          total: messages.length,
          hasMore: offset + limit < messages.length,
          offset
        });
      } catch (err: any) {
        this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to load messages' });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/workspace') {
      this.sendJson(res, 200, { ok: true, ...this.buildWorkspacePayload() });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/workspaces') {
      await this.handleListWorkspaces(res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/fs') {
      await this.handleListFs(res, url.searchParams.get('path') || '');
      return;
    }
    if (req.method === 'POST' && pathname === '/api/workspace-switch') {
      await this.handleWorkspaceSwitch(res, await this.readBody(req));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/files') {
      await this.handleListFiles(res, url.searchParams.get('path') || '');
      return;
    }
    if (req.method === 'GET' && pathname === '/api/file') {
      await this.handleReadFile(res, url.searchParams.get('path') || '');
      return;
    }
    if (req.method === 'POST' && pathname === '/api/file') {
      await this.handleWriteFile(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/open-file') {
      await this.handleOpenFile(res, await this.readBody(req));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/configs') {
      await this.handleListConfigs(res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/settings') {
      await this.handleSettingsGet(res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/settings') {
      await this.handleSettingsUpdate(res, await this.readBody(req));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/dependencies') {
      await this.handleDependencies(res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/tools') {
      await this.handleListTools(res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/channel-toggle') {
      await this.handleChannelToggle(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/channel-active') {
      await this.handleChannelActive(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/remote-action') {
      await this.handleRemoteAction(res, await this.readBody(req));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      await this.handleGetConfig(res, url.searchParams.get('configId') || '');
      return;
    }
    if (req.method === 'POST' && pathname === '/api/config-create') {
      await this.handleConfigCreate(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/config-update') {
      await this.handleConfigUpdate(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/config-delete') {
      await this.handleConfigDelete(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/model') {
      await this.handleSetModel(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/models-add') {
      await this.handleModelsAdd(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/models-remove') {
      await this.handleModelsRemove(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/models-get') {
      await this.handleModelsGet(res, await this.readBody(req));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/prompt-modes') {
      await this.handlePromptModes(res);
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
    if (req.method === 'POST' && pathname === '/api/retry') {
      await this.handleRetry(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/delete-message') {
      await this.handleDeleteMessage(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/tool-confirm') {
      await this.handleToolConfirm(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/rename') {
      await this.handleRename(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/workspace-add') {
      await this.handleWorkspaceAdd(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/workspace-remove') {
      await this.handleWorkspaceRemove(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/conversation-delete') {
      await this.handleConversationDelete(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/edit-message') {
      await this.handleEditMessage(res, await this.readBody(req));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/reroll') {
      await this.handleReroll(res, await this.readBody(req));
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
      activeChannelId: this.host.getSettings().activeChannelId || null,
      activeConversationId: this.activeConversationId,
      activeConversationTitle,
      ...this.buildWorkspacePayload()
    };
  }

  private async handleListConversations(res: http.ServerResponse, rawLimit?: string | null, rawOffset?: string | null): Promise<void> {
    try {
      const ids = await this.host.conversationManager.listConversations();
      // 列表分页（自最新排序后切片）：listConversations 的返回顺序无更新序保证
      //（目录枚举/键序），必须先全量读 meta 排序再切片，否则分页会出现跨页乱序
      const metas = await Promise.all(
        ids.map((id) => this.host.conversationManager.getMetadata(id).catch(() => null))
      );
      // 注意：meta.json 顶层没有 messageCount/preview 字段，二者位于 custom 段
      // （HIS-11 起桌面端即按 custom.messageCount/custom.preview 汇总，远端必须同口径，
      // 否则真实数据下 messageCount 恒为 0 导致会话列表被整体过滤为空）。
      const all = ids
        .map((id, i) => {
          const meta = metas[i];
          const custom = (meta?.custom ?? {}) as Record<string, unknown>;
          return {
            id,
            title: typeof meta?.title === 'string' ? meta.title : '',
            updatedAt: typeof meta?.updatedAt === 'number' ? meta.updatedAt : 0,
            messageCount: typeof custom.messageCount === 'number' ? custom.messageCount : 0,
            preview: typeof custom.preview === 'string' ? custom.preview : ''
          };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const limit = clampInt(rawLimit, CONVERSATIONS_PAGE_SIZE, 1, CONVERSATIONS_PAGE_MAX);
      const offset = clampInt(rawOffset, 0, 0, 1_000_000);
      const conversations = all.slice(offset, offset + limit);
      this.sendJson(res, 200, {
        ok: true,
        conversations,
        total: all.length,
        offset,
        limit,
        hasMore: offset + conversations.length < all.length
      });
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

  /**
   * 发送消息。支持按请求覆盖渠道/模型/模式：
   * - configId：显式指定渠道（缺省回退当前激活渠道 → 第一个启用渠道）；
   * - modelId：透传 modelOverride（桌面端 chatStream 同一参数）；
   * - promptModeId：透传模型模式（桌面端 InputSelectorBar 模式选择同一参数）。
   */
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
        await this.invokeHandler('conversation.createConversation', {
          conversationId: targetId,
          title
        });
      } catch (err: any) {
        this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to create conversation' });
        return;
      }
      // 新会话落库后实时通知列表刷新（桌面端最近对话 + 移动端抽屉）
      this.notifyConversationsChanged();
    }

    // 渠道：显式指定 > 当前激活 > 第一个启用渠道
    const requestedConfigId = typeof body?.configId === 'string' && body.configId ? body.configId : '';
    let configId: string | undefined;
    if (requestedConfigId) {
      if (!isSafeConfigId(requestedConfigId)) {
        this.sendJson(res, 400, { ok: false, error: 'Invalid configId' });
        return;
      }
      configId = requestedConfigId;
    } else {
      configId = await this.resolveConfigId();
    }
    if (!configId) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'No channel enabled. Configure a channel with a valid API key in settings first.'
      });
      return;
    }

    // 模型覆盖（modelOverride）与模型模式（promptModeId）：透传桌面端 chatStream 同一参数
    const modelOverride = typeof body?.modelId === 'string' && body.modelId
      ? body.modelId.slice(0, 256)
      : undefined;
    const promptModeId = typeof body?.promptModeId === 'string' && body.promptModeId
      ? body.promptModeId.slice(0, 64)
      : undefined;

    this.activeConversationId = targetId;
    const streamId = `remote_${randomUUID()}`;
    try {
      await this.runStream('chatStream', {
        conversationId: targetId,
        configId,
        message: text,
        messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        modelOverride,
        promptModeId,
        streamId
      });
      this.sendJson(res, 200, { ok: true, started: true, conversationId: targetId, streamId });
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
      await this.runStream('cancelStream', { conversationId });
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
      await this.invokeHandler('conversation.setTitle', { conversationId, title });
      this.sendJson(res, 200, { ok: true });
      // 改名后实时刷新会话列表（桌面端最近对话 + 移动端抽屉）
      this.notifyConversationsChanged();
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to rename conversation' });
    }
  }

  /**
   * 新增工作区：
   * - 携带 fsPath（移动端目录浏览选中）→ 透传 workspace.openFolder { fsPath }，
   *   桌面端直接打开该目录（不弹窗），自动加入收藏并设为活动工作区；
   * - 不传 fsPath → 桌面端弹出文件夹选择对话框（兜底路径）。
   * 返回与桌面端 handler 一致的结构（success/canceled/activeWorkspaceUri/workspaces/saved）。
   */
  private async handleWorkspaceAdd(res: http.ServerResponse, body: any): Promise<void> {
    const fsPath = typeof body?.fsPath === 'string' ? body.fsPath : '';
    if (fsPath && !isSafeAbsolutePath(fsPath)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid fsPath' });
      return;
    }
    try {
      const result = await this.invokeHandler('workspace.openFolder', fsPath ? { fsPath } : {});
      if (result?.canceled === true) {
        this.sendJson(res, 200, { ok: true, canceled: true });
        return;
      }
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to open workspace folder' });
        return;
      }
      this.sendJson(res, 200, {
        ok: true,
        activeWorkspaceUri: result?.activeWorkspaceUri || null,
        workspaces: Array.isArray(result?.workspaces) ? result.workspaces : [],
        saved: Array.isArray(result?.saved) ? result.saved : []
      });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to open workspace folder' });
    }
  }

  /** 从收藏列表移除工作区（不影响已打开的工作区；透传 workspace.removeSaved） */
  private async handleWorkspaceRemove(res: http.ServerResponse, body: any): Promise<void> {
    const fsPath = typeof body?.fsPath === 'string' ? body.fsPath : '';
    if (!isSafeFsPath(fsPath)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid fsPath' });
      return;
    }
    try {
      const result = await this.invokeHandler('workspace.removeSaved', { fsPath });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to remove saved workspace' });
        return;
      }
      this.sendJson(res, 200, { ok: true, saved: Array.isArray(result?.saved) ? result.saved : [] });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to remove saved workspace' });
    }
  }

  /** 删除会话（透传 conversation.deleteConversation；删除激活会话后清空移动端跟踪） */
  private async handleConversationDelete(res: http.ServerResponse, body: any): Promise<void> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    if (!isSafeConversationId(conversationId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId' });
      return;
    }
    try {
      const result = await this.invokeHandler('conversation.deleteConversation', { conversationId });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to delete conversation' });
        return;
      }
      if (this.activeConversationId === conversationId) {
        this.activeConversationId = null;
      }
      this.sendJson(res, 200, { ok: true });
      this.notifyConversationsChanged();
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to delete conversation' });
    }
  }

  /** 编辑用户消息并重新生成（透传 chat.editBranchStream，创建编辑分支候选，不覆盖原消息） */
  private async handleEditMessage(res: http.ServerResponse, body: any): Promise<void> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    const messageId = typeof body?.messageId === 'string' ? body.messageId : '';
    const newText = typeof body?.newText === 'string' ? body.newText.trim() : '';
    if (!isSafeConversationId(conversationId) || !isSafeNodeId(messageId) || !newText) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId, messageId or newText' });
      return;
    }
    if (newText.length > MAX_MESSAGE_LENGTH) {
      this.sendJson(res, 400, { ok: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` });
      return;
    }
    const configId = await this.resolveConfigId();
    if (!configId) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'No channel enabled. Configure a channel with a valid API key in settings first.'
      });
      return;
    }
    this.activeConversationId = conversationId;
    try {
      // chat.editBranchStream 是注册表流式 handler（chunk 经 ctx.postMessage → SSE），
      // 由 invokeHandler 直连执行，started 应答经 sendResponse 结算
      await this.invokeHandler('chat.editBranchStream', {
        conversationId,
        userNodeId: messageId,
        messageId,
        newText,
        configId,
        mode: 'branch',
        streamId: `remote_${randomUUID()}`
      });
      this.sendJson(res, 200, { ok: true, started: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to edit message' });
    }
  }

  /** 重新生成指定助手消息（透传 chat.rerollStream，分支图保留旧回答可切回） */
  private async handleReroll(res: http.ServerResponse, body: any): Promise<void> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    const assistantNodeId = typeof body?.assistantNodeId === 'string' ? body.assistantNodeId : '';
    if (!isSafeConversationId(conversationId) || !isSafeNodeId(assistantNodeId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId or assistantNodeId' });
      return;
    }
    const configId = await this.resolveConfigId();
    if (!configId) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'No channel enabled. Configure a channel with a valid API key in settings first.'
      });
      return;
    }
    try {
      // chat.rerollStream 是注册表流式 handler（chunk 经 ctx.postMessage → SSE），
      // 由 invokeHandler 直连执行，started 应答经 sendResponse 结算
      await this.invokeHandler('chat.rerollStream', {
        conversationId,
        assistantNodeId,
        configId,
        streamId: `remote_${randomUUID()}`
      });
      this.sendJson(res, 200, { ok: true, started: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to reroll message' });
    }
  }

  // ==========================================================================
  // 工作区：状态 / 列表 / 切换 / 文件浏览 / 读写 / 桌面端打开
  // 文件操作全部经 MessageRouter 透传 webview FileHandlers（工作区包含校验、
  // 大小上限、文本嗅探在 handler 侧执行），本层仅做形状白名单前置校验。
  // ==========================================================================

  private async handleListWorkspaces(res: http.ServerResponse): Promise<void> {
    try {
      const [list, saved] = await Promise.all([
        this.invokeHandler('getWorkspaceList', {}),
        this.invokeHandler('workspace.getSaved', {}).catch(() => ({ saved: [] }))
      ]);
      this.sendJson(res, 200, {
        ok: true,
        activeWorkspaceUri: list?.activeWorkspaceUri || null,
        workspaces: Array.isArray(list?.workspaces) ? list.workspaces : [],
        saved: Array.isArray(saved?.saved) ? saved.saved : []
      });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to list workspaces' });
    }
  }

  /**
   * 切换工作区：按目标 URI 是否已打开分派——
   * - 目标在「当前打开的工作区」中：workspace.setActive 固定（立即生效）；
   * - 目标仅存在于收藏列表：workspace.openFolder { fsPath }，由宿主打开该目录
   *   并自动固定（此前一律走 workspace.setActive，对未打开的工作区会在
   *   WorkspaceManager 里静默无操作，移动端表现为「切换失效」）；
   * - 两处都没有：404，提示先在桌面端打开或收藏该目录。
   */
  private async handleWorkspaceSwitch(res: http.ServerResponse, body: any): Promise<void> {
    const workspaceUri = typeof body?.workspaceUri === 'string' && body.workspaceUri.length <= 2048
      ? body.workspaceUri
      : '';
    if (!workspaceUri) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid workspaceUri' });
      return;
    }
    try {
      const [list, saved] = await Promise.all([
        this.invokeHandler('getWorkspaceList', {}),
        this.invokeHandler('workspace.getSaved', {}).catch(() => ({ saved: [] }))
      ]);
      const openList = Array.isArray(list?.workspaces) ? list.workspaces : [];
      const savedList = Array.isArray(saved?.saved) ? saved.saved : [];
      const norm = (u: string): string => u.replace(/\\/g, '/').toLowerCase();
      const inOpen = openList.some((w: any) => !!w?.uri && norm(w.uri) === norm(workspaceUri));
      if (inOpen) {
        await this.invokeHandler('workspace.setActive', { workspaceUri });
        this.sendJson(res, 200, { ok: true, opened: false });
        return;
      }
      const savedItem = savedList.find((w: any) => !!w?.uri && norm(w.uri) === norm(workspaceUri));
      if (savedItem && typeof savedItem?.fsPath === 'string' && savedItem.fsPath) {
        const result = await this.invokeHandler('workspace.openFolder', { fsPath: savedItem.fsPath });
        if (result?.success === false) {
          const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
          this.sendJson(res, 400, { ok: false, error: msg || 'Failed to open workspace folder' });
          return;
        }
        this.sendJson(res, 200, {
          ok: true,
          opened: true,
          activeWorkspaceUri: result?.activeWorkspaceUri || null
        });
        return;
      }
      this.sendJson(res, 404, {
        ok: false,
        error: 'Workspace not found. Open or save the folder on the desktop first.'
      });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to switch workspace' });
    }
  }

  /**
   * 服务端目录浏览（移动端「选择工作区文件夹」用）：path 为空串时返回根入口
   * （Windows 为盘符列表，POSIX 为 / 的一级目录），否则返回指定目录的子目录列表。
   * 只下发目录项（名称 + 完整路径），绝不读取文件内容；条目按名称排序且截断上限。
   */
  private async handleListFs(res: http.ServerResponse, rawPath: string): Promise<void> {
    if (rawPath !== '' && !isSafeAbsolutePath(rawPath)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid path' });
      return;
    }
    try {
      if (rawPath === '') {
        if (process.platform === 'win32') {
          const drives: string[] = [];
          for (let c = 65; c <= 90; c++) {
            const d = `${String.fromCharCode(c)}:\\`;
            try {
              if (fs.existsSync(d)) drives.push(d);
            } catch {
              // 不可访问的盘符跳过
            }
          }
          this.sendJson(res, 200, { ok: true, path: '', drives, entries: [] });
          return;
        }
        rawPath = '/';
      }
      const entries: Array<{ name: string; path: string; type: 'directory' }> = [];
      let dirents: fs.Dirent[] = [];
      try {
        // withFileTypes 免逐项 stat：绝大多数条目可直接按 isDirectory 判定
        dirents = fs.readdirSync(rawPath, { withFileTypes: true });
      } catch {
        this.sendJson(res, 400, { ok: false, error: 'Failed to list directory' });
        return;
      }
      for (const dirent of dirents) {
        if (entries.length >= MAX_FS_LISTING_ENTRIES) break;
        if (dirent.name.startsWith('.')) continue; // 隐藏项（.git/.vscode 等）不展示
        if (!dirent.isDirectory()) continue;
        entries.push({ name: dirent.name, path: path.join(rawPath, dirent.name), type: 'directory' });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      this.sendJson(res, 200, {
        ok: true,
        path: rawPath,
        parent: this.computeParentDir(rawPath),
        entries
      });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to list directory' });
    }
  }

  /** 计算目录浏览的父目录（盘符根/文件系统根返回 null，UI 不再提供「上一级」） */
  private computeParentDir(dir: string): string | null {
    const isRoot = /^[A-Za-z]:[\\/]$/.test(dir) || dir === '/';
    if (isRoot) return null;
    const parent = path.dirname(dir);
    return parent === dir ? null : parent;
  }

  private async handleListFiles(res: http.ServerResponse, rawPath: string): Promise<void> {
    // searchParams.get 已解码一次；不得再次 decode（否则文件名含 % 字面量的路径错乱）
    const path = rawPath;
    // 空字符串 = 工作区根目录（FileHandlers.listWorkspaceDirectory 的根语义）
    if (!isSafeWorkspaceDirPath(path)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid path' });
      return;
    }
    try {
      const result = await this.invokeHandler('listWorkspaceDirectory', { path });
      if (result?.success === false) {
        this.sendJson(res, 400, { ok: false, error: result.error || 'Failed to list directory' });
        return;
      }
      this.sendJson(res, 200, {
        ok: true,
        path,
        workspaceUri: result?.workspaceUri || null,
        entries: Array.isArray(result?.entries) ? result.entries : []
      });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to list directory' });
    }
  }

  private async handleReadFile(res: http.ServerResponse, rawPath: string): Promise<void> {
    const path = rawPath;
    if (!isSafeWorkspacePath(path)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid path' });
      return;
    }
    try {
      const result = await this.invokeHandler('readWorkspaceTextFile', { path });
      if (result?.success === false) {
        this.sendJson(res, 400, { ok: false, error: result.error || 'Failed to read file' });
        return;
      }
      let content: string = typeof result?.content === 'string' ? result.content : '';
      // 移动端带宽/渲染优化：超大文本只下发前 1M 字符并标记截断（UI 只读提示），
      // 避免手机端经局域网拉取 10MB 级文本拖垮页面
      let truncated = false;
      if (content.length > MAX_FILE_CONTENT_BYTES) {
        content = content.slice(0, MAX_FILE_CONTENT_BYTES);
        truncated = true;
      }
      this.sendJson(res, 200, { ok: true, path: result?.path || path, content, truncated });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to read file' });
    }
  }

  private async handleWriteFile(res: http.ServerResponse, body: any): Promise<void> {
    const path = typeof body?.path === 'string' ? body.path : '';
    const content = typeof body?.content === 'string' ? body.content : null;
    if (!isSafeWorkspacePath(path)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid path' });
      return;
    }
    if (content === null) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid content' });
      return;
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_CONTENT_BYTES) {
      this.sendJson(res, 413, { ok: false, error: 'Content too large' });
      return;
    }
    try {
      const result = await this.invokeHandler('workspace.writeTextFile', { path, content });
      if (result?.success === false) {
        this.sendJson(res, 400, { ok: false, error: result.error || 'Failed to write file' });
        return;
      }
      this.sendJson(res, 200, { ok: true, path: result?.path || path });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to write file' });
    }
  }

  private async handleOpenFile(res: http.ServerResponse, body: any): Promise<void> {
    const path = typeof body?.path === 'string' ? body.path : '';
    if (!isSafeWorkspacePath(path)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid path' });
      return;
    }
    const startLine = typeof body?.startLine === 'number' && Number.isInteger(body.startLine) && body.startLine > 0
      ? body.startLine
      : undefined;
    try {
      const result = await this.invokeHandler('openWorkspaceFileAt', {
        path,
        startLine,
        highlight: true,
        preview: true
      });
      if (result?.success === false) {
        this.sendJson(res, 400, { ok: false, error: result.error || 'Failed to open file' });
        return;
      }
      this.sendJson(res, 200, { ok: true, path: result?.path || path });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to open file' });
    }
  }

  // ==========================================================================
  // 渠道 / 模型
  // ==========================================================================

  private async handleListConfigs(res: http.ServerResponse): Promise<void> {
    try {
      const ids: string[] = [];
      const raw = await this.invokeHandler('config.listConfigs', {});
      if (Array.isArray(raw)) {
        raw.forEach((id) => { if (typeof id === 'string') ids.push(id); });
      }
      // 并行取渠道元信息；单个失败不阻断整体（网络抖动渠道跳过）；
      // 数量上限 20：实际用户渠道极少超此值，超限并行也会压垮消息队列
      const configs = (await Promise.all(
        ids.slice(0, 20).map((id) =>
          this.invokeHandler('config.getConfig', { configId: id })
            .then((cfg) => ({
              id,
              name: typeof cfg?.name === 'string' && cfg.name ? cfg.name : id,
              model: typeof cfg?.model === 'string' ? cfg.model : '',
              enabled: cfg?.enabled !== false,
              // 思考强度选择器依赖渠道类型与 options/optionsEnabled（与桌面端同源）
              type: typeof cfg?.type === 'string' ? cfg.type : '',
              options: cfg?.options && typeof cfg.options === 'object' ? cfg.options : undefined,
              optionsEnabled: cfg?.optionsEnabled && typeof cfg.optionsEnabled === 'object' ? cfg.optionsEnabled : undefined
            }))
            .catch(() => ({ id, name: id, model: '', enabled: true, type: '' }))
        )
      ));
      this.sendJson(res, 200, { ok: true, configs });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to list configs' });
    }
  }

  /**
   * 渠道详情（移动端设置页编辑用）：返回完整配置字段（apiKey 脱敏为占位串，
   *  UI 据此识别「已设置，留空/占位串保持不变」），models 仅裁剪 id/name。
   */
  private async handleGetConfig(res: http.ServerResponse, rawConfigId: string): Promise<void> {
    const configId = rawConfigId;
    if (!isSafeConfigId(configId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId' });
      return;
    }
    try {
      const cfg = await this.invokeHandler('config.getConfig', { configId });
      if (!cfg) {
        this.sendJson(res, 404, { ok: false, error: 'Config not found' });
        return;
      }
      // 模型列表裁剪字段：只下发移动端 UI 需要的 id/name，避免超大配置体
      const models = Array.isArray(cfg.models)
        ? cfg.models
            .slice(0, 200)
            .map((m: any) => ({ id: typeof m?.id === 'string' ? m.id : '', name: typeof m?.name === 'string' ? m.name : '' }))
            .filter((m: { id: string }) => !!m.id)
        : [];
      this.sendJson(res, 200, {
        ok: true,
        config: {
          id: cfg.id,
          name: typeof cfg.name === 'string' ? cfg.name : '',
          model: typeof cfg.model === 'string' ? cfg.model : '',
          type: typeof cfg.type === 'string' ? cfg.type : '',
          enabled: cfg?.enabled !== false,
          url: typeof cfg.url === 'string' ? cfg.url : '',
          apiKey: typeof cfg.apiKey === 'string' && cfg.apiKey ? '********' : '',
          options: cfg?.options && typeof cfg.options === 'object' ? cfg.options : undefined,
          optionsEnabled: cfg?.optionsEnabled && typeof cfg.optionsEnabled === 'object' ? cfg.optionsEnabled : undefined,
          toolMode: typeof cfg.toolMode === 'string' ? cfg.toolMode : undefined,
          timeout: typeof cfg.timeout === 'number' ? cfg.timeout : undefined,
          maxContextTokens: typeof cfg.maxContextTokens === 'number' ? cfg.maxContextTokens : undefined,
          contextManagementEnabled: cfg?.contextManagementEnabled,
          contextManagement: cfg?.contextManagement && typeof cfg.contextManagement === 'object' ? cfg.contextManagement : undefined,
          toolOptions: cfg?.toolOptions && typeof cfg.toolOptions === 'object' ? cfg.toolOptions : undefined,
          customBody: cfg?.customBody ?? undefined,
          customHeaders: Array.isArray(cfg.customHeaders) ? cfg.customHeaders : undefined,
          retryEnabled: cfg?.retryEnabled,
          retryCount: typeof cfg.retryCount === 'number' ? cfg.retryCount : undefined,
          retryInterval: typeof cfg.retryInterval === 'number' ? cfg.retryInterval : undefined,
          models
        }
      });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to get config' });
    }
  }

  /** 新增渠道（对齐桌面端 config.createConfig：{ type, name }） */
  private async handleConfigCreate(res: http.ServerResponse, body: any): Promise<void> {
    const type = typeof body?.type === 'string' ? body.type.trim() : '';
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 64) : '';
    const ALLOWED_TYPES = new Set(['gemini', 'openai', 'openai-responses', 'anthropic']);
    if (!ALLOWED_TYPES.has(type) || !name) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid type or name' });
      return;
    }
    try {
      const configId = await this.invokeHandler('config.createConfig', { type, name });
      if (typeof configId !== 'string' || !configId) {
        this.sendJson(res, 500, { ok: false, error: 'Failed to create config' });
        return;
      }
      this.sendJson(res, 200, { ok: true, configId });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to create config' });
    }
  }

  /** 更新渠道字段（对齐桌面端 config.updateConfig：{ configId, updates }）。
   *  apiKey 占位串（********）/空串表示「保持不变」，不覆盖已有密钥。 */
  private async handleConfigUpdate(res: http.ServerResponse, body: any): Promise<void> {
    const configId = typeof body?.configId === 'string' ? body.configId : '';
    const updates = body?.updates;
    if (!isSafeConfigId(configId) || typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId or updates' });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(updates), 'utf-8') > MAX_SETTINGS_PATCH_BYTES) {
      this.sendJson(res, 413, { ok: false, error: 'Config update too large' });
      return;
    }
    // apiKey 占位/空串不落库（保持已设置的密钥不变）
    if (typeof updates.apiKey === 'string' && (!updates.apiKey || updates.apiKey === '********')) {
      delete updates.apiKey;
    }
    try {
      const result = await this.invokeHandler('config.updateConfig', { configId, updates });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to update config' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to update config' });
    }
  }

  /** 删除渠道（对齐桌面端 config.deleteConfig：{ configId }） */
  private async handleConfigDelete(res: http.ServerResponse, body: any): Promise<void> {
    const configId = typeof body?.configId === 'string' ? body.configId : '';
    if (!isSafeConfigId(configId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId' });
      return;
    }
    try {
      const result = await this.invokeHandler('config.deleteConfig', { configId });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to delete config' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to delete config' });
    }
  }

  private async handleSetModel(res: http.ServerResponse, body: any): Promise<void> {
    const configId = typeof body?.configId === 'string' ? body.configId : '';
    const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
    if (!isSafeConfigId(configId) || !isSafeModelId(modelId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId or modelId' });
      return;
    }
    try {
      const result = await this.invokeHandler('models.setActiveModel', { configId, modelId });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to set model' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to set model' });
    }
  }

  /** 向渠道追加模型（对齐桌面端 models.addModels：{ configId, models: [{ id, name }] }） */
  private async handleModelsAdd(res: http.ServerResponse, body: any): Promise<void> {
    const configId = typeof body?.configId === 'string' ? body.configId : '';
    const models = Array.isArray(body?.models) ? body.models.slice(0, 50) : [];
    if (!isSafeConfigId(configId) || models.length === 0
        || !models.every((m: any) => m && typeof m === 'object'
            && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 256
            && (typeof m.name !== 'string' || m.name.length <= 256))) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId or models' });
      return;
    }
    try {
      const result = await this.invokeHandler('models.addModels', { configId, models });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to add models' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to add models' });
    }
  }

  /** 从渠道移除模型（对齐桌面端 models.removeModel：{ configId, modelId }） */
  private async handleModelsRemove(res: http.ServerResponse, body: any): Promise<void> {
    const configId = typeof body?.configId === 'string' ? body.configId : '';
    const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
    if (!isSafeConfigId(configId) || !isSafeModelId(modelId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId or modelId' });
      return;
    }
    try {
      const result = await this.invokeHandler('models.removeModel', { configId, modelId });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to remove model' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to remove model' });
    }
  }

  /** 从提供商拉取模型列表（对齐桌面端 models.getModels：{ configId }） */
  private async handleModelsGet(res: http.ServerResponse, body: any): Promise<void> {
    const configId = typeof body?.configId === 'string' ? body.configId : '';
    if (!isSafeConfigId(configId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId' });
      return;
    }
    try {
      const result = await this.invokeHandler('models.getModels', { configId });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to fetch models' });
        return;
      }
      const models = Array.isArray(result?.models)
        ? result.models
            .slice(0, 200)
            .map((m: any) => ({ id: typeof m?.id === 'string' ? m.id : '', name: typeof m?.name === 'string' ? m.name : '' }))
            .filter((m: { id: string }) => !!m.id)
        : [];
      this.sendJson(res, 200, { ok: true, models });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to fetch models' });
    }
  }

  /** 模型模式列表（移动端输入区模式下拉：与桌面端 InputSelectorBar 同源） */
  private async handlePromptModes(res: http.ServerResponse): Promise<void> {
    try {
      const result = await this.invokeHandler('getPromptModes', {});
      const modes = Array.isArray(result?.modes)
        ? result.modes
            .map((m: any) => ({
              id: typeof m?.id === 'string' ? m.id : '',
              name: typeof m?.name === 'string' ? m.name : '',
              icon: typeof m?.icon === 'string' ? m.icon : '',
              dynamicContextStrategy: typeof m?.dynamicContextStrategy === 'string' ? m.dynamicContextStrategy : undefined
            }))
            .filter((m: { id: string }) => !!m.id)
        : [];
      this.sendJson(res, 200, {
        ok: true,
        modes,
        currentModeId: typeof result?.currentModeId === 'string' ? result.currentModeId : ''
      });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to load prompt modes' });
    }
  }

  // ==========================================================================
  // 设置（移动端全量设置页）：透传桌面端 getSettings / updateSettings 消息管道。
  // 读侧脱敏（apiKey / base64 音频 / 代理 URL 凭据），写侧仅做形状白名单与大小
  // 限制，具体校验/持久化与桌面端完全一致（SettingsCore 深合并 + 危险键剥离）。
  // ==========================================================================

  private async handleSettingsGet(res: http.ServerResponse): Promise<void> {
    try {
      const result = await this.invokeHandler('getSettings', {});
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to load settings' });
        return;
      }
      this.sendJson(res, 200, { ok: true, settings: sanitizeSettingsForRemote(result?.settings) });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to load settings' });
    }
  }

  /** 写侧密钥剥离：客户端回写脱敏占位串（********）/空串表示「保持不变」，
   *  与 handleConfigUpdate 的 apiKey 剥离同语义；代理 URL 若含 ***@（脱敏后的
   *  userinfo）同样视为占位，不覆盖真实凭据。 */
  private stripMaskedSecrets(patch: any): void {
    if (!patch || typeof patch !== 'object') return;
    const stripKey = (obj: any): void => {
      if (obj && typeof obj === 'object' && typeof obj.apiKey === 'string') {
        if (!obj.apiKey || obj.apiKey === '********') delete obj.apiKey;
      }
    };
    const toolsConfig = patch.toolsConfig;
    if (toolsConfig && typeof toolsConfig === 'object') {
      stripKey(toolsConfig.generate_image);
      const tokenCount = toolsConfig.token_count;
      if (tokenCount && typeof tokenCount === 'object') {
        for (const key of Object.keys(tokenCount)) stripKey(tokenCount[key]);
      }
    }
    if (typeof patch.proxy?.url === 'string' && patch.proxy.url.includes('***@')) {
      delete patch.proxy.url;
    }
  }

  private async handleSettingsUpdate(res: http.ServerResponse, body: any): Promise<void> {
    const patch = body?.settings;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid settings patch' });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(patch), 'utf-8') > MAX_SETTINGS_PATCH_BYTES) {
      this.sendJson(res, 413, { ok: false, error: 'Settings patch too large' });
      return;
    }
    this.stripMaskedSecrets(patch);
    try {
      const result = await this.invokeHandler('updateSettings', { settings: patch });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to update settings' });
        return;
      }
      this.sendJson(res, 200, { ok: true, settings: sanitizeSettingsForRemote(result?.settings) });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to update settings' });
    }
  }

  /** 依赖安装状态（只读展示：python/node/ffmpeg 安装路径与可用性） */
  private async handleDependencies(res: http.ServerResponse): Promise<void> {
    try {
      const result = await this.invokeHandler('dependencies.list', {});
      this.sendJson(res, 200, { ok: true, dependencies: result });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to list dependencies' });
    }
  }

  /** 工具清单（启用状态 + 分类 + 自动执行配置；设置页「工具启用/自动执行」两节用） */
  private async handleListTools(res: http.ServerResponse): Promise<void> {
    try {
      const [toolsResult, autoExecResult] = await Promise.all([
        this.invokeHandler('tools.getTools', {}),
        this.invokeHandler('tools.getAutoExecConfig', {}).catch(() => null)
      ]);
      const tools = Array.isArray(toolsResult?.tools)
        ? toolsResult.tools.map((tool: any) => ({
            name: typeof tool?.name === 'string' ? tool.name : '',
            description: typeof tool?.description === 'string' ? tool.description : '',
            enabled: tool?.enabled !== false,
            category: typeof tool?.category === 'string' ? tool.category : ''
          })).filter((tool: { name: string }) => !!tool.name)
        : [];
      const autoExec = (autoExecResult?.config && typeof autoExecResult.config === 'object')
        ? autoExecResult.config
        : {};
      this.sendJson(res, 200, { ok: true, tools, autoExec });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to list tools' });
    }
  }

  /** 渠道启用/停用（透传 config.updateConfig { enabled }；桌面端渠道列表同路径） */
  private async handleChannelToggle(res: http.ServerResponse, body: any): Promise<void> {
    const configId = typeof body?.configId === 'string' ? body.configId : '';
    const enabled = body?.enabled === true;
    if (!isSafeConfigId(configId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId' });
      return;
    }
    try {
      const result = await this.invokeHandler('config.updateConfig', { configId, updates: { enabled } });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to update channel' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to update channel' });
    }
  }

  /** 设为当前渠道（透传 settings.setActiveChannelId；发送消息默认使用该渠道） */
  private async handleChannelActive(res: http.ServerResponse, body: any): Promise<void> {
    const configId = typeof body?.configId === 'string' ? body.configId : '';
    if (!isSafeConfigId(configId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid configId' });
      return;
    }
    try {
      const result = await this.invokeHandler('settings.setActiveChannelId', { channelId: configId });
      if (result?.success === false) {
        const msg = typeof result?.error === 'string' ? result.error : result?.error?.message;
        this.sendJson(res, 400, { ok: false, error: msg || 'Failed to set active channel' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to set active channel' });
    }
  }

  /** 远程控制服务器操作（restart/stop，透传 remoteControl.apply 既有桌面端逻辑） */
  private async handleRemoteAction(res: http.ServerResponse, body: any): Promise<void> {
    const type = body?.type;
    if (type !== 'restart' && type !== 'stop') {
      this.sendJson(res, 400, { ok: false, error: 'Invalid action type' });
      return;
    }
    try {
      const result = await this.invokeHandler('remoteControl.apply', { type });
      if (result?.ok === false) {
        this.sendJson(res, 400, { ok: false, error: result?.error || 'Failed to apply action' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to apply action' });
    }
  }

  // ==========================================================================
  // 消息操作：重试 / 删除 / 工具确认（全部复用桌面端消息管道）
  // ==========================================================================

  private async handleRetry(res: http.ServerResponse, body: any): Promise<void> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    if (!isSafeConversationId(conversationId)) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId' });
      return;
    }
    const configId = await this.resolveConfigId();
    if (!configId) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'No channel enabled. Configure a channel with a valid API key in settings first.'
      });
      return;
    }
    try {
      await this.runStream('retryStream', {
        conversationId,
        configId,
        streamId: `remote_${randomUUID()}`
      });
      this.sendJson(res, 200, { ok: true, started: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to retry' });
    }
  }

  private async handleDeleteMessage(res: http.ServerResponse, body: any): Promise<void> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    const targetIndex = body?.targetIndex;
    if (!isSafeConversationId(conversationId)
        || typeof targetIndex !== 'number' || !Number.isInteger(targetIndex)
        || targetIndex < 0 || targetIndex > 100_000) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId or targetIndex' });
      return;
    }
    try {
      await this.invokeHandler('deleteSingleMessage', { conversationId, targetIndex });
      this.sendJson(res, 200, { ok: true });
      this.notifyConversationsChanged();
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to delete message' });
    }
  }

  private async handleToolConfirm(res: http.ServerResponse, body: any): Promise<void> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    const toolResponses = Array.isArray(body?.toolResponses)
      ? body.toolResponses.filter(isSafeToolResponse).slice(0, MAX_TOOL_RESPONSES)
      : [];
    if (!isSafeConversationId(conversationId) || toolResponses.length === 0) {
      this.sendJson(res, 400, { ok: false, error: 'Invalid conversationId or toolResponses' });
      return;
    }
    const configId = await this.resolveConfigId();
    if (!configId) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'No channel enabled. Configure a channel with a valid API key in settings first.'
      });
      return;
    }
    try {
      await this.runStream('toolConfirmation', {
        conversationId,
        configId,
        toolResponses,
        streamId: `remote_${randomUUID()}`
      });
      this.sendJson(res, 200, { ok: true, started: true });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err?.message || 'Failed to confirm tool' });
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

  private broadcast(kind: 'message' | 'global' | 'workspace' | 'conversations', message: unknown): void {
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
