# 用户消息插入（U1）— 设计说明 / 修改摘要 / 验证结果

> 批次：U1（用户消息插入，A-COMM 二期）
> 范围：backend mailbox 用户入口 + `chat.sendInterruptMessage` IPC handler + 前端 `sendMessage` 忙时分支 + i18n（后端 webview.errors / 前端 chat.input）+ 测试。不碰 CHANGELOG / 规划文档 / checkpoint / conversation 模块 / components 组件文件。

## 一、设计说明

### 1.1 目标形态

主会话正在工具循环/流式中时，用户发消息不再排队等整轮结束，而是**插入到主会话最新一次工具调用之后**：前端把文本投递到主会话 inbox（`(conversationId, '__main__')`），由 A-COMM 已接线的 `ToolExecutionService.injectInboxMessages` 在最近一次工具调用完成后把消息追加到工具结果之后、随工具结果返回给主模型——主模型在工具循环中尽快感知用户输入。

保持最小语义：**仅投递**。不创建历史消息、不触发新的流式回合；用户消息是否落入历史由模型回复时决定（模型看到 inbox 内容后自行继续/总结，回复自然落入历史）。

### 1.2 后端：mailbox 用户入口（`backend/tools/subagents/agentMailbox.ts`）

复用 A-COMM 的 `AgentMailbox`，新增主会话收件方法（未改任何既有 API/签名，F2 批次在动的 executor/工具声明零接触）：

- `sendUserMessageToMain(conversationId, text)`：
  - 发送方固定 `fromRunId = MAIN_SESSION_RUN_ID ('__main__')`，`fromAgentName = 'user'`（模型侧识别为“用户”）；
  - 收件方固定 `targetRunId = MAIN_SESSION_RUN_ID`——即主会话 inbox，key 为 conversationId；
  - 每次插入不传 threadId → 自动新建线程（hopDepth=1），不存在 agent 互回循环负担；
  - **频率限制**：`USER_INTERRUPT_MIN_INTERVAL_MS = 10_000`（每会话 10 秒最多 1 条，防刷屏），超过返回 `RATE_LIMITED`；
  - **长度限制**：`USER_INTERRUPT_MAX_LENGTH = 4000`，超过返回 `TEXT_TOO_LONG`；
  - 入参校验：缺会话 → `INVALID_CONVERSATION`、空文本 → `EMPTY_TEXT`；
  - 会话是否**存在**由 handler 校验（信箱是纯内存，不感知持久化会话）；
  - 频率记录随 `clearConversation` / `clearAll` 一起清理（无残留）。

### 1.3 新 IPC handler：`chat.sendInterruptMessage`（`webview/handlers/ChatHandlers.ts`）

- 入参 `{ conversationId, text }`；校验顺序：会话 ID 非空 → 文本非空 → `conversationManager.getMetadata(conversationId)` 存在（只读，不写历史）→ `agentMailbox.sendUserMessageToMain`；
- 成功返回 `{ success: true }`；失败返回明确错误码：
  `INTERRUPT_MESSAGE_INVALID_CONVERSATION` / `INTERRUPT_MESSAGE_EMPTY_TEXT` / `INTERRUPT_MESSAGE_CONVERSATION_NOT_FOUND` / `INTERRUPT_MESSAGE_RATE_LIMITED` / `INTERRUPT_MESSAGE_TEXT_TOO_LONG` / `INTERRUPT_MESSAGE_ERROR`（兜底）；
- 注册进既有 `registerChatHandlers`（`chat.sendInterruptMessage`），走非流式注册表路由，与 `chatStream` 流式路径完全分离；
- 后端 i18n 新增 `webview.errors.interruptMessage*` 五条（zh-CN / en / ja）。

### 1.4 前端投递（`frontend/src/stores/chat/messageActions.ts`）

`sendMessage` 入口新增 U1 分支（插在 `isWaitingForResponse` 早退之前）：

- 条件：`!isHiddenSend && (state.isStreaming || state.isWaitingForResponse)`；
- 走 `deliverInterruptMessage`：**不排队、不乐观插入窗口、不创建 assistant 占位、不改流式状态、不触发 chatStream**；`sendToExtension('chat.sendInterruptMessage', { conversationId, text })`；
- 边界（均回退既有语义，返回 false，不打断进行中的回合）：
  - 隐藏发送（计划确认等 `hidden.functionResponse`）→ 保持原路径；
  - 带附件 → 附件无法随 inbox 文本投递，返回 false（调用方维持队列语义）；
  - 文本超 4000 / 无当前会话 / 后端拒绝（频率限制等）→ 返回 false，仅 console.warn，不落错误条；
- 空闲时保持原 `chatStream` 发送路径（行为零变化）。
- 轻提示：i18n 新增 `chat.input.interruptDelivered`（zh-CN / en / ja）——“已插入到当前回合”文案；组件渲染接线交由 components 批次（本批次不碰 components）。

### 1.5 与既有竞态防护的关系

- 忙时分支**不修改** `isStreaming / isWaitingForResponse / activeStreamId / streamingMessageId`，不触碰流式 chunk 处理链，`streamErrorRetry` / `chatRaceCondition` 语义不受影响；
- 不创建历史消息 → 不触碰后端历史索引，`conversation getMessagesPaged / checkpoints` 无感知；
- 投递失败静默回退 → 不会产生半截消息 / 幽灵消息。

## 二、修改摘要

### 新增文件

| 文件 | 内容 |
|---|---|
| `backend/__tests__/tools/userMessageInterrupt.test.ts` | mailbox 用户入口单测：投递成功（inbox 可见、fromAgentName=user、hopDepth=1）、缺会话/空文本/超长/恰好上限、频率限制（不足拒绝、超过放行）、跨会话隔离、clearConversation 重置 |
| `backend/__tests__/webview/chatInterruptHandler.test.ts` | handler 单测：注册、成功投递、缺会话/空文本/会话不存在/频率限制/超长、getMetadata 异常兜底 |
| `frontend/src/__tests__/stores/userMessageInterrupt.test.ts` | sendMessage 忙时走 interrupt：不乐观插入窗口、不改流式状态、不触发 chatStream；空闲保持 chatStream；隐藏发送/带附件/超长/无会话/后端拒绝边界 |

### 修改文件

| 文件 | 改动 |
|---|---|
| `backend/tools/subagents/agentMailbox.ts` | 新增 `USER_INTERRUPT_MAX_LENGTH=4000`、`USER_INTERRUPT_MIN_INTERVAL_MS=10_000`、`UserInterruptResult` 类型、`sendUserMessageToMain()`、`lastUserInterruptAt` 频率表；`clearConversation`/`clearAll` 同步清理频率表 |
| `webview/handlers/ChatHandlers.ts` | 新增 `sendInterruptMessage` handler 并注册 `chat.sendInterruptMessage` |
| `backend/i18n/langs/{zh-CN,en,ja}.ts` | `webview.errors` 新增 interruptMessage* 五条 |
| `frontend/src/stores/chat/messageActions.ts` | `sendMessage` 忙时 U1 分支 + `deliverInterruptMessage` + `INTERRUPT_MESSAGE_MAX_LENGTH` |
| `frontend/src/i18n/langs/{zh-CN,en,ja}.ts` | `chat.input.interruptDelivered` 提示文案 |

未触碰：`CHANGELOG.md`、规划文档、`backend/modules/conversation/*`、`backend/modules/checkpoint/*`、`frontend/src/components/**`、`backend/tools/subagents/{executor,index,runController,subagents,types}.ts`（F2 批次在动，本批次只动 `agentMailbox.ts`）。

### 批次冲突说明

- `frontend/src/stores/chat/messageActions.ts`、`webview/handlers/ChatHandlers.ts`、三份 i18n 文件在工作区中已被其他批次（checkpoint/conversation/F2/settings）改动过；本批次所有 apply_diff 均基于当前文件状态精确匹配成功，无冲突；
- `backend/modules/settings/toolsTypes.ts` 引用不存在的 `./subAgentsTypes` / `./tokenCountTypes`（settings 拆分批次未完成），导致 `npx tsc -p ./ --noEmit` 报 7 个**既有**错误——与本批次无关，本批次文件零类型错误；
- `frontend/src/__tests__/stores/streamErrorRetry.test.ts` 被其他批次修改过（本批次未改），全量回归通过。

## 三、验证结果

- 新增测试：`userMessageInterrupt.test.ts`（8）+ `chatInterruptHandler.test.ts`（8）+ 前端 `userMessageInterrupt.test.ts`（8）＝ **24 通过**；
- 相关既有测试：`agentMailbox.test.ts`（18）+ `agentSendMessage.test.ts`（16）＝ 34 通过（mailbox 无回归）；
- 前端竞态防护：`streamErrorRetry.test.ts`（17）+ `chatRaceCondition.test.ts`（26）＝ 43 通过（无回归）；
- 前端全量：`npm --prefix frontend test` → **16 套 / 168 用例全部通过**；
- 后端全量：`npx jest --config jest.backend.config.js` → **116 套 / 1159 用例全部通过**（A-COMM 基线 114 套 / 1143 用例 + 本批次 2 套 / 16 用例）；
- 前端类型检查：`npm --prefix frontend run typecheck`（vue-tsc --noEmit）→ **0 错误**；
- 后端类型检查：`npx tsc -p ./ --noEmit` → 仅 7 个**既有** settings 模块错误（另一批次未完成），本批次改动 0 错误。

## 四、已知限制 / 后续

1. **UI 提示接线**：`chat.input.interruptDelivered` 文案已就绪；输入区在忙时调用 `sendMessage` 并渲染提示属于 components 批次（当前 InputArea 忙时仍走队列，组件批次切换后生效）；
2. **无工具循环时**：若消息在模型纯文本生成（无更多工具调用）期间到达，inbox 天然保留到下一次工具调用或 run 结束清理（A-COMM 已知限制 3 的延续）；
3. **频率限制**：每会话 10 秒 1 条为硬限制，超限返回 false（调用方维持队列语义），不做丢弃；
4. **附件**：忙时带附件消息不进插入路径，保持既有队列语义（inbox 为文本通道）。
