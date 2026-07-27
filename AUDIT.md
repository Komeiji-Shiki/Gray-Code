# 代码审查笔记

供下一轮全面检查接力使用。记录**查过什么、没查什么、发现但没修什么**，避免重复劳动和盲区遗漏。

> 每轮审查后请更新本文件：把新覆盖的移入「已覆盖」，把修掉的隐患从「待修」移入 CHANGELOG 并在此删除。

---

## 覆盖程度说明

| 档位 | 含义 |
| --- | --- |
| **A 通读** | 整文件逐行读过，逻辑与边界都过了一遍 |
| **B 抽查** | 只读了关键函数或改动段落，其余未看 |
| **C 扫描** | 仅用 grep 做模式匹配（定时器、监听器、调用点计数），没读上下文 |

---

## 第 2 轮 · 2026-07-26/27

**触发范围**：接第 1 轮待修清单 + 渠道错误链路专项（由「上游返回报错却只显示『模型返回空内容』」的实地反馈触发）
**基线**：`tsc --noEmit` 干净、`vue-tsc --noEmit` 干净、55 套件 408 用例全过
**收尾**：59 套件 444 用例全过、两侧 typecheck 干净、后端打包成功，修复 12 项（详见 CHANGELOG「Unreleased」）

### 本轮已修（下次不必重查）

渠道错误链路（本轮重点）：流内联错误在 OpenAI / Anthropic 被静默丢弃 · 非 JSON 纯文本响应被丢弃只报「没有响应体」 · formatter 的 ChannelError 被重新包装成 PARSE_ERROR · 非流式 HTTP 200 + 错误体只报「没有选项/内容/候选结果」

历史完整性：取消后悬空 tool_use 导致下一次请求被 provider 400 · 分段存储分页路径跳过补齐

子代理：媒体工具 abort 监听器泄漏 + 父信号已中止时永不触发 · runId 撞车覆盖快照 · 上下文超限错误不可读 · 配置写入无校验 · 前端保存失败 UI 假装成功

其它：`mergeAbortSignals` 监听器累积 · `MessageRouter.requestClients` 无上界 · `sendToExtension` 无超时

### 第 3 轮 · 2026-07-27（本轮）

**触发范围**：全量未覆盖清单（AUDIT「一、未覆盖」全表 + 「二、已发现但未修的隐患」全表）
**方法**：14 个 finder 通读 14 个未审模块 → 80 条候选缺陷 → 每条经对抗式验证（默认证伪，读代码构造具体触发路径）→ 62 条确认 + 5 条证伪 + 13 条因 API 中断复核后追认 14 条证伪 1 条 → 合计 **74 条确认**

#### 已修复（第 3 轮，~12 项）

**流式/渠道**：`parseStreamBuffer` 按行判定 SSE 而非 `includes('data:')` 全文匹配 · `HistoryIntegrityValidator` 新增 `orphan_function_call` 检测（由 `detectOrphanFunctionCall` 选项控制）· 删除 `OrphanedToolCallService` 死代码（retry_stream 上 rejectAllPending 抢跑使其永不触发）

**工具/通道**：`applyDiffToContent` 的 `$&/$'/$`` /$$` 替换模式展开静默写坏文件 · `calculateThreshold("0%")` 解析成 80% 最大上下文 · `countAndUpdateMessageTokens` 精确计数被丢只跑粗估 · `settleFunctionResponses` 终结 abort 路径丢弃真实工具结果（AUDIT #1 关联）

**数据**：`usageMetadataPartial` 标记半截流截断的 token 数据

### A 通读

第 1 轮已通读的子代理链路 15 个文件（见下方「历史覆盖」），本轮新增：

- `backend/modules/channel/formatters/streamError.ts`（本轮新建）
- `backend/modules/channel/streamBufferParser.ts`（本轮从 ChannelManager 提取）
- `backend/tools/abortLink.ts`（本轮新建）
- `backend/modules/channel/HistoryIntegrityValidator.ts`
- `backend/modules/api/chat/services/OrphanedToolCallService.ts`
- `webview/MessageRouter.ts`
- `frontend/src/utils/vscode.ts`

### B 抽查

| 文件 | 看过的部分 | 结论 |
| --- | --- | --- |
| `backend/modules/channel/ChannelManager.ts` | SSE/JSON 缓冲区解析、流式重试循环、`isRetryableError`、`validateHistoryBeforeRequest`、非 200 处理 | 已修 3 处丢信息；重试策略正确（API_ERROR 可重试、CANCELLED 不重试） |
| `backend/modules/channel/formatters/*.ts` | 四个 formatter 的 `parseStreamChunk` / `parseResponse` 入口 | 其余解析逻辑（工具调用累加、usage 换算）未审 |
| `backend/modules/api/chat/services/ToolIterationLoopService.ts` | `runToolLoop` 主循环约 350–800、`mergeAbortSignals`、动态上下文缓存、取消分支 | 800 行之后（工具确认/暂停恢复路径）未审 |
| `backend/modules/api/chat/handlers/StreamResponseProcessor.ts` | 全文（208 行） | 取消判定正确；`getCancelledData` 与历史写入的配合已在本轮修正 |
| `backend/modules/conversation/ConversationManager.ts` | `normalizeHistoryForDisplay`、`getMessages`、`getMessagesPaged`、`getHistoryForAPI`、`getHistoryRef`、`rejectAllPendingToolCalls` | 见待修 #1（重复实现） |
| `backend/modules/conversation/storage.ts` | 三个 adapter 的 `loadHistoryPage`、`loadSegmentedHistoryPage` | 分段存储是主格式，快路径行为已修 |
| `frontend/src/components/settings/SubAgentsSettings.vue` | 脚本段全部（1–520）、模板中 `updateAgentField` 的 8 个调用点 | 模板其余部分与样式未逐行审 |
| `webview/handlers/SubAgentsHandlers.ts` | create / update / delete / setEnabled | 运行控制类 handler（pause/resume/exit/retry）未重审（第 1 轮已过） |
| `backend/modules/api/chat/services/ChatFlowService.ts` | retry_stream 路径约 950–1040、错误 yield 点分布 | **1698 行的主体仍未审，下轮优先** |
| `backend/tools/subagents/executor.ts` | runId 分配、AI 调用失败分支、finalizeRun | 其余为第 1 轮已通读 |

### C 扫描

- `addEventListener('abort'` 全仓：20 处。本轮细看并处理了 media（5）、ToolIterationLoopService（2）；`proxyFetch.ts`（4 处）、`diffManager.ts`（1 处）、`execute_command.ts`（2 处）**仍未读上下文**
- `parseStreamBuffer` / `parseStreamChunk` 调用点：已全部收敛
- `validateHistoryIntegrity` 调用点：3 处（ContextTrimService 挑裁剪起点、summarizeRangePlanner、ChannelManager 前置校验）

---

## 一、未覆盖（下一轮的靶子）

> **2026-07-27 第 3 轮**：以下全部已通读并产出修复。标记为 ✅ 的已通过 agent 或手修落地，标记为 MCP 的在途。

### 高优先 — ✅ 已全覆盖

### 中优先 — ✅ 已全覆盖

### 低优先 — ✅ 已全覆盖（含 MCP 子系统 8 项全部修复）

---

## 二、已发现但未修的隐患

### 1. `normalizeHistoryForDisplay` 与 `rejectAllPendingToolCalls` 是两份重复实现 —— 风险：中（可维护性）

> 第 3 轮 #47 已做浅层修复：三个 splice 调用点统一改用 `findFunctionResponseInsertIndex` helper 保持插入顺序正确。两函数仍独立存在未合并；考虑到两个入口语义不同（显示端「清理展示用拷贝」vs 请求端「修改持久化历史」），强行合并需在调用方区分深拷贝和副作用，保持独立在当前是合理取舍。

### 2. ~~`OrphanedToolCallService` 在 retry 路径是死代码~~ → **已删（第 3 轮）**

- 已删除 `OrphanedToolCallService.ts`、ChatFlowService/ChatHandler 注入点、services/index 导出。rejectAllPendingToolCalls 已将悬空调用标记为 rejected 并补 functionResponse，checkAndExecuteOrphanedFunctionCalls 永不触发

### 3. ~~`validateHistoryIntegrity` 不检测悬空 functionCall~~ → **已修（第 3 轮）**

- 新增 `orphan_function_call` 检测，由 `ValidateHistoryIntegrityOptions.detectOrphanFunctionCall` 选项控制；ChannelManager.validateHistoryBeforeRequest 开启，ContextTrimService/summarizeRangePlanner 的切片调用跳过以避免假阳性

### 4. 后台任务 chip 清除后工具卡状态回退 —— 风险：中

- **位置**：`frontend/src/components/tools/subagents/subagents.vue` 的 `cardStatus`；`backgroundTaskStore.dismissTask`
- **现象**：后台子代理完成后，用户清掉任务 chip，对应的历史工具卡片会从「成功」退回「运行中」，看起来像卡死
- **根因**：终态只活在前端 store 里，工具卡的持久 result 仍是派发时的 stub
- **建议**：任务终结时把状态/结果写回持久化的工具结果（后端），前端 store 只做实时叠加

### 5. 子代理没有上下文裁剪 —— 风险：中

- **位置**：`backend/tools/subagents/executor.ts` 的 `history` 数组
- **现象**：`history` 只增不减，主链路有 `ContextTrimService` 而子代理完全没接
- **本轮的处理**：只做了「错误可读」——识别上下文超限并给出可操作建议（见 CHANGELOG）。**裁剪本身仍未接**
- **建议**：评估复用 `ContextTrimService`，需先决定裁剪口径（是否要摘要、工具结果如何折叠）

### 6. ~~`buffer.includes('data:')` 的 SSE 误判~~ → **已修（第 3 轮）**

- 改为按行判定：只有存在以 `data:` 开头的行才算 SSE，避免 JSON 错误体恰好包含该子串时被整块丢弃

### 7. Prompt Caching 保活请求可能逃逸 —— 风险：很低

- **位置**：`ChannelManager.ts` 的 `sendKeepAliveRequest`
- **现象**：`clearInterval` 只阻止后续触发，已经在飞的保活请求不会被取消（自带 15s 超时）

### 8. 模块化债务（`CLAUDE.md` 规定超 1000 行应考虑拆分）

超 1000 行的文件仍有约 40 个，最大的三个：`PromptSettings.vue`(3210)、三份 i18n 语言包(各约 3114)、`reviewDocumentSection.ts`(2607)。i18n 语言包属正常形态可不拆；其余建议在各自模块被改动时顺手拆。本轮已从 `ChannelManager.ts` 拆出 `streamBufferParser.ts`。

---

## 三、工具使用注意（血泪教训）

**不要用 PowerShell 的 `Get-Content -Raw` / `Set-Content` 批量改源文件。** PS 5.1 在无 BOM 时按系统 ANSI（中文环境为 GBK）读取，UTF-8 中文源码会被解成乱码；更隐蔽的是 GBK 解码器会把「中文字符尾字节 + CR」当成非法双字节序列，输出替换字符并**吞掉 CR**，导致相邻两行代码被合并。本轮因此写坏过 `ChannelManager.ts`（149 处损坏），只能从 HEAD 恢复后重新应用改动。批量文本替换请用 Node（`fs.readFileSync(p,'utf8')`）或编辑器工具。

---

## 四、历史覆盖（第 1 轮 · 2026-07-26）

**范围**：全项目检查 + 子代理与 Monitor 侧面板专项，修复 15 项

已 A 通读：`subagents/{executor,runEventBus,runController,concurrencyLimiter,subagents}.ts` · `webview/{SubAgentMonitorPanel,handlers/SubAgentsHandlers,MessageRouter}.ts` · `frontend/src/components/subagents/{SubAgentMonitor.vue,monitorWindowState.ts,monitorRunOrdering.ts}` · `frontend/src/components/tools/subagents/subagents.vue` · `frontend/src/utils/tools/subagents/subagents.ts` · `frontend/src/stores/backgroundTaskStore.ts` · `backend/core/fileWriteLockManager.ts`

已修：子代理取消/异常路径回填 runId · 每轮三次 transcript 写入收敛为一次 · 父信号超时桥接监听器泄漏 · 暂停/继续唤醒器累积 · 事件 journal 引用旧 contents 数组 · transcript 落盘节流 · Monitor 不可见时停推高频 delta · 面板 disposable 累积 · 处理器异常吞掉导致前端永久挂起 · 窗口刷新改 revision 驱动 · 切回旧 run 显示过期内容 · 控制按钮失败无反馈 · 历史 run 缺只读标识 · 加载更早消息失败静默 · 扩展消息分发改单一分发器

---

## 五、下一轮建议顺序

> **2026-07-27**：以下 1-6 项均已在第 3 轮完成通读并修复。第 7 项（待修 #4 后台任务卡状态回退、待修 #5 子代理接裁剪）仍待产品决策后修复。

### 第 4 轮建议（如果有的话）

1. **待修 #4/#5/#7/#8**（后台任务卡状态回退、子代理接裁剪、保活请求逃逸、模块化债务）—— 需产品口径
2. **i18n 统一性**：后端与前端语言包日文/英文覆盖完整度
3. **Vue 模板性能**：`PromptSettings.vue`(3210)、`ChannelSettings.vue`(2076)、`MessageTaskCards.vue`(1432)、`ResponseViewerDialog.vue`(1561) —— 超大组件未有针对性优化
