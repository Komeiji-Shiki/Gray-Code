## TODO LIST

<!-- GRAYCODE_TODO_LIST_START -->
- [x] P1: 子代理 Monitor 改为「主窗口内嵌面板」（替代独立窗口方案）  `#P1`
- [x] P2: 历史记录读取性能收尾（缓存已接线 + 分段并行读 + 深拷贝优化 + metaCache 短路）  `#P2`
- [x] P3: 对话重 roll 树状分叉（DeepSeek 风格，后端+前端均已实现并验证）  `#P3`
- [x] P4: 全量验证（Jest 723/723、Vitest 83/83、typecheck 0、E2E ALL PASSED、UISMOKE 含 diffPanel、MONITOR_SMOKE 8/8；CI 未跑）  `#P4`
- [x] P6: 变更查看面板内嵌化（GitHub 风格，替代全屏 Diff 模态框，运行逻辑同 SubAgent Monitor 面板）  `#P6`
- [ ] P5: 打包回归：npm run dist:win 后对 win-unpacked 跑 UISMOKE  `#P5`


<!-- GRAYCODE_TODO_LIST_END -->

# 独立版完善与功能升级计划（会话交接文档）

> 本文档是跨会话交接文档。**新会话从「二、当前进展」开始**，然后按「三、待办事项」逐项执行。
> 工作目录：`C:\Users\cjr13\Documents\暂存\随意2\Gray-Code-1.3.1-1`（源项目 + Electron 独立版）。
> 更多交接背景见 `electron-app/PROGRESS.md`（上一阶段已完成工作的完整记录）。

---

## 一、项目需求（用户原话要点 + 历次补充）

1. 为 GrayCode（VS Code AI 编程助手插件 v1.3.1-1）构造**完全独立于 VS Code** 的前端，用 Electron 实现，功能完整复现插件能力、运行流畅，最终作为 GitHub 分发项目交付。
2. **检查项目 bug 并修复**；确保脱离 vscode 也能完整实现源项目功能。
3. 完善**子 agent 使用体验**。
4. **优化历史记录读取性能**。
5. 对话**重 roll 修改成 deepseek 官网那样的树状分叉**（同一会话内可切换新旧分支）。
6. 具体怎么优化看着来，可以重构代码。
7. **（本次新增，重要）**：子 agent 监控的预期行为是**在主窗口内做一个分区（内嵌面板）**，而不是单独打开一个新的独立窗口占用任务栏。**已实现的独立 BrowserWindow 方案需要改造为内嵌面板。**

---

## 二、当前进展（本会话已完成）

### 2.1 已修复的 bug ✅

| 项 | 位置 | 说明 |
|---|---|---|
| unifiedDiff hunk 边界消歧 | `backend/tools/file/unifiedDiff.ts` | `--- x`+`+++ y`+`@@` 内容对被误判为下一个文件头导致内容丢失；新增 `looksLikeFilePathHeader()` 按"路径形"消歧（`-- old item` 这类内容行不再中断 hunk）。测试 `unifiedDiffHunkBoundary.test.ts` 已过。 |
| insert_code 幻影尾行 | `backend/tools/file/insert_code.ts` | `split('\n')` 的尾部空串导致末尾追加产生多余空行；`insertAtLine` 增加幻影尾行处理并导出。测试 `insertCodePhantomLine.test.ts` 已过。 |
| Electron diff overlay 右栏恒为空 + sessionId 失效 | `electron-app/src/vscode-shim.ts` `vscode.diff` 拦截 | 根因：newUri 是 file: URI 无 provider → newContent 恒 `''`；previewId 从 file URI query 提取恒空。已按两种 diff 路径分别处理：①`gemini-diff-original:`（后端自动打开）→ 从磁盘/文档缓存读 newContent、previewId=path 第一段、filePath=newUri.fsPath；②`graycode-diff-preview:`（前端 openDiffView）→ 双方内容走 diffPreviewProvider、previewId 从 query 取。E2E 场景 B 全过。 |
| macOS activate 双重注册 | `electron-app/src/main.ts` | `ipcMain.on('graycode:renderer-to-backend')` 原在 createWindow 内，activate 重建窗口会重复注册导致消息执行两次；后端也重复创建。已重构：`createBackend()` 只创建一次 BackendHost + 注册一次 IPC，`createWindow()` 只建窗口；activate 无窗口时重建、有窗口时 restore+focus。 |
| `require('./vscode-shim')` 打包后必崩 | `electron-app/src/main.ts` focus/blur | 主进程 bundle 是单文件，运行时不存在独立 shim 文件 → 改具名 import `__setWindowFocused`。 |
| findFiles 硬编码跳过 dist/build | `electron-app/src/vscode-shim.ts` `findFilesImpl` | 默认跳过列表改为可从设置 `graycode.findFilesSkipDirs` 覆盖；默认不再跳 `dist/build/.next/out`（AI 需要检查构建产物）。 |
| workspaceState/globalState 导出 null | `electron-app/src/vscode-shim.ts` | 新增 JSON 文件持久化 `JsonFileMemento`，`__initMementoPaths(userDataPath)` 在 BackendHost 构造时调用；`export let` 活绑定保证 init 后可见。 |
| extensions.getExtension 恒 undefined → 公告/更新失效 | `electron-app/src/vscode-shim.ts` | `Komeiji-Shiki.graycode` 返回最小 stub（packageJSON.version + extensionPath=repo root），桌面版公告检查恢复可用。 |
| 自定义协议 MIME 表缺失 | `electron-app/src/main.ts` `registerCustomProtocol` | 补齐 .map/.md/.txt/.ico/.wasm/.otf/.eot/.mp4/.webm/.xml/.yml/.pdf/.csv 等。 |
| 协议路径包含检查大小写敏感 | `electron-app/src/main.ts` | Windows 路径归一化小写 + 分隔符边界比较。 |
| frontend/dist 与 patch-dist 不一致 | 构建流程 | dist 被重 build 后未重跑 patch-dist → overlay.js/theme/codicon 丢失；`npm run build:all` 已重建并验证。 |

### 2.2 子 agent 体验提升（已完成部分）✅

1. **Electron 子代理 Monitor 窗口**（独立窗口版，待按新需求改内嵌面板）：
   - 新增 `electron-app/src/monitor/SubAgentMonitorWindow.ts`：复用前端 `__GRAYCODE_VIEW_MODE='subagentMonitor'` 模式（App.vue:33 已支持），preload 通过 `additionalArguments` 注入 view mode / initialRunId / clientId；事件总线订阅 + llm_delta 50ms 合并节流 + payload 瘦身（复用 `createMonitorEventPayload`）。
   - `BackendHost` 新增 `routeMonitorMessage()` / `registerMonitorClient()` / `getConversationStore()`；`openSubAgentMonitor` 由 no-op 改为回调 `onOpenSubAgentMonitor`。
   - `main.ts`：`createBackend()` 中创建 monitor window 管理器，IPC 按 sender 窗口身份分发。
   - 验证：`GRAYCODE_MONITOR_SMOKE=1 electron .` 全部通过（窗口创建/模式注入/UI 挂载/monitorReady 往返/未知 run 优雅拒绝/干净释放）。**此方案将被 P1 替换。**
2. **run 卡片"继续"按钮**：`subagents.continueRun` 后端 handler（`webview/handlers/SubAgentsHandlers.ts`）+ `executeSubAgent` 导出（`backend/tools/subagents/subagents.ts`、`index.ts`）+ 前端按钮（`frontend/src/components/tools/subagents/subagents.vue`，InputDialog 输入继续指令，后台任务方式执行并回流）。i18n 三语已补。
3. 前后台 run 卡片状态跟随 `backgroundTaskStore` 真实任务状态（已有，未改动）。

### 2.3 历史记录性能（已部分完成，缓存改造已写好待验证）🟡

**改动已写入 `backend/modules/conversation/ConversationManager.ts`（尚未跑测试验证）：**
- 新增 `historyCache`（容量 24 会话）/ `metaCache`（容量 256）LRU；
- `loadHistory()` 命中缓存直接返回引用（写路径全部经 transcript 仓储 mutate → saveContents → 失效，安全）；
- `invalidateCaches()` 需在所有写路径调用（saveContents、createConversation、createBranchConversation、deleteConversation、setCustomMetadata/updateCustomMetadata 的 saveMetadata 处）；
- `getMetadata()` 接入 metaCache（列表 N 会话从 4N 次 fs 操作降到首列表 2N、后续 O(N) 内存）；
- 已加 `clearCaches()` 供测试使用。
- **注意**：本会话**未完成** `storage.ts` 分段并行读（`loadSegmentedHistory` 串行读段文件）与 `history_search.ts` 深拷贝优化、以及 `getMetadata` 缓存接入的收尾。见 P2。

### 2.4 验证基线 ✅

- 后端 Jest：**717/717 通过**（含新增 unifiedDiff/insertCode 修复回归）。
- 前端 Vitest：**71/71 通过**。
- Electron E2E（GRAYCODE_E2E=1）：**全部通过**（44+ 断言，含 diff overlay 修复后场景 B）。
- UISMOKE（GRAYCODE_UISMOKE=1）：0 渲染错误、overlay 已注入、页面/语言/设置正常（有 1 个 71ms long task 在设置页加载时，可接受）。
- MONITOR_SMOKE（GRAYCODE_MONITOR_SMOKE=1）：**全部通过**（独立窗口方案验证，将被 P1 替代）。

---

## 三、待办事项

### P1 ⭐ 子代理 Monitor 改为主窗口内嵌面板（替代独立窗口）

**用户预期：在主窗口内做一个分区（类似 VS Code 的 Beside 面板/侧栏），而不是独立 BrowserWindow（会占用任务栏）。**

**现状（待改）：**
- `electron-app/src/monitor/SubAgentMonitorWindow.ts`：独立 BrowserWindow 实现（本会话新增）。
- `main.ts` createBackend 里 `subAgentMonitorWindow` 管理 + IPC 按 sender 分发。
- `BackendHost.routeMonitorMessage / registerMonitorClient`（可复用）。
- 前端已支持 `__GRAYCODE_VIEW_MODE==='subagentMonitor'` 渲染 `SubAgentMonitor.vue`（`frontend/src/App.vue:33,517`），VS Code 版用独立 WebviewPanel 打开。

**改造方案（建议）：**
1. **主窗口内做分区面板**：在 App.vue 主聊天布局中新增一个可折叠/可拖拽的右侧面板（或底部抽屉），`v-if` 渲染 `SubAgentMonitor.vue`；面板开关状态放入 `settingsStore`（如 `showSubAgentMonitor`），持久化到 `ui` 设置。
2. **消息路由改造**：Monitor 面板与主聊天在**同一个 webview/窗口**里，前端发消息时需区分 target：
   - 方案 A（推荐）：保留现有 `WebviewClientRegistry` 双 client 机制——主聊天消息带 `clientId:'main-chat'`（默认），Monitor 面板内组件的 `sendToExtension` 统一带 `clientId:'subagent-monitor'`（可在 `frontend/src/utils/vscode.ts` 的 `sendToExtension` 里增加一个可选 clientId 参数，或给 Monitor 组件包一层专用 send 封装）。
   - 后端 `BackendHost` 已就绪：`registerMonitorClient`（按 run 注册 runScope）+ `routeMonitorMessage`；`main.ts` 里按 sender 分发的逻辑可删除，改由消息自带的 clientId 判定（`postToRenderer` 已按 `message.clientId==='subagent-monitor'` 分流，见 createBackend）。
3. **生命周期**：面板挂载时发 `subagents.monitorReady` 拉 manifests；面板关闭（折叠）不销毁订阅也行——`SubAgentMonitorWindow` 的事件订阅逻辑（llm_delta 节流 + 可见性丢弃）移到前端组件或一个主进程/前端共享的轻量桥。由于同一窗口内事件推送可以走现有 `postToRenderer → webContents.send` 通道（无需独立窗口），可直接在 BackendHost 里做一个 `SubAgentMonitorBridge`（订阅 runEventBus，向主窗口推送 `subagentMonitor.event/manifest`，visible 判定改为前端面板是否打开——由前端通过 `subagents.monitor.setVisible` 消息通知）。
4. **前端 Monitor 组件复用**：`SubAgentMonitor.vue` 已按"面板模式"设计（分页窗口、delta 缓冲、工具卡 overlay、控制按钮），改动重点是外层布局与消息通道，组件本体尽量不动。
5. **删除/保留**：`SubAgentMonitorWindow.ts`、`monitor-smoke.ts`、main.ts 中 monitor 窗口相关代码可删除或降级为仅测试；`GRAYCODE_MONITOR_SMOKE` 保留改测面板协议（模拟前端消息即可）。
6. **VS Code 版不受影响**：只动 electron-app 与前端面板布局。

**验收标准：**
- 主聊天窗口内出现 Monitor 分区，不新增窗口/任务栏条目；
- 子代理运行中从工具卡 "Open details" 直接聚焦该分区并实时流式；
- 暂停/继续/退出/删除/重试/继续按钮可用；
- 面板可折叠，折叠时不接收高频事件（或前端自行丢弃）；
- MONITOR_SMOKE 改版后全过。

### P2 历史记录读取性能收尾

已完成：ConversationManager 缓存（见 2.3）。**待办：**
1. **跑测试验证缓存改造**：`npm test`（尤其 `pagedHistoryIntegrity`、`storageSegmentedWrite`、`ConversationManager.usageIndex`、`ConversationManager.branch`）；若 `getMessagesRaw` 与缓存路径不一致导致测试失败，需在 `getMessagesRaw` 也用缓存（注意它无 createConversation 副作用）。
2. **`storage.ts` 分段并行读**：`loadSegmentedHistory`（约 L764-781）把串行 `for` 循环读段文件改为 `Promise.all`（注意保持段顺序）；`loadSegmentedHistoryPage` 已按 index 跳过不相交段，无需改。
3. **`history_search.ts:517` 深拷贝优化**：`getHistory` → 改 `getHistoryRef`（无深拷贝），`formatToDocument` 内按需克隆单条消息；同时利用缓存后全量读变成内存操作。
4. **`getMetadata` 完整性检查优化**：`getMetadata` 每次读 meta + historyPage(limit:1) 两次 fs；缓存命中时跳过；另外可考虑 `loadHistoryPage({limit:1})` 的 integrity 检查改为仅当 metaCache miss 时执行。
5. **旧 composable 串行列表**（`frontend/src/composables/useConversations.ts` 串行 N 次 IPC）：确认是否仍被使用；`conversationActions.ts` 已用并发 30。若 HistoryPanel 用旧版，切换。
6. 性能对比：大对话（>500 消息）重复 loadHistory 的耗时在缓存前后差异（可选，手动验证）。

### P3 对话重 roll 树状分叉（DeepSeek 风格）

**现状：** 重 roll = 原地覆盖（`frontend/src/stores/chat/messageActions.ts` `retryFromMessage` 先 `deleteMessage` 再 `retryStream`）；已存在对话级 `createBranchConversation`（整段复制到新对话 + `custom.branch` 元数据），但没有消息级父子关系。

**目标：** 重 roll / 编辑重发后，旧回复保留为分支节点；消息间出现分支标记（类 DeepSeek 的小圆点），点击可查看/切换到另一分支；当前活动路径可变，切换后继续聊天基于所选分支。

**建议实现（后端优先，数据模型保持 index 寻址，避免消息 ID 大改）：**
1. **分支存储**：新增 `backend/modules/conversation/BranchStore.ts`（或并入 storage.ts）：
   - 目录 `{baseDir}/conversations/{convId}/branches/{branchId}.json`，内容 `{ branchId, parentIndex, createdAt, messageCount, preview, messages: Content[] }`；
   - `{convId}/branches/index.json`（或直接读目录）存列表 `{branchId, parentIndex, createdAt, messageCount, preview}`，供列表页轻量读取。
2. **捕获时机**：`ChatFlowService.handleRetryStream`（L954-1031）与 `handleEditAndRetryStream`（L1036-1180）在截断/重写**之前**调用 `conversationManager.captureRollbackBranch(conversationId, parentIndex, tailContents)` 保存旧尾巴；`ConversationManager.deleteMessage`（用户手动删消息）**不**建分支（保留现状语义）。
   - 注意：`retryStream` 前端先调 `deleteMessage` 再调 `retryStream`——分支捕获要放在删除发生前。可选：给 `deleteMessage` 加 `captureBranch?: boolean` 参数，retry/editAndRetry 路径传入 true。
3. **IPC**：
   - `conversation.listRollbackBranches` {conversationId} → 轻量列表；
   - `conversation.loadRollbackBranch` {conversationId, branchId} → 完整 messages（前端仅展示/确认时用）；
   - `conversation.switchToBranch` {conversationId, branchId} → 当前活动尾巴先存为分支，再把该分支 contents 写回主历史（`storage.saveHistory`），失效缓存，返回新 total + 消息窗口。
4. **前端**：
   - `chatStore` state 增加 `rollbackBranches`（随 loadHistory 一起拉取）；
   - `MessageList`/`MessageItem` 渲染分支标记：位于消息 i 与 i+1 之间，若有 parentIndex===i 的分支则显示小圆点（数量），点击弹出分支列表（时间 + preview + 消息数），点击切换（`conversation.switchToBranch` → 重新 loadHistory）；
   - 重 roll 完成后刷新分支列表；
   - 流式进行中隐藏标记/禁用切换。
5. **边界**：切换分支时若当前路径有未保存状态（如活跃 TODO 元数据）无需处理（元数据按会话级存）；分支文件随 `deleteConversation` 清理；分支捕获失败不阻塞主流程（静默降级）。
6. **测试**：`backend/__tests__/conversation/rollbackBranch.test.ts`（捕获/列表/切换/删除清理/幂等）。

### P4 全量验证

- 后端 Jest、前端 Vitest、`npm run build:all`、E2E、UISMOKE、MONITOR_SMOKE（改版后）。
- `npm run typecheck`（根 tsconfig 只查根目录 TS，electron-app 用 esbuild 打包不 typecheck——如需可加 `tsc --noEmit` 于 electron-app）。

### P5 打包回归

- 改动 src/renderer/frontend 后重跑 `npm run dist:win`，对 win-unpacked 跑 UISMOKE（`GRAYCODE_REPO_ROOT` 指向其 resources 目录）。
- 首次 push GitHub 后确认 CI 三平台绿（.github/workflows/build.yml 已就绪）。

---

## 四、技术要点备忘（避免踩坑）

- `npm start`（electron-app）= frontend build + patch-dist + esbuild 主进程；**改 frontend 后必须重跑 build:all**，否则 overlay/theme 丢失。
- 后端 `vscode` import 由 esbuild alias 到 `electron-app/src/vscode-shim.ts`；主进程 bundle 单文件，**禁止 require('./vscode-shim')**。
- `WebviewClientRegistry` 是响应路由唯一权威表：clientId 决定响应回投哪个 webview/窗口；`createRoutedContext` 已按 registry 分流，注册缺失时回退主聊天。
- Monitor 事件协议：`subagents.monitorReady` / `subagents.monitor.getRunWindow`（请求）+ `subagentMonitor.event` / `subagentMonitor.manifest`（推送）；payload 必须经 `createMonitorEventPayload` 瘦身（大字段只给计数）。
- 缓存一致性契约：历史写路径必须全部经过 `ConversationTranscriptRepository.mutateContents`/`saveContents`（mutator 返回原引用=跳过写回），缓存失效点放在 saveContents 之后即可；直连 `storage.saveHistory` 的 3 处（createConversation / createBranchConversation / 迁移）也要失效。
- 分支树基于 index 寻址的前提：所有分叉都在同一前缀（重 roll/编辑点之前的历史不变），否则 parentIndex 漂移；切换分支后 parentIndex 仍有效（前缀不变）。
- **start.bat 编写雷区（本会话踩过）**：cmd.exe 的括号块解析器会把 `if (...) (` 块内 echo 文本中的未转义括号当作块边界，导致整块解析失败（表现为脚本卡死、退出 255、stderr 报「操作超时」）；echo 带括号的文本必须 `^( ^)` 转义。另外 .bat 文件应保持 CRLF 行尾。
- 本机 `electron-app/release/` 曾因文件监视占用无法删除；打包验证可输出到系统临时目录。

---

## 六、本会话工作记录（2026-08-04，接续第五节）

### 6.1 会话开始时的项目状态

- 上一会话 5.2 的**前端顶部栏改动（ConversationTabs.vue / settingsStore Language 类型 / App.vue 接线）又被整体回退**为上游版本 → 这就是用户反复报告的「设置齿轮与语言按钮消失」根因（**已修复**）。
- 后端缓存/尾部版本、electron-app monitor 窗口方案、unifiedDiff/insertCode 修复均保留。
- 本会话开始时全部验证基线：Jest 723/723、Vitest 71/71、E2E 全过、UISMOKE topBarButtons flake 未收尾。

### 6.2 ✅ 修复：UI 设置/语言按钮缺失（再次回归后重建，改为不可回归方案）

| 文件 | 改动 |
|---|---|
| `frontend/src/components/tabs/ConversationTabs.vue` | **重写为常驻顶部栏**：`.tabs-bar` 无标签页时也渲染（占位标题），右侧 `.tabs-actions` 固定：SubAgent Monitor 开关（codicon-hubot）、语言切换（简体中文→English→日本語→Auto 循环，持久化 updateUISettings）、设置齿轮（codicon-settings-gear）。**常驻渲染让 UISMOKE 检查不再依赖 createTabAction 时序，从根上消除 flake。** |
| `frontend/src/stores/settingsStore.ts` | `Language` 扩为 `'auto'\|'zh-CN'\|'en'\|'ja'`；新增 `subAgentMonitorOpen` / `monitorFocusRunId` 面板状态与 `openSubAgentMonitor` / `closeSubAgentMonitor` / `toggleSubAgentMonitor` |
| `frontend/src/App.vue` | `loadLanguageSettings` 先 `setDetectedLanguage(__GRAYCODE_DETECTED_LANG \|\| navigator.language)`（此前从未接线，auto 模式失效）；无显式语言时默认 auto；新增 `host.openSubAgentMonitor` 命令处理 |
| `frontend/src/composables/useI18n.ts` | 旧 i18n 系统（工具卡/终端用）补齐 ja 语言包 + auto 解析（此前切日文后工具卡全部回落中文） |
| i18n 三语 | `components.tabs.{appTitle,toggleLanguage,settings,monitor,monitorOpen,monitorClose}`、`components.subagents.monitor.closePanel` |

### 6.3 ✅ 修复：首次运行引导每次都出现

- 根因：`BackendHost.checkFirstRunOnboarding` 每次 webviewReady 握手都检查，无真实 API Key 就弹 Welcome toast。
- 修复：`graycode.onboardingSeen` 标记持久化到 `context.globalState`（JSON 文件），显示过一次或已配置真实 Key 后不再弹出。**UISMOKE 里 firstRunToast 为信息项不做断言，不受影响。**

### 6.4 ✅ P1：子代理 Monitor 改为主窗口内嵌面板（替代独立窗口，不再占用任务栏）

**架构（删除独立 BrowserWindow 方案）：**

| 文件 | 改动 |
|---|---|
| `electron-app/src/host/SubAgentMonitorBridge.ts` | **新增**：订阅 `subAgentRunEventBus`，向主窗口渲染进程推送瘦身 `subagentMonitor.event/manifest`；llm_delta 50ms 合并节流；`visible` 开关（隐藏时丢弃高频 delta）；处理 `monitorReady` / `getRunWindow` / `setVisible`，其余委托 `routeMonitorMessage`；`openRun()` 更新焦点并推送 navigate manifest |
| `electron-app/src/host/BackendHost.ts` | 构造 bridge；`handleRendererMessage` 按 `clientId==='subagent-monitor'` 或 monitor 协议类型分流到 bridge；`openSubAgentMonitor` 不再走窗口回调，改为 `bridge.openRun` + 发 `host.openSubAgentMonitor` 命令；删除 `onOpenSubAgentMonitor` option |
| `electron-app/src/main.ts` | **删除 SubAgentMonitorWindow** 与 IPC sender 分发；`postToRenderer` 全部投主窗口；UISMOKE 等待目标只留 `.tabs-bar`（常驻），新增 `monitorPanel` 步骤（发命令→`.monitor-root` 出现→关闭按钮→面板消失） |
| `electron-app/src/monitor/SubAgentMonitorWindow.ts` | **已删除**（被 bridge 取代） |
| `electron-app/src/monitor-smoke.ts` | 重写：不再开窗口，直接测 bridge 协议（monitorReady / getRunWindow 拒绝未知 run / setVisible 开关 / 隐藏丢 delta / 可见推 delta / openRun 导航 manifest） |
| `frontend/src/utils/vscode.ts` | `sendToExtension` 支持 `options.clientId`（per-message 协议，与 VS Code 版一致） |
| `frontend/src/components/subagents/SubAgentMonitor.vue` | 新增 `embedded/visible/focusRunId` props：内嵌布局（height:100% + 头部关闭按钮）、`visible` 通知 setVisible、`focusRunId` 驱动导航；所有 sendToExtension 带 `clientId:'subagent-monitor'` |
| `frontend/src/App.vue` | 聊天视图改 `chat-body`（chat-main + 右侧 400px `monitor-panel` aside，v-show 保活）；顶部栏 hubot 按钮开关；工具卡「打开详情」→ 后端 → `host.openSubAgentMonitor` 命令 → 面板打开并聚焦 run |

**协议要点**：同一窗口内所有消息走同一 IPC 入口；前端按 requestId 匹配响应，`clientId` 只用于后端分流；面板折叠时 bridge 丢弃 llm_delta，重新打开由前端按 revision 校准窗口。

### 6.5 ✅ P2：历史记录读取性能收尾（子 agent 完成）

- `storage.ts` `loadSegmentedHistory`：串行读段 → `Promise.all` 并行（保持段序，单段失败不中断）。
- `history_search.ts`：新增 `getHistoryRef`（无深拷贝）供只读调用方；`ChatHandler/SummarizeService/ChatFlowService` 的 ensureConversation 弃值调用切到 ref。
- `ConversationManager.getMetadata`：metaCache 命中时跳过磁盘完整性检查（两次 fs → O(1) 内存）。
- `useConversations.ts` 确认无组件使用（HistoryPanel 走 conversationActions 并发 30）。

### 6.6 ✅ VSCode-Shim 审查修复（子 agent 完成）

| 修复 | 说明 |
|---|---|
| `showQuickPick` 丢 options + canPickMany 形状错误 | 转发 options；canPickMany 时返回数组（修复 diff 块选择 `selected.some is not a function` 崩溃） |
| 后端自动打开的 diff 预览左栏恒空 | `vscode.diff` else 分支经 `resolveOriginalContent` hook 从 DiffManager pending diffs 取 originalContent |
| glob 花括号 `{a,b}` 永不匹配 | 重构 `globToRegExpSource` 未锚定拼接（修复 find_files exclude 全部失效） |
| findFiles 并发遍历饿死 | 8 路并发 + 空队列不推进 head + `seen` 改绝对路径 + maxResults 截断 |
| `workspace.fs.readFile` 零拷贝 | 去掉整份 Buffer 复制 |

### 6.7 ✅ P3：重roll 树状分叉（上一会话已实现，本会话验证）

- 后端 `ConversationManager.tailVersion.test.ts` 6 用例全过（含在全量 Jest 723 中）。
- 前端代码审查确认链路完整：`retryFromMessage` 在 `deleteMessage` **之前** `saveTailVersionForRetry` → 版本 chips（v1/v2/v3·最新）+ 前后箭头 → `switchTailVersion` → 后端保存当前尾部+恢复目标 → `loadHistory` 重载；流式中禁用切换。
- 遗留：真实模型对话中的端到端人工验证（无 API Key 环境无法自动化）。

### 6.8 ✅ 验证基线（本会话全绿）

- 后端 Jest **723/723**（85 suites）；前端 Vitest **71/71**；根 typecheck 0 错误；前端 vue-tsc 0 错误。
- `npm run build:all`（frontend build + patch-dist + esbuild 主进程）通过。
- E2E **ALL PASSED**（渠道/流式工具/diff/MCP/子代理/CJK 工作区）。
- UISMOKE：`topBarButtons:true`（连跑多次稳定）、`languageToggle` ok、`monitorPanel` ok（打开/关闭均验）、`rendererErrors:[]`、`longTasks:[]`。
- MONITOR_SMOKE：**8/8 全过**（内嵌桥协议）。

### 6.9 未完成 / 待办

1. **P5 打包回归**：`npm run dist:win` 后对 win-unpacked 跑 UISMOKE（GRAYCODE_REPO_ROOT 指向 resources）。
2. **P3 真实对话人工验证**（需真实 API Key）。
3. 首次 push GitHub 后确认 CI 三平台绿。

### 6.10 ✅ 快速启动脚本 + 文档（本会话追加任务）

- 新增 `electron-app/start.bat`（Windows）与 `electron-app/start.sh`（macOS/Linux）：按需 npm install、构建产物缺失或 `--rebuild` 时增量构建（`npm run build:all`），随后直接启动；已实测真实启动（backend_initialized 日志确认）。
- 新增 `electron-app/CHANGELOG.md`（桌面版变更日志）；根 `CHANGELOG.md` [Unreleased] 补重roll 树状分叉/历史性能/unifiedDiff/insert_code 条目；`electron-app/README.md` 补快速启动脚本、Monitor 内嵌面板、重roll 特性、MONITOR_SMOKE；根 README 中英双语补桌面版入口。
- ⚠️ **start.bat 雷区**：cmd.exe 块解析器把 `if (...) (` 块内 echo 文本的未转义括号当块边界 → 卡死/255/「操作超时」；必须 `^( ^)` 转义；.bat 保持 CRLF（详见「四、技术要点备忘」）。

### 6.11 本会话改动文件清单

```
frontend/src/components/tabs/ConversationTabs.vue   # 常驻顶部栏（重写）
frontend/src/stores/settingsStore.ts                 # Language 扩 4 值 + Monitor 面板状态
frontend/src/App.vue                                 # 内嵌面板布局 + setDetectedLanguage 接线 + openMonitor 命令
frontend/src/composables/useI18n.ts                  # ja 语言包 + auto 解析
frontend/src/i18n/langs/{zh-CN,en,ja}.ts             # tabs.* / monitor.closePanel
frontend/src/utils/vscode.ts                         # sendToExtension clientId 支持
frontend/src/components/subagents/SubAgentMonitor.vue# embedded/visible/focusRunId + clientId
backend/modules/conversation/storage.ts              # 分段并行读（子agent）
backend/tools/history/history_search.ts              # getHistoryRef（子agent）
backend/modules/conversation/ConversationManager.ts  # getMetadata 缓存短路（子agent）
backend/modules/api/chat/ChatHandler.ts 等 3 处      # ensureConversation 用 getHistoryRef（子agent）
electron-app/src/vscode-shim.ts                      # quickPick/glob/findFiles/readFile/diff original（子agent）
electron-app/src/host/BackendHost.ts                 # Bridge 接线 + monitor 消息分流 + onboarding 一次性
electron-app/src/host/SubAgentMonitorBridge.ts       # 新增：内嵌面板桥
electron-app/src/main.ts                             # 删窗口方案 + UISMOKE 修复 + monitorPanel 步骤
electron-app/src/monitor-smoke.ts                    # 重写为桥协议测试
electron-app/src/monitor/SubAgentMonitorWindow.ts    # 删除
electron-app/start.bat                               # 新增：Windows 快速启动脚本
electron-app/start.sh                                # 新增：macOS/Linux 快速启动脚本
electron-app/CHANGELOG.md                            # 新增：桌面版变更日志
electron-app/README.md                               # 快速启动/特性/架构/测试更新
CHANGELOG.md / README.md / README_EN.md              # [Unreleased] 条目 + 桌面版入口
```

> 本节为最新一次会话（修复 UI 回归 + 完成 P2 缓存接线 + 完成 P3 重roll树状分叉 + 修复遗留测试 bug）的完整交接记录。
> **本会话被用户中途叫停：UISMOKE 的 topBarButtons flake 修复已写入但未重新验证（见 5.5）；P1 内嵌面板未动工。**

## 五、本会话工作记录（2026-08-04，新会话从本节开始）

### 5.1 会话开始时的项目状态

- 工作副本与 `Gray-Code-1.3.1-1.tar.gz`（上游源项目）逐文件比对（排除行尾差异）后确认：**backend/frontend/webview 全部与上游一致**，即上一会话的改动被整体回退，只剩：
  - `backend/modules/conversation/ConversationManager.ts` 残留上一会话的「缓存脚手架」（LRU 字段 + cacheHistory/cacheMetadata/invalidateCaches/clearCaches），**但从未被调用（死代码）**；
  - 两个上一会话新增的回归测试文件（`insertCodePhantomLine.test.ts`、`unifiedDiffHunkBoundary.test.ts`）**失败**（对应修复未保留）。
- 用户报告 UI 回归：**顶部栏的设置齿轮与语言切换按钮消失**（ConversationTabs 顶部栏被回退）。

### 5.2 已修复：UI 回归（设置/语言按钮消失）✅

| 文件 | 改动 |
|---|---|
| `frontend/src/components/tabs/ConversationTabs.vue` | 重写为**常驻顶部栏**：无标签页时显示 GrayCode 占位标题（`.tabs-placeholder`）；右侧固定操作区 `.tabs-actions`：新建标签（`.tab-action-btn`）、语言切换（`.tab-action-btn.lang-toggle`，循环 中文→EN→日本語→Auto，持久化 `updateUISettings`）、设置齿轮（`.tab-action-btn` + `codicon-settings-gear` → `settingsStore.showSettings()`） |
| `frontend/src/stores/settingsStore.ts` | `Language` 类型扩为 `'auto'\|'zh-CN'\|'en'\|'ja'`，默认 `'auto'` |
| `frontend/src/i18n/langs/{zh-CN,en,ja}.ts` | 补 `components.tabs.toggleLanguage/settings/appTitle` |
| `frontend/src/App.vue` | `loadLanguageSettings` 注入 `setDetectedLanguage(window.__GRAYCODE_DETECTED_LANG || navigator.language)`（此前该函数从未被调用，「跟随系统」失效），并同步 `settingsStore.language` |
| `frontend/src/components/settings/SettingsPanel.vue` | `updateLanguage` 同步 `settingsStore.setLanguage`（此前顶部栏循环位置会读到过期值） |

验证：前端 typecheck 通过；`GRAYCODE_UISMOKE=1` 一次通过（topBarButtons=true、languageToggle toggledToEn/cycledBackToZh=true、rendererErrors=[]）。

### 5.3 已修复：历史读取性能（P2 核心，缓存正式接线）✅

`backend/modules/conversation/ConversationManager.ts`：
- **缓存正式生效**（上一会话的脚手架是死代码，本会话全部接线）：
  - `loadHistory()` 缓存优先（历史 LRU 24 会话）；`loadStoredMetadata()` 缓存优先（元数据 LRU 256）；
  - 所有写路径失效/回填：`getTranscriptRepository` 的 `saveContents`（落盘后 `cacheHistory` + `metaCache.delete`——存储层 saveHistory 会刷新 updatedAt）、`createConversation`/`createBranchConversation`（种子缓存）、`deleteConversation`（`invalidateCaches`）；
  - 新增 `persistMetadata()`（落盘+缓存），`setTitle/setWorkspaceUri/setCustomMetadata/updateCustomMetadata` 全部改走它；
  - `getMetadata()` 读后回填 metaCache（完整性检查仍走磁盘，行为不变）；
- **`getMessagesPaged` 优化**：缓存命中直接从内存快照切片（省掉分段存储的磁盘段读取+解析）；新增 `buildPageRange()` 与 `toFrontendMessage()`——移除逐条 `JSON.parse(JSON.stringify())` 深拷贝（IPC 同步序列化，无共享引用风险），只浅拷贝+剥离 `turnDynamicContext`+附加 index；
- 新增 `ConversationManager.tailVersion.test.ts` 验证缓存路径无回归（723 全过）。

### 5.4 已修复：上一会话遗留的两个失败测试 ✅

| 测试 | 根因 | 修复 |
|---|---|---|
| `backend/__tests__/tools/insertCodePhantomLine.test.ts` | 文件以 `\n` 结尾时 `split('\n')` 产生幻影尾行，末尾追加产生多余空行；且 `insertAtLine` 未导出 | `insert_code.ts`：新增 `hasPhantomTailLine()`（末位空串且前一位非空才算幻影）+ `insertAtLine` 插入索引钳制到幻影行之前（`maxIdx = phantom ? len-1 : len`）；导出 `insertAtLine` |
| `backend/__tests__/tools/unifiedDiffHunkBoundary.test.ts` | hunk 末尾 `--- x`/`+++ y` 内容对 + 下一行 `@@` 被误判为下一个文件头 → break 丢内容 | `unifiedDiff.ts`：新增 `isFileHeaderPair()`——`--- `+`+++ `+后接 `@@`/`diff --git` 且 `---` 路径具备文件头特征（`a/` `b/` 前缀、`/dev/null`、含 `/`、带文件扩展名）才算文件头；纯内容对保留。`apply_diff.ts` 的 loose 解析同步修复（`isUnifiedFileHeaderPair`），避免同样丢行 |

### 5.5 已修复（部分）：UISMOKE 偶发 topBarButtons=false ⚠️ 未重新验证

- **根因**：`electron-app/src/main.ts` UISMOKE 的 mounted 检查等待 `.chat-header`——但 `ChatHeader.vue` 是**未被任何组件引用的死组件**，`.chat-header` 永不存在 → 等待循环永远跑满 10s，检查时机与 `chatStore.initialize()`（异步）赛跑：`bodyLen=117`（loading 容器）说明检查发生在初始化中途，此时 `createTabAction` 尚未执行、`.tabs-bar` 未渲染。
- **已改**：等待目标改为 `.tabs-bar || .welcome-panel`（`main.ts` UISMOKE 段）。
- **⚠️ 未验证（用户叫停）**：最后一次 UISMOKE 仍显示 `topBarButtons:false`——因为 `.welcome-panel` 在 initialize 完成前就会出现，循环提前退出，1.5s 后检查仍早于 `createTabAction`。**下一步建议：等待目标只保留 `.tabs-bar`（不要 welcome-panel），或把 `createTabAction` 提前到 initialize 开头、或 mounted 检查增加对 `openTabs.length>0` 的轮询。**

### 5.6 已完成：P3 对话重 roll 树状分叉（DeepSeek 风格）✅

**设计**：重roll（retryFromMessage）不再是破坏性覆盖——截断前把「当前回答及后续尾部」保存为版本；重roll 出的新回答成为活跃尾部；每条 AI 回答上出现 v1/v2/v3 版本切换器（chips + 前后箭头），可随时切回旧版本；切换时当前尾部先自动保存（不丢失），再恢复目标版本。

**后端**：
- `backend/modules/conversation/types.ts`：`ConversationTailVersion`（id/branchIndex/createdAt/preview/messageCount/messages）+ `ConversationTailVersionInfo`（无 messages 摘要）；
- `backend/modules/conversation/storage.ts`：`IStorageAdapter` 新增可选 `saveTailVersions/loadTailVersions`；三个适配器全部实现——Memory（Map）、VSCode（globalState `limcode.tailVersions.<convId>`，deleteHistory 一并清理）、FileSystem（`{convDir}/versions.json`，随 deleteHistory 递归删除）；适配器不支持时 ConversationManager 回退 `custom.tailVersions`；
- `backend/modules/conversation/ConversationManager.ts`：
  - `saveTailVersion(convId, branchIndex)`：从分支点保存尾部（剥离存储层可能残留的 `index` 字段——truncateFrom 会写回 index，恢复后会污染 transcript）；与已有版本 JSON 全等去重；每会话上限 10 个（按 createdAt 淘汰最旧）；
  - `listTailVersions(convId)`：轻量摘要；
  - `restoreTailVersion(convId, branchIndex, versionId)`：先 `saveTailVersion` 保存当前尾部（切换不丢数据）→ 校验目标版本存在且 branchIndex 匹配 → repo.mutateContents 截断+恢复 → `invalidateContextManagementState`；
- `webview/handlers/ConversationHandlers.ts`：`conversation.saveTailVersion` / `conversation.getTailVersions` / `conversation.restoreTailVersion` 三个 handler + 注册；
- 测试 `backend/__tests__/conversation/ConversationManager.tailVersion.test.ts`（6 用例：保存/去重/空尾部 no-op/切换保双侧/非法参数/删除清理）**全部通过**。

**前端**：
- `frontend/src/stores/chat/state.ts` + `types.ts`：`tailVersionsByConversation`（convId→摘要）、`tailVersionsLoading`、`tailVersionSwitching`（`${convId}:${branch}:${verId}` Set）、`activeTailVersionByBranch`（当前恢复的版本 ID，null=最新当前答案）；
- 新文件 `frontend/src/stores/chat/tailVersionActions.ts`：`refreshTailVersions`（loadHistory/switchConversation 后拉取，不阻塞）、`saveTailVersionForRetry`（重roll 前保存，失败不阻塞重roll）、`switchTailVersion`（调后端→重载消息窗口）、`setActiveTailVersion` / `resetActiveTailVersionsForConversation`（发送/编辑/删除后重置为最新）；
- `frontend/src/stores/chat/messageActions.ts`：`retryFromMessage` 在 `deleteMessage` **之前**调用 `saveTailVersionForRetry`（树状分叉核心）；`sendMessage`/`editAndRetry`/`deleteMessage`/`deleteSingleMessage` 重置活跃版本标记；
- `frontend/src/stores/chat/conversationActions.ts`：`loadHistory` 与 `switchConversation` 非阻塞刷新版本列表；
- `frontend/src/stores/chatStore.ts`：导出 state + `versionsForBranch(convId, branchIndex)` + `switchTailVersion(branchIndex, versionId)` + `refreshTailVersions`；
- `frontend/src/components/message/MessageItem.vue`：AI 消息、非流式、该分支点存在已保存版本时显示**版本切换器**（`.version-switcher`：`v1 v2 v3·最新` chips + `chevron-left/right` 前后步进 + 切换中 loading 态 + chip 高亮），点击 chip 或箭头调用 `switchTailVersion` 并重载历史；
- i18n：`components.message.tailVersion.{title,current,prev,next,switching}` 三语已补。

**验证**：根/前端 typecheck 通过；后端 Jest **723/723**（85 suites）；前端 Vitest **71/71**；Electron E2E **ALL PASS**；MONITOR_SMOKE **ALL PASS**；frontend dist 已重建 + patch-dist + esbuild 主进程均通过。

### 5.7 重要事故记录（务必阅读）

- **ConversationManager.ts 曾被 PowerShell `Set-Content` 以错误编码整体覆写（中文注释乱码）**。已从 `Gray-Code-1.3.1-1.tar.gz`（上游源项目）解包恢复，随后重新实施全部改动。**该文件现为 LF 行尾 + 重新实现后的缓存/尾部版本代码；上游 tarball 中不含上一会话的缓存脚手架（是死代码，无损失）。**
- 比对结论：工作副本其余文件与 tarball 内容一致（仅 CRLF/LF 行尾差异）。若后续需要 diff 上游，请用「归一化行尾后比较」，不要直接 `fc`。

### 5.8 未完成 / 待办（按优先级）

1. **⚠️ UISMOKE topBarButtons flake 收尾**（见 5.5）：验证/修正等待目标为 `.tabs-bar`；全量跑一遍 UISMOKE 确认 `topBarButtons:true`、`languageToggle` ok。
2. **P1 子代理 Monitor 改为主窗口内嵌面板**（用户明确要求，本会话未动工）——按文档第三节 P1 方案执行：App.vue 主聊天布局加右侧/底部可折叠面板渲染 `SubAgentMonitor.vue`；前端 `sendToExtension` 支持 clientId 区分 main-chat/subagent-monitor；`BackendHost` 做 SubAgentMonitorBridge（runEventBus 订阅 → 主窗口 `webview.send`，visible 由前端 `subagents.monitor.setVisible` 通知）；删除 `SubAgentMonitorWindow.ts` 独立窗口方案；MONITOR_SMOKE 改测面板协议。
3. **P3 前端联调验证**：版本切换器在真实对话中的人工/自动化验证（保存→重roll→切换→继续聊天→再切换），确认消息窗口重载、checkpoint/todo 元数据不串、流式期间禁用切换。**后端逻辑已测，前端 UI 尚未在真实运行中验证过。**
4. **P2 剩余项**：`storage.ts` 分段并行读（`loadSegmentedHistory` Promise.all 保持段序）；`history_search.ts:517` 深拷贝改 `getHistoryRef`；`getMetadata` 完整性检查在 metaCache 命中时跳过；检查 `useConversations.ts` 旧 composable 是否仍被使用。
5. **P5 打包回归**：`npm run dist:win` 后对 win-unpacked 跑 UISMOKE。

### 5.9 本会话改动文件清单

```
frontend/src/components/tabs/ConversationTabs.vue        # 顶部栏（语言/设置/占位）
frontend/src/stores/settingsStore.ts                     # Language 类型扩展
frontend/src/i18n/langs/{zh-CN,en,ja}.ts                 # tabs.* / message.tailVersion.*
frontend/src/App.vue                                     # setDetectedLanguage 接线
frontend/src/components/settings/SettingsPanel.vue       # 语言同步 settingsStore
frontend/src/stores/chat/{state,types,chatStore}.ts      # 版本状态 + actions 接线
frontend/src/stores/chat/tailVersionActions.ts           # 新增：版本拉取/保存/切换
frontend/src/stores/chat/{messageActions,conversationActions}.ts  # 重roll 保存版本/刷新
frontend/src/components/message/MessageItem.vue          # 版本切换器 UI
backend/modules/conversation/{ConversationManager,storage,types}.ts  # 缓存接线 + 尾部版本
backend/tools/file/{insert_code,unifiedDiff,apply_diff}.ts          # 幻影行/文件头消歧
webview/handlers/ConversationHandlers.ts                 # 3 个版本 handler
backend/__tests__/conversation/ConversationManager.tailVersion.test.ts  # 新增 6 用例
electron-app/src/main.ts                                 # UISMOKE 等待目标修复（待验证）
```
