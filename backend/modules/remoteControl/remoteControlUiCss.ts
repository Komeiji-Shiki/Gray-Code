/**
 * remoteControlUiCss.ts
 *
 * 远程控制 UI 样式（桌面版 VS Code Dark+ 对齐重写）。
 *
 * 设计对齐桌面端（VS Code Dark+ 主题令牌 + 桌面端组件实测数值）：
 * - 扁平化极小圆角（2-6px）、8pt 间距系统、蓝色 #3794ff 主题强调；
 * - 桌面版三段式布局：顶栏 46px + 会话页签条 32px + 消息区 + 底部输入区；
 * - 文件/设置均为全屏侧滑面板（#panel-files / #panel-settings），设置面板左栏分类导航 + 右侧卡片表单；
 * - 消息：用户淡蓝底 color-mix(6%)、助手扁平列表、工具卡/思考卡/附件占位卡片；
 * - 输入区：四选择器（InputSelectorBar 同款触发按钮）+ 输入框 + 发送按钮；
 * - 全部图标内嵌 SVG（无字体/emoji 依赖）。
 */

export const REMOTE_UI_CSS = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, "Courier New", monospace;
  --vscode-foreground: #cccccc;
  --vscode-disabledForeground: rgba(204, 204, 204, 0.5);
  --vscode-errorForeground: #f48771;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-icon-foreground: #c5c5c5;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-editor-inactiveSelectionBackground: #3a3d41;
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
  --vscode-input-placeholderForeground: #a6a6a6;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-inputValidation-warningForeground: #f9c74f;
  --vscode-panel-background: #1e1e1e;
  --vscode-panel-border: #454545;
  --vscode-sideBar-background: #252526;
  --vscode-sideBar-foreground: #cccccc;
  --vscode-tab-activeBackground: #1e1e1e;
  --vscode-tab-inactiveBackground: #2d2d2d;
  --vscode-tab-activeForeground: #ffffff;
  --vscode-tab-inactiveForeground: #969696;
  --vscode-tab-hoverBackground: #2d2d2d;
  --vscode-tab-activeBorderTop: #0078d4;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #094771;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-editorGroupHeader-tabsBackground: #252526;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
  --vscode-textLink-foreground: #3794ff;
  --vscode-textBlockQuote-background: rgba(127, 127, 127, 0.1);
  --vscode-charts-blue: #3794ff;
  --vscode-charts-green: #89d185;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-red: #f14c4c;
  --vscode-testing-iconPassed: #73c991;
  --vscode-testing-iconFailed: #f14c4c;
  --vscode-testing-runAction: #3794ff;
  --vscode-progressBar-background: #0e70c0;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-checkbox-background: #3c3c3c;
  --vscode-checkbox-border: #3c3c3c;
  --vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.31);
  --vscode-toolbar-activeBackground: rgba(99, 102, 103, 0.31);
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 6px;
  --header-h: 46px;
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
    --vscode-editor-inactiveSelectionBackground: #ececec;
    --vscode-panel-background: #ffffff;
    --vscode-panel-border: #e0e0e0;
    --vscode-sideBar-background: #f3f3f3;
    --vscode-sideBar-foreground: #383a42;
    --vscode-tab-activeBackground: #ffffff;
    --vscode-tab-inactiveBackground: #ececec;
    --vscode-tab-activeForeground: #1f1f1f;
    --vscode-tab-inactiveForeground: rgba(31, 31, 31, 0.7);
    --vscode-tab-hoverBackground: #e8e8e8;
    --vscode-list-hoverBackground: #f0f0f0;
    --vscode-list-activeSelectionBackground: #0060c0;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-editorGroupHeader-tabsBackground: #ececec;
    --vscode-editorWidget-background: #f3f3f3;
    --vscode-editorWidget-border: #c8c8c8;
    --vscode-dropdown-background: #ffffff;
    --vscode-dropdown-foreground: #1f1f1f;
    --vscode-dropdown-border: #c8c8c8;
    --vscode-input-background: #ffffff;
    --vscode-input-foreground: #1f1f1f;
    --vscode-input-border: #c8c8c8;
    --vscode-input-placeholderForeground: rgba(31, 31, 31, 0.4);
    --vscode-inputValidation-errorBackground: #f2dede;
    --vscode-inputValidation-errorBorder: #cd3131;
    --vscode-inputValidation-warningBackground: #fdf6d8;
    --vscode-inputValidation-warningBorder: #949800;
    --vscode-button-background: #0e639c;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-secondaryBackground: #e4e4e4;
    --vscode-button-secondaryForeground: #1f1f1f;
    --vscode-button-secondaryHoverBackground: #d4d4d4;
    --vscode-textLink-foreground: #006ab1;
    --vscode-textBlockQuote-background: rgba(127, 127, 127, 0.1);
    --vscode-charts-blue: #006ab1;
    --vscode-charts-green: #137a00;
    --vscode-charts-yellow: #949800;
    --vscode-charts-red: #cd3131;
    --vscode-testing-iconPassed: #1d7f3a;
    --vscode-testing-iconFailed: #cd3131;
    --vscode-testing-runAction: #006ab1;
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
  overflow-x: hidden;
}
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  line-height: 1.5;
  color: var(--vscode-foreground);
  background: var(--vscode-panel-background);
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  -webkit-user-select: none;
}
input, textarea, .editable { user-select: text; -webkit-user-select: text; }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
svg { display: block; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

#app {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 100dvh;
}

/* ================= 顶栏（46px） ================= */
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
  transition: background-color 0.15s;
}
.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-btn:active { background: var(--vscode-toolbar-hoverBackground); }
.icon-btn svg { width: 18px; height: 18px; }
/* 右侧按钮组（文件 / 设置 / 刷新）随 flex 标题自动右对齐 */
#btn-files, #btn-settings, #btn-refresh { flex-shrink: 0; }
.title-wrap { flex: 1; min-width: 0; }
#title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 0; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.ok { background: var(--vscode-testing-iconPassed); }
.dot.err { background: var(--vscode-testing-iconFailed); }
.dot.busy { background: var(--vscode-charts-yellow); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: 0.4; } }
#status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ================= 会话页签条（桌面端 ConversationTabs 同款：32px、2px 下划线） ================= */
#tabs-bar {
  display: flex;
  align-items: stretch;
  min-height: 32px;
  max-height: 32px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
  overflow: hidden;
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
.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 160px;
  min-width: 0;
  padding: 0 4px 0 10px;
  font-size: 11px;
  color: var(--vscode-tab-inactiveForeground);
  opacity: 0.7;
  background: transparent;
  border-right: 1px solid var(--vscode-panel-border);
  white-space: nowrap;
  flex-shrink: 0;
  transition: opacity 0.1s, background-color 0.1s;
}
.tab:hover { background: var(--vscode-tab-hoverBackground); }
.tab:active { opacity: 1; background: var(--vscode-tab-hoverBackground); }
.tab.active {
  opacity: 1;
  background: var(--vscode-tab-activeBackground);
  color: var(--vscode-tab-activeForeground);
}
.tab.active::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--vscode-tab-activeBorderTop);
}
.tab.streaming {
  color: var(--vscode-tab-activeForeground);
}
.tab.streaming:not(.active) { background: color-mix(in srgb, var(--vscode-progressBar-background) 8%, transparent); }
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
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  font-size: 15px;
  line-height: 1;
  color: var(--vscode-icon-foreground);
  opacity: 0.5;
  flex-shrink: 0;
}
.tab:hover .tab-close, .tab.active .tab-close { opacity: 1; }
.tab .tab-close:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.tab .tab-close:active { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.tab .tab-close svg { width: 12px; height: 12px; }
.tab-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  min-width: 28px;
  height: 100%;
  flex-shrink: 0;
  color: var(--vscode-icon-foreground);
  opacity: 0.6;
  font-size: 18px;
  font-weight: 600;
  transition: opacity 0.1s, background-color 0.1s;
}
.tab-add:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.tab-add:active { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.tab-add svg { width: 15px; height: 15px; }
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

/* ================= 主视图 ================= */
#views { flex: 1; min-height: 0; display: flex; }
.view { flex: 1; min-width: 0; display: flex; flex-direction: column; }
#view-chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ---------- 消息列表（桌面端 MessageItem：16px padding、用户淡蓝底、扁平分隔） ---------- */
#messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding-bottom: 8px;
}
.msg {
  padding: 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 13px;
  line-height: 1.65;
  word-break: break-word;
}
.msg:last-child { border-bottom: none; }
.msg.user { background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent); }
.msg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; }
.msg-role {
  font-weight: 600;
  color: var(--vscode-foreground);
}
.msg-role.assistant { color: var(--vscode-descriptionForeground); }
.msg-role.tool { color: var(--vscode-charts-blue); }
.msg-model { color: var(--vscode-descriptionForeground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-time { color: var(--vscode-descriptionForeground); margin-left: auto; flex-shrink: 0; font-size: 11px; opacity: 0.7; }
.msg-content { font-size: 13px; }
.msg-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; opacity: 0.5; }
.msg:hover .msg-actions, .msg:active .msg-actions { opacity: 1; }
.msg-actions .mini-btn { padding: 3px 8px; min-height: 24px; }
.msg-actions .mini-btn svg { width: 13px; height: 13px; }
.msg-content p { margin: 6px 0; }
.msg-content p:first-child { margin-top: 0; }
.msg-content p:last-child { margin-bottom: 0; }
.msg-content pre {
  background: var(--vscode-textCodeBlock-background, rgba(10, 10, 10, 0.4));
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  line-height: 1.5;
  margin: 8px 0;
}
.msg-content code {
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.15));
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
.msg-content h1, .msg-content h2, .msg-content h3 { margin: 10px 0 6px; line-height: 1.3; }
.markdown h4, .markdown h5, .markdown h6 {
  margin: 8px 0 6px;
  font-size: 13px;
  font-weight: 600;
}
.markdown ul, .markdown ol { margin: 6px 0; padding-left: 22px; }
.markdown li { margin: 2px 0; }
.markdown pre, .markdown code { font-family: var(--vscode-editor-font-family); }
.md-spacer { height: 8px; }
.caret { display: inline-block; width: 7px; height: 14px; background: var(--vscode-progressBar-background); animation: blink 1s steps(1) infinite; vertical-align: text-bottom; }
@keyframes blink { 50% { opacity: 0; } }
.empty-part { color: var(--vscode-disabledForeground); }

/* ---------- 工具卡（桌面端 ToolMessage 同款：1px 边框、2px 圆角、可展开 JSON） ---------- */
.tool-card, .tool-result-card {
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  margin: 6px 0;
}
.tool-card.rejected { opacity: 0.7; }
.tool-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background-color 0.15s;
}
.tool-card-head:hover { background: var(--vscode-list-hoverBackground); }
.tool-card-head:active { background: var(--vscode-list-hoverBackground); }
.tc-chev { width: 12px; height: 12px; color: var(--vscode-descriptionForeground); flex-shrink: 0; transition: transform 0.15s; }
.tc-chev.open { transform: rotate(90deg); }
.tc-ico { width: 14px; height: 14px; color: var(--vscode-charts-blue); flex-shrink: 0; }
.tc-ico.result { color: var(--vscode-testing-iconPassed); }
.tc-name { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-state { margin-left: auto; font-size: 11px; flex-shrink: 0; }
.tc-state.ok { color: var(--vscode-testing-iconPassed); }
.tc-state.rejected { color: var(--vscode-testing-iconFailed); }
.tool-card-body {
  padding: 4px 8px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-inactiveSelectionBackground);
}
.tc-section { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
.tc-sec-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground);
}
.tool-card-body pre {
  padding: 4px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  white-space: pre;
  overflow-x: auto;
  margin: 0;
}
.tool-result-pre {
  font-size: 11px;
  line-height: 1.4;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow: auto;
  margin: 4px 0;
}

/* ---------- 思考块（桌面端 MessageRenderBlock thought-block 同款） ---------- */
.thought-block {
  margin: 8px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  background: var(--vscode-textBlockQuote-background);
  overflow: hidden;
}
.thought-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: background-color 0.15s;
}
.thought-head:hover { background: var(--vscode-list-hoverBackground); }
.thought-head:active { background: var(--vscode-list-hoverBackground); }
.th-chev { width: 12px; height: 12px; color: var(--vscode-descriptionForeground); flex-shrink: 0; transition: transform 0.15s; }
.th-chev.open { transform: rotate(90deg); }
.th-bulb { width: 14px; height: 14px; color: var(--vscode-charts-yellow); flex-shrink: 0; }
.th-label { font-size: 12px; font-weight: 500; font-style: italic; color: var(--vscode-descriptionForeground); }
.thought-body { padding: 12px; max-height: 15em; overflow-y: auto; }
.thought-body .markdown {
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
  word-break: break-word;
}

/* ---------- 附件占位（消息数对齐桌面端，元数据渲染） ---------- */
.msg-attachments {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0;
}
.att-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--vscode-list-hoverBackground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
}
.att-ico { width: 18px; height: 18px; color: var(--vscode-icon-foreground); flex-shrink: 0; }
.att-ico.image { color: var(--vscode-charts-blue); }
.att-name { font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; flex-direction: column; }
.att-mime { font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ---------- 流式工具指示 ---------- */
.stream-tools { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: var(--radius-md);
  padding: 2px 8px;
  font-size: 11px;
}
.tool-chip svg { width: 12px; height: 12px; }

.err-box {
  margin: 10px 16px;
  padding: 10px 12px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: var(--radius-md);
  font-size: 12.5px;
  color: var(--vscode-errorForeground);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.err-box .mini-btn { flex-shrink: 0; }

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
.confirm-box {
  margin: 6px 12px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: var(--radius-md);
}
.confirm-item {
  padding: 4px 0;
  font-size: 12.5px;
  font-family: var(--vscode-editor-font-family);
  word-break: break-all;
}
.confirm-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; color: var(--vscode-inputValidation-warningForeground); }
.confirm-title svg { width: 14px; height: 14px; }
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
  transition: background-color 0.15s;
}
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn:active { background: var(--vscode-button-hoverBackground); }
.btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn.secondary:active { background: var(--vscode-button-secondaryHoverBackground); }
.btn.danger { background: var(--vscode-testing-iconFailed); color: #ffffff; }
.btn:disabled { opacity: 0.4; }
.btn svg { width: 15px; height: 15px; }

/* ---------- 输入区（桌面端 InputArea/InputSelectorBar 同款） ---------- */
footer.composer {
  flex-shrink: 0;
  background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border);
  padding: 8px;
  padding-bottom: calc(8px + var(--footer-safe));
}
/* 选择器行：模式 / 渠道 / 模型 / 思考强度（桌面端 InputSelectorBar：触发按钮 + 竖分隔） */
#composer-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 4px;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid var(--vscode-panel-border);
  margin-bottom: 8px;
}
#composer-meta::-webkit-scrollbar { display: none; }
.sel-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-md);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 150px;
  transition: border-color 0.15s;
}
.sel-chip:hover { border-color: var(--vscode-focusBorder); }
.sel-chip:active { border-color: var(--vscode-focusBorder); }
.sel-chip .sel-label { color: var(--vscode-descriptionForeground); }
.sel-chip .sel-value { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sel-chip .sel-arrow { width: 12px; height: 12px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
#input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
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
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-foreground);
  flex-shrink: 0;
  transition: background-color 0.15s;
}
#send:hover { background: var(--vscode-toolbar-hoverBackground); }
#send:active { background: var(--vscode-toolbar-hoverBackground); }
#send:disabled { opacity: 0.3; }
#send svg { width: 16px; height: 16px; }
#send.stop { color: var(--vscode-testing-iconFailed); }

/* ================= 全屏面板（文件 / 设置：fixed 覆盖、右侧滑入） ================= */
#panel-files, #panel-settings {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: var(--vscode-sideBar-background);
  transform: translateX(100%);
  transition: transform 0.22s ease;
}
#panel-files.open, #panel-settings.open { transform: translateX(0); }
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
.panel-back-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--vscode-icon-foreground);
  flex-shrink: 0;
  transition: background-color 0.15s;
}
.panel-back-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.panel-back-btn:active { background: var(--vscode-toolbar-hoverBackground); }
.panel-back-btn svg { width: 18px; height: 18px; }
.panel-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
#panel-files .panel-body { flex-direction: column; }

/* ---------- 文件面板 ---------- */
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
/* 工作区文字按钮（"切换工作区" / "新增工作区"） */
#btn-ws-switch, #btn-ws-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 10px;
  min-height: 28px;
  border: 1px solid var(--vscode-button-secondaryBackground);
  border-radius: var(--radius-sm);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 0.15s;
}
#btn-ws-switch:hover, #btn-ws-add:hover { background: var(--vscode-button-secondaryHoverBackground); }
#btn-ws-switch:active, #btn-ws-add:active { background: var(--vscode-button-secondaryHoverBackground); }
#btn-ws-switch svg, #btn-ws-add svg { width: 13px; height: 13px; }
.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 10px;
  border: 1px solid var(--vscode-button-secondaryBackground);
  border-radius: var(--radius-sm);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 12px;
  flex-shrink: 0;
  min-height: 28px;
  transition: background-color 0.15s;
}
.mini-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.mini-btn:active { background: var(--vscode-button-secondaryHoverBackground); }
.mini-btn.danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--vscode-testing-iconFailed) 45%, transparent);
  color: var(--vscode-errorForeground);
}
#file-tree { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0; }
.fdir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 14px;
  font-size: 13px;
  text-align: left;
  color: var(--vscode-foreground);
}
.fdir-row:hover { background: var(--vscode-list-hoverBackground); }
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
.fpath { flex: 1; min-width: 0; font-size: 12px; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#file-editor {
  flex: 1;
  min-height: 0;
  resize: none;
  border: none;
  outline: none;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family);
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
  padding: 6px 16px;
  border-radius: var(--radius-sm);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 13px;
  transition: background-color 0.15s;
}
.save-btn:hover { background: var(--vscode-button-hoverBackground); }
.save-btn:active { background: var(--vscode-button-hoverBackground); }
.save-btn:disabled { opacity: 0.4; }

/* ---------- 设置面板（桌面端 SettingsPanel：左栏分类导航 + 右侧卡片表单） ---------- */
#settings-nav {
  width: 132px;
  flex-shrink: 0;
  border-right: 1px solid var(--vscode-panel-border);
  overflow-y: auto;
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--vscode-sideBar-background);
}
.set-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-lg);
  font-size: 12px;
  color: var(--vscode-foreground);
  background: transparent;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 0.15s, color 0.15s;
}
/* 纵向布局：左栏分类导航中按钮占满整行 */
#settings-nav .set-tab {
  width: 100%;
  justify-content: flex-start;
  text-align: left;
}
.set-tab:hover { background: var(--vscode-list-hoverBackground); }
.set-tab:active { background: var(--vscode-list-hoverBackground); }
.set-tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
#settings-scroll { flex: 1; min-height: 0; overflow-y: auto; }
#settings-sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
}
/* 兼容旧结构：设置分类横向页签条不再使用，一律隐藏（由 #settings-nav 接管） */
#settings-tabs { display: none; }
.card {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-lg);
  padding: 12px;
}
.card h3 {
  font-size: 14px;
  font-weight: 500;
  color: var(--vscode-foreground);
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
.set-row + .set-row { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 40%, transparent); }
.set-note { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
.set-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 13px;
}
.set-field + .set-field { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 40%, transparent); }
.set-field .k { flex: 1 1 100%; color: var(--vscode-foreground); font-size: 12px; font-weight: 500; }
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
  padding: 7px 10px;
  transition: border-color 0.15s;
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
  height: 34px;
}
.set-field textarea { min-height: 80px; resize: vertical; }
.set-field input:focus, .set-field select:focus, .set-field textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
/* toggle 开关（iOS 风格滑块，与桌面端 toggle-switch 语义一致） */
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
  padding: 2px 8px;
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
.item-row + .item-row { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 40%, transparent); }
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

/* ---------- 渠道编辑弹窗子菜单（ch-tabs / ch-pane） ---------- */
.ch-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--vscode-panel-border);
  margin-bottom: 10px;
}
.ch-tab {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 2px solid transparent;
  background: transparent;
  transition: color 0.15s, border-color 0.15s;
}
.ch-tab:hover { color: var(--vscode-foreground); }
.ch-tab.active {
  border-bottom: 2px solid var(--vscode-tab-activeBorderTop);
  color: var(--vscode-foreground);
}
.ch-pane { display: none; }
.ch-pane.active { display: block; }

/* ---------- 用量统计卡（stat-grid / stat-card） ---------- */
.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.stat-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  background: var(--vscode-editor-background);
}
.stat-num { font-size: 18px; font-weight: 600; line-height: 1.3; }
.stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ---------- 记忆条目（mem-item / mem-add-row） ---------- */
.mem-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}
.mem-item:last-child { border-bottom: none; }
.mem-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  max-height: 60px;
  overflow: hidden;
  word-break: break-word;
}
.mem-date { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.mem-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 8px;
  min-height: 24px;
  border: 1px solid color-mix(in srgb, var(--vscode-testing-iconFailed) 45%, transparent);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-errorForeground);
  font-size: 11.5px;
  flex-shrink: 0;
}
.mem-del:hover { background: var(--vscode-list-hoverBackground); }
.mem-del:active { background: var(--vscode-list-hoverBackground); }
.mem-del svg { width: 13px; height: 13px; }
.mem-add-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.mem-add-row input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 13px;
  padding: 7px 10px;
}
.mem-add-row input:focus { outline: none; border-color: var(--vscode-focusBorder); }

/* ---------- 设置分组标题 / 分隔线 ---------- */
.group-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
  margin: 14px 0 6px;
}
.group-desc {
  font-size: 11.5px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
  margin: 0 0 8px;
}
.sec-divider {
  height: 1px;
  background: var(--vscode-panel-border);
  margin: 10px 0;
  border: none;
}

/* ---------- 渠道管理（桌面端 ChannelSettings 卡片风格） ---------- */
.cfg-item { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-md); padding: 10px 12px; margin-bottom: 10px; background: var(--vscode-editor-background); }
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
.cfg-item .mchip:not(:disabled):hover { background: var(--vscode-button-hoverBackground); }
.cfg-item .mchip:not(:disabled):active { background: var(--vscode-button-hoverBackground); }
.cfg-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.cfg-actions .mini-btn { flex-shrink: 0; }
.cfg-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.cfg-card-head h3 { margin: 0; flex: 1; }
.add-channel-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px dashed var(--vscode-focusBorder);
  border-radius: var(--radius-md);
  color: var(--vscode-textLink-foreground);
  font-size: 13px;
  width: 100%;
  transition: background-color 0.15s;
}
.add-channel-btn svg { width: 14px; height: 14px; }
.add-channel-btn:hover { background: var(--vscode-list-hoverBackground); }
.add-channel-btn:active { background: var(--vscode-list-hoverBackground); }

/* 抽屉（会话侧栏，桌面端 ConversationList 风格） */
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
.drawer-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.drawer-title { flex: 1; font-size: 14px; font-weight: 500; }
.drawer-list { flex: 1; min-height: 0; overflow-y: auto; }
.conv-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--vscode-panel-border);
  transition: background-color 0.1s;
}
.conv-item:hover { background: var(--vscode-list-hoverBackground); }
.conv-item:active { background: var(--vscode-list-hoverBackground); }
.conv-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  text-align: left;
  color: inherit;
}
.conv-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-sub {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  display: flex;
  gap: 8px;
}
.conv-item.active .conv-sub { color: rgba(255, 255, 255, 0.8); }
.conv-more { flex-shrink: 0; width: 26px; height: 26px; }
.conv-more svg { width: 14px; height: 14px; }
.load-more-btn {
  display: block;
  width: 100%;
  padding: 12px;
  font-size: 12.5px;
  color: var(--vscode-textLink-foreground);
  text-align: center;
}
.load-more-btn:hover { background: var(--vscode-list-hoverBackground); }
.load-more-btn:active { background: var(--vscode-list-hoverBackground); }
.conv-empty { padding: 32px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12.5px; }

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
#sheet .head b { flex: 1; font-size: 14px; font-weight: 500; }
#sheet .list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0; }
.sheet-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 16px;
  font-size: 13.5px;
  text-align: left;
  color: var(--vscode-foreground);
  transition: background-color 0.1s;
}
.sheet-item:hover { background: var(--vscode-list-hoverBackground); }
.sheet-item:active { background: var(--vscode-list-hoverBackground); }
.sheet-item.selected { color: var(--vscode-textLink-foreground); }
.sheet-item .si-sub { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.sheet-item .si-check { margin-left: auto; color: var(--vscode-textLink-foreground); flex-shrink: 0; }
.sheet-item .si-check svg { width: 15px; height: 15px; }
.sheet-hint { padding: 14px 16px; font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
.sheet-actions { display: flex; gap: 10px; padding: 10px 14px calc(10px + var(--footer-safe)); border-top: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
.sheet-actions .btn { flex: 1; }

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
.act-btn:hover { background: var(--vscode-list-hoverBackground); }
.act-btn:active { background: var(--vscode-list-hoverBackground); }
.act-btn svg { width: 17px; height: 17px; color: var(--vscode-icon-foreground); }
.act-btn.danger { color: var(--vscode-errorForeground); }
.act-btn.danger svg { color: var(--vscode-errorForeground); }

/* ================= 对话框（桌面端 Modal 同款） ================= */
#modal { position: fixed; inset: 0; z-index: 50; pointer-events: none; }
#modal .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); opacity: 0; transition: opacity 0.18s; pointer-events: none; }
#modal .box {
  position: absolute;
  left: 50%;
  top: 45%;
  transform: translate(-50%, -50%) scale(0.95);
  width: min(88vw, 380px);
  max-height: 80dvh;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.18s, transform 0.18s;
  z-index: 1;
}
#modal.open { pointer-events: auto; }
#modal.open .backdrop { opacity: 1; pointer-events: auto; }
#modal.open .box { opacity: 1; transform: translate(-50%, -50%); }
#modal-title { padding: 14px 16px 0; font-size: 14px; font-weight: 500; }
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
  bottom: calc(16px + var(--footer-safe));
  transform: translateX(-50%) translateY(8px);
  max-width: 86vw;
  padding: 9px 18px;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
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

/* 全局致命错误横幅（脚本 showFatal 写入，固定顶部、最高层级、不遮挡交互） */
#error-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 70;
  background: var(--vscode-testing-iconFailed);
  color: #ffffff;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  padding: 8px 12px;
  pointer-events: none;
  box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  word-break: break-word;
}

/* ================= 折叠面板（桌面端 advanced-toggle 同款：chevron + 标题 + header toggle） ================= */
.collap {
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
}
.collap:last-child { border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); }
.collap-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 2px;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
  background: transparent;
  border: none;
}
.collap-head:hover { background: var(--vscode-list-hoverBackground); }
.collap-chev { width: 14px; height: 14px; color: var(--vscode-descriptionForeground); flex-shrink: 0; transition: transform 0.15s; }
.collap-chev.open { transform: rotate(90deg); }
.collap-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.collap-body { display: block; padding: 0 2px 6px; }
.collap-body.hidden { display: none; }
.collap-body .set-field + .set-field,
.collap-body .cfg-sub + .set-field,
.collap-body .set-field + .cfg-sub { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 40%, transparent); }
/* 折叠面板内的子分组（高级选项下的思考配置/思考回传等） */
.cfg-sub {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  margin: 8px 0;
  background: var(--vscode-editor-background);
}
.cfg-sub-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
  margin-bottom: 6px;
}
.cfg-sub-title .tgl { margin-left: auto; }
.cfg-sub .set-field .k { font-size: 11.5px; }

/* ================= 渠道页内联设置（桌面端 ChannelSettings 同构：选择器 + 折叠表单） ================= */
#settings-sections .cfg-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
#settings-sections .cfg-selector select {
  flex: 1;
  min-width: 0;
  height: 34px;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 13px;
  padding: 0 10px;
}
.cfg-actions .mini-btn svg { width: 13px; height: 13px; }
.cfg-note { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin-top: 6px; line-height: 1.5; }

/* ================= 提示词条目编辑器（桌面端 PromptEntriesEditor 同款） ================= */
.pe-toolbar { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.pe-toolbar .mini-btn svg { width: 13px; height: 13px; }
.pe-item {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  margin: 8px 0;
  background: var(--vscode-editor-background);
}
.pe-item.pe-chat { border-style: dashed; background: var(--vscode-editor-inactiveSelectionBackground); }
.pe-head { display: flex; align-items: center; gap: 8px; }
.pe-head .tgl { flex-shrink: 0; }
.pe-name { flex: 1; min-width: 0; }
.pe-name input {
  width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  padding: 4px 8px;
}
.pe-name input:focus { outline: none; border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
.pe-role { flex-shrink: 0; }
.pe-role select {
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 11.5px;
  height: 28px;
  padding: 0 6px;
}
.pe-chat-pill {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  padding: 2px 8px;
}
.pe-body { margin-top: 8px; }
.pe-body textarea {
  width: 100%;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 12.5px;
  padding: 7px 10px;
  resize: vertical;
  min-height: 64px;
}
.pe-body textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
.pe-actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.pe-actions .icon-mini { width: 26px; height: 26px; }
.pe-hint { font-size: 11.5px; color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 4px 0; }

/* ================= 图标按钮（设置页操作行） ================= */
.icon-mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--vscode-icon-foreground);
  background: transparent;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 0.15s;
}
.icon-mini svg { width: 14px; height: 14px; }
.icon-mini:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-mini.danger { color: var(--vscode-errorForeground); }
.set-tab { gap: 6px; }
.set-tab svg { width: 13px; height: 13px; flex-shrink: 0; }
.chip-x svg { width: 10px; height: 10px; }

/* ================= 记忆条目编辑 ================= */
.mem-item textarea {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 12.5px;
  padding: 6px 8px;
  resize: vertical;
  min-height: 44px;
}
.mem-item textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
.mem-edit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 8px;
  min-height: 24px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-foreground);
  font-size: 11.5px;
  flex-shrink: 0;
}
.mem-edit-btn:hover { background: var(--vscode-list-hoverBackground); }
.mem-edit-btn svg { width: 13px; height: 13px; }
.mem-scope-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mem-scope-row select {
  flex: 1;
  min-width: 0;
  height: 32px;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 13px;
  padding: 0 10px;
}

/* ================= 用量统计时间范围 ================= */
.usage-range-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.usage-range-row select {
  flex: 1;
  min-width: 0;
  height: 32px;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 13px;
  padding: 0 10px;
}

/* ================= Shell 管理（execute_command） ================= */
.shells-list { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.shell-row { display: flex; align-items: center; gap: 8px; }
.shell-name { font-size: 12px; color: var(--vscode-foreground); min-width: 76px; font-family: var(--vscode-editor-font-family); }
.shell-row .tgl { flex-shrink: 0; }
.shell-row input[type="text"] {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
}
.shell-row input[type="text"]:focus { outline: none; border-color: var(--vscode-focusBorder); }

/* ================= 渠道表单（ch-form） ================= */
.ch-form { margin-bottom: 12px; }
.ch-form .collap .set-field .k { font-size: 12px; }
`;
