# FIX-C：前端错误码与重试路径修复（批次 FIX-C）

日期：2026-06（R3 复审确认的 4 项问题）

## 背景

R3 复审确认了 4 项前端错误码 / 重试路径问题：

1. 【高】`messageActions.ts` 的 `RETRYABLE_ERROR_CODES` 只含 `{STREAM_ERROR, RETRY_ERROR, EDIT_RETRY_ERROR}`，
   但后端流式错误 chunk 的实际 code 来自 `backend/modules/channel/types.ts` 的
   `ChannelError.type`（CONFIG_ERROR/NETWORK_ERROR/API_ERROR/PARSE_ERROR/VALIDATION_ERROR/TIMEOUT_ERROR/CANCELLED_ERROR）
   或 `UNKNOWN_ERROR`——真实流式失败（余额不足/断网/5xx）后错误条不显示“重试”、
   `retryAfterError` 守卫直接 return，是 B7 引入的功能回归。
2. 【中】`retryFromMessage` 中 `deleteMessage` 的 `sendToExtension` **抛异常**路径只 console.error 后继续重试，
   与 `resp.success=false` 路径行为不一致（本地已截断窗口而后端历史未删，继续 retryStream 造成前后端错位）。
3. 【中】`editAndRetry` IPC 失败不回滚本地（本地已截断窗口并改写目标消息内容，后端历史未变）。
4. 【中】`retryAfterError` 防御性 `deleteMessage` await 后缺会话归属校验。

## 修改摘要

### 1. frontend/src/stores/chat/messageActions.ts

- **FIX-C-1（高）**：`RETRYABLE_ERROR_CODES` 并入后端可重试错误码：
  `API_ERROR` / `NETWORK_ERROR` / `TIMEOUT_ERROR` / `PARSE_ERROR`。
  保持不可重试语义不变：`CANCELLED_ERROR`（用户主动取消）、`CONFIG_ERROR` / `VALIDATION_ERROR`
  （配置/参数问题，重试无意义）、`UNKNOWN_ERROR`（语义不明，保守不重试）、以及恢复类
  `RESTORE_*`（H-3 成果不回退）均不在集合内。错误条“重试”按钮（`MessageList.vue` 通过
  `isRetryableError` 判断）与 `retryAfterError` 守卫自动恢复对真实流式错误的可重试性。
  采用复审推荐的方案①（并入集合），未改动 `streamChunkHandlers.handleError` 的归一化逻辑。

- **FIX-C-2（中）**：`retryFromMessage` 的 `deleteMessage` 抛异常路径与 `resp.success=false` 同等对待：
  新增模块内辅助函数 `recoverAfterDeleteFailure(state, originConvId)`（重载最后一页
  `conversation.getMessagesPaged` + `loadCheckpoints` + 复位流式状态 + `isLoading=false`），
  两个失败分支统一调用并 `return`，不再带着错位状态继续 `retryStream`。
  同时通过 `safeSetError` 写入 `DELETE_ERROR` 错误条，用户可知重试未生效。

- **FIX-C-3（中）**：`editAndRetry` 的 catch 中仿照 `checkpointActions.restoreAndEdit` 的 M-9：
  会话未切换（`validateSessionIdentity`）时 `loadHistory` + `loadCheckpoints` 恢复前后端一致。
  结论：`EDIT_RETRY_ERROR` 失败后仍可重试是**安全**的——重载后本地窗口与后端历史一致，
  错误条“重试”走 `retryAfterError → retryStream`，基于真实后端历史重新生成最后一条助手消息；
  若后端未应用编辑，重试的是旧内容（用户可再编辑），不会产生幽灵/重复消息。

- **FIX-C-4（中）**：`retryAfterError` 防御性 `deleteMessage` await 之后追加
  `if (!validateSessionIdentity(state, originConvId)) return`，await 期间会话切换则中止后续写操作
  （清错误/建占位/retryStream 都不落到新会话）。

- 新增导入：`loadHistory`（自 conversationActions）。

### 2. frontend/src/utils/vscode.ts

- **FIX-C-2 配套**：`deleteMessage` 加入 `UNBOUNDED_REQUEST_TYPES`（评估结论：加入）。
  理由：`deleteMessage` 可能在后端互斥锁内等待其他回合收尾而超过 180s 兜底超时；
  超时会误判删除失败并触发前端重载/中止重试路径，而删除实际已生效，造成窗口与历史错位。
  与 `checkpoint.deleteBatch` 等后端互斥操作的既有处理一致。

### 3. frontend/src/components/message/MessageList.vue

- 未改动（错误条通过 `isRetryableError(chatStore.error)` 展示重试按钮，FIX-C-1 后自动覆盖后端错误码；
  错误码展示 `{{ code }}: {{ message }}` 无需调整）。

### 4. frontend/src/stores/chat/streamChunkHandlers.ts

- 未改动（采用方案①，无需归一化）。

### 5. frontend/src/__tests__/stores/streamErrorRetry.test.ts（补测试）

- 新增 `vi.mock('../../stores/chat/conversationActions', ...)`（`importActual` 展开 + 
  `loadHistory`/`loadCheckpoints` 打桩），并导出断言。
- `createState` 补充 `openTabs` / `sessionSnapshots`（safeSetError 跨会话分支需要）。
- 新增测试（8 个）：
  - FIX-C-1：`API_ERROR`/`NETWORK_ERROR`/`TIMEOUT_ERROR`/`PARSE_ERROR` 可重试；
    `CANCELLED_ERROR`/`CONFIG_ERROR`/`VALIDATION_ERROR`/`UNKNOWN_ERROR` 不可重试；
    `handleError` 写入 `API_ERROR` 后错误条可重试（B7 回归端到端）。
  - FIX-C-2：`deleteMessage` 抛异常时中止重试——重载最后一页 + `loadCheckpoints` + 复位流式状态、
    不发起 `retryStream`、错误码 `DELETE_ERROR`；`resp.success=false` 同样中止（原语义保持）。
  - FIX-C-3：`editAndRetryStream` 抛异常时错误码 `EDIT_RETRY_ERROR` + `loadHistory`/`loadCheckpoints`
    被调用、窗口恢复后端一致状态；会话已切换时不重载。
  - FIX-C-4：`retryAfterError` 防御性 `deleteMessage` await 期间会话切换则中止重试
    （不建占位、不发 `retryStream`、流式状态不复位）。
  - 既有 H-3 测试（`RESTORE_*` 不可重试等）保持不变且继续通过。

## 验证结果

- `npm --prefix frontend run typecheck`（vue-tsc --noEmit）：**通过**，无错误。
- `npm --prefix frontend test`（vitest run，全量 17 个文件 / 188 个测试）：**全部通过（188/188）**，
  多次重复运行稳定通过。
- 说明：首次全量运行时曾出现 6 个失败（CheckpointSettings M-4、MessageItem R3-#5、
  checkpointActions R3-#13/summarizeContext），系与 typecheck 并行执行造成 CPU 争用、
  fake-timer/轮询类测试抖动所致；串行执行后连续 4 轮全量均为 188/188 通过，
  且这些失败均位于其他批次（CheckpointSettings/MessageItem/checkpointActions）未提交的进行中改动，
  与本批次文件无关。

## 边界遵守

- 仅修改批次内文件：`frontend/src/stores/chat/messageActions.ts`、`frontend/src/utils/vscode.ts`、
  `frontend/src/__tests__/stores/streamErrorRetry.test.ts`（`streamChunkHandlers.ts` 与
  `MessageList.vue` 评估后无需改动）。
- 未修改 `CHANGELOG.md`、规划文档、`checkpointActions`/`conversationActions`/CheckpointSettings composables、
  backend。
