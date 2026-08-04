# FIX-G4 前端域复查修复报告（批次 FIX-G4）

- 范围：R5c 复查（前端）问题清单，批次 FIX-G4
- 基线：最新代码（前端 v1.2.6）
- 验证：`npm --prefix frontend test`（18 个测试文件 / 200 用例全部通过）+ `npm --prefix frontend run typecheck`（通过）

---

## 修改摘要

### 【中 M3-1】U1 忙时插入零回显/延迟错位（messageActions.ts + MessageList.vue + i18n×3）

实施 **① 前端最近投递回显** 与 **③ 错误可见反馈**（纯前端，最小可行）；**② 后端流式插入窗口留待接线**（见下方方案）。

- `messageActions.ts`：
  - 新增模块级 `recentInterruptDeliveries`（shallowRef）+ `InterruptDeliveryNotice` 类型 + `recordInterruptDelivery` / `clearInterruptDeliveries`；
  - 提示条数上限 3、TTL 10s 自动移除、同会话同类型去重；
  - `deliverInterruptMessage` 成功时记录 `delivered` 提示；失败（含 `INTERRUPT_MESSAGE_RATE_LIMITED` 等错误码）时记录 `error` 提示（错误码/消息透出）；
  - **不写 `state.error`**：避免打断进行中的回合（保持既有测试语义 `error.value === null`），可见反馈走独立提示通道。
- `MessageList.vue`：消息区末尾新增轻量提示条（`interrupt-notices`），按 `currentConversationId` 过滤展示「已投递（将在当前回合结束后处理）」/「消息未能投递：{detail}」；当前回合结束（isStreaming 与 isWaitingForResponse 均 false）时清除本会话提示。
- i18n 三语同步新增 `components.message.interrupt.delivered` / `deliverFailed`（zh-CN / en / ja）。

**取舍说明**：①+③ 为纯前端最小可行。② 需要后端注入点把消息经流式事件带回前端（类似 handleAutoSummary 的 insert 通道），前端侧还缺一个 `streamHandler` 中新 chunk 类型的监听分支（不在本批文件边界内），故本批只做前端提示层，后端方案见下。

**② 接线方案（待后端配合）**：
1. 后端：注入点带出 inbox 消息时，向该会话流发送一个新的 chunk 类型（如 `type: 'interruptMessage', messageId, text`），在最近一次工具调用完成后的 assistant 消息之后插入；
2. 前端：`streamChunkHandlers.ts` 增加对该类型的处理——按后端消息 id 构造 user 消息并 `insertMessageAt`/`appendMessage`（与 `handleAutoSummary` 的插入通道对齐，同步维护 messageIndexById / toolResponseIndex / checkpoints）；
3. 完成后由 MessageList 的回合结束 watcher 自然清除「已投递」提示。此方案同时解决「注入点前 complete 导致消息滞留到下一轮无关回合才被模型感知」与「重试轮首个工具调用后吞掉消息」两个场景——提示层无法根治，需 ② 配合。

### 【中 M1-1】backgroundTaskViewModeByMessageId 永不清理（MessageItem.vue + MessageList.vue）

- `MessageItem.vue`：新增导出 `pruneBackgroundTaskViewModes(activeIds: Set<string>)`；setter 增加容量上限 `BACKGROUND_TASK_VIEW_MODE_CAP = 500`（Map 保持插入序，超限淘汰最旧记录，不侵入渲染热路径）。
- `MessageList.vue`：在 `props.tabId` 切换 watcher（非渲染热路径，仅切换时执行）调用 `pruneBackgroundTaskViewModes(collectActiveBackgroundTaskMessageIds())`；activeIds = 当前窗口 allMessages ∪ 各标签页 sessionSnapshots.allMessages 的并集——**保留其他打开标签页的消息模式**，仅清理已删除消息/已关闭会话遗留的记录，避免破坏跨标签页持久化。

### 【中 M2-1】messageListUiStateByTab 永不清理（messageListUiState.ts + tabActions.ts + MessageList.vue）

- **新增纯模块 `frontend/src/components/message/messageListUiState.ts`**：承载 `RestoreNoticeState` / `MessageListUiState` / `messageListUiStateByTab` / `pruneMessageListUiStateByTab` / `MESSAGE_LIST_UI_STATE_CAP = 50`。
  - 原因：若由 tabActions 直接导入 MessageList.vue 会形成 `tabActions → MessageList.vue → chatStore → tabActions` 循环导入，vue-tsc 对循环中的 .vue 命名导出回退到通配符 shim 报 `Module '"*.vue"' has no exported member`；提升为纯 .ts 模块后 store 层与组件层均无循环。MessageList.vue 保留对外再导出（兼容既有导入）。
- `tabActions.ts`（closeTab 清理接线，L201-208）：移除标签页后调用 `pruneMessageListUiStateByTab(new Set(newTabs.map(t => t.id)))`。
- `MessageList.vue`：`saveCurrentUiState` 增加两道防线——① 已关闭标签页不保存（避免关闭活跃标签页时 tabId watcher 把旧记录写回、抵消 closeTab 清理）；② 容量上限 50（超限优先淘汰最旧非当前记录）。

### 【低 M2-2】todoExpandedMap 与 uiStateByTab.todoExpanded 语义分叉（MessageList.vue）

- 删除实例级 `todoExpandedMap`（conversationId 为 key），统一以模块级 `messageListUiStateByTab`（tabId 为 key）为单一数据源：
  - `restoreTodoExpandedState`：读取 `uiStateByTab.get(props.tabId)?.todoExpanded`；无保存记录时保持当前 ref（组件实例生命周期内用户选择不丢失）；
  - `toggleTodoExpanded`：只翻转 ref；已有 uiState 记录时写回 `todoExpanded`（切换标签页时由 `saveCurrentUiState` 统一落盘）。
- 注：tab ≈ conversation（标签页内对话基本不变），按 tabId 持久化与原按 conversationId 语义等价，且消除了两处互相覆盖的分叉。

### 【低 M1-2】思考计时器 100ms tick 使 v-memo 失效（MessageItem.vue）

- 计时器 100ms → **500ms**。
- 取舍说明：不把 `thinkingTimeDisplay` 从 v-memo 依赖中移除——v-memo 命中时**整个子树（含思考块头部时间徽标）被冻结**，时间文本将停止刷新，破坏「现有显示刷新体验」（问题原文约束）；降频在保留 0.5s 粒度刷新体验的同时，把思考块 v-memo 失效频率从 10 次/秒降到 2 次/秒（5× 收益），且不侵入渲染结构。若后续要彻底解耦，需把时间徽标渲染到 v-memo 边界之外（独立轻量子元素），需重构思考块头部布局，成本高于收益，本批不采纳。

### 【低 M3-2】upsertHiddenFunctionResponseMessage 绕过 rebuildMessageIndexById（messageActions.ts）

- 命中替换路径（整数组替换后）补 `rebuildMessageIndexById(state)`；
- 追加路径由 `state.allMessages.value.push(...)` 改为 `appendMessage(state, ...)`（与 appendMessage 对齐，增量维护 messageIndexById / toolResponseIndex）。

---

## 测试变更

- `frontend/src/__tests__/stores/userMessageInterrupt.test.ts`（15 用例）：
  - M3-1：投递成功记录 delivered 提示；RATE_LIMITED 记录 error 提示且不写错误条；同会话同类型去重；附件/超长/无会话不记录提示；`clearInterruptDeliveries` 只清指定会话；
  - M3-2：隐藏发送追加后 messageIndexById/toolResponseIndex 同步；命中已有同 id 时原地合并并重建索引。
- `frontend/src/components/message/__tests__/MessageItem.test.ts`（4 用例）：M1-1 `pruneBackgroundTaskViewModes` 只保留活跃 id；容量达上限后写入新记录淘汰最旧。
- 新增 `frontend/src/components/message/__tests__/MessageListUiState.test.ts`（3 用例）：M2-1 `pruneMessageListUiStateByTab` 清理逻辑；`closeTab` 关闭非活跃标签页后清理对应 UI 状态（调用链接线）；容量常量存在。

## 验证结果

- `npm --prefix frontend test`：**18 个测试文件全部通过，200/200 用例通过**（含既有 streamErrorRetry / chatRaceCondition / checkpointActions / conversationActions / CheckpointSettings 等）。
- `npm --prefix frontend run typecheck`（vue-tsc --noEmit）：**通过，0 错误**。

## 边界说明

- 新增文件（均为解决实现约束所需）：
  - `frontend/src/components/message/messageListUiState.ts`（M2-1 纯模块，避免 store→组件循环导入）；
  - `frontend/src/components/message/__tests__/MessageListUiState.test.ts`（M2-1 测试）。
- 未触碰：CHANGELOG.md、规划文档、后端、CheckpointSettings/composables、i18n 仅新增 M3-1 三个 key（三语同步）。
- M3-1 ②（后端注入点流式带回用户消息）需后端配合，本批仅出方案，前端监听分支待后端事件类型确定后接线。
