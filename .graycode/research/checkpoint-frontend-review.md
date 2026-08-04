# 前端与 Webview 层 Checkpoint 代码审查报告

> 审查日期：2026-08-04（后台子 agent，只读审查）
> 审查范围：`frontend/src/components/settings/CheckpointSettings.vue`、`frontend/src/stores/chat/checkpointActions.ts`、`messageActions.ts`、`conversationActions.ts`、`windowUtils.ts`、`chatStore.ts`、`frontend/src/components/message/MessageList.vue`、`webview/handlers/CheckpointHandlers.ts`、`ChatHandlers.ts`、`MessageRouter.ts`、`frontend/src/utils/vscode.ts`，及对应测试。

---

## 一、frontend/src/components/settings/CheckpointSettings.vue

### 【高】H-1 配置保存失败不回滚本地响应式对象，且后续成功保存会把"失败的改动"一并持久化
- 位置：L242-288（`updateConfigField`）
- 描述：`updateConfigField` 先改本地 `config`（L244），再整包序列化发送 `checkpoint.updateConfig`（L261-282）。保存失败时仅设置 `configSaveError`（L284-287），**不回滚本地 `config`**。由于每次保存都发送整包配置（`configToSave` 包含所有字段），用户之后对任意其他字段的一次成功保存，会把此前"保存失败"的改动一起写入后端。
- 影响：UI 显示的值与后端实际持久化值脱节；出现"保存失败"提示后，改动仍可能被后续保存静默写入（例如 EX-12 校验拒绝的自定义模式会被下一次成功的类别开关保存顺带持久化；或反之 UI 显示已改而后端仍是旧值）。
- 修复建议：`updateConfigField` 保存失败时回滚该字段为上一次成功快照（进入函数前先深拷贝原值），或失败后立即重新 `loadConfig()` 以权威值覆盖本地；同时让保存串行化（队列/防抖 + 递增版本号，后发保存覆盖先发），并在成功响应中返回归一化配置用于校正。

### 【高】H-2 `loadConfig` 失败时静默渲染默认配置，任意一次保存会覆盖用户真实配置
- 位置：L209-239（`loadConfig`）、L1019-1024（模板 `v-if="isLoading"`）
- 描述：`checkpoint.getConfig` 失败时只 `console.error`（L234-235），`isLoading` 置 false 后模板以 `config` 的默认值（`enabled: true`、`beforeTools: []`、空排除配置）渲染整个表单。此时用户点任意一个开关，`updateConfigField` 会把"默认值 + 该开关改动"整包写回后端，**清空用户真实的工具备份列表等配置**。
- 影响：配置静默丢失（数据丢失级），且界面无任何加载失败提示。
- 修复建议：`loadConfig` 失败时展示错误横幅并禁用整个表单（或保持 `isLoading=true` 阻止交互），直到重试成功；不要把默认值当真实配置暴露给可编辑状态。

### 【中】M-1 `toggleMergeUnchangedCheckpoints` 在保存失败时仍同步 chatStore
- 位置：L510-520
- 描述：`updateConfigField` 内部吞掉异常（不会 rethrow），因此 `await updateConfigField(...)` 之后的 `chatStore.setMergeUnchangedCheckpoints(enabled)`（L519）无论保存成败都会执行。
- 影响：设置页显示保存失败，但聊天视图的合并行为已切换，前后不一致。
- 修复建议：让 `updateConfigField` 返回 `boolean` 成功标志，仅在成功时同步 chatStore。

### 【中】M-2 展开对话的存档列表存在过期响应竞态
- 位置：L725-754（`toggleExpandConversation` / `loadExpandedCheckpoints`）
- 描述：`expandedCheckpoints` 是共享 ref。快速"展开 A → 收起 → 展开 B"时，A 的 `checkpoint.getCheckpoints` 响应若晚于 B 到达，会把 A 的存档写进当前展开（B）的列表；`isExpandedLoading` 也不能防重入。
- 影响：列表内容与展开的对话不一致，用户可能误删另一个对话的存档。
- 修复建议：请求携带 `conversationId`，响应返回时校验 `expandedConversationId.value === conversationId` 才赋值；或为每次展开生成递增令牌。

### 【中】M-3 批量删除：后端失败/部分失败时对话仍被从列表移除
- 位置：L832-915（`confirmDelete`）
- 描述：对话分支在收到 `deleteBatch` 响应后，无条件按 `removedIds` 从 `conversationsWithCheckpoints` 移除（L853-857），即使该对话的 `results` 显示 `success:false` 或存在 `rejectedIds`（仅统计进 `totalFailed`/`totalRejected` 提示）。另外 `confirmDelete` 入口没有 `isBatchDeleting` 防重入检查（L832-837 先置 null 再置 true，同一 tick 内二次点击理论可双发）。
- 影响：后端未删净（被依赖保留）的存档在界面上消失，用户只能靠文字反馈知道有拒绝项，无法再定位；双击可重复删除。
- 修复建议：按 `results` 中失败/被拒的 conversationId 保留在列表中（或刷新后重新加载）；`confirmDelete` 入口增加 `if (isBatchDeleting.value) return`。

### 【中】M-4 进度轮询：瞬时错误永久停止、新操作不重启、无陈旧检测
- 位置：L162-188（`pollOperation` / `startProgressPolling` / `stopProgressPolling`）
- 描述：① `pollOperationProgress` 出错返回 null → `pollOperation` 判定"无进行中操作"并 `stopProgressPolling()`，一次瞬时 IPC 错误就让轮询永久停止；② 轮询只在 `onMounted` 与 `watch(isBatchDeleting)` 时启动——聊天侧新建/恢复存档（设置页打开期间）不会重启轮询，进度框不出现；③ 无"操作长时间无进展（updatedAt 陈旧）"的兜底停止条件，后端操作悬挂时轮询永续（800ms 一次 IPC）。
- 影响：进度展示不可靠；极端情况下设置页常驻时每 800ms 一次无效 IPC。
- 修复建议：错误时不停止轮询（重试数次后才停）；监听后端推送或定期重启；增加 `updatedAt` 陈旧阈值停止条件。

### 【中】M-5 排除预览后端错误细节丢失，且预览请求可能超时无感
- 位置：L401-417（`runPreview`）；另见 checkpointActions.ts L149-156
- 描述：`previewExclusions()` 捕获异常只 console 并返回 null（checkpointActions L152-154），`runPreview` 只能显示通用失败文案（L410）。后端 sendError 的具体原因（如"无工作区"、大工作区扫描超时）全部丢失。
- 影响：用户无法知道预览为何失败；大工作区扫描超过 180s（默认超时）时同样只显示通用错误。
- 修复建议：`previewExclusions` 返回 `{ result } | { error }` 结构，透传后端错误信息；预览接口纳入无超时/进度机制。

### 【低】L-1 大小上限显示与保存的精度问题
- 位置：L357-359（`maxFileSizeMiB` 用 `Math.round`）、L362-370（`saveMaxFileSize`）
- 描述：非整 MiB 配置（如 1.5 MiB）显示为 2；输入空/非法值被静默归一化为 0（= 不限制），与占位符 50 的语义差异无提示；保存失败无任何反馈。
- 修复建议：改为 `Math.floor` 或保留小数；保存失败时在输入框旁给出明确错误。

### 【低】L-2 自定义模式输入触发两次保存、双写同一状态
- 位置：L375-399（`customPatternsText` setter + `saveCustomPatterns`）
- 描述：`v-model.lazy` 的 setter 与 `@change="saveCustomPatterns"` 对同一输入各执行一次归一化与保存，属冗余；且 setter 与 handler 逻辑重复。
- 修复建议：只保留一个写入路径（例如仅 `@change` 保存，v-model 只读展示）。
- **注意：此问题已随本次「排除配置编辑器美化」修复**（chips 编辑器单写入路径 + 即时保存）。

### 【低】L-3 单条删除取消后残留选中态
- 位置：L803-812（`requestDeleteSingleCheckpoint`）
- 描述：单条删除确认复用了 `selectedCheckpointIds`，取消后该存档仍处于选中状态。
- 修复建议：取消时清空 `selectedCheckpointIds`，或单条删除不走共享选择集。

### 【低】L-4 其他小项
- L996-1002：`onMounted` 未 `await loadConfig`，与 H-2 叠加时无失败可见性。
- L1484、L1673：删除反馈/确认按钮在对话框关闭瞬间的 disabled 仅覆盖 `isBatchDeleting`，同 tick 双击风险（与 M-3 同源）。

---

## 二、frontend/src/stores/chat/checkpointActions.ts

### 【中】M-1 `checkpoint.restore` / `checkpoint.deleteBatch` 有 180s 兜底超时，超时后前端误判失败而后端继续执行
- 位置：L184-201（`restoreCheckpoint`）、L741-754；配合 frontend/src/utils/vscode.ts L33-43（`UNBOUNDED_REQUEST_TYPES` 不含 checkpoint 系列）
- 描述：大工作区恢复/批量删除可能超过 180s。超时后 `sendToExtension` reject，前端返回 `{success:false}` 并提示错误；但后端操作在互斥锁内**继续执行**。用户看到失败后可能再次点击恢复，第二次请求会在锁队列中等待第一次完成后再次执行（重复恢复/重复删除）。
- 影响：超时误报 + 潜在重复执行；恢复结果（含 autoPrune/build 刷新）全部丢失。
- 修复建议：将 `checkpoint.restore`、`checkpoint.deleteBatch`、`checkpoint.previewRestore` 加入 UNBOUNDED（或改为基于 `getOperationProgress`/取消机制的异步任务 + 完成回调），前端展示"操作进行中"而非失败。

### 【中】M-2 回档流程 deleteMessage 失败重载历史后不重载 checkpoints
- 位置：L307-312（restoreAndRetry）、L454-459（restoreAndDelete）
- 描述：失败路径先 `clearCheckpointsFromIndex` 截断本地检查点，再 `loadHistory(state)`——而 `loadHistory`（conversationActions L559-595）只拉消息页，**不调用 `loadCheckpoints`**。后端历史未删，检查点也仍存在，但前端窗口只有消息没有检查点条。
- 影响：前端与后端检查点展示不一致（存档条消失），直到切换对话重载。
- 修复建议：失败重载路径改为 `await loadCheckpoints(state)` + `loadHistory(state)` 组合，或让 `loadHistory` 统一重载检查点。

### 【中】M-3 `restoreAndEdit` 本地先截断/改写，后端调用失败时无恢复手段
- 位置：L536-597（`restoreAndEdit`）
- 描述：`restoreCheckpoint` 成功后立即改本地消息内容并截断窗口（L537-546），随后调用 `editAndRetryStream`。该调用失败（异常/后端拒绝）时 catch 只重置流状态（L599-609），本地窗口已截断且内容已改，后端历史仍是旧内容——前后端错位，且没有像 retry/delete 那样的重载兜底。
- 影响：编辑后重试失败时出现幽灵不一致状态。
- 修复建议：catch 中（会话未切换时）执行 `loadHistory(state)` + `loadCheckpoints(state)` 恢复一致；或在调用后端成功前不落本地修改。

### 【低】L-1 重复实现 `resolveConversationModelOverride`
- 位置：L17-21 与 messageActions.ts L102-114
- 描述：两份实现逻辑略有差异（checkpointActions 版未处理 `trim()` 后比较等细节），后续维护易分叉。
- 修复建议：收敛到 messageActions 单份导出。

### 【低】L-2 文件职责混杂 / 轮询错误静默
- L623-718：`summarizeContext`、`cancelSummarizeRequest` 与 checkpoint 无关（建议拆分）；L741-771：`pollOperationProgress` / `cancelCheckpointOperation` 错误只 console，设置页无感知。

---

## 三、frontend/src/stores/chat/messageActions.ts（删除/重试/流式错误回滚）

### 【中】M-1 恢复/预览类错误被错误条"重试"按钮复用，点击会触发 LLM 重新生成
- 位置：L611-689（`retryAfterError`，无错误码过滤）；配合 MessageList.vue L1323-1325（错误条无条件显示重试按钮）、L886-888（`handleErrorRetry` 无条件调 `retryAfterError`）
- 描述：`chatStore.error` 同时承载两类错误：流式错误（可重试）与恢复/预览错误（`RESTORE_ERROR` / `RESTORE_PREVIEW_ERROR` / `RESTORE_PARTIAL_ERROR` / `RESTORE_UNBACKED_WARNING`，见 MessageList L941-990）。错误条对两类错误都显示"重试"按钮，而 `retryAfterError` 只校验 `isLoading/isStreaming`，不校验错误码——恢复失败后点重试会直接 `retryStream` 重新生成最后一条助手消息（没有任何存档恢复语义）。
- 影响：恢复失败场景下错误提示的"重试"执行了完全错误的操作（再次调用 LLM 生成），且 `RESTORE_PARTIAL_ERROR`/`RESTORE_UNBACKED_WARNING` 这类"警告"也用红色错误条+重试按钮展示，语义错配。
- 修复建议：① 错误条重试按钮仅在错误码属于可重试集合（`STREAM_ERROR` 等）时显示/启用；② 恢复类结果用独立非错误样式提示（成功/部分成功/警告分级），不再塞入 `chatStore.error`。

### 【中】M-2 `retryFromMessage` 删除失败重载页后不重载检查点
- 位置：L487-521
- 描述：与 checkpointActions M-2 相同模式：本地 `clearCheckpointsFromIndex` 后失败，用 `getMessagesPaged` 直接重建 `allMessages`（L502-510），`state.checkpoints` 未恢复。
- 影响：失败后检查点条缺失，与后端不一致。
- 修复建议：该分支补 `await loadCheckpoints(state)`。

### 【低】L-1 半截消息保留期间的检查点清理依赖"重试/发送"时机
- 位置：L585-598（`rollbackFailedStreamMessage`）、streamChunkHandlers.ts L1155-1171（`handleError`）
- 描述：`handleError` 保留有内容的半截消息时不清其索引之后的检查点，靠重试/发送时 `rollbackFailedStreamMessage` 清理；若用户既不重试也不发送而直接切换对话，`switchConversation` 会 `loadCheckpoints` 覆盖，故实际影响小，但窗口内残留期间 UI 仍显示"幽灵消息+存档条"，提示语义不清（低）。

---

## 四、webview/handlers/CheckpointHandlers.ts（及路由层）

### 【中】M-1 `previewExclusions` 是排队执行的常规 handler，大工作区全量扫描会阻塞整个 webview 消息通道
- 位置：L230-269；配合 MessageRouter.ts L39-44（`NON_BLOCKING_MESSAGE_TYPES` 不含 checkpoint 系列）
- 描述：`previewExclusions` 直接 `await runExclusionPreview(...)` 全量扫描工作区，在 `ChatViewProvider` 的消息处理队列中串行执行。10 万文件级工作区扫描可能耗时数十秒到分钟级：期间 `cancelStream`、`checkpoint.cancelOperation`、消息删除等所有 IPC 全部排队冻结；且该请求不在 `UNBOUNDED_REQUEST_TYPES`（vscode.ts L33-43）中，前端 180s 超时后报错，后端扫描仍在继续。
- 影响：消息通道整体卡死 + 超时误报；取消操作无法及时送达。
- 修复建议：将 `checkpoint.previewExclusions`、`checkpoint.getAllConversationsWithCheckpoints`（CPF-10 声称非阻塞，但路由层未放行）加入 `NON_BLOCKING_MESSAGE_TYPES`；前端对 preview 请求豁免超时或接入进度/取消。

### 【中】M-2 `updateCheckpointConfig` 不返回归一化后的配置
- 位置：L35-43
- 描述：后端 `updateCheckpointConfig`（SettingsHandler L565-584）成功后返回 `{success:true, settings}`，handler 丢弃 `settings`，只回 `{success:true}`。前端无法用后端归一化结果校正本地值（后端会把 `maxFileSizeBytes` 负数归零、合并 `enabledProfiles` 默认值等）。
- 影响：与 CheckpointSettings H-1 叠加，前端本地值永远无法与后端权威值对齐。
- 修复建议：响应携带 `config: result.settings?.checkpoint ?? 归一化配置`，前端保存成功后以返回值覆盖本地。

### 【低】L-1 `restoreCheckpoint` handler 的取消逻辑若抛错会误报 RESTORE_CHECKPOINT_ERROR
- 位置：L82-91
- 描述：`abortManager.cancel(conversationId)` 与子代理取消（L93-102，已有内部 try/catch）不同，外层无独立 try/catch；若 `cancel` 抛错，整个 handler 落入 L115-117 的 catch，向前端返回"恢复失败"，实际恢复根本没开始。
- 修复建议：把 L82-91 的取消逻辑包进独立 try/catch（仅 warn），不阻断恢复主流程。

### 【低】L-2 各 handler 缺少入参校验
- L123-157：`deleteCheckpoint` / `deleteAllCheckpoints` / `deleteCheckpointsBatch` 未校验 `conversationId`/`checkpointId`/`items` 类型，异常参数会落入通用错误码。`getManifest`（L179-187）当前前端无任何调用方（EX-11"查看存档排除清单"前端缺口）。

### 【低】L-3 ChatHandlers.ts `deleteMessage` handler 无自身 try/catch
- 位置：ChatHandlers.ts L14-37
- 描述：该 handler 直接 `await ctx.chatHandler.handleDeleteToMessage(...)` 无 try/catch；异常时依赖 `MessageRouter.route` 的 catch 与 `ChatViewProvider` 的兜底发送通用 `HANDLER_ERROR`。功能上不会挂起，但错误码/文案不可控。
- 修复建议：补 try/catch，发送明确的 `DELETE_MESSAGE_ERROR`。

---

## 五、frontend/src/components/message/MessageList.vue

### 【中】M-1 恢复结果用错误条展示 + 重试按钮语义错配（与 messageActions M-1 同根，前端侧）
- 位置：L972-991（`confirmRestore` 中 failures/unbackedPaths 塞入 `chatStore.error`）、L1318-1336（错误条模板）
- 描述：恢复"部分完成"（`RESTORE_PARTIAL_ERROR`）与"未备份警告"（`RESTORE_UNBACKED_WARNING`）被以错误样式 + 可点击"重试"按钮展示，重试会走 `retryAfterError` 触发 LLM 重生成。
- 修复建议：恢复结果用独立 toast/横幅（区分成功/部分成功/警告），错误条重试仅限流式错误码。

### 【中】M-2 `openRestoreConfirm` 未固化对话身份
- 位置：L935-957；`confirmRestore` L960-1009
- 描述：预览与确认之间未记录 `conversationId`。若预览请求在途或确认框打开期间用户切换对话（低概率但可能），`confirmRestore` 会用当前对话执行 `restoreCheckpoint` / `restoreAndRetry`，恢复的是错误对话的存档。
- 修复建议：`PendingRestoreAction` 增加 `conversationId` 字段，`confirmRestore` 执行前校验 `chatStore.currentConversationId === action.conversationId`，不一致则丢弃并提示。

### 【低】L-1 全局 `isRestorePreviewing` 使所有恢复按钮同时转圈
- 位置：L1198、L1245
- 描述：单次预览期间页面所有存档恢复按钮都显示 spinner（共享单一标志），视觉噪音。建议只对发起预览的按钮显示。

### 【低】L-2 恢复确认框内容在预览后无刷新机制
- L1041-1050：确认框打开后，若后端在此期间 autoPrune 删除存档（previewRestore 已触发 `loadCheckpoints`），确认框内清单仍为预览快照，确认后 restore 返回 checkpoint_not_found → 以 RESTORE_ERROR 呈现。可接受但可优化为确认时重验。

---

## 六、frontend/src/stores/chat/windowUtils.ts / conversationActions.ts

### 【低】L-1 `trimWindowFromTop` 永久丢弃窗口外检查点，回滚上拉后不恢复
- 位置：windowUtils.ts L269（`state.checkpoints.value = ...filter(cp => cp.messageIndex >= windowStartIndex)`）
- 描述：窗口裁剪时过滤掉 `messageIndex < windowStartIndex` 的检查点；之后用户上拉加载更早历史（`loadOlderMessagesPage` 前移 `windowStartIndex`）时，这些检查点不会恢复。
- 影响：超长对话中早前消息的存档条消失，需切换对话才能恢复显示（数据未丢，属展示一致性问题）。

### 【低】L-2 `loadCheckpoints` 仅捕获并置空
- conversationActions.ts L672-692：加载失败时 `state.checkpoints.value = []`，静默清空检查点列表（无错误提示）。建议失败时保留旧值 + console 告警。

---

## 七、测试覆盖评估

### 已覆盖（较好）
- `checkpointActions.test.ts`（9 用例）：previewRestore 透传/异常、restoreCheckpoint 的 deleteUntrackedFiles 默认 false/确认 true、restoreAndRetry deleteMessage 失败中止 + 重载历史 + 成功路径、restoreAndDelete 失败路径。
- `streamErrorRetry.test.ts`（12 用例）：handleError 保留/删除半截消息、rollbackFailedStreamMessage、dismissError、retryAfterError 回滚、sendMessage 清理残留。
- `chatRaceCondition.test.ts`：会话归属校验、窗口切片、虚拟行回归。

### 缺口（建议补充）
1. **`restoreAndEdit` 零覆盖**——回档三连中唯一没有测试的入口（成功、失败、附件序列化、并发取消）。
2. **恢复结果展示分支无测试**：`confirmRestore` 的 `failures`/`unbackedPaths`/`legacy` 提示。
3. **设置页无任何测试**：`updateConfigField` 保存失败回滚（H-1）、`loadConfig` 失败（H-2）、`toggleProfile`/`saveProfilePatterns`、进度轮询停止/重启条件（M-4）、`confirmDelete` 失败保留列表（M-3）。
4. **失败重载后 checkpoints 不一致**（checkpointActions M-2 / messageActions M-2）无回归测试。
5. **`retryAfterError` 对非流式错误码（RESTORE_ERROR 等）的误触发**无测试。
6. **`pollOperationProgress` / `cancelCheckpointOperation` / `previewExclusions` 无测试**。

---

## 八、按严重程度排序的汇总清单

### 高（3 项）
| # | 位置 | 问题 |
|---|------|------|
| H-1 | CheckpointSettings.vue L242-288 | 配置保存失败不回滚本地对象；后续整包保存会顺带持久化"失败的改动"，UI 与后端长期不一致 |
| H-2 | CheckpointSettings.vue L209-239, L1019-1024 | getConfig 失败静默渲染默认配置，任意一次保存覆盖用户真实配置（数据丢失） |
| H-3 | MessageList.vue L972-991 + messageActions.ts L611-689 | 恢复失败/部分失败/警告被塞进 `chatStore.error`，错误条"重试"按钮会触发 `retryAfterError`→LLM 重新生成，语义错配且危险 |

### 中（11 项）
| # | 位置 | 问题 |
|---|------|------|
| M-1 | checkpointActions.ts L184-201 + vscode.ts L33-43 | checkpoint.restore/deleteBatch 有 180s 超时，超时误报失败而后端继续执行，可能重复恢复/删除 |
| M-2 | CheckpointHandlers.ts L230-269 + MessageRouter.ts L39-44 | previewExclusions 全量扫描在串行队列中执行，阻塞 cancelStream 等全部 IPC；且 180s 超时后扫描仍在继续 |
| M-3 | checkpointActions.ts L307-312/L454-459、messageActions.ts L487-521 | 删除失败重载历史后不重载 checkpoints，检查点条缺失（前后端不一致） |
| M-4 | CheckpointSettings.vue L162-188 | 进度轮询：瞬时错误永久停止、新操作不重启、无陈旧检测 |
| M-5 | CheckpointSettings.vue L725-754 | 展开对话的存档列表过期响应竞态，可能展示/删除错误对话的存档 |
| M-6 | CheckpointSettings.vue L832-915 | confirmDelete 后端失败/部分失败仍从列表移除对话；入口无防重入 |
| M-7 | CheckpointSettings.vue L510-520 | mergeUnchanged 保存失败仍同步 chatStore，行为不一致 |
| M-8 | MessageList.vue L935-957/L960-1009 | openRestoreConfirm 未固化 conversationId，预览/确认期间切对话可恢复错误对话 |
| M-9 | checkpointActions.ts L536-597 | restoreAndEdit 本地先截断改写，后端调用失败无重载兜底 |
| M-10 | CheckpointHandlers.ts L35-43 | updateCheckpointConfig 不返回归一化配置，前端无法校正（加剧 H-1） |
| M-11 | CheckpointHandlers.ts L82-91 | 恢复前 abortManager.cancel 抛错会误报恢复失败（恢复未执行） |

### 低（10 项）
| # | 位置 | 问题 |
|---|------|------|
| L-1 | CheckpointSettings.vue L357-370 | maxFileSize MiB 显示取整误差、非法输入静默归一化 |
| L-2 | CheckpointSettings.vue L375-399 | customPatterns v-model setter 与 @change 双写双保存（已随编辑器美化修复） |
| L-3 | CheckpointSettings.vue L803-812 | 单条删除取消后残留选中态 |
| L-4 | CheckpointSettings.vue L401-417 | 排除预览后端错误细节丢失，只显示通用文案 |
| L-5 | checkpointActions.ts L17-21 | resolveConversationModelOverride 与 messageActions 重复实现 |
| L-6 | checkpointActions.ts L623-718 | summarize 相关函数与 checkpoint 职责混杂 |
| L-7 | windowUtils.ts L269 + conversationActions.ts L559-595 | 窗口裁剪丢弃检查点，上拉回滚后不恢复 |
| L-8 | conversationActions.ts L672-692 | loadCheckpoints 失败静默置空列表 |
| L-9 | CheckpointHandlers.ts L123-157/L179-187 | handler 入参无校验；getManifest 无前端调用方（EX-11 前端缺口） |
| L-10 | CheckpointSettings.vue L191-196 | cancelActiveOperation 乐观置 cancelled，取消失败无反馈 |

### 修复优先级建议
1. **先修数据一致性问题**：H-1/H-2（保存失败回滚 + loadConfig 失败防护）——二者都会造成用户配置静默丢失或被错误覆盖。
2. **再修错误语义与安全**：H-3（恢复错误误触发 LLM 重试）、M-8（恢复目标对话身份校验）、M-9（restoreAndEdit 失败兜底）。
3. **然后修长任务健壮性**：M-1/M-2（超时豁免 + 非阻塞路由）、M-11（取消逻辑隔离）。
4. **最后补一致性展示与测试**：M-3/M-4/M-5/M-6/M-7/M-10 及测试缺口。
