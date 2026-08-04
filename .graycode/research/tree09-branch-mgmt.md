# TREE-09 + MIG-06：分支删除 / 重命名 / 修剪（软删 + 保留期 + 设置页清理入口）

- 日期：2026-08-04
- 范围：`backend/modules/conversation/branch/`（BranchService / BranchGraph / BranchGraphRepository / types）
  + `webview/handlers/BranchHandlers.ts`（只追加）+ `frontend/src/components/settings/`（新区块 + composable）
  + `frontend/src/i18n/langs/`（zh-CN / en / ja 三语同步）
- 依据：`checkpoint-history-branch-architecture.plan.md` TREE-09（L108）+ 已确认决策 3（软删除、保留期 30 天可配置、
  清理入口放设置页新增区块）与决策 4（候选上限提示）；研究参考 `fix-g3-branch.md`（BranchService 现状）。
- 未触碰：CHANGELOG.md、规划文档、ConversationManager.ts、ChatFlowService/ChatHandlers/MessageRouter、
  usage/checkpoint 核心、工作区存档引用计数清理（BCP-06 后续批次）。

---

## 一、设计说明

### 1. 删除语义的取舍（读代码后的决定）

**现状确认**：TREE-09 之前的 `deleteBranchCandidate` 已实现为软删除（节点 `deleted: true` + 候选摘要同步 `deleted`，
活跃路径节点拒绝删除）。本批次**保留软删除作为唯一删除语义**，并补充 `deletedAt`；不把 delete 改回硬删。

- **软删除（主路径）**：`deleteBranchCandidate` → 节点 `deleted + deletedAt`，候选摘要同步；活跃路径节点拒绝
  （`BRANCH_OPERATION_CONFLICT`）；重复删除幂等（deletedAt 保持首次删除时间）。
- **恢复**：新增 `restoreBranchCandidate` → 清除 deleted / deletedAt（节点 + 摘要），不自动重新激活。
- **彻底删除（硬删入口）**：新增 `purgeBranchCandidate`（仅允许对已软删节点，物理移除节点 + 整棵子树，防误删）
  与 `pruneDeletedBranches`（批量物理清理过期软删）。即「恢复」与「彻底删除」两条路径都由显式操作承担，
  软删是它们的前置状态。

### 2. 软删后的图语义

- **活跃路径**：软删节点不参与活跃路径（`activateChild` / `switchActivePath` / `rebuildActivePath` 既有 deleted 拒绝；
  `softDeleteNode` 纯函数新增活跃路径拒绝——避免删除活跃节点破坏 `activeTailNodeId` 终端不变量，与 Service 层一致）。
- **候选列表**：摘要条目保留但标记 `deleted + deletedAt`（供前端灰显「已删除」），`candidateCount` 与
  `getCandidateSummaries` 侧过滤已删；设置页展示软删总数（`getDeletedBranchCount` 全量扫描）。
- **validate 宽容**：validate 已天然宽容 deleted 节点（deleted 节点可存在于图、可被子节点/摘要引用）；
  唯一硬性约束「activeChildId 指向已删节点」仍报错——软删时若父节点（非活跃分支上）的 activeChildId 指向被删子节点
  会同步清空指针，正常流程不会触发。**未改 validate**，仅补充说明。
- **子节点**：deleted 节点下不允许插入新子节点（insertNode 既有约束），因此软删节点的子树必然全部为软删节点，
  子树整体随 prune 一并清理是安全语义。

### 3. 保留期与 prune（修剪）

- **默认 30 天可配置**：`DEFAULT_BRANCH_RETENTION_DAYS = 30`（types.ts）；持久化配置
  `branches.config.json`（数据目录根下，`BranchGraphRepository.load/saveBranchRetentionConfig`，原子写）；
  0 = 不自动清理。优先级：prune 显式入参 > 持久化配置 > 构造默认值。
- **过期判定**：`isDeletedNodeExpired`（纯函数）——`now - deletedAt >= retentionDays * 86400000`；
  `deletedAt` 缺失（TREE-09 之前的遗留软删）以 `createdAt` 兜底，保证遗留节点最终可被清理；
  两者都缺失时保守不过期。
- **pruneDeletedBranches（Service）**：
  - 缺省全量扫描（`repository.listConversationIds`），可指定单会话；
  - 每个会话在会话写锁内（BR-07）：`assertConversationWritable` 跳过已删会话（orphan sidecar）、
    损坏/语义损坏 sidecar 跳过不覆盖（MIG-05 完整性工具负责修复）；
  - 过期节点连同整棵子树物理移除，同步清理候选摘要、`exportedFrom` / `exportedRefs` 引用、父节点 activeChildId
    （防御）、root/tail/镜像指针；
  - **图侧清理边界**：工作区存档的引用计数清理是 BCP-06，本批只做图侧（移除节点时其 workspaceCheckpointId
    绑定随节点消失，不触碰存档文件/索引）。
- **purgeBranchCandidate**：单候选「彻底删除」入口（先软删后彻底删），复用 `removeSubtree` 纯函数。

### 4. 重命名

`renameBranchCandidate(conversationId, nodeId, label)`：**只改 label，不动 contents**（parts/usageMetadata 等原样）。
label trim 后非空、≤200 字符（超限/空 → `INVALID_BRANCH_RELATION`）。节点 label 与候选摘要 label **同步维护**
（摘要条目是候选列表展示真源，节点 label 保持一致性，避免两张皮）。

### 5. 设置页清理入口（与存档清理并列的新区块）

- 新组件 `frontend/src/components/settings/BranchCleanupSettings.vue`（自包含、scoped 样式），
  挂载进 `CheckpointSettings.vue` 清理区块之后（`<BranchCleanupSettings />`）；
- 新 composable `frontend/src/composables/useBranchCleanup.ts`：
  - 软删分支数量展示（`conversation.getDeletedBranchCount`，全量扫描）；
  - 一键清理过期软删（`conversation.pruneDeletedBranches`，成功后刷新数量）；
  - 保留期配置输入（`conversation.getBranchRetentionConfig` / `updateBranchRetentionConfig`，
    非负整数校验，0 = 不自动清理）。
- 新增 7 个 BranchHandlers（**只追加，未与并发批次重叠**）：
  `conversation.restoreBranchCandidate` / `renameBranchCandidate` / `purgeBranchCandidate` /
  `getDeletedBranchCount` / `pruneDeletedBranches` / `getBranchRetentionConfig` / `updateBranchRetentionConfig`。
  变更类操作沿用 TREE-13 流式互斥（`rejectIfStreaming`）；全部写操作在 BranchService 会话写锁内。

### 6. MIG-06 文案

新增文案仅前端三语（zh-CN / en / ja），键集与占位符完全一致（languageParity.test.ts 约束）：
`components.settings.checkpoint.sections.branchCleanup.*`（title / description / deletedCountLabel /
deletedCountValue / deletedCountEmpty / countLoadFailed / pruneButton / pruneLoading / pruneSuccess /
pruneFailed / retention.{label,hint,invalid,save}）。

### 7. 文件边界与并发说明

- 按任务文件边界执行；`webview/handlers/BranchHandlers.ts` 与另一批次（TREE-06 switchBranchCandidate 全链编排）
  并存：对方已改写 `switchBranchCandidate` 编排，本批**只追加**新 handler + 注册项，无重叠（已核对最终文件）。
- 验证期间曾观察到 `UsageIndexStore.ts` 的瞬时类型错误（另一批次编辑中），随后自行恢复；与本批改动无关。

---

## 二、修改摘要

### 后端（backend/modules/conversation/branch/）

| 文件 | 变更 |
|---|---|
| `types.ts` | `ConversationBranchNode.deletedAt?` / `BranchCandidateSummary.deletedAt?`；`DEFAULT_BRANCH_RETENTION_DAYS = 30`；`BranchRetentionConfig` 接口 |
| `BranchGraph.ts` | 新增纯函数：`isDeletedNodeExpired`、`softDeleteNode`（活跃路径拒绝 + 清非活跃父指针 + 摘要同步）、`restoreNode`、`renameBranchLabel`、`collectDeletedNodes`、`pruneDeletedNodes`、`removeSubtree`（共用 `removeNodeSet`） |
| `BranchGraphRepository.ts` | `listConversationIds()`（扫描 conversations/*/branches.json）；`getBranchConfigFilePath` / `loadBranchRetentionConfig`（缺失/损坏回默认 30）/ `saveBranchRetentionConfig`（非法值抛 INVALID_BRANCH_RELATION，原子写） |
| `BranchService.ts` | 构造入参 `options.retentionDays?`；`deleteBranchCandidate` 改走 `softDeleteNode`（补 deletedAt）；新增 `restoreBranchCandidate` / `renameBranchCandidate` / `purgeBranchCandidate` / `getDeletedBranchCount` / `pruneDeletedBranches` / `getBranchRetentionConfig` / `updateBranchRetentionConfig`；`BranchGraphMetaResult.deletedCount` |

### 接口层（webview/handlers/BranchHandlers.ts）

追加 7 个 handler + 注册（见设计 5）；原有 handler 与并发批次编排未动。

### 前端

| 文件 | 变更 |
|---|---|
| `frontend/src/composables/useBranchCleanup.ts` | 新增（数量/清理/保留期） |
| `frontend/src/components/settings/BranchCleanupSettings.vue` | 新增区块组件 |
| `frontend/src/components/settings/CheckpointSettings.vue` | 清理区块后挂载 `<BranchCleanupSettings />` |
| `frontend/src/i18n/langs/zh-CN.ts` / `en.ts` / `ja.ts` | `sections.branchCleanup.*` 三语同步 |

### 测试

| 文件 | 新增用例 |
|---|---|
| `backend/__tests__/conversation/branchGraph.test.ts` | isDeletedNodeExpired ×3、softDeleteNode/restore ×4、renameBranchLabel、collectDeletedNodes、prune/removeSubtree ×4 |
| `backend/__tests__/conversation/branchService.test.ts` | deletedAt 软删 + meta.deletedCount、restore、rename、purge、getDeletedBranchCount（单会话+全量）、prune（now 可控/子树/损坏跳过/孤儿跳过/持久化保留期）、保留期配置 ×7 |
| `backend/__tests__/conversation/branchRepository.test.ts` | listConversationIds、保留期配置读写/损坏回默认/非法值 ×2 |
| `backend/__tests__/webview/branchHandlers.test.ts` | 注册表 5→12、新 7 handler 行为 + 入参校验 + TREE-13 互斥 ×7 |
| `frontend/src/components/settings/__tests__/BranchCleanupSettings.test.ts` | 新增 8 用例（挂载加载/空态/清理成功失败/保留期校验保存失败） |

---

## 三、验证结果

```
npm run typecheck                              # tsc -p ./ --noEmit：通过，0 错误
npm --prefix frontend run typecheck            # vue-tsc --noEmit：通过，0 错误
npx jest --config jest.backend.config.js \
  backend/__tests__/conversation/branchGraph.test.ts \
  backend/__tests__/conversation/branchService.test.ts \
  backend/__tests__/conversation/branchRepository.test.ts \
  backend/__tests__/webview/branchHandlers.test.ts \
  backend/__tests__/conversation/branchReroll.test.ts \
  backend/__tests__/conversation/branchRace.test.ts \
  backend/__tests__/i18n/languageParity.test.ts   # 7 suites / 185 tests 全绿
npx jest --config jest.backend.config.js          # 全量：136 suites / 1486 tests 全绿
npm --prefix frontend test                         # vitest：21 files / 238 tests 全绿
```

- 既有受影响测试（branchService / branchGraph / branchRepository / branchReroll / branchRace / branchHandlers）
  全部保持通过；语言包一致性（backend + frontend 三语键集/占位符）通过。
- 前端新增 BranchCleanupSettings 8 用例 + 既有 CheckpointSettings（现含内嵌新区块）14 用例全绿。

---

## 四、遗留 / 后续说明

- 保留期「自动清理」仅提供 API 与设置入口；定时/触发式自动 prune 的调度（如启动时 / 会话关闭时）未接线，
  建议后续批次在启动流程或 ConversationManager 清理路径挂 `pruneDeletedBranches()`。
- 工作区存档引用计数清理（BCP-06）未做：prune 只清图侧（节点移除后 workspaceCheckpointId 绑定随之消失），
  不触碰存档文件与索引。
- `getDeletedBranchCount` 为全量扫描（O(会话数 × 图大小)），设置页低频调用可接受；如需高频统计可后续加缓存。
- 候选数量上限提示（决策 4）沿用既有 `MAX_CANDIDATES_PER_PARENT = 10` + `assertCandidateLimit`，未在本批改动。
- `deleteToMessage`（决策 6：硬删同步更新分支图子树软删）与 TREE-10 候选切换器 UI（候选列表灰显已删、
  恢复/彻底删除按钮）属后续批次，本批仅提供其依赖的后端 API 与设置页入口。
