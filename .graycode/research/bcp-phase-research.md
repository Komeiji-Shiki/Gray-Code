# 第七阶段 BCP-02~08 实施路径研究（批次 P6b，只读）

- 批次：第七阶段 BCP-02~08（P6b）
- 状态：研究完成（只读，未修改任何业务代码）
- 研究日期：与 `branch-tree-phases-research.md`（第七阶段）、`bcp01-nodeid.md`（BCP-01）同系列
- 关联规划：`checkpoint-history-branch-architecture.plan.md` 第七阶段（L115–124）+ 已确认决策 1/6/7（L2023–2030）+ 第六部分「分支与代码工作区状态」（L1584–1667）+ 第七部分错误码（L1707–1718）
- 注意：`.graycode/research/tree04-06-switch.md` **尚未落盘**（TREE-04/06 切换链路研究缺失），本文按「TREE-06 实施中、切换请求将扩展」的现状撰写，并标注依赖

---

## 0. 现状总览（读代码确认）

### 0.1 已完成（BCP-01，`bcp01-nodeid.md`）

| 能力 | 证据（file:line） |
|---|---|
| `CheckpointRecord.messageNodeId` / `CheckpointSummary.messageNodeId` 类型 | `backend/modules/checkpoint/types.ts` L328 / L122 |
| `createCheckpoint` options 收 `messageNodeId` 并写入记录 | `CheckpointManager.ts` L226–229 → 记录构建 L526 |
| 三个创建方法反查 nodeId 透传 | `CheckpointService.ts` L90/L96（user）、L157/L163（model）、L211–212 + L220（tool execution） |
| `ConversationManager.getMessageNodeIdAt` | `ConversationManager.ts` L1208–1220 |
| ToolExecutionService before/after 反查（第 5 构造参数，未注入时 CheckpointService 兜底） | `ToolExecutionService.ts` L334–343（before）、L543–552（after） |

### 0.2 分支域已就绪（BR/TREE 底座）

| 能力 | 证据 |
|---|---|
| `ConversationBranchNode.workspaceCheckpointId?` / `workspaceState?` | `branch/types.ts` L127 / L129（**全仓库零赋值点**，仅类型） |
| `WorkspaceState = 'unchanged' \| 'checkpointed' \| 'unavailable' \| 'unknown'` | `branch/types.ts` L55 |
| 错误码 `WORKSPACE_STATE_UNAVAILABLE` / `WORKSPACE_CHECKPOINT_BROKEN` | `branch/types.ts` L63–64（预留未用） |
| 分支写入口（全部在会话写锁内） | `BranchService.mutateGraph` L1047–1058；`saveBranchGraph` L288–301 |
| 候选创建/编辑 | `createRerollCandidate` L324–358、`editCandidate` L364–398 |
| reroll 流程 | `startReroll` L414–470、`finishReroll` L482–582 |
| **切换（TREE-04 底座，TREE-06 未落地）** | `switchBranchCandidate` L591–604，返回 `mainHistoryRewrite: false`（注释明确「只切图状态，不重写主历史」） |
| 软删（TREE-09 底座） | `deleteBranchCandidate` L613–656（单节点软删；活跃路径节点拒绝） |
| 主历史追加并入图（TREE-05 已接线） | `ConversationManager.getTranscriptRepository().appendContents` L265–317 → `appendHistoryToGraph`（fire-and-forget，占位候选跳过） |
| prune/restore 纯函数（TREE-09，**未暴露公共方法**） | `BranchGraph.ts` `softDeleteNode` L705、`restoreNode` L750、`collectDeletedNodes` L816、`pruneDeletedNodes` L833 |
| sidecar 全量扫描能力（BCP-06 引用计数用） | `BranchGraphRepository.listConversationIds` L94–115 |

### 0.3 存档域可复用件（BCP-03/05/06 的基础）

| 能力 | 证据 |
|---|---|
| `restoreCheckpoint(conversationId, checkpointId, { deleteUntrackedFiles })` | `CheckpointManager.ts` L721–725；工作区级互斥 L740–743 |
| `previewRestore(conversationId, checkpointId)` → 计划 + failures(missing_in_chain)/missingBackupDirs/unbackedPaths | `CheckpointManager.ts` L887–994；`checkpoint/types.ts` L245–277 |
| 工作区身份校验 | `CheckpointWorkspace.ts` `validateWorkspaceSnapshot` L89–126（`WORKSPACE_IDENTITY_MISSING` / `WORKSPACE_MISMATCH`）；接入点 `CheckpointRestoreService.ts` L277–288；legacy 多根拒绝 L291–296 |
| 恢复前取消流 + SubAgent + 派生元数据刷新（**BCP-03 必须原样复用**） | `webview/handlers/CheckpointHandlers.ts` L81–121 |
| 恢复后编辑器刷新（**注意：静默丢弃 dirty buffer，BCP-05 风险点**） | `WorkspaceEditorRefresher.ts` L23–95（L44–59：dirty 文档 applyEdit 替换为磁盘内容后静默 save） |
| 存档删除（增量链保护 CP-05：祖先闭包 + rejectedIds） | `deleteCheckpointsBatch` L1270–1390（forcedKeep L1312、rejectedIds L1323）；`deleteCheckpointsFromIndexInternal` L1100–1183 |
| 保留清理 + 链重挂 | `CheckpointRetentionService.cleanupOldCheckpoints` L42–85、`mergeCheckpointIntoSuccessor` L103–216 |
| 增量链去重（BCP-07 评估依据） | `CheckpointManager.createCheckpoint` L312–315（lastCheckpoint）；`computeChanges` L679–704；`manifest.files[].backupSourceCheckpointId` `checkpoint/types.ts` L105 |
| 写工具名列表（BCP-04 判据来源） | `DEFAULT_CHECKPOINT_CONFIG.beforeTools/afterTools` `settings/checkpointTypes.ts` L131–182（25 个工具，CP-13）；运行时 `config.beforeTools/afterTools` |
| 节点内工具名提取（已有实现，可抽公共） | `BranchService.buildCandidateSummary` L169–183（toolNames 从 parts 提取） |

### 0.4 前端现状

- **无候选切换 UI（TREE-10 未落地）**、无 `frontend/src/stores/chat/branchActions.ts`、无 reroll 调用（前端 `retryFromMessage` 仍走 `retryStream`）。
- 但类型已预留：`frontend/src/stores/chat/types.ts` L87（`parentId`）、L101–122（`BranchCandidateSummaryData` / `BranchGraphData`，含 `nodeId`/`activeTailNodeId`）。
- 恢复确认框模式可复用：`MessageList.vue` L1024–1091（previewRestore → 确认 → restoreAndRetry/Delete/Edit），`checkpointActions.ts` `restoreAndRetry` L232–372。

### 0.5 并行批次依赖声明

- **TREE-04/06**（候选切换 + 主历史重写）在另一批次实施中：`switchBranchCandidate` 目前 `mainHistoryRewrite:false`；BCP-03/04/05 的「切换 + 工作区联动」**必须等 TREE-06 把主历史重写（replaceContents + 派生状态重建）落地**后才能闭环，否则切换后主历史与工作区仍不一致。
- **TREE-09**（分支软删除/修剪）在另一批次实施中：`pruneDeletedNodes`/`restoreNode`/`collectDeletedNodes` 纯函数已存在但 BranchService 未暴露公共 prune/restore 方法；BCP-06 的「物理清理联动」依赖其落地。
- 本文档各节均标注「依赖」；BCP-02 无强依赖，可立即开工。

---

## 1. BCP-02：每个分支记录对应的工作区存档头节点

### 1.1 现状核对（读代码确认）

1. **字段已存在、无赋值点**：`ConversationBranchNode.workspaceCheckpointId?: string`（`branch/types.ts` L127）、`workspaceState?: WorkspaceState`（L129）。全仓库搜索仅命中类型声明与注释，生产代码零赋值（BCP-01 只填了存档侧 `messageNodeId`，没回填分支侧）。
2. **「最近一次 createCheckpoint 的 id」反查能力**：存档记录已带 `messageNodeId`（BCP-01）；`CheckpointQueryService.getCheckpoints` 返回摘要（含 `messageNodeId`、`timestamp`、`id`），可按 `messageNodeId` 过滤 + 按 `timestamp` 取最新，**无需新增存档查询接口**（v1 够用）。
3. **绑定写入点**：所有分支图写操作都经 `BranchService.mutateGraph`（L1047–1058，会话写锁内 validate+save），新增「绑定」方法直接复用该执行器即可。
4. **reroll/editBranch 流不创建 user/model message 存档**：`handleRerollStream`（`ChatFlowService.ts` L1248–1370）与 `handleEditBranchStream`（L1401–1560）只做 `deleteCheckpointsFromIndex`（L1314 / L1505），不调用 `createUserMessageCheckpoint`；写工具 before/after 存档由 `ToolExecutionService` 创建（L331–347 / L540–560）。**因此绑定主路径 = 工具执行存档点**，消息级存档仅旧 `handleEditAndRetryStream` 有（L1084/L1107/L1657/L1693）。
5. **锁序**：`createCheckpoint` 持工作区级 `checkpointOperationLock`（L299–303）；`bindWorkspaceCheckpoint` 走会话写锁（`runExclusive`）。两个锁无循环依赖（绑定只拿会话锁；create 只拿工作区锁 + 元数据写串行锁；恢复拿工作区锁 + 元数据写串行锁；分支操作拿会话锁）——但**不要在 checkpoint 锁内 await 会话锁**（会引入嵌套等待），绑定应放在 createCheckpoint 返回之后、以 fire-and-forget 方式执行（与 TREE-05 `appendHistoryToGraph` 同模式，`ConversationManager.ts` L292–316）。

### 1.2 字段语义（建议固化）

- `workspaceCheckpointId` = **该分支（从根到该节点路径上）最后一次成功创建的存档 id**（取 `timestamp` 最大者）。before/after 或连续工具产生的多个存档，只保留最新绑定。
- `workspaceState`：
  - 绑定成功 → `'checkpointed'`；
  - 分支有写工具调用但绑定目标存档不可用（被删/断链）→ 评估为 `'unavailable'`（BCP-05 联动）；
  - 分支无写工具 → `'unchanged'`；
  - 缺省 → `'unknown'`（等价未评估，BCP-04 判据不命中）。
- **多节点共享**：同一 checkpoint 可被多个节点绑定（before 挂在父节点、after 挂在子节点等），`workspaceCheckpointId` 不做唯一性约束——这正是 BCP-06 引用计数的来源。

### 1.3 实施路径（文件 / 接口 / 顺序）

**① BranchService 新增（`backend/modules/conversation/branch/BranchService.ts`）**

```ts
// 绑定：把存档 id 写到节点（mutateGraph 内；节点不存在/已删除 → 幂等跳过；只更新为更新的存档）
async bindWorkspaceCheckpoint(
  conversationId: string,
  nodeId: string,
  checkpointId: string,
  options?: { timestamp?: number }   // 用于「只保留最新」比较；缺省取当前时间
): Promise<void>

// 读侧：节点 → { checkpointId?, workspaceState? }（供 BCP-04 evaluateSwitch / 前端展示）
async getBranchWorkspaceState(
  conversationId: string,
  nodeId: string
): Promise<{ checkpointId?: string; workspaceState?: WorkspaceState }>
```

实现要点：`bindWorkspaceCheckpoint` 内部 `mutateGraph` 中做「已有绑定且 `checkpointId` 更旧则覆盖」；绑定后 `workspaceState='checkpointed'`。**不主动创建存档**（v1 语义：只绑定已存在的存档；「切换离开前补建存档」见 1.4 风险）。

**② 绑定时机 A——工具执行存档点（主路径，立即生效）**

- 落点选 `CheckpointService.createToolExecutionCheckpoint`（`CheckpointService.ts` L199–223）：`createCheckpoint` 成功后若 `resolvedNodeId` 存在且返回记录非空 → `getGlobalBranchService()?.bindWorkspaceCheckpoint(conversationId, resolvedNodeId, record.id)`。
- 必须 **fire-and-forget**（`void (async () => {...})()`，失败仅 `log.warn`），原因：① createCheckpoint 持工作区锁，不能在其内 await 会话锁；② 绑定是派生态，主历史/存档才是真源（与 TREE-05 同哲学）。
- `getGlobalBranchService()`（`BranchService.ts` L65–75）已在 webview 侧注册（`BranchHandlers.ts` L68–77 / `ChatHandlers.ts` L20–22），`CheckpointService` 位于 api 层，可直接 import（注意只在存在时绑定，测试环境不注入则跳过）。
- **兜底**：`createUserMessageCheckpoint` / `createModelMessageCheckpoint` 同样在返回后绑定（before 存档 nodeId 通常 undefined，自然跳过）。

**③ 绑定时机 B——分支生成完成（finishReroll 兜底）**

- `BranchService.finishReroll`（L482–582）在回填候选节点后：取新路径节点集合，查 `CheckpointQueryService`（按 `messageNodeId ∈ 新路径节点` 过滤、按 `timestamp` 取最新）绑定到候选节点。
- 说明：绝大多数场景已被时机 A 覆盖（新候选执行写工具时 checkpoint.messageNodeId = 新节点 id）；时机 B 只兜底「工具存档点挂在旧节点、新分支纯聊天」等边角。v1 可后置。

**④ 绑定时机 C——切换离开前（v2 建议，v1 不做）**

- 规划 L1644「切换离开当前分支前」：若当前活跃尾分支执行过写工具但无绑定，切换前补建一个存档。**v1 不建议**：补建存档 = 全工作区扫描（昂贵），且切换时 BCP-04 会提示用户；放入 v2 与「切换前自动存档」开关一起评估。

**⑤ 测试**（`backend/__tests__/conversation/branchWorkspace.test.ts` 新建 + 扩展既有）
- `bindWorkspaceCheckpoint`：绑定写入节点并持久化回读；重复绑定取最新；节点不存在/已删除幂等；无图（线性）不建图不抛错。
- `CheckpointService` 绑定接线：mock `createCheckpoint` 返回记录 → 断言 `bindWorkspaceCheckpoint` 被调用（nodeId/checkpointId 正确）；未注入 branch service 时跳过不抛。
- 工具执行链路：`toolBatchCheckpoint.test.ts` 扩展——before/after 存档后节点 `workspaceCheckpointId` 被绑定。

### 1.4 依赖 / 风险 / 批次

- **依赖**：无（不依赖 TREE-04/06/09）。仅依赖 BCP-01（已完成）与 BranchService 既有 `mutateGraph`。
- **风险**：
  - 锁序（见 1.1.5）：绑定必须 fire-and-forget 在 checkpoint 锁外；若未来把绑定改同步 await，须先验证无死锁。
  - 大量工具调用时每次存档都触发一次 sidecar 写：可合并（同一工具批次 before+after 只写一次）、节流（同节点同 checkpoint 已绑定则跳过）——v1 用「同 id 幂等跳过」即可。
  - 节点在绑定前已被软删（TREE-09 并行）→ 幂等跳过即可。
- **批次**：P6b-1（可立即开工，与 TREE-04/06、TREE-09 完全并行）。

---

## 2. BCP-03：切换代码分支时明确工作区文件恢复语义

### 2.1 现状核对

1. **切换目前只改图**：`BranchService.switchBranchCandidate`（L591–604）只做 `switchActivePath` + 持久化，返回 `mainHistoryRewrite: false`。**TREE-06 落地后**该调用才重写主历史（`replaceContents` + 派生状态重建：`clearTrimState` / `invalidateContextManagementState` / `rebuildTodoListMetadataFromHistory` / 用量重建——见 `branch-tree-phases-research.md` 3.2）。
2. **恢复能力完整可复用**：
   - `restoreCheckpoint`（`CheckpointManager.ts` L721）已含工作区互斥、身份校验（`CheckpointRestoreService.ts` L277–288）、legacy 多根拒绝（L291–296）、增量链恢复、`failures`/`error` 摘要；
   - `previewRestore`（L887）可先算计划（`RestorePreviewResult` 含 `failures`/`missingBackupDirs`/`deletablePaths`/`untrackedPaths`/`legacy`）；
   - `CheckpointHandlers.restoreCheckpoint`（L77–127）已有「取消流 + 取消 SubAgent + 刷新派生元数据」完整前置，**BCP-03 应把这段逻辑抽成可复用函数**（避免 handler 与 switch handler 重复）。
3. **恢复后编辑器刷新会静默丢弃未保存内容**：`WorkspaceEditorRefresher.refreshAffectedDocuments`（L23–95）对 dirty 文档用磁盘内容覆盖 buffer 并静默保存——**这是 BCP-05「未保存工作」检查必须拦截的行为**（现状恢复无任何 dirty 检查）。

### 2.2 三种语义定义（建议固化）

| 语义 | 行为 | 适用场景 |
|---|---|---|
| **不动**（chat_only） | 只执行切换（TREE-06 重写主历史），不碰工作区文件；前端明确提示「工作区仍保持当前状态」 | 纯聊天分支、用户只想查看旧回答、读工具分支 |
| **恢复该分支头存档**（workspace） | 切换前/后执行 `previewRestore` + `restoreCheckpoint`（绑定在目标分支的 `workspaceCheckpointId`） | 写工具分支（BCP-04 判据命中）、用户显式选择 |
| **提示确认**（prompt） | 先 `evaluateSwitch` 判定需要联动 → 前端弹确认框（展示恢复计划摘要，复用 previewRestore 确认框）→ 用户选 1 或 2 | 默认模式（决策 1：默认仅切聊天 + 检测到写工具时提示） |

### 2.3 与恢复流程的衔接（顺序建议）

```
switchWithWorkspace(conversationId, nodeId, { mode, confirmedDeleteUntracked })
 ├─ 0. TREE-13 流式互斥检查（复用 rejectIfStreaming，BranchHandlers.ts L59–65）
 ├─ 1. BCP-05 安全校验 assertWorkspaceRestorable（失败 → BranchError，不执行任何切换）
 ├─ 2. 取消流 + 取消关联 SubAgent（抽 CheckpointHandlers.ts L81–111 为公共函数）
 ├─ 3. previewRestore(checkpointId) → 前端展示待删/未跟踪文件（workspace 模式强制预览确认）
 ├─ 4. restoreCheckpoint(conversationId, checkpointId, { deleteUntrackedFiles: confirmed })
 │       （工作区锁内；恢复失败 → 中止，不切分支——「不静默切换」硬约束）
 ├─ 5. switchBranchCandidate(conversationId, nodeId)（TREE-06 落地后含主历史重写 + 派生状态重建）
 └─ 6. refreshDerivedMetadataAfterHistoryMutation(conversationId)（复用 ChatHandlers.ts L83）
```

顺序论证：`restoreCheckpoint` 按 `checkpointId` 定位、不依赖主历史内容，因此「先恢复后切换」与「先切换后恢复」无正确性差异；选「先恢复后切换」可在恢复失败时**完全不改动分支图**（失败原子性更好）。注意步骤 4 与 5 各自有锁（工作区锁 / 会话锁），不嵌套——步骤 4 返回后再进步骤 5。

### 2.4 需要联动工作区的场景分类

- **写工具分支**（节点 parts 含写工具 functionCall，或 `workspaceCheckpointId` 存在）→ 需要联动（至少提示）。
- **纯聊天分支**（无写工具调用、无绑定）→ 只切聊天，不弹窗。
- **切换目标在「同一父节点候选」间**（左右切换）与「跨层级切换」（切到祖先再走另一子树）同规则——`workspaceCheckpointId` 取**目标节点**绑定值（沿目标路径上最近绑定者）。

### 2.5 实施路径（文件 / 接口）

- **新建 `backend/modules/api/chat/services/BranchWorkspaceSwitchService.ts`**（或 `backend/modules/conversation/branch/WorkspaceSwitchService.ts`；建议放 api 层，因依赖 CheckpointManager/CheckpointService 与 handler 取消逻辑）：
  - `evaluateSwitch(conversationId, nodeId)` → `{ mode: 'chat_only' | 'workspace_pending' | 'workspace_forced', checkpointId?, reasons[] }`（BCP-04 判据在此实现）；
  - `assertWorkspaceRestorable(conversationId, checkpointId)`（BCP-05）；
  - `switchWithWorkspace(...)`（上面 2.3 的顺序编排）。
- **BranchHandlers 扩展**：`switchBranchCandidate` 请求扩展 `mode?: 'chat' | 'workspace' | 'auto'`（BCP-04 参数）；新增 `conversation.evaluateBranchSwitch`（前端弹窗前查询）。`mainHistoryRewrite` 字段在 TREE-06 落地后由 BranchService 返回 `true`。
- **webview 抽公共函数**：`cancelStreamAndSubAgents(ctx, conversationId)`（从 `CheckpointHandlers.ts` L81–111 提取），restore 与 switch 共用。
- **前端**（依赖 TREE-10 UI 或最小切换入口）：`branchActions.ts`（新建）——`switchBranchCandidate(conversationId, nodeId, mode)`、`evaluateBranchSwitch`；确认弹窗复用 `MessageList.vue` L1024–1091 的 previewRestore 确认框模式。

### 2.6 依赖 / 风险 / 批次

- **依赖**：**TREE-06 必须已落地**（否则切换后主历史与工作区不一致，BCP-03 无意义）；TREE-10（切换 UI）或最小化确认弹窗；BCP-02（`workspaceCheckpointId` 绑定）。
- **风险**：
  - 恢复期间用户并发编辑（编辑器 dirty buffer）——BCP-05 拦截 + 恢复前提示；
  - 恢复耗时（大工作区）——复用 `checkpoint.getOperationProgress`/`cancelOperation`（CPF-11）展示进度，`restoreCheckpoint` 已支持；
  - 切换后派生状态（TODO/Build/用量）重建顺序——由 TREE-06/07 负责，BCP-03 只保证调用顺序。
- **批次**：P6b-2（TREE-04/06 落地后开工）。

---

## 3. BCP-04：仅切聊天 vs 聊天 + 工作区一起切

### 3.1 现状核对

- **决策 1 已确认**（规划 L2023）：默认仅切聊天；检测到该分支执行过写工具时弹提示；**判据 = `workspaceCheckpointId` 存在性 + 分支内工具名列表，两者取或**。
- 写工具名列表来源：`DEFAULT_CHECKPOINT_CONFIG.beforeTools/afterTools`（`settings/checkpointTypes.ts` L131–182，25 个工具）与运行时 `config.beforeTools/afterTools`；`ToolExecutionService` L307–329 已有「真实工具名集合 ∩ 配置集合」的判定先例。
- 分支内工具名提取：`BranchService.buildCandidateSummary` L169–183 已实现从 parts 提取 `toolNames`（含 filter/map），**可抽为公共纯函数** `collectToolNamesFromParts(parts)`。
- 前端无切换入口/弹窗（TREE-10 未落地）；`frontend/src/stores/chat/types.ts` L101–122 已有分支摘要类型。

### 3.2 判据函数（决策 1，取或）

```
hasWorkspaceCheckpoint(node.workspaceCheckpointId 存在 && workspaceState === 'checkpointed')
    || collectToolNames(nodePathParts).some(name => WRITE_TOOL_NAMES.has(name))
```

- `WRITE_TOOL_NAMES`：运行时 `checkpointConfig.beforeTools ∪ afterTools`；配置缺失时回退 `DEFAULT_CHECKPOINT_CONFIG` 列表（与 `ToolExecutionService` L315–329 同源，保证「该分支是否可能产生存档」与「是否命中写工具」口径一致）。
- 节点路径 parts：沿 `parentId` 链收集目标节点及其祖先（functionCall part 的 `name`），与 `buildCandidateSummary` 提取逻辑一致（决策 8：functionResponse 并入节点，不影响工具名提取）。
- `workspaceState === 'unavailable'`（BCP-05 评估结果）视为**不命中** `hasWorkspaceCheckpoint` 但**仍命中工具名列表** → 仍会提示，但 workspace 模式会被 BCP-05 拒绝——前端此时展示「存档不可用，只能仅切聊天」而非弹恢复确认。

### 3.3 切换请求参数（建议）

```
conversation.switchBranchCandidate { conversationId, nodeId, mode?: 'chat' | 'workspace' | 'auto' }
```

- `mode` 缺省 = `'auto'`（后端/前端按决策 1 演算：判据命中 → 返回 `workspace_pending` 要求前端弹窗；未命中 → `chat_only` 直接切）。
- 后端**不强依赖前端传 mode**：`evaluateSwitch` 是权威判据（前端弹窗只是 UX 层）；`mode='workspace'` 时后端执行 2.3 全流程。
- 默认值：`chat`（决策 1「默认仅切聊天」）——即前端无弹窗时按 `auto` 演算，`auto` 的默认落点是 `chat_only`。

### 3.4 前端确认弹窗流程

```
用户点候选切换（TREE-10 UI）
  → branchActions.switchBranchCandidate(convId, nodeId, 'auto')
  → 后端 evaluateSwitch → { mode: 'workspace_pending', checkpointId, reasons }
  → 前端弹确认框（文案三语 MIG-06）：
      标题：检测到该分支执行过文件写入
      选项 A：仅切换聊天（工作区保持当前状态）
      选项 B：切换聊天并恢复工作区（→ previewRestore 确认框展示待删文件 → confirmedDeleteUntracked）
  → 按选择再调 switchBranchCandidate(mode='chat' | 'workspace')
```

- 复用 `MessageList.vue` L1024–1091 的 previewRestore 确认框（`isRestorePreviewing` 状态模式）。
- 三语文案 key 必须同步（`languageParity.test.ts` 强制对齐，研究 R14）。

### 3.5 实施路径 / 依赖 / 风险

- **文件**：后端 `BranchWorkspaceSwitchService.evaluateSwitch` + `BranchHandlers.switchBranchCandidate` 扩展 + `frontend/src/stores/chat/branchActions.ts`（新建）+ 弹窗组件 + 三语文案。
- **依赖**：BCP-02（绑定字段）、BCP-03（切换语义）、TREE-06（主历史重写）、TREE-10（切换 UI 或最小入口）。
- **风险**：判据口径漂移（配置列表 vs 真实写工具）→ 以 `WRITE_TOOL_NAMES = config ∪ DEFAULT` 固定；`workspaceState='unavailable'` 与判据的交互要写进测试。
- **批次**：P6b-2（与 BCP-03 同批）。

---

## 4. BCP-05：工作区无法安全恢复时禁止静默切换

### 4.1 现状核对（什么算「无法安全恢复」——已有检测组件盘点）

| 失败类别 | 现有检测 | 现状证据 | 建议错误码 |
|---|---|---|---|
| 存档记录缺失 | `getCheckpoints` 找不到 checkpointId | `CheckpointQueryService` L93–125 | `WORKSPACE_STATE_UNAVAILABLE` |
| 存档备份目录缺失 | `previewRestore.missingBackupDirs` | `CheckpointManager.previewRestore` L887–994（`CheckpointManager.ts` L925） | `WORKSPACE_CHECKPOINT_BROKEN` |
| 增量链断裂 | `previewRestore.failures[].reason === 'missing_in_chain'` | `checkpoint/types.ts` L191–199 / L271 | `WORKSPACE_CHECKPOINT_BROKEN` |
| 工作区身份不符 | `validateWorkspaceSnapshot` → `WORKSPACE_MISMATCH` / `WORKSPACE_IDENTITY_MISSING`；restore 返回 `workspaceMismatch` | `CheckpointWorkspace.ts` L89–126；`CheckpointRestoreService.ts` L277–288 | `WORKSPACE_STATE_UNAVAILABLE` |
| 无工作区根 | `restoreCheckpoint` roots.length===0 → error 'No workspace root' | `CheckpointManager.ts` L727–730 | `WORKSPACE_STATE_UNAVAILABLE` |
| legacy 存档 + 多根 | restore 拒绝 | `CheckpointRestoreService.ts` L291–296 | `WORKSPACE_STATE_UNAVAILABLE` |
| **未保存工作（dirty 文件）** | **无检测**（现状恢复会经 `WorkspaceEditorRefresher` 静默丢弃 dirty buffer） | `WorkspaceEditorRefresher.ts` L44–59 | `WORKSPACE_STATE_UNAVAILABLE`（新增） |

### 4.2 新增检测：未保存工作

- 位置：`BranchWorkspaceSwitchService.assertWorkspaceRestorable`（workspace 模式强制）。
- 实现：遍历 `vscode.workspace.textDocuments`，`doc.uri.scheme === 'file'` 且 `doc.isDirty` 且 `doc.uri.fsPath` 位于任一 runtime workspace root 内 → 命中。
- 语义：命中时 **workspace 模式切换被拒绝**（`WORKSPACE_STATE_UNAVAILABLE`，message 列出文件），前端提示「请先保存或放弃更改」；chat_only 模式不受影响。
- 注意：该检查只在切换的 workspace 模式执行；普通 `checkpoint.restore`（用户显式回档）是否同样拦截属于产品决策——**建议同批一并接入**（现状静默丢弃 dirty buffer 是既有隐患），但需主人确认。

### 4.3 禁止静默切换的硬约束

- `switchWithWorkspace` 中 `assertWorkspaceRestorable` 任何失败 → 抛 `BranchError`（错误码如上），**不执行 `switchBranchCandidate`**、不执行 restore——分支图与工作区都保持原状（失败原子性）。
- 前端收到 `WORKSPACE_STATE_UNAVAILABLE` / `WORKSPACE_CHECKPOINT_BROKEN` 后降级提示「仅切聊天」可用，且不自动静默降级（决策 1 的提示语义：提示确认 ≠ 静默降级）。

### 4.4 实施路径 / 依赖 / 批次

- **文件**：`BranchWorkspaceSwitchService.assertWorkspaceRestorable`（组合 4.1 表格全部检测）+ `BranchErrorCode` 复用（已预留，无需新增）+ handler 错误映射（`sendBranchError` 已透传 `BranchError.code`，`BranchHandlers.ts` L80–88）+ 前端错误文案（三语）。
- **依赖**：BCP-02/03；TREE-04/06（切换入口）；`vscode.workspace.textDocuments` 检测无后端依赖。
- **批次**：P6b-2。建议把「普通 restore 的 dirty 拦截」单独立项（需主人确认，见 4.2 注意）。

---

## 5. BCP-06：分支删除时按引用计数清理存档

### 5.1 现状核对

1. **存档无引用计数字段**：`CheckpointRecord`（`checkpoint/types.ts` L280–333）无 `referenceCount`/`referencedBy`。规划给出两条路（L1653–1657）：持久化 `checkpointReferenceCount` 或 **扫描所有 BranchGraph 计算**。
2. **分支侧删除现状**：
   - 软删：`deleteBranchCandidate`（`BranchService.ts` L613–656）单节点标记 `deleted` + 摘要同步，**不动存档**（软删节点仍引用存档直到物理清理，语义正确）；
   - 物理清理：`BranchGraph.pruneDeletedNodes`（L833–906）返回 `prunedNodeIds`，但 **BranchService 未暴露公共 prune 方法**（TREE-09 进行中）。
3. **存档侧删除现状**：
   - `deleteCheckpointsBatch`（`CheckpointManager.ts` L1270–1390）：`forcedKeep` 祖先闭包（L1312）——被保留节点直接/间接引用为 `baseCheckpointId` 的存档**强制保留**并返回 `rejectedIds`（CP-05）；
   - `CheckpointRetentionService`（L42–216）：`maxCheckpoints` 超限清理 + `mergeCheckpointIntoSuccessor` 链重挂（删除被后继引用的中间节点时把备份内容并入后继）。
4. **存档的三种引用**（规划 L1661–1664）：① 会话摘要引用（`conversation.custom.checkpoints` 列表本身）；② 分支节点引用（`workspaceCheckpointId`）；③ 增量后继引用（`baseCheckpointId`）。

### 5.2 计数模型建议（v1 扫描，v2 可选持久化）

- **v1 推荐「扫描所有 BranchGraph」**（规划 L1657 选项）：
  - `BranchGraphRepository.listConversationIds()`（L94–115）列出全部 sidecar 会话；
  - 逐个 `load` → 收集存活节点（`!deleted`）的 `workspaceCheckpointId` 集合 → 得到「存档 id → 引用节点数」；
  - 被删除分支（软删中）的节点**不计数**（保留期内的 deleted 节点引用不算，因为 prune 后即失效）；但**物理清理动作本身**应以「prune 后扫描」为准（见 5.3 顺序）。
  - 理由：软删除期间引用语义复杂（deleted 节点仍存在）、持久化 counter 需要绑定/解绑/迁移三处维护且崩溃不一致风险高；节点数有限，扫描成本可接受（与 `listConversationIds` 全量扫描同量级，MIG-05 完整性工具已有先例）。
- **v2 可选**：branches.json 图级元数据 `checkpointRefCounts: Record<checkpointId, number>`，绑定/解绑时维护（BCP-02 的 `bindWorkspaceCheckpoint` 与 TREE-09 的 prune 各增减），崩溃后用扫描自愈。**不建议 v1 做**。

### 5.3 联动清理时序（依赖 TREE-09）

```
prune（TREE-09 落地后：BranchService.pruneBranchCandidates 暴露）
  ├─ 1. pruneDeletedNodes 返回 prunedNodeIds（BranchGraph.ts L905）
  ├─ 2. 收集 prunedNodeIds 引用的 checkpointIds（workspaceCheckpointId 去重）
  ├─ 3. 重新扫描全部 sidecar（或基于 prune 前的引用快照增量减）：计算每个 checkpoint 的剩余存活引用数
  ├─ 4. 引用归零的 checkpointIds → 进入「待删候选」（仅本对话的；跨对话引用天然计数，安全）
  ├─ 5. 调 checkpointManager.deleteCheckpointsBatch([{ conversationId, checkpointIds: 待删候选 }])
  │       ——其内部 forcedKeep 祖先闭包（CP-05）自动拒绝「被保留节点引用为 base」的存档（rejectedIds），
  │         需要链重挂时由 CheckpointRetentionService.mergeCheckpointIntoSuccessor 处理（v1 可先跳过重挂，
  │         直接依赖 rejectedIds 语义：被后继引用的存档不删）
  └─ 6. 记录/日志：deletedIds / rejectedIds（可观测，前端设置页「分支清理」区块展示）
```

- 与 `CheckpointRetentionService` 的关系：**职责正交**——Retention 管「数量上限」（maxCheckpoints），BCP-06 管「引用归零」；两者共用 `deleteCheckpointInternal`/`mergeCheckpointIntoSuccessor` 原语，不互相调用（避免清理风暴）。若同批出现「超限 + 引用归零」，先跑 Retention（按时间）再跑 BCP-06（按引用），或合并为一个清理入口（v2）。
- **软删不清理**：`deleteBranchCandidate` 不触发任何存档删除（保留期内可恢复，决策 3）；只有物理 prune 才触发。
- **「删除到某条消息」（决策 6）**：`deleteToMessage` 同步软删分支子树时同样不动存档；其子树软删后引用仍在 → 由后续 prune 统一清理。

### 5.4 需要新增的存档侧能力

- **按 nodeId 删除/查询（研究 3.3 的 `deleteCheckpointsByNodeId`）**：
  - `CheckpointManager`（或 `CheckpointService`）新增 `deleteCheckpointsByNodeIds(conversationId, nodeIds)`：按 `record.messageNodeId ∈ nodeIds` 过滤 + 复用 `deleteCheckpointsBatch` 的 forcedKeep 祖先闭包逻辑（可把 L1297–1350 的闭包计算抽成纯函数 `computeForcedKeepIds(records, keepIds)`）。
  - 用途：① 分支子树物理删除时按 nodeId 闭包清理该分支专属存档；② BCP-06 步骤 5 的按引用归零清理可复用其「强制保留被引用者」语义。
- 注意兼容红线（研究 3.3）：**旧存档无 messageNodeId → 回退 index 匹配 + warn**；`deleteCheckpointsByNodeIds` 对无 nodeId 记录不做任何操作（不误删）。

### 5.5 实施路径 / 依赖 / 批次

- **文件**：`CheckpointManager.ts`（`deleteCheckpointsByNodeIds` + 抽出 `computeForcedKeepIds`）、`BranchService.ts`（`pruneBranchCandidates` 暴露，依赖 TREE-09）、`BranchWorkspaceSwitchService` 或新 `BranchCheckpointCleanupService`（引用扫描编排）、测试。
- **依赖**：**TREE-09 落地**（prune 公共方法）；BCP-02（绑定字段是引用来源）；`deleteCheckpointsBatch` 既有闭包逻辑（已存在）。
- **风险**：全量扫描 sidecar 的 I/O（对话多时）；跨对话引用计数（同一 checkpointId 不可能跨对话——`checkpointId` 全局唯一生成（`generateCheckpointId` L147–149），故引用计数按对话内即可，跨对话无需考虑）；并发（清理与绑定竞态：绑定迟到 → 引用快照过期 → 已删存档被迟到绑定引用 → 恢复时报缺档。缓解：清理先于 prune 在会话写锁内完成绑定快照，且 BCP-05 恢复前仍校验存档存在性）。
- **批次**：P6b-3（TREE-09 落地后）。

---

## 6. BCP-07：分支存档共享不可变内容

### 6.1 现状评估（读代码确认：文件级已天然共享）

1. **增量链去重是核心共享机制**：`createCheckpoint` 以 `lastCheckpoint` 为基（L312–315），`computeChanges` 只计算 `added/modified/deleted`（L679–704），复制只拷贝变更文件（`copyTargets` L412–425）；未变化文件不重复落盘，恢复时经 `baseCheckpointId` 链回溯（`manifest.files[].backupSourceCheckpointId`，`checkpoint/types.ts` L105）。
2. **分支间共享 = 引用共享**：BCP-02 使多个节点 `workspaceCheckpointId` 指向同一 `checkpointId` → 同一备份目录被多分支引用，**磁盘零重复**；BCP-06 引用计数保证其正确回收。
3. **真正冗余的只有**：① 每个 checkpoint 的元数据记录 + manifest（小）；② sidecar 中节点 `parts` 的聊天文本（与存档无关，属分支图设计取舍，研究 R8 已接受第一版冗余）。
4. **同内容重复创建的存档**：`createCheckpoint` 不检查 `contentHash` 去重（`contentHash` 仅用于前端合并显示，`mergeUnchangedCheckpoints` 是显示层语义，`checkpointTypes.ts` L46–56）——同一工作区状态反复创建会产生内容相同但 id 不同的存档记录（备份文件因增量链不重复，仅记录重复）。

### 6.2 需要额外做什么（结论：几乎不需要）

| 项 | 是否做 | 说明 |
|---|---|---|
| 文件级共享 | **已满足** | 增量链 + `backupSourceCheckpointId` 天然共享，无需改 |
| 分支引用共享 | **BCP-02 提供** | 多节点绑同一 checkpointId 即共享 |
| 内容哈希去重创建 | **v1 不做**（可选优化） | 改动会改变存档列表行为（同内容多条变一条），影响既有 UI/测试；如做，在 `createCheckpoint` 中当 `contentHash === lastCheckpoint.contentHash && changes 为空` 时返回 null 或复用记录，需主人确认 |
| manifest/元数据去重 | **v1 不做** | 量级小，收益低 |
| 文档固化语义 | **做** | 在 `branch/types.ts` workspaceCheckpointId 注释 + 研究/测试中固化「同 checkpoint 可被多节点引用，删除按 BCP-06 引用计数」 |

### 6.3 依赖 / 批次

- 依赖：BCP-02（引用共享）、BCP-06（回收语义）。
- 批次：并入 P6b-3（主要是验证 + 测试 + 文档，无独立代码量）。

---

## 7. BCP-08：一致性测试清单（场景矩阵）

### 7.1 测试文件规划

```
backend/__tests__/conversation/branchWorkspace.test.ts     // BCP-02 绑定 + BCP-03/04 切换编排（纯函数层）
backend/__tests__/conversation/branchSwitchWorkspace.test.ts // BCP-03/04/05 集成（switchWithWorkspace 顺序/失败原子性）
backend/__tests__/checkpoint/checkpointNodeRef.test.ts      // BCP-06 引用计数 + deleteCheckpointsByNodeIds
backend/__tests__/checkpoint/CheckpointManager.test.ts      // 扩展：BCP-06 闭包抽函数
frontend/src/stores/chat/__tests__/branchActions.test.ts    // BCP-04 前端：evaluateSwitch/弹窗/降级
```

### 7.2 场景矩阵

| # | 场景 | 断言 | 覆盖 BCP |
|---|---|---|---|
| 1 | 写工具执行 → before/after 存档 → 节点绑定最新 checkpointId | `node.workspaceCheckpointId === after.id`、`workspaceState==='checkpointed'` | 02 |
| 2 | 连续工具多次存档 → 绑定为最新（timestamp 最大） | 覆盖旧绑定 | 02 |
| 3 | before 存档（nodeId undefined）→ 不绑定不抛错 | 幂等跳过 | 02 |
| 4 | 线性对话（无图）工具存档 → 不强制建图、不绑定 | 无副作用 | 02 |
| 5 | 绑定已软删节点 → 幂等跳过 | 不复活 | 02 |
| 6 | 切到纯聊天分支（无写工具、无绑定）→ `evaluateSwitch='chat_only'`，不弹窗 | mode 判定 | 03/04 |
| 7 | 切到写工具分支（parts 有写工具名但无绑定）→ `workspace_pending`（工具名列表命中） | 决策 1 取或 | 04 |
| 8 | 切到有绑定分支（`workspaceCheckpointId` 存在）→ `workspace_pending`（存在性命中） | 决策 1 取或 | 04 |
| 9 | workspace 模式：previewRestore 失败（missing_in_chain）→ 抛 `WORKSPACE_CHECKPOINT_BROKEN`，分支图与工作区均未变 | 失败原子性 | 05 |
| 10 | workspace 模式：存档备份目录缺失 → `WORKSPACE_CHECKPOINT_BROKEN` | 同上 | 05 |
| 11 | workspace 模式：工作区身份不符（换工作区打开）→ `WORKSPACE_STATE_UNAVAILABLE` | 复用 `validateWorkspaceSnapshot` | 05 |
| 12 | workspace 模式：roots 为空 → `WORKSPACE_STATE_UNAVAILABLE` | 同上 | 05 |
| 13 | workspace 模式：dirty 文件在工作区内 → 拒绝 + 列出文件（新增检测） | 未保存工作拦截 | 05 |
| 14 | chat_only 模式：dirty 文件存在 → 不拦截（不检查） | 模式差异 | 05 |
| 15 | workspace 模式成功路径：取消流 → restore → switch → refreshDerivedMetadata 顺序正确；恢复失败不切分支 | 顺序/原子性（2.3） | 03 |
| 16 | 切换后主历史与图活跃路径一致（TREE-06 落地后） | `validateActivePathMatchesHistory.valid` | 03 |
| 17 | 软删分支节点 → 存档不删（保留期可恢复） | 软删不动存档 | 06 |
| 18 | prune 过期节点 → 引用归零存档被物理删除（`deleteCheckpointsBatch` 收到正确 ids） | 引用计数 | 06 |
| 19 | prune 后存档仍被其他存活节点引用 → 不删 | 引用计数 | 06 |
| 20 | prune 后存档被保留节点引用为 base（增量链）→ `rejectedIds`（forcedKeep） | CP-05 闭包兼容 | 06 |
| 21 | 旧存档（无 messageNodeId）+ `deleteCheckpointsByNodeIds` → 不误删 + warn | 兼容红线 | 06 |
| 22 | 两分支绑定同一 checkpointId → 只存一份备份，删除任一分支不影响另一分支恢复 | 共享不可变内容 | 07 |
| 23 | 多分支共享存档 + 全部节点 prune → 引用归零 → 删除 | 组合 | 06/07 |
| 24 | 流式生成期间 evaluateSwitch/switchWithWorkspace → `BRANCH_BUSY` | TREE-13 互斥延续 | 03 |
| 25 | 恢复+切换与工具执行并发 → 工作区锁串行、无死锁 | 锁序（R5） | 03/05 |
| 26 | 前端：`evaluateBranchSwitch` → 弹窗（A/B 选项）→ 按选择调用 mode；`WORKSPACE_STATE_UNAVAILABLE` 时仅展示「仅切聊天」 | branchActions.test | 04/05 |

---

## 8. 依赖关系与批次划分建议（P6b）

```
P6b-1（可立即开工，无外部依赖）
  └─ BCP-02：bindWorkspaceCheckpoint + CheckpointService 绑定 + finishReroll 兜底 + 测试
        └─ 解锁：BCP-03/04 的 workspaceCheckpointId 判据；BCP-06 的引用来源
P6b-2（依赖 TREE-04/06 落地 + P6b-1）
  └─ BCP-03：BranchWorkspaceSwitchService（evaluateSwitch/switchWithWorkspace）+ 取消逻辑抽取
  └─ BCP-04：mode 参数 + 判据（决策 1）+ 前端 branchActions + 确认弹窗 + 三语文案
  └─ BCP-05：assertWorkspaceRestorable（含 dirty 检测）+ 错误码映射
        └─ 普通 restore 的 dirty 拦截 → 单独立项待主人确认
P6b-3（依赖 TREE-09 落地 + P6b-1）
  └─ BCP-06：deleteCheckpointsByNodeIds + computeForcedKeepIds 抽取 + 引用扫描编排 + prune 联动
  └─ BCP-07：验证 + 文档 + 测试（无独立代码量）
BCP-08：跨批次补测试（P6b-1 补 1–5；P6b-2 补 6–16、24–26；P6b-3 补 17–23）
```

### 8.1 前置阻塞项提醒

- **TREE-04/06**：`switchBranchCandidate` 需从 `mainHistoryRewrite:false` 变为完整主历史重写（`replaceContents` + 派生状态重建 + 规范化落盘——`branch-tree-phases-research.md` 3.2 的四个关键坑），BCP-03 才能闭环。**建议 TREE-06 批次把 `BranchSwitchResult.mainHistoryRewrite` 字段语义落实并测试。**
- **TREE-09**：`pruneDeletedNodes`/`restoreNode` 需经 BranchService 暴露公共方法（`pruneBranchCandidates` / `restoreBranchCandidate`），BCP-06 才能编排。
- **`tree04-06-switch.md` 研究文档缺失**：建议 TREE-04/06 批次补充落盘，本文 2.3 的切换顺序以「TREE-06 完成后 switchBranchCandidate 同步重写主历史」为前提。

### 8.2 风险清单（汇总）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 绑定与 checkpoint 锁嵌套死锁 | 绑定 fire-and-forget 于 checkpoint 锁外（1.3②） |
| R2 | 切换恢复失败后分支图已改（不静默切换被绕过） | 2.3 顺序：恢复失败不执行 switch；handler 层统一入口 |
| R3 | dirty buffer 被静默丢弃 | BCP-05 dirty 检测（4.2）；普通 restore 拦截待确认 |
| R4 | 引用计数与绑定竞态（迟到绑定 → 已删存档被引用） | 清理在会话写锁内取绑定快照；BCP-05 恢复前仍校验存档存在性 |
| R5 | 全量扫描 sidecar I/O | v1 接受（与 MIG-05 同量级）；v2 图级 refCounts |
| R6 | 判据口径漂移（写工具列表） | `WRITE_TOOL_NAMES = config ∪ DEFAULT` 单一口径 + 测试固化 |
| R7 | 三语文案同步 | `languageParity.test.ts` 强制；MIG-06 同批 |
| R8 | TREE-06 未落地导致 BCP-03/04 假实现 | 批次硬依赖；P6b-2 开工前确认 TREE-06 状态 |

---

## 9. 结论

1. **BCP-02 是唯一无外部依赖、可立即开工的项**：字段/错误码已预留，绑定主路径（工具执行存档点 → `bindWorkspaceCheckpoint` fire-and-forget）改动面小（BranchService + CheckpointService + 测试）。
2. **BCP-03/04/05 是一组**，共同构成「切换 + 工作区联动」闭环，**硬依赖 TREE-04/06**；建议 TREE-06 落地后整组实施，顺序为 BCP-02（已先行）→ BCP-03 编排 → BCP-04 判据/UI → BCP-05 安全闸。
3. **BCP-06 硬依赖 TREE-09**（prune 公共方法）与 BCP-02（引用来源）；计数模型 v1 用「扫描所有 BranchGraph」，存档删除复用 `deleteCheckpointsBatch` 的祖先闭包语义，与 `CheckpointRetentionService` 职责正交。
4. **BCP-07 现状已基本满足**（增量链天然共享 + BCP-02 引用共享），只需文档与测试固化；唯一可选优化（内容哈希去重创建）需主人确认。
5. **BCP-08 测试矩阵见第 7 节**，随各批次的单元/集成测试落地，重点覆盖「失败原子性」（05）、「顺序编排」（03）、「引用归零」（06）、「决策 1 取或判据」（04）。
