# 修复摘要：GrayCode 用量索引并发与缓存问题（批次 B4）

> 依据 `.graycode/research/conversation-history-performance-review.md` 第 2/3/7/8/9 节问题清单实施。
> 全部改动仅限批次边界文件；未触碰 ConversationManager.ts / storage.ts / HistorySegmentCache.ts / checkpoint / frontend / webview / CHANGELOG.md / 规划文档。

---

## 一、修改摘要

### 1. 【高】UsageIndexStore.ts —— per-conversation 写队列 + 原子写（L95-100、L112-161）

**方案选择**：按任务约束，不碰 ConversationManager.ts（B5 agent 边界），在 `FileUsageIndexStore` 内部实现 per-conversation 写串行队列，把 `appendUsage` / `appendUsageMessages` / `write` / `remove` 全部纳入同一队列：

- `enqueueWrite(conversationId, task)`：按会话隔离的 Promise 链（模式与 ConversationManager 既有写队列一致，尾链 settled 后自清理，前序失败不阻塞后续）。
- **并行子代理归集**（ToolExecutionService 并行执行多个 subagent → `appendUsageMessages`）与**主会话增量**（`updateUsageIndexAppend` → `appendUsage`）与**全量重建**（`updateUsageIndex` / usageStats 重建 → `write`）的 read-modify-write 全部原子化，不再互相覆盖。
- **write 队列内 subagent 兜底合并**：调用方（ConversationManager.updateUsageIndex / usageStats 重建）在队列外 `read` 旧索引做 subagent 合并，若期间有子代理归集写入，其读到的旧索引已过期；`writeLocked` 在队列内重新读当前盘面，按条目键（source+timestamp+modelVersion+各 token 字段）去重补回缺失的 `source='subagent'` 条目——重建不丢并发归集条目，也不会因调用方与存储层双重合并产生重复计数。
- `read` 不排队（统计侧允许读写前旧状态，mtime 机制兜底；队列内复用同一 read，无死锁）。
- **executor.ts 无需改动**：子代理归集入口 `context.usageIndexAppend` → `ConversationManager.appendUsageIndexMessages` → `store.appendUsageMessages`（或回退 read+write），全部落入 store 队列，串行化在存储层完成。

### 2. 【低】UsageIndexStore.ts —— usage.json 原子写（原 L95-100）

- 先写同目录 `{conversationId}.usage.json.tmp`，再 `rename(overwrite)` 原子替换（复用 storage.ts `renameOverwrite` 模式：优先 overwrite rename，平台不支持回退删旧+rename，写写已由队列串行化）。
- 写失败清理 tmp 并向上抛（调用方静默降级）；崩溃时线上文件要么完整旧版要么完整新版，`read` 只读线上路径，临时文件不可见。
- `read()` 永不读到半截 JSON；截断场景自愈路径（missing → 重建）保留。

### 3. 【低】usageStats.ts —— listConversations 失败跳过 prune（原 L430-435 / L547-550）

- 新增 `listFailed` 标志：`listConversations()` 抛错时 `conversationIds=[]` 且 `listFailed=true`，末尾 `cache.prune(...)` 在失败时跳过——瞬时目录读取错误不再清空整个内存缓存，避免下次统计全量重读。

### 4. 【低】usageStats.ts —— 统计重建与子代理归集并发（原 L509-528）

- 与高项同源，已通过 store 内部队列解决（`indexStore.write` 走队列 + 队列内 subagent 兜底合并）；原“先读旧索引再合并”的保护保留（对无内部队列的 store 仍有效），并补充注释说明。

### 5. 【低】usageCache.ts —— fs.watch recursive 平台差异探测与降级（原 L171-187）

- `probeRecursiveWatchSupport(watcher, dir, timeoutMs)`：创建探针子目录并写探针文件，只有收到“探针目录内部文件”事件才算 recursive 生效（非递归 watcher 也会收到子目录本身创建事件，不算证据）；探测用独立临时 change 监听，不污染 dirty 集合；超时/失败返回 false，探测目录自动清理。
- 探测失败（旧 Node/部分平台静默降级）→ `startMtimeFallbackScanner`：定期（默认 15s）对 conversations 目录做 mtime 快照比对（`scanConversationMtimes` 递归收集每对话最大 mtime + `diffMtimeSnapshots`），仅把变化的对话标记 dirty；首次扫描只建基线不标记，避免启动即全量失效；watcher 重建后复用探测结果，不重复探测。
- 顺带修复：`parseConversationIdFromPath` 先剥 `.tmp` 再识别双后缀——原子写产生的 `{id}.usage.json.tmp` / `{id}.meta.json.tmp` 事件此前会被解析成假对话 ID 标记进 dirty 集合（无害但冗余），现正确映射回真实对话。
- `startUsageDirectoryWatcher` 签名向后兼容（新增可选 options 参数，默认值行为不变）。

### 6. 【低】TranscriptRepository.ts —— append 返回值语义显式声明 + saveAndReload 优化（L71-89、L105-111）

- `ITranscriptRepository` 接口注释显式声明：**append 系列返回“本次已追加内容的独立副本”（新增内容，不是完整历史）**，与 replace/mutate 返回“保存后的完整历史”语义不同；回退路径（无 append 委托 → get→push→save → 完整历史）的差异也在注释中说明，消除隐式契约分叉。
- `TranscriptRepositoryDelegate.saveContents` 类型扩展为 `Promise<Content[] | void>`：适配器可在 save 时返回落盘形态，`saveAndReload` 直接采用（省去写后全量回读 + 深拷贝）；返回 void（既有适配器：ConversationManager、SubAgentTranscriptRepository）时保持“写后 getContents 回读”原语义，完全向后兼容（全项目 `tsc --noEmit` 通过验证）。
- 未改动 off-limits 的适配器调用方（ConversationManager.ts / SubAgentTranscriptRepository.ts），性能收益通过接口能力开放，后续适配器可逐步迁移。

### 7. executor.ts —— 无需改动

- 用量归集调用处（L924 `reportUsageToMainConversation` → `context.usageIndexAppend` → `manager.appendUsageIndexMessages`）因 store 内部队列已完整串行化，未做任何修改（符合“最小改动”约束）。

---

## 二、测试

### 新增测试

| 文件 | 覆盖 |
|---|---|
| `backend/__tests__/conversation/UsageIndexStore.test.ts`（新） | ① 并行 appendUsageMessages 不丢失更新（20 路并发回归）；② 并行 appendUsage 不丢失更新；③ appendUsage × appendUsageMessages 混合并发；④ 全量重建 write 与并发子代理归集不互覆、不重复；⑤ 不同会话互不阻塞；⑥ 原子写：只写 tmp + rename 提交、无残留、落盘内容完整；⑦ 写 tmp 失败抛错且线上保持旧版；⑧ rename 失败抛错、tmp 清理、索引自愈为 missing |
| `backend/__tests__/conversation/usageStats.test.ts`（增） | listConversations 失败跳过 prune（缓存保留）；成功时仍正常 prune |
| `backend/__tests__/conversation/usageCache.test.ts`（增） | 原子写 tmp 路径解析映射回真实对话；scanConversationMtimes 收集每对话最大 mtime 且忽略探针目录；diffMtimeSnapshots 只报变更；startMtimeFallbackScanner 首轮建基线、变更后标记 dirty（真实临时目录）；probeRecursiveWatchSupport 真实 fs.watch 探测返回布尔且清理探针目录；startUsageDirectoryWatcher 子目录写入最终标记 dirty（recursive 事件或 mtime 兜底两条路径收敛） |
| `backend/__tests__/conversation/TranscriptRepository.test.ts`（新） | appendContents 返回“已追加内容”独立副本（有/无 append 委托两条路径语义）；saveContents 返回落盘形态时 saveAndReload 跳过回读；返回 void 时保持写后回读（向后兼容） |

### 验证结果

```
npx jest --config jest.backend.config.js backend/__tests__/conversation/
→ Test Suites: 15 passed, 15 total；Tests: 175 passed, 175 total

npx jest --config jest.backend.config.js backend/__tests__/tools/subagentExecutorUsage.test.ts backend/__tests__/tools/subagents.test.ts
→ Test Suites: 1 passed, 1 total；Tests: 5 passed, 5 total（用量归集链路无回归）

npx tsc -p ./ --noEmit
→ exit 0，无类型错误（saveContents 接口扩展对 ConversationManager.ts / SubAgentTranscriptRepository.ts 等 off-limits 调用方兼容）
```

### 边界合规

- 修改：`UsageIndexStore.ts`、`usageStats.ts`、`usageCache.ts`、`TranscriptRepository.ts`、`usageStats.test.ts`、`usageCache.test.ts`（均在批次边界内）。
- 新增：`UsageIndexStore.test.ts`、`TranscriptRepository.test.ts`。
- 未触碰：`ConversationManager.ts`、`storage.ts`、`HistorySegmentCache.ts`、`executor.ts`、checkpoint 模块、frontend、webview、`CHANGELOG.md`、规划文档。

---

## 三、遗留说明

- 高项“freshness 判 fresh 不可自愈”随丢失更新消除而解决：索引不再缺条目，mtime 判定保持有效；极端情况下（如 rename 失败导致索引缺失）走 missing → 重建自愈。
- 队列 Map 在链尾 settled 后自动清理，与 ConversationManager 既有写队列同款；挂起任务泄漏属既有模式（storage.ts 低项 #6 由其他批次负责）。
- TranscriptRepository 的性能收益（跳过回读）需适配器返回落盘形态后才能体现，属渐进式接口能力，未破坏现状。
