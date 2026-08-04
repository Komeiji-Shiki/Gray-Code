# Checkpoint 后端安全与链完整性修复（批次 B1）— 修改摘要与验证结果

> 修复日期：2026-08-04（后台子 agent，批次 B1：安全与链完整性）
> 依据：`.graycode/research/checkpoint-backend-review.md` 中的 CP-DEL-1 / CP-PATH-1 / CP-IDX-1 / CP-RET-2 / CP-CACHE-1 / CP-RET-1 / CP-DEAD-1 / CP-DEAD-2 / CP-PREV-1 / CP-I18N-1 / CP-LOCK-1 / CP-LOCK-3

## 一、修改摘要

### 1. CheckpointManifestRepository.ts（CP-PATH-1 / CP-CACHE-1 / CP-DEAD-2 + 共享校验）

- 新增共享校验函数（供删除/合并/manifest 三处路径共用，对应审查建议的 `assertSafeCheckpointDirName()`）：
  - `isSafeCheckpointDirName(name)`：拒绝空串、`.`/`..`、`\0`、路径分隔符（`/` 与 `\`）、绝对路径/盘符，且仅允许 `[a-zA-Z0-9_.-]` 字符（单层目录名，解析后必然落在 checkpointsDir 内）。兼容测试常用的 `cp-1`/`a-1` 等连字符命名。
  - `assertSafeCheckpointDirName(name)`：校验失败抛 `CheckpointPathError`（复用 CheckpointWorkspace 的错误类，仅 import 不改动该文件）。
- **CP-PATH-1**：`getManifestPath` 入口校验 checkpointId，非法即抛 `CheckpointPathError`；`loadManifest` 在缓存/磁盘/迁移回退路径**之前**前置校验（避免被内部 try/catch 吞掉后误走 fallbackRecord 迁移），`writeManifest` 经 `getManifestPath` 同步抛错。
- **CP-CACHE-1**：内存缓存改为 LRU（上限 32 条，Map 迭代顺序实现 cacheGet/cacheSet），超出淘汰最久未使用；`cache` 字段名保持（既有测试直接访问）。
- **CP-DEAD-2**：删除无生产调用方的 `hasManifest`。

### 2. CheckpointManager.ts（CP-DEL-1 ×4 / CP-IDX-1 / CP-DEAD-1 / CP-PREV-1 / CP-I18N-1 / CP-LOCK-1 联动）

- **CP-DEL-1**（四处删除路径统一在元数据原子写回回调内校验 backupDir，越界记录拒绝删除 + `console.warn`，绝不交给 `fs.rm(recursive)`）：
  - `deleteCheckpointInternal`（L1736-1741）：目标记录 backupDir 越界 → `return current`（记录保留），方法返回 false。
  - `deleteCheckpointsFromIndexInternal`（L1844-1855）：toDelete 过滤掉越界记录（记录保留）。
  - `deleteAllCheckpoints`（L1987-1996）：只删除 backupDir 安全的记录，越界记录保留在元数据中（`return unsafe`）。
  - `deleteCheckpointsBatch`（L2108-2116）：越界记录进 `rejectedIds` 上报前端。
- **CP-IDX-1**（L1825-1842）：`deleteCheckpointsFromIndexInternal` 改为祖先闭包——保留集合 = 显式排除目标（含基链）+ `messageIndex < fromIndex`，再从所有保留节点向前遍历完整祖先链生成 `forcedKeep`，被依赖的基快照即使索引 ≥ fromIndex 也强制保留；返回列表 = `!toDeleteIds`（保留区 + 闭包 + 越界记录）。与 `deleteCheckpointsBatch` 的 CP-05 口径一致。
- **CP-DEAD-1**：删除无调用方的私有包装 `mergeCheckpointIntoSuccessor`（已直接委托 RetentionService）。
- **CP-PREV-1**：`RestorePreviewResult` 新增 `deletedIfUnconfirmed`（默认执行 `deleteUntrackedFiles=false` 时的真实删除数 = `plan.toDelete.length`），`deleted` 保留为“确认删除 untracked 后”的总数；接口注释明确两者语义。预览各返回路径（无根/错误/legacy/正常/异常）均填充。
- **CP-I18N-1**：硬编码文案统一走 `t()`：
  - `prepareRestore`：`checkpointNotFound` / `manifestMissing` / `cannotBuildChain` / `backupDirNotFound({dirs})`；
  - `formatFailureSummary`：截断后缀 `moreFailures({count})`；
  - `buildExcludedNote`：`excludedNote` / `excludedNoteChanged({count})`。
  - 按任务要求不新建语言文件条目（`t()` 缺失 key 时回退为 key 本身）。
- **CP-LOCK-1 联动**：`isFileLockCancellationError` 同时识别 `CHECKPOINT_LOCK_CANCELLED_MESSAGE`（`Checkpoint operation was cancelled`），使锁排队取消正确转换为取消结果。

### 3. CheckpointRetentionService.ts（CP-RET-2 / CP-RET-1）

- **CP-RET-2**（L99-106）：`mergeCheckpointIntoSuccessor` 入口校验 `removed.backupDir` 与 `successor.backupDir`，任一越界即抛错 → `cleanupOldCheckpoints` 捕获后中止删除并保留节点（不触碰越界目录）。
- **CP-RET-1**（L54-80）：
  - 对引用被删项**全部**后继循环执行合并（旧实现只合并第一个依赖者，异常元数据多节点引用同一 base 时其余依赖者会悬空）；
  - 以 `deleteCheckpointInternal` 返回值为准决定是否 `deleted.add`（删除被拒绝时不标记，避免后续迭代把未删除节点当作已处理）。

### 4. CheckpointOperationLock.ts（CP-LOCK-1 / CP-LOCK-3）

- **CP-LOCK-1**（L108-142）：`acquireWorkspaceLock` 接受 `abortSignal`——已 abort 立即 reject；等待中 abort 时把 pending 项移出队列并 reject（`CHECKPOINT_LOCK_CANCELLED_MESSAGE`）；授予锁时移除 abort 监听（避免对已 resolve 的 Promise 二次 reject）。`runExclusive` 透传 signal。
- **CP-LOCK-3**（L54-62）：同 owner 已持有工作区集合时，若嵌套请求**不是**已持有集合的子集（超集/交叉），fail-fast 抛 `Checkpoint lock re-entry deadlock...`，不再排队等待自己。

### 5. 测试文件（backend/__tests__/checkpoint/）

| 文件 | 新增/修改 |
|---|---|
| CheckpointManager.test.ts | 新增 6 用例：CP-DEL-1 四条删除路径的越界拒绝（含“外部受害者目录未被触碰”断言）、CP-IDX-1 索引回退断链场景（B(index=10) → R(index=3, base=B)，删 fromIndex=4 后 R 仍可恢复）、CP-PREV-1 deleted/deletedIfUnconfirmed 分离；conversationManager mock 补 `getCustomMetadata` |
| CheckpointManifestRepository.test.ts | 新增 5 用例：CP-PATH-1（getManifestPath/loadManifest/writeManifest 拒绝越界、绝对路径、盘符等非法 ID）、CP-CACHE-1 LRU 淘汰与命中刷新；`hasManifest` 删除无需用例 |
| CheckpointOperationLock.test.ts | 新增 4 用例：排队中 abort 立即移出队列并 reject、已 abort 信号立即拒绝、授予后 abort 不影响运行中任务（CP-LOCK-1）、超集重入 fail-fast 且锁状态清理（CP-LOCK-3） |
| CheckpointRetentionService.test.ts | **新建** 3 用例：多依赖者循环合并重挂（s2 不悬空，base 独有文件并入）、CP-RET-2 越界合并拒绝且外部目录不被删除、删除被拒绝时后续候选仍继续清理（CP-RET-1） |
| CheckpointManifestPhase3.test.ts | L5 断言放宽为“给出显式错误”（错误串已走 t()，不再断言具体文案）；mock 补 `getCustomMetadata` |
| CheckpointManagerWorkspace.test.ts | mock 补 `getCustomMetadata`（配合并发修改的 CheckpointQueryService CP-TYPE-1） |

## 二、验证结果

- 测试命令：`npx jest --config jest.backend.config.js backend/__tests__/checkpoint/`
- 结果：**Test Suites: 13 passed, 13 total；Tests: 201 passed, 201 total**（含既有用例回归 + 新增 18 个用例）。
- 类型检查：`npx tsc --noEmit -p tsconfig.test.json`（backend + webview + frontend 全量）**0 错误**。

## 三、说明与注意

- 工作区存在多 agent 并发修改：`CheckpointQueryService.ts`（另一 agent 的 CP-QUERY-1/2、CP-TYPE-1）已改为无条件调用 `conversationManager.getCustomMetadata`，导致三个测试文件的 mock 缺少该方法而失败；本批次在测试 mock 中补齐 `getCustomMetadata`（测试文件属本批次边界），未改动 QueryService 本身。
- 未修改：CHANGELOG.md、规划文档、CheckpointSnapshotBuilder.ts / CheckpointRestoreEngine.ts / CheckpointQueryService.ts / checkpointConcurrency.ts / CheckpointIgnoreResolver.ts / CheckpointWorkspace.ts / CheckpointExclusionProfiles.ts / SettingsManager.ts / conversation / frontend / webview；`CheckpointManager.getFileHash` 保持现状。
- i18n 新 key（`modules.checkpoint.restore.checkpointNotFound` 等）暂未加入语言文件，`t()` 缺失时回退返回 key 本身（按任务要求可接受），后续语言包补齐即可。
