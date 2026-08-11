/**
 * GrayCode - 完整的聊天视图提供者
 * 
 * 集成后端API模块，提供完整功能
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { setLanguage as setBackendLanguage } from '../backend/i18n';
import type { SupportedLanguage } from '../backend/i18n';
import type { ConversationManager, FileSystemStorageAdapter, DiffStorageManager } from '../backend/modules/conversation';
import type { BranchService } from '../backend/modules/conversation/branch';
import type { ConfigManager } from '../backend/modules/config';
import type { ChannelManager } from '../backend/modules/channel';
import type { ChatHandler } from '../backend/modules/api/chat';
import type { ModelsHandler } from '../backend/modules/api/models';
import type { SettingsManager, StoragePathManager } from '../backend/modules/settings';
import { SettingsExporter } from '../backend/modules/settings';
import type { SettingsHandler } from '../backend/modules/api/settings';
import type { CheckpointManager } from '../backend/modules/checkpoint';
import type { McpManager } from '../backend/modules/mcp';
import type { DependencyManager } from '../backend/modules/dependencies';
import type { InstallProgressEvent } from '../backend/modules/dependencies';
import { toolRegistry, getDiffManager, resolveMainChatDiffViewColumn } from '../backend/tools';
import type { TerminalOutputEvent, ImageGenOutputEvent, TaskEvent } from '../backend/tools';
import { getSkillsManager } from '../backend/modules/skills';
import type { ActivityTracker } from '../backend/modules/activity';
import type { UpdateChecker } from '../backend/modules/update';
import type { WindowsAgentStopNotificationService } from '../backend/modules/notifications';
import { addChatFocusRestoreNotifier } from '../backend/core/chatFocusGuard';
import { createBackend } from '../backend/bootstrap';
import type { BackendRuntime } from '../backend/bootstrap';
import { MessageRouter } from './MessageRouter';
import { PUSH_MESSAGE_NAMES } from '../shared/protocol';
import { WEBVIEW_CLIENT_IDS, WebviewClientRegistry } from './runtime/WebviewClientRegistry';
import type { RunScope } from '../backend/core/RunController';
import { initializeSubAgentsFromSettings } from './handlers/SubAgentsHandlers';
import type { HandlerContext, DiffPreviewContentProvider as IDiffPreviewContentProvider } from './types';
import { SubAgentMonitorPanel } from './SubAgentMonitorPanel';
import { Logger } from '../backend/core/logger';
import { disposeUsageCache } from './handlers/UsageHandlers';
import { disposeActivityStatsCache } from './handlers/ActivityHandlers';
import { disposeFileHandlerResources } from './handlers/FileHandlers';
import { clearExecCmdAvailabilityCache } from './handlers/ToolHandlers';
import { getExtensionVersion } from './utils/extensionInfo';
import { getCurrentWorkspaceUri as getCurrentWorkspaceUriFromUtils } from './utils/WorkspaceUtils';
import {
    buildDeferredFrontendLoader,
    buildStartupBootstrapMarkup,
    buildStartupBootstrapStyles,
    buildStartupPreferenceAssignment,
    resolveStartupSplashEnabled
} from './startupBootstrap';

const log = Logger.get('ChatViewProvider');

/**
 * Diff 预览内容提供者
 */
class DiffPreviewContentProvider implements vscode.TextDocumentContentProvider, IDiffPreviewContentProvider {
    /** 缓存条目数上限：超过时按插入顺序淘汰最旧条目 */
    private static readonly MAX_CONTENTS_ENTRIES = 50;
    private contents: Map<string, string> = new Map();
    private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    
    public onDidChange = this.onDidChangeEmitter.event;
    
    public setContent(uri: string, content: string): void {
        const prev = this.contents.get(uri);
        // 先删后设：被更新的条目移到 Map 末尾（最新位置），淘汰时优先保留最近使用的预览
        if (prev !== undefined) {
            this.contents.delete(uri);
        }
        this.contents.set(uri, content);

        // 缓存条目数上限：超出时按插入顺序（Map 迭代序）淘汰最旧条目，
        // 防止完整文件内容在长期使用中无界增长（内存泄漏）。
        // 淘汰时排除当前正在展示的预览：diff 标签已打开时若被淘汰，
        // VSCode 重绘会得到空内容，正在查看的 diff 会“消失”（F5）。
        if (this.contents.size > DiffPreviewContentProvider.MAX_CONTENTS_ENTRIES) {
            const openPreviewUris = new Set<string>();
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        openPreviewUris.add(tab.input.uri.toString());
                    }
                }
            }
            for (const key of this.contents.keys()) {
                if (this.contents.size <= DiffPreviewContentProvider.MAX_CONTENTS_ENTRIES) {
                    break;
                }
                if (openPreviewUris.has(key)) {
                    continue;
                }
                this.contents.delete(key);
            }
        }

        // 关键：当同一个 diff 预览标签已打开时，必须主动触发 onDidChange，
        // 否则 VSCode 不会重新拉取 provideTextDocumentContent，看起来像“按钮没反应”。
        if (prev !== content) {
            this.onDidChangeEmitter.fire(vscode.Uri.parse(uri));
        }
    }
    
    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) || '';
    }
    
    public dispose(): void {
        this.contents.clear();
        this.onDidChangeEmitter.dispose();
    }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    // Commands may be sent before the webview JS is ready. Queue them until we get a ready handshake.
    private webviewReady = false;
    private pendingCommands: Array<{ command: string; data?: any }> = [];
    /** pendingCommands 超时兜底定时器：webview 长时间未 ready 时清空队列并告警（F7） */
    private pendingCommandsFlushTimer?: NodeJS.Timeout;
    private static readonly PENDING_COMMANDS_TIMEOUT_MS = 30_000;
    
    // Diff 预览内容提供者
    private diffPreviewProvider: DiffPreviewContentProvider;
    private diffPreviewProviderDisposable: vscode.Disposable;
    
    // 后端模块
    private configManager!: ConfigManager;
    private channelManager!: ChannelManager;
    private conversationManager!: ConversationManager;
    private branchService?: BranchService;
    private chatHandler!: ChatHandler;
    private modelsHandler!: ModelsHandler;
    private settingsManager!: SettingsManager;
    private settingsHandler!: SettingsHandler;
    private checkpointManager!: CheckpointManager;
    private mcpManager!: McpManager;
    private dependencyManager!: DependencyManager;
    private storagePathManager!: StoragePathManager;
    private diffStorageManager!: DiffStorageManager;
    private conversationStorageAdapter?: FileSystemStorageAdapter;
    private windowsAgentStopNotificationService?: WindowsAgentStopNotificationService;
    private subAgentMonitorPanel?: SubAgentMonitorPanel;
    private activityTracker?: ActivityTracker;
    private updateChecker?: UpdateChecker;
    private mainChatClientDisposable?: vscode.Disposable;
    private readonly webviewClientRegistry = new WebviewClientRegistry();
    
    // 消息路由器
    private messageRouter!: MessageRouter;

    // 后端组合根（backend/bootstrap）：管理器装配已下沉，初始化完成后同步到上方字段
    private backend?: BackendRuntime;
    
    
    // 初始化状态
    private initPromise: Promise<void>;

    /** 初始化失败时保存的错误（不 rethrow，供 handleMessage 读取并向 webview 展示根因，F1） */
    private initError?: Error;

    /** 已 dispose：置位后 openSubAgentMonitor/handleMessage 等入口直接短路，阻止旧消息继续执行（F2） */
    private disposed = false;

    /** HTML 静态部分缓存：非 nonce / 非 webview 相关部分只在首次构建时计算（F8） */
    private cachedHtmlStatic?: {
        devServerOrigin?: string;
        startupSplashEnabled: boolean;
        startupBootstrapMarkup: string;
    };

    // 消息处理队列，用于确保消息按顺序处理（解决技能切换与对话请求的竞态问题）
    private messageHandlingQueue: Promise<void> = Promise.resolve();

    /**
     * 当前 webview view 实例的事件订阅。
     *
     * resolveWebviewView 可能被多次调用（视图重建），每次调用前需先清理
     * 上一轮订阅，避免旧监听器累积。参考 SubAgentMonitorPanel.panelDisposables。
     */
    private viewDisposables: vscode.Disposable[] = [];

    // 本地开发模式：前端 Vite 开发服务器地址（仅在 ExtensionMode.Development 生效）
    private readonly webviewDevServerUrl?: string;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.webviewDevServerUrl = this.resolveWebviewDevServerUrl();
        const startupMode = this.getExtensionModeLabel();
        const webviewAssetsSource = this.webviewDevServerUrl
            ? `vite-dev-server(${this.webviewDevServerUrl})`
            : 'frontend/dist';
        log.info('startup', {
            mode: startupMode,
            extensionPath: this.context.extensionPath,
            webviewAssets: webviewAssetsSource
        });

        // 初始化 Diff 预览内容提供者
        this.diffPreviewProvider = new DiffPreviewContentProvider();
        this.diffPreviewProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
            'graycode-diff-preview',
            this.diffPreviewProvider
        );
        context.subscriptions.push(this.diffPreviewProviderDisposable);
        
        // 初始时拒绝所有之前的 diff（例如重载窗口）
        getDiffManager().rejectAll().catch(() => {});
        
        // 异步初始化后端
        this.initPromise = this.initializeBackend().catch(err => {
            console.error('Failed to initialize backend:', err);
            // 不 rethrow：initPromise 若永久 rejected，所有 await this.initPromise 的调用
            // （handleMessage / routeSubAgentMonitorMessage / exportSettings 等）都会同步抛错，
            // 前端永远收不到响应。改为保存错误，由 handleMessage 读取并向 webview 展示根因（F1）。
            this.initError = err instanceof Error ? err : new Error(String(err));
        });

        // 注册重试初始化命令：初始化失败后允许用户从命令面板重试（F1 最小实现）
        this.context.subscriptions.push(
            vscode.commands.registerCommand('graycode.retryInit', () => {
                this.retryInitialization();
            })
        );
    }

    /**
     * 初始化后端模块（组合根已下沉 backend/bootstrap；此处只做钩子装配与字段同步）
     */
    private async initializeBackend() {
        if (!this.backend) {
            this.backend = createBackend(this.context, {
                isDisposed: () => this.disposed,
                sendCommand: (command, data) => this.sendCommand(command, data),
                handleRetryStatus: (status) => this.handleRetryStatus(status),
                handleTerminalOutputEvent: (event) => this.handleTerminalOutputEvent(event),
                handleImageGenOutputEvent: (event) => this.handleImageGenOutputEvent(event),
                handleTaskEvent: (event) => this.handleTaskEvent(event),
                handleDependencyProgressEvent: (event) => this.handleDependencyProgressEvent(event),
                syncLanguageToBackend: (settingsManager) => this.syncLanguageToBackend(settingsManager),
                createMessageRouter: () => {
                    const backend = this.backend;
                    if (!backend) {
                        return;
                    }
                    this.messageRouter = new MessageRouter(
                        backend.chatHandler,
                        backend.conversationManager,
                        backend.settingsManager,
                        (clientId?: string) => this.getClientView(clientId),
                        this.sendResponse.bind(this),
                        this.sendError.bind(this),
                        this.webviewClientRegistry
                    );
                },
                initializeSubAgents: () => this.initializeSubAgents(),
                createSubAgentMonitorPanel: (conversationManager) => {
                    this.subAgentMonitorPanel = new SubAgentMonitorPanel(
                        this.context,
                        this.webviewDevServerUrl,
                        this.routeSubAgentMonitorMessage.bind(this),
                        this.registerWebviewClient.bind(this),
                        conversationManager
                    );
                }
            });
        }

        await this.backend.initialize();

        // 同步管理器引用到字段：webview 层既有访问点（createHandlerContext/exportSettings/importSettings 等）保持不变
        this.settingsManager = this.backend.settingsManager;
        this.storagePathManager = this.backend.storagePathManager;
        this.conversationStorageAdapter = this.backend.conversationStorageAdapter;
        this.diffStorageManager = this.backend.diffStorageManager;
        this.conversationManager = this.backend.conversationManager;
        this.branchService = this.backend.branchService;
        this.configManager = this.backend.configManager;
        this.channelManager = this.backend.channelManager;
        this.checkpointManager = this.backend.checkpointManager;
        this.chatHandler = this.backend.chatHandler;
        this.modelsHandler = this.backend.modelsHandler;
        this.settingsHandler = this.backend.settingsHandler;
        this.mcpManager = this.backend.mcpManager;
        this.dependencyManager = this.backend.dependencyManager;
        this.windowsAgentStopNotificationService = this.backend.windowsAgentStopNotificationService;
        this.activityTracker = this.backend.activityTracker;
        this.updateChecker = this.backend.updateChecker;
    }

    /**
     * 重试后端初始化（graycode.retryInit 命令入口，F1）。
     *
     * 仅在初始化失败后调用。组合根（backend/bootstrap）在失败时会先回滚已建立的
     * 订阅/资源再抛错，因此重跑 initializeBackend 可在任意阶段安全进行，不会叠加订阅。
     */
    private retryInitialization(): void {
        if (!this.initError || this.disposed) {
            return;
        }
        this.initError = undefined;
        this.sendCommand(PUSH_MESSAGE_NAMES.startupRetrying, {});
        this.initPromise = this.initializeBackend().catch(err => {
            console.error('Failed to initialize backend (retry):', err);
            this.initError = err instanceof Error ? err : new Error(String(err));
            this.sendCommand(PUSH_MESSAGE_NAMES.startupFailed, { message: this.initError.message || String(this.initError) });
        });
    }
    
    /**
     * 处理终端输出事件，推送到前端
     */
    private handleTerminalOutputEvent(event: TerminalOutputEvent): void {
        if (!this._view) return;
        // 统一走 sendCommand 队列：webview 未 ready 时自动入队、ready 后 flush（F4）
        this.sendCommand(PUSH_MESSAGE_NAMES.terminalOutput, event);
    }
    
    /**
     * 处理图像生成输出事件，推送到前端
     */
    private handleImageGenOutputEvent(event: ImageGenOutputEvent): void {
        if (!this._view) return;
        // 统一走 sendCommand 队列：webview 未 ready 时自动入队、ready 后 flush（F4）
        this.sendCommand(PUSH_MESSAGE_NAMES.imageGenOutput, event);
    }
    
    /**
     * 处理统一任务事件，推送到前端
     */
    private handleTaskEvent(event: TaskEvent): void {
        // AI 任务（终端/图像生成/后台子代理等）运行中视为用户在场：
        // 主人在等待任务结果时可能不操作编辑器，不能被空闲判定误判为离开
        this.activityTracker?.markAiActive();

        if (!this._view) return;
        // 统一走 sendCommand 队列：webview 未 ready 时自动入队、ready 后 flush（F4）
        this.sendCommand(PUSH_MESSAGE_NAMES.taskEvent, event);
    }
    
    /**
     * 处理依赖安装进度事件，推送到前端
     */
    private handleDependencyProgressEvent(event: InstallProgressEvent): void {
        if (!this._view) return;
        // 统一走 sendCommand 队列：webview 未 ready 时自动入队、ready 后 flush（F4）
        this.sendCommand(PUSH_MESSAGE_NAMES.dependencyProgress, event);
    }

    private openSubAgentMonitor(runId?: string, conversationId?: string): void {
        // dispose() 后不再创建/打开面板（F2）
        if (this.disposed) {
            return;
        }
        if (!this.subAgentMonitorPanel) {
            this.subAgentMonitorPanel = new SubAgentMonitorPanel(
                this.context,
                this.webviewDevServerUrl,
                this.routeSubAgentMonitorMessage.bind(this),
                this.registerWebviewClient.bind(this),
                this.conversationManager
            );
        }

        this.subAgentMonitorPanel.open(runId, conversationId);
    }

    private postRoutedWebviewMessage(clientId: string, message: Record<string, any>, fallbackWebview?: vscode.Webview): void {
        const routedMessage = { ...message, clientId };
        if (this.webviewClientRegistry.postMessage(clientId, routedMessage)) {
            return;
        }
        fallbackWebview?.postMessage(routedMessage);
    }

    private registerWebviewClient(
        clientId: string,
        webview: vscode.Webview,
        runScope?: RunScope,
        isAlive?: () => boolean
    ): vscode.Disposable {
        return this.webviewClientRegistry.register({
            clientId,
            runScope,
            webviewHost: { webview },
            postMessage: (message) => webview.postMessage(message),
            isAlive: isAlive ?? (() => this._view !== undefined && this._view.webview === webview)
        });
    }

    /** 按 clientId 获取目标 webview（F5）：monitor 面板发起的流路由到 monitor，缺省回退主聊天 */
    private getClientView(clientId?: string): { webview: vscode.Webview } | undefined {
        if (clientId) {
            return this.webviewClientRegistry.getWebviewHost(clientId);
        }
        return this._view ? { webview: this._view.webview } : undefined;
    }

    private async routeSubAgentMonitorMessage(message: any, webview: vscode.Webview): Promise<boolean> {
        await this.initPromise;

        const { type, data } = message || {};
        const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
        // 安全：不信任消息体中的 clientId。来源 webview 是 SubAgent Monitor 面板
        // （注册身份固定为 subagentMonitor），路由身份按来源 webview 的注册身份决定，
        // 防止伪造 clientId 冒充其他客户端。
        const routedClientId = WEBVIEW_CLIENT_IDS.subagentMonitor;

        const sendResponse = (id: string, responseData: any) => {
            this.postRoutedWebviewMessage(routedClientId, {
                type: PUSH_MESSAGE_NAMES.response,
                requestId: id,
                success: true,
                data: responseData
            }, webview);
        };

        const sendError = (id: string, code: string, errorMessage: string) => {
            this.postRoutedWebviewMessage(routedClientId, {
                type: PUSH_MESSAGE_NAMES.error,
                requestId: id,
                success: false,
                error: {
                    code,
                    message: errorMessage
                }
            }, webview);
        };

        const ctx: HandlerContext = {
            ...this.createHandlerContext(requestId),
            clientId: routedClientId,
            view: undefined,
            // 修改原因：Monitor 发起的 diff 预览请求沿用同一 DiffHandlers，但 vscode.diff 默认在活动组打开。
            // 修改方式：把主聊天所在列下发为 diff 目标列；主聊天在侧边栏（无列）时回退主区域第一列。
            // 修改目的：焦点在 Monitor 面板时，diff 仍显示在主聊天侧而不是被面板“抢走”。
            diffViewColumn: resolveMainChatDiffViewColumn() ?? vscode.ViewColumn.One,
            sendResponse,
            sendError,
            postMessage: (outgoing: any) => {
                this.postRoutedWebviewMessage(routedClientId, outgoing, webview);
            },
            openSubAgentMonitor: this.openSubAgentMonitor.bind(this)
        };

        // 初始化失败：messageRouter 等模块未初始化，继续路由会抛错。
        // 与 handleMessage 对齐（F1）：回错误响应，避免 Monitor 面板请求永久挂起。
        if (this.initError) {
            const initErrorMessage = this.initError.message || String(this.initError);
            sendError(requestId, 'INIT_FAILED', `Backend initialization failed: ${initErrorMessage}`);
            return true;
        }

        try {
            return await this.messageRouter.route(type, data, requestId, ctx, routedClientId);
        } catch (error: any) {
            sendError(requestId, error.code || 'HANDLER_ERROR', error instanceof Error ? error.message : String(error));
            return true;
        }
    }
    
    /**
     * 初始化子代理（从持久化存储加载到内存 registry）。
     * 管理器引用经 this.backend（组合根）读取：本方法由 bootstrap 的 initSubAgents 阶段
     * 经钩子调用，此时 webview 字段尚未从 runtime 同步。
     */
    private initializeSubAgents(): void {
        const backend = this.backend;
        if (!backend) {
            return;
        }
        const ctx: HandlerContext = {
            clientId: WEBVIEW_CLIENT_IDS.mainChat,
            settingsManager: backend.settingsManager,
            configManager: backend.configManager,
            channelManager: backend.channelManager,
            toolRegistry: toolRegistry,
            settingsHandler: backend.settingsHandler,
            conversationManager: backend.conversationManager,
            chatHandler: backend.chatHandler,
            modelsHandler: backend.modelsHandler,
            checkpointManager: backend.checkpointManager,
            mcpManager: backend.mcpManager,
            dependencyManager: backend.dependencyManager,
            storagePathManager: backend.storagePathManager,
            diffStorageManager: backend.diffStorageManager,
            updateChecker: backend.updateChecker,
            streamAbortControllers: this.messageRouter.getAbortManager(),
            diffPreviewProvider: this.diffPreviewProvider,
            getCurrentWorkspaceUri: this.getCurrentWorkspaceUri.bind(this),
            sendResponse: this.sendResponse.bind(this),
            sendError: this.sendError.bind(this),
            postMessage: (message: any) => {
                this.postRoutedWebviewMessage(WEBVIEW_CLIENT_IDS.mainChat, message, this._view?.webview);
            },
            openSubAgentMonitor: this.openSubAgentMonitor.bind(this)
        };

        initializeSubAgentsFromSettings(ctx);
    }
    
    /**
     * 处理重试状态，推送到前端
     */
    private handleRetryStatus(status: {
        type: 'retrying' | 'retrySuccess' | 'retryFailed';
        attempt: number;
        maxAttempts: number;
        error?: string;
        nextRetryIn?: number;
        conversationId?: string;
    }): void {
        if (!this._view) return;
        // 统一走 sendCommand 队列：webview 未 ready 时自动入队、ready 后 flush（F4）
        this.sendCommand(PUSH_MESSAGE_NAMES.retryStatus, { ...status });
    }
    

    
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        // 每次重建视图前清理上一轮视图级订阅，避免监听器累积
        for (const d of this.viewDisposables.splice(0)) {
            d.dispose();
        }

        this._view = webviewView;
        this.webviewReady = false;
        this.mainChatClientDisposable?.dispose();
        this.mainChatClientDisposable = this.registerWebviewClient(WEBVIEW_CLIENT_IDS.mainChat, webviewView.webview, {
            type: 'conversation',
            conversationId: 'main-chat'
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(this.context.extensionPath, 'frontend', 'dist')),
                // 内置资源（codicons 图标字体、默认提示音等）
                vscode.Uri.file(path.join(this.context.extensionPath, 'resources'))
            ]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        // 监听来自 webview 的消息
        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                // 将消息处理包装在队列中，确保按顺序执行
                this.messageHandlingQueue = this.messageHandlingQueue.then(() =>
                    this.handleMessage(message)
                ).catch(err => {
                    console.error('[ChatViewProvider] Error in message handling queue:', err);
                });
            },
            undefined,
            this.viewDisposables
        );

        // 监听 Diff 状态变化并同步到前端
        const diffManager = getDiffManager();
        const diffStatusListener = (pending: any[], allProcessed: boolean) => {
            // 我们只同步最近一次状态变化
            // 如果所有都处理完了，可能意味着有接受/拒绝发生
            // 找出所有已处理但还未通知前端的 diff 可能比较复杂，
            // 简单的办法是发送所有 pending 的 ID 及其状态，或者直接通知整个列表。
            
            // 发送 diff 状态变化消息
            this.sendCommand(PUSH_MESSAGE_NAMES['diff.statusChanged'], {
                pendingDiffs: pending.map(d => ({
                    id: d.id,
                    status: d.status,
                    filePath: d.filePath,
                    toolId: d.toolId,
                    diffGuardWarning: d.diffGuardWarning,
                    diffGuardDeletePercent: d.diffGuardDeletePercent
                })),
                allProcessed
            });
        };
        diffManager.addStatusListener(diffStatusListener);
        this.viewDisposables.push({
            dispose: () => diffManager.removeStatusListener(diffStatusListener)
        });

        // 关闭 diff 标签归还 workbench 焦点后，通知前端把光标放回聊天输入框
        // （见 backend/core/chatFocusGuard.ts）
        const removeChatFocusRestoreNotifier = addChatFocusRestoreNotifier(() => {
            this.sendCommand(PUSH_MESSAGE_NAMES['chat.restoreInputFocus'], {});
        });
        this.viewDisposables.push({
            dispose: removeChatFocusRestoreNotifier
        });

        // 立即发送一次当前状态
        diffStatusListener(diffManager.getPendingDiffs(), diffManager.areAllProcessed());

        // VSCode 窗口焦点状态推送：前端音效按「窗口是否聚焦」决定是否播放提示音——
        // 焦点在 VSCode 窗口时用户看得见界面，不播；窗口失焦（切到其他应用）时才播提醒。
        // 未就绪时 sendCommand 自动入队，webview ready 后统一 flush。
        const pushWindowFocus = (focused: boolean) => {
            this.sendCommand(PUSH_MESSAGE_NAMES.windowFocusChanged, { focused: !!focused });
        };
        pushWindowFocus(vscode.window.state.focused);
        this.viewDisposables.push(
            vscode.window.onDidChangeWindowState((state) => {
                pushWindowFocus(state.focused);
            })
        );

        // webview 面板关闭/销毁时清理视图级订阅
        this.viewDisposables.push(
            webviewView.onDidDispose(() => {
                for (const d of this.viewDisposables.splice(0)) {
                    d.dispose();
                }
                // 重置视图引用与就绪状态，避免关闭面板后 isAlive 仍判定存活导致消息被静默丢弃（F1）
                // 与 dispose() 的语义保持一致；重开面板时 resolveWebviewView 会重新赋值并注册 client
                this._view = undefined;
                this.webviewReady = false;
                this.mainChatClientDisposable?.dispose();
                this.mainChatClientDisposable = undefined;
            })
        );
    }

    /**
     * 创建处理器上下文
     */
    private createHandlerContext(requestId: string): HandlerContext {
        return {
            context: this.context,
            view: this._view,
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
            updateChecker: this.updateChecker,
            windowsAgentStopNotificationService: this.windowsAgentStopNotificationService,
            streamAbortControllers: this.messageRouter.getAbortManager(),
            diffPreviewProvider: this.diffPreviewProvider,
            // 主聊天自身发起的 diff 也跟随主聊天所在列（与 Monitor 路由同语义）：
            // 主聊天在侧边栏（无列）时 undefined，openDiffView 回退主区域第一列。
            diffViewColumn: resolveMainChatDiffViewColumn(),
            sendResponse: this.sendResponse.bind(this),
            sendError: this.sendError.bind(this),
            getCurrentWorkspaceUri: this.getCurrentWorkspaceUri.bind(this),
            syncLanguageToBackend: this.syncLanguageToBackend.bind(this),
            openSubAgentMonitor: this.openSubAgentMonitor.bind(this)
        };
    }

    /**
     * 处理来自前端的消息
     */
    private async handleMessage(message: any) {
        // dispose() 后旧消息不再执行：扩展已停用，继续路由会访问已释放的模块（F2）
        if (this.disposed) {
            return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            this.sendError('', 'INVALID_MESSAGE', 'Invalid webview message');
            return;
        }
        const { type, data, requestId } = message;
        // 安全：不信任消息体中的 clientId。来源 webview 是主聊天视图
        // （注册身份固定为 mainChat），路由身份按来源 webview 的注册身份决定，
        // 防止主聊天伪造 clientId='subagent-monitor' 触发 monitor 专属操作
        // 或把 pendingCommands 刷到对方 webview。
        const routedClientId = WEBVIEW_CLIENT_IDS.mainChat;

        // The frontend sends this as soon as its JS is ready to receive commands.
        // Handle it even if backend init is still running.
        if (type === 'webviewReady') {
            this.webviewReady = true;
            // Flush any queued commands.
            for (const cmd of this.pendingCommands) {
                this.postRoutedWebviewMessage(routedClientId, {
                    type: PUSH_MESSAGE_NAMES.command,
                    command: cmd.command,
                    data: cmd.data
                }, this._view?.webview);
            }
            this.pendingCommands = [];
            // 队列已 flush，取消超时兜底定时器（F7）
            this.clearPendingCommandsTimeout();

            if (requestId) {
                this.postRoutedWebviewMessage(routedClientId, {
                    type: PUSH_MESSAGE_NAMES.response,
                    requestId,
                    success: true,
                    data: { success: true }
                }, this._view?.webview);
            }
            return;
        }

        try {
            // 等待初始化完成
            await this.initPromise;

            // 初始化失败：messageRouter 等模块未初始化，继续路由会抛错。
            // 向 webview 发送 startupFailed 命令展示根因，并回错误响应（F1）。
            if (this.initError) {
                const initErrorMessage = this.initError.message || String(this.initError);
                this.sendCommand(PUSH_MESSAGE_NAMES.startupFailed, { message: initErrorMessage });
                this.sendError(requestId, 'INIT_FAILED', `Backend initialization failed: ${initErrorMessage}`);
                return;
            }
            
            // 创建处理器上下文
            const ctx = {
                ...this.createHandlerContext(requestId),
                clientId: routedClientId
            };
            
            // 使用消息路由器处理消息
            const handled = await this.messageRouter.route(type, data, requestId, ctx, routedClientId);
            
            if (!handled) {
                console.warn('Unknown message type:', type);
                this.sendError(requestId, 'UNKNOWN_TYPE', `Unknown message type: ${type}`);
            }
        } catch (error: any) {
            console.error('Error handling message:', error);
            this.sendError(requestId, error.code || 'HANDLER_ERROR', error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * 同步语言设置到后端 i18n
     *
     * 初始化阶段由 bootstrap 经钩子传入 settingsManager（此时 webview 字段尚未同步）；
     * 运行期由处理器上下文以无参形式调用（回退到字段）。
     */
    private syncLanguageToBackend(settingsManager?: SettingsManager): void {
        try {
            const settings = (settingsManager ?? this.settingsManager).getSettings();
            const language = settings.ui?.language || 'zh-CN';
            setBackendLanguage(language as SupportedLanguage);
        } catch (error) {
            console.error('Failed to sync language to backend:', error);
        }
    }
    
    /**
     * 获取当前工作区 URI
     */
    private getCurrentWorkspaceUri(): string | null {
        // 复用 WorkspaceUtils 统一实现，避免双份逻辑漂移（F9）
        return getCurrentWorkspaceUriFromUtils();
    }
    
    /**
     * 取消所有活跃的流式请求
     */
    public cancelAllStreams(): void {
        // messageRouter 在 initializeBackend 后期才创建；初始化失败/未完成时
        // 无活跃流可取消，也不记“成功取消”日志（F10）
        if (!this.messageRouter) {
            return;
        }
        this.messageRouter.cancelAllStreams();
        log.info('all_streams_cancelled');
    }
    
    /**
     * 清理资源
     */
    public dispose(): void {
        // 置位 disposed：后续进入的旧消息/事件直接短路（F2）
        this.disposed = true;

        // 取消所有活跃的流式请求
        this.cancelAllStreams();

        // 清理视图级监听器，包括 chat focus notifier。
        for (const disposable of this.viewDisposables.splice(0)) {
            try {
                disposable.dispose();
            } catch (error) {
                log.warn('view_disposable_cleanup_failed', { error: String(error) });
            }
        }
        disposeFileHandlerResources();
        clearExecCmdAvailabilityCache();

        // Drop queued commands.
        this.pendingCommands = [];
        this.webviewReady = false;
        // 重置视图引用，避免重开面板后 postMessage 被静默丢弃（M7）
        this._view = undefined;

        // 后端资源（订阅清理顺序与旧实现一致，见 BackendRuntime.dispose）：
        // 设置监听 → 终端/图像/任务/依赖订阅 → TaskManager → MCP → Skills → 通知服务
        // → 分支全局 → 更新检查定时器 → 活动追踪
        this.backend?.dispose();

        this.subAgentMonitorPanel?.dispose();
        this.subAgentMonitorPanel = undefined;
        this.mainChatClientDisposable?.dispose();
        this.mainChatClientDisposable = undefined;

        // 释放用量统计的目录监听与内存缓存
        disposeUsageCache();
        disposeActivityStatsCache();

        // 取消 pendingCommands 超时兜底定时器（F7）
        this.clearPendingCommandsTimeout();

        // 显式释放 Diff 预览内容提供者（内容缓存 + emitter；F3）
        this.diffPreviewProvider.dispose();
        this.diffPreviewProviderDisposable.dispose();

        // 路由映射清理：mainChatClientDisposable（上方）与 SubAgentMonitorPanel 的
        // clientRegistration（subAgentMonitorPanel.dispose）已释放各自注册；
        // registry 无整体 dispose API，注册均通过各自 Disposable 释放（F3）

        log.info('disposed');
    }
    
    /**
     * 发送响应到前端
     */
    private sendResponse(requestId: string, data: any) {
        this.postRoutedWebviewMessage(WEBVIEW_CLIENT_IDS.mainChat, {
            type: PUSH_MESSAGE_NAMES.response,
            requestId,
            success: true,
            data
        }, this._view?.webview);
    }

    /**
     * 发送错误到前端
     */
    private sendError(requestId: string, code: string, message: string) {
        this.postRoutedWebviewMessage(WEBVIEW_CLIENT_IDS.mainChat, {
            type: PUSH_MESSAGE_NAMES.error,
            requestId,
            success: false,
            error: {
                code,
                message
            }
        }, this._view?.webview);
    }

    /**
     * 发送命令到 Webview
     */
    public sendCommand(command: string, data?: any): void {
        if (!this._view || !this.webviewReady) {
            // Queue until webview is ready (or view exists).
            this.pendingCommands.push({ command, data });
            // 队列上限：面板长期未打开时反复触发命令不能让队列无界增长（F2）
            if (this.pendingCommands.length > 100) {
                this.pendingCommands.splice(0, this.pendingCommands.length - 100);
            }
            // 超时兜底：webview 迟迟不就绪时清空队列并告警，防止命令跨会话残留（F7）
            this.schedulePendingCommandsTimeout();
            return;
        }

        this.postRoutedWebviewMessage(WEBVIEW_CLIENT_IDS.mainChat, {
            type: PUSH_MESSAGE_NAMES.command,
            command,
            data
        }, this._view.webview);
    }

    /** webview 长时间未 ready 时清空 pendingCommands 并告警（F7） */
    private schedulePendingCommandsTimeout(): void {
        if (this.pendingCommandsFlushTimer) {
            return;
        }
        this.pendingCommandsFlushTimer = setTimeout(() => {
            this.pendingCommandsFlushTimer = undefined;
            if (this.pendingCommands.length > 0 && !this.webviewReady) {
                log.warn('pending_commands_timeout_flushed', { count: this.pendingCommands.length });
                this.pendingCommands = [];
            }
        }, ChatViewProvider.PENDING_COMMANDS_TIMEOUT_MS);
        (this.pendingCommandsFlushTimer as { unref?: () => void }).unref?.();
    }

    private clearPendingCommandsTimeout(): void {
        if (this.pendingCommandsFlushTimer) {
            clearTimeout(this.pendingCommandsFlushTimer);
            this.pendingCommandsFlushTimer = undefined;
        }
    }

    /**
     * 手动迁移旧版对话历史到分段存储格式
     */
    public async migrateConversationHistories(progressCallback?: (status: { current: number; total: number; conversationId?: string }) => void): Promise<{
        migrated: number;
        skipped: number;
        failed: Array<{ conversationId: string; error: string }>;
    }> {
        await this.initPromise;

        if (!this.conversationStorageAdapter) {
            throw new Error('Conversation storage adapter is not initialized.');
        }

        return await this.conversationStorageAdapter.migrateLegacyConversationsToSegmented(progressCallback);
    }

    public getEffectiveConversationDataPath(): string {
        if (!this.storagePathManager) {
            throw new Error('StoragePathManager is not initialized.');
        }
        return this.storagePathManager.getEffectiveDataPath();
    }

    /**
     * 导出插件设置（排除对话历史和检查点）
     *
     * 收集所有设置数据并序列化为 JSON 字符串。
     */
    public async exportSettings(): Promise<string> {
        await this.initPromise;

        const skillsManager = getSkillsManager();
        if (!skillsManager) {
            throw new Error('SkillsManager is not initialized.');
        }

        const exporter = new SettingsExporter(
            this.settingsManager,
            this.configManager,
            this.mcpManager,
            skillsManager,
            getExtensionVersion(this.context.extensionPath),
            this.storagePathManager.getEffectiveDataPath() + '/skills'
        );

        return await exporter.exportToJson(true);
    }

    /**
     * 导入插件设置
     *
     * @param json 导出文件的 JSON 字符串
     * @param options 导入选项
     */
    public async importSettings(
        json: string,
        options?: { overwriteChannelConfigs?: boolean; overwriteMcpServers?: boolean; overwriteSkills?: boolean; overwriteVscodeSettings?: boolean }
    ): Promise<{ success: boolean; imported: { vscodeSettings: boolean; channelConfigs: number; mcpServers: number; skills: number }; errors: string[] }> {
        await this.initPromise;

        const skillsManager = getSkillsManager();
        if (!skillsManager) {
            throw new Error('SkillsManager is not initialized.');
        }

        const exporter = new SettingsExporter(
            this.settingsManager,
            this.configManager,
            this.mcpManager,
            skillsManager,
            getExtensionVersion(this.context.extensionPath),
            this.storagePathManager.getEffectiveDataPath() + '/skills'
        );

        const data = exporter.parseExportData(json);
        return await exporter.importFromData(data, options);
    }


    /**
     * 生成webview的HTML
     */
    private getExtensionModeLabel(): string {
        switch (this.context.extensionMode) {
            case vscode.ExtensionMode.Development:
                return 'development';
            case vscode.ExtensionMode.Test:
                return 'test';
            case vscode.ExtensionMode.Production:
            default:
                return 'production';
        }
    }

    private resolveWebviewDevServerUrl(): string | undefined {
        const raw = process.env.GRAYCODE_WEBVIEW_DEV_SERVER_URL?.trim();
        if (!raw) {
            return undefined;
        }

        if (this.context.extensionMode !== vscode.ExtensionMode.Development) {
            console.warn('[ChatViewProvider] GRAYCODE_WEBVIEW_DEV_SERVER_URL 仅在开发模式下生效，当前已忽略。');
            return undefined;
        }

        try {
            const parsed = new URL(raw);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error(`Unsupported protocol: ${parsed.protocol}`);
            }

            return parsed.toString().replace(/\/$/, '');
        } catch (error) {
            console.warn('[ChatViewProvider] 无效的 GRAYCODE_WEBVIEW_DEV_SERVER_URL:', raw, error);
            return undefined;
        }
    }

    /** 内置提示音文件名缓存：按扩展路径 memoize，避免每次构建 HTML 都同步 readdirSync（F6） */
    private static readonly builtinSoundFilesCache = new Map<string, string[]>();

    private buildBuiltinSoundAssets(webview: vscode.Webview): Record<string, { url: string; name: string }> {
        try {
            const soundDir = path.join(this.context.extensionPath, 'resources', 'sound');
            let files = ChatViewProvider.builtinSoundFilesCache.get(soundDir);
            if (files === undefined) {
                if (!fs.existsSync(soundDir)) {
                    files = [];
                } else {
                    files = fs.readdirSync(soundDir).filter(f => f.toLowerCase().endsWith('.mp3'));
                }
                // 成功（含空目录）即缓存：resources/sound 在扩展生命周期内不变（F6）
                ChatViewProvider.builtinSoundFilesCache.set(soundDir, files);
            }
            if (files.length === 0) {
                return {};
            }

            const normalizeMap = new Map(files.map(f => [f.toLowerCase(), f] as const));
            const byName = (name: string): string | undefined => normalizeMap.get(name.toLowerCase());

            // 严格使用默认资源命名：warning.mp3 / error.mp3 / taskComplete.mp3 / taskError.mp3
            const warningFile = byName('warning.mp3');
            const errorFile = byName('error.mp3');
            const taskCompleteFile = byName('taskComplete.mp3');
            const taskErrorFile = byName('taskError.mp3');

            const toEntry = (filename: string) => {
                const uri = webview.asWebviewUri(vscode.Uri.file(path.join(soundDir, filename)));
                return { url: uri.toString(), name: filename };
            };

            const assets: Record<string, { url: string; name: string }> = {};
            if (warningFile) {
                assets.warning = toEntry(warningFile);
            }
            if (errorFile) {
                assets.error = toEntry(errorFile);
            }
            if (taskCompleteFile) {
                assets.taskComplete = toEntry(taskCompleteFile);
            }
            if (taskErrorFile) {
                assets.taskError = toEntry(taskErrorFile);
            }

            return assets;
        } catch (error) {
            console.warn('[ChatViewProvider] Failed to build builtin sound assets:', error);
            return {};
        }
    }

    private buildCsp(webview: vscode.Webview, nonce: string, devServerOrigin?: string): string {
        const scriptSrc = [webview.cspSource, `'nonce-${nonce}'`];
        const styleSrc = [webview.cspSource, "'unsafe-inline'"];
        const imgSrc = [webview.cspSource, 'data:', 'blob:'];
        const mediaSrc = [webview.cspSource, 'data:', 'blob:'];
        const fontSrc = [webview.cspSource];
        const connectSrc = [webview.cspSource];

        if (devServerOrigin) {
            scriptSrc.push(devServerOrigin, "'unsafe-eval'");
            styleSrc.push(devServerOrigin);
            imgSrc.push(devServerOrigin);
            mediaSrc.push(devServerOrigin);
            fontSrc.push(devServerOrigin, 'data:');
            connectSrc.push(devServerOrigin, 'ws:', 'wss:');
        }

        return [
            "default-src 'none'",
            `script-src ${scriptSrc.join(' ')}`,
            `style-src ${styleSrc.join(' ')}`,
            `img-src ${imgSrc.join(' ')}`,
            `media-src ${mediaSrc.join(' ')}`,
            `font-src ${fontSrc.join(' ')}`,
            `connect-src ${connectSrc.join(' ')}`
        ].join('; ');
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'frontend', 'dist', 'index.js'))
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'frontend', 'dist', 'index.css'))
        );
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'codicons', 'codicon.css'))
        );
        const iconUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'icon.svg'))
        );

        const devServerUrl = this.webviewDevServerUrl;
        if (!this.cachedHtmlStatic) {
            // VS Code 配置读取是同步 IPC：只在首次构建 HTML 时读取并缓存，
            // 视图重建（resolveWebviewView）不再重复读配置（F8）。
            const uiConfig = vscode.workspace.getConfiguration('graycode').get<unknown>('ui');
            const startupSplashEnabled = resolveStartupSplashEnabled(uiConfig);
            this.cachedHtmlStatic = {
                devServerOrigin: devServerUrl ? new URL(devServerUrl).origin : undefined,
                startupSplashEnabled,
                startupBootstrapMarkup: buildStartupBootstrapMarkup(startupSplashEnabled)
            };
        }
        const devServerOrigin = this.cachedHtmlStatic.devServerOrigin;
        const nonce = randomBytes(16).toString('base64');
        const cspContent = this.buildCsp(webview, nonce, devServerOrigin);
        const startupBootstrapScript = `<script nonce="${nonce}">${buildStartupPreferenceAssignment(this.cachedHtmlStatic.startupSplashEnabled)}</script>`;
        const startupBootstrapStyles = `<style>${buildStartupBootstrapStyles(iconUri.toString())}</style>`;
        const startupBootstrapMarkup = this.cachedHtmlStatic.startupBootstrapMarkup;
        const builtinSoundAssetsScript = `<script nonce="${nonce}">window.__GRAYCODE_BUILTIN_SOUND_ASSETS = ${JSON.stringify(this.buildBuiltinSoundAssets(webview))};</script>`;

        if (devServerUrl) {
            const frontendLoader = buildDeferredFrontendLoader(
                [codiconsUri.toString()],
                [`${devServerUrl}/@vite/client`, `${devServerUrl}/src/main.ts`]
            );
            log.info('webview_load', { source: 'vite-dev-server', url: devServerUrl });
            return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${cspContent}">
    ${startupBootstrapStyles}
    ${startupBootstrapScript}
    ${builtinSoundAssetsScript}
    <title>GrayCode Chat (Dev)</title>
</head>
<body>
    <div id="app">${startupBootstrapMarkup}</div>
    <script nonce="${nonce}">${frontendLoader}</script>
</body>
</html>`;
        }

        const frontendLoader = buildDeferredFrontendLoader(
            [codiconsUri.toString(), styleUri.toString()],
            [scriptUri.toString()]
        );
        log.info('webview_load', { source: 'frontend/dist' });
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${cspContent}">
    ${startupBootstrapStyles}
    ${startupBootstrapScript}
    ${builtinSoundAssetsScript}
    <title>GrayCode Chat</title>
</head>
<body>
    <div id="app">${startupBootstrapMarkup}</div>
    <script nonce="${nonce}">${frontendLoader}</script>
</body>
</html>`;
    }
}
