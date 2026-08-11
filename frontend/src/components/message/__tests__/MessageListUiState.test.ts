/**
 * MessageList 模块级 UI 状态清理测试（M2-1）
 *
 * 覆盖：
 * - pruneMessageListUiStateByTab 只保留仍打开的标签页记录
 * - tabActions.closeTab 在移除标签页后清理对应 UI 状态（closeTab 调用链接线）
 * - MESSAGE_LIST_UI_STATE_CAP 容量常量存在且为正数（兜底上限）
 */
import { describe, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import {
  messageListUiStateByTab,
  pruneMessageListUiStateByTab,
  MESSAGE_LIST_UI_STATE_CAP
} from '../messageListUiState'
import { closeTab } from '../../../stores/chat/tabActions'
import type { ChatStoreState } from '../../../stores/chat/types'

function makeUiState(overrides: Partial<{ scrollTop: number }> = {}) {
  return {
    scrollTop: overrides.scrollTop ?? 0,
    visibleCount: 40,
    buildExpanded: false,
    todoExpanded: false,
    restoreNotice: null
  }
}

describe('messageListUiStateByTab 清理', () => {
  beforeEach(() => {
    messageListUiStateByTab.clear()
  })

  test('pruneMessageListUiStateByTab 只保留仍打开的标签页记录', () => {
    messageListUiStateByTab.set('tab_1', makeUiState())
    messageListUiStateByTab.set('tab_2', makeUiState())
    messageListUiStateByTab.set('tab_closed', makeUiState())

    pruneMessageListUiStateByTab(new Set(['tab_1', 'tab_2']))

    expect(messageListUiStateByTab.has('tab_1')).toBe(true)
    expect(messageListUiStateByTab.has('tab_2')).toBe(true)
    expect(messageListUiStateByTab.has('tab_closed')).toBe(false)
  })

  test('closeTab 关闭标签页后清理对应 UI 状态（非活跃标签页）', () => {
    const state = {
      openTabs: ref([
        { id: 'tab_1', conversationId: 'conv_1', title: 'A', isStreaming: false },
        { id: 'tab_2', conversationId: 'conv_2', title: 'B', isStreaming: false }
      ]),
      sessionSnapshots: ref(new Map()),
      backgroundStreamBuffers: ref(new Map()),
      activeTabId: ref('tab_1'),
      currentConversationId: ref('conv_1')
    } as unknown as ChatStoreState

    messageListUiStateByTab.set('tab_1', makeUiState())
    messageListUiStateByTab.set('tab_2', makeUiState())

    closeTab(state, 'tab_2', async () => {})

    expect(messageListUiStateByTab.has('tab_2')).toBe(false)
    // 仍打开的标签页记录保留
    expect(messageListUiStateByTab.has('tab_1')).toBe(true)
    expect(state.openTabs.value.map((t: { id: string }) => t.id)).toEqual(['tab_1'])
  })

  test('容量上限常量为正数（兜底防线）', () => {
    expect(MESSAGE_LIST_UI_STATE_CAP).toBeGreaterThan(0)
  })
})
