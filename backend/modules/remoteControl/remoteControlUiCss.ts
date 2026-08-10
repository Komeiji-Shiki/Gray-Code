/**
 * remoteControlUiCss.ts
 *
 * 远程控制移动端 UI 的样式（V3 重构版）。
 *
 * 设计对齐桌面端（VS Code Dark+ 主题令牌）：
 * - 输入区四选择器（模型模式 / 渠道 / 模型 / 思考强度）与桌面端 InputSelectorBar 同款，
 *   下拉面板尺寸适中（不再是被挤压变形的窄 select）；
 * - 会话页签始终可关闭（含未落库的新对话页签）；
 * - 全部图标使用内嵌 SVG（无 emoji 依赖，杜绝移动端图标丢失）；
 * - 设置页 19 分类与桌面端 SettingsPanel 侧栏对齐，渠道支持完整增删改。
 */

export const REMOTE_UI_CSS = `
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
  --vscode-focusBorder: #007fd4;
  --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
  --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-button-secondaryHoverBackground: #45494e;
  --vscode-dropdown-background: #3c3c3c;
  --vscode-dropdown-foreground: #f0f0f0;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: rgba(204, 204, 204, 0.5);
  --vscode-panel-background: #1e1e1e;
  --vscode-panel-border: rgba(128, 128, 128, 0.35);
  --vscode-sideBar-background: #252526;
  --vscode-sideBar-foreground: #cccccc;
  --vscode-tab-activeBackground: #1e1e1e;
  --vscode-tab-inactiveBackground: #2d2d2d;
  --vscode-tab-activeForeground: #ffffff;
  --vscode-tab-inactiveForeground: rgba(255, 255, 255, 0.6);
  --vscode-list-hoverBackground: rgba(128, 128, 128, 0.15);
  --vscode-list-activeSelectionBackground: #094771;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-focusOutline: #007fd4;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
  --vscode-textLink-foreground: #3794ff;
  --vscode-terminal-ansiGreen: #89d185;
  --vscode-terminal-ansiRed: #f14c4c;
  --vscode-terminal-ansiYellow: #cca700;
  --vscode-charts-yellow: #e2c08d;
  --vscode-progressBar-background: #0e70c0;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-checkbox-background: #3c3c3c;
  --vscode-checkbox-border: #3c3c3c;
  --vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.31);
  --vscode-focusBorderSoft: rgba(0, 127, 212, 0.5);
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 6px;
  --header-h: 46px;
  --tabbar-h: 54px;
  --footer-safe: env(safe-area-inset-bottom, 0px);
  --green: #89d185;
  --red: #f14c4c;
  --dim: #9d9d9d;
}

@media (prefers-color-scheme: light) {
  :root {
    --vscode-foreground: #383a42;
    --vscode-disabledForeground: rgba(56, 58, 66, 0.5);
    --vscode-errorForeground: #c42b1c;
    --vscode-descriptionForeground: #6a737d;
    --vscode-editor-background: #ffffff;
    --vscode-editor-foreground: #383a42;
    --vscode-panel-background: #ffffff;
    --vscode-panel-border: rgba(128, 128, 128, 0.3);
    --vscode-sideBar-background: #f3f3f3;
    --vscode-sideBar-foreground: #383a42;
    --vscode-tab-activeBackground: #ffffff;
    --vscode-tab-inactiveBackground: #ececec;
    --vscode-tab-activeForeground: #1f1f1f;
    --vscode-tab-inactiveForeground: rgba(31, 31, 31, 0.7);
    --vscode-list-hoverBackground: rgba(128, 128, 128, 0.12);
    --vscode-list-activeSelectionBackground: #0060c0;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-editorWidget-background: #f3f3f3;
    --vscode-editorWidget-border: #c8c8c8;
    --vscode-dropdown-background: #ffffff;
    --vscode-dropdown-foreground: #1f1f1f;
    --vscode-dropdown-border: #c8c8c8;
    --vscode-input-background: #ffffff;
    --vscode-input-foreground: #1f1f1f;
    --vscode-input-border: #c8c8c8;
    --vscode-input-placeholderForeground: rgba(31, 31, 31, 0.4);
    --vscode-button-background: #0e639c;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-secondaryBackground: #e4e4e4;
    --vscode-button-secondaryForeground: #1f1f1f;
    --vscode-button-secondaryHoverBackground: #d4d4d4;
    --vscode-textLink-foreground: #006ab1;
    --vscode-terminal-ansiGreen: #137a00;
    --vscode-terminal-ansiRed: #cd3131;
    --vscode-terminal-ansiYellow: #949800;
    --vscode-badge-background: #c4c4c4;
    --vscode-badge-foreground: #333333;
    --vscode-checkbox-background: #ffffff;
    --vscode-checkbox-border: #c8c8c8;
    --vscode-progressBar-background: #006ab1;
    --vscode-widget-shadow: rgba(0, 0, 0, 0.15);
    --green: #137a00;
    --red: #cd3131;
    --dim: #6a737d;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }
/* 关键修复：author 样式 display:flex 不得覆盖 hidden 属性（历史故障：隐藏容器仍占屏） */
[hidden] { display: none !important; }

html, body {
  height: 100%;
  overscroll-behavior: none;
}
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-panel-background);
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  -webkit-user-select: none;
}
input, textarea, .editable { user-select: text; -webkit-user-select: text; }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
svg { display: block; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

#app {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 100dvh;
}

/* ================= 顶栏 ================= */
header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--header-h);
  padding: 0 8px;
  background: var(--vscode-sideBar-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--vscode-icon-foreground);
  flex-shrink: 0;
}
.icon-btn:active { background: var(--vscode-toolbar-hoverBackground); }
.icon-btn svg { width: 18px; height: 18px; }
.title-wrap { flex: 1; min-width: 0; }
#title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 0; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.ok { background: var(--vscode-terminal-ansiGreen); }
.dot.err { background: var(--vscode-terminal-ansiRed); }
.dot.busy { background: var(--vscode-terminal-ansiYellow); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: 0.4; } }
#status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ================= 会话页签条（桌面端 ConversationTabs 同款） ================= */
#tabs-bar {
  display: flex;
  align-items: center;
  min-height: 34px;
  background: var(--vscode-tab-inactiveBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
#conv-tabs {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
  min-width: 0;
}
#conv-tabs::-webkit-scrollbar { display: none; }
.conv-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 170px;
  min-width: 0;
  padding: 0 10px;
  font-size: 12.5px;
  color: var(--vscode-tab-inactiveForeground);
  background: var(--vscode-tab-inactiveBackground);
  border-right: 1px solid var(--vscode-panel-border);
  white-space: nowrap;
  flex-shrink: 0;
}
.conv-tab.active {
  background: var(--vscode-tab-activeBackground);
  color: var(--vscode-tab-activeForeground);
  box-shadow: inset 0 -2px 0 var(--vscode-textLink-foreground);
}
.conv-tab .tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
/* 关键修复：所有页签（含未落库的新对话页签）都可关闭 */
.conv-tab .tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  font-size: 15px;
  line-height: 1;
  color: var(--vscode-icon-foreground);
  flex-shrink: 0;
}
.conv-tab .tab-close:active { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.conv-tab.new {
  padding: 0 14px;
  font-size: 18px;
  font-weight: 600;
  color: var(--vscode-icon-foreground);
}
.conv-tab.new:active { background: var(--vscode-list-hoverBackground); }
.tab-spin {
  width: 10px;
  height: 10px;
  border: 2px solid transparent;
  border-top-color: var(--vscode-progressBar-background);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* V4 页签：脚本渲染 .tab/.tab.active/.tab.streaming + .tab-label/.tab-close/.tab-add */
.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 170px;
  min-width: 0;
  padding: 0 8px 0 10px;
  font-size: 12.5px;
  color: var(--vscode-tab-inactiveForeground);
  background: var(--vscode-tab-inactiveBackground);
  border-right: 1px solid var(--vscode-panel-border);
  white-space: nowrap;
  flex-shrink: 0;
}
.tab.active {
  background: var(--vscode-tab-activeBackground);
  color: var(--vscode-tab-activeForeground);
  box-shadow: inset 0 -2px 0 var(--vscode-textLink-foreground);
}
.tab.streaming {
  color: var(--vscode-tab-activeForeground);
  box-shadow: inset 0 -2px 0 var(--vscode-progressBar-background);
}
.tab.streaming:not(.active) { background: color-mix(in srgb, var(--vscode-progressBar-background) 8%, var(--vscode-tab-inactiveBackground)); }
.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.tab .tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  font-size: 15px;
  line-height: 1;
  color: var(--vscode-icon-foreground);
  flex-shrink: 0;
  opacity: 0.65;
}
.tab:hover .tab-close, .tab.active .tab-close, .tab:active .tab-close { opacity: 1; }
.tab .tab-close:active { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.tab .tab-close svg { width: 12px; height: 12px; }
.tab-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 100%;
  flex-shrink: 0;
  color: var(--vscode-icon-foreground);
  font-size: 18px;
  font-weight: 600;
}
.tab-add:active { background: var(--vscode-list-hoverBackground); }
.tab-add svg { width: 15px; height: 15px; }

/* ================= 主视图 ================= */
#views { flex: 1; min-height: 0; display: flex; }
.view { flex: 1; min-width: 0; display: flex; flex-direction: column; }

/* ---------- 消息列表 ---------- */
#messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding-bottom: 8px;
}
.msg {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
  font-size: 13px;
  line-height: 1.65;
  word-break: break-word;
}
.msg.user { background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent); }
.msg .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; }
.msg .role-label {
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.msg .model { color: var(--vscode-descriptionForeground); }
.msg .actions { margin-left: auto; display: flex; gap: 2px; }
.msg .actions .icon-btn { width: 24px; height: 24px; }
.msg .actions .icon-btn svg { width: 14px; height: 14px; }
.msg-content { font-size: 13px; }
/* V4 消息：头 / 工具 / 操作行 / 错误盒 */
.msg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; }
.msg-role {
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.msg.assistant .msg-head .msg-role { color: var(--vscode-textLink-foreground); }
.msg-model { color: var(--vscode-descriptionForeground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-time { color: var(--vscode-descriptionForeground); margin-left: auto; flex-shrink: 0; }
.msg-tools {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: var(--radius-md);
  padding: 3px 10px;
  font-size: 11.5px;
  margin: 0 4px 6px 0;
}
.msg-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.msg-actions .mini-btn { padding: 4px 9px; min-height: 26px; }
.msg-actions .mini-btn svg { width: 13px; height: 13px; }
.err-box {
  margin: 10px 16px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--vscode-terminal-ansiRed) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--vscode-terminal-ansiRed) 40%, transparent);
  border-radius: var(--radius-md);
  font-size: 12.5px;
  color: var(--vscode-errorForeground);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.err-box .mini-btn { flex-shrink: 0; }
.msg-content p { margin: 6px 0; }
.msg-content p:first-child { margin-top: 0; }
.msg-content p:last-child { margin-bottom: 0; }
.msg-content pre {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  overflow-x: auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  margin: 8px 0;
}
.msg-content code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  background: rgba(128, 128, 128, 0.15);
  border-radius: 3px;
  padding: 1px 4px;
}
.msg-content pre code { background: none; padding: 0; }
.msg-content ul, .msg-content ol { margin: 6px 0; padding-left: 22px; }
.msg-content blockquote {
  margin: 6px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--vscode-textLink-foreground);
  color: var(--vscode-descriptionForeground);
}
.msg-content table { border-collapse: collapse; margin: 8px 0; }
.msg-content th, .msg-content td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; }
.msg-content a { color: var(--vscode-textLink-foreground); }
.msg-content h1, .msg-content h2, .msg-content h3 { margin: 10px 0 6px; }
.markdown h4, .markdown h5, .markdown h6 {
  margin: 8px 0 6px;
  font-size: 13px;
  font-weight: 600;
}
.markdown ul, .markdown ol { margin: 6px 0; padding-left: 22px; }
.markdown li { margin: 2px 0; }
.markdown pre, .markdown code { font-family: ui-monospace, Consolas, monospace; }
.md-spacer { height: 8px; }
.caret { display: inline-block; width: 7px; height: 14px; background: var(--vscode-progressBar-background); animation: blink 1s steps(1) infinite; vertical-align: text-bottom; }
@keyframes blink { 50% { opacity: 0; } }
.thoughts {
  border-left: 2px solid var(--vscode-descriptionForeground);
  padding: 4px 10px;
  margin: 6px 0;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  max-height: 130px;
  overflow: hidden;
  position: relative;
  opacity: 0.8;
}
.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: var(--radius-md);
  padding: 3px 10px;
  font-size: 11.5px;
  margin: 3px 4px 3px 0;
}
.tool-chip svg { width: 12px; height: 12px; }
.tool-result {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin: 6px 0;
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
}
.error-banner {
  margin: 10px 16px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--vscode-terminal-ansiRed) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--vscode-terminal-ansiRed) 40%, transparent);
  border-radius: var(--radius-md);
  font-size: 12.5px;
  color: var(--vscode-errorForeground);
}
.error-banner .retry-btn {
  display: inline-block;
  margin-top: 6px;
  padding: 3px 12px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

/* 空状态 */
#empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--vscode-descriptionForeground);
  padding: 30px 20px;
  text-align: center;
}
#empty .big svg { width: 56px; height: 56px; opacity: 0.45; }
#empty-text { font-size: 13px; line-height: 1.6; }

/* 加载更多历史 */
.hist-more {
  padding: 10px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

/* ---------- 工具审批条 ---------- */
#confirm-bar { flex-shrink: 0; }
.confirm-inner {
  margin: 6px 12px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-focusBorderSoft);
  border-radius: var(--radius-md);
}
.confirm-box {
  margin: 6px 12px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-focusBorderSoft);
  border-radius: var(--radius-md);
}
.confirm-item {
  padding: 4px 0;
  font-size: 12.5px;
  font-family: ui-monospace, Consolas, monospace;
  word-break: break-all;
}
.confirm-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.confirm-title svg { width: 14px; height: 14px; color: var(--vscode-terminal-ansiYellow); }
.confirm-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12.5px;
}
.confirm-tool .tname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.confirm-actions { display: flex; gap: 8px; margin-top: 8px; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  min-height: 34px;
}
.btn:active { background: var(--vscode-button-hoverBackground); }
.btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.secondary:active { background: var(--vscode-button-secondaryHoverBackground); }
.btn.danger { background: var(--vscode-terminal-ansiRed); color: #ffffff; }
.btn:disabled { opacity: 0.4; }
.btn svg { width: 15px; height: 15px; }

/* ---------- 输入区（桌面端 InputSelectorBar 同款四选择器 + 输入行） ---------- */
footer.composer {
  flex-shrink: 0;
  background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border);
  padding-bottom: var(--footer-safe);
}
/* 选择器行：模式 / 渠道 / 模型 / 思考强度（与桌面端 InputSelectorBar 一致） */
#composer-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 0;
  overflow-x: auto;
  scrollbar-width: none;
}
#composer-meta::-webkit-scrollbar { display: none; }
.sel-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 150px;
}
.sel-chip:active { border-color: var(--vscode-focusBorder); }
.sel-chip .sel-label { color: var(--vscode-descriptionForeground); }
.sel-chip .sel-value { overflow: hidden; text-overflow: ellipsis; }
.sel-chip .sel-arrow { width: 12px; height: 12px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px;
}
#input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-md);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: 9px 12px;
  max-height: 120px;
  min-height: 38px;
  line-height: 1.5;
}
#input::placeholder { color: var(--vscode-input-placeholderForeground); }
#input:focus { outline: none; border-color: var(--vscode-focusBorder); }
#send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  flex-shrink: 0;
}
#send:active { background: var(--vscode-button-hoverBackground); }
#send:disabled { opacity: 0.35; }
#send svg { width: 17px; height: 17px; }
#send.stop { background: var(--vscode-terminal-ansiRed); }

/* ---------- 文件页 ---------- */
#ws-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
.ws-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws-sub { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws-add-btn, .mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 12px;
  border: 1px solid var(--vscode-button-secondaryBackground);
  border-radius: var(--radius-sm);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 12px;
  flex-shrink: 0;
  min-height: 30px;
}
.ws-add-btn { padding: 0; width: 30px; height: 30px; }
.ws-add-btn svg { width: 15px; height: 15px; }
.ws-add-btn:active, .mini-btn:active { background: var(--vscode-button-secondaryHoverBackground); }
.mini-btn.danger { background: color-mix(in srgb, var(--vscode-terminal-ansiRed) 20%, transparent); border-color: color-mix(in srgb, var(--vscode-terminal-ansiRed) 45%, transparent); color: var(--vscode-errorForeground); }
#file-tree { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0; }
.fdir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 14px;
  font-size: 13px;
  text-align: left;
  color: var(--vscode-foreground);
}
.fdir-row:active { background: var(--vscode-list-hoverBackground); }
.fdir-row .fico { width: 16px; height: 16px; color: var(--vscode-icon-foreground); flex-shrink: 0; }
.fdir-row .caret-svg { width: 12px; height: 12px; color: var(--vscode-descriptionForeground); }
.fdir-row .fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fdir-row .fsize { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
#file-viewer { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#file-viewer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
.fpath { flex: 1; min-width: 0; font-size: 12px; font-family: ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#file-editor {
  flex: 1;
  min-height: 0;
  resize: none;
  border: none;
  outline: none;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  padding: 12px;
  white-space: pre;
}
#file-viewer-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
  padding-bottom: calc(8px + var(--footer-safe));
}
.finfo { flex: 1; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.save-btn {
  padding: 7px 18px;
  border-radius: var(--radius-sm);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 13px;
}
.save-btn:disabled { opacity: 0.4; }

/* ---------- 设置页 ---------- */
#settings-tabs {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  overflow-x: auto;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
  scrollbar-width: none;
}
#settings-tabs::-webkit-scrollbar { display: none; }
.set-tab {
  padding: 5px 14px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--vscode-foreground);
  background: var(--vscode-button-secondaryBackground);
  white-space: nowrap;
  flex-shrink: 0;
}
.set-tab:active { background: var(--vscode-button-secondaryHoverBackground); }
.set-tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
#settings-scroll { flex: 1; min-height: 0; overflow-y: auto; }
#settings-sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
}
.card {
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: 12px;
}
.card h3 {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 10px;
}
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  font-size: 13px;
}
.set-row + .set-row { border-top: 1px solid rgba(128, 128, 128, 0.1); }
.set-note { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
.set-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  font-size: 13px;
}
.set-field + .set-field { border-top: 1px solid rgba(128, 128, 128, 0.1); }
.set-field .k { flex: 1 1 100%; color: var(--vscode-foreground); }
.set-field .ctl { flex: 1 1 100%; display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 关键修复：select/input 宽度正常、箭头完整（不再被挤压变形） */
.set-field select, .set-field input[type="text"], .set-field input[type="number"],
.set-field input[type="password"], .set-field textarea {
  width: 100%;
  min-width: 160px;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 13px;
  padding: 8px 10px;
}
.set-field select {
  -webkit-appearance: none;
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--vscode-foreground) 50%),
    linear-gradient(135deg, var(--vscode-foreground) 50%, transparent 50%);
  background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
  background-size: 5px 5px;
  background-repeat: no-repeat;
  padding-right: 28px;
  height: 36px;
}
.set-field textarea { min-height: 80px; resize: vertical; }
.set-field input:focus, .set-field select:focus, .set-field textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
.tgl { position: relative; display: inline-block; width: 38px; height: 20px; flex-shrink: 0; }
.tgl input { opacity: 0; width: 0; height: 0; }
.tgl .tr {
  position: absolute;
  inset: 0;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 999px;
  transition: background 0.15s;
}
.tgl .tr::before {
  content: "";
  position: absolute;
  width: 14px;
  height: 14px;
  left: 2px;
  top: 2px;
  border-radius: 50%;
  background: var(--vscode-foreground);
  transition: transform 0.15s;
}
.tgl input:checked + .tr { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
.tgl input:checked + .tr::before { transform: translateX(18px); background: #ffffff; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: var(--radius-md);
  padding: 3px 8px;
  font-size: 12px;
}
.chip button { color: inherit; font-size: 13px; line-height: 1; padding: 0 2px; opacity: 0.7; }
.chip-input { display: flex; gap: 6px; width: 100%; margin-top: 4px; }
.chip-input input { flex: 1; }
.item-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}
.item-row + .item-row { border-top: 1px solid rgba(128, 128, 128, 0.1); }
.item-row .t { flex: 1; min-width: 0; }
.item-row .name { font-size: 13px; }
.item-row .sub { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.info-text { font-size: 12.5px; color: var(--vscode-descriptionForeground); }
/* V4 设置页补充：多选列表 / chips 删除钮 / 模型管理 / 弱化文字 */
.checklist { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.chk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  padding: 3px 0;
  cursor: pointer;
}
.chk-row input { accent-color: var(--vscode-button-background); }
.chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 2px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  line-height: 1;
  color: inherit;
  opacity: 0.7;
}
.chip-x:active { background: rgba(0, 0, 0, 0.2); opacity: 1; }
.model-list { display: flex; flex-direction: column; gap: 2px; width: 100%; max-height: 40dvh; overflow-y: auto; }
.model-list .item-row .t { flex: 1; }
.dim { color: var(--vscode-descriptionForeground); font-size: 12px; }
.hint-sm {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--vscode-descriptionForeground);
}
.settings-sec { scroll-margin-top: 8px; }

/* 渠道管理 */
.cfg-item { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-md); padding: 10px 12px; margin-bottom: 10px; background: var(--vscode-sideBar-background); }
.cfg-item .cname { font-size: 13.5px; font-weight: 600; }
.cfg-item .cmodel { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 2px 0 6px; }
.cfg-item .mchips { display: flex; flex-wrap: wrap; gap: 6px; }
.cfg-item .mchip {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11.5px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cfg-item .mchip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.cfg-item .mchip:disabled { opacity: 0.9; }
.cfg-item .mchip:not(:disabled):active { background: var(--vscode-button-hoverBackground); }
.cfg-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.cfg-actions .mini-btn { flex-shrink: 0; }
.cfg-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.cfg-card-head h3 { margin: 0; flex: 1; }
.add-channel-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px dashed var(--vscode-focusBorderSoft);
  border-radius: var(--radius-md);
  color: var(--vscode-textLink-foreground);
  font-size: 13px;
  width: 100%;
  justify-content: center;
}
.add-channel-btn svg { width: 14px; height: 14px; }
.add-channel-btn:active { background: var(--vscode-list-hoverBackground); }

/* 抽屉（会话侧栏） */
#drawer { position: fixed; inset: 0; z-index: 30; pointer-events: none; }
.drawer-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); opacity: 0; transition: opacity 0.2s; pointer-events: none; }
.drawer-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(84vw, 340px);
  background: var(--vscode-sideBar-background);
  display: flex;
  flex-direction: column;
  transform: translateX(-100%);
  transition: transform 0.22s;
  box-shadow: 2px 0 12px var(--vscode-widget-shadow);
  z-index: 1;
}
#drawer.open { pointer-events: auto; }
#drawer.open .drawer-backdrop { opacity: 1; pointer-events: auto; }
#drawer.open .drawer-panel { transform: none; }
.drawer-head { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.drawer-title { flex: 1; font-size: 14px; font-weight: 600; }
.drawer-list { flex: 1; min-height: 0; overflow-y: auto; }
.conv-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  font-size: 13px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}
.conv-item:active { background: var(--vscode-list-hoverBackground); }
.conv-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.conv-item .cv-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv-item .cv-meta { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.conv-item.active .cv-meta { color: rgba(255, 255, 255, 0.8); }
.conv-item .icon-btn { width: 26px; height: 26px; }
.conv-item .icon-btn svg { width: 14px; height: 14px; }
/* V4 抽屉列表：conv-main 主按钮 + 标题/副标题 + 更多操作 */
.conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
  text-align: left;
  color: inherit;
}
.conv-title {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-sub {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.conv-item.active .conv-sub { color: rgba(255, 255, 255, 0.8); }
.conv-more { flex-shrink: 0; }
.load-more-btn {
  display: block;
  width: 100%;
  padding: 12px;
  font-size: 12.5px;
  color: var(--vscode-textLink-foreground);
  text-align: center;
}
.load-more-btn:active { background: var(--vscode-list-hoverBackground); }
.conv-load-more { padding: 12px; text-align: center; }
.conv-empty { padding: 30px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12.5px; }

/* 底部导航 */
#tabbar {
  display: flex;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
  flex-shrink: 0;
  padding-bottom: var(--footer-safe);
}
#tabbar button {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 7px 0 5px;
  font-size: 10.5px;
  color: var(--vscode-tab-inactiveForeground);
}
#tabbar button svg { width: 20px; height: 20px; }
#tabbar button.active { color: var(--vscode-tab-activeForeground); }
#tabbar button:active { background: var(--vscode-list-hoverBackground); }

/* ================= 底部弹层 ================= */
#sheet { position: fixed; inset: 0; z-index: 40; pointer-events: none; }
#sheet .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); opacity: 0; transition: opacity 0.2s; pointer-events: none; }
#sheet .panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 78dvh;
  background: var(--vscode-editorWidget-background);
  border-top: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  transform: translateY(100%);
  transition: transform 0.22s;
  display: flex;
  flex-direction: column;
  z-index: 1;
}
#sheet.open { pointer-events: auto; }
#sheet.open .backdrop { opacity: 1; pointer-events: auto; }
#sheet.open .panel { transform: none; }
#sheet .head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
#sheet .head b { flex: 1; font-size: 14px; }
#sheet .list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0; }
.sheet-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 13px 16px;
  font-size: 13.5px;
  text-align: left;
  color: var(--vscode-foreground);
}
.sheet-item:active { background: var(--vscode-list-hoverBackground); }
.sheet-item.selected { color: var(--vscode-textLink-foreground); }
.sheet-item .si-sub { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.sheet-item .si-check { margin-left: auto; color: var(--vscode-textLink-foreground); flex-shrink: 0; }
.sheet-item .si-check svg { width: 15px; height: 15px; }
.sheet-hint { padding: 14px 16px; font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
.sheet-actions { display: flex; gap: 10px; padding: 10px 14px calc(10px + var(--footer-safe)); border-top: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
.sheet-actions .btn { flex: 1; }

/* 模型选择器分组 */
.model-group { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 8px 16px 4px; text-transform: uppercase; letter-spacing: 0.5px; }

/* ================= 消息操作弹层 ================= */
#action-sheet { position: fixed; inset: 0; z-index: 45; pointer-events: none; }
#action-sheet .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); opacity: 0; transition: opacity 0.2s; pointer-events: none; }
#action-sheet .panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--vscode-editorWidget-background);
  border-top: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  transform: translateY(100%);
  transition: transform 0.22s;
  padding: 6px 0 calc(6px + var(--footer-safe));
  z-index: 1;
}
#action-sheet.open { pointer-events: auto; }
#action-sheet.open .backdrop { opacity: 1; pointer-events: auto; }
#action-sheet.open .panel { transform: none; }
.act-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 18px;
  font-size: 14px;
  text-align: left;
  color: var(--vscode-foreground);
}
.act-btn:active { background: var(--vscode-list-hoverBackground); }
.act-btn svg { width: 17px; height: 17px; color: var(--vscode-icon-foreground); }
.act-btn.danger { color: var(--vscode-errorForeground); }
.act-btn.danger svg { color: var(--vscode-errorForeground); }

/* ================= 对话框 ================= */
#modal { position: fixed; inset: 0; z-index: 50; pointer-events: none; }
#modal .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); opacity: 0; transition: opacity 0.18s; pointer-events: none; }
#modal .box {
  position: absolute;
  left: 50%;
  top: 45%;
  transform: translate(-50%, -50%) scale(0.95);
  width: min(88vw, 380px);
  max-height: 80dvh;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 8px 30px var(--vscode-widget-shadow);
  opacity: 0;
  transition: opacity 0.18s, transform 0.18s;
  z-index: 1;
}
#modal.open { pointer-events: auto; }
#modal.open .backdrop { opacity: 1; pointer-events: auto; }
#modal.open .box { opacity: 1; transform: translate(-50%, -50%); }
#modal-title { padding: 14px 16px 0; font-size: 14px; font-weight: 600; }
#modal-body { padding: 10px 16px 0; font-size: 13px; color: var(--vscode-foreground); overflow-y: auto; }
#modal-input {
  width: 100%;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 13px;
  padding: 10px;
  min-height: 42px;
  resize: none;
}
#modal-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
#modal-actions { display: flex; gap: 10px; padding: 14px 16px calc(14px + var(--footer-safe)); }
#modal-actions .btn { flex: 1; }

/* ================= 轻提示 ================= */
#toast {
  position: fixed;
  left: 50%;
  bottom: calc(var(--tabbar-h) + var(--footer-safe) + 18px);
  transform: translateX(-50%) translateY(8px);
  max-width: 86vw;
  padding: 9px 18px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px var(--vscode-widget-shadow);
  font-size: 12.5px;
  opacity: 0;
  transition: opacity 0.2s, transform 0.2s;
  pointer-events: none;
  z-index: 60;
  text-align: center;
}
#toast.show { opacity: 1; transform: translateX(-50%); }

/* 连接断开横幅 */
.conn-banner {
  position: sticky;
  top: 0;
  z-index: 10;
  background: color-mix(in srgb, var(--vscode-terminal-ansiRed) 15%, transparent);
  color: var(--vscode-errorForeground);
  font-size: 12px;
  text-align: center;
  padding: 6px 10px;
}

/* 全局致命错误横幅（脚本 showFatal 写入，固定顶部、最高层级、不遮挡交互） */
#error-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 70;
  background: var(--vscode-terminal-ansiRed);
  color: #ffffff;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  padding: 8px 12px;
  pointer-events: none;
  box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  word-break: break-word;
}
`;
