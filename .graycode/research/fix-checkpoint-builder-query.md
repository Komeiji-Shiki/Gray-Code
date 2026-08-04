# 批次 B3 修复摘要：Checkpoint 快照构建、恢复与查询

> 修复日期：2026-08-04
> 范围：CP-DUP-1（部分）、CP-PREV-2、CP-QUERY-1、CP-QUERY-2、CP-TYPE-1
> 依据：`.graycode/research/checkpoint-backend-review.md`

## 修改摘要

### 1. CP-DUP-1（部分）——三处重复实现收敛

**新增共享文件（本批次拥有）**
- `backend/modules/checkpoint/fileHashing.ts`：`hashFileStreaming(filePath)` —— 流式 MD5（createReadStream），
  从 SnapshotBuilder / RestoreEngine 抽取的共享实现。注释注明 CheckpointManager.getFileHash 的收敛留给后续批次。
- `backend/modules/checkpoint/checkpointPathUtils.ts`：`isExcludedAbsolutePath(absolutePath, excludePaths)` ——
  强制排除绝对路径判断，**统一大小写策略**：win32 与 darwin（macOS 默认 APFS 大小写不敏感卷）折叠小写比较，
  其余平台大小写敏感（与审查 EX-CASE-1/EX-CASE-2 建议一致）。IgnoreResolver 侧由另一 agent 收敛，本批次只改 SnapshotBuilder 这一侧。

**CheckpointSnapshotBuilder.ts**
- 删除本地 `runBounded`（L112-127 旧），改为引用 `checkpointConcurrency.runBounded`（共享实现带
  “首个错误后停止取新任务、只抛第一个错误”语义；Builder 的 worker 内部全量 catch，行为等价）。
- 删除本地 `hashFileStreaming`（L130-139 旧），改为引用 `fileHashing.hashFileStreaming`；移除不再使用的
  `crypto` / `createReadStream` 导入。
- 删除本地 `isExcludedAbsolutePath`（L97-109 旧），改为引用 `checkpointPathUtils.isExcludedAbsolutePath`。

**CheckpointRestoreEngine.ts**
- 删除本地 `hashFile`（L479-488 旧），`restoreWorkspaceSnapshot` 内改为引用共享 `hashFileStreaming`；
  移除不再使用的 `crypto` / `createReadStream` 导入。

**未触碰**：CheckpointManager.getFileHash（其他 agent 边界 / 后续批次）。

### 2. CP-PREV-2 —— 排除预览 samples 顺序确定

- `previewExclusions`（CheckpointSnapshotBuilder）：runBounded 并发收集完成后、聚合前对 `allExcluded`
  按 `path` 排序（`a.path < b.path ? -1 : ...`），再截取 samples。summary 与 byProfile 各桶的 samples
  均变为跨预览稳定且字典序展示。

### 3. CP-QUERY-1 —— 设置页逐对话顺序读元数据 → 有界并发 + 轻量读

- `CheckpointQueryService.getAllConversationsWithCheckpoints`：改为 `runBounded(conversationIds,
  DEFAULT_CHECKPOINT_CONCURRENCY)` 并行读取；优先使用轻量 `getMetadataLight`（只读 meta.json，不做历史
  完整性检查），对不支持 `getMetadataLight` 的旧实现/测试桩做类型安全回退到 `getMetadata`。

### 4. CP-QUERY-2 —— getCheckpoints 区分“无记录”与“读取失败”

- `CheckpointQueryService.getCheckpoints` 返回类型改为 `CheckpointQueryResult`
  （= `CheckpointSummaryWithSize[] & { error?: string }`）：
  - 无记录 → 空数组（无 error）；
  - 元数据损坏/读取失败 → 仍返回数组（**保持现有调用方与前端兼容**，`CheckpointManager.getCheckpoints`
    的数组返回类型不变、`toEqual([])` 等既有断言不受影响），但通过 `Object.defineProperty` 附加**非枚举**
    `error` 标记（不影响数组相等性与序列化），前端 handler 可读 `result.error` 展示错误而非误显示“无存档”。
  - 日志由 `console.error` 改为模块 Logger `log.warn`。

### 5. CP-TYPE-1 —— 移除 `as any`

- `CheckpointQueryService.getCheckpointRecords`：移除 `as any` 双接口回退，优先走类型化
  `ConversationManager.getCustomMetadata(conversationId, 'checkpoints')`；对不支持 `getCustomMetadata`
  的旧实现/测试桩保留**类型安全**的结构性回退（读 `getMetadata` 的 `custom.checkpoints`），
  不引入任何 `any`。真实 ConversationManager 均实现 `getCustomMetadata`，主路径即类型化接口。

## 验证结果

### 本批次测试（3 个套件，34 用例全部通过）

```
npx jest --config jest.backend.config.js backend/__tests__/checkpoint/CheckpointSnapshotBuilder.test.ts \
  backend/__tests__/checkpoint/CheckpointRestoreEngine.test.ts \
  backend/__tests__/checkpoint/CheckpointQueryService.test.ts --no-cache
Test Suites: 3 passed, 3 total
Tests:       34 passed, 34 total
```

新增用例：
- CheckpointSnapshotBuilder.test.ts
  - `CP-DUP-1: snapshot hashing converges to the shared hashFileStreaming implementation`
  - `CP-DUP-1: forced absolute-path exclusion is case-insensitive on case-insensitive platforms`（win32/darwin）
  - `CP-PREV-2: preview exclusion samples are sorted by path and stable across runs`
- CheckpointRestoreEngine.test.ts
  - `CP-DUP-1: restore hashing converges to the shared hashFileStreaming implementation`
- CheckpointQueryService.test.ts（新建，6 用例）
  - `CP-TYPE-1: getCheckpointRecords reads records through typed getCustomMetadata`
  - `CP-QUERY-2: no records returns empty array without error marker`
  - `CP-QUERY-2: read failure returns empty array with error marker (not "no checkpoints")`
  - `CP-QUERY-2: getCheckpoints maps records to summaries and keeps array usability`
  - `CP-QUERY-1: aggregates conversation stats with lightweight parallel metadata reads`
  - `CP-QUERY-1: metadata reads are bounded (never exceed DEFAULT_CHECKPOINT_CONCURRENCY)`

### 全 checkpoint 套件（12 套件，189 通过 / 3 失败）

失败 3 项均与本批次无关，属其他 agent 进行中改动（已通过 `git stash` 基线验证/依赖分析确认）：

1. `CheckpointManager.test.ts › deleteAllCheckpoints clears records and backup dirs`
   —— 未含本批次改动时同样失败（CheckpointManager/conversation RMW 迁移进行中）。
2. `CheckpointManifestPhase3.test.ts › L5: manifest 缺失的新格式记录恢复给出显式错误`
   —— 未含本批次改动时同样失败（manager 侧新 i18n key `modules.checkpoint.restore.manifestMissing`
   在测试环境未解析）。
3. `CheckpointRetentionService.test.ts › CP-RET-1（合并到 ALL dependents）`
   —— RetentionService agent 新增测试，实现尚在进行中；该测试只 import RetentionService /
   ManifestRepository，与本批次文件无依赖。

另注：首次全量运行曾出现 `CheckpointManager.ts:827 TS2304 CHECKPOINT_LOCK_CANCELLED_MESSAGE` 编译错误，
系 jest/ts-jest 缓存了其他 agent 尚未写完的 CheckpointOperationLock.ts 旧版本；`--no-cache` 后消失，与本批次无关。

## 边界遵守

- 只修改：CheckpointSnapshotBuilder.ts、checkpointConcurrency.ts（未改，仅引用）、CheckpointRestoreEngine.ts、
  CheckpointQueryService.ts、新建 fileHashing.ts / checkpointPathUtils.ts、对应测试（SnapshotBuilder /
  RestoreEngine 测试、新建 QueryService 测试）。
- 未触碰：CheckpointManager.ts（含 getFileHash）、CheckpointManifestRepository.ts、CheckpointRetentionService.ts、
  CheckpointOperationLock.ts、CheckpointIgnoreResolver.ts、CheckpointWorkspace.ts、CheckpointExclusionProfiles.ts、
  SettingsManager.ts、conversation 模块、frontend、webview、CHANGELOG.md、规划文档。
- CheckpointManager.getFileHash 的重复哈希收敛按任务说明留给后续批次。
