# TREE-13/14：流式期间分支操作互斥 + 竞态测试框架

> 阶段：第六阶段 TREE-13 + TREE-14（部分）
> 日期：2026-08-04
> 关联规划：`checkpoint-history-branch-architecture.plan.md`（TREE-13/14 + 分支错误码 L1703–1711）
> 关联研究：`.graycode/research/branch-tree-phases-research.md`（TREE-13 行：用 `StreamAbortManager.isActive` 判定）

---

## 1. 设计说明

### 1.1 问题

流式生成期间（主会话 `chatStream` / `retryStream` / `editAndRetryStream` 进行中），若用户同时触发分支变更类操作（reroll / 切换候选 / 删除候选），会出现两类竞态：

1. **R4 竞态**：reroll/切换创建候选时旧流仍在写历史，分支图与主历史不一致；
2. **R6 竞态**：旧流迟到的 chunk 继续追加主历史，污染新分支。

### 1.2 方案（handler 层前置互斥，最小改动）

- **判定源**：`webview/stream/StreamAbortManager.isActive(conversationId)`（L111–113，只统计主流请求的 controllers Map，summary 请求不拦截）。
- **拦截位置**：`webview/handlers/BranchHandlers.ts` 三个变更类 handler（`createRerollCandidate` / `switchBranchCandidate` / `deleteBranchCandidate`）在入参校验之后、调用 BranchService 之前，检查 `isConversationStreaming(ctx, conversationId)`；活跃时 `sendError(requestId, 'BRANCH_BUSY', '会话正在流式生成中，请等待完成后再操作')` 并提前返回。
- **只读放行**：`getBranchGraph` / `getBranchGraphMeta` 不拦截（读取不产生写竞态）。
- **与主会话工具循环的互斥（需求 3 结论）**：已读代码确认 `BranchService` 全部写操作（createRerollCandidate / editCandidate / switchBranchCandidate / deleteBranchCandidate / saveBranchGraph / recordExport / initializeBranchConversation / validateActivePathMatchesHistory）都在 `conversationManager.runExclusive()` 会话写锁内（BR-07 语义，见 `BranchService.mutateGraph` L520–531 及各方法）。**锁在服务内部已保证**，因此 handler 层只需 `isActive` 前置检查，无需重复加锁。
- **类型适配**：`HandlerContext.streamAbortControllers` 类型声明为 `Map<string, AbortController>`，实际注入的是 `StreamAbortManager` 实例（`ChatViewProvider` L580/803：`streamAbortControllers: this.messageRouter.getAbortManager() as any`，与 `ChatHandlers` / `CheckpointHandlers` 既有 `as any` 模式同源）。守卫采用结构判定：`isActive` 存在优先走 `isActive`，否则按纯 Map 的 `has()` 兜底。不修改 `webview/types.ts`（不在本批次文件边界）。
- **导出复用**：`BRANCH_BUSY_STREAMING_MESSAGE` 与 `isConversationStreaming` 导出，供 reroll 批次新增 `chat.editBranchAndRetryStream` / `chat.rerollStream` handler 时直接复用同一守卫（当前 `editCandidate` 只有服务方法、无 handler，故本批次只守卫已注册的 3 个变更 handler）。
- **错误码**：`BRANCH_BUSY` 已存在于 `branch/types.ts`（L45），无需改动。

### 1.3 测试框架（TREE-14 起步）

| 文件 | 层次 | 覆盖 |
|---|---|---|
| `backend/__tests__/webview/branchHandlers.test.ts`（扩展） | handler 单测 | TREE-13 互斥矩阵：流式中 reroll/switch/delete 被拒（BRANCH_BUSY + 固定文案 + 不调用 service）；流式结束后放行；只读不受影响；会话粒度隔离；纯 Map 兜底；入参校验优先于 BRANCH_BUSY |
| `backend/__tests__/conversation/branchRace.test.ts`（新建） | 集成 + 服务层 | 守卫层 `isConversationStreaming`（真实 StreamAbortManager create/delete 状态迁移）；流式期间三操作集成被拒且图零污染；流式结束后三操作成功；服务层写锁互斥矩阵（并发 reroll+删除、并发 switch 两目标，串行化无丢失）；**迟到 chunk 不污染新分支（R6 基础用例）** |

Mock 方式：测试注入**真实 `StreamAbortManager` 实例**（与生产注入方式一致），通过 `create(conversationId)` / `delete(conversationId)` 模拟流式开始/结束，不 mock 类本身——比假对象更贴近生产语义（`delete` 后 `isActive` 必然为 false，覆盖"流式结束放行"的关键路径）。

---

## 2. 修改摘要

### 2.1 `webview/handlers/BranchHandlers.ts`（唯一业务代码改动）

- 新增 `export const BRANCH_BUSY_STREAMING_MESSAGE = '会话正在流式生成中，请等待完成后再操作'`。
- 新增 `export function isConversationStreaming(ctx, conversationId)`：优先 `StreamAbortManager.isActive`，纯 Map 按 `has()` 兜底。
- 新增私有 `rejectIfStreaming(ctx, conversationId, requestId)`：活跃时发 `BRANCH_BUSY` 错误并返回 true。
- `createRerollCandidate` / `switchBranchCandidate` / `deleteBranchCandidate`：入参校验后、调 service 前插入 `rejectIfStreaming` 检查。
- 只读 handler（`getBranchGraph` / `getBranchGraphMeta`）**未改动**。

### 2.2 `backend/__tests__/webview/branchHandlers.test.ts`（扩展）

- `makeCtx` 增加 `streamAbortControllers: new StreamAbortManager()`（不破坏既有用例：无流时 isActive=false）。
- 新增 `describe('TREE-13 流式期间分支互斥')` 共 8 个用例（见 1.3）。

### 2.3 `backend/__tests__/conversation/branchRace.test.ts`（新建，约 300 行）

- `TREE-13 守卫层`：`isConversationStreaming` 状态迁移 + 会话粒度 + 纯 Map 兜底（2 用例）。
- `TREE-13 流式期间互斥矩阵（集成）`：真实 BranchService + BranchHandlers + StreamAbortManager，流式中三操作 BRANCH_BUSY 且图与流式前 JSON 完全一致（零污染）、只读放行、结束后三操作成功（3 用例）。
- `TREE-14 服务层写锁互斥矩阵`：并发 reroll×2 + 删除非活跃候选全成功、图 validate 通过、无丢失；并发 switch 两目标尾指针收敛、activeChildId 与 activePath 一致（2 用例）。
- `TREE-14 迟到 chunk 隔离（R6 基础用例）`：reroll 后 `manager.addBatch` 追加迟到 model 消息——分支图节点集合/尾指针/候选摘要 JSON 不变、候选 parts 完整、迟到消息只进主历史不进图、后续分支操作可用；流式结束后 reroll 生效期间迟到 chunk 到达也不破坏一致性（2 用例）。

### 2.4 未改动（边界内确认）

- `webview/stream/StreamAbortManager.ts`：只读确认，未改。
- `backend/modules/conversation/branch/BranchService.ts` / `BranchGraph.ts` / `types.ts`：未碰（reroll 批次范围）。`BRANCH_BUSY` 错误码与文案均已在 `types.ts` / handler 内就位，无需补充。
- `CHANGELOG.md`、规划文档、`frontend/src`、checkpoint/conversation 核心：未碰。

---

## 3. 验证结果

| 验证项 | 命令 | 结果 |
|---|---|---|
| 新增 + 相关测试 | `npx jest --config jest.backend.config.js backend/__tests__/webview/ backend/__tests__/conversation/branchService.test.ts backend/__tests__/conversation/branchRace.test.ts` | **7 suites / 67 tests 全过**（含新建 branchRace 12 用例、branchHandlers TREE-13 8 用例） |
| 回归（conversation + webview 全量） | `npx jest --config jest.backend.config.js backend/__tests__/conversation/ backend/__tests__/webview/` | **29 suites / 323 tests 全过**（无回归；输出中的 console.warn 为既有 metadataCorruption 用例的预期日志） |
| 类型检查 | `npx tsc -p ./ --noEmit` | **通过，0 错误** |

说明：未与 reroll 批次并发冲突（本轮执行时 `branchService.test.ts` 原样通过）；若 reroll 批次后续改动 BranchService，重跑 `branchRace.test.ts` + `branchHandlers.test.ts` 即可（不依赖被改服务内部实现，仅依赖已稳定的对外签名）。

---

## 4. 后续衔接

- reroll 批次新增 `chat.rerollStream` / `chat.editBranchAndRetryStream` handler 时，复用 `isConversationStreaming` / `rejectIfStreaming`（已导出）。
- TREE-06（切换重建活跃路径）落地后，本批次的 `validateActivePathMatchesHistory` 期望值（reroll 后 mismatch）需随之更新，迟到 chunk 用例可扩展为"切换重建期间拒绝迟到流写入"。
- 前端 TREE-10 候选切换器上线后，`BRANCH_BUSY` 前端应展示"等待流式完成"提示而非静默重试。
