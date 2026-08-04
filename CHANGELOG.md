# Change Log

<!--
  ⚠️ 维护提醒：`## [Unreleased]` 小节无论何时都不应被彻底删除。
  它是未发布改动的收容区：新改动先记录到 [Unreleased]；发布时把内容整体移至对应版本小节，
  并保留一个空的 [Unreleased] 小节供后续使用。
-->

## [Unreleased]

## [1.4.0] - 2026-08-04

### Changed
  - SubAgent Monitor 运行列表改多行布局（用户反馈）：run tabs 从单行横向滚动改为 `flex-wrap` 自动换行，tab 在行内伸展铺满（`flex: 1 1 170px`），子 agent 数量多时不再横向翻找；限制最大高度约 3 行，run 极多时退化为纵向滚动，不占满整个面板
  - Diff 应用与展示性能重构：`apply_diff`、`write_file`、`search_in_files` 共用带编辑距离预算的 Myers 行级差分，移除 Webview 主线程上的二维 LCS 表和模板内同一 diff 最多 5 次重复计算；每个文件/块改为响应式缓存一次统计与行结果，超长展开内容通过 `VirtualDiffLines` 仅渲染可视窗口，降低大文件和批量替换时的 CPU、内存与 DOM 开销
  - 后端 diff 应用增加快速路径：互不重叠且唯一匹配的结构化 hunks 先规划位置并一次拼接文件，保留依赖前序修改、缩进容错和歧义场景的原逐块语义；unified patch 改为整块单次 `splice`，fallback 先按首行筛选候选再校验完整块，避免逐行修改数组和无条件嵌套扫描
  - 存档排除配置编辑器美化：设置页「自定义排除模式」与「每类别模式编辑」从裸 textarea 改为 chips 风格模式列表编辑器（`PatternListEditor`）——已有模式以标签卡片展示、悬停逐个删除，输入框回车添加、粘贴多行自动拆条去重，添加/删除即时保存；类别编辑面板补充标题栏与「清空（恢复默认）」按钮并补齐样式；自定义模式标签旁新增规则数量徽标；三语文案同步
  - 后台任务回流卡片新增三段式折叠视图（用户反馈）：默认折叠为两行省略，可切换「中展开（约 15 行内滚动查看）」与「完全展开」，三个图标按钮置于卡片头部右侧，当前视图高亮；配合后台回执完整内联修复，长报告不再撑满聊天窗口
  - 存档路径安全加固（审查 CP-DEL-1/CP-PATH-1/CP-RET-2）：删除、合并、manifest 读取路径统一经共享 `isSafeCheckpointDirName` 校验（`/^cp_[a-z0-9_]+$/i`），损坏/恶意元数据中的 `backupDir` 不再能触发 `fs.rm(recursive)` 递归删除存档目录外内容；恢复侧文案与失败摘要统一走 `t()` 并补齐 `modules.checkpoint.restore.*` 三语条目（checkpointNotFound / manifestMissing / cannotBuildChain / backupDirNotFound / moreFailures / excludedNote / excludedNoteChanged）
  - 索引删除补祖先闭包（审查 CP-IDX-1）：`deleteCheckpointsFromIndexInternal` 与批量删除（CP-05）对齐，从所有保留节点向前遍历完整基链，编辑+重试导致消息索引回退时不再删掉保留节点的基快照（不再产生永久断链存档）；预览返回 `deleted` 与 `deletedIfUnconfirmed` 两个计数，与默认执行口径严格一致（CP-09）
  - 存档配置保存链路加固（审查 EX-CFG-1/EX-12-1/EX-12-2）：`updateCheckpointConfig` 改为深合并落盘（部分 exclusion/messageCheckpoint 负载不再覆盖已保存的 profilePatterns 等嵌套字段）；`enabledProfiles` 值必须为 boolean（`"false"` 字符串不再被当真）、工具列表必须为字符串数组、`maxCheckpoints` 仅接受有限整数（保留 -1 无上限哨兵）、`enabled` 必须为 boolean；自定义模式拒绝 `*` / `**` / `/**` / `/*` 全忽略模式（新增 blanket 原因）
  - 强制排除大小写折叠扩展到 macOS（审查 EX-CASE-1/EX-CASE-2/CP-WS-1）：`.GIT` / `NODE_MODULES` 目录片段与扩展存储绝对路径自排除在 win32/darwin 大小写不敏感卷上不再可绕过，`normalizeWorkspaceUri` 同步折叠；符号链接不再静默丢弃，记录为 `unsupported_file_type` 排除条目供预览解释（CP-SYMLINK-1）
  - 用量索引并发丢失更新根治（审查高项）：`FileUsageIndexStore` 内部实现 per-conversation 写串行队列（appendUsage / appendUsageMessages / write / remove 全部入队，write 内按条目键去重），并行子代理与主会话的读改写不再互相覆盖；usage.json 改 tmp+rename 原子写；统计 listConversations 失败时跳过 prune 保留内存缓存；`fs.watch` recursive 增加递归能力探测，不支持时退化为 mtime 快照比对
  - 历史存储读一致性加固（审查中项）：`loadSegmentedHistory` 读后校验 `Σcount === totalMessages` 且段齐全（双 rename 提交窗口不再静默返回错位历史），读侧重试改为 2~3 次带退避；`getMessagesPaged` 初始页先只读浅扫描，仅存在悬空 functionCall 才走深拷贝路径（HIS-13 首屏收益找回）；M3 钳制改轻量只读 index（不再每条消息 O(段数) 次 stat）；删除会话后 append/mutate 短路（流式中删除不再"无 meta 幽灵复活"）；M4 自愈优先从可读段重建、totalMessages 重算为 Σcount、批量摘要返回 truncated 标志、段缓存增加字节软上限与按会话分桶失效
  - 前端设置页与 checkpoint store 加固（审查 H-1/H-2 等）：`updateConfigField` 保存失败回滚字段 + 保存串行化；`loadConfig` 失败时禁用表单并展示错误横幅（不再以默认值渲染导致真实配置被覆盖）；`checkpoint.restore`/`deleteBatch`/`previewExclusions` 超时豁免；失败路径重载 checkpoints；进度轮询瞬时错误不停止 + 陈旧检测 + 新操作重启；展开对话列表响应校验对话身份；批量删除失败保留列表 + 防重入；`mergeUnchanged` 仅保存成功才同步 chatStore
  - 恢复错误语义修正（审查 H-3）：恢复结果（失败/部分失败/未备份警告/成功）改用独立分级提示，不再塞入 `chatStore.error`；错误条「重试」按钮仅在可重试错误码（STREAM_ERROR 等）时显示，恢复失败后点击不再误触发 LLM 重新生成；恢复确认框固化 `conversationId`（预览/确认期间切对话不再恢复错误对话）；`previewExclusions`/`getAllConversationsWithCheckpoints` 加入非阻塞路由；`updateCheckpointConfig` 响应携带归一化配置供前端校正；checkpoint handler 补入参校验与明确错误码
  - 快照构建/查询收敛（审查 CP-DUP-1 等）：`runBounded`/`hashFileStreaming`/`isExcludedAbsolutePath` 三处重复实现收敛到共享模块（`checkpointConcurrency`/`fileHashing`/`checkpointPathUtils`，大小写策略统一）；排除预览 samples 按路径排序；设置页统计改有界并发 + `getMetadataLight`；`getCheckpoints` 区分「无记录」与「读取失败」；移除 `as any` 类型绕过
  - 消息稳定 ID 地基（BR-01/BR-02）：`Content` 新增 `id`/`parentId`，所有写入路径（append 锁内尾读、mutate 插入、functionResponse 补齐）统一经 `ensureNodeId` 生成稳定 ID + 线性 parentId；旧历史在首载/迁移入口按「缺 id 自判定」于会话写锁内确定性补 ID（uuidv5 风格，幂等：多次迁移 ID 集合一致）并原子全量重写一次（totalMessages 不变、指纹校验）；`formatHistoryForAPI` 白名单确认不下发 id/parentId；前端 parsers 透传 `content.id` 为 `Message.id`（跨加载稳定，不再每次生成）
  - 前端清理：`summarizeContext`/`cancelSummarizeRequest` 从 checkpointActions 迁入 messageActions（re-export 保持导出名兼容）；设置页存档项新增「排除详情」入口接通 `checkpoint.getManifest`（EX-11 前端缺口闭合，旧存档提示不可用）
  - 子 agent 嵌套能力（用户需求）：子 agent 现在可派生子子 agent（subagents 工具对子 agent 开放）——嵌套深度上限 2（主=0/子=1/子子=2）超限拒绝，深度由框架注入不可伪造；父 run 结束级联清理派生子 run；子 agent system prompt 追加使用说明（一般不需要，仅代码需独立复查或主模型明确指令时使用）；嵌套派发继承父级工具过滤（只读 agent 不能通过嵌套获得写权限）
  - 用户消息插入（A-COMM 二期）：主会话工具循环/流式中用户发消息不再排队等整轮结束——`chat.sendInterruptMessage` 投递到主会话 inbox，随最近一次工具调用结果一起注入给模型（10s/条频率限制、4000 字符上限、仅投递不落历史）；`sendMessage` 忙时自动改走插入路径
  - 树状分支接线（BR-05/06/07/09）：新建 `BranchService`（分支图读写删接口 getBranchGraph/getBranchGraphMeta/createRerollCandidate/editCandidate/switchBranchCandidate/deleteBranchCandidate、`validateActivePathMatchesHistory` 活跃路径校验、BR-09 跨对话导出建模 exportedFrom/exportedRefs、`importLinearHistory` 线性导入）；`BranchHandlers` 注册 5 个分支 API；`ConversationManager` 暴露 `runExclusive` 公共锁包装（锁序文档化）、`createBranchConversation` 记录 sourceNodeId + 图初始化/导出标注、`deleteConversation` 清理 sidecar；`switchBranchCandidate` 明确不重写主历史（边界留给 TREE-06）
  - 迁移与完整性（MIG-04/05）：新建 `BranchMigration`（逐版本迁移注册表 + 链式升级 + 升级前深拷贝失败回滚 + 原子落盘 + 损坏拒绝覆盖）；新建 `backend/tools/maintenance/integrityCheck` 只读完整性检查（历史 Σcount/段齐全/孤儿段、存档 backupDir/manifest/增量链 base+环、分支 validate + 活跃路径与主历史对比，只报告不修复）；R8e 复查后分支对比降级为 warning（回收条件注释随 TREE-06/09 落地更新）
  - 候选切换全链（TREE-04/06）：`ConversationManager.rewriteHistoryFromBranchGraph`（会话写锁内从图活跃路径重建主历史：决策 8 FR 拆分、幂等、分歧索引、用量重建 + trim 失效）+ `BranchHandlers.switchBranchCandidate` 全链编排（切图 → 主历史重写 → 锁外检查点清理 → rewritten 标记，失败回滚图状态）；R8a 复查后补：FR 消息 id 按「节点 id + FR part id 集」复用旧历史 id（防幂等失效与检查点误删）、invalidate 移至 saveHistory 前（metadata 写失败不再分裂图/历史）、切换前锁内历史/图尾部一致性检测（不一致拒绝切换返回 BRANCH_OPERATION_CONFLICT）
  - 树状分支前端（TREE-07/10/11/12）：`branchActions.ts`（切换成功后重载历史 → 重建 messageIndexById/toolResponseIndex → 清理错误条/流式残留 → TODO/Build 重置 → 刷新检查点与分支图，失败快照回滚，BRANCH_BUSY 前端双保险）；`BranchSwitcherBar.vue`（‹ 2/3 › 循环切换 + 候选下拉 + 两步确认删除，无分支图自动隐藏）；`BranchTreePanel.vue`（分支树浮层面板：本地 DFS 组装 + 活跃路径高亮 + 软删灰显/恢复 + 行内重命名）；标签页快照保存 branchGraph（修复切标签页残留旧图）
  - 用量含全部分支（TREE-08）：方案 A 读取时合并——统计读取时经 `readBranchGraph` 读 branches.json，主历史消息 id 为权威去重键（图活跃路径仅作旧索引无 id 时兜底），非活跃候选 token 以 `source='branch'` 并入各维度 + `inactiveBranchTokens` 细分；R8 复查后补：混合态索引去重修正（historyIdsComplete 判定）、候选节点携带 usageMetadataPartial（中断候选按估算口径）
  - 分支管理（TREE-09）：软删除（deletedAt + 保留期默认 30 天可配置 + **级联软删/恢复整棵子树**——R8 复查修复 prune 静默移除 live 子孙的数据丢失高危）、重命名（renameBranchCandidate 仅改 label）、修剪（pruneDeletedBranches 过期节点+子树物理清理）、purgeBranchCandidate 彻底删除（幂等化）、getDeletedBranchCount 与 prune 孤儿口径统一；设置页新增 `BranchCleanupSettings.vue` 区块（软删数量/一键清理/保留期输入，三语文案）；switch 目标到 root 链上软删节点校验返回 BRANCH_OPERATION_CONFLICT
  - 性能基准（MIG-09）：`test/benchmark/`（.benchmark.ts 后缀 + --testMatch 显式运行，普通测试不执行）——2000 文件快照创建 0.3s/恢复 0.7s、1 万条历史 append 0.9s/读取 27ms/用量 12ms、100 候选图操作全亚毫秒（R8e 后含漂移恢复测量与 102 层深链场景，smoke 上限按实测 10-20× 收紧，harness 输出 GC 可用性并做 JIT 预热）
  - 分支-存档联动（BCP-02~08）：`bindWorkspaceCheckpoint`（节点绑定 workspaceCheckpointId/workspaceState，工具执行存档点 fire-and-forget 接线）；切换双模式（chat-only/chat-and-workspace——决策 1，编排：安全校验→dirty 闸门→取消流→预览→恢复（失败不切分支）→切换，锁序「恢复先于切图」）；**dirty 文件拦截**（决策 11：WorkspaceRestoreGuard 统一拦截普通恢复与切换，未保存内容不再被静默丢弃）；判据富化（hasWorkspaceState/wroteToWorkspace）+ 前端双按钮确认（三语）；引用计数清理（checkpointRefCounts 扫描 + deleteCheckpointsByNodeIds 三重闸门 + purge/prune 联动，软删不触发）；决策 12 不做内容哈希去重（增量链共享 4 测试固化）；BCP-08 一致性矩阵 26 场景盘点；MIG-02/03 核实旧存档 manifest 兼容与 ignorePatterns 合并口径已覆盖
  - 大文件拆分（CPF-12 落地）：`CheckpointManager` 2413→1687 行，恢复侧文件操作与辅助平移至 `CheckpointRestoreService`（722 行，prepareRestore/legacy 恢复/过滤/哈希收集/排除说明等 12 方法）与 `WorkspaceEditorRefresher`（94 行）；`CheckpointSettings.vue` 3284→2263 行，script 拆为 5 个 composable（useCheckpointConfig/useCheckpointExclusion/useCheckpointCleanup/useCheckpointOperationProgress/useCheckpointManifest）；`SettingsManager` 2347 行拆为门面 + SettingsCore + 14 个主题服务，`settings/types.ts` 2419 行拆为 11 个主题类型文件 + 聚合入口（公共导出零变化，纯重构）

### Added
  - 新增共享行级 diff 算法与虚拟行组件测试，以及结构化/unified diff 应用回归测试，覆盖大文件预算降级、公共边缘裁剪、顺序依赖与 relocated hunk fallback
  - 新增 agent 间消息通信（用户设计）：`agent.sendMessage` 工具 + 内存 mailbox（会话限定 + 已知 runId 防冒充、threadId + hopDepth 5 跳防循环）——收件方在**最近一次工具调用结束后**把 inbox 消息追加到工具结果之后随结果返回（主会话工具循环 5 处调用点与子代理执行器均接入），run 结束自动清理；配套信箱与注入点测试 34 用例；用户消息插入与对话删除接线作为二期方案
  - 新增树状分支底座（BR-03/BR-04/BR-08 初版）：`backend/modules/conversation/branch/`——`BranchGraph.ts` 纯函数模块（insertNode / rerollCandidate / editCandidate / activePath / rebuildActivePath / childrenIndex / validate，含环检测）、`BranchGraphRepository.ts`（branches.json 原子写、损坏抛 BRANCH_STORAGE_CORRUPT、删除对话清理）、`types.ts`（ConversationBranchGraph / ConversationBranchNode / BranchErrorCode；functionResponse 不独立成节点、kind 含 exported、单 parentId 索引 + activeChildId）；配套纯函数与仓储单测 61 用例
  - 审计修复核对与测试补齐（F-01/F-02/F-03/F-05）：确认 xmlFormatter 防御配置、toolResponseFormatter 部分成功序列化、SubAgentRegistry.isEnabled 修复已在提交 3bfab33 就位；`promptToolParser.test.ts` 补齐 DOCTYPE 实体不展开与超深嵌套拒绝两项安全用例；新增 `toolResponseFormatter.test.ts`（文档 5.6 节 10 项全覆盖）与 `subagentRegistry.test.ts`；各修复批次新增回归测试（损坏 backupDir 删除拒绝、索引回退不断链、manifest LRU、锁排队取消、大小写绕过、深合并保留、用量并发、双 rename 读一致性、删除复活、设置页保存回滚/加载失败等）
  - 本轮新增测试：子 agent 嵌套（15 例：深度限制/父过滤传播/级联清理）、用户消息插入（8 例：忙时投递/频率限制/失败回退）、分支接线（BranchService 23 + BranchHandlers 6 + BranchGraph 扩展 5）、迁移与完整性（BranchMigration 15 + integrityCheck 32）、复审修复（用量重建/队列超时/重读校验/原子化 9、agentInbox 剥离 11、错误码与重试 8、前端 UX 9、嵌套权限逃逸回归 等）

### Fixed
  - 修复 SubAgent Monitor 面板抢走 diff 预览位置（用户反馈）：`vscode.diff` 不带 viewColumn 时在「当前活动编辑器组」打开，焦点在 Monitor（Beside 列）时 diff 会开在 Monitor 旁边而非主聊天侧；现在 Monitor 路由上下文下发 `diffViewColumn`（经 tabGroups 按 viewType 定位主聊天所在列，侧边栏时回退主区域第一列），`openDiffView` 显式传 `viewColumn`——无论焦点在哪，diff 都固定跟随主聊天所在列；`HandlerContext` 新增 `diffViewColumn` 字段，主聊天自己发起的 diff 行为不变
  - 修复前台 SubAgent 转后台（detach）机制的三处残留缺陷（复查 R7c）：① 循环顶部/工具执行前/启动检查三处取消判定仍裸读父 abortSignal，转后台的 run 在后续迭代或工具调用前仍会被旧流 abort 杀死（绝大多数真实场景失效）——统一改为 `parentAbort()`（detached 后视为无父信号）；② 排队期间 detach 后，acquire 成功时启动检查与超时桥（对已 abort 信号注册的 onParentAbort）仍会杀掉 run——超时桥注册加 `!detachedFromParent` 保护；③ detach 把 acquire 桥的 run 控制信号监听一并移除，排队中已转后台的 run 失去 Monitor 终止响应——acquire 桥拆分父信号/控制信号两部分，detach 只摘父信号；新增回归测试（多轮迭代继续执行、排队-detach 继续执行）
  - 修复用户发消息时前台子 agent 被连带杀掉（用户实测）：此前新流启动（StreamAbortManager.create）会 abort 旧流，而前台 SubAgent 的 abort 信号挂在主会话工具循环上，旧流取消会连带终止还在干活的子代理；现在 `SubAgentRunController` 增加 `attachedToParent` 标记与 `detachFromParent`（转后台）能力——`StreamAbortManager.create` 在 abort 旧流**之前**先把该会话活跃前台 SubAgent 转为后台（executor 同步解绑父 abort 信号的组合监听、排队唤醒桥与超时桥），run 继续执行至完成，结果经 Monitor/事件总线呈现（广播 `run_detached` 事件）；后台 run（attachedToParent=false）不受影响，保留 TaskManager 取消能力；新增回归测试 11 例（runController detach 语义 5、StreamAbortManager 转后台矩阵 4、executor 集成含对照组 2）
  - 修复后台子 agent 完成消息被截断（用户实测）：`buildSubAgentSection` 此前把后台 SubAgent 最终报告按 4000 字符截断，并以 `[Truncated N more characters. Open Monitor to view the full transcript.]` 收尾，而 Monitor 是人类 UI、主模型没有访问路径，研究/审查报告被腰斩（前台不传 background 的回复完整，因 functionResponse 无截断）；现在回执完整内联结果正文，与前台载荷同规格——完整结果本就要经 postMessage 转发给 Monitor（现状无截断），回执再经 chatStream 与普通用户消息同路径发送，无新增载荷上限；新增回归测试锁定超长报告不再截断
  - 修复 manifest 缓存无界与锁队列不可取消（审查 CP-CACHE-1/CP-LOCK-1/CP-LOCK-3）：manifest 内存缓存改 LRU（上限 32）且 `getManifest` 读后即弃；工作区锁排队等待响应取消信号（abort 时移出队列）；同 owner 超集重入改为运行时 fail-fast 而非静默排队死锁
  - 修复存量并发与一致性缺陷：RetentionService 清理以删除返回值为准、对多依赖者循环合并；updateSummary 不再多余写入 `updatedAt`（列表排序不再抖动）；`loadCheckpoints` 失败保留旧值；`trimWindowFromTop` 窗口裁剪不再永久丢弃窗口外检查点；恢复确认框取消时清理选中残留；前端 `restoreAndEdit` 失败补重载兜底
  - 修复恢复/预览性能残留（审查 CP-PERF-1/CP-LOCK-2）：`collectCurrentWorkspaceState` 与 legacy 恢复哈希从顺序读盘改为共享模块有界并发流式哈希；`previewRestore` 经 `runExclusive({ needFileLock: false })` 只取工作区级互斥，不再持有全局文件写锁阻塞全部写工具
  - 修复恢复顺序与进度（审查 CP-ORDER-1/CP-PROG-1）：恢复改为「先复制（含哈希校验）→ 全部成功后最后删除」，复制失败不再留下「已删未补」中间态；删除阶段逐文件上报进度，进度 total 覆盖删除 + 恢复全量
  - 修复复审轮发现的高危问题：用量索引全量重建改为队列内基于最新盘面执行（并发 main 条目不再被覆盖丢失）；`agentInbox` 在落盘前剥离（不再随历史每轮重放给模型）；错误条重试白名单并入后端真实可重试错误码（API/NETWORK/TIMEOUT/PARSE，排除 CANCELLED/CONFIG/VALIDATION 与 RESTORE_*——B7 引入的重试回归修复）；只读预设嵌套派发权限逃逸修复（嵌套继承父级工具过滤、无写工具 agent 移除 subagents、空工具集拒绝一切）；`retryFromMessage`/`editAndRetry` 删除或编辑 IPC 异常路径不再继续重试（历史不重复、本地与后端一致）；`rejectToolCalls` 读改写原子化；`deleteConversation` 纳入会话写锁（删除复活闭环）；段读取后重读 index 版本比对（双 rename 窗口错位历史被检出）；`enqueueWrite` 挂起超时；统计缓存回填含 subagent 合并条目

## [1.3.2] - 2026-08-04

### Changed
  - 存档点创建/恢复主流程切换到新架构：创建改用 `CheckpointSnapshotBuilder`（多根工作区扫描、强制排除存档目录自身、流式哈希 + 有界并发、stat 复用），恢复改用 `CheckpointRestoreEngine`（增量链文件索引 O(1) 查询、scoped 路径安全解析、失败清单区分 missing_in_chain / hash_mismatch / copy_failed / delete_failed）；新存档记录工作区身份（`workspaceRoots` / `workspaceFingerprint`），恢复前校验当前工作区，跨项目恢复被明确拒绝；新存档备份目录改用 scoped 布局（`cp_xxx/ws_xxx/relative`），多根工作区同名文件不再互相覆盖；旧格式存档（相对路径键 + 旧布局）单根恢复保持兼容，多根下明确拒绝而非静默错恢复；存档创建/恢复进入工作区级互斥锁（等待进行中的写工具退出并阻止新写入），恢复失败路径转相对路径展示
  - 用量统计性能再优化：统计读取元数据改为轻量路径（只读 `{id}.meta.json`，不再走 `getMetadata` 的历史完整性检查——此前每次统计都会为每个对话额外加载一次历史，索引优化的收益被抵消大半）；新增对话目录监听（`fs.watch` recursive）+ 内存明细缓存——任何历史/元数据/索引文件写入都会把对应对话标记为 dirty，统计只重读 dirty 对话并回填缓存，其余对话直接重放内存明细（零 stat、零读文件），日常统计从几千次跨进程文件调用降到毫秒级；统计自身重建索引写入 `{id}.usage.json` 会触发一次自伤标记，下一轮重读小索引文件后自然恢复，不会无限循环；扩展 dispose 时释放监听，非文件存储（测试/内存适配器）自动退化全量扫描；新增缓存命中跳过读取 / dirty 重读回填 / 已删对话清理 / 缓存时间筛选与 watcher 文件名解析测试
  - 提示词设置页排版重排（PR #5）：动态上下文保留策略区块从全局固定位置移入对应的模板模式内——预设条目模式下显示在条目编辑区下方，传统模板模式下内联显示在动态模板文本框下方，选项归属不再让人困惑；新增「可用变量参考」可收缩面板（默认收起，静态变量组 / 动态变量组分组展示，chevron 展开收起），长变量列表不再永久占据设置页空间
  - 提示词模式栏新增保存按钮（绿色保存图标，保存中切换为 loading 动画），与底部原保存按钮并存；导入 / 导出按钮从 codicon 通用图标改为成对的自定义 SVG 图标（方向相反的导出/导入箭头），视觉上明确为一对操作
  - 提示词页保存 / 导出 / 导入反馈统一为浮窗 toast（成功 / 失败着色，2.5 秒自动消失，Transition 动画），移除底部行内文本提示（saveMessage）
  - 存档点文件哈希改为流式读取（`CheckpointManager.getFileHash` / `computeFileHashes`），不再把大文件整体 `readFile` 进内存，哈希结果不变
  - 默认启用存档的写工具列表补齐（CP-13）：新增 `insert_code`、`delete_code`、`search_in_files`（replace 模式）、图像处理（`remove_background` / `crop_image` / `resize_image` / `rotate_image`）与文档类（`create_plan` / `update_plan` / `create_design` / `update_design` / `create_progress` / `update_progress` / `record_progress_milestone` / `create_review` / `record_review_milestone` / `finalize_review` / `reopen_review`）默认在执行前/后创建存档；`search_in_files` 纯 search 模式（非 replace）不再创建全工作区存档
  - 恢复检查点前主动取消该对话的流式请求与关联的活跃 SubAgent（CP-04/CP-12），防止恢复后迟到 chunk 污染历史、SubAgent 继续写文件与恢复结果冲突
  - 存档排除功能上线（EX-01~EX-12）：`CheckpointIgnoreResolver` 升级为四层排除模型——强制排除（`.git` / `node_modules` / 扩展存储根绝对路径，`!` 不可否定）→ 默认排除类别（8 类，设置页可分别开关，可被 `!` 重新纳入）→ 嵌套 `.gitignore`（anchored + 否定 + 目录作用域）→ 用户自定义模式（独立最终求值阶段，最后生效）；`shouldIgnore` 返回 `{ignored, reason, rule, source}`，快照构建输出完整 `excluded` 清单（含命中规则文本）与排除统计；单文件大小上限默认 50 MiB（0 = 不限制），超限文件记录 `reason: 'size'` 不静默消失；存档记录与 manifest 保存排除规则快照 `ignoreSnapshot` 与 `excludedCount/excludedBytes`，恢复时对比快照规则与当前规则输出 `excludedNote`（含 `rulesChanged`），且恢复过滤严格按当前规则（不因旧规则宽而覆盖当前明确忽略的文件）
  - 存档排除设置与预览（EX-08/EX-09）：`CheckpointConfig.exclusion`（enabledProfiles 全开 / maxFileSizeBytes 50MiB / customPatterns，兼容旧 `customIgnorePatterns` 合并）；设置页新增默认类别开关、大小上限输入、自定义模式编辑器与「预览排除结果」按钮（按类别聚合展示、samples 上限 50、命中 reason/rule/source、被排除目录有界遍历 2000 项且 `complete=false` 标记）；新增 `checkpoint.previewExclusions` / `checkpoint.getExclusionProfiles` handler；配置校验拒绝空模式、绝对路径（盘符/UNC）、纯 `!`、`..` 越界、换行注入、未知类别 id 与非有限数值
  - 排除语义细节：win32 下强制排除绝对路径比较统一小写归一（防 `C:\Proj` vs `c:\proj` 大小写漏排）；「重新纳入目录类别下文件需同时否定目录本身（如 `!data/ + !data/keep.txt`）」在设置页给出提示；自定义模式不再被嵌套 `.gitignore` 覆盖（见 Fixed）
  - 每类别排除模式可编辑（用户需求）：设置页每个默认排除类别新增「编辑模式」按钮，可覆盖该类别的默认模式清单（每行一个 gitignore 模式，清空保存 = 恢复默认清单）；配置新增 `profilePatterns`（profileId -> 模式清单），`collectEnabledProfilePatterns` / resolver 按覆盖优先解析，并随规则快照写入 manifest（恢复说明口径一致）；保存校验复用 EX-12 规则（未知类别 id / 非字符串数组 / 非法模式均拒绝）；新增覆盖/回退/快照深拷贝测试 3 用例

### Fixed
  - 存档恢复边界显式化：只删除目标快照 `fileHashes` 中记录过的路径（#29 语义），快照后新建、快照时被忽略/未备份（复制失败、大小超限、不可读）的文件恢复时不会被静默删除；恢复/创建期间与写工具互斥，避免快照与文件写入竞态
  - 修复批量删除增量链断链（CP-05）：旧实现只检查「被保留检查点直接引用」一层，链 A→B→C 删除 {A,B} 时 A 被删而 B 保留，B 恢复时断链；现在从所有保留节点向前遍历完整祖先链，被直接或间接依赖的祖先全部强制保留并返回 rejectedIds
  - 存档删除/合并操作接入工作区级互斥锁（CP-03）：删除、按索引删除、批量删除与创建/恢复互斥；`CheckpointOperationLock` 支持同 owner 相同工作区集合的可重入（引用计数），create 锁内清理旧存档（cleanupOldCheckpoints → deleteCheckpoint）不再嵌套等待自己而死锁
  - 修复回档并重试 / 回档并删除时后端删除失败仍继续执行（CP-11）：前端 `deleteMessage` 返回失败或抛错时中止后续重试/流程并展示明确错误，不再出现「前端已截断而后端历史残留」的静默不一致；后端各删除路径的磁盘删除失败不再完全静默，记录 warn 便于排查（元数据已正确移除，残留目录为孤儿目录不影响正确性）
  - 恢复结果新增未备份文件提示（CP-08/CP-10）：`restoreCheckpoint` 返回 `unbackedPaths`（快照时大小超限/不可读/复制失败的文件，恢复时受保护不会被删除），前端恢复确认后展示失败/部分失败/未备份文件清单；设置页批量删除展示被依赖保留与删除失败的数量
  - 新增恢复预览确认流程（CP-09）：所有恢复入口（普通恢复 / 回档并重试 / 回档并删除 / 回档并编辑）先调用 `checkpoint.previewRestore` 计算恢复计划（将恢复/删除/跳过数量 + 待删除文件清单），确认框展示清单后才执行真正恢复；待删除文件区分「快照记录过」（#29 白名单）与「快照后新建」（默认保留，用户确认后一并删除，实现「撤销工具新建文件」语义）；`RestoreEngine` 提取纯计算函数 `computeRestorePlan`，预览清单与实际执行的删除严格一致；`restoreCheckpoint` 新增 `deleteUntrackedFiles` 选项，未确认时保持原有保护语义不删除任何快照后新建文件
  - 恢复确认流程安全加固：`restoreAndRetry` / `restoreAndDelete` / `restoreAndEdit` 的「删除快照后新建文件」改为调用方（确认框）显式传参确认，默认 false——绕过确认框的调用不会静默删除文件；回档三连中 `deleteMessage` 失败时不再只提示，而是重新加载历史拉回前端窗口与后端一致；恢复确认框取消时清理暂存的预览动作状态；预览期间恢复按钮显示 loading 并禁用
  - 存档维护改进：`pruneMissingBackupCheckpointRecords` 顺带清理孤儿备份目录（磁盘存在但无任何记录引用，如删除失败/崩溃残留，仅处理 `cp_*` 格式目录）；设置页存档详情展示「N 个文件未备份」（悬停显示路径清单，去除工作区作用域前缀）；`CheckpointOperationLock` 可重入放宽为「请求集合是已持有集合的子集即放行」，嵌套调用更不易死锁
  - 深度审查修复：快照强制排除范围从存档目录扩大为整个扩展存储根（自定义数据目录位于工作区内时，memory/conversations 等扩展数据不再进入存档）；恢复时「删除多余空目录」纳入 `deleteUntrackedFiles` 确认控制（快照后新建的空目录默认保留，#29 语义，预览清单一并展示）；legacy 存档预览返回 `legacy` 标记，前端展示「恢复以备份内容为准」避免误判「无变更」；恢复确认框打开期间恢复按钮禁用，防止重复点击覆盖确认内容
  - 修复增量链恢复索引错误：增量节点磁盘上只保存 `changes` 里的文件，但恢复索引此前把该节点完整 `fileHashes` 都指向其目录，导致未变化文件恢复时报 `missing_in_chain`；现在按 `changes` 限定节点备份边界，未变化文件从更早节点（base）恢复
  - 修复存档路径安全缺口：备份源目录（`backupDir`）来自存档元数据，损坏数据可含 `..`/绝对路径，现在恢复时校验备份源必须位于存档根目录内（越界视为链上缺失）；恢复目标路径全程做符号链接/junction 检查（`resolveSafePathInsideRoot`），链接不能绕过工作区边界
  - 修复旧版存档（无 `fileHashes`）恢复安全隐患：多根工作区下明确拒绝（旧记录无工作区身份，无法确定文件归属）；单根恢复以备份目录实际内容为目标、绝不删除当前工作区任何文件（旧记录没有“快照时可见”清单），替代此前“删除备份里没有的所有文件”的危险行为
  - 修复同一对话切换工作区后增量链错乱：新存档识别到工作区指纹不一致时从新的完整备份开始（断开旧链），不再跨工作区串接增量
  - 部分恢复失败时返回 `error` 摘要（前 5 条路径+原因，超出计数），前端 `restoreCheckpoint` 类型同步补充 `failures` 字段
  - 修复流式报错后重试残留半截回答：流式过程中后端报错时，后端不会持久化半截 assistant 消息，但前端窗口会保留有内容的半截消息，点击错误通知上的「重试」（`retryAfterError`）之前不会清理，导致重试后窗口/历史出现半截回答残留，且与后端历史错位；现在 `handleError` 会记录失败半截消息 ID，`retryAfterError` 重试前回滚（删除窗口消息 + 清理检查点 + 防御性同步删除后端），错误条「关闭」按钮与发送新消息也会一并清理失败残留，工具响应后的「继续对话」语义不受影响（不删除正常历史）；新增回归测试 12 用例（frontend `streamErrorRetry.test.ts`）
  - 修复动态上下文策略选项的误导性括号标注：单份模式选项原先带有「（当前策略）」（zh-CN）或「（当前行为）」（en/ja）注释，而该选项与保留模式是并列可切换的，标注「当前」会让用户在切换后看到错误的归属语义；现在移除括号注释，三语统一为中性文案「单份动态上下文 / Single dynamic context / 単一の動的コンテキスト」
  - 修复动态上下文策略警告文案硬编码英文：设置页选中保留模式时提示「preserve 会把旧回合的动态快照固定插回原位…」，而选项在 UI 上显示的是中文「保留旧动态上下文原位」，用户无法把二者对应；现在句首直接使用选项的中文名称，不再出现英文标识
  - 修复空提示词保存后回退默认模板（PR #5）：`resolvedMode?.template || promptConfig?.template`（PromptManager.ts）与 `mode?.template || ...`（SettingsManager.getSystemPromptTemplate）的空字符串回退导致 legacy 模式显式保存的空模板在运行时被全局模板覆盖，用户无法真正清空模板；两处改为 `??`（nullish coalescing），空字符串原样保留；前端 `loadModeConfig` 同步用 `typeof === 'string'` 判断而非 `||` 兜底，空模板不再被 DEFAULT_TEMPLATE 顶替，新增回归测试锁定该行为
  - 修复提示词导出流程不可控（PR #5）：前端 Blob 下载在 webview 环境保存位置与文件名不受用户控制，改为通过新增的 `exportPromptModes` webview handler 调用 `vscode.window.showSaveDialog` 让用户选择保存位置，确认后才写文件；取消保存对话框时不写文件并返回 `{ success: false, cancelled: true }`，成功后才报告成功；导出成功 / 取消 / 失败均有明确反馈，不再出现「已导出但不知道存到哪」
  - 修复恢复路径未接入四层排除模型（审查 H-1）：恢复时的目标状态过滤与当前工作区状态收集此前只走 `.gitignore` + 旧 `customIgnorePatterns` 两层，恢复可能把文件写回当前明确排除的路径（`dist/`、`data/`、超过大小上限的文件）或删除当前应排除的文件；现在 `createIgnoreResolver` 统一构造完整四层规则（强制排除含扩展存储根、默认类别、嵌套 `.gitignore`、新旧自定义模式合并），`filterRestoreTargetScoped` / `collectCurrentWorkspaceState` 与快照构建同一口径，恢复不再触碰当前明确排除的路径
  - 修复空增量节点恢复必失败（审查 H1）：增量链索引构建时 `changes` 为空数组的节点（工具执行但无文件变化的 before/after 存档）被当作完整节点，其全部哈希被指到自己的空备份目录并覆盖更早节点，恢复任何漂移文件都报 `missing_in_chain`；现在区分「未提供 changes（完整节点）」与「空数组（空增量节点，不索引任何文件）」，空增量后的恢复由更早节点提供文件
  - 修复跨格式合并断链（审查 M6）：容量清理把 legacy 布局（`cp_xxx/relative`）被清理节点并入新格式后继时，文件被原样复制到后继根目录且不写进 manifest，恢复时 `missing_in_chain`；现在按后继 scoped 布局重写路径（`ws_xxx/` 前缀）再复制，并把合并文件的 scoped 键并入后继 manifest.files（hash 取自被删节点），legacy→新格式过渡期清理不再破坏可恢复性
  - 修复存档取消竞态与锁等待裸异常（审查 M4/M5）：取消发生在等待文件写锁期间时，锁管理器抛普通 Error 从 `runExclusive` 漏出并冒泡到工具循环中断整轮执行；现在 create/restore/deleteAll/deleteBatch 外层捕获锁取消错误转为取消结果；取消发生在复制完成、元数据落盘之前时检查点仍会被保存且进度被 `done` 覆盖——现在写 manifest 与写会话元数据前检查 `throwIfAborted`，进度终态改为 `signal.aborted ? 'cancelled' : 'done'`
  - 修复排除规则对比漏类别开关（审查 M3/M-4）：`rulesChanged` 只比较大小上限与自定义模式，设置页仅开关默认类别（如关闭 logs）时恢复说明误报「规则未变化」；现在同时比较键排序后的 `enabledProfiles` 与规则版本号
  - 修复自定义排除模式被嵌套 `.gitignore` 双向覆盖（审查 M-1）：自定义模式与默认类别原先注入根作用域 matcher，嵌套 `.gitignore` 可否定自定义层的 `!` 规则或反过来；现在自定义模式从作用域链拆出，作为所有作用域求值之后的独立最终阶段（强制排除仍不可覆盖），「设置页规则最后生效」与计划语义一致
  - 修复排除预览 `complete` 谎报（审查 M-6）：主扫描遇到不可读目录时静默跳过且 `complete` 仍为 true；现在不可读目录产出 `unreadable` 排除条目并置 `complete=false` 计入统计
  - 修复恢复说明与未备份提示回归：`rulesChanged` 与 `excludedNote` 补全后恢复说明准确；存档摘要（`CheckpointSummary`）化后设置页「N 个文件未备份」提示丢失——摘要补齐 `unbackedPaths` 相关字段，前端悬停提示恢复
  - 修复 append-only 崩溃恢复后计数永久不一致（审查 H1）：尾段 rename 成功但 index 写失败/崩溃时残留行会在下次追加被并入段计数，`index.totalMessages` 与各段 count 永久相差、全量读与分页读口径不一；现在尾段读取后先按 index 提交点截断（`slice(0, count)`）再拼接新内容，at-most-once 语义下重试不重复，崩溃残留不会泄漏
  - 修复元数据文件损坏导致列表 UNKNOWN_ERROR（真实故障）：`saveMetadata` 原为非原子 `writeFile`，写入中途崩溃/断电即截断 `{id}.meta.json`（如 24MB 大文件），读取时 `parse_error` 抛到前端阻塞对话列表；现在元数据写入改为临时文件 + rename 原子替换（index 式提交点），`getMetadata` 遇 `parse_error` 时把损坏文件改名备份为 `.corrupt-*`（只保留一份）并从历史时间戳重建 fallback 元数据返回，不再向上抛错（存档记录列表随损坏文件丢失属降级代价，磁盘 `cp_*` 备份目录不受影响且不会被自动清理）
  - 修复完整性检查两类误判（审查 M1）：legacy 单文件历史只 `exists` 不解析导致损坏 JSON 报 `ok`——现在至少做一次 `JSON.parse` 探测；segmented 分支 index 完好但段文件缺失时误报 `ok`——现在对每个段 `stat` 存在性（不解析内容，保持 HIS-11 只读结构目标），任一缺失即 `readable=false`
  - 修复段缓存元素引用污染（审查 M2）：`loadSegmentedHistory` 的 `slice` 只复制数组、元素与缓存共享引用，`ContextTrimService` 对 `tokenCountByChannel` 的原地赋值会污染缓存；现在加载路径返回前对元素浅拷贝，缓存只读边界落实；缓存键纳入段文件 mtime（`revision::m{mtime}`），外部进程改写段内容后命中前 `stat` 比对自动失效（审查 M5）
  - 修复用量与元数据一致性：`updateSummary` 不再无条件写前端传来的 `messageCount`——超过历史实际条数时按 `index.totalMessages` 钳制，前端 IPC 失败时不同步本地计数（审查 M3）；append 遇「index 存在但尾段缺失/损坏」时不再永久失败，回退全量重写自愈（审查 M4）
  - 修复前端历史窗口与缓存问题：backfill 把 IPC 失败误当「已到历史开头」置 `windowStartIndex=0` 导致更早消息无法上拉——现在错误与空页区分，错误时放弃合并保留原窗口（审查 L2）；`loadMoreConversations` 游标按实际返回数量前进，批量结果缺失时不再跳过未加载对话（审查 L3）；消息中间位置同长度替换（迟到 cancelled chunk 清理）会命中陈旧可见缓存——`replaceMessageAt` 非尾部替换时清缓存（审查 L1）；`addBatch` 直通 append 可能绕过 functionResponse 去重安全网——契约注释明确仅限纯追加 user/model 并对 functionResponse 显式拒绝（审查 L4）
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
  - 新增 `CheckpointQueryService.ts`（getCheckpoints / getAllConversationsWithCheckpoints / getDirectorySize / pruneMissingBackupCheckpointRecords / 孤儿目录清理）与 `CheckpointRetentionService.ts`（cleanupOldCheckpoints / mergeCheckpointIntoSuccessor），`CheckpointManager` 从 2000+ 行拆分为协调层 + 三服务（CPF-12）
  - 新增共享有界并发池 `checkpointConcurrency.ts`（runBounded，首错停止取新任务并正确传播），创建复制、恢复/删除循环、目录大小统计均改为有界并发（默认 8）（CPF-06）
  - 会话元数据精简：完整 `fileHashes` / `fileStats` 从会话元数据迁到独立 manifest，元数据只保留 `CheckpointSummary`（fileCount / backupBytes / excludedCount / manifestVersion 等）；`getCheckpoints` / `getAllConversationsWithCheckpoints` 只下发摘要，旧存档缺字段时按需懒扫描并写回缓存；磁盘占用创建时直接记录（`backupBytes`），设置页不再重复递归扫描（CPF-01/02/09/10）
  - 流式路径下发摘要化：工具执行期间的 checkpoints chunk 经 `CheckpointService.toStreamSummary()` 剥离 `fileHashes/fileStats`，`loadConversationForView` 与流式两条路径都不再向 webview 传全量哈希映射（CPF-03/04 补全）
  - 存档操作接入进度与取消：Manager 维护进行中操作状态（阶段 / 已处理 / 总数，AbortController），create / restore / deleteAll / deleteBatch 全接入；RestoreEngine 支持 `signal` + `onProgress`；新增 `checkpoint.getOperationProgress` / `checkpoint.cancelOperation` handler 与前端轮询 + 取消按钮（CPF-11）
  - 只读工具批次不再创建存档（CPF-05）：`tool_batch` 判定改为基于真实工具名集合 `toolNames.some(name => configuredTools.includes(name))`，`read_file + search_in_files(search)` 等纯只读批次不建存档，`search_in_files` 仅 replace 模式计入
  - 历史追加改为 append-only 尾段写入（HIS-01/02）：普通追加只写最后一段（不足 200 条）或新建下一段 + 更新 index，不再全量重写所有段；写入顺序「临时尾段 → 原子替换 → 临时 index → 原子替换」，index 是提交点；删除 / 编辑 / 回档 / 分支切换仍走全量重写；`TranscriptRepository` 新增 `appendContents` 直通 append，`addContent` / `addBatch` 纯追加路径不再读全量（functionResponse 保留 mutate 去重安全网）
  - 新增段级 LRU 缓存 `history/HistorySegmentCache.ts`（HIS-06）：键 `conversationId + segmentFile + revision(+mtime)`，默认 32 段，写后 / 删除会话失效；多段读取改有界并发（并发 4）（HIS-05）
  - 同一工具迭代内复用历史快照（HIS-03/04）：`getHistoryForAPIFrom(contents)` / `getStatsFrom(contents)` 支持基于已加载历史直接格式化，`ContextTrimService` 不再每次重新读全量历史
  - 元数据写入合并（HIS-09）：新增 `conversation.updateSummary({conversationId, messageCount, preview})` 一次读写完成，前端流式结束后由 3 次 `setCustomMetadata` 改为 1 次；`updatedAt` 由历史提交统一维护
  - 对话列表批量元数据（HIS-10）：新增 `conversation.getConversationMetadataBatch`（16 并发、每页 ≤200），前端 `loadMoreConversations` 一次 IPC 拉一页摘要，消除逐对话 IPC
  - 用量索引增量维护（HIS-08）：新增 `UsageIndexStore.appendUsage` / `appendUsageMessages`，普通追加助手消息只追加条目，删除 / 编辑 / 回档 / 索引损坏才全量重建；`getMetadata` 完整性检查只读 `history.index.json` 结构，不再解析末段历史（HIS-11）
  - 子agent 用量归集（用户需求）：子agent 每轮 generate 的 `usageMetadata` 以 `source: 'subagent'` 条目追加到发起它的主会话用量索引（`appendUsageIndexMessages`），用量统计 totals / byConversation / byModel / byDay 自动包含子agent 消耗，`ConversationUsage` 新增 `subagentTokens` 细分；索引 stale 全量重建时保留已有 subagent 条目；无主会话归属时跳过归集
  - 前端渲染优化（HIS-12/13）：可见消息窗口增量缓存（同引用 + 长度 + 首尾指纹 O(1) 校验，流式尾替换 O(1)，结构变更回退全量过滤）；对话加载先渲染最后一页再异步补拉更早历史（`backfillInitialVisibleWindow`，与用户上拉 / 发送 / 流式并发时放弃合并）
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
  - 修复 XML 工具调用解析安全（F-01）：`fast-xml-parser` 升级到 5.10.1 后为解析器增加 `processEntities: false` 与 `maxNestedTags: 100`，工具协议不再接受 DOCTYPE 自定义实体与超深嵌套输入；协议层额外过滤 `__proto__`/`constructor`/`prototype` 危险键名防原型污染，新增安全输入回归测试（数字字符串保持、实体不展开、深嵌套安全失败、危险键名拒绝）
  - 修复批量工具部分成功时 LLM 只看得到顶层错误（F-02）：`serializeToolResultForLLM()` 错误分支不再丢弃 `data`，`data.results` 混合数组逐项格式化（避免 JSON 二次转义）、`data.message` 与批量统计（successCount/failCount/totalCount）一并输出，`data.output` 与取消标记保持原有格式；新增共享 formatter 回归测试覆盖 10 项场景
  - 修复 XML 工具指南示例过时（F-03）：`read_file` 的 `paths` 与 `write_file` 的 `files` 旧示例改为真实 schema（单文件 `path` / 批量 `files: [{ path, startLine?, endLine? }]` / 顶层 `path`+`content`），XML/JSON 测试夹具同步更新为真实参数形状
  - 修复 `SubAgentRegistry.isEnabled()` 把未注册代理误判为启用（F-05）：未注册代理现在返回 false
  - 修复注册的自定义 Sub-Agent executor 从未被调用（F-08）：Registry 查询不再隐式创建并缓存默认 executor，正式工具调用路径优先使用显式注册的 executor；executor 请求新增 `conversationId`/`conversationStore`/`promptModeSnapshot` 动态上下文并在每次调用透传
  - 修复 Sub-Agent 跨对话接续泄漏（F-06）：`continueFromRunId` 只允许接续当前主对话所属的 run，归属不一致时拒绝且错误信息不泄漏旧对话 ID 或内容
  - 修复重载/内存淘汰后已持久化 run 无法接续（F-09）：接续时内存快照未命中会只加载当前对话的持久化记录，恢复后仍执行归属与终态校验
  - 修复全部配置代理禁用时 `subagents` 工具被整体隐藏（F-10）：`ChannelManager`/`ToolDeclarationResolver` 统一使用「配置代理计数 > 0 或 General Worker 启用」的 `hasAvailableSubAgent()` 判断
  - 修复 Windows 通知依赖链（F-07）：移除已停更且有生产审计告警的 `node-notifier`，通知适配器改为 VS Code 原生 `showInformationMessage`（操作按钮打开聊天、不阻塞工具调用），esbuild 不再复制原生包，`npm audit --omit=dev` 归零
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
  - 修复 subagents 工具后台模式缺失（E3 F1.1 计划标记完成但实际未实现）：工具声明无 `background` 参数、handler 无后台分支，前端 backgroundTaskStore / BackgroundTaskBar / backgroundStatus 整套后台基建空转；现在按已确认设计补齐——`background: true` 时创建独立 AbortController（用户停止当前对话流不连带取消）、以 `background_subagent` 类型注册到 TaskManager、executor 启动后不 await、工具立即返回 `{ background: true, taskId, runId, agentName }`，executor settle 时注销任务并携带完整结果载荷（response/steps/runId/error），经现成 taskEvent 转发链路由前端混合回流（会话空闲立即发回执、正忙挂起补发）送达主模型
  - 修复代理非 chunked 流式解码仍损坏中文（PR #1 B1 补全）：非 chunked 消费点仍逐 TCP 包 `toString('utf8')`，被包边界切开的 UTF-8 多字节字符固化成 U+FFFD；现在与 chunked 一致走流式 `TextDecoder`，flush 移入非中止分支
  - 修复 glob globstar `**` 失效（PR #1 C4 补全）：GLOBSTAR 占位符正则匹配三个转义星号而 `**` 转义后是两个，`**/node_modules/**` 等规则永不跨目录命中；修正为匹配两个转义星号（PromptManager / fileTree 两处）
  - 修复 diff 预览 LCS 后缀匹配丢失（PR #1 H3 补全）：computeLCS 剥离公共后缀后从不回填，任何带公共尾部的 diff 尾部公共行被标为「删除+新增」、统计虚高；现在按原始索引回填后缀匹配（apply_diff / write_file 两处）
  - 修复 `deleteCheckpoint` 缺少基快照引用保护（PR #1 A2 补全）：updater 未检查 `baseCheckpointId` 引用，被后继检查点引用为基快照时仍删除会断增量链、恢复 100% 失败；现在被引用时返回原引用拒绝删除
  - 修复 ChatViewProvider 关闭标签页后消息仍静默丢失（PR #1 F1 补全）：`onDidDispose` 不重置 `_view`/`webviewReady`，F4 的 isAlive 判定对已销毁 webview 仍返回 true，面板关闭期间 postMessage 静默丢弃；现在与 dispose() 语义对齐重置并释放主聊天 client 注册
  - 修复 media 工具取消后终态恒为 `completed`（PR #1 E1 关联）：批处理末尾无条件 `unregisterTask('completed')`，用户取消的任务显示为「已完成」、后台回执误报成功；现在全部任务被取消时终态为 `cancelled`；`generate_image` 的 failedResults 同步排除 cancelled（与其余 4 个 media 工具对齐）
  - 修复终端输出护栏丢弃行时无截断提示（PR #1 E2 补全）：显示上限关闭时 `omittedOutputLines` 不计入 `wasTruncated`，AI 看不到「输出被截断」；现在护栏丢弃同样触发截断提示
  - 修复 search_in_files 高亮替换串 `$` 特殊语义（PR #1 G1 附带）：匹配文本含美元符特殊替换序列（$'、$`、$$）时 `String.replace` 展开特殊替换模式导致高亮内容错乱；改用替换函数
  - 修复 MarkdownRenderer mermaid 残留注入面（PR #1 G 组补全）：`securityLevel: 'loose'` 下模型可控的图例 HTML 可经 zoomedContent 的 v-html 再次注入执行（webview CSP 含 unsafe-inline）；改为 `'strict'`
  - 修复 fast-tavern Python 遗漏项（PR #1 I 组补全）：`build_prompt.py` 实际存在（文档误判为「已移除」）且 `recentHistoryForWorldbook` 仍 `int()` 强转、浮点字符串抛 ValueError，改为 `int(float())` + 解析失败回退 0；`convert_from_silly_tavern` 遗留 `isinstance(p, int)` 漏 float position，改 `_is_number`；`get_active_entries._to_recursion_limit` 不可解析回退 5（TS 应为 NaN→循环不执行）、负数被钳制到 0 多执行一次、`-inf` 分支多执行一次——全部对齐 TS Math.trunc/Number 语义
  - 修复 glob 通配零段语义（PR #1 C4 补全）：`**/x` 不匹配根级 `x`、`a/**/b` 不匹配 `a/b`（`**` 展开为 `.*` 后要求至少一个目录段）；现在统一到 `backend/modules/prompt/glob.ts` 的 `globPatternToRegExp`（PromptManager / fileTree 三处共用），`**` 后跟分隔符时零段可选（gitignore 语义）、单星不跨目录段（fileTree gitignore 分支原先 `*` 跨 `/` 一并修正）；同时去掉「斜杠展开为 `[/\\]` 字符类」的 4 反斜杠魔法——三处调用点路径均已归一化为 `/`，模式里的 `/` 直接作字面 `/`，「斜杠替换必须先于星号替换」的顺序耦合随之消除
  - 修复 fast-tavern Python normalize_worldbooks 缺字段语义与 TS 不一致（PR #1 I5 补全）：`_to_number` 的 None 分支忽略 fallback 直接返回 0.0，缺 `probability` 的条目概率变 0 永不注入、缺 `index`/`order`/`depth` 的条目被保留（TS 侧分别回退 100 / 丢弃条目）；现在 None 返回 fallback，新增 `_entry_number` 区分「键缺失」（→ fallback）与「显式 null」（→ 0，对齐 `Number(null)`），补 5 个 pytest 用例
  - 修复关闭活跃标签页产生孤儿快照（内存泄漏）：closeTab 删快照后 switchTab 会把已关闭标签页的完整会话状态（allMessages/messageQueue 等）重新写回 sessionSnapshots 成为永不被清理的孤儿条目；现在快照仅在标签页仍存在于 openTabs 时写入，新增 3 个 vitest 用例
  - CheckpointManager 测试补强（PR #1 A2）：测试 mock 此前缺 `updateCustomMetadata`（迁移后的 7 处调用零覆盖），且并发 mock 未模拟真实串行链；现在 mock 补链式 `updateCustomMetadata`，新增 8 个用例覆盖 saveCheckpointToConversation（含并发追加无丢失）、deleteCheckpoint（含 isReferencedBase 拒绝与磁盘目录清理）、deleteCheckpointsFromIndex（含 excludeCheckpointId 基链保留）、deleteAllCheckpoints、pruneMissingBackupCheckpointRecords、cleanupOldCheckpoints 链合并重挂

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
  - 修复 Gemini 空候选报错信息不具体：非流式解析对 `content` 缺失的候选抛笼统错误，现在显式报出 `finishReason`（新增 `emptyCandidate` 三语言词条），内容安全拦截等场景可直接看到真实终止原因（参考 PR #1）
  - 修复 Anthropic `count_tokens` URL 归一化顺序：baseUrl 形如 `.../v1/models/complete` 时先处理 `/v1/models` 会残留 `/complete` 后缀、拼出畸形端点 URL；现在先去掉 `/complete` 再规整 `/v1/models`（参考 PR #1）
  - 修复分段历史原子提交的临时路径类型错误：`getHistoryDir(...) + '.tmp'` 把 Uri 对象与字符串拼接成字符串后直接传给 `workspace.fs`（createDirectory/delete/writeFile/rename），扩展宿主按 UriComponents 重新解析抛 `[UriError]: Scheme contains illegal characters`，导致新建对话/保存历史失败（新建对话闪一下无变化、旧对话发消息报错）；改为 `Uri.joinPath` 构造真正的 Uri 对象，新增回归测试 `storageSegmentedWrite.test.ts`（锁定所有 workspace.fs 路径参数必须是 Uri 对象）
  - 修复 `validateFileInWorkspace` 对 workspaceUri 的裸 `Uri.parse`：非法 URI（如旧格式 Windows 路径）抛 UriError 被外层 catch 吞成 `UNKNOWN` 错误码，或把 `C:\...` 误解析成 `scheme='c'` 导致合法文件被误判为「属于其他工作区」；现在 Windows 盘符路径按 `Uri.file` 语义解析，解析失败时跳过归属比对（不误杀合法文件）
  - 修复会话元数据读改写互相覆盖（PR #1 A 组）：`setCustomMetadata`/`setTitle`/`setWorkspaceUri` 与各存储适配器 `saveHistory` 内部的 updatedAt 更新此前在两条独立串行链上，并发时后写者基于旧 meta 的整体写回会把先写者的 custom 字段覆盖（检查点列表/裁剪状态随机丢失）；现在 `storage.ts` 新增模块级 `withMetadataWriteSerialized` 共享链统一所有元数据读改写，`ConversationManager` 新增 `updateCustomMetadata`（链内「读 meta→updater→无变更跳过写回」，updater 支持异步）
  - apply_diff 匹配失败报错增强：oldContent 找不到时不再只说「请核实内容」，新增最近似块诊断——在文件中定位与 oldContent 最接近的行块，逐行报告差异（含首差异字符列与期望/实际内容片段），帮助快速定位全角/半角、空格、缩进或内容已变等问题；块首行不匹配时自动尝试后续行作锚点，超长块/超大文件自动跳过诊断避免 O(m×n) 扫描卡死；结构化 hunk 与 legacy search/replace 两条失败路径均接入
  - 修复 CheckpointManager 全部 7 处「读列表→内存改→整体写回」竞态（PR #1 A2）：并发创建互相覆盖记录、并发删除/裁剪互相丢失；全部迁移到 `updateCustomMetadata`，删除类操作在链内算好保留集合、写回成功后才删磁盘目录（竞态窗口收敛）
  - 修复 `normalizeHistoryForDisplay` 锁外写回覆盖真实工具结果（PR #1 A3）：`getMessages`/`getMessagesPaged` 的补齐流程基于旧快照整体写回，与工具结果并发落盘互相覆盖；现在整个读-改-写移入仓储互斥执行器，`TranscriptRepository.mutateContents` 新增「返回原引用=跳过写回」无变更契约（无未响应调用时不再每次读历史都写一次盘）
  - 修复 `addContent` 去重锁外执行导致同一 tool_use_id 出现两条 functionResponse（PR #1 A4）：去重+追加整体移入 `mutateContents`，取消流与工具执行循环之间的竞态安全网恢复有效；同步修复契约上线暴露的 9 处「原地修改+返回原引用」mutator（appendContent/addBatch/updateMessage/updateMessagesBatch/insertMessage/insertContent/deleteMessagesInRange/rejectAllPendingToolCalls/settleFunctionResponses）改为有变更时返回新引用
  - 修复 MemoryManager.updateEntry 越界写垃圾记录（PR #1 A5）：`logLen()` 校验与 `logGet` 读取在锁外执行，并发 `truncateLog`/`logAppend` 改变日志长度后基于过期 id 的写入越过 EOF；校验与读取移入锁内
  - 修复 `getStats` 对缺 `data`/`mimeType` 的 inlineData 抛 TypeError（PR #1 A6）：旧版本或手动编辑的历史不再导致统计面板/上下文裁剪入口崩溃
  - 修复代理 CONNECT 隧道流式解码损坏中文（PR #1 B1）：`decodeChunkedStream` 逐 chunk `toString('utf8')` 把被 TCP/chunk 边界切开的 UTF-8 多字节字符在第一个包固化成 U+FFFD，后续 SSE 行 `JSON.parse` 永远失败；现在只收集原始字节，由流式 `TextDecoder` 跨 chunk 拼接解码，循环结束 flush 尾部字符
  - 修复代理取消被误判为可重试（PR #1 B2）：`fetchWithProxy`/`sendRequestOverSocket` 的取消 reject 普通 Error，ChannelManager 只认 `AbortError` 导致取消变无谓重试；新增 `createAbortError` 统一 6 处取消错误，CONNECT 握手成功后移除旧 abort 监听避免重复取消
  - 修复重试等待窗口内发送保活请求（PR #1 B3）：重试路径 delay 前未停 keepAlive 定时器，错误后到 delay 完成之间在无活动流时发出保活请求；现在 delay 前先 clearInterval
  - 修复 OpenAI strict 工具混用被 API 400 拒绝（PR #1 B4）：任一工具 strict 时 OpenAI 要求全部工具 strict，混用显式发送 `strict: false` 被拒；现在整体降级为不启用
  - 修复 directApplyAndSave 把编辑器旧缓冲区写回磁盘覆盖 AI 内容且 diff 永久 pending（PR #1 C1）：dirty 文档 `openDoc.save()` 会把旧内容+用户未保存编辑写回磁盘，且 `saved` 提前 return 跳过 finalizeAcceptedDiff；现在先写盘，再用 WorkspaceEdit 静默替换编辑器内容为 AI 内容并 `save()` 清理 dirty（内容与磁盘一致，保存无害）——早期方案用 `workbench.action.files.revert`，但文档 dirty 时会弹 VS Code 原生确认框阻塞整个 diff 流程，已弃用
  - 修复关标签页不收敛 accepted、diff 永久 pending（PR #1 C2）：磁盘已是 AI 内容（files.autoSave 直接落盘）时关闭标签页既不接受也不拒绝；现在内容相等收敛为接受
  - 修复 legacy 多 diff 行号偏移累积（PR #1 C3）：`start_line` 相对原始文件，前序 hunk 改变行数后后续 hunk 整体错位；三处 legacy 应用路径新增 lineDelta 累计
  - 修复 glob 元字符未转义抛 SyntaxError（PR #1 C4）：`matchGlobPattern`/`shouldIgnore` 只转义 `.`，配置含 `[`/`(`/`+`/`?` 时 `new RegExp` 抛错中断动态上下文生成；改为整体 `escapeRegExp` 后再做通配替换，并修复斜杠替换在星号替换之后导致 `[^[/\]]` 通配永不命中的顺序缺陷
  - 修复 fsPath 大小写敏感比较失效（PR #1 C5）：diffManager 11 处 `fsPath ===` 严格比较在 Windows/macOS 上因大小写变体路径失效导致监听器/文档查找失灵；新增 `sameFsPath`（win32/darwin 折叠大小写，Linux 精确）
  - 修复分段存储 delete+rename 提交窗口与无读重试（PR #1 D1）：删旧目录→rename 期间并发读可能看到 index 在但段文件消失；现在写前清理 tmpIndexPath 残留、提交改 overwrite rename、`loadHistoryWithStatus`/`loadHistoryPage` 对 not_found/io_error 重试一次（50ms）
  - 修复 cancelTask 提前删任务丢终态事件（PR #1 E1）：abort() 后立即删任务+发裸 cancelled，完成路径的 `unregisterTask` 变 no-op、前端任务条卡在「已取消但无结果」；现在只 abort，终态由各完成路径统一发出（已核对 terminal/media 全部取消路径）
  - 修复终端输出无内存护栏（PR #1 E2）：长运行进程持续输出内存无限增长；新增 `MAX_RETAINED_OUTPUT_LINES = 50000` + `pushOutputLines`（超限丢最旧并计数），截断提示用 `output.length + omittedOutputLines` 总量
  - 修复 search_in_files / FilePickerPanel / AnnouncementModal 三处 v-html 注入（PR #1 G1/G2/G3）：搜索结果上下文、文件路径、changelog 正文未转义直接注入 HTML，工作区文件内容含 `<`/`>`/`&` 或恶意 HTML 时可执行任意脚本（远程代码执行级风险）；现在统一先 `escapeHtml` 再做高亮/markdown 标记替换
  - 修复中文/日文输入法合成回车误发消息（PR #1 H1）：InputBox 无 IME 守卫，按 Enter 确认候选词触发发送逻辑误发半截消息；现在 `isComposing`/keyCode 229 直接 return
  - 修复批注消息发送失败不回滚（PR #1 H2）：ToolMessage 先 push 用户批注再发送，失败时批注残留成幻影消息、前端索引与后端错位、重试会再插一份；现在失败按 id 回滚
  - 修复 apply_diff / write_file 大文件 diff 预览卡死（PR #1 H3）：computeLCS 全量二维 DP，数千行 diff 占数百 MB 内存并阻塞 webview 主线程；现在公共前缀/后缀剥离 + 核心区域超过 100 万跳过 DP
  - 修复 isLoadingMore 切标签页后永久禁用（PR #1 H4）：复位在 tabId 匹配分支内部，加载期间切走标签页后上拉加载被永久跳过；现在 finally 无条件复位
  - 修复消息列表 UI 状态组件级丢失（PR #1 H5）：uiStateByTab 是组件实例级 Map，空会话过渡卸载组件后滚动位置/展开状态全丢；现在提升为模块级保存
  - 修复切会话清空排队消息（PR #1 H6）：switchConversation 无条件清空 messageQueue，排队消息被静默丢弃；现在只清理附件，跨会话消息由队列匹配跳过机制处理
  - 修复跨会话消息卡队头（PR #1 H7）：processQueue 取到不属于当前会话的消息放回队头并中止，该消息永久阻塞队列；现在改为查找第一条属于当前会话的消息
  - 修复关标签页不取消流 + 废弃缓冲累积（PR #1 H8）：closeTab 不取消该会话仍在进行的流，后续 chunk 为已关闭会话重建缓冲区且无消费者，反复开关页无限累积；现在关页时按 conversationId 取消流，缓冲对已关闭会话直接丢弃不重建
  - 修复消息 timestamp 被完成时刻覆盖（PR #1 H9）：四个流式 handler 用 `{...message, ...finalMessage}` 展开，finalMessage 的 timestamp 是完成时刻导致时间戳漂移、排序错乱；现在补 timestamp 保留
  - 修复消息订阅者单点崩溃（PR #1 H10）：一个订阅者抛异常中断其余订阅者（backgroundTaskStore 收不到同一条消息）；现在每个订阅者单独 try/catch
  - 修复 Markdown 渲染缓存无界增长（PR #1 H11）：codeHighlightCache/fileExistenceCache/imageCache 无上限，长会话持续增长；现在统一 `setCached` 容量 500 FIFO 淘汰
  - 修复 ChatViewProvider.dispose 不重置 _view（PR #1 F1）：_view 仍指向已销毁 webview，重开面板后 diff 状态/终端输出等事件永久丢失；现在 dispose 置空
  - 修复 pendingCommands 无上限（PR #1 F2）：面板长期未打开期间反复触发命令队列无界增长、打开后一次性重放陈旧命令；现在上限 100
  - 修复 sendError 对非 Error 对象取 message 得 undefined（PR #1 F3）：改为 instanceof 判断回退 String(error)
  - 修复 webview 已死路由判定失效（PR #1 F4）：已销毁 webview 的 postMessage resolve(false) 而不抛异常，调用方误判成功跳过回退路径、响应静默丢失；现在注册表按 isAlive 判定存活，SubAgentMonitorPanel 注册绑定 panel 实例
  - 修复流 chunk 不按 clientId 路由（PR #1 F5）：所有流都发往主聊天，monitor 面板发起的流错投；现在 `getClientView(clientId)` 按注册表路由
  - 修复 requestClients 泄漏（PR #1 F6）：请求结束不清理 requestId→clientId 映射；现在 4 个流式 handler 的 finally 与取消路径统一 finalizeRequest
  - 修复 showDiffView 未入串行队列（PR #1 C7/M13）：与 accept/reject 动作并发时状态互相抢占；现在包 `runDiffActionSerialized`（原实现改 showDiffViewUnlocked）
  - 修复被淘汰 rejected diff 墓碑 Set 无界增长（PR #1 C6）：evictedRejectedDiffIds 随会话无限累积；现在容量上限 2000 FIFO 淘汰
  - 修复 fast-tavern Python 与 TS 语义差异（PR #1 I 组）：assemble_tagged_prompt_list 的 NaN/bool 通过 isinstance 过滤导致 int(nan) 抛 ValueError；history/factories 的 str(text or "") 把 0/False 变空串；convert_from_silly_tavern 的 isinstance(v, int) 漏 float 且 bool 误判；normalize_worldbooks 的 _to_number 未对齐 Number() 且 index/probability int 截断（2.5 与 2 是不同键）；apply_regex 的 macroMode 缺失被当 none（TS 缺失=执行替换）且 {{}}/<<>> 替换顺序与 TS 相反；variable_context 的 float(None) 抛错使已存 null 走字符串拼接；get_active_entries 的 recursionLimit/index/order 数值强转抛 ValueError/TypeError/丢小数——全部对齐 TS 语义（build_prompt 对应文件已随重构移除，不适用）

### Changed
  - `StreamChunkProcessor` 构造从持有 view 引用改为持有 `getView` 回调，视图重建后消息自动发往新视图
  - `TranscriptRepository` 支持注入互斥执行器（`exclusive`），`mutateContents` 的 get→mutate→replace 整体串行化
  - fast-tavern Python 版 `apply_regex` 对齐 TS 版：替换结果中的 `{{user}}`、`{{getvar::...}}`、`{{setvar::...}}` 等宏立即展开，并透传 `variableContext`
  - SubAgent Monitor 流式卡顿优化：前端 `llm_delta` 事件改为非响应式队列 + rAF（setTimeout 兜底）批量 flush，事件回调从「每 chunk 全量更新 manifests/windowsByRunId + renderMessages 全量重建」降为 O(1) 入队、每帧至多一次合并提交；renderMessages 按 content/overlay 引用缓存 Message 对象，未变化的楼层不再触发 MessageItem 重渲染（连带避免重复解析 Markdown），流式更新成本与窗口长度解耦；前端事件数组加 500 条上限（与后端 journal 对齐）；后端 SubAgentMonitorPanel 对 `llm_delta` 做 50ms 节流合并，跨进程 postMessage 次数与渲染帧率对齐而不是与 token 产出速度对齐，并发 SubAgent 下 Monitor 不再卡顿
  - SubAgent 默认限制放宽：迭代次数默认 20 → 50（预设 30~40 → 40~80），运行时间默认 300s → 1800s（预设 600~900s → 1200~2400s），同步更新设置面板默认显示值、工具描述与类型注释；复杂任务不再频繁触顶「超出最大迭代次数 / 运行时间」

### Added
  - 新增回归测试：`formatterParallelTools.test.ts`（H2/H3：Anthropic 并行工具参数按 index 合并、OpenAI Responses done 覆盖增量）与 `h1_deadlock.test.ts`（H1：≥2 条记忆编辑不死锁）
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
