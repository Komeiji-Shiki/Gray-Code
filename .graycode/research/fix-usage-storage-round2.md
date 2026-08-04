# FIX-A：用量统计与历史存储复审修复（round 2）

> 复审来源：R2 复审问题清单（对话中确认，无独立文件）。批次：FIX-A。
> 状态：已完成。涉及文件严格限定在复审指定的 5 个模块 + conversation 测试目录。

## 修改摘要

### 【高】1.1 UsageIndexStore 全量重建写回丢 main 条目（队列外读历史 → write 覆盖并发落盘）

**根因**：调用方（`ConversationManager.updateUsageIndex` / `usageStats` 重建）在 store 队列外
读历史 H0 / 旧索引，期间并发到达的 main 条目（`appendUsage`）被 `write(rebuilt)` 静默覆盖；
`writeLocked` 的 `mergeSubagentEntries` 只按条目键合并 subagent 条目，无法补回 main 条目。

**修复**（采用"把调用方的读旧索引/读历史移入队列内执行"方案）：

- `UsageIndexStore.ts`：新增 `rebuild(conversationId, build)` —— 在会话级写队列内执行
  「读当前盘面索引 → `build(previous)` → 合并盘面 subagent 条目（按键去重兜底）→ 原子落盘」，
  返回落盘索引。`build` 回调收到的是队列内最新盘面。
- `usageStats.ts`：
  - `UsageIndexStore` 接口新增可选 `rebuild?`。
  - 新增 `rebuildIndexForConversation`：优先走 `store.rebuild`，回调在队列内**重读最新历史**
    （`getMessagesRaw` 优先，与 `loadOne` 同一偏好）再 `buildConversationUsageIndex`，
    保证并发落盘的 main 条目不丢；无 `rebuild` 的 store 保留原有读改写兜底。
  - 重建时机从主循环移到 `loadWithCache`（重建结果回填 `loaded.index`，主循环按索引路径聚合，
    含 subagent 与 `subagentTokens` 细分）；重建失败本次走历史路径，下次再试。
- `ConversationManager.updateUsageIndex`：优先走 `usageIndexStore.rebuild`（`history` 为
  会话写锁内刚落盘的最新历史，main 条目直接由其重建；subagent 条目从队列内最新盘面合并）；
  无 `rebuild` 的 store 保留原兜底。

### 【中】1.2 enqueueWrite 无挂起超时

- `storage.ts`：`withHangTimeout` 由私有改为 `export`（供复用）。
- `UsageIndexStore.ts`：`enqueueWrite` 对每个任务套用 `withHangTimeout`（60s，label
  `usageIndexWrite({conversationId})`）；超时按失败处理（调用方静默降级），队列链继续前进、
  Map 条目随之回收，不再永久阻塞该会话后续写入。

### 【中】2.1 usageStats 重建路径回填缓存不含 subagent 合并条目

**根因**：`loadWithCache` 的 `cache.set` 用重建前的明细回填，subagent 合并发生在主循环更后面，
缓存里缺 subagent 条目 → 后续缓存命中轮次统计波动。

**修复**：重建移到 `loadWithCache` 内完成后，`cache.set` 使用 `loaded.index.messages`
（已含队列内合并的 subagent 条目）回填；历史路径兜底仍用 `buildConversationUsageIndex` 提取。

### 【中】3.1 双 rename 窗口"新段+旧 index"静默错读

**根因**：`writeSegmentedHistory` 先 rename 目录再 rename index，读侧可能读到"新段文件 +
旧 index"；`validateIndexConsistency` 只校验 index 自身（旧 index 完全自洽），无法发现段文件
已被换掉，返回被截断/错位的混合历史。

**修复**（`storage.ts`）：`loadSegmentedHistory` 与 `loadSegmentedHistoryPage` 在段文件读取
完成后调用新增的 `verifyIndexUnchanged` —— 重读一次 index，与读取前解析的版本比对
`totalMessages` 与段标识（file/startIndex/endIndex/count 逐一比对，`sameIndexVersion`）；
不一致按可重试错误（`segment_missing`）返回，外层重试后读到一致状态；持续不一致时
重试耗尽后如实报 `segment_missing`，不再静默返回错位历史。

### 【中】3.2 删除复活短路竞态

**根因**：`appendContents` 的 `assertNotDeleted` 在 storage 入队前检查，`deleteConversation`
不入会话写锁，可滑入「断言未删 → 读尾 → 入队 storage 写」的异步窗口：deleteHistory 先入队、
append 的写随后入队 → 删除后新写重新创建历史目录（幽灵会话）。

**修复**（`ConversationManager.deleteConversation`）：`storage.deleteHistory` 整体放入
`withConversationWriteLock` 与 append/mutate 串行 —— 在途 append 先完成（其 storage 写在
delete 之前入队），删除后新发起的 append 在锁内被 `assertNotDeleted` 短路；删除失败仍撤销
已删除标记。锁外清理（索引/快照/diff/branch）保持原样，无死锁（deleteConversation 无其他
持锁调用方，branch 清理不取会话锁）。

### 【中】4.1 rejectToolCalls 锁外 get + 锁内 replace 不原子

**根因**：`rejectToolCalls` 先 `repository.getContents()`（锁外）再 `replaceContents`（锁内），
并发写入会被基于旧快照的整体写回覆盖。

**修复**：整体包进 `repository.mutateContents`（仓储互斥执行器内 get→修改→replace 串行，
与 `rejectAllPendingToolCalls` / `settleFunctionResponses` 一致）；无变更返回原引用跳过写回，
有变更返回新引用触发写回；`messageIndex` 越界仍在锁内抛出；`modified` 标志与
`invalidateContextManagementState` 语义保持不变。

### 【低】3.3 读侧重试对"双格式都不存在"的会话也重试 2 次

**根因**：`isRetryableReadError` 把 `not_found` 一律视为写提交窗口，已删除/不存在的会话
空转 2 次退避重试（每次还附带 2 次 stat）。

**修复**（`storage.ts`）：`loadHistoryWithStatus` / `loadHistoryPage` 在 `not_found` 时
调用新增的 `historyExistsAnyFormat`（index 与 legacy 双 stat）；双格式都不存在 ⇒ 会话确实
不存在，直接返回不重试；index 在但段缺失等真实提交窗口错误仍按原逻辑重试。正常路径
（有 index/legacy）零额外开销（仅在出现 not_found 时才做存在性检查）。

## 新增测试（backend/__tests__/conversation/）

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `UsageIndexStore.test.ts` | rebuild 在队列内原子执行：与并发子代理归集不互覆、不丢条目 | 1.1 |
| `UsageIndexStore.test.ts` | 写队列挂起超时：任务超时按失败处理，队列继续前进、Map 回收 | 1.2 |
| `usageStats.test.ts` | 重建回调在队列内重读最新历史：并发落盘的 main 条目不被重建覆盖 | 1.1 |
| `usageStats.test.ts` | 重建路径缓存回填包含 subagent 合并条目（二次缓存命中仍计入） | 2.1 |
| `storageReadConsistency.test.ts` | 段读取后 index 变为新版本：复核拦截 → 重试读到一致新状态（含分页路径） | 3.1 |
| `storageReadConsistency.test.ts` | 复核始终不一致：重试耗尽报 segment_missing | 3.1 |
| `storageReadConsistency.test.ts` | legacy+segmented 双缺失只尝试一次；index 在但段缺失仍重试 | 3.3 |
| `conversationDeleteRace.test.ts` | append 在 storage 入队窗口内 delete：会话写锁串行，无幽灵会话 | 3.2 |
| `ConversationManager.rejectToolCalls.test.ts`（新文件） | 并发 rejectToolCalls 互不覆盖；写回期间并发追加不被覆盖；越界在锁内抛出不写回 | 4.1 |

## 验证结果

- `npx jest --config jest.backend.config.js backend/__tests__/conversation/`：**23 suites / 277 tests 全部通过**（改动前 21 suites / 250 tests；新增 27 个用例）。
- `npx jest --config jest.backend.config.js`（全量后端回归）：**124 suites / 1275 tests 全部通过**（worker 退出警告为既有测试句柄泄漏，与本批次无关）。
- `npx tsc -p tsconfig.json --noEmit`（改动模块）：通过，0 错误。
- `npx tsc -p tsconfig.test.json --noEmit`（含改动测试）：通过，0 错误。

## 文件边界合规

仅改动：
- `backend/modules/conversation/UsageIndexStore.ts`
- `backend/modules/conversation/usageStats.ts`
- `backend/modules/conversation/storage.ts`
- `backend/modules/conversation/ConversationManager.ts`（仅 updateUsageIndex / deleteConversation / rejectToolCalls）
- `backend/__tests__/conversation/`（新增/修改测试）

未触碰 CHANGELOG.md、规划文档及其它模块（ToolExecutionService/helpers/agentMailbox/frontend/webview/checkpoint/settings/subagents）。
