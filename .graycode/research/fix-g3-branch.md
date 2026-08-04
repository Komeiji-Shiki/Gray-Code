# FIX-G3：Branch 域复查问题修复（branch 模块）

- 日期：2026-08-04
- 范围：`backend/modules/conversation/branch/`（BranchService.ts / BranchGraph.ts / BranchGraphRepository.ts）+ 对应测试
- 依据：R5e 复查（branch 模块）问题清单 + FIX-F（此前取消未修）+ 新发现；基于 reroll 批次扩展（startReroll/finishReroll、updateNodeContent/renameNode）后的最新代码修改。
- 未触碰：ConversationManager.ts、webview/BranchHandlers、checkpoint/conversation 核心、前端、CHANGELOG、规划文档。

---

## 一、修改摘要

### 中 M-1：getBranchGraphMeta 透出仓储损坏 errorCode
- `BranchService.ts`：`BranchGraphMetaResult` 新增 `errorCode?: 'BRANCH_STORAGE_CORRUPT'`（同时新增 `corrupted?: boolean`，见 BS-1）。
- `getBranchGraphMeta`：`repository.load` 返回 `BRANCH_STORAGE_CORRUPT` 时返回
  `{ exists:false, corrupted:true, errorCode:'BRANCH_STORAGE_CORRUPT' }`，兑现注释「损坏时 exists=false 并带 errorCode」的承诺。

### 中 M-2：读取侧语义校验（环/悬空 parentId/activeChildId 指向非子节点等）
- `BranchService.getBranchGraph`：对 `loaded.graph` 执行 `validate()` + `activePath()`；
  语义损坏返回 `{ graph:null, errorCode:'BRANCH_STORAGE_CORRUPT', errorMessage:'semantic validation failed: …' }`，不再原样下发可解析但损坏的图。
- `BranchService.getBranchGraphMeta`：同样先 `validate()`；`activePath` 抛错 catch 分支由
  「exists:true 存在但不可用」改为「exists:false + corrupted:true + errorCode」（与仓储损坏统一）。
- 写路径一致强化：`loadGraphForWrite` 与 `appendHistoryToGraph` 对已加载图做语义校验，
  语义损坏同样抛 `BRANCH_STORAGE_CORRUPT` 拒绝覆盖（与解析损坏同策略，不静默覆盖可能可恢复的数据）。

### 中 M-3：锁序注释修正（强约束）
- `BranchService.ts` 头部注释改为强约束：
  「会话锁内严禁获取存档锁；存档锁只能在会话锁之外获取」。
- 说明全局实际顺序是 存档锁 → 会话锁（CheckpointManager restore/create 路径先取存档操作锁、
  再在锁内获取会话写锁），会话写锁是存档锁的内层；在会话写锁内再取存档锁会与
  restore/create 的「存档锁 → 会话锁」路径构成锁序反转而死锁。
- 明确 TREE-06（切换重写主历史）/ BCP（工作区存档绑定与恢复）设计必须遵守；
  文件写锁仍在最外层（获取方向：文件写锁 → 存档锁 → 会话锁）。

### 中 M-4：importLinearHistory 首条 functionResponse 显式记录丢弃
- `BranchGraph.importLinearHistory`：首条消息为 functionResponse 且 `previousNode === null` 时
  `console.warn` 记录丢弃原因（无前驱用户/模型节点可挂载），不再静默 continue。

### 中 M-5：delete 纳入写串行
- `BranchGraphRepository.deleteConversation`：包进 `runWriteSerialized(conversationId, …)`，
  与 save/migrate 共用同一会话写串行队列（并发「写→删」先写后删无残留）。
- `BranchService.deleteConversationBranch`：包进 `conversationManager.runExclusive`（会话写锁）。
  已确认 ConversationManager.deleteConversation 在会话写锁之外调用本方法（锁内只做
  storage.deleteHistory），不会重入死锁。

### 低 BS-1：MetaResult 三态语义统一
- `BranchGraphMetaResult` 新增 `corrupted?: boolean`，两种损坏（仓储解析失败 / 读取侧语义校验失败）
  统一携带 `corrupted:true + errorCode:'BRANCH_STORAGE_CORRUPT'`。
- 三态：无图（exists:false，无 errorCode）/ 损坏（exists:false + corrupted:true + errorCode）/
  存在可用（exists:true）。
- ⚠️ 冲突消解说明：任务清单中 M-2（中）明确要求语义损坏 catch 分支「exists:false + errorCode」，
  与 BS-1（低）示例的 `exists:true` 冲突；按严重级以 M-2 为准（exists:false）。
  前端仍可区分「无图」与「损坏」（corrupted/errorCode）。若产品需要独立「存在但不可用」
  状态，把语义损坏分支的 exists 改为 true 即可（代码注释已标注）。

### 低 BS-3：createRerollCandidate/editCandidate 父节点必须在活跃路径上
- 新增 `assertParentOnActivePath`：父节点缺失 → `NODE_NOT_FOUND`（保持既有语义）；
  存在但不在活跃路径（非活跃分支上的节点）→ `BRANCH_OPERATION_CONFLICT`
  （与 deleteBranchCandidate 的活跃路径冲突语义一致）。

### 低 BS-4：写路径「已删除会话」检查 + recordExport 空图跳过
- 新增 `assertConversationWritable`：`conversationManager.getMetadata(id) === null`
  （从未创建或已被删除）→ 抛 `BRANCH_OPERATION_CONFLICT`，拒绝分支图写入。
  说明：ConversationManager 的 `deletedConversationIds` 为私有集合（且随上限淘汰），
  BranchService 用 getMetadata 判定「会话不存在」是等价且更强的判据（覆盖集合被淘汰的旧删除）；
  检查在会话写锁内执行，与 deleteConversation 的锁序一致（delete 先入集合→锁内删文件→释放锁，
  迟到写入锁后在此被拒），不会与删除交错产生幽灵 sidecar。
- 接入点：`loadGraphForWrite`（覆盖 mutateGraph / switchBranchCandidate / recordExport）、
  `saveBranchGraph`、`appendHistoryToGraph`。豁免：`deleteConversationBranch`（级联清理路径，
  删除进行中正是其调用时机）、`initializeBranchConversation`（目标对话刚创建）。
- `recordExport`：源会话历史为空时 `loadGraphForWrite` 只产出空图（nodes 为空），跳过不落盘
  （log.warn 记录原因），不再保存空 sidecar。

### 低 BS-6：删除未使用导入
- `BranchService.ts` 移除 `createEmptyBranchGraph` 导入（reroll 批次未使用，仅残留）。

### 低 BG-1：validate 版本检查 + 仓储浅层 version 数值校验
- `BranchGraph.validate`：`graph.version !== BRANCH_GRAPH_VERSION` → `BRANCH_STORAGE_CORRUPT`
  （写路径只产生当前版本；读侧旧/新版本由迁移/降级处理，validate 不猜测式放行）。
- `BranchGraphRepository.isBranchGraphShape`：version 必须为 `>=1` 的整数
  （字符串/0/小数/负数 → `BRANCH_STORAGE_CORRUPT`）。

### 低 BG-2：activeTailNodeId 必须为链终端
- `BranchGraph.validate`：从 root 沿 activeChildId 走到链尾，`activeTailNodeId` 必须等于该链尾；
  指向中间节点 / 环上节点 → `BRANCH_STORAGE_CORRUPT`（"not the terminal node of the active chain"）。
- 补充：`rootNodeId === null` 但 `activeTailNodeId !== null` → `BRANCH_STORAGE_CORRUPT`。
- 保留原「从 root 可达」检查（错误消息与既有测试兼容）。

### 中 BS-2：新增 BranchService.appendHistoryToGraph（方法级，调用点后续接线）
- 签名：`appendHistoryToGraph(conversationId: string, newMessages: ReadonlyArray<Content>): Promise<boolean>`
- 语义（全部在会话写锁 `runExclusive` 内）：
  - 无分支图（线性对话未建图）→ 返回 false，不强制建图；
  - sidecar 损坏（解析或语义）→ 抛 `BRANCH_STORAGE_CORRUPT`（不覆盖）；
  - 已删除/不存在会话 → 抛 `BRANCH_OPERATION_CONFLICT`（BS-4）；
  - 有图：逐条 insertNode 并入活跃路径（setActive + updateTail），functionResponse（决策 8）
    并入前一个节点不独立成节点；createdAt 沿消息顺序严格递增；无 id 消息抛 `INTERNAL_ERROR`；
    全部消息被丢弃时（异常输入）不落盘返回 false；最终 validateAndSave。
- 入参约定：调用方保证只传主历史尾部**新增**消息（已带稳定 id），本方法不做去重。
- **调用点说明（不在本批次）**：应挂在 `ConversationManager.appendContents` 之后（主历史追加
  成功后调用，传本次新增消息数组）。本批次只实现方法 + 单测，避免并发冲突。

### 新发现修复（复查中暴露的潜在缺陷）
- `BranchGraph.validate` 根镜像一致性检查把「根节点无子（`root.activeChildId === undefined`）」
  与「镜像 `graph.activeChildId === null`」误判为不一致 → 单节点图（仅 root，如单条用户消息
  的会话）会被误判损坏。改为 `(root.activeChildId ?? null) !== (graph.activeChildId ?? null)`，
  undefined 与 null 等价（与 syncRootMirror 的 `?? null` 语义一致）。该修复对 M-2 读取侧
  校验落地至关重要（否则真实单消息会话会被读取侧降级）。
- `importLinearHistory` / `appendHistoryToGraph`：createdAt 沿消息顺序严格递增
  （相同/乱序 timestamp 时按序 +1），保证 childrenIndex 候选排序 = 消息顺序，
  不回退到同毫秒 id 字典序。

---

## 二、文件变更清单

| 文件 | 变更 |
|---|---|
| `backend/modules/conversation/branch/BranchService.ts` | M-1/M-2/M-3/M-5/BS-1/BS-2/BS-3/BS-4/BS-6；头部注释更新 |
| `backend/modules/conversation/branch/BranchGraph.ts` | M-4/BG-1/BG-2/createdAt 严格递增/根镜像 undefined==null 修复 |
| `backend/modules/conversation/branch/BranchGraphRepository.ts` | M-5（delete 串行化）/BG-1（version 数值校验） |
| `backend/__tests__/conversation/branchService.test.ts` | 新增：meta 损坏 errorCode、语义损坏拒绝（读+写）、BS-3、BS-4（已删除会话/recordExport 空图）、appendHistoryToGraph ×4 |
| `backend/__tests__/conversation/branchGraph.test.ts` | 新增：BG-1 版本、BG-2 终端 ×2、单节点图镜像回归、createdAt 严格递增、M-4 首条 functionResponse 日志 |
| `backend/__tests__/conversation/branchRepository.test.ts` | 新增：version 数值校验、delete 串行化 ×2（save→delete 无残留 / delete→save 保留最后写入） |

未修改：`types.ts`（无需；`BranchGraphReadResult` 的 errorCode 类型已在，BranchService 内复用字面量）、
`ConversationManager.ts`、webview/BranchHandlers、checkpoint、前端。

---

## 三、验证结果

命令（与要求一致）：
```
npx jest --config jest.backend.config.js backend/__tests__/conversation/branchService.test.ts \
  backend/__tests__/conversation/branchGraph.test.ts \
  backend/__tests__/conversation/branchRepository.test.ts \
  backend/__tests__/conversation/branchReroll.test.ts
npm run typecheck
```

- Test Suites: 4 passed, 4 total
- Tests: 120 passed, 120 total（原 113 项 + 新增 7 项；branchReroll 既有用例全部保持通过）
- typecheck: `tsc -p ./ --noEmit` 通过，0 错误

运行日志中出现的 `console.warn` 为新增测试的预期输出
（branch_graph_meta_semantic_corrupt / branch_export_skipped_empty_source）。

---

## 四、遗留/后续说明

- `appendHistoryToGraph` 调用点未接线（按要求），接线位置：`ConversationManager.appendContents`
  之后（后续批次/主模型接线）。
- BS-1 与 M-2 在「语义损坏 exists 取值」上冲突，已按严重级以 M-2 为准（exists:false）；
  如需独立「存在但不可用」状态见代码注释。
- 读取侧语义校验（M-2）使「旧版本 sidecar」在读路径降级为损坏态；迁移路径
  （BranchGraphRepository.migrate）不受影响（不经过 validate）。
