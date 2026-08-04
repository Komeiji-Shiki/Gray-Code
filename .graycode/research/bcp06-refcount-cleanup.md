# BCP-06：分支删除时按引用计数清理工作区存档（实施记录）

- 批次：第七阶段 BCP-06（P6b-3 的 checkpoint 侧 + purge/prune 联动）
- 状态：实施完成（代码 + 测试 + 全量验证）
- 日期：2026-08-04
- 关联规划：`checkpoint-history-branch-architecture.plan.md` 第七阶段 BCP-06（L122）+ 已确认决策 3（软删保留期）/ 12（BCP-07 不做内容哈希去重）
- 研究依据：`.graycode/research/bcp-phase-research.md` §5（BCP-06 v1 推荐「扫描所有 BranchGraph」）+ §7.2 场景 17-23；`.graycode/research/bcp02-workspace-bind.md`（绑定字段已落地）
- 前置：BCP-01/02（`workspaceCheckpointId` 绑定已落地）、TREE-09（软删/prune/purge 已落地）

---

## 一、设计说明

### 1. 计数模型：v1 扫描所有 BranchGraph（不做持久化 counter）

- 新模块 `backend/modules/checkpoint/checkpointRefCounts.ts`（**选模块化方案**，理由见 §1.5）：
  - `computeCheckpointReferenceCounts(repo, conversationIds?)`：经 `BranchGraphRepository.listConversationIds`（缺省全量）+ 只读 `load` 扫描，统计每个 `checkpointId` 被多少**存活**分支节点引用（`node.workspaceCheckpointId`，按节点计数累加——同一对话多节点引用同一存档天然去重计数）。
  - 计数口径：**软删节点不计数**（研究 §5.2：保留期内引用不算，prune 后即失效）；损坏/缺失 sidecar 跳过（与 `pruneDeletedBranches` 同口径，warn 记录，不抛错）。
  - 返回值 `Map<checkpointId, refCount>`（缺失即 0）。
- 与 `CheckpointRetentionService` 职责正交：Retention 管「数量上限 maxCheckpoints」，BCP-06 管「分支节点引用归零」；两者互不调用，共用 `deleteCheckpointInternal`/`deleteCheckpointsBatch` 家族原语。

### 2. 删除联动：`CheckpointManager.deleteCheckpointsByNodeIds`

签名：`deleteCheckpointsByNodeIds(conversationId, nodeIds, options?: { force?: boolean; referenceCounts?: Map<string, number> })`

- **候选** = 本对话中 `messageNodeId ∈ nodeIds` 的存档记录；旧存档无 `messageNodeId` 不匹配 → 不误删（研究 §5.4 兼容红线）。
- **三重拒绝闸门**（按序合并进 `rejectedIds`）：
  1. **引用计数**：`referenceCounts` 中 refCount>0 → 拒绝（除非 `force=true`；force 只跳过引用计数闸门，不跳过链保护）；`referenceCounts` 缺省时跳过本闸门（退化为研究 §5.4 的 nodeId 清理语义，仅链保护）。
  2. **CP-05 祖先闭包**：即使 refCount===0，被保留存档引用为 base（增量链依赖）的候选也拒绝——与 `deleteCheckpointsBatch` 的 `rejectedIds` 语义合并（BCP-07：增量链共享不因引用计数删除破坏）。
  3. **CP-DEL-1**：`backupDir` 越界记录拒绝（绝不把未校验目录名交给 `fs.rm`）。
- 写回/删盘与 `deleteCheckpointsBatch` 同路径：`updateCustomMetadata` 链内原子写回 → 写回成功后才删备份目录（失败只留孤儿目录）；工作区级存档锁 `runExclusive('delete')`。

### 3. computeForcedKeepIds 抽取（纯重构）

- 读代码确认现状：`deleteCheckpointsBatch` 的祖先闭包逻辑**内联**（L1312-1320），`deleteCheckpointsFromIndexInternal` 有同口径的变体（含 keep 节点自身）。
- 抽取为模块级导出纯函数 `computeForcedKeepIds(records, keepIds): Set<string>`（返回 keepIds 自身 + 全部祖先）；`deleteCheckpointsBatch` 改为调用它（行为逐位等价：keep 节点不在删除集合，加入 forcedKeep 无副作用），新方法 `deleteCheckpointsByNodeIds` 复用。`deleteCheckpointsFromIndexInternal` 未改（最小改原则，其变体带 keepIds 并集，避免无谓风险）。

### 4. purge/prune 挂接（BranchService）

- 新增私有方法 `cleanupZeroReferencedCheckpoints(conversationId, removedNodeIds)`：
  1. 被移除节点已在图中消失（purge/prune 先 `validateAndSave` 落盘）；
  2. 重扫全部 sidecar 计算引用计数（见 §1）；
  3. 经**全局清理器** `getGlobalCheckpointRefCountCleaner()` 调 `deleteCheckpointsByNodeIds`（nodeIds = 被移除节点）；
  4. 失败仅 `log.warn`（清理是派生态，不阻塞分支删除主流程；BCP-05 恢复前仍校验存档存在性兜底）。
- **挂接点**：
  - `purgeBranchCandidate`：mutateGraph 后（会话写锁已释放）同步等待清理；
  - `pruneDeletedBranches`：每个会话 runExclusive 后同步等待清理（跨会话逐会话执行）。
- **软删不触发**：`deleteBranchCandidate` 不调用清理（决策 3 语义：保留期内可恢复；恢复后节点绑定仍有效——有测试固化）。
- **生产接线**：`CheckpointManager` 构造时自注册为全局清理器（`setGlobalCheckpointRefCountCleaner(this)`，与 `setGlobalBranchService` 同模式）。这是文件边界内唯一可行的生产接线点（BranchHandlers/ChatViewProvider 不在本批边界；BranchService 本身持有 BranchGraphRepository，负责扫描侧）。
- **时序取舍：同步 await 而非 fire-and-forget**——purge/prune 均为低频显式清理操作（设置页/手动彻底删除），确定性结果（deleted/rejected 落日志）价值更高；同步等待避免多个 prune 并发扫描交错；失败已内部捕获，不延长用户可见错误。锁序安全：清理在会话写锁之外调用（`cleanupZeroReferencedCheckpoints` 自身只取存档锁 → 存档锁 → 元数据写串行，符合「存档锁只能在会话锁之外获取」强约束）。

### 5. 模块化选型说明（checkpoint 域新文件 vs CheckpointManager 扩展）

- **新文件 `checkpointRefCounts.ts`**：扫描逻辑 + 清理器注册表（接口 + 全局单例）独立成模块。
  - 理由：① 扫描函数是纯只读计算（不依赖 CheckpointManager 内部状态），可独立单测（注入轻量图源）；② 全局注册表避免 BranchService → CheckpointManager 的运行时依赖（BranchService 只依赖 checkpointRefCounts → BranchGraphRepository，无模块环）；③ 与 `CheckpointRetentionService`/`CheckpointQueryService` 的拆分哲学一致（CPF-12）。
- CheckpointManager 只做三处最小改动：`computeForcedKeepIds` 抽取 + `deleteCheckpointsByNodeIds` 新方法 + 构造自注册。

### 6. 已知语义边界（固化为文档/测试）

- 软删节点不计数：若存档仅被软删节点引用且同批有节点被 purge/prune → 存档可能被清理；恢复该软删分支时 `workspaceCheckpointId` 指向已删存档 → BCP-05 恢复前校验将 `workspaceState` 置 `'unavailable'`（研究 §5.2 明确接受该语义）。
- 损坏 sidecar 跳过：其引用无法统计（该图本就不可恢复），warn 记录；MIG-05 完整性工具负责修复。
- 引用计数与绑定竞态（R4）：清理时绑定迟到 → 已删存档被迟到绑定引用 → 恢复时报缺档；缓解：清理在 prune 落盘后立即执行 + BCP-05 恢复前仍校验存档存在性（v1 接受）。

---

## 二、修改摘要

| 文件 | 变更 |
|---|---|
| `backend/modules/checkpoint/checkpointRefCounts.ts` | **新增**：`computeCheckpointReferenceCounts`（扫描全部/指定会话 BranchGraph，存活节点引用计数，损坏跳过）；`CheckpointRefCountCleaner` 接口 + `set/getGlobalCheckpointRefCountCleaner` 全局注册表 |
| `backend/modules/checkpoint/CheckpointManager.ts` | 新增导出纯函数 `computeForcedKeepIds`（CP-05 祖先闭包抽取）；`deleteCheckpointsBatch` 改用该函数（行为等价）；新增 `deleteCheckpointsByNodeIds`（引用计数/CP-05/backupDir 三重闸门 + 写回后删盘）；构造函数自注册为全局清理器 |
| `backend/modules/conversation/branch/BranchService.ts` | 新增 `cleanupZeroReferencedCheckpoints` 私有方法；`purgeBranchCandidate` / `pruneDeletedBranches` 物理清理后同步触发存档清理（软删不触发）；头注释补 BCP-06 职责说明 |
| `backend/modules/conversation/branch/BranchGraphRepository.ts` | **未修改**（只读复用 `listConversationIds` / `load`） |
| `backend/__tests__/checkpoint/checkpointRefCounts.test.ts` | **新增**：引用计数扫描 7 用例（同存档多节点累加/跨对话合并/软删不计数/无绑定不计数/损坏跳过/显式会话/全量缺省） |
| `backend/__tests__/checkpoint/checkpointRefCountDelete.test.ts` | **新增**：`computeForcedKeepIds` 6 用例 + `deleteCheckpointsByNodeIds` 9 用例（refCount 0 删除/refCount>0 拒绝/force 覆盖/缺省计数跳过/旧存档不误删/CP-05 合并（BCP-07 base 保护）/整链可删/unsafe backupDir/空入参） |
| `backend/__tests__/conversation/branchService.test.ts` | **扩展**：BCP-06 联动 5 用例（purge 归零清理/purge 共享不删/prune 归零清理/软删不清理/未注册清理器退化） |

未触碰：CHANGELOG.md、规划文档、ToolExecutionService/ConversationManager/BranchHandlers/前端、CheckpointRestoreService 恢复流程、软删语义。

---

## 三、验证结果

```
npm run typecheck                                  # tsc -p ./ --noEmit：0 错误
npx jest --config jest.backend.config.js \
  backend/__tests__/checkpoint/checkpointRefCounts.test.ts \
  backend/__tests__/checkpoint/checkpointRefCountDelete.test.ts \
  backend/__tests__/conversation/branchService.test.ts   # 新增 27 用例全绿
npx jest --config jest.backend.config.js \
  backend/__tests__/checkpoint/ backend/__tests__/conversation/   # 47 suites / 691 tests 全绿
npx jest --config jest.backend.config.js \
  backend/__tests__/api/ backend/__tests__/tools/toolBatchCheckpoint.test.ts \
  backend/__tests__/webview/                        # 11 suites / 104 tests 全绿
npx jest --config jest.backend.config.js            # 全量：142 suites / 1574 tests 全绿
```

- 全量跑中间曾出现两个**负载抖动**失败（均属其他批次域、与本次改动无关，隔离复跑通过）：
  - `branchSwitch.test.ts`「切换后继续对话 append 到新活跃尾」`waitForGraphTail` 超时（TREE-06 域，轮询等待 10ms×N）；
  - `toolBatchCheckpoint.test.ts`「写工具 before/after 绑定」`waitForBoundNode` 超时（BCP-02 域，fire-and-forget 绑定轮询 3000ms）。
  - 二者隔离复跑均通过（18/18、15/15）；最终全量复跑全绿（1574/1574）。
- 运行日志确认联动生效：`branch_checkpoint_cleanup {"deletedIds":["cp-1"],"rejectedIds":[]}`（purge 归零清理）与 `{"deletedIds":[],"rejectedIds":["cp-1"]}`（共享存档拒绝）。

---

## 四、遗留 / 后续说明

- **deleteCheckpointsFromIndexInternal 未改用 computeForcedKeepIds**：其内联变体带 keepIds 并集，语义等价但形状不同；如需统一可在后续批次合并（当前保持最小改）。
- 设置页「分支清理」区块（TREE-09）当前只展示 prune 数量，未展示 BCP-06 清理的 deleted/rejected 明细；日志（`branch_checkpoint_cleanup`）已可观测，前端展示属后续可选增强。
- 定时/触发式自动 prune 未接线（TREE-09 遗留）：若未来接线，BCP-06 联动随 prune 自动生效，无需额外改动。
