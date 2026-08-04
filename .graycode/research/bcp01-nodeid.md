# BCP-01 存档关联 messageNodeId + MIG-01 核实

- 批次：第七阶段 BCP-01 前置（本批次只「填充」messageNodeId，不做按 nodeId 的删除/恢复重构）
- 状态：完成
- 关联：`checkpoint-history-branch-architecture.plan.md` BCP-01 条目；`.graycode/research/branch-tree-phases-research.md` 1.3 节（字段管道已铺好、缺赋值点）与 2.2 节（BCP-01 行）

---

## 1. 设计说明

### 1.1 目标

`CheckpointRecord.messageNodeId?: string`（`backend/modules/checkpoint/types.ts` L328）与
`CheckpointSummary.messageNodeId?`（L122）此前只有类型与透传（`CheckpointQueryService.toSummary`
L137），**全仓库无赋值点**。本批次把「由消息索引反查稳定节点 ID → 写入存档记录」真正接上。

### 1.2 原则（与任务红线一致）

- **附加字段，不回退 index 定位**：`messageNodeId` 只是双写过渡的一部分（研究 3.3 节「双写过渡」），
  `messageIndex` 仍是主定位键；删除/恢复路径不改（仍按 index / checkpointId）。
- **旧存档兼容**：旧记录无 `messageNodeId` 时读取端已透传 `undefined`，不回填历史数据。
- **before 存档语义**：`before` 存档的索引 = 「即将插入」位置（`history.length`），该位置通常
  尚无消息 → 反查返回 `undefined` → 记录无 nodeId，**不阻塞、不改变创建行为**。
- **最小侵入**：`CheckpointManager.createCheckpoint` 只扩 `options`，不动位置参数；
  `ToolExecutionService` 构造器新增第 5 个可选参数，既有调用点（含全部测试）零改动。

### 1.3 反查辅助（ConversationManager）

新增公开方法：

```ts
async getMessageNodeIdAt(conversationId: string, index: number): Promise<string | undefined>
```

- 读原始历史（`loadHistory`）；命中 BR-02 判据（存在无 id / parentId 未定义的消息）时
  先 `ensureHistoryNodeIds`（写锁内幂等迁移，确定性 id）再重读；
- 返回 `history[index]?.id`；负索引 / 非整数 / 越界 / 消息无 id → `undefined`。

选择「放 ConversationManager」而非在调用方各自拼装：迁移判据与补 ID 都是 ConversationManager
私有能力，放这里避免把 BR-02 细节泄漏给 CheckpointService / ToolExecutionService。

### 1.4 接线拓扑（谁反查、谁传值）

| 层 | 反查 | 传值 |
|---|---|---|
| `CheckpointService.createUserMessageCheckpoint` / `createModelMessageCheckpoint` | 是（内部，用最终确定的 index） | `createCheckpoint(..., { messageNodeId })` |
| `CheckpointService.createToolExecutionCheckpoint` | 显式 `messageNodeId` 参数优先；未传时内部按 `messageIndex` 反查（兜底） | 合并 progress + messageNodeId 进 options |
| `ToolExecutionService` before/after 存档点（原 L268/L455） | 是（注入了 ConversationManager 时） | `createToolExecutionCheckpoint(..., messageNodeId)` 第 5 参 |

生产接线现状：`ChatHandler`（不在本批次文件边界内）未给 `ToolExecutionService` 注入
ConversationManager → 生产路径上 ToolExecutionService 传 `undefined` → 由
`CheckpointService.createToolExecutionCheckpoint` 兜底反查，**行为正确**；
ToolExecutionService 侧反查作为显式路径存在（测试覆盖 + 未来接线即用），两处不会重复反查
（`messageNodeId ?? await ...` 短路）。

### 1.5 CheckpointManager 变更

```ts
async createCheckpoint(
    conversationId: string,
    messageIndex: number,
    toolName: string,
    phase: 'before' | 'after',
    options?: {
        progress?: (progress: CheckpointOperationProgress) => void;
        messageNodeId?: string;   // BCP-01 新增
    }
)
```

记录构建处新增 `messageNodeId: options?.messageNodeId`。`undefined` 时 JSON 序列化自然省略该键，
与旧记录形态一致。`CheckpointRecord` / `CheckpointSummary` 类型无需改动（字段早已预留）。

---

## 2. 修改摘要

### 生产代码（均在任务文件边界内）

1. **`backend/modules/checkpoint/CheckpointManager.ts`**
   - `createCheckpoint` `options` 增加 `messageNodeId?: string`（含 JSDoc）；
   - 记录字面量在 `messageIndex` 后写入 `messageNodeId: options?.messageNodeId`（带注释）。

2. **`backend/modules/conversation/ConversationManager.ts`**
   - 新增公开 `getMessageNodeIdAt(conversationId, index)`（置于 `getMessagesRaw` 之后，
     「消息操作」小节内；复用私有 `loadHistory` / `ensureHistoryNodeIds` / `needsNodeIdMigration`）。

3. **`backend/modules/api/chat/services/CheckpointService.ts`**
   - `createUserMessageCheckpoint`：before / after 两个分支在确定 `index` 后反查 nodeId 并透传；
   - `createModelMessageCheckpoint`：同上（before 的「即将插入」位置反查结果通常为 undefined，不阻塞）；
   - `createToolExecutionCheckpoint`：新增可选位置参数 `messageNodeId?: string`（在 `options` 之前），
     显式值优先，否则内部按 `messageIndex` 反查；progress 与 messageNodeId 合并进 options。

4. **`backend/modules/api/chat/services/ToolExecutionService.ts`**
   - 构造器新增可选第 5 参 `conversationManager?: ConversationManager`（JSDoc 注明未注入时由
     CheckpointService 兜底）；
   - before / after 两个存档调用点：注入时 `getMessageNodeIdAt(conversationId, messageIndex)`
     反查并以第 5 参传入 `createToolExecutionCheckpoint`。

### 测试（均在边界内）

5. **`backend/__tests__/checkpoint/CheckpointManager.test.ts`** 新增 `describe('BCP-01: createCheckpoint messageNodeId 关联')`：
   - `options.messageNodeId` 写入记录并透传到摘要（`getCheckpoints` 回读断言）；
   - 不传时记录与摘要无该字段（旧存档兼容），`messageIndex` 不回退。

6. **`backend/__tests__/checkpoint/CheckpointQueryService.test.ts`** 新增用例：新记录 `messageNodeId`
   透传、旧记录缺省、两者都保留 `messageIndex`。

7. **`backend/__tests__/api/CheckpointService.test.ts`**（新增）：
   - user/model message 反查 index → nodeId 透传；
   - before 反查不到（越界）时 nodeId 缺省不阻塞；
   - tool execution 显式 nodeId 优先（不再反查）、未传时按索引反查、反查不到时 manager 收到空 options；
   - progress 与 messageNodeId 可同时透传。

8. **`backend/__tests__/api/conversationMessageNodeId.test.ts`**（新增，直接测 `getMessageNodeIdAt`）：
   - 已带 id 历史按索引返回；
   - 旧历史（无 id/parentId）触发 BR-02 迁移后返回确定性 id、幂等、parentId 线性补齐；
   - 越界（before「即将插入」位置）/ 负索引 / 非整数 / 空历史 → undefined。
   - 注：该测试 `jest.mock` 掉 `branch/BranchService`（本测试与分支图无关；分支目录正被并行批次
     改造，避免把其未完成状态拖入）。

9. **`backend/__tests__/tools/toolBatchCheckpoint.test.ts`** 新增 2 用例：
   - 注入 conversationManager 时 before/after 存档调用第 5 参携带反查 nodeId（索引为消息索引）；
   - 未注入时第 5 参为 `undefined`（CheckpointService 兜底，兼容旧调用）。
   - `createEnv` 增加可选 `conversationManager` 透传，原有用例全部保持。

---

## 3. 验证结果

### 3.1 测试

| 范围 | 结果 |
|---|---|
| `backend/__tests__/checkpoint/` 全目录（13 suites） | ✅ 210 passed（含新增 BCP-01 用例） |
| `backend/__tests__/api/` 全目录（4 suites，含新增 CheckpointService / conversationMessageNodeId） | ✅ 全绿 |
| `backend/__tests__/tools/` 全目录（33 suites） | ✅ 378 passed（含新增 BCP-01 用例） |
| ToolExecutionService 其他消费方（agentSendMessage / outsideWorkspaceAccess / diffReviewConfirmation / subagentFileLockConflict / diffApplicationAlgorithms 等） | ✅ 全绿（构造器加可选参数无破坏） |

任务要求的重点命令（等价已覆盖）：

```text
npx jest --config jest.backend.config.js backend/__tests__/checkpoint/CheckpointManager.test.ts
npx jest --config jest.backend.config.js backend/__tests__/tools/toolBatchCheckpoint.test.ts
→ 均通过；checkpoint/api/tools 受影响模块全绿
```

### 3.2 tsc

`npx tsc -p ./ --noEmit`：**exit 0，全仓库零错误（含本批次全部文件）**。

### 3.3 环境注意事项（并行批次，已解除）

- `branch/` 目录正被 reroll/互斥批次并行修改（任务已声明不碰）。期间观察到其进行中状态：
  先是 `BranchService.ts` 引用不存在的 `renameNode`/`updateNodeContent` 导出，后是 `BranchGraph.ts`
  的 `updateNodeContent` 缺 `ContentPart`/`UsageMetadata` import（本次会话内多次变化），导致
  `tsc` 与 `backend/__tests__/tools/diffApplicationAlgorithms.test.ts`（依赖链
  `apply_diff → modules/conversation(index) → ConversationManager → branch/BranchService → branch/BranchGraph`）
  暂时失败；该依赖链为本批次改动前即存在，与本次改动无关。
- **终态：并行批次完成后 `tsc` exit 0、tools 33/33 suites 全绿，本批次未对 branch/ 做任何修改。**

---

## 4. MIG-01 核实结论（旧线性对话首分支建基线 BranchGraph）

**结论：已覆盖，无需补码。** 证据（`backend/modules/conversation/branch/BranchService.ts`）：

1. `loadGraphForWrite`（L534–548）：sidecar 无图时以主历史 `importLinearHistory(history)` 建线性
   基线图——注释明确「无 sidecar：以主历史建线性基线图（主历史是活跃路径的唯一真源）」；
   `mutateGraph`（L520–531）注释「无图：以主历史建线性基线图（首次分支惰性建图，MIG-01）」。
   所有分支写操作（reroll / edit / switch / delete / rename / export 记录）都经 `mutateGraph`，
   因此**旧线性对话任意首次分支操作都会惰性建基线图**，且只迁移被分支的对话（不做全量启动扫描）。
2. `initializeBranchConversation`（BR-09，L446–461）：跨对话「复制为新对话」时把目标对话主历史
   全量导入为 `kind:'imported'` 节点并记录 `exportedFrom`；由 `ConversationManager.createBranchConversation`
   （L857）接线，且先 `ensureHistoryNodeIds` 保证 id 就绪。
3. `validateActivePathMatchesHistory`（L391–394）在无图且主历史非空时明确报告
   「branch graph is missing while main history has messages (first branch op will build baseline)」，
   与上述惰性建图设计一致。
4. `importLinearHistory`（`BranchGraph.ts` L80–123）：每条消息一个节点、parentId 线性链接、
   functionResponse 合并进前一个节点（决策 8）、消息无 id 时有确定性兜底（调用方先
   `ensureHistoryNodeIds`，仅防异常输入）。

无缺口：迁移触发点（`mutateGraph` / `initializeBranchConversation` / `recordExport` 前均先
`ensureHistoryNodeIds`）、惰性范围（只迁移被分支对话）、幂等性（BR-02 自判定）均满足 MIG-01
「首次分支时把线性历史导入 BranchGraph（kind:'imported'）」要求。

---

## 5. 后续（明确不在本批次）

- 按 nodeId 的删除 / 恢复（`deleteCheckpointsByNodeId` 闭包删等）→ TREE 之后；
- `ChatHandler` 给 `ToolExecutionService` 注入 `conversationManager`（可选接线，非必需——
  CheckpointService 兜底已保证生产行为）；
- BCP-02~08（分支记录工作区存档头节点等）。
