# TREE-11 + TREE-12：完整分支树查看面板 + 标签页快照保存分支图（第六阶段批次）

- 范围：TREE-11（分支树查看面板）+ TREE-12（标签页快照保存 branchGraph）+ MIG-06 文案（三语同步）+ 测试
- 性质：前端为主，后端只读（仅确认 `branch.getBranchGraph` / `restoreBranchCandidate` / `renameBranchCandidate` 返回结构）
- 参考：`checkpoint-history-branch-architecture.plan.md`（TREE-11/12 清单项）、
  `.graycode/research/tree07-10-frontend.md`（TREE-10 前置：branchGraph 状态 / branchActions 7 动作 / BranchSwitcherBar）、
  `.graycode/research/tree04-06-switch.md`（切换链路 / 响应结构）、`tree09-branch-mgmt.md`（软删/恢复/重命名语义）
- 前置已完成：`chatStore.branchGraph` 状态、`conversation.getBranchGraph` API、BranchSwitcherBar（‹ 2/3 › 切换）、
  软删除（deleted / deletedAt）、`restoreBranchCandidate` / `renameBranchCandidate` 后端 handler

---

## 一、设计说明

### 1. 后端契约确认（只读核实，以代码为准）

- `conversation.getBranchGraph`（BranchHandlers.ts → BranchService.getBranchGraph）：
  - 响应 `{ graph, errorCode?, errorMessage? }`；`graph: null` = 无图（线性模式）或损坏降级（`BRANCH_STORAGE_CORRUPT`）。
  - graph 结构：`{ version, rootNodeId, activeTailNodeId, activeChildId?, nodes: Record<id, node>, candidateSummaries?, exportedFrom?, exportedRefs? }`；
    node：`{ id, parentId, role, parts, kind, createdAt, timestamp?, modelVersion?, activeChildId?, label?, deleted?, deletedAt?, workspaceCheckpointId?, workspaceState?, exportedFrom? }`。
  - **注意**：`deletedCount` / `activePathIds` **不在 getBranchGraph 的 graph 里**（`deletedCount` 属于
    `getBranchGraphMeta` 的元信息结果；`activePathIds` 属于 switch/delete 的返回）。前端活跃路径在本地
    沿 `activeChildId` 链推导（见 §2），不依赖后端下发。
- `conversation.restoreBranchCandidate`（TREE-09）：入参 `{ conversationId, nodeId }`；
  响应 `{ success: true, ...result }`；清除节点/候选摘要的 `deleted / deletedAt`，**不自动重新激活**；
  流式期间被拒（BRANCH_BUSY）。
- `conversation.renameBranchCandidate`（TREE-09）：入参 `{ conversationId, nodeId, label }`；
  响应 `{ success: true, ...result }`；只改 label（节点 + 候选摘要同步，不动 contents）；
  流式期间被拒（BRANCH_BUSY）。
- 错误码：`BRANCH_BUSY`、`NODE_NOT_FOUND`、`BRANCH_OPERATION_CONFLICT`、`BRANCH_STORAGE_CORRUPT`、`INTERNAL_ERROR`。

### 2. TREE-11：完整分支树查看面板（`components/message/BranchTreePanel.vue` 新增）

- **数据源**：`chatStore.branchGraph`（TREE-10 已接线的 `conversation.getBranchGraph`，无新 API）。
- **树形组装（本地，不依赖后端新 API）**——在 `branchActions.ts` 新增两个纯函数（镜像后端 BranchGraph.ts）：
  - `buildChildrenIndex(graph)`：`Map<parentId, 子节点列表>`，按 createdAt 升序（同毫秒按 id 字典序），
    软删节点包含在内（由展示方灰显）——镜像后端 `childrenIndex`；
  - `buildActivePathIds(graph)`：从 root 沿 `activeChildId` 走到 `activeTailNodeId` 的节点 ID 链——
    镜像后端 `activePath`；前端只读展示，环 / 链上缺失保守截断不抛错（后端下发前已语义校验，此处仅防御）。
  - 面板把 `childrenIndex` 从 root 做 DFS 展平成「带深度行」渲染（缩进 = depth × 16px）。
- **展示**：根节点 → 各候选分支；每行 = 角色图标 + 摘要（label > parts 文本截断 60 字符 > 「（无预览）」）
  + 时间（createdAt，MM-DD HH:mm）+ 状态徽标（活跃路径「当前」高亮 / 软删「已删除」灰显 opacity 0.55）；
  hover title 展示 modelVersion · kind · role。
- **交互**（复用 chatStore 既有/新增动作）：
  - 点击行主区 = `switchBranchCandidate`（活跃路径节点 / 软删节点不响应）；
  - 删除（软删）= `deleteBranchCandidate`，**两步确认**（第一次进入确认态，再次点击才删除，风格与 BranchSwitcherBar 一致）；
  - 恢复 = `restoreBranchCandidate`（新增动作，软删节点显示恢复按钮，单击即恢复）；
  - 重命名 = `renameBranchCandidate`（新增动作，行内输入框，Enter 保存 / Esc 取消；活跃节点也可重命名——只改 label 不影响路径）。
  - `isSwitchingBranch` 期间全部动作按钮禁用 + 面板头忙碌图标（store 侧同时拒绝并发操作，双保险）。
- **入口与浮层**（交互选择说明）：入口按钮常驻**消息区顶部**（与 BranchSwitcherBar 同排，独立组件自含触发按钮），
  **有分支图即显示**——不受 BranchSwitcherBar「≥2 候选才显示」限制，单候选 / 深层分支同样可查看整棵树；
  面板为**独立浮层**（`position: fixed` + 透明背板，点击背板 / X 关闭，避免被消息滚动容器裁剪；
  已确认 MessageList 祖先链无 transform/filter/perspective 阻断 fixed）。
  选此方案而非把按钮塞进 BranchSwitcherBar 的原因：BranchSwitcherBar 在 <2 候选时整体隐藏，
  入口会随之消失；独立入口覆盖更全且不动已稳定的 TREE-10 组件及其 11 个测试。
- **挂载点（最小插入，已说明）**：`MessageList.vue` 仅 2 行（import + `<BranchTreePanel />` 挂在
  `<BranchSwitcherBar />` 之后）；MessageList 自身逻辑零改动（FIX-G4/P5d 稳定面不受影响）。

### 3. TREE-12：标签页快照保存分支图（`stores/chat/tabActions.ts` 最小扩展）

- **现状确认**：`switchTabWrapped` → `tabActions.switchTab` **不重载分支图**——切标签页后
  `state.branchGraph` 会残留上一对话的图，分支 UI 显示错乱（这正是 TREE-12 要修的问题）。
- **快照扩展**（保持 FIX-G4 清理语义：closeTab 仍先删快照再移除标签页，孤儿快照防护不变）：
  - `ConversationSessionSnapshot` 新增 `branchGraph: BranchGraphData | null`（types.ts 最小改动，TREE-12 必要类型）；
  - `snapshotCurrentSession` 保存 `state.branchGraph.value`（图按整体替换维护、无原地修改，共享引用安全，
    与 checkpoints / activeBuild 的快照语义一致）；
  - `restoreSessionFromSnapshot` 恢复 `state.branchGraph.value = snapshot.branchGraph ?? null`
    （旧快照无此字段回退 null，兼容模式与 toolResponseCache 一致）；
  - `resetConversationState` 补 `state.branchGraph.value = null`（新空白标签页不再残留上一对话的图）。
- 未保存 `isSwitchingBranch` / `branchGraphLoading`（瞬时状态，恢复后由 loadBranchGraph 自然重建）。

### 4. 文案（MIG-06，三语同步）

`components.message.branchTree.*` 新增 10 个 key（open/close/title/empty/deleted/restore/rename/
renamePlaceholder/save/cancel），复用既有 `components.message.branch.*`（active/switchTo/delete/
deleteConfirm/noPreview）；无占位符，三语 key 集合与占位符一致（languageParity 校验）。

### 5. 文件边界与未做项

改动全部落在允许清单内；`BranchSwitcherBar.vue` **未修改**（入口改走消息区独立组件，理由见 §2）；
`CheckpointSettings.vue` / `BranchCleanupSettings.vue` / `messageActions` / `MessageItem` 未触碰；
`backend/`、`webview/` 只读；CHANGELOG.md / 规划文档未修改。
未做：面板内「从候选继续对话」（TREE-05 前端接线）、reroll 入口（TREE-01 前端接线）——留待后续批次。

---

## 二、修改摘要

| 文件 | 变更 |
|---|---|
| `frontend/src/stores/chat/types.ts` | `ConversationSessionSnapshot` 新增 `branchGraph: BranchGraphData \| null`（TREE-12 快照字段） |
| `frontend/src/stores/chat/branchActions.ts` | 新增常量 `BRANCH_RESTORE_ERROR_CODE` / `BRANCH_RENAME_ERROR_CODE`；纯函数 `buildActivePathIds`（镜像后端 activePath）/ `buildChildrenIndex`（镜像后端 childrenIndex）；动作 `restoreBranchCandidate` / `renameBranchCandidate`（防护：无会话/非法参数/流式 BRANCH_BUSY/isSwitchingBranch 并发拒绝；成功仅刷分支图；失败透出错误码） |
| `frontend/src/stores/chat/tabActions.ts` | `snapshotCurrentSession` 保存 branchGraph；`restoreSessionFromSnapshot` 恢复 branchGraph（旧快照回退 null）；`resetConversationState` 清空 branchGraph |
| `frontend/src/stores/chatStore.ts` | 暴露 `restoreBranchCandidate` / `renameBranchCandidate`（import + 包装 + 返回对象 3 处最小改） |
| `frontend/src/components/message/BranchTreePanel.vue`（新增） | TREE-11 完整分支树面板：入口按钮 + fixed 独立浮层；DFS 树形渲染（缩进/图标/摘要/时间/徽标）；切换 / 两步删除 / 恢复 / 行内重命名；忙碌态禁用 |
| `frontend/src/components/message/MessageList.vue` | 2 行最小插入：import + `<BranchTreePanel />` 挂载点 |
| `frontend/src/i18n/langs/zh-CN.ts` / `en.ts` / `ja.ts` | `components.message.branchTree.*` 10 key 三语同步（无占位符） |
| `frontend/src/stores/chat/__tests__/branchActions.test.ts` | 新增 13 用例：buildActivePathIds（空/链/中途截止/环与缺失防御）、buildChildrenIndex（分组/排序/软删/空图）、restore（成功/失败/BRANCH_BUSY）、rename（成功 label 规范化/BRANCH_BUSY/参数短路） |
| `frontend/src/stores/chat/__tests__/tabActions.test.ts` | 新增 4 用例：快照保存 branchGraph、切标签页保存并恢复、旧快照回退 null、resetConversationState 清空 |
| `frontend/src/components/message/__tests__/BranchTreePanel.test.ts`（新增） | 12 用例：入口显隐、打开/背板关闭、DFS 顺序 + 缩进、活跃高亮/软删灰显、切换（活跃/软删不响应）、两步删除、恢复、重命名（Enter/Esc）、忙碌态禁用 |
| `frontend/src/__tests__/stores/chatRaceCondition.test.ts` | 快照字面量补 `branchGraph: null`（类型必需，1 行） |

---

## 三、验证结果

- `npm --prefix frontend test`：**22 个测试文件全部通过，266/266 用例通过**
  （含新增 BranchTreePanel 12 例、branchActions +13 例、tabActions +4 例；既有全部测试保持通过）。
- `npm --prefix frontend run typecheck`（vue-tsc --noEmit）：**通过，0 错误**。
- `npm run typecheck`（根 tsc --noEmit，后端未改）：**通过**。
- 后端 i18n 一致性：`npx jest --config jest.backend.config.js backend/__tests__/i18n/languageParity.test.ts`
  **4/4 通过**（前端三语 key 集合与占位符一致）。
- 未运行后端全量 Jest（本批后端零改动，仅以 typecheck + i18n parity 验证受影响面）。

## 四、后续接线提示（非本批范围）

1. TREE-01 前端接线批次可复用面板的「行主区点击 = switchBranchCandidate」模式，为候选行补
   reroll / 「从候选继续对话」入口（后端 createRerollCandidate / TREE-05 已就绪）。
2. 流式完成（handleComplete）后刷新分支图不在本批文件边界（streamHandler.ts），后续批次可接线，
   保证新消息产生新分支后面板/切换器位置同步。
3. 面板浮层尺寸（width min(460px, 80vw) / max-height min(70vh, 560px)）可随 webview 宽度自适应
   微调；如需面板内搜索/过滤可后续追加（当前节点量级下不必要）。
