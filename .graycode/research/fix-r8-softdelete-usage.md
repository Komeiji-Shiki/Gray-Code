# FIX-R8：软删数据丢失高危 + 用量双计/低估 复查问题修复

- 日期：2026-08-04
- 范围：`backend/modules/conversation/branch/`（BranchGraph.ts / BranchService.ts / BranchGraphRepository.ts / types.ts）、`backend/modules/conversation/usageStats.ts`、`backend/modules/conversation/UsageIndexStore.ts`、前端设置页（useBranchCleanup.ts / BranchCleanupSettings.vue / i18n 三语）、对应测试
- 依据：R8c（TREE-09 软删复查，1 高危 + 3 中危 + 若干低危）+ R8b（TREE-08 用量复查，2 中危）问题清单（批次 R8-FIX）。
- 未触碰：CHANGELOG.md、规划文档、ConversationManager/Chat 链路、checkpoint 核心、webview/handlers/BranchHandlers.ts（错误码复用 branch/types.ts 既有 `BRANCH_OPERATION_CONFLICT`）。

---

## 一、修改摘要

### 【高 P1】softDeleteNode 级联软删整棵子树 + restoreNode 对称级联恢复（BranchGraph.ts）
- **问题**：`softDeleteNode` 只标记分支头；候选 C 曾被激活续聊（C 下有 live 子孙 C1a），切走后软删 C 通过，C1a 仍是 live；`pruneDeletedNodes`/`removeNodeSet` 以 C 过期为由把整棵子树（含从未软删的 C1a 及其内容）**物理移除——静默数据丢失**。既有测试全「先手动软删子树节点再 prune」，掩盖了该路径。
- **修复（方案 a，最符合用户预期）**：
  - `softDeleteNode`：沿 children 递归收集整棵子树，全部标记 `deleted + deletedAt`（子孙中已软删的保留首次 deletedAt，幂等语义）；子树内指向（已删）子节点的 `activeChildId` 一并清空（validate 的「activeChildId 不得指向已删除节点」不变量）；分支头是父节点当前活跃子时清空父节点指针（既有逻辑保留）；子树内候选摘要同步软删。
  - `restoreNode`：对称级联恢复——子树内所有节点的 `deleted / deletedAt` 与摘要标记一并清除（整体恢复，不自动重新激活）。
  - `pruneDeletedNodes`：逻辑不变（过期分支头 → 整棵子树物理清理），文档注释修正为「softDeleteNode 已级联软删整棵子树，物理清理不丢失任何‘从未软删’的内容；prune 前任意时刻子树可通过 restoreNode 整体恢复」。
  - `collectDeletedNodes` / `deletedCount`：级联后天然含整棵子树（无需单独修改实现，更新注释）。
- **测试**：branchGraph.test.ts 新增级联软删（子孙同步标记 + 子树内指针清空 + validate 通过）、级联保留首次 deletedAt、restore 级联恢复（子树完整 + collectDeletedNodes 归零）、prune 级联后整棵物理清理；既有 collectDeletedNodes/prune 测试改为「只软删分支头」不再逐个手动软删子孙（消除掩盖）；branchService.test.ts 新增端到端：激活续聊 → 切走 → 软删分支头 → 子孙内容不丢失（软删期可整体恢复）→ restore 级联恢复子树完整 → 再软删拨过期 → prune 物理清理整棵子树。

### 【中 P2】switchActivePath / switchBranchCandidate 校验 parentId 链上无软删节点
- **问题**：`switchActivePath` 只查 `target.deleted`；软删节点存在 live 子孙时切换到该子孙，切换会把软删祖先重新指为活跃路径节点 → `validate` 报「activeChildId points to deleted node」→ `validateAndSave` 抛 `BRANCH_STORAGE_CORRUPT` 拒绝落盘——节点成为「显示可用但不可用」的死状态。
- **修复**：`switchActivePath` 收集 root → target 的 parentId 链后，链上任一节点（含目标自身）`deleted` → 抛 `BRANCH_OPERATION_CONFLICT`（业务冲突语义，非损坏；消息提示「restore it first」）。校验放在结构校验（环/缺失/可达性）之后，报错优先级为 损坏 → 冲突。`switchBranchCandidate` 经 `switchActivePath` 自动受益，无需改服务层。级联软删落地后此场景主要出现在「父被软删但子仍 live」的旧数据，校验保留。
- **测试**：branchGraph.test.ts 更新「目标已删除」为 `BRANCH_OPERATION_CONFLICT`，新增「祖先软删 + 目标 live 子孙 → 冲突」；branchService.test.ts 新增遗留数据场景（手工标记祖先软删）→ `switchBranchCandidate` 抛 `BRANCH_OPERATION_CONFLICT` 且不落盘。

### 【中 P4】getDeletedBranchCount 与 prune 同口径（metadata 过滤）+ 设置页 skipped 提示
- **问题**：`getDeletedBranchCount` 不检查会话 metadata，孤儿 sidecar 照常计数；`pruneDeletedBranches` 对 `getMetadata === null` 跳过并计入 `skippedConversations`——设置页数量清理后不归零。
- **修复**：
  - `BranchService.getDeletedBranchCount`：逐会话先查 `conversationManager.getMetadata`，为 null（孤儿 sidecar）跳过，不计数也不计入 `conversationCount`（与 prune 的 skipped 同口径）。
  - 前端：`useBranchCleanup.ts` 新增 `pruneSkippedCount` ref（取 `result.skippedConversations.length`）；`BranchCleanupSettings.vue` 清理成功后 `pruneSkippedCount > 0` 显示提示文案；i18n 三语（zh-CN/en/ja）新增 `branchCleanup.pruneSkipped`。
- **测试**：branchService.test.ts 新增孤儿 sidecar 不计入（全量 + 单会话）；BranchCleanupSettings.test.ts 新增 skipped 提示渲染。

### 【中 R8b-M1】mergeBranchUsageIntoLoaded 去重键「全有或全无」修正（usageStats.ts）
- **问题**：`historyIds` 非空但**部分**主历史消息缺 id（旧索引/迁移失败）时，缺失 id 的主历史消息对应图节点不被去重 → 双计且无日志。
- **修复**：构建 `historyIds` 时同步计算 `historyIdsComplete`（索引/历史中所有 main（model）条目都带 id 才视为完整；subagent/branch 条目不参与）；不完整时 `console.warn` 并视同「无 id」置空 `historyIds` → `extractBranchUsageMessages` 走活跃路径兜底（不变量：主历史 = 活跃路径，活跃节点已由主历史统计）。选实现简单的方案（回退兜底，不强制重建索引）。
- **测试**：usageStats.test.ts 新增混合态索引（m1 带 id、m2 缺 id，图活跃路径=主历史）→ 无双计（totals.promptTokens = 160 而非 220）。

### 【中 R8b-M2】分支候选节点携带 usageMetadataPartial（低估修复）
- **问题**：`ConversationBranchNode` 无 `usageMetadataPartial` 字段，三处节点创建点（BranchService.finishReroll 首条消息 updateNodeContent + 续接节点、appendHistoryToGraph、BranchGraph.importLinearHistory）只拷贝 `usageMetadata` → 中断 reroll 候选按截断原值计入（低估）。
- **修复**：`types.ts` `ConversationBranchNode` 新增可选 `usageMetadataPartial?: boolean`；三处创建点随 `usageMetadata` 一起拷贝（`updateNodeContent` patch 同步支持该字段）；`extractBranchUsageMessages` 自动受益（`extractMessageTokens(node as Content)` 看到标记即走 `estimatePartialMessageTokens` 文本估算）。
- **测试**：usageStats.test.ts 新增中断候选（usageMetadataPartial + 截断 usageMetadata + 100 字符文本）→ candidates 按估算（40）而非截断值（2），prompt 保留截断值。

### 【低 R8b-L1】id 权威时跳过 activePath 解析（收窄损坏图影响面）
- `extractBranchUsageMessages`：仅当 `historyIds` 为空（需要兜底）时才解析 `activePath`；id 权威时跳过，损坏图（悬空 activeChildId/环）不再放弃整个合并（非活跃候选仍计入）。
- 测试：新增 activeChildId 环图 + 非空 historyIds → 分支合并正常；无 id 时行为不变（返回 []）。

### 【低 R8b-L3】UsageIndexStore.readBranchGraph 与 BranchGraphRepository 共享 shape 校验
- `isBranchGraphShape` 提升至 `branch/types.ts` 共享实现（conversation 域 → branch 域依赖方向合理，两处均已有 branch/types 依赖）；`BranchGraphRepository.load` 与 `UsageIndexStore.readBranchGraph` 复用，删除仓储层重复实现。
- 测试：UsageIndexStore.test.ts 新增非整数版本 / 缺失字段 → null（共享实现行为）。

### 【低 R8c-P5】BranchService 构造选项 retentionDays 不再是死代码
- `BranchGraphRepository.loadBranchRetentionConfig` 返回 `{ retentionDays?: number }`：缺失/损坏/非法 → `{}`（undefined），上层 `?? this.retentionDays` 回退构造默认值——构造选项恢复生效。
- 测试：branchRepository.test.ts 更新为缺失/损坏返回 `{}`；branchService.test.ts 既有「默认 30」用例自然覆盖回退链。

### 【低 R8c-P6】deleteBranchCandidate 幂等路径不落盘
- `mutateGraph`：mutator 原样返回读到的图（`next === graph`）时跳过 `validateAndSave`（图未变化不重写 sidecar）；`deleteBranchCandidate` 已删节点重复删除、`restoreBranchCandidate` 未删节点恢复、`purgeBranchCandidate` 节点不存在均受益。
- 测试：branchService.test.ts 新增 spy `repo.save` 断言重复删除不调用 save。

### 【低 R8c-P7】purgeBranchCandidate 节点不存在 → 幂等 purged:false
- 实现与注释统一：节点缺失（已被 prune 清理等）返回 `{ nodeId, purged: false, prunedNodeCount: 0 }`，不再抛 `NODE_NOT_FOUND`；配合 P6 不落盘。
- 测试：branchService.test.ts 更新 ghost 断言为 `{ purged: false, prunedNodeCount: 0 }`。

---

## 二、文件变更清单

| 文件 | 变更 |
|---|---|
| `backend/modules/conversation/branch/types.ts` | `ConversationBranchNode.usageMetadataPartial?`；`isBranchGraphShape` 共享实现（从仓储层提升） |
| `backend/modules/conversation/branch/BranchGraph.ts` | P1 级联软删/级联恢复；P2 switchActivePath 链上软删校验；R8b-M2 importLinearHistory/updateNodeContent 拷贝 usageMetadataPartial；collectDeletedNodes/pruneDeletedNodes 注释 |
| `backend/modules/conversation/branch/BranchService.ts` | P4 getDeletedBranchCount metadata 过滤；R8b-M2 finishReroll/appendHistoryToGraph 拷贝 usageMetadataPartial；P6 mutateGraph 幂等不落盘；P7 purge 幂等；R8c-P5 适配可选 retentionDays |
| `backend/modules/conversation/branch/BranchGraphRepository.ts` | R8c-P5 loadBranchRetentionConfig 返回可选；R8b-L3 复用共享 isBranchGraphShape（删除本地实现） |
| `backend/modules/conversation/usageStats.ts` | R8b-M1 historyIdsComplete；R8b-L1 activePath 惰性解析 |
| `backend/modules/conversation/UsageIndexStore.ts` | R8b-L3 readBranchGraph 复用共享 shape 校验 |
| `frontend/src/composables/useBranchCleanup.ts` | P4 pruneSkippedCount |
| `frontend/src/components/settings/BranchCleanupSettings.vue` | P4 skipped 提示文案 |
| `frontend/src/i18n/langs/{zh-CN,en,ja}.ts` | P4 `branchCleanup.pruneSkipped` 三语 |
| `backend/__tests__/conversation/branchGraph.test.ts` | P1 级联 ×4、P2 ×2、既有用例去掩盖化 |
| `backend/__tests__/conversation/branchService.test.ts` | P1 端到端、P2 遗留数据、P4 孤儿计数、P6 不落盘、P7 幂等 |
| `backend/__tests__/conversation/branchRepository.test.ts` | R8c-P5 缺失/损坏返回 `{}` |
| `backend/__tests__/conversation/usageStats.test.ts` | R8b-M1 混合索引无双计、R8b-L1 环图合并、R8b-M2 中断候选估算 |
| `backend/__tests__/conversation/UsageIndexStore.test.ts` | R8b-L3 共享 shape 校验边界 |
| `frontend/src/components/settings/__tests__/BranchCleanupSettings.test.ts` | P4 skipped 提示 |

---

## 三、验证结果

命令（与要求一致）：
```
npx jest --config jest.backend.config.js backend/__tests__/conversation/branchGraph.test.ts \
  backend/__tests__/conversation/branchService.test.ts \
  backend/__tests__/conversation/usageStats.test.ts \
  backend/__tests__/conversation/UsageIndexStore.test.ts
npm --prefix frontend test
npm run typecheck        # 后端 tsc -p ./ --noEmit
npm --prefix frontend run typecheck   # 前端 vue-tsc --noEmit
```

- 必测 4 套件：**Test Suites: 4 passed, 4 total；Tests: 178 passed, 178 total**
- 扩展回归（branchRace / branchSwitch / branchReroll / branchMigration / nodeIdMigration / branchRepository / webview branchHandlers）：**11 套件 302 passed, 302 total**
- 前端：**22 个测试文件 267 passed, 267 total**（含 BranchCleanupSettings 与三语 languageParity）
- 双 typecheck：**通过，0 错误**

运行日志中的 `console.warn` 为预期输出：
- `mergeBranchUsageIntoLoaded(...): main-history usage entries have missing stable ids; falling back to active-path dedup`（R8b-M1 混合态索引回退提示，出现在旧索引/混合索引测试）；
- `branch_graph_meta_semantic_corrupt` / `branch_export_skipped_empty_source` 等既有日志。

---

## 四、遗留/后续说明

- P2 校验后，遗留「父被软删但子 live」的旧数据无法直接切换（业务冲突，需先 restore 祖先），读取侧 validate 不判损坏——该场景被引导为可恢复操作而非死状态。
- R8b-M1 选「回退活跃路径兜底」而非强制索引重建（实现简单、无双计）；若产品希望自愈，可在后续批次把混合态索引直接判 stale 触发重建。
- `getDeletedBranchCount` 逐会话 `getMetadata` 为只读路径（设置页低频调用），未加锁；与 prune 的锁内判定口径一致（getMetadata === null）。
- 未触碰 webview/handlers/BranchHandlers.ts：`purgeBranchCandidate` 幂等返回（purged:false）与既有透传结构兼容，前端无需改动。
