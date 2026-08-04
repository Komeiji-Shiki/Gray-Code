# Agent 间消息通信（A-COMM）— 设计说明 / 修改摘要 / 验证结果

> 批次：A-COMM（agent 间消息通信）
> 范围：backend 端 mailbox + `agent.sendMessage` 工具 + 工具循环注入点；不含 frontend / CHANGELOG / 规划文档 / checkpoint / conversation 模块。

## 一、设计说明

### 1.1 目标形态

- 子代理之间、子代理 → 主模型可以互相发消息；
- **注入时机**：收件方最近一次工具调用结束后，消息插入在工具调用后面、与工具结果一起返回给模型（不等整轮流式结束）；
- 主模型也可作为收件人（子代理给主模型发消息）；主模型的工具循环同样接入（inbox 按主会话 conversationId 挂载）。

### 1.2 消息存储（inbox，内存版）

新模块 `backend/tools/subagents/agentMailbox.ts`：

- 数据结构：`Map<conversationId, Map<runId, AgentMessage[]>>`；
  - `AgentMessage = { id, threadId, fromRunId, fromAgentName?, toRunId, text, hopDepth, createdAt }`；
  - 另有两张辅助表：`knownRuns`（conversationId → runId → { runId, agentName, registeredAt }，用于"同一对话下已知 runId"的权限校验与按名寻址）、`threadDepths`（conversationId → threadId → 最近 hopDepth，用于防循环）。
- 纯内存，不持久化；run 结束/取消时 `unregisterRun` 清理该 run 的 inbox 与已知记录；提供 `clearConversation` 供对话删除时清理。

### 1.3 新工具 `agent.sendMessage`

- 参数：`targetRunId?` / `targetAgentName?`（二选一）+ `message`（必填）+ `threadId?`；
- **权限（防冒充/注入）**：
  - 必须携带 conversationId（会话限定，优先取执行层注入的 `mailboxConversationId`，主会话回退到 `conversationId`）；
  - 发送方身份由工具执行层注入（`ToolContext.mailboxRunId`），模型无法伪造；
  - 按 `targetRunId` 寻址：只能是本对话下已知的 runId（子代理 run 启动时 `registerRun`），或主会话保留 runId `__main__`；
  - 按 `targetAgentName` 寻址：限定在本对话内解析；`"main"` → 主会话；同名多 run 并行时投给最近注册的 run；未知名称返回明确错误；
- **threadId + hopDepth 防循环**：同一线程回复 hopDepth 递增，超过 `MAX_HOP_DEPTH = 5` 拒绝投递并返回明确错误（提示开启新线程或停止回复）；不带 threadId 自动新建线程（depth=1）；
- 工具已注册进 ToolRegistry（通过 `subagents/index.ts` 的 `getSubAgentsToolRegistrations()`，随 `getAllTools` 注册），子代理可用工具列表**不排除**该工具（`SUBAGENT_EXCLUDED_TOOL_NAMES` 未包含它）。

### 1.4 注入点（核心）

位置：`ToolExecutionService.executeFunctionCallsWithProgress`（工具结果组装处），新增私有方法 `injectInboxMessages(mailboxConversationId, mailboxRunId, responseParts, toolResults)`，在**每次工具调用完成之后**（含并行批内每个工具、串行、参数错误/策略拒绝路径）调用：

- 从 `agentMailbox.drainMessages(conversationId, runId)` 取走当前 run 的 inbox（drain 一次性语义，每条只投递一次）；
- 追加到**最近一次工具结果**之后：
  - 模型可见：`functionResponse.response.agentInbox = [{ fromRunId, fromAgentName?, text, threadId, hopDepth, createdAt }]`（顶层 + `data` 子对象同时注入，覆盖 formatter 的 JSON/文本两条序列化路径）；
  - 前端可见：`toolResult.result.agentInbox` 同步注入；
- 未传 mailbox 身份或 inbox 为空时零开销直接返回，**不改变既有行为**（不新增 history 消息、不新增 orphan functionResponse part——避免 OpenAI/Anthropic function_call 模式的 tool_result 配对问题与 text part 被 formatter 丢弃的问题）。

调用链改动（最小侵入，全部为末尾新增可选参数）：

| 调用方 | 位置 | 传入 |
|---|---|---|
| `ToolIterationLoopService.runToolLoop`（流式早执行） | `executeFunctionCallsWithResults` | `conversationId, MAIN_SESSION_RUN_ID` |
| `ToolIterationLoopService.runToolLoop`（流式进度） | `executeFunctionCallsWithProgress` | `conversationId, MAIN_SESSION_RUN_ID` |
| `ToolIterationLoopService.runNonStreamLoop` | `executeFunctionCallsWithResults` | `conversationId, MAIN_SESSION_RUN_ID` |
| `ChatFlowService`（确认后执行/自动续执行） | `executeFunctionCallsWithProgress` × 2 | `conversationId, MAIN_SESSION_RUN_ID` |
| `subagents/executor.executeToolCall`（子代理工具） | `executeFunctionCallsWithResults` | `currentConversationId, actualRunId` |

主会话信箱 = `(conversationId, '__main__')`；子代理信箱 = `(主会话 conversationId, runId)`。子代理执行路径的 `conversationId` 参数保持 `undefined` 不变（避免子代理工具意外获得主会话 conversationId 改变既有工具行为），信箱会话通过独立参数注入。

### 1.5 注册与清理

- 子代理 run 真正启动（信号量 acquire 成功、`run_started` 事件后）即 `agentMailbox.registerRun(currentConversationId, runId, config.name)`；
- 最外层 `finally`（覆盖成功/失败/取消/超时/异常所有退出路径）`agentMailbox.unregisterRun(currentConversationId, runId)`；
- 排队被取消、接续校验失败等未真正启动的早退路径不会注册（无残留）；
- 对话删除清理：`agentMailbox.clearConversation(conversationId)` 已实现；**接线到 `ConversationManager.deleteConversation` 需改 conversation 模块（BR-01/02 批次保留），v1 未接**（见"已知限制"）。

## 二、修改摘要

### 新增文件

| 文件 | 内容 |
|---|---|
| `backend/tools/subagents/agentMailbox.ts` | `AgentMailbox` 类 + 全局单例 `agentMailbox`；`MAIN_SESSION_RUN_ID='__main__'`、`MAIN_AGENT_NAME='main'`、`MAX_HOP_DEPTH=5`；registerRun/unregisterRun/sendMessage/drainMessages/peekMessages/isKnownRun/getAgentName/getKnownRuns/clearConversation/clearAll |
| `backend/tools/subagents/agentSendMessage.ts` | `agent.sendMessage` 工具声明（category `agents`，`message` 必填）+ handler（身份/会话由执行层注入）+ 单例工具工厂 |
| `backend/__tests__/tools/agentMailbox.test.ts` | 信箱单元测试（投递/drain 一次性/权限/跨会话隔离/按名寻址/深度上限/清理） |
| `backend/__tests__/tools/agentSendMessage.test.ts` | 工具声明与注册、handler 成功/失败、注入点测试（工具结果携带 agentInbox、drain 一次性、主会话信箱、并行批、无 mailbox 身份不注入、toolContext 注入） |

### 修改文件

| 文件 | 改动 |
|---|---|
| `backend/modules/api/chat/services/ToolExecutionService.ts` | 三个入口方法末尾新增 `mailboxConversationId?/mailboxRunId?`；透传到 `runSingleToolCall`/`executeBuiltinTool`；`toolContext` 注入 `mailboxConversationId`/`mailboxRunId`；4 处工具完成后调用 `injectInboxMessages`；新增该私有方法 |
| `backend/modules/api/chat/services/ToolIterationLoopService.ts` | 3 处 `executeFunctionCalls*` 调用追加主会话信箱参数；import `MAIN_SESSION_RUN_ID` |
| `backend/modules/api/chat/services/ChatFlowService.ts` | 2 处 `executeFunctionCallsWithProgress` 调用追加主会话信箱参数；import `MAIN_SESSION_RUN_ID` |
| `backend/tools/subagents/executor.ts` | run 启动后 `registerRun`、外层 finally `unregisterRun`；`executeToolCall` 新增 `mailboxConversationId` 参数并透传到 `executeFunctionCallsWithResults`（信箱 runId = actualRunId） |
| `backend/tools/subagents/index.ts` | 导出 mailbox 与 `agent.sendMessage` 模块；`getAllSubAgentsTools`/`getSubAgentsToolRegistrations` 加入新工具（随 ToolRegistry 全局注册） |

未触碰：`CHANGELOG.md`、规划文档、`backend/modules/conversation/*`、`backend/modules/checkpoint/*`、frontend/webview。

## 三、验证结果

- 新增测试：`agentMailbox.test.ts`（18 用例）+ `agentSendMessage.test.ts`（16 用例）= **34 通过**；
- 相关既有测试：`backend/__tests__/tools` 全部（29 个文件）+ `backend/__tests__/api`（2）+ `backend/__tests__/channel`（12）＝ **43 套 / 485 用例通过**（含 subagents 全部、toolBatchCheckpoint、repeatedCallGuard、toolRegistryAliases、formatter 系列）；
- 全量后端：`npx jest --config jest.backend.config.js` → **114 套 / 1143 用例全部通过**；
- 前端竞态防护：`frontend/src/__tests__/stores/streamErrorRetry.test.ts`（17）+ `chatRaceCondition.test.ts`（26）＝ **43 通过**（未改前端，确认无回归）；
- 类型检查：`npx tsc -p ./ --noEmit` → **0 错误**。

## 四、二期方案（未实现）

### 4.1 用户消息插入（流式/工具循环进行中）

- 方案：新增后端入口（如 `chat/userInboxMessage` 命令）调用 `agentMailbox.sendMessage({ conversationId, fromRunId: MAIN_SESSION_RUN_ID, fromAgentName: 'user', targetRunId: MAIN_SESSION_RUN_ID, text, threadId? })`；主会话注入点（已接入）会在下一次工具调用完成后把用户消息随工具结果带出；
- 前提/风险：需要前端在 `chatStore.sendMessage → chatStream` 进行中检测"非停止语义的新用户输入"，走新命令而非停止当前流；需与现有发送竞态防护（streamErrorRetry / chatRaceCondition）协同；用户消息若在模型无工具调用的纯文本回合到达，需追加"模型无工具循环时消息保留到下一轮"的兜底（inbox 已天然保留，仅需决定何时消费）。
- 结论：涉及前端管道改动，本批次不做，按主人要求列为二期。

### 4.2 对话删除清理接线

- `AgentMailbox.clearConversation` 已就绪；在 `ConversationManager.deleteConversation`（conversation 模块）末尾加一行 `agentMailbox.clearConversation(conversationId)` 即可，交由 BR-01/02 批次（该模块当前保留）接线。

## 五、已知限制

1. **序列化覆盖**：注入的 `agentInbox` 字段在 OpenAI/Anthropic function_call 模式下随 `serializeToolResultForLLM` 透出；对"含大段文本的批量结果（如 read_file 多文件）"与纯错误分支，formatter 只摘取部分字段，`agentInbox` 可能不显示——此时消息保留到下一次工具调用（drain 未消费）或 run 结束清理；
2. **错误/拒绝路径**：参数错误/策略拒绝的工具结果也会携带 inbox 消息（已注入），但若循环随后结束且无更多工具调用，未投递消息在 run 结束时清理；
3. **无持久化**：消息仅在内存；主会话无工具循环期间到达的消息保留到下一次工具调用或对话清理；
4. **仅默认 executor 接入**：自定义 executor 若不经过 `ToolExecutionService` 则无注入；信箱 API 对其可用但需自行 drain。
