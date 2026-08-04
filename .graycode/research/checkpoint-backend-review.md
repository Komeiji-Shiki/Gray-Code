# Checkpoint 模块复审报告

> 审查日期：2026-08-04（后台子 agent，只读审查）
> 审查范围：`backend/modules/checkpoint/`（13 个文件）、`webview/handlers/CheckpointHandlers.ts`、`backend/modules/settings/SettingsManager.ts`（checkpoint 配置段约 736-937 行）、`backend/modules/settings/types.ts`（CheckpointConfig / CheckpointExclusionConfig / MessageCheckpointConfig）。

## 总体印象

第一~三阶段改造整体质量较高：锁的可重入设计（同 owner 引用计数、文件写锁同 holder 计数对称）、增量链批量删除的祖先闭包计算（CP-05）、恢复引擎的路径安全解析（`normalizeSafeCheckpointPath` 拒绝 `..`/绝对路径/盘符/UNC/`\0`，`resolveSafePathInsideRoot` 逐层 lstat 防符号链接与 junction）、manifest 独立存储与轻量摘要（CPF-01~03）、有界并发与流式哈希（CPF-06/07）均实现正确，metadata 读改写走 `withMetadataWriteSerialized` 原子链也无丢记录竞态。

但发现 1 个高危路径安全问题（删除路径未校验 `backupDir`，可经损坏元数据触发递归删除）、1 个中高危增量链保护缺口（索引删除在消息索引回退场景下可断链）、以及若干中危性能/配置校验/强制排除绕过问题。

---

## 1. backend/modules/checkpoint/CheckpointManager.ts

**[高] CP-DEL-1 删除路径未校验 `backupDir`，可经损坏元数据递归删除存档目录外任意目录**
- 位置：L1753-1759（`deleteCheckpointInternal`）、L1826-1832（`deleteCheckpointsFromIndexInternal`）、L1956-1963（`deleteAllCheckpoints`）、L2078-2084（`deleteCheckpointsBatch`）
- 描述：四处删除路径都直接 `path.join(this.checkpointsDir, backupDirToDelete)` 后执行 `fs.rm(backupPath, { recursive: true, force: true })`。`backupDir` 来自对话元数据中的 CheckpointRecord，正常流程由 `generateCheckpointId()` 生成 `cp_xxx`，但元数据 JSON 可被手工编辑/损坏/被恶意扩展写入。恢复引擎对 `backupDir` 有 `isPathInside(checkpointsRoot, backupRoot)` 校验（CheckpointRestoreEngine L305），删除路径完全没有。
- 影响：若某条记录的 `backupDir` 被篡改为 `../../some/path`，`fs.rm(recursive)` 会递归删除扩展存储之外的内容；`deleteAllCheckpoints`/批量删除一次可删多个目录。这是计划文档自身要求（"校验 backupDir 只能是安全目录名"）的遗漏实现。
- 修复建议：删除前统一校验目录名，如 `/^cp_[a-z0-9_]+$/i.test(backupDir)`（与 `removeOrphanBackupDirs` 的过滤一致），或复用 `isPathInside(checkpointsDir, path.resolve(checkpointsDir, backupDir))`；校验失败直接返回 false 并告警。建议抽成共享的 `assertSafeCheckpointDirName()` 供删除/合并/manifest 路径共用。

**[高] CP-IDX-1 `deleteCheckpointsFromIndexInternal` 的基链保护假设在索引回退场景下不成立**
- 位置：L1793-1820（尤其 L1801-1802 注释："其余保留节点（messageIndex < fromIndex）的祖先链按索引天然也在保留区间内"）
- 描述：该函数只对 `excludeCheckpointId` 及其基链做闭包保留，其余保留节点（`messageIndex < fromIndex`）的基链安全完全依赖"消息索引随创建时间单调递增"的假设。但编辑/回档/重试会让索引回退，可构造如下序列：存档 B（messageIndex=10）→ 截断对话到 3 条消息 → 重试产生新存档 R（messageIndex=3，base=B）→ 再次截断到 fromIndex=4 时，B（10≥4）被删而 R（3<4）保留 → R 的 `baseCheckpointId` 悬空，恢复 R 必报 chainBroken 且无法修复。批量删除路径（CP-05 闭包计算）已处理此问题，索引删除路径没有。
- 影响：编辑+重试序列后可产生永久断链存档，与 CP-05 验收标准不符；恢复时用户看到"链断裂"错误。
- 修复建议：与 `deleteCheckpointsBatch` 相同，在计算 `toDelete` 前从所有保留节点（`messageIndex < fromIndex` 及 excludeIds）向前遍历祖先链生成 `forcedKeep` 闭包，被依赖的基快照即使 index ≥ fromIndex 也强制保留；被拒绝删除的项随返回值上报前端。

**[中] CP-PERF-1 恢复/预览路径对全工作区顺序哈希，无并发且每文件一次 await**
- 位置：`collectCurrentWorkspaceState` L1514-1536（L1525 `await this.getFileHash(file)` 在 for 循环内顺序执行）、`restoreLegacyCheckpointViaEngine` L1600-1607
- 描述：CPF-06 要求文件哈希/复制/恢复全部有界并发，快照构建器已做到；但恢复侧 `collectCurrentWorkspaceState` 仍是对每个文件顺序 `getFileHash`。每次 `restoreCheckpoint` 和每次 `previewRestore` 都会对当前工作区做一次全量 MD5；预览+确认执行 = 至少两轮全量哈希。10 万文件工作区下可达数分钟。
- 影响：恢复/预览耗时长，且期间持有全局文件写锁（见 CP-LOCK-2），阻塞主会话与 SubAgent 全部写工具。
- 修复建议：用 `runBounded` 并行哈希；更优做法是利用目标 manifest 中已存的 `mtimeMs/mtimeNs+size` 做快路径——stat 与目标一致的文件直接采用目标哈希，只对漂移文件读盘哈希（快照构建器已有 stat 复用逻辑，可抽取共享比较函数）。

**[中] CP-LOCK-2 `previewRestore` 以只读扫描持有全局文件写锁**
- 位置：L1215-1218（`previewRestore` 调用 `runExclusive('restore')`）→ `CheckpointOperationLock.runWithFileLock`（CheckpointOperationLock.ts L90：`fileWriteLockManager.acquire([''], ...)`）
- 描述：预览是纯计算（`prepareRestore` + `computeRestorePlan`，无任何文件写入），却获取全局根文件锁（`''`），全工作区扫描+哈希期间所有写工具被阻塞。
- 影响：用户打开恢复确认框等待确认时，助手完全无法写文件；大工作区下体验差，且预览被取消也无法中途释放该锁。
- 修复建议：为 `runExclusive` 增加 `needFileLock?: boolean` 选项（预览/只读查询类操作只取工作区级锁），或把 `acquireWorkspaceLock` 与 `runWithFileLock` 拆成两个可组合步骤。

**[中] CP-MAINT-1 CheckpointManager.ts 仍达 2327 行，CPF-12 拆分未完成**
- 位置：全文件
- 描述：`restoreLegacyCheckpointViaEngine`（L1579-1673）、`refreshAffectedDocuments`（L1850-1920）、`filterRestoreTargetScoped`（L899-946）、`collectCurrentWorkspaceState`（L1514-1536）、`buildExcludedNote`（L2283-2315）等大段文件系统/UI 逻辑仍堆积在管理器内；管理器实际承担了"协调 + 文件系统 + VSCode 文档刷新"三种职责。
- 影响：后续第七阶段分支-存档联动（BCP 系列）会继续增大该文件；复审/测试/排错的认知负担高。
- 修复建议：将恢复侧文件操作抽入 RestoreEngine 或新 `CheckpointRestoreService`；`refreshAffectedDocuments` 独立为 `WorkspaceEditorRefresher`；`buildExcludedNote` 移入 ExcludedNoteBuilder。

**[低] CP-DEAD-1 `mergeCheckpointIntoSuccessor` 私有包装是死代码**
- 位置：L1694-1700
- 描述：`cleanupOldCheckpoints` 已直接委托 `retentionService.cleanupOldCheckpoints`，Manager 内这个私有包装方法无任何调用方。
- 影响：死代码增加维护噪音；若未来有人误以为"Manager 负责合并"而在 Manager 内调用，反而绕过了 RetentionService 的 manifest 同步逻辑。
- 修复建议：删除该包装方法。

**[低] CP-I18N-1 恢复说明与失败摘要绕过 i18n**
- 位置：`buildExcludedNote` L2306-2307（硬编码中文文案）、`formatFailureSummary` L1566-1570；`prepareRestore` 多处英文错误串（L1358/L1397/L1430/L1454）与周围 `t()` 混用。
- 影响：文案不随语言切换，用户可能看到两种语言的混合错误。
- 修复建议：统一走 `t()`（MIG-06 一并处理）。

**[低] CP-PREV-1 预览的 `deleted` 计数包含未确认删除的 untracked 文件**
- 位置：L1286 `deleted: plan.toDelete.length + plan.untrackedToDelete.length`
- 描述：默认执行（`deleteUntrackedFiles=false`）只删除 `toDelete`，但预览把 `untrackedToDelete`（快照后新建、默认保留）也计入"将删除"。当前前端总是在确认清单后传 true，二者一致；但任何未来调用方若预览后不传 `deleteUntrackedFiles`，展示数与实际执行数不符，破坏"预览与执行严格一致"的契约（CP-09）。
- 修复建议：返回 `deleted`（确认后）与 `deletedIfUnconfirmed` 两个值，或在接口注释中明确并强制校验。

---

## 2. backend/modules/checkpoint/CheckpointManifestRepository.ts

**[中] CP-CACHE-1 manifest 内存缓存无界且无失效机制**
- 位置：L25 `private readonly cache = new Map<string, CheckpointManifest>()`
- 描述：`loadManifest` 把所有加载过的 manifest 永久缓存，没有任何容量上限或 LRU 淘汰。每个 manifest 含全工作区 `files` 映射（10 万文件 ≈ 10-20MB/个）；一次恢复会加载整条增量链，跨对话/多次恢复后内存持续累积。计划要求"所有缓存都有明确上限和失效条件"，此处两者皆无。
- 影响：长时间运行的扩展宿主内存持续增长，可能触发 GC 压力或 OOM。
- 修复建议：改为 LRU（上限 16~32 条）；`getManifest` 路径可改为"读后即弃、不写缓存"；对话关闭/删除时联动清理。

**[低] CP-DEAD-2 `hasManifest` 无生产调用方**
- 位置：L44-51
- 修复建议：删除，或接入需要"磁盘探测不走缓存"的场景并注明。

**[中] CP-PATH-1 `getManifestPath` 未校验 checkpointId（与 CP-DEL-1 同根因）**
- 位置：L30-32；`CheckpointManager.getManifest` L2142-2144 直接把 webview 传入的 `checkpointId` 交给 `loadManifest`（handler 未做任何过滤）
- 描述：`getManifestPath` 直接 `path.join(checkpointsDir, checkpointId, 'manifest.json')`，未校验 `checkpointId` 是否为 `cp_*` 安全名。webview 可传 `../../...` 尝试跨目录读文件；`writeManifest` 则可把文件写到存储根之外。
- 影响：存档目录边界被破坏；与 CP-DEL-1 组合后，损坏/恶意元数据具备"目录外读 + 目录外递归删"能力。
- 修复建议：`getManifestPath` 内统一做 `/^cp_[a-z0-9_]+$/i` 校验，非法即抛 `CheckpointPathError`；与 CP-DEL-1 共用同一校验函数。

---

## 3. backend/modules/checkpoint/CheckpointRestoreEngine.ts

**[低] CP-ORDER-1 恢复先删除后复制，复制失败时工作区处于"已删未补"的破坏性中间态**
- 位置：L370-386（删除阶段）在 L391-436（复制恢复阶段）之前
- 描述：若目标文件备份缺失或复制失败，用户当前文件已被删除且无法回补；失败清单虽如实上报，但文件顺序设计放大了破坏窗口。
- 影响：部分失败恢复后，用户可能丢失"本可保留"的当前版本文件。
- 修复建议：先执行新增/修改文件的复制（含哈希校验），全部成功后最后再删除多余文件。`toDelete` 与 `filesToRestore` 路径不相交，调整顺序无副作用。

**[低] CP-PROG-1 删除阶段不上报进度**
- 位置：L370-386 与 L391-436 对比（`onProgress` 只在恢复文件循环回调）
- 描述：删除阶段的 `total`/`processed` 缺失，前端进度条在删除阶段停滞。
- 修复建议：删除循环同样调用 `onProgress`，total 改为 `deletionList.length + filesToRestore.length`。

---

## 4. backend/modules/checkpoint/CheckpointIgnoreResolver.ts

**[中] EX-CASE-1 强制排除的目录片段匹配大小写敏感，Windows/macOS 可绕过**
- 位置：L116 `FORCED_IGNORED_SEGMENTS = new Set(['.git', 'node_modules'])`、L452-456 的逐段比较
- 描述：强制排除用精确字符串比较，未做大小写折叠。Windows（不区分大小写）下 `.GIT`、`NODE_MODULES` 目录不会被强制排除，会进入扫描与备份（node_modules 可达数 GB，且破坏 EX-02 的"不可被否定规则覆盖"边界）；macOS 默认 APFS 大小写不敏感，同样存在。注意绝对路径排除已做 win32 小写折叠（L233-250），但目录片段这一层没有，两层口径不一致。
- 影响：强制排除边界（EX-02）在 Windows/macOS 上可被大小写变体绕过，备份体积暴增、耗时剧增，.git 内部文件可能被备份（含敏感历史）。
- 修复建议：win32（及 darwin 大小写不敏感卷）下对 segment 做 `toLowerCase()` 后再比较；测试补 `.GIT`/`NODE_MODULES` 大小写用例。

**[中] EX-CASE-2 扩展存储自排除在 macOS 上大小写敏感**
- 位置：`isExcludedAbsolutePath` L233-250（仅 `process.platform === 'win32'` 时折叠大小写）
- 描述：macOS APFS 默认大小写不敏感，若工作区内通过不同大小写路径引用扩展存储目录，字符串比较不等 → 扫描会深入存储目录，可能把 checkpoints 自身（含正在写入的备份）递归备份，破坏 CP-07"存档绝不备份自己"的目标；同时扫描与写入并发会造成快照内容自增长。
- 影响：自定义数据目录位于工作区内的部署（CP-07 修复场景）在 macOS 上仍可能自备份。
- 修复建议：darwin 同样做 case-fold，或对 excludeAbsolutePaths 先 `fs.realpath` 归一化再比较；`CheckpointWorkspace.normalizeWorkspaceUri`（L46-49）的同类问题一并处理。

**[低] CP-SYMLINK-1 快照扫描静默丢弃符号链接**
- 位置：L354-358（`entry.isDirectory()`/`entry.isFile()` 对 symlink 均为 false，既不递归也不记录）
- 描述：工作区内的符号链接文件/目录不会进入 `files`/`dirs`，也不进 `excluded` 清单；恢复时链接路径不在 currentHashes 中故不会被删除，恢复引擎的 lstat 校验也会拒绝经过链接的写入。行为上安全，但用户对"链接指向的文件为什么没有备份/恢复"无任何提示。
- 修复建议：将符号链接记录进 manifest，或在 excluded 清单中给出 reason（如 `unsupported_file_type`），并在预览中展示。

**[低] CP-DEAD-3 `removeEmptyDirectories` 无生产调用方**
- 位置：L394-429（仅自身递归；生产代码无引用，恢复引擎已自行处理空目录）
- 修复建议：删除，或保留为纯工具方法并注明唯一用途。

---

## 5. backend/modules/checkpoint/CheckpointOperationLock.ts

**[中] CP-LOCK-1 取消信号不作用于工作区锁排队等待**
- 位置：L98-107（`acquireWorkspaceLock` 不接收/检查 abortSignal）、L36-76（`runExclusive` 只在 `runWithFileLock` 把 signal 传给 `fileWriteLockManager.acquire`）
- 描述：`cancelOperation` 只 abort 了 AbortSignal；若操作在 pending 队列中等待（例如被一个长 create 占锁），不会被中断，进度一直停留在 'pending'，直到锁授予后才在任务内 `throwIfAborted` 立刻失败。排队等待时间无上限。
- 影响：取消（CPF-11）体验差；排队中的操作持续占用 `operations` 记录与前端轮询。
- 修复建议：`acquireWorkspaceLock` 接受 abortSignal，abort 时将该 pending 项移出队列并 reject；或对排队等待设上限时间。补"排队中被取消"测试。

**[低] CP-LOCK-3 超集重入是文档化的死锁地雷**
- 位置：L64-66 注释（"调用方不得在持锁任务内等待一个请求了更大工作区集合的嵌套操作"）
- 描述：同一 owner 在持锁任务内请求"更大工作区集合"的嵌套 `runExclusive` 会进入排队等待自己，死锁。当前调用方无此用法，但属于未来多根动态增删场景的隐患。
- 修复建议：增加运行时检测：嵌套调用发现 `activeOwners` 已有同 owner 且请求集合不是已持有集合的子集时直接抛错（fail-fast）。

---

## 6. backend/modules/checkpoint/CheckpointSnapshotBuilder.ts

**[低] CP-DUP-1 三处重复实现，语义漂移风险**
- 位置：本地 `runBounded` L112-127（与 `checkpointConcurrency.runBounded` 重复，且无"首个错误后停止取新任务"的语义）；`hashFileStreaming` L130-139（与 RestoreEngine L479-488、CheckpointManager.getFileHash L878-891 共三份）；`isExcludedAbsolutePath` L97-109（与 IgnoreResolver L233-250 重复，且前者未做 win32 大小写折叠）
- 描述：三处重复实现各自演化，未来修并发/修大小写时极易漏改。
- 修复建议：`runBounded` 直接用模块级共享实现；`hashFileStreaming` 收敛到 `checkpointConcurrency.ts` 或新 `fileHashing.ts`；`isExcludedAbsolutePath` 收敛到 CheckpointWorkspace 或独立 util，统一大小写策略。

**[低] CP-PREV-2 排除预览的 samples 顺序不确定**
- 位置：L366-389（`runBounded(files, 8, ...)` 并发 push 进 `allExcluded`）
- 描述：samples 每次预览顺序可能不同，前端"为什么被排除"示例列表展示不稳定。
- 修复建议：预览收集完成后按 path 排序再截取样本。

---

## 7. backend/modules/checkpoint/CheckpointQueryService.ts

**[低] CP-QUERY-1 设置页统计逐对话顺序读元数据**
- 位置：L134-172（`getAllConversationsWithCheckpoints` 对每个 conversation 顺序 `getMetadata`）
- 描述：对话多时 O(n) 次元数据读盘/反序列化，设置页挂载可能变慢。
- 修复建议：与 HIS-10 批量元数据接口对齐，或利用 `listConversations` 已有数据批量取回 metadata。

**[低] CP-QUERY-2 `getCheckpoints` 吞掉全部错误返回空数组**
- 位置：L97-100
- 描述：元数据损坏、读取失败等异常被静默吞掉返回 []，前端显示"无存档"而非错误。
- 修复建议：区分"无记录"与"读取失败"，失败时返回 error 标记或在响应中附加 warning。

**[低] CP-TYPE-1 `getCheckpointRecords` 用 `as any` 访问 conversationManager**
- 位置：L52-62
- 描述：绕过类型系统做双接口回退；ConversationManager 已有 `getCustomMetadata`，该回退分支是历史兼容残留。
- 修复建议：收敛为类型化接口，移除 `as any`。

---

## 8. backend/modules/checkpoint/CheckpointRetentionService.ts

**[低] CP-RET-1 清理只合并第一个依赖者，且删除失败仍标记 deleted**
- 位置：L56-67（`stillAlive.find(c => c.baseCheckpointId === cp.id)` 只找第一个依赖者；`deleteCheckpointInternal` 返回 false 时仍 `deleted.add(cp.id)`）
- 描述：正常线性链无问题；若数据异常出现多节点引用同一 base（损坏元数据），未合并的依赖者会悬空；删除被拒绝后仍把 cp 视为已删，影响后续迭代的依赖搜索。
- 修复建议：以 `deleteCheckpointInternal` 返回值为准决定是否 `deleted.add`；对多个 dependent 循环执行合并。

**[低] CP-RET-2 合并路径同样未校验 backupDir（与 CP-DEL-1 同根因）**
- 位置：L96-97（`removedBackupPath`/`successorBackupPath` 直接 `path.join(this.checkpointsDir, backupDir)`）、L114、L122-123（`fs.cp(src, dest, ...)`）
- 描述：`fs.cp` 从（可能越界的）removed 目录复制到（可能越界的）successor 目录，属 CP-DEL-1 的次要暴露面。
- 修复建议：与删除路径共用 `assertSafeCheckpointDirName` 校验。

---

## 9. backend/modules/checkpoint/CheckpointWorkspace.ts

未发现独立高危问题。两条低风险提示：
- **[低]** L196-212 `resolveSafePathInsideRoot` 存在 lstat 检查与后续复制之间的 TOCTOU（本地扩展威胁模型下可接受；若未来支持不可信工作区，需在写前重查）。
- **[低]** L46-49 `normalizeWorkspaceUri` 仅 win32 小写化；macOS 大小写不敏感卷下同一目录不同大小写的 URI 会生成不同 rootId（与 EX-CASE-2 同族）。

---

## 10. backend/modules/checkpoint/checkpointConcurrency.ts

未发现正确性问题。`runBounded` 的"首个错误后停止取新任务、只抛第一个错误、其余错误吞掉"语义正确；`throwIfAborted`/`CheckpointAbortError` 使用一致。唯一建议：将 SnapshotBuilder 的本地副本收敛到此模块（见 CP-DUP-1）。

---

## 11. backend/modules/settings/SettingsManager.ts（checkpoint 配置段）

**[中] EX-CFG-1 `updateCheckpointConfig` 浅合并会整体覆盖嵌套配置**
- 位置：L828-829 `await this.saveToolsConfigEntry('checkpoint', oldConfig, { ...oldConfig, ...config })`
- 描述：`exclusion`/`messageCheckpoint` 是嵌套对象，`{ ...oldConfig, ...config }` 是浅合并——若 `config.exclusion` 只含部分字段（如仅 `enabledProfiles`），会整体替换已保存的 `profilePatterns`/`maxFileSizeBytes`/`customPatterns`。读取侧虽与默认值深合并，但用户已保存的每类别自定义模式覆盖（profilePatterns）会被静默丢弃。
- 影响：前端若发送部分 exclusion 负载，用户的类别规则编辑丢失，且无任何报错。
- 修复建议：保存前对 `exclusion`、`messageCheckpoint` 与 `oldConfig` 对应字段做深合并再落盘。

**[中] EX-12-1 `enabledProfiles` 的值未做类型校验**
- 位置：L768-782（只校验 key 是否已知类别，未校验 value 为 boolean）
- 描述：`{ logs: "false" }`、`{ logs: null }` 都能通过校验；`resolveEnabledProfiles` 用 truthiness 取值，字符串 `"false"` 为 truthy → 类别保持启用，"关闭"操作被静默忽略。此外 `beforeTools`/`afterTools`/`enabled`/`maxCheckpoints`/`messageCheckpoint` 完全未做类型校验。
- 影响：EX-12 目标只完成一半；类型混乱配置可能产生不可预期行为。
- 修复建议：`enabledProfiles` 的 value 必须是 boolean；`beforeTools`/`afterTools` 校验为 string 数组；`maxCheckpoints` 校验为有限非负整数；`enabled` 校验为 boolean。

**[低] EX-12-2 未拒绝"全忽略"类无意义规则**
- 位置：CheckpointExclusionProfiles.ts `validateCustomExclusionPatterns` L295-332
- 描述：已覆盖空/纯空白、绝对路径、纯 `!`、`..` 越界、换行注入；但 `*`、`**`、`/**`、`/*` 这类会排除整个工作区的模式未被拒绝。
- 影响：用户误配 `*` 后整个工作区不再备份，恢复时几乎空存档，且无保存期错误提示。
- 修复建议：剥离 `!` 前缀后若模式为 `*`/`**`/`/**`/`/*` 即拒绝（reason 可新增 `blanket`）。

**[低] EX-CFG-2 负数归一化直接修改调用方传入对象**
- 位置：L824-826（`config.exclusion.maxFileSizeBytes = 0`）
- 描述：直接改写 webview 消息数据对象，属隐式副作用。
- 修复建议：先拷贝再归一化。

---

## 12. backend/modules/settings/types.ts

未发现类型定义本身的问题。一处可优化：
- **[低]** `CheckpointConfig` 带 `[key: string]: unknown` 索引签名（L485），使所有保存路径都需手工类型守卫（EX-12-1 的校验缺口由此放大）；可考虑收紧为显式字段或保留索引签名但补齐类型校验。

---

## 13. webview/handlers/CheckpointHandlers.ts

**[低] CP-HANDLER-1 恢复前取消流/SubAgent 是 fire-and-forget**
- 位置：L78-102
- 描述：`abortManager.cancel(conversationId)` 与 `subAgentRunController.cancel(runId, ...)` 都不 await，恢复随即继续。安全性目前完全依赖恢复引擎获取的全局文件写锁兜底；但若某写路径不经过 fileWriteLockManager，仍存在恢复与写并发窗口。另外 `deleteUntrackedFiles` 由 webview 直接传布尔值，后端未校验是否经过 previewRestore 确认。
- 修复建议：保持锁兜底的同时，SubAgent 取消改为可等待或至少记录取消日志；后端对"未预览即传 deleteUntrackedFiles=true"的调用记 warn 日志。

**[低] CP-DUP-2 工作区根序列化逻辑与 CheckpointManager 重复**
- 位置：L239-246 与 CheckpointManager.getRuntimeWorkspaceRoots L338-366
- 描述：handler 中手工拼 `scheme://authority/path`，缺少 Manager 中对无 scheme/authority 场景的退化处理；两处 URI 序列化口径若漂移，`previewExclusions` 的工作区身份与 `createCheckpoint` 记录的身份可能不一致。
- 修复建议：导出 `CheckpointManager.getRuntimeWorkspaceRoots`（或抽成独立函数）供 handler 复用。

---

## 按严重程度排序的汇总清单

### 高（2 项，需尽快修复）

| # | 位置 | 问题 |
|---|------|------|
| 1 | CheckpointManager L1753/1826/1956/2078；RetentionService L96-97/114/122；ManifestRepository L30-32 | **CP-DEL-1/CP-RET-2/CP-PATH-1**：删除、合并、manifest 路径均未校验 `backupDir`/`checkpointId`，损坏或恶意元数据可致 `fs.rm(recursive)` 递归删除存档目录外内容（恢复引擎有 `isPathInside` 校验而删除路径没有） |
| 2 | CheckpointManager L1793-1820 | **CP-IDX-1**：`deleteCheckpointsFromIndexInternal` 只保护 excludeCheckpointId 的基链，消息索引回退（编辑+重试序列）后可删掉保留节点的基快照，产生永久断链存档 |

### 中（8 项）

| # | 位置 | 问题 |
|---|------|------|
| 3 | CheckpointManager L1514-1536、L1600-1607 | **CP-PERF-1**：恢复/预览对全工作区顺序整文件哈希，无并发（违反 CPF-06），预览+执行各做一遍全量哈希 |
| 4 | CheckpointManager L1215-1218 → OperationLock L90 | **CP-LOCK-2**：只读预览持有全局文件写锁，扫描期间阻塞全部写工具 |
| 5 | ManifestRepository L25 | **CP-CACHE-1**：manifest 内存缓存无界无淘汰（每个含全量文件映射），长期运行内存持续增长 |
| 6 | SettingsManager L828-829 | **EX-CFG-1**：updateCheckpointConfig 浅合并，部分 exclusion 负载会静默丢弃已保存的 profilePatterns/maxFileSizeBytes |
| 7 | SettingsManager L768-782 | **EX-12-1**：enabledProfiles 值未做 boolean 校验（`"false"` 被当真），beforeTools/maxCheckpoints 等也未类型校验 |
| 8 | IgnoreResolver L116/L452-456；L233-250 | **EX-CASE-1/EX-CASE-2**：强制排除目录片段大小写敏感（Windows `.GIT`/`NODE_MODULES` 可绕过）；存储自排除仅 win32 折叠大小写，macOS 大小写不敏感卷可绕过 CP-07 |
| 9 | OperationLock L98-107 | **CP-LOCK-1**：工作区锁排队等待不响应取消信号，取消延迟到锁授予之后 |
| 10 | CheckpointManager 全文件（2327 行） | **CP-MAINT-1**：CPF-12 拆分未完成，恢复侧文件操作/文档刷新/排除说明仍堆积在管理器内 |

### 低（16 项）

| # | 位置 | 问题 |
|---|------|------|
| 11 | CheckpointManager L1694-1700；ManifestRepository L44-51；IgnoreResolver L394-429 | **CP-DEAD-1/CP-DEAD-2/CP-DEAD-3**：三处死代码 |
| 12 | SnapshotBuilder L112-127/L130-139/L97-109 | **CP-DUP-1**：runBounded/hashFileStreaming/isExcludedAbsolutePath 与共享模块重复实现（三份哈希、两份排除判断、两份并发池） |
| 13 | QueryService L134-172 | **CP-QUERY-1**：设置页逐对话顺序读元数据（O(n) 读盘） |
| 14 | QueryService L97-100 | **CP-QUERY-2**：getCheckpoints 吞错返回 [] |
| 15 | QueryService L52-62 | **CP-TYPE-1**：`as any` 绕过类型系统 |
| 16 | RetentionService L56-67 | **CP-RET-1**：清理只合并第一个依赖者；删除失败仍标记 deleted |
| 17 | RetentionService L96-97/L114/L122 | **CP-RET-2**：合并路径未校验 backupDir（高 #1 的次要暴露面） |
| 18 | CheckpointManager L2306-2307/L1566-1570/L1358/1397/1430/1454 | **CP-I18N-1**：硬编码中文/英文错误文案绕过 i18n |
| 19 | CheckpointManager L1286 | **CP-PREV-1**：预览 deleted 计数含未确认删除的 untracked 文件 |
| 20 | RestoreEngine L370-386 | **CP-ORDER-1**：先删后拷，复制失败时工作区处于已删未补的破坏性中间态 |
| 21 | RestoreEngine L370-386 | **CP-PROG-1**：删除阶段不上报进度 |
| 22 | IgnoreResolver L354-358 | **CP-SYMLINK-1**：符号链接被静默丢弃且无记录/提示 |
| 23 | ExclusionProfiles L295-332 | **EX-12-2**：未拒绝 `*`/`**` 等全忽略模式 |
| 24 | SettingsManager L824-826 | **EX-CFG-2**：负数归一化直接改写调用方传入对象 |
| 25 | CheckpointHandlers L78-102/L239-246 | **CP-HANDLER-1/CP-DUP-2**：取消流/SubAgent 不等待；工作区根序列化与 Manager 重复 |
| 26 | OperationLock L64-66 | **CP-LOCK-3**：超集重入死锁仅注释声明，无运行时防护 |
| 27 | Workspace L196-212/L46-49 | **CP-WS-1**：restore 路径 TOCTOU（本地威胁模型可接受）；URI 规范化仅 win32 小写化 |

---

## 修复优先级建议

1. **立即（高）**：共享 `assertSafeCheckpointDirName()` 并接入删除/合并/manifest 三处（#1）；`deleteCheckpointsFromIndexInternal` 补基链闭包（#2）。
2. **本周（中）**：恢复路径并行哈希 + stat 快路径（#3）；预览去掉全局文件锁（#4）；manifest 缓存 LRU（#5）；updateCheckpointConfig 深合并 + enabledProfiles 布尔校验（#6/#7）；强制排除大小写折叠（#8）；锁队列取消（#9）。
3. **排期（低）**：死代码清理（#11）、重复实现收敛（#12）、i18n 统一（#18）、其余低危项随第七阶段（BCP）重构一并处理。

## 结语

核心架构（增量链 manifest、恢复引擎路径安全、工作区互斥与可重入、批量删除闭包、流式哈希与有界并发）设计正确且测试覆盖较好（模块 95+ 用例）。当前最紧迫的是两项高危：删除路径的 backupDir 校验（计划文档自身验收项，恢复侧已实现而删除侧遗漏）与索引删除的基链闭包保护（与 CP-05 的批量删除保护不对称）。修复后建议补充两条回归测试：损坏 backupDir 的删除拒绝、编辑+重试后索引删除不断链。
