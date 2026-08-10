/**
 * remoteControlUi.ts
 *
 * 远程控制移动端 UI（自包含单页 HTML）。
 *
 * 设计约束：
 * - 无外部依赖：HTML/CSS/JS 全部内联，随 HTTP 响应下发，移动端浏览器直接可用；
 * - 懒加载：本页面只由 RemoteControlServer 在「远程控制开启」时提供，
 *   关闭时服务器不存在，UI 代码完全不进入运行态（零资源占用）；
 * - 语言：随桌面端 ui.language（zh-CN/en/ja），默认 zh-CN。
 *
 * 页面通过以下 API 与主进程通信（同一 origin，无 CORS）：
 *   GET  /api/status        运行状态 / 激活会话 / 语言
 *   GET  /api/conversations 会话列表
 *   GET  /api/messages      会话消息（role/parts 结构）
 *   POST /api/send          发送消息（chatStream）
 *   POST /api/cancel        停止生成
 *   POST /api/rename        重命名会话
 *   GET  /api/stream        SSE 事件流（streamChunk / streamChunkBatch / hello / bye）
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
  nowStreaming: string;
}

const UI_TEXTS: Record<UiLang, UiText> = {
  'zh-CN': {
    appTitle: 'GrayCode 远程控制',
    statusConnecting: '连接中…',
    statusConnected: '已连接',
    statusReconnecting: '重连中…',
    statusStreaming: '生成中…',
    statusServerStopped: '远程控制已关闭',
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
    nowStreaming: '正在生成回复…'
  },
  en: {
    appTitle: 'GrayCode Remote',
    statusConnecting: 'Connecting…',
    statusConnected: 'Connected',
    statusReconnecting: 'Reconnecting…',
    statusStreaming: 'Generating…',
    statusServerStopped: 'Remote control is off',
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
    nowStreaming: 'Generating reply…'
  },
  ja: {
    appTitle: 'GrayCode リモート',
    statusConnecting: '接続中…',
    statusConnected: '接続済み',
    statusReconnecting: '再接続中…',
    statusStreaming: '生成中…',
    statusServerStopped: 'リモートコントロールはオフです',
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
    nowStreaming: '返信を生成中…'
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
  --code-bg: #1b1b1c;
  --radius: 10px;
  --header-h: 52px;
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
.dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.dot.connected { background: var(--ok); }
.dot.streaming { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
.dot.connecting { background: #d7ba7d; }
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

#messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px calc(16px + var(--footer-safe));
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
.bubble .md table { border-collapse: collapse; margin: 8px 0; font-size: 13px; }
.bubble .md th, .bubble .md td { border: 1px solid var(--border); padding: 4px 8px; }

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

footer {
  flex: none;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  padding: 8px 10px calc(8px + var(--footer-safe));
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

/* 会话切换抽屉 */
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

#rename-modal {
  position: fixed; inset: 0; z-index: 40;
  display: none;
  align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0,0,0,.55);
}
#rename-modal.open { display: flex; }
#rename-modal .box {
  width: 100%; max-width: 320px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px;
}
#rename-modal h3 { font-size: 15px; margin-bottom: 12px; }
#rename-modal input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  color: var(--text);
  font: inherit;
  padding: 9px 11px;
  outline: none;
}
#rename-modal .row { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }
#rename-modal button {
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13.5px;
  cursor: pointer;
}
#rename-modal .cancel { background: var(--bg-elevated); color: var(--text-dim); }
#rename-modal .ok { background: var(--accent); color: #fff; font-weight: 600; }

#toast {
  position: fixed;
  left: 50%;
  bottom: calc(90px + var(--footer-safe));
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
      <div class="sub"><span class="dot" id="dot"></span><span id="status">…</span></div>
    </div>
    <button class="icon-btn" id="btn-refresh" title="refresh" aria-label="refresh">
      <svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
    </button>
  </header>

  <div id="messages" hidden></div>
  <div id="empty" hidden>
    <div class="big">💬</div>
    <div id="empty-text"></div>
  </div>

  <footer>
    <textarea id="input" rows="1" autocomplete="off" enterkeyhint="send"></textarea>
    <button id="send"></button>
  </footer>
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
    <div class="list" id="conv-list"></div>
  </div>
</div>

<div id="rename-modal">
  <div class="box">
    <h3 id="rename-title">…</h3>
    <input id="rename-input" maxlength="100" autocomplete="off">
    <div class="row">
      <button class="cancel" id="rename-cancel"></button>
      <button class="ok" id="rename-ok"></button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
'use strict';
var T = ${texts};
function t(k) { return T[k] != null ? T[k] : k; }
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
  lastActiveConversation: null
};

var $ = function (id) { return document.getElementById(id); };
var messagesEl = $('messages');
var emptyEl = $('empty');
var inputEl = $('input');
var sendBtn = $('send');
var dotEl = $('dot');
var statusEl = $('status');
var titleEl = $('title');
var convListEl = $('conv-list');
var sheetEl = $('sheet');
var toastEl = $('toast');

function fmtTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  var now = new Date();
  var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  return (d.getMonth() + 1) + '/' + d.getDate();
}

function setStatus(kind, text) {
  dotEl.className = 'dot ' + kind;
  statusEl.textContent = text;
}
function setTitle(text) {
  titleEl.textContent = text || t('untitled');
  document.title = text ? (text + ' - GrayCode') : 'GrayCode Remote';
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
function buildMessage(msg) {
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
  state.messages.forEach(function (m) { messagesEl.appendChild(buildMessage(m)); });
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
    $('empty-text').textContent = t('loading');
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
function showErrorBanner(msg) {
  var el = document.createElement('div');
  el.className = 'msg error';
  el.innerHTML = '<div class="bubble">' + esc(t('errorBanner')) + ': ' + esc(msg || '') + '</div>';
  messagesEl.appendChild(el);
  scrollToBottom(true);
}
function loadConversations() {
  return api('/api/conversations').then(function (data) {
    var list = Array.isArray(data.conversations) ? data.conversations : [];
    convListEl.innerHTML = '';
    if (list.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'conv-item';
      empty.style.color = 'var(--text-faint)';
      empty.textContent = t('emptyConversation');
      convListEl.appendChild(empty);
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
      convListEl.appendChild(it);
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
  setTitle(title);
  renderMessages();
  loadMessages(id);
  loadConversations();
}
function openSheet() {
  sheetEl.classList.add('open');
  loadConversations();
}
function closeSheet() { sheetEl.classList.remove('open'); }

/* ---------- rename ---------- */
var renaming = null;
function openRename(id, title) {
  renaming = id;
  $('rename-input').value = title || '';
  $('rename-modal').classList.add('open');
  setTimeout(function () { $('rename-input').focus(); }, 60);
}
function closeRename() { $('rename-modal').classList.remove('open'); renaming = null; }
function submitRename() {
  if (!renaming) return;
  var title = $('rename-input').value.trim();
  if (!title) { closeRename(); return; }
  api('/api/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: renaming, title: title })
  }).then(function () {
    setTitle(title);
    loadConversations();
    toast(t('renameSave') + ' ✓');
  }).catch(function (err) {
    toast(t('sendFailed') + ': ' + (err.message || ''));
  }).finally(closeRename);
}

/* ---------- send / stop ---------- */
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

/* ---------- SSE ---------- */
function connectStream() {
  if (state.evtSource) return;
  var es;
  try { es = new EventSource('/api/stream'); } catch (e) { retryConnect(); return; }
  state.evtSource = es;
  es.onopen = function () {
    state.connected = true;
    setStatus(state.streaming ? 'streaming' : 'connected', state.streaming ? t('statusStreaming') : t('statusConnected'));
  };
  es.addEventListener('hello', function (ev) {
    try {
      var info = JSON.parse(ev.data);
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
  es.addEventListener('bye', function () {
    es.close();
    state.evtSource = null;
    state.connected = false;
    state.streaming = false;
    setStatus('error', t('statusServerStopped'));
    sendBtn.disabled = true;
  });
  es.onerror = function () {
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
        showErrorBanner(d.message || t('loadFailed'));
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
    loadMessages(state.conversationId, true);
    loadConversations();
    return;
  }
  if (type === 'cancelled') {
    if (state.streaming) { state.streamingText = d.content || state.streamingText; setStreaming(false); }
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
  if (type === 'toolsExecuting' || type === 'toolIteration' || type === 'awaitingConfirmation') {
    if (!state.streaming) setStreaming(true, '');
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
  setTitle('');
  renderMessages();
  inputEl.focus();
  toast(t('newChat') + ' — ' + t('emptyConversation'));
});
sheetEl.querySelector('.backdrop').addEventListener('click', closeSheet);
$('rename-cancel').addEventListener('click', closeRename);
$('rename-ok').addEventListener('click', submitRename);
$('rename-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitRename(); }
  if (e.key === 'Escape') closeRename();
});

/* ---------- boot ---------- */
setStatus('connecting', t('statusConnecting'));
api('/api/status').then(function (s) {
  state.appVersion = s.appVersion || '';
  if (s.lang) state.lang = s.lang;
  state.lastActiveConversation = s.activeConversationId || null;
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
