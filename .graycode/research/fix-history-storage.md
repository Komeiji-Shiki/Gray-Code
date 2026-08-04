# 批次 B5：历史存储与 ConversationManager 修复摘要

> 日期：2026-08-04
> 范围：`backend/modules/conversation/storage.ts`、`backend/modules/conversation/history/HistorySegmentCache.ts`、`backend/modules/conversation/ConversationManager.ts`、`backend/__tests__/conversation/`（helpers/fakeVscodeFs.ts 增加 statCalls 统计；新增 storageReadConsistency / conversationDeleteRace / conversationM3LightClamp 三组测试；historySegmentCache.test.ts 扩展）
> 依据：`.graycode/research/conversation-history-performance-review.md` 批次 B5 清单

---

## 一、修改摘要

### 【中】writeSegmentedHistory 双 rename 提交窗口：读侧一致性校验（storage.ts）

- 新增 `validateIndexConsistency(index)`：校验 `Σ segments.count === totalMessages`、段区间连续不重叠、`endIndex === startIndex + count - 1`（纯内存计算，无额外 IO）。
- `loadSegmentedHistory` / `loadSegmentedHistoryPage` 在解析 index 后立即校验；不一致返回 `segment_missing`（不再静默返回截断/错位历史），由外层重试兜底瞬时窗口。
- 说明：追加场景下段文件行数多于 index.count 属于 H1 崩溃残留的正常形态（读侧按 index.count 截断是提交点语义），因此校验只针对 index 内部一致性 + 段文件齐全（缺失段已在读取时返回 not_found/io_error），不检查段文件行数，避免误伤 H1 设计。

### 【中】getMessagesPaged 初始页：只读浅扫描替代全量深拷贝（ConversationManager.ts）

- 新增 `hasUnresolvedFunctionCalls(conversationId)`：只读 `storage.loadHistoryWithStatus` 遍历检查是否存在未响应的 functionCall（无 JSON.stringify/parse 深拷贝、不写回）。
- `getMessagesPaged` 初始页先做浅扫描，仅当命中悬空调用时才走 `normalizeHistoryForDisplay`（mutate + 深拷贝写回路径）；正常历史（绝大多数）完全跳过深拷贝。legacy 分支与缺会话自动创建行为保持不变（pagedHistoryIntegrity 四组用例全部通过）。

### 【中】updateSummary M3 钳制轻量化（ConversationManager.ts + storage.ts）

- `IStorageAdapter` 新增可选 `getHistoryTotalMessages?(conversationId)`：只读 index JSON 取 totalMessages（1 次读、0 次逐段 stat）。FileSystemStorageAdapter / VSCodeStorageAdapter 已实现；MemoryStorageAdapter 不实现（保持测试旧行为，钳制回退跳过）。
- ConversationManager 新增 `resolveHistoryTotalMessages`：优先走轻量方法，未实现时回退 `getHistoryIndexInfo`。
- `updateSummary` 钳制改用轻量路径——多段历史下每次消息后不再做 O(段数) 次 stat（新测试断言 0 次 .ndjson stat）。

### 【中】deleteConversation 与流式写入“删除后复活”竞态（ConversationManager.ts）

- 新增 `deletedConversationIds` 集合（上限 10000，FIFO 淘汰防无界增长）+ `assertNotDeleted`。
- `deleteConversation` 在删除前先记入集合（已排队在 storage 写队列的旧写先完成再删，随后被 delete 清掉；删除后新发起的写被短路，不会重建 `{id}/history/`）。
- 仓储委托的 `saveContents` / `appendContents` 入口短路（覆盖 appendContent/addContent/addBatch/mutate/replace/deleteMessage 等全部写路径）；`loadHistory` 对已删除会话返回 `[]` 不再自动建会话（防读路径复活）。
- 删除失败（存储抛错）撤销标记，会话不冻结；`createConversation` 同 ID 重建时撤销标记。

### 【低】M4 自愈优先从可读段重建（storage.ts appendHistory）

- 尾段缺失/损坏自愈时：先遍历可读 segments 重建 existing（保留分段后的追加），跳过不可读段；仅当没有任何 segment 可读时才回退 legacy 快照（legacy 在分段完成后才删除，崩溃窗口内是旧快照，会丢分段后的追加）。

### 【低】appendHistory 崩溃自愈后 totalMessages 与 Σcount 一致（storage.ts）

- 提交 nextIndex 前重算 `totalMessages = Σ segments.count`（原为 `index.totalMessages + take` 累加，异常态会错位）。

### 【低】getHistoryIndexInfo 逐段 stat（随 M3 轻量化一并解决）

- `getHistoryIndexInfo` 保留为完整性检查场景使用；updateSummary 热路径已改走 `getHistoryTotalMessages`，不再触发逐段 stat。

### 【低】读侧重试 2~3 次带退避（storage.ts）

- `loadHistoryWithStatus` / `loadHistoryPage` 改为最多 3 次尝试（[50ms, 120ms] 退避），重试条件扩展为 `not_found / io_error / segment_missing`。

### 【低】写队列 / 元数据链 Map 挂起泄漏（storage.ts）

- 新增 `withHangTimeout`：分段历史写任务 60s、元数据链任务 30s 挂起超时，超时按失败处理并告警，链前进、Map 条目随之回收（不永久阻塞）。
- `metadataWriteChains` 改为 `{ tail, done }` 条目：容量淘汰只淘汰「已结束」的链，跳过仍在运行中的链（避免与新链并发整体写回互相覆盖）。

### 【低】updateSummary 注释与实现一致（ConversationManager.ts）

- 按注释语义移除 `meta.updatedAt = Date.now()`（updatedAt 由 saveHistory/appendHistory 的 refreshUpdatedAt 统一维护）；避免 append 失败但前端仍乐观调用 updateSummary 时 updatedAt 被无意义前移、列表排序抖动。新测试断言 updateSummary 不移动 updatedAt。

### 【低】getConversationMetadataBatch 截断标志（ConversationManager.ts）

- 超过 200 个 ID 截断时在返回数组对象上附加 `truncated = true` 标志；数组主体不变，现有前端按实际返回数推进游标不受影响（structured clone 通道可读到，纯 JSON 通道忽略）。

### 【低】HistorySegmentCache 字节软上限 + 分桶失效（HistorySegmentCache.ts）

- 新增按字节估算（`JSON.stringify(messages).length`）与字节软上限（默认 64MB），超限按 LRU 提前淘汰（即使段数未超上限）；同键替换按新值重算字节。
- `invalidateConversation` 改为 conversationId → 键集合分桶索引，O(桶大小) 清理，不再全表扫描；淘汰/失效同步扣减 `totalBytes`（新增 `estimatedBytes` 只读属性）。

### 【低】readSegmentCached 缓存键纳入文件 size（storage.ts）

- 缓存键由 `mtime` 扩展为 `mtime:size`：文件系统 mtime 精度不足（同毫秒写入/FAT 2 秒粒度）时 size 变化仍能感知。

---

## 二、验证结果

### 测试命令

```
npx jest --config jest.backend.config.js backend/__tests__/conversation/
npx tsc --noEmit -p tsconfig.test.json
```

### 结果

- **backend/__tests__/conversation/：18 suites / 195 tests 全部通过**（含既有 storageAppend、storageSegmentedWrite、pagedHistoryIntegrity、metadataCorruption、ConversationManager.* 等，以及新增 3 组用例）。
- **tsc --noEmit（tsconfig.test.json）：0 错误**。

### 新增/扩展用例

| 文件 | 覆盖 |
|---|---|
| `storageReadConsistency.test.ts`（新增） | 双 rename 窗口 Σcount≠totalMessages 报 segment_missing（全量+分页）；段文件缺失重试后失败；瞬时窗口重试后读到一致新状态；appendHistory 提交前重算 totalMessages（异常态 3+1=4 而非 5+1=6）；M4 优先从可读段重建（尾段损坏保留 200 条、无任何可读段才回退 legacy） |
| `conversationDeleteRace.test.ts`（新增） | 删除后 append/mutate 短路、目录/meta 不复活；读路径不自动重建；createConversation 同 ID 重建恢复；删除失败撤销标记 |
| `conversationM3LightClamp.test.ts`（新增） | 钳制 0 次 .ndjson stat/read；legacy 跳过钳制；updateSummary 不移动 updatedAt；批量摘要 truncated 标志（>200 带标志、≤200 不带） |
| `historySegmentCache.test.ts`（扩展） | 字节软上限 LRU 提前淘汰；字节数失效/替换同步扣减；分桶失效只清指定会话 |
| `helpers/fakeVscodeFs.ts`（扩展） | 增加 statCalls 统计（供钳制轻量化断言） |

### 注意

- `backend/__tests__/checkpoint/` 下 CheckpointManager.test.ts 有 1 个失败（`deleteAllCheckpoints clears records and backup dirs`）：该文件仅 import checkpoint 模块（不 import conversation 模块任何运行时代码），属于其他 agent 正在进行的 checkpoint 批次工作（git status 显示 checkpoint 模块多处未提交改动），与本批次改动无关。
