# 第五阶段分支接线（BR-05 + BR-06 + BR-07 + BR-09）设计说明与验证结果

> 日期：第五阶段批次 P2
> 范围：BranchService（新建）+ ConversationManager 三处最小改动 + webview 分支接口层 + 测试
> 参考：`checkpoint-history-branch-architecture.plan.md`（第五阶段条目 L86–96、第五部分 L1242–1527、
> 已确认决策 L2012–2025）、`.graycode/research/branch-tree-phases-research.md`
> （2.2 节 BR 行、1.4 节锁、3.1/3.2 节 sidecar 与主历史不变量、5.1 模块划分）
> 依赖：BR-01/02（Content.id/parentId + 惰性迁移）、BR-03/04/08（branch/ 底座）已完成

---

## 1. 交付文件

```
backend/modules/conversation/branch/
  types.ts                  // + BranchExportRecord；ConversationBranchGraph + exportedFrom/exportedRefs
  BranchGraph.ts            // + isFunctionResponseMessage / importLinearHistory（MIG-01/BR-09 线性导入）；
                            //   validate 增加 BR-09 元数据引用校验
  BranchService.ts          // 新建（BR-05/06/07/09 业务编排 + 全局单例）
  index.ts                  // 导出扩展
backend/modules/conversation/ConversationManager.ts
                            // ① runExclusive 公共锁包装（BR-07）② createBranchConversation BR-09 部分
                            //   ③ deleteConversation 清理 branches.json
webview/handlers/
  BranchHandlers.ts         // 新建：5 个分支 API + BranchService 懒初始化 + BranchErrorCode 透出
  index.ts                  // 注册
backend/__tests__/conversation/
  branchService.test.ts     // 新建（23 例）
  branchGraph.test.ts       // 补充 importLinearHistory（5 例）
backend/__tests__/webview/
  branchHandlers.test.ts    // 新建（6 例）
```

## 2. 设计说明

### 2.1 BR-07：分支操作进入会话写锁 + 锁序文档化

- `ConversationManager.withConversationWriteLock`（私有）暴露公共包装
  **`runExclusive(conversationId, fn)`**（ConversationManager L191–203），BranchService 所有图写操作
  （save / reroll / edit / switch / delete / initialize / recordExport）统一经它执行；
  `getTranscriptRepository` 的历史 mutate 与分支图写共用同一把会话锁，崩溃后 sidecar 与主历史不会
  因交错写长期不一致。
- **锁序文档化**（写进 runExclusive 的 JSDoc，作为全仓库约定）：会话写锁 ⊂ 存档操作锁
  （checkpointOperationLockManager，工作区级 + 可重入）⊂ 文件写锁（FileWriteLockManager.acquire）；
  跨层操作必须从外层向内层获取，持内层锁时严禁获取外层锁。
- **防重入死锁的落地细节**：BranchService 在建基线图前需要主历史带稳定 id（BR-02），但
  `ensureHistoryNodeIds` 自身会再取会话锁——因此统一在**锁外**先调 `ensureHistoryNodeIds`（幂等），
  锁内只用**不加锁**的 `getMessagesRaw` 读历史，避免锁内等锁死锁。

### 2.2 BR-06：分支图读写删接口（BranchService）

| 接口 | 语义 | 锁 |
|---|---|---|
| `getBranchGraph` | 直读 sidecar；无图 → `{graph:null}`；损坏 → `{graph:null, errorCode:'BRANCH_STORAGE_CORRUPT'}`（读取降级线性模式，不抛错） | 读不持锁（rename 原子） |
| `getBranchGraphMeta` | 轻量摘要（exists/root/tail/nodeCount/candidateCount/activePathLength/exportedFrom/exportedRefs），免整图下发 | 读不持锁 |
| `saveBranchGraph` | validate 通过后持久化；结构无效抛 `BRANCH_STORAGE_CORRUPT`（闸门） | 会话锁 |
| `deleteConversationBranch` | 级联删 sidecar（幂等，ENOENT 不抛） | 无（unlink 幂等） |
| `createRerollCandidate` | 同一父节点下新增候选 + 切 activeChildId + 候选摘要 + 持久化；**无图先以主历史建线性基线**（MIG-01 惰性建图）；父缺失 → `NODE_NOT_FOUND` | 会话锁 |
| `editCandidate` | 同上，kind='edit'（TREE-03 底座） | 会话锁 |
| `switchBranchCandidate` | `switchActivePath` 纯函数切换祖先 activeChildId + 尾指针重算 + 持久化；**不重写主历史**（`mainHistoryRewrite: false`，TREE-06 边界） | 会话锁 |
| `deleteBranchCandidate` | **软删除**（TREE-09）：节点 deleted + 摘要 deleted；活跃路径上的节点拒绝删除（`BRANCH_OPERATION_CONFLICT`）；父节点 activeChildId 指向被删节点时同步清空（保 validate） | 会话锁 |

**两个刻意设计**（在报告中说明）：

1. **sidecar 损坏的读写不对称**：读取降级线性模式（研究 3.1 节「不阻塞读取」）；**写入拒绝**
   （`BRANCH_STORAGE_CORRUPT`，不静默覆盖可能可恢复的数据）——修复交给 MIG-05 完整性工具，
   避免一次误写把损坏文件彻底冲掉。
2. **候选数量上限不在此阶段实施**：规划「每父节点 10 个候选、超限提示不自动删」是 TREE-02 的产品
   约束，BranchService 只保证兄弟候选按 createdAt 升序稳定排序（`childrenIndex`）。

### 2.3 BR-05：主历史只存活跃路径——不变量文档 + 调试校验

- 不变量（规划 L1310–1337，写进 BranchGraph.ts 头部与 BranchService.validateActivePathMatchesHistory）：
  **主历史 Content[] 永远 = 根 → 活跃子 → … → 活跃尾的线性路径；非活跃分支只在 sidecar**。
  本阶段只建立校验函数，**不强制重写主历史**（TREE-06 才执行 replaceContents 全量重写）。
- `validateActivePathMatchesHistory(conversationId)`：主历史消息 id 链（**过滤 functionResponse**，
  决策 8）vs `activePath(graph)`，逐位比对 + 长度比对 + 图结构 validate 问题汇总，返回
  `{valid, issues, historyIds, activePathIds}`。同时报告「图缺失但历史非空」与
  「reroll 后图领先主历史」（TREE-06 落地前的**预期**不一致，不当作错误抛出）。
- **functionResponse 不独立成节点的落地**：`importLinearHistory` 把 functionResponse 消息的 parts
  合并进前一个模型节点（连续多条依次累积），不建节点；后续消息的 parentId 若指向被吸收的
  functionResponse id，自动回退到前一个真实节点（不产生悬空引用）。校验对比时同样过滤
  functionResponse。

### 2.4 BR-09：跨对话分支建模

`ConversationManager.createBranchConversation` 的改动（三处之一）：

1. **metadata 双写**：`custom.branch` 增加 `sourceNodeId`（分支点 = 复制到的最后一条消息的
   `Content.id`），`sourceMessageIndex` 保留兼容过渡（已确认「保留双写」）。
2. **新对话 BranchGraph 初始化**（`initializeBranchConversation`）：目标历史全量导入为节点
   （kind='imported'，functionResponse 合并进模型节点），图元数据
   `exportedFrom: { conversationId: 源头, nodeId: 分支点 }`。
3. **源头对话标注**（`recordExport`）：在源头图元数据 `exportedRefs` 列表追加
   `{ targetConversationId, nodeId, exportedAt }`；源头无图时自动建线性基线；同关系幂等不重复。
   **最小实现选择**：采用 exportedRefs 列表而非在源头图里新增 kind='exported' 的标注节点——
   标注节点没有真实消息内容，会污染 activePath/childrenIndex/validate 等所有图运算，而
   exportedRefs 是纯元数据、零副作用（已确认「加 exported 标注节点或记录 exportedRefs 列表」二选一）。
4. **接线方式**：ConversationManager 通过 branch 模块的**全局单例**
   （`getGlobalBranchService()`，与 DiffStorageManager 同模式）访问 BranchService；BranchService
   对 ConversationManager 只做 `import type`（无运行时循环依赖）；未注册单例时静默跳过
   （测试/旧环境不阻塞，metadata 的 sourceNodeId 照写）。

### 2.5 webview 接口层（BranchHandlers）

- 注册 5 个 API：`conversation.getBranchGraph` / `getBranchGraphMeta` / `createRerollCandidate` /
  `switchBranchCandidate` / `deleteBranchCandidate`（规划第七部分 L1687–1698 分支 API 最小集；
  reroll/edit 流式、rename、getCandidateSummaries 留待 TREE 阶段）。
- **BranchService 懒初始化**：首次调用时用 `ctx.storagePathManager.getEffectiveDataPath()` 作为
  `BranchGraphRepository` 的 baseDir（与 FileSystemStorageAdapter 同一存储布局），构造后注册为
  全局单例；后续复用。
- **错误码**：`BranchError.code`（types.ts 的 `BranchErrorCode`）直接作为 IPC 错误码透出；
  非 BranchError 兜底 `BRANCH_OPERATION_CONFLICT`。
- 未改 webview/types.ts / MessageRouter / ChatViewProvider（不在本批次文件边界内）。

### 2.6 与其他批次的冲突评估

- `ConversationManager.ts` 的工作区改动全部来自前一批次 BR-01/02（Content.id 迁移），
  本批次在其基础上叠加三处最小改动（runExclusive / BR-09 / deleteConversation 清理）；
  **未发现与其他在途批次冲突**（checkpoint 模块未触碰）。
- `deleteConversation` 的 sidecar 清理通过全局 BranchService 幂等执行；未注册时跳过，
  清理失败不影响对话删除（残留为孤儿文件，无害）。

## 3. 修改摘要

| 文件 | 改动 |
|---|---|
| `branch/types.ts` | +`BranchExportRecord`；`ConversationBranchGraph` +`exportedFrom`/`exportedRefs`（BR-09 图元数据） |
| `branch/BranchGraph.ts` | +`isFunctionResponseMessage`（决策 8 判据）；+`importLinearHistory`（线性导入，kind='imported'，functionResponse 合并，parentId 防悬空，无 id 兜底）；validate +exportedFrom/exportedRefs 引用校验 |
| `branch/BranchService.ts` | 新建：BR-06 八接口 + BR-07 锁内执行器（mutateGraph/loadGraphForWrite/validateAndSave）+ BR-05 校验 + BR-09 两接口 + 全局单例 setGlobalBranchService/getGlobalBranchService |
| `branch/index.ts` | 导出 BranchService 及单例 |
| `ConversationManager.ts` | +`runExclusive`（BR-07 锁包装 + 锁序 JSDoc）；`buildBranchCustomMetadata` +sourceNodeId；`createBranchConversation` BR-09 双写 + 图初始化/导出标注；`deleteConversation` +sidecar 清理 |
| `webview/handlers/BranchHandlers.ts` | 新建：5 handler + 懒初始化 + BranchErrorCode 透出 + registerBranchHandlers |
| `webview/handlers/index.ts` | 注册 BranchHandlers |
| `branchService.test.ts` | 新建 23 例：BR-06 读写删 / BR-07 候选创建编辑切换删除（含并发串行化、损坏拒绝覆盖、基线建图、软删除幂等）/ BR-05 校验（图缺失、线性一致、reroll 领先）/ BR-09（sourceNodeId 双写、imported+exportedFrom、exportedRefs、幂等、未注册跳过、deleteConversation 清理） |
| `branchGraph.test.ts` | +5 例：importLinearHistory（线性导入、functionResponse 合并、连续累积、兜底 id/空历史） |
| `branchHandlers.test.ts` | 新建 6 例：注册表包含 5 API、懒初始化用有效数据路径、成功路径、NODE_NOT_FOUND 错误码透出、缺参冲突码 |

## 4. 验证结果

### 4.1 单测（任务指定命令）

```
npx jest --config jest.backend.config.js backend/__tests__/conversation/ backend/__tests__/webview/
→ 25 suites / 269 tests 全部通过
```

- 其中新增/补充：branchService.test.ts（23 例）、branchGraph.test.ts（新增 5 例，共 55 例）、
  branchHandlers.test.ts（6 例）；全部通过。
- 含既有回归：ConversationManager.branch.test.ts（createBranchConversation 加 sourceNodeId 后
  toMatchObject 子集断言不受影响）、nodeIdMigration、storageAppend、conversationDeleteRace 等。

### 4.2 类型检查

```
npx tsc -p ./ --noEmit          → 0 错误（extension.ts + webview/** + backend/**）
npx tsc -p tsconfig.test.json --noEmit → 0 错误（含全部新增测试）
```

### 4.3 文件边界合规

- 仅改动：`backend/modules/conversation/branch/`（types/BranchGraph/index 扩展 + BranchService 新建）、
  `ConversationManager.ts`（三处最小改动）、`webview/handlers/BranchHandlers.ts`（新建）、
  `webview/handlers/index.ts`（注册）、三个测试文件。
- 未触碰：CHANGELOG.md、规划文档、checkpoint 模块、frontend/src、webview/types.ts、
  MessageRouter、ChatViewProvider、storage.ts。
- 未做 TREE-06 主历史全量重写（switchBranchCandidate 明确 `mainHistoryRewrite: false`）。

## 5. 备注 / 已知边界

- **switch 后主历史与图暂不一致**是 TREE-06 落地前的预期状态：`validateActivePathMatchesHistory`
  会如实报告「length mismatch」，这是调试信号而非错误。
- **sourceNodeId 只写新字段**：旧 `sourceMessageIndex` 保留双写；前端消费在下一阶段。
- **基线图是快照**：首次分支时从主历史导入，之后主历史追加的新消息不会自动进图（reroll 流
  维护图是 TREE-01 的职责）；`validateActivePathMatchesHistory` 可检出此类漂移。
- **损坏写拒绝**：branches.json 损坏时读取降级、写入拒绝（BRANCH_STORAGE_CORRUPT），修复入口
  规划在 MIG-05 完整性工具。
