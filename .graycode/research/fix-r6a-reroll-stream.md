# R6a-FIX：reroll/editBranch 流式链路复查修复（批次 R6a-FIX）

> 批次：R6a 复查修复（reroll 全链路 + P4a editBranchStream 同步检查）
> 日期：2026-08-04
> 背景：R6a 排查发现 reroll 链路 2 高危 + 2 中危 + 1 低危；P4a 刚完成的 `chat.editBranchStream`（与 reroll 同模式）一并检查修复。
> 对比基准：`StreamRequestHandler.handleRetryStream` 的正确模式（abortManager.create + 传 signal + finally delete + STREAM_MESSAGE_TYPES + fire-and-forget + getClientView 路由）。
> 参考报告：`.graycode/research/tree01-02-reroll.md`（reroll 实现）、`.graycode/research/tree03-05-edit-branch.md`（editBranch 实现）。

---

## 一、问题清单与修复

### 【高 H1】rerollStream / editBranchStream 流完全不可取消

**现状**：`ChatHandlers.ts` 的 `rerollStream` / `editBranchStream` 既未注册 AbortController，也未向 `handleRerollStream` / `handleEditBranchStream` 传 `abortSignal`。点停止 no-op、工具循环无法中止、扩展关闭（cancelAllStreams）无法取消、isActive 恒 false 导致 TREE-13 的 BRANCH_BUSY 互斥覆盖不到 reroll。

**修复**（`webview/handlers/ChatHandlers.ts`，两个 handler 同步）：
- handler 内 `abortManager.create(conversationId)` 注册取消控制器（StreamAbortManager 注入路径；纯 Map 注入路径退化：abort 旧流 + set 新控制器）；
- `abortSignal: controller?.signal` + `summarizeAbortSignal: summarizeController?.signal` 透传（与 retryStream 同模式，createSummary 一并接线）；
- `finally` 中 `abortManager.delete(conversationId, controller)` + `deleteSummary` 统一注销（delete 自带引用校验，不会误删新流控制器）；
- catch 中 `controller.signal.aborted` 时透出 `{ cancelled: true }` 结尾事件（对齐 `StreamRequestHandler.reportCancelled`），不按错误处理；
- 原「先 cancel 旧流」前置逻辑移除（create 内部已 abort 旧流，行为等价且更完整）。

### 【高 H2】rerollStream / editBranchStream 按普通 handler 注册，长流占死 IPC 消息队列

**现状**：`MessageRouter.ts` 的 `STREAM_MESSAGE_TYPES` 无 `chat.rerollStream` / `chat.editBranchStream` → `route()` 串行 await 整个流 → 期间 cancelStream / deleteMessage / switchBranchCandidate / 新消息全部排队。

**修复**（`webview/MessageRouter.ts`）：
- `STREAM_MESSAGE_TYPES` 增加 `'chat.rerollStream'`、`'chat.editBranchStream'`；
- `handleStreamMessage` 增加对应 case，通过新增私有方法 `runRegistryStreamHandler` 以 fire-and-forget 方式调用注册表中的 handler（`createRoutedContext` 注入 clientId 路由；错误就地清理 requestClients 后按 `sendRoutedError` 回传）；
- `handleStreamMessage` 签名补充 `ctx` 参数（route() 调用处同步更新）。

### 【中 M1】startReroll 主历史截断未清理旧检查点

**现状**：`handleRerollStream` 无 `deleteCheckpointsFromIndex` 调用（对照 `handleEditAndRetryStream` 截断前显式调用）→ 截断后旧回合检查点原样保留在相同索引，新候选消息命中旧检查点（索引错位，回档/恢复可能恢复到错误状态）。

**修复**（`backend/modules/api/chat/services/ChatFlowService.ts`）：
- 新增导出纯函数 `resolveRerollTruncateIndex(history, assistantNodeId?)`：与 `BranchService.resolveRerollTarget` 同规则解析目标 model 消息（显式 id 或活跃路径最后一条 model），父节点取目标前最后一个非 functionResponse 的 user 消息，返回截断起始索引（parentIndex + 1）；
- `handleRerollStream` 在 `startReroll` 之前调用 `checkpointService.deleteCheckpointsFromIndex(conversationId, truncateIndex)`（truncateIndex > 0 时）；
- `handleEditBranchStream` 在 3.10 主历史 `deleteMessagesInRange` 之前调用 `deleteCheckpointsFromIndex(conversationId, parentIndex + 1)`（与 editAndRetry 对齐）。

### 【中 M2】finishReroll 错误被吞

**现状**：`handleRerollStream` / `handleEditBranchStream` 的 finally 中 catch 仅 `log.warn`，主历史已显示新内容但图里候选空占位，用户无感知。

**修复**（`ChatFlowService.ts`，两个方法同步）：
- finally 中 catch 保留结构化事件日志（`reroll_finish_sync_failed` / `edit_branch_finish_sync_failed`），同时把错误记录到 `finishError`；
- 工具循环正常结束后（finally 之后）若 `finishError` 存在，`yield` 结构化 error chunk（`REROLL_FINISH_SYNC_FAILED` / `EDIT_BRANCH_FINISH_SYNC_FAILED`，含错误详情），前端错误条可见；候选保留占位（决策 10：失败候选保留，可切回查看）。

### 【低 L1】reroll chunk 转发硬编码主视图

**现状**：`new StreamChunkProcessor(() => ctx.view as any, ...)` —— monitor 面板发起的 reroll/editBranch 长流 chunk 会错投主聊天。

**修复**（`ChatHandlers.ts`，两个 handler 同步）：`StreamChunkProcessor` 的 getView 优先走 `ctx.postMessage`（由 `MessageRouter.createRoutedContext` 注入，按 clientId 路由到发起端 webview，目标失效回退主视图），未走路由（直接调用/测试）时回退 `ctx.view` —— 语义与 `StreamRequestHandler.getClientView(clientId)` 一致。

### 【低 R6b-2.1】branchHandlers.test.ts TREE-13 守卫状态迁移补用例

**修复**（`backend/__tests__/webview/branchHandlers.test.ts`，TREE-13 块新增 3 用例）：
1. `abortManager.cancel('c1')`（生产「停止」按钮路径）后 isActive=false、controller 清理，分支操作放行成功；
2. `createSummary('c1')` 后 isActive 仍 false（summary 不置互斥），分支操作放行；
3. `create` 两次后 isActive 仍 true 且旧流被 abort（新流替换旧流），流式互斥继续生效（BRANCH_BUSY）。

---

## 二、修改文件清单

| 文件 | 改动 |
|---|---|
| `webview/handlers/ChatHandlers.ts` | H1：rerollStream/editBranchStream 注册 AbortController + 透传 abortSignal/summarizeAbortSignal + finally delete/deleteSummary + 取消时透出 cancelled；L1：chunk 转发走 ctx.postMessage（clientId 路由）回退 ctx.view；移除旧「先 cancel 旧流」前置逻辑 |
| `webview/MessageRouter.ts` | H2：STREAM_MESSAGE_TYPES 增加 chat.rerollStream / chat.editBranchStream；handleStreamMessage 增加 ctx 参数与两个 case；新增 runRegistryStreamHandler（fire-and-forget + requestClients 就地清理） |
| `backend/modules/api/chat/services/ChatFlowService.ts` | M1：新增导出纯函数 resolveRerollTruncateIndex；handleRerollStream startReroll 前 + handleEditBranchStream 截断前调用 deleteCheckpointsFromIndex；M2：两方法 finish 同步失败透出结构化 error chunk（REROLL_FINISH_SYNC_FAILED / EDIT_BRANCH_FINISH_SYNC_FAILED） |
| `backend/__tests__/webview/branchHandlers.test.ts` | R6b-2.1：TREE-13 守卫状态迁移新增 3 用例（cancel 后放行 / createSummary 不拦截 / create 两次旧流被 abort） |
| `backend/__tests__/conversation/branchReroll.test.ts` | 新增 `TREE-01 webview handler：chat.rerollStream（R6a-FIX H1 取消接线）`：注册控制器 + 透传 signal + 结束清理；停止按钮路径（cancel）→ cancelled 结尾不报错 |
| `backend/__tests__/conversation/editBranch.test.ts` | 新增 editBranchStream handler H1 接线测试 ×2（与 reroll 同模式：控制器生命周期 + 取消路径） |

未触碰：CHANGELOG.md、规划文档、branch/ 模块、checkpoint 模块、前端 frontend/src、subagents 模块、`StreamRequestHandler`（仅参考模式）。

## 三、验证结果

- `npx jest --config jest.backend.config.js backend/__tests__/webview/ backend/__tests__/conversation/editBranch.test.ts backend/__tests__/conversation/branchReroll.test.ts`
  ✅ **8 suites / 77 tests 全绿**（含新增：branchHandlers +3、branchReroll +2、editBranch +2）
- `npx jest --config jest.backend.config.js`（全量回归）
  ✅ **135 suites / 1417 tests 全绿**
- `npm run typecheck`（tsc -p ./ --noEmit）✅ 通过

## 四、遗留与后续

- 前端调用 `chat.rerollStream` / `chat.editBranchStream` 属 TREE-10 范围，本批次只保证后端 API、取消接线、IPC 队列与转发协议就绪。
- M2 的 error chunk 语义：工具循环自身抛错时异常直接传播（由 ChatHandler 转 error chunk），finish 同步失败的 error chunk 只在工具循环正常结束时透出——两路径互不吞并。
