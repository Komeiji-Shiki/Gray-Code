# FIX-G2：checkpoint 域复查问题修复（恢复规则批次）

## 背景

R5a 复查（checkpoint 模块）发现 4 中 + 2 低问题，本批次按文件边界修复：

- `backend/modules/checkpoint/CheckpointManager.ts`
- `backend/modules/checkpoint/CheckpointRestoreService.ts`
- 新增测试 `backend/__tests__/checkpoint/CheckpointRestoreRules.test.ts`

基线说明：`CheckpointManager.createCheckpoint` 已含上一批次（BCP-01）的
`options.messageNodeId`，本次未触碰该逻辑。

## 修改摘要

### M-1（中）：`createCheckpoint` 无工作区根早退残留死操作

**文件**：`CheckpointManager.ts`（`createCheckpoint` 内，roots 检查处）

**问题**：`beginOperation` 已在 L263 注册操作（phase:'scanning'），
`roots.length === 0` 时直接 `return null`，`finally { endOperation }` 不执行 →
操作以 `scanning` 永远留在 operations map（容量清理只淘汰终态条目），
`getOperationProgress()`（不带 operationId）把死记录当“最近进行中操作”返回。

**修复（选型）**：早退前显式
`reportProgress({ phase:'failed', cancelled:false, message:'No workspace root' })` +
`this.endOperation(operationId)`。

**取舍说明**：另一选项是把 roots 检查移到 `beginOperation` 之前（与 restoreCheckpoint
对齐），失败更“干净”（无任何记录）。但该方案会让传入 `progress` 回调的调用方收不到
任何终态通知，`getOperationProgress(operationId)` 也查不到失败原因，丢失 CPF-11
“已开始的操作可查询、可取消”的可观测性；且本方案下 `failed` 是终态，
不带 operationId 的 `getOperationProgress()` 同样会跳过它，两种方案都修复了
“死记录被当进行中操作”的核心问题。故选“先注册、早退时显式终态”方案。

### M-2（中）：恢复侧 `createIgnoreResolver` 漏传 `profilePatterns`

**文件**：`CheckpointRestoreService.ts`（`createIgnoreResolver`）

**问题**：构造 options 只有 `enabledProfiles` 与 `excludeAbsolutePaths`，
没有 `profilePatterns`。创建路径（CheckpointManager L337-338）与预览路径
（previewExclusions L287）都传 `config.exclusion.profilePatterns`（类别自定义模式覆盖），
恢复侧（`filterRestoreTargetScoped` / `collectCurrentWorkspaceState`）却回退到默认模式清单：
用户在类别里改过模式后，恢复侧把本应忽略的文件算可见 → 进 currentHashes →
恢复计划判为 untracked（`deleteUntrackedFiles=true` 时被删）+ diff 噪音；
legacy 恢复把用户想排除的文件恢复出来。与“恢复仍严格按当前规则过滤目标”的文档承诺矛盾。

**修复**：options 补
`profilePatterns: includeCustomPatterns ? config.exclusion?.profilePatterns : undefined`。
`includeCustomPatterns=false`（备份目录侧遍历）时保持 `undefined`，
与 `enabledProfiles: undefined`（不启用默认类别）语义一致——resolver 缺省
`undefined` 即用类别默认清单，非空覆盖才替换默认清单，与快照构建器同一口径。

### M-3（中）：恢复时未把 `manifest.excluded` 纳入 `protectedScopedPaths`

**文件**：`CheckpointRestoreService.ts`（`prepareRestore`）

**问题**：`protectedScopedPaths` 只来自 `checkpoint.unbackedPaths`；
`deletableScopedPaths` 只来自 `fileHashes` 键。快照时被 default/gitignore/custom 规则
排除的文件（manifest.excluded 记录）既不在 deletable 也不在 protected；
用户之后放宽规则（关类别/删自定义模式）→ 恢复时这些快照时已存在的文件进入
currentHashes → untrackedToDelete → `deleteUntrackedFiles=true` 被删。
违反 CP-09“只删快照后新建文件”语义。

**修复**：`prepareRestore` 在 unbackedPaths 并入之后，遍历
`restoreManifest?.excluded ?? []`，将 `reason ∈ {default, gitignore, custom}` 的
`entry.path`（转 scoped）并入 `protectedScopedPaths`。
- `forced` 维持现状：永远被当前规则忽略，永不进入 currentHashes，无需保护；
- `size`/`unreadable` 维持现状：已在 `unbackedPaths` 覆盖。

`manifest.excluded` 结构确认：`CheckpointExcludedEntry { path, reason, rule?, source?, size? }`
（types.ts L26-36，路径为 scoped 键 `rootId/relative`；`toScopedKey` 对已是 scoped 的键原样返回）。

### M-4（低→中）：`buildExcludedNote` 的 `rulesChanged` 未比较 `profilePatterns`

**文件**：`CheckpointRestoreService.ts`（`buildExcludedNote` + 新增 `serializeProfilePatterns`）

**问题**：rulesChanged 比较了 maxFileSizeBytes / customPatterns / enabledProfiles /
版本号，漏掉 `profilePatterns`（类别自定义模式覆盖）——用户只改类别模式时
“快照规则 vs 当前规则”差异不提示。

**修复**：按现有 enabledProfiles 的稳定序列化风格新增 `serializeProfilePatterns`：
键排序后 `id:list.join('\n')` 再 `|` 连接；`undefined` 与空对象均视为“无覆盖”，
比较相等。加入 `rulesChanged` 条件链。

### L-1（低）：`beginOperation` 解构的 `report` 未使用

**文件**：`CheckpointManager.ts`

**修复**：`createCheckpoint`（L268）与 `restoreCheckpoint`（L722）解构时省略
`report`（它们走 `reportProgress` 包装回调）；`deleteAllCheckpoints` /
`deleteCheckpointsBatch` 仍使用 `report`，保持不动。

### L-2（低）：恢复结果展示逻辑与 RestoreService 重复

**文件**：`CheckpointRestoreService.ts`（新增 `showRestoreResultMessage`）+
`CheckpointManager.ts`（新格式路径调用）

**修复**：把“失败/成功文案 + details 拼接 + `setStatusBarMessage`”封装为
`RestoreService.showRestoreResultMessage(checkpoint, counts, failureCount): string`，
两处（CheckpointManager 新格式路径、`restoreLegacyCheckpointViaEngine` legacy 路径）
共用；返回拼接后的完整消息供日志/测试复用。legacy 侧 deleted 恒为 0，
`deleted > 0` 条件拼接等价原行为。

## 测试

新增 `backend/__tests__/checkpoint/CheckpointRestoreRules.test.ts`（5 例）：

| 用例 | 验证内容 |
| --- | --- |
| M-1 | 无工作区根早退：返回 null；progress 回调收到终态 `failed`；`getOperationProgress(operationId)` 返回 failed + message；不带 id 的 `getOperationProgress()` 返回 null（无死记录） |
| M-2 | 快照时无类别覆盖（data.bin 已备份）→ 恢复前启用 `profilePatterns: { largeMedia: ['*.bin'] }`（默认 largeMedia 不含 `*.bin`）→ data.bin 被当前规则排除：restored=0/deleted=0 且内容不被覆盖 |
| M-3 | manifest.excluded 三种 reason（custom/default/gitignore）全部受保护：放宽规则后预览 untrackedPaths 不含它们，`deleteUntrackedFiles=true` 恢复后文件仍存在 |
| M-4 | 仅 profilePatterns 变化 → `rulesChanged=true`；规则一致 → `rulesChanged=false` |
| L-2 | 新格式恢复路径经 `showRestoreResultMessage` 写状态栏（`$(check)` 前缀 + 5000ms） |

## 验证结果

1. **单元测试**：`npx jest --config jest.backend.config.js backend/__tests__/checkpoint/`
   → **14 suites / 215 tests 全部通过**（含既有 checkpoint 测试，无回归）。
2. **typecheck**：`npm run typecheck`（`tsc -p ./ --noEmit`）——**本批次文件 0 错误**。
   工作区存在其他并发批次（subagents F2）未完成的
   `backend/tools/subagents/runController.ts`（TS2322，`run_detached` 未入事件联合类型），
   不在本批次文件边界内，未改动；期间该文件出现过一段语法错误（方法签名重复行），
   已由并发批次自行修复，本批次全程未修改该文件（临时验证后按字节恢复原状）。
3. 修改边界检查：仅改动 `CheckpointManager.ts`、`CheckpointRestoreService.ts` 与
   `backend/__tests__/checkpoint/` 下新增测试；未改 CHANGELOG.md、规划文档、
   branch/、conversation/、frontend/、webview/；未触碰 `messageNodeId` 逻辑。


---

# R7b 复查补充（批次 R7b-FIX）

## 背景

R7b 复查 FIX-G2 发现 M-3 修复不完整（目录级 excluded 条目只保护目录自身）+ 若干低危，
本批次在既定文件边界内修复：

- `backend/modules/checkpoint/CheckpointRestoreEngine.ts`（保护判定前缀匹配）
- `backend/modules/checkpoint/CheckpointRestoreService.ts`（注释修正 + serializeProfilePatterns）
- `backend/__tests__/checkpoint/CheckpointRestoreRules.test.ts`（新增 2 例）
- `backend/__tests__/checkpoint/CheckpointRestoreEngine.test.ts`（新增 2 例）
- `CheckpointIgnoreResolver.ts` 只读（findProfileMatch 仅记录不修）

## 修改摘要

### M-3（中，R7b 补充）：目录级 excluded 条目只保护目录自身 → 前缀匹配

**问题**：快照时整目录被排除（如 `dist/`）时 `CheckpointIgnoreResolver.collectEntries`
只记录目录自身一条 excluded（`ws_x/dist`，reason=default），不递归记录内部文件；
用户放宽规则后目录内文件（`ws_x/dist/app.js`）进入 currentHashes →
untrackedToDelete → `deleteUntrackedFiles=true` 被删。原保护判定是精确匹配
`protectedScopedPaths.has(key)`（computeRestorePlan L192 / restoreWorkspaceSnapshot L470），
`has('ws_x/dist/app.js')` 为 false。默认类别存在大量目录模式
（logs/ data/ dist/ build/ target/ .cache/ __pycache__/ .venv/ venv/ 等）。

**修复**：CheckpointRestoreEngine 新增公共判定函数 `isProtectedScopedPath`：
精确命中或任一祖先前缀命中（`key === p || key.startsWith(p + '/')`），
三处保护判定（computeRestorePlan 的 currentHashes / currentEmptyDirs、restoreWorkspaceSnapshot
的 currentEmptyDirs）统一改用它（公共判定点，预览与执行共用）。
- scoped 键统一 `/` 分隔符（toScopedKey 已归一化反斜杠），无需平台路径处理；
- 文件级条目前缀保护无害：`/` 边界保证 `secret.log` 不会误保护 `secret.log.bak`，
  `dist/` 不会误保护 `dist-other/`；
- 目录条目自身也走精确命中（`has(ws_x/dist)` 为 true），行为超集覆盖原精确匹配。

### M-3 补充（低）：unreadable 目录条目注释修正

resolver 阶段不可读目录的 excluded 条目（reason='unreadable'，isDirectory=true）
只进 manifest.excluded、不在 unbackedPaths（unbackedPaths 只含文件级 size/unreadable
与复制失败路径）；目录保持不可读时内部文件不会进入 currentHashes，无需保护。
修正 prepareRestore 保护循环注释：「size/unreadable 已在 unbackedPaths 覆盖」
限定为文件级，并补充目录级说明。

### M-4（低，三连）：serializeProfilePatterns

① 注释原称「忽略数组内顺序差异」，实现 `list.join('\n')` 保留顺序——顺序对否定规则
（`!`）有语义，按序比较是**正确**行为，只改注释不改实现；
② 空数组条目（`{logs: []}` → `logs:`）与 undefined（`''`）序列化不等价 →
rulesChanged 偶发误报：序列化时过滤 `list.length === 0` 条目（空覆盖=未覆盖=默认清单）；
③ 分隔符 `|` 理论碰撞（模式含 `|` 时跨类别串扰）：改用 `\u0000`
（gitignore 模式不可能出现的字符）。

### 低（仅记录不修）：CheckpointIgnoreResolver.findProfileMatch 规则归属

`findProfileMatch`（L620-635）规则归属用类别**默认**模式清单 `profile.patterns`，
覆盖模式下 rule 缺失——仅展示层瑕疵（预览「为什么被排除」缺规则文本）。
涉及 resolver 展示结构，风险大于收益，本批次只记录不修。

## 测试

新增 4 例：

| 用例 | 位置 | 验证内容 |
| --- | --- | --- |
| M-3 目录级（计划） | CheckpointRestoreEngine.test.ts | computeRestorePlan：`ws_x/dist` 保护 `dist/app.js`、`dist/sub/deep.js` 与 `dist/empty-dir`；`dist-other/`、`secret.log.bak`（文件级邻居）不受保护 |
| M-3 目录级（执行） | CheckpointRestoreEngine.test.ts | restoreWorkspaceSnapshot + deleteUntrackedFiles=true：dist/ 内文件与空目录保留，快照后新建的 extra.txt / orphan-dir 被清理 |
| M-3 目录级（集成） | CheckpointRestoreRules.test.ts | manifest.excluded 只记录 `ws_x/dist` 一条（不递归内部文件）→ 放宽规则 → preview.untrackedPaths 不含 dist 内文件；deleteUntrackedFiles=true 恢复后 dist 文件保留、快照后新建 new.txt 被删 |
| M-3 文件级无副作用（集成） | CheckpointRestoreRules.test.ts | 文件级保护精确匹配：keep.log 受保护保留；快照后新建的 keep.log.bak（无 `/` 边界）正常删除 |

## 验证结果

1. 目标测试：`npx jest --config jest.backend.config.js backend/__tests__/checkpoint/CheckpointRestoreRules.test.ts backend/__tests__/checkpoint/CheckpointRestoreEngine.test.ts`
   → **2 suites / 22 tests 全部通过**。
2. 回归：`npx jest --config jest.backend.config.js backend/__tests__/checkpoint/` →
   **14 suites / 219 tests 全部通过**（基线 215 + 新增 4，无回归）。
3. typecheck：`npm run typecheck`（`tsc -p ./ --noEmit`）→ **0 错误**。
4. 修改边界：仅改动 `CheckpointRestoreEngine.ts`、`CheckpointRestoreService.ts` 与两个测试文件；
   未改 CHANGELOG.md、规划文档、branch/、conversation/、frontend/、webview/；
   未触碰 CheckpointManager 的 create/restore 主流程；`CheckpointIgnoreResolver.ts` 只读。