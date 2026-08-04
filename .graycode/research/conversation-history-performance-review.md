# 对话历史性能改造（HIS-01~HIS-14）代码复审报告

> 审查日期：2026-08-04（后台子 agent，只读审查）
> 审查范围：`backend/modules/conversation/` 全部文件（TranscriptRepository、历史分段存储 storage.ts、用量索引 UsageIndexStore/usageStats/usageCache、HistorySegmentCache、ConversationManager 等）、`backend/modules/api/chat/services/ToolExecutionService.ts`、`backend/__tests__/conversation/` 相关测试（抽查）、前端 HIS-12/HIS-13 改动（简略）。

---

## 一、按文件分组的问题清单

### 1. backend/modules/conversation/storage.ts

**【中】writeSegmentedHistory 双 rename 提交窗口：读侧可静默读到"新段 + 旧 index"的错位历史**
- 位置：L926-947（目录 rename 与 index rename 是两次独立操作）；读侧 L1138-1165（loadSegmentedHistory）
- 描述：appendHistory 的"先段后 index"约定在**追加**场景下成立（旧 index 截断新尾段多余行，读到的是完整旧前缀）。但 writeSegmentedHistory 是**全量重写**：目录 rename 后、index rename 前，读侧看到的是"新段文件 + 旧 index"。若新旧历史段数/计数不同（保存历史变长或变短是常态），旧 index 的 count 会截取**新内容**，或引用**不存在的段文件**。段缺失时走 `not_found`，loadHistoryWithStatus 有 50ms 重试兜底；但段数相同、计数不同时（如 200 条→250 条），会**静默返回缺少 50 条的新历史**，不报任何错误。
- 影响：毫秒级窗口内的读取返回被截断/错位的完整历史，可能直接用于 API 请求或前端展示，且无错误信号；崩溃恢复也没有 index↔段一致性校验。
- 修复建议：在 `loadSegmentedHistory` 读完后校验 `Σ segments.count === index.totalMessages` 且段文件齐全，不满足则延迟重试一次后再失败；或在 index 中增加 generation/commitId 并与段目录标记文件比对。

**【低】M4 自愈路径优先采用 legacy，可能丢失 index 之后的追加内容**
- 位置：L1020-1043
- 描述：尾段损坏回退时，若 legacy 文件存在且非空则直接 `existing = legacyResult.value`。legacy 只在分段完成后才被删除（L949-954），因此"legacy 与 index 同时存在"只发生在 index rename 完成但 legacy 尚未删除的崩溃窗口；此时 legacy 是旧快照，会丢掉分段之后的所有追加。
- 影响：极端罕见（崩溃窗口 + 尾段损坏叠加），但会静默丢消息。
- 修复建议：优先从可读 segments 重建 existing，只有没有任何 segment 可读时才用 legacy。

**【低】appendHistory 崩溃自愈后 totalMessages 与 Σcount 可能不一致**
- 位置：L992-993（totalMessages 从旧 index 继承）+ L1047-1052（尾段按 `last.count` 截断）+ L1067-1072（提交 nextIndex）
- 描述：若 index.count 大于段文件实际行数（异常态），`updated.length` 会小于 `last.count`，但 `totalMessages` 仍按 `index.totalMessages + take` 累加，最终 index 的 totalMessages ≠ Σcount，导致 `loadHistoryPage.total`（来自 totalMessages）与 `loadHistory` 实际长度不一致，前端分页 total 错位。
- 影响：分页 total 与消息数组长度不一致，前端窗口/游标计算错位。
- 修复建议：提交前把 `nextIndex.totalMessages` 重算为 `Σ segments.count`（或写回前重新读实际长度）。

**【低】getHistoryIndexInfo 对每个 segment 做一次 stat（O(段数)）**
- 位置：L1103-1116
- 描述：M1(b) 校验逐段 `exists()`。该方法被 `ConversationManager.updateSummary` 的 M3 钳制逻辑在每条消息后触发（见 ConversationManager 第 10 项），长会话（50 段）每次追加都要 50+ 次 stat。
- 影响：高频追加路径上的无谓文件 IO，与 HIS-11"只读结构、轻量"的目标部分背离。
- 修复建议：提供只读 index JSON 的 `totalMessages` 轻量路径（钳制只需要 totalMessages），把逐段 stat 留到真正的完整性检查场景。

**【低】读侧只重试一次（50ms）**
- 位置：L1289-1298（loadHistoryWithStatus）、L1310-1319（loadHistoryPage）
- 描述：写提交窗口内 `not_found/io_error` 只重试一次；流式高频追加时可能连续命中窗口。
- 影响：偶发抖动，前端表现为一次加载失败（当前调用方已有容错，风险有限）。
- 修复建议：重试 2~3 次带退避，或读取顺序改为"先读 index 再读段"，把暴露窗口缩到段 rename 本身。

**【低】segmentedHistoryWriteQueues / metadataWriteChains 的 Map 仅在链尾完成时清理**
- 位置：L21-34、L40-65
- 描述：若某个会话的任务 Promise 永不 resolve（挂起），队列条目永久残留。metadataWriteChains 有 10000 上限兜底（L41），但淘汰最旧条目时若其链仍在运行，会与该会话的新链并发执行，重新引入"基于旧 meta 整体写回互相覆盖"的问题（仅极端规模可达）。
- 影响：极端情况下内存泄漏或 custom 字段覆盖丢失。
- 修复建议：对挂起任务加超时保护；淘汰时跳过仍在运行中的链。

---

### 2. backend/modules/conversation/UsageIndexStore.ts

**【高】appendUsage / appendUsageMessages 的 read-modify-write 无锁，并发丢失更新且无法自愈**
- 位置：L112-141（appendUsage）、L149-161（appendUsageMessages）；调用方 backend/tools/subagents/executor.ts L924
- 描述：两者都是 `read(usage.json) → push → write`，没有任何串行化，且真实并发场景明确存在：
  1. ToolExecutionService 会把同一响应中的多个 subagents **并行**执行（`isSubAgentCall` 并行组，ToolExecutionService L375-378），每个子代理每轮 generate 后都会 `reportUsageToMainConversation` → `appendUsageMessages`；两个并行子代理对同一 usage.json 同时读改写 → 后写覆盖先写，条目丢失；
  2. 子代理归集（不经主会话写锁）与主会话 `updateUsageIndex`（全量重建，ConversationManager L223-241）/`updateUsageIndexAppend`（L248-261，在主会话写锁内）也并发，同样会互相覆盖。
- 影响：写入后 index mtime 新于历史 mtime → `getFreshness` 判定 fresh → 统计长期信任**缺条目**的索引，token 用量静默少计（并行子代理场景尤其容易丢），且不会被 freshness 机制发现（mtime 反而"看起来更新"，缺的条目要等下一次历史写入才可能被重建补齐）。
- 修复建议：把用量索引的读改写并入会话级串行链——在 ConversationManager 侧用 `withMetadataWriteSerialized(conversationId, ...)` 包住 `appendUsage*` 与全量重建（子代理归集入口 `appendUsageIndexMessages` 也要进链）；或 FileUsageIndexStore 内部加 per-conversation 写队列。

**【低】usage.json 写入非原子（直接 writeFile）**
- 位置：L95-100
- 描述：崩溃/被杀进程可能留下截断 JSON；read() 返回 null 会触发重建，可自愈。但截断内容可能在并发读侧短暂可见，且与上文无锁写叠加时丢数据风险放大。
- 修复建议：与 meta.json 一致改用 tmp + rename 原子提交（复用 FileSystemStorageAdapter.saveMetadata 的模式）。

---

### 3. backend/modules/conversation/ConversationManager.ts

**【中】getMessagesPaged 初始页仍触发全量历史读取 + 全量 JSON 深拷贝（HIS-13 后端收益被抵消）**
- 位置：L845-857（isInitialPage → normalizeHistoryForDisplay），normalizeHistoryForDisplay L431-502，TranscriptRepository.mutateContents→getContents L120-127
- 描述：打开会话的首屏请求先走 `normalizeHistoryForDisplay` → `mutateContents` → `getContents` → `loadHistory`（全量读所有段）→ `cloneTranscriptContents`（全量 **JSON.stringify + parse 深拷贝**）。即使历史没有任何悬空工具调用（绝大多数情况），深拷贝也必然发生，之后才执行 `loadHistoryPage` 取窗口。10k 条消息的对话每次打开都要序列化/反序列化整个历史。
- 影响：长对话首屏延迟的主要来源仍在后端；HIS-13"首屏先展示"的收益被全量读 + 深拷贝抵消大半。
- 修复建议：先做一次**只读浅扫描**（用浅拷贝数组，只遍历检查是否存在无响应的 functionCall，不深拷贝）；仅当发现悬空调用时才走 mutate + 深拷贝写回路径。悬空调用只在取消/中断后出现，正常路径可完全跳过深拷贝。

**【中】updateSummary 的 M3 钳制每次调用都做 O(段数) 次 stat**
- 位置：L1954-1964（resolveHistoryIndexInfo → storage.getHistoryIndexInfo）
- 描述：前端在**每条消息发送后**调用 `conversation.updateSummary`（frontend/src/stores/chat/conversationActions.ts L899）；钳制逻辑调用 getHistoryIndexInfo，其内部对每个 segment 做 exists() stat（storage.ts L1103-1116）。50 段的历史 = 每次追加 51 次文件 stat。
- 影响：高频追加路径上的无谓 IO，与 HIS-09"合并元数据写入"的初衷冲突。
- 修复建议：钳制只需要 `index.totalMessages`，新增"只读 index JSON"的轻量方法（1 次读、0 次逐段 stat）；仅当 index 不可读时才跳过钳制。

**【中】deleteConversation 与进行中的流式写入存在"删除后复活"竞态**
- 位置：deleteConversation L630-661（不走 `withConversationWriteLock`）；storage.deleteHistory L1346-1371（只在 storage 级写队列排队）
- 描述：delete 只排队到 storage 级写队列，保证"已排队的写先完成再删"。但**正在流式生成的会话**：用户删除后，工具循环/流式收尾的后续 append（addContent/appendContents 每次单独取会话锁）会排到 delete **之后**执行 → 重新创建 `{id}/history/` 目录，会话以"无 meta 的幽灵"复活，且带半截历史。代码注释（storage.ts L1347-1348）只覆盖了"排队中的写"，没有覆盖"删除后新发起的写"。
- 影响：删除操作偶发失效，历史列表出现复活会话（meta 缺失走 fallback 元数据）。
- 修复建议：删除时把会话 ID 记入"已删除"集合，ConversationManager 的 append/mutate 入口先检查并短路；或删除时一并取消该会话关联的流（abort controller 已存在）。

**【低】updateSummary 注释与实现不符：注释称"updatedAt 不在此写"，L1970 实际写了 `meta.updatedAt = Date.now()`**
- 位置：L1929-1932（注释）vs L1970（实现）
- 描述：appendHistory 失败但前端仍乐观调用 updateSummary 时，meta.updatedAt 会被无意义前移（M3 钳制只救了 messageCount，没救 updatedAt），对话列表按 updatedAt 排序会因此跳动。
- 影响：删除/追加失败场景下列表排序抖动。
- 修复建议：按注释语义去掉 L1970 的 updatedAt 写入（历史提交路径已统一维护），或修正注释并说明为何必须写。

**【低】getConversationMetadataBatch 静默截断 200 条且无截断标志**
- 位置：L1993-1997
- 描述：`ids.slice(0, 200)` 静默截断。前端已按"实际返回数"推进游标（conversationActions.ts L538，L3 处理），当前行为正确；但后端无任何信号告知截断发生，未来 pageSize 配置超过 200 时会静默丢页。
- 影响：当前无实际影响，属契约隐患。
- 修复建议：返回 `truncated` 标志，或按请求数量返回（不截断）。

---

### 4. backend/modules/conversation/TranscriptRepository.ts

**【低】appendContents 返回值语义变化：返回"新增内容副本"而非"完整历史"**
- 位置：L71-89
- 描述：append-only 路径返回 `cloneTranscriptContents(copies)`，与 replace/mutate 返回"保存后的完整历史"语义不一致（L105-111 saveAndReload）。当前所有调用方都不依赖返回值，但这是隐式契约分叉；且回退路径（无 append 委托）会 `saveAndReload` 再读一次全量，两条路径行为不一致。
- 影响：契约隐患；回退路径多一次全量读。
- 修复建议：在接口注释中显式声明 append 系列返回"已追加内容"；或统一为不返回历史（void），消除歧义。

**【低】saveAndReload 每次写后全量回读 + 深拷贝**
- 位置：L105-111
- 描述：replace/mutate（删除、编辑、回档、截断，即 HIS-02 明确要走全量重写的场景）每次保存后 `getContents()` 全量读 + JSON 深拷贝。这是"返回真实落盘形态"的设计取舍，但长对话下结构性变更在已写全量之后又额外多一次全量读 + 拷贝。
- 影响：结构性变更路径的常数开销翻倍。
- 修复建议：让 delegate 的 saveContents 返回落盘形态，省去回读；至少把回读的深拷贝降为浅拷贝 + 调用方按需深拷贝。

---

### 5. backend/modules/conversation/history/HistorySegmentCache.ts

**【低】容量按"段数"计（默认 32 段 ≈ 6400 条），单段消息无字节上限**
- 位置：L30-35（容量）、L81-87（LRU 淘汰）
- 描述：段大小固定 200 条，但每条消息的 parts 可能很大（大文本、base64 多模态，200 条大消息可达几十 MB）；32 段上限不约束字节数。另外 `invalidateConversation`（L64-71）每次写后遍历全 Map（O(n)），而写后失效是高频路径。
- 影响：极端大消息场景内存超限；高频写路径 O(n) 遍历。
- 修复建议：增加按字节估算的软上限（每段缓存时记录字节数，超限按 LRU 提前淘汰）；invalidate 改为按 conversationId 分桶的 Map 索引，避免全表扫描。

**【低】mtime 作为缓存键的毫秒级同刻写入无法感知**
- 位置：storage.ts L724-748（readSegmentCached）
- 描述：外部进程在同一毫秒内改段文件且 mtime 未变（或文件系统 mtime 精度不足，如 FAT 2 秒粒度）时缓存不失效。理论窗口，风险极低。
- 修复建议：可接受；如需更稳，把文件 size 一并纳入缓存键。

---

### 6. backend/modules/api/chat/services/ToolExecutionService.ts

**【低】abort 中断后仍创建 after 检查点**
- 位置：L307-309（abort 时 break）vs L455-466（无条件创建 after checkpoint）
- 描述：工具循环被 abort 打断（用户取消/流中断）后，`toolNameForCheckpoint` 仍为真时会对"只执行了一半"的工作区状态创建 after 存档，快照内容含部分执行的副作用，与 before 存档之间的"完整批次"语义不符。
- 影响：取消场景产生误导性存档点（恢复它等于恢复半执行状态）。
- 修复建议：abort 时跳过 after checkpoint，或加 `partial: true` 标记。

**【低】批量检查点判定与 CheckpointManager 的 tool_batch 语义不一致**
- 位置：L244-266（toolNameForCheckpoint）vs CheckpointManager L464-471
- 描述：批次只要含任一配置工具就上报 `tool_batch`；CheckpointManager 对 tool_batch 的 before 判定是 `beforeTools.length > 0`（不看批次里实际有没有 before 类工具）。若配置 `beforeTools=[write_file]`、`afterTools=[insert_code]`，一个只含 insert_code 的批次也会创建**多余的 before 检查点**（整工作区快照）。
- 影响：多余的全工作区快照开销——正是 CPF-05 想避免的那类问题。
- 修复建议：批次上报前按 phase 分别判断"批内是否存在 beforeTools 工具 / afterTools 工具"，分别传 'tool_batch' 或 null。

---

### 7. backend/modules/conversation/usageStats.ts

**【低】listConversations 失败时会把整个 UsageStatsCache 清空**
- 位置：L430-435（listConversations 失败 → conversationIds=[]）+ L547-550（cache.prune(new Set(conversationIds))）
- 描述：目录瞬时读取错误时 `conversationIds` 为空数组，末尾 prune 会清空全部内存明细，下次统计全量重读。
- 影响：安全但低效（瞬时错误导致整体缓存失效，统计页变慢一轮）。
- 修复建议：list 失败时跳过 prune。

**【低】统计侧重建索引与子代理归集的并发写无锁**（与 UsageIndexStore 高项同源）
- 位置：L509-528
- 描述：统计侧重建写回 `indexStore.write` 与子代理 `appendUsageMessages` 并发时同样会互相覆盖 subagent 条目。重建路径已有"合并旧索引 subagent 条目"的保护（L512-524），但读到的旧索引本身可能是并发丢失后的版本，保护不彻底。
- 影响：与高项叠加，subagent 条目仍可能丢。
- 修复建议：统一走会话级串行链（见 UsageIndexStore 高项修复建议）。

---

### 8. backend/modules/conversation/usageCache.ts

**【低】fs.watch recursive 在部分平台/Node 版本下静默降级为非递归**
- 位置：L171-187
- 描述：`fs.watch(dir, {recursive:true})` 在旧 Node 或部分 Linux 内核上创建时不抛错但不递归；此时 segmented 历史写在 `{id}/history/` 子目录内的事件不会触发，内存缓存永久陈旧——统计命中缓存时根本不查磁盘，数字停留在旧值。
- 影响：统计页数字错误且无任何告警。
- 修复建议：创建后做一次递归能力探测（写探针文件并确认收到事件），不支持则退化为"每次统计对全量对话做 mtime 快照比对"或定期全量失效。

---

### 9. 测试（backend/__tests__/conversation/，抽查）

**【低】覆盖缺口**
- 已覆盖且质量好：append 崩溃一致性（storageAppend.test.ts：临时段/临时 index 写失败、H1 残留截断、M4 尾段缺失自愈）、段边界（200 条拆段）、LRU 失效（写后失效、deleteHistory、M5 外部 mtime 失效、M2 浅拷贝不污染）、HIS-11 只读 index、metadata 损坏降级（metadataCorruption.test.ts）、批量元数据与 messageCount 钳制、用量索引增量/重建、前端 HIS-10/13。
- 缺失用例（建议补充）：
  1. writeSegmentedHistory 双 rename 窗口内读侧一致性（"新段 + 旧 index"静默截断场景）；
  2. 用量索引并发 lost-update（并行 subagent appendUsageMessages 互相覆盖）；
  3. deleteConversation 与流式 append 的"复活"竞态。

---

### 10. 前端（HIS-12/HIS-13，简略）

- HIS-10 批量摘要：一次 IPC 拉一页摘要，游标按实际返回数推进，正确处理后端 200 截断；无 N+1 IPC。✔
- HIS-13 首屏 + 异步补拉：`renderMessageWindow` 先渲染末页再补拉；合并前校验会话身份与窗口未被改动，与流式/发送/上拉的竞态防护正确。✔
- HIS-12 computed 扫描优化：未发现明显回归。✔
- 小观察：补拉为顺序逐页，历史极长时首屏"可见数达标"前串行多次 IPC；当前阈值下可接受，可考虑并行拉 2~3 页。

---

## 二、按严重程度排序的汇总清单

| 严重度 | # | 文件:行 | 问题 | 影响 |
|---|---|---|---|---|
| **高** | 7 | UsageIndexStore.ts L112-161（+executor.ts L924） | usage.json 读改写无锁：并行子代理 / 主会话并发 appendUsage* → 丢失更新；写后 mtime 新 → freshness 判 fresh → 统计长期信任缺条目的索引 | 用量统计**静默少计**，不可自愈 |
| **中** | 1 | storage.ts L926-947（读侧 L1138-1165） | writeSegmentedHistory 双 rename 窗口：读侧可见"新段+旧 index"，段数/计数变化时**静默**返回截断/错位历史（非 not_found，重试不覆盖） | 罕见但无错误信号的错误数据 |
| **中** | 9 | ConversationManager.ts L845-857 + L431-502 | 打开会话初始页仍全量读 + 全量 JSON 深拷贝（HIS-13 后端收益被抵消） | 长对话首屏延迟主因 |
| **中** | 10 | ConversationManager.ts L1954-1964 + storage.ts L1103-1116 | updateSummary 每次消息后做 O(段数) 次 stat（M3 钳制） | 高频追加路径无谓 IO |
| **中** | 11 | ConversationManager.ts L630-661 + storage.ts L1346-1371 | deleteConversation 不与会话级写锁协同：流式中删除 → 后续 append 复活会话（无 meta 幽灵） | 删除偶发失效 |
| 低 | 2 | storage.ts L1020-1043 | M4 自愈优先用 legacy，崩溃窗口内丢分段后追加 | 极端罕见丢消息 |
| 低 | 3 | storage.ts L992-1052 | 异常态 totalMessages 与 Σcount 不一致 → 分页 total 错位 | 展示错位 |
| 低 | 4 | storage.ts L1091-1136 | getHistoryIndexInfo 逐段 stat（O(段数)） | 见 #10 |
| 低 | 5 | storage.ts L1289-1319 | 读侧只重试一次 50ms | 偶发抖动 |
| 低 | 6 | storage.ts L21-65 | 写队列/元数据链 Map 挂起泄漏；淘汰可能打断运行中的链 | 极端场景 |
| 低 | 8 | UsageIndexStore.ts L95-100 | usage.json 非原子写 | 可自愈，低危 |
| 低 | 12 | ConversationManager.ts L1970 | updateSummary 注释与实现不符，updatedAt 被多余写入 | 列表排序抖动 |
| 低 | 13 | ConversationManager.ts L1993-1997 | 批量摘要静默截断无标志 | 未来配置超限时丢页 |
| 低 | 14 | TranscriptRepository.ts L71-89 | append 返回语义与 replace 分叉 | 契约隐患 |
| 低 | 15 | TranscriptRepository.ts L105-111 | saveAndReload 写后全量回读 + 深拷贝 | 结构性变更路径翻倍开销 |
| 低 | 16 | HistorySegmentCache.ts L30-87 | 容量按段数计无字节上限；写后失效 O(n) 遍历 | 极端大消息内存超限 |
| 低 | 17 | storage.ts L724-748 | mtime 同毫秒/低精度文件系统写入无法感知 | 理论窗口 |
| 低 | 18 | ToolExecutionService.ts L455-466 | abort 后仍创建 after 检查点（半执行快照） | 误导性存档 |
| 低 | 19 | ToolExecutionService.ts L244-266 | 批次检查点判定与 CheckpointManager 不一致 → 多余 before 快照 | 性能开销 |
| 低 | 20 | usageStats.ts L430-435/L547-550 | listConversations 失败清空整个内存缓存 | 效率回退 |
| 低 | 21 | usageStats.ts L509-528 | 统计重建与子代理归集并发无锁（与 #7 同源） | 叠加丢条目 |
| 低 | 22 | usageCache.ts L171-187 | fs.watch recursive 平台差异 → 缓存永久陈旧 | 统计数字错误 |
| 低 | 23 | 测试 | 缺：双 rename 读一致性、用量索引并发、删除复活三组用例 | 回归风险 |

---

## 三、总体评价

HIS-01~HIS-14 的实现整体质量高：append-only 崩溃一致性设计（index 作为提交点 + H1 截断 + M4 自愈）扎实，测试覆盖充分，前端窗口/补拉竞态防护正确，批量元数据与摘要合并确实减少了 IPC。需要优先处理的是：

1. **用量索引的并发丢失更新（高）**——并行子代理是真实高频场景，丢失静默且 freshness 机制无法发现；
2. **writeSegmentedHistory 读侧一致性窗口（中）**——毫秒级但静默错数据；
3. **getMessagesPaged 初始页全量深拷贝与 updateSummary 逐段 stat（中）**——两个性能残留点，修复成本低（浅扫描 + 轻量索引读取）；
4. **删除-流式复活竞态（中）**——需在会话层加"已删除"短路或联动取消。
