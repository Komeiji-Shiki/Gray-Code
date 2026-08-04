# BCP-03/04/05：分支切换与工作区存档联动 + 恢复安全闸

> 批次：第七阶段 BCP-03/04/05（P6b-2，切换 + 工作区联动闭环）
> 日期：2026-08-04
> 规划依据：`checkpoint-history-branch-architecture.plan.md` 第七阶段（L119–121）+ 已确认决策 1（L2023）/ 决策 11（L2033）
> 研究依据：`.graycode/research/bcp-phase-research.md`（2.3 切换编排顺序 / 3.2 BCP-04 判据 / 4 BCP-05 安全闸）、
> `.graycode/research/tree04-06-switch.md`（切换编排现状：切图 → 主历史重写 → 检查点清理）、
> `.graycode/research/fix-r8a-switch-idempotency.md`（切换前尾部一致性检测）
> 前置已完成：TREE-06 切换全链（switchBranchCandidate 切图 + rewriteHistoryFromBranchGraph + 锁外检查点清理）、
> BCP-01 messageNodeId、BCP-02 绑定层（并发批次实施中，**本批次 BranchService/ToolExecutionService 只读**）

---

## 一、设计说明

### 1. 目标与边界

- **BCP-05（决策 11）**：普通 `checkpoint.restore` 与分支切换恢复均拦截未保存（dirty）的编辑器内容——恢复前检测 `vscode.workspace.textDocuments` 中 `isDirty && 在工作区 roots 内` 的文件，命中时不再静默丢弃（`WorkspaceEditorRefresher` 的静默覆盖行为是既有隐患），由前端确认后继续。
- **BCP-03**：`switchBranchCandidate` 扩展 `mode: 'chat-only' | 'chat-and-workspace'`（缺省 chat-only，决策 1）。chat-and-workspace 编排顺序（研究 2.3）：安全校验 → dirty 检测 → 取消流+SubAgent → previewRestore → 恢复（**失败不切分支**）→ 切图 + 主历史重写 + 锁外检查点清理 → 响应 `{ rewritten, workspaceRestored, restoredSummary }`。
- **BCP-04（决策 1）**：`getBranchGraph` / `switchBranchCandidate` 响应对每节点富化 `hasWorkspaceState`（`workspaceCheckpointId` 存在）与 `wroteToWorkspace`（root→节点路径 parts 工具名 ∩ 写工具集非空）；前端 `branchActions.switchBranchCandidate` 缺省 chat-only，判据命中（取或）时弹「仅切聊天 / 切换并恢复工作区」确认框。

### 2. 关键设计决策

1. **锁序（M-3 强约束）**：chat-and-workspace 的 `restoreCheckpoint`（工作区/存档锁）在切图（会话写锁）**之前**完成——恢复阶段无会话锁，切图阶段无存档锁，锁不嵌套；`deleteCheckpointsFromIndex`（存档锁）仍只在会话写锁释放后执行。全局顺序「工作区锁 → 会话锁（图+历史）→ 存档锁（检查点）」无反转。
2. **失败原子性（「不静默切换」硬约束）**：安全校验（目标无 `workspaceCheckpointId` → `WORKSPACE_STATE_UNAVAILABLE`）、dirty 拦截、previewRestore 失败（`WORKSPACE_CHECKPOINT_BROKEN`）、恢复失败（`WORKSPACE_STATE_UNAVAILABLE`）任一命中 → 分支图与工作区都保持原状（不执行 `service.switchBranchCandidate`）。
3. **dirty 拦截零副作用**：检测放在「取消流 + SubAgent」之前——用户取消确认时流保持原状，不取消、不恢复、不切分支。
4. **恢复可安全省略**：`previewRestore` 显示 `restored === 0 && deletedIfUnconfirmed === 0`（目标存档与当前工作区一致/无变化）时跳过实际 `restoreCheckpoint`，仍返回 `workspaceRestored: true` + 空摘要；legacy 存档（`restored === -1`）不命中省略条件，正常恢复。
5. **分支切换恢复不删未跟踪文件**：`restoreCheckpoint(..., { deleteUntrackedFiles: false })`（#29 保护：切换恢复语义为「恢复到该分支头存档」，不删除快照后新建文件）。
6. **BCP-04 判据口径**：`WRITE_TOOL_NAMES = DEFAULT_CHECKPOINT_CONFIG.beforeTools ∪ afterTools`（与 ToolExecutionService 存档判据同源；运行时配置覆盖场景留待后续，handler 读配置成本高且本判据只用于提示）。工具名提取与 `BranchService.buildCandidateSummary`（L217–231）同口径；因 BranchService 只读，提取实现为 handler 层本地纯函数，**抽公共 `collectToolNamesFromParts` 入 branch/BranchGraph 留待 BCP-02 批次完成后**（报告中注明）。
7. **前端确认框承载**：BCP-04 模式确认框直接内嵌 `BranchSwitcherBar.vue` / `BranchTreePanel.vue`（复用 `ConfirmDialog`：footer confirm=仅切换聊天，slot 次按钮=切换并恢复工作区，cancel=取消）。BCP-05 dirty 确认框由新组件 `DirtyFilesConfirm.vue` 承载，挂载在 `BranchSwitcherBar.vue`（消息区常驻组件，无分支图时组件仍渲染），由模块级 `pendingDirtyConfirm`（`stores/chat/dirtyConfirmState.ts`）驱动——checkpointActions（四个恢复入口）与 branchActions（切换）共用，避免 actions ↔ 组件循环导入。
8. **普通 restore 的 dirty 确认与既有流程衔接**：四个入口（restore / retry / delete / edit）都在 store 层检测 `dirtyFiles`——命中时登记待确认动作、**不写错误条**、流程暂停；确认后以 `confirmedDiscardDirty=true` 重放原入口。已知轻微副作用：纯 restore 入口（MessageList 的 `confirmRestore`）在后端返回 `success:false + dirtyFiles` 时会同时展示一条「恢复检查点失败」提示（MessageList 已稳定不可触碰，未改动其逻辑）；确认后真实结果提示覆盖之。**已接受并在本文档记录**，后续批次可在 MessageList 增加 dirtyFiles 分支消除。

### 3. 接口契约

**webview 侧（扩展主机）**

```
checkpoint.restore  入参 + { confirmedDiscardDirty?: boolean }
  未确认且存在 dirty → 响应 { success:false, restored:0, deleted:0, skipped:0, dirtyFiles: string[] }（不执行恢复）
  已确认 / 无 dirty → 既有逻辑（取消流+SubAgent → restoreCheckpoint → 刷新派生元数据）

conversation.switchBranchCandidate  入参 + { mode?: 'chat-only'|'chat-and-workspace', confirmedDiscardDirty?: boolean }
  chat-and-workspace：
    ① 目标节点 workspaceCheckpointId 不存在 → 错误 WORKSPACE_STATE_UNAVAILABLE（不切）
    ② dirty 未确认 → 响应 { success:false, mode:'chat-and-workspace', dirtyFiles }（不切）
    ③ 取消流+SubAgent → ④ previewRestore（失败 → WORKSPACE_CHECKPOINT_BROKEN）
    ⑤ restoreCheckpoint（失败 → WORKSPACE_STATE_UNAVAILABLE，不切；可省略）
    ⑥ 既有切图 → 主历史重写 → 锁外检查点清理 → 响应追加 workspaceRestored / restoredSummary

conversation.getBranchGraph  响应图节点富化 hasWorkspaceState / wroteToWorkspace（内存对象，不落盘）
```

**前端**

```
branchActions.switchBranchCandidate(state, nodeId, options?: { mode, confirmedDiscardDirty })
  needsWorkspaceConfirm(node) = node.wroteToWorkspace === true || node.hasWorkspaceState === true（决策 1 取或）
  dirty 拦截（chat-and-workspace）→ pendingDirtyConfirm 登记，不写错误条
checkpointActions.restoreCheckpoint / restoreAndRetry / restoreAndDelete / restoreAndEdit
  + confirmedDiscardDirty?: boolean；dirty → pendingDirtyConfirm 登记（含入口参数），流程暂停
DirtyFilesConfirm.vue：确认 → 按 kind 分发续作（restore / retry / delete / edit / switch），取消 → 清空
```

---

## 二、修改摘要

| 文件 | 改动 |
|---|---|
| `webview/utils/WorkspaceRestoreGuard.ts` | **新建**：`detectDirtyFilesInWorkspace()`（遍历 textDocuments，`isDirty && file scheme && 在工作区 roots 内`，前缀匹配兼容 Windows）+ `cancelStreamAndSubAgents(ctx, conversationId)`（自 CheckpointHandlers L81–111 原样抽取，恢复/切换共用） |
| `webview/handlers/CheckpointHandlers.ts` | `restoreCheckpoint` 增加 dirty 闸门（`confirmedDiscardDirty` 入参；命中未确认 → 返回 `dirtyFiles`，零副作用）；取消流+SubAgent 改用公共函数；移除 subagent 相关直接导入 |
| `webview/handlers/BranchHandlers.ts` | ① `getBranchGraph` 响应富化 `hasWorkspaceState`/`wroteToWorkspace`（决策 1 判据，本地纯函数 `collectToolNamesFromParts`/`collectPathToolNames` + `WRITE_TOOL_NAMES`=默认 checkpoint 写工具并集）；② `switchBranchCandidate` 编排扩展：`mode` 参数 + chat-and-workspace 全流程（安全校验 → dirty 闸门 → 取消 → previewRestore → restore（失败不切分支，可省略）→ 既有切图/重写/清理）→ 响应追加 `workspaceRestored`/`restoredSummary`；③ 响应图同样富化 |
| `frontend/src/stores/chat/types.ts` | `BranchNodeData` 增加 `hasWorkspaceState?` / `wroteToWorkspace?` |
| `frontend/src/stores/chat/dirtyConfirmState.ts` | **新建**：模块级 `pendingDirtyConfirm`（kind: restore\|switch + 各入口参数），checkpointActions / branchActions / DirtyFilesConfirm 共用 |
| `frontend/src/stores/chat/checkpointActions.ts` | 四个恢复入口（restore/retry/delete/edit）增加 `confirmedDiscardDirty` 透传；后端返回 `dirtyFiles` 时登记待确认动作、不写错误条、流程暂停 |
| `frontend/src/stores/chat/branchActions.ts` | `switchBranchCandidate` 增加 `options { mode, confirmedDiscardDirty }`（缺省 chat-only，IPC 恒带 mode）；`needsWorkspaceConfirm` 导出（决策 1 判据）；chat-and-workspace dirty 响应登记待确认动作 |
| `frontend/src/stores/chat/chatStore.ts` | 最小接线：`switchBranchCandidate`/`restoreCheckpoint`/`restoreAndRetry`/`restoreAndDelete`/`restoreAndEdit` 透传新参数 |
| `frontend/src/components/message/DirtyFilesConfirm.vue` | **新建**：未保存文件确认框（ConfirmDialog + 文件路径列表，确认→按 kind 续作，取消→清空） |
| `frontend/src/components/message/BranchSwitcherBar.vue` | 切换入口 BCP-04 模式确认框（ConfirmDialog：confirm=仅切聊天 / slot 次按钮=切换并恢复工作区 / cancel=取消）；常驻挂载 `DirtyFilesConfirm` |
| `frontend/src/components/message/BranchTreePanel.vue` | 切换入口同样接入 BCP-04 模式确认框 |
| `frontend/src/i18n/langs/zh-CN.ts` / `en.ts` / `ja.ts` | 新增三语文案：`components.message.branch.workspaceConfirm*`（标题/文案/仅切聊天/切换并恢复工作区/取消）+ `components.message.checkpoint.dirtyConfirm*`（标题/文案(count)/丢弃并继续/取消/更多(count)） |
| `backend/__tests__/webview/branchHandlers.test.ts` | 新增 BCP-03/04/05 描述块 10 项（富化 / 缺省 chat-only / 安全闸 / dirty 拦截 / chat-only 不受 dirty 影响 / 成功路径锁序 / 恢复失败不切分支 / preview 链断裂 / 可省略恢复 / confirmedDiscardDirty） |
| `frontend/src/stores/chat/__tests__/branchActions.test.ts` | 既有成功断言更新（IPC 带 mode）；新增 5 项（needsWorkspaceConfirm / chat-and-workspace payload / dirty 拦截登记 / chat-only 不登记 / confirmedDiscardDirty 透传）；fixture `createState` 补 `_failedStreamMessageId`（既有缺口） |
| `frontend/src/stores/chat/__tests__/checkpointActions.test.ts` | 新增 6 项（restore 入口 dirty / confirmed 透传 / retry / delete / edit 登记 / confirmed 后继续流程） |
| `frontend/src/components/message/__tests__/BranchSwitcherBar.test.ts` | 新增 4 项（写工具候选弹确认框 / 切换并恢复工作区 / 仅切聊天 / 无判据直接切换） |

**未触碰（只读）**：`BranchService.ts` / `ToolExecutionService.ts`（BCP-02 并发批次）、`ConversationManager.ts`、checkpoint 核心（`CheckpointManager`/`CheckpointService` 只读复用 `previewRestore`/`restoreCheckpoint`）、`messageActions.ts` / `MessageList.vue`、CHANGELOG、规划文档。

**边界说明（任务边界外的最小必要扩展，已在报告注明）**：
- `checkpointActions.ts` / `chatStore.ts` / `stores/chat/types.ts` 不在任务文件清单内，但「前端四个恢复入口流程」的 dirty 确认与 mode 透传必须经此接线，均为增量式小改（新增参数/登记/透传），未改动既有逻辑。
- `MessageList.vue` 未改（其「恢复检查点失败」提示在纯 restore dirty 拦截时与确认框并存，见设计说明 2.8）。

---

## 三、验证结果

命令：
```
npx jest --config jest.backend.config.js backend/__tests__/webview/branchHandlers.test.ts
npx jest --config jest.backend.config.js                       # 全量后端
npm --prefix frontend test -- --run                             # 全量前端
npm run typecheck                                               # 后端 + webview tsc
npm --prefix frontend run typecheck                             # 前端 vue-tsc
```

- **后端全量：142 套件 / 1574 用例全部通过**（含新增 branchHandlers BCP 10 项；`branchSwitch`/`branchService`/`branchReroll`/`branchRace`/`branchGraph`/`branchRepository`/`ConversationManager.branch` 等既有分支套件全部保持通过——本批次 handler 扩展对缺省 chat-only 路径零行为变化）。
- **前端全量：22 套件 / 282 用例全部通过**（branchActions 37、checkpointActions 34、BranchSwitcherBar 15 含新增 4 项、BranchTreePanel 12 等）。
- **i18n 一致性：`languageParity.test.ts` 4/4 通过**（backend + frontend 三语 key 集合与占位符一致）。
- **双 typecheck 0 错误**（`tsc -p ./ --noEmit` + `vue-tsc --noEmit`）。

新增测试明细：

**branchHandlers.test.ts（BCP-03/04/05，10 项）**
1. getBranchGraph 富化：写工具节点 `wroteToWorkspace=true`、绑定存档节点 `hasWorkspaceState=true`、共享前缀不误判、只读工具不命中
2. 缺省 mode（chat-only）：不触发恢复（restoreSpy 不被调用）且切换成功、响应无 workspace 字段
3. 目标无 `workspaceCheckpointId` → `WORKSPACE_STATE_UNAVAILABLE`，不恢复不切分支
4. dirty 拦截：工作区内未保存文件 → 返回 `dirtyFiles`，不恢复不切分支（活跃尾不变）
5. chat-only 模式不受 dirty 影响（不检测）
6. chat-and-workspace 成功路径：preview → restore（`deleteUntrackedFiles:false`）→ 切图/重写/清理，锁序正确（恢复先于切图），响应 `workspaceRestored:true` + `restoredSummary`
7. 恢复失败（`restoreCheckpoint success:false`）→ `WORKSPACE_STATE_UNAVAILABLE`，不切分支、检查点不清理
8. preview 链断裂（`missing_in_chain`）→ `WORKSPACE_CHECKPOINT_BROKEN`，不切分支
9. 预览无文件变更 → 跳过实际恢复，仍返回 `workspaceRestored:true`
10. `confirmedDiscardDirty:true` 跳过 dirty 拦截并完成恢复+切换；目标节点不存在 → `NODE_NOT_FOUND`

**branchActions.test.ts（5 项）**：判据 helper / mode 透传 / dirty 拦截登记（不写错误条、不发后续 IPC）/ chat-only 不登记 / confirmedDiscardDirty 透传

**checkpointActions.test.ts（6 项）**：restore 入口 dirty 登记（含 entry=restore）/ confirmed 透传 / retry / delete / edit 入口登记（含 messageId/newContent，不写错误、不继续流程）/ confirmed 后继续（deleteMessage + retryStream）

**BranchSwitcherBar.test.ts（4 项）**：写工具候选弹确认框 / 「切换并恢复工作区」→ `(nodeId, { mode: 'chat-and-workspace' })` / 「仅切聊天」→ `(nodeId, { mode: 'chat-only' })` / 无判据直接切换

**并发批次说明**：BCP-02 绑定层在另一批次实施中（BranchService 已含 `bindWorkspaceCheckpoint` 与 BCP-06 清理接线，本批次只读 `workspaceCheckpointId` 字段）；全量后端 1574 用例全绿，无并发批次相关红测。唯一的 `worker process has failed to exit gracefully` 提示为既有 teardown 告警（非本批次引入，全部用例通过）。

---

## 四、遗留与后续（不属于本批次）

- **抽公共纯函数**：`collectToolNamesFromParts`（本批次在 BranchHandlers 本地实现）待 BCP-02 批次完成后并入 `branch/BranchGraph.ts` 共享（BranchService.buildCandidateSummary 同口径）。
- **运行时写工具配置**：`WRITE_TOOL_NAMES` 目前取 `DEFAULT_CHECKPOINT_CONFIG`；如需跟随运行时 checkpoint 配置（`beforeTools/afterTools` 覆盖），后续可在 handler 读取配置后重算（判据只用于提示，口径漂移影响有限）。
- **纯 restore 入口的提示并置**：MessageList（已稳定）在 dirty 拦截时仍展示「恢复检查点失败」提示，与确认框并存；后续可在 MessageList 增加 `dirtyFiles` 分支消除（设计说明 2.8）。
- **切换恢复的 preview 展示**：chat-and-workspace 的 previewRestore 目前为服务端安全校验（不弹预览确认框，`deleteUntrackedFiles=false` 保证不删未跟踪文件）；如需「先展示待删文件再确认」可后续接入 TREE-10 弹窗。
- **BCP-06**：分支物理清理按引用计数联动存档（依赖 TREE-09/BCP-02，后续批次）。
