import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createChatState } from '../../stores/chat/state'
import { applyConversationModelConfig, applyConversationPromptMode, setConfigId, setCurrentPromptModeId, setSelectedModelId } from '../../stores/chat/configActions'
import { sendToExtension } from '../../utils/vscode'
import { createAndPersistConversation } from '../../stores/chat/conversationActions'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn() }))
const send = vi.mocked(sendToExtension)
function state() {
  const result = createChatState()
  result.currentConversationId.value = 'first'
  result.activeTabId.value = 'tab-a'
  result.configId.value = 'channel-a'
  result.selectedModelId.value = 'selected-a'
  return result
}

describe('渠道和模式异步切换', () => {
  beforeEach(() => send.mockReset().mockResolvedValue(undefined))

  test('旧会话元数据迟到不会改动新会话的渠道或推理配置', async () => {
    const current = state()
    let finish!: (result: unknown) => void
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const loading = applyConversationModelConfig(current, 'first')
    current.currentConversationId.value = 'second'
    current.activeTabId.value = 'tab-b'
    current.configId.value = 'channel-b'
    current.selectedReasoningEffort.value = 'high'
    finish({ custom: { inputModelConfig: { configId: 'old', modelId: 'old', reasoningEffort: 'low' } } })
    await loading
    expect(current.configId.value).toBe('channel-b')
    expect(current.selectedReasoningEffort.value).toBe('high')
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('切渠道期间切换会话，旧操作不会重置新会话模型或写其元数据', async () => {
    const current = state()
    let finish!: (result: unknown) => void
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const changing = setConfigId(current, 'channel-new')
    current.currentConversationId.value = 'second'
    current.activeTabId.value = 'tab-b'
    current.configId.value = 'channel-b'
    current.selectedModelId.value = 'model-b'
    finish({ id: 'channel-new', model: 'default-new' })
    await changing
    expect(current.selectedModelId.value).toBe('model-b')
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('渠道详情读取期间用户选择了模型，迟到的存储模型不覆盖新选择', async () => {
    const current = state()
    let finish!: (result: unknown) => void
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const applying = applyConversationModelConfig(current, 'first', { configId: 'channel-a', modelId: 'saved-model' })
    await setSelectedModelId(current, 'user-model')
    finish({ id: 'channel-a', model: 'default-model' })
    await applying
    expect(current.selectedModelId.value).toBe('user-model')
    expect(current.currentConfig.value?.id).toBe('channel-a')
  })

  test('用户切换模式后迟到的模式读取不能恢复旧模式', async () => {
    const current = state()
    let finish!: (result: unknown) => void
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const applying = applyConversationPromptMode(current, 'first')
    await setCurrentPromptModeId(current, 'chat')
    finish({ custom: { promptModeConfig: { modeId: 'code' } } })
    await applying
    expect(current.currentPromptModeId.value).toBe('chat')
  })

  test('新建会话的结果不能绑定到另一个空白标签，并保留原工作区', async () => {
    const current = state()
    current.currentConversationId.value = null
    current.currentWorkspaceUri.value = 'file:///workspace-a'
    let finish!: (result: unknown) => void
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const creating = createAndPersistConversation(current, 'hello')
    current.activeTabId.value = 'tab-b'
    current.currentWorkspaceUri.value = 'file:///workspace-b'
    finish({ success: true })
    const created = await creating
    expect(created).toBeTruthy()
    expect(current.currentConversationId.value).toBeNull()
    expect(current.conversations.value[0].workspaceUri).toBe('file:///workspace-a')
  })
})
