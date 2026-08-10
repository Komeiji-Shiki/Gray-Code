/**
 * remoteControlUiScript.ts
 *
 * 远程控制移动端 UI 脚本（V4 全量重写）。
 *
 * 相对 V3 的核心变化：
 * - 架构重构：单一 IIFE + 明确模块分区（工具/API/图标/状态/视图路由/会话/输入区/
 *   文件/设置/SSE/启动），全部渲染函数幂等且经 safe() 边界保护，任何异常只落
 *   toast + 错误横幅，绝不让页面变空白；
 * - 稳定性：SSE 看门狗（心跳超时主动重连、visibilitychange 恢复重连、bye 后
 *   探测服务器回归自动重连）、全局 window.onerror 兜底、错误横幅可见；
 * - 设置页改为 schema 驱动，全部字段路径与桌面端 SettingsPanel 完全对齐
 *   （如检查点 toolsConfig.checkpoint.*、自动总结 toolsConfig.summarize.*、
 *   内存 toolsConfig.memory.*、子代理 toolsConfig.subagents.* 等），
 *   并新增检查点消息/工具/排除配置、上下文诊断、模型管理等桌面端字段；
 * - 输入区四选择器（模式/渠道/模型/思考强度）走底部弹层，选择后立即联动；
 * - 图标全部内嵌 SVG。
 *
 * 注：本文件在 TS 模板字符串内输出浏览器脚本，脚本内部不得使用反引号与 `${`，
 * 一律用单引号字符串拼接，不得出现 `</script>` 文本。
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

/* ============================================================
   0. 全局错误边界：任何未捕获异常都不允许把页面打成空白
   ============================================================ */
var ERR_SHOWN = 0;
function showFatal(msg) {
  var banner = $('error-banner');
  if (!banner) return;
  banner.textContent = msg;
  banner.hidden = false;
  ERR_SHOWN++;
  if (ERR_SHOWN > 4) banner.hidden = true;
}
function safe(fn) {
  return function () {
    try { return fn.apply(null, arguments); }
    catch (e) {
      try { showFatal(String((e && e.message) || e)); } catch (e2) {}
      return undefined;
    }
  };
}
window.addEventListener('error', function (e) {
  showFatal(String((e && e.message) || 'unexpected error'));
});
window.addEventListener('unhandledrejection', function (e) {
  showFatal('rejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || ''));
});

/* ============================================================
   1. 工具函数
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
  if (isNaN(d.getTime())) return '';
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  var now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
/** 创建元素（attrs 含 data-p 等属性；children 为文本或元素） */
function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'dataset') {
        var ds = attrs[k];
        Object.keys(ds).forEach(function (dk) { node.dataset[dk] = ds[dk]; });
      } else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
        node.addEventListener(k.slice(2), attrs[k]);
      } else if (attrs[k] != null) {
        node.setAttribute(k, String(attrs[k]));
      }
    });
  }
  if (children) {
    children.forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
  }
  return node;
}

/* ============================================================
   2. API 客户端（超时 + 统一错误）
   ============================================================ */
function api(path, opts) {
  var options = opts || {};
  var ctrl = null;
  var tmr = null;
  if (typeof AbortController !== 'undefined') {
    ctrl = new AbortController();
    tmr = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, options.timeoutMs || 30000);
  }
  var init = {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body
  };
  if (ctrl) init.signal = ctrl.signal;
  return fetch(path, init).then(function (res) {
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
  }).catch(function (err) {
    if (err && err.name === 'AbortError') throw new Error('timeout');
    throw err;
  }).then(function (data) {
    if (tmr) clearTimeout(tmr);
    return data;
  }, function (err) {
    if (tmr) clearTimeout(tmr);
    throw err;
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
   3. 图标（全部内嵌 SVG，无字体/emoji 依赖）
   ============================================================ */
function icon(name, cls) {
  var paths = ICONS[name];
  if (!paths) return '';
  var c = cls ? ' class="' + cls + '"' : '';
  return '<svg' + c + ' viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + paths + '</svg>';
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
  warning: '<path d="M12 3L1 21h22L12 3zm1 14h-2v2h2v-2zm0-8h-2v6h2V9z"/>',
  history: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10l4 2-1 1.7-5-2.5V6h2v6z"/>',
  brain: '<path d="M12 2a5 5 0 0 1 5 5c2 1 3 3 3 5 0 2-1.3 3.7-3.2 4.4A5 5 0 0 1 12 22a5 5 0 0 1-4.8-5.6A5 5 0 0 1 4 12c0-2 1-4 3-5a5 5 0 0 1 5-5z"/>',
  language: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.9 6h-3.4A17.7 17.7 0 0 0 14.3 3.6 8.1 8.1 0 0 1 19.9 8zM12 4.1c.9 1 1.8 2.4 2.3 3.9H9.7c.5-1.5 1.4-2.9 2.3-3.9zM4.1 12c0-.7.1-1.4.3-2h3.7c0 .7-.1 1.3-.1 2s.1 1.3.1 2H4.4a8.2 8.2 0 0 1-.3-2zm1.8 6h3.3c.5 1.6 1.4 3 2.3 3.9A8.1 8.1 0 0 1 5.9 18zm3.3-2h5.6c.4 1.3 1 2.5 1.7 3.5a9.6 9.6 0 0 1-9-3.5zm.4-2c-.1-.7-.2-1.3-.2-2s.1-1.3.2-2h5.2c.1.7.2 1.3.2 2s-.1 1.3-.2 2H9.6zm6.1 5.5c.7-1 1.3-2.2 1.7-3.5h3.3a8.1 8.1 0 0 1-5 3.5zm2-5.5c.1-.7.1-1.3.1-2s0-1.3-.1-2h3.7c.2.6.3 1.3.3 2s-.1 1.4-.3 2h-3.7z"/>',
  chatList: '<path d="M4 5h16v2H4V5zm0 4h16v2H4V9zm0 4h10v2H4v-2zm0 4h10v2H4v-2zm13.5-1l2.5-1.5V6H10v8h4.5l3 2z"/>',
  window: '<path d="M3 5h18v14H3V5zm2 2v10h14V7H5z"/>',
  shield: '<path d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5l8-3zm-1 14l6-6-1.4-1.4-4.6 4.6-2-2L7.6 12.6 11 16z"/>',
  sparkle: '<path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z"/>',
  clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm1-13h-2v6l5 3 1-1.6-4-2.4V7z"/>',
  search: '<path d="M10 4a6 6 0 1 0 3.5 10.9l5 5 1.4-1.4-5-5A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"/>',
  wrench: '<path d="M16 3a6 6 0 0 0-5.9 7.3L3 17.4V21h3.6l7.1-7.1A6 6 0 0 0 16 3zm0 2a4 4 0 0 1 3.6 5.6l-6.9 6.9L12 17.5l-1.4-1.4-.5 1.3-1.5 1.5H5v-3.6l1.5-1.5 1.3-.5L6.4 11 13.3 4.1A4 4 0 0 1 16 5z"/>'
};
var ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>';
var ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>';

/* ============================================================
   4. 状态
   ============================================================ */
var MAX_EDIT_CHARS = 1024 * 1024;
var S = {
  lang: '${uiLang}',
  appVersion: '',
  connected: false,
  evtSource: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  serverStopped: false,
  /* 会话页签 */
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
  configs: [],
  configModels: {},
  activeChannelId: null,
  selectedModelId: null,
  promptModes: [],
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
  /* 目录浏览 */
  browsePath: '',
  browseParent: null,
  browseBusy: false
};
var CONV_PAGE_SIZE = 30;
var MSG_PAGE_SIZE = 120;
var ORPHAN_STREAM_MAX = 12;
var ORPHAN_CHUNK_MAX = 5000;
var orphanStreams = {};

function tabByKey(key) {
  for (var i = 0; i < S.tabs.length; i++) if (S.tabs[i].key === key) return S.tabs[i];
  return null;
}
function tabByConvId(id) {
  if (!id) return null;
  for (var i = 0; i < S.tabs.length; i++) if (S.tabs[i].id === id) return S.tabs[i];
  return null;
}
function activeTab() { return tabByKey(S.activeTabKey); }
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
   5. 顶栏 / 视图路由
   ============================================================ */
function setStatus(kind, text) {
  var dot = $('dot');
  if (dot) dot.className = 'dot ' + kind;
  var st = $('status');
  if (st) st.textContent = text;
}
function setTitle(text) {
  var ti = $('title');
  if (ti) ti.textContent = text || t('appTitle');
}
function setWorkspaceName(name) {
  var ws = $('ws-name');
  if (!ws) return;
  if (name) {
    ws.textContent = name;
    ws.hidden = false;
  } else {
    ws.hidden = true;
  }
}
function isView(name) { return $('view-' + name).hidden === false; }
function switchView(name) {
  ['chat', 'files', 'settings'].forEach(function (n) {
    $('view-' + n).hidden = (n !== name);
  });
  document.querySelectorAll('#tabbar button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  if (name === 'chat') {
    renderTabsBar();
    renderMessages();
    renderComposerMeta();
    if (!S.evtSource && !S.serverStopped) connectStream();
  } else if (name === 'files') {
    refreshWsBar();
    loadFiles('', true);
  } else if (name === 'settings') {
    openSettings();
  }
}
function refreshWsBar() {
  var n = $('ws-bar-name');
  var f = $('ws-bar-file');
  if (n) n.textContent = S.workspaceName || t('noWorkspace');
  if (f) f.textContent = S.activeFilePath ? t('activeFile') + ': ' + S.activeFilePath : '';
}

/* ============================================================
   6. 会话页签
   ============================================================ */
function renderTabsBar() {
  var tabsEl = $('conv-tabs');
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  S.tabs.forEach(function (tab) {
    var btn = el('button', {
      class: 'tab' + (tab.key === S.activeTabKey ? ' active' : '') + (tab.streaming ? ' streaming' : ''),
      role: 'tab'
    });
    if (tab.streaming) {
      btn.appendChild(el('span', { class: 'tab-spin' }));
    }
    btn.appendChild(el('span', { class: 'tab-label', text: tab.title || t('newChat') }));
    var closeBtn = el('button', {
      class: 'tab-close',
      'aria-label': t('closeTab')
    });
    closeBtn.innerHTML = icon('close');
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeTab(tab.key);
    });
    btn.appendChild(closeBtn);
    btn.addEventListener('click', function () { activateTab(tab.key); });
    tabsEl.appendChild(btn);
  });
  var addBtn = el('button', { class: 'tab-add', 'aria-label': t('newChat') });
  addBtn.innerHTML = icon('plus');
  addBtn.addEventListener('click', function () { newChatTab(); });
  tabsEl.appendChild(addBtn);
}
function openConversationTab(id, title) {
  var tab = tabByConvId(id);
  if (tab) {
    activateTab(tab.key);
    return;
  }
  var nt = newTabObject(id, title);
  S.tabs.push(nt);
  S.activeTabKey = nt.key;
  renderTabsBar();
  setTitle(nt.title);
  loadMessages(nt, true);
}
function activateTab(key) {
  if (S.activeTabKey === key) return;
  S.activeTabKey = key;
  renderTabsBar();
  renderMessages();
  renderConfirmBar();
  renderSendIcon();
  updateSendBtn();
  var tab = activeTab();
  setTitle(tab ? (tab.title || t('newChat')) : t('appTitle'));
}
function closeTab(key) {
  var idx = -1;
  for (var i = 0; i < S.tabs.length; i++) if (S.tabs[i].key === key) { idx = i; break; }
  if (idx < 0) return;
  var tab = S.tabs[idx];
  if (tab.streaming && tab.id) {
    post('/api/cancel', { conversationId: tab.id }).catch(function () {});
  }
  S.tabs.splice(idx, 1);
  if (S.activeTabKey === key) {
    var next = S.tabs[idx] || S.tabs[idx - 1] || null;
    if (next) {
      S.activeTabKey = next.key;
      renderTabsBar();
      renderMessages();
      setTitle(next.title || t('newChat'));
    } else {
      S.activeTabKey = null;
      S.tabs.push(newTabObject(null, ''));
      S.activeTabKey = S.tabs[S.tabs.length - 1].key;
      renderTabsBar();
      renderMessages();
      setTitle(t('newChat'));
    }
  }
  renderTabsBar();
  renderSendIcon();
  updateSendBtn();
  renderConfirmBar();
}
function newChatTab() {
  var tab = newTabObject(null, '');
  S.tabs.push(tab);
  S.activeTabKey = tab.key;
  closeDrawer();
  renderTabsBar();
  renderMessages();
  renderComposerMeta();
  setTitle(t('newChat'));
  toast(t('newChat') + ' — ' + t('emptyNewChat'));
}
function syncTabTitles(conversations) {
  var list = Array.isArray(conversations) ? conversations : [];
  var byId = {};
  list.forEach(function (c) { if (c && c.id) byId[c.id] = c.title || ''; });
  S.tabs.forEach(function (tab) {
    if (tab.id && byId[tab.id] && byId[tab.id] !== tab.title) {
      tab.title = byId[tab.id];
      if (tab.key === S.activeTabKey) setTitle(tab.title);
    }
  });
  renderTabsBar();
}

/* ---------- 会话列表抽屉 ---------- */
function loadConversations(reset) {
  if (reset) S.convPage = 0;
  if (S.convLoading) return;
  S.convLoading = true;
  var q = '?limit=' + CONV_PAGE_SIZE + '&offset=' + (S.convPage * CONV_PAGE_SIZE);
  api('/api/conversations' + q).then(function (data) {
    S.convLoading = false;
    var list = Array.isArray(data.conversations) ? data.conversations : [];
    S.convTotal = data.total || list.length;
    S.convList = reset ? list : S.convList.concat(list);
    renderDrawerList();
    syncTabTitles(list);
  }).catch(function () {
    S.convLoading = false;
  });
}
function renderDrawerList() {
  var listEl = $('drawer-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  S.convList.forEach(function (c) {
    var item = el('div', { class: 'conv-item' });
    var main = el('button', { class: 'conv-main' });
    main.appendChild(el('div', { class: 'conv-title', text: c.title || t('untitled') }));
    main.appendChild(el('div', {
      class: 'conv-sub',
      text: fmtTime(c.updatedAt) + (c.messageCount ? ' · ' + c.messageCount + ' 条' : '')
    }));
    main.addEventListener('click', function () {
      openConversationTab(c.id, c.title || '');
      closeDrawer();
    });
    item.appendChild(main);
    var more = el('button', { class: 'icon-btn conv-more', 'aria-label': t('moreActions') });
    more.innerHTML = icon('edit');
    more.addEventListener('click', function (e) {
      e.stopPropagation();
      openRename(c.id, c.title || '');
    });
    item.appendChild(more);
    listEl.appendChild(item);
  });
  if (S.convTotal > S.convList.length) {
    var moreBtn = el('button', { class: 'load-more-btn', text: t('loadMore') });
    moreBtn.addEventListener('click', function () {
      S.convPage++;
      loadConversations(false);
    });
    listEl.appendChild(moreBtn);
  }
  if (S.convList.length === 0) {
    listEl.appendChild(el('div', { class: 'conv-empty', text: t('noConversations') }));
  }
}
function openDrawer() {
  var d = $('drawer');
  if (d) d.classList.add('open');
  if (S.convList.length === 0) loadConversations(true);
}
function closeDrawer() {
  var d = $('drawer');
  if (d) d.classList.remove('open');
}
function openRename(id, title) {
  openModal(t('rename'), title || '', t('renameSave'), t('renameCancel'), null, function (val) {
    var nt = String(val || '').trim();
    if (!nt) return;
    post('/api/rename', { conversationId: id, title: nt.slice(0, 100) }).then(function () {
      toast(t('renamed'));
      loadConversations(true);
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
}
function deleteConversation(id) {
  post('/api/conversation-delete', { conversationId: id }).then(function () {
    toast(t('deleted'));
    var tab = tabByConvId(id);
    if (tab) closeTab(tab.key);
    loadConversations(true);
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}

/* ---------- 弹层（通用底部选择器） ---------- */
function openSheet(title, buildList) {
  var sheetEl = $('sheet');
  if (!sheetEl) return;
  var lm = $('sheet-list-mode');
  var bm = $('sheet-browse-mode');
  if (lm) lm.hidden = false;
  if (bm) bm.hidden = true;
  $('sheet-title').textContent = title;
  var list = $('sheet-list');
  list.innerHTML = '';
  safe(buildList)(list);
  sheetEl.classList.add('open');
}
function closeSheet() {
  var sheetEl = $('sheet');
  if (sheetEl) sheetEl.classList.remove('open');
}
function sheetItem(list, label, sub, selected, onClick) {
  var item = el('button', { class: 'sheet-item' + (selected ? ' selected' : '') });
  item.appendChild(el('span', { text: label }));
  if (sub) item.appendChild(el('span', { class: 'si-sub', text: sub }));
  if (selected) {
    var chk = el('span', { class: 'si-check' });
    chk.innerHTML = icon('check');
    item.appendChild(chk);
  }
  item.addEventListener('click', function () { closeSheet(); safe(onClick)(); });
  list.appendChild(item);
}
function sheetHint(list, text) {
  list.appendChild(el('div', { class: 'sheet-hint', text: text }));
}

/* ---------- 对话框 ---------- */
function openModal(title, inputValue, okText, cancelText, kind, onOk) {
  var modalEl = $('modal');
  if (!modalEl) return;
  $('modal-title').textContent = title;
  var bodyEl = $('modal-body');
  var inputEl = $('modal-input');
  bodyEl.innerHTML = '';
  inputEl.hidden = inputValue == null;
  inputEl.value = inputValue == null ? '' : inputValue;
  bodyEl.appendChild(inputEl);
  $('modal-cancel').textContent = cancelText || t('renameCancel');
  $('modal-ok').textContent = okText || t('renameSave');
  $('modal-ok').className = 'btn' + (kind === 'danger' ? ' danger' : '');
  modalEl._onOk = onOk;
  modalEl.classList.add('open');
  if (!inputEl.hidden) setTimeout(function () { inputEl.focus(); }, 60);
}
function closeModal() {
  var modalEl = $('modal');
  if (modalEl) modalEl.classList.remove('open');
}
/* 消息操作菜单（兼容保留：当前版本消息操作全部内联按钮） */
function openActionSheet() {}
function closeActionSheet() {
  var el = $('action-sheet');
  if (el) el.classList.remove('open');
}

/* ---------- 消息渲染 ---------- */
function partsToText(parts) {
  var out = '';
  (parts || []).forEach(function (p) {
    if (!p) return;
    if (typeof p.text === 'string') out += p.text;
    else if (p.thinking && typeof p.thinking === 'string') out += p.thinking;
  });
  return out;
}
function renderInline(s) {
  return esc(s)
    .replace(/&quot;/g, '"')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
}
function renderTable(lines, i) {
  var rows = [];
  var j = i;
  while (j < lines.length && lines[j].trim() !== '') {
    rows.push(lines[j]);
    j++;
  }
  if (rows.length < 2) return null;
  var html = '<table><thead><tr>';
  rows[0].split('|').forEach(function (c) {
    var cell = c.trim();
    if (cell && cell !== '---' && cell !== ':---' && cell !== '---:' && cell !== ':---:') {
      html += '<th>' + renderInline(cell) + '</th>';
    }
  });
  html += '</tr></thead><tbody>';
  for (var r = 1; r < rows.length; r++) {
    html += '<tr>';
    rows[r].split('|').forEach(function (c) {
      html += '<td>' + renderInline(c.trim()) + '</td>';
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  return { html: html, next: j };
}
function renderMarkdown(text) {
  if (!text) return '';
  var lines = String(text).split(/\\n/);
  var out = '';
  var codeOpen = false;
  var codeBuf = [];
  var listOpen = false;
  function flushList() {
    if (listOpen) { out += '</ul>'; listOpen = false; }
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\\s*\`\`\`/.test(line)) {
      flushList();
      if (codeOpen) {
        out += '</code></pre>';
        codeOpen = false;
      } else {
        codeOpen = true;
        codeBuf = [];
        out += '<pre><code>';
      }
      continue;
    }
    if (codeOpen) {
      out += esc(line) + '\\n';
      continue;
    }
    var tbl = /^\\s*\\|/.test(line) ? renderTable(lines, i) : null;
    if (tbl) {
      flushList();
      out += tbl.html;
      i = tbl.next - 1;
      continue;
    }
    var h = /^(#{1,4})\\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      var lv = h[1].length + 2;
      out += '<h' + lv + '>' + renderInline(h[2]) + '</h' + lv + '>';
      continue;
    }
    if (/^\\s*([-*+])\\s+/.test(line)) {
      if (!listOpen) { out += '<ul>'; listOpen = true; }
      out += '<li>' + renderInline(line.replace(/^\\s*([-*+])\\s+/, '')) + '</li>';
      continue;
    }
    if (/^\\s*(\\d+)[.)]\\s+/.test(line)) {
      if (!listOpen) { out += '<ul>'; listOpen = true; }
      out += '<li>' + renderInline(line.replace(/^\\s*(\\d+)[.)]\\s+/, '')) + '</li>';
      continue;
    }
    flushList();
    if (line.trim() === '') {
      out += '<div class="md-spacer"></div>';
    } else {
      out += '<p>' + renderInline(line) + '</p>';
    }
  }
  if (codeOpen) out += '</code></pre>';
  flushList();
  return out;
}
function toolCallsOf(msg) {
  var calls = [];
  (msg.parts || []).forEach(function (p) {
    if (p && p.type === 'toolCall' && p.toolCall && p.toolCall.name) {
      calls.push(p.toolCall.name);
    }
  });
  return calls;
}
function buildMessage(msg, index) {
  if (!msg) return null;
  var role = msg.role || 'assistant';
  var wrap = el('div', { class: 'msg ' + role + (index === null ? ' streaming' : '') });
  var head = el('div', { class: 'msg-head' });
  head.appendChild(el('span', { class: 'msg-role', text: role === 'user' ? t('you') : t('assistant') }));
  if (msg.model) head.appendChild(el('span', { class: 'msg-model', text: msg.model }));
  if (msg.createdAt) head.appendChild(el('span', { class: 'msg-time', text: fmtTime(msg.createdAt) }));
  wrap.appendChild(head);
  var contentEl = el('div', { class: 'msg-content' });
  var tools = toolCallsOf(msg);
  if (tools.length) {
    contentEl.appendChild(el('div', { class: 'msg-tools', text: t('toolUsed') + ': ' + tools.join(', ') }));
  }
  var text = partsToText(msg.parts) || msg.content || '';
  if (role === 'user') {
    contentEl.appendChild(el('div', { text: text }));
  } else {
    var md = el('div', { class: 'markdown' });
    md.innerHTML = renderMarkdown(text);
    contentEl.appendChild(md);
  }
  wrap.appendChild(contentEl);
  var actions = el('div', { class: 'msg-actions' });
  var copyBtn = el('button', { class: 'mini-btn', 'aria-label': t('copy') });
  copyBtn.innerHTML = icon('copy');
  copyBtn.addEventListener('click', function () { copyText(partsToText(msg.parts) || msg.content || ''); });
  actions.appendChild(copyBtn);
  if (role === 'assistant' && !index && msg.id) {
    var rerollBtn = el('button', { class: 'mini-btn', 'aria-label': t('reroll') });
    rerollBtn.innerHTML = icon('refresh');
    rerollBtn.addEventListener('click', function () { rerollMessage(msg); });
    actions.appendChild(rerollBtn);
  }
  if (msg.id) {
    var editBtn = el('button', { class: 'mini-btn', 'aria-label': t('edit') });
    editBtn.innerHTML = icon('edit');
    editBtn.addEventListener('click', function () { editMessage(msg); });
    actions.appendChild(editBtn);
  }
  if (index !== null) {
    var delBtn = el('button', { class: 'mini-btn', 'aria-label': t('deleteMessage') });
    delBtn.innerHTML = icon('trash');
    delBtn.addEventListener('click', function () {
      openModal(t('deleteMessage'), null, t('deleteMessageConfirm'), t('renameCancel'), 'danger', function () {
        deleteMessageAt(index);
      });
    });
    actions.appendChild(delBtn);
  }
  wrap.appendChild(actions);
  return wrap;
}
function renderMessages() {
  var cur = activeTab();
  var messagesEl = $('messages');
  var emptyEl = $('empty');
  if (!messagesEl || !emptyEl) return;
  if (!cur) {
    messagesEl.hidden = true;
    emptyEl.hidden = false;
    $('empty-text').textContent = t('emptyConversation');
    return;
  }
  messagesEl.innerHTML = '';
  if (cur.messages.length === 0 && !cur.streaming) {
    messagesEl.hidden = true;
    emptyEl.hidden = false;
    $('empty-text').textContent = cur.id ? t('emptyConversation') : t('emptyNewChat');
    return;
  }
  messagesEl.hidden = false;
  emptyEl.hidden = true;
  if (cur.hasMore) {
    var moreBtn = el('button', { class: 'load-more-btn', text: cur.loading ? t('loading') : t('loadMore') });
    moreBtn.addEventListener('click', function () { loadOlder(cur); });
    messagesEl.appendChild(moreBtn);
  }
  cur.messages.forEach(function (m, i) {
    var node = buildMessage(m, i);
    if (node) messagesEl.appendChild(node);
  });
  if (cur.streaming) {
    var holder = el('div', { class: 'msg assistant streaming' });
    holder.appendChild(el('div', {
      class: 'msg-head',
      html: '<span class="msg-role">' + esc(t('assistant')) + '</span>' +
        (cur.streamingModel ? '<span class="msg-model">' + esc(cur.streamingModel) + '</span>' : '')
    }));
    var sc = el('div', { class: 'msg-content' });
    sc.innerHTML = (cur.streamingText ? renderMarkdown(cur.streamingText) : '') + '<span class="caret"></span>';
    holder.appendChild(sc);
    messagesEl.appendChild(holder);
  }
  if (cur.lastError) {
    var errBox = el('div', { class: 'err-box' });
    errBox.appendChild(el('span', { text: cur.lastError.text || '' }));
    if (cur.lastError.retry) {
      var retryBtn = el('button', { class: 'mini-btn', text: t('retry') });
      retryBtn.addEventListener('click', function () { doRetry(); });
      errBox.appendChild(retryBtn);
    }
    messagesEl.appendChild(errBox);
  }
  scrollToBottom();
}
function scrollToBottom() {
  var messagesEl = $('messages');
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}
function loadMessages(tab, quiet) {
  if (!tab || !tab.id || tab.loading) return;
  tab.loading = true;
  api('/api/messages?conversationId=' + encodeURIComponent(tab.id) + '&limit=' + MSG_PAGE_SIZE)
    .then(function (data) {
      tab.loading = false;
      tab.messages = Array.isArray(data.messages) ? data.messages : [];
      tab.total = data.total || tab.messages.length;
      tab.offset = tab.messages.length;
      tab.hasMore = !!data.hasMore;
      if (tab.key === S.activeTabKey) renderMessages();
      return data;
    })
    .catch(function (err) {
      tab.loading = false;
      if (!quiet) toast(t('loadFailed') + ': ' + (err.message || ''));
    });
}
function loadOlder(tab) {
  if (!tab || !tab.id || !tab.hasMore || tab.loading) return;
  tab.loading = true;
  api('/api/messages?conversationId=' + encodeURIComponent(tab.id) +
    '&limit=' + MSG_PAGE_SIZE + '&offset=' + tab.offset)
    .then(function (data) {
      tab.loading = false;
      var older = Array.isArray(data.messages) ? data.messages : [];
      tab.messages = older.concat(tab.messages);
      tab.offset += older.length;
      tab.hasMore = !!data.hasMore;
      if (tab.key === S.activeTabKey) renderMessages();
    })
    .catch(function () { tab.loading = false; });
}
function deleteMessageAt(index) {
  var cur = activeTab();
  if (!cur || !cur.id) return;
  post('/api/delete-message', { conversationId: cur.id, targetIndex: index }).then(function () {
    toast(t('deleted'));
    loadMessages(cur, true);
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
function editMessage(msg) {
  var cur = activeTab();
  if (!cur || !cur.id) return;
  openModal(t('editMessage'), partsToText(msg.parts) || msg.content || '', t('save'), t('renameCancel'), null, function (val) {
    var nt = String(val || '').trim();
    if (!nt) return;
    post('/api/edit-message', { conversationId: cur.id, messageId: msg.id, newText: nt }).then(function () {
      toast(t('edited'));
      if (cur.key === S.activeTabKey) loadMessages(cur, true);
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
}
function rerollMessage(msg) {
  var cur = activeTab();
  if (!cur || !cur.id) return;
  post('/api/reroll', { conversationId: cur.id, assistantNodeId: msg.id }).then(function () {
    toast(t('rerolling'));
    setStreaming(cur, true, '');
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
function copyText(text) {
  if (!text) { toast(t('nothingToCopy')); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      toast(t('copied'));
    }).catch(function () { fallbackCopy(text); });
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
  try { document.execCommand('copy'); toast(t('copied')); }
  catch (e) { toast(t('copyFailed')); }
  document.body.removeChild(ta);
}

/* ---------- 工具确认条 ---------- */
function renderConfirmBar() {
  var bar = $('confirm-bar');
  if (!bar) return;
  bar.innerHTML = '';
  var cur = activeTab();
  if (!cur || cur.pendingTools.length === 0) return;
  var box = el('div', { class: 'confirm-box' });
  box.appendChild(el('div', { class: 'confirm-title', text: t('toolConfirmTitle') }));
  cur.pendingTools.forEach(function (tc) {
    box.appendChild(el('div', { class: 'confirm-item', text: (tc.name || tc.tool || '?') }));
  });
  var row = el('div', { class: 'confirm-actions' });
  var rejectBtn = el('button', { class: 'btn danger', text: t('toolReject') });
  rejectBtn.addEventListener('click', function () { toolConfirm(false); });
  var approveBtn = el('button', { class: 'btn', text: t('toolApprove') });
  approveBtn.addEventListener('click', function () { toolConfirm(true); });
  row.appendChild(rejectBtn);
  row.appendChild(approveBtn);
  box.appendChild(row);
  bar.appendChild(box);
}
function toolConfirm(confirmed) {
  var cur = activeTab();
  if (!cur || !cur.id || cur.confirmInFlight) return;
  cur.confirmInFlight = true;
  var responses = cur.pendingTools.map(function (tc) {
    return { id: tc.id, name: tc.name || tc.tool || '', confirmed: confirmed };
  });
  post('/api/tool-confirm', { conversationId: cur.id, toolResponses: responses }).then(function () {
    cur.confirmInFlight = false;
    cur.pendingTools = [];
    renderConfirmBar();
    if (confirmed) setStreaming(cur, true, '');
  }).catch(function (err) {
    cur.confirmInFlight = false;
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}

/* ---------- 发送 / 停止 ---------- */
function renderSendIcon() {
  var btn = $('send');
  if (!btn) return;
  var cur = activeTab();
  btn.innerHTML = cur && cur.streaming ? ICON_STOP : ICON_SEND;
}
function canSend() {
  var cur = activeTab();
  if (!cur) return false;
  if (cur.streaming || cur.sendInFlight) return false;
  var val = $('input').value.trim();
  return val.length > 0 && val.length <= MAX_EDIT_CHARS;
}
function updateSendBtn() {
  var btn = $('send');
  if (!btn) return;
  var cur = activeTab();
  btn.disabled = !canSend() && !(cur && cur.streaming);
}
function doSend() {
  var cur = activeTab();
  if (!cur || cur.streaming || cur.sendInFlight) return;
  var inputEl = $('input');
  var text = inputEl.value.trim();
  if (!text || text.length > MAX_EDIT_CHARS) return;
  if (!S.activeChannelId) {
    toast(t('noConfigs'));
    return;
  }
  cur.sendInFlight = true;
  var payload = {
    text: text,
    configId: S.activeChannelId,
    modelId: S.selectedModelId || undefined,
    promptModeId: S.currentModeId || undefined
  };
  if (cur.id) payload.conversationId = cur.id;
  post('/api/send', payload).then(function (data) {
    cur.sendInFlight = false;
    inputEl.value = '';
    autoGrowInput();
    updateSendBtn();
    if (data.conversationId) {
      if (!cur.id) {
        cur.id = data.conversationId;
        cur.pendingStreamId = data.streamId || null;
        renderTabsBar();
      }
      setStreaming(cur, true, '');
      loadMessages(cur, true);
    }
  }).catch(function (err) {
    cur.sendInFlight = false;
    cur.lastError = { text: t('sendFailed') + ': ' + (err.message || ''), retry: !!cur.id };
    renderMessages();
  });
}
function doStop() {
  var cur = activeTab();
  if (!cur || !cur.streaming) return;
  if (cur.id) {
    post('/api/cancel', { conversationId: cur.id }).catch(function () {});
  }
  cur.streaming = false;
  cur.pendingTools = [];
  renderConfirmBar();
  renderSendIcon();
  updateSendBtn();
  setStatus('ok', t('statusConnected'));
}
function doRetry() {
  var cur = activeTab();
  if (!cur || !cur.id || cur.streaming) return;
  cur.lastError = null;
  post('/api/retry', { conversationId: cur.id }).then(function () {
    setStreaming(cur, true, '');
  }).catch(function (err) {
    cur.lastError = { text: t('retryFailed') + ': ' + (err.message || ''), retry: true };
    renderMessages();
  });
}
function autoGrowInput() {
  var inputEl = $('input');
  if (!inputEl) return;
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

/* ============================================================
   7. SSE 流式（多会话并行 + 看门狗）
   ============================================================ */
function connectStream() {
  if (S.evtSource) return;
  var es;
  try { es = new EventSource('/api/stream'); } catch (e) { scheduleReconnect(3000); return; }
  S.evtSource = es;
  S.reconnectAttempts = 0;
  es.onopen = safe(function () {
    S.serverStopped = false;
    S.connected = true;
    var cur = activeTab();
    setStatus(cur && cur.streaming ? 'busy' : 'ok',
      cur && cur.streaming ? t('statusStreaming') : t('statusConnected'));
  });
  es.addEventListener('hello', safe(function (ev) {
    var info = JSON.parse(ev.data);
    S.statusInfo = info;
    if (info.activeChannelId) S.activeChannelId = info.activeChannelId;
    applyWorkspaceInfo(info);
    renderComposerMeta();
    if (info.activeConversationId && S.tabs.length === 0) {
      openConversationTab(info.activeConversationId, info.activeConversationTitle || '');
    }
    loadConversations(true);
  }));
  es.addEventListener('message', safe(function (ev) { handleStreamMessage(ev.data); }));
  es.addEventListener('global', safe(function (ev) { handleStreamMessage(ev.data); }));
  es.addEventListener('workspace', safe(function (ev) {
    applyWorkspaceInfo(JSON.parse(ev.data));
  }));
  es.addEventListener('conversations', safe(function () {
    loadConversations(true);
  }));
  es.addEventListener('bye', safe(function () {
    S.serverStopped = true;
    if (es) { es.close(); }
    S.evtSource = null;
    S.connected = false;
    resetAllStreaming();
    setStatus('err', t('statusServerStopped'));
    var sendBtn = $('send');
    if (sendBtn) sendBtn.disabled = true;
    /* 服务器重启探测：bye 后周期性探活，恢复后自动重连 */
    probeServerRecovery();
  }));
  es.onerror = safe(function () {
    if (S.serverStopped) return;
    if (es) { es.close(); }
    S.evtSource = null;
    S.connected = false;
    resetAllStreaming();
    setStatus('err', t('statusReconnecting'));
    scheduleReconnect(2000 + Math.min(S.reconnectAttempts * 1000, 15000));
  });
}
function scheduleReconnect(delay) {
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = setTimeout(function () {
    if (S.serverStopped) return;
    if (S.evtSource) return;
    S.reconnectAttempts++;
    connectStream();
  }, delay || 2000);
}
function probeServerRecovery() {
  clearTimeout(S.probeTimer);
  S.probeTimer = setInterval(function () {
    if (S.evtSource) {
      clearInterval(S.probeTimer);
      return;
    }
    api('/api/status').then(function (s) {
      if (s && s.running) {
        clearInterval(S.probeTimer);
        S.serverStopped = false;
        S.statusInfo = s;
        if (s.activeChannelId) S.activeChannelId = s.activeChannelId;
        applyWorkspaceInfo(s);
        renderSettings(s);
        var sendBtn = $('send');
        if (sendBtn) sendBtn.disabled = false;
        setStatus('connecting', t('statusConnecting'));
        connectStream();
      }
    }).catch(function () {});
  }, 3000);
}
/* 看门狗：SSE 连接被静默掐断（无 error 事件）时兜底重连 */
setInterval(function () {
  if (S.serverStopped) return;
  if (S.evtSource) {
    if (S.evtSource.readyState === EventSource.CLOSED) {
      S.evtSource = null;
      scheduleReconnect(1500);
    }
    return;
  }
  scheduleReconnect(1500);
}, 15000);
/* 移动端切回前台：立即恢复连接 */
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && !S.evtSource && !S.serverStopped) {
    scheduleReconnect(200);
  }
});
function resetAllStreaming() {
  var changed = false;
  S.tabs.forEach(function (tab) {
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
      if (tab2.key === S.activeTabKey) renderMessages();
    }
  }
}
function tabByStreamId(streamId) {
  if (!streamId) return null;
  for (var i = 0; i < S.tabs.length; i++) {
    if (S.tabs[i].pendingStreamId === streamId) return S.tabs[i];
  }
  return null;
}
function flushOrphanStream(streamId, tab) {
  if (!streamId || !tab) return;
  var buf = orphanStreams[streamId];
  if (buf && buf.chunks.length) {
    delete orphanStreams[streamId];
    buf.chunks.forEach(function (c) { processChunk(c, tab); });
  }
}
function setStreaming(tab, on, model) {
  if (!tab) return;
  tab.streaming = on;
  if (model) tab.streamingModel = model;
  if (!on) tab.streamingText = '';
  renderTabsBar();
  renderSendIcon();
  updateSendBtn();
  var cur = activeTab();
  setStatus(on ? 'busy' : 'ok', on ? t('statusStreaming') : t('statusConnected'));
  if (cur === tab && tab.key === S.activeTabKey) {
    if (on) renderMessages();
  }
}
function renderStreamingText() {
  var tab = activeTab();
  if (!tab || !tab.streaming) return;
  var messagesEl = $('messages');
  if (!messagesEl) return;
  var holders = messagesEl.querySelectorAll('.msg.assistant.streaming');
  var last = holders[holders.length - 1];
  if (last) {
    var contentEl = last.querySelector('.msg-content');
    if (contentEl) {
      contentEl.innerHTML = (tab.streamingText ? renderMarkdown(tab.streamingText) : '') + '<span class="caret"></span>';
    }
  }
  scrollToBottom();
}
function processChunk(c, tab) {
  if (!c || !c.type || !tab) return;
  var type = c.type;
  if (type === 'chunk' && typeof c.chunk === 'string') {
    if (!tab.streaming) setStreaming(tab, true, '');
    tab.streamingText += c.chunk;
    if (tab.key === S.activeTabKey) renderStreamingText();
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
    if (tab.key === S.activeTabKey) renderMessages();
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
    if (!tab.streaming) setStreaming(tab, true, '');
    tab.pendingTools = [];
    renderConfirmBar();
    return;
  }
  if (type === 'checkpoints' || type === 'autoSummaryStatus' || type === 'autoSummary') {
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
  if (typeof info.workspaceUri === 'string' && info.workspaceUri !== S.workspaceUri) {
    S.workspaceUri = info.workspaceUri;
    changed = true;
  }
  if (typeof info.workspaceName === 'string' && info.workspaceName !== S.workspaceName) {
    S.workspaceName = info.workspaceName;
    changed = true;
  }
  if (typeof info.activeFilePath === 'string' || info.activeFilePath === null) {
    if (info.activeFilePath !== S.activeFilePath) {
      S.activeFilePath = info.activeFilePath;
      changed = true;
    }
  }
  if (changed) {
    setWorkspaceName(S.workspaceName);
    refreshWsBar();
    S.fileDirs = {};
    S.currentFile = null;
    if (isView('files')) {
      $('file-viewer').hidden = true;
      $('file-tree').hidden = false;
      loadFiles('', true);
    }
  }
}

/* ============================================================
   8. 输入区四选择器（模式 / 渠道 / 模型 / 思考强度）
   ============================================================ */
function renderComposerMeta() {
  var el = $('composer-meta');
  if (!el) return;
  el.innerHTML = '';
  el.appendChild(buildModeChip());
  el.appendChild(buildChannelChip());
  el.appendChild(buildModelChip());
  el.appendChild(buildThinkingChip());
}
function selChip(label, value, onClick) {
  var btn = el('button', { class: 'sel-chip' });
  btn.appendChild(el('span', { class: 'sel-label', text: label }));
  btn.appendChild(el('span', { class: 'sel-value', text: value || '—' }));
  var arrow = el('span', { class: 'sel-arrow' });
  arrow.innerHTML = icon('chevronDown');
  btn.appendChild(arrow);
  btn.addEventListener('click', safe(onClick));
  return btn;
}
function findConfig(id) {
  for (var i = 0; i < S.configs.length; i++) if (S.configs[i].id === id) return S.configs[i];
  return null;
}
function buildModeChip() {
  var mode = null;
  for (var i = 0; i < S.promptModes.length; i++) {
    if (S.promptModes[i].id === S.currentModeId) { mode = S.promptModes[i]; break; }
  }
  return selChip(t('selMode'), mode ? mode.name : (S.currentModeId || t('selModeDefault')), openModeSheet);
}
function buildChannelChip() {
  var cfg = findConfig(S.activeChannelId);
  return selChip(t('selChannel'), cfg ? (cfg.name || cfg.id) : t('selChannelNone'), openChannelSheet);
}
function buildModelChip() {
  var models = S.activeChannelId ? (S.configModels[S.activeChannelId] || []) : [];
  var modelName = S.selectedModelId || '';
  var cur = null;
  for (var i = 0; i < models.length; i++) {
    if (models[i].id === modelName) { cur = models[i]; break; }
  }
  return selChip(t('selModel'), cur ? (cur.name || cur.id) : (modelName || t('selModelAuto')), openModelSheet);
}
function buildThinkingChip() {
  return selChip(t('selThinking'), S.thinkingLevel || t('selThinkingAuto'), openThinkingSheet);
}
function openModeSheet() {
  openSheet(t('selModeTitle'), function (list) {
    if (S.promptModes.length === 0) {
      sheetHint(list, t('loadFailed'));
      return;
    }
    S.promptModes.forEach(function (mode) {
      sheetItem(list, mode.name || mode.id, mode.id, mode.id === S.currentModeId, function () {
        S.currentModeId = mode.id;
        renderComposerMeta();
        toast(t('modeChanged'));
      });
    });
  });
}
function openChannelSheet() {
  openSheet(t('selChannelTitle'), function (list) {
    if (S.configs.length === 0) {
      sheetHint(list, t('noConfigs'));
      return;
    }
    S.configs.forEach(function (cfg) {
      sheetItem(list, cfg.name || cfg.id, cfg.model || '', cfg.id === S.activeChannelId, function () {
        S.activeChannelId = cfg.id;
        S.selectedModelId = null;
        S.configModels[cfg.id] = S.configModels[cfg.id] || [];
        renderComposerMeta();
        loadConfigModels(cfg.id);
        toast(t('channelChanged'));
      });
    });
  });
}
function openModelSheet() {
  var models = S.activeChannelId ? (S.configModels[S.activeChannelId] || []) : [];
  openSheet(t('selModelTitle'), function (list) {
    if (!S.activeChannelId) {
      sheetHint(list, t('noConfigs'));
      return;
    }
    var auto = el('button', { class: 'sheet-item' + (!S.selectedModelId ? ' selected' : '') });
    auto.appendChild(el('span', { text: t('selModelAuto') }));
    if (!S.selectedModelId) {
      var chk = el('span', { class: 'si-check' });
      chk.innerHTML = icon('check');
      auto.appendChild(chk);
    }
    auto.addEventListener('click', function () {
      closeSheet();
      S.selectedModelId = null;
      renderComposerMeta();
    });
    list.appendChild(auto);
    if (models.length === 0) {
      sheetHint(list, t('noModels'));
      return;
    }
    models.forEach(function (m) {
      sheetItem(list, m.name || m.id, m.id, m.id === S.selectedModelId, function () {
        S.selectedModelId = m.id;
        renderComposerMeta();
        toast(t('modelChanged'));
      });
    });
  });
}
function openThinkingSheet() {
  openSheet(t('selThinkingTitle'), function (list) {
    if (S.thinkingOptions.length === 0) {
      sheetHint(list, t('noData'));
      return;
    }
    S.thinkingOptions.forEach(function (opt) {
      sheetItem(list, opt.label, '', opt.value === S.thinkingLevel, function () {
        setThinkingLevel(opt.value);
      });
    });
  });
}
/* 思考强度（与桌面端 ThinkingSelector 同源语义） */
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
  if (!S.activeChannelId) return;
  var cfg = findConfig(S.activeChannelId);
  var updates = buildThinkingUpdates(cfg, level);
  if (!updates) return;
  post('/api/config-update', { configId: S.activeChannelId, updates: updates })
    .then(function () {
      S.thinkingLevel = level;
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
    S.configs = Array.isArray(data.configs) ? data.configs : [];
    syncThinkingState();
    renderComposerMeta();
    if (S.activeChannelId && !S.configModels[S.activeChannelId]) {
      loadConfigModels(S.activeChannelId);
    }
    if (isView('settings') && S.settingsTab === 'channel') renderAllSettingsSections();
    return data;
  }).catch(function () {
    renderComposerMeta();
    return Promise.reject(new Error('configs'));
  });
}
var modelsLoaded = {};
function loadConfigModels(configId) {
  if (!configId) return;
  if (modelsLoaded[configId]) return;
  modelsLoaded[configId] = true;
  api('/api/config?configId=' + encodeURIComponent(configId))
    .then(function (data) {
      var cfg = data.config || {};
      var models = Array.isArray(cfg.models) ? cfg.models : [];
      S.configModels[configId] = models;
      syncThinkingFromConfig(configId, cfg);
      renderComposerMeta();
    })
    .catch(function () {
      modelsLoaded[configId] = false;
    });
}
function syncThinkingState() {
  if (!S.activeChannelId) return;
  var cfg = findConfig(S.activeChannelId);
  if (!cfg) return;
  S.thinkingOptions = thinkingOptionsFor(cfg.type);
  S.thinkingLevel = currentThinkingOf(cfg);
  renderComposerMeta();
}
function syncThinkingFromConfig(configId, cfg) {
  if (configId !== S.activeChannelId || !cfg) return;
  S.thinkingOptions = thinkingOptionsFor(cfg.type);
  S.thinkingLevel = currentThinkingOf(cfg);
  renderComposerMeta();
}
function loadPromptModes() {
  api('/api/prompt-modes').then(function (data) {
    S.promptModes = Array.isArray(data.modes) ? data.modes : [];
    if (data.currentModeId && !S.currentModeId) {
      S.currentModeId = data.currentModeId;
    }
    if (S.promptModes.length > 0 && !S.currentModeId) {
      S.currentModeId = S.promptModes[0].id;
    }
    renderComposerMeta();
  }).catch(function () {});
}

/* ============================================================
   9. 文件页（工作区）
   ============================================================ */
function renderFileTree(path, entries) {
  var root = $('file-tree');
  if (!root) return;
  root.innerHTML = '';
  if (!S.workspaceUri && !S.workspaceName) {
    var hint = el('div', { class: 'conv-empty' });
    var ico = el('div');
    ico.innerHTML = icon('folder');
    hint.appendChild(ico);
    hint.appendChild(el('div', { text: t('noWorkspace') }));
    hint.appendChild(el('div', { class: 'hint-sm', text: t('noWorkspaceHint') }));
    root.appendChild(hint);
    var openBtn = el('button', { class: 'btn', text: t('switchWorkspace') });
    openBtn.addEventListener('click', function () { openWorkspaceSheet(); });
    hint.appendChild(openBtn);
    return;
  }
  if (path !== '') {
    var up = el('button', { class: 'fdir-row' });
    var upIcon = el('span', { class: 'fico' });
    upIcon.innerHTML = icon('folderUp');
    up.appendChild(upIcon);
    up.appendChild(el('span', { class: 'fname', text: t('back') + ' · ' + path }));
    up.addEventListener('click', function () { S.fileDirs = {}; loadFiles('', true); });
    root.appendChild(up);
  } else {
    var home = el('button', { class: 'fdir-row' });
    var homeIcon = el('span', { class: 'fico' });
    homeIcon.innerHTML = icon('folder');
    home.appendChild(homeIcon);
    home.appendChild(el('span', { class: 'fname', text: t('workspaceRoot') }));
    root.appendChild(home);
  }
  (entries || []).forEach(function (entry) {
    var isDir = entry.type === 'directory';
    var row = el('button', { class: 'fdir-row' });
    var caret = el('span', { class: 'caret-svg' });
    var fico = el('span', { class: 'fico' });
    if (isDir) {
      caret.innerHTML = icon('chevronRight');
      fico.innerHTML = icon('folder');
    } else {
      fico.innerHTML = icon('file');
    }
    row.appendChild(caret);
    row.appendChild(fico);
    row.appendChild(el('span', { class: 'fname', text: entry.name }));
    if (typeof entry.size === 'number') {
      row.appendChild(el('span', { class: 'fsize', text: fmtSize(entry.size) }));
    }
    row.addEventListener('click', function () {
      if (isDir) {
        S.fileDirs[path] = entries;
        loadFiles(entry.path, true);
      } else {
        openFile(entry.path);
      }
    });
    root.appendChild(row);
  });
  if ((entries || []).length === 0) {
    root.appendChild(el('div', { class: 'conv-empty', text: t('emptyDir') }));
  }
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
    S.currentFile = { path: data.path || path, content: data.content || '', dirty: false, truncated: !!data.truncated };
    $('file-viewer-path').textContent = S.currentFile.path;
    $('file-editor').value = S.currentFile.content;
    $('file-editor').readOnly = S.currentFile.truncated;
    $('file-viewer-info').textContent = S.currentFile.truncated ? t('fileTooLarge') : fmtSize(S.currentFile.content.length);
    var saveBtn = $('btn-save-file');
    saveBtn.disabled = true;
    saveBtn.textContent = t('save');
    $('file-tree').hidden = true;
    $('file-viewer').hidden = false;
  }).catch(function (err) {
    toast(t('fileReadFailed') + ': ' + (err.message || ''));
  });
}
function saveFile() {
  if (!S.currentFile || S.currentFile.dirty === false) return;
  post('/api/file', { path: S.currentFile.path, content: S.currentFile.content })
    .then(function () {
      S.currentFile.dirty = false;
      var saveBtn = $('btn-save-file');
      saveBtn.disabled = true;
      saveBtn.textContent = t('save');
      toast(t('saved'));
    })
    .catch(function (err) {
      toast(t('saveFailed') + ': ' + (err.message || ''));
    });
}
function openOnDesktop() {
  if (!S.currentFile) return;
  post('/api/open-file', { path: S.currentFile.path }).then(function () {
    toast(t('openOnDesktop'));
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}
/* ---------- 工作区切换 / 新增 ---------- */
function loadWorkspaces() {
  api('/api/workspaces').then(function (data) {
    S.workspaces = data;
    renderWorkspaceSheet();
  }).catch(function () {
    renderWorkspaceSheet();
  });
}
function openWorkspaceSheet() {
  loadWorkspaces();
  var lm = $('sheet-list-mode');
  var bm = $('sheet-browse-mode');
  if (lm) lm.hidden = false;
  if (bm) bm.hidden = true;
  $('sheet').classList.add('open');
  $('sheet-title').textContent = t('switchWorkspace');
  var list = $('sheet-list');
  list.innerHTML = '';
  list.appendChild(el('div', { class: 'sheet-hint', text: t('loading') }));
}
function renderWorkspaceSheet() {
  var list = $('sheet-list');
  if (!list) return;
  list.innerHTML = '';
  var data = S.workspaces || {};
  var openList = Array.isArray(data.workspaces) ? data.workspaces : [];
  var savedList = Array.isArray(data.saved) ? data.saved : [];
  var activeUri = data.activeWorkspaceUri || '';
  var shown = {};
  openList.forEach(function (w) {
    shown[w.uri || ''] = true;
    sheetItem(list, w.name || w.uri || '', w.uri || '', (w.uri || '') === activeUri, function () {
      post('/api/workspace-switch', { workspaceUri: w.uri }).then(function () {
        toast(t('workspaceOpened'));
        closeSheet();
        S.fileDirs = {};
        S.currentFile = null;
        if (isView('files')) { $('file-viewer').hidden = true; $('file-tree').hidden = false; loadFiles('', true); }
      }).catch(function (err) {
        toast(t('workspaceNotFound') + ': ' + (err.message || ''));
      });
    });
  });
  savedList.forEach(function (w) {
    if (shown[w.uri || '']) return;
    shown[w.uri || ''] = true;
    sheetItem(list, w.name || w.uri || '', w.uri || '', false, function () {
      post('/api/workspace-switch', { workspaceUri: w.uri }).then(function () {
        toast(t('workspaceOpened'));
        closeSheet();
        S.fileDirs = {};
        S.currentFile = null;
        if (isView('files')) { $('file-viewer').hidden = true; $('file-tree').hidden = false; loadFiles('', true); }
      }).catch(function (err) {
        toast(t('workspaceNotFound') + ': ' + (err.message || ''));
      });
    });
  });
  if (openList.length === 0 && savedList.length === 0) {
    sheetHint(list, t('noWorkspace'));
  }
  var row = el('div', { class: 'sheet-actions' });
  var browseBtn = el('button', { class: 'btn', text: t('browseFolder') });
  browseBtn.addEventListener('click', function () {
    closeSheet();
    openBrowse();
  });
  var addBtn = el('button', { class: 'btn', text: t('addWorkspace') });
  addBtn.addEventListener('click', function () { addWorkspace(); });
  row.appendChild(browseBtn);
  row.appendChild(addBtn);
  list.appendChild(row);
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
/* ---------- 目录浏览（自选工作区） ---------- */
function openBrowse() {
  $('sheet-list-mode').hidden = true;
  $('sheet-browse-mode').hidden = false;
  $('sheet').classList.add('open');
  $('sheet-title').textContent = t('browseTitle');
  loadFsDir('');
}
function loadFsDir(rawPath) {
  if (S.browseBusy) return;
  S.browseBusy = true;
  var q = rawPath ? '?path=' + encodeURIComponent(rawPath) : '';
  api('/api/fs' + q).then(function (data) {
    S.browseBusy = false;
    S.browsePath = data.path || '';
    S.browseParent = data.parent || null;
    S.browseDrives = Array.isArray(data.drives) ? data.drives : [];
    $('browse-path').textContent = data.path || t('browseRootLabel');
    var list = $('browse-list');
    list.innerHTML = '';
    if (S.browseParent) {
      var up = el('button', { class: 'fdir-row' });
      var upIcon = el('span', { class: 'fico' });
      upIcon.innerHTML = icon('folderUp');
      up.appendChild(upIcon);
      up.appendChild(el('span', { class: 'fname', text: t('browseUp') }));
      up.addEventListener('click', function () { loadFsDir(S.browseParent); });
      list.appendChild(up);
    }
    if (data.drives && data.drives.length) {
      list.appendChild(el('div', { class: 'sheet-hint', text: t('browseDrivesLabel') }));
      data.drives.forEach(function (drive) {
        var d = el('button', { class: 'fdir-row' });
        var dIcon = el('span', { class: 'fico' });
        dIcon.innerHTML = icon('folder');
        d.appendChild(dIcon);
        d.appendChild(el('span', { class: 'fname', text: drive }));
        d.addEventListener('click', function () { loadFsDir(drive); });
        list.appendChild(d);
      });
    }
    (data.entries || []).forEach(function (entry) {
      var row = el('button', { class: 'fdir-row' });
      var rIcon = el('span', { class: 'fico' });
      rIcon.innerHTML = icon('folder');
      row.appendChild(rIcon);
      row.appendChild(el('span', { class: 'fname', text: entry.name }));
      row.addEventListener('click', function () { loadFsDir(entry.path); });
      list.appendChild(row);
    });
    var pick = el('button', { class: 'btn', text: t('chooseThisFolder') });
    pick.addEventListener('click', pickBrowseFolder);
    list.appendChild(pick);
  }).catch(function (err) {
    S.browseBusy = false;
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}
function pickBrowseFolder() {
  if (!S.browsePath || S.browseBusy) return;
  post('/api/workspace-add', { fsPath: S.browsePath }).then(function (data) {
    if (data && data.canceled) return;
    toast(t('workspaceOpened'));
    closeSheet();
    S.currentFile = null;
    S.fileDirs = {};
    if (isView('files')) { $('file-viewer').hidden = true; $('file-tree').hidden = false; loadFiles('', true); }
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}

/* ============================================================
   10. 设置页（schema 驱动，字段路径与桌面端 SettingsPanel 对齐）
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
/* 设置页分类加载器（每个分类一个函数，读 S.settings 渲染） */
function renderSettingsTabs() {
  var bar = $('settings-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  SETTINGS_CATEGORIES.forEach(function (cat) {
    var btn = el('button', {
      class: 'set-tab' + (cat.key === S.settingsTab ? ' active' : ''),
      'data-set-tab': cat.key,
      text: t(cat.labelKey)
    });
    btn.addEventListener('click', function () {
      S.settingsTab = cat.key;
      renderSettingsTabs();
      renderAllSettingsSections();
    });
    bar.appendChild(btn);
  });
}
function openSettings() {
  renderSettingsTabs();
  renderAllSettingsSections();
  loadConfigs();
  if (!S.settings) {
    loadSettings();
    loadToolsList();
    loadDeps();
  }
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
  post('/api/settings', { settings: patch }).then(function (data) {
    S.settings = data.settings || S.settings;
    if (extra) extra(data.settings);
    if (isView('settings')) renderAllSettingsSections();
    toast(t('settingsSaved'));
  }).catch(function (err) {
    if (isView('settings')) renderAllSettingsSections();
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
function secCard(titleKey) {
  var card = el('div', { class: 'card settings-sec' });
  card.appendChild(el('h3', { text: t(titleKey) }));
  $('settings-sections').appendChild(card);
  return card;
}
function renderField(sec, f) {
  var row = el('div', { class: 'set-field', 'data-p': JSON.stringify(f.p) });
  row.appendChild(el('span', { class: 'k', text: t(f.t) }));
  var ctl = el('span', { class: 'ctl' });
  row.appendChild(ctl);
  sec.appendChild(row);
  var value = getVal(S.settings, f.p);
  if (f.w === 'toggle') {
    var wrap = el('label', { class: 'tgl' });
    var input = el('input', { type: 'checkbox' });
    input.checked = value === true;
    wrap.appendChild(input);
    wrap.appendChild(el('span', { class: 'tr' }));
    ctl.appendChild(wrap);
    input.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, input.checked));
    });
  } else if (f.w === 'select' || f.w === 'promptMode') {
    var sel = el('select');
    var options = f.w === 'promptMode' ? promptModeOptions() : (f.o || []);
    (options || []).forEach(function (o) {
      sel.appendChild(el('option', { value: o, text: o }));
    });
    sel.value = value != null ? String(value) : '';
    if (sel.value === '' && options && options.length) sel.value = options[0];
    ctl.appendChild(sel);
    sel.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, sel.value));
    });
  } else if (f.w === 'configSelect') {
    var sel2 = el('select');
    sel2.appendChild(el('option', { value: '', text: '—' }));
    (S.configs || []).forEach(function (c) {
      sel2.appendChild(el('option', { value: c.id, text: c.name || c.id }));
    });
    sel2.value = value != null ? String(value) : '';
    ctl.appendChild(sel2);
    sel2.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, sel2.value || undefined));
    });
  } else if (f.w === 'number') {
    var num = el('input', { type: 'number' });
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
      if (raw === '' || !isFinite(v)) {
        num.value = value != null ? String(value) : '';
        toast(t('settingsFailed'));
        return;
      }
      if (f.min != null && v < f.min) v = f.min;
      if (f.max != null && v > f.max) v = f.max;
      num.value = String(v);
      saveSettingsPatch(patchFor(f.p, v));
    });
  } else if (f.w === 'textarea') {
    var ta = el('textarea', { spellcheck: 'false' });
    ta.placeholder = t('keepBlank');
    ta.value = value != null ? String(value) : '';
    ctl.appendChild(ta);
    ta.addEventListener('change', function () {
      saveSettingsPatch(patchFor(f.p, ta.value));
    });
  } else if (f.w === 'chips') {
    var wrap2 = el('div', { class: 'chips' });
    var values = Array.isArray(value) ? value.slice() : [];
    function renderChips() {
      wrap2.innerHTML = '';
      values.forEach(function (v, i) {
        var chip = el('span', { class: 'chip' });
        chip.appendChild(document.createTextNode(v));
        var rm = el('button', { type: 'button', class: 'chip-x', text: '×' });
        rm.addEventListener('click', function () {
          values.splice(i, 1);
          saveSettingsPatch(patchFor(f.p, values.slice()));
          renderChips();
        });
        chip.appendChild(rm);
        wrap2.appendChild(chip);
      });
      var addRow = el('div', { class: 'chip-input' });
      var input2 = el('input', { type: 'text', placeholder: t('chipsHint') });
      var btn = el('button', { type: 'button', class: 'mini-btn', text: t('chipAdd') });
      function addChip() {
        var v = input2.value.trim();
        if (!v || values.indexOf(v) >= 0) return;
        values.push(v);
        input2.value = '';
        saveSettingsPatch(patchFor(f.p, values.slice()));
        renderChips();
      }
      btn.addEventListener('click', addChip);
      input2.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addChip(); }
      });
      addRow.appendChild(input2);
      addRow.appendChild(btn);
      wrap2.appendChild(addRow);
    }
    renderChips();
    ctl.appendChild(wrap2);
  } else if (f.w === 'checklist') {
    /* 多选列表：items 为 {value,label}，value 为当前选中集合 */
    var curVals = Array.isArray(value) ? value : [];
    var items = f.items || [];
    var box = el('div', { class: 'checklist' });
    function toggleVal(v) {
      var idx = curVals.indexOf(v);
      if (idx >= 0) curVals.splice(idx, 1);
      else curVals.push(v);
      saveSettingsPatch(patchFor(f.p, curVals.slice()));
    }
    items.forEach(function (it) {
      var rowItem = el('label', { class: 'chk-row' });
      var cb = el('input', { type: 'checkbox' });
      cb.checked = curVals.indexOf(it.value) >= 0;
      cb.addEventListener('change', function () { toggleVal(it.value); });
      rowItem.appendChild(cb);
      rowItem.appendChild(el('span', { text: it.label }));
      box.appendChild(rowItem);
    });
    ctl.appendChild(box);
  } else if (f.w === 'profileToggles') {
    /* 对象布尔映射（检查点排除类别）：value 为 {key: bool} */
    var profiles = (value && typeof value === 'object') ? value : {};
    var items2 = f.items || [];
    var box2 = el('div', { class: 'checklist' });
    items2.forEach(function (it) {
      var rowItem = el('label', { class: 'chk-row' });
      var cb = el('input', { type: 'checkbox' });
      cb.checked = profiles[it.value] !== false;
      cb.addEventListener('change', function () {
        var next = {};
        Object.keys(profiles).forEach(function (k) { next[k] = profiles[k]; });
        next[it.value] = cb.checked;
        saveSettingsPatch(patchFor(f.p, next));
      });
      rowItem.appendChild(cb);
      rowItem.appendChild(el('span', { text: it.label }));
      box2.appendChild(rowItem);
    });
    ctl.appendChild(box2);
  } else if (f.w === 'ratio') {
    /* 百分比输入（5-95），落库 0-1 小数（与桌面端 SummarizeSettings 一致） */
    var ratioVal = (typeof value === 'number') ? Math.round(value * 100) : 50;
    var ratio = el('input', { type: 'number', min: '5', max: '95', step: '1' });
    ratio.value = String(ratioVal);
    ctl.appendChild(ratio);
    ratio.addEventListener('change', function () {
      var raw = ratio.value.trim();
      var v = Number(raw);
      if (raw === '' || !isFinite(v)) {
        ratio.value = String(ratioVal);
        toast(t('settingsFailed'));
        return;
      }
      if (v < 5) v = 5;
      if (v > 95) v = 95;
      ratio.value = String(v);
      saveSettingsPatch(patchFor(f.p, v / 100));
    });
  } else {
    var inp = el('input', { type: f.w === 'password' ? 'password' : 'text' });
    if (f.w === 'password') {
      inp.autocomplete = 'new-password';
      inp.placeholder = value ? t('apiKeySet') : '';
    } else {
      inp.placeholder = t('keepBlank');
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
  var modes = getVal(S.settings, ['toolsConfig', 'system_prompt', 'modes']);
  if (!modes || typeof modes !== 'object') return [];
  var out = [];
  Object.keys(modes).forEach(function (k) {
    var m = modes[k];
    if (m && typeof m === 'object') out.push(m.id || k);
  });
  return out;
}
function renderSimpleSection(titleKey, fields) {
  var card = secCard(titleKey);
  fields.forEach(function (f) { renderField(card, f); });
}
function itemToggle(checked, onChange) {
  var wrap = el('label', { class: 'tgl' });
  var input = el('input', { type: 'checkbox' });
  input.checked = checked;
  wrap.appendChild(input);
  wrap.appendChild(el('span', { class: 'tr' }));
  input.addEventListener('change', function () { onChange(input.checked); });
  return wrap;
}
function renderToolsSections() {
  var card = secCard('secTools');
  if (!S.tools || S.tools.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noData') }));
  } else {
    S.tools.forEach(function (tool) {
      var row = el('div', { class: 'item-row' });
      var td = el('div', { class: 't' });
      td.appendChild(el('div', { class: 'name', text: tool.name }));
      if (tool.description) td.appendChild(el('div', { class: 'sub', text: tool.description }));
      row.appendChild(td);
      row.appendChild(itemToggle(tool.enabled, function (v) {
        saveSettingsPatch(patchFor(['toolsEnabled', tool.name], v));
      }));
      card.appendChild(row);
    });
  }
  var autoCard = secCard('secAutoExec');
  if (!S.autoExec || Object.keys(S.autoExec).length === 0) {
    autoCard.appendChild(el('div', { class: 'info-text', text: t('noData') }));
  } else {
    Object.keys(S.autoExec).forEach(function (name) {
      var row = el('div', { class: 'item-row' });
      var td = el('div', { class: 't' });
      td.appendChild(el('div', { class: 'name', text: name }));
      row.appendChild(td);
      row.appendChild(itemToggle(S.autoExec[name] === true, function (v) {
        saveSettingsPatch(patchFor(['toolAutoExec', name], v));
      }));
      autoCard.appendChild(row);
    });
  }
}
function renderTokenSection() {
  var tc = getVal(S.settings, ['toolsConfig', 'token_count']);
  if (!tc || typeof tc !== 'object') return;
  var card = secCard('secTokenCount');
  Object.keys(tc).forEach(function (ch) {
    card.appendChild(el('div', { class: 'set-note', text: ch }));
    renderField(card, { t: 'fldTokEnabled', p: ['toolsConfig', 'token_count', ch, 'enabled'], w: 'toggle' });
    renderField(card, { t: 'fldTokUrl', p: ['toolsConfig', 'token_count', ch, 'baseUrl'], w: 'text' });
    renderField(card, { t: 'fldTokModel', p: ['toolsConfig', 'token_count', ch, 'model'], w: 'text' });
    renderField(card, { t: 'fldTokKey', p: ['toolsConfig', 'token_count', ch, 'apiKey'], w: 'password' });
  });
}
function renderImageGenSection() {
  var ig = getVal(S.settings, ['toolsConfig', 'generate_image']);
  if (!ig || typeof ig !== 'object') return;
  var card = secCard('secImageGen');
  [
    { t: 'fldImgUrl', p: ['toolsConfig', 'generate_image', 'url'], w: 'text' },
    { t: 'fldImgModel', p: ['toolsConfig', 'generate_image', 'model'], w: 'text' },
    { t: 'fldImgKey', p: ['toolsConfig', 'generate_image', 'apiKey'], w: 'password' },
    { t: 'fldImgAspect', p: ['toolsConfig', 'generate_image', 'enableAspectRatio'], w: 'toggle' },
    { t: 'fldImgSize', p: ['toolsConfig', 'generate_image', 'enableImageSize'], w: 'toggle' },
    { t: 'fldImgMaxBatch', p: ['toolsConfig', 'generate_image', 'maxBatchTasks'], w: 'number', min: 1 },
    { t: 'fldImgMaxPerTask', p: ['toolsConfig', 'generate_image', 'maxImagesPerTask'], w: 'number', min: 1 },
    { t: 'fldImgReturn', p: ['toolsConfig', 'generate_image', 'returnImageToAI'], w: 'toggle' }
  ].forEach(function (f) { renderField(card, f); });
}
function renderSkillsSection() {
  var skills = getVal(S.settings, ['toolsConfig', 'skills', 'skills']);
  var card = secCard('secSkills');
  if (!Array.isArray(skills) || skills.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noData') }));
    return;
  }
  skills.forEach(function (sk, i) {
    var row = el('div', { class: 'item-row' });
    var td = el('div', { class: 't' });
    td.appendChild(el('div', { class: 'name', text: sk.name || sk.id || '' }));
    if (sk.description || sk.id) td.appendChild(el('div', { class: 'sub', text: sk.description || sk.id }));
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
    { t: 'fldSubMaxConcurrent', p: ['toolsConfig', 'subagents', 'maxConcurrentAgents'], w: 'number', min: -1 },
    { t: 'fldSubFailureMode', p: ['toolsConfig', 'subagents', 'failureModeAfterRetries'], w: 'select', o: ['fail_parent_tool', 'wait_for_monitor_action'] },
    { t: 'fldSubGeneralWorker', p: ['toolsConfig', 'subagents', 'generalWorkerEnabled'], w: 'toggle' },
    { t: 'fldSubDefaultIterations', p: ['toolsConfig', 'subagents', 'defaultMaxIterations'], w: 'number', min: -1 },
    { t: 'fldSubDefaultRuntime', p: ['toolsConfig', 'subagents', 'defaultMaxRuntime'], w: 'number', min: -1 }
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
  var info = S.statusInfo || {};
  [
    { k: t('connection'), v: info.running ? t('running') : t('stopped') },
    { k: t('port'), v: String(info.port != null ? info.port : '') },
    { k: t('appVersion'), v: S.appVersion || '' }
  ].forEach(function (row) {
    var r = el('div', { class: 'set-row' });
    r.appendChild(el('span', { text: row.k }));
    r.appendChild(el('span', { class: 'dim', text: row.v }));
    card.appendChild(r);
  });
  var urls = Array.isArray(info.urls) ? info.urls : [];
  if (urls.length > 0) {
    card.appendChild(el('div', { class: 'set-row', text: t('accessUrls') }));
    urls.forEach(function (url) {
      var chip = el('button', { class: 'chip', text: url });
      chip.addEventListener('click', function () { copyText(url); });
      card.appendChild(chip);
    });
  }
  card.appendChild(el('div', { class: 'set-note', text: t('securityText') }));
  var actions = el('div', { class: 'sheet-actions' });
  var restart = el('button', { class: 'btn', text: t('fldRcRestart') });
  restart.addEventListener('click', function () {
    post('/api/remote-action', { type: 'restart' }).then(function () {
      toast(t('fldRcRestart') + ' ✓');
      S.serverStopped = true;
      probeServerRecovery();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  var stop = el('button', { class: 'btn danger', text: t('fldRcStop') });
  stop.addEventListener('click', function () {
    post('/api/remote-action', { type: 'stop' }).then(function () {
      toast(t('fldRcStop') + ' ✓');
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  actions.appendChild(restart);
  actions.appendChild(stop);
  card.appendChild(actions);
}
function renderStorageSection() {
  var card = secCard('secStorage');
  renderField(card, { t: 'fldStoragePath', p: ['storagePath', 'customDataPath'], w: 'text' });
  card.appendChild(el('div', { class: 'set-note', text: t('fldMigration') }));
}
function renderDepsSection() {
  var card = secCard('secDeps');
  if (!S.deps || S.deps.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noData') }));
    return;
  }
  S.deps.forEach(function (dep) {
    var row = el('div', { class: 'item-row' });
    var td = el('div', { class: 't' });
    td.appendChild(el('div', { class: 'name', text: dep.name || '' }));
    if (dep.installedVersion) td.appendChild(el('div', { class: 'sub', text: dep.installedVersion }));
    row.appendChild(td);
    row.appendChild(el('span', {
      class: 'chip',
      text: dep.installed ? t('depInstalled') : t('depMissing'),
      style: 'color:' + (dep.installed ? 'var(--green)' : 'var(--red)')
    }));
    card.appendChild(row);
  });
}
/* ---------- 检查点（toolsConfig.checkpoint.*，与桌面端 CheckpointSettings 对齐） ---------- */
var CKPT_MESSAGE_TYPES = [
  { value: 'user', labelKey: 'msgTypeUser' },
  { value: 'model', labelKey: 'msgTypeModel' }
];
var CKPT_PROFILES = [
  { value: 'logs', labelKey: 'ckptProfileLogs' },
  { value: 'aiModels', labelKey: 'ckptProfileAiModels' },
  { value: 'datasets', labelKey: 'ckptProfileDatasets' },
  { value: 'caches', labelKey: 'ckptProfileCaches' },
  { value: 'pythonVenvs', labelKey: 'ckptProfilePythonVenvs' },
  { value: 'buildArtifacts', labelKey: 'ckptProfileBuildArtifacts' },
  { value: 'largeMedia', labelKey: 'ckptProfileLargeMedia' },
  { value: 'archives', labelKey: 'ckptProfileArchives' }
];
function checkpointToolItems() {
  if (S.tools && S.tools.length) {
    return S.tools.map(function (tool) {
      return { value: tool.name, label: tool.name };
    });
  }
  return [
    'apply_diff', 'write_file', 'insert_code', 'delete_file', 'delete_code',
    'create_directory', 'execute_command', 'search_in_files', 'generate_image',
    'remove_background', 'crop_image', 'resize_image', 'rotate_image',
    'create_plan', 'update_plan', 'create_design', 'update_design',
    'create_progress', 'update_progress', 'record_progress_milestone',
    'create_review', 'record_review_milestone', 'finalize_review', 'reopen_review'
  ].map(function (name) { return { value: name, label: name }; });
}
function renderCheckpointSection() {
  renderSimpleSection('ckptEnable', [
    { t: 'fldCkptEnabled', p: ['toolsConfig', 'checkpoint', 'enabled'], w: 'toggle' },
    { t: 'fldCkptMax', p: ['toolsConfig', 'checkpoint', 'maxCheckpoints'], w: 'number', min: -1 }
  ]);
  var msgCard = secCard('ckptMessages');
  renderField(msgCard, {
    t: 'ckptMsgBefore',
    p: ['toolsConfig', 'checkpoint', 'messageCheckpoint', 'beforeMessages'],
    w: 'checklist',
    items: CKPT_MESSAGE_TYPES.map(function (m) { return { value: m.value, label: t(m.labelKey) }; })
  });
  renderField(msgCard, {
    t: 'ckptMsgAfter',
    p: ['toolsConfig', 'checkpoint', 'messageCheckpoint', 'afterMessages'],
    w: 'checklist',
    items: CKPT_MESSAGE_TYPES.map(function (m) { return { value: m.value, label: t(m.labelKey) }; })
  });
  renderField(msgCard, { t: 'ckptModelOuter', p: ['toolsConfig', 'checkpoint', 'messageCheckpoint', 'modelOuterLayerOnly'], w: 'toggle' });
  renderField(msgCard, { t: 'ckptMergeUnchanged', p: ['toolsConfig', 'checkpoint', 'messageCheckpoint', 'mergeUnchangedCheckpoints'], w: 'toggle' });
  var toolCard = secCard('ckptTools');
  renderField(toolCard, {
    t: 'ckptBeforeTools',
    p: ['toolsConfig', 'checkpoint', 'beforeTools'],
    w: 'checklist',
    items: checkpointToolItems()
  });
  renderField(toolCard, {
    t: 'ckptAfterTools',
    p: ['toolsConfig', 'checkpoint', 'afterTools'],
    w: 'checklist',
    items: checkpointToolItems()
  });
  var exCard = secCard('ckptExclusion');
  renderField(exCard, {
    t: 'ckptProfiles',
    p: ['toolsConfig', 'checkpoint', 'exclusion', 'enabledProfiles'],
    w: 'profileToggles',
    items: CKPT_PROFILES.map(function (p) { return { value: p.value, label: t(p.labelKey) }; })
  });
  renderField(exCard, { t: 'ckptMaxSizeMiB', p: ['toolsConfig', 'checkpoint', 'exclusion', 'maxFileSizeBytes'], w: 'number', min: 1 });
  renderField(exCard, { t: 'ckptCustomPatterns', p: ['toolsConfig', 'checkpoint', 'exclusion', 'customPatterns'], w: 'chips' });
}
/* ---------- 渠道管理 ---------- */
function renderConfigsCard() {
  var card = secCard('secChannel');
  if (S.configs.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noConfigs') }));
  }
  S.configs.forEach(function (cfg) {
    var item = el('div', { class: 'cfg-item' });
    item.appendChild(el('div', { class: 'cname', text: cfg.name || cfg.id || '' }));
    item.appendChild(el('div', {
      class: 'cmodel',
      text: t('currentModel') + ': ' + (cfg.model || '—') + ' · ' + (cfg.type || '')
    }));
    var ctrl = el('div', { class: 'item-row' });
    var tag = el('span', { class: 't' });
    var isActive = S.activeChannelId === cfg.id;
    tag.textContent = isActive ? t('activeChannel') : (cfg.enabled === false ? t('disabled') : '');
    tag.style.color = isActive ? 'var(--green)' : (cfg.enabled === false ? 'var(--red)' : 'var(--dim)');
    ctrl.appendChild(tag);
    ctrl.appendChild(itemToggle(cfg.enabled !== false, function (v) {
      cfg.enabled = v;
      toggleChannelEnabled(cfg);
    }));
    item.appendChild(ctrl);
    var actions = el('div', { class: 'cfg-actions' });
    if (!isActive) {
      var act = el('button', { class: 'mini-btn', text: t('setActiveChannel') });
      act.addEventListener('click', function () { setChannelActive(cfg); });
      actions.appendChild(act);
    }
    var modelsBtn = el('button', { class: 'mini-btn', text: t('manageModels') });
    modelsBtn.addEventListener('click', function () { openModelsDialog(cfg); });
    actions.appendChild(modelsBtn);
    var editBtn = el('button', { class: 'mini-btn', text: t('editChannel') });
    editBtn.addEventListener('click', function () { editChannel(cfg); });
    actions.appendChild(editBtn);
    var delBtn = el('button', { class: 'mini-btn danger', text: t('deleteChannel') });
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
  var addBtn = el('button', { class: 'add-channel-btn' });
  addBtn.innerHTML = icon('plus') + '<span>' + esc(t('addChannel')) + '</span>';
  addBtn.addEventListener('click', addChannelDialog);
  card.appendChild(addBtn);
}
function addChannelDialog() {
  var modalEl = $('modal');
  $('modal-title').textContent = t('addChannel');
  var inputEl = $('modal-input');
  var bodyEl = $('modal-body');
  bodyEl.innerHTML = '';
  inputEl.hidden = true;
  var nameWrap = el('div', { class: 'set-field' });
  nameWrap.appendChild(el('span', { class: 'k', text: t('channelName') }));
  var nameInput = el('input', { type: 'text', placeholder: 'My Channel' });
  nameWrap.appendChild(nameInput);
  bodyEl.appendChild(nameWrap);
  var typeWrap = el('div', { class: 'set-field' });
  typeWrap.appendChild(el('span', { class: 'k', text: t('channelType') }));
  var typeSel = el('select');
  [
    { v: 'gemini', label: 'Google Gemini' },
    { v: 'openai', label: 'OpenAI Compatible' },
    { v: 'openai-responses', label: 'OpenAI Responses API' },
    { v: 'anthropic', label: 'Anthropic Claude' }
  ].forEach(function (o) {
    typeSel.appendChild(el('option', { value: o.v, text: o.label }));
  });
  typeWrap.appendChild(typeSel);
  bodyEl.appendChild(typeWrap);
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('createChannel');
  $('modal-ok').className = 'btn';
  modalEl._onOk = function () {
    var name = nameInput.value.trim();
    if (!name) { toast(t('channelNameRequired')); return; }
    post('/api/config-create', { type: typeSel.value, name: name }).then(function () {
      toast(t('channelCreated'));
      closeModal();
      loadConfigs();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  };
  modalEl.classList.add('open');
  setTimeout(function () { nameInput.focus(); }, 60);
}
function editChannel(cfg) {
  var modalEl = $('modal');
  $('modal-title').textContent = t('editChannel') + ': ' + (cfg.name || cfg.id);
  var inputEl = $('modal-input');
  var bodyEl = $('modal-body');
  bodyEl.innerHTML = '';
  inputEl.hidden = true;
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
    var wrap = el('div', { class: 'set-field' });
    wrap.appendChild(el('span', { class: 'k', text: f.label }));
    var ctl = el('span', { class: 'ctl' });
    if (f.type === 'select') {
      var sel = el('select');
      f.options.forEach(function (o) { sel.appendChild(el('option', { value: o, text: o })); });
      ctl.appendChild(sel);
      values[f.key] = sel;
    } else if (f.type === 'number') {
      var num = el('input', { type: 'number', min: '0' });
      ctl.appendChild(num);
      values[f.key] = num;
    } else {
      var inp = el('input', { type: f.type });
      if (f.type === 'password') inp.autocomplete = 'new-password';
      ctl.appendChild(inp);
      values[f.key] = inp;
    }
    wrap.appendChild(ctl);
    bodyEl.appendChild(wrap);
  });
  loadChannelDetail(cfg.id, function (detail) {
    if (!detail) return;
    var apply = {
      name: detail.name || cfg.name || '',
      url: detail.url || '',
      apiKey: detail.apiKey || '',
      toolMode: detail.toolMode || 'function_call',
      timeout: detail.timeout != null ? String(detail.timeout) : '',
      maxContextTokens: detail.maxContextTokens != null ? String(detail.maxContextTokens) : ''
    };
    Object.keys(apply).forEach(function (k) {
      var ctlEl = values[k];
      if (ctlEl) {
        if (ctlEl.tagName === 'SELECT') ctlEl.value = apply[k] || 'function_call';
        else ctlEl.value = apply[k];
      }
    });
  });
  /* 思考强度 */
  var thinkWrap = el('div', { class: 'set-field' });
  thinkWrap.appendChild(el('span', { class: 'k', text: t('selThinking') }));
  var thinkSel = el('select');
  var thinkCtl = el('span', { class: 'ctl' });
  thinkCtl.appendChild(thinkSel);
  thinkWrap.appendChild(thinkCtl);
  bodyEl.appendChild(thinkWrap);
  var thinkingVal = 'off';
  loadChannelDetail(cfg.id, function (detail) {
    if (!detail) return;
    var opts = thinkingOptionsFor(detail.type);
    thinkSel.innerHTML = '';
    opts.forEach(function (o) {
      thinkSel.appendChild(el('option', { value: o.value, text: o.label }));
    });
    thinkingVal = currentThinkingOf(detail);
    thinkSel.value = thinkingVal;
    if (thinkSel.value === '') thinkSel.value = opts.length ? opts[0].value : 'off';
  });
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('saveChannel');
  $('modal-ok').className = 'btn';
  modalEl._onOk = function () {
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
    loadChannelDetail(cfg.id, function (detail) {
      var thinkingUpdates = buildThinkingUpdates(Object.assign({}, cfg, detail || {}), thinkSel.value || 'off');
      if (thinkingUpdates) {
        updates.options = thinkingUpdates.options;
        updates.optionsEnabled = thinkingUpdates.optionsEnabled;
      }
      post('/api/config-update', { configId: cfg.id, updates: updates }).then(function () {
        toast(t('channelSaved'));
        closeModal();
        loadConfigs();
      }).catch(function (err) {
        toast(t('settingsFailed') + ': ' + (err.message || ''));
      });
    });
  };
  modalEl.classList.add('open');
}
function loadChannelDetail(configId, cb) {
  api('/api/config?configId=' + encodeURIComponent(configId)).then(function (data) {
    cb(data.config || null);
  }).catch(function () { cb(null); });
}
function setChannelActive(cfg) {
  post('/api/channel-active', { configId: cfg.id }).then(function () {
    S.activeChannelId = cfg.id;
    toast(t('setActiveChannel') + ' ✓');
    loadConfigs();
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
function toggleChannelEnabled(cfg) {
  post('/api/channel-toggle', { configId: cfg.id, enabled: cfg.enabled !== false }).then(function () {
    toast((cfg.enabled !== false ? t('enable') : t('disable')) + ' ✓');
    loadConfigs();
  }).catch(function (err) {
    cfg.enabled = !cfg.enabled;
    toast(t('settingsFailed') + ': ' + (err.message || ''));
    if (isView('settings')) renderAllSettingsSections();
  });
}
function deleteChannel(cfg) {
  post('/api/config-delete', { configId: cfg.id }).then(function () {
    toast(t('channelDeleted'));
    if (S.activeChannelId === cfg.id) S.activeChannelId = null;
    loadConfigs();
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
function openModelsDialog(cfg) {
  var modalEl = $('modal');
  $('modal-title').textContent = t('manageModels') + ': ' + (cfg.name || cfg.id);
  var inputEl = $('modal-input');
  var bodyEl = $('modal-body');
  bodyEl.innerHTML = '';
  inputEl.hidden = true;
  var listEl = el('div', { class: 'model-list' });
  bodyEl.appendChild(listEl);
  var curId = cfg.model || '';
  function renderModels() {
    listEl.innerHTML = '';
    var models = S.configModels[cfg.id] || [];
    if (models.length === 0) {
      listEl.appendChild(el('div', { class: 'info-text', text: t('noModels') }));
    }
    models.forEach(function (m) {
      var row = el('div', { class: 'item-row' });
      var td = el('div', { class: 't' });
      td.appendChild(el('div', { class: 'name', text: m.name || m.id || '' }));
      td.appendChild(el('div', { class: 'sub', text: m.id || '' }));
      row.appendChild(td);
      var curTag = el('span', { class: 'chip', text: m.id === curId ? t('activeModel') : t('setActiveModel') });
      curTag.style.cursor = 'pointer';
      curTag.style.color = m.id === curId ? 'var(--green)' : 'var(--dim)';
      curTag.addEventListener('click', function () {
        post('/api/model', { configId: cfg.id, modelId: m.id }).then(function () {
          curId = m.id;
          cfg.model = m.id;
          toast(t('modelChanged'));
          renderModels();
          loadConfigs();
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
      row.appendChild(curTag);
      var rmBtn = el('button', { class: 'mini-btn danger', text: t('remove') });
      rmBtn.addEventListener('click', function () {
        post('/api/models-remove', { configId: cfg.id, modelId: m.id }).then(function () {
          toast(t('removed'));
          loadConfigModels(cfg.id);
          renderModels();
          loadConfigs();
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
      row.appendChild(rmBtn);
      listEl.appendChild(row);
    });
  }
  renderModels();
  var addRow = el('div', { class: 'chip-input' });
  var idInput = el('input', { type: 'text', placeholder: t('modelIdHint') });
  var nameInput = el('input', { type: 'text', placeholder: t('modelNameHint') });
  var addBtn = el('button', { type: 'button', class: 'mini-btn', text: t('addModel') });
  function addModel() {
    var mid = idInput.value.trim();
    if (!mid) { toast(t('modelIdRequired')); return; }
    post('/api/models-add', { configId: cfg.id, models: [{ id: mid, name: nameInput.value.trim() || mid }] }).then(function () {
      toast(t('modelAdded'));
      idInput.value = '';
      nameInput.value = '';
      loadConfigModels(cfg.id);
      renderModels();
      loadConfigs();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  }
  addBtn.addEventListener('click', addModel);
  idInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addModel(); }
  });
  addRow.appendChild(idInput);
  addRow.appendChild(nameInput);
  addRow.appendChild(addBtn);
  bodyEl.appendChild(addRow);
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('done');
  $('modal-ok').className = 'btn';
  modalEl._onOk = function () {
    closeModal();
  };
  modalEl.classList.add('open');
}
/* ---------- 设置页总渲染 ---------- */
function renderAllSettingsSections() {
  var root = $('settings-sections');
  if (!root) return;
  root.innerHTML = '';
  switch (S.settingsTab) {
    case 'channel':
      renderConfigsCard();
      break;
    case 'general':
      renderSimpleSection('secGeneral', [
        { t: 'fldCheckUpdates', p: ['checkForUpdates'], w: 'toggle' },
        { t: 'fldMaxToolIterations', p: ['maxToolIterations'], w: 'number', min: -1 },
        { t: 'fldDefaultToolMode', p: ['defaultToolMode'], w: 'select', o: ['function_call', 'xml', 'json'] },
        { t: 'fldLanguage', p: ['ui', 'language'], w: 'select', o: ['auto', 'zh-CN', 'en', 'ja'] },
        { t: 'fldWorkspaceBehavior', p: ['ui', 'workspaceBehavior'], w: 'select', o: ['restore', 'none'] },
        { t: 'fldTheme', p: ['ui', 'theme'], w: 'select', o: ['auto', 'dark', 'light'] }
      ]);
      renderSimpleSection('secAppearance', [
        { t: 'fldSmoothStreaming', p: ['ui', 'appearance', 'smoothStreaming'], w: 'select', o: ['off', 'balanced', 'smooth'] },
        { t: 'fldSelectionContext', p: ['ui', 'appearance', 'selectionContextEnabled'], w: 'toggle' },
        { t: 'fldTpsBar', p: ['ui', 'appearance', 'tpsBarEnabled'], w: 'toggle' },
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
    case 'autoExec':
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
        { t: 'fldSandboxLangs', p: ['toolsConfig', 'sandbox', 'allowedLanguages'], w: 'chips' },
        { t: 'fldSbxTimeout', p: ['toolsConfig', 'sandbox', 'defaultTimeout'], w: 'number', min: 1000, step: 1000 },
        { t: 'fldSbxOutputLines', p: ['toolsConfig', 'sandbox', 'maxOutputLines'], w: 'number', min: -1 },
        { t: 'fldSbxCleanup', p: ['toolsConfig', 'sandbox', 'cleanupTempDir'], w: 'toggle' }
      ]);
      break;
    case 'prompt':
      renderSimpleSection('secPrompt', [
        { t: 'fldPromptMode', p: ['toolsConfig', 'system_prompt', 'currentModeId'], w: 'promptMode' },
        { t: 'fldPromptPrefix', p: ['toolsConfig', 'system_prompt', 'customPrefix'], w: 'textarea' },
        { t: 'fldPromptSuffix', p: ['toolsConfig', 'system_prompt', 'customSuffix'], w: 'textarea' },
        { t: 'fldPromptDynamicEnabled', p: ['toolsConfig', 'system_prompt', 'dynamicTemplateEnabled'], w: 'toggle' },
        { t: 'fldPromptDynamic', p: ['toolsConfig', 'system_prompt', 'dynamicTemplate'], w: 'textarea' }
      ]);
      break;
    case 'context':
      renderSimpleSection('secContext', [
        { t: 'fldCtxFiles', p: ['toolsConfig', 'context_awareness', 'includeWorkspaceFiles'], w: 'toggle' },
        { t: 'fldCtxDepth', p: ['toolsConfig', 'context_awareness', 'maxFileDepth'], w: 'number', min: -1 },
        { t: 'fldCtxTabs', p: ['toolsConfig', 'context_awareness', 'includeOpenTabs'], w: 'toggle' },
        { t: 'fldCtxMaxTabs', p: ['toolsConfig', 'context_awareness', 'maxOpenTabs'], w: 'number', min: 0 },
        { t: 'fldCtxEditor', p: ['toolsConfig', 'context_awareness', 'includeActiveEditor'], w: 'toggle' },
        { t: 'fldDiagEnabled', p: ['toolsConfig', 'context_awareness', 'diagnostics', 'enabled'], w: 'toggle' },
        { t: 'fldDiagSeverities', p: ['toolsConfig', 'context_awareness', 'diagnostics', 'includeSeverities'], w: 'checklist', items: [{ value: 'error', label: 'error' }, { value: 'warning', label: 'warning' }, { value: 'information', label: 'information' }, { value: 'hint', label: 'hint' }] },
        { t: 'fldDiagWorkspaceOnly', p: ['toolsConfig', 'context_awareness', 'diagnostics', 'workspaceOnly'], w: 'toggle' },
        { t: 'fldDiagOpenOnly', p: ['toolsConfig', 'context_awareness', 'diagnostics', 'openFilesOnly'], w: 'toggle' },
        { t: 'fldDiagPerFile', p: ['toolsConfig', 'context_awareness', 'diagnostics', 'maxDiagnosticsPerFile'], w: 'number', min: 1 },
        { t: 'fldDiagMaxFiles', p: ['toolsConfig', 'context_awareness', 'diagnostics', 'maxFiles'], w: 'number', min: 1 },
        { t: 'fldCtxIgnore', p: ['toolsConfig', 'context_awareness', 'ignorePatterns'], w: 'chips' }
      ]);
      break;
    case 'memory':
      renderSimpleSection('secMemory', [
        { t: 'fldMemEnabled', p: ['toolsConfig', 'memory', 'enabled'], w: 'toggle' },
        { t: 'fldMemWakeLines', p: ['toolsConfig', 'memory', 'wakeLines'], w: 'number', min: 1 },
        { t: 'fldMemEntryChars', p: ['toolsConfig', 'memory', 'entryChars'], w: 'number', min: 1 },
        { t: 'fldMemPartChars', p: ['toolsConfig', 'memory', 'partChars'], w: 'number', min: 1 },
        { t: 'fldMemPartLines', p: ['toolsConfig', 'memory', 'partLines'], w: 'number', min: 1 }
      ]);
      break;
    case 'summarize':
      renderSimpleSection('secSummarize', [
        { t: 'fldSumPrompt', p: ['toolsConfig', 'summarize', 'summarizePrompt'], w: 'textarea' },
        { t: 'fldSumAutoPrompt', p: ['toolsConfig', 'summarize', 'autoSummarizePrompt'], w: 'textarea' },
        { t: 'fldSumKeepRounds', p: ['toolsConfig', 'summarize', 'keepRecentRounds'], w: 'number', min: 1, max: 10 },
        { t: 'fldSumKeepTokens', p: ['toolsConfig', 'summarize', 'keepRecentTokens'], w: 'text' },
        { t: 'fldSumSeparateModel', p: ['toolsConfig', 'summarize', 'useSeparateModel'], w: 'toggle' },
        { t: 'fldSumChannelId', p: ['toolsConfig', 'summarize', 'summarizeChannelId'], w: 'configSelect' },
        { t: 'fldSumModelId', p: ['toolsConfig', 'summarize', 'summarizeModelId'], w: 'text' },
        { t: 'fldSumMaxAttempts', p: ['toolsConfig', 'summarize', 'maxAutoSummarizeAttemptsPerTurn'], w: 'number', min: 1, max: 5 },
        { t: 'fldSumMaxRatio', p: ['toolsConfig', 'summarize', 'summarizeMaxInputRatio'], w: 'ratio' }
      ]);
      break;
    case 'checkpoint':
      renderCheckpointSection();
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
    S.settings = data.settings || null;
    if (isView('settings') && (S.settingsTab === 'general' || S.settingsTab === 'prompt' ||
        S.settingsTab === 'context' || S.settingsTab === 'memory' || S.settingsTab === 'summarize' ||
        S.settingsTab === 'checkpoint' || S.settingsTab === 'tokenCount' || S.settingsTab === 'imageGen' ||
        S.settingsTab === 'skills' || S.settingsTab === 'subagents' || S.settingsTab === 'pinned' ||
        S.settingsTab === 'sandbox' || S.settingsTab === 'fileTools' || S.settingsTab === 'proxy' ||
        S.settingsTab === 'storage')) {
      renderAllSettingsSections();
    }
  }).catch(function () {});
}
function loadToolsList() {
  api('/api/tools').then(function (data) {
    S.tools = Array.isArray(data.tools) ? data.tools : [];
    S.autoExec = data.autoExec && typeof data.autoExec === 'object' ? data.autoExec : {};
    if (isView('settings') && (S.settingsTab === 'tools' || S.settingsTab === 'autoExec' || S.settingsTab === 'checkpoint')) {
      renderAllSettingsSections();
    }
  }).catch(function () {});
}
function loadDeps() {
  api('/api/dependencies').then(function (data) {
    S.deps = Array.isArray(data.dependencies) ? data.dependencies : [];
    if (isView('settings') && S.settingsTab === 'dependencies') renderAllSettingsSections();
  }).catch(function () {});
}
function renderSettings(s) {
  S.statusInfo = s;
  if (isView('settings') && S.settingsTab === 'remoteControl') renderAllSettingsSections();
}

/* ============================================================
   11. 启动
   ============================================================ */
setStatus('connecting', t('statusConnecting'));
var wsSwitchBtn = $('btn-ws-switch');
if (wsSwitchBtn) {
  wsSwitchBtn.textContent = t('switchWorkspace');
  wsSwitchBtn.addEventListener('click', openWorkspaceSheet);
}
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
  if (isView('chat')) {
    var cur = activeTab();
    if (cur && cur.id) loadMessages(cur, false);
    loadConversations(true);
    toast(t('refresh') + ' ✓');
    return;
  }
  if (isView('settings')) {
    renderSettingsTabs();
    loadConfigs();
    loadSettings();
    loadToolsList();
    loadDeps();
    loadPromptModes();
    toast(t('refresh') + ' ✓');
    return;
  }
  if (isView('files')) {
    S.fileDirs = {};
    loadFiles('', true);
    toast(t('refresh') + ' ✓');
  }
});
$('btn-new').addEventListener('click', function () {
  closeDrawer();
  newChatTab();
});
$('drawer-backdrop').addEventListener('click', closeDrawer);
var sheetEl = $('sheet');
sheetEl.querySelector('.backdrop').addEventListener('click', closeSheet);
$('act-backdrop').addEventListener('click', closeActionSheet);
$('btn-sheet-model-close').addEventListener('click', closeSheet);
$('btn-ws-add').addEventListener('click', openBrowse);
$('btn-sheet-add').addEventListener('click', addWorkspace);
$('btn-sheet-browse').addEventListener('click', function () {
  closeSheet();
  openBrowse();
});
$('btn-browse-back').addEventListener('click', function () {
  loadFsDir(S.browseParent || '');
});
$('btn-browse-root').addEventListener('click', function () { loadFsDir(''); });
$('btn-browse-pick').addEventListener('click', pickBrowseFolder);
$('btn-file-back').addEventListener('click', function () {
  if (S.currentFile && S.currentFile.dirty) {
    openModal(t('save'), null, t('renameSave'), t('renameCancel'), 'danger', function () {
      saveFile();
    });
    return;
  }
  S.currentFile = null;
  $('file-viewer').hidden = true;
  $('file-tree').hidden = false;
});
$('btn-open-desktop').addEventListener('click', openOnDesktop);
fileEditorEl.addEventListener('input', function () {
  if (!S.currentFile) return;
  S.currentFile.content = fileEditorEl.value;
  S.currentFile.dirty = true;
  saveFileBtnEl.disabled = false;
  saveFileBtnEl.textContent = t('save');
});
saveFileBtnEl.addEventListener('click', saveFile);
document.querySelectorAll('#tabbar button').forEach(function (b) {
  b.addEventListener('click', function () { switchView(b.getAttribute('data-tab')); });
});
modalCancelEl.addEventListener('click', closeModal);
modalOkEl.addEventListener('click', function () {
  var onOk = modalEl._onOk;
  closeModal();
  if (onOk) safe(onOk)(modalInputEl.hidden ? null : modalInputEl.value);
});
modalInputEl.addEventListener('input', function () {
  modalInputEl.style.height = 'auto';
  modalInputEl.style.height = Math.min(modalInputEl.scrollHeight, 200) + 'px';
});
modalInputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); modalOkEl.click(); }
  if (e.key === 'Escape') closeModal();
});

/* 启动主流程（任何一步失败都不允许让页面空白） */
try {
  i18nAll();
  saveFileBtnEl.textContent = t('save');
  inputEl.placeholder = t('inputPlaceholder');
  renderSettingsTabs();
  renderTabsBar();
  renderSendIcon();
  updateSendBtn();
  loadPromptModes();
  api('/api/status').then(function (s) {
    S.appVersion = s.appVersion || '';
    S.statusInfo = s;
    if (s.activeChannelId) S.activeChannelId = s.activeChannelId;
    if (s.lang) S.lang = s.lang;
    applyWorkspaceInfo(s);
    renderSettings(s);
    loadConfigs();
    if (s.activeConversationId && S.tabs.length === 0) {
      openConversationTab(s.activeConversationId, s.activeConversationTitle || '');
    } else {
      renderMessages();
      if (S.tabs.length === 0) {
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
    probeServerRecovery();
  });
} catch (e) {
  showFatal(String((e && e.message) || e));
}
updateSendBtn();
</script>`;
}
