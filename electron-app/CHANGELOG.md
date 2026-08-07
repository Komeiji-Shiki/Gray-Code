# Change Log (GrayCode Desktop)

本文件记录 GrayCode Desktop（Electron 独立桌面版）的变更。
桌面版基于 GrayCode VS Code 插件（backend/webview 代码）复用构建；
插件本体（backend / frontend 公共部分 / webview）的变更见根目录 `CHANGELOG.md`。

This file tracks changes to the GrayCode Desktop (standalone Electron edition).
Changes to the shared plugin codebase (backend / webview / shared frontend)
are tracked in the root `CHANGELOG.md`.

## [1.6.9] - 2026-08-07

### Merged
  - 增量合入上游 `70ecbb3..cf9330d` + 80e9de7 修正版（backend/webview/frontend 公共部分，详见根 `CHANGELOG.md` [1.6.9]）：记忆隔离作用域加固（只读不建目录 / scope 显式参数 / 不静默回退全局 / T= 快照重试）、H4 自动建会话即绑定工作区、记忆设置页作用域配置隔离（`listMemoryScopes` 当前激活工作区优先）、子代理工具轮幻觉剥离、nodeIdCache epoch 写链守卫、存储统计纳入记忆目录；80e9de7 以上游修正版合入（混合形态 tool 消息拆分 + 日常形态回归防护，上游原版会破坏 function_call 模式）

### Fixed
  - 修复 `memory_wake` 跨作用域 snapshotT 不匹配静默丢内容（改用该作用域当前总数重试）
  - 修复只读记忆工具隐式创建 `memory-workspaces/<hash>/` 目录的磁盘副作用
  - 修复工作区记忆解析失败静默回退全局的跨工作区污染（改为显式报错）
  - 修复自动创建会话未绑定工作区导致记忆工具回退全局（H4）
  - 修复子代理失败/空响应时 partialResponse 携带幻觉预生成文本
  - 修复混合形态消息（同消息 call+response）转换时 functionResponse 被吞（80e9de7 修正版）

### Changed（1.6.9 迭代二，公共部分详见根 `CHANGELOG.md`）
  - **子代理界面可选择模型**：设置 → 子代理「模型」下拉框实时拉取 provider 模型列表 + 渠道默认模型兜底（此前选项恒为空，只能选渠道）；新建子代理对话框补齐模型选择
  - **全局 diff 绑定对话 + gzip 无损压缩**：diff 内容落盘到对话目录并写入归属索引（删除对话即可清理），不再无限写入 `__global__`；gzip 压缩后磁盘占用降低 3-5 倍；旧版明文文件读取兼容
  - **`memory_wake` 分页/续读历史残留移除**：单次输出双作用域全部可用记忆，移除 part/snapshotT 续读机制与 partChars/partLines 配置项
  - **稳定性修复**：流式终结事件视图缺失不丢（占位消息不再永久「生成中」）、waitForIdle 超时兜底、会话删除后幽灵分支文件拦截、`maxIterations=-1` 工具循环硬性兜底（迭代/墙钟上限）、早启动工具系统异常不再伪装成工具失败、流式重试非内容 chunk 不再重复产出、子代理默认运行时长常量统一

### Tests（1.6.9 迭代二）
  - backend jest 226 套件 / 2302 用例、frontend vitest 63 文件 / 610 用例、tsc 与生产构建全绿

## [1.6.8] - 2026-08-06

### Fixed
  - **对话工作区独立（已关闭的绑定工作区仍然生效）**：桌面版切换「打开的工作区」后，绑定工作区的文件夹从 `workspaceFolders` 移除，工具路径解析静默回落到当前打开的工作区——对话上下文与工具读写不一致（backend/webview 公共部分，详见根 `CHANGELOG.md` [1.6.8]）：解析层新增虚拟工作区能力，绑定工作区关闭后工具/文件树/搜索/命令仍限定原工作区
  - **打开/保存工作区（多工作区收藏）桌面版失效的根因修复**：`vscode-shim` 的 `showOpenDialog` / `showSaveDialog` 此前把 native 层 Electron 形状（`{ filePaths, canceled }` / `{ filePath, canceled }`）原样返回，而调用方按 VS Code 契约消费（`result.length` / `result[0].fsPath` / `result.fsPath`）——工作区选择器「打开工作区文件夹」弹窗选完目录后永远被判为取消，收藏列表既存不进也打不开，存储路径选择与设置导入/导出同受其害。现 shim 统一转换为 VS Code 契约（`Uri[] | undefined` / `Uri | undefined`），桌面版工作区收藏「保存 + 打开 + 重启保留」链路端到端打通
  - **设置导入/导出对话框 filters 形状不匹配（同族）**：`native.ts` 新增 `normalizeDialogFilters`，把 VS Code 对象形状的 `filters` 转换为 Electron `[{ name, extensions }]` 数组，导入/导出对话框的 JSON 过滤恢复生效
  - **桌面版 `env.openExternal` 拒绝 `file:` URI**：shim 对 `file:` 方案的 Uri 改走 `shell:openPath`（「打开 Skills 目录」等按钮恢复可用）
  - 版本号 1.6.8，electron-app/package.json 同步（详见根 `CHANGELOG.md` [1.6.8]）

### Added
  - 设置页设置项搜索（frontend 公共部分，详见根 `CHANGELOG.md` [1.6.8]）：桌面版同样生效——搜索框 + 结果下拉 + 侧边栏命中高亮 + 跳转定位闪烁

## [1.6.6] - 2026-08-06

### Added
  - **工作区选择器收藏（多工作区收藏列表）**：顶部栏文件夹图标下拉重写为自定义菜单，支持收藏多个工作区文件夹（globalState 持久化，跨窗口/重启保留）、条目 × 一键移除、底部「打开工作区文件夹…」加号入口；新增 webview 处理器 `workspace.getSaved` / `workspace.removeSaved` / `workspace.openFolder`，Electron 主进程新增原生操作 `workspace:openFolder`，vscode-shim 支持 `vscode.openFolder` 命令——收藏工作区点击即打开（替换当前工作区并持久化到 workspace state、窗口标题同步更新），三语文案补齐（公共部分详见根 `CHANGELOG.md` [1.6.6]）

### Changed
  - **仓库改名同步**：`czocelot/Gray-Code-ocelot` → `czocelot/Gray-Code-Desktop`（electron-app/package.json 的 author.url / homepage；其余 README/设置页链接同步，详见根 `CHANGELOG.md` [1.6.6]）；桌面版构建产物版本同步为 v1.6.6

### Fixed
  - **多对话并发编辑多工作区**（backend 公共部分，详见根 `CHANGELOG.md` [1.6.6]）：checkpoint 存档按对话绑定工作区裁剪快照与文件锁范围（不再持有全局根锁阻塞其他工作区的写工具）；写锁 key 按对话工作区解析为绝对路径（消除跨工作区同名相对路径的误冲突/漏锁）——桌面版多 tab 并发流式 + 多工作区并行编辑由此端到端可用

## [1.6.4] - 2026-08-05

### Merged
  - 同步合入上游 49a37f2..10c565c（PR #11/#13：启动动画、TPS 实时可视化与流式平滑输出、上下文预算三层重构、diff 行级差分缓存、子代理 transcript 索引投影、fork 性能优化回移植）：详见根 `CHANGELOG.md` [1.6.4]；桌面版构建产物版本同步为 v1.6.4

### Changed
  - 工作区文件树 30s TTL 缓存（gitignore mtime 失效）、`getMetadataLight` 缓存命中改 `structuredClone`、`getCustomMetadata` 走 metaCache、`getMetadata` fallback 回填缓存、SubAgent flushPersist 单次原子写、分支图内存缓存、HistorySegmentCache 字节估算改抽样、i18n 占位符正则缓存、工具结果合并/toolLocalization 收敛、消息项 content-visibility、ToolMessage 倒计时 50→200ms、Shell 可用性缓存 5 分钟 TTL、流式热路径诊断日志加性能开关（以上均为 backend/frontend 公共部分，详见根 `CHANGELOG.md` [1.6.4]）
  - Electron 主进程/预加载脚本生产构建压缩（`minify: true`，关闭 sourcemap）：安装体积与启动解析时间下降
  - `readRootPackageMetadata` memoize（打包后 package.json 不变，公告/版本检查不再重复同步读盘）；`__setWorkspaceFolders` 差集事件（修复技能重复扫描与移除不清理）；dialog/reload 对已销毁窗口加固
  - `build.mjs` 支持 `--dev`（sourcemap/未压缩）与 `--watch`；新增 `typecheck` script（首次接入即修复工作区变更监听从未 dispose 的隐患）；author 补 email 字段（Linux deb maintainer）
  - 前端主入口分包（vue/highlight/katex vendor chunk，主入口 2.38MB→1.55MB，mermaid 保持懒加载）；公告 CHANGELOG 解析 mtime 缓存（backend 公共部分）

### Fixed
  - 移除无引用的运行时依赖 `@vscode/codicons` 与 `nanoid`（根 package.json，详见根 `CHANGELOG.md` [1.6.4]）
  - 设置持久化丢失（自动执行/工具策略/预设条目开关重启回滚）：VSCodeSettingsStorage 快照改存深拷贝 + 各写点整体替换对象（backend 公共部分，详见根 `CHANGELOG.md` [1.6.4]）
  - 原始记忆条目新增单条删除（设置页此前无删除入口；MemoryManager.deleteEntry + deleteMemoryEntry handler + 三语确认框，详见根 `CHANGELOG.md` [1.6.4]）

## [1.6.3] - 2026-08-05

### Merged
  - 同步合入上游 49a37f2（PR #10：子代理续跑同 run 身份与 transcript、分支树面板重构为轨道式泳道「完整消息图」+ 工具分类分组、总结模型透传（手动/自动/独立总结渠道）、上下文管理关闭时手动总结边界生效、MCP server ID 可读化）：详见根 `CHANGELOG.md` [1.6.3]；桌面版构建产物版本同步为 v1.6.3

### Changed
  - 默认对话标题自动附加工作区名（格式 `标题 [工作区名]`，无工作区时不加）：多项目同时编辑时对话列表 / 标签页 / 历史页可按项目区分（前端公共部分，详见根 `CHANGELOG.md` [1.6.3]）

### Fixed
  - 多工作区一致性修复（前端公共部分）：切换绑定工作区的对话时同步激活工作区、历史页「当前工作区」筛选纳入未绑定对话、工作区重绑定失败回滚、分支对话创建不再错误兜底激活工作区（详见根 `CHANGELOG.md` [1.6.3]）
  - 性能优化（backend 公共部分）：`getMetadataLight` 走 metaCache 免磁盘 IO（对话列表 / 用量统计 / 检查点查询受益）、`usedTokens` 单趟逆序扫描、消息占位定位 Map 索引化（详见根 `CHANGELOG.md` [1.6.3]）

## [1.6.2] - 2026-08-05

### Fixed
  - 修复退出不等待 `BackendHost.dispose()`（异步写队列被截断，设置/对话/用量落盘中途丢失）：`before-quit` preventDefault + await dispose + 10s 超时兜底 + `app.exit(0)`（macOS 关窗不退出语义保留）
  - 修复 `mainWindow.loadURL()` 无 catch：页面加载失败（损坏安装/资源缺失）时 unhandled rejection 直接崩主进程，改为弹错误对话框后退出
  - 新增单实例锁：便携版/安装版重复启动会并发写同一 `data/` 目录（多文件非原子写，配置互相覆盖、memento 丢失）；`requestSingleInstanceLock` 未获锁即退出，`second-instance` 聚焦已有窗口
  - 修复主进程无 unhandledRejection 保护（Node 22 默认终止进程）：入口安装只记录不崩溃的守卫（EPIPE 由既有守卫兜底）
  - 修复 IPC 消息队列无超时：任一阻塞 handler 等渲染层回复永不到达（toast 未渲染/面板隐藏/渲染层重载）时整条队列死锁，后续全部 IPC 永久挂起；每条消息加 60s 超时并回 `HANDLER_TIMEOUT` 错误
  - 修复 `pendingToasts` 只增不删：showMessage/showQuickPick/showInputBox 的等待 Promise 无 TTL，泄漏挂起；加 5 分钟 TTL 自动 resolve(undefined)（调用方按取消处理）并清理定时器
  - 修复 `vscode-shim` 硬编码 `version: '1.99.0'`：改为读取根 `package.json` 版本，与扩展真实版本同源
  - 修复 `JsonFileMemento.update` 非原子写：并发 update 交错写盘互相覆盖丢更新、写一半崩溃留下损坏 JSON（下次启动静默清空）；改为 tmp+rename+串行写队列（与 JsonConfigStore.save 同款）
  - 修复安装版数据目录写入受保护位置（Program Files 等）时数据静默丢失：写入前探测可写性，不可写回退 `appData/GrayCode` 并打印明确错误日志
  - 公告版本解析：CHANGELOG 正则不支持 `## [1.3.1-1]` 预发布条目、重复版本号重复展示；正则支持可选预发布段、compareVersions 遵循预发布 < 正式版、重复版本去重（backend 公共部分，详见根 `CHANGELOG.md` [1.6.2]）
  - 同步合入上游 PR #9 与全仓审查修复（backend/frontend/webview 公共部分）：详见根 `CHANGELOG.md` [1.6.2]；桌面版构建产物版本同步为 v1.6.2

## [1.6.1] - 2026-08-05

### Fixed
  - 修复主进程 stdout/stderr EPIPE 崩溃：输出重定向到管道且读取端提前关闭时，Node 把后续 `console.log` 的 EPIPE 当未捕获异常，Electron 主进程弹错崩溃（e2e 大量日志复现）；入口挂 stdout/stderr 错误守卫，仅吞 EPIPE
  - 修复 `BackendHost.previewToSessionId` 无界增长（500 条 FIFO 上限）
  - 修复 auto-open diff 路径 `resolveOriginalContent` 拿到空 previewId（计算提前，去掉对 filePath 兜底的隐性依赖）
  - 修复 `vscode.diff` shim 的 `preview` 字段语义反转（`options?.preview === true`）
  - 修复 dialog 无窗口时 `win!` 传 null 抛 TypeError（退化为无父窗口对话框）
  - 修复 `chat.awaitConversationIdle` 阻塞整条消息队列（加入 NON_BLOCKING_MESSAGE_TYPES）与前端等待无超时（20s 超时放弃本次 flush 重试，绝不提前写入回执）
  - 修复 `StreamAbortManager` 退休旧流 delete 且无新流接管时不唤醒 idleWaiters（纯停止场景后台回执永久挂起）
  - 同步合入第一/二轮全仓审查修复（backend/frontend/webview 公共部分）：详见根 `CHANGELOG.md` [1.6.1]

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
