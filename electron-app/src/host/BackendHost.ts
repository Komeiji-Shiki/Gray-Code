/**
 * BackendHost.ts
 *
 * Standalone host for the GrayCode backend. Mirrors what ChatViewProvider did
 * inside VS Code:
 *
 *   1. Initialize all backend managers (settings, storage, conversation,
 *      channels, chat, MCP, memory, skills, dependencies...).
 *   2. Create the MessageRouter that maps frontend message types to handlers.
 *   3. Bridge messages between the Electron renderer and the router, exactly
 *      like `webview.postMessage` did in VS Code.
 *
 * The `vscode` import is resolved to electron-app/src/vscode-shim.ts by esbuild.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { Logger } from '../../../backend/core/logger';
import {
  ConversationManager,
  FileSystemStorageAdapter,
  FileUsageIndexStore,
  DiffStorageManager
} from '../../../backend/modules/conversation';
import { ConfigManager, MementoStorageAdapter } from '../../../backend/modules/config';
import { ChannelManager } from '../../../backend/modules/channel';
import { ChatHandler } from '../../../backend/modules/api/chat';
import { ModelsHandler } from '../../../backend/modules/api/models';
import { SettingsManager, VSCodeSettingsStorage, StoragePathManager } from '../../../backend/modules/settings';
import { SettingsHandler } from '../../../backend/modules/api/settings';
import { CheckpointManager } from '../../../backend/modules/checkpoint';
import { McpManager, VSCodeFileSystemMcpStorageAdapter } from '../../../backend/modules/mcp';
import { DependencyManager, type InstallProgressEvent } from '../../../backend/modules/dependencies';
import { toolRegistry, registerAllTools, onTerminalOutput, onImageGenOutput, TaskManager, setSubAgentExecutorContext } from '../../../backend/tools';
import type { TerminalOutputEvent, ImageGenOutputEvent, TaskEvent } from '../../../backend/tools';
import { createSkillsManager, getSkillsManager } from '../../../backend/modules/skills';
import { initMemoryManager } from '../../../backend/modules/memory';
import { ActivityTracker, setGlobalActivityTracker } from '../../../backend/modules/activity';
import { UpdateChecker } from '../../../backend/modules/update';
import { getProductVersion } from '../../../backend/core/productMetadata';
import { disposeActivityStatsCache } from '../../../webview/handlers/ActivityHandlers';
import { WindowsAgentStopNotificationService } from '../../../backend/modules/notifications/WindowsAgentStopNotificationService';
import {
  setGlobalSettingsManager,
  setGlobalConfigManager,
  setGlobalChannelManager,
  setGlobalToolRegistry,
  setGlobalDiffStorageManager,
  setGlobalMcpManager
} from '../../../backend/core/settingsContext';
import { MessageRouter } from '../../../webview/MessageRouter';
import { WebviewClientRegistry, WEBVIEW_CLIENT_IDS } from '../../../webview/runtime/WebviewClientRegistry';
import { StreamRequestHandler } from '../../../webview/stream/StreamRequestHandler';
import { createMessageHandlerRegistry } from '../../../webview/handlers';
import type { MessageHandler } from '../../../webview/types';
import { initializeSubAgentsFromSettings } from '../../../webview/handlers/SubAgentsHandlers';
import { WorkspaceManager, setWorkspaceManager } from '../../../webview/utils/WorkspaceManager';
import { SAVED_WORKSPACES_KEY } from '../../../webview/handlers/WorkspaceHandlers';
import type { HandlerContext } from '../../../webview/types';
import { getDiffManager, type PendingDiff, type FinalizedDiffInfo } from '../../../backend/core/services/diffManager';
import { warmUpShellAvailabilityCache } from '../../../backend/tools/terminal/execute_command';
import { subAgentRunEventBus } from '../../../backend/tools/subagents';
import { setGlobalStoragePath } from '../../../backend/core/settingsContext';
import { ElectronContext } from './ElectronContext';
import { SubAgentMonitorBridge } from './SubAgentMonitorBridge';
import { RemoteControlServer, REMOTE_CONTROL_CLIENT_ID } from '../../../backend/modules/remoteControl/RemoteControlServer';
import {
  __setHostBridge,
  __setWorkspaceFolders,
  __initConfigStore,
  __initMementoPaths,
  __resolveToast,
  Uri
} from '../vscode-shim.js';
import { menuLabel } from '../menu-i18n.js';

const log = Logger.get('BackendHost');

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

export interface BackendHostOptions {
  userDataPath: string;
  extensionPath: string;
  /** Post a message (response/error/command/streamChunk...) to the renderer. */
  postToRenderer: (message: any) => void;
  /** Native ops delegated to the Electron main process. */
  native: <T = any>(op: string, payload?: any) => Promise<T>;
  /** Called when the backend wants to open a diff preview in the renderer. */
  onOpenDiffPreview: (payload: any) => void;
  /** 渲染层上报 UI 语言切换后回调（主进程据此重建应用菜单文案）。 */
  onMenuLanguageChange?: (lang: string) => void;
  /** 系统 locale（如 app.getLocale()），用于界面语言为 auto/未配置时的文案回退。 */
  systemLocale?: () => string;
}

export class BackendHost {
  private context: ElectronContext;
  private initPromise: Promise<void>;

  private configManager!: ConfigManager;
  private channelManager!: ChannelManager;
  private conversationManager!: ConversationManager;
  private chatHandler!: ChatHandler;
  private modelsHandler!: ModelsHandler;
  private settingsManager!: SettingsManager;
  private settingsHandler!: SettingsHandler;
  private checkpointManager!: CheckpointManager;
  private mcpManager!: McpManager;
  private dependencyManager!: DependencyManager;
  private storagePathManager!: StoragePathManager;
  private diffStorageManager!: DiffStorageManager;
  private windowsAgentStopNotificationService?: WindowsAgentStopNotificationService;
  private activityTracker?: ActivityTracker;
  private updateChecker?: UpdateChecker;
  private updateCheckTimer?: NodeJS.Timeout;

  private messageRouter!: MessageRouter;
  private workspaceManager!: WorkspaceManager;
  private clientRegistry = new WebviewClientRegistry();
  /** 子代理 Monitor 内嵌面板桥（事件推送 + monitor 协议消息处理） */
  private subAgentMonitorBridge?: SubAgentMonitorBridge;
  /** 远程控制服务器（局域网 HTTP + 移动端 UI；设置开启时运行，否则不存在） */
  private remoteControlServer?: RemoteControlServer;
  /** 远程控制直连 handler 注册表（进程内直接调用，不经 MessageRouter） */
  private remoteRegistry!: Map<string, MessageHandler>;
  /** 远程控制专用流式处理器（与桌面端共享 StreamAbortManager；chunk 直投移动端 SSE） */
  private remoteStreamHandler!: StreamRequestHandler;
  /** 远程流式任务应答结算表（requestId → started/cancelled 应答） */
  private remoteStreamSettlers = new Map<string, {
    resolve: (data: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private messageHandlingQueue: Promise<void> = Promise.resolve();
  /**
   * 开场动画（Splash）完成信号：渲染层在动画淡出后（或用户关闭动画时立即）上报。
   * 「未打开工作区」/首启欢迎等启动提示必须等该信号再弹，避免弹窗盖在动画上。
   */
  private splashDoneReceived = false;
  /** 等待 splashDone 期间积压的提示队列（到达 splashDone/超时后统一补发） */
  private pendingAfterSplash: Array<() => void> = [];
  /** splashDone 兜底超时：渲染层异常未上报时也要保证提示最终可见 */
  private splashWaitTimer: NodeJS.Timeout | null = null;
  private static readonly SPLASH_WAIT_TIMEOUT_MS = 20_000;
  /**
   * settingsManager 就绪信号：initialize 第一步完成后 resolve。
   * getSettings 快速通道（Splash ready 信号）只等这个信号，不等完整 initPromise；
   * checkpoint/MCP/memory/activity/dependency 等后台初始化对设置响应无依赖。
   */
  private settingsReadyPromise!: Promise<void>;
  private resolveSettingsReady!: () => void;
  /** 启动阶段计时起点（GRAYCODE_DIAG=1 时输出各里程碑耗时，诊断用） */
  private readonly initStartedAt = performance.now();
  /** 单条消息处理超时：handler 卡死（挂起的工具调用/等待 toast 回复等）不应把整个串行队列冻结 */
  private static readonly MESSAGE_HANDLING_TIMEOUT_MS = 60_000;
  private unsubscribers: Array<() => void> = [];
  /** diff 预览内容缓存条目数上限：完整文件内容可能数百 KB，超限按插入序淘汰最旧条目防无界增长 */
  private static readonly MAX_DIFF_PREVIEW_CONTENTS_ENTRIES = 50;
  private diffPreviewContents = new Map<string, string>();
  private diffPreviewChangeEmitter = new EventEmitter();
  private diffPreviewProvider = {
    onDidChange: (listener: (uri: any) => void) => {
      this.diffPreviewChangeEmitter.on('change', listener);
      return { dispose: () => this.diffPreviewChangeEmitter.off('change', listener) };
    },
    setContent: (uri: string, content: string): void => {
      const prev = this.diffPreviewContents.get(uri);
      // 先删后设：被更新的条目移到 Map 末尾（最新位置），淘汰时优先保留最近使用的预览
      if (prev !== undefined) {
        this.diffPreviewContents.delete(uri);
      }
      this.diffPreviewContents.set(uri, content);
      if (this.diffPreviewContents.size > BackendHost.MAX_DIFF_PREVIEW_CONTENTS_ENTRIES) {
        const oldest = this.diffPreviewContents.keys().next().value;
        if (oldest !== undefined) {
          this.diffPreviewContents.delete(oldest);
        }
      }
      if (prev !== content) {
        this.diffPreviewChangeEmitter.emit('change', vscode.Uri.parse(uri));
      }
    },
    provideTextDocumentContent: (uri: any): string => {
      return this.diffPreviewContents.get(uri.toString()) || '';
    },
    dispose: (): void => {
      this.diffPreviewContents.clear();
    }
  };

  /** diff.openPreview interception: previewId -> toolId (diff session id) */
  private previewToSessionId = new Map<string, string>();
  /** toolId -> pending diffs [{ diffId, filePath }] (from diff.statusChanged) */
  private toolDiffIds = new Map<string, Array<{ diffId: string; filePath: string }>>();

  /** previewToSessionId 容量上限：键为每次 diff 的唯一 toolId/diffContentId，只增不删，
   *  长会话会无界增长；超出后淘汰最旧条目（旧预览早已不会再来 accept/reject） */
  private static readonly PREVIEW_SESSION_ID_MAX = 500;
  /** toolDiffIds 容量上限：键为 toolId，与 previewToSessionId 同源，超出后淘汰最旧条目 */
  private static readonly TOOL_DIFF_IDS_MAX = 500;

  private setPreviewSessionMapping(key: string, value: string): void {
    if (this.previewToSessionId.size >= BackendHost.PREVIEW_SESSION_ID_MAX) {
      const oldest = this.previewToSessionId.keys().next().value;
      if (oldest !== undefined) {
        this.previewToSessionId.delete(oldest);
      }
    }
    this.previewToSessionId.set(key, value);
  }

  constructor(private options: BackendHostOptions) {
    this.context = new ElectronContext({
      userDataPath: options.userDataPath,
      extensionPath: options.extensionPath
    });

    this.settingsReadyPromise = new Promise<void>((resolve) => {
      this.resolveSettingsReady = resolve;
    });

    // Wire the vscode shim to this host.
    __initConfigStore(path.join(this.context.globalStoragePath, 'settings', 'vscode-config.json'));
    __initMementoPaths(options.userDataPath);
    __setHostBridge({
      postCommand: (command, data) => this.postToRenderer('command', command, data),
      native: (op, payload) => this.options.native(op, payload),
      getWorkspaceFolders: () => [],
      onOpenDiffPreview: (payload) => this.options.onOpenDiffPreview(payload),
      resolveDiffSessionId: async (previewId, filePath) => {
        // Case 1: the preview id is already a diff session id (diff-...)
        if (previewId.startsWith('diff-')) {
          const direct = [...this.toolDiffIds.values()]
            .flat()
            .some((d) => d.diffId === previewId);
          if (direct) return previewId;
        }
        // Case 2: resolve via the tool call that created the preview.
        // The pending diff may still be mid-creation when the renderer opens
        // the preview (diff tools create the diff during execution), so poll
        // briefly instead of failing outright.
        const toolId = this.previewToSessionId.get(previewId) || previewId;
        const matchIn = (list: Array<{ diffId: string; filePath: string }> | undefined) => {
          if (!list || list.length === 0) return undefined;
          if (filePath) {
            const byPath = list.find(
              (d) => d.filePath === filePath || normalizePath(d.filePath) === normalizePath(filePath)
            );
            if (byPath) return byPath.diffId;
          }
          return list[0].diffId;
        };
        const find = (): string | undefined => {
          const cached = matchIn(this.toolDiffIds.get(toolId));
          if (cached) return cached;
          const live = matchIn(
            getDiffManager()
              .getPendingDiffs()
              .filter((d) => d.toolId === toolId)
              .map((d) => ({ diffId: d.id, filePath: d.filePath }))
          );
          return live;
        };
        const immediate = find();
        if (immediate) return immediate;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
          const found = find();
          if (found) return found;
        }
        return toolId;
      },
      resolveOriginalContent: async (previewId, filePath) => {
        const find = (): string | undefined => {
          const list = getDiffManager().getPendingDiffs();
          if (!list || list.length === 0) return undefined;
          const byId = list.find((d) => d.id === previewId);
          if (byId) return byId.originalContent;
          if (filePath) {
            const byPath = list.find(
              (d) => d.filePath === filePath || normalizePath(d.filePath) === normalizePath(filePath)
            );
            if (byPath) return byPath.originalContent;
          }
          return undefined;
        };
        const immediate = find();
        if (immediate !== undefined) return immediate;
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
          const found = find();
          if (found !== undefined) return found;
        }
        return undefined;
      },
      onOpenTextDocument: (uri) => {
        // open files in the OS (shell) - keep it simple
        void this.options.native('shell:openPath', { path: uri.fsPath || uri.path }).catch(() => undefined);
      }
    });

    this.initPromise = this.initialize().catch((err) => {
      console.error('[BackendHost] failed to initialize:', err);
      throw err;
    });
  }

  get ready(): Promise<void> {
    return this.initPromise;
  }

  /** SubAgent monitor window seam: conversation store for historical run restore. */
  getConversationStore(): ConversationManager {
    return this.conversationManager;
  }

  /** 子代理运行事件总线（与 monitor 桥同一单例，供诊断/测试注入事件） */
  getSubAgentRunEventBus() {
    return subAgentRunEventBus;
  }

  /** Register the sub-agent monitor webview client so routed responses reach it. */
  registerMonitorClient(
    runId?: string,
    conversationId?: string,
    sendTo?: (message: any) => void
  ): { dispose(): void } {
    return this.clientRegistry.register({
      clientId: WEBVIEW_CLIENT_IDS.subagentMonitor,
      runScope: runId
        ? { type: 'subagent', runId, parentConversationId: conversationId }
        : undefined,
      postMessage: (message) => {
        sendTo?.(message);
        return true;
      },
      isAlive: () => typeof sendTo === 'function'
    });
  }

  /**
   * Route a message originating from the sub-agent monitor window.
   * Responses are delivered through the WebviewClientRegistry (monitor client),
   * falling back to the main chat renderer when the client is not registered.
   */
  async routeMonitorMessage(message: any): Promise<boolean> {
    await this.initPromise;
    const { type, data, requestId } = message || {};
    if (!type) return false;
    const routedClientId = WEBVIEW_CLIENT_IDS.subagentMonitor;
    const ctx = this.createHandlerContext(requestId);
    const handled = await this.messageRouter.route(type, data, requestId, ctx, routedClientId);
    if (!handled && requestId) {
      const fallback = () =>
        this.postToRenderer('error', requestId, 'UNKNOWN_TYPE', `Unknown message type: ${type}`);
      if (!this.clientRegistry.sendError(routedClientId, requestId, 'UNKNOWN_TYPE', `Unknown message type: ${type}`)) {
        fallback();
      }
    }
    return handled;
  }

  getEffectiveDataPath(): string {
    return this.storagePathManager?.getEffectiveDataPath() ?? this.context.globalStoragePath;
  }

  async dispose(): Promise<void> {
    try {
      await this.initPromise;
    } catch {
      // ignore
    }
    // 远程控制：关闭 HTTP 服务器并清空流式应答（移动端 SSE 收到 bye 后自动重连失败）
    for (const entry of this.remoteStreamSettlers.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Backend host disposed'));
    }
    this.remoteStreamSettlers.clear();
    try {
      await this.remoteControlServer?.dispose();
    } catch {
      // ignore
    }
    this.remoteControlServer = undefined;
    if (this.updateCheckTimer) {
      clearTimeout(this.updateCheckTimer);
      this.updateCheckTimer = undefined;
    }
    this.messageRouter?.cancelAllStreams();
    TaskManager.cancelAllTasks();
    // 清空 diff 映射缓存：dispose 后不再引用旧条目（配合 diffManager 监听退订防泄漏）
    this.previewToSessionId.clear();
    this.toolDiffIds.clear();
    this.diffPreviewContents.clear();
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    setWorkspaceManager(null);
    this.workspaceManager?.dispose();
    try {
      this.mcpManager?.dispose();
    } catch {
      // ignore
    }
    try {
      this.subAgentMonitorBridge?.dispose();
    } catch {
      // ignore
    }
    try {
      getSkillsManager()?.dispose();
    } catch {
      // ignore
    }
    this.windowsAgentStopNotificationService?.dispose();
    // 释放使用时间统计：停止采样并落盘，清理全局引用与结果缓存（与 ChatViewProvider dispose 对齐）
    this.activityTracker?.dispose();
    this.activityTracker = undefined;
    setGlobalActivityTracker(null);
    disposeActivityStatsCache();
    // 排空 globalState/workspaceState 写队列：收藏工作区等 fire-and-forget 写入
    // 由调用方 await，这里兜底等待仍在队列中的落盘完成，退出后不丢数据。
    try {
      await this.context.flush();
    } catch {
      // ignore
    }
  }

  // ==========================================================================
  // Backend initialization (mirrors ChatViewProvider.initializeBackend)
  // ==========================================================================

  private async initialize(): Promise<void> {
    // Commands the backend may execute that have no VS Code equivalent.
    vscode.commands.registerCommand('graycode.openChat', () => undefined);
    vscode.commands.registerCommand('graycode.diff.acceptCurrentBlock', () => undefined);
    vscode.commands.registerCommand('graycode.diff.rejectCurrentBlock', () => undefined);
    // Diff preview content provider (read by the shim's `vscode.diff` command).
    vscode.workspace.registerTextDocumentContentProvider('graycode-diff-preview', this.diffPreviewProvider as any);

    const legacySettingsDir = path.join(this.context.globalStoragePath, 'settings');
    const settingsStorage = new VSCodeSettingsStorage({ legacySettingsDir });
    this.settingsManager = new SettingsManager(settingsStorage);
    await this.settingsManager.initialize();
    // settings 就绪即放行 getSettings 快速通道（Splash ready 不等完整后端初始化）
    this.resolveSettingsReady();
    this.markInitStage('settings-loaded');
    this.windowsAgentStopNotificationService = new WindowsAgentStopNotificationService({ settingsManager: this.settingsManager });

    this.storagePathManager = new StoragePathManager(this.settingsManager, this.context as any);
    await this.storagePathManager.ensureDirectories();

    const effectiveDataUri = this.storagePathManager.getEffectiveDataUri();
    const storageAdapter = new FileSystemStorageAdapter(vscode, effectiveDataUri);

    this.diffStorageManager = DiffStorageManager.initialize(this.storagePathManager.getEffectiveDataPath());
    setGlobalDiffStorageManager(this.diffStorageManager);

    this.conversationManager = new ConversationManager(
      storageAdapter,
      new FileUsageIndexStore(vscode, effectiveDataUri)
    );

    void storageAdapter.migrateLegacyConversationsToSegmented().then((result) => {
      log.info('conversation_migration.finished', {
        migrated: result.migrated,
        skipped: result.skipped,
        failedCount: result.failed.length
      });
    }).catch((error) => {
      log.warn('conversation_migration.background_failed', { error: error?.message || String(error) });
    });

    const configStorage = new MementoStorageAdapter(this.context.globalState, 'graycode.configs');
    this.configManager = new ConfigManager(configStorage);
    await this.ensureDefaultConfig();

    setGlobalSettingsManager(this.settingsManager);
    setGlobalConfigManager(this.configManager);
    setGlobalToolRegistry(toolRegistry);

    // 多工作区支持：激活工作区/列表变化广播到渲染进程（列表广播携带文件系统
    // 大小写口径：列表为空时前端只有平台默认值，列表就绪后口径随探测完成可能变化）
    // 激活工作区变化同时通知远程控制服务器：手机端切换工作区后必须立即收到
    // SSE workspace 事件刷新文件页与工作区条（否则手机显示旧工作区但文件操作
    // 已落到新工作区，状态与行为不一致）。
    this.workspaceManager = new WorkspaceManager({
        onActiveWorkspaceChanged: (uri) => {
          this.postToRenderer('message', 'workspaceUri', uri);
          this.remoteControlServer?.notifyWorkspaceChange();
        },
        onWorkspaceListChanged: (list) => this.postToRenderer('message', 'workspaceList', {
            workspaces: list,
            fsCaseSensitive: this.workspaceManager.getFsCaseSensitivity()
        })
    });
    setWorkspaceManager(this.workspaceManager);
    // 新增的工作区文件夹：项目技能立即重新扫描
    {
      const disposable = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const folder of event.added) {
          getSkillsManager()?.addWorkspacePath(folder.uri.fsPath);
        }
      });
      this.unsubscribers.push(() => disposable.dispose());
    }

    await createSkillsManager({
        workspacePaths: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
        globalStoragePath: this.storagePathManager.getEffectiveDataPath()
    });
    await this.syncSkillsState();

    // shell 可用性磁盘缓存预热：registerAllTools 内 createExecuteCommandTool
    // 会对所有启用 shell 做同步 spawn 探测（wsl --status 最坏阻塞 3s），
    // 预热使探测命中 24h 磁盘缓存，冷启动免 spawn（无缓存时退化为原行为）。
    setGlobalStoragePath(this.storagePathManager.getEffectiveDataPath());
    warmUpShellAvailabilityCache();
    registerAllTools(toolRegistry);
    this.markInitStage('tools-registered');

    this.channelManager = new ChannelManager(this.configManager, toolRegistry, this.settingsManager);
    this.channelManager.setRetryStatusCallback((status) => {
      this.postToRenderer('message', 'retryStatus', status);
    });
    setGlobalChannelManager(this.channelManager);

    this.checkpointManager = new CheckpointManager(
      this.settingsManager,
      this.conversationManager,
      this.context as any,
      this.storagePathManager.getEffectiveDataPath()
    );

    // ===== 启动并行化：以下初始化互不依赖（只依赖上文已就绪的
    // settings/storage/conversation/config），串行执行在慢盘上可达数百 ms，
    // 并行后冷启动时间显著下降。MCP 自动连接本身已 fire-and-forget。 =====
    const mcpConfigDir = this.storagePathManager.getMcpPath();
    const mcpStorage = new VSCodeFileSystemMcpStorageAdapter(
      vscode.Uri.file(path.join(mcpConfigDir, 'servers.json')),
      vscode.workspace.fs
    );
    this.mcpManager = new McpManager(mcpStorage);

    await Promise.all([
      this.checkpointManager.initialize(),
      this.mcpManager.initialize(),
      initMemoryManager(this.storagePathManager.getEffectiveDataPath()),
      // 使用时间统计追踪器（与 ChatViewProvider 25.65 对齐）：心跳 + 用户活动事件按天采样落盘。
      // 桌面端无编辑器事件，采样依赖窗口焦点桥接（main.ts focus/blur → __setWindowFocused）与心跳。
      (async () => {
        this.activityTracker = new ActivityTracker(
          path.join(this.storagePathManager.getEffectiveDataPath(), 'activity')
        );
        this.activityTracker.start();
        setGlobalActivityTracker(this.activityTracker);
      })(),
      (async () => {
        this.dependencyManager = DependencyManager.getInstance(this.context as any, this.storagePathManager.getDependenciesPath());
        await this.dependencyManager.initialize();
        toolRegistry.setDependencyChecker({
          isInstalled: (name: string) => this.dependencyManager.isInstalledSync(name)
        });
        this.unsubscribers.push(
          this.dependencyManager.onProgress((event: InstallProgressEvent) => this.postToRenderer('message', 'dependencyProgress', event))
        );
      })()
    ]);

    this.chatHandler = new ChatHandler(this.configManager, this.channelManager, this.conversationManager, toolRegistry);
    this.chatHandler.setCheckpointManager(this.checkpointManager);
    this.chatHandler.setSettingsManager(this.settingsManager);

    this.modelsHandler = new ModelsHandler(this.configManager, this.settingsManager);

    this.settingsHandler = new SettingsHandler(this.settingsManager, toolRegistry);
    this.settingsHandler.setConversationManager(this.conversationManager);

    this.unsubscribers.push(
      onTerminalOutput((event: TerminalOutputEvent) => this.postToRenderer('message', 'terminalOutput', event)),
      onImageGenOutput((event: ImageGenOutputEvent) => this.postToRenderer('message', 'imageGenOutput', event)),
      TaskManager.onTaskEvent((event: TaskEvent) => this.postToRenderer('message', 'taskEvent', event))
    );

    this.channelManager.setMcpManager(this.mcpManager);
    this.chatHandler.setMcpManager(this.mcpManager);
    setGlobalMcpManager(this.mcpManager);

    setSubAgentExecutorContext({
      channelManager: this.channelManager,
      toolRegistry,
      mcpManager: this.mcpManager,
      settingsManager: this.settingsManager,
      configManager: this.configManager,
      toolExecutionService: this.chatHandler.getToolExecutionService()
    });

    // Diff status changes -> frontend (pending diff bar / countdown)
    // 退订函数入 unsubscribers：dispose 时移除，避免模块级 diffManager 持闭包引用泄漏
    const diffStatusListener = (
      pendingDiffs: PendingDiff[],
      allProcessed: boolean,
      finalized: FinalizedDiffInfo[] = []
    ) => {
      // track toolId -> diff ids so the renderer diff modal can accept/reject
      this.toolDiffIds.clear();
      for (const d of pendingDiffs) {
        if (d.toolId) {
          const list = this.toolDiffIds.get(d.toolId) || [];
          list.push({ diffId: d.id, filePath: d.filePath });
          this.toolDiffIds.set(d.toolId, list);
        }
      }
      while (this.toolDiffIds.size > BackendHost.TOOL_DIFF_IDS_MAX) {
        const oldest = this.toolDiffIds.keys().next().value;
        if (oldest === undefined) break;
        this.toolDiffIds.delete(oldest);
      }
      // 注意：前端经 onExtensionCommand / App.vue 只消费 { type: 'command', command: 'diff.statusChanged' }，
      // 必须用 'command' 类型推送（与 webview/ChatViewProvider.sendCommand 一致），
      // 否则桌面版变更面板的条目状态同步与删除警戒提示失效。
      this.postToRenderer('command', 'diff.statusChanged', {
        pendingDiffs: pendingDiffs.map((d) => ({
          id: d.id,
          status: d.status,
          filePath: d.filePath,
          toolId: d.toolId,
          diffGuardWarning: d.diffGuardWarning,
          diffGuardDeletePercent: d.diffGuardDeletePercent
        })),
        // 最近终结 diff 的终态：前端据此把已自动应用/取消、从 pending 列表消失的
        // 条目结算为 accepted/rejected，否则面板接受/拒绝按钮残留。
        finalized: finalized.map((d) => ({ id: d.id, status: d.status })),
        allProcessed
      });
    };
    getDiffManager().addStatusListener(diffStatusListener);
    this.unsubscribers.push(() => getDiffManager().removeStatusListener(diffStatusListener));

    this.messageRouter = new MessageRouter(
      this.chatHandler,
      this.conversationManager,
      this.settingsManager,
      // 流式 chunk 按 clientId 路由：注册表中有 webviewHost 的客户端（主聊天/远程控制）
      // 直接投递；无 webviewHost 的客户端（monitor 等仅 postMessage 型）回退主聊天视图，
      // 与历史行为一致。
      (clientId) => {
        if (clientId) {
          const client = this.clientRegistry.get(clientId);
          if (client && client.webviewHost) {
            return client.webviewHost;
          }
        }
        return { webview: this.fakeWebviewForClient(undefined) };
      },
      (requestId, data) => this.postToRenderer('response', requestId, data),
      (requestId, code, message) => this.postToRenderer('error', requestId, code, message),
      this.clientRegistry
    );
    // 远程控制直连注册表：与 MessageRouter 同一批 handler 函数（同一业务逻辑），
    // 但由远控端进程内直接调用，不经 MessageRouter 路由层（V2 去虚拟化）。
    this.remoteRegistry = createMessageHandlerRegistry();

    // 子代理 Monitor 内嵌面板桥：订阅 run 事件总线并向主窗口渲染进程推送
    this.subAgentMonitorBridge = new SubAgentMonitorBridge({
      routeMonitorMessage: (message) => this.routeMonitorMessage(message),
      registerMonitorClient: (runId, conversationId, sendTo) =>
        this.registerMonitorClient(runId, conversationId, sendTo),
      getConversationStore: () => this.conversationManager,
      postToRenderer: (message) => this.options.postToRenderer(message)
    });

    this.registerMainChatClient();

    // 远程控制服务器：V2 去虚拟化直连。
    // - 非流式操作：invokeHandler 进程内直接调用 webview handler 函数（sendResponse/
    //   sendError 直接 resolve/reject），不经 MessageRouter/虚拟客户端/序列化往返；
    // - 流式操作：独立装配的远程流 StreamRequestHandler 直连执行（与桌面端共享同一
    //   StreamAbortManager 实例，移动端停止与桌面端取消共用同一取消控制器），
    //   chunk 经 getClientView 直投移动端 SSE；
    // - 不再把远控端注册进 WebviewClientRegistry（无虚拟 webview 客户端）。
    this.remoteStreamHandler = new StreamRequestHandler({
      chatHandler: this.chatHandler,
      abortManager: this.messageRouter.getAbortManager(),
      conversationManager: this.conversationManager,
      // chunk 直投移动端 SSE（onClientMessage → broadcast('message')）
      getClientView: () => ({
        webview: {
          postMessage: (message: any) => this.remoteControlServer?.onClientMessage(message) ?? true
        }
      }) as any,
      // started/cancelled 应答直接结算 runStream 的等待方
      sendResponse: (requestId, data) => {
        const entry = this.remoteStreamSettlers.get(requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.remoteStreamSettlers.delete(requestId);
          entry.resolve(data);
        }
      },
      sendError: (requestId, code, message) => {
        const entry = this.remoteStreamSettlers.get(requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.remoteStreamSettlers.delete(requestId);
          entry.reject(new Error(message || code));
        }
      },
      finalizeRequest: () => {
        // 流结束无需额外清理（settlers 已在 sendResponse/sendError 结算或超时摘除）
      }
    });
    this.remoteControlServer = new RemoteControlServer({
      getSettings: () => this.settingsManager.getSettings() as any,
      getUiLanguage: () => this.resolveToastLanguage(),
      getAppVersion: () => getProductVersion(),
      getWorkspaceSnapshot: () => {
        const workspaceUri = this.workspaceManager ? this.workspaceManager.getActiveWorkspaceUri() : null;
        let activeFilePath: string | null = null;
        try {
          const editor = vscode.window.activeTextEditor;
          if (editor && !editor.document.isUntitled) {
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (folder) {
              activeFilePath = vscode.workspace.asRelativePath(editor.document.uri, false) || null;
            }
          }
        } catch {
          // 活动编辑器读取失败：快照降级为仅工作区
        }
        return { workspaceUri, activeFilePath };
      },
      // 直连非流式 handler：进程内执行，响应直接 resolve（无 pending 表/虚拟客户端）
      invokeHandler: (type, data) => {
        const requestId = `remote_${randomUUID()}`;
        const handler = this.remoteRegistry.get(type);
        if (!handler) {
          return Promise.reject(new Error(`Unknown handler: ${type}`));
        }
        const ctx = {
          ...this.createHandlerContext(requestId),
          clientId: REMOTE_CONTROL_CLIENT_ID,
          // 流式 handler（reroll/editBranch 等）经 ctx.postMessage 转发 chunk → SSE
          postMessage: (message: any) => {
            this.remoteControlServer?.onClientMessage(message);
            return true;
          }
        };
        return new Promise<any>((resolve, reject) => {
          // 超时兜底：openFolder 等原生对话框请求可等待用户操作；60s 上限防移动端挂死
          const timer = setTimeout(() => {
            reject(new Error(`Request timed out: ${type}`));
          }, 60_000);
          const directCtx = {
            ...ctx,
            sendResponse: (id: string, respondData: any): void => {
              clearTimeout(timer);
              resolve(respondData);
            },
            sendError: (id: string, code: string, message: string): void => {
              clearTimeout(timer);
              reject(new Error(message || code));
            }
          };
          Promise.resolve(handler(data, requestId, directCtx)).catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
      },
      // 直连流式任务：注册应答结算 → 启动远程流；chunk 经 remoteStreamHandler 直投 SSE
      runStream: (type, data) => {
        const requestId = `remote_${randomUUID()}`;
        const payload = (data ?? {}) as Record<string, any>;
        return new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.remoteStreamSettlers.delete(requestId);
            reject(new Error(`Stream start timed out: ${type}`));
          }, 20_000);
          this.remoteStreamSettlers.set(requestId, { resolve, reject, timer });
          try {
            switch (type) {
              case 'chatStream':
                this.remoteStreamHandler.handleChatStream(payload, requestId, REMOTE_CONTROL_CLIENT_ID);
                break;
              case 'retryStream':
                this.remoteStreamHandler.handleRetryStream(payload, requestId, REMOTE_CONTROL_CLIENT_ID);
                break;
              case 'toolConfirmation':
                this.remoteStreamHandler.handleToolConfirmationStream(payload, requestId, REMOTE_CONTROL_CLIENT_ID);
                break;
              case 'cancelStream': {
                const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
                // cancelStream 是 async：非法 conversationId 会抛错，需兜底结算（HTTP 面已前置校验，纯防御）
                void Promise.resolve(
                  this.remoteStreamHandler.cancelStream(conversationId, requestId, {
                    preserveSubAgents: payload.preserveSubAgents === true
                  })
                ).catch((err) => {
                  const entry = this.remoteStreamSettlers.get(requestId);
                  if (entry) {
                    clearTimeout(entry.timer);
                    this.remoteStreamSettlers.delete(requestId);
                    entry.reject(err instanceof Error ? err : new Error(String(err)));
                  }
                });
                break;
              }
              default:
                clearTimeout(timer);
                this.remoteStreamSettlers.delete(requestId);
                reject(new Error(`Unknown stream type: ${type}`));
            }
          } catch (err) {
            const entry = this.remoteStreamSettlers.get(requestId);
            if (entry) {
              clearTimeout(entry.timer);
              this.remoteStreamSettlers.delete(requestId);
              entry.reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        });
      },
      conversationManager: this.conversationManager as any,
      configManager: this.configManager as any,
      // 会话变更 → 桌面端最近对话列表实时刷新（远端创建/改名/删除后不再需要重启）
      notifyConversationsChanged: () => {
        try {
          this.postToRenderer('message', 'conversationsChanged', { changed: true });
        } catch (err) {
          console.error('[BackendHost] conversationsChanged broadcast failed:', err);
        }
      }
    });
    // 设置变更（开关/端口）→ 启停/重启服务器；初始化完成后再同步一次兜底。
    // 监听器加入 unsubscribers：dispose 时退订，避免闭包引用 remoteControlServer 泄漏。
    {
      const listener = (event: any): void => {
        if (event.type === 'remoteControl' || event.type === 'full') {
          this.remoteControlServer?.syncFromSettings();
        }
      };
      this.settingsManager.addChangeListener(listener);
      this.unsubscribers.push(() => this.settingsManager.removeChangeListener(listener));
    }
    this.remoteControlServer.syncFromSettings();

    // 桌面端活动编辑器/工作区变化 → 手机端 SSE workspace 事件（远程控制开启时镜像）
    {
      const editorListener = vscode.window.onDidChangeActiveTextEditor(() => {
        this.remoteControlServer?.notifyWorkspaceChange();
      });
      this.unsubscribers.push(() => editorListener.dispose());
      const foldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.remoteControlServer?.notifyWorkspaceChange();
      });
      this.unsubscribers.push(() => foldersListener.dispose());
    }

    // Sub-agents registry from persisted settings
    initializeSubAgentsFromSettings(this.createHandlerContext(''));

    // 窗口焦点状态 → 前端音效控制器（聚焦时不播放提示音；失焦才播）
    const pushWindowFocus = (focused: boolean) => {
      this.postToRenderer('command', 'windowFocusChanged', { focused: !!focused });
    };
    pushWindowFocus(vscode.window.state.focused);
    const focusDisposable = vscode.window.onDidChangeWindowState((state) => pushWindowFocus(state.focused));
    this.unsubscribers.push(() => focusDisposable.dispose());

    // GitHub Releases 自动更新检查（与 ChatViewProvider 对齐：设置项开关 + 代理 + 10s 延迟首查）
    this.updateChecker = new UpdateChecker({
      isCheckEnabled: () => this.settingsManager.getSettings().checkForUpdates !== false,
      getInstallerKind: () => (process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed'),
      getProxyUrl: () => {
        const proxy = this.settingsManager.getSettings().proxy;
        return proxy?.enabled && proxy?.url ? proxy.url : undefined;
      },
      storage: {
        get: (key) => this.context.globalState.get<number>(key),
        update: (key, value) => Promise.resolve(this.context.globalState.update(key, value))
      },
      globalStoragePath: this.storagePathManager.getEffectiveDataPath()
    });
    this.updateCheckTimer = setTimeout(() => {
      this.updateChecker?.check(false).catch(() => {});
    }, 10_000);

    log.info('backend_initialized', { effectiveDataPath: this.storagePathManager.getEffectiveDataPath() });
    this.markInitStage('backend-initialized');
  }

  /** GRAYCODE_DIAG=1 时输出启动里程碑耗时（主进程 stdout，诊断用） */
  private markInitStage(stage: string): void {
    if (process.env.GRAYCODE_DIAG === '1') {
      console.log(`[startup] backend ${stage} at +${Math.round(performance.now() - this.initStartedAt)}ms`);
    }
  }

  private getWorkspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.uri.fsPath;
  }

  private async ensureDefaultConfig(): Promise<void> {
    try {
      const existingConfig = await this.configManager.getConfig('gemini-pro');
      if (!existingConfig) {
        const storage = (this.configManager as any).storageAdapter;
        await storage.save({
          id: 'gemini-default',
          type: 'gemini' as const,
          name: 'Gemini(Default)',
          apiKey: 'YOUR_API_KEY_HERE',
          url: 'https://generativelanguage.googleapis.com/v1beta',
          model: 'gemini-3-pro-preview',
          timeout: 120000,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        (this.configManager as any).loaded = false;
      }
    } catch (error) {
      console.error('Failed to create default config:', error);
    }
  }

  private async syncSkillsState(): Promise<void> {
    try {
      const skillsManager = getSkillsManager();
      if (!skillsManager) return;
      const savedConfig = this.settingsManager.getSkillsConfig() || { skills: [] };
      const savedSkillIds = new Set(savedConfig.skills.map((s) => s.id));
      for (const savedSkill of savedConfig.skills) {
        if (savedSkill.enabled) {
          skillsManager.enableSkill(savedSkill.id);
        } else {
          skillsManager.disableSkill(savedSkill.id);
        }
      }
      for (const skill of skillsManager.getAllSkills()) {
        if (!savedSkillIds.has(skill.id)) {
          skillsManager.enableSkill(skill.id);
        }
      }
    } catch (error) {
      console.error('[BackendHost] Failed to sync skills state:', error);
    }
  }

  // ==========================================================================
  // Message routing
  // ==========================================================================

  private fakeWebviewForClient(_clientId?: string): any {
    return {
      postMessage: (message: any) => {
        this.postToRenderer('raw', message);
        // 桌面端自身会话的流式输出镜像转发给移动端（远程控制开启时）。
        // 放在 fakeWebviewForClient 而非 main-chat 客户端注册的 postMessage：
        // 流式 chunk 由 StreamChunkProcessor 经 webviewHost.webview.postMessage
        // 投递（不走注册表级 postMessage），挂在注册回调上是死代码。
        this.remoteControlServer?.onGlobalMessage(message);
      }
    };
  }

  private registerMainChatClient(): void {
    this.clientRegistry.register({
      clientId: WEBVIEW_CLIENT_IDS.mainChat,
      runScope: { type: 'conversation', conversationId: 'main-chat' } as any,
      webviewHost: { webview: this.fakeWebviewForClient() } as any,
      postMessage: (message) => {
        this.postToRenderer('raw', message);
        return true;
      },
      isAlive: () => true
    });
  }

  private postToRenderer(kind: 'response' | 'error' | 'command' | 'message' | 'raw', ...args: any[]): void {
    let message: any;
    if (kind === 'response') {
      message = { type: 'response', requestId: args[0], success: true, data: args[1] };
    } else if (kind === 'error') {
      message = { type: 'error', requestId: args[0], success: false, error: { code: args[1], message: args[2] } };
    } else if (kind === 'command') {
      message = { type: 'command', command: args[0], data: args[1] };
    } else if (kind === 'message') {
      message = { type: args[0], data: args[1] };
    } else {
      message = args[0];
    }
    try {
      this.options.postToRenderer(message);
    } catch (err) {
      console.error('[BackendHost] postToRenderer failed:', err);
    }
  }

  private createHandlerContext(requestId: string): HandlerContext {
    return {
      context: this.context as any,
      clientId: WEBVIEW_CLIENT_IDS.mainChat,
      configManager: this.configManager,
      channelManager: this.channelManager,
      conversationManager: this.conversationManager,
      chatHandler: this.chatHandler,
      modelsHandler: this.modelsHandler,
      settingsManager: this.settingsManager,
      settingsHandler: this.settingsHandler,
      checkpointManager: this.checkpointManager,
      mcpManager: this.mcpManager,
      dependencyManager: this.dependencyManager,
      storagePathManager: this.storagePathManager,
      diffStorageManager: this.diffStorageManager,
      windowsAgentStopNotificationService: this.windowsAgentStopNotificationService,
      updateChecker: this.updateChecker,
      streamAbortControllers: this.messageRouter.getAbortManager() as any,
      diffPreviewProvider: this.diffPreviewProvider,
      sendResponse: (id, data) => this.postToRenderer('response', id, data),
      sendError: (id, code, message) => this.postToRenderer('error', id, code, message),
      postMessage: (message: any) => this.postToRenderer('raw', message),
      getCurrentWorkspaceUri: () => {
        return this.workspaceManager ? this.workspaceManager.getActiveWorkspaceUri() : null;
      },
      openSubAgentMonitor: (runId?: string, conversationId?: string) => {
        // 内嵌面板方案：更新桥的焦点并通知前端打开面板（不再打开独立窗口）
        this.subAgentMonitorBridge?.openRun(runId, conversationId);
        this.postToRenderer('command', 'host.openSubAgentMonitor', {
          runId,
          conversationId
        });
      },
      remoteControlStatus: () => this.remoteControlServer?.getStatus() ?? {
        available: false,
        enabled: false,
        port: 17532,
        running: false
      },
      remoteControlApply: (action) => {
        if (!this.remoteControlServer) {
          return { ok: false, error: 'Remote control server not available' };
        }
        this.remoteControlServer.apply(action);
        return { ok: true };
      }
    };
  }

  /**
   * Handle a message from the renderer (same semantics as ChatViewProvider.handleMessage).
   */
  async handleRendererMessage(message: any): Promise<void> {
    const { type, data, requestId, clientId } = message || {};
    if (typeof type !== 'string') return;

    // 内嵌 SubAgent Monitor 面板的消息：带 subagent-monitor clientId（兼容不带 clientId
    // 但使用 monitor 专属协议类型的旧前端），统一交给桥处理（monitorReady/getRunWindow/
    // setVisible 由桥直接应答，其余经 routeMonitorMessage 走统一 MessageRouter）。
    const isMonitorMessage =
      clientId === WEBVIEW_CLIENT_IDS.subagentMonitor ||
      type === 'subagents.monitorReady' ||
      type === 'subagents.monitor.getRunWindow' ||
      type === 'subagents.monitor.setVisible';
    if (isMonitorMessage && this.subAgentMonitorBridge) {
      void this.subAgentMonitorBridge.handleMessage(message).catch((err) => {
        console.error('[BackendHost] sub-agent monitor message error:', err);
        if (requestId) {
          this.postToRenderer('error', requestId, 'SUBAGENT_MONITOR_HANDLER_ERROR', String(err));
        }
      });
      return;
    }

    // webviewReady handshake from the frontend
    if (type === 'webviewReady') {
      this.postToRenderer('response', requestId || 'webviewReady', { success: true });
      // If no workspace is open (e.g. a previously saved folder was deleted),
      // surface a hint - but only after the intro animation (Splash) finishes:
      // the renderer reports splashDone when the animation is done (or when the
      // animation is disabled), so the toast never overlaps the animation.
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        this.postWhenSplashDone(() => this.maybeShowNoWorkspaceToast());
      }
      // First-run onboarding: if no channel has a real API key configured yet,
      // nudge the user to set one up (the backend seeds a placeholder default).
      this.checkFirstRunOnboarding();
      return;
    }

    // 开场动画完成信号（渲染层在 Splash 淡出后 / 动画关闭时上报）：
    // 放行积压的启动提示（未打开工作区等），保证提示在动画结束后才出现。
    if (type === 'splashDone') {
      this.postToRenderer('response', requestId || 'splashDone', { success: true });
      this.flushPendingAfterSplash();
      return;
    }

    // 渲染层 UI 语言生效（含 auto 解析后）上报：主进程重建应用菜单文案。
    if (type === 'app.setMenuLanguage') {
      this.postToRenderer('response', requestId || 'app.setMenuLanguage', { success: true });
      try {
        this.options.onMenuLanguageChange?.(typeof data?.lang === 'string' ? data.lang : '');
      } catch (err) {
        console.error('[BackendHost] menu language change callback error:', err);
      }
      return;
    }

    // getSettings 快速通道：只依赖 settingsManager（initialize 第一步即就绪），
    // 不必排队等完整 initPromise——前端 Splash ready 信号（languageLoaded）由此提前，
    // 用户在 checkpoint/MCP/memory/activity/dependency 等后台初始化完成前即可退出
    // 启动画面；其余消息仍走下方队列等 initPromise。响应形状与
    // SettingsHandlers.getSettings（{ success, settings }）完全一致。
    if (type === 'getSettings') {
      const respond = (): void => {
        try {
          const settings = this.settingsManager.getSettings();
          this.postToRenderer('response', requestId || 'getSettings', { success: true, settings });
        } catch (error: any) {
          // 与 webview 路径（settingsHandlerBoundary → ctx.sendError）同一错误形态：
          // 外层 { type:'error', success:false, error:{ code, message } }，前端走 catch
          this.postToRenderer('error', requestId || 'getSettings', error?.code || 'GET_SETTINGS_ERROR', error?.message || String(error));
        }
      };
      // settingsManager 初始化异常（损坏设置文件等）时 settingsReadyPromise 永不 resolve：
      // 给 30s 兜底超时按错误应答，避免前端挂到 180s sendToExtension 兜底（F-4 失败路径退化）
      const timeout = setTimeout(respond, 30_000);
      void this.settingsReadyPromise
        .then(() => {
          clearTimeout(timeout);
          respond();
        })
        .catch((err) => {
          clearTimeout(timeout);
          console.error('[BackendHost] getSettings fast-path error:', err);
          this.postToRenderer('error', requestId || 'getSettings', 'GET_SETTINGS_ERROR', err?.message || String(err));
        });
      return;
    }

    // 前端上报桌面端激活会话（远程控制移动端默认跟随电脑当前会话）
    if (type === 'remoteControl.reportActiveConversation') {
      const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : null;
      this.remoteControlServer?.setActiveConversation(conversationId);
      this.postToRenderer('response', requestId || 'remoteControl.reportActiveConversation', { success: true });
      return;
    }

    // Toast / quick-pick / input-box replies from the renderer UI
    if (type === 'host.toastReply') {
      __resolveToast(Number(data?.id), data?.selected);
      return;
    }

    // Intercept diff.openPreview to record previewId -> toolId mapping so the
    // renderer diff modal can call diff.accept/diff.reject with the session id.
    if (type === 'diff.openPreview') {
      try {
        const toolId = typeof data?.toolId === 'string' ? data.toolId : '';
        if (toolId) {
          this.setPreviewSessionMapping(toolId, toolId);
          const resultData = data?.result?.data as Record<string, any> | undefined;
          const diffContentId = typeof resultData?.diffContentId === 'string' ? resultData.diffContentId : '';
          if (diffContentId) {
            this.setPreviewSessionMapping(diffContentId, toolId);
          }
          const results = resultData?.results;
          if (Array.isArray(results)) {
            for (const r of results) {
              if (typeof r?.diffContentId === 'string') {
                this.setPreviewSessionMapping(r.diffContentId, toolId);
              }
            }
          }
        }
      } catch (err) {
        console.error('[BackendHost] diff.openPreview intercept failed:', err);
      }
    }

    this.messageHandlingQueue = this.messageHandlingQueue
      .then(() => this.handleWithTimeout(this.routeMessage(message), message?.requestId))
      .catch((err) => console.error('[BackendHost] message handling error:', err));
  }

  /** 给单个消息处理加超时：超时对该请求回 error（格式与 routeMessage 的错误响应一致），
   *  并放行队列让后续消息继续处理，避免一条卡死的 handler 永久冻结 IPC 通道。 */
  private async handleWithTimeout(work: Promise<void>, requestId?: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error('[BackendHost] message handling timed out:', requestId);
        if (requestId) {
          this.postToRenderer(
            'error',
            requestId,
            'HANDLER_TIMEOUT',
            'Message handler timed out (60s); the request has been dropped.'
          );
        }
        resolve();
      }, BackendHost.MESSAGE_HANDLING_TIMEOUT_MS);
    });
    try {
      await Promise.race([work, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * First-run onboarding: when no channel has a real API key yet, push a
   * welcome command so the renderer can guide the user to configure one.
   * 只显示一次：标记持久化到 globalState，重启/重复握手不再弹出。
   * 弹窗同样等开场动画结束（postWhenSplashDone），避免盖在动画上。
   */
  private checkFirstRunOnboarding(): void {
    void (async () => {
      try {
        await this.initPromise;
        if (this.context.globalState.get<boolean>('graycode.onboardingSeen') === true) {
          return;
        }
        const configs = await this.configManager.listConfigs();
        const placeholderKey = new Set(['', 'YOUR_API_KEY_HERE', 'YOUR_API_KEY']);
        const hasRealKey = configs.some(
          (c) => c.enabled && typeof c.apiKey === 'string' && !placeholderKey.has(c.apiKey.trim())
        );
        if (hasRealKey) {
          // 用户已经配置过真实 Key，同样视为引导完成，不再弹出
          await this.context.globalState.update('graycode.onboardingSeen', true);
          return;
        }
        const message = menuLabel('firstRunMessage', this.resolveToastLanguage());
        this.postWhenSplashDone(() => {
          this.postToRenderer('command', 'host.firstRun', {
            title: menuLabel('firstRunTitle', this.resolveToastLanguage()),
            message,
            openSettingsLabel: menuLabel('openSettingsBtn', this.resolveToastLanguage()),
            openFolderLabel: menuLabel('openFolderBtn', this.resolveToastLanguage())
          });
        });
        await this.context.globalState.update('graycode.onboardingSeen', true);
      } catch (err) {
        console.error('[BackendHost] first-run check failed:', err);
      }
    })();
  }

  /**
   * 开场动画门控：动画未结束时把 fn 积压到 splashDone 到达后补发；
   * 超时（渲染层异常未上报）则按可见性兜底直接放行。
   */
  private postWhenSplashDone(fn: () => void): void {
    if (this.splashDoneReceived) {
      try {
        fn();
      } catch (err) {
        console.error('[BackendHost] splash-gated toast failed:', err);
      }
      return;
    }
    this.pendingAfterSplash.push(fn);
    if (this.splashWaitTimer === null) {
      this.splashWaitTimer = setTimeout(() => {
        this.flushPendingAfterSplash();
      }, BackendHost.SPLASH_WAIT_TIMEOUT_MS);
    }
  }

  private flushPendingAfterSplash(): void {
    if (this.splashWaitTimer !== null) {
      clearTimeout(this.splashWaitTimer);
      this.splashWaitTimer = null;
    }
    if (this.splashDoneReceived && this.pendingAfterSplash.length === 0) return;
    this.splashDoneReceived = true;
    const queue = this.pendingAfterSplash.splice(0);
    for (const fn of queue) {
      try {
        fn();
      } catch (err) {
        console.error('[BackendHost] splash-gated toast failed:', err);
      }
    }
  }

  /** 启动提示文案语言：设置项优先，auto/未配置时回退主进程注入的系统 locale */
  private resolveToastLanguage(): string {
    try {
      const language = this.settingsManager.getSettings()?.ui?.language;
      if (language && language !== 'auto') return language;
    } catch {
      // settings 尚未就绪/损坏：回退系统 locale
    }
    try {
      return this.options.systemLocale?.() ?? '';
    } catch {
      return '';
    }
  }

  /** 工作区行为（启动恢复策略）：'restore'（恢复上次）/ 'none'（不打开任何工作区） */
  getWorkspaceBehavior(): 'restore' | 'none' {
    try {
      const behavior = this.settingsManager.getSettings()?.ui?.workspaceBehavior;
      if (behavior === 'none' || behavior === 'restore') return behavior;
    } catch {
      // 设置未就绪：按默认恢复策略处理
    }
    return 'restore';
  }

  /**
   * 「未打开工作区」启动提示：
   * - 工作区行为为 'none' 时不提示（用户显式选择不打开）
   * - 发送时重查工作区列表：主进程的启动恢复（setWorkspaceFolders）可能已先行完成，
   *   此时不应再提示
   * - 文案按当前界面语言本地化
   */
  private maybeShowNoWorkspaceToast(): void {
    try {
      const behavior = this.getWorkspaceBehavior();
      if (behavior === 'none') return;
    } catch {
      // 设置读取失败：按默认行为继续
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return;
    const lang = this.resolveToastLanguage();
    this.postToRenderer('command', 'host.noWorkspace', {
      title: menuLabel('noWorkspaceTitle', lang),
      message: menuLabel('noWorkspaceMessage', lang),
      openFolderLabel: menuLabel('openFolderBtn', lang)
    });
  }

  private async routeMessage(message: any): Promise<void> {
    const { type, data, requestId } = message;
    try {
      await this.initPromise;
      const ctx = { ...this.createHandlerContext(requestId) };
      const handled = await this.messageRouter.route(type, data, requestId, ctx, ctx.clientId);
      if (!handled) {
        console.warn('[BackendHost] unknown message type:', type);
        this.postToRenderer('error', requestId, 'UNKNOWN_TYPE', `Unknown message type: ${type}`);
      }
    } catch (error: any) {
      console.error('[BackendHost] error handling message:', error);
      this.postToRenderer('error', requestId, error.code || 'HANDLER_ERROR', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Change the workspace folder(s) at runtime.
   */
  setWorkspaceFolders(fsPaths: string[]): void {
    __setWorkspaceFolders(fsPaths);
    // context awareness needs re-read on next prompt build; nothing to push here
  }

  /**
   * 把工作区路径加入收藏（与 webview/handlers/WorkspaceHandlers 同键、同文件），
   * 供主进程侧入口（File > Open Workspace Folder 等不经渲染层的打开路径）复用：
   * 打开的工作区同样进入「已保存的工作区」列表，多工作区收藏闭环。
   */
  async addSavedWorkspaceFsPath(fsPath: string): Promise<void> {
    try {
      const key = SAVED_WORKSPACES_KEY;
      const raw = this.context.globalState.get<string[]>(key);
      const list = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
      const norm = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
      if (list.some((p) => norm(p) === norm(fsPath))) return;
      list.push(fsPath);
      await this.context.globalState.update(key, list);
    } catch (err) {
      console.error('[BackendHost] failed to save workspace favorite:', err);
    }
  }

  /**
   * 把多个工作区路径加入收藏（幂等；供 File 菜单多选打开等宿主侧路径使用）
   */
  async addSavedWorkspaceFsPaths(fsPaths: string[]): Promise<void> {
    for (const fsPath of fsPaths) {
      await this.addSavedWorkspaceFsPath(fsPath);
    }
  }
}
