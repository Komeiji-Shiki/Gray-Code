# TREE-03 + TREE-05：编辑用户消息分支 + 候选继续对话

> 批次：第六阶段 TREE-03/05（后端流程；前端 UI 属 TREE-10/11）
> 日期：2026-08-04
> 规划依据：`checkpoint-history-branch-architecture.plan.md` 第六阶段 L102/L104、第五部分 L1484–1508（编辑并重试流程）、已确认决策 4/7/10（L2026–2032）
> 研究依据：`.graycode/research/branch-tree-phases-research.md` 2.2 节 TREE 行、3.3 节；`.graycode/research/tree01-02-reroll.md`（reroll 底座编排结构，本批次复用同一套）

---

## 一、设计说明

### 1. 目标与边界

- **TREE-03**：新增 `chat.editBranchStream` 后端流程（`ChatFlowService.handleEditBranchStream` + `ChatHandler.handleEditBranchStream` + webview `chat.editBranchStream` handler），编辑用户消息时创建新的用户消息分支，**不覆盖原消息**（决策 7 与 TREE-03 语义：旧分支完整保留）。
- **TREE-05**：普通消息追加路径对分支图的语义——主历史 append 时若会话已有分支图，把新消息增量并入图（切回候选后继续对话不破坏图）。`appendHistoryToGraph` 由 FIX-G3 批次在 `BranchService` 落地（本批次开始后已就位），本轮在 `ConversationManager.appendContents` 接调用点。
- **决策 10 精神**：流式失败保留旧候选（编辑候选/模型候选保留为失败形态，可切回查看）。
- 不触碰：branch/BranchService.ts、BranchGraph.ts（修复批次在改；`editCandidate` 已存在直接用，缺方法写报告）；checkpoint/排除/工具循环内部（ToolExecutionService 只读）；前端（TREE-10/11）；CHANGELOG.md；规划文档。

### 2. TREE-03 主流程（ChatFlowService.handleEditBranchStream）

```
1. 确保对话 + 验证配置 + newText 非空校验（与 reroll 一致）
2. 中断未完成 diff 等待 + rejectAllPendingToolCalls（与 reroll 一致）
3. 解析并校验编辑目标（resolveEditTargetNode 纯函数，可单测）：
   ├─ 显式 userNodeId：图模式校验「存在 + 在活跃路径 + role==='user' + 非根节点」；
   │   线性模式（无图）以主历史为活跃路径，父节点取前一个非 functionResponse 消息
   │   （与 importLinearHistory 线性链接规则一致，决策 8）
   ├─ 缺省：活跃路径最后一条可编辑用户消息
   └─ 错误码：缺失 NODE_NOT_FOUND；非 user / 不在活跃路径 / 根节点 → INVALID_BRANCH_RELATION
4. BranchService.editCandidate(parentNodeId, { role:'user', parts:[{text:newText}] })
   ├─ 新 user 节点 kind='edit' + 激活 + 摘要（旧用户节点及其子树完整保留进 sidecar——
   │   先建图后截断，线性模式首次建图不丢旧消息，与 startReroll 同序）
5. BranchService.createRerollCandidate(newUserNodeId, { parts: [] })
   ├─ 模型候选占位（流式结果写入此节点；createRerollCandidate 是当前唯一可用的模型节点
   │   创建入口，kind 固定为 'reroll'——BranchService 无 startEditBranch 公共方法，见 §4）
6. 主历史截断到旧用户节点之前（父节点保留，旧子树整体移出主历史；图侧已保留）
7. 追加编辑后的用户消息（id = 新用户节点 id，BR-01 同源：节点 id == Content.id；
   isUserInput: true，时间戳 now）
8. 复用工具循环 runToolLoop（isNewTurn: true——编辑后用户消息内容变化，与
   editAndRetryStream 一致；createBeforeModelCheckpoint 默认开启；isFirstMessage: false——
   根节点不可编辑，编辑目标必有父节点）
9. finally：BranchService.finishReroll(modelCandidateNodeId) 等价回填
   ├─ 首条模型消息 → 模型候选内容写入（必要时重命名对齐消息 id，BR-01 同源）
   ├─ 后续模型消息 → kind='continue' 续接节点（激活 + 更新尾指针）
   ├─ functionResponse → parts 并入前一个模型节点（决策 8）
   └─ 摘要维护；失败也回填（决策 10 精神）
```

### 3. TREE-05 接线（ConversationManager.appendContents 调用点）

- **接入点**：`getTranscriptRepository().appendContents` 委托（主历史 append-only 落盘成功后、`updateUsageIndexAppend` 之后）。
- **语义**：仅当会话已有分支图时增量并入（`appendHistoryToGraph` 内部对无图会话返回 false 不建 sidecar）；线性对话保持线性。
- **锁边界（关键）**：`appendContents` 委托运行在会话写锁内（仓储互斥执行器），而 `appendHistoryToGraph` 内部自行 `runExclusive` 取同一把锁（锁**不可重入**，promise 链串行）——在委托内 `await` 会死锁。因此采用 **fire-and-forget（void + try/catch）**：图同步 promise 排在当前写锁任务之后串行执行，保证「主历史追加 → 图增量」顺序且不与其他写操作交错；失败仅告警（主历史为唯一真源，图同步失败由下次读图/写图自校验兜底）。
- **流式窗口期跳过（占位候选守卫）**：reroll/编辑分支的流式窗口期，图活跃尾是空占位候选（kind='reroll'/'edit' 且 parts 为空，内容由 finishReroll 回填）。若此时把工具循环追加的模型消息也并入图，finishReroll 的「重命名占位节点对齐消息 id」会撞重复节点 id（`renameNode` 抛 INVALID_BRANCH_RELATION）——实测会让既有 branchReroll 16 用例挂 6 个。因此接线在同步前读图检查：**活跃尾是空占位候选 → 跳过，由 finishReroll 回填**；正常继续对话（活跃尾有内容，如候选已生成完毕）→ 增量并入。
- **测试同步技巧**：图同步为最终一致，测试用「轮询 + runExclusive(no-op) 排队」等待同步完成（runExclusive no-op 只保证先于它入队的任务完成，故需轮询）。

### 4. 关键设计决策与取舍

1. **模型候选节点复用 createRerollCandidate（kind='reroll'）**：BranchService 现有 `editCandidate` 只创建 user 节点，无「编辑场景的模型候选」公共方法（缺 `startEditBranch`）。用 `createRerollCandidate(newUserNodeId, {parts:[]})` 创建占位，finishReroll 回填——语义正确，但节点/摘要 kind 为 'reroll' 而非 'edit'。**遗留**：建议修复批次补 `startEditBranch`（或允许 editCandidate 链式创建模型候选并标 kind='edit'），TREE-09 也可在软删/标记能力里校正 kind。
2. **根节点（首条用户消息）不可编辑**：计划语义是「在旧用户节点的父节点下创建新候选」，根节点无父节点（parentId=null），图模型单根不变量下无法挂兄弟候选 → 明确拒绝 INVALID_BRANCH_RELATION（消息说明无父节点）。旧破坏性 `editAndRetryStream` 仍可原地覆盖首条消息（决策 5 兼容路径）。
3. **主历史截断 + 追加两段式（非原子）**：与 startReroll 同款——图变更（会话写锁）→ 截断（deleteMessagesInRange 自带锁）→ 追加（addContent 自带锁），中间窗由 finishReroll 回填兜底；TREE-13 流式互斥已关掉并发窗。
4. **id 对齐（BR-01 同源）**：编辑候选 user 节点在图中先建（随机 UUID），追加进主历史时显式带同一 id（ensureNodeId 保留既有 id），保证「节点 id == Content.id」；模型候选沿用 finishReroll 的重命名对齐机制。
5. **TREE-05 与 reroll/edit 流式窗口的冲突解决**：占位候选守卫（§3）——而非「无条件同步」。备选方案「无条件同步 + finishReroll 容忍重复」依赖改 BranchService/BranchGraph（本批次禁改），未采用；已写入报告供修复批次参考。
6. **失败保留（决策 10 精神）**：流式失败/中断时 finishReroll 仍执行：模型候选保留为空或半截（preview 为空/半截），旧分支（旧 user 节点 + 旧 model 子树）完整保留且 `switchBranchCandidate` 可切回。
7. **与 reroll/retry 并存**：未改 `handleRerollStream`/`handleRetryStream`/`handleEditAndRetryStream` 行为；editBranchStream 为独立新 API。编辑分支后可再 reroll 编辑出的回答；reroll 分支后也可再编辑（测试覆盖）。
8. **webview handler 形态**：`chat.editBranchStream` 注册在 `ChatHandlers.ts`（普通 handler 路径），内部复用 `StreamChunkProcessor`（streamChunk/streamChunkBatch 协议）转发 chunk，先懒初始化全局 BranchService（与 rerollStream 同模式），`{started:true}` 响应。**已知限制**：未加入 `MessageRouter.STREAM_MESSAGE_TYPES`，长流期间占用消息队列——TREE-10 前端切换时需升级为流式消息类型（与 rerollStream 同）。

### 5. 错误码

| 场景 | 错误码 |
|---|---|
| newText 缺失/空白（handler 与 flow 双层校验） | `EDIT_BRANCH_INVALID_ARGS` |
| 配置缺失 / 禁用 | `CONFIG_NOT_FOUND` / `CONFIG_DISABLED`（与 reroll 一致） |
| 目标节点缺失 | `NODE_NOT_FOUND` |
| 非 user / 不在活跃路径 / 根节点 / 无可编辑用户消息 | `INVALID_BRANCH_RELATION` |
| sidecar 损坏拒绝 | `BRANCH_STORAGE_CORRUPT`（flow 快速失败 + appendHistoryToGraph 拒写） |
| 分支服务未注册 | `BRANCH_SERVICE_UNAVAILABLE` |
| 每父节点候选超限（10） | `BRANCH_OPERATION_CONFLICT`（editCandidate 既有校验） |
| 已删除会话迟到写 | `BRANCH_OPERATION_CONFLICT`（appendHistoryToGraph 的 BS-4 校验） |

---

## 二、修改摘要

| 文件 | 改动 |
|---|---|
| `backend/modules/api/chat/services/ChatFlowService.ts` | 新增 `EditBranchRequestData` / `EditTargetResolution`；导出纯函数 `resolveEditTargetNode`（+`findLinearParentId`，可单测）；新增 `handleEditBranchStream` 生成器（newText 校验 → 配置校验 → diff 中断/拒绝挂起工具调用 → 目标校验 → editCandidate → createRerollCandidate 占位 → 主历史截断+追加编辑后消息（id 对齐）→ runToolLoop → finally finishReroll 回填+摘要，失败也回填）；导入 branch 模块（BranchError/activePath/isFunctionResponseMessage/ConversationBranchGraph） |
| `backend/modules/api/chat/ChatHandler.ts` | 新增 `handleEditBranchStream` 流式方法（转发 ChatFlowService 输出；ChannelError 取消 → cancelled；其余 → formatError），导入 `EditBranchRequestData` |
| `webview/handlers/ChatHandlers.ts` | 新增 `editBranchStream` handler（入参校验、先取消同会话旧流、懒初始化全局 BranchService、StreamChunkProcessor 转发 chunk、`{started:true}` 响应）；注册 `chat.editBranchStream` |
| `backend/modules/conversation/ConversationManager.ts` | **TREE-05 最小接线**：`appendContents` 委托在落盘成功后，若注册了全局 BranchService 则以 fire-and-forget 调用 `appendHistoryToGraph`（仅当会话有分支图；**空占位候选（reroll/edit 且 parts 空）跳过**，避免与 finishReroll 重命名冲突；不可重入锁 → 不 await，失败仅告警） |
| `backend/__tests__/conversation/editBranch.test.ts` | 新建（13 用例，风格对齐 branchReroll.test.ts）：编辑保留原分支、编辑后生成新回答（finishReroll 回填/重命名/摘要/续接/BR-05）、失败保留（决策 10）、与 reroll 并存（编辑后再 reroll、reroll 后再编辑）、编辑目标校验（NODE_NOT_FOUND / INVALID_BRANCH_RELATION 矩阵）、线性模式 FR 父节点跳过、候选上限（决策 4）、TREE-05 接线（有图增量并入 / 无图不建 / 流式窗口期跳过）、webview handler 注册与入参校验 |

未触碰：CHANGELOG.md、规划文档、branch/BranchService.ts 与 BranchGraph.ts（仅调用既有 `editCandidate`/`createRerollCandidate`/`finishReroll`/`appendHistoryToGraph`）、前端（TREE-10/11）、checkpoint/排除/工具循环内部。

## 三、验证结果

- `npm run typecheck`（tsc -p ./ --noEmit）✅ 通过
- `npx tsc --noEmit -p tsconfig.test.json` ✅ 通过
- `npx jest --config jest.backend.config.js backend/__tests__/conversation/ backend/__tests__/webview/`
  ✅ **34 suites / 393 tests 全绿**（含新增 `editBranch.test.ts` 13 项；branchReroll 16 项回归通过——TREE-05 接线未破坏 TREE-01/02 流式窗口语义）
- 新增测试明细（`editBranch.test.ts`）：
  1. 编辑保留原分支（决策 7/TREE-03）：旧 user 节点 + 旧 model 子树进 sidecar（kind='imported' 内容不变），新 user 节点 kind='edit' 文本=编辑后内容，父=旧 user 节点的父节点并激活；主历史 = [..父, 新 user 节点]（id 对齐 + isUserInput）
  2. 编辑后生成新回答：模型候选重命名对齐消息 id、functionResponse 合并（决策 8）、续接节点、摘要更新、BR-05 主历史 id 链 == 活跃路径
  3. 失败保留（决策 10）：流式无输出 → 模型候选保留为空、编辑后用户消息仍在、旧分支 `switchBranchCandidate` 可切回
  4. 与 reroll 并存：编辑分支后再 reroll 编辑出的回答（旧 A 保留）；reroll 分支后也可再编辑
  5. 编辑目标校验（resolveEditTargetNode）：缺失 NODE_NOT_FOUND；非 user / 不在活跃路径 / 根节点 → INVALID_BRANCH_RELATION；缺省取活跃路径最后一条可编辑用户消息
  6. 线性模式（无图）校验：主历史即活跃路径；父节点向前跳过 functionResponse（决策 8）；根节点拒绝
  7. 候选上限（决策 4）：编辑候选计入每父节点 10 上限，第 11 个拒绝（BRANCH_OPERATION_CONFLICT）不自动删
  8. TREE-05：有分支图时 append 增量并入图（新消息挂活跃尾，BR-05 仍成立——切回候选后继续对话不破坏图）
  9. TREE-05：无分支图时 append 不建图（线性对话不产生 sidecar）
  10. TREE-05：reroll 流式窗口期 append 不并入图（空占位候选跳过，finishReroll 正常回填不撞重复 id）
  11. webview handler：`chat.editBranchStream` 注册；缺少 conversationId/configId/newText → EDIT_BRANCH_INVALID_ARGS

## 四、遗留与依赖说明（不属于本批次）

- **`appendHistoryToGraph` 已由 FIX-G3 落地**（本批次开始后确认），调用点已按任务要求在 `ConversationManager.appendContents` 接线；其「方法级实现、调用点后续接线」注释与本批次完成项一致。
- **缺少 `startEditBranch` 公共方法**（BranchService 边界外）：模型候选复用 `createRerollCandidate`，节点/摘要 kind='reroll'（语义应为 'edit'）。建议修复批次补专用方法，TREE-09 亦可校正 kind。
- **根节点（首条用户消息）编辑暂不支持**（图模型单根约束），旧 `editAndRetryStream` 兼容路径保留（决策 5）。
- **TREE-05 主场景依赖 TREE-06**：「切回候选后继续对话」的前置是 TREE-06 切换时重写主历史（`switchBranchCandidate` 目前只切图指针不重写主历史）；本批次完成了 append 侧接线（有图增量并入 + 流式窗口跳过），切换侧待 TREE-06。
- **从空失败候选继续对话不并入图**（占位守卫的边界）：空占位是失败候选（决策 10），用户应切换/reroll，TREE-09 处理失败候选标记。
- 前端 `chat.editBranchStream` 调用与候选切换器 UI 属 TREE-10/11；handler 需升级 MessageRouter 流式消息类型（与 rerollStream 同）。
- 流式期间互斥已由 TREE-13 覆盖（BranchHandlers 三个变更 handler 前置 BRANCH_BUSY 检查）；editBranchStream 走流式取消前置（handler 先 cancel 同会话旧流）。
