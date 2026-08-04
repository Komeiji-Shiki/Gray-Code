# 开发计划与遗留事项（Plan）

## 1. 文档目的

本文记录 1.5.0 轮次的审计结论、已完成修复的摘要、尚未处理的遗留事项与后续工作计划。

本轮的完整变更明细见根目录 `CHANGELOG.md` [1.5.0] 与 `electron-app/CHANGELOG.md` [1.5.0]。

---

## 2. 本轮已完成（摘要）

### 2.1 审计

5 个子智能体并行扫描（backend / frontend / webview / electron / 全局安全），覆盖约 230 个后端源文件与全部前端/webview/Electron 源码，输出约 60 项问题，按严重度分级。

### 2.2 安全加固（高危全部关闭）

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| H-1 | `graycode://` 协议可读取含 API Key 的用户数据目录 | 服务根收窄为静态资源白名单 + hostname 强制 `local` + 500 固定文案 |
| H-2 | openPath 黑名单缺 `.hta/.lnk/.url/.reg/.svg` 等 → RCE 链 | 黑名单补齐 11 个可执行/携带代码扩展名 |
| H-3 | API Key 拼进 URL query | Gemini 计数与生图全部改 `x-goog-api-key` 请求头 |
| H-4 | MCP stdin 写入竞态可致扩展宿主崩溃 | error 监听 + spawn 失败立即拒绝挂起请求 + Windows 去 cmd shell |
| H-5 | 流式请求校验在 try 外 → 前端永久挂起 + 路由表泄漏 | 四处校验统一移入错误处理 |
| H-6 | `apply_diff` 重叠匹配 O(n²) 主线程 DoS | 匹配数上限 2 万 + 文件大小护栏 |

另修复：`diff.statusChanged` 类型写错、`subagents.monitor.setVisible` 缺失、附件无上限、排队消息丢失、SSE 错误被吞、schema 栈溢出、exec 命令拼接、日志敏感信息、CRLF 注入、原型链访问、glob 回溯等 30+ 项。

### 2.3 新功能

- 代码查看面板（`CodeViewPanel.vue` + `codeViewStore.ts`）：行号 + 高亮 + 错误行标记 + 诊断跳转 + 最近打开
- 变更查看面板接入基础语法检查：错误数徽标 + 诊断列表 + 「查看新内容」
- 纯前端语法检查引擎 `utils/syntaxCheck.ts`（JSON/C 系/Python/CSS/HTML/XML/Shell，零依赖，带护栏）
- Electron codicon 字体运行时注入（rebuild 不再丢图标，注入幂等）

### 2.4 验证状态（2026-08-04）

- 后端 typecheck ✅、前端 vue-tsc ✅
- 后端 Jest：88 套件 / 746 用例全过（含新增 MCP spawn 失败清理回归）
- 前端 Vitest：9 套件 / 100 用例全过（含新增 syntaxCheck 17 例）
- 扩展 esbuild 打包 ✅、Electron 主进程构建 ✅、前端 vite 构建 ✅
- 发布流程提醒：`npm run build`（frontend）后必须执行 `electron-app/patch-dist.mjs` 再启动桌面版（`npm --prefix electron-app run build:all` 已串联）；codicon/theme 已改运行时注入，图标不再依赖该补丁

---

## 3. 遗留事项与后续计划

按优先级排序；编号沿用审计报告编号。

### 3.1 P0 — 结构性安全加固（Electron 信任边界）

| 编号 | 事项 | 计划方案 |
| --- | --- | --- |
| H-3(desktop) | 渲染层 XSS = 主机沦陷：`toolConfirmation` 确认完全由渲染层自证，`createMcpServer` 可 spawn 任意命令 | ① 破坏性操作（delete_file / execute_command / apply_diff 落盘）确认改为主进程原生对话框（`dialog.showMessageBox`），结果不可由渲染层伪造；② `createMcpServer` 的 stdio `command` 白名单化（仅 node/npm 等可信命令）；③ 为 `chatStream`/`toolConfirmation` 增加会话内单调递增 challenge 防重放 |
| M-1(desktop) | 任意页面脚本可伪造 `host.toastReply` 兑现任意 pending 对话框 | 应答通道改为 `ipcRenderer.invoke` + 一次性 nonce（resolve 后立即失效）；校验 `selected` 必须是 items 中的元素 |

### 3.2 P1 — 数据一致性与健壮性（Electron shim）

| 编号 | 事项 | 计划方案 |
| --- | --- | --- |
| M-4(desktop) | applyEditImpl 读-改-写竞态：并发编辑同一文件丢更新；外部改动被静默覆盖 | 按 fsPath 串行化（复用 BackendHost 的 messageHandlingQueue 思路）+ 写入前 mtime 校验 |
| M-6(desktop) | JsonFileMemento 非原子写、无写队列，崩溃可能截断 JSON 丢状态 | 对齐 FileMemento：tmp + rename + 串行写队列 |
| M-9(desktop) | diffManager 状态监听器未登记 unsubscribers，dispose 后仍执行 | 包装后的 unsubscribe 推入 `this.unsubscribers` |
| M-10(desktop) | 渲染进程崩溃/无响应无处理（白屏无感知） | 监听 `render-process-gone` / `unresponsive`：弹提示并重载或退出 |
| L-3(desktop) | macOS 全窗口关闭后 `dialog.showOpenDialog(win!)` 抛 TypeError | win 为空时退化为无父窗口调用 |
| L-15(desktop) | `--user-data-dir` 无值保护（`argv[index+1]` 可能 undefined） | 参数值校验 |

### 3.3 P2 — 后端性能与边界

| 编号 | 事项 | 计划方案 |
| --- | --- | --- |
| M-5(backend) | 分段历史每次保存全量重写全部段 + 索引，长会话 I/O 放大 O(n²) | 只重写变化的尾部段（最后一个不变段之后），与现有 tmp+rename 崩溃安全策略兼容 |
| M-8(backend) | insert_code / delete_code 同步读文件无大小护栏（apply_diff 已修） | 统一 20MB 护栏 + `fs.promises` 异步读 |
| L-4(backend) | taskManager / execute_command 的 eventEmitter.emit 未捕获监听器异常 | emit 处 try/catch 每个监听器（对齐 McpManager.emitEvent） |
| L-7(backend) | MCP 工具 schema 未经内容规模校验即回传模型 | 单工具 description 长度与 schema 规模上限 |

### 3.4 P2 — webview 流式可靠性

| 编号 | 事项 | 计划方案 |
| --- | --- | --- |
| M-7(webview) | 视图重建空窗期流式终结事件被丢弃，占位消息永久「生成中」 | 重建时将活跃流 streamId 缓存，新视图 ready 后补发终结事件 |
| M-8(webview) | postMessage 返回值未接 rejection（潜在 unhandled rejection） | 统一 `void Promise.resolve(postMessage(...)).catch(() => {})` |
| L-1(webview) | `getRelativePath` 未处理 `vscode-remote://` 路径 | 按 URI scheme 分支解析 |
| L-5(webview) | 未知消息类型且无 requestId 时向主聊天广播空 requestId 错误 | 无 requestId 时静默忽略或仅日志 |

### 3.5 P2 — 前端状态与内存

| 编号 | 事项 | 计划方案 |
| --- | --- | --- |
| H-3(frontend) | 消息窗口裁剪后检查点永久丢失（上拉加载不补检查点） | 记录被裁剪检查点 ID 范围，窗口前移时按 backendIndex 补拉；或加载更早页时一并 loadCheckpoints |
| M-3(frontend) | MessageList 模块级 `messageListUiStateByTab` / `todoExpandedMap` 标签页关闭不清理 | closeTab 时联动删除 |
| M-6(frontend) | terminalStore `commandToTerminalId` exit 时不清脏映射 | exit 时反向扫描删除指向该 terminalId 的键 |
| L-1(frontend) | 死代码清理：`parseXMLToolCall`/`parseJSONToolCall`、重复 `getActualIndex`；`highlightText` 未转义 HTML（潜在 XSS 入口） | 删除或补转义后接入白名单 |

### 3.6 P3 — 纵深防御与依赖

| 编号 | 事项 | 计划方案 |
| --- | --- | --- |
| 安全 | `sanitizeHtml` 未剥离 `style` 属性、未过滤 `<svg>/<math>` | 补充 style 属性剥离与危险标签过滤 |
| 安全 | 设置导入可注册任意 MCP 服务器（连接即 spawn 任意命令） | 导入时逐条展示 command 并二次确认 |
| 安全 | Vite dev server CORS `allowedHeaders: ['*']` | 收窄为具体 vscode-webview 源（仅开发模式） |
| 依赖 | `tree-kill@1.2.2` 已 7 年未维护 | 替换为 `taskkill`/`process.kill` 进程树原生实现 |
| 测试 | 新面板与语法检查的 Electron E2E/UISMOKE 覆盖 | 补充 `codePanel` / `diffSyntaxBadge` smoke 步骤 |

---

## 4. 验收标准（本轮已达成）

1. `npm run typecheck`（根）与 `npm --prefix frontend run typecheck` 零错误。
2. `npm test` 全量通过（88 套件 / 746 用例）；`npm --prefix frontend test` 全量通过（9 套件 / 100 用例）。
3. 扩展打包 `node esbuild.config.js`、桌面版 `node build.mjs`、前端 `npm run build` + `node patch-dist.mjs` 全部成功。
4. 新面板：变更面板错误数徽标、诊断列表、代码面板打开/跳转/高亮可用；Electron 下图标字体运行时注入验证通过。
