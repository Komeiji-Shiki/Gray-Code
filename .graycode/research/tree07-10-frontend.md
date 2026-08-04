# TREE-07 + TREE-10 前端基础：切换后派生状态重建 + 候选切换器 UI（第六阶段批次）

- 范围：TREE-07（切换后派生状态重建，前端）+ TREE-10（候选切换器 + 分支状态 UI）+ MIG-06 文案（三语同步）+ 测试
- 性质：前端为主，后端只读（仅确认 `branch.getBranchGraph` / `switchBranchCandidate` / `deleteBranchCandidate` 返回结构）
- 参考：`checkpoint-history-branch-architecture.plan.md`（TREE-07/10 + 完成定义 13）、`branch-tree-phases-research.md`、`tree03-05-edit-branch.md` 等既有研究报告
- 说明：`.graycode/research/tree04-06-switch.md` 未落盘，切换后端返回结构以代码为准（见下）

---

## 一、设计说明

### 1. 后端契约确认（只读核实，以代码为准）

- `conversation.getBranchGraph`（BranchHandlers.ts → BranchService.getBranchGraph）：
  - 响应 `{ graph, errorCode?, errorMessage? }`；`graph: null` 表示无图（线性模式）或损坏降级（`errorCode: 'BRANCH_STORAGE_CORRUPT'`）。
  - graph 结构：`{ version, rootNodeId, activeTailNodeId, activeChildId?, nodes: Record<id, node>, candidateSummaries?, exportedFrom?, exportedRefs? }`；
    node：`{ id, parentId, role, parts, kind, createdAt, timestamp?, modelVersion?, activeChildId?, label?, deleted?, ... }`。
- `conversation.switchBranchCandidate`（TREE-04/06 底座，**本阶段后端只切图状态不重写主历史**）：
  - 响应 `{ success: true, nodeId, activeTailNodeId, activePathIds, mainHistoryRewrite: false }`。
  - 注意：任务约定文案中的 `{ branchGraph, activePathLength, rewritten }` 与代码不符，**按代码字段实现**；
    前端切换成功路径统一走「重载历史（loadHistory）」而非依赖响应内嵌历史，因此 TREE-06 后端重写主历史落地后无需改前端。
- `conversation.deleteBranchCandidate`：`{ success: true, nodeId, deleted, clearedParentActiveChild }`；活跃路径节点拒绝删除（`BRANCH_OPERATION_CONFLICT`）。
- 错误码：`BRANCH_BUSY`（流式互斥，后端 TREE-13 已保证）、`NODE_NOT_FOUND`、`BRANCH_OPERATION_CONFLICT`、`BRANCH_STORAGE_CORRUPT`、`INTERNAL_ERROR`。

### 2. TREE-07：切换后派生状态重建（`stores/chat/branchActions.ts` 新增）

`switchBranchCandidate(state, nodeId)` 全链路：

1. **前置防护（双保险）**：
   - `isStreaming || isWaitingForResponse` → 写 `{ code: 'BRANCH_BUSY', message: '会话正在流式生成中，请等待完成后再操作' }`（与后端文案一致）并拒绝，不发 IPC；
   - `isSwitchingBranch` 置位期间拒绝并发切换/删除（防双击）；
   - 无当前对话 / 非法 nodeId 短路。
2. **成功路径（按任务要求顺序）**：
   - 清理错误条 / 流式残留：`error=null`、`streamingMessageId=null`、`activeStreamId=null`、`_lastCancelledStreamId=null`、`_failedStreamMessageId=null`、`isStreaming=false`、`isWaitingForResponse=false`、`retryStatus=null`；
   - TODO / Build 重置（**取舍**：先做「重置为待定/清空」而非按新活跃路径重算——按新路径重算需要后端提供「从历史重放 TODO/Build」的回传或前端对全部历史做 replay；本批以 `toolResponseCache` 清空让 `todoSnapshot` 基于新窗口重放为「待定」+ `activeBuild` 置空实现，语义安全且零额外 IPC；精确重算留待 TREE-07 后端重建 API 落地）；
   - 重载历史：`loadHistory(state)`（内部 `renderMessageWindow` → `rebuildMessageIndexById` 同步重建 `messageIndexById` / `toolResponseIndex`）；后端 TREE-06 落地后 `getMessagesPaged` 返回新活跃路径，本批后端未重写时返回原历史，窗口语义保持一致；
   - 检查点列表刷新：`loadCheckpoints(state)`（messageIndex 按新活跃路径重映射）；
   - 分支图刷新：`loadBranchGraph(state)`（切换器数据源）。
3. **失败路径（回滚）**：预先捕获 UI 快照（allMessages / windowStartIndex / totalMessages / checkpoints / toolResponseCache / branchGraph / activeBuild），失败时 `rebuildMessageIndexById` 后整体回滚，仅写错误条（错误码透出，未知异常兜底 `BRANCH_SWITCH_ERROR`）。
4. **竞态归属**：所有 `await` 后 `validateSessionIdentity(state, conversationId)` 校验，防切换对话后写错状态。

`deleteBranchCandidate(state, nodeId)`：软删除非活跃候选（后端拒绝删活跃路径节点），成功后仅刷新分支图（活跃路径不变，无需重载历史/检查点）。

### 3. TREE-10：候选切换器（`components/message/BranchSwitcherBar.vue` 新增）

- **数据源**：`chatStore.branchGraph`（`loadBranchGraph` / `refreshBranchGraph` 调 `conversation.getBranchGraph`）；
  打开对话（switchConversation / openConversationInTab / branchFromMessage / createNewConversation）后由 chatStore 接线 `void loadBranchGraph(state)`。
- **候选组推导**：纯函数 `buildCandidateGroup(graph)` —— 取当前活跃尾节点（`activeTailNodeId`）的**同父兄弟候选**（过滤 `deleted`，按 `createdAt` 升序），返回 `{ parentNodeId, candidates, activeIndex }`；无图 / 无活跃尾 / 无候选返回 null。
- **显隐**：无分支图 / 单候选 / 无当前对话时整个组件隐藏（`v-if="visible"`）。
- **交互**：
  - `‹ 2 / 3 ›`：左/右箭头循环切换到上/下一个候选（`chatStore.switchBranchCandidate`）；中间位置按钮展开候选列表（下拉）；
  - 候选列表：每行显示预览（label > parts 文本 > 「（无预览）」）、活跃项标「当前」、hover 显示模型版本 / 节点类型；点击切换；
  - **删除候选**：仅非活跃候选显示删除按钮，**两步确认**（第一次点击进入确认态，再次点击才调用 `deleteBranchCandidate`，防误删）；
  - `isSwitchingBranch` 期间全部按钮禁用 + 加载图标。
- **样式**：沿用 MessageList build-bar / 检查点条的 VS Code 主题 token（`--vscode-*` 变量、codicon、8pt 间距、扁平化圆角）。

### 4. 未做项与理由（明确取舍）

- **reroll 按钮**：前端尚无 reroll 入口（TREE-01 前端接线不在本批文件边界），任务要求「已有入口才复用」，故不新增。
- **「新建候选」按钮**：后端 `createRerollCandidate` 可用，但空 parts 建候选会「图活跃路径指向空节点 + 主历史未重写」造成短暂不一致；正确的新建候选流是 reroll 流式（TREE-01 前端职责），故本批不展示该按钮，报告注明。
- **CheckpointSettings.vue**：未触碰（另一个批次在加分支清理区块）。
- **webview/handlers/ChatHandlers.ts、MessageRouter.ts**：未触碰（另一个批次在改）。
- **CHANGELOG.md / 规划文档 / backend/**：未修改。

### 5. 文件边界说明

全部改动落在允许清单内：
- `frontend/src/stores/chat/types.ts`（新增分支类型 + 3 个状态字段）、`state.ts`（branchGraph / branchGraphLoading / isSwitchingBranch）、`chatStore.ts`（接线 + 4 处打开对话时刷新分支图）、**新增** `branchActions.ts`；
- `frontend/src/components/message/`：**新增** `BranchSwitcherBar.vue`、`MessageList.vue`（2 处最小插入：import + 挂载点）；
- `frontend/src/i18n/langs/{zh-CN,en,ja}.ts`：`components.message.branch.*` 共 8 个 key 三语同步（无占位符）；
- 测试：**新增** `stores/chat/__tests__/branchActions.test.ts`（20 用例）、`components/message/__tests__/BranchSwitcherBar.test.ts`（11 用例）。

---

## 二、修改摘要

| 文件 | 变更 |
|---|---|
| `frontend/src/stores/chat/types.ts` | 新增 `BranchNodeData` / `BranchCandidateSummaryData` / `BranchGraphData`；`ChatStoreState` 新增 `branchGraph` / `branchGraphLoading` / `isSwitchingBranch` |
| `frontend/src/stores/chat/state.ts` | `createChatState` 新增上述 3 个 ref 并返回 |
| `frontend/src/stores/chat/branchActions.ts`（新增） | `BRANCH_BUSY_MESSAGE`；`buildCandidateGroup`（纯函数）；`loadBranchGraph` / `refreshBranchGraph`；`switchBranchCandidate`（TREE-07 重建链路 + 快照回滚 + BRANCH_BUSY 防护 + 会话归属校验）；`deleteBranchCandidate` |
| `frontend/src/stores/chatStore.ts` | 导入并暴露 `branchGraph` / `branchGraphLoading` / `isSwitchingBranch` / `loadBranchGraph` / `refreshBranchGraph` / `switchBranchCandidate` / `deleteBranchCandidate`；`createNewConversation` / `switchConversation` / `openConversationInTab` / `branchFromMessage` 打开对话后 `void loadBranchGraphAction(state)` |
| `frontend/src/components/message/BranchSwitcherBar.vue`（新增） | TREE-10 候选切换器：`‹ 2 / 3 ›` + 候选下拉列表 + 两步删除 + 忙碌态禁用 |
| `frontend/src/components/message/MessageList.vue` | import + 消息区顶部挂载 `<BranchSwitcherBar />`（2 行最小插入） |
| `frontend/src/i18n/langs/zh-CN.ts` / `en.ts` / `ja.ts` | `components.message.branch.{previous,next,candidateList,switchTo,delete,deleteConfirm,active,noPreview}` 三语同步 |
| `frontend/src/stores/chat/__tests__/branchActions.test.ts`（新增） | 20 用例：loadBranchGraph（成功/无图/损坏/失败保留旧值/无会话/别名）；buildCandidateGroup（null/尾缺失/排序过滤/单候选）；switchBranchCandidate（成功全链路重建、NODE_NOT_FOUND 回滚、未知异常兜底、BRANCH_BUSY ×2、并发拒绝、参数短路）；deleteBranchCandidate（成功仅刷图/失败/BRANCH_BUSY） |
| `frontend/src/components/message/__tests__/BranchSwitcherBar.test.ts`（新增） | 11 用例：显隐（无图/单候选/无会话/显示位置）；切换（‹/› 循环、列表点击、活跃标注）；删除（两步确认、确认目标转移）；忙碌态禁用 |

---

## 三、验证结果

- `npm --prefix frontend test`：**20 个测试文件全部通过，231/231 用例通过**（含既有全部测试 + 新增 branchActions 20 例 + BranchSwitcherBar 11 例）。
- `npm --prefix frontend run typecheck`（vue-tsc --noEmit）：**通过，0 错误**。
- `npm run typecheck`（根 tsc --noEmit，后端未改）：**通过**。
- 后端 i18n 一致性：`npx jest --config jest.backend.config.js backend/__tests__/i18n/languageParity.test.ts` **4/4 通过**（前端三语 key 集合与占位符一致）。
- 未运行后端全量 Jest（本批后端零改动，仅以 typecheck + i18n parity 验证受影响面）。

## 四、后续接线提示（非本批范围）

1. TREE-06 后端重写主历史落地后，`switchBranchCandidate` 成功后 `loadHistory` 自动拿到新活跃路径，前端无需改动；若后端响应新增 `rewritten` / 内嵌历史字段，可在 `branchActions.ts` 成功路径做条件消费。
2. 流式完成（handleComplete）后刷新分支图（`refreshBranchGraph`）不在本批文件边界（streamHandler.ts），后续批次可接线，保证发送新消息后切换器位置同步。
3. 「新建候选」（reroll 入口）与「从候选继续对话」（TREE-05）待 TREE-01 前端接线批次实现。
