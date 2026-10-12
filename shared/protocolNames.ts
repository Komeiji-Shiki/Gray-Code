/**
 * GrayCode 跨端协议单一来源（B1）
 *
 * 本文件是前端（frontend/）与扩展侧（webview/、backend/）共享的
 * 「消息名常量 + 慢消息名单 + 跨端共享类型」的单一来源。
 *
 * 约束：
 * - 零运行时依赖，不 import 任何项目代码；除「消息名 / 慢消息名单 / 共享类型」外，
 *   第 3 节新增的 per-message payload schema 校验器也是纯函数（无 Node / VS Code / DOM 依赖）；
 * - 不包含任何业务逻辑（schema 只描述 payload 形状，不含业务语义）；
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
  'chat.pendingUserInputs': 'chat.pendingUserInputs',
  'chat.updatePendingUserInput': 'chat.updatePendingUserInput',
  'chat.withdrawPendingUserInput': 'chat.withdrawPendingUserInput',

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
  'config.revealApiKey': 'config.revealApiKey',
  'chatgpt.status': 'chatgpt.status',
  'chatgpt.start': 'chatgpt.start',
  'chatgpt.complete': 'chatgpt.complete',
  'chatgpt.cancel': 'chatgpt.cancel',
  'chatgpt.select': 'chatgpt.select',
  'chatgpt.disconnect': 'chatgpt.disconnect',
  'chatgpt.acknowledge': 'chatgpt.acknowledge',
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
  'conversation.getMessageMarkers': 'conversation.getMessageMarkers',
  'conversation.getMessagePosition': 'conversation.getMessagePosition',
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
  'prompt.preview': 'prompt.preview',

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
  'tools.resetToolAutoExec': 'tools.resetToolAutoExec',
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
  'chat.pendingUserInputsChanged': 'chat.pendingUserInputsChanged',
  windowFocusChanged: 'windowFocusChanged',
  'input.addContext': 'input.addContext',
  'tools.applyDiffConfigChanged': 'tools.applyDiffConfigChanged',
  // 渠道/模型配置变更（设置面板保存后推送，输入区据此刷新下拉框）
  'channels.configChanged': 'channels.configChanged',
  // MCP 服务器配置变更（设置导入等外部批量写入后推送，MCP 设置页据此刷新列表）
  'mcp.configChanged': 'mcp.configChanged',
  // VSCode 设置项批量变更（设置导入完成后推送，设置面板据此重新拉取表单值）
  'settings.imported': 'settings.imported',
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
  // 交换令牌和远程撤销有各自的 30 秒网络上限，不受普通界面请求的短超时截断。
  MESSAGE_NAMES['chatgpt.complete'],
  MESSAGE_NAMES['chatgpt.disconnect'],
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
  // 网络/下载类：tokenizer 词表首次下载可达分钟级；token 计数调用渠道 API 受网络超时配置影响
  MESSAGE_NAMES.installUpdate,
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
  // awaitConversationIdle：内部 waitForIdle 等待直到流结束（外层 10s 超时兜底），
  // 若占住串行队列，期间 cancelStream / deleteMessage 等取消类消息全部排队，
  // 用户「停止」点击被推迟数秒才生效；fire-and-forget 后响应照常由 handler 发出。
  MESSAGE_NAMES['chat.awaitConversationIdle'],
  // 重负载读取类：全量用量聚合（跨会话读文件聚合）与记忆条目枚举（最多 1 万条）
  // 耗时数秒且不要求串行语义，不应阻塞队列中的取消类消息。
  MESSAGE_NAMES['usage.getStats'],
  MESSAGE_NAMES.getMemoryEntries,
]);
