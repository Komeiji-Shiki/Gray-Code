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
import { initializeSubAgentsFromSettings } from '../../../webview/handlers/SubAgentsHandlers';
import { WorkspaceManager, setWorkspaceManager } from '../../../webview/utils/WorkspaceManager';
import { SAVED_WORKSPACES_KEY } from '../../../webview/handlers/WorkspaceHandlers';
import type { HandlerContext } from '../../../webview/types';
import { getDiffManager } from '../../../backend/tools/file/diffManager';
import { ElectronContext } from './ElectronContext';
import { SubAgentMonitorBridge } from './SubAgentMonitorBridge';
import {
  __setHostBridge,
  __setWorkspaceFolders,
  __initConfigStore,
  __initMementoPaths,
  __resolveToast,
  Uri
} from '../vscode-shim';

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
  private messageHandlingQueue: Promise<void> = Promise.resolve();
  /** 单条消息处理超时：handler 卡死（挂起的工具调用/等待 toast 回复等）不应把整个串行队列冻结 */
  private static readonly MESSAGE_HANDLING_TIMEOUT_MS = 60_000;
  private unsubscribers: Array<() => void> = [];
  /** diff 预览内容缓存条目数上限：完整文件内容可能数百 KB，超限按插入序淘汰最旧条目防无界增长 */
  private static readonly MAX_DIFF_PREVIEW_CONTENTS_ENTRIES = 50;
  private diffPreviewContents = new Map<string, string>();
  private diffPreviewChangeEmitter = new (require('events').EventEmitter)();
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
    if (this.updateCheckTimer) {
      clearTimeout(this.updateCheckTimer);
      this.updateCheckTimer = undefined;
    }
    this.messageRouter?.cancelAllStreams();
    TaskManager.cancelAllTasks();
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

    // 多工作区支持：激活工作区/列表变化广播到渲染进程
    this.workspaceManager = new WorkspaceManager({
        onActiveWorkspaceChanged: (uri) => this.postToRenderer('message', 'workspaceUri', uri),
        onWorkspaceListChanged: (list) => this.postToRenderer('message', 'workspaceList', list)
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

    registerAllTools(toolRegistry);

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
    await this.checkpointManager.initialize();

    this.chatHandler = new ChatHandler(this.configManager, this.channelManager, this.conversationManager, toolRegistry);
    this.chatHandler.setCheckpointManager(this.checkpointManager);
    this.chatHandler.setSettingsManager(this.settingsManager);
    this.chatHandler.setDiffStorageManager(this.diffStorageManager);

    this.modelsHandler = new ModelsHandler(this.configManager, this.settingsManager);

    this.settingsHandler = new SettingsHandler(this.settingsManager, toolRegistry);
    this.settingsHandler.setConversationManager(this.conversationManager);

    this.unsubscribers.push(
      onTerminalOutput((event: TerminalOutputEvent) => this.postToRenderer('message', 'terminalOutput', event)),
      onImageGenOutput((event: ImageGenOutputEvent) => this.postToRenderer('message', 'imageGenOutput', event)),
      TaskManager.onTaskEvent((event: TaskEvent) => this.postToRenderer('message', 'taskEvent', event))
    );

    const mcpConfigDir = this.storagePathManager.getMcpPath();
    const mcpStorage = new VSCodeFileSystemMcpStorageAdapter(vscode.Uri.file(path.join(mcpConfigDir, 'servers.json')), vscode.workspace.fs);
    this.mcpManager = new McpManager(mcpStorage);
    await this.mcpManager.initialize();

    this.channelManager.setMcpManager(this.mcpManager);
    this.chatHandler.setMcpManager(this.mcpManager);
    setGlobalMcpManager(this.mcpManager);

    await initMemoryManager(this.storagePathManager.getEffectiveDataPath());

    // 使用时间统计追踪器（与 ChatViewProvider 25.65 对齐）：心跳 + 用户活动事件按天采样落盘。
    // 桌面端无编辑器事件，采样依赖窗口焦点桥接（main.ts focus/blur → __setWindowFocused）与心跳。
    this.activityTracker = new ActivityTracker(
      path.join(this.storagePathManager.getEffectiveDataPath(), 'activity')
    );
    this.activityTracker.start();
    setGlobalActivityTracker(this.activityTracker);

    setSubAgentExecutorContext({
      channelManager: this.channelManager,
      toolRegistry,
      mcpManager: this.mcpManager,
      settingsManager: this.settingsManager,
      configManager: this.configManager,
      toolExecutionService: this.chatHandler.getToolExecutionService()
    });

    this.dependencyManager = DependencyManager.getInstance(this.context as any, this.storagePathManager.getDependenciesPath());
    await this.dependencyManager.initialize();
    toolRegistry.setDependencyChecker({
      isInstalled: (name: string) => this.dependencyManager.isInstalledSync(name)
    });
    this.unsubscribers.push(
      this.dependencyManager.onProgress((event: InstallProgressEvent) => this.postToRenderer('message', 'dependencyProgress', event))
    );

    // Diff status changes -> frontend (pending diff bar / countdown)
    getDiffManager().addStatusListener((pendingDiffs, allProcessed) => {
      // track toolId -> diff ids so the renderer diff modal can accept/reject
      this.toolDiffIds.clear();
      for (const d of pendingDiffs) {
        if (d.toolId) {
          const list = this.toolDiffIds.get(d.toolId) || [];
          list.push({ diffId: d.id, filePath: d.filePath });
          this.toolDiffIds.set(d.toolId, list);
        }
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
        allProcessed
      });
    });

    this.messageRouter = new MessageRouter(
      this.chatHandler,
      this.conversationManager,
      this.settingsManager,
      () => ({ webview: this.fakeWebviewForClient(undefined) }),
      (requestId, data) => this.postToRenderer('response', requestId, data),
      (requestId, code, message) => this.postToRenderer('error', requestId, code, message),
      this.clientRegistry
    );

    // 子代理 Monitor 内嵌面板桥：订阅 run 事件总线并向主窗口渲染进程推送
    this.subAgentMonitorBridge = new SubAgentMonitorBridge({
      routeMonitorMessage: (message) => this.routeMonitorMessage(message),
      registerMonitorClient: (runId, conversationId, sendTo) =>
        this.registerMonitorClient(runId, conversationId, sendTo),
      getConversationStore: () => this.conversationManager,
      postToRenderer: (message) => this.options.postToRenderer(message)
    });

    this.registerMainChatClient();

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
      postMessage: (message: any) => this.postToRenderer('raw', message)
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
      }
    };
  }

  /**
   * Handle a message from the renderer (same semantics as ChatViewProvider.handleMessage).
   */
  async handleRendererMessage(message: any): Promise<void> {
    const { type, data, requestId, clientId } = message || {};
    if (!type) return;

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
      // surface a hint now that the renderer is listening.
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        this.postToRenderer('command', 'host.noWorkspace', {
          title: 'Workspace',
          message: 'No workspace folder is open. Use File > Open Workspace Folder... to get started.'
        });
      }
      // First-run onboarding: if no channel has a real API key configured yet,
      // nudge the user to set one up (the backend seeds a placeholder default).
      this.checkFirstRunOnboarding();
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
        this.postToRenderer('command', 'host.firstRun', {
          message: 'Welcome to GrayCode Desktop! Configure an API channel to start chatting with AI.'
        });
        await this.context.globalState.update('graycode.onboardingSeen', true);
      } catch (err) {
        console.error('[BackendHost] first-run check failed:', err);
      }
    })();
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
