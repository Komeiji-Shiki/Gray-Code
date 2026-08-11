/**
 * remoteControlUi.ts
 *
 * 远程控制移动端 UI 入口（V3 重构版）。
 *
 * 架构：单 HTML 自包含页面（零外部依赖），由三部分组装：
 * - CSS：remoteControlUiCss.ts（REMOTE_UI_CSS，桌面端 VS Code Dark+ 对齐）；
 * - Script：remoteControlUiScript.ts（buildRemoteUiScript，四选择器输入区/
 *   可关页签/渠道完整 CRUD/实时会话列表）；
 * - 本文：三语言 i18n（UI_TEXTS）+ HTML 骨架 + 组装（renderRemoteControlUiHtml）。
 *
 * 本文件保持对外契约不变：测试与服务器从本模块导入 renderRemoteControlUiHtml 与 UI_TEXTS。
 */

import { REMOTE_UI_CSS } from './remoteControlUiCss';
import { buildRemoteUiScript } from './remoteControlUiScript';

const SUPPORTED_LANGS = ['zh-CN', 'en', 'ja'] as const;
type UiLang = typeof SUPPORTED_LANGS[number];

/** 页面内置文案（与桌面端 i18n 语义一致；三语言键集合必须完全一致） */
interface UiText {
  /* 顶栏 / 状态 */
  appTitle: string;
  statusConnecting: string;
  statusConnected: string;
  statusReconnecting: string;
  statusStreaming: string;
  statusServerStopped: string;
  /* 底部导航 */
  tabChat: string;
  tabFiles: string;
  tabSettings: string;
  /* 会话 */
  newChat: string;
  conversations: string;
  emptyConversation: string;
  emptyNewChat: string;
  emptyMessages: string;
  untitled: string;
  inputPlaceholder: string;
  send: string;
  stop: string;
  loading: string;
  loadFailed: string;
  sendFailed: string;
  refresh: string;
  closeTab: string;
  loadMore: string;
  copy: string;
  copied: string;
  rename: string;
  renameDialogTitle: string;
  renamePlaceholder: string;
  renameSave: string;
  renameCancel: string;
  deleteConversation: string;
  deleteConversationConfirm: string;
  deleteConversationDone: string;
  deleteConversationFailed: string;
  /* 工作区 / 文件 */
  workspace: string;
  workspaceRoot: string;
  switchWorkspace: string;
  noWorkspace: string;
  noWorkspaceHint: string;
  file: string;
  openOnDesktop: string;
  edit: string;
  save: string;
  saved: string;
  saveFailed: string;
  fileTooLarge: string;
  fileReadFailed: string;
  back: string;
  workspaceOpened: string;
  workspaceNotFound: string;
  addWorkspace: string;
  removeWorkspace: string;
  workspaceRemoved: string;
  openFolderDialog: string;
  browseTitle: string;
  browseSelect: string;
  browseUp: string;
  browseRootLabel: string;
  browseDrivesLabel: string;
  chooseThisFolder: string;
  pickOnDesktop: string;
  activeFile: string;
  /* 消息 */
  userLabel: string;
  assistantLabel: string;
  modelTag: string;
  thinking: string;
  toolCall: string;
  toolResult: string;
  systemMessage: string;
  errorBanner: string;
  streamInterrupted: string;
  awaitingApproval: string;
  approve: string;
  reject: string;
  toolApproved: string;
  toolRejected: string;
  toolConfirmFailed: string;
  retry: string;
  retryFailed: string;
  deleteMessage: string;
  deleteMessageConfirm: string;
  deleteMessageDone: string;
  deleteMessageFailed: string;
  editMessage: string;
  editPlaceholder: string;
  editFailed: string;
  editBranching: string;
  reroll: string;
  rerollFailed: string;
  /* 渠道 / 模型 */
  model: string;
  config: string;
  noConfigs: string;
  currentModel: string;
  noModels: string;
  setModelFailed: string;
  activeChannel: string;
  setActiveChannel: string;
  enable: string;
  disable: string;
  modelSelect: string;
  /* 输入区四选择器（桌面端 InputSelectorBar 同款） */
  selMode: string;
  selModeTitle: string;
  selModeDefault: string;
  selChannel: string;
  selChannelTitle: string;
  selChannelNone: string;
  selModel: string;
  selModelTitle: string;
  selModelAuto: string;
  selThinking: string;
  selThinkingTitle: string;
  selThinkingAuto: string;
  /* 渠道管理（完整增删改） */
  addChannel: string;
  editChannel: string;
  deleteChannel: string;
  deleteChannelConfirm: string;
  createChannel: string;
  saveChannel: string;
  channelCreated: string;
  channelSaved: string;
  channelDeleted: string;
  channelName: string;
  channelNameRequired: string;
  channelType: string;
  channelUrl: string;
  channelApiKey: string;
  channelToolMode: string;
  channelTimeout: string;
  channelMaxContext: string;
  /* 远程控制状态 */
  connection: string;
  running: string;
  stopped: string;
  port: string;
  accessUrls: string;
  appVersion: string;
  securityTitle: string;
  securityText: string;
  /* 设置页 20 分类 */
  secChannel: string;
  secGeneral: string;
  secUI: string;
  secProxy: string;
  secTools: string;
  secAutoExec: string;
  secFileTools: string;
  secCommand: string;
  secPrompt: string;
  secContext: string;
  secMemory: string;
  secSummarize: string;
  secCheckpoint: string;
  secTokenCount: string;
  secImageGen: string;
  secSkills: string;
  secSubagents: string;
  secPinned: string;
  secRemote: string;
  secStorage: string;
  secDeps: string;
  /* 设置字段 */
  fldCheckUpdates: string;
  fldMaxToolIterations: string;
  fldDefaultToolMode: string;
  fldLanguage: string;
  fldTheme: string;
  fldWorkspaceBehavior: string;
  fldLoadingText: string;
  fldSmoothStreaming: string;
  fldSoundEnabled: string;
  fldSoundVolume: string;
  fldSoundTheme: string;
  fldProxyEnabled: string;
  fldProxyUrl: string;
  fldProxyInsecure: string;
  fldReadOutside: string;
  fldWriteOutside: string;
  fldListIgnore: string;
  fldFindExclude: string;
  fldApplyFormat: string;
  fldApplyAutoSave: string;
  fldApplyAutoSaveDelay: string;
  fldApplyGuard: string;
  fldApplyAutoApply: string;
  fldSearchExclude: string;
  fldSearchMaxFind: string;
  fldSearchCtxBefore: string;
  fldSearchCtxAfter: string;
  fldHistoryScope: string;
  fldHistoryMax: string;
  fldCmdShell: string;
  fldCmdTimeout: string;
  fldCmdMaxOutput: string;
  fldSandboxEnabled: string;
  fldSandboxLangs: string;
  fldSandboxTimeout: string;
  fldPromptMode: string;
  fldPromptPrefix: string;
  fldPromptSuffix: string;
  fldPromptDynamicEnabled: string;
  fldPromptDynamic: string;
  fldCtxFiles: string;
  fldCtxDepth: string;
  fldCtxTabs: string;
  fldCtxMaxTabs: string;
  fldCtxEditor: string;
  fldCtxIgnore: string;
  fldCtxDiag: string;
  fldMemEnabled: string;
  fldMemWake: string;
  fldMemChars: string;
  fldSumRounds: string;
  fldSumTokens: string;
  fldSumSeparate: string;
  fldSumChannel: string;
  fldSumModel: string;
  fldSumAttempts: string;
  fldSumRatio: string;
  fldCkptEnabled: string;
  fldCkptMax: string;
  fldTokUrl: string;
  fldTokModel: string;
  fldTokKey: string;
  fldImgUrl: string;
  fldImgModel: string;
  fldImgAspect: string;
  fldImgAspectDef: string;
  fldImgSize: string;
  fldImgSizeDef: string;
  fldImgMaxBatch: string;
  fldImgMaxPerTask: string;
  fldImgReturn: string;
  fldImgKey: string;
  fldSubMaxConcurrent: string;
  fldSubFailureMode: string;
  fldSubGeneralWorker: string;
  fldSubDefaultIterations: string;
  fldSubDefaultRuntime: string;
  fldSubTools: string;
  fldPinnedAdd: string;
  fldPinnedPath: string;
  fldRcEnabled: string;
  fldRcPort: string;
  fldRcRestart: string;
  fldRcStop: string;
  fldRcDisconnectWarn: string;
  fldStoragePath: string;
  fldMigration: string;
  fldDepName: string;
  fldDepStatus: string;
  /* 通用 */
  on: string;
  off: string;
  apiKeySet: string;
  keepBlank: string;
  chipsHint: string;
  settingsSaved: string;
  settingsFailed: string;
  noData: string;
  depInstalled: string;
  depMissing: string;
  unlimited: string;
  seconds: string;
  chipAdd: string;
  chipRemove: string;
  /* ---- V4 追加（与 UI_TEXTS 三语言字典键一致） ---- */
  activeModel: string;
  addModel: string;
  assistant: string;  browseFolder: string;
  channelChanged: string;
  ckptAfterTools: string;
  ckptBeforeTools: string;
  ckptCustomPatterns: string;
  ckptEnable: string;
  ckptExclusion: string;
  ckptMaxSizeMiB: string;
  ckptMergeUnchanged: string;
  ckptMessages: string;
  ckptModelOuter: string;
  ckptMsgAfter: string;
  ckptMsgBefore: string;
  ckptProfileAiModels: string;
  ckptProfileArchives: string;
  ckptProfileBuildArtifacts: string;
  ckptProfileCaches: string;
  ckptProfileDatasets: string;
  ckptProfileLargeMedia: string;
  ckptProfileLogs: string;
  ckptProfilePythonVenvs: string;
  ckptProfiles: string;
  ckptTools: string;
  copyFailed: string;
  deleted: string;
  disabled: string;
  done: string;
  edited: string;
  emptyDir: string;
  fldDiagEnabled: string;
  fldDiagMaxFiles: string;
  fldDiagOpenOnly: string;
  fldDiagPerFile: string;
  fldDiagSeverities: string;
  fldDiagWorkspaceOnly: string;
  fldMemEntryChars: string;
  fldMemPartChars: string;
  fldMemPartLines: string;
  fldMemWakeLines: string;
  fldSbxCleanup: string;
  fldSbxOutputLines: string;
  fldSbxTimeout: string;
  fldSelectionContext: string;
  fldSumAutoPrompt: string;
  fldSumChannelId: string;
  fldSumKeepRounds: string;
  fldSumKeepTokens: string;
  fldSumMaxAttempts: string;
  fldSumMaxRatio: string;
  fldSumModelId: string;
  fldSumPrompt: string;
  fldSumSeparateModel: string;
  fldTokEnabled: string;
  fldTpsBar: string;
  manageModels: string;
  modeChanged: string;
  modelAdded: string;
  modelChanged: string;
  modelIdHint: string;
  modelIdRequired: string;
  modelNameHint: string;
  moreActions: string;
  msgTypeModel: string;
  msgTypeUser: string;
  noConversations: string;
  nothingToCopy: string;
  remove: string;
  removed: string;
  renamed: string;
  rerolling: string;
  secAppearance: string;
  setActiveModel: string;
  textarea: string;
  toolApprove: string;
  toolConfirmTitle: string;
  toolReject: string;
  toolUsed: string;
  you: string;
  /* ---- V5 追加（设置补全 + 消息渲染对齐桌面端） ---- */
  secMcp: string;
  secUsage: string;
  addMcpServer: string;
  mcpTransport: string;
  mcpCommand: string;
  subAgentsList: string;
  install: string;
  uninstall: string;
  installed: string;
  rejected: string;
  toolArgs: string;
  usageTotalTokens: string;
  usagePromptTokens: string;
  usageCandidatesTokens: string;
  usageTotalCost: string;
  fldChStream: string;
  fldChMultimodal: string;
  fldChStrictTools: string;
  fldChRetry: string;
  fldChRetryCount: string;
  fldChRetryInterval: string;
  fldChCustomBodyEnabled: string;
  fldChCustomBody: string;
  fldChCustomHeadersEnabled: string;
  fldChCustomHeaders: string;
  fldApplyGuardThreshold: string;
  fldMemSystemPrompt: string;
  fldPromptAssembly: string;
  promptAssemblyLegacy: string;
  promptAssemblyEntries: string;
  fldPromptStrategy: string;
  /* ---- V6 追加（桌面版三段式布局：顶栏按钮 + 全屏面板 + 新设置字段） ---- */
  btnFiles: string;
  btnSettings: string;
  settingsClose: string;
  chBasic: string;
  chContext: string;
  chToolsCfg: string;
  chAdvanced: string;
  fldChUseAuth: string;
  fldChContextMode: string;
  fldChContextThreshold: string;
  fldChAutoSummarize: string;
  fldChToolCropNorm: string;
  fldChTokenCountMethod: string;
  fldChTemperature: string;
  fldChMaxOutputTokens: string;
  fldChMaxImages: string;
  fldChTopP: string;
  fldChTopK: string;
  fldChFreqPenalty: string;
  fldChPresencePenalty: string;
  fldChReasoning: string;
  fldChEffort: string;
  fldChEffortCustom: string;
  fldChSummary: string;
  fldChThinkingType: string;
  fldChThinkingBudget: string;
  fldChThinkingDisplay: string;
  fldChSendThoughts: string;
  fldChHistoryRounds: string;
  fldChPromptCaching: string;
  fldChTtl: string;
  fldChKeepAlive: string;
  fldChDeepSeekUserId: string;
  fldChPdfAttachment: string;
  fldChAnthropicUserId: string;
  fldChAutoRetry: string;
  memEntries: string;
  memAdd: string;
  memAddPlaceholder: string;
  memEmpty: string;
  memTotal: string;
  memScope: string;
  memScopeGlobal: string;
  memScopeWorkspace: string;
  usageConversations: string;
  usageByModel: string;
  usageByDay: string;
  usageRefresh: string;
  usageThoughts: string;
  usageCacheRead: string;
  usageModelMessages: string;
  mcpDescription: string;
  mcpArgs: string;
  mcpEnv: string;
  mcpHeaders: string;
  mcpAutoConnect: string;
  mcpCleanSchema: string;
  mcpTimeout: string;
  mcpConnect: string;
  mcpDisconnect: string;
  mcpConnected: string;
  mcpDisconnected: string;
  subCreate: string;
  subName: string;
  subSystemPrompt: string;
  subChannel: string;
  subModel: string;
  subToolsMode: string;
  subWhitelist: string;
  subBlacklist: string;
  subMaxIterations: string;
  subMaxRuntime: string;
  fldPromptTemplate: string;
  fldPromptEntries: string;
  fldPromptToolPolicy: string;
  modeNew: string;
  modeRename: string;
  modeCopy: string;
  modeDelete: string;
  modeName: string;
  ckptProfilePatterns: string;
  ckptBranchCleanup: string;
  ckptRetentionDays: string;
  fldSoundCooldown: string;
  fldSoundCues: string;
  fldSoundSubCues: string;
  fldSoundWindowsNotify: string;
  fldSoundOnlyUnfocused: string;
  fldSoundCueWarning: string;
  fldSoundCueError: string;
  fldSoundCueComplete: string;
  fldSoundCueFail: string;
  fldSplashEnabled: string;
  opExport: string;
  opImport: string;
  opCheckUpdate: string;
  opUpdateNow: string;
  opStorageReset: string;
  opStorageOpen: string;
  appInfo: string;
  fldToolsAllEnable: string;
  fldToolsAllDisable: string;
  fldApplyOutside: string;
  toolAllow: string;
  toolAsk: string;
  toolDeny: string;
  /* 渠道页内联折叠菜单（桌面端 ChannelSettings 同构） */
  chSelector: string;
  chEnableSection: string;
  chApiUrlSection: string;
  chApiKeySection: string;
  chModelsSection: string;
  chStreamSection: string;
  chTypeSection: string;
  chToolModeSection: string;
  chMultimodalSection: string;
  chStrictSection: string;
  chTimeoutSection: string;
  chMaxCtxSection: string;
  chContextMgmtSection: string;
  chToolOptionsSection: string;
  chTokenCountSection: string;
  chAdvancedSection: string;
  chCustomBodySection: string;
  chCustomHeadersSection: string;
  chRetrySection: string;
  chThinkingGroup: string;
  chThoughtGroup: string;
  chCacheGroup: string;
  chMaxImages: string;
  chNoConfigSelected: string;
  chCustomBodyMode: string;
  chCustomBodyItems: string;
  chCustomBodyJson: string;
  chCustomHeadersList: string;
  /* 提示词条目编辑器（桌面端 PromptEntriesEditor 同构） */
  peEntriesLabel: string;
  peName: string;
  peRole: string;
  peContent: string;
  peFakeThought: string;
  peAdd: string;
  peConvertLegacy: string;
  peMoveUp: string;
  peMoveDown: string;
  peDuplicate: string;
  peDelete: string;
  peChatHistory: string;
  peChatHistoryHint: string;
  peRoleSystem: string;
  peRoleUser: string;
  peRoleAssistant: string;
  peEntriesHint: string;
  peLegacySystem: string;
  peLegacyDynamic: string;
  confirmSwitchType: string;
  /* 工具页 */
  toolConfigBtn: string;
  toolShellGroup: string;
  toolShellEnabled: string;
  toolShellPath: string;
  toolShellDefault: string;
  toolMaxIter: string;
  toolSandboxGlobal: string;
  /* 记忆 */
  memScopeRow: string;
  memEdit: string;
  memSave: string;
  memEditHint: string;
  memNoScopes: string;
  memWorkspaceLabel: string;
  /* 远程控制 */
  rcSaveHint: string;
  /* 用量 */
  usageRange: string;
  usageRangeAll: string;
  usageRangeToday: string;
  usageRange7d: string;
  usageRange30d: string;
  usageCacheCreation: string;
  usageSkipped: string;
  /* MCP / 子代理补充 */
  mcpTransportType: string;
  mcpCapabilities: string;
  mcpLastError: string;
  mcpEnabledLabel: string;
  subDescription: string;
  subIncludeMcp: string;
  subPresets: string;
  subBlankPreset: string;
  /* diff 查看与批准 */
  diffWaiting: string;
  diffWaitingFor: string;
  diffView: string;
  diffApprove: string;
  diffReject: string;
  diffOriginal: string;
  diffNew: string;
  diffLoading: string;
  diffAccepted: string;
  diffRejected: string;
  diffGuardTitle: string;
  diffAutoRejectHint: string;
  streamingWait: string;
}

export const UI_TEXTS: Record<UiLang, UiText> = {
  'zh-CN': {
    appTitle: 'GrayCode 远程控制',
    statusConnecting: '连接中…',
    statusConnected: '已连接',
    statusReconnecting: '重连中…',
    statusStreaming: '生成中…',
    statusServerStopped: '远程控制已关闭',
    tabChat: '会话',
    tabFiles: '文件',
    tabSettings: '设置',
    newChat: '新建会话',
    conversations: '会话列表',
    emptyConversation: '还没有会话，发送第一条消息即可自动创建。',
    emptyNewChat: '新对话已就绪，输入消息即可开始。',
    emptyMessages: '暂无消息',
    untitled: '未命名会话',
    inputPlaceholder: '输入消息…',
    send: '发送',
    stop: '停止',
    loading: '加载中…',
    loadFailed: '加载失败',
    sendFailed: '发送失败',
    refresh: '刷新',
    closeTab: '关闭会话页签',
    loadMore: '加载更多',
    copy: '复制',
    copied: '已复制',
    rename: '重命名',
    renameDialogTitle: '重命名会话',
    renamePlaceholder: '输入新标题',
    renameSave: '保存',
    renameCancel: '取消',
    deleteConversation: '删除会话',
    deleteConversationConfirm: '确定删除该会话？此操作不可恢复。',
    deleteConversationDone: '会话已删除',
    deleteConversationFailed: '删除会话失败',
    workspace: '工作区',
    workspaceRoot: '工作区根目录',
    switchWorkspace: '切换工作区',
    noWorkspace: '桌面端未打开工作区',
    noWorkspaceHint: '先在电脑上打开一个文件夹，手机端即可浏览与编辑其中的文件。',
    file: '文件',
    openOnDesktop: '在桌面端打开',
    edit: '编辑',
    save: '保存',
    saved: '已保存到工作区',
    saveFailed: '保存失败',
    fileTooLarge: '文件过大，手机上仅可查看（可在桌面端打开）',
    fileReadFailed: '文件读取失败',
    back: '返回',
    workspaceOpened: '工作区已打开',
    workspaceNotFound: '工作区不存在：请先在桌面端打开或收藏该目录',
    addWorkspace: '新增工作区',
    removeWorkspace: '移除收藏',
    workspaceRemoved: '已移除收藏',
    openFolderDialog: '已弹出文件夹选择框，请在桌面端选择',
    browseTitle: '选择工作区文件夹',
    browseSelect: '浏览目录',
    browseUp: '上级目录',
    browseRootLabel: '全部磁盘',
    browseDrivesLabel: '盘符列表',
    chooseThisFolder: '选择此文件夹为工作区',
    pickOnDesktop: '或：在桌面端弹出选择框',
    activeFile: '正在编辑',
    userLabel: '我',
    assistantLabel: 'AI',
    modelTag: '模型',
    thinking: '思考',
    toolCall: '工具调用',
    toolResult: '工具结果',
    systemMessage: '系统消息',
    errorBanner: '出错了',
    streamInterrupted: '生成已中断',
    awaitingApproval: '等待批准：',
    approve: '批准',
    reject: '拒绝',
    toolApproved: '已批准工具执行',
    toolRejected: '已拒绝工具执行',
    toolConfirmFailed: '工具确认失败',
    retry: '重试',
    retryFailed: '重试失败',
    deleteMessage: '删除消息',
    deleteMessageConfirm: '删除这条消息及其之后的所有消息？',
    deleteMessageDone: '消息已删除',
    deleteMessageFailed: '删除失败',
    editMessage: '编辑消息',
    editPlaceholder: '修改内容后重新生成…',
    editFailed: '编辑失败',
    editBranching: '正在重新生成…',
    reroll: '重新生成',
    rerollFailed: '重新生成失败',
    model: '模型',
    config: '渠道',
    noConfigs: '没有已配置的渠道，点击下方按钮新增',
    currentModel: '当前模型',
    noModels: '该渠道暂无可用模型',
    setModelFailed: '切换模型失败',
    activeChannel: '当前渠道',
    setActiveChannel: '设为当前渠道',
    enable: '启用',
    disable: '停用',
    modelSelect: '选择渠道与模型',
    selMode: '模式',
    selModeTitle: '选择模型模式',
    selModeDefault: '默认',
    selChannel: '渠道',
    selChannelTitle: '选择渠道',
    selChannelNone: '未选择',
    selModel: '模型',
    selModelTitle: '选择模型',
    selModelAuto: '自动',
    selThinking: '思考',
    selThinkingTitle: '思考强度',
    selThinkingAuto: '自动',
    addChannel: '新增渠道',
    editChannel: '编辑',
    deleteChannel: '删除',
    deleteChannelConfirm: '确定删除该渠道？此操作不可恢复。',
    createChannel: '创建',
    saveChannel: '保存渠道',
    channelCreated: '渠道已创建',
    channelSaved: '渠道已保存',
    channelDeleted: '渠道已删除',
    channelName: '渠道名称',
    channelNameRequired: '请输入渠道名称',
    channelType: '渠道类型',
    channelUrl: 'API 地址',
    channelApiKey: 'API Key',
    channelToolMode: '工具模式',
    channelTimeout: '超时(ms)',
    channelMaxContext: '最大上下文 token',
    connection: '连接状态',
    running: '运行中',
    stopped: '已停止',
    port: '端口',
    accessUrls: '访问地址',
    appVersion: '版本',
    securityTitle: '安全说明',
    securityText: '远程控制仅在局域网内可用，无账号密码保护。请勿在不可信网络中开启，用毕请关闭。',
    secChannel: '渠道',
    secGeneral: '通用',
    secUI: '界面',
    secProxy: '代理',
    secTools: '工具启用',
    secAutoExec: '自动执行',
    secFileTools: '文件工具',
    secCommand: '命令与沙箱',
    secPrompt: '系统提示词',
    secContext: '上下文感知',
    secMemory: '记忆',
    secSummarize: '对话总结',
    secCheckpoint: '检查点',
    secTokenCount: 'Token 计数',
    secImageGen: '图像生成',
    secSkills: '技能',
    secSubagents: '子代理',
    secPinned: '固定文件',
    secRemote: '远程控制',
    secStorage: '数据存储',
    secDeps: '依赖环境',
    fldCheckUpdates: '检查更新',
    fldMaxToolIterations: '最大工具迭代',
    fldDefaultToolMode: '默认工具模式',
    fldLanguage: '界面语言',
    fldTheme: '主题',
    fldWorkspaceBehavior: '启动恢复工作区',
    fldLoadingText: '加载文案',
    fldSmoothStreaming: '平滑流式输出',
    fldSoundEnabled: '启用提示音',
    fldSoundVolume: '音量',
    fldSoundTheme: '音效风格',
    fldProxyEnabled: '启用代理',
    fldProxyUrl: '代理地址',
    fldProxyInsecure: '跳过 TLS 校验',
    fldReadOutside: '读取工作区外文件',
    fldWriteOutside: '写入工作区外文件',
    fldListIgnore: '列表忽略模式',
    fldFindExclude: '查找排除模式',
    fldApplyFormat: '补丁格式',
    fldApplyAutoSave: '自动保存编辑',
    fldApplyAutoSaveDelay: '自动保存延迟(ms)',
    fldApplyGuard: '差异保护',
    fldApplyAutoApply: '免确认自动应用',
    fldSearchExclude: '搜索排除模式',
    fldSearchMaxFind: '最大查找文件数',
    fldSearchCtxBefore: '上文行数',
    fldSearchCtxAfter: '下文行数',
    fldHistoryScope: '历史搜索范围',
    fldHistoryMax: '最大匹配数',
    fldCmdShell: '默认 Shell',
    fldCmdTimeout: '默认超时(秒)',
    fldCmdMaxOutput: '最大输出行数',
    fldSandboxEnabled: '启用沙箱',
    fldSandboxLangs: '允许的语言',
    fldSandboxTimeout: '默认超时(秒)',
    fldPromptMode: '提示词模式',
    fldPromptPrefix: '自定义前缀',
    fldPromptSuffix: '自定义后缀',
    fldPromptDynamicEnabled: '启用动态上下文模板',
    fldPromptDynamic: '动态上下文模板',
    fldCtxFiles: '包含工作区文件树',
    fldCtxDepth: '最大文件深度',
    fldCtxTabs: '包含打开的标签页',
    fldCtxMaxTabs: '最大标签页数',
    fldCtxEditor: '包含活动编辑器',
    fldCtxIgnore: '忽略模式',
    fldCtxDiag: '包含诊断信息',
    fldMemEnabled: '启用记忆',
    fldMemWake: '唤醒词',
    fldMemChars: '条目字符上限',
    fldSumRounds: '保留最近轮次',
    fldSumTokens: '保留最近 token',
    fldSumSeparate: '独立模型总结',
    fldSumChannel: '总结渠道',
    fldSumModel: '总结模型',
    fldSumAttempts: '自动总结尝试次数',
    fldSumRatio: '总结输入比例',
    fldCkptEnabled: '启用检查点',
    fldCkptMax: '最大检查点数',
    fldTokUrl: '计数接口地址',
    fldTokModel: '计数模型',
    fldTokKey: 'API Key',
    fldImgUrl: '服务地址',
    fldImgModel: '模型',
    fldImgAspect: '启用宽高比',
    fldImgAspectDef: '默认宽高比',
    fldImgSize: '启用尺寸',
    fldImgSizeDef: '默认尺寸',
    fldImgMaxBatch: '最大批量任务',
    fldImgMaxPerTask: '单任务最大图片数',
    fldImgReturn: '图片结果回传 AI',
    fldImgKey: 'API Key',
    fldSubMaxConcurrent: '最大并发数',
    fldSubFailureMode: '失败后处理',
    fldSubGeneralWorker: '启用通用子代理',
    fldSubDefaultIterations: '默认最大迭代',
    fldSubDefaultRuntime: '默认最长运行(秒)',
    fldSubTools: '工具',
    fldPinnedAdd: '添加固定文件',
    fldPinnedPath: '相对路径',
    fldRcEnabled: '启用远程控制',
    fldRcPort: '端口',
    fldRcRestart: '重启服务器',
    fldRcStop: '停止服务器',
    fldRcDisconnectWarn: '修改端口或关闭后本页面将断开连接',
    fldStoragePath: '自定义数据目录',
    fldMigration: '迁移状态',
    fldDepName: '依赖',
    fldDepStatus: '状态',
    on: '开',
    off: '关',
    apiKeySet: '已设置（留空保持不变）',
    keepBlank: '留空保持不变',
    chipsHint: '输入后回车添加',
    settingsSaved: '设置已保存',
    settingsFailed: '保存失败',
    noData: '暂无数据',
    depInstalled: '可用',
    depMissing: '未安装',
    unlimited: '不限',
    seconds: '秒',
    chipAdd: '添加',
    chipRemove: '移除',
    /* ---- V4 新增 ---- */
    moreActions: '更多',
    noConversations: '暂无会话',
    renamed: '已重命名',
    deleted: '已删除',
    you: '你',
    assistant: '助手',
    toolUsed: '使用的工具',
    edited: '已保存修改',
    rerolling: '正在重新生成',
    nothingToCopy: '没有可复制的内容',
    textarea: '多行文本',
    copyFailed: '复制失败',
    toolConfirmTitle: '工具调用待确认',
    toolReject: '拒绝',
    toolApprove: '批准',
    modeChanged: '已切换模式',
    channelChanged: '已切换渠道',
    modelChanged: '已切换模型',
    emptyDir: '目录为空',
    browseFolder: '浏览文件夹',
    disabled: '已停用',
    manageModels: '模型管理',
    activeModel: '当前模型',
    setActiveModel: '设为当前',
    remove: '移除',
    removed: '已移除',
    modelIdHint: '模型 ID',
    modelNameHint: '显示名称（可空）',
    addModel: '添加模型',
    modelIdRequired: '请输入模型 ID',
    modelAdded: '模型已添加',
    done: '完成',
    secAppearance: '外观',
    fldSelectionContext: '选中内容上下文',
    fldTpsBar: '显示 TPS 状态栏',
    fldTokEnabled: '启用计数',
    fldSbxTimeout: '沙箱默认超时(ms)',
    fldSbxOutputLines: '最大输出行数',
    fldSbxCleanup: '自动清理临时目录',
    fldMemWakeLines: '唤醒行数',
    fldMemEntryChars: '条目字符上限',
    fldMemPartChars: '分区字符上限',
    fldMemPartLines: '分区行数上限',
    fldSumPrompt: '总结提示词',
    fldSumAutoPrompt: '自动总结提示词',
    fldSumKeepRounds: '保留最近轮次',
    fldSumKeepTokens: '保留最近 token（数字或百分比）',
    fldSumSeparateModel: '独立模型总结',
    fldSumChannelId: '总结渠道',
    fldSumModelId: '总结模型',
    fldSumMaxAttempts: '自动总结尝试次数',
    fldSumMaxRatio: '总结输入比例(%)',
    ckptEnable: '检查点开关',
    ckptMessages: '消息类型存档点',
    ckptMsgBefore: '消息前存档',
    ckptMsgAfter: '消息后存档',
    ckptModelOuter: '仅外部模型层',
    ckptMergeUnchanged: '合并未变化检查点',
    ckptTools: '工具备份配置',
    ckptBeforeTools: '工具执行前备份',
    ckptAfterTools: '工具执行后备份',
    ckptExclusion: '排除配置',
    ckptProfiles: '排除类别',
    ckptMaxSizeMiB: '最大文件大小(MiB)',
    ckptCustomPatterns: '自定义排除模式',
    msgTypeUser: '用户消息',
    msgTypeModel: '模型消息',
    ckptProfileLogs: '日志文件',
    ckptProfileAiModels: 'AI 模型文件',
    ckptProfileDatasets: '数据集',
    ckptProfileCaches: '缓存目录',
    ckptProfilePythonVenvs: 'Python 虚拟环境',
    ckptProfileBuildArtifacts: '构建产物',
    ckptProfileLargeMedia: '大体积媒体',
    ckptProfileArchives: '压缩包',
    fldDiagEnabled: '启用诊断信息',
    fldDiagSeverities: '包含的诊断等级',
    fldDiagWorkspaceOnly: '仅工作区诊断',
    fldDiagOpenOnly: '仅打开文件诊断',
    fldDiagPerFile: '每文件最大诊断数',
    fldDiagMaxFiles: '最大文件数',
    secMcp: 'MCP 服务器',
    secUsage: '用量统计',
    addMcpServer: '新增 MCP 服务器',
    mcpTransport: '传输方式',
    mcpCommand: '启动命令',
    subAgentsList: '子代理列表',
    install: '安装',
    uninstall: '卸载',
    installed: '已安装',
    rejected: '已拒绝',
    toolArgs: '参数',
    usageTotalTokens: '总 Token',
    usagePromptTokens: '输入 Token',
    usageCandidatesTokens: '输出 Token',
    usageTotalCost: '总费用',
    fldChStream: '流式输出',
    fldChMultimodal: '多模态工具',
    fldChStrictTools: '严格工具模式',
    fldChRetry: '自动重试',
    fldChRetryCount: '重试次数',
    fldChRetryInterval: '重试间隔(ms)',
    fldChCustomBodyEnabled: '自定义请求体',
    fldChCustomBody: '自定义请求体(JSON)',
    fldChCustomHeadersEnabled: '自定义请求头',
    fldChCustomHeaders: '自定义请求头(JSON)',
    fldApplyGuardThreshold: '差异保护阈值',
    fldMemSystemPrompt: '记忆系统提示词',
    fldPromptAssembly: '提示词组装模式',
    promptAssemblyLegacy: '传统模板',
    promptAssemblyEntries: '预设条目',
    fldPromptStrategy: '动态上下文策略',
    /* ---- V6 追加 ---- */
    btnFiles: '文件',
    btnSettings: '设置',
    settingsClose: '关闭',
    chBasic: '基本设置',
    chContext: '上下文管理',
    chToolsCfg: '工具配置',
    chAdvanced: '高级选项',
    fldChUseAuth: '使用 Authorization 头',
    fldChContextMode: '管理模式',
    fldChContextThreshold: '上下文阈值',
    fldChAutoSummarize: '自动总结',
    fldChToolCropNorm: '归一化坐标',
    fldChTokenCountMethod: '计数方式',
    fldChTemperature: '温度',
    fldChMaxOutputTokens: '最大输出 Tokens',
    fldChMaxImages: '最大图片数',
    fldChTopP: 'Top-P',
    fldChTopK: 'Top-K',
    fldChFreqPenalty: '频率惩罚',
    fldChPresencePenalty: '存在惩罚',
    fldChReasoning: '思考配置',
    fldChEffort: '思考强度',
    fldChEffortCustom: '自定义强度',
    fldChSummary: '输出详细程度',
    fldChThinkingType: '思考类型',
    fldChThinkingBudget: '思考预算',
    fldChThinkingDisplay: '思考显示',
    fldChSendThoughts: '回传思考',
    fldChHistoryRounds: '历史思考回合',
    fldChPromptCaching: 'Prompt 缓存',
    fldChTtl: 'TTL',
    fldChKeepAlive: '保活',
    fldChDeepSeekUserId: 'DeepSeek user_id',
    fldChPdfAttachment: 'PDF 附件',
    fldChAnthropicUserId: 'anthropic user_id',
    fldChAutoRetry: '自动重试',
    memEntries: '记忆条目',
    memAdd: '添加',
    memAddPlaceholder: '输入记忆内容…',
    memEmpty: '暂无记忆',
    memTotal: '共',
    memScope: '作用域',
    memScopeGlobal: '全局',
    memScopeWorkspace: '工作区',
    usageConversations: '会话数',
    usageByModel: '按模型',
    usageByDay: '按日期',
    usageRefresh: '刷新',
    usageThoughts: '思考 Tokens',
    usageCacheRead: '缓存读取',
    usageModelMessages: '模型消息',
    mcpDescription: '描述',
    mcpArgs: '启动参数',
    mcpEnv: '环境变量(JSON)',
    mcpHeaders: '请求头(JSON)',
    mcpAutoConnect: '自动连接',
    mcpCleanSchema: '清理 Schema',
    mcpTimeout: '超时(ms)',
    mcpConnect: '连接',
    mcpDisconnect: '断开',
    mcpConnected: '已连接',
    mcpDisconnected: '未连接',
    subCreate: '新建子代理',
    subName: '名称',
    subSystemPrompt: '系统提示词',
    subChannel: '渠道',
    subModel: '模型',
    subToolsMode: '工具模式',
    subWhitelist: '白名单',
    subBlacklist: '黑名单',
    subMaxIterations: '最大迭代',
    subMaxRuntime: '最长运行(秒)',
    fldPromptTemplate: '系统提示词模板',
    fldPromptEntries: '提示词条目',
    fldPromptToolPolicy: '工具策略',
    modeNew: '新建模式',
    modeRename: '重命名',
    modeCopy: '复制',
    modeDelete: '删除',
    modeName: '模式名称',
    ckptProfilePatterns: '类别排除模式',
    ckptBranchCleanup: '分支清理',
    ckptRetentionDays: '保留天数',
    fldSoundCooldown: '最小间隔(ms)',
    fldSoundCues: '事件提示音',
    fldSoundSubCues: '子代理提示音',
    fldSoundWindowsNotify: 'Windows 通知',
    fldSoundOnlyUnfocused: '仅窗口未聚焦',
    fldSoundCueWarning: '警告',
    fldSoundCueError: '错误',
    fldSoundCueComplete: '任务完成',
    fldSoundCueFail: '任务失败',
    fldSplashEnabled: '启动画面',
    opExport: '导出设置',
    opImport: '导入设置',
    opCheckUpdate: '立即检查更新',
    opUpdateNow: '一键更新',
    opStorageReset: '重置默认',
    opStorageOpen: '在资源管理器中打开',
    appInfo: '应用信息',
    fldToolsAllEnable: '全部启用',
    fldToolsAllDisable: '全部禁用',
    fldApplyOutside: '工作区外写入权限',
    toolAllow: '允许',
    toolAsk: '询问',
    toolDeny: '拒绝',
    chSelector: '选择渠道',
    chEnableSection: '启用此配置',
    chApiUrlSection: '接口地址',
    chApiKeySection: 'API 密钥',
    chModelsSection: '模型列表',
    chStreamSection: '流式输出',
    chTypeSection: '渠道类型',
    chToolModeSection: '工具模式',
    chMultimodalSection: '多模态',
    chStrictSection: '严格工具',
    chTimeoutSection: '超时 (ms)',
    chMaxCtxSection: '最大上下文 Tokens',
    chContextMgmtSection: '上下文管理',
    chToolOptionsSection: '工具配置',
    chTokenCountSection: 'Token 计数方式',
    chAdvancedSection: '高级选项',
    chCustomBodySection: '自定义 Body',
    chCustomHeadersSection: '自定义标头',
    chRetrySection: '自动重试',
    chThinkingGroup: '思考配置',
    chThoughtGroup: '思考回传配置',
    chCacheGroup: 'Prompt Caching',
    chMaxImages: '最大图片数',
    chNoConfigSelected: '请先选择或新建一个渠道',
    chCustomBodyMode: '模式',
    chCustomBodyItems: '键值对（JSON 数组）',
    chCustomBodyJson: 'JSON 正文',
    chCustomHeadersList: '标头列表（JSON 数组）',
    peEntriesLabel: '预设提示词条目',
    peName: '名称',
    peRole: '角色',
    peContent: '内容',
    peFakeThought: '伪造思考过程',
    peAdd: '新增条目',
    peConvertLegacy: '从传统模板转换',
    peMoveUp: '上移',
    peMoveDown: '下移',
    peDuplicate: '复制',
    peDelete: '删除',
    peChatHistory: 'Chat History',
    peChatHistoryHint: '真实历史插入点（不可删除）',
    peRoleSystem: 'system（合并进系统提示词）',
    peRoleUser: 'user（临时用户上下文）',
    peRoleAssistant: 'assistant（临时助手消息）',
    peEntriesHint: 'system 合并进系统提示词，user/assistant 作为临时上下文，Chat History 为真实历史插入点。',
    peLegacySystem: '系统提示词',
    peLegacyDynamic: '动态上下文',
    confirmSwitchType: '切换渠道类型将重置该类型特有参数，确定继续？',
    toolConfigBtn: '配置',
    toolShellGroup: '可用 Shell',
    toolShellEnabled: '启用',
    toolShellPath: '可执行文件路径',
    toolShellDefault: '设为默认',
    toolMaxIter: '最大工具调用次数',
    toolSandboxGlobal: '沙箱总开关',
    memScopeRow: '作用域',
    memEdit: '编辑',
    memSave: '保存',
    memEditHint: '点击条目可编辑',
    memNoScopes: '暂无工作区记忆作用域',
    memWorkspaceLabel: '工作区记忆',
    rcSaveHint: '保存后需重启远程控制服务生效',
    usageRange: '时间范围',
    usageRangeAll: '全部',
    usageRangeToday: '今天',
    usageRange7d: '近 7 天',
    usageRange30d: '近 30 天',
    usageCacheCreation: '缓存创建 Tokens',
    usageSkipped: '跳过的会话',
    mcpTransportType: '传输类型',
    mcpCapabilities: '能力',
    mcpLastError: '最近错误',
    mcpEnabledLabel: '启用',
    subDescription: '描述',
    subIncludeMcp: '包含 MCP 工具',
    subPresets: '预设模板',
    subBlankPreset: '空白',
    diffWaiting: '桌面端等待 Diff 批准',
    diffWaitingFor: '等待批准',
    diffView: '查看 Diff',
    diffApprove: '批准',
    diffReject: '拒绝',
    diffOriginal: '原文',
    diffNew: '新内容',
    diffLoading: '加载 Diff…',
    diffAccepted: 'Diff 已批准',
    diffRejected: 'Diff 已拒绝',
    diffGuardTitle: '删除警戒',
    diffAutoRejectHint: '长时间未处理将自动拒绝（约 5 分钟）',
    streamingWait: '等待桌面响应…'
  },
  en: {
    appTitle: 'GrayCode Remote',
    statusConnecting: 'Connecting…',
    statusConnected: 'Connected',
    statusReconnecting: 'Reconnecting…',
    statusStreaming: 'Generating…',
    statusServerStopped: 'Remote control is off',
    tabChat: 'Chat',
    tabFiles: 'Files',
    tabSettings: 'Settings',
    newChat: 'New chat',
    conversations: 'Conversations',
    emptyConversation: 'No conversations yet. Send a message to create one.',
    emptyNewChat: 'New chat ready. Type a message to start.',
    emptyMessages: 'No messages yet',
    untitled: 'Untitled conversation',
    inputPlaceholder: 'Type a message…',
    send: 'Send',
    stop: 'Stop',
    loading: 'Loading…',
    loadFailed: 'Failed to load',
    sendFailed: 'Failed to send',
    refresh: 'Refresh',
    closeTab: 'Close conversation tab',
    loadMore: 'Load more',
    copy: 'Copy',
    copied: 'Copied',
    rename: 'Rename',
    renameDialogTitle: 'Rename conversation',
    renamePlaceholder: 'Enter a new title',
    renameSave: 'Save',
    renameCancel: 'Cancel',
    deleteConversation: 'Delete conversation',
    deleteConversationConfirm: 'Delete this conversation? This cannot be undone.',
    deleteConversationDone: 'Conversation deleted',
    deleteConversationFailed: 'Failed to delete conversation',
    workspace: 'Workspace',
    workspaceRoot: 'Workspace root',
    switchWorkspace: 'Switch workspace',
    noWorkspace: 'No workspace open on desktop',
    noWorkspaceHint: 'Open a folder on your computer first, then browse and edit its files here.',
    file: 'File',
    openOnDesktop: 'Open on desktop',
    edit: 'Edit',
    save: 'Save',
    saved: 'Saved to workspace',
    saveFailed: 'Failed to save',
    fileTooLarge: 'File too large for mobile preview (open on desktop instead)',
    fileReadFailed: 'Failed to read file',
    back: 'Back',
    workspaceOpened: 'Workspace opened',
    workspaceNotFound: 'Workspace not found: open or save the folder on the desktop first',
    addWorkspace: 'Add workspace',
    removeWorkspace: 'Remove from saved',
    workspaceRemoved: 'Removed from saved',
    openFolderDialog: 'Folder picker opened on the desktop',
    browseTitle: 'Choose workspace folder',
    browseSelect: 'Browse folders',
    browseUp: 'Parent folder',
    browseRootLabel: 'All drives',
    browseDrivesLabel: 'Drives',
    chooseThisFolder: 'Use this folder as workspace',
    pickOnDesktop: 'Or: open the folder picker on the desktop',
    activeFile: 'Active file',
    userLabel: 'You',
    assistantLabel: 'AI',
    modelTag: 'Model',
    thinking: 'Thinking',
    toolCall: 'Tool call',
    toolResult: 'Tool result',
    systemMessage: 'System',
    errorBanner: 'Something went wrong',
    streamInterrupted: 'Generation interrupted',
    awaitingApproval: 'Awaiting approval:',
    approve: 'Approve',
    reject: 'Reject',
    toolApproved: 'Tool execution approved',
    toolRejected: 'Tool execution rejected',
    toolConfirmFailed: 'Failed to confirm tool',
    retry: 'Retry',
    retryFailed: 'Failed to retry',
    deleteMessage: 'Delete message',
    deleteMessageConfirm: 'Delete this message and everything after it?',
    deleteMessageDone: 'Message deleted',
    deleteMessageFailed: 'Failed to delete',
    editMessage: 'Edit message',
    editPlaceholder: 'Edit and regenerate…',
    editFailed: 'Failed to edit',
    editBranching: 'Regenerating…',
    reroll: 'Regenerate',
    rerollFailed: 'Failed to regenerate',
    model: 'Model',
    config: 'Channel',
    noConfigs: 'No channels configured. Add one below.',
    currentModel: 'Current model',
    noModels: 'No models available for this channel',
    setModelFailed: 'Failed to switch model',
    activeChannel: 'Active channel',
    setActiveChannel: 'Set as active channel',
    enable: 'Enable',
    disable: 'Disable',
    modelSelect: 'Choose channel and model',
    selMode: 'Mode',
    selModeTitle: 'Choose mode',
    selModeDefault: 'Default',
    selChannel: 'Channel',
    selChannelTitle: 'Choose channel',
    selChannelNone: 'None',
    selModel: 'Model',
    selModelTitle: 'Choose model',
    selModelAuto: 'Auto',
    selThinking: 'Thinking',
    selThinkingTitle: 'Thinking level',
    selThinkingAuto: 'Auto',
    addChannel: 'Add channel',
    editChannel: 'Edit',
    deleteChannel: 'Delete',
    deleteChannelConfirm: 'Delete this channel? This cannot be undone.',
    createChannel: 'Create',
    saveChannel: 'Save channel',
    channelCreated: 'Channel created',
    channelSaved: 'Channel saved',
    channelDeleted: 'Channel deleted',
    channelName: 'Channel name',
    channelNameRequired: 'Please enter a channel name',
    channelType: 'Channel type',
    channelUrl: 'API URL',
    channelApiKey: 'API Key',
    channelToolMode: 'Tool mode',
    channelTimeout: 'Timeout (ms)',
    channelMaxContext: 'Max context tokens',
    connection: 'Connection',
    running: 'Running',
    stopped: 'Stopped',
    port: 'Port',
    accessUrls: 'Access URLs',
    appVersion: 'Version',
    securityTitle: 'Security note',
    securityText: 'Remote control works on the local network only and has no password protection. Do not enable it on untrusted networks and turn it off when done.',
    secChannel: 'Channels',
    secGeneral: 'General',
    secUI: 'Appearance',
    secProxy: 'Proxy',
    secTools: 'Tools',
    secAutoExec: 'Auto-execute',
    secFileTools: 'File tools',
    secCommand: 'Command & sandbox',
    secPrompt: 'System prompt',
    secContext: 'Context',
    secMemory: 'Memory',
    secSummarize: 'Summarize',
    secCheckpoint: 'Checkpoints',
    secTokenCount: 'Token count',
    secImageGen: 'Image generation',
    secSkills: 'Skills',
    secSubagents: 'Sub-agents',
    secPinned: 'Pinned files',
    secRemote: 'Remote control',
    secStorage: 'Storage',
    secDeps: 'Dependencies',
    fldCheckUpdates: 'Check for updates',
    fldMaxToolIterations: 'Max tool iterations',
    fldDefaultToolMode: 'Default tool mode',
    fldLanguage: 'Language',
    fldTheme: 'Theme',
    fldWorkspaceBehavior: 'Restore workspace on start',
    fldLoadingText: 'Loading text',
    fldSmoothStreaming: 'Smooth streaming',
    fldSoundEnabled: 'Enable sounds',
    fldSoundVolume: 'Volume',
    fldSoundTheme: 'Sound theme',
    fldProxyEnabled: 'Enable proxy',
    fldProxyUrl: 'Proxy URL',
    fldProxyInsecure: 'Skip TLS verification',
    fldReadOutside: 'Read files outside workspace',
    fldWriteOutside: 'Write files outside workspace',
    fldListIgnore: 'List ignore patterns',
    fldFindExclude: 'Find exclude patterns',
    fldApplyFormat: 'Patch format',
    fldApplyAutoSave: 'Auto-save edits',
    fldApplyAutoSaveDelay: 'Auto-save delay (ms)',
    fldApplyGuard: 'Diff guard',
    fldApplyAutoApply: 'Auto-apply without review',
    fldSearchExclude: 'Search exclude patterns',
    fldSearchMaxFind: 'Max files to search',
    fldSearchCtxBefore: 'Context lines before',
    fldSearchCtxAfter: 'Context lines after',
    fldHistoryScope: 'History search scope',
    fldHistoryMax: 'Max matches',
    fldCmdShell: 'Default shell',
    fldCmdTimeout: 'Default timeout (s)',
    fldCmdMaxOutput: 'Max output lines',
    fldSandboxEnabled: 'Enable sandbox',
    fldSandboxLangs: 'Allowed languages',
    fldSandboxTimeout: 'Default timeout (s)',
    fldPromptMode: 'Prompt mode',
    fldPromptPrefix: 'Custom prefix',
    fldPromptSuffix: 'Custom suffix',
    fldPromptDynamicEnabled: 'Enable dynamic context template',
    fldPromptDynamic: 'Dynamic context template',
    fldCtxFiles: 'Include workspace file tree',
    fldCtxDepth: 'Max file depth',
    fldCtxTabs: 'Include open tabs',
    fldCtxMaxTabs: 'Max open tabs',
    fldCtxEditor: 'Include active editor',
    fldCtxIgnore: 'Ignore patterns',
    fldCtxDiag: 'Include diagnostics',
    fldMemEnabled: 'Enable memory',
    fldMemWake: 'Wake keywords',
    fldMemChars: 'Max chars per entry',
    fldSumRounds: 'Keep recent rounds',
    fldSumTokens: 'Keep recent tokens',
    fldSumSeparate: 'Separate model for summary',
    fldSumChannel: 'Summary channel',
    fldSumModel: 'Summary model',
    fldSumAttempts: 'Auto-summarize attempts',
    fldSumRatio: 'Summarize input ratio',
    fldCkptEnabled: 'Enable checkpoints',
    fldCkptMax: 'Max checkpoints',
    fldTokUrl: 'Token API URL',
    fldTokModel: 'Token model',
    fldTokKey: 'API Key',
    fldImgUrl: 'Service URL',
    fldImgModel: 'Model',
    fldImgAspect: 'Enable aspect ratio',
    fldImgAspectDef: 'Default aspect ratio',
    fldImgSize: 'Enable image size',
    fldImgSizeDef: 'Default size',
    fldImgMaxBatch: 'Max batch tasks',
    fldImgMaxPerTask: 'Max images per task',
    fldImgReturn: 'Return images to AI',
    fldImgKey: 'API Key',
    fldSubMaxConcurrent: 'Max concurrent',
    fldSubFailureMode: 'On failure',
    fldSubGeneralWorker: 'Enable general sub-agent',
    fldSubDefaultIterations: 'Default max iterations',
    fldSubDefaultRuntime: 'Default max runtime (s)',
    fldSubTools: 'Tools',
    fldPinnedAdd: 'Add pinned file',
    fldPinnedPath: 'Relative path',
    fldRcEnabled: 'Enable remote control',
    fldRcPort: 'Port',
    fldRcRestart: 'Restart server',
    fldRcStop: 'Stop server',
    fldRcDisconnectWarn: 'This page will disconnect when the port changes or remote control is turned off',
    fldStoragePath: 'Custom data directory',
    fldMigration: 'Migration status',
    fldDepName: 'Dependency',
    fldDepStatus: 'Status',
    on: 'On',
    off: 'Off',
    apiKeySet: 'Set (leave blank to keep)',
    keepBlank: 'Leave blank to keep',
    chipsHint: 'Type and press Enter to add',
    settingsSaved: 'Settings saved',
    settingsFailed: 'Failed to save',
    noData: 'No data',
    depInstalled: 'Available',
    depMissing: 'Missing',
    unlimited: 'Unlimited',
    seconds: 's',
    chipAdd: 'Add',
    chipRemove: 'Remove',
    /* ---- V4 新增 ---- */
    moreActions: 'More',
    noConversations: 'No conversations yet',
    renamed: 'Renamed',
    deleted: 'Deleted',
    you: 'You',
    assistant: 'Assistant',
    toolUsed: 'Tools used',
    edited: 'Saved',
    rerolling: 'Regenerating…',
    nothingToCopy: 'Nothing to copy',
    textarea: 'Multi-line text',
    copyFailed: 'Copy failed',
    toolConfirmTitle: 'Tool call awaiting approval',
    toolReject: 'Reject',
    toolApprove: 'Approve',
    modeChanged: 'Mode switched',
    channelChanged: 'Channel switched',
    modelChanged: 'Model switched',
    emptyDir: 'Empty directory',
    browseFolder: 'Browse folder',
    disabled: 'Disabled',
    manageModels: 'Manage models',
    activeModel: 'Active model',
    setActiveModel: 'Set active',
    remove: 'Remove',
    removed: 'Removed',
    modelIdHint: 'Model ID',
    modelNameHint: 'Display name (optional)',
    addModel: 'Add model',
    modelIdRequired: 'Model ID required',
    modelAdded: 'Model added',
    done: 'Done',
    secAppearance: 'Appearance',
    fldSelectionContext: 'Selected context',
    fldTpsBar: 'Show TPS bar',
    fldTokEnabled: 'Enable counting',
    fldSbxTimeout: 'Sandbox default timeout (ms)',
    fldSbxOutputLines: 'Max output lines',
    fldSbxCleanup: 'Clean temp dirs automatically',
    fldMemWakeLines: 'Wake lines',
    fldMemEntryChars: 'Max chars per entry',
    fldMemPartChars: 'Max chars per part',
    fldMemPartLines: 'Max lines per part',
    fldSumPrompt: 'Summary prompt',
    fldSumAutoPrompt: 'Auto-summary prompt',
    fldSumKeepRounds: 'Keep recent rounds',
    fldSumKeepTokens: 'Keep recent tokens (number or %)',
    fldSumSeparateModel: 'Use separate model',
    fldSumChannelId: 'Summary channel',
    fldSumModelId: 'Summary model',
    fldSumMaxAttempts: 'Auto-summary attempts',
    fldSumMaxRatio: 'Summary input ratio (%)',
    ckptEnable: 'Checkpoint toggle',
    ckptMessages: 'Message checkpoints',
    ckptMsgBefore: 'Checkpoint before messages',
    ckptMsgAfter: 'Checkpoint after messages',
    ckptModelOuter: 'Outer model layer only',
    ckptMergeUnchanged: 'Merge unchanged checkpoints',
    ckptTools: 'Tool backup config',
    ckptBeforeTools: 'Backup before tools',
    ckptAfterTools: 'Backup after tools',
    ckptExclusion: 'Exclusions',
    ckptProfiles: 'Exclusion profiles',
    ckptMaxSizeMiB: 'Max file size (MiB)',
    ckptCustomPatterns: 'Custom patterns',
    msgTypeUser: 'User messages',
    msgTypeModel: 'Model messages',
    ckptProfileLogs: 'Logs',
    ckptProfileAiModels: 'AI model files',
    ckptProfileDatasets: 'Datasets',
    ckptProfileCaches: 'Caches',
    ckptProfilePythonVenvs: 'Python virtualenvs',
    ckptProfileBuildArtifacts: 'Build artifacts',
    ckptProfileLargeMedia: 'Large media',
    ckptProfileArchives: 'Archives',
    fldDiagEnabled: 'Enable diagnostics',
    fldDiagSeverities: 'Diagnostic severities',
    fldDiagWorkspaceOnly: 'Workspace-only diagnostics',
    fldDiagOpenOnly: 'Open-files-only diagnostics',
    fldDiagPerFile: 'Max diagnostics per file',
    fldDiagMaxFiles: 'Max files',
    secMcp: 'MCP servers',
    secUsage: 'Usage stats',
    addMcpServer: 'Add MCP server',
    mcpTransport: 'Transport',
    mcpCommand: 'Command',
    subAgentsList: 'Sub-agents',
    install: 'Install',
    uninstall: 'Uninstall',
    installed: 'Installed',
    rejected: 'Rejected',
    toolArgs: 'Arguments',
    usageTotalTokens: 'Total tokens',
    usagePromptTokens: 'Prompt tokens',
    usageCandidatesTokens: 'Output tokens',
    usageTotalCost: 'Total cost',
    fldChStream: 'Stream output',
    fldChMultimodal: 'Multimodal tools',
    fldChStrictTools: 'Strict tools',
    fldChRetry: 'Auto retry',
    fldChRetryCount: 'Retry count',
    fldChRetryInterval: 'Retry interval (ms)',
    fldChCustomBodyEnabled: 'Custom request body',
    fldChCustomBody: 'Custom request body (JSON)',
    fldChCustomHeadersEnabled: 'Custom request headers',
    fldChCustomHeaders: 'Custom request headers (JSON)',
    fldApplyGuardThreshold: 'Diff guard threshold',
    fldMemSystemPrompt: 'Memory system prompt',
    fldPromptAssembly: 'Prompt assembly mode',
    promptAssemblyLegacy: 'Legacy templates',
    promptAssemblyEntries: 'Entries',
    fldPromptStrategy: 'Dynamic context strategy',
    /* ---- V6 additions ---- */
    btnFiles: 'Files',
    btnSettings: 'Settings',
    settingsClose: 'Close',
    chBasic: 'Basic',
    chContext: 'Context',
    chToolsCfg: 'Tools',
    chAdvanced: 'Advanced',
    fldChUseAuth: 'Use Authorization header',
    fldChContextMode: 'Mode',
    fldChContextThreshold: 'Context threshold',
    fldChAutoSummarize: 'Auto summarize',
    fldChToolCropNorm: 'Normalized coordinates',
    fldChTokenCountMethod: 'Count method',
    fldChTemperature: 'Temperature',
    fldChMaxOutputTokens: 'Max output tokens',
    fldChMaxImages: 'Max images',
    fldChTopP: 'Top-P',
    fldChTopK: 'Top-K',
    fldChFreqPenalty: 'Frequency penalty',
    fldChPresencePenalty: 'Presence penalty',
    fldChReasoning: 'Reasoning',
    fldChEffort: 'Effort',
    fldChEffortCustom: 'Custom effort',
    fldChSummary: 'Summary',
    fldChThinkingType: 'Thinking type',
    fldChThinkingBudget: 'Thinking budget',
    fldChThinkingDisplay: 'Display',
    fldChSendThoughts: 'Send thoughts',
    fldChHistoryRounds: 'History rounds',
    fldChPromptCaching: 'Prompt caching',
    fldChTtl: 'TTL',
    fldChKeepAlive: 'Keep alive',
    fldChDeepSeekUserId: 'DeepSeek user_id',
    fldChPdfAttachment: 'PDF attachment',
    fldChAnthropicUserId: 'anthropic user_id',
    fldChAutoRetry: 'Auto retry',
    memEntries: 'Memory entries',
    memAdd: 'Add',
    memAddPlaceholder: 'Type a memory entry…',
    memEmpty: 'No memories',
    memTotal: 'Total',
    memScope: 'Scope',
    memScopeGlobal: 'Global',
    memScopeWorkspace: 'Workspace',
    usageConversations: 'Conversations',
    usageByModel: 'By model',
    usageByDay: 'By day',
    usageRefresh: 'Refresh',
    usageThoughts: 'Thoughts',
    usageCacheRead: 'Cache read',
    usageModelMessages: 'Model messages',
    mcpDescription: 'Description',
    mcpArgs: 'Args',
    mcpEnv: 'Env (JSON)',
    mcpHeaders: 'Headers (JSON)',
    mcpAutoConnect: 'Auto connect',
    mcpCleanSchema: 'Clean schema',
    mcpTimeout: 'Timeout (ms)',
    mcpConnect: 'Connect',
    mcpDisconnect: 'Disconnect',
    mcpConnected: 'Connected',
    mcpDisconnected: 'Disconnected',
    subCreate: 'New sub-agent',
    subName: 'Name',
    subSystemPrompt: 'System prompt',
    subChannel: 'Channel',
    subModel: 'Model',
    subToolsMode: 'Tools mode',
    subWhitelist: 'Whitelist',
    subBlacklist: 'Blacklist',
    subMaxIterations: 'Max iterations',
    subMaxRuntime: 'Max runtime (s)',
    fldPromptTemplate: 'Template',
    fldPromptEntries: 'Entries',
    fldPromptToolPolicy: 'Tool policy',
    modeNew: 'New mode',
    modeRename: 'Rename',
    modeCopy: 'Duplicate',
    modeDelete: 'Delete',
    modeName: 'Mode name',
    ckptProfilePatterns: 'Profile patterns',
    ckptBranchCleanup: 'Branch cleanup',
    ckptRetentionDays: 'Retention days',
    fldSoundCooldown: 'Cooldown (ms)',
    fldSoundCues: 'Event cues',
    fldSoundSubCues: 'Sub-agent cues',
    fldSoundWindowsNotify: 'Windows notifications',
    fldSoundOnlyUnfocused: 'Only when unfocused',
    fldSoundCueWarning: 'Warning',
    fldSoundCueError: 'Error',
    fldSoundCueComplete: 'Task complete',
    fldSoundCueFail: 'Task failed',
    fldSplashEnabled: 'Splash screen',
    opExport: 'Export settings',
    opImport: 'Import settings',
    opCheckUpdate: 'Check for updates now',
    opUpdateNow: 'Update now',
    opStorageReset: 'Reset default',
    opStorageOpen: 'Show in Explorer',
    appInfo: 'App info',
    fldToolsAllEnable: 'Enable all',
    fldToolsAllDisable: 'Disable all',
    fldApplyOutside: 'Outside workspace',
    toolAllow: 'Allow',
    toolAsk: 'Ask',
    toolDeny: 'Deny',
    chSelector: 'Select channel',
    chEnableSection: 'Enable this config',
    chApiUrlSection: 'API URL',
    chApiKeySection: 'API Key',
    chModelsSection: 'Model list',
    chStreamSection: 'Stream output',
    chTypeSection: 'Channel type',
    chToolModeSection: 'Tool mode',
    chMultimodalSection: 'Multimodal',
    chStrictSection: 'Strict tools',
    chTimeoutSection: 'Timeout (ms)',
    chMaxCtxSection: 'Max context tokens',
    chContextMgmtSection: 'Context management',
    chToolOptionsSection: 'Tool options',
    chTokenCountSection: 'Token count method',
    chAdvancedSection: 'Advanced options',
    chCustomBodySection: 'Custom body',
    chCustomHeadersSection: 'Custom headers',
    chRetrySection: 'Auto retry',
    chThinkingGroup: 'Thinking config',
    chThoughtGroup: 'Thoughts relay config',
    chCacheGroup: 'Prompt Caching',
    chMaxImages: 'Max images',
    chNoConfigSelected: 'Select or create a channel first',
    chCustomBodyMode: 'Mode',
    chCustomBodyItems: 'Key-value items (JSON array)',
    chCustomBodyJson: 'JSON body',
    chCustomHeadersList: 'Header list (JSON array)',
    peEntriesLabel: 'Prompt entries',
    peName: 'Name',
    peRole: 'Role',
    peContent: 'Content',
    peFakeThought: 'Fake thought',
    peAdd: 'Add entry',
    peConvertLegacy: 'Convert from legacy templates',
    peMoveUp: 'Move up',
    peMoveDown: 'Move down',
    peDuplicate: 'Duplicate',
    peDelete: 'Delete',
    peChatHistory: 'Chat History',
    peChatHistoryHint: 'Real history insertion point (not removable)',
    peRoleSystem: 'system (merged into system prompt)',
    peRoleUser: 'user (temporary user context)',
    peRoleAssistant: 'assistant (temporary assistant message)',
    peEntriesHint: 'system entries merge into the system prompt; user/assistant entries act as temporary context; Chat History is the real history insertion point.',
    peLegacySystem: 'System prompt',
    peLegacyDynamic: 'Dynamic context',
    confirmSwitchType: 'Switching channel type resets its type-specific options. Continue?',
    toolConfigBtn: 'Config',
    toolShellGroup: 'Available shells',
    toolShellEnabled: 'Enabled',
    toolShellPath: 'Executable path',
    toolShellDefault: 'Set default',
    toolMaxIter: 'Max tool iterations',
    toolSandboxGlobal: 'Sandbox master switch',
    memScopeRow: 'Scope',
    memEdit: 'Edit',
    memSave: 'Save',
    memEditHint: 'Click an entry to edit',
    memNoScopes: 'No workspace memory scopes',
    memWorkspaceLabel: 'Workspace memory',
    rcSaveHint: 'Restart the remote control service after saving',
    usageRange: 'Time range',
    usageRangeAll: 'All',
    usageRangeToday: 'Today',
    usageRange7d: 'Last 7 days',
    usageRange30d: 'Last 30 days',
    usageCacheCreation: 'Cache creation tokens',
    usageSkipped: 'Skipped conversations',
    mcpTransportType: 'Transport type',
    mcpCapabilities: 'Capabilities',
    mcpLastError: 'Last error',
    mcpEnabledLabel: 'Enabled',
    subDescription: 'Description',
    subIncludeMcp: 'Include MCP tools',
    subPresets: 'Preset templates',
    subBlankPreset: 'Blank',
    diffWaiting: 'Desktop waiting for Diff approval',
    diffWaitingFor: 'Waiting for approval',
    diffView: 'View Diff',
    diffApprove: 'Approve',
    diffReject: 'Reject',
    diffOriginal: 'Original',
    diffNew: 'New',
    diffLoading: 'Loading Diff…',
    diffAccepted: 'Diff approved',
    diffRejected: 'Diff rejected',
    diffGuardTitle: 'Delete guard',
    diffAutoRejectHint: 'Auto-rejected if not processed in time (about 5 minutes)',
    streamingWait: 'Waiting for desktop response…'
  },
  ja: {
    appTitle: 'GrayCode リモート',
    statusConnecting: '接続中…',
    statusConnected: '接続済み',
    statusReconnecting: '再接続中…',
    statusStreaming: '生成中…',
    statusServerStopped: 'リモート制御はオフです',
    tabChat: '会話',
    tabFiles: 'ファイル',
    tabSettings: '設定',
    newChat: '新しい会話',
    conversations: '会話一覧',
    emptyConversation: 'まだ会話がありません。最初のメッセージを送ると自動作成されます。',
    emptyNewChat: '新しい会話の準備ができました。メッセージを入力して開始してください。',
    emptyMessages: 'メッセージはまだありません',
    untitled: '無題の会話',
    inputPlaceholder: 'メッセージを入力…',
    send: '送信',
    stop: '停止',
    loading: '読み込み中…',
    loadFailed: '読み込みに失敗しました',
    sendFailed: '送信に失敗しました',
    refresh: '更新',
    closeTab: '会話タブを閉じる',
    loadMore: 'さらに読み込む',
    copy: 'コピー',
    copied: 'コピーしました',
    rename: '名前を変更',
    renameDialogTitle: '会話名を変更',
    renamePlaceholder: '新しいタイトルを入力',
    renameSave: '保存',
    renameCancel: 'キャンセル',
    deleteConversation: '会話を削除',
    deleteConversationConfirm: 'この会話を削除しますか？この操作は元に戻せません。',
    deleteConversationDone: '会話を削除しました',
    deleteConversationFailed: '会話の削除に失敗しました',
    workspace: 'ワークスペース',
    workspaceRoot: 'ワークスペースのルート',
    switchWorkspace: 'ワークスペースを切り替え',
    noWorkspace: 'デスクトップでワークスペースが開かれていません',
    noWorkspaceHint: '先にパソコンでフォルダを開くと、ここからファイルの閲覧・編集ができます。',
    file: 'ファイル',
    openOnDesktop: 'デスクトップで開く',
    edit: '編集',
    save: '保存',
    saved: 'ワークスペースに保存しました',
    saveFailed: '保存に失敗しました',
    fileTooLarge: 'ファイルが大きすぎてモバイルで表示できません（デスクトップで開いてください）',
    fileReadFailed: 'ファイルの読み込みに失敗しました',
    back: '戻る',
    workspaceOpened: 'ワークスペースを開きました',
    workspaceNotFound: 'ワークスペースが見つかりません：先にデスクトップで開くか保存してください',
    addWorkspace: 'ワークスペースを追加',
    removeWorkspace: 'お気に入りから削除',
    workspaceRemoved: 'お気に入りから削除しました',
    openFolderDialog: 'デスクトップでフォルダ選択ダイアログを開きました',
    browseTitle: 'ワークスペースフォルダを選択',
    browseSelect: 'フォルダを参照',
    browseUp: '親フォルダ',
    browseRootLabel: 'すべてのドライブ',
    browseDrivesLabel: 'ドライブ一覧',
    chooseThisFolder: 'このフォルダをワークスペースにする',
    pickOnDesktop: 'または：デスクトップでフォルダ選択を開く',
    activeFile: '編集中',
    userLabel: '自分',
    assistantLabel: 'AI',
    modelTag: 'モデル',
    thinking: '思考',
    toolCall: 'ツール呼び出し',
    toolResult: 'ツール結果',
    systemMessage: 'システム',
    errorBanner: 'エラーが発生しました',
    streamInterrupted: '生成が中断されました',
    awaitingApproval: '承認待ち：',
    approve: '承認',
    reject: '拒否',
    toolApproved: 'ツール実行を承認しました',
    toolRejected: 'ツール実行を拒否しました',
    toolConfirmFailed: 'ツールの確認に失敗しました',
    retry: '再試行',
    retryFailed: '再試行に失敗しました',
    deleteMessage: 'メッセージを削除',
    deleteMessageConfirm: 'このメッセージとそれ以降を削除しますか？',
    deleteMessageDone: 'メッセージを削除しました',
    deleteMessageFailed: '削除に失敗しました',
    editMessage: 'メッセージを編集',
    editPlaceholder: '修正して再生成…',
    editFailed: '編集に失敗しました',
    editBranching: '再生成中…',
    reroll: '再生成',
    rerollFailed: '再生成に失敗しました',
    model: 'モデル',
    config: 'チャンネル',
    noConfigs: 'チャンネルが設定されていません。下のボタンから追加してください。',
    currentModel: '現在のモデル',
    noModels: 'このチャンネルにはモデルがありません',
    setModelFailed: 'モデルの切り替えに失敗しました',
    activeChannel: '現在のチャンネル',
    setActiveChannel: '現在のチャンネルに設定',
    enable: '有効',
    disable: '無効',
    modelSelect: 'チャンネルとモデルを選択',
    selMode: 'モード',
    selModeTitle: 'モードを選択',
    selModeDefault: 'デフォルト',
    selChannel: 'チャンネル',
    selChannelTitle: 'チャンネルを選択',
    selChannelNone: '未選択',
    selModel: 'モデル',
    selModelTitle: 'モデルを選択',
    selModelAuto: '自動',
    selThinking: '思考',
    selThinkingTitle: '思考レベル',
    selThinkingAuto: '自動',
    addChannel: 'チャンネルを追加',
    editChannel: '編集',
    deleteChannel: '削除',
    deleteChannelConfirm: 'このチャンネルを削除しますか？この操作は元に戻せません。',
    createChannel: '作成',
    saveChannel: 'チャンネルを保存',
    channelCreated: 'チャンネルを作成しました',
    channelSaved: 'チャンネルを保存しました',
    channelDeleted: 'チャンネルを削除しました',
    channelName: 'チャンネル名',
    channelNameRequired: 'チャンネル名を入力してください',
    channelType: 'チャンネルタイプ',
    channelUrl: 'API URL',
    channelApiKey: 'API Key',
    channelToolMode: 'ツールモード',
    channelTimeout: 'タイムアウト(ms)',
    channelMaxContext: '最大コンテキストトークン',
    connection: '接続状態',
    running: '実行中',
    stopped: '停止中',
    port: 'ポート',
    accessUrls: 'アクセス URL',
    appVersion: 'バージョン',
    securityTitle: 'セキュリティ',
    securityText: 'リモート制御はローカルネットワーク内でのみ利用でき、パスワード保護はありません。信頼できないネットワークでは有効にせず、使い終わったらオフにしてください。',
    secChannel: 'チャンネル',
    secGeneral: '一般',
    secUI: '外観',
    secProxy: 'プロキシ',
    secTools: 'ツール',
    secAutoExec: '自動実行',
    secFileTools: 'ファイルツール',
    secCommand: 'コマンドとサンドボックス',
    secPrompt: 'システムプロンプト',
    secContext: 'コンテキスト',
    secMemory: 'メモリ',
    secSummarize: '要約',
    secCheckpoint: 'チェックポイント',
    secTokenCount: 'トークン計数',
    secImageGen: '画像生成',
    secSkills: 'スキル',
    secSubagents: 'サブエージェント',
    secPinned: '固定ファイル',
    secRemote: 'リモート制御',
    secStorage: 'ストレージ',
    secDeps: '依存環境',
    fldCheckUpdates: '更新を確認',
    fldMaxToolIterations: '最大ツール反復',
    fldDefaultToolMode: 'デフォルトのツールモード',
    fldLanguage: '言語',
    fldTheme: 'テーマ',
    fldWorkspaceBehavior: '起動時にワークスペースを復元',
    fldLoadingText: '読み込みテキスト',
    fldSmoothStreaming: 'スムーズなストリーミング',
    fldSoundEnabled: 'サウンドを有効化',
    fldSoundVolume: '音量',
    fldSoundTheme: 'サウンドテーマ',
    fldProxyEnabled: 'プロキシを有効化',
    fldProxyUrl: 'プロキシ URL',
    fldProxyInsecure: 'TLS 検証をスキップ',
    fldReadOutside: 'ワークスペース外のファイルを読む',
    fldWriteOutside: 'ワークスペース外のファイルを書く',
    fldListIgnore: '一覧の無視パターン',
    fldFindExclude: '検索の除外パターン',
    fldApplyFormat: 'パッチ形式',
    fldApplyAutoSave: '編集を自動保存',
    fldApplyAutoSaveDelay: '自動保存の遅延(ms)',
    fldApplyGuard: '差分ガード',
    fldApplyAutoApply: '確認なしで自動適用',
    fldSearchExclude: '検索の除外パターン',
    fldSearchMaxFind: '最大検索ファイル数',
    fldSearchCtxBefore: '前のコンテキスト行数',
    fldSearchCtxAfter: '後のコンテキスト行数',
    fldHistoryScope: '履歴検索範囲',
    fldHistoryMax: '最大一致数',
    fldCmdShell: 'デフォルトシェル',
    fldCmdTimeout: 'デフォルトタイムアウト(秒)',
    fldCmdMaxOutput: '最大出力行数',
    fldSandboxEnabled: 'サンドボックスを有効化',
    fldSandboxLangs: '許可する言語',
    fldSandboxTimeout: 'デフォルトタイムアウト(秒)',
    fldPromptMode: 'プロンプトモード',
    fldPromptPrefix: 'カスタムプレフィックス',
    fldPromptSuffix: 'カスタムサフィックス',
    fldPromptDynamicEnabled: '動的コンテキストテンプレートを有効化',
    fldPromptDynamic: '動的コンテキストテンプレート',
    fldCtxFiles: 'ワークスペースファイルツリーを含める',
    fldCtxDepth: '最大ファイル深度',
    fldCtxTabs: '開いているタブを含める',
    fldCtxMaxTabs: '最大タブ数',
    fldCtxEditor: 'アクティブエディタを含める',
    fldCtxIgnore: '無視パターン',
    fldCtxDiag: '診断情報を含める',
    fldMemEnabled: 'メモリを有効化',
    fldMemWake: '起動キーワード',
    fldMemChars: 'エントリあたりの最大文字数',
    fldSumRounds: '保持する最近のラウンド数',
    fldSumTokens: '保持する最近のトークン数',
    fldSumSeparate: '要約用の別モデル',
    fldSumChannel: '要約チャンネル',
    fldSumModel: '要約モデル',
    fldSumAttempts: '自動要約の試行回数',
    fldSumRatio: '要約入力比率',
    fldCkptEnabled: 'チェックポイントを有効化',
    fldCkptMax: '最大チェックポイント数',
    fldTokUrl: '計数 API URL',
    fldTokModel: '計数モデル',
    fldTokKey: 'API Key',
    fldImgUrl: 'サービス URL',
    fldImgModel: 'モデル',
    fldImgAspect: 'アスペクト比を有効化',
    fldImgAspectDef: 'デフォルトのアスペクト比',
    fldImgSize: '画像サイズを有効化',
    fldImgSizeDef: 'デフォルトサイズ',
    fldImgMaxBatch: '最大バッチタスク数',
    fldImgMaxPerTask: 'タスクあたりの最大画像数',
    fldImgReturn: '画像を AI に返す',
    fldImgKey: 'API Key',
    fldSubMaxConcurrent: '最大同時実行数',
    fldSubFailureMode: '失敗時の処理',
    fldSubGeneralWorker: '汎用サブエージェントを有効化',
    fldSubDefaultIterations: 'デフォルトの最大反復',
    fldSubDefaultRuntime: 'デフォルトの最大実行時間(秒)',
    fldSubTools: 'ツール',
    fldPinnedAdd: '固定ファイルを追加',
    fldPinnedPath: '相対パス',
    fldRcEnabled: 'リモート制御を有効化',
    fldRcPort: 'ポート',
    fldRcRestart: 'サーバーを再起動',
    fldRcStop: 'サーバーを停止',
    fldRcDisconnectWarn: 'ポート変更または無効化でこのページの接続が切れます',
    fldStoragePath: 'カスタムデータディレクトリ',
    fldMigration: '移行状態',
    fldDepName: '依存',
    fldDepStatus: '状態',
    on: 'オン',
    off: 'オフ',
    apiKeySet: '設定済み（空欄のままにすると保持）',
    keepBlank: '空欄のままにすると保持',
    chipsHint: '入力して Enter で追加',
    settingsSaved: '設定を保存しました',
    settingsFailed: '保存に失敗しました',
    noData: 'データがありません',
    depInstalled: '利用可能',
    depMissing: '未インストール',
    unlimited: '無制限',
    seconds: '秒',
    chipAdd: '追加',
    chipRemove: '削除',
    /* ---- V4 追加 ---- */
    moreActions: 'その他',
    noConversations: '会話がありません',
    renamed: '名前を変更しました',
    deleted: '削除しました',
    you: 'あなた',
    assistant: 'アシスタント',
    toolUsed: '使用したツール',
    edited: '保存しました',
    rerolling: '再生成中…',
    nothingToCopy: 'コピーする内容がありません',
    textarea: '複数行テキスト',
    copyFailed: 'コピーに失敗しました',
    toolConfirmTitle: 'ツール呼び出しの確認待ち',
    toolReject: '拒否',
    toolApprove: '承認',
    modeChanged: 'モードを切り替えました',
    channelChanged: 'チャネルを切り替えました',
    modelChanged: 'モデルを切り替えました',
    emptyDir: '空のディレクトリです',
    browseFolder: 'フォルダを参照',
    disabled: '無効',
    manageModels: 'モデル管理',
    activeModel: '現在のモデル',
    setActiveModel: '現在に設定',
    remove: '削除',
    removed: '削除しました',
    modelIdHint: 'モデル ID',
    modelNameHint: '表示名（任意）',
    addModel: 'モデル追加',
    modelIdRequired: 'モデル ID を入力してください',
    modelAdded: 'モデルを追加しました',
    done: '完了',
    secAppearance: '外観',
    fldSelectionContext: '選択コンテキスト',
    fldTpsBar: 'TPS バーを表示',
    fldTokEnabled: 'カウントを有効化',
    fldSbxTimeout: 'サンドボックス既定タイムアウト(ms)',
    fldSbxOutputLines: '最大出力行数',
    fldSbxCleanup: '一時ディレクトリを自動削除',
    fldMemWakeLines: 'ウェイク行数',
    fldMemEntryChars: 'エントリ文字数上限',
    fldMemPartChars: 'パート文字数上限',
    fldMemPartLines: 'パート行数上限',
    fldSumPrompt: '要約プロンプト',
    fldSumAutoPrompt: '自動要約プロンプト',
    fldSumKeepRounds: '保持する最近のラウンド',
    fldSumKeepTokens: '保持するトークン（数値または%）',
    fldSumSeparateModel: '専用モデルで要約',
    fldSumChannelId: '要約チャネル',
    fldSumModelId: '要約モデル',
    fldSumMaxAttempts: '自動要約の試行回数',
    fldSumMaxRatio: '要約入力比率(%)',
    ckptEnable: 'チェックポイントスイッチ',
    ckptMessages: 'メッセージチェックポイント',
    ckptMsgBefore: 'メッセージ前チェックポイント',
    ckptMsgAfter: 'メッセージ後チェックポイント',
    ckptModelOuter: '外部モデル層のみ',
    ckptMergeUnchanged: '未変更チェックポイントを統合',
    ckptTools: 'ツールバックアップ設定',
    ckptBeforeTools: 'ツール実行前バックアップ',
    ckptAfterTools: 'ツール実行後バックアップ',
    ckptExclusion: '除外設定',
    ckptProfiles: '除外カテゴリ',
    ckptMaxSizeMiB: '最大ファイルサイズ(MiB)',
    ckptCustomPatterns: 'カスタム除外パターン',
    msgTypeUser: 'ユーザーメッセージ',
    msgTypeModel: 'モデルメッセージ',
    ckptProfileLogs: 'ログファイル',
    ckptProfileAiModels: 'AI モデルファイル',
    ckptProfileDatasets: 'データセット',
    ckptProfileCaches: 'キャッシュ',
    ckptProfilePythonVenvs: 'Python 仮想環境',
    ckptProfileBuildArtifacts: 'ビルド成果物',
    ckptProfileLargeMedia: '大容量メディア',
    ckptProfileArchives: 'アーカイブ',
    fldDiagEnabled: '診断情報を有効化',
    fldDiagSeverities: '診断レベル',
    fldDiagWorkspaceOnly: 'ワークスペースのみ',
    fldDiagOpenOnly: '開いているファイルのみ',
    fldDiagPerFile: 'ファイルあたりの最大診断数',
    fldDiagMaxFiles: '最大ファイル数',
    secMcp: 'MCP サーバー',
    secUsage: '使用量統計',
    addMcpServer: 'MCP サーバーを追加',
    mcpTransport: 'トランスポート',
    mcpCommand: '起動コマンド',
    subAgentsList: 'サブエージェント一覧',
    install: 'インストール',
    uninstall: 'アンインストール',
    installed: 'インストール済み',
    rejected: '拒否済み',
    toolArgs: '引数',
    usageTotalTokens: '合計トークン',
    usagePromptTokens: '入力トークン',
    usageCandidatesTokens: '出力トークン',
    usageTotalCost: '合計費用',
    fldChStream: 'ストリーミング出力',
    fldChMultimodal: 'マルチモーダルツール',
    fldChStrictTools: '厳格ツールモード',
    fldChRetry: '自動リトライ',
    fldChRetryCount: 'リトライ回数',
    fldChRetryInterval: 'リトライ間隔(ms)',
    fldChCustomBodyEnabled: 'カスタムリクエストボディ',
    fldChCustomBody: 'カスタムリクエストボディ(JSON)',
    fldChCustomHeadersEnabled: 'カスタムリクエストヘッダー',
    fldChCustomHeaders: 'カスタムリクエストヘッダー(JSON)',
    fldApplyGuardThreshold: '差分ガード閾値',
    fldMemSystemPrompt: 'メモリシステムプロンプト',
    fldPromptAssembly: 'プロンプト組立モード',
    promptAssemblyLegacy: '従来テンプレート',
    promptAssemblyEntries: 'エントリ',
    fldPromptStrategy: '動的コンテキスト戦略',
    /* ---- V6 追加 ---- */
    btnFiles: 'ファイル',
    btnSettings: '設定',
    settingsClose: '閉じる',
    chBasic: '基本設定',
    chContext: 'コンテキスト',
    chToolsCfg: 'ツール',
    chAdvanced: '詳細設定',
    fldChUseAuth: 'Authorization ヘッダーを使用',
    fldChContextMode: 'モード',
    fldChContextThreshold: 'コンテキスト閾値',
    fldChAutoSummarize: '自動要約',
    fldChToolCropNorm: '正規化座標',
    fldChTokenCountMethod: '計数方式',
    fldChTemperature: '温度',
    fldChMaxOutputTokens: '最大出力トークン',
    fldChMaxImages: '最大画像数',
    fldChTopP: 'Top-P',
    fldChTopK: 'Top-K',
    fldChFreqPenalty: '頻度ペナルティ',
    fldChPresencePenalty: '存在ペナルティ',
    fldChReasoning: '推論設定',
    fldChEffort: '強度',
    fldChEffortCustom: 'カスタム強度',
    fldChSummary: '出力詳細度',
    fldChThinkingType: '思考タイプ',
    fldChThinkingBudget: '思考予算',
    fldChThinkingDisplay: '表示',
    fldChSendThoughts: '思考を送信',
    fldChHistoryRounds: '履歴ラウンド',
    fldChPromptCaching: 'プロンプトキャッシュ',
    fldChTtl: 'TTL',
    fldChKeepAlive: 'キープアライブ',
    fldChDeepSeekUserId: 'DeepSeek user_id',
    fldChPdfAttachment: 'PDF添付',
    fldChAnthropicUserId: 'anthropic user_id',
    fldChAutoRetry: '自動リトライ',
    memEntries: 'メモリエントリ',
    memAdd: '追加',
    memAddPlaceholder: 'メモリを入力…',
    memEmpty: 'メモリなし',
    memTotal: '合計',
    memScope: 'スコープ',
    memScopeGlobal: 'グローバル',
    memScopeWorkspace: 'ワークスペース',
    usageConversations: '会話数',
    usageByModel: 'モデル別',
    usageByDay: '日別',
    usageRefresh: '更新',
    usageThoughts: '思考トークン',
    usageCacheRead: 'キャッシュ読み取り',
    usageModelMessages: 'モデルメッセージ',
    mcpDescription: '説明',
    mcpArgs: '引数',
    mcpEnv: '環境変数(JSON)',
    mcpHeaders: 'ヘッダー(JSON)',
    mcpAutoConnect: '自動接続',
    mcpCleanSchema: 'スキーマをクリーン',
    mcpTimeout: 'タイムアウト(ms)',
    mcpConnect: '接続',
    mcpDisconnect: '切断',
    mcpConnected: '接続済み',
    mcpDisconnected: '未接続',
    subCreate: 'サブエージェントを新規作成',
    subName: '名前',
    subSystemPrompt: 'システムプロンプト',
    subChannel: 'チャンネル',
    subModel: 'モデル',
    subToolsMode: 'ツールモード',
    subWhitelist: 'ホワイトリスト',
    subBlacklist: 'ブラックリスト',
    subMaxIterations: '最大反復',
    subMaxRuntime: '最大実行時間(秒)',
    fldPromptTemplate: 'テンプレート',
    fldPromptEntries: 'エントリ',
    fldPromptToolPolicy: 'ツールポリシー',
    modeNew: 'モードを新規作成',
    modeRename: '名前を変更',
    modeCopy: '複製',
    modeDelete: '削除',
    modeName: 'モード名',
    ckptProfilePatterns: 'プロファイルパターン',
    ckptBranchCleanup: 'ブランチクリーンアップ',
    ckptRetentionDays: '保持日数',
    fldSoundCooldown: '最小間隔(ms)',
    fldSoundCues: 'イベント音',
    fldSoundSubCues: 'サブエージェント音',
    fldSoundWindowsNotify: 'Windows通知',
    fldSoundOnlyUnfocused: '未フォーカス時のみ',
    fldSoundCueWarning: '警告',
    fldSoundCueError: 'エラー',
    fldSoundCueComplete: 'タスク完了',
    fldSoundCueFail: 'タスク失敗',
    fldSplashEnabled: 'スプラッシュ画面',
    opExport: '設定をエクスポート',
    opImport: '設定をインポート',
    opCheckUpdate: '今すぐ更新を確認',
    opUpdateNow: '今すぐ更新',
    opStorageReset: 'デフォルトに戻す',
    opStorageOpen: 'エクスプローラーで表示',
    appInfo: 'アプリ情報',
    fldToolsAllEnable: 'すべて有効',
    fldToolsAllDisable: 'すべて無効',
    fldApplyOutside: 'ワークスペース外書き込み',
    toolAllow: '許可',
    toolAsk: '確認',
    toolDeny: '拒否',
    chSelector: 'チャンネルを選択',
    chEnableSection: 'この設定を有効化',
    chApiUrlSection: 'API URL',
    chApiKeySection: 'API キー',
    chModelsSection: 'モデル一覧',
    chStreamSection: 'ストリーム出力',
    chTypeSection: 'チャンネルタイプ',
    chToolModeSection: 'ツールモード',
    chMultimodalSection: 'マルチモーダル',
    chStrictSection: '厳格ツール',
    chTimeoutSection: 'タイムアウト (ms)',
    chMaxCtxSection: '最大コンテキスト Tokens',
    chContextMgmtSection: 'コンテキスト管理',
    chToolOptionsSection: 'ツール設定',
    chTokenCountSection: 'トークン計数方法',
    chAdvancedSection: '詳細オプション',
    chCustomBodySection: 'カスタム Body',
    chCustomHeadersSection: 'カスタムヘッダー',
    chRetrySection: '自動リトライ',
    chThinkingGroup: '思考設定',
    chThoughtGroup: '思考送信設定',
    chCacheGroup: 'Prompt Caching',
    chMaxImages: '最大画像数',
    chNoConfigSelected: 'チャンネルを選択または作成してください',
    chCustomBodyMode: 'モード',
    chCustomBodyItems: 'キーと値（JSON 配列）',
    chCustomBodyJson: 'JSON ボディ',
    chCustomHeadersList: 'ヘッダー一覧（JSON 配列）',
    peEntriesLabel: 'プロンプトエントリ',
    peName: '名前',
    peRole: 'ロール',
    peContent: '内容',
    peFakeThought: '疑似思考',
    peAdd: 'エントリを追加',
    peConvertLegacy: '従来テンプレートから変換',
    peMoveUp: '上へ',
    peMoveDown: '下へ',
    peDuplicate: '複製',
    peDelete: '削除',
    peChatHistory: 'Chat History',
    peChatHistoryHint: '実際の履歴挿入位置（削除不可）',
    peRoleSystem: 'system（システムプロンプトに統合）',
    peRoleUser: 'user（一時的なユーザーコンテキスト）',
    peRoleAssistant: 'assistant（一時的なアシスタントメッセージ）',
    peEntriesHint: 'system はシステムプロンプトに統合され、user/assistant は一時コンテキスト、Chat History が実際の履歴挿入位置になります。',
    peLegacySystem: 'システムプロンプト',
    peLegacyDynamic: '動的コンテキスト',
    confirmSwitchType: 'チャンネルタイプを切り替えると、そのタイプ固有の設定がリセットされます。続行しますか？',
    toolConfigBtn: '設定',
    toolShellGroup: '利用可能な Shell',
    toolShellEnabled: '有効',
    toolShellPath: '実行ファイルパス',
    toolShellDefault: 'デフォルトに設定',
    toolMaxIter: '最大ツール呼び出し回数',
    toolSandboxGlobal: 'サンドボックス主スイッチ',
    memScopeRow: 'スコープ',
    memEdit: '編集',
    memSave: '保存',
    memEditHint: 'エントリをクリックして編集',
    memNoScopes: 'ワークスペースメモリスコープなし',
    memWorkspaceLabel: 'ワークスペースメモリ',
    rcSaveHint: '保存後、リモートコントロールサービスの再起動が必要です',
    usageRange: '期間',
    usageRangeAll: 'すべて',
    usageRangeToday: '今日',
    usageRange7d: '過去 7 日',
    usageRange30d: '過去 30 日',
    usageCacheCreation: 'キャッシュ作成トークン',
    usageSkipped: 'スキップされた会話',
    mcpTransportType: 'トランスポートタイプ',
    mcpCapabilities: '能力',
    mcpLastError: '最近のエラー',
    mcpEnabledLabel: '有効',
    subDescription: '説明',
    subIncludeMcp: 'MCP ツールを含める',
    subPresets: 'プリセットテンプレート',
    subBlankPreset: '空白',
    diffWaiting: 'デスクトップが Diff の承認を待機中',
    diffWaitingFor: '承認待ち',
    diffView: 'Diff を表示',
    diffApprove: '承認',
    diffReject: '拒否',
    diffOriginal: '元の内容',
    diffNew: '新しい内容',
    diffLoading: 'Diff を読み込み中…',
    diffAccepted: 'Diff は承認されました',
    diffRejected: 'Diff は拒否されました',
    diffGuardTitle: '削除警戒',
    diffAutoRejectHint: '長時間処理されない場合、自動的に拒否されます（約 5 分）',
    streamingWait: 'デスクトップの応答を待機中…'
  }
};

/** 语言解析：桌面端 ui.language（auto 时已由宿主解析）缺省回退 zh-CN */
function pickLang(lang: string | null | undefined): UiLang {
  if (lang === 'en' || lang === 'ja' || lang === 'zh-CN') return lang;
  return 'zh-CN';
}

/**
 * 渲染远程控制桌面版自包含页面。
 *
 * 页面结构（三段式，对齐桌面端 UI）：
 * - 顶栏：抽屉按钮 / 标题与连接状态 / 文件 / 设置 / 刷新；
 * - 会话页签条：多会话并行，全部页签（含未落库新对话）可关闭；
 * - 主视图：会话（消息 + 四选择器输入区）为唯一常驻视图；
 * - 全屏面板：文件面板（工作区 + 文件树 + 编辑器）/ 设置面板（纵向分类导航 + 分类卡片）；
 * - 弹层：底部选择器 / 工作区浏览 / 操作菜单 / 对话框 / 轻提示。
 */
export function renderRemoteControlUiHtml(lang: string | null | undefined): string {
  const uiLang = pickLang(lang);
  const texts = JSON.stringify(UI_TEXTS[uiLang]).replace(/</g, '\\u003c');
  const t = (key: keyof UiText): string => UI_TEXTS[uiLang][key] ?? key;

  return `<!DOCTYPE html>
<html lang="${uiLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#1e1e1e">
<title>GrayCode Remote</title>
<style>${REMOTE_UI_CSS}</style>
</head>
<body>
<div id="app">
  <header>
    <button class="icon-btn" id="btn-drawer" aria-label="${uiLang === 'en' ? 'conversations' : '会话列表'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>'}</button>
    <div class="title-wrap">
      <h1 id="title">GrayCode</h1>
      <div class="sub"><span class="dot" id="dot"></span><span id="status">&hellip;</span><span class="ws" id="ws-name" hidden></span></div>
    </div>
    <button class="icon-btn" id="btn-files" aria-label="${t('btnFiles')}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>'}</button>
    <button class="icon-btn" id="btn-settings" aria-label="${t('btnSettings')}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 4a7 7 0 0 0-.1-1.2l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.06-1.2L16.2 3h-4l-.6 2.54a7 7 0 0 0-2.06 1.2l-2.35-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.4l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.06 1.2L12.2 21h4l.6-2.54a7 7 0 0 0 2.06-1.2l2.35.95 2-3.46-2-1.55c.06-.4.1-.8.1-1.2z"/></svg>'}</button>
    <button class="icon-btn" id="btn-refresh" aria-label="${uiLang === 'en' ? 'refresh' : '刷新'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>'}</button>
  </header>

  <!-- 会话页签条：桌面端 ConversationTabs 同款；全部页签可关闭（含未落库新对话） -->
  <div id="tabs-bar"><div id="conv-tabs"></div></div>

  <!-- 会话侧栏抽屉（最近对话列表，实时刷新） -->
  <div id="drawer">
    <div class="drawer-backdrop" id="drawer-backdrop"></div>
    <aside class="drawer-panel">
      <div class="drawer-head">
        <span class="drawer-title" data-i18n="conversations"></span>
        <button class="icon-btn" id="btn-new" aria-label="${uiLang === 'en' ? 'new chat' : '新建会话'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>'}</button>
      </div>
      <div class="drawer-list" id="drawer-list"></div>
    </aside>
  </div>

  <div id="views">
    <section id="view-chat" class="view">
      <div id="messages" hidden></div>
      <div id="empty" hidden>
        <div class="big">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 7.03 2 12c0 2.6 1.27 4.9 3.27 6.47L4.3 21.6l3.6-1.2c1.3.39 2.7.6 4.1.6 5.5 0 10-4.03 10-9s-4.5-9-10-9z"/></svg>'}</div>
        <div id="empty-text"></div>
      </div>
      <div id="confirm-bar"></div>
      <div id="diff-bar"></div>
      <footer class="composer">
        <!-- 输入区选择器行：模型模式 / 渠道 / 模型 / 思考强度（桌面端 InputSelectorBar 同款） -->
        <div id="composer-meta"></div>
        <div class="composer-row">
          <textarea id="input" rows="1" autocomplete="off" enterkeyhint="send"></textarea>
          <button id="send" aria-label="${uiLang === 'en' ? 'send' : '发送'}"></button>
        </div>
      </footer>
    </section>
  </div>

  <!-- 文件面板（全屏，替换主视图；自选工作区 / 文件树 / 编辑器） -->
  <div id="panel-files" hidden>
    <div class="panel-head">
      <button class="icon-btn panel-back-btn" id="btn-files-back" aria-label="${uiLang === 'en' ? 'back' : '返回'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15 4l-8 8 8 8V4z"/></svg>'}</button>
      <span class="panel-title" data-i18n="tabFiles"></span>
    </div>
    <div class="panel-body" style="flex-direction:column;">
      <div id="ws-bar">
        <div style="flex:1;min-width:0;">
          <div class="ws-name" id="ws-bar-name">&mdash;</div>
          <div class="ws-sub" id="ws-bar-file"></div>
        </div>
        <button class="mini-btn" id="btn-ws-switch"></button>
        <button class="mini-btn" id="btn-ws-add">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>'}<span data-i18n="addWorkspace"></span></button>
      </div>
      <div id="file-tree"></div>
      <div id="file-viewer" hidden>
        <div id="file-viewer-head">
          <button class="icon-btn" id="btn-file-back" aria-label="${uiLang === 'en' ? 'back' : '返回'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15 4l-8 8 8 8V4z"/></svg>'}</button>
          <span class="fpath" id="file-viewer-path"></span>
          <button class="icon-btn" id="btn-open-desktop" aria-label="${uiLang === 'en' ? 'open on desktop' : '在桌面端打开'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h16v10H4V5zm2 12h12v2H6v-2z"/></svg>'}</button>
        </div>
        <textarea id="file-editor" spellcheck="false" readonly></textarea>
        <div id="file-viewer-foot">
          <span class="finfo" id="file-viewer-info"></span>
          <button class="save-btn" id="btn-save-file"></button>
        </div>
      </div>
    </div>
  </div>

  <!-- 设置面板（全屏，替换主视图；纵向分类导航 + 分类卡片） -->
  <div id="panel-settings" hidden>
    <div class="panel-head">
      <button class="icon-btn panel-back-btn" id="btn-settings-back" aria-label="${t('settingsClose')}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'}</button>
      <span class="panel-title" data-i18n="tabSettings"></span>
    </div>
    <div class="panel-body">
      <div id="settings-nav"></div>
      <div id="settings-scroll">
        <div id="settings-sections"></div>
      </div>
    </div>
  </div>
</div>

<!-- 底部弹层：选择器 / 工作区切换 / 目录浏览 -->
<div id="sheet">
  <div class="backdrop"></div>
  <div class="panel">
    <div id="sheet-list-mode">
      <div class="head">
        <b id="sheet-title">&hellip;</b>
        <span style="display:flex;gap:2px;">
          <button class="icon-btn" id="btn-sheet-browse" aria-label="${uiLang === 'en' ? 'browse' : '浏览目录'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>'}</button>
          <button class="icon-btn" id="btn-sheet-add" aria-label="${uiLang === 'en' ? 'add workspace' : '新增工作区'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>'}</button>
        </span>
      </div>
      <div class="list" id="sheet-list"></div>
    </div>
    <div id="sheet-browse-mode" hidden>
      <div class="head">
        <button class="icon-btn" id="btn-browse-back" aria-label="${uiLang === 'en' ? 'back' : '返回'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15 4l-8 8 8 8V4z"/></svg>'}</button>
        <span class="fpath" id="browse-path"></span>
        <button class="icon-btn" id="btn-browse-root" aria-label="${uiLang === 'en' ? 'drives' : '全部磁盘'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>'}</button>
      </div>
      <div class="list" id="browse-list"></div>
      <div class="sheet-actions">
        <button class="btn" id="btn-browse-pick"></button>
      </div>
    </div>
    <!-- 模型/渠道选择器（兼容旧锚点；实际渲染走通用 sheet-list） -->
    <div id="sheet-model-mode" hidden>
      <div class="head">
        <b id="sheet-model-title">&hellip;</b>
        <button class="icon-btn" id="btn-sheet-model-close" aria-label="${uiLang === 'en' ? 'close' : '关闭'}">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'}</button>
      </div>
      <div class="list" id="model-list"></div>
    </div>
  </div>
</div>

<!-- 消息操作菜单 -->
<div id="action-sheet">
  <div class="backdrop" id="act-backdrop"></div>
  <div class="panel"></div>
</div>

<!-- 对话框 -->
<div id="modal">
  <div class="backdrop"></div>
  <div class="box">
    <div id="modal-title"></div>
    <div id="modal-body"><textarea id="modal-input" spellcheck="false" hidden></textarea></div>
    <div id="modal-actions">
      <button class="btn secondary" id="modal-cancel"></button>
      <button class="btn" id="modal-ok"></button>
    </div>
  </div>
</div>

<div id="error-banner" hidden></div>

<!-- Diff 查看/批准对话框 -->
<div id="diff-modal">
  <div class="backdrop"></div>
  <div class="box">
    <div id="diff-modal-title"></div>
    <div id="diff-modal-body"><div class="diff-pane" id="diff-original"><div class="diff-pane-head"></div><pre class="diff-code"></pre></div><div class="diff-pane" id="diff-new"><div class="diff-pane-head"></div><pre class="diff-code"></pre></div></div>
    <div id="diff-modal-actions">
      <button class="btn secondary" id="diff-reject-btn"></button>
      <button class="btn" id="diff-approve-btn"></button>
      <button class="btn secondary" id="diff-close-btn"></button>
    </div>
  </div>
</div>

<div id="toast"></div>

${buildRemoteUiScript(texts, uiLang)}
</body>
</html>`;
}
