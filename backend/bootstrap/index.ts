/**
 * GrayCode 后端组合根（第六批 P6.1：组合根下沉）
 *
 * 职责：把 ChatViewProvider.initializeBackend 内联的 31 步后端装配下沉到这里，
 * 按子系统分组为阶段函数。每个阶段函数显式接收依赖参数（依赖注入），
 * 阶段内部不读取 setGlobal 系列单例——全局引用统一在本类设置。
 * webview 层只保留生命周期/消息路由/HTML/事件转发，经 BackendRuntimeHooks 注入回调。
 *
 * 阶段顺序（真实依赖，勿重排）：
 *   1. settings 最先：存储路径等一切配置来自它（原 L266）
 *   2. skills 必须先于工具注册（read_skill 工具描述需要 SkillsManager，原 L371）
 *   3. 工具注册必须先于 ChannelManager（工具声明经 ToolDeclarationResolver 注入，原 L380）
 *   4. ChannelManager 先于 Checkpoint/API Handlers；MCP 先于 subagent executor context
 *   5. dispose 检查（F2）在依赖尾段与消息路由器之间：deactivate 时中止后续跨生命周期资源
 *
 * 幂等/重试语义：
 *   失败时 initialize() 会先 dispose() 已建立的订阅/资源再抛错（回滚），
 *   因此 graycode.retryInit 可在任意阶段安全重跑——不再依赖“早期失败时后续订阅未建立”的假设。
 *   （原实现不清理，后期失败重试会叠加订阅；此为有意的行为修正，见 P6.1 汇报。）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { PUSH_MESSAGE_NAMES } from '../../shared/protocol';
import { Logger } from '../core/logger';
import {
    ConversationManager,
    FileSystemStorageAdapter,
    FileUsageIndexStore,
    DiffStorageManager
} from '../modules/conversation';
import {
    BranchGraphRepository,
    BranchService,
    getGlobalBranchService,
    setGlobalBranchService
} from '../modules/conversation/branch';
import { ConfigManager, MementoStorageAdapter } from '../modules/config';
import { ChannelManager } from '../modules/channel';
import { ChatHandler } from '../modules/api/chat';
import { ModelsHandler } from '../modules/api/models';
import {
    SettingsManager,
    VSCodeSettingsStorage,
    StoragePathManager
} from '../modules/settings';
import type { SettingsChangeEvent } from '../modules/settings';
import { SettingsHandler } from '../modules/api/settings';
import { CheckpointManager } from '../modules/checkpoint';
import { McpManager, VSCodeFileSystemMcpStorageAdapter } from '../modules/mcp';
import { DependencyManager, type InstallProgressEvent } from '../modules/dependencies';
import {
    toolRegistry,
    registerAllTools,
    onTerminalOutput,
    onImageGenOutput,
    TaskManager,
    setSubAgentExecutorContext,
    getDiffManager,
    hasAvailableSubAgent
} from '../tools';
import type { TerminalOutputEvent, ImageGenOutputEvent, TaskEvent } from '../tools';
import { registerToolDeclarationFactory, assertToolDeclarationFactories } from '../tools/toolDeclarationRegistry';
import { createReadFileTool } from '../tools/file/read_file';
import {
    createGenerateImageTool,
    createRemoveBackgroundTool,
    createCropImageTool,
    createResizeImageTool,
    createRotateImageTool
} from '../tools/media';
import { createWriteFileTool } from '../tools/file/write_file';
import { createListFilesTool } from '../tools/file/list_files';
import { createDeleteFileTool } from '../tools/file/delete_file';
import { createCreateDirectoryTool } from '../tools/file/create_directory';
import { createInsertCodeTool } from '../tools/file/insert_code';
import { createDeleteCodeTool } from '../tools/file/delete_code';
import { createApplyDiffTool } from '../tools/file/diff/declaration';
import { createSearchInFilesTool } from '../tools/search/declaration';
import { createFindFilesTool } from '../tools/search/find_files';
import { createGetSymbolsTool } from '../tools/lsp/get_symbols';
import { createGotoDefinitionTool } from '../tools/lsp/goto_definition';
import { createFindReferencesTool } from '../tools/lsp/find_references';
import { createExecuteCommandTool } from '../tools/terminal/processRunner';
import { createHistorySearchTool } from '../tools/history/history_search';
import { getReadSkillTool } from '../tools/skills/readSkill';
import { createSubAgentsTool } from '../tools/subagents/subagents';
import { createAgentSendMessageTool } from '../tools/subagents/agentSendMessage';
import { createSkillsManager, getSkillsManager } from '../modules/skills';
import { initMemoryManager } from '../modules/memory';
import { registerMaintenanceCommands } from '../tools/maintenance/commands';
import { UpdateChecker } from '../modules/update';
import { ActivityTracker, setGlobalActivityTracker } from '../modules/activity';
import { TokenizerResourceManager, setGlobalTokenizerResourceManager } from '../modules/tokenizer';
import {
    setGlobalSettingsManager,
    getGlobalSettingsManager,
    setGlobalConfigManager,
    getGlobalConfigManager,
    setGlobalChannelManager,
    getGlobalChannelManager,
    setGlobalToolRegistry,
    getGlobalToolRegistry,
    setGlobalDiffStorageManager,
    getGlobalDiffStorageManager,
    setGlobalMcpManager,
    getGlobalMcpManager
} from '../core/settingsContext';
import { WindowsAgentStopNotificationService } from '../modules/notifications';
import { setSubAgentAvailabilityQuery } from '../core/subAgentAvailabilityBridge';

const log = Logger.get('backend/bootstrap');
const UPDATE_CHECK_DELAY_MS = 10_000;
/**
 * TaskManager 泄漏任务周期清扫间隔（发现 01）：abort 后未注销 / 驻留超 30 分钟的任务，
 * 正常运行期间兜底补发 cancelled 终态并移除（dispose 时同步 clearInterval）。
 */
const TASK_CLEANUP_INTERVAL_MS = 60_000;

/** ChannelManager 重试状态（与 modules/channel RetryStatusCallback 结构一致，避免穿透导入） */
export interface BackendRetryStatus {
    type: 'retrying' | 'retrySuccess' | 'retryFailed';
    attempt: number;
    maxAttempts: number;
    error?: string;
    errorDetails?: any;
    nextRetryIn?: number;
    createdAt: number;
    conversationId?: string;
}

/** webview 层注入的回调（bootstrap 不 import webview，全部经此接口反向注入） */
export interface BackendRuntimeHooks {
    /** dispose() 已调用：初始化尾段必须中止（F2，防跨生命周期资源） */
    isDisposed(): boolean;
    /** 推送命令到 webview（settings 变更即时生效等） */
    sendCommand(command: string, data?: unknown): void;
    /** ChannelManager 渠道重试状态回调 → webview 推送 retryStatus */
    handleRetryStatus(status: BackendRetryStatus): void;
    /** 终端输出事件订阅回调 */
    handleTerminalOutputEvent(event: TerminalOutputEvent): void;
    /** 图像生成输出事件订阅回调 */
    handleImageGenOutputEvent(event: ImageGenOutputEvent): void;
    /** 统一任务事件订阅回调（AI 工作在场判定 + 前端推送） */
    handleTaskEvent(event: TaskEvent): void;
    /** 依赖安装进度事件订阅回调 */
    handleDependencyProgressEvent(event: InstallProgressEvent): void;
    /** 同步 UI 语言到后端 i18n（initConfig 阶段，settingsManager 已就绪） */
    syncLanguageToBackend(settingsManager: SettingsManager): void;
    /** 创建消息路由器（webview 层 MessageRouter；本类不持有，创建后存入 webview 字段） */
    createMessageRouter(): void;
    /** 初始化子代理 registry（webview 层装配 HandlerContext 后调用 SubAgentsHandlers） */
    initializeSubAgents(): void;
    /** 创建 SubAgent Monitor 面板（webview 层） */
    createSubAgentMonitorPanel(conversationManager: ConversationManager): void;
}

export class BackendRuntime {
    // —— 管理器引用（初始化完成后由 webview 层同步到自身字段，见 ChatViewProvider.initializeBackend） ——
    settingsManager!: SettingsManager;
    windowsAgentStopNotificationService?: WindowsAgentStopNotificationService;
    storagePathManager!: StoragePathManager;
    conversationStorageAdapter?: FileSystemStorageAdapter;
    diffStorageManager!: DiffStorageManager;
    conversationManager!: ConversationManager;
    branchService?: BranchService;
    configManager!: ConfigManager;
    channelManager!: ChannelManager;
    checkpointManager!: CheckpointManager;
    chatHandler!: ChatHandler;
    modelsHandler!: ModelsHandler;
    settingsHandler!: SettingsHandler;
    mcpManager!: McpManager;
    activityTracker?: ActivityTracker;
    updateChecker?: UpdateChecker;
    dependencyManager!: DependencyManager;

    /** 已建立订阅/资源的清理函数（失败回滚与 dispose 共用；按注册顺序执行） */
    private readonly cleanupFns: Array<() => void> = [];
    /** 延迟更新检查定时器（重试/回滚/dispose 时清理） */
    private updateCheckTimer?: NodeJS.Timeout;
    /** TaskManager 泄漏任务周期清扫定时器（dispose/回滚时清理；初始化成功后重建，重试幂等） */
    private taskCleanupTimer?: NodeJS.Timeout;
    /** graycode.runIntegrityCheck 命令注册 disposable（重试初始化前先注销旧注册） */
    private maintenanceCommandDisposable?: vscode.Disposable;
    /** 完整性检查输出通道（VSCode createOutputChannel 同名复用，重试不重建） */
    private integrityOutputChannel?: vscode.OutputChannel;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly hooks: BackendRuntimeHooks
    ) {}

    /** 记录一个需要随失败回滚/dispose 清理的订阅或资源 */
    private trackCleanup(fn: () => void): void {
        this.cleanupFns.push(fn);
    }

    private clearUpdateCheckTimer(): void {
        if (this.updateCheckTimer !== undefined) {
            clearTimeout(this.updateCheckTimer);
            this.updateCheckTimer = undefined;
        }
    }

    private clearTaskCleanupTimer(): void {
        if (this.taskCleanupTimer !== undefined) {
            clearInterval(this.taskCleanupTimer);
            this.taskCleanupTimer = undefined;
        }
    }

    /**
     * 执行全部阶段。可重入：失败时已建立的订阅会回滚清理，重试（graycode.retryInit）可安全重跑。
     */
    async initialize(): Promise<void> {
        // 先清理上一轮延迟更新检查定时器：重试初始化会再次进入本方法（F2）
        this.clearUpdateCheckTimer();

        try {
            await this.initSettings();                          // 1
            await this.initStorage(this.settingsManager);       // 2-5
            this.initConversation(                              // 6, 6.1
                this.storagePathManager,
                this.conversationStorageAdapter!
            );
            this.initConfig(this.settingsManager);              // 7, 8, 9, 9.1
            await this.initTools(                               // 11, 11.1, 12
                this.settingsManager,
                this.storagePathManager
            );
            this.initChannel(this.configManager);               // 13-15
            await this.initCheckpoint(                          // 16
                this.settingsManager,
                this.conversationManager,
                this.storagePathManager
            );
            this.initMaintenanceCommands();                      // MIG-05：手动完整性检查诊断命令
            this.initHandlers(                                  // 17-22
                this.configManager,
                this.channelManager,
                this.conversationManager,
                this.checkpointManager,
                this.settingsManager
            );
            await this.initMcp(this.storagePathManager);        // 23-25.5
            await this.initMemory(this.storagePathManager);     // 25.6
            this.initActivity(this.storagePathManager);         // 25.65
            this.initTokenizer(this.storagePathManager);        // 25.66
            this.initSubAgentExecutor(                          // 25.7
                this.channelManager,
                this.mcpManager,
                this.settingsManager,
                this.configManager,
                this.chatHandler,
                this.conversationManager
            );
            this.initUpdate(this.settingsManager);              // 25.75
            const continueInit = await this.initDependencies(this.storagePathManager); // 26 + F2 检查 + 27-28
            if (!continueInit) {
                // dispose() 已调用：尾段（29-31）中止（F2）
                return;
            }
            this.initMessageRouter();                           // 29
            this.initSubAgents();                               // 30 + 30.5 + 31
        } catch (error) {
            // 失败回滚：清理本阶段之前已建立的订阅/资源，使重试可在任意阶段安全重跑。
            // （原实现不清理，依赖“失败通常发生在早期、订阅未建立”的假设；下沉后显式清理）
            this.dispose();
            throw error;
        }

        log.info('backend_initialized', {
            effectiveDataPath: this.storagePathManager.getEffectiveDataPath()
        });
    }

    // ============ 阶段函数（按依赖顺序，勿重排） ============

    /** 1. 设置管理器（最先：存储路径等一切配置来自它；依赖：context/hooks 构造注入） */
    private async initSettings(): Promise<void> {
        const legacySettingsDir = path.join(this.context.globalStorageUri.fsPath, 'settings');
        const settingsStorage = new VSCodeSettingsStorage({
            legacySettingsDir
        });
        this.settingsManager = new SettingsManager(settingsStorage);
        await this.settingsManager.initialize();
        this.windowsAgentStopNotificationService = new WindowsAgentStopNotificationService({ settingsManager: this.settingsManager });
    }

    /** 2-5. 存储路径管理器 + 存储适配器 + Diff 存储管理器（前置：settingsManager） */
    private async initStorage(settingsManager: SettingsManager): Promise<void> {
        this.storagePathManager = new StoragePathManager(settingsManager, this.context);
        await this.storagePathManager.ensureDirectories();

        // 有效数据存储路径（可能是自定义路径）
        const effectiveDataUri = this.storagePathManager.getEffectiveDataUri();
        this.conversationStorageAdapter = new FileSystemStorageAdapter(vscode, effectiveDataUri);

        // Diff 存储管理器（apply_diff 的大文件内容抽离）
        this.diffStorageManager = DiffStorageManager.initialize(this.storagePathManager.getEffectiveDataPath());
        setGlobalDiffStorageManager(this.diffStorageManager);
    }

    /** 6, 6.1. 对话管理器 + 分支服务 + 后台旧历史迁移（前置：storagePathManager / storageAdapter） */
    private initConversation(
        storagePathManager: StoragePathManager,
        storageAdapter: FileSystemStorageAdapter
    ): void {
        // 对话管理器（附带用量索引：消息落盘时维护 token 明细，统计页免全量扫描）
        this.conversationManager = new ConversationManager(
            storageAdapter,
            new FileUsageIndexStore(vscode, storagePathManager.getEffectiveDataUri())
        );

        // 分支图同步是普通追加与总结写入的后台职责，不能依赖用户先打开分支面板才初始化。
        // 本次实故障由已结束的空 reroll 占位冻结同步触发；这里额外封堵窗口重载后已有 sidecar
        // 但全局服务尚未懒创建的独立复发路径。懒解析 handler 会复用这个实例。
        this.branchService = new BranchService(
            this.conversationManager,
            new BranchGraphRepository(storagePathManager.getEffectiveDataPath())
        );
        setGlobalBranchService(this.branchService);

        // 后台迁移旧版单文件历史到分段存储格式，不阻塞主初始化链路
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
    }

    /** 7-9.1. 配置管理器 + 语言同步 + 全局引用 + 设置变更监听（前置：settingsManager） */
    private initConfig(settingsManager: SettingsManager): void {
        // 配置管理器（使用 Memento 存储）
        this.configManager = new ConfigManager(
            new MementoStorageAdapter(this.context.globalState, 'graycode.configs')
        );

        // 同步语言设置到后端 i18n
        this.hooks.syncLanguageToBackend(settingsManager);

        // 设置全局上下文引用（供工具和其他模块访问）
        setGlobalSettingsManager(settingsManager);
        setGlobalConfigManager(this.configManager);
        setGlobalToolRegistry(toolRegistry);

        // 监听设置变更：apply_diff 自动应用开关/延迟变更时，让现有 pending diff 立即生效
        const settingsChangeListener = (event: SettingsChangeEvent) => {
            // 更新渠道（stable/nightly）切换：清除旧渠道的更新检查缓存（内存状态 + 节流时间戳），
            // 使下一次检查按新渠道重新拉取，避免 stable 用户看到旧渠道残留的 Nightly 徽章/可安装项
            // （例如先切到 nightly 触发检查得到 updateAvailable，再切回 stable 仍提示安装 nightly 构建）。
            // SettingsChangeEvent 已声明 oldValue?: any，无需 (event as any) 断言（F12）
            if (event.type === 'full' && event.oldValue?.updateChannel !== undefined &&
                event.settings?.updateChannel !== undefined &&
                event.oldValue?.updateChannel !== event.settings?.updateChannel) {
                try {
                    this.updateChecker?.resetStatus();
                } catch (e) {
                    console.warn('[bootstrap] Failed to reset update checker status:', e);
                }
            }
            if (event.type === 'tools' && event.path === 'toolsConfig.apply_diff') {
                try {
                    // 对已存在的 pending diff 重新调度/取消自动保存
                    getDiffManager().refreshAutoSaveTimers();
                } catch (e) {
                    console.warn('[bootstrap] Failed to refresh diff autoSave timers:', e);
                }

                // 推送最新配置到前端（用于更新倒计时/自动确认 UI）
                try {
                    const config = event.settings?.toolsConfig?.apply_diff || settingsManager.getApplyDiffConfig();
                    this.hooks.sendCommand(PUSH_MESSAGE_NAMES['tools.applyDiffConfigChanged'], { config });
                } catch {
                    // ignore
                }
            }
        };
        settingsManager.addChangeListener(settingsChangeListener);
        this.trackCleanup(() => settingsManager.removeChangeListener(settingsChangeListener));
    }

    /** 11-12. Skills 管理器（必须先于工具注册）+ 状态同步 + 注册全部工具（前置：settingsManager/storagePathManager） */
    private async initTools(
        settingsManager: SettingsManager,
        storagePathManager: StoragePathManager
    ): Promise<void> {
        await createSkillsManager({
            workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            globalStoragePath: storagePathManager.getEffectiveDataPath(),
        });

        // 从 settingsManager 同步 skills 状态到 SkillsManager
        await this.syncSkillsState(settingsManager);

        // 注册所有工具到工具注册器（必须在 ChannelManager 之前）。
        // 先清空再注册：重试初始化（graycode.retryInit）会再次走到这里，
        // 避免同一工具被重复注册导致声明重复/覆盖异常（F11）。
        // 09 批 M5 固化：clear() 的「全量重注册」假设仅适用于下方 registerAllTools 的
        // 纯静态注册——任何未来新增的动态注册（不经过 registerAllTools）必须放在 clear()
        // 之后执行，否则会被清掉；注册表内其余索引（alias/registrations）同步清空。
        toolRegistry.clear();
        registerAllTools(toolRegistry);

        // 注册动态工具声明工厂（read_file 多模态描述 / 图片工具参数），
        // 供 ToolDeclarationResolver 反向获取（modules 层不直接依赖工具工厂实现）。
        // 幂等：覆盖式注册，重试初始化重复调用安全；工厂懒创建，每次解析重建动态声明，
        // 语义与改造前直连 createXxxTool 一致。
        // R7 固化：工厂注册必须先于任何 resolver 调用（当前 init 顺序 settings→skills→
        // tools→channel 保证安全）。若未来有代码在 initTools 之前解析声明（import 期
        // 副作用/测试），read_file 多模态描述与图片工具参数会**静默回退静态声明**
        // （getToolDeclarationFactory 返回 undefined），表现为「某些配置下工具描述不更新」。
        registerToolDeclarationFactory('read_file', (args) => createReadFileTool(args.multimodalEnabled, args.channelType, args.toolMode));
        registerToolDeclarationFactory('generate_image', (args) => createGenerateImageTool(args.maxBatchTasks, args.maxImagesPerTask, args.paramsConfig));
        registerToolDeclarationFactory('remove_background', (args) => createRemoveBackgroundTool(args.maxBatchTasks));
        registerToolDeclarationFactory('crop_image', (args) => createCropImageTool(args.maxBatchTasks, { useNormalizedCoordinates: args.useNormalizedCoordinates }));
        registerToolDeclarationFactory('resize_image', (args) => createResizeImageTool(args.maxBatchTasks));
        registerToolDeclarationFactory('rotate_image', (args) => createRotateImageTool(args.maxBatchTasks));

        // 模型工具声明国际化：为 17 个半动态工具注册声明工厂（M-i18n）。
        // 描述语言（zh-CN → 中文，en/ja → 英文）与动态信息（工作区列表、shell 列表、
        // 技能列表、代理列表、MAX_HOP_DEPTH、截断行数等）由工厂每次调用时重新构建，
        // 语言切换后 resolver 按需重建声明；这些工具不依赖解析选项，factory 忽略 args。
        // 懒创建：每次调用重建，不要缓存（语义与 read_file/图片工具注册一致）。
        registerToolDeclarationFactory('write_file', () => createWriteFileTool());
        registerToolDeclarationFactory('list_files', () => createListFilesTool());
        registerToolDeclarationFactory('delete_file', () => createDeleteFileTool());
        registerToolDeclarationFactory('create_directory', () => createCreateDirectoryTool());
        registerToolDeclarationFactory('insert_code', () => createInsertCodeTool());
        registerToolDeclarationFactory('delete_code', () => createDeleteCodeTool());
        registerToolDeclarationFactory('apply_diff', () => createApplyDiffTool());
        registerToolDeclarationFactory('search_in_files', () => createSearchInFilesTool());
        registerToolDeclarationFactory('find_files', () => createFindFilesTool());
        registerToolDeclarationFactory('get_symbols', () => createGetSymbolsTool());
        registerToolDeclarationFactory('goto_definition', () => createGotoDefinitionTool());
        registerToolDeclarationFactory('find_references', () => createFindReferencesTool());
        registerToolDeclarationFactory('execute_command', () => createExecuteCommandTool());
        registerToolDeclarationFactory('history_search', () => createHistorySearchTool());
        registerToolDeclarationFactory('read_skill', () => getReadSkillTool());
        registerToolDeclarationFactory('subagents', () => createSubAgentsTool());
        registerToolDeclarationFactory('agent_send_message', () => createAgentSendMessageTool());

        // 注册 SubAgent 可用性查询（A1：modules 层经 core 桥读取，tools 层实现在组合根注入）。
        // 幂等：覆盖式注册，重试初始化重复调用安全；查询函数在工具声明解析时才执行，
        // 语义与改造前 ToolDeclarationResolver 直连 hasAvailableSubAgent 一致。
        setSubAgentAvailabilityQuery(hasAvailableSubAgent);

        // 动态声明自检（发现 15）：工厂注册完成后断言「声明含 getter 的工具」都有工厂，
        // 防止注释清单与注册漂移导致 resolver 静默回退静态声明（描述不更新而非报错）。
        assertToolDeclarationFactories(toolRegistry.getAllTools());
    }

    /** 11.1. 同步 skills 启用状态（settings 无记录的新 Skill 默认启用） */
    private async syncSkillsState(settingsManager: SettingsManager): Promise<void> {
        try {
            const skillsManager = getSkillsManager();
            if (!skillsManager) {
                return;
            }

            const savedConfig = settingsManager.getSkillsConfig() || { skills: [] };
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
            console.error('[bootstrap] Failed to sync skills state:', error);
        }
    }

    /** 13-15. 渠道管理器 + 重试状态回调 + 全局引用（前置：configManager/toolRegistry/settingsManager） */
    private initChannel(configManager: ConfigManager): void {
        this.channelManager = new ChannelManager(configManager, toolRegistry, this.settingsManager);

        // 设置重试状态回调
        this.channelManager.setRetryStatusCallback((status) => {
            this.hooks.handleRetryStatus(status);
        });

        setGlobalChannelManager(this.channelManager);
    }

    /** 16. 检查点管理器（前置：settingsManager/conversationManager/storagePathManager） */
    private async initCheckpoint(
        settingsManager: SettingsManager,
        conversationManager: ConversationManager,
        storagePathManager: StoragePathManager
    ): Promise<void> {
        this.checkpointManager = new CheckpointManager(
            settingsManager,
            conversationManager,
            this.context,
            storagePathManager.getEffectiveDataPath()
        );
        await this.checkpointManager.initialize();
    }

    /** 16.1 MIG-05：注册手动完整性检查诊断命令（graycode.runIntegrityCheck，前置：storagePathManager/checkpointManager/branchService） */
    private initMaintenanceCommands(): void {
        // 重试安全：重复 initialize 前先注销旧注册，避免同 id 命令叠加
        this.maintenanceCommandDisposable?.dispose();
        this.maintenanceCommandDisposable = undefined;
        const outputChannel = this.integrityOutputChannel ?? vscode.window.createOutputChannel('GrayCode: Integrity Check');
        this.integrityOutputChannel = outputChannel;
        this.maintenanceCommandDisposable = registerMaintenanceCommands({
            getStoragePath: () => this.storagePathManager.getEffectiveDataPath(),
            getCheckpointsDir: () => this.checkpointManager.checkpointsDir,
            getBranchValidator: () => {
                const service = getGlobalBranchService();
                return service
                    ? (conversationId: string) => service.validateActivePathMatchesHistory(conversationId)
                    : undefined;
            },
            outputChannel
        });
        this.trackCleanup(() => {
            this.maintenanceCommandDisposable?.dispose();
            this.maintenanceCommandDisposable = undefined;
        });
    }

    /** 17-22. API 处理器（Chat/Models/Settings）+ 工具事件订阅（前置：channelManager/checkpointManager 等） */
    private initHandlers(
        configManager: ConfigManager,
        channelManager: ChannelManager,
        conversationManager: ConversationManager,
        checkpointManager: CheckpointManager,
        settingsManager: SettingsManager
    ): void {
        // 聊天处理器（传入工具注册器和检查点管理器）
        this.chatHandler = new ChatHandler(
            configManager,
            channelManager,
            conversationManager,
            toolRegistry
        );
        this.chatHandler.setCheckpointManager(checkpointManager);
        this.chatHandler.setSettingsManager(settingsManager);

        // 模型管理处理器
        this.modelsHandler = new ModelsHandler(configManager, settingsManager);

        // 设置处理器（传入工具注册器）
        this.settingsHandler = new SettingsHandler(settingsManager, toolRegistry);
        this.settingsHandler.setConversationManager(conversationManager);

        // 订阅终端输出事件
        this.trackCleanup(onTerminalOutput((event) => {
            this.hooks.handleTerminalOutputEvent(event);
        }));

        // 订阅图像生成输出事件
        this.trackCleanup(onImageGenOutput((event) => {
            this.hooks.handleImageGenOutputEvent(event);
        }));

        // 订阅统一任务事件（用于未来扩展）
        this.trackCleanup(TaskManager.onTaskEvent((event) => {
            this.hooks.handleTaskEvent(event);
        }));

        // TaskManager 泄漏兜底周期清扫（发现 01）：cleanup() 此前只在 dispose 执行一次，
        // 「已取消未注销」与「驻留超 30 分钟」的任务在正常运行期间永远残留。
        // 挂在正常运行期的心跳上，每分钟清扫一次；dispose/失败回滚时由 clearTaskCleanupTimer 清理。
        // 重试幂等：仅当不存在时创建（回滚已清理，重试再建）。
        if (this.taskCleanupTimer === undefined) {
            this.taskCleanupTimer = setInterval(() => {
                try {
                    TaskManager.cleanup();
                } catch (error) {
                    log.warn('task_cleanup_sweep_failed', { error: error?.message || String(error) });
                }
            }, TASK_CLEANUP_INTERVAL_MS);
        }
    }

    /** 23-25.5. MCP 管理器 + 接线 Channel/Chat + 全局引用（前置：storagePathManager/channelManager/chatHandler） */
    private async initMcp(storagePathManager: StoragePathManager): Promise<void> {
        const mcpConfigDir = vscode.Uri.file(storagePathManager.getMcpPath());
        try {
            await vscode.workspace.fs.stat(mcpConfigDir);
        } catch {
            try {
                await vscode.workspace.fs.createDirectory(mcpConfigDir);
            } catch (error) {
                // 目录创建失败（只读/权限/路径非法）：不阻断扩展初始化，
                // MCP 管理器 initialize 自身有失败兜底（告警后以空配置继续）。
                console.error('[bootstrap] MCP config dir create failed:', error);
            }
        }
        const mcpConfigFile = vscode.Uri.joinPath(mcpConfigDir, 'servers.json');
        const mcpStorage = new VSCodeFileSystemMcpStorageAdapter(mcpConfigFile, vscode.workspace.fs);
        this.mcpManager = new McpManager(mcpStorage);
        try {
            await this.mcpManager.initialize();
        } catch (error) {
            // MCP 配置损坏/存储不可读（如 servers.json JSON 损坏）：不阻断扩展整体初始化——
            // 告警后以空配置继续，用户可在设置页重写配置（下次保存原子写回修复文件）。
            console.error('[bootstrap] MCP initialize failed, continuing with empty config:', error);
        }

        // 将 MCP 管理器连接到 ChannelManager（用于工具声明）
        this.channelManager.setMcpManager(this.mcpManager);

        // 将 MCP 管理器连接到 ChatHandler（用于工具调用）
        this.chatHandler.setMcpManager(this.mcpManager);

        // 设置全局 MCP 管理器（用于 subagents 工具描述）
        setGlobalMcpManager(this.mcpManager);
    }

    /** 25.6. MemoryManager（永久记忆系统，含工作区记忆作用域支持） */
    private async initMemory(storagePathManager: StoragePathManager): Promise<void> {
        await initMemoryManager(storagePathManager.getEffectiveDataPath());
    }

    /** 25.65. 使用时间统计追踪器（活跃采样：心跳 + 用户活动事件，按天落盘） */
    private initActivity(storagePathManager: StoragePathManager): void {
        const activityTracker = new ActivityTracker(
            path.join(storagePathManager.getEffectiveDataPath(), 'activity')
        );
        activityTracker.start();
        this.activityTracker = activityTracker;
        setGlobalActivityTracker(activityTracker);
        // dispose 末尾（释放段 25.65）统一执行 activityTracker.dispose()，这里只清理全局引用，
        // 避免同一 tracker 被 trackCleanup 与 dispose 末尾双重 dispose。
        this.trackCleanup(() => {
            setGlobalActivityTracker(null);
        });
    }

    /** 25.66. tokenizer 词表资源管理器（运行时下载 cl100k / DeepSeek 词表到数据目录） */
    private initTokenizer(storagePathManager: StoragePathManager): void {
        const tokenizerManager = new TokenizerResourceManager(storagePathManager.getTokenizerPath());
        setGlobalTokenizerResourceManager(tokenizerManager);
    }

    /** 25.7. SubAgent 执行器上下文（前置：channelManager/mcpManager/settingsManager/configManager/chatHandler/conversationManager） */
    private initSubAgentExecutor(
        channelManager: ChannelManager,
        mcpManager: McpManager,
        settingsManager: SettingsManager,
        configManager: ConfigManager,
        chatHandler: ChatHandler,
        conversationManager: ConversationManager
    ): void {
        setSubAgentExecutorContext({
            channelManager,
            toolRegistry: toolRegistry,
            mcpManager,
            settingsManager,
            configManager,
            toolExecutionService: chatHandler.getToolExecutionService(),
            // 修改原因：子代理 token 消耗需要归集到发起它的主会话用量统计（UsagePage）。
            // 修改方式：把 ConversationManager 的索引追加入口注入 SubAgent 执行上下文，
            //          executor 每轮 generate 后把 usageMetadata 以 source='subagent' 条目写入主会话索引。
            // 修改目的：用量统计包含子代理消耗，且不把子代理运行明细写入主历史。
            usageIndexAppend: (conversationId, messages) =>
                conversationManager.appendUsageIndexMessages(conversationId, messages)
        });
    }

    /** 25.75. 更新检查器（GitHub Releases 自动更新） */
    private initUpdate(settingsManager: SettingsManager): void {
        this.updateChecker = new UpdateChecker({
            // 用户可在设置页「通用」关闭自动检查（checkForUpdates !== false 默认开启）
            isCheckEnabled: () => settingsManager.getSettings().checkForUpdates !== false,
            // 更新渠道：stable 正式版 / nightly 每日构建（设置页「通用」可选）
            getUpdateChannel: () => settingsManager.getSettings().updateChannel ?? 'stable',
            // 复用渠道代理配置：GitHub API/下载在代理环境下同样走代理
            getProxyUrl: () => {
                const proxy = settingsManager.getSettings().proxy;
                return proxy?.enabled && proxy?.url ? proxy.url : undefined;
            },
            // 上次检查时间戳存扩展 globalState（内部状态，不参与 Settings Sync）
            storage: {
                get: (key) => this.context.globalState.get<number>(key),
                update: (key, value) => Promise.resolve(this.context.globalState.update(key, value)),
            },
            globalStoragePath: this.context.globalStorageUri.fsPath,
        });
    }

    /**
     * 26-28. 依赖管理器 + F2 dispose 检查 + 依赖检查器 + 进度订阅。
     * @returns false 表示 dispose() 已调用，初始化尾段（29-31）必须中止
     */
    private async initDependencies(storagePathManager: StoragePathManager): Promise<boolean> {
        this.dependencyManager = DependencyManager.getInstance(
            this.context,
            storagePathManager.getDependenciesPath()
        );
        await this.dependencyManager.initialize();

        // dispose() 后中止初始化尾段：deactivate 时 initialize 可能仍在进行，
        // 此后的步骤（依赖检查器/消息路由器/更新检查定时器/SubAgentMonitorPanel 等）均为同步副作用，
        // 继续执行会在扩展停用后留下跨生命周期资源（F2）
        if (this.hooks.isDisposed()) {
            log.warn('backend_init_aborted_after_dispose');
            return false;
        }

        // 设置依赖检查器到工具注册器（用于过滤未安装依赖的工具）
        toolRegistry.setDependencyChecker({
            isInstalled: (name: string) => this.dependencyManager!.isInstalledSync(name)
        });

        // 订阅依赖安装进度事件
        this.trackCleanup(this.dependencyManager.onProgress((event) => {
            this.hooks.handleDependencyProgressEvent(event);
        }));
        return true;
    }

    /** 29. 消息路由器（webview 层创建并持有；前置：chatHandler/conversationManager/settingsManager） */
    private initMessageRouter(): void {
        this.hooks.createMessageRouter();
    }

    /** 30-31. 子代理初始化 + 延迟更新检查 + SubAgent Monitor 面板（前置：messageRouter/conversationManager） */
    private initSubAgents(): void {
        // 初始化子代理（从持久化存储加载到内存 registry）
        this.hooks.initializeSubAgents();

        // 启动延迟更新检查（避开启动竞态；24h 节流在 UpdateChecker 内部处理，失败静默）
        this.updateCheckTimer = setTimeout(() => {
            if (!this.updateChecker) {
                log.warn('update_check_skipped_not_initialized');
                return;
            }
            this.updateChecker.check(false).catch(error => {
                log.warn('update_check_failed', { error: error?.message || String(error) });
            });
        }, UPDATE_CHECK_DELAY_MS);

        this.hooks.createSubAgentMonitorPanel(this.conversationManager);
    }

    // ============ 释放 ============

    /**
     * 释放后端资源。订阅清理顺序与旧 ChatViewProvider.dispose 保持一致：
     * 设置监听 → 终端/图像/任务/依赖订阅 → TaskManager 取消任务 → MCP → Skills
     * → 通知服务 → 分支全局 → 更新检查定时器 → 活动追踪。
     * 失败回滚（initialize 的 catch）复用本方法，保证重试前无残留订阅。
     */
    dispose(): void {
        for (const fn of this.cleanupFns.splice(0)) {
            try {
                fn();
            } catch (error) {
                log.warn('backend_dispose_cleanup_failed', { error: String(error) });
            }
        }

        // 取消所有活跃任务
        TaskManager.cancelAllTasks();

        // 停掉周期清扫定时器：dispose 末尾有同步 cleanup() 兜底，先清定时器避免竞态
        this.clearTaskCleanupTimer();

        // 清扫泄漏任务：cancelAllTasks 仅触发 abort 不删除条目，这里把已 abort 却未走
        // unregisterTask 注销（泄漏）的任务补发 cancelled 终态事件后移除，activeTasks 不留残项。
        // 幂等：unregisterTask 后续对已清理 ID 是安全 no-op；dispose 同时被失败回滚复用，重试安全。
        TaskManager.cleanup();

        // 释放 MCP 管理器资源（断开所有连接）
        this.mcpManager?.dispose();

        // 释放 Skills 管理器资源
        getSkillsManager()?.dispose();
        this.windowsAgentStopNotificationService?.dispose();

        if (getGlobalBranchService() === this.branchService) {
            setGlobalBranchService(undefined);
        }
        this.branchService = undefined;

        // 09 批 M2：失败回滚（initialize 的 catch 复用 dispose）后必须清空全部核心全局引用——
        // 否则 settings/config/channel/mcp/toolRegistry/diffStorage 仍指向半初始化对象，
        // 未重试窗口内被读取会拿到残缺实例。按「当前全局 === 本实例」匹配清理，
        // 避免误清后续实例已覆盖的引用；toolRegistry/tokenizer 为模块级单例/局部变量，
        // 无条件清空（与 activityTracker 同口径）；重试路径重新 setGlobal 覆盖，幂等。
        if (getGlobalSettingsManager() === this.settingsManager) {
            setGlobalSettingsManager(null);
        }
        if (getGlobalConfigManager() === this.configManager) {
            setGlobalConfigManager(null);
        }
        if (getGlobalChannelManager() === this.channelManager) {
            setGlobalChannelManager(null);
        }
        setGlobalToolRegistry(null);
        if (getGlobalDiffStorageManager() === this.diffStorageManager) {
            setGlobalDiffStorageManager(null);
        }
        if (getGlobalMcpManager() === this.mcpManager) {
            setGlobalMcpManager(null);
        }
        setGlobalTokenizerResourceManager(null);

        // 09 批 A1 桥：SubAgent 可用性查询全局引用（模块级单例，与 toolRegistry/tokenizer
        // 同口径无条件清空）。查询函数无状态、残留虽无害，但为与 M2 全局引用清理口径一致
        // 一并清空；清理后 hasAvailableSubAgentSafe() 回退 true（与未注册一致，宽松不隐藏
        // subagents 工具）；重试路径 initTools 重新注册，幂等。
        setSubAgentAvailabilityQuery(undefined);

        // 清理更新检查延迟任务
        this.clearUpdateCheckTimer();

        // 释放使用时间统计：停止采样并落盘，清理全局引用（结果缓存由 webview 层 disposeActivityStatsCache 清理）
        this.activityTracker?.dispose();
        this.activityTracker = undefined;
        setGlobalActivityTracker(null);
    }
}

/** 创建后端组合根（context 与 webview 钩子经构造注入；阶段函数不再取全局） */
export function createBackend(
    context: vscode.ExtensionContext,
    hooks: BackendRuntimeHooks
): BackendRuntime {
    return new BackendRuntime(context, hooks);
}