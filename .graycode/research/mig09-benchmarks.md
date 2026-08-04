# MIG-09 性能基准（第八阶段）+ 遗留小项清理（批次 P6a）

- 日期：2026-08-02
- 环境：Windows x64（10.0.26200），Node v22.18.0，jest 29.7.0（ts-jest），`NODE_OPTIONS=--expose-gc` 运行基准
- 相关规划：`checkpoint-history-branch-architecture.plan.md` MIG-09（性能基准）

---

## 一、基准结果数据

基准套件位于 `test/benchmark/`（`.benchmark.ts` 后缀，普通 `npm test` 不执行；仅显式
`--testMatch` 运行）。运行命令：

```bash
npx jest --config jest.backend.config.js --testMatch "**/*.benchmark.ts" --runInBand --testTimeout 600000
```

全部数据写入 `os.tmpdir()` 临时目录，完成后清理，不触碰真实数据目录。

### ① 大工作区 checkpoint（2000 文件，约 40 MB，真实磁盘）

| 指标 | 耗时 | 堆内存增量 | 数据量 |
| --- | --- | --- | --- |
| 创建：`buildWorkspaceSnapshot`（扫描 + stat + 流式哈希） | 313.8 ms | +1.2 MB | 2000 文件 |
| 创建：文件备份到存档目录（copy 阶段） | 2.01 s | +0.0 MB | 2000 文件 |
| 恢复：`restoreWorkspaceSnapshot`（增量链索引 + 计划 + 哈希校验 + 复制） | 706.1 ms | +0.6 MB | restored=2000, deleted=0, failures=0 |

smoke 断言：创建/备份/恢复均 < 60 s（实测均 < 3 s）。

### ② 长对话（1 万条消息 / 100 批 × 100 条，真实磁盘）

| 指标 | 耗时 | 堆内存增量 | 数据量 |
| --- | --- | --- | --- |
| append 增量写（`addBatch` → 分段 append-only 尾段写入 + usage 索引增量） | 890.8 ms（8.9 ms/批） | +0.4 MB | 10,000 条 |
| 全量读取 `getMessagesRaw`（分段并发读 + 段缓存） | 27.0 ms | +4.2 MB | 10,000 条 |
| usage 统计（走 `usage.json` 索引，新鲜） | 12.0 ms | +0.1 MB | totalTokens=900,000 |
| usage 统计（全量扫描历史，对比） | 33.8 ms | +2.1 MB | totalTokens=900,000 |

smoke 断言：四项均 < 30 s（实测最慢 append < 1 s）。

### ③ 大量分支（基线 20 节点 + 100 候选，纯 CPU）

| 指标 | 耗时 | 数据量 |
| --- | --- | --- |
| 建图：100 候选（`rerollCandidate` + `upsertCandidateSummary`） | 1.6 ms | nodes=120, candidates=100 |
| `rerollCandidate` ×100 | 3.5 ms（0.035 ms/op） | nodes=220 |
| `activePath` ×100 | 0.3 ms（0.003 ms/op） | pathLength=2 |
| `validate` ×100 | 11.0 ms（0.11 ms/op） | nodes=120 |
| `switchActivePath` ×100 | 0.6 ms（0.006 ms/op） | — |

smoke 断言：五项均 < 10 s（实测均 < 20 ms）。

### 结论（校准说明）

- 1 万条 append 实测 < 1 s（远低于任务示例的 5 s 上限），smoke 上限按 30 s 校准（10× 余量）；
- 2000 文件快照创建（扫描+哈希）约 0.3 s、恢复约 0.7 s，大工作区场景无性能风险；
- 100 候选的图操作全部亚毫秒级，分支规模在既有每父节点 10 候选上限下不是性能瓶颈；
- 内存增量均 < 5 MB，无内存风险点。

---

## 二、修改摘要

### 1. 新增基准套件（全部新文件，`test/benchmark/`）

| 文件 | 内容 |
| --- | --- |
| `README.md` | 运行方式、选型说明（仓库无 tsx/ts-node，用 ts-jest 现成通道；`.benchmark.ts` 后缀避免进普通 `npm test`） |
| `benchmarkHarness.ts` | `withTiming`（hrtime + GC 后堆采样）、报告打印、真实文件系统 vscode shim（`Uri`/`workspace.fs`，供 FileSystemStorageAdapter/FileUsageIndexStore 落真实磁盘）、临时目录管理 |
| `checkpoint.benchmark.ts` | 场景①：2000 文件 `buildWorkspaceSnapshot` + 备份 copy + `restoreWorkspaceSnapshot`（含漂移删除/修改/新建验证） |
| `longConversation.benchmark.ts` | 场景②：1 万条 `addBatch` append（分段写+usage 索引）、`getMessagesRaw` 全量读、`aggregateUsageStats` 索引 vs 全量扫描 |
| `branchGraph.benchmark.ts` | 场景③：100 候选建图、`rerollCandidate`/`activePath`/`validate`/`switchActivePath` ×100 |

### 2. `backend/tools/jsonFormatter.ts`（过时 JSON 指南示例）

确认当前工具形状（对照 `backend/tools/file/read_file.ts` / `write_file.ts` 声明）：
- `read_file`：单文件用顶层 `path`；批量用 `files: [{ path, startLine?, endLine? }]`；**不再接受 `paths` 数组**；
- `write_file`：单文件 schema，`path` + `content`（required）；**不再接受 `files` 数组**（旧示例里的 `{"files": [...]}` 已过时；`xmlFormatter.ts` 的示例也是单文件 `<path>+<content>`）。

更新后的指南示例（与 xmlFormatter 口径一致）：
- 单文件读取 `{"tool": "read_file", "parameters": {"path": "file1.txt"}}`
- 批量读取 `{"tool": "read_file", "parameters": {"files": [{"path": "file1.txt"}, {"path": "src/main.ts", "startLine": 10, "endLine": 20}]}}`
- 写入 `{"tool": "write_file", "parameters": {"path": "output.txt", "content": "Hello!"}}`

（仅改提示词文本，无逻辑变更；`promptToolParser.test.ts` 19 用例通过。）

### 3. `backend/__tests__/channel/streamAccumulator.test.ts`（旧 `<paths>` 夹具）

确认测试仍引用当前解析路径（StreamAccumulator 把文本解析为 functionCall args，不校验形状），
将 read_file 相关夹具更新为当前形状（断言同步更新）：
- JSON partialArgs 增量：`{"paths":["a.txt"]}` → `{"path":"a.txt"}`；
- JSON 完整工具块：`"parameters": {"paths": ["a.txt"]}` → `{"path": "a.txt"}`；
- XML 夹具：`<paths><item>a.txt</item></paths>` → `<path>a.txt</path>`；
- delete_file 夹具（thought 文本）保留 `{"paths": [...]}`——`delete_file` 当前声明仍接受 `paths` 数组，非过时形状。

### 4. `backend/tools/maintenance/integrityCheck.ts`（任务 3：分支校验降级）

**核实结论：正常追加后图与历史仍可能存在不一致，且为已知合法状态（非数据损坏）：**

1. `switchBranchCandidate`（TREE-04/06 底座）只切图活跃路径、**不重写主历史**（TREE-06 未落地，
   BranchService.ts 注释明确「切换后主历史与图活跃路径会暂时不一致，直到 TREE-06 落地」）；
2. `appendHistoryToGraph` 在 `ConversationManager.appendContents` 是 **fire-and-forget**（写锁不可重入，
   通过 promise 链排队），且失败仅 `log.warn` 不阻断——历史可能暂时/持续领先于图；
3. `startReroll` 的图变更（写锁内）与主历史截断（锁外）**非原子**（BranchService.ts 注释），
   中间窗由 `finishReroll` 回填兜底；
4. 消息删除路径（`deleteMessagesInRange` / `deleteToMessage`）暂未同步删除图节点（TREE-09 未落地），
   图可能残留已删消息节点。

因此把 integrityCheck 的「活跃路径与主历史对比」检查从 **error 降级为 warning**（图结构
`BranchGraph.validate` 问题保持 error——那才是真正的 branches.json 损坏）：
- 内置路径：`BRANCH_ACTIVE_PATH_LENGTH_MISMATCH` / `BRANCH_ACTIVE_PATH_ID_MISMATCH` → warning
  （`BRANCH_ACTIVE_PATH_UNRESOLVABLE` 保持 error：activePath 抛错属图结构损坏）；
- branchValidator 复用路径（`BranchService.validateActivePathMatchesHistory`）：按问题前缀区分——
  `graph[CODE]: ...`（validate 结构问题）→ error（`BRANCH_<CODE>`）；其余（长度/id 比较、
  图缺失等已知状态）→ warning（`BRANCH_ACTIVE_PATH_MISMATCH`）；
- 文件头注释补充降级原因与回收条件（TREE-06/TREE-09 落地后应回收为 error）。

### 5. `backend/__tests__/maintenance/integrityCheck.test.ts`（对应断言）

- 长度/逐位不一致两个用例补充 `severity === 'warning'` 断言；
- branchValidator 复用路径用例补充「全部问题均为 warning」断言（该夹具图结构本身合法，仅路径不一致）。

---

## 三、验证结果

| 验证项 | 结果 |
| --- | --- |
| 基准套件（3 场景） | ✅ 3 suites / 3 tests 全过（数据见上，smoke 断言全部通过） |
| `npx jest --config jest.backend.config.js backend/__tests__/channel/streamAccumulator.test.ts backend/__tests__/maintenance/integrityCheck.test.ts` | ✅ 2 suites / 41 tests 全过 |
| `npm run typecheck` | ✅ 通过（0 错误） |
| `promptToolParser.test.ts`（jsonFormatter 间接依赖） | ✅ 19 tests 全过 |
| 普通 `npm test` 不包含基准 | ✅ `--listTests` 确认无 `.benchmark.ts` 进入默认 testMatch |

---

## 四、文件边界确认

仅改动/新增以下内容（未触碰 CHANGELOG、规划文档、ConversationManager/BranchService/BranchGraph、
checkpoint 核心业务逻辑、前端）：
- `test/benchmark/`（新目录，5 个新文件）
- `backend/tools/jsonFormatter.ts`
- `backend/__tests__/channel/streamAccumulator.test.ts`
- `backend/tools/maintenance/integrityCheck.ts`
- `backend/__tests__/maintenance/integrityCheck.test.ts`

---

## 五、R8e-FIX 批次（2026-08-04）：基准修复 + integrityCheck 注释复核

批次背景：R8e 复查 `test/benchmark/` 与 integrityCheck 降级，发现 2 中危（F1 恢复测量失真、
F10 回收条件过期）+ 若干低危。本批次修复基准与注释，重跑三个基准并更新数据。

### 1. 修复摘要

| 编号 | 严重度 | 修复 |
| --- | --- | --- |
| F1 | 中 | `checkpoint.benchmark.ts`：恢复目标从「空目录全量复制」改为「已漂移工作区自身」增量恢复；断言与恢复计划一致（restored=added+modified、skipped、deleted=0 即 untracked 保留、备份哈希校验失败不落盘），并补充无白名单删除对照段 |
| F2 | 低 | 删除 `excludeAbsolutePaths: [checkpointsDir]`（checkpointsDir 在扫描根之外永不命中，无效配置），注释说明 |
| F3/F6 | 低 | smoke 上限按实测收紧：checkpoint build/备份/恢复 < 15s；长对话 append < 15s、读 < 2s、usage 1-2s；分支图全部 < 1s；注释记录校准基准（2026-08-04） |
| F4 | 低 | `branchGraph.benchmark.ts`：reroll 段结束后 `graph = reroll.resultGraph`，validate/activePath/switch 在 220 节点压力图上测量 |
| F5 | 低 | 新增深链段：单一候选下连续 append 100 子节点 + switchActivePath 激活，activePath/switchActivePath 承受 102 层深度 |
| F7 | 低 | harness 首行打印 `[harness] GC available: true/false`；无 gc 时 heapDelta 以 `~` 标记 |
| F8 | 低 | 循环类测项计时前预跑 2 次（JIT 预热）；一次性建图段注释说明含预热开销 |
| F9 | 低 | `countFilesAndBytes` 补符号链接分支（按目标 stat：目录继续遍历/文件计入/断链按 0 字节文件计；realpath 去重防环） |
| F10 | 中 | `integrityCheck.ts` 注释复核：TREE-06 已落地（handler 级 `switchBranchCandidate` 全链编排：切图→重写主历史→检查点清理），从 4 类不一致清单移除「switch 只切图」；TREE-09 软删已落地于分支候选删除，但消息删除路径仍未接线图软删（条目保留并改写）；保持降级为 warning，注明下次复核时间点 |
| — | 附带 | `BranchService.purgeBranchCandidate` 补显式泛型 `mutateGraph<BranchPurgeResult>`（与 `restoreBranchCandidate` 的 `mutateGraph<{...}>` 同模式）——纯类型注解，修复既有 WIP 遗留的 typecheck 报错，零运行期行为变化 |

### 2. 新基准数据（2026-08-04，`--expose-gc`，两次运行取代表性值）

**① 大工作区 checkpoint（2000 文件，真实磁盘）——恢复测量已修正：**

| 指标 | 耗时 | 堆内存增量 | 数据量 |
| --- | --- | --- | --- |
| 创建：buildWorkspaceSnapshot（扫描+stat+流式哈希） | 322-388 ms | +1.2 MB | 2000 文件 |
| 创建：文件备份到存档目录（copy） | 1.47-1.49 s | ~0 | 2000 文件 |
| 准备：重扫漂移后状态（恢复输入） | 289-296 ms | +0.8 MB | files=1741, added=260, modified=182, skipped=1558 |
| 恢复：**增量恢复到已漂移工作区**（added 260 + modified 182 复制/回滚，skipped 1558） | 186-197 ms（0.42-0.45 ms/文件） | +0.1-0.2 MB | restored=442, deleted=0, skipped=1558, failures=0, untracked 保留=1 |
| 恢复：删除路径对照（无白名单，untracked 删除） | 19.0 ms | ~0 | deleted=2, restored=0, skipped=2000 |
| 恢复：完整性（备份哈希校验失败） | 20.4 ms | ~0 | failures=1(hash_mismatch), restored=0 |

> 修正声明（替代上文①的 706.1 ms 恢复条目）：原「恢复」是恢复到空目标目录的全量复制
> （deleted=0/skipped=0，漂移数据只打印不参与断言），不测任何漂移处理路径。现恢复目标 =
> 已漂移工作区自身：漂移删除 260 文件 → added → 从备份复制回来；漂移修改 182 文件 → modified
> → 从备份回滚；未变 1558 文件 → skipped；快照后新建文件 → 删除白名单外 → 保留（deleted=0，
> 断言文件存在）；备份损坏 → hash_mismatch 失败且不落盘。断言均与恢复计划一致
> （restored/skipped/deleted）。smoke：创建/备份/恢复均 < 15s（实测最慢备份 1.5s；无 gc 运行
> 曾达 7.1s，余量仍充足）。

**② 长对话（1 万条消息，真实磁盘）：**

| 指标 | 耗时 | 堆内存增量 | 数据量 |
| --- | --- | --- | --- |
| append 增量写（100 批 × 100 条） | 1.56-5.23 s（15.6-52.3 ms/批） | +0.4 MB | 10,000 条 |
| 全量读取 getMessagesRaw | 52.8-53.7 ms | +4.2 MB | 10,000 条 |
| usage 统计（走 usage.json 索引） | 21.2-21.4 ms | +0.1 MB | totalTokens=900,000 |
| usage 统计（全量扫描历史，对比） | 54.2-58.8 ms | +2.1 MB | totalTokens=900,000 |

smoke：append < 15s（实测最慢 5.2s）、读 < 2s、usage 索引 < 1s / 扫描 < 2s。

**③ 分支图（基线 20 节点 + 100 候选，纯 CPU）——220 节点压力图 + 深链段：**

| 指标 | 耗时 | 数据量 |
| --- | --- | --- |
| 建图：100 候选（rerollCandidate+summary） | 1.5-2.6 ms | nodes=120, candidates=100 |
| reroll ×100（220 节点图） | 2.8-7.1 ms（0.03-0.07 ms/op） | nodes=220 |
| activePath ×100（220 节点图） | 0.2 ms（0.002 ms/op） | pathLength=2 |
| validate ×100（**220 节点图**） | 24-41 ms（0.24-0.41 ms/op） | nodes=220 |
| switchActivePath ×100（220 节点图） | 0.9-2.0 ms（0.01-0.02 ms/op） | — |
| 建深链 100 节点并激活（insertNode+switch） | 6-9 ms | nodes=320, pathLength=102 |
| activePath ×100（深链 102 层） | 1.0-1.1 ms（0.01 ms/op） | pathLength=102 |
| switchActivePath ×100（深链 ↔ 浅候选） | 5.6-6.9 ms（0.06-0.07 ms/op） | pathLength 2↔102 |

> F4 说明：原 validate 跑在 120 节点图（11 ms）；保留 reroll 压力图后 validate 在 220 节点上
> 24-41 ms（约 2-3×），这才是「100 候选 + 100 次 reroll 压力」的真实成本。
> F5 说明：活跃路径深度由 2 提升到 102 层后，activePath 慢约 5×、switch 慢约 3-5×，仍全部亚毫秒级。
> smoke：全部微操作 < 1s（实测最慢 validate×100 = 41ms，≈24× 余量）。

### 3. 验证结果（R8e-FIX）

| 验证项 | 结果 |
| --- | --- |
| 基准套件（3 场景，`--expose-gc`） | ✅ 3 suites / 3 tests 全过（数据见上，smoke 断言全部通过） |
| 基准套件（无 `--expose-gc`） | ✅ 3 suites / 3 tests 全过；首行 `[harness] GC available: false`，heapDelta 以 `~` 标记（F7 生效） |
| `npx jest --config jest.backend.config.js backend/__tests__/maintenance/integrityCheck.test.ts` | ✅ 1 suite / 32 tests 全过 |
| `npm run typecheck` | ✅ 通过（0 错误） |

### 4. 文件边界（R8e-FIX）

- `test/benchmark/benchmarkHarness.ts`（F7/F9）
- `test/benchmark/checkpoint.benchmark.ts`（F1/F2/F3）
- `test/benchmark/branchGraph.benchmark.ts`（F3/F4/F5/F8）
- `test/benchmark/longConversation.benchmark.ts`（F3/F6）
- `test/benchmark/README.md`（GC 提示、校准基准日期）
- `backend/tools/maintenance/integrityCheck.ts`（仅注释/文案更新，判定逻辑未变）
- `backend/modules/conversation/branch/BranchService.ts`（仅 1 行显式泛型类型注解，无行为变化，见修复摘要「附带」）
- `.graycode/research/mig09-benchmarks.md`（本文档）

未触碰：CHANGELOG.md、规划文档、checkpoint/conversation 核心逻辑、前端。
