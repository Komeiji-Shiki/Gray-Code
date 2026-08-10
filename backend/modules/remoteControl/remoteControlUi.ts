/**
 * remoteControlUi.ts
 *
 * 远程控制移动端 UI（自包含单页 HTML）——「床上办公」主界面。
 *
 * 设计约束：
 * - 无外部依赖：HTML/CSS/JS 全部内联，随 HTTP 响应下发，移动端浏览器直接可用；
 * - 懒加载：本页面只由 RemoteControlServer 在「远程控制开启」时提供，
 *   关闭时服务器不存在，UI 代码完全不进入运行态（零资源占用）；
 * - 语言：随桌面端 ui.language（zh-CN/en/ja），默认 zh-CN。
 *
 * 页面结构（底部三页签 + 左侧会话抽屉，风格对齐桌面端 VS Code Dark+）：
 * - 会话：左侧抽屉查看/切换/新建/重命名/删除会话，长按消息可编辑（分支重生成）、
 *   重新生成、重试、删除；发送/停止、流式输出（SSE）、工具确认（批准/拒绝）；
 * - 文件：工作区文件树浏览、文本文件查看与编辑（保存回真实工作区）、
 *   在桌面端打开文件（带行号跳转）、切换工作区、新增工作区（手机端目录浏览
 *   自选或桌面端弹选择框）、移除收藏工作区；
 * - 设置：连接状态、局域网访问地址、渠道与模型切换、全量设置项
 *   （通用/界面/代理/工具/自动执行/文件工具/命令沙箱/提示词/上下文/记忆/
 *   总结/检查点/Token 计数/图像生成/技能/子代理/固定文件/远程控制/存储/依赖）、
 *   安全说明。
 *
 * 页面通过以下 API 与主进程通信（同一 origin，无 CORS）：
 *   GET  /api/status           运行状态 / 激活会话 / 工作区 / 语言
 *   GET  /api/conversations    会话列表
 *   GET  /api/messages         会话消息（role/parts 结构）
 *   GET  /api/workspace        当前工作区状态
 *   GET  /api/workspaces       工作区列表（当前打开 + 收藏）
 *   POST /api/workspace-switch 切换工作区（已打开→固定；仅收藏→宿主打开）
 *   POST /api/workspace-add    新增工作区（可携带 fsPath 直接打开，免桌面端弹窗）
 *   POST /api/workspace-remove 移除收藏工作区
 *   GET  /api/fs               服务端目录浏览（移动端自选工作区文件夹）
 *   GET  /api/files            工作区目录列表
 *   GET  /api/file             读取工作区文本文件
 *   POST /api/file             写入工作区文本文件（影响真实工作区）
 *   POST /api/open-file        在桌面端打开文件（可带行号）
 *   GET  /api/configs          渠道配置列表
 *   GET  /api/config           渠道详情（模型列表）
 *   POST /api/model            切换激活模型
 *   POST /api/channel-toggle   渠道启用/停用
 *   POST /api/channel-active   设为当前渠道
 *   GET  /api/settings         全量设置（密钥字段脱敏）
 *   POST /api/settings         更新设置（深合并语义与桌面端一致）
 *   GET  /api/tools            工具清单（启用状态）
 *   GET  /api/dependencies     依赖安装状态
 *   POST /api/send             发送消息（chatStream）
 *   POST /api/cancel           停止生成
 *   POST /api/retry            重试（retryStream）
 *   POST /api/edit-message     编辑用户消息并重新生成（chat.editBranchStream）
 *   POST /api/reroll           重新生成助手消息（chat.rerollStream）
 *   POST /api/delete-message   删除消息
 *   POST /api/conversation-delete 删除会话
 *   POST /api/tool-confirm     工具确认（批准/拒绝）
 *   POST /api/rename           重命名会话
 *   GET  /api/stream           SSE 事件流（hello/message/global/workspace/bye）
 */

const SUPPORTED_LANGS = ['zh-CN', 'en', 'ja'] as const;
type UiLang = typeof SUPPORTED_LANGS[number];

/** 页面内置文案（与桌面端 i18n 保持语义一致，仅覆盖移动端用到的子集） */
interface UiText {
  appTitle: string;
  statusConnecting: string;
  statusConnected: string;
  statusReconnecting: string;
  statusStreaming: string;
  statusServerStopped: string;
  tabChat: string;
  tabFiles: string;
  tabSettings: string;
  switchConversation: string;
  newChat: string;
  conversations: string;
  emptyConversation: string;
  inputPlaceholder: string;
  send: string;
  stop: string;
  loading: string;
  loadFailed: string;
  sendFailed: string;
  emptyMessages: string;
  untitled: string;
  rename: string;
  renameDialogTitle: string;
  renamePlaceholder: string;
  renameSave: string;
  renameCancel: string;
  modelTag: string;
  thinking: string;
  toolCall: string;
  toolResult: string;
  systemMessage: string;
  errorBanner: string;
  streamInterrupted: string;
  refresh: string;
  workspace: string;
  workspaceRoot: string;
  switchWorkspace: string;
  savedWorkspaces: string;
  noWorkspace: string;
  noWorkspaceHint: string;
  file: string;
  openOnDesktop: string;
  preview: string;
  edit: string;
  save: string;
  saved: string;
  saveFailed: string;
  fileTooLarge: string;
  binaryFile: string;
  fileReadFailed: string;
  back: string;
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
  model: string;
  config: string;
  noConfigs: string;
  currentModel: string;
  noModels: string;
  setModelFailed: string;
  connection: string;
  running: string;
  stopped: string;
  port: string;
  accessUrls: string;
  copy: string;
  copied: string;
  noUrls: string;
  appVersion: string;
  securityTitle: string;
  securityText: string;
  activeFile: string;
  streamLoading: string;
  userLabel: string;
  assistantLabel: string;
  editMessage: string;
  editPlaceholder: string;
  editFailed: string;
  editBranching: string;
  reroll: string;
  rerollFailed: string;
  deleteConversation: string;
  deleteConversationConfirm: string;
  deleteConversationDone: string;
  deleteConversationFailed: string;
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
  workspaceOpened: string;
  workspaceNotFound: string;
  /* 设置页全量设置项 */
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
  secStorage: string;
  secDeps: string;
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
  on: string;
  off: string;
  apiKeySet: string;
  keepBlank: string;
  chipsHint: string;
  settingsSaved: string;
  settingsFailed: string;
  noData: string;
  enable: string;
  disable: string;
  activeChannel: string;
  setActiveChannel: string;
  depInstalled: string;
  depMissing: string;
  unlimited: string;
  seconds: string;
  chipAdd: string;
  chipRemove: string;
}

export const UI_TEXTS: Record<UiLang, UiText> = {
  'zh-CN': {
    appTitle: 'GrayCode 远程控制',    statusConnecting: '连接中…',
    statusConnected: '已连接',
    statusReconnecting: '重连中…',
    statusStreaming: '生成中…',
    statusServerStopped: '远程控制已关闭',
    tabChat: '会话',
    tabFiles: '文件',
    tabSettings: '设置',
    switchConversation: '切换会话',
    newChat: '新建会话',
    conversations: '会话列表',
    emptyConversation: '还没有会话，发送第一条消息即可自动创建。',
    inputPlaceholder: '输入消息…',
    send: '发送',
    stop: '停止',
    loading: '加载中…',
    loadFailed: '加载失败',
    sendFailed: '发送失败',
    emptyMessages: '暂无消息',
    untitled: '未命名会话',
    rename: '重命名',
    renameDialogTitle: '重命名会话',
    renamePlaceholder: '输入新标题',
    renameSave: '保存',
    renameCancel: '取消',
    modelTag: '模型',
    thinking: '思考',
    toolCall: '工具调用',
    toolResult: '工具结果',
    systemMessage: '系统消息',
    errorBanner: '出错了',
    streamInterrupted: '生成已中断',
    refresh: '刷新',
    workspace: '工作区',
    workspaceRoot: '工作区根目录',
    switchWorkspace: '切换工作区',
    savedWorkspaces: '已收藏',
    noWorkspace: '桌面端未打开工作区',
    noWorkspaceHint: '先在电脑上打开一个文件夹，手机端即可浏览与编辑其中的文件。',
    file: '文件',
    openOnDesktop: '在桌面端打开',
    preview: '预览',
    edit: '编辑',
    save: '保存',
    saved: '已保存到工作区',
    saveFailed: '保存失败',
    fileTooLarge: '文件过大，手机上仅可查看（可在桌面端打开）',
    binaryFile: '无法在手机上显示二进制文件',
    fileReadFailed: '文件读取失败',
    back: '返回',
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
    model: '模型',
    config: '渠道',
    noConfigs: '没有已配置的渠道，请在桌面端设置',
    currentModel: '当前模型',
    noModels: '该渠道暂无可用模型',
    setModelFailed: '切换模型失败',
    connection: '连接状态',
    running: '运行中',
    stopped: '已停止',
    port: '端口',
    accessUrls: '访问地址',
    copy: '复制',
    copied: '已复制',
    noUrls: '未获取到局域网地址',
    appVersion: '版本',
    securityTitle: '安全说明',
    securityText: '远程控制仅在局域网内可用，无账号密码保护。请勿在不可信网络中开启，用毕请关闭。',
    activeFile: '正在编辑',
    streamLoading: '正在加载历史消息…',
    userLabel: '我',
    assistantLabel: 'AI',
    editMessage: '编辑消息',
    editPlaceholder: '修改内容后重新生成…',
    editFailed: '编辑失败',
    editBranching: '正在重新生成…',
    reroll: '重新生成',
    rerollFailed: '重新生成失败',
    deleteConversation: '删除会话',
    deleteConversationConfirm: '确定删除该会话？此操作不可恢复。',
    deleteConversationDone: '会话已删除',
    deleteConversationFailed: '删除会话失败',
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
    workspaceOpened: '工作区已打开',
    workspaceNotFound: '工作区不存在：请先在桌面端打开或收藏该目录',
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
    fldMemWake: '唤醒行数',
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
    enable: '启用',
    disable: '停用',
    activeChannel: '当前渠道',
    setActiveChannel: '设为当前渠道',
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
    switchConversation: 'Switch conversation',
    newChat: 'New chat',
    conversations: 'Conversations',
    emptyConversation: 'No conversations yet. Send a message to create one.',
    inputPlaceholder: 'Type a message…',
    send: 'Send',
    stop: 'Stop',
    loading: 'Loading…',
    loadFailed: 'Failed to load',
    sendFailed: 'Failed to send',
    emptyMessages: 'No messages yet',
    untitled: 'Untitled conversation',
    rename: 'Rename',
    renameDialogTitle: 'Rename conversation',
    renamePlaceholder: 'Enter a new title',
    renameSave: 'Save',
    renameCancel: 'Cancel',
    modelTag: 'Model',
    thinking: 'Thinking',
    toolCall: 'Tool call',
    toolResult: 'Tool result',
    systemMessage: 'System message',
    errorBanner: 'Something went wrong',
    streamInterrupted: 'Generation interrupted',
    refresh: 'Refresh',
    workspace: 'Workspace',
    workspaceRoot: 'Workspace root',
    switchWorkspace: 'Switch workspace',
    savedWorkspaces: 'Saved',
    noWorkspace: 'No workspace open on desktop',
    noWorkspaceHint: 'Open a folder on your computer first, then you can browse and edit its files from your phone.',
    file: 'File',
    openOnDesktop: 'Open on desktop',
    preview: 'Preview',
    edit: 'Edit',
    save: 'Save',
    saved: 'Saved to workspace',
    saveFailed: 'Failed to save',
    fileTooLarge: 'File is too large to edit from phone (read-only; open on desktop instead)',
    binaryFile: 'Binary files cannot be displayed on phone',
    fileReadFailed: 'Failed to read file',
    back: 'Back',
    awaitingApproval: 'Awaiting approval:',
    approve: 'Approve',
    reject: 'Reject',
    toolApproved: 'Tool approved',
    toolRejected: 'Tool rejected',
    toolConfirmFailed: 'Failed to confirm tool',
    retry: 'Retry',
    retryFailed: 'Failed to retry',
    deleteMessage: 'Delete messages',
    deleteMessageConfirm: 'Delete this message and everything after it?',
    deleteMessageDone: 'Messages deleted',
    deleteMessageFailed: 'Failed to delete',
    model: 'Model',
    config: 'Channel',
    noConfigs: 'No channels configured. Set one up on the desktop first.',
    currentModel: 'Current model',
    noModels: 'No models available for this channel',
    setModelFailed: 'Failed to switch model',
    connection: 'Connection',
    running: 'Running',
    stopped: 'Stopped',
    port: 'Port',
    accessUrls: 'Access URLs',
    copy: 'Copy',
    copied: 'Copied',
    noUrls: 'No LAN address found',
    appVersion: 'Version',
    securityTitle: 'Security note',
    securityText: 'Remote control works on your LAN only and has no password protection. Do not enable it on untrusted networks; turn it off when done.',
    activeFile: 'Editing',
    streamLoading: 'Loading history…',
    userLabel: 'You',
    assistantLabel: 'AI',
    editMessage: 'Edit message',
    editPlaceholder: 'Edit and regenerate…',
    editFailed: 'Failed to edit',
    editBranching: 'Regenerating…',
    reroll: 'Regenerate',
    rerollFailed: 'Failed to regenerate',
    deleteConversation: 'Delete conversation',
    deleteConversationConfirm: 'Delete this conversation? This cannot be undone.',
    deleteConversationDone: 'Conversation deleted',
    deleteConversationFailed: 'Failed to delete conversation',
    addWorkspace: 'Add workspace',
    removeWorkspace: 'Remove from saved',
    workspaceRemoved: 'Removed from saved',
    openFolderDialog: 'Folder picker opened on desktop',
    browseTitle: 'Choose workspace folder',
    browseSelect: 'Browse folders',
    browseUp: 'Parent folder',
    browseRootLabel: 'All drives',
    browseDrivesLabel: 'Drives',
    chooseThisFolder: 'Open this folder as workspace',
    pickOnDesktop: 'or open the picker on desktop',
    workspaceOpened: 'Workspace opened',
    workspaceNotFound: 'Workspace not found: open or save the folder on the desktop first',
    secGeneral: 'General',
    secUI: 'Appearance',
    secProxy: 'Proxy',
    secTools: 'Tools',
    secAutoExec: 'Auto-execute',
    secFileTools: 'File tools',
    secCommand: 'Command & sandbox',
    secPrompt: 'System prompt',
    secContext: 'Context awareness',
    secMemory: 'Memory',
    secSummarize: 'Summarize',
    secCheckpoint: 'Checkpoint',
    secTokenCount: 'Token count',
    secImageGen: 'Image generation',
    secSkills: 'Skills',
    secSubagents: 'Subagents',
    secPinned: 'Pinned files',
    secStorage: 'Data storage',
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
    fldReadOutside: 'Read outside workspace',
    fldWriteOutside: 'Write outside workspace',
    fldListIgnore: 'List ignore patterns',
    fldFindExclude: 'Find exclude patterns',
    fldApplyFormat: 'Patch format',
    fldApplyAutoSave: 'Auto-save edits',
    fldApplyAutoSaveDelay: 'Auto-save delay (ms)',
    fldApplyGuard: 'Diff guard',
    fldApplyAutoApply: 'Auto-apply without confirm',
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
    fldCtxMaxTabs: 'Max tabs',
    fldCtxEditor: 'Include active editor',
    fldCtxIgnore: 'Ignore patterns',
    fldCtxDiag: 'Include diagnostics',
    fldMemEnabled: 'Enable memory',
    fldMemWake: 'Wake lines',
    fldMemChars: 'Max chars per entry',
    fldSumRounds: 'Keep recent rounds',
    fldSumTokens: 'Keep recent tokens',
    fldSumSeparate: 'Use separate model',
    fldSumChannel: 'Summarize channel',
    fldSumModel: 'Summarize model',
    fldSumAttempts: 'Max auto-summarize attempts',
    fldSumRatio: 'Summarize input ratio',
    fldCkptEnabled: 'Enable checkpoint',
    fldCkptMax: 'Max checkpoints',
    fldTokUrl: 'Count API URL',
    fldTokModel: 'Count model',
    fldTokKey: 'API Key',
    fldImgUrl: 'Server URL',
    fldImgModel: 'Model',
    fldImgAspect: 'Enable aspect ratio',
    fldImgAspectDef: 'Default aspect ratio',
    fldImgSize: 'Enable size',
    fldImgSizeDef: 'Default size',
    fldImgMaxBatch: 'Max batch tasks',
    fldImgMaxPerTask: 'Max images per task',
    fldImgReturn: 'Return images to AI',
    fldImgKey: 'API Key',
    fldSubMaxConcurrent: 'Max concurrent agents',
    fldSubFailureMode: 'Failure mode',
    fldSubGeneralWorker: 'Enable general worker',
    fldSubDefaultIterations: 'Default max iterations',
    fldSubDefaultRuntime: 'Default max runtime (s)',
    fldSubTools: 'Tools',
    fldPinnedAdd: 'Add pinned file',
    fldPinnedPath: 'Relative path',
    fldRcEnabled: 'Enable remote control',
    fldRcPort: 'Port',
    fldRcRestart: 'Restart server',
    fldRcStop: 'Stop server',
    fldRcDisconnectWarn: 'Changing the port or turning it off will disconnect this page',
    fldStoragePath: 'Custom data path',
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
    enable: 'Enable',
    disable: 'Disable',
    activeChannel: 'Active channel',
    setActiveChannel: 'Set as active channel',
    depInstalled: 'Available',
    depMissing: 'Not installed',
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
    statusServerStopped: 'リモートコントロールはオフです',
    tabChat: '会話',
    tabFiles: 'ファイル',
    tabSettings: '設定',
    switchConversation: '会話を切り替え',
    newChat: '新しい会話',
    conversations: '会話一覧',
    emptyConversation: '会話はまだありません。メッセージを送信すると作成されます。',
    inputPlaceholder: 'メッセージを入力…',
    send: '送信',
    stop: '停止',
    loading: '読み込み中…',
    loadFailed: '読み込みに失敗',
    sendFailed: '送信に失敗',
    emptyMessages: 'メッセージはまだありません',
    untitled: '無題の会話',
    rename: '名前を変更',
    renameDialogTitle: '会話の名前を変更',
    renamePlaceholder: '新しいタイトルを入力',
    renameSave: '保存',
    renameCancel: 'キャンセル',
    modelTag: 'モデル',
    thinking: '思考',
    toolCall: 'ツール呼び出し',
    toolResult: 'ツール結果',
    systemMessage: 'システムメッセージ',
    errorBanner: 'エラーが発生しました',
    streamInterrupted: '生成が中断されました',
    refresh: '更新',
    workspace: 'ワークスペース',
    workspaceRoot: 'ワークスペースのルート',
    switchWorkspace: 'ワークスペースを切り替え',
    savedWorkspaces: '保存済み',
    noWorkspace: 'デスクトップにワークスペースがありません',
    noWorkspaceHint: '先にパソコンでフォルダを開いてください。スマホからファイルを閲覧・編集できます。',
    file: 'ファイル',
    openOnDesktop: 'デスクトップで開く',
    preview: 'プレビュー',
    edit: '編集',
    save: '保存',
    saved: 'ワークスペースに保存しました',
    saveFailed: '保存に失敗',
    fileTooLarge: 'ファイルが大きすぎて編集不可（読み取り専用。デスクトップで開いてください）',
    binaryFile: 'バイナリファイルは表示できません',
    fileReadFailed: 'ファイルの読み込みに失敗',
    back: '戻る',
    awaitingApproval: '承認待ち：',
    approve: '承認',
    reject: '拒否',
    toolApproved: 'ツールを承認しました',
    toolRejected: 'ツールを拒否しました',
    toolConfirmFailed: 'ツール確認に失敗',
    retry: '再試行',
    retryFailed: '再試行に失敗',
    deleteMessage: 'メッセージを削除',
    deleteMessageConfirm: 'このメッセージ以降をすべて削除しますか？',
    deleteMessageDone: '削除しました',
    deleteMessageFailed: '削除に失敗',
    model: 'モデル',
    config: 'チャネル',
    noConfigs: '設定済みのチャネルがありません。デスクトップで設定してください',
    currentModel: '現在のモデル',
    noModels: 'このチャネルに利用可能なモデルはありません',
    setModelFailed: 'モデル切り替えに失敗',
    connection: '接続状態',
    running: '稼働中',
    stopped: '停止中',
    port: 'ポート',
    accessUrls: 'アクセスURL',
    copy: 'コピー',
    copied: 'コピーしました',
    noUrls: 'LANアドレスを取得できませんでした',
    appVersion: 'バージョン',
    securityTitle: 'セキュリティ注意',
    securityText: 'リモートコントロールはLAN内のみで動作し、パスワード保護はありません。信頼できないネットワークでは有効にせず、使用後はオフにしてください。',
    activeFile: '編集中',
    streamLoading: '履歴を読み込み中…',
    userLabel: '私',
    assistantLabel: 'AI',
    editMessage: 'メッセージを編集',
    editPlaceholder: '内容を編集して再生成…',
    editFailed: '編集に失敗',
    editBranching: '再生成中…',
    reroll: '再生成',
    rerollFailed: '再生成に失敗',
    deleteConversation: '会話を削除',
    deleteConversationConfirm: 'この会話を削除しますか？この操作は元に戻せません。',
    deleteConversationDone: '会話を削除しました',
    deleteConversationFailed: '会話の削除に失敗',
    addWorkspace: 'ワークスペースを追加',
    removeWorkspace: '保存済みから削除',
    workspaceRemoved: '保存済みから削除しました',
    openFolderDialog: 'デスクトップでフォルダ選択ダイアログを開きました',
    browseTitle: 'ワークスペースフォルダを選択',
    browseSelect: 'フォルダを参照',
    browseUp: '親フォルダ',
    browseRootLabel: 'すべてのドライブ',
    browseDrivesLabel: 'ドライブ一覧',
    chooseThisFolder: 'このフォルダをワークスペースとして開く',
    pickOnDesktop: 'またはデスクトップで選択ダイアログを開く',
    workspaceOpened: 'ワークスペースを開きました',
    workspaceNotFound: 'ワークスペースが見つかりません：先にデスクトップで開くか保存してください',
    secGeneral: '一般',
    secUI: '外観',
    secProxy: 'プロキシ',
    secTools: 'ツール',
    secAutoExec: '自動実行',
    secFileTools: 'ファイルツール',
    secCommand: 'コマンドとサンドボックス',
    secPrompt: 'システムプロンプト',
    secContext: 'コンテキスト認識',
    secMemory: 'メモリ',
    secSummarize: '要約',
    secCheckpoint: 'チェックポイント',
    secTokenCount: 'トークンカウント',
    secImageGen: '画像生成',
    secSkills: 'スキル',
    secSubagents: 'サブエージェント',
    secPinned: '固定ファイル',
    secStorage: 'データ保存',
    secDeps: '依存環境',
    fldCheckUpdates: '更新を確認',
    fldMaxToolIterations: '最大ツール反復',
    fldDefaultToolMode: 'デフォルトツールモード',
    fldLanguage: '言語',
    fldTheme: 'テーマ',
    fldWorkspaceBehavior: '起動時にワークスペース復元',
    fldLoadingText: 'ローディング文言',
    fldSmoothStreaming: 'スムーズストリーミング',
    fldSoundEnabled: 'サウンドを有効化',
    fldSoundVolume: '音量',
    fldSoundTheme: 'サウンドテーマ',
    fldProxyEnabled: 'プロキシを有効化',
    fldProxyUrl: 'プロキシURL',
    fldProxyInsecure: 'TLS検証をスキップ',
    fldReadOutside: 'ワークスペース外の読み取り',
    fldWriteOutside: 'ワークスペース外の書き込み',
    fldListIgnore: '一覧の無視パターン',
    fldFindExclude: '検索の除外パターン',
    fldApplyFormat: 'パッチ形式',
    fldApplyAutoSave: '編集を自動保存',
    fldApplyAutoSaveDelay: '自動保存遅延(ms)',
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
    fldMemWake: 'ウェイク行数',
    fldMemChars: 'エントリ最大文字数',
    fldSumRounds: '保持する最近のラウンド',
    fldSumTokens: '保持する最近のトークン',
    fldSumSeparate: '別モデルで要約',
    fldSumChannel: '要約チャネル',
    fldSumModel: '要約モデル',
    fldSumAttempts: '自動要約の最大試行回数',
    fldSumRatio: '要約入力比率',
    fldCkptEnabled: 'チェックポイントを有効化',
    fldCkptMax: '最大チェックポイント数',
    fldTokUrl: 'カウントAPI URL',
    fldTokModel: 'カウントモデル',
    fldTokKey: 'APIキー',
    fldImgUrl: 'サーバーURL',
    fldImgModel: 'モデル',
    fldImgAspect: 'アスペクト比を有効化',
    fldImgAspectDef: 'デフォルトのアスペクト比',
    fldImgSize: 'サイズを有効化',
    fldImgSizeDef: 'デフォルトサイズ',
    fldImgMaxBatch: '最大バッチタスク',
    fldImgMaxPerTask: 'タスクあたり最大画像数',
    fldImgReturn: '画像をAIに返す',
    fldImgKey: 'APIキー',
    fldSubMaxConcurrent: '最大同時実行数',
    fldSubFailureMode: '失敗時の処理',
    fldSubGeneralWorker: '汎用ワーカーを有効化',
    fldSubDefaultIterations: 'デフォルト最大反復',
    fldSubDefaultRuntime: 'デフォルト最大実行時間(秒)',
    fldSubTools: 'ツール',
    fldPinnedAdd: '固定ファイルを追加',
    fldPinnedPath: '相対パス',
    fldRcEnabled: 'リモートコントロールを有効化',
    fldRcPort: 'ポート',
    fldRcRestart: 'サーバーを再起動',
    fldRcStop: 'サーバーを停止',
    fldRcDisconnectWarn: 'ポート変更または無効化でこのページの接続が切れます',
    fldStoragePath: 'カスタムデータパス',
    fldMigration: '移行状態',
    fldDepName: '依存',
    fldDepStatus: '状態',
    on: 'オン',
    off: 'オフ',
    apiKeySet: '設定済み（空欄のまま保持）',
    keepBlank: '空欄のまま保持',
    chipsHint: '入力してEnterで追加',
    settingsSaved: '設定を保存しました',
    settingsFailed: '保存に失敗',
    noData: 'データがありません',
    enable: '有効化',
    disable: '無効化',
    activeChannel: 'アクティブチャネル',
    setActiveChannel: 'アクティブチャネルに設定',
    depInstalled: '利用可能',
    depMissing: '未インストール',
    unlimited: '無制限',
    seconds: '秒',
    chipAdd: '追加',
    chipRemove: '削除'
  }
};

function pickLang(lang: string | null | undefined): UiLang {
  if (lang === 'en' || lang === 'ja' || lang === 'zh-CN') return lang;
  return 'zh-CN';
}

/**
 * 生成移动端控制页 HTML。
 *
 * @param lang 桌面端界面语言（ui.language，auto 时由宿主解析后传入）
 */
export function renderRemoteControlUiHtml(lang: string | null | undefined): string {
  const uiLang = pickLang(lang);
  const texts = JSON.stringify(UI_TEXTS[uiLang]).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="${uiLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#1e1e1e">
<title>GrayCode Remote</title>
<style>/* ============================================================
   GrayCode Remote — 与桌面端一致的视觉风格
   设计令牌与 electron-app/renderer/theme.css（VS Code Dark+）
   保持一致；浅色主题跟随系统 prefers-color-scheme
   （与桌面端 ui.theme=auto 同源）。扁平化、极简、黑白灰 + 蓝色点缀。
   ============================================================ */
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  --vscode-font-size: 13px;
  --vscode-foreground: #cccccc;
  --vscode-disabledForeground: rgba(204, 204, 204, 0.5);
  --vscode-errorForeground: #f48771;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-icon-foreground: #c5c5c5;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-editor-selectionBackground: #264f78;
  --vscode-editor-inactiveSelectionBackground: #3a3d41;
  --vscode-editor-findMatchHighlightBackground: rgba(234, 92, 0, 0.33);
  --vscode-focusBorder: #007fd4;
  --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
  --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
  --vscode-scrollbarSlider-activeBackground: rgba(191, 191, 191, 0.4);
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-border: rgba(255, 255, 255, 0.07);
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-button-secondaryHoverBackground: #45494e;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #a6a6a6;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-errorForeground: #f48771;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-warningForeground: #f9c74f;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-dropdown-background: #3c3c3c;
  --vscode-dropdown-foreground: #f0f0f0;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-checkbox-background: #3c3c3c;
  --vscode-checkbox-border: #3c3c3c;
  --vscode-checkbox-foreground: #f0f0f0;
  --vscode-list-activeSelectionBackground: #094771;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-warningForeground: #cca700;
  --vscode-tab-activeBackground: #1e1e1e;
  --vscode-tab-activeForeground: #ffffff;
  --vscode-tab-inactiveForeground: #969696;
  --vscode-tab-hoverBackground: #2d2d2d;
  --vscode-tab-activeBorderTop: #0078d4;
  --vscode-editorGroupHeader-tabsBackground: #252526;
  --vscode-sideBar-background: #252526;
  --vscode-sideBarSectionHeader-background: #303031;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-editorHoverWidget-background: #252526;
  --vscode-editorHoverWidget-border: #454545;
  --vscode-editorHoverWidget-foreground: #cccccc;
  --vscode-panel-border: #454545;
  --vscode-widget-border: #454545;
  --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-progressBar-background: #0e70c0;
  --vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.31);
  --vscode-toolbar-activeBackground: rgba(99, 102, 103, 0.31);
  --vscode-textBlockQuote-background: rgba(127, 127, 127, 0.1);
  --vscode-textBlockQuote-border: rgba(0, 122, 204, 0.5);
  --vscode-textCodeBlock-background: rgba(10, 10, 10, 0.4);
  --vscode-textLink-foreground: #3794ff;
  --vscode-textLink-activeForeground: #3794ff;
  --vscode-keybindingLabel-background: rgba(128, 128, 128, 0.17);
  --vscode-charts-red: #f14c4c;
  --vscode-charts-green: #89d185;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-purple: #b180d7;
  --vscode-charts-orange: #d18616;
  --vscode-editorError-foreground: #f14c4c;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-editorInfo-foreground: #3794ff;
  --vscode-editorHint-foreground: rgba(238, 238, 238, 0.7);
  --vscode-notificationsInfoIcon-foreground: #3794ff;
  --vscode-notificationsWarningIcon-foreground: #cca700;
  --vscode-terminal-background: #1e1e1e;
  --vscode-terminal-foreground: #cccccc;
  --vscode-terminal-ansiGreen: #0dbc79;
  --vscode-terminal-ansiRed: #cd3131;
  --vscode-editorLineNumber-foreground: #858585;
  --vscode-textPreformat-foreground: #d7ba7d;
  --radius-sm: 2px;
  --radius-md: 3px;
  --radius-lg: 4px;
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --transition-fast: 0.1s ease;
  --transition-normal: 0.15s ease;
  --footer-safe: env(safe-area-inset-bottom, 0px);
  --header-h: 46px;
  --tabbar-h: 54px;
}

@media (prefers-color-scheme: light) {
  :root {
    --vscode-foreground: #383a42;
    --vscode-disabledForeground: rgba(56, 58, 66, 0.45);
    --vscode-errorForeground: #d1242f;
    --vscode-descriptionForeground: #6e6e6e;
    --vscode-icon-foreground: #424242;
    --vscode-editor-background: #ffffff;
    --vscode-editor-foreground: #383a42;
    --vscode-editor-selectionBackground: #add6ff;
    --vscode-editor-inactiveSelectionBackground: #e5ebf1;
    --vscode-editor-findMatchHighlightBackground: rgba(234, 92, 0, 0.2);
    --vscode-focusBorder: #0090f1;
    --vscode-scrollbarSlider-background: rgba(100, 100, 100, 0.4);
    --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
    --vscode-scrollbarSlider-activeBackground: rgba(0, 0, 0, 0.25);
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-border: rgba(0, 0, 0, 0.1);
    --vscode-button-secondaryBackground: #e4e4e4;
    --vscode-button-secondaryForeground: #383a42;
    --vscode-button-secondaryHoverBackground: #d6d6d6;
    --vscode-input-background: #ffffff;
    --vscode-input-foreground: #383a42;
    --vscode-input-border: #cecece;
    --vscode-input-placeholderForeground: #6e6e6e;
    --vscode-inputValidation-errorBackground: #f8d7da;
    --vscode-inputValidation-errorForeground: #d1242f;
    --vscode-inputValidation-errorBorder: #d1242f;
    --vscode-inputValidation-warningBackground: #fff3cd;
    --vscode-inputValidation-warningForeground: #9a6700;
    --vscode-inputValidation-warningBorder: #b89500;
    --vscode-dropdown-background: #ffffff;
    --vscode-dropdown-foreground: #383a42;
    --vscode-dropdown-border: #cecece;
    --vscode-checkbox-background: #ffffff;
    --vscode-checkbox-border: #a0a0a0;
    --vscode-checkbox-foreground: #383a42;
    --vscode-list-activeSelectionBackground: #0060c0;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-list-hoverBackground: #e8e8e8;
    --vscode-list-warningForeground: #9a6700;
    --vscode-tab-activeBackground: #ffffff;
    --vscode-tab-activeForeground: #333333;
    --vscode-tab-inactiveForeground: #666666;
    --vscode-tab-hoverBackground: #f2f2f2;
    --vscode-tab-activeBorderTop: #0066bf;
    --vscode-editorGroupHeader-tabsBackground: #f3f3f3;
    --vscode-sideBar-background: #f3f3f3;
    --vscode-sideBarSectionHeader-background: #ebebeb;
    --vscode-editorWidget-background: #f3f3f3;
    --vscode-editorWidget-border: #c8c8c8;
    --vscode-editorHoverWidget-background: #f3f3f3;
    --vscode-editorHoverWidget-border: #c8c8c8;
    --vscode-editorHoverWidget-foreground: #383a42;
    --vscode-panel-border: #e0e0e0;
    --vscode-widget-border: #c8c8c8;
    --vscode-widget-shadow: rgba(0, 0, 0, 0.18);
    --vscode-badge-background: #c4c4c4;
    --vscode-badge-foreground: #333333;
    --vscode-progressBar-background: #0e70c0;
    --vscode-toolbar-hoverBackground: rgba(0, 0, 0, 0.08);
    --vscode-toolbar-activeBackground: rgba(0, 0, 0, 0.12);
    --vscode-textBlockQuote-background: rgba(0, 0, 0, 0.04);
    --vscode-textBlockQuote-border: rgba(0, 122, 204, 0.4);
    --vscode-textCodeBlock-background: #f0f0f0;
    --vscode-textLink-foreground: #0969da;
    --vscode-textLink-activeForeground: #0969da;
    --vscode-keybindingLabel-background: rgba(0, 0, 0, 0.06);
    --vscode-charts-red: #d1242f;
    --vscode-charts-green: #388a34;
    --vscode-charts-yellow: #9a6700;
    --vscode-charts-blue: #0066bf;
    --vscode-editorError-foreground: #d1242f;
    --vscode-editorWarning-foreground: #9a6700;
    --vscode-editorInfo-foreground: #0066bf;
    --vscode-notificationsInfoIcon-foreground: #0066bf;
    --vscode-notificationsWarningIcon-foreground: #9a6700;
    --vscode-terminal-background: #ffffff;
    --vscode-terminal-foreground: #333333;
    --vscode-terminal-ansiGreen: #1a7f37;
    --vscode-terminal-ansiRed: #d1242f;
    --vscode-editorLineNumber-foreground: #9d9d9f;
    --vscode-textPreformat-foreground: #a626a4;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; }
body {
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  font: var(--vscode-font-size)/1.5 var(--vscode-font-family);
  display: flex;
  flex-direction: column;
  overscroll-behavior: none;
}
button { font-family: inherit; font-size: inherit; color: inherit; }
textarea, input { font-family: inherit; font-size: inherit; color: inherit; }
::selection { background: var(--vscode-editor-selectionBackground); }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: var(--radius-sm); }

#app { display: flex; flex-direction: column; height: 100dvh; }

/* ---------- 顶栏：桌面端 tabs 栏同款 ---------- */
header {
  height: var(--header-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
header .title-wrap { flex: 1; min-width: 0; }
header h1 {
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-tab-activeForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
header .sub { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
header .ws { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45vw; }

.icon-btn {
  flex: none;
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--vscode-foreground);
  font-size: 16px;
  cursor: pointer;
  padding: 0;
}
.icon-btn:active { background: var(--vscode-toolbar-activeBackground); }
.icon-btn svg { width: 18px; height: 18px; fill: currentColor; }

.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
.dot.connected { background: var(--vscode-terminal-ansiGreen); }
.dot.streaming { background: var(--vscode-charts-blue); animation: pulse 1.1s ease-in-out infinite; }
.dot.connecting { background: var(--vscode-charts-yellow); }
.dot.error { background: var(--vscode-charts-red); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

#views { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.view[hidden] { display: none; }

/* ---------- 消息列表：桌面端 MessageList 同款（扁平行式，无聊天气泡） ---------- */
#messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding-bottom: 4px;
}
.msg {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.msg:last-child { border-bottom: none; }
.msg.user { background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent); }
.msg .meta { display: flex; align-items: center; gap: 8px; font-size: 12px; max-width: 100%; }
.msg .meta .role-label { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); flex: none; }
.msg.assistant .meta .role-label, .msg.system .meta .role-label { color: var(--vscode-descriptionForeground); }
.msg .meta .model { color: var(--vscode-textLink-foreground); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.msg-content { font-size: 13px; line-height: 1.6; color: var(--vscode-foreground); word-break: break-word; overflow-wrap: anywhere; }
.msg.system .msg-content { color: var(--vscode-descriptionForeground); font-size: 12.5px; }
.msg.error .msg-content { color: var(--vscode-charts-red); }

.md h1, .md h2, .md h3, .md h4 { margin: 10px 0 6px; line-height: 1.35; }
.md h1 { font-size: 1.25em; }
.md h2 { font-size: 1.15em; }
.md h3 { font-size: 1.08em; }
.md h4 { font-size: 1em; }
.md p { margin: 6px 0; }
.md p:first-child { margin-top: 0; }
.md p:last-child { margin-bottom: 0; }
.md ul, .md ol { margin: 6px 0; padding-left: 20px; }
.md li { margin: 3px 0; }
.md code {
  font: 12.5px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
}
.md pre {
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  margin: 8px 0;
  overflow-x: auto;
}
.md pre code { background: none; padding: 0; display: block; white-space: pre; }
.md blockquote {
  border-left: 3px solid var(--vscode-textBlockQuote-border);
  background: var(--vscode-textBlockQuote-background);
  padding: 2px 10px;
  margin: 8px 0;
  color: var(--vscode-descriptionForeground);
}
.md a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.md hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
.md table { border-collapse: collapse; margin: 8px 0; font-size: 13px; max-width: 100%; }
.md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
.md .table-wrap { overflow-x: auto; }

.caret {
  display: inline-block;
  width: 7px; height: 15px;
  background: var(--vscode-charts-blue);
  vertical-align: text-bottom;
  margin-left: 2px;
  animation: blink 0.9s steps(1) infinite;
}
@keyframes blink { 50% { opacity: 0; } }

.thoughts {
  font-size: 11.5px;
  color: var(--vscode-descriptionForeground);
  border: 1px dashed var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: 4px 10px;
  max-width: 100%;
}
.thoughts .md { max-height: 130px; overflow-y: auto; opacity: 0.75; }

.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--vscode-charts-blue);
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  padding: 2px 9px;
  margin: 2px 6px 2px 0;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}

.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-textLink-foreground);
  font-size: 12.5px;
  padding: 4px 12px;
  margin-top: 6px;
  cursor: pointer;
  align-self: flex-start;
}
.retry-btn:active { background: var(--vscode-list-hoverBackground); }

#empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
  padding: 20px;
  text-align: center;
}
#empty .big { font-size: 34px; opacity: .5; }

/* ---------- 工具确认条：桌面端 widget 风格 ---------- */
#confirm-bar {
  flex: none;
  display: none;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background);
  border-top: 1px solid var(--vscode-widget-border);
}
#confirm-bar.open { display: flex; }
#confirm-bar .head { font-size: 12px; color: var(--vscode-charts-yellow); display: flex; align-items: center; gap: 6px; }
#confirm-bar .tool-item {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  overflow: hidden;
}
#confirm-bar .tool-item .tname { font-size: 12.5px; font-weight: 600; color: var(--vscode-foreground); word-break: break-all; }
#confirm-bar .tool-item .targs { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin-top: 4px; overflow: hidden; word-break: break-all; }
#confirm-bar .tool-item .trow { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }
#confirm-bar button {
  border: none;
  border-radius: var(--radius-sm);
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
#confirm-bar .ok { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
#confirm-bar .ok:active { background: var(--vscode-button-hoverBackground); }
#confirm-bar .no { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#confirm-bar .no:active { background: var(--vscode-button-secondaryHoverBackground); }
#confirm-bar .pending { opacity: .6; pointer-events: none; }

/* ---------- 输入区：桌面端 InputArea 同款 ---------- */
footer.composer {
  flex: none;
  background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border);
  padding: 10px 16px;
  padding-bottom: calc(10px + var(--footer-safe));
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
#input {
  flex: 1;
  resize: none;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  padding: 8px 10px;
  max-height: 120px;
  min-height: 34px;
  outline: none;
  line-height: 1.5;
}
#input:focus { border-color: var(--vscode-focusBorder); }
#input:disabled { opacity: .6; }
#input::placeholder { color: var(--vscode-input-placeholderForeground); }
#send {
  flex: none;
  width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  padding: 0;
}
#send svg { width: 16px; height: 16px; fill: currentColor; }
#send:active { background: var(--vscode-toolbar-activeBackground); }
#send.stop { color: var(--vscode-charts-red); }
#send:disabled { opacity: .3; cursor: default; }

/* ---------- 底部页签：桌面端 tabs 同款（蓝顶边 + 活动底色） ---------- */
#tabbar {
  flex: none;
  display: flex;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-top: 1px solid var(--vscode-panel-border);
  padding-bottom: var(--footer-safe);
}
#tabbar button {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  border: none;
  background: transparent;
  color: var(--vscode-tab-inactiveForeground);
  font-size: 11px;
  padding: 8px 0 9px;
  cursor: pointer;
  position: relative;
}
#tabbar button svg { width: 20px; height: 20px; fill: currentColor; }
#tabbar button.active { color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-activeBackground); }
#tabbar button.active::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: var(--vscode-tab-activeBorderTop);
}

/* ---------- 左侧会话抽屉：桌面端侧栏（sideBar）同款 ---------- */
#drawer { position: fixed; inset: 0; z-index: 60; pointer-events: none; }
#drawer .drawer-backdrop {
  position: absolute; inset: 0;
  background: rgba(0, 0, 0, .4);
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease;
}
#drawer.open { pointer-events: auto; }
#drawer.open .drawer-backdrop { opacity: 1; pointer-events: auto; }
.drawer-panel {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: min(320px, 84vw);
  background: var(--vscode-sideBar-background);
  border-right: 1px solid var(--vscode-panel-border);
  display: flex;
  flex-direction: column;
  transform: translateX(-100%);
  transition: transform .18s ease;
  box-shadow: 2px 0 12px var(--vscode-widget-shadow);
}
#drawer.open .drawer-panel { transform: none; }
.drawer-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.drawer-head .drawer-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); }
.drawer-list { flex: 1; overflow-y: auto; padding: 4px 0 12px; }

/* ---------- 会话项（抽屉/切换单共用）：桌面端列表项同款 ---------- */
.conv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  text-align: left;
  cursor: pointer;
  width: 100%;
  border-radius: 0;
}
.conv-item:active { background: var(--vscode-list-hoverBackground); }
.conv-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.conv-item .t { flex: 1; min-width: 0; }
.conv-item .t .name {
  font-size: 13px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.conv-item.active .t .name { color: var(--vscode-list-activeSelectionForeground); }
.conv-item .t .preview {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 2px;
}
.conv-item.active .t .preview { color: var(--vscode-list-activeSelectionForeground); opacity: .8; }
.conv-item .when { flex: none; font-size: 11px; color: var(--vscode-descriptionForeground); }
.conv-item .conv-del {
  flex: none;
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  padding: 0;
}
.conv-item .conv-del svg { width: 14px; height: 14px; fill: currentColor; }
.conv-item .conv-del:active { background: var(--vscode-toolbar-activeBackground); color: var(--vscode-charts-red); }
.sheet-sep { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 12px 12px 4px; }

/* ---------- 文件页 ---------- */
#ws-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
#ws-bar .ws-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#ws-bar .ws-sub { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ws-bar .mini-btn {
  flex: none;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
}
#ws-bar .mini-btn:active { background: var(--vscode-button-secondaryHoverBackground); }
#ws-bar .ws-add-btn {
  flex: none;
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  padding: 0;
}
#ws-bar .ws-add-btn svg { width: 14px; height: 14px; fill: currentColor; }
#ws-bar .ws-add-btn:active { background: var(--vscode-button-secondaryHoverBackground); }

#file-tree { flex: 1; overflow-y: auto; padding: 4px 0 12px; }
.fdir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 0;
  color: var(--vscode-foreground);
  cursor: pointer;
  width: 100%;
  background: transparent;
  border: none;
  text-align: left;
  font-size: 13px;
}
.fdir-row:active { background: var(--vscode-list-hoverBackground); }
.fdir-row .caret-svg { width: 12px; height: 12px; fill: var(--vscode-descriptionForeground); flex: none; transition: transform .12s ease; }
.fdir-row.open .caret-svg { transform: rotate(90deg); }
.fdir-row .fname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fdir-row .fico { width: 16px; height: 16px; fill: var(--vscode-descriptionForeground); flex: none; }
.fdir-row .fsize { flex: none; font-size: 11px; color: var(--vscode-descriptionForeground); }
.fdir-row.binary { opacity: .55; }

#file-viewer { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#file-viewer-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
#file-viewer-head .fpath { flex: 1; min-width: 0; font-size: 12.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#file-editor {
  flex: 1;
  min-height: 0;
  resize: none;
  border: none;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font: 12.5px/1.6 var(--vscode-editor-font-family, Consolas, monospace);
  padding: 10px 12px;
  outline: none;
  white-space: pre;
  overflow: auto;
}
#file-viewer-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px calc(8px + var(--footer-safe));
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-top: 1px solid var(--vscode-panel-border);
}
#file-viewer-foot .finfo { flex: 1; min-width: 0; font-size: 11.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#file-viewer-foot .save-btn {
  flex: none;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 13px;
  font-weight: 500;
  padding: 7px 18px;
  cursor: pointer;
}
#file-viewer-foot .save-btn:active { background: var(--vscode-button-hoverBackground); }
#file-viewer-foot .save-btn:disabled { opacity: .5; cursor: default; }

/* ---------- 设置页：桌面端卡片（widget）风格 ---------- */
#settings-scroll { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.card {
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: var(--radius-lg);
  padding: 12px;
}
.card h3 { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; }
.set-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; }
.set-row .k { color: var(--vscode-descriptionForeground); width: 86px; flex: none; }
.set-row .v { flex: 1; min-width: 0; color: var(--vscode-foreground); word-break: break-all; text-align: right; }
.set-row .v.copyable { color: var(--vscode-textLink-foreground); cursor: pointer; }
.url-chip {
  display: flex; align-items: center; gap: 8px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  margin-top: 6px;
  font: 12px ui-monospace, Consolas, monospace;
  color: var(--vscode-foreground);
  cursor: pointer;
  word-break: break-all;
}
.url-chip:active { background: var(--vscode-list-hoverBackground); }

.cfg-item {
  border: 1px solid var(--vscode-widget-border);
  border-radius: var(--radius-lg);
  background: var(--vscode-editor-background);
  padding: 9px 11px;
  margin-bottom: 8px;
}
.cfg-item .cname { font-size: 13px; font-weight: 600; }
.cfg-item .cmodel { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cfg-item .mchips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cfg-item .mchip {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  background: var(--vscode-input-background);
  color: var(--vscode-foreground);
  font-size: 12px;
  padding: 3px 10px;
  cursor: pointer;
  max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cfg-item .mchip.active { border-color: var(--vscode-textLink-foreground); color: var(--vscode-textLink-foreground); }
.cfg-item .mchip:disabled { opacity: .5; }
.info-text { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.6; }

/* ---------- 设置页：全量设置项控件 ---------- */
.settings-sec h3 {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 2px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .4px;
}
.set-field { display: flex; align-items: center; gap: 8px; padding: 7px 0; font-size: 13px; flex-wrap: wrap; }
.set-field .k { color: var(--vscode-descriptionForeground); flex: 1 1 42%; min-width: 120px; }
.set-field .k .sub { display: block; font-size: 11px; opacity: .8; }
.set-field .ctl { flex: 1 1 45%; min-width: 130px; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.set-field input[type="text"], .set-field input[type="number"], .set-field input[type="password"],
.set-field select, .set-field textarea {
  width: 100%;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: 6px 8px;
  outline: none;
  min-width: 0;
}
.set-field textarea { min-height: 56px; resize: none; line-height: 1.5; }
.set-field input:focus, .set-field select:focus, .set-field textarea:focus { border-color: var(--vscode-focusBorder); }
.set-field select { -webkit-appearance: none; appearance: none; padding-right: 22px;
  background-image: linear-gradient(45deg, transparent 50%, var(--vscode-foreground) 50%),
    linear-gradient(135deg, var(--vscode-foreground) 50%, transparent 50%);
  background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%;
  background-size: 4px 4px; background-repeat: no-repeat; }
.tgl { position: relative; width: 38px; height: 20px; flex: none; }
.tgl input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.tgl .tr { position: absolute; inset: 0; border-radius: 999px; background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border); transition: background .15s ease; pointer-events: none; }
.tgl .tr::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--vscode-foreground); transition: transform .15s ease; }
.tgl input:checked + .tr { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
.tgl input:checked + .tr::after { transform: translateX(18px); background: #fff; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; width: 100%; }
.chips .chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  border: 1px solid var(--vscode-panel-border); border-radius: 999px;
  background: var(--vscode-input-background); color: var(--vscode-foreground);
  font-size: 12px; padding: 2px 9px; }
.chips .chip button { border: none; background: transparent; color: var(--vscode-descriptionForeground);
  cursor: pointer; font-size: 13px; line-height: 1; padding: 0 1px; }
.chips .chip button:active { color: var(--vscode-charts-red); }
.chips .chip-input { flex: 1 1 100%; display: flex; gap: 6px; }
.chips .chip-input input { flex: 1; min-width: 0; }
.chips .chip-input .mini-btn { flex: none; }
.mini-btn {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font: inherit; font-size: 12px;
  padding: 5px 12px; cursor: pointer; white-space: nowrap;
}
.mini-btn:active { background: var(--vscode-button-secondaryHoverBackground); }
.mini-btn.danger { background: transparent; color: var(--vscode-charts-red); border-color: var(--vscode-charts-red); }
.item-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-top: 1px solid var(--vscode-widget-border); }
.item-row:first-of-type { border-top: none; }
.item-row .t { flex: 1; min-width: 0; font-size: 13px; }
.item-row .t .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-row .t .sub { font-size: 11px; color: var(--vscode-descriptionForeground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.set-note { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; margin-top: 6px; }
#settings-sections { display: flex; flex-direction: column; gap: 12px; }
#settings-sections .card { padding-top: 8px; }

/* ---------- 目录浏览 ---------- */
#browse-list .dir-item { display: flex; align-items: center; gap: 8px; padding: 9px 6px;
  border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; }
#browse-list .dir-item:active { background: var(--vscode-list-hoverBackground); }
#browse-list .dir-item svg { width: 15px; height: 15px; fill: var(--vscode-charts-orange); flex: none; }
#browse-list .dir-item .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#browse-list .dir-item.active { background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground); }
#browse-list .dir-item.active svg { fill: var(--vscode-list-activeSelectionForeground); }
#btn-browse-pick { width: 100%; justify-content: center; }
#btn-browse-pick:disabled { opacity: .5; }

/* ---------- 底部弹层 / 操作菜单 / 模态框：桌面端 widget 风格 ---------- */
#sheet {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: none;
}
#sheet.open { display: flex; }
#sheet .backdrop {
  position: absolute; inset: 0;
  background: rgba(0, 0, 0, .5);
  animation: fadeIn .15s ease;
}
#sheet .panel {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  max-height: 75dvh;
  background: var(--vscode-editorWidget-background);
  border-top: 1px solid var(--vscode-widget-border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  padding: 10px 10px calc(10px + var(--footer-safe));
  display: flex;
  flex-direction: column;
  animation: slideUp .18s ease;
  box-shadow: 0 -4px 16px var(--vscode-widget-shadow);
}
#sheet .head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 6px 8px;
}
#sheet .head b { font-size: 13px; font-weight: 600; color: var(--vscode-foreground); }
#sheet .list { overflow-y: auto; display: flex; flex-direction: column; }

#action-sheet {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: none;
  align-items: flex-end;
  justify-content: stretch;
}
#action-sheet.open { display: flex; }
#action-sheet .backdrop {
  position: absolute; inset: 0;
  background: rgba(0, 0, 0, .5);
  animation: fadeIn .15s ease;
}
#action-sheet .panel {
  position: relative;
  width: 100%;
  background: var(--vscode-editorWidget-background);
  border-top: 1px solid var(--vscode-widget-border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  padding: 8px 10px calc(8px + var(--footer-safe));
  display: flex;
  flex-direction: column;
  gap: 2px;
  animation: slideUp .18s ease;
  box-shadow: 0 -4px 16px var(--vscode-widget-shadow);
}
.act-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  font-size: 14px;
  text-align: left;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.act-btn:active { background: var(--vscode-list-hoverBackground); }
.act-btn svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
.act-btn.danger { color: var(--vscode-charts-red); }
.act-sep { height: 1px; background: var(--vscode-widget-border); margin: 4px 10px; }

#modal {
  position: fixed; inset: 0; z-index: 40;
  display: none;
  align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .55);
}
#modal.open { display: flex; }
#modal .box {
  width: 100%; max-width: 320px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  box-shadow: 0 8px 24px var(--vscode-widget-shadow);
}
#modal h3 { font-size: 13px; font-weight: 600; margin-bottom: 12px; color: var(--vscode-foreground); }
#modal textarea {
  width: 100%;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: 8px 10px;
  outline: none;
  resize: none;
  min-height: 34px;
  max-height: 220px;
  line-height: 1.5;
}
#modal textarea:focus { border-color: var(--vscode-focusBorder); }
#modal .row { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }
#modal button {
  border: none;
  border-radius: var(--radius-sm);
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
#modal .cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#modal .cancel:active { background: var(--vscode-button-secondaryHoverBackground); }
#modal .ok { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
#modal .ok:active { background: var(--vscode-button-hoverBackground); }
#modal .danger { background: var(--vscode-charts-red); color: #fff; }
#modal .danger:active { background: #e03e2f; }
#modal button:disabled { opacity: .5; }

#toast {
  position: fixed;
  left: 50%;
  bottom: calc(var(--tabbar-h) + 40px + var(--footer-safe));
  transform: translateX(-50%);
  z-index: 70;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-widget-border);
  color: var(--vscode-foreground);
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 999px;
  box-shadow: 0 4px 16px var(--vscode-widget-shadow);
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
  max-width: 86vw;
  text-align: center;
}
#toast.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }

@keyframes fadeIn { from { opacity: 0; } }
@keyframes slideUp { from { transform: translateY(30px); opacity: 0; } }
</style>
</head>
<body>
<div id="app">
  <header>
    <button class="icon-btn" id="btn-drawer" title="conversations" aria-label="conversations">
      <svg viewBox="0 0 24 24"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>
    </button>
    <div class="title-wrap">
      <h1 id="title">GrayCode</h1>
      <div class="sub"><span class="dot" id="dot"></span><span id="status">&hellip;</span><span class="ws" id="ws-name" hidden></span></div>
    </div>
    <button class="icon-btn" id="btn-refresh" title="refresh" aria-label="refresh">
      <svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
    </button>
  </header>

  <!-- 会话侧栏：桌面端侧栏布局在手机端以左滑抽屉呈现 -->
  <div id="drawer">
    <div class="drawer-backdrop" id="drawer-backdrop"></div>
    <aside class="drawer-panel">
      <div class="drawer-head">
        <span class="drawer-title" data-i18n="conversations"></span>
        <button class="icon-btn" id="btn-new" title="new" aria-label="new">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div class="drawer-list" id="drawer-list"></div>
    </aside>
  </div>

  <div id="views">
    <section id="view-chat" class="view">
      <div id="messages" hidden></div>
      <div id="empty" hidden>
        <div class="big">&#128172;</div>
        <div id="empty-text"></div>
      </div>
      <div id="confirm-bar"></div>
      <footer class="composer">
        <textarea id="input" rows="1" autocomplete="off" enterkeyhint="send"></textarea>
        <button id="send" title="send" aria-label="send"></button>
      </footer>
    </section>

    <section id="view-files" class="view" hidden>
      <div id="ws-bar">
        <div style="flex:1;min-width:0;">
          <div class="ws-name" id="ws-bar-name">&mdash;</div>
          <div class="ws-sub" id="ws-bar-file"></div>
        </div>
        <button class="ws-add-btn" id="btn-ws-add" title="addWorkspace" aria-label="addWorkspace">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="mini-btn" id="btn-ws-switch"></button>
      </div>
      <div id="file-tree"></div>
      <div id="file-viewer" hidden>
        <div id="file-viewer-head">
          <button class="icon-btn" id="btn-file-back" aria-label="back">
            <svg viewBox="0 0 24 24"><path d="M15 4l-8 8 8 8V4z"/></svg>
          </button>
          <span class="fpath" id="file-viewer-path"></span>
          <button class="icon-btn" id="btn-open-desktop" title="desktop" aria-label="desktop">
            <svg viewBox="0 0 24 24"><path d="M4 5h16v10H4V5zm2 12h12v2H6v-2z"/></svg>
          </button>
        </div>
        <textarea id="file-editor" spellcheck="false" readonly></textarea>
        <div id="file-viewer-foot">
          <span class="finfo" id="file-viewer-info"></span>
          <button class="save-btn" id="btn-save-file"></button>
        </div>
      </div>
    </section>

    <section id="view-settings" class="view" hidden>
      <div id="settings-scroll">
        <div class="card">
          <h3 id="set-conn-title"></h3>
          <div class="set-row"><span class="k" id="set-conn-label"></span><span class="v" id="set-conn-val">&mdash;</span></div>
          <div class="set-row"><span class="k" id="set-port-label"></span><span class="v" id="set-port-val">&mdash;</span></div>
          <div class="set-row"><span class="k" id="set-ver-label"></span><span class="v" id="set-ver-val">&mdash;</span></div>
        </div>
        <div class="card">
          <h3 id="set-urls-title"></h3>
          <div id="urls-list"></div>
        </div>
        <div class="card">
          <h3 id="set-model-title"></h3>
          <div id="configs-list"></div>
        </div>
        <div id="settings-sections"></div>
        <div class="card">
          <h3 id="set-sec-title"></h3>
          <div class="info-text" id="set-sec-text"></div>
        </div>
      </div>
    </section>
  </div>

  <nav id="tabbar">
    <button data-tab="chat" class="active">
      <svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 7.03 2 12c0 2.6 1.27 4.9 3.27 6.47L4.3 21.6l3.6-1.2c1.3.39 2.7.6 4.1.6 5.5 0 10-4.03 10-9s-4.5-9-10-9zm-5 10a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg>
      <span data-i18n="tabChat"></span>
    </button>
    <button data-tab="files">
      <svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>
      <span data-i18n="tabFiles"></span>
    </button>
    <button data-tab="settings">
      <svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 4a7 7 0 0 0-.1-1.2l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.06-1.2L16.2 3h-4l-.6 2.54a7 7 0 0 0-2.06 1.2l-2.35-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.4l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.06 1.2L12.2 21h4l.6-2.54a7 7 0 0 0 2.06-1.2l2.35.95 2-3.46-2-1.55c.06-.4.1-.8.1-1.2z"/></svg>
      <span data-i18n="tabSettings"></span>
    </button>
  </nav>
</div>

<!-- 底部弹层：工作区切换 / 目录浏览 -->
<div id="sheet">
  <div class="backdrop"></div>
  <div class="panel">
    <div id="sheet-list-mode">
      <div class="head">
        <b id="sheet-title">&hellip;</b>
        <span style="display:flex;gap:2px;">
          <button class="icon-btn" id="btn-sheet-browse" title="browseSelect" aria-label="browseSelect">
            <svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>
          </button>
          <button class="icon-btn" id="btn-sheet-add" title="addWorkspace" aria-label="addWorkspace">
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </span>
      </div>
      <div class="list" id="sheet-list"></div>
    </div>
    <div id="sheet-browse-mode" hidden>
      <div class="head">
        <button class="icon-btn" id="btn-browse-back" aria-label="browseUp">
          <svg viewBox="0 0 24 24"><path d="M15 4l-8 8 8 8V4z"/></svg>
        </button>
        <b id="browse-path" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">&hellip;</b>
        <button class="icon-btn" id="btn-browse-root" aria-label="browseRootLabel">
          <svg viewBox="0 0 24 24"><path d="M4 9l8-5 8 5v11a1 1 0 0 1-1 1h-5v-7h-4v7H5a1 1 0 0 1-1-1V9z"/></svg>
        </button>
      </div>
      <div class="list" id="browse-list"></div>
      <div class="head" style="border-top:1px solid var(--vscode-widget-border);padding-top:8px;">
        <button class="mini-btn" id="btn-browse-pick"></button>
      </div>
    </div>
  </div>
</div>

<!-- 消息操作菜单：长按消息弹出（编辑/重新生成/删除） -->
<div id="action-sheet">
  <div class="backdrop" id="act-backdrop"></div>
  <div class="panel" id="act-panel"></div>
</div>

<!-- 模态框：重命名 / 编辑消息 / 删除确认 -->
<div id="modal">
  <div class="box">
    <h3 id="modal-title">&hellip;</h3>
    <textarea id="modal-input" rows="1" autocomplete="off" hidden></textarea>
    <div class="row">
      <button class="cancel" id="modal-cancel"></button>
      <button class="ok" id="modal-ok"></button>
    </div>
  </div>
</div>

<div id="toast"></div>
<script>
'use strict';
var T = ${texts};
function t(k) { return T[k] != null ? T[k] : k; }
function i18nAll() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
}
i18nAll();

var MAX_EDIT_CHARS = 1024 * 1024; /* 手机上可编辑的上限（超出只读） */

var state = {
  lang: '${uiLang}',
  appVersion: '',
  connected: false,
  streaming: false,
  conversationId: null,
  title: 'GrayCode',
  messages: [],
  streamingText: '',
  streamingModel: '',
  evtSource: null,
  reconnectTimer: null,
  toastTimer: null,
  sendInFlight: false,
  inputting: false,
  lastActiveConversation: null,
  /* 工作区 */
  workspaceUri: null,
  workspaceName: '',
  activeFilePath: null,
  fileDirs: {},            /* dirPath -> entries 缓存 */
  currentFile: null,       /* { path, content, dirty } */
  /* 工具确认 */
  pendingTools: [],        /* [{id,name,args}] */
  confirmInFlight: false,
  /* 模型 */
  configs: [],             /* [{id,name,model}] */
  configModels: {},        /* configId -> [{id,name}] */
  statusInfo: null,
  serverStopped: false,
  /* 设置页全量设置项 */
  settings: null,          /* 脱敏后的完整设置 */
  tools: [],               /* [{name,description,enabled,category}] */
  autoExec: {},            /* toolName -> boolean */
  deps: [],                /* [{name,installed,installedVersion}] */
  settingsBusy: false,
  /* 目录浏览 */
  browsePath: '',
  browseParent: null,
  browseDrives: [],
  browseBusy: false
};

var $ = function (id) { return document.getElementById(id); };
var messagesEl = $('messages');
var emptyEl = $('empty');
var inputEl = $('input');
var sendBtn = $('send');
var dotEl = $('dot');
var statusEl = $('status');
var titleEl = $('title');
var wsNameEl = $('ws-name');
var sheetEl = $('sheet');
var sheetListEl = $('sheet-list');
var sheetTitleEl = $('sheet-title');
var modalEl = $('modal');
var modalTitleEl = $('modal-title');
var modalInputEl = $('modal-input');
var modalCancelEl = $('modal-cancel');
var modalOkEl = $('modal-ok');
var toastEl = $('toast');
var confirmBarEl = $('confirm-bar');
var fileTreeEl = $('file-tree');
var fileViewerEl = $('file-viewer');
var fileEditorEl = $('file-editor');
var fileViewerInfoEl = $('file-viewer-info');
var fileViewerPathEl = $('file-viewer-path');
var saveFileBtnEl = $('btn-save-file');
var drawerEl = $('drawer');
var drawerListEl = $('drawer-list');
var actionSheetEl = $('action-sheet');
var actPanelEl = $('act-panel');
var browseListEl = $('browse-list');
var browsePathEl = $('browse-path');
var browsePickBtn = $('btn-browse-pick');
var settingsSectionsEl = $('settings-sections');

var ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
var ICON_STOP = '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>';

function renderSendIcon() {
  sendBtn.innerHTML = state.streaming ? ICON_STOP : ICON_SEND;
  sendBtn.title = state.streaming ? t('stop') : t('send');
  sendBtn.classList.toggle('stop', state.streaming);
}

function fmtTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  var now = new Date();
  var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  return (d.getMonth() + 1) + '/' + d.getDate();
}
function fmtSize(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function setStatus(kind, text) {
  dotEl.className = 'dot ' + kind;
  statusEl.textContent = text;
}
function setTitle(text) {
  titleEl.textContent = text || t('untitled');
  document.title = text ? (text + ' - GrayCode') : 'GrayCode Remote';
}
function setWorkspaceName(name) {
  state.workspaceName = name || '';
  wsNameEl.hidden = !name;
  wsNameEl.textContent = name;
  $('ws-bar-name').textContent = name || t('noWorkspace');
  $('ws-bar-file').textContent = state.activeFilePath || '';
  if (state.activeFilePath) {
    $('ws-bar-file').textContent = t('activeFile') + ': ' + state.activeFilePath;
  }
}
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
}
function scrollToBottom(force) {
  if (force) { messagesEl.scrollTop = messagesEl.scrollHeight; return; }
  var near = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  if (near) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok || (data && data.ok === false)) {
        var err = new Error((data && data.error) || ('HTTP ' + r.status));
        err.data = data;
        throw err;
      }
      return data;
    });
  });
}

/* ---------- markdown-lite ---------- */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderInline(s) {
  s = esc(s);
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function renderTable(lines, i) {
  var header = lines[i].split('|');
  if (header.length < 2) return null;
  var sep = lines[i + 1] ? lines[i + 1].split('|') : [];
  var isSep = sep.length >= 2 && sep.every(function (c) { return /^\\s*:?-{2,}:?\\s*$/.test(c.trim()); });
  if (!isSep) return null;
  var cells = function (arr) {
    return arr.map(function (c) { return c.trim(); }).filter(function (c, idx, a) { return idx > 0 && idx < a.length - 1 || a.length <= 2; });
  };
  var out = '<div class="table-wrap"><table><thead><tr>';
  var hc = cells(header);
  hc.forEach(function (c) { out += '<th>' + renderInline(c) + '</th>'; });
  out += '</tr></thead><tbody>';
  var consumed = 2;
  for (var j = i + 2; j < lines.length; j++) {
    var row = lines[j];
    if (!row.trim() || row.indexOf('|') < 0) break;
    var rc = cells(row.split('|'));
    out += '<tr>';
    for (var k = 0; k < hc.length; k++) out += '<td>' + renderInline(rc[k] != null ? rc[k] : '') + '</td>';
    out += '</tr>';
    consumed++;
  }
  out += '</tbody></table></div>';
  return { html: out, consumed: consumed };
}
function renderMarkdown(text) {
  if (!text) return '';
  var lines = String(text).replace(/\\r\\n/g, '\\n').split('\\n');
  var html = '';
  var inCode = false;
  var codeBuf = [];
  var inList = false;
  var listType = '';
  var inQuote = false;
  function closeBlock() {
    if (inList) { html += '</' + listType + '>'; inList = false; listType = ''; }
    if (inQuote) { html += '</blockquote>'; inQuote = false; }
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var fence = line.match(/^\\s*\`\`\`(.*)$/);
    if (fence) {
      if (inCode) {
        html += '<pre><code>' + esc(codeBuf.join('\\n')) + '</code></pre>';
        codeBuf = [];
        inCode = false;
      } else {
        closeBlock();
        inCode = true;
        codeBuf = [];
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (!line.trim()) { closeBlock(); continue; }
    var m;
    if ((m = line.match(/^(#{1,4})\\s+(.*)$/))) {
      closeBlock();
      var level = m[1].length;
      html += '<h' + level + '>' + renderInline(m[2]) + '</h' + level + '>';
    } else if ((m = line.match(/^>\\s?(.*)$/))) {
      if (!inQuote) { closeBlock(); inQuote = true; html += '<blockquote>'; }
      html += '<p>' + renderInline(m[1]) + '</p>';
    } else if (line.indexOf('|') >= 0) {
      var tbl = renderTable(lines, i);
      if (tbl) {
        closeBlock();
        html += tbl.html;
        i += tbl.consumed - 1;
      } else {
        closeBlock();
        html += '<p>' + renderInline(line) + '</p>';
      }
    } else if ((m = line.match(/^[-*+]\\s+(.*)$/))) {
      if (!inList || listType !== 'ul') { closeBlock(); inList = true; listType = 'ul'; html += '<ul>'; }
      html += '<li>' + renderInline(m[1]) + '</li>';
    } else if ((m = line.match(/^\\d+\\.\\s+(.*)$/))) {
      if (!inList || listType !== 'ol') { closeBlock(); inList = true; listType = 'ol'; html += '<ol>'; }
      html += '<li>' + renderInline(m[1]) + '</li>';
    } else if (/^(-{3,}|\\*{3,})$/.test(line.trim())) {
      closeBlock();
      html += '<hr>';
    } else {
      closeBlock();
      html += '<p>' + renderInline(line) + '</p>';
    }
  }
  closeBlock();
  if (inCode) html += '<pre><code>' + esc(codeBuf.join('\\n')) + '</code></pre>';
  return html;
}

/* ---------- message rendering ---------- */
function partsToText(parts, kind) {
  var out = [];
  (parts || []).forEach(function (p) {
    if (kind === 'thought') { if (p.thought && p.text) out.push(p.text); }
    else if (typeof p.text === 'string' && p.text && !p.thought) out.push(p.text);
  });
  return out.join('');
}
function partsToToolCalls(parts) {
  var calls = [];
  (parts || []).forEach(function (p) {
    if (p.functionCall && p.functionCall.name) calls.push(p.functionCall.name);
    else if (p.functionResponse && p.functionResponse.name) calls.push(p.functionResponse.name + ' ✓');
  });
  return calls;
}
function buildMessage(msg, index) {
  var el = document.createElement('div');
  var role = msg.role === 'user' ? 'user' : (msg.role === 'system' ? 'system' : 'assistant');
  el.className = 'msg ' + role;
  var roleLabel = role === 'user' ? t('userLabel') : (role === 'system' ? t('systemMessage') : t('assistantLabel'));
  var meta = '<div class="meta"><span class="role-label">' + esc(roleLabel) + '</span>' +
    (msg.role === 'model' && msg.modelVersion ? '<span class="model">' + esc(msg.modelVersion) + '</span>' : '') +
    '</div>';
  var body = '';
  if (msg.role === 'system') {
    body = partsToText(msg.parts, 'text') || t('systemMessage');
  } else {
    var thought = partsToText(msg.parts, 'thought');
    var text = partsToText(msg.parts, 'text');
    var calls = partsToToolCalls(msg.parts);
    if (thought) body += '<div class="thoughts"><div class="md">' + renderMarkdown(thought) + '</div></div>';
    calls.forEach(function (c) { body += '<span class="tool-chip">&#128295; ' + esc(c) + '</span>'; });
    if (text) body += '<div class="msg-content"><div class="md">' + renderMarkdown(text) + '</div></div>';
    else if (!thought && calls.length === 0) body += '<div class="msg-content">' + esc(t('emptyMessages')) + '</div>';
  }
  el.innerHTML = meta + body;
  // 长按消息 → 操作菜单（编辑/重新生成/删除），与桌面端消息操作对齐
  if (state.conversationId && role !== 'system') {
    attachLongPress(el, function () { openActionSheet(msg, index); });
  }
  return el;
}
function renderMessages() {
  messagesEl.innerHTML = '';
  if (state.messages.length === 0 && !state.streaming) {
    emptyEl.hidden = false;
    messagesEl.hidden = true;
    $('empty-text').textContent = t('emptyMessages');
    return;
  }
  emptyEl.hidden = true;
  messagesEl.hidden = false;
  state.messages.forEach(function (m, i) {
    var el = buildMessage(m, i);
    messagesEl.appendChild(el);
  });
  if (state.streaming) {
    var holder = document.createElement('div');
    holder.className = 'msg assistant';
    holder.innerHTML = '<div class="meta"><span class="role-label">' + esc(t('assistantLabel')) + '</span></div>' +
      '<div class="msg-content">' + (state.streamingText ? renderMarkdown(state.streamingText) : '') + '<span class="caret"></span></div>';
    messagesEl.appendChild(holder);
  }
  scrollToBottom(true);
}

/* ---------- 消息操作菜单（编辑 / 重新生成 / 删除） ---------- */
function openActionSheet(msg, index) {
  var role = msg.role === 'user' ? 'user' : 'assistant';
  var actions = [];
  if (role === 'user') {
    actions.push({ key: 'edit', label: t('editMessage'), icon: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>' });
  } else {
    actions.push({ key: 'reroll', label: t('reroll'), icon: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>' });
    actions.push({ key: 'retry', label: t('retry'), icon: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>' });
  }
  actions.push({ key: 'delete', label: t('deleteMessage'), danger: true, icon: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>' });
  actPanelEl.innerHTML = '';
  actions.forEach(function (a) {
    var btn = document.createElement('button');
    btn.className = 'act-btn' + (a.danger ? ' danger' : '');
    btn.innerHTML = a.icon + '<span>' + esc(a.label) + '</span>';
    btn.addEventListener('click', function () {
      closeActionSheet();
      if (a.key === 'edit') editMessage(msg, index);
      else if (a.key === 'reroll') rerollMessage(msg);
      else if (a.key === 'retry') doRetry();
      else if (a.key === 'delete') deleteMessageAt(index);
    });
    actPanelEl.appendChild(btn);
  });
  actionSheetEl.classList.add('open');
}
function closeActionSheet() { actionSheetEl.classList.remove('open'); actPanelEl.innerHTML = ''; }

function deleteMessageAt(index) {
  openModal(t('deleteMessageConfirm'), null, t('deleteMessage'), t('renameCancel'), 'danger', function () {
    api('/api/delete-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: state.conversationId, targetIndex: index })
    }).then(function () {
      toast(t('deleteMessageDone'));
      loadMessages(state.conversationId, true);
      loadConversations();
    }).catch(function (err) {
      toast(t('deleteMessageFailed') + ': ' + (err.message || ''));
    });
  });
}

function editMessage(msg, index) {
  var text = partsToText(msg.parts, 'text') || '';
  if (!msg.id) { toast(t('editFailed')); return; }
  openModal(t('editMessage'), text, t('renameSave'), t('renameCancel'), 'ok', function (val) {
    var v = (val || '').trim();
    if (!v || v === text) return;
    toast(t('editBranching') + '…');
    api('/api/edit-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: state.conversationId, messageId: msg.id, newText: v })
    }).then(function () {
      setStreaming(true, '');
    }).catch(function (err) {
      toast(t('editFailed') + ': ' + (err.message || ''));
    });
  });
}

function rerollMessage(msg) {
  if (!msg.id) { toast(t('rerollFailed')); return; }
  api('/api/reroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: state.conversationId, assistantNodeId: msg.id })
  }).then(function () {
    setStreaming(true, '');
  }).catch(function (err) {
    toast(t('rerollFailed') + ': ' + (err.message || ''));
  });
}

/* 长按（600ms）/ 右键 → 回调；移动端无右键时 contextmenu 事件兜底 */
function attachLongPress(el, onLong) {
  var timer = null;
  el.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    timer = setTimeout(function () { onLong(); }, 600);
  }, { passive: true });
  el.addEventListener('touchmove', function () { clearTimeout(timer); }, { passive: true });
  el.addEventListener('touchend', function () { clearTimeout(timer); });
  el.addEventListener('touchcancel', function () { clearTimeout(timer); });
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    onLong();
  });
}

/* ---------- data loading ---------- */
function loadMessages(conversationId, quiet) {
  if (!conversationId) return Promise.resolve();
  if (!quiet) renderLoading(true);
  return api('/api/messages?conversationId=' + encodeURIComponent(conversationId))
    .then(function (data) {
      state.messages = Array.isArray(data.messages) ? data.messages : [];
      renderLoading(false);
      renderMessages();
    })
    .catch(function (err) {
      renderLoading(false);
      if (!quiet) {
        toast(t('loadFailed') + ': ' + (err.message || ''));
        showErrorBanner(err.message || t('loadFailed'));
      }
    });
}
function renderLoading(on) {
  if (on && !state.messages.length) {
    emptyEl.hidden = false;
    messagesEl.hidden = true;
    $('empty-text').textContent = t('streamLoading');
  } else if (!on) {
    if (!state.messages.length && !state.streaming) {
      emptyEl.hidden = false;
      messagesEl.hidden = true;
      $('empty-text').textContent = t('emptyMessages');
    } else {
      emptyEl.hidden = true;
      messagesEl.hidden = false;
    }
  }
}
function showErrorBanner(msg, withRetry) {
  var el = document.createElement('div');
  el.className = 'msg error';
  el.innerHTML = '<div class="msg-content">' + esc(t('errorBanner')) + ': ' + esc(msg || '') + '</div>' +
    (withRetry ? '<button class="retry-btn">' + esc(t('retry')) + '</button>' : '');
  if (withRetry) {
    var btn = el.querySelector('.retry-btn');
    btn.addEventListener('click', doRetry);
  }
  // 空状态（#empty 显示中）时错误条会被隐藏容器吞掉：显式切回消息视图
  emptyEl.hidden = true;
  messagesEl.hidden = false;
  messagesEl.appendChild(el);
  scrollToBottom(true);
}
function loadConversations() {
  return api('/api/conversations').then(function (data) {
    var list = Array.isArray(data.conversations) ? data.conversations : [];
    drawerListEl.innerHTML = '';
    if (list.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'conv-item';
      empty.style.color = 'var(--vscode-descriptionForeground)';
      empty.textContent = t('emptyConversation');
      drawerListEl.appendChild(empty);
    }
    list.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'conv-item' + (c.id === state.conversationId ? ' active' : '');
      var it = document.createElement('button');
      it.className = 'conv-item-main';
      it.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;gap:10px;background:transparent;border:none;text-align:left;cursor:pointer;padding:0;color:inherit;font:inherit;';
      it.innerHTML = '<div class="t"><div class="name">' + esc(c.title || t('untitled')) + '</div>' +
        (c.preview ? '<div class="preview">' + esc(c.preview) + '</div>' : '') + '</div>' +
        '<span class="when">' + fmtTime(c.updatedAt) + '</span>';
      it.addEventListener('click', function () {
        switchConversation(c.id, c.title);
        closeDrawer();
      });
      it.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openRename(c.id, c.title);
      });
      row.appendChild(it);
      var del = document.createElement('button');
      del.className = 'conv-del';
      del.title = t('deleteConversation');
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        openModal(t('deleteConversationConfirm'), null, t('deleteConversation'), t('renameCancel'), 'danger', function () {
          api('/api/conversation-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: c.id })
          }).then(function () {
            toast(t('deleteConversationDone'));
            if (state.conversationId === c.id) {
              state.conversationId = null;
              state.messages = [];
              state.streaming = false;
              state.streamingText = '';
              state.pendingTools = [];
              renderConfirmBar();
              setTitle('');
              renderMessages();
            }
            loadConversations();
          }).catch(function (err) {
            toast(t('deleteConversationFailed') + ': ' + (err.message || ''));
          });
        });
      });
      row.appendChild(del);
      drawerListEl.appendChild(row);
    });
    return list;
  });
}
function switchConversation(id, title) {
  state.conversationId = id;
  state.streaming = false;
  state.streamingText = '';
  state.messages = [];
  state.pendingTools = [];
  renderConfirmBar();
  setTitle(title);
  renderSendIcon();
  renderMessages();
  loadMessages(id);
  loadConversations();
}
function openDrawer() {
  drawerEl.classList.add('open');
  loadConversations();
}
function closeDrawer() { drawerEl.classList.remove('open'); }

/* 工作区切换弹层（sheet 仅用于工作区；会话切换走左侧抽屉） */
function closeSheet() { sheetEl.classList.remove('open'); closeBrowseMode(); }

/* ---------- rename ---------- */
var renaming = null;
function openRename(id, title) {
  renaming = id;
  openModal(t('renameDialogTitle'), title || '', t('renameSave'), t('renameCancel'), 'ok', function (val) {
    var v = (val || '').trim();
    if (!v) return;
    api('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: renaming, title: v })
    }).then(function () {
      setTitle(v);
      loadConversations();
      toast(t('renameSave') + ' ✓');
    }).catch(function (err) {
      toast(t('sendFailed') + ': ' + (err.message || ''));
    });
  });
}
function openModal(title, inputValue, okText, cancelText, kind, onOk) {
  modalTitleEl.textContent = title;
  modalInputEl.value = inputValue || '';
  var multiline = typeof inputValue === 'string' && inputValue.length > 80;
  modalInputEl.hidden = (typeof inputValue !== 'string');
  modalInputEl.rows = multiline ? 5 : 1;
  modalInputEl.maxLength = 20000;
  modalOkEl.textContent = okText || t('renameSave');
  modalCancelEl.textContent = cancelText || t('renameCancel');
  modalOkEl.className = (kind === 'danger' ? 'danger' : 'ok');
  modalOkEl.disabled = false;
  modalEl._onOk = onOk;
  modalEl._onCancel = function () {};
  modalEl.classList.add('open');
  if (!modalInputEl.hidden) {
    setTimeout(function () { modalInputEl.focus(); }, 60);
  }
  autoResizeModalInput();
}
function autoResizeModalInput() {
  if (modalInputEl.hidden) return;
  modalInputEl.style.height = 'auto';
  modalInputEl.style.height = Math.min(modalInputEl.scrollHeight, 220) + 'px';
}
function closeModal() {
  modalEl.classList.remove('open');
  modalEl._onOk = null;
  modalEl._onCancel = null;
}

/* ---------- send / stop / retry ---------- */
function setStreaming(on, model) {
  state.streaming = on;
  state.streamingModel = model || '';
  if (on) {
    setStatus('streaming', t('statusStreaming'));
  } else {
    setStatus(state.connected ? 'connected' : 'connecting', state.connected ? t('statusConnected') : t('statusConnecting'));
  }
  renderSendIcon();
  renderMessages();
}
function canSend() {
  return state.connected && !state.sendInFlight && !state.streaming;
}
function updateSendBtn() {
  var hasText = inputEl.value.trim().length > 0;
  sendBtn.disabled = !hasText || !canSend();
}
function doSend() {
  var text = inputEl.value.trim();
  if (!text || !canSend()) return;
  inputEl.value = '';
  updateSendBtn();
  state.sendInFlight = true;
  sendBtn.disabled = true;
  var payload = { text: text };
  if (state.conversationId) payload.conversationId = state.conversationId;
  api('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (data) {
    if (data.conversationId && data.conversationId !== state.conversationId) {
      state.conversationId = data.conversationId;
      state.messages = [];
      renderMessages();
      loadConversations();
    }
    setStreaming(true, '');
  }).catch(function (err) {
    toast(t('sendFailed') + ': ' + (err.message || ''));
  }).finally(function () {
    state.sendInFlight = false;
    updateSendBtn();
  });
}
function doStop() {
  if (!state.conversationId) return;
  api('/api/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: state.conversationId })
  }).catch(function () {});
}
function doRetry() {
  if (!state.conversationId) return;
  toast(t('retry') + '…');
  api('/api/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: state.conversationId })
  }).then(function () {
    setStreaming(true, '');
  }).catch(function (err) {
    toast(t('retryFailed') + ': ' + (err.message || ''));
  });
}

/* ---------- tool confirmation ---------- */
function renderConfirmBar() {
  confirmBarEl.innerHTML = '';
  if (state.pendingTools.length === 0) {
    confirmBarEl.classList.remove('open');
    return;
  }
  confirmBarEl.classList.add('open');
  var head = document.createElement('div');
  head.className = 'head';
  head.textContent = '🛠 ' + t('awaitingApproval');
  confirmBarEl.appendChild(head);
  state.pendingTools.forEach(function (tool) {
    var item = document.createElement('div');
    item.className = 'tool-item' + (state.confirmInFlight ? ' pending' : '');
    var argsText = '';
    try {
      argsText = tool.args && typeof tool.args === 'object'
        ? JSON.stringify(tool.args).slice(0, 240)
        : String(tool.args || '').slice(0, 240);
    } catch (e) { argsText = ''; }
    var argsHtml = argsText ? '<div class="targs">' + esc(argsText) + '</div>' : '';
    item.innerHTML = '<div class="tname">' + esc(tool.name || 'tool') + '</div>' + argsHtml +
      '<div class="trow">' +
      '<button class="no" data-act="reject" data-id="' + esc(tool.id || '') + '">' + esc(t('reject')) + '</button>' +
      '<button class="ok" data-act="approve" data-id="' + esc(tool.id || '') + '">' + esc(t('approve')) + '</button>' +
      '</div>';
    confirmBarEl.appendChild(item);
  });
}
function toolConfirm(id, name, confirmed) {
  if (state.confirmInFlight || !state.conversationId) return;
  state.confirmInFlight = true;
  renderConfirmBar();
  api('/api/tool-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: state.conversationId,
      toolResponses: [{ id: id, name: name, confirmed: confirmed }]
    })
  }).then(function () {
    state.pendingTools = state.pendingTools.filter(function (p) { return p.id !== id; });
    toast(confirmed ? t('toolApproved') : t('toolRejected'));
  }).catch(function (err) {
    toast(t('toolConfirmFailed') + ': ' + (err.message || ''));
  }).finally(function () {
    state.confirmInFlight = false;
    renderConfirmBar();
  });
}
confirmBarEl.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!btn) return;
  var id = btn.getAttribute('data-id') || '';
  var name = '';
  var item = btn.closest('.tool-item');
  if (item && item.querySelector('.tname')) name = item.querySelector('.tname').textContent;
  var confirmed = btn.getAttribute('data-act') === 'approve';
  toolConfirm(id, name, confirmed);
});

/* ---------- SSE ---------- */
function connectStream() {
  if (state.evtSource) return;
  var es;
  try { es = new EventSource('/api/stream'); } catch (e) { retryConnect(); return; }
  state.evtSource = es;
  es.onopen = function () {
    state.serverStopped = false;
    state.connected = true;
    setStatus(state.streaming ? 'streaming' : 'connected', state.streaming ? t('statusStreaming') : t('statusConnected'));
  };
  es.addEventListener('hello', function (ev) {
    try {
      var info = JSON.parse(ev.data);
      state.statusInfo = info;
      applyWorkspaceInfo(info);
      if (info.activeConversationId && !state.conversationId) {
        var id = info.activeConversationId;
        state.conversationId = id;
        setTitle(info.activeConversationTitle || '');
        loadMessages(id, true);
        loadConversations();
      }
    } catch (e) {}
  });
  es.addEventListener('message', function (ev) { handleStreamMessage(ev.data); });
  es.addEventListener('global', function (ev) { handleStreamMessage(ev.data); });
  es.addEventListener('workspace', function (ev) {
    try {
      applyWorkspaceInfo(JSON.parse(ev.data));
    } catch (e) {}
  });
  es.addEventListener('bye', function () {
    state.serverStopped = true;
    es.close();
    state.evtSource = null;
    state.connected = false;
    state.streaming = false;
    setStatus('error', t('statusServerStopped'));
    sendBtn.disabled = true;
  });
  es.onerror = function () {
    // bye 事件与连接关闭的先后顺序不保证：收到 bye 后不再重连
    if (state.serverStopped) return;
    es.close();
    state.evtSource = null;
    state.connected = false;
    if (state.streaming) { setStreaming(false); }
    setStatus('connecting', t('statusReconnecting'));
    retryConnect();
  };
}
function retryConnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(connectStream, 2000);
}
function applyWorkspaceInfo(info) {
  if (!info) return;
  var changed = false;
  if (typeof info.workspaceUri === 'string' && info.workspaceUri !== state.workspaceUri) {
    state.workspaceUri = info.workspaceUri;
    changed = true;
  }
  if (typeof info.workspaceName === 'string' && info.workspaceName !== state.workspaceName) {
    state.workspaceName = info.workspaceName;
    changed = true;
  }
  if (typeof info.activeFilePath === 'string' || info.activeFilePath === null) {
    if (info.activeFilePath !== state.activeFilePath) {
      state.activeFilePath = info.activeFilePath;
      changed = true;
    }
  }
  if (changed) {
    setWorkspaceName(state.workspaceName);
    $('ws-bar-file').textContent = state.activeFilePath
      ? t('activeFile') + ': ' + state.activeFilePath
      : '';
    // 工作区变化：清空文件缓存与正在编辑的文件（防止把旧工作区的相对路径
    // 保存到新工作区），文件页回到根目录
    state.fileDirs = {};
    state.currentFile = null;
    if (isTab('files')) {
      fileViewerEl.hidden = true;
      fileTreeEl.hidden = false;
      loadFiles('', true);
    }
  }
}
function handleStreamMessage(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || !msg.type) return;
  var convId = msg.conversationId || (msg.data && msg.data.conversationId) || '';
  var d = msg.data || {};
  if (convId && state.conversationId && convId !== state.conversationId) {
    return;
  }
  switch (msg.type) {
    case 'streamChunk':
    case 'streamChunkBatch':
      processChunks(d);
      break;
    case 'response':
      break;
    case 'error':
      if (!state.streaming) {
        var errText = (d.error && (d.error.message || d.error)) || d.message || t('loadFailed');
        showErrorBanner(errText, state.conversationId ? true : false);
      }
      break;
  }
}
function processChunks(d) {
  var type = d.type;
  if (type === 'chunk' && typeof d.chunk === 'string') {
    if (!state.streaming) setStreaming(true, '');
    state.streamingText += d.chunk;
    renderStreamingText();
    return;
  }
  if (type === 'complete') {
    if (state.streaming) { state.streamingText = d.content || state.streamingText; setStreaming(false); }
    state.pendingTools = [];
    renderConfirmBar();
    loadMessages(state.conversationId, true);
    loadConversations();
    return;
  }
  if (type === 'cancelled') {
    if (state.streaming) { state.streamingText = d.content || state.streamingText; setStreaming(false); }
    state.pendingTools = [];
    renderConfirmBar();
    toast(t('streamInterrupted'));
    loadMessages(state.conversationId, true);
    return;
  }
  if (type === 'error') {
    if (state.streaming) setStreaming(false);
    var errMsg = (d.error && (d.error.message || d.error)) || t('loadFailed');
    showErrorBanner(errMsg);
    loadMessages(state.conversationId, true);
    return;
  }
  if (type === 'toolsExecuting' || type === 'toolIteration') {
    if (!state.streaming) setStreaming(true, '');
    state.pendingTools = [];
    renderConfirmBar();
    return;
  }
  if (type === 'awaitingConfirmation') {
    if (!state.streaming) setStreaming(true, '');
    state.pendingTools = Array.isArray(d.pendingToolCalls) ? d.pendingToolCalls : [];
    renderConfirmBar();
    return;
  }
}
function renderStreamingText() {
  if (!state.streaming) return;
  var holders = messagesEl.querySelectorAll('.msg.assistant');
  var last = holders[holders.length - 1];
  if (last && last.querySelector('.caret')) {
    var contentEl = last.querySelector('.msg-content');
    contentEl.innerHTML = (state.streamingText ? renderMarkdown(state.streamingText) : '') + '<span class="caret"></span>';
  } else {
    renderMessages();
    return;
  }
  scrollToBottom();
}

/* ---------- files ---------- */
function isTab(name) { return $('view-' + name).hidden === false; }
function switchTab(name) {
  ['chat', 'files', 'settings'].forEach(function (n) {
    $('view-' + n).hidden = (n !== name);
  });
  document.querySelectorAll('#tabbar button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  if (name === 'files') {
    $('ws-bar-name').textContent = state.workspaceName || t('noWorkspace');
    $('ws-bar-file').textContent = state.activeFilePath
      ? t('activeFile') + ': ' + state.activeFilePath
      : '';
    loadFiles('', true);
  } else if (name === 'settings') {
    loadConfigs();
    if (!state.settings) {
      loadSettings();
      loadToolsList();
      loadDeps();
    }
  }
}
function renderFileTree(path, entries) {
  var root = fileTreeEl;
  root.innerHTML = '';
  if (!state.workspaceUri && !state.workspaceName) {
    var hint = document.createElement('div');
    hint.className = 'conv-item';
    hint.style.color = 'var(--vscode-descriptionForeground)';
    hint.style.flexDirection = 'column';
    hint.style.alignItems = 'center';
    hint.style.gap = '6px';
    hint.style.padding = '30px 16px';
    hint.innerHTML = '<div style="font-size:26px;opacity:.5">📂</div><div style="text-align:center">' +
      esc(t('noWorkspace')) + '</div><div style="font-size:12px;text-align:center">' +
      esc(t('noWorkspaceHint')) + '</div>';
    root.appendChild(hint);
    return;
  }
  // 面包屑式导航：首行显示当前目录，点击回到根目录
  if (path !== '') {
    var up = document.createElement('button');
    up.className = 'fdir-row';
    up.innerHTML = '<svg class="fico" viewBox="0 0 24 24"><path d="M19 12H5m6-6l-6 6 6 6"/></svg>' +
      '<span class="fname">' + esc(t('back')) + ' · ' + esc(path) + '</span>';
    up.addEventListener('click', function () { state.fileDirs = {}; loadFiles('', true); });
    root.appendChild(up);
  } else {
    var home = document.createElement('button');
    home.className = 'fdir-row';
    home.innerHTML = '<svg class="fico" viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>' +
      '<span class="fname">' + esc(t('workspaceRoot')) + '</span>';
    root.appendChild(home);
  }
  (entries || []).forEach(function (entry) {
    var isDir = entry.type === 'directory';
    var row = document.createElement('button');
    row.className = 'fdir-row';
    row.innerHTML = isDir
      ? '<svg class="caret-svg" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6V6z"/></svg><svg class="fico" viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>'
      : '<svg class="fico" style="margin-left:12px" viewBox="0 0 24 24"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/></svg>';
    row.innerHTML += '<span class="fname">' + esc(entry.name) + '</span>' +
      (entry.size != null && !isDir ? '<span class="fsize">' + fmtSize(entry.size) + '</span>' : '');
    if (isDir) {
      row.addEventListener('click', function () {
        loadFiles(entry.path, true);
      });
    } else {
      row.addEventListener('click', function () { openFile(entry.path); });
    }
    root.appendChild(row);
  });
}
function loadFiles(path, quiet) {
  if (!quiet) fileTreeEl.innerHTML = '<div class="conv-item" style="color:var(--vscode-descriptionForeground)">' + esc(t('loading')) + '</div>';
  return api('/api/files?path=' + encodeURIComponent(path))
    .then(function (data) {
      state.fileDirs[path] = Array.isArray(data.entries) ? data.entries : [];
      renderFileTree(path, state.fileDirs[path]);
    })
    .catch(function (err) {
      fileTreeEl.innerHTML = '<div class="conv-item" style="color:var(--vscode-charts-red)">' + esc(t('loadFailed')) + ': ' + esc(err.message || '') + '</div>';
    });
}
function openFile(path) {
  api('/api/file?path=' + encodeURIComponent(path))
    .then(function (data) {
      state.currentFile = {
        path: data.path || path,
        content: data.content || '',
        truncated: data.truncated === true,
        dirty: false
      };
      showFileViewer();
    })
    .catch(function (err) {
      toast(t('fileReadFailed') + ': ' + (err.message || ''));
      showFileReadError(err.message || t('fileReadFailed'));
    });
}
function showFileReadError(msg) {
  state.currentFile = null;
  fileEditorEl.value = '';
  fileEditorEl.readOnly = true;
  fileViewerPathEl.textContent = msg;
  fileViewerInfoEl.textContent = '';
  saveFileBtnEl.disabled = true;
  fileTreeEl.hidden = true;
  fileViewerEl.hidden = false;
}
function showFileViewer() {
  var f = state.currentFile;
  if (!f) return;
  fileViewerPathEl.textContent = f.path;
  var tooLarge = f.truncated || f.content.length > MAX_EDIT_CHARS;
  fileEditorEl.readOnly = tooLarge;
  fileEditorEl.value = f.content;
  fileViewerInfoEl.textContent = (tooLarge ? t('fileTooLarge') : (t('file') + ' · ' + f.content.length + ' chars'));
  saveFileBtnEl.disabled = tooLarge;
  saveFileBtnEl.textContent = tooLarge ? t('preview') : t('save');
  fileTreeEl.hidden = true;
  fileViewerEl.hidden = false;
  saveFileBtnEl.style.background = '';
}
function saveFile() {
  var f = state.currentFile;
  if (!f || !f.dirty) return;
  saveFileBtnEl.disabled = true;
  api('/api/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: f.path, content: fileEditorEl.value })
  }).then(function () {
    f.content = fileEditorEl.value;
    f.dirty = false;
    toast(t('saved'));
    saveFileBtnEl.style.background = '';
    saveFileBtnEl.textContent = t('save');
  }).catch(function (err) {
    toast(t('saveFailed') + ': ' + (err.message || ''));
    saveFileBtnEl.disabled = false;
  });
}
function openOnDesktop() {
  var f = state.currentFile;
  if (!f) return;
  api('/api/open-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: f.path })
  }).then(function () {
    toast(t('openOnDesktop') + ' ✓');
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}
function loadWorkspaces() {
  return api('/api/workspaces').then(function (data) {
    var items = [];
    (Array.isArray(data.workspaces) ? data.workspaces : []).forEach(function (w) {
      items.push({ name: w.name || w.uri || '', uri: w.uri || '', saved: false, active: w.uri === state.workspaceUri });
    });
    (Array.isArray(data.saved) ? data.saved : []).forEach(function (w) {
      if (!items.some(function (i) { return i.uri === w.uri; })) {
        items.push({ name: w.name || w.fsPath || w.uri || '', uri: w.uri || '', saved: true, active: false });
      }
    });
    return items;
  });
}
function openWorkspaceSheet() {
  sheetEl.classList.add('open');
  sheetTitleEl.textContent = t('switchWorkspace');
  sheetListEl.innerHTML = '<div class="conv-item" style="color:var(--vscode-descriptionForeground)">' + esc(t('loading')) + '</div>';
  loadWorkspaces().then(function (items) {
    sheetListEl.innerHTML = '';
    if (items.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'conv-item';
      empty.style.color = 'var(--vscode-descriptionForeground)';
      empty.textContent = t('noWorkspace');
      sheetListEl.appendChild(empty);
      return;
    }
    items.forEach(function (w) {
      var row = document.createElement('div');
      row.className = 'conv-item' + (w.active ? ' active' : '');
      var it = document.createElement('button');
      it.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;gap:10px;background:transparent;border:none;text-align:left;cursor:pointer;padding:0;color:inherit;font:inherit;';
      it.innerHTML = '<div class="t"><div class="name">' + esc(w.name) + '</div>' +
        (w.saved ? '<div class="preview">' + esc(t('savedWorkspaces')) + '</div>' : '') + '</div>';
      it.addEventListener('click', function () {
        if (!w.active && w.uri) {
          api('/api/workspace-switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceUri: w.uri })
          }).then(function () {
            state.currentFile = null;
            state.fileDirs = {};
            toast(t('switchWorkspace') + ' ✓');
            if (isTab('files')) {
              fileViewerEl.hidden = true;
              fileTreeEl.hidden = false;
              loadFiles('', true);
            }
          }).catch(function (err) {
            toast(t('loadFailed') + ': ' + (err.message || ''));
          });
        }
        closeSheet();
      });
      row.appendChild(it);
      if (w.saved) {
        var del = document.createElement('button');
        del.className = 'conv-del';
        del.title = t('removeWorkspace');
        del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          api('/api/workspace-remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fsPath: w.fsPath || w.uri })
          }).then(function () {
            toast(t('workspaceRemoved'));
            openWorkspaceSheet();
          }).catch(function (err) {
            toast(t('loadFailed') + ': ' + (err.message || ''));
          });
        });
        row.appendChild(del);
      }
      sheetListEl.appendChild(row);
    });
  }).catch(function (err) {
    sheetListEl.innerHTML = '<div class="conv-item" style="color:var(--vscode-charts-red)">' + esc(err.message || '') + '</div>';
  });
}

/** 新增工作区：透传 workspace.openFolder，桌面端弹出文件夹选择框 */
function addWorkspace() {
  api('/api/workspace-add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then(function (data) {
    if (data && data.canceled) return;
    toast(t('openFolderDialog'));
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}

/* ---------- settings / models ---------- */
function loadConfigs() {
  $('configs-list').innerHTML = '<div class="info-text">' + esc(t('loading')) + '</div>';
  return api('/api/configs').then(function (data) {
    state.configs = Array.isArray(data.configs) ? data.configs : [];
    var listEl = $('configs-list');
    listEl.innerHTML = '';
    if (state.configs.length === 0) {
      var none = document.createElement('div');
      none.className = 'info-text';
      none.textContent = t('noConfigs');
      listEl.appendChild(none);
      return;
    }
    state.configs.forEach(function (cfg) {
      var item = document.createElement('div');
      item.className = 'cfg-item';
      item.innerHTML = '<div class="cname">' + esc(cfg.name || cfg.id || '') + '</div>' +
        '<div class="cmodel">' + esc(t('currentModel')) + ': ' + esc(cfg.model || '—') + '</div>' +
        '<div class="mchips"><span class="info-text" style="margin:2px 0">' + esc(t('loading')) + '</span></div>';
      var ctrl = document.createElement('div');
      ctrl.className = 'item-row';
      ctrl.style.borderTop = '1px solid var(--vscode-widget-border)';
      ctrl.style.marginTop = '6px';
      var tag = document.createElement('span');
      tag.className = 't';
      tag.style.fontSize = '12px';
      var isActive = state.statusInfo && state.statusInfo.activeChannelId === cfg.id;
      tag.textContent = isActive ? t('activeChannel') : '';
      tag.style.color = isActive ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-descriptionForeground)';
      ctrl.appendChild(tag);
      if (!isActive) {
        var act = document.createElement('button');
        act.className = 'mini-btn';
        act.textContent = t('setActiveChannel');
        act.addEventListener('click', function () { setChannelActive(cfg); });
        ctrl.appendChild(act);
      }
      ctrl.appendChild(itemToggle(cfg.enabled !== false, function (v) {
        cfg.enabled = v;
        toggleChannelEnabled(cfg);
      }));
      item.appendChild(ctrl);
      listEl.appendChild(item);
      loadConfigModels(cfg.id, item.querySelector('.mchips'));
    });
  }).catch(function (err) {
    $('configs-list').innerHTML = '<div class="info-text" style="color:var(--vscode-charts-red)">' + esc(err.message || '') + '</div>';
  });
}
function loadConfigModels(configId, chipsEl) {
  api('/api/config?configId=' + encodeURIComponent(configId))
    .then(function (data) {
      var cfg = data.config || {};
      var models = Array.isArray(cfg.models) ? cfg.models : [];
      state.configModels[configId] = models;
      chipsEl.innerHTML = '';
      if (models.length === 0) {
        chipsEl.innerHTML = '<span class="info-text">' + esc(t('noModels')) + '</span>';
        return;
      }
      models.forEach(function (m) {
        var chip = document.createElement('button');
        chip.className = 'mchip' + (m.id === cfg.model ? ' active' : '');
        chip.textContent = m.name || m.id || '';
        chip.disabled = (m.id === cfg.model);
        chip.addEventListener('click', function () {
          chipsEl.querySelectorAll('.mchip').forEach(function (c) { c.disabled = true; });
          api('/api/model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configId: configId, modelId: m.id })
          }).then(function () {
            loadConfigs();
            toast(t('model') + ': ' + (m.name || m.id) + ' ✓');
          }).catch(function (err) {
            chipsEl.querySelectorAll('.mchip').forEach(function (c) { c.disabled = false; });
            toast(t('setModelFailed') + ': ' + (err.message || ''));
          });
        });
        chipsEl.appendChild(chip);
      });
    })
    .catch(function () {
      chipsEl.innerHTML = '<span class="info-text">' + esc(t('loadFailed')) + '</span>';
    });
}
function renderSettings(s) {
  $('set-conn-title').textContent = t('connection');
  $('set-conn-label').textContent = t('connection');
  $('set-conn-val').textContent = s.running ? t('running') : t('stopped');
  $('set-conn-val').style.color = s.running ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-charts-red)';
  $('set-port-label').textContent = t('port');
  $('set-port-val').textContent = String(s.port || '');
  $('set-ver-label').textContent = t('appVersion');
  $('set-ver-val').textContent = s.appVersion || '—';
  $('set-urls-title').textContent = t('accessUrls');
  var urlsEl = $('urls-list');
  urlsEl.innerHTML = '';
  var urls = Array.isArray(s.urls) ? s.urls : [];
  if (!s.running || urls.length === 0) {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noUrls');
    urlsEl.appendChild(none);
  }
  urls.forEach(function (u) {
    var chip = document.createElement('div');
    chip.className = 'url-chip';
    chip.textContent = u;
    chip.addEventListener('click', function () {
      var done = function () { toast(t('copied')); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(u).then(done).catch(function () { fallbackCopy(u, done); });
      } else {
        fallbackCopy(u, done);
      }
    });
    urlsEl.appendChild(chip);
  });
  $('set-model-title').textContent = t('model') + ' / ' + t('config');
  $('set-sec-title').textContent = t('securityTitle');
  $('set-sec-text').textContent = t('securityText');
}
function fallbackCopy(text, done) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  done();
}

/* ============================================================
   设置页全量设置项（schema 驱动 + 定制节）
   ============================================================ */
function getVal(obj, p) {
  var cur = obj;
  for (var i = 0; i < p.length; i++) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p[i]];
  }
  return cur;
}
function setVal(obj, p, v) {
  var cur = obj;
  for (var i = 0; i < p.length - 1; i++) {
    if (cur[p[i]] == null || typeof cur[p[i]] !== 'object') cur[p[i]] = {};
    cur = cur[p[i]];
  }
  cur[p[p.length - 1]] = v;
}
function saveSettingsPatch(patch, extra) {
  state.settingsBusy = true;
  api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: patch })
  }).then(function (data) {
    state.settings = data.settings || state.settings;
    if (extra) extra(data.settings);
    // 重渲染使控件与后端钳制后的实际值一致（非法值被 SettingsManager 归一化时）
    renderAllSettingsSections();
    toast(t('settingsSaved'));
  }).catch(function (err) {
    renderAllSettingsSections();
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  }).then(function () {
    state.settingsBusy = false;
  });
}
function secCard(titleKey) {
  var card = document.createElement('div');
  card.className = 'card settings-sec';
  var h = document.createElement('h3');
  h.textContent = t(titleKey);
  card.appendChild(h);
  settingsSectionsEl.appendChild(card);
  return card;
}
function fieldRow(sec, f) {
  var row = document.createElement('div');
  row.className = 'set-field';
  var k = document.createElement('span');
  k.className = 'k';
  k.textContent = t(f.t);
  row.appendChild(k);
  var ctl = document.createElement('span');
  ctl.className = 'ctl';
  row.appendChild(ctl);
  sec.appendChild(row);
  return { row: row, ctl: ctl };
}
function renderField(sec, f) {
  var el = fieldRow(sec, f);
  var value = getVal(state.settings, f.p);
  if (f.w === 'toggle') {
    var wrap = document.createElement('label');
    wrap.className = 'tgl';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
    var tr = document.createElement('span');
    tr.className = 'tr';
    wrap.appendChild(input);
    wrap.appendChild(tr);
    el.ctl.appendChild(wrap);
    input.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, input.checked));
    });
  } else if (f.w === 'select' || f.w === 'promptMode') {
    var sel = document.createElement('select');
    var options = f.w === 'promptMode' ? promptModeOptions() : f.o;
    (options || []).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      sel.appendChild(opt);
    });
    sel.value = value != null ? String(value) : '';
    if (sel.value === '' && options && options.length) sel.value = options[0];
    el.ctl.appendChild(sel);
    sel.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, sel.value));
    });
  } else if (f.w === 'configSelect') {
    var sel2 = document.createElement('select');
    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '—';
    sel2.appendChild(noneOpt);
    (state.configs || []).forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || c.id;
      sel2.appendChild(opt);
    });
    sel2.value = value != null ? String(value) : '';
    el.ctl.appendChild(sel2);
    sel2.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, sel2.value || undefined));
    });
  } else if (f.w === 'number') {
    var num = document.createElement('input');
    num.type = 'number';
    num.min = String(f.min != null ? f.min : 0);
    num.max = String(f.max != null ? f.max : 1e9);
    if (f.step) num.step = String(f.step);
    num.value = value != null ? String(value) : '';
    num.placeholder = f.min === -1 ? t('unlimited') : '';
    el.ctl.appendChild(num);
    num.addEventListener('change', function () {
      var raw = num.value.trim();
      if (raw === '' && f.min === -1) raw = '-1';
      var v = Number(raw);
      if (raw === '' || !isFinite(v)) { num.value = value != null ? String(value) : ''; toast(t('settingsFailed')); return; }
      if (f.min != null && v < f.min) v = f.min;
      if (f.max != null && v > f.max) v = f.max;
      num.value = String(v);
      saveSettingsPatch(patchFor(f.p, v));
    });
  } else if (f.w === 'textarea') {
    var ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.placeholder = t('keepBlank');
    ta.value = value != null ? String(value) : '';
    el.ctl.appendChild(ta);
    ta.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, ta.value));
    });
  } else if (f.w === 'chips') {
    renderChips(el.ctl, f.p, Array.isArray(value) ? value : []);
  } else {
    var inp = document.createElement('input');
    if (f.w === 'password') {
      inp.type = 'password';
      inp.autocomplete = 'new-password';
      inp.placeholder = value ? t('apiKeySet') : '';
    } else {
      inp.type = 'text';
      inp.placeholder = f.w === 'password' ? t('keepBlank') : '';
    }
    inp.value = '';
    el.ctl.appendChild(inp);
    inp.addEventListener('change', function () {
      if (f.w === 'password') {
        if (!inp.value) { inp.value = ''; return; }
        saveSettingsPatch(patchFor(f.p, inp.value), function () { inp.value = ''; });
      } else {
        saveSettingsPatch(patchFor(f.p, inp.value));
      }
    });
  }
}
function patchFor(p, v) {
  var patch = {};
  setVal(patch, p, v);
  return patch;
}
function renderChips(ctl, p, values) {
  var wrap = document.createElement('div');
  wrap.className = 'chips';
  values.forEach(function (v, i) {
    var chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = v;
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = t('chipRemove');
    rm.addEventListener('click', function () {
      var next = values.slice();
      next.splice(i, 1);
      saveSettingsPatch(patchFor(p, next));
    });
    chip.appendChild(rm);
    wrap.appendChild(chip);
  });
  var addRow = document.createElement('div');
  addRow.className = 'chip-input';
  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('chipsHint');
  var btn = document.createElement('button');
  btn.className = 'mini-btn';
  btn.textContent = t('chipAdd');
  btn.type = 'button';
  function addChip() {
    var v = input.value.trim();
    if (!v) return;
    if (values.indexOf(v) >= 0) { input.value = ''; return; }
    saveSettingsPatch(patchFor(p, values.concat([v])));
  }
  btn.addEventListener('click', addChip);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addChip(); }
  });
  addRow.appendChild(input);
  addRow.appendChild(btn);
  wrap.appendChild(addRow);
  ctl.appendChild(wrap);
}
function promptModeOptions() {
  var modes = getVal(state.settings, ['toolsConfig', 'system_prompt', 'modes']);
  if (!Array.isArray(modes)) return [];
  return modes.map(function (m) { return m && m.id ? m.id : ''; }).filter(Boolean);
}
function itemToggle(checked, onChange) {
  var wrap = document.createElement('label');
  wrap.className = 'tgl';
  var input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  var tr = document.createElement('span');
  tr.className = 'tr';
  wrap.appendChild(input);
  wrap.appendChild(tr);
  input.addEventListener('change', function () { onChange(input.checked); });
  return wrap;
}
function renderSimpleSection(titleKey, fields) {
  var card = secCard(titleKey);
  fields.forEach(function (f) { renderField(card, f); });
}
function renderToolsSections() {
  var tools = state.tools;
  var card = secCard('secTools');
  if (!tools || tools.length === 0) {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noData');
    card.appendChild(none);
  } else {
    tools.forEach(function (tool) {
      var row = document.createElement('div');
      row.className = 'item-row';
      var td = document.createElement('div');
      td.className = 't';
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = tool.name;
      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = tool.description || '';
      td.appendChild(name);
      td.appendChild(sub);
      row.appendChild(td);
      row.appendChild(itemToggle(tool.enabled, function (v) {
        saveSettingsPatch(patchFor(['toolsEnabled', tool.name], v));
      }));
      card.appendChild(row);
    });
  }
  var autoCard = secCard('secAutoExec');
  if (!state.autoExec || Object.keys(state.autoExec).length === 0) {
    var none2 = document.createElement('div');
    none2.className = 'info-text';
    none2.textContent = t('noData');
    autoCard.appendChild(none2);
  } else {
    Object.keys(state.autoExec).forEach(function (name) {
      var row = document.createElement('div');
      row.className = 'item-row';
      var td = document.createElement('div');
      td.className = 't';
      var nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = name;
      td.appendChild(nameEl);
      row.appendChild(td);
      row.appendChild(itemToggle(state.autoExec[name] === true, function (v) {
        saveSettingsPatch(patchFor(['toolAutoExec', name], v));
      }));
      autoCard.appendChild(row);
    });
  }
}
function renderTokenSection() {
  var tc = getVal(state.settings, ['toolsConfig', 'token_count']);
  if (!tc || typeof tc !== 'object' || Object.keys(tc).length === 0) return;
  var card = secCard('secTokenCount');
  Object.keys(tc).forEach(function (ch) {
    var sub = document.createElement('div');
    sub.className = 'set-note';
    sub.textContent = ch;
    sub.style.marginTop = '6px';
    sub.style.fontWeight = '600';
    sub.style.color = 'var(--vscode-foreground)';
    card.appendChild(sub);
    renderField(card, { t: 'fldTokUrl', p: ['toolsConfig', 'token_count', ch, 'baseUrl'], w: 'text' });
    renderField(card, { t: 'fldTokModel', p: ['toolsConfig', 'token_count', ch, 'model'], w: 'text' });
    renderField(card, { t: 'fldTokKey', p: ['toolsConfig', 'token_count', ch, 'apiKey'], w: 'password' });
  });
}
function renderImageGenSection() {
  var ig = getVal(state.settings, ['toolsConfig', 'generate_image']);
  if (!ig || typeof ig !== 'object') return;
  var card = secCard('secImageGen');
  var fields = [
    { t: 'fldImgUrl', p: ['toolsConfig', 'generate_image', 'url'], w: 'text' },
    { t: 'fldImgModel', p: ['toolsConfig', 'generate_image', 'model'], w: 'text' },
    { t: 'fldImgKey', p: ['toolsConfig', 'generate_image', 'apiKey'], w: 'password' },
    { t: 'fldImgAspect', p: ['toolsConfig', 'generate_image', 'enableAspectRatio'], w: 'toggle' },
    { t: 'fldImgAspectDef', p: ['toolsConfig', 'generate_image', 'defaultAspectRatio'], w: 'select', o: ['1:1', '16:9', '9:16', '4:3', '3:4'] },
    { t: 'fldImgSize', p: ['toolsConfig', 'generate_image', 'enableImageSize'], w: 'toggle' },
    { t: 'fldImgSizeDef', p: ['toolsConfig', 'generate_image', 'defaultImageSize'], w: 'text' },
    { t: 'fldImgMaxBatch', p: ['toolsConfig', 'generate_image', 'maxBatchTasks'], w: 'number', min: 1 },
    { t: 'fldImgMaxPerTask', p: ['toolsConfig', 'generate_image', 'maxImagesPerTask'], w: 'number', min: 1 },
    { t: 'fldImgReturn', p: ['toolsConfig', 'generate_image', 'returnImageToAI'], w: 'toggle' }
  ];
  fields.forEach(function (f) { renderField(card, f); });
}
function renderSkillsSection() {
  var skills = getVal(state.settings, ['toolsConfig', 'skills', 'skills']);
  var card = secCard('secSkills');
  if (!Array.isArray(skills) || skills.length === 0) {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noData');
    card.appendChild(none);
    return;
  }
  skills.forEach(function (sk, i) {
    var row = document.createElement('div');
    row.className = 'item-row';
    var td = document.createElement('div');
    td.className = 't';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = sk.name || sk.id || '';
    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = sk.description || sk.id || '';
    td.appendChild(name);
    td.appendChild(sub);
    row.appendChild(td);
    row.appendChild(itemToggle(sk.enabled !== false, function (v) {
      var next = skills.slice();
      next[i] = Object.assign({}, sk, { enabled: v });
      saveSettingsPatch(patchFor(['toolsConfig', 'skills', 'skills'], next));
    }));
    var rm = document.createElement('button');
    rm.className = 'mini-btn danger';
    rm.textContent = '×';
    rm.title = t('chipRemove');
    rm.addEventListener('click', function () {
      var next = skills.slice();
      next.splice(i, 1);
      saveSettingsPatch(patchFor(['toolsConfig', 'skills', 'skills'], next));
    });
    row.appendChild(rm);
    card.appendChild(row);
  });
}
function renderSubagentsSection() {
  var sa = getVal(state.settings, ['toolsConfig', 'subagents']);
  var card = secCard('secSubagents');
  if (!sa || typeof sa !== 'object') {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noData');
    card.appendChild(none);
    return;
  }
  renderField(card, { t: 'fldSubMaxConcurrent', p: ['toolsConfig', 'subagents', 'maxConcurrentAgents'], w: 'number', min: 1 });
  renderField(card, { t: 'fldSubFailureMode', p: ['toolsConfig', 'subagents', 'failureModeAfterRetries'], w: 'select', o: ['fail_parent_tool', 'wait_for_monitor_action'] });
  renderField(card, { t: 'fldSubGeneralWorker', p: ['toolsConfig', 'subagents', 'generalWorkerEnabled'], w: 'toggle' });
  renderField(card, { t: 'fldSubDefaultIterations', p: ['toolsConfig', 'subagents', 'defaultMaxIterations'], w: 'number', min: 1 });
  renderField(card, { t: 'fldSubDefaultRuntime', p: ['toolsConfig', 'subagents', 'defaultMaxRuntime'], w: 'number', min: 1 });
  var agents = Array.isArray(sa.agents) ? sa.agents : [];
  agents.forEach(function (ag, i) {
    var row = document.createElement('div');
    row.className = 'item-row';
    var td = document.createElement('div');
    td.className = 't';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = ag.name || ag.type || '';
    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = (ag.channel && ag.channel.channelId ? ag.channel.channelId + (ag.channel.modelId ? ' / ' + ag.channel.modelId : '') : '') + (ag.enabled === false ? ' · ' + t('off') : '');
    td.appendChild(name);
    td.appendChild(sub);
    row.appendChild(td);
    row.appendChild(itemToggle(ag.enabled !== false, function (v) {
      var next = agents.slice();
      next[i] = Object.assign({}, ag, { enabled: v });
      saveSettingsPatch(patchFor(['toolsConfig', 'subagents', 'agents'], next));
    }));
    card.appendChild(row);
  });
}
function renderPinnedSection() {
  var pf = getVal(state.settings, ['toolsConfig', 'pinned_files']);
  var files = pf && Array.isArray(pf.files) ? pf.files : [];
  var card = secCard('secPinned');
  if (files.length === 0) {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noData');
    card.appendChild(none);
  } else {
    files.forEach(function (f, i) {
      var row = document.createElement('div');
      row.className = 'item-row';
      var td = document.createElement('div');
      td.className = 't';
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = f.path || '';
      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = f.workspaceUri || '';
      td.appendChild(name);
      td.appendChild(sub);
      row.appendChild(td);
      row.appendChild(itemToggle(f.enabled !== false, function (v) {
        var next = files.slice();
        next[i] = Object.assign({}, f, { enabled: v });
        saveSettingsPatch(patchFor(['toolsConfig', 'pinned_files', 'files'], next));
      }));
      var rm = document.createElement('button');
      rm.className = 'mini-btn danger';
      rm.textContent = '×';
      rm.title = t('chipRemove');
      rm.addEventListener('click', function () {
        var next = files.slice();
        next.splice(i, 1);
        saveSettingsPatch(patchFor(['toolsConfig', 'pinned_files', 'files'], next));
      });
      row.appendChild(rm);
      card.appendChild(row);
    });
  }
  var addRow = document.createElement('div');
  addRow.className = 'set-field';
  var k = document.createElement('span');
  k.className = 'k';
  k.textContent = t('fldPinnedAdd');
  addRow.appendChild(k);
  var ctl = document.createElement('span');
  ctl.className = 'ctl';
  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('fldPinnedPath');
  var btn = document.createElement('button');
  btn.className = 'mini-btn';
  btn.textContent = t('chipAdd');
  btn.type = 'button';
  function addPinned() {
    var p = input.value.trim();
    if (!p || !state.workspaceUri) { toast(t('settingsFailed')); return; }
    var next = files.concat([{ id: 'pf_' + Date.now(), path: p, workspaceUri: state.workspaceUri, enabled: true, addedAt: Date.now() }]);
    saveSettingsPatch(patchFor(['toolsConfig', 'pinned_files', 'files'], next), function () { input.value = ''; });
  }
  btn.addEventListener('click', addPinned);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addPinned(); }
  });
  ctl.appendChild(input);
  ctl.appendChild(btn);
  addRow.appendChild(ctl);
  card.appendChild(addRow);
}
function renderRemoteSection() {
  var rc = getVal(state.settings, ['remoteControl']);
  var card = secCard('secRemote');
  if (!rc || typeof rc !== 'object') return;
  renderField(card, { t: 'fldRcEnabled', p: ['remoteControl', 'enabled'], w: 'toggle' });
  renderField(card, { t: 'fldRcPort', p: ['remoteControl', 'port'], w: 'number', min: 1, max: 65535 });
  var warn = document.createElement('div');
  warn.className = 'set-note';
  warn.textContent = t('fldRcDisconnectWarn');
  card.appendChild(warn);
  var btns = document.createElement('div');
  btns.className = 'set-field';
  var restart = document.createElement('button');
  restart.className = 'mini-btn';
  restart.textContent = t('fldRcRestart');
  restart.addEventListener('click', function () {
    api('/api/remote-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'restart' })
    }).then(function () { toast(t('settingsSaved')); }).catch(function (err) { toast(t('settingsFailed') + ': ' + (err.message || '')); });
  });
  var stop = document.createElement('button');
  stop.className = 'mini-btn danger';
  stop.textContent = t('fldRcStop');
  stop.addEventListener('click', function () {
    openModal(t('fldRcStop'), null, t('renameSave'), t('renameCancel'), 'danger', function () {
      api('/api/remote-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'stop' })
      }).then(function () { toast(t('settingsSaved')); }).catch(function (err) { toast(t('settingsFailed') + ': ' + (err.message || '')); });
    });
  });
  btns.appendChild(restart);
  btns.appendChild(stop);
  card.appendChild(btns);
}
function renderStorageSection() {
  var sp = getVal(state.settings, ['storagePath']);
  var card = secCard('secStorage');
  if (!sp || typeof sp !== 'object') {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noData');
    card.appendChild(none);
    return;
  }
  var rows = [
    { t: 'fldStoragePath', v: sp.customDataPath || '—' },
    { t: 'fldMigration', v: sp.migrationStatus || '—' }
  ];
  rows.forEach(function (r) {
    var row = document.createElement('div');
    row.className = 'set-row';
    var k = document.createElement('span');
    k.className = 'k';
    k.textContent = t(r.t);
    var v = document.createElement('span');
    v.className = 'v';
    v.textContent = r.v;
    row.appendChild(k);
    row.appendChild(v);
    card.appendChild(row);
  });
}
function renderDepsSection() {
  var card = secCard('secDeps');
  if (state.deps.length === 0) {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('loading');
    card.appendChild(none);
  } else {
    state.deps.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'set-row';
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = d.name || '';
      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = d.installed
        ? (d.installedVersion || t('depInstalled'))
        : t('depMissing');
      v.style.color = d.installed ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-charts-red)';
      row.appendChild(k);
      row.appendChild(v);
      card.appendChild(row);
    });
  }
}
function renderAllSettingsSections() {
  settingsSectionsEl.innerHTML = '';
  if (!state.settings) {
    var p = document.createElement('div');
    p.className = 'info-text';
    p.textContent = t('loading');
    settingsSectionsEl.appendChild(p);
    return;
  }
  var secs = [
    { key: 'secGeneral', f: [
      { t: 'fldCheckUpdates', p: ['checkForUpdates'], w: 'toggle' },
      { t: 'fldMaxToolIterations', p: ['maxToolIterations'], w: 'number', min: -1 },
      { t: 'fldDefaultToolMode', p: ['defaultToolMode'], w: 'select', o: ['function_call', 'xml', 'json'] }
    ]},
    { key: 'secUI', f: [
      { t: 'fldLanguage', p: ['ui', 'language'], w: 'select', o: ['auto', 'zh-CN', 'en', 'ja'] },
      { t: 'fldTheme', p: ['ui', 'theme'], w: 'select', o: ['auto', 'light', 'dark'] },
      { t: 'fldWorkspaceBehavior', p: ['ui', 'workspaceBehavior'], w: 'select', o: ['restore', 'none'] },
      { t: 'fldLoadingText', p: ['ui', 'appearance', 'loadingText'], w: 'text' },
      { t: 'fldSmoothStreaming', p: ['ui', 'appearance', 'smoothStreaming'], w: 'select', o: ['off', 'smooth', 'balanced', 'silky'] },
      { t: 'fldSoundEnabled', p: ['ui', 'sound', 'enabled'], w: 'toggle' },
      { t: 'fldSoundVolume', p: ['ui', 'sound', 'volume'], w: 'number', min: 0, max: 100 },
      { t: 'fldSoundTheme', p: ['ui', 'sound', 'theme'], w: 'select', o: ['beep', 'soft'] }
    ]},
    { key: 'secProxy', f: [
      { t: 'fldProxyEnabled', p: ['proxy', 'enabled'], w: 'toggle' },
      { t: 'fldProxyUrl', p: ['proxy', 'url'], w: 'text' },
      { t: 'fldProxyInsecure', p: ['proxy', 'insecureSkipVerify'], w: 'toggle' }
    ]},
    { key: 'secFileTools', f: [
      { t: 'fldReadOutside', p: ['toolsConfig', 'read_file', 'outsideWorkspaceAccess'], w: 'select', o: ['deny', 'ask', 'allow'] },
      { t: 'fldWriteOutside', p: ['toolsConfig', 'write_file', 'outsideWorkspaceAccess'], w: 'select', o: ['deny', 'ask'] },
      { t: 'fldListIgnore', p: ['toolsConfig', 'list_files', 'ignorePatterns'], w: 'chips' },
      { t: 'fldFindExclude', p: ['toolsConfig', 'find_files', 'excludePatterns'], w: 'chips' },
      { t: 'fldApplyFormat', p: ['toolsConfig', 'apply_diff', 'format'], w: 'select', o: ['unified', 'search_replace'] },
      { t: 'fldApplyAutoSave', p: ['toolsConfig', 'apply_diff', 'autoSave'], w: 'toggle' },
      { t: 'fldApplyAutoSaveDelay', p: ['toolsConfig', 'apply_diff', 'autoSaveDelay'], w: 'number', min: 0 },
      { t: 'fldApplyGuard', p: ['toolsConfig', 'apply_diff', 'diffGuardEnabled'], w: 'toggle' },
      { t: 'fldApplyAutoApply', p: ['toolsConfig', 'apply_diff', 'autoApplyWithoutDiffView'], w: 'toggle' },
      { t: 'fldSearchExclude', p: ['toolsConfig', 'search_in_files', 'excludePatterns'], w: 'chips' },
      { t: 'fldSearchMaxFind', p: ['toolsConfig', 'search_in_files', 'maxFindFiles'], w: 'number', min: 1 },
      { t: 'fldSearchCtxBefore', p: ['toolsConfig', 'search_in_files', 'contextLinesBefore'], w: 'number', min: 0 },
      { t: 'fldSearchCtxAfter', p: ['toolsConfig', 'search_in_files', 'contextLinesAfter'], w: 'number', min: 0 },
      { t: 'fldHistoryScope', p: ['toolsConfig', 'history_search', 'searchScope'], w: 'select', o: ['all', 'summarized'] },
      { t: 'fldHistoryMax', p: ['toolsConfig', 'history_search', 'maxSearchMatches'], w: 'number', min: 1 }
    ]},
    { key: 'secCommand', f: [
      { t: 'fldCmdTimeout', p: ['toolsConfig', 'execute_command', 'defaultTimeout'], w: 'number', min: 1 },
      { t: 'fldCmdMaxOutput', p: ['toolsConfig', 'execute_command', 'maxOutputLines'], w: 'number', min: 1 },
      { t: 'fldSandboxEnabled', p: ['toolsConfig', 'sandbox', 'enabled'], w: 'toggle' },
      { t: 'fldSandboxTimeout', p: ['toolsConfig', 'sandbox', 'defaultTimeout'], w: 'number', min: 1 }
    ]},
    { key: 'secPrompt', f: [
      { t: 'fldPromptMode', p: ['toolsConfig', 'system_prompt', 'currentModeId'], w: 'promptMode' },
      { t: 'fldPromptPrefix', p: ['toolsConfig', 'system_prompt', 'customPrefix'], w: 'textarea' },
      { t: 'fldPromptSuffix', p: ['toolsConfig', 'system_prompt', 'customSuffix'], w: 'textarea' },
      { t: 'fldPromptDynamicEnabled', p: ['toolsConfig', 'system_prompt', 'dynamicTemplateEnabled'], w: 'toggle' },
      { t: 'fldPromptDynamic', p: ['toolsConfig', 'system_prompt', 'dynamicTemplate'], w: 'textarea' }
    ]},
    { key: 'secContext', f: [
      { t: 'fldCtxFiles', p: ['toolsConfig', 'context_awareness', 'includeWorkspaceFiles'], w: 'toggle' },
      { t: 'fldCtxDepth', p: ['toolsConfig', 'context_awareness', 'maxFileDepth'], w: 'number', min: -1 },
      { t: 'fldCtxTabs', p: ['toolsConfig', 'context_awareness', 'includeOpenTabs'], w: 'toggle' },
      { t: 'fldCtxMaxTabs', p: ['toolsConfig', 'context_awareness', 'maxOpenTabs'], w: 'number', min: 0 },
      { t: 'fldCtxEditor', p: ['toolsConfig', 'context_awareness', 'includeActiveEditor'], w: 'toggle' },
      { t: 'fldCtxIgnore', p: ['toolsConfig', 'context_awareness', 'ignorePatterns'], w: 'chips' },
      { t: 'fldCtxDiag', p: ['toolsConfig', 'context_awareness', 'diagnostics', 'enabled'], w: 'toggle' }
    ]},
    { key: 'secMemory', f: [
      { t: 'fldMemEnabled', p: ['toolsConfig', 'memory', 'enabled'], w: 'toggle' },
      { t: 'fldMemWake', p: ['toolsConfig', 'memory', 'wakeLines'], w: 'number', min: 0 },
      { t: 'fldMemChars', p: ['toolsConfig', 'memory', 'entryChars'], w: 'number', min: 1 }
    ]},
    { key: 'secSummarize', f: [
      { t: 'fldSumRounds', p: ['toolsConfig', 'summarize', 'keepRecentRounds'], w: 'number', min: 0 },
      { t: 'fldSumTokens', p: ['toolsConfig', 'summarize', 'keepRecentTokens'], w: 'text' },
      { t: 'fldSumSeparate', p: ['toolsConfig', 'summarize', 'useSeparateModel'], w: 'toggle' },
      { t: 'fldSumChannel', p: ['toolsConfig', 'summarize', 'summarizeChannelId'], w: 'configSelect' },
      { t: 'fldSumModel', p: ['toolsConfig', 'summarize', 'summarizeModelId'], w: 'text' },
      { t: 'fldSumAttempts', p: ['toolsConfig', 'summarize', 'maxAutoSummarizeAttemptsPerTurn'], w: 'number', min: 1, max: 5 },
      { t: 'fldSumRatio', p: ['toolsConfig', 'summarize', 'summarizeMaxInputRatio'], w: 'number', min: 0.05, max: 0.95, step: 0.05 }
    ]},
    { key: 'secCheckpoint', f: [
      { t: 'fldCkptEnabled', p: ['toolsConfig', 'checkpoint', 'enabled'], w: 'toggle' },
      { t: 'fldCkptMax', p: ['toolsConfig', 'checkpoint', 'maxCheckpoints'], w: 'number', min: -1 }
    ]}
  ];
  secs.forEach(function (sec) { renderSimpleSection(sec.key, sec.f); });
  renderToolsSections();
  renderTokenSection();
  renderImageGenSection();
  renderSkillsSection();
  renderSubagentsSection();
  renderPinnedSection();
  renderRemoteSection();
  renderStorageSection();
  renderDepsSection();
}
function loadSettings() {
  api('/api/settings').then(function (data) {
    state.settings = data.settings || null;
    renderAllSettingsSections();
  }).catch(function (err) {
    settingsSectionsEl.innerHTML = '<div class="info-text" style="color:var(--vscode-charts-red)">' + esc(t('loadFailed')) + ': ' + esc(err.message || '') + '</div>';
  });
}
function loadToolsList() {
  api('/api/tools').then(function (data) {
    state.tools = Array.isArray(data.tools) ? data.tools : [];
    state.autoExec = (data.autoExec && typeof data.autoExec === 'object') ? data.autoExec : {};
    renderAllSettingsSections();
  }).catch(function () { /* 工具清单失败不阻断设置页 */ });
}
function loadDeps() {
  api('/api/dependencies').then(function (data) {
    var deps = data.dependencies;
    state.deps = Array.isArray(deps) ? deps : (deps && Array.isArray(deps.dependencies) ? deps.dependencies : []);
    renderAllSettingsSections();
  }).catch(function () { /* 依赖展示失败静默 */ });
}
function toggleChannelEnabled(cfg) {
  api('/api/channel-toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configId: cfg.id, enabled: !cfg.enabled })
  }).then(function () {
    toast(t('settingsSaved'));
    loadConfigs();
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
    loadConfigs(); // 失败回滚开关状态
  });
}
function setChannelActive(cfg) {
  api('/api/channel-active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configId: cfg.id })
  }).then(function () {
    toast(t('setActiveChannel') + ' ✓');
    state.statusInfo = state.statusInfo || {};
    state.statusInfo.activeChannelId = cfg.id;
    loadConfigs();
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}

/* ============================================================
   目录浏览（移动端自选工作区文件夹，免桌面端弹窗）
   ============================================================ */
function openBrowse() {
  $('sheet-list-mode').hidden = true;
  $('sheet-browse-mode').hidden = false;
  sheetEl.classList.add('open');
  browsePickBtn.textContent = t('chooseThisFolder');
  loadFsDir('');
}
function closeBrowseMode() {
  $('sheet-list-mode').hidden = false;
  $('sheet-browse-mode').hidden = true;
}
function loadFsDir(dir) {
  state.browseBusy = true;
  browsePickBtn.disabled = true;
  browseListEl.innerHTML = '<div class="conv-item" style="color:var(--vscode-descriptionForeground)">' + esc(t('loading')) + '</div>';
  api('/api/fs?path=' + encodeURIComponent(dir)).then(function (data) {
    state.browsePath = data.path || '';
    state.browseParent = data.parent || null;
    state.browseDrives = Array.isArray(data.drives) ? data.drives : [];
    renderBrowse(Array.isArray(data.entries) ? data.entries : []);
  }).catch(function (err) {
    browseListEl.innerHTML = '<div class="conv-item" style="color:var(--vscode-charts-red)">' + esc(err.message || '') + '</div>';
  }).then(function () {
    state.browseBusy = false;
    browsePickBtn.disabled = !state.browsePath || state.browseBusy;
  });
}
function renderBrowse(entries) {
  browsePathEl.textContent = state.browsePath || t('browseDrivesLabel');
  browseListEl.innerHTML = '';
  if (!state.browsePath) {
    state.browseDrives.forEach(function (d) {
      var item = document.createElement('div');
      item.className = 'dir-item';
      item.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>' +
        '<span class="n">' + esc(d) + '</span>';
      item.addEventListener('click', function () { loadFsDir(d); });
      browseListEl.appendChild(item);
    });
    return;
  }
  if (state.browseParent) {
    var up = document.createElement('div');
    up.className = 'dir-item';
    up.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 4l-8 8 8 8V4z"/></svg>' +
      '<span class="n">' + esc(t('browseUp')) + '</span>';
    up.addEventListener('click', function () { loadFsDir(state.browseParent); });
    browseListEl.appendChild(up);
  }
  if (entries.length === 0) {
    var none = document.createElement('div');
    none.className = 'conv-item';
    none.style.color = 'var(--vscode-descriptionForeground)';
    none.textContent = t('noData');
    browseListEl.appendChild(none);
  }
  entries.forEach(function (e) {
    var item = document.createElement('div');
    item.className = 'dir-item';
    item.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>' +
      '<span class="n">' + esc(e.name || e.path || '') + '</span>';
    item.addEventListener('click', function () { loadFsDir(e.path); });
    browseListEl.appendChild(item);
  });
  var pickHint = document.createElement('div');
  pickHint.className = 'set-note';
  pickHint.style.cursor = 'pointer';
  pickHint.style.textAlign = 'center';
  pickHint.textContent = t('pickOnDesktop');
  pickHint.addEventListener('click', function () { closeBrowseMode(); addWorkspace(); });
  browseListEl.appendChild(pickHint);
}
function pickBrowseFolder() {
  if (!state.browsePath || state.browseBusy) return;
  api('/api/workspace-add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fsPath: state.browsePath })
  }).then(function (data) {
    if (data && data.canceled) return;
    toast(t('workspaceOpened'));
    closeSheet();
    state.currentFile = null;
    state.fileDirs = {};
    if (isTab('files')) {
      fileViewerEl.hidden = true;
      fileTreeEl.hidden = false;
      loadFiles('', true);
    }
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}

/* ---------- wiring ---------- */
sendBtn.addEventListener('click', function () {
  if (state.streaming) { doStop(); } else { doSend(); }
});
inputEl.addEventListener('input', function () {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  updateSendBtn();
});
inputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    doSend();
  }
});
$('btn-drawer').addEventListener('click', openDrawer);
$('btn-refresh').addEventListener('click', function () {
  if (isTab('chat')) {
    loadMessages(state.conversationId);
    loadConversations();
    toast(t('refresh') + ' ✓');
    return;
  }
  if (isTab('settings')) {
    loadConfigs();
    loadSettings();
    loadToolsList();
    loadDeps();
    toast(t('refresh') + ' ✓');
    return;
  }
  if (isTab('files')) {
    state.fileDirs = {};
    loadFiles('', true);
    toast(t('refresh') + ' ✓');
  }
});
$('btn-new').addEventListener('click', function () {
  closeDrawer();
  state.conversationId = null;
  state.messages = [];
  state.streaming = false;
  state.streamingText = '';
  state.pendingTools = [];
  renderConfirmBar();
  renderSendIcon();
  setTitle('');
  renderMessages();
  inputEl.focus();
  toast(t('newChat') + ' — ' + t('emptyConversation'));
});
$('drawer-backdrop').addEventListener('click', closeDrawer);
sheetEl.querySelector('.backdrop').addEventListener('click', closeSheet);
$('act-backdrop').addEventListener('click', closeActionSheet);
$('btn-ws-switch').textContent = t('switchWorkspace');
$('btn-ws-switch').addEventListener('click', openWorkspaceSheet);
$('btn-ws-add').addEventListener('click', openBrowse);
$('btn-sheet-add').addEventListener('click', addWorkspace);
$('btn-sheet-browse').addEventListener('click', openBrowse);
$('btn-browse-back').addEventListener('click', function () {
  loadFsDir(state.browseParent || '');
});
$('btn-browse-root').addEventListener('click', function () { loadFsDir(''); });
$('btn-browse-pick').addEventListener('click', pickBrowseFolder);
$('btn-file-back').addEventListener('click', function () {
  if (state.currentFile && state.currentFile.dirty) {
    openModal(t('deleteMessage'), null, t('renameSave'), t('renameCancel'), 'danger', null);
    modalTitleEl.textContent = t('save');
    modalOkEl.textContent = t('save');
    modalOkEl.onclick = function () {
      closeModal();
      saveFile();
    };
    return;
  }
  state.currentFile = null;
  fileViewerEl.hidden = true;
  fileTreeEl.hidden = false;
});
$('btn-open-desktop').addEventListener('click', openOnDesktop);
fileEditorEl.addEventListener('input', function () {
  if (!state.currentFile) return;
  state.currentFile.dirty = true;
  saveFileBtnEl.disabled = false;
  saveFileBtnEl.textContent = t('save');
  saveFileBtnEl.style.background = 'var(--vscode-charts-yellow)';
});
saveFileBtnEl.addEventListener('click', saveFile);
document.querySelectorAll('#tabbar button').forEach(function (b) {
  b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
});
modalCancelEl.addEventListener('click', closeModal);
modalOkEl.addEventListener('click', function () {
  var onOk = modalEl._onOk;
  closeModal();
  if (onOk) {
    onOk(modalInputEl.hidden ? null : modalInputEl.value);
  }
});
modalInputEl.addEventListener('input', autoResizeModalInput);
modalInputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); modalOkEl.click(); }
  if (e.key === 'Escape') closeModal();
});

/* ---------- boot ---------- */
setStatus('connecting', t('statusConnecting'));
$('btn-ws-switch').textContent = t('switchWorkspace');
saveFileBtnEl.textContent = t('save');
renderSendIcon();
api('/api/status').then(function (s) {
  state.appVersion = s.appVersion || '';
  state.statusInfo = s;
  if (s.lang) state.lang = s.lang;
  state.lastActiveConversation = s.activeConversationId || null;
  applyWorkspaceInfo(s);
  renderSettings(s);
  if (!state.conversationId && s.activeConversationId) {
    state.conversationId = s.activeConversationId;
  }
  if (state.conversationId) {
    loadMessages(state.conversationId, true);
    loadConversations();
  } else {
    renderMessages();
    $('empty-text').textContent = t('emptyConversation');
    emptyEl.hidden = false;
    messagesEl.hidden = true;
  }
  connectStream();
}).catch(function () {
  setStatus('error', t('statusServerStopped'));
  sendBtn.disabled = true;
  $('empty-text').textContent = t('statusServerStopped');
  emptyEl.hidden = false;
  messagesEl.hidden = true;
});
updateSendBtn();
</script>
</body>
</html>`;
}
