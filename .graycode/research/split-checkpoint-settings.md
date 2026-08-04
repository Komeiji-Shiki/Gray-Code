# CheckpointSettings.vue 拆分（批次 S2）— 纯重构

## 概述

将 `frontend/src/components/settings/CheckpointSettings.vue`（原 3284 行）的 **script 逻辑** 拆分为 5 个 composable 模块，组件只保留编排（composable 组装 + 生命周期/监听）。模板与样式 **原样保留**，未做任何改动。纯重构：行为零变化，公共 props/emits/导出、i18n key 均不变。

- 拆分前：`CheckpointSettings.vue` 3284 行（script ~1211 + template ~789 + style ~1282）
- 拆分后：`CheckpointSettings.vue` 2263 行（script 190 + template 789 + style 1282）
- 新增 5 个文件，共 1387 行

## 拆分结构

```
frontend/src/components/settings/CheckpointSettings.vue  2263 行（script 190 / template 789 / style 1282）
├── frontend/src/composables/useCheckpointConfig.ts                453 行
├── frontend/src/composables/useCheckpointExclusion.ts             218 行
├── frontend/src/composables/useCheckpointCleanup.ts               500 行
├── frontend/src/composables/useCheckpointOperationProgress.ts     123 行
└── frontend/src/composables/useCheckpointManifest.ts               93 行
```

## 新文件职责

### 1. `useCheckpointConfig.ts`（453 行）— 配置加载/保存 + 消息/工具开关
- 类型：`MessageCheckpointConfig` / `CheckpointExclusionConfig` / `CheckpointConfig` / `ToolInfo` / `UpdateCheckpointConfigField`（供其他 composable 复用）
- 独立函数：`getToolDisplayName` / `getToolDescription`（i18n 辅助，清理模块复用）
- 状态：`config`（reactive 整包配置）、`configSaveError`、`isLoading`、`loadError`、`allTools`、保存串行队列 `configSaveChain` + 权威快照 `lastSavedConfig`
- 逻辑：`cloneConfigSnapshot` / `configFieldEquals` / `buildConfigToSave` / `updateConfigField`（H-1 失败回滚）/ `loadConfig`（checkpoint.getConfig）/ `loadTools`（tools.getTools）
- 消息开关：`messageTypes`、`isMessageInBefore/After`、`toggleMessageBefore/After`、`toggleModelOuterLayerOnly`、`toggleMergeUnchangedCheckpoints`（M-7 保存成功才同步 chatStore）、`hasModelMessageCheckpoint`、`toggleAllMessageBefore/After`、`isAllMessageBefore/AfterSelected`
- 工具开关：`displayTools`、`isToolInBefore/After`、`toggleToolBefore/After`、`toggleAllBefore/After`、`isAllBefore/AfterSelected`

### 2. `useCheckpointExclusion.ts`（218 行）— 排除配置（EX-08/09）
- 常量：`DEFAULT_PROFILE_IDS`（模块级导出，供 manifest 复用）
- 依赖注入：`(config, updateConfigField)`，由组件传入 `useCheckpointConfig` 的返回值
- 逻辑：`loadExclusionProfiles`（checkpoint.getExclusionProfiles）、`isProfileEnabled`、`toggleProfile`、`openProfileEditor`、`saveProfilePatterns`、`profileLabel`、`profilePatterns`、`maxFileSizeMiB`、`saveMaxFileSize`、`onCustomPatternsChange`、`runPreview`、`previewRows`、`reasonLabel`、`togglePreviewProfile`
- 状态：`exclusionProfileMeta`、`isPreviewing`、`previewResult`、`previewError`、`expandedPreviewProfile`、`editingProfileId`、`profilePatternsDraft`、`maxFileSizeError`

### 3. `useCheckpointCleanup.ts`（500 行）— 存档点清理 / 批量管理
- 类型：`ConversationWithCheckpoints` / `DeleteConfirmState`
- 状态：`conversationsWithCheckpoints`、`searchQuery`、`isCleanupLoading`、`selectedConversationIds`、`expandedConversationId`、`expandedCheckpoints`、`selectedCheckpointIds`、`isExpandedLoading`、`isBatchDeleting`、`deleteConfirmState`、`deleteFeedback`
- 计算：`filteredConversations`、`selectedConversations`、`selectedConversationsCheckpointCount/Size`、`totalCheckpointsSize`、`totalCheckpointsSizeIncomplete`、`isAllConversationsSelected`、`isAllCheckpointsSelected`、`selectedCheckpointsSize`
- 逻辑：`loadConversationsWithCheckpoints`、`toggleConversationSelected`、`toggleAllConversationsSelected`、`toggleExpandConversation`、`loadExpandedCheckpoints`（M-5 竞态防护）、`toggleCheckpointSelected`、`toggleAllCheckpointsSelected`、`requestDeleteConversations/Checkpoints/SingleCheckpoint`、`showDeleteConfirmDialog`、`cancelDelete`、`confirmDelete`（M-6 失败保留 + 刷新权威计数 + chatStore 联动）
- 格式化：`getPhaseLabel`、`getTypeLabel`、`getToolLabel`（复用 config 模块的 `getToolDisplayName`）、`getUnbackedPathsTitle`、`toDisplayScopedPath`、`formatRelativeTime`、`formatSize`、`formatCheckpointCount`

### 4. `useCheckpointOperationProgress.ts`（123 行）— 操作进度轮询（M7/M4）
- 状态：`operationProgress`、`operationStale`、`operationCancelError`（轮询定时器/重试计数为闭包内变量）
- 逻辑：`pollOperation`、`startProgressPolling`（800ms 间隔）、`stopProgressPolling`、`cancelActiveOperation`（L-10 取消失败保留原状态）、`operationPhaseLabel`；常量 `POLL_ERROR_MAX` / `POLL_STALE_THRESHOLD_MS`

### 5. `useCheckpointManifest.ts`（93 行）— 存档排除清单详情（EX-11）
- 依赖注入：`(config, loadError)`；复用 `DEFAULT_PROFILE_IDS`
- 状态：`manifestCheckpointId`、`manifestDetail`、`isManifestLoading`、`manifestLoadError`
- 逻辑：`manifestExcludedCount`、`manifestEnabledProfileIds`、`manifestRulesChanged`（快照规则 vs 当前规则）、`openManifestDetail`（防串台）、`closeManifestDetail`

## 组件保留内容（CheckpointSettings.vue script，190 行）

- 导入 5 个 composable + `getToolDisplayName` / `getToolDescription`（模板使用）+ 原有 common/i18n/chatStore 导入
- 5 个 composable 的组装（`useCheckpointExclusion(config, updateConfigField)`、`useCheckpointManifest(config, loadError)` 传共享响应式引用）
- 编排函数 `loadConfig()`：`loadConfigFromBackend()` → `loadExclusionProfiles()` → `loadTools()`（保持原顺序与「元数据/工具失败仅告警」语义）
- 生命周期：`onMounted`（await loadConfig → 加载对话列表 → 开始轮询）、`watch(isBatchDeleting)`、`watch(() => chatStore.checkpoints)`、`onUnmounted(stopProgressPolling)`
- 模板与 `<style scoped>` 全部原样保留（样式拆分风险高、非重点，按计划保留）

## 行为等价性核对

- H-1（保存失败回滚/串行队列）、H-2（加载失败横幅+重试）：`updateConfigField` / `loadConfig` 代码逐行搬运，状态由 `useCheckpointConfig` 闭包持有
- M-7（仅保存成功同步 chatStore）：`toggleMergeUnchangedCheckpoints` 原样，chatStore 经 `useChatStore()` 注入
- M-6（confirmDelete 失败保留列表）：原样搬运至 cleanup，IPC 调用顺序与反馈逻辑不变
- M-4（轮询容错：瞬时错误 5 次停止 / 陈旧停止）：`pollOperation` 等原样搬运至 operation composable，定时器语义不变
- EX-11 manifest / EX-08/09 排除逻辑：原样搬运；`loadError` 以 ref 注入 manifest，保证「配置未加载成功不误报差异」语义
- 模板绑定：全部经由组件 script 解构暴露，命名与原来一致（含 `DEFAULT_PROFILE_IDS`、`formatSize`、`profileLabel` 等跨模块引用）

## 验证结果

| 项目 | 结果 |
|---|---|
| `npm --prefix frontend run typecheck`（vue-tsc --noEmit） | ✅ 通过（0 错误） |
| `npm --prefix frontend test`（vitest run，全量） | ✅ 16 个文件 / 168 个用例全部通过 |
| `CheckpointSettings.test.ts` | ✅ 9 个用例全部通过（H-1/H-2/M-7/M-6/M-4） |
| 模板/样式 | ✅ 原样保留（仅删除旧 script 并插入新 script，行数核算：3284 - 1211 + 190 = 2263） |

## 备注

- `frontend/src/stores/chat/checkpointActions.ts`、`messageActions.ts`、`conversationActions.ts`、`MessageList.vue`、`MessageItem.vue` 等正被其他批次修改（git status 为 M）——本批次**只读引用**：composable 仅从 `@/stores/chat/checkpointActions` 导入 `previewExclusions` / `pollOperationProgress` / `cancelCheckpointOperation` / `getCheckpointManifest`（符号均存在且完整），从 `@/stores` 导入 `useChatStore`；未改动任何 stores/、webview/、其他 components/ 文件。
- 未修改 `CHANGELOG.md`、规划文档；`composables/index.ts` 未改动（组件按需直接导入各模块）。
- 未新增任何 i18n key；未改动公共 props/emits（组件本就无 props/emits）。
