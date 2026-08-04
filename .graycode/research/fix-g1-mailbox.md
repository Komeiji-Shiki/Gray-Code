# FIX-G1：conversation/subagents 域复查修复 — 修改摘要 / 验证结果

> 批次：FIX-G1（R5d/R5b 复查问题）
> 依据：R5d HIGH-1（主会话投递整体静默失效）、MED-1/MED-2/MED-3、R5b-2.1/2.3/2.4/1.3
> 范围：仅 `backend/modules/conversation/helpers.ts`、`ConversationManager.ts`、`TranscriptMutation.ts`、
> `backend/tools/subagents/agentMailbox.ts`、`backend/modules/api/chat/services/ToolExecutionService.ts` 及对应测试。
> 未触碰：CHANGELOG / 规划文档 / branch/ / checkpoint / frontend / ContextTrimService / ToolIterationLoopService。

## 一、问题与修复方案

### HIGH-1（高）`cleanFunctionResponseForAPI` 无条件剥离 agentInbox → 主模型永远看不到 agent→main 信箱消息

**根因**：`cleanFunctionResponseForAPI`（helpers.ts）无条件剥离 `agentInbox`；调用链
`ConversationManager.processFunctionResponse`（formatHistoryForAPI）对所有消息的所有 part 无条件执行
→ `injectInboxMessages` 刚注入的当轮工具结果在发给模型的同一请求里已被剥离。子代理→子代理路径
（executor 本地 history 直进 formatter）不受影响，形成“子代理间通、主模型聋”。既有测试只断言
responseParts 有 agentInbox，无端到端断言，故全绿。

**修复（最小侵入，仿照 thoughts/multimodal 的 `isHistoryMessage` 模式）**：
- `cleanFunctionResponseForAPI(response, isHistoryMessage = true)`：新增 `isHistoryMessage` 参数，
  默认 true（历史剥离，既有调用方与测试语义不变）；`isHistoryMessage === false`（当轮）时保留
  顶层与 `data.agentInbox`，其余内部字段照常剥离。
- `formatHistoryForAPI` 的 `processFunctionResponse(part, isHistoryMessage)` 按消息位置传入
  `isHistoryMessage`（`index < lastNonFunctionResponseUserIndex`）：历史消息剥离 agentInbox，
  当轮保留。当轮工具结果落盘后，下一轮请求仍属当前回合（在最后一个真实 user 消息之后），
  保留才能让主模型真正看到；跨轮（新真实 user 消息后）自动剥离，不重放、prompt 不膨胀。
- `cleanContentForAPI`（TokenCountService 计费/计数路径）保持默认剥离，token 计数不含瞬态信箱消息。

**取舍**：回合内多次工具迭代（模型连续调用工具、无新真实 user 消息）时，agentInbox 会随当轮工具
结果持续可见（消息只 drain 一次，但落盘后到回合结束前可被重复发送）——这是“当轮保留、跨轮不含”
语义的可接受代价（模型看到的是同一封邮件，配合自身回复上下文不会重复响应）；严格“投递一次即消失”
需要额外的已投递标记，超出最小修复范围。

### MED-1（中）主会话两个并发生成器共享 mailbox 身份，drain 归属取决于调度顺序

**根因**：流式边执行早启动路径（`executeFunctionCallsWithResults`，流式期间启动）与主循环
（`executeFunctionCallsWithProgress`）共享 `(conversationId, MAIN_SESSION_RUN_ID)` 并各自调用
`injectInboxMessages`。drain 本身同步互斥，但消息挂在哪个结果上取决于调度顺序；abort 丢弃路径
（早启动结果被 settle 后回合结束）会让消息随被丢弃的结果一起丢失。

**修复（ToolExecutionService 内自包含，不破坏现有语义）**：为每个执行循环引入唯一身份
（per-(conversationId, runId) 自增 epoch，key=`conversationId\u0000runId`）；`injectInboxMessages`
只允许「最新启动」的循环 drain——它就是最终落盘的执行循环。早启动路径在主循环启动后自动失去
drain 权（只执行不 drain），消息统一挂在主循环结果上；主循环不存在时（全部工具已早启动），
早启动路径即最终落盘循环，仍正常 drain。循环完成时释放 epoch（异常路径由下一次 claim 覆盖，
Map 条目有界）。

**取舍**：abort 场景消息仍会随回合结束而丢失（模型已停止，无投递目标），但不再挂在会被丢弃的
早启动结果上被持久化；消息保留在 inbox，由 MED-3 的回合边界清理统一处置。未采用“唯一 runId 身份”
方案（会破坏 agent 按 `MAIN_SESSION_RUN_ID` 寻址主模型的既有设计）；未采用“drain 互斥”方案
（drain 已同步，互斥不解决归属问题）。

### MED-2（中）`agentMailbox.clearConversation` 无生产侧调用 → 对话删除后信箱残留

**修复**：`ConversationManager.deleteConversation` 在会话写锁内、`deleteHistory` 成功后调用
`agentMailbox.clearConversation(conversationId)`（内存同步操作，与删除同锁原子执行；删除失败
不会走到该行，信箱状态与对话生命周期一致）。模块依赖方向经确认无环（agentMailbox 仅依赖 crypto）。
接线后对话 ID 复用时不再残留限流状态 / knownRuns / threadDepths / 主会话 inbox。

### MED-3（中）主会话 inbox 无轮次边界清理 → 跨轮滞留/过期投递

**修复（按现有 mailbox 结构最小实现）**：
- `agentMailbox.clearMainSessionInbox(conversationId)`：仅清空主会话（`MAIN_SESSION_RUN_ID`）
  信箱，子代理 inbox 由各自 `unregisterRun` 管理、不受影响。
- `ConversationManager` 在 `addMessage` / `addContent` / `addBatch` 追加**真实 user 消息**
  （role==='user' && !isFunctionResponse && !isSummary && !isAutoSummary）时调用
  `clearMainSessionInbox`——新回合边界 = 新真实 user 消息；回合内 functionResponse / 自动总结
  消息不清空（当轮未投递消息保留）。

**取舍**：以“新回合开始”作为轮次边界（回合结束本身无挂接点——工具循环服务只读、不在本批次
范围内）；回合结束后滞留的 agent→main / 用户打断消息会在下一回合开始时被清空，避免过期投递；
代价是回合间到达的极少数消息（当前架构下子代理随主循环同步执行，回合间基本无到达）会被丢弃，
符合“run 结束后清空未消费消息”的原始意图。

### R5b-2.1（低）`withConversationWriteLock` 无挂起超时

**修复**：引入 `withHangTimeout`（storage.ts 已有导出）包一层，超时 60s（与 usage 队列 / 分段
历史队列对齐；metadata 链 30s 因小文件更短），常量 `CONVERSATION_WRITE_LOCK_HANG_TIMEOUT_MS`。

### R5b-2.3（低）`rejectToolCalls` 遍历 `msg.parts` 未判空

**修复**：`rejectToolCalls` 收集已有响应的循环补 `if (!msg.parts) continue;`，与
`rejectAllPendingToolCalls` / `normalizeHistoryForDisplay` 守卫对齐。

### R5b-2.4（低）删除中间消息后不修复线性 parentId 链（悬空链）

**修复**：新增 `TranscriptMutation.repairParentChainAfterDelete(remaining, deletedMessages)`——
把 `parentId` 直接指向被删 id 的消息重链到被删消息的 `parentId`；被删链连续时沿链向上解析到
最近未删除祖先（首条为 null）。分支语义保留：parentId 指向未删除消息的跨链关系不受影响。
接入点：`deleteLogicalMessage`（deleteMessage 路径）与 `deleteMessagesInRange`（含 BranchService
reroll 主历史截断路径）。`deleteToMessage` / `truncateFrom` 只删末尾、无后继，无需修复。

### R5b-1.3（低）deleteConversation 释放写锁后才 enqueue usage remove → fallback 读改写可“复活 usage.json”

**修复**：把 `usageIndexStore.remove` 的 enqueue 移入会话写锁内（`deleteHistory` 之后）。
在途 append 的 usage 写（appendUsage / 增量缺失回退读改写）都发生在锁内，锁内 enqueue 保证
remove 排在它们之后；删除后新发起的 append 已被 `assertNotDeleted` 短路，不再产生 usage 写。

## 二、修改摘要

| 文件 | 改动 |
|---|---|
| `backend/modules/conversation/helpers.ts` | `cleanFunctionResponseForAPI` 新增 `isHistoryMessage` 参数（默认 true）；当轮保留顶层与 data 的 agentInbox，跨轮剥离；JSDoc 更新 |
| `backend/modules/conversation/ConversationManager.ts` | ① import `withHangTimeout` / `repairParentChainAfterDelete` / `agentMailbox`；② `withConversationWriteLock` 挂起超时 60s（R5b-2.1）；③ `deleteConversation`：usage remove 移入锁内 + `agentMailbox.clearConversation`（R5b-1.3 / MED-2）；④ `addMessage`/`addContent`/`addBatch` 真实 user 消息时 `clearMainSessionInbox`（MED-3）；⑤ `processFunctionResponse` 按 isHistoryMessage 清理（HIGH-1）；⑥ `deleteMessagesInRange` 修复 parentId 链（R5b-2.4）；⑦ `rejectToolCalls` 补 `msg.parts` 判空（R5b-2.3） |
| `backend/modules/conversation/TranscriptMutation.ts` | 新增 `repairParentChainAfterDelete`；`deleteLogicalMessage` 删除后调用（R5b-2.4） |
| `backend/tools/subagents/agentMailbox.ts` | 新增 `clearMainSessionInbox(conversationId)`（MED-3） |
| `backend/modules/api/chat/services/ToolExecutionService.ts` | MED-1：mailbox drain epoch 机制（claim/isOwner/release），`executeFunctionCallsWithProgress` 领取 epoch，4 处 `injectInboxMessages` 传入并校验，完成时释放 |
| `backend/__tests__/conversation/helpers.test.ts` | 新增当轮保留 agentInbox / 默认仍剥离 / 无字段不引入（HIGH-1 单元） |
| `backend/__tests__/conversation/ConversationManager.agentInbox.test.ts` | **新增**：HIGH-1 端到端（注入→addContent 落盘→getHistoryForAPI 当轮含/跨轮不含；回合内多迭代可见）；MED-3（新 user 消息清空、functionResponse/总结不清空、子代理 inbox 不受影响）；MED-2（删除清理、删除失败保留）；R5b-1.3（删除后 append 不产生 usage 写） |
| `backend/__tests__/conversation/TranscriptMutation.test.ts` | **新增**：repairParentChainAfterDelete / deleteLogicalMessage / deleteMessagesInRange 的 parentId 链修复（R5b-2.4） |
| `backend/__tests__/tools/agentMailbox.test.ts` | 新增 `clearMainSessionInbox` 行为测试（MED-3） |
| `backend/__tests__/tools/agentSendMessage.test.ts` | 新增 MED-1 并发执行循环 drain 权收敛测试；`makeStubTool` 支持异步 handler 与自定义工具名 |

未触碰：`CHANGELOG.md`、规划文档、`branch/`、`checkpoint/`、`frontend/`、`ContextTrimService` / `ToolIterationLoopService`（只读）。

## 三、验证结果

- 定向新增测试：`helpers.test.ts`（27 用例）+ `ConversationManager.agentInbox.test.ts`（7）
  + `TranscriptMutation.test.ts`（8）+ `agentMailbox.test.ts`（21）+ `agentSendMessage.test.ts`（19）＝ **82 通过**；
- 回归：`npx jest --config jest.backend.config.js backend/__tests__/conversation/ backend/__tests__/tools/agentMailbox.test.ts backend/__tests__/tools/userMessageInterrupt.test.ts`
  → 本批次改动完成后首轮 **30 套 / 378 用例全部通过**；`backend/__tests__/tools/` 全量 → **34 套 / 388 用例全部通过**；
- 全量后端：`npx jest --config jest.backend.config.js` → **133 套通过 / 2 套失败（8 用例）**；
  失败均为 `TREE-01/02 BranchService reroll` 与 `editBranch.test.ts` 的 branch 图断言（`BranchGraph.renameNode`
  duplicate node id / 图节点缺失）——`branch/` 目录由另一批次在改（本批次首轮 conversation 全量运行时
  这些用例全绿，随后另一批次改动中途出现，与本批次改动无交集；本批次未触碰 branch 相关文件）；
- 类型检查：`npm run typecheck`（tsc -p ./ --noEmit）→ **0 错误**。

> 注：同一工作区另一批次（branch/checkpoint）正在并行编辑，其进行中的改动会使 branch 相关用例
> 出现瞬时红（本批次首次全量运行时全绿，之后未做任何本批次源码改动即出现）。本批次相关用例
> （conversation 非 branch 部分 + tools 全部）在多次运行中稳定全绿。

## 四、遗留说明

- 回合内多迭代重复发送 agentInbox 为接受的取舍（见 HIGH-1 取舍）；
- MED-3 以“新真实 user 消息”为回合边界，回合间极端到达的消息会被清空（见 MED-3 取舍）；
- MED-1 epoch 在异常路径（生成器内部抛错）不释放，由下一次 claim 覆盖，Map 条目有界。
