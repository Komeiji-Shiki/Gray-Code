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
    chipRemove: '移除'
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
    chipRemove: 'Remove'
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
    chipRemove: '削除'
  }
};

/** 语言解析：桌面端 ui.language（auto 时已由宿主解析）缺省回退 zh-CN */
function pickLang(lang: string | null | undefined): UiLang {
  if (lang === 'en' || lang === 'ja' || lang === 'zh-CN') return lang;
  return 'zh-CN';
}

/**
 * 渲染远程控制移动端自包含页面。
 *
 * 页面结构（与桌面端 UI 对齐）：
 * - 顶栏：抽屉按钮 / 标题与连接状态 / 刷新；
 * - 会话页签条：多会话并行，全部页签（含未落库新对话）可关闭；
 * - 主视图：会话（消息 + 四选择器输入区）/ 文件 / 设置（20 分类 + 渠道完整 CRUD）；
 * - 底部导航：会话 / 文件 / 设置；
 * - 弹层：底部选择器 / 工作区浏览 / 操作菜单 / 对话框 / 轻提示。
 */
export function renderRemoteControlUiHtml(lang: string | null | undefined): string {
  const uiLang = pickLang(lang);
  const texts = JSON.stringify(UI_TEXTS[uiLang]).replace(/</g, '\\u003c');

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
    <button class="icon-btn" id="btn-drawer" aria-label="${uiLang === 'en' ? 'conversations' : '会话列表'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>'}</button>
    <div class="title-wrap">
      <h1 id="title">GrayCode</h1>
      <div class="sub"><span class="dot" id="dot"></span><span id="status">&hellip;</span><span class="ws" id="ws-name" hidden></span></div>
    </div>
    <button class="icon-btn" id="btn-refresh" aria-label="${uiLang === 'en' ? 'refresh' : '刷新'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>'}</button>
  </header>

  <!-- 会话页签条：桌面端 ConversationTabs 同款；全部页签可关闭（含未落库新对话） -->
  <div id="tabs-bar"><div id="conv-tabs"></div></div>

  <!-- 会话侧栏抽屉（最近对话列表，实时刷新） -->
  <div id="drawer">
    <div class="drawer-backdrop" id="drawer-backdrop"></div>
    <aside class="drawer-panel">
      <div class="drawer-head">
        <span class="drawer-title" data-i18n="conversations"></span>
        <button class="icon-btn" id="btn-new" aria-label="${uiLang === 'en' ? 'new chat' : '新建会话'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5v14M5 12h14"/></svg>'}</button>
      </div>
      <div class="drawer-list" id="drawer-list"></div>
    </aside>
  </div>

  <div id="views">
    <section id="view-chat" class="view">
      <div id="messages" hidden></div>
      <div id="empty" hidden>
        <div class="big">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 7.03 2 12c0 2.6 1.27 4.9 3.27 6.47L4.3 21.6l3.6-1.2c1.3.39 2.7.6 4.1.6 5.5 0 10-4.03 10-9s-4.5-9-10-9z"/></svg>'}</div>
        <div id="empty-text"></div>
      </div>
      <div id="confirm-bar"></div>
      <footer class="composer">
        <!-- 输入区选择器行：模型模式 / 渠道 / 模型 / 思考强度（桌面端 InputSelectorBar 同款） -->
        <div id="composer-meta"></div>
        <div class="composer-row">
          <textarea id="input" rows="1" autocomplete="off" enterkeyhint="send"></textarea>
          <button id="send" aria-label="${uiLang === 'en' ? 'send' : '发送'}"></button>
        </div>
      </footer>
    </section>

    <section id="view-files" class="view" hidden>
      <div id="ws-bar">
        <div style="flex:1;min-width:0;">
          <div class="ws-name" id="ws-bar-name">&mdash;</div>
          <div class="ws-sub" id="ws-bar-file"></div>
        </div>
        <button class="ws-add-btn" id="btn-ws-add" aria-label="${uiLang === 'en' ? 'add workspace' : '新增工作区'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5v14M5 12h14"/></svg>'}</button>
        <button class="mini-btn" id="btn-ws-switch"></button>
      </div>
      <div id="file-tree"></div>
      <div id="file-viewer" hidden>
        <div id="file-viewer-head">
          <button class="icon-btn" id="btn-file-back" aria-label="${uiLang === 'en' ? 'back' : '返回'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 4l-8 8 8 8V4z"/></svg>'}</button>
          <span class="fpath" id="file-viewer-path"></span>
          <button class="icon-btn" id="btn-open-desktop" aria-label="${uiLang === 'en' ? 'open on desktop' : '在桌面端打开'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h16v10H4V5zm2 12h12v2H6v-2z"/></svg>'}</button>
        </div>
        <textarea id="file-editor" spellcheck="false" readonly></textarea>
        <div id="file-viewer-foot">
          <span class="finfo" id="file-viewer-info"></span>
          <button class="save-btn" id="btn-save-file"></button>
        </div>
      </div>
    </section>

    <section id="view-settings" class="view" hidden>
      <div id="settings-tabs"></div>
      <div id="settings-scroll">
        <div id="settings-sections"></div>
      </div>
    </section>
  </div>

  <nav id="tabbar">
    <button data-tab="chat" class="active">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 7.03 2 12c0 2.6 1.27 4.9 3.27 6.47L4.3 21.6l3.6-1.2c1.3.39 2.7.6 4.1.6 5.5 0 10-4.03 10-9s-4.5-9-10-9zm-5 10a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg>'}<span data-i18n="tabChat"></span></button>
    <button data-tab="files">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>'}<span data-i18n="tabFiles"></span></button>
    <button data-tab="settings">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 4a7 7 0 0 0-.1-1.2l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.06-1.2L16.2 3h-4l-.6 2.54a7 7 0 0 0-2.06 1.2l-2.35-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.4l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.06 1.2L12.2 21h4l.6-2.54a7 7 0 0 0 2.06-1.2l2.35.95 2-3.46-2-1.55c.06-.4.1-.8.1-1.2z"/></svg>'}<span data-i18n="tabSettings"></span></button>
  </nav>
</div>

<!-- 底部弹层：选择器 / 工作区切换 / 目录浏览 -->
<div id="sheet">
  <div class="backdrop"></div>
  <div class="panel">
    <div id="sheet-list-mode">
      <div class="head">
        <b id="sheet-title">&hellip;</b>
        <span style="display:flex;gap:2px;">
          <button class="icon-btn" id="btn-sheet-browse" aria-label="${uiLang === 'en' ? 'browse' : '浏览目录'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>'}</button>
          <button class="icon-btn" id="btn-sheet-add" aria-label="${uiLang === 'en' ? 'add workspace' : '新增工作区'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5v14M5 12h14"/></svg>'}</button>
        </span>
      </div>
      <div class="list" id="sheet-list"></div>
    </div>
    <div id="sheet-browse-mode" hidden>
      <div class="head">
        <button class="icon-btn" id="btn-browse-back" aria-label="${uiLang === 'en' ? 'back' : '返回'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 4l-8 8 8 8V4z"/></svg>'}</button>
        <span class="fpath" id="browse-path"></span>
        <button class="icon-btn" id="btn-browse-root" aria-label="${uiLang === 'en' ? 'drives' : '全部磁盘'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>'}</button>
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
        <button class="icon-btn" id="btn-sheet-model-close" aria-label="${uiLang === 'en' ? 'close' : '关闭'}">${'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6l12 12M18 6L6 18"/></svg>'}</button>
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

<div id="toast"></div>

${buildRemoteUiScript(texts, uiLang)}
</body>
</html>`;
}
