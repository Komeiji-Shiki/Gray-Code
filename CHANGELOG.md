# Change Log

<!--
  ⚠️ 维护提醒：`## [Unreleased]` 小节无论何时都不应被彻底删除。
  它是未发布改动的收容区：新改动先记录到 [Unreleased]；发布时把内容整体移至对应版本小节，
  并保留一个空的 [Unreleased] 小节供后续使用。
-->

## [Unreleased]

（暂无未发布改动）

## [1.7.5dev] - 2026-08-08

### 同步上游
  - **同步上游 Komeiji-Shiki/Gray-Code 25 个提交（962d496..8ed8739）**：20 个本地适配 commit 按模块合入（checkpoint 并发锁/mcp 客户端健壮性/settings 持久化/conversation 分支去重/memory 覆盖块语义/chat 工具执行健壮性/subagents 模型继承与重试/模块健壮性/总结保留预算/配置导出键/思考强度档位/后台回执提前投递/formatter 与 regexGuard 修复/webview 处理器加固/前端缺陷批次），其余（确认门 this 绑定/CI 构建体系/未用导入/文档）本地已有等价或更优实现保留本地；上游 SHA 经 -s ours 记录消除 fork behind 计数。
  - **思考强度档位扩展 + 消息统计 TTFT**（上游 15125ef/2e0704a）：anthropic/openai/openai-responses 渠道支持 max/ultra/custom/minimal 档位，custom 原样透传；StreamAccumulator 计算首字延迟 TTFT 写入 Content，TPS 计算剥离首字时延，MessageItem 展示。
  - **后台任务回执动作边界提前投递**（上游 d9d6369）：LLM 动作边界（取消回合/换回合）立即投递回执，不再硬等模型回合结束。
  - **总结保留预算修复**（上游 962d496）：keepRecentTokens 基数改为规划范围内活跃历史 token 总量（默认 50%），修复长对话总结后上下文被压光；滚动条新增总结截断点标记。
  - **checkpoint / mcp / settings / conversation / memory / chat / subagents / modules 健壮性修复批次**（上游 6cd1330/cddf515/fc2c855/e57a657/c713154/5e8f666/63676f2/858e624/2a37702/6d4bb95/c0cf55f/171dc86）：并发锁唯一化与孤儿保护/协议头优先与绝对 deadline/写队列串行化与深合并/分支并发去重与 detached 保留/覆盖块语义与损坏容错/abort 竞态与模型继承/告警节流与导出键修复等，详见各适配 commit。
  - **webview 处理器加固与前端缺陷修复批次**（上游 05550ca/b0fb1f5/89c64c9/2a4f222）：handler 鸭子分支清理与输入校验/删除二次确认与重命名并存/标签页快照绑定/历史分页空页上限/formatNumber 非有限数防护/CHANGELOG 解析支持字母预发布（1.7.2dev 格式）。

### Added
  - **用户可修改对话标题**（1.7.4）：
    - 历史页/首页对话列表悬停新增「重命名对话」按钮（`ConversationList.vue`），复用 `InputDialog` 弹窗；支持 Enter 确认、Escape 取消。
    - 新增 store action `renameConversationTitle`（`conversationActions.ts`）：trim 校验 → `conversation.setTitle` IPC（后端 `ConversationManager.setTitle` 早已存在，写 meta.json 并原子提交）→ 成功后同步本地列表标题、`updatedAt` 与已打开标签页标题（`updateTabTitle`）；空白/未变化标题不发 IPC，失败保持原状并写入 store error。
    - 新增回归测试：`conversationActions.test.ts` 重命名 4 例（成功同步标签页 / 空白与未变化跳过 / 不存在对话 / IPC 失败保持原状）。
  - **设置页「自动执行」给 Diff 审阅类工具提供「自动批准」开关**（1.7.4）：
    - `write_file / apply_diff / insert_code / delete_code` 原先只显示「差异审阅管理」徽标、无任何可操作控件；现徽标旁新增真实开关（`AutoExecSettings.vue`），状态读写「应用diff 设置」的 `autoSave`（四个工具共用同一开关），并显示「自动批准 / 需确认」状态文字；切换即通过 `tools.updateApplyDiffConfig` 持久化。
  - **设置页子菜单折叠**（1.7.4）：
    - 「自动执行」与「工具」页签的分类子菜单（文件操作/搜索/终端/…）头部可点击折叠/展开（`AutoExecSettings.vue` / `ToolsSettings.vue`），折叠时显示 chevron-right 图标、收起分类内工具列表；状态为组件会话内记忆，不持久化。

### Fixed
  - **沙箱工具描述与分类汉化**（1.7.4）：
    - 工具管理页/自动执行页的 sandbox 工具描述此前缺失 `toolDescriptions.sandbox` i18n 条目，回退显示后端英文声明；现三语（zh-CN/en/ja）补齐（内容与工具声明对齐：隔离临时目录/超时杀进程树/输出上限/语言列表/按需确认）。
    - **工具管理页沙箱分类名缺失 `toolsSettings.categories.sandbox` 条目**（自动执行页的 `autoExec.categories.sandbox` 一直存在）：工具页、子代理设置、提示词设置页的沙箱分类标题显示原始 i18n key（`components.settings.toolsSettings.categories.sandbox`）——即「工具页面沙箱未汉化」的真正残留；三语补齐。
  - **apply_diff 汉化统一为「应用diff」**（1.7.4）：中文界面中工具显示名、工具注册表 label（工具消息卡片标题，`utils/tools/file/apply_diff.ts`）、消息卡片标题、审阅面板标题从「应用差异」/英文混排统一为「应用diff」；自动执行页徽标文案「Diff 审阅管理」→「差异审阅管理」、提示与 tooltip 中的 "Apply Diff" → 「应用diff」；「Diff 警戒值」→「差异警戒值」；ja 指引文案同步为「差分を適用」。
  - **设置搜索补齐 apply_diff 自动应用条目**（1.7.4）：
    - `SettingsPanel.vue` 搜索索引新增 `apply-diff-config` 条目（锚点 `[data-search-anchor="apply-diff-config"]`，位于「工具 → 应用diff → 自动应用开关」区块），关键词覆盖 自动应用/自动批准/auto apply/auto approve/应用diff/跳过差异视图/警戒值 等；`tools` / `tools-list` / `autoExec` 条目关键词同步补全。
    - 搜索跳转自动展开目标工具配置面板：新增 `tools/toolConfigFocus.ts` 展开信号，`openSearchResult` 对 `apply-diff-config` 先请求 `ToolsSettings` 展开面板再定位锚点（双重 nextTick 保证锚点已渲染），消除「点了没反应」式静默回退到节标题。
  - **回归测试**：`toolLocalization.test.ts` 断言更新为「应用diff」并新增 sandbox 描述本地化断言；`settingsSearchAnchorConsistency.test.ts` 反向断言覆盖新锚点。
  - **安全加固批次**：
    - **更新器安装包路径注入修复**（`UpdateChecker.downloadAndInstall`）：远端 Release 的版本号此前直接拼入本地文件名（`path.join` 后 `writeFile` + 系统打开执行），tag 名含路径穿越序列（如 `v1.0.0/../../evil`）时安装包可被写到更新目录之外并被执行；现下载前校验版本号仅允许 `[0-9A-Za-z._+-]`（含 semver 构建元数据 `+`），非法即抛错并走 Release 页兜底。
    - **终端工具 cwd 越界守卫**（`execute_command.ts`）：相对 cwd（含工作区前缀解析路径）折叠 `..` 后校验必须仍落在工作区内，`cwd: '../..'` 不再把命令工作目录带出工作区（与 write 类工具的工作区外审批策略对齐）；盘根工作区（`C:\`）尾分隔符不再误伤合法相对路径。
    - **API key 不再明文驻留缓存键**（`modelList.ts`）：模型列表缓存键改为 apiKey/customHeaders 的 sha256 短摘要，明文密钥不再长期停留进程内存（碰撞仅多一次网络请求，无正确性影响）。
  - **健壮性修复批次**：
    - **上下文预览文件复用过期展示**（`FileHandlers.showContextContent`）：预览文件名带时间戳，同标题二次预览不再覆盖已打开编辑器标签的磁盘文件导致旧内容不重载（与 `previewAttachment` 一致）。
    - **代理非流式响应 chunked 结束判定 O(n²) 修复**（`proxyFetch.ts`）：每个 data 事件对全部已收 chunks 全量 `Buffer.concat` 改为有界 4KB 滚动尾窗（仅含 body，header 解析后初始化），大响应（默认非流式路径 + 本地代理）下不再二次方复制；结束标记判定语义不变（仍只查响应体末尾）。
    - **巨型单事件重复 JSON.parse 守卫**（`streamBufferParser.ts`）：单条 SSE 事件（40MB 级 base64 附件）跨包到达时不再对逐渐变长的 currentData 反复全量 parse——超过 4KB 后仅当末尾字符为 `}`/`]`/`"` 才尝试解析（完成事件必以此收尾，不产生遗漏）；`final` 时无条件解析兜底保留。
    - **上游错误提取函数消重**（`ChannelManager.ts`）：删除本地私有 `extractUpstreamErrorMessage`，统一复用 `proxyFetch` 导出实现（两处此前逐字相同，防止未来一处修复漏同步）。
    - **mtime 兜底扫描器 dispose 竞态**（`usageCache.ts`）：dispose 后 in-flight 异步扫描不再写已释放缓存对象；`reader.cancel()` 未 await/catch 的潜在 unhandled rejection 修复（`proxyFetch.ts`）。
    - **过时注释修正**（`conversationActions.ts`）：同步工作区注释与「对话内禁止切换工作区」实际语义一致（`setActiveWorkspace`/`openWorkspaceFolderAction` 不再重绑定）。
  - **回归测试**：`streamSecurity.test.ts` mock 补充 `extractUpstreamErrorMessage` 真实实现（ChannelManager 消重后保持错误正文提取语义验证）。

## [1.7.4] - 2026-08-08

### Added
  - **对话绑定工作区检查修复批次（1.7.4）**：
    - **文件系统大小写敏感性统一为运行时探测**（`webview/utils/fsCaseSensitivity.ts` 新增）：`detectFsCaseSensitivity` 对样本路径做大小写变体探测（变体存在且同 dev+ino → 不敏感），win32 短路不敏感，探测不到时回退平台默认（darwin 不敏感 / 其他敏感）。此前扩展端仅按 `process.platform !== 'win32'` 下发 `fsCaseSensitive`，macOS APFS（默认大小写不敏感）被误判为敏感，同一目录以不同大小写路径打开/收藏时固定匹配静默失败。
    - `WorkspaceManager` / `WorkspaceHandlers`（收藏去重、`waitForWorkspaceOpened`、已打开判定）/ `WorkspaceUtils.pathsEqual`（绑定归属比对）统一使用同一探测口径，消除「运行时探测 vs win32 常量」两套口径互相矛盾的遗留问题（macOS / WSL drvfs 上 URI 漂移误判 `NOT_IN_CURRENT_WORKSPACE`、3s 误超时返回过期状态）。
    - 进程级共享缓存 `getFsCaseSensitivity`：首个有效样本探测后固定口径；空列表（Electron 启动早期）返回平台默认且不缓存，列表就绪后自动重探——修复「空列表→平台默认→终身缓存」口径漂移窗口；`workspaceList` 广播携带 `fsCaseSensitive`（前端初始化时列表为空只能拿到平台默认，口径随列表就绪变化时必须随广播同步）。
    - 前端 `fsCaseSensitive` 默认值按 webview 宿主平台兜底（win/mac → 不敏感，其他 → 敏感）：`getWorkspaceList` IPC 失败时 Linux 上不再把不同大小写的两个真实目录误合并。
    - `syncConversationWorkspaceUri` TOCTOU 补完：await 后「目标会话仍是当前会话」门禁覆盖**后端写入**——此前仅门禁 store 同步，await 期间用户切换到已绑定对话 B（其激活工作区为 B 的绑定值）时，A 会被错误绑定到 B 的工作区并持久化；现在直接放弃本次同步，切回 A 时重新补绑。写入失败时仅当目标仍是当前会话才回滚展示值，避免覆盖新会话的锁定展示。
    - `ConversationManager.createConversation` 并发去重补绑：并发对同一 ID 建会话时，第二个调用携带的绑定在首个创建完成后补绑（H4 自动建会话与用户建会话并发时用户侧绑定不再丢失），已绑定不覆盖（绑定即终身）。
    - 新增回归测试：`fsCaseSensitivity.test.ts`（平台短路/真实目录探测/共享缓存语义 6 例）、`workspaceSync.test.ts` 切走不写后端用例、`ConversationManager.appendAndMetadata` 并发补绑 2 例。
  - **移除工作区选择器「保存当前工作区」入口**（打开工作区即自动收藏保存，无需显式入口）：删除 `WorkspaceSelector.vue` 保存菜单项、前端 `saveCurrentWorkspace` action、`workspace.saveCurrent` handler 与注册、三语 i18n 键；「打开即保存」逻辑保持不变。

### Fixed
  - **对话内禁止切换工作区——切换工作区 = 打开绑定新工作区的新对话**：
    - 移除下拉切换/打开文件夹对当前对话的重绑定逻辑（`setActiveWorkspace`/`openWorkspaceFolderAction` 不再调用 `conversation.setWorkspaceUri`）——此前在对话内强行切换工作区会把当前对话重绑定到新工作区，导致标题与绑定错位、绑定失效（本地便携版数据实测：`conv_..._2zrlyy` 标题为「新建文件夹」项目但绑定被改写为另一工作区）。
    - 切换工作区统一走 `openWorkspaceInNewConversation`（tabActions）：目标与当前工作区相同 → no-op；当前标签页为空白（未创建对话）→ 直接重定位工作区上下文；已有同工作区空白标签页 → 复用；否则新建空白标签页并切换过去。
    - **不堆积保证**：切换产生的空白标签页在首个消息前不持久化（后端无对话记录），且同工作区空白标签页复用（每个工作区最多一个）；对话列表只显示已持久化对话，切换操作本身不会产生对话堆积。
    - 顺序保证：先固定扩展端激活工作区（IPC 不动 store），再切换标签页（快照记录旧工作区上下文），最后设置当前工作区 URI——旧对话标签页快照不会污染为新工作区。
    - 历史页/首页「当前工作区」筛选天然展示新工作区下的对话列表（`filteredConversations` 按 `currentWorkspaceUri` 过滤，默认 `current`）。
    - 新增回归测试：`workspaceSwitch.test.ts`（同工作区 no-op/空白重定位/新建绑定标签/复用防堆积/Auto/IPC 失败/config 层不改写绑定，7 例）。
  - **对话绑定工作区健壮性修复**：
    - `conversation.setWorkspaceUri` 与 `ConversationManager.setWorkspaceUri`/`createConversation` 增加 workspaceUri 归一化：null/空/空白串 → undefined（解绑 = 跟随活动编辑器），去除首尾空白——此前字面 `null`/脏 URI 会被 JSON.stringify 持久化，破坏下游 `typeof string` 判定（记忆隔离、工具工作区路由、checkpoint 裁剪、前端筛选全部失配）。
    - 后端 H4 自动建会话不再重建已存在的元数据：历史文件缺失但 `{id}.meta.json` 存在时（创建后历史被清理/损坏），保留原标题/绑定工作区/自定义字段，仅补建空历史与用量索引；原元数据未绑定时按 H4 语义补绑当前工作区，已绑定时不被调用方 hint 覆盖（绑定即终身）。此前重建会丢失自定义配置并把绑定改写为扩展端激活工作区，与前端锁定展示不一致。
    - `syncConversationWorkspaceUri` 修复锁定展示被覆盖 + TOCTOU 竞态：已绑定对话在发起任何异步读取前直接返回（此前先 fetch 扩展端激活工作区再校验，扩展端旧值会覆盖 store 的锁定展示与筛选口径）；await 期间会话可能被绑定/删除，写前重新校验；仅当目标会话仍是当前会话时同步 store。
    - 工作区 URI 匹配口径跨平台对齐：前端 `WorkspaceSelector` 与对话筛选改为按扩展端下发的 `fsCaseSensitive`（仅 Windows 大小写不敏感）归一——此前无条件小写归一在 macOS/Linux 大小写敏感文件系统上会把不同大小的目录误判为同一工作区。
    - 新增回归测试：`workspaceBindRepair.test.ts`（H4 元数据保留 + 归一化 7 例）、`workspaceSync.test.ts`（锁定/补绑/回退/竞态 4 例）、WorkspaceSelector 大小写敏感用例。
  - **对话绑定工作区锁定 + 下拉切换工作区修复**：
    - 打开对话必须锁定工作区到对话绑定的工作区：`syncConversationWorkspaceUri` 不再因绑定工作区暂时未打开（已关闭/切换到其它文件夹）而静默重绑定——「绑定即终身」，避免显示与绑定漂移造成混淆；需要换绑时通过顶部下拉显式切换。
    - 切换标签页恢复会话时同步扩展端激活工作区（`restoreSessionFromSnapshot` 与 `switchConversation` 对齐）：绑定工作区的对话切回标签页后文件树/工具不再指向不一致；未绑定对话不发送，保持「跟随活动编辑器」不被标签页切换意外固定。
    - 顶部工作区下拉（WorkspaceSelector）无法切换工作区修复：
      - `WorkspaceManager.setActiveWorkspaceUri` 改为 Windows 大小写不敏感匹配，命中时固定列表中的规范 URI——同一目录以不同大小写路径打开/收藏时点击不再静默失败；被固定工作区在列表中的 URI 大小写漂移时自动采用规范 URI。
      - 请求的工作区未打开时不再解除现有固定（此前固定状态会被清掉，表现为「点了没反应」）。
      - 通过下拉打开收藏工作区后，当前对话重新绑定到新打开的工作区——「切换工作区」真正生效，不再停留/悬空在旧工作区。
      - `setActiveWorkspace` 重绑定使用扩展端返回的规范 URI（避免把大小写漂移 URI 写回对话绑定造成前后端不一致）。
    - 下拉展示「锁定」状态：绑定但未打开（关闭）的工作区不再谎报为 auto——触发按钮显示绑定工作区名，菜单显示带锁图标 + 「未打开」标签的锁定条目；「保存当前工作区」入口在绑定未打开时隐藏。
    - 补充测试：WorkspaceManager 大小写匹配/锁定语义单测、WorkspaceSelector 组件测试（绑定未打开展示/点击切换/收藏交互/大小写漂移）、tabActions 标签页恢复锁定测试、UI smoke 新增 workspaceSelector 步骤。
  - **沙箱功能完整化**（修复 6ad6805 引入的断点与缺陷）：
    - 工具声明缓存指纹纳入 `toolsConfig.sandbox`：在设置页开启/关闭沙箱总开关后，LLM 的工具列表立即生效，不再需要重载扩展（此前开关变更不失效声明缓存，沙箱工具对模型永远不可见）。
    - 语言白名单空列表语义统一为「拒绝全部语言」：此前前端把空列表回退显示为全选、执行层回退为全允许，用户取消全部语言反而获得"全部放行"，存在安全语义反转；现前后端与执行层一致（空 = 全拒），且前端禁止保存空列表并提示至少保留一种语言。
    - 超时/中止杀进程补 SIGTERM 失败升级 SIGKILL：忽略 SIGTERM 的进程不再导致工具调用永久挂起（对照 execute_command 同款兜底）。
    - 输出流式累积增加内存护栏（上限 800 万字符，超出丢弃最旧内容并计数提示）：巨量输出（如单条 10^9 字符打印）不再在截断前撑爆内存。
    - Windows 下输出解码接入 UTF-8 → GBK 自动降级（与 execute_command 同一机制），中文脚本输出不再乱码；清理原先从未被调用的死代码解码路径。
    - `truncateOutputLines` 边界修复（`-1` 返回真实行数、`0` 全部截断）；写文件/spawn 失败路径的临时目录清理尊重 `cleanupTempDir` 配置；工具声明补 `strict: true` 并注明默认需确认。
    - `updateSandboxConfig` 保存时过滤未知语言、钳制超时上限（1000~600000ms），与前端输入范围对齐。
  - **LLM 前缀缓存命中率修复（消息插入不再吃缓存）**：
    - 根因：`injectInboxMessages` 把用户插入 / agent→main 信箱消息注入最近一次工具结果（agentInbox）并随历史落盘；旧实现（HIGH-1）在请求组装时对历史 functionResponse 剥离 agentInbox——同一 tool_result 在当轮请求含信箱消息、跨轮（新真实 user 消息后）被剥离，模型侧内容在回合边界翻转，Anthropic cache_control / OpenAI prefix caching 按字节匹配前缀，从翻转消息起整段缓存失效，消息插入越频繁命中率越低。
    - `cleanFunctionResponseForAPI` 移除 agentInbox 剥离（顶层与 data 均保留，删除 isHistoryMessage 参数）：信箱消息随工具结果常驻历史，发给 LLM 的 tool_result 内容跨回合字节稳定，前缀缓存持续命中；重放代价由 prompt cache 吸收（缓存读远低于重算）。
    - 子代理路径同步：删除 `stripReplayedAgentInboxForModel` 及其调用——子模型请求历史与落盘一致，同 run 迭代与 continueFromRunId 续跑前缀稳定（DeepSeek user_id / Anthropic user_id 缓存域命中）。
    - `SummarizeService.cleanMessagesForSummarize` 与主路径统一改用 `cleanFunctionResponseForAPI`：总结请求同样保留 agentInbox（策略一致，总结上下文不丢信箱消息）。
    - 消息插入功能补齐：`serializeToolResultForLLM` 文本序列化路径（execute_command 输出 / 批量结果 / 部分成功）此前不含 agentInbox，模型实际看不到插入的消息；新增 `[Agent inbox messages]` 文本段（顶层优先渲染，formatResultItem 跳过 agentInbox 键防双份渲染），全部工具结果对模型可见且跨回合字节稳定。
    - 回归测试：helpers.test.ts / ConversationManager.agentInbox.test.ts / agentSendMessage.test.ts 更新为「跨轮保留」断言（含跨轮字节一致契约）；toolResponseFormatter.test.ts 新增 agentInbox 序列化 5 例；删除废弃的 subagentMailboxReplay.test.ts（H1-4 剥离函数已移除，防止旧语义回归）。

### Changed
  - 沙箱设置页 i18n 键路径修正：此前组件引用 `components.settings.sandbox.*`，实际键位于 `components.settings.settingsPanel.sandbox.*`，导致全部文案渲染为原始 key；现已统一，搜索索引 labelKey 同步修正。
  - 设置搜索补齐 `sandbox-info` 条目与 `security/安全` 等关键词；锚点一致性测试增加反向断言（组件锚点必须被搜索索引收录），防止再次漏收。
  - 沙箱设置页「恢复默认」改为获取后端权威默认值（`getDefaultSandboxConfig`）并立即保存，消除默认值双源漂移；总开关与保存操作加并发防抖；加载失败文案 i18n 化。
  - 工具管理页的沙箱开关接入真实总开关（`updateSandboxConfig.enabled`），并新增"详细参数请在设置页配置"提示徽标；三语 `categories.sandbox` / `toolDisplayNames.sandbox` / 工具页 `sandboxHint` 补齐。
  - 新增 `SandboxSettings.test.ts`（加载/空白名单语义/开关回滚/保存校验/恢复默认/数值钳制）。

## [1.7.3] - 2026-08-07

### Added
  - **沙箱工具（Sandbox）**：新增 `sandbox` 工具，供 LLM 在隔离的临时目录中安全运行代码片段。
    - 支持语言：Python / JavaScript / Bash / PowerShell / sh，可通过白名单按需启用。
    - 安全防护：独立临时目录（运行后自动清理）、硬超时强制终止进程树、输出行数上限截断。
    - 设置面板新增「沙箱」独立栏目，含总开关（默认关闭，opt-in）、语言白名单、超时、输出上限、临时目录清理等配置项。
    - 默认需用户确认后执行（与 `execute_command` 一致），可在「自动执行」设置中放开。
    - 三语（zh-CN / en / ja）i18n 完整覆盖，设置搜索索引已纳入。

## [1.7.2dev] - 2026-08-07

### Added
  - 手动创建存档点按钮（输入区工具栏 codicon-save）：任意时刻保存当前工作区状态。后端 `createCheckpoint` 支持 `forceCreate`（跳过 enabled 开关与工具/消息类型过滤，仍尊重排除规则）；webview 新增 `checkpoint.createManual`（绑定当前最后一条消息 + BCP-02 绑定当前分支活跃尾节点）；成功/失败三语通知；CheckpointManager/checkpointActions 测试补齐（合入上游 20cad4e）。

### Changed
  - 同步上游安全加固批次（PR #24 系 + 后续修复，桌面端适配）：
    - 子代理危险工具确认门：执行前与主链路共用 `toolNeedsConfirmation` 判定，需要确认的工具直接拒绝并把原因以 functionResponse 回流；共享执行服务缺少确认门时 fail-closed 拒绝；空工具集不再被转成 undefined 回退渠道全量工具声明；发送前按渠道 `maxContextTokens`（缺省 128000）×0.8 做请求级上下文裁剪（整轮配对丢弃保首条/末尾、超大字符串截断、lastSentHistory 同步裁剪结果）；修正确认门调用丢失 `this` 绑定问题（上游 d28adfc 的 `getToolRejectionReason` 空指针，本地以方法形式调用修复 + 回归测试）
    - 流式缓冲上限改为「解析无进展时 64MB 终止（PARSE_ERROR 不可重试）」：合法巨型单事件（多模态 base64 附件 40MB 级）不再被 20MB 硬上限误杀；generateStream 补 `formatter.validateConfig`（无效配置提前 VALIDATION_ERROR）；纯文本错误正文先读 `text()` 再 `JSON.parse`（网关 502 HTML 正文不再丢失，本地 status 区间判断保留）；`streamChunkHasContent` 纳入 inlineData/fileData（多模态流连接中断不再误判空响应重播整条流）；本地单行防护（MAX_SSE_LINE_CHARS）同步抬升至 128MB 兜底语义
    - 写队列挂起超时不再放行并发写：四个写队列（withConversationWriteLock / runSegmentedHistoryWriteSerialized / withMetadataWriteSerialized / UsageIndexStore.enqueueWrite）链尾挂在底层任务上，超时仅 fail-fast 调用方、链不前进；挂起计时从任务真正启动开始
    - 双文件提交配对一致性：checkpoint files.json/manifest.json 写入带 filesRevision 绑定 + files.json.prev 崩溃恢复（崩溃窗口混合配对可识别并拒绝）
    - retry 前截断主历史末尾 model 消息（DeepSeek prefill 400 / 重试接龙）：`resolveRetryTruncateIndex` 只删「最后一个非 model 消息之后的 model 尾巴」，失败流不误删正常回答
    - 手动总结单轮对话 STALE_RANGE 放行（仅整个历史一个真实用户回合且为用户主动总结；自动总结保持严格 STALE，首条用户消息保护仍生效）
  - 前端多模态占位判定统一：`isEmptyAssistantPlaceholder`/toolActions/streamChunkHandlers 纳入 inlineData/fileData，仅含多模态附件的 assistant 消息不再被误删；本地独有 `cleanupFailedSendPlaceholder` 同步对齐口径
  - 编辑用户消息保存后分支切换器立即显示：分支流首输出 chunk 到达时提前刷新分支图（按 streamId 隔离只刷一次），终结时仍消费标记再刷新
  - `.gitignore` / `.vscodeignore` 忽略 `run-logs.zip`（本地调试日志不进 git / 不进 vsix）
  - 代码优化批次（性能 / 质量 / 安全）：
    - 新增 `backend/core/deepClone` 共享深拷贝工具（structuredClone 优先、JSON 回退），替换 BranchService / runEventBus / executor / ConfigManager / storage / TranscriptMutation / TranscriptRepository / ToolExecutionService 中 21 处 `JSON.parse(JSON.stringify())` 热路径深拷贝（消除全量字符串中间体与 undefined 丢失）
    - `graycode://` 自定义协议缓存命中时重新 stat 比对 mtime，rebuild 后不再返回旧 bundle
    - `pendingToasts`（vscode-shim）增加 100 上限驱逐、`toolDiffIds`（BackendHost）增加 500 上限驱逐，防无界增长
    - DependencyManager npm install 调试日志改用结构化 Logger（截断 2000 字符），不再向 Extension Host console 输出全量 stdout/stderr
    - electron 构建（build.mjs）补 `process.env.NODE_ENV` define，生产构建剔除 dev 代码路径；Vite `manualChunks` 拆分 `js-tiktoken` 为独立 vendor chunk，减小主入口体积
    - 前端懒加载重试增加 jitter；`clipboard.writeText` 错误改为 console.warn 记录而非静默吞掉

### Fixed
  - 子代理执行任意工具报 `Cannot read properties of undefined (reading 'getToolRejectionReason')`：确认门以解绑函数形式调用导致 `toolNeedsConfirmation` 内部 `this` 为 undefined（上游 9644238 引入）；改为方法形式调用，并加 this 绑定回归测试
  - 未捕获异常对话框 detail 未脱敏（现经 redactSecrets 处理，与 unhandledRejection 口径对齐）
  - IPC `graycode:renderer-to-backend` 消息 type 字段未做类型校验（现要求 string，强化原有 `if (!type)` 守卫）
  - `patch-dist.mjs` 幂等检查改用 `<!-- graycode-patch-dist -->` marker 注释，避免源 HTML 含同名字符串时跳过 CSP / codicons 注入

### Tests
  - backend jest 242 套件 / 2485 用例通过（含新增 retryTruncateIndex/writeChainHangTimeout/summarizeManualSingleRound/streamSecurity/proxyFetchErrorBody/subagentToolConfirmation/subagentContextTrim 与 ATOMIC-PAIR 用例）；frontend vitest 69 文件 / 655 用例通过；tsc --noEmit + frontend vue-tsc 全绿
  - fork 同步：上游 9644238 之后 0 commits behind（内容 commit 以适配 cherry-pick 合入，文档/merge commit 以 -s ours 记录 SHA）

## [1.7.1] - 2026-08-07

### Added
  - 桌面端渲染层 native op 白名单（安全收口）：`graycode:native` IPC 仅放行前端实际使用的 `workspace:pickFolder`，剪贴板读写 / 任意路径探测 / shell 打开 / 对话框等其余 op 渲染层不再可达（仅主进程内 host.native 供 shim 使用）——渲染层渲染 AI 生成的 HTML，XSS 失守后不再拥有剪贴板与文件系统探测能力。
  - 主进程 `unhandledRejection` 日志脱敏：错误对象可能携带请求体/配置（含 apiKey）上下文，现只输出 message + 截断堆栈，并遮蔽常见密钥字段（apiKey/authorization/password/token/secret/credential），超长字符串截断，敏感信息不再进入日志管道。

### Changed
  - 前端启动体积与首屏性能优化（桌面端专项）：
    - 历史页 / 用量页 / 设置面板 / 子代理 Monitor / 变更查看 / 代码查看 / 更新弹窗改为 `defineAsyncComponent` 懒加载（保留既有 visitedViews + v-show 惰性挂载语义），设置面板（约 488KB）等大面板代码拆出主入口——入口 JS 由约 1.8MB 降至约 1.24MB（-31%），面板级 CSS 同步按需加载；
    - 变更查看面板 diff 计算加内容指纹 LRU 缓存（`computeDiffLines` 模块级 memo，上限 64 条 / 超大文件跳过），`statsByIndex`/`selectedHunks` 与工具卡不再对同一内容反复跑 LCS；语法检查同样按 语言+内容 指纹缓存（上限 64 条 / 128KB 上限），面板可见期间 entries 推送不再全量重算；
    - `chunkSizeWarningLimit` 由 2500KB 恢复至 1000KB 并开启压缩体积报告，入口体积回归可观测；
    - 移除未使用的 `markdown-it-container` 依赖（仅 .d.ts 类型声明引用）。
  - vscode-shim 稳定性修复：
    - `vscode.diff` 预览路径双重 `decodeURIComponent` 修复：`Uri.parse` 已解码 path（DiffHandlers 构造时编码一次），二次解码遇字面 `%`（如 `report%final.md`）会抛 `URIError` 导致 diff 预览打开失败，现去除多余解码；
    - `workspace.fs.copy` 遵守 overwrite 契约：`overwrite=false`（缺省）时目标已存在报错（`ERR_FS_CP_EEXIST`），不再静默覆盖用户文件；
    - `Uri.parse` 清理空分支死代码。
  - builtinLsp 优化与修正：
    - 未知扩展名不再回退 TS 风格正则（原实现会从 .toml/.ini/.log/Dockerfile 等提取伪符号），未显式映射的语言默认不解析；
    - `findIdentifierLocations` 预计算行起始偏移（原实现每匹配做 slice+split，大文件多匹配 O(n·m)），复用调用方已读内容消除重复读盘；
    - 移除共享 `g` 标志正则的 `lastIndex` 全局可变状态（`getDefinitions`/`getReferences` 并发调用脆弱），统一改用 `matchAll`。
  - BackendHost 资源清理：
    - diffManager 状态监听退订函数入 `unsubscribers`（dispose 时移除，避免模块级单例持闭包引用泄漏）；dispose 清空 `previewToSessionId`/`toolDiffIds`/`diffPreviewContents` 映射；
    - `require('events')` 改为标准 `import { EventEmitter }`。
  - 自定义协议（graycode://local）请求热路径：缓存命中直接返回，省去每次 stat 系统调用（资源为打包产物运行时不变）。

### Fixed
  - 修复回复查看器（ResponseViewerDialog）渲染期空指针导致消息列表 UI 丢失（偶发，便携版/长会话消息滚动渲染时触发）：`MessageItem` 仅在打开对话框时惰性构建 `responseViewerData`（初始为 null），而 `ResponseViewerDialog` 随每条消息常驻渲染，模板与 computed 对 `props.value` 无条件解引用（`:value="props.value.rawJson"` 等）——`props.value` 为 null 时抛 `TypeError: Cannot read properties of null`，Vue 渲染错误向上传播使该消息组件树渲染失败，表现为消息区 UI 缺失。现 `value` prop 改为可空（`value?: ResponseViewerData | null`），全部 computed / 模板访问加可选链与空值兜底（answerText/thoughtText/tools/parts/attachments/metadata/responseInfoItems/basicInfoItems/metadataKnownItems/rawJson），空值时渲染空态而非崩溃。
  - 懒加载面板增加 chunk 加载失败自动重试兜底：便携版/防病毒扫描/临时目录清理等场景下异步 chunk 偶发加载失败会让面板静默空白（表现为 UI 丢失）——`defineAsyncComponent` 统一走 `withLazyFallback`（失败自动重试最多 3 次、指数退避 400ms 递增），仍失败才渲染降级，不再一次性静默失败。
  - 前端流式/高频路径小修正：`App.vue` 命令分发 switch 内重复 `break` 死代码清理。

### Tests
  - 后端 jest 235 套 / 2442 用例通过；前端 vitest 69 文件 / 648 用例通过；`tsc --noEmit` 全绿（根 + electron-app + frontend vue-tsc）；electron-app esbuild 生产构建通过。

## [1.7.0] - 2026-08-07

### Added
  - GitHub Releases 自动更新（fork 桌面版适配）：应用启动后延迟 10s 检查 `czocelot/Gray-Code-Desktop` 最新 Release（距上次检查不足 24 小时跳过，时间戳存 globalState；设置页「立即检查」忽略节流），有新版本时前端弹窗展示 Release 说明，用户确认后自动下载安装包（优先 NSIS `GrayCode.Setup.*.exe`，回退便携版 exe / zip）并交给操作系统打开，由用户完成安装后重启应用生效；设置页「通用」新增「自动更新」区块（启用开关 + 立即检查 + **一键更新**按钮——一键更新自动完成「检查 → 下载 → 打开安装包」）；请求复用渠道代理配置（createProxyFetch），版本检查超时 10s / 下载 120s，失败静默不打扰；新增 `checkForUpdates` 设置项（默认 true，可关闭，随 Settings Sync）；三语 i18n + 设置搜索索引；新增 webview 消息 `getUpdateStatus` / `checkUpdateNow` / `installUpdate` / `updateNow` / `openUpdatePage` 与 `UpdateHandlers`（`updateNow` 为检查下载一条龙；Electron 桌面端与 VSCode 扩展形态均已接入 UpdateChecker 初始化）；后端新增 `UpdateChecker` 模块（版本比较 / 节流判断 / API 响应解析为纯函数，`update` 状态机覆盖 disabled / idle / checking / upToDate / updateAvailable / error）及单元测试。
  - `graycode.checkForUpdates` 注册进 package.json contributes（合入上游 c109fdd）：此前该设置键仅在 `VSCodeSettingsStorage` 读写但未注册 contribution，VSCode 扩展形态下对未注册键 `update` 会抛错；桌面端 vscode-shim 不做键校验不受影响，补齐后扩展形态与设置注册测试（`vscodeSettingsStorageRegisteredKeys.test.ts`）一致。

### Changed
  - 渠道设置支持更改渠道类型（合入上游 3eba442 + c12cb52）：编辑表单类型由只读徽章改为可选下拉框（CustomSelect + 三语确认弹窗）；切换时后端以新类型默认配置为基底重建（`updateConfig` 放开 type，`pickCommonFields` 保留 33 项跨类型通用字段 + apiKey，显式 `updates` 优先级最高），激活渠道变更同步清空会话级模型覆盖；`createConfig` 入口运行时校验非法类型（不再落入 default 分支产生无 url 死配置）；`CHANNEL_TYPES` 常量移入 `configs/base.ts` 与 `ChannelType` 类型同源（消除校验常量与类型漂移）；桌面端保留本地 `resolveModel` 模型回退（类型重建后同样生效）。新增 `ConfigManager.updateConfig.test.ts` 11 用例。
  - 提示词预设 fakeThought 伪造思考过程 + 思考回传配置合并（合入上游 c109fdd）：`PromptEntry` 新增 `fakeThought` 字段（预设临时 assistant 消息可附加伪造思考，PromptManager 组装 `thought: true` part 并剥离进 preserve 快照），ToolIterationLoopService 发送侧 `applyPromptContextThoughtPolicy` 按渠道「发送历史思考内容」开关过滤（不写入 turnDynamicContext 缓存，两处循环入口统一）；设置页 PromptEntriesEditor 新增 fake-thought 输入区；4 个 channel options 组件「当前轮次/历史回合」思考回传双区块合并为单一 `thinkingBackfill` 区块（i18n 键迁移，`ChannelSettings.vue` 旧 CSS 清理）。
  - 根消息编辑重生成（TREE-03-R，合入上游 c109fdd）：`resolveEditTargetNode` 两处 branch 模式不再拒绝根节点；`handleEditBranchStream` 新增 `isRootEdit` 分支——改写根节点 + `createRerollCandidate` 保留旧回答为候选 + 截断其后 + `editStarted.parentNodeId = null`；前端 `effectiveMode` 不再对根节点自动降级 keep（仅用户显式选择时透传 keep）；keep 模式 complete 不再携带 content 且前端不再进入流式等待（修复「编辑根消息后无法发送」：complete 丢失时 isStreaming 残留拦截消息发送）。测试断言同步（editBranch / streamErrorRetry）。

### Fixed
  - 修复设置页保存提示词误报失败（合入上游 40b0ae5）：`countSystemPromptTokens`（调渠道 API 计数）、`tokenizer.getResource`（首次下载词表，分钟级）、`storagePath.getStats`（大目录统计）等慢 handler 占住串行 `messageHandlingQueue` 时，后续 `savePromptMode` 排队超过前端 180s 兜底超时被误报失败（对话框类 `exportPromptModes` 同样豁免）；现三类消息加入 `NON_BLOCKING_MESSAGE_TYPES` fire-and-forget（响应仍按 requestId 路由回发起方）+ 前端 `UNBOUNDED_REQUEST_TYPES` 同步豁免，`saveConfig` 保存后的 token 计数改 `void countTokens()` 不阻塞成功反馈；桌面端保留本地独有条目（`workspace.openFolder`/`chat.awaitConversationIdle`/`summarizeContext` 等）。新增 `messageRouterNonBlockingBehavior.test.ts` / `promptSaveChain.test.ts`，`messageRouterNonBlocking.test.ts` 并集合并。
  - 修复高 tps/代码块渲染吸底优化（合入上游 c37bf00）：① CustomScrollbar 新增 `USER_SCROLL_COOLDOWN_MS` 250ms 冷静期——wheel 输入事件同步派发、早于 scroll 事件与 rAF，冷静期内跳过贴底写入（高 tps 下内容增长抵消滚动距离、每帧被拉回的问题根治），滚动条拖动同样标记冷静期；② MessageRenderBlock `shouldStickBottom` 返回 true 前 `queueMicrotask` 读回写入后实际 scrollTop——程序贴底写入（CharFlow `scrollToEnd`/promote 校正）不再被紧随其后的代码块异步渲染（hljs 高亮使 scrollHeight 骤增）误判为「用户滚动」而丢吸底，`scrollMediumToBottomIfStuck` 写入后同步记录；③ 中展开按 scrollTop 变化检测（scrollTop 未变 = 用户没动，内容增长不改变吸底意图）。与桌面端 M-5 字符级变更节流正交（纯字符变更合并 ~100ms 窗口调用，最终都走 updateLayout 冷静期检查）。新增回归测试（wheel 后不拉回、冷静期恢复、代码块异步渲染不丢吸底）。
  - 修复历史截断后孤儿 functionCall（合入上游 ea05ba6）：被删消息含某 functionCall 的响应、而保留区间仍持有该调用且无其它同 id 响应时，`truncateFrom`/`deleteLogicalMessage`/`deleteMessagesInRange` 截断后经 `repairFunctionCallPairsAfterDelete` 把该调用标记 `rejected = true`（不伪造「用户拒绝」占位响应，避免语义混淆）；`settleFunctionResponses` 新增 `functionCallIds` 集合——迟到真实结果若对应调用已被截断则丢弃（不再制造 orphan_function_response），`settledResponseIds` 统一在写回前清除 rejected（覆盖「截断先标记 rejected、工具结果随后结算」时序，取代原全历史 O(n²) 清 rejected 扫描）；与桌面端既有 BR-07/cleanFunctionCall 读时过滤互补（写时根治）。新增 `orphanFunctionCallRepair.test.ts` 7 用例（测试播种适配桌面端 historyCache，见 Tests）。
  - 修复代码块复制按钮失效（合入上游 c109fdd）：`markdownUtils` sanitizeHtml 此前直接移除 `code-tool-btn` 按钮（净化器把复制按钮删掉）；`copyToClipboard` 新增 execCommand 回退——VSCode Webview（vscode-webview:// 非 secure context）中 `navigator.clipboard` 缺失/被拒时回退 textarea + `execCommand('copy')`（恢复原选区防破坏用户文本选择），MarkdownRenderer 改用 `copyToClipboard` 并新增 `copy-failed` 红色失败反馈样式。
  - 修复后台任务回执（`[Background task completed]`）加载旧对话时显示为普通用户消息：`StreamRequestHandler.handleChatStream` 解构前端 `chatStream` 请求时漏透传 `source` 字段，后端落盘时 `request.source` 为 undefined，回执消息的 `source='background_task'` 从未写入历史——当前会话靠前端内存正常显示，重新加载对话后渲染成完整正文的用户消息（占地超大且无折叠卡片）；现补上 `source` 透传（新数据落盘即带标记），并在统一读路径出口 `toFrontendMessage`（一处覆盖 `toDisplayMessages` / `getMessagesPaged` 缓存/分页/全量路径）对历史遗留的「缺 source 且以 `[Background task completed]` 前缀开头的用户消息」做展示层归一化补 `source='background_task'`（只补内存不写盘，避免重写历史文件）；新增 `ensureBackgroundTaskSourceForDisplay` 单元测试（缺 source 补标记 / 已有 source 不覆盖 / 普通消息与 functionResponse 不误判 / 无 parts 安全跳过）。
  - 渠道设置「启用此配置」开关移至表单顶部：此前该开关位于配置表单最底部，用户进入设置时下意识以为没有启用功能；现置于 API URL 之前（配置选择器/新建按钮正下方），一眼可见，`data-search-anchor="channel-enabled"` 搜索锚点保留。
  - 修复 `memory_config` 只读调用在工作区记忆目录尚未初始化时误报「workspace URI could not be resolved」：此前纯读走 `createIfMissing=false`，工作区目录不存在时返回 null，被笼统报成 URI 解析失败；现区分「URI 不可解析」与「工作区记忆目录未初始化」两种失败——前者才报解析错误，后者纯读时回退显示全局配置并标注 `workspaceNotInitialized`（保持无磁盘副作用，不创建目录），带更新参数时仍正常创建目录并写工作区独立配置；`memory_zoom` 只读调用同样区分两种失败，工作区未初始化时改报明确的 `Workspace memory is not initialized for this workspace`；新增 `memoryConfigTool.test.ts` 回归测试（6 用例：无工作区读全局、工作区独立配置隔离、未初始化纯读回退标注且无副作用、未初始化带更新参数建目录、URI 不可解析报错、全局未初始化报错）。
  - 修复 VSCode 窗口聚焦时仍播放任务完成/错误提示音：音效控制器 `handleSoundEvent` 此前只在文档隐藏（窗口最小化/切走）时聚合不播，窗口聚焦时无论焦点在哪都直接播放；现由扩展侧监听 `vscode.window.onDidChangeWindowState` 把窗口焦点状态（`windowFocusChanged` 命令）推送到前端（Electron 桌面端经 `BackendHost` 等价推送，shim 的窗口焦点事件桥接自 Electron 主进程 focus/blur），音效按窗口焦点分级——VSCode 窗口聚焦（用户看得见界面、事件结果已可见）不播，窗口失焦（切到其他应用）时照常播放提醒；文档隐藏期间聚合的事件在恢复可见时仍补播一次。新增 `soundEventController.test.ts`（7 用例：默认聚焦不播、聚焦不播、失焦播放、失焦后聚焦不播、隐藏聚合后恢复补播、visibilitychange 集成、事件过期丢弃）。
  - 修复流式输出自动滚动吸底的拉回与丢吸底问题：① 正文主滚动容器（CustomScrollbar sticky-bottom）此前 `wasAtBottom` 在 scroll 事件后的 rAF 回调里才更新，滞后一帧——流式期间 MutationObserver 驱动的贴底写入读到陈旧状态，把刚向上滚动的用户拉回底部（「使劲滚才能滚上去」）；现 scroll 事件**同步**更新吸底状态，用户滚动意图立即生效。② 贴底写入后立即用实时 scrollHeight 复验，大段输出 md 异步解析会让 scrollHeight 在写入后继续增长，误判「用户滚离」→ 永久丢吸底；现程序贴底写入记录目标 scrollTop（`programmaticScrollTop`），其触发的 scroll 事件按写入值比对识别为程序行为、保持吸底状态，吸底状态只由用户滚动改变。③ 思维链中展开（MessageRenderBlock）`shouldStickBottom` 按 `scrollHeight - scrollTop - clientHeight` 复验，用户滚回底部后内容大段增长（scrollTop 未变、scrollHeight 变大）同样误判丢吸底；现改用 scrollTop 变化检测——scrollTop 未变 = 用户没动，内容增长不改变吸底意图。④ promote 后的 nextTick 贴底校正增加当前位置复验，用户刚滚离（scroll 事件滞后）不再被拉回。新增 `CustomScrollbarSticky.test.ts`（7 用例：底部增长贴底、滚离不打扰、写入后增长不丢吸底）与 MessageRenderBlock 中展开增长不丢吸底回归测试。

### Performance
  - 存档点 manifest 懒加载（CPF-LAZY-1）：从 schema version 2 起，重量级 `files` 映射（全工作区哈希表，大工作区可达 10-20MB）从 manifest.json 拆出，独立存放于 `checkpoints/cp_xxx/files.json`——`manifest.json` 只保留轻量元数据（workspaceRoots/emptyDirs/changes/excluded/ignoreSnapshot）。读取路径分级：存档列表摘要、设置页排除清单详情、恢复排除说明等只消费元数据视图（`loadManifest`），不再为少量字段解析整张文件哈希表；完整文件映射仅在恢复链构建、增量比较、链合并等真正需要的路径按需懒加载（`loadManifestWithFiles` / `enrichRecord`），经 IPC 下发给前端的 `checkpoint.getManifest` 也同步改为轻量视图。旧格式（v1 内联 files）首次读取后 best-effort 自动拆分为新格式落盘，存量存档渐进迁移：轻量读取路径解析一次后 files 进缓存、**零写放大**，拆分落盘只在完整数据读取（恢复/增量比较/合并）时触发，一次 10-20MB 级写入后后续读取全部走轻量路径；拆分失败/未发生时的 v1 存档由内联兜底继续提供数据，不误判丢失；写入顺序保证 manifest.json 为提交点（先写 files.json 再写 manifest.json，中途崩溃不会出现「新布局指向缺失文件」的不一致）。双缓存隔离：轻量元数据缓存维持既有 LRU 上限（32 条），files 映射缓存按需加载并设独立 LRU 上限（8 条），避免长驻 32 份 10-20MB 大对象；`clearCache`/删除路径同步清理双缓存。完整性检查（integrityCheck）同步支持 v2 拆分布局（files.json 缺失/损坏/ID 不符/形状非法分别上报）。新增回归测试：拆分写入、懒加载不触碰 files.json、files.json 缺失时元数据可读而完整数据显式失败、v1 读取后拆分迁移、双 LRU 淘汰、完整性检查 v2 布局（10 用例）。
  - 存档点 manifest 懒加载后续加固（CPF-LAZY-1 审查优化）：files.json（10-20MB 级）改为紧凑序列化（无缩进）落盘，减小磁盘体积与序列化开销（manifest.json 保持缩进可读）；manifest 版本校验要求整数（非整数如 1.5 一律视为损坏走迁移/回退，不再按未知布局缓存导致数据丢失误判）；`writeManifest` 写盘失败时清空该存档双缓存，避免链合并等路径在写盘前修改过缓存对象后残留「内存与磁盘不一致」状态。新增回归测试：紧凑序列化无换行、version=1.5 迁移落盘、写失败清缓存（3 用例）。
  - 存档点 manifest 懒加载安全加固（CPF-LAZY-1 交叉审查）：files 映射形状校验拒绝数组（`typeof [] === 'object'` 曾会让损坏的 files.json 被当作「空工作区」进入恢复流程，工作区全部文件被误判为 untracked 可删除）；manifest 元数据字段补形状校验（缺 excluded/ignoreSnapshot 等的损坏 v2 manifest 不再让列表摘要/恢复排除说明 TypeError）；L5 守卫用 `record.fileCount` 区分「真空工作区存档」（合法空快照可恢复）与「数据丢失」（显式报错）；同一存档的磁盘写入经 per-checkpointId 单飞队列串行化（消除并发迁移/合并共享 tmp 文件的 ENOENT 竞态与 files.json/manifest.json 配对错乱）；`writeManifest` 校验 manifest.checkpointId 与参数一致；legacy 恢复扫描跳过 manifest.json/files.json/*.tmp 元数据文件；integrityCheck 与运行期对未知版本（>当前）同口径（报 warning 不深校验）；`clearCache('')` 不再误清全部缓存；`checkpoint.getManifest` 返回浅拷贝防外部污染缓存。新增回归测试：files.json 数组拒绝、v1 内联数组拒绝、缺元数据字段迁移、真空存档可恢复、checkpointId 不一致抛错、clearCache('') 语义、并发写串行化、integrityCheck 未知版本（8 用例）。

### Added
  - 设置页新增设置项搜索：标题栏搜索框实时过滤（结果下拉 + 侧边栏命中页签高亮、未命中置灰），键盘上下选择/回车跳转，点击结果自动切换页签并滚动定位（节标题或精确锚点 + 1.6s 闪烁高亮）；内置中/英/日三语关键词索引（SEARCH_INDEX），17 个设置组件 93 个设置块加 `data-search-anchor` 精确锚点，具体设置项全部可搜可直达；空结果提示，三语 i18n 同步。

### Changed
  - 思维链（思考块）视图从两态升级为三段式（对齐后台任务回流消息）：**折叠**（只保留头部标题行）/ **中展开**（默认，固定约 10 行滚动查看）/ **完全展开**；头部单击三档循环切换，头部右侧新增三个精确模式按钮（chevron-up / list-flat / chevron-down，`@click.stop` 防冒泡）；`ThoughtViewMode` 类型与 `getRenderBlockMemoDeps` 签名同步更新（`isThoughtExpanded` → `thoughtViewMode`），清理 MessageItem 中遗留的 thought 样式死代码；三语 i18n 同步；MessageRenderBlock 测试重写为三态覆盖。
  - 思维链中展开（medium）模式完善：**中展开与完全展开同源 markdown 渲染**（流式时渐进 markdown 即时渲染已定型完整段落 + 未完成尾巴 CharFlow 托管，非流式 MarkdownRenderer 直接渲染，不再显示纯文本）；**可中断自动吸底**——内容更新自动贴底跟随最新，用户向上滚动超过 40px 阈值即暂停跟随不打扰，滚回底部附近自动恢复（CharFlow 新增 `scrollContainer` / `stickBottom` 回调，贴底写在滚动容器上）；**裁剪提示**——单段超长内容触发 tailWindow 裁剪时，内容区顶部显示「内容过长，仅显示最近部分，请使用完全展开查看」提示条（CharFlow 新增 `onTrimmed` 回调，仅流式期间显示）；三语 i18n 同步。
  - 思维链中展开吸底稳定性修复：① promote 剥离内容时 CharFlow host 同步变矮、MarkdownRenderer 下一 tick 才渲染变高（两段式高度变化），原同步校正停在中间——改为 `nextTick` 后按最终 `scrollHeight` 校正；② scroll 事件由浏览器合帧派发、滞后于实际滚动，用户刚滚离底部时 append 可能误拉回——`shouldStickBottom` 增加实时位置复验（距底 ≥40px 即同步置 false 不贴底）；③ 新增 `userScrolled` 标志：未滚动/重新进入中展开时无条件贴底（避免初始 scrollTop=0 被复验误判），滚动后按位置复验；注册中展开时重置吸底状态；新增 3 个回归测试（滞后复验 / nextTick 最终高度校正 / 原有恢复路径）。
  - 思维链自动视图模式：思考中默认「中展开」；思考与输出全部结束后自动折叠为**单行第一行预览**（折叠视图新增内容预览区：非流式取思考内容首行，流式由 CharFlow 单行模式实时显示最新字符——`squashLineBreaks` 折叠换行 + `tailWindow` 有界 + `followEnd` 跟随）；用户手动切换过视图模式后自动切换不再干预（尊重用户选择）；已结束消息重建后初始即为折叠态；新增折叠预览与自动模式切换测试。
  - 上下文总结（自动 + 手动）从「物理删除被总结消息」改为「逻辑截断」：被总结区间的原始消息打 `isSummarized` 标记完整保留在历史中（不再从磁盘消失，`history_search` 现在可以检索到被压缩的原文），发送给 AI 与 token 统计跳过被总结区间（`ContextTrimService` 统一过滤）；**首条用户消息永远发送**（任务锚点，`prependFirstUserMessage` 在所有发送路径前置，含手动总结边界与 trim 裁剪场景）；`isRealUserMessage` 排除 `isSummarized`，回合识别/总结规划/`isFirstMessage` 判断（过滤后活跃消息数）全部适配；协议 `insertIndex` 改为总结消息插入位置（= summarizeEndIndex）、`removedCount` 改为本次标记的消息数，前端 `handleAutoSummary` 同步为「标记本地消息 + 插入总结」（不再删除/平移索引）；消息列表在最后一个总结消息后渲染横线分隔「已总结 / 未总结」区域（原文照常显示不折叠）；自动总结的 `STALE_RANGE` 并发校验与低质量总结拒绝保留；历史文件无限增长为接受项（原文永不清理）。
  - 新增「恢复原文」能力（逻辑截断反向操作）：总结消息卡片新增恢复按钮（`restoreSummarizedMessages` API），点击后取消该总结覆盖区间的 `isSummarized` 标记并删除总结消息本身，发送起点回退到上一个总结（或 0），原文重新参与发送与统计；删除总结消息（`deleteMessage` / `deleteMessagesInRange` 命中总结消息）同样自动恢复覆盖区间，杜绝「既无总结文本也无原文」的上下文真空（`restoreSummarizedRange` 纯函数，覆盖区间 = 上一个总结之后到该总结，从晚到早逐个恢复多总结场景）；三语 i18n 与新增回归测试（summarizeRestore.test.ts 7 用例）。
  - 全链路性能与资源占用优化（移植自下游桌面版，仅含前后端可移植部分）：
    - 后端读路径缓存：checkpoint 节点反查（`getMessageNodeIdAt`）300ms 短 TTL + LRU 缓存，一轮对话免十几次全量读盘；分支图读路径只读引用缓存（60s TTL + 200 会话 LRU + mtime/size 外部改写校验），大图不再每次迭代全量 structuredClone；模型列表 5 分钟 TTL；工具声明指纹缓存（tools JSON Schema 构建结果按声明/模式/工具逻辑/MCP 版本缓存）；会话元数据读路径与分支图读路径解耦。
    - 热路径算法：上下文裁剪起点由 O(候选历史) 改为前缀扫描 O(n) 预计算；运行时上下文回合内复用，同一回合不再重复生成；流式响应 chunk 用 offset 游标解析，消除每个数据包 Buffer.concat / 字符串拼接的 O(n²)。
    - 前端流式渲染：hljs 已知语言高亮缓存（流式期间同一语言块不再反复全量高亮）；`usedTokens` 增量指纹（每 chunk 免全量历史扫描）；todo 快照尾部增量重放（每 chunk 免全量重放，前缀引用与响应表校验不一致时自动回退）；MessageList 构建/todo sticky 列表短路（无 build / 无 todo 时免扫描）。
    - 前端高频路径：i18n `t()` 翻译缓存（无参键免 split + 查找）；CustomScrollbar 值相等检查（无变化不写响应式 ref）+ rAF 节流 + 贴底阈值；平滑流式增量基线（每 chunk 免累计文本 slice）。
    - webview：分支图富化响应前浅拷贝（配合只读引用缓存契约）；`requiresJsonRoundTrip` 小 payload 短路（高频小消息免分配 visited Set 深遍历）；广播直接迭代订阅者 Set（免每 50ms 复制订阅者集合）；`getExtensionVersion` memo。

### Fixed
  - 修复编辑用户消息保存后候选切换器（‹ 2/2 ›）不立即显示：编辑分支流结束后分支图虽已刷新，但本地窗口中被编辑消息仍保留旧候选 id，`buildCandidateGroupForNode` 判定其为候选组非活跃成员返回 null，需切换会话再切回（loadHistory 重载后 id 与后端一致）才恢复；现 `loadBranchGraph` 刷新成功后把窗口内「候选组非活跃成员」的用户消息 id 对齐为图活跃候选（BR-01 原则：窗口 id 与后端主历史 Content.id 一致），保存后立即可见切换器，幂等不误伤其他路径；新增回归测试（editBranchRefresh.test.ts 第 5 用例：complete 后 id 对齐 + 候选组命中）。
  - 后台任务状态条（BackgroundTaskBar）新增「清除已完成」按钮：一键清除所有已完成的后台任务 chip（运行中保留）；若存在结果尚未汇报给模型的任务（回执未进入对话历史），先弹危险确认框提示再清除，避免静默丢失任务结果；按钮带可清除数量提示，三语 i18n 同步；新增 `backgroundTaskStore.dismissCompletedTasks` 单元测试（backgroundTaskDismiss.test.ts）。
  - 子代理路径 `ToolDeclarationResolver` 监听器泄漏（H-1）：每次 run 新建实例会向 McpManager 单例注册 3 个永久事件监听器且从不释放，重度多代理下监听器无界累积、MCP 事件派发退化为 O(n)；改为按依赖引用共享实例（容量 4 LRU 淘汰），并新增 `dispose()` 释放监听器，同时让子代理路径真正享受声明缓存收益。
  - `ConversationManager` 节点 ID 反查缓存（`nodeIdCache`）失效覆盖不完整：`invalidateCaches` 定义了但从未被调用，saveContents / 全量重写 / 历史迁移 / 删除对话等写路径不失效缓存，工具循环内（拒绝工具调用等结构性变更后 300ms 窗口内）checkpoint 反查可能命中陈旧节点 id；现全部写路径统一走 `invalidateCaches`。
  - 设置搜索下拉键盘导航滚动跟随：结果超出下拉可视高度时，↑/↓ 选中的高亮项现在会保持在可视区域内（`scrollIntoView({ block: 'nearest' })`）。
  - `ContextTrimService.computeValidSuffixMap` 反向扫描与正向 `validateHistoryIntegrity` 在乱序配对时语义不一致（L-5）：functionResponse 出现在其配对 functionCall 之前（跨消息或同消息内）时，正向判孤儿（invalid）而旧反向实现误判 valid，裁剪后可能把乱序配对发给 API；修复为按「本消息内更早 part / 右侧消息 / 待左侧治愈」三分支精确匹配正向语义。
  - 设置搜索跳转时序与状态残留（L-1/L-2）：跳转定位改为按目标元素相对滚动容器偏移计算一次 `scrollTo`（避免 smooth 动画未推进时同步读 rect 的时序冲突、打断动画）；跳转成功后清空搜索词，侧边栏恢复常态高亮；`search.hint` 词条投入使用（搜索框聚焦且未输入时显示提示）。
  - `pendingWholeBuffer` 注释修正（L-4）：原注释声称「上限由硬限制保护」，实际代码对未知格式的整段累积没有大小上限（与改动前行为一致），已修正为准确描述。
  - 新增回归测试：`subagentResolverSharing.test.ts`（监听器只注册一次 / dispose 释放 / 容量淘汰）、`conversationMessageNodeId.test.ts` 补写路径失效断言（仓储替换、删除对话）、`contextTrimValidSuffixEquivalence.test.ts`（computeValidSuffixMap 与正向校验逐候选等价 + 固定 seed 随机模糊对比 50 轮）、`toolDeclarationResolverCache.test.ts`（缓存命中 / 参数与设置指纹与 MCP 版本失效 / dispose）、`settingsSearchAnchorConsistency.test.ts`（SEARCH_INDEX 锚点与组件 data-search-anchor 一致性）、`todoListIncremental.test.ts`（增量重放参数分段一致性）与 `computed.test.ts` 增量分支（流式追加 / 尾消息原地更新 / 前缀替换回退 / 数组缩短 / 总结估算）。
  - 全仓审计修复（PR #17 合并）：①跨对话存档误删——`CheckpointQueryService.removeOrphanBackupDirs` 孤儿判定汇总全部对话的存档记录（有界并发枚举）+ manifest 身份守卫（fail-closed，含 manifest 的目录绝不删）+ 无 manifest 目录的 mtime 新鲜度守卫（创建中窗口跳过）；②代理流式 buffer 偏移——`ChannelManager` 直接以 `parseStreamBuffer` 返回的 remaining 为下轮基线（修复 JSON-lines 逐行格式丢 chunk、SSE 事件跨 chunk 尾随空行切坏 `data:` 前缀）；③总结消息插入窗口中间不可见/重复——`insertMessageAt` 中间插入清可见消息增量缓存；④`StreamAbortManager`：create() 替换控制器时释放 idleWaiters、`waitForIdle` 退休链等待超时后返回（修复 `awaitConversationIdle` → 后台回执永久挂起）；⑤分支图冻结自愈——空占位超龄判定（10 分钟，`isActiveEmptyPlaceholder`）：崩溃/被杀遗留的空 reroll/edit 占位不再让 append 跳过图同步（append 前先收敛、deferred 同步不再永久 defer），超龄幽灵占位软删回收；⑥SubAgent Monitor contentDelta：快照尾部为工具结果时追加新楼层而非覆盖上一轮模型消息（附 5 例回归测试）；⑦分支：deleteToMessage 截断含总结走 summary_deleted 全量重建、edit 流程补写节点 contentMetadata、contentMetadata 排除 turnDynamicContext 快照、修复备份保留数上限；⑧安全：regexGuard 嵌套分组量词检测、SettingsCore 深合并过滤 `__proto__`/constructor/prototype、Memento 写队列串行化、FileSettingsStorage 原子写、McpManager 重连前断开旧 stdio、StdioClient 通知吞错、nodeIdCache epoch 守卫防陈旧回填；⑨前端：autoSummary chunk 不再被 streamId 门禁丢弃（含 tab 缓冲路径）、error 路径结束半截消息 streaming 标志、cancelled/error/本地取消重置 turnBaseTokens、WorkspaceRestoreGuard 等待旧流完全退出、thought 视图模式与裁剪提示按 messageId 持久化 + prune 集成、SummaryMessage 删除/恢复互斥、投递提示按 seq 精确移除。
  - regexGuard 增强（审查后优化）：扫描式嵌套量词检测补「裸量词原子」跟踪（拦截 `(?:a+|(?:ab))+`、`(?<name>a+)+` 等嵌套 + 原子量词形态，同时保持 `(a+)?`/`(ab+)?` 线性形态放行）；正则启发式检测前净化转义序列与字符类（不再误伤 `\(a+\\)+`、`([a+])+`）；范围量词只认可变 `{n,}`/`{n,m}`（定长 `(a{2}){2}` 放行）；新增 10 组检测矩阵用例。
  - `ConversationManager` nodeIdCache epoch 改全局单调计数器 + LRU 容量淘汰（审查后优化）：
    计数器不归零、淘汰只删最旧条目，消除「整体清空后 0===0」与在途读盘回填的碰撞窗口。
  - `modelList` 缓存读写改浅拷贝一层（原 JSON 序列化深拷贝会丢失 undefined 字段且有全量序列化开销）；`FileSettingsStorage` tmp 文件名加随机后缀（并发 save 不再互相踩）+ rename 失败清理残留；`handleAutoSummary` 标记起点下界钳制 `Math.max(0, insertIndex - markedCount)`（负起点会把窗口外消息全部误标记）。
  - 合入上游 7489a9c..70ecbb3（PR #19 记忆删除 + 审查收尾 + diff partial 修复）：
    - memory_forget 语义变更：单个数字 ID 由「截断删除 ID ≥ N 的全部记忆」改为「只删除这一条原始记忆」；新增闭区间模式（`"1,3"` 逗号分隔删除 1 到 3）；MemoryManager 新增 `deleteRange` / `deleteEntries`（去重排序 + 相邻闭区间聚合、从大到小逐个删），`deleteEntry` 委托 `deleteRange`；删除采用「先清树摘要、后原子换 LOG」顺序（崩溃窗口最多摘要缺失、自愈安全，修复此前「新 LOG + 旧摘要」崩溃窗口内已删记忆在 wake 中复活的中危问题）；`logAppend` 锁内按真实 id 精确校验记录容量（消除估算竞态），`MAX_HEADER_BYTES` 常量替换 23 魔术数；设置页新增批量删除（全选/复选/危险确认，`deleteMemoryEntries` IPC，上限 10000），单删/批量删除响应带 `removed`，加载中禁用勾选/删除、残留选中与编辑态清理（防旧 id 错位删错）；三语 i18n 与前端 `memory_forget` 描述（单条/闭区间/摘要三态）同步；新增 deleteRange / memoryForgetTool 回归测试（含 NaN/非整数/lo>hi 等非法参数防御）。
    - diff 部分接受/部分拒绝状态修复：`PendingDiff` 新增 `partial` / `rejectedBlockIndices`，`finalizeAcceptedDiff` 终结时写回 partial 标记（含被拒绝块索引统计），apply_diff 工具结果按「初始成功 - 被拒块 / 初始失败 + 被拒块」修正计数并返回 `status: 'partial'`；`DiffCodeLensProvider.updateBlockStatus` 改按业务下标 `find(b => b.index === blockIndex)`（修复混合成败时稀疏下标静默 no-op 导致会话永不 complete）；前端 apply_diff 面板 partial 徽标与 rejected 块标记、ToolMessage / responseViewer / agentRun reducer / streamChunkHandlers / SubAgentMonitor 状态派生全部识别 partial；三语 i18n 新增 `partial` / `rejectedBlock` 键。
    - 工作区绑定记忆（fork 新增，桌面版/插件版双端生效）：记忆系统新增作用域——全局记忆（`<dataPath>/memory`，旧行为不变）与工作区记忆（`<dataPath>/memory-workspaces/<hash>/`，每个工作区独立 LOG/TREE/config）；工具层经 `ToolContext.activeWorkspaceUri` 路由到对应实例（无工作区回退全局）；设置页「原始记忆条目」分区编辑：全局 / 工作区两分区切换，工作区分区下拉选择已打开工作区后展示该工作区记忆，条目增删改与运行时参数按作用域读写（enabled/systemPrompt 保持全局）；新增 `listMemoryScopes` IPC 枚举全部工作区记忆 scope。
    - 保存工作区显示修复（fork）：工作区下拉「已保存的工作区」完整展示全部收藏（此前过滤掉已打开的收藏条目，导致对话绑定的多个工作区中已打开者不显示），已打开的条目标注「已打开」并可点击直接固定，未打开者点击打开；三语 i18n 同步。


### Added
  - **记忆设置页支持手动增加记忆（设置 → 记忆 → 原始记忆条目）**：此前记忆只能由 AI 通过 `memory_note` 工具写入，用户想记录一条事实/约定必须让模型代劳。现条目列表顶部新增输入框 + 「添加记忆」按钮（支持 Ctrl+Enter / ⌘+Enter 快捷提交），写入链路与 AI 的 `memory_note` 完全等价（同一 `MemoryManager.note`，同样触发待压缩提示）；新增 `addMemoryEntry` IPC 处理器，添加成功提示新条目 ID 并自动刷新列表
  - **记忆条目列表超限保护**：`getMemoryEntries` 支持 `limit`（默认 5000），`MemoryManager` 新增 O(1) 的 `totalEntries()`；海量记忆（10 万条以上）时不再全量 postMessage 传输 + `v-for` 渲染冻结设置页，截断时前端提示「仅展示前 N 条，其余可用 memory_recall 检索」

### Changed
  - **记忆写入容量校验精确化**：`note` / `updateEntry` 此前只按 `entryChars` 校验文本长度，用户把 `entryChars` 调高或 id 位数增长后会在 `pad()` 处以晦涩的 "Too long" 报错（固定宽度记录含 "#<id> <date> " 头部开销）；现按实际 id 精确校验整条记录，报错信息包含头部开销与可用预算；`memory_config` 工具与配置边界的 `entryChars` 上限同步收敛（`LOG_REC - 1 - 23`），工具描述不再写死错误的「最大值 280」
  - **`wake` 连续原始块批量读取**：此前每个原始记忆块一次 `logSlice` → 一次 open/read/close 文件句柄循环（`T ≤ wakeLines` 时一次 wake 可达上万次）；现 cover 输出的连续原始块合并为一次 `logSlice` 批量读取，句柄数降为块数级别，读取结果逐条输出顺序不变
  - **MemoryManager 初始化收敛**：VS Code 扩展（ChatViewProvider）与 Electron 桌面版（BackendHost）重复的「建 memory 路径 → new MemoryManager → init → loadConfig → setGlobal」五连复制粘贴提取为 `initMemoryManager(dataPath)` 共享助手，两宿主行为零漂移

### Fixed
  - **崩溃残留的撕裂尾部记录被当作有效记忆**：日志末尾不足 `LOG_REC` 字节的半条记录此前会被解析成垃圾条目出现在 wake/recall/listEntries 中；现 `records()` 只解析完整记录，下一次追加时由既有 `repair()` 截断修复
  - **`count()` / `logScan()` 静默吞掉 IO 错误**：此前权限/IO 错误一律当成「空日志」，wake 会在文件实际不可读时谎报「没有记忆」；现只把 ENOENT 视为空，其余错误上抛
  - **设置页记忆条目字节校验对齐后端**：新增/编辑条目的字符计数此前用 UTF-16 码元数（中文等多字节字符低估长度，前端放行、后端报错）；现按 UTF-8 字节数校验并实时显示（超限红色提示），错误提示样式不再依赖字符串内容猜测

### Changed（结构收敛）
  - **性能与资源占用优化（子智能体并行审计 + 修复，全链路）**：
    - **流式渐进 Markdown 渲染根治 O(n²) 重解析**：此前流式期间已定型的段落被持续累积进单一字符串，每次渲染 tick（最长 180ms 一次）都把全部累计文本重新做一遍 markdown-it 解析 + 代码高亮 + 整体 `v-html` 替换——回答越长每帧成本线性增长，长代码生成场景流式后期卡顿。现 promote 文本按 `\n\n` 段落边界切块（`$$` 数学块未闭合的边界暂不切，保证与整段渲染语义一致），每块一个独立的 `MarkdownRenderer` 实例（key 不变 → Vue 复用旧块，只渲染新块）；软上限 200 块防御性淘汰最旧块
    - **smoothStreamManager fence 配对扫描增量 化**：此前每帧对全文从零做 fence 配对正则扫描（长代码块流式时每候选段落一次 O(前缀长) 扫描）；现按流实例维护增量扫描状态（只扫新增区间 + 二分计数），`findPromoteCut` 行为完全不变但每帧成本降为 O(delta)
    - **MessageList / MessageItem 热路径缓存**：`allMessageIndexBounds` / `todoStickyMeta` / `mergeableCheckpointKeys` 改为「引用指纹 + 尾部增量」缓存（复用 `getVisibleChatMessagesCached` 模式），流式 50ms 批次不再对全窗口（≤800 条）重复全扫；`availableCheckpoints` / `checkpointsBeforeMessage` 改走 store 新增的 `checkpointLookup` 增量分组（升序 keys + 前缀终点，二分取最近前序），40 个可见实例不再各自 filter+sort 全量 checkpoints（非单调时防御性回退原逻辑）
    - **CustomScrollbar 流式期间布局节流**：`characterData` 变更（流式每帧发生）合并到 ~100ms 窗口批量更新布局，`childList` 结构变更保持即时；卸载时清理挂起定时器
    - **终端输出全链路节流**：此前 stdout/stderr 每个 data chunk 独立 `postMessage`（高频输出命令消息风暴），且前端每次响应式整体重写 `<pre>`；现 `ChatViewProvider` 按 terminalId 聚合 output/error 80ms 批量发送（start/exit 即时且先冲刷未决输出保持顺序），前端 `terminalStore` 只追加字符串、格式完全兼容
    - **`execute_command` 每次执行的外部进程开销消除**：热路径不再每次 spawn 子进程检测 shell 可用性（改走已存在的 5 分钟 TTL 同步缓存，错误文案语义不变）；Windows 前台命令不再额外启动 `powershell.exe` 设置优先级（前台本就是默认 Normal，纯浪费），后台命令改用 `execFile` argv 数组形式（无 shell 解析面）
    - **`search_in_files` 并发化**：最多 1000 个文件从逐文件串行 I/O 改为受控并发（并发度 8，复用 `mapWithConcurrency`，结果保持原文件顺序）；replace 模式拆两阶段——并发只读扫描 + 串行 diff 审阅（保持审阅顺序语义不变）
    - **`pushOutputLines` 截断摊销化**：5 万行上限后不再每个 chunk 都 `splice(0, dropped)` 整段前移，累计超限 1000 行才清理一次（O(n²) → O(1) 摊销）
    - **`waitForDiffResolution` 轮询降耗**：100ms 常驻轮询降为 1.5s 兜底轮询（事件驱动为主）+ 5 分钟最长等待上限，超时按「用户中断」语义收敛，杜绝永不结算的 pending diff 空转
    - **`ConversationManager` 读路径深拷贝消除**：`getMessages` 逐条 `JSON.parse(JSON.stringify)` 深拷贝与分页路径浅拷贝方案对齐（IPC 序列化天然隔离）；`cloneJson` 统一为 `structuredClone`（快数倍且保 `undefined`）；`getCustomMetadata` 缓存命中只克隆目标键，不再整份 metadata 克隆
    - **`getMessageNodeIdAt` 缓存 TTL 300ms → 30s**：此前工具循环中相邻两次反查间隔超过 300ms 即缓存失效，导致每轮反复全量重读 transcript 文件（写路径已统一失效该缓存，TTL 仅兜底外部直写）；顺带 `usageCache` 降级 mtime 扫描从 15s 同步 stat 风暴改为 60s + `fs.promises` 异步递归
    - **`fileTree` 缓存命中跳过 statSync**：TTL 内不再每次 `statSync` gitignore 文件（miss 时才同步遍历全树）；`createProxyFetch` 按 proxyUrl 记忆化（不再每次请求重建闭包 + 重解析代理）；`PromptManager` 占位符正则模块级预编译缓存；`i18n.t()` 加载时拍平为 Map 查找 + 缺失 key 告警去重（只告警一次，不再刷屏）
    - **Electron 桌面版**：`graycode://` 协议静态资源缓存改 LRU（热点大 bundle 命中即刷新，不再被小资源挤出反复读盘）；`workspace.json` 改 `.tmp` + rename 原子写（崩溃不再损坏收藏工作区记录）；e2e 端口改监听 0 取实际端口（消除并行冲突）；esbuild target `node18` → `node20` 与 engines 对齐；CI 去掉重复的 vue-tsc 全仓检查（build 内置一次即可）+ 增加 30 分钟超时

### Fixed
  - **ToolDeclarationResolver 事件监听器泄漏**：每次 SubAgent 执行 / `ChannelManager.setMcpManager` 重建都会向全局 McpManager 累积 3 个永久监听器（长会话无界增长、闭包阻碍 GC）；新增 `dispose()` 解绑（executor 用完即释放、重建前先解绑）
  - **`cleanupTerminals` 死代码**：活跃进程表只靠 close/error 事件清理，挂死进程条目永久滞留；现 `ChatViewProvider.dispose()` 调用清理
  - **工具注册双重实例化**：注册探针不再执行工厂（此前每次启动多一轮工具声明构建 + shell 检测 execFileSync 阻塞），read_skill 仍以真实工厂注册
  - **Electron 主进程崩溃恢复**：新增 `uncaughtException` 处理（错误对话框提供重启选项）；渲染进程 `render-process-gone` 自动 reload（最多 2 次后弹窗，防死窗）；`before-quit` 二次触发竞态修复（dispose 期间二次退出不再截断写队列，统一由首次收尾）
  - **`monitor-smoke` CI 挂起**：失败/异常时不再让进程无窗口挂死，try/catch/finally + 状态码退出（与 e2e 对齐）
  - **`Selection.isReversed` 逻辑错误**：`anchor === end` 恒假，改为 `anchor.isAfter(active)` 的官方语义
  - **前端资源清理补全**：`ToolMessage` 的 `seenDiffToolIds` / `persistedDiffGuardWarnings` 加 500 上限 + 会话切换清空；`InputBox` 预览消失定时器保存句柄并在卸载时清理；`terminalStore.initialize()` 保存取消函数并暴露 `dispose()`（App 卸载时调用）；`FileHandlers` 高亮定时器挂到装饰器 dispose 生命周期

### Changed（结构收敛）
  - **`execute_command` / `diffManager` / `search_in_files` 重复逻辑收敛**：图片尺寸解析（PNG/JPEG/WebP/GIF）两份同构实现统一为 `parseImageDimensionsFromBytes`；plan/design/progress 三处 `ensureParentDir` + 多工作区路径策略统一收敛到 `backend/tools/pathPolicy.ts`（薄封装保留原导出）；四处分散不一致的忽略列表统一到 `backend/tools/ignoreLists.ts`
  - **`ConversationManager` 三处重复的「未响应工具调用拒绝/补齐」逻辑**提取到 `backend/modules/conversation/TranscriptMutation.ts` 共享纯函数（杜绝语义漂移）
  - **`extension.ts` 瘦身**：导出设置/导入设置/迁移旧对话历史三个命令的完整 UI 流程抽取到 `webview/commands/settingsTransfer.ts`（依赖注入，行为逐字等价），入口只留注册与生命周期编排
  - **`ModuleRegistry` 日志降噪**：注册/注销改 debug 级

### Tests
  - 全量回归：backend jest 215 套件 / 2196 用例、frontend vitest 55 文件 / 551 用例全绿；新增/更新 `fileTree.test.ts`（缓存命中跳过 gitignore stat 的新语义）、`MessageItem.test.ts`（checkpointLookup mock）、`MessageItemStreaming`（分块渲染）、`smoothStreamManager`（增量 fence 扫描）等；Electron e2e / monitor-smoke / uismoke 冒烟通过

## [1.6.9] - 2026-08-07

### Merged
  - 增量合入上游 `70ecbb3..cf9330d`（5 提交：记忆隔离移植 986c4d9、子代理工具轮幻觉剥离 e1d71ec、测试类型引用 92473f0、PR #20 记忆隔离审查修复 80a9fc7、merge cf9330d），保留 fork 的 electron-app / 多工作区 / 安全加固增量：
    - **记忆隔离作用域加固（PR #20 审查）**：`memory_wake`/`recall`/`zoom` 等只读工具不再隐式创建工作区记忆目录（`createIfMissing=false`，只读访问零磁盘副作用）；`memory_wake` 续读时 "T=" 快照过期不再误判为「已读完」跳过——改用该作用域自身当前总数重试，跨作用域 snapshotT 不匹配时内容不丢；`memory_*` 工具新增 `scope` 显式参数（`global`/`workspace`），工作区解析失败不再静默回退全局（防跨工作区记忆污染）；wake/recall 输出段头带作用域与工作区名标注，顶层元数据（blocks/part/totalParts/totalMemories/pendingCompression）改为双作用域合并口径
    - **H4 自动建会话即绑定工作区**：`ConversationManager.loadHistory`/`getMessages`/`getMessagesPaged`/`normalizeHistoryForDisplay` 透传当前工作区 URI，webview 读取入口按需自动创建的会话在创建时就写入 `workspaceUri` 元数据（避免记忆工具回退全局造成跨工作区污染）；`createConversation` 两者皆空归一为 `undefined`（不再持久化字面 null）；`ToolExecutionService` 新增 `conversation_unbound_workspace` 每会话一次告警（把静默降级变为可观测）；前端切换对话时对未绑定工作区的会话用当前活动工作区补绑（`syncConversationWorkspaceUri`，已有绑定/分支继承不覆盖）
    - **记忆设置页作用域配置隔离**：`getMemoryConfig`/`updateMemoryConfig` 按 `data.workspaceUri` 读写对应作用域 MemoryManager 的运行时配置（`loadConfig()` 读磁盘最新值），工作区 tab 保存的数值不再污染全局配置；`listMemoryScopes` 改为「当前激活工作区优先」排序（默认选中项与用户当前项目一致，防记忆写入历史项目造成隔离错位）
    - **子代理工具轮幻觉剥离**：xml/json prompt 模式下，模型在发起工具调用的同一轮"抢跑"输出的文本（无工具结果前的幻觉预生成）从该轮 parts 剥离，不进 history/续跑上下文；`lastResponse` 只在无工具调用的最终轮更新——失败/空响应时 `partialResponse` 不再携带幻觉文本（新增 `subagentPartialResponse.test.ts` 5 例回归）
    - **nodeIdCache epoch 写链守卫**：`getMessageNodeIdAt` 读盘不持会话写锁，读盘前后 epoch 一致才允许回填缓存（消除写提交与旧盘面回填之间的竞态窗口；epoch 全局单调 + LRU 淘汰防清空后归零碰撞）
    - **存储统计/迁移纳入记忆目录**：`StoragePathManager` 的清理/迁移/统计覆盖 `memory` 与 `memory-workspaces`
    - 冲突解决要点：`ConversationManager` 保留 fork 缓存体系（30s TTL + 权威回填，弃用上游移除 historyCache 的做法）；`SettingsHandlers.listMemoryScopes` 保留 fork 收藏工作区口径（上游 `vscode.workspace.workspaceFolders` 不适用于桌面版）；`ConversationHandlers` 保留 fork `assertSafeId` 校验与 trim 清理；webview 多工作区（WorkspaceManager/终端节流/多文件夹 skills 扫描）与前端多工作区体验（切换恢复工作区/标题附加工作区名/消息索引清理）全部保留；i18n 保留桌面键并补充 `workspaceNone`/`newlineNotAllowed`（文案适配桌面版）
  - 合入上游 `80e9de7`（混合形态消息 functionCall+functionResponse 同消息拆分 tool 消息）**修正版**：上游原提交把 formatter 的 else-if 链改为独立 if，修复「同消息 call+response 时 response 被吞」的同时引入严重回归——「文本 + functionCall」同消息的日常形态被重复推送为第二条 assistant 消息，且 tool/tool_result 消息不再紧跟 tool_calls（OpenAI/Anthropic 400，上游实测 function_call 模式整体失败）；桌面版合入时在普通消息分支加 `functionCallParts.length === 0` 守卫，混合形态修复与日常形态行为两全（新增 `formatterMixedToolMessage.test.ts` 上游 3 例 + 回归 2 例）

### Added
  - 记忆工具新增 `scope` 显式参数（global/workspace）与设置页记忆作用域配置隔离（详见上方 Merged）

### Fixed
  - 修复 `memory_wake` 续读时跨作用域 snapshotT 不匹配被误判为「已读完」跳过导致内容静默丢失（改用该作用域当前总数重试）
  - 修复只读记忆工具（wake/recall/zoom）隐式创建 `memory-workspaces/<hash>/` 目录的磁盘副作用
  - 修复工作区记忆解析失败时静默回退全局记忆的跨工作区污染风险（改为显式报错）
  - 修复自动创建会话未绑定工作区导致记忆工具回退全局的跨工作区污染（H4）
  - 修复子代理失败/空响应时 partialResponse 携带工具调用前幻觉预生成文本（e1d71ec）
  - 修复 nodeIdCache 读盘回填竞态（写提交与旧盘面回填之间 300ms 窗口陈旧节点 id）
  - 修复混合形态消息（同消息 call+response）转换时 functionResponse 被吞（80e9de7 修正版，含日常形态回归防护）

### Tests
  - 全量回归：backend jest 225 套件 / 2291 用例、frontend vitest 63 文件 / 610 用例、tsc --noEmit 全绿；新增 `memoryWakeScopes.test.ts`（跨作用域 snapshotT 重试 / nextPart 合并推进 / 压缩提示作用域标注 / 只读不建目录）、`subagentPartialResponse.test.ts`（5 例）、`formatterMixedToolMessage.test.ts`（混合形态 3 例 + 日常形态回归 2 例）、`MemorySettings.test.ts`（作用域缓存防闪烁等）

### Added（1.6.9 迭代二）
  - **子代理界面可选择模型**：设置 → 子代理的「模型」下拉框此前选项恒为空（只读渠道配置里已持久化的 `models` 数组，默认 `[]`），表现为「只能选渠道、不能选模型」，运行时子代理永远跑渠道默认模型。现模型选项改为「本地持久化列表优先，缺失时经 `models.getModels` 实时拉取 provider 模型列表，并始终把渠道默认 `model` 兜底进选项」（与主聊天 write_file/MessageTaskCards 的 `loadModelsForChannel` 口径一致）；渠道切换时自动选中新渠道默认模型（不再强制清空 modelId）；新建子代理对话框补齐模型选择（渠道联动 + 默认模型预填，创建 payload 携带 modelId）
  - **全局 diff 文件绑定对话 + 无损压缩**：
    - 此前 apply_diff/write_file/insert_code/delete_code/search_in_files 每次工具调用都把完整 original/new 内容写入 `diffs/__global__/` 且永无删除路径，磁盘无限增长（`cleanupOrphanedDiffs` 显式跳过 `__global__`）。现 `saveGlobalDiff`/`saveGlobalDiffDeferred` 支持传入 `conversationId`：落盘到 `diffs/{conversationId}/` 对话目录并写入 `diffs/index.json` 归属索引（tmp+rename 原子写、写队列串行化）——删除对话时 `deleteConversationDiffs` 一键清理对应目录 + 索引 + 内存缓存；`cleanupOrphanedDiffs` 同步清理孤儿目录的索引条目；已删除对话墓碑拦截 deferred 后台落盘复活目录
    - **gzip 无损压缩**：diff 文件内容经 zlib gzip（level 6）压缩后落盘，JSON 文本（代码内容）通常可压缩 3-5 倍，磁盘增长速率大幅减缓；读取时按 gzip 魔数自动识别，旧版明文 JSON 完全兼容；`loadGlobalDiff` 查找顺序：内存缓存 → 索引定位对话目录 → `__global__` 回退（旧数据）
    - 迁移路径（`migrateTo`）覆盖 index.json 并重置索引缓存

### Fixed（1.6.9 迭代二）
  - **`memory_wake` 分页/续读历史残留移除**：wake 一次输出双作用域全部可用记忆（近期原文 + 远期摘要），不再按 PART_CHARS/PART_LINES 分页、不再输出 "part N of M" 段头、不再要求模型连调 `memory_wake part=2,3...` 续读到 "You are awake."——所有相关历史残留（`part`/`snapshotT` 参数、`wakeScope` 续读重试、`paginate()`、`totalParts` 字段、`Not awake yet` 提示）全部移除；`partChars`/`partLines` 运行时配置项从类型/工具声明/设置页/三语 i18n/README 全链路删除，存量 config 文件中的 PART_* 行自动忽略；`recall` 输出上限改用独立常量（不再借用已删除的分页配置）
  - **StreamChunkProcessor 视图缺失时终结事件静默丢弃**：视图重建/销毁窗口期 `processChunk` 对 `complete`/`cancelled`/`error` 终结 chunk 整块丢弃且不 flush 缓冲，前端永远收不到旧流终结 → 占位消息永久「生成中」、isStreaming 无法复位、缓冲滞留内存。现终结类 chunk 暂存待视图恢复后补发（`pendingTerminalBuffer`），无 view 时 `flush()` 清空缓冲防滞留，error 仍返回 true 供调用方中断循环（新增 `streamChunkProcessor.test.ts` 8 例）
  - **`StreamAbortManager.waitForIdle` 活跃控制器分支无超时**：活跃流 finally 永不执行时 `waitForIdle` 永久挂起（后台回执通道挂死）；现复用 `OLD_STREAM_EXIT_WAIT_TIMEOUT_MS` 为活跃分支加超时兜底（新增回归用例）
  - **会话删除后 fire-and-forget 分支图同步复活已删除会话（幽灵 branches.json）**：`appendContents` 锁外分支图同步闭包不检查 `deletedConversationIds`，会话删除后闭包仍创建/写入分支文件；现闭包内「读图前 + 写图前」两道删除守卫（与 BranchService BS-4 互为兜底）
  - **`isFirstMessageHistory` 把隐藏 functionResponse 误判为「首条用户消息」**：隐藏续接（Plan 执行确认）场景动态系统提示词被错误当作首条消息刷新，多余 token 消耗；现增加 `!isFunctionResponseMessage(active[0])` 条件（与文件内其它判断口径一致）
  - **工具循环 `maxIterations === -1` 无终止保障**：-1 无限制模式下唯一退出保障是可选 abortSignal，模型持续返回工具调用时请求永久挂起（占会话写锁与内存）；现新增硬性兜底：迭代硬上限 10000（`MAX_ITERATIONS_HARD_CAP`）+ 墙钟 30 分钟上限（`MAX_TOOL_LOOP_WALLCLOCK_MS`），触发时报错 `MAX_TOOL_ITERATIONS_HARD_CAP`/`TOOL_LOOP_WALLCLOCK_LIMIT` 走上层错误通道（仅作用于 -1 模式，有限模式语义零变化；三语 i18n 同步）
  - **流式早启动工具 `.catch` 吞掉全部异常伪装成工具失败**：编程错误/系统错误被包装成 `{ success: false, error }` 写入历史，错误分类失真；现仅 `ChannelError`（可预期执行失败）保持原包装，其余系统异常记录 `log.error` 并以空占位沉降（进度队列正常落定、不重复执行），抛出走上层统一错误通道
  - **`ChannelManager.generateStream` 重试时非内容 chunk 重复产出**：`yieldedAny` 在收到 usage/元数据等无内容 chunk 时已置 true，空响应重试会把这些 chunk 再 yield 一遍（token 统计可能双计）；重试界限改为「已产出可见内容」`yieldedContent`
  - **子代理默认运行时长硬编码不一致**：General Worker 描述写 2400s、实际默认 1800s、预设/文档数值不一；现统一为单一常量 `DEFAULT_MAX_RUNTIME_S = 1800`（executor 默认 + 工具描述 + General Worker 配置 + 类型默认全部引用）
  - **diff 存储压缩/索引层健壮性加固（复扫修复）**：
    - 索引写链（`indexWriteChain`）一次失败后永久失效：旧实现 `chain.then(...)` 遇到一次 IO 错误后整条链变成 rejected，后续所有索引写入永久失败（文件写成功但永不入索引 → 重启后全部绑定 diff 不可达）；现链首 `.catch(() => {})` 自愈，单次失败只影响当次并上抛给调用方
    - 写入顺序改为「先索引、后文件」：旧顺序崩溃窗口产生「文件有、索引无」的永久孤儿文件（load 永远找不到、cleanup 因对话仍有效不清理 → 磁盘增长以新形式回归）；新顺序崩溃窗口只留下「索引有、文件无」的陈旧条目，`loadGlobalDiff` 读到缺失文件时按 ENOENT 自愈删除（瞬时读错误不误删）
    - `rememberDiffOwner` 磁盘写失败时回滚内存索引条目（防止内存与磁盘漂移、幽灵条目随下次成功落盘写进 index.json）
    - 索引写失败时 diff 回退 `__global__` 存储（load 兜底路径仍可找到内容），不再写不可达文件
    - `getStorageStats` 不再把 `index.json`/`__global__` 计入会话数；`migrateTo`/`initialize`/`updateBasePath` 路径变更时重置索引缓存（防旧路径条目跨路径污染）；`cleanupOrphanedDiffs` 清孤儿目录时同步标记墓碑（拦截在途 deferred 落盘复活目录）
    - 新增回归测试 3 例：索引写链故障恢复 / 幽灵索引自愈删除 / 统计口径

### Tests（1.6.9 迭代二）
  - 全量回归：backend jest 226 套件 / 2305 用例、frontend vitest 63 文件 / 610 用例、tsc --noEmit 与生产构建全绿；新增 `diffStorageDeferred.test.ts`（gzip 压缩写盘 / 旧版明文兼容 / 对话绑定落盘 + 删除清理 + 索引定位 / 索引写链故障恢复 / 幽灵索引自愈 / 统计口径）、`streamChunkProcessor.test.ts`（8 例）、`streamAbortWait.test.ts` 增补（waitForIdle 活跃分支超时）；`memoryWakeScopes.test.ts` 分页续读用例改写为单次全量输出断言

## [1.6.8] - 2026-08-06

### Fixed
  - **对话工作区独立（已关闭的绑定工作区仍然生效）**：此前桌面版切换「打开的工作区」后，绑定工作区的文件夹会从 `workspaceFolders` 移除，工具路径解析（list_files/read_file/write_file/apply_diff/search/find/execute_command/媒体工具等）全部静默回落到**当前打开的工作区**——对话上下文里还是原工作区的文件树，工具却读写新工作区的文件，AI 会误报「工作区内容与任务上下文不一致」（例如绑定项目 A 的对话在打开项目 B 后把 B 当成了工作区）。现解析层对对话绑定工作区提供「虚拟工作区」能力（按 URI 重建 index=-1 的虚拟文件夹，目录已删除时回退旧行为）：
    - `backend/tools/utils.ts`：`getWorkspaceByUri` 支持已关闭的绑定工作区；`parseWorkspacePath` 单工作区/无工作区时优先解析到绑定工作区（支持绑定工作区名前缀剥离）；`findWorkspaceForAbsolutePath` 增补 preferred 参数，绑定工作区内的绝对路径归属该工作区
    - `backend/modules/prompt/fileTree.ts`：`getWorkspaceFolderByUri` 虚拟解析，绑定工作区已关闭时文件树/静态环境/诊断/固定文件仍限定原工作区（不泄漏当前打开的项目）
    - `backend/tools/search/find_files.ts`：单工作区模式也按绑定工作区搜索；`search_in_files` / `execute_command` / 媒体 `pathGuard` / `list_files` 的「无工作区」守卫改为「无工作区且无绑定工作区」
    - `webview/utils/WorkspaceUtils.ts`：新增 `resolveWorkspaceFolderByUri`，`validateFileInWorkspace` / `checkFileExists` 对已关闭的绑定工作区做虚拟归属校验（Windows 大小写不敏感）；`webview/handlers/FileHandlers.ts` 的 `resolveTargetWorkspaceFolder` 同步支持
  - 新增回归测试：`backend/__tests__/tools/boundWorkspaceIndependence.test.ts`（相对路径/绝对路径/名前缀/目录删除回退）、`fileTree.test.ts` 增补「绑定工作区已关闭时按虚拟 URI 生成文件树」
  - **打开/保存工作区（多工作区收藏）在桌面版完全失效的根因**：`vscode-shim` 的 `showOpenDialog` / `showSaveDialog` 把 native 层的 Electron 形状结果（`{ filePaths, canceled }` / `{ filePath, canceled }`）原样返回给按 VS Code 契约消费的调用方（`result.length` / `result[i].fsPath` / `result.fsPath`）——打开工作区文件夹弹窗、收藏工作区打开、存储路径选择、设置导入/导出全部静默退化为「取消」。现 shim 统一转换为 VS Code 契约（`Uri[] | undefined` / `Uri | undefined`），工作区收藏「保存 + 打开 + 重启保留」链路在桌面版端到端打通；存储路径选择与设置导入/导出同步修复
  - **设置导入/导出的对话框 filters 形状不匹配（与上述同族）**：VS Code 契约的 `filters` 是 `{ 'JSON Files': ['json'] }` 对象，native.ts 原样透传给 Electron（要求 `[{ name, extensions }]` 数组）导致过滤被忽略/对话框异常；新增 `normalizeDialogFilters` 统一转换
  - **桌面版 `env.openExternal` 拒绝 `file:` URI（「打开 Skills 目录」等按钮静默无效）**：`file:` URI 走不了 `shell:openExternal` 的 http/https/mailto 白名单；现 shim 对 `file:` 方案的 Uri 改走 `shell:openPath`（含目录/可执行扩展名校验），与 VS Code 中打开系统资源管理器的语义一致
  - 修复说明：vscode-shim 全链路扫描（子智能体审查）未发现其他同等级 P0 形状不匹配；已知的 P1 降级项（文件写盘与文档事件脱节、未注册命令桩等）另行跟踪
  - **打开/保存工作区（多工作区收藏）仍失效的残留根因（本轮彻底扫描修复）**：
    - **60s 队列超时斩杀原生对话框**：`workspace.openFolder` / `storagePath.selectFolder` / `settings.import` / `settings.export` 的 handler 会 await 原生对话框（用户浏览文件夹可能远超 60 秒），此前在 `messageHandlingQueue` 串行队列中等待，60s 超时先触发并回传 `HANDLER_TIMEOUT`——前端请求已结算，用户稍后选完路径 handler 才继续执行（收藏已写入、工作区已切换），但迟到响应被前端当作广播丢弃，UI 状态不同步，表现为「打开/保存工作区点了没反应」。现四个对话框驱动类型全部移入 `NON_BLOCKING_MESSAGE_TYPES`（fire-and-forget，响应仍按 requestId 路由回发起方），`MessageRouter.ts` 同步
    - **打开收藏工作区失败被静默吞掉**：收藏目录已被删除/移动时（`WORKSPACE_FOLDER_NOT_FOUND`）或超时等错误，前端 `openWorkspaceFolderAction` 仅 `console.warn`，用户看到「点了没反应」；现统一经 `showNotification` 弹出错误提示（取消对话框不打扰）
    - **响应返回过期工作区状态**：`vscode.openFolder` 在宿主侧异步生效（native 层 fire-and-forget），handler 先于 `__setWorkspaceFolders` 返回过期列表/激活工作区，前端拿旧状态覆盖广播；现 `openWorkspaceFolder` 打开后轮询等待列表生效（≤3s）再响应（`WorkspaceHandlers.waitForWorkspaceOpened`）
    - **File 菜单打开的工作区不进入收藏**：`File > Open Workspace Folder…` 走主进程 `pickWorkspaceFolder`，不经渲染层消息路径，打开的工作区不在「已保存的工作区」列表；现 `BackendHost` 新增 `addSavedWorkspaceFsPaths`（与 WorkspaceHandlers 同键 `graycode.savedWorkspaces` 写入同一 `global-state.json`），File 菜单打开即加入收藏，多工作区「保存 + 打开 + 重启保留」闭环补全
    - **收藏写入 fire-and-forget，退出竞态丢数据**：`persistSavedFsPaths` 不 await，打开工作区后立即退出收藏可能丢失；现改为 await 写队列（VS Code 契约一致），`ElectronContext.FileMemento` 新增 `flush()` 并在 `BackendHost.dispose()` 排空（`before-quit` 兜底）
    - **Windows 路径大小写敏感比较**：`__setWorkspaceFolders` 差集、收藏去重、已打开判定一律按 Windows 大小写不敏感比较（`C:\Foo` 与 `c:\foo` 不再误判 added+removed 触发技能重复扫描/列表闪烁，同一目录不再重复触发宿主替换）
    - **新增显式「保存当前工作区」入口**：此前收藏只在打开文件夹时隐式写入，没有显式保存动作，用户找不到「保存工作区」；现工作区选择器下拉新增「保存当前工作区」菜单项（`workspace.saveCurrent` handler + 前端 action，无激活工作区时报错、已在收藏时置灰幂等），三语 i18n 同步
    - **顺带修复 WorkspaceHandlers 的 i18n key 前缀错误**：`t('webview.errors.*')` / `t('webview.dialogs.*')` 在三语语言包中均不存在（实际命名空间是顶层 `errors.*` / `dialogs.*`），此前所有错误/对话框文案实际显示为原始 key 字符串；已统一修正
  - **设置页搜索不能覆盖全部设置项（本轮彻底扫描修复）**：
    - `SEARCH_INDEX` 从 22 条页签级条目扩展为 **110 条**（17 个页签兜底 + 93 条带 `data-search-anchor` 精确锚点的设置项条目），17 个设置组件（渠道/工具/自动执行/MCP/子代理/存档/总结/图像生成/依赖/上下文/提示词/Token 计数/通知/外观/记忆等）共 93 个设置块逐个加锚点——搜索「API URL」「多模态」「传输类型」「白名单」「宽高比」「分支清理」「排除配置」「音量」「开屏动画」等具体设置项不再搜不到，点击结果直达对应设置块（精确锚点 → h4 → h3 → 首个锚点 → 节容器 五级回退）
    - **dependencies 页签 i18n key 缺失**：`settingsPanel.sections.dependencies` 在三语中均不存在，搜索结果行显示原始 key 字符串且跳转失败；现三语补齐
    - **匹配空格敏感**：`'token 用量'` 匹配不到 `'token用量'`；query 与关键词统一去空白后 `includes`
    - **移除误导性关键词**：appearance 的「主题/字体/深色/亮色/界面/ui/语言」（外观页不存在）、tools 的「重试/git/固定文件」、channel 的「提示词模式」（实际在 prompt 页）等误导词删除，改为各页真实设置项
  - **同名嵌套工作区目录（zip/7z 双解压）路径错位一层**：工作区根下存在与工作区同名的真实目录（`proj/proj/...`）时，`parseWorkspacePath` 的绑定工作区前缀剥离把首段误当「工作区名前缀」——文件树索引里显示的 `proj/README.md` 被解析到根下的 `README.md`，read_file/write_file/list_files/搜索/命令 cwd 等全部 ENOENT（现场会话中模型只能靠「加双前缀」绕过）。现仅当工作区根下**不存在**同名目录时才剥离前缀；存在时按原样解析（与索引展示一致），多层重名（`proj/proj/proj/...`）同理只判定首段；路径等于工作区名时解析到同名嵌套目录本身。新增回归测试（双层/多层/写入/纯目录名/无嵌套不回归）

### Added
  - **设置页设置项搜索**：设置面板标题栏新增搜索框——输入关键词实时过滤（结果下拉 + 侧边栏命中页签高亮、未命中置灰），支持键盘上下键选择与回车跳转；点击结果自动切换到对应页签并滚动定位到设置项（节标题或精确锚点，附带 1.6s 闪烁高亮），搜索「存储路径/代理/语言/导入导出/应用信息」可精确直达对应设置块；内置中/英/日三语关键词索引（`SettingsPanel.vue` 静态 `SEARCH_INDEX`），空结果有提示文案，三语 i18n 同步

### Tests
  - 新增 `backend/__tests__/webview/workspaceHandlers.test.ts`（8 用例）：保存当前工作区（无激活报错/加入收藏/幂等）、打开工作区（目录缺失报错/已打开直接固定不重复触发宿主/未打开经宿主打开并等待生效后返回新状态/对话框选择自动收藏/取消不写收藏）、收藏持久化在响应前完成
  - `messageRouterNonBlocking.test.ts` 增补对话框驱动类型（workspace.openFolder / storagePath.selectFolder / settings.import / settings.export）非阻塞断言
  - `boundWorkspaceIndependence.test.ts` 新增「同名嵌套工作区目录」套件（5 用例）：双层同名嵌套按真实路径解析（读写）、多层同名嵌套逐层解析、路径等于工作区名时解析到嵌套目录本身、无同名嵌套时前缀剥离行为不回归

## [1.6.7] - 2026-08-06

### Merged
  - 增量合入上游 67d7fb6..f204689（40 提交，对应上游 1.4.2/1.4.3 发布）：
    - **长期使用时间统计**（`backend/modules/activity`）：ActivityTracker 以「60 秒心跳 + 用户活动事件」采集 IDE 活跃时间（监听编辑/光标/滚动/切换编辑器/终端/窗口聚焦，连续 5 分钟无活动或失焦即暂停，过滤挂机），AI 工作期间同样记活跃（模型流式生成/工具执行/子代理/后台任务打点），按天原子落盘；统计层提供每日使用时长、24 小时作息热力、当前连续工作时长（间隔 ≤15 分钟视为同一会话）；新增 AI 工具 `get_activity_stats`；用量统计页新增「使用时间」区块（今日/连续工作/近 7 天总览 + 每日条形图 + 作息热力网格 + 7/30/90 天/1 年/全部范围切换与月度聚合）；设置面板新增「用量统计」页签（内嵌使用时间区块 + Token 用量摘要 + 完整统计入口）；`StoragePathManager` 存储目录新增 `activity`，工具分类新增「使用时间」
    - **tokenizer 词表改为运行时联网下载**：后端新增 `TokenizerResourceManager`（cl100k 来自 OpenAI CDN、DeepSeek V3 来自官方 api-docs zip，下载/解压/转换/本地缓存到数据目录，启动复用不再联网，`adm-zip` 解压）；前端经 `tokenizer.getResource` 消息通道获取、`js-tiktoken/lite` 加载；移除 `gpt-tokenizer` 依赖与内置词表（vsix 瘦身 ~4MB），下载失败/离线回退字符类别加权估算
    - **TPS 统计接入模型专属 tokenizer + 自校准**：DeepSeek 用官方 `deepseek_v3_tokenizer` 转换词表（与官方 Python 基准逐位一致）、其余模型用 cl100k；流结束用 usage 真值按模型 EMA 学习校准因子（离群剔除 + localStorage 持久化，系统偏差收敛到 ~3~5%）；工具参数与思考 token 均计入生成速度；超长文本分批计数
    - **自动总结历史丢失修复（物理替换语义）**：自动总结从「只插入不删除」改为物理替换（同一写锁事务内删除被总结区间，`STALE_RANGE` 并发校验防吞当前用户输入、`LOW_QUALITY_SUMMARY` 质量校验）；流式 chunk 透传 `removedCount`、非流式循环补 abort 检查；自动总结始终保留第一条用户消息（删除起点不越过首条真实用户消息，请求组装时首条用户消息早于最后总结则拼到头部）
    - **渠道默认流式输出与自动重试覆盖**：新渠道 `options.stream` 默认 `true`；HTTP 成功但空内容或流式零产出 → `EMPTY_RESPONSE_ERROR` 自动重试；已产出内容但缺 done 标记（上游/代理掐断）→ 显式抛「流式输出被截断」不再假装成功（已产出内容不重试）；ChannelError 原样透传不再误包 PARSE_ERROR
    - **后台命令降 CPU 优先级**：`execute_command` 后台启动的 shell 进程降为低优先级（Windows BelowNormal 优先级类 / POSIX nice +5），跑测试/长任务时让出 CPU 给前台交互
    - 后端修复批次：MCP stdio 缓冲 16MB 硬上限 + 单条消息 4MB 拒发；`McpManager.handleServerNotification` per-server 刷新串行化 + 代际重查；工具并行只读组 abort-race + 2s 收尾窗口；`fileWriteLockManager` release 时 generation 通知等待者 + 50ms 兜底轮询（消除 25ms 固定轮询空转）；checkpoint 快照 stat 复用补 size 校验；`mailboxDrainEpochs` 会话删除清理；`repeatedCallGuard` 大字符串改采样哈希；`ToolRegistry.getFilteredDeclarations` 别名归一化；`SettingsCore.reset` 深拷贝；`taskManager.cleanup` 真正清扫终态任务
    - 前端修复批次：CustomScrollbar marker 扫描节流（字符变更不再每帧强制布局）；`chatStore.initialize()` 监听器幂等防重复订阅；终端输出 200KB 截断；MessageRouter 条目兜底清理；SubAgentMonitor run 终态缓存清理；MarkdownRenderer imageCache 32MB 字节预算；平滑流式反查索引 O(1)；agentStopNotificationController 日志收敛为 debug；删除 scrollTop 死代码
    - UI：系统提示词设置页「保存配置」按钮加大加宽（24×24 图标 → 带文字实底按钮）并修复窄窗口文字折行；消息操作按钮补 tooltip 与 compact 布局 `flex-shrink: 0`；EditDialog 底部按钮强制单行；欢迎页图标改为开屏动画同款手绘 Gray logo（补齐右侧头发色块）；开屏动画与 TPS 条改为外观设置可开关（`splashEnabled` / `tpsBarEnabled`）；使用时间统计默认近 7 天；`get_activity_stats` 工具补齐三语 i18n；纯 tsc 下 `.vue` 类型噪音清理（`vite-env.d.ts` shim 宽松 + `MessageItem.vue.d.ts` 旁路声明）
    - 上游 PR #14 设置持久化修复与 fork 独立实现（bdf9b36）同源，双端语义已一致
    - 保留 fork 的 electron-app / 变更查看面板 / 媒体工具路径护栏 / 多工作区 / 独立版本号增量

### Changed（性能与资源占用优化）
  - **后端读路径去重**：checkpoint 消息节点反查（`getMessageNodeIdAt`）加 300ms 短 TTL + LRU 缓存，不再每回合十几次全量读盘；分支图读路径返回只读引用（去掉每迭代一次的全图 structuredClone），缓存加 200 会话 LRU 上限；模型列表拉取加 5 分钟 TTL 缓存；工具声明（tools JSON Schema）按「渠道/模式/启用工具集/MCP 版本」指纹缓存，工具循环每迭代不再重建整棵 Schema
  - **后端热路径算法优化**：上下文裁剪起点归一化由 O(候选×历史) 改为单遍前缀扫描 O(n) 预计算；动态运行时上下文在回合内复用（不再同回合加载两次）；流式响应 chunk 解析改 offset 游标累积（消除每数据包 Buffer.concat / 字符串拼接的 O(n²) 拷贝）
  - **前端流式渲染优化**：hljs 已知语言代码高亮加有界缓存（流式期间同一增长代码块不再每次全量重高亮）；`usedTokens` 改增量指纹（每 chunk 不再全窗口逆序扫描）；todo 快照改尾部增量重放（不再每 chunk 全量重放全部消息×工具）；MessageList 的 build/todo sticky 计算加短路与指纹，无 build / 无 todo 工具时零扫描
  - **前端高频路径**：i18n `t()` 翻译结果缓存（无参调用免 split+逐层遍历）；CustomScrollbar 布局值相等检查（无变化不写响应式 ref）、滚动改 rAF 节流、贴底跟随加 2px 阈值；平滑流式文本增量基线（不再每 chunk 对整段累计文本 slice 拷贝）
  - **Electron 内存与 IPC**：`diffPreviewContents` 加 50 条淘汰上限（对齐 VS Code 版，防无界增长）；EventEmitter fire 零分配监听快照（版本号惰性重建）；`workspace.workspaceFolders` getter 结果缓存（热路径免重复 Uri 编码）；渲染层广播直接迭代订阅者 Set；`requiresJsonRoundTrip` 小 payload 短路（高频小消息免全树深遍历）；`getExtensionVersion` 加 memo；删除 BackendHost 死代码
  - **CI**：GitHub Actions 构建矩阵收敛为仅 Windows（移除 ubuntu/macos），不再吃 Linux/mac 打包报错

## [1.6.6] - 2026-08-06

### Added
  - **工作区选择器收藏（多工作区收藏列表）**：顶部栏工作区选择器（文件夹图标下拉）由原生 `<select>` 重写为自定义下拉菜单——「跟随活动编辑器」、已打开的工作区列表、收藏工作区列表三区展示；收藏列表持久化在宿主侧（VS Code 扩展 `globalState` / 桌面版 `global-state.json`，跨窗口与重启保留），点击收藏条目快速打开（已在当前窗口打开时直接固定为活动工作区，未打开时经宿主打开），条目右侧小 × 一键移除收藏；菜单底部新增「打开工作区文件夹…」入口（加号图标），弹窗选择后自动加入收藏并打开。新增后端处理器 `workspace.getSaved` / `workspace.removeSaved` / `workspace.openFolder`（webview/handlers/WorkspaceHandlers.ts），前端新增 `savedWorkspaces` 状态与 `loadSavedWorkspaces` / `removeSavedWorkspace` / `openWorkspaceFolder` / `openSavedWorkspace` actions（frontend/stores/chat），三语（zh-CN / en / ja）文案同步补齐
  - **Electron 桌面版 `vscode.openFolder` 支持**：vscode-shim 的 `executeCommand('vscode.openFolder')` 经主进程新增原生操作 `workspace:openFolder` 打开指定文件夹并替换当前工作区（持久化到 workspace state，窗口标题同步更新）；收藏工作区快速打开由此端到端打通

### Changed
  - **仓库改名同步**：GitHub 仓库已由 `czocelot/Gray-Code-ocelot` 改名为 `czocelot/Gray-Code-Desktop`，全部文档与链接同步更新——`README.md` / `README_EN.md`（徽标、下载、clone、issues 链接与 clone 目录名）、根与 electron-app 的 `package.json`（repository.url / homepage / author.url）、设置页「应用信息 → 仓库」链接（frontend/src/components/settings/SettingsPanel.vue）

### Fixed
  - **多对话并发编辑多工作区的 checkpoint 全局根锁（并发编辑可用性的最大阻碍）**：存档创建此前对**全部工作区根**做快照并持有全局文件根锁 `''`（与所有路径互斥），对话 A 每次写工具前后（默认配置对 write_file/apply_diff/execute_command 等全部写工具在 before+after 建存档）的存档期间，绑定其他工作区的对话 B 的写工具全部 `lockConflict` 失败。现 `createCheckpoint` 按对话绑定的工作区（`conversationManager.getMetadata().workspaceUri`）裁剪快照范围与锁范围（`CheckpointOperationLock` 新增 `fileLockPaths` 选项，按工作区根绝对路径加锁；未绑定/绑定工作区已关闭时回退全部根，旧行为不变）——绑定不同工作区的对话在彼此存档期间可无冲突地并发写文件，真正实现多 AI 多工作区并行编辑
  - **文件写锁 key 不按对话工作区解析（跨工作区误冲突/漏锁）**：`ToolExecutionService` 加锁前把写目标路径按对话绑定的工作区解析为绝对路径（与工具执行同一口径 `resolveFileToolPathWithInfo`）再 `tryAcquire`；此前多工作区下同名相对路径（如 `src/a.ts`）解析失败回退进程 cwd 相对路径，不同工作区的同相对路径会映射到同一锁 key 造成误冲突，或映射到不同 key 造成漏锁。diff 预览延迟写盘路径（`PendingDiff.absolutePath`）本就用绝对路径，无此问题
  - 回归测试（CheckpointManagerWorkspace）：绑定工作区对话的存档只快照该工作区根、未绑定对话仍快照全部根、绑定对话存档期间其他工作区的写锁持有者不受阻塞

## [1.6.5] - 2026-08-05

### Merged
  - 增量合入上游 10c565c..67d7fb6（4 提交，详见 [Unreleased]）：TPS 条移除空闲期随机模拟假数据并精确归零（`SETTLE_EPS`）、工具调用输出计入 TPS；CharFlow 流式字符流水线渐进渲染（高频直连/低频快照 + 渐进 markdown 提升与折叠预览修复）；开始动画「草稿→上色」叙事升级与主界面承接淡入；平滑流式生命周期修复（toolsExecuting 终结清理移至函数末尾，覆盖无 content 增量路径）。保留 fork 的 electron-app / 变更查看面板 / 媒体工具路径护栏 / 多工作区 / 独立版本号增量

### Fixed
  - **记忆删除的树摘要残留（子智能体审查修复）**：`MemoryManager.deleteEntry` 删除最后一条记忆（id=T-1）时不再清空覆盖被删记录的尾部树摘要——删除后 T 收缩，`TREE/2` 的 `[T-2,T)` 块、`TREE/4` 的 `[0,T)` 块等仍引用已删内容；此后 `note` 使长度回升时 `wake`/`zoom` 会重现已删除的记忆且 `pending()` 认为该块已压缩而永不重建。现按新长度截断树文件（与 `truncateLog` 同口径）：完全位于保留区内的块摘要保留、覆盖被删记录的块清空。另将重建循环的逐条全量 `Buffer.alloc(T*LOG_REC)` 改为单条 `LOG_REC` 复用缓冲（超大记忆集删除不再有内存尖峰），损坏文件中的空记录改为跳过而非 break（后续有效记录不再被静默丢弃）。新增「删尾条目树摘要截断 + 摘要不重现已删内容」回归测试
  - **分支图 append / 删除同步绕过了 60s TTL 缓存（声称未落地）**：`appendHistoryToGraph` 与 `syncGraphAfterHistoryDelete` 此前直接 `repository.load()` 全量读盘，主历史每次 append 的「读图 → 改 → 原子写回」仍重复全量磁盘 IO。现收敛到与 `loadGraphForWrite` 共用的 `loadGraphCached`（缓存命中 + mtime/size 校验 + 语义损坏拒绝覆盖），热路径磁盘 IO 实际削减
  - **metaCache 未命中路径返回活引用**：`getMetadataLight` / `loadStoredMetadata` 的未命中路径把刚缓存的 `result.value` 原引用直接返回、`getMetadata` 损坏 fallback 路径把已缓存的 `fallback` 原引用返回——调用方原地修改会污染缓存。现缓存一律存 `structuredClone` 快照、返回深拷贝；`persistMetadata` 写后回填同样存快照（保存后原地改 meta 不再污染缓存）
  - **负缓存 null 遮蔽 getMetadata 的历史重建 fallback**：meta.json 缺失（not_found）时 `getMetadataLight` 先负缓存 null，后续 `getMetadata` 命中 null 直接返回，不再走磁盘路径按历史重建——有历史无 meta.json 的会话标题/时间戳持续缺失直到下次写入。现 `getMetadata` 命中 null 时先探测历史索引：历史仍存在则继续走磁盘重建并回填缓存。新增 2 项回归测试
  - **getMetadataLight 声称的 structuredClone 未落地**：命中路径仍是 `JSON.parse(JSON.stringify(...))`（序列化往返开销与声称不符），现统一改为 `structuredClone`
  - **流式平滑显示层在 toolsExecuting 后泄漏**：`handleToolsExecuting` 收到 content 后消息已置非流式、正文输出结束，但未终结平滑条目（`smoothTexts` + manager entry）——流在 toolsExecuting 后异常终止（无终结事件且未走 cancelStream）时条目残留。已随增量合入上游 67d7fb6 统一：`finishSmoothStreamForState` 移至函数末尾无条件执行（toolsExecuting 即当前模型文本段终点，无 content 增量同样清理当前流条目；放完积压、销毁实例、删除显示文本，UI 立即切回真实 content）；工具返回后模型续写正文时 `pushSmoothText` 以当前 part 真实文本为基线重建实例（与段落切换语义一致）。新增回归测试
  - **前端 i18n 参数替换的 `$` 替换模式注入**：`useI18n.translate` 用字符串替换 `result.replace(regex, String(params[key]))`，参数值含 `$&`/`$1`/`$'` 时被 `String.replace` 解释成替换模式（如文件名 `price$1.txt` 变 `price.txt`）。现改为函数替换 `() => String(params[paramKey])`（与核心 i18n 模块写法一致）。新增回归测试
  - **Electron About 菜单在 macOS 关窗后崩溃**：`dialog.showMessageBox(mainWindow!, ...)` 无空值/销毁守卫，macOS 关闭全部窗口（window-all-closed 不退出）后点击 About 抛 "Object has been destroyed"；现与 `native.ts` 的 `usableWindow` 模式一致退化为无父窗口对话框。`pickWorkspaceFolder` 同步补 isDestroyed 检查；before-quit 的 `dispose()` 改经 `Promise.resolve().then` 包裹（dispose 同步抛错不再绕过超时兜底与 `app.exit(0)`）
  - **HttpClient MCP 握手 clientInfo 版本硬编码 1.0.5**：HTTP/SSE MCP 传输的 `initialize` 仍硬编码过期版本，与 Stdio 客户端不一致（已统一走 `createGrayCodeMcpClientInfo`）；现 HTTP 客户端同样改用统一工厂函数
  - **TokenCountService 外部 abort 透传是死代码（声称未落地）**：`fetchWithTimeout` 的 `externalSignal` 参数存在但 8 个计数请求调用点无一处传入，停止流/切会话时进行中的计数请求只能等 15s 超时。现贯通全链：`countTokens` / `countTokensWithChannelConfig` / `countTokensBatch` → 四路提供商方法 → `fetchWithTimeout`，`TokenEstimationService`（preCountUserMessageTokensBatch / countSystemPromptTokens / countTextTokensBatch）与 `ContextTrimService.getHistoryWithContextTrimInfo` / `getHistoryWithGranularFallback` 透传，`ToolIterationLoopService` 流式/非流式两路径以回合 `abortSignal` 传入——停止按钮可立即中断回合前的计数请求
  - **execute_command WSL 同步检测仍用 `execSync` 字符串拼接**：`checkShellAvailabilitySync` 的 `wsl --status` 是常量字符串（无注入面），但与"同步检测统一 execFileSync 参数数组"的口径不符；现改为 `execFileSync('wsl.exe', ['--status'])`
  - **ContextTrimService 窗口未知时拒绝退化为 UNKNOWN_ERROR**：`getHistoryWithGranularFallback` 的 `throwContextOverflow` 在模型 `contextWindow` 未知且无合法候选（历史结构损坏）时抛普通 `Error`，前端错误码退化为 `UNKNOWN_ERROR`；现以渠道 `maxContextTokens` 作为 envelope 参考上限照常抛 `ContextBudgetExceededError`（保持 CONTEXT_OVERFLOW 语义）
  - **会话删除不清理回合级 fallback 切点缓存**：`granularFallbackStartByConversation` Map 在对话删除路径未挂钩，已删会话条目缓慢累积；新增 `ChatHandler.handleConversationDeleted`（清 `clearTrimState`），`deleteConversation` handler 删除成功后调用（失败仅告警不阻断删除）
  - 清理 App.vue 遗留 `.loading-container` 死样式（changelog [1.6.4] 声称已清理但实际残留）；修正 lineDiff trace 内存注释（实际约 1/2，非 1/4）与缓存淘汰语义文档（命中移队首的 LRU，非字面 FIFO）

### Tests
  - 后端：deleteEntry 删尾树摘要截断、metaCache 负缓存不遮蔽 fallback 重建、损坏降级回填后 getMetadataLight 不再负缓存 null、nonStreamAutoSummarizeTurn 适配 abort 透传新签名
  - 前端：handleToolsExecuting 平滑条目清理（含无 content 增量同样终结当前流条目）、useI18n 参数值 `$&`/`$1`/`$'` 原样输出

## [1.6.4] - 2026-08-05

### Merged
  - 同步上游 49a37f2..10c565c（PR #11/#13 等：启动动画 Splash、TPS 实时可视化与流式平滑输出（SmoothStreamer / smoothTexts / TpsBar）、上下文预算三层重构（`ContextBudgetExceededError` / `CONTEXT_OVERFLOW` 仅真实超窗抛出、模型窗口软/信封/硬边界、固定 prompt 计入预算、低收益总结跳过）、diff 工具行级差分缓存与批量加载并行化、子代理 transcript 索引投影与惰性加载（`lastSentHistoryProjection`）、run 终态落盘 flushRun、单会话停止不再取消全局未决 diff、对话删除检查点清理失败显式报错、上游回移植 fork 的 `getMetadataLight` 元数据缓存等性能优化），保留 fork 的 electron-app / 变更查看面板 / 媒体工具路径护栏 / 多工作区 / 独立版本号增量

### Changed
  - 工作区文件树按 (工作区 + 深度 + 自定义忽略模式 + 节点预算) 键控加 30s TTL 缓存：工具循环中每轮请求同步重建整棵目录树（`readdirSync` 全递归，最多 10000 节点）的磁盘 IO 与正则求值大幅减少；`.gitignore` 的 mtime 纳入每次命中校验（改动即失效重建），其余文件变更接受 TTL 内短时陈旧（与 `getSystemPrompt` 60s 缓存同级语义）；新增 `invalidateFileTreeCache` 供测试/诊断清理
  - `getMetadataLight` 缓存命中返回从 `JSON.parse(JSON.stringify(...))` 深拷贝改为 `structuredClone`：对话列表分页（每页 30 条 × 16 并发）命中路径的序列化往返开销显著下降
  - `getCustomMetadata` 改走 metaCache（复用 `getMetadataLight`）：trimState / todoList / pinnedFiles / skills / subAgentRuns 等键在工具迭代热路径每轮读取多次，此前每次都是整份 meta.json 的磁盘读 + JSON parse
  - `getMetadata` 损坏降级（fallback 重建）结果回填 metaCache：损坏文件改名备份后 `getMetadataLight` 曾负缓存 null，导致对话列表标题/时间戳持续缺失直到下次写入；现重建即回填，且与轻量读共享同一缓存
  - SubAgent `flushPersist` 落盘从「getCustomMetadata 全量读 + setCustomMetadata 链内重读」合并为单次原子 `updateCustomMetadata`（链内读改写）：子代理流式期间每 1.5s 的落盘 IO 减半，且消除两次读取不一致的隐含分支；store 未实现原子接口时自动回退读改写
  - 分支图（branches.json）按文件路径（baseDir + conversationId，天然区分多工作区）加 60s TTL 内存缓存：主历史每次 append 的「读图 → 改 → 原子写回」不再重复全量磁盘 IO；命中前 stat 校验 mtime+size，文件被仓储之外的路径改写时自动失效；缓存存/取均为快照深拷贝，杜绝调用方原地修改污染
  - 历史段缓存字节估算从全量 `JSON.stringify` 改为前 16 条抽样按比例外推：段内可能含数十 MB 超大工具结果，缓存写入不再付出二次全量序列化成本（字节软上限仅用于 LRU 淘汰优先级，无需精确）
  - 前端 i18n 参数替换的占位符正则按转义键缓存（`useI18n.translate` 在消息列表/工具卡渲染中高频调用，不再每次 `new RegExp`）
  - 消息项加 `content-visibility: auto` + `contain-intrinsic-size`：长对话上拉展开后视口外消息由浏览器原生跳过渲染/样式计算（兼容性回退 = 无样式类特性，仅失去优化）
  - 工具结果合并逻辑收敛为公共 `utils/toolResult.mergeToolResult`（MessageList / MessageTaskCards / todoList 三处实现语义分叉统一）；工具名/描述 i18n 收敛到 `utils/toolLocalization`（useCheckpointConfig / AutoExecSettings / DependencySettings）
  - ToolMessage 自动确认倒计时从 50ms tick 降频为 200ms：有 pending diff 时每秒响应式更新从 20 次降为 5 次（显示粒度 100ms 不变）
  - Shell 可用性检测缓存加 5 分钟 TTL：运行期间新装 shell（如 WSL）不再需要重启才能被工具声明识别
  - 流式热路径诊断日志（`handleToolsExecuting` / `handleToolIteration` / `handleComplete` / `handleStreamChunkBatch` 跳批统计）改由性能诊断开关（`localStorage.graycode.perf=1`）门控：默认关闭时不再执行模板字符串拼接与计数；agentStopNotificationController 生命周期调试日志改由 `localStorage.graycode.debug=1` 开关门控
  - 生产构建压缩：根 esbuild 单次构建与 Electron 桌面构建 `minify: true` / 关闭 sourcemap（watch 模式保留原始形态）；主进程 bundle 体积与启动解析时间下降
  - 前端主入口分包：vue/pinia、highlight.js、katex+markdown-it 拆为独立 vendor chunk（主入口 2.38MB → 1.55MB），mermaid/cytoscape 保持原生动态 import 懒加载（不做 modulepreload 预取）；桌面端 `graycode://` 协议与 VS Code webview 均按相对路径加载，mtime 缓存已覆盖
  - Electron 桌面版主进程包：`readRootPackageMetadata` memoize（打包后 package.json 不变，公告/版本检查多路径不再重复同步读盘）；`__setWorkspaceFolders` 按新旧列表差集生成 added/removed（此前把保留文件夹重复报为 added 导致技能重复扫描、被移除文件夹不触发清理）；dialog/reload 对已销毁窗口（`isDestroyed`）加固，不再抛 "Object has been destroyed"
  - 公告检查的 CHANGELOG.md（数百 KB）解析按 mtime+size 缓存：升级后首次启动与设置页重复触发不再全量读+正则解析
  - `esbuild.config.js` 移除无引用的 external `typescript`；`electron-app/build.mjs` 支持 `--dev`（保留 sourcemap/未压缩）与 `--watch`；electron-app 新增 `typecheck` script（首次接入即修复工作区变更监听从未真正 dispose 的隐患）；CI 增加后端 jest + 前端 vitest 单测与三端 typecheck 步骤、同一分支连续推送自动取消旧构建（concurrency）

### Fixed
  - 移除无引用的运行时依赖 `@vscode/codicons`（图标由 `resources/codicons` 内置 CSS/字体与 VS Code 宿主提供）与 `nanoid`（ID 生成实际走 `generateId`/`randomUUID`），锁文件同步后 npm audit 仍为 0 漏洞
  - **设置持久化丢失（重启回滚）**：`VSCodeSettingsStorage.save()` 的「只写变更键」快照直接保存活对象引用，保存成功后同一嵌套对象的原地变更（自动执行 `toolAutoExec`、工具策略 `toolPolicy`、预设条目 `promptEntries.enabled`、`toolsConfig.*` 各类工具配置、单工具开关）被 `deepEqual` 的 `a===b` 引用短路误判为「无变化」而跳过写盘——UI 显示正常但重启全部回滚。快照改存深拷贝与活对象解耦；`saveToolsConfigEntry` / `setToolAutoExec` / `setToolEnabled` 同步改为整体替换对象（防御任何存储实现）；新增「load 后原地变更 ×2 + 重启读回」回归测试
  - **原始记忆条目无法删除（功能缺失）**：设置页「原始记忆条目」此前只有查看/编辑、无删除入口。新增 `MemoryManager.deleteEntry`（真·单条删除：读全量 → 过滤 → 重编号 → tmp/rename 原子写回，删除中间条目后其后的 id 前移一格并清空旧树摘要；与 `truncateLog` 的尾部截断不同，不会连坐误删之后的记忆）、`deleteMemoryEntry` handler、设置页删除按钮 + 确认框（三语 i18n）；`memory_forget` 工具描述强调「单个数字 ID 是截断模式，会删除该 ID 及之后所有记忆」，防模型/用户误解连坐误删；新增 6 项回归测试
  - 清理遗留调试输出：App.vue 复制/加载日志、SoundSettings 预览日志、ToolExecutionService 多模态丢弃日志（降级 debug）、format.ts 5 个无引用死函数、test/jest.setup.ts 空文件；三处 hover 定时器（InlineContextMessage / ContextBlocks / InputBox）补卸载清理

## [1.6.3] - 2026-08-05

### Merged
  - 同步上游 016706f..49a37f2（PR #10 等：子代理续跑同 run 身份与 transcript、分支树面板重构为轨道式泳道「完整消息图」+ 工具分类分组、总结模型透传（summarizeContext 处理器 / 自动总结当前模型 / 独立总结渠道隔离）、上下文管理关闭时手动总结边界生效、MCP server ID 由服务器名生成可读 ID），保留 fork 的 electron-app / 变更查看面板 / 媒体工具路径护栏 / 多工作区 / 独立版本号增量
    - 上游 1.4.1 条目原文（部分内容已随 PR #9 在 [1.6.2] 记录，此处为上游条目全文，供核对）：

### Fixed
  - 修复流式平滑输出折叠思考预览变空（被透明字符“挤出去”）：折叠预览是单行滚动容器，CharFlow 开启 `followEnd` 后每次 append 滚到最右端，而新字符带 `animation-delay` 错峰淡入——delay 期间 `opacity: 0` 但占据布局宽度，滚动目标恰好落在透明占位字符上，高 tps 时预览区永远显示空白占位。现折叠预览（`MessageRenderBlock`）注册显示层时禁用淡入（`noFade`，直接文本追加），最右端始终是真实可见字符；展开态保留逐字淡入。
  - TPS 条移除空闲期随机模拟假数据并修复归零/统计口径：`TpsBar` 删除「流不活跃时伪造 ~12 tok/s 波动」的模拟逻辑（含 is-sim 视觉弱化），流结束/空闲时直接绘制 `tpsMeter` 真实 EMA 衰减曲线——柱子自然变矮滚出屏幕、不再被瞬间清空，归零后保持 `0.0 tok/s` 与空画布直到下一轮真实流；`tpsMeter` 新增归零阈值 `SETTLE_EPS`（无事件时 EMA 衰减到 0.05 tok/s 以下精确归零，浮点衰减不再悬停在不可见小值）；工具调用输出计入 TPS：`streamChunkHandlers` 在 functionCall 增量到达时按函数名 + 参数 JSON 长度粗估 `record`（此前仅文本 delta 计入，工具参数流式输出期间曲线错误回落）。
  - 删除消息范围或单条消息前等待主流真正退出：`deleteMessage` / `deleteSingleMessage` 先经 `abortAndWaitForCompletion`（或 `cancel` + `waitForIdle`）等待流退出再执行删除，避免停止后的迟到写入覆盖删除结果。
  - 修复扩展宿主重启后子代理 Monitor 永久显示 running/queued：加载历史 run 记录时把上一宿主遗留的非终态记录纠正为 `interrupted`（当前进程仍活跃的 run 不受影响，按快照存在性区分）。
  - 修复 shell 可用性检测的命令拼接注入面：`checkShellAvailability` 的 wsl / where / which 检测从 `cp.exec` 字符串拼接改为 `cp.execFile` argv 数组传递（customPath 属用户可控配置，不再拼进 shell 命令）。
  - Webview CSP 加固：ChatViewProvider 与 SubAgentMonitorPanel 的内联脚本从 `'unsafe-inline'` 改为 nonce 机制（每面板随机 nonce，脚本标签显式携带），不再依赖内联执行豁免。
  - 前端正则高亮 ReDoS 护栏：新增 `regexGuard`（源长度 500 上限 + 危险分组量词检测 + 构造失败回退），history_search 高亮不再因畸形正则阻塞 Webview 渲染线程（与后端搜索护栏同一限制）。
  - 修复手动总结请求丢失当前对话模型：`summarizeContext` 处理器此前只转发 `conversationId` / `configId` / `abortSignal`，前端载荷中的 `modelOverride` 在 webview 层被丢弃，频道配置 `model` 为空时总结请求仍发送空模型名（HTTP 404: No available providers at the moment）。处理器现原样透传 `modelOverride`，与后端 `SummarizeService` 的模型透传修复（含独立总结渠道隔离与默认模型回落）闭环；新增处理器层透传回归测试。
  - 修复总结请求不携带当前对话实际选中的模型：频道配置 `model` 为空、用户在界面临时选择模型时，手动总结（`SummarizeService.handleSummarizeContext` 读取请求 `modelOverride`）与流式/非流式自动总结（`ToolIterationLoopService` 两处调用透传当前回合 `modelOverride`）此前均向 OpenAI 兼容接口发送空模型名（HTTP 404: No available providers at the moment）；使用独立总结渠道时主动隔离主对话模型，未显式指定总结模型则回落到独立渠道自身默认模型，不再错误继承主对话的 `modelOverride`。
  - 修复手动总结假成功：上下文管理关闭时发送路径直接从索引 0 读取历史，忽略已存在的手动 summary 边界（总结消息只插入历史而不物理删除旧消息），界面显示总结成功、下一次请求却仍携带全部旧上下文。现 `ContextTrimService` 在策略禁用时也查找并应用最后一条总结边界作为发送历史起点（decision.action = `manual_summary_applied`）。
  - 修复编辑分支 / reroll 流停在「工具待确认」（awaitingConfirmation 终结）后 BranchSwitcherBar 不显示新候选：`streamHandler` 的 `awaitingConfirmation` 分支此前遗漏 `finishBranchStreamTracking`（complete/error/cancelled/toolIteration 终结均有，唯此遗漏），`_pendingBranchRefreshAfterStream` 标记残留导致分支图不刷新——用户点「保存」后不切对话看不到「‹ 2/2 ›」切换器，切换对话触发 `loadBranchGraph` 后才恢复。现 `awaitingConfirmation` 终结同样消费标记并刷新分支图（后端编辑候选在流开始时已落盘，刷新安全且即时）；新增 `editBranchRefresh.test.ts` 覆盖 complete / cancelled / toolIteration 审批门闸 / awaitingConfirmation 四种终结路径
  - 上下文阈值恢复为自动总结软触发条件，不再作为主 Agent 请求硬上限：`ContextTrimService` 预算体系重构——fallback 拒绝边界只取当前模型明确声明的 `contextWindow`（`ContextBudgetExceededError` / `CONTEXT_OVERFLOW` 仅在最小合法请求仍超窗时抛出），模型元数据缺失时最多 best-effort 裁剪，渠道 `maxContextTokens` 与默认值不再伪装成硬边界；`contextThreshold` 只触发自动总结与优先压缩目标，关闭上下文管理时也不因总结阈值/显示上限阻止主请求（新增显式总开关与旧版双开关回归测试）
  - 跳过固定 prompt 占比过大时的低收益自动总结：系统提示词 + 动态上下文（`fixedPromptTokens`）计入预算——固定 prompt 已超软阈值且新增历史很少时跳过总结（decision.action = `auto_summarize_skipped_low_savings`）并继续主请求；真实窗口已超限时仍进入请求级 fallback（`hard_fallback_needed`），位于软阈值与硬窗口之间时原样继续；`ToolIterationLoopService` 流式/非流式路径把 `fixedPromptTokens` 透传给 `getHistoryWithGranularFallback`，fallback 预算细化为软预算（threshold 与模型窗口 95% 取小、扣除 provider 预留）、完整窗口 envelope 与硬边界三层
  - 修复总结预算口径：手动总结不再受自动总结输入比例（默认 50%）提前拒绝，仅在接近总结模型真实窗口（95%）时预检失败返回 `CONTEXT_OVERFLOW`；自动/手动总结按 `actualModelId` 解析模型 `contextWindow`（独立总结渠道用总结模型、否则用当前对话模型），预算计入内置总结提示词、用户总结提示词与 provider 预留（`resolveSummaryInputBudget`）；`resolveSummarizeRange` 保留预算支持 `mainModelOverride`，按主对话实际模型窗口解析而非渠道显示上限
  - 修复 SubAgent transcript 大对象重复保存与持久化生命周期：终态 `lastSentHistory` 改用索引投影（`lastSentHistoryProjection` v1，可匹配 `contents` 的消息只存 `contentIndex`、无法匹配的内嵌原文，还原时只保留 provider 消费的 role/parts），大型工具结果/图片不再在 transcript 内保存两份，运行中仍保存完整数组；独立 transcript 按需惰性加载（`transcriptLoaded`，Monitor 聚焦/续跑/改消息时才读正文，恢复会话只读轻量 metadata）；工具返回前 `flushRun` 等待终态 transcript 与元数据落盘（有限重试，扩展重载不再把已完成 run 误判为 interrupted）；`continueFromRunId` 续跑前检测 `transcriptLoaded === false` 并先加载完整 transcript（保住 provider 前缀缓存命中所需的 `lastSentHistory`）
  - 修复停止/删除生命周期边界：单会话停止只取消该会话的未决 diff（`cancelAllPending(conversationId)`），仅 `cancelAllStreams` 仍执行全局清理（此前停止 A 会话会取消 B 会话等待确认的 diff）；检查点备份/索引位于扩展 globalStorage，`deleteCheckpoint` / `deleteCheckpointsFromIndex` / `deleteAllCheckpoints` / 批量删除在无工作区时改用稳定虚拟锁键继续删除（此前静默失败）；对话删除时检查点清理失败返回显式错误（`DELETE_CONVERSATION_CHECKPOINT_CLEANUP_FAILED`）且不再继续删除会话
  - 上下文溢出错误消息本地化与投影性能优化：`SummarizeService` 的 `CONTEXT_OVERFLOW` 与 `ContextBudgetExceededError` 对外消息改走 i18n（zh-CN/en/ja），`ChatHandler.formatError` 统一按 code 透出并携带估算参数（流式/非流式同一出口）；终态 `lastSentHistory` 索引投影改为「粗桶 + 惰性精确索引」两级匹配（大型 parts 不再全量 stringify 作 Map key），`flushRun` 落盘重试次数提取为 `MAX_FLUSH_RETRY_ATTEMPTS` 常量
  - 修复流式输出中长代码块无法滚动：`MarkdownRenderer` 通过 `v-html` 渲染，内容每次更新都会整体重建 DOM，代码块内部滚动容器（`pre.code-block-wrapper`，`max-height: 400px` + `overflow-y: auto`）因此被销毁重建、`scrollTop` 归零——流式期间长代码块一旦出现滚动条就无法滚动（滚动位置被重置、滚动条滚不动）。现流式期间（`is-streaming`）在根节点挂 `is-streaming` 类，CSS 据此放开 `pre` 的 `max-height`（自然展开，用户跟随输出阅读），流式结束后移除类、恢复 `max-height` 限制与内部滚动；思考块（thought）内的 `MarkdownRenderer` 同步透传 `is-streaming`（此前缺失），使思考过程里的长代码块同样生效。新增 `MarkdownRenderer.test.ts`（is-streaming 类切换、代码块结构完整性、流式内容追加渲染）与 `MessageRenderBlock.test.ts`（思考块 is-streaming 透传）。
  - 修复流式平滑输出生命周期清理不全（SmoothStreamer 与 smoothTexts 条目泄漏）：`handleError` 与终结性 `toolIteration` 此前先置空 `streamingMessageId` 再清理导致清理 no-op；complete/cancelled 的占位 id → 持久化 id 迁移后按新 id 清理残留旧条目；`cancelStream`/`cancelStreamAndRejectTools`/`deleteMessage`/`deleteSingleMessage`/`clearMessages`/`resetConversationState`/`closeTab`/`switchTab` 等本地重置路径（closeTab 时后端 cancelled 被后台缓冲丢弃、前端收不到终结）全部补上清理；占位 id 迁移时同步迁移 manager 条目键；`disposeAllSmoothStreams` 挂到 webview 卸载兜底。
  - 修复流式平滑「替换最后一个文本/思考块」在新段落前导空白时错位（上一段已完成内容被平滑文本覆盖 → 消失→重现闪烁）：纯空白 delta 不再进入平滑层（与 flushText 的 trim 语义对齐）；显示层 `smoothTexts` 值改为携带 `partKey`，`RenderBlock` 增加 partKey 标识，`MessageItem` 只替换 partKey 匹配的块、找不到匹配块（快照重建的合并块）时回退真实文本。
  - 修复流式平滑档位实时切换跳变：off→on 时新建 streamer 以当前 part 已累计真实文本为显示基线（不再整段消失重打）；on→off 时立即 flush + dispose + 删除显示文本，切回真实内容。
  - 修复流式结束/中断时超长代码块高度塌缩导致阅读位置丢失：`MarkdownRenderer` 流式期间记录实际高度超过限制的代码块，`is-streaming` 类解除时对这些块保留展开态（`keep-expanded`，`max-height: none`），用户点击换行按钮或滚动离开该块后恢复正常高度限制；流式类采用「滞后副本」过渡，杜绝先塌缩再弹回的闪烁。
  - 修复 TPS 条在 Agent 工具执行/思考停顿（>2s 无 token）时误显示随机模拟数据并来回切换：TpsBar 引入「流活跃」信号（`chatStore.isStreaming || isWaitingForResponse`）——流活跃期间只显示真实（衰减）曲线、禁止启动模拟；模拟阶段加视觉区分（透明度降低）。修复 `tpsMeter.record` 无容量上限（webview 隐藏/后台流停表期间 events 无界增长）：记录上限 1000 条、超出丢最旧。

### Changed
  - 流式输出期间已完成段落即时渲染 markdown（渐进式提升）：`CharFlow` 新增 `settledText`/`promote`——已定型文本到达安全段落边界（以空行 `\n\n` 结尾、且行首代码围栏 ```/~~~ 配对，未闭合代码块整块保留到围栏闭合）时，把该前缀从字符流水线剥离并交给 `MessageItem` 新增的渐进 `MarkdownRenderer` 即时渲染，未完成尾巴继续逐字淡入；长回答不再等到输出结束才出现格式。段落切换/终结时渐进内容随显示层释放（稳定块完整接管，无重复显示）；档位切换与组件重建（切标签页）时 promote 边界（`promotedText`）随 entry 继承/重放，CharFlow 只恢复未提升尾巴，显示连续不跳变。
  - 初次载入「开始动画」升级为完整叙事（Splash.vue）：蓝图点阵背景 + 晕影聚焦；笔尖光点沿描线路径执笔画出少女（SMIL `animateMotion` + `mpath` 直接引用线稿 path，先帽后身，与描线 `stroke-dashoffset` 同曲线同节奏）；完稿瞬间线条定影提亮、此后呼吸待机；标题改为「Gray 粗 / Code 细」+ 蓝色终端光标 `▍` 闪烁 + 副标题「AI CODING ASSISTANT」；原横线脉冲替换为 3-bit 格雷码等待线（000→001→011→010→110→111→101→100 循环，每步恰好只变一位，ready 后归一为蓝色实线）；淡出升级为 blur+scale 消散，`.chat-view` 加 0.3s 淡入承接；`DRAW_TOTAL_MS` 1400→1700、`minDisplayMs` 默认 1100→1700，描线/定影/格雷码时间轴严格对齐；prefers-reduced-motion 分支同步更新（SMIL 光点直接隐藏）；测试常量同步。
  - 开始动画「草稿→上色」叙事升级 + 格雷码线可见性修复（Splash.vue）：SVG 改双层结构——色块层（body 按 M…Z 拆块：身体/头发/脸镂空/帽檐/帽身，后画的覆盖重叠区）在描线完成后 1.6s 起 `ink-in` 错峰渗入（身体 1.6s / 帽子 1.75s），线稿同刻退位为细描边（`line-retire` 动画，delay 自元素插入起算，与 settled 类时机解耦）；灰阶色块用 `color-mix` 从 currentColor 派生，亮/暗主题自适应；定影闪光挪到 2.0s 当「定稿章」。格雷码等待线修复「开场即全灭 + 归一不可见」：起跳提前到 1.15s、周期 2.4s→2s、相位旋转到 001 起始、对比度 0.15/0.9→0.12/1、容器与副标题同款 fade-up 入场；ready 退场改两拍——先归一（`merging` 类，0.42s：蓝线合并 + 光标定格实心 + 一次性 `line-flash` 闪光）再淡出（0.45s），归一不再被淡出淹没；`DRAW_TOTAL_MS` 1700→2300、`minDisplayMs` 默认 1700→2300；光标闪烁改 `steps(1, end)` 惯用写法；splash 根加 `role="status"`；prefers-reduced-motion 分支同步（色块直接可见、线稿静态细描边）；测试常量与两拍退场断言同步。
  - 移植 fork 的全仓性能优化（保留插件形态，不涉及桌面版 electron 层）：
    - `getMetadataLight` 接入会话元数据 LRU 缓存（256 条）：对话列表分页（每页 30 条）、用量统计与检查点查询的逐对话读取从「每次 fs 读 + JSON parse」降为纯内存命中；所有写路径统一失效/回填——`saveMetadata` 落盘点收敛为 `persistMetadata`（写后回填缓存），`saveHistory`/`appendHistory`/历史迁移/分支全量重写等刷新 `updatedAt` 的路径失效缓存，删除会话同步失效（含负缓存）；读侧返回深拷贝防调用方污染
    - `usedTokens` 两趟循环（正序找最新总结估算 + 逆序找最后一条助手 usage）合并为单趟逆序扫描：流式期间每个 chunk 都会使该 computed 失效，数组访问量减半；语义等价（新增 6 例回归测试覆盖 usage/总结估算 timestamp 优先级）
    - 占位消息定位 Map 索引化：`isLateTerminalChunkWithoutStreamId` 与 `handleError` 的 O(n) `find` 改为 `getMessageIndexById`（与其它热路径一致）
    - `handleStreamChunkBatch` 诊断日志不再 `slice + filter` 分配临时数组，改为循环计数（终结 batch 每次都会走到）
  - Diff 工具卡顿优化（前端行级差分与渲染热路径，覆盖 apply_diff / write_file / search_in_files 面板与 VirtualDiffLines）：
    - `lineDiff` 新增带缓存的 `computeLineDiffCached`：按内容 + 起始行 + 编辑预算键控、上限 32 条的 FIFO 缓存。流式结果更新 / 组件重渲染期间同一 hunk 直接复用上一次结果对象，不再重复 Myers 计算；同一结果对象引用同时让下游虚拟列表的 props 保持稳定，不再整树重渲染
    - Myers 快速失败：新旧核心区域无公共行且 n+m 超出编辑距离预算时直接输出退化结果（语义与预算耗尽时完全一致），大文件整体重写场景从跑满 768 层迭代降为一次行 ID 集合探测
    - Myers trace 改为按层动态分配（第 d 层仅覆盖 [-d, d] 对角线，offset 随层递增），总内存约为原来的 1/2，长距离 diff 的分配压力显著下降
    - `apply_diff` / `write_file` / `search_in_files` 的行级差分改为增量式：只对新加载/变更的文件或块计算并缓存结果（此前任一文件加载完成都会触发全部文件全量重算）；展示行从「模板内每次渲染 slice」改为「按展开状态缓存的稳定引用」，父组件重渲染不再生成新数组导致 `VirtualDiffLines` 反复整体重渲染
    - `search_in_files` / `write_file` 批量 diff 内容加载改为并行（此前逐个 `await` 串行等待，N 个文件需 N 次往返）；`search_in_files` 匹配列表按文件预分组，模板内不再对全量结果重复 filter
    - `VirtualDiffLines` 滚动事件按 rAF 节流：连续滚动时每帧至多同步一次视口，不再高频触发窗口行计算与重渲染
    - `ToolMessage` 对 `diff.statusChanged` 相同载荷去重：后端重复广播同一 pending diff 状态（定时器刷新 / 多面板路由）时跳过全部响应式更新，不再让所有消息组件无谓重渲染
  - 存档点排除配置的默认类别行布局修正：「N 条规则」计数与「编辑」按钮组合为右侧操作列整体右对齐（计数紧贴按钮左侧），不再因各勾选框标签宽度不同而在行间漂移居中；补上此前缺失的编辑按钮 hover/禁用样式。
  - 子代理工具白名单/黑名单改为按分类分组展示：新增公共工具分类模块 `frontend/src/utils/toolCategory.ts`（工具设置页与子代理设置页共用同一套分类名/图标映射），子代理面板工具列表从「内置工具 / MCP 工具」两个平铺大列表改为按后端 category 分组的分类卡片（文件、搜索、终端、媒体等，MCP 独立成组，缺省分类归入「其他」）；每个工具项显示本地化名称 + 等宽工具 ID + 描述，MCP 分类文案接入三语 i18n；工具设置页同步改用公共分类模块（展示行为不变）。
  - 分支树面板「完整消息」升级为「完整消息图」（高级模式）：由目录树缩进改为轨道式泳道布局——每条消息一行，轨道列数由同时存在的候选分支决定（候选分支走完即释放轨道、后续新候选复用，不再随消息数量无限向右扩展）；分叉以水平连接线表达，活跃路径轨道线高亮；默认折叠连续线性段，新增「展开完整消息」开关可查看全部节点；「分支导航」缩略版保持不变，三语文案同步。
  - 总结 Token 统计改为「主上下文压缩量」口径：新增 `SummaryTokenStats`（被替换历史估算 token、新摘要 token、估算节省量、总结前主上下文 token 与总结后估算值），总结消息落库与前端展示均使用新口径（历史 → 摘要 + 节省量），旧记录明确标注为「总结模型请求输入 → 输出」（`beforeTokenCount` / `afterTokenCount` 标记 deprecated）；会话用量指示器在总结后优先使用新估算值，下一次真实主回复后自动恢复实际用量（timestamp 判断新旧）。
  - 被裁剪历史的逐字用户输入保险档案上限从 160k 字符降至 64k（约 40k → 16k token），省略标记文本计入预算，避免保险副本吃掉默认上下文保留预算、使总结后上下文几乎不下降。
  - 存储路径加固：conversationId / snapshotId / diffId 统一白名单校验（`^[A-Za-z0-9_-]+$`，新增 `assertSafeStorageId` / `assertSafeDiffId`），覆盖 FileSystemStorageAdapter、UsageIndexStore、DiffStorageManager 与 integrityCheck，从根源拒绝 `..`、路径分隔符、盘符与 URI 编码绕过。
  - 根项目与前端锁文件同步（npm audit 均为 0 vulnerabilities，根项目声明 engines.node >=20）。
  - 子代理续跑（`continueFromRunId`）改为「同一条 run 接着跑」：runId 复用旧 run（Monitor 记录唯一、transcript 一条线连续，不再出现第二条不同身份的记录），身份强制沿用旧 run 的 agent（系统提示/工具集不变，本次调用传入的 agentName 被忽略，旧 agent 已被删除时拒绝续跑），provider 前缀缓存命中条件不变（仍以 `lastSentHistory` 为请求前缀、`conversationId` 沿用旧 runId）；续跑经 `run_resumed` 事件标记，前端工具卡 pending 阶段直接沿用 `continueFromRunId` 关联 Monitor。
  - apply_diff 字符串处理性能优化：匹配次数统计从 `split(search)`（大文件 + 短 search 时生成整个分割数组，且无上限）改为 `indexOf` 循环计数（内存 O(1)，新增 100k 上限保护）；起始行定位改用单次扫描的 `getCharOffsetForLine`（消除全量 `split('\n')` 行数组 + `substring` 拷贝）；匹配行号反算改用 `getLineNumberAtIndex`（消除 `substring` + `split`）；`normalizeLineEndings` 与 diffManager 的 `splitLines` 双正则合并为 `\r\n?` 单次扫描。新增 `applyDiffToContent` 真实实现单测覆盖以上行为。
  - 流式平滑输出：新增 `frontend/src/utils/smoothStream.ts`（`SmoothStreamer` 自适应速率蓄水池——chunk 进池后按「每秒放字数 = clamp(积压÷前瞻窗口, 下限, 上限)」匀速放字，积压多自动加速、供应商卡顿时打字渐缓而非冻结）与 `frontend/src/stores/chat/smoothStreamManager.ts`（每条流式消息一个实例，`Map<messageId, SmoothStreamer>`，多标签页/subagent 并发流互不干扰，段落切换 thought↔正文/新 part 时先放完上一段积压再重置）；真实内容（message.parts/content）照旧在 delta 到达时立即累加，另设显示层 `store.smoothTexts`（messageId → 当前正在流出段落的平滑文本），`MessageItem` 流式期间用平滑文本替换最后一个 text/thought 块渲染、终结/中止（complete/cancelled/error/toolIteration/awaitingConfirmation）时先 `flush()` 放完积压再销毁并切回真实 content，不丢尾巴；commit 按 ~32ms 批量合并 markdown 重渲染；rAF 隐藏时 dt 钳 100ms + 速率自适应 + panic 快进三层兜底；TPS 图与 token 统计仍吃真实 chunk 不经显示层；外观设置新增「流式平滑输出」档位（off=直通 / smooth=灵敏 220ms / balanced=标准 320ms / silky=丝滑 450ms），三语文案同步。
  - 平滑流式与 TPS 审查修复：平滑档位经 `state.smoothMode` 传递（`chatStore` watch 设置同步，流式处理不再内联读全局 store）；`SmoothStreamer.push` 按长度预判 panic 先快进再字素分割（超长 chunk 不再先全量分割浪费内存）；commit 回调 set 前比较旧值（减少无效响应式通知）；移除生产未使用的 `end()`/`ended` 分支；非流式消息不再写入平滑层；`lineDiff` 快速失败条件短路重排（预算不足时不再做公共行扫描）、`editDistanceLimit` 上限钳制 4096（防 trace O(limit²)）、`computeLineDiffCached` 返回对象文档化为只读共享契约；`ToolMessage` 去重键改为定长长度前缀编码（与 JSON 语义等价、消除字段分隔符碰撞）；`MarkdownRenderer` 流式 CSS 改 `overflow: visible`（消除无效的 `overflow-y: visible` 计算值）；三个 diff 面板清理缓存时同步修剪展开状态集合；`clearLineDiffCache` 接入 `MessageList` 卸载。TPS 条新增「流活跃」状态机（见 Fixed）、模拟曲线以最近真实速率为基线、稳态均值校准到 ~12 tok/s、主题色每次绘制实时读取、窄面板（≤520px）隐藏 canvas 只留数值、视图隐藏时暂停模拟定时器、tooltip 走三语 i18n。
  - 流式平滑渲染重构（CharFlow 字符流水线，取代「32ms 批量 commit + 180ms 限频 markdown 全量渲染」，解决高 tps 下消息越长越卡的 O(n²) 渲染问题）：
    - 新增 `frontend/src/utils/charFlow.ts`——活动尾块（当前正在流出的 text/thought 段落）由 CharFlow 全权托管：SmoothStreamer 每帧按速率放出字素，批内每个字符以 `animation-delay` 亚帧错峰淡入（CSS 动画按 vsync 采样，「提交频率与观感解耦」——180Hz 屏接近真·逐字流水，高 tps 下为连绵字符流），播完动画的 chip 每帧回收进单个 settled 文本节点（存活 span ≈ cps×fadeMs 有界），flush/panic 直通定型，支持 prefers-reduced-motion；DOM 全部手动操作，高频路径完全不经过 Vue 响应式链
    - `SmoothStreamer` commit 回调改为 `(字素数组, 帧时长, instant)`：删除 commitIntervalMs 批量合并与 pendingCommit（每帧 drain 直接提交），panic 快进/flush 以 instant 直通（跳过淡入）；maxCps/lookahead 语义不变
    - `smoothStreamManager` 新增显示目标注册表：MessageItem 挂载活动尾块 host 时 `registerSmoothDisplay` 注册 CharFlow（组件重建/切标签页回来从累计文本 restore 定型），段落切换（thought↔正文/新 part）先 flush 旧段落再注销显示目标（旧段落由 renderBlocks 接管为稳定块）；`smoothTexts` 快照降级为低频（~120ms 节流 + 内容去重 + 段落切换/终结强制），仅用于组件判定与重建恢复
    - `MessageItem`/renderBlocks：流式期间最后一个 text 段落（partKey 匹配 + 单 part 块）从渲染块摘出交给 CharFlow；活动 thought 段落保留思维卡片外壳，在折叠预览或展开内容内挂载 CharFlow，流式期间不再反复全量解析 Markdown，折叠态自动跟随最新字符；已完成段落恢复 Markdown 渲染
    - 修复 CharFlow 重构后正文重复：活动尾块 host 插入模板后曾拆断原 `v-if/v-else-if` 链，导致 parts 渲染与 `message.content` 兜底同时出现；现将 content 兜底显式限制为“无渲染块且无活动尾块”。摘块行为严格服从 tailInfo，工具调用成为尾部时保留上一段正文；权威 contentSnapshot 会终结旧显示基线。显示目标注册改为同宿主幂等、按宿主安全注销，首个 delta 入队前发布空基线，并补齐 toolsExecuting 与持久化 id 迁移后的终结清理
    - 滚动层无需改动（CustomScrollbar sticky-bottom 已有 rAF 合帧 + 贴底判断）

### Added
  - 新增回归测试：`getMetadataLight` 元数据缓存（写路径回填免读盘 / 深拷贝防污染 / 负缓存 / append 与删除后失效重读，5 例）、`usedTokens` 单趟逆序语义等价（6 例）。
  - 新增回归测试：行级差分快速失败（无公共行且超预算直接退化 / 预算内不退化且输出与预算耗尽一致）、动态 trace 分配下的预算内精确匹配与回退、`computeLineDiffCached` 缓存命中（同值复用同一结果对象）/ 键区分（起始行、编辑预算）/ 内容变化重新计算（lineDiff 套件扩展到 14 例）。
  - 新增回归测试：删除生命周期（deleteLifecycle）、总结 Token 统计（summarizeTokenStats）、存储路径安全（storagePathSafety）、被裁剪用户输入预算（preservedUserInputsBudget）、子代理 run 事件总线（subagentRunEventBus）、前端正则护栏（regexGuard）、轨道式完整消息图布局（branchTreeLayout.buildTrackGraphRows：线性单轨道、候选轨道分配与释放复用、分叉线单元、折叠/展开行为）、工具分类分组（toolCategory：分组/归一化/分类名与图标映射）、总结模型透传（summarizeModelOverride：手动总结当前模型 / 独立模型优先 / 独立渠道无模型时不继承主对话模型）、自动总结当前模型透传（nonStreamAutoSummarizeTurn）、上下文管理关闭时手动总结边界（contextTrimBackgroundReceipt）、summarizeContext 处理器模型透传（summarizeContextModelOverride）。
  - 前端启动「开始动画」：新增 `frontend/src/components/Splash.vue`——灰码少女线稿（取自 resources/icon.svg）按「帽子先落笔 → 身体/发丝 → 标题字距收拢浮现 → 横线脉冲等待 ready」节奏以 stroke-dashoffset 描线动画呈现，最短展示约 1100ms、ready 后约 0.45s 淡出并通知父组件，支持 prefers-reduced-motion；App.vue 原 loading-container 加载界面替换为 Splash（ready 沿用 `languageLoaded`，主界面以 v-show 在下方就位避免 pop-in），并清理原 `.loading-container` 死样式（`.spin` 旋转动画保留，供自动总结/重试等其它组件使用）。
  - TPS 实时可视化条：新增 `frontend/src/components/input/TpsBar.vue` 与前端采样器 `frontend/src/utils/tpsMeter.ts`（模块级单例）——TPS 条位于聊天 Webview 面板最底部一行（InputArea.bottom-toolbar）、总结上下文按钮左侧，flex 布局为「左侧 TPS 标签 + 中间 240×24 canvas 柱状图 + 右侧实时数值」；流式 chunk 到达时 `streamChunkHandlers` 按文本长度粗估 token 数调用 `tpsMeter.record`，采样器 200ms 采样、1s 滑动窗口求瞬时速率、EMA(α≈0.3) 平滑、定长 ring 随采样滚动，柱高按窗口内峰值归一化、颜色跟随 `--vscode-charts-blue` 主题变量；无真实流（开始动画/空闲等待）时 TPS 条自行随机模拟波动（常态低流量 + 偶发突发 + 均值回归），收到真实流数据后自动切换为真实曲线，让启动与空闲阶段的图表保持活性。
  - 新增测试：`SmoothStreamer` 单测（flush 同步输出不丢尾巴 / switchPart 段落切换先放上一段 / panic 快进 / dispose 不输出 / 档位 lookahead 有序）与 `smoothStreamManager` 单测（每消息独立实例 / partKey 切换 flush / 消息间隔离 / 模式变化重建实例）；`lineDiff` 缓存套件扩展（预算 0 与负数退化语义、32 条 FIFO 淘汰、`clearLineDiffCache` 强制重算）；前端全量 403 例通过。
  - 新增修复回归测试：`SmoothStreamer` tick 路径（fake timers + mock rAF：速率累积 / commitIntervalMs 批量 / dt 钳 100ms / panic 快进 / 积压放完尾巴强制提交）与 manager 基线/模式切换（5+ 例）；`tpsMeter`（fake timers：窗口累计 / 1s 修剪 / EMA 递推 / ring 上限 / live 2s 边界 / events 容量上限 / 退订停表 / 停表状态清理，8 例）与 `Splash` 状态机（ready 最短展示 / drawDone 门控 / done 单次 / 定时器清理 / reduced-motion 同步完成 / aria，8 例）；`lineDiff` 边界（`n+m === limit` 不快速失败 / 只读契约守卫 / 预算钳制生效，+3 例）；`MarkdownRenderer` CSS 规则静态断言（流式 `max-height: none` + `overflow: visible` / `keep-expanded` / 规则顺序）。前端全量 439 例通过。
  - CharFlow 重构配套测试：新增 `charFlow` 单测（批内错峰 delay / step 钳制 / collapse 回收 / finish 定型 / idle / restore 替换 / instant 直通 / reduced-motion 探测 / followEnd / dispose 清空，12 例）；`SmoothStreamer` 单测重写为 commit 新签名（flush 直通不丢尾巴 / panic instant 快进 / 高帧率 180Hz 模拟逐帧输出 / dt 钳制 / 积压放完停止调度，11 例）；`smoothStreamManager` 扩展（显示目标幂等注册/安全注销/恢复、首帧快照、快照节流与内容去重、段落切换、migrate 键同步迁移、finish 定型保留内容，14 例）；新增 MessageItem 正文互斥、工具尾部可见性、thought CharFlow 与 contentSnapshot 基线重置回归测试。前端全量 466 例通过。

### Fixed
  - 多工作区修复（子智能体全链路审查 + 合并后回归核查）：
    - 切换已绑定工作区的对话时同步扩展端激活工作区：此前仅恢复 UI 显示、后端 WorkspaceManager 未同步，聊天顶部选择器与文件操作（文件树/打开文件/固定文件/搜索/保存图片）指向不同项目且分歧无法自愈；现在切换对话即 `workspace.setActive` 到对话绑定工作区（失败仅告警）
    - 历史页「当前工作区」筛选纳入未绑定工作区的对话（未绑定 = 跟随当前工作区）：此前升级前的全部存量对话与从未打开工作区时创建的对话被默认筛选隐藏，历史页打开工作区后默认一片空白
    - `setActiveWorkspace` 重绑定对话失败时回滚激活工作区（此前重绑定失败无回滚无提示，前后端激活值分歧）
    - 分支对话创建不再以激活工作区兜底：此前前端未传 workspaceUri 时 handler 会错误绑定到当前活动项目，绕过后端「分支继承源对话工作区」逻辑（ConversationHandlers.createBranchConversation）
  - 默认对话标题自动附加工作区名（格式 `标题 [工作区名]`，无工作区时不加）：多项目同时编辑时对话列表/标签页/历史页可按项目区分；标签页标题同步同一逻辑（新增公共 `buildConversationTitle`）
  - 性能优化（子智能体审查实施，全部有回归测试）：
    - `getMetadataLight` 接入 metaCache（对话列表每页 30 条摘要从 30 次磁盘读 + JSON parse → 0 次磁盘 IO；命中返回深拷贝防污染，`not_found` 负缓存，io/parse 错误不污染；写路径统一失效/回填）
    - `usedTokens` 两趟 O(n) 正序+逆序扫描合并为单趟逆序扫描（流式期间每个 chunk 使该 computed 失效，访问量减半，语义等价由新测试锁定）
    - 预览文本 `.filter().pop()` 全量扫描改逆序首个命中即 break；`isLateTerminalChunkWithoutStreamId` 与 `handleError` 占位定位从 O(n) `.find()` 改 `getMessageIndexById` Map 索引；batch 跳过诊断块消除每终结 batch 的 `slice+filter` 临时数组分配
  - 新增测试：`getMetadataLight` 缓存行为（命中不读盘/深拷贝防污染/负缓存与写路径覆盖，3 例）、`usedTokens` 合并后语义等价（6 例）

## [1.6.2] - 2026-08-05

### Merged
  - 同步上游 PR #9（上游 1.4.1：生命周期/存储/总结/安全加固），保留 fork 的 electron-app / 变更查看面板 / 媒体路径护栏 / 独立版本号增量
    - 上游改进包括：对话删除前停止并排空主流 + 子代理（abortAndWaitForCompletion + subagent exit/flush，有界等待）、编辑「真·原地保存」（keep 模式只改写目标消息文本，不再截断后续消息/软删分支/重新生成，本地 user 消息补近似 parentId 防根节点误判）、`NODE_NOT_FOUND`/`INVALID_BRANCH_RELATION` 消息编辑 id 对齐与根节点编辑自动降级 keep、候选切换器（BranchSwitcherBar）挂载位置修正、存储 ID 统一 `assertSafeStorageId` 校验、分段历史写入串行化与挂起超时、SubAgent transcript 持久化改进、token 统计与 preservedUserInputs 预算、前端分支树面板重构（branchTreeLayout）等
    - 冲突解决记录：webview CSP 采纳上游 nonce 方案并保留 fork 的 `<` 转义（safeJson）；`deleteConversation`/`deleteSingleMessage` 合并 fork assertSafeId 与上游 abort/子代理排空；`editBranch` keep 模式合并上游真·原地保存与 fork 的索引/工具缓存重建；`loadGlobalDiff` 保留 fork 优雅降级（不安全 id 返回 null 而非抛错）；CHANGELOG 保留 fork 版本体系不并入上游 1.4.1 条目
    - 上游新测试适配 fork 语义：`DELETE_CONVERSATION_INVALID_ID` 错误消息统一、`loadGlobalDiff` 期望调整为 null 降级

### Fixed
  - 修复 `TokenCountService` 四路提供商（Gemini/OpenAI 兼容/OpenAI Responses/Anthropic）计数请求无超时、无 abort 信号：单点挂死会拖死每次模型请求前的 `preCountUserMessageTokensBatch`（整个回合无限期挂起且停止按钮无法中断）；为每个计数请求加 15s 超时 + 外部 abort 透传，超时走本地估算降级（详见 `TokenCountService.fetchWithTimeout`）
  - 修复 `execute_command` 同步 shell 检测用 `execSync` 字符串拼接（`where ${shellPath}`）：customPath 来自工作区设置，含 `&`/`|`/`;` 时被 shell 二次解释执行任意命令（工具声明构建时同步触发、无需确认）；改为 `execFileSync` 参数数组；同步版 `timeout` 参数对 NaN/负数归一化
  - 修复 `ConfigManager` 未校验 timeout 配置：NaN/负数/0 直接进 `setTimeout` 导致所有请求瞬时超时/abort；`validateConfig` + `executeRequest`/`executeStreamRequest` 双重钳制（默认 60s，上限 1h）
  - 修复 `StdioMcpClient.disconnect` 对僵尸进程固定等待 10 秒（exit 事件永不触发）：exitCode/signalCode 已置位直接清理，treeKill 报错立即 resolve；MCP 握手 clientInfo 版本由硬编码 1.0.5 统一为 `createGrayCodeMcpClientInfo()`
  - 修复 `DiffStorageManager.migrateTo` 迁移中途失败静默切换 basePath（旧目录剩余 diff 数据静默丢失）：仅 ENOENT（旧目录不存在）才换路径，其他迁移异常保留旧路径并报错
  - 修复 `chatStream.source` 字段在 webview 层被丢弃：后台任务回执（`source: 'background_task'`）被当成真实用户输入（isUserInput/回合语义/历史渲染全部错乱）；`handleChatStream` 解构与透传补齐 `source`
  - 修复 `deleteMessage`/`editBranchStream` 的 `messageId` 在 webview 层被丢弃：后端 MESSAGE_CHANGED 防索引漂移校验形同虚设（并发删除/压缩后可能误删其他消息）；`DeleteToMessageRequestData`/`EditBranchRequestData` 声明 `messageId` 并透传
  - 修复 `chat.awaitConversationIdle` 后端无限等待（前端 20s 超时摘除 requestId 后，迟到响应被误当广播分发）：handler 加 15s deadline（返回 `{ idle: true, stale: true }`）；`extensionMessageRouting` 增加广播白名单，无匹配 requestId 的响应静默丢弃并记录 debug 日志
  - 修复 IPC 启动失败后空占位 assistant 消息永不清理（幽灵「生成中」）：`cleanupFailedSendPlaceholder` 与 handleError 占位清理等效（空占位删除、有内容登记 `_failedStreamMessageId`）
  - 修复会话快照缺失 `_failedStreamMessageId`/`_lastCancelledStreamId`/`_lastApprovalGatedStreamId`：标签页切换后重试回滚失效、取消检测误判、半截幽灵消息残留
  - 修复审批门闸终止的 toolIteration 后 `processQueue` 永不触发：候选区排队消息无限期冻结，终结路径补 `processQueue()` 调度
  - 修复 `backgroundStreamBuffers` 超 2000 上限淘汰可能丢掉终结事件（complete/error/cancelled 等）：标签页永久「生成中」；按流保留终结事件只丢普通数据 chunk
  - 修复 `SubAgentRunController.waitUntilRunnable` 无限等待（暂停中 run 永久占用并发席位）：30 分钟超时自动 exit；`concurrencyLimiter` 排队加 60s 超时；`fileWriteLockManager.acquire` 轮询加 60s 整体上限（超时抛明确错误）
  - 修复 `proxyFetch` TLS 握手窗口 abort 信号丢失（CONNECT 成功与 tls.connect 之间取消被吞、socket 悬挂）：桥接 abort 监听覆盖窗口期
  - 修复 `deliverInterruptMessage` 错误码丢失（后端 INTERRUPT_MESSAGE_RATE_LIMITED 等被吞为通用文案）、`recordInterruptDelivery` TTL 定时器不随 clear 取消、`switchBranchCandidate` 的 `isSwitchingBranch` 在会话切换后不复位（finally 无条件复位）
  - 修复 electron-app 退出不等待 `dispose()`（异步写队列被截断导致设置/对话落盘丢失）：before-quit preventDefault + await dispose + 10s 超时兜底；`loadURL` 无 catch（页面加载失败主进程崩溃）改为错误对话框退出；新增单实例锁（重复启动并发写同一 data/ 目录损坏配置）；主进程安装 unhandledRejection 保护（不再崩溃）；`vscode-shim` 硬编码 `1.99.0` 改为读根 package.json；`JsonFileMemento.update` 非原子写改为 tmp+rename+串行队列；IPC 消息队列每项 60s 超时（渲染层挂起不再冻结整个通道）、toast 5 分钟 TTL；安装版数据目录不可写时回退 `appData/GrayCode` 并告警（详见 `electron-app/CHANGELOG.md` [1.6.2]）
  - 修复公告版本解析：CHANGELOG 正则不支持 `## [1.3.1-1]` 预发布条目且重复版本号重复展示；正则支持可选预发布段、compareVersions 遵循预发布 < 正式版、重复版本去重

## [1.6.1] - 2026-08-05

### Fixed
  - 修复 `ConversationManager` 合并引入 metaCache 后两处漏同步：`updateSummary` 与 `syncMessageCountAfterStructuralChange` 直写 storage 导致 `getMetadata` 读到陈旧 messageCount/preview（对话列表计数漂移），改走 `persistMetadata`（写盘 + 同步缓存）
  - 修复 `ChannelManager` 流式请求结束后在途保活成功回调重建永不清理的空闲超时定时器（挂起引用 + 120s 后 abort 已废弃 controller）：生成器 finally 将 `idleTimeoutHandle.reset` 置为 no-op；非流式路径 `retryInterval` 与流式一致钳制（非法值不再以 NaN 进入 delay）
  - 修复 `TokenCountService` 模板分支残留空 `key=` 查询参数（统一走 `stripKeyQuery`）
  - 修复 `remove_background` mask_path 按读策略审批可被读策略 allow 绕过写策略 deny（mask_path 是写入目标，改按写策略审批）
  - 修复 `BranchSwitcherBar` 模块级共享监听器标记：多条消息各挂实例时任一实例卸载会误移除其他实例正在使用的滚动/缩放监听（移入组件实例作用域）
  - 修复 `toolActions` 插入/删除消息后未重建 `messageIndexById`/`toolResponseIndex`（被取消工具卡片 hasToolResponse 持续 miss）
  - 修复 `StreamAbortManager` 退休旧流 delete 且会话无新流接管时不唤醒 `idleWaiters`（纯停止场景 `chat.awaitConversationIdle` 永久挂起、后台回执被静默丢弃）
  - 修复桌面版主进程 stdout/stderr EPIPE 崩溃：输出被重定向到管道（CI/终端工具/脚本 `2>&1 | ...`）且读取端提前关闭时，Node 把后续 `console.log` 抛出的 EPIPE 当作未捕获异常，Electron 主进程直接弹「A JavaScript error occurred in the main process」崩溃（e2e 大量日志场景复现）；现在主进程入口挂 stdout/stderr 错误守卫，仅吞 EPIPE、其余错误照常抛出（详见 `electron-app/CHANGELOG.md` [1.6.1]）
  - 修复非流式请求遇非 JSON 错误体（代理网关 HTML/纯文本 429/5xx）时丢失真实状态码与上游错误信息：`executeRequest` 先判 status 再读体，错误体按 JSON → 文本降级解析并透出 `HTTP <status>: <message>`（`API_ERROR`），与流式路径对齐
  - 修复 Gemini 模型列表分页无守卫：上游/中转站异常重复返回 `nextPageToken` 时模型列表接口永久拉取；补页数上限（500）+ cursor 去重，与 OpenAI/Claude 分支一致
  - 修复 `ContextTrimService` 并发删除导致 `estimateMessageTokens(undefined)` 崩溃中断整个回合：index 越界消息按 0 token 处理
  - 修复 `StdioClient.disconnect` 10s 兜底定时器在进程先退出时悬挂不清理（MCP 频繁重启累积悬空 handle）
  - 修复流式路径 `buildRequest` 失败未包 `VALIDATION_ERROR`（与非流式路径不一致，前端错误分类漂移为 UNKNOWN_ERROR）
  - 加固 `regexGuard` ReDoS 检测：改用分组栈扫描，识别嵌套分组/lookaround 绕过（`((a+)+)`、`(?=(a+))+`、`(a?)+`），同时保持字符类内括号/量词、`(?:...)` 非捕获组、无外层量词嵌套的正确放行；补 9 例回归测试
  - 修复 `remove_background` mask_path 写入被策略拒绝时静默跳过但结果仍报成功：与 output_path 一致改为显式失败（此前读策略 allow 可绕过写策略 deny 把遮罩写入工作区外，且任务伪装成功）
  - 修复 `execute_command` 单行输出无长度上限：无换行巨块（如 `print('x'*2e9)`）不再无界累积内存与响应体，单行 1MB 上限、超限截断保留尾部并计入 omittedOutputLines
  - 修复 `delete_code` 整文件删除时产出 `{startLine:1,endLine:0}` 非法块（endLine 下限钳到 1）
  - 修复子代理后台执行同步抛错时任务残留 running（Promise 链包裹），并清除一处重复 catch 语法错误
  - 修复 `generate_image` 对 API 返回超大体图片无字节护栏（与输入侧 50MB 上限对齐）
  - 修复前端「无 streamId 的迟到 complete」覆盖新流占位消息并复位 activeStreamId 导致新回答永久丢失（H4 守卫补全到 handleComplete）
  - 修复前端 batch 跳过优化把无 streamId 的陈旧终结事件当作当前流，误跳过当前活跃流真实增量（只认携带 streamId 的终结事件）
  - 修复 `messageActions` 8 处截断路径（删除/重试/编辑/回档/重放失败）未重建 `messageIndexById`/`toolResponseIndex`、未清空 `toolResponseCache`（被取消工具卡持续 miss、缓存读到已删除轮的响应）
  - 修复会话切换/新建/重置未清空消息索引与 `_failedStreamMessageId`（残留旧会话条目）
  - 修复 `handleAutoSummary` 窗口前插入未同步折叠提示（foldedMessageCount 虚高）
  - 修复后台任务回执 `chat.awaitConversationIdle` 无超时导致回执永久滞留、且阻塞整条消息队列：前端调用加 20s 超时（超时放弃本次 flush 下次重试，绝不提前写入回执），消息路由加入非阻塞白名单
  - 修复 `BackendHost.previewToSessionId` 无界增长（500 条 FIFO 上限）
  - 修复桌面版 auto-open diff 路径下 `resolveOriginalContent` 拿到的 previewId 恒为空（previewId/filePath 计算提前）
  - 修复 `vscode.diff` shim 的 `preview` 字段语义反转（`options?.preview === true` 与 VS Code 一致）
  - 修复桌面版 dialog 无窗口时 `win!` 传 null 抛 TypeError（退化为无父窗口对话框）

## [1.6.0] - 2026-08-05

### Merged
  - 同步合入上游 c7d2e16（PR #8：分支 UI/流式竞态/上下文裁剪 fallback 稳定/总结请求去图/编辑保持当前分支/工具安全），保留 fork 的 electron-app / 变更查看面板 / 媒体工具路径护栏等增量：
    - 上下文裁剪 fallback 切点回合内稳定（保留 provider 前缀缓存）：`getHistoryWithGranularFallback` 支持 `stableStartIndex`——自动总结失败后同一真实用户回合的多次工具迭代（含工具确认后的续跑）复用第一次确定的裁剪起点，工具结果增长不再每轮把 `absoluteStartIndex` 向后推（此前每轮 retainedHistory 开头漂移，缓存只能命中 history 之前的固定系统/工具段）；仅当完整性校验失败或估算超过硬上限（maxContextTokens 的 95%）才重新规划；新回合/总结成功后自动清点重新评估，`clearTrimState` 同步清理
    - 上下文总结请求不再携带图片/文件载荷：`cleanMessagesForSummarize` 把用户消息中的 `inlineData` / `fileData` 替换为 `[Image: …]` / `[File: …]` 文本占位符（总结模型无需加载图片字节，省输入 token，也避免不支持多模态的总结渠道报错）
    - 编辑用户消息新增「保持当前分支」模式（`chat.editBranchStream` 请求新增 `mode` 字段，默认 `'branch'` 行为不变）：`mode='keep'` 时后端直接改写活跃路径上的原用户消息并截断其后内容，不创建编辑候选；先 `ensureBranchGraph` 把完整旧历史并入分支图（无图时建线性基线），截断后 `syncGraphAfterHistoryDelete` 软删被移除的子树（旧版本保留可恢复查看）、`updateActiveNodeParts` 同步改写节点内容与候选摘要（BR-01/BR-05 保持）；前端编辑对话框新增「原地保存（保持当前分支）」按钮（三语文案），编辑链路（EditDialog → MessageItem → MessageList → App → editAndRetry → webview）透传 `mode`，分支流错误重放上下文同步携带 `mode`
    - 其余 PR #8 内容（LSP 工具、regexGuard、cancelForNewTurn、流式竞态等）见上游仓库 CHANGELOG

### Fixed
  - 修复桌面版打包产物（安装版/便携版/zip）通用界面版本号恒为 0.0.0：打包只含 `electron-app/dist`，根 `package.json`（运行时版本唯一来源）与 `CHANGELOG.md` 未打入，设置页应用信息 / About 对话框 / 版本更新公告全部落到兜底 `0.0.0`，公告因版本恒等永不弹出新版本更新内容；现在 electron-builder `extraResources` 追加根 `package.json` 与 `CHANGELOG.md`（详见 `electron-app/CHANGELOG.md` [1.6.0]）
  - 修复桌面版便携式（GrayCode-Portable-*.exe）数据目录解析错误：portable 启动器解压到 `%TEMP%` 运行、退出即整目录删除，旧逻辑把数据目录算在临时目录里导致每次启动都是全新应用、更新替换 exe 后数据无法保留；现在识别 `PORTABLE_EXECUTABLE_DIR` 并把数据写入便携 exe 旁 `data/`（详见 `electron-app/CHANGELOG.md` [1.6.0]）

## [1.5.2] - 2026-08-04

### Merged
  - 同步合入上游 1.4.1（大规模代码审查修复：并发/安全/性能/一致性加固），保留 fork 的 electron-app / 变更查看面板 / 媒体工具路径护栏等增量：
    - MCP：StdioClient spawn `error` 立即清理并拒绝 pending 请求（不再挂满超时）+ stdin/stdout/stderr 流 error 监听 + stderr 64KB 上限；HttpClient SSE 按请求 id 匹配与多行 `data:` 合并、超时覆盖 body 读取与 sendNotification、disconnect 中止进行中请求（保留 fork 的 16MB 缓冲区上限）
    - 依赖安装：并发 in-flight 复用 + 独立临时目录 + `maxBuffer` 64MB + 失败清理（fork 保留 `execFile` 参数直传、不经 shell 解析的注入面收敛）
    - 用量统计：接入 `UsageStatsCache` + 对话目录监听（懒初始化、宿主 dispose 时释放），结果缓存保留 fork 的 LRU 上限
    - Diff 预览：`diffContentId` 白名单校验统一收敛到 `isValidDiffContentId`
    - media 工具：generate_image / remove_background 输入输出统一走 `resolveFileToolPathWithInfo` + 工作区外访问审批流（fork 的 `ensureMediaPathsSafe` 工作区护栏保留，配套测试适配）
    - 前端：`sendToExtension` 条件 JSON 往返（纯 JSON 大载荷不再双份序列化）；设置语言补 'ja'；声音去重与 todo 状态集合容量上限
  - 同步合入上游 150a287（分支 reroll/编辑前端主流程接线、删除消息同步分支图、后台回执上下文骤降修复、子代理工具本地化），保留 fork 的 electron-app / 变更查看面板 / 媒体工具路径护栏等增量：
    - 前端 reroll 主流程接线：消息「重试」与「回档并重试」从破坏性删除（deleteMessage + retryStream）切换为 `chat.rerollStream`（旧回答保留进分支图 sidecar，新候选生成后可经 BranchSwitcherBar 的「‹ 2/2 ›」切换回）；reroll 流结束（complete/error/cancelled）后自动刷新分支图；重试确认框三语文案同步为「保留当前回答、生成新版本」语义；`chat.rerollStream` 加入无超时请求白名单
    - 编辑用户消息分支化：消息「编辑」与「回档并编辑」从破坏性 `editAndRetryStream`（覆盖原消息）切换为 `chat.editBranchStream`（后端创建编辑候选并截断主历史，原消息及其子树保留进分支图 sidecar）；本地窗口改写目标消息 + 截断 + 流式占位 + 分支图刷新标记；流启动失败时重载最后一页 + 检查点恢复前后端一致；附件仅更新本地窗口（编辑分支接口无附件字段）
    - 子代理设置页工具白名单/黑名单列表工具名称与悬停描述接入三语 i18n：新增公共模块 `frontend/src/utils/toolLocalization.ts`（工具显示名/描述本地化，缺失时机械转写回退原文），工具设置页与子代理设置页共用同一套条目，MCP 外部工具自动回退英文原名
    - 删除消息同步软删分支图子树：`deleteToMessage`（删除到某条消息）与单条删除在硬删除主历史后同步更新分支图——被删节点及其后续整棵子树（含非活跃候选）标记为已删除（保留可恢复语义、不物理清理 sidecar），活跃尾自动回退到最后保留消息对应节点，指向被删节点的活跃指针一并清空；无分支图（线性对话）或未注册分支服务时保持原有删除行为不变，图同步失败仅告警不阻断硬删除（主历史为唯一真源）
    - 修复：`_pendingBranchRefreshAfterStream` 标记改为按会话隔离（会话切换后其他会话的终结 chunk 不再误消费并误刷分支图，切回原会话后由该会话的终结 chunk 正确消费）；`retryFromMessage` reroll 流启动失败且会话已切换时不再重载原会话历史（避免污染当前会话窗口与检查点）；分支流失败错误条可重试（后端把底层 `ChannelError.type`（API/NETWORK/TIMEOUT/PARSE 等）透传到错误 chunk，`isRetryableError` 按底层 type 判定，`REROLL_FINISH_SYNC_FAILED` 等 reroll 特有错误或 CONFIG/VALIDATION/CANCELLED 不显示重试）；主聊天发起的 diff 预览同样跟随主聊天所在列（`diffViewColumn` + `openDiffView` 后 `moveActiveEditor` 校正）
    - 后台回执上下文骤降修复（约 35k token → 2k token）：新增后端 `chat.awaitConversationIdle`（`StreamAbortManager.waitForIdle()`），回执发送前以运行控制器为生命周期唯一事实来源、等待旧流真正退出（不再依靠延时或前端瞬时 `isStreaming` 状态猜测），等待期间切换会话或启动新流则重新判定；后台回执以 `source: 'background_task'` 从前端请求贯通到后端历史、`isUserInput: false` 保存，合法裁剪起点、回合识别、当前回合定位、思考范围与 token 累加统一复用 `isRealUserMessage()`，`source` 在渠道 formatter 发请求前剥离、历史重载时透传回前端保持后台任务卡片样式

## [1.4.1] - 2026-08-05

### Changed
  - 分支树面板改造成双模式“分支历史”：默认“分支导航”会折叠连续线性消息，只保留根节点、分支点、候选入口、命名/删除节点与当前尾部；“完整消息”显示所有节点，但普通父子消息沿用同一纵向轨道，只有真正的兄弟候选才横向展开，不再随对话长度形成一路向右的阶梯。面板同时增加节点计数、角色标签、精简时间、悬停操作按钮和窄窗口适配，保留候选切换、工作区恢复确认、软删除、恢复与重命名能力，三语文案同步。
  - 子代理完整 transcript 从 conversation `.meta.json` 迁移到 `conversations/<conversationId>/subagents/<runId>.json` 独立原子文件；元数据仅保留状态、计数、修订号和 `transcriptRef`，不再重复内嵌 `contents` 与 `lastSentHistory`（包括图片 Base64）。旧内嵌记录首次加载时自动迁移并清除大字段，Monitor 历史与续跑 provider 前缀保持完整。

### Added
  - 树状分支重 roll 前端主流程接线（此前仅后端完成）：消息「重试」与「回档并重试」从破坏性删除（deleteMessage + retryStream）切换为 `chat.rerollStream`（旧回答保留进分支图 sidecar，新候选生成后可经 BranchSwitcherBar 的「‹ 2/2 ›」切换回）；reroll 流结束（complete/error/cancelled）后自动刷新分支图；重试确认框三语文案同步为「保留当前回答、生成新版本」语义；`chat.rerollStream` 加入无超时请求白名单与 VSCodeRequest 类型联合
  - 编辑用户消息前端主流程接入 `chat.editBranchStream`（此前仅后端完成）：消息「编辑」与「回档并编辑」从破坏性 `editAndRetryStream`（覆盖原消息）切换为分支编辑——后端创建编辑候选（新 user 节点）并截断主历史，原消息及其子树保留进分支图 sidecar（决策 7：旧分支保留，失败可切回）；本地窗口改写目标消息 + 截断 + 流式占位，置位分支图刷新标记（流结束后 BranchSwitcherBar 显示候选切换器）；流启动失败时重载最后一页 + 检查点恢复前后端一致；`chat.editBranchStream` 加入无超时请求白名单与 VSCodeRequest 类型联合；附件仅更新本地窗口（编辑分支接口无附件字段）
  - 子代理设置页工具白名单/黑名单列表工具名称与悬停描述接入三语 i18n：新增公共模块 `frontend/src/utils/toolLocalization.ts`（工具显示名/描述本地化，缺失时机械转换/回退原文），工具设置页与子代理设置页共用同一套 `toolDisplayNames` / `toolDescriptions` 条目，MCP 外部工具自动回退英文原名
  - 删除消息同步软删分支图子树（后端）：`deleteToMessage`（删除到某条消息）与单条删除在硬删除主历史后同步更新分支图——被删消息对应节点及其后续整棵子树（含非活跃候选）标记为已删除（保留可恢复语义、不物理清理 sidecar，过期清理仍走保留期机制），活跃尾自动回退到最后保留消息对应节点，指向被删节点的活跃指针一并清空；无分支图（线性对话）或无分支服务注册时保持原有删除行为不变，图同步失败仅告警不阻断硬删除（主历史为唯一真源）
  - 编辑用户消息新增「保持当前分支」模式（`chat.editBranchStream` 请求新增 `mode` 字段，默认 `'branch'` 行为不变）：`mode='keep'` 为真·原地保存——只改写活跃路径上目标用户消息的文本，**后续消息、检查点与分支全部保留**，不截断、不软删、不创建候选、不重新生成；后端 `ensureBranchGraph` 建图（无图时建线性基线）后 `updateMessage` 改写主历史 + `updateActiveNodeParts` 同步图节点内容，流直接完成（complete 仅通知前端复位状态）；前端编辑对话框新增「原地保存（保持当前分支）」按钮（三语文案），编辑链路（EditDialog → MessageItem → MessageList → App → editAndRetry → webview）透传 `mode`，分支流错误重放上下文同步携带 `mode`；`editAndRetry` / `restoreAndEdit` 本地同样只改目标消息（不截断窗口、不创建占位），发送时本地 user 消息补近似 `parentId`（首条为 null）供根节点判断

### Fixed
  - 修复流停止等待竞态：`waitForIdle()` 现在同时等待当前控制器和已退休旧流的 finally；`cancel()` 不再让既有等待者永久挂起，也不会在旧流仍处于工具结算窗口时假报空闲；`cancelAll()` 在视图/扩展销毁时统一释放全部退休链。
  - 修复删除会话与运行任务/元数据写入竞态：删除前先中止并等待主流退出，退出该会话全部前台与后台子代理，等待 executor 注销及 transcript/索引持久化排空，再删除检查点和会话；会话物理删除同时进入元数据共享写链，进行中的巨大 `.meta.json` 写不能在删除后通过晚到 rename 复活幽灵文件。
  - 修复「原地保存（保持当前分支）」误删整个分支：keep 模式原实现为「改写 + 截断其后内容 + 软删图子树 + 重新生成」，用户点击后目标消息之后的全部消息与分支候选被移除。现改为真·原地保存语义（只改目标消息文本，后续消息 / 检查点 / 分支全部保留，不重新生成），后端去掉 `deleteCheckpointsFromIndex` / `deleteMessagesInRange` / `syncGraphAfterHistoryDelete` 与工具循环（keep 模式流直接完成），前端不截断窗口、不创建占位、不置分支图刷新标记；错误条重放（`replayBranchStreamAfterError`）对 keep 上下文同样不截断、不创建占位；根节点编辑降级 keep 时走同一语义
  - 修复编辑第一条消息（根节点）报 `INVALID_BRANCH_RELATION: cannot edit the root node`：BranchGraph 为单根模型，根节点没有父节点可挂编辑候选（TREE-03 遗留「根节点编辑暂拒」）。现在编辑根节点时前端自动降级为「原地保存」语义（keep 模式——只改写根消息，后续内容保留，与编辑对话框「保持当前分支」按钮一致）：`resolveEditTargetNode` 新增 `mode` 参数、keep 模式放行根节点（图模式与线性模式都支持），`editAndRetry` / `restoreAndEdit` 检测目标消息 `parentId == null` 时自动以 `mode='keep'` 发起 `chat.editBranchStream`（错误条重放上下文同步携带 keep 模式）；`contentToMessage` / `contentToMessageEnhanced` 透传 `content.parentId`（Message 类型新增 `parentId` 字段），前端据此识别根节点
  - 修复编辑用户消息报 `NODE_NOT_FOUND: node not found: <id>`（新对话首条消息即必现）：前端发送用户消息时窗口消息 id 用 `generateId()` 生成，但 `chatStream` 请求只传文本、不传 id，后端落库时由 `ensureNodeId` 另行生成 `randomUUID()`——窗口 id 与主历史/分支图 Content.id 永远不一致，编辑/重试按 id 定位必失败（assistant 消息经流式 `contentToPersistedMessage` 有 id 对齐机制，user 消息没有）。现在 `chatStream` 请求新增 `messageId` 字段（`ChatRequestData.messageId`），前端 `sendMessage` 携带窗口 user 消息 id，后端 `addMessage` 原样落库（省略时仍由后端生成，兼容旧客户端）；工具确认批注同款修复（`annotationMessageId` 经 `toolConfirmation` → `handleToolConfirmation` → `addContent` 透传）。已打开会话中的历史遗留不一致消息，重新加载历史（切走再切回）后窗口 id 与后端对齐
  - 修复候选切换器（BranchSwitcherBar）挂载位置：切换器改为跟随「当前活跃的候选消息」（用户重 roll / 编辑过的消息本身），而非候选组的父节点——此前 `user:1 → ai:2 → ai:3` 重试 3 后切换器显示在 2 上（候选组挂在父节点 2 下），现在显示在 3'（3 的位置）上；新增 `buildCandidateGroupForNode`（按消息节点推导所属候选组，仅活跃成员返回），`BranchSwitcherBar` prop 从 `parentNodeId` 改为 `nodeId`
  - 上下文裁剪 fallback 切点回合内稳定（保留 provider 前缀缓存）：`getHistoryWithGranularFallback` 支持 `stableStartIndex`——自动总结失败后同一真实用户回合的多次工具迭代（含工具确认后的续跑）复用第一次确定的裁剪起点，工具结果增长不再每轮把 `absoluteStartIndex` 向后推（此前每轮 retainedHistory 开头漂移，缓存只能命中 history 之前的固定系统/工具段）；仅当完整性校验失败或估算超过硬上限（maxContextTokens 的 95%）才重新规划；新回合/总结成功后自动清点重新评估，`clearTrimState` 同步清理
  - 上下文总结请求不再携带图片/文件载荷：`cleanMessagesForSummarize` 把用户消息中的 `inlineData` / `fileData` 替换为 `[Image: …]` / `[File: …]` 文本占位符（总结模型无需加载图片字节，省输入 token，也避免不支持多模态的总结渠道报错）
  - reroll/编辑分支流前端修复：
    - `_pendingBranchRefreshAfterStream` 标记改为按会话隔离（记录发起流的会话 ID）：会话切换后其他会话的终结 chunk 不再误消费并误刷分支图；切回原会话后由该会话的终结 chunk（或后台缓冲 flush）正确消费
    - `retryFromMessage` reroll 流启动失败且会话已切换时不再重载原会话历史（避免污染当前会话窗口与检查点，与 editAndRetry 同款身份校验）
    - 内容型 `toolIteration` 因「需用户确认 / 审批门闸 / 工具被取消」终结流时同样消费分支图刷新标记（此前标记残留，可能被后续无关终结事件消费）
    - `restoreAndEdit` 补 R3-#13 同款按 id 重定位（await 恢复期间数组变化不再错改错删），恢复失败错误写入加会话归属校验
    - `restoreAndRetry` / `restoreAndEdit` 的 `chat.rerollStream` / `chat.editBranchStream` 载荷补齐 `promptModeId`（与 messageActions 入口一致）
    - i18n 新增 `hasMessage()` 静默 key 存在性检查；工具本地化（toolLocalization）缺失条目不再触发 `[i18n] Missing translation` console.warn 刷屏
    - reroll/编辑分支流失败时错误条可重试（方案 B）：后端在流式失败时把底层 `ChannelError.type`（`API_ERROR` / `NETWORK_ERROR` / `TIMEOUT_ERROR` / `PARSE_ERROR` 等）透传到错误 chunk（`{ code, type?, message }`），前端 `isRetryableError` 对 `REROLL_ERROR` / `EDIT_BRANCH_ERROR` 改为按底层 type 判定可重试——携带可重试 type 时错误条显示「重试」；无 type（如 `REROLL_FINISH_SYNC_FAILED` 等 reroll 特有错误）或 type 不可重试（`CONFIG_ERROR` / `VALIDATION_ERROR` / `CANCELLED_ERROR`）时不显示；`ErrorInfo` 类型补可选 `type` 字段，`retryAfterError` 入口守卫改用 `isRetryableError` 保持与错误条判定一致
    - 主聊天发起的 diff 预览同样跟随主聊天所在列：`vscode.diff` 的 `viewColumn` 参数在部分布局/版本下不生效（仍在当前活动编辑器组打开，焦点在 Monitor 面板时 diff 会落到 Monitor 列），现在主聊天上下文同样下发 `diffViewColumn`（与 Monitor 路由同语义，主聊天在侧边栏时回退主区域第一列），且 `openDiffView` 打开后用 `vscode.moveActiveEditor` 把 diff tab 校正到目标列（目标列即当前列时移动幂等）
  - 修复后台子 Agent 完成回执插入尚未结束的主模型调用，并导致上下文从约 35 万 token 骤降至约 2 万 token（用户实测）：
    - 根因一是前端收到 `complete` chunk 后会先清除 `isStreaming` / `isWaitingForResponse`，但后端流此时可能尚未执行 `StreamRequestHandler.finally`；后台任务回流仅依据前端状态判断空闲，随即创建同会话新流，触发 `StreamAbortManager.create()` 中止并替换仍在收尾的旧流。现在新增后端 `chat.awaitConversationIdle` 与 `StreamAbortManager.waitForIdle()`，回执发送前以运行控制器为生命周期唯一事实来源，等待旧流真正退出；等待期间若切换会话或启动新流则重新判定，不再依靠延时或前端瞬时状态猜测
    - 根因二是后台回执经普通 `chatStream` 落盘时被标记为真实 user 消息，裁剪器将其识别为新回合；当前一个工具回合本身约 35 万 token 时，回合完整性约束会迫使裁剪器丢弃整个旧回合，只保留约 2 万 token 的回执回合。现在 `source: 'background_task'` 从前端请求贯通到后端历史，回执以 `isUserInput: false` 保存；合法裁剪起点、回合识别、当前回合定位、思考范围与 token 累加统一复用 `isRealUserMessage()`，后台回执视为原任务的异步延续，旧历史中缺少 `isUserInput` 的真实用户消息仍兼容；`source` 在渠道 formatter 发请求前剥离，历史重载时透传回前端以保持后台任务卡片样式
    - 补充后端运行生命周期、回合边界、旧历史兼容和前端来源透传回归测试；根 TypeScript 检查、前端生产构建及目标测试通过
    - `REROLL_ERROR` / `EDIT_BRANCH_ERROR` 错误条重试改为重放原分支流（方案 B 一致性收口）：此前错误条「重试」会回退到 `retryStream` 直接追加生成——流式失败后主历史已有半截候选、请求级失败后旧回答仍留在主历史，追加生成分别造成「半截候选 + 新回答」重复与「旧回答 + 新回答」重复，并让分支图与主历史失配（后续删除/编辑报索引越界）。现在 `retryFromMessage` / `editAndRetry` / `restoreAndRetry` / `restoreAndEdit` 在发起分支流时记录原请求快照（目标节点、编辑文本、配置、模型覆盖与 Prompt 模式），流失败时随错误对象保存；错误条重试按错误码重放 `chat.rerollStream` / `chat.editBranchStream`——流式失败（`REROLL_ERROR` / `EDIT_BRANCH_ERROR`）复用失败候选（省略旧节点 ID，由后端按当前活跃路径选择，前端仅回滚半截展示、绝不调用 `deleteMessage`），请求级失败（`RETRY_ERROR` / `EDIT_RETRY_ERROR`）按原目标节点重建本地窗口后重放；重放上下文随标签页快照保存/恢复（切标签页后仍可重试），成功/取消/关闭错误时清理；普通流错误（`STREAM_ERROR` / `API_ERROR` 等）重试行为不变

## [1.4.1] - 2026-08-04

### Fixed
  - 修复 `agent.sendMessage` 工具名含点号导致 OpenAI 兼容 API 拒绝请求（400 `Invalid 'tools[N].function.name': string does not match pattern '^[a-zA-Z0-9_-]+$'`）：工具更名为 `agent_send_message`（与全局 snake_case 命名一致），并在声明中注册 `agent.sendMessage` 为别名，旧对话历史中的调用仍可经 ToolRegistry 别名解析执行
  - 子代理设置页工具白名单/黑名单列表不再把工具完整描述直接渲染在名字下方（几十个工具的长英文描述把设置页撑得极大），改为仅显示工具名，描述收敛为鼠标悬停的 title 提示
  - 批量代码审查修复：
    - 工具系统：validateToolArgs 对非对象参数加守卫（畸形模型输出不再 TypeError 崩溃整个工具批次）；insert_code 空内容不再产生多余空行；jsonFormatter 字符串值内出现字面 `<<<END_TOOL_CALL>>>` 标记不再提前截断块（状态机感知字符串开关与转义）
    - 对话历史：rejectToolCalls 对无 parts 消息加防御；getCustomMetadata 在 meta.json 损坏时降级返回 undefined 而非抛错；删除会话后迟到的 setTitle/updateSummary 不再重建幽灵 meta.json（loadMetadataForWrite 校验历史存在性）
    - 文件与搜索：generate_image 参数缺失路径不再残留 running 任务；网络错误不再误报为用户取消；remove_background mask 缩放改 fit:'fill' 消除裁切错位；find_files maxResults 语义修正（+1 探测避免 truncated 误报）；search_in_files replace 模式匹配收集加 20000 上限与 truncated 标志、多根工作区 path 解析失败不再静默回退、正则源超 500 字符拒绝（ReDoS 防护）
    - 子代理与文档工具：agent_send_message 消息加 16000 字符与 inbox 50 条上限；子代理排队取消路径收敛到 finalizeRun 终态出口；update_progress latestConclusion 归一化；record_progress_milestone 里程碑 id 撞车自动递增重试；create_progress 区分 ENOENT 与其它读错误；create_design 不再静默覆盖已存在设计文档；toggle_skills 未找到技能改 data.warnings 语义
    - 记忆与设置：truncateLog 长度读取移入锁内（并发 note 不再被误截断）；compress 仅在 treePut 成功时上报 done；wake 缺失摘要提示指向实际缺失块；SkillsManager.refresh 同步清理已删除技能；代理设置不再默认启用；设置文件损坏抛错而非静默归零；savePromptMode 校验 mode.id 非空
    - webview：MessageRouter 流式请求 clientId 映射改为流结束时统一清理（Monitor 发起的流出错不再错投主聊天或永久挂起）；cancelStream 缺 data 不再泄漏映射条目；diff 预览内容缓存加 50 条上限；getExtensionVersion 收敛到公共模块；UsageHandlers dispose 清空统计缓存；删除 FileHandlers 死代码变量
    - 前端：流式终结 chunk 缺 content 时流状态仍无条件复位（不再卡在"等待响应"）；视频/图片缩略图加载加整体超时与 onerror 兜底；声音去重集合与 todo 状态集合加容量上限；待确认工具拦截路径不再静默丢弃附件；后台会话流式缓冲加 2000 chunk 上限
    - 构建与测试：.vscodeignore 补充 .env/.env.*/*.pem/*.key 防密钥入包；jest 全局 testTimeout 20000；移除空 jest.setup 引用；messageRouterNonBlocking 测试改为断言生产常量（不再是无效测试）；tsconfig 移除 tsc 直出遗留死配置；npm scripts 收敛；fast-tavern 恢复被删除的 build 模块（buildPrompt/buildPromptFromSillyTavern，npm build 与 pytest 恢复通过）、vectorSearch 类型收敛为同步并修正 Python 端异常静默、Python 正则/世界书浮点语义对齐 TS（NaN/Inf 守卫、不再 int 截断）、递归上限对齐 Math.trunc+clamp
  - 第二轮高风险并发/性能修复：
    - 流式取消竞态（ToolIterationLoopService + ChatFlowService）：取消时先以 3s 有界窗口等早启动工具落定再结算（真实结果不再丢失为 cancelled 占位）；主工具循环 gen.next() 与 handleToolConfirmation 两个确认循环补 abort-race + 2s 收尾窗口（不再永久挂起）；流式取消分支补 resolveAndPersistPostToolStopState（审批门不再残留误拦截）——配套 5 个时序测试
    - 代理模式取消：executeStreamRequest 代理分支循环结束后显式检测 externalSignal.aborted 抛 CANCELLED_ERROR（与原生 fetch 分支对齐，半截流不再被当完整消息落盘）+ 剩余 buffer 取消后不再冲刷——5 个测试
    - MCP 连接生命周期：connect 代际号机制（旧连接的晚到 exit/error/catch 不再误删新客户端/覆盖状态）；connect 按 serverId 复用 in-flight promise（不再假成功）；StdioClient spawn 'error' 立即 reject（不再挂满 30s 超时）+ 流 error 监听 + stderr 64KB 上限；HttpClient 超时覆盖 body 读取与 sendNotification、disconnect abort 进行中请求、SSE 按请求 id 匹配与多行 data: 合并——21 个测试
    - 依赖安装与配置导出：DependencyManager 同依赖 in-flight 复用 + 每次安装独立临时目录 + exec maxBuffer 64MB + 失败清理 temp；exportConfig 递归脱敏（customHeaders/customBody/tokenCountApiConfig 不再泄漏密钥）
    - 前端依赖矩阵统一：vite ^5→^6.4.3、@vitejs/plugin-vue ^5→^6.0.8、vitest 4 保持，删除 esbuild overrides，npm dedupe 后测试与生产构建统一到 vite 6.4.3 + esbuild 0.25.12（npm ci 可复现）
    - 锁与设置：fileWriteLockManager 锁 key 统一绝对规范路径（相对/绝对/../写法不再绕过互斥）；registerAllTools 改注册真实工厂（refreshTool 不再静默空操作）；SettingsCore.updateSettings 深合并（嵌套部分对象不再抹掉同层配置）；VSCodeSettingsStorage 按快照 diff 只写变更键（不再每次全量重写全部配置）
    - 并发一致性：runEventBus 持久化队列改按 conversationId 串行（同会话并行子代理不再互相覆盖 transcript）；新增 progressWriteLock per-path 写互斥（progress.md 读改写不再丢失并行更新）
    - 性能：TranscriptRepository 结构化变更少一次写后全量回读+深拷贝；ToolExecutionService 每工具批次节点反查 2 次→1 次（200 次迭代省数百次全量读）；PromptManager 固定文件 TTL+mtime 缓存与 1MB/2MB 大小限制、fileTree 节点预算截断（10000）、gitignore `!` 否定语义、glob 正则编译缓存；checkpoint 三处 O(n²)→O(n)（unbackedPaths/RetentionService 后继/getIncrementalChain）+ 读取侧 backupDir 越界校验
    - 测试稳定性：toolBatchCheckpoint 轮询改为等待 after 最终绑定值（消除 fire-and-forget 绑定窗口的既有 flaky）
  - 安全/性能/一致性修复：
    - webview 安全：diffContentId 白名单校验（^[A-Za-z0-9_-]+$，5 处 loadGlobalDiff 调用点封堵 ../ 穿越）；消息路由 clientId 改为按来源 webview 固定（不再信任消息体字段，杜绝跨面板身份伪造）
    - media 工具工作区护栏：5 个图片工具（generate_image/remove_background/crop/resize/rotate）输入输出路径统一走 resolveFileToolPathWithInfo + outside-workspace 审批流，与 file 工具策略对齐（默认 deny 下不再能读写工作区外）
    - 路径校验：integrityCheck 段文件名白名单（恶意索引不再越界读盘）；BranchGraphRepository（新错误码 INVALID_CONVERSATION_ID）与 DiffStorageManager 会话 ID 白名单
    - 请求一致性：ChatFlowService 前置清理（diff 中断 + rejectAllPendingToolCalls）提取为公共方法并接入非流式 handleChat/handleRetry（悬空 functionCall 不再跨回合残留）；drainInboxIntoResults 显式校验 mailbox drain 持有者（并发主循环不再窃取消息）
    - subagents：executor 超时/父取消直接丢弃 partial response 走终态（半截工具调用不再进 transcript）；agentMailbox 线程深度原子递增 + 拒绝时清理（不再只增不删）；subagents 工具名列表按 registry/MCP 计数指纹缓存（声明访问不再 O(N) 全量重算）
    - 大文件护栏：apply_diff/insert_code/delete_code 同步读取前 stat 5MB 上限；remove_background 文件 50MB + 像素 16MP 双层拦截；apply_diff 精确匹配 10 万候选上限 + LCS DP 行数护栏（病态输入不再撑爆内存）
    - 工具护栏：list_files 递归深度 10/条目 5000 + truncated 标志 + 跳过常见大目录；execute_command shell 检测结果缓存（不再每工具创建多次同步 execSync）；find_references context 钳制 0~10；goto_definition 括号计数词法感知（字符串/注释/模板不参与）
    - memory/prompt/settings：recall 淘汰 O(1) 索引指针（不再反复 shift）；updateConfig 配置项边界校验（entryChars 1~319 等）；listEntries 流式扫描 + 可选 limit；buildPromptCacheKey 纳入模板指纹（改模板不再 60s 内返回过期提示词）；SettingsExporter YAML 双引号转义 + 解析端配套反转义（描述含换行/引号/--- 往返不损坏）
    - webview 性能：附件 base64 上限 50MB；searchWorkspaceFiles limit 钳制 200 + glob 元字符剥离 + 子目录并行遍历；上下文预览改异步写；BranchHandlers 图信息单次 DFS（O(n²)→O(n)）；死代码清理（MessageRouter 两方法、jsonFormatter 三导出、StreamProcessorResult 接口）
    - ConversationManager：insertMessage/insertContent 后 repairParentChainAfterInsert（插入点后继 parentId 重链，恢复线性活跃路径不变量）；结构性删除后同步 messageCount（列表计数不再漂移）；toolAdapter 旧 mcp_ 命名收敛到 codec（mcp__，删除死导出）；create_progress 并入 per-path 写互斥
    - 前端：sanitizeHtml 补齐（xlink:href/use href/data:/srcdoc/style 剥离、控制字符混淆防护）；删除 useChat/useMessages/useConversations 三个死 composable（含从不释放的监听器）；sendToExtension 条件 JSON 往返 + 失败回退（纯 JSON 大载荷不再双份序列化）；settingsStore Language 补 'ja' + useI18n 接入 ja 语言包（ja 用户 store 级文案不再回退中文）
    - fast-tavern：无 id 正则回退 id 改确定性 FNV-1a 哈希（TS/Python 输出一致，可复现）；死代码三元收敛；py README 示例命名与代码块修正；根 package.json 新增 benchmark script 与 engines.node（>=20）；BranchGraphRepository 原子写 rename 重试（Windows EPERM 偶发 flaky 根治）
  - 代码组织与文档收尾：ChannelManager.getFilteredTools 与 ToolDeclarationResolver 合并（删约 235 行重复实现，主会话工具列表获得 denylist/excludeToolNames 能力，"主会话与 SubAgent 共用同一入口"兑现）；review 6 个工具路径策略副本收敛到 progress/pathUtils 共享实现；handleEditAndRetry（非流式）补齐前置清理（与其它入口一致）；前端三语语言包删除 useChat/useConversations 孤儿键；sanitizeHtml 补 srcset 候选级协议校验；CHANGELOG 历史条目清除全部内部代号（CP-/BR-/MIG-/TREE-/BCP-/EX-/HIS-/CPF-/MED-/审查/复查/决策/PR # 等 165 处）
  - 修复刚完成的助手消息点击「重试」时报 `NODE_NOT_FOUND`：模型回复落盘后，后端现在把真实的稳定消息节点 ID 随流式终结内容回传；前端在 `toolsExecuting`、`awaitingConfirmation`、`toolIteration`、`complete` 与取消收尾阶段用该 ID 替换本地流式占位 ID，并同步消息索引与当前流引用。`retryFromMessage` 因此不再把形如 `1785860200670_2ojp0foff` 的前端临时 ID 传给分支图，普通回答、工具调用回答及已落盘的取消回答均使用后端节点 ID。
  - 修复工具调用后续接回答重生成时报 `INVALID_BRANCH_RELATION`，并明确 reroll 为“单条助手消息重新生成”：分支服务现在允许被点模型消息的直接父节点是模型节点，新旧回答在该父节点下形成同级候选；主历史与检查点从被点回答自身开始截断，目标之前的模型工具调用和 `functionResponse` 完整保留，因此只重新生成选中的回答，不会退回用户消息重跑整轮工具。
  - 修复 `read_file` 单文件调用被空批量参数误判为冲突：部分 function-calling 客户端会为未提供的可选数组自动补上 `files: []`，此前与有效 `path` 同时出现会报 `Provide either path or files, not both.`；现在空数组在存在 `path` 时按“未提供批量参数”处理，同时仍拒绝无 `path` 的空批次及 `path` + 非空 `files` 的真正混合调用。
  - 修复排队消息「立即发送」仍会掐断前台子 Agent（用户实测）：前台 SubAgent 转后台（detach）此前只挂在 `StreamAbortManager.create()`（新流启动）上，而队列箭头的 `sendQueuedMessageNow` 是先显式 `cancelStream()` 再发送新消息——旧流 abort 发生在 `create` 之前，父取消信号已传播到子 Agent，等新流创建时 detach 已来不及。现在 `cancelStream` 支持 `preserveSubAgents` 标记：前端「立即发送」路径携带该标记，后端 `StreamAbortManager.cancelForNewTurn()` 在 abort 旧流**之前**先把该会话活跃前台 SubAgent 转为后台（与 create 路径同款 detach 语义），普通「停止」按钮仍走原 `cancel` 保持真正终止；新增回归测试（管理器 detach 顺序矩阵、路由标记透传、前端请求顺序）。
  - 修复 `find_files` 等未配置存档的单个只读工具偶发显示“对话已存在”：单工具存档判定现在与批量工具一致，未配置存档时不再提前反查会话节点；`ConversationManager` 同时按会话 ID 合并仍在进行的首次创建，消除显式创建与读路径按需创建的并发竞争，创建完成后的真正重复调用仍保持报错。
  - 改善主模型与 SubAgent 的停止响应：主聊天点击停止后立即清除前端流式、加载和等待状态，后端关闭 diff、拒绝悬空工具与持久化清理仍按原顺序完成；Monitor 的暂停、继续、退出请求改为非阻塞路由；SubAgent 工具执行增加 500ms 有界中止收尾，即使工具完全不响应 `AbortSignal`，run 也会进入 cancelled 并释放控制器、并发席位与文件锁，退出成功后 Monitor 立即隐藏控制按钮。
  - 降低 `apply_diff` 接受修改后的等待与界面冻结：目标文件 stat/read 改为异步 I/O；完整 diff 内容先写入 16 条/32MiB 双上限的内存缓存，工具结果立即获得预览引用，JSON 持久化转后台并改为紧凑格式，当前会话预览优先读内存、扩展重启后仍可从落盘文件读取；写前/写后工作区存档和 diff 确认流程保持不变。
  - 修复前台 SubAgent 返回后主模型输入从约 30 万 token 突然减少约 5 万的真实上下文丢失：上下文管理不再静默按完整用户回合推进持久 `trimState`，统一改为模型总结优先；总结范围按 token 预算选择，并可在多轮历史的超长工具回合内部以完整 `functionCall/functionResponse` 组为边界切分。工具循环同一用户回合持续工作时仍会逐轮检测上限、最多尝试两次自动总结，失败后仅对当前请求执行不持久化的细粒度安全裁剪；旧版 trim 状态首次读取自动失效，升级前被遮蔽的历史可重新参与评估。
  - 上下文总结与裁剪现在独立保留历史真实用户输入：被压缩区间中的用户原话和附件名称按时间顺序注入请求，排除 functionResponse、后台回执与旧总结；首次目标和最近补充在异常大输入触发安全预算时仍优先保留，档案不写回 transcript，避免重复膨胀。functionResponse token 估算同步按实际 API 可见字段计算，diff 与 SubAgent UI 元数据不再虚增裁剪预算；同时修复总结消息被起点归一化误跳过的问题。
  - 总结设置新增两个可调项：①「自动总结最大尝试次数」——单个真实用户回合内最多尝试 1-5 次（默认 2），尝试耗尽后仍超阈值时本次请求改用不持久化的细粒度安全裁剪；②「总结模型输入占比」——自动总结单次请求输入占总结模型上下文窗口的 5%-95%（默认 50%），超出时自动缩小总结范围、保留最近一轮工具交互。同时清理总结设置页已迁移的过时「自动总结」区块文案，三语同步。
  - 修复分支图异步同步未完成时 functionResponse 可在切换重写中丢失：`rewriteHistoryFromBranchGraph` 的一致性检查此前只验证非 functionResponse 消息已入图，FR 内容（决策 8 并入所属节点 parts）未校验——FR 图同步未完成/失败时切换会静默丢 FR 内容并误清检查点。现在新增 `findUnsyncedFunctionResponses` 纯函数（按所属节点做 FR id 子集匹配、防误报），任一 FR 未同步即拒绝切换并返回 `BRANCH_OPERATION_CONFLICT`，主历史保持不变；补 8 个纯函数用例与集成回归（含补同步后重试幂等）。
  - MCP 工具调用全链透传外部 `AbortSignal`：用户取消回合后 MCP 请求立即中止，不再挂到超时。HTTP 客户端外部信号与内部超时 controller 联动（区分中止/超时文案），SSE 读流外部中止时同步取消 reader；Stdio 客户端外部中止清理 pending、超时与进程退出监听并拒绝；`ToolExecutionService` → `McpManager` → 客户端逐层透传。新增 11 个用例，MCP 6 套件 86 测试全绿。
  - LSP 生命周期保护抽成共享模块并接入全部 LSP 工具：`get_symbols` 的打开文档激活语言服务、超时、取消、瞬时失败重试逻辑提取为 `lspLifecycle.ts`（`withTimeoutAndAbort` / `executeLspCommandWithRetry` / `openDocumentWithGuard`），`goto_definition` 与 `find_references` 补齐同等保护——provider 挂起不再无限等待，回合取消立即中止；`get_symbols` 保留原导出常量与行为，新增 21 个测试。
  - 修复 SubAgent `continueFromRunId` 续跑丢失 provider 前缀缓存的真正根因：此前的修复只解决了缓存域（user_id 沿用旧 runId），但续跑请求历史取自 Monitor 展示 transcript——首条 `# SubAgent Invocation` 卡片从未发送给 provider，与旧 run 的任何一次已缓存请求从第 0 条就不共享前缀，缓存必然全 miss。现在事件总线持久化「最后一次实际发送给 provider 的 history」（`lastSentHistory`，发送前已完成 agentInbox 剥离、深拷贝、不污染 Monitor 内容与修订号），续跑严格以它为前缀再追加新用户消息；旧记录缺字段时降级过滤 invocation 卡片。新增前缀不变量测试（续跑首请求 = 旧最后请求 + 新消息、不含 Invocation 卡片、持久化恢复后仍成立）。
  - 优化 apply_diff 的固定延迟：写前工作区存档不再阻塞工具启动——批内全部为 diff 审阅类工具（apply_diff / write_file / insert_code / delete_code）时，before 存档与工具前置阶段（读文件 + hunk 规划 + 预览渲染）并发启动，预览先行显示；写盘前由 DiffManager 强制等待存档完成并获取目标文件写盘锁（审阅期间持有、diff 终结释放，与入口持锁语义一致，冲突按既有 lockConflict 语义收敛为拒绝），混合批保持同步语义。结构化 hunk 首次精确匹配计划（fast path 产物）缓存到 pending diff，块级拒绝与最终内容重算直接按计划重放、不再重复全文件扫描（起始内容不一致时自动回退重扫）；write_file 新建文件预写空文件同样在 checkpoint 就绪后带临时写锁执行。新增并发时序、锁持有/释放与计划重放等价性测试。
  - 修复 `get_symbols` 在大型、尚未打开的 TypeScript 文件上偶发 `1 file(s) failed to get symbols` 或无限等待：查询前主动打开文档激活语言服务，瞬时未就绪时重试一次，provider 挂起与用户取消均有界退出；聚合错误现在携带具体文件和 tsserver 原因，并补齐 DocumentSymbol 层级、重试与超时回归测试。
  - 修复主聊天或 SubAgent Monitor 获得焦点时原生文件 diff 打开到 Monitor 列：所有写工具共用的 diffManager 在打开瞬间定位主聊天列，`vscode.diff` 后再按实际 tab 校正目标组，主聊天位于侧边栏时回退第一编辑器列。
  - 改进批量 `read_file` 工具卡片摘要：不再把后续文件折叠为 `+N`，而是逐行显示真实文件路径、范围与批次状态；SubAgent Monitor 在窄列下允许运行元信息收缩换行，标题与控制区不再横向溢出。
  - 修复分支候选下拉框在消息项 `contain: layout` 定位上下文中横纵坐标重复偏移、窄侧栏右侧溢出的问题：候选浮层改为 Teleport 到 `body`，根据视口宽高选择向上或向下展开并约束左右边界，滚动和窗口缩放时持续重算位置。
  - 修复 `read_file` 成功执行但工具卡片摘要显示 `?`、展开后丢失文件的问题：单文件调用同时携带规范化生成的空 `files: []` 时不再误入批量分支，摘要和内容面板都会回退使用有效 `path`；新增空批量与单文件路径并存的回归测试。
  - 放宽同参数重复失败调用护栏：失败次数改为只统计没有其他真实工具调用介入的连续同签名失败，执行诊断、修改文件或其它成功调用后允许原参数重跑测试；真正连续原样失败仍会被短路，默认系统提示同步允许相关状态变化后的重新验证。
  - 完善分支候选切换数据源与状态同步：新增 `buildCandidateGroupAt` 按父节点推导候选组（取代原先只取「活跃尾兄弟组」的 `buildCandidateGroup`），`BranchSwitcherBar` 接收 `parentNodeId`，多个分支点可各自计算「‹ N/M ›」候选状态；候选列表使用 fixed 定位浮层防止被消息滚动容器裁剪；`DirtyFilesConfirm` 由 `MessageList` 常驻挂载，分支切换遇到未保存文件时确认框不受组件显隐影响。
  - 按消息操作栏重新整理分支交互：候选切换器不再作为消息下方独立一列，改为嵌入 `MessageActions`，与复制 / 重试按钮保持同一行和高度；分支树面板改为论坛评论树式连接线布局，用竖向树干与横向分叉线表达父子关系，活跃路径只高亮导线，只有活跃尾节点显示「当前」，分支点显示未删除候选数量，并补齐中英日三语文案。

### Tests
  - 新增分支历史纯布局测试，覆盖 20 条线性消息不增加横向轨道、兄弟候选独立轨道、导航模式连续消息折叠及特殊节点保留；更新组件测试覆盖双模式切换与既有管理交互。
  - 新增子代理独立 transcript 新格式/旧数据迁移、文件系统原子写与会话级清理、停止前后空闲等待、运行中会话删除生命周期顺序测试。

## [1.4.0] - 2026-08-04

### Changed
  - SubAgent Monitor 运行列表改多行布局（用户反馈）：run tabs 从单行横向滚动改为 `flex-wrap` 自动换行，tab 在行内伸展铺满（`flex: 1 1 170px`），子 agent 数量多时不再横向翻找；限制最大高度约 3 行，run 极多时退化为纵向滚动，不占满整个面板
  - Diff 应用与展示性能重构：`apply_diff`、`write_file`、`search_in_files` 共用带编辑距离预算的 Myers 行级差分，移除 Webview 主线程上的二维 LCS 表和模板内同一 diff 最多 5 次重复计算；每个文件/块改为响应式缓存一次统计与行结果，超长展开内容通过 `VirtualDiffLines` 仅渲染可视窗口，降低大文件和批量替换时的 CPU、内存与 DOM 开销
  - 后端 diff 应用增加快速路径：互不重叠且唯一匹配的结构化 hunks 先规划位置并一次拼接文件，保留依赖前序修改、缩进容错和歧义场景的原逐块语义；unified patch 改为整块单次 `splice`，fallback 先按首行筛选候选再校验完整块，避免逐行修改数组和无条件嵌套扫描
  - 存档排除配置编辑器美化：设置页「自定义排除模式」与「每类别模式编辑」从裸 textarea 改为 chips 风格模式列表编辑器（`PatternListEditor`）——已有模式以标签卡片展示、悬停逐个删除，输入框回车添加、粘贴多行自动拆条去重，添加/删除即时保存；类别编辑面板补充标题栏与「清空（恢复默认）」按钮并补齐样式；自定义模式标签旁新增规则数量徽标；三语文案同步
  - 后台任务回流卡片新增三段式折叠视图（用户反馈）：默认折叠为两行省略，可切换「中展开（约 15 行内滚动查看）」与「完全展开」，三个图标按钮置于卡片头部右侧，当前视图高亮；配合后台回执完整内联修复，长报告不再撑满聊天窗口
  - 存档路径安全加固：删除、合并、manifest 读取路径统一经共享 `isSafeCheckpointDirName` 校验（`/^cp_[a-z0-9_]+$/i`），损坏/恶意元数据中的 `backupDir` 不再能触发 `fs.rm(recursive)` 递归删除存档目录外内容；恢复侧文案与失败摘要统一走 `t()` 并补齐 `modules.checkpoint.restore.*` 三语条目（checkpointNotFound / manifestMissing / cannotBuildChain / backupDirNotFound / moreFailures / excludedNote / excludedNoteChanged）
  - 索引删除补祖先闭包：`deleteCheckpointsFromIndexInternal` 与批量删除对齐，从所有保留节点向前遍历完整基链，编辑+重试导致消息索引回退时不再删掉保留节点的基快照（不再产生永久断链存档）；预览返回 `deleted` 与 `deletedIfUnconfirmed` 两个计数，与默认执行口径严格一致
  - 存档配置保存链路加固：`updateCheckpointConfig` 改为深合并落盘（部分 exclusion/messageCheckpoint 负载不再覆盖已保存的 profilePatterns 等嵌套字段）；`enabledProfiles` 值必须为 boolean（`"false"` 字符串不再被当真）、工具列表必须为字符串数组、`maxCheckpoints` 仅接受有限整数（保留 -1 无上限哨兵）、`enabled` 必须为 boolean；自定义模式拒绝 `*` / `**` / `/**` / `/*` 全忽略模式（新增 blanket 原因）
  - 强制排除大小写折叠扩展到 macOS：`.GIT` / `NODE_MODULES` 目录片段与扩展存储绝对路径自排除在 win32/darwin 大小写不敏感卷上不再可绕过，`normalizeWorkspaceUri` 同步折叠；符号链接不再静默丢弃，记录为 `unsupported_file_type` 排除条目供预览解释
  - 用量索引并发丢失更新根治：`FileUsageIndexStore` 内部实现 per-conversation 写串行队列（appendUsage / appendUsageMessages / write / remove 全部入队，write 内按条目键去重），并行子代理与主会话的读改写不再互相覆盖；usage.json 改 tmp+rename 原子写；统计 listConversations 失败时跳过 prune 保留内存缓存；`fs.watch` recursive 增加递归能力探测，不支持时退化为 mtime 快照比对
  - 历史存储读一致性加固：`loadSegmentedHistory` 读后校验 `Σcount === totalMessages` 且段齐全（双 rename 提交窗口不再静默返回错位历史），读侧重试改为 2~3 次带退避；`getMessagesPaged` 初始页先只读浅扫描，仅存在悬空 functionCall 才走深拷贝路径（首屏收益找回）；钳制改轻量只读 index（不再每条消息 O(段数) 次 stat）；删除会话后 append/mutate 短路（流式中删除不再"无 meta 幽灵复活"）；自愈优先从可读段重建、totalMessages 重算为 Σcount、批量摘要返回 truncated 标志、段缓存增加字节软上限与按会话分桶失效
  - 前端设置页与 checkpoint store 加固：`updateConfigField` 保存失败回滚字段 + 保存串行化；`loadConfig` 失败时禁用表单并展示错误横幅（不再以默认值渲染导致真实配置被覆盖）；`checkpoint.restore`/`deleteBatch`/`previewExclusions` 超时豁免；失败路径重载 checkpoints；进度轮询瞬时错误不停止 + 陈旧检测 + 新操作重启；展开对话列表响应校验对话身份；批量删除失败保留列表 + 防重入；`mergeUnchanged` 仅保存成功才同步 chatStore
  - 恢复错误语义修正：恢复结果（失败/部分失败/未备份警告/成功）改用独立分级提示，不再塞入 `chatStore.error`；错误条「重试」按钮仅在可重试错误码（STREAM_ERROR 等）时显示，恢复失败后点击不再误触发 LLM 重新生成；恢复确认框固化 `conversationId`（预览/确认期间切对话不再恢复错误对话）；`previewExclusions`/`getAllConversationsWithCheckpoints` 加入非阻塞路由；`updateCheckpointConfig` 响应携带归一化配置供前端校正；checkpoint handler 补入参校验与明确错误码
  - 快照构建/查询收敛：`runBounded`/`hashFileStreaming`/`isExcludedAbsolutePath` 三处重复实现收敛到共享模块（`checkpointConcurrency`/`fileHashing`/`checkpointPathUtils`，大小写策略统一）；排除预览 samples 按路径排序；设置页统计改有界并发 + `getMetadataLight`；`getCheckpoints` 区分「无记录」与「读取失败」；移除 `as any` 类型绕过
  - 消息稳定 ID 地基：`Content` 新增 `id`/`parentId`，所有写入路径（append 锁内尾读、mutate 插入、functionResponse 补齐）统一经 `ensureNodeId` 生成稳定 ID + 线性 parentId；旧历史在首载/迁移入口按「缺 id 自判定」于会话写锁内确定性补 ID（uuidv5 风格，幂等：多次迁移 ID 集合一致）并原子全量重写一次（totalMessages 不变、指纹校验）；`formatHistoryForAPI` 白名单确认不下发 id/parentId；前端 parsers 透传 `content.id` 为 `Message.id`（跨加载稳定，不再每次生成）
  - 前端清理：`summarizeContext`/`cancelSummarizeRequest` 从 checkpointActions 迁入 messageActions（re-export 保持导出名兼容）；设置页存档项新增「排除详情」入口接通 `checkpoint.getManifest`（前端缺口闭合，旧存档提示不可用）
  - 子 agent 嵌套能力（用户需求）：子 agent 现在可派生子子 agent（subagents 工具对子 agent 开放）——嵌套深度上限 2（主=0/子=1/子子=2）超限拒绝，深度由框架注入不可伪造；父 run 结束级联清理派生子 run；子 agent system prompt 追加使用说明（一般不需要，仅代码需独立复查或主模型明确指令时使用）；嵌套派发继承父级工具过滤（只读 agent 不能通过嵌套获得写权限）
  - 用户消息插入：主会话工具循环/流式中用户发消息不再排队等整轮结束——`chat.sendInterruptMessage` 投递到主会话 inbox，随最近一次工具调用结果一起注入给模型（10s/条频率限制、4000 字符上限、仅投递不落历史）；`sendMessage` 忙时自动改走插入路径
  - 树状分支接线：新建 `BranchService`（分支图读写删接口 getBranchGraph/getBranchGraphMeta/createRerollCandidate/editCandidate/switchBranchCandidate/deleteBranchCandidate、`validateActivePathMatchesHistory` 活跃路径校验、跨对话导出建模 exportedFrom/exportedRefs、`importLinearHistory` 线性导入）；`BranchHandlers` 注册 5 个分支 API；`ConversationManager` 暴露 `runExclusive` 公共锁包装（锁序文档化）、`createBranchConversation` 记录 sourceNodeId + 图初始化/导出标注、`deleteConversation` 清理 sidecar；`switchBranchCandidate` 明确不重写主历史（边界留给后续分支任务）
  - 迁移与完整性：新建 `BranchMigration`（逐版本迁移注册表 + 链式升级 + 升级前深拷贝失败回滚 + 原子落盘 + 损坏拒绝覆盖）；新建 `backend/tools/maintenance/integrityCheck` 只读完整性检查（历史 Σcount/段齐全/孤儿段、存档 backupDir/manifest/增量链 base+环、分支 validate + 活跃路径与主历史对比，只报告不修复）；复查后分支对比降级为 warning（回收条件注释随分支任务落地更新）
  - 候选切换全链：`ConversationManager.rewriteHistoryFromBranchGraph`（会话写锁内从图活跃路径重建主历史：FR 拆分、幂等、分歧索引、用量重建 + trim 失效）+ `BranchHandlers.switchBranchCandidate` 全链编排（切图 → 主历史重写 → 锁外检查点清理 → rewritten 标记，失败回滚图状态）；复查后补：FR 消息 id 按「节点 id + FR part id 集」复用旧历史 id（防幂等失效与检查点误删）、invalidate 移至 saveHistory 前（metadata 写失败不再分裂图/历史）、切换前锁内历史/图尾部一致性检测（不一致拒绝切换返回 BRANCH_OPERATION_CONFLICT）
  - 树状分支前端：`branchActions.ts`（切换成功后重载历史 → 重建 messageIndexById/toolResponseIndex → 清理错误条/流式残留 → TODO/Build 重置 → 刷新检查点与分支图，失败快照回滚，BRANCH_BUSY 前端双保险）；`BranchSwitcherBar.vue`（‹ 2/3 › 循环切换 + 候选下拉 + 两步确认删除，无分支图自动隐藏）；`BranchTreePanel.vue`（分支树浮层面板：本地 DFS 组装 + 活跃路径高亮 + 软删灰显/恢复 + 行内重命名）；标签页快照保存 branchGraph（修复切标签页残留旧图）
  - 用量含全部分支：方案 A 读取时合并——统计读取时经 `readBranchGraph` 读 branches.json，主历史消息 id 为权威去重键（图活跃路径仅作旧索引无 id 时兜底），非活跃候选 token 以 `source='branch'` 并入各维度 + `inactiveBranchTokens` 细分；复查后补：混合态索引去重修正（historyIdsComplete 判定）、候选节点携带 usageMetadataPartial（中断候选按估算口径）
  - 分支管理：软删除（deletedAt + 保留期默认 30 天可配置 + **级联软删/恢复整棵子树**——修复 prune 静默移除 live 子孙的数据丢失高危）、重命名（renameBranchCandidate 仅改 label）、修剪（pruneDeletedBranches 过期节点+子树物理清理）、purgeBranchCandidate 彻底删除（幂等化）、getDeletedBranchCount 与 prune 孤儿口径统一；设置页新增 `BranchCleanupSettings.vue` 区块（软删数量/一键清理/保留期输入，三语文案）；switch 目标到 root 链上软删节点校验返回 BRANCH_OPERATION_CONFLICT
  - 性能基准：`test/benchmark/`（.benchmark.ts 后缀 + --testMatch 显式运行，普通测试不执行）——2000 文件快照创建 0.3s/恢复 0.7s、1 万条历史 append 0.9s/读取 27ms/用量 12ms、100 候选图操作全亚毫秒（含漂移恢复测量与 102 层深链场景，smoke 上限按实测 10-20× 收紧，harness 输出 GC 可用性并做 JIT 预热）
  - 分支-存档联动：`bindWorkspaceCheckpoint`（节点绑定 workspaceCheckpointId/workspaceState，工具执行存档点 fire-and-forget 接线）；切换双模式（chat-only/chat-and-workspace，编排：安全校验→dirty 闸门→取消流→预览→恢复（失败不切分支）→切换，锁序「恢复先于切图」）；**dirty 文件拦截**（WorkspaceRestoreGuard 统一拦截普通恢复与切换，未保存内容不再被静默丢弃）；判据富化（hasWorkspaceState/wroteToWorkspace）+ 前端双按钮确认（三语）；引用计数清理（checkpointRefCounts 扫描 + deleteCheckpointsByNodeIds 三重闸门 + purge/prune 联动，软删不触发）；不做内容哈希去重（增量链共享 4 测试固化）；一致性矩阵 26 场景盘点；核实旧存档 manifest 兼容与 ignorePatterns 合并口径已覆盖
  - 大文件拆分（落地）：`CheckpointManager` 2413→1687 行，恢复侧文件操作与辅助平移至 `CheckpointRestoreService`（722 行，prepareRestore/legacy 恢复/过滤/哈希收集/排除说明等 12 方法）与 `WorkspaceEditorRefresher`（94 行）；`CheckpointSettings.vue` 3284→2263 行，script 拆为 5 个 composable（useCheckpointConfig/useCheckpointExclusion/useCheckpointCleanup/useCheckpointOperationProgress/useCheckpointManifest）；`SettingsManager` 2347 行拆为门面 + SettingsCore + 14 个主题服务，`settings/types.ts` 2419 行拆为 11 个主题类型文件 + 聚合入口（公共导出零变化，纯重构）

### Added
  - 新增共享行级 diff 算法与虚拟行组件测试，以及结构化/unified diff 应用回归测试，覆盖大文件预算降级、公共边缘裁剪、顺序依赖与 relocated hunk fallback
  - 新增 agent 间消息通信（用户设计）：`agent.sendMessage` 工具 + 内存 mailbox（会话限定 + 已知 runId 防冒充、threadId + hopDepth 5 跳防循环）——收件方在**最近一次工具调用结束后**把 inbox 消息追加到工具结果之后随结果返回（主会话工具循环 5 处调用点与子代理执行器均接入），run 结束自动清理；配套信箱与注入点测试 34 用例；用户消息插入与对话删除接线作为二期方案
  - 新增树状分支底座（初版）：`backend/modules/conversation/branch/`——`BranchGraph.ts` 纯函数模块（insertNode / rerollCandidate / editCandidate / activePath / rebuildActivePath / childrenIndex / validate，含环检测）、`BranchGraphRepository.ts`（branches.json 原子写、损坏抛 BRANCH_STORAGE_CORRUPT、删除对话清理）、`types.ts`（ConversationBranchGraph / ConversationBranchNode / BranchErrorCode；functionResponse 不独立成节点、kind 含 exported、单 parentId 索引 + activeChildId）；配套纯函数与仓储单测 61 用例
  - 审计修复核对与测试补齐：确认 xmlFormatter 防御配置、toolResponseFormatter 部分成功序列化、SubAgentRegistry.isEnabled 修复已在提交 3bfab33 就位；`promptToolParser.test.ts` 补齐 DOCTYPE 实体不展开与超深嵌套拒绝两项安全用例；新增 `toolResponseFormatter.test.ts`（文档 5.6 节 10 项全覆盖）与 `subagentRegistry.test.ts`；各修复批次新增回归测试（损坏 backupDir 删除拒绝、索引回退不断链、manifest LRU、锁排队取消、大小写绕过、深合并保留、用量并发、双 rename 读一致性、删除复活、设置页保存回滚/加载失败等）
  - 本轮新增测试：子 agent 嵌套（15 例：深度限制/父过滤传播/级联清理）、用户消息插入（8 例：忙时投递/频率限制/失败回退）、分支接线（BranchService 23 + BranchHandlers 6 + BranchGraph 扩展 5）、迁移与完整性（BranchMigration 15 + integrityCheck 32）、复审修复（用量重建/队列超时/重读校验/原子化 9、agentInbox 剥离 11、错误码与重试 8、前端 UX 9、嵌套权限逃逸回归 等）

### Fixed
  - 修复 SubAgent Monitor 面板抢走 diff 预览位置（用户反馈）：`vscode.diff` 不带 viewColumn 时在「当前活动编辑器组」打开，焦点在 Monitor（Beside 列）时 diff 会开在 Monitor 旁边而非主聊天侧；现在 Monitor 路由上下文下发 `diffViewColumn`（经 tabGroups 按 viewType 定位主聊天所在列，侧边栏时回退主区域第一列），`openDiffView` 显式传 `viewColumn`——无论焦点在哪，diff 都固定跟随主聊天所在列；`HandlerContext` 新增 `diffViewColumn` 字段，主聊天自己发起的 diff 行为不变
  - 修复前台 SubAgent 转后台（detach）机制的三处残留缺陷：① 循环顶部/工具执行前/启动检查三处取消判定仍裸读父 abortSignal，转后台的 run 在后续迭代或工具调用前仍会被旧流 abort 杀死（绝大多数真实场景失效）——统一改为 `parentAbort()`（detached 后视为无父信号）；② 排队期间 detach 后，acquire 成功时启动检查与超时桥（对已 abort 信号注册的 onParentAbort）仍会杀掉 run——超时桥注册加 `!detachedFromParent` 保护；③ detach 把 acquire 桥的 run 控制信号监听一并移除，排队中已转后台的 run 失去 Monitor 终止响应——acquire 桥拆分父信号/控制信号两部分，detach 只摘父信号；新增回归测试（多轮迭代继续执行、排队-detach 继续执行）
  - 修复用户发消息时前台子 agent 被连带杀掉（用户实测）：此前新流启动（StreamAbortManager.create）会 abort 旧流，而前台 SubAgent 的 abort 信号挂在主会话工具循环上，旧流取消会连带终止还在干活的子代理；现在 `SubAgentRunController` 增加 `attachedToParent` 标记与 `detachFromParent`（转后台）能力——`StreamAbortManager.create` 在 abort 旧流**之前**先把该会话活跃前台 SubAgent 转为后台（executor 同步解绑父 abort 信号的组合监听、排队唤醒桥与超时桥），run 继续执行至完成，结果经 Monitor/事件总线呈现（广播 `run_detached` 事件）；后台 run（attachedToParent=false）不受影响，保留 TaskManager 取消能力；新增回归测试 11 例（runController detach 语义 5、StreamAbortManager 转后台矩阵 4、executor 集成含对照组 2）
  - 修复后台子 agent 完成消息被截断（用户实测）：`buildSubAgentSection` 此前把后台 SubAgent 最终报告按 4000 字符截断，并以 `[Truncated N more characters. Open Monitor to view the full transcript.]` 收尾，而 Monitor 是人类 UI、主模型没有访问路径，研究/审查报告被腰斩（前台不传 background 的回复完整，因 functionResponse 无截断）；现在回执完整内联结果正文，与前台载荷同规格——完整结果本就要经 postMessage 转发给 Monitor（现状无截断），回执再经 chatStream 与普通用户消息同路径发送，无新增载荷上限；新增回归测试锁定超长报告不再截断
  - 修复 manifest 缓存无界与锁队列不可取消：manifest 内存缓存改 LRU（上限 32）且 `getManifest` 读后即弃；工作区锁排队等待响应取消信号（abort 时移出队列）；同 owner 超集重入改为运行时 fail-fast 而非静默排队死锁
  - 修复存量并发与一致性缺陷：RetentionService 清理以删除返回值为准、对多依赖者循环合并；updateSummary 不再多余写入 `updatedAt`（列表排序不再抖动）；`loadCheckpoints` 失败保留旧值；`trimWindowFromTop` 窗口裁剪不再永久丢弃窗口外检查点；恢复确认框取消时清理选中残留；前端 `restoreAndEdit` 失败补重载兜底
  - 修复恢复/预览性能残留：`collectCurrentWorkspaceState` 与 legacy 恢复哈希从顺序读盘改为共享模块有界并发流式哈希；`previewRestore` 经 `runExclusive({ needFileLock: false })` 只取工作区级互斥，不再持有全局文件写锁阻塞全部写工具
  - 修复恢复顺序与进度：恢复改为「先复制（含哈希校验）→ 全部成功后最后删除」，复制失败不再留下「已删未补」中间态；删除阶段逐文件上报进度，进度 total 覆盖删除 + 恢复全量
  - 修复复审轮发现的高危问题：用量索引全量重建改为队列内基于最新盘面执行（并发 main 条目不再被覆盖丢失）；`agentInbox` 在落盘前剥离（不再随历史每轮重放给模型）；错误条重试白名单并入后端真实可重试错误码（API/NETWORK/TIMEOUT/PARSE，排除 CANCELLED/CONFIG/VALIDATION 与 RESTORE_*——引入的重试回归修复）；只读预设嵌套派发权限逃逸修复（嵌套继承父级工具过滤、无写工具 agent 移除 subagents、空工具集拒绝一切）；`retryFromMessage`/`editAndRetry` 删除或编辑 IPC 异常路径不再继续重试（历史不重复、本地与后端一致）；`rejectToolCalls` 读改写原子化；`deleteConversation` 纳入会话写锁（删除复活闭环）；段读取后重读 index 版本比对（双 rename 窗口错位历史被检出）；`enqueueWrite` 挂起超时；统计缓存回填含 subagent 合并条目

## [1.5.1] - 2026-08-04

### Added
  - 代码查看面板自动打开工作区文件树：面板打开即列出工作区根目录（新 IPC `listWorkspaceDirectory`，工作区包含校验 + 默认忽略 `.git`/`node_modules`/`dist` 等重型目录），目录点击懒加载展开、文件点按即查看代码；工具栏新增文件树开关与刷新按钮；相对路径打开改为拼接工作区根 URI（修复 `file://相对路径` 被 `Uri.parse` 解析成 authority 导致工作区文件无法打开的问题）
  - 变更查看面板支持展示并比对上一轮变更：已处理（已接受/已拒绝）条目在关闭面板后保留，重新打开可继续查看与比对历史 diff，不再只有待处理变更；条目按「轮」分组（连续推送视为同一轮，间隔超过 2s 视为新一轮），文件列表显示「第 N 轮」轮次分隔；全部处理完毕后显示提示条（历史条目仍可查看）；新增「清空历史」按钮显式清空记录
  - 新增变更查看 Store 单元测试 7 例（`frontend/src/__tests__/stores/diffViewerStore.test.ts`）：push 建条目/关闭后保留/已处理条目重复推送保持状态/轮次分组/清空历史/批量接受只作用于待处理条目

### Fixed
  - 修复已接受的变更通过工具卡「查看差异」再次打开时状态被重置为待处理、重新出现接受/拒绝与全部接受/全部拒绝按钮：`diffStore.push` 对已存在条目保留原已解决状态（已接受/已拒绝），不再回退成 pending
  - 修复变更查看面板对已处理条目仍渲染（仅禁用）接受/拒绝按钮：改为非待处理条目完全不渲染接受/拒绝按钮，历史变更只读查看与比对（全部接受/全部拒绝同样只在存在待处理条目时出现）
  - 修复 SSE 心跳事件污染解析累积器导致长流被误判失败并反复超时重试：上游/网关在长时间思考期间周期性回传的 `data: keep_alive` / `keep-alive` / `ping` / `heartbeat` 等非 JSON 心跳行，旧实现会混入 `currentData` 并按「不完整 JSON」继续累积，之后所有真实事件全部解析失败，流结束时被误报「模型返回空内容」、触发无谓的 NETWORK_ERROR 重试；现在只有「看起来像 JSON 前缀」（`{`/`[` 开头）的内容才允许跨行累积，心跳行直接替换/丢弃，纯心跳流在结束时不再进入错误详情（unparsed），网关真实纯文本错误仍照常带出；新增 5 例回归测试
  - 修复代理链路由 CONNECT 阶段 `http.request({ timeout })` 武装的 socket 空闲定时器残留：握手成功后旧定时器仍存活，长流式请求在「上游思考、无数据可发」的静默期超过固定 `timeout` 毫秒时触发 `proxyReq 'timeout'` → `destroy()` 把已转交的隧道 socket 销毁，正在进行的流被固定超时强行掐断（外部 keep-alive 心跳也救不回来）；现在 CONNECT 成功后立即 `socket.setTimeout(0)` 解除残留定时器，流的空闲超时统一交给 `ChannelManager.executeStreamRequest` 的可重置计时器（任意到达字节都会续期）
  - 修复 LLM 模块缓存保活请求未正确判定成功：`sendKeepAliveRequest` 旧实现不检查 `response.ok`，非 2xx（429/5xx/错误体）也被当作「保活成功」，Anthropic Prompt Caching 的 5 分钟 TTL 实际已过期却静默继续、下一轮对话全价计费；现在非 2xx 明确抛错、瞬时失败自动重试一次（500ms 间隔），返回布尔值供调用方判断「上游确实接受本次刷新」
  - 修复 LLM 模块保活调度与流空闲超时脱节：保活定时器从固定 4 分 30 秒的 `setInterval` 改为链式 `setTimeout`（首个保活提前到「流空闲超时前 10 秒」，下限 30s、上限 4 分钟），保活请求成功即通过 `idleTimeoutHandle.reset()` 刷新流的空闲超时——上游静默思考且不回传心跳时，流不再被固定超时掐断，而是靠 LLM 模块自己的保活续命；另加在途互斥（上一次保活未完成不叠加触发）与流结束即停调度（catch/finally 置 `streamFinished`，杜绝残留定时器）
  - 修复重试成功事件在重试请求真正完成前就触发（重试页面过早消失）：`executeStreamRequest` 是异步生成器，`await` 它只拿到生成器对象、请求尚未发出，旧代码在生成器创建后立即广播 `retrySuccess`——重试页面在重试请求真正完成前就消失，且重试再次失败时会闪现错误面板；现在 `retrySuccess` 移到本次尝试的 `for-await` 正常结束后才广播（新增回归测试锁定：网络错误→重试→成功的事件序列）
  - 修复 `GenerateRequest.retryStatusCallback`（请求级重试回调）从未被读取：`ChannelManager` 只使用全局 `retryStatusCallback`，导致 SubAgent executor 传入的重试状态路由（`retryFailedInThisCall` → `wait_for_monitor_action` 恢复路径）与 Monitor 内部重试展示全部失效；现在优先使用请求级回调，`suppressRetryNotification` 只抑制全局回调、不抑制显式传入的请求级回调（新增回归测试覆盖 4 种场景：重试重发请求、请求级回调路由、全部失败 retryFailed、skipRetry 不重试）
  - 修复超时重试面板近乎透明、可读性差：`.retry-panel` / `.retry-header` / `.retry-error-json` 原本使用 rgba 低透明度背景叠加在聊天区上，错误信息与重试进度几乎不可读；全部改为不透明主题色背景（`editorWidget-background` / `editorGroupHeader-tabsBackground` / `textCodeBlock-background`，浅色主题同样有值），并加深面板阴影

### Added
  - 新增 ChannelManager 重试链路回归测试 4 例（`backend/__tests__/channel/channelManagerRetry.test.ts`，mock fetch 首答失败后成功）：验证重试真的重新发送 HTTP 请求（fetch 调用次数 = 尝试次数）、`retrying → retrySuccess` 事件序列、请求级回调在 `suppressRetryNotification` 下仍收到事件、全部重试失败抛错且不重复回调
  - 新增重试面板生命周期前端测试 5 例（`frontend/src/stores/chat/__tests__/retryStatus.test.ts`）：retrying 显示面板、retrySuccess/retryFailed 消失面板、失败后可再次重试、非当前对话的重试状态写入标签页快照不污染当前面板

### Changed
  - 前端 i18n 新增 `components.diff.roundLabel/allProcessed/clearHistory` 与 `components.codeView.workspaceFiles/noWorkspace/refreshTree/treeEmpty` 三语翻译键；`components.diff.empty` 文案改为「暂无变更记录」；`components.codeView.empty` 文案提示从工作区文件树选择

## [1.5.0] - 2026-08-04

### Added
  - 新增代码查看面板（内嵌右侧抽屉，与变更查看面板同布局体系）：工作区路径打开（复用 `readFileForContext` 的扩展端工作区校验）与内存内容查看（diff 新内容 / 工具结果片段），行号 + highlight.js 语法高亮 + 错误行标记 + 诊断列表点击跳转 + 最近打开列表 + 跳转行号输入；入口：聊天区右下角 dock 按钮、read_file 工具卡「代码面板查看」、变更面板「查看新内容」
  - 新增纯前端基础语法检查引擎 `frontend/src/utils/syntaxCheck.ts`（零依赖、单次线性扫描）：JSON 真实解析报错（带行列定位）、C 系（JS/TS/JSX/Java/C/C++/C#/Go/Rust 等）括号/字符串/模板/注释平衡、Python、CSS 块注释、HTML/XML/Vue 标签匹配、Shell 引号；512KB / 2 万行护栏防大文件卡顿；配套 Vitest 17 例（含标签名截断回归）
  - 变更查看面板（Diff Viewer）接入语法检查：文件列表显示新内容语法错误数徽标，详情区展示诊断列表（L行:列 + 消息），仅对支持检查的代码语言展示「未发现语法问题」，非代码文件不误导；「查看新内容」按钮一键在代码查看面板打开修改后内容
  - Electron 桌面版 codicon 图标字体改为主进程运行时注入（insertCSS + 相对字体 URL 重写为绝对 `graycode://local/...`），不再依赖 patch-dist 静态补丁，前端 rebuild 后图标/徽标不再丢失；注入按 key 幂等（reload 先移除旧样式，修复规则翻倍累积）

### Security
  - 修复 `graycode://` 自定义协议可读取含 API Key 的用户数据目录（H-1）：服务根收窄为 `frontend/dist` / `resources` / `renderer` 静态资源白名单，用户数据目录（默认位于 REPO_ROOT 内）显式排除；hostname 强制为 `local`（`graycode://evil/` 一律 403）；500 错误返回固定文案，不再回显内部路径
  - 修复 openPath/showInFolder 可执行扩展名黑名单不完整（H-2）：补充 `.hta` / `.lnk` / `.url` / `.reg` / `.iso` / `.vhd` / `.vhdx` / `.docm` / `.xlsm` / `.pptm` / `.svg`，阻断「AI 写入恶意文件 → 用户打开 → 任意代码执行」链路
  - 修复 API Key 拼进 URL query（泄漏到访问日志/代理日志/浏览器历史）：Gemini token 计数（模板、`generateContent` 端点替换、裸路径三分支）与 generate_image 全部改走 `x-goog-api-key` 请求头，模板残留与 `key`/`api_key` query 统一剥离
  - 修复 MCP StdioClient stdin 写入无 error 监听：进程退出与 `write()` 竞态窗口内 EPIPE/ERR_STREAM_DESTROYED 不再抛未捕获异常导致扩展宿主崩溃；spawn 失败（ENOENT）等不触发 exit 的路径立即拒绝挂起请求；Windows 移除 cmd.exe shell 包装（消除 `&`/`|`/引号参数的二次解释，命令注入面）
  - 修复 MCP stderr 无界累积（与 stdout 对齐 1MB 护栏 + 截断标记）
  - 修复 `SkillsHandlers.openDirectory` 可在任意位置创建目录并打开任意文件夹：只允许打开 skillsManager 管理的目录（绝对路径 containment 校验）
  - 修复代理链路 header CRLF 注入面（纵深防御）：请求头值统一剥离 CR/LF
  - 修复通知处理器把完整 payload（对话标题/正文）写入默认可见的 WARN 日志：只记录元数据，debug 级同样脱敏
  - 修复 i18n 占位符可访问原型链属性（`{toString}` 类占位符）：改 `hasOwnProperty` 校验
  - 修复 glob 连续 `**` 展开成多个可选 `.*` 组（长路径指数级回溯）：编译前折叠为单个 globstar
  - Electron `fs:exists` native op 增加字符串类型校验（非字符串路径不再抛 TypeError）

### Fixed
  - 修复流式请求校验在 try 块外：非法 conversationId 时前端请求永久挂起 + `requestClients` 路由表泄漏（chatStream / retryStream / editAndRetryStream / toolConfirmation 四处），统一改为校验失败即回错误响应并清理路由表
  - 修复 `cancelStream` 载荷解构无防御：data 缺失时 route() 抛错导致路由表条目永久泄漏，改为防御性取值 + 错误回执
  - 修复 `WebviewClientRegistry.resolveClientId` 返回未注册 id：requested 未命中时回退到已注册客户端，避免 `requestClients` 记录无效条目、响应错投
  - 修复 App.vue 监听 `diff.statusChanged` 消息类型写错（`'message'` vs `'command'`）：变更面板条目状态同步与删除警戒提示恢复生效
  - 修复扩展端未实现 `subagents.monitor.setVisible`（与 Electron 版行为对齐）：Monitor 折叠时后端停止推送 llm_delta 高频增量
  - 修复 `summarizeContext` 完成后重载无会话归属校验：切换会话竞态不再把新会话历史整体覆盖进 allMessages；前端将该消息加入无兜底超时列表，与后端分钟级长任务语义一致（180s 兜底超时误触发会把迟到响应误当广播推送）
  - 修复 `restoreAndEdit` 错误路径无会话校验：跨会话不再污染新会话的错误/流式状态
  - 修复发送失败错误展示依赖 `isStreaming` 判断：await 期间用户取消导致的竞态下，真实发送失败不再被静默吞掉
  - 修复 `apply_diff` 重叠匹配 O(n²) 主线程 DoS（高频短 oldContent 卡死数分钟）：匹配数上限 2 万；同步读文件加 20MB 大小护栏
  - 修复 `processQueue` 发送失败时排队消息永久丢失：失败消息放回队首（去重防死循环）
  - 修复附件无大小上限（全量 base64 入内存可拖垮 webview）：50MB 上限（视频 200MB）；批量上传 try/finally 复位上传状态
  - 修复 UsageStats 统计缓存客户端可控 key 无上限：LRU 上限 20 条
  - 修复 HttpClient SSE 服务器结构化错误被当作解析错误吞掉：真实错误不再被替换成误导性的「超时」
  - 修复 `cleanJsonSchema` 无深度护栏：外部 MCP 服务器构造的极深嵌套 schema 不再栈溢出（深度上限 64）
  - 修复 DependencyManager `exec` 字符串拼接（POSIX 路径注入面）：改 `execFile` 参数数组直传
  - 修复 execute_command 每数据块重建 GBK 解码器（表加载开销大）：预览解码器提升为复用实例
  - 修复 HistoryPage 递归预加载风暴（数千条历史串行拉几十页）：单次挂载最多自动补齐 3 页，其余交给滚动触发
  - 修复 i18n `translate` 正则参数键未转义（元字符键替换异常）；App 级声音去重集合无界增长（上限 1000 条）
  - Electron：`workspace.fs.delete` 支持 `useTrash`（进回收站，与 VS Code 语义一致，不再永久删除）；applyEdit 对已删除文件不再静默重建残缺文件（ENOENT 明确报错）；documentCache 加 100 条 LRU 上限；overlay toast 超时自动移除前回执 `undefined`（后端 Promise 不再永久挂起）；后端初始化失败弹原生错误框（可打开数据目录/退出），不再白屏 + unhandled rejection；`will-navigate` 严格限定 `graycode://local/`

### Changed
  - `frontend/src/utils/vscode.ts` 的 UNBOUNDED_REQUEST_TYPES 增加 `summarizeContext`（与后端 NON_BLOCKING 语义对齐）
  - 前端 i18n 新增 `components.codeView.*` 与 `components.diff.*`（viewNewContent/syntaxIssues/noSyntaxIssues）三语翻译键

## [1.4.1] - 2026-08-04

### Security
  - 修复设置导出明文泄露 API Key：导出 JSON 前统一脱敏渠道 `apiKey` 与 MCP 服务器 `headers`/`env`（占位符 `***REDACTED***`）
  - 修复 Markdown 图片 `src` 未转义 XSS：`MarkdownRenderer` image 渲染器输出前对 src 转义；`sanitizeHtml` 改为 scheme 白名单（href 仅 http/https/mailto/tel，src 仅 http/https/data:image），剥离 scheme 内控制字符并处理 `xlink:href`/`srcset`/`formaction`，阻断 `java\tscript:` 类绕过
  - 修复 SubAgent Monitor 面板内联脚本注入：`__GRAYCODE_INITIAL_RUN_ID` 等 JSON 注入前转义 `<`（`</script>` 闭合绕过）
  - 修复 conversationId 路径穿越：`ConversationManager` 存储层 `getConversationDir`/`getMetadataPath`/`getSnapshotPath` 与 `UsageIndexStore` 全部入口统一 `assertSafeId` 校验；webview 边界 `ChatHandlers`/`StreamRequestHandler`/`FileHandlers.summarizeContext`/`SubAgentMonitorPanel` 同步加校验
  - 修复设置导入自动执行任意命令：导入的 MCP 服务器强制 `autoConnect: false`，并校验 SSE/HTTP 传输 URL 仅允许 http/https
  - 修复代理链路 TLS 证书校验全关：默认 `rejectUnauthorized: true`，仅显式设置 `GRAYCODE_ALLOW_INSECURE_TLS=1` 才放行自签名证书
  - 修复 Gemini 模型列表 API Key 出现在 URL query：密钥统一走 `x-goog-api-key` 头传输
  - 修复 MCP 客户端响应缓冲无上限（内存 DoS）：`StdioClient`/`HttpClient` 缓冲上限 16MB，超限断开
  - 修复深合并原型污染：`SettingsManager`/`configs/base.ts` 深合并跳过 `__proto__`/`constructor`/`prototype` 键；`toggleSkills` 拒绝危险技能名
  - 修复自定义 Header CRLF 注入/保留头覆盖：header 键校验 `/^[a-zA-Z0-9-]+$/` 并禁止覆盖 Host/Content-Length/Transfer-Encoding 等保留头
  - 修复 ReDoS 防护可绕过：`isRegexPotentiallyCatastrophic` 新增重叠分支交替检测（`(a|aa)+` 类）与贪婪无锚前缀检测，正则长度阈值收紧到 200
  - 修复 realPath 缓存陈旧导致符号链接逃逸：缓存按最近存在祖先 mtime 失效，新建符号链接后 containment 判定立即重新解析
  - Electron 桌面版安全基线：开启 `contextIsolation` + `sandbox`，preload 改用 `contextBridge` 白名单暴露；`graycode:native`/`renderer-to-backend` IPC 校验发送方为主窗口主框架；`shell:openExternal` 仅允许 http/https/mailto，`shell:openPath`/`showInFolder` 拒绝可执行扩展名；自定义协议不再 `bypassCSP`，生产 index.html 注入严格 CSP；外链恢复为系统浏览器打开

### Fixed
  - 修复 UI 对比度异常（桌面版 light 主题从未生效）：`ui.theme` 设置此前无任何代码消费，`theme.css` 的 light 变量块是死代码且大量变量缺失；现在 App.vue 按 `ui.theme`（light/dark/auto）维护 body 主题 class 并监听系统主题变化，light 块补全 60+ 变量（checkbox/hoverWidget/icon/ansi/placeholder/hint 等）
  - 修复 Mermaid 图表浅色主题下白字白底：移除强制 `#ffffff`，改随 `--vscode-foreground`，按主题配黑白描边；`isDark` 检测补充桌面版主题 class
  - 修复浅色主题下多组件硬编码色对比度不足：音频占位图渐变、TODO 状态徽章、危险按钮、行号徽章、Diff 面板、工具卡按钮边框、token 环形进度、overlay.js toast 等 12 处改为 `--vscode-*` 变量
  - 修复语法高亮退化为单色：highlight.js 改走 `lib/core` + 常用语言子集（主 bundle 减约 900KB），并补充跟随主题的 `.hljs-*` 配色
  - 修复 ToolMessage 自动确认计时器泄漏：全部组件卸载后停止倒计时，用户不可见时不再静默自动接受 diff
  - 修复 diff 审阅破坏用户未保存编辑：创建/展示 diff 前检查目标文档 `isDirty` 并中止；磁盘内容被外部修改时不再强制覆盖，返回明确错误
  - 修复 read_file 批量读取无上限：上限 20 个文件 / 50MB 总预算
  - 修复 list_files 可枚举工作区外目录：纳入与 read_file 一致的 deny/ask/allow 策略，默认忽略 node_modules 等大目录
  - 修复 execute_command 绕过 Shell 启用限制：shell 类型必须存在于配置且启用
  - 修复流式路径重试次数未钳制：`retryCount` 钳制 [0,20]（与非流式一致）
  - 清理测试残留：移除 `electron-app/data/` 中 3 个 smoke test 对话与 `release/win-unpacked/data/` 全部运行时数据，`dist:*` 打包脚本先清理 `release/` 防止测试数据随发布包分发
  - 移除 limcode 品牌残留：设置导出默认文件名改为 `graycode-settings.json`、依赖默认安装目录改 `~/.graycode`（旧 `~/.limcode` 已装依赖时兼容沿用）、Anthropic user_id 前缀加兼容性说明

### Changed
  - `electron-app/package.json` 锁定 `electron ^43.2.0`（原 `latest` 不可复现）
  - Vite dev server CORS 从 `*` 收窄为 localhost/vscode-webview 来源
  - `.vscodeignore` 排除 `AUDIT_REMEDIATION.md`/`.github/`；`.gitignore` 补充密钥类文件模式
  - MCP 工具名编码统一走 `encodeMcpToolName` codec（消除手拼与旧单下划线双规范）

## [1.4.0] - 2026-08-04

### Fixed
  - 修复存在最近对话栏时无法发送消息：渠道只配置 `models` 列表而未选择 `model`（`model` 为空）时，前端发送按钮因 `currentModel` 为空被禁用；`ConfigManager` 创建/更新/读取三路径统一回退 `models[0]`（读取路径只作用于副本、更新路径自我修复历史坏数据），前端 `loadCurrentConfig` 与输入区同步兜底，新增 6 个后端回归用例
  - 桌面版便携式多实例：所有数据默认写入应用目录下 `data/`（不写 AppData/Program Files），复制应用目录即得互不影响实例，`--user-data-dir` 可显式覆盖（详见 `electron-app/CHANGELOG.md`）

### Added
  - 桌面版变更查看面板（内嵌 GitHub 风格）：全屏 Diff 模态框改为主窗口右侧内嵌抽屉（非独立窗口），`vscode.diff` 拦截 → `host.openDiffPreview` 命令驱动打开，左侧文件列表（状态 + ±统计）与右侧统一 diff（hunk 头/双行号/增删着色），单文件与全部接受/拒绝、删除警戒提示、`diff.statusChanged` 状态同步；accept/reject 复用同一协议（详见 `electron-app/CHANGELOG.md`）
  - 行级 diff 计算抽取为共享工具 `frontend/src/utils/diffLines.ts`（LCS 匹配 + hunk 分组 + 统计，超大文件 DP 保护），write_file 工具卡删除重复实现并复用，新增 12 个 Vitest 用例
  - 对话重 roll 树状分叉（DeepSeek 风格）：重新生成 AI 回答不再破坏性覆盖——截断前把当前回答及后续尾部保存为版本（每会话上限 10 个，全等去重，随删除对话清理）；AI 消息上出现 v1/v2/v3 版本切换器（chips + 前后箭头），随时切回旧版本，切换前自动保存当前尾部（不丢数据），切换后继续聊天基于所选分支；版本保存失败静默降级不阻塞重roll；`conversation.saveTailVersion` / `conversation.getTailVersions` / `conversation.restoreTailVersion` 三个 IPC + 6 个后端回归用例
  - 历史记录读取性能优化：ConversationManager 新增历史 LRU（24 会话）与元数据 LRU（256）缓存，写路径统一失效/回填；`getMessagesPaged` 缓存命中直接从内存快照切片（免分段存储磁盘解析），移除逐条 JSON 深拷贝；`getMetadata` 缓存命中跳过磁盘完整性检查（两次 fs → O(1)）；分段历史并行读取（Promise.all 保持段序，单段失败不中断）；`history_search` 新增 `getHistoryRef` 免深拷贝供只读调用方

### Fixed
  - 修复 unifiedDiff hunk 边界误判：hunk 末尾的 `--- x` / `+++ y` 内容对 + 下一行 `@@` 被当作下一个文件头而中断，导致内容丢失；新增 `isFileHeaderPair()` 按「路径形」消歧（`-- old item` 这类内容行不再中断 hunk），`apply_diff` 的 loose 解析同步修复避免同样丢行
  - 修复 `insert_code` 幻影尾行：文件以 `\n` 结尾时 `split('\n')` 产生的尾部空串让末尾追加产生多余空行；新增 `hasPhantomTailLine()` 判定并导出 `insertAtLine`（插入索引钳制到幻影行之前）

### Changed
  - 工具调用格式选项移除「（推荐）」标记：JSON 边界标记不再标注为推荐项（原生 Function Calling 已是主流选择），渠道设置下拉与提示文案的中/英/日三语同步调整




## [1.3.2] - 2026-08-04

### Changed
  - 存档点创建/恢复主流程切换到新架构：创建改用 `CheckpointSnapshotBuilder`（多根工作区扫描、强制排除存档目录自身、流式哈希 + 有界并发、stat 复用），恢复改用 `CheckpointRestoreEngine`（增量链文件索引 O(1) 查询、scoped 路径安全解析、失败清单区分 missing_in_chain / hash_mismatch / copy_failed / delete_failed）；新存档记录工作区身份（`workspaceRoots` / `workspaceFingerprint`），恢复前校验当前工作区，跨项目恢复被明确拒绝；新存档备份目录改用 scoped 布局（`cp_xxx/ws_xxx/relative`），多根工作区同名文件不再互相覆盖；旧格式存档（相对路径键 + 旧布局）单根恢复保持兼容，多根下明确拒绝而非静默错恢复；存档创建/恢复进入工作区级互斥锁（等待进行中的写工具退出并阻止新写入），恢复失败路径转相对路径展示
  - 用量统计性能再优化：统计读取元数据改为轻量路径（只读 `{id}.meta.json`，不再走 `getMetadata` 的历史完整性检查——此前每次统计都会为每个对话额外加载一次历史，索引优化的收益被抵消大半）；新增对话目录监听（`fs.watch` recursive）+ 内存明细缓存——任何历史/元数据/索引文件写入都会把对应对话标记为 dirty，统计只重读 dirty 对话并回填缓存，其余对话直接重放内存明细（零 stat、零读文件），日常统计从几千次跨进程文件调用降到毫秒级；统计自身重建索引写入 `{id}.usage.json` 会触发一次自伤标记，下一轮重读小索引文件后自然恢复，不会无限循环；扩展 dispose 时释放监听，非文件存储（测试/内存适配器）自动退化全量扫描；新增缓存命中跳过读取 / dirty 重读回填 / 已删对话清理 / 缓存时间筛选与 watcher 文件名解析测试
  - 提示词设置页排版重排：动态上下文保留策略区块从全局固定位置移入对应的模板模式内——预设条目模式下显示在条目编辑区下方，传统模板模式下内联显示在动态模板文本框下方，选项归属不再让人困惑；新增「可用变量参考」可收缩面板（默认收起，静态变量组 / 动态变量组分组展示，chevron 展开收起），长变量列表不再永久占据设置页空间
  - 提示词模式栏新增保存按钮（绿色保存图标，保存中切换为 loading 动画），与底部原保存按钮并存；导入 / 导出按钮从 codicon 通用图标改为成对的自定义 SVG 图标（方向相反的导出/导入箭头），视觉上明确为一对操作
  - 提示词页保存 / 导出 / 导入反馈统一为浮窗 toast（成功 / 失败着色，2.5 秒自动消失，Transition 动画），移除底部行内文本提示（saveMessage）
  - 存档点文件哈希改为流式读取（`CheckpointManager.getFileHash` / `computeFileHashes`），不再把大文件整体 `readFile` 进内存，哈希结果不变
  - 默认启用存档的写工具列表补齐：新增 `insert_code`、`delete_code`、`search_in_files`（replace 模式）、图像处理（`remove_background` / `crop_image` / `resize_image` / `rotate_image`）与文档类（`create_plan` / `update_plan` / `create_design` / `update_design` / `create_progress` / `update_progress` / `record_progress_milestone` / `create_review` / `record_review_milestone` / `finalize_review` / `reopen_review`）默认在执行前/后创建存档；`search_in_files` 纯 search 模式（非 replace）不再创建全工作区存档
  - 恢复检查点前主动取消该对话的流式请求与关联的活跃 SubAgent，防止恢复后迟到 chunk 污染历史、SubAgent 继续写文件与恢复结果冲突
  - 存档排除功能上线：`CheckpointIgnoreResolver` 升级为四层排除模型——强制排除（`.git` / `node_modules` / 扩展存储根绝对路径，`!` 不可否定）→ 默认排除类别（8 类，设置页可分别开关，可被 `!` 重新纳入）→ 嵌套 `.gitignore`（anchored + 否定 + 目录作用域）→ 用户自定义模式（独立最终求值阶段，最后生效）；`shouldIgnore` 返回 `{ignored, reason, rule, source}`，快照构建输出完整 `excluded` 清单（含命中规则文本）与排除统计；单文件大小上限默认 50 MiB（0 = 不限制），超限文件记录 `reason: 'size'` 不静默消失；存档记录与 manifest 保存排除规则快照 `ignoreSnapshot` 与 `excludedCount/excludedBytes`，恢复时对比快照规则与当前规则输出 `excludedNote`（含 `rulesChanged`），且恢复过滤严格按当前规则（不因旧规则宽而覆盖当前明确忽略的文件）
  - 存档排除设置与预览：`CheckpointConfig.exclusion`（enabledProfiles 全开 / maxFileSizeBytes 50MiB / customPatterns，兼容旧 `customIgnorePatterns` 合并）；设置页新增默认类别开关、大小上限输入、自定义模式编辑器与「预览排除结果」按钮（按类别聚合展示、samples 上限 50、命中 reason/rule/source、被排除目录有界遍历 2000 项且 `complete=false` 标记）；新增 `checkpoint.previewExclusions` / `checkpoint.getExclusionProfiles` handler；配置校验拒绝空模式、绝对路径（盘符/UNC）、纯 `!`、`..` 越界、换行注入、未知类别 id 与非有限数值
  - 排除语义细节：win32 下强制排除绝对路径比较统一小写归一（防 `C:\Proj` vs `c:\proj` 大小写漏排）；「重新纳入目录类别下文件需同时否定目录本身（如 `!data/ + !data/keep.txt`）」在设置页给出提示；自定义模式不再被嵌套 `.gitignore` 覆盖（见 Fixed）
  - 每类别排除模式可编辑（用户需求）：设置页每个默认排除类别新增「编辑模式」按钮，可覆盖该类别的默认模式清单（每行一个 gitignore 模式，清空保存 = 恢复默认清单）；配置新增 `profilePatterns`（profileId -> 模式清单），`collectEnabledProfilePatterns` / resolver 按覆盖优先解析，并随规则快照写入 manifest（恢复说明口径一致）；保存校验复用规则（未知类别 id / 非字符串数组 / 非法模式均拒绝）；新增覆盖/回退/快照深拷贝测试 3 用例

### Fixed
  - 存档恢复边界显式化：只删除目标快照 `fileHashes` 中记录过的路径（快照语义），快照后新建、快照时被忽略/未备份（复制失败、大小超限、不可读）的文件恢复时不会被静默删除；恢复/创建期间与写工具互斥，避免快照与文件写入竞态
  - 修复批量删除增量链断链：旧实现只检查「被保留检查点直接引用」一层，链 A→B→C 删除 {A,B} 时 A 被删而 B 保留，B 恢复时断链；现在从所有保留节点向前遍历完整祖先链，被直接或间接依赖的祖先全部强制保留并返回 rejectedIds
  - 存档删除/合并操作接入工作区级互斥锁：删除、按索引删除、批量删除与创建/恢复互斥；`CheckpointOperationLock` 支持同 owner 相同工作区集合的可重入（引用计数），create 锁内清理旧存档（cleanupOldCheckpoints → deleteCheckpoint）不再嵌套等待自己而死锁
  - 修复回档并重试 / 回档并删除时后端删除失败仍继续执行：前端 `deleteMessage` 返回失败或抛错时中止后续重试/流程并展示明确错误，不再出现「前端已截断而后端历史残留」的静默不一致；后端各删除路径的磁盘删除失败不再完全静默，记录 warn 便于排查（元数据已正确移除，残留目录为孤儿目录不影响正确性）
  - 恢复结果新增未备份文件提示：`restoreCheckpoint` 返回 `unbackedPaths`（快照时大小超限/不可读/复制失败的文件，恢复时受保护不会被删除），前端恢复确认后展示失败/部分失败/未备份文件清单；设置页批量删除展示被依赖保留与删除失败的数量
  - 新增恢复预览确认流程：所有恢复入口（普通恢复 / 回档并重试 / 回档并删除 / 回档并编辑）先调用 `checkpoint.previewRestore` 计算恢复计划（将恢复/删除/跳过数量 + 待删除文件清单），确认框展示清单后才执行真正恢复；待删除文件区分「快照记录过」（快照白名单）与「快照后新建」（默认保留，用户确认后一并删除，实现「撤销工具新建文件」语义）；`RestoreEngine` 提取纯计算函数 `computeRestorePlan`，预览清单与实际执行的删除严格一致；`restoreCheckpoint` 新增 `deleteUntrackedFiles` 选项，未确认时保持原有保护语义不删除任何快照后新建文件
  - 恢复确认流程安全加固：`restoreAndRetry` / `restoreAndDelete` / `restoreAndEdit` 的「删除快照后新建文件」改为调用方（确认框）显式传参确认，默认 false——绕过确认框的调用不会静默删除文件；回档三连中 `deleteMessage` 失败时不再只提示，而是重新加载历史拉回前端窗口与后端一致；恢复确认框取消时清理暂存的预览动作状态；预览期间恢复按钮显示 loading 并禁用
  - 存档维护改进：`pruneMissingBackupCheckpointRecords` 顺带清理孤儿备份目录（磁盘存在但无任何记录引用，如删除失败/崩溃残留，仅处理 `cp_*` 格式目录）；设置页存档详情展示「N 个文件未备份」（悬停显示路径清单，去除工作区作用域前缀）；`CheckpointOperationLock` 可重入放宽为「请求集合是已持有集合的子集即放行」，嵌套调用更不易死锁
  - 深度审查修复：快照强制排除范围从存档目录扩大为整个扩展存储根（自定义数据目录位于工作区内时，memory/conversations 等扩展数据不再进入存档）；恢复时「删除多余空目录」纳入 `deleteUntrackedFiles` 确认控制（快照后新建的空目录默认保留，快照语义，预览清单一并展示）；legacy 存档预览返回 `legacy` 标记，前端展示「恢复以备份内容为准」避免误判「无变更」；恢复确认框打开期间恢复按钮禁用，防止重复点击覆盖确认内容
  - 修复增量链恢复索引错误：增量节点磁盘上只保存 `changes` 里的文件，但恢复索引此前把该节点完整 `fileHashes` 都指向其目录，导致未变化文件恢复时报 `missing_in_chain`；现在按 `changes` 限定节点备份边界，未变化文件从更早节点（base）恢复
  - 修复存档路径安全缺口：备份源目录（`backupDir`）来自存档元数据，损坏数据可含 `..`/绝对路径，现在恢复时校验备份源必须位于存档根目录内（越界视为链上缺失）；恢复目标路径全程做符号链接/junction 检查（`resolveSafePathInsideRoot`），链接不能绕过工作区边界
  - 修复旧版存档（无 `fileHashes`）恢复安全隐患：多根工作区下明确拒绝（旧记录无工作区身份，无法确定文件归属）；单根恢复以备份目录实际内容为目标、绝不删除当前工作区任何文件（旧记录没有“快照时可见”清单），替代此前“删除备份里没有的所有文件”的危险行为
  - 修复同一对话切换工作区后增量链错乱：新存档识别到工作区指纹不一致时从新的完整备份开始（断开旧链），不再跨工作区串接增量
  - 部分恢复失败时返回 `error` 摘要（前 5 条路径+原因，超出计数），前端 `restoreCheckpoint` 类型同步补充 `failures` 字段
  - 修复流式报错后重试残留半截回答：流式过程中后端报错时，后端不会持久化半截 assistant 消息，但前端窗口会保留有内容的半截消息，点击错误通知上的「重试」（`retryAfterError`）之前不会清理，导致重试后窗口/历史出现半截回答残留，且与后端历史错位；现在 `handleError` 会记录失败半截消息 ID，`retryAfterError` 重试前回滚（删除窗口消息 + 清理检查点 + 防御性同步删除后端），错误条「关闭」按钮与发送新消息也会一并清理失败残留，工具响应后的「继续对话」语义不受影响（不删除正常历史）；新增回归测试 12 用例（frontend `streamErrorRetry.test.ts`）
  - 修复动态上下文策略选项的误导性括号标注：单份模式选项原先带有「（当前策略）」（zh-CN）或「（当前行为）」（en/ja）注释，而该选项与保留模式是并列可切换的，标注「当前」会让用户在切换后看到错误的归属语义；现在移除括号注释，三语统一为中性文案「单份动态上下文 / Single dynamic context / 単一の動的コンテキスト」
  - 修复动态上下文策略警告文案硬编码英文：设置页选中保留模式时提示「preserve 会把旧回合的动态快照固定插回原位…」，而选项在 UI 上显示的是中文「保留旧动态上下文原位」，用户无法把二者对应；现在句首直接使用选项的中文名称，不再出现英文标识
  - 修复空提示词保存后回退默认模板：`resolvedMode?.template || promptConfig?.template`（PromptManager.ts）与 `mode?.template || ...`（SettingsManager.getSystemPromptTemplate）的空字符串回退导致 legacy 模式显式保存的空模板在运行时被全局模板覆盖，用户无法真正清空模板；两处改为 `??`（nullish coalescing），空字符串原样保留；前端 `loadModeConfig` 同步用 `typeof === 'string'` 判断而非 `||` 兜底，空模板不再被 DEFAULT_TEMPLATE 顶替，新增回归测试锁定该行为
  - 修复提示词导出流程不可控：前端 Blob 下载在 webview 环境保存位置与文件名不受用户控制，改为通过新增的 `exportPromptModes` webview handler 调用 `vscode.window.showSaveDialog` 让用户选择保存位置，确认后才写文件；取消保存对话框时不写文件并返回 `{ success: false, cancelled: true }`，成功后才报告成功；导出成功 / 取消 / 失败均有明确反馈，不再出现「已导出但不知道存到哪」
  - 修复恢复路径未接入四层排除模型：恢复时的目标状态过滤与当前工作区状态收集此前只走 `.gitignore` + 旧 `customIgnorePatterns` 两层，恢复可能把文件写回当前明确排除的路径（`dist/`、`data/`、超过大小上限的文件）或删除当前应排除的文件；现在 `createIgnoreResolver` 统一构造完整四层规则（强制排除含扩展存储根、默认类别、嵌套 `.gitignore`、新旧自定义模式合并），`filterRestoreTargetScoped` / `collectCurrentWorkspaceState` 与快照构建同一口径，恢复不再触碰当前明确排除的路径
  - 修复空增量节点恢复必失败：增量链索引构建时 `changes` 为空数组的节点（工具执行但无文件变化的 before/after 存档）被当作完整节点，其全部哈希被指到自己的空备份目录并覆盖更早节点，恢复任何漂移文件都报 `missing_in_chain`；现在区分「未提供 changes（完整节点）」与「空数组（空增量节点，不索引任何文件）」，空增量后的恢复由更早节点提供文件
  - 修复跨格式合并断链：容量清理把 legacy 布局（`cp_xxx/relative`）被清理节点并入新格式后继时，文件被原样复制到后继根目录且不写进 manifest，恢复时 `missing_in_chain`；现在按后继 scoped 布局重写路径（`ws_xxx/` 前缀）再复制，并把合并文件的 scoped 键并入后继 manifest.files（hash 取自被删节点），legacy→新格式过渡期清理不再破坏可恢复性
  - 修复存档取消竞态与锁等待裸异常：取消发生在等待文件写锁期间时，锁管理器抛普通 Error 从 `runExclusive` 漏出并冒泡到工具循环中断整轮执行；现在 create/restore/deleteAll/deleteBatch 外层捕获锁取消错误转为取消结果；取消发生在复制完成、元数据落盘之前时检查点仍会被保存且进度被 `done` 覆盖——现在写 manifest 与写会话元数据前检查 `throwIfAborted`，进度终态改为 `signal.aborted ? 'cancelled' : 'done'`
  - 修复排除规则对比漏类别开关：`rulesChanged` 只比较大小上限与自定义模式，设置页仅开关默认类别（如关闭 logs）时恢复说明误报「规则未变化」；现在同时比较键排序后的 `enabledProfiles` 与规则版本号
  - 修复自定义排除模式被嵌套 `.gitignore` 双向覆盖：自定义模式与默认类别原先注入根作用域 matcher，嵌套 `.gitignore` 可否定自定义层的 `!` 规则或反过来；现在自定义模式从作用域链拆出，作为所有作用域求值之后的独立最终阶段（强制排除仍不可覆盖），「设置页规则最后生效」与计划语义一致
  - 修复排除预览 `complete` 谎报：主扫描遇到不可读目录时静默跳过且 `complete` 仍为 true；现在不可读目录产出 `unreadable` 排除条目并置 `complete=false` 计入统计
  - 修复恢复说明与未备份提示回归：`rulesChanged` 与 `excludedNote` 补全后恢复说明准确；存档摘要（`CheckpointSummary`）化后设置页「N 个文件未备份」提示丢失——摘要补齐 `unbackedPaths` 相关字段，前端悬停提示恢复
  - 修复 append-only 崩溃恢复后计数永久不一致：尾段 rename 成功但 index 写失败/崩溃时残留行会在下次追加被并入段计数，`index.totalMessages` 与各段 count 永久相差、全量读与分页读口径不一；现在尾段读取后先按 index 提交点截断（`slice(0, count)`）再拼接新内容，at-most-once 语义下重试不重复，崩溃残留不会泄漏
  - 修复元数据文件损坏导致列表 UNKNOWN_ERROR（真实故障）：`saveMetadata` 原为非原子 `writeFile`，写入中途崩溃/断电即截断 `{id}.meta.json`（如 24MB 大文件），读取时 `parse_error` 抛到前端阻塞对话列表；现在元数据写入改为临时文件 + rename 原子替换（index 式提交点），`getMetadata` 遇 `parse_error` 时把损坏文件改名备份为 `.corrupt-*`（只保留一份）并从历史时间戳重建 fallback 元数据返回，不再向上抛错（存档记录列表随损坏文件丢失属降级代价，磁盘 `cp_*` 备份目录不受影响且不会被自动清理）
  - 修复完整性检查两类误判：legacy 单文件历史只 `exists` 不解析导致损坏 JSON 报 `ok`——现在至少做一次 `JSON.parse` 探测；segmented 分支 index 完好但段文件缺失时误报 `ok`——现在对每个段 `stat` 存在性（不解析内容，保持只读结构目标），任一缺失即 `readable=false`
  - 修复段缓存元素引用污染：`loadSegmentedHistory` 的 `slice` 只复制数组、元素与缓存共享引用，`ContextTrimService` 对 `tokenCountByChannel` 的原地赋值会污染缓存；现在加载路径返回前对元素浅拷贝，缓存只读边界落实；缓存键纳入段文件 mtime（`revision::m{mtime}`），外部进程改写段内容后命中前 `stat` 比对自动失效
  - 修复用量与元数据一致性：`updateSummary` 不再无条件写前端传来的 `messageCount`——超过历史实际条数时按 `index.totalMessages` 钳制，前端 IPC 失败时不同步本地计数；append 遇「index 存在但尾段缺失/损坏」时不再永久失败，回退全量重写自愈
  - 修复前端历史窗口与缓存问题：backfill 把 IPC 失败误当「已到历史开头」置 `windowStartIndex=0` 导致更早消息无法上拉——现在错误与空页区分，错误时放弃合并保留原窗口；`loadMoreConversations` 游标按实际返回数量前进，批量结果缺失时不再跳过未加载对话；消息中间位置同长度替换（迟到 cancelled chunk 清理）会命中陈旧可见缓存——`replaceMessageAt` 非尾部替换时清缓存；`addBatch` 直通 append 可能绕过 functionResponse 去重安全网——契约注释明确仅限纯追加 user/model 并对 functionResponse 显式拒绝
  - 修复子agent 续跑丢失 provider 缓存（用户反馈）：子agent 每次执行分配新 runId 作为请求 `conversationId`，DeepSeek/Anthropic 的 `user_id` 按它哈希，`continueFromRunId` 续跑时新 runId 落入新缓存域、前缀缓存必 miss；现在续跑时 `conversationId` 直接沿用旧 run 的 runId（`request.continueFromRunId || runId`），`user_id` 哈希输入与旧 run 完全一致、缓存域天然相同——模型调用工具只需传 `continueFromRunId`，系统自动注入稳定缓存域，无需任何额外字段（同时移除临时引入的 `GenerateRequest.cacheDomainId` 机制，formatter 回退为 conversationId 单一来源）
  - 修复子agent 反复调用 todo 工具报「无权限」（用户反馈）：`todo_write`/`todo_update` 依赖主会话 `ToolContext.conversationId`，子agent 执行路径不注入该值，声明了也必然失败并浪费迭代——现在从子agent 工具声明与执行期允许列表统一排除 todo 工具（主会话不受影响）
  - 修复子agent 窗口被尾部校准清空（用户反馈）：SubAgentMonitor 收到工具/内容事件时对聚焦 run 拉取尾部 20 条并整体替换窗口，用户「加载更早消息」prepend 的历史被清空；现在尾部校准改为保留早于传入 `startIndex` 的前缀合并（`replaceRunContentWindowPreservingPrefix`），删除/重试的权威校准路径仍走纯替换
  - 修复子agent 写文件冲突提示不友好（用户反馈）：冲突消息不再笼统「不要重试」，改为明确持有者身份（`agent "X"` / 主会话 / 存档操作）与三步指引（不循环重试 → 先做其他工作、持有者释放后重试 → 持续冲突在最终回复上报主会话协调），`presets.ts` 指引语义同步
  - 修复子agent 运行时间显示本地绝对时间戳（用户反馈）：SubAgentMonitor 的「运行中 · 15:16:46」改为相对耗时（`42s` / `2m30s` / `1h5m`，活跃态显示已运行时长、终态显示总耗时），新增 1s ticker 仅在有活跃 run 时运行

### Added
  - 新增 `exportPromptModes` webview handler（`webview/handlers/SettingsHandlers.ts`）与回归测试 `backend/__tests__/webview/promptModeExport.test.ts`（取消对话框不写文件 / 选路径并写文件成功后才响应，2 用例）；`PromptManager.promptEntries.test.ts` 新增「显式空模板不回退全局模板」用例；vscode mock 补充 `showSaveDialog` / `showOpenDialog`
  - 新增存档快照构建器 `CheckpointSnapshotBuilder`（多根工作区扫描、强制排除绝对路径防存档自备份、单文件大小上限记录排除原因、流式哈希、有界并发）与单元测试 7 用例
  - 新增存档恢复引擎 `CheckpointRestoreEngine`（增量链文件索引 O(1) 查询、scoped 路径安全解析兼容旧相对路径存档、哈希校验、失败清单区分 missing_in_chain / hash_mismatch / copy_failed / delete_failed）与单元测试 6 用例
  - 新增工作区身份与路径安全模块 `CheckpointWorkspace`（工作区根 ID / 指纹 / 快照校验 / 安全相对路径与符号链接边界）与存档操作互斥模块 `CheckpointOperationLock`（工作区级 FIFO 互斥 + 全局文件写锁等待），配套单元测试 26 用例
  - 新增存档工作区边界集成测试 `CheckpointManagerWorkspace.test.ts` 6 用例（多根创建/恢复、跨项目恢复拒绝、存档目录位于工作区内时自排除、多根下旧存档明确拒绝、unbacked 文件恢复保护）
  - 新增增量链/路径安全回归测试 6 用例：增量节点未变化文件从 base 恢复（`changes` 边界）、`backupDir` 越界备份源忽略、跨工作区创建新存档断链、无 `fileHashes` 旧存档多根拒绝、旧存档恢复不删除备份外文件、部分失败返回错误摘要
  - 新增测试：`CheckpointOperationLock` 可重入 3 用例（同 owner 嵌套不死锁、不同 owner 仍串行、内层释放不提前释放外层锁）、批量删除祖先闭包 1 用例（保留尾节点保护整条基链）、恢复返回 `unbackedPaths` 且未备份文件不受删除 1 用例
  - 新增测试：`computeRestorePlan` 白名单/受保护/快照后新建文件过滤 1 用例、`previewRestore` 预览无副作用 + 未确认不删快照后新建文件 + 确认后删除 1 用例
  - 新增测试：锁子集可重入 1 用例、孤儿备份目录清理 1 用例、前端 `checkpointActions.test.ts` 9 用例（previewRestore 透传/异常、restoreCheckpoint 确认标记、restoreAndRetry 删除失败中止 + 重载历史、成功路径、restoreAndDelete 失败重载历史）
  - 新增测试：扩展存储整根排除（memory 数据不进存档）增强 1 用例、快照后空目录默认保留 + 确认后清理 1 用例
  - 设置页存储路径区域新增「打开目录」按钮，复用既有 `storagePath.openInExplorer` webview handler，一键在系统文件管理器中打开当前生效的存储目录
  - 新增 checkpoint 模块共享类型契约 `backend/modules/checkpoint/types.ts`（`CheckpointExcludeReason` / `CheckpointExcludedEntry` / `CheckpointExclusionSummary` / `CheckpointExclusionConfig` / `CheckpointIgnoreSnapshot` / `CheckpointManifest` / `CheckpointSummary` / `CheckpointExclusionPreviewResult` / `CheckpointOperationProgress`），作为排除与 manifest 并行改造的接口锚点
  - 新增默认排除类别模块 `CheckpointExclusionProfiles.ts`：8 个类别（logs / aiModels / datasets / caches / pythonVenvs / buildArtifacts / largeMedia / archives）严格按计划清单（不含 `*.bin/*.dat/*.model`、`env/`、`png/jpg/svg`），导出 `resolveEnabledProfiles` / `collectEnabledProfilePatterns` / `buildIgnoreSnapshot` / `validateCustomExclusionPatterns`
  - 新增 manifest 仓储 `CheckpointManifestRepository.ts`：`checkpoints/cp_xxx/manifest.json` 原子写入（tmp+rename）、按 ID 加载（内存缓存）、旧记录迁移（从 `CheckpointRecord.fileHashes/fileStats/emptyDirs/changes` 生成并落盘，幂等）、损坏回退、写入失败清理 tmp；新格式记录无文件哈希时迁移产物为空则返回 null 并显式报「存档数据缺失」而非假成功
  - 新增 `CheckpointQueryService.ts`（getCheckpoints / getAllConversationsWithCheckpoints / getDirectorySize / pruneMissingBackupCheckpointRecords / 孤儿目录清理）与 `CheckpointRetentionService.ts`（cleanupOldCheckpoints / mergeCheckpointIntoSuccessor），`CheckpointManager` 从 2000+ 行拆分为协调层 + 三服务
  - 新增共享有界并发池 `checkpointConcurrency.ts`（runBounded，首错停止取新任务并正确传播），创建复制、恢复/删除循环、目录大小统计均改为有界并发（默认 8）
  - 会话元数据精简：完整 `fileHashes` / `fileStats` 从会话元数据迁到独立 manifest，元数据只保留 `CheckpointSummary`（fileCount / backupBytes / excludedCount / manifestVersion 等）；`getCheckpoints` / `getAllConversationsWithCheckpoints` 只下发摘要，旧存档缺字段时按需懒扫描并写回缓存；磁盘占用创建时直接记录（`backupBytes`），设置页不再重复递归扫描
  - 流式路径下发摘要化：工具执行期间的 checkpoints chunk 经 `CheckpointService.toStreamSummary()` 剥离 `fileHashes/fileStats`，`loadConversationForView` 与流式两条路径都不再向 webview 传全量哈希映射（补全）
  - 存档操作接入进度与取消：Manager 维护进行中操作状态（阶段 / 已处理 / 总数，AbortController），create / restore / deleteAll / deleteBatch 全接入；RestoreEngine 支持 `signal` + `onProgress`；新增 `checkpoint.getOperationProgress` / `checkpoint.cancelOperation` handler 与前端轮询 + 取消按钮
  - 只读工具批次不再创建存档：`tool_batch` 判定改为基于真实工具名集合 `toolNames.some(name => configuredTools.includes(name))`，`read_file + search_in_files(search)` 等纯只读批次不建存档，`search_in_files` 仅 replace 模式计入
  - 历史追加改为 append-only 尾段写入：普通追加只写最后一段（不足 200 条）或新建下一段 + 更新 index，不再全量重写所有段；写入顺序「临时尾段 → 原子替换 → 临时 index → 原子替换」，index 是提交点；删除 / 编辑 / 回档 / 分支切换仍走全量重写；`TranscriptRepository` 新增 `appendContents` 直通 append，`addContent` / `addBatch` 纯追加路径不再读全量（functionResponse 保留 mutate 去重安全网）
  - 新增段级 LRU 缓存 `history/HistorySegmentCache.ts`：键 `conversationId + segmentFile + revision(+mtime)`，默认 32 段，写后 / 删除会话失效；多段读取改有界并发（并发 4）
  - 同一工具迭代内复用历史快照：`getHistoryForAPIFrom(contents)` / `getStatsFrom(contents)` 支持基于已加载历史直接格式化，`ContextTrimService` 不再每次重新读全量历史
  - 元数据写入合并：新增 `conversation.updateSummary({conversationId, messageCount, preview})` 一次读写完成，前端流式结束后由 3 次 `setCustomMetadata` 改为 1 次；`updatedAt` 由历史提交统一维护
  - 对话列表批量元数据：新增 `conversation.getConversationMetadataBatch`（16 并发、每页 ≤200），前端 `loadMoreConversations` 一次 IPC 拉一页摘要，消除逐对话 IPC
  - 用量索引增量维护：新增 `UsageIndexStore.appendUsage` / `appendUsageMessages`，普通追加助手消息只追加条目，删除 / 编辑 / 回档 / 索引损坏才全量重建；`getMetadata` 完整性检查只读 `history.index.json` 结构，不再解析末段历史
  - 子agent 用量归集（用户需求）：子agent 每轮 generate 的 `usageMetadata` 以 `source: 'subagent'` 条目追加到发起它的主会话用量索引（`appendUsageIndexMessages`），用量统计 totals / byConversation / byModel / byDay 自动包含子agent 消耗，`ConversationUsage` 新增 `subagentTokens` 细分；索引 stale 全量重建时保留已有 subagent 条目；无主会话归属时跳过归集
  - 前端渲染优化：可见消息窗口增量缓存（同引用 + 长度 + 首尾指纹 O(1) 校验，流式尾替换 O(1)，结构变更回退全量过滤）；对话加载先渲染最后一页再异步补拉更早历史（`backfillInitialVisibleWindow`，与用户上拉 / 发送 / 流式并发时放弃合并）
  - 元数据写入原子化：`saveMetadata` 改为临时文件 + rename 原子替换，任何写路径不再可能留下截断的 meta.json
  - 子agent 设置新增「默认迭代次数」（用户需求）：`SubAgentsConfig.defaultMaxIterations`（默认 80，上限 1000），executor 取值 `per-agent maxIterations > 全局默认 > 50`，设置页全局配置区新增输入框（1~1000），`subagents.list` 返回该值

## [1.3.1-1] - 2026-08-02

### Fixed
  - 修复存储路径迁移目录套娃（无限递归）：`copyDirectory` 复制时若目标位于源目录内部会无限递归自我复制（mkdir 目标后 readdir 源会看到刚创建的子目录，一次误选子路径可产生数千层嵌套），现检测到目标在源内部时跳过；路径重叠判断改用 `realpath`，junction/符号链接无法绕过防套娃
  - 修复存储路径迁移数据安全：源/目标互相包含时先复制到临时目录中转，避免清理旧目录时删除新数据；复制失败终止迁移并回滚，源数据与配置保持不变；失败时恢复原 `customDataPath`/状态，不再错误切回默认路径；路径验证改用随机临时目录，不再覆盖用户 `.limcode-test` 文件
  - 修复前端误读 `config.customPath`（后端字段为 `customDataPath`）导致重置按钮永远禁用；应用/重置按钮增加明确提示（空路径、已是默认路径时不再静默无反应）
  - 修复设置页描述单行截断：工具名与描述改用 i18n（47 个工具全覆盖），描述样式改自动换行（pre-wrap），不再截断

### Changed
  - 工具调用格式选项移除「（推荐）」标记：JSON 边界标记不再标注为推荐项（原生 Function Calling 已是主流选择），渠道设置下拉与提示文案的中/英/日三语同步调整
  - 设置页 i18n 补全：工具设置/自动执行/存档点/子代理/模型管理的分类分组全量三语翻译（记忆/审查/进度/技能/设计/通知/代理等 16 类），消除重复「其他」分组；Prompt 设置补 `modules.MEMORY`（记忆系统）三语；记忆设置 Raw Memory Entries 等硬编码英文改走 i18n
  - 存储路径设置 UI 改版：合并「当前存储路径/自定义路径」为单一输入框，新增 📁 文件夹选择按钮（`storagePath.selectFolder`），删除冗余的迁移数据按钮；`validatePath` 放宽——允许选择默认路径/子路径/普通非空目录（如桌面），仅拒绝已包含扩展数据子目录（conversations/checkpoints 等）的目标，防止数据混合
  - 渠道设置新建配置：改为模态遮罩弹窗（点击遮罩取消），配置名称为空时红框+提示
  - 更新扩展与活动栏图标：市场图标由 1024px 角色插画（1.4MB）替换为 256px 三色剪影版（73KB，深蓝圆角方底，小尺寸辨识度更好）；活动栏/侧边栏图标由 VS Code 默认地球替换为角色剪影，并进一步改为纯轮廓线稿（fill=none + stroke=currentColor 随主题着色，Douglas-Peucker 路径简化 716→161 点，24px 下无锯齿）

### Added
  - 新增 `StoragePathManager` 单元测试（6 项）：覆盖迁移中转、失败回滚、realpath 重叠判断、路径验证临时目录等安全加固行为

## [1.3.1] - 2026-08-02

### Fixed
  - 修复 README 与实际工程能力不一致：更新 npm 构建、Node.js 版本、工具参数、模板变量、设置导出边界、测试命令和项目目录说明
  - 修复 npm 工作流残留 pnpm 调用与根锁文件过期：`vscode:prepublish`、前端构建和开发脚本统一通过 npm 执行，重新生成与 GrayCode 1.3.0 当前依赖一致的 `package-lock.json`
  - 修复 SubAgent 对话延续入口不可达：`subagents` 工具正式暴露并在前台、后台、General Worker 与自定义代理路径中透传 `continueFromRunId`
  - 修复 Sub-Agent 可获得永久记忆工具：所有子代理统一排除 7 个 memory 工具，工具清单描述和执行期允许列表使用同一隔离规则
  - 再次修复输入框 Ctrl+Z 撤销忽略粘贴内容：此前文字粘贴在 `paste` 回调中 `preventDefault` 后通过 `execCommand('insertHTML')` 模拟插入，虽然单独执行命令可进入撤销栈，但没有保留 Chromium 原生 `insertFromPaste` 事务，实际 webview 中仍可能跳过粘贴内容；现在仅在本次粘贴默认动作期间把编辑器临时切换为 `contenteditable="plaintext-only"`，由 Chromium 原生完成纯文本粘贴并记录撤销项，事件结束后恢复普通编辑模式，不影响 Shift+Enter 自定义换行与上下文徽章；文件粘贴仍按附件处理，新增组件级回归测试覆盖文字与文件两条分支
  - 修复用量索引文件被识别为假对话：`FileUsageIndexStore` 把索引写到 `{conversationId}.usage.json`（与历史文件同级），而 `listConversations` 只排除了 `.meta.json`，导致每个对话的 `.usage.json` 都被识别成假对话 ID（形如 `xxx.usage`）显示在历史列表，点入报 "Metadata file is missing"；现在文件识别同样排除 `.usage.json`，只返回真实对话 ID（legacy `{id}.json` 与 segmented `{id}/` 目录），新增回归测试锁定该行为
  - 修复 XML 工具调用解析安全：`fast-xml-parser` 升级到 5.10.1 后为解析器增加 `processEntities: false` 与 `maxNestedTags: 100`，工具协议不再接受 DOCTYPE 自定义实体与超深嵌套输入；协议层额外过滤 `__proto__`/`constructor`/`prototype` 危险键名防原型污染，新增安全输入回归测试（数字字符串保持、实体不展开、深嵌套安全失败、危险键名拒绝）
  - 修复批量工具部分成功时 LLM 只看得到顶层错误：`serializeToolResultForLLM()` 错误分支不再丢弃 `data`，`data.results` 混合数组逐项格式化（避免 JSON 二次转义）、`data.message` 与批量统计（successCount/failCount/totalCount）一并输出，`data.output` 与取消标记保持原有格式；新增共享 formatter 回归测试覆盖 10 项场景
  - 修复 XML 工具指南示例过时：`read_file` 的 `paths` 与 `write_file` 的 `files` 旧示例改为真实 schema（单文件 `path` / 批量 `files: [{ path, startLine?, endLine? }]` / 顶层 `path`+`content`），XML/JSON 测试夹具同步更新为真实参数形状
  - 修复 `SubAgentRegistry.isEnabled()` 把未注册代理误判为启用：未注册代理现在返回 false
  - 修复注册的自定义 Sub-Agent executor 从未被调用：Registry 查询不再隐式创建并缓存默认 executor，正式工具调用路径优先使用显式注册的 executor；executor 请求新增 `conversationId`/`conversationStore`/`promptModeSnapshot` 动态上下文并在每次调用透传
  - 修复 Sub-Agent 跨对话接续泄漏：`continueFromRunId` 只允许接续当前主对话所属的 run，归属不一致时拒绝且错误信息不泄漏旧对话 ID 或内容
  - 修复重载/内存淘汰后已持久化 run 无法接续：接续时内存快照未命中会只加载当前对话的持久化记录，恢复后仍执行归属与终态校验
  - 修复全部配置代理禁用时 `subagents` 工具被整体隐藏：`ChannelManager`/`ToolDeclarationResolver` 统一使用「配置代理计数 > 0 或 General Worker 启用」的 `hasAvailableSubAgent()` 判断
  - 修复 Windows 通知依赖链：移除已停更且有生产审计告警的 `node-notifier`，通知适配器改为 VS Code 原生 `showInformationMessage`（操作按钮打开聊天、不阻塞工具调用），esbuild 不再复制原生包，`npm audit --omit=dev` 归零
  - 修复 `.vscode/launch.json` 的 `Extension Tests` 指向不存在的测试入口：替换为可运行的 Jest 调试配置

### Added
  - 永久记忆设置新增默认开启的总开关；关闭后不再向系统提示词注入 `{{$MEMORY}}` 内容，也不会向 AI 暴露 7 个 memory 工具，已有记忆、运行参数和自定义提示词保持不变并可继续在设置页管理，重新开启后恢复使用
  - `read_file` 新增单次批量读取：保留 `path/startLine/endLine` 单文件调用，新增 `files: [{ path, startLine?, endLine? }]`，每个文本文件可独立指定行范围，结果按输入顺序汇总并保留部分失败详情；前端工具摘要与结果面板同步支持批量参数
  - 用量统计新增缓存维度：此前 Anthropic 的缓存写入（cache_creation_input_tokens）与缓存命中（cache_read_input_tokens）在 formatter 被合并成 cachedContentTokenCount 后明细即丢失，聚合器也从未读取该字段，统计里完全没有缓存信息；现在 usageMetadata 拆分保存 cacheCreationTokenCount / cacheReadTokenCount（Anthropic 分别映射写入与命中，OpenAI cached_tokens / Gemini cachedContentTokenCount 映射命中），流式累加器同步合并；aggregateUsageStats 总览 / 按对话 / 按模型 / 按天各维度新增缓存写入与缓存命中两个桶——缓存是 promptTokenCount 的细分（prompt 已含缓存部分），不重复计入 totalTokens；用量统计页总览卡片与明细行新增「缓存写入 / 缓存命中」展示（有值才显示），i18n 三语补齐，新增聚合与 formatter 断言测试
  - 用量统计兼容旧数据缓存记录：旧版本只存缓存合并值（cachedContentTokenCount）无法拆分写入/命中，升级前的对话统计时近似全部记为缓存命中（OpenAI/Gemini 语义下该值本就是命中，Anthropic 实际以命中为主，偏差最小），避免旧对话的缓存贡献在统计中消失
  - 用量统计性能优化：聚合由串行逐个读取改为限流并发（12 路）；新增轻量读取接口 getMessagesRaw 绕过显示规范化与逐条深拷贝，只读统计所需的原始消息；handler 层新增进程内 5 分钟 TTL 结果缓存，短时间内重复打开统计页直接命中缓存，手动刷新（force）强制重算
  - 用量统计性能优化新增消息级增量索引：全量扫描历史文件的开销随对话数增长（每次统计都要解析全部历史 JSON），现在消息落盘时同步维护每对话的用量索引（{conversationId}.usage.json，只存消息级 token 明细，不存消息内容），统计时按历史文件与索引文件的 mtime 判定新鲜度——索引最新则直接聚合索引（完全不读历史文件），缺失/过期/损坏则回退读取历史并重建写回（一次性成本）；任何历史写路径（编辑/删除/回滚/清空/导入/分支）都会更新历史 mtime 从而自动触发索引重建，无需逐一追踪写入口；删除对话时索引同步清理；索引写失败静默降级，不影响对话保存与统计正确性；新增索引构建/命中/重建/损坏回退/写失败降级测试
  - 新增本轮安全与行为修复的回归测试：`toolResponseFormatter.test.ts`（部分成功序列化）、`subagentRegistry.test.ts`（isEnabled 与 executor 语义）、`subagentExecutorContinuation.test.ts`（跨对话拒绝与持久化恢复）、`windowsToastAdapter.test.ts`（VS Code 原生通知适配器）

## [1.3.0] - 2026-08-01

### Fixed
  - 修复输入框 Ctrl+Z 撤销忽略粘贴内容：contenteditable 粘贴为强制纯文本走 `preventDefault` + 手动 Range 插入，操作不进浏览器原生 undo 栈，Ctrl+Z 会跳过刚粘贴的内容去撤销更早的操作（Shift+Enter 换行、插入 @路径文本同理）；现在粘贴 / 换行 / 插入 @路径文本改用 `document.execCommand('insertText'/'insertHTML')` 写入原生撤销栈——一次粘贴对应一个 undo 条目可整体撤销，同时保持纯文本语义与 lim-break BR + ZWSP 的既有 DOM 结构；`execCommand` 不可用时回退手动插入保证功能不回归，插入函数返回 `inputFired` 避免 execCommand 自动派发 input 事件后调用方重复提取节点，新增 14 个 vitest 用例
  - 修复 subagents 工具后台模式缺失（计划标记完成但实际未实现）：工具声明无 `background` 参数、handler 无后台分支，前端 backgroundTaskStore / BackgroundTaskBar / backgroundStatus 整套后台基建空转；现在按已确认设计补齐——`background: true` 时创建独立 AbortController（用户停止当前对话流不连带取消）、以 `background_subagent` 类型注册到 TaskManager、executor 启动后不 await、工具立即返回 `{ background: true, taskId, runId, agentName }`，executor settle 时注销任务并携带完整结果载荷（response/steps/runId/error），经现成 taskEvent 转发链路由前端混合回流（会话空闲立即发回执、正忙挂起补发）送达主模型
  - 修复代理非 chunked 流式解码仍损坏中文：非 chunked 消费点仍逐 TCP 包 `toString('utf8')`，被包边界切开的 UTF-8 多字节字符固化成 U+FFFD；现在与 chunked 一致走流式 `TextDecoder`，flush 移入非中止分支
  - 修复 glob globstar `**` 失效：GLOBSTAR 占位符正则匹配三个转义星号而 `**` 转义后是两个，`**/node_modules/**` 等规则永不跨目录命中；修正为匹配两个转义星号（PromptManager / fileTree 两处）
  - 修复 diff 预览 LCS 后缀匹配丢失：computeLCS 剥离公共后缀后从不回填，任何带公共尾部的 diff 尾部公共行被标为「删除+新增」、统计虚高；现在按原始索引回填后缀匹配（apply_diff / write_file 两处）
  - 修复 `deleteCheckpoint` 缺少基快照引用保护：updater 未检查 `baseCheckpointId` 引用，被后继检查点引用为基快照时仍删除会断增量链、恢复 100% 失败；现在被引用时返回原引用拒绝删除
  - 修复 ChatViewProvider 关闭标签页后消息仍静默丢失：`onDidDispose` 不重置 `_view`/`webviewReady`，isAlive 判定对已销毁 webview 仍返回 true，面板关闭期间 postMessage 静默丢弃；现在与 dispose() 语义对齐重置并释放主聊天 client 注册
  - 修复 media 工具取消后终态恒为 `completed`：批处理末尾无条件 `unregisterTask('completed')`，用户取消的任务显示为「已完成」、后台回执误报成功；现在全部任务被取消时终态为 `cancelled`；`generate_image` 的 failedResults 同步排除 cancelled（与其余 4 个 media 工具对齐）
  - 修复终端输出护栏丢弃行时无截断提示：显示上限关闭时 `omittedOutputLines` 不计入 `wasTruncated`，AI 看不到「输出被截断」；现在护栏丢弃同样触发截断提示
  - 修复 search_in_files 高亮替换串 `$` 特殊语义：匹配文本含美元符特殊替换序列（$'、$`、$$）时 `String.replace` 展开特殊替换模式导致高亮内容错乱；改用替换函数
  - 修复 MarkdownRenderer mermaid 残留注入面：`securityLevel: 'loose'` 下模型可控的图例 HTML 可经 zoomedContent 的 v-html 再次注入执行（webview CSP 含 unsafe-inline）；改为 `'strict'`
  - 修复 fast-tavern Python 遗漏项：`build_prompt.py` 实际存在（文档误判为「已移除」）且 `recentHistoryForWorldbook` 仍 `int()` 强转、浮点字符串抛 ValueError，改为 `int(float())` + 解析失败回退 0；`convert_from_silly_tavern` 遗留 `isinstance(p, int)` 漏 float position，改 `_is_number`；`get_active_entries._to_recursion_limit` 不可解析回退 5（TS 应为 NaN→循环不执行）、负数被钳制到 0 多执行一次、`-inf` 分支多执行一次——全部对齐 TS Math.trunc/Number 语义
  - 修复 glob 通配零段语义：`**/x` 不匹配根级 `x`、`a/**/b` 不匹配 `a/b`（`**` 展开为 `.*` 后要求至少一个目录段）；现在统一到 `backend/modules/prompt/glob.ts` 的 `globPatternToRegExp`（PromptManager / fileTree 三处共用），`**` 后跟分隔符时零段可选（gitignore 语义）、单星不跨目录段（fileTree gitignore 分支原先 `*` 跨 `/` 一并修正）；同时去掉「斜杠展开为 `[/\\]` 字符类」的 4 反斜杠魔法——三处调用点路径均已归一化为 `/`，模式里的 `/` 直接作字面 `/`，「斜杠替换必须先于星号替换」的顺序耦合随之消除
  - 修复 fast-tavern Python normalize_worldbooks 缺字段语义与 TS 不一致：`_to_number` 的 None 分支忽略 fallback 直接返回 0.0，缺 `probability` 的条目概率变 0 永不注入、缺 `index`/`order`/`depth` 的条目被保留（TS 侧分别回退 100 / 丢弃条目）；现在 None 返回 fallback，新增 `_entry_number` 区分「键缺失」（→ fallback）与「显式 null」（→ 0，对齐 `Number(null)`），补 5 个 pytest 用例
  - 修复关闭活跃标签页产生孤儿快照（内存泄漏）：closeTab 删快照后 switchTab 会把已关闭标签页的完整会话状态（allMessages/messageQueue 等）重新写回 sessionSnapshots 成为永不被清理的孤儿条目；现在快照仅在标签页仍存在于 openTabs 时写入，新增 3 个 vitest 用例
  - CheckpointManager 测试补强：测试 mock 此前缺 `updateCustomMetadata`（迁移后的 7 处调用零覆盖），且并发 mock 未模拟真实串行链；现在 mock 补链式 `updateCustomMetadata`，新增 8 个用例覆盖 saveCheckpointToConversation（含并发追加无丢失）、deleteCheckpoint（含 isReferencedBase 拒绝与磁盘目录清理）、deleteCheckpointsFromIndex（含 excludeCheckpointId 基链保留）、deleteAllCheckpoints、pruneMissingBackupCheckpointRecords、cleanupOldCheckpoints 链合并重挂

### Added
  - 新增 subagents 工具后台分支单元测试（`backend/__tests__/tools/subagentsTool.test.ts`，8 用例）：声明暴露 background 参数、后台调用立即返回 stub 且不 await、TaskManager 注册（background_subagent + 元数据）与注销载荷（response/steps/runId/error）、executor 失败/取消状态映射、父 abortSignal 已中止时后台任务仍启动（独立取消）、前台模式回归
  - 新增存档点批量管理/清理：设置页「清理存档点」支持对话多选 + 全选 + 跨对话批量删除（顶部显示已选数量与磁盘占用合计）；对话可展开查看内部存档点列表（阶段/工具/备份类型/文件数/磁盘占用），支持存档点多选或单个删除；后端新增 `deleteCheckpointsBatch` 批量接口（沿用基快照引用保护，整条增量链同时选中时可一并删除，空 ID 列表 = 清空该对话），`getCheckpoints` 支持 `withSize` 返回每条存档点磁盘占用，前端 CheckpointRecord 类型补齐与后端一致的字段

## [1.2.9] - 2026-08-01

### Fixed
  - 修复上传 txt 等文本附件报 `API_ERROR: HTTP 400: unknown variant image_url, expected text`：OpenAI Chat Completions / OpenAI Responses / Anthropic 三个 formatter 把用户附件一律按图片序列化（image_url / input_image / image base64），text/plain 文件被当作图片发送被纯文本 API 拒绝；现在按 MIME 类型分发——图片保持原行为，文本附件解码为 text 块，PDF 在 OpenAI Responses 转 `input_file`（官方支持 base64 内联）、Anthropic 转 document 块；OpenAI Chat Completions 新增 `pdfAttachmentEnabled` 渠道开关（默认关闭，直连官方端点可手动开启），开启后 PDF 以 `file` 内容块发送，关闭时转文本占位避免不支持 file 类型的兼容端点报 400；TokenCountService 同步修正，新增回归测试 `formatterAttachments.test.ts`
  - 修复 MemoryManager 编辑记忆死锁：`updateEntry` 持锁期间调用 `dropSummariesCovering` → `treeDrop` 二次 acquire 同一把不可重入的 AsyncLock，形成闭环等待，记忆条目 ≥2 条时编辑操作永久挂起、整个记忆模块排队瘫痪；`dropSummariesCovering` 移出锁外执行（treeDrop 自身会加锁），新增回归测试 `h1_deadlock.test.ts`
  - 修复 Anthropic 并行工具调用参数全部丢失：formatter 未透传 `content_block_*` 事件的顶层 `index`，累加器把多个工具的 `input_json_delta` 全部拼进最后一个空工具壳导致 `JSON.parse` 失败、工具以空参数执行；现在 `content_block_start` / `input_json_delta` 均透传 `chunk.index`，新增回归测试 `formatterParallelTools.test.ts`
  - 修复 OpenAI Responses 渠道工具参数双重拼接：`function_call_arguments.done` 携带完整 arguments 但未设置 `finalArgs`，累加器把完整 JSON 追加到已累积的半截增量上形成垃圾串，工具全部空参数执行、"流式边执行工具"失效；现在 done 事件设置 `finalArgs: true`，累加器按覆盖语义解析
  - 修复 `delete_file` 可递归删除整个工作区的问题：handler 对 `""`/`"."`/`".."` 及解析后等于任一工作区根的路径零校验，一次误调用即删光全部文件；现在显式拒绝上述路径（工作区外策略拦不住根目录本身）
  - 修复 limcode→graycode 改名残留导致多处功能不可用：diff 视图悬停 ✅/❌ 链接、灯泡操作、编辑器标题栏 Accept/Reject All 按钮、Windows 通知点击打开聊天全部失效（命令均未注册）；8 处 `limcode.*` 全部替换为 `graycode.*`，另修复 `show_windows_notification` 的 `GrayCode.openChat` 大小写错误（extension 注册的是小写 `graycode.openChat`，VS Code 命令名大小写敏感）
  - 修复工具执行后中止时已执行结果被丢弃：模型消息已写入历史、流式提前执行的工具已产生真实副作用，用户停止后直接返回导致结果永久丢失、模型可能重复执行同一工具调用；现在 abort 路径把提前执行与串行执行的结果（含多模态附件）合并写回历史并结算 stop state，等待提前执行工具的循环内部增加 abort 检查避免某工具不响应信号时请求永久挂起
  - 修复同一会话并发流：第二个流创建时静默覆盖旧控制器不中止旧流，旧流先结束时其 finally 无条件 delete 误删新流控制器，旧流不可取消、新流变孤儿、两个流并发读写同一历史文件互相覆盖；现在 `create()` 先 abort 旧控制器再替换，`delete`/`deleteSummary` 加引用校验
  - 修复 diff 自动保存与取消竞态：auto-save 的 acceptDiff 在队列中异步执行，期间用户发送新消息触发 cancelAllPending（不走串行队列）恢复文件后，accept 后续的 `doc.save()`/`writeFileSync` 仍把 AI 内容写回磁盘；现在 `cancelAllPending` 纳入 `diffActionQueue` 串行队列，`acceptDiffUnlocked` 在 openTextDocument/applyEdit/写盘前复查 `diff.status`
  - 修复同一会话历史写并发覆盖：分段历史写入先删整个目录再逐段重写（无锁），transcript `get→mutate→replace` 无串行化，checkpoint 元数据 read-modify-write 无锁——并发时 index 与 segment 不一致、真实执行成功的工具结果被"用户拒绝"占位覆盖、检查点/裁剪状态随机丢失；现在历史写入按会话串行化并改为"临时目录 + rename"原子切换，transcript mutate 整体互斥，`setCustomMetadata` 加 per-conversation 写锁
  - 修复检查点增量链断裂：cleanup 按时间删最旧不检查 `baseCheckpointId` 依赖，配置 `maxCheckpoints`（如 1~2）后回档 100% 失败；现在只删除不再被任何存活检查点引用为 base 的项
  - 修复检查点恢复时 dirty 文档把用户旧缓冲区写回磁盘覆盖刚恢复内容的问题：恢复后对 dirty 文档直接 `doc.save()` 会覆盖恢复结果，现在先把文档 buffer 替换为磁盘内容再静默保存（直接 revert 会弹原生确认框阻塞流程）
  - 修复中断/取消流的 token 严重少计：`usageMetadataPartial` 标记此前从未被写入也从未被检查；现在取消路径写入该标记，用量统计与对话统计对半截 usage 回退到文本长度估算
  - 修复 SSE 合法多行 `data:` 事件内容静默丢失：前一段不完整数据被无条件覆盖丢弃（注释写"继续累积"实际是覆盖）；现在按 SSE 规范用单个换行累积多行 data，解析不了的中间行保留到流结束进入 unparsed 错误详情不再静默吞掉
  - 修复 `execute_command` 超时被误判为执行成功：超时把 `killed = true` 复用为成功标志，模型把超时命令当成功；现在新增独立 `timedOut` 标志，超时按失败返回，任务状态显示 error 而非 cancelled
  - 修复 `insert_code` 内容以 `\n` 结尾时多出空行且 CodeLens 高亮偏移：`split('\n')` 多出的尾部空串被移除，插入行数统计同步修正
  - 修复 `read_file` 无文件大小护栏：超大文件全量读入并全量塞进模型上下文；新增 5MB 上限（与 search_in_files 一致），超限拒绝并提示改用搜索
  - 修复 unified diff 解析把 hunk 内以 `-- ` 开头的删除行（SQL/YAML 注释等）误判为下一个文件头，整包被当作 multi-file 拒绝；`--- ` 中断条件改为仅当与下一行 `+++ ` 成对出现（文件头对）才触发
  - 修复被拒绝的 diff 被 FIFO 淘汰（上限 50）后 `write_file`/`insert_code`/`delete_code`/`search_in_files` 误报"写入成功"：`DiffResolutionReason` 新增 `rejected` 终态，淘汰时对 rejected 留痕，工具改为按 `interruptReason === 'none'` 判定接受
  - 修复 ChatFlowService 主流程 `markUserInterrupt` 与 `resetUserInterrupt` 之间无 try/finally：中途抛错全局中断标记残留，无会话 diff 被误取消；现在重置放入 finally（与 delete 路径一致）
  - 修复 MessageRouter 非阻塞消息异常兜底先删路由条目再发错误导致错误必然错投主聊天、Monitor 面板请求永久挂起；现在先 `sendRoutedError` 再清理，回退路径也补删条目防 `requestClients` 无界泄漏
  - 修复流式处理器构造时捕获 view 引用：视图重建后 chunk 发往已销毁 webview，新视图永远收不到 complete/cancelled、占位消息永久"生成中"；改为每次发送前实时获取 view
  - 修复 `deleteConversation` 不清理孤儿数据：snapshots/ 与 diffs/ 残留孤儿；现在删除对话时一并清理快照与 diff 目录，`cleanupOrphanedDiffs` 不再把 `__global__` 全局 diff 目录连带删除
  - 修复 `search_in_files` replace 模式漏传 `replace` 参数时替换串为空、静默删除所有匹配内容的问题：replace 模式下参数缺失直接报错
  - 修复 `execute_command` 用 `shell.includes('cmd')` 判断 shell 类型（自定义 shell 路径目录名含 cmd 误判）与相同 toolId 并发执行覆盖 `activeProcesses` 条目（旧进程成孤儿无法取消）；改为按 shell 文件名精确匹配，覆盖前先终止仍在运行的旧进程
  - 修复 `list_files` Windows 递归返回 `\` 分隔路径与其余工具 `/` 约定冲突、回传给 read_file 时解析失败的问题
  - 修复 `SettingsManager.getToolsConfigEntry` 浅合并导致用户手写部分配置整体替换嵌套默认对象的问题：改为递归深合并（数组与原始值仍直接覆盖）
  - 修复 `getHistoryForAPI` 在 startIndex ≥ history.length 时返回完整历史而非空历史的问题
  - 修复 `DiffEditorActionsProvider` 从翻译后的 label 文本正则提取块索引（翻译含数字时可能确认错误块）：改为 QuickPick 项结构化携带块索引
  - 修复快照 ID 用 `Date.now()` 同一毫秒内连续创建互相覆盖的问题：追加随机后缀保证唯一
  - 修复检查点增量哈希复用漏检：`mtimeMs + size` 在毫秒精度内同秒等长修改不触发重算；新增纳秒精度 `mtimeNs` 比较（旧记录回退旧行为）
  - 修复 Gemini 流式 URL 拼接未处理 baseUrl 已有 query 参数的问题（生成畸形 URL）；非流式解析对 `content` 缺失的候选直接 TypeError（流式路径已判空）
  - 修复 Anthropic `message_delta` 的 usage 只含 output_tokens 时 `totalTokenCount = 0 + output` 覆盖 message_start 的正确 total、输入 token 从总量中消失的问题：无 input 侧计数时不输出 total，累加器走重算路径
  - 修复 `delete_file` 根目录防护可被 Windows 大小写变体绕过（盘符/目录大小写不一致时大小写敏感比较不命中、递归删除整个工作区）：根路径比较改用路径规范化（Windows 折叠大小写 + 去尾斜杠），并在 handler 内实时获取工作区集合
  - 修复 `rejectAllPendingToolCalls` / `settleFunctionResponses` 直写仓储绕过互斥执行器、真实工具结果仍被“用户拒绝”占位覆盖的竞态：`replaceContents` 纳入 exclusive（内部拆 `saveAndReload` 防锁嵌套），两个函数整体改走 `mutateContents` 串行域
  - 修复 `setTitle` / `setWorkspaceUri` 整对象元数据覆写未加锁：与 `setCustomMetadata` 并发时会把 custom 对象整体冲掉；现在统一走 per-conversation 写锁
  - 修复中止路径写回与 `rejectAllPendingToolCalls` 占位竞争导致真实工具结果被丢弃：abort/等待取消路径改用 `settleFunctionResponses`（真实结果覆盖占位），补齐多模态附件与 stop state 结算；等待提前执行工具的循环与 abort 事件做 race，消除工具不响应信号时的永久挂起窗口
  - 修复 Anthropic 流 total 仍缺输出 token：`message_start` 的 total 只含 input，`message_delta` 的 output 增量现在会合并进总量，下游上下文裁剪/汇总的 `total−prompt` 不再恒为 0
  - 修复 `execute_command` 同 toolId 并发时旧进程 close/error 处理器无条件删除同 key 条目、把新进程变孤儿的问题：预杀分支立即注销旧任务并摘除旧条目，close/error 处理器加身份校验；`success` 前置 `!timedOut`，消除 close(code=0) 晚于超时回调时“成功 + timed out”自相矛盾
  - 修复 retry / edit-and-retry / delete-to-message 三条流程的 `markUserInterrupt` 无 try/finally：中途抛错全局中断标记残留，无会话 diff 被误取消；现在重置统一放入 finally
  - 修复 `summarizeContext` 的 `deleteSummary` 未传控制器引用：同一会话两个总结流交叠时旧者 finally 误删新者控制器、新流无法取消；现在传控制器引用做身份校验
  - 修复 diff 自动保存分支 3 的 `doc.save()` 与 `writeFileSync` 之间无状态复查：取消/拒绝后 AI 内容仍可能被写回磁盘；现在写盘前补 `diff.status` 复查
  - 修复 `evictedRejectedDiffIds` 随会话无界增长：淘汰留痕只对仍有活跃等待者的 rejected diff 生效（新增 `activeDiffWaiters` 登记）
  - 修复 unified diff hunk 内相邻“删除行 `-- ` + 增加行 `++ `”仍被误判为文件头对、整包拒绝的问题：文件头对要求后跟 `@@` 才触发中断
  - 修复历史迁移与删除绕过写队列：`migrateLegacyConversationsToSegmented` 与 `deleteHistory` 与 `saveHistory` 共用同一 per-conversation 写队列，消除迁移/删除与并发写互相干扰（删除后目录被复活、tmp 目录被误删）
  - 修复 checkpoint cleanup 对完整链恒为 no-op、`maxCheckpoints` 静默失效的问题：删除链上中间节点前先把其备份合并进后继（不覆盖后继已有文件）、changes 合并、base 重挂，再删除
  - 修复取消流从未收到 usage 事件时（OpenAI chat/Gemini）整条 model 消息被跳过漏计的问题：`estimatePartialMessageTokens` 在 usage 缺失时也按文本长度估算（含 functionCall 参数）
  - 修复 fast-tavern Python `process_content_stages` 调用 `apply_regex` 时漏传 `variableContext`：`{{getvar::...}}`/`{{setvar::...}}` 在 replaceRegex 场景端到端仍失效；现在与 TS 调用方对齐透传
  - 修复 Gemini 空候选报错信息不具体：非流式解析对 `content` 缺失的候选抛笼统错误，现在显式报出 `finishReason`（新增 `emptyCandidate` 三语言词条），内容安全拦截等场景可直接看到真实终止原因
  - 修复 Anthropic `count_tokens` URL 归一化顺序：baseUrl 形如 `.../v1/models/complete` 时先处理 `/v1/models` 会残留 `/complete` 后缀、拼出畸形端点 URL；现在先去掉 `/complete` 再规整 `/v1/models`
  - 修复分段历史原子提交的临时路径类型错误：`getHistoryDir(...) + '.tmp'` 把 Uri 对象与字符串拼接成字符串后直接传给 `workspace.fs`（createDirectory/delete/writeFile/rename），扩展宿主按 UriComponents 重新解析抛 `[UriError]: Scheme contains illegal characters`，导致新建对话/保存历史失败（新建对话闪一下无变化、旧对话发消息报错）；改为 `Uri.joinPath` 构造真正的 Uri 对象，新增回归测试 `storageSegmentedWrite.test.ts`（锁定所有 workspace.fs 路径参数必须是 Uri 对象）
  - 修复 `validateFileInWorkspace` 对 workspaceUri 的裸 `Uri.parse`：非法 URI（如旧格式 Windows 路径）抛 UriError 被外层 catch 吞成 `UNKNOWN` 错误码，或把 `C:\...` 误解析成 `scheme='c'` 导致合法文件被误判为「属于其他工作区」；现在 Windows 盘符路径按 `Uri.file` 语义解析，解析失败时跳过归属比对（不误杀合法文件）
  - 修复会话元数据读改写互相覆盖：`setCustomMetadata`/`setTitle`/`setWorkspaceUri` 与各存储适配器 `saveHistory` 内部的 updatedAt 更新此前在两条独立串行链上，并发时后写者基于旧 meta 的整体写回会把先写者的 custom 字段覆盖（检查点列表/裁剪状态随机丢失）；现在 `storage.ts` 新增模块级 `withMetadataWriteSerialized` 共享链统一所有元数据读改写，`ConversationManager` 新增 `updateCustomMetadata`（链内「读 meta→updater→无变更跳过写回」，updater 支持异步）
  - apply_diff 匹配失败报错增强：oldContent 找不到时不再只说「请核实内容」，新增最近似块诊断——在文件中定位与 oldContent 最接近的行块，逐行报告差异（含首差异字符列与期望/实际内容片段），帮助快速定位全角/半角、空格、缩进或内容已变等问题；块首行不匹配时自动尝试后续行作锚点，超长块/超大文件自动跳过诊断避免 O(m×n) 扫描卡死；结构化 hunk 与 legacy search/replace 两条失败路径均接入
  - 修复 CheckpointManager 全部 7 处「读列表→内存改→整体写回」竞态：并发创建互相覆盖记录、并发删除/裁剪互相丢失；全部迁移到 `updateCustomMetadata`，删除类操作在链内算好保留集合、写回成功后才删磁盘目录（竞态窗口收敛）
  - 修复 `normalizeHistoryForDisplay` 锁外写回覆盖真实工具结果：`getMessages`/`getMessagesPaged` 的补齐流程基于旧快照整体写回，与工具结果并发落盘互相覆盖；现在整个读-改-写移入仓储互斥执行器，`TranscriptRepository.mutateContents` 新增「返回原引用=跳过写回」无变更契约（无未响应调用时不再每次读历史都写一次盘）
  - 修复 `addContent` 去重锁外执行导致同一 tool_use_id 出现两条 functionResponse：去重+追加整体移入 `mutateContents`，取消流与工具执行循环之间的竞态安全网恢复有效；同步修复契约上线暴露的 9 处「原地修改+返回原引用」mutator（appendContent/addBatch/updateMessage/updateMessagesBatch/insertMessage/insertContent/deleteMessagesInRange/rejectAllPendingToolCalls/settleFunctionResponses）改为有变更时返回新引用
  - 修复 MemoryManager.updateEntry 越界写垃圾记录：`logLen()` 校验与 `logGet` 读取在锁外执行，并发 `truncateLog`/`logAppend` 改变日志长度后基于过期 id 的写入越过 EOF；校验与读取移入锁内
  - 修复 `getStats` 对缺 `data`/`mimeType` 的 inlineData 抛 TypeError：旧版本或手动编辑的历史不再导致统计面板/上下文裁剪入口崩溃
  - 修复代理 CONNECT 隧道流式解码损坏中文：`decodeChunkedStream` 逐 chunk `toString('utf8')` 把被 TCP/chunk 边界切开的 UTF-8 多字节字符在第一个包固化成 U+FFFD，后续 SSE 行 `JSON.parse` 永远失败；现在只收集原始字节，由流式 `TextDecoder` 跨 chunk 拼接解码，循环结束 flush 尾部字符
  - 修复代理取消被误判为可重试：`fetchWithProxy`/`sendRequestOverSocket` 的取消 reject 普通 Error，ChannelManager 只认 `AbortError` 导致取消变无谓重试；新增 `createAbortError` 统一 6 处取消错误，CONNECT 握手成功后移除旧 abort 监听避免重复取消
  - 修复重试等待窗口内发送保活请求：重试路径 delay 前未停 keepAlive 定时器，错误后到 delay 完成之间在无活动流时发出保活请求；现在 delay 前先 clearInterval
  - 修复 OpenAI strict 工具混用被 API 400 拒绝：任一工具 strict 时 OpenAI 要求全部工具 strict，混用显式发送 `strict: false` 被拒；现在整体降级为不启用
  - 修复 directApplyAndSave 把编辑器旧缓冲区写回磁盘覆盖 AI 内容且 diff 永久 pending：dirty 文档 `openDoc.save()` 会把旧内容+用户未保存编辑写回磁盘，且 `saved` 提前 return 跳过 finalizeAcceptedDiff；现在先写盘，再用 WorkspaceEdit 静默替换编辑器内容为 AI 内容并 `save()` 清理 dirty（内容与磁盘一致，保存无害）——早期方案用 `workbench.action.files.revert`，但文档 dirty 时会弹 VS Code 原生确认框阻塞整个 diff 流程，已弃用
  - 修复关标签页不收敛 accepted、diff 永久 pending：磁盘已是 AI 内容（files.autoSave 直接落盘）时关闭标签页既不接受也不拒绝；现在内容相等收敛为接受
  - 修复 legacy 多 diff 行号偏移累积：`start_line` 相对原始文件，前序 hunk 改变行数后后续 hunk 整体错位；三处 legacy 应用路径新增 lineDelta 累计
  - 修复 glob 元字符未转义抛 SyntaxError：`matchGlobPattern`/`shouldIgnore` 只转义 `.`，配置含 `[`/`(`/`+`/`?` 时 `new RegExp` 抛错中断动态上下文生成；改为整体 `escapeRegExp` 后再做通配替换，并修复斜杠替换在星号替换之后导致 `[^[/\]]` 通配永不命中的顺序缺陷
  - 修复 fsPath 大小写敏感比较失效：diffManager 11 处 `fsPath ===` 严格比较在 Windows/macOS 上因大小写变体路径失效导致监听器/文档查找失灵；新增 `sameFsPath`（win32/darwin 折叠大小写，Linux 精确）
  - 修复分段存储 delete+rename 提交窗口与无读重试：删旧目录→rename 期间并发读可能看到 index 在但段文件消失；现在写前清理 tmpIndexPath 残留、提交改 overwrite rename、`loadHistoryWithStatus`/`loadHistoryPage` 对 not_found/io_error 重试一次（50ms）
  - 修复 cancelTask 提前删任务丢终态事件：abort() 后立即删任务+发裸 cancelled，完成路径的 `unregisterTask` 变 no-op、前端任务条卡在「已取消但无结果」；现在只 abort，终态由各完成路径统一发出（已核对 terminal/media 全部取消路径）
  - 修复终端输出无内存护栏：长运行进程持续输出内存无限增长；新增 `MAX_RETAINED_OUTPUT_LINES = 50000` + `pushOutputLines`（超限丢最旧并计数），截断提示用 `output.length + omittedOutputLines` 总量
  - 修复 search_in_files / FilePickerPanel / AnnouncementModal 三处 v-html 注入：搜索结果上下文、文件路径、changelog 正文未转义直接注入 HTML，工作区文件内容含 `<`/`>`/`&` 或恶意 HTML 时可执行任意脚本（远程代码执行级风险）；现在统一先 `escapeHtml` 再做高亮/markdown 标记替换
  - 修复中文/日文输入法合成回车误发消息：InputBox 无 IME 守卫，按 Enter 确认候选词触发发送逻辑误发半截消息；现在 `isComposing`/keyCode 229 直接 return
  - 修复批注消息发送失败不回滚：ToolMessage 先 push 用户批注再发送，失败时批注残留成幻影消息、前端索引与后端错位、重试会再插一份；现在失败按 id 回滚
  - 修复 apply_diff / write_file 大文件 diff 预览卡死：computeLCS 全量二维 DP，数千行 diff 占数百 MB 内存并阻塞 webview 主线程；现在公共前缀/后缀剥离 + 核心区域超过 100 万跳过 DP
  - 修复 isLoadingMore 切标签页后永久禁用：复位在 tabId 匹配分支内部，加载期间切走标签页后上拉加载被永久跳过；现在 finally 无条件复位
  - 修复消息列表 UI 状态组件级丢失：uiStateByTab 是组件实例级 Map，空会话过渡卸载组件后滚动位置/展开状态全丢；现在提升为模块级保存
  - 修复切会话清空排队消息：switchConversation 无条件清空 messageQueue，排队消息被静默丢弃；现在只清理附件，跨会话消息由队列匹配跳过机制处理
  - 修复跨会话消息卡队头：processQueue 取到不属于当前会话的消息放回队头并中止，该消息永久阻塞队列；现在改为查找第一条属于当前会话的消息
  - 修复关标签页不取消流 + 废弃缓冲累积：closeTab 不取消该会话仍在进行的流，后续 chunk 为已关闭会话重建缓冲区且无消费者，反复开关页无限累积；现在关页时按 conversationId 取消流，缓冲对已关闭会话直接丢弃不重建
  - 修复消息 timestamp 被完成时刻覆盖：四个流式 handler 用 `{...message, ...finalMessage}` 展开，finalMessage 的 timestamp 是完成时刻导致时间戳漂移、排序错乱；现在补 timestamp 保留
  - 修复消息订阅者单点崩溃：一个订阅者抛异常中断其余订阅者（backgroundTaskStore 收不到同一条消息）；现在每个订阅者单独 try/catch
  - 修复 Markdown 渲染缓存无界增长：codeHighlightCache/fileExistenceCache/imageCache 无上限，长会话持续增长；现在统一 `setCached` 容量 500 FIFO 淘汰
  - 修复 ChatViewProvider.dispose 不重置 _view：_view 仍指向已销毁 webview，重开面板后 diff 状态/终端输出等事件永久丢失；现在 dispose 置空
  - 修复 pendingCommands 无上限：面板长期未打开期间反复触发命令队列无界增长、打开后一次性重放陈旧命令；现在上限 100
  - 修复 sendError 对非 Error 对象取 message 得 undefined：改为 instanceof 判断回退 String(error)
  - 修复 webview 已死路由判定失效：已销毁 webview 的 postMessage resolve(false) 而不抛异常，调用方误判成功跳过回退路径、响应静默丢失；现在注册表按 isAlive 判定存活，SubAgentMonitorPanel 注册绑定 panel 实例
  - 修复流 chunk 不按 clientId 路由：所有流都发往主聊天，monitor 面板发起的流错投；现在 `getClientView(clientId)` 按注册表路由
  - 修复 requestClients 泄漏：请求结束不清理 requestId→clientId 映射；现在 4 个流式 handler 的 finally 与取消路径统一 finalizeRequest
  - 修复 showDiffView 未入串行队列：与 accept/reject 动作并发时状态互相抢占；现在包 `runDiffActionSerialized`（原实现改 showDiffViewUnlocked）
  - 修复被淘汰 rejected diff 墓碑 Set 无界增长：evictedRejectedDiffIds 随会话无限累积；现在容量上限 2000 FIFO 淘汰
  - 修复 fast-tavern Python 与 TS 语义差异：assemble_tagged_prompt_list 的 NaN/bool 通过 isinstance 过滤导致 int(nan) 抛 ValueError；history/factories 的 str(text or "") 把 0/False 变空串；convert_from_silly_tavern 的 isinstance(v, int) 漏 float 且 bool 误判；normalize_worldbooks 的 _to_number 未对齐 Number() 且 index/probability int 截断（2.5 与 2 是不同键）；apply_regex 的 macroMode 缺失被当 none（TS 缺失=执行替换）且 {{}}/<<>> 替换顺序与 TS 相反；variable_context 的 float(None) 抛错使已存 null 走字符串拼接；get_active_entries 的 recursionLimit/index/order 数值强转抛 ValueError/TypeError/丢小数——全部对齐 TS 语义（build_prompt 对应文件已随重构移除，不适用）

### Changed
  - `StreamChunkProcessor` 构造从持有 view 引用改为持有 `getView` 回调，视图重建后消息自动发往新视图
  - `TranscriptRepository` 支持注入互斥执行器（`exclusive`），`mutateContents` 的 get→mutate→replace 整体串行化
  - fast-tavern Python 版 `apply_regex` 对齐 TS 版：替换结果中的 `{{user}}`、`{{getvar::...}}`、`{{setvar::...}}` 等宏立即展开，并透传 `variableContext`
  - SubAgent Monitor 流式卡顿优化：前端 `llm_delta` 事件改为非响应式队列 + rAF（setTimeout 兜底）批量 flush，事件回调从「每 chunk 全量更新 manifests/windowsByRunId + renderMessages 全量重建」降为 O(1) 入队、每帧至多一次合并提交；renderMessages 按 content/overlay 引用缓存 Message 对象，未变化的楼层不再触发 MessageItem 重渲染（连带避免重复解析 Markdown），流式更新成本与窗口长度解耦；前端事件数组加 500 条上限（与后端 journal 对齐）；后端 SubAgentMonitorPanel 对 `llm_delta` 做 50ms 节流合并，跨进程 postMessage 次数与渲染帧率对齐而不是与 token 产出速度对齐，并发 SubAgent 下 Monitor 不再卡顿
  - SubAgent 默认限制放宽：迭代次数默认 20 → 50（预设 30~40 → 40~80），运行时间默认 300s → 1800s（预设 600~900s → 1200~2400s），同步更新设置面板默认显示值、工具描述与类型注释；复杂任务不再频繁触顶「超出最大迭代次数 / 运行时间」

### Added
  - 新增回归测试：`formatterParallelTools.test.ts`（Anthropic 并行工具参数按 index 合并、OpenAI Responses done 覆盖增量）与 `h1_deadlock.test.ts`（≥2 条记忆编辑不死锁）
  - 修正 4 处 limcode→graycode 改名遗留的过期测试断言（`show_windows_notification`、`create_progress`、`diffManager`、`PromptManager.promptEntries`）

## [1.2.8] - 2026-07-30

### Changed
- **品牌更名**：LimCode → GrayCode。扩展 ID 由 `limcode` 改为 `graycode`。所有 VSCode 命令已更名（`limcode.*` → `graycode.*`），配置命名空间已变更（`limcode.*` → `graycode.*`）。从旧 LimCode 导出的 JSON 文件导入时会自动迁移。
- `DiffHandlers.ts` 中 `buildPreviewContentsFromUnifiedPatch` 的 `flush()` 优化：只在 hunk 有实质内容时才追加空行分隔，减少预览中的多余空行
- 工具设置页面新增工具名称和描述的中文/日文翻译：42 个工具的名称和描述现在会根据界面语言切换显示，覆盖文件和目录操作、终端命令、代码智能、媒体处理、TODO、设计/计划/进度/审查文档、历史搜索、Windows 通知、永久记忆等全部工具
- 记忆设置页面新增 4 个运行时参数配置项：wakeLines（唤醒输出行数）、entryChars（单条记忆最大字节）、partChars（分页最大字符数）、partLines（分页最大行数），用户可直接在设置界面调整记忆系统的输出格式和容量，无需通过 AI 工具
- MemoryToolConfig 类型扩展，新增 wakeLines / entryChars / partChars / partLines 可选字段，默认值与 DEFAULT_MEMORY_CONFIG 对齐
- getMemoryConfig / updateMemoryConfig 处理器合并 MemoryManager 运行时配置：读取时自动合并文件系统的运行时参数，保存时同步到 MemoryManager（若已初始化）

### Fixed
  - 修复 `read_file` 等工具返回给 LLM 时文件内容反斜杠被二次转义的问题（`\` → `\\`），根因在 `anthropic.ts` / `openai.ts` / `openai-responses.ts` 三个 formatter 中对 `functionResponse.response` 统一做了 `JSON.stringify`，导致 JSON-in-JSON 嵌套编码。现改为共享的 `serializeToolResultForLLM` 函数，大段文本内容原样透出，元数据用纯文本前缀。修复后 AI 在 `apply_diff` 等工具中不再因反斜杠翻倍而写出错误的转义序列
  - 修复 `apply_diff` 前端组件中 diff 块失败原因被 CSS 截断不显示的问题：`.error-msg` 移除 `max-width: 200px` + `text-overflow: ellipsis` + `white-space: nowrap`，失败原因完整展示；失败 diff 块新增错误摘要区直接显示具体失败原因，不再只有参数预览
  - 修复加载历史对话时前端工具调用卡片显示状态不正确、搜索结果缺失的问题：根因是前端 `toolResponseIndex`（functionResponse.id → 消息下标 O(1) 索引）在历史加载路径（`loadHistory` / `loadOlderMessagesPage` / `switchConversation` / tab 恢复 / 检查点回档 / 重试重载）中未被重建，导致 `getToolResponseById()` 始终返回 null，工具卡片无法匹配到对应的 `functionResponse` 数据。修复方式为在以上路径的 `allMessages.value` 直接赋值后统一调用 `rebuildMessageIndexById(state)` 重建索引
  - 修复 `serializeToolResultForLLM`（Anthropic/OpenAI function_call 模式）三处信息丢失：(1) 错误分支遇到 `response.error` 时只返回简短错误文本，丢弃了 `data.output` 等诊断信息，导致 AI 只看到 "Command exited with code 1" 而看不到具体 stderr；(2) `data.results` 数组分支只序列化 `data.results` 而丢弃了 `data` 中其他元数据（`count`/`filesModified`/`skippedFiles`/`queryFallback` 等），AI 看不到搜索结果摘要；(3) `formatResultItem` 无条件删除每项 `success` 字段（注释称"顶层已有"），但单文件失败状态被顶层 `success: true` 掩盖，AI 看不到具体哪个文件出错。修复：(1) 错误分支附加 `data.output`；(2) results 分支改为 `JSON.stringify(data)` 保留完整元数据；(3) per-item `success: false` 时标记 `FAILED`；同时将 `lineContent`/`context`/`output` 加入 `TEXT_CONTENT_KEYS`，移除误删 `type` 字段的逻辑

### Added
  - `apply_diff` 结构化 hunk 匹配失败时新增转义诊断（`detectEscapeIssues`）：当 `oldContent` 包含字面 `\n` / `\t` / `\"` 序列时，错误消息自动追加诊断提示，帮助 AI 识别 JSON 参数中的过度转义
  - 新增 `toolResponseFormatter.ts` 共享序列化模块，统一处理工具响应到 LLM 消息的格式化，避免各 formatter 各自 stringify 导致行为分叉
  - 记忆系列工具（memory_wake / memory_note / memory_recall / memory_compress / memory_zoom / memory_forget / memory_config）前端自定义展示组件 `MemoryResult.vue` 重构：展开工具卡片后同时展示模型传入的参数（Parameters 区）和工具返回的文本结果（Result 区），区分原始记忆块与摘要块的颜色，展示统计标签（Memories / Hits / Part / ID / Removed 等）；移除硬编码 max-height 限制，内容完整可见
  - `memory_forget` 新增原始记忆截断模式：传入单个数字 ID（如 `"0"`）可截断原始 LOG，删除 ID >= 该值的所有原始记忆及关联树摘要；传入范围 ID（如 `"16-31"`）保持原有仅删摘要行为。`MemoryManager` 新增 `truncateLog(keepId)` 方法支持物理截断固定宽度记录文件
  - 记忆设置页面新增「Raw Memory Entries」管理面板：用户可直接查看所有原始记忆条目（ID / 日期 / 文本），支持原地编辑单条记忆文本（后端 `MemoryManager.listEntries` / `updateEntry` 新增固定宽度原地覆写能力），编辑后自动清理相关树摘要

## [1.2.7] - 2026-07-28

### Added
  - 永久记忆系统（OptMem）：AI 跨会话自动记住约定、决策和知识，每次新会话开始时通过 `memory_wake` 自动恢复记忆上下文；记忆以追加式日志 + 二叉树摘要存储，旧记忆智能压缩为摘要节省 token
  - 新增 7 个记忆工具：`memory_wake`（唤醒记忆）、`memory_note`（记录记忆）、`memory_recall`（正则搜索记忆）、`memory_compress`（执行压缩合并）、`memory_zoom`（展开树节点）、`memory_forget`（丢弃错误摘要）、`memory_config`（查看/修改参数）
  - 新增 `MemoryManager` 核心引擎（`backend/modules/memory/`）：TypeScript 原生实现的固定宽度记录存储、二叉树 cover 算法、分页输出、异步锁并发控制，完全兼容 OptMem 数据格式
  - 新增 `{{$MEMORY}}` 系统提示词模板变量：在内置 DEFAULT 和 CODE 模板中默认引用，用户可在 设置 → 记忆 中自定义记忆使用说明，或在提示词设置中删除此变量以关闭记忆系统
  - 新增记忆设置页面（设置 → 记忆）：可视化编辑自定义记忆提示词，保存/重置按钮，MemoryToolConfig 类型持久化到 `graycode.toolsConfig.memory`
  - 提示词设置「插入变量」列表新增 `{{$MEMORY}}`（静态分组）
  - 记忆数据默认存储在 `globalStorage/memory/`，随 GrayCode 自定义存储路径迁移
  - 新增 MemoryManager 初始化集成（ChatViewProvider.initializeBackend 步骤 25.6）

### Fixed
  - 修复消息列表滚动到顶部后无法加载更早消息的问题：`hasMore` 条件只看后端是否还有数据，忽略了前端已加载但未渲染的消息；`loadMore()` 在后端无更多数据时直接 return，导致 `visibleCount` 永远不增长。现拆开前端渲染展开与后端分页加载两个步骤，即使全部消息已在内存中也能正常展开渲染
  - 修复 `insert_code` 和 `write_file` 工具结果中文件路径不可点击跳转的问题，补充 `clickable` 样式和点击事件，与其他文件工具（delete_code、read_file、apply_diff 等）行为一致

## [1.2.6] - 2026-07-27

### Added
  - SubAgent 对话延续：主模型调用 `subagents` 工具时可传入 `continueFromRunId` 参数，将新子代理接续到之前已完成子代理的对话上，新子代理自动继承旧 run 的完整 transcript（对话历史），实现跨调用的对话接力；对仍在运行中的旧 run 会拒绝延续并返回明确错误
  - 新增 StreamAccumulator 回归测试（`backend/__tests__/channel/streamAccumulator.test.ts`，覆盖结构修订号递增语义 / 完成工具调用 id 去重 / prompt 模式分片块解析 / thought 文本不解析 / 未闭合块 flush，9 用例）与 xmlFormatter 解析测试（`backend/__tests__/tools/xmlFormatter.test.ts`，tool_name 形态容错 / 带属性参数节点，5 用例）
  - 新增用量统计页面：从已落盘对话历史回溯聚合 token 用量，支持总览 + 按对话 / 按模型 / 按日期三个维度，包含 CSS 条形图可视化；入口位于历史页头部图表按钮
  - 用量统计页新增 VSCode 视图标题栏入口（`graycode.showUsage` 命令 + graph 图标按钮，位于历史与设置之间），不再只能从历史页右上角的隐藏入口进入
  - 用量统计页新增时间范围筛选（全部 / 今天 / 近 7 天 / 近 30 天），后端 `aggregateUsageStats` 支持按消息时间戳过滤（`UsageStatsOptions.startTime/endTime`），总览与三个维度均为筛选后口径；筛选激活时缺失时间戳的消息不参与统计
  - 用量统计页新增成本估算：「按模型」维度可就地配置模型单价（美元/百万 token，思考 token 按输出价计），行上显示单模型估算成本，总览卡片显示总估算成本；单价持久化在 `ui.usagePricing`，随设置导出/导入一同迁移
  - 用量统计页「按对话」维度支持点击行直接打开对应对话并返回聊天视图
  - 新增后端用量聚合器 `usageStats.ts`，从 model 消息的 `usageMetadata` 提取输入/输出/思考 token，兼容旧字段格式，单对话读取失败自动跳过不影响整体
  - 新增 `UsageHandlers` webview 处理器，注册 `usage.getStats` 消息
  - 新增用量统计聚合的后端单元测试（`backend/__tests__/conversation/usageStats.test.ts`，覆盖聚合正确性 / 旧字段兼容 / 读取失败跳过计数 / 双边与单边时间范围筛选，共 5 个用例）
  - 用量统计页三语 i18n（zh-CN / en / ja）
  - 文件工具卡片（apply_diff / write_file / insert_code / delete_code / read_file / delete_file）文件名与路径支持点击跳转到编辑器；insert_code 和 delete_code 还会自动定位到插入/删除行并高亮
  - 新增文件跳转公共 composable `useOpenWorkspaceFile`，封装 `openWorkspaceFile` / `openWorkspaceFileAt` 扩展桥接
  - Anthropic 渠道新增 Prompt Caching 缓存 TTL 选择（5 分钟 / 1 小时），可在渠道设置中选择缓存保持时间；1 小时 TTL 写入价格为 2x 基础输入价格
  - Anthropic 渠道新增 Prompt Caching 缓存保活开关（循环保活 + 退出保活）：当 TTL 为 5 分钟时，流式请求期间每 4 分 30 秒自动发送 max_tokens=5 的保活请求循环刷新 TTL；流正常结束且无工具调用时，若距请求开始已过 4 分钟则额外保活一次，防止用户下一轮输入时缓存刚好过期
  - Anthropic 渠道新增思考内容显示模式开关（隐藏 / 摘要），控制 API 响应中是否返回可见的思考内容；Opus 4.7+ 默认隐藏思考，选择「摘要」可恢复思维链输出；该开关与思考启用状态独立
  - Anthropic 渠道新增 xhigh 思考努力级别，位于 high 和 max 之间（Opus 4.7+）
  - OpenAI 兼容渠道新增 DeepSeek `user_id` 开关，用户可在渠道设置中显式启用，启用后主聊天请求会基于当前对话 ID 生成稳定且不包含隐私信息的 `user_id`，用于 DeepSeek KVCache 按对话隔离；默认关闭，避免误判中转或其他兼容服务
  - 新增设置导入/导出功能：可在设置 → 通用设置中将渠道配置、MCP 服务器、Skills 和 VSCode 设置导出为 JSON 文件，或从文件导入恢复；支持跳过已存在项和覆盖全部两种导入模式，导入时弹出覆盖确认对话框
  - 新增 `SettingsExporter` 后端模块（`backend/modules/settings/SettingsExporter.ts`），负责收集导出数据（VSCode 设置、渠道配置、MCP 服务器、Skills）并序列化/反序列化，排除对话历史与检查点
  - 设置导入/导出支持设置页「通用设置」按钮和命令面板（`graycode.exportSettings` / `graycode.importSettings`）两种入口
  - 新增设置导入/导出三语 i18n（zh-CN / en / ja）
  - 新增 `settings.export` / `settings.import` webview 消息处理器，前端按钮通过消息桥接调用扩展端文件对话框与导出/导入逻辑
  - 类型安全渐进启用：tsconfig 新增 `strictNullChecks` + `alwaysStrict` + `noImplicitThis` + `strictBindCallApply` + `strictFunctionTypes` + `noFallthroughCasesInSwitch`，backend + webview 零严格错误
  - 大段提示词模板从 `backend/modules/settings/types.ts`（2675 行）拆分到独立的 `promptModes.ts`，类型文件只保留类型定义与 re-export，旧 import 路径 100% 兼容
  - 新增 i18n 语言包 key 一致性校验测试（`backend/__tests__/i18n/languageParity.test.ts`），递归比对 backend + frontend 各三份语言文件的 key 集合与 `{placeholder}` 占位符
  - 新增渠道 formatter 核心解析测试（`backend/__tests__/channel/formatterParsing.test.ts`），覆盖 OpenAI / Gemini / Anthropic 三个 formatter 的 parseResponse / convertTools / 非法响应报错（13 个用例）
  - 前端构建新增 `vue-tsc --noEmit` 类型检查步骤（`pnpm run build:frontend` 自动执行），根 package.json 新增 `typecheck` 脚本
  - 引入 esbuild 打包方案（`esbuild.config.js`），扩展入口 `extension.ts` → `dist/extension.js` 单文件 bundle（2.1 MB），node-notifier 作为 external 保留原生文件；vscode:prepublish 与 compile 脚本指向 esbuild
  - 新增工具参数规范化统一入口 `normalizeToolArgs`（`backend/tools/coerceToolArgs.ts`）：单数别名提升（模型误传 `path` 自动转为 `paths: [...]`）、递归嵌套类型容错（`files[].line: "5"` 等嵌套字段也能修正，兼容 Python 风格 `"True"/"False"`）、未知参数剥离；所有自动纠正通过 `parameterWarnings` 字段随工具结果回传，帮助模型在后续调用中自行修正参数写法
  - search_in_files 新增 `caseSensitive` 参数（search 默认不区分大小写、replace 默认区分，可显式覆盖）；replace 模式 0 命中时返回 `zeroMatchHint` 诊断提示两种模式的大小写语义差异，终结“search 搜得到、replace 替不了”的困惑
  - prompt 模式（JSON/XML）工具调用解析失败反馈：有完整边界标记但解析失败的块不再静默降级为普通文本，而是转为携带具体语法错误的合成调用，模型能收到可读的失败原因并重试（含意图工具名提取）
  - JSON 工具调用宽松解析：严格解析失败后自动修复模型高频语法错误（字符串值内的裸换行/制表符、尾逗号）后重试一次，减少细小瑕疵导致整个调用丢失
  - XML 工具模式 CDATA 支持：提示词新增 CDATA 用法说明与代码示例，历史重放时含特殊字符的参数自动 CDATA 包裹（含 `]]>` 分段处理），写入代码类内容不再因 `<` `>` `&` 解析失败
  - 只读工具并行执行：`ToolDeclaration` 新增 `readOnly` 标记（read_file / list_files / find_files / get_symbols / goto_definition / find_references / history_search / read_skill），同一批调用中相邻的只读工具 Promise.all 并行，降低多读取/搜索调用的累计延迟；写类、MCP 和需确认工具保持严格串行
  - 新增同参数重复失败调用护栏 `RepeatedCallGuard`（turn 级别）：相同 name+args 连续失败 2 次后第 3 次相同调用短路返回“换个思路”提示，不再真实执行；成功的重复调用（重跑测试等）完全不干预，阻止小模型烧完 maxIterations 的失败循环
  - 新增工具调用链路测试：`promptToolParser.test.ts`（宽松解析/失败反馈/CDATA/类型保护 12 用例）、`repeatedCallGuard.test.ts`（7 用例）、`diffReviewConfirmation.test.ts`（确认语义 14 用例），`coerceToolArgs.test.ts` / `validateToolArgs.test.ts` 同步新契约
  - 工具参数校验升级为递归校验（`validateToolArgs` 重写）：required 与类型检查深入 array items 和嵌套 object，错误带完整路径（如 `files[0].line`）；新增 enum 值校验，报错时附全部可选值（如 `must be one of "revision" | "progress_sync"`）；校验失败时回显从 schema 生成的 TypeScript 风格参数签名（Expected parameters），模型一轮即可修正参数结构；问题超过 10 条自动截断并提示剩余数量
  - 新增 SubAgent 运行事件总线测试（`backend/__tests__/tools/subagentRunEventBus.test.ts`，13 用例）：manifest 预览截断与超长单条消息不被完整拼接、事件 journal 有界与 llm_delta 不入 journal、`updateLastModelContent` 落盘一致性与 contentRevision 同步、连续写入合并且不丢内容、快照淘汰只作用于已终态且可恢复的 run（运行中与无持久化归属的 run 不被淘汰）
  - 新增 SubAgent 运行控制器测试（`backend/__tests__/tools/subagentRunController.test.ts`，7 用例）：暂停后挂起 / 继续返回 running、退出唤醒并返回 cancelled、反复暂停继续后唤醒列表必须为空、resume 重建 AbortController、暂停时长不计入活跃运行时间、非活跃 run 的控制操作一律失败
  - 新增 Monitor 窗口新鲜度判据测试（`test/unit/frontend/components/subagents/monitorWindowState.test.ts`，7 用例）：无窗口必拉、无 manifest 不拉、manifest 修订号领先判定过期、修订号相同不拉（纯状态事件不触发窗口请求）、本地 delta 领先时不回头拉旧窗口、条数领先仍判定过期、缺失协议字段按 0 处理
  - 新增扩展消息分类规则测试（`test/unit/frontend/utils/extensionMessageRouting.test.ts`，6 用例）：成功/失败响应兑现且不广播、兑现后摘除 requestId、无人等待的响应不得被当作推送消息广播、非对象与无 type 消息忽略
  - 新增事件载荷瘦身与落盘节流测试（补充进 `subagentRunEventBus.test.ts`，4 用例）：`content_snapshot` 只携带计数、journal 不再引用被替换的 contents 数组、节流窗口内连续变更只落盘一次、终态事件跳过节流并写入最新全量内容
  - 新增 SubAgent executor 终态收敛测试（`backend/__tests__/tools/subagentExecutorTermination.test.ts`，4 用例）：早退路径必须发出终态事件并返回 runId、run 结束后从活跃控制器注销、释放并发席位、清理超时轮询定时器不留下常驻 interval
  - 新增工具参数兼容别名通用机制：`ToolDeclaration.paramAliases`（纯改名别名，如 read_file 的 maxLine → endLine，自动改名 + 警告）与 `ToolDeclaration.compatParams`（语义透传参数，不写进 schema 向模型宣传但不被未知参数剥离，由 handler 解释语义），由 normalizeToolArgs 统一消化
  - 新增流式错误归一模块 `backend/modules/channel/formatters/streamError.ts`：把 Anthropic 的 `{ type: 'error', error: {...} }`、OpenAI / Gemini 的 `{ error: {...} }`、简化代理的 `{ error: '文本' }` 三种形态统一识别为 `ChannelError`，结构不认识但确实带内容时原样透出；只有能提取出非空文本才算数，正常 chunk 上的 `error: null` / `error: {}` 不会被误判
  - 新增回合信号桥接包装器 `backend/tools/abortLink.ts`（`withLinkedAbort`），统一处理「进入时父信号已中止」与「退出时摘除监听器」两件事
  - 流式缓冲区解析从 `ChannelManager`（1300+ 行）提取为独立模块 `backend/modules/channel/streamBufferParser.ts`：它是纯函数却埋在类里，既无法单独测试，也让「上游到底回了什么」这一层的行为难以推敲；新增 `unparsed` 字段承载流结束后仍解析不出的原始内容
  - 新增本轮修复的回归测试共 36 个用例：`streamErrorDetection.test.ts`（12，四个 formatter 的流内联错误识别 + 非流式 HTTP 200 错误体 + 正常 chunk 不误判）、`streamBufferParser.test.ts`（11，SSE / JSON 行 / 纯文本三类格式与 unparsed 语义）、`abortLink.test.ts`（5，含监听器不累积与抛出时仍摘除）、`pagedHistoryIntegrity.test.ts`（4，分段存储的悬空工具调用补齐与幂等）、`subagentRunEventBus.test.ts` 补充（4，runId 冲突分配）

### Changed
  - SubAgent transcript 落盘改为节流合并：每次内容变更都要「读整份 conversation metadata → 改 → 写回」，而 metadata 里装着该对话全部 run 的完整 contents，一个多轮子代理跑下来会把同一份大 JSON 反复 parse/stringify 几十次；现在内容类写入按 1.5 秒窗口合并，run 状态变更（含所有终态）仍然立即落盘，落盘次数与真实时间挂钩而不是与 token 产出速度挂钩
  - SubAgent Monitor 面板切到后台标签页时不再推送高频正文增量：`retainContextWhenHidden` 让面板隐藏后依然存在，于是每个流式 chunk 仍要走一遍 payload 清洗、manifest 派生、序列化和 postMessage，最终画在一个用户看不见的 UI 上；现在不可见时只丢弃 `llm_delta`（run 状态、工具状态等低频事件继续推送），重新可见时补推一次 manifest 让前端自行校准窗口
  - SubAgent Monitor 窗口刷新改为 revision 驱动：过去每个非 `llm_delta` 事件（含完全不改 transcript 的 tool_started/tool_completed）都强制重拉一次完整窗口，高频调用工具的子代理会把窗口请求打成风暴；现在以 manifest 的 `contentRevision`/`contentCount` 作为唯一新鲜度判据，真正变化时才拉取
  - 前端扩展消息分发改为单一全局分发器：过去每次 `onMessageFromExtension` 都往 window 挂一个独立监听器，十几个组件订阅后，流式期间每个 chunk 都要走十几遍相同的分类逻辑；现在只保留一个分发器，消息只解析和分类一次
  - SubAgent Monitor 顶部新增控制反馈与历史 run 只读标识：暂停/继续/退出失败时给出明确提示（后端同时回传该 run 是否仍被运行控制器持有，前端据此纠正按钮可见性），非活跃 run 显示「历史运行 · 仅可查看」徽标而不是让控制按钮整组无声消失
  - 后台子代理回流改为轻量卡片：后台任务完成后不再作为普通用户消息渲染，而是在对话中显示为带 `codicon-hubot` 图标和 "COMPLETED" 标签的紧凑卡片（左边框色条 + 浅色背景），与用户自己的消息视觉上明确区分；回执除元数据摘要（状态 / 步数 / 耗时）外仍内联子代理结果正文，超过 4000 字符时截断并提示剩余字符数与「可在 SubAgent Monitor 查看完整 transcript」
  - SubAgent Monitor 顶部控制按钮文案改为与实际动作一致的「暂停 / 继续」：原「中止」（实为 pause）容易与同排的「退出并让主工具失败」混淆，原「重试」（实为 resume）会让用户误以为会重跑整个 run，实际只是从暂停处继续同一个 runId

### Fixed
  - 修复 `execute_command` 的 `cwd` 参数在传入绝对路径时被 `path.join` 错误拼接到 workspace 根目录导致 "Working directory does not exist" 的问题：`cwd` 解析逻辑新增 `path.isAbsolute()` 判断，绝对路径直接使用不再拼接
  - 修复上游返回报错却只显示「模型返回空内容」的问题：这条链路上有三处都在丢信息。其一，OpenAI / Anthropic 两个 formatter 的 `parseStreamChunk` 完全不认流里内联的错误（Anthropic 官方的 `event: error`、兼容代理的 `{"error": {...}}`）——这类 chunk 没有 `choices`/`content_block`，被当成空块跳过，累加器什么也没累加；其二，上游用非 JSON 的纯文本或 HTML 报错（网关 502、代理的纯文本错误）时，缓冲区里的内容在流结束时被静默丢弃，只报一句「没有响应体」；其三，formatter 主动抛出的 `ChannelError` 被外层无条件重新包装成 `PARSE_ERROR`，把「上游返回 429」说成「解析失败」，还改变了重试判定。现在四个 formatter（含 Gemini / OpenAI Responses）统一走 `throwIfStreamError` 识别并归一错误、原样带出上游文案，非流式的 `parseResponse` 同样处理 HTTP 200 + 错误体，未能解析的原始响应作为 `rawResponse` 附在错误详情里，`ChannelError` 直接透传不再被改写类型
  - 修复流式中途取消后，下一次请求被 provider 以 400 拒绝的问题：取消时累加器里的部分内容会直接写进历史，其中可能已经包含**完整**的 `functionCall`，但对应的 `functionResponse` 永远不会补上，历史里就留下悬空的 tool_use；现在取消路径会就地结算这些调用——流式提前执行已经跑完的工具用真实结果（它们的写文件、跑命令等副作用已经发生，丢掉结果等于对模型隐瞒），其余标记为已取消
  - 修复分段存储下悬空工具调用永远不被补齐的问题：`getMessages`（全量）一直会把未响应的 `functionCall` 标记为 rejected 并补 `functionResponse`，但 `getMessagesPaged` 的分段存储快路径直接返回窗口、跳过了这一步，而分段存储正是当前的主存储格式；现在首次加载（默认页）会先做一次全量补齐再分页，上拉加载更早消息时跳过以免每翻一页读一次全量
  - 修复五个媒体工具（crop / generate / remove_background / resize / rotate image）的 abort 监听器泄漏，同时修掉一个更实际的缺陷：父信号在工具启动前就已中止时，`abort` 事件早已派发完毕，新挂的监听器永远不会触发，子信号会停留在未中止状态、工具照常跑完整个任务。现在统一由 `withLinkedAbort` 高阶包装器注入 AbortController——进入时若父信号已中止则立即同步中止，退出时无条件摘除监听器
  - 修复子代理配置界面保存失败时 UI 假装成功的问题：`updateAgentField` 内部吞掉了错误，于是 `saveRename` 的失败分支成了死代码——后端拒绝保存（重名等）时编辑框照常关闭，用户看到的是「改成功了但值没变」；现在保存结果由返回值传递（模板里的 `@change` 不接 catch，抛出会变成 unhandled rejection），失败在顶部横幅明示，删除失败同样不再静默
  - 修复子代理配置写入缺少校验：`createSubAgent` 不拦截空的 `type` / `name`，`updateSubAgent` 传空名称会跳过重名检查直接写入（agent 在选择器里变成看不见的条目）；`deleteSubAgent` 也不检查该 agent 是否还有正在跑的 run——配置一旦消失，run 结束后 Monitor 只剩一个查不到定义的孤儿
  - 修复子代理 runId 撞车会覆盖内存快照的问题：runId 由主工具调用 id 推导，同一 toolId 二次执行时会重复，`createRun` 直接覆盖旧快照，而 `runController.register` 又把旧 AbortController 交给新 run，于是在 Monitor 里暂停其中一个会连带暂停另一个；现在冲突且旧 run **仍活跃**时追加后缀（旧 run 已终态则沿用同名，前端在 pending 阶段正是按 toolId 推导 runId 关联工具卡的）
  - 修复子代理撞上下文上限时错误不可读的问题：子代理没有接主链路的 `ContextTrimService`，history 只增不减，工具结果一大、迭代一多就会撞上限，而用户只看到一句原样透传的 `AI call failed: ...`；现在识别各家 provider 的上下文超限措辞，附上已迭代轮数、累积消息数和可操作的建议
  - 修复自动总结在回合级 abortSignal 上累积监听器：`mergeAbortSignals` 在两个信号都没触发时监听器不会自行摘除，而 `abortSignal` 的生命周期是整个回合，一轮里多次自动总结会持续累积；现在返回 dispose 并在总结结束的 finally 中摘除
  - 修复 `MessageRouter.requestClients` 无上界增长：`requestId → clientId` 的映射只在 `sendResponse` / `sendError` 时删除，但过去无论如何都先登记——未命中处理器而回退的消息、以及 handler 抛异常的请求都会留下永不清理的条目；现在只为确实由本 router 处理的请求登记，handler 抛出时就地清理
  - 修复 `sendToExtension` 无超时导致调用方永久 pending：「后端渠道配置已有超时」这个理由只覆盖 LLM 请求，任何因处理器异常、面板销毁等原因不回复的普通消息都会让调用方永远挂着，UI 上是一个再也不会停下来的加载态；现在非流式请求有 180 秒兜底超时（流式对话、依赖安装、存储迁移等长任务豁免，调用方也可显式覆盖）
  - 修复用户中止子代理后主聊天卡片「打开详情」按钮消失的问题：同步执行路径的取消分支和异常分支都只返回 error，不带 `data.runId`，而按钮可见性依赖 runId——run 明明已经真实创建并留下了 transcript，用户最需要进 Monitor 查看已完成部分时反而点不进去；现在两条路径都回填 runId、agentName 与已产出的部分响应
  - 修复子代理每轮模型输出被重复写入 transcript 三次的问题：流结束后写一次、额外 emit 一次裸 `content_snapshot`、prompt 模式工具调用解析后再写一次，每次都递增 `contentRevision`、广播事件、入队全量落盘，并让 Monitor 前端强制重拉一次窗口；现在统一由解析完成后的唯一写入口落盘，写入的是工具调用已还原为 functionCall 的权威版本
  - 修复子代理在父 abortSignal 上累积 abort 监听器的问题：`maxRuntime > 0` 时挂上去的超时桥接监听器从不摘除，而父信号（主会话 AbortController）生命周期远长于单个 run，一轮对话里派发 N 个子代理就会永久累积 N 个监听器，触发 MaxListenersExceededWarning 且长期驻留内存；现在在 executor 最外层 finally 统一摘除
  - 修复 SubAgent 暂停/继续循环在退出唤醒列表累积僵尸回调的问题：`waitUntilRunnable` 会同时向 resumeWaiters 和 exitWaiters 各注册一次 resolve，而 resume 只清空前者；现在合并为单一唤醒列表（退出原因本就由 `record.exitReason` 承载，旧 exitWaiters 的 reason 参数在调用点被忽略），注册与清空严格一一对应
  - 修复事件 journal 长期引用已被替换的 contents 数组的问题：三个 transcript 写入口都把整份 `snapshot.contents` 塞进 `content_snapshot` 事件 payload，该 payload 没有任何消费者（Monitor 面板一律从 snapshot 自行派生 contentCount），却让内存事件 journal 持有旧数组，`replaceContents` 之后被替换掉的数组因此无法回收；现在事件只携带 contentCount，三个写入口共用同一个提交入口
  - 修复 SubAgent Monitor 面板关闭后事件订阅仍留在扩展生命周期里的问题：`onDidReceiveMessage`/`onDidDispose` 过去注册到 `context.subscriptions`，面板关闭后这些已失效的订阅不会被移除，反复开关 Monitor 会持续累积；现在改为面板级 disposables，随面板一次性清空
  - 修复 SubAgent Monitor 消息处理异常导致前端请求永久挂起的问题：处理器抛异常时旧实现只打日志，带 requestId 的请求便永远收不到回复，前端那个 Promise 永久 pending——「加载更早消息」的 loading 状态再也不会结束，按钮永久转圈；现在异常统一转成错误响应回传，与主聊天路由的保底行为一致，前端同时把失败呈现为可重试的顶部提示
  - 修复 SubAgent Monitor 切回此前查看过的 run 时显示过期内容的问题：窗口请求的早退条件只判断「有没有缓存」，缓存命中就直接沿用，于是切回去看到的是上次离开时的 transcript，要等下一个事件到达才刷新；现在与窗口刷新共用同一套 revision 新鲜度判据
  - 修复扩展响应消息会被误当作主动推送消息投递给业务 handler 的问题：响应只会被第一个 window 监听器兑现（它随即删掉 requestId），其余监听器查不到该 requestId，就把这条响应交给了推送处理链路
  - 修复 SubAgent Monitor「加载更早消息」失败后只留下一个未处理的 Promise rejection、用户看不到任何原因的问题后台调用的工具结果只是含 `taskId` / `runId` 的派发 stub，主模型不会通过 functionResponse 拿到任何产出，回执消息是结果回流的唯一通道；而 `buildSubAgentSection` 基于「主模型已通过 functionResponse 拿到完整输出」的错误前提丢弃了 `response` 字段（该前提只对同步执行的子代理成立），导致后台派发的全部工作被静默丢弃。现在回执内联结果正文并按 4000 字符上限截断
  - 修复子代理在超时 / 超出最大迭代次数 / AI 调用失败等早退路径下 run 状态永久停留在 `running` 的问题：这些路径直接 return 裸结果对象，既不向事件总线广播终态事件也不携带 `runId`，Monitor 中对应 run 永远显示为运行中；更关键的是主聊天工具卡片的「Open details」按钮可见性依赖 `result.data.runId`，缺失时按钮恰好在子代理运行失败时消失，用户最需要查看 Monitor 排查时反而点不进去。现在所有返回路径统一经由 `finalizeRun` 收敛，补齐 runId 并在事件总线尚未进入终态时补发 run_completed / run_failed / run_cancelled
  - 修复每次子代理运行都泄漏一个常驻定时器的问题：`maxRuntime > 0` 时创建的 500ms 超时轮询 `setInterval` 只在父 abortSignal 触发时才清理，正常完成、失败、取消的 run 均不清理，泄漏的定时器会持续调用 checkTimeout 并在超过 maxRuntime 后反复 abort 已废弃的控制器；现在在 executor 最外层 finally 无条件清理
  - 修复后台任务回执发送失败后结果永久丢失的问题：`flushReports` 先把任务乐观标记为 `reported: true` 再 `await sendMessage`，发送抛异常时标记不回滚，该任务再也不会被补发；现在捕获异常并回滚标记，等待下一次 flush 时机重试
  - 修复 SubAgent Monitor 面板始终以中文渲染、不跟随语言设置的问题：Monitor 复用同一前端入口，但 `onMounted` 在 Monitor 模式下直接 return，跳过了 `loadLanguageSettings()`，导致面板内已国际化的 MessageItem / ToolMessage / 各工具卡全部回退到默认中文；英文与日文用户看到的子代理详情是混合语言
  - 修复后台派发的子代理工具卡片显示为「成功」的问题：卡片按 `result.success` 判定状态，而后台调用的 stub 结果恒为 success，导致子代理刚进入队列卡片就显示绿色成功态，且运行完成后卡片里永远看不到产出；现在后台卡片跟随 backgroundTaskStore 中对应 taskId 的真实任务状态，并回填结果正文、错误与步数，同时标记「后台」chip
  - 修复 SubAgent Monitor 消息区底部内容被裁切的问题：滚动容器写死 `max-height: calc(100vh - 96px)`，该值与外层 flex 布局冲突且未计入 run tabs 行、重试状态行的实际高度，多个并发 run 时滚动区会溢出视口；现在移除该覆盖，交由 `flex: 1` 精确分配剩余空间
  - 修复调大子代理并发上限后排队中的 run 不会立即启动的问题：`drainQueue` 仅在 release 时触发，`maxConcurrentAgents` 的「立即生效」语义实际要等到某个运行中的 run 结束才成立；新增 `onCapacityChanged` 入口由设置更新处调用
  - 修复请求在进入流式前就失败时后台任务回执不被补发的问题：`flushReports` 的忙闲判断同时看 `isStreaming` 与 `isWaitingForResponse`，但补发只监听前者，`isWaitingForResponse` 单独由 true 转 false 时不会触发补发，挂起的回执要一直等到下一次流结束或切换会话
  - 修复子代理 transcript 的 `updateLastModelContent` 写入口不落盘的问题：三个写入口中仅此路径不入队持久化，持久记录的 `contentRevision` 会落后于内存快照，扩展在 run 进行中重载时最后一轮模型输出无法恢复
  - 修复用户新建子代理时选择预设模板（如"代码审查者"）必定报错 `Failed to execute 'postMessage' on 'MessagePort': [object Object] could not be cloned.` 的问题：前端 `createAgent()` 中预设模板对象来自 Vue `ref` 响应式数组，其嵌套对象（`tools` 等）为 Proxy，无法被 `vscode.postMessage` 的 structured clone 序列化；修复方式为发送前通过 `JSON.parse(JSON.stringify(payload))` 解包所有响应式代理
  - 修复模型频繁幻觉"用户附加了 新建文件夹 (10).zip"的问题：system prompt 的 `CONTEXT BADGE FORMAT` 示例硬编码了 `新建文件夹 (10).zip` 这个看起来像真实用户文件的名称，模型将示例中的文件名误判为实际附件；三处默认值（`PromptManager.ts` / `PromptSettings.vue` / `settings/types.ts`）统一替换为 `example-report.pdf (example)` 并标注 `(example)`
  - 修复上游 API 错误消息被吞掉：非 200 响应现在从 Anthropic/OpenAI/OpenRouter 通用 `{error:{message}}` 格式提取具体错误消息，前端错误面板直接显示如 `HTTP 429: Provider returned error`，不再仅展示无信息的 HTTP 状态码
  - 修复 write_file 新建文件被用户拒绝或中断后磁盘残留空文件的问题，拒绝/取消时自动删除原先创建的空文件
  - 修复命令执行期间无法继续对话的问题：前台命令现在支持运行时转移至后台（detach），用户发送新消息时自动触发；SendButton 在响应期间仍保留发送入口，消息以排队方式进入队列，命令结果稍后以回执消息回流唤醒模型
  - 修复应用差异/写入代码后用户光标跑进代码编辑器的问题：关闭 diff 标签页的 `tabGroups.close` 未传 `preserveFocus`，关闭活动标签后 VSCode 激活相邻编辑器并把光标带进去；现在 diff 应用/拒绝（diffManager）与检查点回档清理 diff 视图（CheckpointManager）均保持焦点原位
  - 修复关闭 diff 标签后聊天输入框仍会失焦的问题（`preserveFocus` 只能阻止焦点跳进编辑器，无法阻止 workbench 把焦点从侧边栏 webview 收走）：新增焦点守卫 `chatFocusGuard`，前端输入框通过 `chatInput.focusState` 消息上报焦点状态，扩展端在关闭 diff 标签前采样、关闭后若输入框此前持有焦点则执行 `graycode.chatView.focus` 归还 webview 焦点并推送 `chat.restoreInputFocus` 命令让光标回到输入框；焦点在编辑器/终端等其他位置时不干预，连续关闭多个 diff 的 blur 上报竞态由 1.5s 宽限期兜底
  - 修复流式提前执行工具的多模态附件（`multimodalAttachments`）从未被写入历史的问题：xml/json 模式下提前执行的 generate_image / MCP 图片结果不再静默丢失，提前执行与串行执行两条路径的附件统一合并后随函数响应写入
  - 修复流式边执行工具可能被重复执行的隐患：`getNewCompletedFunctionCalls` 改用稳定工具调用 id 去重（原 parts 数组索引在结构调整时会漂移，导致同一工具被重复上报并重复执行）；无稳定 id 的调用交给最终统一执行路径兜底
  - 修复 XML 工具调用 `<tool_name>` 带属性时工具名以对象形态流入执行层导致查找必然失败的问题（提取 `#text` 并校验为非空字符串）
  - 修复 XML 工具调用带属性的纯文本参数节点（如 `<content lang="en">xxx</content>`）内容整个丢失变 `{}` 的问题：无子元素时 `#text` 文本内容作为参数值本身保留
  - 修复 write_file / apply_diff 等写入工具打开 diff 预览时强制抢占键盘焦点的问题（`preserveFocus` 改为 true），用户输入框未完成内容不再意外掉入代码文件
  - 修复检查点回档后存档点消失无法二次回档的问题：回档流程在删除消息时保留刚用于恢复的存档点及其增量基链，新增 `preserveCheckpointId` 参数贯穿前端 store → webview handler → ChatFlowService → CheckpointService → CheckpointManager 全链路
  - 修复聊天消息列表右侧滚动条在长对话、工具卡片和流式输出场景下抽搐、跳位的问题
  - 修复用户消息滚动条标记在滚动过程中可能消失的问题，保留已加载消息窗口内的用户消息标记和预览文本
  - 修复 search_in_files replace 模式下「实际已替换但报告未找到匹配」的 false positive：匹配统计从逐行 exec 改为全文 exec，与 `String.replace` 语义对齐，消除跨行正则的漏报
  - 同步上游 search_in_files / history_search 正则诊断能力：非正则零命中时识别疑似正则查询并提示显式启用 isRegex / is_regex，避免 `foo|bar`、`ssh.*root`、`38\\.12` 等查询被静默按字面量搜索
  - 修复 apply_diff / insert_code / delete_code 在工作区外且 autoSave 开启时，用户手动确认工具调用后仍需等待 diff 自动保存计时器的问题，现在确认后直接应用保存
  - 修复 MCP 工具名包含双下划线时前端解析错误的问题
  - 修复 Anthropic 流式请求未从 `message_start` 事件提取并传递 `modelVersion`，导致落盘消息缺少模型版本字段、用量统计「按模型」维度所有 Anthropic 用量被归类为 unknown 的问题
  - 修复 Anthropic 渠道在部分第三方代理（OpenRouter、one-api 等）下无法正确获取 token 用量的问题：统一 usage 提取逻辑，覆盖 message_start / message_delta / message_stop 三个流式事件；新增 thoughtsTokenCount 提取（output_tokens_details.thinking_tokens），区分思考 token 与输出 token；非流式响应复用同一提取逻辑，消除重复代码
  - 删除 openai formatter 流式热路径上的 `console.log` 调试残留（每收到 tool_call 分片即 JSON 打印），降低长参数场景下的日志刷屏与 CPU 消耗
  - 修复提示词模式导入时工具策略过滤的 TypeScript 类型问题
  - 修正历史页头部「用量统计」与「返回聊天」按钮的样式类名语义（close-btn → header-btn，与用量页命名对齐）
  - 修复 esbuild 在 pnpm symlink 环境下重复构建时 `cpSync` 抛出 EEXIST 的错误：`copyNativePackages` 先 rm 旧目标再 dereference 复制真实文件
  - 修复 esbuild 只复制 `node-notifier` 自身而未带上传递依赖（growly/semver/uuid/which/shellwords/is-wsl/is-docker/isexe），导致 vsix 安装后运行时 `require` 找不到模块
  - 修复 webview（ChatViewProvider / SubAgentMonitorPanel）中 codicons CSS 引用指向 `node_modules/@vscode/codicons`，经过 `.vscodeignore` 排除后打包丢失，界面图标全部消失；引用改为包内自带的 `resources/codicons`
  - 修复 jest 配置依赖被 `.gitignore` 排除的 `test/` 目录导致干净环境 `npm test` 无法运行的问题：移除 `.gitignore` 中对 `test/` 的排除，19 个原有测试文件入库
  - 修复 `typescript` / `undici-types` 被错误放置在 `dependencies` 而非 `devDependencies` 的分类问题
  - 修复 `backend/tools/skills/readSkill.ts` handler 参数类型不兼容 `ToolHandler` 的问题（strictFunctionTypes 暴露）
  - 修复 `backend/modules/channel/StreamAccumulator.ts` 18 处 `text` / `functionCall` 可能为 `undefined` 的类型错误（strictNullChecks 暴露）
  - 修复 `backend/modules/channel/ChannelManager.ts` `timeoutId` 未初始化被引用的错误
  - 修复 MCP stdio 连接失败时子进程永不回收泄漏进程树的问题：connect 外套 try/catch，失败时 await disconnect() + 从管理 map 移除
  - 修复 Windows 上 MCP kill() 只杀 cmd.exe 真正 server 进程逃逸的问题：StdioClient 改用 tree-kill 杀整棵进程树（复用项目已有依赖），等待进程真正退出后再 cleanup
  - 修复 MCP 连接进行中的 delete/disable/disconnect 全部落空进程成孤儿的问题：client 提前在 connect 之前 eager 注册进管理 map
  - 修复 MCP HTTP/SSE 传输超时只覆盖响应头、SSE 正文无限等待无法取消的问题：SSE 读取循环内添加 idle-based 空闲计时器，超时 cancel 底层流避免误杀合法长任务
  - 修复 MCP stdout 按 chunk 调 Buffer.toString() 截断多字节 UTF-8 工具结果静默损坏的问题：spawn 后立即 setEncoding('utf8')，移除逐 chunk toString
  - 修复 MCP validateServerId 允许双下划线违反 mcpToolNameCodec 解析前提的问题：提取 MCP_SERVER_ID_PATTERN 为唯一事实源统一校验
  - 修复 MCP cleanSchema 开关不被持久化每次重载静默回到 true 的问题：storage 读写持久化 cleanSchema 字段
  - 修复 MCP stdio 传输完全忽略用户配置 timeout 硬编码 30 秒的问题：构造函数加 timeout 参数并贯穿到 sendRequest
  - 修复 SSE 缓冲区解析对非 SSE 格式的误判：`buffer.includes('data:')` 改为按行判定（只有存在以 `data:` 开头的行才算 SSE），避免 JSON 错误体恰好包含该子串时被整块丢弃
  - 修复 HistoryIntegrityValidator 不检测悬空 functionCall 的盲区：新增 `orphan_function_call` 检测（由 `detectOrphanFunctionCall` 选项控制），ChannelManager 前置校验启用，裁剪/总结等切片调用跳过以避免配对断裂假阳性——这种悬空调用会导致 Anthropic/OpenAI 直接 400
  - 修复 calculateThreshold 把 "0%" 解析为 80% 最大上下文的 bug：`percent > 0` 放宽为 `percent >= 0`（使 "0%" 合法），新增 `fallbackRatio` 参数使额外裁剪调用在非法值时回退到 0 而非 0.8，防止一次裁剪清空整段对话；targetTokens 为 0 时记 debug 日志
  - 修复 countAndUpdateMessageTokens 的精确计数结果被丢弃，accumulateTokens 退化到粗估（chars÷4）的问题：捕获 `Promise.all` 的第二个返回值并回填 fullHistory 快照，使本轮裁剪判定读到刚算好的精确 token 数
  - 修复 ConversationManager.types 缺失 `usageMetadataPartial` 标记：流被中断时 usageMetadata 只覆盖已收到 chunk 的 token 数（可能严重偏低），现在打显式标记供上下文裁剪和用量统计回退到估算
  - 修复 `applyDiffToContent` 使用 `String.replace` 拼接时 replacement 文本里的 `$&` / `$`` / `$'` / `$$` 被当作替换模式展开导致静默写坏文件的问题：改为基于索引的切片拼接完全绕开 replacement 模式语义
  - 新增 ConversationManager.settleFunctionResponses：用真实工具结果就地覆盖 cancelStream 提前写入的「用户拒绝」占位，同时清除对应 functionCall 的 rejected 标记；handleToolConfirmation 的持久化上移到 abort 检查之前以阻止真实副作用结果被丢弃
  - 删除 OrphanedToolCallService 死代码：retry_stream 路径上 rejectAllPendingToolCalls（995 行）已将所有悬空调用标记为 rejected 并补 functionResponse，紧随其后的 checkAndExecuteOrphanedFunctionCalls（998 行）永不触发——删除该服务文件、ChatFlowService/ChatHandler 注入点与 services/index 导出
  - 修复 `backend/modules/channel/proxyFetch.ts` `AbortSignal | null` 无法赋值给 `AbortSignal | undefined` 的类型冲突
  - 修复 `backend/modules/checkpoint/CheckpointManager.ts` `targetState` 可能为 `undefined` 的错误（添加非空断言）
  - 修复 `backend/modules/conversation/ConversationManager.ts` 与 `helpers.ts` 中 `cleanedResponse` 返回类型可能为 `undefined` 的问题
  - 修复 `backend/modules/conversation/functionCall.ts` `ThoughtSignatures` 与 `Record<string, string>` 类型不兼容问题
  - 修复 `webview/handlers/SettingsHandlers.ts` `syncLanguageToBackend` 可能为 `undefined` 的调用错误
  - 修复 `webview/handlers/ToolHandlers.ts` `serverTools.tools` 可能为 `undefined` 的空值访问
  - 修复 `webview/ChatViewProvider.ts` `initializeSubAgents` 构造 HandlerContext 缺漏必填字段导致类型不匹配
  - 修复 `backend/tools/progress/validate_progress_document.ts` `path` 重复声明与 `ProjectProgressToolResultOptions` 参数缺漏问题
  - 修复 `backend/tools/search/search_in_files.ts` `replacement` 参数可能为 `undefined` 传递给替换引擎的类型错误
  - 修复 `backend/tools/terminal/execute_command.ts` `activeProcesses` Map 在 `getActiveTerminalProcesses` 中类型退化为 `never[]` 的问题
  - 修复 `backend/modules/settings/SettingsManager.ts` `ProxySettings` 更新 spread 合并后类型不完整的问题
  - 修复 `backend/modules/settings/VSCodeSettingsStorage.ts` `legacySettingsDir` 可能为 `undefined` 的赋值错误
  - 修复 `backend/tools/media/remove_background.ts` `dimensions` 返回值 `null` 与接口 `undefined` 类型不兼容问题
  - 修复 `webview/types.ts` HandlerContext 中 `chatHandler` / `modelsHandler` / `checkpointManager` / `getCurrentWorkspaceUri` 错误标记为可选字段导致 20+ 处判空不一致（改为必选）
  - 修复 `extension.ts` 中 `newChat` / `showHistory` / `showSettings` 命令回调未对 `chatViewProvider` 判空的不一致（统一改为可选链）
  - 修复 selection hover 与 code action 只注册 `scheme: 'file'`，未涵盖 `untitled` 未保存文件的问题
  - 清理 `.tmp/` 目录中 80+ 个上游同步遗留物（diff patch、python 脚本、旧版文件副本）
  - 删除 `package.json` 中指向不存在文件的 `test:diagnose-execute-command-order` 脚本
  - 彻底修复用户在聊天输入框打字时 AI 写入/修改文件导致焦点丢失的问题：diff 预览不再打开多余的文件本体 tab（`showTextDocument` + `editor.edit` 改为 `WorkspaceEdit` 直接修改文档，每次写入从两个 tab 减为一个 diff tab）
  - 修复 diff 自动保存/检查点回滚时 revert 操作切换活动编辑器抢占用户焦点的问题：`workbench.action.files.revert` 改为传显式 URI，删除三处（diffManager 两处 + CheckpointManager 一处）`showTextDocument` 前置步骤
  - 修复 search_in_files 的 search 与 replace 模式大小写语义不一致（`gim` vs `g`）导致“搜索命中但同一 query 替换 0 命中”的问题（新增 caseSensitive 参数 + 诊断提示）
  - 修复 search_in_files replace 模式文件级异常被静默吞掉的问题：diff 创建/审阅/写入失败、超大文件跳过、“有匹配但替换无变化”等情况现在通过 `skippedFiles: [{file, reason}]` 明确返回，模型能区分“没匹配”和“处理失败”
  - 修复 search_in_files 多工作区 replace 时 maxFiles 扣减语义漂移的问题（按实际处理文件数而非产生修改的文件数扣减）
  - 修复 XML 工具模式下 fast-xml-parser 自动类型转换破坏字符串参数的问题（`"1.10"` → `1.1`、纯数字文件内容变 number）：`parseTagValue`/`parseAttributeValue` 关闭，类型还原交给 schema 驱动的递归 coerce 层
  - 修复模型多传无害未知参数导致整个工具调用失败、白白浪费一轮迭代的问题：未知参数改为剥离 + 警告回传，仅必需字段缺失或类型无法修复时才真正报错；顺带清理 validateToolArgs 死代码分支
  - 修复流式期间早启动执行的工具（含 execute_command）不创建任何检查点的问题：早启动路径现在把检查点正确挂到即将写入的模型消息索引上，回滚不再缺档
  - 修复 insert_code / delete_code / search_in_files(replace) 在自动应用关闭时被聊天确认框 + diff 审阅双重确认的问题
  - 修复 write_file / apply_diff 在自动应用开启后仍需在”自动执行”页单独勾选才能真正自动的双重配置问题：diff 审阅类调用一律不再叠加聊天确认，确认行为的唯一数据源是 Apply Diff 工具设置（autoSave / 延迟 / 跳过差异视图）；工作区外 ask 策略的安全确认优先级不变
  - 修复 proxyFetch 流式取消后生成器可能永久挂起的问题：新增 `closeSocketGracefully` 统一优雅关闭 socket（先 FIN 后 destroy 超时兜底），onAbort 与 finally 共用避免定时器泄漏与重复代码
  - 修复代理握手阶段取消泄漏隧道 socket：`proxyReq.destroy()` 仅在 CONNECT 未完成时有效，connect 之后的隧道 socket 现在在 `finishReject` 一处统一清理
  - 修复代理 URL 认证信息被丢弃、https 代理按明文 80 端口连接的问题：新增 `parseProxyLeg` 共享 helper 正确解析 https/http 协议、默认端口与 Basic 认证头
  - 修复代理流式非 2xx 错误体取到半截/未解 chunk 框架字节的问题：累积错误体字节并按 transfer-encoding 正确解 chunk 框架后再构造 ChannelError
  - 修复非流式代理响应每 data 事件全量 Buffer.concat + utf8 解码导致的 O(n²) 问题：改为 `chunks[]` + `receivedLength` 增量维护，完成判定时一次性 concat
  - 修复代理隧道中途断开时截断响应当成功返回的问题：socket close/end 路径上按 contentLength 或 chunked 终止块判定 body 完整性
  - 修复 CheckpointManager `computeFileHashes` 方法被调用但缺失实现导致整个测试套件编译失败的问题：实现增量哈希（stat mtime+size 不变时复用旧哈希）
  - 修复增量链断裂后 restore 静默降级为部分恢复仍返回 success 的问题：`getIncrementalChain` 返回 `{ chain, broken }`，broken 时显式失败
  - 修复 restore 会删除检查点从未备份过的工作区文件的问题：删除集合只包含 `fileHashes` 中记录的路径，不删快照时被 ignore 的文件
  - 修复 restore 无法恢复的文件被静默跳过仍返回 success 的问题：四类失败场景（missing_in_chain/hash_mismatch/copy_failed/delete_failed）显式收集并体现在返回值中
  - 修复备份复制失败被吞掉但 fileHashes 声称已备份的问题：复制失败从 fileHashes 剔除 + 恢复侧 detect missing_in_chain
  - 修复检查点元数据写入失败返回幽灵检查点并泄漏备份目录的问题：save 失败 rethrow + catch 中回收 backupDir
  - 修复每个检查点全量 MD5 整个工作区（每次工具调用两遍扫描）的问题：stat 增量哈希 + 避免 createCheckpoint 重复扫描
  - 修复导入设置时 VSCode 配置被无条件整块覆盖、无视用户选择「跳过已存在项」的问题：导出侧移除 machine-local 键 + 导入侧按合并策略跳过已有项
  - 修复渠道配置导入丢弃原始 id 导致 activeChannelId 悬空与重复导入产生重复渠道的问题：getImport 改为保留原始 id
  - 修复导出/导入包含 machine scope（proxy/storagePath）跨机器导入打断网络与数据目录的问题：新增 `MACHINE_SCOPE_KEYS` 常量统一定义，导出与导入两端过滤
  - 修复内置提示词模式自定义 toolPolicy 每次读取被强制回滚并落盘的问题：getter 移除隐式变更，新增 `toolPolicyCustomized` 标记区分「未定制」与「主动定制」，迁移显式幂等
  - 修复导入 Skill 用未校验 id 拼路径、导出文件可写任意目录的问题：skill id 校验收敛到 SkillsManager 单一来源 + resolve 后边界断言防路径穿越
  - 修复 collectVSCodeSettings 用 defaultValue 兜底把包默认值当用户值导出固化的问题：去掉 defaultValue + 补 workspaceFolderValue 三层解析
  - 修复导入后 initialize() 不触发变更事件导致 PromptManager 缓存过期的问题：新增 `reloadAndNotify()` 重新加载并广播 type:full 变更事件
  - 修复 rejectToolCalls 拒绝响应插入位置错误导致 tool_result 与 tool_use 顺序错乱的问题：新增 `findFunctionResponseInsertIndex` 跳过同批次已有响应
  - 修复 markUserInterrupt/cancelAllPending 全局中断 A 会话强杀 B 会话 pending diff 的问题：中断语义改为按 conversationId 隔离
  - 修复 VSCode files.autoSave + pending diff = 死循环（每 autosave tick 全量回写磁盘）的问题：willSave 改为标记 `nonManualSaveFlushed` 直接落盘不再触发回写循环
  - 修复 pendingDiffs/diffSessions 条目永不删除内存泄漏的问题：新增 `finalizedDiffOrder` FIFO 队列 + `MAX_FINALIZED_DIFFS=50` 延迟淘汰
  - 修复关闭标签页拒绝新建文件 diff 后磁盘残留空文件的问题：抽取 `closeDiffTabAndCleanNewFile` 统一关 tab + 删残留
  - 修复 directApplyAndSave fallback 打开 diff 视图 original 侧为空且无 CodeLens 的问题：contentProvider.setContent 改为无条件执行，addSession 保持懒注册
  - 修复 Close 监听器吞掉文件读取失败导致 diff 永久 pending 的问题：catch 到读文件失败时按 reject 收敛 diff
  - 修复 newFile 标记在 createPendingDiff resolve 之后才设置导致 showDiffView 期间取消泄漏空文件的问题：改为通过 CreatePendingDiffOptions 传入提前标记
  - 修复 MarkdownRenderer 未标注语言代码块每次渲染 hljs.highlightAuto 遍历 192 种语法导致流式期间主线程秒级冻结的问题：完全无标注的跳过高亮，有标注但不识别的走缓存
  - 修复 mermaid 代码块 fence 原文未转义拼进 HTML 造成 v-html 注入执行且绕过 artifactSafe 配置的问题：源码插入 HTML 前 HTML 转义，渲染走 DOM API
  - 修复默认档位 html:true 产物未经净化直接 v-html，模型正文原始 HTML 可在 webview 内执行脚本的问题：新增 `sanitizeHtml` DOM 净化器（去危险标签+事件+js 协议），非 artifactSafe 档位启用
  - 修复后处理完成标记在 await 后读 props.content 叠加 isMermaidRendering 提前返回导致 mermaid/图片永久不渲染的问题：renderMermaid 改 promise 串行化 + scheduleRender 快照校验
  - 修复 markdown-it 实例/文件缓存/图片缓存每个消息块各造两份的问题：提升到模块级单例跨消息共享
  - 修复 renderLatexOnly 行内正则缺空格护栏导致货币金额 `$5 to $10` 被当公式渲染的问题：正则新增 `(?!\\s)...(?<!\\s)` 首尾空白护栏
  - 修复消息队列串行等待长任务导致总结中「取消总结」永不执行、整条 webview 消息通道冻结的问题：MessageRouter 新增 NON_BLOCKING_MESSAGE_TYPES，fire-and-forget 不占住队列
  - 修复 saveImageToPath 未做工作区包含校验、webview 消息可用 `..` 覆写工作区外任意文件的问题：新增 `isUriInsideWorkspace` 路径包含性 helper，越界拒绝并回错误
  - 修复 extension.ts deactivate 未摘除 DiffManager 状态监听器导致停用过程中复活已 dispose provider 单例永久泄漏的问题：监听器提为模块级，deactivate 最前面同步摘除
  - 修复 ChatViewProvider 每次重建视图追加 diff 状态监听器旧的不摘除的问题：新增 `viewDisposables` 数组每次 resolve 清空并重新注册
  - 修复 ToolMessage onMounted 内 await 后注册的 onBeforeUnmount/watchEffect 全部失效、每个实例永久泄漏 2 个全局消息订阅者的问题：生命周期注册搬到同步 setup 作用域
  - 修复每个 ToolMessage 为全局 pending diff 启动自动保存倒计时、N 个组件到点同时发 diff.accept 的问题：倒计时提升为模块级单例按 sessionId 去重
  - 修复 ToolMessage 内联箭头函数组件 `<component :is=”()=>renderToolContent(tool)”>` 每次渲染换 vnode type 导致展开面板整棵卸载重建的问题：用 defineComponent 创建恒定 ToolContentHost
  - 修复未完成工具每个 chunk 触发全量消息线性扫描、enhancedTools 订阅整个消息列表的问题：toolResponseCache 改造为随写入维护的 O(1) 权威索引
  - 修复后台派发 subagents 工具卡头部状态恒为「成功」、后台任务失败仍显示绿色对勾的问题：新增 `computeTaskCardStatus` 单一数据源 helper，头部与卡片共用
  - 修复 diff 孤儿宽限期 Date.now() 判定但无重估调度导致超时纠正分支不可达的问题：补 setTimeout 到达宽限期触发 computed 重求值
  - 修复排队消息在流出错/取消后永不重发、输入框进入死循环的问题：cancelled/error 分支补齐 `nextTick(processQueue)`
  - 修复 sendMessage 在多次 await 后重读 currentConversationId 导致消息被发进另一个会话的问题：固化 targetConvId + 写 state 前归属校验
  - 修复 switchConversation 在 await 后无条件覆盖 allMessages/checkpoints 把 A 历史灌进 B 视图的问题：每个 await 后 validateSessionIdentity 守卫
  - 修复 switchConversation 不清空 messageQueue 导致排队消息被自动灌进新会话的问题：清理块追加清空 + QueuedMessage 加 conversationId 字段 processQueue 校验
  - 修复 deleteMessage/retryFromMessage 在 await cancelStream() 后才算索引可能截断另一个会话历史的问题：await 前固化索引 + await 后校验未变
  - 修复 sendMessage 吞掉发送异常导致后台任务回执乐观标记回滚永不生效的问题：改返回 `Promise<boolean>` + backgroundTaskStore 按返回值回滚 reported
  - 修复切换标签页恢复快照不重置 toolResponseCache 导致工具响应全文永久驻留内存的问题：纳入 ConversationSessionSnapshot 按会话存取
  - 修复 loadOlderMessagesPage prepend 了会话 A 历史到会话 B 的问题：锁定请求发起时对话身份 + await 后校验
  - 修复 loadMore scroll-anchor fix-up 在 finally 把上一标签页几何应用到新标签页的问题：归属校验 + finally scroll 恢复仅在归属未变时执行
  - 修复 Message windowing 失效每个 loaded message 在每个 chunk 被重新 enhance/重排的问题：resolveLoadedVisibleMessages 恢复尾部窗口切片

### Improved
  - SubAgent Monitor 未打开时不再为不可见 UI 支付流式序列化成本：事件总线订阅在面板关闭后依然存在，`postEvent` 过去对每个 `llm_delta` 都完整执行 payload 白名单清洗、manifest 派生与 activeRunIds 收集，再在 `postRoutedMessage` 中因没有 panel 被整个丢弃；现在无活跃面板时直接短路
  - 子代理 manifest 预览派生从 O(消息长度) 降为 O(预览长度)：`extractContentPreview` 过去先把整条消息的全部 parts 拼成完整字符串再截断到 160 字，而 manifest 会在每个 `llm_delta` 事件上重新派生，上一轮若是数万字符的模型输出则每个增量都要重跑一次全量拼接；现在逐 part 累积、超过上限立即停止读取
  - 子代理 transcript 持久化写入合并：`enqueuePersist` 过去为每一次 transcript 变更都排一次完整的「读元数据 → 改 → 写回」，流式期间队列被同一 run 的连续写入撑满；现在用脏标记合并尚未开始执行的排队写入（写入前清除标记，写入期间的新变更会正常排下一次），同一 tick 内 30 次变更由 30 次落盘降至个位数
  - 子代理运行时内存改为有界：单个 run 的内存事件 journal 上限 500 条（超出丢弃最旧），事件总线内存快照上限 200 个 run；淘汰只作用于「已进入终态且已持久化到 conversation metadata」的 run，运行中的 run 与无持久化归属的 run 永不淘汰，被淘汰的 run 仍可通过 `loadConversationSnapshots` 从元数据恢复查看
  - 修正子代理组合中止信号的监听器生命周期：`createOperationSignal` 过去把 abort 监听器永久挂在父 abortSignal 与 run 控制器信号上且从不摘除，一个 20 轮带工具调用的 run 会累积上百个监听器并触发 Node 的 MaxListenersExceededWarning；现在返回 release 句柄，由每次 LLM 调用与工具调用在 finally 中摘除，信号生命周期与单次操作对齐
  - 后台任务状态条的 1 秒计时器改为按需启停：`now` 只被运行中任务的耗时显示消费，但 ticker 过去在组件整个生命周期内无条件运行，没有任何后台任务时也会每秒触发一次响应式更新与重渲染，且持续整个 VS Code 会话；现在按 `runningCount` 启停
  - SubAgent Monitor 新增实时输出自动跟随：作为实时监视面板过去从不跟随新内容，用户必须持续手动下拉才能看到子代理正在输出什么；现在复用主聊天 MessageList 的贴底判定，贴底时随尾部内容增长自动滚动，用户向上翻阅历史后不再被拽回底部；尾部指纹使用消息的全局 index 而非窗口内数组长度，因此「加载更早消息」向前 prepend 不会误触发跳底
  - SubAgent Monitor 界面文案接入 i18n（zh-CN / en / ja）：标题、副标题、run 计数、空状态、已加载条数、加载更早、控制按钮、自动重试状态与全部 8 个 run 状态（queued / running / paused / awaiting_monitor_action / completed / failed / cancelled / interrupted）此前均为硬编码中文
  - 流式热路径 O(n²) 性能优化：StreamAccumulator 新增结构修订号 `contentRevision`（仅在新 part 入列、工具参数解析完成等结构性变化时递增），StreamResponseProcessor 据此决定是否下发 contentSnapshot，移除每个 chunk 全量重建 Content + 逐 part `JSON.stringify` 深比较 + 尾部大文本 `startsWith` 比较；长回复/大参数工具调用场景 CPU 开销显著降低，`thinkingStartTime` 也改为直接从累加器读取
  - 删除 StreamAccumulator 旧解析路径 `extractAndConvertToolCalls`：json/xml 模式下每次文本合并都全量重扫所有 parts（O(n²)），职责早已由 IncrementalPromptToolParser 在入口处全量接管；顺带修正 thought 文本中的工具标记被误当真实调用的行为（与 ToolCallParserService 跳过 thought 的语义对齐）
  - jsonFormatter 边界标记正则预编译为模块级常量，`hasCompleteJSONBlock` / `parseJSONToolCalls` 不再每次调用重新转义拼接
  - 清理 ToolIterationLoopService 流式提前执行结果收集中被后续整体覆盖的 `earlyResponseParts.push` 死代码
  - 优化自定义滚动条的尺寸、内容和 marker 更新时机，合并到浏览器渲染帧中处理，降低重复布局计算导致的抖动
  - 历史 / 用量 / 设置三个页面从 v-if 互斥渲染改为惰性挂载 + v-show 保活：首次访问才创建组件（不影响首屏），切换视图不再丢失滚动位置和表单编辑状态；用量页保活后重新进入时自动刷新统计
  - MarkdownRenderer 的 mermaid 图表库改为按需动态导入：首屏 bundle 不再包含 ~1MB 的 mermaid，仅在内容中出现 mermaid 代码块时才加载
  - 优化 search_in_files 替换结果的 diff 预览，仅折叠大段未变化内容并保留变更附近上下文
  - search_in_files 工具结果面板新增查询诊断展示，直接显示 suspected_regex、关键词兜底和疑似多个 path 的纠错建议
  - 同步上游 search_in_files / history_search 多关键词搜索兜底：非正则搜索先匹配完整短语，零命中后再尝试空格分隔关键词，提高自然语言式关键词输入的召回率
  - 优化 history_search 与 execute_command 的工具描述，减少历史读取、正则搜索和工作目录参数误用
  - 增强 execute_command 的 cwd 工作目录说明，明确单根/多根工作区相对路径、workspace 外绝对路径和避免在 command 中嵌入 cd 的规则
  - 主聊天接入 functionCallMerge，统一流式工具调用的 itemId/index/finalArgs 合并逻辑，降低重复工具卡、空参数工具卡和分片参数错位问题
  - diff 预览按钮迁移到 ToolConfig.actions，移除 ToolMessage 对 hasDiffPreview/getDiffFilePath 的旧特判依赖
  - read_file 前端组件适配 path 参数，支持 startLine/endLine 行范围显示
  - resolveUri / resolveUriWithInfo 增强绝对路径处理，自动匹配所属工作区
  - 实现 Anthropic 渠道配置验证（`validateAnthropicConfig`），替换原有的 TODO 占位：校验 URL / apiKey / model / temperature(0-1) / max_tokens / top_p / top_k / thinking.budget_tokens(>=1024)，新增对应 i18n 键
  - 用量统计的前端类型抽取到共享文件 `frontend/src/types/usage.ts`（与后端 `usageStats.ts` 聚合结构对齐），不再手写在组件内
  - 补齐用量页新功能的 i18n 文案（zh-CN / en / ja，时间范围 / 单价编辑 / 估算成本 / 对话跳转等 11 个 key）
  - 重构 SettingsManager 工具/模块配置的 getter/update 方法：新增私有 `getToolsConfigEntry` / `saveToolsConfigEntry` 泛型帮助方法统一 22 组样板逻辑的 merge-保存-通知流程，文件从 2447 行缩至 2063 行，公开 API 不变
  - 重构前端五个媒体工具展示组件（crop / resize / rotate / remove_background / generate_image）：提取共享骨架 `MediaToolPanel.vue` 和类型模块 `mediaToolTypes.ts`，五个组件从合计 4394 行缩减为 1744 行（净减约 2650 行），主题色/任务解析/取消通道等差异参数化；补充 crop/resize/rotate 三面板的 `tasksFailed` 三语 i18n 键
  - i18n 类型定义从手写接口（frontend 3075 行 + backend 714 行）改为从基准语言包（zh-CN）`typeof` 推导，新增翻译键只需修改语言文件即可，en/ja 因保留 `LanguageMessages` 类型标注会在结构不一致时 typecheck 报错
  - todo 工具清理 `(context as any)` 类型逃逸和 `require()` 双重导入：直接使用 `ToolContext` 已有的 `conversationStore` / `conversationId` 类型字段，index.ts 改为静态 import
  - 清理 ToolMessage.vue 中的重复 toolId 排查调试代码（debugToolOnce / isPerfEnabled / console.warn），约 30 行临时代码
  - 4 处空 catch 块补日志：ToolIterationLoopService 两处移除冗余 try/catch（Logger 自身已安全序列化）、StreamAccumulator 一处添加英文注释说明流式 JSON 不完整是正常现象、SettingsHandlers 一处 catch 读版本失败时输出 console.warn
  - backend/webview 共 53 处 `console.log`/`console.debug` 统一迁移到结构化 `Logger`（含通知模块 31 处、ChatViewProvider 8 处、DiffStorageManager 6 处、CheckpointManager 3 处、DependencyManager / ToolExecutionService / ModuleRegistry 等）
  - 通知模块（WindowsAgentStopNotificationService / WindowsToastAdapter / NotificationHandlers）移除模块级 `LOG_PREFIX` 常量，改用 `Logger.get()` 实例化命名日志器
  - `extension.ts` 中 `console.log` / `console.error` 全部替换为 `Logger.get('extension')` 统一日志输出
  - `esbuild.config.js` 新增 `--watch` 参数支持（使用 `esbuild.context().watch()`），内置 rebuild 日志插件；`package.json` watch 脚本从无用的 `tsc -watch` 改为 `node esbuild.config.js --watch`
  - esbuild `copyNativePackages` 重写为递归复制 + 循环依赖保护，确保 external 原生包的所有传递依赖被打进 `dist/node_modules`，模拟安装后加载验证全部通过
  - `package.json` engines.vscode 从 `^1.74.0` 升级到 `^1.84.0`，与 esbuild target `node18` 和 `@types/vscode ^1.84.0` 保持一致，消除运行时 API 版本不匹配风险
  - `.vscodeignore` 移除不存在的旧版 jest 配置条目（jest.config.cjs / tsconfig.jest.json），保留实际存在的 `jest.backend.config.js` 和 `tsconfig.test.json`
  - `.vscodeignore` 的 `*.map` 改为 `**/*.map`，覆盖子目录 sourcemap；新增排除入口源码文件 `extension.ts`、`index.ts`；清理过时的 `!node_modules/node-notifier` 例外规则（运行时依赖已移入 `dist/node_modules`）
  - webview 的 `localResourceRoots` 移除 `node_modules/@vscode/codicons` 条目，统一到 `resources/` 根目录
  - `package.json` license 字段从 `ISC` 改为 `MIT`，与仓库根目录 `LICENSE` 文件内容一致
  - 合并 ToolExecutionService 的 `executeFunctionCallsWithResults` / `executeFunctionCallsWithProgress` 孪生方法（约 210 行逐行重复）：前者改为驱动后者的 generator 到底并丢弃进度事件，检查点/参数规范化/策略过滤/多模态处理只剩一份实现；执行循环抽取 `runSingleToolCall` / `finalizeToolResponse` 共用方法
  - 删除 update_plan 硬编码的 14 个 carry-over 字段剥离特例（`stripKnownUpdatePlanContinuationFields`），由通用未知参数剥离规则覆盖；`getToolArgsArrayValidationError` 的友好错误措辞合并进 validateToolArgs，参数校验从两次遍历合并为一次
  - 新建共享 `diffReviewTools.ts` 判定模块（write_file / apply_diff / insert_code / delete_code / search_in_files replace），消除 ToolIterationLoopService 与 ToolExecutionService 各自维护的重复工具集定义
  - 自动执行设置页对 diff 审阅类工具不再显示无效的勾选框，改为“Diff 审阅管理”状态徽标（悬停说明指向 Apply Diff 设置），批量操作自动跳过这些工具，页面新增配置关系说明（三语 i18n）
  - 清理从未被执行链路消费的僵尸配置字段 `DeleteFileToolConfig.autoExecute` / `ExecuteCommandToolConfig.autoExecute`，避免与统一自动执行配置（toolAutoExec）混淆
  - delete_file / get_symbols / list_files 等工具描述中的“MUST be an array”强调不再是唯一防线，参数层通用别名提升从根源上消化单复数误用
  - read_file 工具声明瘦身：line/maxLine/maxLines/limit 四个兼容别名参数从 schema 和描述中移除（每轮请求少发一大段别名说明），通过 paramAliases/compatParams 机制继续接受旧写法，行范围语义不变
  - RepeatedCallGuard 签名改用键排序的稳定序列化，键顺序不同的语义等价参数不再绕过护栏；rejected:true 的结果（并发超限、策略过滤等）不再计入连续失败，避免“换个思路”提示误导本可稍后重试的场景
  - coerceToolArgs 类型容错补齐 object 分支：JSON 字符串 → 对象（双重编码容错，与 array 分支对称），解析后继续递归修正内部类型；单数别名提升支持 -ies 复数（query → queries）
  - 工具响应深拷贝从 `JSON.parse(JSON.stringify(...))` 换成 `structuredClone`（不可克隆值回退旧方式），大文本 / 多模态 base64 场景显著降低序列化开销
  - ToolRegistry 新增别名索引（alias → 主名），getTool 的别名查找从 O(n) 遍历降为 O(1)，注销 / 刷新工具时同步维护，保持先注册者优先语义
  - XML 工具调用解析失败反馈具体化：借助 XMLValidator 报出具体语法错误与行号，缺失 `<tool_name>` 时单独指出，不再是一句笼统的 "not valid XML"
  - 工具调用链路测试扩充：validateToolArgs 嵌套/enum/签名回显 11 个新用例、coerceToolArgs 对象解析与别名机制 9 个新用例、repeatedCallGuard 稳定签名与 rejected 语义 4 个新用例，新增 `toolRegistryAliases.test.ts`（6 用例）

### Synced from upstream (1.1.28 → 1.2.5)

#### 工具增强
  - apply_diff 升级为结构化 hunks（oldContent/newContent），保留旧 patch 兼容入口；新增行首缩进容错兜底，降低模型缩进误差导致的匹配失败
  - execute_command 重写 Shell 选择规则说明：明确 PowerShell/CMD/sh/Git Bash/WSL/Zsh 的解析规则、管道符转义、复杂命令最佳实践和 SSH 多层解析边界
  - read_file / write_file 输入格式简化，单文件读写改为直接传 `{ path, ... }`；read_file 增加 `line`/`maxLine`/`maxLines`/`limit` 兼容别名
  - list_files / find_files 增加文本文件 `lineCount` 元数据，list_files / find_files / history_search 前端结果卡片展示行数信息
  - DiffReviewSession 抽取为 DiffManager 内部协作者，集中单个 diff review 生命周期；新增 autoSaveError 避免自动确认模式下悬挂状态

#### 流式渲染
  - MarkdownRenderer streaming 调度从纯 debounce 调整为 leading/trailing/max-wait 策略：首个非空片段立即显示，持续输出有最大等待上限
  - 主聊天流式正文不再因 text/thought block key 随正文长度变化而闪烁重建

#### 架构模块
  - 新增 TranscriptRepository / TranscriptMutation 抽象层，收敛主聊天与 SubAgent transcript 读写入口
  - ConversationManager 接入 TranscriptRepository 处理删除、截断、清空和快照恢复等结构性历史变更，并在变更后清理上下文裁剪状态
  - RunController 最小共享契约迁移到 `backend/core/`，统一主聊天取消与 SubAgent pause/resume/exit 接口
  - 新增 ToolDeclarationResolver 工具声明解析器
  - 新增 mcpToolNameCodec 模块，修复 MCP 工具名包含双下划线时前端解析错误
  - 新增 functionCallMerge 模块，标准化 Anthropic `tool_use` 流式工具调用 id/index 语义，消除重复工具卡片

#### Token 速度
  - 新增 tokenRate 公共工具，统一主聊天、SubAgent Monitor 和响应详情的 token 速度计算入口
  - 修复流式 `streamDuration` 语义：使用请求开始到最后一个流式块的完整耗时，降低上游一次性吐出多段 SSE 时的畸高速率

#### SubAgent Monitor（基础设施）
  - 新增 SubAgent Monitor 独立编辑器面板、运行事件总线（runEventBus）与运行控制器（runController）
  - 新增 WebviewClientRegistry 实现 client-aware Webview routing，让 Main Chat 与 SubAgent Monitor 响应回到正确 Webview
  - 新增 agentRun store（events/reducer/selectors/contentDelta）为 Monitor 前端数据流提供状态管理
  - Monitor 前端组件：实时输出、工具卡参数显示、多 run 标签页、窗口状态管理
  - 接入 App 独立面板模式：`__GRAYCODE_VIEW_MODE = 'subagentMonitor'` 时渲染 SubAgent Monitor，并跳过主聊天初始化链路
  - SubAgent 工具卡新增“打开详情 / Open details”操作，复用 `ToolConfig.actions` 和 `ToolMessage` 通用工具操作按钮渲染
  - Webview 侧补齐 `subagents.openMonitor`、pause/resume/exit、delete/retry message 等 Monitor 操作 handler，并在 `ChatViewProvider` 中完成最小路由接线
  - 补齐 SubAgent Monitor 相关 i18n key（zh-CN / en / ja）和前后端通信类型
  - 补齐 ToolProgressEvent、ToolExecutionResult.args、countTextFileLines、gcd 等同步过程中需要的后端类型与工具函数导出
  - 验证通过：`cd frontend; npx vue-tsc --noEmit`、根目录 `npx tsc --noEmit`、相关 Jest 单测 `parsers.test.ts` / `ConversationManager.branch.test.ts` / `toolIterationDynamicContextPreserve.test.ts`

#### 新增文件统计
  - 后端新增 13 个模块/工具文件，前端新增 14 个组件/工具文件
  - 核心工具 4 个文件同步至上游最新，语法验证通过

## [1.1.27] - 2026-05-01

### Added
  - Gemini 频道新增「上游请求最多图片数」配置，可限制发送给 API 的历史图片数量，超出上限时优先保留最新图片

## [1.1.26] - 2026-04-24

### Fixed
  - 修复没有思考内容时不发送reasoning_content的问题

## [1.1.25] - 2026-04-15

### Fixed
  - 修复聊天历史完整性与消息可见性问题
  - 修复 diff 生命周期、plan 可见性、NoAct 审批门闸与提示系统设置
  - 其他

## [1.1.24] - 2026-04-04

### Fixed
  - 新增 Progress 文档能力
  - 修复命令执行的个别bug

## [1.1.23] - 2026-04-03

### Fixed
  - 修复流式工具id问题

## [1.1.22] - 2026-04-02

### Fixed
  - progress_sync 模式下误传 sourceArtifact 时改为忽略并警告，不再报错

## [1.1.21] - 2026-04-02

### Improved
  - 将 prompt mode 的使用范围从全局切换，收敛到会话和请求链路，并补齐运行时上下文。
  - 完善 review mode 的文档生命周期、结构化结果处理与对比流程。
  - 为 design / plan 文档增加更新能力，并让计划文档与任务卡、续写流程保持同步。
  - 提升 Webview 声音提醒的稳定性，处理音频解锁、并发播放、过期事件丢弃和隐藏态折叠等问题。

## [1.1.20] - 2026-04-01

### Added
  - 增加边流式边执行工具的功能

### Fixed
  - 优化工具的兜底机制

## [1.1.19] - 2026-03-31

### Fixed
  - 调整工具解析兜底策略，降低解析失败问题

## [1.1.18] - 2026-03-30

### Fixed
  - 修复ignore模块未被打包导致启动失败的问题

## [1.1.17] - 2026-03-30

### Fixed
  - 添加遵循.gitignore，并修复Windows 系统下的路径规范化问题
  - 修复不同格式下，对于缓存命中token信息的显示和存储问题，使用⚡显示缓存命中token数

## [1.1.16] - 2026-03-25

### Fixed
  - 修复包管理器锁文件冲突：删除多余的 pnpm-lock.yaml，统一使用 npm（package-lock.json）作为包管理器
  - 修复 LLM 工具参数序列化问题：新增 coerceToolArgs 模块，自动修正 AI 模型返回的工具参数类型错误（如将字符串 "true" 转为布尔值 true，字符串 "123" 转为数字 123，字符串化的数组/对象自动解析为原类型）
  - 在主工具执行入口（ToolExecutionService）和子代理执行入口（subagents/executor）中接入 coerceToolArgs，统一参数类型矫正逻辑

### Added
  - 新增 backend/tools/coerceToolArgs.ts 工具参数类型矫正模块
  - 新增 coerceToolArgs 单元测试（backend/__tests__/tools/coerceToolArgs.test.ts）
  - 新增 Jest 测试配置（jest.config.js、tsconfig.test.json）

### Improved
  - tsconfig.json 排除测试目录，避免测试文件影响生产构建

### Note
  - ⚠️ 此为初步修复，coerceToolArgs 的类型矫正覆盖了常见场景，但可能存在边界情况未处理，后续会持续完善

## [1.1.14] - 2026-03-25

### Added
  - 增加Anthropic格式下缓存创建开关

### Improved
  - 优化skill实现逻辑

## [1.1.13] - 2026-03-19

### Fixed
  - 修复了sub-agent不能正常调用的bug

## [1.1.12] - 2026-03-19

### Fixed
  - 兼容旧版 VS Code（移除 nanoid 的 ESM 依赖）
  - 降低vscode版本限制

## [1.1.11] - 2026-03-19

### Fixed
  - 修复设置-提示词-工具策略修改不能保存的问题，优化默认模式工具配置

## [1.1.10] - 2026-03-17

### Added
  - 引入 Review 模式并完善审查文档、工具摘要与前端展示

## [1.1.9] - 2026-03-17

### Added
  - 补齐 design 文档产出与 design 到 plan 联动链路

### Fixed
  - 修复由于ai输出工具调用结构不齐导致的前端渲染崩溃
  - 修复非function call格式的解析
  - 修复skill不支持claude api的问题

## [1.1.8] - 2026-03-16

### Improved
  - 重构前端回复查看器并统一查看回复入口命名

## [1.1.7] - 2026-03-13

### Fixed
  - 修复了获取模型时，自定义标头不起作用的问题，以及使用Auth发送对获取模型无效的问题

## [1.1.6] - 2026-03-13

### Fixed
  - 提高了设置页面中 Token 统计的准确性，并增强了消息处理管道的稳定性

## [1.1.5] - 2026-03-10

### Fixed
  - 修复了切换模型时，发送为gemini格式时，思考签名导致的空括号问题
  - 提高了设置页面中 Token 统计的准确性，并增强了消息处理管道的稳定性

## [1.1.4] - 2026-03-09

### Fixed
  - 修复了单个流式块导致的消息消失问题
  - 修复了拒绝执行工具时，拒绝消息重复添加的问题
  - 修复多标签页同时工作时无法完成响应的问题

## [1.1.3] - 2026-03-07

### Fixed
  - 修复两个源代码里的注释编码问题
  - 修复Anthropic格式下input token，total token记录问题

## [1.1.2] - 2026-03-07

### Fixed
  - 修复Anthropic格式的获取模型死循环和token计数接口格式问题，以及思考签名不发送问题
  - 修复Windows终端工具的编码问题，添加编码失败回退逻辑

## [1.1.1] - 2026-03-06

### Added
  - 添加了外观配置：是否显示添加内容到输入框

## [1.1.0] - 2026-03-05

### Added
  - 添加了Plan卡片消息的标签页打开功能

### Improved
  - 优化了Plan卡片的显示，不再截断内容
  - 交换了Plan文件里正文和todolist的顺序

## [1.0.99] - 2026-03-04

### Fixed
  - 修复点击工具执行的状态问题
  - 修复对话文件的工作区路径无法变更问题
  - 修复长历史对话的全量重载问题

## [1.0.98] - 2026-03-01

### Fixed
  - 修复MCP自动连接依赖UI的Bug
  - 修复历史对话内容检索工具的范围问题

## [1.0.97] - 2026-02-27

### Added
  - 添加了对于文件夹的shift拖拽到输入框的徽章消息支持

## [1.0.96] - 2026-02-27

### Added
  - 鼠标悬停在底部模式/渠道/模型上的悬浮显示支持
  - 拖拽工作区非文本类文件到输入框的徽章优化，不再尝试使用文本解析，改为上传附件+传递路径框架信息，同时优化上传的附件类型，默认支持：图片/视频/音频/文档
  - 系统提示词的静态提示词里添加了{{$CONTEXT_BADGE_FORMAT}}，**务必重置一下静态提示词**

## [1.0.95] - 2026-02-27

### Added
  - 新增声音提醒功能：支持警告/错误/任务完成/任务失败事件，提供独立设置界面，支持导入本地音效，并内置免版权默认提示音

### Improved
  - 优化外观细节：思考内容垂直居中，正文、工具、思考对齐，删除浅色主题的思考标题内容分界线，代码块行号显示自适应

## [1.0.94] - 2026-02-26

### Added
  - 为总结功能添加系统提示词，避免某些缺系统提示词导致的报错问题

## [1.0.93] - 2026-02-24

### Fixed
  - 修复模型回退逻辑与第三方 Gemini 模型过滤

## [1.0.92] - 2026-02-21

### Fixed
  - 修复上下文裁剪估算问题
  - 修复粘贴文本为富文本的问题

## [1.0.91] - 2026-02-18

### Fixed
  - 修复工具等待执行状态不更新的问题

## [1.0.90] - 2026-02-16

### Added
  - 添加了对于mcp工具按照mcp规范工具响应返回图片时的显示支持

### Fixed
  - 优化前后端流式，添加id绑定，修复几个竞态问题

## [1.0.89] - 2026-02-13

### Added
  - 添加了自动总结功能，位于上下文管理里，与上下文裁剪互斥
  - 添加了总结功能的取消操作
  - 添加了对话标签页拖拽调整顺序功能
  - 添加了被总结的对话的历史对话检索工具

### Improved
  - 优化了本地计算token的数量，添加了兜底以及统一系数1.5，降低超上下文情况
  - 优化了前后端流式信息的通信性能消耗
  - 将动态提示词改为回合内固定不变，而不是每次调用ai都实时生成

### Fixed
  - 修复了命令行工具终止不完全的问题
  - 修复了输入框粘贴内容无法撤销的问题
  - 修复了不同对话之间，模型、模式、skill、固定文件无法单独配置的问题
  - 修复了启用自动应用时不打开差异视图配置导致diff一直处于等待的问题
  - 修复了加载对话时跳转到末尾不完全的问题

## [1.0.88] - 2026-02-12

### Improved
  - 增加了聊天界面右侧滚动条和消息节点的大小
  - 修改了遮挡关系，让消息节点位于滚动条上方

## [1.0.87] - 2026-02-12

### Added
  - 添加了Anthropic格式里自适应思考模式和思考effort参数的配置支持
  - 添加了两个diff类工具：插入代码（insert_code），删除代码（delete_code）
  - 添加了diff类工具，自动应用diff时是否显示diff标签页的功能
  - 添加了diff类工具，diff警戒值的功能，只会在开启自动应用diff时显示
  - 添加了聊天界面右侧滚动条节点的功能，可以快速跳转和定位不同的用户消息
  - 添加了聊天界面用户消息的特殊显示，添加了淡蓝色背景，方便快速定位

### Improved
  - 优化了subagent内部的重试机制，改为静默，不再显示到外部

### Fixed
  - 修复了不同对话之间，输入框状态不隔离的问题
  - 修复了执行plan后，如果模型回答没有调用任何工具，导致todolist消失的问题
  - 修复了搜索替换工具点击查看差异按钮没有响应的问题
  - 修复了subagent工具，子代理内部调用ai报错时不重试的问题
  - 修复了subagent工具，子代理配置的工具列表不被使用的问题
  - 修复了不同对话之间，报错重试的串对话问题
  - 修复了顶部todo list的状态保存，不会再切换对话时总是展开，改为对话持久记忆
  - 修复了切换对话后，总是重新渲染文字显示的问题

## [1.0.86] - 2026-02-12

### Fixed
  - 修复了流式工具调用响应的显示问题

## [1.0.85] - 2026-02-11

### Fixed
  - 修复了获取模型列表的数量问题

## [1.0.84] - 2026-02-10

### Fixed
  - 修复了plan模式下，执行计划后todo list消失问题

## [1.0.83] - 2026-02-10

### Added
  - 初步添加了回合消息队列功能，在此基础上保留了立马发送消息功能和添加批注功能，可能有些bug

### Improved
  - 优化了路径高亮的显示，避免不存在的文件路径也显示可点击

### Fixed
  - 修复了通过plan模式创建todo list的显示和更新问题

## [1.0.82] - 2026-02-10

### Added
  - 添加了对话标签页功能，现在可以同时开多个对话任务
  - 添加了流式工具响应的显示功能

### Improved
  - 优化工具的处理和排队显示
  - 优化多工具响应时的显示性能消耗
  - 优化回退时，回退到的存档点的判断

### Fixed
  - 修复了diff保存时的竞态问题导致的显示内容不一致问题

## [1.0.81] - 2026-02-09

### Added
  - 当点击plan工具的执行计划按钮时，自动切换到选择的模式，默认使用code模式，且后续会记住选择的模式
  - 优化了diff工具同一标签页的预览，避免不刷新

## [1.0.80] - 2026-02-09

### Improved
  - 优化了subagent不必要的字段，不再发给ai
  - 优化了subagent的显示，不再显示外部面板
  - 优化了plan工具相关的交互
  - 优化plan工具，会自动打开标签页显示，并且**可以提前编辑其内容**
  - 优化了todolist的语言翻译问题
  - 优化了diff工具的实现，修复偶尔发生的换行查找失败问题
  - 优化了重试次数的统计，改为额外统计报错次数

## [1.0.79] - 2026-02-09

### Improved
  - 优化网络空回问题和报错

### Fixed
  - 修复todo列表导致的消息列表无法正确滚动到底部问题

## [1.0.78] - 2026-02-06

### Added
  - 添加了聊天记录里 文件路径高亮，代码行号高亮和点击跳转功能

## [1.0.77] - 2026-02-06

### Fixed
  - 修复读取非文本类文件时传入行号导致的问题

## [1.0.76] - 2026-02-06

### Improved
  - 优化了编辑框的显示
  - 去除了等待字体的首字母花体效果

## [1.0.75] - 2026-02-06

### Improved
  - apply_diff 添加兜底全局搜索替换机制

## [1.0.74] - 2026-02-06

### Improved
  - apply_diff：unified patch 支持“裸 @@”hunk 头（无行号）时自动退化为全局精确 search/replace 应用，提升兼容性
  - apply_diff 工具面板/历史预览：增强对“裸 @@ / 无前缀行”的展示兜底

## [1.0.73] - 2026-02-05

### Improved
  - 优化了todo工具和实现方式，请务必重置一下**所有模式的动态上下文模板**，以便使用todo list

## [1.0.72] - 2026-02-05

### Improved
  - 优化了新diff格式的提示词，减少失败概率

## [1.0.71] - 2026-02-05

### Added
  - 添加了新的diff格式，且默认使用新diff格式。新格式成功率更高，依旧可以在设置里使用旧格式

### Fixed
  - 修复gemini格式工具响应无法正常发送的问题

## [1.0.70] - 2026-02-04

### Added
  - 添加plan/build模式（测试版，暂时有很多bug）

## [1.0.69] - 2026-01-28

### Fixed
  - 修正diff配置的遗漏问题

## [1.0.68] - 2026-01-27

### Fixed
  - 修复配置未持久化问题

## [1.0.67] - 2026-01-27

### Improved
  - 迁移至 VSCode 原生配置以支持 Settings Sync

## [1.0.66] - 2026-01-24

### Fixed
  - 修复拖选添加文件时路径问题报错导致的添加失败

## [1.0.65] - 2026-01-24

### Added
  - 添加了代码块自动换行显示的功能

## [1.0.64] - 2026-01-24

### Improved
  - 优化前端显示历史消息，变得更流畅，避免全量加载

## [1.0.63] - 2026-01-24

### Improved
  - 移除了附件大小限制（仍可能受vscode本身限制）

### Fixed
  - 修复换行视图上移问题
  - 修复中断报错时的前端索引问题

## [1.0.62] - 2026-01-22

### Fixed
  - 修复子代理创建后无法删除的问题

## [1.0.61] - 2026-01-22

### Added
  - 添加了选中文件里某一部分添加到上下文的功能，可以在选中要添加的代码后，悬停在代码上面，或者点击左侧的灯泡添加到输入框中。后续会扩展更多其他的添加上下文功能

## [1.0.60] - 2026-01-22

### Improved
  - 拆分解耦了输入框组件，使其更简洁

## [1.0.59] - 2026-01-21

### Added
  - 添加了编辑消息面板的"@"菜单
  - 添加了附件消息文件内容的功能
  - 将拖拽和"@"菜单内容做成了两个功能，按住ctrl使用原来的添加路径提示词，不按ctrl则表示直接添加文件内容进提示词

### Improved
  - 重构了输入框的代码，现在可以支持插入更多模块的提示词了
  - 优化了添加文件时的图标显示，改成更符合其文件扩展名的图标

## [1.0.58] - 2026-01-20

### Added
  - 添加了使用"@"选择文件时，打开标签页的高亮显示和优先排序

## [1.0.57] - 2026-01-20

### Fixed
  - 修复ctrl+s保存后diff状态清除不完全的问题
  - 修复Latex公式显示问题

## [1.0.56] - 2026-01-20

### Improved
  - 重构了工具的状态和执行逻辑

### Fixed
  - 修复了思考内容的字体显示问题

## [1.0.55] - 2026-01-20

### Added
  - 添加了 Mermaid 图表 显示支持

### Fixed
  - 修复了生成图片时路径和图片格式不一致的问题

## [1.0.54] - 2026-01-19

### Fixed
  - 修复了"@"菜单里使用↑↓按键无作用的问题

## [1.0.53] - 2026-01-19

### Added
  - 添加了快速回顶/回底按钮，添加了滚动动画

### Fixed
  - 修复了获取模型列表时没有走设置的网络代理的问题

## [1.0.52] - 2026-01-19

### Added
  - 添加了外观设置面板，添加了等待的文字配置项，可以自己配置显示文字，而不使用Loading

### Improved
  - 优化了历史对话加载方式，改为分页加载，减少等待时间

### Fixed
  - 修复了前端中断消息时，流式动画未消失的问题

## [1.0.51] - 2026-01-19

### Added
  - 添加了diff时修改文件内容的支持，同时会告诉ai手动修改了哪些内容

### Improved
  - 优化了读取类工具的换行符读取，使用\n而不再是\r\n，会更节省token和上下文
  - 优化了等待ai响应的动画

### Fixed
  - 修复了写入文件，搜索内容两个工具的diff中断问题，并采取了更稳健和兜底的中断机制
  - 修复了ai使用apply diff工具没有输出行号时的兜底机制没有工作的问题
  - 修复了diff工具文字显示问题

## [1.0.50] - 2026-01-19

### Fixed
  - 修复总结上下文总是带全部历史的问题
  - 发送时过滤掉空的thought块，以格式更正确
  - 修复了发送消息时的token重复计数问题

### Improved
  - 优化了默认的动态提示词，请务必去设置-提示词页签里**重置一下动态提示词**

## [1.0.49] - 2026-01-18

### Added
  - 添加了diff的全部应用和部分应用功能。对于部分应用，可以通过点击diff视图左侧的小灯泡来应用对应部分的diff，或者通过右上角的按钮来一次性保存多个diff块

### Improved
  - 移除搜索的dryrun模式
  - 优化了diff类工具的显示和逻辑，使用统一的diff逻辑，包括apply diff，write file，search in file

### Fixed
  - 修复部分拒绝工具，切换对话、中断工具等复杂情况时的竞态问题
  - 修复需要批准执行的工具造成的索引问题
  - 修复了diff类工具多个diff块时的行号问题

## [1.0.48] - 2026-01-17

### Fixed
  - 修复子代理工具的文字显示问题

## [1.0.47] - 2026-01-17

### Added
  - 添加了子代理工具，现在ai可以分任务给子代理，可以在设置中自行添加不同的agent

### Improved
  - 优化了搜索替换工具的显示和工具定义
  - 优化了token计数api的调用，改为并行调用节省时间

### Fixed
  - 优化了oai response接口的请求体结构
  - 修复了部分工具调用结果拒绝时没有添加响应的问题

## [1.0.46] - 2026-01-16

### Added
  - 添加了模式选择按钮，现在可以自己修改并保存不同的系统提示词和动态提示词为模版并持久保存了

### Fixed
  - 修复ssh时拖拽固定文件路径的问题，以及拖拽ssh拖拽添加文件到输入框的路径问题

## [1.0.45] - 2026-01-16

### Fixed
  - 修复了MCP Studio类型的注册问题，测试使用python、npx、uvx均正常

## [1.0.44] - 2026-01-14

### Improved
  - 优化了动态提示词的插入算法，改为插入到回合之前，避免破坏回合完整性

## [1.0.43] - 2026-01-11

### Improved
  - 优化了提示词，由于提示词更新，所以尽量去前端提示词面板里**重置系统和动态提示词**

## [1.0.42] - 2026-01-11

### Added
  - 初步添加了动态skills功能

## [1.0.41] - 2026-01-10

### Improved
  - 优化了提示词，由于提示词更新，所以尽量去前端提示词面板里**重置系统和动态提示词**
  - 优化了裁剪上下文的逻辑

## [1.0.40] - 2026-01-10

### Improved
  - 优化了变量加载方式，改为在末尾，以便缓存命中，同时优化了提示词结构
  - 优化了前端提示词配置面板，以顺应新更改
  - 由于提示词更新，所以尽量去前端提示词面板里**重置系统和动态提示词**
  - 添加了版本更新公告功能

## [1.0.39] - 2026-01-10

### Fixed
  - 修复图像生成类工具的api调用不传递role的问题

## [1.0.38] - 2026-01-08

### Fixed
  - 修复cmd工具无法执行的问题

## [1.0.37] - 2026-01-08

### Fixed
  - 修复了报错后点击重试按钮无响应的问题

## [1.0.36] - 2026-01-08

### Fixed
  - 修复了搜索工具的显示内容问题
  - 修复了cmd终端类型引号参数问题
  - 修复了搜索工具无法指定单个文件内搜索的问题

### Improved
  - 优化了初始化时按钮的线程堵塞问题
  - 添加了加载历史对话的等待动画
  - 优化了一个大文件，进行了拆分解耦

## [1.0.35] - 2026-01-07

### Added
  - 添加了输入框里"@"选择路径功能

### Fixed
  - 修复中断后点击继续按钮无法继续问题
  - 修复工具显示问题
  - 修复工具分类问题
  - 修复裁剪上下文问题
  - 修复部分情况下思考签名的存储问题
  - 修复文件夹文件不显示末尾/的问题
  - 修复cmd运行问题
  - 修复中断后点击继续无响应的问题
  - 修复上面三种工具显示问题

## [1.0.34] - 2026-01-07

### Added
  - 添加了find_references、get_symbols、goto_definition工具
  - 添加了read_file工具带行号的阅读功能，这可能会导致旧对话旧的读取文件块显示异常，建议开新对话

## [1.0.33] - 2026-01-07

### Improved
  - 优化了两个大文件，进行了拆分解耦

## [1.0.32] - 2026-01-06

### Improved
  - 优化了oai-responses格式，使其更符合官方示例

## [1.0.31] - 2026-01-06

### Fixed
  - 修复终端工具编码显示异常问题

## [1.0.30] - 2026-01-05

### Added
  - 添加openai-responses格式对话和token计数支持

## [1.0.29] - 2026-01-01

### Changed
  - Myers 差分算法重构：`myersDiffLines` 从逐层拷贝 Map（O(D²) 内存）替换为公共前后缀裁剪 + 行 id 化 + Int32Array 状态数组；超预算自动降级为线性路径；全量重写大文件（5000+ 行）从数十秒降至毫秒级，不再阻塞 extension host
  - diff 警戒检测（`checkDiffGuard`）改用快速删除行统计 `countDeletedLines`：只计算编辑距离而不回溯全 diff 操作序列，每次创建 diff 预览时不再触发全文件差异计算
  - `computeUserEditedNewLinesSummary` 新增 500 行截断上限，防止超大编辑生成的摘要膨胀塞满模型上下文
  - 暂时回档到1.0.26

## [1.0.28] - 2025-12-31

### Fixed
  - 修复diff无法自动确认问题

## [1.0.27] - 2025-12-31

### Added
  - 支持工具确认后的分步批注提交

### Fixed
  - 修复总结对话后functionCall被错误裁剪

## [1.0.26] - 2025-12-31

### Fixed
  - 修复存档点问题
  - 修复自定义body时的合并问题

## [1.0.25] - 2025-12-26

### Added
  - 添加回退存档点二次确认功能

## [1.0.24] - 2025-12-26

### Added
  - 在工具确认界面支持读取输入框内容作为批注发送给 AI
  - 当有待确认工具时，发送输入框内容将自动触发“全部拒绝”并带上批注消息
  - 后端 ChatHandler 支持在处理工具结果前插入用户批注消息并重新计算 Token
  - 优化 diff 管理器：在非自动保存模式下，用户手动保存文件后自动关闭 diff 标签页
  - 前端chatStore 增加待确认工具检测逻辑及 rejectPendingToolsWithAnnotation 方法
  - 调整输入框逻辑，允许在工具待确认状态下发送文本内容

### Fixed
  - 修复输入框无法右键粘贴问题，简单模式”下，支持使用 a.b.c 这样的键名

## [1.0.23] - 2025-12-25

### Improved
  - 优化apply diff等工具的存储和显示以及实现

## [1.0.22] - 2025-12-23

### Fixed
  - 修复输入框以及长对话时卡顿问题，引入消息分页，每次多加载40条

## [1.0.21] - 2025-12-22

### Fixed
  - 修复oai格式流式响应中提取token计数问题

## [1.0.20] - 2025-12-22

### Fixed
  - 修复oai格式，Anthropic格式的工具调用格式和显示问题

## [1.0.19] - 2025-12-22

### Fixed
  - 修复终止按钮以及思考消息存储和前端显示问题

## [1.0.18] - 2025-12-22

### Fixed
  - 修复思考删除消息

## [1.0.17] - 2025-12-22

### Fixed
  - 修复文件扩展名识别问题，添加兜底机制
  - 修复空目录的增量备份问题

## [1.0.16] - 2025-12-22

### Added
  - 添加token计数api配置面板

### Improved
  - 大幅优化token计数方法
  - 大幅优化裁剪上下文功能

## [1.0.15] - 2025-12-21

### Fixed
  - 修复开关返回图片给ai时刷新多模态工具配置问题
  - 修复工具调用块里思维链存储和返回问题

## [1.0.14] - 2025-12-21

### Fixed
  - 暂时修复多工具确认问题

## [1.0.13] - 2025-12-21

### Fixed
  - 修复提示词的刷新规则，每次循环都刷新
  - 修复总结对话问题

## [1.0.12] - 2025-12-21

### Added
  - 新增发送前估算token功能
  - 新增额外裁剪功能
  - 新增发送历史对话思考时，控制发送对话轮数的功能

### Fixed
  - 修复历史思考签名回传开关的问题
  - 修复token计算问题，现在会实时裁剪上下文
  - 修复不同渠道的发送思考问题

### Improved
  - 优化了历史思维链回传说明
  - 优化了写入文件，应用差异工具的diff预览问题

## [1.0.11] - 2025-12-21

### Fixed
  - 修复工具格式和解析不匹配问题

### Improved
  - 优化了系统提示词

## [1.0.10] - 2025-12-21

### Improved
  - 优化了系统提示词

### Fixed
  - 修复抓包问题
  - 修复保存正文签名问题
  - 修复总结上下文后使用token不对问题
  - 修复裁剪上下文问题

## [1.0.9] - 2025-12-20

### Added
  - 新增单回合最大工具调用次数配置
  - 在工具设置面板中添加配置项，允许用户自定义每轮对话中 AI 最多可调用的工具次数
  - 默认值为 50，-1 表示无限制

### Improved
  - 优化工具设置面板的数字输入框样式，隐藏上下箭头按钮

### Fixed
  - 修复工具参数验证问题：强调所有数组类型参数必须使用数组格式（即使只有单个值）
  - 文件工具：read_file、write_file、list_files、delete_file、create_directory、apply_diff
  - 搜索工具：find_files
  - 媒体工具：generate_image、resize_image、rotate_image、crop_image、remove_background
  - 修复 AI 调用时出现 `Malformed function call` 错误的问题

## [1.0.8] - 2025-12-20

### Fixed
  - 修复增量存档，始终使用

## [1.0.7] - 2025-12-20

### Added
  - 新增自定义存储路径功能
  - 支持在通用设置中配置自定义存储路径，用于存放对话历史、存档点等数据
  - 支持路径验证和数据迁移功能
  - 可将现有数据迁移到新的存储位置
  - 为搜索工具添加替换功能

### Fixed
  - 修复上下文阈值在有总结消息时不生效的问题
  - 原逻辑：发现总结消息后直接从总结开始返回历史，跳过上下文阈值检查
  - 修复后：即使有总结消息，也会继续检查 token 数是否超过阈值，超过时会对总结后的历史进行回合裁剪
  - 修复 apply_diff 工具前端缩略视图行号始终从 1 开始的问题
  - 将 `start_line` 参数改为必填，要求 AI 必须提供准确的起始行号
  - 后端返回带有实际匹配行号的 diffs 供前端显示
  - 前端优先使用后端返回的 diffs 数据（包含实际匹配行号）
  - 修复diff差异工具的显示问题，优化diff工具的存储

### Improved
  - 优化大部分工具定义和响应
  - 改为使用增量备份功能
  - 添加更多md渲染支持

## [1.0.6] - 2025-12-19

### Fixed
  - 修复上下文总结功能发送给 API 时包含无效字段的问题（如 `functionCall.rejected`、`inlineData.id/name` 等内部字段）
  - 修复 apply_diff 工具前端面板中行号从 0 开始显示的问题，现在正确使用 `start_line` 作为起始行号

### Improved
  - 优化总结请求的字段清理，过滤思考内容和思考签名，保持与 `getHistoryForAPI` 一致的清理逻辑
  - 改进 apply_diff 工具的"查看差异"按钮功能，现在点击后在 VSCode 中显示完整文件的差异视图（包含完整代码上下文），而不仅仅是 search/replace 块
  - 改进切换对话时的自动滚动逻辑
  - 前端添加取消兜底机制，避免一直显示等待

## [1.0.5] - 2025-12-19

### Improved
  - 优化生图工具（generate_image）描述，添加提示说明生成的图片是实色背景而非透明底图

## [1.0.4] - 2025-12-19

### Fixed
  - 修复工具执行完成后点击终止按钮无法正常结束的问题（循环开始时检测取消信号后需发送 cancelled 消息给前端）

### Improved
  - 优化搜索工具（find_files、search_in_files）忽略问题，添加默认排除模式配置

## [1.0.3] - 2025-12-19

### Added
  - 添加了向 AI 发送诊断信息功能

### Fixed
  - 修复上下文感知页面保存问题

### Note
  - ⚠️ 旧版本使用者建议重置系统提示词以添加诊断信息功能

## [1.0.0] - 2025-12-19

### Added
  - 🎉 首次发布
  - AI 编程助手核心功能
  - 多模态支持
  - 对话历史管理
  - 多语言支持（中文、英文、日文）
  - MCP 服务器集成
  - 文件操作工具
  - 终端命令执行
  - 图像处理功能
