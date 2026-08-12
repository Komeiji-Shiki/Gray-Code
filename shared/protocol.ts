/**
 * GrayCode 跨端协议单一来源（B1）
 *
 * 本文件是前端（frontend/）与扩展侧（webview/、backend/）共享的
 * 「消息名常量 + 慢消息名单 + 跨端共享类型」的单一来源。
 *
 * 约束：
 * - 纯类型 + 常量，零运行时依赖，不 import 任何项目代码；
 * - 不包含任何业务逻辑；
 * - 本文件不依赖 Node / VS Code / DOM API（可被两端 tsconfig 与打包器直接消费）。
 *
 * 消费方式：
 * - webview/backend：相对路径 import '../../shared/protocol'（esbuild 自动处理，无需改配置）；
 * - frontend：路径别名 '@shared/protocol'（frontend/tsconfig.json paths +
 *   frontend/vite.config.ts / frontend/vitest.config.ts resolve.alias）。
 *
 * 维护约定：
 * - 新增/重命名跨端消息时，先改本文件的 MESSAGE_NAMES（webview → 扩展请求）或
 *   PUSH_MESSAGE_NAMES（扩展 → webview 推送），再改两端的注册/调用处；
 * - UNBOUNDED_REQUEST_TYPES 与 NON_BLOCKING_MESSAGE_TYPES 语义不同（超时豁免 vs
 *   fire-and-forget 非阻塞），禁止合并成一个 Set；修改时分别对照两端语义。
 */

// ============ 1. 消息名常量 ============

/**
 * 全部跨端消息名的单一来源（request 消息：前端 → 扩展）。
 *
 * 覆盖范围（第一阶段，共 203 个）：
 * - webview/handlers/* 注册表（registry.set / register 调用）中的全部消息名；
 * - StreamRequestHandler / MessageRouter 直连处理的流式消息（chatStream / retryStream /
 *   toolConfirmation / cancelStream，不在 handler 注册表）；
 * - ChatViewProvider 直连处理的 webviewReady（握手消息，不在 handler 注册表）；
 * - SubAgentMonitorPanel 直连处理的 Monitor 消息（subagents.monitorReady /
 *   subagents.monitor.getRunWindow，不在 handler 注册表）；
 *
 * 已覆盖：扩展 → webview 的推送消息名（postMessage 的 type：'command'、'response'、
 * 'error'、'streamChunkBatch'、'subagentMonitor.event' 等，以及 type:'command' 信封内的
 * command 名如 'startupFailed'/'windowFocusChanged'），见 PUSH_MESSAGE_NAMES——从
 * ChatViewProvider.postRoutedWebviewMessage / sendCommand、StreamChunkProcessor、
 * SubAgentMonitorPanel.postRoutedMessage、WebviewClientRegistry 等推送调用点机械提取；
 * webview/handlers 与 backend 中的推送调用点（storageMigrationProgress /
 * tools.applyDiffConfigChanged）也已改引用 PUSH_MESSAGE_NAMES。
 */
export const MESSAGE_NAMES = {
// ---- Activity ----
  'activity.getStats': 'activity.getStats',

// ---- 记忆 ----
  addMemoryEntry: 'addMemoryEntry',

// ---- 固定文件 ----
  addPinnedFile: 'addPinnedFile',

  cancelStream: 'cancelStream',
  cancelSummarizeRequest: 'cancelSummarizeRequest',

// ---- 聊天 ----
  'chat.awaitConversationIdle': 'chat.awaitConversationIdle',
  'chat.claimAgentMessages': 'chat.claimAgentMessages',
  'chat.editBranchStream': 'chat.editBranchStream',
  'chat.releaseAgentMessages': 'chat.releaseAgentMessages',
  'chat.rerollStream': 'chat.rerollStream',
  'chat.sendInterruptMessage': 'chat.sendInterruptMessage',

// ---- 聊天输入 ----
  'chatInput.focusState': 'chatInput.focusState',

// ---- 流式消息（StreamRequestHandler / MessageRouter 直连，不在 handler 注册表） ----
  chatStream: 'chatStream',

  checkAnnouncement: 'checkAnnouncement',
  checkPinnedFilesExistence: 'checkPinnedFilesExistence',
  checkSkillsExistence: 'checkSkillsExistence',
  checkUpdateNow: 'checkUpdateNow',
  checkWorkspaceFilesExist: 'checkWorkspaceFilesExist',

// ---- 检查点（CheckpointHandlers） ----
  'checkpoint.cancelOperation': 'checkpoint.cancelOperation',
  'checkpoint.createManual': 'checkpoint.createManual',
  'checkpoint.deleteBatch': 'checkpoint.deleteBatch',
  'checkpoint.getAllConversationsWithCheckpoints': 'checkpoint.getAllConversationsWithCheckpoints',
  'checkpoint.getCheckpoints': 'checkpoint.getCheckpoints',
  'checkpoint.getConfig': 'checkpoint.getConfig',
  'checkpoint.getExclusionProfiles': 'checkpoint.getExclusionProfiles',
  'checkpoint.getManifest': 'checkpoint.getManifest',
  'checkpoint.getOperationProgress': 'checkpoint.getOperationProgress',
  'checkpoint.previewExclusions': 'checkpoint.previewExclusions',
  'checkpoint.previewRestore': 'checkpoint.previewRestore',
  'checkpoint.restore': 'checkpoint.restore',
  'checkpoint.updateConfig': 'checkpoint.updateConfig',

// ---- 配置（ConfigHandlers） ----
  'config.createConfig': 'config.createConfig',
  'config.deleteConfig': 'config.deleteConfig',
  'config.getConfig': 'config.getConfig',
  'config.listConfigs': 'config.listConfigs',
  'config.updateConfig': 'config.updateConfig',

// ---- MCP ----
  connectMcpServer: 'connectMcpServer',

// ---- 会话/分支（ConversationHandlers / BranchHandlers） ----
  'conversation.createBranchConversation': 'conversation.createBranchConversation',
  'conversation.createConversation': 'conversation.createConversation',
  'conversation.deleteBranchCandidate': 'conversation.deleteBranchCandidate',
  'conversation.deleteConversation': 'conversation.deleteConversation',
  'conversation.getBranchGraph': 'conversation.getBranchGraph',
  'conversation.getBranchRetentionConfig': 'conversation.getBranchRetentionConfig',
  'conversation.getConversationMetadata': 'conversation.getConversationMetadata',
  'conversation.getConversationMetadataBatch': 'conversation.getConversationMetadataBatch',
  'conversation.getDeletedBranchCount': 'conversation.getDeletedBranchCount',
  'conversation.getMessagesPaged': 'conversation.getMessagesPaged',
  'conversation.listConversations': 'conversation.listConversations',
  'conversation.loadConversationForView': 'conversation.loadConversationForView',
  'conversation.pruneDeletedBranches': 'conversation.pruneDeletedBranches',
  'conversation.purgeBranchCandidate': 'conversation.purgeBranchCandidate',
  'conversation.rejectToolCalls': 'conversation.rejectToolCalls',
  'conversation.renameBranchCandidate': 'conversation.renameBranchCandidate',
  'conversation.restoreBranchCandidate': 'conversation.restoreBranchCandidate',
  'conversation.revealInExplorer': 'conversation.revealInExplorer',
  'conversation.setCustomMetadata': 'conversation.setCustomMetadata',
  'conversation.setWorkspaceUri': 'conversation.setWorkspaceUri',
  'conversation.switchBranchCandidate': 'conversation.switchBranchCandidate',
  'conversation.updateBranchRetentionConfig': 'conversation.updateBranchRetentionConfig',
  'conversation.updateSummary': 'conversation.updateSummary',

// ---- 系统提示词 ----
  countSystemPromptTokens: 'countSystemPromptTokens',

  createMcpServer: 'createMcpServer',
  deleteMcpServer: 'deleteMcpServer',
  deleteMemoryEntries: 'deleteMemoryEntries',
  deleteMemoryEntry: 'deleteMemoryEntry',
  deleteMessage: 'deleteMessage',
  deletePromptMode: 'deletePromptMode',
  deleteSingleMessage: 'deleteSingleMessage',

// ---- 依赖安装（DependencyHandlers） ----
  'dependencies.getInstallPath': 'dependencies.getInstallPath',
  'dependencies.install': 'dependencies.install',
  'dependencies.list': 'dependencies.list',
  'dependencies.uninstall': 'dependencies.uninstall',

// ---- 计划确认（PlanApprovalHandlers） ----
  'design.confirmPlanGeneration': 'design.confirmPlanGeneration',

// ---- Diff ----
  'diff.accept': 'diff.accept',
  'diff.loadContent': 'diff.loadContent',
  'diff.openPreview': 'diff.openPreview',
  'diff.reject': 'diff.reject',

  disconnectMcpServer: 'disconnectMcpServer',

// ---- 提示词模式 ----
  exportPromptModes: 'exportPromptModes',

  getActiveEditor: 'getActiveEditor',
  getAppInfo: 'getAppInfo',

  getContextAwarenessConfig: 'getContextAwarenessConfig',
  getDefaultSummarizeConfig: 'getDefaultSummarizeConfig',
  getGenerateImageConfig: 'getGenerateImageConfig',

  getMcpServers: 'getMcpServers',
  getMemoryConfig: 'getMemoryConfig',
  getMemoryEntries: 'getMemoryEntries',
  getOpenTabs: 'getOpenTabs',
  getPinnedFilesConfig: 'getPinnedFilesConfig',
  getPromptModes: 'getPromptModes',
  getRelativePath: 'getRelativePath',
  getSettings: 'getSettings',
  getSkillsConfig: 'getSkillsConfig',
  getSkillsDirectory: 'getSkillsDirectory',
  getSummarizeConfig: 'getSummarizeConfig',
  getSystemPromptConfig: 'getSystemPromptConfig',
  getUpdateStatus: 'getUpdateStatus',
  getWorkspaceUri: 'getWorkspaceUri',

// ---- 图像生成 ----
  'imageGeneration.cancel': 'imageGeneration.cancel',

// ---- 更新（UpdateHandlers） ----
  installUpdate: 'installUpdate',

  listMemoryScopes: 'listMemoryScopes',

// ---- 公告 ----
  markAnnouncementRead: 'markAnnouncementRead',

// ---- 模型 ----
  'models.addModels': 'models.addModels',
  'models.getModels': 'models.getModels',
  'models.removeModel': 'models.removeModel',
  'models.setActiveModel': 'models.setActiveModel',

// ---- 通知 ----
  'notifications.agentStop': 'notifications.agentStop',
  'notifications.preview': 'notifications.preview',

  openDirectory: 'openDirectory',
  openMcpConfigFile: 'openMcpConfigFile',
  openUpdatePage: 'openUpdatePage',
  openWorkspaceFile: 'openWorkspaceFile',
  openWorkspaceFileAt: 'openWorkspaceFileAt',

// ---- 计划（PlanApprovalHandlers） ----
  'plan.confirmExecution': 'plan.confirmExecution',
  'plan.getSourceStatus': 'plan.getSourceStatus',

// ---- 预览 ----
  previewAttachment: 'previewAttachment',

  readFileForContext: 'readFileForContext',
  readWorkspaceFileForInput: 'readWorkspaceFileForInput',
  readWorkspaceImage: 'readWorkspaceImage',
  readWorkspaceTextFile: 'readWorkspaceTextFile',
  refreshSkills: 'refreshSkills',

// ---- 窗口 ----
  reloadWindow: 'reloadWindow',

  removePinnedFile: 'removePinnedFile',
  removeSkillConfig: 'removeSkillConfig',
  renamePromptMode: 'renamePromptMode',

// ---- 总结 ----
  restoreSummarizedMessages: 'restoreSummarizedMessages',

  retryStream: 'retryStream',

// ---- 评审计划确认（PlanApprovalHandlers） ----
  'review.confirmPlanGeneration': 'review.confirmPlanGeneration',

  saveImageToPath: 'saveImageToPath',
  savePromptMode: 'savePromptMode',

// ---- 文件搜索 ----
  searchWorkspaceFiles: 'searchWorkspaceFiles',

  setCurrentPromptMode: 'setCurrentPromptMode',
  setMcpServerEnabled: 'setMcpServerEnabled',
  setPinnedFileEnabled: 'setPinnedFileEnabled',
  setSkillEnabled: 'setSkillEnabled',

// ---- 设置导入导出/渠道 ----
  'settings.export': 'settings.export',
  'settings.getActiveChannelId': 'settings.getActiveChannelId',
  'settings.import': 'settings.import',
  'settings.setActiveChannelId': 'settings.setActiveChannelId',

  showContextContent: 'showContextContent',
  showNotification: 'showNotification',

// ---- 存储路径（StoragePathHandlers） ----
  'storagePath.getConfig': 'storagePath.getConfig',
  'storagePath.migrate': 'storagePath.migrate',
  'storagePath.openInExplorer': 'storagePath.openInExplorer',
  'storagePath.reset': 'storagePath.reset',
  'storagePath.selectFolder': 'storagePath.selectFolder',
  'storagePath.validate': 'storagePath.validate',

// ---- 子代理（SubAgentsHandlers） ----
  'subagents.create': 'subagents.create',
  'subagents.delete': 'subagents.delete',
  'subagents.deleteRunMessage': 'subagents.deleteRunMessage',
  'subagents.exitRun': 'subagents.exitRun',
  'subagents.getPresets': 'subagents.getPresets',
  'subagents.list': 'subagents.list',
  // ---- 子代理监控（SubAgentMonitorPanel 直连，不在 handler 注册表） ----
  'subagents.monitor.getRunWindow': 'subagents.monitor.getRunWindow',
  'subagents.monitorReady': 'subagents.monitorReady',
  'subagents.openMonitor': 'subagents.openMonitor',
  'subagents.pauseRun': 'subagents.pauseRun',
  'subagents.resumeRun': 'subagents.resumeRun',
  'subagents.retryRunFromMessage': 'subagents.retryRunFromMessage',
  'subagents.update': 'subagents.update',
  'subagents.updateGlobalConfig': 'subagents.updateGlobalConfig',

  summarizeContext: 'summarizeContext',

// ---- 后台任务 ----
  'task.cancel': 'task.cancel',
  'task.getAll': 'task.getAll',

// ---- 终端 ----
  'terminal.detachToBackground': 'terminal.detachToBackground',
  'terminal.getOutput': 'terminal.getOutput',
  'terminal.kill': 'terminal.kill',

// ---- Tokenizer ----
  'tokenizer.getResource': 'tokenizer.getResource',

  toolConfirmation: 'toolConfirmation',

// ---- 工具（ToolHandlers） ----
  'tools.getAutoExecConfig': 'tools.getAutoExecConfig',
  'tools.getExecuteCommandConfig': 'tools.getExecuteCommandConfig',
  'tools.getFindFilesConfig': 'tools.getFindFilesConfig',
  'tools.getHistorySearchConfig': 'tools.getHistorySearchConfig',
  'tools.getMaxToolIterations': 'tools.getMaxToolIterations',
  'tools.getMcpTools': 'tools.getMcpTools',
  'tools.getSearchInFilesConfig': 'tools.getSearchInFilesConfig',
  'tools.getToolConfig': 'tools.getToolConfig',
  'tools.getTools': 'tools.getTools',
  'tools.setToolAutoExec': 'tools.setToolAutoExec',
  'tools.setToolEnabled': 'tools.setToolEnabled',
  'tools.updateApplyDiffConfig': 'tools.updateApplyDiffConfig',
  'tools.updateExecuteCommandConfig': 'tools.updateExecuteCommandConfig',
  'tools.updateFindFilesConfig': 'tools.updateFindFilesConfig',
  'tools.updateHistorySearchConfig': 'tools.updateHistorySearchConfig',
  'tools.updateListFilesConfig': 'tools.updateListFilesConfig',
  'tools.updateMaxToolIterations': 'tools.updateMaxToolIterations',
  'tools.updateSearchInFilesConfig': 'tools.updateSearchInFilesConfig',
  'tools.updateToolConfig': 'tools.updateToolConfig',

  updateContextAwarenessConfig: 'updateContextAwarenessConfig',
  updateGenerateImageConfig: 'updateGenerateImageConfig',
  updateMcpServer: 'updateMcpServer',
  updateMemoryConfig: 'updateMemoryConfig',
  updateMemoryEntry: 'updateMemoryEntry',
  updateNow: 'updateNow',
  updateProxySettings: 'updateProxySettings',
  updateSettings: 'updateSettings',
  updateSummarizeConfig: 'updateSummarizeConfig',
  updateSystemPromptConfig: 'updateSystemPromptConfig',
  updateUISettings: 'updateUISettings',

// ---- 用量 ----
  'usage.getStats': 'usage.getStats',

  validateMcpServerId: 'validateMcpServerId',
  validatePinnedFile: 'validatePinnedFile',

// ---- webview 握手（ChatViewProvider 直连，不在 handler 注册表） ----
  webviewReady: 'webviewReady',
} as const;

/** 消息名字面量联合类型（等价于 MESSAGE_NAMES 的全部值） */
export type MessageName = (typeof MESSAGE_NAMES)[keyof typeof MESSAGE_NAMES];

/**
 * 扩展 → webview 推送消息名的单一来源（postMessage 的 type 字段；
 * type:'command' 信封内另有 command 字段名）。
 *
 * 覆盖范围（第一阶段，共 20 个）：
 * - 推送信封类型：ChatViewProvider.postRoutedWebviewMessage / sendCommand、
 *   WebviewClientRegistry.sendResponse|sendError、StreamChunkProcessor、
 *   SubAgentMonitorPanel.postRoutedMessage、StoragePathHandlers 直连推送的 type；
 * - type:'command' 信封内的 command 名（startupRetrying / startupFailed /
 *   terminalOutput / imageGenOutput / taskEvent / dependencyProgress / retryStatus /
 *   diff.statusChanged / chat.restoreInputFocus / windowFocusChanged /
 *   input.addContext / tools.applyDiffConfigChanged）。
 *
 * 未收录（非传输层消息名，勿加）：StreamChunkProcessor 入队的 chunk 事件类型
 * （chunk / complete / cancelled / error / toolsExecuting / toolStatus /
 * awaitingConfirmation / toolIteration / autoSummaryStatus / autoSummary / checkpoints）
 * 是 streamChunkBatch 数据条目内的 payload 判别字段，不是 postMessage 的消息名。
 */
export const PUSH_MESSAGE_NAMES = {
// ---- 推送信封类型（postMessage 的 type 字段） ----
  command: 'command',
  response: 'response',
  error: 'error',
  streamChunk: 'streamChunk',
  streamChunkBatch: 'streamChunkBatch',
  'subagentMonitor.event': 'subagentMonitor.event',
  'subagentMonitor.manifest': 'subagentMonitor.manifest',
  storageMigrationProgress: 'storageMigrationProgress',

// ---- 推送命令名（type: 'command' 的 command 字段） ----
  startupRetrying: 'startupRetrying',
  startupFailed: 'startupFailed',
  terminalOutput: 'terminalOutput',
  imageGenOutput: 'imageGenOutput',
  taskEvent: 'taskEvent',
  dependencyProgress: 'dependencyProgress',
  retryStatus: 'retryStatus',
  'diff.statusChanged': 'diff.statusChanged',
  'chat.restoreInputFocus': 'chat.restoreInputFocus',
  windowFocusChanged: 'windowFocusChanged',
  'input.addContext': 'input.addContext',
  'tools.applyDiffConfigChanged': 'tools.applyDiffConfigChanged',
} as const;

/** 推送消息名字面量联合类型（等价于 PUSH_MESSAGE_NAMES 的全部值） */
export type PushMessageName = (typeof PUSH_MESSAGE_NAMES)[keyof typeof PUSH_MESSAGE_NAMES];

// ============ 2. 慢消息名单（两份语义不同，禁止合并） ============

/**
 * 不设通用超时的请求类型（前端 sendToExtension 的超时豁免名单）。
 *
 * 语义：命中此名单的请求不套用 DEFAULT_REQUEST_TIMEOUT_MS（180s）兜底超时，
 * 由调用方自行承担等待（或依赖后端自身超时）。原定义见
 * frontend/src/utils/vscode.ts（B1 起迁入本文件作为单一来源）。
 *
 * 典型场景：
 * - 流式对话：响应要等整轮工具循环跑完才回，时长由模型和工具决定；
 * - 依赖安装 / 存储迁移 / checkpoint.restore / deleteBatch / previewRestore：
 *   分钟级长任务，超时会让前端误判失败而后端在互斥锁内继续执行，导致重复操作；
 * - deleteMessage / deleteMemoryEntries：可能在后端互斥锁内等待其他回合收尾而超过 180s；
 * - 模态对话框类（exportPromptModes / settings.export / settings.import /
 *   storagePath.selectFolder）：对话框打开期间 promise 一直挂起；
 * - 网络/下载类（tokenizer.getResource / countSystemPromptTokens）。
 *
 * ⚠️ 与 NON_BLOCKING_MESSAGE_TYPES（非阻塞 fire-and-forget）语义不同，禁止合并。
 */
export const UNBOUNDED_REQUEST_TYPES = new Set<string>([
  MESSAGE_NAMES.chatStream,
  MESSAGE_NAMES.retryStream,
  MESSAGE_NAMES['chat.rerollStream'],
  MESSAGE_NAMES['chat.editBranchStream'],
  MESSAGE_NAMES.toolConfirmation,
  MESSAGE_NAMES.cancelStream,
  MESSAGE_NAMES.deleteMessage,
  MESSAGE_NAMES['dependencies.install'],
  MESSAGE_NAMES['dependencies.uninstall'],
  MESSAGE_NAMES['storagePath.migrate'],
  // storagePath.reset：重置回默认路径同样要搬迁整份数据（分钟级），超时会让前端误判失败
  MESSAGE_NAMES['storagePath.reset'],
  MESSAGE_NAMES['storagePath.selectFolder'],
  MESSAGE_NAMES['checkpoint.restore'],
  MESSAGE_NAMES['checkpoint.deleteBatch'],
  MESSAGE_NAMES['checkpoint.previewRestore'],
  // deleteMemoryEntries：批量删除记忆可能对交错 id 触发多次全量 LOG 重建（O(n·T)），
  // 大选择量下可能超过 180s；超时会让前端误判失败而后端已删，重试又因 id 失效报错（memory-review）
  MESSAGE_NAMES.deleteMemoryEntries,
  // 模态对话框类：对话框打开期间 promise 一直挂起，超时会让前端误报失败而对话框关闭后操作实际生效
  MESSAGE_NAMES.exportPromptModes,
  MESSAGE_NAMES['settings.export'],
  MESSAGE_NAMES['settings.import'],
  // installUpdate：下载 vsix + 安装为分钟级任务，超时会让前端误判失败而后端继续安装
  MESSAGE_NAMES.installUpdate,  // 网络/下载类：tokenizer 词表首次下载可达分钟级；token 计数调用渠道 API 受网络超时配置影响
  MESSAGE_NAMES['tokenizer.getResource'],
  MESSAGE_NAMES.countSystemPromptTokens,
  // summarizeContext：总结是长上下文 LLM 调用（分钟级），180s 前端超时会让误判失败后
  // 端继续总结，重试又叠加 token 消耗；与后端 stream 类请求同样豁免
  MESSAGE_NAMES.summarizeContext,
]);

/**
 * 非阻塞消息类型（webview MessageRouter 的 fire-and-forget 名单）。
 *
 * 语义：命中此名单的 handler 可能执行数秒到数分钟（LLM 请求、依赖安装、检查点扫描、
 * 模态对话框、网络下载/更新等），route() 采用 fire-and-forget——不 await handler，
 * catch 中就地清理 requestClients 并回传错误——避免串行 messageHandlingQueue 被
 * 长任务占死、导致取消类消息（cancelStream / checkpoint.cancelOperation / deleteMessage）
 * 全部排队、webview 消息通道整体冻结。原定义见 webview/MessageRouter.ts（B1 起迁入本文件）。
 *
 * ⚠️ 与 UNBOUNDED_REQUEST_TYPES（前端超时豁免）语义不同，禁止合并。
 */
export const NON_BLOCKING_MESSAGE_TYPES = new Set<string>([
  // Diff 接受/拒绝可能等待 checkpoint、文档保存和原生 Diff 标签关闭数秒。
  // 它们必须异步执行，否则一次点击会占住主 Webview 串行队列，后续设置、焦点和保存请求全部排队。
  MESSAGE_NAMES['diff.accept'],
  MESSAGE_NAMES['diff.reject'],
  MESSAGE_NAMES.summarizeContext,
  MESSAGE_NAMES['dependencies.install'],
  MESSAGE_NAMES['dependencies.uninstall'],
  MESSAGE_NAMES['storagePath.migrate'],
  // storagePath.reset：重置回默认路径要搬迁整份数据（分钟级），不应阻塞串行队列中的其它请求
  MESSAGE_NAMES['storagePath.reset'],
  // M-1: 检查点全量扫描/枚举可能耗时数秒到数分钟（大工作区），
  // 若在串行队列中 await 会阻塞 cancelStream / checkpoint.cancelOperation / 消息删除等全部 IPC
  MESSAGE_NAMES['checkpoint.previewExclusions'],
  MESSAGE_NAMES['checkpoint.getAllConversationsWithCheckpoints'],
  // 恢复/批量删除/预览恢复：分钟级长任务（大工作区全量扫描+复制），与 previewExclusions 同属
  // 检查点类慢操作，不应占住串行队列（期间 cancelStream / deleteMessage 等取消类消息全部排队）
  MESSAGE_NAMES['checkpoint.restore'],
  MESSAGE_NAMES['checkpoint.deleteBatch'],
  MESSAGE_NAMES['checkpoint.previewRestore'],
  // deleteMemoryEntries：批量删除可能触发多次全量 LOG 重建（O(n·T)），大选择量下分钟级
  MESSAGE_NAMES.deleteMemoryEntries,
  // Monitor 控制消息必须绕过普通 handler 队列；否则前面一次慢磁盘读取会让暂停/退出点击排队
  MESSAGE_NAMES['subagents.pauseRun'],
  MESSAGE_NAMES['subagents.resumeRun'],
  MESSAGE_NAMES['subagents.exitRun'],
  // 模态对话框类（showSaveDialog/showOpenDialog/showQuickPick）：对话框打开期间 handler 一直 await，
  // 若占住串行队列，后续保存/取消/新消息全部排队，前端 180s 超时误报失败（保存实际已生效）
  MESSAGE_NAMES.exportPromptModes,
  MESSAGE_NAMES['settings.export'],
  MESSAGE_NAMES['settings.import'],
  MESSAGE_NAMES['storagePath.selectFolder'],
  // 网络/下载类：耗时取决于网络状况，不应阻塞队列中的其它请求
  MESSAGE_NAMES.countSystemPromptTokens, // token 计数调用渠道 API
  MESSAGE_NAMES['tokenizer.getResource'], // 首次下载 tokenizer 词表（分钟级）
  // 更新检查/安装类（UpdateHandlers）：checkNow 含网络请求（checker.check），
  // updateNow 除检查外还含下载+安装（分钟级）；installUpdate 为纯下载+安装（分钟级）。
  // 若在串行队列中 await，期间 cancelStream / deleteMessage 等取消类消息全部排队，
  // webview 通道整体冻结
  MESSAGE_NAMES.checkUpdateNow,
  MESSAGE_NAMES.updateNow,
  MESSAGE_NAMES.installUpdate,
]);

// ============ 3. 跨端共享类型 ============

/**
 * Token 详情条目
 *
 * 按模态（modality）分类的 token 统计。
 * 结构在 backend/modules/conversation/types.ts 与 frontend/src/types/index.ts 完全一致
 * （B1 起以本文件为单一来源，两端 re-export）。
 */
export interface TokenDetailsEntry {
  /** 模态类型: "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" */
  modality: string;
  /** Token 数量 */
  tokenCount: number;
}

/**
 * Token 使用统计（Gemini usageMetadata 格式；各渠道统一映射到该结构）
 *
 * 仅存储在 model 角色的消息上。结构在 backend/modules/conversation/types.ts 与
 * frontend/src/types/index.ts 完全一致（B1 起以本文件为单一来源，两端 re-export）。
 */
export interface UsageMetadata {
  /** 输入 prompt 的 token 数量 */
  promptTokenCount?: number;

  /** 提供商报告的总输出 token；reasoning/thinking token 已包含在内 */
  candidatesTokenCount?: number;

  /** 总 token 数量（prompt + candidates + thoughts） */
  totalTokenCount?: number;

  /** 缓存内容的 token 数量（写入缓存 + 命中缓存） */
  cachedContentTokenCount?: number;

  /** 缓存写入的 token 数量（Anthropic cache_creation_input_tokens） */
  cacheCreationTokenCount?: number;

  /** 缓存命中的 token 数量（Anthropic cache_read_input_tokens / OpenAI cached_tokens / Gemini cachedContentTokenCount） */
  cacheReadTokenCount?: number;

  /** 思考部分的 token 数量 */
  thoughtsTokenCount?: number;

  /** Prompt token 详情（按模态分类） */
  promptTokensDetails?: TokenDetailsEntry[];

  /** 候选输出 token 详情（按模态分类，如 IMAGE、TEXT 等） */
  candidatesTokensDetails?: TokenDetailsEntry[];
}

/**
 * 上下文总结的压缩统计
 *
 * 与总结模型自身的 usageMetadata 分开，避免把两种口径混为一谈。
 * 结构在 backend/modules/conversation/types.ts 与 frontend/src/types/index.ts 完全一致
 * （B1 起以本文件为单一来源，两端 re-export）。
 */
export interface SummaryTokenStats {
  /** 被新摘要替换的历史消息估算 token。 */
  sourceTokenCount: number;
  /** 新摘要正文 token（优先使用 provider 输出计数，否则本地估算）。 */
  summaryTokenCount: number;
  /** max(0, sourceTokenCount - summaryTokenCount)。 */
  estimatedTokensSaved: number;
  /** 总结发生前最近一次主模型请求的 prompt token；可能缺失。 */
  contextTokenCountBefore?: number;
  /** 基于历史替换量计算的主上下文估算值；下一次主回复后应以真实 usage 为准。 */
  estimatedContextTokenCountAfter?: number;
}

/**
 * 思考签名（多格式支持，T16 迁入）
 *
 * 不同 API 提供商返回的思考签名格式不同，使用对象结构分开存储。
 * 示例: { gemini: "Eo4KCosKAXrI2nyWeryDa/51Rbxj4E/V/8w==" }
 *
 * 结构在 backend/modules/conversation/types.ts 与 frontend/src/types/index.ts 统一
 * （T16 起以本文件为单一来源，两端 re-export）。
 */
export interface ThoughtSignatures {
    /** Gemini 格式思考签名 */
    gemini?: string;

    /** Anthropic 格式思考签名（预留） */
    anthropic?: string;

    /** OpenAI 格式思考签名（预留） */
    openai?: string;

    /** OpenAI Responses 格式思考签名 */
    'openai-responses'?: string;

    /** 其他格式思考签名 */
    [key: string]: string | undefined;
}

/**
 * OpenAI Responses reasoning item 的标准元数据（T16 迁入）
 *
 * 用于无状态多轮原样回传。
 */
export interface OpenAIResponsesReasoningMetadata {
    /** Responses API reasoning output item 的稳定 ID，后续轮次需要原样回传 */
    id?: string;
    status?: 'in_progress' | 'completed' | 'incomplete';
    /** 可分享的 reasoning summary，保持官方数组格式 */
    summary?: Array<{ type: 'summary_text'; text: string }>;
    /** GPT-OSS 等模型可能返回的 reasoning text，保持官方数组格式 */
    content?: Array<{ type: 'reasoning_text'; text: string }>;
}

/**
 * Content Part（内容片段，T16 迁入）
 *
 * 两端结构超集：后端持久化的全部字段 + 前端遗留字段。
 * 结构在 backend/modules/conversation/types.ts 与 frontend/src/types/index.ts 统一
 * （T16 起以本文件为单一来源，两端 re-export）。
 */
export interface ContentPart {
    /** 文本内容 */
    text?: string;

    /**
     * 内联数据（Base64 编码）
     *
     * 标准 Gemini API 只需要 mimeType 和 data。
     * - displayName: Gemini API 支持的显示名称字段
     * - id 和 name 是附件元数据，仅用于存储和前端显示，发送给 AI 时会被过滤掉。
     */
    inlineData?: {
        mimeType: string;
        data: string; // Base64 编码的数据
        /** 显示名称（Gemini API 支持，可发送给 API） */
        displayName?: string;
        /** 附件 ID（仅用于存储和显示，发送 API 时过滤） */
        id?: string;
        /** 附件名称（仅用于存储和显示，发送 API 时过滤） */
        name?: string;
    };

    /**
     * 文件数据（File API 引用）
     *
     * displayName 在以下场景中必需：
     * - 在 functionResponse.parts 中，需要通过 {"$ref": "displayName"} 引用时
     */
    fileData?: {
        mimeType: string;
        fileUri: string;
        displayName?: string; // 用于 JSON 引用的唯一名称
    };

    /** 函数调用（模型请求） */
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
        /** 增量解析时的原始 JSON 字符串（用于流式输出） */
        partialArgs?: string;
        /**
         * Anthropic forced tool use 的预填参数标记。仅用于流式累加器把初始 input
         * 与后续 input_json_delta 合并；最终 Content 投影会删除该内部字段。
         */
        prefilledArgs?: boolean;
        id?: string; // 可选的函数调用 ID
        /** 是否已被用户拒绝执行（重新加载对话时正确显示工具状态） */
        rejected?: boolean;
        /**
         * 流式合并用的并行工具序号（Anthropic content_block index、
         * OpenAI Responses output_index）。缺 index 时参数增量会被错误地全部拼进
         * 最后一个工具壳，导致并行调用参数丢失。
         */
        index?: number;
        /** 流式合并用的完整参数标记：true 时 partialArgs 携带完整 arguments，累加器应覆盖 */
        finalArgs?: boolean;
        /** 流式合并用的上游 item 定位符（OpenAI Responses 等），仅用于事件归并 */
        itemId?: string;
    };

    /**
     * 函数响应（执行结果）
     *
     * Gemini 3 Pro+ 支持多模态函数响应：parts 可包含 inlineData/fileData 嵌套 parts。
     */
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
        id?: string; // 函数调用 ID（Anthropic 必需）
        parts?: ContentPart[]; // 嵌套的多模态 parts (Gemini 3 Pro+)
    };

    /**
     * 思考签名（多格式支持）
     *
     * 按提供商格式分类存储。发送请求时根据目标 API 类型选择对应格式的签名发送；
     * 必须原样返回给模型、不能与其他 part 合并。
     */
    thoughtSignatures?: ThoughtSignatures;

    /** OpenAI Responses reasoning item 的标准元数据，用于无状态多轮原样回传 */
    openaiResponsesReasoning?: OpenAIResponsesReasoningMetadata;

    /**
     * 是否为思考内容标志
     *
     * true 表示此 part 包含模型的思考过程而非最终回答。
     */
    thought?: boolean;

    /**
     * 加密的思考内容（Anthropic redacted_thinking，Base64）
     *
     * 仅后端产生（Anthropic 持久化进历史）；前端透传不渲染。
     * 发送时需要转换为 { type: 'redacted_thinking', data }。
     */
    redactedThinking?: string;

    /**
     * @deprecated 前端遗留死字段（无消费方）；统一使用 thoughtSignatures。
     */
    thoughtSignature?: string;
}

/**
 * 轻量存档摘要（CPF-02/CPF-03，T16 迁入）
 *
 * 会话元数据只保留此摘要，前端列表也只接收此结构，不再下发完整哈希映射。
 * 结构在 backend/modules/checkpoint/types.ts 与 frontend/src/types/index.ts 统一
 * （T16 起以本文件为单一来源，两端 re-export）。
 */
export interface CheckpointSummary {
    id: string;
    conversationId: string;
    messageNodeId?: string;
    messageIndex: number;
    toolName: string;
    phase: 'before' | 'after';
    timestamp: number;
    type: 'full' | 'incremental';
    baseCheckpointId?: string;
    contentHash: string;
    fileCount: number;
    backupBytes: number;
    excludedCount: number;
    manifestVersion: number;
}

/**
 * 带磁盘占用的存档摘要（getCheckpoints withSize=true 时下发）
 *
 * size 为 withSize 附加字段：优先用创建时记录的 backupBytes，旧存档缺失时懒扫描补齐。
 */
export type CheckpointSummaryWithSize = CheckpointSummary & { size: number };

// ============ 4. TODO：渐进接入（第一阶段未覆盖项） ============
//
// 1. 消息名：
//    - MESSAGE_NAMES 已收录 webview/handlers 注册表（registry.set / register）、
//      StreamRequestHandler / MessageRouter 直连的流式类型、ChatViewProvider 直连的
//      webviewReady、SubAgentMonitorPanel 直连的 Monitor 消息，共 203 个
//      （webview → 扩展请求方向）；
//    - PUSH_MESSAGE_NAMES 已补入扩展 → webview 推送消息名（postMessage 的 type：
//      'command'/'response'/'error'/'streamChunkBatch'/'subagentMonitor.event' 等 +
//      type:'command' 的 command 名，如 'startupFailed'/'windowFocusChanged'），共 20 个；
//      推送调用点（ChatViewProvider / SubAgentMonitorPanel / StreamChunkProcessor /
//      WebviewClientRegistry / commands/diffUi / StoragePathHandlers / backend bootstrap）
//      已全部改为引用常量；
//    - 消费方迁移：已完成——webview/handlers 注册表（registry.set，179 处验证）与
//      前端 sendToExtension 调用处均已引用 MESSAGE_NAMES 常量；遗留消息名
//      （chat / retry / editAndRetry / editAndRetryStream / getHistory / getConfig /
//      updateConfig）及其唯一消费方 VSCodeRequest 类型已一并清理，无裸字符串漂移。
//
// 2. 共享类型：
//    - 已迁移 TokenDetailsEntry / UsageMetadata / SummaryTokenStats（B1）、
//      ContentPart（含 ThoughtSignatures / OpenAIResponsesReasoningMetadata）与
//      CheckpointSummary / CheckpointSummaryWithSize（T16，两端统一为契约超集）；
//    - CheckpointManifest / CheckpointIgnoreSnapshot / CheckpointExcludedEntry 等检查点
//      类型仍分属 backend/modules/checkpoint/types.ts，未纳入本阶段范围。

