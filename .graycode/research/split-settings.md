# 拆分 SettingsManager.ts 与 types.ts（批次 S3）

日期：2026-08-04
范围：`backend/modules/settings/SettingsManager.ts`（2347 行）与 `backend/modules/settings/types.ts`（2419 行）纯重构拆分。
约束：行为零变化；SettingsManager 公共方法签名不变；`types.ts` 现有导出名不变；不碰 `backend/modules/checkpoint/`、frontend、webview、conversation、subagents。

---

## 1. 拆分结构总览

### 1.1 SettingsManager.ts（2347 行 → 门面 1126 行）

原单类按「注释分区」拆为 **1 个核心 + 14 个主题服务**，`SettingsManager` 保留全部公共方法并聚合委托，导出 API 不变（`SettingsManager` 类 + `SettingsStorage` 类型，后者改为从 SettingsCore 重新导出）。

```
backend/modules/settings/
├── SettingsManager.ts                 1126 行  ← 门面：构造服务 + initialize + ~150 个委托方法
├── SettingsCore.ts                     253 行  ← 共享状态与基础设施
├── CheckpointSettingsService.ts        248 行  ← 存档点配置段
├── PromptSettingsService.ts            515 行  ← 系统提示词/模式段
├── ToolsSettingsService.ts             467 行  ← 工具启用/自动执行/工具配置/Shell/工具模式段
├── MemorySettingsService.ts             40 行  ← 记忆配置段（被 Tools 服务注入引用）
├── ContextSettingsService.ts           119 行  ← 上下文感知 + 诊断段
├── PinnedFilesSettingsService.ts       135 行  ← 固定文件段
├── SkillsSettingsService.ts             76 行  ← Skills 段
├── ImageToolsSettingsService.ts         98 行  ← 图像生成/抠图/裁切/缩放/旋转段
├── ProxySettingsService.ts              72 行  ← 代理段
├── SummarizeSettingsService.ts          33 行  ← 总结段
├── TokenCountSettingsService.ts         43 行  ← Token 计数段
├── UISettingsService.ts                 71 行  ← UI 设置 + 公告版本段
├── StoragePathSettingsService.ts        92 行  ← 存储路径段
└── SubAgentsSettingsService.ts          88 行  ← 子代理段
```

#### 关键设计：SettingsCore（共享上下文）

- 持有 `settings`（GlobalSettings）、`storage`（SettingsStorage）、变更监听器集合；
- 提供全部服务共用的基础设施：`cloneConfig` / `deepMergeConfig` / `arraysEqual` /
  `getToolsConfigEntry` / `saveToolsConfigEntry` / `notifyChange` / `getSettings` /
  `updateSettings` / `reloadAndNotify` / `reset` / `addChangeListener` / `removeChangeListener`；
- 游离函数 `deepMergeToolsConfig`（原 SettingsManager 私有）移至本文件；
- 每个服务构造函数接收同一个 `SettingsCore` 实例，保证状态与通知行为完全一致。

#### 跨服务依赖（唯一一处）

- `ToolsSettingsService` 需要 `MemorySettingsService.isMemoryEnabled()`（工具启用判定），
  通过构造函数注入 `memory` 服务；`SettingsManager` 构造时先建 memory 再建 tools。
- `initialize()` 需要 prompt 服务的 `migratePromptModeToolPolicies()`（原私有方法，
  在服务中改为 public，仅模块内部可见，不改变对外 API），由门面编排。

#### 委托方式

每个公共方法在 `SettingsManager` 上保留原签名，方法体为一行委托（如
`getCheckpointConfig()` → `this.checkpoint.getCheckpointConfig()`）；原私有辅助方法
（`exclusionPatternIssueText` / `isStringArray` / `isValidMaxCheckpoints` /
`normalizePromptModeSnapshot` 等）随所属主题原样搬入对应服务并保持 private。

### 1.2 types.ts（2419 行 → 聚合入口 22 行）

类型定义按主题拆到 11 个文件，`types.ts` 仅剩 `export *` 聚合，现有
`from '../settings/types'` 导入路径全部不变（含 `promptModes.ts` 的 `export *` 链）。

```
backend/modules/settings/
├── types.ts                   22 行  ← 聚合入口（export * 11 个主题文件 + promptModes）
├── checkpointTypes.ts        186 行  ← CheckpointConfig / MessageCheckpointConfig + 默认值
├── toolsTypes.ts             783 行  ← 工具启用/自动执行/文件类工具/图像工具/Shell/
│                                        ExecuteCommand 配置与全部 DEFAULT_* + COMMON_IGNORE_PATTERNS
│                                        + ToolsConfig + DEFAULT_MAX_TOOL_ITERATIONS
├── promptTypes.ts            356 行  ← PromptModule / PromptMode / PromptEntry / SystemPromptConfig
│                                        / DynamicContextStrategy 等 + AVAILABLE_PROMPT_MODULES
├── contextTypes.ts           141 行  ← DiagnosticSeverity / DiagnosticsConfig / ContextAwarenessConfig + 默认值
├── pinnedFilesTypes.ts        64 行  ← PinnedFileItem / PinnedFilesConfig + 默认值
├── skillsTypes.ts             52 行  ← SkillConfigItem / SkillsConfig + 默认值
├── summarizeTypes.ts          78 行  ← SummarizeConfig + DEFAULT_KEEP_RECENT_TOKENS / DEFAULT_SUMMARIZE_CONFIG
├── tokenCountTypes.ts        111 行  ← TokenCountChannelConfig / TokenCountConfig + 5 个默认值
├── subAgentsTypes.ts         125 行  ← SubAgentToolsConfig / SubAgentConfigItem / SubAgentsConfig + 默认值
├── uiTypes.ts                 82 行  ← UISoundSettings / UISoundAsset / WindowsAgentStopNotification*
├── generalTypes.ts           346 行  ← ProxySettings / StoragePathConfig / StorageStats / GlobalSettings /
│                                        MACHINE_SCOPE_KEYS / SettingsChangeEvent / SettingsChangeListener
│                                        + DEFAULT_GLOBAL_SETTINGS（聚合默认值）
```

要点：
- `CheckpointConfig` / `MessageCheckpointConfig`（含 `DEFAULT_CHECKPOINT_CONFIG` /
  `DEFAULT_MESSAGE_CHECKPOINT_CONFIG`）移入 `checkpointTypes.ts`，其
  `CheckpointExclusionConfig` 依赖仍来自 `../checkpoint/types`（未移动，也不动 checkpoint 目录）；
- `generalTypes.ts` 的 `DEFAULT_GLOBAL_SETTINGS` 从各主题文件 import 全部默认值（等价于原文件内引用）；
- 原 `types.ts` 末尾的 `export * from './promptModes'` 保留在聚合入口，`promptModes.ts` 未改动；
- 经脚本比对：旧 types.ts 的 94 个导出名在新文件中**无缺失**。

## 2. 新文件职责速查

| 文件 | 职责 |
| --- | --- |
| SettingsCore.ts | 设置状态/存储/监听器；深合并；toolsConfig 读写与通知；getSettings/updateSettings/reloadAndNotify/reset |
| CheckpointSettingsService.ts | checkpoint 配置读写、排除配置校验（EX-12/L-4/EX-CFG-1/2）、工具/消息前后备份判断 |
| PromptSettingsService.ts | system_prompt 读取与版本迁移、模式规范化、模式增删改查/重命名、toolPolicy 迁移 |
| ToolsSettingsService.ts | maxToolIterations、activeChannelId、toolsEnabled、toolAutoExec、全部 toolsConfig 条目、Shell、defaultToolMode |
| MemorySettingsService.ts | 记忆总开关、memory 配置读写 |
| ContextSettingsService.ts | context_awareness 配置、诊断配置（含嵌套更新） |
| PinnedFilesSettingsService.ts | 固定文件增删改查/启用/清空/工作区过滤 |
| SkillsSettingsService.ts | Skills 列表读写、启用/移除 |
| ImageToolsSettingsService.ts | generate_image / remove_background / crop / resize / rotate 配置 |
| ProxySettingsService.ts | 代理配置读写、有效代理 URL 计算 |
| SummarizeSettingsService.ts | 总结配置读写 |
| TokenCountSettingsService.ts | Token 计数配置读写、渠道启用判断 |
| UISettingsService.ts | UI 设置深合并更新、公告版本读写 |
| StoragePathSettingsService.ts | 存储路径配置、迁移状态标记 |
| SubAgentsSettingsService.ts | 子代理配置增删改查 |

## 3. 验证结果

### 3.1 类型检查
```
npx tsc -p ./ --noEmit   → 通过（0 错误）
```

### 3.2 测试（任务指定命令）
```
npx jest --config jest.backend.config.js backend/__tests__/settings/ backend/__tests__/checkpoint/
→ Test Suites: 14 passed, 14 total
→ Tests:       213 passed, 213 total
```

### 3.3 补充回归（直接消费 SettingsManager 的相关套件）
```
npx jest --config jest.backend.config.js backend/__tests__/memory/ backend/__tests__/prompt/
  backend/__tests__/tools/diffReviewConfirmation.test.ts
  backend/__tests__/tools/outsideWorkspaceAccess.test.ts
  backend/__tests__/tools/toolBatchCheckpoint.test.ts
  backend/__tests__/api/summarizeRangePlanner.test.ts
→ Test Suites: 8 passed, 8 total；Tests: 76 passed, 76 total
```

### 3.4 API 面比对（脚本核对 git HEAD）
- SettingsManager 公共方法：old 150（另 3 个为 `for`/`load`/`save` 误报）== new 150，**无缺失、无新增**；
- types.ts 导出名：old 94 个在新拆分文件中**全部存在**，无缺失；
- 全仓库无任何代码访问原 SettingsManager 私有成员（`saveToolsConfigEntry` /
  `getToolsConfigEntry` / `deepMergeToolsConfig` / `.settings` 仅存在于新模块内部）。

## 4. 改动文件清单

- 修改：`backend/modules/settings/SettingsManager.ts`、`backend/modules/settings/types.ts`
- 新建：上述 15 个服务/核心文件 + 11 个类型主题文件（共 26 个）
- 其他目录：零改动（未触碰 checkpoint / frontend / webview / conversation / subagents / CHANGELOG.md / 规划文档）
