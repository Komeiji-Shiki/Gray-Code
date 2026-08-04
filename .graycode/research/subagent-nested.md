# 批次 F2：子 agent 开子子 agent（嵌套）实现说明

## 一、设计说明

### 目标
让子 agent 的工具集包含 `subagents` 工具，使子 agent 能再派生子子 agent（嵌套），同时用**深度上限**、**级联清理**、**既有并发信号量**防止失控，并把嵌套结果沿既有链路汇总回主模型。

### 关键设计决策

1. **深度模型（0 基准）**
   - `MAX_SUBAGENT_NESTING_DEPTH = 2`（`types.ts`）：主模型=0、子 agent=1、子子 agent=2；`depth > 2` 的派发被拒绝。
   - 深度通过 run 上下文传递：`ToolExecutionService` 执行子 agent 内部工具时，把本 run 深度注入 `toolContext.subagentDepth`（`executeToolCall` → `executeFunctionCallsWithResults(..., nestingDepth)` → `executeBuiltinTool` → `toolContext.subagentDepth`）。
   - `subagents.ts` 的 `executeSubAgent` 读取父深度：`depth = parentDepth + 1`，超限立即返回明确错误（前台/后台都拦截，executor 不会被创建）。

2. **结果汇流（确认现有链路，无需改动）**
   - 子子 agent 的最终输出经 `executeToolCall` 的 `toolResultParts` 进入父（子）agent 的 history，随父 agent 的最终回复经 subagents 工具结果返回主模型。链路天然支持，本次未改动。

3. **提示词说明（executor 组装 prompt 处）**
   - 新增中文常量 `SUBAGENT_NESTING_PROMPT_NOTICE`，当本次 run 的 `availableTools` 实际包含 `subagents` 时追加到 systemPrompt 末尾；不包含（如只读白名单 agent）则不追加，避免误导。
   - 文案严格按需求：「你可以使用 subagents 工具派生子 agent 协助工作，但一般不需要——仅当你的代码或输出需要另一个 agent 独立复查，或主模型明确下达指令时才使用。子 agent 的最终结果会汇总到你的输出，并最终返回给主模型。」

4. **防失控**
   - **并发限制**：嵌套 run 与普通 run 走同一个 `subAgentConcurrencyLimiter.acquire/release`（全局 maxConcurrentAgents），无需新信号量。
   - **级联清理**：`SubAgentRunController` 新增父子登记表（`registerChild` / `unregisterChild` / `getChildren` / `cascadeExitChildren`）。executor 最外层 finally 对派生的子 run 执行 `cascadeExitChildren`（exit 幂等），并在排队被取消的早退路径也摘除父子登记；同时排队等待席位时监听本 run 自己的控制信号，保证父 run 级联退出能唤醒排队中的子 run。
   - **深度元数据**（最小实现）：`run_created` payload 携带 `depth`，`runController` 活跃记录也记录 depth（`getDepth`），Monitor 可按需展示。

5. **todo 排除行为保持不变**
   - 执行期允许列表（`resolveSubAgentAvailableTools.excludeToolNames`）与描述期（`SUBAGENT_EXCLUDED_TOOL_NAMES`）都只移除 `'subagents'`，`todo_write/todo_update` 与 memory 工具仍被排除。
   - 确认放开 `subagents` 不会引入 todo 类问题：subagents 工具不依赖 `conversationId`（General Worker 只依赖 `channelConfigId`，始终注入）；声明走 getter 动态生成，不会递归。

6. **嵌套 run 的会话归属（A-COMM 小改）**
   - 子 agent 内部调用时 `context.conversationId` 为 undefined，但信箱身份 `mailboxConversationId`（主会话 ID）始终存在；`executeSubAgent` 回退使用它，让嵌套 run 的 transcript 持久化、用量归集（`usageIndexAppend`）与 `agent.sendMessage` 寻址都正确归属主会话。
   - 父 runId 从 `context.mailboxRunId` 读取，作为 `SubAgentRequest.parentRunId` 传给 executor 做级联登记。

## 二、修改摘要

### backend/tools/subagents/types.ts
- 新增常量 `MAX_SUBAGENT_NESTING_DEPTH = 2`。
- `SubAgentRequest` 新增 `depth?: number`、`parentRunId?: string`。

### backend/tools/subagents/runController.ts
- `ActiveRunRecord` 增加 `depth?`；`register(runId, agentName?, depth?)` 记录深度；新增 `getDepth(runId)`。
- 新增父子关系表与 API：`registerChild` / `unregisterChild` / `getChildren` / `cascadeExitChildren`（幂等，逐个 `exit` 并清空关系表）。

### backend/tools/subagents/executor.ts
- `resolveSubAgentAvailableTools`：`excludeToolNames` 移除 `'subagents'`（todo/memory 保留）。
- 新增中文提示词常量 `SUBAGENT_NESTING_PROMPT_NOTICE`；systemPrompt 在工具集含 subagents 时追加。
- `executeToolCall` 新增 `nestingDepth?` 参数并透传给 `executeFunctionCallsWithResults`。
- `createDefaultExecutor`：
  - 从 request 计算 `depth`（缺省 0）；`createRun` payload 与 `runController.register` 携带 depth。
  - `parentRunId` 存在时 `registerChild`；排队取消早退路径与最外层 finally 都摘除/级联清理（`cascadeExitChildren` + `unregisterChild`）。
  - 排队 acquire 使用「父 abortSignal + 本 run 控制信号」组合信号，父级联退出可唤醒排队子 run。

### backend/tools/subagents/subagents.ts
- `SUBAGENT_EXCLUDED_TOOL_NAMES` 移除 `'subagents'`（描述期工具列表恢复显示 subagents；todo/memory 仍排除）。
- `executeSubAgent`：
  - 读取 `context.subagentDepth` 计算 `depth`，`depth > MAX_SUBAGENT_NESTING_DEPTH` 时返回明确错误（前台/后台均拦截）。
  - `parentRunId = context.mailboxRunId`；`conversationId` 回退 `mailboxConversationId`。
  - 前台与后台 executor 请求均携带 `depth` / `parentRunId` / 回退后的 `conversationId`。

### backend/tools/subagents/index.ts
- 导出 `MAX_SUBAGENT_NESTING_DEPTH`。

### backend/modules/api/chat/services/ToolExecutionService.ts（最小改动）
- `executeFunctionCalls` / `executeFunctionCallsWithResults` / `executeFunctionCallsWithProgress` / `runSingleToolCall` / `executeBuiltinTool` 增加可选 `nestingDepth?: number` 参数（追加在末尾，主会话调用不受影响）；`executeBuiltinTool` 将其注入 `toolContext.subagentDepth`。

### 测试（backend/__tests__/tools/）
- 新增 `subagentNesting.test.ts`（handler / runController 层，10 例）：
  - 工具描述包含 subagents、不含 todo/memory；
  - 主模型派发 depth=1 / 子 agent 派发 depth=2 / 超限拒绝（含后台模式不注册任务）/ 边界合法；
  - conversationId 回退 mailboxConversationId；
  - runController 父子登记、摘除、级联退出、getDepth。
- 新增 `subagentNestingExecutor.test.ts`（executor 层，5 例）：
  - `excludeToolNames` 不含 subagents、含 todo/memory；
  - 工具集含 subagents 时 systemPrompt 追加中文说明；不含时不追加；
  - depth/parentRunId 生效：深度记录、父子登记、run_created payload 深度、结束后摘除；depth 缺省按 0。

## 三、验证结果

- 新增测试：`subagentNesting.test.ts` + `subagentNestingExecutor.test.ts` 共 **15/15 通过**。
- 相关既有测试（subagentsTool、subagentRegistry、agentMailbox、agentSendMessage、subagentConcurrencyLimiter、subagentExecutorContinuation/Termination/Usage、subagentRunController、subagentRunEventBus、subagentFileLockConflict 等）：**107/107 通过**。
- backend/__tests__/tools + api 全量：**34 suites / 385 tests 全部通过**；channel 回归：**12 suites / 123 tests 全部通过**。
- `npx tsc -p ./ --noEmit`：改动文件无类型错误；全量仅剩 `backend/modules/settings/` 的**既有**错误（generalTypes.ts 缺失 DEFAULT_* 常量、toolsTypes.ts 缺失各 *Types 模块——属于其他批次进行中的工作，与本批次无关）。

## 四、备注

- `agentMailbox.ts` 本身未改动；嵌套 run 的消息归属通过 `executeSubAgent` 的 `conversationId` 回退（mailboxConversationId）解决，已在本报告注明。
- 未触碰：CHANGELOG.md、规划文档、checkpoint/conversation 模块、frontend/webview。
