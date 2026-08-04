# GrayCode Desktop (Electron 独立版) — 项目交接文档

> **本文档是跨会话交接文档（下次新会话从「第 11 节 本会话（2026-08-04 第二段）」开始）。**
> 任务：为 GrayCode（VS Code AI 编程助手插件 v1.3.1-1）构造一个完全独立于 VS Code
> 的前端，使用 Electron 实现，功能完整复现插件能力、运行流畅，最终作为 GitHub 分发项目交付。
> 成果将被公开评比。

---

## 0. 当前状态快照（2026-08-03 更新）

**全部计划项已闭环** ✅：

| 项 | 状态 |
|---|---|
| 核心功能复现（渠道/对话/工具/diff/MCP/子代理/检查点/设置/用量/工作区） | ✅ E2E 44+ 断言全过 |
| 流畅度（启动 TTI ~1.4s、零 long task、零渲染错误） | ✅ UISMOKE 实测 |
| 汉英日三语 UI + 顶部栏（新建标签/语言/设置齿轮） | ✅ |
| 首次运行引导（API Key 引导 + 无工作区提示） | ✅ |
| README（中英双语）+ CI（三平台 workflow）+ .gitignore | ✅ |
| 打包（win NSIS/zip + win-unpacked 全部验证） | ✅ 103MB / 143MB 产物 |
| 剩余工作 | 见第 8 节（仅剩：首次 push GitHub 后确认 CI 三平台绿；本机 release/ 目录解锁清理） |

---

## 1. 项目需求（用户原话要点，含历次补充）

1. 为 GrayCode VS Code 插件构造**完全独立**的前端，脱离 VS Code 存在，用 **Electron** 实现。
2. 保证前端**流畅**。
3. 完整复现插件功能（功能完整）。
4. 结果上公开排行榜，尽力而为。
5. （补充）修复乱码文件名；继续完成之前未完成的工作。
6. （补充）**设置选项必须单独在顶部栏开一个** —— 已实现（标签栏右侧齿轮按钮）。
7. （补充）**汉英双语 UI** —— 已实现（顶部栏语言切换按钮 + 系统语言自动检测 + 设置页语言选项）。
8. （补充）**修复无法打开项目文件夹的问题** —— 已修复（根因：shim 的 WorkspaceFolder 缺 `fsPath` 字段 + file URI 格式不符合 `file://` 标准）。
9. （补充）**最终要作为 GitHub 分发的项目** —— 已接入 electron-builder 打包（win/mac/linux），win-unpacked 已验证可运行。

---

## 2. 代码库结构

```
Gray-Code-1.3.1-1/              # 源项目（插件），仅 electron-app 之外极少改动：
│                               #   webview/handlers/FileHandlers.ts（删除调试日志，无功能改动）
│                               #   frontend/（ConversationTabs 顶部栏、App.vue 语言切换、
│                               #     settingsStore Language 类型、i18n 3 语言补 key、vite.config 已还原）
├── backend/        # 后端模块（渠道/对话/MCP/记忆/设置/工具/子代理/检查点…）原样复用
├── frontend/       # Vue3 + Pinia + Vite 前端（本轮做了顶部栏与双语改动；构建产物 frontend/dist）
├── webview/        # VS Code 消息路由（MessageRouter）与各类 Handler
├── resources/      # codicons 图标字体、sound 音效、icon
└── electron-app/   # ⭐ 独立桌面应用（本轮主战场，见下）
```

前端 <-> 后端通信协议（与 VS Code 版完全一致）：
- 请求：`{ type, requestId, data }` via `postMessage`
- 响应：`{ type:'response', requestId, success, data }` / `{ type:'error', requestId, success:false, error:{code,message} }`
- 推送：`{ type:'command', command, data }`、`streamChunk/streamChunkBatch`、`terminalOutput`、`imageGenOutput`、`taskEvent`、`dependencyProgress`、`retryStatus`、`diff.statusChanged` 等

---

## 3. electron-app 架构与关键设计

| 决策 | 说明 |
|---|---|
| 后端进主进程 + vscode shim | 全量复用后端代码零改动：esbuild alias `vscode` → `src/vscode-shim.ts` |
| 前端复用 + 少量改动 | preload 提供 `acquireVsCodeApi` 桥；`window.postMessage` 转发后端消息 |
| 自定义协议 | `graycode://local/<repo相对路径>` 服务资源（`protocol.handle` + `net.fetch(file://)`），避免 file:// 的 fetch/audio CORS 限制 |
| 渲染层 Overlay | `renderer/overlay.js`：toast、quickPick、inputBox、Diff 预览模态框（接受/拒绝）、no-workspace 提示条 |
| Diff 流程 | `vscode.diff` 命令被 shim 拦截 → 向渲染层发 `host.openDiffPreview` → 模态框 Accept/Reject → `diff.accept/diff.reject` |
| 主题 | `renderer/theme.css` 提供完整 VS Code Dark+ 风格 CSS 变量 |
| 打包 | electron-builder：win(nsis/zip) / mac(dmg/zip) / linux(AppImage/deb)，extraResources 放入 frontend/dist + resources |

### 文件清单

```
electron-app/
├── package.json          # scripts: build / build:all / start / e2e / smoke / dist*
│                         # build: electron-builder 配置（appId=dev.graycode.desktop）
├── build.mjs             # esbuild 打包 main+preload（alias vscode→shim；external: electron）
├── patch-dist.mjs        # 构建前端后打补丁：注入 codicons/theme/overlay/sound 到 frontend/dist/index.html
├── src/
│   ├── main.ts           # 窗口/菜单/自定义协议(MIME 表)/原生操作 IPC/工作区持久化+存在性校验/
│   │                     # 调试模式：GRAYCODE_E2E / GRAYCODE_DIAG / GRAYCODE_SHOT / GRAYCODE_UISMOKE
│   ├── preload.ts        # acquireVsCodeApi、消息双向转发、__GRAYCODE_HOST、__GRAYCODE_DETECTED_LANG
│   ├── native.ts         # dialog/shell/clipboard + workspace:pickFolder（供 no-workspace toast 的 Open Folder 按钮）
│   ├── vscode-shim.ts    # ⭐ vscode API shim（详见 3.1）
│   ├── builtinLsp.ts     # 轻量符号提取（executeDocumentSymbolProvider/Definition/Reference 替代实现）
│   ├── e2e.ts            # E2E 测试（7 个场景，见第 5 节）
│   └── host/
│       ├── ElectronContext.ts   # 伪 ExtensionContext
│       └── BackendHost.ts       # 后端初始化 + MessageRouter + 渲染层桥（见 3.2）
├── renderer/
│   ├── theme.css
│   └── overlay.js        # toast/quickPick/inputBox/diff 模态框/no-workspace 提示（原生 JS，DOM-ready 守卫）
├── test/mock-mcp-server.cjs  # MCP stdio mock server（JSON-RPC over stdio，供 E2E）
└── release/              # electron-builder 输出（win-unpacked 已验证可运行）
```

### 3.1 vscode-shim.ts 覆盖的 API（含本轮修复点，⚠️ 标注）

- **Uri**：file/parse/joinPath/with/toString/toJSON；fsPath 与 path 自洽互转
  - ⚠️ **修复**：`toString()` 对 file scheme 一律输出 `file://` 前缀（VS Code 标准行为），
    此前输出 `file:/C%3A/...`，前端 `startsWith('file://')` 判断全部失效。
- **workspace.workspaceFolders**：可运行期替换（`__setWorkspaceFolders`）
  - ⚠️ **修复**：返回的 WorkspaceFolder 对象补上 `fsPath` 字段——后端多处直接读
    `folder.fsPath`（CheckpointManager、工具路径解析、isUriInsideWorkspace 等），
    缺失时抛 `Cannot read properties of undefined (reading 'replace')`，这是
    **「无法打开项目文件夹」的核心根因之一**。
- **workspace.fs**：stat/readFile/writeFile/createDirectory/readDirectory/delete/rename/copy（Node fs 实现）
- **workspace.getConfiguration('graycode')**：JSON 文件存储
- **workspace.findFiles**：内置 glob→regex 遍历
- **workspace.openTextDocument / textDocuments / applyEdit**：文档缓存 + 真实写盘
- **registerTextDocumentContentProvider**：diff 预览虚拟文档
- **onWillSaveTextDocument**：新增 no-op（diffManager 调用，缺了会抛错）
- **CodeLens 类**：新增最小 stub（DiffCodeLensProvider 用到，消除 esbuild 警告）
- **window**：showInformation/Warning/ErrorMessage（toast 桥接）、showQuickPick/showInputBox（模态框）、showOpenDialog/showSaveDialog（原生）、showTextDocument、createOutputChannel、tabGroups、state
- **commands.executeCommand**：`vscode.diff`（→host.openDiffPreview，sessionId 解析支持 **异步等待 pending diff 出现**，修复竞态）、`vscode.open`、`revealFileInOS`、`vscode.execute*Provider`（→builtinLsp）、`workbench.action.reloadWindow`
- **env**：language/clipboard/openExternal；**languages.getDiagnostics**：空
- 类型/枚举：Position/Range/Selection/ThemeColor/TabInputText/FileType/ConfigurationTarget/SymbolKind/RelativePattern/WorkspaceEdit/TextDocumentSaveReason 等

### 3.2 BackendHost.ts 职责

1. 依次初始化：SettingsManager → StoragePathManager → FileSystemStorageAdapter + FileUsageIndexStore +
   DiffStorageManager → ConversationManager → ConfigManager（默认 gemini 渠道）→ 全局上下文 →
   SkillsManager → registerAllTools → ChannelManager → CheckpointManager → ChatHandler → ModelsHandler →
   SettingsHandler → 终端/图像/任务事件订阅 → McpManager → MemoryManager → setSubAgentExecutorContext →
   DependencyManager → MessageRouter → 注册 mainChat client → initializeSubAgentsFromSettings。
2. `handleRendererMessage`：webviewReady 握手（**无工作区时推送 host.noWorkspace 提示**）、
   host.toastReply、diff.openPreview 拦截（previewId→toolId→pending diff id 映射）、串行消息队列。
3. `resolveDiffSessionId`（本轮重写）：若 pending diff 尚未创建（工具仍在执行中），
   轮询最多 3s（50ms 间隔），同时查缓存 `toolDiffIds` 和 diffManager 实况；超时兜底返回 toolId。
4. diff 状态监听：维护 toolId → [{diffId, filePath}]。

---

## 4. 本轮（本会话）完成的工作 ✅

1. **E2E 修复**：diff sessionId 解析竞态（`resolveDiffSessionId` 异步轮询等待 pending diff）。
2. **新增 E2E 场景**：MCP（stdio mock server，创建→连接→工具发现→模型调用→结果落库）、
   子代理（创建→列表→模型调用→内部循环→结果回流→删除）、工作区（中文+空格路径的
   `getWorkspaceUri`/`readWorkspaceTextFile`/`read_file` 全链路）。
3. **修复「无法打开项目文件夹」**：
   - shim `WorkspaceFolder` 补 `fsPath`（`findWorkspaceFolderForUri`/`CheckpointManager` 等直接读它）；
   - `Uri.toString()` 对 file scheme 输出标准 `file:///` 格式。
4. **顶部栏设置按钮**：ConversationTabs.vue 常驻顶部栏（无标签页时显示 GrayCode 占位），
   右侧新增：新建标签（保留）、语言切换、设置齿轮（`codicon-settings-gear`）。App.vue 接线 `showSettings`。
5. **汉英双语 UI**：
   - 顶部栏语言按钮循环切换 中文→English→日本語→Auto（持久化到 `ui.language`）；
   - preload 注入 `__GRAYCODE_DETECTED_LANG`（navigator.language），App.vue 挂载时
     `setDetectedLanguage`，「跟随系统」模式按 OS 语言生效；
   - settingsStore `Language` 类型扩为 `'auto'|'zh-CN'|'en'|'ja'`（原只有 zh-CN/en）；
   - i18n 三语补 `components.tabs.toggleLanguage` / `settings` 两个 key。
6. **Overlay 修复（真正的 appendChild 报错根因）**：overlay.js 被注入 `<head>`，执行时
   `document.body` 尚不存在 → 增加 DOM-ready 守卫（`boot()` 延迟到 body 就绪）。
   另修复 boot() 重构时的语法错误（缺右括号）。
7. **自定义协议 MIME 表**：protocol handler 按扩展名显式返回 Content-Type
   （修复 classic script 的 MIME 校验问题，overlay.js 此前被浏览器拒绝执行）。
8. **打包分发**：electron-builder 配置（win nsis/zip、mac dmg/zip、linux AppImage/deb），
   extraResources 放 frontend/dist + resources；`REPO_ROOT` 支持 `GRAYCODE_REPO_ROOT` 环境变量；
   `npm run dist:win` → `release/win-unpacked/GrayCode.exe` **已验证可启动、UI 正常、资源全部加载**。
9. **性能验证**：UI smoke 报告——启动 DOMContentLoaded ~1.4s、加载期间零 long task、
   渲染进程零 console 错误、设置页 16 个 tab 全部渲染、页面切换 <1.7s。
   （尝试过 Vite manualChunks 拆分 2.7MB 主包，因 chunk 循环依赖报
   `Cannot access 'St' before initialization` 已回滚，单包方案本就流畅。）
10. **工作区体验**：启动时校验已保存的工作区文件夹是否存在；不存在则标题显示
    "No workspace" 并在 webviewReady 后推送 `host.noWorkspace` toast（含 Open Folder 按钮，
    走 `workspace:pickFolder` 原生操作打开目录选择框）。

---

## 4.5 本轮（2026-08 会话）完成的工作 ✅

1. **全链路验证**：重新构建 + UI smoke（0 渲染错误、0 long task、TTI ~1.4-1.8s）+ 后端 E2E 全部通过
   （44+ 断言：渠道/流式工具/diff 接受/确认流/设置/MCP/子代理/CJK 工作区）。
2. **完整打包验证**：`electron-builder --win` 产出 NSIS 安装包（103MB）+ zip（143MB）+ win-unpacked，
   打包版 UI smoke 实测通过（0 错误、0 long task、firstRun toast 正常）。
3. **README.md**：electron-app/README.md 已写（中英双语）：特性、架构图、快速开始、开发/测试/打包命令、
   目录结构、数据存储位置、致谢。GitHub 分发门面完成。
4. **.gitignore**：根 .gitignore 追加 `electron-app/dist/`、`electron-app/release/`、`frontend/dist/`。
5. **CI workflow**：`.github/workflows/build.yml`——三平台（ubuntu/windows/macos）矩阵：
   `npm ci`（root+frontend+electron-app）→ build:all → e2e → smoke（ubuntu 用 xvfb-run）→ electron-builder → 上传产物。
6. **首次运行引导**：webviewReady 握手时检测所有渠道 API Key 是否仍是占位符
   （`YOUR_API_KEY_HERE`），若是则推送 `host.firstRun` → overlay 显示 Welcome toast
   （Open Settings 按钮复用 `showSettings` 命令、Open Folder 按钮走原生目录选择）。
   UISMOKE 新增 `firstRunToast` 断言防回归。
7. **协议缓存优化**：`graycode://` 自定义协议 handler 增加按 mtime 校验的内存缓存
   （命中直接返回 Buffer，避免每次启动重复读 ~3MB 主包 + 字体等），同时移除不再使用的
   `net`/`pathToFileURL` import。
8. **打包元信息**：electron-app/package.json 补充 author/homepage/license，消除 electron-builder 警告。
9. **注意**：electron-app/release/ 目录曾被 OpenCode 自身进程（文件监视）占用锁死无法删除，
   打包验证改输出到系统临时目录；release/ 已加入 .gitignore，本地删除后即可用默认路径打包。

---

## 5. E2E 测试状态（GRAYCODE_E2E=1 electron .，全部通过，40+ 断言）

| 场景 | 内容 | 状态 |
|---|---|---|
| A | 渠道创建/更新 → 对话创建 → chatStream（流式文本→read_file 真实执行→工具结果轮→complete）→ 历史持久化 → 设置读写 | ✅ |
| B | apply_diff → pending diff → diff.openPreview → vscode.diff 拦截 → sessionId 解析 → diff.accept → 文件真实写盘 | ✅ |
| C | 工具确认：delete_file 需确认 → awaitingConfirmation → toolConfirmation 批准 → 文件删除 | ✅ |
| D | 设置 roundtrip + storagePath.getStats | ✅ |
| E | MCP stdio：createServer → connect → tools 发现（echo,add）→ 模型调用 mcp__e2e-mcp__echo → 结果落历史 | ✅ |
| F | 子代理：subagents.create → list → 模型调用 subagents 工具 → 内部循环跑完 → 结果落历史 → delete | ✅ |
| G | 工作区：中文+空格路径 setWorkspaceFolders → getWorkspaceUri 往返 → readWorkspaceTextFile → read_file 工具读 CJK 工作区文件 | ✅ |

UI smoke（GRAYCODE_UISMOKE=1 electron .）：history/usage/settings 页面、设置 tab 切换、
顶部栏按钮存在性、语言切换往返、输入区、渲染进程错误收集（0 错误）、long task 收集。

---

## 6. 调试/运行命令

```powershell
# 一键构建前端+主进程+启动（推荐）
cd Gray-Code-1.3.1-1/electron-app
npm install                  # 已装好（含 electron-builder）
npm start                    # = build:all + electron .

# 分步
npm run build:all            # 前端 build + patch-dist + esbuild 主进程
npm run build                # 只打包主进程（dist/main.js, dist/preload.js）

# 测试
$env:GRAYCODE_E2E='1'; .\node_modules\.bin\electron.cmd .     # 后端 E2E（自动退出）
$env:GRAYCODE_UISMOKE='1'; .\node_modules\.bin\electron.cmd .  # UI 冒烟（自动退出）
$env:GRAYCODE_DIAG='1'; .\node_modules\.bin\electron.cmd .     # DOM 诊断
$env:GRAYCODE_SHOT='C:\temp\shot.png'; electron .              # 截图

# 打包
npm run dist:win             # NSIS 安装包 + zip（输出 release/）
npm run dist:mac / dist:linux
npx electron-builder --win dir   # 只出未打包目录（快速验证）
```

**重要**：`frontend/dist` 每次重新 build 后必须重跑 `node patch-dist.mjs`
（`npm start`/`build:all` 已自动包含）。若改动 `electron-app/renderer/*.js|css`，
同样需要重跑 patch-dist（它把 renderer/ 复制进 frontend/dist/）。

---

## 7. 技术要点备忘（避免踩坑）

- `import * as vscode from 'vscode'` 在 esbuild 中通过 **alias** 替换；`external: ['electron']`。
- 前端 `sendToExtension` 会把 data 做 `JSON.parse(JSON.stringify())` 解包 Proxy，payload 必须纯 JSON。
- `window.postMessage(msg, '*')` 从 preload 直接派发到页面监听器。
- patch-dist 把 overlay.js 注入 `<head>` → overlay 必须 DOM-ready 守卫（已修）。
- `resolveDiffSessionId` 异步：diff.accept/reject 的 sessionId 必须是 DiffManager 的 pending diff id
  （`diff-<ts>-<rand>`），不是 toolId。
- E2E mock OpenAI 服务器：只有第一个无 tool 消息的请求会返回场景工具调用（`toolCallSent` 标志），
  后续请求回纯文本——避免子代理内部循环递归触发同一场景。`resetCapture()` 里重置该标志。
- 自定义协议必须显式给 Content-Type（classic script 会被 MIME 校验拦截）。
- 打包后 REPO_ROOT = `<resources>/`（extraResources 布局：resources/frontend/dist、resources/resources）。
- Vite manualChunks 拆分主包会触发 chunk 间循环依赖 TDZ 错误，**不要尝试**（已试过并回滚）。
- `console-message` 事件在新版 Electron 是单 Event 参数（level/message 在 event 对象上）。

---

## 8. 剩余工作（新会话从这里继续）

1. **（已完成 ✅）README**：electron-app/README.md 已写（中英双语）。
2. **（已完成 ✅）完整打包产物验证**：NSIS + zip + win-unpacked 均产出并验证。
3. **（已完成 ✅）.gitignore / 仓库结构**：根 .gitignore 已覆盖 electron-app 产物。
4. **（已完成 ✅）CI**：.github/workflows/build.yml 三平台矩阵（未在真实 GitHub 上跑过，首次 push 后观察）。
5. **（已完成 ✅）首次运行体验**：host.firstRun Welcome toast（配置渠道/打开文件夹）。
6. **性能**：已达标（启动 1.4s、零 long task、零渲染错误）。协议层内存缓存已加；
   可选：为 graycode:// 加 gzip/brotli（本地读取收益有限，不建议）。
7. **清理**：本机 `electron-app/release/` 被 OpenCode 文件监视锁住，删除后即可；
   首次 push GitHub 后确认 CI 三平台绿。
8. **双语文档一致性**：设置页语言下拉与顶部栏按钮互通已验证。
9. **（新增）打包版回归**：若改动 src/ 或 renderer/，重新 `npm run dist:win` 后
   对 win-unpacked 跑一次 UISMOKE（GRAYCODE_REPO_ROOT 指向其 resources 目录）。

## 9. 已确认无问题的点（避免重复排查）

- 多语言切换（顶部栏按钮 + 设置页下拉）都正常，持久化生效，重启保持。
- 「跟随系统（auto）」按 OS 语言正确解析（preload 注入 navigator.language）。
- 中文/空格/emoji 路径的工作区：getWorkspaceUri、readWorkspaceTextFile、read_file、
  apply_diff 全链路可用。
- 默认渠道 gemini-default 自动创建；渠道设置页可正常新增/编辑。
- 打包版（win-unpacked）UI 完整加载，与源码运行行为一致。

---

## 10. 本会话（2026-08-04）完成的工作（新会话从这里继续）

> 需求补充（用户原话）：① 子 agent 监看窗口不应打开新窗口占用任务栏，应在主程序页面分出一块区域；② 使用引导不应该每次都有；③ 最常出现的 bug 是 UI 的设置与语言缺失；④ 完善子 agent 体验 / 优化历史读取 / 重roll 树状分叉。

### 10.1 ✅ 子代理 Monitor 改为主窗口内嵌面板（P1，独立窗口方案已删除）

- **新架构**：`electron-app/src/host/SubAgentMonitorBridge.ts`（内嵌面板桥）取代 `src/monitor/SubAgentMonitorWindow.ts`（已删除）。
  - 订阅 `subAgentRunEventBus` → 向主窗口渲染进程推送瘦身 `subagentMonitor.event/manifest`；llm_delta 50ms 合并节流；`visible=false` 时丢弃高频 delta；
  - 处理 `subagents.monitorReady` / `subagents.monitor.getRunWindow` / `subagents.monitor.setVisible`；其余经 `routeMonitorMessage` 走统一 MessageRouter；
  - `openRun(runId, conversationId)`：更新焦点 + 推送 navigate manifest。
- `BackendHost`：构造 bridge；`handleRendererMessage` 按 `clientId==='subagent-monitor'`（或 monitor 协议类型）分流；`ctx.openSubAgentMonitor` 改为 bridge.openRun + 发 `host.openSubAgentMonitor` 命令到前端；删除 `onOpenSubAgentMonitor` option。
- `main.ts`：删除 monitor 窗口与 IPC sender 分发；postToRenderer 全部投主窗口。
- 前端：`sendToExtension` 支持 `options.clientId`；`SubAgentMonitor.vue` 新增 `embedded/visible/focusRunId` props（内嵌布局 100% 高 + 头部关闭按钮 + setVisible 通知 + 导航聚焦）；`App.vue` 聊天视图改为 `chat-body`（chat-main + 右侧 400px monitor-panel，v-show 保活）；顶部栏新增 hubot 面板开关。
- **MONITOR_SMOKE 重写**（不再开窗口）：8/8 全过。
- UISMOKE 新增 `monitorPanel` 步骤：发 `host.openSubAgentMonitor` 命令 → `.monitor-root` 出现 → 点关闭按钮 → 面板消失。

### 10.2 ✅ UI 设置/语言按钮缺失（再次回归后重建，改为不可回归）

- `ConversationTabs.vue` **常驻顶部栏**：无标签页也渲染（占位标题），右侧固定「Monitor 开关 / 语言切换 / 设置齿轮」。UISMOKE 等待目标只留 `.tabs-bar` → topBarButtons flake 从根上消除（连跑多次稳定 true）。
- `settingsStore.Language` 扩为 `'auto'|'zh-CN'|'en'|'ja'`；`composables/useI18n.ts`（工具卡/终端用旧 i18n）补齐 ja + auto 解析（此前切日文工具卡全回落中文）。
- `App.vue` `loadLanguageSettings` 接线 `setDetectedLanguage`（此前从未调用，auto 模式实际失效）。

### 10.3 ✅ 首次运行引导只显示一次

- `checkFirstRunOnboarding`：`graycode.onboardingSeen` 持久化到 globalState；显示过一次或已配置真实 Key 后不再弹出。

### 10.4 ✅ 历史读取性能收尾（P2）

- `storage.ts` 分段并行读（Promise.all 保持段序）；`history_search.ts` `getHistoryRef`（免深拷贝）；`getMetadata` metaCache 命中跳过磁盘完整性检查；`useConversations.ts` 确认无组件使用。

### 10.5 ✅ VSCode-Shim 修复

- `showQuickPick` 丢 options + canPickMany 返回形状错误（修复 diff 多选崩溃）；后端自动打开的 diff 预览左栏恒空（`resolveOriginalContent` hook）；glob `{a,b}` 花括号永不匹配（find_files exclude 全部失效）；findFiles 并发遍历饿死（8 路并发）；`workspace.fs.readFile` 零拷贝。

### 10.6 ✅ 验证基线（本会话全绿）

- 后端 Jest **723/723**；前端 Vitest **71/71**；根 typecheck 0 错误；vue-tsc 0 错误。
- `npm run build:all` 通过；E2E **ALL PASSED**；UISMOKE 全步骤 ok（topBarButtons true / languageToggle / monitorPanel / rendererErrors:[] / longTasks:[]）；MONITOR_SMOKE 8/8。

### 10.7 待办

1. **P5 打包回归**：`npm run dist:win` 后对 win-unpacked 跑 UISMOKE（GRAYCODE_REPO_ROOT 指向 resources）。
2. **P3 真实对话人工验证**（重roll 树状分叉 UI 需真实 API Key 环境）。
3. 首次 push GitHub 后确认 CI 三平台绿。

### 10.8 ✅ 快速启动脚本 + 文档

- 新增 `electron-app/start.bat`（Windows）与 `electron-app/start.sh`（macOS/Linux）：按需 npm install、构建产物缺失或 `--rebuild` 时增量构建（`npm run build:all`），随后直接启动 electron；已实测真实启动（backend_initialized 日志确认）。
- ⚠️ **start.bat 编写雷区**：cmd.exe 块解析器会把 `if (...) (` 块内 echo 文本的未转义括号当块边界 → 脚本卡死/退出 255/stderr「操作超时」；必须 `^( ^)` 转义。.bat 保持 CRLF 行尾。
- 新增 `electron-app/CHANGELOG.md`（桌面版变更日志）；根 `CHANGELOG.md` [Unreleased] 补重roll 树状分叉/历史性能/unifiedDiff/insert_code 条目；`electron-app/README.md` 补快速启动脚本、Monitor 内嵌面板、重roll 特性与 MONITOR_SMOKE；根 README 双语文案补桌面版入口。

---

## 11. 本会话（2026-08-04 第二段）完成的工作：变更查看面板内嵌化（GitHub 风格）

> 用户需求：验证代码变更查看窗口行为，实现 GitHub 查看变更的效果；变更窗口**不应是独立窗口**，其运行逻辑应与子代理查看窗口（内嵌面板）类似。测试不应过度。

### 11.1 ✅ 全屏 Diff 模态框 → 主窗口内嵌 GitHub 风格面板

| 文件 | 修改 |
|---|---|
| `frontend/src/utils/diffLines.ts` | **新增**公共行级 diff 工具：LCS 行匹配（Int32Array 滚动 DP，>2M 单元回退全删全加）、`buildHunks`（GitHub 式 hunk 分组：变更块 + 前后各 3 行上下文，`@@ -a,b +c,d @@` 头）、`diffStats`；从 write_file.vue 抽取，删除其重复实现 |
| `frontend/src/__tests__/utils/diffLines.test.ts` | **新增** 12 个 Vitest 用例（行号推进/替换/空文件/hunk 分组/上下文裁剪/统计） |
| `frontend/src/stores/diffStore.ts` | **新增** diff store：`entries` 队列（一次工具调用多文件 diff 累积）、`open`/`selectedIndex`、`push`（按 previewId/sessionId 去重）、`accept/reject/acceptAll/rejectAll`（diff.accept/diff.reject 协议，busy/error 状态）、`syncStatuses`（diff.statusChanged 推送同步状态 + 删除警戒） |
| `frontend/src/components/diff/DiffViewerPanel.vue` | **新增**内嵌面板组件：左侧文件列表（状态徽标 ✓/✕/待处理 + ±行数统计），右侧统一 diff（sticky hunk 头、双行号、增删着色、删除警戒 banner、已处理标签），头部全部接受/全部拒绝/关闭；`visible` prop + `close` emit（与 SubAgentMonitor 内嵌模式一致） |
| `frontend/src/App.vue` | `host.openDiffPreview` 命令 → `diffStore.push`；`message/diff.statusChanged` → `syncStatuses`；`visitedDiff` 惰性挂载 + `diffPanelVisible`；`.chat-body` 加 `position:relative`，面板为绝对定位右侧抽屉（680px，覆盖聊天区，不与 Monitor flex 面板冲突） |
| `frontend/src/stores/index.ts` | 导出 diffStore 与类型 |
| `frontend/src/i18n/langs/{zh-CN,en,ja}.ts` | 新增 `components.diff.*`（title/accept/reject/acceptAll/rejectAll/status/empty/noChange/close/actionFailed） |
| `electron-app/renderer/overlay.js` | **移除** Diff 模态框（gc-diff CSS、lineDiff、diffStack、openDiffPreview、dispatch case）；保留 toast/quickPick/inputBox |
| `electron-app/src/main.ts` | UISMOKE `sendCommand` 支持 data 参数；新增 `diffPanel` 步骤（命令打开 → 断言文件列表/增删行/hunk 头 → 关闭按钮收起面板） |
| `frontend/src/components/tools/file/write_file.vue` | 删除本地 computeDiffLines/computeLCS/DiffLine，改用共享 util（行为等价，typecheck 与全量 Vitest 通过） |

### 11.2 运行逻辑（与子代理 Monitor 内嵌面板同构）

- 触发链：后端 `showDiffViewUnlocked`（auto-open）或前端工具卡「查看变更」（`diff.openPreview`）→ `vscode.diff` 命令 → shim 拦截（sessionId 异步解析 + originalContent 补取）→ `host.openDiffPreview` 命令推送主窗口 → App.vue → diffStore.push → 面板 v-show 打开并选中新条目。
- 请求复用同一 IPC：`diff.accept`/`diff.reject`（requestId 匹配响应），不需要新 clientId、不需要新 IPC 通道；`diff.statusChanged` 全局广播同步面板状态。
- 多文件：一次 apply_diff 多文件 → 多个 `host.openDiffPreview` → 文件列表累积（GitHub PR 变更视图形态）。

### 11.3 验证基线（本会话全绿）

- 前端 Vitest **83/83**（71 + 新增 12）；后端 Jest **723/723**（85 suites）；vue-tsc 0 错误；根 typecheck 0 错误。
- `npm run build:all` 通过；E2E **ALL PASSED**（含 diff 场景 B：openPreview → vscode.diff 拦截 → sessionId → accept → 写盘）。
- UISMOKE **全步骤 ok**，新增 `diffPanel` 步骤实测：`found:true fileRows:1 addLines:2 delLines:1 hunkHeaders:1 closedAfterCloseBtn:true`；rendererErrors:[]、longTasks:[]。
- MONITOR_SMOKE 8/8（回归确认 monitor 内嵌面板未受影响）。

### 11.4 待办（延续）

1. **P5 打包回归**：`npm run dist:win` 后对 win-unpacked 跑 UISMOKE（GRAYCODE_REPO_ROOT 指向 resources）。
2. **P3 真实对话人工验证**（重roll 树状分叉 / 变更面板 Accept 流程需真实 API Key 环境）。
3. 首次 push GitHub 后确认 CI 三平台绿。

> 本会话新增文件清单：`frontend/src/utils/diffLines.ts`、`frontend/src/stores/diffStore.ts`、`frontend/src/components/diff/DiffViewerPanel.vue`、`frontend/src/__tests__/utils/diffLines.test.ts`；修改：App.vue / stores/index.ts / write_file.vue / i18n 三语 / overlay.js / main.ts（UISMOKE）/ 两份 CHANGELOG.md / electron-app README.md。
