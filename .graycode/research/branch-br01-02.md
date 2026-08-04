# 第五阶段树状分支地基 T5a（BR-01 + BR-02）设计说明与验证结果

> 日期：第五阶段批次 T5a
> 范围：稳定消息节点 ID（BR-01）+ 旧历史惰性补 ID（BR-02）
> 参考：`checkpoint-history-branch-architecture.plan.md`（第五阶段 BR-01/BR-02 条目、第三部分「稳定消息节点 ID」L1341–1367）、
> `.graycode/research/branch-tree-phases-research.md`（1.1 / 2.2 节 BR 行、3.4 节迁移幂等）
> 分支底座 BR-03/04/08 已完成（`backend/modules/conversation/branch/`，本批次只读参考未改动）

---

## 1. 设计说明

### 1.1 数据模型（BR-01a）

`backend/modules/conversation/types.ts` 的 `Content` 新增两个可选字段（旧数据完全兼容）：

```ts
id?: string          // 稳定消息节点 ID
parentId?: string | null   // 父消息节点 ID（主历史线性链：前一条消息的 id，首条为 null）
```

- 保持可选：旧历史反序列化不报错，`id`/`parentId` 缺失即视为「待迁移」。
- 均为后端内部字段：`formatHistoryForAPI` 的 `processMessage` 是白名单构造（仅
  `role/parts/isUserInput/turnDynamicContext(+strategy)`），`id`/`parentId` 天然不会下发；
  `SummarizeService.cleanMessagesForSummarize` 同样是白名单（role/parts/isSummary）。
  已在新增测试中锁定「API 请求体不含 id/parentId」。

### 1.2 写入路径统一补 ID（BR-01b）——`ensureNodeId(content, parent)`

在 `ConversationManager` 内新增私有 `ensureNodeId(content, parent)`：

- `id`：已有则保留，否则 `crypto.randomUUID()`（新写入用随机 UUID，迁移才用确定性 ID）；
- `parentId`：`undefined` 时取 `parent?.id ?? null`；显式 null/string 保留。

**append-only 路径（关键设计）**：`addMessage` / `addContent`（非 functionResponse）/ `addBatch`
走 `TranscriptRepository.appendContents`。仓储的互斥执行器（会话写锁）会包住整个 append 委托调用，
因此在 `getTranscriptRepository` 的 `appendContents` 委托内（锁内）读取尾消息（`loadHistoryPage(limit=1)`，
分段存储只读最后一段，成本有界）→ 依次 `ensureNodeId(content, previous)` 形成线性 parentId → 落盘。
**不需要修改 `TranscriptRepository.ts` 接口**，且并发追加时 parentId 始终指向真实上一消息
（尾读与写入同锁，杜绝「两个并发 append 基于同一旧尾」的错链）。

**mutate / 全量重写路径**：`normalizeHistoryForDisplay`、`rejectToolCalls`、
`rejectAllPendingToolCalls`、`settleFunctionResponses` 插入的 functionResponse、
`insertContent` / `insertMessage` 插入的内容，都在 mutator 内就地 `ensureNodeId`（mutate 已读全量，
父消息 id 可直接取 `history[index-1]`，零额外成本）。

**透出**：`getMessages` / `getMessagesPaged` 本就深拷贝除 `turnDynamicContext` 外的全部字段，
`id`/`parentId` 自动随消息下发，前端据此稳定消息身份。

### 1.3 旧历史惰性补 ID（BR-02）——`ensureHistoryNodeIds`

**触发点（显式，不做启动全扫）**：

1. `getMessagesPaged` 首次加载（initial page）：把原 `hasUnresolvedFunctionCalls` 浅扫描升级为
   `scanHistoryForInitialPage`，单次全量读同时检测「悬空 functionCall」与「缺 id」，
   命中才分别走 `normalizeHistoryForDisplay` / `ensureHistoryNodeIds`（正常历史零额外深拷贝，维持 HIS-13 收益）；
2. `getMessages`、`getHistory`：在已加载数组上做纯 O(n) 判据检查，命中才迁移；
3. `createBranchConversation`：源历史先迁移再复制（首次分支操作也是触发点，BR-09 sourceNodeId 依赖）。

**迁移流程（会话写锁内，全量重写一次）**：

- 幂等判据：`needsNodeIdMigration(history)` = 存在 `id` 缺失 或 `parentId === undefined`
  （迁移后「全量有 id 且 parentId 已定义」= 自判定幂等，无需额外标记文件）；
- 确定性 ID：`deterministicNodeId(namespace=conversationId, seed=role+index+timestamp)`
  （RFC 4122 v5 风格，SHA-1 + 版本/变体位）——同一历史多次迁移产出同一 ID 集合（幂等硬要求）；
- 线性 parentId：按数组顺序，`parentId[i] = id[i-1]`（首条 null）；**已有非空 parentId 保留**；
  `i>0` 处显式 null 视为遗留产物（读取时插入的 functionResponse 在父消息尚无 id 时被置 null），迁移修复为前一条 id；
- 落盘：复用 `storage.saveHistory`（分段 tmp+rename 原子写）+ `updateUsageIndex` 全量重建（与 replaceContents 同路径）；
- 先读后写校验：迁移前记录 `totalMessages` + 首尾结构指纹（不含 id/parentId），写回后回读校验
  两者不变，不一致抛错（原子写保证失败不留下部分迁移状态）。

### 1.4 前端透传（最小改动）

`frontend/src/stores/chat/parsers.ts`：

- `contentToMessage` / `contentToMessageEnhanced` 的 `Message.id` 优先级改为
  `显式 id 参数（流式替换） → content.id（后端稳定 id） → generateId()（旧数据 fallback）`；
- 前端 `Content` 类型未声明 `id`（文件边界限制），用文件内 `getContentNodeId(content)` 安全读取；
- `messageIndexById`（`Map<Message.id, 数组下标>`）无需改动：`Message.id` 变稳定后该映射天然跨
  加载稳定；无 id 旧消息仍走 generateId，行为与改动前一致。

### 1.5 已知边界（后续批次处理）

- **insert 不重写后续消息 parentId**：插入摘要/消息时只设置插入内容的
  `parentId = 前一条消息 id`，不修改后续消息——树语义上后续消息的父仍应是其创建时的前驱
  （摘要只是压缩插页）；严格链修复属于 TREE-06 `rebuildActivePath` 范畴。
- **SubAgent transcript 不补 id**（`backend/tools/subagents/` 不在本批次边界），其展示路径本就
  用 `runId_contentIndex` 合成 id，不受影响；前端对无 id 内容保持 generateId fallback。
- **BR-02 迁移不写标记文件**：以「全量有 id」自判定，后续读取 O(n) 判据为 false 即跳过，无落盘。

---

## 2. 修改摘要

| 文件 | 变更 |
|---|---|
| `backend/modules/conversation/types.ts` | `Content` 新增 `id?: string`、`parentId?: string \| null`（含文档注释） |
| `backend/modules/conversation/ConversationManager.ts` | 新增 `deterministicNodeId`（导出）、`ensureNodeId`、`needsNodeIdMigration`、`computeHistoryFingerprint`、`readTailContent`、`ensureHistoryNodeIds`（公开）、`buildMigratedHistory`、`toDisplayMessages`、`scanHistoryForInitialPage`；append 委托锁内补 id+parentId；getMessages/getHistory/getMessagesPaged/createBranchConversation 惰性迁移触发；normalizeHistoryForDisplay/rejectToolCalls/rejectAllPendingToolCalls/settleFunctionResponses/insertContent/insertMessage/addContent(FR) 插入内容补 id；processMessage 白名单注释（id/parentId 不下发） |
| `frontend/src/stores/chat/parsers.ts` | `getContentNodeId` 安全读取 + 两个 converter 的 `Message.id` 优先级（显式 id → content.id → generateId） |
| `backend/__tests__/conversation/nodeIdMigration.test.ts` | **新增 22 用例**（见 §3） |
| `frontend/src/stores/chat/__tests__/parsers.test.ts` | **新增 5 用例**（透传/优先级/fallback） |
| `backend/__tests__/conversation/ConversationManager.branch.test.ts` | 更新 1 处断言：分支复制历史现在携带稳定 id + 线性 parentId（新预期行为），其余字段与源一致 |

未改动（按约束）：`TranscriptRepository.ts` / `TranscriptMutation.ts`（设计上无需扩展——
append 委托已在会话写锁内）、`storage.ts`（分段落盘格式不变，id 只是 Content 字段）、
`branch/`、CHANGELOG、规划文档、checkpoint / subagents / 前端其他文件。

---

## 3. 验证结果

### 3.1 后端（任务指定命令）

```
npx jest --config jest.backend.config.js backend/__tests__/conversation/
```

- **19 suites / 217 tests 全部通过**（既有 195 + 新增 22）。
- 新增覆盖：
  - `deterministicNodeId` 确定性/区分度/UUID v5 格式；
  - 写入路径补 id：addMessage 链式 parentId、addContent/addBatch、addContent(FR)、
    insertContent/insertMessage、settleFunctionResponses、normalizeHistoryForDisplay 插入 FR、
    rejectToolCalls 插入 FR；
  - 读取透出：getMessages / getMessagesPaged（内存 + 分段 paged 快路径）带 id；
  - formatHistoryForAPI / getHistoryForAPIFrom 不含 id/parentId；
  - 迁移：首次加载触发、**幂等硬要求（两次迁移 ID 集合一致）**、迁移后不再重写（saveHistory spy）、
    getHistory/getMessages 触发、部分迁移（已有 id 保留）、paged 快路径、悬空调用+缺 id 并存、
    **迁移失败抛错且不留下部分状态（原子性）**、createBranchConversation 先迁移源。

### 3.2 前端（任务指定命令）

```
npm --prefix frontend test
```

- **15 files / 160 tests 全部通过**（既有 155 + 新增 parsers 5）。
- 新增覆盖：contentToMessage/contentToMessageEnhanced 透传 content.id、显式 id 参数优先、
  无 id 回退 generateId、空字符串 id 视为缺失。

### 3.3 类型检查

```
npx tsc -p ./ --noEmit             → 0 错误
npx tsc -p tsconfig.test.json --noEmit → 0 错误
npm --prefix frontend run typecheck    → 0 错误（vue-tsc）
```

### 3.4 文件边界合规

- 仅修改任务清单内文件 + 新增两个测试文件；`git status` 确认未触碰 `storage.ts`、
  `branch/`、checkpoint、subagents、CHANGELOG、规划文档及前端其他文件。

---

## 4. 备注

- 实现中修正的一个设计点：读取时插入的 functionResponse 若父消息当时无 id，会被 `ensureNodeId`
  置 `parentId=null`；迁移的线性链修复把「i>0 且 parentId 为 null」视为遗留产物并改为前一条 id，
  否则迁移后会出现错误的「多根」节点（有对应测试锁定）。
- `getMessagesPaged` 首次加载的浅扫描由「只查悬空调用」扩展为「悬空调用 + 缺 id」双检测，
  仍是单次全量读、无深拷贝，正常历史零额外写。
- 迁移全量重写复用既有分段原子写（tmp+rename），与 `replaceContents` 同一落盘路径；
  写回后回读校验 totalMessages 与首尾指纹，失败抛错，不留下部分迁移状态。
