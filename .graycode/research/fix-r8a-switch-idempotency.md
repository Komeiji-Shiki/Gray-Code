# R8a-FIX：候选切换复查问题（TREE-04/06 全链）— 修改摘要 / 验证结果

> 批次：R8a-FIX（R8a 复查 TREE-04/06 候选切换全链：1 高危 + 2 中危 + 若干低危）
> 依据：.graycode/research/tree04-06-switch.md；基于最新代码（R7a-FIX 刚完成，
> isRealUserMessage 谓词已统一，本批次未触碰该谓词）
> 范围：仅 `backend/modules/conversation/ConversationManager.ts`
> （rewriteHistoryFromBranchGraph 相关）与 `backend/__tests__/conversation/branchSwitch.test.ts`。
> 未触碰：CHANGELOG / 规划文档 / branch/BranchService.ts / branch/BranchGraph.ts /
> usageStats / UsageIndexStore（R8-FIX 并发批次在改）/ isRealUserMessage / 前端 /
> webview/handlers/BranchHandlers.ts（M2 采用 rewrite 内拒绝方案，无需 handler 编排调整）。

## 一、问题与修复方案

### HIGH H1：FR 消息 id 每次重建随机生成 → 幂等失效 + 检查点误删

**根因**：`rewriteHistoryFromBranchGraph` 重建 FR 消息时 id 每次 `randomUUID()` 新生成
（图不存 FR 消息 id，决策 8 建模使然）；主历史既有 FR id 是写入时的随机 UUID →
活跃路径含 ≥1 个 FR（工具循环场景）时「与旧主历史逐元素按 id 比对」必然失败：
① 同一路径重复切换永远 rewritten=true（每次全量重写 + 用量重建）；
② divergenceIndex 落在首个 FR 位置 → `deleteCheckpointsFromIndex` 把内容未变、
索引仍有效的共享前缀检查点误删（数据损失）。

**修复（读代码后选型）**：重建 FR 消息时**优先复用旧主历史中对应位置的既有 FR 消息 id**。
匹配口径 = 「所属节点 id + FR part id 集」：

- 旧主历史中 FR 消息的 parentId 可能是前一条 FR（逐条追加形态，`addContent`/
  `settleFunctionResponses` 以 `history[length-1]` 为 parent），不能直接用作所属节点 →
  按「最近一条非 FR 消息」确定所属节点；
- key = `${所属节点 id}|${parts 中 functionResponse.id 的有序集合}`，精确匹配优先
  （覆盖重写后的合并形态：一个节点一个 FR 消息、含全部 FR parts）；
- 同一节点拆分多条旧 FR 消息（逐条追加形态）时按「该节点 FR id 并集」兜底复用第一条旧 id
  （首轮重写即稳定，减少抖动）；匹配不到才生成新 id。

幂等比对与 divergenceIndex 无需对 FR 做 id 无关化——复用 id 后同一路径二次重写
逐元素比对自然通过（identical=true → rewritten=false、divergenceIndex=null）。
共享前缀上的 FR（工具调用发生在分歧之前，新旧历史都含）id 复用后不再落入分歧点，
检查点不再被误删；分歧后的 FR 属于不同工具调用、无匹配 → 新 id（正确语义）。

### MED M1：重写部分失败回滚不完整（invalidateContextManagementState 在 saveHistory 之后）

**根因**：顺序为 saveHistory → updateUsageIndex（静默吞错）→ invalidateContextManagementState
（setCustomMetadata → saveMetadata 可抛错）。saveHistory 已成功随后 metadata 写失败 → 抛错 →
BranchHandlers 只回滚图（L223-233），主历史保持新路径 → 图/历史永久分裂无自愈。

**修复（方案 a，最小）**：把 `invalidateContextManagementState('branch_path_switched')` **移到
saveHistory 之前**（历史变更前失效 trim 状态，幂等无害；trim 状态是 transcript 结构的派生状态，
失效后下次读取重算）。修复后重写路径不存在「saveHistory 成功后仍可抛错」的步骤：
metadata 写失败 → saveHistory 未执行 → handler 回滚图 → 图/历史一致；saveHistory 失败 →
trim 状态已失效（无害）→ 同样回滚一致。

### MED M2：切换重写丢弃「已追加主历史但未同步进图」的消息

**根因**：`appendHistoryToGraph` 是锁外 fire-and-forget（appendContents 接线，失败仅
log.warn）；切换重写只取图节点内容 → 异步同步完成前切换（或同步失败）时，主历史尾部
未入图的消息被整体替换丢弃。

**修复（读代码后选型：拒绝切换 + 明确错误，而非锁内同步）**：
在 `rewriteHistoryFromBranchGraph`（会话写锁内）重写前做「历史 vs 图」差异检测——
主历史非 functionResponse 消息的 id 必须存在于图节点集合（FR 消息按决策 8 并入所属节点
parts，排除）。存在未同步消息 → 抛 `BRANCH_OPERATION_CONFLICT`（消息带数量与重试提示），
handler 既有失败路径回滚图状态 → 消息不丢；等待同步收敛（或修复图）后重试成功（自愈）。

**为什么不做锁内同步**：`appendHistoryToGraph` 内部自行获取会话写锁（BranchService.ts
L1042 `runExclusive`），在 rewrite 的 runExclusive 内调用即锁内再入 → 死锁；
在 handler 内先 diff 再同步存在与在途同步的竞态（重复插入同 id 节点）。
拒绝方案无需改 BranchService/BranchGraph（本批次禁止触碰），不引入死锁，零数据丢失。

**一致性说明（与既有切换语义）**：消息若已在图中（含已同步到旧活跃尾下的分支），切换离开
该路径后其作为非活跃分支保留在图中——这是正常分支语义，不构成丢弃；本检查只拦截
「图中完全不存在」的消息（同步未完成/失败的真实丢失面）。

### LOW L1：FR 拆分消息丢失 timestamp

拆分 FR 消息时补齐 `timestamp: node.timestamp ?? node.createdAt`（与所属节点消息一致）。

### LOW L2：divergenceIndex 初值语义与注释不符

初值由 `nextContents.length` 改为 `Math.min(oldHistory.length, nextContents.length)`，
并更新注释：旧历史更长（新路径为旧路径前缀）时 min = 新历史长度（清理全部越界检查点）；
旧历史更短（新路径延伸）时 min = 旧历史长度 = 首个按 id 分歧下标（旧历史无此索引，
清理效果等价）——两态统一为「首次按 id 分歧的数组下标」，与接口注释一致。
既有断言（旧短新长前缀场景 3 → 2）同步更新。

## 二、修改摘要

| 文件 | 改动 |
|---|---|
| `backend/modules/conversation/ConversationManager.ts` | ① H1：FR 重建优先复用旧 id（所属节点 id + FR part id 集精确匹配 + 同节点并集兜底）；② M2：重写前未同步消息检测，抛 BRANCH_OPERATION_CONFLICT 拒绝切换；③ M1：invalidateContextManagementState 移至 saveHistory 之前；④ L1：FR 消息补 timestamp；⑤ L2：divergenceIndex 初值 = min(旧,新) + 注释修正；⑥ 方法 docstring 同步更新 |
| `backend/__tests__/conversation/branchSwitch.test.ts` | 新增 4 项（H1×2 / M2 / M1）；L2 既有断言 3→2 两处；新增 FailingMetadataStorage 测试适配器 |

未触碰：BranchService.ts / BranchGraph.ts / BranchHandlers.ts / usageStats / UsageIndexStore /
isRealUserMessage / 前端 / CHANGELOG / 规划文档。

## 三、验证结果

命令：
```
npx jest --config jest.backend.config.js backend/__tests__/conversation/branchSwitch.test.ts \
  backend/__tests__/conversation/ConversationManager.branch.test.ts \
  backend/__tests__/webview/branchHandlers.test.ts
npx jest --config jest.backend.config.js backend/__tests__/conversation/branchSwitch.test.ts \
  backend/__tests__/conversation/branchService.test.ts backend/__tests__/conversation/branchReroll.test.ts \
  backend/__tests__/conversation/branchRace.test.ts backend/__tests__/conversation/branchGraph.test.ts \
  backend/__tests__/conversation/branchRepository.test.ts backend/__tests__/conversation/ConversationManager.branch.test.ts \
  backend/__tests__/webview/branchHandlers.test.ts
npm run typecheck
```

- 定向（3 套 / 47 用例）：**全部通过**（branchSwitch 17/17 含新增 4 项）。
- 分支组回归（8 套 / 210 用例）：**全部通过**（branchService / branchGraph / branchReroll /
  branchRace / branchRepository / branchSwitch / ConversationManager.branch / branchHandlers）。
- conversation 目录全量（29 套）：28 套全绿；唯一失败为 branchSwitch.test.ts 既有
  `waitForGraphTail` 时序敏感用例（异步图尾收敛轮询，EPERM rename 瞬时失败），**隔离复跑通过**——
  与本批次无关（R7a-FIX 已验证同类 flake：TREE 批次时序轮询，未触碰 append 接线路径）。
- 类型检查：`npm run typecheck`（tsc -p ./ --noEmit）→ **0 错误**。

新增测试明细（`branchSwitch.test.ts`）：
1. 含 FR 的活跃路径重复切换：FR id 复用 → 第二次 rewritten=false、检查点不误删
   （handler 级：二次 doSwitch 同一候选，checkpointDeleteSpy 不调用、FR id 未重新生成）+ L1
   （FR 拆分消息 timestamp == 所属节点 timestamp/createdAt）；
2. 幂等（含 FR）：同一活跃路径二次直调重写 rewritten=false、divergenceIndex=null（不重复落盘）；
3. 尾部未入图消息（同步完成前切换）：拒绝 BRANCH_OPERATION_CONFLICT、消息不丢、图回滚到
   切换前活跃尾；模拟同步收敛后重试成功，消息保留为图分支（未被替换丢弃）；
4. metadata 写失败：重写前失效 trim 状态 → saveHistory 未执行、图回滚 → 图/历史一致；
   metadata 恢复后重试切换成功（自愈）。

## 四、遗留与后续

- M2 采用「拒绝 + 明确错误 + 自愈重试」而非锁内同步：极端场景（同步永久失败且图可读）
  会持续拒绝切换，由 MIG-05 完整性工具修复图后恢复；相比静默丢消息可接受（任务允许二选一）。
- FR id 复用仅保证「同一路径重复切换」与「共享前缀 FR」幂等；跨候选切换后回到原候选时，
  原候选分歧后的 FR id 不在当前旧历史中 → 重新生成（属正常分歧语义，不影响检查点正确性）。
