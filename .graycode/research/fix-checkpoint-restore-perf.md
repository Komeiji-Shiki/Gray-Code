# Checkpoint 恢复性能遗留问题修复（批次 B8：CP-PERF-1 + CP-LOCK-2）

> 修复日期：2026-08-04（后台子 agent）
> 依据审查报告：`.graycode/research/checkpoint-backend-review.md`（CP-PERF-1 见「恢复/预览路径对全工作区顺序哈希」、CP-LOCK-2 见「previewRestore 以只读扫描持有全局文件写锁」）
> 文件边界：`CheckpointManager.ts` / `CheckpointOperationLock.ts` / `checkpointConcurrency.ts`（只读引用）/ `fileHashing.ts`（只读引用）+ 对应测试，未触碰其他文件。

---

## 1. CP-PERF-1 恢复/预览路径并行哈希

### 问题
`CheckpointManager.collectCurrentWorkspaceState`（原 L1533-1555）在 `for...of` 内对每个文件 `await this.getFileHash(file)` 顺序整文件读盘；`restoreLegacyCheckpointViaEngine`（原 L1621-1628）对备份内容哈希同样顺序执行。每次 `restoreCheckpoint` / `previewRestore` 都要做全量 MD5，10 万文件工作区下可达数分钟。

### 修改（CheckpointManager.ts）
1. **`collectCurrentWorkspaceState`（现 L1538-1569）**
   - 先按根收集全部待哈希目标 `{ filePath, scopedPath }`（scoped 键映射与旧实现完全一致），再一次性 `runBounded(hashTargets, DEFAULT_CHECKPOINT_CONCURRENCY, worker)` 有界并发哈希。
   - 复用共享模块：`runBounded`（`checkpointConcurrency.ts`，并发度取模块默认 `DEFAULT_CHECKPOINT_CONCURRENCY = 8`）、`hashFileStreaming`（`fileHashing.ts` 流式哈希，不整文件读入内存）。
   - 语义保持：worker 内 try/catch，读取失败的文件跳过（与旧 `getFileHash` 返回 null → 不进入 `currentHashes` 一致）；`currentEmptyDirs` 收集逻辑不变。
2. **`restoreLegacyCheckpointViaEngine` 备份内容哈希（现 L1634-1652）**
   - 原顺序循环改为先构建 `backupHashTargets`（`normalizeCheckpointPath` 过滤空相对路径，逻辑不变），再 `runBounded(..., DEFAULT_CHECKPOINT_CONCURRENCY, ...)` 并行流式哈希；失败跳过语义与旧实现一致。
3. **imports**：新增 `import { hashFileStreaming } from './fileHashing';`（`runBounded` / `DEFAULT_CHECKPOINT_CONCURRENCY` 原本已导入）。未修改 `getFileHash` 本身，未新建本地副本。

---

## 2. CP-LOCK-2 previewRestore 不持全局文件锁

### 问题
`previewRestore` 是纯计算（`prepareRestore` + `computeRestorePlan`，无文件写入），却经 `runExclusive` → `runWithFileLock` → `fileWriteLockManager.acquire([''], ...)` 获取全局根文件锁，全工作区扫描+哈希期间阻塞主会话与 SubAgent 全部写工具。

### 修改
1. **`CheckpointOperationLock.ts`**
   - 新增并导出 `CheckpointRunExclusiveOptions` 接口（`{ needFileLock?: boolean }`，默认 true）。
   - `runExclusive` 增加可选第 6 参 `options?: CheckpointRunExclusiveOptions`（现有调用全部 ≤5 参，签名兼容不变）。
   - `needFileLock = options?.needFileLock !== false`；为 false 时跳过 `runWithFileLock`，直接执行 `task()`——仍先 `acquireWorkspaceLock` 取得工作区级互斥（与同工作区其他存档操作互斥），但不 acquire 全局根文件锁。可重入路径（同 owner 嵌套）同样按该选项处理。
2. **`CheckpointManager.previewRestore`（现 L1230-1330）**
   - `runExclusive(roots.map(...), 'restore', owner, task, undefined, { needFileLock: false })`；abortSignal 传递保持现有逻辑（预览原不传 signal，仍不传）。

---

## 3. 测试补充

### CheckpointOperationLock.test.ts（+3 用例）
- `CP-LOCK-2: needFileLock=false runs while a tool holds the global file write lock`：写工具持有根锁时，needFileLock=false 的操作立即执行（Promise.race 500ms 超时保护，防回归挂死）。
- `CP-LOCK-2: needFileLock=false does not block new tool writes while running`：预览运行期间写工具 tryAcquire 根锁成功。
- `CP-LOCK-2: needFileLock=false still serializes on the same workspace`：不加文件锁仍保留工作区级互斥（同工作区 FIFO 串行）。

### CheckpointManager.test.ts（+1 用例）
- `CP-LOCK-2: previewRestore runs without the global file write lock; restore acquires it`：`jest.spyOn(fileWriteLockManager, 'acquire')`——预览全程不调用 acquire（回归断言），对照 `restoreCheckpoint` 仍必须调用 acquire。

---

## 4. 验证结果

- `npx jest --config jest.backend.config.js backend/__tests__/checkpoint/` → **13 个 suite 全通过，207/207 用例通过**（含新增 4 例；要求 200+ 全绿）。
- `npx tsc --noEmit -p tsconfig.json` → 无错误。
- `npx tsc --noEmit -p tsconfig.test.json` → 无错误。

## 5. 说明
- 并发数使用共享模块默认值（`DEFAULT_CHECKPOINT_CONCURRENCY = 8`），未在 Manager 内造本地并发/哈希副本。
- 哈希结果插入顺序随并发完成顺序变化，但 `currentHashes`/`rawHashes` 全部按 key 查找消费（`computeRestorePlan` / `restoreWorkspaceSnapshot` 均 `in`/`get` 查询），无顺序依赖，语义不变。
- `previewRestore` 仍持有工作区级锁：与同工作区的 restore/create 互斥，避免预览期间状态被其他存档操作改动，但不再阻塞写工具。
- 未修改 CHANGELOG.md 与规划文档（主模型统一记录）。
