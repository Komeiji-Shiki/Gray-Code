# 修复摘要：CP-ORDER-1 + CP-PROG-1（批次 T2）

> 修复日期：2026-08-04
> 范围：`backend/modules/checkpoint/CheckpointRestoreEngine.ts`（仅此一处生产代码）+ 对应测试文件
> 依据：`.graycode/research/checkpoint-backend-review.md` §3 两项低危发现

## 1. CP-ORDER-1 恢复先删后拷 → 先拷后删

### 问题
原 `restoreWorkspaceSnapshot` 的执行顺序为：删除多余文件（`deletionList`）→ 复制新增/修改文件（`filesToRestore`）。若目标文件备份缺失（`missing_in_chain`）或复制失败（`hash_mismatch`/`copy_failed`），删除阶段已完成而复制未完成，用户当前文件已无法回补，工作区处于「已删未补」的破坏性中间态——恢复失败后用户「本可保留」的当前文件被一并丢失。

### 修复
调整两阶段顺序（`CheckpointRestoreEngine.ts`）：
1. **先执行复制恢复阶段**：新增/修改文件的复制（含备份哈希校验 `hashFileStreaming` 与声明哈希比对）全部完成，期间删除一个字节都不执行；
2. **复制阶段全部成功后，最后再执行删除阶段**：删除循环用 `if (failures.length === 0)` 门控——复制阶段有任何失败（missing_in_chain / hash_mismatch / copy_failed）即整体跳过删除，用户当前文件（含本可删除的多余文件）全部保留，失败清单照常上报。

`toDelete` 与 `filesToRestore` 路径不相交（审查报告已确认），且删除门控只发生在失败路径，正常恢复（零失败）的预览清单与实际执行仍严格一致；`computeRestorePlan` 纯计算逻辑零改动，预览语义保持不变。

## 2. CP-PROG-1 删除阶段不上报进度

### 问题
原实现 `onProgress` 只在复制恢复循环内回调（`total = filesToRestore.length`），删除阶段无任何进度上报，前端进度条在删除阶段停滞。

### 修复
- 进度计数改为跨阶段共享：`processed` 从 0 开始，复制阶段与删除阶段共用递增；
- `total` 改为 `progressTotal = deletionList.length + filesToRestore.length`（等价于删除+恢复文件总数）；
- 删除循环内每条路径（成功 / `fs.unlink` 失败 / 路径解析失败）都 `processed += 1` 并回调 `onProgress(processed, progressTotal)`，与复制循环行为一致（每个文件恰好上报一次）；
- 删除阶段被门控跳过时不再额外补发进度（该场景恢复已失败，前端按失败展示）。

## 变更文件

| 文件 | 变更 |
|---|---|
| `backend/modules/checkpoint/CheckpointRestoreEngine.ts` | 阶段顺序调换（复制→删除）+ 删除阶段 `onProgress` 上报 + 删除门控 `failures.length === 0`（L367-449 区域） |
| `backend/__tests__/checkpoint/CheckpointRestoreEngine.test.ts` | 新增 2 条回归测试（见下） |

未触碰：`CheckpointManager.ts`（另一批次在改）、CHANGELOG.md、规划文档及其他文件。

## 新增测试

1. **CP-ORDER-1: does not delete existing files when restore copy fails**
   工作区含 `ghost.txt`（目标要求恢复但备份缺失）与 `extra.txt`（多余文件）。断言：恢复整体失败、`failures` 恰为 `[ghost.txt: missing_in_chain]`、`deleted === 0`，且 `ghost.txt` 当前内容与 `extra.txt` 均保留——复制失败时删除阶段被跳过，无「已删未补」中间态。
2. **CP-PROG-1: deletion phase reports progress covering the full restore**
   恢复 2 个文件 + 删除 1 个多余文件。断言：`onProgress` 恰被调用 3 次（每文件一次）、所有回调 `total === 3`、存在 `processed > 2` 的回调（证明进度推进到删除阶段）、最后一次回调为 `[3, 3]`（覆盖全量）。

## 验证结果

命令（项目根目录 `a:\api\Gray-Code-main`）：

```
npx jest --config jest.backend.config.js backend/__tests__/checkpoint/CheckpointRestoreEngine.test.ts
```

结果：**Test Suites: 1 passed, 1 total；Tests: 13 passed, 13 total**（原有 11 条全部保持绿色，新增 2 条通过）。
