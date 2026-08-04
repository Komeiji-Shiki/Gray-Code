# R7a-FIX：mailbox 语义一致性 + drain 边角 — 修改摘要 / 验证结果

> 批次：R7a-FIX（R7a 复查 FIX-G1 遗留问题）
> 依据：.graycode/research/fix-g1-mailbox.md；R7a 复查 FIX-G1 发现 2 MED + 若干 LOW
> 范围：仅 `backend/modules/conversation/ConversationManager.ts`、`helpers.ts`、
> `backend/modules/api/chat/services/ToolExecutionService.ts`、`ToolIterationLoopService.ts`、
> `backend/tools/subagents/executor.ts` 及对应测试。
> 未触碰：CHANGELOG / 规划文档 / branch/ / checkpoint/ / frontend / ContextTrimService /
> SummarizeService / rewriteHistoryFromBranchGraph 既有逻辑（仅做谓词统一，未改其行为）。

## 一、问题与修复方案

### MED H1-1：回合边界谓词不一致（总结消息被当回合边界 → 行为分叉）

**根因**：FIX-G1 的 HIGH-1 在 `formatHistoryForAPI` 用 `role==='user' && !isFunctionResponse`
计算 `lastNonFunctionResponseUserIndex`（当轮边界）与 `roundStartIndices`（历史思考回合），
把 **任何** 非 functionResponse 的 user 消息（含 isSummary/isAutoSummary 总结消息）当回合
边界；而 MED-3 清空主会话信箱时**刻意排除**总结消息（总结发生在回合内）。SummarizeService
以 insertIndex 在历史**中间**插总结消息——插入后总结之前的同回合 functionResponse 被判为
「历史」而剥离 agentInbox，但信箱未清空 → 消息既未被清理、模型又看不到，行为分叉。

**修复**：新增共享谓词 `helpers.isRealUserMessage`（`role==='user' && !isFunctionResponse
&& !isSummary && !isAutoSummary`），`formatHistoryForAPI` 的边界循环与 roundStartIndices
循环、以及 `addMessage`/`addContent`/`addBatch` 的 MED-3 清空判定全部改用同一谓词
（roundStartIndices 同时喂给历史思考回合范围，语义为「总结不构成回合」；已跑相关测试确认
thoughts 逻辑无回归）。

### MED E-1：早启动生成器「持 epoch 时已 drain」的消息在 abort 边角丢失

**根因**：流式边执行早启动生成器（`executeFunctionCallsWithResults`，流式期间启动）在其
持有 epoch 期间完成 drain（主循环尚未启动），随后流中途 cancel 且携带 agentInbox 的结果被
整体丢弃（`partialContent.parts.length===0` 不落盘，或调用 id 不在 partialContent 中
`settleCancelledToolCalls` 不结算）时，消息已从 inbox 移除、未持久化 = 丢失。

**方案选择：② 早启动路径一律不 drain（选改动小且语义正确者）**。

- ①（回写 inbox）需在 agentMailbox 增加消息回写 API（不在本批次文件边界内），且回写语义
  （保留原 threadId/hopDepth/id）只能新增方法实现；abort 后下一轮真实 user 消息仍会触发
  MED-3 清空，回写收益有限。
- ② 早启动生成器调用时不传 mailbox 身份（`undefined, undefined`）→ 永不 drain；统一由
  主循环（`executeFunctionCallsWithProgress`，仍传 mailbox 身份）drain；无主循环时
  （autoPrefix 为空分支 = 全部工具已早启动）在落盘前调用新增的
  `ToolExecutionService.drainInboxIntoResults` 显式 drain 一次并注入结果。
- 取舍：流式期间到达的消息不再挂在早启动结果上，而是等主循环/显式 drain 投递——投递时机
  略晚但语义不变（结果落盘后才发下一次模型请求）；abort 场景消息保留在 inbox，由 MED-3
  回合边界清理统一处置（与 FIX-G1 MED-1 的既有取舍一致），不再出现「已移除且未持久化」的
  中间丢失态。

### LOW H1-2：`addMessage` 的 MED-3 谓词缺 isSummary 排除

`addMessage` 旧谓词只有 `!isFunctionResponse`；改为统一 `isRealUserMessage`（含
isSummary 排除）。addContent/addBatch 已具备，本次统一收敛到同一 helper。

### LOW H1-3：`cleanFunctionResponseForAPI` 数组输入无法拦截

`typeof [] === 'object'`，数组会进入解构流程（行为未定义）。增加
`Array.isArray(response)` 守卫直接原样返回。

### LOW E-2：mailboxDrainEpochs 只在完成路径 release

**修复**：`executeFunctionCallsWithProgress` 重构为「公共入口（claim + try/finally 释放 +
`yield*` 委托核心）」+「私有核心（执行逻辑，epoch 由入口传入）」——异常抛出、被 `return()`
提前结束的路径现在 finally 兜底释放；正常路径幂等。新增
`clearMailboxDrainEpochsForConversation`（供需要处调用与测试）。deleteConversation 的
A-COMM 信箱清理已由 FIX-G1 的 `agentMailbox.clearConversation` 接线覆盖（确认，不重复）；
epoch Map 为有界 Map（每 (conversationId, runId) 一条、下次 claim 覆盖），配合 finally
释放后泄漏面仅剩「被永久放弃的生成器 + 已删除会话」的少量数字条目，接受并记录。

### LOW H1-4：子代理本地历史直进 formatter 重放已 drain 消息（选择修复）

**评估**：子代理 executor 的本地 history 直进 ChannelManager formatter（不经
formatHistoryForAPI），`serializeToolResultForLLM`/`convertFunctionResponseToXML` 均原样
序列化 agentInbox ——同 run 后续迭代与 continueFromRunId 续跑会重放已投递消息。裸剥会破坏
首次投递；正确修复需「保留最后一条未投递」语义。

**修复（改动小、风险可控）**：新增纯函数 `executor.stripReplayedAgentInboxForModel`，在
组装 `GenerateRequest.history` 时对 functionResponse 做浅拷贝剥离——只保留**最后一条**
消息中尚未投递过的 agentInbox（工具结果入 history 后第一次请求即投递，与主路径「当轮保留、
跨轮剥离」语义对齐），更早条目顶层与 data.agentInbox 一律剥离，其余字段原样保留；不改写
持久化 transcript（浅拷贝）；无变化时返回原数组（零开销）。`baseContents`
（continueFromRunId 旧 run transcript）中的 agentInbox 全部剥离。

## 二、修改摘要

| 文件 | 改动 |
|---|---|
| `backend/modules/conversation/helpers.ts` | 新增导出 `isRealUserMessage`（MED-3/H1-1 统一谓词）；`cleanFunctionResponseForAPI` 数组守卫（H1-3） |
| `backend/modules/conversation/ConversationManager.ts` | ① `addMessage`/`addContent`/`addBatch` 的 MED-3 清空判定改用 `isRealUserMessage`（H1-2 补 isSummary）；② `formatHistoryForAPI` 的 lastNonFunctionResponseUserIndex 与 roundStartIndices 改用同一谓词（H1-1，总结消息不构成回合边界） |
| `backend/modules/api/chat/services/ToolExecutionService.ts` | E-1：新增公开 `drainInboxIntoResults`（无主循环路径显式 drain，不参与 epoch 竞争）；E-2：`executeFunctionCallsWithProgress` 重构为入口（claim + finally 兜底释放 + yield* 委托）+ 私有核心（epoch 参数传入），新增 `clearMailboxDrainEpochsForConversation` |
| `backend/modules/api/chat/services/ToolIterationLoopService.ts` | E-1 方案②：① 流式早启动调用不再传 mailbox 身份（永不 drain）；② autoPrefix 为空分支（无主循环）落盘前 `drainInboxIntoResults` 显式 drain 一次 |
| `backend/tools/subagents/executor.ts` | H1-4：新增导出 `stripReplayedAgentInboxForModel`；`GenerateRequest.history` 接入（保留最后一条未投递 agentInbox，更早剥离，浅拷贝不改写 transcript） |
| `backend/__tests__/conversation/helpers.test.ts` | H1-3：数组输入原样返回（引用透传） |
| `backend/__tests__/conversation/ConversationManager.agentInbox.test.ts` | H1-1：总结消息插历史中间/末尾不构成新回合（当轮保留、跨轮剥离端到端）；H1-2：addMessage 追加 isSummary 不清空主会话 inbox |
| `backend/__tests__/tools/agentSendMessage.test.ts` | E-1：`drainInboxIntoResults` 显式 drain/无注入目标不消费；E-2：正常/异常路径 epoch 释放、`clearMailboxDrainEpochsForConversation` |
| `backend/__tests__/tools/toolLoopMailboxAbort.test.ts` | **新增**：runToolLoop 集成——① 早启动不 drain + 流中途 cancel → inbox 消息不丢；② 无主循环显式 drain → 消息随最终 functionResponse 投递；③ 主循环接管投递 |
| `backend/__tests__/tools/subagentMailboxReplay.test.ts` | **新增**：`stripReplayedAgentInboxForModel` 单元（同 run 后续迭代保留末条/剥离更早、续跑全剥、浅拷贝不改写原对象、无 functionResponse 原样返回） |

## 三、验证结果

- 定向新增/受影响测试：`helpers.test.ts` + `ConversationManager.agentInbox.test.ts` +
  `agentSendMessage.test.ts` + `subagentMailboxReplay.test.ts` + `toolLoopMailboxAbort.test.ts`
  → **5 套 / 52 用例全部通过**；
- 要求回归：`npx jest --config jest.backend.config.js backend/__tests__/conversation/
  backend/__tests__/tools/agentMailbox.test.ts backend/__tests__/tools/agentSendMessage.test.ts
  backend/__tests__/tools/userMessageInterrupt.test.ts` → **32 套 / 468 用例全部通过**；
- tools 全量 + api toolIteration：→ **37 套 / 404 用例全部通过**（executor 改动对
  subagents/subagentNesting/subagentExecutorContinuation 等全部子代理测试无回归）；
- 全量后端：**138 套 / 1501 用例全部通过**（最后一轮全绿）；
  branchSwitch.test.ts 的 `waitForGraphTail`（TREE-04/06 异步图尾收敛，3s 轮询上限、真实
  临时目录 sidecar）在全量并行负载下出现过 2 次瞬时超时，隔离复跑 / 分支组复跑 / 全量复跑
  均通过——失败用例为 TREE 批次的时序敏感轮询，本批次未触碰 branch/ 及
  appendHistoryToGraph 路径，确认与本批次无关；
- 类型检查：`npm run typecheck`（tsc -p ./ --noEmit）→ **0 错误**。

> 注：同一工作区另一批次（branch/checkpoint 等）正在并行编辑（git status 可见大量分支/检查点
> 文件被修改），存在瞬时红的历史模式；本批次相关用例多次运行稳定全绿。

## 四、遗留说明

- E-1 方案②的取舍：早启动结果不再携带 agentInbox，投递点后移到主循环/显式 drain；
  abort 场景消息保留在 inbox，由 MED-3 回合边界清理统一处置（与 FIX-G1 MED-1 取舍一致）；
- E-2：epoch Map 的 deleteConversation 清理点确认已由 FIX-G1 `clearConversation` 接线覆盖
  （信箱侧）；epoch 条目为有界 Map + finally 兜底释放，未重复接线；
- H1-4：子代理同 run 内「最后一条未投递」之外的 agentInbox 不再重放；控制中断恢复等边角
  若恰好以旧结果作为末条仍可能重投一次（与主路径回合内多迭代重发的既有取舍一致）；
- roundStartIndices 谓词统一后，总结消息不再计入历史思考回合数（更符合「总结发生在回合内」）。
