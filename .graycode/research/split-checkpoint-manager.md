# CPF-12：拆分超大文件 CheckpointManager.ts（批次 S1）

## 背景

`backend/modules/checkpoint/CheckpointManager.ts` 原约 2413 行（拆分后 1687 行）。CPF-12
此前被标记完成但实际未拆（仅把 manifest/查询/保留策略拆成了三个服务，Manager 仍保留全部
恢复侧文件操作）。本批次按审查报告 CP-MAINT-1 建议，把恢复侧辅助与 VSCode 文档刷新
拆为两个新模块，**纯重构：所有移动的方法体逐字平移，仅做必要依赖重定向，不改变任何
行为、不改变导出 API 与调用方**。

## 拆分结构

```
backend/modules/checkpoint/
├── CheckpointManager.ts            (2413 → 1687 行)  协调层：入口方法 / 锁编排 / 配置读取 / 进度与取消
├── CheckpointRestoreService.ts     (新文件, 722 行)  恢复侧文件操作与辅助
├── WorkspaceEditorRefresher.ts     (新文件,  94 行)  VSCode 受影响文档刷新
└── （其余模块不变：RestoreEngine / QueryService / RetentionService / ManifestRepository 等）
```

### 1. CheckpointRestoreService.ts（722 行）— 恢复侧文件操作与辅助

构造注入：`checkpointsDir`、`settingsManager`、`manifestRepository`、`queryService`、
`conversationManager`；文档刷新直接复用 `WorkspaceEditorRefresher` 模块函数。

| 成员 | 原行号 | 现行号 | 说明 |
|---|---|---|---|
| `createIgnoreResolver` | 410-427 | 152-169 | 恢复/当前状态过滤的忽略解析器（含完整四层排除模型） |
| `collectSnapshotEntries` | 435-440 | 177-182 | 备份目录侧遍历条目收集 |
| `filterRestoreTargetScoped` | 914-961 | 190-237 | 按当前规则过滤恢复目标 |
| `getIncrementalChain` | 996-1018 | 242-264 | 增量链构建（#28 断裂检测） |
| `prepareRestore`（public） | 1342-1530 | 275-463 | 恢复公共准备（prune/校验/链验证/收集/删除边界），restore 与 preview 共用 |
| `collectCurrentWorkspaceState` | 1538-1569 | 471-502 | 当前工作区哈希/空目录收集（有界并发 + 流式哈希） |
| `toDisplayPath`（public） | 1574-1580 | 507-513 | scoped 键 → 展示相对路径 |
| `toDisplayUnbackedPaths`（public） | 1586-1596 | 519-529 | unbacked 批量转展示路径（截断 50 条） |
| `formatFailureSummary`（public） | 1599-1605 | 532-538 | 失败清单压缩为单行摘要（5 条截断） |
| `restoreLegacyCheckpointViaEngine`（public） | 1614-1718 | 547-651 | 旧版存档（无 fileHashes）恢复 |
| `buildIgnoreSnapshot` | 2348-2358 | 658-668 | 当前排除规则快照（与构建器同口径） |
| `buildExcludedNote`（public） | 2368-2401 | 678-711 | EX-11 排除说明（快照规则 vs 当前规则） |
| `serializeEnabledProfiles` | 2407-2412 | 717-722 | enabledProfiles 规范化序列化（M-4） |

同时平移的导出类型（`CheckpointManager` 保持原样 re-export，公共 API 不变）：
`RestoreFailureReason`、`RestoreFailure`、`CheckpointExcludedNote`、`RestoreResult`、
`RestorePreparedContext`（内部类型，不导出）。

### 2. WorkspaceEditorRefresher.ts（94 行）— VSCode 文档刷新

`refreshAffectedDocuments(modifiedFiles, deletedFiles)`（原 1917-1987，模块级函数）：
把被恢复影响（修改/删除）的打开文档 buffer 替换为磁盘内容后静默保存、applyEdit 失败
回退 revert；关闭涉及受影响文件的 diff 视图，并保持聊天输入框焦点（chatFocusGuard）。

### 3. CheckpointManager.ts（1687 行）— 保留职责

- 入口方法：`createCheckpoint` / `restoreCheckpoint` / `previewRestore` / `deleteCheckpoint`
  / `deleteCheckpointsFromIndex` / `deleteAllCheckpoints` / `deleteCheckpointsBatch` /
  `getCheckpoints` / `getAllConversationsWithCheckpoints` / `getManifest`
- 锁编排（`checkpointOperationLockManager.runExclusive`）、配置读取、进度/取消注册
  （`beginOperation` / `updateOperation` / `endOperation` / `getOperationProgress` /
  `cancelOperation`）
- 创建侧：快照构建、增量备份、manifest 写入、记录保存、过期清理
- 保留类型导出：`FileChange`、`RestorePreviewResult`、`CheckpointRecord`、
  `BatchCheckpointDeleteItem`、`BatchCheckpointDeleteResult`；恢复侧类型经
  `export type { ... }` 原样 re-export（index.ts 与测试 import 路径均不变）
- `getFileHash`（死代码）按 fileHashing.ts 注释约定保持现状，未触碰

## 依赖重定向（唯一允许的改动）

平移方法内仅做以下等价替换，其余逐字保留：

| 原调用 | 新调用 |
|---|---|
| `this.readCheckpointListFromConversation(...)` | `this.queryService.getCheckpointRecords(...)` |
| `this.pruneMissingBackupCheckpointRecords(...)` | `this.queryService.pruneMissingBackupCheckpointRecords(...)` |
| `this.backupDirectoryExists(...)` | `this.queryService.backupDirectoryExists(...)` |
| `this.refreshAffectedDocuments(...)` | `refreshAffectedDocuments(...)`（导入模块函数） |
| Manager 侧 `this.prepareRestore/buildExcludedNote/toDisplayPath/toDisplayUnbackedPaths/formatFailureSummary/restoreLegacyCheckpointViaEngine/refreshAffectedDocuments(...)` | 改为 `this.restoreService.*` 或模块函数 |

其他保持不变项（刻意为之，避免行为漂移）：
- 日志类别保留 `Logger.get('CheckpointManager')`（新文件内注释说明），`console.warn/error`
  前缀 `[CheckpointManager]` 原样保留；
- 构造函数签名、`CheckpointManager` 导出、`index.ts` 均未改动。

## 验证结果

| 检查 | 结果 |
|---|---|
| `npx tsc -p ./ --noEmit` | ✅ 通过（exit 0） |
| `npx jest --config jest.backend.config.js backend/__tests__/checkpoint/` | ✅ 13 suites / 207 tests 全部通过 |
| `npx jest --config jest.backend.config.js`（后端全量） | ✅ 通过（见下） |
| 拆分脚本断言（行号边界 / 残留 `this.*` 调用 / 关键调用点） | ✅ 全部通过 |

- 拆分过程由脚本按行号范围原样截取（带边界断言），Manager 重组后再次断言
  无残留 `this.<已移动方法>(` 调用、无重复类型定义、关键调用点齐全；
- 移动代码逐字保留（含注释与日志文本），未做任何"顺手优化"。

## 备注

- 与其他批次无冲突：本文件由本批次独占修改；工作区内其他批次对 checkpoint 模块的
  既有改动（tests/i18n 等）不受影响，未修改任何其他文件。
- `index.ts`、`webview`、`frontend`、`CHANGELOG.md`、规划文档均未改动。
