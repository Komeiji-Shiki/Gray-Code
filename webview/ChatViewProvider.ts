/**
 * GrayCode - 完整的聊天视图提供者
 * 
 * 集成后端API模块，提供完整功能
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { t, setLanguage as setBackendLanguage } from '../backend/i18n';
import type { SupportedLanguage } from '../backend/i18n';
import {
    ConversationManager,
    FileSystemStorageAdapter,
    FileUsageIndexStore
} from '../backend/modules/conversation';
import {
    BranchGraphRepository,
    BranchService,
    getGlobalBranchService,
    setGlobalBranchService,
} from '../backend/modules/conversation/branch';
import { ConfigManager, MementoStorageAdapter } from '../backend/modules/config';
import { ChannelManager } from '../backend/modules/channel';
import { ChatHandler } from '../backend/modules/api/chat';
import { ModelsHandler } from '../backend/modules/api/models';
import { SettingsManager, VSCodeSettingsStorage, StoragePathManager, SettingsExporter } from '../backend/modules/settings';
import type { SettingsChangeEvent } from '../backend/modules/settings';
import { SettingsHandler } from '../backend/modules/api/settings';
import { CheckpointManager } from '../backend/modules/checkpoint';
import { McpManager, VSCodeFileSystemMcpStorageAdapter } from '../backend/modules/mcp';
import type { McpServerInfo } from '../backend/modules/mcp';
import { DependencyManager, type InstallProgressEvent } from '../backend/modules/dependencies';
import { toolRegistry, registerAllTools, onTerminalOutput, onImageGenOutput, TaskManager, setSubAgentExecutorContext } from '../backend/tools';
import type { TerminalOutputEvent, ImageGenOutputEvent, TaskEvent } from '../backend/tools';
import { createSkillsManager, getSkillsManager } from '../backend/modules/skills';
import { initMemoryManager } from '../backend/modules/memory';
import { UpdateChecker } from '../backend/modules/update';
import { ActivityTracker, setGlobalActivityTracker } from '../backend/modules/activity';
import { TokenizerResourceManager, setGlobalTokenizerResourceManager } from '../backend/modules/tokenizer';
import type { SettingsExportData } from '../backend/modules/settings';
import {
    setGlobalSettingsManager,
    setGlobalConfigManager,
    setGlobalChannelManager,
    setGlobalToolRegistry,
    setGlobalDiffStorageManager,
    setGlobalMcpManager
} from '../backend/core/settingsContext';
import { DiffStorageManager } from '../backend/modules/conversation';
import { getDiffManager } from '../backend/tools/file/diffManager';
import { resolveMainChatDiffViewColumn } from '../backend/tools/file/diffViewColumn';
import { addChatFocusRestoreNotifier } from '../backend/core/chatFocusGuard';
import { MessageRouter } from './MessageRouter';
import { WEBVIEW_CLIENT_IDS, WebviewClientRegistry } from './runtime/WebviewClientRegistry';
import type { RunScope } from '../backend/core/RunController';
import { initializeSubAgentsFromSettings } from './handlers/SubAgentsHandlers';
import type { HandlerContext, DiffPreviewContentProvider as IDiffPreviewContentProvider } from './types';
import { WindowsAgentStopNotificationService } from '../backend/modules/notifications/WindowsAgentStopNotificationService';
import { SubAgentMonitorPanel } from './SubAgentMonitorPanel';
import { Logger } from '../backend/core/logger';
import { disposeUsageCache } from './handlers/UsageHandlers';
import { disposeActivityStatsCache } from './handlers/ActivityHandlers';
import { disposeFileHandlerResources } from './handlers/FileHandlers';
import { getExtensionVersion } from './utils/extensionInfo';
import {
    buildDeferredFrontendLoader,
    buildStartupBootstrapMarkup,
    buildStartupBootstrapStyles,
    buildStartupPreferenceAssignment,
    resolveStartupSplashEnabled
} from './startupBootstrap';

const log = Logger.get('ChatViewProvider');
const UPDATE_CHECK_DELAY_MS = 10_000;

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
        // 防止完整文件内容在长期使用中无界增长（内存泄漏）
        if (this.contents.size > DiffPreviewContentProvider.MAX_CONTENTS_ENTRIES) {
            const oldestKey = this.contents.keys().next().value;
            if (oldestKey !== undefined) {
                this.contents.delete(oldestKey);
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
    private updateCheckTimer?: NodeJS.Timeout;
    private mainChatClientDisposable?: vscode.Disposable;
    private readonly webviewClientRegistry = new WebviewClientRegistry();
    
    // 消息路由器
    private messageRouter!: MessageRouter;
    
    // 事件取消订阅函数
    private terminalOutputUnsubscribe?: () => void;
    private imageGenOutputUnsubscribe?: () => void;
    private taskEventUnsubscribe?: () => void;
    private dependencyProgressUnsubscribe?: () => void;
    
    // 初始化状态
    private initPromise: Promise<void>;

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
            throw err;
        });
    }

    /**
     * 初始化后端模块
     */
    private async initializeBackend() {
        // 1. 初始化设置管理器（需要最先初始化以获取存储路径配置）
        const legacySettingsDir = path.join(this.context.globalStorageUri.fsPath, 'settings');
        const settingsStorage = new VSCodeSettingsStorage({
            legacySettingsDir
        });
        this.settingsManager = new SettingsManager(settingsStorage);
        await this.settingsManager.initialize();
        this.windowsAgentStopNotificationService = new WindowsAgentStopNotificationService({ settingsManager: this.settingsManager });
        
        // 2. 初始化存储路径管理器
        this.storagePathManager = new StoragePathManager(this.settingsManager, this.context);
        await this.storagePathManager.ensureDirectories();
        
        // 3. 获取有效的数据存储路径（可能是自定义路径）
        const effectiveDataUri = this.storagePathManager.getEffectiveDataUri();
        
        // 4. 初始化存储适配器（使用文件系统存储，避免 globalState 过大）
        const storageAdapter = new FileSystemStorageAdapter(vscode, effectiveDataUri);
        this.conversationStorageAdapter = storageAdapter;
        
        // 5. 初始化 Diff 存储管理器（用于 apply_diff 的大文件内容抽离）
        this.diffStorageManager = DiffStorageManager.initialize(this.storagePathManager.getEffectiveDataPath());
        setGlobalDiffStorageManager(this.diffStorageManager);
        
        // 6. 初始化对话管理器（附带用量索引：消息落盘时维护 token 明细，统计页免全量扫描）
        this.conversationManager = new ConversationManager(
            storageAdapter,
            new FileUsageIndexStore(vscode, effectiveDataUri)
        );

        // 分支图同步是普通追加与总结写入的后台职责，不能依赖用户先打开分支面板才初始化。
        // 本次实故障由已结束的空 reroll 占位冻结同步触发；这里额外封堵窗口重载后已有 sidecar
        // 但全局服务尚未懒创建的独立复发路径。懒解析 handler 会复用这个实例。
        this.branchService = new BranchService(
            this.conversationManager,
            new BranchGraphRepository(this.storagePathManager.getEffectiveDataPath())
        );
        setGlobalBranchService(this.branchService);

        // 6.1 后台迁移旧版单文件历史到分段存储格式，不阻塞主初始化链路
        void storageAdapter.migrateLegacyConversationsToSegmented().then(result => {
            log.info('conversation_migration.finished', {
                migrated: result.migrated,
                skipped: result.skipped,
                failedCount: result.failed.length
            });
            if (result.failed.length > 0) {
                log.warn('conversation_migration.failed_conversations', { failed: result.failed });
            }
        }).catch(error => {
            log.warn('conversation_migration.background_failed', { error: error?.message || String(error) });
        });
        
        // 7. 初始化配置管理器（使用Memento存储）
        const configStorage = new MementoStorageAdapter(
            this.context.globalState,
            'graycode.configs'
        );
        this.configManager = new ConfigManager(configStorage);
        
        // 8. 创建默认配置（如果不存在）
        await this.ensureDefaultConfig();
        
        // 9. 同步语言设置到后端 i18n
        this.syncLanguageToBackend();
        
        // 10. 设置全局上下文引用（供工具和其他模块访问）
        setGlobalSettingsManager(this.settingsManager);
        setGlobalConfigManager(this.configManager);
        setGlobalToolRegistry(toolRegistry);

        // 10.1 监听设置变更：apply_diff 自动应用开关/延迟变更时，让现有 pending diff 立即生效
        const settingsChangeListener = (event: SettingsChangeEvent) => {
            if (event.type === 'tools' && event.path === 'toolsConfig.apply_diff') {
                try {
                    // 对已存在的 pending diff 重新调度/取消自动保存
                    getDiffManager().refreshAutoSaveTimers();
                } catch (e) {
                    console.warn('[ChatViewProvider] Failed to refresh diff autoSave timers:', e);
                }

                // 推送最新配置到前端（用于更新倒计时/自动确认 UI）
                try {
                    const config = event.settings?.toolsConfig?.apply_diff || this.settingsManager.getApplyDiffConfig();
                    this.sendCommand('tools.applyDiffConfigChanged', { config });
                } catch {
                    // ignore
                }
            }
        };
        this.settingsManager.addChangeListener(settingsChangeListener);
        this.context.subscriptions.push({
            dispose: () => this.settingsManager.removeChangeListener(settingsChangeListener)
        });
        
        // 11. 初始化 Skills 管理器（必须在注册工具之前，因为 skills 工具需要它）
        await createSkillsManager({
            workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            globalStoragePath: this.storagePathManager.getEffectiveDataPath(),
        });
        
        // 11.1 从 settingsManager 同步 skills 状态到 SkillsManager
        await this.syncSkillsState();
        
        // 12. 注册所有工具到工具注册器（必须在 ChannelManager 之前）
        registerAllTools(toolRegistry);
        
        // 13. 初始化渠道管理器（传入工具注册器和设置管理器）
        this.channelManager = new ChannelManager(this.configManager, toolRegistry, this.settingsManager);
        
        // 14. 设置重试状态回调
        this.channelManager.setRetryStatusCallback((status) => {
            this.handleRetryStatus(status);
        });
        
        // 15. 设置全局渠道管理器引用
        setGlobalChannelManager(this.channelManager);
        
        // 16. 初始化检查点管理器（使用自定义路径）
        this.checkpointManager = new CheckpointManager(
            this.settingsManager,
            this.conversationManager,
            this.context,
            this.storagePathManager.getEffectiveDataPath()
        );
        await this.checkpointManager.initialize();
        
        // 17. 初始化聊天处理器（传入工具注册器和检查点管理器）
        this.chatHandler = new ChatHandler(
            this.configManager,
            this.channelManager,
            this.conversationManager,
            toolRegistry
        );
        this.chatHandler.setCheckpointManager(this.checkpointManager);
        this.chatHandler.setSettingsManager(this.settingsManager);
        
        // 18. 初始化模型管理处理器
        this.modelsHandler = new ModelsHandler(this.configManager, this.settingsManager);
        
        // 19. 初始化设置处理器（传入工具注册器）
        this.settingsHandler = new SettingsHandler(this.settingsManager, toolRegistry);
        this.settingsHandler.setConversationManager(this.conversationManager);
        
        // 20. 订阅终端输出事件
        this.terminalOutputUnsubscribe = onTerminalOutput((event) => {
            this.handleTerminalOutputEvent(event);
        });
        
        // 21. 订阅图像生成输出事件
        this.imageGenOutputUnsubscribe = onImageGenOutput((event) => {
            this.handleImageGenOutputEvent(event);
        });
        
        // 22. 订阅统一任务事件（用于未来扩展）
        this.taskEventUnsubscribe = TaskManager.onTaskEvent((event) => {
            this.handleTaskEvent(event);
        });
        
        // 23. 初始化 MCP 管理器（使用自定义路径下的 mcp 目录）
        const mcpConfigDir = vscode.Uri.file(this.storagePathManager.getMcpPath());
        try {
            await vscode.workspace.fs.stat(mcpConfigDir);
        } catch {
            await vscode.workspace.fs.createDirectory(mcpConfigDir);
        }
        const mcpConfigFile = vscode.Uri.joinPath(mcpConfigDir, 'servers.json');
        const mcpStorage = new VSCodeFileSystemMcpStorageAdapter(mcpConfigFile, vscode.workspace.fs);
        this.mcpManager = new McpManager(mcpStorage);
        await this.mcpManager.initialize();
        
        // 24. 将 MCP 管理器连接到 ChannelManager（用于工具声明）
        this.channelManager.setMcpManager(this.mcpManager);
        
        // 25. 将 MCP 管理器连接到 ChatHandler（用于工具调用）
        this.chatHandler.setMcpManager(this.mcpManager);
        
        // 25.5. 设置全局 MCP 管理器（用于 subagents 工具描述）
        setGlobalMcpManager(this.mcpManager);
        
        // 25.6. 初始化 MemoryManager（永久记忆系统，含工作区记忆作用域支持）
        await initMemoryManager(this.storagePathManager.getEffectiveDataPath());
        
        // 25.65. 初始化使用时间统计追踪器（活跃采样：心跳 + 用户活动事件，按天落盘）
        const activityTracker = new ActivityTracker(
            path.join(this.storagePathManager.getEffectiveDataPath(), 'activity')
        );
        activityTracker.start();
        this.activityTracker = activityTracker;
        setGlobalActivityTracker(activityTracker);

        // 25.66. 初始化 tokenizer 词表资源管理器（运行时下载 cl100k / DeepSeek 词表到数据目录）
        const tokenizerManager = new TokenizerResourceManager(this.storagePathManager.getTokenizerPath());
        setGlobalTokenizerResourceManager(tokenizerManager);
        
        // 25.7. 设置 SubAgent 执行器上下文
        setSubAgentExecutorContext({
            channelManager: this.channelManager,
            toolRegistry: toolRegistry,
            mcpManager: this.mcpManager,
            settingsManager: this.settingsManager,
            configManager: this.configManager,
            toolExecutionService: this.chatHandler.getToolExecutionService(),
            // 修改原因：子代理 token 消耗需要归集到发起它的主会话用量统计（UsagePage）。
            // 修改方式：把 ConversationManager 的索引追加入口注入 SubAgent 执行上下文，
            //          executor 每轮 generate 后把 usageMetadata 以 source='subagent' 条目写入主会话索引。
            // 修改目的：用量统计包含子代理消耗，且不把子代理运行明细写入主历史。
            usageIndexAppend: (conversationId, messages) =>
                this.conversationManager.appendUsageIndexMessages(conversationId, messages)
        });

        // 25.75. 初始化更新检查器（GitHub Releases 自动更新）
        this.updateChecker = new UpdateChecker({
            // 用户可在设置页「通用」关闭自动检查（checkForUpdates !== false 默认开启）
            isCheckEnabled: () => this.settingsManager.getSettings().checkForUpdates !== false,
            // 复用渠道代理配置：GitHub API/下载在代理环境下同样走代理
            getProxyUrl: () => {
                const proxy = this.settingsManager.getSettings().proxy;
                return proxy?.enabled && proxy?.url ? proxy.url : undefined;
            },
            // 上次检查时间戳存扩展 globalState（内部状态，不参与 Settings Sync）
            storage: {
                get: (key) => this.context.globalState.get<number>(key),
                update: (key, value) => Promise.resolve(this.context.globalState.update(key, value)),
            },
            globalStoragePath: this.context.globalStorageUri.fsPath,
        });
        
        // 26. 初始化依赖管理器（使用自定义路径）
        this.dependencyManager = DependencyManager.getInstance(
            this.context,
            this.storagePathManager.getDependenciesPath()
        );
        await this.dependencyManager.initialize();
        
        // 27. 设置依赖检查器到工具注册器（用于过滤未安装依赖的工具）
        toolRegistry.setDependencyChecker({
            isInstalled: (name: string) => this.dependencyManager.isInstalledSync(name)
        });
        
        // 28. 订阅依赖安装进度事件
        this.dependencyProgressUnsubscribe = this.dependencyManager.onProgress((event) => {
            this.handleDependencyProgressEvent(event);
        });
        
        // 29. 初始化消息路由器
        this.messageRouter = new MessageRouter(
            this.chatHandler,
            this.conversationManager,
            this.settingsManager,
            (clientId?: string) => this.getClientView(clientId),
            this.sendResponse.bind(this),
            this.sendError.bind(this),
            this.webviewClientRegistry
        );
        
        // 30. 初始化子代理（从持久化存储加载）
        this.initializeSubAgents();

        // 30.5. 启动延迟更新检查（避开启动竞态；24h 节流在 UpdateChecker 内部处理，失败静默）
        this.updateCheckTimer = setTimeout(() => {
            if (!this.updateChecker) {
                log.warn('update_check_skipped_not_initialized');
                return;
            }
            this.updateChecker.check(false).catch(error => {
                log.warn('update_check_failed', { error: error?.message || String(error) });
            });
        }, UPDATE_CHECK_DELAY_MS);

        this.subAgentMonitorPanel = new SubAgentMonitorPanel(
            this.context,
            this.webviewDevServerUrl,
            this.routeSubAgentMonitorMessage.bind(this),
            this.registerWebviewClient.bind(this),
            this.conversationManager
        );
        
        log.info('backend_initialized', {
            effectiveDataPath: this.storagePathManager.getEffectiveDataPath()
        });
    }
    
    /**
     * 处理终端输出事件，推送到前端
     */
    private handleTerminalOutputEvent(event: TerminalOutputEvent): void {
        if (!this._view) return;
        
        this._view.webview.postMessage({
            type: 'terminalOutput',
            data: event
        });
    }
    
    /**
     * 处理图像生成输出事件，推送到前端
     */
    private handleImageGenOutputEvent(event: ImageGenOutputEvent): void {
        if (!this._view) return;
        
        this._view.webview.postMessage({
            type: 'imageGenOutput',
            data: event
        });
    }
    
    /**
     * 处理统一任务事件，推送到前端
     */
    private handleTaskEvent(event: TaskEvent): void {
        // AI 任务（终端/图像生成/后台子代理等）运行中视为用户在场：
        // 主人在等待任务结果时可能不操作编辑器，不能被空闲判定误判为离开
        this.activityTracker?.markAiActive();

        if (!this._view) return;
        
        this._view.webview.postMessage({
            type: 'taskEvent',
            data: event
        });
    }
    
    /**
     * 处理依赖安装进度事件，推送到前端
     */
    private handleDependencyProgressEvent(event: InstallProgressEvent): void {
        if (!this._view) return;
        
        this._view.webview.postMessage({
            type: 'dependencyProgress',
            data: event
        });
    }

    private openSubAgentMonitor(runId?: string, conversationId?: string): void {
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
                type: 'response',
                requestId: id,
                success: true,
                data: responseData
            }, webview);
        };

        const sendError = (id: string, code: string, errorMessage: string) => {
            this.postRoutedWebviewMessage(routedClientId, {
                type: 'error',
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

        try {
            return await this.messageRouter.route(type, data, requestId, ctx, routedClientId);
        } catch (error: any) {
            sendError(requestId, error.code || 'HANDLER_ERROR', error instanceof Error ? error.message : String(error));
            return true;
        }
    }
    
    /**
     * 初始化子代理（从持久化存储加载到内存 registry）
     */
    private initializeSubAgents(): void {
        const ctx: HandlerContext = {
            clientId: WEBVIEW_CLIENT_IDS.mainChat,
            settingsManager: this.settingsManager,
            configManager: this.configManager,
            channelManager: this.channelManager,
            toolRegistry: toolRegistry,
            settingsHandler: this.settingsHandler,
            conversationManager: this.conversationManager,
            chatHandler: this.chatHandler,
            modelsHandler: this.modelsHandler,
            checkpointManager: this.checkpointManager,
            mcpManager: this.mcpManager,
            dependencyManager: this.dependencyManager,
            storagePathManager: this.storagePathManager,
            diffStorageManager: this.diffStorageManager,
            updateChecker: this.updateChecker,
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
        
        this._view.webview.postMessage({
            type: 'retryStatus',
            data: {
                ...status
            }
        });
    }
    
    /**
     * 同步 skills 状态到 SkillsManager
     * 从 settingsManager 加载已保存的启用状态
     * 对于 settings 中没有记录的新 Skill，默认设为启用
     */
    private async syncSkillsState(): Promise<void> {
        try {
            const { getSkillsManager } = await import('../backend/modules/skills');
            const skillsManager = getSkillsManager();
            
            if (!skillsManager) {
                return;
            }
            
            // 从 settingsManager 获取已保存的 skills 配置
            const savedConfig = this.settingsManager.getSkillsConfig() || { skills: [] };
            const savedSkillIds = new Set(savedConfig.skills.map(s => s.id));
            
            // 同步已保存的 Skill 状态
            for (const savedSkill of savedConfig.skills) {
                if (savedSkill.enabled) {
                    skillsManager.enableSkill(savedSkill.id);
                } else {
                    skillsManager.disableSkill(savedSkill.id);
                }
            }

            // 对于 settings 中没有记录的新 Skill，默认启用。
            // 否则新扫到的 Skill 在 read_skill 工具注册时不会出现在列表中，
            // 直到前端 getSkillsConfig 被调用才会被默认启用。
            for (const skill of skillsManager.getAllSkills()) {
                if (!savedSkillIds.has(skill.id)) {
                    skillsManager.enableSkill(skill.id);
                }
            }
        } catch (error) {
            console.error('[ChatViewProvider] Failed to sync skills state:', error);
        }
    }
    
    /**
     * 确保存在默认配置
     */
    private async ensureDefaultConfig() {
        try {
            const existingConfig = await this.configManager.getConfig('gemini-pro');
            if (!existingConfig) {
                await this.configManager.ensureConfig('gemini-pro', {
                    type: 'gemini',
                    name: 'Gemini(Default)',
                    apiKey: process.env.GEMINI_API_KEY || 'YOUR_API_KEY_HERE',
                    url: 'https://generativelanguage.googleapis.com/v1beta',
                    model: 'gemini-3-pro-preview',
                    timeout: 120000,
                    enabled: true
                });
            }
        } catch (error) {
            console.error('Failed to create default config:', error);
        }
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
            this.sendCommand('diff.statusChanged', {
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
            this.sendCommand('chat.restoreInputFocus', {});
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
            this.sendCommand('windowFocusChanged', { focused: !!focused });
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
                    type: 'command',
                    command: cmd.command,
                    data: cmd.data
                }, this._view?.webview);
            }
            this.pendingCommands = [];

            if (requestId) {
                this.postRoutedWebviewMessage(routedClientId, {
                    type: 'response',
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
     */
    private syncLanguageToBackend(): void {
        try {
            const settings = this.settingsManager.getSettings();
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
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        return workspaceFolder ? workspaceFolder.uri.toString() : null;
    }
    
    /**
     * 取消所有活跃的流式请求
     */
    public cancelAllStreams(): void {
        this.messageRouter?.cancelAllStreams();
        log.info('all_streams_cancelled');
    }
    
    /**
     * 清理资源
     */
    public dispose(): void {
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

        // Drop queued commands.
        this.pendingCommands = [];
        this.webviewReady = false;
        // 重置视图引用，避免重开面板后 postMessage 被静默丢弃（M7）
        this._view = undefined;
        
        // 取消终端输出订阅
        if (this.terminalOutputUnsubscribe) {
            this.terminalOutputUnsubscribe();
        }
        
        // 取消图像生成输出订阅
        if (this.imageGenOutputUnsubscribe) {
            this.imageGenOutputUnsubscribe();
        }
        
        // 取消统一任务事件订阅
        if (this.taskEventUnsubscribe) {
            this.taskEventUnsubscribe();
        }
        
        // 取消依赖安装进度订阅
        if (this.dependencyProgressUnsubscribe) {
            this.dependencyProgressUnsubscribe();
        }
        
        // 取消所有活跃任务
        TaskManager.cancelAllTasks();
        
        // 释放 MCP 管理器资源（断开所有连接）
        this.mcpManager?.dispose();

        // 释放 Skills 管理器资源
        getSkillsManager()?.dispose();
        this.windowsAgentStopNotificationService?.dispose();
        this.subAgentMonitorPanel?.dispose();
        this.subAgentMonitorPanel = undefined;
        if (getGlobalBranchService() === this.branchService) {
            setGlobalBranchService(undefined);
        }
        this.branchService = undefined;
        this.mainChatClientDisposable?.dispose();
        this.mainChatClientDisposable = undefined;

        // 清理更新检查延迟任务
        if (this.updateCheckTimer) {
            clearTimeout(this.updateCheckTimer);
            this.updateCheckTimer = undefined;
        }

        // 释放用量统计的目录监听与内存缓存
        disposeUsageCache();

        // 释放使用时间统计：停止采样并落盘，清理全局引用与结果缓存
        this.activityTracker?.dispose();
        this.activityTracker = undefined;
        setGlobalActivityTracker(null);
        disposeActivityStatsCache();

        log.info('disposed');
    }
    
    /**
     * 发送响应到前端
     */
    private sendResponse(requestId: string, data: any) {
        this.postRoutedWebviewMessage(WEBVIEW_CLIENT_IDS.mainChat, {
            type: 'response',
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
            type: 'error',
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
            return;
        }

        this.postRoutedWebviewMessage(WEBVIEW_CLIENT_IDS.mainChat, {
            type: 'command',
            command,
            data
        }, this._view.webview);
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
        options?: { overwriteChannelConfigs?: boolean; overwriteMcpServers?: boolean; overwriteSkills?: boolean }
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

    private buildBuiltinSoundAssets(webview: vscode.Webview): Record<string, { url: string; name: string }> {
        try {
            const soundDir = path.join(this.context.extensionPath, 'resources', 'sound');
            if (!fs.existsSync(soundDir)) {
                return {};
            }

            const files = fs.readdirSync(soundDir).filter(f => f.toLowerCase().endsWith('.mp3'));
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
        const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined;
        const nonce = randomBytes(16).toString('base64');
        const cspContent = this.buildCsp(webview, nonce, devServerOrigin);
        // VS Code 配置读取是同步的：在 HTML 首帧中冻结开屏偏好，避免前端再等 getSettings IPC。
        const uiConfig = vscode.workspace.getConfiguration('graycode').get<unknown>('ui');
        const startupSplashEnabled = resolveStartupSplashEnabled(uiConfig);
        const startupBootstrapScript = `<script nonce="${nonce}">${buildStartupPreferenceAssignment(startupSplashEnabled)}</script>`;
        const startupBootstrapStyles = `<style>${buildStartupBootstrapStyles(iconUri.toString())}</style>`;
        const startupBootstrapMarkup = buildStartupBootstrapMarkup(startupSplashEnabled);
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
