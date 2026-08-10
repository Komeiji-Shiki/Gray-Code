/**
 * MessageItem 视图模式的模块级保存（R3-#5 / M1-1）。
 *
 * 独立成纯 .ts 模块的原因：MessageItem 组件实例会随列表滚动（虚拟化）、新增消息、
 * 重载等场景销毁重建；若折叠态只是组件实例级 ref，重建后会复位为默认值。
 * 以 messageId 为 key 存于模块级 reactive(Map)，组件重建时按 id 恢复用户上次选择的
 * 视图模式；同时由 MessageList 在对话/标签页切换时按「仍活跃的消息 ID 集合」清理。
 * 与 messageListUiState.ts 同模式：模块级单例 + 单一导出出口（状态不复制、不分散）。
 */
import { reactive } from 'vue'
import type { ThoughtViewMode } from './renderBlocks'

/** 后台任务回流消息三段式视图模式：折叠 / 中展开（滚动查看） / 完全展开 */
export type BackgroundTaskViewMode = 'collapsed' | 'medium' | 'expanded'

/**
 * 后台任务消息视图模式记录：以 messageId 为 key 的模块级 reactive Map。
 * 使用 reactive(Map) 以便 computed getter 追踪 key 访问、setter 触发更新。
 */
export const backgroundTaskViewModeByMessageId = reactive(new Map<string, BackgroundTaskViewMode>())

/**
 * M1-1：视图模式 Map 容量上限（防御性兜底；正常路径由 pruneBackgroundTaskViewModes 定期清理）。
 * 消息删除/窗口裁剪/重试截断/对话关闭都会留下不再被渲染的 messageId 记录，
 * 该上限保证 Map 大小有界，避免无限增长。
 */
export const BACKGROUND_TASK_VIEW_MODE_CAP = 500

/**
 * M1-1：清理不再活跃（消息被删除/窗口裁剪/重试截断/对话关闭）的视图模式记录。
 *
 * @param activeIds 仍可能被渲染的消息 ID 集合（当前窗口 + 各标签页快照的并集）；
 *                  不在集合中的 messageId 记录会被删除。
 */
export function pruneBackgroundTaskViewModes(activeIds: Set<string>): void {
  for (const messageId of Array.from(backgroundTaskViewModeByMessageId.keys())) {
    if (!activeIds.has(messageId)) {
      backgroundTaskViewModeByMessageId.delete(messageId)
    }
  }
}

/**
 * 思考块视图模式记录的同口径清理（与 pruneBackgroundTaskViewModes 一起由 MessageList
 * 在对话/标签页切换时调用）：消息删除/窗口裁剪/重试截断/对话关闭后移除不再渲染的 id。
 */
export function pruneThoughtViewModes(activeIds: Set<string>): void {
  for (const messageId of Array.from(thoughtViewModeByMessageId.keys())) {
    if (!activeIds.has(messageId)) {
      thoughtViewModeByMessageId.delete(messageId)
    }
  }
}

/**
 * 思考块三段式视图模式的模块级持久化（与 backgroundTaskViewModeByMessageId 同模式）：
 * 虚拟列表滚动回收 MessageItem 后，用户选择的折叠/完全展开不应复位为默认中展开。
 * 带容量上限（消息删除/窗口裁剪会留下不再渲染的 messageId 记录）。
 */
export const thoughtViewModeByMessageId = reactive(new Map<string, ThoughtViewMode>())
export const THOUGHT_VIEW_MODE_CAP = 500
