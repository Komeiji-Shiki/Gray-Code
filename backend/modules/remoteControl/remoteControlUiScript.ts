/**
 * remoteControlUiScript.ts
 *
 * 远程控制移动端 UI 脚本（V5 全量重写：桌面三段式布局）。
 *
 * 相对 V4 的核心变化：
 * - 布局：删除底部三页签（#tabbar）与 switchView，文件/设置为全屏面板
 *   （#panel-files / #panel-settings），openPanel/closePanel 控制 .open 与
 *   hidden，isPanelOpen/isChatView 取代旧 isView；
 * - 设置页：纵向分类导航（renderSettingsNav → #settings-nav），22 分类与
 *   桌面端 SettingsPanel 完全对齐；渠道编辑重构为弹窗内 4 个子页签
 *   （ch-tabs/ch-pane：基本/上下文/工具/高级，strictToolsEnabled 字段名修正，
 *   options/optionsEnabled 合并提交）；新增记忆条目管理（/api/memory-*）、
 *   用量统计（扁平 stats + stat-grid + byModel/byDay）、提示词模式管理
 *   （/api/prompt-mode-*）、子代理完整表单（/api/subagent-save/delete）、
 *   MCP 连接/断开与编辑补全、通用补全（更新/导入导出/应用信息/声音/外观）、
 *   checkpoint 每类别排除模式（profilePatterns）、fileTools 全面补全；
 * - 稳定性：SSE 看门狗（心跳超时主动重连、visibilitychange 恢复重连、bye 后
 *   探测服务器回归自动重连）、全局 window.onerror 兜底、错误横幅可见；
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
  return '<svg' + c + ' width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + paths + '</svg>';
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
  wrench: '<path d="M16 3a6 6 0 0 0-5.9 7.3L3 17.4V21h3.6l7.1-7.1A6 6 0 0 0 16 3zm0 2a4 4 0 0 1 3.6 5.6l-6.9 6.9L12 17.5l-1.4-1.4-.5 1.3-1.5 1.5H5v-3.6l1.5-1.5 1.3-.5L6.4 11 13.3 4.1A4 4 0 0 1 16 5z"/>',
  plug: '<path d="M9 3v4h1V3h2v4h1V3h2v5.5L14 11v6h-1.5v4h-1v-4H9v4h-1v-4H8v-6l-1-2.5V3h2zm-1 8.5V11h8v.5L15 13v3H9v-3l-1-1.5z"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>',
  server: '<path d="M3 4h18v6H3V4zm2 2v2h2V6H5zm11 0h3v2h-3V6zM3 14h18v6H3v-6zm2 2v2h2v-2H5zm11 0h3v2h-3v-2z"/>',
  hubot: '<path d="M12 3a9 9 0 0 0-8.6 12l-1.2 4.2L6.4 18A9 9 0 1 0 12 3zm-4 8h8v3a4 4 0 0 1-8 0v-3zm2 0v3a2 2 0 0 0 4 0v-3h-4z"/>',
  note: '<path d="M4 3h16v14l-4 4H4V3zm2 2v14h9v-3h3V5H6zm2 3h8v2H8V8zm0 4h5v2H8v-2z"/>',
  database: '<path d="M12 3c4.1 0 7 1.3 7 3s-2.9 3-7 3-7-1.3-7-3 2.9-3 7-3zm-7 6c0 1.7 2.9 3 7 3s7-1.3 7-3v3c0 1.7-2.9 3-7 3s-7-1.3-7-3V9zm0 6c0 1.7 2.9 3 7 3s7-1.3 7-3v3c0 1.7-2.9 3-7 3s-7-1.3-7-3v-3z"/>',
  package: '<path d="M12 2l9 5v10l-9 5-9-5V7l9-5zm0 3.2L5.9 8.6 12 12l6.1-3.4L12 5.2zM5 10.6l6 3.3v5.3l-6-3.3v-5.3zm14 0v5.3l-6 3.3v-5.3l6-3.3z"/>',
  paintcan: '<path d="M12 2a3 3 0 0 0-3 3v1H4v4h16V6h-5V5a3 3 0 0 0-3-3zm-2 3a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm-5 6v8a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-8H5zm3 2h2v6H8v-6z"/>',
  bell: '<path d="M12 3a6 6 0 0 0-6 6v4L4 16v1h16v-1l-2-3v-4a6 6 0 0 0-6-6zm-3 14a3 3 0 0 0 6 0H9z"/>',
  terminal: '<path d="M4 4h16v16H4V4zm2 2v12h12V6H6zm3 3l3 3-3 3-1.4-1.4L9.2 12 7.6 10.4 9 9zm5 5h4v2h-4v-2z"/>',
  graph: '<path d="M4 3h2v16h16v2H2V3h2zm4 12h3v5H8v-5zm5-5h3v10h-3V10zm5 4h3v6h-3v-6z"/>',
  remote: '<path d="M12 5a10 10 0 0 0-7 3l1.5 1.5A7 7 0 0 1 12 7a7 7 0 0 1 5.5 2.5L19 8a10 10 0 0 0-7-3zm0 5a5 5 0 0 0-3.5 1.5L10 13a3 3 0 0 1 4 0l1.5-1.5A5 5 0 0 0 12 10zm-1 4l1 3 1-3-1-1-1 1z"/>',
  pin: '<path d="M16 3l5 5-2 2-1.5-1.5-4 4V15L9 19.5V22H2v-7l4.5-4.5h2.5l4-4L11.5 5l2-2H16z"/>',
  star: '<path d="M12 3l2.8 6 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.9 9.2 9l2.8-6z"/>',
  hash: '<path d="M10 3l-1 7H5l-1 4h4l-1 7h4l1-7h4l-1 7h4l1-7h3l1-4h-3l1-7h-4l-1 7h-4l1-7h-4z"/>',
  grid: '<path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>',
  globe: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7 10h-2.6A14.5 14.5 0 0 1 15.4 5.6 8 8 0 0 1 19 12zM12 20a12.5 12.5 0 0 1-2.3-6h4.6A12.5 12.5 0 0 1 12 20zm-2.3-8a12.5 12.5 0 0 1 2.3-6 12.5 12.5 0 0 1 2.3 6H9.7zM8.6 5.6A14.5 14.5 0 0 1 7.6 12H5a8 8 0 0 1 3.6-6.4zM5 14h2.6a14.5 14.5 0 0 0 1 6.4A8 8 0 0 1 5 14zm10.4 6.4a14.5 14.5 0 0 0 1-6.4H19a8 8 0 0 1-3.6 6.4z"/>',
  save: '<path d="M5 3h13l3 3v15H3V5a2 2 0 0 1 2-2zm12 2H5v3h12V5zm3 3h-2v3H6v-3H4v12h16V8z"/>',
  download: '<path d="M12 3v11l4-4 1.4 1.4L12 18l-5.4-5.6L8 10l4 4V3zM4 19h16v2H4v-2z"/>',
  upload: '<path d="M12 16V5L8 9 6.6 7.6 12 2l5.4 5.6L16 9l-4-4v11zM4 19h16v2H4v-2z"/>',
  eye: '<path d="M12 5c-5 0-9.3 3.1-11 7 1.7 3.9 6 7 11 7s9.3-3.1 11-7c-1.7-3.9-6-7-11-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
  eyeClosed: '<path d="M12 7c-3.8 0-7.2 2-9 5 1 2.2 3 4.1 5.4 5l-1.4 1.4 1.4 1.4 8.4-8.4a4 4 0 0 0-2.2-4.1A9 9 0 0 0 12 7zm4.2 1.8l-1.4 1.4a2 2 0 0 1-2.8 2.8l-1.4 1.4a4 4 0 0 0 5.6-5.6zm-2-1.4a9 9 0 0 1 6 2.6 11 11 0 0 0-2 1.7 4 4 0 0 0-4-4.3z"/>',
  arrowUp: '<path d="M12 5l7 7-1.4 1.4L13 8.8V19h-2V8.8l-4.6 4.6L5 12l7-7z"/>',
  arrowDown: '<path d="M12 19l-7-7 1.4-1.4 4.6 4.6V5h2v10.2l4.6-4.6L19 12l-7 7z"/>',
  checkAll: '<path d="M2 12l5 5L18 6l-1.4-1.4L7 14.2 3.4 10.6 2 12zm12.4 1.6L13 12.2l5.4-5.4L20 8.4l-5.6 5.2z"/>',
  fold: '<path d="M3 4h18v2H3V4zm0 5h18v2H3V9zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/>',
  list: '<path d="M4 6h2v2H4V6zm4 0h12v2H8V6zM4 11h2v2H4v-2zm4 0h12v2H8v-2zM4 16h2v2H4v-2zm4 0h12v2H8v-2z"/>',
  network: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm8 10h-2.6A14.5 14.5 0 0 1 15.4 5.6 8 8 0 0 1 19 12zM12 20a12.5 12.5 0 0 1-2.3-6h4.6A12.5 12.5 0 0 1 12 20zm-2.3-8a12.5 12.5 0 0 1 2.3-6 12.5 12.5 0 0 1 2.3 6H9.7zM8.6 5.6A14.5 14.5 0 0 1 7.6 12H5a8 8 0 0 1 3.6-6.4zM5 14h2.6a14.5 14.5 0 0 0 1 6.4A8 8 0 0 1 5 14zm10.4 6.4a14.5 14.5 0 0 0 1-6.4H19a8 8 0 0 1-3.6 6.4z"/>'
};
var ICON_SEND = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>';
var ICON_STOP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>';

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
  /* 提示词模式展开态 */
  promptOpenMode: null,
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
/* 记忆条目 / 用量统计 / MCP 独立状态桶 */
var S_MEM = { entries: [], total: 0, loaded: false };
var S_USAGE = { stats: null, loaded: false, loading: false };
var S_MCP = { servers: [], loaded: false };

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
    pendingStreamId: null,
    activeTools: []
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
/** 面板是否打开（#panel-<name> 带 .open 且未 hidden） */
function isPanelOpen(name) {
  var p = $('panel-' + name);
  return !!(p && p.classList.contains('open') && !p.hidden);
}
/** 会话视图：两个全屏面板都未打开 */
function isChatView() {
  return !isPanelOpen('files') && !isPanelOpen('settings');
}
/** 打开全屏面板：name 为 'files' | 'settings' */
function openPanel(name) {
  var p = $('panel-' + name);
  if (!p) return;
  p.hidden = false;
  p.classList.add('open');
  if (name === 'settings') {
    openSettings();
  } else if (name === 'files') {
    refreshWsBar();
    loadFiles('', true);
  }
}
/** 关闭全屏面板 */
function closePanel(name) {
  var p = $('panel-' + name);
  if (!p) return;
  p.hidden = true;
  p.classList.remove('open');
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
  renderMessages();
  renderComposerMeta();
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
    var sub = el('div', { class: 'conv-sub' });
    sub.appendChild(el('span', { text: fmtTime(c.updatedAt) }));
    if (c.messageCount) sub.appendChild(el('span', { text: c.messageCount + ' 条' }));
    main.appendChild(sub);
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
    var del = el('button', { class: 'icon-btn conv-more', 'aria-label': t('deleteConversation') });
    del.innerHTML = icon('trash');
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      openModal(t('deleteConversation'), null, t('deleteConversationConfirm'), t('renameCancel'), 'danger', function () {
        deleteConversation(c.id);
      });
    });
    item.appendChild(del);
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
/* 与服务端 ContentPart schema 对齐（backend/modules/conversation/types.ts）：
 * - text：正文（thought:true 时是思考过程，折叠显示）
 * - inlineData/fileData：附件（服务端已剥离 base64，保留 mimeType/displayName 元数据）
 * - functionCall：工具调用 { name, args, id, rejected, ... }
 * - functionResponse：工具结果 { name, response, parts? }
 * - 消息级：role / parts / index(绝对) / id / parentId / modelVersion / timestamp /
 *   isFunctionResponse / isSummary */
function partsToText(parts, opts) {
  var out = '';
  var o = opts || {};
  (parts || []).forEach(function (p) {
    if (!p) return;
    if (o.skipThought && p.thought) return;
    if (typeof p.text === 'string' && !(o.skipThought && p.thought)) out += p.text;
  });
  return out;
}
function partsHaveAttachments(parts) {
  return (parts || []).some(function (p) {
    return !!(p && (p.inlineData || p.fileData));
  });
}
function attachmentMetaOf(parts) {
  var out = [];
  (parts || []).forEach(function (p) {
    if (!p) return;
    var meta = null;
    if (p.inlineData) {
      meta = { kind: 'inline', mimeType: p.inlineData.mimeType || '', displayName: p.inlineData.displayName || '' };
    } else if (p.fileData) {
      meta = { kind: 'file', mimeType: p.fileData.mimeType || '', displayName: p.fileData.displayName || '' };
    }
    if (meta) out.push(meta);
  });
  return out;
}
function mimeToKind(mime) {
  if (!mime) return 'file';
  if (mime.indexOf('image/') === 0) return 'image';
  if (mime.indexOf('audio/') === 0) return 'audio';
  if (mime.indexOf('video/') === 0) return 'video';
  return 'file';
}
function fileNameOf(meta) {
  if (meta && meta.displayName) return meta.displayName;
  if (meta && meta.mimeType) {
    var map = { 'image/png': 'image.png', 'image/jpeg': 'image.jpg', 'image/webp': 'image.webp',
      'image/gif': 'image.gif', 'audio/mpeg': 'audio.mp3', 'audio/wav': 'audio.wav',
      'audio/ogg': 'audio.ogg', 'video/mp4': 'video.mp4', 'application/pdf': 'document.pdf' };
    return map[meta.mimeType] || ('attachment.' + (meta.mimeType.split('/')[1] || 'bin'));
  }
  return 'attachment';
}
function toolCallsOf(msg) {
  var calls = [];
  (msg.parts || []).forEach(function (p) {
    if (p && p.functionCall && p.functionCall.name) {
      calls.push(p.functionCall);
    }
  });
  return calls;
}
function toolResultsOf(msg) {
  var results = [];
  (msg.parts || []).forEach(function (p) {
    if (p && p.functionResponse && p.functionResponse.name) {
      results.push(p.functionResponse);
    }
  });
  return results;
}
function renderToolCallCard(fc) {
  var card = el('div', { class: 'tool-card' + (fc.rejected ? ' rejected' : '') });
  var head = el('button', { class: 'tool-card-head', type: 'button' });
  var chev = el('span', { class: 'tc-chev' });
  chev.innerHTML = icon('chevronRight');
  head.appendChild(chev);
  var ico = el('span', { class: 'tc-ico' });
  ico.innerHTML = icon('wrench');
  head.appendChild(ico);
  head.appendChild(el('span', { class: 'tc-name', text: fc.name }));
  if (fc.rejected) head.appendChild(el('span', { class: 'tc-state rejected', text: t('rejected') }));
  else head.appendChild(el('span', { class: 'tc-state ok', text: t('done') }));
  card.appendChild(head);
  var body = el('div', { class: 'tool-card-body', hidden: true });
  var argsText = '';
  try {
    argsText = (fc.args != null && typeof fc.args === 'object') ? JSON.stringify(fc.args, null, 2) : String(fc.args || '');
  } catch (e) { argsText = ''; }
  if (argsText) {
    var sec = el('div', { class: 'tc-section' });
    sec.appendChild(el('div', { class: 'tc-sec-label', text: t('toolArgs') }));
    var pre = el('pre');
    pre.textContent = argsText;
    sec.appendChild(pre);
    body.appendChild(sec);
  }
  card.appendChild(body);
  head.addEventListener('click', function () {
    body.hidden = !body.hidden;
    chev.classList.toggle('open', !body.hidden);
  });
  return card;
}
function renderToolResultCard(fr) {
  var card = el('div', { class: 'tool-result-card' });
  var head = el('button', { class: 'tool-card-head', type: 'button' });
  var chev = el('span', { class: 'tc-chev open' });
  chev.innerHTML = icon('chevronDown');
  head.appendChild(chev);
  var ico = el('span', { class: 'tc-ico result' });
  ico.innerHTML = icon('check');
  head.appendChild(ico);
  head.appendChild(el('span', { class: 'tc-name', text: fr.name || t('toolResult') }));
  card.appendChild(head);
  var body = el('div', { class: 'tool-card-body' });
  var text = '';
  try {
    var resp = fr.response;
    if (resp != null && typeof resp === 'object') {
      if (typeof resp.text === 'string') text = resp.text;
      else if (typeof resp.output === 'string') text = resp.output;
      else if (typeof resp.content === 'string') text = resp.content;
      else if (resp.data && typeof resp.data === 'object' && typeof resp.data.text === 'string') text = resp.data.text;
      else text = JSON.stringify(resp, null, 2);
    } else if (resp != null) {
      text = String(resp);
    }
  } catch (e) { text = ''; }
  if (text) {
    var pre = el('pre', { class: 'tool-result-pre' });
    pre.textContent = text.length > 4000 ? text.slice(0, 4000) + '\\n…' : text;
    body.appendChild(pre);
  }
  card.appendChild(body);
  head.addEventListener('click', function () {
    body.hidden = !body.hidden;
    chev.classList.toggle('open', !body.hidden);
  });
  return card;
}
function renderThoughtBlock(parts) {
  var block = el('div', { class: 'thought-block' });
  var head = el('button', { class: 'thought-head', type: 'button' });
  var chev = el('span', { class: 'th-chev' });
  chev.innerHTML = icon('chevronRight');
  head.appendChild(chev);
  var bulb = el('span', { class: 'th-bulb' });
  bulb.innerHTML = icon('brain');
  head.appendChild(bulb);
  head.appendChild(el('span', { class: 'th-label', text: t('thinking') }));
  block.appendChild(head);
  var body = el('div', { class: 'thought-body', hidden: true });
  var md = el('div', { class: 'markdown' });
  md.innerHTML = renderMarkdown(partsToText(parts, { skipThought: false }));
  body.appendChild(md);
  block.appendChild(body);
  head.addEventListener('click', function () {
    body.hidden = !body.hidden;
    chev.classList.toggle('open', !body.hidden);
  });
  return block;
}
function buildMessage(msg, index) {
  if (!msg) return null;
  var role = msg.role || 'assistant';
  var wrap = el('div', { class: 'msg ' + role + (index === null ? ' streaming' : '') + (msg.isFunctionResponse ? ' tool-response' : '') });
  var head = el('div', { class: 'msg-head' });
  if (msg.isFunctionResponse) {
    head.appendChild(el('span', { class: 'msg-role tool', text: t('toolResult') }));
  } else if (role === 'user') {
    head.appendChild(el('span', { class: 'msg-role', text: t('you') }));
  } else {
    head.appendChild(el('span', { class: 'msg-role assistant', text: t('assistant') }));
    if (msg.modelVersion) head.appendChild(el('span', { class: 'msg-model', text: msg.modelVersion }));
  }
  if (msg.timestamp) head.appendChild(el('span', { class: 'msg-time', text: fmtTime(msg.timestamp) }));
  wrap.appendChild(head);
  var contentEl = el('div', { class: 'msg-content' });
  var attachments = attachmentMetaOf(msg.parts);
  if (attachments.length) {
    var attEl = el('div', { class: 'msg-attachments' });
    attachments.forEach(function (meta) {
      var item = el('div', { class: 'att-item' });
      var kind = mimeToKind(meta.mimeType);
      var ico = el('span', { class: 'att-ico ' + kind });
      ico.innerHTML = icon(kind === 'image' ? 'file' : (kind === 'audio' ? 'chat' : 'file'));
      item.appendChild(ico);
      var nm = el('div', { class: 'att-name', text: fileNameOf(meta) });
      if (meta.mimeType) nm.appendChild(el('span', { class: 'att-mime', text: meta.mimeType }));
      item.appendChild(nm);
      attEl.appendChild(item);
    });
    contentEl.appendChild(attEl);
  }
  var tools = toolCallsOf(msg);
  var thoughtParts = (msg.parts || []).filter(function (p) { return p && p.thought; });
  var bodyParts = (msg.parts || []).filter(function (p) { return !p.thought; });
  if (thoughtParts.length) {
    contentEl.appendChild(renderThoughtBlock(thoughtParts));
  }
  if (tools.length) {
    tools.forEach(function (fc) { contentEl.appendChild(renderToolCallCard(fc)); });
  }
  var text = partsToText(bodyParts, { skipThought: true }) || msg.content || '';
  if (msg.isFunctionResponse) {
    toolResultsOf(msg).forEach(function (fr) { contentEl.appendChild(renderToolResultCard(fr)); });
    var nested = (msg.parts || []).filter(function (p) { return p && p.functionResponse && !p.functionResponse.parts; });
    if (!text && nested.length === 0 && !attachments.length) {
      text = '';
    }
  }
  if (role === 'user') {
    if (text) contentEl.appendChild(el('div', { text: text }));
    if (!text && !attachments.length && !tools.length) {
      contentEl.appendChild(el('div', { class: 'empty-part', text: '…' }));
    }
  } else if (text) {
    var md = el('div', { class: 'markdown' });
    md.innerHTML = renderMarkdown(text);
    contentEl.appendChild(md);
  }
  wrap.appendChild(contentEl);
  var actions = el('div', { class: 'msg-actions' });
  var copyBtn = el('button', { class: 'mini-btn', 'aria-label': t('copy') });
  copyBtn.innerHTML = icon('copy');
  copyBtn.addEventListener('click', function () { copyText(partsToText(msg.parts, {}) || msg.content || ''); });
  actions.appendChild(copyBtn);
  if (role === 'assistant' && index !== null && index !== undefined && msg.id && !msg.isFunctionResponse) {
    var rerollBtn = el('button', { class: 'mini-btn', 'aria-label': t('reroll') });
    rerollBtn.innerHTML = icon('refresh');
    rerollBtn.addEventListener('click', function () { rerollMessage(msg); });
    actions.appendChild(rerollBtn);
  }
  if (msg.id && role === 'user' && !msg.isFunctionResponse) {
    var editBtn = el('button', { class: 'mini-btn', 'aria-label': t('edit') });
    editBtn.innerHTML = icon('edit');
    editBtn.addEventListener('click', function () { editMessage(msg); });
    actions.appendChild(editBtn);
  }
  if (msg.id && typeof msg.index === 'number') {
    var delBtn = el('button', { class: 'mini-btn danger', 'aria-label': t('deleteMessage') });
    delBtn.innerHTML = icon('trash');
    delBtn.addEventListener('click', function () {
      openModal(t('deleteMessage'), null, t('deleteMessageConfirm'), t('renameCancel'), 'danger', function () {
        deleteMessageAt(msg.index);
      });
    });
    actions.appendChild(delBtn);
  }
  wrap.appendChild(actions);
  return wrap;
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
      html: '<span class="msg-role assistant">' + esc(t('assistant')) + '</span>' +
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
  openModal(t('editMessage'), partsToText(msg.parts, { skipThought: true }) || msg.content || '', t('save'), t('renameCancel'), null, function (val) {
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
  cur.sendInFlight = true;
  var payload = {
    text: text,
    configId: S.activeChannelId || undefined,
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
        /* 竞态兜底：SSE 流可能在 POST 响应前已全部到达（含 complete/error），
         * 此时终结块滞留 orphanStreams 永不重放，页签将永久卡「生成中」。
         * 回填 conversationId 后立即重放孤儿缓冲（flushOrphanStream 正是为此设计）。 */
        if (data.streamId) flushOrphanStream(data.streamId, cur);
        if (!cur.streaming && orphanStreamsHasConv(cur.id)) flushOrphanConv(cur.id, cur);
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
function orphanStreamsHasConv(convId) {
  for (var k in orphanStreams) {
    if (orphanStreams[k] && orphanStreams[k].convId === convId) return true;
  }
  return false;
}
function flushOrphanConv(convId, tab) {
  for (var k in orphanStreams) {
    var buf = orphanStreams[k];
    if (buf && buf.convId === convId && buf.chunks.length) {
      delete orphanStreams[k];
      buf.chunks.forEach(function (c) { processChunk(c, tab); });
    }
  }
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
    if (tab.streaming || tab.pendingTools.length || (tab.activeTools && tab.activeTools.length)) {
      tab.streaming = false;
      tab.streamingText = '';
      tab.pendingTools = [];
      tab.activeTools = [];
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
      var toolHtml = '';
      if (tab.activeTools && tab.activeTools.length) {
        toolHtml = '<div class="stream-tools">' + tab.activeTools.map(function (n) {
          return '<span class="tool-chip">' + esc(n) + '</span>';
        }).join('') + '</div>';
      }
      contentEl.innerHTML = toolHtml + (tab.streamingText ? renderMarkdown(tab.streamingText) : '') + '<span class="caret"></span>';
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
    tab.activeTools = [];
    tab.lastError = null;
    renderConfirmBar();
    loadMessages(tab, true);
    loadConversations(true);
    return;
  }
  if (type === 'cancelled') {
    if (tab.streaming) { tab.streamingText = c.content || tab.streamingText; setStreaming(tab, false); }
    tab.pendingTools = [];
    tab.activeTools = [];
    tab.lastError = null;
    renderConfirmBar();
    toast(t('streamInterrupted'));
    loadMessages(tab, true);
    return;
  }
  if (type === 'error') {
    if (tab.streaming) setStreaming(tab, false);
    tab.activeTools = [];
    var errMsg = (c.error && (c.error.message || c.error)) || t('loadFailed');
    tab.lastError = { text: errMsg, retry: false };
    if (tab.key === S.activeTabKey) renderMessages();
    loadMessages(tab, true);
    return;
  }
  if (type === 'toolsExecuting' || type === 'toolIteration') {
    if (!tab.streaming) setStreaming(tab, true, '');
    var toolNames = [];
    var content = c && (c.content || c.toolResults);
    if (Array.isArray(c && c.toolResults)) {
      c.toolResults.forEach(function (tr) {
        if (tr && typeof tr.name === 'string') toolNames.push(tr.name);
      });
    } else if (Array.isArray(c && c.tools)) {
      c.tools.forEach(function (tc) {
        if (tc && typeof tc.name === 'string') toolNames.push(tc.name);
      });
    }
    if (content && typeof content === 'string') {
      tab.streamingText += '\\n' + content;
    }
    tab.activeTools = toolNames;
    if (tab.key === S.activeTabKey) renderStreamingText();
    return;
  }
  if (type === 'toolStatus') {
    if (!tab.streaming) setStreaming(tab, true, '');
    var stName = '';
    if (c && c.tool && typeof c.tool === 'string') stName = c.tool;
    if (stName) tab.activeTools = [stName];
    if (tab.key === S.activeTabKey) renderStreamingText();
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
    if (isPanelOpen('files')) {
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
    if (isPanelOpen('settings') && S.settingsTab === 'channel') renderAllSettingsSections();
    return data;
  }).catch(function () {
    renderComposerMeta();
    return Promise.reject(new Error('configs'));
  });
}
var modelsLoaded = {};
function loadConfigModels(configId, onDone) {
  if (!configId) return;
  if (modelsLoaded[configId]) {
    if (onDone) onDone();
    return;
  }
  modelsLoaded[configId] = true;
  api('/api/config?configId=' + encodeURIComponent(configId))
    .then(function (data) {
      var cfg = data.config || {};
      var models = Array.isArray(cfg.models) ? cfg.models : [];
      S.configModels[configId] = models;
      syncThinkingFromConfig(configId, cfg);
      renderComposerMeta();
      if (onDone) onDone();
    })
    .catch(function () {
      modelsLoaded[configId] = false;
      if (onDone) onDone();
    });
}
/** 强制重新拉取某渠道模型列表（模型管理对话框增删后用） */
function reloadConfigModels(configId, onDone) {
  if (!configId) return;
  delete modelsLoaded[configId];
  loadConfigModels(configId, onDone);
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
        if (isPanelOpen('files')) { $('file-viewer').hidden = true; $('file-tree').hidden = false; loadFiles('', true); }
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
        if (isPanelOpen('files')) { $('file-viewer').hidden = true; $('file-tree').hidden = false; loadFiles('', true); }
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
    if (isPanelOpen('files')) { $('file-viewer').hidden = true; $('file-tree').hidden = false; loadFiles('', true); }
  }).catch(function (err) {
    toast(t('loadFailed') + ': ' + (err.message || ''));
  });
}

/* ============================================================
   10. 设置页（schema 驱动，字段路径与桌面端 SettingsPanel 对齐）
   ============================================================ */
var SETTINGS_CATEGORIES = [
  { key: 'channel', labelKey: 'secChannel', icon: 'plug' },
  { key: 'general', labelKey: 'secGeneral', icon: 'gear' },
  { key: 'proxy', labelKey: 'secProxy', icon: 'globe' },
  { key: 'tools', labelKey: 'secTools', icon: 'wrench' },
  { key: 'autoExec', labelKey: 'secAutoExec', icon: 'bolt' },
  { key: 'mcp', labelKey: 'secMcp', icon: 'server' },
  { key: 'fileTools', labelKey: 'secFileTools', icon: 'file' },
  { key: 'sandbox', labelKey: 'secCommand', icon: 'terminal' },
  { key: 'prompt', labelKey: 'secPrompt', icon: 'note' },
  { key: 'context', labelKey: 'secContext', icon: 'grid' },
  { key: 'memory', labelKey: 'secMemory', icon: 'database' },
  { key: 'summarize', labelKey: 'secSummarize', icon: 'fold' },
  { key: 'checkpoint', labelKey: 'secCheckpoint', icon: 'history' },
  { key: 'tokenCount', labelKey: 'secTokenCount', icon: 'hash' },
  { key: 'imageGen', labelKey: 'secImageGen', icon: 'sparkle' },
  { key: 'skills', labelKey: 'secSkills', icon: 'star' },
  { key: 'subagents', labelKey: 'secSubagents', icon: 'hubot' },
  { key: 'pinned', labelKey: 'secPinned', icon: 'pin' },
  { key: 'remoteControl', labelKey: 'secRemote', icon: 'remote' },
  { key: 'storage', labelKey: 'secStorage', icon: 'folder' },
  { key: 'dependencies', labelKey: 'secDeps', icon: 'package' },
  { key: 'usage', labelKey: 'secUsage', icon: 'graph' }
];
/* 设置分类导航：纵向按钮列表（#settings-nav，替代旧横向页签条） */
function renderSettingsNav() {
  var nav = $('settings-nav');
  if (!nav) return;
  nav.innerHTML = '';
  SETTINGS_CATEGORIES.forEach(function (cat) {
    var btn = el('button', {
      class: 'set-tab' + (cat.key === S.settingsTab ? ' active' : ''),
      'data-set-tab': cat.key,
      text: ''
    });
    if (cat.icon) btn.innerHTML = icon(cat.icon) + '<span>' + esc(t(cat.labelKey)) + '</span>';
    btn.addEventListener('click', function () {
      S.settingsTab = cat.key;
      renderSettingsNav();
      renderAllSettingsSections();
      if (cat.key === 'memory') loadMemoryEntries();
      if (cat.key === 'usage') loadUsageStats();
    });
    nav.appendChild(btn);
  });
}
function openSettings() {
  renderSettingsNav();
  renderAllSettingsSections();
  loadConfigs();
  loadMcpServers();
  loadPromptModes();
  loadMemoryScopes();
  /* 保留 S.settings 缓存：首次打开才拉全量设置 */
  if (!S.settings) {
    loadSettings();
    loadToolsList();
    loadDeps();
  }
  if (S.settingsTab === 'memory') loadMemoryEntries();
  if (S.settingsTab === 'usage') loadUsageStats();
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
    if (isPanelOpen('settings')) renderAllSettingsSections();
    toast(t('settingsSaved'));
  }).catch(function (err) {
    if (isPanelOpen('settings')) renderAllSettingsSections();
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
  } else if (f.w === 'seg') {
    /* 枚举按钮组：点击立即保存（如自动保存延迟档位） */
    var segBox = el('div', { class: 'seg', style: 'display:flex;flex-wrap:wrap;gap:6px;width:100%;' });
    (f.o || []).forEach(function (opt) {
      var active = String(value) === String(opt);
      var b = el('button', {
        type: 'button',
        text: String(opt),
        style: (active
          ? 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);'
          : 'background:var(--vscode-input-background);color:var(--vscode-input-foreground);') +
          'border:1px solid var(--vscode-input-border);border-radius:6px;padding:4px 10px;font-size:12px;'
      });
      b.addEventListener('click', function () {
        saveSettingsPatch(patchFor(f.p, opt));
      });
      segBox.appendChild(b);
    });
    ctl.appendChild(segBox);
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
        var rm = el('button', { type: 'button', class: 'chip-x', 'aria-label': t('remove') });
        rm.innerHTML = icon('close');
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
  } else if (f.w === 'shells') {
    /* 逐 shell 启用开关 + 可执行文件路径（桌面端 execute_command.vue 同款） */
    var shellsWrap = el('div', { class: 'shells-list' });
    var shells = Array.isArray(value) ? value : [];
    shells.forEach(function (sh) {
      var shRow = el('div', { class: 'shell-row' });
      var nameSpan = el('span', { class: 'shell-name', text: (sh && sh.displayName) || (sh && sh.type) || '' });
      shRow.appendChild(nameSpan);
      shRow.appendChild(itemToggle(!(sh && sh.enabled === false), function (v) {
        var next = shells.slice();
        var i = next.indexOf(sh);
        if (i >= 0) next[i] = Object.assign({}, sh, { enabled: v });
        saveSettingsPatch(patchFor(f.p, next));
      }));
      var pathInput = el('input', { type: 'text', placeholder: t('toolShellPath') });
      pathInput.value = (sh && sh.path) || '';
      pathInput.addEventListener('change', function () {
        var next = shells.slice();
        var i = next.indexOf(sh);
        if (i >= 0) next[i] = Object.assign({}, sh, { path: pathInput.value });
        saveSettingsPatch(patchFor(f.p, next));
      });
      shRow.appendChild(pathInput);
      shellsWrap.appendChild(shRow);
    });
    ctl.appendChild(shellsWrap);
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
/* ---------- 渠道编辑弹窗字段控件（子菜单 ch-tabs/ch-pane 共用） ---------- */
function chField(container, reg, key, label, w, opts) {
  var wrap = el('div', { class: 'set-field' });
  wrap.appendChild(el('span', { class: 'k', text: label }));
  var ctl = el('span', { class: 'ctl' });
  if (w === 'select') {
    var sel = el('select');
    (opts || []).forEach(function (o) { sel.appendChild(el('option', { value: o, text: o })); });
    ctl.appendChild(sel);
    reg[key] = sel;
  } else if (w === 'number') {
    var num = el('input', { type: 'number' });
    if (opts && opts.min != null) num.min = String(opts.min);
    if (opts && opts.max != null) num.max = String(opts.max);
    ctl.appendChild(num);
    reg[key] = num;
  } else if (w === 'textarea') {
    var ta = el('textarea', { spellcheck: 'false', placeholder: t('keepBlank') });
    ta.style.minHeight = '70px';
    ctl.appendChild(ta);
    reg[key] = ta;
  } else if (w === 'password') {
    var pw = el('input', { type: 'password', autocomplete: 'new-password' });
    pw.placeholder = t('apiKeySet');
    ctl.appendChild(pw);
    reg[key] = pw;
  } else if (w === 'toggle') {
    var tg = itemToggle(!!(opts && opts.def === true), function (v) { tg._value = v; });
    tg._value = !!(opts && opts.def === true);
    ctl.appendChild(tg);
    reg[key] = tg;
  } else {
    var inp = el('input', { type: 'text' });
    ctl.appendChild(inp);
    reg[key] = inp;
  }
  wrap.appendChild(ctl);
  container.appendChild(wrap);
}
function chVal(reg, key, fallback) {
  var c = reg[key];
  if (!c) return fallback;
  if (c._value !== undefined) {
    var inp = c.querySelector('input');
    if (inp) c._value = inp.checked;
    return c._value;
  }
  if (c.tagName === 'SELECT') return c.value;
  if (c.tagName === 'INPUT' && c.type === 'checkbox') return c.checked;
  if (c.tagName === 'INPUT' && c.type === 'number') return c.value === '' ? undefined : Number(c.value);
  return c.value;
}
function chFill(reg, key, value, fallback) {
  var c = reg[key];
  if (!c) return;
  if (c._value !== undefined) {
    var on = value === true;
    var inp = c.querySelector('input');
    if (inp) inp.checked = on;
    c._value = on;
  } else if (c.tagName === 'SELECT') {
    c.value = value != null ? String(value) : (fallback != null ? String(fallback) : '');
  } else if (c.tagName === 'INPUT' && c.type === 'number') {
    c.value = value != null ? String(value) : '';
  } else {
    c.value = value != null ? String(value) : (fallback != null ? String(fallback) : '');
  }
}
/* 高级选项「开关 + 数值」成对控件（optionsEnabled.X + options.X） */
function chOptField(container, reg, key, label) {
  var wrap = el('div', { class: 'set-field' });
  wrap.appendChild(el('span', { class: 'k', text: label }));
  var ctl = el('span', { class: 'ctl' });
  var tg = itemToggle(false, function (v) { tg._value = v; });
  tg._value = false;
  ctl.appendChild(tg);
  var num = el('input', { type: 'number', style: 'flex:1;min-width:120px;' });
  ctl.appendChild(num);
  wrap.appendChild(ctl);
  container.appendChild(wrap);
  reg[key] = { tg: tg, num: num };
}
function chOptRead(reg, key) {
  var c = reg[key];
  if (!c) return null;
  var inp = c.tg.querySelector('input');
  return { enabled: (!!(inp && inp.checked) || c.tg._value === true), value: String(c.num.value).trim() };
}
function chOptFill(reg, key, optionsEnabled, options) {
  var c = reg[key];
  if (!c) return;
  var oe = optionsEnabled || {};
  var op = options || {};
  var enabled = oe[key] === true;
  c.tg.querySelector('input').checked = enabled;
  c.tg._value = enabled;
  c.num.value = op[key] != null ? String(op[key]) : '';
}
function applyOptPair(oe, op, key, pair) {
  if (!pair) return;
  if (pair.enabled && pair.value !== '') {
    oe[key] = true;
    op[key] = Number(pair.value);
  } else {
    delete oe[key];
    delete op[key];
  }
}
/* 通用多选列表（白名单/黑名单/工具策略用），结果存 _value */
function chkList(selected, items) {
  var box = el('div', { class: 'checklist' });
  var cur = Array.isArray(selected) ? selected.slice() : [];
  items.forEach(function (it) {
    var rowItem = el('label', { class: 'chk-row' });
    var cb = el('input', { type: 'checkbox' });
    cb.checked = cur.indexOf(it.value) >= 0;
    cb.addEventListener('change', function () {
      var idx = cur.indexOf(it.value);
      if (idx >= 0) cur.splice(idx, 1); else cur.push(it.value);
      box._value = cur.slice();
    });
    rowItem.appendChild(cb);
    rowItem.appendChild(el('span', { text: it.label }));
    box.appendChild(rowItem);
  });
  box._value = cur.slice();
  return box;
}
/** 通用工具名清单（checklist / 白名单等用） */
function toolNameItems() {
  if (S.tools && S.tools.length) {
    return S.tools.map(function (tool) { return { value: tool.name, label: tool.name }; });
  }
  return [
    'read_file', 'write_file', 'list_files', 'find_files', 'search_in_files',
    'apply_diff', 'delete_file', 'execute_command', 'generate_image',
    'remove_background', 'crop_image', 'resize_image', 'rotate_image'
  ].map(function (name) { return { value: name, label: name }; });
}
var S_TOOLS_OPEN = {};
/* 有配置面板的工具（与桌面端 hasConfigPanel 白名单一致） */
var TOOL_CONFIG_PANELS = {
  read_file: 'fldReadOutside',
  write_file: 'fldWriteOutside',
  list_files: 'fldListIgnore',
  apply_diff: 'fldApplyFormat',
  execute_command: 'fldCmdTimeout',
  find_files: 'fldFindExclude',
  search_in_files: 'fldSearchExclude',
  history_search: 'fldHistoryScope',
  generate_image: 'fldImgReturn',
  remove_background: 'fldImgReturn',
  crop_image: 'fldImgReturn',
  resize_image: 'fldImgReturn',
  rotate_image: 'fldImgReturn'
};
function renderToolsSection() {
  var card = secCard('secTools');
  if (!S.tools || S.tools.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noData') }));
    return;
  }
  /* 全局配置：最大工具调用次数（桌面端 ToolsSettings 同款） */
  renderField(card, { t: 'toolMaxIter', p: ['maxToolIterations'], w: 'number', min: -1 });
  /* 批量启用/禁用 */
  var batch = el('div', { class: 'sheet-actions' });
  var allOn = el('button', { class: 'btn', text: t('fldToolsAllEnable') });
  allOn.addEventListener('click', function () { setAllToolsEnabled(true); });
  var allOff = el('button', { class: 'btn', text: t('fldToolsAllDisable') });
  allOff.addEventListener('click', function () { setAllToolsEnabled(false); });
  batch.appendChild(allOn);
  batch.appendChild(allOff);
  card.appendChild(batch);
  /* 按工具分类分组（tool.category），行内含配置折叠面板 */
  var byCat = {};
  S.tools.forEach(function (tool) {
    var cat = (tool.category && String(tool.category).trim()) ? String(tool.category) : 'other';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(tool);
  });
  Object.keys(byCat).forEach(function (cat) {
    card.appendChild(el('div', { class: 'group-label', text: cat }));
    byCat[cat].forEach(function (tool) {
      var row = el('div', { class: 'item-row' });
      var td = el('div', { class: 't' });
      td.appendChild(el('div', { class: 'name', text: tool.name }));
      if (tool.description) td.appendChild(el('div', { class: 'sub', text: tool.description }));
      row.appendChild(td);
      var hasPanel = !!TOOL_CONFIG_PANELS[tool.name];
      if (hasPanel) {
        var cfgBtn = el('button', { type: 'button', class: 'icon-mini', 'aria-label': t('toolConfigBtn') });
        cfgBtn.innerHTML = icon('wrench');
        cfgBtn.addEventListener('click', function () {
          S_TOOLS_OPEN[tool.name] = !S_TOOLS_OPEN[tool.name];
          renderAllSettingsSections();
        });
        row.appendChild(cfgBtn);
      }
      row.appendChild(itemToggle(tool.enabled, function (v) {
        saveSettingsPatch(patchFor(['toolsEnabled', tool.name], v));
      }));
      card.appendChild(row);
      if (hasPanel && S_TOOLS_OPEN[tool.name]) {
        var panel = el('div', { class: 'tool-card-body' });
        renderToolConfigPanel(panel, tool.name);
        card.appendChild(panel);
      }
    });
  });
}
/* 工具行内配置面板（字段与 fileTools 分区一致，路径 toolsConfig.<tool>.*） */
function renderToolConfigPanel(panel, toolName) {
  var mpath = ['toolsConfig', toolName];
  var fields = toolConfigFieldsFor(toolName);
  fields.forEach(function (f) {
    renderField(panel, { t: f.t, p: mpath.concat(f.p), w: f.w, o: f.o, min: f.min, max: f.max, step: f.step });
  });
}
function toolConfigFieldsFor(toolName) {
  var map = {
    read_file: [{ t: 'fldReadOutside', p: ['outsideWorkspaceAccess'], w: 'select', o: ['deny', 'ask', 'allow'] }],
    write_file: [{ t: 'fldWriteOutside', p: ['outsideWorkspaceAccess'], w: 'select', o: ['deny', 'ask'] }],
    apply_diff: [
      { t: 'fldApplyOutside', p: ['outsideWorkspaceAccess'], w: 'select', o: ['deny', 'ask'] },
      { t: 'fldApplyFormat', p: ['format'], w: 'select', o: ['unified', 'search_replace'] },
      { t: 'fldApplyAutoSave', p: ['autoSave'], w: 'toggle' },
      { t: 'fldApplyAutoSaveDelay', p: ['autoSaveDelay'], w: 'seg', o: [50, 1000, 2000, 3000, 5000, 10000] },
      { t: 'fldApplyGuard', p: ['diffGuardEnabled'], w: 'toggle' },
      { t: 'fldApplyGuardThreshold', p: ['diffGuardThreshold'], w: 'number', min: 1, max: 100 },
      { t: 'fldApplyAutoApply', p: ['autoApplyWithoutDiffView'], w: 'toggle' }
    ],
    list_files: [{ t: 'fldListIgnore', p: ['ignorePatterns'], w: 'chips' }],
    execute_command: [
      { t: 'fldCmdShell', p: ['defaultShell'], w: 'text' },
      { t: 'fldCmdTimeout', p: ['defaultTimeout'], w: 'select', o: ['30000', '60000', '120000', '300000', '600000', '0'] },
      { t: 'fldCmdMaxOutput', p: ['maxOutputLines'], w: 'select', o: ['20', '50', '100', '200', '500', '-1'] },
      { t: 'toolShellGroup', p: ['shells'], w: 'shells' }
    ],
    find_files: [{ t: 'fldFindExclude', p: ['excludePatterns'], w: 'chips' }],
    search_in_files: [{ t: 'fldSearchExclude', p: ['excludePatterns'], w: 'chips' }],
    history_search: [
      { t: 'fldHistoryScope', p: ['searchScope'], w: 'select', o: ['all', 'summarized'] },
      { t: 'fldHistoryMax', p: ['maxSearchMatches'], w: 'number', min: 1 },
      { t: 'fldSearchCtxBefore', p: ['searchContextLines'], w: 'number', min: 0 },
      { t: 'fldSearchCtxAfter', p: ['maxReadLines'], w: 'number', min: 1 },
      { t: 'fldSearchMaxFind', p: ['maxResultChars'], w: 'number', min: 100 },
      { t: 'fldSearchMaxFind', p: ['lineDisplayLimit'], w: 'number', min: 1 }
    ]
  };
  if (map[toolName]) return map[toolName];
  return [{ t: 'fldImgReturn', p: ['returnImageToAI'], w: 'toggle' }];
}
function setAllToolsEnabled(v) {
  var map = {};
  S.tools.forEach(function (tool) { map[tool.name] = v; });
  saveSettingsPatch({ toolsEnabled: map });
}
function renderAutoExecSection() {
  var card = secCard('secAutoExec');
  if (!S.autoExec || Object.keys(S.autoExec).length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noData') }));
    return;
  }
  Object.keys(S.autoExec).forEach(function (name) {
    var row = el('div', { class: 'item-row' });
    var td = el('div', { class: 't' });
    td.appendChild(el('div', { class: 'name', text: name }));
    row.appendChild(td);
    row.appendChild(itemToggle(S.autoExec[name] === true, function (v) {
      saveSettingsPatch(patchFor(['toolAutoExec', name], v));
    }));
    card.appendChild(row);
  });
}
function renderTokenSection() {
  var tc = getVal(S.settings, ['toolsConfig', 'token_count']);
  if (!tc || typeof tc !== 'object') {
    var emptyCard = secCard('secTokenCount');
    emptyCard.appendChild(el('div', { class: 'info-text', text: t('noData') }));
    return;
  }
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
  if (!ig || typeof ig !== 'object') {
    var emptyCard = secCard('secImageGen');
    emptyCard.appendChild(el('div', { class: 'info-text', text: t('noData') }));
    return;
  }
  var card = secCard('secImageGen');
  [
    { t: 'fldImgUrl', p: ['toolsConfig', 'generate_image', 'url'], w: 'text' },
    { t: 'fldImgModel', p: ['toolsConfig', 'generate_image', 'model'], w: 'text' },
    { t: 'fldImgKey', p: ['toolsConfig', 'generate_image', 'apiKey'], w: 'password' },
    { t: 'fldImgAspect', p: ['toolsConfig', 'generate_image', 'enableAspectRatio'], w: 'toggle' },
    { t: 'fldImgAspectDef', p: ['toolsConfig', 'generate_image', 'defaultAspectRatio'], w: 'text' },
    { t: 'fldImgSize', p: ['toolsConfig', 'generate_image', 'enableImageSize'], w: 'toggle' },
    { t: 'fldImgSizeDef', p: ['toolsConfig', 'generate_image', 'defaultImageSize'], w: 'text' },
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
  var listCard = secCard('subAgentsList');
  var agents = getVal(S.settings, ['toolsConfig', 'subagents', 'agents']);
  if (Array.isArray(agents) && agents.length) {
    agents.forEach(function (agent, i) {
      var row = el('div', { class: 'item-row' });
      var td = el('div', { class: 't' });
      td.appendChild(el('div', { class: 'name', text: agent.name || agent.type || '' }));
      if (agent.description) td.appendChild(el('div', { class: 'sub', text: agent.description }));
      row.appendChild(td);
      row.appendChild(itemToggle(agent.enabled !== false, function (v) {
        var next = agents.slice();
        next[i] = Object.assign({}, agent, { enabled: v });
        saveSettingsPatch(patchFor(['toolsConfig', 'subagents', 'agents'], next));
      }));
      var editBtn = el('button', { class: 'mini-btn', text: t('editChannel') });
      editBtn.addEventListener('click', function () { openSubagentForm(agent); });
      row.appendChild(editBtn);
      var delBtn = el('button', { class: 'mini-btn danger', text: t('deleteChannel') });
      delBtn.addEventListener('click', function () {
        openModal(t('deleteChannel'), null, t('deleteChannelConfirm'), t('renameCancel'), 'danger', function () {
          post('/api/subagent-delete', { type: agent.type }).then(function () {
            toast(t('deleted'));
            loadSettings();
          }).catch(function (err) {
            toast(t('settingsFailed') + ': ' + (err.message || ''));
          });
        });
      });
      row.appendChild(delBtn);
      listCard.appendChild(row);
    });
  } else {
    listCard.appendChild(el('div', { class: 'info-text', text: t('noData') }));
  }
  var addBtn = el('button', { class: 'add-channel-btn' });
  addBtn.innerHTML = icon('plus') + '<span>' + esc(t('subCreate')) + '</span>';
  addBtn.addEventListener('click', function () { openSubagentForm(null); });
  listCard.appendChild(addBtn);
}
/* 子代理完整表单弹窗（新建 / 编辑共用；POST /api/subagent-save） */
function openSubagentForm(agent) {
  var modalEl = $('modal');
  var bodyEl = $('modal-body');
  $('modal-title').textContent = agent ? (t('editChannel') + ': ' + (agent.name || agent.type)) : t('subCreate');
  bodyEl.innerHTML = '';
  $('modal-input').hidden = true;
  var reg = {};
  var channelSel;
  var modeSel;
  var whitelistBox;
  var blacklistBox;
  function renderToolsBox(mode) {
    bodyEl.querySelectorAll('.sub-tools-box').forEach(function (n) { n.remove(); });
    if (mode !== 'whitelist' && mode !== 'blacklist') return;
    var wrap = el('div', { class: 'set-field sub-tools-box' });
    wrap.appendChild(el('span', { class: 'k', text: mode === 'whitelist' ? t('subWhitelist') : t('subBlacklist') }));
    var ctl = el('span', { class: 'ctl' });
    var box = chkList(agent && agent.tools && agent.tools.mode === mode ? (agent.tools.list || []) : [], toolNameItems());
    ctl.appendChild(box);
    wrap.appendChild(ctl);
    bodyEl.appendChild(wrap);
    if (mode === 'whitelist') whitelistBox = box;
    else blacklistBox = box;
  }
  chField(bodyEl, reg, 'name', t('subName'), 'text');
  chField(bodyEl, reg, 'systemPrompt', t('subSystemPrompt'), 'textarea');
  channelSel = el('select');
  channelSel.appendChild(el('option', { value: '', text: '—' }));
  (S.configs || []).forEach(function (c) {
    channelSel.appendChild(el('option', { value: c.id, text: c.name || c.id }));
  });
  var chWrap = el('div', { class: 'set-field' });
  chWrap.appendChild(el('span', { class: 'k', text: t('subChannel') }));
  var chCtl = el('span', { class: 'ctl' });
  chCtl.appendChild(channelSel);
  chWrap.appendChild(chCtl);
  bodyEl.appendChild(chWrap);
  chField(bodyEl, reg, 'model', t('subModel'), 'text');
  modeSel = el('select');
  ['all', 'builtin', 'mcp', 'whitelist', 'blacklist'].forEach(function (o) {
    modeSel.appendChild(el('option', { value: o, text: o }));
  });
  var modeWrap = el('div', { class: 'set-field' });
  modeWrap.appendChild(el('span', { class: 'k', text: t('subToolsMode') }));
  var modeCtl = el('span', { class: 'ctl' });
  modeCtl.appendChild(modeSel);
  modeWrap.appendChild(modeCtl);
  bodyEl.appendChild(modeWrap);
  modeSel.addEventListener('change', function () {
    renderToolsBox(modeSel.value);
  });
  chField(bodyEl, reg, 'maxIterations', t('subMaxIterations'), 'number', { min: -1 });
  chField(bodyEl, reg, 'maxRuntime', t('subMaxRuntime'), 'number', { min: -1 });
  chField(bodyEl, reg, 'enabled', t('enable'), 'toggle', { def: true });
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('saveChannel');
  $('modal-ok').className = 'btn';
  modalEl._onOk = function () {
    var name = chVal(reg, 'name', '').trim();
    if (!name) { toast(t('channelNameRequired')); return; }
    var type = agent ? (agent.type || '') : (name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'agent-' + Date.now().toString(36));
    var payload = {
      type: type,
      name: name,
      systemPrompt: chVal(reg, 'systemPrompt', ''),
      maxIterations: chVal(reg, 'maxIterations', undefined),
      maxRuntime: chVal(reg, 'maxRuntime', undefined),
      enabled: chVal(reg, 'enabled', true)
    };
    var channelId = channelSel.value;
    var modelId = chVal(reg, 'model', '').trim();
    if (channelId) payload.channel = { channelId: channelId, modelId: modelId || undefined };
    var mode = modeSel.value;
    var tools = { mode: mode };
    if (mode === 'whitelist' && whitelistBox) tools.list = (whitelistBox._value || []).slice();
    if (mode === 'blacklist' && blacklistBox) tools.list = (blacklistBox._value || []).slice();
    payload.tools = tools;
    post('/api/subagent-save', payload).then(function () {
      toast(t('channelSaved'));
      closeModal();
      loadSettings();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  };
  /* 回填 */
  if (agent) {
    chFill(reg, 'name', agent.name, '');
    chFill(reg, 'systemPrompt', agent.systemPrompt, '');
    channelSel.value = (agent.channel && agent.channel.channelId) || '';
    chFill(reg, 'model', agent.channel && agent.channel.modelId, '');
    modeSel.value = (agent.tools && agent.tools.mode) || 'all';
    renderToolsBox(modeSel.value);
    chFill(reg, 'maxIterations', agent.maxIterations, '');
    chFill(reg, 'maxRuntime', agent.maxRuntime, '');
    chFill(reg, 'enabled', agent.enabled !== false, true);
  }
  modalEl.classList.add('open');
  setTimeout(function () {
    var nameInput = bodyEl.querySelector('input[type="text"]');
    if (nameInput) nameInput.focus();
  }, 60);
}
function renderPinnedSection() {
  var card = secCard('secPinned');
  var files = getVal(S.settings, ['toolsConfig', 'pinned_files', 'files']);
  if (!Array.isArray(files) || files.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noData') }));
  } else {
    files.forEach(function (f, i) {
      var row = el('div', { class: 'item-row' });
      var td = el('div', { class: 't' });
      td.appendChild(el('div', { class: 'name', text: (f && f.path) || '' }));
      if (f && f.workspaceUri) td.appendChild(el('div', { class: 'sub', text: f.workspaceUri }));
      row.appendChild(td);
      row.appendChild(itemToggle(f && f.enabled !== false, function (v) {
        var next = files.slice();
        next[i] = Object.assign({}, f, { enabled: v });
        saveSettingsPatch(patchFor(['toolsConfig', 'pinned_files', 'files'], next));
      }));
      var rmBtn = el('button', { class: 'mini-btn danger', text: t('remove') });
      rmBtn.addEventListener('click', function () {
        var next = files.slice();
        next.splice(i, 1);
        saveSettingsPatch(patchFor(['toolsConfig', 'pinned_files', 'files'], next));
      });
      row.appendChild(rmBtn);
      card.appendChild(row);
    });
  }
  card.appendChild(el('div', { class: 'set-note', text: t('fldPinnedPath') }));
}
function renderRemoteSection() {
  var card = secCard('secRemote');
  var info = S.statusInfo || {};
  /* 启用开关 + 端口（桌面端 RemoteControlSettings 同款，保存后需重启生效） */
  var enabledVal = getVal(S.settings, ['remoteControl', 'enabled']);
  var portVal = getVal(S.settings, ['remoteControl', 'port']);
  var rcEnabled = enabledVal === true;
  renderField(card, { t: 'fldRcEnabled', p: ['remoteControl', 'enabled'], w: 'toggle' });
  renderField(card, { t: 'fldRcPort', p: ['remoteControl', 'port'], w: 'number', min: 1, max: 65535 });
  card.appendChild(el('div', { class: 'set-note', text: t('rcSaveHint') }));
  var curPort = portVal != null ? portVal : info.port;
  [
    { k: t('connection'), v: info.running ? t('running') : t('stopped') },
    { k: t('port'), v: String(curPort != null ? curPort : '') },
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
      toast(t('fldRcRestart'));
      S.serverStopped = true;
      probeServerRecovery();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  var stop = el('button', { class: 'btn danger', text: t('fldRcStop') });
  stop.addEventListener('click', function () {
    post('/api/remote-action', { type: 'stop' }).then(function () {
      toast(t('fldRcStop'));
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
  var actions = el('div', { class: 'sheet-actions' });
  var openBtn = el('button', { class: 'btn', text: t('opStorageOpen') });
  openBtn.addEventListener('click', function () {
    post('/api/storage-select', {}).then(function () {
      toast(t('openFolderDialog'));
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  var resetBtn = el('button', { class: 'btn', text: t('opStorageReset') });
  resetBtn.addEventListener('click', function () {
    post('/api/storage-reset', {}).then(function () {
      toast(t('settingsSaved'));
      loadSettings();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  actions.appendChild(openBtn);
  actions.appendChild(resetBtn);
  card.appendChild(actions);
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
    if (dep.installed) {
      row.appendChild(el('span', { class: 'chip', text: t('depInstalled'), style: 'color:var(--green)' }));
      var unBtn = el('button', { class: 'mini-btn danger', text: t('uninstall') });
      unBtn.addEventListener('click', function () {
        post('/api/dependency-uninstall', { name: dep.name }).then(function () {
          toast(t('removed'));
          loadDeps();
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
      row.appendChild(unBtn);
    } else {
      row.appendChild(el('span', { class: 'chip', text: t('depMissing'), style: 'color:var(--red)' }));
      var instBtn = el('button', { class: 'mini-btn', text: t('install') });
      instBtn.addEventListener('click', function () {
        instBtn.disabled = true;
        post('/api/dependency-install', { name: dep.name }).then(function () {
          toast(t('installed'));
          loadDeps();
        }).catch(function (err) {
          instBtn.disabled = false;
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
      row.appendChild(instBtn);
    }
    card.appendChild(row);
  });
}
/* ---------- MCP 服务器管理（透传 webview McpHandlers，与桌面端同一存储） ---------- */
function loadMcpServers() {
  api('/api/mcp').then(function (data) {
    S_MCP.servers = Array.isArray(data.servers) ? data.servers : [];
    S_MCP.loaded = true;
    if (isPanelOpen('settings') && S.settingsTab === 'mcp') renderAllSettingsSections();
  }).catch(function () {});
}
function renderMcpSection() {
  var card = secCard('secMcp');
  if (!S_MCP.loaded) {
    card.appendChild(el('div', { class: 'info-text', text: t('loading') }));
  } else if (S_MCP.servers.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noData') }));
  } else {
    S_MCP.servers.forEach(function (srv) {
      var item = el('div', { class: 'cfg-item' });
      item.appendChild(el('div', { class: 'cname', text: srv.name || srv.id || '' }));
      var statusText = srv.status === 'connected' ? t('mcpConnected') : (srv.status === 'error' ? t('loadFailed') : t('mcpDisconnected'));
      item.appendChild(el('div', {
        class: 'cmodel',
        text: (srv.transport && srv.transport.type) + ' · ' + statusText
      }));
      var ctrl = el('div', { class: 'item-row' });
      var tag = el('span', { class: 't' });
      tag.textContent = srv.enabled === false ? t('disabled') : '';
      tag.style.color = srv.enabled === false ? 'var(--red)' : 'var(--dim)';
      ctrl.appendChild(tag);
      ctrl.appendChild(itemToggle(srv.enabled !== false, function (v) {
        srv.enabled = v;
        post('/api/mcp-toggle', { serverId: srv.id, enabled: v }).then(function () {
          toast(t('settingsSaved'));
          loadMcpServers();
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      }));
      item.appendChild(ctrl);
      var actions = el('div', { class: 'cfg-actions' });
      if (srv.status === 'connected') {
        var discBtn = el('button', { class: 'mini-btn', text: t('mcpDisconnect') });
        discBtn.addEventListener('click', function () {
          post('/api/mcp-disconnect', { serverId: srv.id }).then(function () {
            toast(t('settingsSaved'));
            loadMcpServers();
          }).catch(function (err) {
            toast(t('settingsFailed') + ': ' + (err.message || ''));
          });
        });
        actions.appendChild(discBtn);
      } else {
        var connBtn = el('button', { class: 'mini-btn', text: t('mcpConnect') });
        connBtn.addEventListener('click', function () {
          post('/api/mcp-connect', { serverId: srv.id }).then(function () {
            toast(t('settingsSaved'));
            loadMcpServers();
          }).catch(function (err) {
            toast(t('settingsFailed') + ': ' + (err.message || ''));
          });
        });
        actions.appendChild(connBtn);
      }
      var editBtn = el('button', { class: 'mini-btn', text: t('editChannel') });
      editBtn.addEventListener('click', function () { editMcpServer(srv); });
      actions.appendChild(editBtn);
      var delBtn = el('button', { class: 'mini-btn danger', text: t('deleteChannel') });
      delBtn.addEventListener('click', function () {
        openModal(t('deleteChannel'), null, t('deleteChannelConfirm'), t('renameCancel'), 'danger', function () {
          post('/api/mcp-delete', { serverId: srv.id }).then(function () {
            toast(t('deleted'));
            loadMcpServers();
          }).catch(function (err) {
            toast(t('settingsFailed') + ': ' + (err.message || ''));
          });
        });
      });
      actions.appendChild(delBtn);
      item.appendChild(actions);
      card.appendChild(item);
    });
  }
  var addBtn = el('button', { class: 'add-channel-btn' });
  addBtn.innerHTML = icon('plus') + '<span>' + esc(t('addMcpServer')) + '</span>';
  addBtn.addEventListener('click', addMcpServerDialog);
  card.appendChild(addBtn);
}
function addMcpServerDialog() {
  var modalEl = $('modal');
  $('modal-title').textContent = t('addMcpServer');
  var bodyEl = $('modal-body');
  bodyEl.innerHTML = '';
  $('modal-input').hidden = true;
  var nameWrap = el('div', { class: 'set-field' });
  nameWrap.appendChild(el('span', { class: 'k', text: t('channelName') }));
  var nameInput = el('input', { type: 'text', placeholder: 'My MCP Server' });
  nameWrap.appendChild(nameInput);
  bodyEl.appendChild(nameWrap);
  var idWrap = el('div', { class: 'set-field' });
  idWrap.appendChild(el('span', { class: 'k', text: 'ID' }));
  var idInput = el('input', { type: 'text', placeholder: 'my-server' });
  idWrap.appendChild(idInput);
  bodyEl.appendChild(idWrap);
  var typeWrap = el('div', { class: 'set-field' });
  typeWrap.appendChild(el('span', { class: 'k', text: t('mcpTransport') }));
  var typeSel = el('select');
  [{ v: 'stdio', label: 'stdio' }, { v: 'sse', label: 'SSE' }, { v: 'streamable-http', label: 'Streamable HTTP' }].forEach(function (o) {
    typeSel.appendChild(el('option', { value: o.v, text: o.label }));
  });
  typeWrap.appendChild(typeSel);
  bodyEl.appendChild(typeWrap);
  var cmdWrap = el('div', { class: 'set-field' });
  cmdWrap.appendChild(el('span', { class: 'k', text: t('mcpCommand') }));
  var cmdInput = el('input', { type: 'text', placeholder: 'npx -y @modelcontextprotocol/server-filesystem' });
  cmdWrap.appendChild(cmdInput);
  bodyEl.appendChild(cmdWrap);
  var urlWrap = el('div', { class: 'set-field', hidden: true });
  urlWrap.appendChild(el('span', { class: 'k', text: t('channelUrl') }));
  var urlInput = el('input', { type: 'text', placeholder: 'http://localhost:3000/mcp' });
  urlWrap.appendChild(urlInput);
  bodyEl.appendChild(urlWrap);
  typeSel.addEventListener('change', function () {
    urlWrap.hidden = typeSel.value === 'stdio';
    cmdWrap.hidden = typeSel.value !== 'stdio';
  });
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('createChannel');
  $('modal-ok').className = 'btn';
  modalEl._onOk = function () {
    var name = nameInput.value.trim();
    if (!name) { toast(t('channelNameRequired')); return; }
    var id = idInput.value.trim() || ('mcp-' + Date.now().toString(36));
    var input = { id: id, name: name, enabled: true, autoConnect: true };
    if (typeSel.value === 'stdio') {
      input.transport = { type: 'stdio', command: cmdInput.value.trim() || 'npx' };
    } else {
      var url = urlInput.value.trim();
      if (!url) { toast(t('settingsFailed')); return; }
      input.transport = { type: typeSel.value, url: url };
    }
    post('/api/mcp-create', { input: input }).then(function () {
      toast(t('channelCreated'));
      closeModal();
      loadMcpServers();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  };
  modalEl.classList.add('open');
  setTimeout(function () { nameInput.focus(); }, 60);
}
function editMcpServer(srv) {
  var modalEl = $('modal');
  $('modal-title').textContent = t('editChannel') + ': ' + (srv.name || srv.id);
  var bodyEl = $('modal-body');
  bodyEl.innerHTML = '';
  $('modal-input').hidden = true;
  var reg = {};
  chField(bodyEl, reg, 'name', t('channelName'), 'text');
  var tr = (srv.transport && srv.transport.type) || 'stdio';
  var urlWrap = el('div', { class: 'set-field' });
  urlWrap.appendChild(el('span', { class: 'k', text: t('channelUrl') }));
  var urlInput = el('input', { type: 'text' });
  urlInput.value = (srv.transport && (srv.transport.url || '')) || '';
  urlWrap.appendChild(urlInput);
  bodyEl.appendChild(urlWrap);
  var cmdWrap = el('div', { class: 'set-field' });
  cmdWrap.appendChild(el('span', { class: 'k', text: t('mcpCommand') }));
  var cmdInput = el('input', { type: 'text' });
  cmdInput.value = (srv.transport && (srv.transport.command || '')) || '';
  cmdWrap.appendChild(cmdInput);
  bodyEl.appendChild(cmdWrap);
  var argsWrap = el('div', { class: 'set-field' });
  argsWrap.appendChild(el('span', { class: 'k', text: t('mcpArgs') }));
  var argsInput = el('input', { type: 'text', placeholder: t('keepBlank') });
  argsInput.value = (srv.transport && Array.isArray(srv.transport.args)) ? srv.transport.args.join(' ') : '';
  argsWrap.appendChild(argsInput);
  bodyEl.appendChild(argsWrap);
  chField(bodyEl, reg, 'description', t('mcpDescription'), 'textarea');
  var envWrap = el('div', { class: 'set-field' });
  envWrap.appendChild(el('span', { class: 'k', text: t('mcpEnv') }));
  var envInput = el('textarea', { spellcheck: 'false', placeholder: '{"KEY":"value"}' });
  envInput.style.minHeight = '70px';
  try { envInput.value = JSON.stringify(srv.transport && srv.transport.env || {}, null, 2); } catch (e) { envInput.value = ''; }
  envWrap.appendChild(envInput);
  bodyEl.appendChild(envWrap);
  var hdrWrap = el('div', { class: 'set-field' });
  hdrWrap.appendChild(el('span', { class: 'k', text: t('mcpHeaders') }));
  var hdrInput = el('textarea', { spellcheck: 'false', placeholder: '{"Authorization":"Bearer x"}' });
  hdrInput.style.minHeight = '70px';
  try { hdrInput.value = JSON.stringify(srv.transport && srv.transport.headers || {}, null, 2); } catch (e) { hdrInput.value = ''; }
  hdrWrap.appendChild(hdrInput);
  bodyEl.appendChild(hdrWrap);
  chField(bodyEl, reg, 'autoConnect', t('mcpAutoConnect'), 'toggle', { def: true });
  chField(bodyEl, reg, 'cleanSchema', t('mcpCleanSchema'), 'toggle', { def: true });
  chField(bodyEl, reg, 'timeout', t('mcpTimeout'), 'number', { min: 1000 });
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('saveChannel');
  $('modal-ok').className = 'btn';
  modalEl._onOk = function () {
    var updates = {};
    var name = chVal(reg, 'name', '').trim();
    if (name) updates.name = name;
    var tr2 = tr;
    var newTransport = {};
    if (tr2 === 'stdio') {
      var cmd = cmdInput.value.trim();
      if (cmd) {
        newTransport = { type: 'stdio', command: cmd };
        var args = argsInput.value.trim().split(/\s+/).filter(function (a) { return a !== ''; });
        if (args.length) newTransport.args = args;
        var envText = envInput.value.trim();
        if (envText) {
          try { newTransport.env = JSON.parse(envText); } catch (e) { toast(t('settingsFailed')); return; }
        }
        updates.transport = newTransport;
      }
    } else {
      var url = urlInput.value.trim();
      if (url) {
        newTransport = { type: tr2, url: url };
        var hdrText = hdrInput.value.trim();
        if (hdrText) {
          try { newTransport.headers = JSON.parse(hdrText); } catch (e) { toast(t('settingsFailed')); return; }
        }
        updates.transport = newTransport;
      }
    }
    var desc = chVal(reg, 'description', '');
    if (typeof desc === 'string') updates.description = desc;
    updates.autoConnect = chVal(reg, 'autoConnect', true);
    updates.cleanSchema = chVal(reg, 'cleanSchema', true);
    var timeout = chVal(reg, 'timeout', undefined);
    if (timeout !== undefined) updates.timeout = timeout;
    post('/api/mcp-update', { serverId: srv.id, updates: updates }).then(function () {
      toast(t('channelSaved'));
      closeModal();
      loadMcpServers();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  };
  /* 回填 */
  chFill(reg, 'name', srv.name, '');
  chFill(reg, 'description', srv.description, '');
  chFill(reg, 'autoConnect', srv.autoConnect !== false, true);
  chFill(reg, 'cleanSchema', srv.cleanSchema !== false, true);
  chFill(reg, 'timeout', srv.timeout, '');
  modalEl.classList.add('open');
}
/* ---------- 用量统计（GET /api/usage 扁平 stats，桌面端 UsagePage 同源数据） ---------- */
var S_USAGE_RANGE = 'all';
function loadUsageStats() {
  if (S_USAGE.loading) return;
  S_USAGE.loading = true;
  var q = S_USAGE_RANGE === 'all' ? '' : '?range=' + encodeURIComponent(S_USAGE_RANGE);
  api('/api/usage' + q).then(function (data) {
    S_USAGE.loading = false;
    S_USAGE.stats = data.stats || null;
    S_USAGE.loaded = true;
    if (isPanelOpen('settings') && S.settingsTab === 'usage') renderAllSettingsSections();
  }).catch(function () {
    S_USAGE.loading = false;
    S_USAGE.stats = null;
    S_USAGE.loaded = true;
    if (isPanelOpen('settings') && S.settingsTab === 'usage') renderAllSettingsSections();
  });
}
function renderUsageSection() {
  var card = secCard('secUsage');
  /* 时间范围选择（桌面端 usage.getStats startTime 语义） */
  var rangeRow = el('div', { class: 'usage-range-row' });
  rangeRow.appendChild(el('span', { class: 'k', text: t('usageRange') }));
  var rangeSel = el('select');
  [['all', t('usageRangeAll')], ['today', t('usageRangeToday')], ['7d', t('usageRange7d')], ['30d', t('usageRange30d')]].forEach(function (r) {
    rangeSel.appendChild(el('option', { value: r[0], text: r[1] }));
  });
  rangeSel.value = S_USAGE_RANGE;
  rangeSel.addEventListener('change', function () {
    S_USAGE_RANGE = rangeSel.value;
    S_USAGE.loaded = false;
    S_USAGE.stats = null;
    renderAllSettingsSections();
    loadUsageStats();
  });
  rangeRow.appendChild(rangeSel);
  card.appendChild(rangeRow);
  if (!S_USAGE.loaded) {
    card.appendChild(el('div', { class: 'info-text', text: t('loading') }));
    loadUsageStats();
    return;
  }
  var stats = S_USAGE.stats || {};
  var grid = el('div', { class: 'stat-grid' });
  function statCard(label, value) {
    var sc = el('div', { class: 'stat-card' });
    sc.appendChild(el('div', { class: 'stat-num', text: String(value) }));
    sc.appendChild(el('div', { class: 'stat-label', text: label }));
    grid.appendChild(sc);
  }
  statCard(t('usageTotalTokens'), stats.totalTokens != null ? stats.totalTokens : 0);
  statCard(t('usagePromptTokens'), stats.promptTokens != null ? stats.promptTokens : 0);
  statCard(t('usageCandidatesTokens'), stats.candidatesTokens != null ? stats.candidatesTokens : 0);
  statCard(t('usageThoughts'), stats.thoughtsTokens != null ? stats.thoughtsTokens : 0);
  statCard(t('usageCacheRead'), stats.cacheReadTokens != null ? stats.cacheReadTokens : 0);
  statCard(t('usageCacheCreation'), stats.cacheCreationTokens != null ? stats.cacheCreationTokens : 0);
  statCard(t('usageConversations'), stats.conversations != null ? stats.conversations : 0);
  statCard(t('usageModelMessages'), stats.modelMessages != null ? stats.modelMessages : 0);
  card.appendChild(grid);
  if (stats.skippedConversations != null && stats.skippedConversations > 0) {
    card.appendChild(el('div', { class: 'set-note', text: t('usageSkipped') + ' ' + stats.skippedConversations }));
  }
  var byModel = Array.isArray(stats.byModel) ? stats.byModel : [];
  if (byModel.length > 0) {
    card.appendChild(el('div', { class: 'group-label', text: t('usageByModel') }));
    byModel.slice(0, 10).forEach(function (m) {
      var row = el('div', { class: 'set-row' });
      row.appendChild(el('span', { text: (m && (m.modelVersion || m.model || m.id)) || 'unknown' }));
      row.appendChild(el('span', { class: 'dim', text: String((m && (m.totalTokens != null ? m.totalTokens : m.tokens)) || 0) }));
      card.appendChild(row);
    });
  }
  var byDay = Array.isArray(stats.byDay) ? stats.byDay : [];
  if (byDay.length > 0) {
    card.appendChild(el('div', { class: 'group-label', text: t('usageByDay') }));
    byDay.slice(0, 14).forEach(function (d) {
      var row = el('div', { class: 'set-row' });
      row.appendChild(el('span', { text: (d && d.date) || '—' }));
      row.appendChild(el('span', { class: 'dim', text: String((d && (d.totalTokens != null ? d.totalTokens : d.tokens)) || 0) }));
      card.appendChild(row);
    });
  }
  var actions = el('div', { class: 'sheet-actions' });
  var refreshBtn = el('button', { class: 'btn', text: t('usageRefresh') });
  refreshBtn.addEventListener('click', function () {
    S_USAGE.loaded = false;
    renderAllSettingsSections();
    loadUsageStats();
  });
  actions.appendChild(refreshBtn);
  card.appendChild(actions);
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
  /* 每类别自定义排除模式（toolsConfig.checkpoint.exclusion.profilePatterns.<profileId>） */
  CKPT_PROFILES.forEach(function (p) {
    renderField(exCard, {
      t: p.labelKey,
      p: ['toolsConfig', 'checkpoint', 'exclusion', 'profilePatterns', p.value],
      w: 'chips'
    });
  });
  renderField(exCard, { t: 'ckptMaxSizeMiB', p: ['toolsConfig', 'checkpoint', 'exclusion', 'maxFileSizeBytes'], w: 'number', min: 1 });
  renderField(exCard, { t: 'ckptCustomPatterns', p: ['toolsConfig', 'checkpoint', 'exclusion', 'customPatterns'], w: 'chips' });
}
/* ---------- 渠道管理 ---------- */
function renderConfigsCard() {
  var card = secCard('secChannel');
  if (S.configs.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('noConfigs') }));
    var addBtn0 = el('button', { class: 'add-channel-btn' });
    addBtn0.innerHTML = icon('plus') + '<span>' + esc(t('addChannel')) + '</span>';
    addBtn0.addEventListener('click', addChannelDialog);
    card.appendChild(addBtn0);
    return;
  }
  /* ① 渠道选择器（桌面端 ChannelSettings 顶部同款：选中即设为当前） */
  var selRow = el('div', { class: 'cfg-selector' });
  var sel = el('select');
  var curId = '';
  var activeCfg = null;
  S.configs.forEach(function (c) { if (c.id === S.activeChannelId) activeCfg = c; });
  curId = activeCfg ? activeCfg.id : S.configs[0].id;
  sel.appendChild(el('option', { value: '', text: t('chSelector') }));
  S.configs.forEach(function (c) {
    sel.appendChild(el('option', {
      value: c.id,
      text: (c.name || c.id) + (c.type ? ' · ' + c.type : '')
    }));
  });
  sel.value = curId || '';
  sel.addEventListener('change', function () {
    var id = sel.value;
    if (!id) return;
    var cfg = null;
    S.configs.forEach(function (c) { if (c.id === id) cfg = c; });
    if (!cfg) return;
    if (S.activeChannelId !== id) setChannelActive(cfg);
    else renderAllSettingsSections();
  });
  selRow.appendChild(sel);
  var newBtn = el('button', { class: 'mini-btn' });
  newBtn.innerHTML = icon('plus') + '<span>' + esc(t('addChannel')) + '</span>';
  newBtn.addEventListener('click', addChannelDialog);
  selRow.appendChild(newBtn);
  card.appendChild(selRow);
  /* ② 当前渠道完整设置表单（桌面端 ChannelSettings 同构：折叠菜单 + 子菜单） */
  var current = activeCfg || S.configs[0];
  renderChannelForm(card, current);
  /* ③ 渠道列表卡片（快捷操作：设为当前/模型管理/编辑/删除） */
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
      var act = el('button', { class: 'mini-btn' });
      act.innerHTML = icon('check') + '<span>' + esc(t('setActiveChannel')) + '</span>';
      act.addEventListener('click', function () { setChannelActive(cfg); });
      actions.appendChild(act);
    }
    var modelsBtn = el('button', { class: 'mini-btn' });
    modelsBtn.innerHTML = icon('list') + '<span>' + esc(t('manageModels')) + '</span>';
    modelsBtn.addEventListener('click', function () { openModelsDialog(cfg); });
    actions.appendChild(modelsBtn);
    var editBtn = el('button', { class: 'mini-btn' });
    editBtn.innerHTML = icon('edit') + '<span>' + esc(t('editChannel')) + '</span>';
    editBtn.addEventListener('click', function () { editChannel(cfg); });
    actions.appendChild(editBtn);
    var delBtn = el('button', { class: 'mini-btn danger' });
    delBtn.innerHTML = icon('trash') + '<span>' + esc(t('deleteChannel')) + '</span>';
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
/* ============================================================
   渠道内联设置表单（桌面端 ChannelSettings 同构）
   ============================================================ */
var S_CH_DETAIL = {};
var S_CH_FORM = null;
/* 静默保存渠道字段（改即存，不刷 toast） */
function saveChannelPatch(configId, updates) {
  if (!configId || !updates || Object.keys(updates).length === 0) return;
  post('/api/config-update', { configId: configId, updates: updates }).then(function () {
    if (S_CH_FORM === configId) loadChannelDetail(configId, function (detail) {
      if (detail) S_CH_DETAIL[configId] = detail;
    });
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
/* 折叠面板：头部 chevron + 标题 + 可选 header toggle（点击开关不展开） */
function collapSection(headLabel, opts) {
  var item = el('div', { class: 'collap' });
  var head = el('button', { type: 'button', class: 'collap-head' });
  var chev = el('span', { class: 'collap-chev' });
  chev.innerHTML = icon('chevronRight');
  head.appendChild(chev);
  head.appendChild(el('span', { class: 'collap-title', text: headLabel }));
  var state = { open: false, toggle: null };
  if (opts && opts.headerToggle) {
    var tg = itemToggle(!!(opts.initial === true), function (v) {
      tg._value = v;
      if (opts.onToggle) opts.onToggle(v);
    });
    tg._value = !!(opts.initial === true);
    state.toggle = tg;
    head.appendChild(tg);
  }
  var body = el('div', { class: 'collap-body hidden' });
  head.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.tgl')) return;
    state.open = !state.open;
    chev.innerHTML = icon(state.open ? 'chevronDown' : 'chevronRight');
    chev.classList.toggle('open', state.open);
    body.classList.toggle('hidden', !state.open);
  });
  item.appendChild(head);
  item.appendChild(body);
  return { item: item, body: body, toggle: state.toggle };
}
/* 子分组（高级选项下的思考配置等）：静态标题 + 可选 header toggle */
function cfgSubGroup(titleLabel, opts) {
  var box = el('div', { class: 'cfg-sub' });
  var headRow = el('div', { class: 'cfg-sub-title' });
  headRow.appendChild(el('span', { text: titleLabel }));
  var state = { toggle: null };
  if (opts && opts.headerToggle) {
    var tg = itemToggle(!!(opts.initial === true), function (v) {
      tg._value = v;
      if (opts.onToggle) opts.onToggle(v);
    });
    tg._value = !!(opts.initial === true);
    state.toggle = tg;
    headRow.appendChild(tg);
  }
  box.appendChild(headRow);
  return { box: box, toggle: state.toggle };
}
/* 渠道表单字段（chField 同款控件 + 即时保存） */
function chInline(container, reg, key, label, w, opts, onSave) {
  var wrap = el('div', { class: 'set-field' });
  wrap.appendChild(el('span', { class: 'k', text: label }));
  var ctl = el('span', { class: 'ctl' });
  var c = null;
  if (w === 'select') {
    var sel = el('select');
    (opts && opts.options ? opts.options : []).forEach(function (o) {
      sel.appendChild(el('option', { value: o, text: o }));
    });
    ctl.appendChild(sel);
    c = sel;
    sel.addEventListener('change', function () { onSave(chVal({ k: sel }, 'k', '')); });
  } else if (w === 'number') {
    var num = el('input', { type: 'number' });
    if (opts && opts.min != null) num.min = String(opts.min);
    if (opts && opts.max != null) num.max = String(opts.max);
    ctl.appendChild(num);
    c = num;
    num.addEventListener('change', function () {
      var v = num.value.trim();
      if (v === '' || !isFinite(Number(v))) return;
      onSave(Number(v));
    });
  } else if (w === 'text') {
    var inp = el('input', { type: 'text' });
    ctl.appendChild(inp);
    c = inp;
    inp.addEventListener('change', function () { onSave(inp.value); });
  } else if (w === 'password') {
    var pw = el('input', { type: 'password', autocomplete: 'new-password', placeholder: t('apiKeySet') });
    ctl.appendChild(pw);
    c = pw;
    pw.addEventListener('change', function () {
      if (!pw.value) { pw.value = ''; return; }
      onSave(pw.value);
      pw.value = '';
    });
  } else if (w === 'toggle') {
    var tg = itemToggle(!!(opts && opts.def === true), function (v) { tg._value = v; onSave(v); });
    tg._value = !!(opts && opts.def === true);
    ctl.appendChild(tg);
    c = tg;
  } else if (w === 'textarea') {
    var ta = el('textarea', { spellcheck: 'false', placeholder: t('keepBlank') });
    ta.style.minHeight = '64px';
    ctl.appendChild(ta);
    c = ta;
    ta.addEventListener('change', function () { onSave(ta.value); });
  } else {
    var inp2 = el('input', { type: 'text' });
    ctl.appendChild(inp2);
    c = inp2;
    inp2.addEventListener('change', function () { onSave(inp2.value); });
  }
  wrap.appendChild(ctl);
  container.appendChild(wrap);
  reg[key] = c;
  return c;
}
/* 「开关 + 数值」成对即时保存（optionsEnabled.X + options.X） */
function chInlineOpt(container, reg, key, label) {
  var wrap = el('div', { class: 'set-field' });
  wrap.appendChild(el('span', { class: 'k', text: label }));
  var ctl = el('span', { class: 'ctl' });
  var tg = itemToggle(false, function (v) { tg._value = v; });
  tg._value = false;
  ctl.appendChild(tg);
  var num = el('input', { type: 'number', style: 'flex:1;min-width:120px;' });
  ctl.appendChild(num);
  wrap.appendChild(ctl);
  container.appendChild(wrap);
  reg[key] = { tg: tg, num: num };
  return reg[key];
}
function chInlineOptRead(reg, key) {
  var c = reg[key];
  if (!c) return null;
  var inp = c.tg.querySelector('input');
  return { enabled: (!!(inp && inp.checked) || c.tg._value === true), value: String(c.num.value).trim() };
}
function chInlineOptFill(reg, key, optionsEnabled, options) {
  var c = reg[key];
  if (!c) return;
  var oe = optionsEnabled || {};
  var op = options || {};
  var enabled = oe[key] === true;
  c.tg.querySelector('input').checked = enabled;
  c.tg._value = enabled;
  c.num.value = op[key] != null ? String(op[key]) : '';
}
/* 主渲染：渠道完整表单（折叠菜单 + 子菜单，全部即时保存） */
function renderChannelForm(card, cfg) {
  var configId = cfg.id;
  S_CH_FORM = configId;
  var formWrap = el('div', { id: 'ch-form-' + configId, class: 'ch-form' });
  card.appendChild(formWrap);
  var pending = el('div', { class: 'info-text', text: t('loading') });
  formWrap.appendChild(pending);
  loadChannelDetail(configId, function (detail) {
    if (detail) S_CH_DETAIL[configId] = detail;
    if (S_CH_FORM !== configId) return;
    formWrap.innerHTML = '';
    var d = Object.assign({}, cfg, detail || {});
    var reg = {};
    var type = d.type || 'openai';
    /* ---------- 基础字段（桌面端顺序一致） ---------- */
    chInline(formWrap, reg, 'enabled', t('chEnableSection'), 'toggle', { def: true }, function (v) {
      saveChannelPatch(configId, { enabled: v });
    });
    chInline(formWrap, reg, 'url', t('chApiUrlSection'), 'text', null, function (v) {
      saveChannelPatch(configId, { url: v });
    });
    chInline(formWrap, reg, 'apiKey', t('chApiKeySection'), 'password', null, function (v) {
      saveChannelPatch(configId, { apiKey: v });
    });
    if (type === 'gemini' || type === 'anthropic') {
      chInline(formWrap, reg, 'useAuthorizationHeader', t('fldChUseAuth'), 'toggle', { def: false }, function (v) {
        saveChannelPatch(configId, { useAuthorizationHeader: v });
      });
    }
    /* 模型列表入口 */
    var modelRow = el('div', { class: 'set-field' });
    modelRow.appendChild(el('span', { class: 'k', text: t('chModelsSection') }));
    var modelCtl = el('span', { class: 'ctl' });
    var modelBtn = el('button', { class: 'mini-btn' });
    modelBtn.innerHTML = icon('list') + '<span>' + esc(t('manageModels')) + '</span>';
    modelBtn.addEventListener('click', function () { openModelsDialog(cfg); });
    modelCtl.appendChild(modelBtn);
    modelRow.appendChild(modelCtl);
    formWrap.appendChild(modelRow);
    chInline(formWrap, reg, 'streamOutput', t('chStreamSection'), 'toggle', { def: true }, function (v) {
      var opts = Object.assign({}, d.options || {});
      opts.stream = v;
      saveChannelPatch(configId, { options: opts });
    });
    chInline(formWrap, reg, 'type', t('chTypeSection'), 'select', { options: ['gemini', 'openai', 'openai-responses', 'anthropic'] }, function (v) {
      if (v === type) return;
      openModal(t('channelType'), null, t('confirmSwitchType'), t('renameCancel'), null, function () {
        saveChannelPatch(configId, { type: v });
        renderAllSettingsSections();
      });
    });
    chInline(formWrap, reg, 'toolMode', t('chToolModeSection'), 'select', { options: ['function_call', 'xml', 'json'] }, function (v) {
      saveChannelPatch(configId, { toolMode: v });
    });
    chInline(formWrap, reg, 'multimodalToolsEnabled', t('chMultimodalSection'), 'toggle', { def: true }, function (v) {
      saveChannelPatch(configId, { multimodalToolsEnabled: v });
    });
    chInline(formWrap, reg, 'strictToolsEnabled', t('chStrictSection'), 'toggle', { def: false }, function (v) {
      saveChannelPatch(configId, { strictToolsEnabled: v });
    });
    chInline(formWrap, reg, 'timeout', t('chTimeoutSection'), 'number', { min: 0 }, function (v) {
      saveChannelPatch(configId, { timeout: v });
    });
    chInline(formWrap, reg, 'maxContextTokens', t('chMaxCtxSection'), 'number', { min: 0 }, function (v) {
      saveChannelPatch(configId, { maxContextTokens: v });
    });
    /* ---------- 上下文管理（折叠 + header toggle，桌面端同款） ---------- */
    var ctxEnabled = d.contextManagementEnabled === true || !!(d.contextThresholdEnabled || d.autoSummarizeEnabled);
    var ctx = collapSection(t('chContextMgmtSection'), {
      headerToggle: true,
      initial: ctxEnabled,
      onToggle: function (v) {
        if (v) {
          saveChannelPatch(configId, {
            contextManagementEnabled: true,
            contextManagementMode: 'summarize',
            contextThresholdEnabled: false,
            autoSummarizeEnabled: true
          });
        } else {
          saveChannelPatch(configId, {
            contextManagementEnabled: false,
            contextThresholdEnabled: false,
            autoSummarizeEnabled: false
          });
        }
      }
    });
    chInline(ctx.body, reg, 'contextManagementMode', t('chContextMgmtSection'), 'select', { options: ['summarize'] }, function (v) {
      saveChannelPatch(configId, { contextManagementMode: v });
    });
    chInline(ctx.body, reg, 'contextThreshold', t('fldChContextThreshold'), 'text', null, function (v) {
      saveChannelPatch(configId, { contextThreshold: v });
    });
    chInline(ctx.body, reg, 'autoSummarizeEnabled', t('fldChAutoSummarize'), 'toggle', { def: false }, function (v) {
      saveChannelPatch(configId, { autoSummarizeEnabled: v });
    });
    formWrap.appendChild(ctx.item);
    /* ---------- 工具配置（折叠） ---------- */
    var topts = collapSection(t('chToolOptionsSection'));
    chInline(topts.body, reg, 'cropImageNorm', t('fldChToolCropNorm'), 'toggle', { def: true }, function (v) {
      saveChannelPatch(configId, { toolOptions: { cropImage: { useNormalizedCoordinates: v } } });
    });
    formWrap.appendChild(topts.item);
    /* ---------- Token 计数方式（折叠 + 子配置） ---------- */
    var tcm = collapSection(t('chTokenCountSection'));
    var tcBox = el('div', { style: 'display:none;' });
    chInline(tcm.body, reg, 'tokenCountMethod', t('fldChTokenCountMethod'), 'select', {
      options: ['channel_default', 'gemini', 'openai_custom', 'openai_responses', 'anthropic', 'local']
    }, function (v) {
      saveChannelPatch(configId, { tokenCountMethod: v });
      var m = v;
      tcBox.style.display = (m === 'channel_default' || m === 'local') ? 'none' : 'block';
    });
    chInline(tcBox, reg, 'tcUrl', t('fldTokUrl'), 'text', null, function (v) {
      var cur = Object.assign({}, d.tokenCountApiConfig || {});
      cur.url = v;
      saveChannelPatch(configId, { tokenCountApiConfig: cur });
    });
    chInline(tcBox, reg, 'tcKey', t('fldTokKey'), 'password', null, function (v) {
      var cur = Object.assign({}, d.tokenCountApiConfig || {});
      cur.apiKey = v;
      saveChannelPatch(configId, { tokenCountApiConfig: cur });
    });
    chInline(tcBox, reg, 'tcModel', t('fldTokModel'), 'text', null, function (v) {
      var cur = Object.assign({}, d.tokenCountApiConfig || {});
      cur.model = v;
      saveChannelPatch(configId, { tokenCountApiConfig: cur });
    });
    tcm.body.appendChild(tcBox);
    formWrap.appendChild(tcm.item);
    /* ---------- 高级选项（折叠 + 子分组） ---------- */
    var adv = collapSection(t('chAdvancedSection'));
    var oe = Object.assign({}, d.optionsEnabled || {});
    var op = Object.assign({}, d.options || {});
    if (type === 'gemini') {
      chInlineOpt(adv.body, reg, 'temperature', t('fldChTemperature'));
      chInlineOpt(adv.body, reg, 'maxOutputTokens', t('fldChMaxOutputTokens'));
      chInlineOpt(adv.body, reg, 'maxImages', t('chMaxImages'));
      var thinkGroup = cfgSubGroup(t('chThinkingGroup'), {
        headerToggle: true,
        initial: oe.thinkingConfig === true,
        onToggle: function (v) {
          if (v) {
            var tc = Object.assign({}, op.thinkingConfig || {});
            tc.includeThoughts = true;
            tc.mode = tc.mode || 'default';
            tc.thinkingLevel = tc.thinkingLevel || 'low';
            tc.thinkingBudget = tc.thinkingBudget || 1024;
            saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinkingConfig: true }), options: Object.assign({}, op, { thinkingConfig: tc }) });
          } else {
            var oe2 = Object.assign({}, oe); delete oe2.thinkingConfig;
            var op2 = Object.assign({}, op); delete op2.thinkingConfig;
            saveChannelPatch(configId, { optionsEnabled: oe2, options: op2 });
          }
        }
      });
      chInline(thinkGroup.box, reg, 'tc.includeThoughts', t('fldChThinkingDisplay'), 'toggle', { def: true }, function (v) {
        var tc = Object.assign({}, op.thinkingConfig || {});
        tc.includeThoughts = v;
        saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinkingConfig: true }), options: Object.assign({}, op, { thinkingConfig: tc }) });
      });
      chInline(thinkGroup.box, reg, 'tc.mode', t('fldChThinkingType'), 'select', { options: ['default', 'level', 'budget'] }, function (v) {
        var tc = Object.assign({}, op.thinkingConfig || {});
        tc.mode = v;
        saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinkingConfig: true }), options: Object.assign({}, op, { thinkingConfig: tc }) });
      });
      chInline(thinkGroup.box, reg, 'tc.thinkingLevel', t('fldChEffort'), 'select', { options: ['minimal', 'low', 'medium', 'high'] }, function (v) {
        var tc = Object.assign({}, op.thinkingConfig || {});
        tc.thinkingLevel = v;
        saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinkingConfig: true }), options: Object.assign({}, op, { thinkingConfig: tc }) });
      });
      chInline(thinkGroup.box, reg, 'tc.thinkingBudget', t('fldChThinkingBudget'), 'number', { min: 1 }, function (v) {
        var tc = Object.assign({}, op.thinkingConfig || {});
        tc.thinkingBudget = v;
        saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinkingConfig: true }), options: Object.assign({}, op, { thinkingConfig: tc }) });
      });
      adv.body.appendChild(thinkGroup.box);
    } else if (type === 'anthropic') {
      chInlineOpt(adv.body, reg, 'temperature', t('fldChTemperature'));
      chInlineOpt(adv.body, reg, 'max_tokens', t('fldChMaxOutputTokens'));
      chInlineOpt(adv.body, reg, 'top_p', t('fldChTopP'));
      chInlineOpt(adv.body, reg, 'top_k', t('fldChTopK'));
      var thinkGroupA = cfgSubGroup(t('chThinkingGroup'), {
        headerToggle: true,
        initial: oe.thinking === true,
        onToggle: function (v) {
          if (v) {
            var tc = Object.assign({}, op.thinking || {});
            tc.type = tc.type || 'adaptive';
            tc.effort = tc.effort || 'high';
            tc.budget_tokens = tc.budget_tokens || 10000;
            saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinking: true }), options: Object.assign({}, op, { thinking: tc }) });
          } else {
            var oe2 = Object.assign({}, oe); delete oe2.thinking;
            var op2 = Object.assign({}, op); delete op2.thinking;
            saveChannelPatch(configId, { optionsEnabled: oe2, options: op2 });
          }
        }
      });
      chInline(thinkGroupA.box, reg, 'thinking.type', t('fldChThinkingType'), 'select', { options: ['adaptive', 'enabled', 'disabled'] }, function (v) {
        var tc = Object.assign({}, op.thinking || {});
        tc.type = v;
        saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinking: true }), options: Object.assign({}, op, { thinking: tc }) });
      });
      chInline(thinkGroupA.box, reg, 'thinking.effort', t('fldChEffort'), 'select', { options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom'] }, function (v) {
        var tc = Object.assign({}, op.thinking || {});
        tc.effort = v;
        saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinking: true }), options: Object.assign({}, op, { thinking: tc }) });
      });
      chInline(thinkGroupA.box, reg, 'thinking.budget_tokens', t('fldChThinkingBudget'), 'number', { min: 1024 }, function (v) {
        var tc = Object.assign({}, op.thinking || {});
        tc.budget_tokens = v;
        saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinking: true }), options: Object.assign({}, op, { thinking: tc }) });
      });
      chInline(thinkGroupA.box, reg, 'thinking.display', t('fldChThinkingDisplay'), 'select', { options: ['omitted', 'summarized'] }, function (v) {
        var tc = Object.assign({}, op.thinking || {});
        tc.display = v;
        saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { thinking: true }), options: Object.assign({}, op, { thinking: tc }) });
      });
      adv.body.appendChild(thinkGroupA.box);
    } else if (type === 'openai-responses') {
      chInlineOpt(adv.body, reg, 'temperature', t('fldChTemperature'));
      chInlineOpt(adv.body, reg, 'max_output_tokens', t('fldChMaxOutputTokens'));
      var rGroupR = cfgSubGroup(t('chThinkingGroup'), {
        headerToggle: true,
        initial: oe.reasoning === true,
        onToggle: function (v) {
          if (v) {
            var rc = Object.assign({}, op.reasoning || {});
            rc.effort = rc.effort || 'high';
            saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { reasoning: true }), options: Object.assign({}, op, { reasoning: rc }) });
          } else {
            var oe2 = Object.assign({}, oe); delete oe2.reasoning;
            var op2 = Object.assign({}, op); delete op2.reasoning;
            saveChannelPatch(configId, { optionsEnabled: oe2, options: op2 });
          }
        }
      });
      reasoningFields(rGroupR.box, reg, d, function (updates) { saveChannelPatch(configId, updates); });
      adv.body.appendChild(rGroupR.box);
    } else {
      chInlineOpt(adv.body, reg, 'temperature', t('fldChTemperature'));
      chInlineOpt(adv.body, reg, 'max_tokens', t('fldChMaxOutputTokens'));
      chInlineOpt(adv.body, reg, 'top_p', t('fldChTopP'));
      chInlineOpt(adv.body, reg, 'frequencyPenalty', t('fldChFreqPenalty'));
      chInlineOpt(adv.body, reg, 'presencePenalty', t('fldChPresencePenalty'));
      var rGroup = cfgSubGroup(t('chThinkingGroup'), {
        headerToggle: true,
        initial: oe.reasoning === true,
        onToggle: function (v) {
          if (v) {
            var rc = Object.assign({}, op.reasoning || {});
            rc.effort = rc.effort || 'high';
            saveChannelPatch(configId, { optionsEnabled: Object.assign({}, oe, { reasoning: true }), options: Object.assign({}, op, { reasoning: rc }) });
          } else {
            var oe2 = Object.assign({}, oe); delete oe2.reasoning;
            var op2 = Object.assign({}, op); delete op2.reasoning;
            saveChannelPatch(configId, { optionsEnabled: oe2, options: op2 });
          }
        }
      });
      reasoningFields(rGroup.box, reg, d, function (updates) { saveChannelPatch(configId, updates); });
      adv.body.appendChild(rGroup.box);
    }
    /* 思考回传（全部类型） */
    var thoughtGroup = cfgSubGroup(t('chThoughtGroup'));
    chInline(thoughtGroup.box, reg, 'sendCurrentThoughtSignatures', t('fldChSendThoughts'), 'toggle', { def: false }, function (v) {
      saveChannelPatch(configId, { sendCurrentThoughtSignatures: v });
    });
    chInline(thoughtGroup.box, reg, 'sendCurrentThoughts', t('fldChSendThoughts'), 'toggle', { def: false }, function (v) {
      saveChannelPatch(configId, { sendCurrentThoughts: v });
    });
    chInline(thoughtGroup.box, reg, 'sendHistoryThoughtSignatures', t('fldChSendThoughts'), 'toggle', { def: false }, function (v) {
      saveChannelPatch(configId, { sendHistoryThoughtSignatures: v });
    });
    chInline(thoughtGroup.box, reg, 'sendHistoryThoughts', t('fldChSendThoughts'), 'toggle', { def: false }, function (v) {
      saveChannelPatch(configId, { sendHistoryThoughts: v });
    });
    chInline(thoughtGroup.box, reg, 'historyThinkingRounds', t('fldChHistoryRounds'), 'number', { min: -1 }, function (v) {
      saveChannelPatch(configId, { historyThinkingRounds: v });
    });
    adv.body.appendChild(thoughtGroup.box);
    if (type === 'anthropic' || type === 'gemini') {
      var cacheGroup = cfgSubGroup(t('chCacheGroup'));
      chInline(cacheGroup.box, reg, 'promptCachingEnabled', t('fldChPromptCaching'), 'toggle', { def: false }, function (v) {
        saveChannelPatch(configId, { promptCachingEnabled: v });
      });
      chInline(cacheGroup.box, reg, 'promptCachingTtl', t('fldChTtl'), 'select', { options: ['5m', '1h'] }, function (v) {
        saveChannelPatch(configId, { promptCachingTtl: v });
      });
      chInline(cacheGroup.box, reg, 'promptCachingKeepAlive', t('fldChKeepAlive'), 'toggle', { def: false }, function (v) {
        saveChannelPatch(configId, { promptCachingKeepAlive: v });
      });
      adv.body.appendChild(cacheGroup.box);
    }
    if (type === 'anthropic') {
      chInline(adv.body, reg, 'anthropicUserIdEnabled', t('fldChAnthropicUserId'), 'toggle', { def: false }, function (v) {
        saveChannelPatch(configId, { anthropicUserIdEnabled: v });
      });
    }
    if (type === 'openai' || type === 'openai-responses') {
      chInline(adv.body, reg, 'deepSeekUserIdEnabled', t('fldChDeepSeekUserId'), 'toggle', { def: false }, function (v) {
        saveChannelPatch(configId, { deepSeekUserIdEnabled: v });
      });
      chInline(adv.body, reg, 'pdfAttachmentEnabled', t('fldChPdfAttachment'), 'toggle', { def: false }, function (v) {
        saveChannelPatch(configId, { pdfAttachmentEnabled: v });
      });
    }
    formWrap.appendChild(adv.item);
    /* ---------- 自定义 Body（折叠 + header toggle） ---------- */
    var body = collapSection(t('chCustomBodySection'), {
      headerToggle: true,
      initial: d.customBodyEnabled === true,
      onToggle: function (v) {
        saveChannelPatch(configId, { customBodyEnabled: v });
      }
    });
    chInline(body.body, reg, 'customBodyMode', t('chCustomBodyMode'), 'select', { options: ['simple', 'advanced'] }, function (v) {
      var cur = Object.assign({ mode: 'simple', items: [], json: '' }, d.customBody || {});
      cur.mode = v;
      saveChannelPatch(configId, { customBody: cur });
    });
    chInline(body.body, reg, 'customBodyItems', t('chCustomBodyItems'), 'textarea', null, function (v) {
      var cur = Object.assign({ mode: 'simple', items: [], json: '' }, d.customBody || {});
      try {
        var arr = JSON.parse(v);
        if (Array.isArray(arr)) {
          cur.items = arr;
          saveChannelPatch(configId, { customBody: cur });
        } else {
          toast(t('settingsFailed'));
        }
      } catch (e) {
        toast(t('settingsFailed'));
      }
    });
    chInline(body.body, reg, 'customBodyJson', t('chCustomBodyJson'), 'textarea', null, function (v) {
      var cur = Object.assign({ mode: 'simple', items: [], json: '' }, d.customBody || {});
      cur.json = v;
      saveChannelPatch(configId, { customBody: cur });
    });
    formWrap.appendChild(body.item);
    /* ---------- 自定义标头（折叠 + header toggle） ---------- */
    var headers = collapSection(t('chCustomHeadersSection'), {
      headerToggle: true,
      initial: d.customHeadersEnabled === true,
      onToggle: function (v) {
        saveChannelPatch(configId, { customHeadersEnabled: v });
      }
    });
    chInline(headers.body, reg, 'customHeaders', t('chCustomHeadersList'), 'textarea', null, function (v) {
      try {
        var arr = JSON.parse(v);
        if (Array.isArray(arr)) {
          saveChannelPatch(configId, { customHeaders: arr });
        } else {
          toast(t('settingsFailed'));
        }
      } catch (e) {
        toast(t('settingsFailed'));
      }
    });
    formWrap.appendChild(headers.item);
    /* ---------- 自动重试（折叠 + header toggle） ---------- */
    var retry = collapSection(t('chRetrySection'), {
      headerToggle: true,
      initial: d.retryEnabled === true,
      onToggle: function (v) {
        saveChannelPatch(configId, { retryEnabled: v });
      }
    });
    chInline(retry.body, reg, 'retryCount', t('fldChRetryCount'), 'number', { min: 1, max: 10 }, function (v) {
      saveChannelPatch(configId, { retryCount: v });
    });
    chInline(retry.body, reg, 'retryInterval', t('fldChRetryInterval'), 'number', { min: 1000, max: 60000 }, function (v) {
      saveChannelPatch(configId, { retryInterval: v });
    });
    formWrap.appendChild(retry.item);
    /* ---------- 回填现有值 ---------- */
    chFill(reg, 'enabled', d.enabled !== false, true);
    chFill(reg, 'url', d.url, '');
    if (reg.apiKey) { var apiEl = reg.apiKey; apiEl.value = ''; apiEl.placeholder = d.apiKey ? t('apiKeySet') : ''; }
    chFill(reg, 'useAuthorizationHeader', d.useAuthorizationHeader === true, false);
    chFill(reg, 'streamOutput', d.options && d.options.stream !== false, true);
    chFill(reg, 'type', d.type || 'openai', 'openai');
    chFill(reg, 'toolMode', d.toolMode || 'function_call', 'function_call');
    chFill(reg, 'multimodalToolsEnabled', d.multimodalToolsEnabled === true, true);
    chFill(reg, 'strictToolsEnabled', d.strictToolsEnabled === true, false);
    chFill(reg, 'timeout', d.timeout, undefined);
    chFill(reg, 'maxContextTokens', d.maxContextTokens, undefined);
    chFill(reg, 'contextManagementMode', d.contextManagementMode || 'summarize', 'summarize');
    chFill(reg, 'contextThreshold', d.contextThreshold || '80%', '80%');
    chFill(reg, 'autoSummarizeEnabled', d.autoSummarizeEnabled === true, false);
    chFill(reg, 'cropImageNorm', !!(d.toolOptions && d.toolOptions.cropImage && d.toolOptions.cropImage.useNormalizedCoordinates !== false), true);
    chFill(reg, 'tokenCountMethod', d.tokenCountMethod || 'channel_default', 'channel_default');
    var tcm2 = reg.tokenCountMethod;
    if (tcm2) {
      var m2 = tcm2.value || 'channel_default';
      tcBox.style.display = (m2 === 'channel_default' || m2 === 'local') ? 'none' : 'block';
      var tca = d.tokenCountApiConfig || {};
      chFill(reg, 'tcUrl', tca.url, '');
      if (reg.tcKey) { reg.tcKey.value = ''; reg.tcKey.placeholder = tca.apiKey ? t('apiKeySet') : ''; }
      chFill(reg, 'tcModel', tca.model, '');
    }
    ['temperature', 'maxOutputTokens', 'maxImages', 'max_tokens', 'max_output_tokens', 'top_p', 'top_k', 'frequencyPenalty', 'presencePenalty'].forEach(function (k) {
      chInlineOptFill(reg, k, oe, op);
    });
    chFill(reg, 'tc.includeThoughts', !!(op.thinkingConfig && op.thinkingConfig.includeThoughts !== false), true);
    chFill(reg, 'tc.mode', op.thinkingConfig && op.thinkingConfig.mode, 'default');
    chFill(reg, 'tc.thinkingLevel', op.thinkingConfig && op.thinkingConfig.thinkingLevel, 'low');
    chFill(reg, 'tc.thinkingBudget', op.thinkingConfig && op.thinkingConfig.thinkingBudget, undefined);
    chFill(reg, 'thinking.type', op.thinking && op.thinking.type, 'adaptive');
    chFill(reg, 'thinking.effort', op.thinking && op.thinking.effort, 'high');
    chFill(reg, 'thinking.budget_tokens', op.thinking && op.thinking.budget_tokens, undefined);
    chFill(reg, 'thinking.display', op.thinking && op.thinking.display, 'omitted');
    chFill(reg, 'sendCurrentThoughtSignatures', d.sendCurrentThoughtSignatures === true, false);
    chFill(reg, 'sendCurrentThoughts', d.sendCurrentThoughts === true, false);
    chFill(reg, 'sendHistoryThoughtSignatures', d.sendHistoryThoughtSignatures === true, false);
    chFill(reg, 'sendHistoryThoughts', d.sendHistoryThoughts === true, false);
    chFill(reg, 'historyThinkingRounds', d.historyThinkingRounds, undefined);
    chFill(reg, 'promptCachingEnabled', d.promptCachingEnabled === true, false);
    chFill(reg, 'promptCachingTtl', d.promptCachingTtl || '5m', '5m');
    chFill(reg, 'promptCachingKeepAlive', d.promptCachingKeepAlive === true, false);
    chFill(reg, 'anthropicUserIdEnabled', d.anthropicUserIdEnabled === true, false);
    chFill(reg, 'deepSeekUserIdEnabled', d.deepSeekUserIdEnabled === true, false);
    chFill(reg, 'pdfAttachmentEnabled', d.pdfAttachmentEnabled === true, false);
    chFill(reg, 'customBodyMode', (d.customBody && d.customBody.mode) || 'simple', 'simple');
    if (reg.customBodyItems) {
      reg.customBodyItems.value = JSON.stringify((d.customBody && d.customBody.items) || []);
    }
    if (reg.customBodyJson) {
      reg.customBodyJson.value = (d.customBody && d.customBody.json) || '';
    }
    if (reg.customHeaders) {
      reg.customHeaders.value = JSON.stringify(Array.isArray(d.customHeaders) ? d.customHeaders : []);
    }
    chFill(reg, 'retryCount', d.retryCount, 3);
    chFill(reg, 'retryInterval', d.retryInterval, 3000);
  });
}
/* reasoning 子分组字段（openai / openai-responses 共用） */
function reasoningFields(container, reg, d, save) {
  var oe = Object.assign({}, (d.optionsEnabled || {}));
  var op = Object.assign({}, (d.options || {}));
  chInline(container, reg, 'reasoning.effort', t('fldChEffort'), 'select', {
    options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom']
  }, function (v) {
    var rc = Object.assign({}, op.reasoning || {});
    rc.effort = v;
    save({ optionsEnabled: Object.assign({}, oe, { reasoning: true }), options: Object.assign({}, op, { reasoning: rc }) });
  });
  chInline(container, reg, 'reasoning.effortCustom', t('fldChEffortCustom'), 'text', null, function (v) {
    var rc = Object.assign({}, op.reasoning || {});
    rc.effortCustom = v;
    save({ optionsEnabled: Object.assign({}, oe, { reasoning: true }), options: Object.assign({}, op, { reasoning: rc }) });
  });
  chInline(container, reg, 'reasoning.summaryEnabled', t('fldChSummary'), 'toggle', { def: false }, function (v) {
    var rc = Object.assign({}, op.reasoning || {});
    rc.summaryEnabled = v;
    save({ optionsEnabled: Object.assign({}, oe, { reasoning: true }), options: Object.assign({}, op, { reasoning: rc }) });
  });
  chInline(container, reg, 'reasoning.summary', t('fldChSummary'), 'select', { options: ['auto', 'concise', 'detailed'] }, function (v) {
    var rc = Object.assign({}, op.reasoning || {});
    rc.summary = v;
    save({ optionsEnabled: Object.assign({}, oe, { reasoning: true }), options: Object.assign({}, op, { reasoning: rc }) });
  });
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
  var type = cfg.type || 'openai';
  var regBasic = {};
  var regContext = {};
  var regTools = {};
  var regAdv = {};
  /* 顶部 4 个子页签（基本 / 上下文 / 工具 / 高级） */
  var tabs = el('div', { class: 'ch-tabs' });
  var tabDefs = [
    { key: 'basic', label: t('chBasic') },
    { key: 'context', label: t('chContext') },
    { key: 'toolsCfg', label: t('chToolsCfg') },
    { key: 'advanced', label: t('chAdvanced') }
  ];
  var panes = {};
  function activateChTab(name) {
    Object.keys(panes).forEach(function (k) {
      panes[k].classList.toggle('active', k === name);
    });
    tabs.querySelectorAll('.ch-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-ch-tab') === name);
    });
  }
  tabDefs.forEach(function (td) {
    var b = el('button', { type: 'button', class: 'ch-tab' + (td.key === 'basic' ? ' active' : ''), 'data-ch-tab': td.key, text: td.label });
    b.addEventListener('click', function () { activateChTab(td.key); });
    tabs.appendChild(b);
  });
  bodyEl.appendChild(tabs);
  var paneBasic = el('div', { class: 'ch-pane active' });
  var paneContext = el('div', { class: 'ch-pane' });
  var paneTools = el('div', { class: 'ch-pane' });
  var paneAdv = el('div', { class: 'ch-pane' });
  panes = { basic: paneBasic, context: paneContext, toolsCfg: paneTools, advanced: paneAdv };
  bodyEl.appendChild(paneBasic);
  bodyEl.appendChild(paneContext);
  bodyEl.appendChild(paneTools);
  bodyEl.appendChild(paneAdv);
  /* 基本设置 */
  chField(paneBasic, regBasic, 'name', t('channelName'), 'text');
  chField(paneBasic, regBasic, 'url', t('channelUrl'), 'text');
  chField(paneBasic, regBasic, 'apiKey', t('channelApiKey'), 'password');
  chField(paneBasic, regBasic, 'useAuthorizationHeader', t('fldChUseAuth'), 'toggle', { def: false });
  chField(paneBasic, regBasic, 'toolMode', t('channelToolMode'), 'select', ['function_call', 'xml', 'json']);
  chField(paneBasic, regBasic, 'timeout', t('channelTimeout'), 'number', { min: 0 });
  chField(paneBasic, regBasic, 'maxContextTokens', t('channelMaxContext'), 'number', { min: 0 });
  chField(paneBasic, regBasic, 'streamOutput', t('fldChStream'), 'toggle', { def: true });
  chField(paneBasic, regBasic, 'multimodalToolsEnabled', t('fldChMultimodal'), 'toggle', { def: true });
  chField(paneBasic, regBasic, 'strictToolsEnabled', t('fldChStrictTools'), 'toggle', { def: false });
  chField(paneBasic, regBasic, 'enabled', t('enable'), 'toggle', { def: true });
  /* 上下文管理 */
  chField(paneContext, regContext, 'contextManagementEnabled', t('fldChContextMode'), 'toggle', { def: false });
  chField(paneContext, regContext, 'contextManagementMode', t('fldChContextMode'), 'select', ['summarize']);
  chField(paneContext, regContext, 'contextThreshold', t('fldChContextThreshold'), 'text');
  chField(paneContext, regContext, 'autoSummarizeEnabled', t('fldChAutoSummarize'), 'toggle', { def: false });
  /* 工具配置 */
  chField(paneTools, regTools, 'tokenCountMethod', t('fldChTokenCountMethod'), 'select', ['channel_default', 'gemini', 'openai_custom', 'openai_responses', 'anthropic', 'local']);
  var tcBox = el('div', { style: 'display:none;' });
  chField(tcBox, regTools, 'tokenCountApiConfig.url', t('fldTokUrl'), 'text');
  chField(tcBox, regTools, 'tokenCountApiConfig.apiKey', t('fldTokKey'), 'password');
  chField(tcBox, regTools, 'tokenCountApiConfig.model', t('fldTokModel'), 'text');
  paneTools.appendChild(tcBox);
  var tokenCountSel = regTools['tokenCountMethod'];
  function updateTcVisible() {
    var m = tokenCountSel ? tokenCountSel.value : 'channel_default';
    tcBox.style.display = (m === 'channel_default' || m === 'local') ? 'none' : 'block';
  }
  if (tokenCountSel) tokenCountSel.addEventListener('change', updateTcVisible);
  updateTcVisible();
  chField(paneTools, regTools, 'cropImageNorm', t('fldChToolCropNorm'), 'toggle', { def: true });
  /* 高级选项 */
  chField(paneAdv, regAdv, 'retryEnabled', t('fldChRetry'), 'toggle', { def: false });
  chField(paneAdv, regAdv, 'retryCount', t('fldChRetryCount'), 'number', { min: 1, max: 10 });
  chField(paneAdv, regAdv, 'retryInterval', t('fldChRetryInterval'), 'number', { min: 1000, max: 60000 });
  chField(paneAdv, regAdv, 'customBodyEnabled', t('fldChCustomBodyEnabled'), 'toggle', { def: false });
  chField(paneAdv, regAdv, 'customBody', t('fldChCustomBody'), 'textarea');
  chField(paneAdv, regAdv, 'customHeadersEnabled', t('fldChCustomHeadersEnabled'), 'toggle', { def: false });
  chField(paneAdv, regAdv, 'customHeaders', t('fldChCustomHeaders'), 'textarea');
  if (type === 'gemini') {
    chOptField(paneAdv, regAdv, 'temperature', t('fldChTemperature'));
    chOptField(paneAdv, regAdv, 'maxOutputTokens', t('fldChMaxOutputTokens'));
    chField(paneAdv, regAdv, 'thinkingConfig', t('fldChReasoning'), 'toggle', { def: true });
    chField(paneAdv, regAdv, 'tc.includeThoughts', t('fldChThinkingDisplay'), 'toggle', { def: true });
    chField(paneAdv, regAdv, 'tc.mode', t('fldChThinkingType'), 'select', ['default', 'level', 'budget']);
    chField(paneAdv, regAdv, 'tc.thinkingLevel', t('fldChEffort'), 'select', ['off', 'minimal', 'low', 'medium', 'high']);
    chField(paneAdv, regAdv, 'tc.thinkingBudget', t('fldChThinkingBudget'), 'number', { min: 1 });
  } else if (type === 'anthropic') {
    chOptField(paneAdv, regAdv, 'temperature', t('fldChTemperature'));
    chOptField(paneAdv, regAdv, 'max_tokens', t('fldChMaxOutputTokens'));
    chOptField(paneAdv, regAdv, 'top_p', t('fldChTopP'));
    chOptField(paneAdv, regAdv, 'top_k', t('fldChTopK'));
    chField(paneAdv, regAdv, 'thinking', t('fldChReasoning'), 'toggle', { def: false });
    chField(paneAdv, regAdv, 'thinking.type', t('fldChThinkingType'), 'select', ['adaptive', 'enabled', 'disabled']);
    chField(paneAdv, regAdv, 'thinking.effort', t('fldChEffort'), 'select', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom']);
    chField(paneAdv, regAdv, 'thinking.budget_tokens', t('fldChThinkingBudget'), 'number', { min: 1024 });
    chField(paneAdv, regAdv, 'thinking.display', t('fldChThinkingDisplay'), 'select', ['none', 'summary', 'all']);
  } else {
    chOptField(paneAdv, regAdv, 'temperature', t('fldChTemperature'));
    chOptField(paneAdv, regAdv, 'max_tokens', t('fldChMaxOutputTokens'));
    chOptField(paneAdv, regAdv, 'top_p', t('fldChTopP'));
    chOptField(paneAdv, regAdv, 'frequencyPenalty', t('fldChFreqPenalty'));
    chOptField(paneAdv, regAdv, 'presencePenalty', t('fldChPresencePenalty'));
    chField(paneAdv, regAdv, 'reasoning', t('fldChReasoning'), 'toggle', { def: false });
    chField(paneAdv, regAdv, 'reasoning.effort', t('fldChEffort'), 'select', ['low', 'medium', 'high', 'xhigh', 'ultra', 'max', 'custom']);
    chField(paneAdv, regAdv, 'reasoning.effortCustom', t('fldChEffortCustom'), 'text');
    chField(paneAdv, regAdv, 'reasoning.summaryEnabled', t('fldChSummary'), 'toggle', { def: false });
    chField(paneAdv, regAdv, 'reasoning.summary', t('fldChSummary'), 'select', ['auto', 'concise', 'detailed']);
  }
  /* 回传思考（全部类型） */
  chField(paneAdv, regAdv, 'sendCurrentThoughtSignatures', t('fldChSendThoughts'), 'toggle', { def: false });
  chField(paneAdv, regAdv, 'sendCurrentThoughts', t('fldChSendThoughts'), 'toggle', { def: false });
  chField(paneAdv, regAdv, 'sendHistoryThoughtSignatures', t('fldChSendThoughts'), 'toggle', { def: false });
  chField(paneAdv, regAdv, 'sendHistoryThoughts', t('fldChSendThoughts'), 'toggle', { def: true });
  chField(paneAdv, regAdv, 'historyThinkingRounds', t('fldChHistoryRounds'), 'number', { min: -1 });
  if (type === 'anthropic' || type === 'gemini') {
    chField(paneAdv, regAdv, 'promptCachingEnabled', t('fldChPromptCaching'), 'toggle', { def: false });
    chField(paneAdv, regAdv, 'promptCachingTtl', t('fldChTtl'), 'select', ['5m', '1h']);
    chField(paneAdv, regAdv, 'promptCachingKeepAlive', t('fldChKeepAlive'), 'toggle', { def: false });
  }
  if (type === 'anthropic') {
    chField(paneAdv, regAdv, 'anthropicUserIdEnabled', t('fldChAnthropicUserId'), 'toggle', { def: false });
  }
  if (type === 'openai' || type === 'openai-responses') {
    chField(paneAdv, regAdv, 'deepSeekUserIdEnabled', t('fldChDeepSeekUserId'), 'toggle', { def: false });
    chField(paneAdv, regAdv, 'pdfAttachmentEnabled', t('fldChPdfAttachment'), 'toggle', { def: false });
  }
  $('modal-cancel').textContent = t('renameCancel');
  $('modal-ok').textContent = t('saveChannel');
  $('modal-ok').className = 'btn';
  modalEl._onOk = function () {
    var updates = {};
    var name = chVal(regBasic, 'name', '').trim();
    if (name) updates.name = name;
    var url = chVal(regBasic, 'url', '').trim();
    if (url) updates.url = url;
    var apiKey = chVal(regBasic, 'apiKey', '').trim();
    if (apiKey) updates.apiKey = apiKey;
    updates.useAuthorizationHeader = chVal(regBasic, 'useAuthorizationHeader', false);
    var toolMode = chVal(regBasic, 'toolMode', '');
    if (toolMode) updates.toolMode = toolMode;
    var timeout = chVal(regBasic, 'timeout', undefined);
    if (timeout !== undefined) updates.timeout = timeout;
    var mct = chVal(regBasic, 'maxContextTokens', undefined);
    if (mct !== undefined) updates.maxContextTokens = mct;
    updates.streamOutput = chVal(regBasic, 'streamOutput', true);
    updates.multimodalToolsEnabled = chVal(regBasic, 'multimodalToolsEnabled', true);
    updates.strictToolsEnabled = chVal(regBasic, 'strictToolsEnabled', false);
    updates.enabled = chVal(regBasic, 'enabled', true);
    /* 上下文 */
    updates.contextManagementEnabled = chVal(regContext, 'contextManagementEnabled', false);
    var cm = chVal(regContext, 'contextManagementMode', 'summarize');
    if (cm) updates.contextManagementMode = cm;
    var ct = chVal(regContext, 'contextThreshold', '80%');
    if (ct) updates.contextThreshold = ct;
    updates.autoSummarizeEnabled = chVal(regContext, 'autoSummarizeEnabled', false);
    /* 工具配置 */
    var tcm = chVal(regTools, 'tokenCountMethod', 'channel_default');
    if (tcm) updates.tokenCountMethod = tcm;
    var tcUrl = chVal(regTools, 'tokenCountApiConfig.url', '').trim();
    var tcKey = chVal(regTools, 'tokenCountApiConfig.apiKey', '').trim();
    var tcModel = chVal(regTools, 'tokenCountApiConfig.model', '').trim();
    if (tcUrl || tcKey || tcModel) {
      updates.tokenCountApiConfig = {
        url: tcUrl || undefined,
        apiKey: tcKey || undefined,
        model: tcModel || undefined
      };
    }
    updates.toolOptions = { cropImage: { useNormalizedCoordinates: chVal(regTools, 'cropImageNorm', true) } };
    /* 高级基础字段 */
    updates.retryEnabled = chVal(regAdv, 'retryEnabled', false);
    var rc = chVal(regAdv, 'retryCount', undefined);
    if (rc !== undefined) updates.retryCount = rc;
    var ri = chVal(regAdv, 'retryInterval', undefined);
    if (ri !== undefined) updates.retryInterval = ri;
    updates.customBodyEnabled = chVal(regAdv, 'customBodyEnabled', false);
    var cb = chVal(regAdv, 'customBody', '').trim();
    if (cb) updates.customBody = cb;
    updates.customHeadersEnabled = chVal(regAdv, 'customHeadersEnabled', false);
    var chh = chVal(regAdv, 'customHeaders', '').trim();
    if (chh) updates.customHeaders = chh;
    loadChannelDetail(cfg.id, function (detail) {
      var base = Object.assign({}, cfg, detail || {});
      var oe = Object.assign({}, base.optionsEnabled || {});
      var op = Object.assign({}, base.options || {});
      if (type === 'gemini') {
        applyOptPair(oe, op, 'temperature', chOptRead(regAdv, 'temperature'));
        applyOptPair(oe, op, 'maxOutputTokens', chOptRead(regAdv, 'maxOutputTokens'));
        if (chVal(regAdv, 'thinkingConfig', true)) {
          oe.thinkingConfig = true;
          var tc = Object.assign({}, op.thinkingConfig || {});
          tc.includeThoughts = chVal(regAdv, 'tc.includeThoughts', true);
          tc.mode = chVal(regAdv, 'tc.mode', 'default');
          var lvl = chVal(regAdv, 'tc.thinkingLevel', '');
          if (lvl) tc.thinkingLevel = lvl;
          var tb = chVal(regAdv, 'tc.thinkingBudget', undefined);
          if (tb !== undefined) tc.thinkingBudget = tb;
          op.thinkingConfig = tc;
        } else {
          oe.thinkingConfig = false;
        }
      } else if (type === 'anthropic') {
        applyOptPair(oe, op, 'temperature', chOptRead(regAdv, 'temperature'));
        applyOptPair(oe, op, 'max_tokens', chOptRead(regAdv, 'max_tokens'));
        applyOptPair(oe, op, 'top_p', chOptRead(regAdv, 'top_p'));
        applyOptPair(oe, op, 'top_k', chOptRead(regAdv, 'top_k'));
        if (chVal(regAdv, 'thinking', false)) {
          oe.thinking = true;
          var th = Object.assign({}, op.thinking || {});
          th.type = chVal(regAdv, 'thinking.type', 'adaptive');
          var eff = chVal(regAdv, 'thinking.effort', '');
          if (eff) th.effort = eff;
          var bt = chVal(regAdv, 'thinking.budget_tokens', undefined);
          if (bt !== undefined) th.budget_tokens = bt;
          var disp = chVal(regAdv, 'thinking.display', '');
          if (disp) th.display = disp;
          op.thinking = th;
        } else {
          oe.thinking = false;
        }
      } else {
        applyOptPair(oe, op, 'temperature', chOptRead(regAdv, 'temperature'));
        applyOptPair(oe, op, 'max_tokens', chOptRead(regAdv, 'max_tokens'));
        applyOptPair(oe, op, 'top_p', chOptRead(regAdv, 'top_p'));
        applyOptPair(oe, op, 'frequencyPenalty', chOptRead(regAdv, 'frequencyPenalty'));
        applyOptPair(oe, op, 'presencePenalty', chOptRead(regAdv, 'presencePenalty'));
        if (chVal(regAdv, 'reasoning', false)) {
          oe.reasoning = true;
          var r = Object.assign({}, op.reasoning || {});
          var eff2 = chVal(regAdv, 'reasoning.effort', 'high');
          if (eff2) r.effort = eff2;
          var ec = chVal(regAdv, 'reasoning.effortCustom', '').trim();
          if (ec) r.effortCustom = ec;
          if (chVal(regAdv, 'reasoning.summaryEnabled', false)) {
            r.summaryEnabled = true;
            var sum = chVal(regAdv, 'reasoning.summary', 'auto');
            if (sum) r.summary = sum;
          } else {
            r.summaryEnabled = false;
          }
          op.reasoning = r;
        } else {
          oe.reasoning = false;
        }
      }
      updates.sendCurrentThoughtSignatures = chVal(regAdv, 'sendCurrentThoughtSignatures', false);
      updates.sendCurrentThoughts = chVal(regAdv, 'sendCurrentThoughts', false);
      updates.sendHistoryThoughtSignatures = chVal(regAdv, 'sendHistoryThoughtSignatures', false);
      updates.sendHistoryThoughts = chVal(regAdv, 'sendHistoryThoughts', true);
      var htr = chVal(regAdv, 'historyThinkingRounds', undefined);
      if (htr !== undefined) updates.historyThinkingRounds = htr;
      if (type === 'anthropic' || type === 'gemini') {
        updates.promptCachingEnabled = chVal(regAdv, 'promptCachingEnabled', false);
        var ttl = chVal(regAdv, 'promptCachingTtl', '5m');
        if (ttl) updates.promptCachingTtl = ttl;
        updates.promptCachingKeepAlive = chVal(regAdv, 'promptCachingKeepAlive', false);
      }
      if (type === 'anthropic') {
        updates.anthropicUserIdEnabled = chVal(regAdv, 'anthropicUserIdEnabled', false);
      }
      if (type === 'openai' || type === 'openai-responses') {
        updates.deepSeekUserIdEnabled = chVal(regAdv, 'deepSeekUserIdEnabled', false);
        updates.pdfAttachmentEnabled = chVal(regAdv, 'pdfAttachmentEnabled', false);
      }
      updates.options = op;
      updates.optionsEnabled = oe;
      post('/api/config-update', { configId: cfg.id, updates: updates }).then(function () {
        toast(t('channelSaved'));
        closeModal();
        loadConfigs();
      }).catch(function (err) {
        toast(t('settingsFailed') + ': ' + (err.message || ''));
      });
    });
  };
  /* 回填（含 options/optionsEnabled/上下文/toolOptions/tokenCountMethod） */
  loadChannelDetail(cfg.id, function (detail) {
    if (!detail) return;
    chFill(regBasic, 'name', detail.name || cfg.name, '');
    chFill(regBasic, 'url', detail.url, '');
    chFill(regBasic, 'apiKey', detail.apiKey, '');
    chFill(regBasic, 'useAuthorizationHeader', detail.useAuthorizationHeader === true, false);
    chFill(regBasic, 'toolMode', detail.toolMode, 'function_call');
    chFill(regBasic, 'timeout', detail.timeout, '');
    chFill(regBasic, 'maxContextTokens', detail.maxContextTokens, '');
    chFill(regBasic, 'streamOutput', detail.streamOutput !== false, true);
    chFill(regBasic, 'multimodalToolsEnabled', detail.multimodalToolsEnabled !== false, true);
    chFill(regBasic, 'strictToolsEnabled', detail.strictToolsEnabled === true, false);
    chFill(regBasic, 'enabled', detail.enabled !== false, true);
    chFill(regContext, 'contextManagementEnabled', detail.contextManagementEnabled === true, false);
    chFill(regContext, 'contextManagementMode', detail.contextManagementMode, 'summarize');
    chFill(regContext, 'contextThreshold', detail.contextThreshold, '80%');
    chFill(regContext, 'autoSummarizeEnabled', detail.autoSummarizeEnabled === true, false);
    chFill(regTools, 'tokenCountMethod', detail.tokenCountMethod, 'channel_default');
    chFill(regTools, 'tokenCountApiConfig.url', detail.tokenCountApiConfig && detail.tokenCountApiConfig.url, '');
    chFill(regTools, 'tokenCountApiConfig.apiKey', detail.tokenCountApiConfig && detail.tokenCountApiConfig.apiKey, '');
    chFill(regTools, 'tokenCountApiConfig.model', detail.tokenCountApiConfig && detail.tokenCountApiConfig.model, '');
    chFill(regTools, 'cropImageNorm', !!(detail.toolOptions && detail.toolOptions.cropImage && detail.toolOptions.cropImage.useNormalizedCoordinates !== false), true);
    updateTcVisible();
    var oe = detail.optionsEnabled || {};
    var op = detail.options || {};
    chOptFill(regAdv, 'temperature', oe, op);
    chOptFill(regAdv, 'maxOutputTokens', oe, op);
    chOptFill(regAdv, 'max_tokens', oe, op);
    chOptFill(regAdv, 'top_p', oe, op);
    chOptFill(regAdv, 'top_k', oe, op);
    chOptFill(regAdv, 'frequencyPenalty', oe, op);
    chOptFill(regAdv, 'presencePenalty', oe, op);
    chFill(regAdv, 'retryEnabled', !!(detail.retryEnabled || (detail.autoRetry && detail.autoRetry.enabled)), false);
    chFill(regAdv, 'retryCount', detail.retryCount, '');
    chFill(regAdv, 'retryInterval', detail.retryInterval, '');
    chFill(regAdv, 'customBodyEnabled', !!detail.customBodyEnabled, false);
    chFill(regAdv, 'customBody', typeof detail.customBody === 'string' ? detail.customBody : '', '');
    chFill(regAdv, 'customHeadersEnabled', !!detail.customHeadersEnabled, false);
    chFill(regAdv, 'customHeaders', typeof detail.customHeaders === 'string' ? detail.customHeaders : '', '');
    if (type === 'gemini') {
      chFill(regAdv, 'thinkingConfig', oe.thinkingConfig !== false, true);
      var tc = op.thinkingConfig || {};
      chFill(regAdv, 'tc.includeThoughts', tc.includeThoughts !== false, true);
      chFill(regAdv, 'tc.mode', tc.mode, 'default');
      chFill(regAdv, 'tc.thinkingLevel', tc.thinkingLevel, '');
      chFill(regAdv, 'tc.thinkingBudget', tc.thinkingBudget, '');
    } else if (type === 'anthropic') {
      chFill(regAdv, 'thinking', oe.thinking === true, false);
      var th = op.thinking || {};
      chFill(regAdv, 'thinking.type', th.type, 'adaptive');
      chFill(regAdv, 'thinking.effort', th.effort, '');
      chFill(regAdv, 'thinking.budget_tokens', th.budget_tokens, '');
      chFill(regAdv, 'thinking.display', th.display, '');
    } else {
      chFill(regAdv, 'reasoning', oe.reasoning === true, false);
      var r = op.reasoning || {};
      chFill(regAdv, 'reasoning.effort', r.effort, 'high');
      chFill(regAdv, 'reasoning.effortCustom', r.effortCustom, '');
      chFill(regAdv, 'reasoning.summaryEnabled', r.summaryEnabled === true, false);
      chFill(regAdv, 'reasoning.summary', r.summary, 'auto');
    }
    chFill(regAdv, 'sendCurrentThoughtSignatures', detail.sendCurrentThoughtSignatures === true, false);
    chFill(regAdv, 'sendCurrentThoughts', detail.sendCurrentThoughts === true, false);
    chFill(regAdv, 'sendHistoryThoughtSignatures', detail.sendHistoryThoughtSignatures === true, false);
    chFill(regAdv, 'sendHistoryThoughts', detail.sendHistoryThoughts !== false, true);
    chFill(regAdv, 'historyThinkingRounds', detail.historyThinkingRounds, '');
    if (type === 'anthropic' || type === 'gemini') {
      chFill(regAdv, 'promptCachingEnabled', detail.promptCachingEnabled === true, false);
      chFill(regAdv, 'promptCachingTtl', detail.promptCachingTtl, '5m');
      chFill(regAdv, 'promptCachingKeepAlive', detail.promptCachingKeepAlive === true, false);
    }
    if (type === 'anthropic') {
      chFill(regAdv, 'anthropicUserIdEnabled', detail.anthropicUserIdEnabled === true, false);
    }
    if (type === 'openai' || type === 'openai-responses') {
      chFill(regAdv, 'deepSeekUserIdEnabled', detail.deepSeekUserIdEnabled === true, false);
      chFill(regAdv, 'pdfAttachmentEnabled', detail.pdfAttachmentEnabled === true, false);
    }
  });
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
    toast(t('setActiveChannel'));
    loadConfigs();
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
function toggleChannelEnabled(cfg) {
  post('/api/channel-toggle', { configId: cfg.id, enabled: cfg.enabled !== false }).then(function () {
    toast((cfg.enabled !== false ? t('enable') : t('disable')));
    loadConfigs();
  }).catch(function (err) {
    cfg.enabled = !cfg.enabled;
    toast(t('settingsFailed') + ': ' + (err.message || ''));
    if (isPanelOpen('settings')) renderAllSettingsSections();
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
          /* 强制重拉模型列表（modelsLoaded 缓存会短路旧逻辑导致列表不刷新） */
          reloadConfigModels(cfg.id, function () {
            loadConfigs().then(function () {
              var fresh = findConfig(cfg.id);
              if (fresh) {
                curId = fresh.model || '';
                cfg.model = fresh.model;
              }
              renderModels();
            }).catch(function () { renderModels(); });
          });
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
      row.appendChild(rmBtn);
      listEl.appendChild(row);
    });
  }
  renderModels();
  /* 打开对话框时强制刷新模型列表，避免首次打开显示空列表/旧缓存 */
  reloadConfigModels(cfg.id, function () { renderModels(); });
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
      reloadConfigModels(cfg.id, function () { renderModels(); });
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
/* ---------- 通用分类（更新 / 导入导出 / 应用信息 / 声音 / 外观） ---------- */
function renderGeneralSection() {
  renderSimpleSection('secGeneral', [
    { t: 'fldCheckUpdates', p: ['checkForUpdates'], w: 'toggle' },
    { t: 'fldMaxToolIterations', p: ['maxToolIterations'], w: 'number', min: -1 },
    { t: 'fldDefaultToolMode', p: ['defaultToolMode'], w: 'select', o: ['function_call', 'xml', 'json'] },
    { t: 'fldLanguage', p: ['ui', 'language'], w: 'select', o: ['auto', 'zh-CN', 'en', 'ja'] },
    { t: 'fldWorkspaceBehavior', p: ['ui', 'workspaceBehavior'], w: 'select', o: ['restore', 'none'] },
    { t: 'fldTheme', p: ['ui', 'theme'], w: 'select', o: ['auto', 'dark', 'light'] },
    { t: 'fldLoadingText', p: ['ui', 'appearance', 'loadingText'], w: 'text' },
    { t: 'fldSplashEnabled', p: ['ui', 'appearance', 'splashEnabled'], w: 'toggle' }
  ]);
  renderSimpleSection('secAppearance', [
    { t: 'fldSmoothStreaming', p: ['ui', 'appearance', 'smoothStreaming'], w: 'select', o: ['off', 'smooth', 'balanced', 'silky'] },
    { t: 'fldSelectionContext', p: ['ui', 'appearance', 'selectionContextEnabled'], w: 'toggle' },
    { t: 'fldTpsBar', p: ['ui', 'appearance', 'tpsBarEnabled'], w: 'toggle' },
    { t: 'fldSoundEnabled', p: ['ui', 'sound', 'enabled'], w: 'toggle' },
    { t: 'fldSoundVolume', p: ['ui', 'sound', 'volume'], w: 'number', min: 0, max: 100 },
    { t: 'fldSoundTheme', p: ['ui', 'sound', 'theme'], w: 'select', o: ['beep', 'soft'] },
    { t: 'fldSoundCooldown', p: ['ui', 'sound', 'cooldownMs'], w: 'number', min: 0, max: 5000 }
  ]);
  var cueCard = secCard('fldSoundCues');
  renderField(cueCard, { t: 'fldSoundCueWarning', p: ['ui', 'sound', 'cues', 'warning'], w: 'toggle' });
  renderField(cueCard, { t: 'fldSoundCueError', p: ['ui', 'sound', 'cues', 'error'], w: 'toggle' });
  renderField(cueCard, { t: 'fldSoundCueComplete', p: ['ui', 'sound', 'cues', 'taskComplete'], w: 'toggle' });
  renderField(cueCard, { t: 'fldSoundCueFail', p: ['ui', 'sound', 'cues', 'taskError'], w: 'toggle' });
  var subCueCard = secCard('fldSoundSubCues');
  renderField(subCueCard, { t: 'fldSoundCueWarning', p: ['ui', 'sound', 'cues', 'subagent', 'warning'], w: 'toggle' });
  renderField(subCueCard, { t: 'fldSoundCueError', p: ['ui', 'sound', 'cues', 'subagent', 'error'], w: 'toggle' });
  renderField(subCueCard, { t: 'fldSoundCueComplete', p: ['ui', 'sound', 'cues', 'subagent', 'taskComplete'], w: 'toggle' });
  renderField(subCueCard, { t: 'fldSoundCueFail', p: ['ui', 'sound', 'cues', 'subagent', 'taskError'], w: 'toggle' });
  var winCard = secCard('fldSoundWindowsNotify');
  renderField(winCard, { t: 'fldSoundWindowsNotify', p: ['ui', 'sound', 'windowsAgentStopNotification', 'enabled'], w: 'toggle' });
  renderField(winCard, { t: 'fldSoundOnlyUnfocused', p: ['ui', 'sound', 'windowsAgentStopNotification', 'onlyWhenWindowNotFocused'], w: 'toggle' });
  renderField(winCard, { t: 'fldSoundCueError', p: ['ui', 'sound', 'windowsAgentStopNotification', 'cases', 'error'], w: 'toggle' });
  renderField(winCard, { t: 'fldSoundCueWarning', p: ['ui', 'sound', 'windowsAgentStopNotification', 'cases', 'awaitingUserAction'], w: 'toggle' });
  renderField(winCard, { t: 'fldSoundCueComplete', p: ['ui', 'sound', 'windowsAgentStopNotification', 'cases', 'continueRequired'], w: 'toggle' });
  renderField(winCard, { t: 'opStorageOpen', p: ['ui', 'sound', 'windowsAgentStopNotification', 'content', 'titleTemplate'], w: 'text' });
  renderField(winCard, { t: 'fldSoundCueError', p: ['ui', 'sound', 'windowsAgentStopNotification', 'content', 'bodyTemplates', 'error'], w: 'textarea' });
  renderField(winCard, { t: 'fldSoundCueWarning', p: ['ui', 'sound', 'windowsAgentStopNotification', 'content', 'bodyTemplates', 'awaitingUserAction'], w: 'textarea' });
  renderField(winCard, { t: 'fldSoundCueComplete', p: ['ui', 'sound', 'windowsAgentStopNotification', 'content', 'bodyTemplates', 'continueRequired'], w: 'textarea' });
  /* 更新 / 导入导出 / 应用信息 */
  var infoCard = secCard('appInfo');
  var actRow = el('div', { class: 'sheet-actions' });
  var checkBtn = el('button', { class: 'btn', text: t('opCheckUpdate') });
  checkBtn.addEventListener('click', function () {
    post('/api/update-check', {}).then(function (data) {
      var msg = (data && (data.message || data.version || data.upToDate)) ? String(data.message || data.version || data.upToDate) : '';
      toast(msg || t('done'));
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  var updateBtn = el('button', { class: 'btn', text: t('opUpdateNow') });
  updateBtn.addEventListener('click', function () {
    post('/api/update-now', {}).then(function () {
      toast(t('done'));
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  actRow.appendChild(checkBtn);
  actRow.appendChild(updateBtn);
  infoCard.appendChild(actRow);
  var verRow = el('div', { class: 'set-row' });
  verRow.appendChild(el('span', { text: t('appVersion') }));
  verRow.appendChild(el('span', { class: 'dim', text: S.appVersion || '—' }));
  infoCard.appendChild(verRow);
  var repoRow = el('div', { class: 'set-row' });
  repoRow.appendChild(el('span', { text: 'GitHub' }));
  var repoBtn = el('button', { class: 'mini-btn', text: 'czocelot/Gray-Code-Desktop' });
  repoBtn.addEventListener('click', function () { copyText('https://github.com/czocelot/Gray-Code-Desktop'); });
  repoRow.appendChild(repoBtn);
  infoCard.appendChild(repoRow);
  var ioRow = el('div', { class: 'sheet-actions' });
  var exportBtn = el('button', { class: 'btn', text: t('opExport') });
  exportBtn.addEventListener('click', function () {
    post('/api/settings-export', {}).then(function () {
      toast(t('openFolderDialog'));
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  var importBtn = el('button', { class: 'btn', text: t('opImport') });
  importBtn.addEventListener('click', function () {
    post('/api/settings-import', {}).then(function () {
      toast(t('settingsSaved'));
      loadSettings();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  ioRow.appendChild(exportBtn);
  ioRow.appendChild(importBtn);
  infoCard.appendChild(ioRow);
}
/* ---------- 文件工具（toolsConfig.*，与桌面端 FileToolsSettings 对齐） ---------- */
function renderFileToolsSection() {
  var card = secCard('secFileTools');
  var tools = [
    { key: 'read_file', labelKey: 'fldReadOutside' },
    { key: 'write_file', labelKey: 'fldWriteOutside' },
    { key: 'apply_diff', labelKey: 'fldApplyFormat' },
    { key: 'list_files', labelKey: 'fldListIgnore' },
    { key: 'find_files', labelKey: 'fldFindExclude' },
    { key: 'search_in_files', labelKey: 'fldSearchExclude' },
    { key: 'execute_command', labelKey: 'fldCmdTimeout' },
    { key: 'history_search', labelKey: 'fldHistoryScope' }
  ];
  tools.forEach(function (tool) {
    var block = el('div', { class: 'cfg-item' });
    var head = el('button', { class: 'tool-card-head', type: 'button' });
    var open = S_TOOLS_OPEN['ft:' + tool.key] === true;
    var chev = el('span', { class: 'tc-chev' + (open ? ' open' : '') });
    chev.innerHTML = icon(open ? 'chevronDown' : 'chevronRight');
    head.appendChild(chev);
    head.appendChild(el('span', { class: 'tc-name', text: tool.key }));
    block.appendChild(head);
    head.addEventListener('click', function () {
      S_TOOLS_OPEN['ft:' + tool.key] = !S_TOOLS_OPEN['ft:' + tool.key];
      renderAllSettingsSections();
    });
    if (open) {
      var body = el('div', { class: 'tool-card-body' });
      renderToolConfigPanel(body, tool.key);
      block.appendChild(body);
    }
    card.appendChild(block);
  });
  /* 媒体工具（5 个：仅 returnImageToAI 开关） */
  var mediaBlock = el('div', { class: 'cfg-item' });
  var mediaHead = el('button', { class: 'tool-card-head', type: 'button' });
  var mediaOpen = S_TOOLS_OPEN['ft:media'] === true;
  var mediaChev = el('span', { class: 'tc-chev' + (mediaOpen ? ' open' : '') });
  mediaChev.innerHTML = icon(mediaOpen ? 'chevronDown' : 'chevronRight');
  mediaHead.appendChild(mediaChev);
  mediaHead.appendChild(el('span', { class: 'tc-name', text: 'media' }));
  mediaBlock.appendChild(mediaHead);
  mediaHead.addEventListener('click', function () {
    S_TOOLS_OPEN['ft:media'] = !S_TOOLS_OPEN['ft:media'];
    renderAllSettingsSections();
  });
  if (mediaOpen) {
    var mediaBody = el('div', { class: 'tool-card-body' });
    ['generate_image', 'remove_background', 'crop_image', 'resize_image', 'rotate_image'].forEach(function (toolName) {
      renderField(mediaBody, { t: 'fldImgReturn', p: ['toolsConfig', toolName, 'returnImageToAI'], w: 'toggle' });
    });
    mediaBlock.appendChild(mediaBody);
  }
  card.appendChild(mediaBlock);
}
/* ---------- 提示词模式管理（modes.<id> 每模式字段 + 新建/重命名/复制/删除） ---------- */
function renderPromptSection() {
  var card = secCard('secPrompt');
  renderField(card, { t: 'fldPromptMode', p: ['toolsConfig', 'system_prompt', 'currentModeId'], w: 'promptMode' });
  renderField(card, { t: 'fldPromptPrefix', p: ['toolsConfig', 'system_prompt', 'customPrefix'], w: 'textarea' });
  renderField(card, { t: 'fldPromptSuffix', p: ['toolsConfig', 'system_prompt', 'customSuffix'], w: 'textarea' });
  var modes = getVal(S.settings, ['toolsConfig', 'system_prompt', 'modes']);
  var ids = [];
  if (modes && typeof modes === 'object') ids = Object.keys(modes);
  var listCard = secCard('secPrompt');
  if (ids.length === 0) {
    listCard.appendChild(el('div', { class: 'info-text', text: t('noData') }));
  }
  ids.forEach(function (id) {
    var mode = (modes && modes[id]) || {};
    var open = S.promptOpenMode === id;
    var block = el('div', { class: 'cfg-item' });
    var head = el('button', { class: 'tool-card-head', type: 'button' });
    var chev = el('span', { class: 'tc-chev' + (open ? ' open' : '') });
    chev.innerHTML = icon(open ? 'chevronDown' : 'chevronRight');
    head.appendChild(chev);
    head.appendChild(el('span', { class: 'tc-name', text: mode.name || id }));
    block.appendChild(head);
    head.addEventListener('click', function () {
      S.promptOpenMode = S.promptOpenMode === id ? null : id;
      renderAllSettingsSections();
    });
    if (open) {
      var body = el('div', { class: 'tool-card-body' });
      var mpath = ['toolsConfig', 'system_prompt', 'modes', id];
      var assembly = mode.promptAssemblyMode || 'legacy';
      /* 组装方式（桌面端 radio 二选一：传统模板 / 预设条目） */
      var asmRow = el('div', { class: 'set-field' });
      asmRow.appendChild(el('span', { class: 'k', text: t('fldPromptAssembly') }));
      var asmCtl = el('span', { class: 'ctl', style: 'display:flex;gap:8px;' });
      [['legacy', t('promptAssemblyLegacy')], ['entries', t('promptAssemblyEntries')]].forEach(function (opt) {
        var active = assembly === opt[0];
        var b = el('button', {
          type: 'button',
          text: opt[1],
          style: (active
            ? 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);'
            : 'background:var(--vscode-input-background);color:var(--vscode-input-foreground);') +
            'border:1px solid var(--vscode-input-border);border-radius:6px;padding:4px 10px;font-size:12px;'
        });
        b.addEventListener('click', function () {
          if (assembly === opt[0]) return;
          if (opt[0] === 'entries') {
            var cur = normalizePromptEntries(mode.promptEntries || []);
            saveSettingsPatch(patchFor(mpath.concat(['promptEntries']), cur));
            saveSettingsPatch(patchFor(mpath.concat(['promptAssemblyMode']), 'entries'));
          } else {
            saveSettingsPatch(patchFor(mpath.concat(['promptAssemblyMode']), 'legacy'));
          }
        });
        asmCtl.appendChild(b);
      });
      asmRow.appendChild(asmCtl);
      body.appendChild(asmRow);
      if (assembly === 'entries') {
        /* 预设条目编辑器（桌面端 PromptEntriesEditor 同构） */
        renderPromptEntriesEditor(body, mpath, mode.promptEntries || []);
      } else {
        renderField(body, { t: 'fldPromptTemplate', p: mpath.concat(['template']), w: 'textarea' });
        renderField(body, { t: 'fldPromptDynamicEnabled', p: mpath.concat(['dynamicTemplateEnabled']), w: 'toggle' });
        renderField(body, { t: 'fldPromptDynamic', p: mpath.concat(['dynamicTemplate']), w: 'textarea' });
      }
      renderField(body, { t: 'fldPromptStrategy', p: mpath.concat(['dynamicContextStrategy']), w: 'select', o: ['single', 'preserve'] });
      renderField(body, { t: 'fldPromptToolPolicy', p: mpath.concat(['toolPolicy']), w: 'checklist', items: toolNameItems() });
      block.appendChild(body);
    }
    var actions = el('div', { class: 'cfg-actions' });
    var renameBtn = el('button', { class: 'mini-btn', text: t('modeRename') });
    renameBtn.addEventListener('click', function () {
      openModal(t('modeRename'), mode.name || id, t('save'), t('renameCancel'), null, function (val) {
        var name = String(val || '').trim();
        if (!name) return;
        post('/api/prompt-mode-rename', { modeId: id, name: name }).then(function () {
          toast(t('renamed'));
          refreshPromptModes();
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
    });
    actions.appendChild(renameBtn);
    var copyBtn = el('button', { class: 'mini-btn', text: t('modeCopy') });
    copyBtn.addEventListener('click', function () {
      openModal(t('modeCopy'), (mode.name || id) + '-copy', t('createChannel'), t('renameCancel'), null, function (val) {
        var name = String(val || '').trim();
        if (!name) return;
        var newId = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || ('mode-' + Date.now().toString(36));
        post('/api/prompt-mode-save', { mode: Object.assign({}, mode, { id: newId, name: name }) }).then(function () {
          toast(t('channelCreated'));
          refreshPromptModes();
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
    });
    actions.appendChild(copyBtn);
    var deleteBtn = el('button', { class: 'mini-btn danger', text: t('modeDelete') });
    deleteBtn.addEventListener('click', function () {
      openModal(t('modeDelete'), null, t('deleteChannelConfirm'), t('renameCancel'), 'danger', function () {
        post('/api/prompt-mode-delete', { modeId: id }).then(function () {
          toast(t('deleted'));
          refreshPromptModes();
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
    });
    actions.appendChild(deleteBtn);
    block.appendChild(actions);
    listCard.appendChild(block);
  });
  var addBtn = el('button', { class: 'add-channel-btn' });
  addBtn.innerHTML = icon('plus') + '<span>' + esc(t('modeNew')) + '</span>';
  addBtn.addEventListener('click', function () {
    openModal(t('modeNew'), '', t('createChannel'), t('renameCancel'), null, function (val) {
      var name = String(val || '').trim();
      if (!name) return;
      var newId = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || ('mode-' + Date.now().toString(36));
      post('/api/prompt-mode-save', { mode: { id: newId, name: name, template: '', dynamicTemplateEnabled: false, dynamicTemplate: '' } }).then(function () {
        toast(t('channelCreated'));
        refreshPromptModes();
      }).catch(function (err) {
        toast(t('settingsFailed') + ': ' + (err.message || ''));
      });
    });
  });
  listCard.appendChild(addBtn);
}
function refreshPromptModes() {
  loadSettings();
  loadPromptModes();
  renderAllSettingsSections();
}
/* ---------- 提示词预设条目编辑器（桌面端 PromptEntriesEditor 同构） ---------- */
var PE_CHAT_ID = 'chat-history';
function normalizePromptEntries(raw) {
  var src = Array.isArray(raw) ? raw : [];
  var used = {};
  var out = [];
  var hasChat = false;
  src.forEach(function (e, i) {
    if (!e || typeof e !== 'object') return;
    var isChat = e.type === 'chat_history' || e.id === PE_CHAT_ID;
    if (isChat) {
      if (hasChat) return;
      hasChat = true;
      out.push({
        id: PE_CHAT_ID,
        name: (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : 'Chat History',
        type: 'chat_history',
        enabled: true,
        role: 'user',
        content: '',
        fakeThought: '',
        order: typeof e.order === 'number' && isFinite(e.order) ? e.order : out.length
      });
      return;
    }
    var id = (typeof e.id === 'string' && e.id.trim()) ? e.id.trim() : 'entry_' + i;
    if (used[id]) id = id + '_' + i;
    used[id] = true;
    out.push({
      id: id,
      name: (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : 'Prompt ' + (i + 1),
      type: 'prompt',
      enabled: e.enabled !== false,
      role: (e.role === 'user' || e.role === 'assistant' || e.role === 'system') ? e.role : 'system',
      content: typeof e.content === 'string' ? e.content : '',
      fakeThought: typeof e.fakeThought === 'string' ? e.fakeThought : '',
      order: typeof e.order === 'number' && isFinite(e.order) ? e.order : i
    });
  });
  if (!hasChat) {
    out.push({
      id: PE_CHAT_ID,
      name: 'Chat History',
      type: 'chat_history',
      enabled: true,
      role: 'user',
      content: '',
      fakeThought: '',
      order: out.length
    });
  }
  return out.sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).map(function (e, i) {
    return Object.assign({}, e, { order: i });
  });
}
function savePromptEntriesSilent(mpath, entries) {
  post('/api/settings', { settings: patchFor(mpath.concat(['promptEntries']), normalizePromptEntries(entries)) }).then(function (data) {
    S.settings = data.settings || S.settings;
  }).catch(function (err) {
    toast(t('settingsFailed') + ': ' + (err.message || ''));
  });
}
function renderPromptEntriesEditor(container, mpath, entries) {
  var entries2 = normalizePromptEntries(entries);
  container.appendChild(el('div', { class: 'pe-hint', text: t('peEntriesHint') }));
  var toolbar = el('div', { class: 'pe-toolbar' });
  var addBtn = el('button', { class: 'mini-btn' });
  addBtn.innerHTML = icon('plus') + '<span>' + esc(t('peAdd')) + '</span>';
  addBtn.addEventListener('click', function () {
    var next = entries2.slice();
    next.push({
      id: 'entry_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: 'Prompt ' + next.length,
      type: 'prompt',
      enabled: true,
      role: 'system',
      content: '',
      fakeThought: '',
      order: next.length
    });
    entries2 = normalizePromptEntries(next);
    savePromptEntriesSilent(mpath, entries2);
    renderPromptEntriesEditor(container, mpath, entries2);
  });
  toolbar.appendChild(addBtn);
  var convBtn = el('button', { class: 'mini-btn' });
  convBtn.innerHTML = icon('refresh') + '<span>' + esc(t('peConvertLegacy')) + '</span>';
  convBtn.addEventListener('click', function () {
    var mode = getVal(S.settings, mpath) || {};
    var out = [];
    var cleanedTemplate = String(mode.template || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    var cleanedDynamic = String(mode.dynamicTemplate || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    if (cleanedTemplate) {
      out.push({
        id: 'legacy-system-template',
        name: t('peLegacySystem'),
        enabled: true,
        role: 'system',
        content: cleanedTemplate,
        order: 0
      });
    }
    if (cleanedDynamic) {
      out.push({
        id: 'legacy-dynamic-context',
        name: t('peLegacyDynamic'),
        enabled: mode.dynamicTemplateEnabled !== false,
        role: 'user',
        content: cleanedDynamic,
        order: 100
      });
    }
    var patch = patchFor(mpath.concat(['promptEntries']), normalizePromptEntries(out));
    setVal(patch, mpath.concat(['promptAssemblyMode']), 'entries');
    post('/api/settings', { settings: patch }).then(function (data) {
      S.settings = data.settings || S.settings;
      renderAllSettingsSections();
    }).catch(function (err) {
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  });
  toolbar.appendChild(convBtn);
  container.appendChild(toolbar);
  entries2.forEach(function (entry, idx) {
    var isChat = entry.type === 'chat_history' || entry.id === PE_CHAT_ID;
    var item = el('div', { class: 'pe-item' + (isChat ? ' pe-chat' : '') });
    var head = el('div', { class: 'pe-head' });
    if (!isChat) {
      var tg = itemToggle(entry.enabled !== false, function (v) {
        var next = entries2.slice();
        next[idx] = Object.assign({}, next[idx], { enabled: v });
        entries2 = normalizePromptEntries(next);
        savePromptEntriesSilent(mpath, entries2);
        renderPromptEntriesEditor(container, mpath, entries2);
      });
      head.appendChild(tg);
    }
    var nameWrap = el('div', { class: 'pe-name' });
    var nameInput = el('input', { type: 'text' });
    nameInput.value = entry.name || '';
    nameInput.disabled = isChat;
    nameInput.addEventListener('change', function () {
      var next = entries2.slice();
      next[idx] = Object.assign({}, next[idx], { name: nameInput.value });
      entries2 = normalizePromptEntries(next);
      savePromptEntriesSilent(mpath, entries2);
    });
    nameWrap.appendChild(nameInput);
    head.appendChild(nameWrap);
    if (isChat) {
      head.appendChild(el('span', { class: 'pe-chat-pill', text: t('peChatHistory') }));
    } else {
      var roleSel = el('select', { class: 'pe-role' });
      [['system', t('peRoleSystem')], ['user', t('peRoleUser')], ['assistant', t('peRoleAssistant')]].forEach(function (r) {
        roleSel.appendChild(el('option', { value: r[0], text: r[1] }));
      });
      roleSel.value = entry.role || 'system';
      roleSel.addEventListener('change', function () {
        var next = entries2.slice();
        next[idx] = Object.assign({}, next[idx], { role: roleSel.value });
        entries2 = normalizePromptEntries(next);
        savePromptEntriesSilent(mpath, entries2);
        renderPromptEntriesEditor(container, mpath, entries2);
      });
      head.appendChild(roleSel);
    }
    item.appendChild(head);
    var pbody = el('div', { class: 'pe-body' });
    var contentTa = el('textarea', { spellcheck: 'false', placeholder: t('peContent') });
    contentTa.value = entry.content || '';
    contentTa.addEventListener('change', function () {
      var next = entries2.slice();
      next[idx] = Object.assign({}, next[idx], { content: contentTa.value });
      entries2 = normalizePromptEntries(next);
      savePromptEntriesSilent(mpath, entries2);
    });
    pbody.appendChild(contentTa);
    if (!isChat && entry.role === 'assistant') {
      var fakeTa = el('textarea', { spellcheck: 'false', placeholder: t('peFakeThought') });
      fakeTa.value = entry.fakeThought || '';
      fakeTa.addEventListener('change', function () {
        var next = entries2.slice();
        next[idx] = Object.assign({}, next[idx], { fakeThought: fakeTa.value });
        entries2 = normalizePromptEntries(next);
        savePromptEntriesSilent(mpath, entries2);
      });
      pbody.appendChild(fakeTa);
    }
    item.appendChild(pbody);
    var acts = el('div', { class: 'pe-actions' });
    function iconBtn(iconName, label, enabled, fn) {
      var b = el('button', { type: 'button', class: 'icon-mini', 'aria-label': label });
      b.innerHTML = icon(iconName);
      if (!enabled) { b.disabled = true; b.style.opacity = '0.35'; }
      b.addEventListener('click', fn);
      return b;
    }
    if (!isChat) {
      acts.appendChild(iconBtn('arrowUp', t('peMoveUp'), idx > 0, function () {
        var next = entries2.slice();
        var tmp = next[idx - 1];
        next[idx - 1] = next[idx];
        next[idx] = tmp;
        entries2 = normalizePromptEntries(next);
        savePromptEntriesSilent(mpath, entries2);
        renderPromptEntriesEditor(container, mpath, entries2);
      }));
      acts.appendChild(iconBtn('arrowDown', t('peMoveDown'), idx < entries2.length - 1, function () {
        var next = entries2.slice();
        var tmp = next[idx + 1];
        next[idx + 1] = next[idx];
        next[idx] = tmp;
        entries2 = normalizePromptEntries(next);
        savePromptEntriesSilent(mpath, entries2);
        renderPromptEntriesEditor(container, mpath, entries2);
      }));
      acts.appendChild(iconBtn('copy', t('peDuplicate'), true, function () {
        var next = entries2.slice();
        var copy = Object.assign({}, next[idx], {
          id: 'entry_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          name: (next[idx].name || 'Prompt') + ' Copy',
          order: idx + 0.5
        });
        next.splice(idx + 1, 0, copy);
        entries2 = normalizePromptEntries(next);
        savePromptEntriesSilent(mpath, entries2);
        renderPromptEntriesEditor(container, mpath, entries2);
      }));
      acts.appendChild(iconBtn('trash', t('peDelete'), true, function () {
        var next = entries2.slice();
        next.splice(idx, 1);
        entries2 = normalizePromptEntries(next);
        savePromptEntriesSilent(mpath, entries2);
        renderPromptEntriesEditor(container, mpath, entries2);
      }));
    }
    item.appendChild(acts);
    container.appendChild(item);
  });
}
/* ---------- 记忆条目管理（GET /api/memory-entries，增删实时刷新） ---------- */
var S_MEM_SCOPE = 'global';
var S_MEM_SCOPES = [];
var S_MEM_WORKSPACE = '';
function loadMemoryScopes() {
  api('/api/memory-scopes').then(function (data) {
    S_MEM_SCOPES = Array.isArray(data.scopes) ? data.scopes : [];
  }).catch(function () {});
}
function memoryScopeParams() {
  if (S_MEM_SCOPE === 'workspace' && S_MEM_WORKSPACE) return { workspaceUri: S_MEM_WORKSPACE };
  return {};
}
function loadMemoryEntries() {
  var q = 'limit=100';
  var sp = memoryScopeParams();
  if (sp.workspaceUri) q += '&workspaceUri=' + encodeURIComponent(sp.workspaceUri);
  api('/api/memory-entries?' + q).then(function (data) {
    S_MEM.entries = Array.isArray(data.entries) ? data.entries : [];
    S_MEM.total = typeof data.total === 'number' ? data.total : S_MEM.entries.length;
    S_MEM.loaded = true;
    if (isPanelOpen('settings') && S.settingsTab === 'memory') renderAllSettingsSections();
  }).catch(function () {});
}
function renderMemorySection() {
  renderSimpleSection('secMemory', [
    { t: 'fldMemEnabled', p: ['toolsConfig', 'memory', 'enabled'], w: 'toggle' },
    { t: 'fldMemWakeLines', p: ['toolsConfig', 'memory', 'wakeLines'], w: 'number', min: 1 },
    { t: 'fldMemEntryChars', p: ['toolsConfig', 'memory', 'entryChars'], w: 'number', min: 1 },
    { t: 'fldMemSystemPrompt', p: ['toolsConfig', 'memory', 'systemPrompt'], w: 'textarea' }
  ]);
  var card = secCard('memEntries');
  /* 作用域选择（全局 / 工作区，桌面端 MemorySettings 同款） */
  var scopeRow = el('div', { class: 'mem-scope-row' });
  scopeRow.appendChild(el('span', { class: 'k', text: t('memScopeRow') }));
  var scopeSel = el('select');
  scopeSel.appendChild(el('option', { value: 'global', text: t('memScopeGlobal') }));
  scopeSel.appendChild(el('option', { value: 'workspace', text: t('memScopeWorkspace') }));
  scopeSel.value = S_MEM_SCOPE;
  scopeSel.addEventListener('change', function () {
    S_MEM_SCOPE = scopeSel.value;
    S_MEM_WORKSPACE = '';
    if (S_MEM_SCOPE === 'workspace' && S_MEM_SCOPES.length > 0) {
      S_MEM_WORKSPACE = S_MEM_SCOPES[0].uri || '';
    }
    S_MEM.loaded = false;
    loadMemoryEntries();
    renderAllSettingsSections();
  });
  scopeRow.appendChild(scopeSel);
  var wsSel = null;
  if (S_MEM_SCOPE === 'workspace') {
    wsSel = el('select');
    wsSel.appendChild(el('option', { value: '', text: t('memNoScopes') }));
    (S_MEM_SCOPES || []).forEach(function (sc) {
      wsSel.appendChild(el('option', { value: sc.uri, text: sc.name || sc.fsPath || sc.uri }));
    });
    if (S_MEM_WORKSPACE) wsSel.value = S_MEM_WORKSPACE;
    wsSel.addEventListener('change', function () {
      S_MEM_WORKSPACE = wsSel.value || '';
      S_MEM.loaded = false;
      loadMemoryEntries();
      renderAllSettingsSections();
    });
    scopeRow.appendChild(wsSel);
  }
  card.appendChild(scopeRow);
  if (!S_MEM.loaded) {
    card.appendChild(el('div', { class: 'info-text', text: t('loading') }));
  } else if (S_MEM.entries.length === 0) {
    card.appendChild(el('div', { class: 'info-text', text: t('memEmpty') }));
  } else {
    S_MEM.entries.forEach(function (en) {
      var item = el('div', { class: 'mem-item' });
      var editBtn = el('button', { class: 'mem-edit-btn', 'aria-label': t('memEdit') });
      editBtn.innerHTML = icon('edit');
      var editing = false;
      var textEl = el('div', { class: 'mem-text', text: (en && en.text) || '' });
      item.appendChild(textEl);
      editBtn.addEventListener('click', function () {
        if (editing) return;
        editing = true;
        textEl.remove();
        var ta = el('textarea', { spellcheck: 'false' });
        ta.value = (en && en.text) || '';
        item.insertBefore(ta, editBtn);
        var saveBtn = el('button', { class: 'mini-btn', text: t('memSave') });
        saveBtn.addEventListener('click', function () {
          var text = ta.value.trim();
          if (!text) return;
          post('/api/memory-update', Object.assign({ id: en.id, text: text }, memoryScopeParams())).then(function () {
            toast(t('saved'));
            loadMemoryEntries();
          }).catch(function (err) {
            toast(t('settingsFailed') + ': ' + (err.message || ''));
          });
        });
        item.appendChild(saveBtn);
      });
      item.appendChild(editBtn);
      item.appendChild(el('div', { class: 'mem-date', text: (en && en.date) || '' }));
      var del = el('button', { class: 'mem-del', 'aria-label': t('remove') });
      del.innerHTML = icon('trash');
      del.addEventListener('click', function () {
        post('/api/memory-delete', Object.assign({ id: en.id }, memoryScopeParams())).then(function () {
          toast(t('removed'));
          loadMemoryEntries();
        }).catch(function (err) {
          toast(t('settingsFailed') + ': ' + (err.message || ''));
        });
      });
      item.appendChild(del);
      card.appendChild(item);
    });
  }
  card.appendChild(el('div', { class: 'set-note', text: t('memTotal') + ' ' + S_MEM.total }));
  var addRow = el('div', { class: 'mem-add-row' });
  var addInput = el('input', { type: 'text', placeholder: t('memAddPlaceholder') });
  var addBtn = el('button', { class: 'mini-btn', text: t('memAdd') });
  function addEntry() {
    var text = addInput.value.trim();
    if (!text) return;
    addBtn.disabled = true;
    post('/api/memory-add', Object.assign({ text: text }, memoryScopeParams())).then(function () {
      addBtn.disabled = false;
      addInput.value = '';
      toast(t('done'));
      loadMemoryEntries();
    }).catch(function (err) {
      addBtn.disabled = false;
      toast(t('settingsFailed') + ': ' + (err.message || ''));
    });
  }
  addBtn.addEventListener('click', addEntry);
  addInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addEntry(); }
  });
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  card.appendChild(addRow);
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
      renderGeneralSection();
      break;
    case 'proxy':
      renderSimpleSection('secProxy', [
        { t: 'fldProxyEnabled', p: ['proxy', 'enabled'], w: 'toggle' },
        { t: 'fldProxyUrl', p: ['proxy', 'url'], w: 'text' },
        { t: 'fldProxyInsecure', p: ['proxy', 'insecureSkipVerify'], w: 'toggle' }
      ]);
      break;
    case 'tools':
      renderToolsSection();
      break;
    case 'autoExec':
      renderAutoExecSection();
      break;
    case 'fileTools':
      renderFileToolsSection();
      break;
    case 'sandbox':
      renderSimpleSection('secCommand', [
        { t: 'fldCmdShell', p: ['toolsConfig', 'execute_command', 'defaultShell'], w: 'select', o: ['auto', 'cmd', 'powershell', 'bash'] },
        { t: 'fldCmdTimeout', p: ['toolsConfig', 'execute_command', 'defaultTimeout'], w: 'number', min: 0, step: 1000 },
        { t: 'fldCmdMaxOutput', p: ['toolsConfig', 'execute_command', 'maxOutputLines'], w: 'number', min: -1 },
        { t: 'fldSandboxEnabled', p: ['toolsConfig', 'sandbox', 'enabled'], w: 'toggle' },
        { t: 'fldSandboxLangs', p: ['toolsConfig', 'sandbox', 'allowedLanguages'], w: 'chips' },
        { t: 'fldSbxTimeout', p: ['toolsConfig', 'sandbox', 'defaultTimeout'], w: 'number', min: 1000, step: 1000 },
        { t: 'fldSbxOutputLines', p: ['toolsConfig', 'sandbox', 'maxOutputLines'], w: 'number', min: -1 },
        { t: 'fldSbxCleanup', p: ['toolsConfig', 'sandbox', 'cleanupTempDir'], w: 'toggle' }
      ]);
      break;
    case 'prompt':
      renderPromptSection();
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
      renderMemorySection();
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
    case 'mcp':
      renderMcpSection();
      break;
    case 'usage':
      renderUsageSection();
      break;
    default:
      break;
  }
}
function loadSettings() {
  api('/api/settings').then(function (data) {
    S.settings = data.settings || null;
    if (isPanelOpen('settings') && (S.settingsTab === 'general' || S.settingsTab === 'prompt' ||
        S.settingsTab === 'context' || S.settingsTab === 'memory' || S.settingsTab === 'summarize' ||
        S.settingsTab === 'checkpoint' || S.settingsTab === 'tokenCount' || S.settingsTab === 'imageGen' ||
        S.settingsTab === 'skills' || S.settingsTab === 'subagents' || S.settingsTab === 'pinned' ||
        S.settingsTab === 'sandbox' || S.settingsTab === 'fileTools' || S.settingsTab === 'proxy' ||
        S.settingsTab === 'storage' || S.settingsTab === 'dependencies')) {
      renderAllSettingsSections();
    }
  }).catch(function () {});
}
function loadToolsList() {
  api('/api/tools').then(function (data) {
    S.tools = Array.isArray(data.tools) ? data.tools : [];
    S.autoExec = data.autoExec && typeof data.autoExec === 'object' ? data.autoExec : {};
    if (isPanelOpen('settings') && (S.settingsTab === 'tools' || S.settingsTab === 'autoExec' ||
        S.settingsTab === 'checkpoint' || S.settingsTab === 'prompt' || S.settingsTab === 'subagents')) {
      renderAllSettingsSections();
    }
  }).catch(function () {});
}
function loadDeps() {
  api('/api/dependencies').then(function (data) {
    S.deps = Array.isArray(data.dependencies) ? data.dependencies : [];
    if (isPanelOpen('settings') && S.settingsTab === 'dependencies') renderAllSettingsSections();
  }).catch(function () {});
}
function renderSettings(s) {
  S.statusInfo = s;
  if (isPanelOpen('settings') && S.settingsTab === 'remoteControl') renderAllSettingsSections();
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
$('btn-files').addEventListener('click', function () { openPanel('files'); });
$('btn-settings').addEventListener('click', function () { openPanel('settings'); });
$('btn-files-back').addEventListener('click', function () { closePanel('files'); });
$('btn-settings-back').addEventListener('click', function () { closePanel('settings'); });
$('btn-refresh').addEventListener('click', function () {
  if (isChatView()) {
    var cur = activeTab();
    if (cur && cur.id) loadMessages(cur, false);
    loadConversations(true);
    toast(t('refresh'));
    return;
  }
  if (isPanelOpen('settings')) {
    renderSettingsNav();
    renderAllSettingsSections();
    loadConfigs();
    loadSettings();
    loadToolsList();
    loadDeps();
    loadMcpServers();
    loadPromptModes();
    loadMemoryScopes();
    if (S.settingsTab === 'memory') loadMemoryEntries();
    if (S.settingsTab === 'usage') loadUsageStats();
    toast(t('refresh'));
    return;
  }
  if (isPanelOpen('files')) {
    S.fileDirs = {};
    loadFiles('', true);
    toast(t('refresh'));
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
  renderSettingsNav();
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
