/**
 * Chat Store 对话与标签页导航
 *
 * 新建、切换、分支打开与删除对话，以及标签页的创建、切换和关闭。
 * 每次导航递增 navigationEpoch：等待期间用户又发起了导航，旧导航放弃自动打开。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension } from '../../utils/vscode'
import { t } from '../../composables/useI18n'
import { messageListUiStateByTab } from '../../components/message/messageListUiState'
import type { ChatStoreState } from './types'
import type { StreamHandlerContext } from './streamHandler'
import type { RemoteViewResync } from './remoteReconnect'
import type { createInputDraftPersistence } from './inputDraftPersistence'
import {
    createNewConversation as createNewConvAction,
    ensureConversationSummary,
    resumeDesktopConversation,
    loadHistory,
    switchConversation as switchConvAction,
    deleteConversation as deleteConvAction,
    createBranchConversation as createBranchConversationAction,
    type CancelStreamAndRejectToolsCallback,
} from './conversationActions'
import { loadCurrentConfig, persistConversationModelConfig } from './configActions'
import { loadBranchGraph as loadBranchGraphAction } from './branchActions'
import {
    createTab as createTabAction,
    closeTab as closeTabAction,
    switchTab as switchTabAction,
    findTabByConversationId,
    updateTabTitle,
    updateTabConversationId,
} from './tabActions'

export interface ChatNavigationDeps {
  cancelStreamAndRejectTools: CancelStreamAndRejectToolsCallback
  /** 切换标签页时回放后台缓冲区 */
  streamHandlerCtx: StreamHandlerContext
  remoteViews: RemoteViewResync
  inputDrafts?: ReturnType<typeof createInputDraftPersistence>
}

export function createChatNavigation(state: ChatStoreState, deps: ChatNavigationDeps) {
  const { cancelStreamAndRejectTools, streamHandlerCtx, remoteViews, inputDrafts } = deps
  let navigationEpoch = 0

  /**
   * 创建新对话 - 标签页感知
   *
   * 如果当前标签页是空白的（无对话），直接复用；否则创建新标签页
   */
  const createNewConversation = async () => {
    navigationEpoch++
    // 如果当前标签页已经是空白的，直接在当前标签页创建
    if (!state.currentConversationId.value && state.allMessages.value.length === 0) {
      // 空白标签页可能已入队消息/附件/编辑器节点：resetConversationState 会清空它们，
      // 先暂存再恢复，避免「新建对话」静默丢弃排队内容（P2）；
      // 输入框内容 / Prompt 模式 / 模型选择同样被重置，一并保留（空白标签页新建对话不应清空输入态）
      const preserved = {
        messageQueue: state.messageQueue.value,
        attachments: state.attachments.value,
        editorNodes: state.editorNodes.value,
        inputValue: state.inputValue.value,
        currentPromptModeId: state.currentPromptModeId.value,
        selectedModelId: state.selectedModelId.value,
        selectedReasoningEffort: state.selectedReasoningEffort.value
      }
      await createNewConvAction(state, cancelStreamAndRejectTools)
      state.messageQueue.value = preserved.messageQueue
      state.attachments.value = preserved.attachments
      state.editorNodes.value = preserved.editorNodes
      state.inputValue.value = preserved.inputValue
      state.currentPromptModeId.value = preserved.currentPromptModeId
      state.selectedModelId.value = preserved.selectedModelId
      state.selectedReasoningEffort.value = preserved.selectedReasoningEffort
      await persistConversationModelConfig(state)
      void loadBranchGraphAction(state)
      return
    }

    // 创建新标签页
    const tabId = createTabAction(state, { title: t('components.tabs.newChat') })
    if (tabId) {
      // createTabAction 未传 conversationId：新标签页的 conversationId 恒为 null，
      // existingTab.conversationId 分支是死代码（旧实现每次都会走到），直接切换
      switchTab(tabId)
    }
  }

  /**
   * 切换对话 - 标签页感知
   *
   * 如果对话已在某个标签页中打开，切换到该标签页；
   * 否则在当前标签页中加载该对话
   */
  const switchConversation = async (id: string) => {
    if (window.__GRAYCODE_HOST) return openConversationInTab(id)
    navigationEpoch++
    // 检查对话是否已在某个标签页中打开
    const existingTab = findTabByConversationId(state, id)
    if (existingTab) {
      // 直接切换到已打开的标签页
      switchTab(existingTab.id)
      return
    }

    // await 前固化目标标签页：切换期间用户可能点了别的标签页，绑定必须基于快照
    const targetTabId = state.activeTabId.value

    // 在当前标签页中加载该对话
    await switchConvAction(state, id, cancelStreamAndRejectTools)
    void loadBranchGraphAction(state)

    // 更新当前标签页的信息（仅当用户没有切换走）
    if (targetTabId && state.activeTabId.value === targetTabId) {
      updateTabConversationId(state, targetTabId, id)
      const conv = state.conversations.value.find(c => c.id === id)
      if (conv) {
        updateTabTitle(state, targetTabId, conv.title)
      }
    }
  }

  /**
   * 从指定后端消息索引创建分支对话，并在新标签页中打开。
   */
  const branchFromMessage = async (messageBackendIndex: number): Promise<void> => {
    const sourceConversationId = state.currentConversationId.value
    if (!sourceConversationId) return
    if (!Number.isFinite(messageBackendIndex) || messageBackendIndex < 0) return
    const epoch = ++navigationEpoch
    const sourceWorkspaceUri = state.currentWorkspaceUri.value

    if (state.isWaitingForResponse.value || state.isStreaming.value) {
      try {
        await cancelStreamAndRejectTools()
      } catch (error) {
        if (epoch !== navigationEpoch) return
        throw error
      }
    }

    const conv = await createBranchConversationAction(state, sourceConversationId, messageBackendIndex, { workspaceUri: sourceWorkspaceUri })
      .catch((error: unknown) => {
        console.error('[chatStore] Failed to create branch conversation:', error)
        if (epoch === navigationEpoch) {
          state.error.value = {
            code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'CREATE_BRANCH_CONVERSATION_ERROR',
            message: error instanceof Error ? error.message : 'Failed to create branch conversation'
          }
        }
        return null
      })
    // 创建仍属于点击时的来源，等待期间的新导航只取消这次自动打开。
    if (!conv || epoch !== navigationEpoch) return

    const tabId = createTabAction(state, {
      conversationId: conv.id,
      title: conv.title
    })

    if (tabId) {
      switchTab(tabId)
      await switchConvAction(state, conv.id, cancelStreamAndRejectTools)
      if (state.activeTabId.value !== tabId || state.currentConversationId.value !== conv.id) return
      void loadBranchGraphAction(state)
      updateTabTitle(state, tabId, conv.title)
    } else {
      await switchConversation(conv.id)
    }
  }

  const deleteConversation = (id: string) => deleteConvAction(
    state,
    id,
    switchConversation,
    createNewConversation
  )

  function getConversationViews() {
    return state.openTabs.value.map(tab => {
      const active = tab.id === state.activeTabId.value
      const snapshot = active ? null : state.sessionSnapshots.value.get(tab.id)
      return { ...tab, active, hasDraft: active ? !!state.inputValue.value.trim() || state.editorNodes.value.some(node => node.type === 'context' || !!node.text.trim()) || !!state.attachments.value.length
        : !!snapshot?.inputValue.trim() || !!snapshot?.editorNodes.some(node => node.type === 'context' || !!node.text.trim()) || !!snapshot?.attachments.length }
    })
  }

  /**
   * 创建新标签页
   */
  function createNewTab(): string | null {
    navigationEpoch++
    if (window.__GRAYCODE_HOST && !state.currentConversationId.value && !state.allMessages.value.length && !state.inputValue.value.trim()
      && state.editorNodes.value.every(node => node.type === 'text' && !node.text.trim()) && !state.attachments.value.length && !state.isWaitingForResponse.value) return state.activeTabId.value
    const tabId = createTabAction(state, { title: t('components.tabs.newChat') })
    if (tabId) {
      switchTab(tabId)
    }
    return tabId
  }

  /**
   * 关闭标签页
   */
  function closeTab(tabId: string): void {
    const conversationId = state.openTabs.value.find(tab => tab.id === tabId)?.conversationId
    closeTabAction(
      state,
      tabId,
      switchTab,
      window.__GRAYCODE_HOST ? undefined : async (conversationId) => {
        try {
          await sendToExtension(MESSAGE_NAMES.cancelStream, { conversationId })
        } catch (error) {
          console.error('[chatStore] Failed to cancel stream on tab close:', error)
        }
      }
    )
    if (conversationId && !state.openTabs.value.some(tab => tab.conversationId === conversationId)) remoteViews.forget(conversationId)
  }

  /**
   * 切换标签页
   */
  function switchTab(tabId: string): void {
    // 再次选择当前标签同样表示取消尚未完成的历史导航。
    navigationEpoch++
    if (state.activeTabId.value === tabId) {
      if (state.currentConversationId.value && remoteViews.isStale(state.currentConversationId.value)) void remoteViews.restore(state.currentConversationId.value)
      return
    }
    const hasSnapshot = state.sessionSnapshots.value.has(tabId)
    const restoredDraft = inputDrafts?.takeRestoredTab(tabId)
    switchTabAction(state, tabId, cancelStreamAndRejectTools, streamHandlerCtx)
    void loadCurrentConfig(state)
    const conversationId = state.currentConversationId.value
    if (window.__GRAYCODE_HOST && conversationId && remoteViews.isStale(conversationId)) { void remoteViews.restore(conversationId); return }
    if (window.__GRAYCODE_HOST && hasSnapshot && conversationId && !state.isStreaming.value && !state.isWaitingForResponse.value) {
      const savedView = messageListUiStateByTab.get(tabId)
      const preserveWindow = savedView?.followingBottom === false && savedView.conversationId === conversationId
      state.isLoading.value = true
      void (async () => {
        try {
          if (restoredDraft) {
            await ensureConversationSummary(state, conversationId)
            if (state.currentConversationId.value !== conversationId) return
          }
          await loadHistory(state, false, { preserveWindow })
          await resumeDesktopConversation(state, conversationId, { preserveWindow })
          if (restoredDraft && state.currentConversationId.value === conversationId) void loadBranchGraphAction(state)
        }
        catch (error) { if (state.currentConversationId.value === conversationId) state.error.value = { code: 'RESUME_ERROR', message: (error as Error).message } }
        finally { if (state.currentConversationId.value === conversationId) state.isLoading.value = false }
      })()
    }
  }

  function restoreInputDraft(): boolean {
    const tabId = inputDrafts?.takeActiveTab()
    if (!tabId) return false
    const initialTabId = state.activeTabId.value
    switchTab(tabId)
    if (initialTabId && initialTabId !== tabId) closeTab(initialTabId)
    return true
  }

  /**
   * 从历史打开对话（在新标签页或当前空白标签页中）
   */
  async function openConversationInTab(conversationId: string): Promise<void> {
    const epoch = ++navigationEpoch
    await ensureConversationSummary(state, conversationId)
    if (epoch !== navigationEpoch) return
    // 如果已在某个标签页中打开，直接切换
    const existingTab = findTabByConversationId(state, conversationId)
    if (existingTab) {
      switchTab(existingTab.id)
      return
    }
    if (window.__GRAYCODE_HOST && state.openTabs.value.length >= 100) {
      const unused = state.openTabs.value.find(tab => {
        const snapshot = state.sessionSnapshots.value.get(tab.id)
        return tab.id !== state.activeTabId.value && !tab.isStreaming && snapshot && !snapshot.isWaitingForResponse && !snapshot.isLoading
          && !snapshot.inputValue.trim() && snapshot.editorNodes.every(node => node.type === 'text' && !node.text.trim()) && !snapshot.attachments.length && !snapshot.messageQueue.length
      })
      if (unused) closeTab(unused.id)
      else throw new Error('打开的对话较多，请先关闭一个不用的对话视图。输入草稿和运行中的对话会保留。')
    }

    // 如果当前标签页是空白的，在当前标签页中加载
    // 只有完全空白的输入可以复用；已有文本或附件的草稿继续保留在原对话。
    const conv = state.conversations.value.find(c => c.id === conversationId)
    const reusable = !state.currentConversationId.value && !state.allMessages.value.length && !state.inputValue.value.trim()
      && state.editorNodes.value.every(node => node.type === 'text' && !node.text.trim()) && !state.attachments.value.length && !state.isWaitingForResponse.value
    const tabId = reusable && state.activeTabId.value ? state.activeTabId.value : createTabAction(state, {
      conversationId,
      title: conv?.title || t('components.tabs.chat')
    })
    if (tabId) {
      switchTab(tabId)
      // 导航已被接受，标签身份先与目标一致；历史加载期间重复选中本标签不能留下空白绑定。
      updateTabConversationId(state, tabId, conversationId)
      if (conv) {
        updateTabTitle(state, tabId, conv.title)
      }
      await switchConvAction(state, conversationId, cancelStreamAndRejectTools)
      if (state.activeTabId.value !== tabId || state.currentConversationId.value !== conversationId) return
      void loadBranchGraphAction(state)
    }
  }

  return {
    createNewConversation,
    switchConversation,
    branchFromMessage,
    deleteConversation,
    getConversationViews,
    createNewTab,
    closeTab,
    switchTab,
    restoreInputDraft,
    openConversationInTab,
  }
}
