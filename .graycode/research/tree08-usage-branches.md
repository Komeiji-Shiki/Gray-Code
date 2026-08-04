# TREE-08：用量统计包含对话全部分支（非活跃候选消耗计入）

> 批次：第六阶段 TREE-08 + 已确认决策 2（非活跃分支消耗也计入，统计页展示对话总消耗含所有候选）
> 主规划：`checkpoint-history-branch-architecture.plan.md`（TREE-08 行）
> 研究参考：`.graycode/research/branch-tree-phases-research.md`（TREE-08 行）
> 日期：2026-08-04

---

## 1. 现状研究结论（只读调研）

### 1.1 主历史 token 如何统计
- 聚合入口：`aggregateUsageStats(source, { startTime, endTime, indexStore, cache })`（`usageStats.ts`）。
  `source` 是 `UsageStatsSource`（生产上即 `ConversationManager`）；`indexStore` 是
  `FileUsageIndexStore`（`{baseDir}/conversations/{id}.usage.json`，消息级 token 索引）。
- 每对话读取路径（`loadOne`）：索引 `fresh`（历史 mtime ≤ 索引 mtime）→ 直接用索引消息，
  不读历史；`missing/stale` → 读主历史并**重建写回**索引（`buildConversationUsageIndex` +
  队列内 `rebuild`，保留 `source='subagent'` 条目）。
- token 提取：`extractMessageTokens(message)`（优先 `usageMetadata`，兼容旧顶层字段、
  `usageMetadataPartial` 半截流估算）。
- 维度：totals / byConversation / byModel / byDay，全部经 `accumulateRecord` 累加；
  `subagentTokens` 是既有「不入主历史但计入对话总消耗」的细分先例。

### 1.2 候选节点 contents 结构（BranchGraph sidecar）
- `branches.json` 布局：`{baseDir}/conversations/{id}/branches.json`（与 usage.json 同级目录）。
- 节点 `ConversationBranchNode` 存**完整内容**：`parts` / `usageMetadata` / `modelVersion` /
  `timestamp` / `kind` / `deleted` / `activeChildId` 等。
- **关键确认：nodes 包含活跃路径节点**。`finishReroll`/`appendHistoryToGraph` 会把当前活跃
  路径的消息也同步成图节点（带 parts/usageMetadata）。因此「候选 sidecar 只含非活跃节点」
  的假设**不成立**，合并时必须按活跃路径 / 主历史去重，否则 reroll 后活跃消息会被双计。

### 1.3 用量统计的读取路径
- `webview/handlers/UsageHandlers.ts`：`usage.getStats` → `aggregateUsageStats(manager, {
  indexStore: manager.getUsageIndexStore(), cache })`。本批次不改 UsageHandlers /
  ConversationManager（另一批次在改历史重写），读取源通过 `UsageIndexStore.readBranchGraph`
  （可选接口方法，文件实现放 FileUsageIndexStore）与 `UsageStatsSource.getBranchGraph`
  （内存/测试源）注入，生产链路零改动即生效。

### 1.4 去重关键发现（现状过渡态）
- 当前 `BranchService.switchBranchCandidate` **不重写主历史**（`mainHistoryRewrite: false`，
  注释明确「TREE-06 才执行 replaceContents 全量重写」）。因此「图活跃路径 = 主历史」的
  不变量在切换后**暂时不成立**：主历史仍是旧路径，图活跃路径已指向新路径。
- 若只按「图活跃路径」去重：切换后旧路径节点（仍在主历史）会被当作非活跃候选再次计入
  → **双计**；新路径节点（图活跃但不在主历史）被跳过 → **漏计**。
- 结论：**去重的权威键是「主历史消息 id」**（索引条目 id / 历史消息 id），图活跃路径仅作为
  旧索引（无消息 id）时的兜底。这样在终态（主历史=活跃路径）与过渡态都正确。

---

## 2. 方案选择：A（读取时合并，不落盘）✅

| 方案 | 做法 | 侵入面 | 结论 |
|---|---|---|---|
| **A** | 统计读取时：主历史用量 + 遍历 BranchGraph 非活跃候选节点 contents 算 token，合并进对话总消耗 | 只改读取侧（usageStats.ts + FileUsageIndexStore 只读方法），usage.json 写路径语义不变 | **采用** |
| B | 写入时把候选内容也写进用量索引（BranchService.finishReroll 上报） | 需改 BranchService 写路径（另一批次在改软删除，冲突）、索引格式与去重（活跃/非活跃转换时需增删条目） | 放弃 |

选 A 的理由：
1. **语义正确**：分支候选内容在 sidecar 是唯一真源，读取时叠加天然覆盖「切换后旧候选不在
   主历史」的场景；usage.json 继续只描述主历史，写路径（ConversationManager / BranchService）
   完全不动，避开与并行批次冲突。
2. **实现成本低**：只新增一个可选读方法 + 一个纯函数 + 聚合器一处合并钩子。
3. **去重可控**：以主历史 id 为权威键（见 1.4），活跃路径兜底，双计风险可测可证。
4. **性能**：无分支图对话只多一次 ENOENT 读；有图对话每次统计读一次 branches.json（分支
   操作必然改写主历史 → 索引 stale → 重建路径已存在，额外成本一次小文件读）；内存明细缓存
   命中时零 IO，缓存失效由既有目录 watcher 覆盖（branches.json 写入会 markDirty）。

### 2.1 合并口径（返回结构，保持向后兼容）
- 非活跃候选节点 = `branches.json` 中「不在主历史（权威：节点 id ∉ 主历史消息 id）」且
  「未软删除（`deleted` 非 true）」的 model 节点（user/system 无 usageMetadata）。
- 合并条目打 `source: 'branch'`，经既有 `accumulateRecord` 进入 totals / byConversation /
  byModel / byDay 全部分桶（时间筛选、模型、日期口径与主历史一致）。
- 新增细分字段（已包含在 totalTokens，仅展示用，与 `subagentTokens` 先例一致）：
  - `ConversationUsage.inactiveBranchTokens?`：该对话非活跃候选的 prompt+candidates+thoughts；
  - `UsageStatsResult.totals.inactiveBranchTokens?`：全部对话合计。
- 无分支图 / 图损坏 / 读取失败：返回结构完全不变（字段省略），行为与旧版一致。

### 2.2 去重逻辑（必须正确）
```
跳过节点，当且仅当：
  1. node.deleted === true                     （用户已丢弃的分支不计）
  2. node.role !== 'model'
  3. node.id ∈ 主历史消息 id 集合（historyIds）   ← 权威去重（主历史已统计）
  4. historyIds 为空时（旧索引无 id）：node.id ∈ activePath(graph)   ← 兜底（终态不变量）
图损坏（无根 / activePath 解析失败 / 空图）→ 返回 []，本次不合并（降级线性模式）
```
- 终态（主历史 = 活跃路径）：规则 3 与 4 等价，仅非活跃候选被计。
- 切换过渡态（图活跃路径 ≠ 主历史）：规则 3 保证旧路径不双计、新路径（不在主历史）不漏计。
- 已知限制：旧版持久化索引（无 id 字段）在「切换且未重写历史」的过渡态下会双计旧路径，
  下次任何主历史写（reroll/追加/编辑）触发重建（新索引带 id）后自愈；已在代码注释说明。

---

## 3. 修改摘要

### 3.1 `backend/modules/conversation/usageStats.ts`（核心）
- 类型：
  - `UsageIndexMessage` 新增可选 `id?`（主历史条目记录消息稳定 id，供分支合并去重）；
  - `UsageIndexMessageSource` 扩展为 `'main' | 'subagent' | 'branch'`；
  - `ConversationUsage` 新增 `inactiveBranchTokens?`；`UsageStatsResult.totals` 新增 `inactiveBranchTokens?`；
  - `UsageStatsSource` 新增可选 `getBranchGraph?`（内存/测试源）；
  - `UsageIndexStore` 接口新增可选 `readBranchGraph?`（文件实现）。
- 函数：
  - `buildConversationUsageIndex`：主历史条目写入 `id`（消息带 id 时）；
  - 新增 `extractBranchUsageMessages(graph, historyIds?)`（纯函数，见 2.2 口径）；
  - 新增 `mergeBranchUsageIntoLoaded()`：读取分支图 → 提取非活跃候选条目 → 与主历史索引
    视图合并（仅内存，不落盘）。
- 聚合：
  - `aggregateUsageStats` 解析分支图读取源（`indexStore?.readBranchGraph ?? source.getBranchGraph`）；
  - `loadWithCache` 在索引重建后合并分支条目（缓存回填含 `source='branch'` 条目）；
  - 主循环统计 `source='branch'` 条目（与时间筛选同口径），输出 per-conversation 与 totals 细分。

### 3.2 `backend/modules/conversation/UsageIndexStore.ts`（最小改）
- `FileUsageIndexStore` 新增只读方法 `readBranchGraph(conversationId)`：读
  `{baseDir}/conversations/{id}/branches.json`，ENOENT / JSON 解析失败 / 结构不符（version<1、
  nodes 非对象）返回 null（损坏降级线性模式），不进入写队列；
- `appendUsage` 提取消息 `id` 写入条目（与 buildConversationUsageIndex 一致）。

### 3.3 未改动（边界遵守）
- 未改：`ConversationManager.ts`、`BranchService.ts`、`BranchGraph.ts`（只 import 其 `activePath`
  纯函数）、`BranchGraphRepository.ts`、`usageCache.ts`、webview 前端统计页 UI、CHANGELOG、
  规划文档、checkpoint/subagents。
- 未落盘：usage.json 不写入 branch 条目（方案 A 语义）。

### 3.4 测试
- `backend/__tests__/conversation/usageStats.test.ts`：新增 3 个 describe、约 20 用例：
  - `extractBranchUsageMessages` 纯函数：活跃/非活跃过滤、主历史 id 去重、活跃路径兜底、
    切换过渡态不双计不遗漏、软删除跳过、空图/损坏图/无用量/user 节点返回空；
  - `aggregateUsageStats 分支图合并`：reroll 旧候选计入且活跃不双计（历史路径）、多候选+
    深层续接累加、切换过渡态按主历史 id 去重、索引 fresh 路径（条目 id 去重）、旧索引无 id
    回退活跃路径、无图/损坏图降级（回归）、时间筛选作用于分支条目、缓存回填与命中、
    索引 stale 重建后仍合并且写回不含 branch 条目（方案 A 不落盘）；
  - `buildConversationUsageIndex 消息 id`。
- `backend/__tests__/conversation/UsageIndexStore.test.ts`：新增 `readBranchGraph`（无 sidecar
  → null、有效图、损坏 → null）与 `appendUsage` 提取 id 用例。

---

## 4. 验证结果

- `npx jest --config jest.backend.config.js backend/__tests__/conversation/usageStats.test.ts backend/__tests__/conversation/UsageIndexStore.test.ts`
  → **2 suites / 55 tests 全绿**（含全部新增用例 + 既有回归）。
- `npm run typecheck` → **通过**（exit 0）。
- 全量 conversation 目录：26/29 suites 通过；3 个失败套件
  （`branchGraph.test.ts` / `branchService.test.ts` / `branchSwitch.test.ts`）经隔离复跑确认
  为**另一批次（TREE-09 软删除）在途修改所致**：其测试引用 `isDeletedNodeExpired` /
  `pruneDeletedBranches` / `getDeletedBranchCount` 等新函数，`branchGraph.test.ts` 单独运行
  即报其自身 TS 类型错误（节点字面量缺 `createdAt`），`branchSwitch` 出现 EPERM rename /
  超时（其依赖的 `ConversationManager.ts` 正被并行修改）。与本批次改动（usageStats /
  UsageIndexStore / 对应测试）无交集，待该批次完成后自愈。

## 5. 后续注意
- TREE-06（主历史重写）落地后，「图活跃路径 = 主历史」不变量恢复，去重仍以主历史 id 为
  权威，逻辑无需变更；切换路径将自然消除「旧索引无 id 过渡态」限制。
- 若未来需要把分支消耗持久化（如跨进程统计），可在此读取合并结果上增量落盘，但当前
  方案 A 刻意保持写路径不动。
- 前端统计页若要展示细分，可直接读 `ConversationUsage.inactiveBranchTokens` /
  `totals.inactiveBranchTokens`（后端返回结构已就绪，UI 改动超出本批次边界）。
