# Change Log (GrayCode Desktop)

本文件记录 GrayCode Desktop（Electron 独立桌面版）的变更。
桌面版基于 GrayCode VS Code 插件（backend/webview 代码）复用构建；
插件本体（backend / frontend 公共部分 / webview）的变更见根目录 `CHANGELOG.md`。

This file tracks changes to the GrayCode Desktop (standalone Electron edition).
Changes to the shared plugin codebase (backend / webview / shared frontend)
are tracked in the root `CHANGELOG.md`.

## [1.6.0] - 2026-08-05

### Merged
  - 同步合入上游 c7d2e16（PR #8：分支 UI/流式竞态/上下文裁剪 fallback 稳定/总结请求去图/编辑保持当前分支/工具安全）：详见根 `CHANGELOG.md` [Unreleased]；桌面版公告/版本信息（扩展 stub）同步为 v1.6.0

### Fixed
  - 修复打包版（安装版/便携版/zip）通用界面版本号恒为 0.0.0：打包产物只包含 `dist/`，根 `package.json`（运行时版本唯一来源）与 `CHANGELOG.md` 未被打入，所有版本读取（设置页应用信息、About 对话框、版本更新公告）都落到兜底 `0.0.0`，公告逻辑因版本恒等而永不弹新版本更新内容；现在 electron-builder `extraResources` 追加根 `package.json` 与 `CHANGELOG.md`（`resources/package.json`、`resources/CHANGELOG.md`），运行时读取路径不变即可拿到真实版本号与变更日志
  - 修复便携版（GrayCode-Portable-*.exe）数据目录解析错误：portable 启动器把程序解压到 `%TEMP%` 运行并在退出后整目录删除，`app.getPath('exe')` 指向的是临时目录——按旧逻辑数据目录落在临时目录里，每次退出全部数据（设置/会话/记忆/用量）丢失、更新替换 exe 后也表现为「全新应用」且无法核对版本；现在检测到 `PORTABLE_EXECUTABLE_DIR`（启动器注入的便携 exe 实际所在目录）时数据写入该目录旁 `data/`，与安装版/zip 语义一致（复制应用目录即得独立实例），替换 exe 升级后数据保留

## [1.5.2] - 2026-08-04

### Merged
  - 同步合入上游 150a287（分支 reroll/编辑前端主流程接线、删除消息同步分支图、后台回执上下文骤降修复、子代理工具本地化）：reroll/编辑分支流的候选切换、后台回执上下文骤降修复与分支流失败可重试等详见根 `CHANGELOG.md` [1.5.2]；桌面版公告/版本信息（扩展 stub）同步为 `czocelot.graycode` / v1.5.2

## [1.5.1] - 2026-08-04

### Added
  - 代码查看面板自动打开工作区文件树：面板打开即列出工作区根目录（复用新 IPC `listWorkspaceDirectory`，工作区包含校验 + 默认忽略 `.git`/`node_modules`/`dist` 等重型目录），目录懒加载展开、文件点按即查看代码；工具栏新增文件树开关与刷新按钮；相对路径打开改为拼接工作区根 URI（修复 `file://相对路径` 被解析成 authority 导致工作区文件无法打开的问题）
  - 变更查看面板展示并比对上一轮变更：已处理（已接受/已拒绝）条目在关闭面板后保留，重新打开可继续查看与比对历史 diff；条目按「轮」分组（连续推送为同一轮，间隔超过 2s 视为新一轮），文件列表显示「第 N 轮」轮次分隔；全部处理完毕后显示提示条；新增「清空历史」按钮

### Fixed
  - 修复已接受的变更通过工具卡「查看差异」再次打开时状态被重置为待处理、重新出现接受/拒绝与全部接受/全部拒绝按钮：已处理条目保持已解决状态，且非待处理条目不渲染接受/拒绝按钮，历史变更只读查看与比对
  - 修复 SSE 心跳事件污染解析累积器导致长流被误判失败并反复超时重试：`data: keep_alive`/`keep-alive`/`ping`/`heartbeat` 等非 JSON 心跳行不再混入跨行 JSON 累积，后续真实事件可正常解析，纯心跳流结束时不再误入错误详情（详见根 `CHANGELOG.md` [1.5.1]）
  - 修复代理 CONNECT 后 socket 空闲定时器残留把长流掐断：握手成功即 `socket.setTimeout(0)` 解除固定超时，流的空闲超时统一由可重置计时器管理（收到任何字节都会续期）
  - 修复 LLM 模块缓存保活未正确判定成功 + 与流空闲超时脱节：非 2xx 保活响应不再误报成功（瞬时失败自动重试一次）；首个保活提前到「流空闲超时前 10 秒」并成功后刷新流空闲超时，上游静默思考期间流不再被固定超时掐断（详见根 `CHANGELOG.md` [1.5.1]）
  - 修复重试成功事件过早触发（重试页面在重试请求完成前消失）：`retrySuccess` 改为本次尝试流真正结束后广播；修复请求级 `retryStatusCallback` 从未被读取（SubAgent → Monitor 重试状态路由失效）；新增 ChannelManager 重试链路回归测试 4 例与重试面板生命周期前端测试 5 例（详见根 `CHANGELOG.md` [1.5.1]）
  - 修复超时重试面板近乎透明、可读性差：重试面板/头部/错误块全部改为不透明主题色背景
  - 新增变更查看 Store 单元测试 7 例（详见根 `CHANGELOG.md` [1.5.1]）

## [1.5.0] - 2026-08-04

### Security
  - 修复 `graycode://` 自定义协议可读取用户数据目录（含 API Key 与全部对话历史，默认 `data/` 位于 REPO_ROOT 内）：服务根收窄为静态资源白名单（`frontend/dist`、`resources`、`renderer`），用户数据目录显式排除；hostname 强制为 `local`（`graycode://evil/` 拒绝）；500 错误返回固定文案，不再向渲染层回显内部路径/错误细节
  - 修复 openPath/showInFolder 可执行扩展名黑名单不完整：补充 `.hta` / `.lnk` / `.url` / `.reg` / `.iso` / `.vhd` / `.vhdx` / `.docm` / `.xlsm` / `.pptm` / `.svg`，阻断「AI 在工作区写入恶意文件 → 用户打开 → 任意代码执行」链路
  - 修复 MCP stdio 客户端 Windows 下经 cmd.exe shell 启动、args 可被二次解释：改 `shell: false` 直连 spawn
  - `fs:exists` native op 增加字符串类型校验（非字符串路径不再抛 TypeError）

### Fixed
  - 修复前端 rebuild 后图标/徽标全丢（根因：`npm run build` 重新生成 dist 冲掉 patch-dist.mjs 注入的 codicon `<link>`）：codicon 字体 CSS 与 theme.css 同策略改为主进程运行时注入（`insertCSS`），相对字体 URL 重写为绝对 `graycode://local/resources/codicons/...`（否则按页面路径解析 404）；注入按 key 幂等管理（reload 先移除旧样式，顺带修复规则翻倍累积）
  - 修复 `workspace.fs.delete` 忽略 `useTrash` 导致永久删除：`useTrash: true` 时走 `shell.trashItem` 进回收站，与 VS Code 语义一致
  - 修复 applyEdit 对已删除文件静默重建残缺文件：ENOENT 明确报错
  - 修复 documentCache 无界增长（长会话 GB 级膨胀）：100 条 LRU 上限
  - 修复 overlay toast 超时自动移除但从不回执：移除前发送 `host.toastReply { id, selected: undefined }`，后端 `showMessage` Promise 不再永久挂起
  - 修复后端初始化失败静默白屏 + unhandled rejection：弹原生错误对话框（可打开数据目录或退出）
  - 修复 `will-navigate` 前缀校验过宽（`graycode://evil/` 等 host 变体）：严格限定 `graycode://local/`

### Added
  - 代码查看面板与变更查看面板的基础语法检查能力（引擎/入口与主项目同步，详见根 `CHANGELOG.md` [1.5.0]）

## [1.4.0] - 2026-08-04

### Fixed
  - 修复存在最近对话栏（欢迎面板历史列表）时无法发送消息：渠道只配置了 `models` 列表而未显式选择 `model` 时（`model` 为空字符串），前端 `currentModel` 为空导致发送按钮被禁用、消息永远发不出去；现在 `ConfigManager` 创建/更新/读取三个路径统一回退到 `models[0]`（读取路径只作用于副本不污染缓存，更新路径自动修复历史坏数据），前端 `loadCurrentConfig` 与输入区 `currentModel` 同步兜底；新增 6 个后端回归用例 + UISMOKE `sendFromEmpty` 步骤（欢迎面板可见时输入并发送，断言用户消息卡片出现）
  - 便携式多实例：所有数据（会话/设置/工作区/记忆/用量/缓存）默认写入应用目录下 `data/`，不再写入系统路径（AppData/Program Files）——复制应用目录即得完全独立的实例，互不影响；`--user-data-dir <path>` / `GRAYCODE_USER_DATA_DIR` 仍可显式覆盖

### Added
  - 变更查看面板（Diff Viewer）：由全屏模态框改为**主窗口内嵌 GitHub 风格面板**（右侧抽屉，非独立窗口，运行逻辑与 SubAgent Monitor 内嵌面板一致）。`vscode.diff` 拦截 → `host.openDiffPreview` 命令 → 打开面板：左侧文件列表（状态徽标 + ±行数统计），右侧统一 diff（hunk 头 `@@ -a,b +c,d @@` + 双行号 + 增删着色），支持单文件/全部接受与拒绝、删除警戒提示、`diff.statusChanged` 状态同步；accept/reject 复用 VS Code 版同一协议（`electron-app/renderer/overlay.js` 的模态框已移除）
  - 行级 diff 算法抽取为公共工具 `frontend/src/utils/diffLines.ts`（LCS 行匹配 + hunk 分组 + 统计），write_file 工具卡改用它，删除重复实现；配套 Vitest 12 例
  - UISMOKE 新增 `diffPanel` 步骤：命令打开面板 → 断言文件列表/增删行/hunk 头 → 关闭按钮收起（防回归）
  - 新增快速启动脚本：`start.bat`（Windows）/ `start.sh`（macOS/Linux）——按需安装依赖并增量构建，双击或一条命令即可启动；`--rebuild` 参数强制全量重建
  - 子代理 Monitor 改为主窗口内嵌面板（右侧分区，替代独立 BrowserWindow）：不再占用任务栏；顶部栏新增 Monitor 开关按钮，工具卡「打开详情」直接聚焦对应 run；面板可折叠，折叠时后端自动停止推送高频流式事件（llm_delta 50ms 合并节流，重新打开按 revision 校准）
  - 顶部栏常驻化：无标签页时显示 GrayCode 占位标题，右侧固定「SubAgent Monitor 开关 / 语言切换 / 设置齿轮」，语言在 简体中文 → English → 日本語 → Auto（跟随系统）间循环并持久化
  - 日文语言包接入全部工具卡/终端组件（旧 i18n 链路补齐 ja 与 auto 解析）；「跟随系统」模式接线系统语言检测
  - 首次运行引导（Welcome / 配置 API 渠道）只显示一次：已显示过或已配置真实 Key 后不再弹出（持久化标记）

### Fixed
  - 修复设置齿轮与语言切换按钮缺失（多次回归根因：顶部栏被回退为上游版本）；改为常驻渲染后 UI 冒烟测试稳定
  - 修复 `showQuickPick` 丢弃 options 且 `canPickMany` 返回形状错误（Diff 多块选择 `selected.some is not a function` 崩溃）：options 转发渲染层，多选返回数组
  - 修复后端自动打开的 Diff 预览左栏恒空：`vscode.diff` 的 `gemini-diff-original:` 分支经 `resolveOriginalContent` 从 DiffManager 实况补取原始内容
  - 修复 glob 花括号 `{a,b}` 永不匹配（`find_files` 的 exclude 规则全部失效）；重构为未锚定正则拼接
  - 修复 `findFiles` 并发遍历饿死深层目录与多工作区同相对路径互相吞结果：8 路并发 + 空队列不推进游标 + 去重键改绝对路径
  - `workspace.fs.readFile` 改为零拷贝 Buffer 视图，大文件读取不再产生整份复制

## [1.3.1] - 2026-08-03

### Added
  - Electron 独立桌面版首版：完整复用 GrayCode v1.3.1 后端（渠道/对话/工具/diff/MCP/子代理/检查点/记忆/技能/用量）与 Vue3 前端，脱离 VS Code 运行
  - `vscode` API 兼容层（`vscode-shim.ts`）：Uri / workspace.fs / 配置 / 对话框 / diff 命令 / findFiles / openTextDocument / 主题等，esbuild alias 内联进主进程 bundle
  - `graycode://` 自定义协议服务前端与资源（MIME 表 + mtime 内存缓存），规避 `file://` 的 fetch/audio CORS 限制
  - Diff 预览模态框（接受/拒绝/逐块），`vscode.diff` 命令拦截 + sessionId 异步解析（3s 轮询兜底）
  - Overlay：toast / quickPick / inputBox / 无工作区提示 / 首次运行 Welcome（DOM-ready 守卫）
  - 多语言 UI（简体中文 / English / 日本語）+ 顶部栏新建标签 / 语言切换 / 设置齿轮
  - 首次运行引导与无工作区提示；工作区选择与持久化、失效目录自动降级提示
  - 子代理 Monitor 独立窗口版（后续版本已改为内嵌面板）；run 卡片「继续」按钮与前后台任务状态回流
  - 打包：electron-builder（win NSIS/zip、mac dmg/zip、linux AppImage/deb）+ GitHub Actions 三平台 CI
  - 测试体系：后端 E2E（7 场景 40+ 断言）、UI 冒烟（UISMOKE）、MONITOR_SMOKE、mock MCP 服务器

### Fixed
  - 修复「无法打开项目文件夹」：WorkspaceFolder 补 `fsPath` 字段 + `Uri.toString()` 输出标准 `file:///` 格式
  - 修复 macOS activate 重复注册 IPC 导致消息执行两次
  - 修复 overlay.js 在 body 就绪前执行导致 appendChild 报错（DOM-ready 守卫）
  - 修复自定义协议 MIME 缺失/大小写敏感路径校验（Windows 路径归一化）
  - 修复 diff 预览右栏恒空与 sessionId 失效（两种 diff 路径分别处理）
  - 修复 findFiles 默认跳过 dist/build 导致 AI 无法检查构建产物（改为设置可覆盖）
  - 修复 workspaceState/globalState 导出 null（JSON 文件持久化）
  - 修复 `require('./vscode-shim')` 打包后必崩（改为具名导入）
