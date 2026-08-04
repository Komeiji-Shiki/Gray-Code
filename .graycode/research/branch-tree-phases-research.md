# GrayCode「树状分支对话」后续实施路径研究报告

> 研究日期：规划阶段（第一~四阶段已完成，第五~八阶段待实施）
> 研究对象：`checkpoint-history-branch-architecture.plan.md`（第五~十二部分，L1242–2033）+ 现状代码
> 研究范围：`backend/modules/conversation/`（18 文件）、`backend/modules/api/chat/`（23 文件）、`backend/modules/checkpoint/`（13 文件）、`webview/`（29 文件）、`frontend/src/stores/`（31 文件）、`frontend/src/i18n/langs/zh-CN.ts`（3407 行）
> 性质：只读研究，未修改任何业务代码

---

## 目录

1. [现状盘点](#1-现状盘点)
2. [实施顺序建议（BR → TREE → BCP → MIG）](#2-实施顺序建议br--tree--bcp--mig)
3. [关键设计决策点](#3-关键设计决策点)
4. [需要主人确认的业务语义清单](#4-需要主人确认的业务语义清单)
5. [建议的模块文件划分](#5-建议的模块文件划分)
6. [风险清单](#6-风险清单)
7. [测试策略建议](#7-测试策略建议)
8. [总体结论与里程碑建议](#8-总体结论与里程碑建议)

---

## 1. 现状盘点

### 1.1 Content 结构：无 `id` / `parentId`，只有易漂移的数组下标

`backend/modules/conversation/types.ts` 的 `Content`（L317–533）当前字段：

| 字段 | 行号 | 说明 |
|---|---|---|
| `role` / `parts` | L319–321 | Gemini 格式 |
| `index?: number` | L329 | **由后端填充的数组下标**，删除/插入后经 `normalizeIndexes` 重写（`TranscriptMutation.ts` L23–31），是漂移的显示位置 |
| `timestamp` | L472 | 消息时间 |
| `modelVersion` / `usageMetadata` / `thinkingDuration` 等 | L337–404 | 仅 model 消息 |
| `isFunctionResponse` | L416 | user 消息标记 |
| `isUserInput` / `isSummary` / `isAutoSummary` | L434–464 | |
| `turnDynamicContext` | L527 | 回合动态上下文（后端内部） |

**结论：`Content` 没有稳定 ID，也没有 `parentId`**。BR-01（加 `id`/`parentId`）是纯新增，但会波及以下依赖方：

- 前端以 `Content.index` 为对齐锚（`frontend/src/stores/chat/parsers.ts` L270–272、L370–372：`content.index → Message.backendIndex`）；
- 存档以 `messageIndex` 定位（见 1.3）；
- 会话操作（删除/更新/截断）全部按 `messageIndex` 传参（见 1.2 / 1.5）。

**前端消息 ID 是临时的**：`frontend/src/stores/chat/parsers.ts` L245、L344 的 `contentToMessage`/`contentToMessageEnhanced` 均为 `id: id || generateId()`，而后端 `getMessagesPaged` 不下发 id，所以前端 `Message.id` 每次加载都会重新生成（`frontend/src/types/index.ts` L188–238）。前端内部用 `messageIndexById: Map<id, 数组下标>` 做定位（`frontend/src/stores/chat/types.ts` L155），这个映射在后端补发稳定 ID 后可直接切换到 `id → backendIndex`。

### 1.2 重试 / 编辑：目前是破坏性实现

**核心事实：重试 = 先删后生成；编辑 = 原地覆盖 + 截断。旧回答不保留，与规划 TREE-01/03 的目标直接冲突。**

后端破坏性操作：

- `ConversationManager.deleteToMessage`（`ConversationManager.ts` L1055–1076）→ `TranscriptMutation.truncateFrom`（`TranscriptMutation.ts` L55–65）：**保留 `[0, targetIndex)`，目标索引起全部删除**，并重排 index。这是 retry/edit/delete 共用的截断原语。
- `ConversationManager.deleteMessage`（L970–978）→ `deleteLogicalMessage`（`TranscriptMutation.ts` L67–90）：删除目标消息 + 匹配的 functionResponse，同样重排 index。
- `ConversationManager.updateMessage`（L919–934）：`Object.assign(history[messageIndex], updates)` **原地覆盖原消息**，编辑没有"保留原消息"语义。

三个破坏性调用链（后端）：

1. **重试**：前端先删 → `ChatHandler.handleRetryStream`（`ChatHandler.ts` L445–479）→ `ChatFlowService.handleRetryStream`（`ChatFlowService.ts` L954–1030）：`rejectAllPendingToolCalls`（L998）→ `runToolLoop`（L1013，`createBeforeModelCheckpoint:false`、`isNewTurn:false`，复用回合动态上下文）。
2. **编辑并重试**：`ChatFlowService.handleEditAndRetryStream`（L1036–1183）：`deleteCheckpointsFromIndex`（L1106）→ `updateMessage` 覆盖（L1124）→ `deleteToMessage` 截断（L1137）→ `clearTrimState`（L1142）→ before/after 用户消息存档（L1109 / L1145）→ `runToolLoop`（L1169）。非流式版 `handleEditAndRetry`（L711–816）同构。
3. **删除到消息**：`handleDeleteToMessage`（L1633–1674）：`deleteCheckpointsFromIndex`（L1654）→ `deleteToMessage`（L1657）→ `rebuildTodoListMetadataFromHistory`（L1660）→ `clearTrimState`（L1663）。

前端破坏性调用链（见 1.5）：`retryFromMessage` 在调用 `retryStream` 之前先**本地** `allMessages.slice(0, messageIndex)` + `clearCheckpointsFromIndex`（`messageActions.ts` L482–484）再调后端 `deleteMessage`（L487–490），后端截断后 `retryStream`（L550）。**旧回答在窗口和后端都消失了。**

### 1.3 消息与存档的关联：`messageIndex` 为主，`messageNodeId` 仅预留

- 存档记录 `CheckpointRecord`：`messageIndex: number`（`CheckpointManager.ts` L198）+ **`messageNodeId?: string`（L240，注释"树状分支扩展预留"）——全仓库无任何赋值点**（`search_in_files` 仅命中类型声明与 `CheckpointQueryService.ts` L113 透传）。
- 轻量摘要 `CheckpointSummary`：`messageNodeId?`（`backend/modules/checkpoint/types.ts` L122）+ `messageIndex`（L123），同样只透传。
- 创建入口只收 index：`CheckpointManager.createCheckpoint(conversationId, messageIndex, toolName, phase)`（L440–446）；调用方 `CheckpointService.createUserMessageCheckpoint`（`CheckpointService.ts` L69–117）、`createModelMessageCheckpoint`（L126–175）、`createToolExecutionCheckpoint`（L184–201），以及 `ToolExecutionService` 的 before/after 存档点（`ToolExecutionService.ts` L268–279、L455–479）。
- 按索引删除：`CheckpointManager.deleteCheckpointsFromIndex`（L1802–1820，`cp.messageIndex >= fromIndex` 过滤）。
- 增量链：`baseCheckpointId` / `backupSourceCheckpointId`（`checkpoint/types.ts` L105）——链式依赖与分支无关，BCP 阶段只需复用。

**结论：BCP-01（存档关联 nodeId）的字段管道已铺好（类型 + 透传），缺的是"Content 有稳定 id + createCheckpoint 时解析当前消息 nodeId"这一层。** 在 BR-01/BR-02 落地前，`messageNodeId` 无法被填充。

### 1.4 会话写锁机制

三层互斥，全部存在且可用：

1. **会话级写锁**：`ConversationManager.conversationWriteQueues: Map<string, Promise<void>>`（L156）+ `withConversationWriteLock`（L158–169，promise 链串行化）。绑定到 `getTranscriptRepository(conversationId)` 的 `exclusive` 参数（L192–215），因此 `appendContents`/`replaceContents`/`mutateContents`（`TranscriptRepository.ts` L71–128）全部落在锁内。
2. **分段历史写串行**：`runSegmentedHistoryWriteSerialized`（`storage.ts` L23–34）覆盖 `appendHistory`/`saveHistory`/`writeSegmentedHistory`/`deleteHistory` 等文件层写。
3. **元数据写串行**：`withMetadataWriteSerialized`（`storage.ts` L47–65，带 `METADATA_WRITE_MAX_KEYS` 淘汰）。
4. **存档操作互斥**（CP-03 完成）：`checkpointOperationLockManager.runExclusive`（`CheckpointManager.ts` L504），工作区级 + 可重入（同 owner）。

**对 BR 阶段的意义**：BR-07（分支操作进会话写锁）可直接复用 `withConversationWriteLock`；sidecar 写入还需要新增自己的写串行或复用同一把会话锁（建议复用，避免锁序问题）。注意 `withConversationWriteLock` 是私有方法，需要暴露公共包装（如 `runExclusive(conversationId, fn)`），或让 BranchService 通过现有 repository 的 mutate 路径落盘。

### 1.5 前端 retry / 编辑调用链（关键文件 + 行号）

| 操作 | 前端入口 | 关键步骤 | 后端消息 |
|---|---|---|---|
| 重试（含流式失败重试） | `messageActions.ts` `retryFromMessage` L390–571 | 本地 slice 窗口 L482–484；`clearCheckpointsFromIndex` L483；**`deleteMessage`（后端截断）L487–490**；`retryStream` L550 | `ChatHandler.handleRetryStream` L445 |
| 重试最后一条 | `retryLastMessage` L369–385 → `retryFromMessage` | 同上 | 同上 |
| 错误条重试 | `retryAfterError` L611–689 + `rollbackFailedStreamMessage` L585–598 | 先回滚半截消息 | 同上 |
| 编辑并重试 | `editAndRetry` L694–796 | **`editAndRetryStream` L772** | `handleEditAndRetryStream`（后端覆盖 + 截断） |
| 删除到消息 | `deleteMessage` L801–874 | `deleteMessage` L847–850（后端 `deleteToMessage` 语义） | `ChatHandlers.deleteMessage`（`webview/handlers/ChatHandlers.ts` L14–37：先 `abortManager.cancel(conversationId)` 再 `handleDeleteToMessage`） |
| 删除单条 | `deleteSingleMessage` L879–939 | `deleteSingleMessage` L903 | `ChatHandlers.deleteSingleMessage` L42–57 |
| 回档并重试 | `checkpointActions.ts` `restoreAndRetry` L232–368 | `previewRestore`（确认框）→ `restoreCheckpoint`（L262）→ `deleteMessage`（L287–294，失败中止）→ `retryStream`（L343–356） | `CheckpointHandlers.restoreCheckpoint`（`webview/handlers/CheckpointHandlers.ts` L74–118：先取消流 + SubAgent） |
| 回档并删除 | `restoreAndDelete` L380–472 | 同上，无 retryStream | 同上 |
| 回档并编辑 | `restoreAndEdit` L487–613 | `editAndRetryStream` L588 | 同上 |
| 跨对话创建分支 | `conversationActions.ts` `createBranchConversation` L418–473 | `conversation.createBranchConversation` | `ConversationHandlers.ts` L97–114 → `ConversationManager.createBranchConversation`（L547–625） |

UI 绑定点：`App.vue` L239（editAndRetry）、L272（retryFromMessage）；`MessageList.vue` L768（restoreAndRetry / restoreAndEdit emit）；消息菜单文案在 `zh-CN.ts` L397–400（`message.actions.branchFromHere: '从这里创建分支'`——现有唯一"分支"入口即跨对话分支）。

流式基础设施：`webview/stream/StreamAbortManager.ts`（L17–230，per-conversation AbortController + summary 控制器 + `IRunController` 适配）；`webview/types.ts` L48 的类型声明仍是 `Map<string, AbortController>`（代码里 `as any` 绕过，`.limcode/plans` 有遗留优化项）。TREE-13（流式期间分支操作互斥）可直接用 `StreamAbortManager.isActive(conversationId)`（L111–113）判定。

### 1.6 关键缺口汇总

| # | 缺口 | 现状证据 | 对应规划项 |
|---|---|---|---|
| 1 | Content 无稳定 id/parentId | `types.ts` L317–533 | BR-01 / BR-02 |
| 2 | 前端消息 id 非持久 | `parsers.ts` L245 / L344 | BR-01 的消费侧 |
| 3 | 重试 / 编辑破坏性 | `TranscriptMutation.truncateFrom` L55；`updateMessage` L928；`messageActions.retryFromMessage` L482–490 | TREE-01 / 02 / 03 |
| 4 | 存档只有 messageIndex | `CheckpointManager.ts` L198 / L240（messageNodeId 无赋值） | BCP-01 |
| 5 | 无 BranchGraph / sidecar | `conversation/history/` 仅 `HistorySegmentCache.ts`；规划第八部分列出的 HistorySegmentStore 等未拆 | BR-03~06 |
| 6 | 派生状态按数组 index 重建 | `ToolIterationLoopService.findTurnStartMessageIndex` L255；`rebuildTodoListMetadataFromHistory` `ChatFlowService.ts` L483 | TREE-06 / 07 |
| 7 | 用量索引按历史全量重建 / 追加 | `updateUsageIndex` L223、`updateUsageIndexAppend` L248；`UsageIndexStore.appendUsage` L112 | TREE-08 |
| 8 | 无分支 API / 错误码 | `ConversationHandlers.ts` 仅 createBranchConversation | 规划第七部分 |

---

## 2. 实施顺序建议（BR → TREE → BCP → MIG）

### 2.1 依赖关系图（必须先做的地基）

```
BR-01  Content.id/parentId  ←──── 一切的地基（nodeId 是后续所有 API 的入参）
  └─ BR-02  旧历史惰性补 ID（幂等迁移）
      └─ BR-03/04/05  BranchGraph 模型 + sidecar + 主历史只存活跃路径
          ├─ BR-06  分支图读写删迁移接口（依赖 03/04/05）
          ├─ BR-07  分支操作入会话写锁（依赖 06）
          ├─ BR-08  纯函数模块 + 单测（可与 04/05 并行）
          └─ BR-09  跨对话分支记 sourceNodeId（依赖 01/02，可提前）
      └─（并行线）MIG-02/03/05 旧存档/ignorePatterns 迁移（与 BR 无强依赖，可并行）
TREE-01~05  reroll/编辑分支/候选切换（依赖 BR 全量）
  └─ TREE-06/07  切换重建活跃路径 + 派生状态（依赖 04/05 的路径解析）
  └─ TREE-08  用量只统计活跃路径（依赖 04 的活跃路径定义 + UsageIndex 改造）
  └─ TREE-12  标签页快照（依赖 03 模型，前端）
BCP-01~08  存档联动（依赖 TREE 的 nodeId 定位 + BR 的 nodeId）
MIG-01  旧线性对话首分支建基线图（依赖 BR-04）
```

**关键判断**：

- **BR-01 + BR-02 是唯一必须先行的地基**，它们不改变任何用户可见行为，风险最低，且能立即解锁 `messageNodeId` 填充（1.3 节缺口 #4）。
- **BR-03/04/05 构成"分支底座"的不可分割核心**：数据模型、存储布局、主历史线性不变量三者必须一次设计到位，否则切换时重建逻辑返工。
- **可并行的线**：① BR-08（纯函数）可与 BR-04/05 并行；② BR-09（跨对话分支记 sourceNodeId）依赖极小（01/02 即可），可提前；③ MIG-02/03/05（存档 manifest 迁移、ignorePatterns 兼容、完整性检查工具）与 BR/TREE 无强依赖，可全程并行；④ BCP 内部 BCP-05/08（安全检查 + 测试）可前置到 TREE-06 之后立即做。
- **不应并行**：TREE 系列必须等 BR 全量（尤其 BR-04 的活跃路径定义）；BCP 必须等 TREE-01/03 落地（否则没有 nodeId 可关联）。

### 2.2 细化步骤表

#### Phase BR（第五阶段：稳定消息 ID 与树状分支底座）

| 步骤 | 输入 | 输出 | 依赖 | 风险 | 备注 |
|---|---|---|---|---|---|
| BR-01a 给 `Content` 加 `id?: string`、`parentId?: string \| null` | `types.ts` | 类型变更 | 无 | 低（纯类型） | `formatHistoryForAPI`（`ConversationManager.ts` L1403–1778）需确认不把 id/parentId 发给模型（processMessage 已过滤白名单字段，L1741–1747） |
| BR-01b 写入路径补 ID | `addMessage` / `addContent` / `insertContent` / `settleFunctionResponses` 插入的响应 | 所有新消息带 id | BR-01a | 中：`normalizeHistoryForDisplay`（L431–502）会插入 functionResponse，必须同步补 id；`getMessages`（L812–824）需透出 id | 在 `ConversationManager` 内部统一 `ensureNodeId(content, parent)`，避免散落 |
| BR-02 旧历史惰性补 ID | `getMessagesPaged`（L845–903）读取路径 | 无 ID 消息按顺序生成 UUID + 线性 parentId，**在会话写锁内全量重写一次** | BR-01 | 高：全量重写会触发 `updateUsageIndex`（L223）与分段重写（`writeSegmentedHistory`）；必须"检测到有缺 ID 才写"，幂等；重写后 `totalMessages` 不变 | 建议只在"显式触发"（首次加载 / 首次分支操作）时迁移，避免启动时全量扫描；迁移标记可写 metadata.custom 或依赖"全量有 id"自判定 |
| BR-03 BranchGraph 数据模型 | 规划 L1369–1426 的结构 | `branch/types.ts` | BR-01 | 低 | 单 parentId 索引、不存 childrenIds、`activeChildId` 指针 |
| BR-04 sidecar 存储 | 规划 L1428–1448：`conversations/{id}/branches.json` | `BranchGraphRepository.ts`（读 / 写 / 原子替换） | BR-03 | 中：与分段历史写入的原子性衔接（参考 `writeSegmentedHistory` 的 tmp+rename 模式，`storage.ts` L877–958）；删除对话时清理（`deleteConversation` L630–661 需扩展） | 文件布局建议：`conversations/{id}/branches.json`（第一版单文件即可） |
| BR-05 主历史只存活跃路径 | 规划 L1310–1337 | 不变量：主历史数组 = 当前活跃路径 | BR-04 | 高（设计核心）：所有下游按数组 index 的消费方（分页 / 裁剪 / API 格式化 / 用量 / 存档）继续可用 | 见 3.2 的切换重建方案 |
| BR-06 分支图读写删迁移接口 | — | `BranchGraphRepository` 的 get/save/delete/migrate + ConversationManager 包装 | BR-04/05 | 中 | 迁移接口 = BR-02 的"线性 → 单路径图" |
| BR-07 分支操作入会话写锁 | `withConversationWriteLock`（L158–169） | BranchService 所有写操作经锁 | BR-06 | 中：锁序（会话锁 ↔ 存档锁 ↔ 文件写锁）需文档化，防死锁 | 建议暴露 `conversationManager.runExclusive()` |
| BR-08 纯函数模块 + 单测 | — | `branch/BranchGraph.ts`（纯函数：insertNode / rerollCandidate / activePath / rebuild） | BR-03 | 低 | 与 04/05 并行；这是 TREE-06 路径重建的基础 |
| BR-09 跨对话分支记 sourceNodeId | `createBranchConversation`（L547–625）的 `buildBranchCustomMetadata`（L329–364） | `custom.branch.sourceNodeId`（替代 / 补充 `sourceMessageIndex` L359） | BR-01/02 | 低 | 兼容旧字段，双写过渡 |

#### Phase TREE（第六阶段：树状 reroll 与候选切换）

| 步骤 | 输入 | 输出 | 依赖 | 风险 |
|---|---|---|---|---|
| TREE-01 破坏性重试 → reroll：新增 `chat.rerollStream`（后端 `rerollFromNode`） | BR 全量 | 旧回答进 sidecar，新候选为主 | BR-04/05/07 | 高：与现有 `retryStream` 并存；前端 `retryFromMessage` 先切新 API，本地占位逻辑（L416–472）保留 |
| TREE-02 多候选 | 规划 L1255–1269 | `activeChildId` 下多个兄弟候选 + 候选摘要 | TREE-01 | 中 |
| TREE-03 编辑用户消息创建分支 | 规划 L1271–1290 | `editNodeAndContinue`：新用户节点 kind:'edit' | TREE-01 | 高：`updateMessage` 破坏性语义（L928）必须保留给旧路径，新路径走新节点 |
| TREE-04 候选左右切换 | — | `conversation.switchBranchCandidate` | TREE-06 | 中 |
| TREE-05 任意候选继续对话 | — | 在非尾节点接新子节点 | TREE-01/03 | 中 |
| TREE-06 切换重建活跃路径 | BR-08 的 activePath | 主历史全量重写（`replaceContents`） | BR-05/08 | **高**：全量重写 = 分段重写（storage L877–958）+ `updateUsageIndex`（L223）全量重建，必须与流式 / 工具循环互斥 |
| TREE-07 派生状态重建 | — | TODO 重放（`rebuildTodoListMetadataFromHistory` L483）、Build、trimState（`clearTrimState` L156 + `invalidateContextManagementState` L176）、工具响应索引 | TREE-06 | 中：`normalizeHistoryForDisplay` 会把未响应调用标 rejected（L453），切换后需先跑一遍 |
| TREE-08 用量只统计活跃路径 | — | `UsageIndexStore` 按 nodeId 过滤 / 重建 | TREE-06 | 中：`buildConversationUsageIndex`（usageStats.ts L318–332）需知道活跃 nodeId 集合 |
| TREE-09 分支删除 / 重命名 / 修剪 | — | `deleteBranchCandidate` / `renameBranch` | BR-06 | 中：软删除（deleted 标记） |
| TREE-10 候选切换器 UI | 规划 L1533–1558 | `‹ 2 / 3 ›` 组件 | TREE-04 | 中 |
| TREE-11 分支树面板 | 规划 L1560–1573 | 完整树查看 | TREE-10 | 低（第一版可后置） |
| TREE-12 标签页快照 | — | tab 快照保存 branchGraph 位置 | TREE-03 | 中 |
| TREE-13 流式期间分支互斥 | `StreamAbortManager.isActive`（L111–113） | 切换 / reroll 前检查并拒绝（BRANCH_BUSY） | TREE-01/04 | 中 |
| TREE-14 测试 | — | reroll / 编辑 / 切换 / 竞态测试 | 全量 | — |

#### Phase BCP（第七阶段：与工作区存档联动）

| 步骤 | 输入 | 输出 | 依赖 | 风险 |
|---|---|---|---|---|
| BCP-01 存档关联 nodeId | `CheckpointManager.createCheckpoint`（L440） | createCheckpoint 增加 `messageNodeId` 入参；`CheckpointRecord` / `CheckpointSummary` 填充 | BR-01 | 中：调用方（CheckpointService L69–201、ToolExecutionService L268 / L455）需能由 index 反查 nodeId |
| BCP-02 分支记录工作区存档头节点 | — | `ConversationBranchNode.workspaceCheckpointId` | BCP-01 | 中 |
| BCP-03 切换代码分支的恢复语义 | — | 复用 `restoreCheckpoint` / `previewRestore`（`CheckpointManager.ts` L1145+、`CheckpointHandlers.ts` L61–118） | BCP-02 | 高：恢复前取消流 / SubAgent 的既有逻辑（CheckpointHandlers L82–102）必须原样纳入 |
| BCP-04 双模式切换 | — | 仅聊天 / 聊天 + 工作区 | BCP-03 | 高：需主人确认默认行为（见第 4 节） |
| BCP-05 工作区无法安全恢复时禁止静默切换 | — | 复用 `previewRestore` 失败路径 + 链断裂检测（L1426） | BCP-03 | 中 |
| BCP-06 分支删除按引用计数清理存档 | — | `checkpointReferenceCount` 或扫描所有 BranchGraph | BCP-01 | 中：与 `deleteCheckpointsBatch` 祖先闭包（L1802–1820）并存 |
| BCP-07 存档共享不可变内容 | — | 分支间复用 `backupSourceCheckpointId`（manifest L105） | BCP-06 | 低（现有增量链已天然共享） |
| BCP-08 一致性测试 | — | 聊天分支 ↔ 工作区状态矩阵测试 | 全量 | — |

#### Phase MIG（第八阶段：迁移、测试与发布）

| 步骤 | 输入 | 输出 | 依赖 | 风险 |
|---|---|---|---|---|
| MIG-01 旧线性对话首分支建基线图 | BR-02 的惰性迁移 | 首次分支时把线性历史导入 BranchGraph（kind:'imported'） | BR-04 | 中：只迁移被分支对话，不做全量启动扫描 |
| MIG-02 旧存档 → manifest 模式 | — | 复用 `CheckpointManifestRepository`（已有） | 无 | 低（CPF-01 已完成主路径） |
| MIG-03 旧 `ignorePatterns` 兼容 | — | `ignoreSnapshot` 回退 | 无 | 低 |
| MIG-04 迁移版本号 + 回滚 | — | BranchGraph `version`、迁移状态机 | BR-04 | 中 |
| MIG-05 完整性检查工具 | — | 历史 / 存档 / sidecar 一致性扫描 | BR-06 | 中 |
| MIG-06 三语文案 | zh-CN.ts / en.ts / ja.ts（各 3406–3407 行，`languageParity.test.ts` 会强制对齐） | 新增分支 / 切换 / 存档联动文案 | TREE-10 / BCP-04 | 低（但注意三语 key 必须同步，否则测试失败） |
| MIG-07 后端 Jest + 前端 Vitest + typecheck + build | — | 全绿 | 全量 | — |
| MIG-08 README / CHANGELOG `[Unreleased]` | — | 文档 | 全量 | 低 |
| MIG-09 性能基准 | 规划第十一部分三组工作区 | 基准报告 | TREE-06 | 中 |

---

## 3. 关键设计决策点

### 3.1 BranchGraph 存哪：sidecar 文件格式

**推荐**：沿用规划 L1428–1448 的布局，但按现状目录微调（现状 `FileSystemStorageAdapter` 的会话目录是 `conversations/{id}/`，见 `getConversationDir` `storage.ts` L585–591、`getConversationsRootDir` L617–625）：

```
conversations/
  {conversationId}/
    history.index.json          （现有，分段索引）
    history/                    （现有，分段）
    branches.json               （新增：BranchGraph 全量）
```

设计要点：

1. **单文件 JSON 即可**（第一版节点数有限，规划 L1448 也同意不过度设计）；`branches.json` 内含 `version`、`rootNodeId`、`activeTailNodeId`、`nodes` 记录、`activeChildId` 指针、候选摘要（供 `getCandidateSummaries` 免读主历史）。
2. **原子写**：复用 `writeSegmentedHistory` 的 tmp + rename 模式（`storage.ts` L877–958 的 `tmpIndexPath` / `renameOverwrite` L659–670），**并且 branches.json 与主历史必须同锁写**（BR-07），否则崩溃后主历史与图不一致。
3. **内容冗余策略**：非活跃节点在 sidecar 存**完整 Content 副本**（含 parts / usageMetadata），因为主历史删除后它就是唯一真源；活跃路径节点只存摘要或引用主历史 index（切换时以主历史为准重建节点 detail，见 3.2）。此设计让"主历史重写"与"sidecar 更新"解耦。
4. **损坏恢复**：branches.json 解析失败时回退"线性模式"（视所有主历史消息为单路径），并标记 `BRANCH_STORAGE_CORRUPT`（规划 L1705 错误码），不阻塞读取。
5. **删除对话**：`deleteConversation`（`ConversationManager.ts` L630–661）需加 sidecar 删除（与快照 / diff 清理并列，L641–660 模式）。

### 3.2 主历史只保留活跃路径：切换时如何重建

**不变量**（规划 L1310–1337）：主历史 `Content[]` 永远是"根 → 活跃子 → … → 活跃尾"的线性路径；非活跃分支只在 sidecar。

切换流程（TREE-06）建议落地为：

1. 读 sidecar → `BranchPathResolver.resolve(rootNodeId → targetNode → activeTail)`（BR-08 纯函数）。
2. **在会话写锁 + StreamAbortManager 检查后**（TREE-13）执行：`repository.replaceContents(activePathContents)`（`TranscriptRepository.ts` L91–99，全量重写分段）。
3. 重建派生状态：`clearTrimState`（`ContextTrimService.ts` L156–158）+ `invalidateContextManagementState`（`ConversationManager.ts` L176–182）→ `rebuildTodoListMetadataFromHistory`（`ChatFlowService.ts` L483）→ 用量索引全量重建（`updateUsageIndex` L223）→ 存档 `messageIndex` 重映射（见 3.3）。
4. 前端收到新最后一页 + 候选摘要，`switchConversation` 或专用 `loadHistory` 路径刷新窗口（`conversationActions.ts` L700–797 可复用）。

**关键坑**：

- `normalizeHistoryForDisplay`（L431–502）会在读取时插入 rejected functionResponse 并改变长度——**重建后的活跃路径必须先在锁内跑一遍规范化再落盘**，否则路径 nodeId 与主历史 index 错位。
- `turnDynamicContext`（L527，回合缓存）属于旧路径时需随切换失效。
- 分页（`getMessagesPaged` L845–903）基于数组 index，重建后天然正确，无需改动——这正是"主历史只存活跃路径"的价值。

### 3.3 reroll 与现有 checkpoint 定位：`messageIndex` vs `nodeId` 衔接

现状：存档用 `messageIndex` 定位（1.3 节），删除按 `messageIndex >= fromIndex` 过滤（`CheckpointManager.ts` L1802–1820）。

**衔接策略（避免一次性全量迁移）**：

1. **双写过渡**：`createCheckpoint` 增加 `messageNodeId` 入参后，**记录同时写 `messageIndex`（现状值）和 `messageNodeId`（新值）**；读取端（`CheckpointQueryService` L112–115）已透传两者，前端可逐步切到 nodeId。
2. **reroll 语义**：reroll 创建新候选时，**不删除**旧路径的存档（旧候选仍可切回），只把 `activeChildId` 指向新候选；新候选路径上的工具继续按新 index 建存档。此时"删除候选"才触发 `deleteCheckpointsByNodeId`（按 nodeId 闭包删，替代 L1802 的 index 过滤）。
3. **切换重建时的重映射**：主历史被替换后，`messageIndex` 对旧节点失效；**凡涉及恢复（restoreAndRetry 等，`checkpointActions.ts` L232–368）的入参一律改为 `nodeId`**，后端先 `nodeId → 当前活跃路径 index` 再走既有 `restoreCheckpoint` / `deleteCheckpointsFromIndex`。这样 BCP 阶段不需要重写恢复引擎，只加一层解析。
4. **`preserveCheckpointId` 语义保留**：回档场景（L1106 / L1654 的 preserve）继续按 checkpointId 保留，与 nodeId 无冲突。
5. **兼容性红线**：**旧存档无 messageNodeId 时，切换 / 删除回退 index 匹配**，并打 warn；MIG-05 完整性工具扫描"nodeId 悬空存档"。

### 3.4 旧数据迁移的幂等策略

BR-02（旧历史补 ID）+ MIG-01（首分支建图）+ MIG-04（版本 / 回滚）统一原则：

1. **惰性触发，不做启动全扫**：仅在 ①首次读取分页时检测"存在无 id 消息"、②首次分支操作时，才执行迁移。迁移在会话写锁内一次性完成并落盘（含分段重写 + 用量索引重建），之后"全量有 id"作为幂等判据（自判定，无需额外标记文件）。
2. **确定性 ID 生成**：对旧消息用 `uuidv5(namespace=conversationId, seed=role+index+timestamp)` 或顺序 UUID——**同一历史多次迁移必须产出同一 ID 集合**，这是幂等的硬要求；`parentId` 线性链接（规划 L1357–1361）。
3. **先读后写校验**：迁移前记录 `totalMessages` + 内容哈希；写回后回读校验长度与首尾消息指纹，失败回滚到 tmp 备份（复用 `writeSegmentedHistory` 的 tmp 目录 L884）。
4. **MIG-04 版本化**：BranchGraph `version` 字段 + 迁移函数注册表（`migrate(v1→v2)`），sidecar 损坏时降级线性模式（3.1 节），保证可恢复中间状态。
5. **MIG-02/03（存档迁移）已由 CPF-01 / EX-10 完成主路径**（manifest 独立、ignoreSnapshot 快照），剩余是旧记录读取兼容（`ignorePatterns` 回退），风险低，可与 BR 并行。

---

## 4. 需要主人确认的业务语义清单

**规划第十二部分（L1954–2008）原有 7 项**（单文件上限、默认排除目录、回档删文件、分支切换默认模式、非活跃分支用量、删除分支软 / 硬、候选数量上限），其中**前 3 项已在 Phase 1–3 解决**（50 MiB 上限 `DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES`、排除类别 `CheckpointExclusionProfiles`、回档确认框 `previewRestore` + `deleteUntrackedFiles`）。**真正待确认的是后 4 项 + 以下结合代码现状新增的决策点**：

### A 组：规划第十二部分遗留（第 4–7 项）

1. **分支切换默认模式**：BCP-04 的默认值——规划推荐"默认只切聊天 + 检测到写工具时提示"。需要确认：检测"该分支执行过写工具"的判据（按 BranchGraph 节点 `workspaceCheckpointId` 存在性？按工具名列表？）。
2. **非活跃分支用量**：规划推荐"主页只统计活跃路径 + 另提供所有候选总用量"。需要确认 TREE-08 首版是否只做前者（实现简单），后者后置。
3. **删除分支**：规划推荐软删除。需要确认软删除的保留期 / 手动清理入口（TREE-09）。
4. **候选数量上限**：规划推荐不自动删、超限提示。需要确认上限默认值（如每父节点 10 个候选）。

### B 组：结合代码现状新增的决策点

5. **旧破坏性行为的去留**：TREE-01 上线后，`retryStream` / `editAndRetryStream` 是否保留为内部兼容（错误通知重试 `retryAfterError` 走 reroll 吗）？建议：`retryAfterError`（`messageActions.ts` L611）与 `rollbackFailedStreamMessage`（L585）先保留现状，仅主流程切 reroll，后续版本清理。
6. **"删除到消息"（deleteToMessage）与 reroll 的关系**：现有"删除到某条消息"是显式破坏性操作（UI 有入口），reroll 上线后它是否保留为"硬删除"？建议保留（用户显式操作 ≠ 重试），但要同步更新分支图（该点之后的子树整体移除或软删）。
7. **回档并重试 / 删除 / 编辑与分支的交互**：回档恢复的是工作区文件，历史截断后原分支是否保留？建议：回档并重试 = 在目标 nodeId 上创建 reroll 候选 + 恢复存档（把现有 `restoreAndRetry` 的 deleteMessage 换成 reroll 语义），**旧分支保留**；"回档并删除"才真正移除分支。
8. **`isFunctionResponse` 消息是否成为独立节点**：functionResponse 是 user 角色、配对工具调用（`TranscriptMutation.ts` L33–53 配对逻辑）。BranchGraph 中它建议**不单独成节点**（依附于所属 model 节点的子记录或并入主历史 index 映射），否则 reroll 后配对会乱。需确认此建模选择。
9. **跨对话分支（BR-09）与树内分支的关系**：现有"从这里创建分支"（`createBranchConversation`，`ConversationManager.ts` L547–625）复制历史到新对话。它和"树内 reroll"是两套机制——是否需要把"复制为新对话"也纳入 BranchGraph（节点 kind:'exported'）？建议：仅记录 `sourceNodeId`（BR-09），不强耦合。
10. **流式失败半截消息在 reroll 下的处理**：`retryAfterError` 现在回滚半截消息（L585–598）；reroll 后失败的新候选是否保留为"失败的候选"（可切回查看错误）还是自动清理？建议：保留为候选 + 标记失败，符合"失败可切回"（规划 L1471）。

---

## 5. 建议的模块文件划分

**规划第八部分（L1715–1759）的蓝图 + 现状目录的落地清单**：

### 5.1 backend/modules/conversation/branch/（新建，规划 L1735–1746）

```
backend/modules/conversation/branch/
  types.ts                    // ConversationBranchGraph / ConversationBranchNode / BranchErrorCode
                              //   （规划 L1374–1406、L1703–1711）
  BranchGraph.ts              // 纯函数：insertNode / rerollCandidate / editCandidate / activePath /
                              //   rebuildActivePath / childrenIndex / validate（BR-08，可单测）
  BranchPathResolver.ts       // nodeId → 活跃路径 Content[] 解析；nodeId ↔ messageIndex 双向映射
                              //   （TREE-06 / 3.3 节）
  BranchGraphRepository.ts    // branches.json 读写 / 原子替换 / 损坏降级线性模式（BR-04/06）
  BranchService.ts            // 业务编排：rerollFromNode / editNodeAndContinue / switchBranchCandidate /
                              //   deleteBranchCandidate / renameBranch / getCandidateSummaries
                              //   （BR-07 锁内）
  BranchMigration.ts          // 线性历史 → BranchGraph 首次建图（MIG-01）、版本迁移状态机（MIG-04）、
                              //   旧历史惰性补 ID（BR-02）
  index.ts                    // 模块导出
```

### 5.2 backend/modules/conversation/（改造）

```
ConversationManager.ts        // Content 写入统一 ensureNodeId（BR-01b）；暴露 runExclusive 公共锁包装（BR-07）；
                              //   deleteConversation 清理 sidecar；createBranchConversation 记 sourceNodeId（BR-09）
storage.ts                    // FileSystemStorageAdapter 增加 branches.json 路径与原子写
                              //   （或由 BranchGraphRepository 独立实现，建议独立）
TranscriptMutation.ts         // 增加 truncateToNode / deleteNodeSubtree 纯函数（或迁移到 branch/ 后引用）
types.ts                      // Content.id / parentId（BR-01a）；CheckpointRecord 关联补充
UsageIndexStore.ts / usageStats.ts   // TREE-08：按活跃 nodeId 集合过滤
```

### 5.3 backend/modules/api/chat/（改造）

```
services/ChatFlowService.ts   // rerollStream 新流程（替代 / 并存 handleRetryStream L954）；
                              //   editNodeAndContinue（L1036 改造）
services/ToolIterationLoopService.ts  // 切换后重建钩子；findTurnStartMessageIndex（L255）改为 nodeId 兼容
services/ToolExecutionService.ts      // 存档创建传 messageNodeId（L268 / L455）
services/CheckpointService.ts         // createCheckpoint 透传 nodeId；deleteCheckpointsByNodeId
services/ContextTrimService.ts        // 切换时统一失效（复用 clearTrimState L156）
api/types.ts / api/index.ts           // 分支 API 请求 / 响应类型（规划 L1687–1698）
```

### 5.4 webview/（扩展宿主侧）

```
handlers/BranchHandlers.ts    // 新建：conversation.getBranchGraph / getCandidateSummaries /
                              //   switchBranchCandidate / deleteBranchCandidate / renameBranch /
                              //   createBranchConversation（BR-09 增强）/ chat.rerollStream /
                              //   chat.editBranchAndRetryStream（注册进 handlers/index.ts）
handlers/ConversationHandlers.ts  // loadConversationForView 增加 branchGraph / 候选摘要（L139–164）
stream/StreamAbortManager.ts  // 已具备 isActive（L111），TREE-13 直接复用
types.ts                      // 顺手修正 streamAbortControllers 类型（L48，去除 as any）
```

### 5.5 frontend/src/（webview UI 侧）

```
stores/chat/state.ts / types.ts      // Message 增加 nodeId / parentId / candidates 元数据；messageIndexById 保留
stores/chat/messageActions.ts        // retryFromMessage（L390）改 reroll 调用；editAndRetry（L694）改 editNodeAndContinue
stores/chat/checkpointActions.ts     // restoreAndRetry / Edit / Delete 入参改 nodeId（L232 / L380 / L487）
stores/chat/branchActions.ts         // 新建：候选切换、分支删除 / 重命名、候选摘要拉取
stores/chat/tabActions.ts            // TREE-12：快照保存分支位置
components/message/MessageList.vue   // 候选切换器 `‹ 2/3 ›`、消息菜单扩展（TREE-10）
components/branch/BranchGraphPanel.vue  // 新建：分支树面板（TREE-11，可后置）
i18n/langs/zh-CN.ts / en.ts / ja.ts  // 三语同步（MIG-06；languageParity.test.ts 强制 key 对齐）
```

### 5.6 测试文件

```
backend/__tests__/conversation/branchGraph.test.ts        // BR-08 纯函数
backend/__tests__/conversation/branchRepository.test.ts   // sidecar 读写 / 损坏 / 迁移
backend/__tests__/conversation/branchReroll.test.ts       // TREE-01/02/03/05
backend/__tests__/conversation/branchSwitch.test.ts       // TREE-06/07/13
backend/__tests__/checkpoint/checkpointNodeId.test.ts     // BCP-01/06
frontend/src/stores/chat/__tests__/branchActions.test.ts  // TREE-14
```

---

## 6. 风险清单

### 6.1 迁移风险

- **R1 旧历史补 ID 的全量重写**（BR-02）：长对话（≥200 条）会触发分段全量重写 + 用量索引重建，窗口期崩溃可能留下"部分有 id"状态 → 缓解：tmp 原子写 + 回读校验 + 自判定幂等（3.4 节）；迁移与写入共用 `runSegmentedHistoryWriteSerialized` 锁。
- **R2 迁移后 index 漂移**：`normalizeHistoryForDisplay`（L431–502）在迁移前 / 后插入 functionResponse 会改变长度 → 缓解：迁移在锁内先规范化再补 id；nodeId 与 index 的映射只在切换时重建，不长期缓存。
- **R3 sidecar 与主历史不一致**（崩溃 / 手动编辑）→ 缓解：版本号 + 损坏降级线性模式（3.1 节）+ MIG-05 完整性工具。

### 6.2 并发风险

- **R4 reroll 与工具循环竞态**：reroll 创建候选时旧流可能还在写历史（`StreamAbortManager` 只管理流，不管理已落库的工具结果）→ 缓解：TREE-13 用 `isActive` 前置拒绝 + reroll 进入会话写锁 + 复用 `cancelStream → rejectAllPendingToolCalls` 的既有竞态防护（`ConversationManager.ts` L750–751 注释）。
- **R5 分支切换与存档恢复并发**：切换触发工作区恢复（BCP-03）时，与 `checkpointOperationLock` / 文件写锁的锁序 → 缓解：BCP 阶段文档化锁序（会话锁 ⊂ 存档锁 ⊂ 文件写锁），复用 `CheckpointHandlers.restoreCheckpoint` 的"先取消流 + SubAgent"（L82–102）。
- **R6 迟到 chunk 污染新分支**（规划测试项 L1893）→ 缓解：reroll 新候选使用新 streamId；旧流的 chunk 处理器按 `_lastCancelledStreamId` / `streamingMessageId` 校验（`messageActions.ts` L548–549 已有模式）。

### 6.3 性能风险

- **R7 切换重建成本**：`replaceContents` 全量重写分段 + 用量索引重建（TREE-06）在 20k 消息量级可达秒级 → 缓解：切换期间前端 loading（参考 `restoreAndRetry` 的 `isRestorePreviewing` 模式）；用量索引改为"仅失效、惰性重建"。
- **R8 sidecar 膨胀**：每个候选存完整 Content 副本，多候选大附件（inlineData base64）会翻倍磁盘 → 缓解：候选共享不可变 parts 引用（JSON 引用或去重，第一版可接受冗余，MIG-09 基准验证）；规划 L1448 也同意第一版不过度设计。
- **R9 branches.json 每次 chunk 写**：流式期间频繁更新候选节点会反复写 sidecar → 缓解：流式期间只更新内存 + 完成 / 中止时一次性落盘（规划 L1468–1470 同款）。

### 6.4 兼容性风险

- **R10 前端旧消息无 id**：旧历史经 BR-02 前被前端加载，`Message.id` 仍临时 → 缓解：BR-02 优先在首次加载时触发；前端 `messageIndexById` 回退逻辑保留。
- **R11 旧存档无 messageNodeId**（3.3 节红线）→ 缓解：回退 index 匹配 + warn + MIG-05 扫描。
- **R12 发送给模型的字段泄漏**：`formatHistoryForAPI`（L1403–1778）必须过滤 `id` / `parentId`（processMessage L1741–1747 白名单需扩展）→ 测试覆盖"API 请求体中无分支字段"。
- **R13 SubAgent 子对话**：`TranscriptRepository` 被 SubAgent 复用（`ConversationTranscriptRepository` L131），加 ID 逻辑会波及 SubAgent transcript——建议 SubAgent 不建 BranchGraph，只保证有 id（BR-01 统一入口覆盖）。
- **R14 三语文案同步**：`languageParity.test.ts`（backend/__tests__/i18n）强制 key 对齐，新增文案必须三语同步提交，否则 CI 红。

---

## 7. 测试策略建议

**层次**（参照规划第十部分 L1879–1895 + 现状测试基建）：

1. **纯函数单测**（BR-08，最高优先级，TDD）：`BranchGraph` 的 insert / reroll / activePath / validate、`BranchPathResolver` 的路径重建、`BranchMigration` 的幂等（同一输入迁移两次 ID 一致）。落 `backend/__tests__/conversation/`，沿用 `MemoryStorageAdapter`（`storage.ts` L241–367）。
2. **仓储单测**：branches.json 原子写、损坏降级、与分段历史同锁；崩溃恢复（参照 `storageAppend.test.ts`、`storageSegmentedWrite.test.ts` 模式）。
3. **会话级集成测试**（后端）：reroll 保留旧回答；多候选；编辑分支保留旧子树；切换重建活跃路径后 `getMessagesPaged` / `formatHistoryForAPI` / `getHistoryWithContextTrimInfo` 输出正确；`updateUsageIndex` 只含活跃路径；切换后 TODO / Build 重建（参照 `ConversationManager.branch.test.ts`、`ConversationManager.appendAndMetadata.test.ts`）。
4. **竞态测试**：流式期间切换被拒（TREE-13）；迟到 chunk 不污染（R6）；reroll 与工具循环并发（R4）；分支操作与存档恢复锁序（R5）——参照 `subagentFileLockConflict.test.ts`、`CheckpointOperationLock.test.ts` 的并发模式。
5. **前端 Vitest**：`branchActions.test.ts`（候选切换状态、reroll 乐观更新、失败回滚）；改造现有 `checkpointActions.test.ts`（入参 nodeId 后断言不变）；`retryFromMessage` 新行为（不再调用 `deleteMessage`）回归（现有 `conversationActions.test.ts` / `tabActions.test.ts` 需同步）。
6. **跨层契约测试**：`messageRouterNonBlocking.test.ts`（webview/backend）中的 STREAM_TYPES 列表（L23）新增 `rerollStream` 时更新；IPC 载荷里 nodeId 透传。
7. **性能基准**（MIG-09）：按规划第十一部分三组工作区，重点记录候选切换耗时（R7）、追加写入字节数（R9）、sidecar 磁盘占用（R8）。
8. **完整性工具测试**（MIG-05）：构造"主历史与 sidecar 不一致""nodeId 悬空存档"用例，验证工具检出且不破坏数据。

---

## 8. 总体结论与里程碑建议

1. **地基确认**：前四阶段（CP / EX / CPF / HIS）已为分支功能铺好全部底层设施——分段历史 append-only 写入（HIS-01）、会话写锁（`ConversationManager.ts` L158）、存档互斥锁（`CheckpointManager.ts` L504）、恢复取消流 / SubAgent（`CheckpointHandlers.ts` L82–102）、`messageNodeId` 预留字段（`CheckpointManager.ts` L240）。**当前没有任何阻塞项，Phase 5 可以直接开工。**
2. **最小可行里程碑**：
   - M1 = BR-01/02（稳定 ID，无用户可见变化）
   - M2 = BR-03~08（分支底座 + 纯函数）
   - M3 = TREE-01/02/04/06（reroll + 候选切换，主用户价值）
   - M4 = TREE-03/05/07/08（编辑分支 + 派生状态一致）
   - M5 = BCP 全量
   - M6 = MIG 全量
3. **最大技术风险集中在 TREE-06（切换重建）与 BCP-03（工作区联动）**，两者都建议先写纯函数 / 预览（参照 `computeRestorePlan` 的先例），再接入写路径。
4. **需要主人先拍板的 4 个产品语义**（第 4 节 A 组）：分支切换默认模式、非活跃分支用量口径、删除分支软 / 硬、候选上限——这些会直接影响 BCP / TREE 的接口签名，建议在 M2 结束前确认。
