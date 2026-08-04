# MIG-09 性能基准

第八阶段 MIG-09：大工作区 / 长对话 / 大量分支性能基准（防回归 smoke 断言）。

## 为什么用 Jest 而不是独立脚本

- 仓库没有 `tsx` / `ts-node` 运行器（package.json 仅含 ts-jest + jest）；
- 基准需要直接调用 TypeScript 生产模块（CheckpointSnapshotBuilder、CheckpointRestoreEngine、
  FileSystemStorageAdapter、BranchGraph 等），纯 JS `.cjs` 无法 require TS 源码；
- ts-jest 是现成的 TS 编译通道（tsconfig.test.json 已包含 `test/**/*.ts`）。

因此基准写成 Jest 套件，但使用 `.benchmark.ts` 后缀——主配置 `jest.backend.config.js`
的 `testMatch` 是 `**/*.test.ts`，普通 `npm test` 不会跑到基准；只有显式用
`--testMatch` 才会执行，保证 CI 全量测试不受影响。

## 运行

```bash
# 仓库根目录（glob：--testMatch "**/*.benchmark.ts"，匹配 test/benchmark/ 下的基准文件）
npx jest --config jest.backend.config.js --testMatch "**/*.benchmark.ts" --runInBand --testTimeout 600000
```

可选：加 `NODE_OPTIONS=--expose-gc` 可获得更准确的内存增量采样（否则 GC 时机不定）：

```bash
NODE_OPTIONS=--expose-gc npx jest --config jest.backend.config.js --testMatch "**/*.benchmark.ts" --runInBand --testTimeout 600000
```

说明：
- 每次运行首行会打印 `[harness] GC available: true/false`；无 `--expose-gc` 时各指标行的
  heapDelta 以 `~` 标记，仅作参考（F7）；
- `--runInBand`：单进程串行，保证内存采样与计时稳定；
- `--testTimeout 600000`：基准远超 Jest 默认 5s 超时（每个文件内部也调用了
  `jest.setTimeout(600000)`）；
- 所有数据写入 `os.tmpdir()` 下的临时目录，`afterEach` 清理，绝不触碰真实数据目录。

## 场景

| 文件 | 场景 | 覆盖模块 |
| --- | --- | --- |
| `checkpoint.benchmark.ts` | ① 大工作区：2000 文件快照创建/恢复 | `CheckpointSnapshotBuilder.buildWorkspaceSnapshot`、`CheckpointRestoreEngine.restoreWorkspaceSnapshot`（真实磁盘） |
| `longConversation.benchmark.ts` | ② 长对话：1 万条消息 append 增量写/全量读取/usage 统计 | `ConversationManager.addBatch` → `FileSystemStorageAdapter.appendHistory`（分段 append-only）、`FileUsageIndexStore.appendUsage`、`aggregateUsageStats`（索引 vs 全量扫描） |
| `branchGraph.benchmark.ts` | ③ 大量分支：100 候选图操作 | `BranchGraph` 纯函数：`insertNode` / `rerollCandidate` / `upsertCandidateSummary` / `activePath` / `validate` / `switchActivePath` |

每个场景输出可读指标（耗时 / 堆内存增量 / 数据量），并在末尾执行 smoke 断言
（上限远高于实测，只防灾难性回归）。

## smoke 上限校准（R8e-FIX，2026-08-04）

- checkpoint：build / 备份 / 恢复均 < 15s（实测 0.3-2s）；恢复为「增量恢复到已漂移工作区」
  （漂移删除→added、漂移修改→modified 回滚、untracked 保留、备份哈希校验失败路径）；
- 长对话：append < 15s（实测 0.89s）；全量读 / usage 扫描 < 2s、usage 索引 < 1s（实测 12-34ms）；
- 分支图：全部微操作 < 1s（实测 < 20ms；含 220 节点压力图 + 100 层深链段）。

校准基准日 2026-08-04（R8e-FIX 实测数据见 `.graycode/research/mig09-benchmarks.md`）；
上限约为实测的 15-75×，既收紧到能捕捉量级回归，又给 CI 慢机留足余量。

## 数据记录

实测结果与修改说明见 `.graycode/research/mig09-benchmarks.md`。
