# GrayCode 项目状态与重要备忘

> 生成日期：2026-08-04（最后更新：同日，TREE 全部完成后）。本文件是后续会话的**必读交接文档**——压缩上下文后先读这里。

## 一、项目规则（血泪教训，必须遵守）

1. **CHANGELOG.md [Unreleased] 必须同步**：任何代码修改都要记录；**统一由主模型写，禁止派给子 agent**（多 agent 并发写会冲突）。
2. **前端 i18n 三语同步**：新增文案必须同时更新 zh-CN/en/ja，否则 `languageParity.test.ts` 失败。
3. **多 agent 并行按文件域划分**：同文件并发修改会互相覆盖；派活时给每个 agent 明确文件边界，并列出"不要碰的文件"。
4. **后台子 agent 报告超长会被截断**（已修复 reportBuilder 的 4000 截断）：超长报告让 agent **落盘文件**或**续跑分段重发**（每段 ≤3500 字符）。
5. **拆大文件必须是纯重构**：行为零变化、公共导出不变，否则回归难查。
6. **测试命令**：后端 `npm test`（138 套/1517 用例）、前端 `npm --prefix frontend test`（22 文件/267 用例）、双 typecheck `npm run typecheck` / `npm --prefix frontend run typecheck`；基准 `npx jest --config jest.backend.config.js --testMatch "**/*.benchmark.ts"`。
7. 扩展宿主里"Diff is no longer pending"提示 = 并行修改导致某 diff 失效，通常无害。

## 二、主线规划进度（checkpoint-history-branch-architecture.plan.md）

| 阶段 | 状态 |
|---|---|
| 第一~四阶段（存档正确性/排除/性能/历史性能） | ✅ 完成 |
| 第五阶段 BR-01~09（稳定消息 ID + 分支底座） | ✅ 完成 |
| 第六阶段 TREE-01~14（reroll/候选切换/编辑分支/UI/互斥/测试） | ✅ **全部完成** |
| 第七阶段 BCP-01~08（分支与工作区存档联动） | ✅ **全部完成**（含决策 11 dirty 拦截、决策 12 不做哈希去重） |
| 第八阶段 MIG | ✅ **全部完成**（MIG-01~09；最终验证 142 套/1574 用例 + 前端 22 文件/282 用例 + 双 typecheck 全绿） |

### 已确认业务决策（2026-08-04，主人拍板，记录在规划文档）
1. 分支切换默认只切聊天；检测到写工具时提示（判据 = workspaceCheckpointId 存在性 + 工具名列表，**取或结合**）
2. 用量统计**包含全部分支**（非活跃也计入）
3. 分支删除软删除（deleted 标记、可恢复），保留期默认 30 天可配置，清理入口在**设置页分支清理区块**
4. 每父节点候选上限 **10 个**，超限提示不自动删
5. 旧 retryStream/editAndRetryStream **保留**内部兼容，主流程切 reroll
6. deleteToMessage 保留硬删除语义，同步更新分支图
7. 回档并重试/编辑 = reroll 候选 + 恢复存档（旧分支保留）；回档并删除才移除分支
8. **functionResponse 不独立成 BranchGraph 节点**（依附 model 节点）
9. 跨对话"创建分支"建模进 BranchGraph（kind: 'exported'，BR-09 已按此实现）
10. 流式失败候选保留（标记失败可切回）

### 待主人拍板的产品决策（P6b 研究提出，BCP-03/04/05 前置）
1. **普通 `checkpoint.restore` 是否也拦截 dirty 文件**——✅ 已拍板：拦截（决策 11，已实现）
2. **BCP-07 内容哈希去重是否做**——✅ 已拍板：不做（决策 12，增量链共享测试固化）

## 三、已落地的新能力（本阶段成果）

1. **agent 间消息通信**：`agent.sendMessage` + 内存 mailbox（threadId + 5 跳防循环）；收件方在**最近一次工具调用后**与结果一起注入；主会话 5 处调用点接入；`agentInbox` 落盘前剥离（当轮保留、跨轮剥离——R7a 后谓词统一为 `isRealUserMessage`）；子代理历史组装时剥离已投递消息。
2. **用户消息插入**：会话忙时 `chat.sendInterruptMessage` 投递主会话 inbox（10s/条限频、4000 字符上限），随最新工具调用注入；前端忙时自动走插入路径 + 轻量回显。
3. **子 agent 嵌套**：深度上限 2，深度框架注入不可伪造；父级工具过滤传播；级联清理。
4. **前台 SubAgent 转后台**（用户实测需求）：`SubAgentRunController.detachFromParent` + `StreamAbortManager.create` 在 abort 旧流**之前**先 detach 该会话活跃前台 SubAgent——用户发新消息不再杀子代理，run 转后台继续（广播 run_detached；后台 run 不受影响）。R7c 复查修复：三处裸取消检查改 `parentAbort()`、超时桥 detached 保护、acquire 桥拆分（排队中 detach 也能继续 + Monitor 仍可终止）。
5. **树状分支全链路**：
   - 底座：BranchGraph 纯函数 + BranchGraphRepository（branches.json 原子写、损坏降级）+ BranchService（锁内接口）+ BranchMigration + BranchHandlers
   - reroll：`chat.rerollStream`（旧候选进 sidecar/新候选激活/主历史截断/失败保留；每父 10 候选上限）
   - 编辑分支：`chat.editBranchStream`（edit 候选，旧分支保留）
   - 切换：`switchBranchCandidate` 全链（切图 → `rewriteHistoryFromBranchGraph` 主历史重写 → 检查点清理；FR id 复用防误删；失败回滚）
   - 软删：级联软删/恢复整棵子树 + 保留期配置 + 修剪 + 设置页清理区块
   - 用量：读取时合并非活跃候选 token（id 权威去重 + inactiveBranchTokens）
   - UI：BranchSwitcherBar（‹ 2/3 ›）、BranchTreePanel（分支树）、标签页快照
6. **存档-分支联动**：BCP-01 messageNodeId 接线；BCP-02 bindWorkspaceCheckpoint（工具执行存档点自动绑定节点）；BCP-03/04/05 切换双模式（chat-only/chat-and-workspace，dirty 拦截 + 恢复失败不切分支）；BCP-06 引用计数清理；决策 11/12 落地。
7. **性能基准**：test/benchmark/ 三场景（大工作区/长对话/大量分支），smoke 上限按实测收紧。
8. **大文件拆分**：CheckpointManager→CheckpointRestoreService(722)/WorkspaceEditorRefresher(94)；CheckpointSettings.vue→5 composable；SettingsManager→门面+14 服务；settings/types.ts→11 主题文件。

## 四、待办清单（按优先级）

1. **无遗留阻断项**——规划全部 8 阶段完成。可选后续：A-COMM 二期实时通道（信箱模型已够用，实时推送未做）；`collectToolNamesFromParts` 抽公共函数（BCP-03/04/05 报告提及，与 buildCandidateSummary 同口径，纯重构）；integrityCheck 分支对比 warning 回收条件复核（TREE-06/09/BCP-02 全部落地后重跑确认是否可升级回 error）。

## 五、关键架构备忘

- **锁序**：会话写锁 ⊂ 存档操作锁 ⊂ 全局文件写锁。**强约束：会话锁内严禁获取存档锁**（BranchService 注释已写明，BCP 设计时必须遵守，否则与 restore/create 的"存档锁→会话锁"路径死锁）。切图与主历史重写在同一会话锁内原子执行；检查点清理在锁外。
- **分支图**：单 parentId 索引 + activeChildId；functionResponse 不独立成节点（依附 model）；节点内容存 sidecar（branches.json），主历史只保存当前活跃路径；软删 = deleted + deletedAt（级联子树）；图/历史一致性靠 appendHistoryToGraph（fire-and-forget）+ 切换前锁内尾部一致性检测。
- **用量统计**：FileUsageIndexStore per-conversation 写串行队列；读取时合并非活跃候选（source='branch'），主历史消息 id 权威去重；usageMetadataPartial 支持中断估算。
- **恢复安全**：dirty 文件统一拦截（WorkspaceRestoreGuard.detectDirtyFilesInWorkspace + confirmedDiscardDirty 确认流，普通恢复与切换共用）；恢复失败不切分支；恢复前置取消流+SubAgent（cancelStreamAndSubAgents 抽取共用）；存档删除三重闸门（引用计数/祖先闭包/unsafe backupDir）。
- **存档安全**：删除/合并/manifest 路径统一 `isSafeCheckpointDirName`；恢复保护判定为前缀匹配（isProtectedScopedPath，目录级排除条目保护子树）；恢复侧 ignore 口径与创建/预览一致（含 profilePatterns）。
- **恢复流程**：previewRestore（只取工作区锁）→ computeRestorePlan → 先复制全部成功再删除；恢复前取消该对话流式 + 活跃 SubAgent。
- **mailbox**：回合边界 = 真实用户消息（isRealUserMessage 排除总结消息）；drain 由主循环统一接管（epoch）；run 结束/对话删除清理。
- **前端**：RETRYABLE_ERROR_CODES；BRANCH_BUSY 前端双保险；模块级 Map（折叠态/UI 状态）带清理与容量上限；思考计时器 500ms 防 v-memo 击穿。

## 六、审查发现的历史问题（已修复，防止回归）

- 前台子代理被用户发消息连带杀掉（detach 转后台）✅
- 软删 prune 静默物理移除 live 子孙（级联软删）✅
- 切换重写 FR id 重生 → 检查点误删（FR id 复用）✅
- 用量混合态索引双计（historyIdsComplete 判定）✅
- agentInbox 当轮剥离（主模型收不到信箱消息）✅
- 恢复侧漏传 profilePatterns（排除口径三处不一致）✅
- manifest.excluded 目录级条目未保护（前缀匹配）✅
- 用量索引重建丢 main 条目 ✅
- 错误码白名单不匹配导致重试按钮消失 ✅
- 嵌套子 agent 权限逃逸 ✅
- 配置保存失败不回滚/加载失败默认值覆盖 ✅
- checkpoint 删除路径未校验 backupDir ✅
- reroll/editBranch 流不可取消 + 占死 IPC 队列 ✅
