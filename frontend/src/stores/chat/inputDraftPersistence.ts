import { toRaw, watch } from 'vue'
import type { Attachment } from '../../types'
import type { HostTransport } from '../../utils/hostTransport'
import type { ChatStoreState, ConversationSessionSnapshot, TabInfo } from './types'
import { snapshotCurrentSession } from './tabActions'

type InputDraft = Pick<ConversationSessionSnapshot, 'inputValue' | 'editorNodes' | 'attachments'
  | 'configId' | 'selectedModelId' | 'selectedReasoningEffort' | 'currentPromptModeId'
  | 'pendingModelOverride' | 'pendingConfigIdOverride'>
interface SavedDraft { tab: Pick<TabInfo, 'id' | 'conversationId' | 'title'>; input: InputDraft }
interface InputDraftState { version: 1; activeTabId: string | null; drafts: SavedDraft[] }

function pickInputDraft(source: InputDraft): InputDraft {
  return {
    inputValue: source.inputValue, editorNodes: source.editorNodes, attachments: source.attachments,
    configId: source.configId, selectedModelId: source.selectedModelId,
    selectedReasoningEffort: source.selectedReasoningEffort, currentPromptModeId: source.currentPromptModeId,
    pendingModelOverride: source.pendingModelOverride, pendingConfigIdOverride: source.pendingConfigIdOverride,
  }
}

/** 草稿沿用宿主按账号和客户端隔离的界面状态，不保存历史消息或运行中的任务。 */
export function createInputDraftPersistence(state: ChatStoreState, host: HostTransport) {
  const saved = (host.getState() as { inputDrafts?: InputDraftState } | undefined)?.inputDrafts
  const restoredTabs = new Set<string>()
  let started = false
  let activeDraftTabId: string | null = null

  function capture(): InputDraftState {
    const drafts: SavedDraft[] = []
    for (const tab of state.openTabs.value) {
      const active = tab.id === state.activeTabId.value
      const source = active ? {
        inputValue: state.inputValue.value, editorNodes: state.editorNodes.value, attachments: state.attachments.value,
        configId: state.configId.value, selectedModelId: state.selectedModelId.value,
        selectedReasoningEffort: state.selectedReasoningEffort.value, currentPromptModeId: state.currentPromptModeId.value,
        pendingModelOverride: state.pendingModelOverride.value, pendingConfigIdOverride: state.pendingConfigIdOverride.value,
      } : state.sessionSnapshots.value.get(tab.id)
      if (!source || (!source.inputValue && !source.editorNodes.length && !source.attachments.length)) continue
      drafts.push({ tab: { id: tab.id, title: tab.title,
        conversationId: active ? state.currentConversationId.value : tab.conversationId }, input: pickInputDraft(source) })
    }
    return { version: 1, activeTabId: state.activeTabId.value, drafts }
  }

  // 附件加入输入框后不再修改，内容可能有数 MB：变更检测只比较附件对象，写入时复用按对象缓存的纯数据副本，
  // 输入文字时不再重复序列化附件内容。
  const attachmentKeys = new WeakMap<Attachment, number>()
  const plainAttachments = new WeakMap<Attachment, Attachment>()
  let nextAttachmentKey = 0
  function attachmentKey(attachment: Attachment) {
    const raw = toRaw(attachment)
    let key = attachmentKeys.get(raw)
    if (key === undefined) attachmentKeys.set(raw, key = nextAttachmentKey++)
    return key
  }
  function plainAttachment(attachment: Attachment) {
    const raw = toRaw(attachment)
    let value = plainAttachments.get(raw)
    if (!value) plainAttachments.set(raw, value = JSON.parse(JSON.stringify(raw)) as Attachment)
    return value
  }

  // 同一轮状态变更后立即写入：避开切标签时的中间状态，也不依赖退出事件或延迟定时器。
  // 只跟踪草稿投影，流式消息更新不会反复序列化整段会话。
  let captured: InputDraftState
  watch(() => {
    captured = capture()
    return JSON.stringify({ ...captured, drafts: captured.drafts.map(({ tab, input }) =>
      ({ tab, input: { ...input, attachments: input.attachments.map(attachmentKey) } })) })
  }, serialized => {
    if (!started) return
    const inputDrafts = JSON.parse(serialized) as InputDraftState
    inputDrafts.drafts.forEach((draft, index) => { draft.input.attachments = captured.drafts[index].input.attachments.map(plainAttachment) })
    const previous = host.getState()
    host.setState({ ...(previous && typeof previous === 'object' ? previous : {}), inputDrafts })
  })

  return {
    restoreTabs() {
      if (started) return
      started = true
      if (saved?.version !== 1 || !Array.isArray(saved.drafts)) return
      for (const { tab, input } of saved.drafts) {
        if (!tab?.id || !input || typeof input.inputValue !== 'string'
          || !Array.isArray(input.editorNodes) || !Array.isArray(input.attachments)) continue
        if (state.openTabs.value.some(current => current.id === tab.id)) continue
        state.openTabs.value.push({ ...tab, isStreaming: false })
        state.sessionSnapshots.value.set(tab.id, {
          ...snapshotCurrentSession(state), ...input, conversationId: tab.conversationId,
        })
        restoredTabs.add(tab.id)
      }
      if (saved.activeTabId && restoredTabs.has(saved.activeTabId)) activeDraftTabId = saved.activeTabId
    },
    takeActiveTab() {
      const tabId = activeDraftTabId
      activeDraftTabId = null
      return tabId && state.openTabs.value.some(tab => tab.id === tabId) ? tabId : null
    },
    takeRestoredTab(tabId: string) { return restoredTabs.delete(tabId) },
  }
}
