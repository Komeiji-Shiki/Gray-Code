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
 * 页面结构（底部三页签）：
 * - 会话：查看/切换/新建/重命名会话、发送/停止/重试、删除消息（长按）、
 *   流式输出（SSE）、工具确认（批准/拒绝）、思考/工具调用展示；
 * - 文件：工作区文件树浏览、文本文件查看与编辑（保存回真实工作区）、
 *   在桌面端打开文件（带行号跳转）、切换工作区；
 * - 设置：连接状态、局域网访问地址、渠道与模型切换、安全说明。
 *
 * 页面通过以下 API 与主进程通信（同一 origin，无 CORS）：
 *   GET  /api/status           运行状态 / 激活会话 / 工作区 / 语言
 *   GET  /api/conversations    会话列表
 *   GET  /api/messages         会话消息（role/parts 结构）
 *   GET  /api/workspace        当前工作区状态
 *   GET  /api/workspaces       工作区列表（当前打开 + 收藏）
 *   POST /api/workspace-switch 切换工作区
 *   GET  /api/files            工作区目录列表
 *   GET  /api/file             读取工作区文本文件
 *   POST /api/file             写入工作区文本文件（影响真实工作区）
 *   POST /api/open-file        在桌面端打开文件（可带行号）
 *   GET  /api/configs          渠道配置列表
 *   GET  /api/config           渠道详情（模型列表）
 *   POST /api/model            切换激活模型
 *   POST /api/send             发送消息（chatStream）
 *   POST /api/cancel           停止生成
 *   POST /api/retry            重试（retryStream）
 *   POST /api/delete-message   删除消息
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
    streamLoading: '正在加载历史消息…'
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
    streamLoading: 'Loading history…'
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
    streamLoading: '履歴を読み込み中…'
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
<style>
:root {
  --bg: #1e1e1e;
  --bg-panel: #252526;
  --bg-elevated: #2d2d2f;
  --border: #3c3c3c;
  --text: #d4d4d4;
  --text-dim: #9d9d9d;
  --text-faint: #6b6b6b;
  --accent: #4da3ff;
  --accent-dim: #1f4e79;
  --user-bubble: #2b4a68;
  --assistant-bubble: #2d2d2f;
  --danger: #f14c4c;
  --ok: #4ec9b0;
  --warn: #d7ba7d;
  --code-bg: #1b1b1c;
  --radius: 10px;
  --header-h: 52px;
  --tabbar-h: 54px;
  --footer-safe: env(safe-area-inset-bottom, 0px);
}
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  display: flex;
  flex-direction: column;
  overscroll-behavior: none;
}
#app { display: flex; flex-direction: column; height: 100dvh; }

header {
  height: var(--header-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
header .title-wrap { flex: 1; min-width: 0; }
header h1 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
header .sub {
  font-size: 11px;
  color: var(--text-faint);
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
}
header .sub .ws {
  max-width: 45vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}
header .sub .ws::before { content: "·"; margin-right: 6px; color: var(--text-faint); }
.dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.dot.connected { background: var(--ok); }
.dot.streaming { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
.dot.connecting { background: var(--warn); }
.dot.error { background: var(--danger); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

.icon-btn {
  flex: none;
  width: 38px; height: 38px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 8px;
  background: transparent; color: var(--text-dim);
  font-size: 18px;
  cursor: pointer;
}
.icon-btn:active { background: var(--bg-elevated); color: var(--text); }
.icon-btn svg { width: 20px; height: 20px; fill: currentColor; }

#views { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.view[hidden] { display: none; }

/* ---------- chat ---------- */
#messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
#messages::-webkit-scrollbar { width: 4px; }
#messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.msg { display: flex; flex-direction: column; max-width: 92%; }
.msg.user { align-self: flex-end; align-items: flex-end; }
.msg.assistant, .msg.system { align-self: flex-start; align-items: flex-start; }
.msg.system { align-self: center; max-width: 96%; }

.msg .meta {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0 4px 4px;
  display: flex;
  gap: 6px;
  align-items: center;
  max-width: 100%;
}
.msg .meta .model { color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.bubble {
  border-radius: var(--radius);
  padding: 9px 12px;
  word-break: break-word;
  overflow-wrap: anywhere;
  min-width: 40px;
  max-width: 100%;
}
.msg.user .bubble { background: var(--user-bubble); border-bottom-right-radius: 3px; }
.msg.assistant .bubble { background: var(--assistant-bubble); border: 1px solid var(--border); border-bottom-left-radius: 3px; }
.msg.system .bubble { background: var(--bg-panel); border: 1px dashed var(--border); color: var(--text-dim); font-size: 12.5px; }
.msg.error .bubble { border-color: var(--danger); color: var(--danger); }

.bubble .md h1, .bubble .md h2, .bubble .md h3, .bubble .md h4 { margin: 10px 0 6px; line-height: 1.35; }
.bubble .md h1 { font-size: 1.25em; }
.bubble .md h2 { font-size: 1.15em; }
.bubble .md h3 { font-size: 1.08em; }
.bubble .md h4 { font-size: 1em; }
.bubble .md p { margin: 6px 0; }
.bubble .md p:first-child { margin-top: 0; }
.bubble .md p:last-child { margin-bottom: 0; }
.bubble .md ul, .bubble .md ol { margin: 6px 0; padding-left: 20px; }
.bubble .md li { margin: 3px 0; }
.bubble .md code {
  font: 12.5px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
.bubble .md pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  overflow-x: auto;
}
.bubble .md pre code { background: none; padding: 0; display: block; white-space: pre; }
.bubble .md blockquote {
  border-left: 3px solid var(--accent-dim);
  padding: 2px 10px;
  margin: 8px 0;
  color: var(--text-dim);
}
.bubble .md a { color: var(--accent); text-decoration: none; }
.bubble .md hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
.bubble .md table { border-collapse: collapse; margin: 8px 0; font-size: 13px; max-width: 100%; }
.bubble .md th, .bubble .md td { border: 1px solid var(--border); padding: 4px 8px; }
.bubble .md .table-wrap { overflow-x: auto; }

.caret {
  display: inline-block;
  width: 7px; height: 15px;
  background: var(--accent);
  vertical-align: text-bottom;
  margin-left: 2px;
  animation: blink 0.9s steps(1) infinite;
}
@keyframes blink { 50% { opacity: 0; } }

.thoughts {
  margin: 2px 4px 6px;
  font-size: 11.5px;
  color: var(--text-faint);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 4px 10px;
  max-width: 100%;
}
.thoughts .md { max-height: 130px; overflow-y: auto; opacity: 0.75; }

.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-dim);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 9px;
  margin: 2px 6px 2px 0;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}
.tool-chip .spin { animation: pulse 1s ease-in-out infinite; }

.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-panel);
  color: var(--accent);
  font-size: 12.5px;
  padding: 4px 12px;
  margin-top: 6px;
  cursor: pointer;
}
.retry-btn:active { background: var(--bg-elevated); }

#empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-faint);
  font-size: 13px;
  padding: 20px;
  text-align: center;
}
#empty .big { font-size: 34px; opacity: .5; }

/* 工具确认条 */
#confirm-bar {
  flex: none;
  display: none;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
}
#confirm-bar.open { display: flex; }
#confirm-bar .head { font-size: 12px; color: var(--warn); display: flex; align-items: center; gap: 6px; }
#confirm-bar .tool-item {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 10px;
}
#confirm-bar .tool-item .tname {
  font-size: 13px; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#confirm-bar .tool-item .targs {
  font: 11.5px/1.5 ui-monospace, Consolas, monospace;
  color: var(--text-dim);
  margin-top: 3px;
  max-height: 64px;
  overflow: hidden;
  word-break: break-all;
}
#confirm-bar .tool-item .trow { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }
#confirm-bar button {
  border: none;
  border-radius: 8px;
  padding: 7px 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
#confirm-bar .ok { background: var(--ok); color: #0e2b24; }
#confirm-bar .no { background: var(--bg-elevated); color: var(--text-dim); border: 1px solid var(--border); }
#confirm-bar .pending { opacity: .6; pointer-events: none; }

/* ---------- composer ---------- */
footer.composer {
  flex: none;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  padding: 8px 10px;
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
#input {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
  color: var(--text);
  font: inherit;
  padding: 9px 12px;
  max-height: 120px;
  min-height: 42px;
  outline: none;
}
#input:focus { border-color: var(--accent-dim); }
#input:disabled { opacity: .6; }
#send {
  flex: none;
  height: 42px;
  min-width: 58px;
  border: none;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  padding: 0 14px;
}
#send:active { opacity: .8; }
#send.stop { background: var(--danger); }
#send:disabled { background: var(--accent-dim); cursor: default; }

/* ---------- tab bar ---------- */
#tabbar {
  flex: none;
  display: flex;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  padding-bottom: var(--footer-safe);
  padding-top: 4px;
}
#tabbar button {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 10.5px;
  padding: 6px 0 8px;
  cursor: pointer;
}
#tabbar button svg { width: 21px; height: 21px; fill: currentColor; }
#tabbar button.active { color: var(--accent); }

/* ---------- files ---------- */
#ws-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
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
#ws-bar .ws-sub { font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ws-bar .mini-btn {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
}
#ws-bar .mini-btn:active { background: var(--bg); }

#file-tree { flex: 1; overflow-y: auto; padding: 6px 8px 12px; }
.fdir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 8px;
  border-radius: 8px;
  color: var(--text);
  cursor: pointer;
  width: 100%;
  background: transparent;
  border: none;
  text-align: left;
  font-size: 14px;
}
.fdir-row:active { background: var(--bg-elevated); }
.fdir-row .caret-svg { width: 12px; height: 12px; fill: var(--text-faint); flex: none; transition: transform .12s ease; }
.fdir-row.open .caret-svg { transform: rotate(90deg); }
.fdir-row .fname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fdir-row .fico { width: 16px; height: 16px; fill: var(--text-faint); flex: none; }
.fdir-row .fsize { flex: none; font-size: 11px; color: var(--text-faint); }
.fdir-row.binary { opacity: .55; }

#file-viewer { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#file-viewer-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
#file-viewer-head .fpath { flex: 1; min-width: 0; font-size: 12.5px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#file-editor {
  flex: 1;
  min-height: 0;
  resize: none;
  border: none;
  background: var(--code-bg);
  color: var(--text);
  font: 12.5px/1.6 ui-monospace, "Cascadia Code", Consolas, monospace;
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
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
}
#file-viewer-foot .finfo { flex: 1; min-width: 0; font-size: 11.5px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#file-viewer-foot .save-btn {
  flex: none;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 18px;
  cursor: pointer;
}
#file-viewer-foot .save-btn:disabled { background: var(--accent-dim); }

/* ---------- settings ---------- */
#settings-scroll { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
}
.card h3 { font-size: 12px; color: var(--text-faint); margin-bottom: 8px; font-weight: 600; }
.set-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; font-size: 13.5px; }
.set-row .k { color: var(--text-dim); width: 86px; flex: none; }
.set-row .v { flex: 1; min-width: 0; color: var(--text); word-break: break-all; text-align: right; }
.set-row .v.copyable { color: var(--accent); cursor: pointer; }
.url-chip {
  display: flex; align-items: center; gap: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 10px;
  margin-top: 6px;
  font: 12px ui-monospace, Consolas, monospace;
  color: var(--text);
  cursor: pointer;
  word-break: break-all;
}
.url-chip:active { background: var(--bg); }

.cfg-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
  padding: 9px 11px;
  margin-bottom: 8px;
}
.cfg-item .cname { font-size: 13.5px; font-weight: 600; }
.cfg-item .cmodel { font-size: 12px; color: var(--text-dim); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cfg-item .mchips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cfg-item .mchip {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-panel);
  color: var(--text-dim);
  font-size: 12px;
  padding: 4px 11px;
  cursor: pointer;
  max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cfg-item .mchip.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.cfg-item .mchip:disabled { opacity: .5; }
.info-text { font-size: 12px; color: var(--text-faint); line-height: 1.6; }

/* ---------- bottom sheets & modals ---------- */
#sheet {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: none;
}
#sheet.open { display: flex; }
#sheet .backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,.5);
  animation: fadeIn .15s ease;
}
#sheet .panel {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  max-height: 75dvh;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  border-radius: 16px 16px 0 0;
  padding: 12px 10px calc(12px + var(--footer-safe));
  display: flex;
  flex-direction: column;
  animation: slideUp .18s ease;
}
#sheet .head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 10px;
}
#sheet .head b { font-size: 15px; }
#sheet .list { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.conv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 10px;
  border-radius: 10px;
  background: transparent;
  border: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.conv-item:active { background: var(--bg-elevated); }
.conv-item.active { background: var(--accent-dim); }
.conv-item .t { flex: 1; min-width: 0; }
.conv-item .t .name {
  font-size: 14px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.conv-item .t .preview {
  font-size: 11.5px;
  color: var(--text-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 2px;
}
.conv-item .when { flex: none; font-size: 11px; color: var(--text-faint); }
.sheet-sep { font-size: 11px; color: var(--text-faint); padding: 10px 10px 4px; }

#modal {
  position: fixed; inset: 0; z-index: 40;
  display: none;
  align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0,0,0,.55);
}
#modal.open { display: flex; }
#modal .box {
  width: 100%; max-width: 320px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px;
}
#modal h3 { font-size: 15px; margin-bottom: 12px; }
#modal input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  color: var(--text);
  font: inherit;
  padding: 9px 11px;
  outline: none;
}
#modal .row { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }
#modal button {
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13.5px;
  cursor: pointer;
}
#modal .cancel { background: var(--bg-elevated); color: var(--text-dim); }
#modal .ok { background: var(--accent); color: #fff; font-weight: 600; }
#modal .danger { background: var(--danger); color: #fff; font-weight: 600; }

#toast {
  position: fixed;
  left: 50%;
  bottom: calc(var(--tabbar-h) + 40px + var(--footer-safe));
  transform: translateX(-50%);
  z-index: 50;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
  padding: 9px 16px;
  border-radius: 999px;
  box-shadow: 0 4px 16px rgba(0,0,0,.4);
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
    <button class="icon-btn" id="btn-switch" title="switch" aria-label="switch">
      <svg viewBox="0 0 24 24"><path d="M3 6h13v3H3zM3 11h10v3H3zM3 16h7v3H3zM17.5 15V9l4 3z"/></svg>
    </button>
    <div class="title-wrap">
      <h1 id="title">GrayCode</h1>
      <div class="sub"><span class="dot" id="dot"></span><span id="status">…</span><span class="ws" id="ws-name" hidden></span></div>
    </div>
    <button class="icon-btn" id="btn-refresh" title="refresh" aria-label="refresh">
      <svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
    </button>
  </header>

  <div id="views">
    <section id="view-chat" class="view">
      <div id="messages" hidden></div>
      <div id="empty" hidden>
        <div class="big">💬</div>
        <div id="empty-text"></div>
      </div>
      <div id="confirm-bar"></div>
      <footer class="composer">
        <textarea id="input" rows="1" autocomplete="off" enterkeyhint="send"></textarea>
        <button id="send"></button>
      </footer>
    </section>

    <section id="view-files" class="view" hidden>
      <div id="ws-bar">
        <div style="flex:1;min-width:0;">
          <div class="ws-name" id="ws-bar-name">—</div>
          <div class="ws-sub" id="ws-bar-file"></div>
        </div>
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
          <div class="set-row"><span class="k" id="set-conn-label"></span><span class="v" id="set-conn-val">—</span></div>
          <div class="set-row"><span class="k" id="set-port-label"></span><span class="v" id="set-port-val">—</span></div>
          <div class="set-row"><span class="k" id="set-ver-label"></span><span class="v" id="set-ver-val">—</span></div>
        </div>
        <div class="card">
          <h3 id="set-urls-title"></h3>
          <div id="urls-list"></div>
        </div>
        <div class="card">
          <h3 id="set-model-title"></h3>
          <div id="configs-list"></div>
        </div>
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

<div id="sheet">
  <div class="backdrop"></div>
  <div class="panel">
    <div class="head">
      <b id="sheet-title">…</b>
      <button class="icon-btn" id="btn-new" aria-label="new">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <div class="list" id="sheet-list"></div>
  </div>
</div>

<div id="modal">
  <div class="box">
    <h3 id="modal-title">…</h3>
    <input id="modal-input" maxlength="100" autocomplete="off" hidden>
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
  serverStopped: false
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
  var meta = '';
  if (msg.role === 'model' && msg.modelVersion) {
    meta = '<div class="meta"><span class="model">' + esc(t('modelTag')) + ': ' + esc(msg.modelVersion) + '</span></div>';
  }
  var body = '';
  if (msg.role === 'system') {
    body = partsToText(msg.parts, 'text') || t('systemMessage');
  } else {
    var thought = partsToText(msg.parts, 'thought');
    var text = partsToText(msg.parts, 'text');
    var calls = partsToToolCalls(msg.parts);
    if (thought) body += '<div class="thoughts"><div class="md">' + renderMarkdown(thought) + '</div></div>';
    calls.forEach(function (c) { body += '<span class="tool-chip">🔧 ' + esc(c) + '</span>'; });
    if (text) body += '<div class="bubble"><div class="md">' + renderMarkdown(text) + '</div></div>';
    else if (!thought && calls.length === 0) body += '<div class="bubble">' + esc(t('emptyMessages')) + '</div>';
  }
  el.innerHTML = meta + body;
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
    // 长按消息 → 删除该消息及其之后的消息（与桌面端删除语义一致）
    if (state.conversationId) {
      attachLongPress(el, function () {
        openModal(t('deleteMessageConfirm'), null, t('deleteMessage'), t('renameCancel'), 'danger', function () {
          api('/api/delete-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: state.conversationId, targetIndex: i })
          }).then(function () {
            toast(t('deleteMessageDone'));
            loadMessages(state.conversationId, true);
            loadConversations();
          }).catch(function (err) {
            toast(t('deleteMessageFailed') + ': ' + (err.message || ''));
          });
        });
      });
    }
    messagesEl.appendChild(el);
  });
  if (state.streaming) {
    var holder = document.createElement('div');
    holder.className = 'msg assistant';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = (state.streamingText ? renderMarkdown(state.streamingText) : '') + '<span class="caret"></span>';
    holder.appendChild(bubble);
    messagesEl.appendChild(holder);
  }
  scrollToBottom(true);
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
  el.innerHTML = '<div class="bubble">' + esc(t('errorBanner')) + ': ' + esc(msg || '') + '</div>' +
    (withRetry ? '<button class="retry-btn">↻ ' + esc(t('retry')) + '</button>' : '');
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
    sheetListEl.innerHTML = '';
    if (list.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'conv-item';
      empty.style.color = 'var(--text-faint)';
      empty.textContent = t('emptyConversation');
      sheetListEl.appendChild(empty);
    }
    list.forEach(function (c) {
      var it = document.createElement('button');
      it.className = 'conv-item' + (c.id === state.conversationId ? ' active' : '');
      it.innerHTML = '<div class="t"><div class="name">' + esc(c.title || t('untitled')) + '</div>' +
        (c.preview ? '<div class="preview">' + esc(c.preview) + '</div>' : '') + '</div>' +
        '<span class="when">' + fmtTime(c.updatedAt) + '</span>';
      it.addEventListener('click', function () {
        switchConversation(c.id, c.title);
      });
      it.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openRename(c.id, c.title);
      });
      sheetListEl.appendChild(it);
    });
    return list;
  });
}
function switchConversation(id, title) {
  closeSheet();
  state.conversationId = id;
  state.streaming = false;
  state.streamingText = '';
  state.messages = [];
  state.pendingTools = [];
  renderConfirmBar();
  setTitle(title);
  renderMessages();
  loadMessages(id);
  loadConversations();
}
function openSheet() {
  sheetEl.classList.add('open');
  sheetTitleEl.textContent = t('conversations');
  loadConversations();
}
function closeSheet() { sheetEl.classList.remove('open'); }

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
  modalInputEl.hidden = (typeof inputValue !== 'string');
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
    sendBtn.textContent = t('stop');
    sendBtn.classList.add('stop');
  } else {
    setStatus(state.connected ? 'connected' : 'connecting', state.connected ? t('statusConnected') : t('statusConnecting'));
    sendBtn.textContent = t('send');
    sendBtn.classList.remove('stop');
  }
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
    var bubble = last.querySelector('.bubble');
    bubble.innerHTML = (state.streamingText ? renderMarkdown(state.streamingText) : '') + '<span class="caret"></span>';
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
  }
}
function renderFileTree(path, entries) {
  var root = fileTreeEl;
  root.innerHTML = '';
  if (!state.workspaceUri && !state.workspaceName) {
    var hint = document.createElement('div');
    hint.className = 'conv-item';
    hint.style.color = 'var(--text-faint)';
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
  if (!quiet) fileTreeEl.innerHTML = '<div class="conv-item" style="color:var(--text-faint)">' + esc(t('loading')) + '</div>';
  return api('/api/files?path=' + encodeURIComponent(path))
    .then(function (data) {
      state.fileDirs[path] = Array.isArray(data.entries) ? data.entries : [];
      renderFileTree(path, state.fileDirs[path]);
    })
    .catch(function (err) {
      fileTreeEl.innerHTML = '<div class="conv-item" style="color:var(--danger)">' + esc(t('loadFailed')) + ': ' + esc(err.message || '') + '</div>';
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
  sheetListEl.innerHTML = '<div class="conv-item" style="color:var(--text-faint)">' + esc(t('loading')) + '</div>';
  loadWorkspaces().then(function (items) {
    sheetListEl.innerHTML = '';
    if (items.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'conv-item';
      empty.style.color = 'var(--text-faint)';
      empty.textContent = t('noWorkspace');
      sheetListEl.appendChild(empty);
      return;
    }
    items.forEach(function (w) {
      var it = document.createElement('button');
      it.className = 'conv-item' + (w.active ? ' active' : '');
      it.innerHTML = '<div class="t"><div class="name">' + esc(w.name) + '</div>' +
        (w.saved ? '<div class="preview">' + esc(t('savedWorkspaces')) + '</div>' : '') + '</div>';
      it.addEventListener('click', function () {
        if (!w.active && w.uri) {
          api('/api/workspace-switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceUri: w.uri })
          }).then(function () {
            // SSE workspace 事件（BackendHost onActiveWorkspaceChanged → notifyWorkspaceChange）
            // 会刷新工作区状态与文件页；此处兜底清理，防 SSE 未连接时保存到错误工作区
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
      sheetListEl.appendChild(it);
    });
  }).catch(function (err) {
    sheetListEl.innerHTML = '<div class="conv-item" style="color:var(--danger)">' + esc(err.message || '') + '</div>';
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
      listEl.appendChild(item);
      loadConfigModels(cfg.id, item.querySelector('.mchips'));
    });
  }).catch(function (err) {
    $('configs-list').innerHTML = '<div class="info-text" style="color:var(--danger)">' + esc(err.message || '') + '</div>';
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
  $('set-conn-val').style.color = s.running ? 'var(--ok)' : 'var(--danger)';
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
$('btn-switch').addEventListener('click', openSheet);
$('btn-refresh').addEventListener('click', function () {
  if (!isTab('chat')) return;
  loadMessages(state.conversationId);
  loadConversations();
  toast(t('refresh') + ' ✓');
});
$('btn-new').addEventListener('click', function () {
  closeSheet();
  state.conversationId = null;
  state.messages = [];
  state.streaming = false;
  state.streamingText = '';
  state.pendingTools = [];
  renderConfirmBar();
  setTitle('');
  renderMessages();
  inputEl.focus();
  toast(t('newChat') + ' — ' + t('emptyConversation'));
});
sheetEl.querySelector('.backdrop').addEventListener('click', closeSheet);
$('btn-ws-switch').textContent = t('switchWorkspace');
$('btn-ws-switch').addEventListener('click', openWorkspaceSheet);
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
  saveFileBtnEl.style.background = 'var(--warn)';
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
modalInputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); modalOkEl.click(); }
  if (e.key === 'Escape') closeModal();
});

/* ---------- boot ---------- */
setStatus('connecting', t('statusConnecting'));
$('btn-ws-switch').textContent = t('switchWorkspace');
saveFileBtnEl.textContent = t('save');
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
