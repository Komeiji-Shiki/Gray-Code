import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import ToolMessage from '../../components/message/ToolMessage.vue'
import type { Content, ToolUsage } from '../../types'
import { appendMessage, createChatState } from '../../stores/chat/state'
import { contentToMessage } from '../../stores/chat/parsers'
import { handleAwaitingConfirmation, handleToolStatus, handleToolStatusBatch } from '../../stores/chat/chunkHandlers/chunkTools'
import { buildFunctionCallToolRenderEntry } from '../../utils/toolRenderEntries'

const runtime = vi.hoisted(() => ({
  store: undefined as any,
  sendToExtension: vi.fn(),
  showNotification: vi.fn()
}))
vi.mock('../../stores', () => ({ useChatStore: () => runtime.store }))
vi.mock('../../stores/backgroundTaskStore', () => ({ useBackgroundTaskStore: () => ({ tasks: {} }) }))
vi.mock('../../utils/toolRegistry', () => ({ getToolConfig: () => ({ label: 'delete_file', expandable: false }) }))
vi.mock('../../utils/tools', () => ({ ensureMcpToolRegistered: vi.fn() }))
vi.mock('../../utils/vscode', () => ({
  sendToExtension: runtime.sendToExtension,
  showNotification: runtime.showNotification,
  onExtensionCommand: vi.fn(() => vi.fn())
}))
vi.mock('../../i18n', async importOriginal => ({
  ...await importOriginal<typeof import('../../i18n')>(),
  useI18n: () => ({ t: (key: string) => key })
}))

const content: Content = { id: 'tool-message', role: 'model', parts: [
  { functionCall: { id: 'delete-call', name: 'delete_file', args: { paths: ['fixture.txt'] } } }
] }

function createApproval(fromHistory = false, choices?: ToolUsage['approvalChoices']) {
  const state = createChatState()
  state.currentConversationId.value = 'conversation'
  state.activeStreamId.value = 'live-stream'
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true
  state.streamingMessageId.value = fromHistory ? content.id! : 'placeholder'
  appendMessage(state, fromHistory ? contentToMessage(content) : {
    id: 'placeholder', role: 'assistant', content: '', timestamp: 1, streaming: true, localOnly: true
  })
  handleAwaitingConfirmation({ type: 'awaitingConfirmation', conversationId: 'conversation',
    streamId: 'live-stream', keepStreamOpen: true, content,
    pendingToolCalls: [{ id: 'delete-call', name: 'delete_file', args: { paths: ['fixture.txt'] },
      approvalId: 'approval-1', approvalReason: 'Delete requires permission', approvalChoices: choices }]
  }, state, vi.fn())
  // MessageContent -> MessageRenderBlock -> ToolMessage uses this projection, not message.tools directly.
  const project = () => {
    const message = state.allMessages.value.find(item => item.id === 'tool-message')!
    return message.parts!.filter(part => part.functionCall).map((part, functionCallOrdinal) =>
      buildFunctionCallToolRenderEntry({ messageId: message.id, functionCall: part.functionCall!,
        messageTools: message.tools!, functionCallOrdinal }))
  }
  runtime.store = {
    currentConversationId: 'conversation', currentConfig: { id: 'config' },
    activeStreamId: 'live-stream', isGenerating: true, isWaitingForResponse: true,
    currentPromptModeId: 'code', getToolResponseById: vi.fn(() => undefined),
    beginToolConfirmationRound: vi.fn(), abortToolConfirmationRound: vi.fn()
  }
  return { state, project }
}

let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  runtime.sendToExtension.mockResolvedValue(undefined)
  runtime.showNotification.mockResolvedValue(undefined)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

const requests = () => runtime.sendToExtension.mock.calls.filter(([type]) => type === 'toolConfirmation')

describe('tool approval through the real render projection', () => {
  test.each([
    { fromHistory: false, decision: 'confirm' }, { fromHistory: false, decision: 'reject' },
    { fromHistory: true, decision: 'confirm' }, { fromHistory: true, decision: 'reject' }
  ])('preserves identity for $decision (history=$fromHistory), even while generating', async ({ fromHistory, decision }) => {
    const { state, project } = createApproval(fromHistory)
    expect(state.allMessages.value[0].tools?.[0].approvalId).toBe('approval-1')
    wrapper = mount(ToolMessage, { props: { tools: project() } })
    await wrapper.get(`.${decision}-btn`).trigger('click')
    await flushPromises()
    expect(requests()).toHaveLength(1)
    expect(requests()[0][1]).toMatchObject({ streamId: 'live-stream', toolResponses: [
      { id: 'delete-call', name: 'delete_file', approvalId: 'approval-1', confirmed: decision === 'confirm' }
    ] })
    expect(runtime.store.beginToolConfirmationRound).not.toHaveBeenCalled()
  })

  test('preserves the reason and concrete permission choices rather than replacing them with generic buttons', async () => {
    const { project } = createApproval(false, [
      { id: 'once', kind: 'allow_once', label: 'Allow once' },
      { id: 'deny', kind: 'reject_once', label: 'Deny' }
    ])
    wrapper = mount(ToolMessage, { props: { tools: project() } })
    expect(wrapper.find('.confirm-btn').exists()).toBe(false)
    expect(wrapper.text()).toContain('Delete requires permission')
    await wrapper.get('.permission-options button').trigger('click')
    await flushPromises()
    expect(requests()[0][1].toolResponses[0]).toMatchObject({ approvalId: 'approval-1', choiceId: 'once', confirmed: true })
  })

  test('does not invent an approval identity from model functionCall data', () => {
    const entry = buildFunctionCallToolRenderEntry({ messageId: 'history', functionCall: {
      ...content.parts[0].functionCall!, approvalId: 'untrusted-model-field'
    } as any, messageTools: [], functionCallOrdinal: 0 })
    expect(entry.approvalId).toBeUndefined()
  })

  test.each([false, true])('CANCELLED result clears pending buttons through projection (batched=%s)', async batched => {
    const { state, project } = createApproval()
    wrapper = mount(ToolMessage, { props: { tools: project() } })
    const result = { success: false, error: 'Cancelled by user', code: 'CANCELLED', cancelled: true }
    const chunk = { type: 'toolStatus' as const, conversationId: 'conversation', toolStatus: true,
      tool: { id: 'delete-call', name: 'delete_file', status: 'error' as const, result } }
    if (batched) handleToolStatusBatch([chunk], state)
    else handleToolStatus(chunk, state)
    await wrapper.setProps({ tools: project() })
    expect(wrapper.find('.confirm-btn').exists()).toBe(false)
    expect(wrapper.find('.reject-btn').exists()).toBe(false)
    expect(wrapper.find('.status-error').exists()).toBe(true)
  })

  test.each(['currentConversationId', 'currentConfig'])('missing %s gives a visible error without submitting or rebinding', async field => {
    const { project } = createApproval()
    runtime.store[field] = null
    wrapper = mount(ToolMessage, { props: { tools: project() } })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await wrapper.get('.confirm-btn').trigger('click')
      await flushPromises()
      expect(requests()).toHaveLength(0)
      expect(runtime.showNotification).toHaveBeenCalledWith(field === 'currentConversationId'
        ? 'stores.chatStore.errors.noConversationSelected' : 'stores.chatStore.errors.noConfigSelected', 'error')
      expect(runtime.store.beginToolConfirmationRound).not.toHaveBeenCalled()
      expect(runtime.store.abortToolConfirmationRound).not.toHaveBeenCalled()
      expect(wrapper.find('.confirm-btn').exists()).toBe(true)
    } finally { log.mockRestore() }
  })

  test('a rejected confirmation is visible to the user without destroying the live run', async () => {
    const { project } = createApproval()
    wrapper = mount(ToolMessage, { props: { tools: project() } })
    runtime.sendToExtension.mockImplementation((type: string) => type === 'toolConfirmation'
      ? Promise.reject(new Error('Approval is no longer pending')) : Promise.resolve())
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await wrapper.get('.confirm-btn').trigger('click')
      await flushPromises()
      expect(runtime.showNotification).toHaveBeenCalledWith('Approval is no longer pending', 'error')
      expect(runtime.store.abortToolConfirmationRound).not.toHaveBeenCalled()
      expect(runtime.store.activeStreamId).toBe('live-stream')
      expect(wrapper.find('.confirm-btn').exists()).toBe(true)
    } finally { log.mockRestore() }
  })
})

describe('批量文件读取的总体状态', () => {
  test.each([
    { data: { successCount: 2, failCount: 1 }, success: false, status: 'warning', icon: 'warning' },
    { data: { results: [{ success: true }, { success: false }] }, success: false, status: 'warning', icon: 'warning' },
    { data: { successCount: 0, failCount: 2 }, success: false, status: 'error', icon: 'error' },
    { data: { successCount: 2, failCount: 0 }, success: true, status: 'success', icon: 'check' },
  ])('混合/全败/全成得到 $status（$data）', ({ data, success, status, icon }) => {
    createApproval();
    wrapper = mount(ToolMessage, { props: { tools: [{ id: 'read-batch', name: 'read_file', args: { files: [{ path: 'a' }, { path: 'missing' }] },
      status: success ? 'success' : 'error', result: { success, data, ...(!success ? { error: 'Some files failed' } : {}) } }] } });
    expect(wrapper.find(`.tool-item.status-${status}`).exists()).toBe(true);
    expect(wrapper.find(`.status-icon.codicon-${icon}`).exists()).toBe(true);
    if (status === 'warning') expect(wrapper.find('.tool-item.status-error').exists()).toBe(false);
  });
});
