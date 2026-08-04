# FIX-E 批次：R4 复查安全与清理问题修复摘要

批次：FIX-E（R4 复查 H-1 / M-6 / M-7 / L-6 / L-7 / L-8 / L-9 / L-10 / L-11）
状态：已完成，全部测试通过。

## 一、修改摘要

### H-1（高）嵌套子 agent 权限逃逸 —— 已修复（方案 1 + 2 组合）

- `backend/tools/subagents/presets.ts`：导出 `WRITE_TOOLS`（供共享裁剪口径复用）。
- `backend/tools/subagents/executor.ts`：
  - 新增 `WRITE_CAPABILITY_TOOLS = WRITE_TOOLS ∪ ['execute_command']` 与共享纯函数
    `agentLacksWriteCapability(toolsConfig)`：mode `all`/`builtin` 具备写/执行能力；
    `mcp` 不具备；`whitelist` 必须包含全部写/执行工具；`blacklist` 命中任一即不具备。
  - `resolveSubAgentAvailableTools` 末尾：对不具备完整写/执行能力的代理，从解析结果中
    移除 `subagents` 声明（方案 2）——deep-researcher（blacklist 排写工具+execute_command）、
    code-reviewer（whitelist 只读）、web-searcher（mcp）等只读/受限预设因此无法派发
    mode='all' 的 General Worker，绕过只读沙箱的路径被掐断。
  - 新增模块级 `runAllowedToolsRegistry`（`setRunAllowedTools` / `getRunAllowedTools` /
    `clearRunAllowedTools`）：executor 解析出 run 的最终可用工具后按 runId 注册，
    run 结束时在最外层 finally 清理。
  - `createDefaultExecutor`：若 request 携带 `inheritedToolFilter`（父 run 限制），
    子 run 最终可用工具 = 自身配置解析结果 ∩ 父 run 可用工具（方案 1+3），
    `allowedToolNames`、`toolOverrides`、嵌套说明追加均改用交集后的集合；
    并将子 run 的最终工具集注册到 `runAllowedToolsRegistry`，供更内层派发继承。
- `backend/tools/subagents/subagents.ts`：
  - `getAgentAvailableTools` 复用同一 `agentLacksWriteCapability` 裁剪口径（声明描述
    与执行器实际工具集一致）。
  - `executeSubAgent` 嵌套派发（存在 `context.mailboxRunId`）时，从
    `getRunAllowedTools(parentRunId)` 读取父 run 限制，随 `SubAgentRequest.inheritedToolFilter`
    传给 executor（后台与前台两条路径均传）；主模型直接派发不继承。
  - General Worker 描述文案同步说明“被其他子代理调用时工具受父代理限制”。
- `backend/tools/subagents/types.ts`：`SubAgentRequest` 新增 `inheritedToolFilter?: string[]`
  （仅框架注入，模型不可控）。

### M-6（中）allowedToolNames 空集语义 —— 已修复

- `executor.ts` `executeToolCall`：校验分支由 `allowedToolNames && size > 0` 改为
  `if (allowedToolNames)`——空 Set 即拒绝一切工具调用（“无工具可用”而非“不校验”）。

### M-7（中低）声明侧与执行器工具口径分叉 —— 已处理

- 两侧（`subagents.ts getAgentAvailableTools` 与 `executor.ts resolveSubAgentAvailableTools`）
  共用 `agentLacksWriteCapability` + `WRITE_CAPABILITY_TOOLS`，保证 subagents 工具去留口径一致；
- 声明侧同步路径无法直接复用异步 ToolDeclarationResolver，已在 `getAgentAvailableTools`
  上方注释说明分叉原因与后续合一方案（声明生成改异步或缓存 resolver 结果）。

### L-6（低）BranchHandlers 未知错误映射 —— 已修复

- `backend/modules/conversation/branch/types.ts`：`BranchErrorCode` 新增 `'INTERNAL_ERROR'`。
- `webview/handlers/BranchHandlers.ts` `sendBranchError`：非 BranchError 不再伪装成
  `BRANCH_OPERATION_CONFLICT`，改返回 `INTERNAL_ERROR` 并透传 `error.message`。

### L-7（低）BranchHandlers 入参类型校验 —— 已修复

- 五个 handler 的 `conversationId`/`parentNodeId`/`nodeId` 均改为
  `typeof x !== 'string' || !x.trim()` 显式校验，非 string 入参按缺失处理
  （仍返回 `BRANCH_OPERATION_CONFLICT`，保持既有 IPC 契约）。

### L-8（低）SubAgentRequest.depth 注释 —— 已修复

- `types.ts` depth 注释补充“仅允许框架注入（subagents handler 由 context.subagentDepth+1
  计算），模型不可控；非法值由 executor 规范化为非负整数”。

### L-9（低）executor systemPrompt undefined 拼接 —— 已修复

- `executor.ts`：`${config.systemPrompt ?? ''}${SUBAGENT_NESTING_PROMPT_NOTICE}`。

### L-10（低）CheckpointManager 死代码 —— 已删除

- 删除 `getFileHash`（私有，全库无调用；crypto 仍被 createCheckpoint 使用，保留；
  `createReadStream` import 随删除清理）；
- 删除无调用方的私有转发包装 `backupDirectoryExists`、`pruneMissingBackupCheckpointRecords`
  （能力在 CheckpointQueryService，RestoreService 已直接调用 queryService）；
- 唯一测试引用（CheckpointManager.test.ts 的 prune 用例）改为直接调用
  `manager.queryService.pruneMissingBackupCheckpointRecords`。

### L-11（低）Checkpoint 公共类型迁移 —— 已完成

- `backend/modules/checkpoint/types.ts` 成为公共类型单一真源，迁入：
  `FileChange`、`RestorePreviewResult`、`CheckpointRecord`、`BatchCheckpointDeleteItem`、
  `BatchCheckpointDeleteResult`、`RestoreFailureReason`、`RestoreFailure`、
  `CheckpointExcludedNote`、`RestoreResult`；
- `CheckpointManager.ts`：删除本地同名类型定义，从 `./types` 导入并 `export type` re-export
  兼容（index.ts / QueryService / RetentionService / ManifestRepository / integrityCheck.test 等
  既有导入路径零改动）；
- `CheckpointRestoreService.ts`：L43 改为 `import type { CheckpointRecord, ... } from './types'`，
  本地类型定义删除并 re-export 兼容。

## 二、测试

新增/更新：
- 新增 `backend/__tests__/tools/subagentToolRestriction.test.ts`（11 用例）：
  - H-1 预设裁剪：deep-researcher 无写工具/无 subagents；code-reviewer 无 subagents；
    web-searcher 无 subagents；mode all / 显式白名单含 subagents 保留；blacklist 只排
    execute_command 仍裁剪（防执行权限逃逸）；
  - H-1 父限制传播：mode='all' General Worker 被只读父限制裁剪（toolOverrides 无写工具/
    execute_command/subagents、不追加嵌套说明、run 工具限制注册与清理）；
  - M-6：可用工具空集时工具调用被拒绝（success=false），run 正常收敛；
  - 预设定义完整性。
- `subagentsTool.test.ts` 新增 3 用例：嵌套派发 General Worker 携带 inheritedToolFilter、
  主模型直接派发不携带、blacklist 预设声明描述不暴露 subagents；executor mock 改为
  `requireActual` 展开（真实 `agentLacksWriteCapability`）+ 补充 `getRunAllowedTools` mock。
- `subagentNesting.test.ts`：executor mock 同步补齐（对应测试）。
- `branchHandlers.test.ts` 新增 2 用例：L-7 非 string 入参 → BRANCH_OPERATION_CONFLICT；
  L-6 未知异常 → INTERNAL_ERROR 透传原始信息。
- `CheckpointManager.test.ts`：prune 用例改走 queryService（L-10）。

## 三、验证结果

- 指定测试命令（6 个套件）：`npx jest --config jest.backend.config.js
  backend/__tests__/tools/subagentsTool.test.ts
  backend/__tests__/tools/subagentExecutorTermination.test.ts
  backend/__tests__/webview/branchHandlers.test.ts
  backend/__tests__/checkpoint/CheckpointManager.test.ts
  backend/__tests__/tools/subagentToolRestriction.test.ts
  backend/__tests__/tools/subagentNesting.test.ts`
  → **6 passed, 76 tests passed**。
- 全量后端：`npx jest --config jest.backend.config.js` → **125 suites / 1291 tests 全部通过**。
- TypeScript：`npx tsc --noEmit -p tsconfig.json` → **无错误**。

## 四、边界与兼容

- 仅改动任务允许的文件（subagents 模块、BranchHandlers、branch/types.ts 仅加码、
  checkpoint 三文件 + 对应测试）；未触碰 CHANGELOG.md、规划文档、前端、
  BranchService/BranchGraph/BranchGraphRepository、conversation storage/UsageIndexStore/ConversationManager。
- 行为兼容：mode all/builtin 代理（General Worker、自定义全量代理）保持嵌套派发能力；
  只读/受限代理不再暴露 subagents；嵌套子 run 工具集恒为父限制的子集。
- 残留说明：whitelist 预设（如 parallel-editor）未显式列出 subagents，故解析后仍不含
  subagents（resolver 白名单语义，既有行为，非本批次引入）；如需启用其嵌套派发，
  需在白名单中显式加入 subagents。
