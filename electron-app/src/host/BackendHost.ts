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
import { MemoryManager, setGlobalMemoryManager } from '../../../backend/modules/memory';
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

  private messageRouter!: MessageRouter;
  private clientRegistry = new WebviewClientRegistry();
  /** 子代理 Monitor 内嵌面板桥（事件推送 + monitor 协议消息处理） */
  private subAgentMonitorBridge?: SubAgentMonitorBridge;
  private messageHandlingQueue: Promise<void> = Promise.resolve();
  private unsubscribers: Array<() => void> = [];
  private diffPreviewContents = new Map<string, string>();
  private diffPreviewChangeEmitter = new (require('events').EventEmitter)();
  private diffPreviewProvider = {
    onDidChange: (listener: (uri: any) => void) => {
      this.diffPreviewChangeEmitter.on('change', listener);
      return { dispose: () => this.diffPreviewChangeEmitter.off('change', listener) };
    },
    setContent: (uri: string, content: string): void => {
      const prev = this.diffPreviewContents.get(uri);
      this.diffPreviewContents.set(uri, content);
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
  ): () => void {
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
    this.messageRouter?.cancelAllStreams();
    TaskManager.cancelAllTasks();
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
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

    this.storagePathManager = new StoragePathManager(this.settingsManager, this.context);
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

    await createSkillsManager({
      workspacePath: this.getWorkspacePath(),
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
      this.context,
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

    const memoryPath = path.join(this.storagePathManager.getEffectiveDataPath(), 'memory');
    const memoryManager = new MemoryManager(memoryPath);
    await memoryManager.init();
    await memoryManager.loadConfig();
    setGlobalMemoryManager(memoryManager);

    setSubAgentExecutorContext({
      channelManager: this.channelManager,
      toolRegistry,
      mcpManager: this.mcpManager,
      settingsManager: this.settingsManager,
      configManager: this.configManager,
      toolExecutionService: this.chatHandler.getToolExecutionService()
    });

    this.dependencyManager = DependencyManager.getInstance(this.context, this.storagePathManager.getDependenciesPath());
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
      this.postToRenderer('message', 'diff.statusChanged', {
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
    // Initial diff state
    getDiffManager().getPendingDiffs();

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

    log.info('backend_initialized', { effectiveDataPath: this.storagePathManager.getEffectiveDataPath() });
  }

  private getWorkspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.fsPath;
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
      postMessage: (message) => this.postToRenderer('raw', message),
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
      streamAbortControllers: this.messageRouter.getAbortManager() as any,
      diffPreviewProvider: this.diffPreviewProvider,
      sendResponse: (id, data) => this.postToRenderer('response', id, data),
      sendError: (id, code, message) => this.postToRenderer('error', id, code, message),
      postMessage: (message: any) => this.postToRenderer('raw', message),
      getCurrentWorkspaceUri: () => {
        const folders = vscode.workspace.workspaceFolders;
        return folders?.[0] ? folders[0].uri.toString() : null;
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
          this.previewToSessionId.set(toolId, toolId);
          const resultData = data?.result?.data as Record<string, any> | undefined;
          const diffContentId = typeof resultData?.diffContentId === 'string' ? resultData.diffContentId : '';
          if (diffContentId) {
            this.previewToSessionId.set(diffContentId, toolId);
          }
          const results = resultData?.results;
          if (Array.isArray(results)) {
            for (const r of results) {
              if (typeof r?.diffContentId === 'string') {
                this.previewToSessionId.set(r.diffContentId, toolId);
              }
            }
          }
        }
      } catch (err) {
        console.error('[BackendHost] diff.openPreview intercept failed:', err);
      }
    }

    this.messageHandlingQueue = this.messageHandlingQueue
      .then(() => this.routeMessage(message))
      .catch((err) => console.error('[BackendHost] message handling error:', err));
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
}
