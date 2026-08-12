# 1.7.15dev — 增量更新（墙钟时限可配置 + 上翻历史卡死修复 + 自动贴底自愈）

## ✨ 新增

- **无限制模式工具循环墙钟时限可配置**：新增全局设置 `graycode.maxToolLoopWallclockMinutes`（默认 30 分钟，-1 = 不设墙钟时限，仅保留迭代硬上限兜底）。仅在「单回合最大工具调用次数 = -1（无限制）」时生效，有限迭代模式语义零变化；工具设置页新增输入框并明确标注生效条件；VSCode 配置键可 Settings Sync，远控设置页同步镜像；三语 i18n。
- **伴生修复**：`maxToolLoopWallclockMs = -1`（不设墙钟时限）时原 guard 判断 `Date.now() > 0` 恒真会立即误触发 `TOOL_LOOP_WALLCLOCK_LIMIT`——guard 条件已补 `wallclockMs !== -1`。

## 🛠 修复

- **上翻历史过多时界面卡死（消息窗口无限增长）**：底部追加路径在 MAX_WINDOW_MESSAGES 内折叠，上翻路径此前从不裁剪，`allMessages` 与虚拟窗口随上翻无限增长，渲染 DOM/索引重建随轮次线性膨胀直至冻结。现上翻路径窗口超过上限时从底部（最新侧）滑动裁剪，仍可逐页翻完整历史；流式/等待响应期间不裁剪；发送前若窗口末尾落后于真实最新先重载最后一页对齐 backendIndex；新增底部「回到最新」一键恢复最新消息。
- **滚动条在底部时自动贴底失效**：内容增长瞬间的 scroll 事件用中间态布局把 `wasAtBottom` 误判为 false，且陈旧的程序写入目标会吞掉「滚回底部」的 scroll 事件——陈旧 false 永久保留。现 `updateLayout` 跟随条件放宽为 `wasAtBottom || isAtBottom()`（当前在底部即跟随）并恢复状态，`handleScroll` 命中程序写入目标同样恢复；上拉功能不受影响。

## ✅ 测试

- 后端 277 套件/3149 例全绿（新增 toolLoopWallclockLimit 3 例）；
- 前端受影响模块回归通过（conversationActions 18 例、CustomScrollbarSticky 6 例、settingsSearchAnchorConsistency 3 例）；
- typecheck（backend + frontend + electron）+ i18n:check 全绿；
- 敏感信息扫描通过（无本地路径/密钥/token 泄漏）。

---

# 1.7.15dev — 上游 54 commits 合入 + 并发崩溃修复 + 两个上游 PR 合入

## ✨ 新增

- **子代理运行时长上限可配置（上游 PR #37 合入 + 链路补齐）**：新增全局 `defaultMaxRuntime`（-1 无限制，默认 1800 秒），per-agent 未配置 `maxRuntime` 时继承全局默认；list 回显 + updateGlobalConfig 校验（-1 或正整数）+ 工具描述兜底跟随全局动态读取（适配本地 defaultMaxRuntime 命名）；前端子代理设置新增「默认最大运行时间（秒）」输入框（三语 i18n）。
- **UI 调整**：设置-通用-工作区行为不再位于应用信息之下，改为与同页其它设置项占用一致的空间。
- **通知系列（上游）**：点击通知后聚焦 VS Code 窗口 + toast 使用扩展自带图标；Win32Focus 绕过前台锁；换回 node-notifier 实现 Windows 系统 toast。
- **diff 预热增强（上游）**：预热扩展到虚拟原文档 + 写入就绪共享屏障 + pending 时序前置。

## 🔄 上游同步（54 commits，2ffa0fc2..e12da760，含 PR #33/#34/#35/#36/#37）

- **合入内容**：.editorconfig 编码设置；记忆配置全局共享；execute_command 超不再误报用户取消；自动总结不再白烧 AI（auto 切点钳制到当前回合 + 无新消息直接放弃）；toolMeta 生成跨平台行尾规范；diff 文档预热消除首次预览卡顿；README 衍生项目章节；全仓扫描修复批次；子代理排队超时可配置 + 最大并发支持 -1（`queueTimeoutSeconds`）。
- **PR #36（回退早启动工具超时兜底）**：上游 PR #35 引入的 ToolIterationLoopService 早启动等待超时兜底会在流式结束后把 3 秒窗口内未落定的工具强制标为超时失败，误伤仍在正常执行的长耗时工具（execute_command 超过 3 秒即被占位结算）；恢复原始等待逻辑（保留 abort 事件 race），长任务不再被误杀。
- **VSCodeSettingsStorage 修复**：读侧保持 VS Code 合并值语义（workspaceFolder > workspace > global），save 写入目标层级跟随（workspace 已有显式值写 Workspace 层，否则写 Global）——保留本地 remoteControl 字段；
- **不采纳**：fast-tavern 相关 commits（b9e8f29d、0730d582）与 nightly 相关 commits 按项目决策以 -x ours 消除，合并树不含 fast-tavern-main 子项目。

## 🛠 并发子代理崩溃修复（桌面版）

- **根因**：Electron 版 `SubAgentMonitorBridge` 无条件订阅子代理事件总线，且对非 llm_delta 事件无节流、无「面板未打开」短路（VSCode 版有 `!panel` 守卫，移植时漏掉）——Monitor 从未打开时每个子代理的 `tool_*/content_snapshot/run_*` 事件仍逐条构造载荷并 `webContents.send`，并发 8-10 个子代理即每秒数百条 IPC 灌进单一 `graycode:backend-to-renderer` 通道，渲染进程队列无限增长 → OOM/长时间无响应 → 窗口崩溃。
- **修复**：① 新增 `monitorMounted` 短路——前端 `subagents.monitorReady` 到达前不推送任何事件；② 面板折叠时非 delta 事件按 runId 合并到 100ms 窗口粒度（每 run 保留最新一条）；③ 恢复可见时补推一次纯状态 manifest（`navigate:false`，不覆盖用户选中）；④ 新增 `getCachedManifest`（updatedAt 缓存 + 容量上限），消除每条事件重复派生轻量 manifest 的开销（与 VSCode 版对齐）。
- **附带**：事件总线僵尸快照 TTL 清理——自动重建的无主快照（emit 迟到事件）不再永久驻留内存。

## 🔒 安全与质量

- 96 个冲突文件分 4 批人工裁决合并，fork 独有功能全量保留（远程控制/桌面背景图/多工作区/安全加固）；本地版本体系 1.7.x 保持不回退上游 1.5.x；
- 测试回归修复：vscode mock env 重复声明合并、summarize 单超大轮断言对齐新语义、progressCards 重复 import、SubAgentsSettings.vue merge 双 style 块残留、根依赖补 jsdom；
- **后台任务完成回执/任务小气泡收不到修复**：taskEvent 推送格式与前端订阅契约不符（后端直发 type:'taskEvent'，前端按 command 信封订阅），导致后台任务完成回执不回流、BackgroundTaskBar 不出现——已统一为 command 信封（VSCode + Electron 双宿主），App.vue 保留旧格式兼容；
- 后端 276 套件/3146 例 + 前端 106 文件/1021 例 + typecheck + i18n:check 全绿；
- 敏感信息扫描通过（无本地路径/密钥/token 泄漏）。
