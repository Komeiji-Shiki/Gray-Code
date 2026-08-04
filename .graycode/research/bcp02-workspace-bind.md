# BCP-02：每个分支记录对应的工作区存档头节点（实施完成）

- 批次：第七阶段 BCP-02（P6b-1，无外部依赖，与 TREE-04/06、TREE-09 并行）
- 状态：**已实施 + 测试通过**
- 关联规划：`checkpoint-history-branch-architecture.plan.md` 第七阶段 L118 + 第六部分「分支与代码工作区状态」（L1584–1667）
- 前置研究：`.graycode/research/bcp-phase-research.md` 第 1 节（BCP-02 路径）；BCP-01（messageNodeId）已落地

---

## 1. 设计说明

### 1.1 目标

让每个分支节点记录「该分支（路径上）最后一次成功创建的工作区存档头节点」：
`ConversationBranchNode.workspaceCheckpointId` + `workspaceState`（字段在 `branch/types.ts`
早已预留、全仓库零赋值，本批次首次落地写入）。

### 1.2 绑定语义（固化）

- `workspaceCheckpointId` = 该节点路径上最近一次成功创建的存档 id（before/after 或连续工具
  产生的多个存档只保留最新绑定；同节点重复绑定**直接覆盖**）。
- `workspaceState`：绑定成功 → `'checkpointed'`（缺省）；可显式传其它值（`unavailable` 等，
  供 BCP-05 评估用）。`types.ts` 确认 `workspaceState` 为字符串联合
  `'unchanged' | 'checkpointed' | 'unavailable' | 'unknown'`，**非对象结构**，故接口第 4 参
  数即 `WorkspaceState`，不额外存 `{ fingerprint, updatedAt }`。
- 多节点共享：同一 checkpoint 可被多个节点绑定（before 挂父节点、after 挂子节点），
  `workspaceCheckpointId` 不做唯一性约束——BCP-06 引用计数的来源。

### 1.3 接口

```ts
// BranchService（backend/modules/conversation/branch/BranchService.ts）
async bindWorkspaceCheckpoint(
    conversationId: string,
    nodeId: string,
    checkpointId: string,
    workspaceState: WorkspaceState = 'checkpointed'
): Promise<boolean>
// true = 已绑定并落盘；false = 无图跳过 或 同 id 同 state 幂等（图未变化，不落盘）
```

行为矩阵：

| 输入情形 | 行为 |
|---|---|
| 无 sidecar（线性对话） | 返回 `false`，**不强制建图**（绑定是派生态，不因绑定创建分支图） |
| sidecar 损坏（解析 / 语义 / 活跃路径不可解） | 抛 `BRANCH_STORAGE_CORRUPT`（与其它写路径一致：拒绝覆盖可能可恢复的数据） |
| 节点不存在 | 抛 `NODE_NOT_FOUND` |
| 节点已软删（deleted） | 抛 `BRANCH_OPERATION_CONFLICT`（不复活、不写入） |
| 同 id 同 state 已绑定 | 返回 `false`（幂等，不落盘，避免工具循环高频触发 sidecar 重写） |
| 会话已删除 | 抛 `BRANCH_OPERATION_CONFLICT`（BS-4 迟到写防护，复用 assertConversationWritable） |
| 正常 | 会话写锁内读图 → 校验 → 写节点字段 → validateAndSave → 返回 `true` |

实现要点：
- 复用会话写锁（`ConversationManager.runExclusive`），与 `mutateGraph` 同锁域；但**不复用
  `mutateGraph`**（它会经 `loadGraphForWrite` 在无图时强制建线性基线，与本语义冲突），
  改为锁内直接 `repository.load` + 与 `loadGraphForWrite` 同策略的损坏/语义校验（validate +
  activePath）。
- 锁序：`createCheckpoint` 持工作区存档锁，`bindWorkspaceCheckpoint` 只取会话写锁，
  二者无嵌套（R1 死锁规避）。

### 1.4 接线（主路径 = 工具执行存档点）

`ToolExecutionService.executeFunctionCallsWithProgressCore` 的两个存档点
（before ≈L446 / after ≈L656）在 `createToolExecutionCheckpoint` 返回非空记录后，
`void this.bindWorkspaceCheckpointBestEffort(conversationId, messageNodeId, record.id)`
fire-and-forget 绑定：

- **不阻塞工具循环**：helper 返回 void、内部 `void promise.catch(...)`；失败仅
  `log.warn('bind_workspace_checkpoint_failed', {...})`（绑定是派生态，存档记录与主历史才是
  真源，与 TREE-05 `appendHistoryToGraph` 同哲学）。
- **BranchService 实例来源**：`getGlobalBranchService()`（webview BranchHandlers 注册的模块级
  单例；测试环境未注册时直接跳过，不抛错）。
- **nodeId 可得性**：两个存档点均已由 BCP-01 反查 `messageNodeId`
  （`conversationManager.getMessageNodeIdAt(conversationId, messageIndex)`），直接复用；
  nodeId 缺省（before 存档位置尚无消息等）时 helper 跳过。
- **锁序**：绑定调用放在 createCheckpoint 返回之后、以 void 丢弃，绝不 await（避免
  「存档锁 → 会话锁」嵌套等待）。

### 1.5 不做的事（本批次边界）

- 不碰 `CheckpointService`（只读确认：三个创建方法均返回 `CheckpointRecord | null`，含 `id`，
  供绑定使用——已满足，零改动）。
- 不做「分支生成完成兜底绑定」（研究 1.3③，finishReroll 查 CheckpointQueryService）——
  绝大多数场景已被工具存档点覆盖，v1 后置。
- 不做「切换离开前补建存档」（研究 1.3④，v2 与 BCP-03/04 一起评估）。
- 不做切换时的工作区联动（BCP-03 之后的事）。

---

## 2. 修改摘要

| 文件 | 改动 |
|---|---|
| `backend/modules/conversation/branch/BranchService.ts` | 新增 `bindWorkspaceCheckpoint`（会话写锁内读图 → 损坏/语义校验 → 节点存在性与软删校验 → 幂等短路 → 写字段 → validateAndSave）；导入 `WorkspaceState`；文件头职责注释补 BCP-02 |
| `backend/modules/conversation/branch/types.ts` | 仅文档：`workspaceCheckpointId` / `workspaceState` 注释固化绑定语义（同存档可多节点引用，BCP-06 引用计数据此回收） |
| `backend/modules/api/chat/services/ToolExecutionService.ts` | 新增私有 helper `bindWorkspaceCheckpointBestEffort`（fire-and-forget + log.warn）；before/after 存档点创建成功后接线（`void ...`）；导入 `Logger` 与 `getGlobalBranchService` |
| `backend/modules/api/chat/services/CheckpointService.ts` | **只读确认，零改动**（三个创建方法均返回 `CheckpointRecord \| null`，含 `id`） |
| `backend/__tests__/conversation/branchWorkspaceBind.test.ts` | **新建**，BCP-02 单元测试（9 例） |
| `backend/__tests__/tools/toolBatchCheckpoint.test.ts` | 扩展 BCP-02 集成测试（5 例）；`run` helper 增加可选 conversationId 参数 |

---

## 3. 验证结果

### 3.1 测试命令与结果

```
npx jest --config jest.backend.config.js backend/__tests__/conversation/ backend/__tests__/tools/toolBatchCheckpoint.test.ts
→ Test Suites: 31 passed, 31 total；Tests: 455 passed, 455 total

npm run typecheck（tsc -p ./ --noEmit）
→ 通过，无错误
```

### 3.2 覆盖矩阵（BCP-08 场景 1–5 + 补充）

| # | 场景 | 断言 | 位置 |
|---|---|---|---|
| 1 | 写工具执行 → before/after 存档 → 节点绑定最新 checkpointId | `node.workspaceCheckpointId === 'cp-after-2'`、`workspaceState==='checkpointed'`（after 覆盖 before） | `toolBatchCheckpoint.test.ts`「写工具执行 before/after 存档后…」 |
| 2 | 连续工具多次存档 → 绑定为最新（覆盖旧绑定） | 第二次绑定后字段为 cp-2 | `branchWorkspaceBind.test.ts`「重复绑定新存档直接覆盖」 |
| 2' | 同 id 同 state 幂等 | 返回 false 且 sidecar 文件内容不变（不落盘） | 「同 id 同 state 幂等」 |
| 3 | before 存档（nodeId undefined）→ 不绑定不抛错 | helper 短路；未注册 BranchService 时工具循环正常 | 「未注册 BranchService…绑定跳过」 |
| 4 | 线性对话（无图）工具存档 → 不强制建图、不绑定 | 返回 false 且 `repo.exists === false` | 「无图（线性对话）→ 返回 false 且不强制建图」 |
| 5 | 绑定已软删节点 → 拒绝且不复活 | `BRANCH_OPERATION_CONFLICT`、字段未写入、deleted 仍为 true | 「软删节点 → BRANCH_OPERATION_CONFLICT」 |
| 6 | 绑定失败（reject）不阻塞工具执行 | 工具循环正常完成、存档照常创建、绑定被调用（fire-and-forget） | 「绑定失败（reject）不阻塞工具执行」 |
| 7 | 绑定挂起（永不 resolve）不阻塞工具循环 | 若被 await 将超时；循环正常完成 | 「绑定挂起（永不 resolve）也不阻塞工具循环」 |
| 8 | 纯只读批次不创建存档 → 不触发绑定 | checkpoint 未调用、节点字段 undefined | 「纯只读批次不创建存档 → 不触发绑定」 |
| 补充 | 节点不存在 | `NODE_NOT_FOUND` | 「节点不存在 → NODE_NOT_FOUND」 |
| 补充 | sidecar 损坏 | `BRANCH_STORAGE_CORRUPT` 且原文件未被覆盖 | 「sidecar 损坏 → BRANCH_STORAGE_CORRUPT」 |
| 补充 | 已删除会话迟到写 | `BRANCH_OPERATION_CONFLICT`（BS-4） | 「已删除会话拒绝写」 |
| 补充 | 自定义 workspaceState 透传 | 绑定 'unavailable' 后字段正确 | 「自定义 workspaceState 透传」 |
| 补充 | 绑定持久化回读 | 新 repository 实例重读字段一致、其它节点不受影响 | 「绑定写入节点字段…并持久化回读」 |

### 3.3 回归

- `backend/__tests__/conversation/` 全量 30 个套件 + `toolBatchCheckpoint.test.ts` 全部通过
  （455 例），既有 BCP-01 / CPF-05 / TREE 语义未受影响；
- `npm run typecheck` 通过。

---

## 4. 依赖 / 后续

- **解锁**：BCP-03/04 的 `workspaceCheckpointId` 判据、BCP-06 的引用来源（存档 id → 节点引用）。
- **后续批次**：BCP-03/04/05（切换 + 工作区联动，硬依赖 TREE-06）；BCP-06（prune 联动清理，
  依赖 TREE-09）；BCP-07（共享不可变内容验证）。
- **风险备注**：绑定为 fire-and-forget，若未来改为同步 await 必须先验证锁序无死锁（R1）；
  同 id 幂等短路已避免高频工具调用时的无谓 sidecar 重写。
