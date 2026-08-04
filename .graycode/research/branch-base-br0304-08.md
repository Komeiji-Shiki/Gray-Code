# 第五阶段分支底座（BR-03 + BR-04 + BR-08）设计说明与验证结果

> 日期：第五阶段批次 P1
> 范围：`backend/modules/conversation/branch/`（新建）+ 两个单测文件
> 参考：`checkpoint-history-branch-architecture.plan.md`（L1369–1448 数据模型 / L1703–1711 错误码）、
> `.graycode/research/branch-tree-phases-research.md`（3.1 sidecar、5.1 模块划分、1.4 锁机制）
> 约束：只新建文件，未修改任何现有文件（ConversationManager.ts / storage.ts / types.ts 等一律未动）

---

## 1. 交付文件

```
backend/modules/conversation/branch/
  types.ts                  // 数据模型：ConversationBranchGraph / ConversationBranchNode /
                            //   BranchErrorCode / BranchCandidateSummary / BranchError / 常量
  BranchGraph.ts            // 纯函数模块（BR-08）：insertNode / rerollCandidate / editCandidate /
                            //   activateChild / switchActivePath / activePath / rebuildActivePath /
                            //   childrenIndex / validate / 候选摘要维护
  BranchGraphRepository.ts  // sidecar 存储（BR-04）：branches.json 读写 / 原子替换 / 损坏降级 /
                            //   deleteConversation / 会话级写串行
  index.ts                  // 模块导出
backend/__tests__/conversation/
  branchGraph.test.ts       // 纯函数单测（36 例）
  branchRepository.test.ts  // 仓储单测（真实临时目录，11 例）
```

## 2. 设计说明

### 2.1 types.ts —— 数据模型（决策 1/2/3/4 全部落实）

- **functionResponse 不独立成节点**：节点 `parts: ContentPart[]` 直接引用
  `conversation/types.ts` 的 `ContentPart`，functionResponse 是 parts 的一种，天然依附所属
  model 节点（决策 1）。
- **kind**：`'normal' | 'reroll' | 'edit' | 'continue' | 'imported' | 'exported'`；
  `exportedFrom?: { conversationId, nodeId }` 记录跨对话「复制为新对话」的来源（决策 2）。
- **单 parentId + activeChildId 指针**：不存 childrenIds；子列表由
  `BranchGraph.childrenIndex()` 运行时建立（决策 3）。
- **sidecar 内容**：`version`（`BRANCH_GRAPH_VERSION = 1`）、`rootNodeId`、`activeTailNodeId`、
  `nodes`、`activeChildId`、`candidateSummaries` 全部在 `ConversationBranchGraph` 中（决策 4）。
  - `graph.activeChildId` 是根节点 `activeChildId` 的**镜像指针**：真源是
    `rootNode.activeChildId`，所有纯函数同步维护，`validate` 校验两者一致（防漂移）。
  - `candidateSummaries: BranchCandidateSummary[]` 供 `getCandidateSummaries` 免读主历史。
- **节点字段**：id / parentId / role / parts / kind / createdAt / timestamp / modelVersion /
  usageMetadata / activeChildId / label / deleted / workspaceCheckpointId / workspaceState /
  exportedFrom，与任务清单一致。
- **`BranchErrorCode`**：7 个错误码与规划 L1703–1711 逐一对应；
  `BranchError extends Error` 携带 `code`，供纯函数 / 后续 BranchService 抛错。
  （仓储层损坏**不抛错**，走读结果降级，见 2.3。）

### 2.2 BranchGraph.ts —— 纯函数模块（BR-08）

全部为纯函数，不碰文件系统；返回新图（浅拷贝 nodes 记录，节点对象视为不可变）。

| 函数 | 语义 |
|---|---|
| `insertNode(graph, node, {setActive, updateTail})` | 插入节点；`setActive`（默认 true）使父节点 activeChildId 指向新节点；单根不变量（无根先插根、已有根禁再插根、无根禁插子）；父节点缺失 → NODE_NOT_FOUND；重复 id / 自引用 / 向已删除节点挂子 → INVALID_BRANCH_RELATION |
| `rerollCandidate(graph, parentId, node)` | 同一父节点下新增候选并切换 activeChildId（kind 固定 'reroll'），旧候选及其子树保留 |
| `editCandidate(graph, parentId, node)` | 同上，kind 固定 'edit'（TREE-03 基础） |
| `activateChild(graph, parentId, childId)` | 切换父节点活跃子指针；目标不是直接子节点 / 已删除 → INVALID_BRANCH_RELATION |
| `switchActivePath(graph, targetNodeId)` | 把 root→…→target 每个祖先的 activeChildId 指向路径下一节点，尾指针重算（TREE-06 切换重建基础）；目标不在 root 之下 → BRANCH_STORAGE_CORRUPT |
| `activePath(graph)` | 从 root 沿 activeChildId 到 activeTail 的节点 id 链；空图 → []；尾不可达 / 链上环 → BRANCH_STORAGE_CORRUPT |
| `rebuildActivePath(graph, targetNodeId)` | 给定目标节点：沿 parentId 向上到 root + 沿 activeChildId 向下到其活跃尾（TREE-06 核心解析） |
| `childrenIndex(graph)` | `Map<parentId, childIds>`，按 createdAt 升序（同毫秒按 id 字典序），软删除节点包含在内 |
| `validate(graph)` | 一致性校验：parentId 存在性 / 无环 / 单根 / activeChildId 指向真实且未删除的直接子节点 / activeTailNodeId 可达 / 镜像一致 / 摘要引用存在；返回 `{valid, issues[]}` |
| `upsertCandidateSummary` / `removeCandidateSummary` | 候选摘要维护（sidecar「候选摘要」字段的写入方） |

**关键不变量（实现中落地的设计决策）**：
1. **尾指针从活跃路径派生**：`activeTailNodeId` 永远等于「沿当前 activeChildId 链走到最后的节点」
   （`deriveActiveTail`）。插入/激活/切换后统一重算——插入到**非活跃分支**下的节点不会改变活跃尾。
2. **镜像同步**：每次变更后 `graph.activeChildId = rootNode.activeChildId`，validate 兜底校验。
3. **错误码语义**：结构关系问题 → NODE_NOT_FOUND / INVALID_BRANCH_RELATION；
   图数据自相矛盾（环、尾不可达、镜像漂移）→ BRANCH_STORAGE_CORRUPT。

### 2.3 BranchGraphRepository.ts —— sidecar 存储（BR-04）

- **路径约定**：`{baseDir}/conversations/{conversationId}/branches.json`
  （`getBranchesFilePath` 为规则单一来源；与 FileSystemStorageAdapter 的会话目录一致）。
- **原子写**：`tmp + rename`（参考 storage.ts `writeSegmentedHistory` / `renameOverwrite` 模式）；
  tmp 文件名带 `pid + 时间 + 随机后缀` 防并发冲突；失败清理 tmp 后抛出；成功后目录无 tmp 残留。
- **损坏降级**：`load()` 返回 `BranchGraphReadResult`：
  - 文件不存在 → `{ graph: null }`（线性模式，无错误码）
  - JSON 解析失败 / 结构不符（version 非数字、nodes 非对象）→
    `{ graph: null, errorCode: 'BRANCH_STORAGE_CORRUPT', errorMessage }`，由调用方降级线性模式，不阻塞读取。
  - 深度一致性交给 `BranchGraph.validate`，仓储层保持「纯存储」。
- **写串行**：按会话 Promise 链串行化（与 storage.ts `runSegmentedHistoryWriteSerialized` 同模式），
  保证同会话内最后写者确定；rename 本身原子，读不参与串行。
- **`deleteConversation(conversationId)`**：幂等删除 sidecar 文件（ENOENT 不抛错）；
  目录与主历史/元数据清理仍由 ConversationManager 既有路径负责（BR-06 接线）。
- **可测试性**：构造注入 `baseDir`，测试用 `os.tmpdir()` 真实临时目录，不依赖 vscode mock。

### 2.4 与后续批次的衔接

- BR-06/07：`BranchGraphRepository` 是纯存储，接线时在会话写锁内 `load → 纯函数变更 → save`；
  `BranchError` 直接供 BranchService 透出给 API 层。
- TREE-04/06：`activateChild` / `switchActivePath` / `rebuildActivePath` 即候选切换与
  「主历史 = 活跃路径」重建的纯函数基础（规划 L1310–1337 不变量）。
- TREE-02：`candidateSummaries` 字段 + `upsertCandidateSummary` 已就位。
- BCP-02：`workspaceCheckpointId` / `workspaceState` 字段已预留（缺省等价 'unknown'）。
- MIG-04：`version` 字段 + `BRANCH_GRAPH_VERSION` 常量作为版本迁移状态机基线。

## 3. 验证结果

### 3.1 单测（任务指定命令）

```
npx jest --config jest.backend.config.js backend/__tests__/conversation/branchGraph.test.ts backend/__tests__/conversation/branchRepository.test.ts
```

- **2 suites / 61 tests 全部通过**（branchGraph 50 例 + branchRepository 11 例）。
- 覆盖：insert/reroll/edit/activateChild/switchActivePath/activePath/rebuildActivePath/
  childrenIndex/validate（含环检测、尾不可达、镜像漂移、多根、悬空 parentId、摘要引用缺失）/
  候选摘要；仓储侧：路径约定、往返一致、原子写无 tmp 残留、损坏 JSON/结构降级
  BRANCH_STORAGE_CORRUPT、覆盖写、deleteConversation 幂等、并发写串行化、多会话隔离。

### 3.2 类型检查

```
npx tsc -p ./ --noEmit          → 0 错误（覆盖 backend/**/*.ts，含新模块）
npx tsc -p tsconfig.test.json --noEmit → 0 错误（覆盖 backend/__tests__，含两个新测试文件）
```

### 3.3 回归

- `npx jest --config jest.backend.config.js backend/__tests__/conversation`：
  15 suites / 175 tests 全部通过（含既有 conversation 测试；其中一次运行出现 2 例既有 flake，
  复跑全绿——新文件使用隔离临时目录，与既有测试无共享状态，判定为既有偶发抖动）。

### 3.4 文件边界合规

- 仅新增：`backend/modules/conversation/branch/`（4 文件）+ 2 个测试文件；
  `git status` 确认未修改任何已跟踪文件（其余 M 状态均为前序批次/其他 agent 的既有改动）。

## 4. 备注

- 实现过程中修正的一个设计点：`activeTailNodeId` 初始实现为「插入时直接指向新节点」，会在
  「向非活跃分支插入子节点」时把尾指针错误地移到非活跃分支上（与「主历史 = 活跃路径」
  不变量冲突）；已改为**从 activeChildId 链派生尾指针**，并有对应单测锁定。
- `rerollCandidate` / `editCandidate` 的 kind 固定为 'reroll' / 'edit'（需要其他 kind 走 insertNode），
  避免调用方误传。
