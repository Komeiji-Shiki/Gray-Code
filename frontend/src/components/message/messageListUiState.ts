/**
 * MessageList UI 状态的模块级保存（H5 / M2-1）。
 *
 * 独立成纯 .ts 模块的原因：tabActions.closeTab 需要在移除标签页后清理该 Map
 * （tabId 全局唯一不复用，每关一个标签页泄漏一条）；若从 MessageList.vue 导入，
 * store 层（tabActions → MessageList.vue → chatStore → tabActions）会产生循环导入，
 * 且 vue-tsc 对循环中的 .vue 命名导出会回退到通配符 shim 导致类型错误。
 * 提升为纯模块后，MessageList.vue 与 tabActions 都从这里读写/清理，无循环。
 */
export interface RestoreNoticeState {
  kind: 'error' | 'partial' | 'warning' | 'success'
  message: string
}

export interface MessageListUiState {
  scrollTop: number
  visibleCount: number
  buildExpanded: boolean
  todoExpanded: boolean
  /** R3-#8: 恢复结果提示随标签页 UI 状态持久化，切换标签页/组件重建后不丢失 */
  restoreNotice: RestoreNoticeState | null
}

export const messageListUiStateByTab = new Map<string, MessageListUiState>()

/** M2-1：MessageList UI 状态容量上限（防御性兜底，防止异常路径持续累积） */
export const MESSAGE_LIST_UI_STATE_CAP = 50

/**
 * M2-1：按「仍打开的标签页 ID 集合」清理模块级 UI 状态。
 * tabId 全局唯一且不复用，关闭标签页后其记录永不失效；
 * 由 tabActions.closeTab 在移除标签页后调用，避免每关一个标签页泄漏一条。
 */
export function pruneMessageListUiStateByTab(activeTabIds: Set<string>): void {
  for (const tabId of Array.from(messageListUiStateByTab.keys())) {
    if (!activeTabIds.has(tabId)) {
      messageListUiStateByTab.delete(tabId)
    }
  }
}
