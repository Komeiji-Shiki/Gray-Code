# TREE-01 + TREE-02：reroll 底座（chat.rerollStream + 多候选）

> 批次：第六阶段 TREE-01/02（reroll 后端底座，前端切换属 TREE-10）
> 日期：2026-08-04
> 规划依据：`checkpoint-history-branch-architecture.plan.md` 第六阶段 L98–113、第五部分 L1452–1471（reroll 流程）、已确认决策 4/5/8/10（L1988–2025）
> 研究依据：`.graycode/research/branch-tree-phases-research.md` 2.2 节 TREE 行、3.3 节、5.3 节

---

## 一、设计说明

### 1. 目标与边界

- **TREE-01**：新增 `chat.rerollStream` 后端流程（`ChatFlowService.handleRerollStream` + `ChatHandler.handleRerollStream` + webview `chat.rerollStream` handler），把"破坏性重试"改成"保留旧回答的 reroll"：旧助手节点及其子树进 sidecar，新候选激活为主。
- **TREE-02**：同一父节点下多次 reroll 形成多个兄弟候选；候选摘要随 reroll 流程 upsert；每父节点候选上限 10（决策 4），超限明确报错提示清理，**不自动删**。
- **决策 5**：`retryStream` / `editAndRetryStream` 保留为内部兼容路径（错误条重试 `retryAfterError` 等暂走旧逻辑），主流程切 reroll；本批次只实现 reroll 后端 API 与纯流程，前端切换留给 TREE-10。
- **决策 8**：functionResponse 不独立成节点——reroll 新候选的工具响应走主历史正常路径（工具循环原样追加），finishReroll 回填图时按 `importLinearHistory` 同规则并入模型节点 parts。
- **决策 10**：流式失败保留旧候选（可切回），新候选保留为"失败候选"（内容为空或半截，标记能力留给 TREE-09 的软删/状态字段）。

### 2. reroll 主流程（ChatFlowService.handleRerollStream）

```
1. ensureConversation + 验证配置（与 retryStream 一致）
2. 中断未完成 diff 等待 + rejectAllPendingToolCalls（与 retryStream 一致）
3. BranchService.startReroll(conversationId, assistantNodeId?)
   ├─ 验证目标节点存在且在活跃路径（省略 assistantNodeId 时取活跃路径最后一条 model 消息）
   ├─ 目标 role==='model' 且父节点存在且 role==='user'（否则 INVALID_BRANCH_RELATION）
   ├─ 候选上限校验（BRANCH_OPERATION_CONFLICT，提示清理）
   ├─ 创建新候选节点（占位、空 parts、kind='reroll'）并设为父节点 activeChildId（旧候选保留）
   └─ 主历史截断到父用户节点之后（旧助手消息及其子树从主历史移除）
4. 复用 ToolIterationLoopService.runToolLoop（isNewTurn:false、createBeforeModelCheckpoint:false，
   与 retry 相同语义）生成内容 → 流式结果写入主历史尾部（functionResponse 走正常配对路径）
5. finally：BranchService.finishReroll(conversationId, candidateNodeId)
   ├─ 主历史父节点后的消息回填图：首条 model 消息 → 候选节点内容（必要时重命名对齐消息 id）
   ├─ 后续 model 消息 → kind='continue' 续接节点（激活 + 更新尾指针）
   ├─ functionResponse 消息 → parts 并入前一个模型节点（决策 8）
   └─ 更新候选摘要（preview/modelVersion/usageMetadata）；失败也执行（决策 10）
```

### 3. 关键设计决策与取舍

1. **主历史切换采用"截断到父节点 + 工具循环追加"（完整路径，非降级方案）**：
   任务允许"先只做图状态 + 主历史追加新消息"，但截断主历史到父用户节点是既有成熟操作
   （`deleteToMessage` / `deleteMessagesInRange` 已被 retry 流程广泛使用），且只有截断后
   主历史才真正等于新候选路径（BR-05 不变量），故直接采用完整方案：`startReroll` 内先建图
   后截断，`finishReroll` 后主历史 id 链 == 图活跃路径（有测试断言）。

2. **顺序：先建图（含旧节点）后截断主历史**：线性模式首次建图时，旧助手节点必须先进入
   sidecar，否则截断主历史会把它永久删除（丢失旧回答）。测试 `线性模式首次建图不丢旧回答`
   专门覆盖此坑。

3. **锁边界与死锁规避**：`mutateGraph`（会话写锁）内不能调用 `deleteMessagesInRange`
   （`ConversationTranscriptRepository` 的 mutate 自身包 `withConversationWriteLock`，
   嵌套会死锁）。因此图变更与主历史截断不原子：先图后历史，中间窗由 `finishReroll` 的
   主历史→图回填兜底；TREE-13 将加流式互斥彻底关闭该窗。

4. **候选节点 id 对齐（BR-01 同源）**：工具循环生成的模型消息 id 由 `ensureNodeId` 随机
   生成，无法预知 → `startReroll` 先建占位候选（随机 UUID），`finishReroll` 时把占位节点
   **重命名**为主历史首条新消息 id（新增纯函数 `renameNode`，同步修正 nodes key、父节点
   activeChildId、尾指针、rootNodeId、镜像指针、候选摘要、跨对话引用），保证
   "节点 id 与 Content.id 同源"。

5. **流式结果"写入新节点"的粒度**：不逐 chunk 重写 branches.json（每 chunk 原子写代价高），
   而是在工具循环结束后一次性回填（`finishReroll`）。失败/中断时半截消息同样回填，
   可切回查看错误（决策 10）。

6. **候选上限口径（决策 4）**：按父节点**全部非软删除子节点**计数（含原始回答，即候选切换器
   中可见条数），上限 `MAX_CANDIDATES_PER_PARENT = 10`；超限抛
   `BRANCH_OPERATION_CONFLICT`（消息含 "candidate limit ... please clean up"），不自动删。
   该检查同时挂在 `createRerollCandidate`、`editCandidate`、`startReroll` 三个入口。

7. **webview handler 形态**：`chat.rerollStream` 注册在 `ChatHandlers.ts`（普通 handler 路径），
   内部复用 `StreamChunkProcessor` 以 streamChunk/streamChunkBatch 协议转发 chunk，与现有
   流式协议一致；handler 内先懒初始化全局 BranchService（与 BranchHandlers 同模式，保证
   ChatFlowService 内 `getGlobalBranchService()` 可用）。**已知限制**：本 handler 未加入
   `MessageRouter.STREAM_MESSAGE_TYPES`（MessageRouter 不在本批次文件边界内），长流期间会
   占用消息队列——TREE-10 前端切换时需把 rerollStream 升级为流式消息类型（研究 5.3 已列此
   事项，规划 L1696）。

8. **与 retryStream 并存（决策 5）**：未改动 `handleRetryStream` / `handleEditAndRetryStream`
   任何行为；reroll 只新增独立方法。测试验证 reroll 后旧破坏性 retry 路径
   （deleteMessage 截断 + retryStream 语义）仍可用，图侧候选不受影响。

### 4. 错误码

| 场景 | 错误码 |
|---|---|
| 目标节点缺失 / 候选节点缺失 | `NODE_NOT_FOUND` |
| 目标不在活跃路径 / 非 model / 父非 user / 无助手消息可 reroll | `INVALID_BRANCH_RELATION` |
| 每父节点候选超限（10） | `BRANCH_OPERATION_CONFLICT`（消息提示清理） |
| sidecar 损坏拒绝覆盖 | `BRANCH_STORAGE_CORRUPT`（既有行为） |
| 分支服务未注册 | `BRANCH_SERVICE_UNAVAILABLE`（ChatFlowService 层） |

---

## 二、修改摘要

| 文件 | 改动 |
|---|---|
| `backend/modules/conversation/branch/BranchGraph.ts` | 新增纯函数 `updateNodeContent`（reroll 结果写入节点，只替换显式字段、parts 深拷贝）与 `renameNode`（候选节点 id 对齐主历史消息 id，同步修正全部引用）；导入补 `ContentPart`/`UsageMetadata` |
| `backend/modules/conversation/branch/BranchService.ts` | 新增 `MAX_CANDIDATES_PER_PARENT = 10`、`RerollStartResult`/`RerollFinishResult`；新增 `startReroll`（验证目标→旧候选进 sidecar→建候选激活→截断主历史）、`finishReroll`（主历史→图回填：首条消息写候选/重命名、后续消息插 continue 节点、FR 合并、摘要更新）；`createRerollCandidate`/`editCandidate` 挂候选上限检查；新增私有 `assertCandidateLimit`/`resolveRerollTarget`；导入 `insertNode`/`renameNode`/`updateNodeContent` |
| `backend/modules/api/chat/services/ChatFlowService.ts` | 新增 `RerollRequestData`（conversationId + assistantNodeId? + configId + …）；新增 `handleRerollStream` 生成器（配置校验 → diff 中断/拒绝挂起工具调用 → startReroll → 复用 runToolLoop → finally finishReroll，失败也回填）；导入 `getGlobalBranchService` |
| `backend/modules/api/chat/ChatHandler.ts` | 新增 `handleRerollStream` 流式方法（转发 ChatFlowService 输出；ChannelError 取消 → cancelled；其余 → formatError），导入 `RerollRequestData` |
| `webview/handlers/ChatHandlers.ts` | 新增 `rerollStream` handler（入参校验、先取消同会话旧流、懒初始化全局 BranchService、StreamChunkProcessor 转发 chunk、`{started:true}` 响应）；注册 `chat.rerollStream` |
| `backend/__tests__/conversation/branchReroll.test.ts` | 新建：TREE-01 startReroll 语义/校验/损坏拒绝、finishReroll 内容回填/失败保留旧候选、TREE-02 多候选/上限/摘要、与 retryStream 并存、BranchGraph 纯函数扩展 |

未触碰：CHANGELOG.md、规划文档、前端（TREE-10）、checkpoint 模块、BranchGraphRepository 写串行/原子写结构、UsageIndexStore/storage/ConversationManager 核心。

## 三、验证结果

- `npx tsc --noEmit -p tsconfig.json` ✅ 通过
- `npx tsc --noEmit -p tsconfig.test.json` ✅ 通过
- `npx jest --config jest.backend.config.js backend/__tests__/conversation/ backend/__tests__/webview/`
  ✅ **30 suites / 339 tests 全绿**（含新增 `branchReroll.test.ts` 16 项）
- 新增测试明细（`branchReroll.test.ts`，风格对齐 `branchService.test.ts`）：
  1. 旧候选保留进 sidecar、新候选激活、主历史截断到父节点之后
  2. 线性模式首次建图不丢旧回答（无 sidecar 时先建图后截断）
  3. assistantNodeId 缺省 → 活跃路径最后一条助手消息
  4. 入参校验：缺失 → NODE_NOT_FOUND；不在活跃路径 → INVALID_BRANCH_RELATION
  5. 非 model / 父节点非 user 拒绝（含 model 父 model 的续接节点场景）
  6. sidecar 损坏拒绝覆盖（BRANCH_STORAGE_CORRUPT）
  7. finishReroll 内容回填：候选重命名对齐消息 id、FR 合并（决策 8）、continue 续接节点、摘要更新、BR-05 主历史 id 链 == 活跃路径
  8. 失败保留旧候选（决策 10）：无内容 / 半截消息两种失败形态，旧候选可切回
  9. 多次 reroll 形成兄弟候选（含 reroll 新候选后再 reroll）
  10. 每父节点候选上限 10：`createRerollCandidate` 与 `startReroll` 均拒绝第 11 个，不自动删
  11. 候选摘要维护：每次 reroll upsert，finish 后 preview 更新
  12. 与 retryStream 并存：reroll 后 deleteMessage 截断路径仍可用，图侧候选不受影响
  13. BranchGraph `updateNodeContent` / `renameNode` 纯函数行为（深拷贝、引用修正、no-op、重复 id 拒绝）

## 四、遗留与后续（不属于本批次）

- 流式期间 reroll 互斥（TREE-13）；`chat.rerollStream` 升级为 MessageRouter 流式消息类型
- 前端 `retryFromMessage` 切 reroll、候选切换器 UI（TREE-10）
- 失败候选显式"failed"标记、软删除（TREE-09，需扩展节点类型字段）
- 候选切换重建主历史/派生状态（TREE-06/07）
- 编辑分支 reroll 化（TREE-03）、回档三连与 reroll 语义衔接（决策 7）
