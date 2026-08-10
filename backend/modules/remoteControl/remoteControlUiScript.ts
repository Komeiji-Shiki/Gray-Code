/**
 * remoteControlUiScript.ts
 *
 * 远程控制移动端 UI 的脚本（V3 重构版）。
 *
 * 与旧版（5128 行单文件）相比的核心变化：
 * - 输入区四选择器：模型模式 / 渠道 / 模型 / 思考强度，与桌面端 InputSelectorBar
 *   对齐；下拉以底部弹层呈现（移动端交互），面板尺寸正常；
 * - 会话页签始终可关闭（含未落库的新对话页签）；
 * - 设置页渠道完整增删改（新增/编辑/删除/模型管理/思考强度），高级设置可读写；
 * - SSE conversations 事件实时刷新会话列表（桌面端与移动端双向实时同步）；
 * - 图标全部内嵌 SVG。
 *
 * 注：本文件在 TS 模板字符串内输出浏览器脚本，脚本内部不得使用反引号与 `${`，
 * 一律用单引号字符串拼接（与旧版同约定，避免模板嵌套转义地狱）。
 */

/** 构建移动端 UI 脚本（texts 为序列化并转义后的 i18n JSON，uiLang 为语言） */
export function buildRemoteUiScript(texts: string, uiLang: string): string {
  return `<script>
'use strict';
var T = ${texts};
function t(k) { return T[k] != null ? T[k] : k; }
function i18nAll() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
}
i18nAll();

/* ============================================================
   工具函数
   ============================================================ */
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function toast(msg) {
  var el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () { el.classList.remove('show'); }, 2400);
}
function fmtTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  var now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function api(path, opts) {
  var options = opts || {};
  return fetch(path, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok || data.ok === false) {
        var err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
        err.status = res.status;
        throw err;
      }
      return data;
    }).catch(function (err) {
      if (err && err.status) throw err;
      throw new Error('HTTP ' + res.status);
    });
  });
}
function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

/* ============================================================
   图标（全部内嵌 SVG，无字体/emoji 依赖——杜绝移动端图标丢失）
   ============================================================ */
function icon(name, cls) {
  var paths = ICONS[name];
  if (!paths) return '';
  var c = cls ? ' class="' + cls + '"' : '';
  return '<svg' + c + ' viewBox="0 0 24 24" fill="currentColor">' + paths + '</svg>';
}
var ICONS = {
  menu: '<path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/>',
  refresh: '<path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chat: '<path d="M12 3C6.5 3 2 7.03 2 12c0 2.6 1.27 4.9 3.27 6.47L4.3 21.6l3.6-1.2c1.3.39 2.7.6 4.1.6 5.5 0 10-4.03 10-9s-4.5-9-10-9zm-5 10a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>',
  gear: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 4a7 7 0 0 0-.1-1.2l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.06-1.2L16.2 3h-4l-.6 2.54a7 7 0 0 0-2.06 1.2l-2.35-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.4l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.06 1.2L12.2 21h4l.6-2.54a7 7 0 0 0 2.06-1.2l2.35.95 2-3.46-2-1.55c.06-.4.1-.8.1-1.2z"/>',
  back: '<path d="M15 4l-8 8 8 8V4z"/>',
  desktop: '<path d="M4 5h16v10H4V5zm2 12h12v2H6v-2z"/>',
  folderUp: '<path d="M19 12H5m6-6l-6 6 6 6"/>',
  file: '<path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>',
  chevronRight: '<path d="M9 6l6 6-6 6V6z"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  trash: '<path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zm13.5-14l1.5 1.5"/>',
  copy: '<path d="M8 8h12v12H8V8zm4-6h12v12h-4V8h-8V2z"/>',
  send: '<path d="M3 11l18-8-8 18-2-8-8-2z"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  pencil: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zm13.5-14l1.5 1.5"/>',
  refresh2: '<path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>',
  warning: '<path d="M12 3L1 21h22L12 3zm1 14h-2v2h2v-2zm0-8h-2v6h2V9z"/>',
  history: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10l4 2-1 1.7-5-2.5V6h2v6z"/>',
  sparkle: '<path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z"/>',
  brain: '<path d="M12 2a5 5 0 0 1 5 5c2 1 3 3 3 5 0 2-1.3 3.7-3.2 4.4A5 5 0 0 1 12 22a5 5 0 0 1-4.8-5.6A5 5 0 0 1 4 12c0-2 1-4 3-5a5 5 0 0 1 5-5z"/>'
};
var ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>';
var ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>';

/* ============================================================
   状态
   ============================================================ */
var MAX_EDIT_CHARS = 1024 * 1024;

var state = {
  lang: '${uiLang}',
  appVersion: '',
  connected: false,
  evtSource: null,
  reconnectTimer: null,
  serverStopped: false,
  /* 会话页签（多会话并行） */
  tabs: [],
  activeTabKey: null,
  convPage: 0,
  convTotal: 0,
  convLoading: false,
  convList: [],
  /* 工作区 */
  workspaceUri: null,
  workspaceName: '',
  activeFilePath: null,
  fileDirs: {},
  currentFile: null,
  /* 输入区选择器 */
  configs: [],             /* [{id,name,model,enabled,type,options,optionsEnabled}] */
  configModels: {},        /* configId -> [{id,name}] */
  activeChannelId: null,
  selectedModelId: null,   /* null = 自动（渠道默认模型）；显式选择后随发送透传 modelOverride */
  promptModes: [],         /* [{id,name,icon,dynamicContextStrategy}] */
  currentModeId: '',
  thinkingLevel: 'off',
  thinkingOptions: [],
  /* 设置页 */
  settings: null,
  settingsTab: 'channel',
  tools: [],
  autoExec: {},
  deps: [],
  statusInfo: null,
  settingsBusy: false,
  /* 目录浏览 */
  browsePath: '',
  browseParent: null,
  browseDrives: [],
  browseBusy: false
};

var CONV_PAGE_SIZE = 30;
var MSG_PAGE_SIZE = 120;
var ORPHAN_STREAM_MAX = 12;
var ORPHAN_CHUNK_MAX = 5000;
var orphanStreams = {};

function tabByKey(key) {
  for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].key === key) return state.tabs[i];
  return null;
}
function tabByConvId(id) {
  if (!id) return null;
  for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].id === id) return state.tabs[i];
  return null;
}
function activeTab() {
  return tabByKey(state.activeTabKey);
}
function newTabObject(id, title) {
  var key = (id && id !== 'new')
    ? id
    : ('new-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  return {
    key: key,
    id: id || null,
    title: title || '',
    messages: [],
    total: 0,
    offset: 0,
    hasMore: false,
    loading: false,
    streaming: false,
    streamingText: '',
    streamingModel: '',
    pendingTools: [],
    confirmInFlight: false,
    sendInFlight: false,
    lastError: null,
    pendingStreamId: null
  };
}

/* ============================================================
   顶栏 / 状态
   ============================================================ */
function setStatus(kind, text) {
  var dot = $('dot');
  dot.className = 'dot ' + kind;
  $('status').textContent = text;
}
function setTitle(text) {
  $('title').textContent = text || t('appTitle');
}
function setWorkspaceName(name) {
  var ws = $('ws-name');
  if (name) {
    ws.textContent = name;
    ws.hidden = false;
  } else {
    ws.hidden = true;
  }
}

/* ============================================================
   会话页签（桌面端 ConversationTabs 同款）
   ============================================================ */
function renderTabsBar() {
  var tabsEl = $('conv-tabs');
  tabsEl.innerHTML = '';
  state.tabs.forEach(function (tab) {
    var btn = document.createElement('button');
    btn.className = 'conv-tab' + (tab.key === state.activeTabKey ? ' active' : '');
    var spin = tab.streaming ? '<span class="tab-spin"></span>' : '';
    // 关键修复：所有页签（含未落库的新对话页签）都渲染关闭按钮
    var close = '<span class="tab-close" data-close="1" title="' + esc(t('closeTab')) + '">&times;</span>';
    btn.innerHTML = spin + '<span class="tab-title">' + esc(tab.title || t('untitled')) + '</span>' + close;
    btn.addEventListener('click', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-close')) {
        e.stopPropagation();
        closeTab(tab.key);
        return;
      }
      activateTab(tab.key);
    });
    tabsEl.appendChild(btn);
  });
  var addBtn = document.createElement('button');
  addBtn.className = 'conv-tab new';
  addBtn.innerHTML = icon('plus');
  addBtn.title = t('newChat');
  addBtn.addEventListener('click', newChatTab);
  tabsEl.appendChild(addBtn);
}
function openConversationTab(id, title) {
  var existing = tabByConvId(id);
  if (existing) {
    activateTab(existing.key);
    return;
  }
  var tab = newTabObject(id, title);
  state.tabs.push(tab);
  state.activeTabKey = tab.key;
  renderTabsBar();
  setTitle(tab.title);
  loadMessages(tab, true);
}
function activateTab(key) {
  var prev = activeTab();
  var tab = tabByKey(key);
  if (!tab || tab.key === state.activeTabKey) return;
  if (prev) {
    /* 切出前保存输入草稿与模型模式（每个会话独立） */
    prev.draft = $('input').value;
    prev.modeId = state.currentModeId;
  }
  state.activeTabKey = key;
  /* 恢复该会话的模型模式（与桌面端 per-conversation mode 语义对齐） */
  if (tab.modeId) state.currentModeId = tab.modeId;
  renderTabsBar();
  renderComposerMeta();
  setTitle(tab.title);
  renderMessages();
  renderConfirmBar();
  $('input').value = tab.draft || '';
  autoGrowInput();
  updateSendBtn();
  if (tab.id && tab.messages.length === 0) loadMessages(tab, true);
  scrollToBottom();
}
/** 关闭页签：有会话 ID 时同时取消后端流；未落库页签直接丢弃 */
function closeTab(key) {
  var idx = -1;
  for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].key === key) { idx = i; break; }
  if (idx < 0) return;
  var tab = state.tabs[idx];
  if (tab.streaming && tab.id) {
    post('/api/cancel', { conversationId: tab.id }).catch(function () {});
  }
  state.tabs.splice(idx, 1);
  if (state.activeTabKey === key) {
    var next = state.tabs[idx] || state.tabs[idx - 1] || null;
    if (next) {
      state.activeTabKey = next.key;
    } else {
      newChatTab();
      return;
    }
  }
  renderTabsBar();
  var cur = activeTab();
  if (cur) {
    setTitle(cur.title);
    renderMessages();
    renderConfirmBar();
    $('input').value = cur.draft || '';
    updateSendBtn();
  } else {
    setTitle('');
    $('empty-text').textContent = t('emptyConversation');
    $('empty').hidden = false;
    $('messages').hidden = true;
  }
}
function closeTabByConvId(id) {
  for (var i = 0; i < state.tabs.length; i++) {
    if (state.tabs[i].id === id) { closeTab(state.tabs[i].key); return; }
  }
}
function newChatTab() {
  var tab = newTabObject(null, '');
  state.tabs.push(tab);
  state.activeTabKey = tab.key;
  renderTabsBar();
  setTitle('');
  $('empty-text').textContent = t('emptyNewChat');
  $('empty').hidden = false;
  $('messages').hidden = true;
  $('input').value = '';
  renderConfirmBar();
  updateSendBtn();
  scrollToBottom();
}
function syncTabTitles(conversations) {
  var byId = {};
  (conversations || []).forEach(function (c) { if (c && c.id) byId[c.id] = c; });
  var changed = false;
  state.tabs.forEach(function (tab) {
    if (!tab.id) return;
    var conv = byId[tab.id];
    if (conv && conv.title && conv.title !== tab.title) {
      tab.title = conv.title;
      changed = true;
    }
  });
  if (changed) {
    renderTabsBar();
    var cur = activeTab();
    if (cur) setTitle(cur.title);
  }
}

/* ============================================================
   会话抽屉（最近对话列表）
   ============================================================ */
function loadConversations(reset) {
  if (reset) {
    state.convPage = 0;
    state.convList = [];
    state.convTotal = 0;
  }
  if (state.convLoading) return;
  state.convLoading = true;
  api('/api/conversations?limit=' + CONV_PAGE_SIZE + '&offset=' + (state.convPage * CONV_PAGE_SIZE))
    .then(function (data) {
      state.convTotal = data.total || 0;
      var items = Array.isArray(data.conversations) ? data.conversations : [];
      if (state.convPage === 0) state.convList = items;
      else state.convList = state.convList.concat(items);
      state.convPage++;
      renderDrawerList();
      syncTabTitles(items);
    })
    .catch(function () {})
    .then(function () {
      state.convLoading = false;
    });
}
function renderDrawerList() {
  var list = $('drawer-list');
  list.innerHTML = '';
  if (state.convList.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = t('emptyConversation');
    list.appendChild(empty);
    return;
  }
  state.convList.forEach(function (conv) {
    var item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === (activeTab() && activeTab().id) ? ' active' : '');
    var title = document.createElement('span');
    title.className = 'cv-title';
    title.textContent = conv.title || t('untitled');
    var meta = document.createElement('span');
    meta.className = 'cv-meta';
    meta.textContent = (conv.messageCount > 0 ? conv.messageCount + ' · ' : '') + fmtTime(conv.updatedAt);
    var renameBtn = document.createElement('button');
    renameBtn.className = 'icon-btn';
    renameBtn.innerHTML = icon('pencil');
    renameBtn.title = t('rename');
    renameBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openRename(conv.id, conv.title || '');
    });
    var delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.innerHTML = icon('trash');
    delBtn.title = t('deleteConversation');
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openModal(t('deleteConversation'), null, t('deleteConversationConfirm'), t('renameCancel'), 'danger', function () {
        deleteConversation(conv.id);
      });
    });
    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(renameBtn);
    item.appendChild(delBtn);
    item.addEventListener('click', function () {
      closeDrawer();
      openConversationTab(conv.id, conv.title || '');
    });
    list.appendChild(item);
  });
  if (state.convPage * CONV_PAGE_SIZE < state.convTotal) {
    var more = document.createElement('button');
    more.className = 'btn secondary conv-load-more';
    more.textContent = t('loadMore');
    more.addEventListener('click', function () { loadConversations(false); });
    list.appendChild(more);
  }
}
function openDrawer() {
  if (state.convList.length === 0) loadConversations(true);
  else renderDrawerList();
  $('drawer').classList.add('open');
}
function closeDrawer() {
  $('drawer').classList.remove('open');
}
function openRename(id, title) {
  openModal(t('renameDialogTitle'), title, t('renameSave'), t('renameCancel'), 'text', function (value) {
    if (!value) return;
    post('/api/rename', { conversationId: id, title: value }).then(function () {
      toast(t('renameSave') + ' ✓');
      loadConversations(true);
      var tab = tabByConvId(id);
      if (tab) { tab.title = value; renderTabsBar(); }
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
}
function deleteConversation(id) {
  post('/api/conversation-delete', { conversationId: id }).then(function () {
    toast(t('deleteConversationDone'));
    closeTabByConvId(id);
    loadConversations(true);
  }).catch(function (err) {
    toast(t('deleteConversationFailed') + ': ' + (err.message || ''));
  });
}

/* ============================================================
   对话框 / 操作弹层
   ============================================================ */
function openModal(title, inputValue, okText, cancelText, kind, onOk) {
  var el = $('modal');
  $('modal-title').textContent = title;
  var inputEl = $('modal-input');
  var bodyEl = $('modal-body');
  bodyEl.innerHTML = '';
  if (kind === 'text') {
    bodyEl.appendChild(inputEl);
    inputEl.value = inputValue || '';
    inputEl.hidden = false;
    inputEl.style.minHeight = '42px';
    inputEl.focus();
  } else if (kind === 'textarea') {
    bodyEl.appendChild(inputEl);
    inputEl.value = inputValue || '';
    inputEl.hidden = false;
    inputEl.style.minHeight = '90px';
    inputEl.focus();
  } else if (kind === 'danger') {
    inputEl.hidden = true;
    var p = document.createElement('div');
    p.textContent = inputValue || '';
    bodyEl.appendChild(p);
  } else {
    inputEl.hidden = true;
  }
  $('modal-cancel').textContent = cancelText || t('renameCancel');
  $('modal-ok').textContent = okText || t('renameSave');
  $('modal-ok').className = 'btn' + (kind === 'danger' ? ' danger' : '');
  el._onOk = onOk;
  el.classList.add('open');
}
function closeModal() {
  $('modal').classList.remove('open');
}
var actPanelEl = null;
function openActionSheet(actions) {
  var el = $('action-sheet');
  var panel = el.querySelector('.panel');
  panel.innerHTML = '';
  actions.forEach(function (act) {
    var btn = document.createElement('button');
    btn.className = 'act-btn' + (act.danger ? ' danger' : '');
    btn.innerHTML = icon(act.icon, '') + '<span>' + esc(act.label) + '</span>';
    btn.addEventListener('click', function () {
      closeActionSheet();
      if (act.onClick) act.onClick();
    });
    panel.appendChild(btn);
  });
  el.classList.add('open');
}
function closeActionSheet() {
  $('action-sheet').classList.remove('open');
}

/* ============================================================
   消息渲染
   ============================================================ */
function renderInline(s) {
  return esc(s)
    .replace(/&quot;/g, '"')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
    .replace(/\\*([^*]+)\\*/g, '<i>$1</i>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function renderTable(lines, i) {
  var rows = [];
  while (i < lines.length && lines[i].trim() !== '') {
    var line = lines[i].trim();
    if (line.startsWith('|')) {
      rows.push(line.slice(1, -1).split('|').map(function (c) { return c.trim(); }));
    } else break;
    i++;
  }
  if (rows.length === 0) return null;
  var html = '<table>';
  rows.forEach(function (row, ri) {
    if (row.every(function (c) { return /^:?-{2,}:?$/.test(c); })) return;
    html += '<tr>';
    row.forEach(function (cell) { html += (ri === 0 ? '<th>' : '<td>') + renderInline(cell) + (ri === 0 ? '</th>' : '</td>'); });
    html += '</tr>';
  });
  html += '</table>';
  return { html: html, next: i };
}
function renderMarkdown(text) {
  var lines = String(text || '').split('\\n');
  var html = '';
  var inCode = false;
  var codeLang = '';
  var codeLines = [];
  var inList = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();
    if (trimmed.startsWith('\`\`\`')) {
      if (inCode) {
        html += '<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>';
        codeLines = [];
        inCode = false;
        continue;
      }
      inCode = true;
      codeLang = trimmed.slice(3).trim();
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      var table = renderTable(lines, i);
      if (table) {
        html += table.html;
        i = table.next - 1;
        continue;
      }
    }
    if (/^#{1,6}\\s/.test(trimmed)) {
      var level = trimmed.match(/^(#{1,6})\\s/)[1].length;
      html += '<h' + level + '>' + renderInline(trimmed.slice(level + 1)) + '</h' + level + '>';
      continue;
    }
    if (/^[-*]\\s/.test(trimmed)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + renderInline(trimmed.slice(2)) + '</li>';
      continue;
    }
    if (/^\\d+\\.\\s/.test(trimmed)) {
      if (!inList) { html += '<ol>'; inList = true; }
      html += '<li>' + renderInline(trimmed.replace(/^\\d+\\.\\s/, '')) + '</li>';
      continue;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    if (trimmed.startsWith('> ')) {
      html += '<blockquote>' + renderInline(trimmed.slice(2)) + '</blockquote>';
      continue;
    }
    if (trimmed === '---' || trimmed === '***') {
      html += '<hr style="border:none;border-top:1px solid var(--vscode-panel-border);margin:8px 0;">';
      continue;
    }
    if (trimmed === '') {
      html += '<p></p>';
      continue;
    }
    html += '<p>' + renderInline(trimmed) + '</p>';
  }
  if (inCode) html += '<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>';
  if (inList) html += '</ul>';
  return html;
}
function partsToText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(function (p) { return p && typeof p.text === 'string' && !p.thought; })
    .map(function (p) { return p.text; })
    .join('');
}
function partsToThought(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(function (p) { return p && typeof p.text === 'string' && p.thought; })
    .map(function (p) { return p.text; })
    .join(' ');
}
function partsToToolCalls(parts) {
  if (!Array.isArray(parts)) return [];
  var calls = [];
  parts.forEach(function (p) {
    if (p && p.functionCall && p.functionCall.name) {
      calls.push({ name: p.functionCall.name, args: p.functionCall.arguments || '' });
    }
  });
  return calls;
}
function buildMessage(msg, index) {
  var role = msg.role === 'user' ? 'user' : 'assistant';
  var isFuncResp = !!msg.isFunctionResponse;
  var div = document.createElement('div');
  div.className = 'msg ' + role + (msg.streaming ? ' streaming' : '');
  div.setAttribute('data-index', String(index));
  var meta = document.createElement('div');
  meta.className = 'meta';
  var roleLabel = document.createElement('span');
  roleLabel.className = 'role-label';
  roleLabel.textContent = isFuncResp ? t('toolResult') : (role === 'user' ? t('userLabel') : t('assistantLabel'));
  meta.appendChild(roleLabel);
  if (msg.model && !isFuncResp && role === 'assistant') {
    var model = document.createElement('span');
    model.className = 'model';
    model.textContent = msg.model;
    meta.appendChild(model);
  }
  var actions = document.createElement('span');
  actions.className = 'actions';
  if (!isFuncResp && (msg.role === 'user' || msg.role === 'assistant') && !msg.functionCall) {
    var editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.innerHTML = icon('pencil');
    editBtn.title = t('editMessage');
    editBtn.addEventListener('click', function () { editMessage(msg, index); });
    var copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.innerHTML = icon('copy');
    copyBtn.title = t('copy');
    copyBtn.addEventListener('click', function () { copyText(partsToText(msg.parts) || msg.content || ''); });
    actions.appendChild(editBtn);
    actions.appendChild(copyBtn);
    if (msg.role === 'assistant') {
      var rerollBtn = document.createElement('button');
      rerollBtn.className = 'icon-btn';
      rerollBtn.innerHTML = icon('refresh2');
      rerollBtn.title = t('reroll');
      rerollBtn.addEventListener('click', function () { rerollMessage(msg, index); });
      actions.appendChild(rerollBtn);
    }
    var delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.innerHTML = icon('trash');
    delBtn.title = t('deleteMessage');
    delBtn.addEventListener('click', function () { deleteMessageAt(index); });
    actions.appendChild(delBtn);
  }
  meta.appendChild(actions);
  div.appendChild(meta);
  var content = document.createElement('div');
  content.className = 'msg-content';
  if (isFuncResp) {
    var resp = msg.parts && msg.parts[0] && msg.parts[0].functionResponse;
    if (resp) {
      var respText = typeof resp.response === 'string' ? resp.response : JSON.stringify(resp.response || '');
      content.innerHTML = '<div class="tool-result">' + esc(respText.slice(0, 2000)) + '</div>';
    }
  } else {
    var thought = partsToThought(msg.parts);
    if (thought) {
      var thoughts = document.createElement('div');
      thoughts.className = 'thoughts';
      thoughts.textContent = thought;
      content.appendChild(thoughts);
    }
    var calls = partsToToolCalls(msg.parts);
    calls.forEach(function (call) {
      var chip = document.createElement('span');
      chip.className = 'tool-chip';
      chip.innerHTML = icon('sparkle', '') + '<span>' + esc(call.name) + '</span>';
      content.appendChild(chip);
    });
    var text = partsToText(msg.parts) || msg.content || '';
    if (text) {
      content.innerHTML += renderMarkdown(text);
    }
  }
  div.appendChild(content);
  return div;
}
function renderMessages() {
  var cur = activeTab();
  if (!cur) {
    $('messages').hidden = true;
    $('empty').hidden = false;
    $('empty-text').textContent = t('emptyConversation');
    return;
  }
  if (cur.messages.length === 0 && !cur.streaming) {
    $('messages').hidden = true;
    $('empty').hidden = false;
    $('empty-text').textContent = cur.id ? t('emptyMessages') : t('emptyNewChat');
    return;
  }
  $('empty').hidden = true;
  var listEl = $('messages');
  listEl.hidden = false;
  listEl.innerHTML = '';
  if (cur.hasMore) {
    var moreBtn = document.createElement('button');
    moreBtn.className = 'hist-more btn secondary';
    moreBtn.textContent = t('loadMore');
    moreBtn.addEventListener('click', function () { loadOlder(cur); });
    listEl.appendChild(moreBtn);
  }
  cur.messages.forEach(function (msg, i) {
    listEl.appendChild(buildMessage(msg, i));
  });
  if (cur.streaming) {
    var holder = document.createElement('div');
    holder.className = 'msg assistant streaming';
    holder.innerHTML = '<div class="meta"><span class="role-label">' + esc(t('assistantLabel')) + '</span>' +
      (cur.streamingModel ? '<span class="model">' + esc(cur.streamingModel) + '</span>' : '') + '</div>' +
      '<div class="msg-content"></div>';
    listEl.appendChild(holder);
  }
  if (cur.lastError) {
    var err = document.createElement('div');
    err.className = 'error-banner';
    err.innerHTML = '<b>' + esc(t('errorBanner')) + '</b>: ' + esc(cur.lastError.text);
    if (cur.lastError.retry) {
      var retryBtn = document.createElement('button');
      retryBtn.className = 'retry-btn';
      retryBtn.textContent = t('retry');
      retryBtn.addEventListener('click', function () { doRetry(); });
      err.appendChild(retryBtn);
    }
    listEl.appendChild(err);
  }
  scrollToBottom();
}
function scrollToBottom() {
  var el = $('messages');
  requestAnimationFrame(function () {
    el.scrollTop = el.scrollHeight;
  });
}
function loadMessages(tab, quiet) {
  if (!tab || !tab.id) return;
  tab.loading = true;
  api('/api/messages?conversationId=' + encodeURIComponent(tab.id) +
    '&limit=' + MSG_PAGE_SIZE + '&offset=' + tab.offset)
    .then(function (data) {
      if (tabByKey(tab.key) !== tab) return;
      tab.total = data.total || 0;
      tab.hasMore = !!data.hasMore;
      var msgs = Array.isArray(data.messages) ? data.messages : [];
      /* 自尾端开窗：offset 只增不减；每批替换为「更早消息 + 当前窗口」 */
      if (tab.offset === 0) {
        tab.messages = msgs;
      } else {
        var seen = {};
        tab.messages.forEach(function (m, i) { seen[i] = true; });
        var known = tab.messages.slice();
        var fresh = [];
        msgs.forEach(function (m) {
          var key = (m.role || '') + '|' + (partsToText(m.parts) || m.content || '').slice(0, 40);
          if (!seen[key]) fresh.push(m);
        });
        tab.messages = fresh.concat(known);
      }
      if (tab.key === state.activeTabKey) renderMessages();
    })
    .catch(function () {
      if (tabByKey(tab.key) !== tab) return;
      tab.lastError = { text: t('loadFailed'), retry: false };
      if (tab.key === state.activeTabKey) renderMessages();
    })
    .then(function () {
      tab.loading = false;
    });
}
function loadOlder(tab) {
  if (!tab || !tab.id || !tab.hasMore || tab.loading) return;
  tab.offset += MSG_PAGE_SIZE;
  loadMessages(tab, true);
}
function deleteMessageAt(index) {
  var tab = activeTab();
  if (!tab || !tab.id) return;
  openModal(t('deleteMessage'), null, t('deleteMessageConfirm'), t('renameCancel'), 'danger', function () {
    post('/api/delete-message', { conversationId: tab.id, targetIndex: index }).then(function () {
      toast(t('deleteMessageDone'));
      loadMessages(tab, true);
      loadConversations(true);
    }).catch(function (err) {
      toast(t('deleteMessageFailed') + ': ' + (err.message || ''));
    });
  });
}
function editMessage(msg, index) {
  var tab = activeTab();
  if (!tab || !tab.id) return;
  openModal(t('editMessage'), partsToText(msg.parts), t('editPlaceholder'), t('renameCancel'), 'textarea', function (value) {
    if (!value || !value.trim()) return;
    post('/api/edit-message', {
      conversationId: tab.id,
      messageId: msg.id || (msg.role + '-' + index),
      newText: value.trim()
    }).then(function () {
      toast(t('editBranching'));
      tab.pendingStreamId = null;
    }).catch(function (err) {
      toast(t('editFailed') + ': ' + (err.message || ''));
    });
  });
}
function rerollMessage(msg, index) {
  var tab = activeTab();
  if (!tab || !tab.id) return;
  post('/api/reroll', {
    conversationId: tab.id,
    assistantNodeId: msg.id || ('assistant-' + index)
  }).then(function () {
    toast(t('reroll') + '…');
  }).catch(function (err) {
    toast(t('rerollFailed') + ': ' + (err.message || ''));
  });
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      toast(t('copied'));
    }).catch(function () {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast(t('copied')); } catch (e) {}
  document.body.removeChild(ta);
}

/* ============================================================
   工具审批
   ============================================================ */
function renderConfirmBar() {
  var cur = activeTab();
  var bar = $('confirm-bar');
  bar.innerHTML = '';
  if (!cur || cur.pendingTools.length === 0) return;
  var inner = document.createElement('div');
  inner.className = 'confirm-inner';
  var title = document.createElement('div');
  title.className = 'confirm-title';
  title.innerHTML = icon('warning', '') + '<span>' + esc(t('awaitingApproval')) + '</span>';
  inner.appendChild(title);
  cur.pendingTools.forEach(function (tool) {
    var row = document.createElement('div');
    row.className = 'confirm-tool';
    row.innerHTML = '<span class="tname">' + esc(tool.name || tool.id || '') + '</span>';
    inner.appendChild(row);
  });
  var actions = document.createElement('div');
  actions.className = 'confirm-actions';
  var rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn secondary';
  rejectBtn.textContent = t('reject');
  rejectBtn.addEventListener('click', function () { toolConfirm(false); });
  var approveBtn = document.createElement('button');
  approveBtn.className = 'btn';
  approveBtn.textContent = t('approve');
  approveBtn.addEventListener('click', function () { toolConfirm(true); });
  actions.appendChild(rejectBtn);
  actions.appendChild(approveBtn);
  inner.appendChild(actions);
  bar.appendChild(inner);
}
function toolConfirm(confirmed) {
  var tab = activeTab();
  if (!tab || tab.pendingTools.length === 0 || tab.confirmInFlight) return;
  tab.confirmInFlight = true;
  var responses = tab.pendingTools.map(function (tool) {
    return { id: tool.id || tool.toolCallId || '', name: tool.name || tool.id || '', confirmed: confirmed };
  });
  post('/api/tool-confirm', { conversationId: tab.id, toolResponses: responses })
    .then(function () {
      tab.pendingTools = [];
      tab.confirmInFlight = false;
      renderConfirmBar();
      toast(confirmed ? t('toolApproved') : t('toolRejected'));
    })
    .catch(function (err) {
      tab.confirmInFlight = false;
      toast(t('toolConfirmFailed') + ': ' + (err.message || ''));
    });
}

/* ============================================================
   发送 / 停止 / 重试
   ============================================================ */
function renderSendIcon() {
  var cur = activeTab();
  var btn = $('send');
  btn.innerHTML = cur && cur.streaming ? ICON_STOP : ICON_SEND;
  btn.classList.toggle('stop', !!(cur && cur.streaming));
}
function canSend() {
  var cur = activeTab();
  if (!cur) return false;
  if (cur.streaming) return false;
  return $('input').value.trim().length > 0;
}
function updateSendBtn() {
  var btn = $('send');
  btn.disabled = !canSend();
}
function doSend() {
  var cur = activeTab();
  if (!cur || cur.streaming || cur.sendInFlight) return;
  var text = $('input').value.trim();
  if (!text) return;
  cur.sendInFlight = true;
  var payload = { text: text };
  if (cur.id) payload.conversationId = cur.id;
  /* 输入区选择器：渠道 / 模型覆盖 / 模型模式透传（与桌面端 chatStream 同参数） */
  if (state.activeChannelId) payload.configId = state.activeChannelId;
  if (state.selectedModelId) payload.modelId = state.selectedModelId;
  if (state.currentModeId) payload.promptModeId = state.currentModeId;
  post('/api/send', payload)
    .then(function (data) {
      cur.sendInFlight = false;
      if (data.conversationId && !cur.id) {
        cur.id = data.conversationId;
        cur.pendingStreamId = data.streamId || null;
        renderTabsBar();
        /* 竞态窗口内已到达的孤儿 chunk 立即补发（SSE chunk 先于 POST 响应到达时） */
        flushOrphanStream(data.streamId, cur);
      }
      /* 立即清空输入并回显用户消息（流式完成后服务端落盘，UI 先行） */
      $('input').value = '';
      autoGrowInput();
      updateSendBtn();
      var optimistic = {
        role: 'user',
        parts: [{ text: text }],
        content: text
      };
      cur.messages.push(optimistic);
      if (cur.key === state.activeTabKey) renderMessages();
      setStreaming(cur, true, '');
      loadConversations(true);
    })
    .catch(function (err) {
      cur.sendInFlight = false;
      cur.lastError = { text: (err.message || t('sendFailed')), retry: true };
      if (cur.key === state.activeTabKey) renderMessages();
      toast(t('sendFailed') + ': ' + (err.message || ''));
    });
}
function doStop() {
  var cur = activeTab();
  if (!cur || !cur.streaming) return;
  if (cur.id) {
    post('/api/cancel', { conversationId: cur.id }).catch(function () {});
  }
  cur.streaming = false;
  cur.streamingText = '';
  cur.pendingTools = [];
  renderConfirmBar();
  renderSendIcon();
  updateSendBtn();
  toast(t('streamInterrupted'));
}
function doRetry() {
  var cur = activeTab();
  if (!cur || !cur.id || cur.streaming) return;
  cur.lastError = null;
  cur.streaming = false;
  post('/api/retry', { conversationId: cur.id }).then(function () {
    setStreaming(cur, true, '');
    renderMessages();
  }).catch(function (err) {
    cur.lastError = { text: t('retryFailed') + ': ' + (err.message || ''), retry: true };
    renderMessages();
  });
}

/* ============================================================
   SSE 流式（多会话并行）
   ============================================================ */
function connectStream() {
  if (state.evtSource) return;
  var es;
  try { es = new EventSource('/api/stream'); } catch (e) { retryConnect(); return; }
  state.evtSource = es;
  es.onopen = function () {
    state.serverStopped = false;
    state.connected = true;
    var cur = activeTab();
    setStatus(cur && cur.streaming ? 'busy' : 'ok',
      cur && cur.streaming ? t('statusStreaming') : t('statusConnected'));
  };
  es.addEventListener('hello', function (ev) {
    try {
      var info = JSON.parse(ev.data);
      state.statusInfo = info;
      state.activeChannelId = info.activeChannelId || state.activeChannelId || null;
      applyWorkspaceInfo(info);
      renderComposerMeta();
      if (info.activeConversationId && state.tabs.length === 0) {
        var tab = newTabObject(info.activeConversationId, info.activeConversationTitle || '');
        state.tabs.push(tab);
        state.activeTabKey = tab.key;
        renderTabsBar();
        setTitle(tab.title);
        loadMessages(tab, true);
      }
      loadConversations(true);
    } catch (e) {}
  });
  es.addEventListener('message', function (ev) { handleStreamMessage(ev.data); });
  es.addEventListener('global', function (ev) { handleStreamMessage(ev.data); });
  es.addEventListener('workspace', function (ev) {
    try { applyWorkspaceInfo(JSON.parse(ev.data)); } catch (e) {}
  });
  /* 会话列表变更（远端/桌面端新建、改名、删除）：实时刷新，无需重启 */
  es.addEventListener('conversations', function () {
    loadConversations(true);
  });
  es.addEventListener('bye', function () {
    state.serverStopped = true;
    es.close();
    state.evtSource = null;
    state.connected = false;
    resetAllStreaming();
    setStatus('err', t('statusServerStopped'));
    $('send').disabled = true;
  });
  es.onerror = function () {
    if (state.serverStopped) return;
    es.close();
    state.evtSource = null;
    state.connected = false;
    resetAllStreaming();
    setStatus('err', t('statusReconnecting'));
    retryConnect();
  };
}
function resetAllStreaming() {
  var changed = false;
  state.tabs.forEach(function (tab) {
    if (tab.streaming || tab.pendingTools.length) {
      tab.streaming = false;
      tab.streamingText = '';
      tab.pendingTools = [];
      changed = true;
    }
  });
  if (changed) {
    renderTabsBar();
    renderConfirmBar();
    renderMessages();
    renderSendIcon();
    updateSendBtn();
  }
}
function retryConnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(connectStream, 2000);
}
function handleStreamMessage(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || !msg.type) return;
  var d = msg.data || {};
  if (msg.type === 'streamChunk' || msg.type === 'streamChunkBatch') {
    var chunks = Array.isArray(d) ? d : [d];
    var first = chunks[0] || {};
    var convId = msg.conversationId || first.conversationId || '';
    var streamId = msg.streamId || first.streamId || '';
    var tab = tabByConvId(convId) || tabByStreamId(streamId);
    if (!tab) {
      if (streamId) {
        var buf = orphanStreams[streamId];
        if (!buf) {
          if (Object.keys(orphanStreams).length >= ORPHAN_STREAM_MAX) {
            var firstKey = null;
            for (var k in orphanStreams) { firstKey = k; break; }
            if (firstKey) delete orphanStreams[firstKey];
          }
          buf = { convId: convId, chunks: [] };
          orphanStreams[streamId] = buf;
        }
        if (buf.chunks.length < ORPHAN_CHUNK_MAX) {
          buf.chunks = buf.chunks.concat(chunks);
        }
      }
      return;
    }
    if (tab.id !== convId && convId && !tabByConvId(convId)) {
      tab.id = convId;
      tab.pendingStreamId = null;
      renderTabsBar();
    }
    var buffered = streamId && orphanStreams[streamId];
    if (buffered && buffered.chunks.length) {
      chunks = buffered.chunks.concat(chunks);
      delete orphanStreams[streamId];
    }
    chunks.forEach(function (c) { processChunk(c, tab); });
    return;
  }
  if (msg.type === 'error') {
    var tab2 = tabByConvId(msg.conversationId || (d && d.conversationId)) || activeTab();
    if (!tab2) return;
    if (!tab2.streaming) {
      var errText = (d.error && (d.error.message || d.error)) || d.message || t('loadFailed');
      tab2.lastError = { text: errText, retry: !!tab2.id };
      if (tab2.key === state.activeTabKey) renderMessages();
    }
  }
}
function tabByStreamId(streamId) {
  if (!streamId) return null;
  for (var i = 0; i < state.tabs.length; i++) {
    if (state.tabs[i].pendingStreamId === streamId) return state.tabs[i];
  }
  return null;
}
/** 新建会话 POST 响应到达：flush 竞态窗口内的孤儿 chunk 到对应页签 */
function flushOrphanStream(streamId, tab) {
  if (!streamId || !tab) return;
  var buf = orphanStreams[streamId];
  if (buf && buf.chunks.length) {
    delete orphanStreams[streamId];
    buf.chunks.forEach(function (c) { processChunk(c, tab); });
  }
}
function setStreaming(tab, on, model) {
  tab.streaming = on;
  if (model) tab.streamingModel = model;
  if (!on) tab.streamingText = '';
  renderTabsBar();
  renderSendIcon();
  updateSendBtn();
  var cur = activeTab();
  setStatus(on ? 'busy' : 'ok', on ? t('statusStreaming') : t('statusConnected'));
  if (cur === tab && cur.key === state.activeTabKey) {
    if (on) renderMessages();
  }
}
function renderStreamingText() {
  var tab = activeTab();
  if (!tab || !tab.streaming) return;
  var holders = $('messages').querySelectorAll('.msg.assistant.streaming');
  var last = holders[holders.length - 1];
  if (last) {
    var contentEl = last.querySelector('.msg-content');
    contentEl.innerHTML = (tab.streamingText ? renderMarkdown(tab.streamingText) : '') + '<span class="caret"></span>';
  }
  scrollToBottom();
}
function processChunk(c, tab) {
  if (!c || !c.type) return;
  var type = c.type;
  if (type === 'chunk' && typeof c.chunk === 'string') {
    if (!tab.streaming) setStreaming(tab, true, '');
    tab.streamingText += c.chunk;
    if (tab.key === state.activeTabKey) renderStreamingText();
    return;
  }
  if (type === 'complete') {
    if (tab.streaming) { tab.streamingText = c.content || tab.streamingText; setStreaming(tab, false); }
    tab.pendingTools = [];
    tab.lastError = null;
    renderConfirmBar();
    loadMessages(tab, true);
    loadConversations(true);
    return;
  }
  if (type === 'cancelled') {
    if (tab.streaming) { tab.streamingText = c.content || tab.streamingText; setStreaming(tab, false); }
    tab.pendingTools = [];
    tab.lastError = null;
    renderConfirmBar();
    toast(t('streamInterrupted'));
    loadMessages(tab, true);
    return;
  }
  if (type === 'error') {
    if (tab.streaming) setStreaming(tab, false);
    var errMsg = (c.error && (c.error.message || c.error)) || t('loadFailed');
    tab.lastError = { text: errMsg, retry: false };
    if (tab.key === state.activeTabKey) renderMessages();
    loadMessages(tab, true);
    return;
  }
  if (type === 'toolsExecuting' || type === 'toolIteration') {
    if (!tab.streaming) setStreaming(tab, true, '');
    tab.pendingTools = [];
    renderConfirmBar();
    return;
  }
  if (type === 'toolStatus') {
    /* 工具状态（执行中/完成）：保持流式光标，不打断输出 */
    if (!tab.streaming) setStreaming(tab, true, '');
    tab.pendingTools = [];
    renderConfirmBar();
    return;
  }
  if (type === 'checkpoints' || type === 'autoSummaryStatus' || type === 'autoSummary') {
    /* 检查点/自动总结：无移动端专用 UI，保持流式状态即可（终结事件仍由 complete 处理） */
    return;
  }
  if (type === 'awaitingConfirmation') {
    if (!tab.streaming) setStreaming(tab, true, '');
    tab.pendingTools = Array.isArray(c.pendingToolCalls) ? c.pendingToolCalls : [];
    renderConfirmBar();
    return;
  }
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
    $('ws-bar-name').textContent = state.workspaceName || t('noWorkspace');
    $('ws-bar-file').textContent = state.activeFilePath ? t('activeFile') + ': ' + state.activeFilePath : '';
    state.fileDirs = {};
    state.currentFile = null;
    if (isTab('files')) {
      $('file-viewer').hidden = true;
      $('file-tree').hidden = false;
      loadFiles('', true);
    }
  }
}

/* ============================================================
   输入区四选择器（桌面端 InputSelectorBar 同款：模式/渠道/模型/思考强度）
   ============================================================ */
function renderComposerMeta() {
  var el = $('composer-meta');
  el.innerHTML = '';
  el.appendChild(buildModeChip());
  el.appendChild(buildChannelChip());
  el.appendChild(buildModelChip());
  el.appendChild(buildThinkingChip());
}
function selChip(label, value, onClick) {
  var btn = document.createElement('button');
  btn.className = 'sel-chip';
  btn.innerHTML = '<span class="sel-label">' + esc(label) + '</span>' +
    '<span class="sel-value">' + esc(value || '—') + '</span>' +
    icon('chevronDown', 'sel-arrow');
  btn.addEventListener('click', onClick);
  return btn;
}
function buildModeChip() {
  var mode = null;
  for (var i = 0; i < state.promptModes.length; i++) {
    if (state.promptModes[i].id === state.currentModeId) { mode = state.promptModes[i]; break; }
  }
  return selChip(t('selMode'), mode ? mode.name : (state.currentModeId || t('selModeDefault')), openModeSheet);
}
function buildChannelChip() {
  var cfg = null;
  for (var i = 0; i < state.configs.length; i++) {
    if (state.configs[i].id === state.activeChannelId) { cfg = state.configs[i]; break; }
  }
  return selChip(t('selChannel'), cfg ? (cfg.name || cfg.id) : t('selChannelNone'), openChannelSheet);
}
function buildModelChip() {
  var models = state.activeChannelId ? (state.configModels[state.activeChannelId] || []) : [];
  var modelName = state.selectedModelId || '';
  var cur = null;
  for (var i = 0; i < models.length; i++) {
    if (models[i].id === modelName) { cur = models[i]; break; }
  }
  return selChip(t('selModel'), cur ? (cur.name || cur.id) : (modelName || t('selModelAuto')), openModelSheet);
}
function buildThinkingChip() {
  return selChip(t('selThinking'), state.thinkingLevel || t('selThinkingAuto'), openThinkingSheet);
}
/* 底部弹层通用打开 */
function openSheet(title, buildList) {
  var el = $('sheet');
  $('sheet-title').textContent = title;
  var list = $('sheet-list');
  list.innerHTML = '';
  buildList(list);
  el.classList.add('open');
}
function closeSheet() {
  $('sheet').classList.remove('open');
}
function sheetItem(list, label, sub, selected, onClick) {
  var item = document.createElement('button');
  item.className = 'sheet-item' + (selected ? ' selected' : '');
  var labelEl = document.createElement('span');
  labelEl.textContent = label;
  item.appendChild(labelEl);
  if (sub) {
    var subEl = document.createElement('span');
    subEl.className = 'si-sub';
    subEl.textContent = sub;
    item.appendChild(subEl);
  }
  if (selected) {
    var check = document.createElement('span');
    check.className = 'si-check';
    check.innerHTML = icon('check');
    item.appendChild(check);
  }
  item.addEventListener('click', function () { closeSheet(); onClick(); });
  list.appendChild(item);
}
function openModeSheet() {
  openSheet(t('selModeTitle'), function (list) {
    if (state.promptModes.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'sheet-hint';
      hint.textContent = t('loadFailed');
      list.appendChild(hint);
      return;
    }
    state.promptModes.forEach(function (mode) {
      sheetItem(list, mode.name || mode.id, mode.id, mode.id === state.currentModeId, function () {
        state.currentModeId = mode.id;
        renderComposerMeta();
      });
    });
  });
}
function openChannelSheet() {
  openSheet(t('selChannelTitle'), function (list) {
    if (state.configs.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'sheet-hint';
      hint.textContent = t('noConfigs');
      list.appendChild(hint);
      return;
    }
    state.configs.forEach(function (cfg) {
      sheetItem(list, cfg.name || cfg.id, cfg.model || '', cfg.id === state.activeChannelId, function () {
        state.activeChannelId = cfg.id;
        state.selectedModelId = null;
        state.configModels[cfg.id] = state.configModels[cfg.id] || [];
        renderComposerMeta();
        loadConfigModels(cfg.id);
      });
    });
  });
}
function openModelSheet() {
  var models = state.activeChannelId ? (state.configModels[state.activeChannelId] || []) : [];
  openSheet(t('selModelTitle'), function (list) {
    if (!state.activeChannelId) {
      var hint = document.createElement('div');
      hint.className = 'sheet-hint';
      hint.textContent = t('noConfigs');
      list.appendChild(hint);
      return;
    }
    if (models.length === 0) {
      var hint2 = document.createElement('div');
      hint2.className = 'sheet-hint';
      hint2.textContent = t('noModels');
      list.appendChild(hint2);
      return;
    }
    var auto = document.createElement('div');
    auto.className = 'sheet-item' + (!state.selectedModelId ? ' selected' : '');
    auto.innerHTML = '<span>' + esc(t('selModelAuto')) + '</span>' +
      (!state.selectedModelId ? '<span class="si-check">' + icon('check') + '</span>' : '');
    auto.addEventListener('click', function () {
      closeSheet();
      state.selectedModelId = null;
      renderComposerMeta();
    });
    list.appendChild(auto);
    models.forEach(function (m) {
      sheetItem(list, m.name || m.id, m.id, m.id === state.selectedModelId, function () {
        state.selectedModelId = m.id;
        renderComposerMeta();
      });
    });
  });
}
function openThinkingSheet() {
  openSheet(t('selThinkingTitle'), function (list) {
    if (state.thinkingOptions.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'sheet-hint';
      hint.textContent = t('noData');
      list.appendChild(hint);
      return;
    }
    state.thinkingOptions.forEach(function (opt) {
      sheetItem(list, opt.label, '', opt.value === state.thinkingLevel, function () {
        setThinkingLevel(opt.value);
      });
    });
  });
}
/* 思考强度选项（与桌面端 ThinkingSelector 同源：按渠道类型） */
function thinkingOptionsFor(type) {
  if (type === 'openai' || type === 'openai-responses') {
    return [
      { value: 'off', label: 'Off' }, { value: 'none', label: 'none' },
      { value: 'minimal', label: 'minimal' }, { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' }, { value: 'max', label: 'max' },
      { value: 'ultra', label: 'ultra' }, { value: 'custom', label: 'custom' }
    ];
  }
  if (type === 'anthropic') {
    return [
      { value: 'off', label: 'Off' }, { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' }, { value: 'max', label: 'max' },
      { value: 'ultra', label: 'ultra' }, { value: 'custom', label: 'custom' }
    ];
  }
  if (type === 'gemini') {
    return [
      { value: 'off', label: 'Off' }, { value: 'minimal', label: 'minimal' },
      { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' }
    ];
  }
  return [];
}
function currentThinkingOf(cfg) {
  if (!cfg || !cfg.type) return 'off';
  var optionsEnabled = cfg.optionsEnabled || {};
  var options = cfg.options || {};
  if (cfg.type === 'openai' || cfg.type === 'openai-responses') {
    if (!optionsEnabled.reasoning) return 'off';
    return (options.reasoning && options.reasoning.effort) || 'high';
  }
  if (cfg.type === 'anthropic') {
    if (!optionsEnabled.thinking) return 'off';
    var thinking = options.thinking || {};
    if (thinking.type === 'disabled') return 'off';
    return thinking.effort || 'high';
  }
  if (cfg.type === 'gemini') {
    if (optionsEnabled.thinkingConfig === false) return 'off';
    var tc = options.thinkingConfig || {};
    if (tc.includeThoughts === false) return 'off';
    if (tc.mode === 'level') return tc.thinkingLevel || 'medium';
    return 'medium';
  }
  return 'off';
}
function buildThinkingUpdates(cfg, level) {
  if (!cfg || !cfg.type) return null;
  var type = cfg.type;
  var options = cfg.options || {};
  var optionsEnabled = cfg.optionsEnabled || {};
  if (type === 'openai' || type === 'openai-responses') {
    var current = options.reasoning || {};
    var defaults = { effort: 'high', summaryEnabled: false, summary: 'auto' };
    if (level === 'off') {
      return { optionsEnabled: Object.assign({}, optionsEnabled, { reasoning: false }) };
    }
    return {
      optionsEnabled: Object.assign({}, optionsEnabled, { reasoning: true }),
      options: Object.assign({}, options, {
        reasoning: Object.assign({}, defaults, current, { effort: level })
      })
    };
  }
  if (type === 'anthropic') {
    var cur = options.thinking || {};
    if (level === 'off') {
      return {
        optionsEnabled: Object.assign({}, optionsEnabled, { thinking: true }),
        options: Object.assign({}, options, { thinking: Object.assign({}, cur, { type: 'disabled' }) })
      };
    }
    return {
      optionsEnabled: Object.assign({}, optionsEnabled, { thinking: true }),
      options: Object.assign({}, options, { thinking: Object.assign({}, cur, { type: 'adaptive', effort: level }) })
    };
  }
  if (type === 'gemini') {
    var cur2 = options.thinkingConfig || {};
    if (level === 'off') {
      return {
        optionsEnabled: Object.assign({}, optionsEnabled, { thinkingConfig: true }),
        options: Object.assign({}, options, { thinkingConfig: Object.assign({}, cur2, { includeThoughts: false }) })
      };
    }
    return {
      optionsEnabled: Object.assign({}, optionsEnabled, { thinkingConfig: true }),
      options: Object.assign({}, options, {
        thinkingConfig: Object.assign({}, cur2, { includeThoughts: true, mode: 'level', thinkingLevel: level })
      })
    };
  }
  return null;
}
function setThinkingLevel(level) {
  if (!state.activeChannelId) return;
  var cfg = null;
  for (var i = 0; i < state.configs.length; i++) {
    if (state.configs[i].id === state.activeChannelId) { cfg = state.configs[i]; break; }
  }
  var updates = buildThinkingUpdates(cfg, level);
  if (!updates) return;
  post('/api/config-update', { configId: state.activeChannelId, updates: updates })
    .then(function () {
      state.thinkingLevel = level;
      renderComposerMeta();
      toast(t('settingsSaved'));
      loadConfigs();
    })
    .catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
}
function loadConfigs() {
  return api('/api/configs').then(function (data) {
    state.configs = Array.isArray(data.configs) ? data.configs : [];
    /* 渠道列表现已携带 type/options/optionsEnabled（V2），思考强度直接可算 */
    syncThinkingState();
    renderComposerMeta();
    if (state.activeChannelId && !state.configModels[state.activeChannelId]) {
      loadConfigModels(state.activeChannelId);
    }
    return data;
  }).catch(function () {
    renderComposerMeta();
    return Promise.reject(new Error('configs'));
  });
}
function loadConfigModels(configId) {
  api('/api/config?configId=' + encodeURIComponent(configId))
    .then(function (data) {
      var cfg = data.config || {};
      var models = Array.isArray(cfg.models) ? cfg.models : [];
      state.configModels[configId] = models;
      syncThinkingFromConfig(configId, cfg);
      renderComposerMeta();
      if (state.settingsTab === 'channel') renderAllSettingsSections();
    })
    .catch(function () {});
}
/** 同步当前渠道的思考强度展示（读取渠道配置的真实值；列表已含 type/options） */
function syncThinkingState() {
  if (!state.activeChannelId) return;
  var cfg = null;
  for (var i = 0; i < state.configs.length; i++) {
    if (state.configs[i].id === state.activeChannelId) { cfg = state.configs[i]; break; }
  }
  if (!cfg) return;
  state.thinkingOptions = thinkingOptionsFor(cfg.type);
  state.thinkingLevel = currentThinkingOf(cfg);
  renderComposerMeta();
}
function syncThinkingFromConfig(configId, cfg) {
  if (configId !== state.activeChannelId || !cfg) return;
  state.thinkingOptions = thinkingOptionsFor(cfg.type);
  state.thinkingLevel = currentThinkingOf(cfg);
  renderComposerMeta();
}
function loadPromptModes() {
  api('/api/prompt-modes').then(function (data) {
    state.promptModes = Array.isArray(data.modes) ? data.modes : [];
    if (data.currentModeId && !state.currentModeId) {
      state.currentModeId = data.currentModeId;
    }
    if (state.promptModes.length > 0 && !state.currentModeId) {
      state.currentModeId = state.promptModes[0].id;
    }
    renderComposerMeta();
  }).catch(function () {});
}

/* ============================================================
   文件页
   ============================================================ */
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
    $('ws-bar-file').textContent = state.activeFilePath ? t('activeFile') + ': ' + state.activeFilePath : '';
    loadFiles('', true);
  } else if (name === 'settings') {
    renderSettingsTabs();
    renderAllSettingsSections();
    loadConfigs();
    if (!state.settings) {
      loadSettings();
      loadToolsList();
      loadDeps();
    }
  }
}
function renderFileTree(path, entries) {
  var root = $('file-tree');
  root.innerHTML = '';
  if (!state.workspaceUri && !state.workspaceName) {
    var hint = document.createElement('div');
    hint.className = 'conv-empty';
    hint.innerHTML = icon('folder', '') + '<div style="margin-top:8px">' + esc(t('noWorkspace')) + '</div>' +
      '<div style="font-size:12px;margin-top:4px">' + esc(t('noWorkspaceHint')) + '</div>';
    root.appendChild(hint);
    return;
  }
  if (path !== '') {
    var up = document.createElement('button');
    up.className = 'fdir-row';
    up.innerHTML = icon('folderUp', 'fico') + '<span class="fname">' + esc(t('back')) + ' · ' + esc(path) + '</span>';
    up.addEventListener('click', function () { state.fileDirs = {}; loadFiles('', true); });
    root.appendChild(up);
  } else {
    var home = document.createElement('button');
    home.className = 'fdir-row';
    home.innerHTML = icon('folder', 'fico') + '<span class="fname">' + esc(t('workspaceRoot')) + '</span>';
    root.appendChild(home);
  }
  (entries || []).forEach(function (entry) {
    var isDir = entry.type === 'directory';
    var row = document.createElement('button');
    row.className = 'fdir-row';
    row.innerHTML = (isDir ? icon('chevronRight', 'caret-svg') : '') +
      (isDir ? icon('folder', 'fico') : icon('file', 'fico')) +
      '<span class="fname">' + esc(entry.name) + '</span>' +
      (typeof entry.size === 'number' ? '<span class="fsize">' + fmtSize(entry.size) + '</span>' : '');
    row.addEventListener('click', function () {
      if (isDir) {
        state.fileDirs[path] = entries;
        loadFiles(entry.path, true);
      } else {
        openFile(entry.path);
      }
    });
    root.appendChild(row);
  });
}
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function loadFiles(path, quiet) {
  var q = path ? '?path=' + encodeURIComponent(path) : '';
  api('/api/files' + q).then(function (data) {
    renderFileTree(data.path || '', Array.isArray(data.entries) ? data.entries : []);
  }).catch(function (err) {
    if (!quiet) toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}
function openFile(path) {
  api('/api/file?path=' + encodeURIComponent(path)).then(function (data) {
    state.currentFile = { path: data.path || path, content: data.content || '', dirty: false, truncated: !!data.truncated };
    $('file-viewer-path').textContent = state.currentFile.path;
    $('file-editor').value = state.currentFile.content;
    $('file-editor').readOnly = state.currentFile.truncated;
    $('file-viewer-info').textContent = state.currentFile.truncated ? t('fileTooLarge') : fmtSize(state.currentFile.content.length);
    $('btn-save-file').disabled = true;
    $('btn-save-file').textContent = t('save');
    $('file-tree').hidden = true;
    $('file-viewer').hidden = false;
  }).catch(function (err) {
    toast(t('fileReadFailed') + ': ' + (err.message || ''));
  });
}
function saveFile() {
  if (!state.currentFile || state.currentFile.dirty === false) return;
  post('/api/file', { path: state.currentFile.path, content: state.currentFile.content })
    .then(function () {
      state.currentFile.dirty = false;
      $('btn-save-file').disabled = true;
      $('btn-save-file').textContent = t('save');
      toast(t('saved'));
    })
    .catch(function (err) {
      toast(t('saveFailed') + ': ' + (err.message || ''));
    });
}
function openOnDesktop() {
  if (!state.currentFile) return;
  post('/api/open-file', { path: state.currentFile.path }).then(function () {
    toast(t('openOnDesktop') + ' ✓');
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}
function loadWorkspaces() {
  api('/api/workspaces').then(function (data) {
    state.workspaces = data;
    renderWorkspaceSheet();
  }).catch(function () {});
}
function openWorkspaceSheet() {
  loadWorkspaces();
  $('sheet').classList.add('open');
  $('sheet-title').textContent = t('switchWorkspace');
  var list = $('sheet-list');
  list.innerHTML = '';
  list.innerHTML = '<div class="sheet-hint">' + esc(t('loading')) + '</div>';
}
function renderWorkspaceSheet() {
  var list = $('sheet-list');
  list.innerHTML = '';
  var data = state.workspaces || {};
  var openList = Array.isArray(data.workspaces) ? data.workspaces : [];
  var savedList = Array.isArray(data.saved) ? data.saved : [];
  openList.forEach(function (w) {
    sheetItem(list, w.name || w.uri || '', w.uri || '', (w.uri || '') === (data.activeWorkspaceUri || ''), function () {
      post('/api/workspace-switch', { workspaceUri: w.uri }).then(function () {
        toast(t('workspaceOpened'));
        closeSheet();
        state.fileDirs = {};
        state.currentFile = null;
        if (isTab('files')) { $('file-viewer').hidden = true; $('file-tree').hidden = false; loadFiles('', true); }
      }).catch(function (err) {
        toast(t('workspaceNotFound') + ': ' + (err.message || ''));
      });
    });
  });
  if (openList.length === 0 && savedList.length === 0) {
    var hint = document.createElement('div');
    hint.className = 'sheet-hint';
    hint.textContent = t('noWorkspace');
    list.appendChild(hint);
  }
}
function addWorkspace() {
  post('/api/workspace-add', {}).then(function (data) {
    if (data && data.canceled) return;
    toast(t('openFolderDialog'));
    closeSheet();
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}
function openBrowse() {
  $('sheet-list-mode').hidden = true;
  $('sheet-browse-mode').hidden = false;
  $('sheet').classList.add('open');
  $('sheet-title').textContent = t('browseTitle');
  loadFsDir('');
}
function closeBrowseMode() {
  $('sheet-browse-mode').hidden = true;
  $('sheet-list-mode').hidden = false;
}
function loadFsDir(rawPath) {
  if (state.browseBusy) return;
  state.browseBusy = true;
  var q = rawPath ? '?path=' + encodeURIComponent(rawPath) : '';
  api('/api/fs' + q).then(function (data) {
    state.browseBusy = false;
    state.browsePath = data.path || '';
    state.browseParent = data.parent || null;
    state.browseDrives = Array.isArray(data.drives) ? data.drives : [];
    $('browse-path').textContent = data.path || t('browseRootLabel');
    var list = $('browse-list');
    list.innerHTML = '';
    if (state.browseParent) {
      var up = document.createElement('button');
      up.className = 'fdir-row';
      up.innerHTML = icon('folderUp', 'fico') + '<span class="fname">' + esc(t('browseUp')) + '</span>';
      up.addEventListener('click', function () { loadFsDir(state.browseParent); });
      list.appendChild(up);
    }
    if (data.drives && data.drives.length) {
      var dl = document.createElement('div');
      dl.className = 'sheet-hint';
      dl.textContent = t('browseDrivesLabel');
      list.appendChild(dl);
      data.drives.forEach(function (drive) {
        var d = document.createElement('button');
        d.className = 'fdir-row';
        d.innerHTML = icon('folder', 'fico') + '<span class="fname">' + esc(drive) + '</span>';
        d.addEventListener('click', function () { loadFsDir(drive); });
        list.appendChild(d);
      });
    }
    (data.entries || []).forEach(function (entry) {
      var row = document.createElement('button');
      row.className = 'fdir-row';
      row.innerHTML = icon('folder', 'fico') + '<span class="fname">' + esc(entry.name) + '</span>';
      row.addEventListener('click', function () { loadFsDir(entry.path); });
      list.appendChild(row);
    });
    var pick = document.createElement('button');
    pick.className = 'btn';
    pick.style.margin = '10px 14px';
    pick.textContent = t('chooseThisFolder');
    pick.addEventListener('click', pickBrowseFolder);
    list.appendChild(pick);
  }).catch(function (err) {
    state.browseBusy = false;
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}
function pickBrowseFolder() {
  if (!state.browsePath || state.browseBusy) return;
  post('/api/workspace-add', { fsPath: state.browsePath }).then(function (data) {
    if (data && data.canceled) return;
    toast(t('workspaceOpened'));
    closeSheet();
    closeBrowseMode();
    state.currentFile = null;
    state.fileDirs = {};
    if (isTab('files')) { $('file-viewer').hidden = true; $('file-tree').hidden = false; loadFiles('', true); }
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}

/* ============================================================
   设置页（19 分类 + 渠道完整增删改）
   ============================================================ */
var SETTINGS_CATEGORIES = [
  { key: 'channel', labelKey: 'secChannel' },
  { key: 'general', labelKey: 'secGeneral' },
  { key: 'proxy', labelKey: 'secProxy' },
  { key: 'tools', labelKey: 'secTools' },
  { key: 'autoExec', labelKey: 'secAutoExec' },
  { key: 'fileTools', labelKey: 'secFileTools' },
  { key: 'sandbox', labelKey: 'secCommand' },
  { key: 'prompt', labelKey: 'secPrompt' },
  { key: 'context', labelKey: 'secContext' },
  { key: 'memory', labelKey: 'secMemory' },
  { key: 'summarize', labelKey: 'secSummarize' },
  { key: 'checkpoint', labelKey: 'secCheckpoint' },
  { key: 'tokenCount', labelKey: 'secTokenCount' },
  { key: 'imageGen', labelKey: 'secImageGen' },
  { key: 'skills', labelKey: 'secSkills' },
  { key: 'subagents', labelKey: 'secSubagents' },
  { key: 'pinned', labelKey: 'secPinned' },
  { key: 'remoteControl', labelKey: 'secRemote' },
  { key: 'storage', labelKey: 'secStorage' },
  { key: 'dependencies', labelKey: 'secDeps' }
];
function renderSettingsTabs() {
  var bar = $('settings-tabs');
  bar.innerHTML = '';
  SETTINGS_CATEGORIES.forEach(function (cat) {
    var btn = document.createElement('button');
    btn.className = 'set-tab' + (cat.key === state.settingsTab ? ' active' : '');
    btn.textContent = t(cat.labelKey);
    btn.addEventListener('click', function () {
      state.settingsTab = cat.key;
      renderSettingsTabs();
      renderAllSettingsSections();
    });
    bar.appendChild(btn);
  });
}
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
function patchFor(p, v) {
  var patch = {};
  setVal(patch, p, v);
  return patch;
}
function saveSettingsPatch(patch, extra) {
  state.settingsBusy = true;
  post('/api/settings', { settings: patch }).then(function (data) {
    state.settings = data.settings || state.settings;
    if (extra) extra(data.settings);
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
  $('settings-sections').appendChild(card);
  return card;
}
function renderField(sec, f) {
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
    ctl.appendChild(wrap);
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
    ctl.appendChild(sel);
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
    ctl.appendChild(sel2);
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
    ctl.appendChild(num);
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
    ctl.appendChild(ta);
    ta.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, ta.value));
    });
  } else if (f.w === 'chips') {
    var wrap2 = document.createElement('div');
    wrap2.className = 'chips';
    var values = Array.isArray(value) ? value : [];
    values.forEach(function (v, i) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = v;
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.addEventListener('click', function () {
        var next = values.slice();
        next.splice(i, 1);
        saveSettingsPatch(patchFor(f.p, next));
      });
      chip.appendChild(rm);
      wrap2.appendChild(chip);
    });
    var addRow = document.createElement('div');
    addRow.className = 'chip-input';
    var input2 = document.createElement('input');
    input2.type = 'text';
    input2.placeholder = t('chipsHint');
    var btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.textContent = t('chipAdd');
    btn.type = 'button';
    function addChip() {
      var v = input2.value.trim();
      if (!v || values.indexOf(v) >= 0) return;
      saveSettingsPatch(patchFor(f.p, values.concat([v])));
    }
    btn.addEventListener('click', addChip);
    input2.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addChip(); }
    });
    addRow.appendChild(input2);
    addRow.appendChild(btn);
    wrap2.appendChild(addRow);
    ctl.appendChild(wrap2);
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
    ctl.appendChild(inp);
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
  var card = secCard('secTools');
  if (!state.tools || state.tools.length === 0) {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noData');
    card.appendChild(none);
  } else {
    state.tools.forEach(function (tool) {
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
  [
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
  ].forEach(function (f) { renderField(card, f); });
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
    card.appendChild(row);
  });
}
function renderSubagentsSection() {
  var card = secCard('secSubagents');
  [
    { t: 'fldSubMaxConcurrent', p: ['toolsConfig', 'subagents', 'maxConcurrent'], w: 'number', min: 1 },
    { t: 'fldSubFailureMode', p: ['toolsConfig', 'subagents', 'failureMode'], w: 'select', o: ['abort', 'continue'] },
    { t: 'fldSubGeneralWorker', p: ['toolsConfig', 'subagents', 'enableGeneralWorker'], w: 'toggle' },
    { t: 'fldSubDefaultIterations', p: ['toolsConfig', 'subagents', 'defaultMaxIterations'], w: 'number', min: 1 },
    { t: 'fldSubDefaultRuntime', p: ['toolsConfig', 'subagents', 'defaultMaxRuntimeSeconds'], w: 'number', min: 1 }
  ].forEach(function (f) { renderField(card, f); });
}
function renderPinnedSection() {
  var card = secCard('secPinned');
  [
    { t: 'fldPinnedAdd', p: ['toolsConfig', 'pinned_files', 'pinnedFiles'], w: 'chips' }
  ].forEach(function (f) { renderField(card, f); });
}
function renderRemoteSection() {
  var card = secCard('secRemote');
  var info = state.statusInfo || {};
  var rows = [
    { k: t('connection'), v: info.running ? t('running') : t('stopped') },
    { k: t('port'), v: String(info.port != null ? info.port : '') },
    { k: t('appVersion'), v: state.appVersion || '' }
  ];
  rows.forEach(function (row) {
    var r = document.createElement('div');
    r.className = 'set-row';
    r.innerHTML = '<span>' + esc(row.k) + '</span><span style="color:var(--vscode-descriptionForeground)">' + esc(row.v) + '</span>';
    card.appendChild(r);
  });
  var urls = Array.isArray(info.urls) ? info.urls : [];
  if (urls.length > 0) {
    var u = document.createElement('div');
    u.className = 'set-row';
    u.innerHTML = '<span>' + esc(t('accessUrls')) + '</span>';
    card.appendChild(u);
    urls.forEach(function (url) {
      var chip = document.createElement('button');
      chip.className = 'chip';
      chip.style.cursor = 'pointer';
      chip.textContent = url;
      chip.addEventListener('click', function () { copyText(url); });
      card.appendChild(chip);
    });
  }
  var note = document.createElement('div');
  note.className = 'set-note';
  note.style.marginTop = '8px';
  note.textContent = t('securityText');
  card.appendChild(note);
  var actions = document.createElement('div');
  actions.className = 'sheet-actions';
  actions.style.padding = '10px 0 0';
  var restart = document.createElement('button');
  restart.className = 'btn';
  restart.textContent = t('fldRcRestart');
  restart.addEventListener('click', function () {
    post('/api/remote-action', { type: 'restart' }).then(function () { toast(t('fldRcRestart') + ' ✓'); }).catch(function (err) { toast(t('settingsFailed') + ': ' + (err.message || '')); });
  });
  var stop = document.createElement('button');
  stop.className = 'btn danger';
  stop.textContent = t('fldRcStop');
  stop.addEventListener('click', function () {
    post('/api/remote-action', { type: 'stop' }).then(function () { toast(t('fldRcStop') + ' ✓'); }).catch(function (err) { toast(t('settingsFailed') + ': ' + (err.message || '')); });
  });
  actions.appendChild(restart);
  actions.appendChild(stop);
  card.appendChild(actions);
}
function renderStorageSection() {
  var card = secCard('secStorage');
  [
    { t: 'fldStoragePath', p: ['storagePath', 'customDataPath'], w: 'text' }
  ].forEach(function (f) { renderField(card, f); });
  var note = document.createElement('div');
  note.className = 'set-note';
  note.textContent = t('fldMigration');
  card.appendChild(note);
}
function renderDepsSection() {
  var card = secCard('secDeps');
  if (!state.deps || state.deps.length === 0) {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noData');
    card.appendChild(none);
    return;
  }
  state.deps.forEach(function (dep) {
    var row = document.createElement('div');
    row.className = 'item-row';
    var td = document.createElement('div');
    td.className = 't';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = dep.name || '';
    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = dep.installedVersion || '';
    td.appendChild(name);
    td.appendChild(sub);
    row.appendChild(td);
    var tag = document.createElement('span');
    tag.className = 'chip';
    tag.style.color = dep.installed ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-terminal-ansiRed)';
    tag.textContent = dep.installed ? t('depInstalled') : t('depMissing');
    row.appendChild(tag);
    card.appendChild(row);
  });
}

/* ---------- 渠道管理（完整增删改） ---------- */
function renderConfigsCard() {
  var card = secCard('secChannel');
  var head = document.createElement('div');
  head.className = 'cfg-card-head';
  card.appendChild(head);
  if (state.configs.length === 0) {
    var none = document.createElement('div');
    none.className = 'info-text';
    none.textContent = t('noConfigs');
    card.appendChild(none);
  }
  state.configs.forEach(function (cfg) {
    var item = document.createElement('div');
    item.className = 'cfg-item';
    item.innerHTML = '<div class="cname">' + esc(cfg.name || cfg.id || '') + '</div>' +
      '<div class="cmodel">' + esc(t('currentModel')) + ': ' + esc(cfg.model || '—') + ' · ' + esc(cfg.type || '') + '</div>' +
      '<div class="mchips"><span class="info-text">' + esc(t('loading')) + '</span></div>';
    var ctrl = document.createElement('div');
    ctrl.className = 'item-row';
    ctrl.style.borderTop = '1px solid var(--vscode-widget-border)';
    ctrl.style.marginTop = '6px';
    var tag = document.createElement('span');
    tag.className = 't';
    tag.style.fontSize = '12px';
    var isActive = state.activeChannelId === cfg.id;
    tag.textContent = isActive ? t('activeChannel') : '';
    tag.style.color = isActive ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-descriptionForeground)';
    ctrl.appendChild(tag);
    ctrl.appendChild(itemToggle(cfg.enabled !== false, function (v) {
      cfg.enabled = v;
      toggleChannelEnabled(cfg);
    }));
    item.appendChild(ctrl);
    var actions = document.createElement('div');
    actions.className = 'cfg-actions';
    if (!isActive) {
      var act = document.createElement('button');
      act.className = 'mini-btn';
      act.textContent = t('setActiveChannel');
      act.addEventListener('click', function () { setChannelActive(cfg); });
      actions.appendChild(act);
    }
    var editBtn = document.createElement('button');
    editBtn.className = 'mini-btn';
    editBtn.textContent = t('editChannel');
    editBtn.addEventListener('click', function () { editChannel(cfg); });
    actions.appendChild(editBtn);
    var delBtn = document.createElement('button');
    delBtn.className = 'mini-btn danger';
    delBtn.textContent = t('deleteChannel');
    delBtn.addEventListener('click', function () {
      openModal(t('deleteChannel'), null, t('deleteChannelConfirm'), t('renameCancel'), 'danger', function () {
        deleteChannel(cfg);
      });
    });
    actions.appendChild(delBtn);
    item.appendChild(actions);
    card.appendChild(item);
    loadConfigModels(cfg.id);
  });
  var addBtn = document.createElement('button');
  addBtn.className = 'add-channel-btn';
  addBtn.innerHTML = icon('plus', '') + '<span>' + esc(t('addChannel')) + '</span>';
  addBtn.addEventListener('click', addChannelDialog);
  card.appendChild(addBtn);
}
function addChannelDialog() {
  var el = $('modal');
  $('modal-title').textContent = t('addChannel');
  var inputEl = $('modal-input');
  var bodyEl = $('modal-body');
  bodyEl.innerHTML = '';
  inputEl.hidden = true;
  var nameWrap = document.createElement('div');
  nameWrap.className = 'set-field';
  nameWrap.innerHTML = '<span class="k">' + esc(t('channelName')) + '</span>';
  var nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'My Channel';
  nameWrap.appendChild(nameInput);
  bodyEl.appendChild(nameWrap);
  var typeWrap = document.createElement('div');
  typeWrap.className = 'set-field';
  typeWrap.innerHTML = '<span class="k">' + esc(t('channelType')) + '</span>';
  var typeSel = document.createElement('select');
  [
    { v: 'gemini', label: 'Google Gemini' },
    { v: 'openai', label: 'OpenAI Compatible' },
    { v: 'openai-responses', label: 'OpenAI Responses API' },
    { v: 'anthropic', label: 'Anthropic Claude' }
  ].forEach(function (o) {
    var opt = document.createElement('option');
    opt.value = o.v;
    opt.textContent = o.label;
    typeSel.appendChild(opt);
  });
  typeWrap.appendChild(typeSel);
  bodyEl.appendChild(typeWrap);
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('createChannel');
  $('modal-ok').className = 'btn';
  el._onOk = function () {
    var name = nameInput.value.trim();
    if (!name) { toast(t('channelNameRequired')); return; }
    post('/api/config-create', { type: typeSel.value, name: name }).then(function (data) {
      toast(t('channelCreated'));
      loadConfigs();
      if (state.settingsTab === 'channel') renderAllSettingsSections();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  };
  el.classList.add('open');
  setTimeout(function () { nameInput.focus(); }, 60);
}
function editChannel(cfg) {
  var el = $('modal');
  $('modal-title').textContent = t('editChannel') + ': ' + (cfg.name || cfg.id);
  var inputEl = $('modal-input');
  var bodyEl = $('modal-body');
  bodyEl.innerHTML = '';
  inputEl.hidden = true;
  /* 表单字段（含高级设置） */
  var fields = [
    { key: 'name', label: t('channelName'), type: 'text', def: cfg.name || '' },
    { key: 'url', label: t('channelUrl'), type: 'text', def: '' },
    { key: 'apiKey', label: t('channelApiKey'), type: 'password', def: '' },
    { key: 'toolMode', label: t('channelToolMode'), type: 'select', options: ['function_call', 'xml', 'json'], def: '' },
    { key: 'timeout', label: t('channelTimeout'), type: 'number', def: '' },
    { key: 'maxContextTokens', label: t('channelMaxContext'), type: 'number', def: '' }
  ];
  var values = {};
  fields.forEach(function (f) {
    var wrap = document.createElement('div');
    wrap.className = 'set-field';
    wrap.innerHTML = '<span class="k">' + esc(f.label) + '</span>';
    var ctl = document.createElement('span');
    ctl.className = 'ctl';
    if (f.type === 'select') {
      var sel = document.createElement('select');
      f.options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        sel.appendChild(opt);
      });
      ctl.appendChild(sel);
      values[f.key] = sel;
    } else if (f.type === 'number') {
      var num = document.createElement('input');
      num.type = 'number';
      num.min = '0';
      ctl.appendChild(num);
      values[f.key] = num;
    } else {
      var inp = document.createElement('input');
      inp.type = f.type;
      if (f.type === 'password') inp.autocomplete = 'new-password';
      ctl.appendChild(inp);
      values[f.key] = inp;
    }
    wrap.appendChild(ctl);
    bodyEl.appendChild(wrap);
    loadChannelDetail(cfg.id, function (detail) {
      if (!detail) return;
      var apply = {};
      apply.name = detail.name || cfg.name || '';
      apply.url = detail.url || '';
      apply.apiKey = detail.apiKey || '';
      apply.toolMode = detail.toolMode || 'function_call';
      apply.timeout = detail.timeout != null ? String(detail.timeout) : '';
      apply.maxContextTokens = detail.maxContextTokens != null ? String(detail.maxContextTokens) : '';
      Object.keys(apply).forEach(function (k) {
        var ctlEl = values[k];
        if (ctlEl) {
          if (ctlEl.tagName === 'SELECT') ctlEl.value = apply[k] || 'function_call';
          else ctlEl.value = apply[k];
        }
      });
    });
  });
  /* 思考强度（渠道类型决定选项） */
  var thinkWrap = document.createElement('div');
  thinkWrap.className = 'set-field';
  thinkWrap.innerHTML = '<span class="k">' + esc(t('selThinking')) + '</span>';
  var thinkSel = document.createElement('select');
  var thinkCtl = document.createElement('span');
  thinkCtl.className = 'ctl';
  thinkCtl.appendChild(thinkSel);
  thinkWrap.appendChild(thinkCtl);
  bodyEl.appendChild(thinkWrap);
  var thinkingVal = 'off';
  loadChannelDetail(cfg.id, function (detail) {
    if (!detail) return;
    var opts = thinkingOptionsFor(detail.type);
    thinkSel.innerHTML = '';
    opts.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      thinkSel.appendChild(opt);
    });
    thinkingVal = currentThinkingOf(detail);
    thinkSel.value = thinkingVal;
    if (thinkSel.value === '') thinkSel.value = opts.length ? opts[0].value : 'off';
  });
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('saveChannel');
  $('modal-ok').className = 'btn';
  el._onOk = function () {
    var updates = {};
    var name = values.name.value.trim();
    if (name) updates.name = name;
    var url = values.url.value.trim();
    if (url) updates.url = url;
    var apiKey = values.apiKey.value.trim();
    if (apiKey) updates.apiKey = apiKey;
    if (values.toolMode.value) updates.toolMode = values.toolMode.value;
    if (values.timeout.value !== '') updates.timeout = Number(values.timeout.value);
    if (values.maxContextTokens.value !== '') updates.maxContextTokens = Number(values.maxContextTokens.value);
    var cfgLocal = cfg;
    loadChannelDetail(cfg.id, function (detail) {
      var thinkingUpdates = buildThinkingUpdates(Object.assign({}, cfgLocal, detail || {}), thinkSel.value || 'off');
      if (thinkingUpdates) {
        updates.options = thinkingUpdates.options;
        updates.optionsEnabled = thinkingUpdates.optionsEnabled;
      }
      post('/api/config-update', { configId: cfg.id, updates: updates }).then(function () {
        toast(t('channelSaved'));
        loadConfigs();
        if (state.settingsTab === 'channel') renderAllSettingsSections();
      }).catch(function (err) {
        toast(t('settingsFailed') + ': ' + (err.message || ''));
      });
    });
  };
  el.classList.add('open');
}
function loadChannelDetail(configId, cb) {
  api('/api/config?configId=' + encodeURIComponent(configId)).then(function (data) {
    cb(data.config || null);
  }).catch(function () { cb(null); });
}
function setChannelActive(cfg) {
  post('/api/channel-active', { configId: cfg.id }).then(function () {
    state.activeChannelId = cfg.id;
    toast(t('setActiveChannel') + ' ✓');
    loadConfigs();
    if (state.settingsTab === 'channel') renderAllSettingsSections();
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
function toggleChannelEnabled(cfg) {
  post('/api/channel-toggle', { configId: cfg.id, enabled: cfg.enabled !== false }).then(function () {
    toast((cfg.enabled !== false ? t('enable') : t('disable')) + ' ✓');
  }).catch(function (err) {
    cfg.enabled = !cfg.enabled;
    toast(t('settingsFailed') + ': ' + (err.message || ''));
    if (state.settingsTab === 'channel') renderAllSettingsSections();
  });
}
function deleteChannel(cfg) {
  post('/api/config-delete', { configId: cfg.id }).then(function () {
    toast(t('channelDeleted'));
    if (state.activeChannelId === cfg.id) state.activeChannelId = null;
    loadConfigs();
    if (state.settingsTab === 'channel') renderAllSettingsSections();
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}

/* ---------- 设置页总渲染 ---------- */
function renderAllSettingsSections() {
  var root = $('settings-sections');
  root.innerHTML = '';
  switch (state.settingsTab) {
    case 'channel':
      renderConfigsCard();
      break;
    case 'general':
      renderSimpleSection('secGeneral', [
        { t: 'fldCheckUpdates', p: ['checkForUpdates'], w: 'toggle' },
        { t: 'fldMaxToolIterations', p: ['maxToolIterations'], w: 'number', min: -1 },
        { t: 'fldDefaultToolMode', p: ['defaultToolMode'], w: 'select', o: ['function_call', 'xml', 'json'] }
      ]);
      renderSimpleSection('secUI', [
        { t: 'fldLanguage', p: ['ui', 'language'], w: 'select', o: ['auto', 'zh-CN', 'en', 'ja'] },
        { t: 'fldTheme', p: ['ui', 'theme'], w: 'select', o: ['auto', 'dark', 'light'] },
        { t: 'fldSmoothStreaming', p: ['ui', 'smoothStreaming'], w: 'toggle' },
        { t: 'fldSoundEnabled', p: ['ui', 'sound', 'enabled'], w: 'toggle' },
        { t: 'fldSoundVolume', p: ['ui', 'sound', 'volume'], w: 'number', min: 0, max: 100 }
      ]);
      break;
    case 'proxy':
      renderSimpleSection('secProxy', [
        { t: 'fldProxyEnabled', p: ['proxy', 'enabled'], w: 'toggle' },
        { t: 'fldProxyUrl', p: ['proxy', 'url'], w: 'text' },
        { t: 'fldProxyInsecure', p: ['proxy', 'insecureSkipTlsVerify'], w: 'toggle' }
      ]);
      break;
    case 'tools':
      renderToolsSections();
      break;
    case 'fileTools':
      renderSimpleSection('secFileTools', [
        { t: 'fldReadOutside', p: ['toolsConfig', 'read_file', 'allowOutsideWorkspace'], w: 'toggle' },
        { t: 'fldWriteOutside', p: ['toolsConfig', 'write_file', 'allowOutsideWorkspace'], w: 'toggle' },
        { t: 'fldApplyFormat', p: ['toolsConfig', 'apply_diff', 'format'], w: 'select', o: ['unified', 'diff'] },
        { t: 'fldApplyAutoSave', p: ['toolsConfig', 'apply_diff', 'autoSave'], w: 'toggle' },
        { t: 'fldApplyAutoSaveDelay', p: ['toolsConfig', 'apply_diff', 'autoSaveDelay'], w: 'number', min: 0 },
        { t: 'fldApplyGuard', p: ['toolsConfig', 'apply_diff', 'diffGuardEnabled'], w: 'toggle' },
        { t: 'fldApplyAutoApply', p: ['toolsConfig', 'apply_diff', 'autoApplyWithoutDiffView'], w: 'toggle' },
        { t: 'fldSearchExclude', p: ['toolsConfig', 'search_in_files', 'excludePatterns'], w: 'chips' }
      ]);
      break;
    case 'sandbox':
      renderSimpleSection('secCommand', [
        { t: 'fldCmdShell', p: ['toolsConfig', 'execute_command', 'defaultShell'], w: 'select', o: ['auto', 'cmd', 'powershell', 'bash'] },
        { t: 'fldCmdTimeout', p: ['toolsConfig', 'execute_command', 'defaultTimeoutMs'], w: 'number', min: 0, step: 1000 },
        { t: 'fldSandboxEnabled', p: ['toolsConfig', 'sandbox', 'enabled'], w: 'toggle' },
        { t: 'fldSandboxLangs', p: ['toolsConfig', 'sandbox', 'allowedLanguages'], w: 'chips' }
      ]);
      break;
    case 'prompt':
      renderSimpleSection('secPrompt', [
        { t: 'fldPromptMode', p: ['toolsConfig', 'system_prompt', 'mode'], w: 'promptMode' },
        { t: 'fldPromptPrefix', p: ['toolsConfig', 'system_prompt', 'customPrefix'], w: 'textarea' },
        { t: 'fldPromptSuffix', p: ['toolsConfig', 'system_prompt', 'customSuffix'], w: 'textarea' },
        { t: 'fldPromptDynamicEnabled', p: ['toolsConfig', 'system_prompt', 'dynamicContextEnabled'], w: 'toggle' },
        { t: 'fldPromptDynamic', p: ['toolsConfig', 'system_prompt', 'dynamicContextTemplate'], w: 'textarea' }
      ]);
      break;
    case 'context':
      renderSimpleSection('secContext', [
        { t: 'fldCtxFiles', p: ['toolsConfig', 'context_awareness', 'includeWorkspaceFiles'], w: 'toggle' },
        { t: 'fldCtxDepth', p: ['toolsConfig', 'context_awareness', 'maxFileDepth'], w: 'number', min: 0 },
        { t: 'fldCtxTabs', p: ['toolsConfig', 'context_awareness', 'includeOpenTabs'], w: 'toggle' },
        { t: 'fldCtxMaxTabs', p: ['toolsConfig', 'context_awareness', 'maxOpenTabs'], w: 'number', min: 0 },
        { t: 'fldCtxEditor', p: ['toolsConfig', 'context_awareness', 'includeActiveEditor'], w: 'toggle' },
        { t: 'fldCtxDiag', p: ['toolsConfig', 'context_awareness', 'includeDiagnostics'], w: 'toggle' }
      ]);
      break;
    case 'memory':
      renderSimpleSection('secMemory', [
        { t: 'fldMemEnabled', p: ['toolsConfig', 'memory', 'enabled'], w: 'toggle' },
        { t: 'fldMemWake', p: ['toolsConfig', 'memory', 'wakeKeywords'], w: 'chips' },
        { t: 'fldMemChars', p: ['toolsConfig', 'memory', 'maxCharsPerEntry'], w: 'number', min: 100 }
      ]);
      break;
    case 'summarize':
      renderSimpleSection('secSummarize', [
        { t: 'fldSumRounds', p: ['toolsConfig', 'summarize', 'rounds'], w: 'number', min: 1 },
        { t: 'fldSumTokens', p: ['toolsConfig', 'summarize', 'maxTokens'], w: 'number', min: 100 },
        { t: 'fldSumSeparate', p: ['toolsConfig', 'summarize', 'separateChannel'], w: 'toggle' },
        { t: 'fldSumChannel', p: ['toolsConfig', 'summarize', 'channelId'], w: 'configSelect' },
        { t: 'fldSumModel', p: ['toolsConfig', 'summarize', 'model'], w: 'text' },
        { t: 'fldSumAttempts', p: ['toolsConfig', 'summarize', 'autoAttempts'], w: 'number', min: 0 },
        { t: 'fldSumRatio', p: ['toolsConfig', 'summarize', 'ratio'], w: 'number', min: 1, max: 100 }
      ]);
      break;
    case 'checkpoint':
      renderSimpleSection('secCheckpoint', [
        { t: 'fldCkptEnabled', p: ['toolsConfig', 'checkpoints', 'enabled'], w: 'toggle' },
        { t: 'fldCkptMax', p: ['toolsConfig', 'checkpoints', 'maxCheckpoints'], w: 'number', min: 1 }
      ]);
      break;
    case 'tokenCount':
      renderTokenSection();
      break;
    case 'imageGen':
      renderImageGenSection();
      break;
    case 'skills':
      renderSkillsSection();
      break;
    case 'subagents':
      renderSubagentsSection();
      break;
    case 'pinned':
      renderPinnedSection();
      break;
    case 'remoteControl':
      renderRemoteSection();
      break;
    case 'storage':
      renderStorageSection();
      break;
    case 'dependencies':
      renderDepsSection();
      break;
    default:
      break;
  }
}
function loadSettings() {
  api('/api/settings').then(function (data) {
    state.settings = data.settings || null;
    if (state.settingsTab === 'general' || state.settingsTab === 'prompt') renderAllSettingsSections();
  }).catch(function () {});
}
function loadToolsList() {
  api('/api/tools').then(function (data) {
    state.tools = Array.isArray(data.tools) ? data.tools : [];
    state.autoExec = data.autoExec && typeof data.autoExec === 'object' ? data.autoExec : {};
    if (state.settingsTab === 'tools' || state.settingsTab === 'autoExec') renderAllSettingsSections();
  }).catch(function () {});
}
function loadDeps() {
  api('/api/dependencies').then(function (data) {
    state.deps = Array.isArray(data.dependencies) ? data.dependencies : [];
    if (state.settingsTab === 'dependencies') renderAllSettingsSections();
  }).catch(function () {});
}
function renderSettings(s) {
  state.statusInfo = s;
  if (state.settingsTab === 'remoteControl') renderAllSettingsSections();
}

/* ============================================================
   输入框
   ============================================================ */
function autoGrowInput() {
  var el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/* ============================================================
   事件接线
   ============================================================ */
var sendBtn = $('send');
var inputEl = $('input');
var messagesEl = $('messages');
var emptyEl = $('empty');
var fileTreeEl = $('file-tree');
var fileViewerEl = $('file-viewer');
var fileEditorEl = $('file-editor');
var saveFileBtnEl = $('btn-save-file');
var modalEl = $('modal');
var modalTitleEl = $('modal-title');
var modalBodyEl = $('modal-body');
var modalInputEl = $('modal-input');
var modalCancelEl = $('modal-cancel');
var modalOkEl = $('modal-ok');

sendBtn.addEventListener('click', function () {
  var cur = activeTab();
  if (cur && cur.streaming) { doStop(); } else { doSend(); }
});
inputEl.addEventListener('input', function () {
  autoGrowInput();
  updateSendBtn();
});
inputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    doSend();
  }
});
messagesEl.addEventListener('scroll', function () {
  var cur = activeTab();
  if (!cur || !cur.hasMore || cur.loading) return;
  if (messagesEl.scrollTop < 60) loadOlder(cur);
});
$('btn-drawer').addEventListener('click', openDrawer);
$('btn-refresh').addEventListener('click', function () {
  if (isTab('chat')) {
    var cur = activeTab();
    if (cur && cur.id) loadMessages(cur, false);
    loadConversations(true);
    toast(t('refresh') + ' ✓');
    return;
  }
  if (isTab('settings')) {
    renderSettingsTabs();
    loadConfigs();
    loadSettings();
    loadToolsList();
    loadDeps();
    loadPromptModes();
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
  newChatTab();
  toast(t('newChat') + ' — ' + t('emptyNewChat'));
});
$('drawer-backdrop').addEventListener('click', closeDrawer);
$('sheet').querySelector('.backdrop').addEventListener('click', closeSheet);
$('act-backdrop').addEventListener('click', closeActionSheet);
$('btn-sheet-model-close').addEventListener('click', closeSheet);
$('btn-ws-switch').textContent = t('switchWorkspace');
$('btn-ws-switch').addEventListener('click', openWorkspaceSheet);
$('btn-ws-add').addEventListener('click', openBrowse);
$('btn-sheet-add').addEventListener('click', addWorkspace);
$('btn-sheet-browse').addEventListener('click', function () {
  closeSheet();
  openBrowse();
});
$('btn-browse-back').addEventListener('click', function () {
  loadFsDir(state.browseParent || '');
});
$('btn-browse-root').addEventListener('click', function () { loadFsDir(''); });
$('btn-browse-pick').addEventListener('click', pickBrowseFolder);
$('btn-file-back').addEventListener('click', function () {
  if (state.currentFile && state.currentFile.dirty) {
    openModal(t('save'), null, t('renameSave'), t('renameCancel'), 'danger', function () {
      saveFile();
    });
    return;
  }
  state.currentFile = null;
  $('file-viewer').hidden = true;
  $('file-tree').hidden = false;
});
$('btn-open-desktop').addEventListener('click', openOnDesktop);
fileEditorEl.addEventListener('input', function () {
  if (!state.currentFile) return;
  state.currentFile.content = fileEditorEl.value;
  state.currentFile.dirty = true;
  saveFileBtnEl.disabled = false;
  saveFileBtnEl.textContent = t('save');
});
saveFileBtnEl.addEventListener('click', saveFile);
document.querySelectorAll('#tabbar button').forEach(function (b) {
  b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
});
modalCancelEl.addEventListener('click', closeModal);
modalOkEl.addEventListener('click', function () {
  var onOk = modalEl._onOk;
  closeModal();
  if (onOk) onOk(modalInputEl.hidden ? null : modalInputEl.value);
});
modalInputEl.addEventListener('input', function () {
  modalInputEl.style.height = 'auto';
  modalInputEl.style.height = Math.min(modalInputEl.scrollHeight, 200) + 'px';
});
modalInputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); modalOkEl.click(); }
  if (e.key === 'Escape') closeModal();
});

/* ============================================================
   启动
   ============================================================ */
setStatus('connecting', t('statusConnecting'));
$('btn-ws-switch').textContent = t('switchWorkspace');
saveFileBtnEl.textContent = t('save');
inputEl.placeholder = t('inputPlaceholder');
renderSettingsTabs();
renderTabsBar();
renderSendIcon();
loadPromptModes();
api('/api/status').then(function (s) {
  state.appVersion = s.appVersion || '';
  state.statusInfo = s;
  state.activeChannelId = s.activeChannelId || null;
  if (s.lang) state.lang = s.lang;
  applyWorkspaceInfo(s);
  renderSettings(s);
  loadConfigs();
  if (s.activeConversationId && state.tabs.length === 0) {
    var tab = newTabObject(s.activeConversationId, s.activeConversationTitle || '');
    state.tabs.push(tab);
    state.activeTabKey = tab.key;
    renderTabsBar();
    setTitle(tab.title);
    loadMessages(tab, true);
    loadConversations(true);
  } else {
    renderMessages();
    if (state.tabs.length === 0) {
      $('empty-text').textContent = t('emptyConversation');
      emptyEl.hidden = false;
      messagesEl.hidden = true;
    }
  }
  connectStream();
}).catch(function () {
  setStatus('err', t('statusServerStopped'));
  sendBtn.disabled = true;
  $('empty-text').textContent = t('statusServerStopped');
  emptyEl.hidden = false;
  messagesEl.hidden = true;
});
updateSendBtn();
</script>`;
}
