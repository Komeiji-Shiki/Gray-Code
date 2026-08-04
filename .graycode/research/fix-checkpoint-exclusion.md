# 批次 B2 修复摘要：Checkpoint 排除与设置校验

> 依据 `.graycode/research/checkpoint-backend-review.md` 的 EX-CFG-1 / EX-12-1 / EX-12-2 /
> EX-CFG-2 / EX-CASE-1 / EX-CASE-2 / CP-SYMLINK-1 / CP-DEAD-3 / CP-WS-1（URI 部分）修复。
> 日期：2026-08-04（后台子 agent，批次 B2）

## 修改摘要

### 1. [中] EX-CFG-1 保存前深合并嵌套配置 — `backend/modules/settings/SettingsManager.ts`

- `updateCheckpointConfig`（L752-866）落盘前由浅合并 `{ ...oldConfig, ...config }` 改为
  `deepMergeToolsConfig(oldConfig, configToSave)`（复用模块内已有的递归深合并工具，
  数组与原始值仍直接覆盖）。
- 效果：前端只发送部分 `exclusion` / `messageCheckpoint` 负载时，已保存的
  `profilePatterns` / `maxFileSizeBytes` / `customPatterns` 及 messageCheckpoint 嵌套字段不再被整体覆盖。
- 其他 tools 配置的保存语义未改动（仅 checkpoint 段落使用深合并）。

### 2. [中] EX-12-1 类型校验补齐 — `SettingsManager.ts`

- `enabledProfiles`：value 必须是 `boolean`（`"false"` 字符串 / `null` 拒绝保存，否则 truthy 会让“关闭”静默失效）。
- `beforeTools` / `afterTools`：必须是字符串数组（新增私有 `isStringArray`）。
- `maxCheckpoints`：必须是有限整数；**保留 `-1` 为“无上限”哨兵**（前端 CheckpointSettings.vue 与
  `DEFAULT_CHECKPOINT_CONFIG` 均沿用 `-1`，直接按“非负整数”会破坏无上限保存），
  拒绝 NaN / Infinity / 非整数 / 小于 -1 / 字符串（新增私有 `isValidMaxCheckpoints`）。
- `enabled`：必须是 `boolean`。
- 新增 i18n key `modules.settings.errors.invalidCheckpointConfigField`（en / zh-CN / ja）。

### 3. [低] EX-12-2 拒绝全忽略模式 — `backend/modules/checkpoint/CheckpointExclusionProfiles.ts`

- `validateCustomExclusionPatterns` 剥离 `!` 前缀后，若 body 为 `*` / `**` / `/**` / `/*` 即拒绝，
  reason 新增 `blanket`（同步加入 `CheckpointExclusionPatternIssueReason` 联合类型）。
- `**/cache/**`、`*.log` 等限定子树模式不受影响（已有用例回归通过）。
- i18n `exclusionPatternReason.blanket` 三语种文案已同步。

### 4. [低] EX-CFG-2 负数归一化不再改写调用方对象 — `SettingsManager.ts`

- `updateCheckpointConfig` 开头先浅拷贝 `configToSave`（`exclusion` 单独拷贝一层），
  后续 `maxFileSizeBytes < 0 → 0` 归一化只写拷贝对象；调用方传入对象保持原值。

### 5. [中] EX-CASE-1 强制排除目录片段大小写折叠 — `CheckpointIgnoreResolver.ts`

- 新增模块级 `CASE_INSENSITIVE_FS = win32 || darwin`；`shouldIgnore` 逐段比较前
  `toLowerCase()`，`.GIT` / `NODE_MODULES` 在 Windows / macOS 大小写不敏感卷上不再可绕过强制排除，
  且仍不可被 `!` 否定。命中时 `rule` 返回磁盘原始片段名。

### 6. [中] EX-CASE-2 + CP-WS-1 URI 大小写折叠 — `CheckpointIgnoreResolver.ts` / `CheckpointWorkspace.ts`

- `isExcludedAbsolutePath` 的 case-fold 由仅 `win32` 扩展为 `win32 || darwin`（macOS APFS 默认大小写不敏感）。
- `CheckpointWorkspace.normalizeWorkspaceUri` 同样改为 `win32 || darwin` 小写化，
  同一目录不同大小写的 URI 生成相同 rootId / 指纹。

### 7. [低] CP-SYMLINK-1 符号链接不再静默丢弃 — `CheckpointIgnoreResolver.ts`

- `collectEntries` 中既非目录也非文件的条目（符号链接 / fifo / socket）记录到 `excluded` 清单，
  `reason: 'unsupported_file_type'`、`source: 'filesystem'`，预览/恢复可向用户解释“为什么没有备份”。
- 采用“记录 reason + 预览展示”的最小实现，未改动 manifest 结构与恢复引擎。

### 8. [低] CP-DEAD-3 删除死代码 — `CheckpointIgnoreResolver.ts`

- 删除 `removeEmptyDirectories`（全仓库无生产调用方、无测试引用；恢复引擎已自行处理空目录清理）。
- 因无任何引用，删除安全；如需手动清理可经快照构建器/恢复引擎路径。

## 回归测试

| 文件 | 新增用例 |
|---|---|
| `CheckpointExclusionConfigValidation.test.ts` | EX-12-1：enabledProfiles 非布尔（`"false"`/null）拒绝；beforeTools/afterTools 非字符串数组拒绝；enabled 非布尔拒绝；maxCheckpoints NaN/Infinity/1.5/-2/字符串拒绝、-1 与 0 保留合法 |
| 同上 | EX-CFG-1：部分 exclusion 更新深合并保留 profilePatterns / maxFileSizeBytes / customPatterns；messageCheckpoint 部分更新保留嵌套字段 |
| 同上 | EX-CFG-2：负数归一化不改写调用方对象（调用方保持 -5，落盘为 0） |
| 同上 | EX-12-2：`*` `**` `/**` `/*` `!*` `!**` 自定义模式拒绝保存 |
| `CheckpointExclusionProfiles.test.ts` | EX-12-2：blanket 拒绝（含 `!` 变体），`**/cache/**` 等仍合法 |
| `CheckpointIgnoreResolver.test.ts` | EX-CASE-1：`.GIT` / `NODE_MODULES` 大小写用例（win32/darwin 强制排除且 `!` 否定无效；POSIX 分支保持跟踪） |
| 同上 | EX-CASE-2：原 L-3 用例扩展为 win32/darwin 分支 |
| 同上 | CP-SYMLINK-1：符号链接记录为 `unsupported_file_type` excluded 条目（Windows 无权限时按既有惯例跳过） |
| `CheckpointWorkspace.test.ts` | CP-WS-1：`file:///A/Workspace` 与 `file:///a/workspace` 在 win32/darwin 同 rootId，POSIX 不同 |

## 验证结果

指定命令（4 个测试文件）全部通过：

```
npx jest --config jest.backend.config.js backend/__tests__/checkpoint/CheckpointExclusionConfigValidation.test.ts \
  backend/__tests__/checkpoint/CheckpointIgnoreResolver.test.ts \
  backend/__tests__/checkpoint/CheckpointExclusionProfiles.test.ts \
  backend/__tests__/checkpoint/CheckpointWorkspace.test.ts
→ Test Suites: 4 passed, 4 total; Tests: 85 passed, 85 total
```

扩展回归（checkpoint 全目录 + toolBatchCheckpoint + settings）：**158 passed / 39 failed**。
39 个失败全部位于 `CheckpointManager.test.ts` / `CheckpointManagerWorkspace.test.ts` /
`CheckpointManifestPhase3.test.ts`，根因是**其他 agent 未提交的 `CheckpointQueryService.ts` 重构**
（CP-TYPE-1：`getCheckpointRecords` 移除 `as any` 回退、改走类型化 `getCustomMetadata`）——
这三个测试文件中的 conversationManager mock 尚无 `getCustomMetadata` 方法，运行时报
`TypeError: this.conversationManager.getCustomMetadata is not a function`。
上述文件均不在本批次允许修改边界内（CheckpointQueryService.ts 与三个 CheckpointManager 测试
文件均不在允许清单），本批次改动未引入任何新失败：除这三个套件外其余 11 个套件全部通过。

## 边界遵守

- 仅修改：`SettingsManager.ts`（checkpoint 配置段）、`CheckpointExclusionProfiles.ts`、
  `CheckpointIgnoreResolver.ts`、`CheckpointWorkspace.ts`、`backend/i18n/langs/` 错误文案、
  允许清单内的 4 个测试文件。
- 未触碰：CHANGELOG.md、规划文档、CheckpointManager / ManifestRepository / RetentionService /
  OperationLock / SnapshotBuilder / RestoreEngine / QueryService / checkpointConcurrency /
  conversation 模块、frontend、webview。
