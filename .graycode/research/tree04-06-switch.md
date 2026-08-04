# TREE-04 + TREE-06：候选切换 + 主历史重写（后端同步切换链路）

> 批次：第六阶段 TREE-04/06（后端同步切换链路；前端候选切换器 UI 属 TREE-10）
> 日期：2026-08-04
> 规划依据：`checkpoint-history-branch-architecture.plan.md` 第五部分 §8（L1511–1535 切换流程）、
> 完成定义 11/12/13、已确认决策 8（functionResponse 建模）
> 研究依据：`.graycode/research/branch-tree-phases-research.md`（TREE-04/06 行、3.2 节）、
> `.graycode/research/fix-g3-branch.md`（BranchService 现状 + M-3 锁序强约束）、
> `.graycode/research/tree01-02-reroll.md`（reroll 底座：startReroll/finishReroll、appendHistoryToGraph 接线）
> 前置已完成：`BranchService.switchBranchCandidate`（图侧：目标候选激活 activeChildId + 尾指针，
> `mainHistoryRewrite: false` 边界已注明）、`validateActivePathMatchesHistory`（BR-05）、
> FIX-G3 读取侧语义校验、reroll/editBranch 流程（startReroll/finishReroll）、
> `appendHistoryToGraph`（`ConversationManager.appendContents` 之后异步接线，TREE-05）

---

## 一、设计说明

### 1. 目标与边界

- **TREE-04**：`conversation.switchBranchCandidate` 候选左右切换的**后端同步全链**——
  切图（BranchService）→ 主历史重写（ConversationManager）→ 检查点清理 → 返回
  `{ branchGraph, activePathLength, rewritten: true }`。
- **TREE-06**：主历史全量重写——「切换后主历史 = 新活跃路径」的唯一真源操作，
  从分支图活跃路径节点重建主历史 Content[]（候选节点内容存于 sidecar，主历史里可能没有）。
- 本批次**只做后端**；前端候选切换器 UI 是 TREE-10；TREE-07 的 TODO/Build 重建留待后续批次
  （本批次只做上下文裁剪状态失效，见 3.5）。
- 文件边界：`backend/modules/conversation/ConversationManager.ts`（新增重写方法）、
  `webview/handlers/BranchHandlers.ts`（switchBranchCandidate 编排升级）、
  `backend/__tests__/conversation/branchSwitch.test.ts`（新建切换全链测试）。
  未触碰：BranchService.ts / BranchGraph.ts（软删除批次在改）、ChatFlowService/ChatHandlers/
  MessageRouter（reroll/editBranch 流式接线批次）、usage/checkpoint 核心、前端、CHANGELOG、规划文档。

### 2. 主历史重写（ConversationManager.rewriteHistoryFromBranchGraph）

签名：`rewriteHistoryFromBranchGraph(conversationId: string): Promise<BranchHistoryRewriteResult>`，
返回值含 `{ rewritten, historyLength, activePathLength, divergenceIndex, historyIds }`。

流程（整体在 `runExclusive` 会话写锁内）：

1. **读图**：经 `getGlobalBranchService().getBranchGraph`（只读不持图锁，无死锁；
   与 `appendContents` 的既有接线同模式）。无图/空图 → 线性模式，不重写（rewritten=false）；
   损坏（解析/语义）→ 抛 `BRANCH_STORAGE_CORRUPT`，拒绝覆盖。
2. **节点 → Content[] 映射**（决策 8）：
   - user/model/system 节点 → 一条消息：`role / parts(剔除 functionResponse) / id / parentId /
     timestamp / modelVersion / usageMetadata` 取自节点；
   - 节点 parts 中的 functionResponse **拆分回独立消息**（`role='user'` + `isFunctionResponse: true`，
     依附在所属节点消息之后）——与 `importLinearHistory` / `finishReroll` 的合并规则互为逆操作；
   - 拆分出的 FR 消息补齐随机 id（图不存 FR 消息 id，决策 8 建模使然），
     parentId = 前一条消息 id（线性链）。
3. **幂等**：与旧主历史逐元素按 id 比对，完全一致 → 不落盘（rewritten=false）。
4. **分歧索引**：旧历史与新历史首次 id 分歧的数组下标（旧历史更长时取新历史长度）——
   检查点从该索引起清理（与 reroll 截断的 `deleteCheckpointsFromIndex(truncateIndex)` 语义对齐）。
5. **落盘**：直接走 `storage.saveHistory`（分段原子写 + updatedAt 统一维护）+ `updateUsageIndex`
   （用量索引全量重建，口径 = 新活跃路径）——**不走仓储**（仓储自带会话写锁，锁内嵌套会死锁，
   与 `ensureHistoryNodeIds` / startReroll 截断的既有做法一致）；随后
   `invalidateContextManagementState('branch_path_switched')` 失效上下文裁剪状态（TREE-07 前置）。

### 3. 编排与锁序（BranchHandlers.switchBranchCandidate 升级）

```
1. 切图：        service.switchBranchCandidate(conversationId, nodeId)   （会话写锁内，BranchService）
2. 主历史重写：  conversationManager.rewriteHistoryFromBranchGraph(...)  （会话写锁内）
3. 检查点清理：  checkpointService.deleteCheckpointsFromIndex(divergenceIndex)  （会话锁之外）
4. 响应：        { success, nodeId, activeTailNodeId, activePathIds, rewritten: true,
                   activePathLength, historyLength, branchGraph }
```

- **锁序（M-3 强约束）**：`CheckpointService.deleteCheckpointsFromIndex` 内部持
  `checkpointOperationLockManager` 存档操作锁——**只能在会话写锁之外调用**，故步骤 3 在
  步骤 1/2 的会话锁释放后执行；全局顺序「会话锁（图+历史）→ 存档锁（检查点）」无反转。
- **原子性编排**：图切换与主历史重写是两个独立 `runExclusive` 获取（BranchService 不可改，
  跨服务编排顺序明确为「先图后历史」）；重写读图看到的是刚切换后的图，语义上等价于
  「同锁内图→历史」的串行提交。
- **失败回滚**：主历史重写失败时尽力回滚图状态（`switchBranchCandidate(previousActiveTail)`）：
  有图取切换前 `graph.activeTailNodeId`；线性模式（无图）取旧历史尾部最后一条非
  functionResponse 消息 id；回滚失败仅告警。随后透出原始错误码
  （BranchError 码原样 / 非 BranchError → `INTERNAL_ERROR`，L-6 语义）。
- **检查点清理语义**：`divergenceIndex` 为 null（完全一致）不清理；为 0（路径完全不同）从 0 删
  （全部旧检查点）；否则删除 `messageIndex >= divergenceIndex` 的检查点——共享前缀上的检查点
  保留（消息 id 未变，索引仍有效），分歧点之后的旧检查点索引错位，一律清理。

### 4. 关键取舍

1. **FR 消息 id 每次重建重新生成**：图不存 FR 消息 id（决策 8），重建时随机 UUID。
   FR 不参与节点 id 链（BR-05 校验过滤）、无检查点、前端不持久引用 → 无影响。
2. **`isUserInput` / `turnDynamicContext` / `tokenCountByChannel` 等字段不保留**：
   图节点只存 content 核心字段（importLinearHistory/finishReroll 入图时即已丢失），
   重建是「图 → 主历史」的对称逆操作，不额外丢失信息；新回合消息由前端追加时自带
   `isUserInput`，工具循环/上下文裁剪以「最后一条 isUserInput 消息」定位不受影响。
3. **不跑 `normalizeHistoryForDisplay`**：图节点 parts 已包含被合并的 rejected FR
   （rejectAllPendingToolCalls 的 rejected 标记保留在 parts 里），重建即自洽；
   极端悬空 functionCall 由既有读取路径（getMessagesPaged 首次页）兜底。
4. **不更新 custom.messageCount**：与 BR-02 迁移/删除路径一致，摘要 messageCount 由前端
   加载后 updateSummary 维护；`saveHistory` 已统一维护 updatedAt 与存储级 totalMessages。
5. **响应 `rewritten: true` 恒真**（任务契约）：表示「切换编排已完成且主历史已验证 = 新活跃路径」；
   实际是否落盘由内部 `rewritten` 判定（无变更不重写，幂等）。

### 5. 与后续批次的分界

- TREE-07：TODO 重放 / Build 重建 / 工具响应索引重建——不在本批次（仅失效 trim 状态）。
- TREE-08：用量只统计活跃路径——本批次已按新活跃路径全量重建用量索引，与 TREE-08 口径兼容。
- TREE-10：前端候选切换器 UI 消费本响应 `{ branchGraph, activePathLength, rewritten }`。
- TREE-09：软删除/恢复/修剪批次（并发进行中），未触碰。

---

## 二、修改摘要

| 文件 | 改动 |
|---|---|
| `backend/modules/conversation/ConversationManager.ts` | 新增 `BranchHistoryRewriteResult` 接口与 `rewriteHistoryFromBranchGraph(conversationId)`（TREE-06 主历史重写，见设计 §2）；导入 `activePath` / `isFunctionResponseMessage`（branch/BranchGraph）与 `BranchError`（branch/types） |
| `webview/handlers/BranchHandlers.ts` | `switchBranchCandidate` 编排升级为「切图 → 主历史重写 → 锁外检查点清理 → 响应 `{ rewritten: true, activePathLength, historyLength, branchGraph }`」；失败回滚图状态 + 透出明确错误码；导入 `CheckpointService` 与 `isFunctionResponseMessage` |
| `backend/__tests__/conversation/branchSwitch.test.ts` | **新建**：TREE-14 切换全链测试 13 项（见验证结果） |

未触碰：BranchService.ts / BranchGraph.ts（软删除批次）、ChatFlowService/ChatHandlers/MessageRouter、
CheckpointService.ts（只读确认签名，无需改动）、usage/checkpoint 核心、前端、CHANGELOG、规划文档。

---

## 三、验证结果

命令：
```
npx jest --config jest.backend.config.js backend/__tests__/conversation/branchSwitch.test.ts \
  backend/__tests__/conversation/branchService.test.ts \
  backend/__tests__/conversation/branchReroll.test.ts \
  backend/__tests__/conversation/branchRace.test.ts \
  backend/__tests__/conversation/branchRepository.test.ts \
  backend/__tests__/webview/branchHandlers.test.ts
npx tsc --noEmit -p tsconfig.json
```

- **Test Suites: 6 passed / 6 total；Tests: 122 passed / 122 total**
  （含新增 branchSwitch.test.ts 13 项；branchService/branchReroll/branchRace/branchRepository/
  branchHandlers 既有用例全部保持通过）
- **typecheck：`tsc --noEmit -p tsconfig.json` 通过，0 错误**

新增测试明细（`branchSwitch.test.ts`，风格对齐 branchReroll.test.ts）：
1. 切图 + 主历史重写 + 响应（rewritten/activePathLength/branchGraph）+ 检查点清理（分歧索引=新历史长度）
2. 检查点清理分歧索引：从分歧位（非前缀）清理
3. 切回旧候选恢复旧内容；切回新候选 functionResponse 依附正确（决策 8：FR 拆分回独立消息、
   parentId=所属节点、非 FR id 链 == 活跃路径）
4. 切换到空候选（失败候选）：从 sidecar 物化空消息，主历史 = 活跃路径
5. 切换后继续对话 append 到新活跃尾（appendHistoryToGraph 已接线）
6. 线性模式首次切换（无图）：建基线图后主历史不变（幂等，检查点不清理）
7. rewriteHistoryFromBranchGraph 直调：无图（线性模式）rewritten=false
8. 幂等：切换重写后再次调用同一路径 rewritten=false（不重复落盘）
9. sidecar 损坏（解析失败）拒绝重写 BRANCH_STORAGE_CORRUPT，主历史保持原样
10. 语义损坏图（可解析但无效）同样拒绝重写
11. 未注册全局分支服务时拒绝 BRANCH_OPERATION_CONFLICT
12. 主历史重写失败：图状态回滚到切换前活跃尾，透出明确错误码（INTERNAL_ERROR）
13. 线性模式（无图）重写失败：回滚锚点取旧历史尾，图回到线性路径

**并发批次说明**：完整范围 `backend/__tests__/conversation/` 全量运行时，除本批次 6 个
分支相关套件全绿外，以下失败均来自**并发批次进行中的文件**（不在本批次文件边界内）：
- `usageStats.test.ts`（TREE-08 批次）：曾出现「describe 嵌套在 test 内」的结构性错误（该批次
  追加 TREE-08 用例时未闭合前一个 test），随后已消失；
- `branchGraph.test.ts` / `branchService.test.ts`（TREE-09 软删除批次）：新追加的
  TREE-09 用例（isDeletedNodeExpired 夹具缺 createdAt / 保留期扫描计数）在并发编辑期间
  间歇红，单独运行当前全绿（branchService 39/39）。
以上与本批次改动无因果关系（本批次未触碰这些文件及其依赖的行为路径）。

---

## 四、遗留与后续（不属于本批次）

- TREE-07：切换后 TODO / Build / 工具响应索引重建（本批次仅失效上下文裁剪状态）。
- TREE-10：前端候选切换器 UI 消费 `{ branchGraph, activePathLength, rewritten }` 并刷新消息窗口。
- `BranchService.switchBranchCandidate` 返回值 `mainHistoryRewrite: false` 保持服务层边界不变
  （图侧职责），handler 层 `rewritten: true` 表示编排已完成主历史重写/校验——如需统一可后续
  让 BranchService 接受「重写回调」实现真正同锁原子，本批次按「跨服务编排顺序」落地。
- 流式失败候选的显式 failed 标记（TREE-09/10 能力，本批次仅按决策 10 保留空候选可切回）。
