# BCP-07 验证 + BCP-08 测试矩阵起点（批次 BCP-07/08）验证报告

- 批次：第七阶段 BCP-07 验证 + BCP-08 测试矩阵起点（P6b，纯 checkpoint 域测试 + 文档）
- 日期：2026-08-04
- 关联规划：`checkpoint-history-branch-architecture.plan.md`（BCP-07 L123 / BCP-08 L124 / 决策 12 L2034）
- 关联研究：`.graycode/research/bcp-phase-research.md`（§6 BCP-07 / §7 BCP-08 场景矩阵 / §8 批次）
- 文件边界遵守：仅改 `backend/__tests__/checkpoint/` 与 `backend/__tests__/conversation/branchSwitch.test.ts` + 本报告；未写任何业务代码（backend/modules、webview、frontend/src 均只读）；未改 CHANGELOG.md / 规划文档
- 测试命令：`npx jest --config jest.backend.config.js backend/__tests__/checkpoint/ backend/__tests__/conversation/branchSwitch.test.ts` → **16 suites / 241 tests 全通过**
- 类型检查：`npm run typecheck`（tsc -p ./ --noEmit）→ **通过**

---

## 1. BCP-07 验证结论（决策 12 固化）

### 1.1 结论

**决策 12 成立，无需做内容哈希去重**：增量链文件级共享（createCheckpoint 增量节点只复制变更文件）+ BCP-02 引用级共享（多分支节点绑同一 checkpointId）已满足「分支存档共享不可变内容」需求。本批以显式测试固化，未改任何实现。

### 1.2 证据一：增量链文件级共享（未变文件不重复存储）

- **新增** `backend/__tests__/checkpoint/CheckpointIncrementalSharing.test.ts`「文件级共享：连续存档只复制变更文件…」：
  - cp1 完整备份（a.txt + b.txt）→ 修改 a.txt → cp2 增量；
  - 断言 `cp2.type === 'incremental'`、`cp2.baseCheckpointId === cp1.id`；
  - **backupDir 布局断言**：cp2 备份目录存在 `ws_xxx/a.txt`、**不存在 `ws_xxx/b.txt`**（未变文件不重复落盘）；cp1 目录两文件齐全；
  - **manifest 断言**：`manifest.files` 是完整工作区映射（b.txt 仍在，hash 与 base 一致），`manifest.changes` 只含 `a.txt(modified)`；
  - 磁盘断言：`cp2.backupBytes < cp1.backupBytes`、`fileCount 1 < 2`。
- 既有覆盖（核实）：`CheckpointManifestPhase3.test.ts` CPF-01（增量基于 manifest 回填、changes 精确断言）与 H1（空增量节点），但均未断言 backupDir 布局——本批补齐。

### 1.3 证据二：恢复按增量链引用 base（不要求每个存档完整副本）

- **新增** 同文件「恢复按增量链引用 base…」：
  - cp1(full) → cp2(incremental, 只含 a.txt) 后，工作区删除 b.txt；
  - `restoreCheckpoint(cp2)` 成功：a.txt=v2（来自 cp2 目录）、**b.txt=v1（来自 cp1 目录，cp2 目录中无此文件）**；`restored=1 / skipped=1`；
  - **反证**：删除 cp1（base）目录后再恢复 cp2 → 恢复被拒（`success=false` 且 `missingBackupDirs` 含 cp1.id）——证明 b.txt 确实由 base 提供、引用关系真实存在。
- **新增** 同文件「多跳增量链…」：cp1(full) → cp2(a.txt 变) → cp3(b.txt 变)；恢复 cp3 时 a.txt=v2 必须来自 **cp2**（最近持有者，若误解析到 cp1 会得到 v1）——证明跨两级 base 的链式解析。
- 既有覆盖（核实）：`CheckpointRestoreEngine.test.ts` L346「restores unchanged files from base…」（引擎纯函数层）、`CheckpointManifestPhase3.test.ts` H1（空增量节点恢复）。本批新增 CheckpointManager 集成层（真实 createCheckpoint → restoreCheckpoint 全链路）。

### 1.4 证据三：决策 12 语义固化（同内容重复创建：记录重复、文件零重复）

- **新增** 同文件「决策 12：同内容重复创建 → 存档记录重复（无哈希去重）但备份文件零重复」：
  - 工作区无变化再次 createCheckpoint → 新记录（id 不同、`contentHash` 相同、`changes=[]`、`fileCount=0`、`backupBytes=0`）；
  - 存档记录数 = 2（**不做哈希去重**，存档列表按创建次数增长——决策 12 明确接受）；
  - cp2 备份目录除 manifest.json 外为空（**磁盘零重复**）；
  - 恢复 cp2 成功且文件全部由 base 提供。

### 1.5 现状核实备注（供后续文档引用）

- `manifest.files[].backupSourceCheckpointId`（`checkpoint/types.ts` L105）为类型预留字段，`createCheckpoint` 当前不写入；引用语义通过 `manifest.changes` **隐式**表达——不在 changes 中的文件即由更早节点提供；恢复端 `CheckpointRestoreEngine.buildFileIndex`（L329–367）按 changes 限定「该节点目录内真实存在的文件」，其余路径回退更早节点。文档固化时建议按此口径描述，不要声称 manifest 显式写入 backupSourceCheckpointId。

### 1.6 文档固化建议位置（本批不修改，仅建议）

| 位置 | 建议内容 |
|---|---|
| `checkpoint-history-branch-architecture.plan.md` L123 BCP-07 条目 | 追加完成标注：`[x]` + 「增量链文件级共享 + BCP-02 引用共享已由验证测试固化（CheckpointIncrementalSharing.test.ts 4 用例，决策 12：不做内容哈希去重）」 |
| `README.md` L133 设置说明「存档点（配置自动 checkpoint、查看与清理恢复点）」附近 / L89 功能特性「自动存档点」条目 | 追加一句：「增量存档仅保存变更文件，恢复时未变文件按增量链从早期存档引用；同一存档可被多个分支共享，不重复存储」 |
| `backend/modules/conversation/branch/types.ts` L127 `workspaceCheckpointId` 注释（业务代码，随 BCP-06 批） | 固化「同 checkpoint 可被多节点引用（BCP-06 引用计数来源），删除按引用归零」 |

---

## 2. BCP-08 测试矩阵进度（26 场景三态盘点）

图例：✅ 已覆盖（指向现有测试）｜🆕 本批新增 ｜⏳ 待 BCP-03/04/05 或 BCP-06 落地后补

| # | 场景 | 状态 | 覆盖位置 / 说明 |
|---|---|---|---|
| 1 | 写工具执行 → before/after 存档 → 节点绑定最新 checkpointId | ✅ | `toolBatchCheckpoint.test.ts`（BCP-02 接线：bind 收到 nodeId+checkpointId，含 rejecting/hanging service 防护）；`branchWorkspaceBind.test.ts` |
| 2 | 连续工具多次存档 → 绑定为最新（timestamp 最大） | ✅ | `branchWorkspaceBind.test.ts`「重复绑定新存档直接覆盖」；latest-wins 由绑定实现 + 接线测试覆盖 |
| 3 | before 存档（nodeId undefined）→ 不绑定不抛错 | ✅ | `toolBatchCheckpoint.test.ts`（before 绑定调用幂等）；`branchWorkspaceBind.test.ts`「无图 → 返回 false 不抛错」 |
| 4 | 线性对话（无图）工具存档 → 不强制建图 | ✅ | `branchWorkspaceBind.test.ts`「无图 → 返回 false 且不强制建图（不创建 sidecar）」 |
| 5 | 绑定已软删节点 → 幂等跳过 | ✅ | `branchWorkspaceBind.test.ts`「软删节点 → BRANCH_OPERATION_CONFLICT，字段不写入、不复活」（实现为拒绝而非跳过） |
| 6 | 切到纯聊天分支 → `evaluateSwitch='chat_only'` | ⏳ | BCP-03/04 `BranchWorkspaceSwitchService.evaluateSwitch` 未落地 |
| 7 | 切到写工具分支（工具名命中、无绑定）→ `workspace_pending` | ⏳ | BCP-04 决策 1「取或」判据未落地 |
| 8 | 切到有绑定分支 → `workspace_pending`（存在性命中） | ⏳ | BCP-04 |
| 9 | workspace 模式 previewRestore 失败 → `WORKSPACE_CHECKPOINT_BROKEN`，失败原子性 | ⏳ | BCP-05（previewRestore 的 missing_in_chain 检测本身已存在，`CheckpointRestoreEngine.test.ts` / `CheckpointManager.test.ts` 覆盖，但 switch 编排层未落地） |
| 10 | workspace 模式备份目录缺失 → `WORKSPACE_CHECKPOINT_BROKEN` | ⏳ | BCP-05（缺失检测已存在，编排层未落地；本批 `CheckpointIncrementalSharing.test.ts` 反证用例验证了 missingBackupDirs 语义） |
| 11 | workspace 模式工作区身份不符 → `WORKSPACE_STATE_UNAVAILABLE` | ⏳ | BCP-05（`CheckpointWorkspace.validateWorkspaceSnapshot` 已存在且有测试，switch 编排层未落地） |
| 12 | workspace 模式 roots 为空 → `WORKSPACE_STATE_UNAVAILABLE` | ⏳ | BCP-05 |
| 13 | workspace 模式 dirty 文件拦截（新增检测） | ⏳ | BCP-05（dirty 检测为新增项，未实现） |
| 14 | chat_only 模式 dirty 不拦截 | ⏳ | BCP-05 |
| 15 | workspace 成功路径顺序：取消流 → restore → switch → refreshDerived | ⏳ | BCP-03（取消流逻辑在 `CheckpointHandlers.ts` L81–121，抽公共函数未做） |
| 16 | 切换后主历史与图活跃路径一致 | ✅ | `branchSwitch.test.ts` 多处 `validateActivePathMatchesHistory`（prefix/分歧/切回/幂等/失败回滚等）+ **🆕 本批新增切回祖先用例** |
| 17 | 软删分支节点 → 存档不删（保留期可恢复） | ✅（侧） | TREE-09 软删测试（`branchReroll.test.ts`/`branchService.test.ts`）+ 现状无清理调用；BCP-06 批建议补显式断言 |
| 18 | prune 过期节点 → 引用归零存档物理删除 | ⏳ | BCP-06（`deleteCheckpointsByNodeIds` + 引用扫描未落地） |
| 19 | prune 后仍被存活节点引用 → 不删 | ⏳ | BCP-06 |
| 20 | prune 后存档被保留节点引用为 base → rejectedIds（forcedKeep） | ✅（删除域） | `CheckpointManager.test.ts` CP-IDX-1 / 祖先闭包 / deleteCheckpointsBatch 拒绝被引用 base（L860/L904/L1088）；BCP-06 编排层待落地 |
| 21 | 旧存档（无 messageNodeId）+ deleteCheckpointsByNodeIds → 不误删 + warn | ⏳ | BCP-06（接口未落地） |
| 22 | 两分支绑定同一 checkpointId → 只存一份备份，删除任一分支不影响另一分支恢复 | 🆕（前半）/ ⏳（后半） | **前半（只存一份备份 + 多节点引用同一存档）本批已固化**：`CheckpointIncrementalSharing.test.ts`（备份唯一性 + base 引用恢复）；BCP-02 已落地支持多节点绑同一 id（无唯一性约束）。后半（删除分支联动）依赖 BCP-06 清理编排 → 待补 |
| 23 | 多分支共享存档 + 全部节点 prune → 引用归零删除 | ⏳ | BCP-06 |
| 24 | 流式生成期间 switch → `BRANCH_BUSY` | ✅ | TREE-13：`backend/__tests__/webview/branchHandlers.test.ts` 互斥矩阵 + `branchRace.test.ts` 竞态 |
| 25 | 恢复+切换与工具执行并发 → 工作区锁串行、无死锁 | ✅（锁域） | `CheckpointOperationLock.test.ts`（工作区级互斥串行）+ TREE-13 互斥；BCP-03 switchWithWorkspace 编排层待落地 |
| 26 | 前端 evaluateBranchSwitch 弹窗 / 降级 | ⏳ | BCP-04（frontend branchActions 未落地） |

**汇总**：✅ 已覆盖 8 项（1–5、16、20、24、25，其中 16/20/25 为既有域内覆盖）｜🆕 本批新增/强化 3 项（16 补充边界用例、22 前半、决策 12 语义）｜⏳ 待 BCP-03/04/05 落地 10 项（6–15、26）｜⏳ 待 BCP-06 落地 6 项（17 后半建议、18、19、21、22 后半、23）。

---

## 3. 修改摘要

| 文件 | 改动 | 说明 |
|---|---|---|
| `backend/__tests__/checkpoint/CheckpointIncrementalSharing.test.ts` | **新增（356 行，4 用例）** | BCP-07 验证：①文件级共享 backupDir 布局 + manifest 断言；②base 引用恢复（含缺失 base 反证）；③多跳增量链解析；④决策 12 语义（记录重复、文件零重复）。harness 与 `CheckpointManifestPhase3.test.ts` 同构 |
| `backend/__tests__/conversation/branchSwitch.test.ts` | **+1 用例（L217 后）** | BCP-08 场景 16 边界：切回祖先（旧分支更长，`startReroll` 工具循环流）→ 新历史为旧历史严格前缀 → 分歧索引=新历史长度 1 → `deleteCheckpointsFromIndex('c1', 1, undefined)`；幂等重复切换不再清理 |
| `.graycode/research/bcp07-08-verification.md` | **新增（本文件）** | 验证结论 + 矩阵进度 + 修改摘要 |

**调研结论（未改代码）**：① `createRerollCandidate` 场景切回祖先节点时，祖先 `activeChildId` 仍指向候选子树，活跃路径**不**回退（`BranchGraph.switchActivePath` 现状），故无检查点清理；真正触发「索引回退清理」的是 `startReroll` 流（切回旧候选 M 时新历史为旧历史严格前缀）——本批新增用例基于后者（与既有 `branchSwitch.test.ts` L217 场景同流，补上其缺失的 checkpointDeleteSpy 断言）。② BCP-02 已落地（`BranchService.bindWorkspaceCheckpoint` + `ToolExecutionService` fire-and-forget 接线 + `branchWorkspaceBind.test.ts` 9 用例），绑定一致性场景 1–5 核实已覆盖，无新增必要；「节点指向的存档存在性校验」属 BCP-05 恢复前校验范畴（`bindWorkspaceCheckpoint` 语义上不校验存在性，fire-and-forget），建议 BCP-05 批在 `assertWorkspaceRestorable` 中落地。

## 4. 遗留与后续

- BCP-03/04/05 落地后补场景 6–15、26（`branchSwitchWorkspace.test.ts` / `branchActions.test.ts` 按研究 §7.1 规划）。
- BCP-06 落地后补场景 17（显式断言）、18、19、21、22 后半、23（`checkpointNodeRef.test.ts`）。
- 规划文档 L123 BCP-07 与 README 存档点条目的文档固化按 §1.6 建议位置执行（不属本批文件边界）。
