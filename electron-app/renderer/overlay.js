/**
 * overlay.js - standalone-UI pieces that replaced VS Code chrome:
 *  - toasts (showInformationMessage etc.)
 *  - quick pick / input box modals
 *
 * (diff preview moved to the embedded panel: frontend/src/components/diff/DiffViewerPanel.vue,
 *  opened by the host.openDiffPreview command handled in App.vue)
 *
 * Talks to the backend through the same postMessage protocol as the app.
 */
(function () {
  'use strict';
  if (window.__graycodeOverlayLoaded) return;
  window.__graycodeOverlayLoaded = true;

  function boot() {
    // overlay.js is injected into <head> by patch-dist.mjs, so document.body
    // may not exist yet when this script first runs.
    const vscode = window.acquireVsCodeApi();
  const send = (type, data) => {
    try {
      vscode.postMessage({ type, requestId: 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), data });
    } catch (e) {
      console.error('[overlay] send failed', e);
    }
  };

  const css = `
.gc-overlay-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:var(--vscode-font-family,-apple-system,"Segoe UI",sans-serif);font-size:13px;color:var(--vscode-foreground,#cccccc)}
.gc-overlay-root *{box-sizing:border-box}
.gc-toast{position:fixed;top:14px;right:14px;width:340px;max-width:calc(100vw - 28px);pointer-events:auto;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-widget-border,#454545);border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.4);margin-bottom:8px;overflow:hidden;animation:gcToastIn .18s ease}
@keyframes gcToastIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}
.gc-toast-header{display:flex;align-items:center;gap:8px;padding:8px 12px;font-weight:600;border-bottom:1px solid var(--vscode-widget-border,#454545)}
.gc-toast-header .gc-toast-ico{flex:none;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff}
.gc-toast.info .gc-toast-ico{background:var(--vscode-button-background,#007acc)}
.gc-toast.warning .gc-toast-ico{background:var(--vscode-editorWarning-foreground,#d18616)}
.gc-toast.error .gc-toast-ico{background:var(--vscode-editorError-foreground,#f14c4c)}
.gc-toast-detail{padding:8px 12px;font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
.gc-toast-actions{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--vscode-widget-border,#454545)}
.gc-btn{pointer-events:auto;border:1px solid var(--vscode-button-border,rgba(255,255,255,.07));background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#fff);border-radius:3px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.gc-btn:hover{background:var(--vscode-button-secondaryHoverBackground,#45494e)}
.gc-btn.primary{background:var(--vscode-button-background,#0e639c)}
.gc-btn.primary:hover{background:var(--vscode-button-hoverBackground,#1177bb)}
.gc-btn.danger{background:var(--vscode-errorForeground,#be1100)}
.gc-btn.danger:hover{background:color-mix(in srgb,var(--vscode-errorForeground,#be1100) 80%,black)}
.gc-modal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);pointer-events:auto;z-index:2147483001;animation:gcFade .12s ease}
@keyframes gcFade{from{opacity:0}to{opacity:1}}
.gc-modal-box{width:520px;max-width:calc(100vw - 48px);max-height:calc(100vh - 80px);background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-widget-border,#454545);border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden}
.gc-modal-title{padding:10px 14px;font-weight:600;border-bottom:1px solid var(--vscode-widget-border,#454545);display:flex;align-items:center;gap:8px}
.gc-modal-body{overflow:auto;padding:6px 0}
.gc-qp-item{padding:8px 14px;cursor:pointer;display:flex;flex-direction:column;gap:2px}
.gc-qp-item:hover,.gc-qp-item.selected{background:var(--vscode-list-activeSelectionBackground,#094771);color:var(--vscode-list-activeSelectionForeground,#fff)}
.gc-qp-item .gc-qp-label{font-size:13px}
.gc-qp-item .gc-qp-desc{font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d)}
.gc-qp-item:hover .gc-qp-desc{color:rgba(255,255,255,.85)}
.gc-input{padding:8px 14px;border:none;background:transparent;color:var(--vscode-foreground,#ccc);font-size:13px;outline:none;width:100%;font-family:inherit}
.gc-modal-actions{display:flex;justify-content:flex-end;gap:6px;padding:10px 14px;border-top:1px solid var(--vscode-widget-border,#454545)}
.gc-empty{color:var(--vscode-descriptionForeground,#9d9d9d);padding:24px;text-align:center}
`;

  let styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'gc-overlay-root';
  document.body.appendChild(root);

  // ================= toasts =================
  function showToast(payload) {
    const el = document.createElement('div');
    el.className = 'gc-toast ' + (payload.type || 'info');
    const icon = payload.type === 'warning' ? '!' : payload.type === 'error' ? '!' : 'i';
    let html = `<div class="gc-toast-header"><span class="gc-toast-ico">${icon}</span><span style="flex:1;min-width:0">${escapeHtml(payload.message || '')}</span><button class="gc-btn" data-act="__close">×</button></div>`;
    if (payload.detail) html += `<div class="gc-toast-detail">${escapeHtml(payload.detail)}</div>`;
    el.innerHTML = html;
    const actions = document.createElement('div');
    actions.className = 'gc-toast-actions';
    actions.style.display = 'none';
    if (payload.items && payload.items.length > 0) {
      actions.style.display = 'flex';
      payload.items.forEach((item) => {
        const b = document.createElement('button');
        b.className = 'gc-btn' + (item === 'Open Chat' ? ' primary' : '');
        b.textContent = item;
        b.addEventListener('click', () => {
          replyToast(payload.id, item);
          el.remove();
        });
        actions.appendChild(b);
      });
    }
    el.appendChild(actions);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      replyToast(payload.id, undefined);
      el.remove();
    });
    root.appendChild(el);
    // 超时自动移除时回执 undefined，否则后端 showMessage 的 Promise 永久挂起（M-5）
    setTimeout(() => {
      replyToast(payload.id, undefined);
      el.remove();
    }, 10000);
  }

  function replyToast(id, selected) {
    send('host.toastReply', { id, selected });
  }

  // ================= quick pick / input box =================
  function showQuickPick(payload) {
    const modal = document.createElement('div');
    modal.className = 'gc-modal';
    const items = payload.items || [];
    modal.innerHTML = `<div class="gc-modal-box"><div class="gc-modal-title"><span style="flex:1">选择…</span><button class="gc-btn" data-act="cancel">取消</button></div><div class="gc-modal-body"></div></div>`;
    const body = modal.querySelector('.gc-modal-body');
    const box = modal.querySelector('.gc-modal-box');
    let selectedIndex = 0;
    items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'gc-qp-item';
      row.innerHTML = `<span class="gc-qp-label">${escapeHtml(item.label ?? item.description ?? String(item))}</span>${item.description ? `<span class="gc-qp-desc">${escapeHtml(item.description)}</span>` : ''}`;
      row.addEventListener('click', () => finish(item));
      row.addEventListener('mouseenter', () => setSelected(idx));
      body.appendChild(row);
    });
    function setSelected(idx) {
      selectedIndex = idx;
      [...body.children].forEach((c, i) => c.classList.toggle('selected', i === idx));
    }
    if (items.length > 0) setSelected(0);
    function finish(item) {
      modal.remove();
      send('host.toastReply', { id: payload.id, selected: item });
    }
    modal.querySelector('[data-act="cancel"]').addEventListener('click', () => {
      modal.remove();
      send('host.toastReply', { id: payload.id, selected: undefined });
    });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        send('host.toastReply', { id: payload.id, selected: undefined });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected(Math.min(items.length - 1, selectedIndex + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected(Math.max(0, selectedIndex - 1));
      } else if (e.key === 'Enter' && items[selectedIndex]) {
        finish(items[selectedIndex]);
      }
    });
    root.appendChild(modal);
    box.focus?.();
    modal.tabIndex = -1;
    modal.focus();
  }

  function showInputBox(payload) {
    const opts = payload.options || {};
    const modal = document.createElement('div');
    modal.className = 'gc-modal';
    modal.innerHTML = `<div class="gc-modal-box"><div class="gc-modal-title">${escapeHtml(opts.title || '输入')}</div><input class="gc-input" value="${escapeHtml(opts.value || '')}" placeholder="${escapeHtml(opts.placeHolder || '')}"><div class="gc-modal-actions"><button class="gc-btn" data-act="cancel">取消</button><button class="gc-btn primary" data-act="ok">确定</button></div></div>`;
    const input = modal.querySelector('input');
    const finish = (val) => {
      modal.remove();
      send('host.toastReply', { id: payload.id, selected: val });
    };
    modal.querySelector('[data-act="ok"]').addEventListener('click', () => finish(input.value));
    modal.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(undefined));
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') finish(undefined);
      else if (e.key === 'Enter') finish(input.value);
    });
    root.appendChild(modal);
    input.focus();
    input.select();
  }

  // ================= message dispatch =================
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'command') {
      switch (msg.command) {
        case 'host.toast':
          showToast(msg.data || {});
          break;
        case 'host.quickPick':
          showQuickPick(msg.data || {});
          break;
        case 'host.inputBox':
          showInputBox(msg.data || {});
          break;
        case 'host.noWorkspace':
          showNoWorkspaceToast(msg.data || {});
          break;
        case 'host.firstRun':
          showFirstRunToast(msg.data || {});
          break;
      }
    }
  });

  // ================= no-workspace hint =================
  function showNoWorkspaceToast(payload) {
    const el = document.createElement('div');
    el.className = 'gc-toast warning';
    const detail = String(payload.message || 'No workspace folder is open.');
    const openLabel = String(payload.openFolderLabel || 'Open Folder...');
    el.innerHTML = `<div class="gc-toast-header"><span class="gc-toast-ico">!</span><span style="flex:1;min-width:0">${escapeHtml(payload.title || 'Workspace')}</span><button class="gc-btn" data-act="__close">×</button></div><div class="gc-toast-detail">${escapeHtml(detail)}</div><div class="gc-toast-actions" style="display:flex"><button class="gc-btn primary" data-act="open">${escapeHtml(openLabel)}</button></div>`;
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'open') {
        try { window.__graycodeNative?.('workspace:pickFolder'); } catch (e2) { /* ignore */ }
        el.remove();
      } else if (act === '__close') {
        el.remove();
      }
    });
    root.appendChild(el);
    setTimeout(() => el.remove(), 20000);
  }

  // ================= first-run welcome =================
  function showFirstRunToast(payload) {
    const el = document.createElement('div');
    el.className = 'gc-toast info';
    const detail = String(payload.message || 'Welcome to GrayCode Desktop!');
    const title = String(payload.title || 'Welcome to GrayCode Desktop');
    const openSettingsLabel = String(payload.openSettingsLabel || 'Open Settings');
    const openFolderLabel = String(payload.openFolderLabel || 'Open Folder...');
    el.innerHTML = `<div class="gc-toast-header"><span class="gc-toast-ico">i</span><span style="flex:1;min-width:0">${escapeHtml(title)}</span><button class="gc-btn" data-act="__close">×</button></div><div class="gc-toast-detail">${escapeHtml(detail)}</div><div class="gc-toast-actions" style="display:flex"><button class="gc-btn primary" data-act="openSettings">${escapeHtml(openSettingsLabel)}</button><button class="gc-btn" data-act="openFolder">${escapeHtml(openFolderLabel)}</button></div>`;
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'openSettings') {
        // same command the extension pushed in VS Code - the app listens for it
        try { window.postMessage({ type: 'command', command: 'showSettings', data: {} }, '*'); } catch (e2) { /* ignore */ }
        el.remove();
      } else if (act === 'openFolder') {
        try { window.__graycodeNative?.('workspace:pickFolder'); } catch (e2) { /* ignore */ }
        el.remove();
      } else if (act === '__close') {
        el.remove();
      }
    });
    root.appendChild(el);
    setTimeout(() => el.remove(), 30000);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  }

  if (document.body) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
})();
